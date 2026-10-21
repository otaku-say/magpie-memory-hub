/**
 * 模块职责：记忆有效性校验（未软失效且未过期）与标签交集检查
 * 依赖：../../semantic_dedup.js
 * 被依赖：src/tools/**, src/services/**
 */

import { normalizeSemanticText } from "../../semantic_dedup.js";

/** 检查记忆是否有效（未标记 invalid_at 且未超过 expires_at） */
export function isMemoryValid(row, nowMs = Date.now()) {
  if (!row) return false;
  if (row.invalid_at) return false;
  if (row.expires_at) {
    const str = String(row.expires_at).trim();
    const iso = str.replace(" ", "T") + (str.includes("Z") ? "" : "Z");
    const t = Date.parse(iso);
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
