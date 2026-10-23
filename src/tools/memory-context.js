/**
 * 模块职责：memory_context MCP 工具入口（上下文装配、记忆与踩坑双路召回、预算控制与格式化注入）
 * 依赖：src/core/**, src/domain/**, src/integration/**, src/services/**, online_models.js
 * 被依赖：src/index.js
 */

import { normalizeToolArgs } from "./args.js";
import { fetchAll, rowsOf } from "../integration/ncb.js";
import { nowSql } from "../core/config.js";
import { scoreMemory, scorePitfall, freshness, rankMemory, cut, jsonOut, termsOf } from "../domain/scoring.js";
import { isMemoryValid } from "../domain/validity.js";
import { trackMemoryRetrievals } from "../services/audit/scheduler.js";
import { rewriteSearchQuery } from "../integration/provider-models.js";

export async function memoryContext(client, cfg, rawArgs, ctx) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const maxItems = Number(args.max_items) || cfg.maxInject || 5;
  const budget = Number(args.max_chars) || cfg.maxBudget || 2048;
  const rawQuery = String(args.query || "").trim();
  const origTerms = termsOf(rawQuery);
  const projectArg = args.project ? String(args.project).trim() : "";

  const fetchParams = {
    lifecycle_status: "active",
    columns: [
      "id", "project", "category", "scope_level",
      "client", "origin", "title", "content",
      "tags", "related_entities", "confidence_score", "recurrence",
      "retrieval_count", "last_used_at", "updated_at",
      "lifecycle_status", "invalid_at", "expires_at",
    ],
  };

  // 1. 获取 memories（支持跨项目全局穿透：project + global）
  let pool = [];
  if (projectArg && projectArg !== "global") {
    const [projRows, globalRows] = await Promise.all([
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: projectArg })),
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: "global" })),
    ]);
    // 项目行优先合并 global 穿透行，按 id 去重后再统一做有效性与归属过滤
    pool = _mergeRowsDedup(projRows, globalRows).filter((r) => {
      if (r.lifecycle_status === "superseded" || !isMemoryValid(r)) return false;
      const pj = String(r.project || "");
      return pj === projectArg || pj === "global";
    });
  } else {
    if (projectArg) fetchParams.project = projectArg;
    const all = await fetchAll(client, "memories", fetchParams);
    pool = all.filter((r) => r.lifecycle_status !== "superseded" && isMemoryValid(r));
    if (projectArg) pool = pool.filter((r) => String(r.project || "") === projectArg);
  }

  // 【BUG-460-1b】handoff:open / mail:unread 属于控制行，已由末尾 _detectAndClaimHandoff 置顶单次输出；
  // 这里必须从常规候选集剔除，否则同一控制行会以普通记忆身份在正文被二次打印（重复注入 + 白占预算）。
  pool = pool.filter((r) => !HANDOFF_OPEN_TAG.test(String(r.tags || "")) && !MAIL_UNREAD_TAG.test(String(r.tags || "")));

  // 2. 自动合并当前 project 与 global 下的 principle 准则，当前项目优先，全局兜底，杜绝全局准则丢失
  const maxPrinciples = Number(args.max_principles ?? cfg.max_principles ?? 3) || 3;
  const allPrinciples = pool.filter((r) => String(r.category || "").toLowerCase() === "principle");
  const principleOrder = (a, b) => {
    if (projectArg && projectArg !== "global") {
      const aProj = String(a.project || "") === projectArg ? 1 : 0;
      const bProj = String(b.project || "") === projectArg ? 1 : 0;
      if (aProj !== bProj) return bProj - aProj;
    }
    return rankMemory(b) - rankMemory(a);
  };
  let principles = allPrinciples.slice().sort(principleOrder).slice(0, maxPrinciples);
  // 【保底席位】rankMemory = conf*(1+0.1*retrieval_count)*(0.5+0.5*freshness)，
  // 新写入的 principle 的 retrieval_count 恒为 0，得分天然只有老原则的 2/3，
  // 永远挤不进 Top N → 永远不被注入 → 永远积累不到 retrieval_count（死锁）。
  // 规则：若「最近更新的一条 principle」不在已选列表中，就用它替换末位，保证新规范至少被看见一次。
  if (maxPrinciples >= 2 && principles.length > 0) {
    const tsOf = (r) => {
      const raw = String(r.updated_at || r.created_at || "").replace(" ", "T");
      const t = Date.parse(raw);
      return isNaN(t) ? 0 : t;
    };
    const newest = allPrinciples.slice().sort((a, b) => {
      const tb = tsOf(b);
      const ta = tsOf(a);
      if (tb !== ta) return tb - ta;
      return Number(b.id || 0) - Number(a.id || 0);
    })[0];
    if (newest && !principles.some((p) => String(p.id) === String(newest.id))) {
      principles = principles.slice(0, maxPrinciples - 1).concat([newest]);
    }
  }

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

  const principleIds = new Set(principles.map((p) => p.id));
  // 【BUG-460-1d】新仓库冷启动：当前项目专属记忆为 0 时，global 收敛画像在词面上必然 0 命中，
  // 会被 hit>0 的过滤直接丢弃 → 给保底召回分并整层优先，保证用户个人习惯零配置生效。
  const coldStart = Boolean(rawQuery) && Boolean(projectArg) && projectArg !== "global"
    && !pool.some((r) => String(r.project || "") === projectArg);
  const scored = pool
    .filter((r) => !principleIds.has(r.id))
    .map((r) => {
      if (!hasOrig && !hasRewrite) {
        return { row: r, hit: 1, origHit: 1, rewriteHit: 0 };
      }
      const origHit = hasOrig ? scoreMemory(r, origTerms) : 0;
      const rewriteHit = hasRewrite ? scoreMemory(r, rewrittenTerms) : 0;

      let combinedHit = 0;
      if (hasOrig && hasRewrite) {
        combinedHit = origHit + rewriteHit;
      } else if (hasOrig) {
        combinedHit = origHit;
      } else if (hasRewrite) {
        combinedHit = rewriteHit;
      }

      // 冷启动保底：词面 0 命中的收敛画像补到「1 个词命中标题」的分值，避免被 hit>0 门槛筛掉
      const floor = coldStart && _isConvergedProfile(r) ? COLD_START_PROFILE_FLOOR : 0;
      return { row: r, hit: Math.max(combinedHit, floor), origHit, rewriteHit };
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
  // 保底分只保证入场；排序让收敛画像整层优先，避免被高词面分的老 global 记忆挤出 max_items 预算
  if (coldStart) scored.sort((a, b) => (_isConvergedProfile(b.row) ? 1 : 0) - (_isConvergedProfile(a.row) ? 1 : 0));

  // 3. 同时拉取 pitfalls 表，支持跨项目穿透，匹配 Top 3 踩坑经验
  let pitfallPool = [];
  try {
    const pitfallColumns = [
      "id", "project", "component", "client", "symptom", "root_cause", "solution",
      "recurrence", "last_occurred_at", "updated_at", "invalid_at"
    ];
    let rawPitfalls = [];
    if (projectArg && projectArg !== "global") {
      const [projPits, globalPits] = await Promise.all([
        fetchAll(client, "pitfalls", { project: projectArg, columns: pitfallColumns }),
        fetchAll(client, "pitfalls", { project: "global", columns: pitfallColumns }),
      ]);
      const seenPits = new Set();
      for (const r of projPits) {
        const pid = r.id != null ? r.id : `${r.project}:${r.symptom}`;
        if (!seenPits.has(pid)) {
          seenPits.add(pid);
          rawPitfalls.push(r);
        }
      }
      for (const r of globalPits) {
        const pid = r.id != null ? r.id : `${r.project}:${r.symptom}`;
        if (!seenPits.has(pid)) {
          seenPits.add(pid);
          rawPitfalls.push(r);
        }
      }
    } else {
      const pitParams = { columns: pitfallColumns };
      if (projectArg) pitParams.project = projectArg;
      rawPitfalls = await fetchAll(client, "pitfalls", pitParams);
    }
    pitfallPool = rawPitfalls.filter((r) => r && !r.invalid_at && (r.symptom || r.component));
    if (projectArg) {
      if (projectArg === "global") {
        pitfallPool = pitfallPool.filter((r) => String(r.project || "") === "global");
      } else {
        pitfallPool = pitfallPool.filter(
          (r) => String(r.project || "") === projectArg || String(r.project || "") === "global"
        );
      }
    }
  } catch (_) {
    pitfallPool = [];
  }

  const scoredPitfalls = pitfallPool
    .map((r) => {
      if (!hasOrig && !hasRewrite) {
        return { row: r, hit: 1 };
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
      return { row: r, hit: combinedHit };
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
  const topPitfalls = scoredPitfalls.slice(0, 3).map((x) => x.row);

  // 4. 组装 [Persistent Memory Context] 块
  let block = "[Persistent Memory Context]\n";
  let n = 0;
  const matchedMemories = [];

  // 说明：曾用 process.argv 检测测试文件名来切换输出格式（省略 #id），
  // 这会让「测试通过」依赖文件名而生产行为不一致，已移除。格式在测试与生产完全统一。

  const quota = _calcQuota(rawQuery, scored.length, maxItems, topPitfalls.length > 0);
  let prCount = 0;
  for (const pr of principles) {
    if (n >= maxItems || prCount >= quota.maxPr) break;
    const idTag = pr.id != null ? `#${pr.id}` : "";
    const prEntStr = Array.isArray(pr.related_entities)
      ? pr.related_entities.join(",")
      : String(pr.related_entities || "").trim();
    const prEntPart = prEntStr ? ` | 实体: ${cut(prEntStr, 120)}` : "";
    const line = `- [principle${idTag}] ${cut(pr.title, 120)}${prEntPart}: ${cut(pr.content, 400)}\n`;
    if (block.length + line.length > budget) break;
    block += line;
    matchedMemories.push(pr);
    n++;
    prCount++;
  }

  const pitfallThreshold = Number(args.pitfall_recurrence_threshold ?? cfg?.pitfall_recurrence_threshold ?? 3) || 3;

  let pitCount = 0;
  for (const pit of topPitfalls) {
    if (n >= maxItems || (quota.hasHits && (n >= maxItems - quota.reserved && pitCount >= quota.maxPit))) break;
    const comp = pit.component || "general";
    const idTag = pit.id != null ? `#${pit.id}` : "";
    const rec = Number(pit.recurrence) || 1;
    const isFrequent = rec >= pitfallThreshold;
    const prefix = isFrequent ? ("[高频复发×" + rec + "] ") : "";
    const suffix = isFrequent ? " 建议核查根因是否已根治" : "";
    const line = "- " + prefix + "[pitfall/" + cut(comp, 40) + idTag + "] " + cut(pit.symptom, 160) + " → " + cut(pit.solution, 240) + suffix + "\n";
    if (block.length + line.length > budget) break;
    block += line;
    n++;
    pitCount++;
  }

  for (const x of scored) {
    if (n >= maxItems) break;
    const idTag = x.row.id != null ? `#${x.row.id}` : "";
    const cat = x.row.category || "fact";
    const isPitfall = String(cat).toLowerCase().indexOf("pitfall") === 0;
    const rec = Number(x.row.recurrence) || 1;
    const isFrequent = isPitfall && rec >= pitfallThreshold;
    const prefix = isFrequent ? ("[高频复发×" + rec + "] ") : "";
    const suffix = isFrequent ? " 建议核查根因是否已根治" : "";
    // EVO-3：实体独立展示，便于 Agent 判断记录归属领域
    const entStr = Array.isArray(x.row.related_entities)
      ? x.row.related_entities.join(",")
      : String(x.row.related_entities || "").trim();
    const entPart = entStr ? ` | 实体: ${cut(entStr, 120)}` : "";
    const line = "- " + prefix + "[" + cat + idTag + "] " + cut(x.row.title, 120) + entPart + ": " + cut(x.row.content, 400) + suffix + "\n";
    if (block.length + line.length > budget) break;
    block += line;
    matchedMemories.push(x.row);
    n++;
  }

  if (n > 0) {
    block += "（摘要已截断，可用 memory_get(id=…) 看全文）\n";
  }

  // P1-7: 异步非阻塞递增 retrieval_count 并更新 last_used_at
  trackMemoryRetrievals(client, matchedMemories);

  // EVO-14: evolution_opportunities 演进契机自省计算
  // 内联根因与解法占位检测（保持与 isPlaceholderRootCause / isMeaningfulIronlaw 语义一致）
  const checkRootCausePlaceholder = (rc, sym) => {
    if (!rc || !String(rc).trim()) return true;
    const s = String(rc).trim();
    if (sym && s.toLowerCase() === String(sym).trim().toLowerCase()) return true;
    if (/未知|待查|临时|unknown|todo|tbd|已处置解决|执行过程中出现/i.test(s)) return true;
    return false;
  };

  const checkSolutionPlaceholder = (sol) => {
    if (!sol || !String(sol).trim()) return true;
    const s = String(sol).trim();
    if (/未知|待查|临时|unknown|todo|tbd/i.test(s)) return true;
    return false;
  };

  const crystallizationThreshold = Number(args.crystallization_threshold ?? cfg?.crystallization_threshold ?? 5) || 5;
  const nearIronlaw = [];
  const chronicWithoutRootCause = [];

  for (const pit of topPitfalls) {
    const rec = Number(pit.recurrence) || 1;
    const rcIsPlaceholder = checkRootCausePlaceholder(pit.root_cause, pit.symptom);
    const solIsPlaceholder = checkSolutionPlaceholder(pit.solution);

    // 1) near_ironlaw: recurrence >= (crystallization_threshold - 1) 且 recurrence < crystallization_threshold 且 root_cause/solution 真实非占位
    if (rec >= (crystallizationThreshold - 1) && rec < crystallizationThreshold && !rcIsPlaceholder && !solIsPlaceholder) {
      const missingCount = Math.max(1, crystallizationThreshold - rec);
      nearIronlaw.push({
        id: pit.id,
        component: pit.component || "general",
        symptom: String(pit.symptom || "").slice(0, 60),
        recurrence: rec,
        missing: missingCount,
      });
    }

    // 2) chronic_without_root_cause: recurrence >= 3 且 root_cause 为空或占位
    if (rec >= 3 && rcIsPlaceholder) {
      chronicWithoutRootCause.push({
        id: pit.id,
        component: pit.component || "general",
        symptom: String(pit.symptom || "").slice(0, 60),
        recurrence: rec,
      });
    }
  }

  // EVO-18: 记忆表侧 near_crystallization 演进契机
  const nearCrystallization = [];
  for (const m of matchedMemories) {
    const cat = String(m.category || "").toLowerCase();
    if (cat === "preference" || cat === "decision") {
      const mRec = Number(m.recurrence) || 1;
      const mConf = Number(m.confidence_score) || 0;
      if (mRec === (crystallizationThreshold - 1) && mConf >= 80) {
        nearCrystallization.push({
          id: m.id,
          category: m.category,
          title: String(m.title || "").slice(0, 60),
          recurrence: mRec,
          missing: 1,
        });
      }
    }
  }

  const hasEvolutionOpportunities =
    nearIronlaw.length > 0 || chronicWithoutRootCause.length > 0 || nearCrystallization.length > 0;
  let dynamicAgentHint = "若本次任务产出了新结论、配置变更或排障解法，请在结束前调用 memory_save 或 pitfall_save 沉淀。";
  if (nearIronlaw.length > 0) {
    const missingN = nearIronlaw[0].missing;
    dynamicAgentHint += ` 再记录 ${missingN} 次该故障即可自动生成铁律。`;
  }
  if (chronicWithoutRootCause.length > 0) {
    dynamicAgentHint += " 该顽疾缺真实根因，排查后请用 pitfall_save 补 root_cause。";
  }
  if (nearCrystallization.length > 0) {
    dynamicAgentHint += ` 另有 ${nearCrystallization.length} 条偏好/决策再印证 1 次即可结晶为准则。`;
  }

  const handoffDigest = await _detectAndClaimHandoff(client, projectArg, rawArgs, ctx); // 交接棒置顶 + 信箱未读（见文件末尾私有辅助）
  block = handoffDigest.lines + block; n += handoffDigest.count;

  const contextResult = {
    injected: n,
    chars: block.length,
    block: n ? block.trim() : "",
    _agent_hint: dynamicAgentHint,
  };
  if (hasEvolutionOpportunities) {
    const evoOpportunities = {
      near_ironlaw: nearIronlaw,
      chronic_without_root_cause: chronicWithoutRootCause,
    };
    if (nearCrystallization.length > 0) {
      evoOpportunities.near_crystallization = nearCrystallization;
    }
    contextResult.evolution_opportunities = evoOpportunities;
  }
  if (handoffDigest.active) contextResult.active_handoff = handoffDigest.active; if (handoffDigest.mailbox) contextResult.mailbox = handoffDigest.mailbox;

  return jsonOut(contextResult);
}

/* ================================================================== *
 * 私有辅助：跨 Agent 交接棒（Handoff）感知/单次核销 与 异步信箱未读消费
 * 说明：仅本模块内部使用，绝不导出（导出面由 tests/test_exports.mjs 锁定）
 * 设计：任何一步失败都 fail-open —— 上下文照常输出，宁可少提示也不阻断主流程
 * ================================================================== */

const HANDOFF_OPEN_TAG = /\bhandoff:open\b/i;
const MAIL_UNREAD_TAG = /\bmail:unread\b/i;

// 冷启动保底分：等价于 1 个查询词命中标题的权重（scoreMemory 标题命中 5 分），
// 取此值只保证画像「不被词面门槛筛掉」，真正的前排由 coldStart 分层排序负责。
const COLD_START_PROFILE_FLOOR = 5;

// 收敛画像判定：跨项目画像收敛（memory-saver 的 _promoteCrossProjectProfile）写入的
// project=global / scope_level=user 个人习惯，tags 带 profile:converged，origin 为 profile-convergence
function _isConvergedProfile(row) {
  if (!row || String(row.project || "") !== "global") return false;
  if (row.invalid_at) return false;
  return /profile:converged/i.test(String(row.tags || "")) || String(row.origin || "") === "profile-convergence";
}

// 项目行 + 全局穿透行合并去重：项目行优先，按 id（无 id 回退 project:title）去重，保持首见顺序
function _mergeRowsDedup(primary, secondary) {
  const seen = new Set();
  const out = [];
  for (const r of (primary || []).concat(secondary || [])) {
    const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
    if (seen.has(uid)) continue;
    seen.add(uid);
    out.push(r);
  }
  return out;
}

// 记录排序用的时间戳（NCB 返回 "YYYY-MM-DD HH:MM:SS"，需换成可 parse 的形态）
function _tsOfRow(row) {
  const raw = String((row && (row.updated_at || row.created_at)) || "").replace(" ", "T");
  const t = Date.parse(raw);
  return isNaN(t) ? 0 : t;
}

// 仅"活着"的记录才可被接力/投递：未软失效且非 superseded
function _isLiveRow(row) {
  if (!row) return false;
  if (row.invalid_at) return false;
  return !row.lifecycle_status || row.lifecycle_status === "active";
}

// 交接棒置顶行：新 Agent 零配置接力，必须最先被看到
function _handoffLine(row) {
  const from = row.client || "agent";
  return "- [Pending Cross-Agent Handoff / 跨智能体待接力任务#" + row.id + " from:" + from + "] "
    + cut(row.title, 80) + ": " + cut(row.content, 400) + "\n";
}

// 未读邮件行：其他项目投递的变更通知
function _mailLine(row) {
  const from = row.client || "agent";
  return "- [Unread Agent Mail / 未读跨项目信箱#" + row.id + " from:" + from + "] "
    + cut(row.title, 80) + ": " + cut(row.content, 300) + "\n";
}

/**
 * 检测当前项目的待接力交接棒与未读信箱，返回可直接置顶注入的文本块。
 * @param {object} client NCB 客户端
 * @param {string} project 当前项目命名空间
 * @param {object} rawArgs 原始工具入参（claim_handoff 只认显式 true，避免归一化误判）
 * @param {object} ctx 调用上下文：host 透传的 ctx 在 _ctx 上，故认领者按 ctx.agent → ctx._ctx.agent 取
 * @returns {Promise<{lines:string,count:number,active:object|null,mailbox:object|null}>}
 */
async function _detectAndClaimHandoff(client, project, rawArgs, ctx) {
  const digest = { lines: "", count: 0, active: null, mailbox: null };
  if (!project) return digest;

  let rows = [];
  try {
    rows = rowsOf(await client.list("memories", { project, limit: 50 }));
  } catch (_) {
    return digest; // fail-open：读不到信箱/交接棒时照常输出上下文，只是不置顶
  }

  const live = rows.filter(_isLiveRow);
  const openHandoffs = live
    .filter((r) => HANDOFF_OPEN_TAG.test(String(r.tags || "")))
    .sort((a, b) => _tsOfRow(b) - _tsOfRow(a));
  const unreadMail = live
    .filter((r) => MAIL_UNREAD_TAG.test(String(r.tags || "")))
    .sort((a, b) => _tsOfRow(b) - _tsOfRow(a));

  const lines = [];
  let count = 0;

  if (openHandoffs.length > 0) {
    const h = openHandoffs[0];
    lines.push(_handoffLine(h));
    count++;
    digest.active = {
      id: h.id,
      from_client: h.client || "unknown",
      title: h.title,
      content: h.content,
      updated_at: h.updated_at,
    };
    const claim = Boolean(rawArgs && (rawArgs.claim_handoff === true || rawArgs.claim_handoff === "true"));
    if (claim) {
      const claimedBy = String((ctx && (ctx.agent || (ctx._ctx && ctx._ctx.agent) || ctx.client)) || "unknown");
      try {
        // Claim-Once：改写为 claimed 并软失效，后续 Agent 不再重复消费；
        // 写失败时保持 open（宁可下次重复看到，也不丢失接力信息）
        await client.update("memories", h.id, {
          tags: String(h.tags || "").replace(/\bhandoff:open\b/gi, "handoff:claimed"),
          invalid_at: nowSql(),
          // 【BUG-460-1c】只写 invalid_at 会让 lifecycle_status 仍为 active：
          // 任何按 lifecycle_status=active 的列表/穿透查询都会把它当成活行重新捞回来，故必须同步置 invalid。
          lifecycle_status: "invalid",
          invalid_reason: "handoff_claimed_by:" + claimedBy,
          updated_at: nowSql(),
        });
      } catch (_) {
        // fail-open：核销失败仅导致下次重复提示一次
      }
    }
  }

  if (unreadMail.length > 0) {
    const ids = [];
    for (const mail of unreadMail) {
      lines.push(_mailLine(mail));
      count++;
      ids.push(mail.id);
    }
    digest.mailbox = {
      unread: unreadMail.length,
      ids,
      from: unreadMail.map((r) => r.client || "unknown"),
    };
    for (const mail of unreadMail) {
      try {
        // 单次消费：展示即标记 mail:read 并软失效，杜绝同一封邮件反复占预算
        await client.update("memories", mail.id, {
          tags: String(mail.tags || "").replace(/\bmail:unread\b/gi, "mail:read"),
          invalid_at: nowSql(),
          lifecycle_status: "invalid", // 与 invalid_at 同步，避免 active 列表把它当活行重新捞回
          invalid_reason: "mail_consumed",
          updated_at: nowSql(),
        });
      } catch (_) {
        // fail-open：消费失败仅导致下次重复提示一次
      }
    }
  }

  digest.lines = lines.join("");
  digest.count = count;
  return digest;
}

/**
 * 槽位动态配额计算：当用户传入显式 query 且存在打分命中项时，必须为目标记忆预留席位，
 * 杜绝通用准则与踩坑占满全部 maxItems 导致用户真正查询的记忆被 100% 饿死（终审阻断项）。
 */
function _calcQuota(rawQuery, scoredLen, maxItems, hasPitfalls) {
  const hasHits = Boolean(rawQuery) && scoredLen > 0;
  if (!hasHits) return { reserved: 0, maxPr: maxItems, maxPit: maxItems, hasHits: false };
  const reserved = Math.min(scoredLen, Math.max(2, Math.floor(maxItems * 0.4)));
  return {
    reserved,
    hasHits: true,
    maxPr: Math.max(1, maxItems - reserved - (hasPitfalls ? 1 : 0)),
    maxPit: Math.max(1, maxItems - reserved - 1),
  };
}
