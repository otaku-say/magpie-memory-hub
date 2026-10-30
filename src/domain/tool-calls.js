/**
 * 模块职责：从响应体 / SSE 事件里提取 tool_call 名（非流式与流式共用）
 * 依赖：无（纯函数）
 * 被依赖：src/middleware/response-hook.js, src/middleware/event-stream.js, src/services/harvest/hook-response.js
 *
 * 为什么要单独抽：非流式能一次拿到完整 `message.tool_calls`，流式只能拿到
 * `delta.tool_calls[].function.name` 的**碎片**。两套语法不一样，但“最后得到
 * 哪些工具被调了”这件事是同一个，所以归一到同一个提取器，避免两份规则逐渐跑偏。
 */

var MAX_NAMES = 32;

/* 从单个对象里拉出工具调用条目。
 * 返回 [{ name, index, complete }]：
 *   complete=true  名字已完整（Anthropic / responses / Gemini / 非流的 chat）
 *   complete=false 名字是碎片（OpenAI 流式 delta），需按 index 累加
 */
function extractToolCalls(evt) {
  var out = [];
  if (!evt || typeof evt !== "object") return out;

  function push(name, index, complete) {
    if (typeof name !== "string") return;
    out.push({ name: name, index: typeof index === "number" ? index : 0, complete: complete !== false });
  }

  // 1) OpenAI chat：非流式 message / 流式 delta
  if (Array.isArray(evt.choices)) {
    for (var i = 0; i < evt.choices.length; i++) {
      var ch = evt.choices[i];
      if (!ch || typeof ch !== "object") continue;
      var holder = ch.message || ch.delta;
      if (!holder || typeof holder !== "object") continue;
      var isDelta = !ch.message;
      var tcs = holder.tool_calls || holder.toolCalls;
      if (Array.isArray(tcs)) {
        for (var j = 0; j < tcs.length; j++) {
          var t = tcs[j];
          if (!t || typeof t !== "object") continue;
          var n = (t.function && t.function.name) || t.name || "";
          if (typeof n === "string" && n) push(n, t.index, !isDelta);
        }
      }
      if (holder.function_call && typeof holder.function_call.name === "string") {
        push(holder.function_call.name, 0, !isDelta);
      }
    }
  }

  // 2) Anthropic：完整块 / 流式 content_block_start
  if (Array.isArray(evt.content)) {
    for (var k = 0; k < evt.content.length; k++) {
      var blk = evt.content[k];
      if (blk && blk.type === "tool_use" && typeof blk.name === "string") push(blk.name, k, true);
    }
  }
  if (evt.type === "content_block_start" && evt.content_block && evt.content_block.type === "tool_use") {
    push(evt.content_block.name, evt.index, true);
  }

  // 3) OpenAI responses：完整 output / 流式 output_item.added
  function scanRespItem(item) {
    if (!item || typeof item !== "object") return;
    if ((item.type === "function_call" || item.type === "tool_call") && typeof item.name === "string") {
      push(item.name, 0, true);
    }
    if (Array.isArray(item.content)) {
      for (var c = 0; c < item.content.length; c++) {
        var cp = item.content[c];
        if (cp && cp.type === "tool_use" && typeof cp.name === "string") push(cp.name, c, true);
      }
    }
  }
  if (Array.isArray(evt.output)) {
    for (var o = 0; o < evt.output.length; o++) scanRespItem(evt.output[o]);
  }
  if (evt.type === "response.output_item.added") scanRespItem(evt.item);

  // 4) Gemini
  if (Array.isArray(evt.candidates)) {
    for (var g = 0; g < evt.candidates.length; g++) {
      var cand = evt.candidates[g];
      var parts = cand && cand.content && cand.content.parts;
      if (!Array.isArray(parts)) continue;
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        if (part && part.functionCall && typeof part.functionCall.name === "string") {
          push(part.functionCall.name, p, true);
        }
      }
    }
  }

  return out;
}

/* 把一个事件累加到 st 上的缓冲。中段绝不抛错，绝不改变事件本身。
 * 返回当前累计到的“完整名”列表（供调用方判断是否需要立即收口）。 */
function accumulateToolCalls(evt, st) {
  if (!st || typeof st !== "object") return [];
  if (!Array.isArray(st._toolCallNames)) st._toolCallNames = [];
  if (!st._tcPartials || typeof st._tcPartials !== "object") st._tcPartials = {};

  var items = extractToolCalls(evt);
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.complete) {
      if (st._toolCallNames.length < MAX_NAMES) st._toolCallNames.push(it.name);
      continue;
    }
    /* 流式碎片：同一个 index 跨事件拼接。
     * 不能每个碎片都 push，否则会把一个名字拆成多条记录。 */
    st._tcPartials[it.index] = (st._tcPartials[it.index] || "") + it.name;
  }
  return st._toolCallNames;
}

/* 流结束时把未收口的碎片一次性展开 */
function flushToolCallPartials(st) {
  if (!st || typeof st !== "object") return [];
  if (!Array.isArray(st._toolCallNames)) st._toolCallNames = [];
  var parts = st._tcPartials || {};
  var keys = Object.keys(parts);
  for (var i = 0; i < keys.length; i++) {
    var v = String(parts[keys[i]] || "").trim();
    if (v && st._toolCallNames.length < MAX_NAMES) st._toolCallNames.push(v);
  }
  st._tcPartials = {};
  return st._toolCallNames;
}

export { MAX_NAMES, extractToolCalls, accumulateToolCalls, flushToolCallPartials };
