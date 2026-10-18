/**
 * compress.js — 上下文压缩模块（Headroom 思路的纯 JS 实现）
 * ==========================================================
 * 为什么必须纯 JS：本模块运行在 Magpie 网关进程内的 moejs 引擎里，
 * 没有网络、没有子进程、不能加载原生模块或 WASM，且 onRequest 只有 250ms。
 *
 * 因此只实现 Headroom 管线中「纯算法可做」的部分，并明确标注做不到的：
 *   ✅ ContentRouter  —— 判断内容类型，分流到不同压缩器
 *   ✅ SmartCrusher   —— JSON 结构化压缩（工具输出是 Token 大头，收益最高）
 *   ✅ LogCrush       —— 日志/文本启发式压缩（保错误与关键行，丢噪声）
 *   ✅ CacheAligner   —— 标记易变内容，避免破坏上游 KV-Cache 前缀
 *   ✅ 预算硬控        —— 整包 Token 预算兜底
 *   ❌ Kompress-v2    —— ModernBERT INT8 ONNX，moejs 跑不了（放到离线管线）
 *   ❌ CodeCompressor —— 需要 tree-sitter/AST，moejs 跑不了
 */

/* ---------------- 内容类型判定（ContentRouter） ---------------- */
/* Git status / diff 输出【绝不压缩】：
 * 它们是结构化的状态快照，丢一行未暂存文件就会让 agent 做出灾难性误判。
 * （Headroom 的 ContentRouter 对这两类走 Lossless Passthrough） */
var GIT_STATUS_RE = /(^|\n)\s*(On branch |HEAD detached|Your branch is |Changes to be committed:|Changes not staged for commit:|Untracked files:|nothing to commit|no changes added to commit)/;
var GIT_DIFF_RE = /(^|\n)(diff --git |@@ -\d+|index [0-9a-f]+\.\.)/;

