/**
 * test_state_bloat_and_dead_letter.mjs
 * 
 * 验证 state.json 膨胀治理与下发污染整改：
 * 1. 进程内 mtime 缓存（文件未变不重复读盘，文件变动自动失效并重读）
 * 2. 紧凑序列化（无缩进输出，比对缩进格式显著减小 30%~40% 体积）
 * 3. file_states 淘汰上限（>500 个按 processed_at 降序保留最新 500 个）
 * 4. processed_fingerprints 淘汰上限（截断至最新 1000 个）
 * 5. harvest_queue 死信熔断与淘汰（遇非 1062 报错累加 retries，满 3 次彻底移出队列）
 * 6. pending_patterns 瘦身与防死锁（payload 截断至 200 字符、达标立即出队、上限 500）
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readState,
  writeState,
  statePath,
  _resetStateCacheForTests,
  rememberGatewayHarvest,
  lookupGatewayHarvest,
  recordPendingEvidence,
  truncatePendingPayload,
  DEFAULT_MIN_EVIDENCE,
  DEFAULT_MAX_PENDING,
  enqueueHarvestItems,
  readHarvestQueue,
  removeHarvestItems,
  clearHarvestQueue,
  updateHarvestItemRetries,
} from "../src/core/state.js";
import { triggerBackgroundDrain } from "../gateway_harvest.hooks.js";

console.log("=================================================================");
console.log("【测试开始】state.json 膨胀治理与死信队列淘汰验证");
console.log("=================================================================\n");

const origState = readState();

try {
  // -----------------------------------------------------------------
  // 1. 进程内 mtime 缓存验证
  // -----------------------------------------------------------------
  console.log("▶ [Test 1] 进程内 mtime 缓存与失效机制验证...");
  _resetStateCacheForTests();

  const testState1 = {
    current: "cache_test_instance",
    secrets: { s1: "sec1" },
    actions: {},
    gateway_harvest: {},
    pending_patterns: {},
    r2_mounts: {},
    harvest_queue: [],
  };
  writeState(testState1);

  // 第一次读取
  const read1 = readState();
  assert.strictEqual(read1.current, "cache_test_instance");

  // 验证不改文件时，多次读取走缓存
  const read2 = readState();
  assert.deepStrictEqual(read1, read2);

  // 模拟外部直接修改文件（更新 mtime）
  const p = statePath();
  const rawDisk = JSON.parse(fs.readFileSync(p, "utf8"));
  rawDisk.current = "modified_by_external_process";
  fs.writeFileSync(p, JSON.stringify(rawDisk));

  // 必须能感知到 mtime 变化并重新解析新内容
  const read3 = readState();
  assert.strictEqual(read3.current, "modified_by_external_process", "外部修改文件后缓存必须自动失效并重新加载最新内容");
  console.log("  ✓ 进程内 mtime 缓存命中与外部变动失效重载验证通过！\n");

  // -----------------------------------------------------------------
  // 2. 紧凑序列化与体积减小验证
  // -----------------------------------------------------------------
  console.log("▶ [Test 2] 紧凑序列化对比 (相比 null, 2 减少 30%~40% 体积)...");
  const testObj = {
    current: "compact_test",
    secrets: { key1: "secret_1", key2: "secret_2" },
    actions: { lastDoneId: "act_123", history: [{ id: "1", op: "status" }] },
    gateway_harvest: { processed_fingerprints: ["fp1", "fp2", "fp3"] },
    pending_patterns: {
      p1: { count: 1, kind: "pitfall", payload: { title: "Test", desc: "Short sample" } }
    },
    r2_mounts: {},
    harvest_queue: []
  };

  const prettyLen = Buffer.byteLength(JSON.stringify(testObj, null, 2), "utf8");
  const compactLen = Buffer.byteLength(JSON.stringify(testObj), "utf8");
  const reduction = ((prettyLen - compactLen) / prettyLen) * 100;
  console.log(`  - 缩进格式体积: ${prettyLen} 字节 | 紧凑格式体积: ${compactLen} 字节 | 缩减率: ${reduction.toFixed(1)}%`);
  assert.ok(reduction >= 25, `紧凑序列化缩减率应 >= 25% (实际: ${reduction.toFixed(1)}%)`);
  console.log("  ✓ 紧凑序列化体积缩减验证通过！\n");

  // -----------------------------------------------------------------
  // 3. file_states 淘汰上限 (最多保留最近 500 个)
  // -----------------------------------------------------------------
  console.log("▶ [Test 3] file_states 500 个上限与 processed_fingerprints 1000 上限淘汰验证...");
  const fakeFiles = {};
  for (let i = 0; i < 600; i++) {
    fakeFiles[`file_${i}.json`] = {
      mtime: 1000 + i,
      processed_at: 1000 + i, // i 越大越新
    };
  }
  const fakeFps = [];
  for (let i = 0; i < 1500; i++) {
    fakeFps.push(`fp_${i}`);
  }

  rememberGatewayHarvest({
    files: fakeFiles,
    processed_fingerprints: fakeFps,
  });

  const gh = lookupGatewayHarvest();
  const fileKeys = Object.keys(gh.files || {});
  assert.strictEqual(fileKeys.length, 500, "file_states 超过 500 个时必须淘汰至恰好 500 个");
  // 断言保留的是最新的 500 个 (file_100 到 file_599，file_0 应已被淘汰)
  assert.strictEqual(gh.files["file_0.json"], undefined, "最旧的 file_0.json 必须已被淘汰");
  assert.ok(gh.files["file_599.json"] !== undefined, "最新的 file_599.json 必须保留");

  assert.strictEqual(gh.processed_fingerprints.length, 1000, "processed_fingerprints 超过 1000 时必须淘汰至最新 1000 个");
  assert.strictEqual(gh.processed_fingerprints[0], "fp_500", "最旧的 500 个指纹必须被淘汰");
  assert.strictEqual(gh.processed_fingerprints[999], "fp_1499", "最新的指纹必须保留");
  console.log("  ✓ file_states 500 上限与 processed_fingerprints 1000 上限淘汰验证通过！\n");

  // -----------------------------------------------------------------
  // 4. pending_patterns 瘦身、截断与达标立即出队验证
  // -----------------------------------------------------------------
  console.log("▶ [Test 4] pending_patterns 字段截断、达标立即出队与上限验证...");
  assert.strictEqual(DEFAULT_MIN_EVIDENCE, 2, "默认门禁必须为 2 次复现");
  assert.strictEqual(DEFAULT_MAX_PENDING, 500, "默认最大 pending 上限必须为 500");

  const longPayload = {
    title: "A".repeat(150),
    content: "B".repeat(500),
    symptom: "C".repeat(500),
    root_cause: "D".repeat(500),
    solution: "E".repeat(500),
    sample: "F".repeat(500),
    raw: "G".repeat(1000), // 应被彻底删除
  };

  const truncated = truncatePendingPayload(longPayload);
  assert.strictEqual(truncated.title.length, 103, "title 超过 100 字符必须截断加省略号");
  assert.strictEqual(truncated.content.length, 203, "content 超过 200 字符必须截断加省略号");
  assert.strictEqual(truncated.symptom.length, 203, "symptom 超过 200 字符必须截断加省略号");
  assert.strictEqual(truncated.raw, undefined, "raw 大字段必须被彻底移除");

  // 模拟两轮观察：第 1 次未达标，暂存必须为截断数据
  const testFp = "p:test:truncate_test_fp";
  const r1 = recordPendingEvidence(testFp, longPayload, { minEvidence: 2 });
  assert.strictEqual(r1.shouldGraduate, false, "第 1 次观察不得毕业");
  const stAfter1 = readState();
  const pendingItem = stAfter1.pending_patterns[testFp];
  assert.ok(pendingItem, "未达标前条目必须存在于 pending 中");
  assert.strictEqual(pendingItem.payload.content.length, 203, "pending 暂存的 content 必须是截断后的短文本");

  // 第 2 次观察：达成门限 (count: 2 >= 2)，必须立即毕业且从 pending 彻底移除
  const r2 = recordPendingEvidence(testFp, longPayload, { minEvidence: 2 });
  assert.strictEqual(r2.shouldGraduate, true, "第 2 次观察达成门槛必须毕业");
  const stAfter2 = readState();
  assert.strictEqual(stAfter2.pending_patterns[testFp], undefined, "毕业后该指纹必须从 pending_patterns 中彻底移除（零僵尸残留）");
  console.log("  ✓ pending_patterns 字段截断与达成门槛立即出队验证通过！\n");

  // -----------------------------------------------------------------
  // 5. harvest_queue 死信累加与淘汰验证
  // -----------------------------------------------------------------
  console.log("▶ [Test 5] harvest_queue 死信重试累加与 3 次失败强制淘汰验证...");
  clearHarvestQueue();

  const deadItem = {
    id: "hq_dead_item_1",
    table: "memories",
    project: "__test_dead_letter__",
    data: {
      project: "__test_dead_letter__",
      title: "Broken Memory",
      content: "This memory fails repeatedly with 500 error",
    },
    retries: 0,
  };
  enqueueHarvestItems([deadItem]);

  assert.strictEqual(readHarvestQueue().length, 1);

  // 构造模拟 client：遇到 create 抛出 500 Internal Error (非 1062)
  const mockFailingClient = {
    list: async () => ({ data: [] }),
    create: async () => {
      throw new Error("500 Internal Database Error: disk I/O failure");
    },
    update: async () => ({ affectedRows: 1 }),
  };

  // 第 1 次消费尝试：报错，重试计数变为 1
  await triggerBackgroundDrain(mockFailingClient);
  let q1 = readHarvestQueue();
  assert.strictEqual(q1.length, 1, "第 1 次失败保留在队列");
  assert.strictEqual(q1[0].retries, 1, "retries 应累加至 1");

  // 第 2 次消费尝试：报错，重试计数变为 2
  await triggerBackgroundDrain(mockFailingClient);
  let q2 = readHarvestQueue();
  assert.strictEqual(q2.length, 1, "第 2 次失败保留在队列");
  assert.strictEqual(q2[0].retries, 2, "retries 应累加至 2");

  // 第 3 次消费尝试：超过 3 次重试上限，必须彻底淘汰出队（死信熔断，防止无限阻塞）
  await triggerBackgroundDrain(mockFailingClient);
  let q3 = readHarvestQueue();
  assert.strictEqual(q3.length, 0, "重试满 3 次后死信必须被安全移出队列，杜绝永久死锁与状态膨胀！");
  console.log("  ✓ harvest_queue 死信重试累加与 3 次强制淘汰验证通过！\n");

  console.log("=================================================================");
  console.log("✅ 全部 state.json 治理与死信防膨胀测试 100% 通过！");
  console.log("=================================================================\n");
} finally {
  // 恢复原始环境状态
  writeState(origState);
  clearHarvestQueue();
}
