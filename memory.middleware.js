/**
 * memory.middleware.js — 网关中间件（v5.0）
 * ==========================================
 * 运行环境：Magpie 网关进程内的 moejs
 *   - 纯同步：禁止 fetch / setTimeout / Promise / 网络 / 文件
 *   - 限额：onRequest 250ms，onEvent 50ms/事件，onResponse 250ms
 *   - 抛错或超时 = fail open，请求保持原样
 *
 * 【本文件为什么这么写】
 * 中间件读不到数据库，它只看到一个由外部（离线管线经
 * `magpie plugin options`）推进 plugins.json 的 memories 数组。
 * 所以这里的检索必须全部在【内存数组】上完成——任何 SQL / 网络方案都不成立。
 *
 * 借鉴（只取在内存里能实现的部分）：
 *   - Graphiti   ：RRF 倒数排名融合，避免不同量纲分数硬加权
 *   - Khoj       ：艾宾浩斯保留率，做时间衰减
 *   - Graphiti   ：双时态（invalid_at）过滤，历史不删只失效
 *   - Hindsight  ：行为准则（principle）强制置顶
 *   - Headroom   ：CCR 摘要卡，只下发摘要与 ID，长文按需展开
 */

import { compressBody } from "./compress.js";

var HARVEST_TAG = "[MEMORY_HARVEST]";
/* 插件自己的包名 —— Magpie 把插件工具注册成 <包名>_<工具名>，
 * 所以这里要写全名，否则模型按 memory_save 去调会找不到工具。 */
var PLUGIN_NAME = "magpie-memory-hub";
var ANSWER_CAP = 4000;
var PROMPT_CAP = 1500;
var RRF_K = 60;
var CAND_CAP = 200;      // 参与 RRF 融合的候选上限
var BUCKET_CAP = 50;     // 每个倒排桶最多取多少条
var HARD_CAND = 600;     // 候选收集的硬上限，防止宽查询拖垮单次请求
var DAY_MS = 86400000;

var _cache = null;
var _cacheKey = "";

/* ================= 文本清洗 ================= */
function cleanText(text) {
  if (!text || typeof text !== "string") return "";
  var s = text;
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  s = s.replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, "");
  s = s.replace(/<context_guidance>[\s\S]*?<\/context_guidance>/gi, "");
  s = s.replace(/\[system-reminder\][\s\S]*?\[\/system-reminder\]/gi, "");
  s = s.replace(/\[Persistent Memory Context\][\s\S]*?(?=\n\n|$)/gi, "");
  s = s.replace(/\[Memory Instruction\][\s\S]*?(?=\n\n|$)/gi, "");
  return s.replace(/^\s+|\s+$/g, "");
}

/* ================= 分词 =================
 * 英文/数字取 ≥2 长度的整词；中文取【双字组】（overlapping bigram）。
 * 为什么中文要切 bigram：无词典分词下若把整段中文当成一个 token，
 * 「端口冲突怎么处理」就永远匹配不到标题里的「端口冲突」，中文召回会大面积失效。
 */
function tokenize(text) {
  var s = String(text || "").toLowerCase();
  var runs = s.match(/[a-z0-9_-]{2,}|[\u4e00-\u9fff]+/g) || [];
  var seen = {};
  var out = [];
  for (var i = 0; i < runs.length; i++) {
    var t = runs[i];
    if (/[\u4e00-\u9fff]/.test(t)) {
      if (t.length === 1) {
        if (!seen[t]) { seen[t] = 1; out.push(t); }
        continue;
      }
      for (var j = 0; j + 2 <= t.length; j++) {
        var g = t.substr(j, 2);
        if (!seen[g]) { seen[g] = 1; out.push(g); }
      }
    } else if (!seen[t]) {
      seen[t] = 1;
      out.push(t);
    }
  }
  return out;
}

