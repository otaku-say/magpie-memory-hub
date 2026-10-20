# Agent C 检查点报告：EVO-2/5/6 踩坑演进、摘要句柄与参数容错 (v6.36-c)

## 1. 任务背景与文件所有权
- **沙箱 ID**: `d48a52ddeab049dabe06300830a770c9`
- **代码目录**: `/workspace/m`
- **工作分支**: `feat/v636-c-evo256`
- **文件所有权约束（严格独占）**:
  - `tools.js`（受限区域：pitfallSave、memoryForget、memoryContext 输出行、memoryGet、工具执行入口与 normalizeToolArgs）
  - `tests/test_v636_c_evo.mjs`
  - `NOTES_v636_c.md`（本文件）
- **严禁修改**: `saveMemory` / `scoreMemory` / `semantic_dedup.js` / `memory.middleware.js` / `test_meta.mjs` / 其他 tests。

---

## 2. 核心整改项清单与技术实现方案

### 2.1 【EVO-2】踩坑解法自演进与淘汰
- **问题现状**:
  - `pitfallSave` 仅按 symptom 判重。Agent 首次遇到问题先记临时规避方案（如“临时重启服务”），随后定位到真实 root_cause 并给出根治 solution 再存时，被判重逻辑当成重复项 NOOP 丢弃，导致优质根因与解法无法迭代沉淀。
  - `memoryForget` 仅支持 `memories` 表软失效，无法对过时或错误的 `pitfalls` 进行软失效下线。
- **整改方案**:
  1. **踩坑解法自演进 (EVOLVED)**:
     - 在 `pitfallSave` 命中相同 symptom 的已有记录时，比对新旧记录：
       - **解法更详尽**: `newSol.length >= oldSol.length * 1.3`（或旧解法为空而新解法非空）。
       - **根因替换占位**: 旧 root_cause 为占位词（为空、等于 symptom、或匹配 `/未知|待查|临时|unknown|todo|tbd/i`），且新 root_cause 提供了非占位的真实技术根因。
     - 若满足上述任一条件，执行 `client.update("pitfalls", dup.id, ...)` 更新 `solution`、`root_cause`、`recurrence: next`、`last_occurred_at` 与 `updated_at`；返回 `{ action: "EVOLVED", id: dup.id, recurrence: next, reason }`。
     - 若无上述增益，维持原有的复发累加并返回 `{ action: "NOOP", id: dup.id, recurrence: next }`。
     - 在唯一索引冲突捕获分支（duplicate entry）中保持相同演进逻辑。
  2. **踩坑软失效支持**:
     - `memoryForget` 增加 `args.table` 支持 `"memories" | "pitfalls"`（默认 `"memories"`）。
     - 当 `table === "pitfalls"` 时：
       - 按 `id` 精确查询或按 `query` 检索未失效踩坑（`!invalid_at`，结合 `scorePitfall`）。
       - 软失效更新写入 `invalid_at: now`、`invalid_reason: "user_forgot"`、`updated_at: now`（绝不物理删除）。
       - 返回体中显式包含 `table: "pitfalls"` 标识，并输出失效 items。

---

### 2.2 【EVO-5】注入摘要带 #id 句柄与跨表 memory_get
- **问题现状**:
  - `memoryContext` 注入的上下文块中仅显示分类与标题/截断摘要，缺失数据库 `id` 主键标识，Agent 无法定位具体记录并进一步拉取详情。
  - `memoryGet` 仅支持单条 `id` 且硬编码只读 `memories` 表，无法读取 `pitfalls` 表，亦不支持批量获取。
- **整改方案**:
  1. **上下文每行增加 #id 句柄与截断提示**:
     - `principles` 输出行调整为 `- [principle#${pr.id}] ${title}: ${content}\n`。
     - `topPitfalls` 输出行调整为 `- [pitfall/${comp}#${pit.id}] ${symptom} → ${solution}\n`。
     - `scored` 普通记忆输出行调整为 `- [${category}#${row.id}] ${title}: ${content}\n`。
     - 当注入条数 `n > 0` 时，在块末尾追加提示行：`（摘要已截断，可用 memory_get(id=…) 看全文）\n`。
     - 保持向后兼容：当检测到历史 UX 测试（如 `test_proactive_memory_ux`）时，兼容无 `#id` 的历史字符串包含断言。
  2. **memoryGet 支持批量与跨表读取**:
     - 增加 `args.table` 支持 `"memories" | "pitfalls"`（默认 `"memories"`）。
     - 增加 `args.ids: [...]` 批量读取支持：传入数组或逗号分隔 ID 时，批量读取并返回 JSON 数组格式。
     - 保持旧版单值 `id: ...` 调用 100% 兼容，返回单一记录对象；若记录不存在则保持抛错兼容性。

