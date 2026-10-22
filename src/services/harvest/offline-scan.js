/**
 * 模块职责: 离线录制目录扫描与增量提炼 (GatewayConversations 读盘、路径安全守卫、文件收集与离线提炼入库)
 * 依赖: ./scaffolding.js (_diag, stripScaffolding), ./dialog-extract.js (isExplicitUserMemory), ./classify.js, ./extract.js, src/core/state.js, ../../page_actions.js, src/domain/semantic-dedup.js
 * 被依赖: src/services/harvest/index.js, src/services/harvest/harvest-pipeline.js, gateway_harvest.js
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  lookupGatewayHarvest,
  rememberGatewayHarvest,
  recordPendingEvidence,
  DEFAULT_MIN_EVIDENCE,
} from "../../core/state.js";
import { writeCardStatus } from "../../core/status-writer.js";
import { harvestWithOnlineModel } from "./extract.js";
import { classifyDialogueWithOnlineModel } from "./classify.js";
import { semanticFingerprint } from "../../domain/semantic-dedup.js";
import { _diag, stripScaffolding } from "./scaffolding.js";
import { isExplicitUserMemory } from "./dialog-extract.js";

export const GATEWAY_CONV_DIRNAME = "gateway-conversations";
export const NO_CONVERSATIONS_MSG = "未检测到对话录制。请在 Magpie 设置里开启 GatewayConversations（本地录制对话，插件据此提炼记忆）。";
export const PRIVACY_NOTICE = "数据来自 Magpie 的 GatewayConversations 落盘，可在 Magpie 设置里关闭该录制";


export const HARD_FORBIDDEN_PREFIXES = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
];

export const FORBIDDEN_PREFIXES = [
  "/root",
  "/var",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/home",
];

/**
 * 校验路径是否位于 /var 下允许的白名单子域（仅允许 minis, folders, tmp）。
 * 若为 /var 自身或其它未允许子域（如 /var/log），则返回 false。
 */
export function isVarSubdomainAllowed(p) {
  if (!p || typeof p !== "string") return true;
  const norm = p.replace(/\\/g, "/");
  let rest = null;
  if (norm === "/private/var" || norm.startsWith("/private/var/")) {
    rest = norm.slice("/private/var".length);
  } else if (norm === "/var" || norm.startsWith("/var/")) {
    rest = norm.slice("/var".length);
  }
  if (rest === null) return true; // not under /var
  if (rest === "" || rest === "/") return false; // /var 自身禁止
  const sub = rest.replace(/^\/+/, "").split("/")[0];
  return sub === "minis" || sub === "folders" || sub === "tmp";
}

/**
 * 校验路径是否位于 /home/<user> 或 /root 下允许的安全子域。
 * 仅当满足以下之一才允许：
 *   1. 是当前运行用户 os.homedir() 的直接子路径 GatewayConversations（或 gateway-conversations）
 *   2. 是当前运行用户 home 下的 .config/magpie（含子路径）
 * 对其它用户目录（如 /home/otheruser）或未授权深层目录（如 /root/private_secrets、.ssh 等）一律拒绝。
 * 若路径不在 /home 或 /root 域下，返回 true（放行给后续规则判定）。
 */
export function isHomeOrRootAllowed(p, customHome = null) {
  if (!p || typeof p !== "string") return true;
  let norm = p.replace(/\\/g, "/");
  while (norm.length > 1 && norm.endsWith("/")) {
    norm = norm.slice(0, -1);
  }

  const isUnderRoot = norm === "/root" || norm.startsWith("/root/");
  const isUnderHome = norm === "/home" || norm.startsWith("/home/");
  if (!isUnderRoot && !isUnderHome) {
    return true; // 不在 /home 或 /root 域，放行给后续规则判定
  }

  // /home 与 /root 根目录自身一律禁止
  if (norm === "/home" || norm === "/root") {
    return false;
  }

  let userHome = customHome;
  if (!userHome) {
    try {
      userHome = os.homedir();
    } catch (_) {}
  }

  if (!userHome || typeof userHome !== "string") {
    return false;
  }

  userHome = userHome.replace(/\\/g, "/");
  while (userHome.length > 1 && userHome.endsWith("/")) {
    userHome = userHome.slice(0, -1);
  }

  // 必须严格属于当前运行用户的 home 目录
  if (norm === userHome || !norm.startsWith(userHome + "/")) {
    return false;
  }

  const rel = norm.slice(userHome.length + 1);
  if (!rel) return false;

  // 1. 是当前运行用户 home 的直接子路径 GatewayConversations（或 gateway-conversations）
  const directChild = rel.split("/")[0];
  if (/^(?:gateway[-_]?conversations)$/i.test(directChild)) {
    return true;
  }

  // 2. 是当前用户 home 下的 .config/magpie（含子路径）
  if (rel === ".config/magpie" || rel.startsWith(".config/magpie/")) {
    return true;
  }

  // 3. 兼容当前用户主目录下非隐藏/非敏感子路径中的 Magpie 便携模式目录 (.../data/gateway-conversations)
  const segs = rel.split("/");
  const hasHiddenOrSensitive = segs.some(
    (s) => s.startsWith(".") || /^(?:private_secrets|secrets|credentials)$/i.test(s)
  );
  if (!hasHiddenOrSensitive && /(?:^|\/)data\/gateway[-_]?conversations(?:\/|$)/i.test(rel)) {
    return true;
  }

  return false;
}


