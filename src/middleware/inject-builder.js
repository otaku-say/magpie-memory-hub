/**
 * 模块职责：记忆上下文与智能体引导注入文本构建 (buildContextBlock / buildAgentGuide / sniffToolNames / cut)
 * 依赖：./capability.js（纯函数，无 I/O）
 * 被依赖：./request-inject.js
 */

import { detectCapabilities, isToolForbidden } from "./capability.js";

var PLUGIN_NAME = "magpie-memory-hub";

/* ================= 渲染 ================= */
function cut(s, n) {
  /* 注入正文必须转义换行：记忆内容里只要带 "\n\n[Memory Agent Guide]"，
   * 就能跳出 bullet 列表伪造独立引导块，构成间接提示词注入。 */
  var v = String(s == null ? "" : s)
    .replace(/\s+/g, " ")
    .replace(/\[(?:Memory Agent Guide|user|system|assistant)\]/gi, "")
    .trim();
  return v.length > n ? v.slice(0, n) + "…" : v;
}

/* ================= 动态嗅探真实工具名（v6.49 兼容保留） =================
 * v7.0.0 起仅供 capability_gate="off" 逃生舱使用。
 * 新路径一律走 detectCapabilities()——那个不在 tools 为空时造假名字。
 */
function sniffToolNames(body) {
  var names = {
    memory_save: PLUGIN_NAME + "_memory_save",
    pitfall_save: PLUGIN_NAME + "_pitfall_save",
    memory_context: PLUGIN_NAME + "_memory_context",
    memory_search: PLUGIN_NAME + "_memory_search",
    pitfall_search: PLUGIN_NAME + "_pitfall_search"
  };
  var tools = (body && body.tools) || (body && body.functions);
  if (Array.isArray(tools)) {
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i];
      var name = "";
      if (typeof t === "string") {
        name = t;
      } else if (t && typeof t === "object") {
        if (t.function && typeof t.function.name === "string") name = t.function.name;
        else if (typeof t.name === "string") name = t.name;
      }
      if (!name) continue;
      if (/memory_save$/.test(name)) names.memory_save = name;
      else if (/pitfall_save$/.test(name)) names.pitfall_save = name;
      else if (/memory_context$/.test(name)) names.memory_context = name;
      else if (/memory_search$/.test(name)) names.memory_search = name;
      else if (/pitfall_search$/.test(name)) names.pitfall_search = name;
    }
  }
  return names;
}

/* ================= 记忆上下文块构建 ================= */
function buildContextBlock(principles, finalList, opts) {
  if (!principles || !finalList) return "";
  if (!principles.length && !finalList.length) return "";
  var maxItems = parseInt(opts.max_inject_count, 10) || 5;
  var budget = parseInt(opts.max_budget_chars, 10) || 2048;
  var useCards = !!opts.ccr_cards;
  var canExpand = opts._canExpand === true;   // 只有档 2（工具就绪）才提 memory_get
  var block = "\n\n[Persistent Memory Context]\n";
  var used = 0;

  for (var p = 0; p < principles.length && used < maxItems; p++) {
    var pr = principles[p];
    var scopeTag = pr._envScope ? "〔仅 " + pr._envScope + "〕" : "";
    var pline = "- 【避坑准则】" + scopeTag + cut(pr.content, 300) + "\n";
    if (block.length + pline.length > budget) break;
    block += pline;
    used++;
  }

  var pitfallThreshold = Number(opts.pitfall_recurrence_threshold ?? opts.pitfallRecurrenceThreshold ?? opts.crystallization_threshold ?? 3) || 3;

  for (var n = 0; n < finalList.length && used < maxItems; n++) {
    var it = finalList[n];
    if (String(it.category) === "principle") continue;  // 已在上面注入过
    var isPitfall = String(it.category || "").toLowerCase().indexOf("pitfall") === 0 || !!it.symptom;
    var itRec = Number(it.recurrence) || 1;
    var isFrequent = isPitfall && itRec >= pitfallThreshold;
    var prefix = isFrequent ? "[高频复发×" + itRec + "] " : "";
    var suffix = isFrequent ? " 建议核查根因是否已根治" : "";
    var line;
    if (useCards && String(it.content || "").length > 160) {
      /* CCR：长内容只给摘要卡 + ID。只有工具就绪时才提 memory_get，
       * 否则无工具客户端会去调一个不存在的工具。 */
      line = "- " + prefix + "[" + (it.category || "fact") + "] " + cut(it.title, 60) +
             ": " + cut(it.content, 120) +
             (canExpand ? " (id=" + it.id + "，需要完整内容可调 memory_get)" : " (id=" + it.id + ")") + suffix + "\n";
    } else {
      line = "- " + prefix + "[" + (it.category || "fact") + "] " + cut(it.title, 120) +
             ": " + cut(it.content, 400) + suffix + "\n";
    }
    if (block.length + line.length > budget) break;
    block += line;
    used++;
  }
  if (used) return block;
  return "";
}

