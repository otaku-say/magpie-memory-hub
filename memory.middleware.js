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

/* 插件自己的包名 —— Magpie 把插件工具注册成 <包名>_<工具名>，
 * 所以这里要写全名，否则模型按 memory_save 去调会找不到工具。 */
var PLUGIN_NAME = "magpie-memory-hub";
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
  s = s.replace(/\[Memory Check[^\n\]]*\][\s\S]*?(?=\n\n|$)/gi, "");
  s = s.replace(/\[Memory Agent Guide[^\n\]]*\][\s\S]*?(?=\n\n|$)/gi, "");
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

/* ================= 时间解析辅助 ================= */
function parseTime(s) {
  if (!s) return NaN;
  var str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(str)) {
    str = str.replace(" ", "T") + (str.indexOf("Z") < 0 ? "Z" : "");
  }
  return Date.parse(str);
}

/* ================= 双时态：是否仍然有效 ================= */
function isValid(m, now) {
  if (!m) return false;
  if (m.lifecycle_status === "superseded") return false;
  if (m.invalid_at) {
    var it = parseTime(m.invalid_at);
    if (!isNaN(it) && it <= now) return false;
  }
  if (m.expires_at) {
    var et = parseTime(m.expires_at);
    if (!isNaN(et) && et <= now) return false;
  }
  return true;
}

/* ================= 艾宾浩斯保留率 =================
 * 强度 S 随命中次数对数增长，保留率 R = exp(-Δt / S)
 * 高频核心事实半衰期长，偶发噪音快速衰减。
 */
