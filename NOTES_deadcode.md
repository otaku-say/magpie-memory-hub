# Magpie Memory Hub 死代码审计与文档同步检查点 (NOTES_deadcode.md)

**记录时间**：2026-10-17
**审计目标**：`/var/minis/workspace/magpie-memory-hub/`
**原则依据**：「插件不需要兼容过时内容」「当自动记忆实现后，要移除之前为未生效的自动记忆添加的、已经无用的代码」。

---

## 一、死代码审计清单（分类、证据与删除风险）

### A. 从未生效的路径
1. **`memory.middleware.js:973-990` (`harvest(ctx)`) 及 `1032, 1087` 行调用**
   - **代码片段**：`function harvest(ctx) { ... console.log(HARVEST_TAG + JSON.stringify(...)); }`
   - **判定理由**：官方 Docker 部署（`gcr.io/distroless/cc-debian12:nonroot`）下，Go 网关将 moejs 中间件 stdout 捕获入容器日志，与宿主管道无关联，且容器无 Python 运行时。此 stdout 采集链路从未生效。
   - **删除风险**：**高（严格豁免不删）**。遵循硬性要求「绝不删除 memory.middleware.js 与 compress.js」，本轮仅审计记录，不改动该文件。

2. **`harvest.py:1448-1465` (`read_turns` 消费 stdout/日志流)**
   - **代码片段**：`def read_turns(stream, follow): ... idx = line.find(HARVEST_TAG)`
   - **判定理由**：从未生效的 stdout 管道消费端，在官方 Docker 环境下无法接收任何输入。
   - **删除风险**：**中（待确认）**。`harvest.py` 仍需保持语法 AST 解析通过，不建议直接大段删毁导致测试异常。

3. **`harvest.py:53-74, 1275-1316, 1370-1412` (`plugin_options`, `read_magpie_options`, `write_magpie_options`, `SnapshotPusher`)**
   - **代码片段**：调用 `magpie plugin options <name>` 反向推送记忆快照到 `plugins.json`。
   - **判定理由**：Docker 容器隔离下独立 Python 无法调用 magpie 二进制；频繁改动 options 会导致插件频繁重启。
   - **删除风险**：**中（待确认）**。

4. **`harvest.py:1029-1116` (`promote_scopes` 记忆作用域提升)**
   - **代码片段**：`def promote_scopes(ncb, cfg, dry_run=False): ...`
   - **判定理由**：规划中但从未在生产路径触发的离线批处理逻辑。
   - **删除风险**：**低（待确认）**。

---

### B. 已废弃的兼容代码（执行删除）
1. **`tools.js:312` 中的 `m.source_client` 旧字段别名**
   - **代码片段**：`|| (m.source_client && String(m.source_client).trim())`
   - **判定理由**：重构到标准 `client` 字段前的历史别名回退。用户明确不需要兼容过时内容。
   - **删除风险**：**极低**。删除后直接断言。

2. **`tools.js:533` 中的 `args.source_client` 旧字段别名**
   - **代码片段**：`|| (args.source_client && String(args.source_client).trim())`
   - **判定理由**：同上，踩坑写入时的旧参数别名。
   - **删除风险**：**极低**。删除后直接断言。

3. **`gateway_harvest.hooks.js:220` 中的 `r.fingerprint` 旧列名查重回退**
   - **代码片段**：`(r) => r.content_fingerprint === fp || r.fingerprint === fp`
   - **判定理由**：Schema v3 已重构为 `content_fingerprint`，`r.fingerprint` 属历史兼容代码。
   - **删除风险**：**极低**。删除后直接断言。

4. **`gateway_harvest.hooks.js:274` 中的 `r.fingerprint` 旧列名查重回退**
   - **代码片段**：`(r) => r.content_fingerprint === fp || r.fingerprint === fp`
   - **判定理由**：同上，踩坑查重逻辑中的历史旧列兼容。
   - **删除风险**：**极低**。删除后直接断言。

5. **`tools.js:141-147` (`makeClient` 降级为 `makeRestClient`)**
   - **代码片段**：`if (cfg.mcpKey) return makeMcpClient(cfg, sig); return makeRestClient(cfg, sig);`
   - **判定理由**：为未配置 MCP Key 但有 Secret Key 的旧用户保留的降级逻辑。
   - **删除风险**：**中（待确认，暂保留）**。防范无 MCP key 场景下纯 REST 测试用例或极端配置破坏，暂不物理删除。

---

### C. 不可达代码（执行删除）
1. **`tools.js:37` 中的 `const SNAPSHOT_CAP = 500;`**
   - **代码片段**：`const SNAPSHOT_CAP = 500;`
   - **判定理由**：未导出且在 `tools.js` 内部 0 处引用，系推快照旧逻辑遗留常量。
   - **删除风险**：**极低**。删除后断言。

2. **`schema.js:7` 注释中的旧表名 `memhub_meta`**
   - **代码片段**：`* 3. 结构版本号：记录在 memhub_meta 表里...`
   - **判定理由**：Schema v3 中已重命名为 `schema_meta`，此为过时注释。
   - **删除风险**：**极低**。修正为 `schema_meta`。

---

### D. 冗余重复
1. **`harvest.py` 与 `gateway_harvest.js` 中的抽取规则逻辑 1:1 重复**
   - **判定理由**：`mine_failures` / `mine_environment_facts` / `mine_architectural_decisions` 等抽取规则在两个文件中各写了一遍。
   - **删除风险**：**中（待确认）**。`gateway_harvest.js` 是生产激活代码；`harvest.py` 保留独立 Python 运行能力，不破坏其内部完整性。

---

### E. 文档与代码不符（执行同步）
1. **`README.md:53-110` 数据库表结构全量按 `schema.js` 同步**
   - 更新 `memories`、`pitfalls` 表定义为当前声明的完整 23 列 / 17 列与新列名（`content_fingerprint`、`lifecycle_status`、`superseded_by_id`、`revision`、`retrieval_count`、`last_used_at`、`scope_level`、`origin`、`full_text` 等）。
   - 补全 `schema_meta` 表结构声明。
   - 更新所有复合唯一索引与辅助索引定义。
2. **`README.md:121, 279` 移除已废弃工具 `memory_extract`**
   - 将文档中提到的 9 个 / 18 个工具修正为当前真实注册的 22 个工具，删除 `memory_extract` 的说明。
3. **`README.md:20-40` 同步真实自动记忆路径**
   - 纠正未生效的 `[MEMORY_HARVEST]` stdout 离线管线图示，注明基于 `GatewayConversations` 录制提炼与 PR #2118 异步请求钩子的生产闭环。

---

## 二、删除与修改执行计划
1. 编辑 `tools.js`：删除 `SNAPSHOT_CAP` 常量，删除 `source_client` 别名。
2. 编辑 `gateway_harvest.hooks.js`：删除 `|| r.fingerprint === fp` 兼容代码。
3. 编辑 `schema.js`：修正注释中的 `memhub_meta` 为 `schema_meta`。
4. 编辑 `README.md`：全量同步表结构、移除 `memory_extract`、同步架构说明，并执行 `check_schema_sync.mjs` 规则自检。
5. 运行全部测试并断言验证。
