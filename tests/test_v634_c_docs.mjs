/**
 * test_v634_c_docs.mjs —— 文档与现实一致性自动化门禁测试
 *
 * 覆盖 3 项交叉一致性核查与反证门禁：
 * 1. 【徽章与测试数一致性】
 *    - 动态统计 tests/ 下活跃 .mjs 测试文件总数（排除 test_meta.mjs 与 test_helpers.mjs）；
 *    - 动态从 README.md 正则提取测试徽章数字，断言二者一致，数字全动态推导绝不硬编码；
 *    - 反证门：篡改徽章数字故意制造漂移，断言门禁必须捕获拦截。
 * 2. 【DEVNOTES 复选框状态一致性】
 *    - 扫描 DEVNOTES.md 中所有 ## 章节下的复选框；
 *    - 断言不存在「正文/标题明确声明已完成/已修复/✅ 但复选框仍为 [ ]」的滞后漂移；
 *    - 反证门：构造包含完成声明却留空复选框的虚假样本，断言检查器必须拦截报错。
 * 3. 【MCP 工具声明与源码一致性】
 *    - 使用正则从 tools.js 动态提取 TOOLS 注册工具键清单与数量；
 *    - 使用正则从 README.md 动态提取声明的工具数量（如 21 个）；
 *    - 断言文档声明与源码注册完全一致；
 *    - 反证门：篡改工具数声明样本，断言比对逻辑必须抛错。
 * 4. 【test_meta 规范元检查自证】
 *    - 引用 scanTestFile 进行测试合规自检，断言 0 违规，纯静态无数据库写操作。
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanTestFile } from "./test_meta.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TESTS_DIR = path.resolve(ROOT, "tests");

console.log("=================================================================");
console.log("【测试开始】Track C: 文档与现实一致性门禁核查套件 (v6.34)");
console.log("=================================================================\n");

// =============================================================================
// 工具函数：统计 tests 目录活跃测试文件数
// =============================================================================
export function getActiveTestFiles(testsDir = TESTS_DIR) {
  const entries = fs.readdirSync(testsDir, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".mjs") &&
        e.name !== "test_meta.mjs" &&
        e.name !== "test_helpers.mjs"
    )
    .map((e) => e.name);
}

// =============================================================================
// 工具函数：从 README.md 提取测试徽章及相关数字
// =============================================================================
export function extractReadmeTestCounts(readmeContent) {
  const badgeMatch =
    readmeContent.match(/tests-(\d+)%20passed/i) ||
    readmeContent.match(/tests-(\d+)\s+passed/i);
  const suiteMatch = readmeContent.match(/\*\*(\d+)\s*个自动化测试套件\*\*/);
  const metaCommentMatch = readmeContent.match(/#\s*(\d+)\s*个测试文件元检查/);

  return {
    badgeCount: badgeMatch ? parseInt(badgeMatch[1], 10) : null,
    suiteCount: suiteMatch ? parseInt(suiteMatch[1], 10) : null,
    metaCommentCount: metaCommentMatch ? parseInt(metaCommentMatch[1], 10) : null,
  };
}

// =============================================================================
// 工具函数：从 tools.js 提取 TOOLS 注册键清单
// =============================================================================
export function extractToolsRegistered(toolsContent) {
  const toolsBlockMatch = toolsContent.match(/const\s+TOOLS\s*=\s*\{([\s\S]*?)\n\};/);
  if (!toolsBlockMatch) {
    throw new Error("无法从 tools.js 中定位 const TOOLS = { ... }; 字典块！");
  }
  const toolKeys = [...toolsBlockMatch[1].matchAll(/^\s{2}([a-zA-Z0-9_]+):\s*\{/gm)].map(
    (m) => m[1]
  );
  return toolKeys;
}

// =============================================================================
// 工具函数：从 README.md 提取声明的 MCP 工具数量
// =============================================================================
export function extractReadmeDeclaredToolsCount(readmeContent) {
  const headingMatch = readmeContent.match(/##\s*二、MCP\s*工具全集[（\(](\d+)\s*个/);
  const inlineMatch = readmeContent.match(/聚合本插件\s*(\d+)\s*个工具/);
  return {
    headingCount: headingMatch ? parseInt(headingMatch[1], 10) : null,
    inlineCount: inlineMatch ? parseInt(inlineMatch[1], 10) : null,
  };
}

// =============================================================================
// 工具函数：扫描 DEVNOTES.md 中「声明已完成但仍为 [ ]」的可疑项
// =============================================================================
export function scanSuspiciousDevnotesCheckboxes(devnotesContent) {
  const lines = devnotesContent.split("\n");
  const suspicious = [];
  let currentH2 = "";

  const COMPLETION_REGEX = /(?:已?完成|已修复|已闭环|✅|100%)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      currentH2 = line;
    }

    // 匹配 Markdown 复选框为未完成状态 [ ]
    if (line.includes("- [ ]") || /^\s*\d+\.\s*\[ \]/.test(line)) {
      // 1. 同一行包含完成语义
      const sameLineHit = COMPLETION_REGEX.test(line);

      // 2. 紧邻上下文（前后各 3 行）包含明确完成标记
      const contextLines = lines
        .slice(Math.max(0, i - 3), Math.min(lines.length, i + 4))
        .join("\n");
      const contextHit = COMPLETION_REGEX.test(contextLines);

      // 3. 当前二级标题明确声明已完成
      const h2Hit = COMPLETION_REGEX.test(currentH2);

      if (sameLineHit || contextHit || h2Hit) {
        suspicious.push({
          lineNo: i + 1,
          line: line.trim(),
          h2: currentH2,
          reason: sameLineHit
            ? "同一行正文包含已完成/已修复语义"
            : contextHit
            ? "紧邻上下文包含已完成/已修复语义"
            : "章节标题声明已完成但存在未勾选复选框",
        });
      }
    }
  }

  return suspicious;
}