/* ================= 能力分档引导 =================
 *
 * v7.0.0：从「无条件命令调工具」改为三档 + 零工具写入通道。
 *
 *   档 0  本请求未通告任何工具      → 默认整块不注入；开了 guide_on_no_tools 则陈述式
 *   档 1  有工具，但没有本插件的    → 「能力未确认」，**一个具体工具名都不写**
 *   档 2  通告了本插件工具          → 用**真实通告名** + 不可重试条款
 *
 * 外部实证（见 docs/RESEARCH-capability-gating.md）：
 *  - claude-mem 按 runtime 逐行裁剪指令，不适用运行时的句子直接删除；
 *  - basic-memory 在 provider 未就绪时直接返回空串；
 *  - mem0 把召回/写入全部迁到 hook 与 CLI，根本不依赖工具。
 */

function quoteNames(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i]) out.push("`" + list[i] + "`");
  }
  return out.join("、");
}

/* 根据能力对象算出「本轮真正可用的工具名」——已应用客户端画像的禁用清单 */
function usableNames(caps) {
  var matched = (caps && caps.matched) || {};
  var forbid = (caps && caps.forbidTools) || [];
  function ok(n) { return !!n && !isToolForbidden(n, forbid); }
  return {
    ctx: ok(matched.memory_context) ? matched.memory_context : "",
    search: ok(matched.memory_search) ? matched.memory_search : "",
    pitSearch: ok(matched.pitfall_search) ? matched.pitfall_search : "",
    get: ok(matched.memory_get) ? matched.memory_get : "",
    save: ok(matched.memory_save) ? matched.memory_save : "",
    pitSave: ok(matched.pitfall_save) ? matched.pitfall_save : ""
  };
}

function readToolList(u) {
  var out = [];
  if (u.ctx) out.push(u.ctx);
  if (u.search) out.push(u.search);
  if (u.pitSearch) out.push(u.pitSearch);
  return out;
}

function writeToolList(u) {
  var out = [];
  if (u.save) out.push(u.save);
  if (u.pitSave) out.push(u.pitSave);
  return out;
}

/* 零工具写入通道：仿 mem0 把 CLI 当一个“永远存在”的通道。
 * 只有显式配置 cli_channel 才提，并且只给命令不给 MCP 工具名。 */
function cliLines(opts) {
  var ch = opts && opts.cli_channel;
  if (!ch) return [];
  var cmd = typeof ch === "string" ? ch.trim() : "";
  if (!cmd) return [];
  return [
    "- 写入通道（CLI，不依赖任何工具）：" + cmd + " save --title \"<标题>\" --content \"<正文>\". ",
    "- 检索通道（CLI）：" + cmd + " search --query \"<关键词>\". 若命令不可用，则以上面的上下文作答，不要先猜结果。"
  ];
}

