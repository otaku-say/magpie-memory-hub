/**
 * gateway_harvest.js —— Magpie 网关对话录制（GatewayConversations）读盘与增量提炼
 * ==============================================================================
 *
 * 【隐私与数据来源说明】
 * 1. 数据来源：
 *    本模块读取的数据来自 Magpie 内置的网关对话录制功能（GatewayConversations）。
 * 2. 为什么会存在这些数据：
 *    当用户在 Magpie 中开启了 GatewayConversations（该功能在 Magpie 本地为 opt-in，
 *    默认 false），Magpie 网关会在每次对话结束后将对话轮次（GatewayTurn，含 Agent、
 *    Session、Time、Model、Input、Output 等）落盘到持久卷的 gateway-conversations 目录。
 * 3. 如何关闭：
 *    用户可在 Magpie 设置界面关闭 GatewayConversations 选项，或通过命令行运行
 *    `magpie settings set gateway_conversations false`。关闭后 Magpie 将停止落盘；
 *    已落盘的历史文件可在 Magpie 界面中清理，或直接删除 gateway-conversations 目录。
 * 4. 隐私保护保证：
 *    - 绝不将任何对话原始文本直接存入外部或共享数据库。
 *    - 仅对对话进行规则启发式提炼，提取结构化的环境事实、架构决策与踩坑故障解法。
 *    - 提炼过程纯本地运行，不调用任何云端外部模型。
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
} from "./local_state.js";
import { writeCardStatus } from "./page_actions.js";

export const GATEWAY_CONV_DIRNAME = "gateway-conversations";
export const NO_CONVERSATIONS_MSG = "未检测到对话录制。请在 Magpie 设置里开启 GatewayConversations（本地录制对话，插件据此提炼记忆）。";
export const PRIVACY_NOTICE = "数据来自 Magpie 的 GatewayConversations 落盘，可在 Magpie 设置里关闭该录制";

/* ================================================================== *
 * 1. 对话目录探测
 * ================================================================== */

/**
 * 确定 GatewayConversations 存储目录。
 * 优先级：
 *   1. 显式传入的 options.dir
 *   2. 环境变量 MEMHUB_GATEWAY_CONV_DIR
 *   3. 运行时 cwd 下的 gateway-conversations（Bun 宿主 cwd 为 settings.Dir()）
 *   4. XDG_CONFIG_HOME/magpie/gateway-conversations
 *   5. /config/magpie/gateway-conversations（Docker 容器持久卷官方标准路径）
 *   6. ~/.config/magpie/gateway-conversations（宿主机/本地安装默认路径）
 */
export function resolveGatewayDir(customDir) {
  if (customDir && typeof customDir === "string" && customDir.trim()) {
    return path.resolve(customDir.trim());
  }
  if (process.env.MEMHUB_GATEWAY_CONV_DIR && process.env.MEMHUB_GATEWAY_CONV_DIR.trim()) {
    return path.resolve(process.env.MEMHUB_GATEWAY_CONV_DIR.trim());
  }

  const candidates = [];

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

  // 若均不存在，选择最合理的默认路径返回
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
 * 2. 启发式规则提炼引擎（纯 JS 实现，零外部依赖，零云端模型调用）
 * ================================================================== */

// 失败特征（报错原文 / 明确失败词 / HTTP 异常等）
const FAIL_PATTERNS = [
  /\b(?:Traceback \(most recent call last\)|ModuleNotFoundError|ImportError|SyntaxError|TypeError|ValueError|AttributeError|KeyError|IndexError|NameError)\b[^\n]*/i,
  /\b(?:command not found|No such file or directory|Permission denied|Address already in use|connection refused|timed out)\b[^\n]*/i,
  /\b(?:ERROR|FATAL|FAILED|FAIL|Error:)\b[^\n]{0,120}/i,
  /\bexit code\s*(?!0\b)\d+\b[^\n]*/i,
  /\bHTTP[/ ]?\d*[ -]?(?:4\d\d|5\d\d)\b[^\n]*/i,
];

// 成功特征（真正奏效之后出现的信号）
const OK_PATTERNS = [
  /\b(?:success|succeeded|passed|PASS|OK|done|fixed|resolved|works? now|green)\b[^\n]{0,80}/i,
  /\bexit code\s*0\b[^\n]*/i,
  /\b\d+\s+(?:passed|passing)\b[^\n]*/i,
];

const GENERIC_PRONOUNS = new Set([
  "它", "这个", "那个", "某个", "这里", "那里", "代码", "文件", "系统",
  "脚本", "方法", "方案", "命令", "库", "框架", "技术", "工具",
  "this", "that", "it", "something", "tool", "file"
]);

const NOISE_PATTERNS = [
  /^\s*(好的|明白|收到|嗯|谢谢|你好|ok|okay|sure|thanks|got it)\s*[。.!！]?$/i,
  /^\s*(正在|刚刚|已经)(执行|运行|处理|加载)/,
];

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

  // 必须是显式前缀指令（行首或句首标点引出的记忆/避坑意图）
  return /(?:^|\n|[。！？；：!?;:\n]\s*)(?:记下来|记住|避坑|备忘|必须记住|一定要记|务必遵守|mark|remember)[:：]/i.test(target) ||
         /(?:^|\n|[。！？；：!?;:\n]\s*)(?:注意|规则|规范要求)[:：]/i.test(target);
}

