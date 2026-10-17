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

export const STATE_DIRNAME = ".magpie-memory-hub";
export const STATE_FILENAME = "state.json";

/** 状态文件路径；拿不到 HOME 时返回 null（调用方需容错）。 */
export function statePath() {
  try {
    return path.join(os.homedir(), STATE_DIRNAME, STATE_FILENAME);
  } catch (e) {
    return null;
  }
}

/** 读状态。任何异常都退化为空状态，绝不让调用方崩。 */
export function readState() {
  const p = statePath();
  if (!p) return { secrets: {}, actions: {}, gateway_harvest: {}, pending_patterns: {}, _ok: false };
  try {
    if (!fs.existsSync(p)) return { secrets: {}, actions: {}, gateway_harvest: {}, pending_patterns: {}, _ok: true, _missing: true };
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!o || typeof o !== "object") return { secrets: {}, actions: {}, gateway_harvest: {}, pending_patterns: {}, _ok: true };
    return {
      current: typeof o.current === "string" ? o.current : "",
      secrets: o.secrets && typeof o.secrets === "object" ? o.secrets : {},
      actions: o.actions && typeof o.actions === "object" ? o.actions : {},
      gateway_harvest: o.gateway_harvest && typeof o.gateway_harvest === "object" ? o.gateway_harvest : {},
      pending_patterns: o.pending_patterns && typeof o.pending_patterns === "object" ? o.pending_patterns : {},
      _ok: true,
    };
  } catch (e) {
    return { secrets: {}, actions: {}, gateway_harvest: {}, pending_patterns: {}, _ok: false, _err: String(e && e.message || e) };
  }
}

/** 原子写状态（先写临时文件再 rename）。返回是否成功。 */
export function writeState(state) {
  const p = statePath();
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const out = Object.assign({}, state, {
      current: typeof state.current === "string" ? state.current : "",
      secrets: state.secrets && typeof state.secrets === "object" ? state.secrets : {},
      actions: state.actions && typeof state.actions === "object" ? state.actions : {},
      gateway_harvest: state.gateway_harvest && typeof state.gateway_harvest === "object" ? state.gateway_harvest : {},
      pending_patterns: state.pending_patterns && typeof state.pending_patterns === "object" ? state.pending_patterns : {},
    });
    delete out._ok;
    delete out._missing;
    delete out._err;
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch (e) { /* 某些文件系统不支持，忽略 */ }
    return true;
  } catch (e) {
    return false;
  }
}

/** 读回 gateway_harvest 增量状态 */
export function lookupGatewayHarvest() {
  const st = readState();
  return st.gateway_harvest || {};
}

/** 保存 gateway_harvest 增量状态 */
export function rememberGatewayHarvest(harvestState) {
  const st = readState();
  st.gateway_harvest = Object.assign({}, st.gateway_harvest || {}, harvestState || {});
  return writeState(st);
}

/** 记住某个数据库的 Secret Key —— 只在内存里传一次，落盘即刻。 */
export function rememberSecret(database, secret) {
  if (!database || !secret) return false;
  const st = readState();
  st.secrets[database] = { v: String(secret), at: Date.now() };
  return writeState(st);
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

/** 记录设置页信标的执行结果（供 page_actions.js 用）。 */
export function rememberAction(id, info) {
  const st = readState();
  st.actions[id] = Object.assign({ at: Date.now() }, info || {});
  // 只保留最近 30 条
  const keys = Object.keys(st.actions);
  if (keys.length > 30) {
    keys.sort((a, b) => (st.actions[a].at || 0) - (st.actions[b].at || 0));
    for (const k of keys.slice(0, keys.length - 30)) delete st.actions[k];
  }
  return writeState(st);
}

/** 读回某次信标的执行结果。 */
export function lookupAction(id) {
  const st = readState();
  return st.actions[id] || null;
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

  // ③ 唯一真实库兜底
  if (names.length === 1 && /^\d+_/.test(names[0])) return names[0];
  if (st.current && /^\d+_/.test(st.current)) return st.current;

  return want;
}

/* ================================================================== *
 * P0 & P2: Headroom TrafficLearner LRU 门禁暂存队列管理
 * ================================================================== */

export const DEFAULT_MIN_EVIDENCE = 3;
export const DEFAULT_PENDING_TTL_MS = 21 * 24 * 60 * 60 * 1000; // 21 天未复现硬淘汰 (Headroom :1946)
export const DEFAULT_MAX_PENDING = 1000; // 上限 1000 条

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

  // 1. 清理过期项 (21 天未复现硬淘汰) 与损坏脏项
  for (const [k, v] of Object.entries(pending)) {
    if (!v || typeof v !== "object") {
      delete pending[k];
      continue;
    }
    const ts = getEntryTimestamp(v);
    if (ts === null || (now - ts > ttlMs)) {
      delete pending[k];
    }
  }

  // 2. 更新或新建条目
  let entry = pending[fingerprint];
  if (entry) {
    entry.count = (entry.count || 0) + 1;
    entry.last_seen = now;
    if (payload) {
      entry.payload = payload;
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
      payload: payload || {},
    };
    pending[fingerprint] = entry;
  }

  // 3. 门禁阈值判断
  if (entry.count >= minEvidence) {
    // 达到门槛，正式毕业进写入队列，从 pending 移除
    const graduatedEntry = { ...entry };
    delete pending[fingerprint];
    st.pending_patterns = pending;
    writeState(st);
    return {
      shouldGraduate: true,
      entry: graduatedEntry,
      count: entry.count,
    };
  }

  // 未达门槛，仅更新 pending 计数
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