function detectKind(s) {
  if (!s || typeof s !== "string") return "raw";
  var t = s.replace(/^\s+/, "");
  if (!t.length) return "raw";
  if (GIT_STATUS_RE.test(s)) return "verbatim";
  if (GIT_DIFF_RE.test(s)) return "verbatim";
  var c = t.charCodeAt(0);
  if (c === 123 || c === 91) {           // { 或 [
    if (/^\s*[\[{][\s\S]*[\]}]\s*$/.test(t)) return "json";
  }
  if (/^(traceback|error|warning|\d{4}-\d{2}-\d{2}[ T])/im.test(t)) return "log";
  if (/^(diff --git|@@ |[+\-]{3} )/m.test(t)) return "diff";
  if (/(^|\n)\s*(def |class |function |import |package |#include|using )/m.test(t)) return "code";
  return "prose";
}

/* ---------------- 长字符串截断 ---------------- */
function cutStr(s, max) {
  if (typeof s !== "string") return s;
  if (s.length <= max) return s;
  var head = Math.floor(max * 0.6);
  var tail = max - head;
  return s.slice(0, head) + "\n…[已省略 " + (s.length - max) + " 字符]…\n" + s.slice(s.length - tail);
}

/* ---------------- SmartCrusher：JSON 结构化压缩 ---------------- */
/* 阈值照抄 Headroom SmartCrusher 的默认值（transforms/smart_crusher.py） */
var CRUSH = {
  maxString: 800,        // 单个字符串值上限
  maxArray: 15,          // 数组最多保留条数（= max_items_after_crush）
  minArray: 5,           // 少于此条数的数组不压（= min_items_to_analyze）
  maxDepth: 8,           // 最大深度
  maxKeys: 60,           // 对象最多保留多少键
  varianceThreshold: 2.0,// 标准差倍数（异常判定）
  firstFraction: 0.3,    // 配额：开头留 30%
  lastFraction: 0.15,    // 配额：结尾留 15%（余下 55% 给「重要项」）
  dedupIdentical: true,  // 完全相同项只留一份（= dedup_identical_items）
  logTemplateDedup: true // 日志内容模板去重开关（= log_template_dedup）
};

/* 「异常项」永远保留，且是【加法式】的：即使超出配额也不丢。
 * 依据 Headroom 的保证：error 项 / 数值异常 / 长度异常 / 变化点
 * 在【所有数组类型】里都必须留下——工具输出里最关键的恰恰是它们。 */
var ERROR_RE = /\b(error|errors|exception|failed|failure|critical|fatal|panic|traceback|refused|denied|timeout|timed out|abort|corrupt|invalid|mismatch)\b/i;

/** 取一个可比较的数值特征：数字用它本身，字符串用长度，对象用其可数值字段之和/序列化长度 */
function featureOf(v) {
  var t = typeof v;
  if (t === "number") return isFinite(v) ? v : null;
  if (t === "boolean") return v ? 1 : 0;
  if (t === "string") return v.length;
  if (v === null || v === undefined) return null;
  // 对象：优先找第一个数值字段，找不到就用序列化后的长度
  try {
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) {
      var x = v[keys[i]];
      if (typeof x === "number" && isFinite(x)) return x;
    }
    var j = JSON.stringify(v);
    return j ? j.length : null;
  } catch (e) { return null; }
}

/** 受保护项的下标集合：error 项 + 数值/长度异常 + 变化点 */
function protectedIndices(arr) {
  var n = arr.length, keep = {};
  var feats = [];
  for (var i = 0; i < n; i++) feats.push(featureOf(arr[i]));
  var valid = [];
  for (var j = 0; j < n; j++) if (feats[j] !== null) valid.push(feats[j]);
  var mean = null, std = null;
  if (valid.length >= 2) {
    var sum = 0;
    for (var k = 0; k < valid.length; k++) sum += valid[k];
    mean = sum / valid.length;
    var ss = 0;
    for (var m = 0; m < valid.length; m++) { var d = valid[m] - mean; ss += d * d; }
    std = Math.sqrt(ss / valid.length);
  }
  for (var a = 0; a < n; a++) {
    if (isErrorItem(arr[a])) { keep[a] = 1; continue; }
    var f = feats[a];
    if (f !== null && std !== null && std > 0 && Math.abs(f - mean) > CRUSH.varianceThreshold * std) keep[a] = 1;
    if (f !== null && std !== null && std > 0 && a > 0 && feats[a - 1] !== null &&
        Math.abs(f - feats[a - 1]) > CRUSH.varianceThreshold * std) { keep[a] = 1; keep[a - 1] = 1; }
  }
  return keep;
}

/** 审计：受保护项是否都在保留集里。缺任何一项即判定本次压缩不安全。 */
function auditSafe(arr, guard, keptIdx) {
  var got = {};
  for (var i = 0; i < keptIdx.length; i++) got[keptIdx[i]] = 1;
  var keys = Object.keys(guard);
  for (var j = 0; j < keys.length; j++) {
    if (!got[keys[j]]) return false;
  }
  return true;
}

function isErrorItem(v) {
  try {
    var t = typeof v === "string" ? v : JSON.stringify(v);
    return t ? ERROR_RE.test(t) : false;
  } catch (e) { return false; }
}

/**
 * 选要保留的下标。返回升序数组（保持原始顺序，避免重排造成语义漂移）。
 * 加法式：异常项先占位，再按配额补首尾与重要项。
 */
function pickIndices(arr) {
  var n = arr.length;
  var keep = {};
  var keptCount = 0;

  /* ① 异常项：无条件保留，不占配额 */
  var feats = [];
  for (var i = 0; i < n; i++) feats.push(featureOf(arr[i]));
  var valid = [];
  for (var j = 0; j < n; j++) if (feats[j] !== null) valid.push(feats[j]);

  var mean = null, std = null;
  if (valid.length >= 2) {
    var sum = 0;
    for (var k = 0; k < valid.length; k++) sum += valid[k];
    mean = sum / valid.length;
    var ss = 0;
    for (var m = 0; m < valid.length; m++) { var d = valid[m] - mean; ss += d * d; }
    std = Math.sqrt(ss / valid.length);
  }
  var thr = CRUSH.varianceThreshold;
  for (var a = 0; a < n; a++) {
    if (isErrorItem(arr[a])) { if (!keep[a]) { keep[a] = 1; keptCount++; } continue; }
    var f = feats[a];
    if (f !== null && std !== null && std > 0 && Math.abs(f - mean) > thr * std) {
      if (!keep[a]) { keep[a] = 1; keptCount++; }
    }
    // 变化点：与前一项相比出现突跳
    if (f !== null && std !== null && std > 0 && a > 0 && feats[a - 1] !== null &&
        Math.abs(f - feats[a - 1]) > thr * std) {
      if (!keep[a]) { keep[a] = 1; keptCount++; }
      if (!keep[a - 1]) { keep[a - 1] = 1; keptCount++; }
    }
  }

  /* ①.5 完全相同项折叠：重复项不该占配额，
   * 但【受保护项】必须先保住，所以折叠放在异常标记之后。 */
  var dedupedKeep = {};
  var dedupSeen = {};
  for (var di = 0; di < n; di++) {
    if (!keep[di]) continue;
    var dv = arr[di], dk;
    try { dk = typeof dv === "string" ? dv : JSON.stringify(dv); } catch (e) { dk = null; }
    if (dk === null) { dedupedKeep[di] = 1; continue; }
    if (dedupSeen[dk]) { } else { dedupSeen[dk] = 1; dedupedKeep[di] = 1; }
  }
  /* 被折叠掉的异常重复项保留标记位（审计要求受保护项必须都在） */
  for (var pi = 0; pi < n; pi++) if (keep[pi]) dedupedKeep[pi] = 1;

  /* 交给后续配额填充使用 */
  keep = dedupedKeep;
  keptCount = 0;
  for (var z0 = 0; z0 < n; z0++) if (keep[z0]) keptCount++;

  /* ② 配额：开头 30% + 结尾 15% */
  var quota = CRUSH.maxArray;
  var firstN = Math.max(1, Math.round(quota * CRUSH.firstFraction));
  var lastN = Math.max(1, Math.round(quota * CRUSH.lastFraction));
  var need = [];
  for (var p = 0; p < firstN && p < n; p++) if (!keep[p]) { keep[p] = 1; keptCount++; }
  for (var q = Math.max(0, n - lastN); q < n; q++) if (!keep[q]) { keep[q] = 1; keptCount++; }

  /* ③ 余下配额给「重要项」：以值稀有度做代理（重复度高 = 信息量低） */
  if (keptCount < quota) {
    var freq = {};
    for (var r = 0; r < n; r++) {
      var key = String(feats[r]);
      freq[key] = (freq[key] || 0) + 1;
    }
    var rest = [];
    for (var t = 0; t < n; t++) if (!keep[t]) rest.push(t);
    rest.sort(function (x, y) {
      return (freq[String(feats[x])] || 0) - (freq[String(feats[y])] || 0);
    });
    for (var u = 0; u < rest.length && keptCount < quota; u++) {
      keep[rest[u]] = 1;
      keptCount++;
    }
  }

  var out = [];
  for (var v = 0; v < n; v++) if (keep[v]) out.push(v);
  return out;
}

function crushValue(v, depth) {
  if (v === null || v === undefined) return v;
  var t = typeof v;
  if (t === "string") return cutStr(v, CRUSH.maxString);
  if (t === "number" || t === "boolean") return v;
  if (depth >= CRUSH.maxDepth) return "…[深层内容已省略]";

  if (Object.prototype.toString.call(v) === "[object Array]") {
    var n = v.length;
    if (n === 0) return v;
    // 同类对象的数组：保留结构 + 首尾样本 + 计数摘要（最有价值的一种压缩）
    if (n > CRUSH.maxArray) {
      /* 先算出「受保护项」（error / 数值异常 / 长度异常 / 变化点）用于事后审计 */
      var guard = protectedIndices(v);
      var idxs = pickIndices(v);
      var keptArr = [];
      for (var i = 0; i < idxs.length; i++) keptArr.push(crushValue(v[idxs[i]], depth + 1));

      /* audit_safe：审计受保护项是否 100% 存活。
       * 少任何一项就【整体放弃压缩】，返回原数组——
       * 宁可多花 token，也不能把报错或离群值压没。
       * （这是防「将来有人改坏选择逻辑」的兜底，正常路径不会触发。） */
      if (!auditSafe(v, guard, idxs)) {
        var raw = [];
        for (var a = 0; a < n; a++) raw.push(crushValue(v[a], depth + 1));
        return raw;
      }
      /* 保留原顺序直接返回数组本身，不加包装键——
       * Headroom 的原则：输出只包含原数组里的项，不生成文本、不加元数据键，
       * 这样下游解析器与工具原样可用。 */
      return keptArr;
    }
    if (n < CRUSH.minArray) {
      /* 太短的数组不值得压（= min_items_to_analyze） */
      var all = [];
      for (var k0 = 0; k0 < n; k0++) all.push(crushValue(v[k0], depth + 1));
      return all;
    }
    var out = [];
    for (var k = 0; k < n; k++) out.push(crushValue(v[k], depth + 1));
    return out;
  }

  if (t === "object") {
    var keys = Object.keys(v);
    var res = {};
    var count = 0;
    for (var m = 0; m < keys.length; m++) {
      if (count >= CRUSH.maxKeys) {
        res["_headroom_省略键数"] = keys.length - count;
        break;
      }
      var val = v[keys[m]];
      if (val === null || val === "" || val === undefined) continue;  // 丢空值
      res[keys[m]] = crushValue(val, depth + 1);
      count++;
    }
    return res;
  }
  return v;
}

function crushJson(text, maxChars) {
  var obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return cutStr(text, maxChars);   // 解析不了就退化为截断
  }
  var crushed = crushValue(obj, 0);
  var out;
  try {
    out = JSON.stringify(crushed);
  } catch (e) {
    return cutStr(text, maxChars);
  }
  // 压完反而更大（小对象被加了摘要字段）→ 保留原文
  if (out.length >= text.length) return text.length > maxChars ? cutStr(text, maxChars) : text;
  return out;
}

