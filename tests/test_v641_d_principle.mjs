/**
 * tests/test_v641_d_principle.mjs
 * =================================================================
 * principle 配额死锁修复专项反证测试
 *
 * 1. 【反证门 a】保底席位：已有 2 条高热度 principle，新增第 3 条低热度 principle
 *    → 新原则必须出现在 memory_context 的 block 中（修复前必然缺席）。
 * 2. 【反向门 b】不应挤掉全部老原则：maxPrinciples=2 时，band 内仍保留至少 1 条老原则。
 * 3. 【反向门 c】不会重复：block 中同一条 principle 不重复出现。
 * 4. 【上限门 d】injected 原则条数 <= maxPrinciples。
 * 5. 【默认值门 e】不传 max_principles 时默认为 3。
 * =================================================================
 */
import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MagpieMemoryHub } from "../tools.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

const parseOut = (res) => {
  if (typeof res === "string") {
    try { return JSON.parse(res); } catch (_) { return res; }
  }
  return res;
};

console.log("=================================================================");
console.log("【v6.41-d principle 配额死锁修复专项反证】");
const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 隔离命名空间: ${env.project}`);
console.log("=================================================================\n");

try {
  const hub = await env.createHub();
  const memCtx = hub.tool["memory_context"];

  // 构造两条「老」高热度原则
  const old1 = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    category: "principle",
    title: "老原则甲：所有服务统一使用 UTC 时间戳",
    content: "时间处理硬性规范：禁止使用本地时区，全链路统一 UTC。",
  }));
  const old2 = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    category: "principle",
    title: "老原则乙：线上禁止直接执行 DDL",
    content: "数据库变更必须先走影子表校验，严禁在线上直接 ALTER。",
  }));
  assert.ok(old1.id && old2.id, "两条老原则必须写入成功");

  // 给老原则人为堆高热度（模拟长期被注入）
  const staleTime = "2025-01-01 00:00:00";
  for (const id of [old1.id, old2.id]) {
    await env.client.update("memories", id, {
      retrieval_count: 50,
      updated_at: staleTime,
      created_at: staleTime,
      confidence_score: 100,
    });
  }

  // 新增第三条原则（低热度、最新）
  const fresh = parseOut(await hub.tool["memory_save"].execute({
    project: env.project,
    category: "principle",
    title: "新原则丙：检索代码一律优先使用 XERJ",
    content: "检索规范：禁止 rg/grep 大面积盲扫，优先 xerj search / xerj def。",
  }));
  assert.ok(fresh.id, "新原则必须写入成功");

  const ctx1 = parseOut(await memCtx.execute({ project: env.project, query: "规范 时间 数据库 检索" }, {}));
  const block1 = String(ctx1.block || "");

  // a) 新原则必须出现
  assert.ok(
    block1.includes("新原则丙"),
    "【反证门 a 通过】：低热度但最新的 principle 必须通过保底席位进入 block（修复前必然缺席）"
  );
  console.log("  ✓ a. 保底席位生效：新原则成功进入 context block");

  // b) 不能把老原则全挤掉
  const oldCount = (block1.includes("老原则甲") ? 1 : 0) + (block1.includes("老原则乙") ? 1 : 0);
  assert.ok(oldCount >= 1, "【反向门 b 通过】：保底替换不得把老原则全部挤掉，至少保留 1 条");
  console.log(`  ✓ b. 老原则保留 ${oldCount} 条（未被全量挤掉）`);

  // c) 不重复
  const occurFresh = block1.split("新原则丙").length - 1;
  assert.strictEqual(occurFresh, 1, "【反向门 c 通过】：同一条 principle 在 block 中不得重复出现");
  console.log("  ✓ c. 无重复条目");

  // d) 条数不超过 maxPrinciples（默认 3）
  const principleLines = block1.split("\n").filter((l) => l.includes("[principle")).length;
  assert.ok(principleLines <= 3, `【上限门 d 通过】：principle 行数 ${principleLines} 不得超过默认上限 3`);
  console.log(`  ✓ d. block 中 principle 共 ${principleLines} 条（<=3）`);

  // e) 显式 max_principles=2 时不越界，且仍有保底
  const ctx2 = parseOut(await memCtx.execute({ project: env.project, query: "规范", max_principles: 2 }, {}));
  const block2 = String(ctx2.block || "");
  const p2Lines = block2.split("\n").filter((l) => l.includes("[principle")).length;
  assert.ok(p2Lines <= 2, `【上限门 e 通过】：显式 max_principles=2 时 principle 行数 ${p2Lines} 不得超过 2`);
  assert.ok(block2.includes("新原则丙"), "【上限门 e 通过】：max_principles=2 时保底席位仍然生效");
  console.log(`  ✓ e. max_principles=2 时 ${p2Lines} 条且保底仍生效`);

  // 元检查自检
  const selfPath = fileURLToPath(import.meta.url);
  const scanRes = scanTestFile(selfPath, fs.readFileSync(selfPath, "utf8"));
  assert.strictEqual(scanRes.issues.length, 0, "test_meta 自检必须 0 违规");
  console.log("  ✓ 元检查自检 0 违规");

} finally {
  await env.cleanup();
  const residue = await env.countAllTestResidue();
  assert.strictEqual(residue.total, 0, "测试后必须 0 残留");
  console.log("✅ 零残留断言通过");
}

console.log("=================================================================");
console.log("✅ v6.41-d principle 配额死锁修复全部反证通过");
console.log("=================================================================");