/* ================= 双时态：是否仍然有效 ================= */
function isValid(m, now) {
  if (!m) return false;
  if (m.status === "superseded") return false;
  if (m.invalid_at) {
    var t = Date.parse(String(m.invalid_at));
    if (!isNaN(t) && t <= now) return false;
  }
  return true;
}

/* ================= 艾宾浩斯保留率 =================
 * 强度 S 随命中次数对数增长，保留率 R = exp(-Δt / S)
 * 高频核心事实半衰期长，偶发噪音快速衰减。
 */
function retention(m, now) {
  var hits = parseInt(m.hits, 10);
  if (!hits || hits !== hits) hits = 0;
  var acc = parseInt(m.access_count, 10);
  if (!acc || acc !== acc) acc = 0;
  var S = 1.0 * (1 + 1.5 * Math.log(1 + hits + acc * 0.5));
  var t = Date.parse(String(m.updated_at || m.last_accessed_at || m.created_at || ""));
  if (isNaN(t)) return 1;
  var days = (now - t) / DAY_MS;
  if (days <= 0) return 1;
  return Math.exp(-days / S);
}

/* ================= 倒排索引 =================
 * 缓存键必须是【内容签名】而不是数组引用：ctx.options 每次请求都由 JSON
 * 重新解析，引用每次都变，用引用比较等于永不命中——5000 条时每请求重建
 * 索引要 250ms，直接击穿 onRequest 的限额。签名只用整数运算，O(n) 且极廉价。
 */
function signatureOf(memories) {
  var n = memories.length;
  var sum = 0;
  var inact = 0;
  for (var i = 0; i < n; i++) {
    var m = memories[i];
    if (!m) continue;
    sum = (sum + (m.id | 0) + (m.access_count | 0) * 7 + (m.hits | 0) * 13) | 0;
    if (m.status && m.status !== "active") inact++;
    if (m.invalid_at) inact += 2;
  }
  var h = (n * 31 + sum * 131 + inact * 17) | 0;
  /* 抽样看正文长度：全量读字符串长度在 moejs 上太贵，抽样已足以捕捉
   * 快照整体换代（快照由离线管线整体重写，边界与中段几乎必然变化）。 */
  var step = n > 16 ? Math.ceil(n / 16) : 1;
  for (var j = 0; j < n; j += step) {
    var x = memories[j];
    if (!x) continue;
    h = (h * 31 + (x.title ? x.title.length : 0) + (x.content ? x.content.length : 0)) | 0;
  }
  return h;
}

function buildIndex(memories, now, version) {
  if (!memories || !memories.length) return null;
  /* 首选：离线管线在快照里带的版本号，O(1) 比较。
   * 兜底：没有版本号时才做一遍采样签名（仍远贵于版本号）。 */
  var key = version != null && version !== "" ? "v:" + version : "s:" + signatureOf(memories);
  if (_cache && _cacheKey === key) return _cache;

  var idx = {};
  var principles = [];
  for (var i = 0; i < memories.length; i++) {
    var m = memories[i];
    if (!isValid(m, now)) continue;

    /* 准则在建索引时一并抽出：放进缓存，避免每请求再全量扫一遍 */
    if (String(m.category) === "principle") {
      m._fresh = retention(m, now);
      principles.push(m);
    }

    var keys = {};
    if (m.project) keys[String(m.project).toLowerCase()] = 1;
    if (m.category) keys[String(m.category).toLowerCase()] = 1;
    if (m.entities) {
      var ents = String(m.entities).toLowerCase().split(/[\s,]+/);
      for (var e = 0; e < ents.length; e++) if (ents[e].length >= 2) keys[ents[e]] = 1;
    }
    if (m.tags) {
      var tags = String(m.tags).toLowerCase().split(",");
      for (var t = 0; t < tags.length; t++) {
        var tag = tags[t].replace(/^\s+|\s+$/g, "");
        if (tag.length >= 2) keys[tag] = 1;
      }
    }
    if (m.title) {
      var tw = tokenize(m.title);
      for (var w = 0; w < tw.length; w++) keys[tw[w]] = 1;
    }
    var ks = Object.keys(keys);
    for (var k = 0; k < ks.length; k++) {
      if (!idx[ks[k]]) idx[ks[k]] = [];
      idx[ks[k]].push(m);
    }
  }
  principles.sort(function (a, b) { return b._fresh - a._fresh; });
  _cache = { index: idx, principles: principles };
  _cacheKey = key;
  return _cache;
}

