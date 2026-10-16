/**
 * tests/test_multi_protocol.mjs —— 多协议支持深度验收测试
 *
 * 覆盖四种协议：
 *   1. chat      (OpenAI Chat Completions: body.messages, choices[].delta.content)
 *   2. anthropic (Anthropic Messages: body.messages, content_block_delta -> delta.text)
 *   3. responses (OpenAI Responses: body.input 为字符串或数组, response.output_text.delta)
 *   4. gemini    (Google Gemini: body.contents, candidates[].content.parts[].text)
 *
 * 验证维度：
 *   - 注入位置精准（仅最后一条用户消息前缀插入，严格保 KV-Cache 不变）
 *   - schema 规范校验（responses 塞 input_text，gemini 仅塞纯 text Part）
 *   - 流式 <memory> 剥离状态机（正常、跨 chunk 切断、极端 1 字节流、未闭合保命）
 *   - 非流式 onResponse 剥离与采集
 *   - 反证用例（故意破坏/反向断言验证门禁真实拦截能力）
 */
import assert from "node:assert/strict";

const MW = await import(new URL("../memory.middleware.js", import.meta.url).href);
const { onRequest, onEvent, onResponse } = MW;

let passed = 0;
function pass(msg) {
  passed++;
  console.log(`  ✓ ${msg}`);
}

const mockMemories = [
  {
    id: 101,
    project: "demo",
    category: "fact",
    title: "Docker端口约定",
    content: "本地开发统一使用 8080 端口，生产环境使用 443 端口",
    tags: "docker,port",
    retrieval_count: 5,
    lifecycle_status: "active"
  },
  {
    id: 102,
    project: "demo",
    category: "principle",
    title: "避坑准则：不要直接写库",
    content: "所有配置必须经由 options 传递，禁止中间件直连网络",
    tags: "db,rule",
    retrieval_count: 20,
    lifecycle_status: "active"
  }
];

const defaultOptions = {
  memories: mockMemories,
  inline_extract: true,
  inject_principles: true,
  max_inject_count: 3
};

console.log("=================================================================");
console.log("【测试 1/5】四种协议 onRequest 记忆注入与历史保密性验证");
console.log("=================================================================");

// 1.1 Chat 协议
{
  const body = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "第一轮用户问题" },
      { role: "assistant", content: "第一轮回复" },
      { role: "user", content: "请问 Docker 端口怎么配？" }
    ]
  };
  const ctx = { protocol: "chat", options: defaultOptions, state: {} };
  const historyBefore = JSON.stringify(body.messages.slice(0, 3));

  onRequest(body, ctx);

  assert.strictEqual(JSON.stringify(body.messages.slice(0, 3)), historyBefore, "Chat 历史消息与 system 必须字节级不变（保 KV-Cache）");
  assert.ok(body.messages[3].content.includes("[Persistent Memory Context]"), "最后一条用户消息必须成功注入记忆上下文");
  assert.ok(body.messages[3].content.endsWith("请问 Docker 端口怎么配？"), "用户原始提问必须完好保留在末尾");
  assert.strictEqual(ctx.state.promptText, "请问 Docker 端口怎么配？", "promptText 提取正确");
  pass("Chat 协议注入成功，历史与 system 零改动");
}

// 1.2 Anthropic 协议（数组型 content 块）
{
  const body = {
    model: "claude-3-7-sonnet",
    messages: [
      { role: "user", content: "你好" },
      { role: "assistant", content: [{ type: "text", text: "你好！有什么我可以帮你的？" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "关于 Docker 端口 配置的规范是怎样的？" }
        ]
      }
    ]
  };
  const ctx = { protocol: "anthropic", options: defaultOptions, state: {} };
  const historyBefore = JSON.stringify(body.messages.slice(0, 2));

  onRequest(body, ctx);

  assert.strictEqual(JSON.stringify(body.messages.slice(0, 2)), historyBefore, "Anthropic 历史消息必须字节级不变");
  assert.strictEqual(body.messages[2].content[0].type, "text", "新插入的块必须为合法 text 类型");
  assert.ok(body.messages[2].content[0].text.includes("[Persistent Memory Context]"), "第一块必须注入记忆上下文");
  assert.strictEqual(body.messages[2].content[1].text, "关于 Docker 端口 配置的规范是怎样的？", "原始文本块位置顺延且内容不变");
  pass("Anthropic 协议块数组注入成功");
}

