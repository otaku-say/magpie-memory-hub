# v6.38-c 修复记录：后台副作用清理与离线扫描占位消除

## 1. 任务背景与文件所有权原则
- **BUG-37-2（高危）**：后台异步队列消费器（triggerBackgroundDrain）在消费时，通过调用 MagpieMemoryHub 误杀宿主生产定时去重调度器，且入队/落库置信度字段量纲错配，导致置信度被重置为默认 100。
- **BUG-37-4a（中危）**：离线扫描对话落盘（harvestGateway）在落库 saveMemory 时漏传 related_entities；在调用 pitfallSave 时对缺失根因的踩坑硬编码拼接占位文案 “执行过程中出现 <title>，已处置解决”。
- **文件所有权遵守**：
  - 修改文件：gateway_harvest.hooks.js、gateway_harvest.js
  - 新增文件：NOTES_v638_c.md、tests/test_v638_c_harvest.mjs
  - **严禁改动 tools.js**：所有修复均在 hook 与 gateway 层闭环处理，不触碰正在被其他 Agent 修改的 tools.js。

---

## 2. 根因剖析

### BUG-37-2a：后台消费误杀生产调度器
- **位置**：gateway_harvest.hooks.js:1225
- **成因**：triggerBackgroundDrain 在消费队列需要调用工具时，执行：
  hubInstance = (options && options.hub) || await MagpieMemoryHub({}, { _client: safeClient, _cfg: (options && options.cfg) || {} });
  在 options.hub 为空且 caller 传入空 options 或 cfg 嵌套在 _cfg 下时，MagpieMemoryHub 内部的 readOptions 无法在顶级选项读取到 dedup_schedule，因而解析为 "off"。
  tools.js 内部逻辑判定 if (dedupSched === "off" || dedupSched === "none") { stopAuditScheduler(); }，无条件调用了模块单例的 stopAuditScheduler()，直接掐断生产定时去重计时器并置空 _auditOptionsGetter。

### BUG-37-2b：置信度量纲与字段错配
- **位置**：gateway_harvest.hooks.js:960 与 gateway_harvest.hooks.js:1266
- **成因**：在入队构建 memoryPayload 时仅写入了 confidence_score: 82（整数量纲 0~100）。
  而在 tools.js 中 saveMemory 真正读取的字段是 m.confidence（期望 0~1 小数量纲或 0~100 整数）。
  因为 payload 仅有 confidence_score，m.confidence 为 undefined，rawConf 被回退至默认值 1，进而 confidence_score 被放大存为 100。

### BUG-37-4a：离线扫描漏传实体与硬编码占位根因
- **位置**：gateway_harvest.js:1017-1029 及 gateway_harvest.js:1070
- **成因**：
  1. 离线提炼入库 saveMemory 载荷中遗漏了 related_entities 属性，导致模型提炼的关联实体无法落盘。
  2. 离线提炼入库 pitfallSave 载荷中写有：
     root_cause: p.root_cause || `执行过程中出现 ${p.symptom}，已处置解决`,
     当未提炼出明确根因时，强行拼接无信息量的套话，造成知识库污染。

---

## 3. 修复方案

### 修复 1：调度器防护与真实配置透传
1. 优先复用 options.hub。
2. 若 options.hub 不存在，在调用 MagpieMemoryHub 时：
   - 提取真实排期：从 options.dedup_schedule、options.cfg.dedup_schedule 中读取。
   - 若 options 中未指定，但当前进程单例已处于启动状态（通过 MagpieMemoryHub.ensureAuditScheduler().started === true 探知），则从当前的活跃配置中继承 dedup_schedule 并显式透传给 MagpieMemoryHub 的 input 与 options。
   - 这样保证传入的 dedupSched 与生产运行状态一致（如 "daily"），绝不触发 stopAuditScheduler()。
3. 在 processDialogueAndHarvest 中调用 triggerBackgroundDrain(client, options) 时完整透传 options。
4. **集成建议**：未来集成阶段建议在 tools.js 的 MagpieMemoryHub 增加 _no_scheduler: true 标记，专供纯工具消费类实例使用。

### 修复 2：置信度字段与量纲标准化
1. 在 gateway_harvest.hooks.js 的 memoryPayload 构造处，显式写入 confidence: 0~1 浮点数，并保留 confidence_score: 0~100。
2. 在 triggerBackgroundDrain 消费队列时，对 memPayload.confidence 进行兼容标准化：
   - 若包含 confidence 则规范为 <= 1 的浮点数。
   - 若仅包含 confidence_score（如历史遗留队列数据），自动换算为 / 100 赋给 memPayload.confidence。
   - 确保 saveMemory 能正确读到 m.confidence，落库保存为真实值（如 82）而非 100。

### 修复 3：离线扫描实体透传与占位根因清除
1. gateway_harvest.js 在 saveMemory 时补齐 related_entities: item.related_entities ? String(item.related_entities).trim() : ""。
2. gateway_harvest.js 在 pitfallSave 时补齐 related_entities，并将 root_cause 修正为 p.root_cause ? String(p.root_cause).trim() : ""。无根因时传空字符串，绝不产生「已处置解决」占位文案。

---

## 4. 双向反证验收设计
在 tests/test_v638_c_harvest.mjs 中构建双向反证：
1. **调度器反证**：
   - 在已启动调度器前提下触发 triggerBackgroundDrain，打桩监控 stopAuditScheduler，断言调用次数恒为 0，且 ensureAuditScheduler().started 仍为 true。
   - 对照反证：若故意传入 dedup_schedule: "off" 且无防护，调度器会被关闭；而受保护链路绝不被关闭。
2. **置信度反证**：
   - 写入包含 confidence: 0.82 及仅包含 confidence_score: 82 的队列项，经过 drain 后从数据库查询，断言 confidence_score 为 82，反证绝不是 100。
3. **离线扫描占位根因与实体反证**：
   - 离线提炼无根因的对话，落库的 root_cause 不得包含「已处置解决」，断言为空串。
   - 正常有根因和实体的对话，落库的 root_cause 与 related_entities 必须完整保留真实提炼值。
4. **测试元规范（test_meta）合规**：
   - 完整遵守命名空间隔离、cleanup、residue 断言、反证标记与非 0 退出。
