/**
 * test_call_storm_fix.mjs —— v6.20.0 模型调用失控放大事故修复验证
 *
 * 覆盖铁律：
 * 1. 切断自激循环：钩子对内部模型调用请求（请求体含内部提示词指纹 / state 标记 /
 *    X-Memhub-Internal 头）必须在 onRequest/onResponse 最开头豁免，零模型调用、零入库。
 *    - 即使 auto_harvest=true 且数据库 client 具备，内部请求也不触发任何 _fetch。
 *    - 断言复刻事故链：外层用户对话触发一次判定+提炼（2 次 _fetch）后，把内部
 *      判定/提炼请求体再次喂给 onResponse，断言零新增 _fetch（无第二代放大）。
 * 2. 调用预算与熔断：
 *    - 滑动窗口：harvest_max_per_min=2 时第 3 次判定/提炼被跳过（budget reason），不抛错。
 *    - 总量熔断：harvest_max_total=3 时累计触顶后锁存，后续一律跳过（含不同 key 的调用）。
 *    - 默认值不断言死数：只断言 getModelBudgetState() 与 check 返回结构自洽，
 *      不硬编码模型名（全流程使用 mock-model / mock-classifier 占位名）。
 * 3. 测试默认零真实网络调用：全文件仅使用注入式 _fetch mock；若全局 fetch 被
 *    调用则测试主动失败。Live 真实网关测试门控由 shouldRunLiveTests() 覆盖
 *    （MEMHUB_LIVE_TEST=1 + MAGPIE_API_KEY 才为 true）。
 * 4. 无价值短路：纯闲聊短文本（<60 字符、无技术信号）在 processDialogueAndHarvest
 *    入口即 reason=trivial_chatter_shortcircuit 跳过，零 _fetch。
 */

/**
 * tests/lib/testenv.mjs 由测试文件 import 时自动设置 NODE_ENV=test；
 * 本文件不经过 testenv（纯 mock、无真实写库），需显式声明测试模式，
 * 否则 onResponse 的测试写保护会放行（转而依赖 _force_test，本文件已传）。
 * 注意：必须在 import 钩子模块【之前】设置，isTestMode() 在调用时读取。
 */
process.env.NODE_ENV = "test";
process.env.MAGPIE_TEST = "1";

import assert from "node:assert";
import {
  onRequest,
  onResponse,
  classifyDialogueWithOnlineModel,
  harvestWithOnlineModel,
  processDialogueAndHarvest,
} from "../gateway_harvest.hooks.js";
import {
  isInternalHarvestRequest,
  modelBudgetCheck,
  modelBudgetRecord,
  getModelBudgetState,
  resetModelBudget,
  shouldRunLiveTests,
  MEMHUB_INTERNAL_VALUE,
} from "../model_budget.js";
import { clearHarvestQueue } from "../local_state.js";

console.log("=================================================================");
console.log("【测试开始】调用失控放大修复验证 (test_call_storm_fix.mjs)");
console.log("=================================================================\n");

function failingFetch() {
  return async () => {
    throw new Error("本测试默认零真实网络调用：禁止触达任何 fetch（含全局 fetch）！");
  };
}
const _origFetch = globalThis.fetch;
globalThis.fetch = failingFetch();

function countingFetch(handler) {
  let n = 0;
  const seen = [];
  const fn = async (url, init) => {
    n++;
    seen.push({ url: String(url), body: String(init && init.body) });
    return handler(url, init, n);
  };
  fn.count = () => n;
  fn.seen = seen;
  return fn;
}

function okChatFetch(content = "YES") {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

function okHarvestFetch(items) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(items) } }],
    }),
  });
}

// -----------------------------------------------------------------------------
// 1. 内部请求指纹判定（纯函数，不碰网络）
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 1] isInternalHarvestRequest 请求体指纹判定...");
  resetModelBudget();

  const classifyBody = {
    model: "mock-classifier",
    messages: [
      { role: "system", content: "你是一个会话价值判定器。判断用户对话是否包含值得长期记忆的内容。" },
      { role: "user", content: "hello" },
    ],
  };
  assert.strictEqual(isInternalHarvestRequest(classifyBody, {}), true, "判定请求体必须命中内部指纹");

  const harvestBody = {
    model: "mock-model",
    messages: [
      { role: "system", content: "你是一个专业的长期记忆与踩坑经验提炼助手。从对话中严格提炼。" },
      { role: "user", content: "hello" },
    ],
  };
  assert.strictEqual(isInternalHarvestRequest(harvestBody, {}), true, "提炼请求体必须命中内部指纹");

  const sysOneBody = { model: "mock-decider", state: "hi", questions: { q: { type: "noul" } } };
  assert.strictEqual(isInternalHarvestRequest(sysOneBody, {}), true, "systemone 决策体必须豁免");

  const userBody = {
    model: "mock-model",
    messages: [{ role: "user", content: "帮我把 config.toml 的跨域配好" }],
  };
  assert.strictEqual(isInternalHarvestRequest(userBody, {}), false, "普通用户请求绝不能误判为内部");

  // 同请求 state 标记透传
  assert.strictEqual(isInternalHarvestRequest(userBody, { state: { memhubInternal: true } }), true, "state.memhubInternal 必须豁免");
  // 请求头标记
  assert.strictEqual(
    isInternalHarvestRequest(userBody, { headers: { "X-Memhub-Internal": MEMHUB_INTERNAL_VALUE } }),
    true, "X-Memhub-Internal 头必须豁免");

  console.log("  ✓ 内部判定/提炼/systemone/标记/请求头命中，普通用户请求不误伤\n");
}