/* ---------------- LogCrush：日志/文本启发式压缩 ---------------- */
/* 保留「信息密度高」的行：错误、异常、堆栈、路径、数字、关键字；
 * 丢弃重复行与纯噪声模板行。这是 Headroom 的 lossy 思路，纯正则实现。 */
/* ---------------- 日志内容模板去重 ----------------
 * 针对「只差时间戳/数字/ID」的日志行（心跳、轮询、重试等，占日志绝大多数）：
 * 抹去结构性易变段得到「内容模板」，将同模板的连续行折叠为：
 *   首行
 *   …[相同内容重复 N 次]…
 *   尾行
 *
 * 避坑原则：
 * 1. 关键行必须逐行保留：只认 FATAL/ERROR/CRITICAL/致命/失败/拒绝/崩溃/异常 等，
 *    严禁使用含裸数字 \d+ 的宽泛正则（避免因时间戳中的年份把每一行都当关键行保护）。
 * 2. 占位符抹平：对 \x00P\d+\x00 等上游生成的占位符先行归一化为 <p>，避免因编号不同导致模板不匹配。
 * 3. 性能热路径：单次正则遍历，无复杂回溯，耗时远低于 250ms 限额。
 */

var CRITICAL_KEYWORD_RE = /\b(?:FATAL|PANIC|CRITICAL|SEVERE|Traceback|Exception|FAILED)\b|connection refused|permission denied|access denied|timed out|\btimeout\b|segfault|\bOOM\b|\bkilled\b|No such file|not found|\bcannot\b|\bunable\b|exit code [1-9]|\b[1-9]\d* (?:failed|errors?|failures?)\b|致命|严重|失败|拒绝|崩溃|异常|报错|错误|警告升级|必须立即|立即降级|数据丢失/i;
var ERROR_WORD_RE = /\b(?:ERROR|ERR)\b/i;
var NEG_HEALTHY_RE = /无(?:异常|报错|错误)|0\s+(?:errors?|errs?|failures?)|(?:errors?|errs?|failures?)\s*[:=]\s*0/i;

function isCriticalLine(src) {
  if (!src || typeof src !== "string") return false;
  if (NEG_HEALTHY_RE.test(src)) return false;
  if (CRITICAL_KEYWORD_RE.test(src)) return true;
  if (ERROR_WORD_RE.test(src)) return true;
  return false;
}

var TPL_VOLATILE_RE = /\x00P\d+\x00|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b|\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b|\b[0-9a-fA-F]{16,}\b|\b(elapsed|duration|took|took_ms|latency|mem|memory|size|count|total|n|id|pid|tid|job|batch|worker|req|conn)=[-\w.]+|\b\d+(?:\.\d+)?\s?(?:ms|us|µs|ns|s|sec|secs|MB|GB|KB|B|bytes|rows|items|lines)\b|\b\d+(?:\.\d+)?\b/gi;

function lineTemplate(src) {
  if (!src || typeof src !== "string") return "";
  return src.replace(/^\s+/, "").replace(/\s+$/, "").replace(TPL_VOLATILE_RE, function (m, kv) {
    if (kv) return kv + "=<v>";
    if (m.charCodeAt(0) === 0) return "<p>";
    if (m.length === 36 && m.charAt(8) === "-") return "<uuid>";
    if (m.length >= 16 && /^[0-9a-fA-F]+$/.test(m)) return "<hex>";
    if (m.indexOf(":") !== -1) return "<ts>";
    if (/[a-zA-Zµ]/.test(m)) return "<num><unit>";
    return "<n>";
  });
}

