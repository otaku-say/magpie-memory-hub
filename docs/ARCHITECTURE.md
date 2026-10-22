# 架构概览

> 本文档描述 `magpie-memory-hub` v6.45.0 目录结构重构后的代码组织方式。
> 数字口径：本文所有行数均为 `wc -l` 实测值，统计基线为提交 `8ec2574`（`integ2`）。
> 决策背景见 [ADR-001-facade-pattern.md](ADR-001-facade-pattern.md)。

| 统计项 | 数值 |
|---|---|
| `src/` 下 JavaScript 模块 | 51 个 / 17 176 行 |
| `src/page/settings.css` | 1 169 行 |
| 根目录门面文件 | 3 个 / 宿主入口门面 |
| `src/` 一级子目录 | 7 个（core / domain / integration / middleware / page / services / tools） |
| 根目录 `.js` 总行数（重构前 `8f495b0`） | 16 个文件 / 17 048 行 |

---

## 分层模型

```
┌─────────────────────────────────────────────────┐
│ 根目录宿主契约层（tools.js · memory.middleware.js · gateway_*.js）    │
│ tools.js · memory.middleware.js · gateway_*.js    │
│ local_state.js · scrub.js · ncb_mcp.js · ...     │
├─────────────────────────────────────────────────┤
│ src/tools/    工具入口（MCP 工具处理函数）          │
├─────────────────────────────────────────────────┤
│ src/services/ 业务服务（save·audit·harvest）       │
├─────────────────────────────────────────────────┤
│ src/middleware/ 中间件（注入·流处理·事件）          │
├─────────────────────────────────────────────────┤
│ src/integration/ 外部系统集成（NCB·R2·MCP·模型）   │
├─────────────────────────────────────────────────┤
│ src/domain/   领域逻辑（指纹·评分·去重·预算）       │
├─────────────────────────────────────────────────┤
│ src/core/     基础设施（配置·状态·时间·环境）       │
└─────────────────────────────────────────────────┘
```

各层的实际体量：

| 层 | 文件数 | 行数 | 定位 |
|---|---:|---:|---|
| `src/core/` | 5 | 1 259 | 基础设施：配置常量、宿主本地状态、时间窗口、凭据脱敏 |
| `src/domain/` | 5 | 846 | 领域逻辑：指纹、相关性评分、语义去重、模型调用预算、有效性校验 |
| `src/integration/` | 7 | 3 787 | 外部集成：NoCodeBackend、Cloudflare R2、MCP 客户端、Schema、在线模型 |
| `src/middleware/` | 6 | 1 455 | 网关中间件：请求注入、流式事件、响应清洗 |
| `src/services/` | 14 | 4 778 | 业务服务：`save/` 记忆写入、`audit/` 去重审计、`harvest/` 对话采集 |
| `src/tools/` | 9 | 1 848 | MCP 工具入口：9 个记忆/踩坑工具的参数归一化与格式化 |
| `src/page/` | 2 | 2 629 | 设置页：`actions.js` 信标执行器 + `settings.js` 前端逻辑 |
| `src/index.js` | 1 | 563 | 插件主入口：工具树注册与宿主生命周期管理 |

---

## 依赖方向规则

**主方向（自上而下，箭头表示「可以依赖」）**：

```
src/index.js  ──▶  src/tools/  ──▶  src/services/
                       │                 │
                       ▼                 ▼
                 src/integration/  ──▶  src/domain/
                       │                 │
                       ▼                 ▼
                    src/core/  ◀─────────┘
```

允许的依赖方向（`↓` 表示允许上层依赖下层）：

| 依赖方 ↓ / 被依赖 → | core | domain | integration | middleware | services | tools | page | index |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **core** | ✅ | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **domain** | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **integration** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **middleware** | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **services** | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ⚠️ | ⚠️ |
| **tools** | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| **page** | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ |
| **index** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

规则说明：

- ✅ **允许**：该层的职责就是把下层能力组装成上层语义。
- ❌ **禁止**：反向依赖会制造循环，ESM 循环依赖会在某条调用链上把绑定解析成 `undefined`。
- ⚠️ **已存在的例外**（实测于 `8ec2574`，非本轮引入）：

  | 例外 | 具体位置 | 原因 |
  |---|---|---|
  | `core → domain` | `src/core/state.js` → `domain/semantic-dedup.js` | 本地状态需要 `isSemanticallySimilar` 判定状态条目语义重复 |
  | `services → page` | `src/services/audit/auditor.js`、`audit/undo.js`、`harvest/offline-scan.js` → `page/actions.js` | 审计与采集需回写设置页卡片状态（`writeCardStatus`） |
  | `services → index` | `src/services/harvest/harvest-pipeline.js` → 根 `tools.js` → `src/index.js` | 采集流水线需回调插件主入口写入记忆 |