function lastUserText(messages) {
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    var c = messages[i].content;
    if (typeof c === "string") return cleanText(c);
    if (c && c.length) {
      var out = "";
      for (var j = 0; j < c.length; j++) {
        if (c[j] && c[j].type === "text") out += " " + cleanText(c[j].text);
      }
      return cleanText(out);
    }
  }
  return "";
}

/* ================= 词法命中分（字段加权） ================= */
function lexicalScore(m, tokens) {
  if (!tokens.length) return 0;
  var title = String(m.title || "").toLowerCase();
  var ents = String(m.entities || "").toLowerCase();
  var tags = String(m.tags || "").toLowerCase();
  var body = String(m.content || "").toLowerCase();
  var score = 0;
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (title.indexOf(t) !== -1) score += 5;   // 标题
    if (ents.indexOf(t) !== -1) score += 3;    // 实体
    if (tags.indexOf(t) !== -1) score += 3;    // 标签
    if (body.indexOf(t) !== -1) score += 1;    // 正文
  }
  return score;
}

/* ================= RRF 融合 =================
 * 把若干路「按排名」的候选合并成一个分。RRF 只吃排名不吃原始分，
 * 因此不需要在词法分、时间分、热度分之间做量纲归一化。
 */
function fuse(rankedLists, k) {
  var acc = {};
  var order = [];
  for (var l = 0; l < rankedLists.length; l++) {
    var list = rankedLists[l];
    if (!list || !list.items) continue;
    var w = list.weight == null ? 1 : list.weight;
    for (var r = 0; r < list.items.length; r++) {
      var id = list.items[r]._uid;
      if (!acc[id]) { acc[id] = { item: list.items[r], score: 0 }; order.push(id); }
      acc[id].score += w * (1.0 / (k + r + 1));
    }
  }
  var out = [];
  for (var i = 0; i < order.length; i++) out.push(acc[order[i]]);
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}

function byDesc(getter) {
  return function (a, b) { return getter(b) - getter(a); };
}

var SCOPE_AFFINITY = { turn: 4, session: 3, project: 2, user: 1 };

/* ================= 渲染 ================= */
function cut(s, n) {
  var v = String(s == null ? "" : s);
  return v.length > n ? v.slice(0, n) + "…" : v;
}

