/**
 * 模块职责：memory_context MCP 工具入口（上下文装配、记忆与踩坑双路召回、预算控制与格式化注入）
 * 依赖：src/core/**, src/domain/**, src/integration/**, src/services/**, online_models.js
 * 被依赖：src/index.js
 */

import { normalizeToolArgs } from "./args.js";
import { fetchAll } from "../integration/ncb.js";
import { scoreMemory, scorePitfall, freshness, rankMemory, cut, jsonOut, termsOf } from "../domain/scoring.js";
import { isMemoryValid } from "../domain/validity.js";
import { trackMemoryRetrievals } from "../services/audit/scheduler.js";
import { rewriteSearchQuery } from "../integration/provider-models.js";

export async function memoryContext(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const maxItems = Number(args.max_items) || cfg.maxInject || 5;
  const budget = Number(args.max_chars) || cfg.maxBudget || 2048;
  const rawQuery = String(args.query || "").trim();
  const origTerms = termsOf(rawQuery);
  const projectArg = args.project ? String(args.project).trim() : "";

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

  // 1. 获取 memories（支持跨项目全局穿透：project + global）
  let pool = [];
  if (projectArg && projectArg !== "global") {
    const [projRows, globalRows] = await Promise.all([
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: projectArg })),
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: "global" })),
    ]);
    const seen = new Set();
    const all = [];
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
    pool = all.filter((r) => r.lifecycle_status !== "superseded" && isMemoryValid(r));
    pool = pool.filter((r) => String(r.project || "") === projectArg || String(r.project || "") === "global");
  } else {
    if (projectArg) fetchParams.project = projectArg;
    const all = await fetchAll(client, "memories", fetchParams);
    pool = all.filter((r) => r.lifecycle_status !== "superseded" && isMemoryValid(r));
    if (projectArg) pool = pool.filter((r) => String(r.project || "") === projectArg);
  }

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

  for (const pr of principles) {
    if (n >= maxItems) break;
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
  }

  const pitfallThreshold = Number(args.pitfall_recurrence_threshold ?? cfg?.pitfall_recurrence_threshold ?? 3) || 3;

  for (const pit of topPitfalls) {
    if (n >= maxItems) break;
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

  return jsonOut(contextResult);
}
