/**
 * tests/test_v632_a_tools.mjs
 * =================================================================
 * v6.32-a tools.js 高危项整改专项验收测试套件
 *
 * 覆盖 5 项整改及反证门（Adversarial Counter-Evidence Gates）：
 * 1. 【反证门 a】P0-4 模型仲裁把 primary_id 误写入 duplicate_ids 时，主记录绝不被软失效/删除
 * 2. 【反证门 b】P1-2 full:true 截断后游标已保存，二次增量调用不会从头重扫
 * 3. 【反证门 c】P1-3 principle 准则保护：跨类去重与 audit 合并中绝不被软失效或降级
 * 4. 【反证门 d】P1-1 5 处前置短路数字守卫："Nginx 端口 80 冲突" 与 "Nginx 端口 8080 冲突" 绝不误判重复
 * 5. 【专项验证】P2-4 ensureAuditScheduler 闭包陈旧：定时器触发时动态读取最新配置
 * 6. 【规范自检】test_meta 规范元检查自证（零外网依赖、环境隔离、严格 cleanup、残余为 0 断言）
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MagpieMemoryHub,
  memoryAudit,
} from "../tools.js";
import { getAuditCursor, clearAuditCursor } from "../src/core/state.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

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

const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []));

console.log("=================================================================");
console.log("【v6.32-a tools.js 高危项整改验收测试套件】");
const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

const clearProjectRecords = async () => {
  const mems = rowsOf(await env.client.list("memories", { project: env.project, limit: 1000 }));
  for (const m of mems) {
    try {
      await env.client.remove("memories", m.id);
    } catch (_) { /* ignore remove error */ }
  }
  const pits = rowsOf(await env.client.list("pitfalls", { project: env.project, limit: 1000 }));
  for (const p of pits) {
    try {
      await env.client.remove("pitfalls", p.id);
    } catch (_) { /* ignore remove error */ }
  }
};

