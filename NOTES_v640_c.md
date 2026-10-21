# v6.40-c 修复记录：MCP Schema 补全自演进参数声明与 _no_scheduler 入口前置隔离

## 1. 任务背景与文件所有权原则
- **BUG-39-3（中危）**：MCP 工具 Schema 遗漏声明自演进关键参数。
  - `memory_save` 漏声明 `supersede_id`、`supersede`、`related_entities`；
  - `pitfall_save` 漏声明 `related_entities`、`recurrence`；
  - `memory_context` 漏声明 `max_principles`。
  - 这些参数底层逻辑均已完整实现，且 conflict_candidates note 明确引导 Agent 使用 `supersede_id`，但 Schema 缺失导致客户端大模型无法感知或被严格 Schema 校验器剥离。
- **BUG-39-4a（中危）**：`_no_scheduler` 隔离标记解析过晚，未包裹入口前置副作用。
  - `writeCardStatus("db", dbInfo)`（约 4215 行）、`autoInit` 自愈（约 4243 行）与 `autoHarvest` 自动增量提炼（约 4253 行）在 `noScheduler` 解析（约 4271 行）之前执行。
  - 导致后台 drain 构造的临时 hub 仍会覆写宿主 `_status.js` 卡片、触发 DDL 探测和重复增量扫描。
- **文件所有权遵守**：
  - 允许修改：`tools.js` 的 TOOLS Schema 区（约 3870-3960）与 MagpieMemoryHub 入口区（约 4210-4280）。
  - 新增文件：`NOTES_v640_c.md`、`tests/test_v640_c_schema.mjs`。
  - **严禁修改**：saveMemory / pitfallSave / checkAndApplyIronlaw / memoryContext / memoryGet / memoryList / memorySearch / gateway_harvest*.js / test_meta.mjs / semantic_dedup.js。
  - **禁改计数原则**：严格遵从 DEVNOTES.md 规范，不修改 `test_meta.mjs` 中的文件计数断言，由新测试通过 `scanTestFile` 执行规范自证（0 违规），待合并阶段统一锁定计数。

---

## 2. 根因深度剖析与修复设计

### 2.1 BUG-39-3：Schema 自演进参数声明补齐 (EVO-17)
在 `tools.js` 的 `TOOLS` 对象中对应工具的 `args.properties` 补齐字段声明：
1. **`memory_save`**:
   - `supersede_id`: `{ type: "number", description: "要取代的旧记录 ID（显式取代走 UPDATE）" }`
   - `supersede`: `{ type: "boolean", description: "强制以新内容扩充/覆盖同标题记录" }`
   - `related_entities`: `{ type: "string", description: "关联实体，逗号分隔" }`
2. **`pitfall_save`**:
   - `related_entities`: `{ type: "string", description: "关联实体，逗号分隔" }`
   - `recurrence`: `{ type: "number", description: "本次复发次数，默认 1" }`
   - 确认既有 `root_cause` 属性保留，不予改动。
3. **`memory_context`**:
   - `max_principles`: `{ type: "number", description: "置顶准则条数上限，默认 2" }`
4. **必填防线**：
   - 严格保留各工具原有的 `required` 数组（`memory_save` 为 `["title", "content"]`，`pitfall_save` 为 `["symptom", "solution"]`，`memory_context` 无 required），绝不误将新增参数加入必填，防止未传参数的大模型报错。
5. **名称合规防线**：
   - description 中避免出现触发 `test_tool_names_static.mjs` 正则误报的词汇。

### 2.2 BUG-39-4a：`_no_scheduler` 隔离标记前置至副作用之前
在 `tools.js` 的 `MagpieMemoryHub` 入口中：
1. 将 `noScheduler` 解析提前至最前部（`client` 构造之后、`writeCardStatus` 之前）：
   ```javascript
   const noScheduler = (options && options._no_scheduler === true) || (input && input._no_scheduler === true);
   ```
2. 使用 `!noScheduler` 包裹前置副作用：
   - `writeCardStatus("db", dbInfo)` 包装在 `if (!noScheduler) { ... }` 中；
   - `autoInit` 改为 `if (!noScheduler && cfg.autoInit && cfg.mcpKey && !isTestMode())`；
   - `autoHarvest` 改为 `if (!noScheduler && cfg.autoHarvest && !isTestMode())`。
3. 保持后续调度器管理中已有的 `if (!noScheduler)` 分支；
4. 保证 `_no_scheduler: true` 构造的临时 hub 依然完整返回所有工具映射（`tool` 对象可用）。

---

## 3. 双向反证测试矩阵 (tests/test_v640_c_schema.mjs)

| 门禁分类 | 测试用例 | 验证与反证设计 |
| :--- | :--- | :--- |
| **Schema 反证 a** | `memory_save` 属性声明 | 断言 `TOOLS.memory_save.args.properties` 包含 `supersede_id`, `supersede`, `related_entities` |
| **Schema 反证 b** | `pitfall_save` 属性声明 | 断言 `TOOLS.pitfall_save.args.properties` 包含 `related_entities`, `recurrence`，且既有 `root_cause` 未被破坏 |
| **Schema 反证 c** | `memory_context` 属性声明 | 断言 `TOOLS.memory_context.args.properties` 包含 `max_principles` |
| **Schema 反证 d** | `required` 约束守卫 | 断言 `memory_save.required` 仅为 `["title", "content"]`，`pitfall_save.required` 仅为 `["symptom", "solution"]`，未误加任何新增可选参数 |
| **端到端反证 e** | `supersede_id` 真实取代调用 | 构造旧记录并记录其 ID，通过 `tool["memory_save"].execute` 传入该 `supersede_id` 写入新记录，断言旧记录被标记为 `superseded`，新记录为 active 且关联正确 |
| **隔离反证 f** | `_no_scheduler: true` 前置副作用阻断 | 传入 `_no_scheduler: true`，断言 `writeCardStatus` 未被调用、`dbInit` 未被调用、`harvestGateway` 未被调用，且 `hub.tool` 仍完整具备 21 个工具 |
| **对照反证 g** | 默认主路径无回归 | 未传入 `_no_scheduler` 时，`writeCardStatus` 正常执行，主路径原有加载逻辑 100% 保持不变 |
| **合规与零残留 h** | 元检查自检与清理 | `scanTestFile` 静态扫描本测试 0 违规；命名空间隔离运行，测试完成后 `residue.total === 0` |

---

## 4. 验证与回归记录
1. 遵循文件所有权与“禁改计数”原则，严禁修改 `test_meta.mjs`。
2. 静态工具名检查：`node tests/test_tool_names_static.mjs` 100% PASS（0 误报，21 工具全集校验）。
3. 调度器隔离历史回归：`node tests/test_v639_c_nosched.mjs` 100% PASS。
4. 导出面合规复核：`node tests/test_exports.mjs` 100% PASS。
5. 专项双向反证：`node tests/test_v640_c_schema.mjs` 100% PASS。
