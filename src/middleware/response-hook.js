/**
 * 模块职责：非流式响应钩子 (onResponseInner / onResponse)，负责响应正文中的 <memory> 标签剥离与清洗
 * 依赖：./stream-utils.js
 * 被依赖：./memory.middleware.js, 根目录 memory.middleware.js
 */
import { pickText, stripMemoryBlock, _mwFailOpen } from "./stream-utils.js";
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
      // Responses 协议输出
      for (var oi = 0; oi < body.output.length; oi++) {
        var oit = body.output[oi];
        if (oit && Array.isArray(oit.content)) {
          for (var ci = 0; ci < oit.content.length; ci++) {
            var cp = oit.content[ci];
            if (cp && typeof cp.text === "string") {
              cp.text = stripMemoryBlock(cp.text);
            }
          }
        }
      }
    } else if (Array.isArray(body.candidates)) {
      // Gemini 协议输出
      for (var gi = 0; gi < body.candidates.length; gi++) {
        var gc = body.candidates[gi];
        if (gc && gc.content && Array.isArray(gc.content.parts)) {
          for (var gp = 0; gp < gc.content.parts.length; gp++) {
            var part = gc.content.parts[gp];
            if (part && typeof part.text === "string") {
              part.text = stripMemoryBlock(part.text);
            }
          }
        }
      }
    }
  }

  return body;
}

export function onResponse(body, ctx) {
  try { return onResponseInner(body, ctx); }
  catch (e) { return _mwFailOpen("onResponse", e, body); }
}

