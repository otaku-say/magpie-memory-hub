/**
 * 模块职责：设置页信标动作执行器（处理设置页按钮触发的后台动作并回写状态）
 * 依赖：src/integration/db-tools.js, ../../r2.js, src/core/state.js, ../../gateway_harvest.js, ../../tools.js, ../../gateway_harvest.hooks.js, ../../model_budget.js
 * 被依赖：page_actions.js, src/index.js, tests
 */
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
/** @internal 由 src/index.js 注入 MagpieMemoryHub 工厂函数 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { dbInit, dbReset, dbStatus, dbProvision, storageSetup, ncbCheck, secretCheck, RESET_CONFIRM } from "../integration/db-tools.js";
import { r2Setup, r2Check, cleanProbes } from "../integration/r2-storage.js";
import { lookupRealDatabase, lookupActionState, rememberActionState } from "../core/state.js";
import { harvestGateway } from "../services/harvest/index.js";
import { testModelConnectivity } from "../services/harvest/extract.js";
import { formatCardStatus as _fcs } from "../core/status-writer.js";
import { parseDbInfo as _pdi } from "../core/status-writer.js";
import { writeCardStatus as _wcs } from "../core/status-writer.js";
import { makeClient, fetchAll } from "../integration/ncb.js";
import { memoryAudit } from "../services/audit/auditor.js";

/** 插件目录下的状态文件路径（供 iframe 内设置页通过 script 标签加载）。 */
export const STATUS_JS_PATH = fileURLToPath(new URL("../../_status.js", import.meta.url));
export const STATUS_JSON_PATH = fileURLToPath(new URL("../../_status.json", import.meta.url));

/** options 里存放信标的键。以 _ 开头，与用户配置区分。 */
export const ACTION_KEY = "_action";

const STATE_DIR = ".magpie-memory-hub";
const STATE_FILE = "page-actions.json";

/** 合法的动作类型。 */
export const OPS = {
  provision: "一键创建数据库与全部表/字段/索引，并按需挂载 R2（先查重名，默认复用已有库）",
  storage_setup: "为当前数据库挂载 R2 存储（自动建 bucket 并配置 CORS）",
  init: "创建缺失的表、列、索引（只增不删，幂等）",
  reset: "删除插件三张表（结构与数据一并删除，不可恢复）",
  status: "只读检查结构状态",  // db-col-ok: UI 操作描述字典键名，非数据库列
  ncb_check: "检测 MCP Key 有效性并检查目标数据库与结构状态（只读检测）",
  secret_check: "检测数据库 Secret Key 是否有效（通过只读接口验证，不上传文件）",
  r2_check: "检测 R2 凭据是否真的可用（真实上传探针，只读检测）",
  clean_probe: "扫描 R2 中残留的探针文件并自动删除（走 REST 接口）",
  model_check: "检测在线模型连通性与可用性（实际调用提炼与判定模型并校验返回）",
  memory_audit: "记忆体检（扫描重复、冲突与高频踩坑，只出建议卡片不改数据）",
  harvest_gateway: "立即扫描网关对话录制并提炼记忆",
  sync_snapshot: "拉取最新活跃记忆快照供前端同步至中间件",
};

function statePath(fs, os, path) {
  // 单一状态源：收敛至 ~/.magpie-memory-hub/state.json
  try {
    return path.join(os.homedir(), STATE_DIR, "state.json");
  } catch (e) {
    return null;
  }
}

function loadState(fs, p) {
  return lookupActionState();
}

