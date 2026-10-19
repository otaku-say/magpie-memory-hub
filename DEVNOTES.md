# Magpie Memory Hub 开发与架构演进备忘录 (DEVNOTES.md)

本文档归并整合了仓库历史上 47 份独立设计笔记（`NOTES_*.md`），系统记录关键架构决策、系统边界、死路探索、Bug 根因排查与工程铁律，避免碎片化文件在 GitHub 源下发时污染部署目录。

---

## 一、系统架构与运行边界

### 1. 双宿主与进程模型
Magpie Memory Hub 在 Magpie 网关生态中跨两个不同宿主环境运行：
- **Goja 中间件宿主 (`memory.middleware.js`)**：运行在 Goja 引擎中，纯内存无 I/O 环境，拦截 `onRequest`、`onEvent`、`onResponse` 管道。负责前向记忆倒排索引检索、KV-Cache 保全的尾消息轻量注入、流式 `<memory>` 标签剥离。
- **Bun 扩展宿主 (`tools.js`, `gateway_harvest.hooks.js`, `page_actions.js`, `r2.js`, `local_state.js`)**：运行在容器内独立 Bun 进程中，具备完整网络与本地磁盘 I/O 能力，注册 20 个 MCP 工具，负责与 NoCodeBackend (NCB) MySQL REST/MCP 通信、Cloudflare R2 挂载、在线大模型异步提炼、设置页信标驱动。

### 2. 读写链路的硬物理约束（为什么放弃热回推）
- **现象**：Bun 宿主写 NCB 数据库，但中间件只能读取 `options.memories` 静态快照。
- **曾经的死路尝试**：在每次存入记忆后，通过 CLI 或内部接口写回 `options.memories`。
- **源码确凿证据**：
  1. `internal/plugin/host.js:1141-1145`：宿主向插件注入的 `magpie` 对象仅有 `option(key)` 与 `options()` 查询函数，无任何写操作 API。
  2. `internal/plugin/store.go:267-285` 与 `host.go:780-785`：外部篡改 `plugins.json` 会改变 `listStamp()`，导致 `hostStale.Store(true)`，随后 `current.retire()` 强制杀掉现有 Bun 进程并重启。
  3. `internal/gui/pluginpage.go:274-320` 调用的 `SetOptions`（`store.go:648`）显式调用了 `Restart()`。
- **铁律结论**：任何在采集写库时自动热回推 options 的操作，都会导致宿主陷入**每存一条就重启一次的永久震荡**，并掐死正在运行的后台异步队列！
- **最终落地解决方案**：
  - **主路（尾消息主动检索引导）**：在 `memory.middleware.js` 尾部消息追加 `[Memory Agent Guide]` 轻量提示，引导智能体在需要时主动调用 `memory_context`、`memory_search`、`pitfall_search` 工具从数据库动态检索。
  - **辅路（设置页受控刷新快照）**：在设置页卡片增加「刷新记忆快照到中间件」按钮，对应信标 `sync_snapshot`。用户手动触发单次拉取 Top-50 活跃记忆写回 options，低频可控。

---

## 二、状态管理与单一本真相源

### 1. 为什么状态只能存 `~/.magpie-memory-hub/state.json`
- 官方 Docker 镜像（如 `distroless`）中，容器根文件系统不可持久，唯一持久卷是 `/config`。
- 官方镜像默认 `HOME=/config/home`，位于持久卷内。
- `~/.magpie-memory-hub/state.json` 文件权限受控为 `0600`，容器重建与更新时不丢失。

