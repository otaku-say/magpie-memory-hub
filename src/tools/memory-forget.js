/**
 * 模块职责：memory_forget MCP 工具入口（跨表软失效，保留审计链，不物理删除）
 * 依赖：src/tools/args.js, src/integration/ncb.js, src/domain/scoring.js
 * 被依赖：src/index.js
 */

import { normalizeToolArgs } from "./args.js";
import { fetchAll, rowsOf } from "../integration/ncb.js";
import { scoreMemory, scorePitfall, jsonOut, termsOf } from "../domain/scoring.js";

async function _handleFeedback(client, id, feedback) {
  if (feedback !== "not_helpful") return null;
  const row = await client.get("memories", id);
  if (!row) return jsonOut({ ok: false, error: "not found" });
  const newConf = Math.max(0, (Number(row.confidence_score) || 100) - 25);
  await client.update("memories", id, { confidence_score: newConf, updated_at: nowSql() });
  return jsonOut({ ok: true, action: "FEEDBACK_DOWNVOTE", id, confidence_score: newConf });
}

export async function memoryForget(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const fb = await _handleFeedback(client, Number(args.id), String(args.feedback || "").toLowerCase().trim());
  if (fb) return fb;
  const table = (args.table && String(args.table).trim().toLowerCase() === "pitfalls") ? "pitfalls" : "memories";
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  let targets = [];

  const isBatch = Array.isArray(args.ids) || (args.ids != null && typeof args.ids === "string" && args.ids.includes(","));
  if (isBatch) {
    const targetIds = (Array.isArray(args.ids) ? args.ids : String(args.ids).split(",")).map(Number).filter(Boolean);
    for (const tid of targetIds) {
      const rows = rowsOf(await client.list(table, { limit: 1, id: tid })).filter((r) => Number(r.id) === tid);
      if (rows.length > 0) targets.push(rows[0]);
    }
  } else if (args.id != null) {
    targets = rowsOf(await client.list(table, { limit: 1, id: Number(args.id) }))
      .filter((r) => Number(r.id) === Number(args.id));
  } else if (args.query) {
    const terms = termsOf(args.query);
    if (table === "memories") {
      const fetchParams = { lifecycle_status: "active" };
      if (args.project) fetchParams.project = String(args.project).trim();
      const all = await fetchAll(client, "memories", fetchParams);
      let pool = all;
      if (args.project) pool = pool.filter((r) => String(r.project || "") === String(args.project));
      targets = pool
        .map((r) => ({ row: r, hit: scoreMemory(r, terms) }))
        .filter((x) => x.hit > 0)
        .sort((a, b) => b.hit - a.hit)
        .slice(0, Math.max(1, Math.min(Number(args.limit) || 1, 20)))
        .map((x) => x.row);
    } else {
      const fetchParams = {};
      if (args.project) fetchParams.project = String(args.project).trim();
      const all = await fetchAll(client, "pitfalls", fetchParams);
      let pool = all.filter((r) => !r.invalid_at);
      if (args.project) pool = pool.filter((r) => String(r.project || "") === String(args.project));
      targets = pool
        .map((r) => ({ row: r, hit: scorePitfall(r, terms) }))
        .filter((x) => x.hit > 0)
        .sort((a, b) => b.hit - a.hit)
        .slice(0, Math.max(1, Math.min(Number(args.limit) || 1, 20)))
        .map((x) => x.row);
    }
  } else {
    throw new Error("需要 id、ids 或 query 之一");
  }
  if (!targets.length) return jsonOut({ action: "NOT_FOUND", table, forgotten: 0 });

  const done = [];
  for (const t of targets) {
    try {
      if (table === "memories") {
        await client.update("memories", t.id, {
          invalid_at: now, lifecycle_status: "invalid", invalid_reason: "user_forgot",
          updated_at: now,          // NCB 不生效 ON UPDATE CURRENT_TIMESTAMP，必须显式写
        });
        done.push({ id: t.id, title: t.title });
      } else {
        await client.update("pitfalls", t.id, {
          invalid_at: now,
          invalid_reason: "user_forgot",
          updated_at: now,
        });
        done.push({ id: t.id, title: t.symptom || t.title, symptom: t.symptom });
      }
    } catch (e) { /* 单条失败不影响其余 */ }
  }
  return jsonOut({
    action: "SOFT_DELETE",
    table,
    forgotten: done.length,
    items: done,
    note: "已软失效（写 invalid_at），记录保留可追溯，中间件不再注入",
  });
}

/* ================================================================== *
 * 全自动去重与撤销回滚
 * ================================================================== */

/** 计算定时去重范围 (daily: -24h, weekly: -7d, monthly: -30d) */
