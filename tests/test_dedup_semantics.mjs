/**
 * tests/test_dedup_semantics.mjs
 * 记忆语义级去重专项测试：
 * 1. 【反证门 1】：同一事实（Web Search MCP）5 种不同措辞变体，断言只入库 1 条，recurrence 累加到 5
 * 2. 【反证门 2】：同一事实（pnpm 依赖管理）4 种不同措辞变体，断言只入库 1 条，recurrence 累加到 4
 * 3. 【正例门】：3 个不同事实（Web Search、pnpm、禁止调大模型），断言全部独立入库（证明去重未误伤正例）
 * 4. 【异步网关队列去重】：测试 gateway_harvest.hooks.js drainHarvestQueue 消费队列时的语义查重与复发计数累加
 * 5. 【数据隔离与零残留】：使用 createTestEnv 隔离命名空间，测试完毕强制清理并断言 residue 为 0
 */

import assert from "node:assert";
import { MagpieMemoryHub } from "../tools.js";
import { createTestEnv } from "./lib/testenv.mjs";
import {
  enqueueHarvestItems,
  readHarvestQueue,
  clearHarvestQueue,
} from "../src/core/state.js";
import { triggerBackgroundDrain } from "../gateway_harvest.hooks.js";

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

const rowsOf = (res) => Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);

const env = await createTestEnv({ mode: "memory" });