function dedupLogTemplates(text, opts) {
  if (typeof text !== "string" || text.length < 40) return text;
  var lines = text.split("\n");
  if (lines.length < 3) return text;

  var checkCritical = (opts && typeof opts.isCriticalLine === "function") ? opts.isCriticalLine : isCriticalLine;

  var out = [];
  var currentRun = null;

  function flushRun() {
    if (!currentRun) return;
    if (currentRun.count === 1) {
      out.push(currentRun.firstLine);
    } else if (currentRun.count === 2) {
      out.push(currentRun.firstLine);
      out.push(currentRun.lastLine);
    } else {
      out.push(currentRun.firstLine);
      out.push("…[相同内容重复 " + (currentRun.count - 2) + " 次]…");
      out.push(currentRun.lastLine);
    }
    currentRun = null;
  }

  for (var i = 0; i < lines.length; i++) {
    var rawLine = lines[i];
    var trimmed = rawLine.replace(/\s+$/, "").replace(/^\s+/, "");
    if (!trimmed.length) {
      flushRun();
      out.push(rawLine);
      continue;
    }

    if (checkCritical(trimmed)) {
      flushRun();
      out.push(rawLine);
      continue;
    }

    var tpl = lineTemplate(trimmed);
    if (currentRun && currentRun.tpl === tpl) {
      currentRun.count++;
      currentRun.lastLine = rawLine;
    } else {
      flushRun();
      currentRun = {
        tpl: tpl,
        firstLine: rawLine,
        lastLine: rawLine,
        count: 1
      };
    }
  }
  flushRun();

  var res = out.join("\n");
  return res.length < text.length ? res : text;
}

/* 「致命行」必须逐字节存活：报错、异常、堆栈、失败关键字。
 * 把 FATAL 压掉的压缩器比不压缩更危险，这是本模块的第一原则。
 *
 * 判定必须带边界，否则 "0 errors" 这类例行行会被误判为致命
 * （实测：宽松正则导致 120 行 INFO 全部被判致命，压缩彻底失效）。 */

/* 次要行：仍然有信息量，但可以被预算裁掉 */
var NOISE_RE = /(\berror\b|\berr\b|\bwarn\b|\bfailed\b|https?:\/\/|\/[\w.\-\/]{4,}|\.(?:py|js|ts|go|rs|java|rb|json|ya?ml|toml)(?::\d+)?|\d{3,})/i;

/* 例行行：时间戳 + 级别 + 无异常信息，价值最低 */
var ROUTINE_RE = /^\s*\d{4}-\d{2}-\d{2}[ T][\d:.]+\s+(?:INFO|DEBUG|TRACE|NOTICE)\b/i;

function crushLog(text, maxChars, maxLines, opts) {
  if (typeof text !== "string") return text;
  var cap = maxLines || 400;

  var doDedup = true;
  if (opts && (opts.log_template_dedup === false || opts.logTemplateDedup === false)) {
    doDedup = false;
  }
  if (CRUSH.logTemplateDedup === false) {
    doDedup = false;
  }

  var deduped = doDedup ? dedupLogTemplates(text, opts) : text;
  if (deduped.length < text.length && deduped.length <= maxChars) {
    return deduped;
  }

  var lines = String(deduped).split("\n");
  var total = lines.length;

  var critical = [];
  var other = [];
  var last = "";
  var dup = 0;
  var hasRoutine = false;

  for (var i = 0; i < total; i++) {
    var trimmed = lines[i].replace(/\s+$/, "");
    if (!trimmed.length) continue;
    if (trimmed === last) { dup++; continue; }
    if (dup > 0) {
      other.push("…[重复 " + dup + " 行]…");
      dup = 0;
    }
    last = trimmed;
    if (isCriticalLine(trimmed)) {
      critical.push(trimmed);          // 致命行：原样保留，不截断
    } else if (/^…\[相同内容重复 \d+ 次\]…$/.test(trimmed)) {
      other.push(trimmed);             // 模板去重标记作为要点行保留
    } else if (ROUTINE_RE.test(trimmed)) {
      hasRoutine = true;               // 例行行：默认丢，只在预算有富余时补几条
    } else if (NOISE_RE.test(trimmed)) {
      other.push(trimmed);
    }
    if (critical.length >= cap) break;
  }
  if (dup > 0) other.push("…[重复 " + dup + " 行]…");

  if (!critical.length && !other.length) return cutStr(text, maxChars);

  var head = "…[日志压缩：原 " + total + " 行 → 致命 " + critical.length +
             " 行完整保留" + (other.length ? "，另附 " + other.length + " 行要点" : "") +
             (hasRoutine ? "，例行 " + (total - critical.length - other.length) + " 行已略" : "") + "]…\n";

  /* 先无条件放下全部致命行——这是不可协商的 */
  var body = critical.join("\n");
  var budget = maxChars - head.length;

  if (body.length > budget) {
    /* 致命行本身就超预算：保留【头部】，因为严重级别标记在行首。
     * 绝不保留中段——实测保留首尾会把 "FATAL database connection refused"
     * 拦腰截断，反而丢掉最关键的判定词。 */
    var per = Math.max(80, Math.floor(budget / critical.length) - 1);
    var cut = [];
    for (var c = 0; c < critical.length; c++) {
      cut.push(critical[c].length > per ? critical[c].slice(0, per) + "…" : critical[c]);
    }
    body = cut.join("\n");
  }

  /* 剩余预算再补要点行 */
  var used = head.length + body.length;
  var extra = [];
  for (var n = 0; n < other.length; n++) {
    var add = other[n].length > 300 ? other[n].slice(0, 300) + "…" : other[n];
    if (used + add.length + 1 > maxChars) break;
    extra.push(add);
    used += add.length + 1;
  }
  if (extra.length) body += "\n" + extra.join("\n");

  var out = head + body;
  /* 兜底：压完不能比原文还大，也不能超预算 */
  if (out.length >= text.length) return text.length > maxChars ? cutStr(text, maxChars) : text;
  if (out.length > maxChars) return out.slice(0, maxChars) + "…";
  return out;
}