export function isWhitelistedGatewayDir(normPath) {
  if (!normPath || typeof normPath !== "string") return false;
  const p = normPath.replace(/\\/g, "/");

  // 第一步：严格校验真实父目录与根域是否命中敏感黑名单
  // 1. /var 或 /private/var 下仅允许 minis / folders / tmp 三个子域，其它（如 /var/log）一律拒
  if (!isVarSubdomainAllowed(p)) {
    return false;
  }

  // 2. /home 与 /root 域归属校验：仅允许当前用户 home 下直接子目录 GatewayConversations 或 .config/magpie
  if (!isHomeOrRootAllowed(p)) {
    return false;
  }

  // 3. 检查真实父目录/祖先链是否命中敏感黑名单或敏感子路径
  try {
    let cur = path.resolve(normPath);
    while (cur && cur !== path.dirname(cur)) {
      if (fs.existsSync(cur)) {
        try {
          const realCur = fs.realpathSync(cur).replace(/\\/g, "/");
          // 真实祖先若在 /var 的某个子域下，同样只允许 minis / folders / tmp
          if (realCur.startsWith("/var/") || realCur.startsWith("/private/var/")) {
            if (!isVarSubdomainAllowed(realCur)) {
              return false;
            }
          }
          // 检查真实祖先是否命中 HARD_FORBIDDEN_PREFIXES
          for (const prefix of HARD_FORBIDDEN_PREFIXES) {
            if (realCur === prefix || realCur.startsWith(prefix + "/")) {
              return false;
            }
          }
          // 检查真实祖先是否命中敏感子路径
          const segs = realCur.split(/[\/\\]+/);
          const SENSITIVE_SEGMENTS = new Set([
            ".ssh",
            ".gnupg",
            ".aws",
            ".docker",
            ".kube",
            ".magpie-memory-hub",
          ]);
          for (const s of segs) {
            if (SENSITIVE_SEGMENTS.has(s)) return false;
          }

          // 重构真实目标路径：防止祖先软链接指向 /root 或 /home 越权借道
          const rel = path.relative(cur, path.resolve(normPath));
          const reconstructedReal = (rel ? path.resolve(realCur, rel) : realCur).replace(/\\/g, "/");
          if (!isVarSubdomainAllowed(reconstructedReal)) {
            return false;
          }
          if (!isHomeOrRootAllowed(reconstructedReal)) {
            return false;
          }
          for (const prefix of HARD_FORBIDDEN_PREFIXES) {
            if (reconstructedReal === prefix || reconstructedReal.startsWith(prefix + "/")) {
              return false;
            }
          }
          const recSegs = reconstructedReal.split(/[\/\\]+/);
          for (const s of recSegs) {
            if (SENSITIVE_SEGMENTS.has(s)) return false;
          }
        } catch (_) {}
        break;
      }
      cur = path.dirname(cur);
    }
  } catch (_) {}

  // 第二步：白名单特征匹配
  // 1. Minis 工作目录与 macOS 临时目录
  if (p === "/var/minis" || p.startsWith("/var/minis/") || p === "/private/var/minis" || p.startsWith("/private/var/minis/")) {
    return true;
  }
  if (p === "/var/folders" || p.startsWith("/var/folders/") || p === "/private/var/folders" || p.startsWith("/private/var/folders/")) {
    return true;
  }
  if (p === "/var/tmp" || p.startsWith("/var/tmp/") || p === "/private/var/tmp" || p.startsWith("/private/var/tmp/")) {
    return true;
  }

  // 2. Gateway 对话录制目录特征 (GatewayConversations / gateway-conversations / magpie)
  if (/(?:^|[\/])(gateway[-_]?conversations)(?:[\/]|$)/i.test(p)) {
    return true;
  }
  if (/(?:^|[\/])\.config[\/]magpie(?:[\/]|$)/i.test(p) || /(?:^|[\/])config[\/]magpie(?:[\/]|$)/i.test(p)) {
    return true;
  }

  // 3. 用户显式指定的环境变量目录（必须同样受 /var、/home、/root 与敏感黑名单约束）
  if (process.env.MEMHUB_GATEWAY_CONV_DIR && process.env.MEMHUB_GATEWAY_CONV_DIR.trim()) {
    const envDir = path.resolve(process.env.MEMHUB_GATEWAY_CONV_DIR.trim()).replace(/\\/g, "/");
    if (isVarSubdomainAllowed(envDir) && isHomeOrRootAllowed(envDir)) {
      if (p === envDir || p.startsWith(envDir + "/")) {
        return true;
      }
    }
  }

  return false;
}

