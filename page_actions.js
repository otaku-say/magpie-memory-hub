/**
 * page_actions.js —— 「设置页按钮 → 宿主动作」的唯一可行通道。
 *
 * 背景（已实测确认，2026-10-16）：
 *   Magpie 的插件设置页运行在 iframe 里，sandbox 仅 allow-scripts，
 *   CSP `connect-src 'none'`，且 iframe 是 Origin: null（连 /api/ 都被 403）。
 *   桥接 API 只有 hello / theme / options.get / options.set / read 五种，
 *   **没有任何通道能让页面直接触发宿主动作**。官方也没有生命周期钩子
 *   （npm 脚本被 --ignore-scripts 全部阻断）。
 *
 * 唯一可行路径：页面把「要做什么」写进 options 当一次性信标，
 * 宿主（Bun，有网络）在每次加载时读取并执行。
 *
 *   页面 → magpie.options.set({...,_action:{op,id,at}}) → plugins.json
 *        → plugin.Restart() → 新宿主加载 → 本模块读取 _action → 执行
 *
 * 已知限制（如实记录，不粉饰）：
 *   1. 执行时机是「宿主下次加载时」——即用户保存设置后，下一次 agent 调用
 *      工具（Magpie 枚举工具会拉起宿主）时才真正执行。
 *   2. **宿主无法把执行结果写回 options**（没有写 API），所以页面无法显示
 *      「执行成功/失败」。结果落在三处：本地状态文件、宿主日志、
 *      schema_meta 表（可用 db_status 工具查看）。
 *   3. options.set 有频控：每秒至多 1 次，超频 HTTP 429。
 *
 * 幂等保证：
 *   - 信标带唯一 id；执行过的 id 记在本地状态文件里，重复加载不会重复执行。
 *   - 即使状态文件丢失，db_init 本身也是幂等的（无差异时产出 0 条语句）。
 *   - db_reset 是破坏性的：若状态文件不可读（无法判定是否已执行过），
 *     **一律拒绝执行**（fail-closed），绝不冒重复清库的风险。
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { dbInit, dbReset, dbStatus, dbProvision, storageSetup, ncbCheck, RESET_CONFIRM } from "./db_tools.js";
import { r2Setup, r2Check } from "./r2.js";
import { checkLocalModel, downloadModel, modelDir, human, MODEL_SPEC } from "./model_check.js";

/** 插件目录下的状态文件路径（供 iframe 内设置页通过 script 标签加载）。 */
export const STATUS_JS_PATH = fileURLToPath(new URL("./_status.js", import.meta.url));
export const STATUS_JSON_PATH = fileURLToPath(new URL("./_status.json", import.meta.url));

/** options 里存放信标的键。以 _ 开头，与用户配置区分。 */
export const ACTION_KEY = "_action";
/** 执行结果也写回 options 的同一个键（页面可读）。 */
export const RESULT_KEY = "_action_result";

const STATE_DIR = ".magpie-memory-hub";
const STATE_FILE = "page-actions.json";

/** 合法的动作类型。 */
export const OPS = {
  provision: "一键创建数据库与全部表/字段/索引，并按需挂载 R2（先查重名，默认复用已有库）",
  storage_setup: "为当前数据库挂载 R2 存储（自动建 bucket 并配置 CORS）",
  init: "创建缺失的表、列、索引（只增不删，幂等）",
  reset: "删除插件三张表（结构与数据一并删除，不可恢复）",
  status: "只读检查结构状态",
  ncb_check: "检测 MCP Key 有效性并检查目标数据库与结构状态（只读检测）",
  r2_check: "检测 R2 凭据是否真的可用（真实上传探针，只读检测）",
  model_check: "检测本地多语言小模型是否已就绪（只读检测）",
  model_download: "下载并安装本地多语言小模型（LLMLingua-2 mBERT INT8，约 174MB，支持断点续传与校验）",
};

let _modelDownloadTask = null;

export function isModelDownloading() {
  return _modelDownloadTask !== null;
}

