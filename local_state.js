/**
 * local_state.js —— 插件在宿主本地的持久状态。
 *
 * 为什么需要它：
 *   宿主（Bun）**没有写 options 的 API**（已实测：input.magpie.option/options 是
 *   provider 鉴权用的布尔开关，与插件配置无关；第二个参数 options 只读）。
 *   但宿主有文件系统，而官方镜像里 HOME=/config/home 位于唯一的持久卷 /config 内，
 *   所以写在这里的内容**容器重建也不丢**。
 *
 * 目前存两类东西：
 *   1. secrets[数据库名] —— 由 create_database 自动生成、**只在创建时返回一次**的
 *      Secret Key。捕获后存在这里，用户就不必再手动填。
 *   2. actions —— 设置页信标的执行记录（由 page_actions.js 使用）。
 *
 * 安全：文件权限 0600；只写不含其它敏感信息；绝不打印到日志。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSemanticallySimilar } from "./semantic_dedup.js";

export const STATE_DIRNAME = ".magpie-memory-hub";
export const STATE_FILENAME = "state.json";
const STATUS_JSON_PATH = fileURLToPath(new URL("./_status.json", import.meta.url));

/** 状态文件路径；拿不到 HOME 时返回 null（调用方需容错）。 */
export function statePath() {
  try {
    const envDir = (process.env.MEMHUB_STATE_DIR || "").trim();
    if (envDir) {
      if (envDir.endsWith(STATE_FILENAME)) return envDir;
      return path.join(envDir, STATE_FILENAME);
    }
    const isTestMode =
      process.env.MAGPIE_TEST === "1" ||
      process.env.NODE_ENV === "test" ||
      process.env.MEMHUB_TEST === "1" ||
      (Array.isArray(process.argv) && process.argv.some((arg) => {
          if (typeof arg !== "string" || !arg.endsWith(".mjs")) return false;
          try {
            const resolved = path.resolve(arg);
            return path.basename(path.dirname(resolved)) === "tests";
          } catch (_) {
            return false;
          }
        }));
    if (isTestMode) {
      const testDir = path.join(os.tmpdir(), `memhub-test-state-${process.pid}`);
      try {
        fs.mkdirSync(testDir, { recursive: true });
      } catch (_) {}
      return path.join(testDir, STATE_FILENAME);
    }
    return path.join(os.homedir(), STATE_DIRNAME, STATE_FILENAME);
  } catch (e) {
    return null;
  }
}

// 进程内缓存与紧凑序列化
let _cachedState = null;
let _cachedMtime = 0;
let _cachedSize = 0;
let _cachedIno = 0;
let _cachedPath = null;

/** 测试或隔离环境清理内存缓存 */
export function _resetStateCacheForTests() {
  _cachedState = null;
  _cachedMtime = 0;
  _cachedSize = 0;
  _cachedIno = 0;
  _cachedPath = null;
}

/** 读状态。带进程内 mtime 缓存，损坏自愈与防抹平保护。 */
/**
 * 抽公共函数：状态文件损坏时执行自愈与容灾。
 * 1. 同步将损坏内容写入 .corrupt.<ts> 备份（防 FUSE 延迟）
 * 2. 尝试从 .bak 恢复
 * 3. 严禁回写空 {}，失败时保持 _ok: false
 */
export function _recoverCorruptStateFile(p, raw, err) {
  const corruptPath = `${p}.corrupt.${Date.now()}`;
  try {
    let contentToWrite = typeof raw === "string" ? raw : "";
    if (!contentToWrite && fs.existsSync(p)) {
      try { contentToWrite = fs.readFileSync(p, "utf8"); } catch (_) {}
    }
    fs.writeFileSync(corruptPath, contentToWrite, "utf8");
    try { fs.unlinkSync(p); } catch (_) {
      try { fs.renameSync(p, corruptPath); } catch (_) {}
    }
  } catch (_) {
    try { fs.renameSync(p, corruptPath); } catch (_) {}
  }

  const bakPath = `${p}.bak`;
  if (fs.existsSync(bakPath)) {
    try {
      const bakRaw = fs.readFileSync(bakPath, "utf8");
      const bakObj = JSON.parse(bakRaw);
      if (bakObj && typeof bakObj === "object") {
        const recovered = {
          current: typeof bakObj.current === "string" ? bakObj.current : "",
          secrets: bakObj.secrets && typeof bakObj.secrets === "object" ? bakObj.secrets : {},
          actions: bakObj.actions && typeof bakObj.actions === "object" ? bakObj.actions : {},
          audit: bakObj.audit && typeof bakObj.audit === "object" ? bakObj.audit : {},
          gateway_harvest: bakObj.gateway_harvest && typeof bakObj.gateway_harvest === "object" ? bakObj.gateway_harvest : {},
          pending_patterns: bakObj.pending_patterns && typeof bakObj.pending_patterns === "object" ? bakObj.pending_patterns : {},
          r2_mounts: bakObj.r2_mounts && typeof bakObj.r2_mounts === "object" ? bakObj.r2_mounts : {},
          harvest_queue: Array.isArray(bakObj.harvest_queue) ? bakObj.harvest_queue : [],
          _ok: true,
          _recovered_from_bak: true,
        };
        try {
          fs.copyFileSync(bakPath, p);
          const restat = fs.statSync(p);
          _cachedState = recovered;
          _cachedMtime = restat.mtimeMs;
          _cachedSize = restat.size;
          _cachedIno = restat.ino;
          _cachedPath = p;
        } catch (_) {}
        return JSON.parse(JSON.stringify(recovered));
      }
    } catch (_) {}
  }

  _cachedState = null;
  _cachedMtime = 0;
  _cachedPath = null;
  return {
    secrets: {},
    actions: {},
    gateway_harvest: {},
    pending_patterns: {},
    r2_mounts: {},
    harvest_queue: [],
    _ok: false,
    _corrupt: true,
    _err: String((err && err.message) || err || "invalid state object"),
  };
}

