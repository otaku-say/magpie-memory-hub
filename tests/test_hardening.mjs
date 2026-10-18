/**
 * test_hardening.mjs —— 三项健壮性加固全面回归与反证测试
 *
 * 覆盖：
 *   1. 加固一：设置页 queuedOptionsSet 防抖、字段合并、与 immediate 立即 flush 机制
 *   2. 加固二：流式与非流式思维链隔离（OpenAI / Anthropic / 正文标签），客户端逐字节不变证明，加法式保命
 *   3. 加固三：__MEMHUB_PROBE__ 存活探针 418 响应、健康数据结构、严格全等匹配与防御性降级
 */

import assert from "node:assert";
import { onRequest, onEvent, onResponse } from "../memory.middleware.js";

console.log("=================================================================");
console.log("【加固三测试】__MEMHUB_PROBE__ 存活探针测试");
console.log("=================================================================");

// 1.1 Chat 协议触发 418 探针
{
  let rejectCalled = false;
  let rejectCode = 0;
  let rejectBody = "";

  const ctx = {
    protocol: "chat",
    options: {
      disabled: false,
      memories: [{ id: 1, title: "测试记忆" }],
      compress: true
    },
    state: { turnNo: 2 },
    reject: (code, msg) => {
      rejectCalled = true;
      rejectCode = code;
      rejectBody = msg;
      return { rejected: true, code, msg };
    }
  };

  const body = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "__MEMHUB_PROBE__" }
    ]
  };

  const res = onRequest(body, ctx);
  assert.strictEqual(rejectCalled, true, "严格全等 __MEMHUB_PROBE__ 必须触发 ctx.reject");
  assert.strictEqual(rejectCode, 418, "探针响应状态码必须为 418");
  assert.strictEqual(res.rejected, true, "onRequest 必须返回 ctx.reject 的返回值");

  const data = JSON.parse(rejectBody);
  assert.strictEqual(data.status, "ok", "probe status 应为 ok");
  assert.strictEqual(data.probe, "__MEMHUB_PROBE__", "probe 标识匹配");
  assert.strictEqual(data.plugin, "magpie-memory-hub", "插件标识匹配");
  assert.strictEqual(data.version, "5.0", "中间件版本匹配");
  assert.strictEqual(data.disabled, false, "disabled 状态匹配");
  assert.strictEqual(data.memories_count, 1, "记忆数量应为 1");
  assert.strictEqual(data.compress, true, "压缩开关应为 true");
  assert.strictEqual(data.protocol, "chat", "协议识别为 chat");
  assert.strictEqual(data.turn_no, 3, "turn_no 正确递增");
  assert.ok(typeof data.timestamp === "number" && data.timestamp > 0, "带有效时间戳");
  console.log("✓ Chat 协议 418 探针触发成功，回传健康状态 JSON 字段完整");
}

// 1.2 多协议支持测试（Anthropic / Responses / Gemini）
for (const proto of ["anthropic", "responses", "gemini"]) {
  let rejectCalled = false;
  const ctx = {
    protocol: proto,
    options: { disabled: false, memories: [] },
    reject: (code, msg) => {
      rejectCalled = true;
      return { rejected: true, code, msg };
    }
  };

  let body = {};
  if (proto === "anthropic") {
    body = { messages: [{ role: "user", content: "__MEMHUB_PROBE__" }] };
  } else if (proto === "responses") {
    body = { input: [{ role: "user", content: [{ type: "input_text", text: "__MEMHUB_PROBE__" }] }] };
  } else if (proto === "gemini") {
    body = { contents: [{ role: "user", parts: [{ text: "__MEMHUB_PROBE__" }] }] };
  }

  onRequest(body, ctx);
  assert.strictEqual(rejectCalled, true, `${proto} 协议探针触发成功`);
}
console.log("✓ Anthropic / Responses / Gemini 多协议探针均支持");

// 1.3 反证测试：模糊匹配与正常对话绝不误触发探针
{
  let rejectCalled = false;
  const ctx = {
    protocol: "chat",
    options: { memories: [] },
    reject: () => { rejectCalled = true; }
  };

  const normalInputs = [
    "__MEMHUB_PROBE__ extra text",
    "prefix __MEMHUB_PROBE__",
    "Please tell me what __MEMHUB_PROBE__ means",
    "__memhub_probe__"
  ];

  for (const text of normalInputs) {
    rejectCalled = false;
    const body = { messages: [{ role: "user", content: text }] };
    const res = onRequest(body, ctx);
    assert.strictEqual(rejectCalled, false, `包含子串 "${text}" 绝不能误触发探针`);
    assert.strictEqual(res, body, "正常请求原样透传");
  }
  console.log("✓ 反证通过：非严格全等的输入绝不误触发 418 探针（零重叠率保障）");
}

