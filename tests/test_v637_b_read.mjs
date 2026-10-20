/**
 * tests/test_v637_b_read.mjs
 * =================================================================
 * v6.37-b 读取与入口链路修复与演进专项双向反证测试套件
 *
 * 覆盖 4 大核心任务与双向反证靶场：
 * 1. 【BUG-2 高危：memory_context 与 memory_list 参数容错与项目继承】
 *    - 正向反证：传 q: "Redis" 调 memory_context 正常映射到 query 召回结果；
 *    - 反向反证：同时传 query 与 q 时，保留 query，绝不被 q 覆盖篡改；
 *    - 隔离反证：缺省 project 时自动继承 cfg.project，杜绝跨项目全表串扰泄漏。
 * 2. 【BUG-4 中危：memory_search 补齐 related_entities 投影】
 *    - 正向反证：memory_search 返回的 memories 条目必包含 related_entities 字段；
 *    - 容错反证：无实体记录返回 null，字段结构始终对齐。
 * 3. 【BUG-4 中危：memory_get 自动回退 pitfalls 与优先级】
 *    - 正向反证：未传 table 且 ID 属于 pitfalls 时，自动回退并标记 table:"pitfalls", auto_fallback:true；
 *    - 优先级反证：memories 存在该 ID 时严格优先返回 memories，不触发 fallback；
 *    - 批量反证：批量 ids 支持混合跨表展开与回退。
 * 4. 【BUG-4 中危：memory_forget 批量软失效与单条兼容】
 *    - 正向反证：传 ids: [1, 2] 批量软失效，返回 forgotten: 2 与逐条 items；
 *    - 兼容反证：单条 id: 1 保持 100% 格式兼容；
 *    - 跨表反证：支持 table: "pitfalls" 批量软失效。
 * 5. 【EVO-9b：memory_get revision > 1 附带 superseded_history】
 *    - 正向反证：多次迭代升维的记录返回前序版本摘要列表（最多 3 条）；
 *    - 真实反证：原地增量无历史存储时返回空数组且 note 声明“历史版本未持久化”，不伪造数据；
 *    - 边界反证：revision === 1 的初版记忆绝不携带 superseded_history 字段。
 * 6. 【EVO-10：memory_list 返回 knowledge_profile 自省画像】
 *    - 正向反证：正确输出 principle_count、preference_count、decision_count、total_active；
 *    - 临界反证：recurrence >= threshold - 1 的高频偏好/决策准确定位至 near_crystallization；
 *    - 防误报反证：未达门禁阈值时 near_crystallization 严格为空数组，绝不虚报。
 * 7. 【test_meta 规范元检查自证】
 *    - 命名空间隔离、强制 cleanup、0 残留断言、scanTestFile 静态扫描 0 违规。
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MagpieMemoryHub } from "../tools.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

const parseOut = (res) => {
  if (typeof res === "string") {
    try {
      return JSON.parse(res);
    } catch (_) {
      return res;
    }
  }
  return res;
};

const rowsOf = (res) => {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res.rows)) return res.rows;
  return [];
};

console.log("=================================================================");
console.log("【v6.37-b 读取与入口链路修复与演进专项双向反证测试套件】");
const env = await createTestEnv({ mode: "memory" });
const otherEnv = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 主测试隔离命名空间: ${env.project}`);
console.log(`[testenv] 辅助隔离命名空间: ${otherEnv.project}`);
console.log("=================================================================\n");

try {
  const hub = await env.createHub({
    crystallization_threshold: 5,
  });
  const otherHub = await otherEnv.createHub();

  // -----------------------------------------------------------------
  // 1. 【BUG-2】memory_context 与 memory_list 参数容错与项目继承
  // -----------------------------------------------------------------
  console.log("▶ [Test 1] 【BUG-2】memory_context 与 memory_list 参数容错与项目继承双向反证...");

  // 1.1 写入测试基准数据（使用 fact 类型检验 query 检索命中）
  const mRedis = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: "Redis Cluster 分片路由事实",
    content: "Redis 集群采用 16384 个虚拟槽位进行数据路由分片",
    category: "fact",
    tags: "redis,cluster,slot",
  }));
  assert.strictEqual(mRedis.action, "ADD");

  const mPostgres = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: "PostgreSQL 连接池上限事实",
    content: "统一设置 max_connections 为 100 且开启空闲回收",
    category: "fact",
    tags: "postgres,pool",
  }));
  assert.strictEqual(mPostgres.action, "ADD");

  // 在隔离的其他 project 中写入一条数据，检验是否会跨项目泄漏
  const mOtherLeak = parseOut(await otherHub.tool["memory_save"].execute({
    project: otherEnv.project,
    title: "跨项目机密配置泄漏排查",
    content: "这是其他项目的私有密钥配置，绝不可出现在当前项目的 context 中",
    category: "fact",
    tags: "secret,leak",
  }));
  assert.strictEqual(mOtherLeak.action, "ADD");

  // 1.2 正向验证：传 q: "Redis" 调 memory_context 必须成功召回 Redis 记忆
  const ctxResQ = parseOut(await hub.tool["memory_context"].execute({
    project: env.project,
    q: "Redis",
  }));
  assert.ok(
    ctxResQ && ctxResQ.block && ctxResQ.block.includes("Redis Cluster 分片路由事实"),
    "【反证门 1.2 通过】：传 q 必须能自动映射为 query 并召回对应记忆"
  );

  // 1.3 反向反证：已有 query 存在时，绝不被冲突的 q 覆盖
  const ctxResPreserve = parseOut(await hub.tool["memory_context"].execute({
    project: env.project,
    query: "PostgreSQL",
    q: "Redis",
  }));
  assert.ok(
    ctxResPreserve && ctxResPreserve.block && ctxResPreserve.block.includes("PostgreSQL 连接池上限事实"),
    "【反证门 1.3 通过】：已有 query 优先级最高，绝不被歧义 q 覆盖"
  );
  assert.ok(
    !ctxResPreserve.block.includes("Redis Cluster 分片路由事实"),
    "【反证门 1.3 通过】：查询保持为 PostgreSQL，不得命中 Redis"
  );

  // 1.4 项目继承与防跨项目泄漏反证：缺省 project 时必须继承 cfg.project
  const ctxResInherit = parseOut(await hub.tool["memory_context"].execute({
    q: "分片", // 缺省 project，依赖 normalizeToolArgs 继承 cfg.project (即 env.project)
  }));
  assert.ok(
    ctxResInherit && ctxResInherit.block && ctxResInherit.block.includes("Redis Cluster 分片路由事实"),
    "【反证门 1.4a 通过】：memory_context 缺省 project 成功继承 cfg.project 召回本项记忆"
  );
  assert.ok(
    !ctxResInherit.block.includes("跨项目机密配置泄漏排查"),
    "【反证门 1.4b 通过】：memory_context 绝不拉取其他项目的记录，杜绝跨项目串扰！"
  );

  // 1.5 memory_list 缺省 project 继承验证
  const listResInherit = parseOut(await hub.tool["memory_list"].execute({
    limit: 10, // 缺省 project
  }));
  const listMemories = listResInherit.memories || [];
  assert.ok(listMemories.length >= 2, "memory_list 缺省 project 应返回当前项目的活跃记忆");
  for (const m of listMemories) {
    assert.ok(
      m.project === env.project || m.project === "global",
      `【反证门 1.5 通过】：memory_list 记录必须严格属于 ${env.project} 或 global，实际: ${m.project}`
    );
  }

  console.log("  ✓ 1. BUG-2 memory_context/list 参数映射与项目继承双向反证全部通过！\n");

  // -----------------------------------------------------------------
  // 2. 【BUG-4】memory_search 补齐 related_entities 投影
  // -----------------------------------------------------------------
  console.log("▶ [Test 2] 【BUG-4】memory_search 补齐 related_entities 投影字段验证...");

  const mWithEntities = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: "Prisma 实体关系定义规范",
    content: "使用 Prisma Schema 规范约束数据模型的一对多与多对多关联",
    related_entities: "Prisma,PostgreSQL,Schema",
    tags: "prisma,orm",
  }));
  assert.strictEqual(mWithEntities.action, "ADD");

  const searchRes = parseOut(await hub.tool["memory_search"].execute({
    project: env.project,
    query: "Prisma",
  }));

  const foundItem = (searchRes.memories || []).find((m) => m.id === mWithEntities.id);
  assert.ok(foundItem, "memory_search 必须召回刚才保存的 Prisma 记录");
  assert.strictEqual(
    foundItem.related_entities,
    "Prisma,PostgreSQL,Schema",
    "【反证门 2.1 通过】：memory_search 返回的 memories 条目必包含 related_entities 且值正确！"
  );

  // 针对未设置实体的记录，验证其字段优雅保持 null
  const foundNoEntity = (searchRes.memories || []).find((m) => m.id === mRedis.id);
  if (foundNoEntity) {
    assert.strictEqual(
      foundNoEntity.related_entities,
      null,
      "【反证门 2.2 通过】：未传 related_entities 的记录优雅返回 null"
    );
  }

  console.log("  ✓ 2. BUG-4 memory_search related_entities 投影验证通过！\n");

  // -----------------------------------------------------------------
  // 3. 【BUG-4】memory_get 自动回退 pitfalls 与优先级双向反证
  // -----------------------------------------------------------------
  console.log("▶ [Test 3] 【BUG-4】memory_get 自动回退 pitfalls 与优先级双向反证...");

  // 3.1 创建一条独占的 pitfall
  const pSymptom = parseOut(await hub.tool["pitfall_save"].execute({
    project: env.project,
    component: "vite_hmr",
    symptom: "Vite 热更新报 WebSocket 连接丢包",
    solution: "配置 server.hmr.clientPort 映射外网端口",
    tags: "vite,hmr",
  }));
  assert.strictEqual(pSymptom.action, "ADD");
  const pitId = pSymptom.id;

  // 确认在 memories 表无此 id（由 autoId 单调递增保证，或通过 list 断言）
  const memCheck = rowsOf(await env.client.list("memories", { id: pitId }));
  let targetPitId = pitId;
  if (memCheck.length > 0) {
    const pAnother = parseOut(await hub.tool["pitfall_save"].execute({
      project: env.project,
      symptom: "Unique Pitfall Probe Symptom",
      solution: "Unique Solution Fix",
    }));
    targetPitId = pAnother.id;
  }

  // 3.2 正向验证：未传 table，memory_get 查 memories 无果时自动回退 pitfalls
  const fallbackGet = parseOut(await hub.tool["memory_get"].execute({
    id: targetPitId, // 不传 table
  }));
  assert.strictEqual(
    fallbackGet.table,
    "pitfalls",
    "【反证门 3.2a 通过】：未传 table 且 memories 查无时，必须成功回退并标记 table: 'pitfalls'"
  );
  assert.strictEqual(
    fallbackGet.auto_fallback,
    true,
    "【反证门 3.2b 通过】：回退成功时必须标 auto_fallback: true"
  );
  assert.ok(
    String(fallbackGet.content).includes("【症状】") && String(fallbackGet.solution).length > 0,
    "【反证门 3.2c 通过】：回退返回完整的踩坑排障正文与解法"
  );

  // 3.3 优先级反证：当 memories 存在该 ID 时，严格优先 memories，绝不误回退
  const memGetDirect = parseOut(await hub.tool["memory_get"].execute({
    id: mRedis.id, // 不传 table，目标是真实 memory
  }));
  assert.strictEqual(memGetDirect.id, mRedis.id);
  assert.strictEqual(memGetDirect.table, undefined, "memories 记录不应标 table: 'pitfalls'");
  assert.strictEqual(memGetDirect.auto_fallback, undefined, "memories 优先命中时绝不得触发 auto_fallback");
  assert.strictEqual(memGetDirect.title, "Redis Cluster 分片路由事实");

  // 3.4 批量读取中的混合跨表与自动回退验证
  const batchGetRes = parseOut(await hub.tool["memory_get"].execute({
    ids: [mRedis.id, targetPitId], // 不传 table，混合 memory 与 pitfall ID
  }));
  assert.ok(Array.isArray(batchGetRes), "批量读取必须返回数组");
  assert.strictEqual(batchGetRes.length, 2, "批量读取应正确获取两条记录");
  const bMem = batchGetRes.find((x) => x.id === mRedis.id);
  const bPit = batchGetRes.find((x) => x.id === targetPitId);
  assert.ok(bMem && !bMem.auto_fallback, "批量中的 memory 项严格正常展开");
  assert.ok(bPit && bPit.auto_fallback === true && bPit.table === "pitfalls", "批量中的 pitfall 项成功自动回退");

  console.log("  ✓ 3. BUG-4 memory_get 自动回退 pitfalls 与优先级双向反证通过！\n");

  // -----------------------------------------------------------------
  // 4. 【BUG-4】memory_forget 批量软失效与单条兼容
  // -----------------------------------------------------------------
  console.log("▶ [Test 4] 【BUG-4】memory_forget 批量软失效与单条兼容反证...");

  // 4.1 写入 2 条用于测试批量失效的 memories
  const mBatch1 = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: "Batch Forget Target 1",
    content: "Content 1 to be forgotten",
  }));
  const mBatch2 = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: "Batch Forget Target 2",
    content: "Content 2 to be forgotten",
  }));

  // 批量失效调用
  const forgetBatchRes = parseOut(await hub.tool["memory_forget"].execute({
    ids: [mBatch1.id, mBatch2.id],
  }));
  assert.strictEqual(forgetBatchRes.action, "SOFT_DELETE");
  assert.strictEqual(forgetBatchRes.forgotten, 2, "【反证门 4.1a 通过】：批量失效计数应为 2");
  assert.strictEqual(forgetBatchRes.items.length, 2, "【反证门 4.1b 通过】：items 数组应包含 2 条详情");

  // 验证底层数据库状态已写入 invalid_at 且 lifecycle_status 为 invalid
  const checkM1 = rowsOf(await env.client.list("memories", { id: mBatch1.id }))[0];
  const checkM2 = rowsOf(await env.client.list("memories", { id: mBatch2.id }))[0];
  assert.ok(checkM1.invalid_at != null && checkM1.lifecycle_status === "invalid");
  assert.ok(checkM2.invalid_at != null && checkM2.lifecycle_status === "invalid");

  // 4.2 单条失效保持 100% 格式兼容
  const mSingle = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: "Single Forget Target",
    content: "Content to be forgotten single",
  }));
  const forgetSingleRes = parseOut(await hub.tool["memory_forget"].execute({
    id: mSingle.id,
  }));
  assert.strictEqual(forgetSingleRes.action, "SOFT_DELETE");
  assert.strictEqual(forgetSingleRes.forgotten, 1, "【反证门 4.2 通过】：单条失效计数为 1 且格式一致");

  // 4.3 批量软失效 pitfalls 跨表支持
  const pBatch1 = parseOut(await hub.tool["pitfall_save"].execute({
    project: env.project,
    symptom: "Pitfall Batch Forget 1",
    solution: "Solution 1",
  }));
  const pBatch2 = parseOut(await hub.tool["pitfall_save"].execute({
    project: env.project,
    symptom: "Pitfall Batch Forget 2",
    solution: "Solution 2",
  }));
  const forgetPitBatchRes = parseOut(await hub.tool["memory_forget"].execute({
    table: "pitfalls",
    ids: [pBatch1.id, pBatch2.id],
  }));
  assert.strictEqual(forgetPitBatchRes.action, "SOFT_DELETE");
  assert.strictEqual(forgetPitBatchRes.table, "pitfalls");
  assert.strictEqual(forgetPitBatchRes.forgotten, 2);

  console.log("  ✓ 4. BUG-4 memory_forget 批量与单条软失效反证通过！\n");

  // -----------------------------------------------------------------
  // 5. 【EVO-9b】memory_get revision > 1 时附带 superseded_history
  // -----------------------------------------------------------------
  console.log("▶ [Test 5] 【EVO-9b】memory_get revision > 1 附带 superseded_history 反证...");

  // 5.1 创建多版本记忆（通过同标题不同内容触发 supersede 机制）
  const v1Title = "微服务接口版本迭代规范";
  const memV1 = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: v1Title,
    content: "第一版规范：所有对外 API 必须携带 /v1 前缀路径，响应体统一包裹 code 与 message 字段",
    category: "principle",
  }));
  assert.strictEqual(memV1.action, "ADD");

  // 写入同名新版本（内容不同），触发 supersede 链条
  const memV2 = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: v1Title,
    content: "第二版规范：升级支持 GraphQL 与 gRPC 协议，同时保留 /v1 与 /v2 双轨网关路由兼容",
    category: "principle",
  }));
  assert.strictEqual(memV2.action, "UPDATE");

  // 5.2 调用 memory_get 读取 revision > 1 的记忆
  const getV2Res = parseOut(await hub.tool["memory_get"].execute({
    id: memV2.id,
  }));
  assert.strictEqual(getV2Res.revision, 2, "读出记忆修订版本号应为 2");
  assert.ok(
    Array.isArray(getV2Res.superseded_history),
    "【反证门 5.2a 通过】：revision > 1 时必须返回 superseded_history 数组"
  );
  assert.strictEqual(
    getV2Res.superseded_history.length,
    1,
    "【反证门 5.2b 通过】：成功还原 1 条前序版本摘要"
  );
  const prevRev = getV2Res.superseded_history[0];
  assert.strictEqual(prevRev.revision, 1);
  assert.strictEqual(prevRev.title, v1Title);
  assert.ok(
    prevRev.content.includes("第一版规范"),
    "前序版本摘要必须为第一版真实内容（截断前 120 字）"
  );
  assert.ok(prevRev.updated_at, "前序版本摘要必须保留当时的时间戳");

  // 5.3 反证：从当前记录无法还原时返回空数组并附带 note（不要伪造数据）
  const isolatedRevMemory = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: "Isolated High Revision Memory",
    content: "Directly created memory with simulated high revision",
  }));
  // 在 DB 中直接把 revision 改成 3，但无历史 superseded 记录
  await env.client.update("memories", isolatedRevMemory.id, { revision: 3 });

  const getIsolatedRes = parseOut(await hub.tool["memory_get"].execute({
    id: isolatedRevMemory.id,
  }));
  assert.strictEqual(getIsolatedRes.revision, 3);
  assert.ok(
    Array.isArray(getIsolatedRes.superseded_history) && getIsolatedRes.superseded_history.length === 0,
    "【反证门 5.3a 通过】：无法从存储还原历史版本时必须返回空数组，不得伪造数据！"
  );
  assert.strictEqual(
    getIsolatedRes.note,
    "历史版本未持久化",
    "【反证门 5.3b 通过】：无法还原时必须在 note 中如实声明'历史版本未持久化'"
  );

  // 5.4 边界反证：初版记录 (revision === 1) 绝不得输出虚假 superseded_history
  const getV1Res = parseOut(await hub.tool["memory_get"].execute({
    id: mRedis.id,
  }));
  assert.strictEqual(getV1Res.revision, 1);
  assert.strictEqual(
    getV1Res.superseded_history,
    undefined,
    "【反证门 5.4 通过】：初版记录不得携带 superseded_history 属性"
  );

  console.log("  ✓ 5. EVO-9b memory_get superseded_history 双向反证通过！\n");

  // -----------------------------------------------------------------
  // 6. 【EVO-10】memory_list 返回 knowledge_profile 自省画像
  // -----------------------------------------------------------------
  console.log("▶ [Test 6] 【EVO-10】memory_list 返回 knowledge_profile 自省画像反证...");

  // 构造特定画像数据分布：
  // 1) principle 若干
  // 2) preference 达到 near_crystallization 阈值 (threshold=5, recurrence >= 4)
  // 3) decision 未达到阈值 (recurrence = 1)
  const prefNear = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: "用户对 Markdown 输出格式的强偏好",
    content: "用户强烈要求所有代码块与结论必须用标准 Markdown 排版呈现",
    category: "preference",
  }));
  // 将 recurrence 提升至 4 (threshold - 1 = 4)
  await env.client.update("memories", prefNear.id, { recurrence: 4 });

  const decLow = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    title: "单次网络重试次数决策",
    content: "所有 HTTP 请求默认重试不超过 2 次",
    category: "decision",
  }));
  // recurrence 为 1

  // 执行 memory_list
  const listProfileRes = parseOut(await hub.tool["memory_list"].execute({
    limit: 50,
  }));
  const kp = listProfileRes.knowledge_profile;

  assert.ok(kp != null && typeof kp === "object", "memory_list 响应中必须包含 knowledge_profile 画像");
  assert.ok(kp.principle_count >= 1, `principle_count 统计准确 (实际: ${kp.principle_count})`);
  assert.ok(kp.preference_count >= 1, `preference_count 统计准确 (实际: ${kp.preference_count})`);
  assert.ok(kp.decision_count >= 1, `decision_count 统计准确 (实际: ${kp.decision_count})`);
  assert.strictEqual(kp.total_active, listProfileRes.total_active, "total_active 统计必须与 total_active 完全对齐");

  // 6.2 临界反证：near_crystallization 必须准确捕获 recurrence >= 4 的记录
  assert.ok(
    Array.isArray(kp.near_crystallization),
    "near_crystallization 必须为数组"
  );
  const foundNear = kp.near_crystallization.find((item) => item.id === prefNear.id);
  assert.ok(
    foundNear != null,
    "【反证门 6.2a 通过】：recurrence >= threshold - 1 的偏好记录必须进入 near_crystallization"
  );
  assert.strictEqual(foundNear.threshold, 5);
  assert.strictEqual(foundNear.recurrence, 4);

  // 6.3 防误报反证：低频决策 (recurrence=1 < 4) 绝不得误入 near_crystallization
  const foundFalsePositive = kp.near_crystallization.find((item) => item.id === decLow.id);
  assert.strictEqual(
    foundFalsePositive,
    undefined,
    "【反证门 6.3 通过】：低频决策绝不误报为 near_crystallization！"
  );

  console.log("  ✓ 6. EVO-10 memory_list knowledge_profile 自省画像反证通过！\n");

  // -----------------------------------------------------------------
  // 7. 【元检查自检】test_meta 规范元检查自证
  // -----------------------------------------------------------------
  console.log("▶ [Test 7] 【元检查自检】对本测试文件进行 test_meta 规范扫描...");
  const thisFile = fileURLToPath(import.meta.url);
  const rawContent = fs.readFileSync(thisFile, "utf8");
  const scanRes = scanTestFile(thisFile, rawContent);

  if (scanRes.issues.length > 0) {
    console.error("❌ test_v637_b_read.mjs 存在 test_meta 规范违规:");
    for (const is of scanRes.issues) {
      console.error("   -", is);
    }
  }

  assert.strictEqual(
    scanRes.issues.length,
    0,
    "本测试文件自身必须 100% 符合 test_meta 测试规范！"
  );
  assert.strictEqual(
    scanRes.hasDbWrite,
    true,
    "本测试包含写库操作，已严格集成 createTestEnv 隔离与 cleanup 机制"
  );

  console.log("  ✓ 7. 本测试文件经 test_meta 静态扫描，0 规范违规！\n");

} finally {
  // 强制安全清理并自证 0 残余
  console.log("[CLEANUP] 开始清理隔离命名空间...");
  await otherEnv.cleanup();
  await env.cleanup();
  const residue = await env.countAllTestResidue();
  assert.strictEqual(residue.total, 0, `[残余断言失败] 清理后仍有残余记录: ${JSON.stringify(residue)}`);
  console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
}

console.log("=================================================================");
console.log("🎉 全部 v6.37-b BUG-2/4 与 EVO-9b/10 双向反证测试 100% 成功通过！");
console.log("=================================================================");
