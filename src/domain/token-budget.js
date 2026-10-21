/**
 * 模块职责：在线模型调用的自激豁免判定与调用预算/熔断（v6.20.0 新增）
 * 依赖：node:fs
 * 被依赖：model_budget.js, src/services/harvest/**, src/core/config.js, online_models.js, page_actions.js
 */

import { readFileSync } from "node:fs";

export const MEMHUB_INTERNAL_HEADER = "x-memhub-internal";
export const MEMHUB_INTERNAL_VALUE = "1";
export const MAGPIE_INTERNAL_HEADER = "x-magpie-internal";
export const MAGPIE_INTERNAL_VALUE = "memory-hub";
export const MEMHUB_CLIENT_NAME = "Memory";

let _cachedUserAgent = null;

/**
 * 获取插件内部模型调用使用的 User-Agent
 * 规则：
 * - 运行时从 package.json 读取 version，拼接为 "Memory/<version>"
 * - 模块级变量 _cachedUserAgent 缓存，只读一次，避免每次请求重复读盘
 * - 容错处理：若读不到或解析失败，回退为 "Memory"（不带斜杠，Magpie agentOf 仍能正确归一为 Memory）
 */
export function getClientUserAgent() {
  if (_cachedUserAgent !== null) {
    return _cachedUserAgent;
  }
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const content = readFileSync(pkgUrl, "utf8");
    const parsed = JSON.parse(content);
    const ver = typeof parsed?.version === "string" ? parsed.version.trim() : "";
    if (ver) {
      _cachedUserAgent = `${MEMHUB_CLIENT_NAME}/${ver}`;
      return _cachedUserAgent;
    }
  } catch (_) {
    // 容错回退
  }
  _cachedUserAgent = MEMHUB_CLIENT_NAME;
  return _cachedUserAgent;
}

/** 仅供测试使用：重置 User-Agent 模块缓存 */
export function _resetUserAgentCacheForTesting() {
  _cachedUserAgent = null;
}

/**
 * 统一构造插件内部发起的大模型请求头
 *
 * @param {string} [apiKey=""] - 网关 API 密钥
 * @param {object} [extraHeaders={}] - 额外自定义头
 * @returns {Record<string, string>}
 */