/* ================= onRequest ================= */
export function onRequest(body, ctx) {
  if (!body) return body;
  ctx = ctx || {};
  var opts = ctx.options || {};
  if (opts.disabled) return body;

  ctx.state = ctx.state || {};
  var messages = body.messages;
  if (!messages || !messages.length) return body;

  /* system 一律不碰（可能是字符串，也可能是 block 数组）。
   * 下面只读它来判断协议，不做任何写入。 */

  var prompt = lastUserText(messages);
  ctx.state.promptText = prompt;
  ctx.state.model = body.model;
  ctx.state.answer = "";
  ctx.state.harvested = 0;
  ctx.state.cardPrefix = opts.ccr_cards ? "card" : "full";
  ctx.state.inlineExtract = !!opts.inline_extract;
  ctx.state.memHold = 0;
  ctx.state.memBuf = "";
  ctx.opts = opts;

  var injected = "";
  var now = Date.now ? Date.now() : 0;

  /* --- ⓪ 上下文压缩（Headroom 思路的纯 JS 实现） ---
   * 只压历史里的工具输出与超长文本块，绝不动 system prompt 与最后一条用户消息。
   * 压缩模块内部有兜底：压完不比原文小就原样返回，且失败一律 fail-open。 */
  if (opts.compress !== false) {
    try {
      var cr = compressBody(body, {
        max_chars: parseInt(opts.compress_max_chars, 10) || 3000,
        min_chars: parseInt(opts.compress_min_chars, 10) || 1200
      });
      ctx.state.compressSaved = cr.saved;
      ctx.state.compressBefore = cr.before;
    } catch (e) {
      /* 压缩出任何问题都不能影响主流程 */
    }
  }

  /* --- ① 检索与注入 --- */
  if (prompt && opts.memories && opts.memories.length) {
    var built = buildIndex(opts.memories, now, opts.memories_version);
    var index = built && built.index;
    var tokens = tokenize(prompt);
    var finalList = [];

    /* 行为准则无条件置顶：
     * 它的价值在于「你还不知道会踩这个坑时就提醒你」，若也按关键词匹配，
     * 恰恰会在最需要它的场合缺席。用条数与字符双重封顶控制噪声。 */
    var principles = [];
    if (built && opts.inject_principles !== false) {
      var cap = parseInt(opts.max_principles, 10) || 2;
      for (var pi = 0; pi < built.principles.length && principles.length < cap; pi++) {
        principles.push(built.principles[pi]);
      }
    }

    if (index && tokens.length) {
      var seen = {};
      var cand = [];
      for (var i = 0; i < tokens.length; i++) {
        var bucket = index[tokens[i]];
        if (!bucket) continue;
        /* 桶内只取前 BUCKET_CAP 条：快照由离线管线按重要度预排序推送，
         * 桶前缀就是最相关的那些。这样宽查询（中文双字组几乎命中全部条目）
         * 也不会把单次开销拖成 O(全部记忆)。 */
        var lim = bucket.length > BUCKET_CAP ? BUCKET_CAP : bucket.length;
        for (var b = 0; b < lim; b++) {
          var m = bucket[b];
          var uid = String(m.id != null ? m.id : (m.project + ":" + m.title));
          if (seen[uid]) continue;
          seen[uid] = 1;
          m._uid = uid;
          m._lex = lexicalScore(m, tokens);
          if (m._lex > 0) {
            cand.push(m);
            if (cand.length >= HARD_CAND) break;
          }
        }
        if (cand.length >= HARD_CAND) break;
      }

      if (cand.length) {
        /* 词法命中为门槛：0 分的候选一律不注入（避免噪声） */
        var lexSorted = cand.slice().sort(byDesc(function (x) { return x._lex; }));

        /* 候选封顶：宽查询（如单字中文）可能命中上千条，全部拖进 RRF 排序
         * 会让单次开销失控。只保留词法分最高的 CAND_CAP 条参与融合。 */
        if (lexSorted.length > CAND_CAP) {
          lexSorted = lexSorted.slice(0, CAND_CAP);
          cand = lexSorted;
        }

        /* 排序键一次性预计算。
         * 千万不能在比较器里调 retention()：它内含 Date.parse，会被调
         * O(n log n) 次，在 moejs 上这是实测最大的单项开销。 */
        for (var q = 0; q < cand.length; q++) {
          var cq = cand[q];
          cq._fresh = retention(cq, now);
          cq._heat = (parseInt(cq.hits, 10) || 0) + (parseInt(cq.access_count, 10) || 0);
          cq._scope = SCOPE_AFFINITY[cq.scope] || 2;
        }
        var freshSorted = cand.slice().sort(byDesc(function (x) { return x._fresh; }));
        var heatSorted = cand.slice().sort(byDesc(function (x) { return x._heat; }));
        var scopeSorted = cand.slice().sort(byDesc(function (x) { return x._scope; }));

        /* RRF 四路融合：词法最重，新鲜度次之，热度与作用域为辅。
         * RRF 只吃「排名」不吃原始分，因此无需在词法分、时间分、
         * 热度分之间做量纲归一化——这正是它比加权求和稳的地方。 */
        finalList = fuse([
          { items: lexSorted, weight: 1.0 },
          { items: freshSorted, weight: 0.6 },
          { items: heatSorted, weight: 0.4 },
          { items: scopeSorted, weight: 0.3 }
        ], RRF_K).map(function (x) { return x.item; });
      }
    }

    if (principles.length || finalList.length) {
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

      for (var n = 0; n < finalList.length && used < maxItems; n++) {
        var it = finalList[n];
        if (String(it.category) === "principle") continue;  // 已在上面注入过
        var line;
        if (useCards && String(it.content || "").length > 160) {
          /* CCR：长内容只给摘要卡 + ID，Agent 需要时调 memory_expand 展开 */
          line = "- [" + (it.category || "fact") + "] " + cut(it.title, 60) +
                 ": " + cut(it.content, 120) +
                 " (id=" + it.id + "，需要完整内容可调 memory_expand)\n";
        } else {
          line = "- [" + (it.category || "fact") + "] " + cut(it.title, 120) +
                 ": " + cut(it.content, 400) + "\n";
        }
        if (block.length + line.length > budget) break;
        block += line;
        used++;
      }
      if (used) injected += block;
    }
  }

  /* --- ② 可选：内联提炼指令 ---
   *
   * 两条通路，优先走第一条：
   *
   *   ① 【直调工具】让 agent 用 memory_save 工具存 → 数据直接经 MCP 进库，
   *      不依赖任何外部进程。这是主路径。
   *
   *   ② 【<memory> 块】agent 手里没有这个工具时的兜底。中间件剥离该块并
   *      打印 [MEMORY_HARVEST]{json} 到网关 stdout，由 harvest.py 读走。
   *
   * 为什么把顺序反过来（早先只做 ②）：② 依赖「有人在跑 harvest.py」，而
   * 在 Docker 部署里网关 stdout 是容器管道、不是文件，没有进程能 tail 它，
   * 于是模型就算是乖乖输出了 <memory> 块，内容也永远进不了库。
   * ① 没有这个外部依赖，是唯一在容器里能自洽跑通的路径。
   */
  if (opts.inline_extract) {
    var toolName = PLUGIN_NAME + "_memory_save";
    injected +=
      "\n\n[Memory Instruction]\n" +
      "若本轮产生了值得跨会话复用的持久事实（偏好/事实/决策/实体/洞察），" +
      "用 `" + toolName + "` 工具把它存下来" +
      "（参数：category、title、content、tags、confidence）。" +
      "\n若你的工具列表里没有它，则改为在回复的最后追加一个 " +
      "<memory>JSON 数组</memory> 块，元素形如 " +
      '{"category":"fact|preference|context|entity|decision|insight","title":"...","content":"...","tags":"a,b","confidence":0.9}。' +
      "\n没有值得长期留存的内容时，两条都不要做（不要为了凑数而保存）。";
  }

  if (!injected) return body;

  /* --- ③ 落位：只改【尾部】，绝不碰 system prompt ---
   *
   * 硬不变量（来自 Headroom 的 CacheAligner，它们的注释里写明这条是用血泪换的）：
   *   「system prompt 是 provider KV-Cache 的热区，绝不能被修改」
   *   —— 一旦改了，整个前缀缓存失效，后续每一轮都要重新处理全部上下文，
   *      省下的记忆注入 token 远抵不上缓存失效的代价。
   *   Headroom 为此刻意把旧的「改写 system prompt」实现整个删掉了。
   *
   * 所以注入落在【最后一条用户消息】上：它之前的一切（system + 历史）
   * 保持字节不变，前缀缓存照常命中；注入内容也紧贴当前提问，注意力更好。
   * 这也是 Headroom Persistent Memory 的做法（prepend 到 user message）。
   *
   * 找不到可写的用户消息时就不注入 —— 宁可少注入，也不动缓存热区。 */
  for (var u = messages.length - 1; u >= 0; u--) {
    if (messages[u].role !== "user") continue;
    var mc = messages[u].content;
    if (typeof mc === "string") {
      messages[u].content = injected.replace(/^\s+/, "") + "\n\n" + mc;
      return body;
    }
    if (mc && mc.length) {
      /* Anthropic/OpenAI 的 content 可能是块数组：在最前面插一个文本块 */
      messages[u].content = [{ type: "text", text: injected.replace(/^\s+/, "") }].concat(mc);
      return body;
    }
    break;
  }
  return body;
}

