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
import { detectCapabilities, buildCapsTelemetry } from "./capability.js";
import { extractToolCalls } from "../domain/tool-calls.js";

/* 四协议 tool_call 提取已下沉到 src/domain/tool-calls.js（流式与非流式共用）。
 * 这里保留同名薄包装，因为已有测试与调用方按这个名字断言。 */
function collectToolCalls(body) {
  var items = extractToolCalls(body);
  var out = [];
  for (var i = 0; i < items.length; i++) out.push(items[i].name);
  return out;
}
/* 把检测结果写回 ctx.state，供宿主侧钩子落盘。
 * 流式请求的工具名由 onEvent 累加在 st._toolCallNames 上，优先级高于本次响应体
 * （流式时 onResponse 可能拿到的是拼装体，也可能根本不被调用）。 */
function recordTelemetry(body, ctx) {
  var st = (ctx && ctx.state) || {};
  var caps = st.caps || detectCapabilities((ctx && (ctx.request || st.requestBody)) || null);
  var streamed = Array.isArray(st._toolCallNames) ? st._toolCallNames : [];
  var names = streamed.length ? streamed : collectToolCalls(body);
  var t = buildCapsTelemetry(caps, names, st);
  if (t) st.capsTelemetry = t;
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