export function getInternalModelHeaders(apiKey = "", extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": getClientUserAgent(),
    "X-Magpie-Agent": MEMHUB_CLIENT_NAME,
    [MEMHUB_INTERNAL_HEADER]: MEMHUB_INTERNAL_VALUE,
    [MAGPIE_INTERNAL_HEADER]: MAGPIE_INTERNAL_VALUE,
    ...(extraHeaders || {}),
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * 内部模型调用请求体指纹：四条内部 system prompt 的稳定子串。
 * 与提示词原文强绑定——若修改下列提示词，必须同步更新此处，否则豁免失效：
 * - "会话价值判定器"：gateway_harvest.hooks.js classify 经 chat 端点的判定提示词
 * - "长期记忆与踩坑经验提炼助手"：gateway_harvest.hooks.js HARVEST_SYSTEM_PROMPT
 * - "系统故障诊断专家"：online_models.js ERROR_DIAGNOSE_SYSTEM_PROMPT
 * - "长期记忆检索改写助手"：online_models.js QUERY_REWRITE_SYSTEM_PROMPT
 * - "长期记忆中枢全自动去重专家"：online_models.js AUDIT_SYSTEM_PROMPT (P0-1 对齐实际提示词)
 * - "长期记忆中枢体检与质量审阅专家"：历史兼容与旧版提示词
 * - "记忆中枢检索增强与语义重排专家"：online_models.js RERANK_SYSTEM_PROMPT
 */
export const INTERNAL_PROMPT_MARKERS = [
  "会话价值判定器",
  "长期记忆与踩坑经验提炼助手",
  "系统故障诊断专家",
  "长期记忆检索改写助手",
  "长期记忆中枢全自动去重专家",
  "长期记忆中枢体检与质量审阅专家",
  "记忆中枢检索增强与语义重排专家",
];

function _checkPromptSnippet(val) {
  if (val === null || val === undefined) return false;
  let text = "";
  if (typeof val === "string") {
    text = val.slice(0, 2000);
  } else {
    try {
      text = JSON.stringify(val).slice(0, 2000);
    } catch (_) {
      return false;
    }
  }
  if (!text) return false;
  for (const mk of INTERNAL_PROMPT_MARKERS) {
    if (mk && text.includes(mk)) return true;
  }
  return false;
}

/**
 * 判定一次网关请求是否为本插件内部模型调用（命中则钩子必须立即豁免）。
 * @param {object} body 请求体（chat: {messages}；systemone: {state, questions}）
 * @param {object} ctx 钩子上下文（含 options/state/headers 等，字段缺失时容错）
 */
export function isInternalHarvestRequest(body, ctx) {
  try {
    const c = ctx && typeof ctx === "object" ? ctx : {};

    // 1) 同请求传递的进程内标记（onRequest 命中后打标，onResponse 直接复用）
    if (c.state && c.state.memhubInternal === true) return true;
    if (c.memhubInternal === true) return true;

    // 2) 显式请求头（优先识别：宿主若透出请求头则立即命中）
    const headerSources = [c.headers, c.requestHeaders, c.httpHeaders, c.reqHeaders];
    for (const h of headerSources) {
      if (!h || typeof h !== "object") continue;
      for (const k of Object.keys(h)) {
        const lowerKey = String(k).toLowerCase();
        const val = String(h[k]).trim().toLowerCase();
        if (lowerKey === MEMHUB_INTERNAL_HEADER && val === MEMHUB_INTERNAL_VALUE) {
          return true;
        }
        if (lowerKey === MAGPIE_INTERNAL_HEADER && val === MAGPIE_INTERNAL_VALUE) {
          return true;
        }
      }
    }

    // 3) 请求体特征（主判据，不依赖宿主透出任何额外字段）
    if (body && typeof body === "object") {
      // systemone 决策请求体（{model, state, questions}）不可能是用户会话流量；
      // 钩子正常情况下见不到它（systemone 不触发钩子），防御性覆盖。
      if (body.questions !== undefined && body.state !== undefined) return true;

      // 检查「所有可能承载 system prompt 的位置」：
      // body.system、body.systemInstruction (驼峰) 与 body.system_instruction (snake_case)、body.instructions
      if (_checkPromptSnippet(body.system)) return true;
      if (_checkPromptSnippet(body.systemInstruction)) return true;
      if (_checkPromptSnippet(body.system_instruction)) return true;
      if (_checkPromptSnippet(body.systemInstructions)) return true;
      if (_checkPromptSnippet(body.system_instructions)) return true;
      if (_checkPromptSnippet(body.instructions)) return true;

      // Gemini contents 形态：检查 contents[0] 与 contents 末元素，每个最多前 2000 字符
      if (Array.isArray(body.contents) && body.contents.length > 0) {
        if (_checkPromptSnippet(body.contents[0])) return true;
        if (_checkPromptSnippet(body.contents[body.contents.length - 1])) return true;
      }

      // Responses input 形态：支持 string 或 array（检查 input[0] 与 input 末元素）
      if (typeof body.input === "string") {
        if (_checkPromptSnippet(body.input)) return true;
      } else if (Array.isArray(body.input) && body.input.length > 0) {
        if (_checkPromptSnippet(body.input[0])) return true;
        if (_checkPromptSnippet(body.input[body.input.length - 1])) return true;
      } else if (body.input && typeof body.input === "object") {
        if (_checkPromptSnippet(body.input)) return true;
      }

      // Chat messages 形态：检查 messages[0]、末元素、及带有 system role 或包含 marker 的消息
      if (Array.isArray(body.messages) && body.messages.length > 0) {
        if (_checkPromptSnippet(body.messages[0])) return true;
        if (_checkPromptSnippet(body.messages[body.messages.length - 1])) return true;

        for (const m of body.messages) {
          if (!m) continue;
          if (m.role === "system" || typeof m.content === "string") {
            if (_checkPromptSnippet(m.content)) return true;
          }
        }
      }
    }
  } catch (_) {
    // 极致 fail-open：判定自身绝不抛错；拿不准时返回 false（走正常采集路径）
  }
  return false;
}

/* ================================================================== *
 * 调用预算与熔断
 * ================================================================== */

export const BUDGET_WINDOW_MS = 60000;
export const DEFAULT_MAX_PER_MIN = 20;
export const DEFAULT_MAX_TOTAL = 2000;

const _callTimestamps = [];
let _totalCalls = 0;
let _tripped = false;
const _warned = new Set();

function _numOpt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function _prune(now) {
  const cutoff = (typeof now === "number" ? now : Date.now()) - BUDGET_WINDOW_MS;
  while (_callTimestamps.length > 0 && _callTimestamps[0] <= cutoff) {
    _callTimestamps.shift();
  }
}

function _warnOnce(tag, msg) {
  if (_warned.has(tag)) return;
  _warned.add(tag);
  try { console.log("[memory-hub][model-budget] " + msg); } catch (_) {}
}

export function getModelBudgetState() {
  _prune(Date.now());
  return {
    perMinute: _callTimestamps.length,
    total: _totalCalls,
    tripped: _tripped,
    windowMs: BUDGET_WINDOW_MS,
  };
}

/**
 * 调用前检查：是否允许再发起一次模型调用。
 * @returns {{allowed:boolean, reason:string, perMinute:number, total:number, tripped:boolean}}
 */
export function modelBudgetCheck(options = {}) {
  const o = options && typeof options === "object" ? options : {};
  const maxPerMin = _numOpt(o.harvest_max_per_min ?? o.model_max_per_min, DEFAULT_MAX_PER_MIN);
  const maxTotal = _numOpt(o.harvest_max_total ?? o.model_max_total, DEFAULT_MAX_TOTAL);
  _prune(Date.now());
  if (_tripped) {
    return { allowed: false, reason: "budget_total_tripped", perMinute: _callTimestamps.length, total: _totalCalls, tripped: true, maxPerMin, maxTotal };
  }
  if (_totalCalls >= maxTotal) {
    _tripped = true;
    _warnOnce("tripped", `单进程累计模型调用已达上限 (${_totalCalls}/${maxTotal})，已熔断：本进程不再自动采集，需重启网关恢复`);
    return { allowed: false, reason: "budget_total_exceeded", perMinute: _callTimestamps.length, total: _totalCalls, tripped: true, maxPerMin, maxTotal };
  }
  if (_callTimestamps.length >= maxPerMin) {
    _warnOnce("minute", `60 秒窗口模型调用已达上限 (${_callTimestamps.length}/${maxPerMin})，超限采集已跳过`);
    return { allowed: false, reason: "budget_minute_exceeded", perMinute: _callTimestamps.length, total: _totalCalls, tripped: false, maxPerMin, maxTotal };
  }
  return { allowed: true, reason: "ok", perMinute: _callTimestamps.length, total: _totalCalls, tripped: false, maxPerMin, maxTotal };
}

/** 实际发起一次模型 HTTP 调用后记录（成功/失败均计数，防止失败紧循环打爆额度）。 */
export function modelBudgetRecord() {
  _totalCalls += 1;
  _callTimestamps.push(Date.now());
  _prune(Date.now());
  return getModelBudgetState();
}

/** 仅供测试：重置进程内预算计数器与熔断锁存。 */
export function resetModelBudget() {
  _callTimestamps.length = 0;
  _totalCalls = 0;
  _tripped = false;
  _warned.clear();
}

/**
 * Live 真实网关测试门控：默认关闭，仅 MEMHUB_LIVE_TEST=1 且具备
 * MAGPIE_API_KEY 时返回 true。保证全套测试默认零真实模型调用。
 */
export function shouldRunLiveTests(env) {
  const e = env || (typeof process !== "undefined" ? process.env : {});
  return String(e && e.MEMHUB_LIVE_TEST) === "1" && !!(e && e.MAGPIE_API_KEY);
}
