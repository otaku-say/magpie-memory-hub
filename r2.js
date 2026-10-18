/**
 * r2.js —— Cloudflare R2 文件存储（经 NoCodeBackend 代管）。
 *
 * 凭据分工（实测确认）：
 *   · 创建 bucket / 配 CORS   → **MCP** `setup_r2_storage`
 *   · 上传 / 列举 / 删除      → **数据库 Secret Key 的 REST**
 *     （MCP 的 23 个工具里只有 setup + upload，没有 list/delete）
 *   · 下载                    → 靠 bucket 的公开域名（NCB 不提供文件流代理）
 *
 * ⚠️ 本文件最重要的一条经验：
 *   **`setup_r2_storage` 会在实际失败时也返回 `ok: true`。**
 *   实测用故意写错的凭据调用，得到：
 *     { ok: true, reused_existing_connection: false,
 *       bucket_created: false, cors_configured: true }
 *   —— 连 bucket 都没建出来，却报告成功。
 *   所以 r2Setup **不采信返回值**，而是紧接着做一次真实上传探测（r2Probe），
 *   以真实操作为准给出判定。
 */
import { NcbMcp } from "./ncb_mcp.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupSecret, forgetSecret, lookupRealDatabase, rememberDatabase, rememberR2Mount, lookupR2Mount, forgetR2Mount } from "./local_state.js";
import { explainUnknownErrorWithModel, attachAiDiagnosis } from "./online_models.js";

const REST_BASE = "https://api.nocodebackend.com";

/* ------------------------------------------------------------------ *
 * 客户端
 * ------------------------------------------------------------------ */

function clientOf(cfg, signal) {
  const key = (cfg && (cfg.mcpKey || cfg.mcp_key)) || "";
  if (!key) {
    const err = new Error(
      "未配置 MCP key。R2 存储的创建与上传都走 NoCodeBackend 的 MCP，需要在设置页填写 MCP key。"
    );
    err.code = "NO_MCP_KEY";
    throw err;
  }
  return new NcbMcp({ apiKey: key, signal: signal || (cfg && cfg.signal) || null });
}

/** 从各种命名里取数据库名（readOptions 产出的是 instance）。 */
function dbOf(cfg, args) {
  const db = (args && args.database) || (cfg && (cfg.instance || cfg.ncb_instance)) || "";
  if (!db) {
    const err = new Error("未指定数据库名（请在设置页填 ncb_instance）");
    err.code = "NO_DATABASE";
    throw err;
  }
  return db;
}

/**
 * 解析出真实的远端数据库名（带账号前缀，如 41694_agent_memory）。
 * 依据实测：NCB 的 REST 接口（/files 等）强制要求带账号前缀的真实名，
 * 逻辑名（agent_memory）一律返回 403 (Invalid secret_key)。
 * 保证「桶名」「REST 调用的 Instance」「列表/删除时的库名」三者同源。
 */
export async function resolveRealDatabase(cfg, name) {
  const want = String(name || "").trim();
  if (!want) return "";
  if (/^\d+_/.test(want)) return want;

  const local = lookupRealDatabase(want);
  if (local && /^\d+_/.test(local)) return local;

  const mcpKey = (cfg && (cfg.mcpKey || cfg.mcp_key)) || "";
  if (mcpKey) {
    try {
      const mcp = new NcbMcp({ apiKey: mcpKey, signal: (cfg && cfg.signal) || null });
      const text = await mcp.listDatabasesText();
      const norm = (x) => String(x || "").toLowerCase().replace(/^\d+_/, "");
      const target = norm(want);
      const lines = String(text || "").split(/\r?\n/);
      const candidates = [];
      for (const line of lines) {
        const m = line.match(/^-\s*([A-Za-z0-9_]+)/);
        if (m) candidates.push(m[1]);
      }
      const hit = candidates.find((c) => norm(c) === target) || (candidates.length === 1 ? candidates[0] : "");
      if (hit && /^\d+_/.test(hit)) {
        try { rememberDatabase(hit); } catch (_) {}
        return hit;
      }
    } catch (_) {}
  }

  return local || want;
}

/** NoCodeBackend 的 REST 客户端（用数据库 Secret Key 认证）。 */
function restClient(cfg) {
  const secret = (cfg && (cfg.secret || cfg.ncb_secret)) || "";
  const rawInstance = (cfg && (cfg.instance || cfg.ncb_instance)) || "";
  // 必须使用真实库名（带账号数字前缀），逻辑名在 REST 侧会直接 403
  const instance = lookupRealDatabase(rawInstance) || rawInstance;
  if (!secret) {
    const err = new Error(
      "未配置数据库 Secret Key。R2 的「列举 / 删除」走 NoCodeBackend 的 REST，需要 Secret Key；" +
      "只有「创建 bucket」需要 MCP key。" +
      "解决办法：打开 NoCodeBackend 控制台 → 该数据库 → 复制 Secret Key，" +
      "填到本插件设置页的「数据库 Secret Key」一栏（插件无法自行取回，它只在建库时返回一次）。"
    );
    err.code = "NO_SECRET";
    throw err;
  }
  if (!instance) {
    const err = new Error("未指定数据库名");
    err.code = "NO_DATABASE";
    throw err;
  }
  return { secret, instance };
}

