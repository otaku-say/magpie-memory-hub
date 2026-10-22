# Magpie Memory Hub × ai-memory 核心功能集成规格说明书 (Spec)

## 一、集成目标与架构原则

依据用户指示与架构对标文档，将 akitaonrails/ai-memory 的 6 大高价值协议与核心算法，以纯 JavaScript 原生集成进 magpie-memory-hub：
1. **零新增 DDL 表（Zero-DDL Change）**：100% 复用 NoCodeBackend memories 表的已有列，不增加新表，保证对现有 Schema 门禁完全兼容；
2. **端到端闭环**：不仅在后端及 MCP 工具层实现能力，必须在设置页（settings.html / settings.js / settings.css）落地可视化的交互卡片；
3. **严格 25 个中文技能**：遵循《规格驱动开发技能》、《接口与API设计技能》、《前端UI工程技能》、《测试驱动开发技能》、《代码审查技能》。

---

## 二、六大功能技术规格

### 1. 跨 Agent 任务交接棒协议 (Cross-Agent Claim-Once Handoff)
- **协议存储**：
  - `category`: "context", `scope_level`: "session"
  - `title`: "【任务交接】" + summaryTitle
  - `content`: 结构化交接三要素：【当前进展】、【已排除方案】、【未决问题与下一步】
  - `tags`: "handoff, handoff:open"
- **自动感知与认领**：
  - `memory_context` 自动检查当前项目是否有 `handoff:open` 记录；
  - 若有，在返回 context 顶部优先置顶输出 `[Pending Cross-Agent Handoff]`，新 Agent 零配置无缝接力；
  - 传入 `claim_handoff: true` 时单次核销（更新 tags 为 `handoff:claimed`，设置 `invalid_at`，防止重复消费）。

### 2. 记忆质量反馈与显著性打分 (Memory Feedback & M8 Decay)
- **协议**：
  - 扩展 `memory_forget` 支持 `feedback: "stale" | "wrong" | "not_helpful"`；
  - `not_helpful`: 下调 confidence_score 25 分而不直接软删除；
  - `stale` / `wrong`: 立即软失效并记录 `invalid_reason`；
  - `memory_get` / `memory_save` 支持 `feedback: "helpful"`: 提升 confidence_score 并累加 recurrence。
- **M8 时间衰减**：
  - 升级 `src/domain/scoring.js` 的 `rankMemory`：引入基于 `last_used_at` 的访问时间衰减，长期未命中的老记忆加成指数衰减，防止远古记忆霸榜。

### 3. 跨项目开发者个人画像收敛 (Cross-Project Developer Profile)
- 当某条 `preference` 或 `principle` 在 >= 2 个不同项目中出现时，自动在 `project: "global", scope_level: "user"` 下生成一条全局开发者习惯；
- 全新仓库冷启动时（当前项目记忆为 0），`memory_context` 自动放宽 global 画像注入条数，零配置生效个人习惯。

### 4. 检索可解释性追踪 (Recall Explain Trace: `explain: true`)
- `memory_search` 与 `pitfall_search` 增加可选参数 `explain: true`；
- 返回每条结果的 `score_details`（原始词面分、改写词面分、实体分、新鲜度因子、综合排序分、Rerank名次）与 `timings` 耗时诊断。

### 5. 零 LLM 冷记忆抽取式压缩 (Extractive Cold Compaction)
- 在 `memory_audit` 中针对 60 天未访问的长记忆（>240字），通过纯正则提取首句摘要与关键 Token（文件路径、代码、错误码、配置项），浓缩正文，原文无损留存 `full_text`，释放 60%+ 字符预算。

### 6. 跨项目 Agent 异步信箱 (Agent Messaging)
- 允许向其他项目投递变更通知，目标项目调用 `memory_context` 时提示未读邮件并单次消费。

---

## 三、设置页前端 UI 规格

在 `settings.html` 中新增 **【任务接力与记忆自洁】** 卡片：
1. 待接力任务状态（展示最新待认领交接单，支持手动核销）；
2. 开发者全局画像看板（展示已收敛的个人习惯）；
3. 记忆健康度指标与“一键冷记忆压缩”手动触发按钮；
4. 检索解释性追踪开关与未读信箱提醒。
