import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import { modelDir, isInsidePluginDir, checkLocalModel, PLUGIN_ROOT } from "../model_check.js";

console.log("=== 1. 默认路径持久化断言 ===");
delete process.env.MEMHUB_MODEL_DIR;
const defaultDir = modelDir();
console.log("默认 modelDir():", defaultDir);
console.log("插件根目录 PLUGIN_ROOT:", PLUGIN_ROOT);

assert.ok(defaultDir, "modelDir() 必须有非空返回值");
assert.strictEqual(isInsidePluginDir(defaultDir), false, "默认 modelDir() 绝不能在插件目录内");
const expectedPrefix = path.join(os.homedir(), ".magpie-memory-hub", "models");
assert.ok(defaultDir.startsWith(expectedPrefix), `默认路径必须位于 ${expectedPrefix} 持久卷内`);
console.log("PASS: 默认路径严格位于持久卷内，绝不在插件目录内！\n");

console.log("=== 2. 环境变量覆盖与持久性自查告警测试 ===");
// 故意将环境变量设在插件目录内
const insidePath = path.join(PLUGIN_ROOT, "models", "test-model");
process.env.MEMHUB_MODEL_DIR = insidePath;
console.log("手动设置 MEMHUB_MODEL_DIR =", insidePath);
assert.strictEqual(modelDir(), insidePath);
assert.strictEqual(isInsidePluginDir(insidePath), true, "isInsidePluginDir 必须识别出落在插件目录内");

const checkInside = await checkLocalModel();
console.log("检测结果 lines:");
checkInside.lines.forEach(l => console.log("  -", l));

assert.strictEqual(checkInside.inside_plugin_dir, true, "checkInside 必须标记 inside_plugin_dir=true");
const hasWarnLine = checkInside.lines.some(l => l.includes("持久性警告") || l.includes("插件目录内") || l.includes("覆盖删除"));
assert.ok(hasWarnLine, "检测结果 lines 中必须明确包含持久性警告提示");
console.log("PASS: 错误配置到插件目录时，自查检测成功输出严重警告！\n");

// 恢复正常环境变量测试
const outsidePath = path.join(os.homedir(), "custom_volume", "my-model");
process.env.MEMHUB_MODEL_DIR = outsidePath;
assert.strictEqual(isInsidePluginDir(outsidePath), false);
const checkOutside = await checkLocalModel();
assert.strictEqual(checkOutside.inside_plugin_dir, false);
console.log("PASS: 正常持久卷路径不会触发警告！\n");

delete process.env.MEMHUB_MODEL_DIR;
console.log("=== 持久化验证全部通过 ===");
