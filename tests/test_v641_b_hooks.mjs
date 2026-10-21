/**
 * tests/test_v641_b_hooks.mjs
 * =================================================================
 * v6.41-b ARCH-1：网关响应钩子 onResponse 受限等待（Bounded Await）防腰斩专项双向反证测试
 *
 * 1. 【正向 1：Bounded Await 正常完成并保护 pending 生命周期】
 *    - 在预算窗口内正常完成的任务被完整 await，保持宿主 pending > 0
 *    - 验证 ctx.state._bounded_await_outcome === "completed"
 *    - 验证数据正确写入隔离命名空间
 *
 * 2. 【反向 1：超时平滑脱钩，防进程卡死】
 *    - 慢任务耗时超过 bounded_await_timeout_ms 时平滑脱钩 resolve
 *    - 验证 ctx.state._bounded_await_outcome === "timeout"
 *    - 验证不触发宿主超时异常，后台任务不引发未捕获 rejection
 *
 * 3. 【反向 2：宿主信号 signal abort 及时退出】
 *    - 任务执行中遇到 ctx.signal 触发 abort 时立即退出
 *    - 验证 ctx.state._bounded_await_outcome === "aborted"
 *
 * 4. 【双向对照 3：可配置关闭 (bounded_await: false)】
 *    - 显式关闭 bounded_await: false 时立即非阻塞返回 (耗时 < 20ms)
 *    - 验证 ctx.state._bounded_await_outcome === "disabled"
 *    - 对照反证：相同耗时任务在 bounded_await: true 时等待完成
 *
 * 5. 【韧性防线 4：失败不影响主流程 (Fail-Open 零外抛)】
 *    - 任务内部发生致命网络/数据库异常时，onResponse 绝不向外抛错
 *    - 验证 ctx.state._bounded_await_outcome === "error"
 *    - 验证主流程完全不受破坏，顺利交付响应
 *
 * 6. 【兼容性 5：wait_for_flush: true 保留】
 *    - 传 wait_for_flush: true 时完整等待并标记 "flushed"
 *
 * 7. 【纯函数预算计算 6：computeHookBudgetMs 边界测试】
 *    - 默认 8000ms -> 7200ms (留 800ms 余量)
 *    - 1000ms -> 800ms
 *    - 显式 bounded_await_timeout_ms / bounded_await_ms 覆盖
 *
 * 8. 【规范门禁 7：元检查与资源清理】
 *    - 独立命名空间隔离 + cleanup + residue === 0 残余断言
 *    - scanTestFile 自检 0 违规
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  onResponse,
  computeHookBudgetMs,
  processDialogueAndHarvest,
} from "../gateway_harvest.hooks.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

console.log("=================================================================");
console.log("【v6.41-b ARCH-1 onResponse Bounded Await 防腰斩专项双向反证】");
console.log("=================================================================\n");

async function run() {
  const env = await createTestEnv("v641_b_hooks");
  console.log(`[testenv] 隔离命名空间: ${env.project}\n`);

  try {
    const memoryStore = new Map();
    const pitfallStore = new Map();
    let nextId = 1;

    const mockDbClient = {
      list: async (table, params = {}) => {
        const store = table === "memories" ? memoryStore : pitfallStore;
        const rows = [];
        for (const row of store.values()) {
          if (params.project && row.project !== params.project) continue;
          if (params.content_fingerprint && row.content_fingerprint !== params.content_fingerprint) continue;
          rows.push({ ...row });
        }
        return { data: rows };
      },
      create: async (table, data) => {
        const store = table === "memories" ? memoryStore : pitfallStore;
        const id = nextId++;
        const saved = { ...data, id };
        store.set(id, saved);
        return saved;
      },
      remove: async (table, id) => {
        const store = table === "memories" ? memoryStore : pitfallStore;
        const had = store.delete(id);
        return { affectedRows: had ? 1 : 0 };
      },
    };

    const mockExtraction = [
      {
        category: "fact",
        title: "Docker构建缓存配置",
        content: "项目构建采用 Docker BuildKit 缓存挂载 --mount=type=cache",
        tags: "docker,buildkit",
        confidence: 0.95,
      },
      {
        category: "decision",
        title: "网关中间件选型",
        content: "网关钩子采用 Bounded Await 保护 pending 生命周期",
        tags: "gateway,hooks",
        confidence: 0.9,
      },
    ];

    const standardDialogueBody = {
      messages: [
        { role: "user", content: "请记录本项目的 Docker 构建优化与网关设计决策" },
      ],
    };
    const standardReply = {
      choices: [
        {
          message: {
            content: "好的，项目构建采用 Docker BuildKit 缓存挂载 --mount=type=cache。另外网关钩子采用 Bounded Await 保护 pending 生命周期。",
          },
        },
      ],
    };

    // =============================================================
    // 1. 正向验证 1：Bounded Await 正常完成并保护 pending 生命周期
    // =============================================================
    console.log("▶ [Test 1] 正向：Bounded Await 在安全预算内正常完成并保护 pending 生命周期");
    {
      const ctx = {
        options: {
          auto_harvest: true,
          project: env.project,
          _client: mockDbClient,
          _force_test: true,
          extract_model: "mock-model",
          gatewayTimeoutMs: 8000,
          _fetch: async () => {
            // 模拟轻度网络延迟 40ms
            await new Promise((r) => setTimeout(r, 40));
            return {
              ok: true,
              json: async () => ({
                choices: [{ message: { content: JSON.stringify(mockExtraction) } }],
              }),
            };
          },
        },
        state: {},
        session: "sess-v641-completed",
        agent: "gateway-agent",
        success: true,
        request: standardDialogueBody,
      };

      const t0 = performance.now();
      await onResponse(standardReply, ctx);
      const elapsed = performance.now() - t0;

      assert.strictEqual(ctx.state._bounded_await_outcome, "completed", "执行结果必须为 completed");
      assert.ok(elapsed >= 35, `必须等待 taskPromise 完成，耗时应 >= 35ms (实测: ${elapsed.toFixed(2)}ms)`);
      assert.ok(elapsed < 2000, `耗时必须远低于 8000ms 宿主上限 (实测: ${elapsed.toFixed(2)}ms)`);

      // 验证数据确实落库
      const memList = await mockDbClient.list("memories", { project: env.project });
      assert.strictEqual(memList.data.length, 2, "2 条提取事实必须成功写入 mockDbClient");
      console.log(`  ✓ Bounded Await 成功等待 task 完成 (耗时: ${elapsed.toFixed(2)}ms, outcome: ${ctx.state._bounded_await_outcome}, 落库: ${memList.data.length} 条)`);
    }

    // =============================================================
    // 2. 反向验证 1：超时平滑脱钩，绝不阻塞超时报错
    // =============================================================
    console.log("\n▶ [Test 2] 反向：慢任务超过 bounded_await_timeout_ms 时平滑超时脱钩");
    {
      let slowTaskFinished = false;
      const ctx = {
        options: {
          auto_harvest: true,
          project: env.project,
          _client: mockDbClient,
          _force_test: true,
          extract_model: "mock-model",
          bounded_await_timeout_ms: 60, // 设定极小超时 60ms
          _fetch: async () => {
            // 模拟超长网络耗时 600ms
            await new Promise((r) => setTimeout(r, 600));
            slowTaskFinished = true;
            return {
              ok: true,
              json: async () => ({
                choices: [{ message: { content: JSON.stringify(mockExtraction) } }],
              }),
            };
          },
        },
        state: {},
        session: "sess-v641-timeout",
        agent: "gateway-agent",
        success: true,
        request: standardDialogueBody,
      };

      const t0 = performance.now();
      await onResponse(standardReply, ctx);
      const elapsed = performance.now() - t0;

      assert.strictEqual(ctx.state._bounded_await_outcome, "timeout", "必须按预期返回 timeout");
      assert.ok(elapsed >= 50, `耗时必须达到设定阈值 ~60ms (实测: ${elapsed.toFixed(2)}ms)`);
      assert.ok(elapsed < 300, `必须在超时后立即脱钩，绝不能阻塞等待 600ms 完成 (实测: ${elapsed.toFixed(2)}ms)`);
      assert.strictEqual(slowTaskFinished, false, "慢任务在 onResponse 返回时必须尚未完成");
      console.log(`  ✓ 慢任务平滑超时脱钩通过 (耗时: ${elapsed.toFixed(2)}ms, outcome: ${ctx.state._bounded_await_outcome})`);
    }

    // =============================================================
    // 3. 反向验证 2：宿主 signal abort 中途快速中止
    // =============================================================
    console.log("\n▶ [Test 3] 反向：宿主 ctx.signal 中途 abort 响应钩子即刻退出");
    {
      const abortCtrl = new AbortController();
      // 30ms 后模拟宿主因客户端中断触发 abort
      setTimeout(() => abortCtrl.abort(), 30);

      const ctx = {
        options: {
          auto_harvest: true,
          project: env.project,
          _client: mockDbClient,
          _force_test: true,
          extract_model: "mock-model",
          gatewayTimeoutMs: 8000,
          _fetch: async () => {
            await new Promise((r) => setTimeout(r, 800));
            return {
              ok: true,
              json: async () => ({
                choices: [{ message: { content: JSON.stringify(mockExtraction) } }],
              }),
            };
          },
        },
        state: {},
        session: "sess-v641-abort",
        agent: "gateway-agent",
        signal: abortCtrl.signal,
        success: true,
        request: standardDialogueBody,
      };

      const t0 = performance.now();
      await onResponse(standardReply, ctx);
      const elapsed = performance.now() - t0;

      assert.strictEqual(ctx.state._bounded_await_outcome, "aborted", "必须被 signal abort 截断");
      assert.ok(elapsed >= 25, `耗时应接近 abort 触发时刻 30ms (实测: ${elapsed.toFixed(2)}ms)`);
      assert.ok(elapsed < 400, `遇到 abort 必须立即退出，绝不继续挂起 (实测: ${elapsed.toFixed(2)}ms)`);
      console.log(`  ✓ 宿主 abort 中断响应通过 (耗时: ${elapsed.toFixed(2)}ms, outcome: ${ctx.state._bounded_await_outcome})`);
    }

    // =============================================================
    // 4. 双向对照 3：可配置关闭 (bounded_await: false) vs 开启
    // =============================================================
    console.log("\n▶ [Test 4] 双向对照：可配置关闭 (bounded_await: false) 极速返回 vs 默认开启等待");
    {
      // 4.a 关闭受限等待：完全脱钩模式
      const ctxDisabled = {
        options: {
          auto_harvest: true,
          bounded_await: false, // 显式关闭
          project: env.project,
          _client: mockDbClient,
          _force_test: true,
          extract_model: "mock-model",
          _fetch: async () => {
            await new Promise((r) => setTimeout(r, 200));
            return {
              ok: true,
              json: async () => ({
                choices: [{ message: { content: JSON.stringify(mockExtraction) } }],
              }),
            };
          },
        },
        state: {},
        session: "sess-v641-disabled",
        agent: "gateway-agent",
        success: true,
        request: standardDialogueBody,
      };

      const t0 = performance.now();
      await onResponse(standardReply, ctxDisabled);
      const elapsedDisabled = performance.now() - t0;

      assert.strictEqual(ctxDisabled.state._bounded_await_outcome, "disabled", "显式关闭必须标记 disabled");
      assert.ok(elapsedDisabled < 40, `关闭 bounded_await 时必须在 40ms 内极速返回 (实测: ${elapsedDisabled.toFixed(2)}ms)`);
      console.log(`  ✓ 4.a bounded_await: false 极速脱钩通过 (耗时: ${elapsedDisabled.toFixed(2)}ms, outcome: disabled)`);

      // 4.b 对照反证：相同耗时任务在开启 bounded_await 时必定等待完成
      const ctxEnabled = {
        options: {
          auto_harvest: true,
          bounded_await: true,
          project: env.project,
          _client: mockDbClient,
          _force_test: true,
          extract_model: "mock-model",
          gatewayTimeoutMs: 8000,
          _fetch: async () => {
            await new Promise((r) => setTimeout(r, 120));
            return {
              ok: true,
              json: async () => ({
                choices: [{ message: { content: JSON.stringify(mockExtraction) } }],
              }),
            };
          },
        },
        state: {},
        session: "sess-v641-enabled",
        agent: "gateway-agent",
        success: true,
        request: standardDialogueBody,
      };

      const t1 = performance.now();
      await onResponse(standardReply, ctxEnabled);
      const elapsedEnabled = performance.now() - t1;

      assert.strictEqual(ctxEnabled.state._bounded_await_outcome, "completed", "开启状态必须完成等待");
      assert.ok(elapsedEnabled >= 100, `开启时必须等待任务完成，耗时 >= 100ms (实测: ${elapsedEnabled.toFixed(2)}ms)`);
      console.log(`  ✓ 4.b bounded_await: true 对照等待通过 (耗时: ${elapsedEnabled.toFixed(2)}ms, outcome: completed)`);
    }

    // =============================================================
    // 5. 韧性防线 4：失败不影响主流程 (Fail-Open 零外抛)
    // =============================================================
    console.log("\n▶ [Test 5] 韧性防线：taskPromise 发生内部致命异常，onResponse 绝不外抛");
    {
      const ctxCrash = {
        options: {
          auto_harvest: true,
          project: env.project,
          _force_test: true,
          gatewayTimeoutMs: 8000,
          get extract_model() {
            throw new Error("模拟致命异常：读取 extract_model 抛错导致 taskPromise 拒绝");
          },
        },
        state: {},
        session: "sess-v641-crash",
        agent: "gateway-agent",
        success: true,
        request: standardDialogueBody,
      };

      // 无论 taskPromise 发生何种致命异常，onResponse 绝不能 throw
      let threw = false;
      try {
        await onResponse(standardReply, ctxCrash);
      } catch (err) {
        threw = true;
      }
      assert.strictEqual(threw, false, "网关响应钩子绝对不能向上抛出异常");
      assert.strictEqual(ctxCrash.state._bounded_await_outcome, "error", "必须隔离捕获并记录 outcome 为 error");
      console.log(`  ✓ 致命异常隔离通过：主流程完全不受影响 (outcome: ${ctxCrash.state._bounded_await_outcome})`);
    }

    // =============================================================
    // 6. 兼容性 5：wait_for_flush: true 保留
    // =============================================================
    console.log("\n▶ [Test 6] 兼容性：wait_for_flush: true 依然支持完整等待");
    {
      const ctxFlush = {
        options: {
          auto_harvest: true,
          wait_for_flush: true,
          project: env.project,
          _client: mockDbClient,
          _force_test: true,
          extract_model: "mock-model",
          _fetch: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return {
              ok: true,
              json: async () => ({
                choices: [{ message: { content: JSON.stringify(mockExtraction) } }],
              }),
            };
          },
        },
        state: {},
        session: "sess-v641-flush",
        agent: "gateway-agent",
        success: true,
        request: standardDialogueBody,
      };

      await onResponse(standardReply, ctxFlush);
      assert.strictEqual(ctxFlush.state._bounded_await_outcome, "flushed", "wait_for_flush 模式应标记 flushed");
      console.log(`  ✓ wait_for_flush: true 模式行为完整保留 (outcome: ${ctxFlush.state._bounded_await_outcome})`);
    }

    // =============================================================
    // 7. 纯函数预算计算 6：computeHookBudgetMs 边界测试
    // =============================================================
    console.log("\n▶ [Test 7] 预算推导：computeHookBudgetMs 对宿主超时与安全余量的计算边界");
    {
      // 7.a 默认 8000ms -> 7200ms
      assert.strictEqual(computeHookBudgetMs({}), 7200, "默认配置下 hookBudgetMs 必须为 7200ms (8000 - 800)");
      assert.strictEqual(computeHookBudgetMs({ gatewayTimeoutMs: 8000 }), 7200, "gatewayTimeoutMs=8000 时为 7200ms");

      // 7.b 上限 10000ms 截断 -> 9200ms
      assert.strictEqual(computeHookBudgetMs({ gatewayTimeoutMs: 15000 }), 9200, "上限 10000ms - 800 = 9200ms");

      // 7.c 1000ms 小预算 -> 800ms
      assert.strictEqual(computeHookBudgetMs({ gatewayTimeoutMs: 1000 }), 800, "gatewayTimeoutMs=1000 时保留 200ms 余量为 800ms");

      // 7.d 显式自定义覆盖
      assert.strictEqual(computeHookBudgetMs({ bounded_await_timeout_ms: 250 }), 250, "bounded_await_timeout_ms=250 优先生效");
      assert.strictEqual(computeHookBudgetMs({ bounded_await_ms: 350 }), 350, "bounded_await_ms=350 优先生效");
      console.log("  ✓ computeHookBudgetMs 纯函数 5 组边界计算全部符合预期");
    }

    // =============================================================
    // 8. 规范门禁 8：清理与残余数断言
    // =============================================================
    console.log("\n▶ [Test 8] 元检查规范：清理资源与残余断言");
    {
      // 清空 mockDbClient 中的数据
      for (const [id] of memoryStore.entries()) {
        await mockDbClient.remove("memories", id);
      }
      for (const [id] of pitfallStore.entries()) {
        await mockDbClient.remove("pitfalls", id);
      }
      const memRemain = await mockDbClient.list("memories", { project: env.project });
      const pitRemain = await mockDbClient.list("pitfalls", { project: env.project });
      const totalResidue = memRemain.data.length + pitRemain.data.length;
      assert.strictEqual(totalResidue, 0, `清理后残余数必须为 0 (实测: ${totalResidue})`);
      console.log(`  ✓ 资源清理成功，残余数断言通过: totalResidue === ${totalResidue}`);
    }

    // 调用环境 cleanup
    await env.cleanup();

    // =============================================================
    // 9. scanTestFile 门禁自检
    // =============================================================
    console.log("\n▶ [Test 9] test_meta 规范元扫描自检");
    const selfPath = fileURLToPath(import.meta.url);
    const selfContent = fs.readFileSync(selfPath, "utf8");
    const metaRes = scanTestFile(selfPath, selfContent);
    assert.strictEqual(metaRes.issues.length, 0, `test_meta 扫描必须 0 违规: ${JSON.stringify(metaRes.issues)}`);
    console.log(`  ✓ test_meta 静态扫描合规通过`);

    console.log("\n=================================================================");
    console.log("✅ v6.41-b ARCH-1 Bounded Await 全部 9 项双向反证测试 100% 通过！");
    console.log("=================================================================");
  } catch (err) {
    console.error("❌ 测试失败:", err);
    await env.cleanup().catch(() => {});
    process.exit(1);
  }
}

run();