export function startBackgroundModelDownload(cfg, action) {
  if (_modelDownloadTask) return _modelDownloadTask;

  writeCardStatus("model", {
    at: Date.now(),
    op: "model_download",
    ok: true,
    title: "正在下载本地小模型…",
    lines: [
      "准备连接镜像站并校验已有文件…",
      "目标模型：LLMLingua-2 mBERT（多语言 INT8，174MB）",
      "存储目录：" + modelDir(),
    ],
    progress: {
      percent: 0,
      file: "准备中",
      done_bytes: 0,
      total_bytes: MODEL_SPEC.approx_bytes,
      status: "starting",
    },
  });

  let lastWrite = 0;
  const onProgress = (info) => {
    const now = Date.now();
    if (now - lastWrite > 800 || info.percent === 100 || info.status === "verifying") {
      lastWrite = now;
      writeCardStatus("model", {
        at: now,
        op: "model_download",
        ok: true,
        title: info.status === "verifying"
          ? `正在校验 ${info.file} 的 SHA-256…`
          : `正在下载模型：${info.percent}%（${info.file}）`,
        lines: [
          `当前文件：${info.file}（${human(info.done_bytes)} / ${human(info.total_bytes)}）`,
          `总体进度：${info.percent}%（已完成 ${info.file_index - 1}/${info.total_files} 个文件）`,
          `落点目录：${modelDir()}`,
        ],
        progress: info,
      });
    }
  };

  _modelDownloadTask = downloadModel(cfg, action, onProgress)
    .then((res) => {
      _modelDownloadTask = null;
      writeCardStatus("model", {
        at: Date.now(),
        op: "model_download",
        ok: true,
        title: "本地小模型下载并校验成功",
        lines: [
          "全部 4 个文件已完成校验并原子落地（总大小约 174.1 MB）",
          "文件列表：model.onnx、tokenizer.json、vocab.txt、config.json",
          "存储目录：" + modelDir() + "（Magpie 持久卷）",
          "离线语义压缩已就绪，请求时可按需启用多语言抽取式压缩",
        ],
        progress: { percent: 100, status: "done" },
      });
      return res;
    })
    .catch((err) => {
      _modelDownloadTask = null;
      const errMsg = String((err && err.message) || err);
      writeCardStatus("model", {
        at: Date.now(),
        op: "model_download",
        ok: false,
        title: "本地小模型下载失败",
        lines: [
          "失败原因：" + errMsg,
          "旧模型文件（若存在）未受破坏，仍可继续使用",
          "已下载的临时分块已保留，再次点击可断点续传",
          "排查建议：检查网络连接是否可访问 hf-mirror.com 或 huggingface.co",
        ],
        progress: { percent: 0, status: "failed", error: errMsg },
      });
    });

  return _modelDownloadTask;
}

function statePath(fs, os, path) {
  try {
    return path.join(os.homedir(), STATE_DIR, STATE_FILE);
  } catch (e) {
    return null;
  }
}

function loadState(fs, p) {
  // 返回 { ok, lastDoneId, history }；ok=false 表示读不到/读坏了
  try {
    if (!p || !fs.existsSync(p)) return { ok: true, lastDoneId: "", pendingId: "", history: [], missing: true };
    const raw = fs.readFileSync(p, "utf8");
    const o = JSON.parse(raw);
    return {
      ok: true,
      lastDoneId: String(o.lastDoneId || ""),
      // pendingId：已开始执行但结局未知（进程中途死掉）的 id
      pendingId: String(o.pendingId || ""),
      history: Array.isArray(o.history) ? o.history : [],
    };
  } catch (e) {
    return { ok: false, lastDoneId: "", pendingId: "", history: [], err: String(e && e.message || e) };
  }
}

function saveState(fs, p, state) {
  try {
    const dir = p.slice(0, p.lastIndexOf("/"));
    fs.mkdirSync(dir, { recursive: true });
    // 只留最近 50 条历史，避免无限增长
    const hist = (state.history || []).slice(-50);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ lastDoneId: state.lastDoneId, pendingId: state.pendingId || "", history: hist }, null, 2));
    fs.renameSync(tmp, p);      // 原子替换
    return true;
  } catch (e) {
    return false;
  }
}

