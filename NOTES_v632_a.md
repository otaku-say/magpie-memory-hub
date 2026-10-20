# Agent A 检查点：tools.js 高危项整改验收报告 (v6.32)

## 任务背景
在沙箱 `9c04f4d59e1942e29a21c39ec7ddfb08` 的 `/workspace/m` 目录、`feat/v632-a-tools` 分支，独占修改 `tools.js` 完成 5 项高危整改，并新建专项反证测试 `tests/test_v632_a_tools.mjs`，确保全量测试通过并提交推送。

## 5 项核心整改项完成状态

1. **【P0-4 最紧急】memoryAudit 模型仲裁自删主记录修复 (tools.js 约 2015-2026、2167-2178)** [已完成]
   - **根因**: 重构解耦拉取批与模型分块后，`dItems` 过滤映射丢失了 `id !== pId` 与全局已消费过滤。若模型返回的 duplicate_ids 中包含了 primary_id，主记忆会被错误软失效、主踩坑会被误删。
   - **修复**:
     - 记忆与踩坑两段模型仲裁均恢复严格三重过滤：`dIds.includes(r.id) && r.id !== pId && !modelDupIds.has(r.id)`。
     - 每消费一个 id 立即加入 `modelDupIds`，防止跨组重复消费。
     - 在后续软失效与删除执行循环中追加双保险断言：`if (!d || d.id === p.id) continue;`，彻底杜绝自删主记录。

2. **【P1-2】memoryAudit 全量截断游标丢失与配置断层修复 (tools.js 约 121、1890、1990、2284、2360)** [已完成]
   - **根因**: 原实现只在 `isIncremental === true` 时保存游标；当 `full: true` 扫描达到 `fetch_limit` 截断退出时，未持久化游标，导致后续增量扫描永远从第 1 条重扫陷入死循环；且 `readOptions` 将 `dedup_batch_size` 限制在 200，忽略了设置页配置的 1000 上限。
   - **修复**:
     - 截断退出时保存游标：`if (isIncremental || truncated) saveAuditCursor(...)`，确保全量截断后二次调用可从断点处无缝续跑。
     - `readOptions` 与 `memoryAudit` 支持 `dedup_batch_size` 高达 1000（fetch 上限硬顶 1000），优先读取 `args.fetch_limit || args.limit || args.batch_size || cfg.dedup_fetch_limit || cfg.dedup_batch_size`。
     - `groups.length === 0` 时绝不跳过模型仲裁：仍将整批候选提交给 `auditMemoriesWithModel`（受 `maxModelBatches` 预算约束）。

3. **【P1-3】principle 准则免降级与免软删保护 (tools.js 约 596-629、1957-1983)** [已完成]
   - **根因**: `saveMemory` 跨类去重命中旧 fact 时直接复用旧分类将准则降级为 fact；`memoryAudit` 规则合并仅按 recurrence / updated_at 排序，导致准则被当成 duplicate 软失效。
   - **修复**:
     - `saveMemory`: 跨类去重命中时检测 `isNewPrinciple = category === "principle" && crossDup.category !== "principle"`。命中时将既有记录在库中升级为 `principle` 并保留准则内容，绝不降级。
     - `memoryAudit`: 规则合并排序时增加权重，组内存在 `category === "principle"` 时强制排在首位作为 primary；并在模型仲裁合并与软失效循环中多重校验，绝不软失效准则。

4. **【P1-1】tools.js 内 5 处前置短路数字冲突守卫 (约 534、1277、1320、1973、2127)** [已完成]
   - **根因**: `saveMemory` 踩坑优先、`pitfallSave` 记忆软失效、`pitfallSave` 踩坑去重、`memoryAudit` 记忆查重、`memoryAudit` 踩坑查重 5 处在调用 `isSemanticallySimilar` 之前均有 `includes` 或 `overlapCoefficient` 短路条件，绕过了数字冲突守卫，直接将不同端口（80 vs 8080）或版本（Node 18 vs Node 20）误判为重复。
   - **修复**: 从 `./semantic_dedup.js` 导入 `hasConflictingNumbers`，在全部 5 处前置短路分支前均严格校验 `!hasConflictingNumbers(a, b)`。

5. **【P2-4】ensureAuditScheduler 闭包陈旧修复 (tools.js 约 2360-2480、2780)** [已完成]
   - **根因**: 定时器闭包内捕获的 `cfg` 和 `client` 是模块加载期初始快照，用户在设置页修改了 `project`、`dedup_batch_size` 或连接凭据后定时去重无法感知。
   - **修复**:
     - `ensureAuditScheduler(client, cfg, optionsGetter)` 支持传入 `optionsGetter`。
     - 宿主挂载时传入 `() => readOptions(input || options)`。
     - 定时器每次触发时调用 `getFreshCfg()` 动态获取最新配置，并按需构建最新 client，保证 project 与 batch/fetch 上限永远最新。

## 验收测试套件 tests/test_v632_a_tools.mjs 覆盖

- **反证门 a**: 故意构造模型返回 `primary_id` 包含在 `duplicate_ids` 中的响应，验证主记录（记忆与踩坑）绝对不被软失效或物理删除，且 recurrence 正确累加。
- **反证门 b**: `full: true` 配合 `fetch_limit: 2` 触发全量截断，验证本地状态游标成功保存，二次增量调用无缝续跑绝不重扫前 2 条。
- **反证门 c**: 跨类去重与 audit 规则合并双场景验证 `principle` 准则免降级与免软删保护。
- **反证门 d**: Port 80 vs Port 8080 与 Node 18 vs Node 20 跨全部短路场景验证数字冲突守卫严格生效。
- **调度器测试**: 动态 options 响应测试，验证设置页参数动态读取。
- **元规范自检**: 集成 `scanTestFile` 自检，0 违规，且零残留断言通过。

## 测试运行结果
- `node tests/test_meta.mjs` -> ✅ PASS (50/50 测试合规)
- `node tests/test_exports.mjs` -> ✅ PASS (导出面 100% 合规)
- `node tests/test_dedup_and_audit.mjs` -> ✅ PASS
- `node tests/test_auto_dedup_and_undo.mjs` -> ✅ PASS
- `node tests/test_dedup_semantics.mjs` -> ✅ PASS
- `node tests/test_v631_a_tools.mjs` -> ✅ PASS
- `node tests/test_v632_a_tools.mjs` -> ✅ PASS
