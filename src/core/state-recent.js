/**
 * 模块职责：进程内近期写入指纹单例状态管理（防写后读延迟造成的重复写入）
 * 依赖：无
 * 被依赖：src/services/save/memory-saver.js, src/tools/pitfall-save.js
 */

const RECENT_WINDOW_MS = 6000;
const RECENT_CAP = 5000;

/**
 * 进程内近期写入指纹 → 写入时刻。
 * NoCodeBackend 的读接口有约 2 秒的写后可见延迟，光靠「先读后写」去重
 * 会让这 2 秒内的重复写入变成两条。宿主进程是长驻的，用一个【有时间窗】的
 * 表兜住这个窗口；窗口之外一律回落到数据库判重，保证计数能正常累加。
 */
export let recentWrite = new Map();

export function markRecent(fp) {
  if (recentWrite.size >= RECENT_CAP) recentWrite.clear();
  recentWrite.set(fp, Date.now());
}

/** 是否在写后读延迟窗口内刚写过 */
export function justWritten(fp) {
  const t = recentWrite.get(fp);
  if (!t) return false;
  if (Date.now() - t > RECENT_WINDOW_MS) {
    recentWrite.delete(fp);
    return false;
  }
  return true;
}
