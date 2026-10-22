/**
 * tests/test_v646_a_handoff_and_messaging.mjs
 * =================================================================
 * v6.46-a【Handoff 接力协议 / 跨项目画像收敛 / 异步信箱】七门专项测试
 *
 * 覆盖 SPEC-AI-MEMORY-INTEGRATION §1 / §3 / §6，全部零 DDL（复用 memories 表）：
 *  门1 交接棒置顶：handoff:open 记录必须置顶出现在 context 首行，且给出 active_handoff；
 *      反证：不带 handoff 标签的普通记录绝不被当成接力棒置顶。
 *  门2 Claim-Once 单次核销：默认只提示不消费；claim_handoff: true 后 tags 改 handoff:claimed
 *      且 invalid_at 落值；二次 claim 幂等、不会"复活"已核销的接力棒。
 *  门3 接力棒单开原则：同项目写入新接力棒时，旧接力棒必须被 superseded 且 superseded_by_id 指向新棒；
 *      反证：跨项目的 open 接力棒绝不被本项目的保存动作误核销。
 *  门4 跨项目画像收敛：同一 preference 标题出现在 >= 2 个不同项目 → 合成 global/user 画像；
 *      反证：只出现在 1 个项目时绝不生成全局画像（避免单项目噪声污染个人画像）。
 *  门5 画像幂等：第 3 个项目再次印证同一偏好，不得重复生成第二条全局画像。
 *  门6 异步信箱：投递到目标项目的 mail:unread 记录必须在 context 置顶提示并单次消费，
 *      反证：消费后同一封邮件绝不再重复占预算。
 *  门7 元规范与零残留：本文件经 test_meta 静态扫描 0 违规，清理后残余数严格为 0。
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { createTestEnv } from "./lib/testenv.mjs";
import { scanTestFile } from "./test_meta.mjs";
import { saveMemory } from "../src/services/save/memory-saver.js";

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

const rowsOf = (res) => {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res.rows)) return res.rows;
  return [];
};

const GLOBAL_SCOPE = "global";

console.log("=================================================================");
console.log("【v6.46-a Handoff 接力 / 跨项目画像收敛 / 异步信箱 七门专项测试】");
const env = await createTestEnv({ mode: "memory" });
const envB = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 主隔离命名空间 A: ${env.project}`);
console.log(`[testenv] 跨项目隔离命名空间 B: ${envB.project}`);
console.log("=================================================================\n");

// 画像收敛用受控内存桩：memory 模式 client 严禁触碰 global，画像合成需独立可控的 mockDbClient
const memoryStore = new Map();
let mockNextId = 1;
const mockDbClient = {
  list: async (table, params = {}) => {
    if (table !== "memories") return { data: [] };
    let rows = Array.from(memoryStore.values());
    if (params.project) rows = rows.filter((r) => r.project === params.project);
    if (params.lifecycle_status) rows = rows.filter((r) => r.lifecycle_status === params.lifecycle_status);
    if (params.category) rows = rows.filter((r) => r.category === params.category);
    return { data: rows.map((r) => ({ ...r })) };
  },
  create: async (table, data) => {
    const saved = { ...data, id: mockNextId++ };
    memoryStore.set(saved.id, saved);
    return saved;
  },
  update: async (table, rowId, data) => {
    const row = memoryStore.get(Number(rowId));
    if (row) Object.assign(row, data);
    return { affectedRows: row ? 1 : 0 };
  },
};

const savePref = (project, title, content) =>
  saveMemory(mockDbClient, { crystallization_threshold: 5 }, {
    project,
    category: "preference",
    scope_level: "project",
    title,
    content,
    tags: "pref, coding-style",
  }, {});

const globalRows = () => Array.from(memoryStore.values()).filter((r) => r.project === GLOBAL_SCOPE);

try {
  const hubA = await env.createHub();
  const hubB = await envB.createHub();
  const ctxA = hubA.tool.memory_context;
  const saveA = (args) => hubA.tool.memory_save.execute(Object.assign({ project: env.project }, args), {});
  const saveB = (args) => hubB.tool.memory_save.execute(Object.assign({ project: envB.project }, args), {});

  // =================================================================
  // 门1：交接棒置顶
  // =================================================================
  console.log("▶ [门1] 【交接棒置顶】handoff:open 必须置顶注入，普通记录不得冒充接力棒...");
  const plain = parseOut(await saveA({ category: "fact", title: "构建脚本使用 Node 24", content: "本地构建统一走 node --check + 全量测试" }));
  assert.strictEqual(plain.action, "ADD", "门1 前置：普通事实记录必须正常入库");

  const h1 = parseOut(await saveA({
    category: "context", scope_level: "session", client: "agentA",
    tags: "handoff, handoff:open",
    title: "【任务交接】v646 拆分等价收尾",
    content: "【当前进展】私有 helper 已抽出；【未决】待推 origin",
  }));
  assert.strictEqual(h1.action, "ADD", "交接棒记录必须正常入库");

  const ctx1 = parseOut(await ctxA.execute({ project: env.project }, {}));
  assert.ok(String(ctx1.block || "").startsWith("- [Pending Cross-Agent Handoff"), "门1 正向：context 首行必须置顶交接棒");
  assert.strictEqual(ctx1.active_handoff && ctx1.active_handoff.id, h1.id, "门1 正向：active_handoff 必须精确指向交接棒 id");
  assert.ok(String(ctx1.block || "").indexOf("构建脚本使用 Node 24") > 0, "门1 反证：普通记录只能出现在正文，绝不占据首行置顶位");
  console.log("  ✓ 门1 通过：接力棒置顶且普通记录未冒充置顶。\n");

  // =================================================================
  // 门2：Claim-Once 单次核销
  // =================================================================
  console.log("▶ [门2] 【Claim-Once】默认只提示不消费；claim 后必须核销且不可复活...");
  const rowBeforeClaim = rowsOf(await env.client.list("memories", { project: env.project, id: h1.id }))[0];
  assert.strictEqual(rowBeforeClaim.invalid_at, null, "门2 反证：未显式 claim 时接力棒绝不可被消费");
  assert.ok(/handoff:open/i.test(String(rowBeforeClaim.tags)), "门2 反证：未 claim 时 tags 必须保持 handoff:open");

  const ctxClaim = parseOut(await ctxA.execute({ project: env.project, claim_handoff: true }, {}));
  assert.strictEqual(ctxClaim.active_handoff && ctxClaim.active_handoff.id, h1.id, "门2 正向：认领当次仍必须把接力棒返还给新 Agent");

  const rowAfterClaim = rowsOf(await env.client.list("memories", { project: env.project, id: h1.id }))[0];
  assert.ok(/handoff:claimed/i.test(String(rowAfterClaim.tags)), "门2 正向：claim 后 tags 必须改写为 handoff:claimed");
  assert.ok(rowAfterClaim.invalid_at != null, "门2 正向：claim 后必须软失效，杜绝重复消费");
  assert.ok(String(rowAfterClaim.invalid_reason || "").startsWith("handoff_claimed_by:"), "门2 正向：必须记录认领来源");
  assert.strictEqual(rowAfterClaim.content, "【当前进展】私有 helper 已抽出；【未决】待推 origin", "门2 正向：核销不得篡改交接内容");

  const ctxSecond = parseOut(await ctxA.execute({ project: env.project, claim_handoff: true }, {}));
  assert.strictEqual(ctxSecond.active_handoff, undefined, "门2 反证：已核销接力棒绝不能被二次 claim 复活");
  assert.ok(!/Pending Cross-Agent Handoff/.test(String(ctxSecond.block || "")), "门2 反证：已核销接力棒不得再次置顶");
  console.log("  ✓ 门2 通过：认领即核销，二次认领不复活。\n");

  // =================================================================
  // 门3：接力棒单开原则
  // =================================================================
  console.log("▶ [门3] 【接力棒单开】新棒写入必须取代旧棒，跨项目旧棒不得被误伤...");
  const h3a = parseOut(await saveA({
    category: "context", scope_level: "session", client: "agentA",
    tags: "handoff, handoff:open",
    title: "【任务交接】v646 全量回归与推送",
    content: "【当前进展】回归脚本已就绪；【未决】待推 origin",
  }));
  assert.strictEqual(h3a.action, "ADD", "门3 前置：待取代的旧接力棒必须正常入库");

  const bHandoff = parseOut(await saveB({
    category: "context", scope_level: "session", client: "agentB",
    tags: "handoff, handoff:open",
    title: "【任务交接】v647 异步信箱设计",
    content: "【当前进展】信箱消费语义已定稿",
  }));
  assert.strictEqual(bHandoff.action, "ADD", "门3 前置：B 项目接力棒必须正常入库");

  const h2 = parseOut(await saveA({
    category: "context", scope_level: "session", client: "agentA",
    tags: "handoff, handoff:open",
    title: "【任务交接】v647 信箱与画像收敛",
    content: "【当前进展】信箱消费与画像晋升已实装；【下一步】补全量回归",
  }));
  assert.strictEqual(h2.action, "ADD", "门3 前置：同项目新接力棒必须正常入库");

  const staleRow = rowsOf(await env.client.list("memories", { project: env.project, id: h3a.id }))[0];
  assert.strictEqual(staleRow.lifecycle_status, "superseded", "门3 正向：旧接力棒必须被标记 superseded");
  assert.strictEqual(Number(staleRow.superseded_by_id), Number(h2.id), "门3 正向：旧棒必须指向新棒构成接力链");
  assert.ok(/handoff:superseded/i.test(String(staleRow.tags)), "门3 正向：旧棒 tags 必须改写为 handoff:superseded");

  const ctx3 = parseOut(await ctxA.execute({ project: env.project }, {}));
  assert.strictEqual(ctx3.active_handoff && ctx3.active_handoff.id, h2.id, "门3 正向：置顶的必须是最新一棒");
  assert.strictEqual((String(ctx3.block || "").match(/Pending Cross-Agent Handoff/g) || []).length, 1, "门3 正向：同一时刻只允许一条有效接力棒置顶");

  const bRow = rowsOf(await envB.client.list("memories", { project: envB.project, id: bHandoff.id }))[0];
  assert.strictEqual(bRow.lifecycle_status, "active", "门3 反证：A 项目保存动作绝不得核销 B 项目的 open 接力棒");
  assert.strictEqual(bRow.invalid_at, null, "门3 反证：B 项目接力棒必须保持可接力状态");
  console.log("  ✓ 门3 通过：接力棒单开，跨项目互不误伤。\n");

  // =================================================================
  // 门4：跨项目画像收敛
  // =================================================================
  console.log("▶ [门4] 【跨项目画像收敛】≥2 个项目同偏好必须升为 global/user 习惯，单项目不得升维...");
  const prefTitle = "偏好使用 TypeScript 严格模式";
  const p1 = await savePref(env.project, prefTitle, "所有项目开启 strict，禁止隐式 any");
  assert.strictEqual(p1.action, "ADD", "门4 前置：首个项目偏好必须正常入库");
  assert.strictEqual(globalRows().length, 0, "门4 反证：仅 1 个项目出现时绝不生成全局画像");

  const p2 = await savePref(`${env.project}_b`, prefTitle, "所有项目开启 strict 且禁用 any，编译期拦截脏类型");
  assert.strictEqual(p2.action, "ADD", "门4 前置：第二个项目偏好必须正常入库");
  const promoted = globalRows();
  assert.strictEqual(promoted.length, 1, "门4 正向：跨 2 个项目必须合成恰好 1 条全局画像");
  assert.strictEqual(promoted[0].scope_level, "user", "门4 正向：全局画像必须是 user 级作用域");
  assert.strictEqual(promoted[0].category, "preference", "门4 正向：画像必须继承偏好分类");
  assert.ok(/profile:converged/i.test(String(promoted[0].tags)), "门4 正向：画像必须带 profile:converged 标签");
  assert.strictEqual(Number(promoted[0].recurrence), 2, "门4 正向：画像 recurrence 必须反映 2 个项目印证");
  console.log("  ✓ 门4 通过：跨项目偏好收敛为全局画像，单项目不误升维。\n");

  // =================================================================
  // 门5：画像幂等
  // =================================================================
  console.log("▶ [门5] 【画像幂等】第 3 个项目再次印证，不得重复生成画像...");
  const p3 = await savePref(`${env.project}_c`, prefTitle, "所有项目开启 strict，禁用 any，并用 noUncheckedIndexedAccess 加固");
  assert.strictEqual(p3.action, "ADD", "门5 前置：第三个项目偏好必须正常入库");
  assert.strictEqual(globalRows().length, 1, "门5 反证：第 3 次印证绝不允许重复生成第二条全局画像");
  const globalResidue = Array.from(memoryStore.values()).filter((r) => r.project === GLOBAL_SCOPE && r.invalid_at);
  assert.strictEqual(globalResidue.length, 0, "门5 反证：幂等路径不得产生失效残留行");
  console.log("  ✓ 门5 通过：画像收敛幂等。\n");

  // =================================================================
  // 门6：异步信箱
  // =================================================================
  console.log("▶ [门6] 【异步信箱】未读通知必须提示并单次消费，已读不得重复提示...");
  const mail = parseOut(await saveB({
    project: env.project,
    category: "context", scope_level: "session", client: "agentB",
    tags: "agent-mail, mail:unread",
    title: "【变更通知】memories 表新增接力列",
    content: "已在零 DDL 前提下复用 tags 承载 handoff 状态，请勿再建表",
  }));
  assert.strictEqual(mail.action, "ADD", "门6 前置：跨项目投递必须成功入库到目标项目");

  const ctx6 = parseOut(await ctxA.execute({ project: env.project }, {}));
  assert.ok(/Unread Agent Mail/.test(String(ctx6.block || "")), "门6 正向：目标项目 context 必须提示未读邮件");
  assert.strictEqual(ctx6.mailbox && ctx6.mailbox.unread, 1, "门6 正向：mailbox.unread 必须精确计数");
  assert.deepStrictEqual(ctx6.mailbox.ids, [mail.id], "门6 正向：mailbox.ids 必须精确指向该封邮件");

  const mailRow = rowsOf(await env.client.list("memories", { project: env.project, id: mail.id }))[0];
  assert.ok(/mail:read/i.test(String(mailRow.tags)), "门6 正向：消费后必须标记 mail:read");
  assert.ok(mailRow.invalid_at != null, "门6 正向：消费后必须软失效");

  const ctx6Second = parseOut(await ctxA.execute({ project: env.project }, {}));
  assert.strictEqual(ctx6Second.mailbox, undefined, "门6 反证：已消费邮件绝不得再次上报未读");
  assert.ok(!/Unread Agent Mail/.test(String(ctx6Second.block || "")), "门6 反证：已消费邮件绝不得再次占用上下文预算");
  console.log("  ✓ 门6 通过：信箱单次消费，已读不重复。\n");

  // =================================================================
  // 门7：元规范自检
  // =================================================================
  console.log("▶ [门7] 【元规范自检】test_meta 静态扫描 0 违规...");
  const thisFile = fileURLToPath(import.meta.url);
  const scanRes = scanTestFile(thisFile, fs.readFileSync(thisFile, "utf8"));
  if (scanRes.issues.length > 0) {
    console.error("❌ test_v646_a_handoff_and_messaging.mjs 存在 test_meta 规范违规:");
    for (const issue of scanRes.issues) console.error("   -", issue);
  }
  assert.strictEqual(scanRes.issues.length, 0, "本测试文件自身必须 100% 符合 test_meta 测试规范");
  assert.strictEqual(scanRes.hasDbWrite, true, "本测试包含写库操作，已集成隔离与 cleanup 机制");
  assert.ok(globalRows().length >= 1, "门7：画像桩数据在清理前必须可观测");
  console.log("  ✓ 门7 通过：元规范 0 违规。\n");
} finally {
  console.log("[CLEANUP] 开始清理隔离命名空间与内存桩...");
  memoryStore.clear();
  await env.cleanup();
  await envB.cleanup();
  const residue = await env.countAllTestResidue();
  assert.strictEqual(memoryStore.size, 0, "[残余断言失败] 画像内存桩清理后仍有残余");
  assert.strictEqual(residue.total, 0, `[残余断言失败] 清理后仍有残余记录: ${JSON.stringify(residue)}`);
  console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
}

console.log("=================================================================");
console.log("🎉 全部 v6.46-a 七门 Handoff / 画像收敛 / 信箱测试 100% 成功通过！");
console.log("=================================================================");
