/**
 * test_abort.mjs —— 验证 ctx.abort 对工具层网络 fetch 的中断与干净退出
 */
import assert from "node:assert";
import { MagpieMemoryHub } from "../tools.js";

console.log("==========================================");
console.log("测试：ctx.abort 中断与干净退出验证");
console.log("==========================================");

async function runTest() {
  const plugin = await MagpieMemoryHub({}, {
    ncb_instance: "test_db",
    ncb_secret: "test_secret",
    mcp_key: "test_mcp_key",
  });

  const tools = plugin.tool;
  assert(tools && typeof tools === "object", "插件导出了 tool 对象");
  assert(typeof tools.memory_save.execute === "function", "memory_save.execute 是函数");

  // 1. 测试已被提前 abort 的 ctx 传入 memory_save (REST client)
  console.log("\n1. 验证已中止的 ctx.abort 传给 memory_save:");
  {
    const ac = new AbortController();
    ac.abort();
    let abortedCleanly = false;
    try {
      await tools.memory_save.execute({
        category: "fact",
        title: "test",
        content: "test abort",
        confidence: 0.9,
      }, { abort: ac.signal });
    } catch (e) {
      const msg = String(e && e.message || e);
      if (e.name === "AbortError" || /aborted|取消/i.test(msg)) {
        abortedCleanly = true;
        console.log(`  ✓ 成功捕获 AbortError/取消信号: [${e.name}] ${msg}`);
      } else {
        console.error(`  ✗ 异常但非取消: ${msg}`);
      }
    }
    assert(abortedCleanly, "已 abort 的 ctx 调用 memory_save 必须干净中断退出");
  }

  // 2. 测试已中止的 ctx.abort 传给 ncb_check (MCP client)
  console.log("\n2. 验证已中止的 ctx.abort 传给 ncb_check:");
  {
    const ac = new AbortController();
    ac.abort();
    let abortedCleanly = false;
    try {
      await tools.ncb_check.execute({ database: "test_db" }, { abort: ac.signal });
    } catch (e) {
      const msg = String(e && e.message || e);
      if (e.name === "AbortError" || /aborted|取消/i.test(msg)) {
        abortedCleanly = true;
        console.log(`  ✓ 成功捕获 AbortError/取消信号: [${e.name}] ${msg}`);
      } else {
        console.error(`  ✗ 异常但非取消: ${msg}`);
      }
    }
    assert(abortedCleanly, "已 abort 的 ctx 调用 ncb_check 必须干净中断退出");
  }

  // 3. 测试已中止的 ctx.abort 传给 r2_check (R2 client)
  console.log("\n3. 验证已中止的 ctx.abort 传给 r2_check:");
  {
    const ac = new AbortController();
    ac.abort();
    let abortedCleanly = false;
    try {
      await tools.r2_check.execute({}, { abort: ac.signal });
    } catch (e) {
      const msg = String(e && e.message || e);
      if (e.name === "AbortError" || /aborted|取消/i.test(msg)) {
        abortedCleanly = true;
        console.log(`  ✓ 成功捕获 AbortError/取消信号: [${e.name}] ${msg}`);
      } else {
        console.error(`  ✗ 异常但非取消: ${msg}`);
      }
    }
    assert(abortedCleanly, "已 abort 的 ctx 调用 r2_check 必须干净中断退出");
  }

  // 4. 测试动态触发 abort（异步 10ms 中断运行中的 fetch）
  console.log("\n4. 验证运行中的 fetch 收到异步 abort 信号立即干净退出:");
  {
    const ac = new AbortController();
    const t0 = Date.now();
    const timer = setTimeout(() => ac.abort(), 10);
    let abortedCleanly = false;
    try {
      await tools.memory_search.execute({ query: "keyword" }, { abort: ac.signal });
    } catch (e) {
      const elapsed = Date.now() - t0;
      const msg = String(e && e.message || e);
      if (e.name === "AbortError" || /aborted|取消/i.test(msg)) {
        abortedCleanly = true;
        console.log(`  ✓ 异步中断成功，耗时 ${elapsed}ms，捕获: [${e.name}] ${msg}`);
      } else {
        console.error(`  ✗ 未按预期中断: ${msg}`);
      }
    } finally {
      clearTimeout(timer);
    }
    assert(abortedCleanly, "异步 abort 必须在数毫秒内干净中断 fetch 退出");
  }

  console.log("\n✅ 全部 ctx.abort 验证项测试通过！");
}

runTest().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
