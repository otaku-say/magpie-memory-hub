# 架构瘦身与闭环收敛检查点报告 (v6.22.0 · NOTES_arch_slimming.md)

**发布版本**：`v6.22.0`（`package.json` 与 `settings.html` 严格同步）
**合流基准**：`fa9fe59` (v6.21.0: 合流自激修复 + 按外部清单完成 23 项深度整改)
**整改依据**：架构级分析（5 项重点）：闭合读链路、剥离 compress.js、单一状态源、合并管线（移除 harvest.py）、去重与检索优化。

---

## 一、核心架构整改落地与判定明细

### ① 闭合「读链路」—— 物理死结判定与双轨闭环方案
- **源码审查确凿证据（物理死结铁证）**：
  1. `internal/plugin/host.js:1144`：Bun 插件宿主仅暴露只读查询接口 `magpie: { option: optionValue, options: optionValues }`，根本不存在任何 `magpie.options.set` 等修改 options 的宿主 API。
  2. `internal/plugin/store.go:270-285`：外部直接写 `plugins.json` 时，`checkList()` 会计算 `listStamp()`，发现文件 mtime 变动后将 `hostStale` 原子标记为 `true`。
  3. `internal/plugin/host.go:780-785`：每次调用 `get(ctx)` 执行宿主调用时，检测到 `hostStale.Swap(false)`，立即执行 `current.retire()` 杀掉 Bun 宿主并重新启动进程。
  4. `internal/gui/pagebridge.js:65` 与 `internal/gui/pluginpage.go:274-320`：设置页虽有 `POST /api/plugin-pages/options`，但后端调用 `plugin.SetPageOptions` -> `SetOptions`（`store.go:648`），内部无条件显式执行 `Restart()`。
  5. 结论：在数据写入主路径（如 `saveMemory` 或后台采集）中做任何写回 `options.memories` 的尝试，无论是调 CLI、调 HTTP API 还是改写文件，都必然导致 Magpie Bun 宿主频繁重启退役，陷入无限重启震荡死循环！
- **落地落点**：
  - **主路（已落地）**：在 `memory.middleware.js` 尾部注入段注入双向轻量引导。在遵守硬约束 #2（绝不碰 system prompt，只追加在最后一条用户消息末尾）前提下，提示模型：遇项目背景/历史规范/配置/报错排查时，优先主动调用 `magpie-memory-hub_memory_context`、`memory_search` 或 `pitfall_search` 检索经验；产生持久事实或报错解法时调用 `memory_save` 或 `pitfall_save` 保存。
  - **辅路（已落地）**：设置页提供受控的「刷新记忆快照到中间件」信标 `sync_snapshot`。用户手动显式点击时触发，由宿主拉取最新 Top-50 活跃记忆（按 `lifecycle_status='active'` 和 `updated_at DESC`），前端桥接调用 `window.magpie.options.set({ memories })`。用户主动点击时的单次重启属于预期内的低频运维动作，完全不影响正常对话。
  - **零残留保证**：整仓清零任何在工具执行或采集热路径中写 options 的代码路径。

### ② 剥离 `compress.js`（彻底保全 KV-Cache）
- **判定与改法**：
  - 从 `memory.middleware.js` 顶部彻底删除 `import { compressBody } from "./compress.js";`；
  - 彻底删除 `memory.middleware.js` 内部 `opts.compress === true` 的压缩调用分支；
  - 记忆注入热路径绝不追溯改写历史任何消息，历史消息 `[0..n-2]` 100% 逐字节不变，彻底保全 KV-Cache；
  - `compress.js` 作为独立文件保留，`package.json` 的 `compress` 维持默认 `false`。

