/**
 * tests/test_v6462_transient_guard.mjs
 * =================================================================
 * v6.46.2【瞬时控制行防吞没 / handoff 契约自动补标签】专项测试
 *
 * 对应审计报告红队长尾瑕疵：
 *  门1 BUG-461-1（P2）：auditor 周期去重必须豁免未消费的 mail:unread / handoff:open
 *      瞬时控制行——两个 Agent 先后投递的同标题未读信，在任何一方消费前
 *      绝不得被 memory_audit 判重软失效静默吞没；
 *      反证：普通同标题重复记忆仍必须被正常去重（修复不得过度豁免）。
 *  门2 BUG-461-2（P3）：memory_save 仅传 handoff: true（不写 tags）时，
 *      落库 tags 必须自动补齐 "handoff, handoff:open"，
 *      且 memory_context 必须能将其检出为 active_handoff 置顶接力棒；
 *      反证：不带 handoff 声明的普通记忆绝不被自动打上 handoff:open 标签。
 *  门3 元规范自检 + 隔离清理零残留。
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { createTestEnv } from "./lib/testenv.mjs";
import { scanTestFile } from "./test_meta.mjs";
import { MagpieMemoryHub } from "../tools.js";

const parseOut = (res) => {
  if (typeof res === "string") {
    try {
      return JSON.parse(res);
    } catch (e) {
      throw new Error("工具返回值不是合法 JSON: " + String(res).slice(0, 200) + " | " + e.message);
    }
  }
  return res;
};

const rowsOf = (res) => Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);

console.log("=================================================================");
console.log("【v6.46.2 瞬时控制行防吞没 / handoff 契约自动补标签专项测试】");
const env = await createTestEnv({ mode: "memory" });
console.log(`隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

const hub = await MagpieMemoryHub({}, {
  client: env.client,
  ncb_instance: env.instance,
});
const memSave = hub.tool["memory_save"];
const memAudit = hub.tool["memory_audit"];
const memCtx = hub.tool["memory_context"];
const saveA = (args) => memSave.execute(Object.assign({ project: env.project }, args), {});

try {
  // =================================================================
  // 门1：auditor 去重豁免未消费瞬时控制行（BUG-461-1）
  // =================================================================
  console.log("▶ [门1] 【瞬时行防吞没】两封同标题未读信在消费前绝不得被 memory_audit 判重吞没...");
  const mail1 = parseOut(await saveA({
    category: "context", scope_level: "session", client: "agent-order",
    tags: "agent-mail, mail:unread",
    title: "【变更通知】订单接口字段调整",
    content: "订单服务 v2 接口将 orderNo 字段更改为 order_id，请订阅方及时适配。",
  }));
  assert.strictEqual(mail1.action, "ADD", "门1 前置：第一封未读信必须成功入库");
  const mail2 = parseOut(await saveA({
    category: "context", scope_level: "session", client: "agent-pay",
    tags: "agent-mail, mail:unread",
    title: "【变更通知】订单接口字段调整",
    content: "订单服务 v2 接口将 orderNo 字段更改为 order_id，请订阅方及时适配。",
  }));
  assert.strictEqual(mail2.action, "ADD", "门1 前置：第二封同标题未读信必须独立 ADD 入库（写入侧豁免）");

  // 同步写入两棒 open 接力棒（同项目同标题），验证 audit 也不吞未消费接力棒
  const baton1 = parseOut(await saveA({
    category: "context", scope_level: "session", client: "agentA",
    tags: "handoff, handoff:open",
    title: "【任务交接】支付网关重构",
    content: "已完成灰度方案设计，待接力方执行压测。",
  }));
  const baton2 = parseOut(await saveA({
    category: "context", scope_level: "session", client: "agentA",
    tags: "handoff, handoff:open",
    title: "【任务交接】支付网关重构",
    content: "已完成灰度方案设计，待接力方执行压测。",
  }));
  assert.strictEqual(baton1.action, "ADD", "门1 前置：第一棒必须 ADD");
  assert.strictEqual(baton2.action, "ADD", "门1 前置：第二棒必须独立 ADD（写入侧豁免命中）");

  // 普通同标题重复记忆（对照组：必须被正常去重）
  // 第二条用 client.create 直写模拟"历史存量重复"（audit 的职责是清理存量，
  // 写入侧 saveMemory 会把新写入的同标题拦成 NOOP，到不了 audit 环节）
  const dup1 = parseOut(await saveA({
    category: "context", client: "minis",
    title: "Redis 连接池上限配置规范",
    content: "生产环境 Redis 连接池 maxTotal 统一配置为 200。",
  }));
  assert.strictEqual(dup1.action, "ADD", "门1 前置：普通重复记忆 1 入库");
  await env.client.create("memories", {
    project: env.project,
    category: "context",
    client: "minis",
    scope_level: "project",
    title: "Redis 连接池上限配置规范",
    content: "生产环境 Redis 连接池 maxTotal 统一配置为 200。",
    tags: "redis,pool",
    lifecycle_status: "active",
    confidence_score: 100,
    recurrence: 1,
    retrieval_count: 0,
  });

  // 触发周期去重巡检（无模型配置 → 纯规则路径）
  const auditRes = parseOut(await memAudit.execute({
    project: env.project,
    batch_size: 50,
    full: true,
  }, {}));
  assert.ok(auditRes && typeof auditRes === "object", "memory_audit 必须返回结构化结果");

  const afterRows = rowsOf(await env.client.list("memories", { project: env.project, limit: 200 }));
  const mailRows = afterRows.filter((r) => /mail:unread/i.test(String(r.tags || "")));
  assert.strictEqual(mailRows.length, 2, "门1 正向：两封未读信在 audit 后必须全部存活");
  for (const mr of mailRows) {
    assert.ok(!mr.invalid_at, `门1 正向：未读信 id=${mr.id} 绝不得被去重软失效（消费前属于接收方资产）`);
    assert.strictEqual(mr.lifecycle_status, "active", `门1 正向：未读信 id=${mr.id} 必须保持 active`);
  }
  const baton1Row = afterRows.find((r) => Number(r.id) === Number(baton1.id));
  const baton2Row = afterRows.find((r) => Number(r.id) === Number(baton2.id));
  assert.ok(baton1Row && baton2Row, "门1 前置：两根接力棒必须都在库（含已核销旧棒）");
  assert.ok(!baton2Row.invalid_at && /handoff:open/i.test(String(baton2Row.tags || "")), "门1 正向：新棒必须保持 active 且带 handoff:open（audit 不得吞没待认领资产）");
  assert.ok(baton1Row.invalid_at, "门1 前置：旧棒已被写入侧单开原则核销");
  assert.ok(/handoff_superseded-by/i.test(String(baton1Row.invalid_reason || "")), "门1 正向：旧棒必须是显式 superseded 核销（写入侧单开原则），而非被 audit 吞没");
  assert.ok(!/dedup/i.test(String(baton1Row.invalid_reason || "")), "门1 反证：接力棒的失效原因绝不得是 dedup:* 去重吞没");

  // 对照组反证：普通重复记忆必须仍被正常去重（修复不得过度豁免）
  const dupRows = afterRows.filter((r) => String(r.title || "").includes("Redis 连接池上限配置规范"));
  const dupInvalid = dupRows.filter((r) => r.invalid_at);
  assert.strictEqual(dupRows.length, 2, "门1 前置：普通重复对照记忆必须都在库");
  assert.strictEqual(dupInvalid.length, 1, "门1 反证：普通同标题重复记忆仍必须被规则去重精确软失效 1 条（瞬时豁免不得扩大化）");
  console.log("  ✓ 门1 通过：未消费信件与接力棒零吞没，普通重复仍正常去重。\n");

  // =================================================================
  // 门2：handoff:true 自动补齐 handoff:open 标签（BUG-461-2）
  // =================================================================
  console.log("▶ [门2] 【handoff 契约补标签】仅传 handoff: true 时落库 tags 必须自动补齐 handoff:open...");
  const hb = parseOut(await memSave.execute({
    project: env.project,
    handoff: true,
    category: "context", scope_level: "session", client: "agentA",
    title: "【任务交接】网关限流算法迁移",
    content: "令牌桶方案已评审通过，待接力方落地实现。",
  }, {}));
  assert.strictEqual(hb.action, "ADD", "门2 前置：handoff:true 写入必须 ADD 成功");
  const hbRow = rowsOf(await env.client.list("memories", { project: env.project, id: hb.id }))[0];
  assert.ok(hbRow, "门2 前置：落库行必须可回查");
  assert.ok(/handoff:open/i.test(String(hbRow.tags || "")), `门2 正向：仅传 handoff:true 时落库 tags 必须自动含 handoff:open（实际: "${hbRow.tags}"）`);
  assert.ok(/(^|,)\s*handoff\s*(,|$)/i.test(String(hbRow.tags || "")), "门2 正向：tags 必须同时补齐裸 handoff 关键词便于检索");

  // 读取侧闭环：memory_context 必须能将其检出为待接力任务
  const ctx2 = parseOut(await memCtx.execute({ project: env.project }, {}));
  assert.ok(/Pending Cross-Agent Handoff/i.test(String(ctx2.block || "")), "门2 正向：memory_context 必须置顶检出 handoff:true 写入的接力棒");
  assert.strictEqual(ctx2.active_handoff && ctx2.active_handoff.id, hb.id, "门2 正向：active_handoff 必须精确指向该接力棒 id");

  // 反证：普通记忆绝不被自动打上 handoff:open
  const normal = parseOut(await saveA({
    category: "fact", client: "minis",
    title: "网关部署区域事实",
    content: "网关集群部署在 us-east-1 区域。",
  }));
  const normalRow = rowsOf(await env.client.list("memories", { project: env.project, id: normal.id }))[0];
  assert.ok(!/handoff:open/i.test(String(normalRow.tags || "")), "门2 反证：不带 handoff 声明的普通记忆绝不得被自动打上 handoff:open 标签");
  console.log("  ✓ 门2 通过：handoff:true 自动补标签全链路闭环。\n");

  // =================================================================
  // 门3：元规范自检 + 零残留清理
  // =================================================================
  console.log("▶ [门3] 【元规范自检】test_meta 静态扫描 0 违规...");
  const thisFile = fileURLToPath(import.meta.url);
  const scanRes = scanTestFile(thisFile, fs.readFileSync(thisFile, "utf8"));
  if (scanRes.issues.length > 0) {
    console.error("❌ test_v6462_transient_guard.mjs 存在 test_meta 规范违规:");
    for (const issue of scanRes.issues) console.error("   -", issue);
  }
  assert.strictEqual(scanRes.issues.length, 0, "门3：本测试文件必须通过 test_meta 元规范扫描");
  console.log("  ✓ 门3 通过：元规范 0 违规。\n");
} catch (err) {
  console.error("\n❌ v6.46.2 瞬时控制行专项测试失败:", err.message);
  if (err.stack) console.error(err.stack.split("\n").slice(0, 6).join("\n"));
  process.exitCode = 1;
} finally {
  await env.cleanup();
  const residue = rowsOf(await env.client.list("memories", { project: env.project, limit: 500 }));
  assert.strictEqual(residue.length, 0, "清理后隔离命名空间残余必须严格为 0");
  console.log("\n✅ 【零残留断言通过】：测试数据已彻底清除！");
}

console.log("\n=================================================================");
if (process.exitCode === 1) {
  console.log("❌ v6.46.2 瞬时控制行专项测试存在失败项！");
} else {
  console.log("🎉 全部 v6.46.2 瞬时控制行专项测试 100% 成功通过！");
}
console.log("=================================================================");
