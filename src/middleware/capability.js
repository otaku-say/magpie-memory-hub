/**
 * 模块职责：能力探测、环境画像与作用域归一 (detectCapabilities / resolveToolCall / matchEnvScope / normalizeEnvScope)
 * 依赖：无（纯内存同步计算，零 I/O，符合 moejs 中间件运行时约束）
 * 被依赖：./inject-builder.js, ./request-inject.js, ./response-hook.js, src/services/save/memory-saver.js
 *
 * 为什么需要这个模块：
 * v6.49 及之前，sniffToolNames() 在 body.tools 为空时返回**硬编码默认工具名**，
 * buildAgentGuide() 再无条件输出「请调用 magpie-memory-hub_memory_context」。
 * 于是没有 MCP 的客户端（ishellpro 等）会被命令去调用根本不存在的工具。
 *
 * 唯一可靠的真相源是「本次请求实际通告的工具清单」（body.tools / functions /
 * Gemini functionDeclarations）。本模块把它抽成显式能力对象，注入层据此分档，
 * 响应层据此判定「模型是否在调一个没被通告的工具」（幻觉的直接证据）。
 */

/* 记忆工具的逻辑名。顺序敏感：长名在前，避免同后缀误配。 */
import { parseScope, normalizeEnvScope, mergeEnvScope, matchEnvScope, envScopeOf } from "../domain/env-scope.js";

var MEMORY_TOOL_KEYS = [
  "memory_context",
  "memory_search",
  "pitfall_search",
  "memory_save",
  "pitfall_save",
  "memory_get"
];

/* ================= 通告工具清单提取 ================= */
/* 五种结构都要兼容，否则「有工具」会被误判成「没工具」：
 *  - OpenAI chat:      body.tools = [{ type:"function", function:{ name } }]
 *  - OpenAI responses: body.tools = [{ type:"function", name, ... }]
 *  - Anthropic:        body.tools = [{ name, input_schema }]
 *  - Gemini:           body.tools = [{ functionDeclarations: [{ name }] }]
 *  - 老式 functions / 单 tool 对象 */
function advertisedToolNames(body) {
  var out = [];
  var seen = {};
  if (!body || typeof body !== "object") return out;

  function push(name) {
    if (typeof name !== "string") return;
    var n = name.trim();
    if (!n || seen[n]) return;
    seen[n] = 1;
    out.push(n);
  }

  function scanDecls(list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (d && typeof d.name === "string") push(d.name);
    }
  }

  function scanList(list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (typeof t === "string") { push(t); continue; }
      if (!t || typeof t !== "object") continue;
      if (t.function && typeof t.function.name === "string") push(t.function.name);
      if (typeof t.name === "string") push(t.name);
      scanDecls(t.functionDeclarations);
      scanDecls(t.function_declarations);
    }
  }

  scanList(body.tools);
  scanList(body.functions);
  if (body.tool && typeof body.tool === "object") scanList([body.tool]);
  return out;
}

/* 后缀匹配：客户端可能给工具加包装前缀（mcp__magpie__memory_context、
 * custom_memory-mcp_magpie-memory-hub_memory_context），只要**边界正确**
 * 的后缀一致就算命中。
 * 不用 includes：`my_memory_contextual` 不应命中 memory_context。 */
function suffixHits(name, key) {
  if (name === key) return true;
  if (name.length <= key.length) return false;
  if (name.slice(name.length - key.length) !== key) return false;
  var prev = name.charAt(name.length - key.length - 1);
  return prev === "_" || prev === "-" || prev === "." || prev === "/" || prev === ":";
}

function logicalKeyOf(name) {
  for (var i = 0; i < MEMORY_TOOL_KEYS.length; i++) {
    if (suffixHits(String(name), MEMORY_TOOL_KEYS[i])) return MEMORY_TOOL_KEYS[i];
  }
  return null;
}

/* ================= 元工具分发器 =================
 * 为什么需要这层（v7.0.1 线上回归挖出来的）：
 * Cindy / pi 这类宿主**不把 MCP 工具直标在 body.tools 里**，而是包在一个
 * 通用分发器后面（cindy_mcp_call_tool / run_code 等），真正的工具名只是
 * 分发器的一个参数。于是 v7.0.0 对它们全部降到了档 1「能力未确认」，
 * 而它们其实完全能调——这是把“保守”当成了“正确”。
 *
 * 分档因此多一档 1.5：有分发器不说“没工具”，也不写死工具名，
 * 而是告诉模型“先枚举、再经分发器调”。
 */
var DISPATCHER_RE = /(?:^|[_\-.])(call_?tool|invoke_?tool|execute_?tool|run_?code|code_?run|mcp_?call|tool_?call)$/i;

function isDispatcherName(name) {
  return DISPATCHER_RE.test(String(name || ""));
}

/* ================= 能力对象 ================= */
function detectCapabilities(body) {
  var names = advertisedToolNames(body);
  var matched = {};
  var advSet = {};
  var dispatchers = [];
  for (var k = 0; k < MEMORY_TOOL_KEYS.length; k++) matched[MEMORY_TOOL_KEYS[k]] = null;

  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    advSet[n] = 1;
    if (isDispatcherName(n)) dispatchers.push(n);
    var key = logicalKeyOf(n);
    if (key && !matched[key]) matched[key] = n;
  }

  var readOk = !!(matched.memory_context || matched.memory_search || matched.pitfall_search || matched.memory_get);
  var writeOk = !!(matched.memory_save || matched.pitfall_save);
  return {
    hasTools: names.length > 0,
    advertised: names,
    advertisedSet: advSet,
    dispatchers: dispatchers,
    hasDispatcher: dispatchers.length > 0,
    matched: matched,
    readOk: readOk,
    writeOk: writeOk,
    present: readOk || writeOk
  };
}