export function readState() {
  const p = statePath();
  if (!p) return { secrets: {}, actions: {}, gateway_harvest: {}, pending_patterns: {}, r2_mounts: {}, harvest_queue: [], _ok: false };
  try {
    if (!fs.existsSync(p)) {
      _cachedState = null;
      _cachedMtime = 0;
      _cachedPath = null;
      return { secrets: {}, actions: {}, gateway_harvest: {}, pending_patterns: {}, r2_mounts: {}, harvest_queue: [], _ok: true, _missing: true };
    }
    const stat = fs.statSync(p);
    if (_cachedState && _cachedPath === p && stat.mtimeMs === _cachedMtime && stat.size === _cachedSize && stat.ino === _cachedIno) {
      return JSON.parse(JSON.stringify(_cachedState));
    }

    let raw = "";
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch (readErr) {
      throw readErr;
    }

    let o;
    try {
      o = JSON.parse(raw);
    } catch (jsonErr) {
      return _recoverCorruptStateFile(p, raw, jsonErr);
    }

    if (!o || typeof o !== "object") {
      return _recoverCorruptStateFile(p, raw, new Error("state is not an object"));
    }

    const parsed = {
      current: typeof o.current === "string" ? o.current : "",
      secrets: o.secrets && typeof o.secrets === "object" ? o.secrets : {},
      actions: o.actions && typeof o.actions === "object" ? o.actions : {},
      audit: o.audit && typeof o.audit === "object" ? o.audit : {},
      gateway_harvest: o.gateway_harvest && typeof o.gateway_harvest === "object" ? o.gateway_harvest : {},
      pending_patterns: o.pending_patterns && typeof o.pending_patterns === "object" ? o.pending_patterns : {},
      r2_mounts: o.r2_mounts && typeof o.r2_mounts === "object" ? o.r2_mounts : {},
      harvest_queue: Array.isArray(o.harvest_queue) ? o.harvest_queue : [],
      _ok: true,
    };
    _cachedState = parsed;
    _cachedMtime = stat.mtimeMs;
    _cachedSize = stat.size;
    _cachedIno = stat.ino;
    _cachedPath = p;
    return JSON.parse(JSON.stringify(parsed));
  } catch (e) {
    return { secrets: {}, actions: {}, gateway_harvest: {}, pending_patterns: {}, r2_mounts: {}, harvest_queue: [], _ok: false, _err: String(e && e.message || e) };
  }
}

