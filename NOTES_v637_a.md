# Agent A 检查点报告：写入链路修复与演进增强 (v6.37-a)

## 一、任务背景与文件所有权约定
- **沙箱 ID**: `2ee9215f1290473e81a6c0fe30bc48f3`
- **工作目录**: `/workspace/m`
- **工作分支**: `feat/v637-a-write`
- **文件所有权范围**:
  - 独占修改: `tools.js` 中的 `saveMemory` 与 `pitfallSave` 两个函数区域。
  - 独占新增: `tests/test_v637_a_write.mjs`、`NOTES_v637_a.md`。
  - 严格禁改: `memoryContext` / `memoryList` / `memoryGet` / `memoryForget` / `memorySearch` / `normalizeToolArgs` 及其注册处、`semantic_dedup.js`、`gateway_harvest*.js`、`memory.middleware.js`、`test_meta.mjs` 以及历史测试文件。

---

## 二、BUG-1（高危）：pitfallSave 根因覆盖/数字冲突/tags 合并修复

### 1. 现状根因分析
- **根因被占位符覆盖**: 在原有 `pitfallSave` 实现中，入参 `rawRootCause = String(args.root_cause || "").trim()`，随后直接 `rootCause = scrubSecrets(rawRootCause || symptom)`。当首次调用存了真实根因（如 `root_cause: "连接池泄漏未释放"`），第二次调用仅补充更详尽方案 `solution`（未再显式传 `root_cause`）时，`rootCause` 自动回退为 `symptom`。随后在更新载荷中通过 `root_cause: newRc || oldRc` 赋值，由于 `newRc` 为 `symptom`（非空），导致数据库中的真实根因被强制冲刷回占位符 `symptom`。
- **缺失解法数字冲突守卫**: `isSolutionMoreDetailed` 仅通过长度判断（`newSol.length >= oldSol.length * 1.3`），未校验 `!hasConflictingNumbers(oldSol, newSol)`。导致诸如 `2048MB` 配置被包含 `8192MB` 的新方案直接覆盖演进。
- **演进丢失 tags**: 在 `EVOLVED` 更新载荷中，未对既有 `tags` 与新传入 `tags` 取并集，导致新标签丢失或旧标签未被继承。

### 2. 修复方案与实现
1. **显式根因保护**:
   - 增加显式传参判定: `hasExplicitRootCause = Boolean(args.root_cause != null && String(args.root_cause).trim() !== "")`。
   - 仅当调用方**显式传入**非空 `root_cause` 时才更新根因；若未传则严格保留库中原根因（`oldRc`），绝不以 `symptom` 顶替。
   - 支持显式传新根因更新: 若调用方显式传入了不同于旧值且非占位的新根因，成功触发演进并更新记录。
2. **数字冲突阻断演进**:
   - 演进判定前增加数字冲突守卫: 若 `hasConflictingNumbers(oldSol, newSol)` 为真，禁止触发 `EVOLVED` 覆盖，改为执行 `NOOP`，累加 `recurrence` 与更新时间戳，并在返回 `note` 中明确说明「方案存在数字冲突，禁止演进覆盖，累加复发计数」。
3. **标签并集融合**:
   - 演进时对 `dup.tags` 与传入 `tags` 进行切分去重取并集，写入更新载荷。

---

## 三、BUG-3（中危）：saveMemory 显式 supersede 与 NOOP 标签实体保留

### 1. 现状根因分析
- **显式 supersede 被卡死**: 原有逻辑中 `const shouldEnrich = isSameTitle && noNumberConflict && (hasSignificantGrowth || isExplicitSupersede);`，由于 `isSameTitle` 位于与逻辑外层，当语义查重命中相似重复（`dup`）但标题措辞不同（`isSameTitle` 为 false）时，即便显式传入 `supersede: true`，也被强制拦截而无法进入 `ENRICHED` 融合路径。
- **NOOP 分支丢弃 tags 与 related_entities**: 在 `saveMemory` 的 `else`（NOOP）分支中，仅更新了 `recurrence` 与 `updated_at`，新传入的 `tags` 与 `related_entities` 被完全丢弃，导致后续检索命中率与知识关联退化。