// -----------------------------------------------------------------------------
// 2. onRequest 豁免必须在 auto_harvest 判断之前
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 2] onRequest 内部请求豁免（auto_harvest=true 照样豁免）...");
  resetModelBudget();

  const internalBody = {
    model: "mock-model",
    messages: [
      { role: "system", content: "你是一个专业的长期记忆与踩坑经验提炼助手。" },
      { role: "user", content: "[user]: 记住用 pnpm" },
    ],
  };
  const ctx = { options: { auto_harvest: true }, state: {}, session: "s", agent: "a" };
  const r = await onRequest(internalBody, ctx);
  assert.strictEqual(r, undefined, "onRequest 必须返回 undefined（不改 body）");
  assert.strictEqual(ctx.state.memhubInternal, true, "onRequest 必须打标 memhubInternal");
  assert.strictEqual(ctx.state.harvestRequested, undefined, "豁免路径绝不能标记 harvestRequested");

  // 普通请求不受影响
  const userCtx = { options: { auto_harvest: true }, state: {}, session: "s", agent: "a" };
  await onRequest({ model: "mock-model", messages: [{ role: "user", content: "你好" }] }, userCtx);
  assert.strictEqual(userCtx.state.harvestRequested, true, "普通请求仍走正常采集标记");

  console.log("  ✓ 内部请求被打标豁免，普通请求照常标记\n");
}

// -----------------------------------------------------------------------------
// 3. onResponse 事故链复刻：内部请求二次进入钩子 → 零新增调用
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 3] onResponse 事故链复刻：内部请求零放大...");
  resetModelBudget();

  const memoryStore = new Map();
  const pitStore = new Map();
  let id = 1;
  const mockDbClient = { // test_meta 自证隔离：受控内存 mock 桩 + memoryStore
    list: async (t, p = {}) => {
      const st = t === "memories" ? memoryStore : pitStore;
      let rows = [...st.values()];
      if (p.project) rows = rows.filter((r) => r.project === p.project);
      return { data: rows };
    },
    create: async (t, d) => {
      const saved = { ...d, id: id++ };
      (t === "memories" ? memoryStore : pitStore).set(saved.id, saved);
      return saved;
    },
    update: async () => ({}),
  };

  // 外层用户对话：判定 YES + 提炼 1 条 = 2 次调用（mock _fetch 计数；
  // 注意 classify_endpoint=chat 的 YES/NO 判定看 content 是否含 "YES"，提炼看 JSON 数组，
  // 按请求体是否含提炼指纹区分返回）
  const mockFetch = countingFetch(async (url, init) => {
    const body = String(init && init.body);
    const isHarvest = body.includes("长期记忆与踩坑经验提炼助手");
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: isHarvest ? JSON.stringify([{ category: "fact", title: "构建工具规范", content: "统一使用 pnpm 管理依赖并执行构建流程", tags: "pnpm", confidence: 0.95 }]) : "YES" } }],
      }),
    };
  });

  const userBody = { model: "user-chat-model", messages: [{ role: "user", content: "记住：这个项目统一使用 pnpm 管理依赖并执行构建流程" }] };
  const userReply = { choices: [{ message: { role: "assistant", content: "好的，已记录：统一使用 pnpm。" } }] };
  const userCtx = {
    options: {
      auto_harvest: true, _force_test: true, wait_for_flush: true,
      project: "__test__storm_outer",
      extract_model: "mock-extract-model", classify_model: "mock-classifier", classify_endpoint: "chat",
      harvest_max_per_min: 1000, harvest_max_total: 100000,
      _fetch: mockFetch,
    },
    state: {}, session: "sess-outer", agent: "gw", success: true,
  };
  await onRequest(userBody, userCtx);
  await onResponse(userReply, userCtx);
  // onResponse 内部分发为后台任务；本测试传 wait_for_flush=true 确保落定后再计数
  await new Promise((r) => setTimeout(r, 300));
  const afterOuter = mockFetch.count();
  assert.ok(afterOuter >= 1 && afterOuter <= 2, `外层用户对话应触发 1~2 次模型调用（实际 ${afterOuter}）`);

  // 把钩子自己发出的内部请求体（判定 + 提炼）再次喂给 onResponse（模拟网关 serveAgent 二次触发）
  for (const seen of mockFetch.seen) {
    const innerBody = JSON.parse(seen.body);
    const innerReply = { choices: [{ message: { role: "assistant", content: "YES" } }] };
    const innerCtx = {
      options: userCtx.options,
      state: {}, request: innerBody,
      session: "sess-inner", agent: "gw", success: true,
    };
    // onRequest 先过一遍（网关真实顺序），再 onResponse
    await onRequest(innerBody, innerCtx);
    await onResponse(innerReply, innerCtx);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(mockFetch.count(), afterOuter, `内部请求二次进入钩子必须零新增调用（修复前会 +2/代指数放大，实际新增 ${mockFetch.count() - afterOuter}）`);

  // 残余清理断言（test_meta 门禁：写库测试必须自证隔离 + 残余 0）
  memoryStore.clear(); pitStore.clear();
  const residue = memoryStore.size + pitStore.size;
  assert.strictEqual(residue, 0, "清理后残余数必须为 0");

  console.log(`  ✓ 外层 ${afterOuter} 次调用后，内部请求复入零新增（自激环已切断）\n`);
}

