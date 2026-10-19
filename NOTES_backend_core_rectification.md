# 后端核心数据与引擎修复检查点记录 (NOTES_backend_core_rectification.md)

## 1. 任务启动与环境基线
- **启动时间**: 2026-10-19
- **基线 Commit**: `4d67847` (v6.28.3)
- **发布版本**: `v6.29.0` (package.json 与 settings.html 严格同步)
- **执行环境**: 专属独立云端沙箱 (`/workspace/magpie-memory-hub`)，严禁本机执行，所有测试在沙箱 Node 24 下跑通。
- **协同分工**: 前端 UI/设置页卡片/文档由 Agent 2 在独立分支处理；本任务聚焦于后端与核心逻辑文件（tools.js, local_state.js, page_actions.js, gateway_harvest.hooks.js, gateway_harvest.js, r2.js, mcp_client.js 等）。

## 2. 10 项核心整改清单执行结果 (100% 全部完成)
- [x] **P0-1**: `tools.js:607-624` memorySearch 投影列补齐 `"invalid_at"` 与 `"expires_at"`，确保 isMemoryValid 准确过滤临时与失效记忆。并在 `tests/test_p0_external_fixes.mjs` 中为 Mock Client 增加了严格字段裁剪与失效/过期过滤断言。
- [x] **P0-2**: `tools.js:1401, 1528, 1682` memoryAudit 游标双表拆分为 `last_memory_id` 与 `last_pitfall_id`，杜绝跨表自增主键漏检；游标初始与空值以 `null` 表达，彻底杜绝 NCB 外键列哨兵值 0。
- [x] **P0-3**: `local_state.js:567` recordPendingEvidence 接入 `semantic_dedup.js` 的 `isSemanticallySimilar` 语义判定，同 project + kind: "pitfall" 时做语义模糊去重；统一 `tools.js:865`、`gateway_harvest.hooks.js:952`、`gateway_harvest.js:569` 中的 pitfall 指纹算法（`semanticFingerprint(project, "pitfall", component, symptom)`）。
- [x] **P1-5**: `tools.js` 增加 `_isAuditing` 全局并发互斥锁（重入直接返回 `skipped: true`）；`page_actions.js:351` 异步去重闭包直接调用 `memoryAudit` 方法，避免将 options 当作 input 递归调用 MagpieMemoryHub 造成状态与调度器重复初始化。
- [x] **P1-6**: `tools.js` 统一导出 `makeClient(cfg)`，并在 `page_actions.js`、`gateway_harvest.hooks.js` 中使用 `makeClient(cfg)`，支持 `ncb_secret`（REST 模式）回退。
- [x] **P1-7**: `tools.js` 中 `memorySearch`（top 命中文档）和 `memoryContext`（matchedMemories 命中文档）异步非阻塞（`Promise.allSettled`）递增 `retrieval_count` 并更新 `last_used_at` 与 `updated_at`。
- [x] **P1-8**: `tools.js:801-829` memoryContext 增加对 `category === "principle"` 准则的无条件置顶支持（最多 `max_principles` 条，默认 2），与网关中间件保持一致。
- [x] **P1-10**: `r2.js:636` r2Upload 补上 `await resolveRealDatabase(cfg, rawDb)`，消除真实库名前缀缺失隐患。
- [x] **P2-12**: `tools.js` memoryAudit 合并去重时合并 `tags` 与 `related_entities`，准确累加全部 duplicate 的 `recurrence` 计数（memories 与 pitfalls 双表均支持）。
- [x] **P2-13**: `tools.js` fetchAll 传入 `order_by: "updated_at DESC"`；`mcp_client.js` 对 `order_by` 做严格安全正则白名单与标识符双重校验。

## 3. 门禁与自动化测试验证
- `test_meta.mjs`: 43 个测试文件元检查 100% PASS。
- `check_schema_sync.mjs`: Schema 声明、写入字段、版本号同步（v6.29.0）100% PASS。
- `settings_page_test.mjs`: 静态检查 + 16 个真实交互测试 100% PASS。
- `verify_settings.mjs`: 11 个大项验收 100% PASS，残余为 0。
- `test_schema_defaults.mjs`: 外键列零哨兵值 0、时间戳全部显式写入 100% PASS。
- `test_exports.mjs`: tools.js 与中间件导出面合规性 100% PASS。
- `test_p0_external_fixes.mjs`: P0-1/2/3 专项测试 100% PASS。
- `test_tool_names_static.mjs`: 21 个 MCP 工具静态引用断言 100% PASS。
- `test_dedup_semantics.mjs`: 语义去重专项测试 100% PASS。
- `test_state_bloat_and_dead_letter.mjs`: state.json 防膨胀与死信淘汰 100% PASS。
- `test_search_enhancement_and_scale.mjs`: 检索增强与规模化专项测试 100% PASS。
- `test_auto_dedup_and_undo.mjs`: 自动去重与时间点撤销 100% PASS。
- 全量自动化测试扫描：41 个 PASS，4 个 SKIP（远端网络测试无 live key 正常跳过），0 FAIL。