/** 原子写状态（紧凑无缩进序列化；保留 .bak 备份；先写临时文件再 rename；防抹平保护）。返回是否成功。 */
export function writeState(state) {
  const p = statePath();
  if (!p) return false;
  // 防抹平保护：严禁写入损坏状态或异常抹平状态
  if (!state || state._ok === false || state._corrupt === true) {
    return false;
  }
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const out = Object.assign({}, state, {
      current: typeof state.current === "string" ? state.current : "",
      lastDoneId: typeof state.lastDoneId === "string" ? state.lastDoneId : (state.actions?.lastDoneId || ""),
      secrets: state.secrets && typeof state.secrets === "object" ? state.secrets : {},
      actions: state.actions && typeof state.actions === "object" ? state.actions : {},
      audit: state.audit && typeof state.audit === "object" ? state.audit : {},
      gateway_harvest: state.gateway_harvest && typeof state.gateway_harvest === "object" ? state.gateway_harvest : {},
      pending_patterns: state.pending_patterns && typeof state.pending_patterns === "object" ? state.pending_patterns : {},
      r2_mounts: state.r2_mounts && typeof state.r2_mounts === "object" ? state.r2_mounts : {},
      harvest_queue: Array.isArray(state.harvest_queue) ? state.harvest_queue : [],
    });
    delete out._ok;
    delete out._missing;
    delete out._err;
    delete out._corrupt;
    delete out._recovered_from_bak;

    // 自动 Compact 保护：若 pending_patterns 存在已达标项（count>=2）或超量，自动清洗
    if (out.pending_patterns && typeof out.pending_patterns === "object") {
      const keys = Object.keys(out.pending_patterns);
      if (keys.length > 500) {
        const sorted = keys.map((k) => ({ k, v: out.pending_patterns[k] }))
          .sort((a, b) => (getEntryTimestamp(b.v) || 0) - (getEntryTimestamp(a.v) || 0));
        const kept = {};
        for (const item of sorted.slice(0, 500)) {
          kept[item.k] = item.v;
        }
        out.pending_patterns = kept;
      }
    }

    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    tmp = `${p}.tmp.${nonce}`;
    // 紧凑序列化：绝不使用 null, 2，直接写入紧凑 JSON
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    // 写入前保留备份 state.json.bak
    const bak = `${p}.bak`;
    try {
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, bak);
      }
    } catch (_) {}
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch (e) { /* 某些文件系统不支持，忽略 */ }
    try {
      const st = fs.statSync(p);
      _cachedState = JSON.parse(JSON.stringify(out));
      _cachedMtime = st.mtimeMs;
      _cachedSize = st.size;
      _cachedIno = st.ino;
      _cachedPath = p;
    } catch (_) {}
    return true;
  } catch (e) {
    try {
      if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
    return false;
  }
}

/** 读回 gateway_harvest 增量状态 */
export function lookupGatewayHarvest() {
  const st = readState();
  return st.gateway_harvest || {};
}

/** 保存 gateway_harvest 增量状态（file_states 最多保留最近 500 个；processed_fingerprints 上限 1000） */
export function rememberGatewayHarvest(harvestState) {
  const st = readState();
  const gh = Object.assign({}, st.gateway_harvest || {}, harvestState || {});

  // 1. file_states (files) 淘汰上限：按 processed_at 排序，最多保留最近 500 个
  if (gh.files && typeof gh.files === "object") {
    const fileEntries = Object.entries(gh.files);
    if (fileEntries.length > 500) {
      fileEntries.sort((a, b) => {
        const ta = (a[1] && (a[1].processed_at || a[1].mtime || 0)) || 0;
        const tb = (b[1] && (b[1].processed_at || b[1].mtime || 0)) || 0;
        return tb - ta; // 降序，最新的在前面
      });
      gh.files = Object.fromEntries(fileEntries.slice(0, 500));
    }
  }

  // 2. processed_fps (processed_fingerprints) 上限 5000 -> 1000
  if (Array.isArray(gh.processed_fingerprints)) {
    if (gh.processed_fingerprints.length > 1000) {
      gh.processed_fingerprints = gh.processed_fingerprints.slice(-1000);
    }
  }

  st.gateway_harvest = gh;
  return writeState(st);
}

/** 读回信标动作状态（单一状态源 state.json 维护） */
export function lookupActionState() {
  const st = readState();
  const act = (st.actions && typeof st.actions === "object") ? st.actions : {};
  return {
    ok: st._ok !== false,
    lastDoneId: String(act.lastDoneId || ""),
    pendingId: String(act.pendingId || ""),
    history: Array.isArray(act.history) ? act.history : [],
    missing: !!st._missing,
  };
}

/** 保存信标动作状态（单一状态源 state.json 维护） */
export function rememberActionState(actionState) {
  const st = readState();
  const hist = (actionState && Array.isArray(actionState.history) ? actionState.history : []).slice(-50);
  const doneId = String(actionState?.lastDoneId || "");
  st.lastDoneId = doneId;
  st.actions = {
    lastDoneId: doneId,
    pendingId: String(actionState?.pendingId || ""),
    history: hist,
  };
  return writeState(st);
}

/** 记住某个数据库的 Secret Key —— 只在内存里传一次，落盘即刻。 */
export function rememberSecret(database, secret) {
  if (!database || !secret) return false;
  const st = readState();
  st.secrets[database] = { v: String(secret), at: Date.now() };
  return writeState(st);
}

