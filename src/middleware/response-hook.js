/**
 * 模块职责：非流式响应钩子 (onResponseInner / onResponse)——<memory> 标签剥离 + 幻觉工具调用检测
 * 依赖：./stream-utils.js, ./capability.js
 * 被依赖：./memory.middleware.js, 根目录 memory.middleware.js
 *
 * v7.0.0 新增幻觉检测：为什么放在响应层而不是只看请求层——
 * 请求层只能知道「我们允许它调什么」，只有当模型真的发出一个**没被通告的工具名**时，
 * 才有确定性证据证明它在幻觉。这是比「率估算」强一个档位的信号：
 *   - unadvertised：通告了工具，但这个名字不在清单里
 *   - unavailable：本请求根本没通告任何工具，模型凭空造了一个工具
 * 统计写到 ctx.state.capsTelemetry，由宿主侧钩子落盘（中间件运行时无 fs）。
 */
import { pickText, stripMemoryBlock, _mwFailOpen } from "./stream-utils.js";
import { detectCapabilities, resolveToolCall } from "./capability.js";

/* 把四种协议里的 tool_call 名全部拉出来。取不到就返回空数组，绝不抛。 */
function collectToolCalls(body) {
  var out = [];
  if (!body || typeof body !== "object") return out;

  // OpenAI chat / 兼容形态
  var choices = body.choices;
  if (Array.isArray(choices)) {
    for (var i = 0; i < choices.length; i++) {
      var msg = choices[i] && choices[i].message;
      if (!msg) continue;
      var tcs = msg.tool_calls || msg.toolCalls;
      if (Array.isArray(tcs)) {
        for (var j = 0; j < tcs.length; j++) {
          var t = tcs[j];
          var n = (t && t.function && t.function.name) || (t && t.name) || "";
          if (typeof n === "string" && n) out.push(n);
        }
      }
      if (msg.function_call && typeof msg.function_call.name === "string") out.push(msg.function_call.name);
    }
  }

  // Anthropic / 通用 block 形态
  if (Array.isArray(body.content)) {
    for (var k = 0; k < body.content.length; k++) {
      var blk = body.content[k];
      if (blk && blk.type === "tool_use" && typeof blk.name === "string") out.push(blk.name);
    }
  }

  // OpenAI responses
  if (Array.isArray(body.output)) {
    for (var o = 0; o < body.output.length; o++) {
      var item = body.output[o];
      if (!item || typeof item !== "object") continue;
      if ((item.type === "function_call" || item.type === "tool_call") && typeof item.name === "string") out.push(item.name);
      if (Array.isArray(item.content)) {
        for (var c = 0; c < item.content.length; c++) {
          var cp = item.content[c];
          if (cp && cp.type === "tool_use" && typeof cp.name === "string") out.push(cp.name);
        }
      }
    }
  }

  // Gemini
  if (Array.isArray(body.candidates)) {
    for (var g = 0; g < body.candidates.length; g++) {
      var cand = body.candidates[g];
      var parts = cand && cand.content && cand.content.parts;
      if (!Array.isArray(parts)) continue;
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        if (part && part.functionCall && typeof part.functionCall.name === "string") out.push(part.functionCall.name);
      }
    }
  }

  return out;
}

/* 把检测结果写回 ctx.state，供宿主侧钩子落盘。
 * 只在「确实发生了幻觉」或「注入了引导」时记录，绝不给每条正常响应都加一个对象。 */
function recordTelemetry(body, ctx) {
  var st = (ctx && ctx.state) || {};
  var caps = st.caps || detectCapabilities((ctx && (ctx.request || st.requestBody)) || null);
  var names = collectToolCalls(body);

  var memCalls = 0;
  var halluc = [];
  for (var i = 0; i < names.length; i++) {
    var r = resolveToolCall(names[i], caps);
    if (r.logical) memCalls++;
    if (r.kind === "unadvertised" || r.kind === "unavailable") {
      halluc.push({ name: String(names[i]).slice(0, 120), kind: r.kind, logical: r.logical });
    }
  }

  var injected = st.guideInjected === true;
  if (!halluc.length && !injected && !names.length) return;

  st.capsTelemetry = {
    at: (typeof Date !== "undefined" && Date.now) ? Date.now() : 0,
    agent: String(st.envAgent || (ctx && ctx.agent) || "").slice(0, 64),
    tier: st.guideTier == null ? null : st.guideTier,
    injected: injected,
    hasTools: !!caps.hasTools,
    present: !!caps.present,
    toolCalls: names.length,
    memoryToolCalls: memCalls,
    hallucinated: halluc.slice(0, 5),
    hallucinatedCount: halluc.length
  };
}

/* ================= onResponse：非流式 ================= */
function onResponseInner(body, ctx) {
  if (!body) return body;
  ctx = ctx || {};
  ctx.state = ctx.state || {};
  var opts = ctx.options || {};

  var answer = pickText(body);

  if (opts.inline_extract && answer && answer.indexOf("<memory") !== -1) {
    var stripped = stripMemoryBlock(answer);
    if (body.choices && body.choices.length && body.choices[0].message) {
      body.choices[0].message.content = stripped;
    } else if (body.content && body.content.length) {
      for (var i = 0; i < body.content.length; i++) {
        if (body.content[i] && typeof body.content[i].text === "string") {
          body.content[i].text = stripMemoryBlock(body.content[i].text);
        }
      }
    } else if (Array.isArray(body.output)) {
      for (var oi = 0; oi < body.output.length; oi++) {
        var oit = body.output[oi];
        if (oit && Array.isArray(oit.content)) {
          for (var ci = 0; ci < oit.content.length; ci++) {
            var cp = oit.content[ci];
            if (cp && typeof cp.text === "string") cp.text = stripMemoryBlock(cp.text);
          }
        }
      }
    } else if (Array.isArray(body.candidates)) {
      for (var gi = 0; gi < body.candidates.length; gi++) {
        var gc = body.candidates[gi];
        if (gc && gc.content && Array.isArray(gc.content.parts)) {
          for (var gp = 0; gp < gc.content.parts.length; gp++) {
            var part = gc.content.parts[gp];
            if (part && typeof part.text === "string") part.text = stripMemoryBlock(part.text);
          }
        }
      }
    }
  }

  /* 幻觉检测：放在最后，不依赖上面任何分支是否命中 */
  try { recordTelemetry(body, ctx); } catch (_) { /* 观测代码自身绝不抛 */ }

  return body;
}

export function onResponse(body, ctx) {
  try { return onResponseInner(body, ctx); }
  catch (e) { return _mwFailOpen("onResponse", e, body, ctx); }
}

export { collectToolCalls, recordTelemetry };
