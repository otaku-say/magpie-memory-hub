/**
 * 模块职责：记忆全局审计去重（模型判定合并、批次游标管理与审计日志）
 * 依赖：src/core/**, src/domain/**, src/integration/**, local_state.js, online_models.js, semantic_dedup.js
 * 被依赖：src/services/audit/scheduler.js, src/tools/**, tools.js
 */

import { nowSql } from "../../core/config.js";
import { getDedupTimeWindow } from "../../core/time.js";
import { rowsOf, mergeCommaSeparated } from "../../integration/ncb.js";
import { jsonOut } from "../../domain/scoring.js";
import { memoryAuditUndo } from "./undo.js";
import { hasTagsIntersection } from "../../domain/validity.js";
import { writeCardStatus } from "../../core/status-writer.js";
import {
  lookupAuditState,
  rememberAuditState,
  getAuditCursor,
  saveAuditCursor,
  clearAuditCursor,
} from "../../core/state.js";
import { auditMemoriesWithModel } from "../../integration/provider-models.js";
import {
  normalizeSemanticText,
  isSemanticallySimilar,
  hasConflictingNumbers,
  tokenize,
  jaccardSimilarity,
} from "../../domain/semantic-dedup.js";

let _isAuditing = false;

export function resetIsAuditing() {
  _isAuditing = false;
}

/**
 * 全自动去重：单次模型调用判定并立即合并，分批支持全量与定时下推，绝不物理删
 */