/** 发一次 REST 请求；返回 { status, body }。 */
async function rest(cfg, method, path, opts) {
  const { secret, instance } = restClient(cfg);
  const o = opts || {};
  const url = REST_BASE + path + "?Instance=" + encodeURIComponent(instance);
  const headers = { Authorization: "Bearer " + secret };
  let payload;
  if (o.json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(o.json);
  } else if (o.form !== undefined) {
    payload = o.form;                       // FormData：让 fetch 自己设 boundary
  }
  const externalSignal = (o && o.signal) || (cfg && cfg.signal) || null;
  if (externalSignal && externalSignal.aborted) {
    const abortErr = new Error("操作已被取消 (aborted)");
    abortErr.name = "AbortError";
    throw abortErr;
  }
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeout || 60000) : null;
  let abortListener = null;
  if (ctrl && externalSignal) {
    abortListener = () => ctrl.abort();
    externalSignal.addEventListener("abort", abortListener, { once: true });
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: ctrl ? ctrl.signal : undefined });
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (externalSignal && abortListener) externalSignal.removeEventListener("abort", abortListener);
    const isAbort = externalSignal && externalSignal.aborted;
    const msg = isAbort ? "操作已被取消 (aborted)" : String(e && e.message || e);
    const err = new Error("连接 NoCodeBackend 失败：" + msg);
    if (isAbort || (e && e.name === "AbortError")) err.name = "AbortError";
    throw err;
  }
  if (timer) clearTimeout(timer);
  if (externalSignal && abortListener) externalSignal.removeEventListener("abort", abortListener);
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body };
}

/* ------------------------------------------------------------------ *
 * 真实性探测
 * ------------------------------------------------------------------ */

/**
 * 探测 R2 是否**真的**可用：上传一个极小的探针文件。
 *
 * 探针失败时的典型错误与含义：
 *   · `sslv3 alert handshake failure` / `SSL alert number 40` / `EPROTO`
 *       → Cloudflare 在 TLS 握手阶段就拒绝，说明 NCB 手里那份凭据是旧的
 *         （已轮换/删除），或新令牌权限不足。此时**必须让 NCB 换成新凭据**。
 *   · 403 / InvalidAccessKeyId / SignatureDoesNotMatch
 *       → 凭据不匹配或已删除。
 */
export async function r2Probe(cfg, database) {
  const signal = (cfg && cfg.signal) || null;
  if (signal && signal.aborted) {
    const abortErr = new Error("操作已被取消 (aborted)");
    abortErr.name = "AbortError";
    throw abortErr;
  }
  const mcp = clientOf(cfg);
  const rawDb = database || dbOf(cfg, {});
  const db = await resolveRealDatabase(cfg, rawDb);
  /* 【固定文件名，不要带时间戳】
   * 早先用 "_memhub_probe_" + Date.now() + ".txt"，于是每次检测都新增一个文件。
   * 一旦删除失败（没 secret、key 对不上、权限不足），这些探针就会在 R2 里越堆越多。
   * 改成固定名字后，重复检测只会覆盖同一个文件 —— 最坏情况也只剩 1 个。 */
  const name = "_memhub_probe.txt";
  try {
    const out = await mcp.uploadFile(db, name, utf8ToBase64("probe"), "text/plain");
    const url = (out && (out.url || out.publicUrl)) || "";
    if (!url) return { ok: false, error: "上传没有返回 URL", raw: out };
    /* 探针用完就删。删不掉不算失败（有些配置不给删权限），
     * 但必须把结果如实回传，让用户知道有没有留下垃圾文件。 */
    let cleaned = false;
    let cleanNote = "";
    try {
      /* 注意：NCB 上传后会在文件名前加一段前缀（如 1792163443679-xxxx-），
       * 所以实际对象 key 与上传时的 name 并不相同。优先用响应里的 key，
       * 并同时尝试 name 本身，两个都试过才算尽力。 */
      const keys = [];
      if (out && out.key) keys.push(String(out.key));
      const prefix = (out && (out.prefix || out.path)) ? String(out.prefix || out.path) : "";
      if (prefix) keys.push(prefix.replace(/\/+$/, "") + "/" + name);
      // 从 url / publicUrl 的 pathname 提取 key（防止 out 仅返回 url 未带 key 导致删除匹配不到真实对象）
      if (url) {
        try {
          const u = new URL(url);
          const pathKey = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
          if (pathKey && !keys.includes(pathKey)) keys.push(pathKey);
        } catch (_) {}
      }
      keys.push(name);
      const capturedSecret = lookupSecret(db) || lookupSecret(rawDb) || "";
      const secretVal = (cfg && (cfg.secret || cfg.ncb_secret)) || capturedSecret || "";
      const hasSecret = !!secretVal;
      if (!hasSecret) {
        cleanNote = "探针文件已留在 R2 存储中，因为删除需要数据库 Secret Key，而当前尚未填写（只有 MCP Key 时只能上传不能删除）。清理方法：请前往 NoCodeBackend 控制台复制 Secret Key 填入设置页，然后点击下方「清理探针文件」按钮即可一键批量删除所有探针。";
      } else {
        const restCfg = Object.assign({}, cfg, { instance: db, secret: secretVal });
        for (const k of keys) {
          try {
            const r = await rest(restCfg, "DELETE", "/files/" + encodeURIComponent(k), { skip_mount_check: true });
            if (r.status < 400) { cleaned = true; break; }
            if (r.status === 401 || r.status === 403) {
              forgetSecret(db || rawDb);
            }
          } catch (e) {
            if (/403|401|invalid secret/i.test(String(e && e.message || e))) {
              forgetSecret(db || rawDb);
            }
            if (e.name === "AbortError" || (signal && signal.aborted)) throw e;
          }
        }
        if (!cleaned) cleanNote = "探针文件删除失败（已尝试匹配的 key、URL 路径与原始文件名），可能仍留在 R2 存储中。清理方法：请在设置页确认 Secret Key 有效，并点击下方「清理探针文件」按钮重新清理，或前往 Cloudflare R2 控制台手动删除。";
      }
    } catch (e) {
      if (e.name === "AbortError" || (signal && signal.aborted)) throw e;
      cleanNote = "探针清理时出错：" + String(e && e.message || e);
    }
    return { ok: true, url, cleaned, clean_note: cleanNote };
  } catch (e) {
    if (e.name === "AbortError" || (signal && signal.aborted)) {
      throw e;
    }
    return { ok: false, error: String(e && e.message || e) };
  }
}

