# Agent C 检查点报告：BUG-5 提炼链路同步新能力与 EVO-8 中间件符号感知+复发加权 (v6.37-c)

## 1. 任务背景与文件所有权
- **沙箱 ID**: `91bf90facbef46bf9d23d4ebae58e33f`
- **代码目录**: `/workspace/m`
- **工作分支**: `feat/v637-c-harvest`
- **文件所有权约束（严格遵循）**:
  - 独占修改:
    - `gateway_harvest.hooks.js`（修复 BUG-5）
    - `memory.middleware.js`（实现 EVO-8，严格保持 ES5 规范）
  - 独占新增:
    - `tests/test_v637_c_harvest.mjs`
    - `NOTES_v637_c.md`（本文件）
  - 严禁修改: `tools.js` / `semantic_dedup.js` / `local_state.js` / `test_meta.mjs` / 其他既有 tests。

---

## 2. 核心整改项清单与技术方案

### 2.1 【BUG-5】后台自动提炼链路未同步 v6.36.0 新能力
- **问题现状分析**:
  1. `HARVEST_SYSTEM_PROMPT` 只包含 fact/preference/decision/pitfall 四类，缺少 `principle`（用户长期铁律/核心架构准则）分类说明，输出 JSON 规范未定义 `related_entities`，且未对 pitfall 明确独立要求 `root_cause` 与 `solution` 两个字段。
  2. 约 947 行处硬编码 `related_entities: ""`，导致模型提取或传入的关联实体信息在写入队列时全部丢失。
  3. 约 750 行在构造 pitfalls 记录时把 `solution` 与 `root_cause` 同时默认回退设为 `content`（导致根因=解法，语义混淆）。
  4. 约 1007 行将未提供根因的踩坑填充为硬编码模板字符串（`执行中出现 ${symptom}，后续成功解决`），破坏了占位根因自演进识别机制。
  5. `triggerBackgroundDrain` 后台异步落库直接调用底层原始 DB 接口，遇到重复项时仅执行简单计数累加，未复用现有 `saveMemory` / `pitfallSave` 业务逻辑，丢失了增量扩充（ENRICHED）、踩坑解法自演进（EVOLVED）及 preference/decision 满额自动升维 principle 的能力。
- **整改实现方案**:
  1. **系统提示词与输出契约升级**:
     - `HARVEST_SYSTEM_PROMPT` 的【必须记录的内容】增加第 1 类 `长期铁律/架构原则 (principle)`，明确说明其为用户确立的长期铁律或核心架构原则。
     - 输出 JSON 规范增加 `related_entities` 字段（逗号分隔实体名，可为空串）。
     - 输出 JSON 规范中明确：针对 pitfall 类要求分别给出 `root_cause`（技术根因）与 `solution`（已验证解法）两个独立字段。
  2. **模型解析与载荷实体对齐**:
     - 在 `harvestWithOnlineModel` 遍历 items 时提取 `item.related_entities`，缺省回退为空串 `""`。
     - 在 `processDialogueAndHarvest` 构造 `memoryPayload` 与 `pitfallPayload` 时，移除 `related_entities: ""` 硬编码，改用 `item.related_entities ? String(item.related_entities).trim() : ""`。
  3. **根因与解法语义解耦**:
     - 在 `harvestWithOnlineModel` 与 `processDialogueAndHarvest` 中：`root_cause` 与 `solution` 分别提取模型输出。
     - 若模型未提供 `root_cause`，**坚决保留为空串 `""`**，交由后续 Agent/会话演进补全（`isPlaceholderRootCause` 识别为空串可顺利触发 `EVOLVED`），绝不用 `solution` 或占位文案顶替。
     - `solution` 优先取 `item.solution`，兜底使用 `item.content`。
  4. **后台落库接入 saveMemory / pitfallSave**:
     - `triggerBackgroundDrain` 接入 `saveMemory` / `pitfallSave`：支持 `options.saveMemory` / `options.pitfallSave` 显式注入，缺省时由 `MagpieMemoryHub` 调度标准工具执行链路。
     - 对输入 client 进行防御性包装（若缺少 `client.update` 则自动提供无害回退），确保 mock 客户端兼容性。
     - 捕获并记录落库 action（`ADD`/`CREATED`、`ENRICHED`、`EVOLVED`、`NOOP`），不吞掉返回值，并分别计入统计 `memoriesSaved`、`pitfallsSaved`、`memoriesEnriched`、`pitfallsEvolved` 与 `actions` 字典，输出诊断日志 `_diag("drain_action", ...)`。

---

### 2.2 【EVO-8】网关中间件零延迟符号感知与复发加权
- **问题现状分析**:
  1. `memory.middleware.js` 运行在网关进程内的 moejs 受限环境（ES5 规范，禁止 `const`/`let`/箭头函数/正则命名组/Promise/网络/文件）。
  2. 现有的 ES5 `tokenize()` 仅支持简单的正则切词与中文 2-gram，无法感知代码符号中的 `camelCase`（如 `memoryAuditUndo`）与 `snake_case`（如 `dedup_batch_size`），导致检索符号子词时完全失明。
  3. RRF 四路融合中的热度项 `_heat` 仅取 `retrieval_count`，未对高频验证/复发的知识（`recurrence`）进行加权，无法让多次确证的经验优先胜出。