/* 档 0：无工具环境。只陈述事实，不给任何 MCP 工具名。 */
function buildNoToolGuide(opts) {
  var lines = [
    "- 本会话未注册任何记忆工具（含 MCP）。上面的记忆上下文是**已经取回的结果**，直接据此作答即可；不要尝试检索，检索不可能成功。",
    "- 禁止声称「已记住 / 已保存 / 已写入记忆」：本环境不存在任何 MCP 写入通道。用户要求持久化时，如实说明需要开启记忆工具，或把结论交给用户自行保存。",
    "- 禁止描述并未发生的工具调用，禁止输出记忆标签块。"
  ];
  var cli = cliLines(opts);
  if (cli.length) {
    lines[1] = "- 存在 CLI 写入通道，写入必须真的执行成功；未拿到命令输出前一律不得声称已保存。";
    lines = lines.concat(cli);
  }
  return "\n\n[Memory Agent Guide —— 无工具环境]\n" + lines.join("\n");
}

/* 档 1：有工具但未能确认本插件。不写具体工具名——写死名字就是幻觉的源头。 */
function buildUnknownToolGuide(opts) {
  var lines = [
    "- 本会话未通告记忆工具。仅当工具清单里确实出现名称含 memory 或 pitfall 的检索/写入工具时才可调用；否则直接使用上面的记忆上下文作答。",
    "- 一次调用返回「工具不存在 / 不可用」后立即停手，不要换名重试，也不要声称已保存。"
  ];
  return "\n\n[Memory Agent Guide —— 能力未确认]\n" + lines.concat(cliLines(opts)).join("\n");
}

/* 档 2：工具已就绪。场景语气沿用四档，但工具名一律取自真实通告值。 */
function buildReadyGuide(scenario, u, opts) {
  var reads = readToolList(u);
  var writes = writeToolList(u);
  var lines = [];
  var title = "检索与沉淀";

  if (scenario === "trouble") {
    title = "排障与避坑";
    if (reads.length) {
      var order = [];
      if (u.pitSearch) order.push(u.pitSearch);
      if (u.ctx) order.push(u.ctx);
      if (!order.length) order = reads.slice(0, 2);
      lines.push("- 先查避坑：检测到排障/报错场景，请先调用 " + quoteNames(order.slice(0, 2)) +
        " 检索已知避坑经验与历史解法；");
    }
    if (writes.length) {
      var pit = u.pitSave || u.save;
      lines.push("- 修复必存：排障解决后，结束本轮前调用 `" + pit + "` 沉淀踩坑经验（含 symptom, solution）；");
    }
  } else if (scenario === "principle") {
    title = "规范与准则沉淀";
    if (writes.length) {
      var primary = u.save || u.pitSave;
      lines.push("- 立即沉淀准则：检测到长期规范或铁律意图，请立即调用 `" + primary +
        "`（category=\"principle\"）持久化沉淀；");
    }
    if (reads.length) {
      lines.push("- 检索辅助：若需校验既有规范或配置，可主动调用 " + quoteNames(reads.slice(0, 2)) + " 召回。");
    }
  } else if (scenario === "eager") {
    if (reads.length) {
      lines.push("1. 优先检索：涉及项目背景、历史规范、关键配置或排查报错时，优先主动调用 " +
        quoteNames(reads) + " 检索记忆与避坑经验。");
    }
    if (writes.length) {
      lines.push("2. 及时沉淀：结束本轮前检查是否产生了持久偏好、架构决策、环境事实或报错解法，若命中立即用 " +
        quoteNames(writes) + " 存入。");
    }
  } else {
    if (reads.length) {
      lines.push("- 遇项目背景、历史规范或报错时，主动调用 " + quoteNames(reads) + " 检索记忆与避坑经验；");
    }
    if (writes.length) {
      lines.push("- 若产生了值得持久化的偏好/决策/事实/报错解法，调用 " + quoteNames(writes) + " 保存；");
    }
    lines.push("- 无相关需求时忽略本提示，绝不为了凑数操作。");
  }

  /* 两条通用硬约束（外部项目实证）：
   *  - basic-memory「Saves must be real」：编造“已保存”的回执比调错工具更难发现；
   *  - claude-mem「do not call a missing write tool」：幻觉的典型形态是换名连试三次。 */
  lines.push("- 保存必须是真的：只有工具返回成功后才可声称「已记住」，并能引用返回的 id；工具未返回前一律不得声称已保存。");
  lines.push("- 若调用返回「工具不存在 / 不可用」，立即停手改用上下文快照作答，禁止换名重试，也不得输出记忆标签块。");
  return "\n\n[Memory Agent Guide —— " + title + "]\n" + lines.join("\n");
}

