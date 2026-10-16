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

/** NoCodeBackend 的 REST 客户端（用数据库 Secret Key 认证）。 */
function restClient(cfg) {
  const secret = (cfg && (cfg.secret || cfg.ncb_secret)) || "";
  const instance = (cfg && (cfg.instance || cfg.ncb_instance)) || "";
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
  const db = database || dbOf(cfg, {});
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
      keys.push(name);
      const hasSecret = !!(cfg && (cfg.secret || cfg.ncb_secret));
      if (!hasSecret) {
        cleanNote = "未配置数据库 Secret Key，无法删除探针（R2 删除走 REST 接口，只有 MCP key 时只能上传）";
      } else {
        for (const k of keys) {
          try {
            const r = await rest(cfg, "DELETE", "/files/" + encodeURIComponent(k), {});
            if (r.status < 400) { cleaned = true; break; }
          } catch (e) {
            if (e.name === "AbortError" || (signal && signal.aborted)) throw e;
          }
        }
        if (!cleaned) cleanNote = "探针文件删除失败（已尝试返回的 key 与原始文件名），它可能仍留在 R2 里";
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
  if (/handshake failure|SSL alert number 40|EPROTO|sslv3/i.test(m)) {
    return {
      kind: "STALE_CREDENTIALS",
      title: "R2 凭据在 Cloudflare 侧被拒绝（TLS 握手失败）",
      detail:
        "NoCodeBackend 拿它自己保存的 Cloudflare 凭据去连 R2，Cloudflare 拒绝了这次握手 —— " +
        "通常是因为那把密钥已在 Cloudflare 轮换/删除，或新令牌权限不足。",
      actions: [
        "① 确认新的 R2 API Token 权限选的是【Admin Read & Write】。" +
          "只选 Object Read & Write 时 NoCodeBackend 无法自动建桶与配 CORS，而且会静默失败（返回 ok:true 但没做事）。",
        "② 到 NoCodeBackend 控制台的 R2 Storage 页面，把该数据库的 Cloudflare 连接【更新】或【删除后重建】，" +
          "填入新的 Account ID / Access Key / Secret。" +
          "插件无法替 NCB 覆盖它在账号层保存的旧连接 —— 这是平台边界。",
        "③ 改完后回到插件重新点「挂载 R2 存储」，本次会用真实上传验证。",
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

export async function r2Setup(cfg, args) {
  const db = dbOf(cfg, args);
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
  const creds = {
    account_id: pick("account_id", "r2AccountId"),
    access_key_id: pick("access_key_id", "r2AccessKeyId"),
    secret_access_key: pick("secret_access_key", "r2SecretAccessKey"),
    bucket_name: pick("bucket_name", "r2BucketName"),
    public_url: pick("public_url", "r2PublicUrl"),
  };
  const extra = {};
  for (const k of Object.keys(creds)) if (creds[k]) extra[k] = creds[k];

  const out = await mcp.setupR2Storage(db, extra);

  // 不采信 setup 的返回值（实测会静默失败却报 ok:true），改做真实探测
  const probe = await r2Probe(cfg, db);
  const explained = probe.ok ? null : explainProbeFailure(probe.error);

  return {
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
    db = dbOf(cfg, a);
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

  const pick = (kArg, kCfg) => (a[kArg] != null && a[kArg] !== "" ? a[kArg] : (cfg && cfg[kCfg]) || "");
  const bucketName = pick("bucket_name", "r2BucketName");
  const publicUrl = pick("public_url", "r2PublicUrl");
  const hasInputCreds = Boolean(a.account_id || a.access_key_id || a.secret_access_key);
  const hasSavedCreds = Boolean(cfg && (cfg.r2AccountId || cfg.r2AccessKeyId || cfg.r2SecretAccessKey));
  const credentialsSource = hasInputCreds
    ? "本次调用传入"
    : hasSavedCreds
    ? "插件设置页保存的"
    : "未提供任何凭据（使用 NCB 缓存连接）";

  // 不做 setupR2Storage，直接用真实探针判断凭据是否可用
  const probe = await r2Probe(cfg, db);
  const explained = probe.ok ? null : explainProbeFailure(probe.error);
  const ok = !!probe.ok;

  return {
    ok,
    verdict: ok ? "VERIFIED" : "FAILED",
    database: db,
    bucket_name: bucketName,
    public_url: publicUrl,
    credentials_source: credentialsSource,
    probe: probe.ok ? { uploaded: true, cleaned: probe.cleaned, clean_note: probe.clean_note || "" } : { error: probe.error },
    diagnosis: explained,
    note: ok
      ? "R2 凭据已通过真实探针验证：上传正常，当前存储可用。"
        + (probe.cleaned
            ? "探针文件已清理。"
            : " ⚠️ " + (probe.clean_note || "探针文件未能删除，可能残留在 R2 里。"))
      : "R2 凭据验证失败：无法完成探针文件写入。" + (explained ? " 原因：" + explained.title : ""),
  };
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

  const hasContent = args && args.content != null;
  const hasSecret = !!((cfg && (cfg.secret || cfg.ncb_secret)) || "");

  // 有内容 + 有 Secret Key → REST multipart（二进制不用 base64，省 33% 且更快）
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
    const { status, body } = await rest(cfg, "POST", "/upload", { form });
    const url = (body && body.url) || "";
    return {
      ok: status < 400 && !!url,
      database: db, filename, url, via: "rest-multipart", http: status, result: body,
      note: url
        ? "上传完成。建议用 memory_save 把 url 存成 category=file 的记忆，日后可检索回该文件。"
        : "上传失败，详见 result。",
    };
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
  const { status, body } = await rest(cfg, "GET", "/files", {});
  if (status >= 400) return { ok: false, error: `HTTP ${status}`, body };
  const files = (body && body.files) || [];
  const limit = Number((args && args.limit) || 100) || 100;
  return { ok: true, count: files.length, files: files.slice(0, limit), truncated: files.length > limit };
}

/**
 * 删除桶内一个对象。key 就是上传时返回的 key（不是完整 URL）。
 * 破坏性操作，需要显式传 confirm="DELETE"。
 */
export async function r2Delete(cfg, args) {
  const key = args && (args.key || args.filename);
  if (!key) throw new Error("缺少 key（上传时返回的那个 key，不是完整 URL）");
  if ((args && args.confirm) !== "DELETE") {
    return {
      ok: false, action: "CONFIRM_REQUIRED", key,
      warning: '删除不可恢复。确认请再次调用并传 confirm="DELETE"。',
    };
  }
  const { status, body } = await rest(cfg, "DELETE", "/files/" + encodeURIComponent(key), {});
  return {
    ok: status < 400 && !(body && body.status === "failed"),
    key, http: status, result: body,
  };
}

/** 把 R2 的可用与不可用能力讲清楚，避免 agent 去用不存在的接口。 */
export function r2Guide() {
  return {
    ok: true,
    endpoint: "Cloudflare R2（由 NoCodeBackend 代管，S3 兼容，零出网费）",
    capabilities: {
      setup: "r2_setup —— 创建 bucket 并配置 CORS；**会用真实上传验证**，不采信 NCB 的返回值",
      setup_storage: "storage_setup —— 同上（别名）",
      upload: "r2_upload —— 文本/二进制都可；有 Secret Key 时走 REST multipart，更省",
      list: "r2_list —— 列出桶内对象（走 Secret Key 的 REST；MCP 没有这个接口）",
      delete: 'r2_delete —— 删除对象，需 confirm="DELETE"（走 Secret Key 的 REST）',
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
        "NoCodeBackend 会在实际失败时也返回 ok:true。以 r2_setup 返回的 verdict/probe 为准，不要看 ncb_reported。",
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