/* ================= 从事件里取正文 ================= */
function pickText(obj) {
  if (!obj || typeof obj !== "object") return "";
  if (obj.choices && obj.choices.length) {
    var c = obj.choices[0];
    if (c.delta && typeof c.delta.content === "string") return c.delta.content;
    if (c.delta && c.delta.content && c.delta.content.length) {
      var acc = "";
      for (var i = 0; i < c.delta.content.length; i++) {
        if (c.delta.content[i] && c.delta.content[i].text) acc += c.delta.content[i].text;
      }
      return acc;
    }
    if (c.message && typeof c.message.content === "string") return c.message.content;
  }
  if (obj.type === "content_block_delta" && obj.delta && typeof obj.delta.text === "string") {
    return obj.delta.text;
  }
  if (obj.content && obj.content.length) {
    var out = "";
    for (var k = 0; k < obj.content.length; k++) {
      var blk = obj.content[k];
      if (blk && typeof blk.text === "string") out += blk.text;
      if (blk && blk.delta && typeof blk.delta.text === "string") out += blk.delta.text;
    }
    return out;
  }
  if (typeof obj.output_text === "string") return obj.output_text;
  return "";
}

function isFinish(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.choices && obj.choices.length && obj.choices[0].finish_reason) return true;
  if (obj.type === "message_stop" || obj.type === "response.completed") return true;
  return false;
}

