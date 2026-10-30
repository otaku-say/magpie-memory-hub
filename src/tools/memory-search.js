/**
 * 模块职责：memory_search MCP 工具入口（语义检索、关键词评分、置顶原则、LLM 重排与召回统计）
 * 依赖：src/core/**, src/domain/**, src/integration/**, src/services/**, online_models.js
 * 被依赖：src/index.js
 * 配置契约：explain 明细 = 入参 args.explain === true 或 设置页 cfg.explain_debug === true（取或）。
 */

import { normalizeToolArgs } from "./args.js";
import { fetchAll } from "../integration/ncb.js";
import { scoreMemory, rankMemory, explainScoreDetails, createExplainTimer, jsonOut, termsOf } from "../domain/scoring.js";
import { isMemoryValid } from "../domain/validity.js";
import { trackMemoryRetrievals } from "../services/audit/scheduler.js";
import { rewriteSearchQuery, rerankSearchResultsWithModel } from "../integration/provider-models.js";

/** 单条命中的可解释性明细（仅 explain:true 时装配，默认路径零字段） */
function _hitScoreDetails(x, terms, finalRank) {
  return Object.assign(explainScoreDetails(x.row, terms), {
    rewrite_score: x.rewriteHit,
    fusion_score: x.hit,
    final_rank: finalRank,
    rerank_score: x._rerank_score || null,
    rerank_reason: x._rerank_reason || null,
  });
}

