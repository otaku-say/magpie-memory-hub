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
 *
 *  咬死门（专治终审 QA 指出的 B2 假绿盲区，每条都做过「注入变异必转红」验证）：
 *      M1  控制行（handoff:open / mail:unread）只允许在顶层置顶区块出现一次，
 *          剥离置顶行后的常规正文里绝不得再出现该条目（否则一份控制信息吃两份预算）；
 *      M5  「同标题」新交接棒必须 ADD，绝不得被 dup 吞成 NOOP/UPDATE，
 *          旧棒 superseded_by_id 必须精准指向新棒 ID；
 *      M8  同标题但端口/版本冲突的跨项目记忆绝不得合成 global 画像
 *          （正向对照：数字一致的跨项目偏好仍必须照常收敛，防「整段关掉也变绿」）；
 *      M10 claim 核销的 invalid_reason 必须记录真实 agent 身份，绝不得退化为 unknown。
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

// 顶层置顶区块（交接棒 / 未读信箱）的行前缀：M1 咬死门只剥离置顶行，剩下的才是「常规正文」。
// 用行前缀剥离而不是字符串替换，是为了在置顶行被截断/换行时也不误伤正文。
const PINNED_BLOCK_LINE = /^- \[(?:Pending Cross-Agent Handoff|Unread Agent Mail)/;
const bodyOnly = (block) =>
  String(block || "")
    .split("\n")
    .filter((line) => !PINNED_BLOCK_LINE.test(line))
    .join("\n");

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

  // ---- 【M1 咬死门】控制行只允许在顶层置顶区块出现一次，绝不得在常规正文被二次打印 ----
  // 变异 M1：把 memory_context 里剔除 handoff:open / mail:unread 的那一行删掉 → 下面四条必须转红。
  const ctx1Body = bodyOnly(ctx1.block);
  assert.ok(String(ctx1Body).includes("构建脚本使用 Node 24"), "M1 前置：剥离置顶行后常规正文仍必须含普通记忆（证明不是把正文清空冒充通过）");
  assert.ok(
    !String(ctx1Body).includes("【任务交接】v646 拆分等价收尾"),
    "M1 咬死：handoff:open 条目绝不得在常规正文二次出现（顶层置顶区块之外一律禁止）"
  );
  assert.ok(
    !String(ctx1Body).includes(`[context#${h1.id}]`),
    `M1 咬死：交接棒 #${h1.id} 绝不得以普通记忆身份在正文重复打印（重复注入 + 白占预算）`
  );
  assert.ok(!/\bhandoff:open\b/i.test(String(ctx1Body)), "M1 咬死：常规正文绝不得出现 handoff:open 控制标记");
  assert.strictEqual(
    (String(ctx1.block || "").match(/Pending Cross-Agent Handoff/g) || []).length,
    1,
    "M1 咬死：同一根交接棒在全量上下文里只允许出现 1 次（置顶），绝不能出现「置顶 + 正文」双份"
  );
  console.log("  ✓ 门1 通过：接力棒置顶且普通记录未冒充置顶。\n");

  // =================================================================
  // 门2：Claim-Once 单次核销
  // =================================================================
  console.log("▶ [门2] 【Claim-Once】默认只提示不消费；claim 后必须核销且不可复活...");
  const rowBeforeClaim = rowsOf(await env.client.list("memories", { project: env.project, id: h1.id }))[0];
  assert.strictEqual(rowBeforeClaim.invalid_at, null, "门2 反证：未显式 claim 时接力棒绝不可被消费");
  assert.ok(/handoff:open/i.test(String(rowBeforeClaim.tags)), "门2 反证：未 claim 时 tags 必须保持 handoff:open");

  const ctxClaim = parseOut(await ctxA.execute({ project: env.project, claim_handoff: true }, { agent: "test-agent-x" }));
  assert.strictEqual(ctxClaim.active_handoff && ctxClaim.active_handoff.id, h1.id, "门2 正向：认领当次仍必须把接力棒返还给新 Agent");

  const rowAfterClaim = rowsOf(await env.client.list("memories", { project: env.project, id: h1.id }))[0];
  assert.ok(/handoff:claimed/i.test(String(rowAfterClaim.tags)), "门2 正向：claim 后 tags 必须改写为 handoff:claimed");
  assert.ok(rowAfterClaim.invalid_at != null, "门2 正向：claim 后必须软失效，杜绝重复消费");
  assert.ok(String(rowAfterClaim.invalid_reason || "").startsWith("handoff_claimed_by:"), "门2 正向：必须记录认领来源");

  // ---- 【M10 咬死门】认领核销必须落真实 Agent 身份，绝不允许退化成 unknown 兜底值 ----
  // 变异 M10：claimedBy 取成常量 "unknown"（或 ctx.agent 读错层级）→ 下面两条必须转红。
  assert.strictEqual(
    String(rowAfterClaim.invalid_reason),
    "handoff_claimed_by:test-agent-x",
    `M10 咬死：invalid_reason 必须精确记录真实认领者身份，实际 ${rowAfterClaim.invalid_reason}`
  );
  assert.ok(
    !/unknown/i.test(String(rowAfterClaim.invalid_reason)),
    "M10 咬死：invalid_reason 绝不得是 unknown 兜底值——那等于没记录是谁接的棒，事后无法追责"
  );
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

  // ---- 【M5 咬死门】「同标题」的新交接棒绝不得被常规 dup 吞成 NOOP/UPDATE ----
  // 旧测试用的是「不同标题」，那走不到指纹/标题去重分支；变异 M5 正是把瞬时物件豁免摘掉后，
  // 同标题新棒会被判为重复 → NOOP/UPDATE，接力方从此读到过期交接单。
  const sameTitle = "【任务交接】同标题接力棒单开验证";
  const hSameA = parseOut(await saveA({
    category: "context", scope_level: "session", client: "agentA",
    tags: "handoff, handoff:open",
    title: sameTitle,
    content: "【当前进展】第一棒：回归脚本待补；【未决】待推 origin",
  }));
  assert.strictEqual(hSameA.action, "ADD", `M5 前置：第一条交接棒必须入库，实际 ${hSameA.action}`);

  const hSameB = parseOut(await saveA({
    category: "context", scope_level: "session", client: "agentA",
    tags: "handoff, handoff:open",
    title: sameTitle,
    content: "【当前进展】第二棒：变异反证已补齐；【未决】待全量回归",
  }));
  assert.notStrictEqual(hSameB.action, "NOOP", "M5 咬死：同标题新交接棒绝不得被 dup 吞成 NOOP（接力方会一直读到过期交接单）");
  assert.notStrictEqual(hSameB.action, "UPDATE", "M5 咬死：同标题新交接棒绝不得被判定为重复而走 UPDATE 融合（旧棒内容会被顶掉）");
  assert.strictEqual(hSameB.action, "ADD", `M5 咬死：同标题第二条交接棒必须独立成行 ADD，实际 ${hSameB.action}`);
  assert.notStrictEqual(Number(hSameB.id), Number(hSameA.id), "M5 咬死：新棒必须拿到全新 ID，绝不得复用旧棒行");

  const hSameARow = rowsOf(await env.client.list("memories", { project: env.project, id: hSameA.id }))[0];
  assert.strictEqual(hSameARow.lifecycle_status, "superseded", "M5 咬死：旧棒必须被标记 superseded，绝不允许两根 open 棒并存");
  assert.strictEqual(
    Number(hSameARow.superseded_by_id),
    Number(hSameB.id),
    `M5 咬死：旧棒 superseded_by_id 必须精准指向新棒 ID（期望 ${hSameB.id}，实际 ${hSameARow.superseded_by_id}）`
  );
  assert.ok(/handoff:superseded/i.test(String(hSameARow.tags)), "M5 咬死：旧棒 tags 必须改写为 handoff:superseded");
  assert.ok(!/handoff:open/i.test(String(hSameARow.tags)), "M5 咬死：旧棒绝不得残留 handoff:open（否则会被再次置顶）");
  assert.strictEqual(String(hSameARow.invalid_reason), "handoff_superseded-by:" + hSameB.id, "M5 咬死：取代原因必须精确记录新棒 ID");
  assert.strictEqual(hSameARow.content, "【当前进展】第一棒：回归脚本待补；【未决】待推 origin", "M5：取代不得篡改旧棒内容（留证）");

  const ctxSame = parseOut(await ctxA.execute({ project: env.project }, {}));
  assert.strictEqual(ctxSame.active_handoff && ctxSame.active_handoff.id, hSameB.id, "M5：置顶的必须是最新同标题棒");
  assert.ok(!String(ctxSame.block || "").includes("第一棒：回归脚本待补"), "M5 咬死：已 superseded 的旧棒绝不得再被置顶注入");
  assert.strictEqual((String(ctxSame.block || "").match(/Pending Cross-Agent Handoff/g) || []).length, 1, "M5：同标题接力后仍只允许 1 条置顶");

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
  // 门5b：【M8 咬死门】同标题但端口/版本冲突的跨项目记忆，绝不得合成 global 画像
  // =================================================================
  console.log("▶ [门5b] 【M8 咬死】同标题但端口/版本不同的跨项目记忆，绝不得并进 global 画像...");
  const globalCountBeforeProbe = globalRows().length;
  assert.strictEqual(globalCountBeforeProbe, 1, "门5b 前置：此刻 global 只应有门4 合成的那 1 条画像");

  // 反证一：端口冲突（3306 vs 3307）
  const portTitle = "生产库连接池端口基线约定";
  const portA = await savePref(`${env.project}_port_a`, portTitle, "生产库统一走端口 3306，超时保持默认值");
  const portB = await savePref(`${env.project}_port_b`, portTitle, "生产库统一走端口 3307，超时保持默认值");
  assert.strictEqual(portA.action, "ADD", "门5b 前置：端口 A 项目偏好必须入库");
  assert.strictEqual(portB.action, "ADD", "门5b 前置：端口 B 项目偏好必须入库");
  assert.strictEqual(
    globalRows().filter((r) => String(r.title || "") === portTitle).length,
    0,
    `M8 咬死：同标题但端口冲突（3306 vs 3307）绝不得合成 global 画像，实际 ${JSON.stringify(globalRows().map((r) => r.title))}`
  );

  // 反证二：版本冲突（Node 18 vs Node 20）
  const verTitle = "构建工具链版本基线约定";
  await savePref(`${env.project}_ver_a`, verTitle, "全项目统一 Node 18 构建，禁止私自升级");
  await savePref(`${env.project}_ver_b`, verTitle, "全项目统一 Node 20 构建，禁止私自升级");
  assert.strictEqual(
    globalRows().filter((r) => String(r.title || "") === verTitle).length,
    0,
    "M8 咬死：同标题但版本冲突（Node 18 vs Node 20）绝不得合成 global 画像"
  );
  assert.strictEqual(
    globalRows().length,
    globalCountBeforeProbe,
    `M8 咬死：两组冲突项目都不得新增任何 global 画像行（实际 ${JSON.stringify(globalRows().map((r) => r.title))}）`
  );

  // 正向对照：守卫必须只挡「冲突」，数字一致的同标题跨项目偏好仍必须升维 ——
  // 否则把 promote 整段关掉也能让上面两条「反证」变绿，那是假绿。
  const okTitle = "缓存实例连接基线约定";
  await savePref(`${env.project}_ok_a`, okTitle, "缓存统一走端口 6379，超时保持默认值");
  await savePref(`${env.project}_ok_b`, okTitle, "缓存统一走端口 6379，超时保持默认值");
  assert.strictEqual(
    globalRows().filter((r) => String(r.title || "") === okTitle).length,
    1,
    "门5b 正向对照：数字一致的同标题跨项目偏好必须照常升维为 1 条 global 画像（证明守卫只挡冲突，不挡收敛）"
  );
  assert.strictEqual(globalRows().length, globalCountBeforeProbe + 1, "门5b：除合法对照画像外不得多出任何 global 行");
  const okProfile = globalRows().filter((r) => String(r.title || "") === okTitle)[0];
  assert.ok(/profile:converged/i.test(String(okProfile.tags)), "门5b 正向对照：合法收敛画像必须带 profile:converged 标签");
  assert.strictEqual(String(okProfile.content).includes("6379"), true, "门5b 正向对照：合法画像内容必须原样保留一致的端口值");

  // 收尾：删掉对照画像，恢复「只有门4 一条画像」的世界，避免污染后续门7 断言
  memoryStore.delete(Number(okProfile.id));
  assert.strictEqual(globalRows().length, globalCountBeforeProbe, "门5b 收尾：对照画像清理后 global 行数必须复原");
  console.log("  ✓ 门5b 通过：端口/版本冲突不升维，数字一致仍照常收敛。\n");

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

  // ---- 【M1 咬死门·信箱侧】mail:unread 同样只允许在顶层置顶区块出现一次 ----
  const ctx6Body = bodyOnly(ctx6.block);
  assert.ok(
    !String(ctx6Body).includes("【变更通知】memories 表新增接力列"),
    "M1 咬死：mail:unread 邮件绝不得在常规正文二次出现（置顶提示 + 正文打印＝一份通知吃两份预算）"
  );
  assert.ok(
    !String(ctx6Body).includes(`[context#${mail.id}]`),
    `M1 咬死：邮件 #${mail.id} 绝不得以普通记忆身份在正文重复打印`
  );
  assert.ok(!/\bmail:unread\b/i.test(String(ctx6Body)), "M1 咬死：常规正文绝不得出现 mail:unread 控制标记");
  assert.ok(
    !String(ctx6Body).includes("第二棒：变异反证已补齐"),
    "M1 咬死：仍在 open 状态的交接棒同样不得在常规正文出现"
  );
  assert.strictEqual(
    (String(ctx6.block || "").match(/Unread Agent Mail/g) || []).length,
    1,
    "M1 咬死：同一封未读邮件在全量上下文里只允许出现 1 次"
  );

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
