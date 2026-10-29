/**
 * 模块职责：流式事件钩子 (onEventInner / onEvent)，负责流式 <memory> 标签剥离与宿主零拷贝快路径
 * 依赖：./stream-utils.js
 * 被依赖：./memory.middleware.js, 根目录 memory.middleware.js
 * 快路径判定：typeof ctx.report === "function"
 */
import { pickText, isFinish, setEventText, stripStream, _mwFailOpen } from "./stream-utils.js";
/* ================= onEvent：流式 ================= */
function onEventInner(event, ctx) {
  ctx = ctx || {};
  var isHostRuntime = Boolean(ctx && typeof ctx.report === "function");
  if (!ctx.state) return isHostRuntime ? undefined : event;
  var st = ctx.state;

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