// =============================================================================
// 1. 【门禁 1】README 顶部徽章与实际测试文件数一致性
// =============================================================================
console.log("▶ [门禁 1] 校验 README.md 测试徽章与 tests/ 实际文件数一致性...");
{
  const testFiles = getActiveTestFiles(TESTS_DIR);
  assert.ok(testFiles.length > 0, "tests/ 下必须存在 .mjs 测试文件");

  const selfName = path.basename(fileURLToPath(import.meta.url));
  const functionalTestFiles = testFiles.filter((f) => f !== selfName);

  const readmeContent = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const counts = extractReadmeTestCounts(readmeContent);

  assert.ok(counts.badgeCount !== null, "README.md 顶部必须存在 tests 徽章");
  assert.ok(counts.suiteCount !== null, "README.md 第五节必须声明自动化测试套件数");
  assert.ok(counts.metaCommentCount !== null, "README.md 第五节必须声明元检查文件数");

  // 必须三处自洽一致
  assert.strictEqual(
    counts.badgeCount,
    counts.suiteCount,
    `README.md 徽章数字 (${counts.badgeCount}) 与正文测试套件数 (${counts.suiteCount}) 必须一致`
  );
  assert.strictEqual(
    counts.badgeCount,
    counts.metaCommentCount,
    `README.md 徽章数字 (${counts.badgeCount}) 与元检查注释数 (${counts.metaCommentCount}) 必须一致`
  );

  // 动态比对：必须匹配实际活跃测试文件数（支持基线功能测试数或含门禁测试数，杜绝硬编码）
  const expectedPossibleCounts = [functionalTestFiles.length, testFiles.length];
  assert.ok(
    expectedPossibleCounts.includes(counts.badgeCount),
    `[徽章漂移拦截] README 徽章数字 (${counts.badgeCount}) 必须与实际测试文件数动态一致（当前基准: ${functionalTestFiles.length} 或含门禁: ${testFiles.length}）`
  );

  // 反证测试 1.1：故意构造滞后的徽章（如 43 或 99），必须被拦截
  const fakeTamperedBadge = readmeContent.replace(
    /tests-\d+%20passed/i,
    "tests-99%20passed"
  );
  const tamperedCounts = extractReadmeTestCounts(fakeTamperedBadge);
  assert.strictEqual(
    expectedPossibleCounts.includes(tamperedCounts.badgeCount),
    false,
    "[反证门 1.1] 篡改徽章数字为 99 时，门禁必须判定不一致并拦截！"
  );

  console.log(`  ✓ 徽章数字 (${counts.badgeCount}) 与测试文件数 (${testFiles.length}) 动态核对通过，反证门拦截生效\n`);
}

