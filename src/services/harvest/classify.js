
function safeTimeoutMs(directMs, secValue, fallbackMs) {
  const direct = Number(directMs);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.max(500, Math.min(120000, direct));
  }
  const sec = Number(secValue);
  if (Number.isFinite(sec) && sec > 0) {
    return Math.max(500, Math.min(120000, sec * 1000));
  }
  return fallbackMs;
}

/**
 * 模块职责: 在线分类模型意图判定 (classify_model / classify_endpoint)，自适应 systemone / chat 端点
 * 依赖: ./scaffolding.js (_diag), src/domain/token-budget.js (modelBudgetCheck, modelBudgetRecord, getInternalModelHeaders)
 * 被依赖: src/services/harvest/harvest-pipeline.js, src/services/harvest/offline-scan.js, gateway_harvest.hooks.js, gateway_harvest.js
 */

import { _diag } from "./scaffolding.js";
import {
  modelBudgetCheck,
  modelBudgetRecord,
  getInternalModelHeaders,
} from "../../domain/token-budget.js";

/** 判定模型端点自适应缓存：model -> "systemone" | "chat" */
export const classifyEndpointCache = new Map();

/**
 * 使用网关配置的在线分类模型判定对话是否包含值得长期记忆的内容。
 * 支持 classify_endpoint: "auto" | "systemone" | "chat"。
 * 未配置判定模型时明确跳过判定过滤并留诊断日志，绝不调用任何写死模型。
 */
