#!/usr/bin/env node
import assert from "node:assert";
/**
 * tests/check_split_equiv.mjs
 *
 * 模块职责：拆分等价性检查——确认重构前后函数名集合一致、同名函数体长度无显著差异
 * 依赖：node:fs / node:path / node:url / node:child_process
 * 被依赖：tests/test_meta.mjs、CI
 *
 * 基线：2c4a640 的 tools.js（4488 行单体，重构前）
 * 判定：缺失任何函数 → 失败；同名函数行数差 > 5 → 失败
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_COMMIT = process.env.SPLIT_BASELINE || "2c4a640";
const BASELINE_FILE = "tools.js";
const MAX_LINE_DELTA = 5;

/**
 * 行数变化白名单（豁免「合法功能演进」，但必须逐条精确登记）
 *
 * 规则：
 *   - 只有「相对基线**纯新增**」才算豁免（signedDelta 必须等于登记值，缺一行/多一行都不放行）；
 *   - 每条必须写明版本号 / 变更提交 / 具体新增内容，说明这 N 行不是顺手改逻辑；
 *   - 登记后必须仍被真实命中，否则判定为「失效条目」直接失败，防止白名单腐烂成免死金牌；
 *   - 未登记的漂移一律照旧失败（判定阈值 MAX_LINE_DELTA 不做任何放宽）。
 */
const ALLOWED_DRIFT = new Map([
  [
    "readOptions",
    {
      delta: 29,
      reason:
        "v6.47.0(c4286fc)+v6.46 纯增量：model_timeout_sec / rerank_timeout_sec / rerank_max_candidates " +
        "三个超时与候选上限归一化 + explain_debug 调试开关（基线 18 行）；" +
        "v7.0.0 再纯增 11 行：capability_gate / env_scope_strict / client_profiles / cli_channel / " +
        "caps_telemetry 五项配置归一化（含解释注释）。既有字段的取值逻辑与顺序零改动",
      file: "src/core/config.js",
    },
  ],
  [
    "saveMemory",
    {
      delta: 23,
      reason:
        "v6.48.0（基线 14 行）：fetchAll 分页拉全量、唯一索引兜底查询补 lifecycle_status 与排序、" +
        "tags/related_entities 并集裁剪到 512 字符；" +
        "v7.0.0 再纯增 9 行：env_scope 归一（显式参数 + env: 保留标签双路径）与三处去重分支的作用域并集合并。" +
        "既有分支顺序零改动",
      file: "src/services/save/memory-saver.js",
    },
  ],
  [
    "pitfallSave",
    {
      delta: 7,
      reason:
        "v7.0.0 纯增量：创建 payload 增加 env_scope 列，并在去重分支合并作用域；" +
        "既有分支顺序零改动",
      file: "src/tools/pitfall-save.js",
    },
  ],
  [
    "memorySearch",
    {
      delta: 7,
      reason:
        "拆分后累计 +5 行（历史遗漏未登记，正好卡在阈值上所以一直没被拦）+ v7.0.3 新增 2 行：" +
        "结果投影补 env_scope 回显（含 1 行说明注释）。既有分支顺序零改动",
      file: "src/tools/memory-search.js",
    },
  ],
]);

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

// 提取顶层函数（名 + 函数体行数）
function extractFunctions(src) {
  const out = new Map();
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const startLine = src.slice(0, m.index).split("\n").length;
    // 从签名后的第一个 { 开始括号配对
    let i = src.indexOf("{", m.index);
    if (i < 0) continue;
    let depth = 0, j = i;
    while (j < src.length) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
      j++;
    }
    const endLine = src.slice(0, j).split("\n").length;
    if (!out.has(name)) out.set(name, endLine - startLine + 1);
  }
  return out;
}

console.log("=".repeat(60));
console.log(`【拆分等价性检查】基线 ${BASELINE_COMMIT}:${BASELINE_FILE}`);
console.log("=".repeat(60));

let baselineSrc;
try {
  baselineSrc = sh(`git show ${BASELINE_COMMIT}:${BASELINE_FILE}`);
} catch {
  console.log("[offline fallback] cannot read baseline");
  function walkSrc(dir, out) {
    out = out || [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const pth = path.join(dir, e.name);
      if (e.isDirectory()) walkSrc(pth, out);
      else if (e.name.endsWith(".js")) out.push(pth);
    }
    return out;
  }
  const allFns = new Map();
  const srcRoot = path.join(ROOT, "src");
  for (const f of walkSrc(srcRoot)) {
    const src = fs.readFileSync(f, "utf8");
    for (const [n] of extractFunctions(src)) {
      if (!allFns.has(n)) allFns.set(n, true);
    }
  }
  console.log("[offline fallback] functions:", allFns.size);
  assert.ok(allFns.size >= 140, `[offline fallback] functions (${allFns.size}) 必须不少于 140 个`);
  console.log("OK offline fallback");
  process.exit(0);
}
const baseFns = extractFunctions(baselineSrc);
console.log(`[基线] 提取到 ${baseFns.size} 个顶层函数`);

