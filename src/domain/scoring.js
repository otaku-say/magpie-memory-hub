/**
 * 模块职责：相关性打分、新鲜度衰减、综合排序与分词辅助
 * 依赖：src/domain/semantic-dedup.js
 * 被依赖：src/tools/**, src/services/**, tools.js
 */

import { termsOf, CJK_STOP_BIGRAMS } from "./semantic-dedup.js";
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

function _m8Boost(row) {
  const cnt = Math.min(Number(row.retrieval_count) || 0, 50);
  const rec = Math.min(Math.max(0, (Number(row.recurrence) || 1) - 1), 20);
  const af = row.last_used_at ? freshness({ updated_at: row.last_used_at }) : freshness(row);
  return (Math.log1p(cnt) * (0.4 + 0.6 * af)) + (0.15 * rec);
}

export function rankMemory(row) {
  const raw = Number(row.confidence_score);
  const conf = (!isNaN(raw) ? raw : 100) / 100;
  const b = _m8Boost(row);
  return conf * (1 + 0.25 * b) * (0.5 + 0.5 * freshness(row));
}

/** 检索可解释性明细（explain:true 时透出）：词面分、实体加权、新鲜度衰减、综合排序分 */
export function explainScoreDetails(row, terms) {
  const list = Array.isArray(terms) ? terms : [];
  const entities = (Array.isArray(row.related_entities)
    ? row.related_entities.join(",")
    : String(row.related_entities || "")
  ).toLowerCase();
  const f = freshness(row);
  const rank = rankMemory(row);
  return {
    lexical_score: scoreMemory(row, list),
    entity_weight: list.filter((t) => entities.includes(t)).length * 3,
    confidence: Number(row.confidence_score) || 100,
    retrieval_count: Number(row.retrieval_count) || 0,
    recurrence: Number(row.recurrence) || 1,
    freshness_factor: Number(f.toFixed(4)),
    rank_score: Number(rank.toFixed(4)),
  };
}

/** 踩坑检索可解释性明细：现象/根因/解法词面分 + 复发权重 + 新鲜度衰减（rank_score 为诊断值，不参与排序） */
export function explainPitfallScoreDetails(row, terms) {
  const list = Array.isArray(terms) ? terms : [];
  const f = freshness(row);
  const rank = (1 + 0.25 * _m8Boost(row)) * (0.5 + 0.5 * f);
  return {
    lexical_score: scorePitfall(row, list),
    recurrence_weight: Number((0.15 * Math.min(Math.max(0, (Number(row.recurrence) || 1) - 1), 20)).toFixed(4)),
    freshness_factor: Number(f.toFixed(4)),
    rank_score: Number(rank.toFixed(4)),
  };
}

/**
 * 检索可解释性阶段计时器（explain:true 时启用）
 * enabled=false 时 mark 为空操作、report 不输出任何字段，保证旧格式零侵入
 */
export function createExplainTimer(enabled) {
  const on = enabled === true;
  const t0 = Date.now();
  let last = t0;
  const ms = { total_ms: 0, rewrite_ms: 0, fetch_ms: 0, score_ms: 0, rerank_ms: 0 };
  return {
    mark(phase) {
      if (!on) return;
      const now = Date.now();
      const key = `${phase}_ms`;
      if (Object.prototype.hasOwnProperty.call(ms, key)) ms[key] = Math.max(0, now - last);
      ms.total_ms = Math.max(0, now - t0);
      last = now;
    },
    report() {
      return Object.assign({}, ms);
    },
  };
}

export function cut(s, n) {
  const v = String(s == null ? "" : s);
  return v.length > n ? v.slice(0, n) + "…" : v;
}

export function jsonOut(o) {
  return JSON.stringify(o, null, 2);
}