- **已存在的两处循环依赖**（静态导入图实测，同样非本轮引入）：
  1. `src/index.js` → `src/page/actions.js` → `src/services/harvest/index.js` → `src/services/harvest/harvest-pipeline.js` → `src/index.js`
  2. `src/page/actions.js` → `src/services/harvest/index.js` → `src/services/harvest/harvest-pipeline.js` → `src/services/harvest/offline-scan.js` → `src/page/actions.js`

  两条链路都经过根目录门面收敛（`tools.js` / `gateway_harvest.js`），ESM 的 `export *` 是活绑定，
  因此当前不产生运行期 `undefined`。但 CONSTRAINTS.md 声明的 `tests/check_cycles.mjs` 门禁
  **在 `8ec2574` 的仓库树中并不存在**（全部远端分支历史中也未出现过该文件），因此这条约束
  目前没有机器检查兜底。详见「守护脚本」一节。

---

## 模块清单

下表按 `src/` 一级子目录组织。「主要依赖」列给出该模块的实际 import 目标（已把根目录门面
还原成其实现所在的层），依据各文件头部注释的「模块职责 / 依赖 / 被依赖」三段式声明。

### `src/core/` — 基础设施（5 个模块 / 1 259 行）

| 文件名 | 行数 | 职责 | 主要依赖 |
|---|---:|---|---|
| `config.js` | 92 | 统一配置解析、SQL 时间戳与常量定义（`CATEGORIES`/`SCOPES`/`SEVERITIES`/`FETCH_LIMIT`） | `core/state.js`（门面 `local_state.js`） |
| `sanitize.js` | 91 | 敏感凭据脱敏公共模块（单一真相源实现，幂等占位符） | 无 |
| `state-recent.js` | 32 | 进程内近期写入指纹单例（防 NCB 约 2 秒写后可见延迟造成的重复写入） | 无 |
| `state.js` | 973 | 插件在宿主本地的持久状态（`state.json` 单例、mtime 缓存、紧凑序列化、文件存取） | `node:fs`/`os`/`path`/`url`、`domain/semantic-dedup.js` |
| `time.js` | 71 | 定时去重时间窗口计算与触发判定（daily/weekly/monthly → SQL 时间戳） | 无 |

### `src/domain/` — 领域逻辑（5 个模块 / 846 行）

| 文件名 | 行数 | 职责 | 主要依赖 |
|---|---:|---|---|
| `fingerprint.js` | 30 | 文本指纹生成与语义规范化（FNV-1a 双轮 64bit → 32 位十六进制） | 无 |
| `scoring.js` | 67 | 相关性打分（标题 5 / 标签 3 / 实体 3 / 正文 1）、新鲜度衰减、综合排序与分词辅助 | `domain/semantic-dedup.js` |
| `semantic-dedup.js` | 437 | 语义级去重引擎（Layer ① 语义归一化指纹 + Layer ② 局部滑动窗口相似度比对） | `node:crypto` |
| `token-budget.js` | 278 | 在线模型调用的自激豁免判定与调用预算/熔断（`x-memhub-internal` 等内部头） | `node:fs` |
| `validity.js` | 34 | 记忆有效性校验（未软失效且未过期）与标签交集检查 | `domain/semantic-dedup.js` |

### `src/integration/` — 外部系统集成（7 个模块 / 3 787 行）