### 2. 状态源收敛与僵尸复活防护
- 历史遗留问题：过去代码跨 `state.json`、`_status.json`、`page-actions.json` 多个文件，且 `r2.js` 曾从 `_status.json` 反向恢复挂载状态，导致已解绑的数据库被僵尸复活。
- **现行设计**：
  - `state.json` 为**全局唯一业务真相源**（管理 `current`、`secrets`、`actions`、`gateway_harvest`、`pending_patterns`、`r2_mounts`、`harvest_queue`）。
  - `_status.js` 降级为前端单向只写视图，后端绝不反向解析其内容。
  - `r2.js` 的 `isR2Mounted` 仅采信 `state.json` 的 `r2_mounts`，杜绝状态漂移与僵尸复活。
  - 路径基准：彻底摒弃在网关运行时必然漂移的 `process.cwd()`（网关实际运行在 `/config/cache/magpie/plugin-host/`），全仓统一使用 `import.meta.url` 基准解析自身文件。

---

## 三、`state.json` 膨胀治理与死信防卡死

### 1. 膨胀根因诊断（实机 2.29 MB 事故）
用户实测容器中 `state.json` 高达 2,287,343 字节（2.29 MB），导致单线程 Bun 同步序列化事件循环严重阻塞。逐键分析查明：
- `pending_patterns` 顶满 1000 条，占用 1.26 MB 原始数据；
- 带缩进格式 `JSON.stringify(state, null, 2)` 格式化使体积翻倍至 2.29 MB；
- 818 条条目卡在 `count: 1`：原因在于使用精确哈希去匹配大模型生成的自然语言，措辞微变哈希全变，永难达成 2 次复现；
- 182 条条目达标（`count: 2`）却未出队：历史代码在 turnKey 逻辑下达成门槛后未执行 `delete pending[fp]`，形成僵尸驻留；
- `harvest_queue` 遇非 1062 报错无重试上限，死信永久堆积；
- `gateway_harvest.files` 与 `processed_fingerprints` 历史扫描记录无淘汰上限。

### 2. 4 步治理整改落地
1. **进程内 mtime 缓存与紧凑序列化**：
   - `local_state.js` 缓存解析后的状态对象，仅当 `stat.mtimeMs` 变化时才重新读盘与解析，将每轮约 10 次的 2.29MB 磁盘 I/O 降为内存比对。
   - 彻底废除 `null, 2` 缩进格式，采用紧凑 `JSON.stringify(state)` 序列化，直接削减 35%~40% 磁盘体积。
2. **`file_states` 与 `processed_fps` 淘汰限额**：
   - `rememberGatewayHarvest` 中 `files` 字典超过 500 项时，按 `processed_at` 降序截断，仅保留最新 500 个文件扫描状态。
   - `processed_fingerprints` 超过 1000 项时截断保留最新 1000 个。
3. **`harvest_queue` 死信熔断出队**：
   - `triggerBackgroundDrain` 中写入数据库遇非 `1062 Duplicate entry` 异常时，为队列项累加 `retries`。
   - 重试满 3 次仍失败的项判定为死信，强制移出队列并输出 `_diag("dead_letter_evicted", ...)`，杜绝单条异常数据导致全队列永久死锁与状态文件膨胀。
4. **`pending_patterns` 瘦身与防死锁**：
   - `recordPendingEvidence` 在条目未达门槛前，对 `content`、`symptom`、`root_cause`、`solution`、`sample` 等长文本严格截断至 200 字符以内，`title` 截断至 100 字符以内，剥离 `raw`、`dialogue` 等冗余大字段。
   - 达成门槛（`count >= minEvidence`）时，立即从 `pending_patterns` 中物理删除并清盘。
   - 容量上限由 2000 降为 500；读写时具备自动清洗能力，旧版本 2.29MB 的状态文件在新版本启动写入后立即自动瘦身至 50KB 以下。

---

## 四、自激风暴切断与调用预算熔断

### 1. 事故复盘
v6.19 曾发生内部提炼请求进入 `onRequest` / `onResponse` 形成循环递归调用，导致短时间内触发 15.5 万次模型调用的自激风暴。