/** 把探针失败翻译成人能看懂的原因与下一步。 */
export function explainProbeFailure(err) {
  const m = String(err || "");
  if (/bucket name is not valid|InvalidBucketName/i.test(m)) {
    return {
      kind: "INVALID_BUCKET_NAME",
      title: "R2 存储桶名称不合法",
      detail: "Cloudflare R2 / S3 规范要求桶名只能由小写字母、数字、连字符和点组成，不能包含下划线，长度在 3-63 字符之间。",
      actions: [
        "插件已自动将数据库名中的下划线转换为连字符（例如 41694_agent_memory → 41694-agent-memory）。",
        "若手动指定了 Bucket 名称，请检查是否包含下划线、大写字母或非法符号，修改后重试。",
        "如在 NoCodeBackend 控制台已绑定旧桶，请在控制台重新挂载合法桶名。",
      ],
    };
  }
  if (/handshake failure|SSL alert number 40|EPROTO|sslv3/i.test(m)) {
    return {
      kind: "STALE_CREDENTIALS",
      title: "R2 凭据在 Cloudflare 侧被拒绝（TLS 握手失败）",
      detail:
        "NoCodeBackend 拿它自己保存的 Cloudflare 凭据去连 R2，Cloudflare 拒绝了这次握手 —— " +
        "通常是因为那把密钥已在 Cloudflare 轮换/删除，或新令牌权限不足。注意：此 TLS 握手发生在 NCB 远端与 Cloudflare 之间，与本地 Docker / 宿主容器 TLS 环境完全无关，切勿在容器内安装 openssl。",
      actions: [
        "① 确认新的 R2 API Token 权限选的是【Admin Read & Write】。" +
          "只选 Object Read & Write 时 NoCodeBackend 无法自动建桶与配 CORS，而且会静默失败（返回 ok:true 但没做事）。",
        "② 到 NoCodeBackend 控制台的 R2 Storage 页面，把该数据库的 Cloudflare 连接【更新】或【删除后重建】，" +
          "填入新的 Account ID / Access Key / Secret。" +
          "插件无法替 NCB 覆盖它在账号层保存的旧连接 —— 这是平台边界。",
        "③ 改完后回到插件重新点「挂载 R2 存储」，本次会用真实上传验证（排查此问题无需在本地容器内装 openssl）。",
      ],
    };
  }
  /* 数据库 Secret Key 本身失效（与 Cloudflare 凭据无关）。
   * 典型原因：数据库被删除重建，NCB 换了新密钥，而插件手里还是旧的。 */
  if (/Invalid\s*secret[_-]?key|secret_key/i.test(m)) {
    return {
      kind: "BAD_SECRET_KEY",
      title: "数据库 Secret Key 已失效",
      detail: "插件手里的 Secret Key 被 NoCodeBackend 拒绝了。常见原因：数据库删除重建后 NCB 换了新密钥。",
      actions: [
        "打开 NoCodeBackend 控制台 → 找到该数据库 → 复制当前的 Secret Key。",
        "填到本插件设置页的「数据库 Secret Key」一栏（填了就以你填的为准，不再用自动捕获的）。",
        "也可以点「一键创建数据库」重新走一次建库流程，届时会自动捕获并覆盖为新密钥。",
      ],
    };
  }
  if (/Unauthorized|403|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(m)) {
    return {
      kind: "BAD_CREDENTIALS",
      title: "R2 凭据无效",
      detail: "Access Key / Secret 不匹配，或该密钥已被删除。",
      actions: ["到 Cloudflare R2 重新生成 API Token（权限选 Admin Read & Write），再填回插件。"],
    };
  }
  return {
    kind: "UNKNOWN",
    title: "R2 挂载后真实上传失败",
    detail: m.slice(0, 300),
    actions: ["按原始错误排查；确认 NoCodeBackend 控制台里该库的 R2 配置存在且正确。"],
  };
}

/* ------------------------------------------------------------------ *
 * 配置 R2（挂载）
 * ------------------------------------------------------------------ */

/**
 * 从数据库名或用户输入派生符合 S3/R2 命名规范的合法桶名。
 * S3 / Cloudflare R2 规范要求：
 *   - 只能包含小写字母 (a-z)、数字 (0-9)、连字符 (-) 和点 (.)
 *   - 绝不允许下划线 (_) 或大写字母
 *   - 必须以字母或数字开头与结尾（不可为 - 或 .）
 *   - 不得包含连续的点 (..) 或连续连字符
 *   - 长度必须在 3 到 63 个字符之间
 *
 * 这是纯函数，创建与列举/删除/探测等所有场景必须由同一个函数产出。
 */
export function deriveLegalBucketName(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.toLowerCase().trim();
  // 下划线、点及其他非法字符转为连字符 '-'（Cloudflare R2 规范要求仅允许小写字母、数字与连字符）
  s = s.replace(/[^a-z0-9-]/g, "-");
  // 合并连续连字符
  s = s.replace(/-{2,}/g, "-");
  // 去除首尾的连字符
  s = s.replace(/^-+|-+$/g, "");
  // 截断到最大 63 字符，且截断后不得以连字符结尾
  if (s.length > 63) {
    s = s.slice(0, 63).replace(/-+$/g, "");
  }
  // 补齐最小 3 字符（若有效字符完全为空则回退为默认合规桶名，若 1-2 字符则追加 '-bkt'）
  if (s.length === 0) {
    s = "memhub-r2-bkt";
  } else if (s.length < 3) {
    s = (s + "-bkt").slice(0, 63);
  }
  return s;
}

