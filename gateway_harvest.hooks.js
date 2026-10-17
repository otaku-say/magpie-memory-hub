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
 *    复用 gateway_harvest.js 的 mineEnvironmentFacts / mineArchitecturalDecisions / mineFailures，
 *    通过 content_fingerprint 唯一指纹与近期内存缓存双重防重入库。
 */

import crypto from "node:crypto";
import {
  mineEnvironmentFacts,
  mineArchitecturalDecisions,
  mineFailures,
  isTestMode,
  isExplicitUserMemory,
} from "./gateway_harvest.js";
import { makeMcpClient, buildSelect, buildInsert, sqlValue } from "./mcp_client.js";
import {
  lookupSecret,
  lookupDatabase,
  recordPendingEvidence,
  DEFAULT_MIN_EVIDENCE,
} from "./local_state.js";

/** Headroom :68-80 脚手架注入前缀黑名单 */
export const SCAFFOLDING_PATTERNS = [
  /<app-context[\s\S]*?(?:<\/app-context>|$)/gi,
  /<system-reminder[\s\S]*?(?:<\/system-reminder>|$)/gi,
  /<permissions instructions[\s\S]*?(?:<\/permissions instructions>|$)/gi,
  /<skills_instructions[\s\S]*?(?:<\/skills_instructions>|$)/gi,
  /<context[\s\S]*?(?:<\/context>|$)/gi,
  /<instructions[\s\S]*?(?:<\/instructions>|$)/gi,
  /#\s*agents\.md\s+instructions\s+for[^\n]*/gi,
  /another language model started to solve[^\n]*/gi,
  /\[developer instructions\][\s\S]*?(?:\n\n|$)/gi,
];

export function stripScaffolding(text) {
  if (!text) return "";
  let s = String(text);
  for (const pat of SCAFFOLDING_PATTERNS) {
    s = s.replace(pat, "");
  }
  return s.trim();
}

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
    } else if (typeof body.prompt === "string" && body.prompt.trim()) {
      userText = `[user]: ${body.prompt.trim()}`;
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

  // 4. Legacy single prompt
  if (typeof body.prompt === "string" && body.prompt.trim()) {
    return 1;
  }

  return null;
}

/* ================================================================== *
 * 3. 提炼并安全入库
 * ================================================================== */