export async function memoryAudit(client, cfg, args, ctx) {
  args = args || {};
  if (!client || typeof client !== "object" || typeof client.list !== "function") {
    return jsonOut({ action: "DEDUP_REPORT", success: false, data_changed: false,
      batch: "0/0", dedup_state: "skipped", note: "无可用数据库客户端，已跳过去重（不影响插件加载）" });
  }
  if (args && (args.undo === true || args.undo_before)) {
    return await memoryAuditUndo(client, cfg, args);
  }
  if (_isAuditing) {
    return jsonOut({
      action: "DEDUP_REPORT",
      success: true,
      data_changed: false,
      skipped: true,
      reason: "audit_in_progress",
      status: "跳过", // db-col-ok: 去重任务运行状态
      note: "去重任务正在执行中，已跳过并发重入请求",
    });
  }
  _isAuditing = true;

  try {
    const project = String(args.project || (cfg && cfg.project) || "global").trim();
    // 【v6.3.1 解耦】「DB 拉取批」与「模型分块」
    // a) dbFetchLimit：只管从数据库拉取多少条数据（默认 200，上限 1000）
    // 【P1-2】优先级：用户显式传 args.fetch_limit > 用户配置的 dedup_batch_size > dedup_fetch_limit > 200
    const explicitFetchLimit = args && (args.fetch_limit || args.limit || args.batch_size);
    const configuredUserBatchSize = (args && args.dedup_batch_size) || (cfg && (Number(cfg.dedup_batch_size) !== 50 ? cfg.dedup_batch_size : null));
    const configuredFetchLimit = (args && args.dedup_fetch_limit) || (cfg && cfg.dedup_fetch_limit);
    const dbFetchLimit = Math.max(1, Math.min(Number(
      explicitFetchLimit ||
      configuredUserBatchSize ||
      configuredFetchLimit ||
      (cfg && cfg.dedup_batch_size) ||
      200
    ), 1000));
    const maxModelBatches = Math.max(1, Math.min(Number(args.audit_max_batches || args.max_model_batches || args.max_batches || cfg.audit_max_batches || 2), 10));
    const batchTs = Date.now();
    const now = nowSql();

    const isIncremental = args.incremental === true;
    let cursor = isIncremental
      ? getAuditCursor(project)
      : { last_memory_id: null, last_pitfall_id: null, last_id: null, last_updated_at: "", reviewed_count: 0 };
    if (args.since_id != null && Number(args.since_id) > 0) {
      const sId = Number(args.since_id);
      cursor = { last_memory_id: sId, last_pitfall_id: sId, last_id: sId, last_updated_at: "", reviewed_count: 0 };
    }
    if (args.full === true) {
      clearAuditCursor(project);
      cursor = { last_memory_id: null, last_pitfall_id: null, last_id: null, last_updated_at: "", reviewed_count: 0 };
    }

  let timeFilter = null;
  if (args.updated_after && typeof args.updated_after === "string") {
    timeFilter = args.updated_after.trim();
  } else if (args.schedule) {
    timeFilter = getDedupTimeWindow(args.schedule);
  } else if (args.since_days && Number(args.since_days) > 0) {
    const d = new Date(Date.now() - Number(args.since_days) * 86400000);
    timeFilter = d.toISOString().slice(0, 19).replace("T", " ");
  }

  const auditState = lookupAuditState();
  let rollingLogs = Array.isArray(auditState.logs) ? [...auditState.logs] : [];

  let totalScannedMemories = 0;
  let totalDedupedMemories = 0;
  let totalScannedPitfalls = 0;
  let totalDedupedPitfalls = 0;

  // 【v6.4.6-B】冷记忆压缩累计量与矛盾预警收集器（helper 内部全 fail-open，绝不阻断去重主流程）
  const coldStats = { scanned: 0, compacted: 0, saved_chars: 0, ids: [] }, contradictions = [];
  const allDedupedMemIds = [];
  const allDedupedPitIds = [];

  // ==========================================
  // 分批处理 memories
  // ==========================================
  let memLastId = isIncremental && Number(cursor.last_memory_id ?? cursor.last_id) > 0 ? Number(cursor.last_memory_id ?? cursor.last_id) : null;
  let memBatchNum = 0;
  let memTruncated = false;
  while (true) {
    memBatchNum++;
    const q = {
      project,
      lifecycle_status: "active",
      invalid_at: null,
      limit: dbFetchLimit,
      order_by: "id ASC",
      columns: [
        "id", "project", "category", "scope_level", "client", "origin",
        "title", "content", "full_text", "tags", "confidence_score",
        "recurrence", "content_fingerprint", "updated_at", "lifecycle_status",
        "related_entities", "invalid_at", "expires_at"
      ],
    };
    if (memLastId) q.since_id = memLastId;
    if (timeFilter) q.updated_after = timeFilter;

    const rawRows = rowsOf(await client.list("memories", q));
    const rows = rawRows.filter((r) => r.lifecycle_status === "active" && !r.invalid_at);
    if (!rawRows.length) break;
    memLastId = rawRows[rawRows.length - 1].id;
    totalScannedMemories += rows.length;

    mergeColdStats(coldStats, await compactColdBatch(client, rows, now, batchTs, rollingLogs)); // 累加而非覆盖
    contradictions.push(...lintContradictions(rows));
    // b) 内存中全量规则级查重（指纹相同 / 归一化标题相同 / tags 交集）覆盖整批记录（BUG-461-1：瞬时控制行豁免，见顶层 isTransientControlRow）
    const batchDupIds = new Set();
    const groups = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      if (batchDupIds.has(a.id) || isTransientControlRow(a)) continue;
      const grp = [a];
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j];
        if (batchDupIds.has(b.id) || isTransientControlRow(b)) continue;
        if (hasConflictingNumbers(a.title, b.title)) continue;
        const contentA = a.content || a.full_text || "";
        const contentB = b.content || b.full_text || "";
        if (hasConflictingNumbers(contentA, contentB)) continue;
        const sameFp = a.content_fingerprint && b.content_fingerprint && a.content_fingerprint === b.content_fingerprint;
        const normTitleA = normalizeSemanticText(a.title);
        const normTitleB = normalizeSemanticText(b.title);
        const sameTitle = normTitleA && normTitleB && normTitleA === normTitleB && !hasConflictingNumbers(a.title, b.title) && !hasConflictingNumbers(contentA, contentB);
        const similar = isSemanticallySimilar(a.title, a.content || a.full_text, b.title, b.content || b.full_text);
        const tagIntersect = hasTagsIntersection(a.tags, b.tags);
        const titleOverlap = Boolean(normTitleA && normTitleB && (normTitleA.includes(normTitleB) || normTitleB.includes(normTitleA)));
        if (sameFp || sameTitle || similar || (tagIntersect && titleOverlap && !hasConflictingNumbers(a.title, b.title) && !hasConflictingNumbers(contentA, contentB))) {
          grp.push(b);
          batchDupIds.add(b.id);
        }
      }
      if (grp.length > 1) {
        batchDupIds.add(a.id);
        // 【P1-3】若组内存在 category === "principle"，必须强制选它为 primary，绝不允许 principle 被当作 duplicate 软失效
        grp.sort((x, y) => {
          const xIsPrinciple = x.category === "principle" ? 1 : 0;
          const yIsPrinciple = y.category === "principle" ? 1 : 0;
          if (xIsPrinciple !== yIsPrinciple) return yIsPrinciple - xIsPrinciple;
          return (Number(y.recurrence) || 1) - (Number(x.recurrence) || 1) || (new Date(y.updated_at) - new Date(x.updated_at));
        });
        groups.push({ primary: grp[0], duplicates: grp.slice(1) });
      }
    }

    // c) 模型仲裁：groups.length === 0 时不要直接跳过模型仲裁，仍应把整批交给 auditMemoriesWithModel 做一轮语义仲裁（受 maxModelBatches 预算约束）
    const auditOptions = Object.assign({}, cfg, args);
    const auditModel = String(auditOptions.audit_model || auditOptions.extract_model || "").trim();
    if (auditModel && auditModel !== "off" && auditModel !== "none" && rows.length > 1) {
      const candidateItemMap = new Map();
      let candidateList = [];
      for (const g of groups) {
        candidateItemMap.set(g.primary.id, g.primary);
        for (const d of g.duplicates) candidateItemMap.set(d.id, d);
      }
      // 【P1-2 a】未分组行也要按 chunk 送模型（预算仍受 maxModelBatches 约束）；【BUG-461-1】瞬时行同样不得进入模型仲裁候选集
      for (const r of rows) {
        if (!isTransientControlRow(r) && !candidateItemMap.has(r.id)) candidateItemMap.set(r.id, r);
      }
      candidateList = Array.from(candidateItemMap.values());

      // 【P1-2】MODEL_CHUNK 增加 [5, 60] 范围守卫并锚定 audit_chunk_size
      const rawChunk = Number(auditOptions.audit_chunk_size ?? cfg.audit_chunk_size ?? 40);
        // 【时间预算】单次 memory_audit 的最坏耗时估算：
  // 2 次模型调用 × 15s = 30s < 55s（MCP 客户端硬超时），安全余量 25s。
  // 新增任何模型调用时必须重算此预算，绝不允许突破 55s。
const MODEL_CHUNK = Math.max(5, Math.min(Number.isFinite(rawChunk) ? rawChunk : 40, 60));
      const modelBudgetItems = maxModelBatches * MODEL_CHUNK;
      const forModel = candidateList.slice(0, modelBudgetItems);

      try {
        const modelRes = await auditMemoriesWithModel({ memories: forModel, pitfalls: [], options: auditOptions });
        if (modelRes && modelRes.result) {
          const mr = modelRes.result;
          const mDups = Array.isArray(mr.memory_duplicates)
            ? mr.memory_duplicates
            : (Array.isArray(mr.duplicate_groups) ? mr.duplicate_groups : []);
          if (mDups.length > 0) {
            // 【P1-2 b】remainingGroups 只剔除「已被模型明确处理过的 id」，不要把整组无条件丢弃
            // 【P1-1a】先用数字守卫预过滤模型幻觉组，只有「仍然有效」的组才记账。
            // 反例：模型把 3306 合进 3307 被守卫拒绝，但 3306 已被记为 handled，
            // 导致 3306 自身的精确重复组被拆毁 → 永久漏删。
            const validMDups = [];
            for (const dg of mDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              if (!pId || dIds.length === 0) continue;
              const pItemPre = rows.find((r) => r.id === pId) || candidateItemMap.get(pId);
              // 【P2-1a】模型可能捏造当前批次根本不存在的主记录 ID：此时绝不能放行该组，
              // 否则会把它记入 modelHandledIds，导致同 ID 的真实规则组被误判为「已处理」而拆毁。
              if (!pItemPre) {
                rollingLogs.push(`[${nowSql()}] 模型组主记录 ${pId} 不存在于本批次，已忽略（疑似幻觉）`);
                continue;
              }
              const pTitlePre = pItemPre.title || "";
              const pContentPre = pItemPre.content || pItemPre.full_text || "";
              // 【P1-1b】严格分字段校验（标题对标题、正文对正文），禁止跨字段拼接
              const keptDIds = dIds.filter((dId) => {
                if (dId === pId) return false;
                const dItemPre = rows.find((r) => r.id === dId) || candidateItemMap.get(dId);
                // 【P2-1b】模型捏造不存在的从记录 ID：剔除，不得计入 validMDups
                if (!dItemPre) return false;
                const dTitlePre = dItemPre.title || "";
                const dContentPre = dItemPre.content || dItemPre.full_text || "";
                return !hasConflictingNumbers(pTitlePre, dTitlePre)
                  && !hasConflictingNumbers(pContentPre, dContentPre);
              });
              if (keptDIds.length > 0) {
                validMDups.push({ primary_id: pId, duplicate_ids: keptDIds });
              } else {
                rollingLogs.push(`[${nowSql()}] 模型组被数字守卫拒绝（主记录 ${pId}），保留原规则组`);
              }
            }

            const modelHandledIds = new Set();
            for (const dg of validMDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              modelHandledIds.add(pId);
              for (const dId of dIds) {
                if (dId !== pId) modelHandledIds.add(dId);
              }
            }

            const remainingGroups = [];
            const orphanedDupsByPrimary = new Map();
            for (const g of groups) {
              if (modelHandledIds.has(g.primary.id)) {
                const unhandledDups = g.duplicates.filter((d) => !modelHandledIds.has(d.id));
                if (unhandledDups.length > 1) {
                  remainingGroups.push({ primary: unhandledDups[0], duplicates: unhandledDups.slice(1) });
                } else if (unhandledDups.length === 1) {
                  // 【P1-3 a】单条精确重复暂存，挂入主记录所属的模型组一起合并，杜绝漏删
                  const list = orphanedDupsByPrimary.get(g.primary.id) || [];
                  list.push(unhandledDups[0]);
                  orphanedDupsByPrimary.set(g.primary.id, list);
                }
              } else {
                const unhandledDups = g.duplicates.filter((d) => !modelHandledIds.has(d.id));
                if (unhandledDups.length > 0) {
                  remainingGroups.push({ primary: g.primary, duplicates: unhandledDups });
                }
              }
            }

            // 【P1-2 c】每处理一组就把 pId 也加入 modelDupIds，杜绝跨组主从互指
            const modelDupIds = new Set();
            for (const rg of remainingGroups) {
              modelDupIds.add(rg.primary.id);
              for (const d of rg.duplicates) modelDupIds.add(d.id);
            }

            const attachedOrphanIds = new Set();
            for (const dg of validMDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              if (pId && dIds.length > 0 && !modelDupIds.has(pId)) {
                let pItem = rows.find((r) => r.id === pId) || candidateItemMap.get(pId);
                const dItems = (forModel.length ? forModel : rows).filter(
                  (r) => dIds.includes(r.id) && r.id !== pId && !modelDupIds.has(r.id)
                );
                for (const dId of dIds) {
                  if (dId !== pId && !modelDupIds.has(dId) && !dItems.some((r) => r.id === dId)) {
                    const fallbackItem = rows.find((r) => r.id === dId) || candidateItemMap.get(dId);
                    if (fallbackItem) dItems.push(fallbackItem);
                  }
                }

                // 【P1-3 a】把主记录所属的孤儿精确重复副本挂入当前模型组
                const candidatePrimaryIds = [pId, ...dItems.map((d) => d.id)];
                for (const candId of candidatePrimaryIds) {
                  const orphans = orphanedDupsByPrimary.get(candId);
                  if (orphans && orphans.length > 0) {
                    for (const orphan of orphans) {
                      if (!modelDupIds.has(orphan.id) && !dItems.some((d) => d.id === orphan.id) && orphan.id !== pId) {
                        dItems.push(orphan);
                        attachedOrphanIds.add(orphan.id);
                      }
                    }
                  }
                }

                // 【P1-3】组内存在 principle 时强制将其选为 primary
                if (pItem && pItem.category !== "principle") {
                  const princIdx = dItems.findIndex((d) => d.category === "principle");
                  if (princIdx >= 0) {
                    const princItem = dItems[princIdx];
                    dItems.splice(princIdx, 1, pItem);
                    pItem = princItem;
                  }
                }

                // 【P1-3 b】模型合并结果必须经过数字守卫校验，冲突则跳过合并
                const validDItems = [];
                if (pItem) {
                  const pTitle = pItem.title || "";
                  const pContent = pItem.content || pItem.full_text || "";

                  // 【P1-1b】严格分字段校验，删除跨字段拼接 pAllText/dAllText：
                  // 拼接后「方案多了『重试 3 次』」会让数字集合大小不同而被误判冲突
                  for (const d of dItems) {
                    const dTitle = d.title || "";
                    const dContent = d.content || d.full_text || "";

                    const hasNumConflict =
                      hasConflictingNumbers(pTitle, dTitle) ||
                      hasConflictingNumbers(pContent, dContent);

                    if (hasNumConflict) {
                      continue;
                    }
                    validDItems.push(d);
                  }
                }

                if (pItem && validDItems.length > 0) {
                  modelDupIds.add(pItem.id);
                  for (const d of validDItems) modelDupIds.add(d.id);
                  remainingGroups.push({ primary: pItem, duplicates: validDItems });
                }
              }
            }

            // 若有未挂载到任何模型组的孤儿精确重复，安全回退合并
            for (const [primId, orphans] of orphanedDupsByPrimary.entries()) {
              const unattached = orphans.filter((o) => !attachedOrphanIds.has(o.id) && !modelDupIds.has(o.id));
              if (unattached.length > 0) {
                const primItem = rows.find((r) => r.id === primId) || candidateItemMap.get(primId);
                if (primItem && !modelDupIds.has(primItem.id)) {
                  remainingGroups.push({ primary: primItem, duplicates: unattached });
                  modelDupIds.add(primItem.id);
                  for (const u of unattached) modelDupIds.add(u.id);
                } else if (unattached.length > 1) {
                  remainingGroups.push({ primary: unattached[0], duplicates: unattached.slice(1) });
                }
              }
            }

            groups.length = 0;
            groups.push(...remainingGroups);
          }
        }
      } catch (err) {
        rollingLogs.push(`[${nowSql()}] 模型不可用或超预算，安全跳过在线模型并使用规则查重: ${(err && err.message) || err}`);
      }
    }

    for (const g of groups) {
      const p = g.primary;
      const dups = g.duplicates;
      for (const d of dups) {
        if (!d || d.id === p.id) continue; // 双保险：杜绝自删/自失效主记录
        if (d.category === "principle") continue; // 准则保护：绝不软失效准则
        try {
          await client.update("memories", d.id, {
            invalid_at: now,
            lifecycle_status: "invalid",
            invalid_reason: `dedup:${batchTs}:into:${p.id}`,
            updated_at: now,
          });
          totalDedupedMemories++;
          allDedupedMemIds.push(d.id);
        } catch (_) {}
      }
      try {
        const validDups = dups.filter((d) => d && d.id !== p.id && d.category !== "principle");
        const dupRecurrenceSum = validDups.reduce((acc, d) => acc + (Number(d.recurrence) || 1), 0);
        const nextRec = (Number(p.recurrence) || 1) + dupRecurrenceSum;
        const mergedTags = mergeCommaSeparated(p.tags, ...validDups.map((d) => d.tags));
        const mergedEntities = mergeCommaSeparated(p.related_entities, ...validDups.map((d) => d.related_entities));
        await client.update("memories", p.id, {
          recurrence: nextRec,
          updated_at: now,
          ...(mergedTags ? { tags: mergedTags } : {}),
          ...(mergedEntities ? { related_entities: mergedEntities.slice(0, 500) } : {}),
        });
      } catch (_) {}
    }

    const batchDedupCount = groups.reduce((acc, g) => acc + g.duplicates.length, 0);
    rollingLogs.push(`[${nowSql()}] 记忆批次 ${memBatchNum} 完成：扫描 ${rows.length} 条，合并 ${batchDedupCount} 条`);
    if (rollingLogs.length > 30) rollingLogs = rollingLogs.slice(-30);

    try {
      writeCardStatus("audit", {
        ok: true,
        at: Date.now(),
        op: "memory_audit",
        title: "全自动去重进行中...",
        batch: `${memBatchNum}/-`,
        status: "进行中", // db-col-ok: 去重任务运行状态
        scanned: { memories: totalScannedMemories, pitfalls: totalScannedPitfalls },
        deduped: { memories: totalDedupedMemories, pitfalls: totalDedupedPitfalls },
        lines: [
          `扫描记忆: ${totalScannedMemories} 条 · 去重合并: ${totalDedupedMemories} 条`,
          `扫描踩坑: ${totalScannedPitfalls} 条 · 去重合并: ${totalDedupedPitfalls} 条`,
          `批次: ${memBatchNum}/-  ·  状态: 进行中`
        ],
        logs: rollingLogs,
      });
    } catch (_) {}

    if (rawRows.length < dbFetchLimit) break;
    memTruncated = true;
    break;
  }

  // 分批处理 pitfalls
  // ==========================================
  let pitLastId = isIncremental && Number(cursor.last_pitfall_id ?? cursor.last_id) > 0 ? Number(cursor.last_pitfall_id ?? cursor.last_id) : null;
  let pitBatchNum = 0;
  let pitTruncated = false;
  while (true) {
    pitBatchNum++;
    const q = {
      project,
      invalid_at: null,
      limit: dbFetchLimit,
      order_by: "id ASC",
    };
    if (pitLastId) q.since_id = pitLastId;
    if (timeFilter) q.updated_after = timeFilter;

    const rawRows = rowsOf(await client.list("pitfalls", q));
    const rows = rawRows.filter((r) => !r.invalid_at);
    if (!rawRows.length) break;
    pitLastId = rawRows[rawRows.length - 1].id;
    totalScannedPitfalls += rows.length;

    // b) 内存中全量规则级查重覆盖整批记录
    const batchDupIds = new Set();
    const groups = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      if (batchDupIds.has(a.id)) continue;
      const grp = [a];
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j];
        if (batchDupIds.has(b.id)) continue;
        // 【P1-1b】规则层同样必须分字段独立校验：
        // 拼接后「方案多了『重试 3 次』」会让数字集合大小不同而被误判冲突
        if (hasConflictingNumbers(a.symptom || "", b.symptom || "")) continue;
        if (hasConflictingNumbers(a.solution || "", b.solution || "")) continue;
        if (hasConflictingNumbers(a.root_cause || "", b.root_cause || "")) continue;
        const sameFp = a.content_fingerprint && b.content_fingerprint && a.content_fingerprint === b.content_fingerprint;
        const normSymA = normalizeSemanticText(a.symptom);
        const normSymB = normalizeSemanticText(b.symptom);
        const sameSym = normSymA && normSymB && normSymA === normSymB;
        const similar = isSemanticallySimilar(a.symptom, a.solution || a.root_cause, b.symptom, b.solution || b.root_cause);
        const tagIntersect = hasTagsIntersection(a.tags, b.tags);
        const symOverlap = Boolean(normSymA && normSymB && (normSymA.includes(normSymB) || normSymB.includes(normSymA)));
        if (sameFp || sameSym || similar || (tagIntersect && symOverlap)) {
          grp.push(b);
          batchDupIds.add(b.id);
        }
      }
      if (grp.length > 1) {
        batchDupIds.add(a.id);
        grp.sort((x, y) => (Number(y.recurrence) || 1) - (Number(x.recurrence) || 1) || (new Date(y.updated_at) - new Date(x.updated_at)));
        groups.push({ primary: grp[0], duplicates: grp.slice(1) });
      }
    }

    // c) 只把规则筛出的候选组交给 auditMemoriesWithModel 做模型仲裁（groups.length===0 时也不跳过，整批提交受预算约束）
    const auditOptions = Object.assign({}, cfg, args);
    const auditModel = String(auditOptions.audit_model || auditOptions.extract_model || "").trim();
    if (auditModel && auditModel !== "off" && auditModel !== "none" && rows.length > 1) {
      const candidateItemMap = new Map();
      let candidateList = [];
      for (const g of groups) {
        candidateItemMap.set(g.primary.id, g.primary);
        for (const d of g.duplicates) candidateItemMap.set(d.id, d);
      }
      // 【P1-2 a】未分组行也要按 chunk 送模型（预算仍受 maxModelBatches 约束）
      for (const r of rows) {
        if (!candidateItemMap.has(r.id)) {
          candidateItemMap.set(r.id, r);
        }
      }
      candidateList = Array.from(candidateItemMap.values());

      // 【P1-2】MODEL_CHUNK 增加 [5, 60] 范围守卫并锚定 audit_chunk_size
      const rawChunk = Number(auditOptions.audit_chunk_size ?? cfg.audit_chunk_size ?? 40);
      const MODEL_CHUNK = Math.max(5, Math.min(Number.isFinite(rawChunk) ? rawChunk : 40, 60));
      const modelBudgetItems = maxModelBatches * MODEL_CHUNK;
      const forModel = candidateList.slice(0, modelBudgetItems);

      try {
        const modelRes = await auditMemoriesWithModel({ memories: [], pitfalls: forModel, options: auditOptions });
        if (modelRes && modelRes.result) {
          const mr = modelRes.result;
          const pDups = Array.isArray(mr.pitfall_duplicates) ? mr.pitfall_duplicates : [];
          if (pDups.length > 0) {
            // 【P1-2 b】remainingGroups 只剔除「已被模型明确处理过的 id」，不要把整组无条件丢弃
            // 【P1-1a】同 memories：先校验后记账，被守卫拒绝的组不得抢先标记
            const validPDups = [];
            for (const dg of pDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              if (!pId || dIds.length === 0) continue;
              const pItemPre = rows.find((r) => r.id === pId) || candidateItemMap.get(pId);
              // 【P2-1c】同 memories：捏造的主记录 ID 必须丢弃，避免误拆真实规则组
              if (!pItemPre) {
                rollingLogs.push(`[${nowSql()}] 模型踩坑组主记录 ${pId} 不存在于本批次，已忽略（疑似幻觉）`);
                continue;
              }
              const pSymPre = pItemPre.symptom || "";
              const pSolPre = pItemPre.solution || "";
              const pRootPre = pItemPre.root_cause || "";
              // 【P1-1b】分字段独立校验：症状对症状、方案对方案、根因对根因
              const keptDIds = dIds.filter((dId) => {
                if (dId === pId) return false;
                const dItemPre = rows.find((r) => r.id === dId) || candidateItemMap.get(dId);
                // 【P2-1d】模型捏造不存在的从记录 ID：剔除
                if (!dItemPre) return false;
                return !hasConflictingNumbers(pSymPre, dItemPre.symptom || "")
                  && !hasConflictingNumbers(pSolPre, dItemPre.solution || "")
                  && !hasConflictingNumbers(pRootPre, dItemPre.root_cause || "");
              });
              if (keptDIds.length > 0) {
                validPDups.push({ primary_id: pId, duplicate_ids: keptDIds });
              } else {
                rollingLogs.push(`[${nowSql()}] 模型踩坑组被数字守卫拒绝（主记录 ${pId}），保留原规则组`);
              }
            }

            const modelHandledIds = new Set();
            for (const dg of validPDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              modelHandledIds.add(pId);
              for (const dId of dIds) {
                if (dId !== pId) modelHandledIds.add(dId);
              }
            }

            const remainingGroups = [];
            const orphanedDupsByPrimary = new Map();
            for (const g of groups) {
              if (modelHandledIds.has(g.primary.id)) {
                const unhandledDups = g.duplicates.filter((d) => !modelHandledIds.has(d.id));
                if (unhandledDups.length > 1) {
                  remainingGroups.push({ primary: unhandledDups[0], duplicates: unhandledDups.slice(1) });
                } else if (unhandledDups.length === 1) {
                  // 【P1-3 a】单条精确重复暂存，挂入主记录所属的模型组一起合并，杜绝漏删
                  const list = orphanedDupsByPrimary.get(g.primary.id) || [];
                  list.push(unhandledDups[0]);
                  orphanedDupsByPrimary.set(g.primary.id, list);
                }
              } else {
                const unhandledDups = g.duplicates.filter((d) => !modelHandledIds.has(d.id));
                if (unhandledDups.length > 0) {
                  remainingGroups.push({ primary: g.primary, duplicates: unhandledDups });
                }
              }
            }

            // 【P1-2 c】每处理一组就把 pId 也加入 modelDupIds，杜绝跨组主从互指
            const modelDupIds = new Set();
            for (const rg of remainingGroups) {
              modelDupIds.add(rg.primary.id);
              for (const d of rg.duplicates) modelDupIds.add(d.id);
            }

            const attachedOrphanIds = new Set();
            for (const dg of validPDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              if (pId && dIds.length > 0 && !modelDupIds.has(pId)) {
                let pItem = rows.find((r) => r.id === pId) || candidateItemMap.get(pId);
                const dItems = (forModel.length ? forModel : rows).filter(
                  (r) => dIds.includes(r.id) && r.id !== pId && !modelDupIds.has(r.id)
                );
                for (const dId of dIds) {
                  if (dId !== pId && !modelDupIds.has(dId) && !dItems.some((r) => r.id === dId)) {
                    const fallbackItem = rows.find((r) => r.id === dId) || candidateItemMap.get(dId);
                    if (fallbackItem) dItems.push(fallbackItem);
                  }
                }

                // 【P1-3 a】把主记录所属的孤儿精确重复副本挂入当前模型组
                const candidatePrimaryIds = [pId, ...dItems.map((d) => d.id)];
                for (const candId of candidatePrimaryIds) {
                  const orphans = orphanedDupsByPrimary.get(candId);
                  if (orphans && orphans.length > 0) {
                    for (const orphan of orphans) {
                      if (!modelDupIds.has(orphan.id) && !dItems.some((d) => d.id === orphan.id) && orphan.id !== pId) {
                        dItems.push(orphan);
                        attachedOrphanIds.add(orphan.id);
                      }
                    }
                  }
                }

                // 【P1-3 b】模型合并结果必须经过数字守卫校验，冲突则跳过合并
                const validDItems = [];
                if (pItem) {
                  const pSym = pItem.symptom || "";
                  const pSol = pItem.solution || "";
                  const pRoot = pItem.root_cause || "";

                  // 【P1-1b】分字段独立校验，删除跨字段拼接 pText/dText
                  for (const d of dItems) {
                    const hasNumConflict =
                      hasConflictingNumbers(pSym, d.symptom || "") ||
                      hasConflictingNumbers(pSol, d.solution || "") ||
                      hasConflictingNumbers(pRoot, d.root_cause || "");

                    if (hasNumConflict) {
                      continue;
                    }
                    validDItems.push(d);
                  }
                }

                if (pItem && validDItems.length > 0) {
                  modelDupIds.add(pItem.id);
                  for (const d of validDItems) modelDupIds.add(d.id);
                  remainingGroups.push({ primary: pItem, duplicates: validDItems });
                }
              }
            }

            // 若有未挂载到任何模型组的孤儿精确重复，安全回退合并
            for (const [primId, orphans] of orphanedDupsByPrimary.entries()) {
              const unattached = orphans.filter((o) => !attachedOrphanIds.has(o.id) && !modelDupIds.has(o.id));
              if (unattached.length > 0) {
                const primItem = rows.find((r) => r.id === primId) || candidateItemMap.get(primId);
                if (primItem && !modelDupIds.has(primItem.id)) {
                  remainingGroups.push({ primary: primItem, duplicates: unattached });
                  modelDupIds.add(primItem.id);
                  for (const u of unattached) modelDupIds.add(u.id);
                } else if (unattached.length > 1) {
                  remainingGroups.push({ primary: unattached[0], duplicates: unattached.slice(1) });
                }
              }
            }

            groups.length = 0;
            groups.push(...remainingGroups);
          }
        }
      } catch (err) {
        rollingLogs.push(`[${nowSql()}] 模型不可用或超预算，安全跳过在线模型并使用规则查重: ${(err && err.message) || err}`);
      }
    }

    for (const g of groups) {
      const p = g.primary;
      const dups = g.duplicates;
      for (const d of dups) {
        if (!d || d.id === p.id) continue; // 双保险：对 pitfalls remove/update 前再断言 d.id !== pId，绝不自删主记录
        try {
          await client.update("pitfalls", d.id, {
            invalid_at: now,
            invalid_reason: `dedup:${batchTs}:into:${p.id}`,
            updated_at: now,
          });
          totalDedupedPitfalls++;
          allDedupedPitIds.push(d.id);
        } catch (_) {}
      }
      try {
        const validDups = dups.filter((d) => d && d.id !== p.id);
        const dupRecurrenceSum = validDups.reduce((acc, d) => acc + (Number(d.recurrence) || 1), 0);
        const nextRec = (Number(p.recurrence) || 1) + dupRecurrenceSum;
        const mergedTags = mergeCommaSeparated(p.tags, ...validDups.map((d) => d.tags));
        await client.update("pitfalls", p.id, {
          recurrence: nextRec,
          updated_at: now,
          ...(mergedTags ? { tags: mergedTags } : {}),
        });
      } catch (_) {}
    }

    const batchDedupCount = groups.reduce((acc, g) => acc + g.duplicates.length, 0);
    rollingLogs.push(`[${nowSql()}] 踩坑批次 ${pitBatchNum} 完成：扫描 ${rows.length} 条，合并 ${batchDedupCount} 条`);
    if (rollingLogs.length > 30) rollingLogs = rollingLogs.slice(-30);

    try {
      writeCardStatus("audit", {
        ok: true,
        at: Date.now(),
        op: "memory_audit",
        title: "全自动去重进行中...",
        batch: `${memBatchNum + pitBatchNum}/-`,
        status: "进行中", // db-col-ok: 去重任务运行状态
        scanned: { memories: totalScannedMemories, pitfalls: totalScannedPitfalls },
        deduped: { memories: totalDedupedMemories, pitfalls: totalDedupedPitfalls },
        lines: [
          `扫描记忆: ${totalScannedMemories} 条 · 去重合并: ${totalDedupedMemories} 条`,
          `扫描踩坑: ${totalScannedPitfalls} 条 · 去重合并: ${totalDedupedPitfalls} 条`,
          `批次: ${memBatchNum + pitBatchNum}/-  ·  状态: 进行中`
        ],
        logs: rollingLogs,
      });
    } catch (_) {}

    if (rawRows.length < dbFetchLimit) break;
    pitTruncated = true;
    break;
  }

  const truncated = memTruncated || pitTruncated;
  const totalBatches = Math.max(1, memBatchNum + pitBatchNum);
  const totalDeduped = totalDedupedMemories + totalDedupedPitfalls;

  rollingLogs.push(`[${nowSql()}] 全自动去重已完成：记忆扫描 ${totalScannedMemories} 合并 ${totalDedupedMemories}，踩坑扫描 ${totalScannedPitfalls} 合并 ${totalDedupedPitfalls}`);
  if (rollingLogs.length > 30) rollingLogs = rollingLogs.slice(-30);

  rememberAuditState({
    last_audit_at: nowSql(),
    last_dedup_at: truncated ? (auditState.last_dedup_at || null) : nowSql(),
    last_dedup_pending: Boolean(truncated),
    last_dedup_batch_ts: batchTs,
    last_dedup_count: totalDeduped,
    last_dedup_ids: { memories: allDedupedMemIds, pitfalls: allDedupedPitIds },
    scanned: { memories: totalScannedMemories, pitfalls: totalScannedPitfalls },
    deduped: { memories: totalDedupedMemories, pitfalls: totalDedupedPitfalls },
    logs: rollingLogs,
  });

  const finalLines = [
    `扫描记忆: ${totalScannedMemories} 条 · 去重合并: ${totalDedupedMemories} 条`,
    `扫描踩坑: ${totalScannedPitfalls} 条 · 去重合并: ${totalDedupedPitfalls} 条`,
    truncated
      ? `批次: ${totalBatches} 批（本次预算 ${dbFetchLimit} 条）· 状态: 本轮完成，仍有剩余`
      : `批次: ${totalBatches}/${totalBatches}  ·  状态: 已完成`
  ];

  try {
    writeCardStatus("audit", {
      ok: true,
      at: Date.now(),
      op: "memory_audit",
      title: "全自动去重完成",
      batch: `${totalBatches}/${totalBatches}`,
      status: "已完成", // db-col-ok: 去重任务运行状态
      scanned: { memories: totalScannedMemories, pitfalls: totalScannedPitfalls },
      deduped: { memories: totalDedupedMemories, pitfalls: totalDedupedPitfalls },
      lines: finalLines,
      logs: rollingLogs,
    });
  } catch (_) {}

    const newMemLastId = memLastId || cursor.last_memory_id || null;
    const newPitLastId = pitLastId || cursor.last_pitfall_id || null;
    const maxIdSeen = Math.max(Number(newMemLastId) || 0, Number(newPitLastId) || 0, Number(cursor.last_id) || 0) || null;
    // 【P1-2】full:true 扫满 fetch_limit 截断退出时，必须保存游标（不能只在 isIncremental 时保存）
    if (isIncremental || truncated) {
      saveAuditCursor(project, {
        last_memory_id: newMemLastId,
        last_pitfall_id: newPitLastId,
        last_id: maxIdSeen,
        last_updated_at: nowSql(),
      });
    }

    return jsonOut({
      action: "DEDUP_REPORT",
      success: true,
      data_changed: totalDeduped > 0,
      batch: `${totalBatches}/${totalBatches}`,
      status: truncated ? "部分完成" : "已完成", // db-col-ok: 去重任务运行状态
      has_more: truncated,
      next_action: truncated
        ? "本轮已达单次拉取批上限（防 55s 超时），游标已保存。请再次调用 memory_audit（incremental: true）继续；或等待定时调度器每 5 分钟自动接力。"
        : "",
      incremental: isIncremental,
      cursor: {
        previous_last_memory_id: cursor.last_memory_id || null,
        previous_last_pitfall_id: cursor.last_pitfall_id || null,
        current_last_memory_id: newMemLastId,
        current_last_pitfall_id: newPitLastId,
        previous_last_id: Number(cursor.last_id) || 0,
        current_last_id: Number(maxIdSeen) || 0,
        batch_size: dbFetchLimit,
      },
      scanned: {
        memories: totalScannedMemories,
        pitfalls: totalScannedPitfalls,
      },
      deduped: {
        memories: totalDedupedMemories,
        pitfalls: totalDedupedPitfalls,
      },
      lines: finalLines,
      logs: rollingLogs,
      contradictions, cold_compaction: coldStats,
      note: `全自动去重完成。扫描记忆 ${totalScannedMemories} 条，合并 ${totalDedupedMemories} 条；扫描踩坑 ${totalScannedPitfalls} 条，合并 ${totalDedupedPitfalls} 条。`,
    });
  } finally {
    _isAuditing = false;
  }
}