/* 响应侧：把模型发出的一个 tool_call 名归类。
 *  - "advertised"：与通告名逐字相等，正常
 *  - "alias"：逻辑名相同但客户端可能改写成短名，仍算正常
 *  - "unadvertised"：**通告了工具但这一名字不在清单里** → 幻觉调用
 *  - "unavailable"：本请求根本没通告任何工具 → 模型凭空造了一个工具
 */
function resolveToolCall(name, caps) {
  var n = String(name || "").trim();
  if (!n) return { kind: "empty", logical: null };
  var logical = logicalKeyOf(n);
  if (caps && caps.advertisedSet && caps.advertisedSet[n]) return { kind: "advertised", logical: logical };
  if (!logical) return { kind: "other", logical: null };
  if (!caps || !caps.hasTools) return { kind: "unavailable", logical: logical };
  return { kind: "unadvertised", logical: logical };
}

/* ================= 客户端画像 ================= */
function parseProfiles(opts) {
  var raw = opts && opts.client_profiles;
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function headerGet(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  var direct = headers[name];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct) && typeof direct[0] === "string") return direct[0];
  var lower = name.toLowerCase();
  for (var k in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
    if (String(k).toLowerCase() !== lower) continue;
    var hv = headers[k];
    if (typeof hv === "string") return hv;
    if (Array.isArray(hv) && typeof hv[0] === "string") return hv[0];
  }
  return "";
}

/* 客户端身份：宿主显式字段优先，其次请求头，其次 UA。
 * 为什么必须是环境客观信号：模型没有能力知道「自己跑在哪个宿主上」，
 * 让它自己判断等于让它猜。 */
function resolveAgentKey(body, ctx, profiles) {
  var candidates = [];
  function push(v) {
    if (typeof v === "string" && v.trim()) candidates.push(v.trim());
  }
  if (ctx && typeof ctx === "object") {
    push(ctx.agent);
    push(ctx.client);
    push(ctx.clientName);
    if (ctx.state && typeof ctx.state === "object") push(ctx.state.agent);
    push(headerGet(ctx.headers, "x-magpie-agent"));
    push(headerGet(ctx.headers, "x-agent-name"));
    push(headerGet(ctx.headers, "x-client-name"));
    var req = ctx.req || ctx.request;
    if (req && typeof req === "object") {
      push(headerGet(req.headers, "x-magpie-agent"));
      push(headerGet(req.headers, "x-agent-name"));
      push(headerGet(req.headers, "x-client-name"));
      push(headerGet(req.headers, "user-agent"));
    }
  }
  if (!candidates.length) return "";

  if (profiles && typeof profiles === "object") {
    var keys = Object.keys(profiles);
    for (var c = 0; c < candidates.length; c++) {
      var hay = candidates[c].toLowerCase();
      for (var k = 0; k < keys.length; k++) {
        if (hay.indexOf(String(keys[k]).toLowerCase()) !== -1) return keys[k];
      }
    }
  }
  return candidates[0];
}

/* ================= 禁用工具 glob ================= */
function globToRegExp(pattern) {
  var p = String(pattern || "");
  var out = "^";
  for (var i = 0; i < p.length; i++) {
    var ch = p.charAt(i);
    if (ch === "*") out += "[\\s\\S]*";
    else if (ch === "?") out += "[\\s\\S]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

function isToolForbidden(name, patterns) {
  if (!name || !Array.isArray(patterns) || !patterns.length) return false;
  for (var i = 0; i < patterns.length; i++) {
    if (typeof patterns[i] !== "string" || !patterns[i]) continue;
    try {
      if (globToRegExp(patterns[i]).test(String(name))) return true;
    } catch (e) { /* 非法模式跳过，绝不因配置笔误阻断注入 */ }
  }
  return false;
}

/* ================= 合成：能力 + 环境 ================= */
/* 返回 { caps, env, profiles, agentKey }。
 * 关键不变量：env.mcp 永远以真实通告工具为准，画像只能**收窄**不能放宽。 */
function buildEnv(body, ctx, opts) {
  var caps = detectCapabilities(body);
  var profiles = parseProfiles(opts);
  var agentKey = resolveAgentKey(body, ctx, profiles);
  var env = {};

  var profile = (profiles && agentKey && profiles[agentKey]) || null;
  if (profile && typeof profile === "object") {
    var keys = Object.keys(profile);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === "forbid_tools" || k === "tools_via") continue;
      /* 画像里的 env/mcp 不能覆盖真实探测结果 */
      if (k.toLowerCase() === "mcp") continue;
      if (profile[k] == null || profile[k] === "") continue;
      env[k.toLowerCase()] = String(profile[k]);
    }
  }
  if (agentKey) env.agent = env.agent || agentKey;
  env.mcp = caps.present ? "yes" : "no";

  caps.forbidTools = (profile && Array.isArray(profile.forbid_tools)) ? profile.forbid_tools : [];
  /* tools_via：显式指定分发器名，让档 1.5 从『猜』变成『已知』 */
  caps.toolsVia = (profile && typeof profile.tools_via === "string") ? profile.tools_via.trim() : "";
  caps.agentKey = agentKey || "";
  return { caps: caps, env: env, profiles: profiles, agentKey: agentKey || "" };
}

export {
  MEMORY_TOOL_KEYS,
  advertisedToolNames,
  isDispatcherName,
  DISPATCHER_RE,
  suffixHits,
  logicalKeyOf,
  resolveToolCall,
  detectCapabilities,
  parseProfiles,
  resolveAgentKey,
  parseScope,
  normalizeEnvScope,
  mergeEnvScope,
  matchEnvScope,
  envScopeOf,
  globToRegExp,
  isToolForbidden,
  buildEnv
};