export async function processDialogueAndHarvest(dialogueText, meta = {}, client = null, options = {}) {
  if (!dialogueText || dialogueText.length < 20) {
    return { memoriesSaved: 0, pitfallsSaved: 0, pendingSaved: 0, skipped: true, reason: "dialogue too short" };
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

  // 规则启发式提炼
  const facts = mineEnvironmentFacts(dialogueText);
  const decisions = mineArchitecturalDecisions(dialogueText);
  const failures = mineFailures(dialogueText);

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

    const fp = fingerprint(`${project}:${item.category}:${title}:${content}`);
    if (isRecent("m:" + fp)) continue;

    // 门禁按类型区分：非显式表达且显式指定了 minEvidenceMemory > 1 时进入 pending 门禁
    if (!isExplicit && minEvidenceMemory > 1) {
      const pendingRes = recordPendingEvidence("m:" + fp, { ...item, project, agent }, {
        kind: "memory",
        minEvidence: minEvidenceMemory,
      });
      if (!pendingRes.shouldGraduate) {
        pendingSaved++;
        continue;
      }
    }

    if (client) {
      try {
        // 查重：按 content_fingerprint 精确索引查询，彻底根治超过 100 条分页截断导致的失效
        const existing = await client.list("memories", {
          project,
          content_fingerprint: fp,
          limit: 1,
        });
        const isDupe = Array.isArray(existing?.data) && existing.data.length > 0;
        if (isDupe) {
          markRecent("m:" + fp);
          continue;
        }

        const now = new Date().toISOString().slice(0, 19).replace("T", " ");
        await client.create("memories", {
          project,
          category: item.category || "fact",
          scope_level: item.scope_level || "project",
          client: agent,
          origin: "harvest",
          title,
          content,
          full_text: content,
          tags: item.tags || "auto-harvest",
          related_entities: "",
          content_fingerprint: fp,
          confidence_score: Math.round((item.confidence || 0.8) * 100),
          lifecycle_status: "active",
          superseded_by_id: null,
          revision: 1,
          retrieval_count: 0,
          created_at: now,
          updated_at: now,
          invalid_at: null,
          invalid_reason: "",
          expires_at: null,
          last_used_at: null,
          source_session: sourceSession,
          source_turn: sourceTurn,
        });
        markRecent("m:" + fp);
        memoriesSaved++;
      } catch (err) {
        // 静默容错，fail-open
      }
    } else {
      markRecent("m:" + fp);
      memoriesSaved++;
    }
  }

  // 2. 入库 pitfalls（踩坑与失败规避）
  const turnKey = fingerprint(dialogueText.slice(0, 300));
  for (const item of failures) {
    const component = String(item.component || "general").trim();
    const symptom = String(item.symptom || "").trim();
    if (!symptom) continue;

    const fp = item.content_fingerprint || fingerprint(`${project}:${component}:${symptom}`);
    const pitKey = `p:${project}:${fp}`;
    if (isRecent(pitKey)) continue;

    let recurrence = 1;
    // P0 证据门禁：非显式表达必须在 pending 累计达到 minEvidencePitfall（同一轮次 turnKey 去重）
    if (!isExplicit && minEvidencePitfall > 1) {
      const pendingRes = recordPendingEvidence(pitKey, { ...item, project, agent }, {
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

    if (client) {
      try {
        // 查重：按 content_fingerprint 精确索引查询，彻底根治超过 100 条分页截断导致的失效
        const existing = await client.list("pitfalls", {
          project,
          content_fingerprint: fp,
          limit: 1,
        });
        const isDupe = Array.isArray(existing?.data) && existing.data.length > 0;
        if (isDupe) {
          const row = existing.data[0];
          const next = (Number(row.recurrence) || 1) + recurrence;
          const now = new Date().toISOString().slice(0, 19).replace("T", " ");
          try {
            await client.update("pitfalls", row.id, {
              recurrence: next,
              last_occurred_at: now,
              updated_at: now,
            });
          } catch (_) {}
          markRecent(pitKey);
          continue;
        }

        const now = new Date().toISOString().slice(0, 19).replace("T", " ");
        await client.create("pitfalls", {
          project,
          client: agent,
          component,
          symptom,
          root_cause: item.root_cause || `执行中出现 ${symptom}，后续成功解决`,
          solution: item.solution || "",
          severity: item.severity || "medium",
          error_type: item.error_type || "general",
          tags: item.tags || "auto-harvest,gateway",
          content_fingerprint: fp,
          recurrence,
          created_at: now,
          updated_at: now,
          invalid_at: null,
          invalid_reason: "",
          last_occurred_at: now,
          source_session: sourceSession,
          source_turn: sourceTurn,
        });
        markRecent(pitKey);
        pitfallsSaved++;
      } catch (err) {
        // 静默容错，fail-open
      }
    } else {
      markRecent("p:" + fp);
      pitfallsSaved++;
    }
  }

  return { memoriesSaved, pitfallsSaved, pendingSaved, skipped: false };
}

/* ================================================================== *
 * 4. 导出的异步网关请求钩子 (Async Gateway Hooks)
 * ================================================================== */

/**
 * 请求前置钩子：在路由前调用。
 * 绝不改动 body，只读提取元数据并绑定到 ctx.state。
 */
export async function onRequest(body, ctx) {
  try {
    const opts = (ctx && ctx.options) || {};
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
    // 默认关闭校验
    if (opts.auto_harvest !== true) {
      return;
    }

    // 严禁在测试环境或非生产跑批中触发写库
    if (isTestMode()) {
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

    // 构造 NCB client（如果配置了 mcp_key）
    let client = null;
    const mcpKey = opts.mcp_key || opts.mcpKey || process.env.NCB_API_KEY || "";
    const instance = opts.ncb_instance || opts.instance || lookupDatabase() || "memory";
    if (mcpKey) {
      try {
        client = makeMcpClient({ mcpKey, instance });
      } catch (_) {
        client = null;
      }
    }

    await processDialogueAndHarvest(dialogueText, meta, client, opts);
  } catch (e) {
    // 极致 fail-open：吞掉一切异常，绝不向上抛出
  }
}
