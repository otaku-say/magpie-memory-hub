/**
 * tests/test_v6300_state_and_retrieval.mjs
 * =================================================================
 * v6300 数据状态机、中文分词Bigram、一站式投影与衰减算法整改专项验证
 * =================================================================
 */
import assert from "node:assert";
import {
  MagpieMemoryHub,
  termsOf,
  CJK_STOP_BIGRAMS,
  fetchAll,
  memoryAuditUndo,
  memoryAudit,
} from "../tools.js";
import { createTestEnv } from "./lib/testenv.mjs";
import { stripScaffolding, SCAFFOLDING_PATTERNS } from "../gateway_harvest.js";
import { harvestWithOnlineModel, classifyDialogueWithOnlineModel } from "../gateway_harvest.hooks.js";

const parseOut = (raw) => (typeof raw === "string" ? JSON.parse(raw) : raw);
const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []));

async function run() {
  console.log("=================================================================");
  console.log("【v6300 状态机与中文分词检索整改专项测试】");
  const env = await createTestEnv();
  console.log("隔离命名空间 project:", env.project);
  console.log("=================================================================\n");

  const hub = await MagpieMemoryHub({
    extract_model: "test-extract-model",
    audit_model: "test-audit-model",
    rerank_model: "test-rerank-model",
    search_rewrite: true,
  }, {
    client: env.client,
    ncb_instance: env.instance,
  });

  const memSave = hub.tool["memory_save"];
  const memSearch = hub.tool["memory_search"];
  const memContext = hub.tool["memory_context"];
  const pitSave = hub.tool["pitfall_save"];
  const pitSearch = hub.tool["pitfall_search"];
  const memAudit = hub.tool["memory_audit"];

  const subProjects = [];

  try {
    // =================================================================
    // --- [Test 1] termsOf(q) 中文 Bigram 切分与虚词剥离验证 ---
    // =================================================================
    console.log("--- [Test 1] termsOf(q) 中文 Bigram 分词与 CJK_STOP_BIGRAMS 剥离验证 ---");
    {
      assert.ok(CJK_STOP_BIGRAMS instanceof Set, "CJK_STOP_BIGRAMS 必须为 Set");
      const requiredStops = ["怎么", "如何", "什么", "为什", "么办", "请问", "帮我", "一下", "这个", "那个"];
      for (const stop of requiredStops) {
        assert.ok(CJK_STOP_BIGRAMS.has(stop), `CJK_STOP_BIGRAMS 必须包含虚词: ${stop}`);
      }

      const q1 = "端口冲突怎么处理";
      const terms1 = termsOf(q1);
      assert.ok(terms1.includes("端口"), "必须包含 2-gram '端口'");
      assert.ok(terms1.includes("冲突"), "必须包含 2-gram '冲突'");
      assert.ok(terms1.includes("处理"), "必须包含 2-gram '处理'");
      assert.ok(!terms1.includes("怎么"), "必须过滤虚词 '怎么'");

      const q2 = "请问Redis缓存异常如何解决一下这个";
      const terms2 = termsOf(q2);
      assert.ok(terms2.includes("redis"), "必须提取英文 'redis'");
      assert.ok(terms2.includes("缓存"), "必须包含 '缓存'");
      assert.ok(terms2.includes("异常"), "必须包含 '异常'");
      assert.ok(terms2.includes("解决"), "必须包含 '解决'");
      assert.ok(!terms2.includes("请问"), "必须剥离 '请问'");
      assert.ok(!terms2.includes("如何"), "必须剥离 '如何'");
      assert.ok(!terms2.includes("一下"), "必须剥离 '一下'");
      assert.ok(!terms2.includes("这个"), "必须剥离 '这个'");

      console.log("  ✓ 中文双字组提取与虚词剥离完全符合预期！\n");
    }

    // =================================================================
    // --- [Test 2] fetchAll max_pages 支持（默认 5，上限 20） ---
    // =================================================================
    console.log("--- [Test 2] fetchAll max_pages 支持（默认 5，上限 20）验证 ---");
    {
      let callPages = [];
      const mockClient = {
        list: async (table, params) => {
          callPages.push(params.page);
          return { data: [{ id: params.page }], metadata: { hasMore: true } };
        },
      };

      // 默认 5 页
      callPages = [];
      await fetchAll(mockClient, "memories", {});
      assert.deepStrictEqual(callPages, [1, 2, 3, 4, 5], "默认必须拉取 5 页");

      // 自定义 max_pages: 3
      callPages = [];
      await fetchAll(mockClient, "memories", { max_pages: 3 });
      assert.deepStrictEqual(callPages, [1, 2, 3], "自定义 max_pages=3 必须拉取 3 页");

      // 上限 20 页
      callPages = [];
      await fetchAll(mockClient, "memories", { max_pages: 50 });
      assert.strictEqual(callPages.length, 20, "max_pages 必须硬上限 20 页");

      console.log("  ✓ fetchAll max_pages 默认值与上限控制验证通过！\n");
    }

    // =================================================================
    // --- [Test 3] memoryContext 精简投影与双路词面扩展打分 ---
    // =================================================================
    console.log("--- [Test 3] memoryContext 精简投影与双路打分验证 ---");
    {
      const m1 = parseOut(await memSave.execute({
        project: env.project,
        category: "fact",
        title: "关于网关端口冲突解决方案",
        content: "当遇到端口被占用的情况，可通过 lsof -i :port 排查并 kill 进程",
        tags: "gateway, port, conflict",
      }));

      // 使用自然无空格中文提问检索
      const ctxRes = parseOut(await memContext.execute({
        project: env.project,
        query: "端口冲突怎么处理",
      }));

      assert.ok(ctxRes.injected >= 1, "中文无空格自然问句必须精准召回记忆条目");
      assert.ok(ctxRes.block.includes("关于网关端口冲突解决方案"), "持久上下文块必须包含该记忆");

      console.log("  ✓ memoryContext 成功通过中文 Bigram 召回自然语言问句相关条目！\n");
    }

    // =================================================================
    // --- [Test 4] pitfallSave 软删除不复活与 Layer ② 语义比对 ---
    // =================================================================
    console.log("--- [Test 4] pitfallSave 软删除防复活与 Layer ② 语义比对验证 ---");
    {
      // 4.1 创建初始踩坑
      const p1 = parseOut(await pitSave.execute({
        project: env.project,
        component: "db_driver",
        symptom: "PostgreSQL 连接池超过上限报错 too many connections",
        solution: "调整 max_connections 参数并开启 pgBouncer 连接池",
      }));

      // 软删除该踩坑（写入 invalid_at）
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      await env.client.update("pitfalls", p1.id, {
        invalid_at: now,
        invalid_reason: "user_deleted",
      });

      // 4.2 软删除后重新保存同类踩坑：绝不应复活已软删除的记录！
      const p2 = parseOut(await pitSave.execute({
        project: env.project,
        component: "db_driver",
        symptom: "PostgreSQL 连接池配置不足导致连接超时超限",
        solution: "调整 max_connections 参数并开启 pgBouncer 连接池",
      }));

      assert.strictEqual(p2.action, "ADD", "旧记录软失效后，新踩坑应新建插入，绝不复活旧记录");
      assert.notStrictEqual(p2.id, p1.id, "新记录 ID 必须不同于已软删除的 ID");

      // 4.3 Layer ② 语义比对：表述相近但非字面完全一致的活跃踩坑必须自动去重累加
      const p3 = parseOut(await pitSave.execute({
        project: env.project,
        component: "db_driver",
        symptom: "Postgres 连接池超限报错 too many connections",
        solution: "调整 max_connections 参数并配置 pgBouncer 代理",
      }));

      assert.strictEqual(p3.action, "NOOP", "语义相似踩坑必须去重命中 NOOP");
      assert.strictEqual(p3.id, p2.id, "必须合并到活跃的 p2 上");
      assert.strictEqual(p3.recurrence, 2, "recurrence 必须累加到 2");

      console.log("  ✓ 软删除踩坑防复活与 Layer ② 语义比对验证通过！\n");
    }

    // =================================================================
    // --- [Test 5] memoryAudit 踩坑跨组件语义去重 ---
    // =================================================================
    console.log("--- [Test 5] memoryAudit 踩坑跨组件语义合并验证 ---");
    {
      const subProj = `${env.project}_audit_comp`;
      subProjects.push(subProj);
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");

      const pA = await env.client.create("pitfalls", {
        project: subProj,
        component: "express_app",
        symptom: "EADDRINUSE 端口 3000 被占用异常报错",
        solution: "kill 占用该端口的旧进程后重试启动",
        content_fingerprint: "fp_comp_a",
        created_at: now,
        updated_at: now,
      });

      const pB = await env.client.create("pitfalls", {
        project: subProj,
        component: "fastify_gateway", // 不同组件名称！
        symptom: "EADDRINUSE 端口 3000 被占用异常报错",
        solution: "kill 占用该端口的旧进程后重试启动",
        content_fingerprint: "fp_comp_b",
        created_at: now,
        updated_at: now,
      });

      // 执行 memory_audit
      const auditRes = parseOut(await memAudit.execute({
        project: subProj,
        full: true,
      }));

      assert.strictEqual(auditRes.success, true);
      assert.strictEqual(auditRes.deduped.pitfalls, 1, "放宽 sameComp 限制后应跨组件合并 1 条踩坑");

      const pBId = pB.id || pB.insertId;
      const pitBRow = rowsOf(await env.client.list("pitfalls", { project: subProj, id: pBId }))[0];
      assert.strictEqual(pitBRow.invalid_at !== null && pitBRow.invalid_at !== undefined, true, "跨组件且相同现象的踩坑必须被合并软失效");

      console.log("  ✓ 跨组件踩坑去重合并验证通过！\n");
    }

    // =================================================================
    // --- [Test 6] memoryAuditUndo 数学守恒（按真实 dupRec 扣减） ---
    // =================================================================
    console.log("--- [Test 6] memoryAuditUndo 数学守恒与 recurrence 精准回滚验证 ---");
    {
      const subProj = `${env.project}_undo_math`;
      subProjects.push(subProj);
      // 创建主记录 (recurrence = 1)
      const pri = parseOut(await memSave.execute({
        project: subProj,
        category: "fact",
        title: "核心配置规则 Alpha",
        content: "配置 port = 8080 必须生效",
      }));

      // 创建副本记录，其 recurrence 已经累加到 3 (比如多次复发)
      const batchTs = Date.now();
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      const dupCreated = await env.client.create("memories", {
        project: subProj,
        category: "fact",
        title: "核心配置规则 Alpha 副本",
        content: "配置 port = 8080 必须生效",
        content_fingerprint: "math_dup_fp",
        lifecycle_status: "invalid",
        invalid_at: now,
        invalid_reason: `dedup:${batchTs}:into:${pri.id}`,
        recurrence: 3, // 副本真实频次为 3！
        created_at: now,
        updated_at: now,
      });
      const dupId = dupCreated.id || dupCreated.insertId;

      // 主记录 recurrence 累加了副本的 3 -> 1 + 3 = 4
      await env.client.update("memories", pri.id, { recurrence: 4 });

      // 执行撤销
      const undoRes = parseOut(await memAudit.execute({
        project: subProj,
        undo: true,
      }));

      assert.strictEqual(undoRes.success, true);
      assert.strictEqual(undoRes.undone_recurrence, 3, "必须精确扣减副本对应的真实 recurrence=3，确保数学守恒");

      const priAfter = rowsOf(await env.client.list("memories", { project: subProj, id: pri.id }))[0];
      assert.strictEqual(Number(priAfter.recurrence), 1, "主记录 recurrence 必须精确减回 1，杜绝膨胀！");

      console.log("  ✓ memoryAuditUndo 数学守恒精准回滚验证通过！\n");
    }

    // =================================================================
    // --- [Test 7] SCAFFOLDING_PATTERNS 注入前缀剥离与超时常量断言 ---
    // =================================================================
    console.log("--- [Test 7] SCAFFOLDING_PATTERNS 注入前缀彻底剥离与超时常量断言 ---");
    {
      const complexPrompt = `
[Persistent Memory Context]
- [principle] 必须进行类型检查: 避免 any
- [fact] 架构规范: 统一采用 ESM

[Memory Agent Guide —— 检索与沉淀]
1. 优先检索记忆...
2. 及时沉淀...

[Memory Context]
- [decision] 选型: 使用 fastify

用户实际业务问题：请帮我检查当前服务端口是否冲突

--- Context from the delegating agent ---
云端沙箱 ID：aa8f1812331643068673810a570196ea
`.trim();

      const stripped = stripScaffolding(complexPrompt);
      assert.ok(!stripped.includes("[Persistent Memory Context]"), "必须清洗 [Persistent Memory Context]");
      assert.ok(!stripped.includes("[Memory Agent Guide"), "必须清洗 [Memory Agent Guide]");
      assert.ok(!stripped.includes("[Memory Context]"), "必须清洗 [Memory Context]");
      assert.ok(!stripped.includes("Context from the delegating agent"), "必须清洗 --- Context from the delegating agent ---");
      assert.strictEqual(stripped, "用户实际业务问题：请帮我检查当前服务端口是否冲突", "必须干净纯粹保留用户实际业务输入");

      console.log("  ✓ 上下文与指派模板清洗彻底，有效杜绝 Prompt 膨胀！\n");
    }

  } finally {
    // =================================================================
    // --- [CLEANUP] 环境清理与零残留检查 ---
    // =================================================================
    console.log(`[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    for (const sp of subProjects) {
      const mems = rowsOf(await env.client.list("memories", { project: sp }));
      for (const m of mems) {
        try { await env.client.remove("memories", m.id); } catch (e) { void e; }
      }
      const pits = rowsOf(await env.client.list("pitfalls", { project: sp }));
      for (const pt of pits) {
        try { await env.client.remove("pitfalls", pt.id); } catch (e) { void e; }
      }
    }
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "测试命名空间必须 100% 零残留");
    console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
  }

  console.log("=================================================================");
  console.log("🎉 全部 v6300 状态机与中文分词检索整改测试 100% 成功通过！");
  console.log("=================================================================");
}

run().catch((e) => {
  console.error("❌ 测试失败:", e);
  process.exit(1);
});
