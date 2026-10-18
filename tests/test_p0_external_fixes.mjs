/**
 * test_p0_external_fixes.mjs —— P0 三大核心缺陷验证
 * 1. #2: 不传 compress 时历史消息逐字节未改（保 KV-Cache 铁律）
 * 2. #3: local_state.js lookupR2Mount target 变量作用域修复，不再抛 ReferenceError
 * 3. #5: harvest_gateway 信标完整注册与执行验证
 */
import assert from "node:assert";
import { onRequest } from "../memory.middleware.js";
import { lookupR2Mount, rememberR2Mount, forgetR2Mount } from "../local_state.js";
import { OPS, executeAction, readAction } from "../page_actions.js";
import { createTestEnv } from "./lib/testenv.mjs";

console.log("=================================================================");
console.log("【测试开始】外部清单 P0 核心缺陷整改验证 (test_p0_external_fixes.mjs)");
console.log("=================================================================\n");

// -------------------------------------------------------------
// P0 - #2: 不传 compress 时历史消息逐字节未改（保 KV-Cache）
// -------------------------------------------------------------
console.log("▶ [P0 - #2] 验证不传 compress 时历史消息逐字节未改 (保 KV-Cache)...");
{
  const toolOutput = "2026-10-18 12:00:00 [DEBUG] sync step 1 finished\n".repeat(100);
  const userHistory = "请检查前几步的日志输出是否正常。\n".repeat(50);
  
  const body = {
    model: "test-llm",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: userHistory },
      { role: "assistant", content: "好的，我来调用工具查看日志。" },
      { role: "tool", content: toolOutput },
      { role: "user", content: "现在请给出分析结果。" }
    ]
  };

  const origHistoryJson = JSON.stringify(body.messages.slice(0, 4));

  // 不传 compress 选项（options = {}）
  const ctx = {
    options: { memories: [] },
    state: {}
  };

  onRequest(body, ctx);

  const processedHistoryJson = JSON.stringify(body.messages.slice(0, 4));
  assert.strictEqual(
    processedHistoryJson,
    origHistoryJson,
    "核心铁律违背！未传 compress 时，历史前缀消息被改写，KV-Cache 被击穿！"
  );
  console.log("  ✓ 核心铁律验证通过：未传 compress 时历史消息 [0..3] 逐字节完全一致，KV-Cache 100% 保全");
}

// -------------------------------------------------------------
// P0 - #3: lookupR2Mount target 变量作用域与跨库隔离验证
// -------------------------------------------------------------
console.log("\n▶ [P0 - #3] 验证 lookupR2Mount 跨库查询不再抛 ReferenceError 且不串扰...");
{
  const stBackup = (await import("../local_state.js")).readState();
  const origMounts = stBackup.r2_mounts || {};
  const writeState = (await import("../local_state.js")).writeState;
  writeState({ ...stBackup, r2_mounts: {} });

  rememberR2Mount("41694_db_alpha", {
    bucket: "bucket-alpha",
    public_url: "https://alpha.example.com",
    at: Date.now()
  });

  try {
    // 单条记录存在时，查询不同库名
    let hit = null;
    assert.doesNotThrow(() => {
      hit = lookupR2Mount("41694_db_beta");
    }, "查询未绑定的 db_beta 不得抛出 ReferenceError");
    assert.strictEqual(hit, null, "查询不同库名时不应兜底返回 db_alpha 的挂载记录");

    // 查询同源库名（忽略前缀与大小写）
    const hitAlpha = lookupR2Mount("db_alpha");
    assert.ok(hitAlpha, "归一化查询同一库名应成功命中");
    assert.strictEqual(hitAlpha.bucket, "bucket-alpha");

    // 不传库名时唯一记录兜底
    const hitEmpty = lookupR2Mount("");
    assert.ok(hitEmpty, "未指定库名时单记录兜底生效");
    assert.strictEqual(hitEmpty.bucket, "bucket-alpha");
    console.log("  ✓ 作用域与跨库隔离验证通过：不抛 ReferenceError，跨库安全隔离");
  } finally {
    forgetR2Mount("41694_db_alpha");
    writeState({ ...(await import("../local_state.js")).readState(), r2_mounts: origMounts });
  }
}

// -------------------------------------------------------------
// P0 - #5: harvest_gateway 信标补齐注册与执行验证
// -------------------------------------------------------------
console.log("\n▶ [P0 - #5] 验证 harvest_gateway 信标在 OPS 注册并可执行...");
{
  assert.ok(OPS.harvest_gateway, "harvest_gateway 必须在 OPS 中合法注册");
  const action = readAction({ _action: { op: "harvest_gateway", id: "act-gw-1", at: Date.now() } });
  assert.ok(action, "readAction 必须识别 harvest_gateway 信标");

  const env = await createTestEnv({ instance: "41694_agent_memory" });
  try {
    const res = await executeAction(
      action,
      { options: { dir: "/tmp", extract_model: "" }, client: env.client },
      env.instance
    );
    assert.strictEqual(res.ran, true, "executeAction 必须执行 harvest_gateway");
    assert.ok(res.result, "harvest_gateway 执行结果对象存在");
    assert.strictEqual(res.result.op, "harvest_gateway");
    console.log("  ✓ 信标注册与执行验证通过：harvest_gateway 正式入驻并可受控调用");
  } finally {
    await env.cleanup();
  }
}

console.log("\n=================================================================");
console.log("✅ 全部 P0 验证测试 100% 通过！");
console.log("=================================================================");