/* ---------------- CrossTurnDedup：跨轮逐字去重 ----------------
 * 场景（Headroom 的原话）：bash agent 会反复重显同样的文件字节——
 *   cat foo.py → sed -n 75,100p foo.py → git diff → 又 cat foo.py
 * 每个「块内」压缩器都看不见这种冗余，因为冗余是【跨块】的。
 *
 * 两条硬不变量（照搬 Headroom，生产可用缺一不可）：
 *
 *   ① 前缀单调性（cache-safety）：块按顺序处理，一个块只与【严格更早】的块
 *      匹配。因此「0..k 块的输出」是否改写过，与第 k+1 块存在与否无关——
 *      追加新一轮永远不会改动更早的轮，上游的 prompt-cache 前缀保持字节稳定。
 *      引用一律用【绝对块序号】，不用相对偏移。
 *
 *   ② 信息不离开窗口（accuracy）：只回指在更早块中【逐字存在】的片段；
 *      且【最早出现处永不重写】（keep-earliest），所以指针指向的原文
 *      始终物理存在于上下文里。
 *
 * 纯字符串运算、确定性、出错一律返回原样。
 */
var DEDUP = {
  minRunLines: 4,     // 连续多少行才算值得折叠
  minRunChars: 160,   // 折叠片段的最小字符数
  keyPad: "\u0000l:" // 行键前缀：避免命中 Object.prototype 上的键（如 constructor）
};

function dedupLineKey(ln) {
  return DEDUP.keyPad + ln.replace(/\s+$/, "").replace(/^\s+/, "");
}

/** 是否空行（空行语义中性，不应当打断一个正在进行的 run） */
function isBlankLine(ln) {
  return !ln || !ln.replace(/\s+$/, "").replace(/^\s+/, "").length;
}

/**
 * 对一段文本做跨轮去重。
 * @param text   当前块文本
 * @param seen   {lineKey: 最早出现的块序号}  —— 只含【更早】块的行
 * @param ordinal 当前块的绝对序号
 * @returns 去重后的文本（未改动则返回原文本）
 */
function dedupBlock(text, seen, ordinal) {
  if (!text || text.length < DEDUP.minRunChars) return text;
  var lines = text.split("\n");
  if (lines.length < DEDUP.minRunLines) return text;

  var out = [];
  var runStart = -1;
  var runChars = 0;
  var runOwner = -1;

  function flushRun(endIdx) {
    if (runStart < 0) return;
    var nLines = endIdx - runStart;
    if (nLines >= DEDUP.minRunLines && runChars >= DEDUP.minRunChars) {
      // 指针用【绝对块序号】，且指向最早出现的那一块
      out.push("…[与上文第 " + (runOwner + 1) + " 块逐字相同，" +
               nLines + " 行已省略]…");
    } else {
      for (var k = runStart; k < endIdx; k++) out.push(lines[k]);
    }
    runStart = -1;
    runChars = 0;
    runOwner = -1;
  }

  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var owner;
    if (isBlankLine(ln)) {
      /* 空行不打断已有 run：真实文件里空行随处可见，
       * 若让它断流，一段大文件永远凑不满 minRunLines（实测踩过）。
       * 不在 run 中就按普通行处理。 */
      owner = runStart >= 0 ? runOwner : undefined;
    } else {
      owner = seen[dedupLineKey(ln)];
    }
    if (owner !== undefined) {
      if (runStart < 0) { runStart = i; runChars = 0; runOwner = owner; }
      if (owner < runOwner) runOwner = owner;
      runChars += ln.length + 1;
    } else {
      flushRun(i);
      out.push(ln);
    }
  }
  flushRun(lines.length);

  var res = out.join("\n");
  return res.length < text.length ? res : text;
}

/** 登记本块的行（必须在处理完之后做，保证只与更早块匹配） */
function dedupRemember(text, seen, ordinal) {
  if (!text) return;
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (isBlankLine(lines[i])) continue;   // 空行不入表
    var key = dedupLineKey(lines[i]);
    if (seen[key] === undefined) seen[key] = ordinal;
  }
}

/* FNV-1a 4轮 32-bit (128-bit) -> 32 位十六进制哈希（纯整数运算，处理双字节 Unicode）。
 * 仅用于 analyzeCacheStability 计算「稳定前缀哈希」以判定前缀是否漂移。
 *
 * 注：曾用它做压缩结果缓存的键，实测后【已整体移除该缓存】——
 * 在 moejs 下哈希一次的开销是压缩一次的 76%（0.79 vs 1.05 µs/字符），
 * 即便 4 轮完全相同的请求体、缓存 100% 命中，端到端也只有 1.01x。
 * 详见 README「为什么没有压缩缓存」。 */
function hash32hex(str) {
  if (typeof str !== "string") str = String(str == null ? "" : str);
  var h1 = 0x811c9dc5, h2 = 0x27d4eb2f, h3 = 0x9e3779b9, h4 = 0x7feb352d;
  var len = str.length;
  for (var i = 0; i < len; i++) {
    var c = str.charCodeAt(i);
    var lo = c & 0xff;
    var hi = (c >> 8) & 0xff;
    h1 = Math.imul(h1 ^ lo, 0x01000193);
    h1 = Math.imul(h1 ^ hi, 0x01000193);
    h2 = Math.imul(h2 ^ lo, 0x5bd1e995);
    h2 = Math.imul(h2 ^ hi, 0x5bd1e995);
    h3 = Math.imul(h3 ^ lo, 0x1000193);
    h3 = Math.imul(h3 ^ hi, 0x1000193);
    h4 = Math.imul(h4 ^ lo, 0x27d4eb2f);
    h4 = Math.imul(h4 ^ hi, 0x27d4eb2f);
  }
  return (
    ("0000000" + (h1 >>> 0).toString(16)).slice(-8) +
    ("0000000" + (h2 >>> 0).toString(16)).slice(-8) +
    ("0000000" + (h3 >>> 0).toString(16)).slice(-8) +
    ("0000000" + (h4 >>> 0).toString(16)).slice(-8)
  );
}