/** 读回全自动去重调度与状态 (last_dedup_at, last_dedup_batch_ts, last_dedup_ids, etc.) */
export function lookupAuditState() {
  const st = readState();
  return st.audit || {};
}
export const lookupDedupState = lookupAuditState;

/** 记录全自动去重状态 */
export function rememberAuditState(auditState) {
  const st = readState();
  st.audit = Object.assign({}, st.audit || {}, auditState || {});
  writeState(st);
  return st.audit;
}
export const rememberDedupState = rememberAuditState;

/** 读回指定项目的记忆体检增量游标（断点续跑与避免上万条全量扫描） */
export function getAuditCursor(project) {
  const prj = String(project || "global").trim();
  const st = readState();
  const cursors = (st.audit && st.audit.cursors) || {};
  return cursors[prj] || { last_memory_id: null, last_pitfall_id: null, last_id: null, last_updated_at: "", reviewed_count: 0 };
}

/** 保存指定项目的记忆体检增量游标 */
export function saveAuditCursor(project, cursorData) {
  const prj = String(project || "global").trim();
  const st = readState();
  if (!st.audit) st.audit = {};
  if (!st.audit.cursors) st.audit.cursors = {};
  st.audit.cursors[prj] = Object.assign({}, st.audit.cursors[prj] || {}, cursorData, { at: Date.now() });
  writeState(st);
  return st.audit.cursors[prj];
}

/** 清理/重置指定项目的记忆体检游标（供全量体检使用） */
export function clearAuditCursor(project) {
  const prj = String(project || "global").trim();
  const st = readState();
  if (st.audit && st.audit.cursors && st.audit.cursors[prj]) {
    delete st.audit.cursors[prj];
    writeState(st);
  }
}

/**
 * 取回某个数据库的 Secret Key；没有则返回 ""。
 *
 * 【为什么不能只做精确匹配】
 * 捕获时用的是 NCB 返回的【真实库名】（例如 41694_agent_memory），
 * 而调用方传进来的往往是用户在设置页填的【逻辑库名】（例如 agent_memory）。
 * 两者不一致时精确匹配会落空 → 表现为「明明一键创建过，却报未配置 Secret Key」，
 * 于是 R2 的列举/删除全部不可用，探针文件也就永远清不掉（真实踩过）。
 *
 * 因此按三级策略查找：
 *   ① 精确匹配
 *   ② 归一化匹配：去掉账号数字前缀后再比（41694_agent_memory ↔ agent_memory）
 *   ③ 唯一记录兜底：本地只存了一条时直接用它（本插件通常只服务一个库）
 */
export function lookupSecret(database) {
  const st = readState();
  const secrets = st.secrets && typeof st.secrets === "object" ? st.secrets : {};
  const names = Object.keys(secrets);
  if (!names.length) return "";
  const valueOf = (k) => {
    const e = secrets[k];
    return typeof e === "string" ? e : (e && e.v) || "";
  };

  // ① 精确匹配
  const want = String(database || "").trim();
  if (want && secrets[want]) {
    const v = valueOf(want);
    if (v) return v;
  }

  // ② 归一化匹配（忽略账号前缀与大小写）
  const norm = (x) => String(x || "").toLowerCase().replace(/^\d+_/, "");
  if (want) {
    const target = norm(want);
    const hit = names.find((k) => norm(k) === target);
    if (hit) {
      const v = valueOf(hit);
      if (v) return v;
    }
  }

  // ③ 唯一记录兜底
  if (names.length === 1) {
    const v = valueOf(names[0]);
    if (v) return v;
  }
  return "";
}

/**
 * 忘记某个数据库的 Secret Key（403 鉴权失败或显式重置时调用）。
 * 对称匹配 lookupSecret 的逻辑：精确匹配 -> 归一化匹配 -> 唯一记录兜底清除。
 */
export function forgetSecret(database) {
  const st = readState();
  const secrets = st.secrets && typeof st.secrets === "object" ? st.secrets : {};
  const names = Object.keys(secrets);
  if (!names.length) return false;

  const want = String(database || "").trim();
  const norm = (x) => String(x || "").toLowerCase().replace(/^\d+_/, "");
  const target = want ? norm(want) : "";

  let removed = 0;
  for (const k of names) {
    if (!want) {
      delete secrets[k];
      removed++;
    } else if (k === want || norm(k) === target) {
      delete secrets[k];
      removed++;
    }
  }

  // 若未精准/归一化匹配但本地仅存 1 条记录（对应 lookupSecret 的 ③ 唯一记录兜底命中），也将其清除
  if (removed === 0 && names.length === 1) {
    delete secrets[names[0]];
    removed++;
  }

  if (removed > 0) {
    st.secrets = secrets;
    writeState(st);
    return true;
  }
  return false;
}

