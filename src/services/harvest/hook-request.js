/**
 * 模块职责: 网关请求前置钩子 onRequest 主体（自激防护、auto_harvest 门禁、origin 隐私守卫、cwd/query 上下文注入、诊断上报）
 * 依赖: ./scaffolding.js (_diag), src/domain/token-budget.js (isInternalHarvestRequest)
 * 被依赖: src/services/harvest/index.js, src/services/harvest/hook-response.js, gateway_harvest.hooks.js
 */

import { isInternalHarvestRequest } from "../../domain/token-budget.js";

var _hookProbeLogged = 0;
export function _hookProbe(which, opts) {
  if (_hookProbeLogged) return;
  _hookProbeLogged = 1;
  try {
    var keys = (opts && typeof opts === "object") ? Object.keys(opts) : [];
    console.log("[memory-hub][hook] " + which + " 已被调用 | auto_harvest=" +
      String(opts && opts.auto_harvest) + " | options 键数=" + keys.length +
      " | gatewayTimeoutMs=" + String(opts && opts.gatewayTimeoutMs));
  } catch (_) { /* 连打印都不许抛 */ }
}

export async function onRequest(body, ctx) {
  try {
    const opts = (ctx && ctx.options) || {};
    _hookProbe("onRequest", opts);
    // 防线一（v6.20.0 自激放大事故修复）：内部模型调用豁免——必须放在
    // auto_harvest 判断【之前】，否则开关开启时豁免永远够不着。
    try {
      if (isInternalHarvestRequest(body, ctx)) {
        if (ctx && typeof ctx === "object") {
          if (!ctx.state || typeof ctx.state !== "object") ctx.state = {};
          ctx.state.memhubInternal = true;
        }
        if (ctx && typeof ctx.report === "function") {
          try { ctx.report("skipped", 0); } catch (_) {}
        }
        return undefined;
      }
    } catch (_) {}
    // 默认关闭：未显式开启时立即退出，0 额外开销
    if (opts.auto_harvest !== true) {
      if (ctx && typeof ctx.report === "function") {
        try { ctx.report("skipped", 0); } catch (_) {}
      }
      return undefined;
    }

    // ARCH-3 遵循 docs/subsystems/gateway-request-hooks.md:53 隐私边界：
    // remote 流量需显式开启 allow_remote_harvest，否则跳过
    const origin = (ctx && ctx.origin) || "";
    if (origin === "remote" && opts.allow_remote_harvest !== true) {
      if (ctx && typeof ctx.report === "function") {
        try { ctx.report("skipped", 0); } catch (_) {}
      }
      return undefined;
    }

    if (!ctx.state) ctx.state = {};
    ctx.state.harvestRequested = true;
    ctx.state.session = ctx.session || "";
    ctx.state.agent = ctx.agent || "";
    ctx.state.origin = origin;
    ctx.state.cwd = (ctx && ctx.cwd) || "";
    ctx.state.query = (ctx && ctx.query) || "";
    ctx.state.model = ctx.model || "";
    ctx.state.startTime = Date.now();
    ctx.state.requestBody = body;

    // ARCH-3 宿主状态诊断上报：网关提炼准备就绪
    if (ctx && typeof ctx.report === "function") {
      try { ctx.report("ready", 0); } catch (_) {}
    }

    // 绝不修改原始请求体
    return undefined;
  } catch (e) {
    // 极致 fail-open：捕获一切异常，返回 undefined 保留原样 body
    try {
      if (ctx && typeof ctx.report === "function") {
        ctx.report("invalid", 0);
      }
    } catch (_) {}
    return undefined;
  }
}
