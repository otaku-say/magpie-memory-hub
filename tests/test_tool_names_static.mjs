/**
 * test_tool_names_static.mjs —— 静态断言测试：锁定工具名引用一致性
 *
 * 目的：
 * 曾经发生过 memory.middleware.js 的 CCR 提示里把 memory_get 误写为 memory_expand，
 * 导致 Agent 按提示调用时找不到工具，CCR 静默失效。
 * 本测试从 tools.js 动态解析出真实工具名全集，并静态扫描：
 *   - memory.middleware.js
 *   - tools.js
 *   - settings.html
 * 凡出现 memory_* / pitfall_* / storage_* / db_* / ncb_* / r2_* / model_*
 * 形式的工具标识符，必须全部存在于真实工具名全集中，否则断言失败。
 */

import { readFileSync } from "node:fs";
import assert from "node:assert";
import { MagpieMemoryHub } from "../tools.js";

// 1. 获取真实工具名集合
const hub = await MagpieMemoryHub({}, {});
const registeredTools = new Set(Object.keys(hub.tool || {}));
console.log(`[1] 真实注册工具共 ${registeredTools.size} 个:`);
console.log(`    ${[...registeredTools].sort().join(", ")}`);

if (registeredTools.size === 0) {
  throw new Error("无法从 tools.js 加载注册工具！");
}

// 强断言：工具总数必须为 21 个（新增 memory_audit 记忆体检工具）
assert.strictEqual(registeredTools.size, 21, "真实注册工具总数必须为 21 个");

// 非工具符号白名单（仅限配置选项名、DOM 元素 ID、模块文件名）
const KNOWN_NON_TOOL_SYMBOLS = new Set([
  // 模块引用
  "db_tools",
  // 配置选项 / 参数名
  "ncb_instance",
  // v6.47.0 大模型/重排超时与候选上限配置项（非工具）：
  // 三者均声明于 package.json → magpie.options，并在 settings.html 以 <input id="…"> 落盘，
  // 见下方「白名单自证门」——必须同时在 options 声明与设置页控件中存在才允许豁免。
  "model_timeout_sec",
  "rerank_timeout_sec",
  "rerank_max_candidates",
  "ncb_secret",
  "r2_account_id",
  "r2_access_key_id",
  "r2_secret_access_key",
  "r2_bucket_name",
  "r2_public_url",
  "storage_public_url",
  "model_dir",
  // v6.20.0 调用预算配置选项（非工具，仅 options 字段；扫描器按 model_ 前缀误报）
  "model_budget",
  "model_max_per_min",
  "model_max_total",
  "harvest_max_per_min",
  "harvest_max_total",
  // v6.28.0 去重模型响应字段
  "memory_duplicates",
  "pitfall_duplicates",
  // v6.36：配置项键名（非 MCP 工具），避免被工具名门禁误判
  "pitfall_recurrence_threshold",
  // 设置页 DOM 元素 ID
  "db_action_status",
  "model_action_status",
  "r2_action_status",
  "r2_status",
]);

const TOOL_PATTERN = /\b(memory|pitfall|storage|db|ncb|r2|model)_[a-zA-Z0-9_]+\b/g;

/**
 * 白名单自证门：豁免「不是工具」的符号必须拿出可验证的证据。
 * v6.47.0 新增的三个 `model_` / `rerank_` 前缀配置键命中工具名正则属**测试误报**，
 * 它们既不是 MCP 工具，也不该被扫成工具；这里强制它们同时满足：
 *   1) 出现在 package.json 的 magpie.options 默认值中（宿主据此渲染/校验选项）；
 *   2) 出现在 settings.html 中形如 id="<key>" 的表单控件上（用户可配置的入口）。
 * 任一条不成立，说明白名单被当成「万能免死金牌」滥用，必须失败。
 */
function assertConfigKeysAreNotTools(keys) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const options = (pkg && pkg.magpie && pkg.magpie.options) || {};
  const settingsHtml = readFileSync(new URL("../settings.html", import.meta.url), "utf8");
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) {
      throw new Error(`白名单自证失败：${key} 未在 package.json 的 magpie.options 中声明，不能豁免为配置项`);
    }
    if (!settingsHtml.includes(`id="${key}"`)) {
      throw new Error(`白名单自证失败：${key} 未在 settings.html 中以 id="${key}" 控件暴露，不能豁免为配置项`);
    }
    if (registeredTools.has(key)) {
      throw new Error(`白名单自证失败：${key} 已是真实注册工具，不应出现在非工具白名单中`);
    }
  }
}

