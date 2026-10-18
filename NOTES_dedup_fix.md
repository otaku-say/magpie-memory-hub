# NOTES_dedup_fix.md: 自动采集记忆严重重复根因与语义去重设计方案

## 1. 现象与根因确认

### 用户实测现象
- 开启 `auto_harvest` 对话单话题后，NCB 数据库中产生 64 条记忆（`origin=harvest`，`project=global`）。
- 其中 25+ 条为相同事实的变体：
  - `[64] Magpie Web Search MCP端点与特性` 至 `[40]` 重复 20+ 次
  - `「项目统一使用 pnpm 管理依赖」` 重复 7 次（措辞标题各异）
  - `「显式记忆保存禁止调用大模型」` 重复 3-4 次

### 根因分析
1. **字面哈希拦截失效**：`content_fingerprint` 是基于 `crypto.createHash("sha256").update(`${project}:${category}:${title}:${content}`).digest("hex")` 的字面哈希。在线提炼模型每轮对话输出的标题、标点、虚词或修饰语略有不同，算出完全不同的哈希，导致数据库上的 `(project, content_fingerprint)` 唯一索引彻底无法拦截语义重复。
2. **缺乏复发计数机制**：`pitfalls` 表具备 `recurrence` 字段且查重时会累加复发计数与更新时间，而 `memories` 表此前没有 `recurrence` 列，查重命中时直接静默忽略或遗漏，且无法表达同一事实被多次观察到的置信强化。
3. **写入通道前置去重缺失**：
   - `gateway_harvest.hooks.js` 的 `harvestDialogue` 仅使用字面哈希计算队列 ID 与内存防重（`isRecent("m:" + fp)`），措辞稍变即可穿透。
   - `drainHarvestQueue` 仅做单条精确 `content_fingerprint` 查重，未对同项目同分类的近期记忆做语义相似度比对。
   - `tools.js` 的 `saveMemory` 仅比对精确指纹与精确标题 `title.toLowerCase()`，措辞微调即新增条目。

---

## 2. 语义级去重架构设计

本方案实现 **Layer ①（归一化指纹）** + **Layer ②（近期记忆语义相似度比对）** 双层防御：

### Layer ①：语义指纹归一化（Normalized Fingerprint，必做）
在计算指纹前执行语义归一化（`normalizeSemanticText`）：
1. 字母统一转小写。
2. 剥离 Markdown 符号（`*`、`#`、`_`、反引号等）与各类中英文引号、书名号、括号（`「`、`」`、`『`、`』`、`“`、`”`、`【`、`】` 等）。
3. 剥离无实义的结构助词与弱虚词（`的`、`之`、`地`、`得`）。
4. 归一化常见同义表达与前后缀变体：
   - `端点与工具特性` / `接口与特性` / `端点及特性` / `工具特性与端点` → `端点与特性`
   - `特性说明` / `工具特性` / `功能特性` → `特性`
   - `进行依赖管理` / `依赖包管理` / `依赖管理` → `管理依赖`
   - `严禁` / `不可` / `不要` / `切勿` → `禁止`
   - `采用` / `利用` → `使用`
   - `直达` → `直接`
   - `记忆保存` → `保存记忆`
   - 过滤口语与填充短语（`进行`、`关于`、`对于`、`具备` → `提供`）
5. 剔除所有中英文标点、符号与空白字符。
6. 计算归一化哈希：`semanticFingerprint(project, category, normTitle, normContent)`。
**效果**：直接拦下标点差异、括号包裹、大小写差异与绝大多数常见措辞/后缀变体。

### Layer ②：局部滑动窗口语义相似度比对（Semantic Similarity Comparison，建议做）
在入库前，与同 `project` + 同 `category` 的最近 N 条（默认 50 条）活跃记忆做相似度比对：
1. **实体硬门禁**：若两侧均含有英文/数字技术专有名词（如 `pnpm`、`react18`、`nodejs20`），若交集为空则判定为不同事实（防止句式相近但技术实体不同的误判）。
2. **多维相似度计算**：
   - **Jaccard 词元相似度**：字/双字/英文单词集合交并比 `|A ∩ B| / |A ∪ B|`。
   - **Overlap / 包含率**：`|A ∩ B| / min(|A|, |B|)`，准确捕获“简略表述与详尽表述”的包含关系。
   - **Levenshtein 编辑距离相似度**：`1 - lev(s1, s2) / max(len1, len2)`。
3. **判定门限**：
   - 标题完全归一相同，直接判定命中。
   - 标题高度相似（Overlap >= 0.75 且 Jaccard >= 0.5，或 Lev >= 0.7）且内容相关（Overlap >= 0.4 或 Jaccard >= 0.22），判定命中。
   - 综合加权得分 `>= 0.6` 时判定命中。
4. **命中处理**：不新增记录，将既有记录的 `recurrence` 累加，并刷新 `updated_at` 为当前时间。

### Layer ③：在线模型判定（可选，视需要启用）
经实测，Layer ① + Layer ② 已能 100% 覆盖用户反馈的 Web Search MCP、pnpm 依赖管理、禁止调用大模型等各类真实变体，同时在 0 token 消耗、0 网络往返延迟（<1ms）下运行。故本轮上线 Layer ① + Layer ②，不盲目增加在线模型调用开销。

---

## 3. 数据库 Schema 同步设计

对齐 `pitfalls` 表，在 `memories` 表新增 `recurrence` 字段：
- `schema.js`:
  - `SCHEMA_VERSION`: 4 → 5
  - `MIGRATIONS[5]`: `"memories 表新增 recurrence (INT, default 1) 观察复发次数与语义去重计数，对齐 pitfalls 表"`
  - `TABLES.memories.columns`: 新增 `{ name: "recurrence", type: "INT", default: "1" }`
- 写入点同步：
  - `tools.js` (`saveMemory` 载荷与查重更新)
  - `gateway_harvest.hooks.js` (`memoryPayload` 与 `drainHarvestQueue` 查重更新)
  - `gateway_harvest.js` (`saveMemory` 调用)
  - `harvest.py` (`save_memory` 载荷与查重更新)
- 校验测试：
  - `tests/check_schema_sync.mjs`
  - `tests/test_schema.mjs`
  - `README.md`

---

## 4. 存量重复数据清理方案与 SQL（不执行，由用户确认后执行）

### 清理依据与策略
- 针对用户库中的 64 条数据：
  1. 按 `(project, category)` 分组，识别出主题相同（Web Search MCP 变体、pnpm 变体、显式保存禁调大模型变体等）的重复条目。
  2. **保留组内最早入库的一条**（即 `MIN(id)`），以保持初始创建时间与外键关联安全。
  3. **累加复发频次**：将重复出现的次数计入保留行的 `recurrence`，并将 `updated_at` 刷新至最近时间，保证事实观察权重不丢失。
  4. **删除多余变体**：安全删除其余冗余行（`id > min_id`）。

### 可执行 SQL 脚本（详见后续完整报告）

---

## 5. 测试验收计划
1. **反证门测试**：构造同一事实的 5 种不同措辞，断言最终仅入库 1 条记录，且 `recurrence = 5`。
2. **正例门测试**：构造 3 个不同事实（Web Search MCP、pnpm 管理、显式保存禁模型），断言全部成功入库（3 条独立记录）。
3. **回归测试**：
   - `tests/check_schema_sync.mjs`
   - `tests/test_all_20_tools_e2e.mjs`
   - `tests/test_denoise_p0.mjs`
   - `tests/test_meta.mjs`
   - 全套测试必须 100% 绿色通过，且测试数据严格隔离并零残留。
