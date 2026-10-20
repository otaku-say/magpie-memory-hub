# Agent A 检查点报告：EVO-1 记忆智能增量扩充 与 EVO-4 高频经验自动升维结晶 (v6.36-a)

## 一、任务背景与文件所有权约定
- **沙箱 ID**: `d0cbc898ebc8451196de0bf1762b85c6`
- **工作目录**: `/workspace/m`
- **工作分支**: `feat/v636-a-evo14`
- **文件所有权**:
  - 独占修改: `tools.js`、`memory.middleware.js`
  - 独占新增: `tests/test_v636_a_evo.mjs`、`NOTES_v636_a.md`
  - 严禁修改: `semantic_dedup.js`、`gateway_harvest*.js`、`local_state.js`、`test_meta.mjs`、历史测试文件及其他模块。

---

## 二、EVO-1 记忆认知智能增量扩充设计与实现

### 1. 现状痛点分析
在原有 `saveMemory` 逻辑中（约 582-602 行）：
Agent 对已有简短记忆（例如「使用 Redis 缓存会话数据」）补充架构细节（例如集群配置、拓扑架构等）再次存入时，因标题完全一致且旧文本是新文本的子串，语义去重层的 `cOverlap = 1.0 >= 0.38`，被 `findSemanticDuplicate` 判定为语义重复命中。系统直接返回 `action: "NOOP"`，仅对旧记录累加 `recurrence` 并刷新 `updated_at`，新补充的架构细节被全部丢弃，且由于提前短路返回，下游 655 行的 `superseded` 版本链也无法触发。

### 2. 解决方案与技术实现
在 `tools.js` 的 `saveMemory` 中拦截命中语义重复的候选（`dup`）：
1. **触发条件判断**：
   - 同标题重复：`normalizeSemanticText(dup.title) === normalizeSemanticText(title)` 或 trim 忽略大小写一致；
   - 严禁数字冲突：`!hasConflictingNumbers(title, dup.title) && !hasConflictingNumbers(content, dup.content || dup.full_text || "")`；
   - 显著信息量增长或显式指令：新内容长度 `newContent.length >= oldContent.length * 1.25` 或显式传入 `m.supersede === true`。
2. **原地增量扩充更新原记录（保留原 ID）**：
   - `content` / `full_text` 融合：取更详尽者；
   - `tags` 融合：新旧标签拆分归一化并取并集（`Array.from(new Set([...oldTags, ...newTags])).join(", ")`）；
   - `related_entities` 融合：新旧实体拆分去重取并集；
   - `recurrence` 累加：`(Number(dup.recurrence) || 1) + initialRecurrence`；
   - `revision` 版本递增：`(Number(dup.revision) || 1) + 1`；
   - `updated_at` 刷新为当前时间；
   - 重新计算并更新 `content_fingerprint`，并刷新 `markRecent` 缓存。
3. **返回体**：
   - 返回 `action: "ENRICHED"`，保留原 `id`，返回新 `recurrence` 与 `revision`，并附带 note 说明。
4. **反证保底**：
   - 若信息量未显著增长（长度增长不足 1.25 且未显式指定 `supersede: true`），或存在数字冲突，严格维持原 `action: "NOOP"` 行为。

---

## 三、EVO-4 高频经验自动升维结晶设计与实现

### 1. preference / decision 类记忆高频自动升维 principle
- **触发条件**：
  - 类别限制：记忆类别属于 `preference` 或 `decision`；
  - 复发阈值：`recurrence` 累加后达到 `crystallization_threshold`（默认 5，可通过配置自定义）；
  - 可信度门槛：`confidence_score >= 80`。
- **升维操作**：
  - 将数据库中该记录的 `category` 更新为 `"principle"`；
  - 更新对应的 `content_fingerprint`（分类变更入指纹）；
  - 在返回体 `note` 中明确追加或说明「已升维为 principle」。
- **反证门限**：
  - 未达到阈值（如 recurrence=4 < 5）必须不升级；
  - confidence_score < 80 必须不升级；
  - 其他分类（如 fact / context）即使达到阈值也严禁升级。

### 2. 踩坑高频复发报警与根因提示
- **触发条件**：
  - 踩坑记录（pitfall）的 `recurrence >= 3`（可通过 `pitfall_recurrence_threshold` 配置，默认 3）。
- **注入渲染**：
  - 在 `memory_context`（tools.js）生成的上下文文本中，对满足条件的踩坑项，条目添加前缀 `[高频复发×N] `，并在行尾追加提示 ` 建议核查根因是否已根治`；
  - 在 `memory.middleware.js` 中间件注入的上下文文本中，对满足条件的踩坑项，同样添加前缀 `[高频复发×N] `，行尾追加 ` 建议核查根因是否已根治`。
- **反证门限**：
  - recurrence < 3 时，不得出现 `[高频复发×N]` 与根因提示。