export async function memorySearch(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const explain = args.explain === true || cfg.explain_debug === true, tm = createExplainTimer(explain);
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const rawQuery = String(args.query || "").trim();
  const origTerms = termsOf(rawQuery);

  const fetchParams = {
    lifecycle_status: "active",
    columns: [
      "id",
      "project",
      "category",
      "scope_level",
      "client",
      "origin",
      "title",
      "content",
      "tags",
      "related_entities",
      "confidence_score",
      "recurrence",
      "retrieval_count",
      "last_used_at",
      "updated_at",
      "lifecycle_status",
      "invalid_at",
      "expires_at",
    ],
  };
  const projectArg = args.project ? String(args.project).trim() : "";
  if (args.category) fetchParams.category = String(args.category).trim();
  if (args.scope_level) fetchParams.scope_level = String(args.scope_level).trim();
  if (args.client) fetchParams.client = String(args.client).trim();
  if (args.origin) fetchParams.origin = String(args.origin).trim();

  let all = [];
  if (projectArg && projectArg !== "global") {
    // 跨项目全局穿透检索：支持 project IN (args.project, 'global')
    const [projRows, globalRows] = await Promise.all([
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: projectArg })),
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: "global" })),
    ]);
    const seen = new Set();
    for (const r of projRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
    for (const r of globalRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
  } else {
    if (projectArg) fetchParams.project = projectArg;
    all = await fetchAll(client, "memories", fetchParams);
  }

  let pool = all;
  if (projectArg) {
    if (projectArg === "global") {
      pool = pool.filter((r) => String(r.project || "") === "global");
    } else {
      pool = pool.filter((r) => String(r.project || "") === projectArg || String(r.project || "") === "global");
    }
  }
  if (args.category) pool = pool.filter((r) => String(r.category || "") === args.category);
  const targetScope = args.scope_level;
  if (targetScope) pool = pool.filter((r) => String(r.scope_level || "") === targetScope);
  if (args.client) pool = pool.filter((r) => String(r.client || "") === String(args.client));
  if (args.origin) pool = pool.filter((r) => String(r.origin || "") === String(args.origin));
  // 历史版本默认不返回（Headroom：查询默认排除 superseded）
  if (args.include_history !== true) pool = pool.filter((r) => r.lifecycle_status !== "superseded");
  pool = pool.filter((r) => isMemoryValid(r));
  tm.mark("fetch");

  // 优先级 2：在线提炼模型改写自然语言查询（在配置了模型且开启改写时）
  let rewrittenInfo = null;
  let rewrittenTerms = [];
  if (rawQuery) {
    try {
      rewrittenInfo = await rewriteSearchQuery({
        query: rawQuery,
        options: cfg,
      });
      if (rewrittenInfo && rewrittenInfo.rewrittenQuery) {
        rewrittenTerms = termsOf(rewrittenInfo.rewrittenQuery);
      }
    } catch (_) {
      // 严格 fail-open：模型异常或超时，降级为原查询纯词面检索
      rewrittenInfo = null;
      rewrittenTerms = [];
    }
  }

  const hasOrig = origTerms.length > 0;
  const hasRewrite = rewrittenTerms.length > 0;
  tm.mark("rewrite");

  const scored = pool
    .map((r) => {
      if (!hasOrig && !hasRewrite) {
        return { row: r, hit: 1, origHit: 1, rewriteHit: 0 };
      }
      const origHit = hasOrig ? scoreMemory(r, origTerms) : 0;
      const rewriteHit = hasRewrite ? scoreMemory(r, rewrittenTerms) : 0;

      // 双路融合打分：
      // 1. 同时命中两路：叠加奖励分（原词 + 改写词同时命中，相关度最高）；
      // 2. 仅命中原词（如直接搜索专业术语）：原样召回，绝不丢弃；
      // 3. 仅命中改写词（自然语言问句）：由改写词成功召回原本无法命中的记忆！
      let combinedHit = 0;
      if (hasOrig && hasRewrite) {
        combinedHit = origHit + rewriteHit;
      } else if (hasOrig) {
        combinedHit = origHit;
      } else if (hasRewrite) {
        combinedHit = rewriteHit;
      }

      return { row: r, hit: combinedHit, origHit, rewriteHit };
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => {
      if (projectArg && projectArg !== "global") {
        const aProj = String(a.row.project || "") === projectArg ? 1 : 0;
        const bProj = String(b.row.project || "") === projectArg ? 1 : 0;
        if (aProj !== bProj) return bProj - aProj;
      }
      return b.hit - a.hit || rankMemory(b.row) - rankMemory(a.row);
    });
  tm.mark("score");

  // 检索增强：模型语义重排与精准挑选（在配置了模型且开启 rerank 时）
  let rerankUsed = false;
  let rerankModel = null;
  const shouldRerank = (args.search_rerank !== false) && (cfg.search_rerank !== false);
  if (shouldRerank && rawQuery && scored.length >= 1) {
    try {
      // 扩大粗筛召回窗口（取 top 15~25 条候选），让重排模型从中挑选最相关的结果
      const candidatePool = scored.slice(0, Math.max(limit * 2, 20));
      const rerankRes = await rerankSearchResultsWithModel({
        query: rawQuery,
        candidates: candidatePool.map((x) => x.row),
        options: cfg,
        maxTop: limit,
      });

      if (rerankRes && Array.isArray(rerankRes.ranked) && rerankRes.ranked.length > 0) {
        rerankUsed = true;
        rerankModel = rerankRes.modelUsed;
        const scoreMap = new Map();
        for (const item of rerankRes.ranked) {
          scoreMap.set(item.id, item);
        }

        // 重排胜出项置顶，其余候选按原粗排次序后置
        const topRanked = [];
        const restRanked = [];
        for (const x of scored) {
          if (scoreMap.has(x.row.id)) {
            const rInfo = scoreMap.get(x.row.id);
            topRanked.push(Object.assign({}, x, {
              _rerank_score: rInfo.score,
              _rerank_reason: rInfo.reason,
            }));
          } else {
            restRanked.push(x);
          }
        }
        topRanked.sort((a, b) => b._rerank_score - a._rerank_score);
        // 红线保证：结果集永不比纯词面更少，无缝拼接
        scored.length = 0;
        scored.push(...topRanked, ...restRanked);
      }
    } catch (_) {
      // fail-open：模型异常或超时，原样保留纯词面排序
      rerankUsed = false;
      rerankModel = null;
    }
  }
  tm.mark("rerank");

  const out = scored.slice(0, limit).map((x, i) => Object.assign({
    id: x.row.id,
    project: x.row.project,
    category: x.row.category,
    scope_level: x.row.scope_level,
    client: x.row.client || "unknown",
    origin: x.row.origin || "tool",
    title: x.row.title,
    content: x.row.content,
    tags: x.row.tags,
    related_entities: x.row.related_entities || null,
    /* v7.0.3：带上作用域，才能解释“为何这条在某些客户端不出现” */
    env_scope: x.row.env_scope || null,
    confidence: x.row.confidence_score,
    recurrence: Number(x.row.recurrence) || 1,
    retrieval_count: Number(x.row.retrieval_count) || 0,
    last_used_at: x.row.last_used_at || null,
    updated_at: x.row.updated_at,
    _hit: x.hit,
    _rerank_score: x._rerank_score || null,
    _rerank_reason: x._rerank_reason || null,
  }, explain ? { score_details: _hitScoreDetails(x, origTerms, i + 1) } : {}));

  trackMemoryRetrievals(client, scored.slice(0, limit).map((x) => x.row));

  return jsonOut(Object.assign({
    total_active: all.length,
    matched: scored.length,
    returned: out.length,
    query_rewritten: rewrittenInfo ? rewrittenInfo.rewrittenQuery : null,
    rewrite_used: Boolean(rewrittenInfo && rewrittenInfo.rewrittenQuery),
    rerank_used: rerankUsed,
    rerank_model: rerankModel,
    memories: out,
    _agent_hint: "若本次任务产出了新结论、配置变更或排障解法，请在结束前调用 memory_save 或 pitfall_save 沉淀。",
  }, explain ? { timings: tm.report() } : {}));
}