/** 记住本次真正使用的数据库实例名（NCB 可能自动加账号前缀或后缀）。 */
export function rememberDatabase(name) {
  if (!name) return false;
  const st = readState();
  st.current = String(name);
  return writeState(st);
}

/** 取回上次真正使用的数据库实例名。 */
export function lookupDatabase() {
  const st = readState();
  return st.current || "";
}

/** 已记录 Secret Key 的数据库名清单（不含任何密钥值）。 */
export function knownDatabases() {
  const st = readState();
  return Object.keys(st.secrets);
}

/**
 * 从逻辑库名解析出真正的远端数据库实例名（带账号前缀，如 41694_agent_memory）。
 * NCB 的 REST 接口必须使用带账号前缀的真实库名；若传逻辑名会直接返回 403 (Invalid secret_key)。
 */
export function lookupRealDatabase(database) {
  const want = String(database || "").trim();
  if (!want) return "";
  if (/^\d+_/.test(want)) return want;

  const st = readState();
  const secrets = st.secrets && typeof st.secrets === "object" ? st.secrets : {};
  const names = Object.keys(secrets);

  const norm = (x) => String(x || "").toLowerCase().replace(/^\d+_/, "");
  const target = norm(want);

  // ① 从已记录 Secret 的真实库名中反查
  const hit = names.find((k) => norm(k) === target);
  if (hit) return hit;

  // ② 从 st.current 比对
  if (st.current && norm(st.current) === target) return st.current;

  // 绝不盲目跨库篡改：如果明确指定了库名且不匹配，原样返回 want
  return want;
}

/* ------------------------------------------------------------------ *
 * R2 存储挂载状态持久化（解决未挂载时检测 R2 误报凭据错误的问题）
 * ------------------------------------------------------------------ */

/**
 * 记录某个数据库的 R2 存储挂载成功状态。
 * 只有在真实探针上传探测成功（probe.ok === true）后才调用，绝不记录未经验证的死状态。
 */
export function rememberR2Mount(database, mountInfo) {
  if (!database) return false;
  const st = readState();
  if (!st.r2_mounts || typeof st.r2_mounts !== "object") st.r2_mounts = {};
  const info = mountInfo || {};
  st.r2_mounts[database] = {
    mounted: true,
    bucket: String(info.bucket || ""),
    public_url: String(info.public_url || ""),
    account_id_tail: String(info.account_id_tail || ""),
    at: typeof info.at === "number" ? info.at : Date.now(),
  };
  return writeState(st);
}

/**
 * 查询某个数据库的 R2 挂载状态。
 * 同样采用三级策略：①精确匹配 ②归一化匹配（忽略账号前缀与大小写） ③唯一记录兜底
 */
export function lookupR2Mount(database) {
  const st = readState();
  const mounts = st.r2_mounts && typeof st.r2_mounts === "object" ? st.r2_mounts : {};
  const names = Object.keys(mounts);
  if (!names.length) return null;

  const want = String(database || "").trim();
  // ① 精确匹配
  if (want && mounts[want]) return mounts[want];

  // ② 归一化匹配（忽略账号数字前缀与大小写）
  const norm = (x) => String(x || "").toLowerCase().replace(/^\d+_/, "");
  const target = want ? norm(want) : "";
  if (target) {
    const hit = names.find((k) => norm(k) === target);
    if (hit) return mounts[hit];
  }

  // ③ 唯一记录兜底（仅在未指定目标库时兜底；明确指定且不匹配时决不能兜底返回其他库）
  if (!want && names.length === 1) {
    return mounts[names[0]];
  }
  return null;
}

/**
 * 清除某个数据库的 R2 挂载状态（清库或显式解绑时调用）。
 */
export function forgetR2Mount(database) {
  if (!database) return false;
  const st = readState();
  let changed = false;
  if (st.r2_mounts && typeof st.r2_mounts === "object") {
    const norm = (x) => String(x || "").toLowerCase().replace(/^\d+_/, "");
    const target = norm(database);
    for (const k of Object.keys(st.r2_mounts)) {
      if (k === database || norm(k) === target) {
        delete st.r2_mounts[k];
        changed = true;
      }
    }
    if (changed) writeState(st);
  }
  // 同时同步清除 _status.json 与 _status.js 中的 r2 挂载卡片状态，杜绝已解绑的数据库被 _status.json/js 僵尸复活
  try {
    const p = STATUS_JSON_PATH;
    const jsPath = p.replace(/\.json$/, ".js");
    let o = null;
    if (fs.existsSync(p)) {
      try { o = JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) {}
    }
    if ((!o || !o.r2) && fs.existsSync(jsPath)) {
      try {
        const text = fs.readFileSync(jsPath, "utf8");
        const m = text.match(/window\.__memhubStatus\s*=\s*(\{[\s\S]*\});?\s*$/);
        if (m) o = Object.assign({}, JSON.parse(m[1]), o || {});
      } catch (_) {}
    }
    if (o && typeof o === "object" && o.r2) {
      delete o.r2;
      try { fs.writeFileSync(p, JSON.stringify(o, null, 2), "utf8"); } catch (_) {}
      try { fs.writeFileSync(jsPath, `window.__memhubStatus = ${JSON.stringify(o, null, 2)};\n`, "utf8"); } catch (_) {}
    }
  } catch (_) {}
  return true;
}

