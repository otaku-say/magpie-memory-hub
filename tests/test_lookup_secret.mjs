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

const { lookupSecret } = await import(new URL("../local_state.js", import.meta.url).href);

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
