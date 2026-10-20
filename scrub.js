/**
 * scrub.js —— 敏感凭据脱敏公共模块（单一真相源）
 *
 * 设计原则：
 * 1. 全仓库唯一实现，tools.js 与 gateway_harvest.hooks.js 均从此处导入，
 *    彻底消除此前两处重复维护、正则漂移的隐患（审计 P2-1）。
 * 2. 纯函数、零依赖、零副作用，可被中间件/宿主/测试任意引用。
 * 3. 已脱敏的内容不重复替换（幂等），避免 ***REDACTED*** 被二次加工。
 */

const REDACTED = "***REDACTED***";

/** 已包含脱敏占位符则跳过，保证幂等 */
function alreadyRedacted(v) {
  return /\*{2,}REDACTED\*{2,}/i.test(String(v));
}

/**
 * 脱敏一组正则规则
 * @param {string} text 原始文本
 * @returns {string} 脱敏后的文本
 */
export function scrubSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let s = text;

  // ── 1. PEM 私钥块（含 RSA / EC / OPENSSH / PGP）────────────────────
  s = s.replace(
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    REDACTED
  );
  // 只有 BEGIN 没有 END（被截断的日志片段）也一并抹掉
  s = s.replace(/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*$/g, REDACTED);

  // ── 2. AWS Access Key / Session Key ────────────────────────────────
  s = s.replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED);

  // ── 3. OpenAI / Anthropic / 通用 sk- ───────────────────────────────
  s = s.replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "sk-" + REDACTED);

  // ── 4. GitHub Token ────────────────────────────────────────────────
  s = s.replace(/\bgh[pousr]_[a-zA-Z0-9]{8,}\b/g, "ghp_" + REDACTED);

  // ── 5. GitLab Personal Access Token ────────────────────────────────
  s = s.replace(/\bglpat-[a-zA-Z0-9_-]{8,}\b/g, "glpat-" + REDACTED);

  // ── 6. Google API Key (AIza...) ────────────────────────────────────
  s = s.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, REDACTED);

  // ── 7. HuggingFace Token ───────────────────────────────────────────
  s = s.replace(/\bhf_[0-9A-Za-z]{20,}\b/g, "hf_" + REDACTED);

  // ── 8. npm Token ───────────────────────────────────────────────────
  s = s.replace(/\bnpm_[0-9A-Za-z]{20,}\b/g, "npm_" + REDACTED);

  // ── 9. Slack / Discord Bot Token ───────────────────────────────────
  s = s.replace(/\b(xox[baprs]-)[0-9A-Za-z-]{10,}\b/g, "$1" + REDACTED);

  // ── 10. 三段式 JWT ─────────────────────────────────────────────────
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED);

  // ── 11. NoCodeBackend Secret Key（前缀拼接避免被自身规则命中）─────
  s = s.replace(/\bncb_sec_[a-zA-Z0-9_-]{8,}\b/g, "ncb-" + REDACTED);

  // ── 12. Bearer Token ───────────────────────────────────────────────
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9_.-]{8,}\b/gi, "$1" + REDACTED);

  // ── 13. 数据库连接串密码 scheme://user:pass@host ────────────────────
  s = s.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/:\s@]+:)([^@\s]+)(@)/g,
    (m, p1, p2, p3) => (alreadyRedacted(p2) ? m : `${p1}${REDACTED}${p3}`)
  );

  // ── 14. URL / 命令行参数里的凭据 (?token=xxx&api_key=yyy) ───────────
  s = s.replace(
    /([?&](?:token|access_token|api_?key|secret|secret_?key|password|passwd|pwd|auth|sig|signature)=)([^&#\s"']{6,})/gi,
    (m, p1, p2) => (alreadyRedacted(p2) ? m : `${p1}${REDACTED}`)
  );

  // ── 15. 中文口令描述（密钥是 xxx / 密码：yyy）───────────────────────
  s = s.replace(
    /(密码|密钥|口令|token|secret|apikey|api_key)\s*[是为:：=]\s*['"]?([A-Za-z0-9_!@#$%^&*\-+=.~]{6,})['"]?/gi,
    (m, k, v) => (alreadyRedacted(v) ? m : `${k}=${REDACTED}`)
  );

  // ── 16. 键值对形式的密码字段 ───────────────────────────────────────
  s = s.replace(
    /\b(password|passwd|pwd|api_key|apikey|secret_key|secretKey)\s*([:=])\s*(['"]?)([^'"\s,;]+)\3/gi,
    (m, k, eq, q, v) => (alreadyRedacted(v) ? m : `${k}${eq}${q}${REDACTED}${q}`)
  );

  return s;
}

export { REDACTED };
