# NOTES_harvest_quality.md —— 自动记忆产出质量缺陷分析与修复检查点

## 1. 缺陷背景与真实数据证实（数据源：用户真实库 `41694_agent_memory`）

### 缺陷 1：踩坑表噪音洪水（20 分钟写入 288 条伪踩坑，自增 ID 飙升至 1373）
* **真实样本**：
  * `symptom: "ERROR|FATAL|FAILED|FAIL|Error:)\b[^\n]{<n>,<n>}/i,"` / `solution: "solution: <str>,"`
  * `symptom: "fail(error.AccessDenied),"` / `solution: "<n>- var done: bool = false;"`
  * `symptom: "ModuleNotFoundError: No module named <str>，后续通过调整成功解决","` / `solution: "<str>: <str>,"`
* **根因确认**：
  1. **把源码与正则当故障**：`gateway_harvest.js` 的 `mineFailures`（约 160-185 行）未过滤 Markdown 代码块与行内代码；对话里粘贴的代码/正则/JSON 触发 `FAIL_PATTERNS`，后面的普通代码行（如含 `done`、`solution:` 等）被误判为解法。
  2. **全量历史反复扫描**：`gateway_harvest.hooks.js` 的 `buildDialogueText` 遍历整场对话所有历史 messages 拼成巨型字符串，每轮请求反复重扫全部历史。
  3. **去重查询截断失效**：`gateway_harvest.hooks.js` 使用 `client.list("pitfalls", { project, limit: 100 })`，无 `ORDER BY`，默认只返回最早 100 条。库内超过 100 条后新条目永远查不到，导致无限重复插入（ID 达到 1373，实际有效仅 288 条）。

### 缺陷 2：路径正则误判
* **真实记录**：`路径纠正: Object.prototype.hasOwnProperty.call` —— 内容 `文件 GLOBAL.md 不存在，正确路径为 Object.prototype.hasOwnProperty.call。`
* **根因确认**：`gateway_harvest.js` 约 300 行与 `harvest.py` 中的 `pathRe` 采用 `[~/\w.-]+\.[a-zA-Z0-9]+`，缺少对路径分隔符（`/` 或 `\\`）的强制约束，JS 对象属性链 `Object.prototype.hasOwnProperty.call` 完全匹配该正则而被当作路径。

### 缺陷 3：时间戳为空与门禁盲区
* **真实记录**：自动采集的 memories 记录中 `created_at` 与 `updated_at` 均为 NULL。
* **根因确认**：`gateway_harvest.hooks.js` 的 `create("memories", ...)` 与 `create("pitfalls", ...)` 载荷中漏传了 `created_at` 与 `updated_at`；同时静态门禁 `tests/test_schema_defaults.mjs` 的扫描文件列表 `FILES` 仅包含 `tools.js` / `harvest.py` / `schema.js` / `db_tools.js`，存在扫描盲区，漏掉了 `gateway_harvest.hooks.js`。

### 缺陷 4：钩子超时预算
* **上游确认**：
  * 沙箱 `/root/magpie`（依据 commit `81313b912128e2c6d8991caf6667b55c27cfb1cd`）。
  * `internal/plugin/host.js:1225`：
    `const gatewayTimeout = (h) => Number.isInteger(h.options.gatewayTimeoutMs) && h.options.gatewayTimeoutMs >= 100 && h.options.gatewayTimeoutMs <= 10000 ? h.options.gatewayTimeoutMs : 1000`
  * `docs/subsystems/gateway-request-hooks.md:56`：
    `The gatewayTimeoutMs option accepts 100–10000 ms (default 1000 ms).`
  * 默认仅 1000ms，在提炼 + NCB 写入时极易被 abort 丢弃数据。

---

## 2. 修复方案与执行步骤

1. **只提炼本轮增量 (`gateway_harvest.hooks.js`)**：
   - 重构 `buildDialogueText`，请求侧提取逻辑改为只取最后一轮用户输入（`role: "user"`），与本次模型输出配对。
2. **剔除代码块与收紧 `mineFailures` (`gateway_harvest.js`, `harvest.py`)**：
   - 抽取前先剥离 Markdown 代码块（```` ```...``` ```` 与 `~~~...~~~`）以及行内代码 `` `...` ``（避免代码片段被当成错误日志）。
   - 收紧 `mineFailures`：解法不能仅仅是含有 `ok/pass/done` 的任意文本；强制要求必须是可执行命令（如 `apt/npm/pip/uv/export/source/mv/cd` 等）或具有明确修复语义的自然语言描述，排除代码语法、属性行与纯退出状态。
3. **收紧路径正则 (`gateway_harvest.js`, `harvest.py`)**：
   - 目标路径强制要求包含路径分隔符（`/`、`\\`、`~/`、`./`），并排除连续多点无斜杠的 JS 链式属性模式。
4. **修复去重查重 (`gateway_harvest.hooks.js`)**：
   - 将 `client.list(table, { project, limit: 100 })` 改为精确指纹查询 `client.list(table, { project, content_fingerprint: fp, limit: 1 })`，直接走数据库 `idx_*_uniq_fp` 索引，彻底根除分页截断导致的重复插入。
5. **补齐时间戳并扩大门禁扫描 (`gateway_harvest.hooks.js`, `tests/test_schema_defaults.mjs`)**：
   - 在 `gateway_harvest.hooks.js` 的 `memories` 与 `pitfalls` 写入载荷中显式传入 `created_at: now` 与 `updated_at: now`。
   - 在 `tests/test_schema_defaults.mjs` 的 `FILES` 数组中增加 `gateway_harvest.hooks.js`。
6. **配置 `gatewayTimeoutMs` (`package.json`)**：
   - 在 `package.json` 的 `magpie.options` 中显式配置 `"gatewayTimeoutMs": 8000`。
7. **回归测试与质量标准断言**：
   - 验证原有高价值产出（`Python 虚拟环境激活`、`选型决策: 采用 mcp_client 替换 db_tools`、`工具规范: npm 代替 pnpm`）依然被准确提炼。
   - 验证真实噪音样本（含正则、`fail(error.AccessDenied)`、代码属性行）彻底不再入库。
   - 反证测试：喂入真实故障 + 真实解法，断言确实能够提炼成功。
   - 跑通全量 `node tests/test_meta.mjs` 及所有测试套件。
