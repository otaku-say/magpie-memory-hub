/**
 * gateway_harvest.hooks.js —— Magpie 异步网关请求钩子 (PR #2118 / Async Gateway Hooks)
 * ====================================================================================
 *
 * 【架构设计与 Fail-Open 铁律】
 * 1. 运行环境：
 *    本钩子由 Magpie 插件宿主（Bun）通过 package.json 的 magpie.hooks 注册加载。
 *    运行在 Bun 插件宿主进程中，具备原生异步 I/O、fetch 与网络访问能力。
 *
 * 2. 核心生命周期与触发时机：
 *    - onRequest(body, ctx)：请求路由前调用。
 *      只读捕获请求信息到 ctx.state，绝不改动 body（直接返回 undefined）。
 *      若抛错/超时，Magpie 自动回滚原样请求，完全 fail-open。
 *    - onResponse(reply, ctx)：响应完成交付后后台异步触发。
 *      完全处于非关键路径（fire-and-forget 独立协程），客户端此时已接收到完整响应。
 *      无论本钩子成功、抛错还是超时，对客户端模型请求零影响。
 *
 * 3. 默认关闭（Zero Impact by Default）：
 *    读取 ctx.options.auto_harvest；未显式开启时（默认 false）首行立即退出，0 额外开销。
 *
 * 4. 抽取逻辑与复用：
 *    采用 Model-in-the-Loop 在线大模型结构化提炼，
 *    通过 content_fingerprint 唯一指纹与近期内存缓存双重防重入库。
 */

import crypto from "node:crypto";
import { MagpieMemoryHub } from "./tools.js";
import {
  isTestMode,
  isExplicitUserMemory,
} from "./gateway_harvest.js";
import {
  normalizeSemanticText,
  semanticFingerprint,
  isSemanticallySimilar,
  findSemanticDuplicate,
  tokenize,
  overlapCoefficient,
  jaccardSimilarity,
  hasConflictingNumbers,
} from "./semantic_dedup.js";
import { makeMcpClient, buildSelect, buildInsert, sqlValue } from "./mcp_client.js";
import {
  lookupSecret,
  lookupDatabase,
  lookupRealDatabase,
  recordPendingEvidence,
  DEFAULT_MIN_EVIDENCE,
  enqueueHarvestItems,
  readHarvestQueue,
  removeHarvestItems,
  updateHarvestItemRetries,
} from "./local_state.js";
import {
  MEMHUB_INTERNAL_HEADER,
  MEMHUB_INTERNAL_VALUE,
  isInternalHarvestRequest,
  modelBudgetCheck,
  modelBudgetRecord,
  getModelBudgetState,
  getInternalModelHeaders,
} from "./model_budget.js";

import { _diag, SCAFFOLDING_PATTERNS, stripScaffolding } from "./gateway_harvest.js";

import { scrubSecrets } from "./scrub.js";
export { scrubSecrets };

function safeEnqueueHarvestItems(items) {
  if (!Array.isArray(items)) return;
  const scrubbed = items.map((it) => {
    if (!it || !it.data || typeof it.data !== "object") return it;
    const data = Object.assign({}, it.data);
    for (const k of ["title", "content", "full_text", "symptom", "root_cause", "solution", "tags", "related_entities"]) {
      if (typeof data[k] === "string") {
        data[k] = scrubSecrets(data[k]);
      }
    }
    return Object.assign({}, it, { data });
  });
  return enqueueHarvestItems(scrubbed);
}


export { SCAFFOLDING_PATTERNS, stripScaffolding };

/* ================================================================== *
 * 1. 进程内近期去重与辅助结构
 * ================================================================== */

const RECENT_CAP = 1000;
const recentFingerprints = new Map();

function markRecent(fp) {
  if (!fp) return;
  if (recentFingerprints.size >= RECENT_CAP) {
    const oldestKey = recentFingerprints.keys().next().value;
    if (oldestKey) recentFingerprints.delete(oldestKey);
  }
  recentFingerprints.set(fp, Date.now());
}

function isRecent(fp) {
  if (!fp) return false;
  const at = recentFingerprints.get(fp);
  if (!at) return false;
  if (Date.now() - at > 300000) {
    recentFingerprints.delete(fp);
    return false;
  }
  return true;
}

export function fingerprint(text) {
  return crypto.createHash("sha256").update(String(text || "").trim()).digest("hex");
}

/* ================================================================== *
 * 2. 跨协议对话文本提取
 * ================================================================== */