function retention(m, now) {
  var rc = parseInt(m.retrieval_count, 10);
  if (!rc || rc !== rc) rc = 0;
  var S = 1.0 * (1 + 1.5 * Math.log(1 + rc));
  var t = parseTime(m.updated_at || m.last_used_at || m.created_at || "");
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
    var rc = m.retrieval_count | 0;
    var st = m.lifecycle_status;
    sum = (sum + (m.id | 0) + rc * 7) | 0;
    if (st && st !== "active") inact++;
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
    var entsStr = m.related_entities;
    if (entsStr) {
      var ents = String(entsStr).toLowerCase().split(/[\s,]+/);
      for (var e = 0; e < ents.length; e++) if (ents[e].length >= 2) keys[ents[e]] = 1;
    }
    if (m.tags) {
      var tags = String(m.tags).toLowerCase().split(",");
      for (var t = 0; t < tags.length; t++) {
        var tag = tags[t].replace(/^\s+|\s+$/g, "");
        if (tag.length >= 2) keys[tag] = 1;
        var tagWords = tokenize(tag);
        for (var twi = 0; twi < tagWords.length; twi++) keys[tagWords[twi]] = 1;
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

/* ================= 多协议嗅探与统一遍历器 ================= */

/**
 * 协议嗅探（降级策略）：当 ctx.protocol 缺失或为空时，根据请求体结构自动嗅探协议类型
 */
function sniffProtocol(body, ctx) {
  if (ctx && typeof ctx.protocol === "string" && ctx.protocol.trim()) {
    return ctx.protocol.trim().toLowerCase();
  }
  if (body && typeof body === "object") {
    if (Array.isArray(body.contents)) return "gemini";
    if (body.input !== undefined) return "responses";
    if (Array.isArray(body.messages)) {
      if (body.system !== undefined) return "anthropic";
      return "chat";
    }
    if (body.systemInstruction || body.system_instruction) return "gemini";
  }
  return "chat";
}

/**
 * getLastUserTurn(body, protocol)
 * 返回定位到的「最后一条用户消息」的句柄，用于注入（前缀插入）与提取当前 prompt。
 * 纯同步、无依赖，符合 moejs 运行时约束。
 *
 * 协议支持：
 *   - chat / anthropic: body.messages (role: "user")
 *   - responses: body.input 为纯字符串或数组 (role: "user")
 *   - gemini: body.contents (role: "user" 或 role 缺失)
 */
function getLastUserTurn(body, protocol) {
  if (!body || typeof body !== "object") return null;
  var proto = String(protocol || "").toLowerCase();
  if (!proto) proto = sniffProtocol(body);

  // 1. Gemini: body.contents
  if (proto === "gemini" || Array.isArray(body.contents)) {
    var contents = Array.isArray(body.contents) ? body.contents : [];
    for (var i = contents.length - 1; i >= 0; i--) {
      var item = contents[i];
      if (!item || typeof item !== "object") continue;
      if (item.role && item.role !== "user") continue;
      var parts = Array.isArray(item.parts) ? item.parts : [];
      return {
        protocol: "gemini",
        turn: item,
        getText: function () {
          var out = "";
          for (var p = 0; p < parts.length; p++) {
            var pt = parts[p];
            if (pt && typeof pt.text === "string" && !pt.thought) {
              out += (out ? " " : "") + cleanText(pt.text);
            }
          }
          return cleanText(out);
        },
        prepend: function (injectedText) {
          if (!injectedText) return;
          var pfx = String(injectedText).replace(/^\s+/, "");
          if (!pfx) return;
          if (!Array.isArray(item.parts)) item.parts = [];
          if (item.parts.length > 0 && typeof item.parts[0].text === "string" && !item.parts[0].thought) {
            item.parts[0].text = pfx + "\n\n" + item.parts[0].text;
          } else {
            // Gemini schema: Part 对象只包含合法字段（例如 text），禁止插入 type 等非法字段
            item.parts.unshift({ text: pfx });
          }
        }
      };
    }
    return null;
  }

  // 2. OpenAI Responses: body.input (字符串或数组)
  if (proto === "responses" || body.input !== undefined) {
    if (typeof body.input === "string") {
      return {
        protocol: "responses",
        turn: body,
        getText: function () {
          return cleanText(body.input);
        },
        prepend: function (injectedText) {
          if (!injectedText) return;
          var pfx = String(injectedText).replace(/^\s+/, "");
          if (!pfx) return;
          body.input = pfx + "\n\n" + body.input;
        }
      };
    }
    if (Array.isArray(body.input)) {
      var inputItems = body.input;
      for (var j = inputItems.length - 1; j >= 0; j--) {
        var it = inputItems[j];
        if (!it || typeof it !== "object") continue;
        if (it.role !== "user") continue;
        return {
          protocol: "responses",
          turn: it,
          getText: function () {
            var c = it.content;
            if (typeof c === "string") return cleanText(c);
            if (Array.isArray(c)) {
              var out = "";
              for (var p = 0; p < c.length; p++) {
                var cp = c[p];
                if (cp && typeof cp.text === "string" && (cp.type === "input_text" || cp.type === "text" || !cp.type)) {
                  out += (out ? " " : "") + cleanText(cp.text);
                }
              }
              return cleanText(out);
            }
            return "";
          },
          prepend: function (injectedText) {
            if (!injectedText) return;
            var pfx = String(injectedText).replace(/^\s+/, "");
            if (!pfx) return;
            var c = it.content;
            if (typeof c === "string") {
              it.content = pfx + "\n\n" + c;
            } else if (Array.isArray(c)) {
              // Responses schema: user 输入块严格要求 type: "input_text"
              it.content = [{ type: "input_text", text: pfx }].concat(c);
            } else {
              it.content = [{ type: "input_text", text: pfx }];
            }
          }
        };
      }
      return null;
    }
    return null;
  }

  // 3. Chat / Anthropic: body.messages
  var msgs = Array.isArray(body.messages) ? body.messages : [];
  for (var u = msgs.length - 1; u >= 0; u--) {
    var m = msgs[u];
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user") continue;
    return {
      protocol: proto === "anthropic" ? "anthropic" : "chat",
      turn: m,
      getText: function () {
        var c = m.content;
        if (typeof c === "string") return cleanText(c);
        if (Array.isArray(c)) {
          var out = "";
          for (var p = 0; p < c.length; p++) {
            var pt = c[p];
            if (pt && pt.type === "text" && typeof pt.text === "string") {
              out += (out ? " " : "") + cleanText(pt.text);
            }
          }
          return cleanText(out);
        }
        return "";
      },
      prepend: function (injectedText) {
        if (!injectedText) return;
        var pfx = String(injectedText).replace(/^\s+/, "");
        if (!pfx) return;
        var c = m.content;
        if (typeof c === "string") {
          m.content = pfx + "\n\n" + c;
        } else if (Array.isArray(c)) {
          m.content = [{ type: "text", text: pfx }].concat(c);
        } else {
          m.content = pfx;
        }
      }
    };
  }
  return null;
}

/**
 * walkTurns(body, protocol, callback)
 * 统一遍历请求体中各轮次的文本内容，供标签剥离与提炼采集复用。
 * callback(text, setText, info)
 */
function walkTurns(body, protocol, fn) {
  if (!body || typeof body !== "object" || typeof fn !== "function") return;
  var proto = String(protocol || "").toLowerCase();
  if (!proto) proto = sniffProtocol(body);

  if (proto === "gemini" || Array.isArray(body.contents)) {
    var contents = Array.isArray(body.contents) ? body.contents : [];
    for (var i = 0; i < contents.length; i++) {
      var item = contents[i];
      if (!item || typeof item !== "object") continue;
      var role = item.role || "user";
      if (Array.isArray(item.parts)) {
        for (var p = 0; p < item.parts.length; p++) {
          var part = item.parts[p];
          if (part && typeof part.text === "string") {
            (function (pt, r, it) {
              fn(pt.text, function (newText) { pt.text = newText; }, { role: r, item: it, part: pt, protocol: "gemini" });
            })(part, role, item);
          }
        }
      }
    }
    return;
  }

  if (proto === "responses" || body.input !== undefined) {
    if (typeof body.input === "string") {
      fn(body.input, function (newText) { body.input = newText; }, { role: "user", item: body, protocol: "responses" });
      return;
    }
    if (Array.isArray(body.input)) {
      for (var j = 0; j < body.input.length; j++) {
        var itm = body.input[j];
        if (!itm || typeof itm !== "object") continue;
        var rRole = itm.role || "user";
        if (typeof itm.content === "string") {
          (function (it, r) {
            fn(it.content, function (newText) { it.content = newText; }, { role: r, item: it, protocol: "responses" });
          })(itm, rRole);
        } else if (Array.isArray(itm.content)) {
          for (var cp = 0; cp < itm.content.length; cp++) {
            var cpart = itm.content[cp];
            if (cpart && typeof cpart.text === "string") {
              (function (p, r, it) {
                fn(p.text, function (newText) { p.text = newText; }, { role: r, item: it, part: p, protocol: "responses" });
              })(cpart, rRole, itm);
            }
          }
        }
      }
      return;
    }
    return;
  }

  var msgs = Array.isArray(body.messages) ? body.messages : [];
  for (var m = 0; m < msgs.length; m++) {
    var msg = msgs[m];
    if (!msg || typeof msg !== "object") continue;
    var mRole = msg.role || "user";
    if (typeof msg.content === "string") {
      (function (it, r) {
        fn(it.content, function (newText) { it.content = newText; }, { role: r, item: it, protocol: proto });
      })(msg, mRole);
    } else if (Array.isArray(msg.content)) {
      for (var k = 0; k < msg.content.length; k++) {
        var blk = msg.content[k];
        if (blk && typeof blk.text === "string") {
          (function (p, r, it) {
            fn(p.text, function (newText) { p.text = newText; }, { role: r, item: it, part: p, protocol: proto });
          })(blk, mRole, msg);
        }
      }
    }
  }
}

function lastUserText(body, protocol) {
  if (Array.isArray(body)) {
    for (var i = body.length - 1; i >= 0; i--) {
      if (body[i] && body[i].role === "user") {
        var c = body[i].content;
        if (typeof c === "string") return cleanText(c);
        if (Array.isArray(c)) {
          var out = "";
          for (var j = 0; j < c.length; j++) {
            if (c[j] && c[j].type === "text") out += " " + cleanText(c[j].text);
          }
          return cleanText(out);
        }
      }
    }
    return "";
  }
  var turn = getLastUserTurn(body, protocol);
  return turn ? turn.getText() : "";
}

/* ================= 词法命中分（字段加权） ================= */
function lexicalScore(m, tokens) {
  if (!tokens.length) return 0;
  var title = String(m.title || "").toLowerCase();
  var ents = String(m.related_entities || "").toLowerCase();
  var tags = String(m.tags || "").toLowerCase();
  var body = String(m.content || "").toLowerCase();
  var score = 0;
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (title.indexOf(t) !== -1) score += 5;   // 标题
    if (ents.indexOf(t) !== -1) score += 3;    // 实体
    if (tags.indexOf(t) !== -1) score += 6;    // 标签/同义检索词加权
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
function onRequestInner(body, ctx) {
  if (!body || typeof body !== "object") return body;
  ctx = ctx || {};
  var opts = (ctx.options && typeof ctx.options === "object") ? ctx.options : {};

  if (!ctx.state || typeof ctx.state !== "object") ctx.state = {};

  var proto = (ctx && ctx.protocol) ? String(ctx.protocol).toLowerCase() : sniffProtocol(body, ctx);
  ctx.state.protocol = proto;

  var userTurn = getLastUserTurn(body, proto);
  if (!userTurn) return body;

  var prompt = userTurn.getText();

  /* ================= 存活探针 (__MEMHUB_PROBE__) =================
   * 依据：第三方插件 heaven-1314/magpie-plugin-claude-scrub 用 ctx.reject(418, msg) 做秒级存活确认。
   * ctx.reject 在状态码 400-599 时可阻断请求并返回消息。
   * 防御性调用：只有在 ctx.reject 为函数且最后一条用户消息恰好等于探针串 "__MEMHUB_PROBE__" 时触发。
   */
  if (prompt === "__MEMHUB_PROBE__" && typeof ctx.reject === "function") {
    var probePayload = {
      status: "ok",
      probe: "__MEMHUB_PROBE__",
      plugin: PLUGIN_NAME,
      version: "5.0", // db-col-ok: 存活探针版本
      disabled: !!opts.disabled,
      memories_count: (opts.memories && Array.isArray(opts.memories)) ? opts.memories.length : 0,
      compress: opts.compress === true,
      protocol: proto,
      turn_no: (Number(ctx.state.turnNo) || 0) + 1,
      timestamp: Date.now ? Date.now() : 0
    };
    return ctx.reject(418, JSON.stringify(probePayload));
  }

  if (opts.disabled) return body;

  /* system 一律不碰（可能是字符串，也可能是 block 数组）。
   * 保 KV-Cache 核心不变量：绝不改写 system prompt 与历史消息。 */
  ctx.state.promptText = prompt;
  ctx.state.model = body.model;
  ctx.state.cardPrefix = opts.ccr_cards ? "card" : "full";
  // 轮次号与来源 agent：供提炼指令的间隔控制与作用域过滤使用
  /* 注意：这里必须写 ctx.state，不能写 st。
   * 曾误写成 st（周边全是 ctx.state，改名的残留），导致 st is not defined，
   * onRequest 对【每一条正常对话】都抛异常 → 记忆注入从未生效、
   * 线上表现为插件列表里成片的中间件失败。 */
  ctx.state.turnNo = (Number(ctx.state.turnNo) || 0) + 1;
  ctx.state.agent = (ctx && ctx.agent) || ctx.state.agent || "";
  ctx.state.inlineExtract = !!opts.inline_extract;
  ctx.state.memHold = 0;
  ctx.state.memBuf = "";
  ctx.state.memPending = "";
  ctx.opts = opts;

  var injected = "";
  var now = Date.now ? Date.now() : 0;

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
          if (!isValid(m, now)) continue;
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
          cq._heat = (parseInt(cq.retrieval_count, 10) || 0);
          cq._scope = SCOPE_AFFINITY[cq.scope_level] || 2;
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
          /* CCR：长内容只给摘要卡 + ID，Agent 需要时调 memory_get 展开 */
          line = "- [" + (it.category || "fact") + "] " + cut(it.title, 60) +
                 ": " + cut(it.content, 120) +
                 " (id=" + it.id + "，需要完整内容可调 memory_get)\n";
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
   * 保存通路（按优先级）：
   *   ① 【直调工具】让 agent 用 memory_save / pitfall_save 存 → 数据经 MCP 直接进库（推荐路径）。
   *   ② 【网关自动采集】auto_harvest → Bun 宿主在对话结束后异步提炼入库（独立路径）。
   *
   * 注意：v6.24.0 起引导里【不再】要求「在回复末尾追加 <memory> 块」。
   * 实测该兜底诱发模型输出超大未闭合 <memory> 块，流式剥离扣留导致客户端只收到
   * keepalive 直至超时取消（499）。历史遗留的块仍由 stripStream / stripMemoryBlock
   * 做 fail-open 剥离（只剥闭合块，绝不吞正文），但不再主动引导模型产出块。
   *
   * ── 强度模式（照官方 middleware-system-prompt 的思路做成可配置）──
   * soft   ：现状语气「若产生了…」。被动，取决于模型是否意识到有东西值得存。
   * strict ：「每轮结束前检查」+ 给出具体清单。**实测观察：模型不存的原因往往
   *           不是不愿意，而是不确定什么算「值得长期留存」** —— 给清单能显著
   *           降低它的判断负担，从而提高合规率。
   * 另有 extract_agents / extract_models 两个作用域过滤（照 system-prompt 的
   * agents/models 设计），以及 extract_interval 控制注入频率以省 token。
   */
  var wantExtract = opts.inline_extract !== false;
  if (wantExtract) {
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

    if (wantExtract) {
      var saveTool = PLUGIN_NAME + "_memory_save";
      var pitfallTool = PLUGIN_NAME + "_pitfall_save";
      var ctxTool = PLUGIN_NAME + "_memory_context";
      var searchTool = PLUGIN_NAME + "_memory_search";
      var pitSearchTool = PLUGIN_NAME + "_pitfall_search";
      if (strength === "strict") {
        injected +=
          "\n\n[Memory Agent Guide —— 检索与沉淀]\n" +
          "1. 主动检索：涉及项目背景、历史规范、关键配置或排查报错时，优先主动调用 `" + ctxTool + "`（上下文召回）、`" + searchTool + "`（关键词语义检索）或 `" + pitSearchTool + "`（避坑经验匹配）。\n" +
          "2. 及时沉淀：结束本轮前检查是否产生了持久偏好、架构决策、环境事实或报错解法，若命中立即用 `" + saveTool + "` 存入（报错踩坑优先用 `" + pitfallTool + "`）；无工具调用能力时跳过保存，绝不在回复里输出 <memory> 标签块。\n" +
          "无相关需求时忽略本提示，绝不为了凑数操作。";
      } else {
        injected +=
          "\n\n[Memory Agent Guide]\n" +
          "- 遇项目背景、历史规范或报错时，主动调用 `" + ctxTool + "`、`" + searchTool + "` 或 `" + pitSearchTool + "` 检索记忆与避坑经验；\n" +
          "- 若产生了值得持久化的偏好/决策/事实/报错解法，调用 `" + saveTool + "`（或 `" + pitfallTool + "`）保存；无工具调用能力时跳过保存，绝不在回复里输出 <memory> 标签块。无需求请忽略。";
      }
    }
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
  /* 找不到可写的用户消息时就不注入 —— 宁可少注入，也不动缓存热区。 */
  userTurn.prepend(injected);
  return body;
}

/* ================= 从事件或响应里取正文（多协议支持） ================= */
function pickText(obj) {
  if (!obj || typeof obj !== "object") return "";

  // 1. OpenAI Chat: choices[0].delta or choices[0].message
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

  // 2. Anthropic: content_block_delta
  if (obj.type === "content_block_delta" && obj.delta && typeof obj.delta.text === "string") {
    return obj.delta.text;
  }

  // 3. OpenAI Responses 流式事件: response.output_text.delta
  if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
    return obj.delta;
  }
  if (obj.type === "response.output_text.done" && typeof obj.text === "string") {
    return obj.text;
  }

  // 4. Gemini 流式事件与响应: candidates[].content.parts[].text
  if (Array.isArray(obj.candidates) && obj.candidates.length) {
    var gOut = "";
    for (var gi = 0; gi < obj.candidates.length; gi++) {
      var cand = obj.candidates[gi];
      if (cand && cand.content && Array.isArray(cand.content.parts)) {
        for (var pi = 0; pi < cand.content.parts.length; pi++) {
          var gPart = cand.content.parts[pi];
          if (gPart && typeof gPart.text === "string" && !gPart.thought) {
            gOut += gPart.text;
          }
        }
      }
    }
    if (gOut) return gOut;
  }

  // 5. OpenAI Responses 非流式完整响应: body.output[].content[].text
  if (Array.isArray(obj.output) && obj.output.length) {
    var rOut = "";
    for (var oi = 0; oi < obj.output.length; oi++) {
      var oItem = obj.output[oi];
      if (oItem && Array.isArray(oItem.content)) {
        for (var ci = 0; ci < oItem.content.length; ci++) {
          var oPart = oItem.content[ci];
          if (oPart && typeof oPart.text === "string") {
            rOut += oPart.text;
          }
        }
      }
    }
    if (rOut) return rOut;
  }

  // 6. Anthropic 非流式响应: body.content[].text
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
  // 1. Chat
  if (obj.choices && obj.choices.length && obj.choices[0].finish_reason) return true;
  // 2. Anthropic
  if (obj.type === "message_stop") return true;
  if (obj.type === "message_delta" && obj.delta && obj.delta.stop_reason) return true;
  // 3. Responses
  if (obj.type === "response.completed" || obj.type === "response.done") return true;
  // 4. Gemini
  if (Array.isArray(obj.candidates) && obj.candidates.length && obj.candidates[0].finishReason) return true;
  return false;
}

/* ================= 写回事件正文（四种协议） ================= */
function setEventText(obj, text) {
  if (!obj || typeof obj !== "object") return;
  // 1. Chat
  if (obj.choices && obj.choices.length) {
    var c0 = obj.choices[0];
    if (!c0.delta) c0.delta = {};
    c0.delta.content = text;
    return;
  }
  // 2. Anthropic
  if (obj.type === "content_block_delta") {
    if (!obj.delta) obj.delta = {};
    obj.delta.text = text;
    return;
  }
  if (obj.type === "message_delta" || obj.type === "message_stop") {
    if (!obj.delta) obj.delta = {};
    obj.delta.text = text;
    return;
  }
  // 3. Responses
  if (obj.type === "response.output_text.delta" || (obj.type && obj.type.indexOf("response.") === 0)) {
    obj.delta = text;
    return;
  }
  // 4. Gemini: candidates[0].content.parts[0].text
  if (Array.isArray(obj.candidates) && obj.candidates.length) {
    var gc = obj.candidates[0];
    if (!gc.content) gc.content = {};
    if (!Array.isArray(gc.content.parts)) gc.content.parts = [];
    if (gc.content.parts.length === 0) {
      gc.content.parts.push({ text: text });
      return;
    }
    for (var j = 0; j < gc.content.parts.length; j++) {
      var p = gc.content.parts[j];
      if (p && !p.thought) {
        p.text = text;
        return;
      }
    }
    gc.content.parts.push({ text: text });
    return;
  }
}

/* ================= 流式剥离 <memory> 块 =================
 * 为什么必须在流的每一块上做：流式回复走 onEvent，onResponse 根本拿不到内容。
 * 而 agent 场景几乎全是流式——不解决这个，内联提炼就会把 <memory> 块喷给用户。
 *
 * 状态机（存在 ctx.state 里，随请求共享）：
 *   hold=0 透传；见到 "<memory" 前缀即进入 hold=1 并开始吞
 *   hold=1 吞掉直到 "</memory>"；若超过 HOLD_MAX 仍未闭合则【原样吐出】(fail-open)
 *   hold=-1 / memBypassed=true: 彻底禁用剥离，所有内容原样透传，绝不再扣留
 */
var HOLD_MAX = 20000;
var OPEN_TAG = "<memory";
var CLOSE_TAG = "</memory>";

function _stripStreamInner(piece, st) {
  /* 若该流已因超限熔断或标记跳过，绝不再做任何扣留，所有内容逐字节直通 */
  if (st.memBypassed || st.memHold === -1) {
    var prefix = (st.memPending || "") + (st.memBuf || "");
    st.memPending = "";
    st.memBuf = "";
    return prefix + (piece || "");
  }

  /* 上一块扣住的半个标记必须先拼回来再判断，否则被切开的 "<mem"+"ory>"
   * 永远拼不完整，剥离直接失效（实测踩过）。 */
  if (st.memPending) {
    piece = st.memPending + (piece || "");
    st.memPending = "";
  }
  if (!piece) return piece;
  var hold = st.memHold || 0;

  var holdLimit = (st && typeof st.holdMax === "number" && st.holdMax > 0) ? st.holdMax : HOLD_MAX;

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
    /* 【必须判定「是否真的像记忆块」再扣留】
     * 早先这里无条件进入扣留，于是模型只要在散文里【提到】这个标签
     * （例如「这个 <memory> 标签的作用是…」），后面的正文就全部被吞 ——
     * 用户界面上表现为回复在中途莫名其妙断掉（真实踩过两次）。
     * 判据：标签之后跳过空白，必须紧跟 "["（数组）或 "{"（单个对象），
     * 这才是本插件约定的记忆块格式；否则按普通正文原样输出。 */
    var head = piece.slice(0, i);
    var rem = piece.slice(i);
    var closeAngle = rem.indexOf(">");
    if (closeAngle === -1) {
      // "<memory" 尚未闭合 ">"，先扣留在 pending
      if (rem.length > 50) return piece;
      st.memPending = rem;
      return head;
    }

    var tagStr = rem.slice(0, closeAngle + 1);
    // 严格保证只认 <memory> 或 <memory >，防止 <memoryManagement> 被误判
    if (tagStr !== "<memory>" && !/^<memory\s*>$/i.test(tagStr)) {
      return head + tagStr + stripStream(rem.slice(closeAngle + 1), st);
    }

    var afterTag = rem.slice(closeAngle + 1);
    if (/^\s*$/.test(afterTag)) {
      // 标签后在本 chunk 全是空白，等待下一个 chunk 确认首个非空白字符
      if (rem.length > 100) return piece;
      st.memPending = rem;
      return head;
    }

    /* 必须判定「是否真的像记忆块」再扣留：
     * 跳过空白必须紧跟 "[" 或 "{"；若紧跟散文汉字/英文等，绝不扣留！原样吐出。 */
    if (!/^\s*[\[{]/.test(afterTag)) {
      return head + tagStr + stripStream(afterTag, st);
    }

    st.memHold = 1;
    st.memBuf = rem;
    st.memHead = head;
    var end0 = st.memBuf.indexOf(CLOSE_TAG);
    if (end0 !== -1) {
      st.memHold = 0;   // 同一块内就闭合了，重置状态并支持后续连续块
      var tail0 = st.memBuf.slice(end0 + CLOSE_TAG.length);
      st.memBuf = "";
      return st.memHead + (tail0 ? stripStream(tail0, st) : "");
    }
    // 未闭合：检查单 chunk 扣留量是否就已超限
    if (st.memBuf.length > holdLimit) {
      /* 单 chunk 即超限：立即把扣留内容原样吐出，且本流彻底禁用扣留 (fail-open) */
      var flush0 = st.memHead + st.memBuf;
      st.memHold = -1;
      st.memBypassed = true;
      st.memBuf = "";
      st.memPending = "";
      return flush0;
    }
    return st.memHead;
  }

  if (hold === 1) {
    st.memBuf += piece;
    var end = st.memBuf.indexOf(CLOSE_TAG);
    if (end !== -1) {
      st.memHold = 0;   // 块闭合了，恢复正常透传
      var tail = st.memBuf.slice(end + CLOSE_TAG.length);
      st.memBuf = "";
      return tail ? stripStream(tail, st) : "";
    }
    if (st.memBuf.length > holdLimit) {
      /* 迟迟不闭合且扣留超限：判定为模型没按格式闭合，立即把扣留内容原样吐出，且不再继续扣 (fail-open) */
      var flush = st.memBuf;
      st.memHold = -1;
      st.memBypassed = true;
      st.memBuf = "";
      st.memPending = "";
      return flush;
    }
    return "";
  }

  /* 兜底状态：重置后重走 */
  st.memHold = 0;
  return stripStream(piece, st);
}

function stripStream(piece, st) {
  try {
    return _stripStreamInner(piece, st);
  } catch (err) {
    /* 任何异常保命：释放全部已有扣留，原样拼接 piece，彻底禁用后续剥离 */
    var toRelease = (st.memPending || "") + (st.memBuf || "");
    st.memPending = "";
    st.memBuf = "";
    st.memHold = -1;
    st.memBypassed = true;
    return toRelease + (piece || "");
  }
}

function stripMemoryBlock(text) {
  if (!text || text.indexOf("<memory") === -1) return text;
  return text.replace(/<memory>\s*(?:\[|\{)[\s\S]*?<\/memory>/gi, "").replace(/\n{3,}/g, "\n\n");
}

/* ================= onEvent：流式 ================= */
function onEventInner(event, ctx) {
  ctx = ctx || {};
  if (!ctx.state) return event;
  var st = ctx.state;

  var piece = pickText(event);
  if (piece) {
    /* 用户可见的部分去掉 <memory> 块 */
    if (st.inlineExtract) {
      var visible = stripStream(piece, st);
      if (visible !== piece) setEventText(event, visible);
    }
  }
  if (isFinish(event)) {
    if (st.inlineExtract) {
      // 流结束保命：若有扣留未闭合的待定尾部或未闭合块，原样释放
      var toRelease = "";
      if (st.memPending) {
        toRelease += st.memPending;
        st.memPending = "";
      }
      if (st.memBuf) {
        toRelease += st.memBuf;
        st.memBuf = "";
        st.memHold = 0;
      }
      if (toRelease) {
        var curVis = pickText(event) || "";
        setEventText(event, curVis + toRelease);
      }
    }
  }
  return event;
}

/* ================= onResponse：非流式 ================= */
function onResponseInner(body, ctx) {
  if (!body) return body;
  ctx = ctx || {};
  ctx.state = ctx.state || {};
  var opts = ctx.options || {};

  var answer = pickText(body);

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
    } else if (Array.isArray(body.output)) {
      // Responses 协议输出
      for (var oi = 0; oi < body.output.length; oi++) {
        var oit = body.output[oi];
        if (oit && Array.isArray(oit.content)) {
          for (var ci = 0; ci < oit.content.length; ci++) {
            var cp = oit.content[ci];
            if (cp && typeof cp.text === "string") {
              cp.text = stripMemoryBlock(cp.text);
            }
          }
        }
      }
    } else if (Array.isArray(body.candidates)) {
      // Gemini 协议输出
      for (var gi = 0; gi < body.candidates.length; gi++) {
        var gc = body.candidates[gi];
        if (gc && gc.content && Array.isArray(gc.content.parts)) {
          for (var gp = 0; gp < gc.content.parts.length; gp++) {
            var part = gc.content.parts[gp];
            if (part && typeof part.text === "string") {
              part.text = stripMemoryBlock(part.text);
            }
          }
        }
      }
    }
  }

  return body;
}

/* ---------------- fail-open 外壳（最后一道防线） ----------------
 * 背景：插件的中间件跑在【用户的模型请求链路上】。一旦我们抛异常，
 * 轻则本次注入/剥离失效，重则整个请求失败 —— 后者绝不可接受。
 * 实测线上出现过 322 次失败（约 2.1%），而平均耗时仅 87µs，
 * 说明不是超时，而是某些输入形状不符预期时直接抛异常。
 *
 * 三道防线：
 *   ① 各函数内对所有外部数据做防御性取值
 *   ② 每个钩子用 try/catch 包住，异常一律降级为「不做任何改动」
 *   ③ 降级时只打印一行简短原因（不打印内容，避免泄露用户对话）
 */
var _mwErrLogged = 0;
function _mwFailOpen(name, e, fallback) {
  if (_mwErrLogged < 3) {           // 高频出错时别刷屏
    _mwErrLogged++;
    try {
      console.log("[memory-hub] " + name + " 已降级(fail-open): " +
        ((e && e.name) || "Error") + ": " + String((e && e.message) || e).slice(0, 160));
    } catch (_) { /* 连打印都不能抛 */ }
  }
  return fallback;
}

export function onRequest(body, ctx) {
  try { return onRequestInner(body, ctx); }
  catch (e) { return _mwFailOpen("onRequest", e, body); }
}

export function onEvent(event, ctx) {
  try { return onEventInner(event, ctx); }
  catch (e) {
    /* 顶层异常保命：若 ctx.state 里有扣留内容，必须释放到当前 event，绝不能丢用户内容 */
    if (ctx && ctx.state) {
      try {
        var toRelease = (ctx.state.memPending || "") + (ctx.state.memBuf || "");
        ctx.state.memPending = "";
        ctx.state.memBuf = "";
        ctx.state.memHold = -1;
        ctx.state.memBypassed = true;
        if (toRelease) {
          var curVis = pickText(event) || "";
          setEventText(event, toRelease + curVis);
        }
      } catch (_) {}
    }
    return _mwFailOpen("onEvent", e, event);
  }
}

export function onResponse(body, ctx) {
  try { return onResponseInner(body, ctx); }
  catch (e) { return _mwFailOpen("onResponse", e, body); }
}
