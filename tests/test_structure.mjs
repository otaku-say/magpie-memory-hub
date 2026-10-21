#!/usr/bin/env node
import assert from "node:assert";
/**
 * tests/test_structure.mjs
 *
 * 模块职责：目录结构守护——门面行数、门面纯净度、目录白名单、模块注释头
 * 依赖：node:fs / node:path / node:url
 * 被依赖：tests/test_meta.mjs、CI
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 根目录允许存在的门面（超过行数上限即失败）
const GATES = {
  "tools.js": 35,
  "memory.middleware.js": 35,
  "gateway_harvest.hooks.js": 40,
  "gateway_harvest.js": 40,
  "local_state.js": 20,
  "scrub.js": 20,
  "model_budget.js": 20,
  "semantic_dedup.js": 20,
  "ncb_mcp.js": 20,
  "mcp_client.js": 20,
  "schema.js": 20,
  "online_models.js": 20,
  "db_tools.js": 20,
  "r2.js": 20,
  "page_actions.js": 20,
};

// 根目录允许存在的非门面 JS（运行时状态、测试辅助）
const ROOT_ALLOWED_NON_GATE = ["_status.js"];

// src/ 允许的一级目录
const SRC_DIRS = ["core", "domain", "integration", "services", "tools", "middleware", "page"];

const issues = [];
const warns = [];

// ---- 1. 根目录 JS 白名单 ----
const rootJs = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js"));
for (const f of rootJs) {
  if (!GATES[f] && !ROOT_ALLOWED_NON_GATE.includes(f)) {
    issues.push(`根目录出现非白名单 JS：${f}（应移入 src/ 或加进白名单）`);
  }
}

// ---- 2. 门面行数 + 纯净度 ----
console.log("【根门面检查】");
for (const [f, max] of Object.entries(GATES)) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) {
    issues.push(`门面缺失：${f}`);
    continue;
  }
  const src = fs.readFileSync(p, "utf8");
  const lines = src.split("\n").length;
  const ok = lines <= max;
  console.log(`  ${ok ? "✓" : "✗"} ${f}: ${lines} 行（上限 ${max}）`);
  if (!ok) issues.push(`${f} 超出行数上限：${lines} > ${max}`);

  // 去掉注释与 import/export 行后，看剩多少实质代码
  let body = src.replace(/\/\*[\s\S]*?\*\//g, "");
  body = body.replace(/\/\/[^\n]*/g, "");
  const residual = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(import|export)\b/.test(l));
  if (residual.length > 0) {
    issues.push(`${f} 门面含实现（残留 ${residual.length} 行）：${residual[0].slice(0, 60)}`);
    console.log(`     ✗ 非导入导出残留 ${residual.length} 行`);
  }
}

// ---- 3. src/ 一级目录白名单 ----
const srcRoot = path.join(ROOT, "src");
if (fs.existsSync(srcRoot)) {
  const dirs = fs.readdirSync(srcRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const extra = dirs.filter((d) => !SRC_DIRS.includes(d));
  if (extra.length) issues.push(`src/ 出现非白名单目录：${extra.join(", ")}`);

  // ---- 4. 每个模块必须有中文注释头 ----
  const walk = (p, out = []) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) walk(fp, out);
      else if (e.name.endsWith(".js")) out.push(fp);
    }
    return out;
  };
  const mods = walk(srcRoot);
  let missing = 0;
  const big = [];
  for (const m of mods) {
    const head = fs.readFileSync(m, "utf8").split("\n").slice(0, 6).join("\n");
    if (!head.includes("模块职责")) {
      missing++;
      if (missing <= 3) issues.push(`模块缺中文注释头：${path.relative(ROOT, m)}`);
    }
    const lines = fs.readFileSync(m, "utf8").split("\n").length;
    if (lines > 400) big.push(`${path.relative(ROOT, m)}: ${lines} 行`);
  }
  console.log(`  ✓ src/ 目录合规：${dirs.length} 个一级目录，${mods.length} 个模块`);

  // 行数超 400 只警告，不失败（按职责内聚优先）
  if (big.length) {
    warns.push(`\n⚠️ [WARN] 以下模块 > 400 行（职责单一可保留，请人工确认）：`);
    for (const b of big) warns.push(`    - ${b}`);
  }
}

// ---- 输出 ----
for (const w of warns) console.log(w);

if (issues.length === 0) {
  console.log("\n✅ 目录结构守护断言全部通过！");
  assert.ok(true, "检查通过");
process.exit(0);
}

console.log(`\n❌ 发现 ${issues.length} 项结构违规：`);
for (const i of issues) console.log("  ✗ " + i);
assert.fail("检查失败");
process.exit(1);
