# magpie-memory-hub

Magpie 的**透明记忆网关**。把流经 Magpie 的对话沉淀为长期记忆，在后续提问时自动注入相关经验，并通过 MCP 向所有智能体提供结构化记忆工具。

[![Version](https://img.shields.io/badge/version-v6.40.1-blue.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-78%20passed-brightgreen.svg)](tests/)
[![Adversarial Gate](https://img.shields.io/badge/adversarial--gate-6%2F6%20green-success.svg)](tests/adversarial_v629_gate.mjs)

---

## 一、记忆工作模式与运行架构 (v6.40.1)

| 环节 | 运行时机制 | 协作方式与说明 |
|---|---|---|
| **意图感知引导** | **动态嗅探 + 意图分流** | 中间件动态嗅探客户端工具名前缀（适配 `mcp__magpie__...`），根据对话特征按需注入：排障意图（强制先查已知避坑、修完必存踩坑）、规范意图（立即沉淀 `principle` 铁律）、首轮引导（检索+沉淀指南） |
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
| **`memory_save`** | **【持久化沉淀】**<br>沉淀长期有效的事实、架构决策或工程规范。确立铁律时必须设 `category="principle"`。 | `title`, `content`, `category`, `tags`, `project` | • 入库自动脱敏密钥<br>• 同名新内容自动 supersede<br>• 规范准则优先置顶 |
| **`pitfall_search`** | **【已知故障与避坑检索】**<br>遇到报错、排查故障或准备执行关键操作前调用：先查已知症状与已验证解法。 | `query`, `project`, `component`, `limit` | • 检索已知错误与解法<br>• 在线模型重排相关度<br>• 跨项目全局避坑穿透 |
| **`pitfall_save`** | **【避坑排障沉淀】**<br>定位并解决报错后必须调用：沉淀故障现象与验证过的解法，杜绝重复踩坑。 | `symptom`, `solution`, `component` (可选，默认 general), `root_cause` (可选) | • 参数放宽（仅需现象与解法）<br>• 自动脱敏密钥与连接串<br>• 语义归一复发计数 (+1) |
| **`memory_get`** | **【记忆全文查看】**<br>根据记忆 ID 精确取出一条记录的完整原文。上下文卡片显示不全时展开详情。 | `id` (记忆ID) | • 异步更新访问热度与时间戳<br>• 零时间戳篡改（不改 updated_at） |
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
# 输出: "version": "6.37.0"
```

---

## 五、测试与质量保证

全套 **78 个自动化测试套件** 与 **红队反证靶场** 均在独立 Linux 容器中通过验证：

```bash
node tests/test_meta.mjs             # 78 个测试文件元检查（100% 隔离合规）
node tests/adversarial_v629_gate.mjs # 红队 6 大核心缺陷反证靶场（6/6 GREEN）
node tests/test_proactive_memory_ux.mjs # 主动记忆、一站式召回与脱敏专项测试
node tests/settings_page_test.mjs    # 设置页表单与 DOM 交互测试
node tests/check_schema_sync.mjs     # 表结构与版本号严格对齐检查
```
