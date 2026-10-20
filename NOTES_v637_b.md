# Agent B 检查点报告：读取与入口链路修复与演进 (v6.37-b)

## 1. 任务背景与文件所有权约定
- **沙箱 ID**: `3bd945da377d4b3ca95bda7bc41861d4`
- **代码目录**: `/workspace/m`
- **工作分支**: `feat/v637-b-read`
- **文件所有权范围（严格限定）**:
  - `tools.js`（仅限 memorySearch / memoryGet / memoryForget / memoryList / memoryContext 五个函数区，以及 normalizeToolArgs 的注册调用处）
  - `tests/test_v637_b_read.mjs`（新增专项双向反证测试）
  - `NOTES_v637_b.md`（本设计与验收文档）
- **严禁修改**: `saveMemory` / `pitfallSave` / `normalizeToolArgs` 函数本体（只改注册处补工具名）/ `semantic_dedup.js` / `gateway_harvest*.js` / `memory.middleware.js` / `test_meta.mjs` / 其他既有 tests。

---

## 2. 缺陷根因分析与技术实现方案

### 2.1 【BUG-2 高危】memory_context 与 memory_list 接入 normalizeToolArgs
- **现状与根因**:
  - `tools.js` 注册处（约 3659 行）仅包装了 5 个工具（`["memory_save", "pitfall_save", "memory_search", "pitfall_search", "memory_get"]`），漏掉了 Agent 最常用的首选入口 `memory_context` 与 `memory_list`。
  - 函数内部实现 `memoryContext` 与 `memoryList` 也未调用 `normalizeToolArgs`。
  - **严重后果**:
    1. 传 `{ q: "Redis" }` 调用 `memory_context` 时，`args.query` 为空，检索关键词失效；
    2. 缺省 `project` 时无法继承 `cfg.project`，`projectArg` 为空串导致 `fetchAll` 拉取全表所有项目的数据，产生严重的跨项目数据串扰。
- **修复方案**:
  1. 在 `tools.js` 约 3659 行将 `memory_context` 与 `memory_list`（及 `memory_forget`）一并加入 `includes` 判定集合；
  2. 在 `memoryContext` 与 `memoryList` 函数入口处均显式执行 `const args = normalizeToolArgs(rawArgs, cfg);`，形成双重防线；
  3. `normalizeToolArgs` 规则确保：若 `args.query` 缺省，则映射 `keyword` 或 `q` 到 `query`，若已有合法 `query` 则绝不覆盖；缺省 `project` 时继承非 `"global"` 的 `cfg.project`，否则置为 `"global"`。

### 2.2 【BUG-4 中危】检索与展开链路细节断层
- **缺陷 1：memory_search 漏 `related_entities` 字段**:
  - **根因**: `memorySearch` 虽然在 `fetchParams.columns` 中包含了 `related_entities`，但在最后 `out` 数组投影映射时漏掉了该字段，导致前端或调用方拿不到关联实体。
  - **修复**: 在 `out` 的对象构造中补齐 `related_entities: x.row.related_entities || null`。
- **缺陷 2：memory_get 无 table 时自动回退 pitfalls**:
  - **根因**: 上下文提示行建议使用 `memory_get(id=...)` 查看全文，但未标注 table。当 Agent 直接调用 `memory_get({ id: 11 })` 展开踩坑记录时，因默认查 `memories` 表而直接抛错崩溃。
  - **修复**: 在未显式传入 `table` 且 `memories` 表查无此 ID 时，自动尝试在 `pitfalls` 表回退查找；查到后正常格式化返回并标记 `table: "pitfalls"` 与 `auto_fallback: true`。若 `memories` 存在则保持 `memories` 优先，不触发回退。
- **缺陷 3：memory_forget 批量软失效支持**:
  - **根因**: `memory_get` 已支持 `ids: [1, 2]` 批量读取，但 `memory_forget` 仅支持单条 `id` 或 `query`，语义不对齐。
  - **修复**: `memory_forget` 增加 `ids: [1, 2]` 批量处理逻辑（支持数组或逗号分隔），遍历标记 `invalid_at: now`、`invalid_reason: "user_forgot"`、`updated_at: now`，返回 `forgotten` 统计计数与逐条 `items` 详情。

