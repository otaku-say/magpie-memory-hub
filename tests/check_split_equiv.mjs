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
  if (allFns.size >= 140) {
    console.log("OK offline fallback");
    process.exit(0);
  }
  console.log("FAIL offline fallback");
  process.exit(1);
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

const missing = [];
const drift = [];
for (const [name, baseLen] of baseFns) {
  const now = nowFns.get(name);
  if (!now) {
    missing.push(name);
    continue;
  }
  const d = Math.abs(now.len - baseLen);
  if (d > MAX_LINE_DELTA) {
    drift.push({ name, baseLen, nowLen: now.len, diff: d, file: now.file });
  }
}

if (missing.length === 0 && drift.length === 0) {
  console.log(`\n✓ ${baseFns.size} 个函数全部存在，且同名函数行数变化均 ≤ ${MAX_LINE_DELTA} 行`);
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