// 1.3 Responses 协议（形态 A：纯字符串 input）
{
  const body = {
    model: "gpt-5-codex",
    input: "我想知道 Docker 端口 的约定。"
  };
  const ctx = { protocol: "responses", options: defaultOptions, state: {} };

  onRequest(body, ctx);

  assert.strictEqual(typeof body.input, "string", "Responses 纯字符串形态保持为 string");
  assert.ok(body.input.includes("[Persistent Memory Context]"), "纯字符串 input 注入记忆上下文");
  assert.ok(body.input.endsWith("我想知道 Docker 端口 的约定。"), "用户原始文本保留在结尾");
  assert.strictEqual(ctx.state.promptText, "我想知道 Docker 端口 的约定。", "Responses 字符串 promptText 提取准确");
  pass("Responses 纯字符串 input 注入成功");
}

// 1.4 Responses 协议（形态 B：对象数组 input，强校验 input_text 类型）
{
  const body = {
    model: "gpt-5-codex",
    input: [
      { type: "message", role: "developer", content: "instructions here" },
      { type: "message", role: "user", content: "历史提问" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "历史回答" }] },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "查一下 Docker 端口" }
        ]
      }
    ]
  };
  const ctx = { protocol: "responses", options: defaultOptions, state: {} };
  const historyBefore = JSON.stringify(body.input.slice(0, 3));

  onRequest(body, ctx);

  assert.strictEqual(JSON.stringify(body.input.slice(0, 3)), historyBefore, "Responses 历史 turns 字节级不变");
  const lastUser = body.input[3];
  assert.strictEqual(lastUser.content[0].type, "input_text", "Responses 注入块类型必须为 schema 规定的 input_text");
  assert.ok(lastUser.content[0].text.includes("[Persistent Memory Context]"), "首个 input_text 块包含记忆注入");
  assert.strictEqual(lastUser.content[1].text, "查一下 Docker 端口", "原始输入块完好保留");
  pass("Responses 数组 input 注入成功（严格符合 input_text schema）");
}

// 1.5 Gemini 协议（body.contents 与 Part schema 规范）
{
  const body = {
    model: "gemini-2.5-pro",
    contents: [
      { role: "user", parts: [{ text: "早上好" }] },
      { role: "model", parts: [{ text: "早上好！" }] },
      {
        role: "user",
        parts: [
          { text: "请说明 Docker 端口 配置" }
        ]
      }
    ]
  };
  const ctx = { protocol: "gemini", options: defaultOptions, state: {} };
  const historyBefore = JSON.stringify(body.contents.slice(0, 2));

  onRequest(body, ctx);

  assert.strictEqual(JSON.stringify(body.contents.slice(0, 2)), historyBefore, "Gemini 历史 turns 字节级不变");
  const lastParts = body.contents[2].parts;
  // Gemini 必须是合法 Part，不能带有非标准字段（如 type: 'text'）
  for (const part of lastParts) {
    assert.strictEqual(part.type, undefined, "Gemini Part 严禁带有非法 type 字段");
    assert.strictEqual(typeof part.text, "string", "Gemini Part text 必须为合法字符串");
  }
  assert.ok(lastParts[0].text.includes("[Persistent Memory Context]"), "Gemini 用户消息首部成功注入记忆");
  assert.ok(lastParts[0].text.includes("请说明 Docker 端口 配置"), "Gemini 用户原始正文完好");
  pass("Gemini 协议注入成功（严格符合 Gemini Part schema）");
}

console.log("\n=================================================================");
console.log("【测试 2/5】四种协议流式 onEvent 剥离与正文保全");
console.log("=================================================================");