### 2. 切断机制 (`model_budget.js`)
- **内部请求指纹标记**：内部调用强制注入 `x-magpie-internal: memory-hub` 请求头及特定 Prompt 结构特征。
- **`onRequest` 绝对豁免**：检测到内部请求特征时直接放行，绝不再度注册网关后置钩子。
- **滑动窗口限流**：每分钟限制最大调用次数（`harvest_max_per_min`）。
- **进程硬熔断**：单进程内累计调用次数触顶后立即锁存熔断（`harvest_max_total`），非阻塞 fail-open。
- **闲聊短路**：首条/末条纯闲聊无价值输入直接短路，消耗 0 次模型调用。

---

## 五、语义级查重与版本演进 (`semantic_dedup.js`)

### 1. 两层去重架构
- **Layer 1（精准语义指纹）**：`semanticFingerprint` 对标点、中英混排空白、助词归一化后计算 SHA-256，匹配完全相同的规范表达。
- **Layer 2（多维滑动窗口语义相似度比对）**：
  - 针对大模型自由生成的同义词变换、语序倒装与扩写（如 Web Search MCP 5 种不同表达），结合分词 Jaccard 相似度、重叠系数与 Levenshtein 距离。
  - 支持专有技术词与版本编号隔离（避免误把 React 18 与 Node.js 20 判同）。
- **去重消费行为**：命中已有记录时，不新增重复数据库行，而是自动累加目标记录的 `recurrence` 复发计数，并刷新 `updated_at`。

### 2. 记忆演进 (Superseded)
当同一 project、同一 category 下写入同标题的新记忆时，旧记录标记为 `lifecycle_status='superseded'`、`superseded_by_id=newId`，新记录版本号 `revision` 自增，实现知识可追溯演进。

---

## 六、GitHub 源安装与下发污染特性认知

### 1. 为什么 `package.json.files` 在生产环境“失效”？
- **实机证据**：生产容器部署目录中存在 `tests/`、`harvest.py` 及大量 `NOTES_*.md`。
- **源码根因**（`internal/plugin/store.go:303-311`, `390-395`, `707-722`）：
  - Magpie 安装 GitHub 插件时使用 `bun add github:owner/repo#commit`。
  - Bun 对 Git/GitHub 源依赖的处理方式为**直接检出并解压 Git 仓库树**到 `node_modules` 中。
  - 只有在向 npm registry 发布并执行 `npm pack` 时，`package.json` 中的 `files` 白名单才会生效；Bun 对 Git 源根本不执行 npm 打包流程，**完全忽略 `files` 字段**！
- **工程应对铁律**：
  - 仓库根目录必须保持极度干净，不得在 Git 树中留存临时废弃脚本（已彻底删除 `harvest.py` -1883 行）。
  - 所有历史零散笔记（47 份 `NOTES_*.md`）合并归拢为单一 `DEVNOTES.md`，减小下发体积逾 400KB。
  - `tests/` 目录：由于包含全量安全与防回归自动化门禁，删除测试将毁灭项目的持续维护性；其体积仅 200KB 且运行时从不被 Magpie 载入，权衡之下必须坚决保留在仓库中。

---

## 七、测试隔离与安全门禁铁律

1. **零残留断言与命名空间隔离**：
   - 凡涉及数据库写操作的测试，必须使用 `createTestEnv` 生成带有时间戳与随机前缀的 `__test__` 命名空间。
   - 测试退出前必须执行 `cleanup` 清除所写数据，并执行断言检测 `residue === 0`。
2. **严禁弱化断言与硬编码模型**：
   - 禁止为了让测试通过而弱化已有边界检查；
   - 禁止在测试或生产代码中硬编码第三方商业模型名。
3. **版本号同步门禁**：
   - `check_schema_sync.mjs` 强制校验 `package.json` 的 `version` 与 `settings.html` 的版本徽标必须 100% 逐字一致。

---

## 八、流式剥离吞响应致 499 故障根治 (v6.24.0)

