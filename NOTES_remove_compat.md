# 清理向后兼容代码执行计划与检查点 (NOTES_remove_compat.md)

## 1. 原则与用户长期授权
- 用户长期授权：「**插件代码不用做过时内容的兼容**」。
- 若删了兼容代码后有测试变红，说明该测试在依赖过时行为，本身也应一并清理（「不需要的测试都移除」）。
- 绝不改动版本号、不执行 git commit / git push。
- 严禁向用户生产库（如 41694_agent_memory）写入任何测试数据（必须隔离 `__test__`、测试后清理且残余断言为 0）。

## 2. 协作边界与文件所有权（并行代理防护）
- **禁止修改（正被其他代理改动）**：
  - `gateway_harvest.hooks.js`
  - `gateway_harvest.js`
  - `model_check.js`
  - `tools.js`
  - `package.json`
  - `settings.*` (`settings.js`, `settings.html`, `settings.css`)
- **本任务责任范围**：
  - `r2.js`
  - `compress.js`
  - `db_tools.js`
  - 以及属于上述文件直接关联的测试脚本

## 3. 全仓扫描候选与逐项裁决

| 编号 | 命中位置 | 代码/摘要 | 判定 | 理由与处置方案 |
|---|---|---|---|---|
| 1 | `r2.js:340, 353-369` | `// 2. 检查 _status.json（平滑兼容历史状态）` | ✗ **真兼容代码** | 历史升级前兼容分支，应只以 `local_state` (`lookupR2Mount`) 为唯一真相源。**从 r2.js 彻底删除**，并移除未使用的 `fs` 与 `path` import。 |
| 2 | `compress.js:949-956, 1082` | `volatilityScore(text)` 及 export | ✗ **真兼容代码** | 易变内容计分旧函数，已全部由 `CacheAligner` 替代，全仓 0 调用方。**彻底删除函数与 export**。 |
| 3 | `db_tools.js:36` | `// 兼容两种命名：readOptions 映射出的是 instance；直接传原始 options 时是 ncb_instance` | ✗ **真兼容代码** | 同进程内的冗余回退。已验证全仓调用方（`tools.js`, `page_actions.js`, 测试用例）均统一传递 `cfg.instance`，无调用方传 `ncb_instance`。**统一为 `cfg.instance`，删除回退分支与注释**。同步清理 453, 597 行同类残留。 |
| 4 | `r2.js:44, 94, 344` | `(cfg && (cfg.instance || cfg.ncb_instance))` | ✗ **真兼容代码** | 同上，r2.js 内部的 `cfg.ncb_instance` 回退，统一为 `cfg.instance`。 |
| 5 | `gateway_harvest.js:1330` | `heuristic_fallback: true`（遗留测试兼容） | ✗ **真兼容代码（跨文件边界）** | 另一个代理正在重构 gateway_harvest，**列入报告交接，不跨权修改**。 |
| 6 | `gateway_harvest.hooks.js:386` | `// 4. Legacy single prompt` | ⚠️ **协议容忍/跨边界** | 兼容传入 prompt 而非 messages 的 completions 接口；且文件属并行代理所有权，**不触碰**。 |
| 7 | `schema.js:203, 223` | `兼容两种输入形态` / `兼容 column_name / Field 别名` | ✓ **合法用法** | 数据库接口返回格式容错（形态 A / 形态 B），非过时软件版本兼容。**保留**。 |
| 8 | `settings.html:167` / `r2.js:708` | `S3 兼容 API` | ✓ **合法用法** | 行业标准对象存储规范术语，非兼容代码。**保留**。 |
| 9 | `settings.css:660` | `兼容现有 paintDbStatus 结构` | ✓ **合法用法** | UI DOM 选择器适配，且属并行代理文件。**保留**。 |
| 10 | `compress_text.py:504` | `严禁在生产环境直接运行 v2.4.1 之前的旧版本` | ✓ **合法用法** | 测试用例文本样本。**保留**。 |
| 11 | `tools.js:191`, `ncb_mcp.js:165`, `db_tools.js:693` | `res.status === 401/403/502` | ✓ **合法用法** | HTTP 响应码判断，非过时数据列。**保留**。 |
| 12 | `settings.js:345, 630`, `page_actions.js:96` | `prog.status === "downloading"` | ✓ **合法用法** | UI 下载进度状态。**保留**。 |
| 13 | `tools.js:440` | `旧版本行不可达，已跳过 supersede 标记` | ✓ **合法用法** | 数据行版本状态生命周期描述，非软件旧版本。**保留**。 |
| 14 | `tests/test_schema.mjs:64, 103, 128` | 模拟旧库缺少列测试增量迁移 | ✓ **合法用法** | 核心增量 DDL 迁移功能验证。**保留**。 |
| 15 | `check_schema_sync.mjs:123` | `现已彻底删除所有针对数据库列改名的兼容代码...` | ✓ **合法用法** | 架构门禁文档说明。**保留**。 |

## 4. 实施检查点 (Checkpoints)
- [ ] **Check 1**: 在 `r2.js` 中删除 `_status.json` 的平滑兼容读取分支（第 353-369 行），更新注释，并移除顶部未使用的 `import fs` 和 `import path`。
- [ ] **Check 2**: 在 `r2.js` 中清理 `cfg.instance || cfg.ncb_instance` 为 `cfg.instance`。
- [ ] **Check 3**: 在 `compress.js` 中删除 `volatilityScore` 函数（第 949-956 行）及其导出（第 1082 行）。
- [ ] **Check 4**: 在 `db_tools.js` 中清理 `cfg.instance || cfg.ncb_instance` 为 `cfg.instance`，清理相关注释。
- [ ] **Check 5**: 全局 `rg` 确认无遗漏或断裂调用。
- [ ] **Check 6**: 运行全套相关测试验证，记录真实测试结果。