/** 读取 options 里的信标；没有或格式非法则返回 null。 */
export function readAction(options) {
  const a = options && options[ACTION_KEY];
  if (!a || typeof a !== "object") return null;
  const op = String(a.op || "");
  const id = String(a.id || "");
  if (!op || !id || !Object.prototype.hasOwnProperty.call(OPS, op)) return null;
  return {
    op, id,
    at: Number(a.at) || 0,
    database: a.database ? String(a.database) : "",
    confirm: a.confirm ? String(a.confirm) : "",
    on_exist: a.on_exist ? String(a.on_exist) : "",
    with_r2: a.with_r2 === false ? false : undefined,
    bucket_name: a.bucket_name ? String(a.bucket_name) : "",
    public_url: a.public_url ? String(a.public_url) : "",
    account_id: a.account_id ? String(a.account_id) : "",
    access_key_id: a.access_key_id ? String(a.access_key_id) : "",
    secret_access_key: a.secret_access_key ? String(a.secret_access_key) : "",
    region: a.region ? String(a.region) : "",
  };
}

/**
 * 执行 options 里的待办任务（若存在且未执行过）。
 * 返回 { ran, op, id, result?, reason? }。
 * 绝不抛异常 —— 宿主入口不能被它搞崩。
 */
export async function runPendingAction(options, cfg) {
  let fs, os, path;
  try {
    fs = await import("node:fs");
    os = await import("node:os");
    path = await import("node:path");
  } catch (e) {
    return { ran: false, reason: "宿主无文件系统能力，跳过信标" };
  }

  const action = readAction(options);
  if (!action) return { ran: false, reason: "没有待办任务" };

  const sp = statePath(fs, os, path);
  const state = loadState(fs, sp);

  // 已经执行完同一个 id → 不再执行
  if (state.ok && state.lastDoneId === action.id) {
    return { ran: false, op: action.op, id: action.id, reason: "该任务已执行过（幂等跳过）" };
  }
  // 同一 id 已经开始过但没记到完成（进程中途死掉，结局未知）
  if (state.ok && state.pendingId === action.id) {
    if (action.op !== "reset") {
      // init/status 是幂等安全操作，重跑无妨
      return await execute(action, cfg, fs, sp, state);
    }
    return {
      ran: false, op: action.op, id: action.id,
      reason: "这条清库任务此前已开始执行但结局未知（进程可能中途中断）。" +
        "为避免误判，已拒绝重跑；请在设置页重新点击「清空数据库」提交一条新任务。",
    };
  }

  /* ---- 破坏性操作的 fail-closed 判定 ----
   * 关键点：不能一遇到「文件缺失」就拒绝，否则【首次清库】永远被拒，成为死循环。
   * 正确判据是区分两种情况：
   *   文件缺失 + 信标【陈旧】  → 这是一条被回放的老信标（文件被删过），拒绝
   *   文件缺失 + 信标【新鲜】  → 用户刚刚点的，就是首次执行，放行
   * 文件存在但损坏（状态不可信）→ 一律拒绝。
   * 陈旧阈值取 5 分钟：正常点击到宿主加载远小于它。 */
  const STALE_MS = 5 * 60 * 1000;
  if (action.op === "reset") {
    if (!state.ok) {
      return {
        ran: false, op: action.op, id: action.id,
        reason: "执行记录文件损坏，无法确认清库任务是否已执行过；为避免重复清库已拒绝执行。" +
          "请在设置页重新点击「清空数据库」。",
      };
    }
    if (state.missing && action.at > 0 && Date.now() - action.at > STALE_MS) {
      return {
        ran: false, op: action.op, id: action.id,
        reason: "这条清库信标已提交 " + Math.round((Date.now() - action.at) / 60000) +
          " 分钟，且本地没有它的执行记录（记录可能被删除）。为避免重复清库已拒绝。" +
          "确认要清库请在设置页重新点击「清空数据库」。",
      };
    }
  }

  return await execute(action, cfg, fs, sp, state);
}

