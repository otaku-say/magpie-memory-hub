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
 *    - 使用用户在设置中显式配置的在线提炼大模型，提取结构化的环境事实、架构决策与踩坑故障解法。
 *    - 未配置提炼模型（extract_model 为空）时默认安全跳过，绝不调用未授权模型。
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
import { harvestWithOnlineModel } from "./gateway_harvest.hooks.js";
import { semanticFingerprint } from "./semantic_dedup.js";

/* 诊断：把静默吞掉的错误说出来（每类只打一次，不含对话内容） */
var _diagLogged = {};
export function _diag(tag, msg) {
  if (_diagLogged[tag]) return;
  _diagLogged[tag] = 1;
  try { console.log("[memory-hub][diag] " + tag + ": " + String(msg).slice(0, 300)); } catch (_) {}
}

export const GATEWAY_CONV_DIRNAME = "gateway-conversations";
export const NO_CONVERSATIONS_MSG = "未检测到对话录制。请在 Magpie 设置里开启 GatewayConversations（本地录制对话，插件据此提炼记忆）。";
export const PRIVACY_NOTICE = "数据来自 Magpie 的 GatewayConversations 落盘，可在 Magpie 设置里关闭该录制";

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
 * 2. 辅助函数与记忆标记
 * ================================================================== */

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

  return stripScaffolding(parts.join("\n"));
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

          const mFp = semanticFingerprint(targetProject, item.category, item.title, item.content);
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

          const pFp = p.content_fingerprint || crypto.createHash("sha256").update(`${targetProject}:${p.component}:${sig(p.symptom)}`).digest("hex").slice(0, 32);
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
              root_cause: p.root_cause || `执行过程中出现 ${p.symptom}，已处置解决`,
              solution: p.solution,
              severity: p.severity || "medium",
              error_type: p.error_type || "general",
              tags: p.tags,
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
