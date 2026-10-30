/**
 * 模块职责: 网关响应后置钩子 onResponse 主体（Bounded Await 受限等待、生命周期防护、超时脱钩与任务调度）
 * 依赖: ./scaffolding.js (_diag), ./dialog-extract.js (buildDialogueText, countTurnsFromMessages), ./project-resolve.js (deriveProjectFromCwd), ./harvest-pipeline.js (processDialogueAndHarvest), ./offline-scan.js (isTestMode), ./hook-request.js (_hookProbe), src/domain/token-budget.js (isInternalHarvestRequest), tools.js (makeClient)
 * 被依赖: src/services/harvest/index.js, gateway_harvest.hooks.js
 */

import { _diag } from "./scaffolding.js";
import { buildDialogueText, countTurnsFromMessages } from "./dialog-extract.js";
import { deriveProjectFromCwd } from "./project-resolve.js";
import { processDialogueAndHarvest } from "./harvest-pipeline.js";
import { isTestMode } from "./offline-scan.js";
import { _hookProbe } from "./hook-request.js";
import { isInternalHarvestRequest } from "../../domain/token-budget.js";
import { makeClient } from "../../integration/ncb.js";
import { recordCapsTelemetry } from "../caps-stats.js";

export function computeHookBudgetMs(opts = {}) {
  if (opts.bounded_await_timeout_ms != null && !isNaN(Number(opts.bounded_await_timeout_ms)) && Number(opts.bounded_await_timeout_ms) > 0) {
    return Number(opts.bounded_await_timeout_ms);
  }
  if (opts.bounded_await_ms != null && !isNaN(Number(opts.bounded_await_ms)) && Number(opts.bounded_await_ms) > 0) {
    return Number(opts.bounded_await_ms);
  }
  const rawTimeout = Number(opts.gatewayTimeoutMs) || 8000;
  const margin = rawTimeout > 1000 ? 800 : Math.min(200, Math.floor(rawTimeout * 0.2));
  return Math.max(100, Math.min(rawTimeout, 10000) - margin);
}