| 文件名 | 行数 | 职责 | 主要依赖 |
|---|---:|---|---|
| `db-tools.js` | 940 | 数据库结构管理与 R2 存储工具实现（探针 / 建库 / 初始化 / 重置 / 差集检测） | `ncb-client.js`、`schema.js`、`core/state.js`、`r2-storage.js`、`provider-models.js` |
| `mcp-client.js` | 285 | 只用 MCP key 的数据读写客户端（拼 SQL、表名/列名白名单、标识符与值转义） | `schema.js`、`ncb-client.js`、`core/state.js`、`r2-storage.js` |
| `ncb-client.js` | 326 | NoCodeBackend MCP HTTP JSON-RPC 客户端（通信 / 序列化 / DDL / R2 封装、SSE 响应解析） | 无 |
| `ncb.js` | 176 | NoCodeBackend 客户端构建（MCP/REST 双模）、参数形状嗅探与基础结果集工具 | `core/config.js`、`mcp-client.js` |
| `provider-models.js` | 670 | 在线模型调用封装（报错人话解释 / 语义改写 / 检索重排 / 语义查重审计） | `domain/token-budget.js` |
| `r2-storage.js` | 980 | Cloudflare R2 对象存储代管（双模凭据分工、真实探针校验、桶名规范化、上传列举删除） | `ncb-client.js`、`core/state.js`、`provider-models.js` |
| `schema.js` | 410 | 数据库结构的唯一真相源、DDL 语句生成与幂等迁移计划计算（`SCHEMA_VERSION = 6`） | 无 |

### `src/middleware/` — 中间件（6 个模块 / 1 455 行）

| 文件名 | 行数 | 职责 | 主要依赖 |
|---|---:|---|---|
| `event-stream.js` | 84 | 流式事件钩子 `onEvent`：`<memory>` 标签剥离与宿主零拷贝快路径 | `middleware/stream-utils.js` |
| `inject-builder.js` | 166 | 记忆上下文与智能体引导注入文本构建（`buildContextBlock`/`buildAgentGuide`/`sniffToolNames`） | 无（纯内存同步计算，零 I/O） |
| `memory.middleware.js` | 10 | 网关中间件骨架，串联 `onRequest`/`onEvent`/`onResponse` 三段管道 | `request-inject.js`、`event-stream.js`、`response-hook.js` |
| `request-inject.js` | 804 | 请求前置拦截与记忆注入：协议嗅探、分词倒排索引、RRF 排序（`RRF_K=60`）与组装 | `inject-builder.js`、`stream-utils.js` |
| `response-hook.js` | 63 | 非流式响应钩子 `onResponse`：响应正文中的 `<memory>` 标签剥离与清洗 | `stream-utils.js` |
| `stream-utils.js` | 328 | 流式事件正文提取、写回、完成状态判断、`<memory>` 标签状态机剥离与 fail-open 保护 | 无（纯内存同步代码，零 I/O） |

> 中间件层是唯一运行在 **Goja 无 I/O 宿主** 里的层，因此 `inject-builder.js` 与
> `stream-utils.js` 严禁引入任何文件系统或网络访问（AGENTS.md 硬约束 4：注入路径 250ms 硬限额）。

### `src/services/` — 业务服务（14 个模块 / 4 778 行）

**`save/` — 记忆存储（1 个模块）**

| 文件名 | 行数 | 职责 | 主要依赖 |
|---|---:|---|---|
| `save/memory-saver.js` | 557 | 记忆核心写入事务（指纹去重、语义去重、时序版本链 supersede 与冲突检测） | `core/**`、`integration/ncb.js`、`core/sanitize.js`、`domain/semantic-dedup.js` |

**`audit/` — 审计调度（3 个模块）**

| 文件名 | 行数 | 职责 | 主要依赖 |
|---|---:|---|---|
| `audit/auditor.js` | 831 | 记忆全局审计去重（模型判定合并、批次游标管理与审计日志） | `core/**`、`domain/**`、`integration/**`、`page/actions.js` |
| `audit/scheduler.js` | 196 | 定时去重后台调度器管理、触发检查与召回频次统计 | `core/**`、`integration/**`、`audit/auditor.js` |
| `audit/undo.js` | 198 | 去重审计撤销（全量回滚、按时间截断回滚与单批次撤销） | `core/**`、`domain/**`、`integration/**`、`page/actions.js` |

**`harvest/` — 对话采集（10 个模块）**