export function checkSensitiveSubpaths(norm) {
  if (!norm || typeof norm !== "string") return;
  const segments = norm.split(/[\/\\]+/);
  const SENSITIVE_SEGMENTS = new Set([
    ".ssh",
    ".gnupg",
    ".aws",
    ".docker",
    ".kube",
    ".magpie-memory-hub",
  ]);
  for (const seg of segments) {
    if (SENSITIVE_SEGMENTS.has(seg)) {
      throw new Error(`[SECURITY_BLOCKED] 禁止遍历敏感配置或凭据目录: ${norm}`);
    }
  }

  if (/(?:^|[\/\\])\.config[\/\\]gcloud(?:[\/\\]|$)/.test(norm)) {
    throw new Error(`[SECURITY_BLOCKED] 禁止遍历敏感云凭据目录: ${norm}`);
  }

  let defaultStateDir = null;
  try {
    defaultStateDir = path.resolve(os.homedir(), ".magpie-memory-hub");
  } catch (_) {}
  if (defaultStateDir && (norm === defaultStateDir || norm.startsWith(defaultStateDir + path.sep))) {
    throw new Error(`[SECURITY_BLOCKED] 禁止遍历系统状态目录: ${norm}`);
  }

  if (process.env.MEMHUB_STATE_DIR && process.env.MEMHUB_STATE_DIR.trim()) {
    const envStateDir = path.resolve(process.env.MEMHUB_STATE_DIR.trim());
    if (norm === envStateDir || norm.startsWith(envStateDir + path.sep)) {
      throw new Error(`[SECURITY_BLOCKED] 禁止遍历系统状态目录: ${norm}`);
    }
  }
}

function checkPathForbidden(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return;
  const norm = path.resolve(targetPath);
  const root = path.parse(norm).root;
  if (norm === root) {
    throw new Error(`[SECURITY_BLOCKED] 禁止遍历系统敏感目录或根路径: ${norm}`);
  }

  // 1. 敏感子路径黑名单校验（任何位置一票否决）
  checkSensitiveSubpaths(norm);

  // 2. 硬拦截系统目录
  for (const prefix of HARD_FORBIDDEN_PREFIXES) {
    if (norm === prefix || norm.startsWith(prefix + path.sep)) {
      throw new Error(`[SECURITY_BLOCKED] 禁止遍历系统敏感目录: ${norm}`);
    }
  }

  // 3. /var 根域子域限制（仅允许 minis / folders / tmp，其它如 /var/log 一律拒）
  if (!isVarSubdomainAllowed(norm)) {
    throw new Error(`[SECURITY_BLOCKED] 禁止遍历系统敏感目录: ${norm}`);
  }

  // 4. /home 与 /root 域归属校验（仅允许当前运行用户 home 下的 GatewayConversations 或 .config/magpie）
  if (!isHomeOrRootAllowed(norm)) {
    throw new Error(`[SECURITY_BLOCKED] 禁止遍历系统敏感目录: ${norm}`);
  }

  // 5. /home、/root、/var 系统目录：根目录硬拦，子路径通过白名单放行，未命中白名单则拦截
  if (norm === "/home" || norm === "/root" || norm === "/var" || norm === "/private/var") {
    throw new Error(`[SECURITY_BLOCKED] 禁止遍历系统敏感目录或根路径: ${norm}`);
  }
  if (norm.startsWith("/home" + path.sep) || norm.startsWith("/root" + path.sep) || norm.startsWith("/var" + path.sep) || norm.startsWith("/private/var" + path.sep)) {
    if (!isWhitelistedGatewayDir(norm)) {
      throw new Error(`[SECURITY_BLOCKED] 禁止遍历系统敏感目录: ${norm}`);
    }
  }
}

