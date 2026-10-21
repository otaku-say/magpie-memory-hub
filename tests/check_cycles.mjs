#!/usr/bin/env node
/**
 * tests/check_cycles.mjs
 *
 * 模块职责：检测全仓 JS 模块的循环依赖（强连通分量）
 * 依赖：node:fs / node:path / node:url
 * 被依赖：tests/test_meta.mjs（规范扫描）、CI
 *
 * 覆盖四类依赖边（缺一类就会漏掉一半环）：
 *   1. import ... from "x"
 *   2. export ... from "x"
 *   3. export * from "x"
 *   4. 动态 import("x")   ← 注意裸 import() 不带 await 也要算
 *
 * 算法：Tarjan 强连通分量，SCC 节点数 > 1 即为环。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 允许存在的环白名单（目前为空：目标是零环）
const ALLOWED_CYCLES = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = walk(ROOT).map((p) => path.relative(ROOT, p));
const fileSet = new Set(files);
const srcCache = new Map();
for (const f of files) srcCache.set(f, fs.readFileSync(path.join(ROOT, f), "utf8"));

// 建图
const edges = new Map();
for (const f of files) {
  const s = srcCache.get(f);
  const set = new Set();
  // 静态 import/export ... from "spec"
  // 支持多行 import 块：从 import/export 起到 from，中途不得出现新的 import/export 关键字
  const reStatic =
    /(?:^|\n)\s*(?:import|export)\s+(?:(?!\n\s*(?:import|export)\b)[\s\S])*?\bfrom\s+["']([^"']+)["']/g;
  let m;
  while ((m = reStatic.exec(s))) addEdge(f, m[1], set);
  // 裸 import "spec"（副作用导入）
  const reBare = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  while ((m = reBare.exec(s))) addEdge(f, m[1], set);
  // 动态 import("spec") —— 同时覆盖 await import 与裸 import()
  const reDyn = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = reDyn.exec(s))) addEdge(f, m[1], set);
  edges.set(f, set);
}

function addEdge(fromFile, spec, set) {
  if (!spec.startsWith(".")) return; // 只关心仓库内相对路径
  const resolved = path.normalize(path.join(path.dirname(fromFile), spec));
  const candidates = [resolved, resolved + ".js", path.join(resolved, "index.js")];
  for (const c of candidates) {
    if (fileSet.has(c)) {
      set.add(c);
      return;
    }
  }
}

// Tarjan
let counter = 0;
const idx = new Map(), low = new Map(), onStack = new Set(), stack = [];
const sccs = [];

function strongConnect(v) {
  idx.set(v, counter); low.set(v, counter); counter++;
  stack.push(v); onStack.add(v);
  for (const w of edges.get(v) || []) {
    if (!idx.has(w)) {
      strongConnect(w);
      low.set(v, Math.min(low.get(v), low.get(w)));
    } else if (onStack.has(w)) {
      low.set(v, Math.min(low.get(v), idx.get(w)));
    }
  }
  if (low.get(v) === idx.get(v)) {
    const comp = [];
    let w;
    do {
      w = stack.pop(); onStack.delete(w); comp.push(w);
    } while (w !== v);
    if (comp.length > 1) sccs.push(comp);
  }
}

for (const f of files) if (!idx.has(f)) strongConnect(f);

// 过滤白名单
const realCycles = sccs.filter((comp) => {
  const key = [...comp].sort().join("|");
  return !ALLOWED_CYCLES.some((a) => [...a].sort().join("|") === key);
});

console.log("=".repeat(60));
console.log(`【循环依赖检查】扫描 ${files.length} 个模块文件`);
console.log("=".repeat(60));

if (realCycles.length === 0) {
  console.log("✓ 无任何循环依赖！");
  process.exit(0);
}

console.log(`✗ 发现 ${realCycles.length} 个循环依赖环：\n`);
for (const comp of realCycles) {
  console.log(`  ── 环大小 ${comp.length} ──`);
  for (const f of comp.sort()) {
    const outs = [...(edges.get(f) || [])].filter((t) => comp.includes(t));
    console.log(`     ${f}  →  ${outs.join(", ")}`);
  }
  console.log("");
}
console.log("修复思路：找到环内最「反向」的那条边，用依赖注入或下沉到低层模块来切断。");
process.exit(1);