### ③ 收敛为单一状态源
- **判定与改法**：
  - **业务真相源**：运行时持久状态唯一保留 `~/.magpie-memory-hub/state.json`（支持 `secrets`、`actions`、`gateway_harvest`、`pending_patterns`、`r2_mounts`、`harvest_queue`）；
  - **清除僵尸复活漏洞**：彻底移除 `r2.js` 的 `isR2Mounted` 中从 `_status.json` 反向恢复业务状态的错误逻辑与 `STATUS_JSON_PATH` 依赖，后端绝不依赖 `_status.json`；
  - **废弃 `page-actions.json`**：`page_actions.js` 的信标读写（`loadState` / `saveState`）通过 `local_state.js` 的 `lookupActionState()` 与 `rememberActionState()` 统一收敛至 `state.json` 的 `actions` 字段，杜绝多文件竞态与踩踏；
  - **`_status.js` 降级**：严格作为面向前端的单向展示输出（只写不读），供 iframe 内设置页通过 script 标签只读加载。

### ④ 合并三套提炼管线为单一核心引擎
- **判定与改法**：
  - 彻底物理删除 `harvest.py`（1880 行死代码，官方 distroless 容器无 Python）；
  - 同步更新 `package.json` 的 `files` 白名单，移除 `harvest.py`；
  - 同步更新 `README.md` 与测试用例（`tests/check_schema_sync.mjs`、`tests/test_schema_defaults.mjs`），移除对 `harvest.py` 的依赖与扫描；
  - 统一指纹生成：`memories` 统一采用 `semanticFingerprint`，`pitfalls` 统一采用 `fingerprint(`${project}:${component}:${symptom}`)` 并截取 32 位；
  - `gateway_harvest.js`（离线录制增量扫描）与 `gateway_harvest.hooks.js`（实时网络请求钩子）共用同一套指纹与入库版本演进规则。

### ⑤ 去重与检索优化（零 I/O 约束内）
- **判定与改法**：
  - **底层去重**：`mcp_client.js` 的 `buildSelect` 支持安全校验的 `order_by`（如 `updated_at DESC`）。`tools.js` 的 `saveMemory` 与 `gateway_harvest.hooks.js` 的 `triggerBackgroundDrain` 在拉取去重候选集时，统一传递 `{ project, category, lifecycle_status: "active", order_by: "updated_at DESC", limit: 200 }`，直接在 SQL 层面通过索引过滤并按时间倒序排列，彻底杜绝记忆条数增多时跨分类挤出与过期历史挤占；
  - **零 I/O 同义检索**：在 `gateway_harvest.hooks.js` 的 `HARVEST_SYSTEM_PROMPT` 中明确要求模型在 `tags` 中输出 3~5 个同义检索词、别名与关键词（例如针对数据库密码必须包含 `数据库,密码,凭据,db,credential,password`）；
  - **中间件加权**：在 `memory.middleware.js` 中，将 `lexicalScore` 中 `tags` 的权重从 3 提升到 6，并在 `buildIndex` 建立倒排索引时对 `tags` 进行切词索引，实现纯同步、零网络下的同义词精准高召回。

---

## 二、测试与验证状态

核心架构与安全门禁全部全绿通过：
- `test_call_storm_fix.mjs`：7 项测试 100% 通过（自激风暴切断、模型调用预算限流与熔断验证通过）；
- `test_p0_external_fixes.mjs`：全部 P0 缺陷验证 100% 通过（KV-Cache 历史消息逐字节未改、R2 作用域隔离、harvest_gateway 注册通过）；
- `check_schema_sync.mjs`：全部 26/19 列 schema 与代码 100% 同步，旧列名残留校验 0 处，版本号严格对齐；
- `test_schema_defaults.mjs`：外键 0 哨兵值检测通过，时间戳显式写检测通过；
- `test_beacon.mjs` / `test_beacon_e2e.mjs`：信标幂等性、确认门、单一状态源收敛测试全部通过；
- `test_multi_protocol.mjs`：四协议注入、流式/非流式 `<memory>` 剥离 27 项断言全部通过；
- `settings_page_test.mjs` / `verify_settings.mjs`：设置页行为与前端桥接全部通过。