function buildAgentGuide(prompt, opts, body, ctx) {
  var wantExtract = opts.inline_extract !== false;
  if (!wantExtract) return "";

  var strength = String(opts.extract_strength || "soft").toLowerCase();
  var interval = Number(opts.extract_interval) || 1;
  var st = (ctx && ctx.state && typeof ctx.state === "object") ? ctx.state : {};
  var turnNo = Number(st.turnNo) || 0;
  var onlyAgents = opts.extract_agents;
  var onlyModels = opts.extract_models;
  var agentName = String((ctx && ctx.agent) || st.agent || "").trim();
  var modelName = String(st.model || "").trim();
  if (Array.isArray(onlyAgents) && onlyAgents.length && agentName &&
      onlyAgents.indexOf(agentName) === -1) wantExtract = false;
  if (Array.isArray(onlyModels) && onlyModels.length && modelName &&
      !onlyModels.some(function (p) { return modelName.indexOf(p) === 0; })) wantExtract = false;
  if (interval > 1 && (turnNo % interval) !== 0) wantExtract = false;

  if (!wantExtract) return "";

  var caps = st.caps && typeof st.caps === "object" ? st.caps : detectCapabilities(body);

  /* 逃生舱：capability_gate="off" 精确退回 v6.49 行为，仅用于排查回归。 */
  var gate = String(opts.capability_gate == null ? "auto" : opts.capability_gate).toLowerCase();
  if (gate === "off") {
    var legacy = sniffToolNames(body);
    caps = {
      hasTools: true,
      present: true,
      readOk: true,
      writeOk: true,
      matched: {
        memory_context: legacy.memory_context,
        memory_search: legacy.memory_search,
        pitfall_search: legacy.pitfall_search,
        memory_get: (legacy.memory_context || "").replace(/memory_context$/, "memory_get"),
        memory_save: legacy.memory_save,
        pitfall_save: legacy.pitfall_save
      },
      forbidTools: []
    };
  }

  /* 档 0：无工具。默认整块静默——不注入才是真正零成本的除幻觉手段。 */
  if (!caps.hasTools) {
    if (opts.guide_on_no_tools === true) { st.guideTier = 0; return buildNoToolGuide(opts); }
    return "";
  }

  var u = usableNames(caps);
  var reads = readToolList(u);
  var writes = writeToolList(u);

  /* 档 1：有工具，但本插件工具要么没通告、要么被画像禁完 */
  if (!reads.length && !writes.length) { st.guideTier = 1; return buildUnknownToolGuide(opts); }

  st.guideTier = 2;
  var isTrouble = /Error:|Exception|Traceback|panic:|ENOENT|ECONN|报错|失败|不生效|踩坑|异常|bug/i.test(prompt);
  var isPrinciple = /记住|以后都|不要再|严禁|禁止|必须用|统一用|默认配置|架构原则|铁律/.test(prompt);

  var scenario = "default";
  if (isTrouble) scenario = "trouble";
  else if (isPrinciple) scenario = "principle";
  else if (strength === "strict" || turnNo <= 1) scenario = "eager";

  return buildReadyGuide(scenario, u, opts);
}

export {
  cut,
  sniffToolNames,
  buildContextBlock,
  buildAgentGuide
};