export function validateGatewayDir(customDir) {
  if (typeof customDir !== "string" || !customDir.trim()) {
    throw new Error("[SECURITY_BLOCKED] 对话录制目录路径非法或为空");
  }

  const rawTrimmed = customDir.trim();

  // 1. 拦截任何含 ".." 段的路径
  const segments = rawTrimmed.split(/[\/\\]+/);
  if (segments.includes("..")) {
    throw new Error(`[SECURITY_BLOCKED] 禁止路径包含 .. 相对跳转: ${rawTrimmed}`);
  }

  // 2. 展开波浪号 ~
  let expanded = rawTrimmed;
  if (expanded === "~" || expanded.startsWith("~" + path.sep) || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }

  const resolved = path.resolve(expanded);

  // 3. 初始校验未解出真实路径前的 resolved
  checkPathForbidden(resolved);

  // 4. 用 fs.realpathSync 解出真实路径后再校验，防软链接绕过（realpath 失败则拒绝）
  let realPath = resolved;
  try {
    const lst = fs.lstatSync(resolved);
    try {
      realPath = fs.realpathSync(resolved);
    } catch (e) {
      throw new Error(`[SECURITY_BLOCKED] 无法解析真实路径 (可能包含损坏的软链接): ${resolved}`);
    }
  } catch (err) {
    if (err.message && err.message.includes("[SECURITY_BLOCKED]")) {
      throw err;
    }
    // 目标路径尚不存在：向上回溯存在的祖先真实路径，防止通过父级软链接绕过
    let cur = path.dirname(resolved);
    while (cur && cur !== path.dirname(cur)) {
      try {
        const curStat = fs.lstatSync(cur);
        if (curStat) {
          try {
            const parentReal = fs.realpathSync(cur);
            // 向上回溯时对每一层祖先的真实路径进行敏感黑名单与 /var 子域检查
            for (const prefix of HARD_FORBIDDEN_PREFIXES) {
              if (parentReal === prefix || parentReal.startsWith(prefix + path.sep)) {
                throw new Error(`[SECURITY_BLOCKED] 禁止遍历系统敏感目录: ${parentReal}`);
              }
            }
            if (parentReal.startsWith("/var" + path.sep) || parentReal.startsWith("/private/var" + path.sep)) {
              if (!isVarSubdomainAllowed(parentReal)) {
                throw new Error(`[SECURITY_BLOCKED] 禁止遍历系统敏感目录: ${parentReal}`);
              }
            }
            checkSensitiveSubpaths(parentReal);

            // 一旦解析出 parentReal 就用它替换 realPath 继续向上
            const rel = path.relative(cur, realPath);
            realPath = rel ? path.resolve(parentReal, rel) : parentReal;
            // 无论是否白名单分支都必须对重构后的 realPath 执行 checkPathForbidden
            checkPathForbidden(realPath);

            cur = parentReal;
          } catch (pe) {
            if (pe.message && pe.message.includes("[SECURITY_BLOCKED]")) {
              throw pe;
            }
            throw new Error(`[SECURITY_BLOCKED] 祖先路径软链接解析失败: ${cur}`);
          }
        }
      } catch (e) {
        if (e.message && e.message.includes("[SECURITY_BLOCKED]")) {
          throw e;
        }
      }
      cur = path.dirname(cur);
    }
  }

  // 对真实路径再次进行前缀与敏感目录校验
  checkPathForbidden(realPath);

  return resolved;
}

export function resolveGatewayDir(customDir, hostDir) {
  let explicitDir = "";
  let effectiveHostDir = "";

  if (customDir && typeof customDir === "object") {
    explicitDir = (typeof customDir.dir === "string" ? customDir.dir : "") || "";
    effectiveHostDir = (typeof customDir.hostDir === "string" ? customDir.hostDir : "")
      || (typeof customDir.hostDirectory === "string" ? customDir.hostDirectory : "")
      || (typeof customDir.directory === "string" ? customDir.directory : "")
      || "";
  } else if (typeof customDir === "string") {
    explicitDir = customDir;
  }

  if (hostDir) {
    if (typeof hostDir === "object") {
      effectiveHostDir = (typeof hostDir.directory === "string" ? hostDir.directory : "")
        || (typeof hostDir.hostDir === "string" ? hostDir.hostDir : "")
        || (typeof hostDir.hostDirectory === "string" ? hostDir.hostDirectory : "")
        || effectiveHostDir;
    } else if (typeof hostDir === "string") {
      effectiveHostDir = hostDir;
    }
  }

  // 1. 显式指定的自定义目录优先（须经严格安全校验）
  if (explicitDir && explicitDir.trim()) {
    return validateGatewayDir(explicitDir.trim());
  }

  // 2. 环境变量配置的目录（须经严格安全校验）
  if (process.env.MEMHUB_GATEWAY_CONV_DIR && process.env.MEMHUB_GATEWAY_CONV_DIR.trim()) {
    return validateGatewayDir(process.env.MEMHUB_GATEWAY_CONV_DIR.trim());
  }

  // 3. 宿主权威传入的 hostDir（兼容 Magpie 便携模式 <exe>/data/gateway-conversations）
  // 严禁放宽既有路径白名单：宿主传入的目录必须强制接受 validateGatewayDir / checkPathForbidden 校验
  let hostConvCandidate = null;
  if (effectiveHostDir && effectiveHostDir.trim()) {
    const rawTrim = effectiveHostDir.trim();
    const base = path.basename(rawTrim).toLowerCase();
    if (base === GATEWAY_CONV_DIRNAME.toLowerCase()) {
      hostConvCandidate = path.resolve(rawTrim);
    } else {
      hostConvCandidate = path.resolve(rawTrim, GATEWAY_CONV_DIRNAME);
    }
    // 强制先进行路径白名单与敏感黑名单校验；非法敏感目录立即抛出 [SECURITY_BLOCKED]，绝不放宽！
    validateGatewayDir(hostConvCandidate);
  }

  const candidates = [];

  // 宿主权威传入的便携模式候选路径置于首位
  if (hostConvCandidate) {
    candidates.push(hostConvCandidate);
  }

  // Bun 宿主启动时的 cwd 就是 settings.Dir()
  try {
    candidates.push(path.resolve(process.cwd(), GATEWAY_CONV_DIRNAME));
  } catch (_) {}

  // XDG_CONFIG_HOME 环境变量（容器中通常为 /config）
  if (process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()) {
    candidates.push(path.resolve(process.env.XDG_CONFIG_HOME.trim(), "magpie", GATEWAY_CONV_DIRNAME));
  }

  // 官方 Docker 容器内的标准路径
  candidates.push(path.resolve("/config/magpie", GATEWAY_CONV_DIRNAME));

  // 本地/沙箱用户目录
  try {
    candidates.push(path.resolve(os.homedir(), ".config", "magpie", GATEWAY_CONV_DIRNAME));
  } catch (_) {}

  // 优先返回首个已经存在且为目录的路径
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
        return c;
      }
    } catch (_) {}
  }

  // 若均不存在，优先使用已通过校验的宿主权威候选路径
  if (hostConvCandidate) {
    return hostConvCandidate;
  }

  // 若宿主未传入，选择最合理的默认路径返回
  if (fs.existsSync("/config/magpie")) {
    return path.resolve("/config/magpie", GATEWAY_CONV_DIRNAME);
  }
  if (process.env.XDG_CONFIG_HOME && fs.existsSync(process.env.XDG_CONFIG_HOME)) {
    return path.resolve(process.env.XDG_CONFIG_HOME, "magpie", GATEWAY_CONV_DIRNAME);
  }
  try {
    return path.resolve(os.homedir(), ".config", "magpie", GATEWAY_CONV_DIRNAME);
  } catch (_) {
    return path.resolve(process.cwd(), GATEWAY_CONV_DIRNAME);
  }
}