### 2. 修复方案与实现
1. **显式 supersede 穿透**:
   - 调整扩充判定逻辑: `const shouldEnrich = noNumberConflict && (isExplicitSupersede || (isSameTitle && hasSignificantGrowth));`。
   - 当调用方显式传入 `supersede: true` 时，只要不存在硬性数字冲突，即便标题不完全一致，亦必须进入 `ENRICHED` 融合路径，并将记录标题更新为新标题。
2. **NOOP 分支并集回写**:
   - 在 NOOP 更新载荷中，将本次传入的 `tags` 与既有 `dup.tags` 取并集、本次传入的 `related_entities` 与既有 `dup.related_entities` 取并集，通过 `client.update` 完整回写数据库，确保增量标签与技术实体不丢失。

---

## 四、EVO-9a 冲突感知与显式指定 supersede_id

### 1. 设计目标与场景
当 Agent 向记忆库存储事实/规范时，可能由于标题措辞差异或数字冲突（如默认监听 80 端口 vs 8080 端口）绕过语义合并而作为新记录 `ADD` 入库。库中同时并存两套互相矛盾的配置会导致后续问答产生幻觉。

### 2. 技术实现
1. **冲突感知检测**:
   - 在 `saveMemory` 执行 `ADD` 入库后，扫描当前同 `project`、未失效（`lifecycle_status === 'active'` 且无 `invalid_at`）的所有历史记忆。
   - 标题同主题判定: 综合归一化标题包含、分词重合度（`overlapCoefficient >= 0.4` / `jaccardSimilarity >= 0.25`）以及去数字归一化重合度判定。
   - 冲突检测: 若 `hasConflictingNumbers(title, r.title)` 或 `hasConflictingNumbers(content, r.content)` 为真，即判定为存在配置数字冲突。
   - 附加信息: 收集最多 3 条候选，在返回体中附加 `conflict_candidates: [{id, title, content}]`（其中 `content` 截取前 100 字符摘要），并附加提示 `note: "可能存在配置冲突，建议用 supersede_id 取代或 memory_forget 淘汰"`。
   - 保底反证: 若无任何冲突项，返回体绝不污染附带 `conflict_candidates`，主流程与已有接口字段保持严格向后兼容。
2. **显式 supersede_id 淘汰旧记录**:
   - `saveMemory` 支持传入 `supersede_id`: 指定需要取代的旧记录主键 ID。
   - 写入新记录后，立即将目标记录软失效: `lifecycle_status = "superseded"`、`superseded_by_id = newId`、`invalid_at = nowSql()`、`invalid_reason = "superseded_by:<newId>"`。
   - 返回 `action: "UPDATE"` 与 `superseded_id`，并累加版本审计链。

---

## 五、双向反证用例设计矩阵 (tests/test_v637_a_write.mjs)

| 模块 | 正向验证 (Positive) | 反向反证 (Negative) |
| :--- | :--- | :--- |
| **BUG-1 根因保护** | 显式传入新根因时，记录的 `root_cause` 成功更新为新根因，action 为 `EVOLVED` | 未显式传根因仅扩充方案时，库中原真实根因必须严格保留，绝不得被 `symptom` 顶替 |
| **BUG-1 数字冲突** | 无数字冲突且方案显著增长时正常触发 `EVOLVED` | 方案包含数字冲突（如 2048MB vs 8192MB）时，严禁演进覆盖，必须返回 `NOOP` 并在 note 中指明数字冲突 |
| **BUG-1 标签合并** | 踩坑演进时，新旧 tags 自动取并集融合入库 | 演进不覆盖/丢弃既有 tags |
| **BUG-3 supersede 标题** | 命中 dup 且标题不一致时，传 `supersede: true` 必须进入 `ENRICHED` 融合路径 | 未传 `supersede: true` 且标题不同时，维持原有判定路径 |
| **BUG-3 NOOP 标签实体** | NOOP 分支下，传入的新 tags 与 related_entities 成功与库中旧值合并回写 | NOOP 下数据库中正文内容严格不得被覆盖 |
| **EVO-9a 冲突感知** | 保存同主题但含冲突数字的配置（如 8080 vs 80）时，ADD 返回体必须包含 `conflict_candidates` 与提示文案 | 保存完全无关或无冲突数字的记忆时，`conflict_candidates` 必须为空 |
| **EVO-9a supersede_id** | 传入 `supersede_id` 时，旧记录被软失效且 `invalid_reason` 精确记录为 `superseded_by:<newId>` | 未传 `supersede_id` 时，旧记录不受非预期软失效影响 |