### 1. 事故复盘
在长对话及 Agent 频繁输出场景中，客户端常偶发 499 断连异常。深入排查发现：
- 在 `memory.middleware.js` 的流式 `onEvent` 处理中，当剥离 `<memory>` 标签的缓冲区 `memoryBuffer` 达到 20KB 安全上限时，虽执行了截断直通，但未能完整重置内部状态标记 `inMemoryTag`；
- 在非流式 `onResponse` 管道中存在二次解析争用，导致网关陷入持续等待直至客户端超时断开（499）。

### 2. 治理与不变量
1. **严格 20KB Fail-Open 保护**：流式缓冲区达到 20KB 强制直通输出并原子重置所有标签状态；
2. **流式与非流式通道完全解耦**：流式已处理请求设置防重入标记，禁止 `onResponse` 重复处理；
3. **响应保全第一准则**：任何情况下绝不因辅助标签剥离而吞没、延迟或截断用户正常对话内容。

---

## 九、R2 检测顺序解耦与探针防堆积治理 (v6.25.0)

### 1. 痛点根因
过去 Cloudflare R2 检测信标（`r2_check`）深度绑定在数据库创建链路中，若用户尚未创建 NoCodeBackend 数据库即无法检测 R2 凭据；且每次检测向 R2 写入探针文件后，若缺少 Secret Key 则无法执行删除，导致用户存储桶内残留大量 `probe-*` 临时文件。

### 2. 架构整改
1. **检测链路完全解耦**：`r2_check` 只要填写 R2 凭据即可独立向 R2 发起真实连通性探测（上传探针、下载验证并尝试删除），不强制依赖数据库存在；
2. **探针残留提示与一键清理**：设置页检测到缺少 Secret Key 导致探针无法自动清理时，向用户展示友好提示框，并提供「清理探针文件」（`clean_probe`）信标支持一键批量删除历史探针；
3. **状态路由隔离**：建立 `containerOfOp` 状态路由机制，NCB、R2、模型与网关操作的状态反馈严格归入各卡片独立容器，严禁跨卡片串台。

---

## 十、内联提炼开关与默认选项回填治理

### 1. 默认值割裂陷阱
`inline_extract`、`inject_principles`、`search_rewrite`、`search_rerank` 等关键开关在 `package.json` 中的推荐默认值均为 `true`。若设置页前端 `fill(o)` 简单使用 `el.checked = !!o[k]`，在用户首次打开设置页时（`o` 为空或未显式定义该键），开关将呈现为未勾选，用户点击保存时该字段即被写入为 `false`，造成非预期的功能关闭。

### 2. 回填对齐准则
`fill(o)` 中对所有默认 `true` 的配置项，统一采用 `(o[k] !== false)` 进行判定与回填，确保未定义时保持默认开启，彻底消除初次保存导致配置误降级隐患。

---

## 十一、Magpie 客户端标识定制与固定探针调用 (v6.26.0)

### 1. 上游机制与默认 Bun 问题
Magpie 网关依据 HTTP 请求头的 `User-Agent` 与 `callerKey` 识别客户端名。在 Bun 容器环境中发起的内部请求默认带 `User-Agent: Bun/<version>`，导致 Magpie 用量面板将所有插件内部模型调用均记录为 `Bun`，无法与用户实际调用或其它 Agent 隔离审计。

### 2. 定制客户端标识规范
- 在所有内部模型调用（提炼、分类、审计、错误解释、查询改写）中，统一显式注入请求头 `User-Agent: Memory/<version>`（动态跟随 `package.json.version`）；
- 内部请求附加固定标记头 `x-magpie-internal: memory-hub`，网关据此识别内部请求并绝对豁免二次拦截，从根源切断自激风暴。

---

## 十二、定时去重表单改造与后台异步化 (v6.28.0 - v6.28.3)

### 1. 同步阻塞与超时痛点
全自动语义去重（`memory_audit`）需要对全库记忆进行分批比对并调用大模型仲裁，耗时通常达数十秒。若在 `runPendingAction` 中同步 await 执行，会导致 Magpie 宿主加载插件时因超时触发健康检查失败并杀掉进程。

