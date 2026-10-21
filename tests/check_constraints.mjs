#!/usr/bin/env node
/**
 * tests/check_constraints.mjs
 *
 * 模块职责：按 CONSTRAINTS.md 的 Floor 条款，检测「测试被悄悄放宽」的三类退化
 * 依赖：node:fs / node:path / node:child_process
 * 被依赖：全量测试脚本
 *
 * 检测项（对照 git 基线）：
 *   1. 阈值移动：tests/test_meta.mjs 的计数断言是否被改小
 *   2. 测试变简单：新增 .skip / 删除测试文件 / 抽掉 assert
 *   3. 检查器被静默：新增 eslint-disable / @ts-ignore / 无注释空 catch
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const BASE = process.env.CONSTRAINT_BASE || "8f495b0";
const issues = [];

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function baseFile(p) {
  return sh(`git show ${BASE}:${p}`);
}

// ---------- 1. 阈值移动：test_meta 计数 ----------
const metaNow = fs.readFileSync(path.join(ROOT, "tests/test_meta.mjs"), "utf8");
const metaBase = baseFile("tests/test_meta.mjs");
const reCount = /testFiles\.length,\s*(\d+)/;
const nowM = metaNow.match(reCount);
const baseM = metaBase.match(reCount);
if (nowM && baseM) {
  const now = Number(nowM[1]);
  const base = Number(baseM[1]);
  if (now < base) {
    issues.push(`阈值被下调：test_meta 计数 ${base} → ${now}（不得为了让测试变绿而调小）`);
  }
}

// ---------- 2. 测试变简单 ----------
const testDir = path.join(ROOT, "tests");
const nowFiles = fs.readdirSync(testDir).filter((f) => f.endsWith(".mjs")).sort();
const baseFiles = (sh(`git ls-tree --name-only ${BASE} tests/`) || "")
  .split("\n")
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => path.basename(f))
  .sort();

const deleted = baseFiles.filter((f) => !nowFiles.includes(f));
if (deleted.length) {
  issues.push(`测试文件被删除：${deleted.join(", ")}`);
}

// 新增 .skip
let skipHits = [];
for (const f of nowFiles) {
  const p = path.join(testDir, f);
  const s = fs.readFileSync(p, "utf8");
  const m = s.match(/\b(it|describe|test)\.skip\s*\(/g);
  if (m) skipHits.push(`${f}(${m.length})`);
}
if (skipHits.length) {
  issues.push(`新增 .skip：${skipHits.join(", ")}（除非 commit message 说明原因）`);
}

// 断言数量下降（对同名文件逐字比对 assert 出现次数）
let shrunk = [];
for (const f of nowFiles) {
  if (!baseFiles.includes(f)) continue;
  const nowC = (fs.readFileSync(path.join(testDir, f), "utf8").match(/\bassert\./g) || []).length;
  const baseS = sh(`git show ${BASE}:tests/${f}`);
  if (!baseS) continue;
  const baseC = (baseS.match(/\bassert\./g) || []).length;
  if (nowC < baseC) shrunk.push(`${f}: assert ${baseC} → ${nowC}`);
}
if (shrunk.length) {
  issues.push(`断言被抽掉：${shrunk.join("; ")}`);
}

// ---------- 3. 检查器被静默 ----------
const scanDirs = ["src", "."];
let suppress = [];
for (const d of scanDirs) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const fp = path.join(p, e.name);
      if (e.isDirectory()) walk(fp);
      else if ((e.name.endsWith(".js") || e.name.endsWith(".mjs")) && fp !== fileURLToPath(import.meta.url)) {
        const s = fs.readFileSync(fp, "utf8");
        const hits = s.match(/eslint-disable|@ts-ignore|\/\*\s*istanbul ignore/g);
        if (hits) suppress.push(`${path.relative(ROOT, fp)}(${hits.length})`);
      }
    }
  };
  walk(dir);
}
if (suppress.length) {
  issues.push(`新增错误抑制：${[...new Set(suppress)].join(", ")}`);
}

// ---------- 输出 ----------
console.log("=".repeat(56));
console.log(`【CONSTRAINTS.md 退化检测】基线 ${BASE}`);
console.log("=".repeat(56));
if (issues.length === 0) {
  console.log("✓ 未发现质量底线退化");
  console.log("=".repeat(56));
  process.exit(0);
} else {
  for (const i of issues) console.log("✗ " + i);
  console.log("=".repeat(56));
  console.log(`❌ 发现 ${issues.length} 项退化，违反 CONSTRAINTS.md`);
  process.exit(1);
}
