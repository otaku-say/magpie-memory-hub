/**
 * tests/test_v638_b_read.mjs
 * =================================================================
 * v6.38-b 读取能力深化与别名映射专项双向反证测试套件
 *
 * 覆盖 3 大核心任务与双向反证靶场：
 * 1. 【BUG-37-4b：normalizeToolArgs 补齐 cause / reason → root_cause 映射】
 *    - 正向反证 a: 传 cause: "X" 成功映射到 root_cause === "X"
 *    - 反向反证 b: 传 root_cause: "Y", cause: "X" 时保留 root_cause === "Y"，绝不被覆盖
 *    - 同义反证 c: 传 reason: "Z" 成功映射到 root_cause === "Z"
 *    - 保护反证 d: 传 root_cause: "Y", reason: "Z" 时保留 root_cause === "Y"
 *    - 空值兜底 e: 传 root_cause: "", cause: "X" 时成功兜底为 root_cause === "X"
 *    - 端到端实测 f: 通过 pitfall_save 传 cause 参数成功持久化为 root_cause
 * 2. 【EVO-12：knowledge_profile 补齐置信度过滤与 chronic_pitfalls 顽疾画像】
 *    - 正向反证 a: recurrence >= 3 未失效踩坑必须进入 chronic_pitfalls
 *    - 临界反证 b: recurrence = 2 踩坑绝不得进入 chronic_pitfalls
 *    - 失效反证 c: 已软失效（invalid_at 非空）的踩坑绝不得出现
 *    - 门禁反证 d: confidence_score < 80 的高频偏好绝不得进 near_crystallization
 *    - 正例反证 e: confidence_score >= 80 的高频偏好准确进入 near_crystallization
 *    - 截断反证 f: chronic_pitfalls 的 symptom 字段严格截取前 60 字符
 *    - 排序反证 g: chronic_pitfalls 按 recurrence 降序排序且最多 5 条
 *    - 语义不变 h: principle_count / preference_count / decision_count / total_active 计数完整
 * 3. 【EVO-13：memory_get 生命周期状态与取代指引】
 *    - 正向反证 a: active 活跃记录的 _lifecycle_warning 严格为 null（无告警）
 *    - 取代反证 b: 被 supersede_id 取代的失效记录带有新 ID 指引告警文案
 *    - 失效反证 c: 软失效且未被取代的记录返回失效原因告警（原因: <invalid_reason>）
 *    - 跨表反证 d: table: "pitfalls" 的踩坑记录读取同样适用生命周期状态与告警
 *    - 批量反证 e: ids 批量读取中各个记录生命周期状态与 warning 保持准确
 *    - 回退反证 f: auto_fallback 触发时踩坑生命周期元数据与 warning 依然准确生效
 * 4. 【元检查自检与零残留断言】
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
console.log("【v6.38-b 读取能力深化与别名映射专项双向反证测试套件】");
const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 主测试隔离命名空间: ${env.project}`);
console.log("=================================================================\n");

try {
  const hub = await env.createHub({
    crystallization_threshold: 5,
  });
  const normalize = MagpieMemoryHub.normalizeToolArgs;

  // -----------------------------------------------------------------
  // 1. 【BUG-37-4b】normalizeToolArgs 漏映射 cause / reason → root_cause
  // -----------------------------------------------------------------
  console.log("▶ [Test 1] 【BUG-37-4b】normalizeToolArgs 别名映射与兜底双向反证...");

  // 1.1 正向反证 a: { cause: "X" } → root_cause === "X"
  const normA = normalize({ cause: "连接超时未释放" }, { project: env.project });
  assert.strictEqual(
    normA.root_cause,
    "连接超时未释放",
    "【反证门 1.1 通过】：仅传 cause 时必须正确映射至 root_cause"
  );

  // 1.2 反向反证 b: { root_cause: "Y", cause: "X" } → root_cause === "Y"（绝不覆盖）
  const normB = normalize(
    { root_cause: "既有明确根因", cause: "次要别名成因" },
    { project: env.project }
  );
  assert.strictEqual(
    normB.root_cause,
    "既有明确根因",
    "【反证门 1.2 通过】：已有合法 root_cause 时绝不被 cause 覆盖"
  );

  // 1.3 同义反证 c: { reason: "Z" } → root_cause === "Z"
  const normC = normalize({ reason: "心跳包丢失" }, { project: env.project });
  assert.strictEqual(
    normC.root_cause,
    "心跳包丢失",
    "【反证门 1.3 通过】：传 reason 时必须正确映射至 root_cause"
  );

  // 1.4 保护反证 d: { root_cause: "Y", reason: "Z" } → root_cause === "Y"
  const normD = normalize(
    { root_cause: "原生权威根因", reason: "外部传入原因" },
    { project: env.project }
  );
  assert.strictEqual(
    normD.root_cause,
    "原生权威根因",
    "【反证门 1.4 通过】：已有合法 root_cause 时绝不被 reason 覆盖"
  );

  // 1.5 空值兜底反证 e: { root_cause: "", cause: "X" } → root_cause === "X"
  const normE = normalize(
    { root_cause: "", cause: "空值兜底根因" },
    { project: env.project }
  );
  assert.strictEqual(
    normE.root_cause,
    "空值兜底根因",
    "【反证门 1.5 通过】：root_cause 为空串时允许 cause 兜底映射"
  );

  // 1.6 端到端实测 f: pitfall_save 传入 cause 成功写入数据库
  const pitSaveRes = parseOut(await hub.tool["pitfall_save"].execute({
    project: env.project,
    component: "network",
    symptom: "Socket 连接异常重置",
    cause: "TCP KeepAlive 参数未在套接字开启",
    solution: "设置 SO_KEEPALIVE 为 true",
  }));
  assert.strictEqual(pitSaveRes.action, "ADD", "踩坑记录保存成功");
  const savedPitRows = rowsOf(await env.client.list("pitfalls", { id: pitSaveRes.id, limit: 1 }));
  assert.strictEqual(savedPitRows.length, 1);
  assert.strictEqual(
    savedPitRows[0].root_cause,
    "TCP KeepAlive 参数未在套接字开启",
    "【反证门 1.6 通过】：端到端 pitfall_save 成功将 cause 映射并持久化为 root_cause"
  );

  console.log("  ✓ 1. BUG-37-4b normalizeToolArgs 别名映射与兜底反证全部通过！\n");

  // -----------------------------------------------------------------
  // 2. 【EVO-12】knowledge_profile 补齐（置信度过滤 + chronic_pitfalls 顽疾画像）
  // -----------------------------------------------------------------
  console.log("▶ [Test 2] 【EVO-12】knowledge_profile 置信度过滤与 chronic_pitfalls 双向反证...");

  // 2.1 准备 memory 记录验证 near_crystallization 置信度门禁
  // 2.1.1 高频 + 高置信度偏好 (rec=4 >= 5-1, confidence=90 >= 80) → 必须进 near_crystallization
  const pHigh = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    category: "preference",
    title: "TypeScript 偏好严格空值检查",
    content: "优先使用 strictNullChecks 避免 undefined 运行时崩溃",
    confidence: 90,
  }));
  await env.client.update("memories", pHigh.id, { recurrence: 4 });

  // 2.1.2 高频 + 低置信度偏好 (rec=4 >= 5-1, confidence=70 < 80) → 绝不得进 near_crystallization
  const pLowConf = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    category: "preference",
    title: "实验性特性偏好待验证",
    content: "偶尔尝试新语法糖但未形成团队定式",
    confidence: 70,
  }));
  await env.client.update("memories", pLowConf.id, { recurrence: 4 });

  // 2.1.3 高频 + 高置信度决策 (rec=4, confidence=85) → 必须进 near_crystallization
  const dHigh = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    category: "decision",
    title: "网关协议决策统一 gRPC",
    content: "服务间通讯全量采用 gRPC 并生成 protobuf 契约",
    confidence: 85,
  }));
  await env.client.update("memories", dHigh.id, { recurrence: 4 });

  // 2.1.4 准则记录 (验证 principle_count 统计)
  const princ1 = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    category: "principle",
    title: "数据安全性最高准则",
    content: "严禁在日志中明文打印用户密码与敏感凭证",
    confidence: 100,
  }));

  // 2.2 准备 pitfall 记录验证 chronic_pitfalls
  // 2.2.1 踩坑 A: recurrence = 4, 未失效 → 必须进 chronic_pitfalls
  const pitA = parseOut(await hub.tool["pitfall_save"].execute({
    project: env.project,
    component: "redis",
    symptom: "Redis 键未设置过期时间导致内存撑爆",
    root_cause: "写缓存漏填 TTL 参数",
    solution: "包装缓存写函数强制校验并设置默认 TTL",
  }));
  await env.client.update("pitfalls", pitA.id, { recurrence: 4 });

  // 2.2.2 踩坑 B: recurrence = 3, 未失效，symptom 超长（用于验证前 60 字截断）→ 必须进 chronic_pitfalls
  const longSymptom = "MySQL 慢查询执行时间严重超过阈值并且在高峰期并发查询导致数据库连接池被耗尽系统整体服务出现不可用雪崩现象需要立即排查优化";
  const pitB = parseOut(await hub.tool["pitfall_save"].execute({
    project: env.project,
    component: "db",
    symptom: longSymptom,
    root_cause: "缺少复合联合索引走全表扫描",
    solution: "对查询字段建立 (user_id, status, created_at) 联合索引",
  }));
  await env.client.update("pitfalls", pitB.id, { recurrence: 3 });

  // 2.2.3 踩坑 C: recurrence = 2, 未失效 (未达 >= 3 门禁) → 绝不得进 chronic_pitfalls
  const pitC = parseOut(await hub.tool["pitfall_save"].execute({
    project: env.project,
    component: "build",
    symptom: "Webpack 内存溢出打包中断",
    root_cause: "Node 默认堆内存限制",
    solution: "设置 max-old-space-size=4096",
  }));
  await env.client.update("pitfalls", pitC.id, { recurrence: 2 });

  // 2.2.4 踩坑 D: recurrence = 5, 已软失效 (invalid_at 非空) → 绝不得进 chronic_pitfalls
  const pitD = parseOut(await hub.tool["pitfall_save"].execute({
    project: env.project,
    component: "docker",
    symptom: "旧版 Docker 构建缓存失效",
    root_cause: "基础镜像更新",
    solution: "使用 BuildKit 缓存挂载",
  }));
  await env.client.update("pitfalls", pitD.id, {
    recurrence: 5,
    invalid_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    invalid_reason: "user_forgot",
  });

  // 2.3 执行 memory_list 检验 knowledge_profile
  const listRes = parseOut(await hub.tool["memory_list"].execute({
    project: env.project,
    limit: 50,
  }));
  const kp = listRes.knowledge_profile;
  assert.ok(kp != null, "memory_list 返回结果必须包含 knowledge_profile");

  // 2.4 反证门 d & e: near_crystallization 置信度门禁
  const nearList = kp.near_crystallization || [];
  const foundHighPref = nearList.find((x) => x.id === pHigh.id);
  assert.ok(
    foundHighPref != null,
    "【反证门 2.1e 通过】：高置信度高频偏好 (conf=90 >= 80) 必须进入 near_crystallization"
  );

  const foundLowPref = nearList.find((x) => x.id === pLowConf.id);
  assert.strictEqual(
    foundLowPref,
    undefined,
    "【反证门 2.1d 通过】：低置信度偏好 (conf=70 < 80) 绝不得进入 near_crystallization"
  );

  const foundHighDec = nearList.find((x) => x.id === dHigh.id);
  assert.ok(
    foundHighDec != null,
    "【反证门 2.1e 通过】：高置信度高频决策 (conf=85 >= 80) 必须进入 near_crystallization"
  );

  // 2.5 反证门 a, b, c, f, g: chronic_pitfalls 顽疾画像
  const chronicList = kp.chronic_pitfalls || [];
  assert.ok(Array.isArray(chronicList), "chronic_pitfalls 必须为数组");

  // 正向反证 a: recurrence=4 未失效的 pitA 必须存在
  const foundPitA = chronicList.find((x) => x.id === pitA.id);
  assert.ok(
    foundPitA != null,
    "【反证门 2.2a 通过】：recurrence >= 3 未失效踩坑必须出现在 chronic_pitfalls 中"
  );
  assert.strictEqual(foundPitA.recurrence, 4);
  assert.strictEqual(foundPitA.component, "redis");

  // 正向反证 a: recurrence=3 未失效的 pitB 必须存在
  const foundPitB = chronicList.find((x) => x.id === pitB.id);
  assert.ok(
    foundPitB != null,
    "【反证门 2.2a 通过】：recurrence=3 未失效踩坑必须出现在 chronic_pitfalls 中"
  );
  assert.strictEqual(foundPitB.recurrence, 3);

  // 反向反证 b: recurrence=2 的 pitC 绝不得出现
  const foundPitC = chronicList.find((x) => x.id === pitC.id);
  assert.strictEqual(
    foundPitC,
    undefined,
    "【反证门 2.2b 通过】：recurrence=2 的低频踩坑绝不得进入 chronic_pitfalls"
  );

  // 失效反证 c: 已软失效的 pitD 绝不得出现
  const foundPitD = chronicList.find((x) => x.id === pitD.id);
  assert.strictEqual(
    foundPitD,
    undefined,
    "【反证门 2.2c 通过】：已软失效（invalid_at 非空）的踩坑绝不得进入 chronic_pitfalls"
  );

  // 截断反证 f: symptom 字段必须最多 60 字符
  assert.strictEqual(
    foundPitB.symptom.length,
    60,
    "【反证门 2.2f 通过】：长 symptom 必须严格截取前 60 个字符"
  );
  assert.strictEqual(foundPitB.symptom, longSymptom.slice(0, 60));

  // 排序反证 g: 按 recurrence 降序排列
  const idxA = chronicList.findIndex((x) => x.id === pitA.id);
  const idxB = chronicList.findIndex((x) => x.id === pitB.id);
  assert.ok(
    idxA < idxB,
    "【反证门 2.2g 通过】：chronic_pitfalls 必须按 recurrence 降序排列 (4 > 3)"
  );
  assert.ok(
    chronicList.length <= 5,
    "【反证门 2.2g 通过】：chronic_pitfalls 列表最多截取 5 条"
  );

  // 语义不变 h: principle_count / preference_count / decision_count / total_active 计数完整
  assert.ok(kp.principle_count >= 1, "principle_count 统计准确");
  assert.ok(kp.preference_count >= 2, "preference_count 必须包含所有活跃偏好（不因置信度过滤而漏计）");
  assert.ok(kp.decision_count >= 1, "decision_count 统计准确");
  assert.strictEqual(kp.total_active, listRes.total_active, "total_active 语义保持完全一致");

  console.log("  ✓ 2. EVO-12 knowledge_profile 置信度过滤与 chronic_pitfalls 顽疾画像反证全部通过！\n");

  // -----------------------------------------------------------------
  // 3. 【EVO-13】memory_get 生命周期状态与取代指引
  // -----------------------------------------------------------------
  console.log("▶ [Test 3] 【EVO-13】memory_get 生命周期状态与取代指引双向反证...");

  // 3.1 正向反证 a: active 活跃记录的 _lifecycle_warning 严格为 null 或不出现
  const getActiveRes = parseOut(await hub.tool["memory_get"].execute({
    id: princ1.id,
  }));
  assert.strictEqual(
    getActiveRes.lifecycle_status,
    "active",
    "active 记录 lifecycle_status 必须为 active"
  );
  assert.strictEqual(
    getActiveRes.invalid_at,
    null,
    "active 记录 invalid_at 必须为 null"
  );
  assert.strictEqual(
    getActiveRes.superseded_by_id,
    null,
    "active 记录 superseded_by_id 必须为 null"
  );
  assert.ok(
    getActiveRes._lifecycle_warning == null,
    "【反证门 3.1a 通过】：有效 active 记录的 _lifecycle_warning 必须为 null 或不出现"
  );

  // 3.2 取代反证 b: 被 supersede_id 取代的失效记录带有新 ID 指引告警
  // 3.2.1 创建旧记录
  const oldMem = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    category: "principle",
    title: "旧版缓存淘汰准则",
    content: "采用简单的先进先出 FIFO 算法淘汰数据",
  }));
  // 3.2.2 显式传入 supersede_id 创建新记录
  const newMem = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    category: "principle",
    title: "新版缓存淘汰准则",
    content: "全面升级为分段 LRU-2 算法进行缓存热度衰减淘汰",
    supersede_id: oldMem.id,
  }));

  // 3.2.3 读取被取代的旧记录
  const getSupersededRes = parseOut(await hub.tool["memory_get"].execute({
    id: oldMem.id,
  }));
  assert.strictEqual(
    getSupersededRes.lifecycle_status,
    "superseded",
    "被取代记录 lifecycle_status 必须为 superseded"
  );
  assert.ok(
    getSupersededRes.invalid_at != null,
    "被取代记录 invalid_at 必须非空"
  );
  assert.strictEqual(
    getSupersededRes.superseded_by_id,
    newMem.id,
    "superseded_by_id 必须精准指向新记录 ID"
  );
  const expectedWarning = `该记录已被 #${newMem.id} 取代，可调 memory_get(id=${newMem.id}) 查看最新版本`;
  assert.strictEqual(
    getSupersededRes._lifecycle_warning,
    expectedWarning,
    "【反证门 3.2b 通过】：被取代记录必须输出精准的取代 ID 指引告警文案"
  );
  // 读取已失效记录时仍必须返回完整内容（追溯性保障）
  assert.ok(
    getSupersededRes.content.includes("FIFO"),
    "读取已失效记录时仍必须保留并返回原文内容以便追溯"
  );

  // 3.3 失效反证 c: 软失效且未被取代的记录（如 memory_forget）输出原因告警
  const memToForget = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    category: "fact",
    title: "临时过时端口配置",
    content: "测试服务器监听 9099 端口",
  }));
  await hub.tool["memory_forget"].execute({
    project: env.project,
    id: memToForget.id,
  });

  const getForgottenRes = parseOut(await hub.tool["memory_get"].execute({
    id: memToForget.id,
  }));
  assert.strictEqual(
    getForgottenRes.lifecycle_status,
    "invalid",
    "软失效记录 lifecycle_status 必须为 invalid"
  );
  assert.ok(
    getForgottenRes.invalid_at != null,
    "软失效记录 invalid_at 必须已填充"
  );
  assert.strictEqual(
    getForgottenRes.superseded_by_id,
    null,
    "软失效且无取代记录 superseded_by_id 为 null"
  );
  assert.strictEqual(
    getForgottenRes.invalid_reason,
    "user_forgot",
    "软失效原因记录为 user_forgot"
  );
  assert.strictEqual(
    getForgottenRes._lifecycle_warning,
    "该记录已失效（原因: user_forgot）",
    "【反证门 3.3c 通过】：未被取代的软失效记录必须输出原因告警文案"
  );

  // 3.4 跨表反证 d: table: "pitfalls" 读取同样适用生命周期状态与告警
  // 3.4.1 读取 active 状态的踩坑
  const getPitActive = parseOut(await hub.tool["memory_get"].execute({
    id: pitA.id,
    table: "pitfalls",
  }));
  assert.strictEqual(
    getPitActive.lifecycle_status,
    "active",
    "活跃踩坑记录 lifecycle_status 为 active"
  );
  assert.strictEqual(
    getPitActive.invalid_at,
    null,
    "活跃踩坑记录 invalid_at 为 null"
  );
  assert.ok(
    getPitActive._lifecycle_warning == null,
    "【反证门 3.4d 通过】：活跃踩坑记录 _lifecycle_warning 严格为 null"
  );

  // 3.4.2 读取已失效状态的踩坑 (pitD 已被软失效)
  const getPitInvalid = parseOut(await hub.tool["memory_get"].execute({
    id: pitD.id,
    table: "pitfalls",
  }));
  assert.strictEqual(
    getPitInvalid.lifecycle_status,
    "invalid",
    "失效踩坑记录 lifecycle_status 为 invalid"
  );
  assert.ok(
    getPitInvalid.invalid_at != null,
    "失效踩坑记录 invalid_at 非空"
  );
  assert.strictEqual(
    getPitInvalid._lifecycle_warning,
    "该记录已失效（原因: user_forgot）",
    "【反证门 3.4d 通过】：失效踩坑记录必须输出失效告警"
  );

  // 3.5 批量反证 e: ids 批量读取中保持各个记录的生命周期元数据与告警准确
  const batchRes = parseOut(await hub.tool["memory_get"].execute({
    ids: [princ1.id, oldMem.id, memToForget.id],
  }));
  assert.strictEqual(batchRes.length, 3, "批量读取必须返回 3 条记录");
  const bPrinc = batchRes.find((x) => x.id === princ1.id);
  const bOld = batchRes.find((x) => x.id === oldMem.id);
  const bForg = batchRes.find((x) => x.id === memToForget.id);

  assert.ok(bPrinc._lifecycle_warning == null, "批量读取中 active 记录无告警");
  assert.strictEqual(bOld._lifecycle_warning, expectedWarning, "批量读取中取代记录告警正确");
  assert.strictEqual(bForg._lifecycle_warning, "该记录已失效（原因: user_forgot）", "批量读取中失效记录告警正确");

  // 3.6 回退反证 f: 未传 table 时 auto_fallback 到 pitfalls 表依然具有生命周期与告警
  const fallbackActive = parseOut(await hub.tool["memory_get"].execute({
    id: pitA.id,
  }));
  assert.strictEqual(fallbackActive.table, "pitfalls", "自动回退至 pitfalls 表");
  assert.strictEqual(fallbackActive.auto_fallback, true, "标记 auto_fallback: true");
  assert.strictEqual(fallbackActive.lifecycle_status, "active");
  assert.ok(fallbackActive._lifecycle_warning == null, "回退踩坑 active 无告警");

  const fallbackInvalid = parseOut(await hub.tool["memory_get"].execute({
    id: pitD.id,
  }));
  assert.strictEqual(fallbackInvalid.table, "pitfalls");
  assert.strictEqual(fallbackInvalid.auto_fallback, true);
  assert.strictEqual(fallbackInvalid.lifecycle_status, "invalid");
  assert.strictEqual(
    fallbackInvalid._lifecycle_warning,
    "该记录已失效（原因: user_forgot）",
    "【反证门 3.6f 通过】：auto_fallback 回退踩坑失效告警准确生效"
  );

  console.log("  ✓ 3. EVO-13 memory_get 生命周期状态与取代指引反证全部通过！\n");

  // -----------------------------------------------------------------
  // 4. 【元检查自检】test_meta 规范元检查自证
  // -----------------------------------------------------------------
  console.log("▶ [Test 4] 【元检查自检】对本测试文件进行 test_meta 规范扫描...");
  const thisFile = fileURLToPath(import.meta.url);
  const rawContent = fs.readFileSync(thisFile, "utf8");
  const scanRes = scanTestFile(thisFile, rawContent);

  if (scanRes.issues.length > 0) {
    console.error("❌ test_v638_b_read.mjs 存在 test_meta 规范违规:");
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

  console.log("  ✓ 4. 本测试文件经 test_meta 静态扫描，0 规范违规！\n");

} finally {
  // 强制安全清理并自证 0 残余
  console.log("[CLEANUP] 开始清理隔离命名空间...");
  await env.cleanup();
  const residue = await env.countAllTestResidue();
  assert.strictEqual(residue.total, 0, `[残余断言失败] 清理后仍有残余记录: ${JSON.stringify(residue)}`);
  console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
}

console.log("=================================================================");
console.log("🎉 全部 v6.38-b BUG-37-4b 与 EVO-12/13 双向反证测试 100% 成功通过！");
console.log("=================================================================");