export async function classifyDialogueWithOnlineModel(dialogueText, options = {}) {
  const model = String(options.classify_model || options.classifier_model || "").trim();
  if (model === "off" || model === "none") {
    return { shouldHarvest: true, score: 1.0, reason: "disabled" };
  }
  if (!model) {
    _diag("classify_skipped", "未配置判定模型 (classify_model 为空)，跳过前置判定过滤");
    return { shouldHarvest: true, score: null, reason: "unconfigured_classify_model" };
  }

  const endpointSetting = String(options.classify_endpoint || "auto").trim().toLowerCase();
  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  const timeoutMs = safeTimeoutMs(options.classify_timeout_ms, options.model_timeout_sec, 15000);
  const threshold = typeof options.classify_threshold === "number" ? options.classify_threshold : 0.5;
  const doFetch = options._fetch || globalThis.fetch;

  // 调用预算熔断（v6.20.0 自激放大事故修复）：超限则跳过判定、默认放行提炼链路，
  // 绝不因限流改变采集语义（fail-open），只打一行诊断。
  const _budget = modelBudgetCheck(options);
  if (!_budget.allowed) {
    _diag("budget_skip_classify", `模型调用预算超限(${_budget.reason}, 60s=${_budget.perMinute}, 累计=${_budget.total})，跳过判定过滤`);
    return { shouldHarvest: true, score: null, reason: _budget.reason, budgetSkipped: true };
  }

  const headers = getInternalModelHeaders(apiKey);

  // 内部辅助：请求 /v1/systemone 决策端点
  async function callSystemOne() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${baseUrl}/v1/systemone`;
      const payload = {
        model,
        state: dialogueText.slice(0, 4000),
        questions: {
          worth_remembering: {
            type: "noul",
            instructions: "Does this text contain user preferences, technical decisions, environment facts, or bug fixes worth remembering?",
          },
        },
      };

      let res;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        try { modelBudgetRecord(); } catch (_) {}
      } catch (netErr) {
        return { ok: false, status: 0, errText: String(netErr?.message || netErr), reason: "systemone_network_exception" }; // db-col-ok: HTTP 状态码，非数据库列
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return { ok: false, status: res.status, errText, reason: `systemone_http_${res.status}` }; // db-col-ok: HTTP 状态码，非数据库列
      }

      const json = await res.json().catch(() => null);
      const noul = json?.answers?.worth_remembering?.noul;
      if (typeof noul === "number") {
        return { ok: true, score: noul, reason: "systemone" };
      }
      return { ok: false, status: 200, errText: "返回缺少有效 noul 打分", reason: "systemone_missing_noul" }; // db-col-ok: HTTP 状态码，非数据库列
    } finally {
      clearTimeout(timer);
    }
  }

  // 内部辅助：请求 /v1/chat/completions 对话分类端点
  async function callChat() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${baseUrl}/v1/chat/completions`;
      const payload = {
        model,
        messages: [
          {
            role: "system",
            content: "你是一个会话价值判定器。判断用户对话是否包含值得长期记忆的持久事实、配置、偏好、架构决策或报错踩坑解法。若包含返回 YES，若仅为闲聊/临时提问/代码探讨返回 NO。只输出 YES 或 NO。",
          },
          {
            role: "user",
            content: dialogueText.slice(0, 3000),
          },
        ],
        stream: false,
        temperature: 0.1,
        max_tokens: 10,
      };

      let res;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        try { modelBudgetRecord(); } catch (_) {}
      } catch (netErr) {
        return { ok: false, status: 0, errText: String(netErr?.message || netErr), reason: "chat_network_exception" }; // db-col-ok: HTTP 状态码，非数据库列
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return { ok: false, status: res.status, errText, reason: `chat_http_${res.status}` }; // db-col-ok: HTTP 状态码，非数据库列
      }

      const json = await res.json().catch(() => null);
      const content = String(json?.choices?.[0]?.message?.content || "").trim();
      const hasYes = /\bYES\b/i.test(content);
      const hasNo = /\bNO\b/i.test(content);
      if (hasYes && !hasNo) {
        return { ok: true, score: 1.0, reason: "chat_classifier" };
      }
      if (hasNo && !hasYes) {
        return { ok: true, score: 0.0, reason: "chat_classifier" };
      }
      return { ok: false, status: 200, errText: "非预期判定输出: " + content.slice(0, 40), reason: "chat_invalid_output" }; // db-col-ok: HTTP 状态码，非数据库列
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    if (endpointSetting === "systemone") {
      const sRes = await callSystemOne();
      if (sRes.ok) {
        return { shouldHarvest: sRes.score >= threshold, score: sRes.score, reason: "systemone", endpoint: "systemone" };
      }
      _diag("systemone_error", `HTTP ${sRes.status}: ${sRes.errText.slice(0, 100)}`);
      return { shouldHarvest: true, score: 0.5, reason: `systemone_http_${sRes.status}`, endpoint: "systemone" };
    }

    if (endpointSetting === "chat") {
      const cRes = await callChat();
      if (cRes.ok) {
        return { shouldHarvest: cRes.score >= threshold, score: cRes.score, reason: "chat_classifier", endpoint: "chat" };
      }
      _diag("chat_classify_error", `HTTP ${cRes.status}: ${cRes.errText.slice(0, 100)}`);
      return { shouldHarvest: true, score: 0.5, reason: `chat_http_${cRes.status}`, endpoint: "chat" };
    }

    // auto 自适应模式：进程级缓存优先
    const cached = classifyEndpointCache.get(model);
    if (cached === "systemone") {
      const sRes = await callSystemOne();
      if (sRes.ok) {
        return { shouldHarvest: sRes.score >= threshold, score: sRes.score, reason: "systemone", endpoint: "systemone" };
      }
      // 降级尝试 chat
      const cRes = await callChat();
      if (cRes.ok) {
        classifyEndpointCache.set(model, "chat");
        return { shouldHarvest: cRes.score >= threshold, score: cRes.score, reason: "chat_classifier", endpoint: "chat" };
      }
      if (sRes.reason === "systemone_network_exception" || cRes.reason === "chat_network_exception") {
        return { shouldHarvest: true, score: 0.5, reason: "classifier_exception", endpoint: "systemone" };
      }
      return { shouldHarvest: true, score: 0.5, reason: "systemone_cached_fail", endpoint: "systemone" };
    } else if (cached === "chat") {
      const cRes = await callChat();
      if (cRes.ok) {
        return { shouldHarvest: cRes.score >= threshold, score: cRes.score, reason: "chat_classifier", endpoint: "chat" };
      }
      return { shouldHarvest: true, score: 0.5, reason: `chat_http_${cRes.status}`, endpoint: "chat" };
    }

    // 未缓存：优先探测 systemone
    const sRes = await callSystemOne();
    if (sRes.ok) {
      classifyEndpointCache.set(model, "systemone");
      return { shouldHarvest: sRes.score >= threshold, score: sRes.score, reason: "systemone", endpoint: "systemone" };
    }

    // systemone 不可用（如 400/404/405/422/501 或非决策模型），自动切换至 chat
    _diag("classify_auto_fallback", `判定模型 ${model} 在 /v1/systemone 返回 HTTP ${sRes.status}，自动切换至 /v1/chat/completions`);
    const cRes = await callChat();
    if (cRes.ok) {
      classifyEndpointCache.set(model, "chat");
      return { shouldHarvest: cRes.score >= threshold, score: cRes.score, reason: "chat_classifier", endpoint: "chat" };
    }

    // 两类均失败，fail-open
    _diag("classify_all_failed", `模型 ${model} systemone 与 chat 端点均请求失败`);
    return { shouldHarvest: true, score: 0.5, reason: "classify_all_failed" };
  } catch (err) {
    _diag("classifier_exception", (err && err.message) || String(err));
    return { shouldHarvest: true, score: 0.5, reason: "classifier_exception" };
  }
}