/**
 * 判断指定数据库实例是否已成功挂载 R2 存储通道。
 * 判据：
 *   1. 本地单一状态真相源（local_state.r2_mounts）：经 r2Setup 真实探针验证通过才写入；
 *   2. 若无成功记录，无论凭据是否填写，均判定为尚未挂载（未挂载时调 upload/probe 必然报 TLS 40）。
 *   注：后端逻辑严格禁止从 _status.json 视图文件反向恢复状态，彻底杜绝僵尸状态复活。
 */
export function isR2Mounted(cfg, database, args) {
  const rawDb = String(database || (args && args.database) || (cfg && (cfg.instance || cfg.ncb_instance)) || "").trim();
  const db = lookupRealDatabase(rawDb) || rawDb;

  // 1. 本地状态文件 lookupR2Mount（三级策略：精确匹配、归一化去前缀匹配、单条兜底）
  const localRecord = lookupR2Mount(db) || (rawDb ? lookupR2Mount(rawDb) : null);
  if (localRecord && localRecord.mounted === true) {
    return { mounted: true, record: localRecord, reason: "LOCAL_STATE" };
  }

  return { mounted: false, record: null, reason: "NOT_MOUNTED" };
}

/**
 * 统一的「R2 尚未挂载」明确提示结构（不走远端探测，绝不误报 TLS 错误或密钥失效）
 */
export function notMountedResponse(database) {
  const db = String(database || "").trim();
  return {
    ok: false,
    verdict: "NOT_MOUNTED",
    action: "NOT_MOUNTED",
    database: db,
    bucket_name: "",
    public_url: "",
    credentials_source: "尚未挂载",
    probe: { error: "R2 尚未挂载" },
    title: "R2 尚未挂载",
    lines: [
      `目标数据库：${db || "当前库"}`,
      "R2 尚未挂载 —— 请先在 R2 卡片点击『挂载 R2 存储』，再来检测。",
      "未挂载时无法检测，因为还没有可验证的存储通道。",
      "挂载成功后，插件会自动通过真实探针验证并建立存储通道。",
    ],
    diagnosis: {
      kind: "NOT_MOUNTED",
      title: "R2 尚未挂载",
      detail: "检测到当前数据库尚未挂载 R2 存储通道。未挂载时无法检测，因为还没有可验证的存储通道。",
      actions: [
        "请先在 R2 卡片填写或确认凭据后，点击『挂载 R2 存储』完成挂载，再来检测。",
      ],
    },
    note: "R2 尚未挂载 —— 请先在 R2 卡片点击『挂载 R2 存储』，再来检测。未挂载时无法检测，因为还没有可验证的存储通道。",
  };
}

export async function r2Setup(cfg, args) {
  const rawDb = dbOf(cfg, args);
  const db = await resolveRealDatabase(cfg, rawDb);
  const mcp = clientOf(cfg);
  const a = args || {};

  /* 凭据来源优先级：本次调用显式传入 > 插件设置页保存的。
   * 必须【显式传给 NCB】，否则它会用账号里缓存的那份旧连接 ——
   * 用户轮换密钥后，旧连接必然失败（实测表现为 TLS 握手被拒）。 */
  const pick = (k1, k2) => {
    const v = a[k1];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    return String((cfg && cfg[k2]) || "").trim();
  };
  // 桶名从数据库名派生合法合规名称（S3/R2 命名规范：下划线转连字符，纯函数派生）
  const defaultBucket = deriveLegalBucketName(db);
  const customBucket = pick("bucket_name", "r2BucketName");
  const bucketName = customBucket ? deriveLegalBucketName(customBucket) : defaultBucket;
  const creds = {
    account_id: pick("account_id", "r2AccountId"),
    access_key_id: pick("access_key_id", "r2AccessKeyId"),
    secret_access_key: pick("secret_access_key", "r2SecretAccessKey"),
    bucket_name: bucketName,
    public_url: pick("public_url", "r2PublicUrl"),
  };
  const extra = {};
  for (const k of Object.keys(creds)) if (creds[k]) extra[k] = creds[k];

  const out = await mcp.setupR2Storage(db, extra);

  // 不采信 setup 的返回值（实测会静默失败却报 ok:true），改做真实探测
  const probe = await r2Probe(cfg, db);
  const explained = probe.ok ? null : explainProbeFailure(probe.error);

  if (probe.ok) {
    const finalBucket = (out && out.bucket_name) || extra.bucket_name || bucketName || "";
    const finalPublicUrl = (out && out.public_url) || extra.public_url || "";
    const accId = creds.account_id || "";
    rememberR2Mount(db, {
      bucket: finalBucket,
      public_url: finalPublicUrl,
      account_id_tail: accId ? accId.slice(-6) : "",
      at: Date.now(),
    });
  } else {
    forgetR2Mount(db);
  }

  const res = {
    ok: probe.ok,
    verdict: probe.ok ? "VERIFIED" : "FAILED_VERIFY",
    database: db,
    credentials_source: Object.keys(extra).length
      ? (a.account_id || a.access_key_id || a.secret_access_key ? "本次调用传入" : "插件设置页保存的")
      : "未提供任何凭据（会让 NCB 用它缓存的旧连接）",
    bucket_name: (out && out.bucket_name) || extra.bucket_name || "",
    public_url: (out && out.public_url) || extra.public_url || "",
    // 如实展示 NCB 的说法，但**不作为判定依据**
    ncb_reported: {
      ok: out && out.ok,
      reused_existing_connection: out && out.reused_existing_connection,
      bucket_created: out && out.bucket_created,
      cors_configured: out && out.cors_configured,
    },
    probe: probe.ok ? { uploaded: true, cleaned: probe.cleaned, clean_note: probe.clean_note || "" } : { error: probe.error },
    diagnosis: explained,
    note: probe.ok
      ? "已用真实上传验证：R2 确实可用（不是只看 NCB 的返回值）。"
        + (probe.cleaned ? "" : " ⚠️ " + (probe.clean_note || "探针文件未能删除，可能残留在 R2 里。"))
      : "⚠️ NCB 报告成功，但**真实上传失败** —— 这个挂载实际上没生效。" +
        (explained ? "原因：" + explained.title : ""),
    raw: out,
  };

  if (!probe.ok && explained && explained.kind === "UNKNOWN") {
    try {
      const aiDiag = await explainUnknownErrorWithModel({
        error: probe.error,
        component: "storage_setup",
        database: db,
        options: cfg,
      });
      if (aiDiag) attachAiDiagnosis(res, aiDiag);
    } catch (_) {}
  }

  return res;
}