/**
 * 真正执行一条信标。
 *
 * write-ahead 与「已完成」必须分开记：
 *   pendingId   = 已开始执行、但结局未知（进程可能中途死掉）
 *   lastDoneId  = 确定执行完成
 * 若把两者混为一谈（早先的实现就是把 write-ahead 直接写成 lastDoneId），
 * 被「二次确认门」拦下的任务会被误记为已执行，用户再也无法重试。
 */
async function execute(action, cfg, fs, sp, state) {
  const args = { database: action.database || undefined };
  if (action.op === "reset") args.confirm = action.confirm || "";
  if (action.op === "provision") {
    // 重名策略等参数随信标一起传进来
    if (action.on_exist) args.on_exist = action.on_exist;
    if (action.with_r2 !== undefined) args.with_r2 = action.with_r2;
    for (const k of ["bucket_name", "public_url", "account_id", "access_key_id", "secret_access_key", "region"]) {
      if (action[k]) args[k] = action[k];
    }
  }
  if (action.op === "storage_setup") {
    // 挂载时把插件里保存的 R2 凭据一并传下去（信标里带的优先）
    for (const k of ["bucket_name", "public_url", "account_id", "access_key_id", "secret_access_key"]) {
      if (action[k]) args[k] = action[k];
    }
  }

  // 破坏性操作：先落「即将执行」，万一中途中断也不会被重复执行
  if (action.op === "reset") {
    saveState(fs, sp, {
      lastDoneId: state.lastDoneId || "",
      pendingId: action.id,
      history: (state.history || []).concat([{ id: action.id, op: action.op, at: Date.now(), started: true }]),
    });
  }

  let result;
  try {
    if (action.op === "provision") result = await dbProvision(cfg, args);
    else if (action.op === "storage_setup") result = await storageSetup(cfg, args);
    else if (action.op === "init") result = await dbInit(cfg, args);
    else if (action.op === "reset") result = await dbReset(cfg, args);
    else if (action.op === "ncb_check") result = await ncbCheck(cfg, args);
    else if (action.op === "r2_check") result = await r2Check(cfg, args);
    else if (action.op === "model_check") result = await checkLocalModel({ checkUpstream: true });
    else if (action.op === "model_download") {
      if (isModelDownloading()) {
        result = {
          ok: true,
          action: "IN_PROGRESS",
          title: "本地小模型正在下载中",
          lines: [
            "后台下载任务已在进行中，无需重复触发",
            "支持断点续传与 sha256 校验，请关注卡片进度条",
            "完成后将自动就绪并更新卡片状态",
          ],
        };
      } else {
        startBackgroundModelDownload(cfg, action);
        result = {
          ok: true,
          action: "STARTED",
          title: "已开始下载本地小模型",
          lines: [
            "已启动后台下载任务（约 174MB，支持断点续传与 sha256 校验）",
            "国内优先走 hf-mirror.com 镜像，失败自动回退官方 HuggingFace",
            "下载期间不会阻塞 agent 对话，可在本卡片查看实时下载进度",
          ],
        };
      }
    }
    else result = await dbStatus(cfg, args);
  } catch (e) {
    result = { ok: false, error: String(e && e.message || e) };
  }

  // 写入卡片状态文件（供设置页读取）
  try {
    // 结果写到哪张卡片 —— 必须逐项显式映射，不能只分两类。
    // 早先写成 `op === "storage_setup" ? "r2" : "ncb"`，导致 r2_check 的结果
    // 被写进 NoCodeBackend 卡片、model_check 干脆无处可去（它当时也没实现）。
    const CARD_OF_OP = {
      provision: "ncb", init: "ncb", reset: "ncb", status: "ncb", ncb_check: "ncb",
      storage_setup: "r2", r2_check: "r2",
      model_check: "model", model_download: "model",
    };
    const cardKey = CARD_OF_OP[action.op] || "ncb";
    writeCardStatus(cardKey, result, action.op);
  } catch (e) {
    console.error("[memory-hub] writeCardStatus execution error:", (e && e.message) || e);
  }

  // 被确认门拦下 = 什么都没发生 → 清掉 pendingId，保留原 lastDoneId，用户可重试
  const blocked = !!(result && result.action === "CONFIRM_REQUIRED");
  if (blocked) {
    saveState(fs, sp, {
      lastDoneId: state.lastDoneId || "",
      pendingId: "",
      history: (state.history || []).concat([{ id: action.id, op: action.op, at: Date.now(), blocked: true }]),
    });
    return { ran: true, op: action.op, id: action.id, executed: false, result };
  }

  saveState(fs, sp, {
    lastDoneId: action.id,
    pendingId: "",
    history: (state.history || []).concat([{ id: action.id, op: action.op, at: Date.now(), ok: !!(result && result.ok) }]),
  });
  return { ran: true, op: action.op, id: action.id, executed: true, result };
}

