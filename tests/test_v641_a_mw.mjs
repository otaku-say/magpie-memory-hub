/**
 * tests/test_v641_a_mw.mjs
 * =================================================================
 * ARCH-2: memory.middleware.js 零拷贝快路径双向反证专项测试
 *
 * 核心目标：
 * 1. 【宿主快路径正向】在宿主环境下（typeof ctx.report === "function"，ctx.reject 不存在），
 *    当 event 未被修改时，onEvent 必须返回 undefined 触发宿主零拷贝（内部跳过 JSON 序列化）；
 * 2. 【宿主修改反证】当 event 发生实质性修改（剔除 <memory> 块或流结束释放未闭合缓冲）时，
 *    onEvent 绝不得返回 undefined，必须返回修改后的 event 对象；
 * 3. 【测试环境兼容正向与反证】在单测/测试环境下（!ctx || typeof ctx.report !== "function"），
 *    未修改与已修改均返回 event 对象，100% 保持既有单测断言兼容；
 * 4. 【宿主判定防线反证】验证宿主判定严格依据 typeof ctx.report === "function"：
 *    - ctx.reject 不存在时依然稳定识别为宿主并走 undefined 快路径；
 *    - 伪造 ctx.reject 存在而无 report 时坚决判定为测试环境（返回 event）；
 *    - 顶层异常 fail-open 保命分支按环境自适应返回。
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { onEvent } from "../memory.middleware.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【ARCH-2 memory.middleware.js 零拷贝快路径双向反证】");
console.log("=================================================================\n");

// 辅助构造 Chat 格式 SSE 事件
function makeChunk(text, finishReason = null) {
  return {
    choices: [
      {
        delta: text !== null ? { content: text } : {},
        finish_reason: finishReason,
      },
    ],
  };
}

// 辅助构造 Anthropic 格式 SSE 事件
function makeAnthropicChunk(text) {
  return {
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  };
}

// =================================================================
// 门禁一：宿主环境零拷贝快路径正向与反证验证
// =================================================================
console.log("▶ [Test 1] 宿主环境 (typeof ctx.report === 'function') 零拷贝快路径");

// 1.a 未修改普通文本 chunk → 必须返回 undefined（快路径生效）
{
  const reports = [];
  const hostCtx = {
    options: { inline_extract: true },
    state: { inlineExtract: true, memHold: 0, memBuf: "", memPending: "" },
    report: (code, count) => reports.push({ code, count }),
    // 关键事实：宿主环境下 ctx.reject 不存在
    reject: undefined,
  };

  const normalEvent = makeChunk("Hello world! 这是普通对话内容。");
  const res = onEvent(normalEvent, hostCtx);

  assert.strictEqual(
    res,
    undefined,
    "【反证 1.a】宿主环境下普通未修改文本必须返回 undefined 走零拷贝快路径"
  );
  console.log("  ✓ 1.a 宿主环境下普通文本 chunk 返回 undefined（零拷贝快路径命中）");
}

// 1.b 空文本 / ping / keepalive 结构 chunk → 必须返回 undefined
{
  const hostCtx = {
    options: { inline_extract: true },
    state: { inlineExtract: true, memHold: 0 },
    report: () => {},
  };

  const pingEvent = { type: "ping" };
  const resPing = onEvent(pingEvent, hostCtx);
  assert.strictEqual(resPing, undefined, "【反证 1.b】ping 事件未修改必须返回 undefined");

  const emptyEvent = makeChunk(null);
  const resEmpty = onEvent(emptyEvent, hostCtx);
  assert.strictEqual(resEmpty, undefined, "【反证 1.b】空 delta 事件未修改必须返回 undefined");
  console.log("  ✓ 1.b 宿主环境下 ping/空 chunk 均返回 undefined");
}

// 1.c 直通态 (memBypassed = true) 或未开启 inlineExtract → 必须快速返回 undefined
{
  const hostCtx = {
    options: { inline_extract: true },
    state: { inlineExtract: true, memBypassed: true, memPending: "", memBuf: "" },
    report: () => {},
  };
  const event = makeChunk("Bypassed content");
  const res = onEvent(event, hostCtx);
  assert.strictEqual(res, undefined, "【反证 1.c】直通态未修改必须快速返回 undefined");

  const hostCtxDisabled = {
    options: { inline_extract: false },
    state: { inlineExtract: false },
    report: () => {},
  };
  const resDisabled = onEvent(makeChunk("Disabled extract"), hostCtxDisabled);
  assert.strictEqual(resDisabled, undefined, "【反证 1.c】未开启内联剥离必须返回 undefined");
  console.log("  ✓ 1.c 宿主环境下直通态与未开启 inlineExtract 均快速返回 undefined");
}

// 1.d 流正常结束且无积压缓冲 → 必须返回 undefined
{
  const hostCtx = {
    options: { inline_extract: true },
    state: { inlineExtract: true, memHold: 0, memBuf: "", memPending: "" },
    report: () => {},
  };
  const finishEvent = makeChunk("", "stop");
  const res = onEvent(finishEvent, hostCtx);
  assert.strictEqual(res, undefined, "【反证 1.d】正常流结束且无扣留缓冲必须返回 undefined");
  console.log("  ✓ 1.d 宿主环境下无缓冲 finish event 返回 undefined");
}

// 1.e 【核心反证 1】包含 <memory> 标签被修改时 → 绝对不得返回 undefined，必须返回修改后的 event
{
  const hostCtx = {
    options: { inline_extract: true },
    state: { inlineExtract: true, memHold: 0, memBuf: "", memPending: "" },
    report: () => {},
  };
  const memEvent = makeChunk('<memory>[{"title":"偏好","content":"偏好测试"}]</memory>正文开始');
  const res = onEvent(memEvent, hostCtx);

  assert.notStrictEqual(res, undefined, "【核心反证 1.e】被剥离修改的 event 绝对不得返回 undefined！");
  assert.strictEqual(typeof res, "object", "被修改的 event 必须返回对象形式");
  assert.strictEqual(
    res.choices[0].delta.content,
    "正文开始",
    "必须准确剥离记忆块，仅保留用户可见正文"
  );
  console.log("  ✓ 1.e [核心反证] 发生标签剥离修改时，精准返回修改后的 event 对象（非 undefined）");
}

// 1.f 【核心反证 2】流结束时释放未闭合扣留缓冲 → 绝对不得返回 undefined，必须释放正文
{
  const hostCtx = {
    options: { inline_extract: true },
    state: {
      inlineExtract: true,
      memHold: 1,
      memBuf: "<memory>[{\"title\":\"未闭合",
      memPending: "",
    },
    report: () => {},
  };
  const finishEvent = makeChunk("已完成", "stop");
  const res = onEvent(finishEvent, hostCtx);

  assert.notStrictEqual(res, undefined, "【核心反证 1.f】流结束释放扣留缓冲时绝对不得返回 undefined！");
  assert.strictEqual(
    res.choices[0].delta.content,
    "<memory>[{\"title\":\"未闭合已完成",
    "未闭合缓冲必须完整合并释放至当前 event"
  );
  console.log("  ✓ 1.f [核心反证] 流结束保命释放缓冲时，返回携带释放内容的 event 对象（非 undefined）");
}

// 1.g 宿主异常 fail-open 分支自适应
{
  // 1.g.1 无扣留时异常 → fail-open 返回 undefined 透传
  const hostCtxClean = {
    options: { inline_extract: true },
    state: { inlineExtract: true, memHold: 0, memBuf: "", memPending: "" },
    report: () => {},
  };
  const brokenEvent1 = { choices: [{ get delta() { throw new Error("测试无害异常1"); } }] };
  const resClean = onEvent(brokenEvent1, hostCtxClean);
  assert.strictEqual(resClean, undefined, "【反证 1.g.1】无扣留缓冲异常时，宿主环境 fail-open 返回 undefined");

  // 1.g.2 有扣留时异常 → 强制释放扣留内容到 event 并返回该 event（绝不丢用户内容）
  const hostCtxDirty = {
    options: { inline_extract: true },
    state: { inlineExtract: true, memHold: 1, memBuf: "重要未闭合数据", memPending: "" },
    report: () => {},
  };
  const brokenEvent2 = {
    choices: [{ delta: { content: "现有文本" } }],
  };
  const proxyEvent = new Proxy(brokenEvent2, {
    get(target, prop) {
      if (prop === "choices") throw new Error("故意触发内部异常以测试保命释放");
      return target[prop];
    },
  });
  const resDirty = onEvent(proxyEvent, hostCtxDirty);
  assert.strictEqual(hostCtxDirty.state.memBypassed, true, "异常后状态必须标记为 memBypassed");
  assert.strictEqual(hostCtxDirty.state.memBuf, "", "扣留缓冲必须清空释放");
  console.log("  ✓ 1.g 宿主 fail-open 保命分支按扣留状态自适应处理");
}

// =================================================================
// 门禁二：测试环境 (无 ctx.report) 保持返回 event 100% 兼容验证
// =================================================================
console.log("\n▶ [Test 2] 测试环境兼容性验证 (保持返回 event)");

// 2.a 测试环境下未修改的普通文本 → 必须返回原始 event 对象（不得返回 undefined 破坏既有测试）
{
  const testCtx = {
    options: { inline_extract: true },
    state: { inlineExtract: true, memHold: 0, memBuf: "", memPending: "" },
    // 关键：测试环境无 report 函数
  };
  const event = makeChunk("测试环境普通文本");
  const res = onEvent(event, testCtx);

  assert.strictEqual(res, event, "【反证 2.a】测试环境下即便未修改也必须返回 event 对象保持兼容");
  console.log("  ✓ 2.a 测试环境下普通文本返回 event 对象（保持兼容）");
}

// 2.b 测试环境下发生剥离修改 → 返回修改后的 event
{
  const testCtx = {
    options: { inline_extract: true },
    state: { inlineExtract: true, memHold: 0, memBuf: "", memPending: "" },
  };
  const event = makeChunk("<memory>[{}]</memory>正文内容");
  const res = onEvent(event, testCtx);

  assert.strictEqual(res, event, "【反证 2.b】测试环境下修改后返回同一个 event 对象");
  assert.strictEqual(res.choices[0].delta.content, "正文内容");
  console.log("  ✓ 2.b 测试环境下剥离后正常返回 event 对象");
}

// 2.c 测试环境空/极端 ctx 兼容
{
  const event = makeChunk("极端输入");
  assert.strictEqual(onEvent(event, null), event, "ctx=null 必须返回 event");
  assert.strictEqual(onEvent(event, undefined), event, "ctx=undefined 必须返回 event");
  assert.strictEqual(onEvent(event, {}), event, "ctx={} (无 state) 必须返回 event");
  console.log("  ✓ 2.c 极端/缺省 ctx 下测试环境均安全返回 event");
}

// 2.d 测试环境下 Anthropic / Responses 协议格式返回兼容
{
  const testCtx = {
    options: { inline_extract: true },
    state: { inlineExtract: true },
  };
  const antEvent = makeAnthropicChunk("Anthropic delta");
  const resAnt = onEvent(antEvent, testCtx);
  assert.strictEqual(resAnt, antEvent, "Anthropic 协议在测试环境必须返回原始 event");
  console.log("  ✓ 2.d 多协议事件在测试环境均返回 event");
}

// =================================================================
// 门禁三：宿主检测边界与 ctx.reject 防线验证
// =================================================================
console.log("\n▶ [Test 3] 宿主检测准则 (typeof ctx.report === 'function'，ctx.reject 不存在)");

// 3.a 真实宿主：有 report，无 reject → 必须正确识别为宿主（返回 undefined）
{
  const realHostCtx = {
    state: { inlineExtract: true, memHold: 0 },
    report: function (code, count) {},
    reject: undefined, // 宿主没有 reject
  };
  const event = makeChunk("纯文本");
  const res = onEvent(event, realHostCtx);
  assert.strictEqual(res, undefined, "【反证 3.a】有 report 且无 reject 时必须被正确判定为宿主走快路径");
  console.log("  ✓ 3.a 有 report 无 reject 场景准确命中宿主快路径（返回 undefined）");
}

// 3.b 伪造/旧版单测：仅有 reject 而无 report → 坚决判定为测试环境（返回 event）
{
  const mockTestCtx = {
    state: { inlineExtract: true, memHold: 0 },
    reject: function (code, msg) {}, // 伪造的 reject
    report: undefined, // 没有 report
  };
  const event = makeChunk("纯文本");
  const res = onEvent(event, mockTestCtx);
  assert.strictEqual(
    res,
    event,
    "【反证 3.b】仅有 reject 而无 report 时不得判定为宿主，必须返回 event 保持测试兼容"
  );
  console.log("  ✓ 3.b [反证门] 仅有 reject 无 report 场景安全退回测试兼容（返回 event）");
}

// 3.c 静态源码断言：确认 memory.middleware.js 采用 typeof ctx.report === "function"
{
  const src = fs.readFileSync(new URL("../memory.middleware.js", import.meta.url), "utf8");
  assert.ok(
    /typeof\s+ctx\.report\s*===\s*["']function["']/.test(src),
    "【静态反证 3.c】源码中必须严格使用 typeof ctx.report === 'function' 判断宿主"
  );
  assert.ok(
    !/isHostRuntime\s*=\s*Boolean\([^)]*ctx\.reject[^)]*\)/.test(src),
    "【静态反证 3.c】宿主判断中绝不得依赖 ctx.reject！"
  );
  console.log("  ✓ 3.c 静态断言通过：宿主判定精准基于 ctx.report，零 ctx.reject 误依赖");
}

// =================================================================
// 门禁四：测试文件自身规范元检查
// =================================================================
console.log("\n▶ [Test 4] 测试规范元检查与断言自验");
{
  const selfPath = fileURLToPath(import.meta.url);
  const selfCode = fs.readFileSync(selfPath, "utf8");
  const scanRes = scanTestFile(selfPath, selfCode);
  if (scanRes.issues.length > 0) {
    for (const is of scanRes.issues) console.error("   - " + is);
  }
  assert.strictEqual(scanRes.issues.length, 0, "test_v641_a_mw.mjs 必须 0 规范违规");
  console.log("  ✓ test_v641_a_mw.mjs 元检查 0 违规，符合测试严谨性标准");
}

console.log("\n=================================================================");
console.log("🎉 ARCH-2 零拷贝快路径与兼容性双向反证 100% 全部通过！");
console.log("=================================================================");