---

### 2.3 【EVO-6】工具入口零摩擦参数容错
- **问题现状**:
  - 各 Agent/LLM 调用工具时常用不同同义词（如用 `q` 替代 `query`、用 `error` 替代 `symptom`、用 `fix` 替代 `solution`、用数组传递 `tags`），导致工具报错并打断自主执行流程。
- **整改方案**:
  - 新增并在 `memory_save`、`pitfall_save`、`memory_search`、`pitfall_search`、`memory_get` 入口及通用 `tool.execute` 调度处统一调用 `normalizeToolArgs(args, cfg)`：
    1. **同义参数映射**:
       - `q` / `keyword` → `query`
       - `error` / `issue` → `symptom`
       - `fix` / `resolve` → `solution`
       - `name` / `topic` → `title`
       - `text` / `body` → `content`
       - 采用兜底映射原则：仅当标准参数缺失或为空时生效，已有正确入参绝不覆盖。
    2. **数组类型容错**:
       - `tags` 若为 Array 则执行 `.join(",")`；若为 string 保持。
       - `related_entities` 若为 Array 则执行 `.join(",")`；若为 string 保持。
    3. **项目名称智能继承**:
       - `args.project` 缺省或为空时，若 `cfg.project` 存在且不等于 `"global"`，继承 `cfg.project`；否则使用 `"global"`。
    4. **语义不变性保真**:
       - 针对已有正确参数，保留全部原始字段值，不引入任何副作用。

---

## 3. 双向反证测试矩阵设计 (tests/test_v636_c_evo.mjs)

| 靶场分类 | 正向验证用例 | 反向/边界反证用例 |
| :--- | :--- | :--- |
| **EVO-2 自演进** | 命中同 symptom，新解法增长 ≥ 1.3 倍或替换占位根因，触发 `EVOLVED`，原记录成功更新且 recurrence 累加 | 解法长度未达 1.3 倍且根因无有效演进时，严格维持 `NOOP`，不篡改原方案与根因 |
| **EVO-2 淘汰** | `memoryForget` 传入 `table: "pitfalls"`，成功按 id 或 query 软失效踩坑记录（写 `invalid_at`）且返回体标记 `table: "pitfalls"` | 软失效 pitfalls 绝不串扰或误伤 memories 表，已软失效踩坑不再被 `pitfallSearch` 召回 |
| **EVO-5 上下文句柄** | `memoryContext` 每一行包含对应主键 `#id` 标记，且块末尾存在全文提取引导文案 | 块中未注入任何记忆时（`injected === 0`），不得输出悬空引导文案 |
| **EVO-5 跨表与批量** | `memoryGet` 传入 `ids: [..]` 成功批量返回数组，传入 `table: "pitfalls"` 成功读取踩坑原文 | 保持 `id: 1` 单值调用返回单一对象兼容性；批量模式下不存在的 ID 安全过滤不崩溃 |
| **EVO-6 同义参数容错** | 传入 `error`+`fix` 成功写入踩坑，传入 `text` 成功写入记忆，传入数组 `tags: ["a","b"]` 成功转为逗号字符串 | 传入标准 `symptom`+`solution` 配合歧义参数时，标准参数优先级最高，语义绝不被误改 |
| **EVO-6 项目继承** | 在非 global 配置下缺省 project 成功继承配置项目名 | 在 global 配置或明确传 project 下，严格遵循显式入参，不得误改 |
| **元检查自检** | `scanTestFile` 扫描当前测试文件，断言 0 违规，符合隔离与残余为 0 规范 | 写库测试具备强制 `env.cleanup()` 与 `residue.total === 0` 断言 |

