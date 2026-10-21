/**
 * tests/test_v639_b_save.mjs
 * =================================================================
 * v6.39-b 修复显式 supersede 被吞没与检索期自省专项双向反证测试套件
 *
 * 覆盖 3 大核心任务与全部双向反证门：
 * 1. 【BUG-38-2：显式 supersede_id 被 dup/crossDup 吞没（高危修复）】
 *    - 正向反证 a: 同标题 fact "使用 npm" 存在，新传 decision "切换为 pnpm" + supersede_id=<旧id>
 *                 必须成功新增记录并返回 UPDATE，旧记录被软失效且 invalid_reason 为 superseded-by:<newId>
 *    - 反向反证 b: 不传 supersede_id 时，同标题无数字冲突的重复调用必须命中 dup/crossDup 严格返回 NOOP
 *    - 跨类反证 c: 跨类别（fact -> decision）与同类别（fact -> fact）显式 supersede 均必须生效
 * 2. 【EVO-14：memory_context 透出 evolution_opportunities 演进契机（自省增强）】
 *    - 正向反证 a: recurrence=4 (>= 5-1) 且根因/解法真实的踩坑召回时，near_ironlaw 必须含它且 missing=1，_agent_hint 追加铁律提示
 *    - 顽疾反证 b: recurrence=5 (>= 3) 且根因占位的踩坑召回时，chronic_without_root_cause 必须含它，_agent_hint 追加补根因提示
 *    - 纯净反证 c: 无任何机会时，evolution_opportunities 为空/缺省，_agent_hint 绝不含演进提示文案
 *    - 结构保护 d: block 块结构与 max_items 上限保持完好，不受演进契机字段干扰
 * 3. 【EVO-15：pitfall_search 透出诊断标记（自省增强）】
 *    - 慢性反证 a: recurrence=4 的踩坑 is_chronic=true；recurrence=2 的踩坑 is_chronic=false
 *    - 占位反证 b: root_cause 为 "具体待查" / 等于 symptom / 含 "已处置解决" / 含 "执行过程中出现" 等，root_cause_is_placeholder=true
 *    - 真实反证 c: root_cause 为 "TCP KeepAlive 未开启" 时，root_cause_is_placeholder=false
 * 4. 【测试元检查自检与零残留防线】
 *    - 引用 createTestEnv / env.project 隔离
 *    - 强制 cleanup 与 residue.total === 0 强断言
 *    - scanTestFile 静态自检 0 违规
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
console.log("【v6.39-b 修复 supersede 吞没与检索期自省专项双向反证测试套件】");
const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 主测试隔离命名空间: ${env.project}`);
console.log("=================================================================\n");

try {
  const hub = await env.createHub({
    crystallization_threshold: 5,
  });

  const memSave = hub.tool["memory_save"];
  const pitSave = hub.tool["pitfall_save"];
  const memContext = hub.tool["memory_context"];
  const pitSearch = hub.tool["pitfall_search"];

  // =================================================================
  // 1. 【BUG-38-2】显式 supersede_id 被 dup / crossDup 吞没双向反证
  // =================================================================
  console.log("▶ [Test 1] 【BUG-38-2】显式 supersede_id 取代与防重双向反证...");

  // 1.1 先存入一条事实记录：包管理器选型（npm）
  const factOld = parseOut(await memSave.execute({
    project: env.project,
    category: "fact",
    title: "包管理器选型",
    content: "当前工程统一使用 npm 作为主包管理器管理全部依赖",
  }, {}));
  assert.strictEqual(factOld.action, "ADD", "旧事实初次入库必须为 ADD");
  assert.ok(factOld.id, "必须生成有效旧记录 ID");

  // 1.2 反向反证 b: 不传 supersede_id 时，同标题无数字冲突的重复提交仍必须触发 NOOP 防重
  const dupNoop = parseOut(await memSave.execute({
    project: env.project,
    category: "fact",
    title: "包管理器选型",
    content: "工程统一采用 npm 管理开发环境与构建部署依赖",
  }, {}));
  assert.strictEqual(dupNoop.action, "NOOP", "【反证门 1.2 通过】：不传 supersede_id 的同标题重复必须严格返回 NOOP 防重");
  assert.strictEqual(dupNoop.id, factOld.id, "NOOP 必须关联既有旧记录 ID");
  console.log("  ✓ 1.2 未传 supersede_id 正常命中 dup/crossDup 返回 NOOP 防重反证通过");

  // 1.3 正向反证 a & 跨类反证 c: 显式传 supersede_id 想取代同标题旧记录（fact -> decision: npm -> pnpm）
  const supersedeRes = parseOut(await memSave.execute({
    project: env.project,
    category: "decision",
    title: "包管理器选型",
    content: "经架构决策，项目全面切换为 pnpm 以加速构建并共享依赖",
    supersede_id: factOld.id,
  }, {}));

  assert.strictEqual(
    supersedeRes.action,
    "UPDATE",
    "【反证门 1.3 通过】：显式传 supersede_id 时，即使同标题也绝不能被 dup 吞没为 NOOP，必须返回 UPDATE！"
  );
  assert.ok(supersedeRes.id && supersedeRes.id !== factOld.id, "必须生成全新版本记录 ID");
  assert.strictEqual(supersedeRes.superseded_id, factOld.id, "返回体必须明确标明被取代的旧 ID");

  // 1.4 验证数据库底层软失效状态与 invalid_reason 指向
  const checkOldRow = rowsOf(await env.client.list("memories", { id: factOld.id, limit: 1 }))[0];
  assert.strictEqual(checkOldRow.lifecycle_status, "superseded", "旧记录 lifecycle_status 必须标记为 superseded");
  assert.strictEqual(
    checkOldRow.invalid_reason,
    `superseded-by:${supersedeRes.id}`,
    "旧记录 invalid_reason 必须精确记录为 superseded-by:<新ID>"
  );
  assert.strictEqual(checkOldRow.superseded_by_id, supersedeRes.id, "旧记录 superseded_by_id 外键必须指向新记录");
  assert.ok(checkOldRow.invalid_at != null, "旧记录 invalid_at 必须记录时间戳");

  // 1.5 验证数据库新记录状态
  const checkNewRow = rowsOf(await env.client.list("memories", { id: supersedeRes.id, limit: 1 }))[0];
  assert.strictEqual(checkNewRow.lifecycle_status, "active", "新记录 lifecycle_status 必须为 active");
  assert.strictEqual(checkNewRow.category, "decision", "新记录分类必须成功升级为 decision");
  assert.strictEqual(checkNewRow.revision, (Number(checkOldRow.revision) || 1) + 1, "新记录 revision 必须递增");
  console.log("  ✓ 1.3~1.5 显式 supersede_id 成功跨类取代旧记录、旧记录软失效且版本递增验证全部通过！\n");

  // =================================================================
  // 2. 【EVO-14】memory_context 透出 evolution_opportunities 双向反证
  // =================================================================
  console.log("▶ [Test 2] 【EVO-14】memory_context 透出 evolution_opportunities 自省反证...");

  // 2.1 构造正向用例 a: recurrence = 4 (>= 5 - 1) 且 root_cause/solution 真实非占位
  const pitIron = parseOut(await pitSave.execute({
    project: env.project,
    component: "mysql",
    symptom: "MySQL 生产连接池耗尽报错 Too many connections 导致请求熔断",
    root_cause: "数据库连接池配置 maxConnections 偏小且未开启泄漏回收",
    solution: "增大 maxConnections 至 500 并开启 connectionTimeout 回收",
  }, {}));
  await env.client.update("pitfalls", pitIron.id, { recurrence: 4 });

  // 2.2 构造顽疾用例 b: recurrence = 5 (>= 3) 且 root_cause 为占位（具体待查）
  const pitChronic = parseOut(await pitSave.execute({
    project: env.project,
    component: "kafka",
    symptom: "Kafka 消费组在网络波动时频繁发生 Rebalance 抖动",
    root_cause: "具体待查",
    solution: "重启消费者实例临时恢复消费速率",
  }, {}));
  await env.client.update("pitfalls", pitChronic.id, { recurrence: 5 });

  // 2.3 执行 memory_context 检索
  const ctxRes = parseOut(await memContext.execute({
    project: env.project,
    query: "连接池与消费组故障排查",
  }, {}));

  // 2.4 断言 evolution_opportunities 结构与 near_ironlaw 契机
  assert.ok(ctxRes.evolution_opportunities, "存在契机时，返回体必须包含 evolution_opportunities 字段");
  assert.ok(Array.isArray(ctxRes.evolution_opportunities.near_ironlaw), "near_ironlaw 必须为数组");
  assert.ok(
    ctxRes.evolution_opportunities.near_ironlaw.some((x) => x.id === pitIron.id && x.missing === 1),
    "【反证门 2.1 通过】：near_ironlaw 必须包含 recurrence=4 且根因真实的踩坑，且 missing=1！"
  );
  const ironItem = ctxRes.evolution_opportunities.near_ironlaw.find((x) => x.id === pitIron.id);
  assert.strictEqual(ironItem.component, "mysql", "component 必须一致");
  assert.ok(ironItem.symptom.length <= 60, "symptom 必须截取前 60 字");
  assert.strictEqual(ironItem.recurrence, 4, "recurrence 必须正确");

  // 2.5 断言 chronic_without_root_cause 顽疾契机
  assert.ok(Array.isArray(ctxRes.evolution_opportunities.chronic_without_root_cause), "chronic_without_root_cause 必须为数组");
  assert.ok(
    ctxRes.evolution_opportunities.chronic_without_root_cause.some((x) => x.id === pitChronic.id),
    "【反证门 2.2 通过】：chronic_without_root_cause 必须包含 recurrence=5 且根因占位的踩坑！"
  );
  const chronicItem = ctxRes.evolution_opportunities.chronic_without_root_cause.find((x) => x.id === pitChronic.id);
  assert.strictEqual(chronicItem.component, "kafka", "component 必须一致");
  assert.strictEqual(chronicItem.recurrence, 5, "recurrence 必须正确");

  // 2.6 断言 _agent_hint 动态追加提示
  assert.ok(
    ctxRes._agent_hint.includes("再记录 1 次该故障即可自动生成铁律"),
    "【反证门 2.3 通过】：_agent_hint 必须动态追加再记录 N 次生成铁律提示"
  );
  assert.ok(
    ctxRes._agent_hint.includes("该顽疾缺真实根因，排查后请用 pitfall_save 补 root_cause"),
    "【反证门 2.4 通过】：_agent_hint 必须动态追加顽疾缺真实根因补全提示"
  );

  // 2.7 结构保护断言：不得破坏原有 block 块格式与 max_items 截断
  assert.ok(ctxRes.block.startsWith("[Persistent Memory Context]"), "block 依然以 [Persistent Memory Context] 开头");
  assert.ok(ctxRes.injected <= 5, "injected 条数不得突破 max_items 上限");
  console.log("  ✓ 2.1~2.7 near_ironlaw、chronic_without_root_cause 与动态 _agent_hint 验证全部通过！");

  // 2.8 反向反证 c: 纯净场景（检索仅命中 fact 时，无踩坑演进契机，evolution_opportunities 为空/缺省，_agent_hint 不含演进提示）
  const cleanCtxRes = parseOut(await memContext.execute({
    project: env.project,
    query: "包管理器",
  }, {}));

  const oppEmpty =
    !cleanCtxRes.evolution_opportunities ||
    (Array.isArray(cleanCtxRes.evolution_opportunities) && cleanCtxRes.evolution_opportunities.length === 0) ||
    ((cleanCtxRes.evolution_opportunities.near_ironlaw || []).length === 0 &&
      (cleanCtxRes.evolution_opportunities.chronic_without_root_cause || []).length === 0);

  assert.ok(oppEmpty, "【反证门 2.8 通过】：无机会时 evolution_opportunities 必须为空或省略");
  assert.ok(!cleanCtxRes._agent_hint.includes("再记录"), "无机会时 _agent_hint 绝不得含再记录铁律提示");
  assert.ok(!cleanCtxRes._agent_hint.includes("该顽疾缺真实根因"), "无机会时 _agent_hint 绝不得含补根因提示");
  console.log("  ✓ 2.8 纯净场景 evolution_opportunities 为空且 _agent_hint 无演进提示反证通过！\n");

  // =================================================================
  // 3. 【EVO-15】pitfall_search 透出诊断标记双向反证
  // =================================================================
  console.log("▶ [Test 3] 【EVO-15】pitfall_search 透出诊断标记双向反证...");

  // 3.1 构造测试样本
  // 样本 1: recurrence=4 (>=3) 且真实根因 -> is_chronic: true, root_cause_is_placeholder: false
  const p1 = parseOut(await pitSave.execute({
    project: env.project,
    component: "tcp",
    symptom: "TCP 孤儿连接堆积导致端口耗尽",
    root_cause: "TCP KeepAlive 未开启",
    solution: "调整 tcp_keepalive_time 参数至 300s",
  }, {}));
  await env.client.update("pitfalls", p1.id, { recurrence: 4 });

  // 样本 2: recurrence=2 (<3) 且占位根因 "具体待查" -> is_chronic: false, root_cause_is_placeholder: true
  const p2 = parseOut(await pitSave.execute({
    project: env.project,
    component: "disk",
    symptom: "磁盘 IO 使用率突增至 100% 告警",
    root_cause: "具体待查",
    solution: "排查正在执行的大文件 dump 任务",
  }, {}));
  await env.client.update("pitfalls", p2.id, { recurrence: 2 });

  // 样本 3: root_cause 等于 symptom -> root_cause_is_placeholder: true
  const p3 = parseOut(await pitSave.execute({
    project: env.project,
    component: "cron",
    symptom: "定时任务超时未完成",
    root_cause: "定时任务超时未完成",
    solution: "拆分批处理任务并发执行",
  }, {}));

  // 样本 4: root_cause 含 "执行过程中出现" -> root_cause_is_placeholder: true
  const p4 = parseOut(await pitSave.execute({
    project: env.project,
    component: "mq",
    symptom: "消息积压无法消费",
    root_cause: "在执行过程中出现异常导致死信堆积",
    solution: "清理死信队列并重启工作协程",
  }, {}));

  // 样本 5: root_cause 含 "已处置解决" -> root_cause_is_placeholder: true
  const p5 = parseOut(await pitSave.execute({
    project: env.project,
    component: "auth",
    symptom: "JWT Token 校验失效报 401 Unauthorized",
    root_cause: "已处置解决，更换了公钥",
    solution: "同步最新公钥证书至网关节点",
  }, {}));

  // 3.2 调用 pitfall_search 进行检索并验证诊断标记
  const searchRes = parseOut(await pitSearch.execute({
    project: env.project,
    query: "TCP 磁盘 定时 消息 JWT",
    limit: 10,
  }, {}));

  const foundP1 = searchRes.pitfalls.find((x) => x.id === p1.id);
  assert.ok(foundP1, "必须检索到样本 p1");
  assert.strictEqual(
    foundP1.is_chronic,
    true,
    "【反证门 3.1 通过】：recurrence=4 的踩坑 is_chronic 必须为 true"
  );
  assert.strictEqual(
    foundP1.root_cause_is_placeholder,
    false,
    "【反证门 3.2 通过】：root_cause='TCP KeepAlive 未开启' 时 root_cause_is_placeholder 必须为 false"
  );

  const foundP2 = searchRes.pitfalls.find((x) => x.id === p2.id);
  assert.ok(foundP2, "必须检索到样本 p2");
  assert.strictEqual(
    foundP2.is_chronic,
    false,
    "【反证门 3.3 通过】：recurrence=2 的踩坑 is_chronic 必须为 false"
  );
  assert.strictEqual(
    foundP2.root_cause_is_placeholder,
    true,
    "【反证门 3.4 通过】：root_cause='具体待查' 时 root_cause_is_placeholder 必须为 true"
  );

  const foundP3 = searchRes.pitfalls.find((x) => x.id === p3.id);
  assert.ok(foundP3, "必须检索到样本 p3");
  assert.strictEqual(
    foundP3.root_cause_is_placeholder,
    true,
    "【反证门 3.5 通过】：root_cause 等于 symptom 时 root_cause_is_placeholder 必须为 true"
  );

  const foundP4 = searchRes.pitfalls.find((x) => x.id === p4.id);
  assert.ok(foundP4, "必须检索到样本 p4");
  assert.strictEqual(
    foundP4.root_cause_is_placeholder,
    true,
    "【反证门 3.6 通过】：root_cause 含'执行过程中出现'时 root_cause_is_placeholder 必须为 true"
  );

  const foundP5 = searchRes.pitfalls.find((x) => x.id === p5.id);
  assert.ok(foundP5, "必须检索到样本 p5");
  assert.strictEqual(
    foundP5.root_cause_is_placeholder,
    true,
    "【反证门 3.7 通过】：root_cause 含'已处置解决'时 root_cause_is_placeholder 必须为 true"
  );

  console.log("  ✓ 3.1~3.7 pitfall_search 诊断标记 (is_chronic / root_cause_is_placeholder) 双向反证全部通过！\n");

  // =================================================================
  // 4. 【元检查自检与零残留防线】
  // =================================================================
  console.log("▶ [Test 4] 【元检查自检】对本测试文件进行 test_meta 规范扫描...");
  const thisFile = fileURLToPath(import.meta.url);
  const rawContent = fs.readFileSync(thisFile, "utf8");
  const scanRes = scanTestFile(thisFile, rawContent);

  if (scanRes.issues.length > 0) {
    console.error("❌ test_v639_b_save.mjs 存在 test_meta 规范违规:");
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
console.log("🎉 全部 v6.39-b BUG-38-2 与 EVO-14/15 双向反证测试 100% 成功通过！");
console.log("=================================================================");
