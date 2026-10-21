/**
 * tests/test_v634_a_tools.mjs
 * =================================================================
 * v6.34-a tools.js 调度器接力与审计仲裁修复专项验收测试套件
 *
 * 覆盖 4 项整改及反证门（Adversarial Counter-Evidence Gates）：
 * 1. 【反证门 1】P1-1 调度器关闭彻底性与定时自动接力反证测试 (daily -> off 关闭 + has_more 接力)
 * 2. 【反证门 2】P1-2 readOptions 漏字段补齐与 dedup_batch_size 优先级反证测试
 * 3. 【反证门 3】P1-3 单条精确重复孤儿挂载与模型合并数字冲突守卫反证测试 (3306 vs 3307 守卫)
 * 4. 【反证门 4】P1-5 pitfalls 软删记录过滤、分页截断判定与投影列补齐反证测试
 * 5. 【规范自检】test_meta 规范元检查自证（零外网依赖、环境隔离、严格 cleanup、残余为 0 断言）
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MagpieMemoryHub,
  memoryAudit,
} from "../tools.js";
const readOptions = MagpieMemoryHub.readOptions;
const checkScheduledDedup = MagpieMemoryHub.checkScheduledDedup;
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

// 测试数据必须用「当前时间」构造：定时去重按 schedule 计算 updated_after 窗口，
// 硬编码过去时间会随日期推移滑出窗口，导致扫描 0 条（时间炸弹）。
const NOW_STR = new Date().toISOString().slice(0, 19).replace("T", " ");

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

const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []));

console.log("=================================================================");
console.log("【v6.34-a tools.js 调度器接力与审计仲裁整改验收测试套件】");
const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

const clearProjectRecords = async () => {
  const mems = rowsOf(await env.client.list("memories", { project: env.project, limit: 1000 }));
  for (const m of mems) {
    try {
      await env.client.remove("memories", m.id);
    } catch (_) {
      // 忽略单条删除异常
    }
  }
  const pits = rowsOf(await env.client.list("pitfalls", { project: env.project, limit: 1000 }));
  for (const p of pits) {
    try {
      await env.client.remove("pitfalls", p.id);
    } catch (_) {
      // 忽略单条删除异常
    }
  }
};

async function run() {
  try {
    // =================================================================
    // 1. 【反证门 1】P1-1 调度器关闭彻底性与定时自动接力反证测试
    // =================================================================
    console.log("▶ [Test 1] 【反证门 1】P1-1 调度器关闭彻底性与定时自动接力反证测试...");
    await clearProjectRecords();

    // 1a. daily -> off 彻底停止与句柄清理
    const schedResult1 = MagpieMemoryHub.ensureAuditScheduler(env.client, {
      project: env.project,
      dedup_schedule: "daily",
    });
    assert.strictEqual(schedResult1.started, true, "daily 配置下调度器必须成功启动");

    // 模拟设置页改回 off
    const schedResult2 = MagpieMemoryHub.ensureAuditScheduler(env.client, {
      project: env.project,
      dedup_schedule: "off",
    });
    assert.strictEqual(schedResult2.started, false, "【反证门 1a 通过】：dedup_schedule 改为 off 时调度器必须显式 stop 并清理定时器句柄！");
    const triggeredOff = await schedResult2.runScheduled();
    assert.strictEqual(triggeredOff, null, "调度器在 off 状态下触发执行必须安全返回 null，绝不空转去重");

    // 1b. 定时去重接力不被阻断（has_more=true 时连续两次调度均真实执行）
    // 插入 4 条重复记忆，单批拉取上限设为 2，必触发截断 has_more: true
    for (let i = 1; i <= 4; i++) {
      await env.client.create("memories", {
        project: env.project,
        category: "fact",
        title: "定时接力去重测试条目",
        content: "完全相同的内容指纹用以产生精确重复",
        lifecycle_status: "active",
        recurrence: 1,
        tags: "scheduled, relay",
        created_at: NOW_STR,
        updated_at: NOW_STR,
      });
    }

    const relaySched = MagpieMemoryHub.ensureAuditScheduler(env.client, {
      project: env.project,
      dedup_schedule: "daily",
      dedup_fetch_limit: 2,
      fetch_limit: 2,
    });

    // 第一次触发调度
    const resRun1 = parseOut(await relaySched.runScheduled());
    assert.ok(resRun1 && resRun1.action === "DEDUP_REPORT", "第 1 次调度必须真实执行");
    assert.strictEqual(resRun1.has_more, true, "第 1 次调度因批次上限截断，has_more 必须为 true");

    // 连续触发第二次调度（模拟 5 分钟后自动接力）
    // 旧逻辑下因 last_dedup_at 被更新为当前时刻，第二次调度会被判定为 schedule_not_due 而被跳过！
    // 新逻辑下检测到 last_dedup_pending: true 且 last_dedup_at 未被提前锁死，保证接力不被阻断
    const resRun2 = parseOut(await relaySched.runScheduled());
    assert.ok(resRun2, "第 2 次调度必须返回结果");
    assert.notStrictEqual(resRun2.skipped, true, "【反证门 1b 通过】：has_more=true 时连续调度绝不得被 schedule_not_due 跳过阻断，接力必须真实执行！");
    assert.strictEqual(resRun2.action, "DEDUP_REPORT", "第 2 次调度接力成功生成报告");

    // 清理调度器
    MagpieMemoryHub.stopAuditScheduler();
    console.log("  ✓ 【反证门 1 通过】：调度器关闭彻底且定时接力未被阻断！\n");

    // =================================================================
    // 2. 【反证门 2】P1-2 readOptions 漏字段补齐与 dedup_batch_size 优先级反证测试
    // =================================================================
    console.log("▶ [Test 2] 【反证门 2】P1-2 readOptions 漏字段补齐与 dedup_batch_size 优先级反证测试...");

    // 2a. readOptions 补齐 4 个字段
    const customOpts = readOptions({
      project: env.project,
      audit_chunk_size: 25,
      audit_max_batches: 3,
      rerank_model: "custom/rerank-model-v1",
    });
    assert.strictEqual(customOpts.project, env.project, "readOptions 必须保留 project 字段");
    assert.strictEqual(customOpts.audit_chunk_size, 25, "readOptions 必须保留 audit_chunk_size 字段");
    assert.strictEqual(customOpts.audit_max_batches, 3, "readOptions 必须保留 audit_max_batches 字段");
    assert.strictEqual(customOpts.rerank_model, "custom/rerank-model-v1", "readOptions 必须保留 rerank_model 字段");

    // 默认值检验
    const defaultOpts = readOptions({});
    assert.strictEqual(defaultOpts.project, "global", "readOptions 默认 project 应为 global");
    assert.strictEqual(defaultOpts.audit_chunk_size, 40, "readOptions 默认 audit_chunk_size 应为 40");
    assert.strictEqual(defaultOpts.audit_max_batches, 1, "readOptions 默认 audit_max_batches 应为 1");
    assert.strictEqual(defaultOpts.rerank_model, "", "readOptions 默认 rerank_model 应为空字符串");

    // 2b. 配置 dedup_batch_size=300 时，实际拉取上限必须是 300 而不是被 package.json 默认 200 遮蔽
    let capturedListLimit = null;
    const mockProbeClient = {
      list: async (tbl, q) => {
        capturedListLimit = q.limit;
        return [];
      },
    };

    // 配置 dedup_batch_size: 300, dedup_fetch_limit: 200 (模拟 package.json 默认 200 合并)
    const auditResBatch300 = parseOut(await memoryAudit(mockProbeClient, {
      project: env.project,
      dedup_batch_size: 300,
      dedup_fetch_limit: 200,
    }, {}));
    assert.strictEqual(capturedListLimit, 300, "【反证门 2a 通过】：用户配置 dedup_batch_size=300 时拉取上限必须为 300，绝不得被 200 遮蔽！");
    assert.strictEqual(auditResBatch300.cursor.batch_size, 300, "返回 cursor.batch_size 必须为 300");

    // 显式传入 args.fetch_limit 优先级最高
    await memoryAudit(mockProbeClient, {
      project: env.project,
      dedup_batch_size: 300,
      dedup_fetch_limit: 200,
    }, { fetch_limit: 450 });
    assert.strictEqual(capturedListLimit, 450, "显式 args.fetch_limit 优先级高于用户配置");

    // 2c. MODEL_CHUNK 增加 [5, 60] 范围守卫
    await clearProjectRecords();
    for (let i = 1; i <= 30; i++) {
      await env.client.create("memories", {
        project: env.project,
        category: "fact",
        title: `模型分块测试条目 ${i}`,
        content: `模型分块正文详情 ${i}`,
        lifecycle_status: "active",
        recurrence: 1,
        tags: `chunk, test${i}`,
        created_at: NOW_STR,
        updated_at: NOW_STR,
      });
    }

    let sentModelItemCount = 0;
    const probeChunkFetch = async (url, reqOptions) => {
      try {
        const bodyStr = reqOptions && reqOptions.body;
        const parsed = typeof bodyStr === "string" ? JSON.parse(bodyStr) : bodyStr;
        if (parsed && parsed.messages && parsed.messages[1]) {
          const contentStr = parsed.messages[1].content;
          const match = contentStr.match(/【待去重记忆列表】：\n(\[.*?\])\n/s);
          if (match) {
            const list = JSON.parse(match[1]);
            sentModelItemCount = list.length;
          }
        }
      } catch (_) {
        // 忽略测试探针解析异常
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({ memory_duplicates: [], pitfall_duplicates: [] }),
            },
          }],
        }),
      };
    };

    const hubChunk25 = await MagpieMemoryHub({
      audit_model: "test-probe-model",
      audit_chunk_size: 25,
      audit_max_batches: 1,
      _fetch: probeChunkFetch,
    }, {
      client: env.client,
      ncb_instance: env.instance,
    });

    await hubChunk25.tool["memory_audit"].execute({
      project: env.project,
      full: true,
      max_model_batches: 1,
    });
    assert.strictEqual(sentModelItemCount, 25, "【反证门 2b 通过】：配置 audit_chunk_size=25 时送入模型条数必须精确为 25");

    console.log("  ✓ 【反证门 2 通过】：readOptions 字段完整且 batch_size/chunk 优先级与守卫正常！\n");

    // =================================================================
    // 3. 【反证门 3】P1-3 单条精确重复被丢弃 + 模型合并结果未过数字守卫
    // =================================================================
    console.log("▶ [Test 3] 【反证门 3】P1-3 单条精确重复被丢弃 + 模型合并结果未过数字守卫反证测试...");
    await clearProjectRecords();

    // 3a. 规则组主记录被模型选为另一组 primary + 规则组仅剩 1 条 dup 场景
    // R1 与 R2 构成规则组（相同内容指纹，R1 recurrence=2 确定为主记录，R2 recurrence=1 为 duplicate）
    const r1 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "Redis集群主从架构方案",
      content: "Redis 主从架构部署规范与内存容量规划详情",
      content_fingerprint: "fp_redis_cluster_schema",
      lifecycle_status: "active",
      recurrence: 2,
      tags: "redis, cluster",
      created_at: "2026-10-20 10:00:00",
      updated_at: "2026-10-20 10:02:00",
    });
    const r2 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "Redis集群主从架构方案",
      content: "Redis 主从架构部署规范与内存容量规划详情",
      content_fingerprint: "fp_redis_cluster_schema",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "redis, cluster",
      created_at: "2026-10-20 10:01:00",
      updated_at: "2026-10-20 10:01:00",
    });
    // R3 为语义同义改写条目（不与 R1/R2 命中确定性指纹规则）
    const r3 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "分布式缓存系统主备方案设计指南",
      content: "缓存高可用中间件主备拓扑与容量评估指南",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "redis, cache",
      created_at: "2026-10-20 10:02:00",
      updated_at: "2026-10-20 10:02:00",
    });

    const r1Id = Number(r1.id || r1.data?.id);
    const r2Id = Number(r2.id || r2.data?.id);
    const r3Id = Number(r3.id || r3.data?.id);

    // 构造模拟模型：模型将 R1 与 R3 判为重复（primary=R1, dups=[R3]）
    // 此时规则组 { primary: R1, duplicates: [R2] } 中，R1 已被模型触碰，未被处理的 duplicates 仅剩 [R2]（length=1）
    // 旧逻辑中 if (unhandledDups.length > 1) 为假导致 R2 被彻底抛弃！
    // 新逻辑将 R2 挂入 R1 所属的模型组一起软失效合并
    const mockModelOrphanFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              memory_duplicates: [
                {
                  primary_id: r1Id,
                  duplicate_ids: [r3Id],
                },
              ],
              pitfall_duplicates: [],
            }),
          },
        }],
      }),
    });

    const hubOrphan = await MagpieMemoryHub({
      audit_model: "test-orphan-model",
      _fetch: mockModelOrphanFetch,
    }, {
      client: env.client,
      ncb_instance: env.instance,
    });

    const orphanAuditRes = parseOut(await hubOrphan.tool["memory_audit"].execute({
      project: env.project,
      full: true,
    }));
    assert.strictEqual(orphanAuditRes.action, "DEDUP_REPORT");

    const memRowsAfterOrphan = rowsOf(await env.client.list("memories", { project: env.project, limit: 100 }));
    const rowR1 = memRowsAfterOrphan.find((r) => Number(r.id) === r1Id);
    const rowR2 = memRowsAfterOrphan.find((r) => Number(r.id) === r2Id);
    const rowR3 = memRowsAfterOrphan.find((r) => Number(r.id) === r3Id);

    assert.ok(rowR1 && rowR1.invalid_at == null, "主记录 R1 必须保持 active");
    assert.ok(rowR3 && rowR3.invalid_at != null, "模型指派重复 R3 必须被软失效");
    assert.ok(rowR2 && rowR2.invalid_at != null, "【反证门 3a 通过】：规则组主记录被模型触碰且仅剩 1 条 dup 时，该精确重复 R2 绝不得被丢弃，必须正确软失效！");
    assert.ok(rowR2.invalid_reason && rowR2.invalid_reason.includes(`into:${r1Id}`), "R2 软失效 invalid_reason 必须指向主记录 R1");

    // 3b. 构造模型误把 3306 与 3307 判为重复，断言数字守卫拦截不合并
    await clearProjectRecords();
    const num1 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "生产数据库连接端口配置",
      content: "MySQL 生产集群连接服务端口 3306 支持读写",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "mysql, port",
      created_at: "2026-10-20 11:00:00",
      updated_at: "2026-10-20 11:00:00",
    });
    const num2 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "灾备数据库连接端口配置",
      content: "MySQL 灾备集群连接服务端口 3307 支持只读",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "mysql, port",
      created_at: "2026-10-20 11:01:00",
      updated_at: "2026-10-20 11:01:00",
    });
    const num1Id = Number(num1.id || num1.data?.id);
    const num2Id = Number(num2.id || num2.data?.id);

    // 模拟大模型发生幻觉，把 3306 与 3307 判为重复
    const mockModelConflictNumFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              memory_duplicates: [
                {
                  primary_id: num1Id,
                  duplicate_ids: [num2Id],
                },
              ],
              pitfall_duplicates: [],
            }),
          },
        }],
      }),
    });

    const hubNumConflict = await MagpieMemoryHub({
      audit_model: "test-num-conflict-model",
      _fetch: mockModelConflictNumFetch,
    }, {
      client: env.client,
      ncb_instance: env.instance,
    });

    await hubNumConflict.tool["memory_audit"].execute({
      project: env.project,
      full: true,
    });

    const memRowsAfterNumConflict = rowsOf(await env.client.list("memories", { project: env.project, limit: 100 }));
    const rowNum1 = memRowsAfterNumConflict.find((r) => Number(r.id) === num1Id);
    const rowNum2 = memRowsAfterNumConflict.find((r) => Number(r.id) === num2Id);

    assert.ok(rowNum1.invalid_at == null, "num1 记录必须保持 active");
    assert.ok(rowNum2.invalid_at == null, "【反证门 3b 通过】：模型返回存在数字冲突 (3306 vs 3307) 时，数字守卫必须拦截，绝不得误合并！");
    assert.strictEqual(rowNum2.lifecycle_status, "active", "num2 记录必须保持 active");

    console.log("  ✓ 【反证门 3 通过】：单条精确重复孤儿成功挂载合并，且模型合并受数字守卫严密保护！\n");

    // =================================================================
    // 4. 【反证门 4】P1-5 pitfalls 软删记录过滤、分页截断判定与投影列补齐
    // =================================================================
    console.log("▶ [Test 4] 【反证门 4】P1-5 pitfalls 软删记录过滤、分页截断判定与投影列补齐反证测试...");
    await clearProjectRecords();

    // 4a. 构造包含软删记录的批次，断言以 rawRows.length 判定截断，防止提前断页
    // 插入 1 条软删除记录 + 2 条有效记录
    // 当拉取上限为 2 时，第一批拉取到 [P1(已软删), P2(有效)]
    // 过滤后有效行仅 1 条，旧逻辑 1 < 2 提前 break 导致 has_more 恒 false，P3 永久漏扫
    // 新逻辑以 rawRows.length (2 == 2) 判定截断，正确设置 has_more: true 并推进游标至 P2
    const pit1 = await env.client.create("pitfalls", {
      project: env.project,
      symptom: "历史遗留软失效踩坑 1",
      solution: "历史解决方案",
      root_cause: "旧版本缺陷",
      invalid_at: "2026-10-20 09:00:00",
      lifecycle_status: "invalid",
      recurrence: 1,
      tags: "pitfall, legacy",
      created_at: "2026-10-20 09:00:00",
      updated_at: "2026-10-20 09:00:00",
    });
    const pit2 = await env.client.create("pitfalls", {
      project: env.project,
      symptom: "活跃有效踩坑 2",
      solution: "排查连接池参数",
      root_cause: "超时时间过短",
      invalid_at: null,
      lifecycle_status: "active",
      recurrence: 1,
      tags: "pitfall, active2",
      created_at: "2026-10-20 09:01:00",
      updated_at: "2026-10-20 09:01:00",
    });
    const pit3 = await env.client.create("pitfalls", {
      project: env.project,
      symptom: "活跃有效踩坑 3",
      solution: "调整缓冲区大小",
      root_cause: "消息体积过大",
      invalid_at: null,
      lifecycle_status: "active",
      recurrence: 1,
      tags: "pitfall, active3",
      created_at: "2026-10-20 09:02:00",
      updated_at: "2026-10-20 09:02:00",
    });

    const pit2Id = Number(pit2.id || pit2.data?.id);
    const pit3Id = Number(pit3.id || pit3.data?.id);

    // 第一批审计（拉取批上限为 2）
    const pitAuditRes1 = parseOut(await memoryAudit(env.client, {
      project: env.project,
      dedup_fetch_limit: 2,
    }, {
      project: env.project,
      fetch_limit: 2,
      incremental: true,
    }));

    assert.strictEqual(pitAuditRes1.has_more, true, "【反证门 4a 通过】：批次内存在软删记录时，一律以 rawRows.length 判定截断，has_more 必须正确为 true！");
    assert.strictEqual(pitAuditRes1.cursor.current_last_pitfall_id, pit2Id, "游标必须成功推进至 P2 的 ID");

    // 增量审计继续拉取第二批，成功扫描并覆盖 P3
    const pitAuditRes2 = parseOut(await memoryAudit(env.client, {
      project: env.project,
      dedup_fetch_limit: 2,
    }, {
      project: env.project,
      fetch_limit: 2,
      incremental: true,
    }));
    assert.ok(pitAuditRes2.scanned.pitfalls >= 1, "第二批增量接力审计必须成功扫描到 P3 记录");
    assert.strictEqual(pitAuditRes2.cursor.current_last_pitfall_id, pit3Id, "第二批游标推进至 P3");

    // 4b. memories 投影列补齐 related_entities, invalid_at, expires_at 验证
    await clearProjectRecords();
    const ent1 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "网关认证服务架构规范",
      content: "JWT 校验与无状态服务设计原则",
      related_entities: "auth-service,redis-cache",
      expires_at: "2027-01-01 00:00:00",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "auth, gateway",
      created_at: "2026-10-20 10:00:00",
      updated_at: "2026-10-20 10:00:00",
    });
    const ent2 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "网关认证服务架构规范",
      content: "JWT 校验与无状态服务设计原则",
      related_entities: "api-gateway,jwt-token",
      expires_at: "2027-01-01 00:00:00",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "auth, gateway",
      created_at: "2026-10-20 10:01:00",
      updated_at: "2026-10-20 10:01:00",
    });

    await memoryAudit(env.client, { project: env.project }, { project: env.project, full: true });

    const memAfterEntAudit = rowsOf(await env.client.list("memories", { project: env.project, limit: 10 }));
    const mergedMaster = memAfterEntAudit.find((r) => !r.invalid_at);
    const softDup = memAfterEntAudit.find((r) => r.invalid_at != null);

    assert.ok(mergedMaster, "主记录必须存在且保持 active");
    assert.ok(softDup, "从记录必须被软失效");
    assert.ok(mergedMaster.related_entities && mergedMaster.related_entities.includes("api-gateway"), "【反证门 4b 通过】：memories 投影补齐 related_entities，合并后必须完整聚合被合并记录的实体！");
    assert.ok(mergedMaster.related_entities.includes("redis-cache"), "保留原主记录的实体标签");

    console.log("  ✓ 【反证门 4 通过】：pitfalls 截断判定杜绝断页，投影补齐字段验证完全合规！\n");

    // =================================================================
    // 5. 【规范自检】test_meta.mjs 规范合规自检与零残留断言
    // =================================================================
    console.log("▶ [Test 5] test_meta.mjs 规范合规自检与零残留断言...");
    const selfPath = fileURLToPath(import.meta.url);
    const selfCode = fs.readFileSync(selfPath, "utf8");
    const scanResult = scanTestFile(selfPath, selfCode);

    if (scanResult.issues.length > 0) {
      console.error("❌ test_v634_a_tools.mjs 存在 test_meta 规范违规:");
      for (const iss of scanResult.issues) {
        console.error("   - " + iss);
      }
      process.exit(1);
    }
    assert.strictEqual(scanResult.issues.length, 0, "本测试文件必须 100% 符合 test_meta 规范！");
    console.log("  ✓ 本测试文件经 test_meta 扫描，0 规范违规！");

  } catch (err) {
    console.error("❌ Test error inside try:", err);
    throw err;
  } finally {
    // 数据库清理与残余检测
    console.log(`\n[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "测试结束后数据库必须彻底清理，残余数必须为 0！");
    console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
  }
}

await run();
console.log("=================================================================");
console.log("✅ 全部 4 项 Agent A tools.js 整改与 4 大反证门 100% 顺利通过！");
console.log("=================================================================");
