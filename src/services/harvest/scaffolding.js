/**
 * 模块职责: 脚手架与模板提示词过滤脱敏，提供 SCAFFOLDING_PATTERNS 与 stripScaffolding；提供统一的 _diag 诊断日志
 * 依赖: 无外部依赖
 * 被依赖: src/services/harvest/*, gateway_harvest.js, gateway_harvest.hooks.js
 */
import { logDebug } from "../../core/logger.js";

var _diagLogged = {};
export function _diag(tag, msg) {
  if (_diagLogged[tag]) return;
  _diagLogged[tag] = 1;
  try { logDebug("[memory-hub][diag] " + tag + ": " + String(msg).slice(0, 300)); } catch (_) {}
}

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
  /\[Persistent Memory Context[\s\S]*?(?=\n\n|\n\[user\]|$)/gi,
  /\[Memory Instruction[\s\S]*?(?=\n\n|\n\[user\]|$)/gi,
  /\[Memory Check[^\n\]]*\][\s\S]*?(?=\n\n|\n\[user\]|$)/gi,
  /\[Memory Agent Guide[\s\S]*?(?=\n\n|\n\[user\]|$)/gi,
  /\[Memory Context\][\s\S]*?(?=\n\n|\n\[user\]|$)/gi,
  /---\s*Context from the delegating agent\s*---[\s\S]*?(?:\n\n|$)/gi,
];

export function stripScaffolding(text) {
  if (!text) return "";
  let s = String(text);
  for (const pat of SCAFFOLDING_PATTERNS) {
    s = s.replace(pat, "");
  }
  return s.trim();
}
