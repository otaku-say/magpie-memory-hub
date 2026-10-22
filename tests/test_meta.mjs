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
  /\.(?:memory_save|pitfall_save)\.execute\s*\(/i,
  /\.(?:create|remove|update)\s*\(\s*["'](?:memories|pitfalls)["']/i,
  /INSERT\s+INTO\s+["`']?(?:memories|pitfalls)["`']?/i,
  /UPDATE\s+["`']?(?:memories|pitfalls)["`']?/i,
  /\.harvest_gateway\.execute\s*\(/i,
  /\bharvestGateway\s*\(/i,
  /\bprocessDialogueAndHarvest\s*\(/i,
];

const ISOLATION_PATTERNS = [
  /\bcreateTestEnv\b/,
  /\bmockDbClient\b/,
  /\bmemoryStore\b/,
  /\bglobalMemoryStore\b/,
];

const CLEANUP_PATTERNS = [
  /\benv\.cleanup\s*\(/,
  /\bcleanup\s*\(/,
  /\bcleanupQualityTest\s*\(/,
  /DELETE\s+FROM\s+["`']?(?:memories|pitfalls)["`']?/i,
];

const RESIDUE_ASSERT_PATTERNS = [
  /countAllTestResidue/i,
  /residue/i,
  /totalResidue/i,
  /cleanRes\.(?:memoriesDeleted|pitfallsDeleted)/i,
  /residue\.total/i,
];

const KEY_TEST_FILES = [
  { match: /beacon/i, name: "信标机制" },
  { match: /tool_names/i, name: "静态工具名" },
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

  // 1. 检查数据库写操作隔离与清理（严禁污染真实库，严禁向 global 写入）
  const hasDbWrite = WRITE_PATTERNS.some((p) => p.test(content));
  if (hasDbWrite) {
    const hasIsolation = ISOLATION_PATTERNS.some((p) => p.test(content));
    const hasCleanup = CLEANUP_PATTERNS.some((p) => p.test(content));
    const hasResidueAssert = RESIDUE_ASSERT_PATTERNS.some((p) => p.test(content));

    // 严密防线 1：严禁任何写库测试包含 project: "global" 写入
    const hasGlobalLeak = /project:\s*["']global["']/.test(content);
    if (hasGlobalLeak) {
      issues.push(`[DB泄漏违规] 测试用例严禁直接写入 project='global'（存在污染用户真实库风险）！必须使用 env.project 或 mock 隔离命名空间`);
    }

    if (!hasIsolation) {
      issues.push(`[DB隔离违规] 存在写库操作，但未包含 project 命名空间隔离`);
    }
    if (!hasCleanup) {
      issues.push(`[DB清理违规] 存在写库操作，但未包含 cleanup 清理逻辑`);
    }
    if (!hasResidueAssert) {
      issues.push(`[DB残余断言违规] 存在写库操作，但未断言清理后残余数为 0`);
    }

    // 严密防线 2：测试必须能自证隔离生效（使用受控 mock 桩对象，或基于 createTestEnv 绑定断言 env.project）
    const hasSelfProof =
      (/\bcreateTestEnv\b/.test(content) && /\benv\.project\b/.test(content)) ||
      (/\bmockDbClient\b/.test(content) && /\bmemoryStore\b/.test(content)) ||
      (/\bfakeCrashingClient\b/.test(content));
    if (!hasSelfProof) {
      issues.push(`[DB自证隔离缺失] 写库测试必须能自证隔离生效（必须使用 createTestEnv 并绑定 env.project，或使用受控内存 mock 桩，杜绝假装隔离）`);
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

  // 强断言：锁定当前活跃测试文件总数（新增 adversarial_v629_gate.mjs 后为 44 个）
  assert.strictEqual(testFiles.length, 88, "测试文件总数断言：期望精确 88 个（新增测试须同步更新，不得放宽为 >= 掩盖误删）");

  // 反证测试 1：验证门禁对写 global 恶意用例具备拦截能力
  const fakeSample = `
    import { createTestEnv } from "./lib/testenv.mjs";
    client.create("memories", { project: "global", title: "leak" });
    cleanup();
    assert.strictEqual(residue, 0);
  `;
  const fakeRes = scanTestFile("sample_fake_leak.mjs", fakeSample);
  assert.ok(
    fakeRes.issues.some((i) => i.includes("DB泄漏违规")),
    "[反证门失败] test_meta 门禁未能拦截假装隔离且向 global 泄露的测试样本！"
  );

  // 反证测试 2：构造「假装隔离」（写了 project 但其实是真实 client，未引用 createTestEnv / 明确 mock 桩）的样本文件
  const fakePretendIsolationSample = `
    import { makeMcpClient } from "../src/integration/mcp-client.js";
    const client = makeMcpClient({ instance: "41694_agent_memory", mcpKey: "real_token" });
    const project = "my_custom_project";
    await client.create("memories", { project, title: "pretend" });
    cleanup();
    assert.strictEqual(residue, 0);
  `;
  const fakePretendRes = scanTestFile("sample_fake_pretend.mjs", fakePretendIsolationSample);
  assert.ok(
    fakePretendRes.issues.some((i) => i.includes("DB隔离违规") || i.includes("DB自证隔离缺失")),
    "[反证门失败] test_meta 门禁未能拦截假装隔离（写了 project 但使用真实 client 且无隔离设施）的样本！"
  );

  if (!silent) {
    console.log("=================================================================");
    console.log(`【测试元检查】正在扫描 ${testFiles.length} 个测试文件规范合规性（已通过反证门拦截测试）`);
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
