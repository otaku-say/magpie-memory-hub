/**
 * 模块职责：memory_get MCP 工具入口（单条或批量读取记忆与踩坑记录，CCR 展开用）
 * 依赖：src/tools/args.js, src/integration/ncb.js, src/domain/scoring.js
 * 被依赖：src/index.js
 */

import { normalizeToolArgs } from "./args.js";
import { rowsOf } from "../integration/ncb.js";
import { jsonOut } from "../domain/scoring.js";

/**
 * feedback=helpful 提权：confidence +10（封顶 100）、recurrence +1，并顺带累加访问热度。
 * 落库失败仅吞掉写操作（读取结果不受影响，fail-open），返回回显标记供调用方透出。
 */
async function _applyHelpfulFeedback(client, table, id, hit, count, now, helpful) {
  const patch = { retrieval_count: count, last_used_at: now };
  if (helpful) {
    const cur = Number(hit.confidence_score);
    patch.confidence_score = Math.min(100, (isNaN(cur) ? 100 : cur) + 10);
    patch.recurrence = (Number(hit.recurrence) || 1) + 1;
  }
  try {
    await client.update(table, id, patch);
  } catch (_) {
    return null; // 访问计数/反馈写失败不阻塞读取（fail-open）
  }
  if (helpful) {
    // BUG-460-4b：库内已提权，内存对象必须同步，否则回显给调用方的仍是提权前的旧分
    hit.confidence_score = patch.confidence_score;
    hit.recurrence = patch.recurrence;
  }
  return helpful ? "helpful" : null;
}

/**
 * BUG-460-4b：提权当次把「库内已生效」的 confidence_score / recurrence 回显到返回体。
 * 只有 fbApplied 为真才调用，未提权路径不新增任何字段，保持旧返回体零侵入。
 */
function _applyFeedbackEcho(rec, hit, fbApplied) {
  rec.feedback_applied = fbApplied;
  rec.confidence_score = Number(hit.confidence_score);
  rec.recurrence = Number(hit.recurrence) || 1;
}

