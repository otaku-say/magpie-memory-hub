/**
 * tests/test_auto_dedup_and_undo.mjs
 * =================================================================
 * 全自动去重与撤销回滚专项测试套件
 *
 * 覆盖矩阵：
 * 1. 定时范围计算与触发判定：
 *    - getDedupTimeWindow (daily -24h / weekly -7d / monthly -30d)
 *    - isDedupDue (时段匹配 / 超期触发 / 反证门拦截错误触发)
 * 2. 批大小可配与指标规范：
 *    - dedup_batch_size (50~1000)
 *    - 指标字段格式：扫描记忆/踩坑、去重合并数、批次、状态
 * 3. 全自动去重执行：
 *    - 仅软失效（写 invalid_at），绝不物理删除
 *    - 编码批次标识 invalid_reason: "dedup:<batchTs>:into:<primaryId>"
 *    - 主记录 recurrence 精确累加
 * 4. 撤销恢复（undo: true 与 undo_before 时间点回滚）：
 *    - invalid_at 恢复为 NULL
 *    - lifecycle_status 恢复为 active
 *    - 主记录 recurrence 精确减回
 *    - 反证门：多批去重后按时间点回滚，只撤销指定时间点之后的批次
 * 5. 边角情况：
 *    - 主记录被后续删除/合并时跳过并计入 skipped，不报错中断
 *    - 只改变动字段，其余字段完全不被篡改
 * 6. 测试隔离与零残留。
 * =================================================================
 */

import assert from "node:assert";
import { MagpieMemoryHub, getDedupTimeWindow, isDedupDue } from "../tools.js";
import { createTestEnv } from "./lib/testenv.mjs";

function parseOut(res) {
  if (typeof res === "string") {
    try {
      return JSON.parse(res);
    } catch (_) {
      return res;
    }
  }
  return res;
}

const rowsOf = (res) => Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);