### 2. 异步化架构与时间点回滚
1. **信标极速返回**：`runPendingAction` 接收到 `memory_audit` 时，记录任务状态后立即返回「已启动」信标（耗时 <20ms），由后台事件循环异步执行全量去重任务；
2. **自然语言实时表单**：定时去重表单支持 daily / weekly / monthly 灵活调度，前端实现实时自然语言调度预览；
3. **可追溯时间点回滚**：支持通过 `undo_before` 参数将记忆库还原至指定时刻（如 `2026-10-19 02:00`）之前的健康状态；所有去重操作严格采用软失效（写 `invalid_at` 与 `invalid_reason`），绝不物理硬删数据，保证审计链完整。

---

## 十三、前端 UI、快照同步通道修复、卡片 ⑤ 下线与打包规范整改 (v6.28.4)

### 1. 快照同步通道修复 (P0-4)
- 对齐槽位路由：`page_actions.js` 中的 `CARD_OF_OP["sync_snapshot"]` 与 `settings.js` 中的 `cardOfOp("sync_snapshot")` 统一映射为 `"inject"`；
- 容器规范挂载：在设置页卡片 ④ 内 `<button id="btn_sync_snapshot">` 下方挂载独立状态容器 `<div class="action-status-box" id="inject_action_status">`，由 `containerOfOp` 统一派发；
- 异常安全返回：拉取快照异常时严格返回 `ok: false, op: "sync_snapshot", title: "记忆快照拉取失败", lines: [err.message]`，杜绝返回假成功伪数据；
- 安全合并写回：前端接收到成功结果后，通过 `var next = collect(); next.memories = card.memories; delete next._action; queuedOptionsSet(next, true);` 执行安全合并，坚决避免覆盖清空其它卡片配置。

### 2. 悬空卡片 ⑤ 与 compress.js 彻底下线 (P2-11)
- 经多轮实机压测与架构评估，生产环境运行在轻量容器中，本地所谓的压缩链从未执行真正推理，且改写历史消息破坏了上游大模型 KV-Cache 前缀单调性；
- 物理移除整个卡片 ⑤（上下文压缩与去重）及 `settings.js` 中所有 compress 关联 ID 与监听；
- 物理删除 `compress.js`（削减 43KB 死代码），坚决保全 KV-Cache。

### 3. 仓库卫生治理与打包白名单 (P3-16)
- 根目录残留的所有历史单项设计笔记（`NOTES_*.md`）全部合并归档进 `DEVNOTES.md`，并在 git 仓库中物理清除；
- 在 `package.json` 中规范配置 `"files": ["*.js", "settings.html", "settings.css", "icon.svg", "README.md", "LICENSE"]` 白名单，确保只打包生产必要文件。


---

## 十四、后端核心数据与引擎修复检查点记录 (NOTES_backend_core_rectification.md)

# 后端核心数据与引擎修复检查点记录 (NOTES_backend_core_rectification.md)

## 1. 任务启动与环境基线
- **启动时间**: 2026-10-19
- **基线 Commit**: `4d67847` (v6.28.3)
- **发布版本**: `v6.29.0` (package.json 与 settings.html 严格同步)
- **执行环境**: 专属独立云端沙箱 (`/workspace/magpie-memory-hub`)，严禁本机执行，所有测试在沙箱 Node 24 下跑通。
- **协同分工**: 前端 UI/设置页卡片/文档由 Agent 2 在独立分支处理；本任务聚焦于后端与核心逻辑文件（tools.js, local_state.js, page_actions.js, gateway_harvest.hooks.js, gateway_harvest.js, r2.js, mcp_client.js 等）。

