# Agent A 检查点报告：调度器接力与审计仲裁修复 (v6.34-a)

## 任务背景
- **沙箱 ID**: `88ae31e7d2ca494e966abb94d2152dbf`
- **代码目录**: `/workspace/m`
- **工作分支**: `feat/v634-a-tools`
- **文件所有权**: 独占修改 `tools.js` 与 `tests/test_v634_a_tools.mjs`，编写 `NOTES_v634_a.md`。严禁修改其他共享模块与测试文件。

## 4 项整改方案与技术实现

### 1. 【P1-1】调度器关闭不彻底 + 定时接力被阻断（tools.js 约 2394、2500-2528、2990-2995）
- **问题根因**:
  - a) 当设置页把 `dedup_schedule` 改回 `off` 时，入口处原代码在 `if (dedupSched !== off)` 外直接跳过，既没有调用 `stopAuditScheduler()` 也没有刷新 `_auditOptionsGetter`，导致旧定时器句柄继续按原配置后台空转。
  - b) `checkScheduledDedup` 定时触发调用 `memoryAudit` 时未传 `incremental: true`；且当单次达到批次上限截断（`has_more: true`）时，原代码仍无条件更新 `last_dedup_at: nowSql()`，导致 5 分钟后的自动接力触发被判定为「今天刚跑过」而跳过，截断数据永久卡死。
- **修复方案**:
  - a) 入口处无条件刷新模块闭包 `_auditOptionsGetter` 与基础配置，当 `dedupSched === off || dedupSched === none` 时显式调用 `stopAuditScheduler()` 并清理定时器句柄；`ensureAuditScheduler` 内部若检测到 schedule 为 off 亦显式停止。
  - b) `checkScheduledDedup` 调用 `memoryAudit` 时显式传入 `incremental: true`；在 `memoryAudit` 结束持久化状态时，若本轮截断（`truncated === true`），保持原 `last_dedup_at` 不更新（或保留旧值）并置位 `last_dedup_pending: true`；`checkScheduledDedup` 检测到 `isPending` 时判定为超期并立刻接力执行。
- **反证门 1 设计**:
  1. 验证 daily → off 彻底停止：初始化 daily 调度器，随后传入 off 配置，断言定时器被清理、状态为 stopped，且手动触发 `runScheduled()` 立即拒绝执行。
  2. 验证 has_more 自动接力：构造超出单批拉取上限的数据集，第一次触发返回 `has_more: true`，断言 `last_dedup_pending: true`；连续触发第二次调度，断言第二次调度被真实接力执行且成功处理下一分批。

---

### 2. 【P1-2】readOptions 漏字段 + dedup_fetch_limit 恒真遮蔽用户配置（tools.js 约 88-135、1916、2041、2258）
- **问题根因**:
  - a) `readOptions()` 漏拷贝 `project`、`audit_chunk_size`、`audit_max_batches`、`rerank_model`，导致下游在 `cfg` 中读取恒为 `undefined`。
  - b) `package.json` 里 `dedup_fetch_limit` 默认声明为 200 恒为真值，原代码使用 `o.dedup_fetch_limit || o.dedup_batch_size || 200` 与 `cfg.dedup_fetch_limit || cfg.dedup_batch_size || 200`，导致 200 恒先命中，用户在设置页修改 `dedup_batch_size` 完全被遮蔽无效。
- **修复方案**:
  - a) `readOptions` 补齐 4 个字段并赋予严谨默认值：`project: global`、`audit_chunk_size: 40`、`audit_max_batches: 1`、`rerank_model: `。
  - b) 拉取上限优先级调整为：显式调用参数 `args.fetch_limit` > 用户配置的 `cfg.dedup_batch_size` > `cfg.dedup_fetch_limit` > 200。
  - c) `MODEL_CHUNK` 统一使用 `Math.max(5, Math.min(chunk, 60))` 增加 [5, 60] 范围守卫。
