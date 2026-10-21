# Agent B 检查点报告：修复显式 supersede 被吞没与检索期自省 (v6.39-b)

## 1. 任务背景与文件所有权约定
- **沙箱 ID**: `45773dfb239840c0ba02fc9da0f9b5ef`
- **工作目录**: `/workspace/m`
- **目标分支**: `feat/v639-b-save` (基线 commit: `fd649e8`)
- **文件所有权范围（严格限定）**:
  - `tools.js`：
    * `saveMemory`：前置解析 `supersede_id`，跳过 dup 与 crossDup 的 NOOP 短路（BUG-38-2）。
    * `memoryContext`：返回体透出 `evolution_opportunities`（`near_ironlaw` 与 `chronic_without_root_cause`）并动态追加 `_agent_hint`（EVO-14）。
    * `pitfallSearch`：返回踩坑结果附加 `is_chronic` 与 `root_cause_is_placeholder` 诊断标记（EVO-15）。
  - `tests/test_v639_b_save.mjs`：新增专项双向反证测试套件。
  - `NOTES_v639_b.md`：本技术设计与验收报告。
- **严禁修改（红线边界）**:
  - `pitfallSave` / `checkAndApplyIronlaw` / `isPlaceholderRootCause`（由 Agent A 维护修改）
  - `memoryGet` / `memoryList` / `memoryForget` / `MagpieMemoryHub` 入口
  - `gateway_harvest*.js` / `test_meta.mjs` / `semantic_dedup.js`

---

## 2. 缺陷根因分析与技术实现方案

### 2.1 【BUG-38-2】显式 supersede_id 被 dup / crossDup 吞没
- **现状与根因**:
  - 在 `saveMemory` 中，`targetSupersedeId` 的解析位于 759-761 行，落后于同分类语义查重（`dup`，约 560-675 行）与跨类别查重（`crossDup`，约 684-740 行）。
  - 当 Agent 显式传递 `supersede_id` 旨在取代同标题旧记忆时（例如同标题事实“包管理器选型”从“使用 npm”切换为“切换为 pnpm”），由于标题完全一致且无数字冲突，流程在 `dup` 或 `crossDup` 处直接命中并返回 `action: "NOOP"`。
  - 结果：新决策记录被直接丢弃，旧记录未被打上 `superseded` 软失效标记，严重违背调用方显式取代意图。
- **技术实现**:
  1. 将 `targetSupersedeId` 与 `targetSupersedeRow` 的解析提前至候选集拉取之后、`dup` 查重之前：
     ```javascript
     const targetSupersedeId = (m.supersede_id != null && m.supersede_id !== "" && !isNaN(Number(m.supersede_id)))
       ? Number(m.supersede_id)
       : null;
     let targetSupersedeRow = targetSupersedeId ? allActiveRows.find((r) => r.id === targetSupersedeId) : null;
     if (targetSupersedeId && !targetSupersedeRow) {
       try {
         const fetched = rowsOf(await client.list("memories", { id: targetSupersedeId, limit: 1 }));
         if (fetched.length > 0) targetSupersedeRow = fetched[0];
       } catch (_) {}
     }
     const hasValidSupersede = Boolean(targetSupersedeId && targetSupersedeRow);
     ```
  2. 当 `hasValidSupersede` 为 true 时，显式取代是最高优先级意图，**跳过 `dup` 与 `crossDup` 的 NOOP 短路**，直接进入记录创建与旧记录软失效流程。
  3. 支持跨类别升级（如从 fact 升级为 decision），新记录写入新分类并递增版本，旧记录置为 `lifecycle_status="superseded"`、`superseded_by_id=newId`、`invalid_reason="superseded-by:" + newId`。
  4. 当无 `supersede_id` 时，原有同标题查重与防重逻辑完全保持不变，确保 NOOP 防重机制不被破坏。

