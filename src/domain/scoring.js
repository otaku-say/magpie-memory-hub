/**
 * 模块职责：相关性打分、新鲜度衰减、综合排序与分词辅助
 * 依赖：../../semantic_dedup.js
 * 被依赖：src/tools/**, src/services/**, tools.js
 */

import { termsOf, CJK_STOP_BIGRAMS } from "../../semantic_dedup.js";
export { termsOf, CJK_STOP_BIGRAMS };

/** 记忆：标题(5) 标签(3) 实体(3) 正文(1) —— EVO-3 修复实体检索失明与独立打分 */
export function scoreMemory(row, terms) {
  if (!terms.length) return 1;
  const title = String(row.title || "").toLowerCase();
  const tags = String(row.tags || "").toLowerCase();
  const entities = (Array.isArray(row.related_entities)
    ? row.related_entities.join(",")
    : String(row.related_entities || "")
  ).toLowerCase();
  const content = String(row.content || "").toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (title.includes(t)) s += 5;
    if (tags.includes(t)) s += 3;
    if (entities.includes(t)) s += 3;
    if (content.includes(t)) s += 1;
  }
  return s;
}

/** 踩坑：把现象/根因/解法/组件全部纳入命中面 */
export function scorePitfall(row, terms) {
  if (!terms.length) return 1;
  const head = [row.component, row.symptom].filter(Boolean).join(" ").toLowerCase();
  const tags = String(row.tags || "").toLowerCase();
  const body = [row.root_cause, row.solution].filter(Boolean).join(" ").toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (head.includes(t)) s += 5;
    if (tags.includes(t)) s += 3;
    if (body.includes(t)) s += 1;
  }
  return s;
}

/** Headroom 式时序新鲜度：越新越靠前（对数衰减，避免压倒命中分） */
export function freshness(row) {
  const t = Date.parse(String(row.last_used_at || row.updated_at || row.created_at || "").replace(" ", "T") + "Z");
  if (!t || isNaN(t)) return 0;
  const days = (Date.now() - t) / 86400000;
  return days <= 0 ? 1 : 1 / (1 + Math.log10(1 + days));
}

export function rankMemory(row) {
  const rawScore = Number(row.confidence_score);
  const conf = (!isNaN(rawScore) ? rawScore : 100) / 100;
  const acc = Math.min(Number(row.retrieval_count) || 0, 10);
  return conf * (1 + 0.1 * acc) * (0.5 + 0.5 * freshness(row));
}

export function cut(s, n) {
  const v = String(s == null ? "" : s);
  return v.length > n ? v.slice(0, n) + "…" : v;
}

export function jsonOut(o) {
  return JSON.stringify(o, null, 2);
}