| 文件名 | 行数 | 职责 | 主要依赖 |
|---|---:|---|---|
| `harvest/classify.js` | 289 | 在线分类模型意图判定（自适应 systemone / chat 端点） | `harvest/scaffolding.js`、`domain/token-budget.js` |
| `harvest/dialog-extract.js` | 346 | 对话文本与用户输入抽取、协议归一化、JSON 提取与显式记忆意图判定 | `harvest/scaffolding.js` |
| `harvest/extract.js` | 261 | 在线提炼模型调用、结构化提炼、JSON 解析与字段归一化、模型连通性检测 | `harvest/scaffolding.js`、`dialog-extract.js`、`classify.js`、`domain/token-budget.js` |
| `harvest/harvest-pipeline.js` | 549 | 对话提炼与记忆入库流水线（双轨门禁、指纹去重与后台队列消费） | `harvest/*`、`tools.js`、`core/sanitize.js`、`core/state.js`、`domain/semantic-dedup.js` |
| `harvest/hook-request.js` | 84 | 网关请求前置钩子（自激防护、`auto_harvest` 门禁、origin 隐私守卫、cwd/query 注入） | `harvest/scaffolding.js`、`domain/token-budget.js` |
| `harvest/hook-response.js` | 180 | 网关响应后置钩子（Bounded Await 受限等待、生命周期防护、超时脱钩与任务调度） | `harvest/*`、`domain/token-budget.js`、`tools.js` |
| `harvest/index.js` | 73 | 汇总导出 `harvest` 域内所有服务模块与对外公共 API | `harvest/*`（域内全部） |
| `harvest/offline-scan.js` | 1 129 | 离线录制目录扫描与增量提炼（读盘、路径安全守卫、文件收集与离线入库） | `harvest/*`、`core/state.js`、`page/actions.js`、`domain/semantic-dedup.js` |
| `harvest/project-resolve.js` | 45 | 基于工作目录 `cwd` 与配置推导生效的项目命名空间（ARCH-3） | 无 |
| `harvest/scaffolding.js` | 40 | 脚手架与模板提示词过滤脱敏，提供统一 `_diag` 诊断日志 | 无 |

### `src/tools/` — MCP 工具入口（9 个模块 / 1 848 行）

| 文件名 | 行数 | 职责 | 主要依赖 |
|---|---:|---|---|
| `args.js` | 67 | 工具入参零摩擦容错归一化（同义字段映射、数组字符串互转与 project 继承） | 无 |
| `memory-context.js` | 404 | `memory_context` 入口：上下文装配、记忆与踩坑双路召回、预算控制与格式化注入 | `core/**`、`domain/**`、`integration/**`、`services/**`、`provider-models.js` |
| `memory-forget.js` | 91 | `memory_forget` 入口：跨表软失效，保留审计链，不物理删除 | `tools/args.js`、`integration/ncb.js`、`domain/scoring.js` |
| `memory-get.js` | 223 | `memory_get` 入口：单条或批量读取记忆与踩坑记录（CCR 展开用） | `tools/args.js`、`integration/ncb.js`、`domain/scoring.js` |
| `memory-list.js` | 158 | `memory_list` 入口：按项目/分类/标签/作用域分页列出记忆 | `tools/args.js`、`integration/ncb.js`、`domain/scoring.js`、`domain/validity.js` |
| `memory-save.js` | 15 | `memory_save` 入口：入参归一化、保存并格式化输出 | `tools/args.js`、`services/save/memory-saver.js`、`domain/scoring.js` |
| `memory-search.js` | 231 | `memory_search` 入口：语义检索、关键词评分、置顶原则、LLM 重排与召回统计 | `core/**`、`domain/**`、`integration/**`、`services/**`、`provider-models.js` |
| `pitfall-save.js` | 467 | `pitfall_save` 入口：踩坑记录沉淀、同因合并、复发频次累加、高频结晶反哺事实库 | `core/**`、`domain/**`、`integration/**`、`core/sanitize.js`、`domain/semantic-dedup.js` |
| `pitfall-search.js` | 192 | `pitfall_search` 入口：踩坑记录多字段加权检索与重排 | `tools/args.js`、`integration/ncb.js`、`domain/scoring.js`、`provider-models.js` |

### `src/page/` — 设置页面（2 个模块 / 2 629 行）

| 文件名 | 行数 | 职责 | 主要依赖 |
|---|---:|---|---|
| `actions.js` | 1 007 | 设置页信标动作执行器（处理设置页按钮触发的后台动作并回写状态） | `db-tools.js`、`r2-storage.js`、`core/state.js`、`harvest/index.js`、`tools.js` |
| `settings.js` | 1 622 | 设置页前端逻辑（沙箱 iframe 内运行，经 `_magpie/bridge.js` 与宿主通信） | 无（浏览器端脚本） |

> `settings.html` 通过相对路径 `src/page/settings.css` 与 `src/page/settings.js` 引用本层资源，
> 与 `src/` 的物理位置强耦合——移动这两个文件必须同步改 HTML。