/* ---------------- 统一入口 ---------------- */
function crushText(text, opts) {
  opts = opts || {};
  var maxChars = opts.maxChars || opts.max_chars || 4000;
  if (typeof text !== "string") return text;
  if (text.length <= maxChars) return text;       // 没超预算就不动，零风险

  var kind = detectKind(text);
  if (kind === "verbatim") {
    return text;   // 含 git status/diff → 无损直通
  }

  var out;
  if (kind === "json") out = crushJson(text, maxChars);
  else if (kind === "log") out = crushLog(text, maxChars, opts.maxLines || opts.max_lines || 400, opts);
  else out = cutStr(text, maxChars);   // prose/code/diff：不做有损改写，只截断

  // 兜底：压完不能比原文还大（否则是倒退，不是压缩，记入 Skip Set）
  if (typeof out !== "string" || out.length >= text.length) return text;
  return out;
}

/* ---------------- 作用到整个请求体 ---------------- */
/**
 * 压缩请求体里的工具输出与超长文本块。
 * 只动 content 里 type 为 tool_result / 超长 text 的部分，
 * 绝不动 system prompt 与最后一条用户消息——那是语义关键区。
 */
/* ---------------- 时间兜底（紧急泄压阀） ----------------
 * 背景：moejs 的 onRequest 硬限额约 250ms，一旦超时【整个请求被丢弃】。
 * 实测压缩速率约 1.4µs/字符（iSH：15302 字符 → 21.45ms），
 * 故 180ms 预算 ≈ 12.8 万字符的可压缩内容，对正常请求有 8 倍以上余量。
 *
 * 【两级设计的原因 —— 不能照搬别人的 afford() 时间判据】
 * 纯时间判据是【非确定性】的：第 5 块超时与第 7 块超时，
 * 会让同一个历史块在 A 轮被压、B 轮没被压 → 前缀字节变化 → KV-Cache 失效，
 * 破坏我们「绝不改历史前缀」的核心不变量。
 * 所以主力防线改用【确定性】的工作量预算，时间只作应急后备：
 *
 *   一级（确定性，主力）：累计「已压字符数」超预算就停手。
 *        同一输入永远得到同一决策，前缀稳定不受影响。
 *   二级（非确定性，应急）：单次调用异常慢时（预估失准），
 *        按墙钟时间停手。仅在内容比实测均值慢得多时才会触发，
 *        代价是这一轮压缩结果不完整 —— 但这远好过整个请求被丢弃。
 *
 * 触发时【就地停止压后续块】，已压完的块保持生效。
 * 刻意不返回「整轮放弃」：那需要深拷贝原文（我们已删掉 cloneDeep），
 * 且会让「这一轮到底压没压」变成更难推理的状态。
 */
var WORK_BUDGET_CHARS = 128000;   // 一级：累计可压字符上限（≈180ms）
var TIME_BUDGET_MS    = 180;      // 二级：墙钟兜底（moejs 限额 250ms 的安全垫）