// 1.4 反证测试：ctx.reject 缺失时防御性降级不抛异常
{
  const ctxNoReject = {
    protocol: "chat",
    options: { disabled: false, memories: [] }
  };
  const body = { messages: [{ role: "user", content: "__MEMHUB_PROBE__" }] };
  let threw = false;
  let res = null;
  try {
    res = onRequest(body, ctxNoReject);
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, "ctx.reject 缺失时绝不能抛出异常");
  assert.strictEqual(res, body, "ctx.reject 缺失时安全降级透传 body");
  console.log("✓ 反证通过：ctx.reject 不存在时防御性降级生效，fail-open 原样透传");
}

// 1.5 插件 disabled 时探针仍可探活并返回 disabled: true
{
  let rejectBody = "";
  const ctxDisabled = {
    protocol: "chat",
    options: { disabled: true, memories: [] },
    reject: (code, msg) => {
      rejectBody = msg;
      return { rejected: true };
    }
  };
  const body = { messages: [{ role: "user", content: "__MEMHUB_PROBE__" }] };
  onRequest(body, ctxDisabled);
  assert.ok(rejectBody, "disabled 状态下探针依然响应");
  const data = JSON.parse(rejectBody);
  assert.strictEqual(data.disabled, true, "探针准确反馈当前处于 disabled 状态");
  console.log("✓ disabled 状态下探针正常工作，便于外部健康监控探活");
}

console.log("\n=================================================================");
console.log("【加固二测试】思维链流式与非流式隔离测试");
console.log("=================================================================");

// 2.1 正文中 <think>...</think> 段：开启 inline_extract 时思考链完整保留且 <memory> 块精准剥离测试
{
  const ctx = {
    options: { inline_extract: true },
    state: { promptText: "请回答宇宙的终极答案是什么？", inlineExtract: true }
  };

  const chunks = [
    { choices: [{ delta: { content: "<think>The user is asking the ultimate question." } }] },
    { choices: [{ delta: { content: " According to Hitchhiker's Guide to the Galaxy, the answer is 42." } }] },
    { choices: [{ delta: { content: " I should state this clearly.</think>宇宙的终极答案是 42。<memory>[{\"title\":\"答案\",\"content\":\"42\"}]</memory>" } }] },
    { choices: [{ delta: { content: "出自《银河系漫游指南》。" }, finish_reason: "stop" }] }
  ];

  for (const chunk of chunks) {
    onEvent(chunk, ctx);
  }

  const fullOutput = chunks.map(c => c.choices[0]?.delta?.content || "").join("");
  assert.ok(fullOutput.includes("<think>The user is asking the ultimate question."), "思考过程 <think> 标签与内容完整保留");
  assert.ok(fullOutput.includes("宇宙的终极答案是 42。"), "正常回答完整保留");
  assert.strictEqual(fullOutput.includes("<memory>"), false, "<memory> 提炼块已从客户端呈现中精准剥离");
  console.log("✓ 真测试验证通过：开启 inlineExtract 时思考链 100% 保留且 <memory> 标签被精准剔除");
}