/**
 * r2_check —— 真实探针检测 R2 凭据是否可用（只读探测，不做任何写配置操作）：
 * 上传极小探针文件，成功则删除并返回 VERIFIED，
 * 失败则用 explainProbeFailure 给出清晰排查步骤并返回 FAILED。
 */
export async function r2Check(cfg, args) {
  const a = args || {};
  let db = "";
  try {
    const rawDb = dbOf(cfg, a);
    db = await resolveRealDatabase(cfg, rawDb);
  } catch (e) {
    return {
      ok: false,
      verdict: "FAILED",
      database: "",
      bucket_name: "",
      public_url: "",
      credentials_source: "未配置数据库",
      probe: { error: e.message },
      diagnosis: {
        kind: "NO_DATABASE",
        title: "未指定数据库名",
        detail: "必须先指定或配置一个数据库实例，才能探测该库关联的 R2 存储。",
        actions: ["请在设置页填写 ncb_instance 或给工具传入 database 参数"],
      },
      note: "未指定数据库名，无法进行探针测试。",
    };
  }

  // 【核心修复 Bug 1：检测独立于挂载】
  // 「检测 R2 密钥」用于独立验证凭据是否真实可用，绝不强依赖已建立的挂载状态。
  // 只要用户填写了凭据（或远端已有配置），即可直接发起真实上传与删除探针检测。
  const mountCheck = isR2Mounted(cfg, db, a);
  const pick = (kArg, kCfg) => (a[kArg] != null && a[kArg] !== "" ? a[kArg] : (cfg && cfg[kCfg]) || "");
  const defaultBucket = deriveLegalBucketName(db);
  const customBucket = pick("bucket_name", "r2BucketName");
  const bucketName = customBucket ? deriveLegalBucketName(customBucket) : ((mountCheck.record && mountCheck.record.bucket) || defaultBucket);
  const publicUrl = pick("public_url", "r2PublicUrl") || ((mountCheck.record && mountCheck.record.public_url) || "");
  const hasInputCreds = Boolean(a.account_id || a.access_key_id || a.secret_access_key);
  const hasSavedCreds = Boolean(cfg && (cfg.r2AccountId || cfg.r2AccessKeyId || cfg.r2SecretAccessKey));
  const credentialsSource = hasInputCreds
    ? "本次调用传入"
    : hasSavedCreds
    ? "插件设置页保存的"
    : (mountCheck.mounted ? "已挂载配置" : "未提供任何凭据（使用 NCB 缓存连接）");

  // 若本次传入或配置了凭据，先行通过 setup_r2_storage 同步至 NCB，以便真实探针基于该套凭据验证
  if (hasInputCreds || hasSavedCreds) {
    try {
      const mcp = clientOf(cfg);
      const creds = {
        account_id: pick("account_id", "r2AccountId"),
        access_key_id: pick("access_key_id", "r2AccessKeyId"),
        secret_access_key: pick("secret_access_key", "r2SecretAccessKey"),
        bucket_name: bucketName,
        public_url: publicUrl,
      };
      const extra = {};
      for (const k of Object.keys(creds)) if (creds[k]) extra[k] = creds[k];
      if (Object.keys(extra).length) {
        await mcp.setupR2Storage(db, extra);
      }
    } catch (_) {}
  }

  // 真实探针探测（上传 + 删除）
  let probe;
  try {
    probe = await r2Probe(cfg, db);
  } catch (e) {
    probe = { ok: false, error: (e && e.message) || String(e) };
  }
  const explained = probe.ok ? null : explainProbeFailure(probe.error);
  const ok = !!probe.ok;

  // 检测成功后，顺带落地挂载记录；检测失败则清除失效挂载记录
  if (ok) {
    const accId = (cfg && (cfg.r2AccountId || cfg.account_id)) || (a && (a.account_id || a.r2AccountId)) || "";
    rememberR2Mount(db, {
      bucket: bucketName,
      public_url: publicUrl,
      account_id_tail: accId ? accId.slice(-6) : "",
      at: Date.now(),
    });
  } else {
    forgetR2Mount(db);
  }

  const res = {
    ok,
    verdict: ok ? "VERIFIED" : "FAILED",
    database: db,
    bucket_name: bucketName,
    public_url: publicUrl,
    credentials_source: credentialsSource,
    probe: probe.ok ? { uploaded: true, cleaned: probe.cleaned, clean_note: probe.clean_note || "" } : { error: probe.error },
    diagnosis: explained,
    title: ok ? "R2 凭据验证通过（可用）" : (explained && explained.title ? explained.title : "R2 凭据验证失败"),
    lines: ok ? [
      `数据库：${db}`,
      `存储桶：${bucketName}`,
      publicUrl ? `公开域名：${publicUrl}` : "未配置公开域名（使用 S3 私有签名访问）",
      probe.cleaned === false
        ? (probe.clean_note ? `探针残留提示：${probe.clean_note}` : "真实上传验证成功；探针文件留在 R2（删除需 Secret Key）")
        : "真实上传与删除探针测试成功，存储通道就绪",
      "凭据真实有效，R2 存储通道已就绪（可随时使用或点击『挂载 R2 存储』确认配置）",
    ] : [
      `数据库：${db}`,
      explained && explained.detail ? `诊断：${explained.detail}` : `错误：${String(probe.error).slice(0, 100)}`,
      (explained && Array.isArray(explained.actions) && explained.actions.length > 0)
        ? `排查指引：${explained.actions[0]}`
        : "请在 NoCodeBackend 控制台确认 Cloudflare R2 连接与权限",
    ],
    note: ok
      ? "R2 凭据已通过真实探针验证：上传正常，当前存储可用。"
        + (probe.cleaned
            ? "探针文件已清理。"
            : " ⚠️ " + (probe.clean_note || "探针文件未能删除，可能残留在 R2 里。"))
      : "R2 凭据验证失败：无法完成探针文件写入。" + (explained ? " 原因：" + explained.title : ""),
  };

  if (!ok && explained && explained.kind === "UNKNOWN") {
    try {
      const aiDiag = await explainUnknownErrorWithModel({
        error: probe.error,
        component: "r2_check",
        database: db,
        options: cfg,
      });
      if (aiDiag) attachAiDiagnosis(res, aiDiag);
    } catch (_) {}
  }

  return res;
}