function compressBody(body, opts) {
  if (!body || !body.messages || !body.messages.length) return { body: body, saved: 0 };
  opts = opts || {};
  var before = 0;
  var after = 0;
  var maxChars = opts.max_chars || opts.maxChars || 4000;
  var minChars = opts.min_chars || opts.minChars || 1200;   // 小于这个长度的块不值得动
  /* 跨轮去重的「已见行表」：只登记更早块的行，
   * 因此追加新一轮绝不改动更早的轮（前缀单调性）。 */
  var seenLines = {};
  var dedupSaved = 0;

  /* 两级兜底的状态（详见上方注释） */
  var workBudget = (opts.work_budget_chars !== undefined ? opts.work_budget_chars
                  : (opts.workBudgetChars !== undefined ? opts.workBudgetChars : WORK_BUDGET_CHARS));
  var timeBudgetMs = (opts.time_budget_ms !== undefined ? opts.time_budget_ms
                  : (opts.timeBudgetMs !== undefined ? opts.timeBudgetMs : TIME_BUDGET_MS));
  var startedAt = Date.now();
  var workUsed = 0;
  var guardTripped = "";
  /* 是否还有预算继续压下一块；只按确定性字符预算中断，杜绝非确定性墙钟中断破坏 KV-Cache */
  function budgetLeft(len) {
    if (guardTripped) return false;
    if (workUsed + len > workBudget) { guardTripped = "work"; return false; }
    workUsed += len;
    return true;
  }

  /* skip_user_messages（Headroom 默认 True）：用户自己写的散文绝不压缩——
   * 那是请求意图本身，动了它等于改了需求。
   * 注意：Anthropic 的工具结果【就在 user 消息里】，所以这里只拦「散文」，
   * tool_result 块照常处理。 */
  var skipUser = opts.skip_user_messages !== false;

  var crushOpts = {
    maxChars: maxChars,
    maxLines: opts.max_lines || opts.maxLines || 400,
    logTemplateDedup: opts.log_template_dedup !== undefined ? opts.log_template_dedup : (opts.logTemplateDedup !== undefined ? opts.logTemplateDedup : CRUSH.logTemplateDedup),
    log_template_dedup: opts.log_template_dedup !== undefined ? opts.log_template_dedup : (opts.logTemplateDedup !== undefined ? opts.logTemplateDedup : CRUSH.logTemplateDedup)
  };

  for (var i = 0; i < body.messages.length; i++) {
    var msg = body.messages[i];
    if (!msg || msg.role === "system") continue;
    // 最后一条消息是当前意图，绝不压缩、也不登记
    if (i === body.messages.length - 1) break;
    var c = msg.content;
    if (typeof c === "string") {
      if (skipUser && msg.role === "user") continue;   // 用户散文不动
      before += c.length;
      var nc = (c.length > minChars && budgetLeft(c.length)) ? crushText(c, crushOpts) : c;
      msg.content = nc;
      after += nc.length;
      continue;
    }
    if (c && c.length) {
      for (var j = 0; j < c.length; j++) {
        var blk = c[j];
        if (!blk) continue;
        // Anthropic 风格的工具结果
        if (blk.type === "tool_result" && typeof blk.content === "string") {
          before += blk.content.length;
          if (blk.content.length > minChars && budgetLeft(blk.content.length)) {
            blk.content = crushText(blk.content, crushOpts);
          }
          /* 跨轮去重：块内压完再压【跨块】冗余 */
          if (opts.cross_turn_dedup !== false) {
            var dd = dedupBlock(blk.content, seenLines, i);
            if (dd !== blk.content) { dedupSaved += blk.content.length - dd.length; blk.content = dd; }
            dedupRemember(blk.content, seenLines, i);
          }
          after += blk.content.length;
          continue;
        }
        if (blk.type === "tool_result" && blk.content && blk.content.length) {
          for (var k = 0; k < blk.content.length; k++) {
            var sub = blk.content[k];
            if (sub && typeof sub.text === "string") {
              before += sub.text.length;
              if (sub.text.length > minChars && budgetLeft(sub.text.length)) {
                sub.text = crushText(sub.text, crushOpts);
              }
              after += sub.text.length;
            }
          }
          continue;
        }
        // OpenAI 风格的工具结果
        if (msg.role === "tool" && blk.type === "text" && typeof blk.text === "string") {
          before += blk.text.length;
          if (blk.text.length > minChars && budgetLeft(blk.text.length)) {
            blk.text = crushText(blk.text, crushOpts);
          }
          after += blk.text.length;
          continue;
        }
        /* 普通文本块：仅当它不是「用户自己在说话」时才压 */
        if (blk.type === "text" && typeof blk.text === "string" &&
            blk.text.length > minChars * 3 && !(skipUser && msg.role === "user") &&
            budgetLeft(blk.text.length)) {
          before += blk.text.length;
          blk.text = crushText(blk.text, crushOpts);
          after += blk.text.length;
        }
      }
    }
  }
  return { body: body, saved: before - after, before: before, after: after,
           dedup_saved: dedupSaved, dedup_lines: seenLines ? Object.keys(seenLines).length : 0,
           /* 兜底诊断：空串=未触发；"work"/"time"=触发了哪一级 */
           guard_tripped: guardTripped, work_used: workUsed, elapsed_ms: Date.now() - startedAt };
}

/* ---------------- CacheAligner：前缀漂移探测器（Detector-Only） ----------------
 * 严格遵循 Headroom 的设计哲学与硬不变量：
 *   "Invariant I2 — the cache hot zone (system prompt) must never be mutated."
 *   本模块【只检测、绝不改写】，从不修改 prompt 或 body 的任何字段。
 *
 * 检测结构化易变模式（非宽泛正则，避免误伤业务文本）：
 *   1. UUID      ：RFC 4122 规范 36 字符（带 4 个连字符），纯十六进制数字
 *   2. ISO 8601  ：YYYY-MM-DD 或 YYYY-MM-DDTHH:MM:SS 带时区，结构校验 + 有效性判断
 *   3. JWT       ：三段以点分隔的 base64url 格式（每段 >= 4 字节，字符集 [A-Za-z0-9_-]）
 *   4. Hex Hash  ：定长 MD5(32) / SHA1(40) / SHA256(64) 纯十六进制字母表
 */

var HEX_HASH_LENGTHS = { 32: 1, 40: 1, 64: 1 };

function isUuid(token) {
  if (token.length !== 36) return false;
  if (token.charAt(8) !== "-" || token.charAt(13) !== "-" ||
      token.charAt(18) !== "-" || token.charAt(23) !== "-") return false;
  for (var i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) continue;
    var c = token.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) {
      return false;
    }
  }
  return true;
}

function isIso8601(token) {
  if (token.length < 10) return false;
  for (var i = 0; i < 4; i++) {
    var c = token.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  if (token.charAt(4) !== "-") return false;
  var m1 = token.charCodeAt(5), m2 = token.charCodeAt(6);
  if (m1 < 48 || m1 > 57 || m2 < 48 || m2 > 57) return false;
  if (token.charAt(7) !== "-") return false;
  var d1 = token.charCodeAt(8), d2 = token.charCodeAt(9);
  if (d1 < 48 || d1 > 57 || d2 < 48 || d2 > 57) return false;
  if (token.length === 10) return !isNaN(Date.parse(token));
  var sep = token.charAt(10);
  if (sep !== "T" && sep !== "t" && sep !== " ") return false;
  return !isNaN(Date.parse(token.replace(" ", "T")));
}

function isBase64Url(str) {
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95)) {
      return false;
    }
  }
  return true;
}

function isJwt(token) {
  var segments = token.split(".");
  if (segments.length !== 3) return false;
  for (var i = 0; i < 3; i++) {
    var seg = segments[i];
    if (seg.length < 4 || !isBase64Url(seg)) return false;
  }
  return true;
}

function isHexHash(token) {
  if (!HEX_HASH_LENGTHS[token.length]) return false;
  for (var i = 0; i < token.length; i++) {
    var c = token.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) {
      return false;
    }
  }
  return true;
}

function classifyToken(token) {
  if (isUuid(token)) return "uuid";
  if (token.indexOf(".") !== -1 && isJwt(token)) return "jwt";
  if (isIso8601(token)) return "iso8601";
  if (isHexHash(token)) return "hex_hash";
  return null;
}