export async function onResponse(reply, ctx) {
  try {
    const opts = (ctx && ctx.options) || {};
    _hookProbe("onResponse", opts);

    /* v7.0.0 能力幻觉遥测：中间件在受限运行时里只能检测，不能落盘；
     * 这里（宿主运行时，有 fs）把它固化下来。
     * 必须放在 auto_harvest 开关判断【之前】——遥测与是否提炼无关。
     * 任何异常一律吞掉，绝不影响主链路。 */
    try { recordCapsTelemetry(ctx); } catch (_) {}
    // 防线一（v6.20.0 自激放大事故修复）：内部模型调用豁免——必须放在
    // auto_harvest 判断【之前】。钩子自己经 loopback 发出的判定/提炼请求
    // 会再次走 serveAgent 触发 onResponse；此处按请求体指纹识别后立即
    // return，切断 2^n 指数自激环（零模型调用、零入库）。
    try {
      const _reqForExempt = ctx && (ctx.request || (ctx.state && ctx.state.requestBody));
      if ((ctx && ctx.state && ctx.state.memhubInternal === true) ||
          isInternalHarvestRequest(_reqForExempt, ctx)) {
        return;
      }
    } catch (_) {}
    // 默认关闭校验
    if (opts.auto_harvest !== true) {
      return;
    }

    // ARCH-3 隐私边界守卫：remote 来源流量必须显式开启 allow_remote_harvest
    const origin = (ctx && ctx.origin) || (ctx && ctx.state && ctx.state.origin) || "";
    if (origin === "remote" && opts.allow_remote_harvest !== true) {
      return;
    }

    // 严禁在测试环境意外触发真实数据库写入（除非显式传入 mock/隔离 client 或 _force_test 标记）
    if (isTestMode() && !opts._force_test && !opts._client && !opts.client) {
      return;
    }

    // 只有请求成功完成才进行记忆提炼
    if (ctx && ctx.success === false) {
      return;
    }

    const requestBody = ctx && (ctx.request || (ctx.state && ctx.state.requestBody));
    const queryFallback = (ctx && ctx.query) || (ctx && ctx.state && ctx.state.query) || "";
    const dialogueText = buildDialogueText(requestBody, reply, queryFallback);
    if (!dialogueText || dialogueText.length < 20) {
      return;
    }

    // ARCH-3 项目推导契约守卫：
    // 严格遵循规范：project 自动推导仅在显式 project==="auto" 时启用，默认 global 保持原行为，绝不自动按 cwd 分项目。
    const cwd = (ctx && ctx.cwd) || (ctx && ctx.state && ctx.state.cwd) || "";
    const configuredProject = opts.project != null ? opts.project : (opts._project != null ? opts._project : "");
    const effectiveProject = deriveProjectFromCwd(cwd, configuredProject);

    const meta = {
      project: effectiveProject,
      agent: (ctx && ctx.agent) || (ctx && ctx.state && ctx.state.agent) || "gateway",
      session: (ctx && ctx.session) || (ctx && ctx.state && ctx.state.session) || "",
      turn: countTurnsFromMessages(requestBody),
    };

    // 构造 NCB client（支持 mcp_key 与 ncb_secret 回退）
    let client = (opts && (opts._client || opts.client)) || null;
    if (!client) {
      try {
        // makeClient 已在顶部静态 import
        client = makeClient(opts);
      } catch (_) {
        client = null;
      }
    }

    // ARCH-1 架构演进：
    // 网关钩子采用受限等待（Bounded Await，Promise.race + 超时保护）。
    // 对齐 magpie-main/internal/plugin/host.js:1366 与 gateway.go:213 的生命周期：
    // onResponse 本身已在 Go 后台 goroutine 中执行（完全不阻塞客户端响应交付），
    // 通过在 gatewayTimeoutMs 安全余量内受限等待 taskPromise，保持宿主 pending > 0，
    // 防止宿主在 Restart() 时因 pending===0 提前 process.exit(0) 腰斩正在进行的提炼与入库任务。
    // 同时支持可配置关闭（opts.bounded_await === false 等），超时/中止平滑脱钩，且任何失败绝不影响网关主流程。
    const taskPromise = processDialogueAndHarvest(dialogueText, meta, client, opts);

    if (opts.wait_for_flush === true) {
      try {
        await taskPromise;
        if (ctx && ctx.state && typeof ctx.state === "object") {
          ctx.state._bounded_await_outcome = "flushed";
        }
      } catch (err) {
        _diag("onResponse taskPromise flush 异常 (非致命，已隔离)", (err && err.message) || err);
        if (ctx && ctx.state && typeof ctx.state === "object") {
          ctx.state._bounded_await_outcome = "flush_error";
        }
      }
    } else if (
      opts.bounded_await === false ||
      opts.wait_bounded === false ||
      opts.bounded_await_enabled === false ||
      opts.bounded_await === "off" ||
      opts.bounded_await === "disabled"
    ) {
      // 可配置关闭受限等待：回退到纯脱钩异步模式
      taskPromise.catch((err) => {
        _diag("onResponse taskPromise 后台异常 (非致命，已隔离)", (err && err.message) || err);
      });
      if (ctx && ctx.state && typeof ctx.state === "object") {
        ctx.state._bounded_await_outcome = "disabled";
      }
    } else {
      // 默认开启 Bounded Await：Promise.race + 超时 / abort 保护
      const hookBudgetMs = computeHookBudgetMs(opts);
      let timer = null;
      let abortHandler = null;

      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ outcome: "timeout" }), hookBudgetMs);
        if (timer && typeof timer.unref === "function") timer.unref();

        if (ctx && ctx.signal) {
          if (ctx.signal.aborted) {
            resolve({ outcome: "aborted" });
          } else if (typeof ctx.signal.addEventListener === "function") {
            abortHandler = () => resolve({ outcome: "aborted" });
            try {
              ctx.signal.addEventListener("abort", abortHandler, { once: true });
            } catch (_) {}
          }
        }
      });

      const safeTaskPromise = Promise.resolve(taskPromise)
        .then((res) => ({ outcome: "completed", result: res }))
        .catch((err) => {
          // 失败不影响主流程 (fail-open)
          _diag("onResponse taskPromise 异常 (非致命，已隔离)", (err && err.message) || err);
          return { outcome: "error", error: err };
        });

      try {
        const raceResult = await Promise.race([safeTaskPromise, timeoutPromise]);
        if (ctx && ctx.state && typeof ctx.state === "object") {
          ctx.state._bounded_await_outcome = raceResult && raceResult.outcome;
        }
      } catch (raceErr) {
        // 双重兜底：Promise.race 自身若发生意外异常，绝不外抛，隔离保护网关主流程
        _diag("onResponse bounded await race 异常 (非致命)", (raceErr && raceErr.message) || raceErr);
      } finally {
        if (timer) clearTimeout(timer);
        if (abortHandler && ctx && ctx.signal && typeof ctx.signal.removeEventListener === "function") {
          try {
            ctx.signal.removeEventListener("abort", abortHandler);
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    // fail-open 仍是原则：绝不向上抛。但**不再静默** —— 打一行诊断，否则永远查不到
    _diag("onResponse 异常", (e && e.stack) || (e && e.message) || e);
  }
}