/* ================= 写回事件正文（两种协议） ================= */
function setEventText(obj, text) {
  if (!obj || typeof obj !== "object") return;
  if (obj.choices && obj.choices.length) {
    var d = obj.choices[0].delta;
    if (d && typeof d.content === "string") { d.content = text; return; }
  }
  if (obj.type === "content_block_delta" && obj.delta && typeof obj.delta.text === "string") {
    obj.delta.text = text; return;
  }
}

/* ================= 流式剥离 <memory> 块 =================
 * 为什么必须在流的每一块上做：流式回复走 onEvent，onResponse 根本拿不到内容。
 * 而 agent 场景几乎全是流式——不解决这个，内联提炼就会把 <memory> 块喷给用户。
 *
 * 状态机（存在 ctx.state 里，随请求共享）：
 *   hold=0 透传；见到 "<memory" 前缀即进入 hold=1 并开始吞
 *   hold=1 吞掉直到 "</memory>"；若超过 HOLD_MAX 仍未闭合则【原样吐出】(fail-open)
 *   hold=2 已剥完，后续透传
 */
var HOLD_MAX = 20000;
var OPEN_TAG = "<memory";
var CLOSE_TAG = "</memory>";

function stripStream(piece, st) {
  /* 上一块扣住的半个标记必须先拼回来再判断，否则被切开的 "<mem"+"ory>"
   * 永远拼不完整，剥离直接失效（实测踩过）。 */
  if (st.memPending) {
    piece = st.memPending + (piece || "");
    st.memPending = "";
  }
  if (!piece) return piece;
  var hold = st.memHold || 0;

  if (hold === 0) {
    var i = piece.indexOf(OPEN_TAG);
    if (i === -1) {
      /* 还可能是 "<mem" 这种被切开的半个标记：先扣住尾部待定部分 */
      for (var L = Math.min(piece.length, OPEN_TAG.length - 1); L > 0; L--) {
        if (piece.slice(piece.length - L) === OPEN_TAG.slice(0, L)) {
          st.memPending = piece.slice(piece.length - L);
          return piece.slice(0, piece.length - L);
        }
      }
      return piece;
    }
    st.memHold = 1;
    st.memBuf = piece.slice(i);
    st.memHead = piece.slice(0, i);
    var end0 = st.memBuf.indexOf(CLOSE_TAG);
    if (end0 !== -1) {
      st.memHold = 2;   // 同一块内就闭合了
      var tail0 = st.memBuf.slice(end0 + CLOSE_TAG.length);
      st.memBuf = "";
      return st.memHead + tail0;
    }
    return st.memHead;
  }

  if (hold === 1) {
    st.memBuf += piece;
    var end = st.memBuf.indexOf(CLOSE_TAG);
    if (end !== -1) {
      st.memHold = 2;
      var tail = st.memBuf.slice(end + CLOSE_TAG.length);
      st.memBuf = "";
      return tail;
    }
    if (st.memBuf.length > HOLD_MAX) {
      /* 迟迟不闭合：判定为模型没按格式输出，原样吐出，绝不吞掉用户内容 */
      var flush = OPEN_TAG + st.memBuf;
      st.memHold = 0;
      st.memBuf = "";
      return flush;
    }
    return "";
  }

  /* hold=2：已剥离，但可能还有第二个块 */
  st.memHold = 0;
  return stripStream(piece, st);
}

