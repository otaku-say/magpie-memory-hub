# Agent B 检查点报告：读取能力深化与别名映射 (v6.38-b)

## 1. 任务背景与文件所有权约定
- **沙箱 ID**: `6eadc2faea99477d879d3dd6bb0d580b`
- **代码目录**: `/workspace/m`
- **工作分支**: `feat/v638-b-read` (基线: `852e56b`，干净)
- **文件所有权范围（严格限定）**:
  - `tools.js`：仅限 `normalizeToolArgs` 函数本体，以及 `memoryList` / `memoryGet` 两个函数实现区。
  - `tests/test_v638_b_read.mjs`：新增专项双向反证测试套件。
  - `NOTES_v638_b.md`：本设计与验收文档。
- **严禁修改**: `saveMemory` / `pitfallSave` / `memoryContext` / `memoryForget` / `memorySearch` / `semantic_dedup.js` / `gateway_harvest*.js` / `memory.middleware.js` / `test_meta.mjs` / 其他既有 tests。

---

## 2. 缺陷根因分析与技术实现方案

### 2.1 【BUG-37-4b】normalizeToolArgs 补齐 cause / reason → root_cause 映射
- **现状与根因**:
  - `normalizeToolArgs` 虽已支持 `error` / `issue` → `symptom`、`fix` / `resolve` → `solution` 等别名容错，但漏掉了排障踩坑中最常见的 `cause` 与 `reason` 参数。
  - 当调用方或前端传入 `{ cause: "..." }` 或 `{ reason: "..." }` 时，无法正确映射到 `root_cause`，导致根因被视为空值或回退为占位。
- **修复方案**:
  - 在 `normalizeToolArgs` 中增加别名映射：
    ```javascript
    // cause / reason → root_cause (BUG-37-4b)
    if (args.root_cause == null || args.root_cause === "") {
      if (args.cause != null && args.cause !== "") args.root_cause = args.cause;
      else if (args.reason != null && args.reason !== "") args.root_cause = args.reason;
    }
    ```
  - **映射守卫规则**:
    1. 兜底映射：仅当 `root_cause` 缺省（null/undefined）或为空字符串 `""` 时生效；
    2. 不可覆盖性：若调用方已显式传入合法的 `root_cause`，绝不被 `cause` 或 `reason` 覆盖篡改。

### 2.2 【EVO-12】knowledge_profile 补齐置信度过滤与 chronic_pitfalls 顽疾画像
- **现状与根因**:
  - EVO-10 引入的 `knowledge_profile` 中，`near_crystallization` 仅判断了 `recurrence >= threshold - 1`，未过滤置信度 `confidence_score`，导致低置信度（如 70 分）的偶发偏好误入结晶候选区。
  - 目前的自省画像仅涵盖准则/偏好/决策统计，缺少排障领域的“顽疾画像”（chronic_pitfalls），导致 Agent 无法在列表级自省项目中高频复发的踩坑。
- **技术实现**:
  1. **near_crystallization 增加置信度门禁**:
     - 在判断 `nearCandidates` 时，除类别匹配（`preference` / `decision`）与复发频次达标（`recurrence >= threshold - 1`）外，增加 `confidence_score >= 80` 严格过滤（缺省按 100 处理）。
     - 保持 `principle_count`、`preference_count`、`decision_count` 与 `total_active` 基础计数统计语义不变。
  2. **新增 chronic_pitfalls 顽疾画像**:
     - 检索当前 project 下的踩坑记录（若 `projectArg && projectArg !== "global"` 则并发穿透 `global` 踩坑并按 ID 去重，与既有穿透一致）。
     - 过滤条件：`!r.invalid_at`（未失效）且 `recurrence >= 3`。
     - 排序与截断：按 `recurrence` 降序排列，取 Top 5。
     - 字段投影：精确投影 `{ id, component, symptom (前60字), recurrence }`。
     - 挂载至 `knowledge_profile.chronic_pitfalls`。