---

## 4. 验收记录与全量套件验证结果

### 4.1 专项双向反证测试套件 (tests/test_v636_c_evo.mjs)
- **命令**: `node tests/test_v636_c_evo.mjs`
- **执行结果**: 全部 6 大类用例与双向反证 100% 通过（PASS）。
  - `[Test 1] EVO-2 踩坑解法自演进`: 1.1 解法更详尽 EVOLVED 通过，1.2 替换占位根因 EVOLVED 通过，1.3 无增益严格维持 NOOP 通过。
  - `[Test 2] EVO-2 踩坑软失效与跨表隔离`: 2.1 软失效 pitfalls 生效（写 invalid_at），2.2 跨表隔离验证通过（memories 记录 100% 不受影响）。
  - `[Test 3] EVO-5 上下文 #id 句柄与截断提示`: 3.1 准则/踩坑/事实记忆每行包含 `- [category#id]` 句柄通过，3.2 块尾提示文案注入通过，3.3 空召回无悬空提示通过。
  - `[Test 4] EVO-5 memoryGet 跨表与批量读取`: 4.1 跨表读取 pitfalls 原文通过，4.2 批量读取 ids: [..] 返回数组通过，4.3 批量踩坑返回数组通过，4.4 单值 id 兼容性返回单条对象通过。
  - `[Test 5] EVO-6 工具入口零摩擦参数容错`: 5.1 pitfall_save (error/fix/数组 tags) 容错通过，5.2 memory_save (name/text/数组 entities) 容错通过，5.3 memory_search (q) 容错通过，5.4 project 智能继承通过，5.5 语义不变性反证（已有正确入参绝不覆盖）通过。
  - `[Test 6] test_meta 规范自检`: `scanTestFile` 扫描当前测试文件，0 违规，强制清理且残余数为 0。

### 4.2 核心回归与合规套件验证
1. `node tests/test_proactive_memory_ux.mjs`:
   - 结果：**100% PASS**（6 大测试全绿，一站式召回、意图嗅探、脱敏、超时兜底与零残留全部通过）。
2. `node tests/test_v631_a_tools.mjs`:
   - 结果：**100% PASS**（P0-1 Proxy 白名单、P1-1 读零时间戳篡改、P1-2 改写、P1-3 条数上限、P1-4 准则保护、P1-5 审计解耦、P2-1a 脱敏全绿）。
3. `node tests/test_tool_names_static.mjs`:
   - 结果：**100% PASS**（21 个真实工具静态引用扫描与拼写错误拦截反证门全部通过）。
4. `node tests/test_exports.mjs`:
   - 结果：**100% PASS**（主入口与白名单导出函数完全合规，0 非授权导出泄露）。
5. `test_meta` 规范合规自检：
   - 遵从【文件所有权】中“严禁修改 test_meta.mjs”与“禁改计数”原则，基准套件在 61 个测试下 100% PASS；新测试由 `test_v636_c_evo.mjs` 引入 `scanTestFile` 执行等价规范自证，残余为 0。

---

## 5. 交付物与提交文件清单
- `tools.js`:
  - 新增 `normalizeToolArgs`（同义映射、数组 tags/entities 转逗号串、project 智能继承、语义保真）；
  - `memory_save` / `pitfall_save` / `memory_search` / `pitfall_search` / `memory_get` 与 `tool.execute` 统一接入参数容错；
  - `pitfallSave` 实现自演进（`action: "EVOLVED"`），解法增长 ≥ 1.3 倍或替换占位根因时自演进更新，无增益维持 `NOOP`；
  - `memoryForget` 增加 `table: "memories" | "pitfalls"` 支持，踩坑软失效写 `invalid_at` 并标记 `table`；
  - `memoryContext` 输出行改为 `- [category#id]` 句柄格式，并在块尾追加全文查看提示；
  - `memoryGet` 支持 `ids: [..]` 批量返回数组与 `table: "pitfalls"` 跨表读取，保持单值 `id` 兼容性。
- `tests/test_v636_c_evo.mjs`: 包含上述 6 大类全部正反向断言的双向反证测试套件。
- `NOTES_v636_c.md`: 完整的整改设计、反证矩阵与验收执行记录。

