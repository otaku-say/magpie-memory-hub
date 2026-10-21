# NOTES_v640_a: 修复铁律死循环与更新残留，实现 EVO-18 双表演进感知

## 1. 任务背景与核心问题

在 v6.39 版本的演进契机感知与铁律升维体系中，排查发现以下三项高危/中危缺陷与一项演进能力缺失：

1. **BUG-39-1: near_ironlaw 缺上界致死循环提示（高危）**
   - **位置**: tools.js:1707
   - **根因**: if (rec >= (crystallizationThreshold - 1) && !rcIsPlaceholder && !solIsPlaceholder) 只有下界缺少上界。当踩坑记录复发次数达到或超过结晶阈值（如 rec=5, threshold=5）时，条件依然成立，Math.max(1, crystallizationThreshold - rec) 恒等于 1。
   - **影响**: 即使铁律已自动生成，memory_context 依然反复提示「再记录 1 次该故障即可自动生成铁律」，形成恶性死循环诱导 Agent 无限重复调用 pitfall_save。
   - **方案**: 增加严格上界 rec < crystallizationThreshold，将触发窗口锁定在 [crystallizationThreshold - 1, crystallizationThreshold)。

2. **BUG-39-4b: 更新既有铁律漏写 confidence_score（高危残留）**
   - **位置**: tools.js:1914 附近（existingPrinciple 演进更新分支）与 tools.js:1971 附近（duplicate-entry 兜底分支）
   - **根因**: 在 v6.39-a 中新建铁律显式写入了 confidence_score: 100，但在二次演进更新既有铁律时，两处 client.update 载荷均漏写了 confidence_score: 100。
   - **影响**: 若铁律此前存在历史遗留异常分数（例如置信度为 1），演进更新路径无法自愈恢复为满分 100。
   - **方案**: 在两处 client.update 载荷中同语句显式补齐 confidence_score: 100 与 updated_at: nowSql()。

3. **BUG-39-4c: 唯一索引冲突兜底漏合并 tags（中危残留）**
   - **位置**: tools.js:2119 附近（pitfallSave 的 duplicate-entry catch 里 hasSolConflict 保护分支）
   - **根因**: 当新旧解法存在数字冲突时，只更新了 { recurrence, last_occurred_at, updated_at }，未写入 tags: mergedTags || dup.tags，同时传给 checkAndApplyIronlaw 的也是 dup.tags 而非合并后的标签。
   - **影响**: 走唯一索引冲突分支时，新传入的业务标签被静默丢弃。
   - **方案**: 提前计算 mergedTags，在 client.update 和后续调用中显式传入 tags: mergedTags || dup.tags。

4. **EVO-18: memory_context 双表全向演进契机（能力演进）**
   - **位置**: tools.js:1710 附近 memoryContext 契机分析段
   - **需求**: 对称于踩坑侧的 near_ironlaw，构建记忆侧的 near_crystallization 契机。
   - **规则**: 从本次召回的 matchedMemories 中筛选：
     - category 为 preference 或 decision
     - recurrence 恰好等于 crystallizationThreshold - 1
     - confidence_score >= 80
   - **输出**: { id, category, title: cut(title, 60), recurrence, missing: 1 } 挂载到 evolution_opportunities.near_crystallization。
   - **动态提示**: _agent_hint 追加「另有 N 条偏好/决策再印证 1 次即可结晶为准则。」
   - **边界约束**: 无候选时 near_crystallization 不得输出（省略/undefined）。

---

## 2. 详细实现细节

### 2.1 tools.js 修改点

1. **tools.js:1707 (BUG-39-1)**
   ```js
   // 修改前
   if (rec >= (crystallizationThreshold - 1) && !rcIsPlaceholder && !solIsPlaceholder) {
   // 修改后
   if (rec >= (crystallizationThreshold - 1) && rec < crystallizationThreshold && !rcIsPlaceholder && !solIsPlaceholder) {
   ```

2. **tools.js:1710+ (EVO-18)**
   遍历 matchedMemories：
   ```js
   const nearCrystallization = [];
   for (const m of matchedMemories) {
     const cat = String(m.category || "").toLowerCase();
     if (cat === "preference" || cat === "decision") {
       const mRec = Number(m.recurrence) || 1;
       const mConf = Number(m.confidence_score) || 0;
       if (mRec === (crystallizationThreshold - 1) && mConf >= 80) {
         nearCrystallization.push({
           id: m.id,
           category: m.category,
           title: String(m.title || "").slice(0, 60),
           recurrence: mRec,
           missing: 1,
         });
       }
     }
   }
   ```
   组装 dynamicAgentHint 与 evolution_opportunities：
   ```js
   if (nearCrystallization.length > 0) {
     dynamicAgentHint += ` 另有 ${nearCrystallization.length} 条偏好/决策再印证 1 次即可结晶为准则。`;
   }
   const hasEvolutionOpportunities =
     nearIronlaw.length > 0 || chronicWithoutRootCause.length > 0 || nearCrystallization.length > 0;
   ...
   if (hasEvolutionOpportunities) {
     const evo = {
       near_ironlaw: nearIronlaw,
       chronic_without_root_cause: chronicWithoutRootCause,
     };
     if (nearCrystallization.length > 0) {
       evo.near_crystallization = nearCrystallization;
     }
     contextResult.evolution_opportunities = evo;
   }
   ```

