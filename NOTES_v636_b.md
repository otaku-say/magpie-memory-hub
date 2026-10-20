# EVO-3 检索增强技术架构与修复方案 (NOTES_v636_b.md)

## 1. 任务背景与文件所有权约定
- **沙箱 ID**：`158406d85fae4b34a284c07a1332f606`
- **代码目录**：`/workspace/m`
- **工作分支**：`feat/v636-b-evo3`
- **文件所有权范围（严格遵循）**：
  - 核心修改：`semantic_dedup.js`（`termsOf` 符号裂变与分词）、`tools.js`（仅 `scoreMemory` 函数与 `memory_context` 读取/输出 `related_entities` 行）。
  - 新增文件：`tests/test_v636_b_evo.mjs`、`NOTES_v636_b.md`。
  - 严格禁改：`saveMemory` / `pitfallSave` / `memoryGet` / `tests/test_meta.mjs` / 其他既有 tests。

---

## 2. 缺陷根因分析

### 2.1 【缺陷 A】`related_entities` 检索失明（tools.js 约 393 行）
- **现象**：数据库中存储有 `related_entities: "Prisma,PostgreSQL"` 的记忆条目，按关键词 `"Prisma"` 进行检索时命中数为 0。
- **根因**：`tools.js` 中 `scoreMemory` 原实现为：
  ```javascript
  const body = String(row.content || row.related_entities || "").toLowerCase();
  ```
  在实际生产与测试场景中，记忆条目的 `content` 正文非空恒为真，导致逻辑或 `||` 永远短路，`row.related_entities` 100% 被忽略，造成相关实体字段完全检索失明。

### 2.2 【缺陷 B】`termsOf` 无法拆分 camelCase 与 snake_case 代码符号
- **现象**：用户或 Agent 查询 `"memoryAuditUndo"` 或 `"dedup_batch_size"` 时，无法命中包含对应子词（如 `"audit"`、`"batch"`）的正文，也无法从代码符号中解构语义。
- **根因**：原 `termsOf` 在分词阶段先执行 `q.toLowerCase()`，破坏了 camelCase 大小写驼峰边界；同时仅提取 `[a-z0-9_-]{2,}` 整词，未对下划线 `_` 或连字符 `-` 作符号裂变。

---

## 3. 整改方案与核心实现

### 3.1 修复 `scoreMemory`（tools.js）
- **权重独立化**：为 `related_entities` 单独赋予权重 `+3`（对齐标签权重 3，高于正文权重 1，低于标题权重 5）。
- **完全解耦与独立累加**：
  ```javascript
  function scoreMemory(row, terms) {
    if (!terms.length) return 1;
    const title = String(row.title || "").toLowerCase();
    const tags = String(row.tags || "").toLowerCase();
    const entities = String(row.related_entities || "").toLowerCase();
    const content = String(row.content || "").toLowerCase();
    let s = 0;
    for (const t of terms) {
      if (title.includes(t)) s += 5;
      if (tags.includes(t)) s += 3;
      if (entities.includes(t)) s += 3;
      if (content.includes(t)) s += 1;
    }
    return s;
  }
  ```
  绝不使用 `||` 短路，`entities` 与 `content` 独立匹配并按权重累加。

### 3.2 增加符号裂变分词 `termsOf`（semantic_dedup.js & tools.js）
- **驼峰裂变 (camelCase / PascalCase)**：
  通过正则匹配大写边界，将 `memoryAuditUndo` 裂变为小写子词：`memory`、`audit`、`undo`，同时保留小写全名 `memoryauditundo`。
- **下划线裂变 (snake_case / kebab-case)**：
  将 `dedup_batch_size` 裂变为小写子词：`dedup`、`batch`、`size`，同时保留原名 `dedup_batch_size` 与去符号全名 `dedupbatchsize`。
- **只加不减原则**：所有裂变词与原始词并入词集 `Set`，中文 2-gram 分词、虚词 `CJK_STOP_BIGRAMS` 过滤及非字符串防御机制完全保留。

### 3.3 `memory_context` 组装文本注入 `related_entities`（tools.js）
- 在 `memoryContext` 格式化 memories 及 principles 输出行时，若记录包含 `related_entities`，将其格式化为 ` | 实体: <entities>` 并入输出行：
  `- [fact] 架构规范 | 实体: Prisma,Redis: 统一使用 Prisma 连接数据库`
  便于 Agent 判断技术栈上下文并直接定位关联实体。

---

## 4. 双向反证测试方案 (`tests/test_v636_b_evo.mjs`)
1. **反证门 1（实体召回必命中）**：
   正文无 "Prisma"、仅 `related_entities: "Prisma,PostgreSQL"` 的记忆，检索 "Prisma" 必须命中（修复前命中 0）。
2. **反证门 2（代码符号全名与子词双向必命中）**：
   检索 `memoryAuditUndo` 必须命中包含 `audit` 或 `memory` 的记录；检索 `audit` 亦必须命中包含 `memoryAuditUndo` 的记录。
   检索 `dedup_batch_size` 必须命中包含 `batch` 的记录；检索 `batch` 亦必须命中包含 `dedup_batch_size` 的记录。
3. **反证门 3（防过度召回，无关 query 必不命中）**：
   检索与标题/正文/标签/实体完全无关的词汇（如 `"kubernetes"`、`"mongodb"`），命中得分必须为 0，结果集必须为空。
4. **反证门 4（上下文输出格式验证）**：
   调用 `memory_context`，断言生成的 Context 块中明确包含 `| 实体: Prisma,PostgreSQL`。
5. **元规范自检**：
   引入 `scanTestFile` 对测试文件自检，断言 0 违规、写库带隔离与清理、残余断言为 0。