/** Levenshtein 动态规划编辑距离计算 */
export function levenshteinDistance(s1, s2) {
  const str1 = String(s1 || "");
  const str2 = String(s2 || "");
  const m = str1.length;
  const n = str2.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/** 通用排查/观察工具黑名单（Headroom :382-421） */
export const GENERIC_NOISE_TOOLS = new Set([
  "cat", "grep", "rg", "awk", "sed", "head", "tail", "sort", "uniq",
  "wc", "xargs", "find", "echo", "true", "false", "test", "more", "less"
]);

/** 提取命令行的首个可执行二进制程序名 */
export function extractExecutable(cmdLine) {
  if (!cmdLine || typeof cmdLine !== "string") return "";
  let clean = cmdLine.trim().replace(/^[$#>]\s*/, "");
  clean = clean.replace(/^(?:sudo|time|nohup|exec|env)\s+/i, "");
  const m = clean.match(/^([a-zA-Z0-9_.-]+)/);
  if (!m) return "";
  const token = m[1].replace(/\\/g, "/");
  return path.basename(token).toLowerCase();
}

/** 判定是否为通用排查命令调用（只读/检查用，绝不可当作故障或解法） */
export function isGenericToolInvocation(line) {
  const bin = extractExecutable(line);
  return GENERIC_NOISE_TOOLS.has(bin);
}

/** 判定一行文本是否具备命令行调用的外观 */
export function isLikelyCommandLine(line) {
  const s = String(line || "").trim();
  if (/^[$#>]\s+[a-zA-Z0-9_.-]+/.test(s)) return true;
  const bin = extractExecutable(s);
  if (!bin) return false;
  const commonBins = new Set([
    "npm", "npx", "pnpm", "yarn", "pip", "pip3", "python", "python3", "uv",
    "cargo", "gem", "brew", "git", "curl", "wget", "docker", "kill", "killall",
    "apt", "apt-get", "systemctl", "service", "pytest", "node", "make", "bash",
    "sh", "source", "chmod", "chown", "mv", "cp", "rm", "mkdir", "cat", "grep",
    "rg", "awk", "sed", "head", "tail", "sort", "uniq", "wc", "xargs", "find"
  ]);
  return commonBins.has(bin);
}

export function normalizeCommandArgs(cmd) {
  return String(cmd || "")
    .trim()
    .replace(/^[$#>]\s*/, "")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter((tok) => tok && !tok.startsWith("-"));
}

export function haveSubstantiveArgsOverlap(cmd1, cmd2) {
  const tokens1 = normalizeCommandArgs(cmd1).slice(1);
  const tokens2 = normalizeCommandArgs(cmd2).slice(1);
  const set2 = new Set(tokens2.map((t) => t.toLowerCase()));
  for (const t of tokens1) {
    if (t.length >= 3 && set2.has(t.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/** Headroom :382-421 命令重试配对校验 */
export function isCommandRetryCompatible(failedCmd, solutionCmd, errorType = "general") {
  const binA = extractExecutable(failedCmd);
  const binB = extractExecutable(solutionCmd);
  if (!binA || !binB) return true;

  // 1. 通用噪音工具不可作为重试对
  if (GENERIC_NOISE_TOOLS.has(binA) || GENERIC_NOISE_TOOLS.has(binB)) {
    return false;
  }

  // 2. 同二进制情况
  if (binA === binB) {
    const s1 = String(failedCmd).trim();
    const s2 = String(solutionCmd).trim();
    const maxLen = Math.max(s1.length, s2.length);
    const editDist = levenshteinDistance(s1, s2);
    const normDist = maxLen > 0 ? editDist / maxLen : 0;
    return normDist <= 0.40 || haveSubstantiveArgsOverlap(s1, s2);
  }

  // 3. 异二进制情况 (binA !== binB)
  const allowedCrossBins = {
    missing_dependency: new Set(["pip", "pip3", "npm", "pnpm", "yarn", "cargo", "brew", "apt", "apt-get", "uv"]),
    missing_command: new Set(["apt", "apt-get", "brew", "npm", "pip", "cargo", "uv"]),
    port_conflict: new Set(["kill", "killall", "fuser"]),
    permission: new Set(["chmod", "chown", "sudo"]),
    missing_path: new Set(["mkdir", "touch", "cp", "mv", "ln"]),
  };

  const validTargetBins = allowedCrossBins[errorType];
  if (validTargetBins && validTargetBins.has(binB)) {
    return true;
  }

  return false;
}

/** 向上回溯寻找引发报错的命令行 */
function findPrecedingCommand(rawLines, atIndex) {
  for (let j = atIndex; j >= Math.max(0, atIndex - 3); j--) {
    const l = (rawLines[j] || "").trim();
    if (isLikelyCommandLine(l)) {
      return l;
    }
  }
  return null;
}

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

/** 剥离 Markdown 代码块（``` 与 ~~~ 围栏） */
export function stripCodeBlocks(text) {
  if (!text) return "";
  return String(text)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "");
}

/** 剥离行内代码 `...`（用于检测关键字是否仅处于源码引用中） */
export function stripInlineCode(text) {
  if (!text) return "";
  return String(text).replace(/`[^`\r\n]+`/g, "");
}

function cleanDialogueText(text) {
  if (!text) return "";
  const noAnsi = String(text).replace(/\x1b\[[0-9;]*m/g, "");
  // 抽取前先去掉 Markdown 代码块围栏，避免源码被当成日志/故障
  return stripCodeBlocks(noAnsi).trim();
}

/** 判定是否为源码语法行、配置行或属性行噪音 */
function isCodeOrSyntaxNoise(line) {
  const s = String(line || "").trim();
  if (!s) return true;
  // 正则定义行，如 /.../i, 或 /\b(?:ERROR...)/
  if (/(?:^\/|\/[gimsuy]*\s*,?$)/.test(s) && (s.includes("\\b") || s.includes("(?i)"))) return true;
  // 编程语言语句或声明
  if (/^(?:const|let|var|function|return|import|export|class|def|fn|struct|interface|type)\b/.test(s)) return true;
  // Git diff 行，如 - var done: bool = false; 或 + var done: ...
  if (/^[+-]\s*(?:var|const|let|function|return|if|else|bool|int|string)\b/.test(s)) return true;
  // JSON/JS 属性键值行，如 "symptom": "...", 或 "solution": "..."
  if (/^["']?[\w.-]+["']?\s*:\s*["'<]/.test(s)) return true;
  // 结尾为分号的代码行且包含等号或函数调用
  if (/;\s*$/.test(s) && (s.includes("=") || s.includes("(") || s.includes("{"))) return true;
  return false;
}

// 处置动作命令特征（高置信度操作指令）
const ACTION_CMD_RE = /(?:^|[;&|`\s])(?:sudo\s+)?(?:apt|apt-get|npm|npx|pnpm|yarn|pip|pip3|python3?|uv|cargo|gem|brew|git|export|source|\.|mv|cp|rm|mkdir|chmod|chown|systemctl|service|curl|wget|docker|kill|killall)\s+[^\n]{2,120}/i;

// 明确自然语言修复/处置动作语义
const FIX_DESC_RE = /(?:(?:建议|请|必须|统一|改用|已)?(?:通过|采用|使用|执行|运行|改用|安装|配置|调整|更新|升级|修复|修改|重新)\s*[^\n]{2,80}?(?:解决|修复|搞定|奏效|恢复|生效|成功|pass)|(?:解决(?:方法|方案|办法)?|修复(?:方法|方案|办法)?|处置(?:方法|方案)?|应对措施|workaround)[：:\s]+[^\n]{3,120}|(?:已|后续)?(?:通过|改用|切换到|重新安装|修复为|添加|配置)\s*[^\n]{3,120}|(?:fix(?:ed)?|solution|resolved?)\s*(?:by|via|with|using|to)?[：:\s]+[^\n]{3,120})/i;

function isPureStatusOrNoise(line) {
  const s = String(line || "").trim();
  if (isCodeOrSyntaxNoise(s)) return true;
  // 纯退出码或测试通过计数行
  if (/^(?:exit code\s*0|\d+\s+passed|success|ok|passed|done|green)[.!]?$/i.test(s)) return true;
  if (/^\d+\s+passed\s+in\s+[\d.]+s/i.test(s)) return true;
  return false;
}

function isDialogueNoise(text) {
  const s = String(text || "").trim();
  if (s.length < 10) return true;
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every((l) => NOISE_PATTERNS.some((p) => p.test(l)))) {
    return true;
  }
  return false;
}

function isValidMemoryCandidate(cand) {
  const title = String(cand.title || "").trim();
  const content = String(cand.content || "").trim();
  if (title.length < 4 || title.length > 60) return false;
  if (content.length < 12 || content.length > 500) return false;
  if (NOISE_PATTERNS.some((p) => p.test(content))) return false;
  return true;
}

/** 失败学习：提取「失败现象 → 后续奏效解法」配对 */
export function mineFailures(text) {
  const cleaned = cleanDialogueText(text);
  if (isDialogueNoise(cleaned)) return [];

  const rawLines = cleaned.split(/\r?\n/);
  const fails = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line || line.length < 5) continue;
    if (isCodeOrSyntaxNoise(line)) continue;
    // 排除通用排查命令调用（cat/grep/rg 等绝不是故障本身）
    if (isGenericToolInvocation(line)) continue;

    // 剔除行内 code 后若不再匹配，说明关键字完全在行内代码中（例如 `fail(error.AccessDenied)`）
    const lineWithoutInline = stripInlineCode(line).trim();

    for (const pat of FAIL_PATTERNS) {
      const m = pat.exec(line);
      if (m) {
        // 如果去除行内代码后不再匹配，且原匹配含代码特征（括号、点号等），判定为源码引用，剔除
        if (!pat.test(lineWithoutInline) && (m[0].includes("(") || m[0].includes(")") || m[0].includes("."))) {
          continue;
        }
        // 排除代码函数调用 fail(
        if (/\bfail\s*\(/i.test(line)) {
          continue;
        }
        fails.push({ at: i, raw: m[0], symptom: sig(m[0]) });
        break;
      }
    }
  }

  const out = [];
  const seen = new Set();

  for (const f of fails) {
    const window = rawLines.slice(f.at + 1, f.at + 60);
    const failedCmd = findPrecedingCommand(rawLines, f.at);

    // 首先检查后续窗口中是否有成功/解决的确认信号
    let hasOkSignal = false;
    for (const l of window) {
      for (const pat of OK_PATTERNS) {
        if (pat.test(l)) {
          hasOkSignal = true;
          break;
        }
      }
      if (hasOkSignal) break;
    }

    // 寻找真正的处置动作或解法说明（宁可不报，也不要报错）
    let solutionLine = null;
    for (const l of window) {
      const trimmed = l.trim();
      if (!trimmed || isPureStatusOrNoise(trimmed)) continue;
      // 排除通用排查工具（cat/grep/rg 等只读/分析指令绝不是解法）
      if (isGenericToolInvocation(trimmed)) continue;

      if (ACTION_CMD_RE.test(trimmed) || FIX_DESC_RE.test(trimmed)) {
        // 命令重试校验（Headroom :382-421）：若存在引发报错的命令且候选解法也是命令
        if (failedCmd && isLikelyCommandLine(trimmed)) {
          let prelimEtype = "general";
          const lowF = f.raw.toLowerCase();
          if (lowF.includes("modulenotfound") || lowF.includes("importerror")) {
            prelimEtype = "missing_dependency";
          } else if (lowF.includes("command not found")) {
            prelimEtype = "missing_command";
          } else if (lowF.includes("no such file")) {
            prelimEtype = "missing_path";
          } else if (lowF.includes("permission denied")) {
            prelimEtype = "permission";
          } else if (lowF.includes("already in use")) {
            prelimEtype = "port_conflict";
          } else if (lowF.includes("connection refused") || lowF.includes("timed out")) {
            prelimEtype = "network";
          }
          if (!isCommandRetryCompatible(failedCmd, trimmed, prelimEtype)) {
            continue;
          }
        }
        solutionLine = trimmed;
        break;
      }
    }

    // 如果未找到明确解法行，或未确认后续成功/解决，放弃收录
    if (!solutionLine) continue;
    if (!hasOkSignal && !/(?:解决|修复|搞定|奏效|恢复|生效|成功|fixed|resolved)/i.test(solutionLine)) {
      continue;
    }

    // P2: 存储字段与指纹字段严格分离
    // 入库保留真实原文，绝不提前使用 sig() 破坏真实命令参数
    const rawSymptom = f.raw.trim().slice(0, 500);
    const rawSolution = solutionLine.trim().slice(0, 500);
    const maskedSymptom = sig(rawSymptom);
    const maskedSolution = sig(rawSolution);
    const contentFp = crypto.createHash("sha256").update(`${maskedSymptom}|||${maskedSolution}`).digest("hex").slice(0, 32);

    const key = maskedSymptom + "|||" + maskedSolution;
    if (seen.has(key)) continue;
    seen.add(key);

    let etype = "general";
    const low = f.raw.toLowerCase();
    if (low.includes("modulenotfound") || low.includes("importerror")) {
      etype = "missing_dependency";
    } else if (low.includes("command not found")) {
      etype = "missing_command";
    } else if (low.includes("no such file")) {
      etype = "missing_path";
    } else if (low.includes("permission denied")) {
      etype = "permission";
    } else if (low.includes("already in use")) {
      etype = "port_conflict";
    } else if (low.includes("connection refused") || low.includes("timed out")) {
      etype = "network";
    } else if (/http[/ ]?\d*\s*[45]\d\d/i.test(low)) {
      etype = "http_error";
    }

    out.push({
      component: etype,
      symptom: rawSymptom,
      root_cause: `执行过程中出现 ${rawSymptom}，后续通过执行 ${rawSolution} 成功解决`,
      solution: rawSolution,
      error_type: etype,
      severity: (etype === "missing_dependency" || etype === "port_conflict") ? "high" : "medium",
      tags: `auto-harvest,gateway,${etype}`,
      content_fingerprint: contentFp,
    });
  }

  return out;
}

export function isLikelyFilePath(p) {
  const s = String(p || "").trim();
  // 必须含有路径分隔符 / 或 \
  if (!/[/\\]/.test(s)) return false;
  // 严禁匹配 JS 属性链，如 Object.prototype.hasOwnProperty.call
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)+$/.test(s)) return false;
  if (/(?:prototype|hasOwnProperty|constructor|__proto__|Object|Function|Array)\b/.test(s)) return false;
  return true;
}

export function isLikelyFilePathOrName(p) {
  const s = String(p || "").trim();
  if (/[/\\]/.test(s)) {
    return isLikelyFilePath(s);
  }
  // 纯文件名（如 GLOBAL.md 或 settings.html）
  // 严禁包含 2 个以上点号且无斜杠的属性链（如 a.b.c）
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*){2,}$/.test(s)) return false;
  if (/(?:prototype|hasOwnProperty|constructor|__proto__|Object|Function|Array)\b/.test(s)) return false;
  return /^[a-zA-Z0-9_.~-]+\.[a-zA-Z0-9_-]+$/.test(s);
}

/** Headroom :308-335 路径纠错编辑距离与基名校验 */
export function isValidPathCorrection(errP, okP) {
  const p1 = String(errP || "").trim();
  const p2 = String(okP || "").trim();
  if (!p1 || !p2 || p1 === p2) return false;

  if (!isLikelyFilePath(p2) || !isLikelyFilePathOrName(p1)) {
    return false;
  }

  // 严格排除 JS 属性链如 Object.prototype.hasOwnProperty.call
  if (/(?:prototype|hasOwnProperty|constructor|__proto__|Object|Function|Array)\b/.test(p1) ||
      /(?:prototype|hasOwnProperty|constructor|__proto__|Object|Function|Array)\b/.test(p2)) {
    return false;
  }

  const base1 = path.basename(p1.replace(/\\/g, "/"));
  const base2 = path.basename(p2.replace(/\\/g, "/"));

  // 1. 基名相同（例如迁移/重命名目录 /a/b/file.txt -> /x/y/file.txt）
  if (base1 && base2 && base1 === base2) {
    return true;
  }

  // 2. 或编辑距离 <= max(2, floor(len / 3))
  const maxLen = Math.max(p1.length, p2.length);
  const allowedDist = Math.max(2, Math.floor(maxLen / 3));
  const dist = levenshteinDistance(p1, p2);
  if (dist <= allowedDist) {
    return true;
  }

  const baseMaxLen = Math.max(base1.length, base2.length);
  const baseAllowedDist = Math.max(2, Math.floor(baseMaxLen / 3));
  const baseDist = levenshteinDistance(base1, base2);
  if (baseDist <= baseAllowedDist) {
    return true;
  }

  return false;
}

/** 环境事实提取 */
export function mineEnvironmentFacts(text) {
  const cleaned = cleanDialogueText(text);
  if (isDialogueNoise(cleaned)) return [];

  const results = [];

  // 1. Python 虚拟环境激活
  const venvRe = /(?:source|\.)\s+([~/\w.-]+(?:\/|\.)venv[/\w.-]*\/activate|[~/\w.-]+\/activate)/gi;
  let vmMatch;
  while ((vmMatch = venvRe.exec(cleaned)) !== null) {
    const venvPath = vmMatch[1].trim();
    results.push({
      category: "fact",
      scope_level: "project",
      title: "Python 虚拟环境激活",
      content: `Python virtual environment: \`source ${venvPath}\` before running Python tools.`,
      tags: "environment,python,venv",
      confidence: 0.85,
    });
  }

  // 2. 有效测试命令
  const lines = cleaned.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const tm = /(?:^|\s)(?:[$#>]\s*)?((?:uv\s+run\s+)?pytest(?:\s+[\w./\\-]+)*(?:\s+-[a-zA-Z0-9]+)*)/.exec(lines[i]);
    if (tm) {
      const cmd = tm[1].trim();
      const window = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 15)).join("\n");
      if (/\b(?:PASSED|passed|OK|\d+\s+passed)\b/.test(window)) {
        results.push({
          category: "fact",
          scope_level: "project",
          title: "可用测试命令",
          content: `Working test command: \`${cmd}\``,
          tags: "environment,test",
          confidence: 0.80,
        });
      }
    }
  }

  // 3. 环境执行工具规范（如 uv run python vs python3 / pnpm vs npm）
  const toolPatterns = [
    // 模式 A: 先否定后肯定（如：不要使用 npm，必须统一使用 pnpm）
    {
      re: /(?:不要|禁止|避免|切勿|别)(?:直接)?(?:使用|运行|用|调用)\s*[`'"]?([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*)[`'"]?[，,]\s*(?:必须|请|统一|改用|需|要|应|建议)*\s*(?:使用|改用|通过|用|采用)\s*[`'"]?([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*)[`'"]?/gi,
      dir: "avoid_first",
    },
    // 模式 B: 先肯定后否定（如：环境要求必须使用 uv run python 执行，而不是 python3）
    {
      re: /(?:环境要求|必须|请|统一|要求|规范)[\s：:]*(?:必须|请|统一|要|需)?\s*(?:使用|通过|用|采用)\s*[`'"]?([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*)[`'"]?[^\n]{0,14}?(?:代替|替代|而非|而不是|不要用|不用|别用)(?:[\s，,。.]|(?:直接|再|去|手动|单独|只|统统|一律))*\s*[`'"]?([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*)[`'"]?/gi,
      dir: "prefer_first",
    },
    // 宽松兜底
    {
      re: /(?:建议|请|必须|统一|改用|推荐|需要)?(?:使用|采用|运行|执行)\s*[`'"]?([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*)[`'"]?\s*(?:执行|运行|来跑|再)?\s*(?:而不是|而非|不用|不要用|代替)\s*[`'"]?([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*)[`'"]?/gi,
      dir: "prefer_first",
    },
  ];

  for (const { re, dir } of toolPatterns) {
    let tnMatch;
    while ((tnMatch = re.exec(cleaned)) !== null) {
      const g1 = tnMatch[1].trim();
      const g2 = tnMatch[2].trim();
      const preferred = dir === "avoid_first" ? g2 : g1;
      const avoid = dir === "avoid_first" ? g1 : g2;
      if (preferred && avoid && preferred !== avoid && !GENERIC_PRONOUNS.has(preferred.toLowerCase()) && !GENERIC_PRONOUNS.has(avoid.toLowerCase())) {
        results.push({
          category: "fact",
          scope_level: "project",
          title: `工具规范: ${preferred} 代替 ${avoid}`,
          content: `环境规范：优先使用 \`${preferred}\`，避免使用 \`${avoid}\`。`,
          tags: "environment,tooling,toolchain",
          confidence: 0.85,
        });
      }
    }
  }

  // 4. 路径纠错（严格排除 JS 属性链如 Object.prototype.hasOwnProperty.call）
  const pathRe = /(?:文件|路径)?\s*[`'"]?([~/\w.-]+\.[a-zA-Z0-9]+)[`'"]?\s*(?:不存在|未找到|not found|does not exist).*?(?:正确路径(?:为|是)?|实际路径(?:为|是)?|应为|修正为|改用|迁移到)\s*[`'"]?([~/\w.-]+\.[a-zA-Z0-9]+)[`'"]?/gis;
  let pMatch;
  while ((pMatch = pathRe.exec(cleaned)) !== null) {
    const errP = pMatch[1].trim();
    const okP = pMatch[2].trim();
    if (errP && okP && errP !== okP) {
      if (!isValidPathCorrection(errP, okP)) {
        continue;
      }
      const base = path.basename(okP.replace(/\\/g, "/"));
      results.push({
        category: "fact",
        scope_level: "project",
        title: `路径纠正: ${base}`,
        content: `文件 \`${errP}\` 不存在，正确路径为 \`${okP}\`。`,
        tags: "environment,path",
        confidence: 0.85,
      });
    }
  }

  // 5. 命令可用性与替代
  const cmdNfRe = /[`'"]?([a-zA-Z0-9_-]+)[`'"]?:\s*command not found.*?(?:改用|请使用|统一使用|已安装|可使用)\s*[`'"]?([a-zA-Z0-9_-]+)[`'"]?/gis;
  let cMatch;
  while ((cMatch = cmdNfRe.exec(cleaned)) !== null) {
    const cNf = cMatch[1].trim();
    const cAlt = cMatch[2].trim();
    if (cNf && cAlt && cNf !== cAlt) {
      results.push({
        category: "fact",
        scope_level: "project",
        title: `命令替代: ${cNf} 不可用，改用 ${cAlt}`,
        content: `环境缺少命令 \`${cNf}\`，改用 \`${cAlt}\` 执行对应操作。`,
        tags: "environment,command",
        confidence: 0.80,
      });
    }
  }

  const out = [];
  const seen = new Set();
  for (const c of results) {
    if (!isValidMemoryCandidate(c)) continue;
    const key = c.category + "|||" + c.title + "|||" + c.content;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** 架构决策提取 */
export function mineArchitecturalDecisions(text) {
  const cleaned = cleanDialogueText(text);
  if (isDialogueNoise(cleaned)) return [];

  const results = [];

  // 1. 依赖选型与库替代决策
  const depReplaceRe = /(?:技术选型|依赖选型|架构决策|选型决策|决定|方案评估)[：:\s]*(?:统一|决定)?(?:采用|使用|选用|引入)\s*[`'"]?([a-zA-Z0-9_.-]+)[`'"]?\s*(?:替代|取代|代替|替换)\s*[`'"]?([a-zA-Z0-9_.-]+)[`'"]?(?:[，,。.\n]|\s*(?:作为|用于))/gi;
  let drMatch;
  while ((drMatch = depReplaceRe.exec(cleaned)) !== null) {
    const depNew = drMatch[1].trim();
    const depOld = drMatch[2].trim();
    if (depNew && depOld && depNew !== depOld && !GENERIC_PRONOUNS.has(depNew.toLowerCase()) && !GENERIC_PRONOUNS.has(depOld.toLowerCase())) {
      results.push({
        category: "decision",
        scope_level: "project",
        title: `选型决策: 采用 ${depNew} 替换 ${depOld}`,
        content: `架构决策：采用 \`${depNew}\` 替代 \`${depOld}\`。`,
        tags: "architecture,decision,tech-choice",
        confidence: 0.85,
      });
    }
  }

  // 2. 目录规范与模块分工约定
  const dirConvRe = /(?:代码目录|目录结构|模块存放|文件规范)[：:\s]*(?:统一|规范)?(?:将|把)?\s*([a-zA-Z0-9_\u4e00-\u9fa5]{2,16})\s*(?:统一)?(?:存放在|放在|移至|集中在)\s*[`'"]?([~/\w.-]+)[`'"]?\s*(?:目录|下)/gi;
  let dcMatch;
  while ((dcMatch = dirConvRe.exec(cleaned)) !== null) {
    const modType = dcMatch[1].trim();
    let dirPath = dcMatch[2].trim();
    if (modType && dirPath && !GENERIC_PRONOUNS.has(modType)) {
      if (!dirPath.endsWith("/")) dirPath += "/";
      results.push({
        category: "decision",
        scope_level: "project",
        title: `目录规范: ${modType} 存放在 ${dirPath}`,
        content: `架构目录约定：${modType}统一存放在 \`${dirPath}\` 目录中。`,
        tags: "architecture,structure,convention",
        confidence: 0.85,
      });
    }
  }

  // 3. 架构规范与设计模式约定
  const patternRe = /(?:架构规范|设计约定|架构设计|架构风格)[：:\s]*(?:统一采用|统一遵循|遵循|采用)\s*([a-zA-Z0-9_\u4e00-\u9fa5-]{2,30}(?:规范|风格|架构|模式))/gi;
  let patMatch;
  while ((patMatch = patternRe.exec(cleaned)) !== null) {
    const standard = patMatch[1].trim();
    if (standard && !GENERIC_PRONOUNS.has(standard)) {
      results.push({
        category: "decision",
        scope_level: "project",
        title: `架构规范: 遵循 ${standard}`,
        content: `系统架构规范约定：统一采用并遵循 ${standard}。`,
        tags: "architecture,pattern,convention",
        confidence: 0.85,
      });
    }
  }

  const out = [];
  const seen = new Set();
  for (const c of results) {
    if (!isValidMemoryCandidate(c)) continue;
    const key = c.category + "|||" + c.title + "|||" + c.content;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/* ================================================================== *
 * 3. 递归文件扫描与解析
 * ================================================================== */

function collectConversationFiles(dir) {
  const files = [];
  function walk(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        if (ent.name.endsWith(".jsonl") || ent.name.endsWith(".json")) {
          if (!ent.name.includes(".tmp") && !ent.name.includes(".bad") && !ent.name.endsWith(".lock")) {
            files.push(full);
          }
        }
      }
    }
  }
  walk(dir);
  return files;
}

function parseTurnsFromFile(filePath) {
  let content = "";
  try {
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

  return parts.join("\n");
}

function turnFingerprint(turn) {
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
export function isTestMode() {
  if (process.env.NODE_ENV === "test" || process.env.MAGPIE_TEST === "1") return true;
  if (typeof process !== "undefined" && Array.isArray(process.argv)) {
    const entry = String(process.argv[1] || "");
    if (entry.includes("/tests/") || entry.includes("\\tests\\") || entry.includes("test_") || entry.endsWith(".test.mjs") || entry.endsWith(".test.js")) {
      return true;
    }
  }
  return false;
}

export async function harvestGateway(args, context) {
  const options = args || {};
  const ctx = context || {};
  const client = ctx._client || ctx.client;
  const cfg = ctx._cfg || ctx.cfg || {};
  const saveMemory = ctx.saveMemory;
  const pitfallSave = ctx.pitfallSave;
  const signal = ctx.signal;

  const convDir = resolveGatewayDir(options.dir || cfg.gatewayConvDir);

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

    for (const turn of turns) {
      if (signal && signal.aborted) {
        aborted = true;
        break;
      }

      const fp = turnFingerprint(turn);
      if (!options.force_rescan && processedFpSet.has(fp)) {
        continue;
      }

      const agent = String(turn.agent || turn.Agent || "").trim() || "gateway";
      const dialogueText = extractDialogueText(turn);
      if (!dialogueText || dialogueText.length < 15) {
        processedFpSet.add(fp);
        continue;
      }

      // 双轨制：用户显式知识沉淀指令穿透门禁直接入库
      const isExplicit = isExplicitUserMemory(dialogueText);
      const minEvidence = options.min_evidence !== undefined
        ? Number(options.min_evidence)
        : (cfg.min_evidence !== undefined ? Number(cfg.min_evidence) : DEFAULT_MIN_EVIDENCE);

      // 规则提取
      const failures = mineFailures(dialogueText);
      const facts = mineEnvironmentFacts(dialogueText);
      const decisions = mineArchitecturalDecisions(dialogueText);

      // 写入 memories（事实 + 架构决策）
      if (typeof saveMemory === "function") {
        for (const item of facts.concat(decisions)) {
          if (signal && signal.aborted) { aborted = true; break; }

          // P0 证据累计门禁（显式指令直接穿透）
          if (!isExplicit && minEvidence > 1) {
            const itemFp = crypto.createHash("sha256").update(`${targetProject}:${item.category}:${item.title}`).digest("hex").slice(0, 32);
            const pendingRes = recordPendingEvidence("m:" + itemFp, {
              ...item,
              project: targetProject,
              client: agent,
            }, {
              kind: "memory",
              minEvidence,
            });
            if (!pendingRes.shouldGraduate) {
              continue; // 未达到门禁累计次数，仅在 pending 计数，不落盘
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
              confidence: item.confidence,
            }, { agent, _ctx: { agent } });
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

          const pFp = p.content_fingerprint || crypto.createHash("sha256").update(`${targetProject}:${p.component}:${sig(p.symptom)}`).digest("hex").slice(0, 32);
          let recurrence = 1;

          // P0 证据累计门禁（显式指令直接穿透）
          if (!isExplicit && minEvidence > 1) {
            const pendingRes = recordPendingEvidence(`p:${targetProject}:${pFp}`, {
              ...p,
              project: targetProject,
              client: agent,
            }, {
              kind: "pitfall",
              minEvidence,
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
              component: p.component,
              symptom: p.symptom,
              root_cause: p.root_cause,
              solution: p.solution,
              severity: p.severity || "medium",
              error_type: p.error_type || "general",
              tags: p.tags,
              content_fingerprint: pFp,
              recurrence,
            }, { agent, _ctx: { agent } });
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

    // 记录该文件处理进度
    updatedFileStates[filePath] = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      turns_count: turns.length,
      processed_at: Date.now(),
    };

    if (aborted) break;
  }

  // 4. 持久化增量状态（受限队列，最多保留 2000 个 turn 指纹）
  const allFps = Array.from(processedFpSet);
  const boundedFps = allFps.slice(Math.max(0, allFps.length - 2000));
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