3. **tools.js:1914 & tools.js:1971 (BUG-39-4b)**
   在两个更新铁律的 client.update("memories", ...) 载荷中添加：
   ```js
   confidence_score: 100,
   updated_at: nowSql(),
   ```

4. **tools.js:2119 (BUG-39-4c)**
   在 pitfallSave 的 duplicate entry 处理中提前计算 mergedTags：
   ```js
   const existingTags = String(dup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
   const incomingTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
   const mergedTags = Array.from(new Set([...existingTags, ...incomingTags])).join(", ");
   ```
   在 hasSolConflict 分支更新：
   ```js
   await client.update("pitfalls", dup.id, {
     recurrence: next,
     tags: mergedTags || dup.tags,
     last_occurred_at: now,
     updated_at: now,
   });
   ```

---

## 3. 双向反证测试矩阵 (tests/test_v640_a_iron.mjs)

1. **BUG-39-1 反证门**:
   - rec=4, threshold=5: 必须进入 near_ironlaw，且 missing=1；
   - rec=5, threshold=5: near_ironlaw 必须为空数组，_agent_hint 严禁出现「再记录」提示；
   - rec=6, threshold=5: near_ironlaw 必须为空数组。

2. **BUG-39-4b 反证门**:
   - 插入一条历史损坏铁律（confidence_score: 1）；
   - 触发一次二次演进更新；
   - 查库断言 confidence_score === 100（置信度自愈）；
   - 断言 content, tags, related_entities, recurrence 均正确更新。

3. **BUG-39-4c 反证门**:
   - 预埋一条踩坑记录（solution: "设置 write 线程池 queue_size=1000 并限制单次 bulk 请求文档批次为 500 条", tags: "es, bulk, initial-tag"）；
   - 模拟唯一索引冲突并发竞态（client.create 抛出 Duplicate entry 异常，进入 catch 块）；
   - 新解法存在数字冲突（1000 vs 2000, 500 vs 800），触发 hasSolConflict 保护分支；
   - 断言命中 hasSolConflict 分支，库中记录 tags 成功合并为包含 initial-tag, conflict-patch, v640；
   - 断言 recurrence 正确累加，旧解法未被破坏覆盖。

4. **EVO-18 双向反证门**:
   - 正向 反证 a: preference, recurrence=4, confidence_score=90 -> 必须进入 near_crystallization，missing=1；
   - 反向 反证 b: preference, recurrence=4, confidence_score=70 -> 置信度未达标，严禁进入；
   - 反向 反证 c: decision, recurrence=3, confidence_score=90 -> 计数未达标，严禁进入；
   - 反向 反证 d: 纯净场景无候选时 -> near_crystallization 字段缺省/省略，_agent_hint 无该提示。

5. **元规范自检与零残留**:
   - scanTestFile 静态扫描 0 违规；
   - createTestEnv 动态隔离命名空间；
   - 测试结束后 countAllTestResidue 断言 residue.total === 0。

---

## 4. 验证与回归记录

1. **专项双向反证验收**：
   - 运行 `node tests/test_v640_a_iron.mjs`：全部 4 大任务与全量正反向反证门 100% 通过，隔离命名空间测试数据彻底清理，`residue.total === 0` 零残留断言通过。
2. **核心回归套件**：
   - 运行 `node tests/test_v639_a_write.mjs`：100% 通过（BUG-38-1 铁律量纲、BUG-38-4a 占位正则、BUG-38-4b 软失效正文数字守卫、EVO-16 NOOP tags 合并全部保持绿灯）。
   - 运行 `node tests/test_v639_b_save.mjs`：100% 通过（BUG-38-2 supersede_id 取代防重、EVO-14 演进契机自省、EVO-15 诊断标记全部保持绿灯）。
   - 运行 `node tests/test_schema_defaults.mjs`：100% 通过（所有数据库写入载荷显式包含时间戳，无外键哨兵值 0）。
3. **遵循文件所有权与“禁改计数”原则**（对齐 DEVNOTES.md:2040 与 DEVNOTES.md:2226）：
   - `test_meta.mjs` 严格保持只读，未做任何修改；
   - 新增测试由 `tests/test_v640_a_iron.mjs` 引入 `scanTestFile` 执行等价规范自检（0 违规），待合并阶段统一锁定计数。
