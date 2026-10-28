/**
 * 模块职责：记忆有效性校验（未软失效且未过期）与标签交集检查
 * 依赖：src/domain/semantic-dedup.js
 * 被依赖：src/tools/**, src/services/**
 */

import { normalizeSemanticText } from "./semantic-dedup.js";

/** 检查记忆是否有效（未标记 invalid_at 且未超过 expires_at） */
export function isMemoryValid(row, nowMs = Date.now()) {
  if (!row) return false;
  if (row.invalid_at) return false;
  if (row.expires_at) {
    const str = String(row.expires_at).trim();
    /* v6.48.0 修复：原先无条件补 "Z"，导致带时区偏移（+08:00）或纯日期（YYYY-MM-DD）
     * 的合法输入一律 Date.parse 成 NaN，isNaN 分支按「未过期」放行——过期记忆永不过期。
     * 现在依次尝试：原样 -> 空格换 T -> 补 Z，三者皆 NaN 才视为无法解析。 */
    let t = Date.parse(str);
    if (isNaN(t)) t = Date.parse(str.replace(" ", "T"));
    if (isNaN(t)) t = Date.parse(str.replace(" ", "T") + "Z");
    if (!isNaN(t) && t <= nowMs) return false;
  }
  return true;
}


/** 检查两个标签集合是否存在交集 */
export function hasTagsIntersection(t1, t2) {
  if (!t1 || !t2) return false;
  const set1 = new Set(String(t1).split(/[,;\s，、|]+/).map(normalizeSemanticText).filter(Boolean));
  if (!set1.size) return false;
  const set2 = new Set(String(t2).split(/[,;\s，、|]+/).map(normalizeSemanticText).filter(Boolean));
  if (!set2.size) return false;
  for (const x of set1) {
    if (set2.has(x)) return true;
  }
  return false;
}