- **反证门 2 设计**:
  1. 配置 `dedup_batch_size = 300`，执行去重，断言实际拉取批上限为 300 而非被遮蔽的 200。
  2. 配置 `audit_chunk_size = 25`，断言 `MODEL_CHUNK` 精确为 25；测试边界溢出值（如 70 与 2），断言分别被范围守卫钳制在 60 与 5。

---

### 3. 【P1-3】单条精确重复被丢弃 + 模型合并结果未过数字守卫（tools.js 约 2066-2114、2281-2320）
- **问题根因**:
  - a) 当规则组 `g.primary` 被模型仲裁命中为重复（或被选为主记录），而其原有规则精确重复列表 `unhandledDups` 仅剩 1 条时，原代码 `if (unhandledDups.length > 1)` 判断为假，该孤儿重复记录被直接忽略丢弃，既未参与模型合并也未作为规则组合并，永久漏删。
  - b) 模型仲裁返回的从记录列表 `dItems` 未校验 `hasConflictingNumbers`，若模型发生幻觉将不同端口（如 3306 与 3307）或版本号判定为重复，将被直接合并，导致关键数字冲突数据损毁。
- **修复方案**:
  - a) 当 `unhandledDups.length === 1` 时，暂存该规则副本，并将其挂入主记录所属的模型组（无论是作为主记录还是作为从记录）中一并执行合并与软失效；未被模型组消费的孤儿安全回退合并。
  - b) 模型仲裁解析每条从记录时，逐条执行 `hasConflictingNumbers(primary, duplicate)` 校验，出现标题、正文或全文本数字冲突的从记录立即剔除，绝不合并。
- **反证门 3 设计**:
  1. 构造规则组主记录被模型选为另一组 primary、且规则组仅剩 1 条 dup 的场景，断言该孤儿 dup 仍被正确软失效。
  2. 构造模型模拟返回将 3306 与 3307 判定为同一组重复，断言数字冲突守卫拦截生效，两条记录均保持 valid，拒绝误合并。

---

### 4. 【P1-5】pitfalls 查询缺 invalid_at 过滤 + 分页提前断页 + 投影漏列（tools.js 约 1971、2197-2211、2373）
- **问题根因**:
  - a) `pitfalls` 列表查询未传 `invalid_at: null`，已软删记录仍被拉取；内存过滤软删记录后，有效行数 `rows.length < dbFetchLimit` 触发提前 `break`，导致批次误判为全部完成，`has_more` 恒为 `false`，后续未处理记录永久断页。
  - b) `memories` 查询 columns 投影漏选 `related_entities`、`invalid_at`、`expires_at`，导致实体合并时 `p.related_entities` 恒为 `undefined` 无法合并，且在投影模式下 `r.invalid_at` 缺失影响有效性判定。
- **修复方案**:
  - a) `pitfalls` 查询显式传入 `invalid_at: null`；在分页截断判定处，一律使用未过滤前的原始数据行数 `rawRows.length < dbFetchLimit` 对比拉取上限，只要数据库返回了整页原始行即判定仍有数据。
  - b) `memories` 查询 columns 投影补齐 `related_entities`、`invalid_at`、`expires_at`，保证实体合并与有效性判定完全正常。
- **反证门 4 设计**:
  构造「包含 1 条软失效记录 + 达到拉取批上限的有效记录」批次，断言过滤后即使有效条数小于上限，分页仍正确判定 `has_more: true`，且游标正确推进到后续记录。

## 验收计划与执行顺序
1. 编写 `NOTES_v634_a.md`（本文件）。
2. 在 `tools.js` 独占实现上述 4 项修复。
3. 创建 `tests/test_v634_a_tools.mjs`，包含 4 大专项反证测试，严格遵守 `test_meta.mjs` 规范（createTestEnv/env.project/cleanup/residue===0）。
4. 运行验证全量核心测试套件。
5. Git 提交并推送至 `feat/v634-a-tools`。