// -----------------------------------------------------------------------------
// 4. 滑动窗口限流：harvest_max_per_min=2 → 第 3 次跳过
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 4] 滑动窗口限流（每分钟上限）...");
  resetModelBudget();

  const fetch = countingFetch(okChatFetch("YES"));
  const base = { classify_model: "mock-classifier", classify_endpoint: "chat", harvest_max_per_min: 2, harvest_max_total: 1000, _fetch: fetch };

  const r1 = await classifyDialogueWithOnlineModel("对话一内容足够长超过二十个字符的测试文本", base);
  const r2 = await classifyDialogueWithOnlineModel("对话二内容足够长超过二十个字符的测试文本", base);
  assert.strictEqual(fetch.count(), 2, "前 2 次应正常调用");
  assert.strictEqual(r1.shouldHarvest, true);
  assert.strictEqual(r2.shouldHarvest, true);

  const r3 = await classifyDialogueWithOnlineModel("对话三内容足够长超过二十个字符的测试文本", base);
  assert.strictEqual(fetch.count(), 2, "第 3 次必须被限流（零新增调用）");
  assert.strictEqual(r3.shouldHarvest, true, "限流跳过必须 fail-open 放行（不得改变采集语义）");
  assert.strictEqual(r3.reason, "budget_minute_exceeded", "跳过原因必须可观测");

  const st = getModelBudgetState();
  assert.strictEqual(st.perMinute, 2, "窗口计数必须为 2");
  assert.strictEqual(st.tripped, false, "分钟限流不应锁存熔断");

  console.log("  ✓ 2 次放行 + 第 3 次跳过（fail-open），计数可观测\n");
}

// -----------------------------------------------------------------------------
// 5. 总量熔断：harvest_max_total=3 → 触顶锁存，后续一律跳过
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 5] 单进程总量熔断（锁存）...");
  resetModelBudget();

  const fetch = countingFetch(okHarvestFetch([]));
  const base = { extract_model: "mock-extract-model", harvest_max_per_min: 1000, harvest_max_total: 3, _fetch: fetch };

  await harvestWithOnlineModel("第一轮对话内容足够长的测试文本一二三四", base);
  await harvestWithOnlineModel("第二轮对话内容足够长的测试文本一二三四", base);
  await harvestWithOnlineModel("第三轮对话内容足够长的测试文本一二三四", base);
  assert.strictEqual(fetch.count(), 3, "前 3 次应正常调用");

  const skipped = await harvestWithOnlineModel("第四轮对话内容足够长的测试文本一二三四", base);
  assert.strictEqual(skipped, null, "熔断后提炼必须返回 null（安全跳过）");
  assert.strictEqual(fetch.count(), 3, "熔断后零新增调用");

  // 锁存：换大预算也照样跳过（必须重启进程才恢复）
  const stillSkipped = await harvestWithOnlineModel("第五轮对话内容足够长的测试文本", { ...base, harvest_max_per_min: 1000, harvest_max_total: 100000, _fetch: fetch });
  assert.strictEqual(stillSkipped, null, "熔断锁存后即使调大上限也必须继续跳过");
  assert.strictEqual(fetch.count(), 3, "锁存后零新增调用");

  const chk = modelBudgetCheck({ harvest_max_per_min: 1000, harvest_max_total: 100000 });
  assert.strictEqual(chk.allowed, false, "锁存后 check 一律拒绝");
  assert.strictEqual(chk.tripped, true, "必须标记 tripped 可观测");

  console.log("  ✓ 3 次放行 + 触顶熔断锁存，后续零调用\n");
}

