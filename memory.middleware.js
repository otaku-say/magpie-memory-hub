/**
 * memory.middleware.js — Magpie Gateway Middleware v2.0
 *
 * 运行环境: Go moejs（纯同步，禁止 fetch/timer/async）
 * 职责:
 *   onRequest  — 从 ctx.options.memories 中匹配相关记忆，注入到 system prompt
 *   onResponse — 提取对话 payload，通过 console.log 输出给外部 harvester 消费
 */

var _cachedIndex = null;
var _cachedRef = null;

// ---- 噪声清洗（Context-Mode pattern）----
function clean(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, "")
    .replace(/<context_guidance>[\s\S]*?<\/context_guidance>/gi, "")
    .replace(/\[system-reminder\][\s\S]*?\[\/system-reminder\]/gi, "")
    .replace(/\[Persistent Memory Context[\s\S]*?(?=\n\n|\n[A-Z]|$)/gi, "")
    .trim();
}

// ---- 倒排索引构建 ----
function buildIndex(memories) {
  if (!memories || !memories.length) return null;
  if (_cachedIndex && _cachedRef === memories) return _cachedIndex;

  var idx = {};
  for (var i = 0; i < memories.length; i++) {
    var m = memories[i];
    if (!m || m.status === "superseded") continue;
    var keys = {};
    if (m.project) keys[m.project.toLowerCase()] = 1;
    if (m.category) keys[m.category.toLowerCase()] = 1;
    if (m.tags) {
      var ts = m.tags.toLowerCase().split(",");
      for (var t = 0; t < ts.length; t++) {
        var tag = ts[t].trim();
        if (tag.length >= 2) keys[tag] = 1;
      }
    }
    // 标题分词
    if (m.title) {
      var words = m.title.toLowerCase().match(/[a-z0-9\u4e00-\u9fff_-]{2,}/g) || [];
      for (var w = 0; w < words.length; w++) keys[words[w]] = 1;
    }
    var ks = Object.keys(keys);
    for (var k = 0; k < ks.length; k++) {
      if (!idx[ks[k]]) idx[ks[k]] = [];
      idx[ks[k]].push(m);
    }
  }
  _cachedIndex = idx;
  _cachedRef = memories;
  return idx;
}

// ---- 提取最后一条用户消息 ----
function lastUserText(messages) {
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      var c = messages[i].content;
      if (typeof c === "string") return clean(c);
      if (Array.isArray(c)) {
        var out = "";
        for (var j = 0; j < c.length; j++) {
          if (c[j].type === "text") out += " " + clean(c[j].text);
        }
        return out.trim();
      }
    }
  }
  return "";
}

// ==== onRequest: 注入相关记忆到 system prompt ====
export function onRequest(body, ctx) {
  if (!body) return body;
  ctx = ctx || {};
  var opts = ctx.options || {};
  if (opts.disabled) return body;
  ctx.state = ctx.state || {};

  var messages = body.messages;
  if (!messages || !Array.isArray(messages) || !messages.length) return body;

  var prompt = lastUserText(messages);
  ctx.state.prompt = prompt;
  ctx.state.model = body.model;
  if (!prompt) return body;

  // 查倒排索引
  var index = buildIndex(opts.memories);
  if (!index) return body;

  var tokens = prompt.toLowerCase().match(/[a-z0-9\u4e00-\u9fff_-]{2,}/g) || [];
  if (!tokens.length) return body;

  var seen = {};
  var hits = [];
  for (var w = 0; w < tokens.length; w++) {
    var bucket = index[tokens[w]];
    if (!bucket) continue;
    for (var h = 0; h < bucket.length; h++) {
      var item = bucket[h];
      var uid = item.id || (item.project + ":" + item.title);
      if (seen[uid]) continue;
      seen[uid] = 1;
      // Mem0 排名分 = confidence * (1 + 0.1 * min(access_count, 10))
      var score = (parseFloat(item.confidence_score) || 1) * (1 + 0.1 * Math.min(parseInt(item.access_count) || 0, 10));
      item._score = score;
      hits.push(item);
    }
  }
  if (!hits.length) return body;

  hits.sort(function(a, b) { return (b._score || 0) - (a._score || 0); });

  var max = opts.max_inject_count || 5;
  var budget = opts.max_budget_chars || 2048;
  var block = "\n\n[Persistent Memory Context]\n";
  var count = 0;
  for (var m = 0; m < hits.length && count < max; m++) {
    var it = hits[m];
    var line = "- [" + (it.category || "fact") + "] " + it.title + ": " + it.content + "\n";
    if (block.length + line.length > budget) break;
    block += line;
    count++;
  }

  // 注入 system prompt
  var protocol = ctx.protocol || "chat";
  if (protocol === "anthropic") {
    body.system = (typeof body.system === "string" ? body.system : "") + block;
  } else {
    var injected = false;
    for (var s = 0; s < messages.length; s++) {
      if (messages[s].role === "system") {
        messages[s].content += block;
        injected = true;
        break;
      }
    }
    if (!injected) {
      messages.unshift({ role: "system", content: block.trim() });
    }
  }
  return body;
}

// ==== onResponse: 输出对话 payload 给外部 harvester ====
export function onResponse(body, ctx) {
  if (!body) return body;
  ctx = ctx || {};
  ctx.state = ctx.state || {};

  var assistant = "";
  if (body.choices && body.choices.length > 0) {
    var c = body.choices[0];
    if (c.message && c.message.content) assistant = c.message.content;
  }

  // 只处理有实质内容的对话
  if (ctx.state.prompt && assistant && assistant.length > 50) {
    var payload = {
      model: ctx.state.model || "",
      prompt: ctx.state.prompt.slice(0, 2000),
      response: assistant.slice(0, 4000),
      ts: Date.now()
    };
    console.log("[MEMORY_HARVEST]" + JSON.stringify(payload));
  }
  return body;
}