const V647_CONFIG_KEYS = ["model_timeout_sec", "rerank_timeout_sec", "rerank_max_candidates"];
assertConfigKeysAreNotTools(V647_CONFIG_KEYS);
console.log(`[1.5] 白名单自证门通过：${V647_CONFIG_KEYS.join(", ")} 均为 package.json/settings.html 中的配置项，非工具`);

// 反证：自证门必须能拒绝「没有 options 声明」的键，否则白名单就成了万能免死金牌
let selfProofRejected = false;
try {
  assertConfigKeysAreNotTools(["model_budget"]);
} catch {
  selfProofRejected = true;
}
if (!selfProofRejected) {
  throw new Error("反证失败：白名单自证门未能拦截未在 package.json options 声明的键 model_budget");
}
console.log("  ✓ 反证门：未在 options 声明的 model_budget 被自证门拒绝豁免");

/**
 * 扫描文本并返回未识别的工具标识符
 */
export function scanToolIdentifiers(text, registered = registeredTools, nonTools = KNOWN_NON_TOOL_SYMBOLS) {
  const errors = [];
  const matches = text.match(TOOL_PATTERN) || [];
  for (const id of matches) {
    if (nonTools.has(id)) continue;
    if (!registered.has(id)) {
      errors.push(id);
    }
  }
  return errors;
}

// 2. 真实文件扫描断言
console.log("\n[2] 扫描关键文件中的工具名引用...");
const targetFiles = [
  { path: "memory.middleware.js", url: new URL("../memory.middleware.js", import.meta.url) },
  { path: "tools.js", url: new URL("../tools.js", import.meta.url) },
  { path: "settings.html", url: new URL("../settings.html", import.meta.url) },
  { path: "src/middleware/inject-builder.js", url: new URL("../src/middleware/inject-builder.js", import.meta.url) },
  { path: "src/middleware/request-inject.js", url: new URL("../src/middleware/request-inject.js", import.meta.url) },
  { path: "src/index.js", url: new URL("../src/index.js", import.meta.url) },
];

let totalErrors = 0;
for (const target of targetFiles) {
  const content = readFileSync(target.url, "utf8");
  const errors = scanToolIdentifiers(content);
  if (errors.length > 0) {
    console.error(`  ✗ [FAIL] ${target.path} 发现未注册的工具名: ${[...new Set(errors)].join(", ")}`);
    totalErrors += errors.length;
  } else {
    console.log(`  ✓ [PASS] ${target.path} 所有工具名引用均合法`);
  }
}

if (totalErrors > 0) {
  throw new Error(`静态工具名断言失败：发现 ${totalErrors} 处未知或拼错的工具名！`);
}

// 3. 自测反证门：断言当存在错写工具名（如 memory_expand）时，校验器必须报错
console.log("\n[3] 运行反证测试（断言错写工具名时测试必定失败）...");
const badSample1 = '需要完整内容可调 memory_expand 展开';
const badErrors1 = scanToolIdentifiers(badSample1);
if (badErrors1.length !== 1 || badErrors1[0] !== "memory_expand") {
  throw new Error(`反证失败：未能拦截 memory_expand，实际拦截到: ${JSON.stringify(badErrors1)}`);
}
console.log(`  ✓ 成功拦截典型拼写错误: memory_expand -> 抛出错误`);

const badSample2 = '请调用 storage_remove 删除文件，或调用 db_drop_all 清空库';
const badErrors2 = scanToolIdentifiers(badSample2);
if (badErrors2.length !== 2 || !badErrors2.includes("storage_remove") || !badErrors2.includes("db_drop_all")) {
  throw new Error(`反证失败：未能拦截虚构工具名，实际: ${JSON.stringify(badErrors2)}`);
}
console.log(`  ✓ 成功拦截虚构工具名: storage_remove, db_drop_all -> 抛出错误`);

const badOfflineSample = '支持调用 model_check 或 model_download 管理本地模型';
const badOfflineErrors = scanToolIdentifiers(badOfflineSample);
if (badOfflineErrors.length !== 2 || !badOfflineErrors.includes("model_check") || !badOfflineErrors.includes("model_download")) {
  throw new Error(`反证失败：已下线的 model_check / model_download 未被拦截为未注册工具名，实际: ${JSON.stringify(badOfflineErrors)}`);
}
console.log(`  ✓ 成功拦截已下线工具名: model_check, model_download -> 确认为未注册工具`);

console.log("\n✅ 静态工具名断言测试全部通过！");
