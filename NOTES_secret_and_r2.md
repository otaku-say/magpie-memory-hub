# 密钥与 R2 清理问题修复检查点 (NOTES_secret_and_r2.md)

## 状态总览
本文档记录两组线上用户实测反馈问题（Secret Key 体验与 R2 清理问题）的定位、决定性实测证据与修复计划。

## 一、决定性证据与根因分析

### 1. 核心实测结论：NCB REST 必须使用真实库名
- **实测证据**（使用测试有效密钥验证，不回显具体密钥）：
  - `GET https://api.nocodebackend.com/files?Instance=agent_memory` → HTTP 403 `{"error":"Invalid secret_key."}`
  - `GET https://api.nocodebackend.com/files?Instance=41694_agent_memory` → HTTP 200 `{"status":"success","files":[...]}`
- **根本原因**：
  - NCB 的 REST 接口（`/files` 等）严格要求带账号数字前缀的**真实库名**（如 `41694_agent_memory`）。
  - 设置页与配置中传入的是逻辑名（如 `agent_memory`）。使用逻辑名探测或调用 REST 时，NCB 返回 403 假象为「Invalid secret_key」。
  - 这一根因同时导致了：
    1. `db_tools.js` 中 `secretCheck` 探测报「Secret Key 无效」；
    2. `r2.js` 中 `r2List` / `r2Delete` / `cleanProbes` 报「Secret Key 无效，无法清理探针」。

### 2. 按钮点不动与即时反馈缺失原因
- **原因 1：即时反馈指向错误容器**：`settings.js` 中 `submitAction` 在提交初始阶段调用 `paintDbStatus(null, "正在提交信标任务…", "")` 未传入 `containerMap[targetCard]`，硬编码写入了 NCB 卡片的 `db_action_status`，处于屏幕下方的 R2 卡片没有任何视觉变化。
- **原因 2：频控限制报错未落到当前卡片**：1 秒频控拦截时未传入当前卡片容器，R2 卡片无反应。
- **原因 3：clean_probe 信标未传递 secret 字段**：`submitAction` 中未对 `clean_probe` 提取当前输入框中的 `ncb_secret`。
- **原因 4：宿主未调用时的轮询等待**：信标落盘后需等待宿主执行；配合库名 403 导致清理总是失败。

### 3. 一键创建数据库与 R2 桶同名规范及 opt-in 彻底解耦
- **存储桶命名规则**：
  - 用户明确要求 R2 创建的存储桶名称必须与数据库名称相同（不加 `-storage` 后缀），确保「桶名」「REST 调用的 Instance」「列表/删除时的库名」三者同源。
  - 不显式传 `bucket_name` 时，默认桶名直接取真实数据库名。
- **一键创建与 R2 解耦**：
  - 用户要求「只有在 R2 卡片点『挂载 R2 存储』时才创建桶」。
  - `dbProvision` 彻底移除默认联动创建 R2 逻辑，`tools.js` / `settings.js` / `page_actions.js` 清理多余联动参数。

### 4. 移除「自动获取 Secret Key」的承诺文案与误导逻辑
- MCP key 无法读取 Secret Key（`list_databases` 不含、`get_integration_prompts` 仅为占位符）。
- 仅在新建数据库时（`create_database`）返回一次。
- 移除设置页所有「会自动获取」误导文案，明确说明需前往控制台复制，并区分三类失败提示与自救路径。

## 二、整改行动计划
1. **抽离统一的逻辑名到真实库名解析函数**：
   - 在 `local_state.js` 导出同步解析 `lookupRealDatabase(name)`。
   - 在 `r2.js` / `db_tools.js` 统一实现异步解析 `resolveRealDatabase(cfg, name)`（本地状态优先，MCP `listDatabases` 兜底）。
   - 在所有走 NCB REST 接口的地方（`secretCheck`, `r2List`, `r2Delete`, `cleanProbes`, `r2Probe`, `r2Setup` 等）统一使用解析后的真实库名。
2. **规范 R2 存储桶默认名**：
   - 默认桶名 = 真实数据库名（同源，不加 `-storage`）。
   - 更新 `r2.js`, `db_tools.js`, `tools.js`, `settings.html`。
3. **修复 R2 卡片即时反馈与按钮交互**：
   - `settings.js` 中 `submitAction` 在各个错误和过渡状态点显式指定 `containerMap[targetCard]`。
   - `clean_probe` 信标提取输入框中的 secret。
4. **精细化 Secret Key 失败提示与自救指引**：
   - 细分未填、鉴权被拒（401/403，附两个高频原因）、格式错误（长度/空格）三类提示。
   - 提示可通过 auto_rename 策略新建库自救获取新密钥。
5. **单元测试与断言保护**：
   - 构造逻辑名+带前缀真实库名测试，断言 REST 请求使用的是真实库名。
   - 断言桶名与真实库名同源。
   - 断言所有测试绿灯。
