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
import { lookupGatewayHarvest, rememberGatewayHarvest } from "./local_state.js";
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

function cleanDialogueText(text) {
  if (!text) return "";
  return String(text).replace(/\x1b\[[0-9;]*m/g, "").trim();
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
  const lines = String(text || "").split(/\r?\n/);
  const fails = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of FAIL_PATTERNS) {
      const m = pat.exec(line);
      if (m) {
        fails.push({ at: i, raw: m[0], symptom: sig(m[0]) });
        break;
      }
    }
  }

  const out = [];
  const seen = new Set();

  for (const f of fails) {
    const window = lines.slice(f.at + 1, f.at + 60);
    let okLine = null;
    for (const l of window) {
      for (const pat of OK_PATTERNS) {
        if (pat.test(l)) {
          okLine = l.trim();
          break;
        }
      }
      if (okLine) break;
    }
    if (!okLine) continue;

    const solution = sig(okLine);
    const key = f.symptom + "|||" + solution;
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
      symptom: f.symptom,
      root_cause: `执行过程中出现 ${f.symptom}，后续通过调整成功解决`,
      solution,
      error_type: etype,
      severity: "medium",
      tags: `auto-harvest,gateway,${etype}`,
    });
  }

  return out;
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
      scope: "project",
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
          scope: "project",
          title: "可用测试命令",
          content: `Working test command: \`${cmd}\``,
          tags: "environment,test",
          confidence: 0.80,
        });
      }
    }
  }

  // 3. 环境执行工具规范（如 uv run python vs python3 / pnpm vs npm）
  const toolNormRe = /(?:建议|请|必须|统一|改用|推荐|需要)?(?:使用|采用|运行|执行)\s*[`'"]?([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*)[`'"]?\s*(?:执行|运行|来跑|再)?\s*(?:而不是|而非|不用|不要用|代替)\s*[`'"]?([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*)[`'"]?/gi;
  let tnMatch;
  while ((tnMatch = toolNormRe.exec(cleaned)) !== null) {
    const preferred = tnMatch[1].trim();
    const avoid = tnMatch[2].trim();
    if (preferred && avoid && preferred !== avoid && !GENERIC_PRONOUNS.has(preferred.toLowerCase()) && !GENERIC_PRONOUNS.has(avoid.toLowerCase())) {
      results.push({
        category: "fact",
        scope: "project",
        title: `工具规范: ${preferred} 代替 ${avoid}`,
        content: `环境规范：优先使用 \`${preferred}\`，避免使用 \`${avoid}\`。`,
        tags: "environment,tooling",
        confidence: 0.85,
      });
    }
  }

  // 4. 路径纠错
  const pathRe = /(?:文件|路径)?\s*[`'"]?([~/\w.-]+\.[a-zA-Z0-9]+)[`'"]?\s*(?:不存在|未找到|not found|does not exist).*?(?:正确路径(?:为|是)?|实际路径(?:为|是)?|应为|修正为|改用|迁移到)\s*[`'"]?([~/\w.-]+\.[a-zA-Z0-9]+)[`'"]?/gis;
  let pMatch;
  while ((pMatch = pathRe.exec(cleaned)) !== null) {
    const errP = pMatch[1].trim();
    const okP = pMatch[2].trim();
    if (errP && okP && errP !== okP) {
      const base = path.basename(okP.replace(/\\/g, "/"));
      results.push({
        category: "fact",
        scope: "project",
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
        scope: "project",
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
        scope: "project",
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
        scope: "project",
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
        scope: "project",
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

      // 规则提取
      const failures = mineFailures(dialogueText);
      const facts = mineEnvironmentFacts(dialogueText);
      const decisions = mineArchitecturalDecisions(dialogueText);

      // 写入 memories（事实 + 架构决策）
      if (typeof saveMemory === "function") {
        for (const item of facts.concat(decisions)) {
          if (signal && signal.aborted) { aborted = true; break; }
          try {
            const res = await saveMemory(client, cfg, {
              project: targetProject,
              category: item.category,
              scope: item.scope || "project",
              client: agent,
              title: item.title,
              content: item.content,
              tags: item.tags,
              confidence: item.confidence,
              source: "gateway_harvest",
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
              source: "gateway_harvest",
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