/* ================================================================== *
 * 【v6.4.6-B】零 LLM 冷记忆抽取式压缩 (Extractive Cold Compaction)
 * ------------------------------------------------------------------
 * 设计铁律：
 *   1. 绝不调用模型 —— 全确定性正则，可安稳跑在 55s MCP 硬超时预算内；
 *   2. 绝不丢原文 —— 首次压缩把 content 原样搬进 full_text，之后只替换 content；
 *   3. 绝不重复压缩 —— tags 里的 "compacted" 是唯一幂等门，也是唯一判定依据；
 *   4. 绝不阻断主流程 —— 单条写库失败只落日志，去重照常完成（fail-open）。
 * 接口契约（对外仅两个导出）：
 *   compactColdContent(content) -> { text, summary, tokens, original_length, saved_length, saved_ratio }
 *   compactColdMemories(client, { project, limit }) -> { scanned, compacted, saved_chars, ids }
 * ================================================================== */

const COLD_DAYS = 60;          // 冷记忆判定：距 updated_at / last_used_at 均超过 60 天
const COLD_MIN_CHARS = 240;    // 参与压缩的最小正文字符数
const SUMMARY_MAX = 120;       // 首句摘要上限（字）
const KEEP_RATIO = 0.35;       // 浓缩正文预算：原文 35%，即恒定节省 ≥60% 字符
const TOKEN_MAX_ITEMS = 12;    // 关键 Token 条数上限
const CONTRADICTION_MAX = 20;  // 单次审计矛盾预警上限
const COLD_MAX_PER_RUN = 20;   // 单批压缩条数上限：防止审计把 55s MCP 超时预算耗在压缩上
const RULE_CATEGORIES = new Set(["principle", "preference", "decision"]); // 规范性规则分类

