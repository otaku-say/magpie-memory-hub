# Agent B 检查点报告：修复 supersede_id 跨项目越权、已失效误激活与前置拦截 (v6.40-b)

## 1. 任务背景与文件所有权约定
- **沙箱 ID**: `95d33cab8d94479393a0199ab47e8a82`
- **工作目录**: `/workspace/m`
- **目标分支**: `feat/v640-b-supersede` (基线 commit: `4c1fc7b`)
- **文件所有权范围（严格限定）**:
  - `tools.js`：仅修改 `saveMemory` 函数内部逻辑（行号约 500-1000）：
    * 将 `supersede_id` 的解析与多重安全校验前置到「0.5) 踩坑优先」之前；
    * 增加跨项目所有权校验 (`cand.project === project`)，防止跨项目越权篡改；
    * 增加有效性与生命周期校验 (`!cand.invalid_at && (!cand.lifecycle_status || cand.lifecycle_status === 'active')`)，防止已失效记录被误"激活"；
    * 校验未通过时返回明确 NOOP (`supersede_id 指向不存在/跨项目/已失效的记录，已忽略取代意图`)，杜绝静默降级；
    * 「0.5) 踩坑优先」拦截增加 `&& !hasValidSupersede`，防止显式取代被同名踩坑拦截。
  - `tests/test_v640_b_supersede.mjs`：新增专项双向反证测试套件。
  - `NOTES_v640_b.md`：本技术设计与验收报告。
- **严禁修改（红线边界）**:
  - `pitfallSave` / `checkAndApplyIronlaw` / `memoryContext` / `memoryGet` / `memoryList` / `TOOLS Schema`
  - `MagpieMemoryHub` 入口 / `gateway_harvest*.js` / `test_meta.mjs` / `semantic_dedup.js`

---

## 2. 缺陷根因分析与技术实现方案 (BUG-39-2)

### 2.1 三处高危漏洞根因
1. **跨项目越权 (a)**：
   - 现状：在 `targetSupersedeId` 未在本地候选集命中时，通过 `client.list("memories", { id: targetSupersedeId, limit: 1 })` 回查，但未校验 `fetched[0].project === project`。
   - 危害：在 project_A 传入 project_B 的记录 ID，会把 project_B 的活跃记忆篡改为 `lifecycle_status="superseded"`，造成严重跨项目未授权篡改。
2. **已失效记录被误“激活”(b)**：
   - 现状：回查与命中时未校验 `!fetched[0].invalid_at` 及 `lifecycle_status`。
   - 危害：传入已软失效或已废弃的 ID 会把它当作有效取代目标，破坏版本链与软失效审计痕迹。
3. **前置踩坑拦截 (c)**：
   - 现状：「0.5) 踩坑优先」检查位于 `supersede_id` 解析之前。
   - 危害：若 pitfalls 表中存在同名/语义相近的踩坑记录，显式传入 `supersede_id` 仍会在 0.5 处直接返回 `action: "NOOP", table: "pitfalls"`，导致记忆取代失败。

### 2.2 修复与防御设计
1. **解析与校验前置**：
   - 将 `allActiveRows` 查询与 `supersede_id` 解析校验提升至「0.5) 踩坑优先」之前。
   - 严格进行双重校验：
     ```javascript
     const hasSupersedeParam = m.supersede_id !== undefined && m.supersede_id !== null && m.supersede_id !== "";
     const targetSupersedeId = (hasSupersedeParam && !isNaN(Number(m.supersede_id)) && Number(m.supersede_id) > 0)
       ? Number(m.supersede_id)
       : null;
     let targetSupersedeRow = targetSupersedeId
       ? allActiveRows.find((r) =>
           r.id === targetSupersedeId &&
           r.project === project &&
           !r.invalid_at &&
           (!r.lifecycle_status || r.lifecycle_status === "active")
         )
       : null;
     if (targetSupersedeId && !targetSupersedeRow) {
       try {
         const fetched = rowsOf(await client.list("memories", { id: targetSupersedeId, limit: 1 }));
         if (fetched.length > 0) {
           const cand = fetched[0];
           if (cand && cand.project === project && !cand.invalid_at
               && (!cand.lifecycle_status || cand.lifecycle_status === "active")) {
             targetSupersedeRow = cand;
           }
         }
       } catch (_) {}
     }
     if (hasSupersedeParam && (!targetSupersedeId || !targetSupersedeRow)) {
       return {
         action: "NOOP",
         id: null,
         note: "supersede_id 指向不存在/跨项目/已失效的记录，已忽略取代意图",
       };
     }
     const hasValidSupersede = Boolean(targetSupersedeId && targetSupersedeRow);
     ```
2. **踩坑优先前置豁免**：
   - 「0.5) 踩坑优先」判断条件增加 `&& !hasValidSupersede`：
     ```javascript
     if (category !== "principle" && !hasValidSupersede) {
     ```
   - 显式取代作为最高优先级用户意图，跳过踩坑优先拦截，同时在无 `supersede_id` 时维持原有踩坑优先行为不变。
3. **写库时间戳一致性**：
   - 遵循同语句内含 `updated_at: nowSql()` 规范，确保更新 payload 具备新鲜度追踪能力。

---

## 3. 双向反证测试矩阵 (tests/test_v640_b_supersede.mjs)

| 序号 | 反证门分类 | 测试场景与断言 |
| :--- | :--- | :--- |
| **a** | 跨项目越权反证 | project_A 存 fact，project_B 用其 id 作为 supersede_id 保存 → 必须返回 NOOP，且 project_A 记录 lifecycle_status 仍为 active、invalid_at 为 null，project_B 0 写入 |
| **b** | 已失效记录反证 | 已 soft-delete (invalid_at 非空) 的记录 id 作为 supersede_id 保存 → 必须返回 NOOP，不得作为有效取代目标 |
| **c** | 正常同项目取代 | 同项目同标题显式传 supersede_id → 必须成功返回 UPDATE，旧记录置为 superseded 并指向新 ID，新记录 revision 递增 |
| **d** | 同名踩坑穿透 | 库中存在同名踩坑时，显式传 supersede_id 必须穿透踩坑优先拦截成功 UPDATE，不得被拦截为 table="pitfalls" 的 NOOP |
| **e** | 缺省行为保全 | 不传 supersede_id 时，原有的语义查重 NOOP 与踩坑优先拦截机制 100% 保持不变 |
| **meta** | 元规范与零残留 | scanTestFile 静态扫描 0 违规，createTestEnv 隔离运行，结束后 residue.total === 0 |

---

## 4. 验证与回归记录
1. 测试套件全量执行验证：
   - `node tests/test_meta.mjs`
   - `node tests/test_v640_b_supersede.mjs`
   - `node tests/test_v639_b_save.mjs`
   - `node tests/test_v638_a_write.mjs`
   - `node tests/test_dedup_and_audit.mjs`
2. 零残留验证：
   - `env.cleanup()` + `residue.total === 0` 强断言。