export async function testClassificationModel(options = {}) {
  const model = String(options.classify_model || options.classifier_model || "").trim();
  if (!model || model === "off" || model === "none") {
    // 独立调用如实报告「未配置」；聚合层 testModelConnectivity 会因 skipped 将其从判定中剔除
    return { skipped: true, ok: false, error: "未配置判定模型 (classify_model 为空或已禁用)" };
  }

  const endpoint = String(options.classify_endpoint || "auto").trim().toLowerCase();
  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  // 弃用通用 timeout_ms，采用专名；默认放宽至 15 秒 (15000ms)
  const timeoutMs = Number(options.model_check_timeout_ms || options.classify_timeout_ms) || 15000;
  const doFetch = options._fetch || globalThis.fetch;

  const testDialogue = "[user]: 我们已决定在生产环境采用 PostgreSQL 替代 MySQL。\n[assistant]: 好的，已记录技术选型。";

  const start = Date.now();
  const url = endpoint === "systemone" ? `${baseUrl}/v1/systemone` : `${baseUrl}/v1/chat/completions`;
  try {
    const res = await classifyDialogueWithOnlineModel(testDialogue, {
      classify_model: model,
      classify_endpoint: endpoint,
      gateway_url: baseUrl,
      gateway_api_key: apiKey,
      classify_timeout_ms: timeoutMs,
      _fetch: doFetch,
    });
    const latencyMs = Date.now() - start;

    const isSuccess = res && (res.reason === "systemone" || res.reason === "chat_classifier");
    if (!isSuccess) {
      const reasonMsg = res?.reason || "unknown_failure";
      const extraErr = res?.budgetSkipped ? " (调用预算超限)" : (res?.errText ? ` - ${res.errText.slice(0, 80)}` : "");
      return {
        ok: false,
        model,
        endpoint,
        usedUrl: url,
        timeoutMs,
        latencyMs,
        reason: res?.reason,
        error: `分类器验证未通过: ${reasonMsg}${extraErr} (URL: ${url}, 耗时: ${latencyMs}ms)`,
      };
    }

    return {
      ok: true,
      model,
      effectiveEndpoint: res.endpoint || endpoint,
      usedUrl: url,
      timeoutMs,
      latencyMs,
      score: res.score,
      shouldHarvest: res.shouldHarvest,
      reason: res.reason,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isAborted = (err && (err.name === "AbortError" || /aborted/i.test(err.message)));
    const detailMsg = isAborted ? `调用超时 (${latencyMs}ms > 限制 ${timeoutMs}ms)` : ((err && err.message) || String(err));
    return {
      ok: false,
      model,
      endpoint,
      usedUrl: url,
      timeoutMs,
      latencyMs,
      error: `检测过程异常: ${detailMsg} (URL: ${url})`,
    };
  }
}