// 逐个正则只抓「丢了就再也找不回来」的硬信息：URL / 文件路径 / 代码 / 错误码 / 端口 / 配置键值
const TOKEN_PATTERNS = [
  /https?:\/\/[^\s"'<>，。；、）]+/g,
  /(?:[A-Za-z]:\\[^\s"'，。；、）]+|(?:[\w.@-]+\/)+[\w.@-]+\.(?:js|mjs|cjs|ts|tsx|py|json|md|html|css|sh|ya?ml|sql|db|log|txt|ini|conf))/g,
  /`[^`\n]{1,80}`/g,
  /\b(?:ERR(?:OR)?_[A-Z0-9_]{2,}|E[A-Z]{2,}\d{2,}|[A-Z]{2,}[_-]\d{2,}|0x[0-9a-fA-F]{4,}|HTTP\s?[1-5]\d{2})\b/g,
  /(?:端口|listen|port|PORT)\s*[:=：]?\s*\d{2,5}\b|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\s*:\s*\d{2,5}\b/g,
  /\b[a-z][a-z0-9_.]{2,}(?:_KEY|_ID|_URL|_NAME|_HOST|_PORT|_TIMEOUT|_LIMIT|_SIZE|_DIR|_PATH|_TOKEN|_MODE|_ENV|_TTL|_COUNT|_MAX|_MIN)?\s*[=:：]\s*"?[-\w./:@]{1,40}"?/g,
];

/** 时间戳解析：无法解析一律返回 0（绝不把「不认识的时间」当成「刚刚访问过」） */
/**
 * 【BUG-461-1】未消费瞬时控制行判定：tags 含 handoff:open 或 mail:unread。
 * 这类行生命周期极短（消费/认领后即转 invalid），但"同标题多封"是合法形态——
 * 不同 Agent 先后投递的同主题通知信 / 新旧交接棒，一旦被周期去重判重软失效，
 * 接收方在消费前就会永久丢失第二封（静默吞没）。因此规则查重与模型仲裁
 * 候选集构建必须整层跳过它们。
 */
function isTransientControlRow(r) {
  return /\b(?:handoff:open|mail:unread)\b/i.test(String((r && r.tags) || ""));
}

function parseStamp(v) {
  if (!v) return 0;
  const ms = Date.parse(String(v).replace(" ", "T"));
  return Number.isFinite(ms) ? ms : 0;
}

/** tags 归一化为去重后的数组（兼容中英文逗号、分号、竖线与空白分隔） */
function tagsOf(row) {
  return String((row && row.tags) || "")
    .split(/[,;|，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 首句摘要：取首句；首句不足 40 字时向后补齐，整体不超过 SUMMARY_MAX */
function firstSentenceOf(text) {
  const parts = String(text || "").split(/(?<=[。！？!?；;.\n])\s*/).filter(Boolean);
  let out = "";
  for (const p of parts) {
    out += p;
    if (out.length >= 40) break;
  }
  return out.slice(0, SUMMARY_MAX);
}

/** 正则抽取关键 Token：各类别轮转取用（保证 URL / 路径 / 错误码 / 端口 / 配置都有机会入选）、
 *  去重、限条数，并严格受字符预算约束，避免把正文又撑回去 */
function extractKeyTokens(text, budget) {
  const out = [];
  if (budget <= 0) return out;
  const buckets = TOKEN_PATTERNS.map((re) => {
    re.lastIndex = 0;
    const seen = [];
    for (const m of String(text).matchAll(re)) {
      const tok = String(m[0]).trim().slice(0, 80);
      if (tok && !seen.includes(tok)) seen.push(tok);
    }
    return seen;
  });
  const maxLen = Math.max(0, ...buckets.map((b) => b.length));
  let used = 0;
  for (let round = 0; round < maxLen; round++) {
    for (const bucket of buckets) {
      const tok = bucket[round];
      if (!tok || out.includes(tok)) continue;
      if (out.length >= TOKEN_MAX_ITEMS || used + tok.length + 3 > budget) return out;
      out.push(tok);
      used += tok.length + 3;
    }
  }
  return out;
}

/**
 * 纯正则抽取式压缩（零 LLM）：首句摘要 + 关键 Token，恒定节省 ≥60% 字符。
 * 契约：对任何输入都不抛错、不返回 null；空输入返回全零结果。
 */
export function compactColdContent(content) {
  const raw = String(content == null ? "" : content).trim();
  if (!raw) {
    return { text: "", summary: "", tokens: [], original_length: 0, saved_length: 0, saved_ratio: 0 };
  }
  const flat = raw.replace(/\s+/g, " ");
  const budget = Math.floor(raw.length * KEEP_RATIO);
  const summary = firstSentenceOf(flat).slice(0, Math.min(SUMMARY_MAX, budget));
  const tokens = extractKeyTokens(flat, budget - summary.length - 10);
  const text = tokens.length ? `${summary}〔关键Token：${tokens.join(" · ")}〕` : summary;
  return {
    text,
    summary,
    tokens,
    original_length: raw.length,
    saved_length: text.length,
    saved_ratio: raw.length ? Number((1 - text.length / raw.length).toFixed(4)) : 0,
  };
}

/** 冷记忆判定：非 principle / 正文 >240 字 / 无 compacted 标签 / updated_at 与 last_used_at 均超 60 天 */
function isColdCompactable(row, cutoff) {
  if (!row || row.invalid_at) return false;
  if (String(row.category || "").trim() === "principle") return false;
  if (String(row.content || "").length <= COLD_MIN_CHARS) return false;
  if (tagsOf(row).includes("compacted")) return false;
  const ref = Math.max(parseStamp(row.updated_at), parseStamp(row.last_used_at));
  return ref > 0 && ref < cutoff;
}

/** 压缩单条记录：原文搬进 full_text（已有则原样保留）、content 换摘要、tags 追加 compacted。
 *  绝不改写 updated_at：压缩是后台瘦身维护，篡改时间戳会让 120 天冷记忆的 freshness 满血复活霸榜。 */
async function compactColdRow(client, row) {
  const res = compactColdContent(row.content);
  if (!res.text || res.saved_ratio < 0.6) return null;
  const tags = tagsOf(row);
  if (!tags.includes("compacted")) tags.push("compacted");
  const fullTextVal = String(row.full_text || row.content);
  const newTagsStr = tags.join(",");
  await client.update("memories", row.id, {
    content: res.text,
    full_text: fullTextVal,
    tags: newTagsStr,
  });
  // 同步回写内存对象：紧随其后的去重合并以 row.tags 为准，不同步会把刚写入的 compacted 标签冲掉
  row.content = res.text;
  row.full_text = fullTextVal;
  row.tags = newTagsStr;
  return { id: row.id, saved_chars: res.original_length - res.saved_length, saved_ratio: res.saved_ratio };
}

/** 多批冷压缩统计合并：四个字段一律相加，绝不覆盖（覆盖会让前序批次的压缩量凭空消失） */
function mergeColdStats(acc, batch) {
  acc.scanned += batch.scanned;
  acc.compacted += batch.compacted;
  acc.saved_chars += batch.saved_chars;
  acc.ids.push(...batch.ids);
  return acc;
}

/** 批量压缩（memoryAudit 主循环与手动信标共用）：内部 fail-open，绝不向上抛错 */
async function compactColdBatch(client, rows, now, ts, rollingLogs) {
  const stats = { scanned: Array.isArray(rows) ? rows.length : 0, compacted: 0, saved_chars: 0, ids: [] };
  if (!Array.isArray(rows) || !client || typeof client.update !== "function") return stats;
  const cutoff = Number(ts || Date.now()) - COLD_DAYS * 86400000;
  for (const row of rows) {
    if (stats.compacted >= COLD_MAX_PER_RUN) break;
    if (!isColdCompactable(row, cutoff)) continue;
    try {
      const r = await compactColdRow(client, row);
      if (!r) continue;
      stats.compacted++;
      stats.saved_chars += r.saved_chars;
      stats.ids.push(row.id);
    } catch (err) {
      // fail-open：单条压缩失败只记日志，去重与后续记录照常推进（绝不让审计整轮失败）
      if (rollingLogs) rollingLogs.push(`[${now}] 冷记忆压缩失败 #${row.id}：${(err && err.message) || err}`);
    }
  }
  if (stats.compacted && rollingLogs) {
    rollingLogs.push(`[${now}] 冷记忆抽取压缩完成：${stats.compacted} 条，释放 ${stats.saved_chars} 字符`);
  }
  return stats;
}

