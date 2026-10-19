/**
 * test_exports.mjs —— 复核 tools.js 与 memory.middleware.js 的导出面
 */
import assert from "node:assert";

console.log("==========================================");
console.log("导出面合规性复核");
console.log("==========================================");

// 1. tools.js 导出面复核（主插件入口必须为 MagpieMemoryHub，其它仅允许白名单辅助工具函数）
const toolsMod = await import("../tools.js");
const toolsKeys = Object.keys(toolsMod);
console.log("tools.js 导出列表:", toolsKeys);
assert.strictEqual(typeof toolsMod.MagpieMemoryHub, "function", "tools.js 导出的主入口必须是函数");
const ALLOWED_EXPORTS = new Set(["MagpieMemoryHub", "makeClient", "memoryAudit", "getDedupTimeWindow", "isDedupDue", "memoryAuditUndo", "termsOf", "CJK_STOP_BIGRAMS", "fetchAll"]);
for (const k of toolsKeys) {
  assert(ALLOWED_EXPORTS.has(k), `未授权的导出项: ${k}`);
}
assert(toolsKeys.includes("MagpieMemoryHub"), "必须导出 MagpieMemoryHub");
assert(toolsKeys.includes("makeClient"), "必须导出 makeClient");
console.log("✓ tools.js 导出面完全合规：主插件入口 MagpieMemoryHub 与白名单辅助函数对齐，无非授权函数泄露！");

// 2. memory.middleware.js 导出面复核
const mwMod = await import("../memory.middleware.js");
const mwKeys = Object.keys(mwMod);
console.log("\nmemory.middleware.js 导出列表:", mwKeys);
const expectedMwHooks = ["onRequest", "onEvent", "onResponse"];
assert(mwKeys.every((k) => expectedMwHooks.includes(k)), `中间件仅允许导出标准网关钩子，实际: ${mwKeys.join(", ")}`);
console.log("✓ memory.middleware.js 导出面合规：仅导出标准网关中间件钩子 (onRequest, onEvent, onResponse)，未导出任何辅助函数。");
console.log("ℹ 说明：因 package.json 中 main 指向 tools.js，Bun 宿主不会加载中间件文件；网关进程 (moejs) 按名字调用钩子，不存在被误当成多个插件函数的隐患。");

console.log("\n✅ 导出面复核 100% 通过！");