/* ================================================================== *
 * P0 & P2: Headroom TrafficLearner LRU 门禁暂存队列管理
 * ================================================================== */

export const DEFAULT_MIN_EVIDENCE = 2; // 默认 2 次复现放行
export const DEFAULT_PENDING_TTL_MS = 21 * 24 * 60 * 60 * 1000; // 21 天未复现硬淘汰 (Headroom :1946)
export const DEFAULT_MAX_PENDING = 500; // 上限收敛至 500 条

/** 安全截断暂存 Payload（未达门槛前绝不在 sample 里存超长原文） */
export function truncatePendingPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const p = { ...payload };
  for (const k of ["content", "symptom", "root_cause", "solution", "sample", "full_text", "reasoning", "context"]) {
    if (typeof p[k] === "string" && p[k].length > 200) {
      p[k] = p[k].slice(0, 200) + "...";
    }
  }
  if (typeof p.title === "string" && p.title.length > 100) {
    p.title = p.title.slice(0, 100) + "...";
  }
  delete p.raw;
  delete p.dialogue;
  delete p.history;
  return p;
}

/** 安全提取条目时间戳（区分缺失与合法值） */
export function getEntryTimestamp(entry) {
  if (!entry || typeof entry !== "object") return null;
  const ts = entry.last_seen != null ? entry.last_seen : entry.first_seen;
  const num = Number(ts);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * 记录一次证据观察。
 * - 若 count + 1 >= minEvidence：从 pending 移除，返回 { shouldGraduate: true, entry, count }
 * - 否则更新 pending 并返回 { shouldGraduate: false, count, needed: minEvidence }
 */
export function recordPendingEvidence(fingerprint, payload, options = {}) {
  if (!fingerprint) return { shouldGraduate: false, count: 0, needed: 0 };

  const minEvidence = typeof options.minEvidence === "number" ? options.minEvidence : DEFAULT_MIN_EVIDENCE;
  const ttlMs = typeof options.ttlMs === "number" ? options.ttlMs : DEFAULT_PENDING_TTL_MS;
  const maxPending = typeof options.maxPending === "number" ? options.maxPending : DEFAULT_MAX_PENDING;
  const now = typeof options.now === "number" ? options.now : Date.now();
  const kind = options.kind || "pitfall";
  const truncatedPayload = truncatePendingPayload(payload);

  // minEvidence <= 1 时直接放行毕业
  if (minEvidence <= 1) {
    return {
      shouldGraduate: true,
      entry: {
        fingerprint,
        kind,
        count: 1,
        first_seen: now,
        last_seen: now,
        payload: payload || {},
      },
      count: 1,
    };
  }

  const st = readState();
  const pending = st.pending_patterns && typeof st.pending_patterns === "object" ? st.pending_patterns : {};

  // 1. 清理过期项 (21 天未复现硬淘汰)、损坏脏项、已达标历史残留并截断超长样本
  for (const [k, v] of Object.entries(pending)) {
    if (!v || typeof v !== "object") {
      delete pending[k];
      continue;
    }
    if (typeof v.count === "number" && v.count >= minEvidence) {
      delete pending[k]; // 彻底清除已达标历史僵尸残留
      continue;
    }
    const ts = getEntryTimestamp(v);
    if (ts === null || (now - ts > ttlMs)) {
      delete pending[k];
      continue;
    }
    if (v.payload && typeof v.payload === "object") {
      v.payload = truncatePendingPayload(v.payload);
    }
  }

  const turnKey = options.turnKey ? String(options.turnKey).trim() : "";

  // 2. 更新或新建条目
  let entry = pending[fingerprint];
  let targetKey = fingerprint;

  // P0-3: 同 project + kind === "pitfall" 时做语义模糊去重
  const isPitfall = kind === "pitfall" || options.kind === "pitfall" || (payload && payload.kind === "pitfall") || (typeof fingerprint === "string" && fingerprint.startsWith("p:"));
  if (!entry && isPitfall && payload) {
    const fpParts = typeof fingerprint === "string" ? fingerprint.split(":") : [];
    const fpProj = fpParts.length >= 3 && fpParts[0] === "p" ? fpParts[1] : "";
    const curProject = String(options.project || payload.project || fpProj || "").trim();
    const curComp = String(payload.component || "").trim().toLowerCase();
    const curSym = String(payload.symptom || payload.title || "").trim();
    const curSol = String(payload.solution || payload.root_cause || "").trim();

    if (curSym) {
      for (const [k, cand] of Object.entries(pending)) {
        if (!cand || typeof cand !== "object") continue;
        const candKind = cand.kind || (k.startsWith("p:") ? "pitfall" : "");
        if (candKind !== "pitfall") continue;
        const candPayload = cand.payload || {};
        const candFpParts = typeof k === "string" ? k.split(":") : [];
        const candFpProj = candFpParts.length >= 3 && candFpParts[0] === "p" ? candFpParts[1] : "";
        const candProject = String(candPayload.project || candFpProj || "").trim();
        if (curProject && candProject && curProject !== candProject) continue;
        const candComp = String(candPayload.component || "").trim().toLowerCase();
        const candSym = String(candPayload.symptom || candPayload.title || "").trim();
        const candSol = String(candPayload.solution || candPayload.root_cause || "").trim();
        if (candSym && isSemanticallySimilar(`${curComp ? curComp + ' ' : ''}${curSym}`, curSol, `${candComp ? candComp + ' ' : ''}${candSym}`, candSol)) {
          entry = cand;
          targetKey = k;
          break;
        }
      }
    }
  }

  // P2-3: 同 project + kind === "memory" 时做语义模糊去重
  const isMemory = kind === "memory" || options.kind === "memory" || (payload && payload.kind === "memory") || (typeof fingerprint === "string" && fingerprint.startsWith("m:"));
  if (!entry && isMemory && payload) {
    const fpParts = typeof fingerprint === "string" ? fingerprint.split(":") : [];
    const fpProj = fpParts.length >= 3 && fpParts[0] === "m" ? fpParts[1] : "";
    const curProject = String(options.project || payload.project || fpProj || "").trim();
    const curTitle = String(payload.title || payload.desc || "").trim();
    const curContent = String(payload.content || payload.detail || payload.solution || "").trim();

    if (curTitle || curContent) {
      for (const [k, cand] of Object.entries(pending)) {
        if (!cand || typeof cand !== "object") continue;
        const candKind = cand.kind || (k.startsWith("m:") ? "memory" : "");
        if (candKind !== "memory") continue;
        const candPayload = cand.payload || {};
        const candFpParts = typeof k === "string" ? k.split(":") : [];
        const candFpProj = candFpParts.length >= 3 && candFpParts[0] === "m" ? candFpParts[1] : "";
        const candProject = String(candPayload.project || candFpProj || "").trim();
        if (curProject && candProject && curProject !== candProject) continue;
        const candTitle = String(candPayload.title || candPayload.desc || "").trim();
        const candContent = String(candPayload.content || candPayload.detail || candPayload.solution || "").trim();
        if ((candTitle || candContent) && isSemanticallySimilar(curTitle, curContent, candTitle, candContent)) {
          entry = cand;
          targetKey = k;
          break;
        }
      }
    }
  }

  if (entry) {
    // 同轮去重：如果传入了 turnKey 且本轮次已经记录过该指纹，则本轮不重复 +1
    if (turnKey && entry.last_turn === turnKey) {
      entry.last_seen = now;
      if (payload) entry.payload = truncatedPayload;
      if (entry.count >= minEvidence) {
        delete pending[targetKey];
        st.pending_patterns = pending;
        writeState(st);
        return {
          shouldGraduate: true,
          entry: { ...entry, payload: payload || entry.payload || {} },
          count: entry.count,
          needed: minEvidence,
        };
      }
      st.pending_patterns = pending;
      writeState(st);
      return {
        shouldGraduate: false,
        entry: { ...entry },
        count: entry.count,
        needed: minEvidence,
      };
    }
    entry.count = (entry.count || 0) + 1;
    entry.last_seen = now;
    if (turnKey) entry.last_turn = turnKey;
    if (payload) {
      entry.payload = truncatedPayload;
    }
  } else {
    // 容量上限检查：若超过上限，LRU 淘汰 last_seen 最早的一条
    while (Object.keys(pending).length >= maxPending) {
      const keys = Object.keys(pending);
      let oldestKey = keys[0];
      let oldestTime = getEntryTimestamp(pending[oldestKey]) || 0;
      for (const k of keys) {
        const t = getEntryTimestamp(pending[k]) || 0;
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = k;
        }
      }
      delete pending[oldestKey];
    }

    entry = {
      fingerprint,
      kind,
      count: 1,
      first_seen: now,
      last_seen: now,
      last_turn: turnKey || undefined,
      payload: truncatedPayload,
    };
    pending[fingerprint] = entry;
    targetKey = fingerprint;
  }

  // 3. 门禁阈值判断
  if (entry.count >= minEvidence) {
    // 达到门槛，正式毕业进写入队列，从 pending 彻底移除
    const graduatedEntry = { ...entry, payload: payload || entry.payload || {} };
    delete pending[targetKey];
    st.pending_patterns = pending;
    writeState(st);
    return {
      shouldGraduate: true,
      entry: graduatedEntry,
      count: entry.count,
    };
  }

  // 未达门槛，仅更新 pending 计数（保存截断样本）
  st.pending_patterns = pending;
  writeState(st);
  return {
    shouldGraduate: false,
    entry: { ...entry },
    count: entry.count,
    needed: minEvidence,
  };
}

