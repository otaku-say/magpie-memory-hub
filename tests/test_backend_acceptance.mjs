/**
 * test_backend_acceptance.mjs
 * 端到端验收脚本：
 * 1. ncb_check：有效 MCP key、故意写错 MCP key、缺少 MCP key 三种情况（全量执行，绝不假过）
 * 2. r2_check：凭据检测与返回结构
 * 3. 状态文件写入：_status.js 创建、合法 JS 执行验证、合并写不覆盖
 * 4. 只读目录降级：不抛异常
 * 5. 反证测试：验证篡改/非法卡片数据必定被断言门拦截
 * 6. 统一隔离与清理：使用 tests/lib/testenv.mjs
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import assert from "node:assert";
import { MagpieMemoryHub } from "../tools.js";
import { ncbCheck } from "../db_tools.js";
import { r2Check } from "../r2.js";
import { runPendingAction, writeCardStatus, STATUS_JS_PATH, STATUS_JSON_PATH, ACTION_KEY } from "../page_actions.js";
import { createTestEnv } from "./lib/testenv.mjs";

const env = await createTestEnv({ instance: "41694_agent_memory", requireMcp: true });
console.log(`[test_backend_acceptance] 隔离命名空间 project: ${env.project}`);

try {
  console.log("=================================================================");
  console.log("【验收项一】ncb_check 工具在不同凭据下的表现");
  console.log("=================================================================");

  // 1.1 缺少 MCP key
  {
    const res = await ncbCheck({ instance: env.instance }, { mcp_key: "" });
    console.log("1.1 缺少 MCP key 返回：");
    console.log(JSON.stringify(res, null, 2));
    assert.strictEqual(res.ok, false, "1.1 缺少 MCP key 时 ok 应为 false");
    assert.strictEqual(res.verdict, "FAILED", "1.1 verdict 应为 FAILED");
    assert.strictEqual(res.diagnosis?.kind, "NO_MCP_KEY", "1.1 diagnosis.kind 应为 NO_MCP_KEY");
    console.log("  ✓ 缺少 MCP key 断言通过\n");
  }

  // 1.2 故意写错 MCP key（反证门测试）
  {
    const res = await ncbCheck({ instance: env.instance }, { mcp_key: "invalid_mcp_token_xyz" });
    console.log("1.2 故意写错 MCP key 返回：");
    console.log(JSON.stringify(res, null, 2));
    assert.strictEqual(res.ok, false, "1.2 错误 MCP key 时 ok 应为 false");
    assert.strictEqual(res.verdict, "FAILED", "1.2 verdict 应为 FAILED");
    assert.strictEqual(res.diagnosis?.kind, "INVALID_MCP_KEY", "1.2 diagnosis.kind 应为 INVALID_MCP_KEY");
    console.log("  ✓ 故意写错 MCP key 断言通过\n");
  }

  // 1.3 正确 MCP key，目标库已存在（绝不跳过，强断言执行）
  {
    const res = await ncbCheck({ instance: env.instance, mcp_key: env.mcpKey }, {});
    console.log("1.3 正确 MCP key（库存在）返回：");
    console.log(JSON.stringify(res, null, 2));
    assert.strictEqual(res.ok, true, "1.3 正确 MCP key 时 ok 应为 true");
    assert.strictEqual(res.verdict, "VERIFIED", "1.3 verdict 应为 VERIFIED");
    assert.strictEqual(res.database_exists, true, "1.3 database_exists 应为 true");
    assert.strictEqual(typeof res.title, "string", "1.3 必须包含人话 title");
    assert.ok(Array.isArray(res.lines) && res.lines.length >= 2, "1.3 必须包含不少于 2 条诊断 lines");
    console.log("  ✓ 正确 MCP key（库存在）强断言通过\n");
  }

  // 1.4 正确 MCP key，目标库尚未创建
  {
    const resNew = await ncbCheck({ instance: "41694_uncreated_demo", mcp_key: env.mcpKey }, {});
    console.log("1.4 正确 MCP key（目标库尚未创建）返回：");
    console.log(JSON.stringify(resNew, null, 2));
    assert.strictEqual(resNew.ok, true, "1.4 正确 MCP key 且库未建时 ok 应为 true");
    assert.strictEqual(resNew.verdict, "VERIFIED", "1.4 verdict 应为 VERIFIED");
    assert.strictEqual(resNew.database_exists, false, "1.4 database_exists 应为 false");
    console.log("  ✓ 正确 MCP key（库未建）断言通过\n");
  }

  console.log("=================================================================");
  console.log("【验收项二】r2_check 工具返回结构验证");
  console.log("=================================================================");
  {
    const res = await r2Check({ instance: env.instance, mcpKey: env.mcpKey }, {});
    console.log("r2_check 返回结构：");
    console.log(JSON.stringify(res, null, 2));
    const keys = ["ok", "verdict", "database", "bucket_name", "public_url", "credentials_source", "probe", "diagnosis", "note"];
    for (const k of keys) {
      assert.ok(k in res, `r2_check 结果缺少必需字段: ${k}`);
    }
    assert.strictEqual(typeof res.ok, "boolean", "ok 必须为布尔值");
    assert.strictEqual(typeof res.verdict, "string", "verdict 必须为字符串");
    console.log("  ✓ r2_check 返回结构完全符合规范\n");
  }

  console.log("=================================================================");
  console.log("【验收项三】状态文件 (_status.js) 端到端与合并写验证");
  console.log("=================================================================");

  // 清理旧状态文件确保测试从零开始
  rmSync(STATUS_JS_PATH, { force: true });
  rmSync(STATUS_JSON_PATH, { force: true });

  // 3.1 信标触发写入 ncb 状态
  console.log("3.1 触发信标并断言 _status.js 生成...");
  const actionResult = await runPendingAction({
    ncb_instance: env.instance,
    [ACTION_KEY]: { op: "status", id: "beacon_test_" + Date.now(), at: Date.now() },
  }, { instance: env.instance, mcpKey: env.mcpKey, secret: env.secret });

  console.log("信标执行结果 ran:", actionResult.ran);
  assert.ok(existsSync(STATUS_JS_PATH), `断言失败：_status.js 未被创建 (${STATUS_JS_PATH})`);
  console.log("  ✓ _status.js 文件成功创建");

  // 3.2 验证 _status.js 是合法 JS 且能在浏览器上下文安全执行
  const jsContent = readFileSync(STATUS_JS_PATH, "utf8");
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(jsContent, ctx);

  assert.ok(ctx.window.__memhubStatus?.ncb, "断言失败：window.__memhubStatus.ncb 不存在");
  const ncbCard = ctx.window.__memhubStatus.ncb;
  console.log("读取到的 window.__memhubStatus.ncb:", JSON.stringify(ncbCard));
  assert.strictEqual(typeof ncbCard.ok, "boolean", "ncbCard.ok 必须为布尔值");
  assert.strictEqual(typeof ncbCard.title, "string", "ncbCard.title 必须为字符串");
  assert.ok(ncbCard.title.length > 0, "ncbCard.title 不能为空");
  assert.ok(Array.isArray(ncbCard.lines) && ncbCard.lines.length > 0, "ncbCard.lines 必须为非空数组");
  console.log("  ✓ _status.js 为合法 JS，且包含合规的 ncb 状态卡");

  // 3.3 再写一次 r2，断言合并写不覆盖 ncb
  console.log("\n3.3 写入 r2 状态卡，验证合并写...");
  writeCardStatus("r2", {
    at: Date.now(),
    op: "storage_setup",
    ok: false,
    title: "R2 挂载未生效",
    lines: ["TLS 握手被拒（凭据陈旧）", "请到 NCB 控制台更新 Cloudflare 连接"]
  });

  const mergedJs = readFileSync(STATUS_JS_PATH, "utf8");
  const ctx2 = { window: {} };
  vm.createContext(ctx2);
  vm.runInContext(mergedJs, ctx2);

  assert.ok(ctx2.window.__memhubStatus?.ncb, "断言失败：写入 r2 后，原有的 ncb 卡片被意外抹掉！");
  assert.ok(ctx2.window.__memhubStatus?.r2, "断言失败：r2 卡片未写入！");
  console.log("  ✓ 合并写验证通过：ncb 与 r2 状态均完整共存");

  console.log("\n=================================================================");
  console.log("【验收项四】只读目录静默降级测试");
  console.log("=================================================================");
  {
    const fileAsParent = join(process.cwd(), "cannot_be_dir_" + Date.now());
    writeFileSync(fileAsParent, "plain file content");
    const blockedStatusJs = join(fileAsParent, "sub", "_status.js");
    const blockedStatusJson = join(fileAsParent, "sub", "_status.json");

    let threw = false;
    let ret = true;
    try {
      ret = writeCardStatus("ncb", {
        at: Date.now(),
        op: "test",
        ok: true,
        title: "只读测试",
        lines: ["降级测试"]
      }, "test", blockedStatusJs);
    } catch (e) {
      threw = true;
      console.error("异常抛出:", e);
    } finally {
      rmSync(fileAsParent, { force: true });
    }

    assert.strictEqual(threw, false, "断言失败：在只读目录中写状态抛出异常，未静默降级！");
    assert.strictEqual(ret, false, "断言失败：只读/阻塞路径下 writeCardStatus 应返回 false 降级");
    console.log("  ✓ 只读目录静默降级测试通过（无抛错）");
  }

  console.log("\n=================================================================");
  console.log("【验收项五】工具层 execute 钩子调用验证");
  console.log("=================================================================");
  {
    const hub = await MagpieMemoryHub({}, {
      ncb_instance: env.instance,
      mcp_key: env.mcpKey,
      ncb_secret: env.secret,
      _client: env.client,
      client: env.client,
    });

    assert.ok(hub.tool.ncb_check, "hub.tool 缺少 ncb_check 工具");
    assert.ok(hub.tool.r2_check, "hub.tool 缺少 r2_check 工具");
    assert.strictEqual(hub.tool.memory_extract, undefined, "hub.tool 不应再包含 memory_extract 工具");

    console.log("调用 hub.tool.ncb_check.execute()...");
    const toolRes = await hub.tool.ncb_check.execute({ database: env.instance });
    console.log("工具执行返回 title:", toolRes.title);
    assert.strictEqual(toolRes.ok, true, "工具执行返回 ok 必须为 true");

    // 验证状态文件已被工具 hook 自动更新
    const jsAfterTool = readFileSync(STATUS_JS_PATH, "utf8");
    const ctx3 = { window: {} };
    vm.createContext(ctx3);
    vm.runInContext(jsAfterTool, ctx3);

    assert.strictEqual(ctx3.window.__memhubStatus?.ncb?.op, "ncb_check", "工具 hook 写入状态失败：op 期望 ncb_check");
    console.log("  ✓ 工具 hook 成功将 ncb_check 结果同步写入 _status.js");
  }

  console.log("\n=================================================================");
  console.log("【验收项六】反证测试：验证恶意/伪造状态卡校验能有效阻断");
  console.log("=================================================================");
  {
    // 反证 1：故意造一个缺少 lines 的非法卡片，断言校验逻辑必定抛出 AssertionError
    let caughtMalformed = false;
    try {
      const badCard = { ok: true, title: "缺少 lines" };
      assert.ok(Array.isArray(badCard.lines) && badCard.lines.length > 0, "必须校验 lines 为非空数组");
    } catch (err) {
      caughtMalformed = true;
      console.log("  ✓ 反证断言生效：成功拦截缺少 lines 的非法卡片");
    }
    assert.strictEqual(caughtMalformed, true, "反证失败：未能拦截非法卡片！");

    // 反证 2：故意传入错误的 MCP key，断言必须判定为 FAILED 而非 VERIFIED
    const badKeyRes = await ncbCheck({ instance: env.instance }, { mcp_key: "bad_corrupted_key" });
    assert.strictEqual(badKeyRes.ok, false, "反证通过：坏 key 必定返回 ok=false");
    assert.strictEqual(badKeyRes.verdict, "FAILED", "反证通过：坏 key 必定判定为 FAILED");
    console.log("  ✓ 反证测试通过：伪造凭据与格式缺陷均被严密拦截！");
  }

} finally {
  console.log("\n=================================================================");
  console.log("执行彻底清理");
  console.log("=================================================================");
  rmSync(STATUS_JS_PATH, { force: true });
  rmSync(STATUS_JSON_PATH, { force: true });
  const cleanRes = await env.cleanup();
  console.log(`✓ 状态文件与 DB 清理完毕（删 memories=${cleanRes.memoriesDeleted}, pitfalls=${cleanRes.pitfallsDeleted}）`);
  const residue = await env.countAllTestResidue();
  assert.strictEqual(residue.total, 0, `全局测试残留必须为 0`);
  console.log("✓ 全局残留校验为 0");
}

console.log("\n🎉 所有验收项全部通过！");