### 2.3 【EVO-13】memory_get 生命周期状态与取代指引
- **现状与根因**:
  - `memory_get`（单条与批量）返回的记录对象未暴露 `lifecycle_status`、`invalid_at`、`invalid_reason`、`superseded_by_id` 等生命周期元数据。
  - 当读取已失效或已被取代的历史记录时，调用方无法感知其有效性状态，极易沿用已被废弃或取代的过时逻辑。
- **技术实现**:
  1. 在 `formatMemoryRecord` 与 `formatPitfallRecord` 返回体中补齐生命周期元数据：
     - `lifecycle_status`: 记录生命周期（若库中缺省，失效记录置为 `"invalid"`，有效置为 `"active"`）
     - `invalid_at`: 失效时间戳（有效记录为 `null`）
     - `invalid_reason`: 失效原因（无则为空串 `""`）
     - `superseded_by_id`: 取代者 ID（无则为 `null`）
     - `_lifecycle_warning`: 生命周期告警指引文案
  2. **_lifecycle_warning 规则**:
     - 有效记录（`invalid_at` 为空且 `lifecycle_status` 为 `"active"`/undefined）→ 值为 `null`（或不出现）；
     - 已失效且存在 `superseded_by_id` → `"该记录已被 #<superseded_by_id> 取代，可调 memory_get(id=<superseded_by_id>) 查看最新版本"`；
     - 已失效且无 `superseded_by_id` → `"该记录已失效（原因: <invalid_reason>）"`（若 `invalid_reason` 为空则优雅提示 `"未注明"`）。
  3. **兼容性保障**:
     - 保持已失效记录的可读性（返回完整内容便于追溯，但不隐瞒失效状态）；
     - 严格保持既有 `auto_fallback`（memories 找不到自动回退 pitfalls）、`superseded_history`（历史版本摘要）及 `ids` 批量读取语义不变。

---

## 3. 双向反证测试矩阵设计 (tests/test_v638_b_read.mjs)

| 任务 | 正向反证门 (Positive) | 反向/边界反证门 (Counter-Evidence) |
| :--- | :--- | :--- |
| **BUG-37-4b** | 传 `{ cause: "X" }` 成功归一化为 `root_cause === "X"`；传 `{ reason: "Z" }` 成功映射 | 传 `{ root_cause: "Y", cause: "X" }` 时，`root_cause` 严格保持为 `"Y"` 绝不被覆盖 |
| **EVO-12 顽疾画像** | `recurrence >= 3` 且 `invalid_at` 为空的踩坑记录必进 `chronic_pitfalls`，按复发降序最多 5 条，前 60 字截断对齐 | `recurrence = 2` 的低频踩坑不得出现；已被软失效（`invalid_at` 非空）的踩坑不得出现 |
| **EVO-12 置信度门禁** | `confidence_score >= 80` 且 `rec >= threshold - 1` 的偏好必进 `near_crystallization` | `confidence_score = 70 (< 80)` 的高频偏好绝不得误入 `near_crystallization`；基础计数保持完整 |
| **EVO-13 生命周期指引** | 有效 active 记录 `_lifecycle_warning` 为 null；已失效且被 supersede 记录带有新 ID 指引 | 已失效但未被取代记录输出原因告警；table: "pitfalls" 跨表失效记录同样具备告警 |
| **规范元检查自证** | `scanTestFile` 静态扫描测试文件 0 违规，强断言隔离与清理 | 执行 `env.cleanup()` 后断言 `residue.total === 0`，数据库零残留 |

---

## 4. 验证与回归规划
1. 遵循文件所有权与“禁改计数”原则，严禁修改 `test_meta.mjs`。
2. 运行基准与新增测试套件：
   - `node tests/test_v638_b_read.mjs`（新增专项双向反证）
   - `node tests/test_v637_b_read.mjs`（既有读取与入口链路专项）
   - `node tests/test_proactive_memory_ux.mjs`（主动记忆 UX）
   - `node tests/test_search_enhancement_and_scale.mjs`（检索增强与规模）
3. 确保全部测试 100% PASS，0 失败，0 残留。
