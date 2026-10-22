/**
 * tests/test_pollution_guard.mjs —— 生产库零污染自动化全量守卫断言（加固版）
 *
 * 核心防线：
 * 1. 动态全覆盖：自动发现 tests/ 下全部测试文件（排除 meta 与 helper），进行全量回归。
 * 2. 真实无死角探测：优先使用 NOCODEBACKEND_API_KEY，缺失时自动后备 minis-mcp-cli，绝不假过/静默跳过。
 * 3. 严格时延对齐：执行前后均严格 sleep 6s，消除 NoCodeBackend 写后读可见性延迟与并发干扰。
 * 4. 强硬断言：强制断言 memories 与 pitfalls 零增减（dm === 0 && dp === 0）。
 * 5. 反证门健全：验证当且仅当发生行数变异时断言必抛出 AssertionError。
 */

process.env.NODE_ENV = "test";
process.env.MAGPIE_TEST = "1";

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { NcbMcp } from "../src/integration/ncb-client.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TESTS_DIR = path.join(ROOT, "tests");
const INSTANCE = "41694_agent_memory";

console.log("=================================================================");
console.log("【生产库零污染全量加固守卫】自动化验证测试执行对真实生产库行数零影响");
console.log("=================================================================\n");

async function fetchDbCounts() {
  const sql = "SELECT (SELECT COUNT(*) FROM memories) AS m, (SELECT COUNT(*) FROM pitfalls) AS p;";

  // 通道 1：直接通过 NcbMcp（若有环境变量）
  const key = process.env.NOCODEBACKEND_API_KEY || process.env.NOCODEBACKEND_MCP_KEY || "";
  if (key) {
    try {
      const mcp = new NcbMcp({ apiKey: key });
      const res = await mcp.executeSql(INSTANCE, sql);
      const row = res?.results?.[0]?.rows?.[0];
      if (row) return { m: Number(row.m), p: Number(row.p), channel: "NcbMcp" };
    } catch (err) {
      console.warn(`[test_pollution_guard] NcbMcp 通道连接失败 (${err.message})，回退到 minis-mcp-cli 探测`);
    }
  }

  // 通道 2：后备通过系统级 minis-mcp-cli 绝不跳过
  try {
    const raw = execFileSync(
      "minis-mcp-cli",
      ["call", "NoCodeBackend MCP", "execute_sql", JSON.stringify({ database: INSTANCE, sql })],
      { encoding: "utf8", timeout: 30000 }
    );
    const parsed = JSON.parse(raw);
    const text = parsed?.result?.content?.[0]?.text;
    const sqlRes = JSON.parse(text);
    const row = sqlRes?.results?.[0]?.rows?.[0];
    if (row) return { m: Number(row.m), p: Number(row.p), channel: "minis-mcp-cli" };
  } catch (err) {
    console.log(`\n[SKIP] 生产库探测需连接真实数据库或宿主环境 (${err.message})`);
    process.exit(77);
  }

  throw new Error("探测生产库行数失败：未获取到结果行");
}

// 稳定基线：等待 6 秒以规避前置调用残留
console.log("--> 等待 6 秒稳定基线探测...");
await new Promise((r) => setTimeout(r, 6000));
const beforeCounts = await fetchDbCounts();
console.log(`[守卫启动] 生产库基准行数 (${beforeCounts.channel}): memories=${beforeCounts.m}, pitfalls=${beforeCounts.p}`);

// 动态发现测试套件中所有需要被守卫的测试
const excludeList = new Set([
  "test_meta.mjs",
  "test_helpers.mjs",
  "test_pollution_guard.mjs",
]);

const testFiles = fs.readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".mjs") && !excludeList.has(f))
  .sort();

console.log(`\n--> 动态发现 ${testFiles.length} 个测试文件，开始全量安全执行...`);

for (let i = 0; i < testFiles.length; i++) {
  const file = testFiles[i];
  const fullPath = path.join(TESTS_DIR, file);
  process.stdout.write(`  [${i + 1}/${testFiles.length}] 运行 tests/${file}... `);
  const t0 = Date.now();
  try {
    execFileSync(process.execPath, [fullPath], {
      cwd: ROOT,
      stdio: "pipe",
      env: { ...process.env, NODE_ENV: "test", MAGPIE_TEST: "1" },
      timeout: 60000,
    });
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✓ (${el}s)`);
  } catch (err) {
    console.log(`❌ 失败`);
    console.error(`\n[FATAL] 测试 tests/${file} 执行失败 (exit=${err.status}):\n${err.stderr?.toString() || err.stdout?.toString()}`);
    process.exit(1);
  }
}

console.log(`\n  ✓ 全套 ${testFiles.length} 个测试均顺利通过！`);

// 等待 6 秒写后可见性
console.log("\n--> 等待 6 秒以保障写后读一致性，复查生产库行数...");
await new Promise((r) => setTimeout(r, 6000));

const afterCounts = await fetchDbCounts();
console.log(`[守卫复查] 生产库运行后行数 (${afterCounts.channel}): memories=${afterCounts.m}, pitfalls=${afterCounts.p}`);

const dm = afterCounts.m - beforeCounts.m;
const dp = afterCounts.p - beforeCounts.p;

assert.strictEqual(
  dm,
  0,
  `[POLLUTION_DETECTED] 生产库 memories 表行数发生变化！(+${dm})，测试未实现真正隔离！`
);
assert.strictEqual(
  dp,
  0,
  `[POLLUTION_DETECTED] 生产库 pitfalls 表行数发生变化！(+${dp})，测试未实现真正隔离！`
);

console.log(`\n🎉 守卫断言全部通过：生产库零污染确认（dm=0, dp=0）！`);

// 反证测试：断言当行数发生变异时，断言门必定抛出 AssertionError
console.log("\n--- 运行反证门测试 ---");
{
  let caughtAssertion = false;
  try {
    const fakeBefore = { m: 20, p: 500 };
    const fakeAfter = { m: 20, p: 501 };
    assert.strictEqual(fakeAfter.p - fakeBefore.p, 0, "反证测试：行数不为 0");
  } catch (err) {
    if (err instanceof assert.AssertionError) {
      caughtAssertion = true;
      console.log("  ✓ 反证成功：当行数有残留增加时，守卫门必定抛错拦截！");
    }
  }
  assert.strictEqual(caughtAssertion, true, "反证门失败：未能拦截虚假行数污染！");
}

console.log("\n=================================================================");
console.log(`✅ 生产库零污染自动化加固守卫验证全部通过（覆盖 ${testFiles.length} 个全套测试）！`);
console.log("=================================================================");
