/**
 * 模块职责：记忆上下文与智能体引导注入文本构建器 (buildContextBlock / buildAgentGuide / sniffToolNames / cut)
 * 依赖：无外部依赖（纯内存同步计算，无任何 I/O）
 * 被依赖：./request-inject.js
 */

var PLUGIN_NAME = "magpie-memory-hub";

/* ================= 渲染 ================= */
function cut(s, n) {
  var v = String(s == null ? "" : s);
  return v.length > n ? v.slice(0, n) + "…" : v;
}


/* ================= 动态嗅探真实工具名 =================
 * 客户端可能使用不同前缀（如 mcp__magpie__... 或直接工具名），
 * 动态从 body.tools 中嗅探最匹配的注册工具名。
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
        if (t.function && typeof t.function.name === "string") {
          name = t.function.name;
        } else if (typeof t.name === "string") {
          name = t.name;
        }
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
  var block = "\n\n[Persistent Memory Context]\n";
  var used = 0;

  for (var p = 0; p < principles.length && used < maxItems; p++) {
    var pr = principles[p];
    var pline = "- 【避坑准则】" + cut(pr.content, 300) + "\n";
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
      /* CCR：长内容只给摘要卡 + ID，Agent 需要时调 memory_get 展开 */
      line = "- " + prefix + "[" + (it.category || "fact") + "] " + cut(it.title, 60) +
             ": " + cut(it.content, 120) +
             " (id=" + it.id + "，需要完整内容可调 memory_get)" + suffix + "\n";
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


/* ================= 内联提炼指令与意图引导构建 ================= */
function buildAgentGuide(prompt, opts, body, ctx) {
  var wantExtract = opts.inline_extract !== false;
  if (!wantExtract) return "";

  var strength = String(opts.extract_strength || "soft").toLowerCase();
  var interval = Number(opts.extract_interval) || 1;
  var turnNo = Number(ctx.state.turnNo) || 0;
  // 作用域过滤：留空=全部适用
  var onlyAgents = opts.extract_agents;
  var onlyModels = opts.extract_models;
  var agentName = String((ctx && ctx.agent) || ctx.state.agent || "").trim();
  var modelName = String(ctx.state.model || "").trim();
  if (Array.isArray(onlyAgents) && onlyAgents.length && agentName &&
      onlyAgents.indexOf(agentName) === -1) wantExtract = false;
  if (Array.isArray(onlyModels) && onlyModels.length && modelName &&
      !onlyModels.some(function (p) { return modelName.indexOf(p) === 0; })) wantExtract = false;
  if (interval > 1 && (turnNo % interval) !== 0) wantExtract = false;

  if (!wantExtract) return "";

  var toolsSniffed = sniffToolNames(body);
  var saveTool = toolsSniffed.memory_save;
  var pitfallTool = toolsSniffed.pitfall_save;
  var ctxTool = toolsSniffed.memory_context;
  var searchTool = toolsSniffed.memory_search;
  var pitSearchTool = toolsSniffed.pitfall_search;

  var isTrouble = /Error:|Exception|Traceback|panic:|ENOENT|ECONN|报错|失败|不生效|踩坑|异常|bug/i.test(prompt);
  var isPrinciple = /记住|以后都|不要再|严禁|禁止|必须用|统一用|默认配置|架构原则|铁律/.test(prompt);

  if (isTrouble) {
    return (
      "\n\n[Memory Agent Guide —— 排障与避坑]\n" +
      "- 先查避坑：检测到排障/报错场景，请先主动调用 `" + pitSearchTool + "` 或 `" + ctxTool + "` 检索已知避坑经验与历史解法；\n" +
      "- 修复必存：排障解决后，结束本轮前务必调用 `" + pitfallTool + "` 沉淀踩坑经验（含 symptom, solution 等）；无工具调用能力时跳过保存，绝不在回复里输出 <memory> 标签块。"
    );
  } else if (isPrinciple) {
    return (
      "\n\n[Memory Agent Guide —— 规范与准则沉淀]\n" +
      "- 立即沉淀准则：检测到长期规范或铁律意图，请立即调用 `" + saveTool + "`(category=\"principle\") 持久化沉淀；无工具调用能力时跳过保存，绝不在回复里输出 <memory> 标签块。\n" +
      "- 检索辅助：若需校验既有规范或配置，可主动调用 `" + ctxTool + "` 或 `" + searchTool + "` 召回。"
    );
  } else if (strength === "strict" || turnNo <= 1) {
    return (
      "\n\n[Memory Agent Guide —— 检索与沉淀]\n" +
      "1. 优先检索：涉及项目背景、历史规范、关键配置或排查报错时，优先主动调用 `" + ctxTool + "`（首选一站式召回）、`" + searchTool + "` 或 `" + pitSearchTool + "` 检索记忆与避坑经验。\n" +
      "2. 及时沉淀：结束本轮前检查是否产生了持久偏好、架构决策、环境事实或报错解法，若命中立即用 `" + saveTool + "` 存入（报错踩坑优先用 `" + pitfallTool + "`）；无工具调用能力时跳过保存，绝不在回复里输出 <memory> 标签块。\n" +
      "无相关需求时忽略本提示，绝不为了凑数操作。"
    );
  } else {
    return (
      "\n\n[Memory Agent Guide]\n" +
      "- 遇项目背景、历史规范或报错时，主动调用 `" + ctxTool + "`、`" + searchTool + "` 或 `" + pitSearchTool + "` 检索记忆与避坑经验；\n" +
      "- 若产生了值得持久化的偏好/决策/事实/报错解法，调用 `" + saveTool + "`（或 `" + pitfallTool + "`）保存；无工具调用能力时跳过保存，绝不在回复里输出 <memory> 标签块。无需求请忽略。"
    );
  }
}


export {
  cut,
  sniffToolNames,
  buildContextBlock,
  buildAgentGuide
};