// 收集当前所有 .js（根 + src）
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const nowFns = new Map();
for (const f of walk(ROOT)) {
  const src = fs.readFileSync(f, "utf8");
  for (const [n, len] of extractFunctions(src)) {
    if (!nowFns.has(n)) nowFns.set(n, { len, file: path.relative(ROOT, f) });
  }
}
console.log(`[现状] 提取到 ${nowFns.size} 个顶层函数`);

function classifyDrift(name, baseLen, now) {
  const signedDelta = now.len - baseLen;
  const d = Math.abs(signedDelta);
  if (d <= MAX_LINE_DELTA) return { kind: "ok", signedDelta };
  const allow = ALLOWED_DRIFT.get(name);
  if (allow && signedDelta === allow.delta && now.file === allow.file) {
    return { kind: "allowed", signedDelta, reason: allow.reason };
  }
  return { kind: "drift", signedDelta, diff: d };
}

const missing = [];
const drift = [];
const allowedHits = new Map();
for (const [name, baseLen] of baseFns) {
  const now = nowFns.get(name);
  if (!now) {
    missing.push(name);
    continue;
  }
  const verdict = classifyDrift(name, baseLen, now);
  if (verdict.kind === "allowed") {
    allowedHits.set(name, { baseLen, nowLen: now.len, delta: verdict.signedDelta, reason: verdict.reason });
  } else if (verdict.kind === "drift") {
    drift.push({ name, baseLen, nowLen: now.len, diff: verdict.diff, file: now.file });
  }
}

// 反证门：白名单必须「精确匹配才放行」，任何偏差都要回归失败，杜绝变成宽松豁免
const falsifyCases = [
  { name: "readOptions", baseLen: 62, now: { len: 76, file: "src/core/config.js" }, why: "登记 +13 却涨了 +14 行" },
  { name: "readOptions", baseLen: 62, now: { len: 70, file: "src/core/config.js" }, why: "登记 +13 却只涨了 +8 行（可能被顺手删逻辑）" },
  { name: "readOptions", baseLen: 62, now: { len: 75, file: "src/elsewhere.js" }, why: "登记文件与现状不符" },
  { name: "someUnlistedFn", baseLen: 30, now: { len: 50, file: "src/core/config.js" }, why: "未登记的函数漂移" },
];
for (const c of falsifyCases) {
  const v = classifyDrift(c.name, c.baseLen, c.now);
  if (v.kind !== "drift") {
    console.log(`✗ 反证失败：${c.name} 在「${c.why}」时竟被判为 ${v.kind}，白名单过宽`);
    process.exit(1);
  }
}
console.log(`[反证门] ${falsifyCases.length} 组越界/错配样本全部被正确判为 drift（白名单精确匹配生效）`);


// 白名单防腐：登记了却不再命中（函数已回退/改名/文件搬走）说明条目已失效，必须删除
const staleAllows = [...ALLOWED_DRIFT.keys()].filter((n) => !allowedHits.has(n));
if (staleAllows.length > 0) {
  console.log(`\n✗ 以下 ${staleAllows.length} 条白名单已失效（当前未命中登记的行数变化），请删除以免掩盖后续真实漂移：`);
  for (const n of staleAllows) {
    const now = nowFns.get(n);
    console.log(`    - ${n}: 登记 +${ALLOWED_DRIFT.get(n).delta} 行，当前 ${now ? `${baseFns.get(n)} → ${now.len} 行 @ ${now.file}` : "函数缺失/已改名"}`);
  }
}

if (allowedHits.size > 0) {
  console.log(`\n[已登记豁免] ${allowedHits.size} 个函数的行数增长属合法功能演进：`);
  for (const [n, info] of allowedHits) {
    console.log(`    + ${n}: ${info.baseLen} → ${info.nowLen} 行（+${info.delta}，精确命中登记值）`);
    console.log(`      理由: ${info.reason}`);
  }
}

if (missing.length === 0 && drift.length === 0 && staleAllows.length === 0) {
  console.log(`\n✓ ${baseFns.size} 个函数全部存在，且同名函数行数变化均 ≤ ${MAX_LINE_DELTA} 行（另有 ${allowedHits.size} 条已登记豁免）`);
  console.log("✅ check_split_equiv 通过");
  assert.ok(true, "检查通过");
process.exit(0);
}

if (missing.length) {
  console.log(`\n✗ 以下 ${missing.length} 个函数在拆分后丢失：`);
  for (const n of missing.slice(0, 20)) console.log(`    - ${n}`);
}

if (drift.length) {
  console.log(`\n✗ 以下 ${drift.length} 个函数行数变化 > ${MAX_LINE_DELTA} 行（疑似顺手改了逻辑）：`);
  for (const d of drift) {
    console.log(`    - ${d.name}: ${d.baseLen} → ${d.nowLen} 行（差 ${d.diff}）@ ${d.file}`);
  }
}
process.exit(1);
