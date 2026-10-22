/**
 * 模块职责：进程内近期写入指纹单例状态管理（防写后读延迟造成的重复写入）
 * 依赖：无
 * 被依赖：src/services/save/memory-saver.js, src/tools/pitfall-save.js, src/services/harvest/harvest-pipeline.js
 */

const RECENT_WINDOW_MS = 6000;
const RECENT_CAP = 5000;

/**
 * 进程内近期写入指纹 → 写入时刻。
 * NoCodeBackend 的读接口有约 2 秒的写后可见延迟，光靠「先读后写」去重
 * 会让这 2 秒内的重复写入变成两条。宿主进程是长驻的，用一个【有时间窗】的
 * 表兜住这个窗口；窗口之外一律回落到数据库判重，保证计数能正常累加。
 *
 * markRecent / justWritten 直接接受【完整 key】（如 "m:{project}:{fp}"、
 * "p:{fp}:{solFp}"），不再自行拼接前缀，使工具显式写入与后台异步提炼
 * 共享同一内存表，实现跨路径的互通防重。
 */
let recentWrite = new Map();

function normalizeKey(key) {
  if (key == null) return "";
  if (typeof key === "string") return key;
  if (typeof key === "object") {
    return String(key.key ?? key.fp ?? key.fingerprint ?? key.fullKey ?? key.id ?? "");
  }
  return String(key);
}

export function markRecent(key) {
  const k = normalizeKey(key);
  if (!k) return;
  if (recentWrite.size >= RECENT_CAP) { const o = recentWrite.keys().next().value; if (o) recentWrite.delete(o); }
  recentWrite.set(k, Date.now());
}

/** 是否在写后读延迟窗口内刚写过 */
export function justWritten(key) {
  const k = normalizeKey(key);
  if (!k) return false;
  const t = recentWrite.get(k);
  if (!t) return false;
  if (Date.now() - t > RECENT_WINDOW_MS) { recentWrite.delete(k); return false; }
  return true;
}

export { RECENT_WINDOW_MS, RECENT_CAP };
export function _resetRecentWrite() { recentWrite = new Map(); }