### 2.2 【EVO-14】memory_context 透出 evolution_opportunities 演进契机
- **需求与设计**:
  - 在 `memoryContext` 返回体中组装并输出 `evolution_opportunities`（若无契机则省略或为空）：
    1. `near_ironlaw`: 当前召回的踩坑中 `recurrence >= (crystallization_threshold - 1)` 且 `root_cause` / `solution` 真实非占位，输出 `{ id, component, symptom (前60字), recurrence, missing: 1 }`。
    2. `chronic_without_root_cause`: `recurrence >= 3` 且 `root_cause` 为空或占位，输出 `{ id, component, symptom (前60字), recurrence }`。
  - 在 `_agent_hint` 中动态追加对应提示：
    * 存在 `near_ironlaw` 时提示：“再记录 N 次该故障即可自动生成铁律”
    * 存在 `chronic_without_root_cause` 时提示：“该顽疾缺真实根因，排查后请用 pitfall_save 补 root_cause”
    * 无任何契机时保持原生 hint，不含演进提示。
  - 严格保持现有 `[Persistent Memory Context]` 块结构与 `max_items` 上限不受任何影响。

### 2.3 【EVO-15】pitfall_search 透出诊断标记
- **需求与设计**:
  - `pitfallSearch` 召回的每条踩坑记录增加两项布尔诊断属性：
    * `is_chronic`: `recurrence >= 3`
    * `root_cause_is_placeholder`: 根因为空 / 等于 symptom / 匹配 `/未知|待查|临时|unknown|todo|tbd|已处置解决|执行过程中出现/i`
  - 遵循文件所有权约定，不修改外部 `isPlaceholderRootCause` 函数，在 `pitfallSearch` 内联相同判断逻辑并加注释说明。

---

## 3. 双向反证测试矩阵 (tests/test_v639_b_save.mjs)

| 任务 | 正向反证门 (Positive) | 反向/边界反证门 (Counter-Evidence) |
| :--- | :--- | :--- |
| **BUG-38-2 supersede 取代** | 同标题旧 fact "使用 npm" 存在，新传 decision "切换为 pnpm" + supersede_id=<旧id> → 成功落库新记录，返回 UPDATE，旧记录 lifecycle_status=superseded 且 invalid_reason 含新 id | 不传 supersede_id 时，同标题重复提交必须命中 dup/crossDup 严格返回 NOOP |
| **BUG-38-2 跨类 supersede** | 旧记录为 fact，新记录为 decision + supersede_id，分类成功转换，版本号正确递增 | supersede_id 为非法/不存在 ID 时，回退至正常查重流程 |
| **EVO-14 near_ironlaw** | recurrence=4 且根因/解法真实的踩坑召回时，必进 near_ironlaw 且 missing=1，_agent_hint 动态提示 | recurrence=4 但根因为“具体待查”的踩坑绝不进入 near_ironlaw |
| **EVO-14 chronic 顽疾画像** | recurrence=5 且根因占位的踩坑召回时，必进 chronic_without_root_cause，_agent_hint 提示补根因 | recurrence=2 或根因真实的踩坑绝不进入 chronic_without_root_cause |
| **EVO-14 纯净反证** | 无任何符合条件的踩坑时，evolution_opportunities 为空/缺省，_agent_hint 绝不含演进提示 | memoryContext block 格式与 max_items 截断不受 evolution_opportunities 影响 |
| **EVO-15 诊断标记** | recurrence=4 → is_chronic=true；root_cause="具体待查" → root_cause_is_placeholder=true | recurrence=2 → is_chronic=false；root_cause="TCP KeepAlive 未开启" → root_cause_is_placeholder=false |
| **测试元检查与清理** | scanTestFile 静态扫描本测试 0 违规，强断言隔离 | env.cleanup() 执行后断言 residue.total === 0 零残留 |

---

## 4. 验证与回归记录
1. 遵循文件所有权与“禁改计数”原则（对齐 DEVNOTES.md:2040 与 DEVNOTES.md:2226）：
   - `test_meta.mjs` 严格保持只读，未做任何修改；
   - 新增测试由 `tests/test_v639_b_save.mjs` 引入 `scanTestFile` 执行规范自证（0 违规）。
2. 执行基准与新增测试套件：
   - `node tests/test_v639_b_save.mjs`
   - `node tests/test_v638_b_read.mjs`
   - `node tests/test_v637_b_read.mjs`
   - `node tests/test_proactive_memory_ux.mjs`
