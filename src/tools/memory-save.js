/**
 * 模块职责：memory_save MCP 工具入口（入参归一化、写入、feedback=helpful 提权与输出格式化）
 * 依赖：src/tools/args.js, src/services/save/memory-saver.js, src/domain/semantic-dedup.js,
 *       src/core/sanitize.js, src/integration/ncb.js, src/core/config.js, src/domain/scoring.js
 * 被依赖：src/index.js
 */

import { normalizeToolArgs } from "./args.js";
import { saveMemory } from "../services/save/memory-saver.js";
import { semanticFingerprint } from "../domain/semantic-dedup.js";
import { scrubSecrets } from "../core/sanitize.js";
import { rowsOf } from "../integration/ncb.js";
import { CATEGORIES, FETCH_LIMIT, nowSql } from "../core/config.js";
import { jsonOut } from "../domain/scoring.js";

/** SPEC §2 只定义正向反馈 helpful；stale / wrong / not_helpful 归 memory_forget 处理 */
const HELPFUL = "helpful";

/**
 * 提权对象：仅去重（NOOP）与演进（ENRICHED）命中的既有记忆。
 * 新建行（ADD / UPDATE）是本次才落库的记录，没有被验证过的历史；pitfalls 表没有
 * confidence_score 列，两者都不参与 helpful 提权。
 */
function _isHitExisting(result) {
  if (!result || result.table === "pitfalls") return false;
  return result.action === "NOOP" || result.action === "ENRICHED";
}

/**
 * 写后读延迟窗口内 saveMemory 会短路成「NOOP + id:null」，此时仍需把 helpful 落到既有行上。
 * 指纹派生与写入侧逐字一致（同一 project / category 归一 / 脱敏 / tags 小写），
 * 查询按 project 拉回后本地过滤——不依赖后端是否支持 content_fingerprint 过滤。
 */
async function _idByFingerprint(client, args) {
  const project = String(args.project || "global").trim();
  const category = CATEGORIES.includes(args.category) ? args.category : "fact";
  const title = scrubSecrets(String(args.title || "").trim());
  const content = scrubSecrets(String(args.content || "").trim());
  const tags = scrubSecrets(String(args.tags || "").trim().toLowerCase());
  const fp = String(args.content_fingerprint || "").trim() || semanticFingerprint(project, category, title, content, tags);
  const rows = rowsOf(await client.list("memories", { project, limit: FETCH_LIMIT }));
  const row = rows.find((r) => r && r.content_fingerprint === fp && !r.invalid_at);
  return row ? Number(row.id) : null;
}

/**
 * SPEC §2 helpful 提权：confidence +10（封顶 100）、recurrence 累加、访问热度 +1。
 * 写入侧已把本次复发计入时（result.recurrence 有值）只需再 +1 表达「老经验再次被验证有用」；
 * 被写后读窗口短路掉时本次复发没被计入，因此补 +2。基数取库内现值与接口回显的较大者，
 * 避免 NCB 读延迟把计数写回去。与 memory_get 同一约定：不改 updated_at，不把老记忆伪装成新记忆。
 * 读写失败一律降级为「不提权」且不抛错：反馈是附赠信号，不能反过来吃掉已成功的保存。
 */
async function _escalateHelpful(client, id, result) {
  let row;
  try {
    row = rowsOf(await client.list("memories", { id, limit: 1 }))[0];
  } catch (_) {
    return null;
  }
  if (!row) return null;

  const reported = Number(result && result.recurrence) || 0;
  const cur = Number(row.confidence_score);
  const patch = {
    confidence_score: Math.min(100, (isNaN(cur) ? 100 : cur) + 10),
    recurrence: Math.max(Number(row.recurrence) || 1, reported) + (reported ? 1 : 2),
    retrieval_count: (Number(row.retrieval_count) || 0) + 1,
    last_used_at: nowSql(),
  };
  try {
    await client.update("memories", id, patch);
  } catch (_) {
    return null;
  }
  return patch;
}

/**
 * feedback="helpful" 的回显与提权收口在写入之后执行：未带 helpful 时原样返回 result，
 * 输出与旧格式逐字节一致（零侵入）。
 */
async function _applyHelpfulFeedback(client, result, args) {
  if (args.feedback !== HELPFUL) return result;

  const hit = _isHitExisting(result);
  let targetId = hit ? Number(result.id) || null : null;
  if (hit && !targetId) targetId = await _idByFingerprint(client, args).catch(() => null);
  const patch = targetId ? await _escalateHelpful(client, targetId, result) : null;

  if (patch) {
    return Object.assign({}, result, {
      feedback_applied: HELPFUL,
      confidence_score: patch.confidence_score,
      recurrence: patch.recurrence,
    });
  }
  return Object.assign({}, result, {
    feedback_applied: null,
    feedback_note: hit
      ? "命中既有记忆但提权写入失败（fail-open），保存结果不受影响"
      : "本次未命中既有记忆（新建行或踩坑表），helpful 提权只作用于去重/演进命中的记录",
  });
}

export async function memorySave(client, cfg, rawArgs, ctx) {
  const args = normalizeToolArgs(rawArgs, cfg);
  args.feedback = String(args.feedback || "").toLowerCase().trim(); // 归一化后随 args 透传给写入服务
  const result = await saveMemory(client, cfg, args, ctx);
  return jsonOut(await _applyHelpfulFeedback(client, result, args));
}
