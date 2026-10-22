/**
 * 模块职责：pitfall_search MCP 工具入口（踩坑记录多字段加权检索与重排）
 * 依赖：src/tools/args.js, src/integration/ncb.js, src/domain/scoring.js, online_models.js
 * 被依赖：src/index.js
 */

import { normalizeToolArgs } from "./args.js";
import { fetchAll } from "../integration/ncb.js";
import { scorePitfall, jsonOut, termsOf } from "../domain/scoring.js";
import { rewriteSearchQuery, rerankSearchResultsWithModel } from "../integration/provider-models.js";

export async function pitfallSearch(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const rawQuery = String(args.query || "").trim();
  const origTerms = termsOf(rawQuery);
  const projectArg = args.project ? String(args.project).trim() : "";

  const fetchParams = {};
  if (args.client) fetchParams.client = String(args.client).trim();
  if (args.component) fetchParams.component = String(args.component).trim();

  let all = [];
  if (projectArg && projectArg !== "global") {
    // 跨项目全局穿透检索：支持 project IN (args.project, 'global')
    const [projRows, globalRows] = await Promise.all([
      fetchAll(client, "pitfalls", Object.assign({}, fetchParams, { project: projectArg })),
      fetchAll(client, "pitfalls", Object.assign({}, fetchParams, { project: "global" })),
    ]);
    const seen = new Set();
    for (const r of projRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.symptom}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
    for (const r of globalRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.symptom}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
  } else {
    if (projectArg) fetchParams.project = projectArg;
    all = await fetchAll(client, "pitfalls", fetchParams);
  }

  let pool = all.filter((r) => !r.invalid_at);
  if (projectArg) {
    if (projectArg === "global") {
      pool = pool.filter((r) => String(r.project || "") === "global");
    } else {
      pool = pool.filter((r) => String(r.project || "") === projectArg || String(r.project || "") === "global");
    }
  }
  if (args.client) pool = pool.filter((r) => String(r.client || "") === String(args.client));
  if (args.component) pool = pool.filter((r) => String(r.component || "") === args.component);

  // 双路词面扩展打分：在线提炼模型改写自然语言查询（fail-open）
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
      rewrittenInfo = null;
      rewrittenTerms = [];
    }
  }

  const hasOrig = origTerms.length > 0;
  const hasRewrite = rewrittenTerms.length > 0;

  const scored = pool
    .map((r) => {
      if (!hasOrig && !hasRewrite) {
        return { row: r, hit: 1, origHit: 1, rewriteHit: 0 };
      }
      const origHit = hasOrig ? scorePitfall(r, origTerms) : 0;
      const rewriteHit = hasRewrite ? scorePitfall(r, rewrittenTerms) : 0;

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
      return b.hit - a.hit || (Number(b.row.recurrence) || 0) - (Number(a.row.recurrence) || 0);
    });

  // 检索增强：调用模型重排候选踩坑
  let rerankUsed = false;
  let rerankModel = null;
  const shouldRerank = (args.search_rerank !== false) && (cfg.search_rerank !== false);
  if (shouldRerank && args.query && scored.length >= 1) {
    try {
      const candidatePool = scored.slice(0, Math.max(limit * 2, 20));
      const rerankRes = await rerankSearchResultsWithModel({
        query: String(args.query),
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
        scored.length = 0;
        scored.push(...topRanked, ...restRanked);
      }
    } catch (_) {
      rerankUsed = false;
      rerankModel = null;
    }
  }

  // EVO-15: 透出诊断标记（内联根因占位判断，与 isPlaceholderRootCause 语义保持一致，后续可提取公共函数）
  const checkRootCausePlaceholder = (rc, sym) => {
    if (!rc || !String(rc).trim()) return true;
    const s = String(rc).trim();
    if (sym && s.toLowerCase() === String(sym).trim().toLowerCase()) return true;
    if (/未知|待查|临时|unknown|todo|tbd|已处置解决|执行过程中出现/i.test(s)) return true;
    return false;
  };

  const out = scored.slice(0, limit).map((x) => {
    const rec = Number(x.row.recurrence) || 1;
    const isChronic = rec >= 3;
    const rcIsPlaceholder = checkRootCausePlaceholder(x.row.root_cause, x.row.symptom);
    return Object.assign({}, x.row, {
      is_chronic: isChronic,
      root_cause_is_placeholder: rcIsPlaceholder,
      _hit: x.hit,
      _rerank_score: x._rerank_score || null,
      _rerank_reason: x._rerank_reason || null,
    });
  });
  return jsonOut({
    total_pitfalls: all.length,
    matched: scored.length,
    returned: out.length,
    query_rewritten: rewrittenInfo ? rewrittenInfo.rewrittenQuery : null,
    rewrite_used: Boolean(rewrittenInfo && rewrittenInfo.rewrittenQuery),
    rerank_used: rerankUsed,
    rerank_model: rerankModel,
    pitfalls: out,
    _agent_hint:
      "若本次任务产出了新结论、配置变更或排障解法，请在结束前调用 memory_save 或 pitfall_save 沉淀。" +
      (out.some((p) => p.is_chronic && p.root_cause_is_placeholder)
        ? " 命中高频顽疾且缺真实根因，排查后请用 pitfall_save 补 root_cause。"
        : ""),
  });
}

/* 单条或批量读取（CCR 展开用），支持 memories 与 pitfalls 跨表读取 */