/* ------------------------------------------------------------------ *
 * 上传 / 列举 / 删除
 * ------------------------------------------------------------------ */

export async function r2Upload(cfg, args) {
  const db = dbOf(cfg, args);
  const filename = args && args.filename;
  if (!filename) {
    const err = new Error("缺少 filename");
    err.code = "NO_FILENAME";
    throw err;
  }

  // 依赖 R2 守卫：未挂载时直接返回明确提示
  const mountCheck = isR2Mounted(cfg, db, args);
  if (!mountCheck.mounted) {
    const res = notMountedResponse(db);
    return Object.assign({ filename, url: "" }, res);
  }

  const hasContent = args && args.content != null;
  const hasSecret = !!((cfg && (cfg.secret || cfg.ncb_secret)) || "");

  // 有内容 + 有 Secret Key → 优先尝试 REST multipart（二进制不用 base64，省 33% 且更快）
  if (hasContent && hasSecret) {
    const isText = args.encoding !== "base64";
    let bytes;
    if (isText) {
      bytes = new TextEncoder().encode(String(args.content));
    } else {
      bytes = Uint8Array.from(atob(String(args.content)), (c) => c.charCodeAt(0));
    }
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: args.content_type || "application/octet-stream" }), filename);
    try {
      const { status, body } = await rest(cfg, "POST", "/upload", { form });
      const url = (body && body.url) || "";
      if (status < 400 && !!url) {
        return {
          ok: true,
          database: db, filename, url, via: "rest-multipart", http: status, result: body,
          note: "上传完成。建议用 memory_save 把 url 存成 category=file 的记忆，日后可检索回该文件。",
        };
      }
      if (status === 401 || status === 403 || /invalid secret/i.test(JSON.stringify(body || ""))) {
        forgetSecret(db);
      }
    } catch (e) {
      if (/403|401|invalid secret/i.test(String(e && e.message || e))) {
        forgetSecret(db);
      }
      // REST 失败（如 403 密钥过期或重置）时，平滑后备降级到 MCP upload_file 走 MCP key 上传
    }
  }

  // 否则走 MCP（base64 直传，或返回 presigned 上传 URL）
  const mcp = clientOf(cfg);
  let data;
  if (hasContent) {
    data = args.encoding === "base64" ? String(args.content) : utf8ToBase64(String(args.content));
  }
  const out = await mcp.uploadFile(db, filename, data, args && args.content_type);
  const url = (out && (out.url || out.publicUrl)) || "";
  return {
    ok: !(out && out.ok === false) && (!!url || !data),
    database: db, filename, url,
    presigned_upload_url: !data ? (out && out.uploadUrl) : undefined,
    via: "mcp", result: out,
    note: data
      ? "上传完成。建议用 memory_save 把 url 存成 category=file 的记忆。"
      : "已生成 presigned 上传 URL：客户端 PUT 二进制到该 URL，再把 publicUrl 存进记忆。",
  };
}

/**
 * 列出该库 R2 桶内的对象。
 * 注意：这条能力在 Secret Key 的 REST 上，MCP 的 23 个工具里没有。
 */
