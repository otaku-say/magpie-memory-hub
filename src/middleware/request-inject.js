/**
 * 模块职责：请求前置拦截与记忆注入 (onRequestInner / onRequest)，包含协议嗅探、分词索引、RRF 排序与组装
 * 依赖：./inject-builder.js, ./stream-utils.js
 * 被依赖：./memory.middleware.js, 根目录 memory.middleware.js
 */
import { buildContextBlock, buildAgentGuide } from "./inject-builder.js";
import { _mwFailOpen } from "./stream-utils.js";

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
function splitCamelCase(word) {
  if (!word || typeof word !== "string") return [];
  var s = word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z0-9])/g, "$1 $2");
  var parts = s.split(/\s+/);
  var res = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].toLowerCase();
    if (p.length >= 2) res.push(p);
  }
  return res;
}

function tokenize(text) {
  var rawStr = String(text || "");
  var runs = rawStr.match(/[a-zA-Z0-9_-]{2,}|[\u4e00-\u9fff]+/g) || [];
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
    } else {
      var lower = t.toLowerCase();
      if (!seen[lower]) {
        seen[lower] = 1;
        out.push(lower);
      }
      // a) snake_case / kebab-case 裂变
      if (t.indexOf("_") !== -1 || t.indexOf("-") !== -1) {
        var segs = t.split(/[_-]+/);
        for (var si = 0; si < segs.length; si++) {
          var seg = segs[si];
          var segLower = seg.toLowerCase();
          if (segLower.length >= 2 && !seen[segLower]) {
            seen[segLower] = 1;
            out.push(segLower);
          }
          var subCamel = splitCamelCase(seg);
          for (var sci = 0; sci < subCamel.length; sci++) {
            var sc = subCamel[sci];
            if (!seen[sc]) { seen[sc] = 1; out.push(sc); }
          }
        }
        var stripped = lower.replace(/[_-]+/g, "");
        if (stripped.length >= 2 && !seen[stripped]) {
          seen[stripped] = 1;
          out.push(stripped);
        }
      }
      // b) camelCase 裂变
      var camels = splitCamelCase(t);
      for (var ci = 0; ci < camels.length; ci++) {
        var cItem = camels[ci];
        if (!seen[cItem]) { seen[cItem] = 1; out.push(cItem); }
      }
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
  var tUpd = parseTime(m.updated_at || "");
  var tUsed = parseTime(m.last_used_at || "");
  var validUpd = !isNaN(tUpd) && tUpd > 0;
  var validUsed = !isNaN(tUsed) && tUsed > 0;
  var t;
  if (validUpd && validUsed) {
    t = Math.max(tUsed, tUpd);
  } else if (validUsed) {
    t = tUsed;
  } else if (validUpd) {
    t = tUpd;
  } else {
    t = parseTime(m.created_at || "");
  }
  if (isNaN(t) || !t) return 1;
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

function countUserTurns(body) {
  var count = 0;
  if (body && typeof body === "object") {
    if (Array.isArray(body.messages)) {
      for (var i = 0; i < body.messages.length; i++) {
        if (body.messages[i] && body.messages[i].role === "user") {
          count++;
        }
      }
    } else if (Array.isArray(body.contents)) {
      for (var j = 0; j < body.contents.length; j++) {
        var it = body.contents[j];
        if (it && (it.role === "user" || !it.role)) {
          count++;
        }
      }
    } else if (Array.isArray(body.input)) {
      for (var k = 0; k < body.input.length; k++) {
        if (body.input[k] && body.input[k].role === "user") {
          count++;
        }
      }
    }
  }
  return Math.max(1, count);
}

function buildIndex(memories, now, version, project) {
  if (!memories || !memories.length) return null;
  var currentProject = String(project || "").trim();
  /* 首选：离线管线在快照里带的版本号，O(1) 比较。
   * 兜底：没有版本号时才做一遍采样签名（仍远贵于版本号）。 */
  var key = (version != null && version !== "" ? "v:" + version : "s:" + signatureOf(memories)) + ":p:" + currentProject;
  if (_cache && _cacheKey === key) return _cache;

  var idx = {};
  var principles = [];
  for (var i = 0; i < memories.length; i++) {
    var m = memories[i];
    if (!isValid(m, now)) continue;

    if (currentProject) {
      var rowProject = String((m && m.project) || "global").trim();
      if (rowProject !== currentProject && rowProject !== "global") {
        continue;
      }
    }

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
  var calculatedTurnNo = countUserTurns(body);
  ctx.state.turnNo = calculatedTurnNo;

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
      protocol: proto,
      turn_no: calculatedTurnNo,
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
  ctx.state.turnNo = calculatedTurnNo;
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
    var built = buildIndex(opts.memories, now, opts.memories_version, opts.project);
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
        /* EVO-8：词法同分时用热度（retrieval_count + 复发加权）打破平局。
         * 若只靠 RRF 融合，词法权重 1.0 远高于热度 0.4，同分时名次由输入顺序决定，
         * 会导致「多次印证的经验」无法优先胜出，与 EVO-8 目标相悖。
         * 这里仅作为【同分】的次级排序键，不改变不同分之间的相对次序。 */
        var lexSorted = cand.slice().sort(function (a, b) {
          if (b._lex !== a._lex) return b._lex - a._lex;
          // 注意：_heat 的赋值在本轮排序之后才执行，故此处必须就地现算，
          // 否则比较时两侧均为 undefined，tie-break 完全失效。
          var ha = (function (o) {
            var rc = parseInt(o.retrieval_count, 10); if (!rc || rc !== rc || rc < 0) rc = 0;
            var rec = parseInt(o.recurrence, 10); if (!rec || rec !== rec || rec < 1) rec = 1;
            return rc + (rec - 1) * 2;
          })(a);
          var hb = (function (o) {
            var rc = parseInt(o.retrieval_count, 10); if (!rc || rc !== rc || rc < 0) rc = 0;
            var rec = parseInt(o.recurrence, 10); if (!rec || rec !== rec || rec < 1) rec = 1;
            return rc + (rec - 1) * 2;
          })(b);
          return hb - ha;
        });

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
          var rc = parseInt(cq.retrieval_count, 10);
          if (!rc || rc !== rc || rc < 0) rc = 0;
          var rec = parseInt(cq.recurrence, 10);
          if (!rec || rec !== rec || rec < 1) rec = 1;
          cq._heat = rc + (rec - 1) * 2;
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


    var ctxBlock = buildContextBlock(principles, finalList, opts);
    if (ctxBlock) injected += ctxBlock;
  }

  /* --- ② 可选：内联提炼指令 --- */
  var guideBlock = buildAgentGuide(prompt, opts, body, ctx);
  if (guideBlock) injected += guideBlock;

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
  userTurn.prepend(injected);
  return body;
}

export function onRequest(body, ctx) {
  try { return onRequestInner(body, ctx); }
  catch (e) { return _mwFailOpen("onRequest", e, body); }
}