// 2.1 Chat 流式事件
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { choices: [{ delta: { content: "回答正文第一段 <mem" } }] };
  const ev2 = { choices: [{ delta: { content: "ory>[{\"title\":\"t\"}]</memory>正文第二段" } }] };
  const ev3 = { choices: [{ delta: { content: "，顺利完成。" }, finish_reason: "stop" }] };

  onEvent(ev1, ctx);
  onEvent(ev2, ctx);
  onEvent(ev3, ctx);

  assert.strictEqual(ev1.choices[0].delta.content, "回答正文第一段 ");
  assert.strictEqual(ev2.choices[0].delta.content, "正文第二段");
  assert.strictEqual(ev3.choices[0].delta.content, "，顺利完成。");

  pass("Chat 流式事件成功跨 chunk 剥离 <memory>，正文无损");
}

// 2.2 Anthropic 流式事件
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { type: "content_block_delta", delta: { type: "text_delta", text: "Anthropic output: <memory>[{\"x\":1}]</memory>All good." } };
  onEvent(ev1, ctx);
  assert.strictEqual(ev1.delta.text, "Anthropic output: All good.");
  pass("Anthropic content_block_delta 流式剥离成功");
}

// 2.3 Responses 流式事件 (response.output_text.delta)
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { type: "response.output_text.delta", delta: "Responses: " };
  const ev2 = { type: "response.output_text.delta", delta: "<memory>[{\"k\":\"v\"}]" };
  const ev3 = { type: "response.output_text.delta", delta: "</memory>Final result." };
  const evDone = { type: "response.completed" };

  onEvent(ev1, ctx);
  onEvent(ev2, ctx);
  onEvent(ev3, ctx);
  onEvent(evDone, ctx);

  assert.strictEqual(ev1.delta, "Responses: ");
  assert.strictEqual(ev2.delta, "");
  assert.strictEqual(ev3.delta, "Final result.");
  pass("Responses response.output_text.delta 跨事件剥离成功");
}

// 2.4 Gemini 流式事件 (candidates[0].content.parts[0].text)
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { candidates: [{ content: { parts: [{ text: "Gemini text: <memory>[{\"cat\":\"fact\"}]</memory>Done." }] } }] };
  onEvent(ev1, ctx);
  assert.strictEqual(ev1.candidates[0].content.parts[0].text, "Gemini text: Done.");
  pass("Gemini candidates 结构流式剥离成功");
}

console.log("\n=================================================================");
console.log("【测试 3/5】极端边界条件：1 字节微步流与非标签保命");
console.log("=================================================================");

// 3.1 极端 1 字节流式切分
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const fullText = "PREFIX_<memory>[{\"a\":123}]</memory>_SUFFIX";
  let output = "";

  for (let i = 0; i < fullText.length; i++) {
    const ch = fullText[i];
    const ev = { choices: [{ delta: { content: ch } }] };
    onEvent(ev, ctx);
    output += ev.choices[0].delta.content;
  }
  const finishEv = { choices: [{ delta: { content: "" }, finish_reason: "stop" }] };
  onEvent(finishEv, ctx);
  output += finishEv.choices[0].delta.content;

  assert.strictEqual(output, "PREFIX__SUFFIX", "1 字节切分极端场景下，<memory> 必须完全被扣住剥离，周围文本完整拼接");

  pass("极端 1 字节切分流式剥离 100% 准确");
}

// 3.2 假标签前缀保命（例如 <members> 不是 <memory>）
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { choices: [{ delta: { content: "Our <mem" } }] };
  const ev2 = { choices: [{ delta: { content: "bers are active." } }] };

  onEvent(ev1, ctx);
  onEvent(ev2, ctx);

  const combined = ev1.choices[0].delta.content + ev2.choices[0].delta.content;
  assert.strictEqual(combined, "Our <members are active.", "非 <memory> 的类似标签前缀绝不误吞，一字不丢");
  pass("相似前缀识别无误，非标签文本完整释放");
}