// 2.2 跨 chunk 切分的思考标签透传测试
{
  const ctx = {
    options: { inline_extract: false },
    state: { promptText: "测试跨 chunk 标签" }
  };

  const chunks = [
    { choices: [{ delta: { content: "前言：<th" } }] },
    { choices: [{ delta: { content: "ink>这里是漫长的思考过程</th" } }] },
    { choices: [{ delta: { content: "ink>正文结果。" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] }
  ];

  const origChunksJson = JSON.stringify(chunks);
  for (const chunk of chunks) onEvent(chunk, ctx);

  assert.strictEqual(JSON.stringify(chunks), origChunksJson, "跨 chunk 切分场景下客户端流式内容逐字节不变");
  console.log("✓ 跨 chunk 切分的思考标签在客户端流式通道中 100% 逐字节保真透传");
}

// 2.3 反证测试：非思考标签的类似前缀绝对不能丢失（加法式保命）
{
  const ctx = {
    options: { inline_extract: false },
    state: { promptText: "测试假标签保命" }
  };

  const chunks = [
    { choices: [{ delta: { content: "代码：<th" } }] },
    { choices: [{ delta: { content: "read>安全的线程内容</thread>" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] }
  ];

  const origChunksJson = JSON.stringify(chunks);
  for (const chunk of chunks) onEvent(chunk, ctx);

  assert.strictEqual(JSON.stringify(chunks), origChunksJson, "假标签场景下客户端流式内容逐字节不变");
  console.log("✓ 反证通过：加法式保命生效，非思考标签 <thread> 客户端逐字节不变");
}

// 2.4 OpenAI 风格 delta.reasoning_content 纯思考块透传测试
{
  const ctx = {
    options: { inline_extract: false },
    state: { promptText: "测试 reasoning_content" }
  };

  const chunks = [
    { choices: [{ delta: { reasoning_content: "Step 1: check parameters." } }] },
    { choices: [{ delta: { reasoning_content: "Step 2: formulate reply." } }] },
    { choices: [{ delta: { content: "正式答复。" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] }
  ];

  const origChunksJson = JSON.stringify(chunks);
  for (const chunk of chunks) onEvent(chunk, ctx);

  assert.strictEqual(JSON.stringify(chunks), origChunksJson, "客户端 reasoning_content 逐字节不变");
  console.log("✓ OpenAI 风格 delta.reasoning_content 成功隔离，透传零篡改");
}

// 2.5 Anthropic 风格 thinking_delta 纯思考块透传测试
{
  const ctx = {
    options: { inline_extract: false },
    state: { promptText: "测试 thinking_delta" }
  };

  const chunks = [
    { type: "content_block_start", content_block: { type: "thinking" } },
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Claude deep thinking" } },
    { type: "content_block_start", content_block: { type: "text" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Claude 正文。" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } }
  ];

  const origChunksJson = JSON.stringify(chunks);
  for (const chunk of chunks) onEvent(chunk, ctx);

  assert.strictEqual(JSON.stringify(chunks), origChunksJson, "Anthropic thinking 结构逐字节不变");
  console.log("✓ Anthropic 风格 thinking_delta 成功隔离，透传零篡改");
}

// 2.6 非流式 onResponse 思维链隔离测试
{
  const ctx = {
    options: { inline_extract: false },
    state: {}
  };

  const body = {
    choices: [{
      message: {
        role: "assistant",
        content: "<think>Hidden reasoning...</think>Clean answer for user."
      }
    }]
  };

  const origBodyJson = JSON.stringify(body);
  const res = onResponse(body, ctx);

  // 证明客户端非流式 body 逐字节不变
  assert.strictEqual(JSON.stringify(res), origBodyJson, "客户端非流式 body 逐字节不变");
  console.log("✓ 非流式 onResponse 正确隔离思维链，客户端正文逐字节不变");
}

console.log("\n=================================================================");
console.log("【加固一测试】设置页 queuedOptionsSet 防抖与排队测试");
console.log("=================================================================");
{
  // 模拟沙箱环境与桥接
  let rawSetCalls = 0;
  let lastPayloadWritten = null;

  global.window = {
    magpie: {
      options: {
        set: async (payload) => {
          rawSetCalls++;
          lastPayloadWritten = JSON.parse(JSON.stringify(payload));
          return lastPayloadWritten;
        }
      }
    }
  };

  // 从真实 settings.js 提取并加载防抖逻辑
  const settingsSrc = fs.readFileSync(path.join(__dirname, "../settings.js"), "utf8");
  const vmCtx = {
    window: { magpie: { options: { set: async (o) => { rawSetCalls++; lastPayload = o; return o; } } } },
    setTimeout,
    clearTimeout,
    Date,
    Object,
    Promise,
  };
  vm.createContext(vmCtx);
  const qCode = settingsSrc.slice(settingsSrc.indexOf("var queuedTimer = null;"), settingsSrc.indexOf("function collect()"));
  vm.runInContext(qCode, vmCtx);
  const queuedOptionsSet = vmCtx.queuedOptionsSet;

  // 3.1 连续快速点击多个按钮/开关：只有最后一次真正落盘，配置全量合并
  rawSetCalls = 0;
  queuedOptionsSet({ fieldA: 1, shared: "first" }, false);
  queuedOptionsSet({ fieldB: 2, shared: "second" }, false);
  queuedOptionsSet({ fieldC: 3, shared: "third" }, false);

  assert.strictEqual(rawSetCalls, 0, "1100ms 防抖期内不发起底层落盘");
  await new Promise((r) => setTimeout(r, 1200));

  assert.strictEqual(rawSetCalls, 1, "防抖结束后仅发生 1 次真正落盘（避免 429）");
  assert.strictEqual(lastPayloadWritten.fieldA, 1, "保留 fieldA");
  assert.strictEqual(lastPayloadWritten.fieldB, 2, "保留 fieldB");
  assert.strictEqual(lastPayloadWritten.fieldC, 3, "保留 fieldC");
  assert.strictEqual(lastPayloadWritten.shared, "third", "相同字段以最后一次改动为准");
  console.log("✓ 连续快速操作防抖 1100ms 生效：仅落盘 1 次且所有字段合并完整，未丢配置");

  // 3.2 关键动作（信标提交 _action）立即 flush 队列
  await new Promise((r) => setTimeout(r, 1100)); // 渡过频控安全期
  rawSetCalls = 0;
  // 先排队一个修改
  queuedOptionsSet({ backgroundField: "saved_pending" }, false);
  assert.strictEqual(rawSetCalls, 0, "排队中尚未落盘");

  // 紧接着触发信标
  queuedOptionsSet({ _action: { op: "provision", id: "p1" } }, true);
  // immediate 应立刻执行底层调用
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(rawSetCalls, 1, "信标提交立即 flush 落盘，零延迟！");
  assert.strictEqual(lastPayloadWritten.backgroundField, "saved_pending", "排队的配置并入信标提交一并落盘");
  assert.strictEqual(lastPayloadWritten._action.op, "provision", "信标载荷完整写入");
  console.log("✓ 关键动作带 _action 立即 flush 生效，信标零延迟且带上排队配置");
}

console.log("\n=================================================================");
console.log("✅ 三项加固全部测试通过！所有断言 100% 达成。");
console.log("=================================================================");
