/**
 * 模块职责：环境作用域（env_scope）的解析、归一、合并与匹配
 * 依赖：无（纯函数，零 I/O）
 * 被依赖：src/middleware/capability.js, src/services/save/memory-saver.js, src/tools/pitfall-save.js
 *
 * 为什么要抽到 domain：同一套语法要被三个层用（中间件召回过滤、保存侧归一、提炼侧写入），
 * 放在任一侧都会造成另一侧反向依赖。
 *
 * 语法：`k=v,k2=v2`，同键多值用 `|`，同时容忍 `:` 分隔。
 * 语义：
 *  - 空作用域 = 通用（现有数据一格不用迁）；
 *  - 当前环境**未知的维度一律不参与判定**（fail-open），避免误杀；
 *  - 两条作用域合并时同名键取并集，不是覆盖。
 */

function parseScope(scopeStr) {
  var out = {};
  if (scopeStr == null) return out;
  var toks = String(scopeStr).split(/[,;\s]+/);
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i].trim();
    if (!t) continue;
    var sep = t.indexOf("=");
    if (sep < 0) sep = t.indexOf(":");
    if (sep <= 0) continue;
    var k = t.slice(0, sep).trim().toLowerCase();
    var v = t.slice(sep + 1).trim().toLowerCase();
    if (!k || !v) continue;
    out[k] = v;
  }
  return out;
}

/* 保存侧归一：小写、排序、去重、裁剪到 256 字符（对齐列宽）。
 * 非法片段直接丢弃而不是整条报错——作用域是附加元数据，不该阻断一次有效保存。 */
function normalizeEnvScope(scopeStr) {
  var map = parseScope(scopeStr);
  var keys = Object.keys(map).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) parts.push(keys[i] + "=" + map[keys[i]]);
  var s = parts.join(",");
  return s.length > 256 ? s.slice(0, 256) : s;
}

/* 两条作用域取并集（同名键保留两者值，用 | 连接） */
function mergeEnvScope(a, b) {
  var A = parseScope(a);
  var B = parseScope(b);
  var keys = Object.keys(B);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!A[k]) { A[k] = B[k]; continue; }
    var alts = String(A[k]).split("|");
    var bAlts = String(B[k]).split("|");
    for (var j = 0; j < bAlts.length; j++) {
      if (alts.indexOf(bAlts[j]) === -1) alts.push(bAlts[j]);
    }
    A[k] = alts.join("|");
  }
  var out = [];
  var ks = Object.keys(A).sort();
  for (var n = 0; n < ks.length; n++) out.push(ks[n] + "=" + A[ks[n]]);
  return normalizeEnvScope(out.join(","));
}

/* 环境是否匹配。
 * 关键决策（v7.0.0 真机测试修正）：**带作用域的记忆必须正向确认才召回**。
 * 早期实现对“未知维度” fail-open，结果是没有 os 画像的 ishellpro 依然收到了
 * 「Windows 上要用 X」这类准则——等于把最大的风险留在默认路径上。
 * 现在默认 requireKnown=true：作用域里任一维度在当前环境不可知就不召回；
 * 完全没作用域的记忆（绝大多数）不受影响，仍然无条件召回。
 * 需要宽松时显式传 opts.requireKnown=false。 */
function matchEnvScope(scopeStr, env, opts) {
  var want = parseScope(scopeStr);
  var keys = Object.keys(want);
  var requireKnown = !(opts && opts.requireKnown === false);
  if (!keys.length) return true;
  if (!env || typeof env !== "object") return !requireKnown;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var have = env[k];
    if (have == null || have === "") {
      if (requireKnown) return false;
      continue;
    }
    var haveStr = String(have).toLowerCase();
    var alts = String(want[k]).split("|");
    var ok = false;
    for (var a = 0; a < alts.length; a++) {
      if (alts[a].trim().toLowerCase() === haveStr) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

/* 兼容两种落地形态：
 *  1) 真列 env_scope（v7 schema 起的形态，优先）；
 *  2) related_entities 里的保留标签 `env:os=windows`（v6 过渡形态，向后兼容）。
 * 列迁移与标签共存时以列优先——因为列是写路径的唯一真相源。 */
function envScopeOf(m) {
  if (!m || typeof m !== "object") return "";
  if (m.env_scope != null && String(m.env_scope).trim()) return normalizeEnvScope(String(m.env_scope));
  var ents = m.related_entities;
  if (!ents) return "";
  var toks = String(ents).split(/[\s,;]+/);
  var out = [];
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i].trim();
    if (t.length > 4 && t.slice(0, 4).toLowerCase() === "env:") out.push(t.slice(4));
  }
  return out.length ? normalizeEnvScope(out.join(",")) : "";
}

/* 从 related_entities 文本里抽出 env: 保留标签（保存侧用） */
function envTagsOf(relatedEntities) {
  if (!relatedEntities) return "";
  var toks = String(relatedEntities).split(/[\s,;]+/);
  var out = [];
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i].trim();
    if (t.length > 4 && t.slice(0, 4).toLowerCase() === "env:") out.push(t.slice(4));
  }
  return out.join(",");
}


/* 提炼层专用：把模型吐的 applies_to 自然语言归一成规范作用域。
 * 为什么不让模型直接写 k=v：它经常写成「仅限 Windows」「arm64 上」这类人话，
 * 转成规范串后才能真正参与过滤；不认识的部分保留原文作为 agent 维度，
 * 宁可过滤保守（滤掉不匹配的）也不要把它当成通用事实污染其他环境。 */
var APPLIES_MAP = {
  windows: "os=windows", win: "os=windows", win32: "os=windows", win64: "os=windows",
  linux: "os=linux", macos: "os=macos", mac: "os=macos", darwin: "os=macos",
  amd64: "arch=amd64", x86_64: "arch=amd64", x64: "arch=amd64",
  arm64: "arch=arm64", aarch64: "arch=arm64"
};

function appliesToToScope(raw) {
  var str = String(raw == null ? "" : raw).trim();
  if (!str) return "";
  /* 已经是规范形态就直接归一返回 */
  if (str.indexOf("=") !== -1) return normalizeEnvScope(str);
  var toks = str.toLowerCase().split(/[\s,\/;|、，]+/);
  var parts = [];
  var extra = [];
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i].trim();
    if (!t) continue;
    if (APPLIES_MAP[t]) { parts.push(APPLIES_MAP[t]); continue; }
    if (/^[a-z0-9_\.-]{2,32}$/.test(t)) extra.push(t);
  }
  if (extra.length) parts.push("agent=" + extra.join("|"));
  return normalizeEnvScope(parts.join(","));
}

export { parseScope, normalizeEnvScope, mergeEnvScope, matchEnvScope, envScopeOf, envTagsOf, appliesToToScope };
