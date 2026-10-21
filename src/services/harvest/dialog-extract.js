/**
 * 模块职责: 对话文本与用户输入抽取、协议归一化、JSON 提取与显式记忆意图判定
 * 依赖: ./scaffolding.js (stripScaffolding)
 * 被依赖: src/services/harvest/*, gateway_harvest.js, gateway_harvest.hooks.js
 */

import { stripScaffolding } from "./scaffolding.js";

/** 双轨制：判定是否为用户显式意图沉淀的记忆/避坑指令（穿透门禁） */
export function isExplicitUserMemory(text) {
  if (!text || typeof text !== "string") return false;
  // 若包含角色标签，严格限定在用户发言（[user]: ...）部分检测，绝不把模型回复的解释性「注意：」当成用户意图
  let target = text;
  if (text.includes("[user]:") || text.includes("[assistant]:")) {
    const userParts = [];
    const blocks = text.split(/(?=\[(?:user|assistant|model|system)\]:)/i);
    for (const b of blocks) {
      if (/^\s*\[user\]:/i.test(b)) {
        userParts.push(b.replace(/^\s*\[user\]:\s*/i, ""));
      }
    }
    target = userParts.join("\n");
  }
  if (!target) return false;

  // 必须是显式记忆/避坑指令（严禁把通用的「注意：」「规则：」当作显式意图）
  return /(?:^|\n|[。！？；：!?;:\n]\s*)(?:记下来|记住|存入记忆|记入记忆|记入避坑|记录避坑|避坑|备忘|必须记住|一定要记|务必遵守|务必记住|mark|remember)[:：,，\s]/i.test(target) ||
         /(?:^|\n|[。！？；：!?;:\n]\s*)(?:避坑指南|踩坑记录|避坑备忘)[:：]/i.test(target);
}

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

export function buildDialogueText(body, reply, queryFallback = "") {
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
  // ARCH-3: 当从请求体中无法提取有效用户输入时，使用 GatewayContext 注入的纯净 ctx.query 进行兜底
  if (!userText && queryFallback) {
    let fallbackText = "";
    if (typeof queryFallback === "string") {
      fallbackText = queryFallback.trim();
    } else if (queryFallback && typeof queryFallback === "object") {
      fallbackText = String(
        queryFallback.query ||
        (queryFallback.state && queryFallback.state.query) ||
        ""
      ).trim();
    }
    if (fallbackText) {
      userText = `[user]: ${fallbackText}`;
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
