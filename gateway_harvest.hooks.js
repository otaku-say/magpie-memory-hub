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
} from "./gateway_harvest.js";
import { makeMcpClient, buildSelect, buildInsert, sqlValue } from "./mcp_client.js";
import { lookupSecret, lookupDatabase } from "./local_state.js";

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

export function extractTextFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  const parts = [];
  for (const m of messages) {
    if (!m) continue;
    const role = m.role || "user";
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
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (text && text.trim()) {
      parts.push(`[${role}]: ${text.trim()}`);
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
      .map((p) => (typeof p === "string" ? p : (p && p.text) || ""))
      .filter(Boolean)
      .join("\n");
  }

  // 4. OpenAI Responses API 格式
  if (Array.isArray(reply.output)) {
    const parts = [];
    for (const out of reply.output) {
      if (Array.isArray(out?.content)) {
        for (const item of out.content) {
          if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
        }
      }
    }
    if (parts.length) return parts.join("\n");
  }

  return "";
}

export function buildDialogueText(body, reply) {
  const parts = [];
  // 请求侧
  let userText = "";
  if (body) {
    if (Array.isArray(body.messages)) {
      userText = extractTextFromMessages(body.messages);
    } else if (typeof body.prompt === "string" && body.prompt.trim()) {
      userText = `[user]: ${body.prompt.trim()}`;
    } else if (Array.isArray(body.contents)) {
      // Gemini contents
      const geminiParts = [];
      for (const c of body.contents) {
        const role = c.role === "model" ? "assistant" : "user";
        const t = (c.parts || []).map((p) => p.text || "").join("\n").trim();
        if (t) geminiParts.push(`[${role}]: ${t}`);
      }
      userText = geminiParts.join("\n");
    }
  }
  if (userText) parts.push(userText);

  // 响应侧
  const assistantText = extractTextFromReply(reply);
  if (assistantText && assistantText.trim()) {
    parts.push(`[assistant]: ${assistantText.trim()}`);
  }

  return parts.join("\n\n");
}

/* ================================================================== *
 * 3. 提炼并安全入库
 * ================================================================== */

export async function processDialogueAndHarvest(dialogueText, meta = {}, client = null) {
  if (!dialogueText || dialogueText.length < 20) {
    return { memoriesSaved: 0, pitfallsSaved: 0, skipped: true, reason: "dialogue too short" };
  }

  const project = String(meta.project || "global").trim();
  const agent = String(meta.agent || "gateway").trim();

  // 规则启发式提炼
  const facts = mineEnvironmentFacts(dialogueText);
  const decisions = mineArchitecturalDecisions(dialogueText);
  const failures = mineFailures(dialogueText);

  let memoriesSaved = 0;
  let pitfallsSaved = 0;

  // 1. 入库 memories（环境事实与架构决策）
  const memoryCandidates = facts.concat(decisions);
  for (const item of memoryCandidates) {
    const title = String(item.title || "").trim();
    const content = String(item.content || "").trim();
    if (!title || !content) continue;

    const fp = fingerprint(`${project}:${item.category}:${title}:${content}`);
    if (isRecent("m:" + fp)) continue;

    if (client) {
      try {
        // 查重
        const existing = await client.list("memories", { project, limit: 100 });
        const isDupe = (existing.data || []).some(
          (r) => r.content_fingerprint === fp
        );
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
          invalid_at: null,
          invalid_reason: "",
          expires_at: null,
          last_used_at: null,
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
  for (const item of failures) {
    const component = String(item.component || "general").trim();
    const symptom = String(item.symptom || "").trim();
    if (!symptom) continue;

    const fp = fingerprint(`${project}:${component}:${symptom}`);
    if (isRecent("p:" + fp)) continue;

    if (client) {
      try {
        const existing = await client.list("pitfalls", { project, limit: 100 });
        const isDupe = (existing.data || []).some(
          (r) => r.content_fingerprint === fp
        );
        if (isDupe) {
          markRecent("p:" + fp);
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
          recurrence: 1,
          invalid_at: null,
          invalid_reason: "",
          last_occurred_at: now,
        });
        markRecent("p:" + fp);
        pitfallsSaved++;
      } catch (err) {
        // 静默容错，fail-open
      }
    } else {
      markRecent("p:" + fp);
      pitfallsSaved++;
    }
  }

  return { memoriesSaved, pitfallsSaved, skipped: false };
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

    await processDialogueAndHarvest(dialogueText, meta, client);
  } catch (e) {
    // 极致 fail-open：吞掉一切异常，绝不向上抛出
  }
}