/**
 * 手动触发入口（设置页 compact_cold 信标直连）：自己拉取候选集再走同一套压缩 helper，
 * 与 memoryAudit 周期调度共享唯一实现，杜绝两份压缩逻辑漂移。
 */
export async function compactColdMemories(client, options) {
  const opts = options || {};
  const stats = { scanned: 0, compacted: 0, saved_chars: 0, ids: [] };
  if (!client || typeof client.list !== "function" || typeof client.update !== "function") return stats;
  const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 500));
  const q = {
    lifecycle_status: "active",
    invalid_at: null,
    limit,
    order_by: "updated_at ASC",
    columns: [
      "id", "project", "category", "title", "content", "full_text",
      "tags", "updated_at", "last_used_at", "lifecycle_status", "invalid_at",
    ],
  };
  const project = String(opts.project || "").trim();
  if (project && project !== "global") q.project = project;
  const rows = rowsOf(await client.list("memories", q))
    .filter((r) => r && r.lifecycle_status === "active" && !r.invalid_at);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  return await compactColdBatch(client, rows, now, Date.now());
}

/* ================================================================== *
 * 【v6.4.6-B】主动矛盾检测巡检 (Contradiction Lint)
 * ------------------------------------------------------------------
 * 同项目 + 同主题 + 数字互斥 = 一条硬性规则被两条记忆各写了一个值。
 * 只预警不写库：矛盾对的处理权交给人和模型，审计绝不擅自失效任何一方。
 * ================================================================== */