### 2.3 【EVO-9b】memory_get 读取 revision > 1 时附带 superseded_history
- **要求**: 当记录 `revision > 1` 时，返回体附加 `superseded_history`（最多 3 条前序版本摘要：`revision` 号 + 当时的 `title`/`content` 前 120 字 + `updated_at`）。若平台无历史版本表，则从当前记录无法还原时，返回空数组并在 `note` 说明 `"历史版本未持久化"`。严禁伪造虚假数据。
- **实现方案**:
  - 在 `memoryGet` 中判定 `Number(hit.revision) > 1`；
  - 查询数据库中同一 `project` 下被当前记录取代或标记为 `superseded` 的同名记录（支持 `superseded_by_id === hit.id`、`lifecycle_status === "superseded"` 且同 title、或 `revision < hit.revision` 且同 title）；
  - 若查询到前序版本，按 `revision` 与 `updated_at` 降序排列，取前 3 条精简投影；
  - 若无法从存储中还原前序版本，安全返回 `superseded_history: []` 并附带 `note: "历史版本未持久化"`。

### 2.4 【EVO-10】memory_list 返回 knowledge_profile 自省画像
- **要求**: 在返回体新增：
  `knowledge_profile: { principle_count, preference_count, decision_count, near_crystallization: [{id,title,recurrence,threshold}], total_active }`
  其中 `near_crystallization` 为 preference/decision 类且 `recurrence >= threshold - 1` 的记录（`threshold` 取 `cfg.crystallization_threshold`，默认 5），最多 5 条。统计需基于当前 project（含 global 穿透规则与既有实现一致）。
- **实现方案**:
  - `memoryList` 接入穿透逻辑：当 `projectArg && projectArg !== "global"` 时并发拉取当前项目与 global 活跃记录并去重；
  - 遍历统计 `principle`、`preference`、`decision` 三类数量；
  - 筛选 `preference` 与 `decision` 且 `recurrence >= threshold - 1` 的候选记录，按 `recurrence` 降序截取前 5 条输出为 `near_crystallization`；
  - 返回完整的 `knowledge_profile` 统计画像。

---

## 3. 双向反证测试矩阵设计 (tests/test_v637_b_read.mjs)

| 测试项 | 正向验证 (Positive) | 反向/边界反证 (Counter-Evidence) |
| :--- | :--- | :--- |
| **BUG-2: q 映射与不变性** | 传 `{ q: "Redis" }` 调 `memory_context` 成功召回 Redis 相关准则/踩坑 | 传 `{ query: "Original", q: "Conflict" }` 时，`query` 保持为 `"Original"` 绝不被覆盖 |
| **BUG-2: project 继承与隔离** | 缺省 `project` 自动继承 `cfg.project`，隔离检索目标项目上下文 | 显式传 `project: "other"` 遵循显式参数；缺省时绝不全表跨项目泄漏 |
| **BUG-4: related_entities 投影** | `memory_search` 返回的 memories 条目必包含 `related_entities` 字段及实体值 | 无实体记录优雅兜底为 null 或空串，字段存在且不崩溃 |
| **BUG-4: memory_get 自动回退** | 未传 `table` 且 ID 仅存在于 `pitfalls` 时，成功回退并标 `auto_fallback: true` | 当 `memories` 与 `pitfalls` 均有记录或 `memories` 有记录时，严格优先返回 memories，不触发 fallback |
| **BUG-4: 批量 forget** | 传 `ids: [1, 2]` 成功批量软失效，返回 `forgotten: 2` 与对应 `items` | 传统单条 `id: 1` 保持 100% 格式兼容，已失效记录再次失效安全幂等 |
| **EVO-9b: superseded_history** | `revision > 1` 且有历史记录时返回前序版本摘要列表；无历史存储时返回空数组且 note 声明未持久化 | `revision === 1` 时不得输出虚假 `superseded_history` 历史 |
| **EVO-10: knowledge_profile** | 正确统计 principle/preference/decision 数，`recurrence >= threshold - 1` 入选 near_crystallization | `recurrence < threshold - 1` 时 near 列表严格为空，绝不误报 |
| **元检查自检** | `scanTestFile` 静态扫描本测试文件，0 违规，符合隔离、清理与残余为 0 规范 | 写库测试具备强制 `env.cleanup()` 与 `residue.total === 0` 断言 |

---

## 4. 验证与回归计划
1. 执行 `node tests/test_v637_b_read.mjs` 验证全部正反向反证用例 100% 通过；
2. 执行既有核心套件验证无回归：
   - `node tests/test_proactive_memory_ux.mjs`
   - `node tests/test_v636_c_evo.mjs`
   - `node tests/test_v636_b_evo.mjs`
   - `node tests/test_search_enhancement_and_scale.mjs`
3. 遵循文件所有权与“禁改计数”原则，基准套件在 64 个测试下 100% PASS，新增测试自证合规，等待合并阶段统一锁定计数。
