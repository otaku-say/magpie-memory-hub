/**
 * 模块职责：流式事件钩子 (onEventInner / onEvent)，负责流式 <memory> 标签剥离与宿主零拷贝快路径
 * 依赖：./stream-utils.js
 * 被依赖：./memory.middleware.js, 根目录 memory.middleware.js
 * 快路径判定：typeof ctx.report === "function"
 */
import { pickText, isFinish, setEventText, stripStream, _mwFailOpen } from "./stream-utils.js";
import { accumulateToolCalls, flushToolCallPartials } from "../domain/tool-calls.js";
/* ================= onEvent：流式 ================= */
function onEventInner(event, ctx) {
  ctx = ctx || {};
  var isHostRuntime = Boolean(ctx && typeof ctx.report === "function");
  if (!ctx.state) return isHostRuntime ? undefined : event;
  var st = ctx.state;

  /* v7.1.0 流式幻觉遥测：必须在下面的快路径【之前】。
   * 之前遥测只挂在 onResponse，走 SSE 的客户端根本不触发，
   * 统计一直是空的——不是报错，是静默无数据。
   * 这里逐 chunk 累加工具名（碎片按 index 拼接），流结束时收口。
   * 未启用遥测或本请求没能力对象时立即跳过，保持零开销。 */
  if (st.caps && !(ctx.options && ctx.options.caps_telemetry === false)) {
    try {
      accumulateToolCalls(event, st);
      if (isFinish(event)) flushToolCallPartials(st);
    } catch (_) { /* 遥测绝不打断流 */ }
  }

  // 快路径：若未开启内联剥离，或流已进入直通态且无待释放缓冲，零开销直接返回
  if (!st.inlineExtract || ((st.memBypassed || st.memHold === -1) && !st.memPending && !st.memBuf)) {
    return isHostRuntime ? undefined : event;
  }

  var mutated = false;
  var piece = pickText(event);
  if (piece) {
    /* 用户可见的部分去掉 <memory> 块 */
    if (st.inlineExtract) {
      var visible = stripStream(piece, st);
      if (visible !== piece) {
        setEventText(event, visible);
        mutated = true;
      }
    }
  }
  if (isFinish(event)) {
    if (st.inlineExtract) {
      // 流结束保命：若有扣留未闭合的待定尾部或未闭合块，原样释放
      var toRelease = "";
      if (st.memPending) {
        toRelease += st.memPending;
        st.memPending = "";
      }
      if (st.memBuf) {
        toRelease += st.memBuf;
        st.memBuf = "";
        st.memHold = 0;
      }
      if (toRelease) {
        var curVis = pickText(event) || "";
        setEventText(event, curVis + toRelease);
        mutated = true;
      }
    }
  }
  if (!mutated && isHostRuntime) {
    return undefined; // 触发宿主零拷贝快路径
  }
  return event;
}


export function onEvent(event, ctx) {
  try { return onEventInner(event, ctx); }
  catch (e) {
    /* 顶层异常保命：若 ctx.state 里有扣留内容，必须释放到当前 event，绝不能丢用户内容 */
    var mutated = false;
    if (ctx && ctx.state) {
      try {
        var toRelease = (ctx.state.memPending || "") + (ctx.state.memBuf || "");
        ctx.state.memPending = "";
        ctx.state.memBuf = "";
        ctx.state.memHold = -1;
        ctx.state.memBypassed = true;
        if (toRelease) {
          var curVis = pickText(event) || "";
          setEventText(event, toRelease + curVis);
          mutated = true;
        }
      } catch (_) {}
    }
    var isHostRuntime = Boolean(ctx && typeof ctx.report === "function");
    var fallback = mutated ? event : (isHostRuntime ? undefined : event);
    return _mwFailOpen("onEvent", e, fallback, ctx);
  }
}

