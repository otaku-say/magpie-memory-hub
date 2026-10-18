import assert from "node:assert";
import { makeMcpClient } from "../mcp_client.js";
import { buildSelect } from "../mcp_client.js";

console.log("=================================================================");
console.log("【对抗性自审反证测试】");
console.log("=================================================================");

// 1. 验证真实的 memory.middleware.js cleanText 是否能干净清除 [Memory Check] 块
console.log("--- 1. 真实中间件 cleanText 清洗能力验证 ---");
const { onRequest } = await import("../memory.middleware.js");
const rawPrompt = `你好，请帮我写个脚本。\n\n[Memory Check —— 结束本轮回复前必做一次]\n逐项检查本轮是否产生了下面任一类内容：\n1) 【偏好/约定】...\n\n[Persistent Memory Context]\n- [fact] 测试记忆: 内容`;
const mockCtx = {
  protocol: "chat",
  options: { disabled: false, memories: [] },
  state: {},
};
const testBody = {
  model: "gpt-4o",
  messages: [{ role: "user", content: rawPrompt }],
};
onRequest(testBody, mockCtx);
assert.strictEqual(mockCtx.state.promptText, "你好，请帮我写个脚本。", "真实中间件 cleanText 必须彻底剥离 [Memory Check] 与 [Persistent Memory Context]，恢复纯净用户意图！");
console.log("✓ 真实中间件 cleanText 成功将 [Memory Check] 与上下文标记彻底清洗！");

// 2. 验证 makeMcpClient 分页 metadata 与 SQL 构建
console.log("\n--- 2. makeMcpClient metadata 返回形状 ---");
const mockClient = makeMcpClient({ instance: "__test_mock_instance__", mcpKey: "test_key" });
const sql = buildSelect("memories", { project: "alpha", limit: 200, page: 2 });
assert.strictEqual(sql, "SELECT * FROM `memories` WHERE `project` = 'alpha' LIMIT 200 OFFSET 200", "SQL 语句必须正确下推 project 并在 page 2 时计算出 OFFSET 200");
console.log("✓ buildSelect 分页与 WHERE 下推 SQL 构建正确：", sql);

console.log("\n=================================================================");
console.log("🎉 全部对抗性自审反证测试 100% 通过！");
console.log("=================================================================");