/** 抽取可读的数字集合（供 UI 直接展示冲突双方的具体取值） */
function numbersIn(text) {
  const nums = String(text == null ? "" : text).match(/\d+(?:\.\d+)*/g) || [];
  return [...new Set(nums)].slice(0, 6);
}

/** 同主题判定：归一化标题包含，或标题词集 Jaccard ≥ 0.5（宁严勿滥，避免把无关规则判成矛盾） */
function sameRuleTopic(a, b) {
  const ta = normalizeSemanticText(a.title);
  const tb = normalizeSemanticText(b.title);
  if (!ta || !tb) return false;
  if (ta === tb || ta.includes(tb) || tb.includes(ta)) return true;
  return jaccardSimilarity(tokenize(a.title).tokens, tokenize(b.title).tokens) >= 0.5;
}

/** 巡检：对同项目下的规范性规则做交叉比对，输出矛盾预警数组 */
function lintContradictions(rows) {
  const out = [];
  if (!Array.isArray(rows) || rows.length < 2) return out;
  const rules = rows.filter(
    (r) => r && !r.invalid_at && RULE_CATEGORIES.has(String(r.category || "").trim().toLowerCase())
  );
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];
      if (String(a.project || "") !== String(b.project || "")) continue;
      if (!sameRuleTopic(a, b)) continue;
      const contentA = a.content || a.full_text || "";
      const contentB = b.content || b.full_text || "";
      if (!hasConflictingNumbers(a.title, b.title) && !hasConflictingNumbers(contentA, contentB)) continue;
      out.push({
        project: String(a.project || ""),
        a_id: a.id,
        b_id: b.id,
        a_title: String(a.title || "").slice(0, 80),
        b_title: String(b.title || "").slice(0, 80),
        numbers_a: numbersIn(`${a.title || ""} ${contentA}`),
        numbers_b: numbersIn(`${b.title || ""} ${contentB}`),
        kind: "numeric_conflict",
        severity: "warn",
      });
      if (out.length >= CONTRADICTION_MAX) return out;
    }
  }
  return out;
}
