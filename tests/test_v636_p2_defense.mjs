/**
 * tests/test_v636_p2_defense.mjs
 * =================================================================
 * v6.36 P2 防御性微调专项反证套件
 *
 * 覆盖 2 项：
 *  1. 【P2-1】模型幻觉捏造不存在的 primary_id / duplicate_ids 时：
 *      - 该组必须被整体忽略（不得计入 modelHandledIds）
 *      - 同 ID 的真实确定性规则组必须仍能正常合并（不被误判为已处理而拆毁）
 *  2. 【P2-2】maxModelBatches 必须能由 args.audit_max_batches 覆盖
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
const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []);

console.log("=================================================================");
console.log("【v6.36 P2 防御性微调验收套件】");
const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

const clearAll = async () => {
  for (const t of ["memories", "pitfalls"]) {
    const rows = rowsOf(await env.client.list(t, { project: env.project, limit: 1000 }));
    for (const r of rows) {
      try { await env.client.remove(t, r.id); } catch (_) { /* 单条失败不影响后续 */ }
    }
  }
};

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function run() {
  try {
    // =================================================================
    // 【反证门 1】模型捏造不存在的 primary_id：真实规则组不得被拆毁
    // =================================================================
    console.log("▶ [反证门 1] 模型捏造不存在的 primary_id 时，真实规则组必须完好...");
    await clearAll();

    // 造一对真实精确重复（同指纹）
    const r1 = await env.client.create("memories", {
      project: env.project, category: "fact",
      title: "P2反证：Nginx 上游超时治理",
      content: "调整 proxy_read_timeout 至 60s",
      content_fingerprint: "fp_p2_defense_nginx",
      lifecycle_status: "active", recurrence: 3, tags: "nginx,timeout",
      created_at: now(), updated_at: now(),
    });
    const r2 = await env.client.create("memories", {
      project: env.project, category: "fact",
      title: "P2反证：Nginx 上游超时治理",
      content: "调整 proxy_read_timeout 至 60s",
      content_fingerprint: "fp_p2_defense_nginx",
      lifecycle_status: "active", recurrence: 1, tags: "nginx,timeout",
      created_at: now(), updated_at: now(),
    });
    const r1Id = Number(r1.id || r1.insertId);
    const r2Id = Number(r2.id || r2.insertId);

    // 模型完全捏造：primary_id=999999（不存在），duplicate_ids=[888888]
    const fakeFetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          memory_duplicates: [{ primary_id: 999999, duplicate_ids: [888888, r2Id] }],
          pitfall_duplicates: [],
        }) } }],
      }),
    });

    const hub = await MagpieMemoryHub(
      { audit_model: "test-p2-hallucination", _fetch: fakeFetch },
      { client: env.client, ncb_instance: env.instance }
    );
    const res = parseOut(await hub.tool["memory_audit"].execute({ project: env.project, full: true }));
    assert.strictEqual(res.action, "DEDUP_REPORT", "审计必须正常完成");

    const after = rowsOf(await env.client.list("memories", { project: env.project, limit: 100 }));
    const row1 = after.find((r) => Number(r.id) === r1Id);
    const row2 = after.find((r) => Number(r.id) === r2Id);

    assert.ok(row1 && row1.invalid_at == null, "主记录 r1 必须保持 active");
    assert.ok(
      row2 && row2.invalid_at != null && String(row2.invalid_reason || "").includes(`into:${r1Id}`),
      "【反证门 1 通过】：模型捏造 999999 后，真实规则组 (r1<-r2) 必须仍被正常合并软失效！"
    );
    console.log("  ✓ 反证门 1 通过：幻觉组被忽略，真实规则组完好合并\n");

    // =================================================================
    // 【反证门 2】P2-2 maxModelBatches 可由 args.audit_max_batches 覆盖
    // =================================================================
    console.log("▶ [反证门 2] args.audit_max_batches 必须覆盖 cfg 配置...");
    await clearAll();
    for (let i = 1; i <= 30; i++) {
      await env.client.create("memories", {
        project: env.project, category: "fact",
        title: `P2分块条目 ${i}`, content: `正文 ${i}，用于触发模型分块预算`,
        lifecycle_status: "active", recurrence: 1, tags: `p2,item${i}`,
        created_at: now(), updated_at: now(),
      });
    }

    let modelCallCount = 0;
    const probeFetch = async () => {
      modelCallCount++;
      return { ok: true, status: 200, json: async () => ({
        choices: [{ message: { content: JSON.stringify({ memory_duplicates: [], pitfall_duplicates: [] }) } }],
      }) };
    };

    // cfg 里配 2 批，但 args 里传 1 批 -> 必须听 args 的，只调用 1 次
    const hub2 = await MagpieMemoryHub(
      { audit_model: "test-p2-budget", audit_chunk_size: 20, audit_max_batches: 2, _fetch: probeFetch },
      { client: env.client, ncb_instance: env.instance }
    );
    await hub2.tool["memory_audit"].execute({
      project: env.project, full: true, audit_max_batches: 1,
    });
    assert.strictEqual(
      modelCallCount, 1,
      `【反证门 2 通过】：args.audit_max_batches=1 必须生效，实际模型调用 ${modelCallCount} 次（应为 1）`
    );
    console.log(`  ✓ 反证门 2 通过：args.audit_max_batches 覆盖生效（模型调用 ${modelCallCount} 次）\n`);

    // =================================================================
    // 自检
    // =================================================================
    console.log("▶ [自检] test_meta 规范合规性...");
    const selfPath = fileURLToPath(import.meta.url);
    const scanRes = scanTestFile(selfPath, fs.readFileSync(selfPath, "utf8"));
    if (scanRes.issues.length > 0) {
      for (const is of scanRes.issues) console.error("   -", is);
    }
    assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 0 规范违规");
    console.log("  ✓ test_meta 自检 0 违规\n");

  } finally {
    console.log("[CLEANUP] 清理隔离命名空间...");
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "残余必须为 0");
    console.log("✅ 零残留断言通过\n");
  }
}

await run();
console.log("=================================================================");
console.log("✅ v6.36 P2 全部反证门 100% 通过！");
console.log("=================================================================");