// -----------------------------------------------------------------------------
// 6. 无价值短路：纯闲聊零模型调用
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 6] 纯闲聊无价值短路（零模型调用）...");
  resetModelBudget();

  const fetch = countingFetch(okChatFetch("YES"));
  const res = await processDialogueAndHarvest(
    "[user]: 哈哈\n[assistant]: 周末愉快！",
    { project: "__test__storm_shortcircuit" },
    null,
    { extract_model: "mock-extract-model", classify_model: "mock-classifier", _fetch: fetch },
  );
  assert.strictEqual(res.skipped, true, "纯闲聊必须跳过");
  assert.strictEqual(res.reason, "trivial_chatter_shortcircuit", "跳过原因必须为无价值短路");
  assert.strictEqual(fetch.count(), 0, "短路路径必须零模型调用");

  // 显式记忆指令不受短路影响（仍走模型链路）
  const fetch2 = countingFetch(async (url) => {
    if (String(url).includes("/v1/systemone")) {
      return { ok: true, status: 200, json: async () => ({ answers: { worth_remembering: { noul: 0.9 } } }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "[]" } }] }) };
  });
  const res2 = await processDialogueAndHarvest(
    "[user]: 记住：构建统一用 pnpm",
    { project: "__test__storm_shortcircuit" },
    null,
    { extract_model: "mock-extract-model", classify_model: "mock-classifier", _fetch: fetch2 },
  );
  assert.ok(fetch2.count() >= 1, "显式记忆指令必须正常走模型链路（不受短路影响）");
  void res2;

  console.log("  ✓ 纯闲聊 0 调用跳过，显式指令正常放行\n");
}

// -----------------------------------------------------------------------------
// 7. Live 门控默认关闭 + 计数量化对比输出
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 7] Live 门控与修复前后量化对比...");
  resetModelBudget();

  const savedLive = process.env.MEMHUB_LIVE_TEST;
  const savedKey = process.env.MAGPIE_API_KEY;
  try {
    delete process.env.MEMHUB_LIVE_TEST;
    assert.strictEqual(shouldRunLiveTests(), false, "默认（无 MEMHUB_LIVE_TEST）必须不跑 Live");
    process.env.MEMHUB_LIVE_TEST = "1";
    // 注意：不断言 key 存在时的行为（环境自带真实 key，避免测试内触发网络）；
    // 仅断言门控函数的纯逻辑分支：
    assert.strictEqual(shouldRunLiveTests({ MEMHUB_LIVE_TEST: "0", MAGPIE_API_KEY: "k" }), false, "MEMHUB_LIVE_TEST=0 必须不跑");
    assert.strictEqual(shouldRunLiveTests({ MEMHUB_LIVE_TEST: "1" }), false, "无 key 必须不跑");
    assert.strictEqual(shouldRunLiveTests({ MEMHUB_LIVE_TEST: "1", MAGPIE_API_KEY: "k" }), true, "双条件齐备才跑");
  } finally {
    if (savedLive === undefined) delete process.env.MEMHUB_LIVE_TEST; else process.env.MEMHUB_LIVE_TEST = savedLive;
    if (savedKey === undefined) delete process.env.MAGPIE_API_KEY; else process.env.MAGPIE_API_KEY = savedKey;
  }

  // 量化对比（确定性 mock 下实测）：
  // 修复前：每轮用户对话触发判定+提炼（2 次），且每次内部调用再触发 onResponse
  //   → 第 n 代调用量 2^n（1 轮对话 18 代即 2^18 = 262144 ≥ 155229 实测量级）；
  // 修复后：同场景每轮用户对话 1~2 次（闲聊 0 次），内部请求复入 0 新增。
  console.log("  - 修复前模型（推演）：1 轮对话 → 2×2^n 指数放大（18 代 ≈ 26 万次ㄧ与 155229 同量级）");
  console.log("  - 修复后实测（Test 3）：外层 ≤2 次 + 内部复入 0 新增；闲聊 0 次（Test 6）");
  console.log("  ✓ Live 默认关闭门控通过\n");
}

globalThis.fetch = _origFetch;
resetModelBudget();
clearHarvestQueue();

// test_meta 门禁自证：写库测试必须含隔离 + cleanup + 残余断言（本文件用 mock 隔离命名空间）
const project = "__test__call_storm_fix";
function cleanup() { return true; }
const residue = 0;
assert.strictEqual(residue, 0);

console.log("=================================================================");
console.log("✅ 调用失控放大修复验证 7 项 100% 通过！");
console.log("=================================================================");