console.log("=================================================================");
console.log("【记忆语义去重专项测试】");
console.log(`隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

async function run() {
  const hub = await MagpieMemoryHub({}, { client: env.client, ncb_instance: env.instance });
  const memSave = hub.tool["memory_save"];
  const memSearch = hub.tool["memory_search"];

  try {
    // -----------------------------------------------------------------
    // 测试 1：【反证门 1】同一事实的 5 种不同措辞，断言只入库 1 条，recurrence 累加至 5
    // -----------------------------------------------------------------
    console.log("--- 测试 1: 【反证门 1】Web Search MCP 同一事实 5 种不同措辞变体 ---");
    const wsVariants = [
      { title: "Magpie Web Search MCP端点与特性", content: "Web Search MCP 提供网络搜索能力，端点配置为 /api/search" },
      { title: "Magpie Web Search MCP端点与工具特性", content: "Web Search MCP 插件提供网络搜索功能，端点为 /api/search" },
      { title: "Magpie Web Search MCP 端点与特性说明", content: "Magpie 网关的 Web Search MCP 端点提供网络搜索特性，接口是 /api/search" },
      { title: "「Magpie Web Search MCP」端点及特性", content: "关于 Web Search MCP：提供网络搜索能力，端点配置是 /api/search" },
      { title: "Magpie 的 Web Search MCP 工具特性与端点", content: "Web Search MCP 具备网络搜索工具特性，其端点为 /api/search" },
    ];

    let firstId = null;
    for (let i = 0; i < wsVariants.length; i++) {
      const v = wsVariants[i];
      const res = parseOut(await memSave.execute({
        project: env.project,
        category: "fact",
        title: v.title,
        content: v.content,
      }));

      console.log(`  措辞变体 ${i + 1}/5 保存结果:`, JSON.stringify(res));

      if (i === 0) {
        assert.strictEqual(res.action, "ADD", "第 1 条变体应成功 ADD 新增");
        assert.ok(res.id > 0, "应返回有效主键 ID");
        assert.strictEqual(res.recurrence, 1, "初始 recurrence 应为 1");
        firstId = res.id;
      } else {
        // v6.36 EVO-1 语义升级：同标题且新内容显著更详尽时会返回 ENRICHED 融合更新，
        // 仍复用同一 id 且不新增记录。故此处接受 NOOP 或 ENRICHED，
        // 但下方「id 必须相同」「库中只 1 条」等不变量保持严格。
        assert.ok(["NOOP", "ENRICHED"].includes(res.action), `变体 ${i + 1} 必须被语义查重拦截（NOOP 或 ENRICHED），实际 ${res.action}`);
        assert.strictEqual(res.id, firstId, `变体 ${i + 1} 返回的 id 必须与第 1 条相同`);
        assert.strictEqual(res.recurrence, i + 1, `变体 ${i + 1} recurrence 应累加为 ${i + 1}`);
      }
    }

    // 校验内存/库中该项目下的记忆总数：必须严格等于 1
    const memRows1 = rowsOf(await env.client.list("memories", { project: env.project, category: "fact" }));
    assert.strictEqual(memRows1.length, 1, "【反证门 1】数据库中必须严格只有 1 条记录，绝不允许多条变体共存！");
    assert.strictEqual(memRows1[0].id, firstId, "保留记录必须为首条记录");
    assert.strictEqual(memRows1[0].recurrence, 5, "数据库行 recurrence 字段必须严格累加到 5！");
    console.log("  ✓ 【反证门 1 通过】：5 种变体成功去重合并为 1 条记录，recurrence 累加至 5！\n");

    // -----------------------------------------------------------------
    // 测试 2：【反证门 2】同一事实（pnpm 依赖管理）4 种不同措辞变体
    // -----------------------------------------------------------------
    console.log("--- 测试 2: 【反证门 2】pnpm 依赖管理 同一事实 4 种不同措辞变体 ---");
    const pnpmVariants = [
      { title: "项目统一使用 pnpm 管理依赖", content: "项目全工程强制统一使用 pnpm 安装依赖，避免锁文件冲突。" },
      { title: "「项目统一使用 pnpm 管理依赖」", content: "项目全工程强制统一采用 pnpm 进行依赖管理，避免锁文件冲突。" },
      { title: "项目统一采用 pnpm 进行依赖管理", content: "统一采用 pnpm 管理依赖包，防止版本冲突。" },
      { title: "全工程依赖包管理统一使用 pnpm", content: "全工程依赖包管理统一使用 pnpm 作为包管理器，严禁使用 npm/yarn。" },
    ];

    let pnpmFirstId = null;
    for (let i = 0; i < pnpmVariants.length; i++) {
      const v = pnpmVariants[i];
      const res = parseOut(await memSave.execute({
        project: env.project,
        category: "preference",
        title: v.title,
        content: v.content,
      }));

      console.log(`  pnpm 变体 ${i + 1}/4 保存结果:`, JSON.stringify(res));

      if (i === 0) {
        assert.strictEqual(res.action, "ADD", "第 1 条 pnpm 记忆应 ADD 入库");
        assert.ok(res.id > 0, "应返回有效主键 ID");
        pnpmFirstId = res.id;
      } else {
        // v6.36 EVO-1 语义升级：同标题且新内容显著更详尽时会返回 ENRICHED 融合更新，
        // 仍复用同一 id 且不新增记录。故此处接受 NOOP 或 ENRICHED，
        // 但下方「id 必须相同」「库中只 1 条」等不变量保持严格。
        assert.ok(["NOOP", "ENRICHED"].includes(res.action), `pnpm 变体 ${i + 1} 必须被语义查重拦截（NOOP 或 ENRICHED），实际 ${res.action}`);
        assert.strictEqual(res.id, pnpmFirstId, `pnpm 变体 ${i + 1} 返回的 id 必须与第 1 条相同`);
        assert.strictEqual(res.recurrence, i + 1, `pnpm 变体 ${i + 1} recurrence 应累加为 ${i + 1}`);
      }
    }

    const memRows2 = rowsOf(await env.client.list("memories", { project: env.project, category: "preference" }));
    assert.strictEqual(memRows2.length, 1, "【反证门 2】pnpm 分类下必须严格只有 1 条记录！");
    assert.strictEqual(memRows2[0].recurrence, 4, "数据库行 recurrence 字段必须严格累加到 4！");
    console.log("  ✓ 【反证门 2 通过】：4 种 pnpm 变体成功去重合并为 1 条记录，recurrence 累加至 4！\n");

    // -----------------------------------------------------------------
    // 测试 3：【正例门】3 个不同事实，断言全部独立入库（证明去重未误伤）
    // -----------------------------------------------------------------
    console.log("--- 测试 3: 【正例门】3 个不同事实，断言全部独立入库 ---");
    const distinctFacts = [
      { category: "decision", title: "前端状态管理决策", content: "经过技术评估，前端状态管理统一使用 Zustand，摒弃 Redux。" },
      { category: "decision", title: "后端鉴权方案决策", content: "网关与服务间认证统一采用 JWT Bearer Token，并在 Redis 中做黑名单校验。" },
      { category: "decision", title: "数据库连接池配置决策", content: "生产环境连接池最大连接数设置为 50，超时时间 5000ms。" },
    ];

    const insertedIds = [];
    for (let i = 0; i < distinctFacts.length; i++) {
      const f = distinctFacts[i];
      const res = parseOut(await memSave.execute({
        project: env.project,
        category: f.category,
        title: f.title,
        content: f.content,
      }));

      console.log(`  不同事实 ${i + 1}/3 保存结果:`, JSON.stringify(res));
      assert.strictEqual(res.action, "ADD", `不同事实 ${i + 1} 必须正常 ADD 入库，绝不许被误判为重复！`);
      assert.ok(res.id > 0, "必须分配有效 ID");
      insertedIds.push(res.id);
    }

    // 校验 decision 分类下条目数量恰好为 3
    const decisionRows = rowsOf(await env.client.list("memories", { project: env.project, category: "decision" }));
    assert.strictEqual(decisionRows.length, 3, "【正例门】3 个不同决策必须全部入库（条数必须恰好为 3）！");
    assert.strictEqual(new Set(insertedIds).size, 3, "3 个条目 ID 必须互不相同");
    console.log("  ✓ 【正例门通过】：3 个不同事实均正常分配独立主键入库，证明语义去重未误杀正例！\n");

    // -----------------------------------------------------------------
    // 测试 4：【网关自动采集异步队列语义去重验证】
    // -----------------------------------------------------------------
    console.log("--- 测试 4: 【网关自动采集异步队列语义去重】 ---");
    clearHarvestQueue();

    // 模拟网关自动采集队列塞入同一事实的 3 个变体
    const harvestVariants = [
      {
        id: "hq_m_test_1",
        table: "memories",
        project: env.project,
        data: {
          project: env.project,
          category: "insight",
          title: "显式记忆保存禁止调用大模型",
          content: "显式保存记忆（memory_save）应当直达数据库，严禁额外触发模型提炼以免开销与死循环。",
          origin: "harvest",
          recurrence: 1,
        },
      },
      {
        id: "hq_m_test_2",
        table: "memories",
        project: env.project,
        data: {
          project: env.project,
          category: "insight",
          title: "显式记忆保存切勿调用大模型",
          content: "显式记忆保存必须直接写入数据库，切勿额外调用大模型提炼，避免死循环开销。",
          origin: "harvest",
          recurrence: 1,
        },
      },
      {
        id: "hq_m_test_3",
        table: "memories",
        project: env.project,
        data: {
          project: env.project,
          category: "insight",
          title: "显式保存记忆禁止调用大模型",
          content: "显式保存记忆（memory_save）应当直接持久化入库，严禁额外调用大模型以免死循环。",
          origin: "harvest",
          recurrence: 1,
        },
      },
    ];

    enqueueHarvestItems(harvestVariants);
    const queueBefore = readHarvestQueue();
    assert.strictEqual(queueBefore.length, 3, "入队后队列长度应为 3");

    // 执行网关消费落库
    const drainRes = await triggerBackgroundDrain(env.client);
    console.log("  drainHarvestQueue 消费结果:", JSON.stringify(drainRes));
    assert.strictEqual(drainRes.processed, 3, "应消费 3 个队列项");
    assert.strictEqual(drainRes.memoriesSaved, 1, "真正落盘新建行必须恰好为 1 条！");

    const insightRows = rowsOf(await env.client.list("memories", { project: env.project, category: "insight" }));
    assert.strictEqual(insightRows.length, 1, "数据库中 insight 分类必须只有 1 条记录！");
    assert.strictEqual(insightRows[0].recurrence, 3, "既有记录 recurrence 必须成功累加到 3！");
    console.log("  ✓ 【网关自动采集异步队列测试通过】：3 次变体消费后仅产生 1 条记录，且 recurrence 累加为 3！\n");

    // -----------------------------------------------------------------
    // 测试 5：检索输出验证
    // -----------------------------------------------------------------
    console.log("--- 测试 5: 【检索输出验证】 ---");
    const rawSearch = await memSearch.execute({
      project: env.project,
      category: "fact",
      query: "Web Search MCP",
    });
    const searchRes = typeof rawSearch === "string" ? JSON.parse(rawSearch) : rawSearch;
    assert.ok(searchRes.memories && searchRes.memories.length > 0, "应检索到 Web Search 记忆");
    assert.strictEqual(searchRes.memories[0].recurrence, 5, "检索输出应返回 recurrence 字段且为 5");
    console.log("  ✓ 检索输出已包含 recurrence=5！\n");

  } finally {
    // -----------------------------------------------------------------
    // 清理与零残留断言
    // -----------------------------------------------------------------
    console.log(`[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    const cleanRes = await env.cleanup();
    console.log(`[CLEANUP] 已清理: memories=${cleanRes.memoriesDeleted}, pitfalls=${cleanRes.pitfallsDeleted}`);
    const residue = await env.countAllTestResidue();
    console.log(`[CLEANUP] 全局残余检测: memories=${residue.memories}, pitfalls=${residue.pitfalls}, total=${residue.total}`);
    assert.strictEqual(residue.total, 0, "必须实现 100% 零残留！");
    console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
  }
}

run().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
