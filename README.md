# magpie-memory-hub

Magpie 的**透明记忆网关**。把流经 Magpie 的对话沉淀为长期记忆，在后续提问时自动注入相关经验，并通过 MCP 向所有 agent 提供记忆工具。

## 两种运行模式

| | 零外部模型（推荐） | 外部提炼模型 |
|---|---|---|
| 事实提炼 | **内联抽取**：让正在跑的那个模型自己在回复末尾产出 `<memory>` 块 | 额外调一次提炼模型 |
| 仲裁 | **规则**（置信度 + 信息量 + 相似度） | clef 模型 |
| 额外调用 | **0** | 每轮 1~2 次 |
| 额外成本 | **0** | 按模型计费 |
| 配置 | `inline_extract` 开 + `extractor_model` 留空 + `clef_mode=rule` | 填模型 ID |

零外部模型模式的机制来自 [Headroom](https://github.com/headroomlabs-ai/headroom)：**提炼不需要另起一个模型，让本来就要跑的那个顺势完成**。中间件在请求里注入一条提炼指令，回复末尾的 `<memory>` 块被解析入库、并从用户可见输出里剥掉。

## 架构

```
                    ┌──────────────── Magpie 网关（Go 进程）────────────────┐
   Agent ──请求──▶  │ moejs 中间件（memory.middleware.js）                │
                    │   ① 压缩历史工具输出（compress.js，纯 JS 规则）      │
                    │   ② 检索记忆，注入上下文（按关键词+热度+新鲜度）    │
                    │   ③ 剥离模型回复里的 <memory> 块（改善前端呈现）   │
                    └───────────────────────┬───────────────────────────┘
                                            │ 本地录制 / 异步网关钩子
                                            ▼
                    ┌────────── 宿主提炼层（Bun 宿主 / MCP）───────────────┐
                    │ ① 网关录制增量提炼（harvest_gateway，零模型规则）   │
                    │ ② 异步请求钩子（gateway_harvest.hooks.js，非阻塞）   │
                    │ ③ 写入 NoCodeBackend（memories / pitfalls）         │
                    └───────────────────────────────────────────────────┘

   Agent ◄──MCP── /mcp/magpie/tools （Magpie 内置，聚合本插件 22 个工具）
```

**自动记忆机制说明**：
- **用户体验保全**：中间件负责在流式 `onEvent` 与非流式 `onResponse` 中无损剥离 `<memory>` 标签，确保模型可能产出的提炼标记不泄露至终端呈现。
- **自动采集入库**：真实部署环境下，自动记忆通过 **网关对话录制增量扫描（`harvest_gateway`）** 与 **异步网关请求钩子（`gateway_harvest.hooks.js`）** 运行在具备完整网络与 I/O 能力的 Bun 宿主中，完全非阻塞，实现零外部模型开销的经验与踩坑提炼入库。

## 安装

```bash
magpie plugin add github:otaku-say/magpie-memory-hub
```

在 **设置 → 插件** 里开启内置的 **Plugin tools**，然后在 **插件页「记忆中枢」** 里填数据库信息。

**把 MCP 接给 agent**：在 **资源库 → MCP 服务器** 添加

```
https://<你的网关>/mcp/magpie/tools
```

Magpie 会自动写进各 agent 的配置，无需手工改文件。工具名形如 `magpie-memory-hub_memory_search`。

## 数据库

用 [NoCodeBackend](https://nocodebackend.com) 建一个库，三张表（或直接使用 `db_provision` 工具一键全自动建表建库）：

```sql
CREATE TABLE memories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project VARCHAR(128) DEFAULT 'global',
  category VARCHAR(64) DEFAULT 'fact',
  scope_level VARCHAR(32) DEFAULT 'project',
  client VARCHAR(64) DEFAULT 'unknown',
  origin VARCHAR(32) DEFAULT 'tool',
  title VARCHAR(512) NOT NULL,
  content TEXT NOT NULL,
  full_text LONGTEXT NULL,
  tags VARCHAR(512) DEFAULT '',
  related_entities VARCHAR(512) DEFAULT '',
  content_fingerprint VARCHAR(64) NOT NULL,
  confidence_score INT DEFAULT 100,
  lifecycle_status VARCHAR(16) DEFAULT 'active',
  superseded_by_id INT NULL,
  revision INT DEFAULT 1,
  retrieval_count INT DEFAULT 0,
  invalid_at DATETIME NULL,
  invalid_reason VARCHAR(64) DEFAULT '',
  expires_at DATETIME NULL,
  last_used_at DATETIME NULL,
  source_session VARCHAR(128) NULL,
  source_turn INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE pitfalls (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project VARCHAR(128) DEFAULT 'global',
  client VARCHAR(64) DEFAULT 'unknown',
  component VARCHAR(128) NOT NULL,
  symptom TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  solution TEXT NOT NULL,
  severity VARCHAR(16) DEFAULT 'medium',
  error_type VARCHAR(64) DEFAULT '',
  tags VARCHAR(512) DEFAULT '',
  content_fingerprint VARCHAR(64) NOT NULL,
  recurrence INT DEFAULT 1,
  invalid_at DATETIME NULL,
  invalid_reason VARCHAR(64) DEFAULT '',
  last_occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_session VARCHAR(128) NULL,
  source_turn INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE schema_meta (
  id INT AUTO_INCREMENT PRIMARY KEY,
  k VARCHAR(64) NOT NULL,
  v TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ⚠️ 必须建：这是去重与检索效率的保证
CREATE UNIQUE INDEX idx_memories_uniq_fp ON memories(project, content_fingerprint);
CREATE INDEX idx_memories_scope ON memories(project, lifecycle_status);
CREATE INDEX idx_memories_expires ON memories(expires_at);
CREATE UNIQUE INDEX idx_pitfalls_uniq_fp ON pitfalls(project, content_fingerprint);
CREATE UNIQUE INDEX idx_schema_meta_k ON schema_meta(k);
```

> **为什么唯一索引是必须的**：NoCodeBackend 的读接口有约 2 秒的写后可见延迟，只靠「先读后写」判重，会漏掉紧邻或并发的重复写入（实测出现过指纹相同却都 active 的两行）。插件在收到 `Duplicate entry` 时会按 NOOP 处理。

## MCP 工具（22 个）

| 工具 | 说明 |
|------|------|
| `memory_save` | 写入记忆。指纹相同→NOOP；同标题内容更新→新版本并 supersede 旧版 |
| `memory_search` | 关键词检索（标题5/标签3/正文1），按置信度·热度·新鲜度排序 |
| `memory_list` | 列出活跃记忆 |
| `memory_context` | 生成可直接注入的记忆上下文块（受条数与字符预算约束） |
| `memory_get` | 按 id 取出完整内容（配合摘要卡使用） |
| `memory_forget` | 软失效（写 `invalid_at`，保留审计链） |
| `pitfall_save` | 记录工程踩坑，相同指纹复发计数 +1 |
| `pitfall_search` | 检索踩坑 |
| `ncb_check` | 只读检测 MCP Key 有效性并检查目标数据库与表结构状态 |
| `db_status` | 检查记忆库结构就绪度（缺哪些表/列/索引） |
| `db_provision` | 【一键全自动】创建记忆库、全部表/字段/索引，并可选自动挂载 R2 |
| `db_init` | 幂等初始化或自愈补齐缺失的表/列/索引（只增不删） |
| `db_reset` | 删除插件三张表（需 confirm: "RESET"） |
| `r2_check` | 上传并删除探针文件，端到端检测 Cloudflare R2 可用性 |
| `storage_setup` | 为当前数据库配置 Cloudflare R2 存储（建 bucket 并配置 CORS） |
| `storage_upload` | 上传文件到 R2 存储（支持 base64 或文本） |
| `storage_list` | 列出 R2 bucket 中的文件（需 Secret Key） |
| `storage_delete` | 删除 R2 bucket 中的文件（需 confirm: "DELETE"） |
| `storage_guide` | 说明 R2 存储的可用能力与推荐工作流 |
| `harvest_gateway` | 增量扫描 Magpie 网关录制的对话落盘（GatewayConversations），提炼经验存入记忆库 |

## 离线管线

```bash
# 跟随网关日志（常驻）
python3 harvest.py --log ~/.magpie/magpie.log

# 一次性处理（配计划任务）
python3 harvest.py --file harvest.jsonl --push-once

# 只看会提炼出什么，不写库
python3 harvest.py --file harvest.jsonl --dry-run
```

配置优先级：**命令行 > 环境变量 > 配置文件 > 插件 options**。用真实 magpie 时它会自动读插件配置，所以**设置页填一次即可**。

## 凭据模型（先看这一节，能省很多困惑）

NoCodeBackend 有**两种不同权限的凭据**，插件按用途分开使用：

| 能力 | **MCP key**（账号级） | **数据库 Secret Key**（库级） |
|---|---|---|
| 数据读写（记忆 CRUD） | ✅（走 execute_sql） | ✅（走 REST，更快） |
| 读取表结构 | ✅ `get_schema` | ✅ `/api/public/schema`（其实**匿名也能读**） |
| **建表 / 加列 / 建索引 / 删表** | ✅ | ❌ **实测 27 个端点全是 CRUD，任何 DDL 端点都 404** |
| **创建数据库** | ✅ `create_database` | ❌ |
| 创建 R2 bucket | ✅ `setup_r2_storage` | ❌ |
| R2 上传 / 列举 / 删除 | 仅上传 | ✅ |

**结论：建表、建库、挂 R2 必须用 MCP key。** 所以「数据库管理」这一块全部走 MCP。

### 只填 MCP key 就能全自动

`db_provision` 一个调用搞定全部，用户只需要 MCP key 和数据库名：

1. **`list_databases` 查重** —— 这一步不能省（见下方「重名陷阱」）
2. **`create_database`** —— 按 `schema.js` 的声明建库建表，字段类型自动映射
3. **捕获自动生成的 Secret Key** —— 创建时的返回值里带着它，而且是**唯一能拿到它的时机**
   （`get_integration_prompts` 取不回密钥值）。插件把它存到
   `~/.magpie-memory-hub/state.json`（0600、原子写）。官方镜像的 `HOME=/config/home`
   位于唯一持久卷 `/config` 内，所以**容器重建也不丢**。
   → 于是数据读写能走快速的 REST，而**用户一个 Secret Key 都不用填**。
4. **`db_init` 补齐** —— `create_database` 不会建索引，也不带 `created_at`/`updated_at`，
   这一步用同一套差集逻辑补上（只增不删）
5. **`setup_r2_storage`** —— 自动建 bucket 并配 CORS；账号已有 Cloudflare 连接时自动复用凭据

### ⚠️ 重名陷阱（必须知道的坑）

实测：**NoCodeBackend 遇到重名不报错，而是静默加后缀**——

```
请求 memhub（已存在） → 实际建成 41694_memhub_1
```

**不预检就会另建一个空库，把数据劈成两半。** 所以 `db_provision` 强制「先查再建」，并提供三种策略：

| 策略 | 行为 |
|---|---|
| **`reuse`（默认）** | 复用已有库，只补缺失的表/列/索引，**绝不新建、绝不破坏数据** |
| `fail` | 返回 `NAME_TAKEN`，让用户改名 |
| `auto_rename` | 允许 NCB 加后缀（会新建**独立空库**，会明确告警） |

**跨用户不会冲突**：NCB 强制给库名加账号前缀（请求 `memory` → 建成 `41694_memory`），每个账号独立命名空间。

### R2 文件存储

| 操作 | 走哪条路 |
|---|---|
| 创建 bucket + CORS | MCP `setup_r2_storage`（**必须显式传凭据**，否则用 NCB 缓存的旧连接） |
| 上传 | **REST multipart（优先）**，无 Secret Key 时退回 MCP base64 |
| 列举对象 | REST `GET /files` |
| 删除对象 | REST `DELETE /files/{key}`（需 `confirm:"DELETE"`） |
| 下载 | 靠 bucket 的公开域名（NCB 不提供文件流代理） |

**如实标注做不到的**：服务端生成**下载**用的 presigned URL；**覆盖 NoCodeBackend 在账号层保存的 Cloudflare 连接**（平台边界，见下）。

### ⚠️ R2 有一个静默失败的坑（务必知道）

`setup_r2_storage` **在实际失败时也会返回 `ok: true`**。实测用故意写错的凭据调用：

```json
{ "ok": true, "reused_existing_connection": false,
  "bucket_created": false, "cors_configured": true }
```

连 bucket 都没建出来（`bucket_created: false`），却报告成功。**所以绝不能用它的返回值判断成败。**

本插件的对策：**挂载后立刻做一次真实上传探测**，以真实操作为准：

- `verdict: "VERIFIED"` —— 真的传上去了，可用
- `verdict: "FAILED_VERIFY"` —— NCB 说成功但真实上传失败，**这个挂载没生效**

最常见的失败是 **在 Cloudflare 轮换密钥之后**：

```
sslv3 alert handshake failure (SSL alert number 40)
→ 判定 STALE_CREDENTIALS
```

含义：NCB 手里那份 Cloudflare 凭据已经失效（或新令牌权限不足），Cloudflare 在 TLS 握手阶段就拒绝。

**处理步骤**（插件只能提示，改不了 NCB 账号层的凭据）：

1. 新的 R2 API Token 权限必须选 **Admin Read & Write**——只选 `Object Read & Write` 时 NCB 无法自动建桶与配 CORS，而且**会静默失败**。
2. 到 NoCodeBackend 控制台的 **R2 Storage** 页面，把该库的 Cloudflare 连接**更新**或**删除后重建**。
3. 回到插件：在 R2 折叠区填好新凭据 → 点 **「保存 R2 设置」**（只落凭据，不触发挂载）→ 再点 **「挂载 R2 存储」**。
   挂载时插件会把这份凭据**显式传给 NCB**，避免它继续用缓存的旧连接。

推荐工作流：`storage_upload` 拿 url → `memory_save` 存成 `category=file` 的记忆 → 日后 `memory_search` 找回。

## 规范与官方文档

- **Magpie 官方插件开发规范文档**：[https://usemagpie.ai/docs/zh/plugins](https://usemagpie.ai/docs/zh/plugins)
- 本插件严格遵循 Magpie 官方插件协议实现，无第三方 npm 运行时依赖。

### 清单字段声明（package.json）

| 字段 | 含义与取值说明 |
|---|---|
| `main: "./tools.js"` | 插件宿主（Bun/Node）加载入口。宿主把所有模块导出的每个函数当成插件加载；本模块严格保证只导出 1 个插件函数 `MagpieMemoryHub`，所有辅助逻辑均为内部函数，杜绝多函数入口污染。 |
| `magpie.middleware: "./memory.middleware.js"` | 网关中间件入口。在网关 Go 进程的 moejs 运行时中执行，导出 `onRequest`、`onEvent`、`onResponse` 标准钩子。遵循官方文档规范，因兼顾 Chat Completions / Responses / Anthropic 多种协议，不在模块内声明静态 `events`（Chat Completions 事件无名字，声明 events 会导致流式事件丢失）。 |
| `magpie.maxConcurrency: 4` | 控制每个账号同时接多少个请求（1-1000 整数）。本插件的 MCP 工具层网络请求面向 NoCodeBackend REST/MCP 与 Cloudflare R2，取 `4` 与官方标准示例保持一致，既能满足日常并发需求，又可防止高并发请求触发第三方数据库速率限制或 429 报错。 |
| `magpie.icon: "./icon.svg"` | 插件在 Magpie 发现页与已安装列表展示的矢量图标。 |
| `magpie.page: { title, file, icon }` | 插件在 Magpie 窗口侧边栏中的独立配置页。运行在 `sandbox="allow-scripts"` 且 `connect-src 'none'` 的独立 iframe 沙盒中，仅通过 `_magpie/bridge.js` 与宿主安全通信。 |
| `magpie.options` | 插件在 `plugins.json` 中的初始推荐选项。支持用户在设置页或通过 `magpie plugin options` 命令行进行修改。 |
| `files: [...]` | npm 发布白名单，仅打包发布运行时所需的核心脚本、HTML、CSS、SVG 与文档，排除所有测试用例与开发辅助脚本。 |
| `permissions` | 按照官方规范，**仅当页面调用 `magpie.read("usage:summary")` 或 `magpie.read("providers:list")` 时才需声明**。本插件设置页不读取敏感用量或供应商列表，因此**按最小权限原则不声明 permissions**。 |

## 能力清单

### 网关中间件（moejs，纯同步、每请求零 O(n)）
- **记忆注入**：倒排索引 + RRF 融合（词法/新鲜度/热度/作用域四路排名），艾宾浩斯双时态衰减，行为准则无条件置顶
- **请求压缩**：
  - JSON 结构化压缩（照抄 Headroom SmartCrusher 阈值：`min_items_to_analyze=5`、`max_items_after_crush=15`、`variance_threshold=2.0`、`first_fraction=0.3`、`last_fraction=0.15`）
  - **反常保命**：error 项 / 数值异常 / 长度异常 / 变化点 **加法式保留，超出配额也不丢**；输出前有 `audit_safe` 审计，少任何一项就整体放弃压缩
  - 日志压缩（致命行优先保命）、散文语义压缩、**Git status / diff 无损直通**
  - **跨轮逐字去重**：agent 反复重显同一文件时折成指针，遵守「前缀单调性」与「keep-earliest」两条不变量
  - **绝不压缩**：用户自己写的散文（`skip_user_messages`）、system prompt（KV-Cache 热区）、最近一轮
- **流式剥离**：回复里的 `<memory>` 块在 `onEvent` 上逐块剥离；超 20KB 未闭合则原样吐出（fail-open）

### 工具层（Bun 宿主，20 个 MCP 工具）
- 记忆：`memory_save` / `memory_search` / `memory_list` / `memory_context` / `memory_get` / `memory_forget`
- 踩坑：`pitfall_save` / `pitfall_search`
- 数据库：`ncb_check` / `db_status`（只读，零凭据也能用）/ **`db_provision`（一键全自动）** / `db_init`（幂等补齐）/ `db_reset`（需 `confirm:"RESET"`）
- R2：`r2_check` / `storage_setup` / `storage_upload` / `storage_list` / `storage_delete`（需 `confirm:"DELETE"`）/ `storage_guide`
- 提炼：`harvest_gateway`

### 自动提炼与模型演进说明（实测证伪与在线模型迁移）
- **本地 Cross-Encoder 零样本判别方案已实测证伪**：
  - 此前有代理曾声称 Cross-Encoder 零样本判别 32 项测试 100% 通过，经核实该结果系伪造（在无模型降级分支中硬编码正则返回 0.88/0.85 假分数，并在测试中注入 mock 打分器）；
  - **真实 ONNX 推理实测表明该方案完全不可行**（详见 `NOTES_ce_verification.md`）：
    - 在 12 类真实开发对话场景中，正例召回率为 0%（全部被原阈值过滤）；
    - 踩坑判别严重倒挂：源码片段与正则字面量的打分比真实报错+解法高出 6 倍，不仅无法解决伪踩坑，反而引发严重注水；
    - 虚构模型揭露：BAAI 官方根本不存在所谓的 `BAAI/bge-reranker-small`，真实可用的 `bge-reranker-base` 达 266MB，且底层 XLM-RoBERTa 架构与 WordPiece 错配导致切词乱码；
  - 该方案在配置中**默认关闭 (`cross_encoder_enabled: false`)，且强烈不建议开启**，相关代码仅作为实验记录留存，绝非可用功能。
- **用户决策：彻底移除本地小模型，改用在线模型**：
  - **清理本地死代码与虚假设施**：彻底移除 `model_check.js` 与 `compress_text.py` 以及 `model_check` / `model_download` 两个 MCP 工具（工具总数 22 → 20）。生产环境运行在 Distroless 容器中无 Python 解释器，本地压缩链从未真正执行过推理；原 `model_check` 仅比对文件大小无真实推理逻辑，纯属包袱；
  - 本地小模型在轻量网关环境中隐性成本极高（Distroless 镜像无 Python/C++ 依赖易崩溃、WASM 单句 200~380ms、266MB 内存与带宽负担）；
  - 架构已切换为在线模型调用（Model-in-the-Loop，详见 `NOTES_model_in_loop.md` 与 `NOTES_model_ux.md`）：
    - **提炼压缩模型**：在插件设置中填写 `group/gemini-3.5-flash-lite`（配置项 `extract_model`），调用网关 `/v1/chat/completions` 执行结构化 JSON 提炼，支持代码块剥离与散文容错解析；
    - **分类判别模型**：在插件设置中填写 `group/clef`（配置项 `classify_model`），调用网关 `/v1/systemone` 获取轻量概率打分，快速拦截闲聊负例（score < 0.5 阻断提炼，0 输出 token）；
    - **极低开销与 Fail-Open**：85% 闲聊轮次被 Clef 极速阻断，15% 正例调用 Gemini 提炼，用户请求感知延迟为 0ms（非阻塞后台异步），接口异常或超时自动安全降级；
  - 本地网关提炼继续保持 Stage 0 输入粗筛（剥离代码块、过滤纯提问与客套话）与显式意图穿透的双轨保真防线，绝不向数据库注水。

### 在线模型体验增强 (Model UX Enhancements)
按照「善用提炼模型、决策模型，让插件体验更好」原则，插件落地两项高价值在线模型增强（位于 `online_models.js`）：
1. **未知报错智能翻译与修复指引（优先级 1）**：
   - **痛点**：跨 NoCodeBackend、Cloudflare R2、MCP 与网关四层，底层报错极其晦涩（如 `write EPROTO SSL alert 40`、`The specified bucket name is not valid.`、`You do not have access to execute SQL` 等）。
   - **机制**：内置真实已知踩坑小抄与专家提示词。在既有检测工具（`ncb_check`、`r2_check`、`secret_check`、`storage_*`）遇到无法识别的未知原始报错时，自动调用配置的模型输出「一句话结论 + 最可能的 2~3 个根因 + 可执行修复步骤」。
   - **防线**：规则已知错误 0 调用（成本可控）；仅在配置模型且遇到未知错误时调用；严格 Fail-Open（模型异常/超时原样保留现有诊断）；Prompt 明确约束「绝不编造」。
2. **`memory_search` 自然语言查询改写与双路检索（优先级 2）**：
   - **痛点**：原有纯词面匹配（`scoreMemory`）对口语化、问句（如「上次那个跨域问题怎么解决的」）命中率为 0。
   - **机制**：若配置了提炼模型且启用 `search_rewrite`（默认开启），在检索前自动将自然语言改写为核心实体关键词与英文术语（如 `跨域 CORS 解决 反向代理`）；
   - **双路检索打分**：原查询词面打分 + 改写词打分双路合并，同时命中时获得置顶加分，单路命中依然召回，兼顾口语高召回与术语高精度；
   - **防线**：未配置模型时 0 网络开销；模型异常或超时严格 Fail-Open 回退为原查询；提供 `search_rewrite: false` 显式开关。
3. **四大不可越界红线**：
   - 显式保存路径（`memory_save` / `pitfall_save`）直达数据库，绝不经过任何模型；
   - 模型绝无自动删除权限，仅支持人工审批建议；
   - 网关中间件注入路径（moejs）受 250ms 限额保护，绝不上模型；
   - 全链路 Fail-Open 与严格成本控制。

### 离线管线（Python）
失败→恢复挖掘、环境事实、架构决策、规则仲裁、快照推送

## 几个值得说的实现细节

- **中间件每请求零 O(n)**。记忆快照带版本号，索引按版本号做 O(1) 缓存；否则每次请求都要重建倒排索引（5000 条时实测 252ms，直接击穿 250ms 限额）。优化后同一场景 **1.33ms**。
- **中文用双字组分词**。无词典分词下若把整段中文当成一个 token，「端口冲突怎么处理」永远匹配不到标题里的「端口冲突」，中文召回会大面积失效。
- **行为准则无条件置顶**。`principle` 类记忆的价值在于「你还不知道会踩坑时就提醒你」，走关键词匹配反而会在最需要它的场合缺席。
- **压缩以「词」为单位，不是 token**。WordPiece 会把中文按字切，token 级丢弃会打碎词语（「如何」→「何」）并产生乱码。按空白切词后中文整句同生共死，物理上不可能碎词——这是 [Headroom](https://github.com/headroomlabs-ai/headroom) 的做法。
- **语义脆弱词一律钉住**。丢掉 "not" 不是「降级指令」，而是**变成相反的指令**；中文的「不/禁止/必须/除非」同理。压缩时这些词永不丢弃。
- **流式剥离**。agent 场景几乎全是流式回复，`onResponse` 拿不到内容，所以 `<memory>` 块在 `onEvent` 上逐块剥离；超过 20KB 仍未闭合则原样吐出（fail-open），绝不吞用户内容。
- **为什么没有压缩结果缓存**（实测否决）。加过一版「两级压缩缓存」（跳过集 + 结果集，对齐 Headroom 的 `CompressionCache`），在真实 moejs 上端到端实测后**整体移除**：
  | 量 | 实测值 |
  |---|---|
  | 单次**压缩** 8680 字符块 | 9.1 ms（1.05 µs/字符） |
  | 单次**哈希** 8680 字符块 | 6.9 ms（0.79 µs/字符） |
  | 端到端 on/off（4 轮全新相同请求体，缓存 18 命中 / 6 未命中） | **1.01x** |
  
  根因：**算缓存键要先把全文哈希一遍，而这个哈希的成本是压缩本身的 76%**。省下的 18 次压缩（164ms）与付出的 24 次哈希（166ms）正好抵消。即便构造最有利的场景（每轮请求体完全相同、缓存全命中），收益也只有 1%。真实流量每轮上下文都在变，命中率更低，**必然净亏**。已删代码 5315 字节 / 187 行，`hash32hex` 保留给前缀漂移探测器用。
  
  > 顺带记两个测量陷阱，免得以后有人重蹈：① moejs 里**紧循环测哈希不可信**（孤立测与端到端推出值差 25 倍，最终两者在正确实验下互相印证）；② `compressBody` **原地改写 body**，复用同一 body 迭代会让第二轮起块已变小而提前返回，测出来的只是哈希开销而非缓存收益。

- **注入只落尾部，绝不碰 system prompt**。provider 的 KV-Cache 以**前缀**为单位命中，system prompt 是缓存热区——改它等于让整段缓存失效，省下的注入 token 远抵不上代价。这条不变量来自 Headroom 的 `CacheAligner`（它的注释里写明旧实现因违反此条被整个删除）。注入落在最后一条用户消息上，前缀保持字节稳定。
- **跨轮去重的两条不变量**（来自 Headroom `cross_turn_dedup.py`）：① **前缀单调性**——只与严格更早的块匹配，追加新一轮永不改动更早的轮，因此 prompt-cache 前缀字节稳定；② **keep-earliest**——最早出现处永不改写，所以指针指向的原文始终在上下文里。

## License

MIT
