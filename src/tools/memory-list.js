/**
 * 模块职责：memory_list MCP 工具入口（按项目/分类/标签/作用域分页列出记忆）
 * 依赖：src/tools/args.js, src/integration/ncb.js, src/domain/scoring.js, src/domain/validity.js
 * 被依赖：src/index.js
 */

import { normalizeToolArgs } from "./args.js";
import { fetchAll } from "../integration/ncb.js";
import { rankMemory, jsonOut } from "../domain/scoring.js";
import { isMemoryValid } from "../domain/validity.js";

export async function memoryList(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
  const projectArg = args.project ? String(args.project).trim() : "";
  const fetchParams = { lifecycle_status: "active" };
  if (args.client) fetchParams.client = String(args.client).trim();

  let all = [];
  if (projectArg && projectArg !== "global") {
    // 跨项目全局穿透：支持 project IN (args.project, 'global')，当前项目专属优先
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
    all = all.filter((r) => r.lifecycle_status !== "superseded" && isMemoryValid(r));
    all = all.filter((r) => String(r.project || "") === projectArg || String(r.project || "") === "global");
  } else {
    if (projectArg) fetchParams.project = projectArg;
    all = (await fetchAll(client, "memories", fetchParams)).filter(
      (r) => r.lifecycle_status !== "superseded" && isMemoryValid(r)
    );
    if (projectArg) all = all.filter((r) => String(r.project || "") === projectArg);
  }

  if (args.client) all = all.filter((r) => String(r.client || "") === String(args.client));

  const sorted = all.slice().sort((a, b) => {
    if (projectArg && projectArg !== "global") {
      const aProj = String(a.project || "") === projectArg ? 1 : 0;
      const bProj = String(b.project || "") === projectArg ? 1 : 0;
      if (aProj !== bProj) return bProj - aProj;
    }
    return rankMemory(b) - rankMemory(a);
  }).slice(0, limit);

  // EVO-10: knowledge_profile 自省画像计算
  const threshold = Number(cfg?.crystallization_threshold ?? 5) || 5;
  let principleCount = 0;
  let preferenceCount = 0;
  let decisionCount = 0;
  const nearCandidates = [];

  for (const r of all) {
    const cat = String(r.category || "").toLowerCase();
    if (cat === "principle") principleCount++;
    else if (cat === "preference") preferenceCount++;
    else if (cat === "decision") decisionCount++;

    if (cat === "preference" || cat === "decision") {
      const rec = Number(r.recurrence) || 1;
      const conf = r.confidence_score != null ? Number(r.confidence_score) : 100;
      if (rec >= threshold - 1 && rec < threshold && conf >= 80) {
        nearCandidates.push({
          id: r.id,
          title: r.title,
          recurrence: rec,
          threshold,
        });
      }
    }
  }

  nearCandidates.sort((a, b) => b.recurrence - a.recurrence);
  const nearCrystallization = nearCandidates.slice(0, 5);

  // EVO-12: chronic_pitfalls 顽疾画像（当前 project 含 global 穿透，invalid_at 为空且 recurrence >= 3，按 recurrence 降序最多 5 条）
  let chronicPitfalls = [];
  try {
    const pitfallColumns = ["id", "project", "component", "symptom", "recurrence", "invalid_at"];
    let rawPitfalls = [];
    if (projectArg && projectArg !== "global") {
      const [projPits, globalPits] = await Promise.all([
        fetchAll(client, "pitfalls", { project: projectArg, columns: pitfallColumns }),
        fetchAll(client, "pitfalls", { project: "global", columns: pitfallColumns }),
      ]);
      const seen = new Set();
      for (const r of projPits) {
        if (r && r.id != null && !seen.has(r.id)) {
          seen.add(r.id);
          rawPitfalls.push(r);
        }
      }
      for (const r of globalPits) {
        if (r && r.id != null && !seen.has(r.id)) {
          seen.add(r.id);
          rawPitfalls.push(r);
        }
      }
    } else {
      const pitParams = { columns: pitfallColumns };
      if (projectArg) pitParams.project = projectArg;
      rawPitfalls = await fetchAll(client, "pitfalls", pitParams);
    }
    chronicPitfalls = rawPitfalls
      .filter((r) => r && !r.invalid_at && (Number(r.recurrence) || 0) >= 3)
      .sort((a, b) => (Number(b.recurrence) || 0) - (Number(a.recurrence) || 0))
      .slice(0, 5)
      .map((r) => ({
        id: r.id,
        component: r.component || "general",
        symptom: String(r.symptom || "").slice(0, 60),
        recurrence: Number(r.recurrence) || 1,
      }));
  } catch (_) {
    chronicPitfalls = [];
  }

  const knowledgeProfile = {
    principle_count: principleCount,
    preference_count: preferenceCount,
    decision_count: decisionCount,
    near_crystallization: nearCrystallization,
    chronic_pitfalls: chronicPitfalls,
    total_active: all.length,
  };

  return jsonOut({
    total_active: all.length,
    returned: sorted.length,
    memories: sorted.map((r) => ({
      id: r.id, project: r.project, category: r.category,
      scope_level: r.scope_level,
      client: r.client || "unknown",
      origin: r.origin || "tool",
      title: r.title, tags: r.tags,
      recurrence: Number(r.recurrence) || 1,
      retrieval_count: Number(r.retrieval_count) || 0,
      last_used_at: r.last_used_at || null,
    })),
    knowledge_profile: knowledgeProfile,
  });
}