// 3.3 流意外终结未闭合保命（加法式保命：fail-open）
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { choices: [{ delta: { content: "关键数据 <mem" } }] };
  // 模型突然中断或结束，未产生 ory>
  const finishEv = { choices: [{ delta: { content: "" }, finish_reason: "length" }] };

  onEvent(ev1, ctx);
  onEvent(finishEv, ctx);

  const total = ev1.choices[0].delta.content + finishEv.choices[0].delta.content;
  assert.strictEqual(total, "关键数据 <mem", "流中断时扣留的待定字符必须原样释放，绝不吞掉用户正文");
  pass("流异常中断时加法式保命生效");
}

console.log("\n=================================================================");
console.log("【测试 4/5】四种协议非流式 onResponse 剥离与采集");
console.log("=================================================================");

// 4.1 Chat
{
  const ctx = { options: { inline_extract: true }, state: {} };
  const body = { choices: [{ message: { content: "Chat: <memory>[1]</memory>OK" } }] };
  onResponse(body, ctx);
  assert.strictEqual(body.choices[0].message.content, "Chat: OK");

  pass("Chat onResponse 剥离成功");
}

// 4.2 Anthropic
{
  const ctx = { options: { inline_extract: true }, state: {} };
  const body = { content: [{ type: "text", text: "Anthropic: <memory>[2]</memory>OK" }] };
  onResponse(body, ctx);
  assert.strictEqual(body.content[0].text, "Anthropic: OK");
  pass("Anthropic onResponse 剥离成功");
}

// 4.3 Responses (body.output)
{
  const ctx = { options: { inline_extract: true }, state: {} };
  const body = {
    output: [
      {
        content: [
          { type: "output_text", text: "Responses: <memory>[3]</memory>OK" }
        ]
      }
    ]
  };
  onResponse(body, ctx);
  assert.strictEqual(body.output[0].content[0].text, "Responses: OK");
  pass("Responses onResponse (body.output) 剥离成功");
}

// 4.4 Gemini (body.candidates)
{
  const ctx = { options: { inline_extract: true }, state: {} };
  const body = {
    candidates: [
      {
        content: {
          parts: [
            { text: "Gemini: <memory>[4]</memory>OK" }
          ]
        }
      }
    ]
  };
  onResponse(body, ctx);
  assert.strictEqual(body.candidates[0].content.parts[0].text, "Gemini: OK");
  pass("Gemini onResponse (body.candidates) 剥离成功");
}

console.log("\n=================================================================");
console.log("【测试 5/5】反证用例与降级嗅探验证");
console.log("=================================================================");

// 5.1 反证：inline_extract 关停时断言「不得剥离」
{
  const ctx = { options: { inline_extract: false }, state: { inlineExtract: false } };
  const body = { choices: [{ message: { content: "Raw <memory>[tag]</memory> text" } }] };
  onResponse(body, ctx);

  assert.strictEqual(
    body.choices[0].message.content,
    "Raw <memory>[tag]</memory> text",
    "反证断言：inline_extract=false 时标签绝不能被剥离"
  );
  pass("反证 1 通过：配置未开启时标签完整保留");
}

// 5.2 反证：无协议指示（ctx.protocol 为空）时的字段形状自动降级嗅探
{
  // 无 ctx.protocol，嗅探 responses (body.input)
  const respBody = { input: "通过 input 嗅探协议" };
  const ctx1 = { options: defaultOptions, state: {} };
  onRequest(respBody, ctx1);
  assert.strictEqual(ctx1.state.protocol, "responses", "无 ctx.protocol 时根据 input 准确嗅探为 responses");

  // 无 ctx.protocol，嗅探 gemini (body.contents)
  const geminiBody = { contents: [{ role: "user", parts: [{ text: "通过 contents 嗅探" }] }] };
  const ctx2 = { options: defaultOptions, state: {} };
  onRequest(geminiBody, ctx2);
  assert.strictEqual(ctx2.state.protocol, "gemini", "无 ctx.protocol 时根据 contents 准确嗅探为 gemini");

  pass("反证 2 通过：自动降级协议嗅探在缺失 ctx.protocol 时准确无误");
}

console.log("\n=================================================================");
console.log("【测试 6/6】防吞正文：散文提及 <memory> 标签与真记忆块精准甄别");
console.log("=================================================================");

