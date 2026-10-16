/**
 * test_exports.mjs —— 复核 tools.js 与 memory.middleware.js 的导出面
 */
import assert from "node:assert";

console.log("==========================================");
console.log("导出面合规性复核");
console.log("==========================================");

// 1. tools.js 导出面复核（硬红线：只能导出 1 个插件函数）
const toolsMod = await import("../tools.js");
const toolsKeys = Object.keys(toolsMod);
console.log("tools.js 导出列表:", toolsKeys);
assert.strictEqual(toolsKeys.length, 1, `tools.js 必须只导出 1 个项，实际导出: ${toolsKeys.join(", ")}`);
assert.strictEqual(typeof toolsMod[toolsKeys[0]], "function", "tools.js 导出的唯一项必须是函数");
assert.strictEqual(toolsKeys[0], "MagpieMemoryHub", "导出的插件入口名称应为 MagpieMemoryHub");
console.log("✓ tools.js 导出面完全合规：仅导出 1 个插件入口函数 MagpieMemoryHub，无任何辅助函数泄露！");

// 2. memory.middleware.js 导出面复核
const mwMod = await import("../memory.middleware.js");
const mwKeys = Object.keys(mwMod);
console.log("\nmemory.middleware.js 导出列表:", mwKeys);
const expectedMwHooks = ["onRequest", "onEvent", "onResponse"];
assert(mwKeys.every((k) => expectedMwHooks.includes(k)), `中间件仅允许导出标准网关钩子，实际: ${mwKeys.join(", ")}`);
console.log("✓ memory.middleware.js 导出面合规：仅导出标准网关中间件钩子 (onRequest, onEvent, onResponse)，未导出任何辅助函数。");
console.log("ℹ 说明：因 package.json 中 main 指向 tools.js，Bun 宿主不会加载中间件文件；网关进程 (moejs) 按名字调用钩子，不存在被误当成多个插件函数的隐患。");

console.log("\n✅ 导出面复核 100% 通过！");