/* ================================================================== *
 * 状态文件回传（让被 CSP/sandbox 隔离的设置页通过 <script> 读到执行结果）
 * ================================================================== */

/**
 * 格式化卡片状态项为统一人话结构：
 * { at, op, ok, title, lines: [2~5 条关键事实] }
 */
export function formatCardStatus(key, rawResult, opHint) {
  let res = rawResult;
  if (typeof res === "string") {
    try {
      res = JSON.parse(res);
    } catch (_) {
      res = { error: res };
    }
  }
  if (!res || typeof res !== "object") {
    res = { error: String(res) };
  }

  const at = typeof res.at === "number" ? res.at : Date.now();
  const op = String(opHint || res.op || "unknown");
  const ok = res.ok !== false && res.verdict !== "FAILED" && res.verdict !== "FAILED_VERIFY";

  // 若传入的已具备完整的 title 和 lines，则直接标准化后返回
  if (typeof res.title === "string" && Array.isArray(res.lines) && res.lines.length >= 2) {
    const card = {
      at,
      op,
      ok,
      title: res.title,
      lines: res.lines.map(String).slice(0, 5),
    };
    if (res.progress) card.progress = res.progress;
    return card;
  }

  let title = "";
  const lines = [];

  if (key === "ncb") {
    if (op === "provision") {
      if (ok) {
        title = res.action === "CREATED" ? "一键创建完成（新建数据库）" : "一键创建完成（复用既有库）";
        lines.push(`数据库：${res.database || "已就绪"}`);
        if (res.schema && typeof res.schema === "object") {
          const applied = res.schema.applied != null ? res.schema.applied : 0;
          lines.push(`结构变更：已应用 ${applied} 处表结构/索引设置`);
        } else {
          lines.push("核心表与索引均已就绪（3 表 / 4 索引）");
        }
        if (res.secret_captured) {
          lines.push("已自动捕获并保存 Secret Key，数据读写直接可用");
        }
        if (res.r2) {
          lines.push(res.r2.ok ? `R2 存储：已挂载（${res.r2.bucket || "默认桶"}）` : "R2 存储：挂载未生效，需检查凭据");
        }
      } else {
        title = "一键创建失败";
        if (res.reason) lines.push(`原因：${res.reason}`);
        else if (res.error) lines.push(`错误：${res.error}`);
        else lines.push("无法完成数据库创建与结构初始化");
        if (res.suggestion) lines.push(res.suggestion);
        else lines.push("请在设置页确认 MCP Key 是否有效");
        lines.push("确认 MCP Key 拥有 NoCodeBackend 控制台建库权限");
      }
    } else if (op === "init") {
      if (ok) {
        title = res.action === "NOOP" ? "数据库结构已就绪（无需变更）" : "数据库初始化完成";
        lines.push(`数据库：${res.database || "当前库"}`);
        lines.push(`应用变更：${res.applied != null ? res.applied : 0} 处`);
        lines.push(res.note || "3 张核心表及唯一索引已处于最新状态");
      } else {
        title = "数据库初始化失败";
        lines.push(`原因：${res.error || res.reason || "DDL 执行中断"}`);
        if (res.failed && res.failed.length) lines.push(`失败语句：${res.failed.length} 条`);
        lines.push("请检查 MCP Key 权限或稍后重试");
      }
    } else if (op === "status") {
      if (ok) {
        title = res.initialized ? "数据库结构完整就绪" : "数据库结构存在缺失";
        lines.push(`数据库：${res.database || "当前库"}`);
        if (res.initialized) {
          lines.push("核心表状态：3 张表与索引均已就绪");
        } else {
          const missing = (res.missing_tables || []).concat(res.missing_columns || []);
          lines.push(`缺失项：${missing.join(", ") || "需补齐结构"}`);
        }
        lines.push(res.read_only ? "当前模式：只读检查（未填 MCP Key）" : "当前模式：完整管理（已填 MCP Key）");
      } else {
        title = "数据库状态检查失败";
        lines.push(`原因：${res.reason || res.error || "无法获取数据库结构"}`);
        lines.push(res.hint || "请检查网络连接及数据库实例名是否正确");
      }
    } else if (op === "reset") {
      if (res.action === "CONFIRM_REQUIRED") {
        title = "清库需要二次确认";
        lines.push(`目标数据库：${res.database || "当前库"}`);
        lines.push("操作将永久删除 memories/pitfalls/schema_meta 及其数据");
        lines.push("若确认清空，请在工具或信标中传入 confirm='RESET'");
      } else if (ok) {
        title = "记忆库三表已清空";
        lines.push(`数据库：${res.database || "当前库"}`);
        lines.push(`已删除表：${(res.dropped || []).join(", ") || "memories, pitfalls, schema_meta"}`);
        lines.push("表结构与数据已彻底清除，可随时点击「初始化」重建");
      } else {
        title = "清空数据库失败";
        lines.push(`原因：${res.error || res.reason || "删除表失败"}`);
        lines.push("请检查 MCP Key 是否拥有 DROP TABLE 权限");
      }
    } else if (op === "ncb_check") {
      title = res.title || (ok ? "MCP Key 有效" : "MCP Key 验证失败");
      if (Array.isArray(res.lines) && res.lines.length) {
        lines.push(...res.lines);
      } else {
        lines.push(ok ? "MCP Key 验证成功" : "MCP Key 验证未通过");
        if (res.database) lines.push(`目标数据库：${res.database}`);
        if (res.diagnosis && res.diagnosis.detail) lines.push(res.diagnosis.detail);
      }
    } else {
      title = ok ? "操作执行成功" : "操作执行失败";
      lines.push(`操作类型：${op}`);
      if (res.database) lines.push(`数据库：${res.database}`);
      if (res.note || res.reason || res.error) lines.push(res.note || res.reason || res.error);
    }
  } else if (key === "r2") {
    if (op === "storage_setup" || op === "r2_check") {
      if (ok) {
        title = op === "r2_check" ? "R2 凭据验证通过（可用）" : "R2 存储挂载成功";
        lines.push(`数据库：${res.database || "当前库"}`);
        lines.push(`存储桶：${res.bucket_name || "已绑定"}`);
        if (res.public_url) lines.push(`公开域名：${res.public_url}`);
        lines.push("真实上传与删除探针测试成功，存储通道就绪");
      } else {
        const diag = res.diagnosis;
        title = diag && diag.title ? diag.title : (op === "r2_check" ? "R2 凭据验证失败" : "R2 挂载未生效");
        lines.push(`数据库：${res.database || "当前库"}`);
        if (diag && diag.detail) lines.push(diag.detail);
        else if (res.probe && res.probe.error) lines.push(`探针失败：${res.probe.error}`);
        else if (res.error) lines.push(`错误：${res.error}`);
        else lines.push("真实上传探针失败，存储无法正常工作");

        if (diag && Array.isArray(diag.actions) && diag.actions.length) {
          lines.push(diag.actions[0]);
          if (diag.actions[1] && lines.length < 5) lines.push(diag.actions[1]);
        } else {
          lines.push("请到 NoCodeBackend 控制台确认 Cloudflare R2 连接与权限");
        }
      }
    } else {
      title = ok ? "R2 操作完成" : "R2 操作失败";
      lines.push(`操作：${op}`);
      if (res.database) lines.push(`数据库：${res.database}`);
      if (res.note || res.error) lines.push(res.note || res.error);
    }
  } else if (key === "gateway") {
    title = res.title || (ok ? "网关对话提炼就绪" : "未检测到对话录制");
    if (Array.isArray(res.lines) && res.lines.length) {
      lines.push(...res.lines);
    } else if (res.message) {
      lines.push(res.message);
    } else {
      lines.push(ok ? "网关对话提炼功能正常运行" : "未检测到对话录制。请在 Magpie 设置里开启 GatewayConversations（本地录制对话，插件据此提炼记忆）。");
    }
  }

  while (lines.length < 2) {
    lines.push(ok ? "操作已正常完成" : "请根据提示排查后重试");
  }

  const outCard = {
    at,
    op,
    ok,
    title: title || (ok ? "操作成功" : "操作失败"),
    lines: lines.slice(0, 5),
  };
  if (res.progress) outCard.progress = res.progress;
  return outCard;
}