// 6.1 四协议流式：散文提到 <memory>（紧跟散文汉字/英文，非 [ 或 {）-> 正文一字不少
// 6.1.1 Chat 流式散文提到 <memory>（跨 chunk 切割）
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { choices: [{ delta: { content: "我们在说明中提到 <mem" } }] };
  const ev2 = { choices: [{ delta: { content: "ory> 标签作为示例，" } }] };
  const ev3 = { choices: [{ delta: { content: "后续正文必须百分之百保留。" } }] };
  const finishEv = { choices: [{ delta: {}, finish_reason: "stop" }] };

  onEvent(ev1, ctx);
  onEvent(ev2, ctx);
  onEvent(ev3, ctx);
  onEvent(finishEv, ctx);

  const full = (ev1.choices[0].delta.content || "") +
               (ev2.choices[0].delta.content || "") +
               (ev3.choices[0].delta.content || "") +
               (finishEv.choices[0].delta.content || "");
  assert.strictEqual(
    full,
    "我们在说明中提到 <memory> 标签作为示例，后续正文必须百分之百保留。",
    "Chat 流式散文提到 <memory> 必须一字不少完整透传"
  );
  pass("Chat 流式散文提及 <memory> 标签零吞字测试通过");
}

// 6.1.2 Anthropic 流式散文提到 <memory>
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { type: "content_block_delta", delta: { type: "text_delta", text: "Claude 指引：<memory> 是内部协议，" } };
  const ev2 = { type: "content_block_delta", delta: { type: "text_delta", text: "请严格遵循格式。" } };
  const finishEv = { type: "message_delta", delta: { stop_reason: "end_turn" } };

  onEvent(ev1, ctx);
  onEvent(ev2, ctx);
  onEvent(finishEv, ctx);

  const full = (ev1.delta.text || "") + (ev2.delta.text || "") + (finishEv.delta.text || "");
  assert.strictEqual(full, "Claude 指引：<memory> 是内部协议，请严格遵循格式。", "Anthropic 流式散文必须原样保留");
  pass("Anthropic 流式散文提及 <memory> 标签零吞字测试通过");
}

// 6.1.3 Responses 流式散文提到 <memory>
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { type: "response.output_text.delta", delta: "Responses: 该标签为 <memory> " };
  const ev2 = { type: "response.output_text.delta", delta: "用来标记重点事实。" };
  const finishEv = { type: "response.completed" };

  onEvent(ev1, ctx);
  onEvent(ev2, ctx);
  onEvent(finishEv, ctx);

  const full = (ev1.delta || "") + (ev2.delta || "") + (finishEv.delta || "");
  assert.strictEqual(full, "Responses: 该标签为 <memory> 用来标记重点事实。", "Responses 流式散文必须原样保留");
  pass("Responses 流式散文提及 <memory> 标签零吞字测试通过");
}

// 6.1.4 Gemini 流式散文提到 <memory>
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { candidates: [{ content: { parts: [{ text: "Gemini 阐述：这里的 <memory> 标签仅供展示。" }] } }] };
  const finishEv = { candidates: [{ finishReason: "STOP" }] };

  onEvent(ev1, ctx);
  onEvent(finishEv, ctx);

  const full = (ev1.candidates[0].content.parts[0].text || "") +
               ((finishEv.candidates && finishEv.candidates[0].content && finishEv.candidates[0].content.parts[0].text) || "");
  assert.strictEqual(full, "Gemini 阐述：这里的 <memory> 标签仅供展示。", "Gemini 流式散文必须原样保留");
  pass("Gemini 流式散文提及 <memory> 标签零吞字测试通过");
}