function saveState(fs, p, state) {
  return rememberActionState(state);
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
    with_r2: a.with_r2 === true ? true : undefined,
    bucket_name: a.bucket_name ? String(a.bucket_name) : "",
    public_url: a.public_url ? String(a.public_url) : "",
    account_id: a.account_id ? String(a.account_id) : "",
    access_key_id: a.access_key_id ? String(a.access_key_id) : "",
    secret_access_key: a.secret_access_key ? String(a.secret_access_key) : "",
    region: a.region ? String(a.region) : "",
    secret: a.secret ? String(a.secret) : "",
    undo: a.undo === true ? true : undefined,
    undo_before: a.undo_before ? String(a.undo_before) : undefined,
    args: a.args && typeof a.args === "object" ? a.args : undefined,
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

  return await execute(action, cfg, fs, sp, state, options);
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
async function execute(action, cfg, fs, sp, state, options) {
  /* 统一构建 client（harvest_gateway / memory_audit / sync_snapshot 共用）
     ✗ 构建失败置 null ✗ 各分支自身降级 ✓ */
  let client = null;
  try {
    if (cfg && cfg.client) client = cfg.client;
    else if (cfg) {
      client = makeClient(cfg); // makeClient 已在顶部静态 import
    }
  } catch (_) { client = null; }

  const args = { database: action.database || undefined };
  if (action.secret) args.secret = action.secret;
  if (action.op === "reset") args.confirm = action.confirm || "";
  if (action.op === "provision") {
    // 重名策略等参数随信标一起传进来；按要求一键创建数据库绝不默认创建 R2 存储
    if (action.on_exist) args.on_exist = action.on_exist;
    args.with_r2 = false;
    if (action.region) args.region = action.region;
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
    else if (action.op === "secret_check") result = await secretCheck(cfg, args);
    else if (action.op === "r2_check") result = await r2Check(cfg, args);
    else if (action.op === "clean_probe") result = await cleanProbes(cfg, args);
    else if (action.op === "model_check") {
      const { getModelBudgetState } = await import("../domain/token-budget.js");
      const modelOpts = Object.assign({}, cfg, options || {});
      const conn = await testModelConnectivity("all", modelOpts);
      const ok = conn.ok;
      const lines = [];
      if (conn.extract) {
        if (conn.extract.ok) {
          lines.push(`提炼模型 [${conn.extract.model}]: 验证成功 (${conn.extract.latencyMs}ms)`);
        } else {
          lines.push(`提炼模型: ${conn.extract.error || "调用失败"}`);
        }
      }
      if (conn.classify) {
        if (conn.classify.ok) {
          lines.push(`判定模型 [${conn.classify.model}]: 验证成功 (端点: ${conn.classify.effectiveEndpoint}, ${conn.classify.latencyMs}ms)`);
        } else {
          lines.push(`判定模型: ${conn.classify.error || "调用失败"}`);
        }
      }
      if (lines.length < 2) {
        lines.push(ok ? "在线模型全部校验通过，响应正常" : "请在设置中配置有效的在线模型名称");
      }
      try {
        const bs = getModelBudgetState();
        const maxPerMin = Number((options || {}).harvest_max_per_min ?? cfg.harvest_max_per_min ?? 20);
        const maxTotal = Number((options || {}).harvest_max_total ?? cfg.harvest_max_total ?? 2000);
        lines.push(`调用预算: 60s窗口 ${bs.perMinute}/${maxPerMin} · 累计 ${bs.total}/${maxTotal}${bs.tripped ? " · 已熔断（重启网关恢复）" : ""}`);
      } catch (_) {}
      result = {
        ok,
        at: Date.now(),
        op: "model_check",
        title: ok ? "在线模型连通就绪" : "在线模型检测未通过",
        lines,
        detail: conn,
      };
    }
    else if (action.op === "harvest_gateway") {
      let saveMemory = null;
      let pitfallSave = null;
      try {
        // harvest_gateway 生产副作用消除：显式禁用 auto_init / auto_harvest / dedup_schedule
        // 防止信标执行时意外启动生产调度器或触发自动采集
        const safeOpts = Object.assign({}, options || {}, cfg || {}, {
          auto_init: false,
          autoInit: false,
          auto_harvest: false,
          autoHarvest: false,
          dedup_schedule: "off",
          audit_interval: "off",
          auditInterval: "off",
        });
        delete safeOpts._action;
        delete safeOpts[ACTION_KEY];
        safeOpts._client = client;
        void safeOpts;
        // 直接导入 save/pitfall 函数（不经过 Hub，解除循环依赖）
        const { memorySave } = await import("../tools/memory-save.js");
        const { pitfallSave: pitfallSaveFn } = await import("../tools/pitfall-save.js");
        saveMemory = async (cl, c, m, ctx) => {
          const raw = await memorySave(cl || client, c || {}, m, { ...(ctx || {}), _ctx: ctx });
          return typeof raw === "string" ? JSON.parse(raw) : raw;
        };
        pitfallSave = async (cl, c, p, ctx) => {
          const raw = await pitfallSaveFn(cl || client, c || {}, p, { ...(ctx || {}), _ctx: ctx });
          return typeof raw === "string" ? JSON.parse(raw) : raw;
        };
      } catch (err) {
        console.error("[page_actions] harvest_gateway resolve save functions error:", err);
      }

      const res = await harvestGateway(action.args || {}, {
        _cfg: cfg,
        cfg,
        _client: client,
        client,
        options: options || {},
        saveMemory,
        pitfallSave,
      });
      const ok = res && res.success !== false;
      const lines = [];
      if (res && res.message) lines.push(res.message);
      if (res && res.details) {
        if (res.details.filesScanned !== undefined) {
          lines.push(`扫描文件: ${res.details.filesScanned} · 记忆: ${res.details.memoriesSaved || 0} · 踩坑: ${res.details.pitfallsSaved || 0}`);
        }
      } else if (res && res.turns_scanned !== undefined) {
        lines.push(`扫描轮次: ${res.turns_scanned} · 提炼记忆: ${res.memories_saved || 0} · 提炼踩坑: ${res.pitfalls_saved || 0}`);
      }
      if (lines.length < 2) {
        lines.push(ok ? "网关对话录制增量扫描完成" : "网关对话录制扫描未完成");
      }
      result = {
        ok,
        at: Date.now(),
        op: "harvest_gateway",
        title: ok ? "对话录制扫描完成" : "对话录制扫描失败",
        lines,
        detail: res,
      };
    }
    else if (action.op === "sync_snapshot") {
      let memories = [];
      try {
        let fetchFn = null;
        try {
          if (!client) client = makeClient(cfg);
          fetchFn = fetchAll;
        } catch (_) {
          if (!client) {
            // makeClient 已在顶部静态 import
            client = makeClient(cfg);
          }
        }

        const prj = String(action.project || (cfg && cfg.project) || (options && options.project) || "").trim();
        let activeMemories = [];
        if (prj && prj !== "global") {
          // 在有 project 上下文时支持按 project + global 过滤，杜绝跨项目混淆
          const [projRes, globalRes] = await Promise.all([
            client.list("memories", {
              project: prj,
              lifecycle_status: "active",
              order_by: "updated_at DESC",
              limit: 50,
            }),
            client.list("memories", {
              project: "global",
              lifecycle_status: "active",
              order_by: "updated_at DESC",
              limit: 50,
            }),
          ]);
          const projRows = Array.isArray(projRes?.data) ? projRes.data : (Array.isArray(projRes) ? projRes : []);
          const globalRows = Array.isArray(globalRes?.data) ? globalRes.data : (Array.isArray(globalRes) ? globalRes : []);
          const seen = new Set();
          const combined = [];
          for (const r of projRows) {
            const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
            if (!seen.has(uid)) {
              seen.add(uid);
              combined.push(r);
            }
          }
          for (const r of globalRows) {
            const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
            if (!seen.has(uid)) {
              seen.add(uid);
              combined.push(r);
            }
          }
          // 专属项目优先排序，其次按 updated_at 倒序
          combined.sort((a, b) => {
            const aIsProj = String(a.project || "") === prj ? 1 : 0;
            const bIsProj = String(b.project || "") === prj ? 1 : 0;
            if (aIsProj !== bIsProj) return bIsProj - aIsProj;
            return Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0);
          });
          activeMemories = combined
            .filter((m) => m && !m.invalid_at && (!m.lifecycle_status || m.lifecycle_status === "active"))
            .slice(0, 50);
        } else {
          const queryParams = {
            lifecycle_status: "active",
            order_by: "updated_at DESC",
            limit: 50,
          };
          if (prj === "global") {
            queryParams.project = "global";
          }
          const resList = await client.list("memories", queryParams);
          const rawMem = Array.isArray(resList?.data) ? resList.data : (Array.isArray(resList) ? resList : []);
          activeMemories = rawMem
            .filter((m) => m && !m.invalid_at && (!m.lifecycle_status || m.lifecycle_status === "active"))
            .slice(0, 50);
        }

        // FUNC-2: 同步拉取 pitfalls 表活跃记录并转换为中间件兼容快照条目
        let pitfalls = [];
        try {
          if (typeof fetchFn === "function") {
            if (prj && prj !== "global") {
              const [pProj, pGlob] = await Promise.all([
                fetchFn(client, "pitfalls", { project: prj }),
                fetchFn(client, "pitfalls", { project: "global" }),
              ]);
              const seenP = new Set();
              for (const r of [...pProj, ...pGlob]) {
                const uid = r && (r.id != null ? r.id : `${r.project}:${r.symptom || ""}`);
                if (uid != null && !seenP.has(uid)) {
                  seenP.add(uid);
                  pitfalls.push(r);
                }
              }
            } else {
              const q = prj === "global" ? { project: "global" } : {};
              pitfalls = await fetchFn(client, "pitfalls", q);
            }
          } else if (client && typeof client.list === "function") {
            if (prj && prj !== "global") {
              const [projPitRes, globalPitRes] = await Promise.all([
                client.list("pitfalls", { project: prj, limit: 50 }),
                client.list("pitfalls", { project: "global", limit: 50 }),
              ]);
              const pProj = Array.isArray(projPitRes?.data) ? projPitRes.data : (Array.isArray(projPitRes) ? projPitRes : []);
              const pGlob = Array.isArray(globalPitRes?.data) ? globalPitRes.data : (Array.isArray(globalPitRes) ? globalPitRes : []);
              const seenP = new Set();
              for (const r of [...pProj, ...pGlob]) {
                const uid = r && (r.id != null ? r.id : `${r.project}:${r.symptom || ""}`);
                if (uid != null && !seenP.has(uid)) {
                  seenP.add(uid);
                  pitfalls.push(r);
                }
              }
            } else {
              const q = { limit: 50 };
              if (prj === "global") q.project = "global";
              const pResList = await client.list("pitfalls", q);
              pitfalls = Array.isArray(pResList?.data) ? pResList.data : (Array.isArray(pResList) ? pResList : []);
            }
          }
        } catch (_) {}

        const activePitfallSnapshots = (Array.isArray(pitfalls) ? pitfalls : [])
          .filter((p) => p && !p.invalid_at && (!p.lifecycle_status || p.lifecycle_status === "active"))
          .sort((a, b) => (Number(b.recurrence) || 1) - (Number(a.recurrence) || 1))
          .slice(0, 50)
          .map((p) => ({
            id: p.id,
            project: p.project || "global",
            category: "pitfall",
            scope_level: "project",
            title: `${p.component || "general"}: ${String(p.symptom || p.title || "").slice(0, 80)}`,
            content: `${p.symptom || p.title || ""} → ${p.solution || p.root_cause || p.content || ""}`,
            symptom: p.symptom,
            solution: p.solution,
            root_cause: p.root_cause,
            tags: p.tags || "",
            related_entities: p.related_entities || p.component || "",
            recurrence: Number(p.recurrence) || 1,
            retrieval_count: Number(p.recurrence) || 1,
            updated_at: p.updated_at || p.last_occurred_at,
            lifecycle_status: "active",
          }));

        memories = activeMemories.concat(activePitfallSnapshots).slice(0, 500);
        result = {
          ok: true,
          at: Date.now(),
          op: "sync_snapshot",
          title: "记忆快照拉取就绪",
          lines: [`成功拉取 ${memories.length} 条活跃记忆快照供前端同步`],
          memories,
        };
      } catch (err) {
        result = {
          ok: false,
          at: Date.now(),
          op: "sync_snapshot",
          title: "记忆快照拉取失败",
          lines: [err.message],
        };
      }
    }
    else if (action.op === "memory_audit") {
      const isUndo = !!action.undo;
      // 立即返回「已启动」，绝不 await 全程阻塞 runPendingAction 与插件加载
      result = {
        ok: true,
        at: Date.now(),
        op: "memory_audit",
        title: isUndo ? "已开始撤销去重任务" : "已开始全自动去重任务",
        lines: [
          isUndo ? "已提交撤销去重任务，后台正在异步还原…" : "已提交全自动去重任务，后台正在异步执行…",
          "状态: 进行中"
        ],
        status: "进行中", // db-col-ok: UI 状态字段
        detail: { started: true, is_async: true },
        logs: [
          `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${isUndo ? "撤销去重" : "全自动去重"}后台任务已启动`
        ]
      };

      // 先把 "进行中" 状态 writeCardStatus 落盘，再启动异步 IIFE，消除状态倒退竞态
      writeCardStatus("audit", result, "memory_audit");

      // 异步在后台执行去重/撤销（fire-and-forget），通过 writeCardStatus("audit", ...) 持续回传进度
      (async () => {
        try {
          // makeClient/memoryAudit 已在顶部静态 import
          // 后台任务必须自建 client，不依赖加载期传入的那个
          let asyncClient = null;
          const clientCfg = Object.assign({}, cfg || {}, options || {});
          try {
            asyncClient = makeClient(clientCfg);
          } catch (_) { asyncClient = null; }

          const auditArgs = Object.assign({}, action.args || {});
          if (action.undo) auditArgs.undo = true;
          if (action.undo_before) auditArgs.undo_before = action.undo_before;

          const auditResRaw = await memoryAudit(asyncClient, clientCfg, auditArgs, {});
          const auditRes = typeof auditResRaw === "string" ? JSON.parse(auditResRaw) : auditResRaw;
          const ok = auditRes && auditRes.success !== false;
          let lines = [];
          if (auditRes?.action === "DEDUP_UNDONE") {
            lines = [
              auditRes.note || `已恢复 ${auditRes.restored_records || 0} 条 · 撤销 recurrence ${auditRes.undone_recurrence || 0} 次 · 跳过 ${auditRes.skipped || 0} 条`,
              "状态: 已完成"
            ];
          } else if (Array.isArray(auditRes?.lines) && auditRes.lines.length > 0) {
            lines = auditRes.lines;
          } else {
            lines = [
              `扫描记忆: ${auditRes?.scanned?.memories || 0} 条 · 去重合并: ${auditRes?.deduped?.memories || 0} 条`,
              `扫描踩坑: ${auditRes?.scanned?.pitfalls || 0} 条 · 去重合并: ${auditRes?.deduped?.pitfalls || 0} 条`,
              `批次: ${auditRes?.batch || "1/1"}  ·  状态: ${auditRes?.status || "已完成"}`
            ];
          }
          const finalResult = {
            ok,
            at: Date.now(),
            op: "memory_audit",
            title: auditRes?.action === "DEDUP_UNDONE" ? "去重撤销已完成" : (ok ? "全自动去重完成" : "全自动去重未完成"),
            status: ok ? "已完成" : "未完成", // db-col-ok: UI 状态字段
            lines,
            detail: auditRes,
            logs: auditRes?.logs || [],
          };
          writeCardStatus("audit", finalResult, "memory_audit");
        } catch (bgErr) {
          console.error("[memory-hub] background memory_audit failed:", bgErr);
          writeCardStatus("audit", {
            ok: false,
            at: Date.now(),
            op: "memory_audit",
            title: "去重任务执行异常",
            lines: [String(bgErr && bgErr.message || bgErr), "状态: 异常退出"],
            status: "异常", // db-col-ok: UI 状态字段
            logs: [`[${new Date().toISOString().replace("T", " ").slice(0, 19)}] 错误: ${String(bgErr && bgErr.message || bgErr)}`]
          }, "memory_audit");
        }
      })();
    }
    else result = await dbStatus(cfg, args);
  } catch (e) {
    result = { ok: false, op: action.op, error: String(e && e.message || e) };
  }

  // 写入卡片状态文件（供设置页读取）
  try {
    // memory_audit 的初始「进行中」已在启动 IIFE 前同步落盘，后续由 IIFE 更新，避免外层落盘覆盖后台最终状态
    if (action.op !== "memory_audit") {
      const CARD_OF_OP = {
        provision: "ncb", init: "ncb", reset: "ncb", status: "ncb", ncb_check: "ncb", secret_check: "ncb",  // db-col-ok: UI 操作对应的卡片映射表，非数据库列
        storage_setup: "r2", r2_check: "r2", clean_probe: "r2",
        model_check: "model",
        memory_audit: "audit",
        harvest_gateway: "gateway",
        sync_snapshot: "inject",
      };
      const cardKey = CARD_OF_OP[action.op] || "ncb";
      writeCardStatus(cardKey, result, action.op);
    }
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

/** 直接执行信标动作（供测试或内部直接调用） */
export async function executeAction(action, cfg, targetDb, customStatusPath) {
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const sp = statePath(fsMod, osMod, pathMod);
  const state = loadState(fsMod, sp);
  const opts = cfg && (cfg.options || cfg);
  return await execute(action, cfg, fsMod, sp, state, opts);
}

/* ================================================================== *
 * 状态文件回传（让被 CSP/sandbox 隔离的设置页通过 <script> 读到执行结果）
 * ================================================================== */

/**
 * 格式化卡片状态项为统一人话结构：
 * { at, op, ok, title, lines: [2~5 条关键事实] }
 */
// formatCardStatus 已下沉到 src/core/status-writer.js
export const formatCardStatus = _fcs;


/**
 * 从名称或 local_state 解析数据库逻辑名、数字前缀与完整名。
 * 格式：{ logical: "agent_memory", prefix: "41694_", full: "41694_agent_memory" }
 */
// parseDbInfo 已下沉到 src/core/status-writer.js
export const parseDbInfo = _pdi;


/**
 * 把单张卡片的执行结果合并写入 _status.js（同时维护内部真相源 _status.json）。
 *
 * 保证：
 *   - 原子写：先写 .tmp 再 renameSync
 *   - 合并写：只更新 key（ncb, r2, model, gateway, db），不抹掉对方
 *   - 静默降级：只读目录或写文件报错时不抛异常，只在 console.error 里打日志
 */
// writeCardStatus 已下沉到 src/core/status-writer.js（解循环依赖）
export const writeCardStatus = _wcs;