/**
 * 把单张卡片的执行结果合并写入 _status.js（同时维护内部真相源 _status.json）。
 *
 * 保证：
 *   - 原子写：先写 .tmp 再 renameSync
 *   - 合并写：只更新 key（ncb 或 r2），不抹掉对方
 *   - 静默降级：只读目录或写文件报错时不抛异常，只在 console.error 里打日志
 */
export function writeCardStatus(key, payloadOrResult, opHint, customStatusPath) {
  if (key !== "ncb" && key !== "r2" && key !== "model" && key !== "gateway") {
    console.error(`[memory-hub] writeCardStatus: invalid key "${key}", must be "ncb", "r2", "model" or "gateway"`);
    return false;
  }

  const jsPath = customStatusPath || STATUS_JS_PATH;
  const jsonPath = jsPath.replace(/\.js$/, ".json");
  const nonce = Date.now() + "." + Math.random().toString(36).slice(2, 8);
  const tmpJsonPath = jsonPath + ".tmp." + nonce;
  const tmpJsPath = jsPath + ".tmp." + nonce;

  try {
    // 1. 读回现有内容（优先从真相源 _status.json 读，退避时解析 _status.js）
    let current = {};
    if (fs.existsSync(jsonPath)) {
      try {
        current = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      } catch (_) {
        current = {};
      }
    } else if (fs.existsSync(jsPath)) {
      try {
        const text = fs.readFileSync(jsPath, "utf8");
        const m = text.match(/window\.__memhubStatus\s*=\s*(\{[\s\S]*\});?\s*$/);
        if (m) {
          current = JSON.parse(m[1]);
        }
      } catch (_) {
        current = {};
      }
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      current = {};
    }

    // 2. 格式化本次更新的卡片项
    const entry = formatCardStatus(key, payloadOrResult, opHint);
    current[key] = entry;

    // 3. 序列化
    const jsonStr = JSON.stringify(current, null, 2);
    const jsStr = `window.__memhubStatus = ${jsonStr};\n`;

    // 4. 原子写内部真相源 _status.json
    fs.writeFileSync(tmpJsonPath, jsonStr, "utf8");
    fs.renameSync(tmpJsonPath, jsonPath);

    // 5. 原子写设置页 script 标签目标 _status.js
    fs.writeFileSync(tmpJsPath, jsStr, "utf8");
    fs.renameSync(tmpJsPath, jsPath);

    return true;
  } catch (err) {
    try { if (fs.existsSync(tmpJsonPath)) fs.unlinkSync(tmpJsonPath); } catch (_) {}
    try { if (fs.existsSync(tmpJsPath)) fs.unlinkSync(tmpJsPath); } catch (_) {}

    console.error("[memory-hub] writeCardStatus failed (directory read-only or not writable):", (err && err.message) || err);
    return false;
  }
}