export async function memoryGet(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const explicitTable = (rawArgs && rawArgs.table != null && String(rawArgs.table).trim() !== "")
    ? String(rawArgs.table).trim().toLowerCase()
    : null;
  const table = (explicitTable === "pitfalls") ? "pitfalls" : "memories";
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const helpful = String(args.feedback || "").toLowerCase().trim() === "helpful";

  const isBatch = Array.isArray(args.ids) || (args.ids != null && typeof args.ids === "string" && args.ids.includes(","));
  let targetIds = [];

  if (isBatch) {
    targetIds = (Array.isArray(args.ids) ? args.ids : String(args.ids).split(",")).map(Number).filter(Boolean);
  } else if (args.id != null) {
    const singleId = Number(args.id);
    if (!singleId) throw new Error("id 不能为空");
    targetIds = [singleId];
  } else {
    throw new Error("id 不能为空");
  }

  async function getSupersededHistory(hit) {
    if (Number(hit.revision) <= 1) return { history: null, note: null };
    try {
      const queryParams = { project: hit.project, limit: 100 };
      const allProjMemories = rowsOf(await client.list("memories", queryParams));
      const titleLower = String(hit.title || "").trim().toLowerCase();
      const predecessors = allProjMemories.filter((r) => {
        if (Number(r.id) === Number(hit.id)) return false;
        const isSuperBy = Number(r.superseded_by_id) === Number(hit.id);
        const isSameTitleSuperseded = r.lifecycle_status === "superseded" &&
          String(r.title || "").trim().toLowerCase() === titleLower;
        const isPriorRevision = Number(r.revision) < Number(hit.revision) &&
          String(r.title || "").trim().toLowerCase() === titleLower;
        return isSuperBy || isSameTitleSuperseded || isPriorRevision;
      });

      if (predecessors.length > 0) {
        predecessors.sort((a, b) => {
          const revDiff = (Number(b.revision) || 0) - (Number(a.revision) || 0);
          if (revDiff !== 0) return revDiff;
          return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
        });
        const history = predecessors.slice(0, 3).map((r) => ({
          revision: Number(r.revision) || 1,
          title: r.title,
          content: String(r.content || "").slice(0, 120),
          updated_at: r.updated_at,
        }));
        return { history, note: null };
      }
      return { history: [], note: "历史版本未持久化" };
    } catch (_) {
      return { history: [], note: "历史版本未持久化" };
    }
  }

  function getLifecycleWarning(hit) {
    const isInvalid = Boolean((hit.invalid_at && String(hit.invalid_at).trim() !== "") || (hit.lifecycle_status && hit.lifecycle_status !== "active"));
    if (!isInvalid) return null;
    const superId = (hit.superseded_by_id != null && String(hit.superseded_by_id).trim() !== "")
      ? Number(hit.superseded_by_id)
      : null;
    if (superId) {
      return `该记录已被 #${superId} 取代，可调 memory_get(id=${superId}) 查看最新版本`;
    }
    const reason = (hit.invalid_reason != null && String(hit.invalid_reason).trim() !== "")
      ? String(hit.invalid_reason).trim()
      : "未注明";
    return `该记录已失效（原因: ${reason}）`;
  }

  function formatMemoryRecord(hit, count, lastUsed, historyInfo) {
    const full = (hit.full_text != null && String(hit.full_text).trim() !== "")
      ? hit.full_text
      : hit.content;
    const isInvalid = Boolean((hit.invalid_at && String(hit.invalid_at).trim() !== "") || (hit.lifecycle_status && hit.lifecycle_status !== "active"));
    const warning = getLifecycleWarning(hit);
    const rec = {
      id: hit.id,
      project: hit.project,
      category: hit.category,
      scope_level: hit.scope_level,
      client: hit.client || "unknown",
      origin: hit.origin || "tool",
      title: hit.title,
      content: full,
      summary: hit.content,
      full_text: full,
      tags: hit.tags,
      related_entities: hit.related_entities || "",
      retrieval_count: count,
      last_used_at: lastUsed,
      revision: Number(hit.revision) || 1,
      lifecycle_status: hit.lifecycle_status || (isInvalid ? "invalid" : "active"),
      invalid_at: (hit.invalid_at && String(hit.invalid_at).trim() !== "") ? hit.invalid_at : null,
      invalid_reason: hit.invalid_reason || "",
      superseded_by_id: (hit.superseded_by_id != null && String(hit.superseded_by_id).trim() !== "") ? Number(hit.superseded_by_id) : null,
      _lifecycle_warning: warning || null,
      _note: "已返回完整原文（见 full_text 与 content），summary 为注入卡片所用摘要",
    };
    if (Number(hit.revision) > 1) {
      rec.superseded_history = (historyInfo && historyInfo.history) || [];
      if (historyInfo && historyInfo.note) {
        rec.note = historyInfo.note;
      }
    }
    return rec;
  }

  function formatPitfallRecord(hit, autoFallback = false) {
    const isInvalid = Boolean((hit.invalid_at && String(hit.invalid_at).trim() !== "") || (hit.lifecycle_status && hit.lifecycle_status !== "active"));
    const warning = getLifecycleWarning(hit);
    const rec = {
      id: hit.id,
      project: hit.project,
      table: "pitfalls",
      component: hit.component || "general",
      symptom: hit.symptom,
      root_cause: hit.root_cause,
      solution: hit.solution,
      severity: hit.severity,
      error_type: hit.error_type,
      tags: hit.tags,
      recurrence: Number(hit.recurrence) || 1,
      title: `${hit.component || "general"}: ${hit.symptom}`,
      content: `【症状】${hit.symptom}\n【根因】${hit.root_cause}\n【解法】${hit.solution}`,
      full_text: `【症状】${hit.symptom}\n【根因】${hit.root_cause}\n【解法】${hit.solution}`,
      summary: `${hit.symptom} → ${hit.solution}`,
      lifecycle_status: hit.lifecycle_status || (isInvalid ? "invalid" : "active"),
      invalid_at: (hit.invalid_at && String(hit.invalid_at).trim() !== "") ? hit.invalid_at : null,
      invalid_reason: hit.invalid_reason || "",
      superseded_by_id: (hit.superseded_by_id != null && String(hit.superseded_by_id).trim() !== "") ? Number(hit.superseded_by_id) : null,
      _lifecycle_warning: warning || null,
      last_occurred_at: hit.last_occurred_at || now,
      _note: "已返回踩坑排障完整记录",
    };
    if (autoFallback) {
      rec.auto_fallback = true;
    }
    return rec;
  }

  if (isBatch) {
    const items = [];
    for (const tid of targetIds) {
      let res = await client.list(table, { id: tid, limit: 1 });
      let hit = rowsOf(res).filter((r) => Number(r.id) === tid)[0];
      let isFallback = false;

      // BUG-4: 若未显式指定 table，且 memories 表查无此 id，自动回退到 pitfalls 表查找
      if (!hit && !explicitTable) {
        const pitRes = await client.list("pitfalls", { id: tid, limit: 1 });
        const pitHit = rowsOf(pitRes).filter((r) => Number(r.id) === tid)[0];
        if (pitHit) {
          hit = pitHit;
          isFallback = true;
        }
      }

      if (hit) {
        if (isFallback || table === "pitfalls") {
          items.push(formatPitfallRecord(hit, isFallback));
        } else {
          const count = (Number(hit.retrieval_count) || 0) + 1;
          const fbApplied = await _applyHelpfulFeedback(client, "memories", tid, hit, count, now, helpful);
          // 先落库（含 helpful 提权）再装配返回体，保证 count / confidence 与回显一致
          const rec = formatMemoryRecord(hit, count, now, await getSupersededHistory(hit));
          if (fbApplied) _applyFeedbackEcho(rec, hit, fbApplied);
          items.push(rec);
        }
      }
    }
    return jsonOut(items);
  }

  // 单值 id 调用：必须完全兼容旧行为
  const singleId = targetIds[0];
  let res = await client.list(table, { id: singleId, limit: 1 });
  let hit = rowsOf(res).filter((r) => Number(r.id) === singleId)[0];
  let isFallback = false;

  // BUG-4: 若未显式指定 table，且 memories 表查无此 id，自动回退到 pitfalls 表查找
  if (!hit && !explicitTable) {
    const pitRes = await client.list("pitfalls", { id: singleId, limit: 1 });
    const pitHit = rowsOf(pitRes).filter((r) => Number(r.id) === singleId)[0];
    if (pitHit) {
      hit = pitHit;
      isFallback = true;
    }
  }

  if (!hit) throw new Error(`找不到 id=${singleId} 的${table === "pitfalls" ? "踩坑" : "记忆"}`);

  if (isFallback || table === "pitfalls") {
    return jsonOut(formatPitfallRecord(hit, isFallback));
  } else {
    const count = (Number(hit.retrieval_count) || 0) + 1;
    const fbApplied = await _applyHelpfulFeedback(client, "memories", singleId, hit, count, now, helpful);
    // 先落库（含 helpful 提权）再装配返回体，保证 count / confidence 与回显一致
    const rec = formatMemoryRecord(hit, count, now,
      await getSupersededHistory(hit));
    if (fbApplied) _applyFeedbackEcho(rec, hit, fbApplied);
    return jsonOut(rec);
  }
}

/* 软失效：不物理删除，写 invalid_at，保留审计链，支持 memories 与 pitfalls 跨表软失效与批量失效 */