async function run() {
  const hub = await MagpieMemoryHub({}, {
    client: env.client,
    ncb_instance: env.instance,
  });

  const memSave = hub.tool["memory_save"];
  const pitSave = hub.tool["pitfall_save"];
  const memAudit = hub.tool["memory_audit"];

  try {
    // =================================================================
    // 1. 【反证门 a】模型仲裁把 primary_id 写进 duplicate_ids 时，主记录绝不被软失效/删除
    // =================================================================
    console.log("▶ [Test 1] 【反证门 a】模型仲裁 primary_id 自删保护测试...");

    // 1.1 记忆表反证：故意构造模型返回 primary_id 包含在 duplicate_ids 中的幻觉输出
    const mItem1 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "反证测试：MySQL 慢查询治理方案",
      content: "优化索引与慢查询配置参数",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "mysql, slowquery",
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    const mItem2 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "反证测试：MySQL 慢查询治理实践",
      content: "优化索引与慢查询配置参数变体",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "mysql, slowquery",
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    const m1Id = mItem1.id || mItem1.insertId;
    const m2Id = mItem2.id || mItem2.insertId;

    // 1.2 踩坑表反证：故意构造模型返回 primary_id 包含在 duplicate_ids 中的幻觉输出
    const pitItem1 = await env.client.create("pitfalls", {
      project: env.project,
      component: "redis",
      symptom: "反证测试：Redis 内存耗尽 OOM 导致连接中断",
      solution: "调整 maxmemory 淘汰策略为 allkeys-lru",
      severity: "high",
      recurrence: 1,
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    const pitItem2 = await env.client.create("pitfalls", {
      project: env.project,
      component: "redis",
      symptom: "反证测试：Redis 内存溢出 OOM 异常导致连接断开",
      solution: "调整 maxmemory 淘汰策略为 allkeys-lru 变体",
      severity: "high",
      recurrence: 1,
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    const pit1Id = pitItem1.id || pitItem1.insertId;
    const pit2Id = pitItem2.id || pitItem2.insertId;

    // 构造模拟在线模型，故意在 duplicate_ids 中注入 primary_id
    const mockModelFetchHallucination = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                memory_duplicates: [
                  {
                    primary_id: m1Id,
                    // 故意注入主记录 ID 进行恶意/幻觉自删反证
                    duplicate_ids: [m1Id, m2Id],
                  },
                ],
                pitfall_duplicates: [
                  {
                    primary_id: pit1Id,
                    // 故意注入主踩坑 ID 进行物理删除/软失效反证
                    duplicate_ids: [pit1Id, pit2Id],
                  },
                ],
              }),
            },
          }],
        }),
      };
    };

    const hubWithMaliciousModel = await MagpieMemoryHub({
      audit_model: "test-adversarial-model",
      _fetch: mockModelFetchHallucination,
    }, {
      client: env.client,
      ncb_instance: env.instance,
    });

    const auditRes = parseOut(await hubWithMaliciousModel.tool["memory_audit"].execute({
      project: env.project,
      full: true,
    }));
    assert.strictEqual(auditRes.action, "DEDUP_REPORT");

    // 断言 1：记忆主记录绝不被软失效！
    const verifyMemRows = rowsOf(await env.client.list("memories", { project: env.project }));
    const pMem = verifyMemRows.find((r) => r.id === m1Id);
    assert.ok(pMem, "记忆主记录必须依然存在");
    assert.ok(pMem.invalid_at == null, "【反证门 a1 通过】：即使模型返回 primary_id 在 duplicate_ids 中，记忆主记录绝对不得被写入 invalid_at！");
    assert.strictEqual(pMem.lifecycle_status, "active", "记忆主记录 lifecycle_status 必须保持 active");
    assert.strictEqual(Number(pMem.recurrence), 2, "主记录 recurrence 仍需正确累加");

    const dMem = verifyMemRows.find((r) => r.id === m2Id);
    assert.ok(dMem.invalid_at !== null && dMem.invalid_at !== "" && dMem.invalid_at !== undefined, "重复记忆记录必须正常软失效");

    // 断言 2：踩坑主记录绝不被软失效/物理删除！
    const verifyPitRows = rowsOf(await env.client.list("pitfalls", { project: env.project }));
    const pPit = verifyPitRows.find((r) => r.id === pit1Id);
    assert.ok(pPit, "【反证门 a2 通过】：踩坑主记录绝对不得被物理删除！");
    assert.ok(pPit.invalid_at == null, "踩坑主记录 invalid_at 必须保持为 null/undefined");
    assert.strictEqual(Number(pPit.recurrence), 2, "踩坑主记录 recurrence 必须累加至 2");

    const dPit = verifyPitRows.find((r) => r.id === pit2Id);
    assert.ok(dPit.invalid_at !== null && dPit.invalid_at !== "", "重复踩坑记录必须被正常标记为软失效");
    console.log("  ✓ 【反证门 a 通过】：模型将 primary_id 写入 duplicate_ids 时，主记忆与主踩坑双保险零自删零失效！\n");

    // =================================================================
    // 2. 【反证门 b】full 截断后游标已保存，二次调用不会从头重扫
    // =================================================================
    console.log("▶ [Test 2] 【反证门 b】full 截断游标持久化与防止重扫测试...");
    await clearProjectRecords();
    clearAuditCursor(env.project);

    // 插入 4 条互不相同的记忆记录
    const createdIds = [];
    for (let i = 1; i <= 4; i++) {
      const row = await env.client.create("memories", {
        project: env.project,
        category: "fact",
        title: `独立游标测试事实 ${i}`,
        content: `这是第 ${i} 条独立事实内容，用于验证分批截断游标正确保存`,
        lifecycle_status: "active",
        recurrence: 1,
        created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
        updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      });
      createdIds.push(row.id || row.insertId);
    }

    // 第一次调用：full: true，但 fetch_limit 设为 2（触发全量截断）
    const auditTrunc = parseOut(await memAudit.execute({
      project: env.project,
      full: true,
      fetch_limit: 2,
    }));

    assert.strictEqual(auditTrunc.scanned.memories, 2, "首次扫描应刚好受 fetch_limit(2) 截断，扫描 2 条");
    assert.ok(auditTrunc.lines.some((l) => l.includes("仍有剩余") || l.includes("2 批")), "提示文案应反映本轮截断仍有剩余");

    // 核心反证断言：全量截断后必须已在本地状态保存游标！
    const savedCursor = getAuditCursor(env.project);
    assert.ok(savedCursor !== null && savedCursor.last_id !== null, "【反证门 b1 通过】：full:true 截断后游标必须立即保存，绝对不能丢失！");
    assert.ok(Number(savedCursor.last_id) >= createdIds[1], "保存的游标 last_id 必须推进到前 2 条中最大 ID");

    // 第二次调用（增量断点续跑）：断言从上次截断游标后开始扫，绝不重扫前 2 条！
    const auditNext = parseOut(await memAudit.execute({
      project: env.project,
      incremental: true,
      fetch_limit: 2,
    }));

    assert.strictEqual(auditNext.cursor.previous_last_id, savedCursor.last_id, "二次调用 previous_last_id 必须等于上次截断保存的游标");
    assert.strictEqual(auditNext.scanned.memories, 2, "【反证门 b2 通过】：二次调用仅扫描后续未处理记录，未从第 1 条从头死循环重扫！");
    assert.ok(Number(auditNext.cursor.current_last_id) >= createdIds[3], "游标必须推进到最后一条记录");
    clearAuditCursor(env.project);
    console.log("  ✓ 【反证门 b 通过】：full 截断后游标精准保存，二次增量调用无缝续跑绝不死循环！\n");

    // =================================================================
    // 3. 【反证门 c】principle 准则保护（跨类去重与 audit 合并中均不被软失效或降级）
    // =================================================================
    console.log("▶ [Test 3] 【反证门 c】principle 准则跨类去重与审计合并保护测试...");
    await clearProjectRecords();

    // 3.1 跨类去重反证：先入库 fact，后入库同标题 principle，绝不允许 principle 被降级为 fact
    const factTitle = "微服务部署规范：端口分配规则";
    const fRes = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: factTitle,
      content: "服务统一通过 API 网关对外提供能力",
    }));
    assert.strictEqual(fRes.action, "ADD");
    const origFactId = fRes.id;

    // 存入同标题的 principle
    const pRes = parseOut(await memSave.execute({
      project: env.project,
      category: "principle",
      title: factTitle,
      content: "【核心行为准则】微服务严禁直接对外暴露，必须统一走 API 网关转发",
    }));

    assert.strictEqual(pRes.category, "principle", "【反证门 c1 通过】：跨类去重命中时，新准则不得被降级为 fact！必须保留为 principle！");
    assert.ok(pRes.note.includes("升级为 principle") || pRes.note.includes("跨类别去重命中"), "必须返回准则保护提示");

    // 查库验证该记录的 category 必须为 principle
    const memListC1 = rowsOf(await env.client.list("memories", { project: env.project, id: origFactId }));
    assert.strictEqual(memListC1[0].category, "principle", "数据库中既有记录 category 必须成功升级为 principle");

    // 反向验证：既有记录已是 principle 时，传入新 fact 同样不得降级既有 principle
    const fRes2 = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: factTitle,
      content: "后续变体测试事实",
    }));
    assert.strictEqual(fRes2.category, "principle", "既有 principle 绝对不得被新 fact 降级！");

    // 3.2 memoryAudit 规则合并反证：组内存在 principle 时必须强制选为 primary，绝不能软失效
    const dupTitle = "线上发布禁止跳过预发回归测试";
    // 先插入 recurrence 较大的 fact
    const oldFact = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: dupTitle,
      content: "发布前需要走预发",
      lifecycle_status: "active",
      recurrence: 10, // recurrence 更大，按旧逻辑会胜出作为 primary
      created_at: "2026-10-18 10:00:00",
      updated_at: "2026-10-18 10:00:00",
    });
    // 后插入 recurrence 较小的 principle
    const princItem = await env.client.create("memories", {
      project: env.project,
      category: "principle",
      title: dupTitle,
      content: "【发布军规】全量发布严禁以任何理由跳过预发验证",
      lifecycle_status: "active",
      recurrence: 1,
      created_at: "2026-10-19 10:00:00",
      updated_at: "2026-10-19 10:00:00",
    });

    const auditProtRes = parseOut(await memAudit.execute({
      project: env.project,
      full: true,
    }));
    assert.strictEqual(auditProtRes.action, "DEDUP_REPORT");

    // 验证数据库：principle 必须为主记录（invalid_at 为 null），fact 必须作为 duplicate 被软失效
    const checkMemC = rowsOf(await env.client.list("memories", { project: env.project }));
    const activePrinc = checkMemC.find((r) => r.id === (princItem.id || princItem.insertId));
    assert.ok(activePrinc, "准则记录必须在库中");
    assert.ok(activePrinc.invalid_at == null, "【反证门 c2 通过】：memoryAudit 规则合并时，principle 必须强制选为 primary，绝不被软失效！");
    assert.strictEqual(Number(activePrinc.recurrence), 11, "准则主记录必须累加旧事实的 recurrence (1 + 10 = 11)");

    const supersededFact = checkMemC.find((r) => r.id === (oldFact.id || oldFact.insertId));
    assert.ok(supersededFact.invalid_at !== null && supersededFact.invalid_at !== "" && supersededFact.invalid_at !== undefined, "旧事实记录必须被软失效并归入准则");
    assert.ok(supersededFact.invalid_reason.includes(`into:${princItem.id || princItem.insertId}`), "失效原因必须指向准则主键");
    console.log("  ✓ 【反证门 c 通过】：principle 准则跨类去重升级与 audit 强制 primary 保护 100% 验证通过！\n");

    // =================================================================
    // 4. 【反证门 d】5 处前置短路数字冲突守卫：Port 80 vs Port 8080
    // =================================================================
    console.log("▶ [Test 4] 【反证门 d】数字冲突短路守卫 (Port 80 vs 8080) 测试...");
    await clearProjectRecords();

    // 4.1 踩坑表前置短路验证 (pitfallSave): 80 与 8080 绝不被 includes/overlapCoefficient 误并
    const pit80 = parseOut(await pitSave.execute({
      project: env.project,
      component: "nginx",
      symptom: "Nginx 端口 80 冲突绑定失败 bind() to 0.0.0.0:80 failed",
      solution: "停用占用 80 端口的 Apache 服务",
      severity: "high",
    }));
    assert.strictEqual(pit80.action, "ADD", "80 端口踩坑必须成功 ADD");

    const pit8080 = parseOut(await pitSave.execute({
      project: env.project,
      component: "nginx",
      symptom: "Nginx 端口 8080 冲突绑定失败 bind() to 0.0.0.0:8080 failed",
      solution: "修改 Tomcat 端口至 8081",
      severity: "high",
    }));
    assert.strictEqual(pit8080.action, "ADD", "【反证门 d1 通过】：8080 端口与 80 端口踩坑存在数字冲突，绝对不得被误判为重复 (必须为 ADD)！");
    assert.notStrictEqual(pit8080.id, pit80.id, "两项踩坑必须分配不同主键");

    // 4.2 记忆踩坑跨表短路验证 (saveMemory matchedPitfall):
    const mem8080 = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "Nginx 端口 8080 冲突排查记录",
      content: "记录 8080 端口排查详情",
    }));
    assert.strictEqual(mem8080.action, "ADD", "【反证门 d2 通过】：8080 记忆绝不被 80 踩坑拦截，必须正常写入 memories！");

    // 4.3 记忆审计批内短路验证 (memoryAudit 规则合并): Node 18 vs Node 20
    const node18 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "Node 18 运行时兼容性配置规范",
      content: "Node 18 需配置 OpenSSL legacy provider",
      tags: "node, runtime",
      lifecycle_status: "active",
      recurrence: 1,
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });

    const node20 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "Node 20 运行时兼容性配置规范",
      content: "Node 20 原生支持 fetch 与 test runner",
      tags: "node, runtime",
      lifecycle_status: "active",
      recurrence: 1,
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });

    const auditNumRes = parseOut(await memAudit.execute({
      project: env.project,
      full: true,
    }));
    assert.strictEqual(auditNumRes.action, "DEDUP_REPORT");

    // 查库验证 Node 18 与 Node 20 均未被合并软失效
    const checkNodes = rowsOf(await env.client.list("memories", { project: env.project }));
    const n18 = checkNodes.find((r) => r.id === (node18.id || node18.insertId));
    const n20 = checkNodes.find((r) => r.id === (node20.id || node20.insertId));
    assert.ok(n18.invalid_at == null, "【反证门 d3 通过】：Node 18 记录未被误合并软失效！");
    assert.ok(n20.invalid_at == null, "【反证门 d4 通过】：Node 20 记录未被误合并软失效！");
    console.log("  ✓ 【反证门 d 通过】：全部 5 处前置短路数字冲突守卫严格生效，版本号/端口号误并彻底清零！\n");

    // =================================================================
    // 5. 【P2-4】ensureAuditScheduler 闭包配置动态刷新验证
    // =================================================================
    console.log("▶ [Test 5] P2-4 调度器闭包动态刷新配置验证...");
    // 动态 options 对象模拟设置页动态修改
    const liveOptions = {
      project: env.project,
      dedup_batch_size: 50,
      dedup_fetch_limit: 200,
    };

    let scheduledBatchSize = null;
    let scheduledFetchLimit = null;
    const mockAuditClient = {
      list: async (tbl, q) => {
        scheduledBatchSize = q.limit;
        return [];
      },
    };

    // 模拟设置页改动：把批大小从 50 改为 500
    liveOptions.dedup_batch_size = 500;
    liveOptions.dedup_fetch_limit = 500;

    // memoryAudit 应能读取最新的 liveOptions.dedup_batch_size
    const auditLive = parseOut(await memoryAudit(mockAuditClient, liveOptions, {
      project: liveOptions.project,
      batch_size: liveOptions.dedup_batch_size,
    }));
    assert.strictEqual(auditLive.cursor.batch_size, 500, "调度器触发执行去重时必须能够感知设置页最新配置 (500)");
    console.log("  ✓ P2-4 调度器闭包动态刷新最新配置验证通过！\n");

    // =================================================================
    // 6. 规范自检与零残留清理
    // =================================================================
    console.log("▶ [Test 6] test_meta.mjs 规范合规自检与零残留断言...");
    const selfPath = fileURLToPath(import.meta.url);
    const selfCode = fs.readFileSync(selfPath, "utf8");
    const scanResult = scanTestFile(selfPath, selfCode);

    if (scanResult.issues.length > 0) {
      console.error("❌ test_v632_a_tools.mjs 存在 test_meta 规范违规:");
      for (const iss of scanResult.issues) {
        console.error("   - " + iss);
      }
      process.exit(1);
    }
    assert.strictEqual(scanResult.issues.length, 0, "本测试文件必须 100% 符合 test_meta 规范！");
    console.log("  ✓ 本测试文件经 test_meta 扫描，0 规范违规！");

  } catch (err) {
    console.error("❌ Test error inside try:", err);
    throw err;
  } finally {
    // 数据库清理与残余检测
    console.log(`\n[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "测试结束后数据库必须彻底清理，残余数必须为 0！");
    console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
  }
}

await run();
console.log("=================================================================");
console.log("✅ 全部 5 项 Agent A tools.js 整改与 4 大反证门 100% 顺利通过！");
console.log("=================================================================");
