/**
 * 模块职责：pitfall_save MCP 工具入口（踩坑记录沉淀、同因合并、复发频次累加、高频结晶反哺事实库）
 * 依赖：src/core/**, src/domain/**, src/integration/**, src/services/**, scrub.js, semantic_dedup.js
 * 被依赖：src/index.js
 */

import { normalizeToolArgs } from "./args.js";
import { SEVERITIES, FETCH_LIMIT, nowSql } from "../core/config.js";
import { isTestMode } from "../core/env.js";
import { markRecent, justWritten } from "../core/state-recent.js";
import { fingerprint } from "../domain/fingerprint.js";
import { jsonOut } from "../domain/scoring.js";
import { rowsOf } from "../integration/ncb.js";
import { saveMemory } from "../services/save/memory-saver.js";
import { scrubSecrets } from "../core/sanitize.js";
import {
  normalizeSemanticText,
  semanticFingerprint,
  isSemanticallySimilar,
  tokenize,
  overlapCoefficient,
  jaccardSimilarity,
  hasConflictingNumbers,
} from "../domain/semantic-dedup.js";

export async function pitfallSave(client, cfg, rawArgs, ctx) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const project = String(args.project || "global").trim();
  const callerAgent = (ctx && (ctx.agent || (ctx._ctx && ctx._ctx.agent))) || "";
  const clientVal = (args.client && String(args.client).trim())
    || (callerAgent && String(callerAgent).trim())
    || (args.agent && String(args.agent).trim())
    || "unknown";
  const rawSymptom = String(args.symptom || "").trim();
  const rawSolution = String(args.solution || "").trim();
  if (!rawSymptom) throw new Error("symptom 不能为空");
  if (!rawSolution) throw new Error("solution 不能为空");

  const symptom = scrubSecrets(rawSymptom);
  const solution = scrubSecrets(rawSolution);
  const rawComponent = String(args.component || "").trim();
  const component = scrubSecrets(rawComponent || "general");
  const rawRootCause = String(args.root_cause || "").trim();
  const hasExplicitRootCause = Boolean(args.root_cause != null && String(args.root_cause).trim() !== "");
  const rootCause = scrubSecrets(rawRootCause || symptom);

  const severity = SEVERITIES.includes(args.severity) ? args.severity : "medium";
  const errorType = String(args.error_type || "").trim();
  const tags = scrubSecrets(String(args.tags || "").trim().toLowerCase());

  /* 来源可追溯性（空值语义同 saveMemory）：
   * 无会话上下文或直接调用时为 NULL，严禁伪造假数据。 */
  const callerSession = (ctx && (ctx.session || (ctx._ctx && ctx._ctx.session))) || "";
  const callerTurn = (ctx && (typeof ctx.turn === "number" ? ctx.turn : (ctx._ctx && typeof ctx._ctx.turn === "number" ? ctx._ctx.turn : null)));
  const rawSession = (args.source_session && String(args.source_session).trim())
    || (callerSession && String(callerSession).trim())
    || "";
  const sourceSession = rawSession ? rawSession.slice(0, 128) : null;
  const parsedTurn = typeof args.source_turn === "number" ? args.source_turn : (args.source_turn ? Number(args.source_turn) : null);
  const sourceTurn = (typeof parsedTurn === "number" && !isNaN(parsedTurn) && parsedTurn >= 1)
    ? Math.floor(parsedTurn)
    : (callerTurn && callerTurn >= 1 ? Math.floor(callerTurn) : null);

  const fp = (args.content_fingerprint && String(args.content_fingerprint).trim()) || semanticFingerprint(project, "pitfall", component, symptom);
  const solFp = fingerprint((solution || "") + ":" + (rootCause || ""));
  const recentKey = "p:" + fp + ":" + solFp;
  const initialRecurrence = typeof args.recurrence === "number" && args.recurrence >= 1 ? Math.floor(args.recurrence) : 1;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  if (!isTestMode() && justWritten(recentKey)) {
    return jsonOut({ action: "NOOP", id: null, note: "刚刚写入过（写后读延迟窗口内），已忽略重复" });
  }

  // A③ 踩坑优先：若 memories 表中存在该问题的冗余记忆，软失效之（排除 category==="principle"，绝不物理删除）
  try {
    const memRows = rowsOf(await client.list("memories", { project, lifecycle_status: "active", limit: FETCH_LIMIT }));
    const normSym = normalizeSemanticText(symptom);
    const supersededMems = memRows.filter((m) => {
      if (m.category === "principle") return false;
      if (hasConflictingNumbers(m.title, symptom)) return false;
      if (hasConflictingNumbers(m.content || m.full_text || "", solution || rootCause || "")) return false;
      const mTitle = normalizeSemanticText(m.title);
      if (mTitle && (mTitle === normSym || mTitle.includes(normSym) || normSym.includes(mTitle))) {
        if (!hasConflictingNumbers(m.title, symptom)) return true;
      }
      const tTok = tokenize(m.title);
      const sTok = tokenize(symptom);
      if (overlapCoefficient(tTok.tokens, sTok.tokens) >= 0.5 || jaccardSimilarity(tTok.tokens, sTok.tokens) >= 0.3) {
        if (!hasConflictingNumbers(m.title, symptom)) return true;
      }
      return isSemanticallySimilar(m.title, m.content || m.full_text, symptom, solution || rootCause);
    });
    for (const oldMem of supersededMems) {
      try {
        await client.update("memories", oldMem.id, {
          lifecycle_status: "superseded",
          invalid_at: now,
          invalid_reason: "superseded_by_pitfall",
          updated_at: now,
        });
      } catch (_) {}
    }
  } catch (_) {
    // fail-open
  }

  const allPitfalls = rowsOf(await client.list("pitfalls", { project, limit: FETCH_LIMIT }));
  const activePitfalls = allPitfalls.filter((r) => !r.invalid_at);
  let dup = activePitfalls.find((r) => r.content_fingerprint === fp);
  if (!dup) {
    dup = activePitfalls.find((r) => {
      if (hasConflictingNumbers(r.symptom, symptom)) return false;
      const rSym = normalizeSemanticText(r.symptom);
      const curSym = normalizeSemanticText(symptom);
      if (rSym && curSym && (rSym === curSym || rSym.includes(curSym) || curSym.includes(rSym))) {
        if (!hasConflictingNumbers(r.symptom, symptom)) return true;
      }
      const rTok = tokenize(r.symptom);
      const sTok = tokenize(symptom);
      if (overlapCoefficient(rTok.tokens, sTok.tokens) >= 0.5 || jaccardSimilarity(rTok.tokens, sTok.tokens) >= 0.3) {
        if (!hasConflictingNumbers(r.symptom, symptom)) return true;
      }
      return isSemanticallySimilar(symptom, solution || rootCause, r.symptom, r.solution || r.root_cause);
    });
  }

  function isPlaceholderRootCause(rc, sym) {
    if (!rc || !String(rc).trim()) return true;
    const s = String(rc).trim();
    if (sym && s === String(sym).trim()) return true;
    if (/未知|待查|临时|unknown|todo|tbd|已处置解决|执行过程中出现/i.test(s)) return true;
    return false;
  }

  function isMeaningfulIronlaw(rc, sym, sol) {
    const rcStr = String(rc || "").trim();
    const symStr = String(sym || "").trim();
    const solStr = String(sol || "").trim();
    if (!rcStr || !solStr) return false;
    if (rcStr.toLowerCase() === symStr.toLowerCase()) return false;
    const placeholderRe = /未知|待查|临时|unknown|todo|tbd|已处置解决|执行过程中出现/i;
    if (placeholderRe.test(rcStr) || placeholderRe.test(solStr)) return false;
    return true;
  }

  async function checkAndApplyIronlaw(outObj, targetRecurrence, targetComponent, targetSymptom, targetRootCause, targetSolution, targetTags) {
    const crystallizationThreshold = Number(args.crystallization_threshold ?? cfg?.crystallization_threshold ?? 5) || 5;
    const rec = Number(targetRecurrence) || 1;
    if (rec < crystallizationThreshold) {
      return outObj;
    }
    if (!isMeaningfulIronlaw(targetRootCause, targetSymptom, targetSolution)) {
      return outObj;
    }

    try {
      const comp = String(targetComponent || "general").trim();
      const symTrimmed = String(targetSymptom || "").trim().slice(0, 60);
      const ironTitle = `【踩坑铁律】${comp}: ${symTrimmed}`;
      const ironContent = `【症状】${targetSymptom}\n【根因】${targetRootCause}\n【解法】${targetSolution}`;

      const existingTags = String(targetTags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!existingTags.includes("pitfall-ironlaw")) {
        existingTags.push("pitfall-ironlaw");
      }
      const ironTags = Array.from(new Set(existingTags)).join(", ");

      const compList = comp ? [comp] : [];
      const incomingEntities = String(args.related_entities || "").split(/[,;\s，、]+/).map((s) => scrubSecrets(s.trim())).filter(Boolean);
      const ironEntities = Array.from(new Set([...compList, ...incomingEntities])).join(", ");

      const memRows = rowsOf(await client.list("memories", { project, limit: FETCH_LIMIT }));
      const existingPrinciple = memRows.find(
        (r) => r.category === "principle" && !r.invalid_at && (r.lifecycle_status === "active" || !r.lifecycle_status) && String(r.title || "").trim() === ironTitle
      );

      let ironId;
      if (existingPrinciple) {
        const ironNext = (Number(existingPrinciple.recurrence) || 1) + 1;
        const existingPTags = String(existingPrinciple.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const mergedIronTags = Array.from(new Set([...existingPTags, ...existingTags])).join(", ");
        const existingPEntities = String(existingPrinciple.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
        const mergedIronEntities = Array.from(new Set([...existingPEntities, ...compList, ...incomingEntities])).join(", ");
        const updatedIronFp = semanticFingerprint(project, "principle", ironTitle, ironContent, mergedIronTags);
        await client.update("memories", existingPrinciple.id, {
          recurrence: ironNext,
          confidence_score: 100,
          content: ironContent,
          full_text: ironContent,
          tags: mergedIronTags,
          related_entities: mergedIronEntities || comp,
          content_fingerprint: updatedIronFp,
          updated_at: nowSql(),
        });
        ironId = existingPrinciple.id;
      } else {
        const ironFp = semanticFingerprint(project, "principle", ironTitle, ironContent, ironTags);
        try {
          const createdMem = await client.create("memories", {
            project,
            category: "principle",
            scope_level: "project",
            client: clientVal,
            origin: "tool",
            title: ironTitle,
            content: ironContent,
            full_text: ironContent,
            tags: ironTags,
            related_entities: ironEntities || comp,
            content_fingerprint: ironFp,
            confidence_score: 100,
            lifecycle_status: "active",
            superseded_by_id: null,
            revision: 1,
            recurrence: 1,
            retrieval_count: 0,
            invalid_at: null,
            invalid_reason: "",
            expires_at: null,
            last_used_at: null,
            created_at: nowSql(),
            updated_at: nowSql(),
            source_session: sourceSession,
            source_turn: sourceTurn,
          });
          ironId = createdMem && (createdMem.id || createdMem.insertId);
          if (ironId) {
            markRecent("m:" + ironFp);
          }
        } catch (e) {
          if (/duplicate entry/i.test(String(e.message))) {
            const memRowsAgain = rowsOf(await client.list("memories", { project, limit: FETCH_LIMIT }));
            const dupP = memRowsAgain.find(
              (r) => r.category === "principle" && !r.invalid_at && (String(r.title || "").trim() === ironTitle || r.content_fingerprint === ironFp)
            );
            if (dupP) {
              const ironNext = (Number(dupP.recurrence) || 1) + 1;
              const dupPTags = String(dupP.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
              const mergedIronTags = Array.from(new Set([...dupPTags, ...existingTags])).join(", ");
              const dupPEntities = String(dupP.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
              const mergedIronEntities = Array.from(new Set([...dupPEntities, ...compList, ...incomingEntities])).join(", ");
              const updatedIronFp = semanticFingerprint(project, "principle", ironTitle, ironContent, mergedIronTags);
              await client.update("memories", dupP.id, {
                recurrence: ironNext,
                confidence_score: 100,
                content: ironContent,
                full_text: ironContent,
                tags: mergedIronTags,
                related_entities: mergedIronEntities || comp,
                content_fingerprint: updatedIronFp,
                updated_at: nowSql(),
              });
              ironId = dupP.id;
            }
          }
        }
      }

      if (ironId) {
        outObj.ironlaw_created = true;
        outObj.ironlaw_id = ironId;
      }
    } catch (_) {}
    return outObj;
  }

  if (dup) {
    const next = (Number(dup.recurrence) || 1) + initialRecurrence;
    const oldSol = String(dup.solution || "").trim();
    const newSol = String(solution || "").trim();
    const oldRc = String(dup.root_cause || "").trim();
    const oldSym = String(dup.symptom || "").trim();

    // EVO-16: 既有 tags 与本次传入 tags 取并集（用于 EVOLVED 与 NOOP 回写）
    const existingTags = String(dup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const incomingTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const mergedTags = Array.from(new Set([...existingTags, ...incomingTags])).join(", ");

    // BUG-1 (2): 数字冲突守卫：新旧 solution 存在数字冲突时禁止演进覆盖，改为返回 NOOP 并在 note 说明数字冲突
    const hasSolConflict = hasConflictingNumbers(oldSol, newSol);
    if (hasSolConflict) {
      try {
        await client.update("pitfalls", dup.id, {
          recurrence: next,
          tags: mergedTags || dup.tags,
          last_occurred_at: now,
          updated_at: now,
        });
        markRecent(recentKey);
        const out = await checkAndApplyIronlaw({
          action: "NOOP",
          id: dup.id,
          recurrence: next,
          note: "方案存在数字冲突，禁止演进覆盖，累加复发计数",
        }, next, dup.component || component, dup.symptom || symptom, dup.root_cause || rootCause, oldSol, mergedTags || dup.tags);
        return jsonOut(out);
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    }

    // 演进条件 1: 新 solution 更详尽（长度 ≥ 旧×1.3 且无数字冲突）
    const isSolutionMoreDetailed = !hasSolConflict && (
      (oldSol.length === 0 && newSol.length > 0) ||
      (oldSol.length > 0 && newSol.length >= oldSol.length * 1.3)
    );

    // BUG-1 (1): 仅当调用方显式传入 root_cause 时才用新值；未传则保留库中原值（绝不拿 symptom 顶替）
    const explicitRc = hasExplicitRootCause ? scrubSecrets(rawRootCause) : "";
    const oldIsPlaceholder = isPlaceholderRootCause(oldRc, oldSym);
    const newIsReal = hasExplicitRootCause && explicitRc && !isPlaceholderRootCause(explicitRc, symptom);
    const isRootCauseReplaced = oldIsPlaceholder && Boolean(newIsReal);
    const isRootCauseExplicitUpdated = hasExplicitRootCause && Boolean(explicitRc) && explicitRc !== oldRc && !oldIsPlaceholder;

    if (isSolutionMoreDetailed || isRootCauseReplaced || isRootCauseExplicitUpdated) {
      const reasons = [];
      if (isSolutionMoreDetailed) reasons.push(`解法更详尽（长度由 ${oldSol.length} 增至 ${newSol.length}，≥1.3倍）`);
      if (isRootCauseReplaced) reasons.push(`根因替换占位（原根因: "${oldRc || '(空)'}" -> 新根因: "${explicitRc}"）`);
      else if (isRootCauseExplicitUpdated) reasons.push(`根因更新（原根因: "${oldRc || '(空)'}" -> 新根因: "${explicitRc}"）`);
      const reason = reasons.join("；");

      const updatePayload = {
        solution: (isSolutionMoreDetailed && newSol) ? newSol : oldSol,
        root_cause: (hasExplicitRootCause && explicitRc) ? explicitRc : oldRc,
        tags: mergedTags || dup.tags,
        recurrence: next,
        last_occurred_at: now,
        updated_at: now,
      };

      try {
        await client.update("pitfalls", dup.id, Object.assign({}, updatePayload, { updated_at: updatePayload.updated_at || nowSql() }));
        markRecent(recentKey);
        const out = await checkAndApplyIronlaw({
          action: "EVOLVED",
          id: dup.id,
          recurrence: next,
          reason,
          note: reason,
        }, next, dup.component || component, dup.symptom || symptom, updatePayload.root_cause, updatePayload.solution, updatePayload.tags);
        return jsonOut(out);
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    } else {
      try {
        await client.update("pitfalls", dup.id, {
          recurrence: next,
          tags: mergedTags || dup.tags,
          last_occurred_at: now,
          updated_at: now,
        });
        markRecent(recentKey);
        const out = await checkAndApplyIronlaw({
          action: "NOOP",
          id: dup.id,
          recurrence: next,
          note: dup.content_fingerprint === fp ? undefined : "语义相似踩坑去重命中，累加复发计数",
        }, next, dup.component || component, dup.symptom || symptom, dup.root_cause || rootCause, oldSol, mergedTags || dup.tags);
        return jsonOut(out);
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    }
  }

  let created;
  try {
    created = await client.create("pitfalls", {
      project, client: clientVal, component, symptom, root_cause: rootCause, solution,
      severity, error_type: errorType, tags, related_entities: args.related_entities ? scrubSecrets(String(args.related_entities).trim()).slice(0, 500) : "", content_fingerprint: fp,
      recurrence: initialRecurrence, last_occurred_at: now,
      source_session: sourceSession,
      source_turn: sourceTurn,
      created_at: now, updated_at: now,
    });
  } catch (e) {
    if (/duplicate entry/i.test(String(e.message))) {
      markRecent(recentKey);
      const dup = rowsOf(await client.list("pitfalls", { project, limit: FETCH_LIMIT })).filter(
        (r) => !r.invalid_at && r.content_fingerprint === fp
      )[0];
      if (dup) {
        const next = (Number(dup.recurrence) || 1) + initialRecurrence;
        const oldSol = String(dup.solution || "").trim();
        const newSol = String(solution || "").trim();
        const oldRc = String(dup.root_cause || "").trim();
        const oldSym = String(dup.symptom || "").trim();

        const existingTags = String(dup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const incomingTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const mergedTags = Array.from(new Set([...existingTags, ...incomingTags])).join(", ");

        const hasSolConflict = hasConflictingNumbers(oldSol, newSol);
        if (hasSolConflict) {
          try {
            await client.update("pitfalls", dup.id, {
              recurrence: next,
              tags: mergedTags || dup.tags,
              last_occurred_at: now,
              updated_at: now,
            });
          } catch (_) {}
          const out = await checkAndApplyIronlaw({
            action: "NOOP",
            id: dup.id,
            recurrence: next,
            note: "方案存在数字冲突，禁止演进覆盖，累加复发计数",
          }, next, dup.component || component, dup.symptom || symptom, dup.root_cause || rootCause, oldSol, mergedTags || dup.tags);
          return jsonOut(out);
        }

        const isSolutionMoreDetailed = !hasSolConflict && (
          (oldSol.length === 0 && newSol.length > 0) ||
          (oldSol.length > 0 && newSol.length >= oldSol.length * 1.3)
        );
        const explicitRc = hasExplicitRootCause ? scrubSecrets(rawRootCause) : "";
        const oldIsPlaceholder = isPlaceholderRootCause(oldRc, oldSym);
        const newIsReal = hasExplicitRootCause && explicitRc && !isPlaceholderRootCause(explicitRc, symptom);
        const isRootCauseReplaced = oldIsPlaceholder && Boolean(newIsReal);
        const isRootCauseExplicitUpdated = hasExplicitRootCause && Boolean(explicitRc) && explicitRc !== oldRc && !oldIsPlaceholder;

        if (isSolutionMoreDetailed || isRootCauseReplaced || isRootCauseExplicitUpdated) {
          const reasons = [];
          if (isSolutionMoreDetailed) reasons.push(`解法更详尽（长度由 ${oldSol.length} 增至 ${newSol.length}，≥1.3倍）`);
          if (isRootCauseReplaced) reasons.push(`根因替换占位（原根因: "${oldRc || '(空)'}" -> 新根因: "${explicitRc}"）`);
          else if (isRootCauseExplicitUpdated) reasons.push(`根因更新（原根因: "${oldRc || '(空)'}" -> 新根因: "${explicitRc}"）`);
          const reason = reasons.join("；");

          try {
            await client.update("pitfalls", dup.id, {
              solution: (isSolutionMoreDetailed && newSol) ? newSol : oldSol,
              root_cause: (hasExplicitRootCause && explicitRc) ? explicitRc : oldRc,
              tags: mergedTags || dup.tags,
              recurrence: next,
              last_occurred_at: now,
              updated_at: now,
            });
          } catch (_) {}
          const out = await checkAndApplyIronlaw({ action: "EVOLVED", id: dup.id, recurrence: next, reason, note: reason }, next, dup.component || component, dup.symptom || symptom, (hasExplicitRootCause && explicitRc) ? explicitRc : oldRc, (isSolutionMoreDetailed && newSol) ? newSol : oldSol, mergedTags || dup.tags);
          return jsonOut(out);
        }

        try {
          await client.update("pitfalls", dup.id, {
            recurrence: next,
            tags: mergedTags || dup.tags,
            last_occurred_at: now,
            updated_at: now,
          });
        } catch (_) {}
        const out = await checkAndApplyIronlaw({
          action: "NOOP",
          id: dup.id,
          recurrence: next,
          note: "唯一索引拦下重复",
        }, next, dup.component || component, dup.symptom || symptom, dup.root_cause || rootCause, oldSol, mergedTags || dup.tags);
        return jsonOut(out);
      }
      return jsonOut({ action: "NOOP", id: null, note: "唯一索引拦下重复" });
    }
    throw e;
  }
  markRecent(recentKey);
  const out = await checkAndApplyIronlaw({ action: "ADD", id: created && (created.id || created.insertId) }, initialRecurrence, component, symptom, rootCause, solution, tags);
  return jsonOut(out);
}