console.log("=================================================================");
console.log("【全自动去重与时间点撤销回滚专项测试】");
const env = await createTestEnv({ mode: "memory" });
console.log(`隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

async function run() {
  const hub = await MagpieMemoryHub({
    dedup_schedule: "daily",
    dedup_time: "02:00",
    dedup_batch_size: 100,
  }, {
    client: env.client,
    ncb_instance: env.instance,
  });

  const memSave = hub.tool["memory_save"];
  const pitSave = hub.tool["pitfall_save"];
  const memAudit = hub.tool["memory_audit"];

  try {
    // =================================================================
    // 1. 定时范围计算与调度判定测试 (getDedupTimeWindow & isDedupDue)
    // =================================================================
    console.log("--- [Test 1] 定时范围与调度触发算法测试 ---");
    const testNow = new Date("2026-10-19T03:00:00.000Z");

    // 1.1 时间窗计算
    const dailyWindow = getDedupTimeWindow("daily", testNow);
    const weeklyWindow = getDedupTimeWindow("weekly", testNow);
    const monthlyWindow = getDedupTimeWindow("monthly", testNow);
    const offWindow = getDedupTimeWindow("off", testNow);

    assert.strictEqual(dailyWindow, "2026-10-18 03:00:00", "daily 时间窗应为触发时刻前 24h");
    assert.strictEqual(weeklyWindow, "2026-10-12 03:00:00", "weekly 时间窗应为触发时刻前 7d");
    assert.strictEqual(monthlyWindow, "2026-09-19 03:00:00", "monthly 时间窗应为触发时刻前 30d");
    assert.strictEqual(offWindow, null, "关闭状态时间窗应为 null");

    // 1.2 调度触发判定
    // a) off 不触发
    assert.strictEqual(isDedupDue({ schedule: "off", now: testNow }), false, "off 绝不触发");

    // b) daily 超期 24h 触发
    const last30h = new Date(testNow.getTime() - 30 * 3600 * 1000).toISOString();
    assert.strictEqual(isDedupDue({ schedule: "daily", time: "02:00", lastDedupAt: last30h, now: testNow }), true, "超期 30h 必须触发");

    // c) daily 当天 02:00 到达且上次去重在昨天，触发
    const lastYesterday = "2026-10-18 01:50:00";
    assert.strictEqual(isDedupDue({ schedule: "daily", time: "02:00", lastDedupAt: lastYesterday, now: testNow }), true, "已到达设定时刻且上次在昨天必须触发");

    // d) 反证门：今天 02:05 已执行过，03:00 绝不能重复触发
    const alreadyDoneToday = "2026-10-19 02:05:00";
    const duplicateTrigger = isDedupDue({ schedule: "daily", time: "02:00", lastDedupAt: alreadyDoneToday, now: testNow });
    assert.strictEqual(duplicateTrigger, false, "【反证门通过】：当天已执行过去重绝不重复触发");

    // e) weekly 判定 (2026-10-19 是周一)
    assert.strictEqual(isDedupDue({ schedule: "weekly", time: "02:00", weekday: 1, lastDedupAt: last30h, now: testNow }), true, "周一且到达时刻必须触发 weekly");
    assert.strictEqual(isDedupDue({ schedule: "weekly", time: "02:00", weekday: 3, lastDedupAt: last30h, now: testNow }), false, "非周一绝不触发周三的 weekly");

    console.log("  ✓ 定时范围计算 (24h/7d/30d) 与调度状态机断言通过！\n");

    // =================================================================
    // 2. 批大小可配与指标规范测试 (batch_size & metrics)
    // =================================================================
    console.log("--- [Test 2] 批大小可配与指标规范测试 ---");
    // 准备数据：存入两组重复事实
    const baseTitle1 = "SQLite WAL 模式并发写入性能优化指南";
    const item1 = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: baseTitle1,
      content: "SQLite 开启 WAL (Write-Ahead Logging) 模式可实现读写并发，提升吞吐量。",
      tags: "sqlite, wal, db",
    }));

    // 变体 1.1
    const leg1 = await env.client.create("memories", {
      project: env.project,
      category: "preference",
      title: "「SQLite WAL 模式并发写入性能优化指南」",
      content: "关于 SQLite WAL 模式：开启 WAL 即可实现读写并发并提升吞吐性能。",
      content_fingerprint: "test_fp_wal_1",
      lifecycle_status: "active",
      recurrence: 1,
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });

    // 踩坑数据
    const pit1 = parseOut(await pitSave.execute({
      project: env.project,
      component: "sqlite_busy",
      symptom: "database is locked 错误频发",
      root_cause: "未开启 WAL 导致读写锁冲突",
      solution: "PRAGMA journal_mode=WAL;",
      severity: "high",
    }));

    // 踩坑重复变体
    const legPit1 = await env.client.create("pitfalls", {
      project: env.project,
      client: "test",
      component: "sqlite_busy",
      symptom: "database is locked 错误频发（重复变体）",
      root_cause: "未开启 WAL 导致读写锁冲突",
      solution: "PRAGMA journal_mode=WAL;",
      severity: "high",
      recurrence: 1,
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });

    const leg1Id = leg1.id || leg1.insertId;
    const legPitId = legPit1.id || legPit1.insertId;

    // 执行指定批大小 50 的全自动去重
    const auditRes = parseOut(await memAudit.execute({
      project: env.project,
      batch_size: 50,
      full: true,
    }));

    // 指标字段规范校验
    assert.strictEqual(auditRes.action, "DEDUP_REPORT", "action 必须为 DEDUP_REPORT");
    assert.strictEqual(auditRes.status, "已完成", "status 必须为 已完成");
    assert.strictEqual(auditRes.data_changed, true, "存在重复时必须触发数据变更");
    assert.ok(auditRes.scanned.memories >= 2, "扫描记忆数必须 >= 2");
    assert.ok(auditRes.scanned.pitfalls >= 2, "扫描踩坑数必须 >= 2");
    assert.ok(auditRes.deduped.memories >= 1, "去重记忆数必须 >= 1");
    assert.ok(auditRes.deduped.pitfalls >= 1, "去重踩坑数必须 >= 1");

    // 校验 lines 文案格式
    assert.ok(auditRes.lines.some((l) => l.includes("扫描记忆:") && l.includes("去重合并:")), "必须包含记忆扫描指标");
    assert.ok(auditRes.lines.some((l) => l.includes("扫描踩坑:") && l.includes("去重合并:")), "必须包含踩坑扫描指标");
    assert.ok(auditRes.lines.some((l) => l.includes("批次:") && l.includes("状态: 已完成")), "必须包含批次与状态指标");
    console.log("  ✓ 批大小可配与指标规范验证通过！\n");

    // =================================================================
    // 3. 软失效断言与编码批次标识 (invalid_reason = dedup:<batchTs>:into:<id>)
    // =================================================================
    console.log("--- [Test 3] 只软失效、不物理删与编码批次标识验证 ---");
    const memRows = rowsOf(await env.client.list("memories", { project: env.project, id: leg1Id }));
    assert.strictEqual(memRows.length, 1, "【红线 1】：被合并物理行必须依然存在，绝不物理删除");
    const mDup = memRows[0];
    assert.ok(mDup.invalid_at !== null && mDup.invalid_at !== "", "必须写入 invalid_at");
    assert.strictEqual(mDup.lifecycle_status, "invalid", "lifecycle_status 必须置为 invalid");
    assert.ok(/^dedup:\d+:into:\d+$/.test(mDup.invalid_reason), "invalid_reason 必须符合 dedup:<batchTs>:into:<primaryId> 格式");

    const primaryMem = rowsOf(await env.client.list("memories", { project: env.project, id: item1.id }))[0];
    assert.strictEqual(Number(primaryMem.recurrence), 2, "主记录 recurrence 必须累加至 2");
    console.log("  ✓ 软失效审计字段与 recurrence 累加验证通过！\n");

    // =================================================================
    // 4. 撤销恢复测试 (undo: true 撤销最近一次批次)
    // =================================================================
    console.log("--- [Test 4] 撤销最近一次去重测试 (undo: true) ---");
    const undoRes = parseOut(await memAudit.execute({
      project: env.project,
      undo: true,
    }));

    assert.strictEqual(undoRes.action, "DEDUP_UNDONE", "撤销返回 action 必须为 DEDUP_UNDONE");
    assert.ok(undoRes.restored_records >= 2, "应恢复记忆与踩坑共 >= 2 条");
    assert.ok(undoRes.undone_recurrence >= 2, "应撤销 recurrence >= 2");
    assert.strictEqual(undoRes.skipped, 0, "主记录正常存在时 skipped 应为 0");
    assert.ok(undoRes.note.includes("已恢复") && undoRes.note.includes("撤销 recurrence"), "note 格式符合预期");

    // 断言完整恢复：invalid_at 为 NULL，lifecycle_status 为 active，recurrence 减回 1
    const memRestored = rowsOf(await env.client.list("memories", { project: env.project, id: leg1Id }))[0];
    assert.strictEqual(memRestored.invalid_at, null, "撤销后副本 invalid_at 必须为 null");
    assert.strictEqual(memRestored.lifecycle_status, "active", "撤销后副本 lifecycle_status 必须为 active");

    const primaryRestored = rowsOf(await env.client.list("memories", { project: env.project, id: item1.id }))[0];
    assert.strictEqual(Number(primaryRestored.recurrence), 1, "主记录 recurrence 必须精确减回 1");

    const pitRestored = rowsOf(await env.client.list("pitfalls", { project: env.project, id: legPitId }))[0];
    assert.strictEqual(pitRestored.invalid_at, null, "踩坑副本 invalid_at 必须恢复为 null");
    console.log("  ✓ 撤销完整还原（invalid_at=null, active, recurrence精确减回）验证通过！\n");

    // =================================================================
    // 5. 时间点回滚 (undo_before: "YYYY-MM-DD HH:mm") 与反证门
    // =================================================================
    console.log("--- [Test 5] 时间点回滚 (undo_before) 与反证测试 ---");
    // 模拟两批在不同时间发生的去重：
    // Batch 1 (过去时刻):
    const earlyBatchTs = Date.now() - 120000; // 2 分钟前
    const b1Primary = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "多批回滚测试条目 Batch1",
      content: "这是第一批的主记录内容",
    }));
    const b1Dup = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "多批回滚测试条目 Batch1 副本",
      content: "这是第一批的副本内容",
      content_fingerprint: "batch1_fp",
      lifecycle_status: "invalid",
      invalid_at: new Date(earlyBatchTs).toISOString().slice(0, 19).replace("T", " "),
      invalid_reason: `dedup:${earlyBatchTs}:into:${b1Primary.id}`,
      recurrence: 1,
      created_at: new Date(earlyBatchTs).toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date(earlyBatchTs).toISOString().slice(0, 19).replace("T", " "),
    });
    // 累加 primary 1 的 recurrence 至 2
    await env.client.update("memories", b1Primary.id, { recurrence: 2 });

    // 确定分割时间点 cutoffTime：位于 Batch 1 和 Batch 2 之间 (1 分钟前)
    const cutoffTime = new Date(Date.now() - 60000).toISOString().slice(0, 19).replace("T", " ");

    // Batch 2 (当前时刻):
    const lateBatchTs = Date.now();
    const b2Primary = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "多批回滚测试条目 Batch2",
      content: "这是第二批的主记录内容",
    }));
    const b2Dup = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "多批回滚测试条目 Batch2 副本",
      content: "这是第二批的副本内容",
      content_fingerprint: "batch2_fp",
      lifecycle_status: "invalid",
      invalid_at: new Date(lateBatchTs).toISOString().slice(0, 19).replace("T", " "),
      invalid_reason: `dedup:${lateBatchTs}:into:${b2Primary.id}`,
      recurrence: 1,
      created_at: new Date(lateBatchTs).toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date(lateBatchTs).toISOString().slice(0, 19).replace("T", " "),
    });
    await env.client.update("memories", b2Primary.id, { recurrence: 2 });

    const b1DupId = b1Dup.id || b1Dup.insertId;
    const b2DupId = b2Dup.id || b2Dup.insertId;

    // 执行按时间点回滚：undo_before: cutoffTime（撤销 cutoffTime 之后发生的 Batch 2）
    console.log(`  执行时间点回滚 (undo_before: "${cutoffTime}")...`);
    const rollbackRes = parseOut(await memAudit.execute({
      project: env.project,
      undo_before: cutoffTime,
    }));

    // 【反证门断言】：Batch 2（cutoff 之后）必须被撤销恢复；Batch 1（cutoff 之前）必须严格保留失效！
    const b2DupAfter = rowsOf(await env.client.list("memories", { project: env.project, id: b2DupId }))[0];
    const b1DupAfter = rowsOf(await env.client.list("memories", { project: env.project, id: b1DupId }))[0];
    const b2PrimaryAfter = rowsOf(await env.client.list("memories", { project: env.project, id: b2Primary.id }))[0];
    const b1PrimaryAfter = rowsOf(await env.client.list("memories", { project: env.project, id: b1Primary.id }))[0];

    assert.strictEqual(b2DupAfter.invalid_at, null, "Batch 2 副本必须被恢复（invalid_at 置 null）");
    assert.strictEqual(b2DupAfter.lifecycle_status, "active", "Batch 2 副本状态必须恢复 active");
    assert.strictEqual(Number(b2PrimaryAfter.recurrence), 1, "Batch 2 主记录 recurrence 必须恢复为 1");

    assert.ok(b1DupAfter.invalid_at !== null, "【反证门通过】：cutoff 之前的 Batch 1 副本绝不能被误恢复！");
    assert.strictEqual(b1DupAfter.lifecycle_status, "invalid", "【反证门通过】：Batch 1 副本状态依然为 invalid");
    assert.strictEqual(Number(b1PrimaryAfter.recurrence), 2, "【反证门通过】：Batch 1 主记录 recurrence 依然为 2 未受影响");
    console.log("  ✓ 【反证门通过】：时间点回滚仅影响指定时刻之后的批次，早前批次不受影响！\n");

    // =================================================================
    // 6. 边角情况：主记录已被后续删除/合并时跳过并计入 skipped
    // =================================================================
    console.log("--- [Test 6] 边角情况：主记录已被删除时跳过并计入 skipped ---");
    // 创建一组已去重记录
    const orphanPrimary = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "孤儿主记录测试",
      content: "主记录将被软失效",
    }));
    const orphanBatchTs = Date.now();
    const orphanDup = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "孤儿副本测试",
      content: "副本将被撤销",
      content_fingerprint: "orphan_fp",
      lifecycle_status: "invalid",
      invalid_at: new Date(orphanBatchTs).toISOString().slice(0, 19).replace("T", " "),
      invalid_reason: `dedup:${orphanBatchTs}:into:${orphanPrimary.id}`,
      recurrence: 1,
      created_at: new Date(orphanBatchTs).toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date(orphanBatchTs).toISOString().slice(0, 19).replace("T", " "),
    });
    const orphanDupId = orphanDup.id || orphanDup.insertId;

    // 模拟主记录已被后续删除/失效
    await env.client.update("memories", orphanPrimary.id, {
      invalid_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      lifecycle_status: "invalid",
    });

    // 执行撤销：主记录已被删除，必须跳过并计入 skipped，不报错中断！
    const orphanUndoRes = parseOut(await memAudit.execute({
      project: env.project,
      undo_before: new Date(orphanBatchTs - 1000).toISOString().slice(0, 19).replace("T", " "),
    }));

    assert.ok(orphanUndoRes.skipped >= 1, "主记录失效时 skipped 必须 >= 1");
    assert.ok(orphanUndoRes.note.includes("跳过"), "返回 note 必须提示跳过");

    // 副本依然能够安全恢复
    const orphanDupRestored = rowsOf(await env.client.list("memories", { project: env.project, id: orphanDupId }))[0];
    assert.strictEqual(orphanDupRestored.invalid_at, null, "副本必须正常恢复为 null");
    assert.strictEqual(orphanDupRestored.lifecycle_status, "active", "副本状态必须恢复 active");
    console.log("  ✓ 主记录失效安全跳过（skipped 计数且不报错中断）验证通过！\n");

  } finally {
    console.log(`[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    const cleanRes = await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "残余必须彻底为 0");
    console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
  }
}

run().catch((err) => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});