// 6.2 极端兜底：流在提到 <memory> 处突然中断/结束（无闭合、带/不带 finish）
// 6.2.1 尾部切在 <memory> 且随 finish 结束
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { choices: [{ delta: { content: "前文内容，结尾提到了 <memory" } }] };
  const ev2 = { choices: [{ delta: { content: ">" } }] };
  const finishEv = { choices: [{ delta: {}, finish_reason: "stop" }] };

  onEvent(ev1, ctx);
  onEvent(ev2, ctx);
  onEvent(finishEv, ctx);

  const full = (ev1.choices[0].delta.content || "") +
               (ev2.choices[0].delta.content || "") +
               (finishEv.choices[0].delta.content || "");
  assert.strictEqual(full, "前文内容，结尾提到了 <memory>", "末尾孤立 <memory> 在 finish 时必须完整释放，零丢失");
  pass("末尾孤立 <memory> 遇 finish 保命释放通过");
}

// 6.2.2 极端未闭合：看似真记忆开头但中途断流（加法式保命 fail-open）
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { choices: [{ delta: { content: "正文开始：<memory>[{\"title\":\"截断" } }] };
  // 模型异常断流，直接给出 finish，从未输出 </memory>
  const finishEv = { choices: [{ delta: {}, finish_reason: "length" }] };

  onEvent(ev1, ctx);
  onEvent(finishEv, ctx);

  const full = (ev1.choices[0].delta.content || "") + (finishEv.choices[0].delta.content || "");
  assert.strictEqual(full, "正文开始：<memory>[{\"title\":\"截断", "真记忆块未闭合时在 finish 必须全量吐出，绝不吞正文");
  pass("真记忆块未闭合遇异常截断加法式保命生效");
}

// 6.3 四协议非流式 onResponse：散文提到 <memory> 绝不被误删
{
  const testCases = [
    { name: "Chat", body: { choices: [{ message: { content: "Chat: 文档里提到了 <memory> 这个标签。" } }] }, get: b => b.choices[0].message.content },
    { name: "Anthropic", body: { content: [{ type: "text", text: "Anthropic: 文档里提到了 <memory> 这个标签。" }] }, get: b => b.content[0].text },
    { name: "Responses", body: { output: [{ content: [{ type: "output_text", text: "Responses: 文档里提到了 <memory> 这个标签。" }] }] }, get: b => b.output[0].content[0].text },
    { name: "Gemini", body: { candidates: [{ content: { parts: [{ text: "Gemini: 文档里提到了 <memory> 这个标签。" }] } }] }, get: b => b.candidates[0].content.parts[0].text }
  ];

  for (const tc of testCases) {
    const ctx = { options: { inline_extract: true }, state: {} };
    onResponse(tc.body, ctx);
    assert.strictEqual(tc.get(tc.body), `${tc.name}: 文档里提到了 <memory> 这个标签。`, `${tc.name} 非流式散文不得被误删`);
  }
  pass("四协议非流式散文提及 <memory> 标签零篡改通过");
}

// 6.4 反证：真记忆块（带空白 + [ 或 {）在流式与非流式中必须确实被剥离
// 6.4.1 流式反证：真记忆块带空白与换行
{
  const ctx = { opts: { inline_extract: true }, state: { inlineExtract: true } };
  const ev1 = { choices: [{ delta: { content: "正文开始。<memory> \n [ {\"category\":\"fact\"} ] \n </memory>正文结束。" } }] };
  onEvent(ev1, ctx);
  assert.strictEqual(ev1.choices[0].delta.content, "正文开始。正文结束。", "真记忆块必须确实被剥离，不可因修防吞而失效");
  pass("反证 3 通过：流式真记忆块带空白/换行时精准剥离");
}

// 6.4.2 非流式反证：单对象形式与数组形式真记忆块
{
  const ctx = { options: { inline_extract: true }, state: {} };
  const body = { choices: [{ message: { content: "回答前言。<memory> {\"category\":\"fact\"} </memory>回答后语。" } }] };
  onResponse(body, ctx);
  assert.strictEqual(body.choices[0].message.content, "回答前言。回答后语。", "非流式真记忆块必须精准剥离");
  pass("反证 4 通过：非流式真记忆块单对象格式精准剥离");
}

console.log("\n=================================================================");
console.log(`✅ 多协议验收测试全部通过！共完成 ${passed} 项深度断言校验。`);
console.log("=================================================================");
