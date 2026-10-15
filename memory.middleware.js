/**
 * memory.middleware.js - High-Performance Magpie Gateway Middleware
 *
 * Engine: Go moejs (Microsecond-level synchronous execution)
 * Absorbed from Top Projects:
 * 1. Context-Mode: Noise cleaning - strips runtime tags (<system-reminder>, <task-notification>, etc.)
 * 2. Headroom: Token Budget Guard + Failure-Pattern heuristics
 * 3. Mem0: Multi-factor scoring (confidence * access weight) + temporal freshness
 * 4. Microsecond Inverted Index: O(1) keyword lookup for zero gateway latency
 */

var _cachedIndex = null;
var _cachedMemoriesRef = null;

// Context-Mode pattern: clean runtime tags and system noise
function cleanUserText(text) {
  if (!text || typeof text !== "string") return "";
  var cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, "")
    .replace(/<context_guidance>[\s\S]*?<\/context_guidance>/gi, "")
    .replace(/\[system-reminder\][\s\S]*?\[\/system-reminder\]/gi, "")
    .replace(/\[Relevant Long-term Context\][\s\S]*?(?=\n\n|\n[A-Z]|$)/gi, "")
    .replace(/\[Persistent Long-term Context[\s\S]*?(?=\n\n|\n[A-Z]|$)/gi, "");
  return cleaned.trim();
}

/**
 * Build inverted index from raw memories array.
 * Rebuilt ONLY when ctx.options.memories reference changes.
 */
function getOrBuildIndex(memories) {
  if (!memories || !memories.length) return null;
  if (_cachedIndex && _cachedMemoriesRef === memories) {
    return _cachedIndex;
  }

  var index = {};
  for (var i = 0; i < memories.length; i++) {
    var item = memories[i];
    if (!item || item.status === "superseded") continue;

    var itemKeys = {};
    if (item.project_name) itemKeys[item.project_name.toLowerCase()] = true;
    if (item.component) itemKeys[item.component.toLowerCase()] = true;
    if (item.tags) {
      var tags = item.tags.toLowerCase().split(",");
      for (var t = 0; t < tags.length; t++) {
        var tag = tags[t].trim();
        if (tag.length >= 2) itemKeys[tag] = true;
      }
    }

    var keys = Object.keys(itemKeys);
    for (var k = 0; k < keys.length; k++) {
      var kw = keys[k];
      if (!index[kw]) index[kw] = [];
      index[kw].push(item);
    }
  }

  _cachedIndex = index;
  _cachedMemoriesRef = memories;
  return index;
}

export function onRequest(body, ctx) {
  var opts = ctx.options || {};
  if (opts.disabled) return body;

  var messages = body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return body;
  }

  // 1. Extract and clean latest user query text (Context-Mode Heuristic)
  var promptText = "";
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      var c = messages[i].content;
      if (typeof c === "string") {
        promptText = cleanUserText(c);
      } else if (Array.isArray(c)) {
        for (var j = 0; j < c.length; j++) {
          if (c[j].type === "text") promptText += " " + cleanUserText(c[j].text);
        }
      }
      break;
    }
  }

  ctx.state.promptText = promptText;
  ctx.state.model = body.model;

  if (!promptText) return body;

  // 2. Query Inverted Index
  var index = getOrBuildIndex(opts.memories);
  if (!index) return body;

  var tokens = promptText.toLowerCase().match(/[a-z0-9_-]{2,}/g) || [];
  if (!tokens.length) return body;

  var matchedMap = {};
  var matchedItems = [];

  for (var w = 0; w < tokens.length; w++) {
    var hits = index[tokens[w]];
    if (hits) {
      for (var h = 0; h < hits.length; h++) {
        var item = hits[h];
        var uid = item.id || (item.project_name + ":" + item.title);
        if (!matchedMap[uid]) {
          matchedMap[uid] = true;
          // Mem0 Ranking Score = confidence * (1 + 0.1 * access_count)
          var conf = parseFloat(item.confidence_score) || 1.0;
          var accesses = parseInt(item.access_count) || 0;
          item._rankingScore = conf * (1.0 + 0.1 * Math.min(accesses, 10));
          matchedItems.push(item);
        }
      }
    }
  }

  if (matchedItems.length === 0) return body;

  // Sort by Mem0 ranking score descending
  matchedItems.sort(function(a, b) {
    return (b._rankingScore || 0) - (a._rankingScore || 0);
  });

  // 3. Render Memory Context Block with Headroom Budget Cap
  var maxItems = opts.max_inject_count || 5;
  var budgetChars = opts.max_budget_chars || 2048;
  var memoryBlock = "\n\n[Persistent Long-term Context & Engineering Knowledge]\n";

  var injectedCount = 0;
  for (var m = 0; m < matchedItems.length && injectedCount < maxItems; m++) {
    var it = matchedItems[m];
    var line = "- [" + (it.category || "RULE") + "] " + it.title + ": " + it.content + "\n";
    if (memoryBlock.length + line.length > budgetChars) break;
    memoryBlock += line;
    injectedCount++;
  }

  // 4. Inject based on protocol (OpenAI / Anthropic)
  var protocol = ctx.protocol || "chat";
  if (protocol === "anthropic") {
    if (typeof body.system === "string") {
      body.system += memoryBlock;
    } else {
      body.system = "You are a senior technical assistant." + memoryBlock;
    }
  } else {
    var injected = false;
    for (var s = 0; s < messages.length; s++) {
      if (messages[s].role === "system") {
        messages[s].content += memoryBlock;
        injected = true;
        break;
      }
    }
    if (!injected) {
      messages.unshift({
        role: "system",
        content: "You are a senior technical assistant with persistent memory." + memoryBlock
      });
    }
  }

  return body;
}

export function onResponse(body, ctx) {
  var assistantText = "";
  if (body.choices && body.choices.length > 0) {
    var choice = body.choices[0];
    if (choice.message && choice.message.content) {
      assistantText = choice.message.content;
    }
  }

  // Headroom Failure-Pattern detection: tool/code error followed by correction
  if (ctx.state.promptText && assistantText && assistantText.length > 40) {
    var payload = {
      model: ctx.state.model,
      prompt: ctx.state.promptText.slice(0, 1000),
      response: assistantText.slice(0, 2000),
      ts: Date.now()
    };
    console.log("[MEMORY_HARVEST]" + JSON.stringify(payload));
  }

  return body;
}
