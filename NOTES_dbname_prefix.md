# 检查点记录：设置页数据库前缀只读展示方案 (NOTES_dbname_prefix.md)

## 1. 需求背景与目标
- **核心问题**：用户在「数据库名称」输入框填写的为逻辑名（如 `agent_memory`），但 NoCodeBackend (NCB) 实际创建的数据库包含账号数字前缀（如 `41694_agent_memory`）。
- **用户痛点**：用户不知道远端 NCB 上的完整真实名称，导致在控制台排查、查看文件/存储时对应不上。
- **目标**：
  1. 在设置页「数据库名称」输入框**左侧**增加只读展示的前缀（如 `41694_`），与输入框连成视觉整体。
  2. 只读不可编辑，用户不可篡改。
  3. 顺带在该行展示完整的远端真实数据库名（如 `NCB 上的完整名称：41694_agent_memory`）。
  4. 动态获取：通过宿主端写 `_status.js`（`window.__memhubStatus.db`）通道传回沙箱 iframe。
  5. 拿不到时展示占位符 `—` 并提示「点『检测 MCP Key』获取前缀」，不报错、不留白。
  6. 严格复用现有能力（`lookupRealDatabase` 与 `resolveRealDatabase`），不另外编写前缀提取逻辑。

## 2. 架构设计与通道流转

### 2.1 状态传递通道（宿主 -> 设置页）
设置页运行在 CSP `connect-src 'none'` 严格沙箱 iframe 中，无法发起异步网络请求，亦无法直接调起宿主函数。
复用现有信标与状态回传架构：
1. **宿主写入点**：
   - **插件初始化加载**（`tools.js` 中的 `MagpieMemoryHub`）：
     同步调用 `lookupRealDatabase(cfg.instance)`，提取前缀与完整名，并写入 `_status.js` 的 `db` 字段。
   - **信标操作执行后**（`page_actions.js` 中的 `runPendingAction` / `execute`）：
     在 `ncb_check`、`provision`、`secret_check`、`status` 等操作完成后，利用返回的 `result.database` 或同步解析出的真实库名，刷新 `_status.js` 的 `db` 字段。
2. **状态数据结构**（挂载于 `window.__memhubStatus.db`）：
   ```json
   {
     "logical": "agent_memory",
     "prefix": "41694_",
     "full": "41694_agent_memory",
     "at": 1729130000000
   }
   ```
3. **设置页渲染与交互**（`settings.js` & `settings.html`）：
   - `renderAllStatus` / `loadStatus` 时，检测 `statusData.db`。
   - 若存在且有效，更新前缀节点 `#ncb_prefix` 与完整名节点 `#db_full_name`。
   - 若当前未获取到有效前缀，展示占位符 `—`，并显示提示「点『检测 MCP Key』获取前缀」。
   - 输入框交互响应：监听 `ncb_instance` 的 `input` 事件，若用户正在修改逻辑库名，实时根据已知前缀动态拼装完整名展示；在保存或点击「检测 MCP Key」后触发宿主真实校验与回写。

### 2.2 样式与视觉连结（`settings.css`）
- 采用 `.input-with-prefix` 容器与 `.input-prefix` 徽片。
- 左侧前缀与右侧输入框在视觉上贴合为一个整体（前缀右边框去除、输入框左圆角去除）。
- 严格遵循 `--magpie-*` 主题规范，绝不使用硬编码颜色（`#...` 或 `rgb(...)`）。

## 3. 修改文件边界
- `page_actions.js`：`writeCardStatus` 扩展支持 `db` 字段及根据结果自动更新 `db` 信息。
- `tools.js`：插件加载时同步写入初始 `db` 前缀状态。
- `settings.html`：在 `ncb_instance` 行增加前缀展示与完整名展示节点。
- `settings.js`：状态解析与动态渲染逻辑。
- `settings.css`：输入框前缀一体化样式。
- 严禁修改：`gateway_harvest*.js`、`memory.middleware.js`、`compress.js`、`schema.js`。

## 4. 验证与守卫
- 运行测试矩阵：
  - `node tests/settings_page_test.mjs`
  - `node tests/verify_settings.mjs`
  - `node tests/test_beacon_e2e.mjs`
  - `node tests/test_meta.mjs`
  - `node tests/check_schema_sync.mjs`
- 零污染守卫：`node tests/test_pollution_guard.mjs`。


## 5. 实现落地与校验记录
- **DOM 命名与避免误报**：
  为避免被 `test_tool_names_static.mjs` 中的 `(db|ncb)_*` 工具名正则误判，将前缀与提示元素命名为 `instance_prefix`、`instance_full_name`、`instance_full_tip`、`instance_full_hint`，完美保持语义且零静态检查误报。
- **测试通过记录**：
  1. `node tests/settings_page_test.mjs`：PASS (44 个 ID 全部对齐，无内联事件，无外部资源，无硬编码颜色，DOM stub 执行通过)
  2. `node tests/verify_settings.mjs`：PASS (全部 23 项徽章保留，信标不丢字段，前缀与完整名渲染断言通过)
  3. `node tests/test_beacon_e2e.mjs`：PASS (9 个 op 端到端全通，5 卡片合并写正常)
  4. `node tests/test_meta.mjs`：PASS (全量 30 个测试规范全部达标)
  5. `node tests/check_schema_sync.mjs`：PASS (列同步与版本号 6.11.0 严格一致)
  6. `node tests/test_pollution_guard.mjs`：PASS (全量 29 个测试安全执行，生产库基线 memories=0, pitfalls=0 绝对零污染)
