# Agent A 检查点报告：审计数字守卫与游标边界精修 (v6.35-a)

## 任务背景
- **沙箱 ID**: `36d34bb5424645c5aabb79872c551d76`
- **代码目录**: `/workspace/m`
- **工作分支**: `feat/v635-a-tools`
- **文件所有权**: 独占修改 `tools.js` 与 `tests/test_v635_a_tools.mjs`，编写 `NOTES_v635_a.md`。严禁修改其他共享模块、文档与历史测试文件。

---

## 3 项整改方案与技术实现

### 1. 【P1-1】数字守卫的「先标记后校验」与「跨字段拼接」双缺陷（tools.js 约 2070-2198、2228-2245、2350-2470）
- **问题根因**:
  - a) **先标记后校验**：`modelHandledIds` 与 `attachedOrphanIds` 在执行 `hasConflictingNumbers` 数字守卫校验之前就将模型返回的 ID 记录为已处理。当在线模型发生幻觉（例如将包含 3306 端口的记录与 3307 端口的记录归为一组）后，虽然该模型组合并被数字守卫拦截抛弃，但 3306 记录及其孤儿副本已从规则组中剔除，导致 3306 记录自身的确定性精确重复项被拆毁、无法完成软失效合并，发生数据漏删。
  - b) **跨字段全文本拼接**：在校验数字冲突时，将「标题+正文」拼成 `pAllText` / `dAllText`，将踩坑「症状+方案+根因」拼成 `textA` / `textB` / `pText` / `dText` 后整体调用 `hasConflictingNumbers`。当两条踩坑记录 symptom 均包含 "3306"、且 root_cause 一致，但其中一条记录的 solution 多写了 "重试 3 次" 时，由于全文本数字集合 `{3306}` 与 `{3306, 3}` 大小不同，被误判为数字冲突而拒绝本应合并的重复记录。
- **修复方案**:
  - a) 颠倒执行顺序：在处理模型返回的去重组（`mDups` / `pDups`）时，**先**执行逐项分字段数字守卫过滤，仅将通过校验且去重后依然非空、有效的模型组记入 `modelHandledIds`；被守卫拦截无效的模型组不记入 `modelHandledIds`，完全保留其原有规则组，确保 3306 的确定性规则查重正常进行。
  - b) 移除所有跨字段全文本拼接：在 memories 中改为标题对标题（`title` vs `title`）、正文对正文（`content` vs `content`）分字段独立校验；在 pitfalls 中改为症状对症状（`symptom` vs `symptom`）、方案对方案（`solution` vs `solution`）、根因对根因（`root_cause` vs `root_cause`）分字段独立校验。任一对应字段存在真实冲突才拦截，消除因字段间数字多寡不同造成的误拒。
- **反证门 1 设计（双向断言）**:
  - 1a) **该合必须合（规则保护）**：构造「模型误把 3306 端口合入 3307 端口 + 3306 自己还有一条精确重复副本」的场景。断言模型组被守卫拦截，且 3306 自身的重复项未被拆毁，仍被确定性规则组正确软失效合并。
  - 1b) **该合必须合（字段独立）与该拒必须拒（真实冲突拦截）**：构造两条踩坑记录同 symptom 包含 3306、solution 一多一少（一侧有重试 3 次，一侧无数字），断言因分字段独立校验，两条记录正常去重合并；同时构造 symptom 包含 3307 的第三条记录，断言与 3306 记录严格互斥拒绝合并。

---

### 2. 【P1-2】readOptions 三元表达式顺序错 + MODEL_CHUNK 覆盖优先级错（tools.js 约 123-126、2055、2342）
- **问题根因**:
  - a) **readOptions 三元短路**：在 `readOptions` 的 `dedup_fetch_limit` 计算中，false 分支写为 `(o.dedup_batch_size || o.dedup_fetch_limit || 200)`。由于 `dedup_batch_size` 默认值为 50（恒为真值），导致 false 分支恒短路返回 50，调用方/设置页传入的 `dedup_fetch_limit: 200`（或自定义值）被恒定忽略。
  - b) **MODEL_CHUNK 覆盖优先级倒置**：`const rawChunk = Number(cfg.audit_chunk_size ?? auditOptions.audit_chunk_size ?? 40);` 中，`cfg.audit_chunk_size` 排在 `auditOptions` 之前，导致调用参数 `args.audit_chunk_size` 无法覆盖全局/持久化配置 `cfg`。
- **修复方案**:
  - a) 将 `readOptions` false 分支调整为 `(o.dedup_fetch_limit || o.dedup_batch_size || 200)`，保证 `dedup_fetch_limit` 优先命中。
  - b) 将 `rawChunk` 计算调整为调用参数优先：`Number(args.audit_chunk_size ?? cfg.audit_chunk_size ?? 40)`，使单次调用传入的 `args.audit_chunk_size` 能正确覆盖 `cfg`。
- **反证门 2 设计（双向断言）**:
  - 2a) **fetch_limit 优先断言**：配置 `dedup_batch_size = 50, dedup_fetch_limit = 200`，断言实际 `readOptions` 返回及下游实际拉取上限为 200，绝不被默认值 50 覆盖。
  - 2b) **args 覆盖 cfg 与边界守卫断言**：当 `cfg.audit_chunk_size = 40`，传入 `args.audit_chunk_size = 25` 时，断言 `MODEL_CHUNK` 精确为 25；同时断言边界溢出值（如 80 与 2）被 `[5, 60]` 守卫分别钳制在 60 与 5。

---

### 3. 【P1-4】跨周期复用旧游标导致漏扫（tools.js 约 2558-2566、2645-2675）
- **问题根因**:
  - 当一轮全表扫描完成（`truncated === false`）后，表尾游标依然保存在持久化状态中；次日或下周开启新一轮定时周期时（`isPending === false`），`checkScheduledDedup` 仍携带旧游标以 `incremental: true` 执行，导致 `memoryAudit` 直接跳过所有 `id <= oldMaxId` 的既有记录，新周期的定时全量体检形同虚设。
- **修复方案**:
  - 在 `checkScheduledDedup` 中，当 `!isPending`（即本轮为新周期的首次触发，而非 5 分钟截断接力）时，显式调用 `clearAuditCursor(project)` 重置游标，保证新周期从头完整扫描；而在接力场景下（`isPending === true`）保留游标不清理，维持正常截断断点续跑。
- **反证门 3 设计（双向断言）**:
  - 3a) **完整周期后游标保存断言**：运行完整一轮去重（`truncated: false`），断言游标已写入且指向当前最大 ID。
  - 3b) **新周期首发重置与漏扫消除断言**：模拟新一天定时周期到达（`isPending: false`），断言触发执行前游标已被重置清除，且调度器成功扫描并去重此前存在的更小 ID 既有记录；同时断言若处于接力状态（`isPending: true`），游标安全保留不被清理。

---

## 验收计划与执行步骤
1. 编写 `NOTES_v635_a.md`（已完成）。
2. 在 `tools.js` 独占实施上述 3 项精修。
3. 创建 `tests/test_v635_a_tools.mjs`，包含 3 大专项双向反证测试门，严守 `test_meta.mjs` 规范（独立命名空间、写库必须清理、残余断言为 0、自检 scanTestFile）。
4. 运行全量核心测试套件，确保 100% 通过。
5. 提交 git commit 并推送至 `origin/feat/v635-a-tools`。
