/**
 * 模块职责：定时去重时间窗口计算与触发判定
 * 依赖：无
 * 被依赖：src/services/audit/scheduler.js, src/services/audit/auditor.js, tools.js
 */

/** 计算定时去重范围 (daily: -24h, weekly: -7d, monthly: -30d) */
export function getDedupTimeWindow(schedule, now = new Date()) {
  if (!schedule || typeof schedule !== "string") return null;
  const sched = schedule.toLowerCase().trim();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (sched === "daily") {
    return new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  }
  if (sched === "weekly") {
    return new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  }
  if (sched === "monthly") {
    return new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  }
  return null;
}

/** 判定当前是否满足定时去重触发条件 (超期 / 设定时段到达) */
export function isDedupDue(opts) {
  if (!opts || typeof opts !== "object" || typeof opts.schedule !== "string") return false;
  const { schedule, time, weekday, day, lastDedupAt, now = new Date() } = opts;
  const sched = schedule.toLowerCase().trim();
  if (!sched || sched === "off" || sched === "none") return false;

  const curDate = now instanceof Date ? now : new Date(now);
  const nowTs = curDate.getTime();
  const lastTs = lastDedupAt ? new Date(lastDedupAt).getTime() : 0;

  let targetH = 2, targetM = 0;
  if (time && typeof time === "string") {
    const m = time.trim().match(/^(\d{1,2}):(\d{1,2})$/);
    if (m) {
      targetH = Math.min(23, Math.max(0, parseInt(m[1], 10)));
      targetM = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    }
  }

  const todayTarget = new Date(curDate.getFullYear(), curDate.getMonth(), curDate.getDate(), targetH, targetM, 0).getTime();

  if (sched === "daily") {
    const over24h = (nowTs - lastTs) >= 24 * 60 * 60 * 1000;
    const reachedToday = (nowTs >= todayTarget) && (lastTs < todayTarget);
    return over24h || reachedToday;
  }

  if (sched === "weekly") {
    const targetWeekday = Math.min(7, Math.max(1, parseInt(weekday, 10) || 1));
    const curWeekday = curDate.getDay() === 0 ? 7 : curDate.getDay();
    const over7d = (nowTs - lastTs) >= 7 * 24 * 60 * 60 * 1000;
    const isTargetDay = curWeekday === targetWeekday;
    const reachedTarget = isTargetDay && (nowTs >= todayTarget) && (lastTs < todayTarget);
    return over7d || reachedTarget;
  }

  if (sched === "monthly") {
    const targetDay = Math.min(28, Math.max(1, parseInt(day, 10) || 1));
    const curDay = curDate.getDate();
    const over30d = (nowTs - lastTs) >= 30 * 24 * 60 * 60 * 1000;
    const isTargetDay = curDay === targetDay;
    const reachedTarget = isTargetDay && (nowTs >= todayTarget) && (lastTs < todayTarget);
    return over30d || reachedTarget;
  }

  return false;
}
