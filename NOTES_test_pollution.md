# 排查与治理：测试套件污染用户真实账号问题 (NOTES_test_pollution.md)

## 1. 问题背景与现象确认

用户 NoCodeBackend (NCB) 账号中发现真实数据库 `41694_test` (Display Name: `test`)：
- 用户 NCB 账号总配额为 25 个数据库，目前已占用 2 个：`41694_agent_memory`（业务库）与 `41694_test`（测试污染生成）。
- 该库由自动化测试 `tests/test_provision.mjs` 创建：
  - `tests/test_provision.mjs` 在 Section 4 中使用 `database: "test", on_exist: "fail"` 调用 `dbProvision`。
  - `dbProvision` 的内部逻辑：若目标库未在账号中发现，则执行 `mcp.createDatabase(want, ...)`。因此当账号中尚未存在 `test` 库时，测试会直接在用户账号中创建一个真实数据库 `41694_test`！
  - 随后的 Section 5 和 Section 6 又直接硬编码依赖 `41694_test` 存在来进行 `reuse` 测试。
- **严重性**：
  1. 账号级污染：不只是写几行数据，而是直接消耗了用户珍贵的数据库名额（NCB 账号上限 25 个）。
  2. 删库无法单边解决：若测试代码不改，用户一旦在 NCB 控制台删除了 `41694_test`，下次运行测试套件时，`test_provision.mjs` 又会自动在用户账号里新建一个 `41694_test`。
  3. NCB MCP 工具能力边界：经核实，NoCodeBackend MCP 的 23 个工具中**没有** `delete_database` / `drop_database` 工具，测试创建的真实数据库无法通过自动化测试清理，必须由用户登录 Web 控制台手动删除。

---

## 2. 全仓排查清单：测试到底触碰了哪些真实资源

经过全仓静态与动态扫描，测试对真实资源的操作可划分为两类：

### 2.1 账号级资源（高危：建库 / 建桶 / 账号配置）
1. **`tests/test_provision.mjs`**：
   - **调用**：`new NcbMcp({ apiKey: KEY })`，调用 `mcp.listDatabasesText()` 和 `dbProvision(cfg, { database: "test", on_exist: "fail" })`。
   - **创建资源**：当库不存在时，调用 `mcp.createDatabase("test")`，直接在用户账号创建真实数据库 `41694_test`！
   - **硬编码依赖**：多处依赖 `41694_test` 实例名（第 16、21、43、44、61、75 行）。
2. **`tests/test_r2_verify.mjs`**：
   - **调用**：使用真实 `KEY` 和目标库 `41694_agent_memory`，调用 `r2Setup` 与 `r2Probe`。
   - **创建/变更资源**：`r2Setup` 内部会调用 MCP `setup_r2_storage`，在 Cloudflare R2 上创建桶（Bucket）并配置 CORS。当传入测试凭据时（第 65 行），会直接向 NCB 提交测试用的 Cloudflare R2 密钥，存在篡改或覆盖真实库 R2 连接的风险；同时 `r2Probe` 会真实上传 probe 测试文件。
3. **`tests/lib/testenv.mjs`**：
   - 在远程模式下包裹了 `rawMcp.callTool`，但**缺少对账号级资源创建工具（`create_database`、`setup_r2_storage`）的拦截防线**。

### 2.2 表级/行级数据读写
- 多数业务测试（如 `test_abort.mjs`、`test_denoise_p0.mjs`、`test_gateway_harvest.mjs` 等）通过 `createTestEnv` 运行，默认处于纯内存模式（`mode: "memory"`），零远端网络调用。在远程模式下有 `__test__` project 隔离与 cleanup 清理逻辑。
- `test_pollution_guard.mjs`：仅通过 `executeSql` 统计 `41694_agent_memory` 上的 memories 与 pitfalls 行数，**完全抓不到「新建了一个数据库」或「创建了一个 R2 桶」**。
- `test_beacon.mjs`：虽在内存桩中拦截了 `args.database === "41694_test"`，但硬编码使用了 `41694_test` 作为 mock 实例名，存在语义耦合。

---

## 3. 治理方案设计

### 3.1 核心原则
1. **测试绝不应在用户真实账号中创建真实资源（建库、建桶、改账号配置）**。
2. **纯逻辑决策与真实网络交互严格解耦**：
   - 库名解析（`parseDatabases`）、账号前缀推断（`inferAccount`）、逻辑名提取（`logicalName`）为纯函数测试。
   - `dbProvision` 的三种策略（`reuse`、`fail`、`auto_rename`）以及建库参数决策，使用**受控打桩 client (Mock MCP)** 进行完整覆盖，不碰真实网络。
   - 对端到端建库流程：由于 NCB MCP 无法自动删库，测试中严禁静默建库；若需保留端到端用例，必须由显式环境变量门禁控制，默认 SKIP 并打印控制台清理指引，且命名绝不使用 `test`。
3. **彻底切除对 `41694_test` 的硬依赖**：
   - 移除测试对 `41694_test` 必须存在的任何假定。
   - 测试中的沙箱实例名统一改为隔离标识（如 `mock_db_instance` 或 `__test_mock__`）。
4. **加固 `tests/lib/testenv.mjs` 账号级防御**：
   - 在 `testenv.mjs` 中对 `create_database` 和 `setup_r2_storage` 等账号级工具增加严格的 `SECURITY_BLOCKED` 拦截。
5. **治理 `test_r2_verify.mjs`**：
   - 将 `r2Setup` 的判决机制与凭据追踪测试改为基于打桩 client / 纯逻辑验证，杜绝在真实生产库 `41694_agent_memory` 上反复调用 `setup_r2_storage`。

---

## 4. 实施计划
1. 改写 `tests/test_provision.mjs`：
   - 保留纯函数解析测试。
   - 使用受控打桩的 `NcbMcp` 客户端模拟 `list_databases`、`create_database`、`get_schema` 等响应，全面验证 `reuse`、`fail`、`auto_rename` 的决策分支。
   - 移除所有对真实 `41694_test` 的依赖与网络建库调用。
2. 加固 `tests/lib/testenv.mjs`：
   - 增加账号级破坏性操作拦截。
3. 改写 `tests/test_r2_verify.mjs`：
   - 避免向真实 `41694_agent_memory` 发送 `setup_r2_storage` 请求。
4. 规范 `tests/test_beacon.mjs`：
   - 桩对象实例名脱敏，解除对 `41694_test` 的字面引用。
5. 验证与证据收集：
   - 运行前记录 `list_databases` 库清单与数量。
   - 运行 `test_meta.mjs`、`test_provision.mjs`、`test_pollution_guard.mjs`。
   - 运行后再次比对 `list_databases`，证明测试前后账号中数据库数量 100% 保持一致，零新增资源。
6. 输出用户清理指引：
   - 给出在 NoCodeBackend 控制台手动删除 `41694_test` 的操作步骤。
