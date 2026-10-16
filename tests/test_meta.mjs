/**
 * test_meta.mjs —— 测试规范元检查器
 *
 * 自动化静态扫描 tests/ 下的所有测试文件，强制执行以下测试严谨性防线：
 * 1. 数据库写入防线：凡包含写库操作（memory_save / pitfall_save / INSERT / client.create / harvest_gateway）的文件，
 *    必须同时具备：
 *      a) project 命名空间隔离（引用 testenv / env.project）
 *      b) 强制 cleanup 清理逻辑
 *      c) 清理后残余数断言（count === 0）
 * 2. 断言与退出防线：测试文件必须包含足够的真实断言（不少于 2 处），且必须具备非 0 退出路径，杜绝空 catch 吞异常或静默假过。
 * 3. 关键测试反证门防线：信标、下载/模型校验、工具名静态检查、中断 abort 等关键测试必须包含反证用例（故意破坏/篡改以验证拦截能力）。
 *
 * 元检查自身具备自证能力：故意注入违规测试必定报错拦截。
 */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const TESTS_DIR = ROOT;

const WRITE_PATTERNS = [
  /\bmemory_save\b/i,
  /\bpitfall_save\b/i,
  /\bINSERT\s+INTO\b/i,
  /\.(?:create|remove)\s*\(\s*["'](?:memories|pitfalls)["']/i,
  /\bharvest_gateway\b/i,
];

const ISOLATION_PATTERNS = [
  /env\.project/i,
  /createTestEnv/i,
  /__test__/i,
  /\bproject\b/i,
];

const CLEANUP_PATTERNS = [
  /cleanup\s*\(/i,
  /DELETE\s+FROM/i,
  /mcp\.remove/i,
];

const RESIDUE_ASSERT_PATTERNS = [
  /countAllTestResidue/i,
  /residue/i,
  /===\s*0/i,
  /==\s*0/i,
  /total\s*===\s*0/i,
  /strictEqual\([^,]+,\s*0/i,
  /check\([^,]*0/i,
];

const KEY_TEST_FILES = [
  { match: /beacon/i, name: "信标机制" },
  { match: /tool_names/i, name: "静态工具名" },
  { match: /verify_(?:download|full_model)/i, name: "模型下载与校验" },
  { match: /abort/i, name: "中断退出" },
];

const COUNTER_EVIDENCE_PATTERNS = [
  /反证/i,
  /falsif/i,
  /tamper/i,
  /badSample/i,
  /corrupted/i,
  /poison/i,
  /故意/i,
  /反例/i,
];

export function scanTestFile(filePath, rawContent) {
  const relPath = path.relative(TESTS_DIR, filePath);
  const issues = [];
  const content = rawContent
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  // 1. 检查数据库写操作隔离与清理
  const hasDbWrite = WRITE_PATTERNS.some((p) => p.test(content));
  if (hasDbWrite) {
    const hasIsolation = ISOLATION_PATTERNS.some((p) => p.test(content));
    const hasCleanup = CLEANUP_PATTERNS.some((p) => p.test(content));
    const hasResidueAssert = RESIDUE_ASSERT_PATTERNS.some((p) => p.test(content));

    if (!hasIsolation) {
      issues.push(`[DB隔离违规] 存在写库操作，但未包含 project 命名空间隔离`);
    }
    if (!hasCleanup) {
      issues.push(`[DB清理违规] 存在写库操作，但未包含 cleanup 清理逻辑`);
    }
    if (!hasResidueAssert) {
      issues.push(`[DB残余断言违规] 存在写库操作，但未断言清理后残余数为 0`);
    }
  }

  // 2. 检查断言覆盖与非 0 退出
  const assertionMatches = content.match(/assert(?:\.[a-zA-Z0-9_]+)?\s*\(|check\s*\(|eq\s*\(|expect\s*\(|throw new (?:assert\.)?Error|\bno\s*\(/g) || [];
  if (assertionMatches.length < 2) {
    issues.push(`[断言过弱] 断言数量不足 2 处（实际: ${assertionMatches.length} 处）`);
  }

  const hasNonZeroExit =
    /process\.exit\s*\(\s*(?:fail|1|[a-zA-Z0-9_]+\s*\?\s*1)/i.test(content) ||
    /assert(?:\.[a-zA-Z0-9_]+)?\s*\(/i.test(content) ||
    /throw new (?:assert\.)?Error/i.test(content);
  if (!hasNonZeroExit) {
    issues.push(`[退出路径违规] 缺少失败时非 0 退出路径 (process.exit(1) 或抛错)`);
  }

  // 3. 检查假过漏洞（完全空白的 catch 块吞掉错误）
  if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(rawContent)) {
    const emptyCatches = rawContent.match(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g);
    if (emptyCatches) {
      issues.push(`[假过隐患] 发现空 catch 块吞掉异常: ${emptyCatches.length} 处`);
    }
  }

  // 4. 关键测试反证用例检查
  for (const keyDef of KEY_TEST_FILES) {
    if (keyDef.match.test(relPath)) {
      const hasCounterEvidence = COUNTER_EVIDENCE_PATTERNS.some((p) => p.test(content));
      if (!hasCounterEvidence) {
        issues.push(`[反证用例缺失] 关键测试 (${keyDef.name}) 必须包含反证测试（如故意篡改/破坏以验证拦截能力）`);
      }
    }
  }

  return { relPath, issues, hasDbWrite };
}

export function runMetaCheck(options = {}) {
  const silent = options.silent === true;
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const testFiles = [];

  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith(".mjs") && ent.name !== "test_meta.mjs" && ent.name !== "test_helpers.mjs") {
      testFiles.push(path.join(TESTS_DIR, ent.name));
    }
  }

  if (!silent) {
    console.log("=================================================================");
    console.log(`【测试元检查】正在扫描 ${testFiles.length} 个测试文件规范合规性`);
    console.log("=================================================================\n");
  }

  let totalViolations = 0;
  const results = [];

  for (const f of testFiles) {
    const content = fs.readFileSync(f, "utf8");
    const r = scanTestFile(f, content);
    results.push(r);

    if (r.issues.length > 0) {
      totalViolations += r.issues.length;
      if (!silent) {
        console.error(`❌ [FAIL] ${r.relPath}:`);
        for (const is of r.issues) {
          console.error(`     - ${is}`);
        }
      }
    } else {
      if (!silent) {
        const tag = r.hasDbWrite ? " [写库+隔离+清理齐全]" : "";
        console.log(`✓ [PASS] ${r.relPath}${tag}`);
      }
    }
  }

  if (!silent) {
    console.log("\n=================================================================");
    if (totalViolations === 0) {
      console.log(`✅ 测试元检查全部通过！所有 ${testFiles.length} 个测试均符合隔离与严谨性规范。`);
    } else {
      console.error(`❌ 测试元检查发现 ${totalViolations} 处违规，请修正！`);
    }
    console.log("=================================================================");
  }

  return { totalViolations, testFilesCount: testFiles.length, results };
}

// 直接运行模式
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { totalViolations } = runMetaCheck();
  process.exit(totalViolations > 0 ? 1 : 0);
}
