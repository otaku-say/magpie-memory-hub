/**
 * 模块职责：流式事件正文提取、写回、完成状态判断、<memory> 标签状态机剥离与 fail-open 保护
 * 依赖：无外部依赖（纯内存同步代码，无任何 I/O）
 * 被依赖：./event-stream.js, ./response-hook.js, ./request-inject.js
 */
/* ================= 从事件或响应里取正文（多协议支持） ================= */
function pickText(obj) {
  if (!obj || typeof obj !== "object") return "";

  // 1. OpenAI Chat: choices[0].delta or choices[0].message
  if (obj.choices && obj.choices.length) {
    var c = obj.choices[0];
    if (c.delta && typeof c.delta.content === "string") return c.delta.content;
    if (c.delta && c.delta.content && c.delta.content.length) {
      var acc = "";
      for (var i = 0; i < c.delta.content.length; i++) {
        if (c.delta.content[i] && c.delta.content[i].text) acc += c.delta.content[i].text;
      }
      return acc;
    }
    if (c.message && typeof c.message.content === "string") return c.message.content;
  }

  // 2. Anthropic: content_block_delta
  if (obj.type === "content_block_delta" && obj.delta && typeof obj.delta.text === "string") {
    return obj.delta.text;
  }

  // 3. OpenAI Responses 流式事件: response.output_text.delta
  if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
    return obj.delta;
  }
  if (obj.type === "response.output_text.done" && typeof obj.text === "string") {
    return obj.text;
  }

  // 4. Gemini 流式事件与响应: candidates[].content.parts[].text
  if (Array.isArray(obj.candidates) && obj.candidates.length) {
    var gOut = "";
    for (var gi = 0; gi < obj.candidates.length; gi++) {
      var cand = obj.candidates[gi];
      if (cand && cand.content && Array.isArray(cand.content.parts)) {
        for (var pi = 0; pi < cand.content.parts.length; pi++) {
          var gPart = cand.content.parts[pi];
          if (gPart && typeof gPart.text === "string" && !gPart.thought) {
            gOut += gPart.text;
          }
        }
      }
    }
    if (gOut) return gOut;
  }

  // 5. OpenAI Responses 非流式完整响应: body.output[].content[].text
  if (Array.isArray(obj.output) && obj.output.length) {
    var rOut = "";
    for (var oi = 0; oi < obj.output.length; oi++) {
      var oItem = obj.output[oi];
      if (oItem && Array.isArray(oItem.content)) {
        for (var ci = 0; ci < oItem.content.length; ci++) {
          var oPart = oItem.content[ci];
          if (oPart && typeof oPart.text === "string") {
            rOut += oPart.text;
          }
        }
      }
    }
    if (rOut) return rOut;
  }

  // 6. Anthropic 非流式响应: body.content[].text
  if (obj.content && obj.content.length) {
    var out = "";
    for (var k = 0; k < obj.content.length; k++) {
      var blk = obj.content[k];
      if (blk && typeof blk.text === "string") out += blk.text;
      if (blk && blk.delta && typeof blk.delta.text === "string") out += blk.delta.text;
    }
    return out;
  }

  if (typeof obj.output_text === "string") return obj.output_text;
  return "";
}

function isFinish(obj) {
  if (!obj || typeof obj !== "object") return false;
  // 1. Chat
  if (obj.choices && obj.choices.length && obj.choices[0].finish_reason) return true;
  // 2. Anthropic
  if (obj.type === "message_stop") return true;
  if (obj.type === "message_delta" && obj.delta && obj.delta.stop_reason) return true;
  // 3. Responses
  if (obj.type === "response.completed" || obj.type === "response.done") return true;
  // 4. Gemini
  if (Array.isArray(obj.candidates) && obj.candidates.length && obj.candidates[0].finishReason) return true;
  return false;
}

/* ================= 写回事件正文（四种协议） ================= */
function setEventText(obj, text) {
  if (!obj || typeof obj !== "object") return;
  // 1. Chat
  if (obj.choices && obj.choices.length) {
    var c0 = obj.choices[0];
    if (!c0.delta) c0.delta = {};
    c0.delta.content = text;
    return;
  }
  // 2. Anthropic
  if (obj.type === "content_block_delta") {
    if (!obj.delta) obj.delta = {};
    obj.delta.text = text;
    return;
  }
  if (obj.type === "message_delta" || obj.type === "message_stop") {
    if (!obj.delta) obj.delta = {};
    obj.delta.text = text;
    return;
  }
  // 3. Responses
  if (obj.type === "response.output_text.delta" || (obj.type && obj.type.indexOf("response.") === 0)) {
    obj.delta = text;
    return;
  }
  // 4. Gemini: candidates[0].content.parts[0].text
  if (Array.isArray(obj.candidates) && obj.candidates.length) {
    var gc = obj.candidates[0];
    if (!gc.content) gc.content = {};
    if (!Array.isArray(gc.content.parts)) gc.content.parts = [];
    if (gc.content.parts.length === 0) {
      gc.content.parts.push({ text: text });
      return;
    }
    for (var j = 0; j < gc.content.parts.length; j++) {
      var p = gc.content.parts[j];
      if (p && !p.thought) {
        p.text = text;
        return;
      }
    }
    gc.content.parts.push({ text: text });
    return;
  }
}

