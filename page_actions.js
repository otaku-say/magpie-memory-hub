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
 *      memhub_meta 表（可用 db_status 工具查看）。
 *   3. options.set 有频控：每秒至多 1 次，超频 HTTP 429。
 *
 * 幂等保证：
 *   - 信标带唯一 id；执行过的 id 记在本地状态文件里，重复加载不会重复执行。
 *   - 即使状态文件丢失，db_init 本身也是幂等的（无差异时产出 0 条语句）。
 *   - db_reset 是破坏性的：若状态文件不可读（无法判定是否已执行过），
 *     **一律拒绝执行**（fail-closed），绝不冒重复清库的风险。
 */
import { dbInit, dbReset, dbStatus, dbProvision, storageSetup, RESET_CONFIRM } from "./db_tools.js";

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
};

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
  if (!op || !id || !OPS[op]) return null;
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
    else result = await dbStatus(cfg, args);
  } catch (e) {
    result = { ok: false, error: String(e && e.message || e) };
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