### `src/index.js` — 插件主入口（1 个模块 / 563 行）

| 文件名 | 行数 | 职责 | 主要依赖 |
|---|---:|---|---|
| `index.js` | 563 | `MagpieMemoryHub` 插件主入口、MCP 工具树注册（21 个工具）与宿主生命周期管理 | `core/**`、`domain/**`、`integration/**`、`services/**`、`tools/**`、`db-tools.js`、`r2-storage.js`、`page/actions.js`、`harvest/index.js` |

---

## 根目录门面机制

### 为什么根目录保留「空壳文件」

v6.43.0 之前，`tools.js`（4 488 行）、`memory.middleware.js`（1 409 行）、
`gateway_harvest.js`（1 213 行）、`gateway_harvest.hooks.js`（1 805 行）四个巨石文件
承载了全部逻辑，根目录 `.js` 合计 17 048 行。重构把实现整体搬进 `src/`，**但根目录的
15 个 `.js` 文件全部保留**，每个只有 6–14 行，内容几乎全是 `export`。

保留空壳而不是直接删除，有三个硬性理由：

1. **宿主契约不可变**。`package.json` 里写死了三个入口路径：
   - `"main": "./tools.js"`
   - `"magpie".hooks": "./gateway_harvest.hooks.js"`
   - `"magpie".middleware": "./memory.middleware.js"`

   这些路径是 Magpie 宿主与插件之间的**发布契约**，改路径等于要求宿主升级，成本远高于收益。

2. **零引用破坏**。仓库里有三类指向根目录文件的引用（见下节），其中两类无法用机械改写覆盖。
   只要根目录文件还在，指向它的引用就全部继续有效。

3. **可回滚**。门面白名单一旦失效（见 ADR-001），回滚只需把 `src/` 目录删掉、恢复根文件，
   不需要逐个还原被拆散的模块。

### 三类引用与 codemod 的覆盖边界

迁移到 `src/` 时，全仓指向根目录文件的引用共 **268 条边**，分布在三类：

| 引用类型 | 边数 | 涉及文件数 | 典型写法 | codemod 能否覆盖 |
|---|---:|---:|---|---|
| **① ESM import** | 248 | 104 | `import { X } from "./tools.js";` | ✅ 可以 |
| **② readFileSync 字符串路径** | 1 | 1 | `fs.readFileSync("tools.js", "utf8")` | ❌ 不能（路径是裸字符串，不在 import 语句里） |
| **③ import.meta.url / new URL** | 19 | 10 | `new URL("../tools.js", import.meta.url)` | ❌ 不能（路径是运行时拼出来的 URL 对象） |

- **① ESM import** 是唯一「长得像 import」的引用，因此也正是 codemod 最容易覆盖的一类。
  但它只占 248/268 ≈ **92.5%**。
- **② readFileSync 字符串路径**只有 1 条（`tests/test_v631_a_tools.mjs` 读 `tools.js` 校验
  最坏耗时注释）。这条引用即便文件被搬走也不会「报错」，而是**静默读到空串或抛 ENOENT**，
  是最难排查的一类。
- **③ import.meta.url** 共 19 条，分布在 `tests/check_schema_sync.mjs`、
  `test_failopen.mjs`、`test_lookup_secret.mjs`、`test_multi_protocol.mjs`、
  `test_secret_stale_eviction.mjs`、`test_tool_names_static.mjs`、`test_v637_c_harvest.mjs`、
  `test_v6401_polish.mjs`、`test_v640_c_schema.mjs`、`test_v641_a_mw.mjs`。
  `import.meta.url` 的基准是**模块自身所在目录**，文件一旦移进 `src/core/`，
  相对层级从 `../` 变成 `../../`，路径必须同步改写。

### 当前的门面清单

| 根文件 | 行数 | 实现所在 | 被引用方式 |
|---|---:|---|---|
| `tools.js` | 14 | `src/index.js` + 4 个白名单辅助导出 | ①③ |
| `memory.middleware.js` | 8 | `src/middleware/memory.middleware.js` | ①③ |
| `gateway_harvest.js` | 6 | `src/services/harvest/index.js` | ① |
| `gateway_harvest.hooks.js` | 8 | `src/services/harvest/index.js` | ①③ |
| `local_state.js` | 6 | `src/core/state.js` | ①③ |
| `scrub.js` | 6 | `src/core/sanitize.js` | ① |
| `ncb_mcp.js` | 6 | `src/integration/ncb-client.js` | ①③ |
| `mcp_client.js` | 6 | `src/integration/mcp-client.js` | ① |
| `db_tools.js` | 6 | `src/integration/db-tools.js` | ①③ |
| `r2.js` | 6 | `src/integration/r2-storage.js` | ①③ |
| `schema.js` | 7 | `src/integration/schema.js` | ① |
| `semantic_dedup.js` | 6 | `src/domain/semantic-dedup.js` | ① |
| `model_budget.js` | 6 | `src/domain/token-budget.js` | ① |
| `online_models.js` | 6 | `src/integration/provider-models.js` | ① |
| `page_actions.js` | 6 | `src/page/actions.js` | ① |

