/**
 * 模块职责：去重审计撤销（支持全量回滚、按时间截断回滚与单批次撤销）
 * 依赖：src/core/**, src/domain/**, src/integration/**, local_state.js
 * 被依赖：src/services/audit/auditor.js, tools.js
 */

import { nowSql } from "../../core/config.js";
import { rowsOf } from "../../integration/ncb.js";
import { jsonOut } from "../../domain/scoring.js";
import { lookupAuditState, rememberAuditState } from "../../../local_state.js";
import { writeCardStatus } from "../../core/status-writer.js";

export async function memoryAuditUndo(client, cfg, args) {
  args = args || {};
  if (!client || typeof client !== "object" || typeof client.list !== "function") {
    return jsonOut({ action: "DEDUP_UNDONE", success: false, data_changed: false,
      restored_records: 0, undone_recurrence: 0, skipped: 0,
      note: "无可用数据库客户端，已跳过撤销（不影响插件加载）" });
  }
  const project = String(args.project || (cfg && cfg.project) || "global").trim();
  const auditState = lookupAuditState();
  let rollingLogs = Array.isArray(auditState.logs) ? [...auditState.logs] : [];

  let cutoffTs = null;
  if (args.undo_before) {
    const s = String(args.undo_before).trim();
    if (/^\d{10,13}$/.test(s)) {
      cutoffTs = Number(s);
    } else {
      let iso = s.replace(" ", "T");
      if (!iso.includes("Z") && !/[+-]\d{2}(?::?\d{2})?$/.test(iso)) {
        iso += "Z";
      }
      const t = Date.parse(iso);
      cutoffTs = isNaN(t) ? new Date(s).getTime() : t;
    }
  }

  async function fetchInvalidCandidates(table) {
    const candidates = [];
    let lastId = 0;
    while (true) {
      const q = { project, since_id: lastId, limit: 1000, order_by: "id ASC" };
      const res = await client.list(table, q);
      const rows = rowsOf(res);
      if (!rows.length) break;
      for (const r of rows) {
        lastId = r.id;
        if (!r.invalid_at) continue;
        const reason = String(r.invalid_reason || "");
        const m = reason.match(/^dedup:(\d+):into:(\d+)$/);
        if (m) {
          candidates.push({
            id: r.id,
            table,
            batchTs: Number(m[1]),
            primaryId: Number(m[2]),
            row: r,
          });
        }
      }
      if (rows.length < 1000) break;
    }
    return candidates;
  }

  const memCandidates = await fetchInvalidCandidates("memories");
  const pitCandidates = await fetchInvalidCandidates("pitfalls");
  const allCandidates = memCandidates.concat(pitCandidates);

  let targetCandidates = [];
  if (cutoffTs !== null) {
    targetCandidates = allCandidates.filter((c) => c.batchTs >= cutoffTs);
  } else {
    let latestBatchTs = 0;
    for (const c of allCandidates) {
      if (c.batchTs > latestBatchTs) latestBatchTs = c.batchTs;
    }
    if (!latestBatchTs && auditState.last_dedup_batch_ts) {
      latestBatchTs = Number(auditState.last_dedup_batch_ts);
    }
    if (latestBatchTs) {
      targetCandidates = allCandidates.filter((c) => c.batchTs === latestBatchTs);
    }
  }

  if (targetCandidates.length === 0) {
    const note = "已恢复 0 条 · 撤销 recurrence 0 次 · 跳过 0 条（未找到符合条件的去重记录）";
    return jsonOut({
      action: "DEDUP_UNDONE",
      success: true,
      data_changed: false,
      restored_records: 0,
      undone_recurrence: 0,
      skipped: 0,
      note,
      lines: [note, "状态: 已完成"],
      logs: rollingLogs,
    });
  }

  let restoredCount = 0;
  let undoneRecurrence = 0;
  let skippedCount = 0;
  const now = nowSql();

  const memPrimaryMap = new Map();
  const pitPrimaryMap = new Map();

  for (const c of targetCandidates) {
    try {
      const dupRec = Number(c.row?.recurrence) || 1;
      if (c.table === "memories") {
        await client.update("memories", c.id, {
          invalid_at: null,
          lifecycle_status: "active",
          invalid_reason: null,
          updated_at: now,
        });
        restoredCount++;
        const cur = memPrimaryMap.get(c.primaryId) || { count: 0, rec: 0 };
        cur.count += 1;
        cur.rec += dupRec;
        memPrimaryMap.set(c.primaryId, cur);
      } else if (c.table === "pitfalls") {
        await client.update("pitfalls", c.id, {
          invalid_at: null,
          invalid_reason: null,
          updated_at: now,
        });
        restoredCount++;
        const cur = pitPrimaryMap.get(c.primaryId) || { count: 0, rec: 0 };
        cur.count += 1;
        cur.rec += dupRec;
        pitPrimaryMap.set(c.primaryId, cur);
      }
    } catch (_) {}
  }

  async function rollbackPrimaries(table, primaryMap) {
    for (const [pId, info] of primaryMap.entries()) {
      try {
        const rows = rowsOf(await client.list(table, { project, id: pId }));
        const pRow = rows[0];
        if (!pRow || pRow.invalid_at || pRow.lifecycle_status === "invalid" || pRow.lifecycle_status === "superseded") {
          skippedCount += info.count;
          continue;
        }
        const curRec = Number(pRow.recurrence) || 1;
        const newRec = Math.max(1, curRec - info.rec);
        await client.update(table, pId, {
          recurrence: newRec,
          updated_at: now,
        });
        undoneRecurrence += (curRec - newRec);
      } catch (_) {
        skippedCount += info.count;
      }
    }
  }

  await rollbackPrimaries("memories", memPrimaryMap);
  await rollbackPrimaries("pitfalls", pitPrimaryMap);

  const note = `已恢复 ${restoredCount} 条 · 撤销 recurrence ${undoneRecurrence} 次 · 跳过 ${skippedCount} 条`;
  rollingLogs.push(`[${now}] 撤销去重完成：${note}`);
  if (rollingLogs.length > 30) rollingLogs = rollingLogs.slice(-30);

  rememberAuditState({
    last_dedup_at: now,
    last_undo_at: now,
    logs: rollingLogs,
  });

  try {
    writeCardStatus("audit", {
      ok: true,
      at: Date.now(),
      op: "memory_audit",
      title: "去重撤销已完成",
      status: "已完成", // db-col-ok: 去重任务运行状态
      lines: [note, "状态: 已完成"],
      logs: rollingLogs,
    });
  } catch (_) {}

  return jsonOut({
    action: "DEDUP_UNDONE",
    success: true,
    data_changed: restoredCount > 0,
    restored_records: restoredCount,
    undone_recurrence: undoneRecurrence,
    skipped: skippedCount,
    note,
    lines: [note, "状态: 已完成"],
    logs: rollingLogs,
  });
}
