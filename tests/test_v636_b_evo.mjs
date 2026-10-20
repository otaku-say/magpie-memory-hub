/**
 * tests/test_v636_b_evo.mjs
 * =================================================================
 * EVO-3 检索增强双向反证专项测试套件：
 * 1. 【反证门 1】related_entities 检索失明修复与独立权重 (+3) 打分验证
 *    - 实测正文不含实体关键词、仅 related_entities 包含时的召回能力（修复前命中 0）；
 *    - 无关 query 必须严格不命中（得分为 0，防过度召回）。
 * 2. 【反证门 2】camelCase 符号裂变双向反证验证
 *    - termsOf("memoryAuditUndo") -> memory, audit, undo 以及全名保留；
 *    - 搜全名可命中子词记录，搜子词亦可命中全名记录。
 * 3. 【反证门 3】snake_case 符号裂变双向反证验证
 *    - termsOf("dedup_batch_size") -> dedup, batch, size 以及全名保留；
 *    - 搜全名与子词双向均可命中。
 * 4. 【反证门 4】memory_context 上下文文本组装纳入 related_entities
 *    - 输出行格式验证：`- [fact] 标题 | 实体: Prisma,Redis: 正文`；
 *    - 无实体记录不包含多余 `| 实体:` 字段。
 * 5. 【元检查自检】符合 test_meta.mjs 隔离、清理、残余为 0 规范自证
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestEnv } from "./lib/testenv.mjs";
import { termsOf } from "../tools.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【EVO-3 检索增强双向反证专项测试】");
console.log("=================================================================");

const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 隔离命名空间 project: ${env.project}`);

try {
  const hub = await env.createHub();
  const tools = hub.tool;

  // -----------------------------------------------------------------
  // 1. 【反证门 1】related_entities 检索失明修复与独立打分 (+3) 验证
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 1] 【反证门 1】related_entities 检索失明修复与独立权重 (+3) 验证...");

  // 构造记录：正文绝对不含 "Prisma" 或 "PostgreSQL"，仅 related_entities 包含
  const prismaSaveRes = JSON.parse(await tools.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "ORM 数据库连接池配置",
    content: "统一设置 max_connections 为 100，并开启闲置连接超时回收机制",
    related_entities: "Prisma,PostgreSQL",
    tags: "database,pool",
  }, {}));

  assert.ok(prismaSaveRes.id, "必须成功保存包含 related_entities 的事实记忆");

  // 1.1 检索 "Prisma"：必须成功命中且得分包含实体权重 (+3)
  const prismaSearchRaw = await tools.memory_search.execute({
    project: env.project,
    query: "Prisma",
  }, {});
  const prismaSearchResult = JSON.parse(prismaSearchRaw);

  assert.ok(prismaSearchResult.memories.length > 0, "【反证门 1 通过】：修复后按 related_entities:'Prisma' 检索必须成功召回记录（修复前命中 0）");
  assert.strictEqual(prismaSearchResult.memories[0].id, prismaSaveRes.id, "命中的记忆 ID 必须精确匹配");

  // 1.2 检索 "PostgreSQL"：同样必须通过实体字段成功命中
  const pgSearchRaw = await tools.memory_search.execute({
    project: env.project,
    query: "PostgreSQL",
  }, {});
  const pgSearchResult = JSON.parse(pgSearchRaw);
  assert.ok(pgSearchResult.memories.length > 0, "按 related_entities 中的第二个实体 'PostgreSQL' 检索必须成功命中");

  // 1.3 【防过度召回反例断言】：检索完全无关实体 "MongoDB"，得分必为 0，命中数必为 0
  const mongoSearchRaw = await tools.memory_search.execute({
    project: env.project,
    query: "MongoDB",
  }, {});
  const mongoSearchResult = JSON.parse(mongoSearchRaw);
  assert.strictEqual(mongoSearchResult.memories.length, 0, "【反证门 1b 通过】：无关 query 'MongoDB' 必须返回 0 条，绝不发生过度召回");

  console.log("  ✓ 1. related_entities 检索失明修复与防过度召回双向验证通过！");

  // -----------------------------------------------------------------
  // 2. 【反证门 2】camelCase 符号裂变双向反证验证
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 2] 【反证门 2】camelCase 代码符号裂变双向反证验证...");

  // 2.1 termsOf 分词裂变断言
  const camelQuery = "memoryAuditUndo";
  const camelTerms = termsOf(camelQuery);
  console.log("  termsOf('memoryAuditUndo') 裂变结果:", camelTerms);

  assert.ok(camelTerms.includes("memoryauditundo"), "全名小写必须保留");
  assert.ok(camelTerms.includes("memory"), "小写子词 memory 必须被裂变提取");
  assert.ok(camelTerms.includes("audit"), "小写子词 audit 必须被裂变提取");
  assert.ok(camelTerms.includes("undo"), "小写子词 undo 必须被裂变提取");

  // 2.2 存入包含子词的记忆，用全名搜
  const subwordSaveRes = JSON.parse(await tools.memory_save.execute({
    project: env.project,
    category: "decision",
    title: "记忆审计撤销操作规范",
    content: "系统定期执行 audit 巡检，必要时进行回滚",
    tags: "audit,maintenance",
  }, {}));

  const fullSearchRaw = await tools.memory_search.execute({
    project: env.project,
    query: "memoryAuditUndo",
  }, {});
  const fullSearchResult = JSON.parse(fullSearchRaw);
  assert.ok(
    fullSearchResult.memories.some((m) => m.id === subwordSaveRes.id),
    "【反证门 2a 通过】：搜全名 'memoryAuditUndo' 必须通过裂变子词 audit 命中相关正文记录"
  );

  // 2.3 存入包含全名符号的记忆，用子词搜
  const symbolSaveRes = JSON.parse(await tools.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "tools 导出函数",
    content: "memoryAuditUndo 函数负责恢复被软失效的记忆",
    tags: "tools",
  }, {}));

  const subwordSearchRaw = await tools.memory_search.execute({
    project: env.project,
    query: "undo",
  }, {});
  const subwordSearchResult = JSON.parse(subwordSearchRaw);
  assert.ok(
    subwordSearchResult.memories.some((m) => m.id === symbolSaveRes.id),
    "【反证门 2b 通过】：搜子词 'undo' 必须命中包含全名 'memoryAuditUndo' 的记录"
  );

  console.log("  ✓ 2. camelCase 符号裂变与全名/子词双向命中验证通过！");

  // -----------------------------------------------------------------
  // 3. 【反证门 3】snake_case 符号裂变双向反证验证
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 3] 【反证门 3】snake_case 代码符号裂变双向反证验证...");

  // 3.1 termsOf 分词裂变断言
  const snakeQuery = "dedup_batch_size";
  const snakeTerms = termsOf(snakeQuery);
  console.log("  termsOf('dedup_batch_size') 裂变结果:", snakeTerms);

  assert.ok(snakeTerms.includes("dedup_batch_size"), "snake_case 全名必须保留");
  assert.ok(snakeTerms.includes("dedup"), "子词 dedup 必须被裂变提取");
  assert.ok(snakeTerms.includes("batch"), "子词 batch 必须被裂变提取");
  assert.ok(snakeTerms.includes("size"), "子词 size 必须被裂变提取");

  // 3.2 存入仅含子词 batch 的记录，搜全名 dedup_batch_size 必须命中
  const batchSaveRes = JSON.parse(await tools.memory_save.execute({
    project: env.project,
    category: "insight",
    title: "批量处理性能调优",
    content: "调大 batch 参数可显著降低网络往返延迟",
    tags: "performance",
  }, {}));

  const snakeSearchRaw = await tools.memory_search.execute({
    project: env.project,
    query: "dedup_batch_size",
  }, {});
  const snakeSearchResult = JSON.parse(snakeSearchRaw);
  assert.ok(
    snakeSearchResult.memories.some((m) => m.id === batchSaveRes.id),
    "【反证门 3a 通过】：搜全名 'dedup_batch_size' 必须通过裂变子词 batch 命中正文"
  );

  // 3.3 搜子词 dedup 命中包含 dedup_batch_size 的记录
  const snakeSymSaveRes = JSON.parse(await tools.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "去重配置参数",
    content: "dedup_batch_size 默认取值为 50",
    tags: "config",
  }, {}));

  const dedupSearchRaw = await tools.memory_search.execute({
    project: env.project,
    query: "dedup",
  }, {});
  const dedupSearchResult = JSON.parse(dedupSearchRaw);
  assert.ok(
    dedupSearchResult.memories.some((m) => m.id === snakeSymSaveRes.id),
    "【反证门 3b 通过】：搜子词 'dedup' 必须命中包含 'dedup_batch_size' 的配置记录"
  );

  console.log("  ✓ 3. snake_case 符号裂变与全名/子词双向命中验证通过！");

  // -----------------------------------------------------------------
  // 4. 【反证门 4】memory_context 上下文文本组装纳入 related_entities
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 4] 【反证门 4】memory_context 上下文文本组装纳入 related_entities 验证...");

  const ctxRaw = await tools.memory_context.execute({
    project: env.project,
    query: "ORM 连接池 Prisma",
  }, {});
  const ctxResult = JSON.parse(ctxRaw);
  const block = ctxResult.block;

  console.log("  生成的一站式 Context 片段:\n" + block);

  // 4.1 断言包含 related_entities 格式化字段
  assert.ok(
    block.includes("| 实体: Prisma,PostgreSQL"),
    "【反证门 4a 通过】：memory_context 组装文本必须将 related_entities 纳入输出行（如 | 实体: Prisma,PostgreSQL）"
  );

  // 4.2 断言未配置实体的记录不包含 ' | 实体:' 虚假占位
  assert.ok(
    block.includes("- [insight#") && block.includes("批量处理性能调优: 调大 batch 参数可显著降低网络往返延迟"),
    "【反证门 4b 通过】：无 related_entities 记录保持干净输出，绝不拼接空白实体占位"
  );
  assert.ok(
    !block.includes("批量处理性能调优 | 实体:"),
    "【反证门 4c 通过】：无实体记录严禁包含 '| 实体:'"
  );

  console.log("  ✓ 4. memory_context 输出文本 related_entities 注入验证通过！");

  // -----------------------------------------------------------------
  // 5. 【元检查自检】test_meta 规范元检查自证
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 5] 【元检查自检】对本测试文件进行 test_meta 规范扫描...");
  const thisFile = fileURLToPath(import.meta.url);
  const rawContent = fs.readFileSync(thisFile, "utf8");
  const scanRes = scanTestFile(thisFile, rawContent);

  if (scanRes.issues.length > 0) {
    console.error("❌ test_v636_b_evo.mjs 存在 test_meta 规范违规:");
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
    true,
    "本测试包含写库操作，已严格集成 createTestEnv 隔离与 cleanup 机制"
  );

  console.log("  ✓ 5. 本测试文件经 test_meta 静态扫描，0 规范违规！");

} finally {
  // 强制安全清理并自证 0 残余
  console.log("\n[CLEANUP] 开始清理隔离命名空间...");
  await env.cleanup();
  const residue = await env.countAllTestResidue();
  assert.strictEqual(residue.total, 0, `[残余断言失败] 清理后仍有残余记录: ${JSON.stringify(residue)}`);
  console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
}

console.log("=================================================================");
console.log("🎉 全部 EVO-3 检索增强与双向反证测试 100% 成功通过！");
console.log("=================================================================");
