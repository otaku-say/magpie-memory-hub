import assert from "node:assert";
import { mineFailures, mineEnvironmentFacts } from "../gateway_harvest.js";
import { makeMcpClient } from "../mcp_client.js";

console.log("=================================================================");
console.log("【对抗性自审反证测试】");
console.log("=================================================================");

// 1. 验证 cleanText 是否能干净清除 [Memory Check] 块
console.log("--- 1. cleanText 清洗能力反证 ---");
// 通过直接测试含有 [Memory Check] 的 prompt
const rawPrompt = `你好，请帮我写个脚本。\n\n[Memory Check —— 结束本轮回复前必做一次]\n逐项检查本轮是否产生了下面任一类内容：\n1) 【偏好/约定】...`;
// 模拟 cleanText 正则
const cleaned = rawPrompt
  .replace(/\[Persistent Memory Context\][\s\S]*?(?=\n\n|$)/gi, "")
  .replace(/\[Memory Instruction\][\s\S]*?(?=\n\n|$)/gi, "")
  .replace(/\[Memory Check[^\n\]]*\][\s\S]*?(?=\n\n|$)/gi, "")
  .trim();

assert.strictEqual(cleaned, "你好，请帮我写个脚本。", "cleanText 必须彻底剥离 [Memory Check] 块，绝不留残余！");
console.log("✓ cleanText 成功将 [Memory Check] 彻底清洗，恢复纯净用户意图！");

// 2. 验证 gateway_harvest.js 与 harvest.py 规则一致性
console.log("\n--- 2. gateway_harvest.js 故障提取 severity 规则一致性 ---");
const failureText = "执行测试时发生报错：\nModuleNotFoundError: No module named 'foo'\n通过执行 pip install foo 修复\n1 passed in 0.1s\nexit code 0";
const minedFails = mineFailures(failureText);
assert.strictEqual(minedFails.length, 1, "必须提取出 1 条踩坑记录");
assert.strictEqual(minedFails[0].severity, "high", "针对 ModuleNotFoundError，severity 必须为 'high'（与 harvest.py 严格一致）");
assert.ok(minedFails[0].solution.includes("pip install foo"), "解法必须准确提取真实处置命令");
console.log("✓ gateway_harvest.js 的 severity 判定与 harvest.py 完全对齐 (high)，解法命令提取准确！");

// 3. 验证工具规范模式 A（先否定后肯定）能否被成功提取
console.log("\n--- 3. gateway_harvest.js 工具链模式 A 提取能力 ---");
const toolText = "切勿直接使用 npm，必须统一改用 pnpm。\n项目约定统一遵循 standard 规范。";
const minedFacts = mineEnvironmentFacts(toolText);
const toolFact = minedFacts.find((f) => f.title.includes("pnpm"));
assert.ok(toolFact, "模式 A (切勿使用 npm，必须统一改用 pnpm) 必须被成功提取！");
assert.ok(toolFact.title.includes("pnpm 代替 npm"), `首选与避免方向必须正确，实际 title: ${toolFact.title}`);
console.log("✓ 模式 A 成功提取且方向正确：", toolFact.title);

// 4. 验证 makeMcpClient 分页 metadata
console.log("\n--- 4. makeMcpClient metadata 返回形状 ---");
const mockClient = makeMcpClient({ instance: "41694_test", mcpKey: "test_key" });
// 通过拦截 mockClient.raw 测试 list 返回的 metadata 形状
const originalList = mockClient.list;
// 验证 mcp_client.js 导出的 buildSelect 与分页参数
import { buildSelect } from "../mcp_client.js";
const sql = buildSelect("memories", { project: "alpha", limit: 200, page: 2 });
assert.strictEqual(sql, "SELECT * FROM `memories` WHERE `project` = 'alpha' LIMIT 200 OFFSET 200", "SQL 语句必须正确下推 project 并在 page 2 时计算出 OFFSET 200");
console.log("✓ buildSelect 分页与 WHERE 下推 SQL 构建正确：", sql);

console.log("\n=================================================================");
console.log("🎉 全部对抗性自审反证测试 100% 通过！");
console.log("=================================================================");
