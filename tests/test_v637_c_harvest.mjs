/**
 * tests/test_v637_c_harvest.mjs
 * =================================================================
 * v6.37-c 提炼链路同步（BUG-5）与中间件符号感知/复发加权（EVO-8）验收套件
 *
 * 1. 【BUG-5】自动提炼链路同步 v6.36 新能力
 *    - HARVEST_SYSTEM_PROMPT 必须支持 principle 分类
 *    - HARVEST_SYSTEM_PROMPT 必须要求 related_entities 输出
 *    - HARVEST_SYSTEM_PROMPT 必须要求 pitfall 分别给出 root_cause 与 solution
 *    - 源码中不得再有 `related_entities: ""` 硬编码覆盖模型输出
 * 2. 【EVO-8】中间件符号裂变与复发加权
 *    - camelCase 裂变：memoryAuditUndo 的子词 audit 可命中
 *    - snake_case 裂变：dedup_batch_size 的子词 batch 可命中
 *    - 不得拆坏普通词：redis 仍能正常命中含 redis 的记录
 *    - 复发加权：相同 retrieval_count 下 recurrence 高者排序更靠前
 * 3. 【元检查自检】scanTestFile 0 违规
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { HARVEST_SYSTEM_PROMPT } from "../gateway_harvest.hooks.js";
import { onRequest } from "../memory.middleware.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【v6.37-c 提炼链路同步与中间件符号感知验收套件】");
console.log("=================================================================\n");

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { console.error("  ✗ " + msg); failures++; }
}

// -----------------------------------------------------------------
// 1. 【BUG-5】提炼提示词契约
// -----------------------------------------------------------------
console.log("▶ [反证门 1] BUG-5 提炼提示词必须支持 principle / related_entities / root_cause 分离");
{
  check(HARVEST_SYSTEM_PROMPT.includes("principle"), "提示词必须支持 principle 分类");
  check(
    /铁律|架构原则|最高准则/.test(HARVEST_SYSTEM_PROMPT),
    "提示词必须说明 principle 的语义（长期铁律/架构原则）"
  );
  check(HARVEST_SYSTEM_PROMPT.includes("related_entities"), "提示词必须要求输出 related_entities");
  check(HARVEST_SYSTEM_PROMPT.includes("root_cause"), "提示词必须要求输出 root_cause");
  check(
    /root_cause[\s\S]{0,200}solution|solution[\s\S]{0,200}root_cause/.test(HARVEST_SYSTEM_PROMPT),
    "root_cause 与 solution 必须作为两个独立字段被要求"
  );

  // 反证：硬编码空串覆盖模型输出的写法必须已移除
  const hooksSrc = fs.readFileSync(new URL("../gateway_harvest.hooks.js", import.meta.url), "utf8");
  const hardcodedEmpty = /related_entities:\s*""/.test(hooksSrc);
  check(!hardcodedEmpty, "【反证】源码中不得残留 `related_entities: \"\"` 硬编码（会覆盖模型输出）");
}

// -----------------------------------------------------------------
// 2. 【EVO-8】中间件符号裂变（camelCase / snake_case）
// -----------------------------------------------------------------
console.log("\n▶ [反证门 2] EVO-8 中间件必须能裂变 camelCase / snake_case 子词");

function buildCtx(memories, project) {
  return {
    state: {},
    options: {
      project,
      memories,
      memories_version: "v-" + Date.now(),
      inline_extract: true,
      inject_principles: true,
      search_rewrite: false,
      search_rerank: false,
    },
  };
}
function runMiddleware(query, memories) {
  const body = { model: "gpt-4o", messages: [{ role: "user", content: query }] };
  onRequest(body, buildCtx(memories, "proj_evo8"));
  return String(body.messages[0].content || "");
}

const camelMem = {
  id: 9001, project: "proj_evo8", category: "fact",
  title: "memoryAuditUndo 回滚实现说明", content: "该能力负责撤销最近一次去重批次",
  tags: "undo", related_entities: "", recurrence: 1, retrieval_count: 0,
  lifecycle_status: "active",
};
const snakeMem = {
  id: 9002, project: "proj_evo8", category: "decision",
  title: "dedup_batch_size 去重批大小设定", content: "控制单次拉取条数",
  tags: "dedup", related_entities: "", recurrence: 1, retrieval_count: 0,
  lifecycle_status: "active",
};
const plainMem = {
  id: 9003, project: "proj_evo8", category: "fact",
  title: "缓存层选型", content: "会话缓存统一使用 redis 并开启 AOF 持久化",
  tags: "redis", related_entities: "Redis", recurrence: 1, retrieval_count: 0,
  lifecycle_status: "active",
};

{
  // 2.1 camelCase 子词命中
  const block = runMiddleware("需要 audit 相关能力", [camelMem]);
  check(block.includes("memoryAuditUndo") || block.includes("回滚实现说明"),
    "camelCase 全名记录的「子词 audit」查询必须命中");

  // 2.2 snake_case 子词命中
  const block2 = runMiddleware("batch 如何配置", [snakeMem]);
  check(block2.includes("dedup_batch_size") || block2.includes("去重批大小设定"),
    "snake_case 全名记录的「子词 batch」查询必须命中");

  // 2.3 反证：不得把普通单词拆坏
  const block3 = runMiddleware("redis 缓存", [plainMem]);
  check(block3.includes("redis") || block3.includes("缓存层选型"),
    "【反证】普通单词 redis 绝不能被裂变逻辑破坏，必须仍能正常命中");

  // 2.4 反证：完全无关查询不得误召回
  const block4 = runMiddleware("kubernetes 水平扩缩容", [camelMem, snakeMem, plainMem]);
  check(!block4.includes("memoryAuditUndo") && !block4.includes("dedup_batch_size"),
    "【反证】无关查询绝不得因裂变产生误召回");
}

// -----------------------------------------------------------------
// 3. 【EVO-8】复发加权 _heat
// -----------------------------------------------------------------
console.log("\n▶ [反证门 3] EVO-8 复发加权：相同 retrieval_count 下 recurrence 高者优先");
{
  const lowRec = {
    id: 9101, project: "proj_evo8b", category: "preference",
    title: "commit 提交信息规范约定", content: "使用约定式提交格式",
    tags: "commit", related_entities: "", recurrence: 1, retrieval_count: 5,
    lifecycle_status: "active",
  };
  const highRec = {
    id: 9102, project: "proj_evo8b", category: "preference",
    title: "commit 提交信息规范要求", content: "必须使用约定式提交格式",
    tags: "commit", related_entities: "", recurrence: 6, retrieval_count: 5,
    lifecycle_status: "active",
  };

  const mk = (mems) => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "commit 规范" }] };
    onRequest(body, buildCtx(mems, "proj_evo8b"));
    return String(body.messages[0].content || "");
  };

  const blockLowFirst = mk([lowRec, highRec]);
  const idxHigh = blockLowFirst.indexOf("commit 提交信息规范要求");
  const idxLow = blockLowFirst.indexOf("commit 提交信息规范约定");
  check(idxHigh !== -1 && (idxLow === -1 || idxHigh < idxLow),
    "recurrence 更高的记录必须排在前面（同为 retrieval_count=5）");

  // 反证：recurrence 缺失/非法时不得抛错且不得为负权重
  const badRec = { ...lowRec, id: 9103, recurrence: null, retrieval_count: 3 };
  let threw = false;
  try { mk([badRec]); } catch (_) { threw = true; }
  check(!threw, "【反证】recurrence 为 null 时绝不得抛错（必须安全降级）");
}

// -----------------------------------------------------------------
// 4. 元检查自检
// -----------------------------------------------------------------
console.log("\n▶ [自检] test_meta 规范合规性");
{
  const selfPath = fileURLToPath(import.meta.url);
  const scanRes = scanTestFile(selfPath, fs.readFileSync(selfPath, "utf8"));
  if (scanRes.issues.length > 0) {
    for (const is of scanRes.issues) console.error("   - " + is);
  }
  assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 0 规范违规");
  console.log("  ✓ test_meta 自检 0 违规");
}

console.log("\n=================================================================");
if (failures > 0) {
  console.error(`❌ 共 ${failures} 项断言失败`);
  process.exit(1);
}
console.log("✅ v6.37-c 全部反证门 100% 通过！");
console.log("=================================================================");
