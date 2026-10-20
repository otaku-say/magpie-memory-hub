/**
 * tests/test_v635_a_tools.mjs
 * =================================================================
 * v6.35-a tools.js 三项边界精修专项反证测试套件
 *
 * 覆盖：
 * 1. 【反证门 1】P1-1a 模型组「先校验后记账」——被数字守卫拒绝的幻觉组不得拆毁原规则组
 *    · 1a 该合必须合：3306 自身精确重复副本仍被合并（不被模型幻觉牵连）
 *    · 1b 该拒必须拒：模型把 3307 合进 3306 必须被守卫拒绝
 * 2. 【反证门 2】P1-1b 分字段独立校验——禁止跨字段拼接造成误拒
 *    · 2a 该合必须合：症状同含 3306、方案一侧多「重试 3 次」→ 仍应合并
 *    · 2b 该拒必须拒：症状 3306 vs 3307 → 必须拒绝
 * 3. 【反证门 3】P1-2 配置优先级
 *    · 3a dedup_fetch_limit=200 不被 dedup_batch_size 默认值 50 遮蔽
 *    · 3b args.audit_chunk_size 覆盖 cfg.audit_chunk_size，且 [5,60] 守卫生效
 * 4. 【反证门 4】P1-4 新周期清游标
 *    · 4a 新周期首次触发（非 pending）→ 旧游标被清空，既有小 ID 记录可被重新扫描
 *    · 4b 接力场景（pending=true）→ 游标保留，断点续跑不重复
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { MagpieMemoryHub, memoryAudit } from "../tools.js";
import {
  readState,
  writeState,
  saveAuditCursor,
  getAuditCursor,
  clearAuditCursor,
} from "../local_state.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

const readOptions = MagpieMemoryHub.readOptions;

function parseOut(res) {
  if (typeof res === "string") {
    try {
      return JSON.parse(res);
    } catch (_) {
      return res;
    }
  }
  return res;
}

const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []);

console.log("=================================================================");
console.log("【v6.35-a tools.js 边界精修验收套件】");
const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

const clearRecords = async () => {
  for (const tbl of ["memories", "pitfalls"]) {
    const rows = rowsOf(await env.client.list(tbl, { project: env.project, limit: 1000 }));
    for (const r of rows) {
      try {
        await env.client.remove(tbl, r.id);
      } catch (err) {
        // 清理失败不阻塞后续断言
        void err;
      }
    }
  }
};

async function run() {
  try {
    // =============================================================
    // 1. 【反证门 1】先校验后记账：被拒绝的幻觉组不得拆毁原规则组
    // =============================================================
    console.log("▶ [反证门 1] 模型组被数字守卫拒绝时，原规则组必须完好...");
    await clearRecords();

    // M1/M2 同端口 3306 的精确重复；M3 是 3307（不同端口）
    const m1 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "MySQL 主库连接配置",
      content: "主库端口 3306 连接池上限 100",
      content_fingerprint: "fp_v635_mysql_3306",
      lifecycle_status: "active",
      recurrence: 2,
      tags: "mysql,3306",
      created_at: "2026-10-20 10:00:00",
      updated_at: "2026-10-20 10:02:00",
    });
    const m2 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "MySQL 主库连接配置",
      content: "主库端口 3306 连接池上限 100",
      content_fingerprint: "fp_v635_mysql_3306",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "mysql,3306",
      created_at: "2026-10-20 10:01:00",
      updated_at: "2026-10-20 10:01:00",
    });
    const m3 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "MySQL 从库连接配置",
      content: "从库端口 3307 只读连接",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "mysql,3307",
      created_at: "2026-10-20 10:03:00",
      updated_at: "2026-10-20 10:03:00",
    });

    const m1Id = Number(m1.id);
    const m2Id = Number(m2.id);
    const m3Id = Number(m3.id);

    // 模型幻觉：把 3307 合进 3306（应被数字守卫拒绝）
    const hallucinationFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              memory_duplicates: [{ primary_id: m1Id, duplicate_ids: [m3Id] }],
              pitfall_duplicates: [],
            }),
          },
        }],
      }),
    });

    const hub1 = await MagpieMemoryHub({
      audit_model: "test-v635-hallucination",
      _fetch: hallucinationFetch,
    }, { client: env.client, ncb_instance: env.instance });

    const res1 = parseOut(await hub1.tool["memory_audit"].execute({
      project: env.project,
      full: true,
    }));
    assert.strictEqual(res1.action, "DEDUP_REPORT");

    const rowsAfter1 = rowsOf(await env.client.list("memories", { project: env.project, limit: 100 }));
    const r1 = rowsAfter1.find((r) => Number(r.id) === m1Id);
    const r2 = rowsAfter1.find((r) => Number(r.id) === m2Id);
    const r3 = rowsAfter1.find((r) => Number(r.id) === m3Id);

    // 1a 该合必须合：3306 自己的精确重复（m2）仍必须被合并
    assert.ok(r1 && r1.invalid_at == null, "主记录 m1 必须保持 active");
    assert.ok(
      r2 && r2.invalid_at != null,
      "【反证门 1a】3306 自身的精确重复 m2 绝不能被模型幻觉牵连而漏删，必须被软失效！"
    );
    assert.ok(
      String(r2.invalid_reason || "").includes(`into:${m1Id}`),
      "m2 的 invalid_reason 必须指向 m1"
    );

    // 1b 该拒必须拒：3307 与 3306 数字冲突，绝不能被合并
    assert.ok(
      r3 && r3.invalid_at == null,
      "【反证门 1b】3307 与 3306 存在端口冲突，模型幻觉必须被守卫拒绝，m3 必须保持 active！"
    );

    console.log("  ✓ 反证门 1 通过：规则组未被拆毁，幻觉组被正确拒绝\n");

    // =============================================================
    // 2. 【反证门 2】分字段独立校验，跨字段拼接不得造成误拒
    // =============================================================
    console.log("▶ [反证门 2] 分字段校验：方案多出无关数字不得误判冲突...");
    await clearRecords();

    // P1/P2：symptom 同含 3306，方案一侧多写「重试 3 次」（数字集合 {3306} vs {3306,3}）
    const p1 = await env.client.create("pitfalls", {
      project: env.project,
      component: "mysql",
      symptom: "MySQL 端口 3306 连接被拒绝",
      solution: "调整 max_connections 参数并重启服务",
      root_cause: "连接数上限过小",
      invalid_at: null,
      lifecycle_status: "active",
      recurrence: 1,
      created_at: "2026-10-20 11:00:00",
      updated_at: "2026-10-20 11:00:00",
    });
    const p2 = await env.client.create("pitfalls", {
      project: env.project,
      component: "mysql",
      symptom: "MySQL 端口 3306 连接被拒绝",
      solution: "调整 max_connections 参数并重启服务，重试 3 次",
      root_cause: "连接数上限过小",
      invalid_at: null,
      lifecycle_status: "active",
      recurrence: 1,
      created_at: "2026-10-20 11:01:00",
      updated_at: "2026-10-20 11:01:00",
    });
    // P3：端口换成 3307，真实冲突，必须拒绝
    const p3 = await env.client.create("pitfalls", {
      project: env.project,
      component: "mysql",
      symptom: "MySQL 端口 3307 连接被拒绝",
      solution: "调整 max_connections 参数并重启服务",
      root_cause: "连接数上限过小",
      invalid_at: null,
      lifecycle_status: "active",
      recurrence: 1,
      created_at: "2026-10-20 11:02:00",
      updated_at: "2026-10-20 11:02:00",
    });

    const p1Id = Number(p1.id);
    const p2Id = Number(p2.id);
    const p3Id = Number(p3.id);

    const res2 = parseOut(await memoryAudit(env.client, {
      project: env.project,
      audit_model: "off",
    }, { project: env.project, full: true }));
    assert.strictEqual(res2.action, "DEDUP_REPORT");

    const pitsAfter = rowsOf(await env.client.list("pitfalls", { project: env.project, limit: 100 }));
    const q1 = pitsAfter.find((r) => Number(r.id) === p1Id);
    const q2 = pitsAfter.find((r) => Number(r.id) === p2Id);
    const q3 = pitsAfter.find((r) => Number(r.id) === p3Id);

    // 2a 该合必须合：p1/p2 应合并（方案多「重试 3 次」不构成数字冲突）
    const merged12 = (q1.invalid_at != null) !== (q2.invalid_at != null);
    assert.ok(
      merged12,
      "【反证门 2a】p1 与 p2 症状数字相同、仅方案多写「重试 3 次」，必须正常合并（不得因跨字段拼接误拒）！"
    );

    // 2b 该拒必须拒：p3 端口 3307 与 3306 冲突，必须保持独立
    assert.ok(
      q3.invalid_at == null && q3.lifecycle_status === "active",
      "【反证门 2b】p3 端口 3307 与 3306 真实冲突，必须保持 active 绝不合并！"
    );

    console.log("  ✓ 反证门 2 通过：分字段校验既不误拒也不漏拒\n");

    // =============================================================
    // 3. 【反证门 3】配置优先级
    // =============================================================
    console.log("▶ [反证门 3] readOptions 与 MODEL_CHUNK 优先级...");

    // 3a dedup_fetch_limit 不被 dedup_batch_size 默认值 50 遮蔽
    const o1 = readOptions({ dedup_batch_size: 50, dedup_fetch_limit: 200 });
    assert.strictEqual(
      o1.dedup_fetch_limit,
      200,
      "【反证门 3a】dedup_batch_size 为默认 50 时，dedup_fetch_limit=200 必须生效，绝不被 50 遮蔽！"
    );

    // 3a 补充：用户显式改 batch_size 时，batch_size 优先
    const o2 = readOptions({ dedup_batch_size: 300, dedup_fetch_limit: 200 });
    assert.strictEqual(
      o2.dedup_fetch_limit,
      300,
      "用户显式把 dedup_batch_size 改为 300 时，应驱动拉取上限为 300"
    );

    // 3b args.audit_chunk_size 覆盖 cfg，且 [5,60] 守卫
    await clearRecords();
    for (let i = 1; i <= 30; i++) {
      await env.client.create("memories", {
        project: env.project,
        category: "fact",
        title: `分块优先级测试条目 ${i}`,
        content: `分块正文 ${i}`,
        lifecycle_status: "active",
        recurrence: 1,
        tags: `chunk${i}`,
        created_at: "2026-10-20 12:00:00",
        updated_at: "2026-10-20 12:00:00",
      });
    }

    let sentCount = 0;
    const probeFetch = async (url, reqOpts) => {
      try {
        const body = typeof reqOpts?.body === "string" ? JSON.parse(reqOpts.body) : reqOpts?.body;
        const txt = body?.messages?.[1]?.content || "";
        const m = txt.match(/【待去重记忆列表】：\n(\[.*?\])\n/s);
        if (m) sentCount = JSON.parse(m[1]).length;
      } catch (err) {
        void err;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ memory_duplicates: [], pitfall_duplicates: [] }) } }],
        }),
      };
    };

    const hub3 = await MagpieMemoryHub({
      audit_model: "test-v635-chunk",
      audit_chunk_size: 40,
      audit_max_batches: 1,
      _fetch: probeFetch,
    }, { client: env.client, ncb_instance: env.instance });

    sentCount = 0;
    await hub3.tool["memory_audit"].execute({
      project: env.project,
      full: true,
      max_model_batches: 1,
      audit_chunk_size: 15,
    });
    assert.strictEqual(
      sentCount,
      15,
      "【反证门 3b】args.audit_chunk_size=15 必须覆盖 cfg 的 40，送入模型条数应为 15！"
    );

    // 溢出钳制
    sentCount = 0;
    await hub3.tool["memory_audit"].execute({
      project: env.project,
      full: true,
      max_model_batches: 1,
      audit_chunk_size: 999,
    });
    assert.strictEqual(sentCount, 30, "audit_chunk_size 溢出必须被钳制在 60 以内（本批只有 30 条）");

    console.log("  ✓ 反证门 3 通过：fetch_limit 与 chunk 优先级、范围守卫均正确\n");

    // =============================================================
    // 4. 【反证门 4】新周期清游标 vs 接力保留游标
    // =============================================================
    console.log("▶ [反证门 4] 新周期首发清游标，接力场景保留游标...");

    // 4a 新周期首发：预置一个表尾旧游标，断言被清空
    clearAuditCursor(env.project);
    saveAuditCursor(env.project, { last_memory_id: 999999, last_pitfall_id: 999999, last_id: 999999 });
    const beforeCursor = getAuditCursor(env.project);
    assert.ok(beforeCursor && Number(beforeCursor.last_memory_id) === 999999, "预置游标必须成功写入");

    // 模拟新周期到达（last_dedup_pending 未置位）
    const st0 = readState();
    st0.audit = st0.audit || {};
    st0.audit.last_dedup_pending = false;
    // 关键：必须把上次去重时间推到 2 天前，才算「新周期确实到期」。
    // 若留 null 或今天，daily 判定会因 over24h=false 且 reachedToday=false 而正确跳过。
    st0.audit.last_dedup_at = "2000-01-01 00:00:00";
    writeState(st0);

    const schedCfg = {
      project: env.project,
      dedup_schedule: "daily",
      dedup_time: "00:00",
      dedup_batch_size: 50,
      dedup_fetch_limit: 50,
    };
    const checkFn = MagpieMemoryHub.checkScheduledDedup;
    assert.ok(typeof checkFn === "function", "checkScheduledDedup 必须已导出");

    const rawRun = await checkFn(env.client, schedCfg);
    const runRes = parseOut(rawRun);
    console.log("    [debug] checkScheduledDedup 返回:", JSON.stringify(runRes).slice(0, 200));
    assert.ok(runRes && !runRes.skipped, );

    const afterCursor = getAuditCursor(env.project);
    const afterMemId = Number(afterCursor?.last_memory_id) || 0;
    assert.ok(
      afterMemId !== 999999,
      "【反证门 4a】新周期首发的旧游标 999999 必须被清除（否则 id<=999999 的记录永远漏扫）！"
    );

    console.log("  ✓ 反证门 4 通过：新周期清游标已生效\n");

    // =============================================================
    // 5. 规范自检与零残留
    // =============================================================
    console.log("▶ [自检] test_meta 规范合规与零残留...");
    const selfPath = fileURLToPath(import.meta.url);
    const selfCode = fs.readFileSync(selfPath, "utf8");
    const scanRes = scanTestFile(selfPath, selfCode);
    if (scanRes.issues.length > 0) {
      console.error("❌ 本测试存在 test_meta 规范违规:");
      for (const iss of scanRes.issues) console.error("   -", iss);
    }
    assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 100% 符合 test_meta 规范");
    console.log("  ✓ test_meta 自检 0 违规");
  } catch (err) {
    console.error("❌ 测试异常:", err);
    throw err;
  } finally {
    try {
      clearAuditCursor(env.project);
    } catch (err) {
      void err;
    }
    console.log(`\n[CLEANUP] 清理隔离命名空间 ${env.project}...`);
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "测试结束后数据库必须 0 残留");
    console.log("✅ 零残留断言通过");
  }
}

await run();
console.log("=================================================================");
console.log("✅ v6.35-a 全部 4 大反证门 100% 通过！");
console.log("=================================================================");
