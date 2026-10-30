# magpie-memory-hub

Magpie 的**透明记忆网关**。把流经 Magpie 的对话沉淀为长期记忆，在后续提问时自动注入相关经验，并通过 MCP 向所有智能体提供结构化记忆工具。

[![Version](https://img.shields.io/badge/version-v7.0.1-blue.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-100%20passed-brightgreen.svg)](tests/)
[![Adversarial Gate](https://img.shields.io/badge/adversarial--gate-6%2F6%20green-success.svg)](tests/adversarial_v629_gate.mjs)

---

## 一、记忆工作模式与运行架构 (v7.0.1)

| 环节 | 运行时机制 | 协作方式与说明 |
|---|---|---|
| **意图感知引导** | **动态嗅探 + 意图分流** | 中间件动态嗅探客户端工具名前缀（适配 `mcp__magpie__...`），根据对话特征按需注入：排障意图（强制先查已知避坑、修完必存踩坑）、规范意图（立即沉淀 `principle` 铁律）、首轮引导（检索+沉淀指南） |
| **能力门控** | **按通告工具分档注入** | 从本次请求的 `body.tools` / `functions` / Gemini `functionDeclarations` 提取**真实通告的工具名**，分四档：无工具→整块不注入；有工具但非本插件且无分发器→只给「能力未确认」；**有元工具分发器（Cindy/pi 的 `cindy_mcp_call_tool`、Code Mode 的 `run_code`）→「经分发器可用」，给查找键 + 唯一入口**；工具就绪→用真实名并附「禁止换名重试」 |
| **环境作用域** | **`env_scope` 硬过滤** | 记忆带 `env_scope`（如 `os=windows,arch=amd64`）；召回与准则置顶都先过环境硬门，**带作用域必须正向确认才召回**（`env_scope_strict` 默认开）。客户端身份取自 `x-magpie-agent` 头或宿主 `ctx.agent`，由 `client_profiles` 映射到画像 |
| **零工具通道** | **`memory-cli.js`** | 配置 `cli_channel` 后，没有 MCP 的客户端会用 CLI 读写记忆——可用性不再绑在「工具一定存在」这个前提上（mem0 同款思路） |
| **幻觉遥测** | **确定性检测 + 降档建议** | 响应层直接核对模型发出的 tool_call 名是否在本次通告清单里；不是「率估算」。累计到阈值后给出 `client_profiles` 降档建议，落盘 `~/.magpie-memory-hub/caps-stats.json` |
| **一站式召回** | **MCP `memory_context` 直连** | 一次调用同时召回当前项目的核心行为准则 (`principle`)、相关历史记忆 (`memories`) 以及 Top 3 避坑排障经验 (`pitfalls`)，支持跨项目全局穿透兜底 |
| **深度检索与重排** | **双路改写 + 在线模型重排** | `memory_search` 与 `pitfall_search` 支持原始词 + 在线模型改写词双路分词召回，并调用在线大模型进行高精度语义相关度重排 (rerank) |
| **安全写入与脱敏** | **自动正则脱敏 (`scrubSecrets`)** | 写入记忆或踩坑时，入库前自动将明文 API Key (`sk-...`, `ghp_...`, `Bearer ...`, 数据库密码) 脱敏为 `***REDACTED***`，杜绝密钥上云 |
| **全自动去重巡检** | **语义查重与回滚 (`memory_audit`)** | 支持单次模型判定合并、定时调度（每天/每周/每月）、双表独立增量游标 (`last_memory_id`, `last_pitfall_id`) 与指定时间点一键撤销回滚 |
| **离线快照兜底** | **快照缓存 (`options.memories`)** | 设置页点击「刷新记忆快照」，前端安全合并后将最新活跃记忆快照写入中间件，供断网或离线时兜底准则注入 |

```
                    ┌──────────────── Magpie 网关（Go 进程）────────────────┐
   Agent ──请求──▶  │ moejs 中间件（memory.middleware.js）                │
                    │   ① 静态准则置顶与快照检索（零 I/O 兜底）           │
                    │   ② 动态嗅探客户端工具名（适配包装前缀）             │
                    │   ③ 意图感知动态注入 [Memory Agent Guide] 引导      │
                    │   ④ 严格保 KV-Cache：逐字节保留历史前缀与 Prompt     │
                    └───────────────────────┬───────────────────────────┘
                                            │ 本地录制 / 异步网关钩子
                                            ▼
                    ┌────────── 宿主提炼层（Bun 宿主 / MCP）───────────────┐
                    │ ① 网关录制增量提炼（harvest_gateway）               │
                    │ ② 异步请求钩子（gateway_harvest.hooks.js，非阻塞）   │
                    │ ③ 写入 NoCodeBackend（memories / pitfalls）         │
                    │ ④ 入库前敏感凭据自动脱敏（scrubSecrets）             │
                    └───────────────────────────────────────────────────┘

   Agent ◄──MCP── /mcp/magpie/tools （Magpie 内置，聚合本插件 21 个工具，实现全量实时检索）
```

---

## 二、MCP 工具全集（21 个，语义明确化定义）

所有工具均具备工业级严谨的参数校验、异常捕获与友好人话返回，检索类工具统一植入 `_agent_hint` 注意力闭环提示：

### 1. 核心读写与排障沉淀工具（日常高频）

| 工具名称 | 语义定位与最佳调用时机 | 核心入参说明 | 关键特性 |
|---|---|---|---|
| **`memory_context`** | **【首选一站式上下文召回】**<br>开始新任务、排查问题或编写代码前必调：一次调用全景召回当前项目准则、历史记忆与 Top 3 踩坑排障解法。 | `query` (当前任务词), `project` (项目名), `max_items`, `max_chars` | • 准则无条件置顶<br>• 融入 Top 3 避坑解法<br>• 跨项目全局穿透兜底<br>• 双路查询改写扩展 |
| **`memory_search`** | **【深度记忆检索】**<br>针对特定主题、实体或技术背景的高精度深搜。回答历史相关提问前调用。 | `query`, `project`, `category`, `limit`, `search_rerank` | • 原始+改写词双路融合<br>• 在线大模型智能重排<br>• 项目专属优先 + 全局兜底 |
| **`memory_save`** | **【持久化沉淀】**<br>沉淀长期有效的事实、架构决策或工程规范。确立铁律时必须设 `category="principle"`。 | `title`, `content`, `category`, `tags`, `project`, `feedback` (可选 `"helpful"`) | • 入库自动脱敏密钥<br>• 同名新内容自动 supersede<br>• 规范准则优先置顶<br>• `feedback="helpful"` 命中重复/演进时 confidence +10（封顶 100）并累加 recurrence |
| **`pitfall_search`** | **【已知故障与避坑检索】**<br>遇到报错、排查故障或准备执行关键操作前调用：先查已知症状与已验证解法。 | `query`, `project`, `component`, `limit` | • 检索已知错误与解法<br>• 在线模型重排相关度<br>• 跨项目全局避坑穿透 |
| **`pitfall_save`** | **【避坑排障沉淀】**<br>定位并解决报错后必须调用：沉淀故障现象与验证过的解法，杜绝重复踩坑。 | `symptom`, `solution`, `component` (可选，默认 general), `root_cause` (可选) | • 参数放宽（仅需现象与解法）<br>• 自动脱敏密钥与连接串<br>• 语义归一复发计数 (+1) |
| **`memory_get`** | **【记忆全文查看】**<br>根据记忆 ID 精确取出一条记录的完整原文。上下文卡片显示不全时展开详情。 | `id` (记忆ID), `ids` (批量), `feedback` (可选 `"helpful"`) | • 异步更新访问热度与时间戳<br>• 零时间戳篡改（不改 updated_at）<br>• `feedback="helpful"` confidence +10、recurrence +1 |
| **`memory_list`** | **【知识总览】**<br>分页列出当前项目或全局的活跃记忆列表，快速了解项目知识全貌。 | `project`, `limit` | • 按访问热度与新鲜度排序<br>• 过滤已软失效的脏数据 |
| **`memory_forget`** | **【记忆软失效】**<br>标记过时、失效或已被废弃的记忆。支持 ID 精确失效或关键词匹配。 | `id`, `query`, `limit` | • 软失效（写 invalid_at）<br>• 绝不物理删除，留存审计痕迹 |
| **`memory_audit`** | **【全自动去重巡检与撤销】**<br>分批语义查重合并记忆与踩坑，支持定时去重与指定时间点一键还原。 | `project`, `full`, `schedule`, `undo_before`, `since_days` | • 双表独立增量游标<br>• 并发互斥锁 (`_isAuditing`)<br>• 精确累加 recurrence<br>• 支持撤销至指定时间戳 |

### 2. 数据库与存储管理工具（设置页与系统运维）

| 工具名称 | 功能描述 |
|---|---|
| **`ncb_check`** | 检测 NoCodeBackend MCP Key 连通性，自动识别账号前缀并缓存真实物理库名。 |
| **`db_status`** | 只读检测当前表结构 vs 期望 Schema 差集，汇报缺失表、列、索引及版本号。 |
| **`db_init`** | 幂等初始化表结构（`memories`、`pitfalls`、`schema_meta`），只增不删不影响已有数据。 |
| **`db_provision`** | 一键全自动建库与初始化表结构，默认 `reuse` 策略防止重名库分裂。 |
| **`db_reset`** | 【破坏性】清空插件自身三张表结构与数据（需显式传 `confirm="RESET"` 二次确认）。 |
| **`r2_check`** | 仅通过上传并立即清理一个临时极小探针文件，只读检测 Cloudflare R2 凭据有效性。 |
| **`storage_setup`** | 挂载 R2 存储桶，配置 CORS 并执行真实端到端上传探测验证。 |
| **`storage_upload`** | 上传文本或二进制文件到 R2 存储桶，获取公开访问 URL。 |
| **`storage_list`** | 列出 R2 存储桶内的文件对象列表（key、大小、修改时间、公开链接）。 |
| **`storage_delete`** | 【破坏性】从 R2 存储桶中删除指定 key 的文件（需传 `confirm="DELETE"` 确认）。 |
| **`storage_guide`** | 查询 R2 存储能力边界、凭据分离机制（MCP 建桶 vs Secret Key 操作）与排错指南。 |
| **`harvest_gateway`** | 增量扫描 Magpie 网关录制的历史对话落盘文件，调用在线大模型提炼知识入库。 |

---

## 三、四大核心设计原则（不可违背的铁律）

1. **誓死保全推理大模型 KV-Cache（零前缀变动）**：
   - 彻底下线并删除了改写历史消息前缀的旧代码（`compress.js`），中间件注入一律且仅落在**最后一条用户消息末尾**，system prompt 与历史消息逐字节未动，杜绝 Token 成本与延迟成倍放大。
2. **记忆单通道与真实数据库真相源**：
   - 严禁在本地写杂乱零散的文本记忆，持久记忆统一存储在 NoCodeBackend 数据库中；
   - 智能体通过标准 MCP 协议直接与数据库读写，中间件仅负责轻量意图引导。
3. **软失效与无损去重**：
   - 无论是 `memory_forget` 还是 `memory_audit` 自动合并，系统**绝不物理删除**任何用户记忆，一律通过 `invalid_at` 和 `invalid_reason`（如 `dedup:<batch>:into:<id>`）进行软失效，随时可通过时间点回滚还原。
4. **零凭据泄漏（开源安全标准）**：
   - 入库前置执行 `scrubSecrets` 正则脱敏，过滤各类 API Key 与密码；
   - 报错诊断人话化，严禁向前端或日志吐出裸错误或原始密钥。

---

## 四、生产环境更新指引（Docker / VPS）

在部署 Magpie 的 VPS 容器内执行三步命令即可升级至最新版：

```bash
# 1. 移除旧插件并清理 lockfile 与 bun 缓存
/usr/local/bin/magpie plugin rm magpie-memory-hub
rm -f /config/magpie/plugins/bun.lock /config/magpie/plugins/bun.lockb
rm -rf /config/home/.cache/magpie/bun/install-cache/*

# 2. 拉取最新 release
/usr/local/bin/magpie plugin add github:otaku-say/magpie-memory-hub

# 3. 校验版本
grep '"version"' /config/magpie/plugins/node_modules/magpie-memory-hub/package.json
# 输出: "version": "6.49.0"
```

---

## 五、测试与质量保证

全套 **100 个自动化测试套件** 与 **红队反证靶场** 均在独立 Linux 容器中通过验证：

```bash
node tests/test_meta.mjs             # 100 个测试文件元检查（100% 隔离合规）
node tests/adversarial_v629_gate.mjs # 红队 6 大核心缺陷反证靶场（6/6 GREEN）
node tests/test_proactive_memory_ux.mjs # 主动记忆、一站式召回与脱敏专项测试
node tests/settings_page_test.mjs    # 设置页表单与 DOM 交互测试
node tests/check_schema_sync.mjs     # 表结构与版本号严格对齐检查
node tests/test_v700_capability_gate.mjs # 能力门控 / 环境作用域 / 幻觉检测 35 项
node tests/test_v700_env_scope.mjs      # env_scope / applies_to / 负反馈 / 遥测 12 项
node tests/e2e/gateway-real.mjs         # 真机网关集成（真 HTTP + 真中间件 + 真子进程）
```

**计数口径（三处数字同源，均取 `tests/` 活跃套件总数 100）**：徽章、本节正文与项目结构树声明的是同一批套件；
`tests/test_meta.mjs` 的锁定断言 `testFiles.length === 100` 是唯一权威值，`tests/test_helpers.mjs` 是共享桩库、
`tests/test_meta.mjs` 自身是元检查器，二者不计入套件数。

全量逐套执行入口（跳过 `test_meta.mjs` 元检查器与 `test_helpers.mjs` 共享桩库，其余 100 个套件串行全跑）实测：
**通过 96 / 跳过 4 / 失败 0**；4 套跳过
（`test_all_20_tools_e2e`、`test_backend_acceptance`、`test_mcp_only`、`test_pollution_guard`）均因容器内缺少
真实 NoCodeBackend 凭证或宿主环境而显式 `exit 77`，属于可解释跳过而非失败。

---

## 日志与诊断 (v7.0.0)

`log_level` 配置项（package.json options / 设置页「日志与诊断」卡片）控制插件日志：

| 等级 | 行为 |
|:--|:--|
| `off`（默认） | 零日志：不产生任何日志文件，插件下次加载时自动清理历史日志（`~/.magpie-memory-hub/logs/`、`_logs.json`、`_logs.js`） |
| `error` | 仅错误与降级（中间件 fail-open、模型调用失败、auto_init / auto_harvest 失败等） |
| `info` | 常规运行事件（onRequest 慢路径采样 >50ms、调用预算熔断提示、页面任务执行结果） |
| `debug` | 全量日志：在 info 之上追加每次请求耗时（proto / turn / prompt 长度）与每次在线模型调用耗时（diagnose / rewrite / audit / rerank） |

日志落盘到 `~/.magpie-memory-hub/logs/memhub.log`（2MB 上限，超限自动保留尾部 1MB），
同时维护最近 800 条环形缓冲；设置页「导出日志」按钮将其落成 `_logs.js` 快照并导出为
`memhub-logs-<时间戳>.log`（若下载被沙箱拦截，自动改为弹窗展示并支持全选复制）。

边界说明：网关请求链路（中间件 onRequest / onEvent / onResponse）运行在无文件系统的受限运行时，
其日志按同一 `log_level` 过滤后输出到网关控制台（Magpie 中间件统计面板可见），不进入导出文件；
工具与服务侧（Node 运行时）的日志才会落盘并支持导出。

## 项目结构

```
├── src/
│   ├── core/           基础设施（配置、状态、时间）
│   ├── domain/         领域逻辑（指纹、评分、去重）
│   ├── integration/    外部集成（NCB、R2、MCP、模型）
│   ├── middleware/     中间件（注入、流处理）
│   ├── services/       业务服务
│   │   ├── save/       记忆存储
│   │   ├── audit/      审计调度
│   │   └── harvest/    对话采集
│   ├── tools/          MCP 工具入口
│   └── page/           设置页面
├── tests/              测试套件（100 套）
├── docs/               架构文档与决策记录
└── tools.js 等         仅保留宿主契约入口（tools / middleware / hooks）与运行时状态
```

详见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## v7.0.1 变更清单

修复 v7.0.0 的一个真实回归：**Cindy 自己收到了「能力未确认」**。

- 根因：Cindy / pi 不把 MCP 工具直标在 `body.tools`，而是包在 `cindy_mcp_call_tool` 这类元工具后面，
  于是 `detectCapabilities()` 看不到工具名，整片客户端被降到档 1。
- 新增 **档 1.5「经分发器可用」**：给【查找键】（memory_context / memory_save 这类名字）+【唯一入口】
  （必须经分发器调，不得直接把查找键当工具名）。两个约束缺一不可：少前者等于什么都不做，少后者就是在复现幻觉。
- 分发器识别：`call_tool` / `invoke_tool` / `execute_tool` / `run_code` / `code_run` / `mcp_call` / `tool_call`
  （带 `_ - .` 边界），`cindy_mcp_list_tools`、`read_file` 不会误命中。
- `client_profiles` 支持 `tools_via`，把档 1.5 从「猜」变成「已知」。
- 连带发现：`run_code` 属于 Code Mode 分发器，原有两个「档 1」用例的工具集其实应当走 1.5，已改成真正的无分发器工具集。

---

## v7.0.0 变更清单

本轮完成 v6.50 遗留的五项改造，并用真机测试挖出并修正了一个设计错误。
调研依据见 [docs/RESEARCH-capability-gating.md](docs/RESEARCH-capability-gating.md)。

**schema v7：`env_scope` 升为真列**

- `memories` 与 `pitfalls` 增加 `env_scope VARCHAR(256)`，空值 = 通用（存量数据零迁移）。
- `db_init` 幂等迁移自动补列；`related_entities` 里的 `env:os=windows` 保留标签仍然兼容。
- 保存侧两条路径（显式参数 / 保留标签）走同一个 `normalizeEnvScope`；二次写入去重时作用域**取并集**而不是覆盖。

**提炼侧治本：`applies_to`**

- 提炼提示新增「环境限定守则」：平台限定事实必须写 `applies_to`，严禁写成无修饰的普遍事实。
- `appliesToToScope()` 把「仅限 Windows」「arm64 / alpine」这类人话归一成 `os=windows` / `arch=arm64,agent=alpine`。

**真机测试挖出的设计错误：fail-open → fail-closed**

- 首版对「未知维度」fail-open，导致没有 os 画像的 ishellpro 依然收到 Windows 准则。
- 现改为：**带作用域的记忆必须正向确认环境才召回**；无作用域记忆不受影响。开关 `env_scope_strict`。

**能力遥测与自愈**

- `response-hook.js` 对四种协议的 tool_call 做确定性核对：`unadvertised`（通告了但名字不在清单）/ `unavailable`（根本没通告工具却调）。
- 中间件无 fs，检测结果经 `ctx.state.capsTelemetry` 交给宿主钩子落盘（`src/services/caps-stats.js`，60s 节流）。
- 幻觉累计 ≥ 3 且几乎没用上工具时，输出 `client_profiles` 降档建议。

**零工具写入通道**

- 新增根目录 `memory-cli.js`：`save / pitfall / search / context / doctor`，走同一套工具实现。
- `cli_channel` 配置后，无工具环境的提示会给出 CLI 命令（仍不给任何 MCP 工具名）。
- 这意味着 ishellpro 从「不幻觉」升级到「真能读写」。

**设置页**

- 新卡片「能力门控与环境作用域」：`capability_gate` / `guide_on_no_tools` / `env_scope_strict` / `caps_telemetry` / `cli_channel` / `client_profiles`。
- `client_profiles` 是自由编辑 JSON，**非法 JSON 拒绝保存**（静默容错会让用户误以为画像生效）。
- 「一键补齐 client_profiles」：宿主加载时把 `caps-stats.json` 的降档建议写进 `_status.js`，
  页面读 `caps_action_status` 后一键写入文本域（仍需手动保存，不静默改配置）。

**测试**

- 新增 `tests/test_v700_capability_gate.mjs`（35 项）与 `tests/test_v700_env_scope.mjs`（12 项）。
- 新增 `tests/e2e/gateway-real.mjs`：真 HTTP 网关 + 真中间件 + 真宿主钩子 + 真子进程 CLI，四个客户端画像（ishellpro / openminis / cindy-win11 / codex）13 项断言。
- 修了两颗原有的测试定时炸弹：`test_proactive_memory_ux` 1.3 无工具却断言注入了工具指引；`test_v634_c_docs` 把 `99` 写死当错误值。
- 修了一处**假绿**：环境作用域的负向断言原本拿 `title` 判，而 principle 块只渲染 `content`，漏注入也照样绿；已改为 content 特征串 + 正向对照。

**回滚的一个决定**

- 曾给 `memory_get` 加 `feedback="unhelpful"`，与仓库已确立的「降权属于 `memory_forget`」契约冲突且功能重复（`memory_forget` 已有 `not_helpful` 降 25）。已完整回滚。

---

## v6.48.0 修复清单

本轮为全量代码审计后的回归修复，共 17 项，全部配反证门测试（`tests/test_v648_adversarial.mjs`，33 项断言）。

**数据正确性**

- 去重候选集改为分页拉全量：原先只取最近 200 条，活跃记忆超限后指纹查重、语义查重、版本链与 supersede 全部静默失效。
- 唯一索引兜底查询补 `lifecycle_status='active'` 与排序：原先可能把复发计数累加到已失效记录上。
- `tags` / `related_entities` 并集统一裁剪到 512 字符：原先多轮演进后撞列宽，MySQL strict 模式下整次保存抛错。
- 过期时间解析支持带时区偏移与纯日期：原先一律 `NaN`，导致过期记忆永不过期。

**安全**

- 模型诊断请求的原始报错先经 `scrubSecrets`：原先可能把自动生成的 Secret Key 发给在线模型。
- 路径守卫补齐原始 POSIX 形态与 win32 系统目录判定：原先在 Windows 宿主上整套 `/var` `/home` `/root` 域限制静默失效。
- `forgetSecret` 的唯一记录兜底仅在未指定目标时生效：原先一条无关的 403 会删除本地唯一有效凭据。
- 注入到 prompt 的记忆正文折叠换行并剔除保留标识符：阻断借换行伪造 `[Memory Agent Guide]` 引导块的结构注入。

**契约与假绿**

- `memory_save` 的 schema 补齐 `source_session` / `source_turn` 声明，与 handler 实际读取字段对齐。
- rerank 校验返回的 id 必须属于候选集，原先只校验正整数，幻觉 ID 会造成「重排成功但结果未变」的假绿。
- 模型输出解析失败不再标记 `anySucceeded=true`，并留 `[memory-hub][model] parse-failed` 日志。
- `rerank_timeout_sec` 未显式配置时回落到声明的 15s，原先继承 `model_timeout_sec` 的 30s 默认值。

**中间件与客户端**

- `<memory>` 标签剥离支持属性变体（`<memory type="json">`）与代码围栏包裹，流式与非流式行为对齐。
- NCB public schema 请求的超时清理移到 `finally`，原先在读取响应体之前就清掉，body 卡住时无兜底超时。

**测试可移植性**

- 移除 `tests/test_adversarial_timeout_and_rerank.mjs` 中的 `/workspace` 硬编码绝对路径。
- 动态 `import()` 绝对路径改用 `pathToFileURL`，Windows 下不再抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