function splitTokens(content) {
  if (!content || typeof content !== "string") return [];
  var rawTokens = content.split(/\s+/);
  var tokens = [];
  var stripRe = /^[\.,;:!?"'()\[\]{}<>]+|[\.,;:!?"'()\[\]{}<>]+$/g;
  for (var i = 0; i < rawTokens.length; i++) {
    var cleaned = rawTokens[i].replace(stripRe, "");
    if (cleaned.length > 0) tokens.push(cleaned);
  }
  return tokens;
}

/**
 * 结构化检测易变内容（纯检测，不改写）
 * @param {string} text 待检测文本
 * @returns {Array<{label: string, sample: string}>}
 */
function detectVolatileContent(text) {
  if (!text || typeof text !== "string") return [];
  var tokens = splitTokens(text);
  var findings = [];
  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];
    var label = classifyToken(tok);
    if (!label && tok.indexOf("=") !== -1) {
      var parts = tok.split("=");
      if (parts.length === 2 && parts[1]) {
        label = classifyToken(parts[1]);
        if (label) tok = parts[1];
      }
    }
    if (label) {
      var sample = tok.length <= 16 ? tok : tok.slice(0, 8) + "..." + tok.slice(-4);
      findings.push({ label: label, sample: sample });
    }
  }
  return findings;
}

/**
 * volatilityScore — 易变内容计分（保留兼容；内部并入 CacheAligner 结构化探测器）
 * @param {string} text 待检测文本
 * @returns {number} 命中易变模式的次数
 */
function volatilityScore(text) {
  if (typeof text !== "string" || !text.length) return 0;
  return detectVolatileContent(text).length;
}

/** 从多种消息 content 形态中安全提取纯文本（不修改原对象） */
function extractText(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var item = content[i];
      if (item === null || item === undefined) continue;
      if (typeof item === "string") {
        parts.push(item);
      } else if (typeof item === "object") {
        if (typeof item.text === "string") parts.push(item.text);
        if (typeof item.content === "string") parts.push(item.content);
        else if (item.content) parts.push(extractText(item.content));
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    try { return JSON.stringify(content); } catch (e) { return ""; }
  }
  return "";
}

/**
 * analyzeCacheStability — CacheAligner 前缀漂移探测器（纯检测，绝不修改 body）
 *
 * 检测对象：system prompt + 除最后一条之外的消息（KV-Cache 稳定前缀区）
 *
 * @param {object} body OpenAI / Anthropic 格式请求体
 * @param {object} [ctxState] 调用方上下文状态对象（网关 ctx.state）
 * @returns {{ prefixChanged: boolean, warnings: string[], volatileHits: number, prefixHash: string }}
 */
function analyzeCacheStability(body, ctxState) {
  if (!body || typeof body !== "object") {
    return { prefixChanged: false, warnings: [], volatileHits: 0, prefixHash: "" };
  }
  ctxState = (ctxState && typeof ctxState === "object") ? ctxState : {};

  var prefixParts = [];
  var allFindings = [];

  // 1. Anthropic 风格顶层 system
  if (body.system) {
    var sysText = extractText(body.system);
    if (sysText) {
      prefixParts.push("system:" + sysText);
      var sf = detectVolatileContent(sysText);
      if (sf.length) allFindings.push.apply(allFindings, sf);
    }
  }

  // 2. 消息序列：system 角色全保留；其它角色保留最后一条之前的全部消息（即前缀区）
  if (Array.isArray(body.messages)) {
    var msgs = body.messages;
    var lastIdx = msgs.length - 1;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || typeof m !== "object") continue;
      if (m.role === "system" || i < lastIdx) {
        var text = extractText(m.content);
        if (text) {
          prefixParts.push((m.role || "") + ":" + text);
          var mf = detectVolatileContent(text);
          if (mf.length) allFindings.push.apply(allFindings, mf);
        }
      }
    }
  }

  var scopeText = prefixParts.join("\n---\n");
  var prefixHash = scopeText ? hash32hex(scopeText) : "";

  // 比对上一次的前缀哈希
  var prevHash = (ctxState.prefixHash !== undefined) ? ctxState.prefixHash :
                 (ctxState._prefixHash !== undefined ? ctxState._prefixHash : null);
  var prefixChanged = (prevHash !== null && prevHash !== "" && prevHash !== prefixHash);

  // 记录本次哈希到 ctxState
  if (prefixHash) {
    ctxState.prefixHash = prefixHash;
    ctxState._prefixHash = prefixHash;
  }

  var warnings = [];
  if (allFindings.length > 0) {
    var counts = {};
    for (var a = 0; a < allFindings.length; a++) {
      var lbl = allFindings[a].label;
      counts[lbl] = (counts[lbl] || 0) + 1;
    }
    var keys = Object.keys(counts).sort();
    var cparts = [];
    for (var k = 0; k < keys.length; k++) {
      cparts.push(keys[k] + "=" + counts[keys[k]]);
    }
    var countsStr = cparts.join(", ");
    warnings.push(
      "CacheAligner: detected volatile content in system prompt (" +
        countsStr +
        "); cache prefix unstable. Move dynamic values out of the system prompt to recover cache hits."
    );
  }

  return {
    prefixChanged: prefixChanged,
    warnings: warnings,
    volatileHits: allFindings.length,
    prefixHash: prefixHash
  };
}

/* 导出（moejs 只加载包内相对文件） */
export {
  // 现有导出面（保持原有签名不变）
  detectKind,
  crushJson,
  crushLog,
  crushText,
  compressBody,
  volatilityScore,
  cutStr,

  // 新增导出（前缀漂移探测 + 哈希工具）
  analyzeCacheStability,
  detectVolatileContent,
  hash32hex,

  // 日志内容模板去重
  dedupLogTemplates,
  lineTemplate,
  isCriticalLine
};