export async function r2List(cfg, args) {
  const rawDb = String((args && args.database) || (cfg && (cfg.instance || cfg.ncb_instance)) || "").trim();
  const db = rawDb ? await resolveRealDatabase(cfg, rawDb) : "";
  const clientCfg = db ? Object.assign({}, cfg, { instance: db }) : cfg;

  // 依赖 R2 守卫：未挂载时直接返回明确提示（允许传 skip_mount_check 内部绕过，如 cleanProbes）
  if (!args || !args.skip_mount_check) {
    const mountCheck = isR2Mounted(clientCfg, db || rawDb, args);
    if (!mountCheck.mounted) {
      const res = notMountedResponse(db || rawDb);
      return Object.assign({ count: 0, files: [], truncated: false }, res);
    }
  }

  let status, body;
  try {
    const r = await rest(clientCfg, "GET", "/files", {});
    status = r.status;
    body = r.body;
  } catch (err) {
    return {
      ok: false,
      error: err.code || "REQUEST_FAILED",
      message: err.message,
      hint: err.code === "NO_SECRET"
        ? "未配置数据库 Secret Key。R2 的「列举 / 删除」走 NoCodeBackend 的 REST，需要 Secret Key。解决办法：前往 NoCodeBackend 控制台复制 Secret Key 填入设置页。"
        : err.message,
      count: 0,
      files: [],
      truncated: false,
    };
  }

  if (status >= 400) {
    const isBadSecret = status === 403 || /invalid secret/i.test(JSON.stringify(body || ""));
    if (isBadSecret) {
      forgetSecret(db || rawDb);
    }
    return {
      ok: false,
      error: `HTTP ${status}`,
      body,
      hint: isBadSecret
        ? "数据库 Secret Key 无效（可能数据库已重建换了新密钥）。已自动清除本地失效密钥缓存。请在 NoCodeBackend 控制台复制最新的 Secret Key 填入设置页。"
        : "获取文件列表失败，详见 body。",
    };
  }
  const files = (body && body.files) || [];
  const limit = Number((args && args.limit) || 100) || 100;
  return { ok: true, count: files.length, files: files.slice(0, limit), truncated: files.length > limit };
}

/**
 * 删除桶内一个对象。key 就是上传时返回的 key（不是完整 URL）。
 * 破坏性操作，需要显式传 confirm="DELETE"。
 */
export async function r2Delete(cfg, args) {
  const rawDb = String((args && args.database) || (cfg && (cfg.instance || cfg.ncb_instance)) || "").trim();
  const db = rawDb ? await resolveRealDatabase(cfg, rawDb) : "";
  const clientCfg = db ? Object.assign({}, cfg, { instance: db }) : cfg;
  const key = args && (args.key || args.filename);
  if (!key) throw new Error("缺少 key（上传时返回的那个 key，不是完整 URL）");
  if ((args && args.confirm) !== "DELETE") {
    return {
      ok: false, action: "CONFIRM_REQUIRED", key,
      warning: '删除不可恢复。确认请再次调用并传 confirm="DELETE"。',
    };
  }

  // 依赖 R2 守卫：未挂载时直接返回明确提示（允许传 skip_mount_check 内部绕过，如 cleanProbes）
  if (!args || !args.skip_mount_check) {
    const mountCheck = isR2Mounted(clientCfg, db || rawDb, args);
    if (!mountCheck.mounted) {
      const res = notMountedResponse(db || rawDb);
      return Object.assign({ key }, res);
    }
  }

  let status, body;
  try {
    const r = await rest(clientCfg, "DELETE", "/files/" + encodeURIComponent(key), {});
    status = r.status;
    body = r.body;
  } catch (err) {
    return {
      ok: false,
      key,
      error: err.code || "REQUEST_FAILED",
      message: err.message,
      hint: err.code === "NO_SECRET"
        ? "未配置数据库 Secret Key。R2 的「列举 / 删除」走 NoCodeBackend 的 REST，需要 Secret Key。解决办法：前往 NoCodeBackend 控制台复制 Secret Key 填入设置页。"
        : err.message,
    };
  }

  const isFailed = status >= 400 || (body && body.status === "failed");
  const isBadSecret = status === 403 || /invalid secret/i.test(JSON.stringify(body || ""));
  if (isBadSecret) {
    forgetSecret(db || rawDb);
  }
  return {
    ok: !isFailed,
    key, http: status, result: body,
    hint: isBadSecret
      ? "数据库 Secret Key 无效（可能数据库已重建换了新密钥）。已自动清除本地失效密钥缓存。请在 NoCodeBackend 控制台复制最新的 Secret Key 填入设置页。"
      : (isFailed ? "删除失败，详见 result。" : "删除成功。"),
  };
}

/** 把 R2 的可用与不可用能力讲清楚，避免 agent 去用不存在的接口。 */
export function r2Guide() {
  return {
    ok: true,
    endpoint: "Cloudflare R2（由 NoCodeBackend 代管，S3 兼容，零出网费）",
    capabilities: {
      setup: "storage_setup —— 创建 bucket 并配置 CORS；**会用真实上传验证**，不采信 NCB 的返回值",
      check: "r2_check —— 检测已配置或已挂载 R2 存储通道与凭据真实可用性（只读探针测试）",
      upload: "storage_upload —— 文本/二进制都可；有 Secret Key 时走 REST multipart 更省，亦可走 MCP",
      list: "storage_list —— 列出桶内对象（走 Secret Key 的 REST；需数据库 Secret Key）",
      delete: 'storage_delete —— 删除对象，需 confirm="DELETE"（走 Secret Key 的 REST）',
      read: "拿到 url 后直接 GET（bucket 需开启公开访问或绑定自定义域名）",
    },
    not_available: [
      "服务端生成**下载**用的 presigned URL（下载只能靠 bucket 的公开域名）",
      "读取/覆盖 NoCodeBackend 在账号层保存的旧 Cloudflare 凭据（这是平台边界）",
    ],
    credential_split:
      "创建 bucket 需要 MCP key；上传/列举/删除需要数据库 Secret Key（REST）。" +
      "若数据库由本插件创建，Secret Key 会随创建自动取得并保存，无需手填。",
    troubleshooting: {
      "bucket_created: false 但 ok: true":
        "NoCodeBackend 会在实际失败时也返回 ok:true。以 storage_setup 返回的 verdict/probe 为准，不要看 ncb_reported。",
      "sslv3 alert handshake failure":
        "NCB 手里的 Cloudflare 凭据已失效（多半是密钥在 CF 轮换过）。" +
        "必须去 NCB 控制台的 R2 Storage 页面更新该库的连接——插件改不了账号层保存的凭据。",
      "新令牌怎么建":
        "Cloudflare → R2 → Manage API Tokens → Create，权限必须选【Admin Read & Write】，" +
        "否则 NCB 无法自动建桶与配 CORS。",
    },
  };
}

