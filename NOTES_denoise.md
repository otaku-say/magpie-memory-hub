# Headroom TrafficLearner 去噪机制移植方案 (NOTES_denoise.md)

## 1. 目标与背景
解决 Magpie Memory Hub 中「自动采集噪音洪水」（20 分钟 288 条伪踩坑，累计 792 条，有效产出≈0）的问题。
移植 Headroom `TrafficLearner` 的纯规则、零 LLM、<1ms 高性能去噪机制。

## 2. 核心架构设计与优先级分解

### P0：证据累计门禁（min_evidence）
- 依据：Headroom `traffic_learner.py:511`，观察到的规则首次严禁直接落盘，必须在暂存队列累计达到门槛（默认 3 次，可配置）才正式入库。
- 存储权衡与选型：
  - 方案 A（DB 表 pending_patterns）：需要每次命中都发起 NCB MCP 请求，在噪音洪水场景（每 20 分钟近 300 条）下会带来严重的 HTTP/DB 开销与网络抖动风险。
  - 方案 B（本地状态 local_state.js 持久化 LRU 队列）：与 Headroom 源码实现（进程级/本地 LRU）完全对齐，提炼命中只更新本地状态，延迟 < 0.2ms，彻底阻断未达标噪音对远端 NCB 数据库的侵蚀。达到阈值时才发起 1 次正式写库，写库后从 pending 移除。
  - 选型结论：采用 `local_state.js` 维护 `pending_patterns` 暂存队列，支持容量上限（默认 1000 条 LRU 淘汰）与过期时间（默认 7 天 TTL 清理）。
- 双轨制（Bypass Channel）：
  - 显式用户意图（如以「记下来：」「避坑：」「注意：」开头，或由 `memory_save` / `pitfall_save` 工具显式触发）直接穿透门禁，不经过累计门禁，确保低频高价值知识即时落盘。

### P1：命令重试必须「同二进制 + 排除通用工具」
- 依据：Headroom `:382-421`。
- 提取命令首个可执行二进制（如 `npm run build` -> `npm`，`git checkout` -> `git`）。
- 若 `bin_a !== bin_b`，直接拒绝配对。
- 通用过滤工具黑名单：`cat`, `grep`, `rg`, `awk`, `sed`, `head`, `tail`, `sort`, `uniq`, `wc`, `xargs`, `find`，同名也不算实质配对。
- 编辑距离与参数校验：要求命令归一化编辑距离 ≤ 40% 或共享实质性参数（非单纯管道传递）。

### P1：路径编辑距离校验
- 依据：Headroom `:308-335`。
- 路径纠错中两个路径必须 `basename 相同` 或 `Levenshtein 编辑距离 <= max(2, Math.floor(len / 3))`，否则拒绝。
- 彻底根治类似 `Object.prototype.hasOwnProperty.call` 被误识别为路径纠错的问题。

### P1：脚手架注入前缀黑名单与系统消息剥离
- 依据：Headroom `:68-80` 及 mem0 `utils.py:65`。
- 过滤黑名单前缀：`<app-context>`, `<system-reminder>`, `<permissions instructions>`, `<skills_instructions>`, `# agents.md instructions for`, `another language model started to solve...`。
- 在构建对话文本时，严格丢弃 `role === "system"` 与 `role === "tool"`（工具原始回显常含大量 traceback/源码）。仅提取最终轮次中用户与助手的实质性交互。

### P2：存储字段与指纹字段分离
- 根因分析：原代码过早对 `symptom`/`solution` 执行 `sig()` 掩码替换，导致入库内容退化为 `npm run <str>` / `line <n>` 等无用占位符。
- 修复方案：
  - 入库字段 `symptom`, `solution`, `root_cause` 严格保留原始清洗文本。
  - 占位符掩码 `sig()` 仅用于生成 `content_fingerprint` 唯一去重指纹。

### P2：生命周期淘汰与衰减机制
- 依据：Headroom `:1946-2034`。
- 记录 `evidence_count` 与 `first_seen_at` / `last_seen_at`。
- 引入容量上限与过期机制，防止 pending 状态与无效记忆无限增长。

### P2：磁盘物理存在性校验
- 实测确认 Bun 宿主 `process.cwd()` 与文件系统路径的同源性。
- 若处于容器映射环境且无法可靠验证物理路径，将在报告中明确说明并在未确认同源前暂不启用硬拒绝。

## 3. 约束执行清单
- 仅修改指定文件：`gateway_harvest.js`, `gateway_harvest.hooks.js`, `harvest.py`, `local_state.js`, `tools.js` 及测试。
- 零 LLM 调用，纯规则引擎。
- 严禁测试污染生产数据库（使用隔离 `__test__` 项目并断言完全清理）。
- 绝不改动版本号，不执行 git commit/push。