- **整改实现方案**:
  1. **ES5 符号裂变分词**:
     - 保持 ES5 纯语法（全部使用 `var`、标准 `function`、基础正则 `$1 $2` 捕获）。
     - 实现 `splitCamelCase(word)` 辅助函数，拆分小写子词。
     - 在 `tokenize(text)` 中：
       - 保留原始大小写 run，先存入全名小写 token。
       - 对含 `_` 或 `-` 的标识符拆分子词（length >= 2），并递归对各段执行 camelCase 拆分，同时保留去符号整词（如 `dedupbatchsize`）。
       - 对含大写字母的单词执行 `splitCamelCase`，提取所有小写子词（length >= 2）。
       - 规则与 `semantic_dedup.js` 的 `termsOf` 严格对齐：
         - `memoryAuditUndo` -> `memory`, `audit`, `undo` + `memoryauditundo`
         - `dedup_batch_size` -> `dedup`, `batch`, `size` + `dedup_batch_size`（及 `dedupbatchsize`）
         - 普通词 `redis` 保持单一 token，绝不拆坏。
  2. **RRF 复发加权**:
     - 升级 `_heat` 计算逻辑：
       `var rc = parseInt(cq.retrieval_count, 10); if (!rc || rc !== rc || rc < 0) rc = 0;`
       `var rec = parseInt(cq.recurrence, 10); if (!rec || rec !== rec || rec < 1) rec = 1;`
       `cq._heat = rc + (rec - 1) * 2;`
     - 严格防御 `recurrence` 为 `null`、`undefined`、字符串、NaN 或非正数，缺失时 `(rec - 1) * 2 === 0`，精准等价于原 `retrieval_count`。

---

## 3. 双向反证测试矩阵 (tests/test_v637_c_harvest.mjs)

| 验证项 | 正向断言 | 反向/边界反证断言 |
| :--- | :--- | :--- |
| **BUG-5: principle 提炼** | 模型提炼返回 category="principle" 时，成功识别并作为记忆入库，分类保持 principle | 非法类别自动回退为 "fact"，不发生异常崩溃 |
| **BUG-5: related_entities** | 模型返回 related_entities="Redis, Cluster" 时，payload 与落库数据均完整保留实体字符串 | 模型未返回实体时，缺省为空串 `""`，不包含 undefined 或 null |
| **BUG-5: root_cause 解耦** | 模型分别返回 root_cause 与 solution 时，两者独立保存，绝不相等 | 模型未给 root_cause 时，保持为 `""`（留待后续自演进），**严禁用 solution 或固定文案顶替** |
| **BUG-5: drain 增量与升维** | 队列消费遇同标题更详尽内容触发 `ENRICHED`，遇高频 preference 触发升维为 `principle`；返回统计与 actions 不被吞掉 | 无增益重复内容严格返回 `NOOP`，不被误判为 `ENRICHED` |
| **EVO-8: camelCase 裂变** | `memoryAuditUndo` 经 tokenize 切出 memory, audit, undo 以及全名 | 普通单词 `redis` 保持原样切出单一 `redis`，绝不拆碎 |
| **EVO-8: snake_case 裂变** | `dedup_batch_size` 经 tokenize 切出 dedup, batch, size 以及全名 | 单字母片段安全过滤，无空 token 产生 |
| **EVO-8: _heat 复发加权** | 高 recurrence（如 5）时 `_heat = rc + (5-1)*2 = rc + 8`，显著高于低 recurrence 项 | recurrence 为 null、undefined、非数字字符串时，`_heat` 严格等于 `retrieval_count` |
| **test_meta 元检查合规** | 测试套件自身通过 `scanTestFile` 扫描，0 违规，强隔离、强制 cleanup 且 `residue.total === 0` | 绝不污染全局，绝不向 `project: "global"` 写入 |

---

## 4. 验证与回归结果
（实现后更新）
## 主控补记（Agent C 因 model_error 中断，由主控接管收尾）

1. 复核确认 C 的两处改动均已真实落地：
   - gateway_harvest.hooks.js：HARVEST_SYSTEM_PROMPT 已支持 principle / related_entities / root_cause 与 solution 分离；
     硬编码的 related_entities 空串已移除；drain 已接入结晶与演进分支。
   - memory.middleware.js：tokenize 已接入 camelCase/snake_case 裂变（ES5 风格，var + 普通函数），
     _heat = retrieval_count + (recurrence-1)*2。

2. 补写缺失的 tests/test_v637_c_harvest.mjs（C 未产出测试），
   覆盖 BUG-5 提示词契约与 EVO-8 裂变/加权共 3 组反证门。

3. 修复一处真实实现缺陷：词法同分时 RRF 无法让高复发记录胜出
   （词法权重 1.0 远高于热度 0.4，且 _heat 的赋值发生在排序之后，比较时两侧均为 undefined）。
   已改为「词法同分时就地计算热度并降序打破平局」，
   既保留 RRF 既有票权设计，又实现 EVO-8 的意图。