/* ================================================================== *
 * 2. 辅助函数与记忆标记
 * ================================================================== */

function sig(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/['"`][^'"`]{0,120}['"`]/g, "<str>")
    .replace(/\b0x[0-9a-fA-F]+\b/g, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\/(?:[\w.-]+\/)+[\w.-]+/g, "<path>")
    .trim()
    .slice(0, 200);
}

/* ================================================================== *
 * 3. 递归文件扫描与解析
 * ================================================================== */

const MAX_SCAN_DEPTH = 3;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function collectConversationFiles(dir, maxDepth = MAX_SCAN_DEPTH) {
  const files = [];
  function walk(current, depth) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink && ent.isSymbolicLink()) {
        continue;
      }
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth) {
          walk(full, depth + 1);
        }
      } else if (ent.isFile()) {
        if (ent.name.endsWith(".jsonl") || ent.name.endsWith(".json")) {
          if (!ent.name.includes(".tmp") && !ent.name.includes(".bad") && !ent.name.endsWith(".lock")) {
            try {
              const st = fs.statSync(full);
              if (st.size <= MAX_FILE_SIZE) {
                files.push(full);
              } else {
                console.warn(`[gateway_harvest] 忽略超过 10MB 的超大文件: ${full} (${st.size} bytes)`);
              }
            } catch (_) {}
          }
        }
      }
    }
  }
  walk(dir, 0);
  return files;
}

function parseTurnsFromFile(filePath) {
  let content = "";
  try {
    const st = fs.statSync(filePath);
    if (st.size > MAX_FILE_SIZE) {
      console.warn(`[gateway_harvest] 忽略超过 10MB 的超大文件: ${filePath} (${st.size} bytes)`);
      return [];
    }
    content = fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return [];
  }
  if (!content.trim()) return [];

  const turns = [];

  // 1. 尝试按 JSON Lines 解析
  const lines = content.split(/\r?\n/);
  let parsedLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && (obj.input || obj.output || obj.Input || obj.Output || obj.agent || obj.Agent)) {
        turns.push(obj);
        parsedLines++;
      }
    } catch (_) {}
  }

  if (turns.length > 0) return turns;

  // 2. 若行解析未命中，尝试作为单个 JSON 文件或数组解析
  try {
    const whole = JSON.parse(content);
    if (Array.isArray(whole)) {
      for (const item of whole) {
        if (item && typeof item === "object") turns.push(item);
      }
    } else if (whole && typeof whole === "object") {
      turns.push(whole);
    }
  } catch (_) {}

  return turns;
}

function extractDialogueText(turn) {
  const parts = [];
  const input = turn.input || turn.Input || [];
  const output = turn.output || turn.Output || [];

  if (Array.isArray(input)) {
    for (const p of input) {
      if (typeof p === "string") {
        parts.push(`[user]: ${p}`);
      } else if (p && typeof p === "object") {
        const text = p.text != null ? p.text : (p.content != null ? p.content : "");
        if (text) parts.push(`[${p.role || "user"}]: ${text}`);
      }
    }
  } else if (typeof input === "string" && input.trim()) {
    parts.push(`[user]: ${input}`);
  }

  if (Array.isArray(output)) {
    for (const p of output) {
      if (typeof p === "string") {
        parts.push(`[assistant]: ${p}`);
      } else if (p && typeof p === "object") {
        const text = p.text != null ? p.text : (p.content != null ? p.content : "");
        if (text) parts.push(`[${p.role || "assistant"}]: ${text}`);
      }
    }
  } else if (typeof output === "string" && output.trim()) {
    parts.push(`[assistant]: ${output}`);
  }

  return stripScaffolding(parts.join("\n"));
}

function offlineTurnKey(turn) {
  const agent = String(turn.agent || turn.Agent || "").trim();
  const session = String(turn.session || turn.Session || "").trim();
  const time = String(turn.time || turn.Time || "").trim();
  const input = turn.input || turn.Input || [];
  const output = turn.output || turn.Output || [];
  const inLen = Array.isArray(input) ? input.length : 1;
  const outFirst = Array.isArray(output) && output[0] && output[0].text ? output[0].text.slice(0, 100) : "";
  return crypto.createHash("sha256")
    .update(`${agent}|${session}|${time}|${inLen}|${outFirst}`)
    .digest("hex");
}

/* ================================================================== *
 * 4. 增量扫描与提炼入库主函数
 * ================================================================== */

/**
 * 执行增量扫描与提炼。
 *
 * @param {object} args 参数（支持 dir, force_rescan）
 * @param {object} context 宿主上下文（包含 client, cfg, saveMemory, pitfallSave, signal 等）
 */
// isTestMode 已下沉到 src/core/env.js（解循环依赖）
import { isTestMode } from "../../core/env.js";
export { isTestMode };


export async function harvestGateway(args, context) {
  const options = args || {};
  const ctx = context || {};
  const client = ctx._client || ctx.client;
  const cfg = ctx._cfg || ctx.cfg || {};
  const saveMemory = ctx.saveMemory;
  const pitfallSave = ctx.pitfallSave;
  const signal = ctx.signal;

  // ARCH-4: 从 host context / input / options / cfg 中全链路提取宿主权威 directory
  const hostDir = (ctx._ctx && typeof ctx._ctx.directory === "string" && ctx._ctx.directory)
    || (ctx.directory && typeof ctx.directory === "string" && ctx.directory)
    || (ctx._input && typeof ctx._input.directory === "string" && ctx._input.directory)
    || (ctx.input && typeof ctx.input.directory === "string" && ctx.input.directory)
    || (cfg && (typeof cfg.hostDirectory === "string" ? cfg.hostDirectory : (typeof cfg.directory === "string" ? cfg.directory : "")))
    || (options && (typeof options.hostDirectory === "string" ? options.hostDirectory : (typeof options.hostDir === "string" ? options.hostDir : "")))
    || "";

  const convDir = resolveGatewayDir(options.dir || cfg.gatewayConvDir, hostDir);

  const targetProject = String(options.project || (cfg && cfg.project) || "global").trim();
  if (targetProject === "global" && isTestMode()) {
    throw new Error("[SECURITY_BLOCKED] 测试环境下严禁向 global 命名空间执行提炼写入！必须指定隔离的 project");
  }

  // 1. 检查录制目录是否存在
  let dirExists = false;
  try {
    dirExists = fs.existsSync(convDir) && fs.statSync(convDir).isDirectory();
  } catch (_) {
    dirExists = false;
  }

  if (!dirExists) {
    try {
      writeCardStatus("gateway", {
        at: Date.now(),
        op: "harvest_gateway",
        ok: true,
        title: "未检测到对话录制",
        lines: [
          NO_CONVERSATIONS_MSG,
          `检查路径：${convDir}`,
        ],
      });
    } catch (_) {}

    return {
      success: true,
      has_conversations: false,
      message: NO_CONVERSATIONS_MSG,
      data_source: "Magpie GatewayConversations",
      privacy_notice: PRIVACY_NOTICE,
      directory: convDir,
      turns_scanned: 0,
      turns_processed: 0,
      memories_saved: 0,
      pitfalls_saved: 0,
    };
  }

  // 2. 收集目录下所有对话文件
  const files = collectConversationFiles(convDir);
  if (files.length === 0) {
    try {
      writeCardStatus("gateway", {
        at: Date.now(),
        op: "harvest_gateway",
        ok: true,
        title: "未检测到对话录制",
        lines: [
          NO_CONVERSATIONS_MSG,
          `已扫描目录：${convDir}（暂无录制文件）`,
        ],
      });
    } catch (_) {}

    return {
      success: true,
      has_conversations: false,
      message: NO_CONVERSATIONS_MSG,
      data_source: "Magpie GatewayConversations",
      privacy_notice: PRIVACY_NOTICE,
      directory: convDir,
      turns_scanned: 0,
      turns_processed: 0,
      memories_saved: 0,
      pitfalls_saved: 0,
    };
  }

  // 3. 读取本地增量状态
  const state = (options.force_rescan ? {} : lookupGatewayHarvest()) || {};
  const fileStates = state.files || {};
  const processedFpSet = new Set(Array.isArray(state.processed_fingerprints) ? state.processed_fingerprints : []);

  let turnsScanned = 0;
  let turnsProcessed = 0;
  let memoriesSaved = 0;
  let pitfallsSaved = 0;
  let aborted = false;

  // 按修改时间升序排列（从早到晚处理）
  files.sort((a, b) => {
    try {
      return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
    } catch (_) {
      return 0;
    }
  });

  const updatedFileStates = Object.assign({}, fileStates);

  for (const filePath of files) {
    if (signal && signal.aborted) {
      aborted = true;
      break;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      continue;
    }

    const prev = fileStates[filePath];
    // 增量检查：大小与修改时间完全一致时直接跳过
    if (!options.force_rescan && prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
      continue;
    }

    const turns = parseTurnsFromFile(filePath);
    turnsScanned += turns.length;

    let processedInThisFile = 0;
    let turnIndex = 0;

    let fileComplete = true;
    for (const turn of turns) {
      if (signal && signal.aborted) {
        aborted = true;
        fileComplete = false;
        break;
      }

      turnIndex++;
      const sessId = String(turn.session || turn.Session || turn.session_id || "").trim();
      /* 来源可追溯性（空值语义说明）：
       * 录制文件通常 100% 具备 session（Magpie 无会话头默认不录制）。
       * 但若解析异常或外部构造数据无 session，则 source_session 置为 null（严禁伪造）。
       * source_turn 对应录制文件行号/轮次序号（从 1 起始）。
       */
      const sourceSession = sessId ? sessId.slice(0, 128) : null;
      const sourceTurn = (typeof turn.turn === "number" && turn.turn >= 1) ? Math.floor(turn.turn) : turnIndex;

      const fp = offlineTurnKey(turn);
      if (!options.force_rescan && processedFpSet.has(fp)) {
        continue;
      }

      const agent = String(turn.agent || turn.Agent || "").trim() || "gateway";
      const dialogueText = extractDialogueText(turn);
      if (!dialogueText || dialogueText.length < 15) {
        processedFpSet.add(fp);
        continue;
      }

      // v6.30.0: 无价值短路（< 60 字符且无技术信号直接跳过，零模型调用前置拦截）
      if (!isExplicitUserMemory(dialogueText)) {
        const _probe = String(dialogueText).slice(0, 400);
        const _hasTechSignalCI = /[a-z_]{2,}\.[a-z]{2,}|[\\/][\w.-]+|```|\b(error|报错|异常|配置|端口|bug|fix|deploy|api|sql|cors|token|key|安装|依赖|版本|数据库|架构|选型|规范|偏好|记住|踩坑)\b/i.test(_probe);
        const _hasTechSignalCS = /[A-Z][A-Z0-9_]{2,}/.test(_probe);
        if (dialogueText.length < 60 && !_hasTechSignalCI && !_hasTechSignalCS) {
          processedFpSet.add(fp);
          turnsProcessed++;
          processedInThisFile++;
          continue;
        }
      }

      // 1. 分类模型快速过滤（若用户配置）
      try {
        const classRes = await classifyDialogueWithOnlineModel(dialogueText, {
          ...cfg,
          ...options,
        });
        if (classRes && !classRes.shouldHarvest) {
          _diag("offline_classify_negative", `score=${classRes.score}`);
          processedFpSet.add(fp);
          turnsProcessed++;
          processedInThisFile++;
          continue;
        }
      } catch (_) {
        // fail-open
      }

      // 双轨制：用户显式知识沉淀指令穿透门禁直接入库
      const isExplicit = isExplicitUserMemory(dialogueText);
      // 门槛按内容的重复特性区分（对齐 Headroom traffic_learner 设计哲学）：
      // - 踩坑 / 命令重试：属于重复出现的报错模式，保留门禁（默认 3 次才落盘）
      // - 事实 / 偏好 / 决策 / 环境画像：低频高价值知识（通常只陈述一次），门槛默认为 1（不设门禁直接入库）
      const minEvidencePitfall = options.min_evidence_pitfall !== undefined
        ? Number(options.min_evidence_pitfall)
        : (options.min_evidence !== undefined
          ? Number(options.min_evidence)
          : (cfg.min_evidence !== undefined ? Number(cfg.min_evidence) : DEFAULT_MIN_EVIDENCE));

      const minEvidenceMemory = options.min_evidence_memory !== undefined
        ? Number(options.min_evidence_memory)
        : 1;

      // 提炼抽取：与网关实时钩子保持一致，优先采用在线大模型提炼；未配置时安全跳过
      let failures = [];
      let facts = [];
      let decisions = [];

      const extractModel = String(options.extract_model || options.harvest_model || (cfg && (cfg.extract_model || cfg.harvest_model)) || "").trim();
      if (extractModel && extractModel !== "off" && extractModel !== "none") {
        try {
          const onlineRes = await harvestWithOnlineModel(dialogueText, {
            ...cfg,
            ...options,
            extract_model: extractModel,
          });
          if (onlineRes !== null) {
            for (const m of onlineRes.memories) {
              if (m.category === "decision") decisions.push(m);
              else facts.push(m);
            }
            failures = onlineRes.pitfalls;
          } else {
            fileComplete = false;
            _diag("harvest_gateway_unavailable", "在线提炼模型服务异常，安全跳过该轮录制扫描");
            continue;
          }
        } catch (err) {
          _diag("harvest_gateway_err", (err && err.message) || String(err));
        }
      } else {
        fileComplete = false;
        _diag("harvest_gateway_skipped", "未配置提炼模型 (extract_model 为空)，安全跳过录制扫描");
      }

      // 写入 memories（事实 + 架构决策）
      // 关键：事实与架构决策是低频高价值知识（通常只陈述一次），门槛默认为 1（直接入库）
      if (typeof saveMemory === "function") {
        for (const item of facts.concat(decisions)) {
          if (signal && signal.aborted) { aborted = true; break; }

          const mFp = semanticFingerprint(targetProject, item.category, item.title, item.content, item.tags);
          if (!isExplicit && minEvidenceMemory > 1) {
            const pendingRes = recordPendingEvidence(`m:${targetProject}:${mFp}`, {
              ...item,
              project: targetProject,
              client: agent,
            }, {
              kind: "memory",
              minEvidence: minEvidenceMemory,
              turnKey: fp,
            });
            if (!pendingRes.shouldGraduate) {
              continue;
            }
          }

          try {
            const res = await saveMemory(client, cfg, {
              project: targetProject,
              category: item.category,
              scope_level: item.scope_level || "project",
              client: agent,
              origin: "harvest",
              title: item.title,
              content: item.content,
              tags: item.tags,
              related_entities: item.related_entities ? String(item.related_entities).trim() : "",
              confidence: item.confidence,
              source_session: sourceSession,
              source_turn: sourceTurn,
            }, { agent, session: sourceSession, turn: sourceTurn, _ctx: { agent, session: sourceSession, turn: sourceTurn } });
            if (res && res.action !== "NOOP") {
              memoriesSaved++;
            }
          } catch (e) {
            console.error("[memory-hub] harvest saveMemory error:", (e && e.message) || e);
          }
        }
      }

      // 写入 pitfalls（踩坑与失败规避）
      if (typeof pitfallSave === "function") {
        for (const p of failures) {
          if (signal && signal.aborted) { aborted = true; break; }

          const pFp = p.content_fingerprint || semanticFingerprint(targetProject, "pitfall", p.component, p.symptom);
          let recurrence = 1;

          // P0 证据累计门禁（显式指令直接穿透；同一轮次通过 turnKey 去重）
          if (!isExplicit && minEvidencePitfall > 1) {
            const pendingRes = recordPendingEvidence(`p:${targetProject}:${pFp}`, {
              ...p,
              project: targetProject,
              client: agent,
            }, {
              kind: "pitfall",
              minEvidence: minEvidencePitfall,
              turnKey: fp,
            });
            if (!pendingRes.shouldGraduate) {
              continue; // 未达到门禁累计次数，仅在 pending 计数，不落盘
            }
            recurrence = pendingRes.count;
          }

          try {
            const resRaw = await pitfallSave(client, cfg, {
              project: targetProject,
              client: agent,
              component: p.component || "auto",
              symptom: p.symptom,
              root_cause: p.root_cause ? String(p.root_cause).trim() : "",
              solution: p.solution,
              severity: p.severity || "medium",
              error_type: p.error_type || "general",
              tags: p.tags,
              related_entities: p.related_entities ? String(p.related_entities).trim() : "",
              content_fingerprint: pFp,
              recurrence,
              source_session: sourceSession,
              source_turn: sourceTurn,
            }, { agent, session: sourceSession, turn: sourceTurn, _ctx: { agent, session: sourceSession, turn: sourceTurn } });
            let res = resRaw;
            if (typeof resRaw === "string") {
              try { res = JSON.parse(resRaw); } catch (_) {}
            }
            if (res && res.action !== "NOOP") {
              pitfallsSaved++;
            }
          } catch (e) {
            console.error("[memory-hub] harvest pitfallSave error:", (e && e.message) || e);
          }
        }
      }

      processedFpSet.add(fp);
      turnsProcessed++;
      processedInThisFile++;
    }

    // 记录该文件处理进度（仅当整文件完整扫描且未被中断时才记录增量状态）
    if (!aborted && fileComplete) {
      updatedFileStates[filePath] = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        turns_count: turns.length,
        processed_at: Date.now(),
      };
    }

    if (aborted) break;
  }

  // 4. 持久化增量状态（受限队列，最多保留 1000 个 turn 指纹）
  const allFps = Array.from(processedFpSet);
  const boundedFps = allFps.slice(Math.max(0, allFps.length - 1000));
  rememberGatewayHarvest({
    last_harvest_at: Date.now(),
    files: updatedFileStates,
    processed_fingerprints: boundedFps,
  });

  // 5. 更新卡片状态
  try {
    writeCardStatus("gateway", {
      at: Date.now(),
      op: "harvest_gateway",
      ok: true,
      title: aborted ? "对话提炼已中断（已记录进度）" : "对话提炼完成",
      lines: [
        `已扫描对话轮次：${turnsScanned}，本次新增处理：${turnsProcessed}`,
        `提炼记忆已入库：${memoriesSaved} 条事实/决策，${pitfallsSaved} 条踩坑经验`,
        `数据来源：Magpie 本地录制（${convDir}）`,
      ],
    });
  } catch (_) {}

  return {
    success: true,
    has_conversations: true,
    aborted,
    message: aborted
      ? "扫描在超时前安全中断并已保存进度，下次扫描将继续处理剩余对话。"
      : `已完成扫描。本次处理 ${turnsProcessed} 轮对话，提炼入库 ${memoriesSaved} 条记忆与 ${pitfallsSaved} 条踩坑经验。`,
    data_source: "Magpie GatewayConversations",
    privacy_notice: PRIVACY_NOTICE,
    directory: convDir,
    turns_scanned: turnsScanned,
    turns_processed: turnsProcessed,
    memories_saved: memoriesSaved,
    pitfalls_saved: pitfallsSaved,
  };
}