export function getPendingEvidence(fingerprint) {
  const st = readState();
  return (st.pending_patterns && st.pending_patterns[fingerprint]) || null;
}

export function clearPendingEvidence(fingerprint) {
  const st = readState();
  if (st.pending_patterns && st.pending_patterns[fingerprint]) {
    delete st.pending_patterns[fingerprint];
    return writeState(st);
  }
  return false;
}

export function listPendingEvidence() {
  const st = readState();
  return Object.values(st.pending_patterns || {});
}

export function cleanExpiredPending(ttlMs = DEFAULT_PENDING_TTL_MS, now = Date.now()) {
  const st = readState();
  const pending = st.pending_patterns && typeof st.pending_patterns === "object" ? st.pending_patterns : {};
  let removed = 0;
  for (const [k, v] of Object.entries(pending)) {
    if (!v || typeof v !== "object") {
      delete pending[k];
      removed++;
      continue;
    }
    const ts = getEntryTimestamp(v);
    if (ts === null || (now - ts > ttlMs)) {
      delete pending[k];
      removed++;
    }
  }
  if (removed > 0) {
    st.pending_patterns = pending;
    writeState(st);
  }
  return removed;
}

/* ================================================================== *
 * 5. 待写入记忆/踩坑落库队列（持久化缓冲，解耦网关钩子执行超时）
 * ================================================================== */