## 2. 10 项核心整改清单执行结果 (100% 全部完成)
- [x] **P0-1**: `tools.js:607-624` memorySearch 投影列补齐 `"invalid_at"` 与 `"expires_at"`，确保 isMemoryValid 准确过滤临时与失效记忆。并在 `tests/test_p0_external_fixes.mjs` 中为 Mock Client 增加了严格字段裁剪与失效/过期过滤断言。
- [x] **P0-2**: `tools.js:1401, 1528, 1682` memoryAudit 游标双表拆分为 `last_memory_id` 与 `last_pitfall_id`，杜绝跨表自增主键漏检；游标初始与空值以 `null` 表达，彻底杜绝 NCB 外键列哨兵值 0。
- [x] **P0-3**: `local_state.js:567` recordPendingEvidence 接入 `semantic_dedup.js` 的 `isSemanticallySimilar` 语义判定，同 project + kind: "pitfall" 时做语义模糊去重；统一 `tools.js:865`、`gateway_harvest.hooks.js:952`、`gateway_harvest.js:569` 中的 pitfall 指纹算法（`semanticFingerprint(project, "pitfall", component, symptom)`）。
- [x] **P1-5**: `tools.js` 增加 `_isAuditing` 全局并发互斥锁（重入直接返回 `skipped: true`）；`page_actions.js:351` 异步去重闭包直接调用 `memoryAudit` 方法，避免将 options 当作 input 递归调用 MagpieMemoryHub 造成状态与调度器重复初始化。
- [x] **P1-6**: `tools.js` 统一导出 `makeClient(cfg)`，并在 `page_actions.js`、`gateway_harvest.hooks.js` 中使用 `makeClient(cfg)`，支持 `ncb_secret`（REST 模式）回退。
- [x] **P1-7**: `tools.js` 中 `memorySearch`（top 命中文档）和 `memoryContext`（matchedMemories 命中文档）异步非阻塞（`Promise.allSettled`）递增 `retrieval_count` 并更新 `last_used_at` 与 `updated_at`。
- [x] **P1-8**: `tools.js:801-829` memoryContext 增加对 `category === "principle"` 准则的无条件置顶支持（最多 `max_principles` 条，默认 2），与网关中间件保持一致。
- [x] **P1-10**: `r2.js:636` r2Upload 补上 `await resolveRealDatabase(cfg, rawDb)`，消除真实库名前缀缺失隐患。
- [x] **P2-12**: `tools.js` memoryAudit 合并去重时合并 `tags` 与 `related_entities`，准确累加全部 duplicate 的 `recurrence` 计数（memories 与 pitfalls 双表均支持）。
- [x] **P2-13**: `tools.js` fetchAll 传入 `order_by: "updated_at DESC"`；`mcp_client.js` 对 `order_by` 做严格安全正则白名单与标识符双重校验。

## 3. 门禁与自动化测试验证
- `test_meta.mjs`: 43 个测试文件元检查 100% PASS。
- `check_schema_sync.mjs`: Schema 声明、写入字段、版本号同步（v6.29.0）100% PASS。
- `settings_page_test.mjs`: 静态检查 + 16 个真实交互测试 100% PASS。
- `verify_settings.mjs`: 11 个大项验收 100% PASS，残余为 0。
- `test_schema_defaults.mjs`: 外键列零哨兵值 0、时间戳全部显式写入 100% PASS。
- `test_exports.mjs`: tools.js 与中间件导出面合规性 100% PASS。
- `test_p0_external_fixes.mjs`: P0-1/2/3 专项测试 100% PASS。
- `test_tool_names_static.mjs`: 21 个 MCP 工具静态引用断言 100% PASS。
- `test_dedup_semantics.mjs`: 语义去重专项测试 100% PASS。
- `test_state_bloat_and_dead_letter.mjs`: state.json 防膨胀与死信淘汰 100% PASS。
- `test_search_enhancement_and_scale.mjs`: 检索增强与规模化专项测试 100% PASS。
- `test_auto_dedup_and_undo.mjs`: 自动去重与时间点撤销 100% PASS。
- 全量自动化测试扫描：41 个 PASS，4 个 SKIP（远端网络测试无 live key 正常跳过），0 FAIL。