/* ================= 流式剥离 <memory> 块 =================
 * 为什么必须在流的每一块上做：流式回复走 onEvent，onResponse 根本拿不到内容。
 * 而 agent 场景几乎全是流式——不解决这个，内联提炼就会把 <memory> 块喷给用户。
 *
 * 状态机（存在 ctx.state 里，随请求共享）：
 *   hold=0 透传；见到 "<memory" 前缀即进入 hold=1 并开始吞
 *   hold=1 吞掉直到 "</memory>"；若超过 HOLD_MAX 仍未闭合则【原样吐出】(fail-open)
 *   hold=-1 / memBypassed=true: 彻底禁用剥离，所有内容原样透传，绝不再扣留
 */
var HOLD_MAX = 20000;
var OPEN_TAG = "<memory";
var CLOSE_TAG = "</memory>";

function _stripStreamInner(piece, st) {
  /* 若该流已因超限熔断或标记跳过，绝不再做任何扣留，所有内容逐字节直通 */
  if (st.memBypassed || st.memHold === -1) {
    var prefix = (st.memPending || "") + (st.memBuf || "");
    st.memPending = "";
    st.memBuf = "";
    return prefix + (piece || "");
  }

  /* 上一块扣住的半个标记必须先拼回来再判断，否则被切开的 "<mem"+"ory>"
   * 永远拼不完整，剥离直接失效（实测踩过）。 */
  if (st.memPending) {
    piece = st.memPending + (piece || "");
    st.memPending = "";
  }
  if (!piece) return piece;
  var hold = st.memHold || 0;

  var holdLimit = (st && typeof st.holdMax === "number" && st.holdMax > 0) ? st.holdMax : HOLD_MAX;

  if (hold === 0) {
    /* 大小写不敏感匹配：<MEMORY>/<Memory> 与 <memory> 在流式与非流式下必须一致。
     * 曾经这里用区分大小写的 indexOf，导致同一段回复「流式泄漏、非流式被剥离」——
     * 用户看到的文本取决于是否开流，属于不可接受的行为漂移。 */
    var lowerPiece = piece.toLowerCase();
    var i = lowerPiece.indexOf(OPEN_TAG);
    if (i === -1) {
      /* 还可能是 "<mem" 这种被切开的半个标记：先扣住尾部待定部分 */
      for (var L = Math.min(piece.length, OPEN_TAG.length - 1); L > 0; L--) {
        if (lowerPiece.slice(piece.length - L) === OPEN_TAG.slice(0, L)) {
          st.memPending = piece.slice(piece.length - L);
          return piece.slice(0, piece.length - L);
        }
      }
      return piece;
    }
    /* 【必须判定「是否真的像记忆块」再扣留】
     * 早先这里无条件进入扣留，于是模型只要在散文里【提到】这个标签
     * （例如「这个 <memory> 标签的作用是…」），后面的正文就全部被吞 ——
     * 用户界面上表现为回复在中途莫名其妙断掉（真实踩过两次）。
     * 判据：标签之后跳过空白，必须紧跟 "["（数组）或 "{"（单个对象），
     * 这才是本插件约定的记忆块格式；否则按普通正文原样输出。 */
    var head = piece.slice(0, i);
    var rem = piece.slice(i);
    var closeAngle = rem.indexOf(">");
    if (closeAngle === -1) {
      // "<memory" 尚未闭合 ">"，先扣留在 pending
      if (rem.length > 50) return piece;
      st.memPending = rem;
      return head;
    }

    var tagStr = rem.slice(0, closeAngle + 1);
    // 严格保证只认 <memory> / <memory >（大小写不敏感），防止 <memoryManagement> 被误判
    if (!/^<memory\s*>$/i.test(tagStr)) {
      return head + tagStr + stripStream(rem.slice(closeAngle + 1), st);
    }

    var afterTag = rem.slice(closeAngle + 1);
    if (/^\s*$/.test(afterTag)) {
      // 标签后在本 chunk 全是空白，等待下一个 chunk 确认首个非空白字符
      if (rem.length > 100) return piece;
      st.memPending = rem;
      return head;
    }

    /* 必须判定「是否真的像记忆块」再扣留：
     * 跳过空白必须紧跟 "[" 或 "{"；若紧跟散文汉字/英文等，绝不扣留！原样吐出。 */
    if (!/^\s*[\[{]/.test(afterTag)) {
      return head + tagStr + stripStream(afterTag, st);
    }

    st.memHold = 1;
    st.memBuf = rem;
    st.memHead = head;
    var m0 = st.memBuf.match(/<\/memory\s*>/i);
    var end0 = m0 ? m0.index : -1;
    if (end0 !== -1) {
      st.memHold = 0;   // 同一块内就闭合了，重置状态并支持后续连续块
      var tail0 = st.memBuf.slice(end0 + m0[0].length);
      st.memBuf = "";
      return st.memHead + (tail0 ? stripStream(tail0, st) : "");
    }
    // 未闭合：检查单 chunk 扣留量是否就已超限
    if (st.memBuf.length > holdLimit) {
      /* 单 chunk 即超限：立即把扣留内容原样吐出，且本流彻底禁用扣留 (fail-open) */
      var flush0 = st.memHead + st.memBuf;
      st.memHold = -1;
      st.memBypassed = true;
      st.memBuf = "";
      st.memPending = "";
      return flush0;
    }
    return st.memHead;
  }

  if (hold === 1) {
    st.memBuf += piece;
    var mEnd = st.memBuf.match(/<\/memory\s*>/i);
    var end = mEnd ? mEnd.index : -1;
    if (end !== -1) {
      st.memHold = 0;   // 块闭合了，恢复正常透传
      var tail = st.memBuf.slice(end + mEnd[0].length);
      st.memBuf = "";
      return tail ? stripStream(tail, st) : "";
    }
    if (st.memBuf.length > holdLimit) {
      /* 迟迟不闭合且扣留超限：判定为模型没按格式闭合，立即把扣留内容原样吐出，且不再继续扣 (fail-open) */
      var flush = st.memBuf;
      st.memHold = -1;
      st.memBypassed = true;
      st.memBuf = "";
      st.memPending = "";
      return flush;
    }
    return "";
  }

  /* 兜底状态：重置后重走 */
  st.memHold = 0;
  return stripStream(piece, st);
}

function stripStream(piece, st) {
  try {
    return _stripStreamInner(piece, st);
  } catch (err) {
    /* 任何异常保命：释放全部已有扣留，原样拼接 piece，彻底禁用后续剥离 */
    var toRelease = (st.memPending || "") + (st.memBuf || "");
    st.memPending = "";
    st.memBuf = "";
    st.memHold = -1;
    st.memBypassed = true;
    return toRelease + (piece || "");
  }
}

function stripMemoryBlock(text) {
  if (!text || typeof text !== "string") return text;
  if (text.toLowerCase().indexOf("<memory") === -1) return text;
  var matched = false;
  var out = text.replace(/<memory\s*>\s*(?:\[|\{)[\s\S]*?<\/memory\s*>/gi, function () {
    matched = true;
    return "";
  });
  /* 只有确实剥掉过记忆块，才做空行收敛：
   * 否则「正文里提到 <memory> 一词」的回复会被顺手改写排版（连续空行被压缩），
   * 与流式路径（逐块透传、从不重排）行为不一致。 */
  return matched ? out.replace(/\n{3,}/g, "\n\n") : text;
}

/* ---------------- fail-open 外壳（最后一道防线） ----------------
 * 背景：插件的中间件跑在【用户的模型请求链路上】。一旦我们抛异常，
 * 轻则本次注入/剥离失效，重则整个请求失败 —— 后者绝不可接受。
 * 实测线上出现过 322 次失败（约 2.1%），而平均耗时仅 87µs，
 * 说明不是超时，而是某些输入形状不符预期时直接抛异常。
 *
 * 三道防线：
 *   ① 各函数内对所有外部数据做防御性取值
 *   ② 每个钩子用 try/catch 包住，异常一律降级为「不做任何改动」
 *   ③ 降级时只打印一行简短原因（不打印内容，避免泄露用户对话）
 */
var _mwErrLogged = 0;
function _mwFailOpen(name, e, fallback) {
  if (_mwErrLogged < 3) {           // 高频出错时别刷屏
    _mwErrLogged++;
    try {
      console.log("[memory-hub] " + name + " 已降级(fail-open): " +
        ((e && e.name) || "Error") + ": " + String((e && e.message) || e).slice(0, 160));
    } catch (_) { /* 连打印都不能抛 */ }
  }
  return fallback;
}
export {
  pickText,
  isFinish,
  setEventText,
  HOLD_MAX,
  OPEN_TAG,
  CLOSE_TAG,
  stripStream,
  stripMemoryBlock,
  _mwFailOpen
};