export function enqueueHarvestItems(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const st = readState();
  const queue = Array.isArray(st.harvest_queue) ? st.harvest_queue : [];
  let added = 0;
  for (const item of items) {
    if (!item || !item.table || !item.data) continue;
    const fp = item.fp || "";
    if (fp && queue.some((q) => q.fp === fp && q.table === item.table)) continue;
    queue.push({
      id: item.id || `hq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      table: item.table,
      data: item.data,
      project: item.project || "global",
      fp: fp,
      enqueued_at: Date.now(),
      retries: typeof item.retries === "number" ? item.retries : 0,
    });
    added++;
  }
  if (added > 0) {
    // 队列容量软上限 200 项，防止异常无限堆积
    if (queue.length > 200) {
      queue.splice(0, queue.length - 200);
    }
    st.harvest_queue = queue;
    writeState(st);
  }
  return added;
}

export function readHarvestQueue() {
  const st = readState();
  return Array.isArray(st.harvest_queue) ? st.harvest_queue : [];
}

export function removeHarvestItems(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const idSet = new Set(ids);
  const st = readState();
  const queue = Array.isArray(st.harvest_queue) ? st.harvest_queue : [];
  const initialLen = queue.length;
  const nextQueue = queue.filter((q) => !idSet.has(q.id));
  const removed = initialLen - nextQueue.length;
  if (removed > 0) {
    st.harvest_queue = nextQueue;
    writeState(st);
  }
  return removed;
}

export function updateHarvestItemRetries(id, errMessage) {
  if (!id) return false;
  const st = readState();
  const queue = Array.isArray(st.harvest_queue) ? st.harvest_queue : [];
  let updated = false;
  for (const item of queue) {
    if (item.id === id) {
      item.retries = (Number(item.retries) || 0) + 1;
      if (errMessage) item.last_error = String(errMessage).slice(0, 200);
      updated = true;
      break;
    }
  }
  if (updated) {
    st.harvest_queue = queue;
    writeState(st);
  }
  return updated;
}

export function clearHarvestQueue() {
  const st = readState();
  st.harvest_queue = [];
  return writeState(st);
}