### 3. 配置化支持与 readOptions 对齐
- 在 `tools.js` 的 `readOptions` 中追加：
  - `crystallization_threshold`: 默认 5；
  - `pitfall_recurrence_threshold`: 默认 3；
- 绝不改动已有字段的语义与默认值。

---

## 四、双向反证用例设计（tests/test_v636_a_evo.mjs）
1. **反证门 1（EVO-1 双向验证）**:
   - 正向：简短记忆更新架构细节（长度增长 > 1.25），断言返回 `action: "ENRICHED"`，原 ID 保持不变，revision 递增，content/tags/entities 成功融合。
   - 反向：微小修改（长度增长 < 1.25 且无 supersede），断言返回 `action: "NOOP"`，正文不变；存在数字冲突（如 80 vs 8080）时严禁误扩充。
   - 显式指示：即使长度未翻倍，传 `supersede: true` 时亦必须触发 `action: "ENRICHED"`。
2. **反证门 2（EVO-4 升维双向验证）**:
   - 正向：`preference` 记忆复发累加至 5 且 confidence=90，断言 category 升级为 `principle`，返回体 note 包含「已升维为 principle」。
   - 反向 a：复发累加至 4（未达 5），断言 category 维持原样，note 不含升维提示。
   - 反向 b：复发累加至 5 但 confidence=70（< 80），断言严禁升维。
   - 反向 c：`fact` 记忆复发达到 5 且 confidence=90，断言非偏好决策类严禁升维。
   - 自定义配置：通过 cfg 配置 `crystallization_threshold: 3` 时，累加至 3 即可提前升维。
3. **反证门 3（EVO-4 踩坑高频警告双向验证）**:
   - 正向：踩坑 recurrence=3 时，在 `memory_context` 和中间件注入文本中断言包含 `[高频复发×3]` 与 `建议核查根因是否已根治`。
   - 反向：踩坑 recurrence=2 时，断言绝不包含高频复发前缀与根因提示。
4. **元规范自检与零残留清理**：
   - 引用 `scanTestFile` 自检 0 违规；
   - 测试结束后完整清理数据库隔离命名空间，断言 residue.total === 0。
## 五、验收测试实测与审计记录

### 1. 专项验收测试 (`tests/test_v636_a_evo.mjs`)
- **反证门 1（EVO-1 智能增量扩充）**：
  - 正向通过：简短记忆更新架构细节（>1.25倍，无数字冲突）触发 `action: "ENRICHED"`，原 ID 保持不变，revision 递增，content/tags/entities 正确融合。
  - 反向 a 通过：微小修改（<1.25倍且无 supersede）严格维持 `action: "NOOP"`，正文不被覆盖。
  - 反向 b 通过：数字冲突（80 vs 8080）守卫生效，不同端口号严禁增量合并。
  - 显式指示通过：无数字冲突下显式传 `supersede: true` 成功触发 `action: "ENRICHED"`。
- **反证门 2（EVO-4 经验升维结晶）**：
  - 正向通过：preference 记忆 recurrence 达 5 且 confidence=90 成功升维 principle 并写库，note 明确包含「已升维为 principle」。
  - 反向 a 通过：recurrence=4 未达阈值严格不升维。
  - 反向 b 通过：confidence=70 低于 80 严格不升维。
  - 反向 c 通过：fact 普通事实类严禁升维为 principle。
  - 配置化通过：自定义 `crystallization_threshold: 3` 时按配置提前触发升维。
- **反证门 3（EVO-4 踩坑高频报警）**：
  - 正向通过：踩坑 recurrence=3 时，`memory_context` 文本包含 `[高频复发×3]` 与行尾 `建议核查根因是否已根治`。
  - 正向通过：`memory.middleware.js` 中间件注入文本包含 `[高频复发×3]` 与行尾 `建议核查根因是否已根治`。
  - 反向通过：recurrence=2 未达阈值绝不包含高频复发前缀与根因提示。
  - 配置化通过：`pitfall_recurrence_threshold: 2` 成功按配置提前触发。
- **规范自检与清理**：
  - `scanTestFile` 元检查自检 0 违规；
  - `env.countAllTestResidue` 断言 0 残留通过。

### 2. 回归测试验证
- `tests/test_dedup_and_audit.mjs`: PASS
- `tests/test_v635_a_tools.mjs`: PASS
- `tests/test_v632_a_tools.mjs`: PASS
- `tests/test_exports.mjs`: PASS

### 3. 文件所有权遵循确证
- 修改文件：`tools.js`, `memory.middleware.js`
- 新增文件：`tests/test_v636_a_evo.mjs`, `NOTES_v636_a.md`
- 严格禁改文件（`semantic_dedup.js`, `gateway_harvest*.js`, `local_state.js`, `test_meta.mjs`, 历史测试等）0 变动。