// =============================================================================
// 2. 【门禁 2】DEVNOTES.md 复选框与正文完成状态一致性
// =============================================================================
console.log("▶ [门禁 2] 校验 DEVNOTES.md 中所有复选框状态与正文完成状态一致性...");
{
  const devnotesContent = fs.readFileSync(path.join(ROOT, "DEVNOTES.md"), "utf8");
  const suspicious = scanSuspiciousDevnotesCheckboxes(devnotesContent);

  if (suspicious.length > 0) {
    console.error("❌ 发现 DEVNOTES.md 存在「正文声明完成但复选框为 [ ]」的滞后项:");
    for (const item of suspicious) {
      console.error(`   - [Line ${item.lineNo}] (${item.reason}) 标题: ${item.h2} => ${item.line}`);
    }
  }

  assert.strictEqual(
    suspicious.length,
    0,
    `DEVNOTES.md 中严禁存在正文/标题声明完成但复选框为未完成 [ ] 的漂移项（发现 ${suspicious.length} 处）`
  );

  // 反证测试 2.1：故意构造未勾选但正文写「已完成」的假样本，断言必须被识别拦截
  const fakeTamperedDevnotes = `
## 二十四、测试整改检查点 (100% 全部完成)
- [ ] 关键整改项已完成落地与闭环
  - [ ] 子模块修复已完成
  `;
  const fakeSuspicious = scanSuspiciousDevnotesCheckboxes(fakeTamperedDevnotes);
  assert.ok(
    fakeSuspicious.length >= 2,
    "[反证门 2.1] 故意构造的未勾选却声明已完成样本必须被门禁精准拦截！"
  );

  console.log("  ✓ DEVNOTES.md 全量复选框对齐校验通过，0 滞后项，反证门拦截生效\n");
}

// =============================================================================
// 3. 【门禁 3】README.md 声明的 MCP 工具数与 tools.js 注册工具数一致性
// =============================================================================
console.log("▶ [门禁 3] 校验 README.md 声明 MCP 工具数与 tools.js 实际注册数一致性...");
{
  const toolsContent = fs.readFileSync(path.join(ROOT, "tools.js"), "utf8");
  const registeredTools = extractToolsRegistered(toolsContent);
  assert.ok(registeredTools.length > 0, "tools.js 中必须注册至少 1 个 MCP 工具");

  const readmeContent = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const declared = extractReadmeDeclaredToolsCount(readmeContent);

  assert.ok(declared.headingCount !== null, "README.md 必须包含「## 二、MCP 工具全集（N 个...）」标题");
  assert.ok(declared.inlineCount !== null, "README.md 必须包含「聚合本插件 N 个工具」架构说明");

  // 断言文档内两处声明工具数一致
  assert.strictEqual(
    declared.headingCount,
    declared.inlineCount,
    `README.md 标题工具数 (${declared.headingCount}) 与架构图工具数 (${declared.inlineCount}) 必须一致`
  );

  // 核心断言：文档声明的工具数必须与 tools.js 实际注册工具数完全一致
  assert.strictEqual(
    declared.headingCount,
    registeredTools.length,
    `[工具数漂移拦截] README.md 声明工具数 (${declared.headingCount}) 必须与 tools.js 注册数 (${registeredTools.length}) 严格一致！`
  );

  // 反证测试 3.1：故意篡改 README 声明工具数为 19，断言门禁必定拦截
  const fakeReadmeTools = readmeContent.replace(
    /MCP 工具全集[（\(]\d+\s*个/g,
    "MCP 工具全集（19 个"
  );
  const tamperedDeclared = extractReadmeDeclaredToolsCount(fakeReadmeTools);
  assert.notStrictEqual(
    tamperedDeclared.headingCount,
    registeredTools.length,
    "[反证门 3.1] 篡改文档工具数声明为 19 时，门禁必须判定不一致并拦截！"
  );

  console.log(`  ✓ 源码注册工具数 (${registeredTools.length}) 与文档声明 (${declared.headingCount}) 完全对齐，反证门拦截生效\n`);
}

// =============================================================================
// 4. 【元检查自检】test_meta 规范元检查自证
// =============================================================================
console.log("▶ [元检查自检] 对本测试文件进行 test_meta 规范合规性自检...");
{
  const thisFile = fileURLToPath(import.meta.url);
  const rawContent = fs.readFileSync(thisFile, "utf8");
  const scanRes = scanTestFile(thisFile, rawContent);

  if (scanRes.issues.length > 0) {
    console.error("❌ test_v634_c_docs.mjs 存在 test_meta 规范违规:");
    for (const is of scanRes.issues) {
      console.error("   -", is);
    }
  }

  assert.strictEqual(
    scanRes.issues.length,
    0,
    "本测试文件自身必须 100% 符合 test_meta 测试规范！"
  );
  assert.strictEqual(
    scanRes.hasDbWrite,
    false,
    "本测试纯文档与现实交叉静态校验，不触碰数据库写操作"
  );

  console.log("  ✓ 本测试文件经 test_meta 扫描，0 规范违规！\n");
}

console.log("=================================================================");
console.log("✅ 全部 3 大文档与现实一致性门禁及反证门 100% 全部通过！");
console.log("=================================================================");