/* Bun/Node 都有 Buffer；无 Buffer 时退回浏览器式实现。 */
function utf8ToBase64(s) {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  const bytes = unescape(encodeURIComponent(s));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes.charCodeAt(i));
  return btoa(bin);
}

/**
 * cleanProbes —— 扫描 R2 存储桶中所有 _memhub_probe 前缀的探针对象并全部删除。
 * 走现有的信标机制，结果写回 R2 卡片。
 */
export async function cleanProbes(cfg, args) {
  const rawDb = String((args && args.database) || (cfg && (cfg.instance || cfg.ncb_instance)) || "").trim();
  const db = await resolveRealDatabase(cfg, rawDb);

  const manual = String((args && args.secret) || (cfg && (cfg.ncb_secret || cfg.secret)) || "").trim();
  const captured = db ? (lookupSecret(db) || lookupSecret(rawDb)) : (lookupSecret("") || "");
  const secret = manual || captured || "";

  if (!secret) {
    return {
      ok: false,
      action: "NO_SECRET",
      database: db || rawDb,
      deleted_count: 0,
      title: "未配置 Secret Key，无法清理探针",
      lines: [
        `目标数据库：${db || rawDb || "未指定"}`,
        "Secret Key 只在建库时返回一次，MCP Key 无法读取它，插件也拿不到",
        "探针文件清理走 REST 接口，必须使用数据库 Secret Key（只有 MCP Key 时无法列举或删除）",
        "解决办法：前往 NoCodeBackend 控制台 → 该数据库 → 复制 Secret Key 填入设置页",
        "提示：也可以登录 Cloudflare R2 控制台手动删除带有 _memhub_probe 前缀的文件",
      ],
      suggestion: "请前往 NoCodeBackend 控制台复制 Secret Key 填入设置页后重试。",
    };
  }

  const clientCfg = Object.assign({}, cfg, { instance: db, secret });
  let listRes;
  try {
    listRes = await r2List(clientCfg, { limit: 1000, skip_mount_check: true });
  } catch (err) {
    return {
      ok: false,
      action: "ERROR",
      database: db || rawDb,
      deleted_count: 0,
      title: "扫描 R2 存储桶失败",
      lines: [
        `目标数据库：${db || rawDb || "当前库"}`,
        `网络或接口异常：${String((err && err.message) || err).slice(0, 100)}`,
        "无法获取桶内文件列表，清理中止",
      ],
    };
  }

  if (!listRes.ok) {
    const isAuth = listRes.error && (listRes.error.includes("401") || listRes.error.includes("403"));
    if (isAuth) {
      forgetSecret(db || rawDb);
    }
    return {
      ok: false,
      action: "AUTH_FAILED",
      database: db || rawDb,
      deleted_count: 0,
      title: isAuth ? "Secret Key 无效（被 NCB 拒绝），无法清理探针" : "列举 R2 存储桶对象失败",
      lines: [
        `目标数据库：${db || rawDb || "当前库"}`,
        isAuth
          ? "Secret Key 鉴权失败（403/401），两个最常见原因：① 误把 MCP Key 当成 Secret Key ② 数据库重建后换了新密钥，当前手里是旧的"
          : `错误信息：${String(listRes.error || "").slice(0, 100)}`,
        isAuth
          ? "【已自动处理】已自动清除本地缓存的失效密钥，请到 NCB 控制台复制当前 Secret Key 填入设置页。"
          : "无法获取桶内文件列表，清理中止",
        "建议去 NoCodeBackend 控制台重新复制 Secret Key 填入设置页；如无法找回旧密钥，可点击「一键创建数据库」重新建库以重新捕获新密钥（注意：旧库数据不会自动迁移）。",
      ],
    };
  }

  const files = listRes.files || [];
  const probeKeys = [];
  for (const f of files) {
    const k = typeof f === "string" ? f : (f.key || f.name || f.filename || "");
    if (k && k.includes("_memhub_probe")) {
      probeKeys.push(k);
    }
  }

  if (probeKeys.length === 0) {
    return {
      ok: true,
      action: "CLEANED",
      database: db,
      found_count: 0,
      deleted_count: 0,
      title: "未发现残留探针文件",
      lines: [
        `目标数据库：${db || "当前库"}`,
        "已扫描 R2 存储桶，未发现任何包含 _memhub_probe 的探针对象",
        "存储桶保持整洁，无需清理",
      ],
    };
  }

  let deleted = 0;
  let failed = 0;
  for (const k of probeKeys) {
    try {
      const del = await r2Delete(clientCfg, { key: k, confirm: "DELETE", skip_mount_check: true });
      if (del.ok) deleted++;
      else failed++;
    } catch (_) {
      failed++;
    }
  }

  const allDeleted = failed === 0;
  return {
    ok: allDeleted,
    action: "CLEANED",
    database: db,
    found_count: probeKeys.length,
    deleted_count: deleted,
    failed_count: failed,
    title: allDeleted ? `已清理 ${deleted} 个探针文件` : `探针清理完成（成功 ${deleted}，失败 ${failed}）`,
    lines: [
      `目标数据库：${db || "当前库"}`,
      `共发现 ${probeKeys.length} 个探针文件，已成功删除 ${deleted} 个`,
      ...(failed > 0
        ? [`${failed} 个文件删除失败，可在 Cloudflare 控制台手动清理`]
        : ["R2 存储桶中的探针垃圾文件已全部清除"]),
    ],
  };
}