其中 **`tools.js`、`memory.middleware.js`、`gateway_harvest.hooks.js`** 三个是
CONSTRAINTS.md 定义的**宿主入口门面**：它们是 `package.json` 声明的宿主加载点，
且必须保持「去掉注释与 import/export 后残留代码为 0」。其余 12 个是**兼容门面**，
只为保住①③两类引用而存在。

---

## 守护脚本

CONSTRAINTS.md 声明的门禁脚本与仓库实际状态对照如下（实测于 `8ec2574`）：

| 脚本 | 检查什么 | 仓库中是否存在 |
|---|---|:--:|
| `tests/check_cycles.mjs` | **循环依赖**：构建 import 图并检测环，防止 ESM 循环依赖在调用链上把绑定解析成 `undefined` | ❌ **不存在**（全部远端分支历史中亦无此文件；上文的 2 条循环依赖因此无机器门禁兜底） |
| `tests/test_structure.mjs` | **目录结构与门面纯净度**：① 根目录只有 3 个宿主入口门面（`tools.js` / `memory.middleware.js` / `gateway_harvest.hooks.js`）；② 门面只做 re-export，去掉注释与 import/export 后残留代码为 0；③ 每个模块顶部有中文注释（职责 / 依赖 / 被依赖） | ❌ **不存在**（同上） |
| `tests/check_split_equiv.mjs` | **拆分等价性**：① 函数名集合与重构前基线完全一致；② 同名函数行数差 ≤ 5 行（证明是原样搬运而非顺手改逻辑） | ❌ **不存在**（同上） |
| `tests/check_constraints.mjs` | **三类退化检测**（对照 `CONSTRAINT_BASE`，默认基线 `8f495b0`）：① 阈值移动——`test_meta.mjs` 的测试计数断言被改小；② 测试变简单——新增 `.skip` / 删除测试文件 / 抽掉 `assert`；③ 检查器被静默——新增 `eslint-disable` / `@ts-ignore` / `istanbul ignore` | ✅ 存在（128 行） |
| `verify_delivery.py` | **六项机器验收**：① 全部 `src/**/*.js` 与 3 个宿主门面的 `node --check` 语法；② import 与本地声明同名符号冲突；③ 3 个宿主门面行数 < 40；④ 门面只做 re-export（去注释与 import/export 后残留为 0）；⑤ 函数名集合与 `8f495b0:tools.js` 比对无缺失；⑥ `src/` 一级目录白名单（`core/domain/integration/services/tools/middleware/page`） | ✅ 存在（115 行） |

仓库中**实际存在**、且 `CONSTRAINTS.md`「检查器」一节已列出的另外两个脚本：

| 脚本 | 检查什么 | 状态 |
|---|---|:--:|
| `tests/check_schema_sync.mjs` | Schema 声明与代码实际写入字段是否对齐（防止漏列这类致命 bug） | ✅ 存在（209 行） |
| `tests/test_exports.mjs` | 导出面复核：`tools.js` 仅允许 9 个白名单导出；`memory.middleware.js` 仅允许 `onRequest`/`onEvent`/`onResponse` | ✅ 存在（32 行） |

> **注意**：CONSTRAINTS.md 的「检查器」小节列出的 7 个命令中，有 3 个
> （`check_cycles.mjs` / `test_structure.mjs` / `check_split_equiv.mjs`）在当前仓库树中
> 并不存在。这意味着「无循环依赖」「门面只做 re-export」「拆分等价性」三条架构约束
> 目前**没有自动化兜底**，需要人工评审把关。补齐这三个脚本属于后续待办。
> `CONSTRAINTS.md` 是唯一权威来源，脚本只是它的镜像——两者冲突时以 `CONSTRAINTS.md` 为准。
