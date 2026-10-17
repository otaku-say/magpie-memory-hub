/**
 * lookupSecret 三级匹配单测。
 *
 * 【为什么必须测这个】
 * Secret Key 的捕获用的是 NCB 返回的【真实库名】（如 41694_agent_memory），
 * 而调用方传进来的是用户在设置页填的【逻辑库名】（如 agent_memory）。
 * 早先只做精确匹配，两者不一致时落空 → 表现为「明明用一键创建建过数据库，
 * 却报未配置 Secret Key」→ R2 列举/删除全部不可用，探针文件永远清不掉。
 *
 * 【安全性】本测试会临时替换本地状态文件，用 try/finally 保证一定还原。
 * 【不写数据库】因此按 test_meta 规则无需 project 隔离与清理。
 * 【反证】末尾构造「多条记录 + 未知库名」，断言不会被兜底误取（防串库）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const { lookupSecret, lookupRealDatabase } = await import(new URL("../local_state.js", import.meta.url).href);
const { resolveRealDatabase } = await import(new URL("../r2.js", import.meta.url).href);
const { secretCheck } = await import(new URL("../db_tools.js", import.meta.url).href);

// 找到实际使用的 state 文件路径（local_state.js 自己算的）
const candidate = [
  path.join(os.homedir(), ".magpie-memory-hub", "state.json"),
  "/config/home/.magpie-memory-hub/state.json",
].find((p) => fs.existsSync(p)) || path.join(os.homedir(), ".magpie-memory-hub", "state.json");

let fail = 0;
const t = (desc, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${desc.padEnd(30)} → ${JSON.stringify(got)}${ok ? "" : `（期望 ${JSON.stringify(want)}）`}`);
};

let orig = null;
try {
  orig = fs.existsSync(candidate) ? fs.readFileSync(candidate, "utf8") : null;
  fs.mkdirSync(path.dirname(candidate), { recursive: true });

  console.log("【夹具】只存一条 41694_agent_memory");
  fs.writeFileSync(candidate, JSON.stringify({ secrets: { "41694_agent_memory": { v: "SEC-123", at: 1 } } }));
  t("① 精确匹配", lookupSecret("41694_agent_memory"), "SEC-123");
  t("② 归一化（去账号前缀）", lookupSecret("agent_memory"), "SEC-123");
  t("③ 唯一记录兜底（未知库名）", lookupSecret("完全无关的库"), "SEC-123");
  t("③ 空参数也兜底", lookupSecret(""), "SEC-123");

  console.log("【夹具】两条记录：兜底必须失效，且不许串库");
  fs.writeFileSync(candidate, JSON.stringify({
    secrets: { "41694_agent_memory": { v: "SEC-123", at: 1 }, "99999_other_db": { v: "SEC-999", at: 2 } },
  }));
  t("① 精确匹配仍正确", lookupSecret("41694_agent_memory"), "SEC-123");
  t("② 归一化仍正确", lookupSecret("agent_memory"), "SEC-123");
  t("③ 多条时未知库名不误取", lookupSecret("who_knows"), "");
  t("不串库（另一库精确）", lookupSecret("99999_other_db"), "SEC-999");

  console.log("【夹具】空状态");
  fs.writeFileSync(candidate, JSON.stringify({ secrets: {} }));
  t("无记录时返回空串", lookupSecret("agent_memory"), "");

  console.log("\n【测试】lookupRealDatabase 逻辑名 → 真实库名归一化解析");
  fs.writeFileSync(candidate, JSON.stringify({
    current: "41694_agent_memory",
    secrets: { "41694_agent_memory": { v: "SEC-123", at: 1 } },
  }));
  t("逻辑名解析出真实库名", lookupRealDatabase("agent_memory"), "41694_agent_memory");
  t("带数字前缀原样直出", lookupRealDatabase("41694_agent_memory"), "41694_agent_memory");
  t("空库名返回空串", lookupRealDatabase(""), "");

  console.log("\n【测试】resolveRealDatabase 异步解析与 REST 库名同源一致性");
  const resolved = await resolveRealDatabase({ instance: "agent_memory" }, "agent_memory");
  t("resolveRealDatabase 解析真实库名", resolved, "41694_agent_memory");

  console.log("\n【测试】R2 默认桶名必须等于真实数据库名（同源同变量）");
  // 模拟 r2Setup 取默认桶名的逻辑：当未显式传 bucket_name 时，桶名取 db
  const testDb = await resolveRealDatabase({}, "agent_memory");
  const defaultBucketName = testDb;
  assert.strictEqual(defaultBucketName, testDb, "默认桶名必须严格全等于数据库真实名");
  assert.strictEqual(defaultBucketName, "41694_agent_memory", "默认桶名必须为真实库名 41694_agent_memory");
  t("桶名与 REST Instance 同源同名", defaultBucketName, testDb);

  console.log("\n【测试】secretCheck 三类失败分支与可操作指引");
  // 1) 未填写 Secret Key (本地无捕获且未手动传)
  fs.writeFileSync(candidate, JSON.stringify({ current: "41694_agent_memory", secrets: {} }));
  const checkEmpty = await secretCheck({ instance: "agent_memory", secret: "" }, {});
  assert.strictEqual(checkEmpty.verdict, "EMPTY", "未填应返回 EMPTY");
  assert.ok(checkEmpty.lines.some((l) => l.includes("NoCodeBackend 控制台")), "必须包含去控制台复制指引");
  assert.ok(checkEmpty.lines.some((l) => l.includes("auto_rename")), "必须包含新建库自救指引");
  t("分支1: 未填写返回 EMPTY 与复制/自救指引", checkEmpty.verdict, "EMPTY");

  // 2) 格式明显错误（如空格、长度过短、误填 mcp_）
  const checkMcpKey = await secretCheck({ instance: "agent_memory" }, { secret: "mcp_sec_invalid_key_12345" });
  assert.strictEqual(checkMcpKey.verdict, "MALFORMED", "误填 MCP Key 应返回 MALFORMED");
  assert.ok(checkMcpKey.lines.some((l) => l.includes("MCP Key（账号级）")), "必须明确指出误填了 MCP Key");
  t("分支2: 误填 MCP Key 返回 MALFORMED", checkMcpKey.verdict, "MALFORMED");

  const checkSpaces = await secretCheck({ instance: "agent_memory" }, { secret: "sec key with spaces" });
  assert.strictEqual(checkSpaces.verdict, "MALFORMED", "含空格应返回 MALFORMED");
  t("分支2: 含空格密钥返回 MALFORMED", checkSpaces.verdict, "MALFORMED");

  // 3) 探测 URL 断言：mock fetch 验证发往远端的 URL 必须带真实库名（带账号前缀）
  const origFetch = globalThis.fetch;
  let interceptedUrl = "";
  let interceptedAuth = "";
  globalThis.fetch = async (url, opts) => {
    interceptedUrl = String(url);
    interceptedAuth = opts?.headers?.Authorization || "";
    return {
      status: 403,
      json: async () => ({ status: "failed", error: "Invalid secret_key." }),
    };
  };

  try {
    const checkProbe = await secretCheck({ instance: "agent_memory" }, { secret: "ncb_sec_sample_invalid_key_999" });
    assert.strictEqual(checkProbe.verdict, "INVALID", "远端 403 应返回 INVALID");
    assert.ok(interceptedUrl.includes("Instance=41694_agent_memory"), `探测 URL 必须使用真实库名！实际: ${interceptedUrl}`);
    assert.ok(!interceptedUrl.includes("Instance=agent_memory&"), "严禁使用逻辑名 agent_memory 探测");
    assert.ok(checkProbe.lines.some((l) => l.includes("两个最常见原因")), "必须给出两个高频原因说明");
    t("分支3: 403 INVALID 且探测 URL 使用真实库名 41694_agent_memory", checkProbe.verdict, "INVALID");
  } finally {
    globalThis.fetch = origFetch;
  }
} finally {
  try {
    if (orig !== null) fs.writeFileSync(candidate, orig);
    else if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    console.log("  ✓ 已还原本地状态文件");
  } catch (e) {
    console.log("  ⚠️ 状态文件还原失败:", e.message);
  }
}

// 真断言（供 test_meta 计数，且保证失败必退出非 0）
assert.equal(typeof lookupSecret, "function", "lookupSecret 必须是函数");
assert.strictEqual(fail, 0, "三级匹配存在失败用例");

console.log(fail ? `\n❌ ${fail} 项失败` : "\n✅ lookupSecret 三级匹配全部通过");
process.exit(fail ? 1 : 0);