/* ================= 交出一轮对话 ================= */
function harvest(ctx) {
  var st = ctx.state;
  if (!st || st.harvested) return;
  st.harvested = 1;
  var prompt = st.promptText || "";
  var answer = st.answer || "";
  if (prompt.length < 10 || answer.length < 80) return;   // 降噪门槛
  console.log(
    HARVEST_TAG +
      JSON.stringify({
        v: 5,
        model: st.model || "",
        prompt: prompt.slice(0, PROMPT_CAP),
        response: answer.slice(0, ANSWER_CAP),
        ts: Date.now ? Date.now() : 0
      })
  );
}

function stripMemoryBlock(text) {
  if (!text || text.indexOf("<memory") === -1) return text;
  return text.replace(/<memory>[\s\S]*?<\/memory>/gi, "").replace(/\n{3,}/g, "\n\n");
}

/* ================= onEvent：流式 ================= */
export function onEvent(event, ctx) {
  ctx = ctx || {};
  if (!ctx.state) return event;
  var st = ctx.state;
  var opts = ctx.opts || {};

  var piece = pickText(event);
  if (piece) {
    /* 抓取用【原始】文本（含 <memory>，供提炼） */
    var cur = st.answer || "";
    if (cur.length < ANSWER_CAP) st.answer = (cur + piece).slice(0, ANSWER_CAP + 200);

    /* 用户可见的部分去掉 <memory> 块 */
    if (st.inlineExtract) {
      var visible = stripStream(piece, st);
      if (visible !== piece) setEventText(event, visible);
    }
  }
  if (isFinish(event)) harvest(ctx);
  return event;
}

/* ================= onResponse：非流式 ================= */
export function onResponse(body, ctx) {
  if (!body) return body;
  ctx = ctx || {};
  ctx.state = ctx.state || {};
  var opts = ctx.options || {};

  var answer = pickText(body);
  if (answer) ctx.state.answer = answer;

  if (opts.inline_extract && answer && answer.indexOf("<memory") !== -1) {
    var stripped = stripMemoryBlock(answer);
    if (body.choices && body.choices.length && body.choices[0].message) {
      body.choices[0].message.content = stripped;
    } else if (body.content && body.content.length) {
      for (var i = 0; i < body.content.length; i++) {
        if (body.content[i] && typeof body.content[i].text === "string") {
          body.content[i].text = stripMemoryBlock(body.content[i].text);
        }
      }
    }
    ctx.state.answer = answer;  // 抓取侧保留完整文本（含 <memory>）
  }

  harvest(ctx);
  return body;
}
