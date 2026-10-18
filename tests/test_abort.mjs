/**
 * test_abort.mjs —— 验证 ctx.abort 对工具层网络 fetch 的中断与干净退出
 * 严谨性整改：
 * 1. 隔离命名空间：使用 tests/lib/testenv.mjs (project = env.project)
 * 2. 强制清理：finally 中无论中断成功与否均执行 cleanup，并断言残留数为 0
 * 3. 严格字段断言：精确断言 AbortError 或取消信号
 * 4. 反证测试：验证当调用未中断（resolve）或抛出非中断错误时，断言门必定报错拦截
 */
import assert from "node:assert";
import { MagpieMemoryHub } from "../tools.js";
import { createTestEnv } from "./lib/testenv.mjs";

console.log("==========================================");
console.log("测试：ctx.abort 中断与干净退出验证（含反证门）");
console.log("==========================================");

/** 核心中断断言门函数 */
async function assertAbortedCleanly(fn, desc) {
  let threwAbort = false;
  let normalResult = null;
  let unexpectedErr = null;
  try {
    normalResult = await fn();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (e.name === "AbortError" || /aborted|取消/i.test(msg)) {
      threwAbort = true;
      console.log(`  ✓ 成功捕获 AbortError/取消信号: [${e.name}] ${msg}`);
    } else {
      unexpectedErr = e;
    }
  }

  if (normalResult !== null) {
    throw new assert.AssertionError({
      message: `[反证拦截] ${desc} 期望中断退出，但调用却正常 resolve 返回: ${JSON.stringify(normalResult)}`,
    });
  }
  if (unexpectedErr !== null) {
    throw new assert.AssertionError({
      message: `[反证拦截] ${desc} 抛出了非 AbortError 异常: ${unexpectedErr.message}`,
    });
  }
  assert.strictEqual(threwAbort, true, `${desc} 必须干净抛出 AbortError`);
}

async function runTest() {
  const env = await createTestEnv({ instance: "41694_agent_memory", requireMcp: true });

  try {
    const plugin = await MagpieMemoryHub({}, {
      ncb_instance: env.instance,
      ncb_secret: env.secret,
      mcp_key: env.mcpKey,
      _client: env.client,
      client: env.client,
    });

    const tools = plugin.tool;
    assert(tools && typeof tools === "object", "插件导出了 tool 对象");
    assert(typeof tools.memory_save.execute === "function", "memory_save.execute 是函数");

    // 1. 测试已被提前 abort 的 ctx 传入 memory_save
    console.log("\n1. 验证已中止的 ctx.abort 传给 memory_save:");
    {
      const ac = new AbortController();
      ac.abort();
      await assertAbortedCleanly(
        () => tools.memory_save.execute({
          project: env.project,
          category: "fact",
          title: "test abort title",
          content: "test abort content",
          confidence: 0.9,
        }, { abort: ac.signal }),
        "已 abort 的 ctx 调用 memory_save"
      );
    }

    // 2. 测试已中止的 ctx.abort 传给 ncb_check
    console.log("\n2. 验证已中止的 ctx.abort 传给 ncb_check:");
    {
      const ac = new AbortController();
      ac.abort();
      await assertAbortedCleanly(
        () => tools.ncb_check.execute({ database: env.instance }, { abort: ac.signal }),
        "已 abort 的 ctx 调用 ncb_check"
      );
    }

    // 3. 测试已中止的 ctx.abort 传给 r2_check
    console.log("\n3. 验证已中止的 ctx.abort 传给 r2_check:");
    {
      const ac = new AbortController();
      ac.abort();
      await assertAbortedCleanly(
        () => tools.r2_check.execute({ database: env.instance }, { abort: ac.signal }),
        "已 abort 的 ctx 调用 r2_check"
      );
    }

    // 4. 测试动态触发 abort（异步 10ms 中断运行中的 fetch）
    console.log("\n4. 验证运行中的 fetch 收到异步 abort 信号立即干净退出:");
    {
      const ac = new AbortController();
      const origList = env.client.list;
      env.client.list = async (t, p) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(async () => {
            try { resolve(await origList(t, p)); } catch (e) { reject(e); }
          }, 40);
          ac.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const err = new Error("操作已被取消 (aborted)");
            err.name = "AbortError";
            reject(err);
          }, { once: true });
        });
      };
      const timer = setTimeout(() => ac.abort(), 10);
      try {
        await assertAbortedCleanly(
          () => tools.memory_search.execute({ query: "keyword", project: env.project }, { abort: ac.signal }),
          "异步 abort 中断 fetch"
        );
      } finally {
        clearTimeout(timer);
        env.client.list = origList;
      }
    }

    // 5. 反证测试 1：未中断调用（正常 resolve）时，断言门必须识别并报错
    console.log("\n5. 反证测试：断言门对「未中断」与「非 Abort 错误」的拦截能力");
    {
      let caughtFakePass = false;
      try {
        // 模拟一个没有被 abort 的假调用（返回正常对象）
        await assertAbortedCleanly(
          async () => ({ action: "NOOP" }),
          "假冒正常结果"
        );
      } catch (err) {
        if (err instanceof assert.AssertionError && /期望中断退出/.test(err.message)) {
          caughtFakePass = true;
          console.log(`  ✓ 成功拦截正常 resolve 的假过情况: ${err.message}`);
        }
      }
      assert.strictEqual(caughtFakePass, true, "反证用例 1 失败：断言门未能拦截正常 resolve 的假过！");
    }

    // 6. 反证测试 2：抛出普通 Error（而非 AbortError）时，断言门必须拦截
    {
      let caughtUnexpectedErr = false;
      try {
        await assertAbortedCleanly(
          async () => { throw new TypeError("Something else broke"); },
          "普通错误抛出"
        );
      } catch (err) {
        if (err instanceof assert.AssertionError && /非 AbortError/.test(err.message)) {
          caughtUnexpectedErr = true;
          console.log(`  ✓ 成功拦截非 AbortError 异常: ${err.message}`);
        }
      }
      assert.strictEqual(caughtUnexpectedErr, true, "反证用例 2 失败：断言门未能拦截非 AbortError 错误！");
    }

  } finally {
    console.log("\n--- 7. 退出前彻底清理与残留断言 ---");
    const cleanRes = await env.cleanup();
    console.log(`  清理完成: memories 已删 ${cleanRes.memoriesDeleted} 行, pitfalls 已删 ${cleanRes.pitfallsDeleted} 行`);
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, `全局测试残余必须为 0（实际: ${residue.total}）`);
    console.log("  ✓ 全局 __test__ 残留确认为 0");
  }

  console.log("\n✅ 全部 ctx.abort 验证项与反证门测试通过！");
}

runTest().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
