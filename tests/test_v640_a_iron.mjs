/**
 * tests/test_v640_a_iron.mjs
 * =================================================================
 * v6.40-a 铁律死循环提示修复、更新残留与 EVO-18 双表演进感知专项测试套件
 *
 * 覆盖 4 大核心任务及全量双向反证矩阵：
 * 1. 【BUG-39-1 near_ironlaw 缺上界死循环提示双向反证】
 *    - a) rec=4, threshold=5, 根因真实 -> near_ironlaw 含它且 missing=1，_agent_hint 包含再记录提示（正向反证）；
 *    - b) rec=5, threshold=5, 根因真实 -> near_ironlaw 必须为空数组，_agent_hint 绝不得含再记录提示（新反向反证，阻止死循环）；
 *    - c) rec=6, threshold=5 -> near_ironlaw 同样为空数组（超界反向反证）。
 *
 * 2. 【BUG-39-4b 更新既有铁律漏写 confidence_score 双向反证】
 *    - a) 手工将既有铁律 confidence_score 改为 1，触发二次演进更新 -> 读回置信度自愈为 100（反证自愈能力）；
 *    - b) 更新后其余字段（content, tags, related_entities, content_fingerprint, recurrence）正常更新且不受破坏。
 *
 * 3. 【BUG-39-4c 唯一索引冲突兜底漏合并 tags 双向反证】
 *    - 模拟并发/唯一索引冲突路径（duplicate entry 且方案存在数字冲突）-> 新传入 tags 必须成功合并进库，原方案保留，recurrence 累加。
 *
 * 4. 【EVO-18 memory_context 双表全向演进契机双向反证】
 *    - a) preference rec=4 conf=90 -> 必须进入 near_crystallization 且 missing=1，_agent_hint 追加提示；
 *    - b) preference rec=4 conf=70 -> 严禁进入 near_crystallization（置信度不足 80 反证）；
 *    - c) decision rec=3 conf=90 -> 严禁进入 near_crystallization（未达 threshold - 1 反证）；
 *    - d) 纯净场景无候选时 -> near_crystallization 为空/省略。
 *
 * 5. 【元规范自检与零残留】
 *    - scanTestFile 门禁自检 0 违规，createTestEnv 隔离运行，结束后 0 残留断言。
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { MagpieMemoryHub } from "../tools.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []);

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

async function run() {
  const env = await createTestEnv("v640_a_iron");
  console.log("=================================================================");
  console.log("【v6.40-a 铁律死循环修复、更新残留与 EVO-18 双表演进感知双向反证套件】");
  console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
  console.log("=================================================================\n");

  try {
    const hub = await MagpieMemoryHub({}, { client: env.client, ncb_instance: env.instance });
    const pitSave = hub.tool["pitfall_save"];
    const memSave = hub.tool["memory_save"];
    const memContext = hub.tool["memory_context"];

    // =============================================================
    // 1. BUG-39-1: near_ironlaw 缺上界死循环提示双向反证
    // =============================================================
    console.log("▶ [Test 1] BUG-39-1 near_ironlaw 缺上界死循环提示双向反证...");

    const pitSymptom1 = "Redis 缓存穿透导致大量瞬时请求直击后端数据库引起崩溃";
    const pitRc1 = "高并发查询不存在的键且未配置布隆过滤器与空值缓存";
    const pitSol1 = "部署 Google Guava 布隆过滤器并在 CacheManager 对空查询结果设置 60s 缓存";

    // 1.a rec=4, threshold=5, 真实根因 -> near_ironlaw 包含该项且 missing=1
    const pit1 = parseOut(await pitSave.execute({
      project: env.project,
      component: "redis",
      symptom: pitSymptom1,
      root_cause: pitRc1,
      solution: pitSol1,
      recurrence: 4,
      tags: "redis, cache, db",
    }, {}));
    assert.strictEqual(pit1.action, "ADD");
    assert.ok(pit1.id, "踩坑记录必须创建成功");

    const ctxResRec4 = parseOut(await memContext.execute({
      project: env.project,
      query: "redis 缓存 穿透 崩溃",
      crystallization_threshold: 5,
    }, {}));

    assert.ok(ctxResRec4.evolution_opportunities, "rec=4 时必须包含 evolution_opportunities 字段");
    assert.ok(Array.isArray(ctxResRec4.evolution_opportunities.near_ironlaw), "near_ironlaw 必须为数组");
    const nearItemRec4 = ctxResRec4.evolution_opportunities.near_ironlaw.find((x) => x.id === pit1.id);
    assert.ok(nearItemRec4, "【反证门 1.a 通过】：rec=4, threshold=5 时 near_ironlaw 必须包含该踩坑");
    assert.strictEqual(nearItemRec4.missing, 1, "missing 必须为 1");
    assert.strictEqual(nearItemRec4.recurrence, 4, "recurrence 必须为 4");
    assert.ok(
      ctxResRec4._agent_hint.includes("再记录 1 次该故障即可自动生成铁律"),
      "【反证门 1.a 提示通过】：rec=4 时 _agent_hint 必须提示再记录 1 次生成铁律"
    );
    console.log("  ✓ 1.a rec=4, threshold=5 正向反证通过（near_ironlaw 含它且 missing=1，提示生成铁律）");

    // 1.b rec=5, threshold=5, 真实根因 -> near_ironlaw 必须为空数组，死循环提示必须解除！
    await env.client.update("pitfalls", pit1.id, {
      recurrence: 5,
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });

    const ctxResRec5 = parseOut(await memContext.execute({
      project: env.project,
      query: "redis 缓存 穿透 崩溃",
      crystallization_threshold: 5,
    }, {}));

    const nearItemsRec5 = ctxResRec5.evolution_opportunities?.near_ironlaw || [];
    assert.ok(
      !nearItemsRec5.some((x) => x.id === pit1.id),
      "【反证门 1.b 核心反证通过】：rec=5 已达阈值，near_ironlaw 绝不得再包含该记录！"
    );
    assert.ok(
      !ctxResRec5._agent_hint.includes("再记录 1 次该故障即可自动生成铁律"),
      "【反证门 1.b 提示反证通过】：rec=5 时 _agent_hint 绝不得再输出死循环提示！"
    );
    console.log("  ✓ 1.b rec=5, threshold=5 反向反证通过（near_ironlaw 为空，彻底杜绝死循环提示）");

    // 1.c rec=6, threshold=5 -> 同样严禁出现
    await env.client.update("pitfalls", pit1.id, {
      recurrence: 6,
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });

    const ctxResRec6 = parseOut(await memContext.execute({
      project: env.project,
      query: "redis 缓存 穿透 崩溃",
      crystallization_threshold: 5,
    }, {}));

    const nearItemsRec6 = ctxResRec6.evolution_opportunities?.near_ironlaw || [];
    assert.ok(
      !nearItemsRec6.some((x) => x.id === pit1.id),
      "【反证门 1.c 超界反证通过】：rec=6 超出阈值，near_ironlaw 绝不得包含该记录！"
    );
    assert.ok(!ctxResRec6._agent_hint.includes("再记录"), "rec=6 时 _agent_hint 不含再记录提示");
    console.log("  ✓ 1.c rec=6, threshold=5 超界反向反证通过（near_ironlaw 为空）\n");

    // =============================================================
    // 2. BUG-39-4b: 更新既有铁律漏写 confidence_score 双向反证
    // =============================================================
    console.log("▶ [Test 2] BUG-39-4b 更新既有铁律漏写 confidence_score 双向反证...");

    const pitSymptom2 = "PostgreSQL 慢事务长周期未提交导致 vacuum 无法清理死元组引起表剧烈膨胀";
    const pitRc2 = "报表离线服务长连接开启事务后由于长耗时导出导致 xmin 长期钉死不动";
    const pitSol2 = "服务端配置 idle_in_transaction_session_timeout 强制中断空闲悬挂长事务";

    // 2.a 创建一条铁律（recurrence=5）
    const ironCreateRes = parseOut(await pitSave.execute({
      project: env.project,
      component: "postgresql",
      symptom: pitSymptom2,
      root_cause: pitRc2,
      solution: pitSol2,
      recurrence: 5,
      tags: "postgres, vacuum, transaction",
      related_entities: "postgres, dba",
    }, {}));

    assert.strictEqual(ironCreateRes.ironlaw_created, true, "初次创建必须生成铁律");
    assert.ok(ironCreateRes.ironlaw_id, "必须返回铁律记录 ID");
    const ironId = ironCreateRes.ironlaw_id;

    // 手工将既有铁律的 confidence_score 改为 1（模拟历史脏数据/误改）
    await env.client.update("memories", ironId, {
      confidence_score: 1,
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    const tamperedMem = rowsOf(await env.client.list("memories", { id: ironId, limit: 1 }))[0];
    assert.strictEqual(tamperedMem.confidence_score, 1, "预埋反证条件：已手工篡改为 1");

    // 触发二次演进更新（解法无数字冲突，长度扩充超过 1.3 倍）
    const evolvedSol2 = pitSol2 + " 并通过 pg_stat_activity 实时监控长事务持有者，在客户端报表服务中引入流式游标分批拉取避免长连接堆积事务";
    const ironEvolveRes = parseOut(await pitSave.execute({
      project: env.project,
      component: "postgresql",
      symptom: pitSymptom2,
      root_cause: pitRc2,
      solution: evolvedSol2,
      recurrence: 1,
      tags: "postgres, vacuum, tuning, evolved",
      related_entities: "postgres, analytics",
    }, {}));

    assert.strictEqual(ironEvolveRes.action, "EVOLVED", "解法显著扩展必须触发 EVOLVED");
    assert.strictEqual(ironEvolveRes.ironlaw_created, true);
    assert.strictEqual(ironEvolveRes.ironlaw_id, ironId, "更新必须作用在同一铁律 ID 上");

    // 读回铁律，断言 confidence_score 已自愈为 100
    const healedMem = rowsOf(await env.client.list("memories", { id: ironId, limit: 1 }))[0];
    assert.ok(healedMem, "铁律记录必须存在");
    assert.strictEqual(
      healedMem.confidence_score,
      100,
      "【反证门 2.a 通过】：更新既有铁律时 confidence_score 必须自愈为整数量纲 100（非 1、非 1.0）！"
    );
    assert.notStrictEqual(healedMem.confidence_score, 1, "反证断言：confidence_score 不得残留为 1");

    // 2.b 其余字段不受影响且正确演进
    assert.ok(healedMem.content.includes("pg_stat_activity"), "content 必须包含演进后的新解法");
    const healedTags = String(healedMem.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase());
    assert.ok(healedTags.includes("pitfall-ironlaw"), "tags 必须包含 pitfall-ironlaw 标识");
    assert.ok(healedTags.includes("evolved"), "tags 必须合并演进传入的新标签 evolved");
    const healedEntities = String(healedMem.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase());
    assert.ok(healedEntities.includes("postgresql"), "related_entities 必须包含 component");
    assert.ok(healedEntities.includes("analytics"), "related_entities 必须合并演进传入的新实体");
    assert.strictEqual(healedMem.recurrence, 2, "recurrence 必须正确递增");
    console.log("  ✓ 2.a~2.b 既有铁律置信度自愈 100 且其余字段演进反证通过\n");

    // =============================================================
    // 3. BUG-39-4c: 唯一索引冲突兜底漏合并 tags 双向反证
    // =============================================================
    console.log("▶ [Test 3] BUG-39-4c 唯一索引冲突兜底漏合并 tags 双向反证...");

    const pitSymptom3 = "Elasticsearch 批量写入请求被限流拒绝且返回 429 Too Many Requests";
    const pitRc3 = "write 线程池阻塞队列被大量并发 bulk 挤爆且底层 NVMe 磁盘 IOPS 耗尽";
    const pitSol3 = "设置 write 线程池 queue_size=1000 并限制单次 bulk 请求文档批次为 500 条";

    // 预先创建一条初始踩坑记录
    const initialPit3 = parseOut(await pitSave.execute({
      project: env.project,
      component: "elasticsearch",
      symptom: pitSymptom3,
      root_cause: pitRc3,
      solution: pitSol3,
      recurrence: 2,
      tags: "es, bulk, initial-tag",
    }, {}));
    assert.strictEqual(initialPit3.action, "ADD");
    const targetPitId = initialPit3.id;

    // 模拟唯一索引冲突并发竞态：拦截 client.list 初次查询（返回空）使之跳过前置 dup 检索，直达 client.create
    // client.create 抛出 Duplicate entry 异常，进入 catch 块
    const origList = env.client.list.bind(env.client);
    const origCreate = env.client.create.bind(env.client);

    let listIntercepted = false;
    let createIntercepted = false;

    env.client.list = async (tbl, params) => {
      if (tbl === "pitfalls" && !listIntercepted) {
        listIntercepted = true;
        // 第一次 list 返回空列表，模拟写入前读未命中
        return { data: [] };
      }
      return origList(tbl, params);
    };

    env.client.create = async (tbl, payload) => {
      if (tbl === "pitfalls" && !createIntercepted) {
        createIntercepted = true;
        throw new Error("Duplicate entry 'fake_fp' for key 'idx_pitfalls_uniq_fp'");
      }
      return origCreate(tbl, payload);
    };

    // 新解法存在数字冲突（1000 vs 2000, 500 vs 800），必须走 hasSolConflict 保护分支
    const conflictingSol = "设置 write 线程池 queue_size=2000 并限制单次 bulk 请求文档批次为 800 条";
    const dupConflictRes = parseOut(await pitSave.execute({
      project: env.project,
      component: "elasticsearch",
      symptom: pitSymptom3,
      root_cause: pitRc3,
      solution: conflictingSol,
      recurrence: 1,
      tags: "es, bulk, conflict-patch, v640",
    }, {}));

    // 恢复 client 方法
    env.client.list = origList;
    env.client.create = origCreate;

    assert.strictEqual(dupConflictRes.action, "NOOP");
    assert.ok(
      dupConflictRes.note && dupConflictRes.note.includes("数字冲突"),
      "必须命中方案数字冲突保护分支"
    );

    // 查库验证 tags 必须成功合并 conflict-patch 与 v640
    const pit3InDb = rowsOf(await env.client.list("pitfalls", { id: targetPitId, limit: 1 }))[0];
    assert.ok(pit3InDb, "必须查到目标踩坑记录");
    const mergedTagsList = String(pit3InDb.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase());
    assert.ok(
      mergedTagsList.includes("initial-tag"),
      "库中原有 tags (initial-tag) 必须保留"
    );
    assert.ok(
      mergedTagsList.includes("conflict-patch") && mergedTagsList.includes("v640"),
      "【反证门 3 通过】：唯一索引冲突兜底分支中，新传入 tags (conflict-patch, v640) 必须成功合并入库！"
    );
    assert.strictEqual(pit3InDb.recurrence, 3, "recurrence 必须正确累加至 3");
    assert.ok(pit3InDb.solution.includes("1000"), "存在数字冲突时原方案解法必须保留，禁止覆盖");
    console.log("  ✓ 3. 唯一索引冲突兜底漏合并 tags 反证通过（新传入 tags 成功合并且原解法保留）\n");

    // =============================================================
    // 4. EVO-18: memory_context 双表全向演进契机双向反证
    // =============================================================
    console.log("▶ [Test 4] EVO-18 memory_context 双表全向演进契机双向反证...");

    // a) preference, rec=4, conf=90 -> 必须进入 near_crystallization
    const mem1 = parseOut(await memSave.execute({
      project: env.project,
      category: "preference",
      title: "微服务对外接口通信规范偏好：所有对外 API 强制统一采用驼峰命名与统一响应 Envelope",
      content: "系统偏好定义：对外 HTTP/RPC 服务一律输出统一结构体",
      recurrence: 4,
      confidence: 90,
      tags: "api, microservice, preference, rpc",
    }, {}));
    assert.strictEqual(mem1.action, "ADD");
    assert.ok(mem1.id);

    // b) preference, rec=4, conf=70 -> 严禁进入 near_crystallization（置信度门槛 < 80）
    const mem2 = parseOut(await memSave.execute({
      project: env.project,
      category: "preference",
      title: "前端微应用样式隔离偏好：单页架构中优先选用 CSS Modules 方案隔离全局样式污染",
      content: "样式隔离偏好：使用 CSS Modules 规避不同微应用样式类名重叠污染",
      recurrence: 4,
      confidence: 70,
      tags: "css, frontend, preference, microservice",
    }, {}));
    assert.strictEqual(mem2.action, "ADD");
    assert.ok(mem2.id);

    // c) decision, rec=3, conf=90 -> 严禁进入 near_crystallization（未达 threshold-1 = 4 门槛）
    const mem3 = parseOut(await memSave.execute({
      project: env.project,
      category: "decision",
      title: "海量日志传输消息队列选型决策：针对高吞吐日志聚合场景选用 Apache Kafka 作为消息管道",
      content: "技术选型决策：日志收集通道统一接入 Kafka，吞吐量优先，规避 RabbitMQ 内存挤占风险",
      recurrence: 3,
      confidence: 90,
      tags: "kafka, logging, decision, microservice",
    }, {}));
    assert.strictEqual(mem3.action, "ADD");
    assert.ok(mem3.id);

    // 调用 memory_context 检索，命中上述 3 条记录
    const evoCtxRes = parseOut(await memContext.execute({
      project: env.project,
      query: "微服务 接口 通信 规范 样式 日志 选型 偏好 决策",
      crystallization_threshold: 5,
      max_items: 10,
    }, {}));

    assert.ok(evoCtxRes.evolution_opportunities, "存在演进契机时 evolution_opportunities 必须存在");
    assert.ok(
      Array.isArray(evoCtxRes.evolution_opportunities.near_crystallization),
      "near_crystallization 必须为数组"
    );

    const nearCrystList = evoCtxRes.evolution_opportunities.near_crystallization;

    // 4.a 断言 mem1 必须存在
    const foundMem1 = nearCrystList.find((x) => x.id === mem1.id);
    assert.ok(
      foundMem1,
      "【反证门 4.a 通过】：preference, rec=4, conf=90 必须成功进入 near_crystallization！"
    );
    assert.strictEqual(foundMem1.category, "preference");
    assert.strictEqual(foundMem1.recurrence, 4);
    assert.strictEqual(foundMem1.missing, 1);
    assert.ok(foundMem1.title.length <= 60, "title 必须截断前 60 字以内");

    // 4.b 断言 mem2 (conf=70) 严禁进入
    assert.ok(
      !nearCrystList.some((x) => x.id === mem2.id),
      "【反证门 4.b 通过】：confidence_score < 80 (70) 的记录绝不得进入 near_crystallization！"
    );

    // 4.c 断言 mem3 (rec=3) 严禁进入
    assert.ok(
      !nearCrystList.some((x) => x.id === mem3.id),
      "【反证门 4.c 通过】：recurrence < 4 (3) 的记录绝不得进入 near_crystallization！"
    );

    // 4.d 动态 _agent_hint 断言
    assert.ok(
      evoCtxRes._agent_hint.includes("另有 1 条偏好/决策再印证 1 次即可结晶为准则。"),
      "【反证门 4.d 通过】：_agent_hint 必须动态追加偏好/决策结晶提示！"
    );
    console.log("  ✓ 4.a~4.d near_crystallization 准入门槛与动态 hint 反证通过");

    // 4.e 纯净场景反向反证：无候选时 near_crystallization 为空或省略
    const cleanCtxRes = parseOut(await memContext.execute({
      project: env.project,
      query: "不存在的不相关主题",
    }, {}));

    const crystEmpty =
      !cleanCtxRes.evolution_opportunities ||
      !cleanCtxRes.evolution_opportunities.near_crystallization ||
      cleanCtxRes.evolution_opportunities.near_crystallization.length === 0;

    assert.ok(
      crystEmpty,
      "【反证门 4.e 通过】：无候选时 near_crystallization 必须为空或省略！"
    );
    assert.ok(
      !cleanCtxRes._agent_hint.includes("偏好/决策再印证"),
      "无候选时 _agent_hint 绝不得含偏好/决策结晶提示"
    );
    console.log("  ✓ 4.e 纯净场景无候选时 near_crystallization 为空/省略反向反证通过\n");

    // =============================================================
    // 5. 元规范自检与零残留
    // =============================================================
    console.log("▶ [自检] test_meta 规范合规自检与零残留断言...");
    const selfPath = fileURLToPath(import.meta.url);
    const selfCode = fs.readFileSync(selfPath, "utf8");
    const scanRes = scanTestFile(selfPath, selfCode);
    if (scanRes.issues.length > 0) {
      console.error("❌ 本测试存在 test_meta 规范违规:");
      for (const iss of scanRes.issues) console.error("   -", iss);
    }
    assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 100% 符合 test_meta 规范");
    console.log("  ✓ test_meta 自检 0 违规");

  } catch (err) {
    console.error("❌ 测试执行异常:", err);
    throw err;
  } finally {
    console.log(`\n[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "测试结束后数据库必须 0 残留");
    console.log("✅ 【零残留断言通过】：测试数据已彻底清除！");
  }
}

await run();
console.log("=================================================================");
console.log("✅ v6.40-a 全部 4 大任务与双向反证门 100% 顺利通过！");
console.log("=================================================================");