export function extractLastUserTurn(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const role = m.role || "user";
    // 丢弃 role === "system" 与 role === "tool" 与 role === "function"（Headroom :68-80 / mem0 utils.py:65）
    if (role === "system" || role === "tool" || role === "function") {
      continue;
    }
    if (role === "user") {
      let text = "";
      if (typeof m.content === "string") {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content
          .map((p) => {
            if (!p) return "";
            if (typeof p === "string") return p;
            if (p.type === "text" && typeof p.text === "string") return p.text;
            if (typeof p.content === "string") return p.content;
            if (Array.isArray(p.content)) {
              return p.content
                .map((cp) => (typeof cp === "string" ? cp : (cp && cp.text) || ""))
                .filter(Boolean)
                .join("\n");
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      const stripped = stripScaffolding(text);
      if (stripped && stripped.trim()) {
        return `[user]: ${stripped.trim()}`;
      }
    }
  }
  return "";
}

export function extractTextFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  const parts = [];
  for (const m of messages) {
    if (!m) continue;
    const role = m.role || "user";
    // 过滤系统与工具回显
    if (role === "system" || role === "tool" || role === "function") {
      continue;
    }
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map((p) => {
          if (!p) return "";
          if (typeof p === "string") return p;
          if (p.type === "text" && typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
          if (Array.isArray(p.content)) {
            return p.content
              .map((cp) => (typeof cp === "string" ? cp : (cp && cp.text) || ""))
              .filter(Boolean)
              .join("\n");
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    const stripped = stripScaffolding(text);
    if (stripped && stripped.trim()) {
      parts.push(`[${role}]: ${stripped.trim()}`);
    }
  }
  return parts.join("\n");
}

export function extractTextFromReply(reply) {
  if (!reply || typeof reply !== "object") return "";

  // 1. OpenAI Chat Completions 格式
  if (Array.isArray(reply.choices) && reply.choices[0]) {
    const c = reply.choices[0];
    const msg = c.message || c.delta;
    if (msg) {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .map((p) => (typeof p === "string" ? p : (p && p.text) || ""))
          .filter(Boolean)
          .join("\n");
      }
    }
    if (typeof c.text === "string") return c.text;
  }

  // 2. Anthropic Messages 格式
  if (Array.isArray(reply.content)) {
    return reply.content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // 3. Gemini generateContent 格式
  if (Array.isArray(reply.candidates) && reply.candidates[0]?.content?.parts) {
    return reply.candidates[0].content.parts
      .filter((p) => !p?.thought)
      .map((p) => (typeof p === "string" ? p : (p && p.text) || ""))
      .filter(Boolean)
      .join("\n");
  }

  // 4. OpenAI Responses API 格式 (output[].content[].text, type 为 output_text 或 text)
  if (Array.isArray(reply.output)) {
    const parts = [];
    for (const out of reply.output) {
      if (!out) continue;
      if (typeof out.content === "string" && out.content.trim()) {
        parts.push(out.content.trim());
      } else if (Array.isArray(out.content)) {
        for (const item of out.content) {
          if (!item) continue;
          if (typeof item === "string" && item.trim()) {
            parts.push(item.trim());
          } else if (
            (item.type === "output_text" || item.type === "text" || !item.type) &&
            typeof item.text === "string" &&
            item.text.trim()
          ) {
            parts.push(item.text.trim());
          }
        }
      }
    }
    if (parts.length) return parts.join("\n");
  }

  if (typeof reply.output_text === "string" && reply.output_text.trim()) {
    return reply.output_text.trim();
  }

  return "";
}

export function buildDialogueText(body, reply) {
  const parts = [];
  // 请求侧：仅取本轮增量（最后一轮用户输入），绝不反复扫描全部历史对话
  let userText = "";
  if (body) {
    if (Array.isArray(body.messages)) {
      userText = extractLastUserTurn(body.messages);
    } else if (Array.isArray(body.contents)) {
      // Gemini contents：仅取最后一轮非 model 的 user 内容
      for (let i = body.contents.length - 1; i >= 0; i--) {
        const c = body.contents[i];
        if (!c) continue;
        if (c.role !== "model") {
          const t = (c.parts || [])
            .filter((p) => !p?.thought)
            .map((p) => (typeof p === "string" ? p : (p && p.text) || ""))
            .filter(Boolean)
            .join("\n")
            .trim();
          if (t) {
            userText = `[user]: ${t}`;
            break;
          }
        }
      }
    } else if (body.input !== undefined) {
      // Responses API: body.input 可以是纯字符串，也可以是数组
      if (typeof body.input === "string" && body.input.trim()) {
        userText = `[user]: ${body.input.trim()}`;
      } else if (Array.isArray(body.input)) {
        for (let i = body.input.length - 1; i >= 0; i--) {
          const it = body.input[i];
          if (!it) continue;
          const role = it.role || (it.type === "function_call_output" ? "tool" : "user");
          if (role === "user") {
            let t = "";
            if (typeof it.content === "string") {
              t = it.content;
            } else if (Array.isArray(it.content)) {
              t = it.content
                .map((cp) => (typeof cp === "string" ? cp : (cp && cp.text) || ""))
                .filter(Boolean)
                .join("\n");
            } else if (typeof it.output === "string") {
              t = it.output;
            }
            if (t && t.trim()) {
              userText = `[user]: ${t.trim()}`;
              break;
            }
          }
        }
      }
    }
  }
  if (userText) {
    const stripped = stripScaffolding(userText);
    if (stripped && stripped.trim()) parts.push(stripped.trim());
  }

  // 响应侧：本次模型生成的最新回复
  const assistantText = extractTextFromReply(reply);
  if (assistantText && assistantText.trim()) {
    const stripped = stripScaffolding(assistantText);
    if (stripped && stripped.trim()) parts.push(`[assistant]: ${stripped.trim()}`);
  }

  return parts.join("\n\n");
}

/**
 * 从不同协议请求体推导用户轮次序号（从 1 开始的正整数）。
 *
 * 跨协议推导规则：
 * - OpenAI / Anthropic: 数 body.messages 中 role === "user" 的条数
 * - Gemini: 数 body.contents 中 role !== "model" 的条数
 * - Responses API: 数 body.input 中 role === "user"（或非 function_call_output）的条数
 * - 单次 Prompt: 1 轮
 *
 * 空值语义说明：
 * 请求体为空、没有 user 角色消息或无法推导时返回 null。
 * 严禁无轮次信息时伪造假数据（如硬编码 1 或 0）。
 */
export function countTurnsFromMessages(body) {
  if (!body || typeof body !== "object") return null;

  // 1. OpenAI / Anthropic messages
  if (Array.isArray(body.messages)) {
    const userTurns = body.messages.filter((m) => {
      if (!m || typeof m !== "object" || m.role !== "user") return false;
      if (typeof m.content === "string") return m.content.trim().length > 0;
      if (Array.isArray(m.content)) return m.content.length > 0;
      return true;
    }).length;
    return userTurns > 0 ? userTurns : null;
  }

  // 2. Gemini contents（仅计入包含有效正文 parts 的用户轮次，排除模型与系统指令）
  if (Array.isArray(body.contents)) {
    const userTurns = body.contents.filter((c) => {
      if (!c || typeof c !== "object" || !Array.isArray(c.parts)) return false;
      const role = c.role || "user";
      if (role === "model" || role === "system") return false;
      return c.parts.some((p) => {
        if (!p || p.thought) return false;
        if (typeof p === "string") return p.trim().length > 0;
        return typeof p.text === "string" && p.text.trim().length > 0;
      });
    }).length;
    return userTurns > 0 ? userTurns : null;
  }

  // 3. Responses API input
  if (Array.isArray(body.input)) {
    const userTurns = body.input.filter((i) => {
      if (!i || typeof i !== "object") return false;
      const role = i.role || (i.type === "function_call_output" ? "tool" : "");
      if (role === "assistant" || role === "system" || role === "tool") return false;
      if (role === "user") return true;
      if (typeof i.content === "string") return i.content.trim().length > 0;
      if (Array.isArray(i.content)) return i.content.length > 0;
      return false;
    }).length;
    return userTurns > 0 ? userTurns : null;
  }
  if (typeof body.input === "string" && body.input.trim()) {
    return 1;
  }

  return null;
}

/* ================================================================== *
 * 2.5 在线大模型分类判定与结构化提炼 (Model-in-the-Loop)
 * ================================================================== */

/** 判定模型端点自适应缓存：model -> "systemone" | "chat" */
export const classifyEndpointCache = new Map();

export const HARVEST_SYSTEM_PROMPT = `你是一个专业的长期记忆与踩坑经验提炼助手。从对话中严格提炼出值得跨会话持久化的重要信息。

【必须记录的内容】：
1. 长期铁律/架构原则 (principle)：用户确立的长期铁律、最高准则或核心架构原则（例如「严禁在前端代码中暴露任何密钥凭据」「单测断言失败必须立即中断流水线」）。
2. 偏好/约定 (preference)：用户表达的持久习惯、偏好风格或硬性约束（例如「统一使用 TypeScript」「不要使用 any」）。
3. 架构决策 (decision)：经确认的技术选型、组件替代、接口协议约定（例如「API 网关采用 fastify 替代 express」）。
4. 环境事实 (fact)：项目路径、可用的生效端口、确定的配置文件及生效选项、环境变量（例如「跨域必须在 config.toml 中配置 cors = true」）。
5. 真实踩坑与解法 (pitfall)：真实遇到的具体报错/异常现象，以及最终确证有效的解决办法（必须包含现象、根因、解法三要素，分别明确给出 root_cause 与 solution）。

【严禁记录的内容】：
- 闲聊、客套、问候、感谢（如「你好」「谢谢你的帮助」）。
- 宽泛的概念科普、通用语法讲解、未经运行测试的零散代码片段。
- 临时性排查提问或未验证的中间推测。
- 无复用价值的日常操作流水账。

【输出规范】：
- 若对话中没有任何值得持久化的内容，必须且仅返回空数组: []
- 若有值得记录的内容，返回合法的 JSON 数组，每个对象包含以下键：
  {
    "category": "principle" | "fact" | "preference" | "decision" | "pitfall",
    "title": "简明标题（20字以内，点明核心实体与动作）",
    "content": "核心事实、原则或踩坑详情（必须具体，包含关键参数或报错与解法）",
    "tags": "3~5个逗号分隔的同义检索词/别名/关键词（必须包含不同表述的检索同义词，如关于数据库密码必须包含：数据库,密码,凭据,db,credential,password 等，确保用户用不同同义词搜索时均可精准命中）",
    "related_entities": "逗号分隔的相关实体/技术栈/模块名（例如 Redis, Fastify, Docker；无特定实体时给空字符串 \"\"）",
    "confidence": 0.8到1.0之间的置信度数值,
    "root_cause": "技术根因（category 为 pitfall 时必填，说明引发报错的技术原因；非 pitfall 类可为空串 \"\"）",
    "solution": "已验证的解法（category 为 pitfall 时必填，说明确证有效的解决步骤；非 pitfall 类可为空串 \"\"）"
  }
- 严禁包裹 \`\`\`json 代码块，严禁输出任何 markdown 格式或额外说明文字，仅输出原始 JSON 数组。`;

/**
 * 健壮的 JSON 数组提取与解析函数（容错解析带代码块或说明文字的返回）
 */
export function parseExtractionJson(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  let s = rawText.trim();

  // 去除 markdown 代码块标记 (```json ... ``` 或 ``` ...)
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // 1. 尝试直接解析
  try {
    const direct = JSON.parse(s);
    if (Array.isArray(direct)) return direct;
    if (direct && typeof direct === "object") return [direct];
  } catch (_) {}

  // 2. 正则定位最外层的 [ ... ]
  const firstBracket = s.indexOf("[");
  const lastBracket = s.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const arrayStr = s.slice(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(arrayStr);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }

  return [];
}

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
  const timeoutMs = Number(options.classify_timeout_ms) || 15000;
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

/**
 * 调用网关在线提炼模型提炼事实、偏好、架构决策与踩坑。
 * 未配置提炼模型时明确跳过并留诊断日志，绝不私自调用写死模型。
 */
export async function harvestWithOnlineModel(dialogueText, options = {}) {
  const model = String(options.extract_model || options.harvest_model || "").trim();
  if (!model || model === "off" || model === "none") {
    _diag("harvest_model_missing", "未配置提炼模型 (extract_model 为空)，跳过提炼");
    return null;
  }

  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  const timeoutMs = Number(options.harvest_timeout_ms) || 30000;
  const doFetch = options._fetch || globalThis.fetch;

  // 调用预算熔断（v6.20.0 事故修复）：超限则直接跳过提炼（返回 null = 安全跳过），
  // 不改变 fail-open 语义，只打一行诊断。
  const _hBudget = modelBudgetCheck(options);
  if (!_hBudget.allowed) {
    _diag("budget_skip_harvest", `模型调用预算超限(${_hBudget.reason}, 60s=${_hBudget.perMinute}, 累计=${_hBudget.total})，跳过本次提炼`);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = getInternalModelHeaders(apiKey);

  try {
    const url = `${baseUrl}/v1/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: HARVEST_SYSTEM_PROMPT },
        { role: "user", content: dialogueText.slice(0, 8000) },
      ],
      temperature: 0.1,
    };

    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    try { modelBudgetRecord(); } catch (_) {}

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      _diag("online_harvest_http_err", `HTTP ${res.status}: ${errText.slice(0, 100)}`);
      return null;
    }

    const json = await res.json();
    const rawContent = json?.choices?.[0]?.message?.content || "";
    const items = parseExtractionJson(rawContent);

    const memories = [];
    const pitfalls = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const title = String(item.title || "").trim();
      const content = String(item.content || "").trim();
      if (!title || !content) continue;

      const category = String(item.category || "fact").toLowerCase();
      const tags = String(item.tags || "auto-harvest").trim();
      const confidence = typeof item.confidence === "number" ? item.confidence : 0.95;
      const minConf = Number(options.min_confidence ?? options.minConfidence ?? 0.6);
      if (confidence < minConf) continue;

      const related_entities = item.related_entities ? String(item.related_entities).trim() : "";

      if (category === "pitfall" || category === "failure" || /踩坑|报错|error|failure/i.test(category)) {
        const root_cause = item.root_cause ? String(item.root_cause).trim() : "";
        const solution = item.solution ? String(item.solution).trim() : content;
        pitfalls.push({
          title,
          content,
          symptom: item.symptom ? String(item.symptom).trim() : title,
          solution,
          root_cause,
          component: item.component || (tags.split(",")[0] || "general"),
          tags,
          related_entities,
          confidence,
          category: "pitfall",
        });
      } else {
        const VALID_CATS = ["principle", "preference", "fact", "context", "entity", "decision", "insight"];
        memories.push({
          title,
          content,
          tags,
          related_entities,
          confidence,
          category: VALID_CATS.includes(category) ? category : "fact",
        });
      }
    }

    return { memories, pitfalls, rawCount: items.length };
  } catch (err) {
    _diag("online_harvest_exception", (err && err.message) || String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ================================================================== *
 * 3. 提炼并安全入库
 * ================================================================== */

export async function processDialogueAndHarvest(dialogueText, meta = {}, client = null, options = {}) {
  if (!dialogueText || dialogueText.length < 20) {
    return { memoriesSaved: 0, pitfallsSaved: 0, pendingSaved: 0, skipped: true, reason: "dialogue too short" };
  }

  // v6.20.0 事故修复·无价值短路（零模型调用前置拦截）：
  // 纯闲聊/问候/感谢（< 60 字符且无任何技术信号）直接跳过，连判定模型都不调。
  // 显式记忆沉淀指令（"记住…"/"避坑…"）不受此短路影响，仍走正常提炼链路。
  // 注意：短路只看纯文本信号，不看模型名——不硬编码任何模型。
  if (!isExplicitUserMemory(dialogueText)) {
    const _probe = String(dialogueText).slice(0, 400);
    // 技术信号分两组判定（注意：常量组必须大小写敏感，否则 [A-Z]{3} 会误匹配任意英文词）：
    const _hasTechSignalCI = /[a-z_]{2,}\.[a-z]{2,}|[\\/][\w.-]+|```|\b(error|报错|异常|配置|端口|bug|fix|deploy|api|sql|cors|token|key|安装|依赖|版本|数据库|架构|选型|规范|偏好|记住|踩坑)\b/i.test(_probe);
    const _hasTechSignalCS = /[A-Z][A-Z0-9_]{2,}/.test(_probe);
    if (dialogueText.length < 60 && !_hasTechSignalCI && !_hasTechSignalCS) {
      return { memoriesSaved: 0, pitfallsSaved: 0, pendingSaved: 0, skipped: true, reason: "trivial_chatter_shortcircuit" };
    }
  }

  const project = String(meta.project || "global").trim();
  const agent = String(meta.agent || "gateway").trim();

  /* 来源可追溯性（空值语义说明）：
   * source_session 与 source_turn 为 NULL 是完全合法且符合设计的正常行为：
   * 1. 客户端未携带会话标识头（如 curl 或单次脚本调用）；
   * 2. 请求体缺少 user 消息或单次非对话式调用；
   * 3. 离线/测试直接调用 processDialogueAndHarvest。
   * 严禁无会话信息时伪造虚假数据，拿不到时必须为 NULL。
   * 严格截断至至多 128 字符（契合 VARCHAR 128 限制）。
   */
  const rawSession = (meta && meta.session && String(meta.session).trim()) || "";
  const sourceSession = rawSession ? rawSession.slice(0, 128) : null;
  const parsedTurn = meta && (typeof meta.turn === "number" ? meta.turn : (meta.turn ? Number(meta.turn) : null));
  const sourceTurn = (typeof parsedTurn === "number" && !isNaN(parsedTurn) && parsedTurn >= 1) ? Math.floor(parsedTurn) : null;

  // 严禁在测试环境中向 global 真实写入
  if (project === "global" && isTestMode()) {
    return { memoriesSaved: 0, pitfallsSaved: 0, pendingSaved: 0, skipped: true, reason: "test environment blocked global write" };
  }

  // 双轨制：显式记忆沉淀指令直接穿透门禁
  const isExplicit = isExplicitUserMemory(dialogueText) || options.bypass_gate === true;

  // 门槛按内容的重复特性区分（对齐 Headroom traffic_learner 设计哲学）：
  // - 踩坑 / 命令重试：属于重复出现的报错模式，保留门禁（默认 3 次才落盘）
  // - 事实 / 偏好 / 决策 / 环境画像：低频高价值知识（通常只陈述一次），门槛默认为 1（不设门禁直接入库）
  const minEvidencePitfall = typeof options.min_evidence_pitfall === "number"
    ? options.min_evidence_pitfall
    : (typeof options.min_evidence === "number"
      ? options.min_evidence
      : (typeof meta.min_evidence === "number" ? meta.min_evidence : DEFAULT_MIN_EVIDENCE));

  const minEvidenceMemory = typeof options.min_evidence_memory === "number"
    ? options.min_evidence_memory
    : 1;

  // 提取事实与踩坑候选：完全由用户在设置中指定的在线模型提炼
  const extractModel = String(options.extract_model || options.harvest_model || "").trim();
  if (!extractModel || extractModel === "off" || extractModel === "none") {
    // 未配置提炼模型：明确跳过本次采集并记录诊断日志，绝不静默、绝不偷偷使用写死模型、绝不回退规则
    _diag("harvest_skipped", "未配置提炼模型 (extract_model 为空)，安全跳过本次采集");
    return {
      memoriesSaved: 0,
      pitfallsSaved: 0,
      pendingSaved: 0,
      skipped: true,
      reason: "unconfigured_extract_model",
    };
  }

  let facts = [];
  let decisions = [];
  let failures = [];

  try {
    // 1. 分类模型快速过滤（若用户配置）
    const classRes = await classifyDialogueWithOnlineModel(dialogueText, options);
    if (classRes && !classRes.shouldHarvest) {
      _diag("classify_negative", `score=${classRes.score}`);
      return {
        memoriesSaved: 0,
        pitfallsSaved: 0,
        pendingSaved: 0,
        skipped: true,
        reason: "classified_negative",
        score: classRes.score,
      };
    }

    // 2. 在线模型结构化提炼
    const onlineRes = await harvestWithOnlineModel(dialogueText, options);
    if (onlineRes === null) {
      // 提炼模型不可用或异常：安全跳过本次采集并留一行诊断日志，绝不回退启发式规则
      _diag("harvest_unavailable_skip", "提炼模型服务不可用或异常，安全跳过本次采集");
      return {
        memoriesSaved: 0,
        pitfallsSaved: 0,
        pendingSaved: 0,
        skipped: true,
        reason: "online_harvest_unavailable",
      };
    }

    for (const m of onlineRes.memories) {
      if (m.category === "decision") decisions.push(m);
      else facts.push(m);
    }
    failures = onlineRes.pitfalls;
  } catch (err) {
    _diag("online_harvest_err", (err && err.message) || String(err));
    return {
      memoriesSaved: 0,
      pitfallsSaved: 0,
      pendingSaved: 0,
      skipped: true,
      reason: "online_harvest_exception",
    };
  }

  // 核心安全红线：彻底切断启发式兜底回退！
  // 绝不因模型未产出或不可用而静默切回规则制造伪踩坑噪音（fail-open 的正确含义是跳过本次，绝非换一套会制造噪音的规则）

  let memoriesSaved = 0;
  let pitfallsSaved = 0;
  let pendingSaved = 0;

  // 1. 入库 memories（环境事实与架构决策）
  // 关键：事实与架构决策是低频高价值知识（通常只陈述一次），门槛默认为 1（直接入库，不设门禁）
  // 若显式传入 minEvidenceMemory > 1 且非显式表达，则受控进入 pending 证据门禁
  const memoryCandidates = facts.concat(decisions);
  for (const item of memoryCandidates) {
    const title = String(item.title || "").trim();
    const content = String(item.content || "").trim();
    if (!title || !content) continue;

    const fp = semanticFingerprint(project, item.category || "fact", title, content, item.tags);
    const memKey = `m:${project}:${fp}`;
    if (isRecent(memKey)) continue;

    // 门禁按类型区分：非显式表达且显式指定了 minEvidenceMemory > 1 时进入 pending 门禁
    if (!isExplicit && minEvidenceMemory > 1) {
      const pendingRes = recordPendingEvidence(memKey, { ...item, project, agent }, {
        kind: "memory",
        minEvidence: minEvidenceMemory,
        turnKey: fingerprint(dialogueText.slice(0, 300)),
      });
      if (!pendingRes.shouldGraduate) {
        pendingSaved++;
        continue;
      }
    }

    // 1. 入库 memories（环境事实与架构决策）
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const queueId = `hq_m_${fp}`;
    const memoryPayload = {
      project,
      category: item.category || "fact",
      scope_level: item.scope_level || "project",
      client: agent,
      origin: "harvest",
      title,
      content,
      full_text: content,
      tags: item.tags || "auto-harvest",
      related_entities: item.related_entities ? String(item.related_entities).trim() : "",
      content_fingerprint: fp,
      confidence: typeof item.confidence === "number" ? (item.confidence > 1 ? item.confidence / 100 : item.confidence) : 0.8,
      confidence_score: Math.round(((typeof item.confidence === "number" ? (item.confidence > 1 ? item.confidence / 100 : item.confidence) : 0.8)) * 100),
      lifecycle_status: "active",
      superseded_by_id: null,
      revision: 1,
      recurrence: 1,
      retrieval_count: 0,
      created_at: now,
      updated_at: now,
      invalid_at: null,
      invalid_reason: "",
      expires_at: null,
      last_used_at: null,
      source_session: sourceSession,
      source_turn: sourceTurn,
    };
    safeEnqueueHarvestItems([{ id: queueId, table: "memories", data: memoryPayload, project, fp }]);
    markRecent(memKey);
    memoriesSaved++;
  }

  // 2. 入库 pitfalls（踩坑与失败规避）
  const turnKey = fingerprint(dialogueText.slice(0, 300));
  for (const item of failures) {
    const component = String(item.component || (item.tags && item.tags.split(",")[0]) || "general").trim();
    const symptom = String(item.symptom || item.title || "").trim();
    if (!symptom) continue;

    const fp = item.content_fingerprint || semanticFingerprint(project, "pitfall", component, symptom);
    const pitKey = `p:${project}:${fp}`;
    if (isRecent(pitKey)) continue;

    let recurrence = 1;
    // P0 证据门禁：非显式表达必须在 pending 累计达到 minEvidencePitfall（同一轮次 turnKey 去重）
    if (!isExplicit && minEvidencePitfall > 1) {
      const pendingRes = recordPendingEvidence(pitKey, { ...item, project, agent, component, symptom }, {
        kind: "pitfall",
        minEvidence: minEvidencePitfall,
        turnKey,
      });
      if (!pendingRes.shouldGraduate) {
        pendingSaved++;
        continue;
      }
      recurrence = pendingRes.count;
    }

    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const queueId = `hq_p_${fp}`;
    const rootCause = item.root_cause ? String(item.root_cause).trim() : "";
    const solution = item.solution ? String(item.solution).trim() : (item.content ? String(item.content).trim() : "");
    const pitfallPayload = {
      project,
      client: agent,
      component,
      symptom,
      root_cause: rootCause,
      solution: solution,
      severity: item.severity || "medium",
      error_type: item.error_type || "general",
      tags: item.tags || "auto-harvest,gateway",
      related_entities: item.related_entities ? String(item.related_entities).trim() : "",
      content_fingerprint: fp,
      recurrence,
      created_at: now,
      updated_at: now,
      invalid_at: null,
      invalid_reason: "",
      last_occurred_at: now,
      source_session: sourceSession,
      source_turn: sourceTurn,
    };
    safeEnqueueHarvestItems([{ id: queueId, table: "pitfalls", data: pitfallPayload, project, fp }]);
    markRecent(pitKey);
    pitfallsSaved++;
  }

  _diag("pipeline", "client=" + (client ? "有" : "无") + " memoriesSaved=" + memoriesSaved +
    " pitfallsSaved=" + pitfallsSaved + " pending=" + pendingSaved +
    " queue=" + (typeof readHarvestQueue === "function" ? (readHarvestQueue() || []).length : "?"));

  // 若传入了 client，由唯一受控的消费器统一执行落库（防并发重入与重复插入）
  let memoriesEnriched = 0;
  let pitfallsEvolved = 0;
  if (client && !client._isNoCredentials) {
    try {
      const drainRes = await triggerBackgroundDrain(client, options);
      _diag("drain", JSON.stringify(drainRes).slice(0, 200));
      if (drainRes && !drainRes.inProgress) {
        if (typeof drainRes.memoriesSaved === "number") {
          memoriesSaved = drainRes.memoriesSaved;
        }
        if (typeof drainRes.pitfallsSaved === "number") {
          pitfallsSaved = drainRes.pitfallsSaved;
        }
        if (typeof drainRes.memoriesEnriched === "number") {
          memoriesEnriched = drainRes.memoriesEnriched;
        }
        if (typeof drainRes.pitfallsEvolved === "number") {
          pitfallsEvolved = drainRes.pitfallsEvolved;
        }
      }
    } catch (_) {}
  }

  return { memoriesSaved, pitfallsSaved, memoriesEnriched, pitfallsEvolved, pendingSaved, skipped: false };
}

/* ================================================================== *
 * 4. 导出的异步网关请求钩子 (Async Gateway Hooks)
 * ================================================================== */

/**
 * 请求前置钩子：在路由前调用。
 * 绝不改动 body，只读提取元数据并绑定到 ctx.state。
 */

/* 一次性探针：证明「钩子到底有没有被调用」。
 * 只在进程内打一次（零刷屏），且**不含任何对话内容**（隐私安全）。
 * 必须放在 auto_harvest 判断【之前】—— 这样即使开关没生效也能打出来，
 * 从而区分「钩子没被调用」与「被调用了但开关没读到」。 */
var _hookProbeLogged = 0;
function _hookProbe(which, opts) {
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
        return undefined;
      }
    } catch (_) {}
    // 默认关闭：未显式开启时立即退出，0 额外开销
    if (opts.auto_harvest !== true) {
      return undefined;
    }

    if (!ctx.state) ctx.state = {};
    ctx.state.harvestRequested = true;
    ctx.state.session = ctx.session || "";
    ctx.state.agent = ctx.agent || "";
    ctx.state.origin = ctx.origin || "";
    ctx.state.model = ctx.model || "";
    ctx.state.startTime = Date.now();
    ctx.state.requestBody = body;

    // 绝不修改原始请求体
    return undefined;
  } catch (e) {
    // 极致 fail-open：捕获一切异常，返回 undefined 保留原样 body
    return undefined;
  }
}

/**
 * 响应后置钩子：在响应完全交付给客户端后后台异步调用 (fire-and-forget)。
 * 绝不在模型请求的关键路径上。
 */
export async function onResponse(reply, ctx) {
  try {
    const opts = (ctx && ctx.options) || {};
    _hookProbe("onResponse", opts);
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

    // 严禁在测试环境意外触发真实数据库写入（除非显式传入 mock/隔离 client 或 _force_test 标记）
    if (isTestMode() && !opts._force_test && !opts._client && !opts.client) {
      return;
    }

    // 只有请求成功完成才进行记忆提炼
    if (ctx && ctx.success === false) {
      return;
    }

    const requestBody = ctx && (ctx.request || (ctx.state && ctx.state.requestBody));
    const dialogueText = buildDialogueText(requestBody, reply);
    if (!dialogueText || dialogueText.length < 20) {
      return;
    }

    const meta = {
      project: opts.project || "global",
      agent: (ctx && ctx.agent) || (ctx && ctx.state && ctx.state.agent) || "gateway",
      session: (ctx && ctx.session) || (ctx && ctx.state && ctx.state.session) || "",
      turn: countTurnsFromMessages(requestBody),
    };

    // 构造 NCB client（支持 mcp_key 与 ncb_secret 回退）
    let client = (opts && (opts._client || opts.client)) || null;
    if (!client) {
      try {
        const { makeClient } = await import("./tools.js");
        client = makeClient(opts);
      } catch (_) {
        client = null;
      }
    }

    // 治本策略：
    // 网关钩子采用非阻塞后台异步任务（detached background promise）。
    // 提炼与本地排队在毫秒内完成，钩子极速 resolve，绝不阻塞网关交付；
    // 无论 gatewayTimeoutMs 是否存在（默认 1000ms 还是未配置），宿主超时定时器绝不会触发 abort！
    const taskPromise = processDialogueAndHarvest(dialogueText, meta, client, opts);
    if (opts.wait_for_flush === true) {
      await taskPromise;
    } else {
      taskPromise.catch(() => {});
    }
  } catch (e) {
    // fail-open 仍是原则：绝不向上抛。但**不再静默** —— 打一行诊断，否则永远查不到
    _diag("onResponse 异常", (e && e.stack) || (e && e.message) || e);
  }
}

/* ================================================================== *
 * 5. 后台异步队列消费器（供常驻后台与工具调用连带消费）
 * ================================================================== */

let _isDraining = false;
export async function triggerBackgroundDrain(client, options = {}) {
  if (!client || _isDraining) return { processed: 0, memoriesSaved: 0, pitfallsSaved: 0, inProgress: _isDraining };
  _isDraining = true;
  let totalMemoriesSaved = 0;
  let totalPitfallsSaved = 0;
  let totalMemoriesEnriched = 0;
  let totalPitfallsEvolved = 0;
  const actions = { CREATED: 0, ENRICHED: 0, EVOLVED: 0, NOOP: 0 };

  let hubInstance = null;
  const safeClient = {
    ...client,
    update: client.update ? client.update.bind(client) : async () => ({ affectedRows: 0 }),
  };

  async function getHub() {
    if (!hubInstance) {
      if (options && options.hub) {
        hubInstance = options.hub;
      } else {
        // 调度器防护（BUG-37-2）：显式透传当前真实 cfg 的 dedup_schedule
        let activeSchedule = (options && (options.dedup_schedule || options.audit_interval))
          || (options && options.cfg && (options.cfg.dedup_schedule || options.cfg.audit_interval || options.cfg.auditInterval));
        let activeCfg = (options && options.cfg) || {};

        if (!activeSchedule && typeof MagpieMemoryHub.ensureAuditScheduler === "function") {
          try {
            const check = MagpieMemoryHub.ensureAuditScheduler();
            if (check && check.started && typeof check.getFreshCfg === "function") {
              const fresh = check.getFreshCfg();
              if (fresh) {
                const s = fresh.dedup_schedule || fresh.audit_interval || fresh.auditInterval;
                if (s && s !== "off" && s !== "none") {
                  activeSchedule = s;
                  activeCfg = { ...fresh, ...activeCfg };
                }
              }
            }
          } catch (_) {}
        }

        const hubOpts = {
          ...activeCfg,
          ...(options && typeof options === "object" ? options : {}),
          _client: safeClient,
          _cfg: activeCfg,
          _no_scheduler: true,
        };
        const hubInput = {
          ...activeCfg,
          _no_scheduler: true,
        };
        if (activeSchedule) {
          hubInput.dedup_schedule = activeSchedule;
          hubOpts.dedup_schedule = activeSchedule;
        }

        hubInstance = await MagpieMemoryHub(hubInput, hubOpts);
      }
    }
    return hubInstance;
  }

  async function callSaveMemory(data, ctx) {
    if (options && typeof options.saveMemory === "function") {
      if (options.saveMemory.length >= 3) {
        return await options.saveMemory(safeClient, (options && options.cfg) || {}, data, ctx);
      }
      return await options.saveMemory(data, ctx);
    }
    const h = await getHub();
    const res = await h.tool.memory_save.execute(data, ctx);
    return typeof res === "string" ? JSON.parse(res) : res;
  }

  async function callPitfallSave(data, ctx) {
    if (options && typeof options.pitfallSave === "function") {
      if (options.pitfallSave.length >= 3) {
        return await options.pitfallSave(safeClient, (options && options.cfg) || {}, data, ctx);
      }
      return await options.pitfallSave(data, ctx);
    }
    const h = await getHub();
    const res = await h.tool.pitfall_save.execute(data, ctx);
    return typeof res === "string" ? JSON.parse(res) : res;
  }

  try {
    let totalProcessed = 0;
    while (true) {
      const queue = readHarvestQueue();
      if (!queue || queue.length === 0) break;
      let batchSuccess = 0;
      const successIds = [];
      const deadLetterIds = [];
      for (const item of queue) {
        try {
          if (item.table === "memories") {
            const project = item.project || item.data?.project || "global";
            const rawData = item.data || {};
            const rawConf = rawData.confidence !== undefined
              ? rawData.confidence
              : (rawData.confidence_score !== undefined ? (Number(rawData.confidence_score) > 1 ? Number(rawData.confidence_score) / 100 : Number(rawData.confidence_score)) : 0.8);
            const memPayload = {
              ...rawData,
              project,
              confidence: typeof rawConf === "number" && !isNaN(rawConf) ? (rawConf > 1 ? rawConf / 100 : rawConf) : 0.8,
            };
            const ctx = {
              agent: memPayload.client,
              session: memPayload.source_session,
              turn: memPayload.source_turn,
            };
            const res = await callSaveMemory(memPayload, ctx);
            const act = String((res && (res.action || (res.status ? res.status : ""))) || "").toUpperCase();
            _diag("drain_action", `item ${item.id} table=memories action=${act || "UNKNOWN"} id=${res && res.id}`);

            if (act === "ADD" || act === "CREATED" || act === "UPDATE") {
              totalMemoriesSaved++;
              actions.CREATED = (actions.CREATED || 0) + 1;
            } else if (act === "ENRICHED") {
              totalMemoriesEnriched++;
              actions.ENRICHED = (actions.ENRICHED || 0) + 1;
              _diag("drain_enriched", `item ${item.id} memory enriched id=${res.id} recurrence=${res.recurrence} rev=${res.revision}`);
            } else {
              actions.NOOP = (actions.NOOP || 0) + 1;
            }
            if (res && (res.crystallized || (res.category === "principle" && memPayload.category !== "principle"))) {
              _diag("drain_crystallized", `item ${item.id} memory crystallized into principle id=${res.id}`);
            }
            const fp = item.fp || item.data?.content_fingerprint || "";
            if (fp) markRecent(`m:${project}:${fp}`);
            successIds.push(item.id);
            batchSuccess++;
          } else if (item.table === "pitfalls") {
            const project = item.project || item.data?.project || "global";
            const pitPayload = {
              ...item.data,
              project,
            };
            const ctx = {
              agent: pitPayload.client,
              session: pitPayload.source_session,
              turn: pitPayload.source_turn,
            };
            const res = await callPitfallSave(pitPayload, ctx);
            const act = String((res && (res.action || (res.status ? res.status : ""))) || "").toUpperCase();
            _diag("drain_action", `item ${item.id} table=pitfalls action=${act || "UNKNOWN"} id=${res && res.id}`);

            if (act === "ADD" || act === "CREATED") {
              totalPitfallsSaved++;
              actions.CREATED = (actions.CREATED || 0) + 1;
            } else if (act === "EVOLVED") {
              totalPitfallsEvolved++;
              actions.EVOLVED = (actions.EVOLVED || 0) + 1;
              _diag("drain_evolved", `item ${item.id} pitfall evolved id=${res.id} recurrence=${res.recurrence} reason=${res.reason || ""}`);
            } else {
              actions.NOOP = (actions.NOOP || 0) + 1;
            }
            const fp = item.fp || item.data?.content_fingerprint || "";
            if (fp) markRecent(`p:${project}:${fp}`);
            successIds.push(item.id);
            batchSuccess++;
          }
        } catch (itemErr) {
          const msg = String((itemErr && itemErr.message) || itemErr || "");
          if (/duplicate|ER_DUP_ENTRY|already exists|1062/i.test(msg)) {
            const fp = item.fp || item.data?.content_fingerprint || "";
            const project = item.project || item.data?.project || "global";
            if (fp) markRecent((item.table === "pitfalls" ? "p:" : "m:") + project + ":" + fp);
            successIds.push(item.id);
            batchSuccess++;
            actions.NOOP = (actions.NOOP || 0) + 1;
            _diag("drain_action", `item ${item.id} duplicate index caught, marked as NOOP`);
          } else {
            const currentRetries = (Number(item.retries) || 0) + 1;
            item.retries = currentRetries;
            if (currentRetries >= 3 && !deadLetterIds.includes(item.id)) {
              deadLetterIds.push(item.id);
              _diag("dead_letter_evicted", `item ${item.id} table=${item.table} retries=${currentRetries} err=${msg.slice(0, 100)}`);
            } else {
              updateHarvestItemRetries(item.id, msg);
            }
          }
        }
      }
      const toRemove = [...successIds, ...deadLetterIds];
      if (toRemove.length > 0) {
        removeHarvestItems(toRemove);
      }
      totalProcessed += batchSuccess;
      if (batchSuccess === 0 && deadLetterIds.length === 0) {
        break;
      }
    }
    return {
      processed: totalProcessed,
      memoriesSaved: totalMemoriesSaved,
      pitfallsSaved: totalPitfallsSaved,
      memoriesEnriched: totalMemoriesEnriched,
      pitfallsEvolved: totalPitfallsEvolved,
      actions,
    };
  } finally {
    _isDraining = false;
  }
}

/* ================================================================== *
 * 5. 模型连通性与可用性真实检测能力 (Model Health Check)
 * ================================================================== */

/**
 * 真实检测提炼模型 (extract_model) 连通性与结构化提炼能力
 * 实际调用网关 /v1/chat/completions 并校验返回 JSON 结构与延迟
 */
export async function testExtractionModel(options = {}) {
  const model = String(options.extract_model || options.harvest_model || "").trim();
  if (!model) {
    return { ok: false, error: "未配置提炼模型 (extract_model 为空)" };
  }

  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  // 弃用通用 timeout_ms，采用专名；检测为手动触发，默认放宽至 30 秒 (30000ms)
  const timeoutMs = Number(options.model_check_timeout_ms || options.extract_timeout_ms) || 30000;
  const doFetch = options._fetch || globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  const url = `${baseUrl}/v1/chat/completions`;
  const headers = getInternalModelHeaders(apiKey);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: HARVEST_SYSTEM_PROMPT },
          { role: "user", content: "[user]: 这个项目统一使用 pnpm 管理依赖。\n[assistant]: 好的，已记录项目环境规范。" },
        ],
        temperature: 0.1,
        stream: false, // 显式禁用流式传输，提升响应速度并杜绝 chunk 挂起
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        ok: false,
        model,
        endpoint: "/v1/chat/completions",
        usedUrl: url,
        timeoutMs,
        latencyMs,
        status: res.status,
        error: `网关返回 HTTP ${res.status}: ${errText.slice(0, 200)} (URL: ${url}, 耗时: ${latencyMs}ms)`,
      };
    }

    const json = await res.json();
    const rawContent = json?.choices?.[0]?.message?.content || "";
    const items = parseExtractionJson(rawContent);

    return {
      ok: true,
      model,
      endpoint: "/v1/chat/completions",
      usedUrl: url,
      timeoutMs,
      latencyMs,
      itemCount: items.length,
      sampleResult: items,
      rawOutput: rawContent.slice(0, 200),
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isAborted = (err && (err.name === "AbortError" || /aborted/i.test(err.message))) || controller.signal.aborted;
    const errorType = isAborted ? (latencyMs >= timeoutMs - 500 ? "TIMEOUT" : "ABORTED") : "REQUEST_ERROR";
    const detailMsg = isAborted
      ? (latencyMs >= timeoutMs - 500
          ? `调用超时 (${latencyMs}ms > 限制 ${timeoutMs}ms)`
          : `请求被中断 (${(err && err.message) || "Aborted"}, 耗时: ${latencyMs}ms)`)
      : ((err && err.message) || String(err));

    return {
      ok: false,
      model,
      endpoint: "/v1/chat/completions",
      usedUrl: url,
      timeoutMs,
      latencyMs,
      errorType,
      error: `请求异常: ${detailMsg} (URL: ${url})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 真实检测判定模型 (classify_model) 连通性与打分能力
 * 根据 classify_endpoint 选项或 auto 自适应探测实际调用 /v1/systemone 或 /v1/chat/completions
 */
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

/**
 * 统一模型连通性检测能力入口
 */
export async function testModelConnectivity(type = "all", options = {}) {
  const result = { at: new Date().toISOString() };
  if (type === "all" || type === "extract" || type === "extraction") {
    result.extract = await testExtractionModel(options);
  }
  if (type === "all" || type === "classify" || type === "classification") {
    result.classify = await testClassificationModel(options);
  }
  const configuredItems = [];
  if (result.extract && !result.extract.skipped) configuredItems.push(result.extract);
  if (result.classify && !result.classify.skipped) configuredItems.push(result.classify);

  if (configuredItems.length === 0) {
    result.ok = (!result.extract || result.extract.ok) && (!result.classify || result.classify.ok);
  } else {
    result.ok = configuredItems.every((item) => item.ok);
  }
  return result;
}

