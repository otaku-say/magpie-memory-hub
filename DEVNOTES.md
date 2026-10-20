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


---

# 第十五章：红队靶场验收测试报告 (归档自 checkpoint_adversarial_v629.md)

# 红队靶场验收测试报告 (checkpoint_adversarial_v629.md)

## 1. 任务背景与执行环境基线
- **报告生成时间**: 2026-10-19
- **测试执行角色**: 独立红队测试与验收门禁 Agent（背靠背独立于开发 Agent 1、前端 Agent 2）
- **基线 Commit**: `4d67847` (v6.28.3)
- **代码分支**: `qa/adversarial-v629-gate` (独立 worktree 分支)
- **专属沙箱环境**:
  - 沙箱 ID: `3119588a1ccc45728ee1e8c0da62f594`
  - 沙箱工作目录: `/workspace/magpie-memory-hub`
  - 运行时环境: Node.js `v24.18.1` (Linux aarch64 musl)
- **测试元规范遵从**:
  - 完全遵从 `tests/test_meta.mjs` 防线约束：
    1. 零外部网络依赖（纯内存/受控 Mock 桩仿真）
    2. Project 独立命名空间隔离（`__test__<ts>_<rand>`）
    3. 严禁向 `project='global'` 写入
    4. 执行完毕后强制 cleanup，断言清理后残余为 0（`residue === 0`）
    5. 具备确定性非 0 退出路径（门禁未通时严格 `process.exit(1)`）
    6. 无空 catch 块假过

---

## 2. 6 大核心缺陷靶场用例设计与反证矩阵

| 序号 | 缺陷代号 | 漏洞类型 | 靶场设计原则与对抗手法 | 未修复代码反证表现 (RED) | 修复验收标准 (GREEN 判据) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **靶子 1** | **P0-1** | **字段投影漏洞** | Mock Client 严格按 `params.columns` 裁剪字段（未选列设为 undefined，模拟真实 `mcp_client.js` SELECT 投影）；构造过期临时记忆 (`expires_at="2020-01-01"`) 与软失效记忆 (`invalid_at` 非空)。 | ❌ **RED**: `tools.js:607-624` 查询投影列缺失 `invalid_at` 和 `expires_at`，Mock 裁剪后 `isMemoryValid` 接收到 undefined，两项无效记录 100% 泄漏至 search 结果。 | `memorySearch` 返回结果 100% 过滤这两条记录，仅返回合法活跃记忆。 |
| **靶子 2** | **P0-2** | **游标跨表混用漏检** | 模拟 memories 表自增 ID 达 500、pitfalls 表自增 ID 仅 20。首轮增量巡检生成游标后，在 pitfalls 插入 ID 21..30 的 10 条新记录，再执行增量巡检。 | ❌ **RED**: `tools.js:1528` 跨表复用游标 `cursor.last_id=500`，导致 pitfalls 下推 `WHERE id > 500`，新增的 10 条踩坑记录全部被跳过，扫描数为 0。 | `scanned.pitfalls` 精确等于 10，游标双表独立拆分（`last_memory_id` 与 `last_pitfall_id`）。 |
| **靶子 3** | **P0-3** | **自然语言提炼语义比对与晋升** | 模拟大模型两次提炼相同语义但措辞微变的问题（如 `"Docker 启动失败: connection refused 127.0.0.1"` 与 `"Docker 服务启动报错 Connection Refused"`），连续调用两次 `recordPendingEvidence`。 | ❌ **RED**: `local_state.js:567` 仅通过字面字符串 key 匹配，无法识别语义变体，第 2 次调用新建孤立条目，count 保持为 1，`shouldGraduate` 为 false。 | 第 2 次调用命中语义相似项，count 累加至 2 (达到 `minEvidence=2`)，并触发 `shouldGraduate: true` 晋升。 |
| **靶子 4** | **P1-5** | **并发去重互斥锁** | 模拟 50ms 异步延迟，同时并发发起两个 `memoryAudit` 任务，制造重入竞态窗口。 | ❌ **RED**: `tools.js` 缺失 `_isAuditing` 互斥保护，后进入的任务未被拦截，两任务均全量执行完毕，存在并发重入重复写库风险。 | 后进入的任务被 `_isAuditing` 锁拦截，立即返回 `{ skipped: true, reason: "audit_in_progress" }`。 |
| **靶子 5** | **P1-8** | **memoryContext 准则无条件置顶** | 数据库中存在 `category === "principle"` 的架构准则记忆（如 `"全局禁止在 /root 幽灵目录作业"`），检索传入完全不相干的 query（如 `"React Hook 性能调优"`）。 | ❌ **RED**: `tools.js:801-829` 仅基于 query 关键词命中（`hit > 0`）过滤，准则关键词未命中被彻底丢弃，返回空 block。 | 返回的 context block 无条件置顶包含该条架构准则，不受 query 关键词无关影响。 |
| **靶子 6** | **P0-4** | **快照拉取异常安全** | 模拟底层网络中断与连接超时（Client 抛出 `ETIMEDOUT` 异常），触发信标执行 `sync_snapshot`。 | ❌ **RED**: `page_actions.js:306` 空 catch 吞掉异常，违规返回 `ok: true + memories: []`，会导致前端将空数组误当成正常快照全量覆写。 | 返回结果严格 fail-closed，必须为 `ok: false`，绝不允许返回 `ok: true + memories: []`。 |

---

## 3. 未修复代码上的反证执行实录

在未修复代码基线 (`commit 4d67847`) 上，执行 `node tests/adversarial_v629_gate.mjs`，运行实录如下：

```text
=================================================================
【红队独立质检验收门禁套件 tests/adversarial_v629_gate.mjs 启动】
=================================================================
[Gate Init] 测试隔离命名空间: __test__1792392995215_dff97eca

=======================================================
【靶子 1】P0-1 字段投影漏洞测试 (Field Projection Vulnerability)
=======================================================
  检索返回条目数: 3, 返回 ID 集合: [1, 3, 2]

❌ [RED 命中] 靶子 1 (P0-1 字段投影漏洞测试) 成功捕获预期缺陷！
   反证断言信息: [P0-1 字段投影漏洞反证成功] 过期临时记忆 (id=2) 竟泄漏在 search 结果中！原因：tools.js columns 未投影 expires_at 列，导致 isMemoryValid 判断失灵

=======================================================
【靶子 2】P0-2 游标跨表混用漏检测试 (Cursor Cross-Table Contamination)
=======================================================
  执行第一轮增量巡检（memories 自增 500，pitfalls 自增 20）...
  第一轮巡检完成，游标: {"previous_last_id":0,"current_last_id":500,"batch_size":1000}
  在 pitfalls 表新增 ID 21..30 的 10 条踩坑记录...
  执行第二轮增量巡检...
  第二轮巡检完成，扫描 pitfalls: 0 条 (期望: 10 条)

❌ [RED 命中] 靶子 2 (P0-2 游标跨表混用漏检测试) 成功捕获预期缺陷！
   反证断言信息: [P0-2 游标跨表混用反证成功] pitfalls 新增的 10 条记录 (ID 21..30) 完全漏检！实际扫描 0 条。原因：tools.js:1528 cursor.last_id=500 跨表污染 pitfalls 查询，导致 where id > 500

0 !== 10

=======================================================
【靶子 3】P0-3 自然语言提炼语义比对与晋升靶场 (Semantic Dedup & Graduation)
=======================================================
  第 1 次提炼: "Docker 启动失败: connection refused 127.0.0.1"
  第 1 次结果: count=1, shouldGraduate=false
  第 2 次提炼（自然语言措辞微变）: "Docker 服务启动报错 Connection Refused"
  第 2 次结果: count=1, shouldGraduate=false

❌ [RED 命中] 靶子 3 (P0-3 自然语言提炼语义比对与晋升靶场) 成功捕获预期缺陷！
   反证断言信息: [P0-3 语义比对与晋升缺陷反证成功] 自然语言措辞微变的相似问题未能累加 count！期望 count=2，实际 count=1

1 !== 2

=======================================================
【靶子 4】P1-5 并发去重互斥锁靶场 (Concurrent Audit Mutex)
=======================================================
  并发发起两个 memoryAudit 任务...
  任务 1 响应: action=DEDUP_REPORT, success=true, skipped=undefined
  任务 2 响应: action=DEDUP_REPORT, success=true, skipped=undefined

❌ [RED 命中] 靶子 4 (P1-5 并发去重互斥锁靶场) 成功捕获预期缺陷！
   反证断言信息: [P1-5 并发互斥锁缺陷反证成功] 并发调用的两个 memoryAudit 均未被拦截！无 _isAuditing 互斥锁保护，存在并发重入重复写库风险！(call1.skipped=undefined, call2.skipped=undefined)

=======================================================
【靶子 5】P1-8 memoryContext 准则无条件置顶靶场 (Principle Unconditional Pinning)
=======================================================
  调用 memoryContext，传入不相干 query: "React Hook 性能调优 useMemo useCallback"
  memoryContext 返回注入块:
(空 block)

❌ [RED 命中] 靶子 5 (P1-8 memoryContext 准则无条件置顶靶场) 成功捕获预期缺陷！
   反证断言信息: [P1-8 准则置顶缺陷反证成功] memoryContext 返回的 block 未包含架构准则！即便 query 完全不相关，category === 'principle' 准则必须无条件置顶！实际 block: ""

=======================================================
【靶子 6】P0-4 快照拉取异常安全靶场 (Sync Snapshot Fail-Closed)
=======================================================
  触发 sync_snapshot 信标，传入崩溃 client 模拟网络中断 (id=adversarial-sync-1792392995383)...
  runPendingAction 响应: {"ran":true,"op":"sync_snapshot","id":"adversarial-sync-1792392995383","executed":true,"result":{"ok":true,"at":1792392995384,"op":"sync_snapshot","title":"记忆快照拉取就绪","lines":["成功拉取 0 条活跃记忆快照供前端同步"],"memories":[]}}

❌ [RED 命中] 靶子 6 (P0-4 快照拉取异常安全靶场) 成功捕获预期缺陷！
   反证断言信息: [P0-4 快照异常安全缺陷反证成功] sync_snapshot 在网络/数据库抛错时违规返回 ok: true！这会导致前端误用空数组覆盖正常快照！res={"ok":true,"at":1792392995384,"op":"sync_snapshot","title":"记忆快照拉取就绪","lines":["成功拉取 0 条活跃记忆快照供前端同步"],"memories":[]}

true !== false

=================================================================
【红队独立质检靶场测试结果总览】
=================================================================
❌ [靶子 1] P0-1 字段投影漏洞测试: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P0-1 字段投影漏洞反证成功] 过期临时记忆 (id=2) 竟泄漏在 search 结果中！原因：tools.js columns 未投影 expires_at 列，导致 isMemoryValid 判断失灵
❌ [靶子 2] P0-2 游标跨表混用漏检测试: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P0-2 游标跨表混用反证成功] pitfalls 新增的 10 条记录 (ID 21..30) 完全漏检！实际扫描 0 条。原因：tools.js:1528 cursor.last_id=500 跨表污染 pitfalls 查询，导致 where id > 500
0 !== 10
❌ [靶子 3] P0-3 自然语言提炼语义比对与晋升靶场: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P0-3 语义比对与晋升缺陷反证成功] 自然语言措辞微变的相似问题未能累加 count！期望 count=2，实际 count=1
1 !== 2
❌ [靶子 4] P1-5 并发去重互斥锁靶场: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P1-5 并发互斥锁缺陷反证成功] 并发调用的两个 memoryAudit 均未被拦截！无 _isAuditing 互斥锁保护，存在并发重入重复写库风险！(call1.skipped=undefined, call2.skipped=undefined)
❌ [靶子 5] P1-8 memoryContext 准则无条件置顶靶场: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P1-8 准则置顶缺陷反证成功] memoryContext 返回的 block 未包含架构准则！即便 query 完全不相关，category === 'principle' 准则必须无条件置顶！实际 block: ""
❌ [靶子 6] P0-4 快照拉取异常安全靶场: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P0-4 快照异常安全缺陷反证成功] sync_snapshot 在网络/数据库抛错时违规返回 ok: true！这会导致前端误用空数组覆盖正常快照！res={"ok":true,"at":1792392995384,"op":"sync_snapshot","title":"记忆快照拉取就绪","lines":["成功拉取 0 条活跃记忆快照供前端同步"],"memories":[]}
true !== false

=================================================================
统计: 共运行 6 个靶场，通过 0 个，反证缺陷暴露 6 个
=================================================================

🚨 [红队门禁拦截] 检测到 6 个核心缺陷尚未修复 (RED 状态)！门禁已生效，阻止未达标代码合入。
（exit code: 1）
```

---

## 4. 测试元规范扫描结果 (test_meta.mjs)
在沙箱内运行 `node tests/test_meta.mjs`，全量 44 个测试合规扫描结果：
```text
=================================================================
【测试元检查】正在扫描 44 个测试文件规范合规性（已通过反证门拦截测试）
=================================================================

✓ [PASS] adversarial_v629_gate.mjs
✓ [PASS] adversarial_verify.mjs
✓ [PASS] check_schema_sync.mjs
✓ [PASS] settings_page_test.mjs
✓ [PASS] test_abort.mjs [写库+隔离+清理齐全]
✓ [PASS] test_all_20_tools_e2e.mjs [写库+隔离+清理齐全]
✓ [PASS] test_auto_dedup_and_undo.mjs [写库+隔离+清理齐全]
✓ [PASS] test_backend_acceptance.mjs
✓ [PASS] test_beacon.mjs
✓ [PASS] test_beacon_e2e.mjs
✓ [PASS] test_call_storm_fix.mjs [写库+隔离+清理齐全]
✓ [PASS] test_client_name.mjs
✓ [PASS] test_compress_template_dedup.mjs
✓ [PASS] test_configurable_models.mjs [写库+隔离+清理齐全]
✓ [PASS] test_dedup_and_audit.mjs [写库+隔离+清理齐全]
✓ [PASS] test_dedup_semantics.mjs
✓ [PASS] test_denoise_p0.mjs [写库+隔离+清理齐全]
✓ [PASS] test_exports.mjs
✓ [PASS] test_failopen.mjs
✓ [PASS] test_gateway_harvest.mjs [写库+隔离+清理齐全]
✓ [PASS] test_gateway_harvest_hooks.mjs [写库+隔离+清理齐全]
✓ [PASS] test_hardening.mjs
✓ [PASS] test_lookup_secret.mjs
✓ [PASS] test_mcp_only.mjs [写库+隔离+清理齐全]
✓ [PASS] test_model_in_loop.mjs [写库+隔离+清理齐全]
✓ [PASS] test_model_ux.mjs
✓ [PASS] test_multi_protocol.mjs
✓ [PASS] test_p0_external_fixes.mjs
✓ [PASS] test_pollution_guard.mjs
✓ [PASS] test_provision.mjs
✓ [PASS] test_r2_check_and_probe.mjs
✓ [PASS] test_r2_verify.mjs
✓ [PASS] test_schema.mjs
✓ [PASS] test_schema_defaults.mjs
✓ [PASS] test_search_enhancement_and_scale.mjs
✓ [PASS] test_secret_stale_eviction.mjs
✓ [PASS] test_sql_escape.mjs [写库+隔离+清理齐全]
✓ [PASS] test_state_bloat_and_dead_letter.mjs
✓ [PASS] test_status_race.mjs
✓ [PASS] test_stream_failopen.mjs
✓ [PASS] test_tool_names_static.mjs
✓ [PASS] test_traceability.mjs [写库+隔离+清理齐全]
✓ [PASS] verify_settings.mjs
✓ [PASS] verify_sub2.mjs

=================================================================
✅ 测试元检查全部通过！所有 44 个测试均符合隔离与严谨性规范。
=================================================================
```

---

## 5. 红队交付物与 Git 追踪
- **新增文件**: `tests/adversarial_v629_gate.mjs`
- **更新文件**: `tests/test_meta.mjs` (活跃测试文件数由 43 更新至 44)
- **文档文件**: `checkpoint_adversarial_v629.md`
- **Git 目标分支**: `origin qa/adversarial-v629-gate`
- **门禁验收令**: 开发 Agent 1 与前端 Agent 2 完成修复后，必须在沙箱内运行 `node tests/adversarial_v629_gate.mjs` 达成 6/6 靶场全绿（GREEN）且 exit code 0，方准发起主线合并！


---

## 十五、P0/P1 缺陷修复、测试用例清理与读操作防写放大整改报告

# P0/P1 缺陷修复、测试用例清理与读操作防写放大整改报告 (NOTES_v6291_bugfixes.md)

## 1. 任务背景与执行环境基线
- **报告生成时间**: 2026-10-19
- **执行角色**: Agent 1 (缺陷修复、测试清理与防写放大整改)
- **代码分支**: `feat/v6291-bugfixes`
- **沙箱环境**:
  - 沙箱 ID: `1abf0407baf441fa86804455390b21c8`
  - 沙箱工作目录: `/workspace/magpie-memory-hub`
  - 运行时环境: Node.js `v24.18.1` (Linux aarch64 musl)

---

## 2. 6 大核心整改清单执行结果 (100% 完成)

### 2.1 P0-1: page_actions.js 与 settings.js 快照同步与卡片回传规范化
- **page_actions.js**:
  - `formatCardStatus` 在快速返回与常规构建两条返回路径上均严格拷贝 `memories` 字段：`if (Array.isArray(res.memories)) card.memories = res.memories;`，防止快照数组在格式化时丢失。
  - 增加 `key === "inject"` 分支：`title = res.title || "记忆快照已就绪"; lines = Array.isArray(res.lines) ? res.lines.slice() : ["活跃记忆快照已提取完成"];`。
- **settings.js**:
  - `cardOfOp("sync_snapshot")` 稳定映射至 `"inject"`，状态容器绑定 `#inject_action_status`。
  - 轮询拿到更新且成功的结果时，若 `card.op === "sync_snapshot"`（或 `opHint === "sync_snapshot"`）且包含 `card.memories` 数组，安全同步至 `next.memories` 并调用 `queuedOptionsSet(next, true)` 立即回盘，且安全清理 `_action` 标记。

### 2.2 P0-2: 测试清理与遗留探针清理
- **物理删除失效用例**:
  - 使用 `git rm` 彻底删除 `tests/test_compress_template_dedup.mjs` 与 `tests/verify_sub2.mjs`，根除缺少 `compress.js` 导致的 `ERR_MODULE_NOT_FOUND` 报错。
- **tests/test_meta.mjs**:
  - 活跃测试文件总数断言从 44 个调整为 42 个（42/42 PASS）。
- **memory.middleware.js:563**:
  - 彻底删除存活探针 `__MEMHUB_PROBE__` 中 `compress: opts.compress === true` 遗留探针属性。
  - 同步更新 `tests/test_hardening.mjs`，断言探针返回数据中 `data.compress === undefined`。
- **settings.html:18**:
  - 移除副标题中的“上下文压缩”字样，订正为“内置踩坑库、R2 存储。”。

### 2.3 P1-3: tools.js 客户端构建归一化与防 null 崩溃
- **tools.js: makeClient(cfg, signal)**:
  - 归一化输入参数：`const o = (cfg && cfg.instance && typeof cfg.secret === "string" && typeof cfg.mcpKey === "string") ? cfg : readOptions(cfg);`。
  - `makeRestClient` 中提取库名与密钥支持别名回退：`instance = cfg.instance || cfg.ncb_instance`，`secret = cfg.secret || cfg.ncb_secret`。
  - **防 null 崩溃 Stub 客户端**:
    当无任何可用凭据（无 MCP Key 且无 Secret Key）时，构建并返回一个包含 `list`, `create`, `update`, `remove`, `raw` 等方法的 Proxy Stub 客户端，调用任意方法时抛出明确的人话异常：
    `"NO_CREDENTIALS: 未配置有效的 NoCodeBackend 凭据"`，
    彻底消除 `TypeError: Cannot read properties of null (reading 'list')`。

### 2.4 P1-4: local_state.js 与 gateway_harvest.hooks.js 组件名软匹配
- **local_state.js:595**:
  - 移除硬编码的 `if (curComp && candComp && curComp !== candComp) continue;` 阻断拦截。
  - 改为将 component 作为前缀拼入 symptom 传给 `isSemanticallySimilar`:
    `isSemanticallySimilar(`${curComp ? curComp + ' ' : ''}${curSym}`, curSol, `${candComp ? candComp + ' ' : ''}${candSym}`, candSol)`，实现组件名称的语义级容错软匹配。
- **gateway_harvest.hooks.js:959**:
  - 在调用 `recordPendingEvidence(pitKey, ...)` 时，传入 payload 显式补齐归一化后的 `component` 与 `symptom`，确保 pending 判定拥有完整的技术组件语义。

### 2.5 P1-5: tools.js 读操作绝不篡改 updated_at 与防写放大
- **tools.js: trackMemoryRetrievals**:
  - 只更新 `{ retrieval_count: (Number(r.retrieval_count) || 0) + 1, last_used_at: now }`，彻底删除 `updated_at: now` 覆写，坚决保障读操作不改变记忆修改时间戳。
  - 限制批量写入条数最多取前 5 条 (`rows.filter(r => r && r.id).slice(0, 5)`)，消除全量检索时的批量写放大。
- **freshness(row)**:
  - 优先读取 `row.last_used_at || row.updated_at || row.created_at`，保持时间衰减权重计算精确。
- **tests/test_schema_defaults.mjs**:
  - 对检索频次追踪 `trackMemoryRetrievals` 显式放行，对齐读操作不篡改 `updated_at` 的铁律。

### 2.6 P2-6: 仓库卫生与网络容错
- **DEVNOTES.md & checkpoint_adversarial_v629.md**:
  - 将根目录 `checkpoint_adversarial_v629.md` 完整归档入 `DEVNOTES.md` 第十五章，并通过 `git rm` 从仓库根目录物理移除。
- **settings.html 文案订正**:
  - 第 530 行、552 行、585 行文案订正为基于/采用在线模型抽取（消除已废弃的“本地规则引擎/零云端模型成本”遗留文案）。
- **package.json:45**:
  - 将 `ccr_cards` 默认值设为 `false`，与前端设置页及测试规范完全对齐。
- **网络容错优雅退出**:
  - `tests/test_backend_acceptance.mjs` 与 `tests/test_mcp_only.mjs` 增加网络错误与断网异常捕获，在检测到 `NETWORK_ERROR` 或连接断开时安全调用 `env.cleanup()` 并执行 `process.exit(77)` 优雅跳过。

---

## 3. 测试验证与门禁全绿实录

1. **测试元检查规范 (`node tests/test_meta.mjs`)**:
   - 扫描全部 42 个测试文件，通过所有反证门、写库隔离、强制清理与非 0 退出断言。
   - 结果：**42/42 PASS**。

2. **红队独立质检门禁 (`node tests/adversarial_v629_gate.mjs`)**:
   - 靶子 1 (P0-1 字段投影漏洞): PASS (GREEN)
   - 靶子 2 (P0-2 游标跨表独立管理): PASS (GREEN)
   - 靶子 3 (P0-3 语义比对与晋升): PASS (GREEN)
   - 靶子 4 (P1-5 并发互斥锁): PASS (GREEN)
   - 靶子 5 (P1-8 架构准则无条件置顶): PASS (GREEN)
   - 靶子 6 (P0-4 快照异常安全 Fail-Closed): PASS (GREEN)
   - 结果：**6/6 GREEN，0 反证漏洞**。

3. **设置页全量行为验收 (`node tests/settings_page_test.mjs && node tests/verify_settings.mjs`)**:
   - 静态检查、真实交互、信标保留、单卡片保存、状态回传等全部通过，残余为 0。

4. **全量自动化测试扫描 (42 套件)**:
   - 结果：**38 PASS，4 SKIP (77, 远端真实网络测试项正常优雅跳过)，0 FAIL**。


---

## 十六、主动查存记忆、一站式检索、安全脱敏与超时兜底报告

# 记忆中枢主动查存、一站式检索、安全脱敏与超时兜底整改检查点报告

## 1. 任务背景与执行环境
- **任务代号**: feat/v6291-proactive-memory-ux
- **执行角色**: Agent 2 (主动记忆与检索增强)
- **沙箱 ID**: `7561fceb4f414daf8565c56d35f12227`
- **沙箱工作路径**: `/workspace/magpie-memory-hub`
- **当前分支**: `feat/v6291-proactive-memory-ux`
- **运行时环境**: Node.js `v24.18.1` (Linux aarch64)

---

## 2. 核心整改清单与落地实现

### 1) 动态嗅探真实工具名 + 意图感知引导 (`memory.middleware.js`)
- **动态工具名嗅探 (`sniffToolNames`)**:
  - 从 `body.tools` / `body.functions` 动态检测符合 `/memory_save$/`, `/pitfall_save$/`, `/memory_context$/`, `/memory_search$/`, `/pitfall_search$/` 的真实工具名，全面兼容客户端前缀（如 `mcp__magpie__...`、`custom_agent_...`）或直接工具名；
  - 嗅探不到时安全回退至标准插件注册名（`magpie-memory-hub_...`）。
- **意图感知引导注入 (`[Memory Agent Guide]`)**:
  - **排障意图** (`/Error:|Exception|Traceback|panic:|ENOENT|ECONN|报错|失败|不生效|踩坑|异常|bug/i`):
    - 注入 `[Memory Agent Guide —— 排障与避坑]`；
    - 强化【先查避坑】（引导主动调用 `pitfall_search` 或 `memory_context`）+【修复必存 pitfall_save】（问题解决后必存踩坑）。
  - **规范意图** (`/记住|以后都|不要再|严禁|禁止|必须用|统一用|默认配置|架构原则|铁律/`):
    - 注入 `[Memory Agent Guide —— 规范与准则沉淀]`；
    - 强化【立即调用 memory_save(category="principle")】持久化规范，并提供一站式召回入口。
  - **首轮与严格模式** (`turnNo <= 1` 或 `extract_strength === "strict"`):
    - 注入完整 `[Memory Agent Guide —— 检索与沉淀]`，包含【优先检索】+【及时沉淀】。
  - **普通软模式**:
    - 注入常规轻量指引，并能被 `cleanText` 彻底清洗，杜绝跨轮次污染。

### 2) 一站式召回入口升级 (`tools.js` - `memory_context`)
- **避坑经验融入**:
  - 检索 `pitfalls` 表，将匹配到的 Top 3 踩坑记录以 `- [pitfall/组件] 症状 → 解法` 格式拼入 `[Persistent Memory Context]`；
- **跨项目准则穿透合并**:
  - 当指定了非 "global" 的 project 时，自动合并当前 project 与 "global" 下的 principle 准则，优先排列当前项目准则，全局准则兜底，彻底杜绝全局规范在子项目中丢失；
- **入口描述更新**:
  - `TOOLS.memory_context.description` 更新为推荐的首选一站式检索入口描述。

### 3) 写入门槛放宽与 `_agent_hint` 闭环引导 (`tools.js`)
- **参数放宽**:
  - `TOOLS.pitfall_save.args.required` 放宽为 `["symptom", "solution"]`；
  - `pitfallSave` 内部对缺失的 `component` 默认设为 `"general"`，缺失的 `root_cause` 默认设为 `symptom`，极大降低 Agent 报错时的记录成本；
- **Schema 瘦身**:
  - 从 `TOOLS.memory_save.args.properties` 中隐藏内部专属参数（`origin`, `source_session`, `source_turn`, `content_fingerprint`），对外 Schema 保持轻量；
- **闭环引导 (`_agent_hint`)**:
  - 在 `memorySearch`、`memoryContext`、`pitfallSearch` 的 JSON 响应中统一追加 `_agent_hint: "若本次任务产出了新结论、配置变更或排障解法，请在结束前调用 memory_save 或 pitfall_save 沉淀。"`。

### 4) 跨项目全局穿透检索支持 (`tools.js`)
- 在 `memorySearch`、`memoryContext`、`pitfallSearch` 中，当 `args.project` 非 "global" 时，支持检索 `project IN (args.project, 'global')`；
- 排序与呈现严格遵守「当前项目专属优先，全局准则/避坑兜底」，既不遗漏全局沉淀，又优先匹配当前项目专属上下文。

### 5) 入库前敏感凭据自动脱敏 (`tools.js` & `gateway_harvest.hooks.js`)
- 实现轻量正则脱敏函数 `scrubSecrets(text)`：
  - 自动过滤 `sk-...` 为 `sk-***REDACTED***`；
  - 自动过滤 `ghp_...`（及 gho/ghu/ghs/ghr）为 `ghp_***REDACTED***`；
  - 自动过滤 `Bearer ...` 为 `Bearer ***REDACTED***`；
  - 自动过滤 `scheme://user:password@host` 数据库连接串密码为 `***REDACTED***`；
  - 自动过滤 key-value 中的 `password / api_key` 等敏感字段；
- 在 `saveMemory`、`pitfallSave` 以及 `enqueueHarvestItems` 入口处执行强制脱敏，确保敏感凭据绝不落库、绝不上报。

### 6) 默认网络超时兜底 (`mcp_client.js` & `ncb_mcp.js` & `tools.js`)
- `ncb_mcp.js` 的 `DEFAULT_TIMEOUT` 调整为 `15000` (15s)；
- `ncb_mcp.js` 与 `tools.js` 的 `fetch` 调用均使用 `signal: effectiveSignal || AbortSignal.timeout(15000)`，彻底杜绝挂死。

---

## 3. 测试与验证实录

### 3.1 专项单测 (`tests/test_proactive_memory_ux.mjs`)
编写并执行了 6 大维度全覆盖的单元测试，包含：
1. `memory.middleware.js` 动态前缀工具名嗅探（`mcp__magpie__...`、`custom_agent_...`）；
2. 排障意图感知、规范原则意图感知、首轮完整引导注入断言；
3. `TOOLS.memory_context.description` 描述校验；
4. `TOOLS.pitfall_save` 放宽参数入库与自动兜底校验；
5. `_agent_hint` 在三大检索接口中的闭环返回校验；
6. `memory_context` 一站式召回（Top 3 避坑经验 + 全局与项目准则合并 + 事实记忆）；
7. `memory_search` 跨项目全局穿透与专属优先排序校验；
8. `scrubSecrets` 正则脱敏在 `memory_save` 与 `pitfall_save` 的入库脱敏校验；
9. `NcbMcp` 15000ms 默认超时与 AbortError 干净中断校验；
10. 测试环境 cleanup 与残余为 0 校验。

**执行结果**: 全部通过（6 大项全部 PASS）。

### 3.2 规范与门禁验证
1. **导出面合规 (`tests/test_exports.mjs`)**:
   - `tools.js` 与 `memory.middleware.js` 导出严格符合白名单，无多余未授权导出，100% PASS。
2. **静态工具名断言 (`tests/test_tool_names_static.mjs`)**:
   - 所有在代码中出现的工具标识符均为已注册工具或合法白名单符号，100% PASS。
3. **架构同步与模式校验 (`tests/check_schema_sync.mjs`, `tests/test_schema.mjs`)**:
   - 表结构声明与代码写入字段严格对齐，100% PASS。
4. **中断与退出安全 (`tests/test_abort.mjs`)**:
   - `ctx.abort` 中断与超时拦截正常，100% PASS。
5. **网关异步采集与流式保真 (`tests/test_gateway_harvest_hooks.mjs`)**:
   - 11 项全功能与逐字节保真测试，100% PASS。
6. **红队靶场门禁 (`tests/adversarial_v629_gate.mjs`)**:
   - 6 大核心缺陷反证靶场全部 GREEN 放行。
7. **测试元规范审查 (`tests/test_meta.mjs`)**:
   - 全库 45 个测试文件静态合规审查，无 DB 泄露、无假过，100% PASS。

---

## 4. 安全合规保证
- 代码库及测试用例中严禁硬编码任何真实密钥或敏感凭据；
- 所有敏感凭据在入库前均经过 `scrubSecrets` 正则脱敏；
- 测试用例使用内存 Mock 桩与隔离命名空间，测试结束后残留确认为 0。


---

## 十七、数据状态机、中文分词Bigram、一站式投影与衰减算法整改报告

# 检查点：v6300 状态机与中文分词检索整改任务

## 角色与分支
- 角色：数据状态机与中文分词检索增强 Agent（沙箱 1）
- 分支：feat/v6300-state-and-retrieval
- 沙箱 ID：aa8f1812331643068673810a570196ea

## 任务拆解与整改完成情况
1. [x] tools.js: termsOf(q) 中文 Bigram 分词与常见疑问虚词剥离（CJK_STOP_BIGRAMS 过滤）
   - 对中文连续串提取 2-gram 并过滤 CJK_STOP_BIGRAMS = new Set(["怎么", "如何", "什么", "为什", "么办", "请问", "帮我", "一下", "这个", "那个"])。
   - 彻底解决无空格自然中文问句（如“端口冲突怎么处理”）召回率为 0 的严重问题。
2. [x] tools.js: memoryContext 精简投影白名单（排除 full_text），接入 rewriteSearchQuery 双路词面扩展打分
   - memoryContext 补齐 columns 精简投影白名单，防止穿透拉取庞大 full_text。
   - 接入 rewriteSearchQuery 双路词面扩展与打分机制，大幅提升上下文召回语义覆盖度。
3. [x] tools.js & gateway_harvest.hooks.js: pitfallSave 增加 !r.invalid_at 过滤，接入 Layer ② isSemanticallySimilar 语义比对
   - 杜绝软删除踩坑被复活并卡死。
   - 接入 Layer ② isSemanticallySimilar 语义比对，支持语义相似踩坑去重合并累加。
4. [x] tools.js: memoryAuditUndo 撤销去重按 dupRec 真实值扣减主记录 recurrence，数学守恒
   - 按 dupRec (Number(c.row.recurrence) || 1) 真实累加值扣减主记录 recurrence，确保数学守恒，杜绝主记录计数膨胀。
5. [x] tools.js: memoryAudit 踩坑规则去重放宽 sameComp 限制，支持跨组件语义合并
   - 放宽 sameComp 限制，支持跨组件相同现象或语义相似的踩坑合并软失效。
6. [x] memory.middleware.js: 艾宾浩斯衰减 retention 修复短路：Math.max(tUsed, tUpd)
   - retention 修复时间戳短路：tUsed 与 tUpd 取 Math.max(tUsed, tUpd)，使检索命中后更新的 last_used_at 真实参与衰减加权。
7. [x] settings.js: sync_snapshot 回写设置 next.memories_version = Date.now()，配合 O(1) 索引快速缓存
   - sync_snapshot 收到快照结果后回写 next.memories_version = Date.now()，配合中间件实现 O(1) 索引快速缓存。
8. [x] tools.js: fetchAll 支持 max_pages 参数（默认 5，上限 20），消除穿透查询 RPC 放大
   - 支持 max_pages 控制拉取上限（默认 5 页，上限 20 页），防止穿透查询时的串行 RPC 放大。
9. [x] gateway_harvest.js: 离线扫描增加 < 60 字符短路与 classifyDialogueWithOnlineModel 前置分类过滤
   - 增加 < 60 字符短路与 classifyDialogueWithOnlineModel 前置分类过滤，防止打满模型预算。
10. [x] 加塞紧急修复：SCAFFOLDING_PATTERNS 补充上下文/提示词剥离，调整超时上限（提炼 30s，分类 15s），防 499 客户端取消异常
   - SCAFFOLDING_PATTERNS 增加 [Persistent Memory Context]、[Memory Agent Guide]、[Memory Context]、--- Context from the delegating agent --- 清洗规则；
   - harvestWithOnlineModel 默认超时放宽至 30000ms；classifyDialogueWithOnlineModel 默认超时放宽至 15000ms；
   - test_denoise_p0.mjs 补全相应剥离断言。

## 验证结论
- tests/test_v6300_state_and_retrieval.mjs: 100% 通过
- tests/test_auto_dedup_and_undo.mjs: 100% 通过
- tests/test_search_enhancement_and_scale.mjs: 100% 通过
- tests/test_denoise_p0.mjs: 100% 通过
- tests/test_gateway_harvest.mjs: 100% 通过
- tests/test_gateway_harvest_hooks.mjs: 100% 通过
- tests/test_dedup_and_audit.mjs: 100% 通过
- 全流程隔离环境零残留断言通过。


---

## 十八、安全防御、租户隔离与凭据脱敏整改报告

# feat(v6300): 安全防御、租户隔离与凭据脱敏整改检查点记录

## 1. 整改背景与目标
沙箱 ID: 59a254a04c78437ba68a29425d474b87
分支: feat/v6300-security-and-isolation
目标: 针对 Magpie 记忆中枢系统的安全边界、租户隔离、凭据脱敏与状态保护进行全面加固，杜绝密钥泄露、租户数据混淆、跨库清空与异常状态抹平。

## 2. 核心整改任务清单与执行规划

### 任务 1: tools.js & gateway_harvest.hooks.js: scrubSecrets 正则脱敏库全量扩充
- [x] AWS Access Key 过滤: \b(AKIA|ASIA)[0-9A-Z]{16}\b -> ***REDACTED***
- [x] Slack/Discord Bot Token: \b(xox[baprs]-)[0-9A-Za-z-]{10,}\b -> $1***REDACTED***
- [x] 长 JWT (三段式): \beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b -> ***REDACTED***
- [x] 数据库连接串密码脱敏: [a-z]+:\/\/[^:\s]+:[^@\s]+@[^\s]+ -> scheme://user:***REDACTED***@host
- [x] 中文口令描述脱敏: /(密码|密钥|口令|token|secret|apikey|api_key)\s*[是为:：=]\s*['"]?([^\s'"]{8,})['"]?/gi -> $1=***REDACTED***
- [x] 保持 tools.js 与 gateway_harvest.hooks.js 脱敏逻辑一致。

### 任务 2: local_state.js: readState() 损坏自愈与防抹平保护
- [x] readState() 损坏容灾：JSON 解析失败或损坏时，严禁写入空 {} 抹平历史状态（防止丢失 secret key 缓存与游标）。
- [x] 损坏文件重命名备份为 state.json.corrupt.<timestamp>，并尝试加载 state.json.bak 备份。
- [x] writeState 备份机制：在原子写入成功前保留 state.json.bak。若传入损坏状态 (_ok === false || _corrupt === true) 禁止落盘。

### 任务 3: db_tools.js: db_reset 目标数据库强制保护
- [x] 强校验 args.database === (cfg.instance || cfg.ncb_instance)，拒绝清空外来数据库或系统表。
- [x] 违规请求抛出 FORBIDDEN_DATABASE 错误并中止。

### 任务 4: gateway_harvest.js: harvest_gateway 路径穿越与越界遍历防护
- [x] 强校验 dir 参数：禁止遍历 / 或 /root 等系统根路径与敏感系统目录，解析绝对路径确保在安全目录内。
- [x] 限制目录递归最大深度为 3。
- [x] 单文件体积上限限制为 10MB。

### 任务 5: tools.js: memorySave: 修复 confidence_score 值为 0 时的 JS 短路 Bug
- [x] 修正 confidence || 1 短路判断，支持 0 分置信度合法存储：typeof args.confidence === "number" ? args.confidence : 1。

### 任务 6: mcp_client.js: makeMcpClient 冷启动自动库名前缀解析缓存
- [x] 在仅提供逻辑库名时，冷启动自动调用前缀解析，将账号前缀（如 41694_xxx）解析并缓存至 local_state。

### 任务 7: page_actions.js: sync_snapshot 在有 project 上下文时支持按 project + global 过滤
- [x] sync_snapshot 读取记忆快照时，根据 project 上下文按 project + global 过滤，专属项目优先，杜绝跨项目混淆。

## 3. 验收标准与测试执行结果
- 新增验收测试套件 `tests/test_v6300_security_and_isolation.mjs`，包含 7 大核心整改项专项测试，100% 通过。
- 历史核心回归测试全量通过：
  - `tests/test_exports.mjs`: 导出面白名单合规性复核通过。
  - `tests/test_proactive_memory_ux.mjs`: 主动记忆查存与脱敏验收全部通过。
  - `tests/test_secret_stale_eviction.mjs`: 失效密钥清理与反证测试全部通过。
  - `tests/test_sql_escape.mjs`: SQL 转义与注入对抗全部通过。
  - `tests/test_gateway_harvest.mjs`: 录制扫描与增量提炼全部通过。
  - `tests/test_gateway_harvest_hooks.mjs`: 异步请求钩子 11 项严谨性测试全部通过。
  - `tests/test_state_bloat_and_dead_letter.mjs`: 状态膨胀与死信淘汰全部通过。
  - `tests/adversarial_v629_gate.mjs`: 红队 6 大靶场门禁 100% 放行 (GREEN)。
  - `tests/test_failopen.mjs`: 畸形输入 fail-open 保护全部通过。
  - `tests/test_denoise_p0.mjs`: 去噪门禁与生命周期测试全部通过。
  - `tests/test_multi_protocol.mjs`: 多协议流式剥离与保真测试全部通过。
- 零敏感凭据输出到控制台与日志。
- 代码无破坏性回归。


---

## 十九、v6.30.0 里程碑红队对抗门禁与发版集成报告

# NOTES_v6300_qa_and_docs.md
# v6.30.0 里程碑红队门禁与发版集成检查点记录

## 1. 角色与任务定位
- 角色：红队门禁与 v6.30.0 里程碑发版套件 Agent（沙箱 3）
- 沙箱 ID：832efdf46c8b46a6891eea0a42afeb6d
- 当前分支：feat/v6300-qa-and-docs
- 上游特性分支：
  - Agent 1: `feat/v6300-state-and-retrieval` (沙箱 aa8f1812331643068673810a570196ea)
  - Agent 2: `feat/v6300-security-and-isolation` (沙箱 59a254a04c78437ba68a29425d474b87)

## 2. 红队对抗靶场套件规划 (tests/test_v6300_milestone_gate.mjs)
覆盖 7 大核心反证靶场：
1. **靶子 1 (中文无空格自然问句检索)**:
   - 输入 query: "端口冲突怎么处理"
   - 目标命中: 标题为 "Nginx 端口冲突解决方案" 的记忆
   - 验证点: Bigram 双字切词与常见中文疑问虚词剥离生效，杜绝中文问句零召回。
2. **靶子 2 (软失效踩坑防死循环复活)**:
   - 目标: 验证已标记 invalid_at 的踩坑记录绝不能被 pitfall_save 命中为 NOOP 且不清除 invalid_at。
   - 验证点: 软失效记录在语义比对与复发累加时必须被排除或正确复活，杜绝死循环卡死。
3. **靶子 3 (memoryAuditUndo 复发计数数学守恒)**:
   - 构造: 合并副本 recurrence=3
   - 验证点: 撤销去重后主记录 recurrence 必须准确扣减 3，而不是只扣减 1，保持数学守恒。
4. **靶子 4 (scrubSecrets 全格式脱敏靶场)**:
   - 构造包含:
     - AWS Access Key (AKIA...)
     - 长 JWT (eyJ...)
     - Slack Token (xoxb-...)
     - Postgres 连接串明文密码 (postgres://user:password@host/db)
   - 验证点: 100% 替换为 ***REDACTED***，杜绝任何敏感凭据落库。
5. **靶子 5 (db_reset 越权跨库防御靶场)**:
   - 传入非当前配置的目标数据库名 (如 rogue_database)
   - 验证点: 必须抛错拦截，拒绝越权跨库破坏。
6. **靶子 6 (harvest_gateway 根目录路径穿越拦截)**:
   - 传入 dir: "/" 或 dir: "/etc"
   - 验证点: 必须安全拦截抛错，禁止遍历根路径与敏感系统路径。
7. **靶子 7 (state.json 损坏自愈靶场)**:
   - 故意写入非法 JSON 损坏 state.json
   - 验证点: readState() 绝不能抹平为空对象 {}，必须生成 .corrupt 备份并尝试从 .bak 恢复。

## 3. 规范遵从与发版计划
- 更新 tests/test_meta.mjs: 活跃测试总数断言由 43 升级为 44。
- 监听并汇聚 Agent 1 (`feat/v6300-state-and-retrieval`) 与 Agent 2 (`feat/v6300-security-and-isolation`)。
- 全量回归测试：全库 44 个单测与红队反证套件 100% GREEN。
- 版本升级：package.json、settings.html、README.md 同步升级至 v6.30.0。
- 最终 commit 并 push origin feat/v6300-qa-and-docs。


---

## 二十、v6.31.0 tools.js 核心逻辑整改（导出面/Proxy/读时间戳/改写/条数上限/准则保护/审计解耦/脱敏收敛）

# Agent A 检查点：tools.js 核心逻辑整改 (v6.3.1)

## 任务背景
在分支 `feat/v631-a-tools` 上，独占修改 `tools.js` 完成 7 项整改，并新建专项测试 `tests/test_v631_a_tools.mjs`，确保全量测试通过并提交推送。

## 7 项核心整改项完成状态

1. **P0-1 导出面与 Proxy 安全 (tools.js)** [已完成]
   - `makeNoCredentialsClient`: Proxy 白名单只拦截 `list` / `create` / `update` / `remove` / `raw`，其余属性安全返回 `undefined`。保留 `_isNoCredentials: true` 与 `then: undefined`（防 Promise 同化）。
   - 所有非入口导出函数 (`fetchAll`, `termsOf`, `getDedupTimeWindow`, `isDedupDue`, `memoryAudit`, `memoryAuditUndo`, `makeClient`) 在入口处增加宿主探针守卫：若首个参数是宿主对象（无 `list` 函数且不是合法 cfg 形状），安全返回空值或安全响应，绝不抛错。

2. **P1-1 memoryGet 读操作零时间戳篡改 (tools.js)** [已完成]
   - 删除 memoryGet update 载荷中的 `updated_at: nowSql()`，仅保留 `retrieval_count` 与 `last_used_at`。

3. **P1-2 pitfallSearch 接入 query 改写 (tools.js)** [已完成]
   - 对齐 memorySearch：调用 `rewriteSearchQuery` 进行双路打分 (`origHit + rewriteHit`)，返回体增加 `rewrite_used` 与 `query_rewritten` 字段，严格 fail-open。

4. **P1-3 memoryContext 统一条数上限 (tools.js)** [已完成]
   - 准则 (principles)、踩坑 (pitfalls)、记忆 (memories) 三段循环统一共用计数器 `n`，每段循环开头 `if (n >= maxItems) break;`，彻底杜绝注入条数超限。

5. **P1-4 principle 准则保护 (tools.js)** [已完成]
   - `saveMemory`: `category === principle` 豁免「踩坑优先软失效」逻辑（不能被 pitfalls 表覆盖失效）。
   - `pitfallSave`: 跨表软失效 memories 时排除 `category === principle` 的记录。

6. **P1-5 memoryAudit 解耦「DB 拉取批」与「模型分块」(tools.js)** [已完成]
   - 新增 `dbFetchLimit`（默认 200，上限 1000，取自 `args.fetch_limit || cfg.dedup_fetch_limit`）。
   - 内存级全量规则去重（指纹相同 / 归一化标题相同 / tags 交集）覆盖整批拉取的记录。
   - 仅将规则筛出的候选组提交给 `auditMemoriesWithModel`（模型分块 40 条已由 online_models 处理）。
   - 独立模型仲裁预算：`maxModelBatches`（默认 2 = 最多 2 次分块调用），超出部分仅用规则结果 fail-open。
   - cursor 按 `dbFetchLimit` 推进，返回体保留 `has_more` / `next_action`。
   - 注释注明单次调用最坏耗时估算：2 次模型调用 × 15s = 30s < 55s。

7. **P2-1a 脱敏收敛 (tools.js)** [已完成]
   - 移除 `tools.js` 内本地 `scrubSecrets` 实现，统一为 `import { scrubSecrets } from ./scrub.js;`。

## 验收检查
- [x] 编写 `tests/test_v631_a_tools.mjs` 覆盖全部 7 项整改及反证测试
- [x] 跑通全量指定测试用例：
  - `node tests/test_meta.mjs` (47/47 通过)
  - `node tests/test_exports.mjs` (100% 通过)
  - `node tests/test_proactive_memory_ux.mjs` (100% 通过)
  - `node tests/test_dedup_and_audit.mjs` (100% 通过)
  - `node tests/test_auto_dedup_and_undo.mjs` (100% 通过)
  - `node tests/test_model_ux.mjs` (100% 通过)
  - `node tests/test_v631_a_tools.mjs` (100% 通过)
- [x] 检查代码零密钥泄露
- [x] git commit & git push origin feat/v631-a-tools


---

## 二十一、v6.31.0 采集与中间件整改（路径穿越/库名归一化/信标补参/turnNo/可选模型判空/清库清状态）

# feat(v631-b-harvest): Agent B 采集与中间件整改检查点记录

## 1. 任务背景与目标
- 沙箱 ID: 1a11e38a23f94cdbb38cbca019ce0d00
- 目标分支: feat/v631-b-harvest
- 负责范围: 独占负责采集 (gateway_harvest) 与中间件 (memory.middleware) 等相关整改
- 严格文件所有权:
  - 独占修改 5 个代码文件:
    1. gateway_harvest.js
    2. gateway_harvest.hooks.js
    3. db_tools.js
    4. memory.middleware.js
    5. page_actions.js
  - 新增 1 个专项测试文件:
    - tests/test_v631_b_harvest.mjs
  - 本检查点文档:
    - NOTES_v631_b.md
  - 严禁修改其他 Agent 负责文件 (tools.js / local_state.js / semantic_dedup.js / mcp_client.js / ncb_mcp.js / r2.js / online_models.js / settings.js / 其他 tests)

## 2. 7 项核心整改任务完成清单

### [P0-2] 路径穿越加固 (gateway_harvest.js:90-122、219-252)
- [x] validateGatewayDir 路径加固:
  - 拦截任何含 ".." 相对段的路径 (split 分段检测，杜绝路径穿越)
  - 敏感目录前缀匹配过滤: 覆盖 /root、/var、/etc、/proc、/sys、/dev、/boot、/bin、/sbin、/usr、/lib、/lib64、/home，以及 ~/.magpie-memory-hub（状态目录）
  - 使用 fs.realpathSync 解出真实路径后再校验，防软链接越界绕过（损坏/不可解析软链接抛出 SECURITY_BLOCKED 拒绝）
  - 对尚未创建的合法测试路径，递归向上校验其真实祖先目录
- [x] collectConversationFiles 遍历保护:
  - 递归遍历扫描时跳过 ent.isSymbolicLink() 条目，严禁跟随软链接扫描外部非授权文件
  - 导出 collectConversationFiles 供外部测试复核

### [P0-3] dbReset 库名归一化 (db_tools.js:199-211)
- [x] 新增 isSameDatabaseTarget(a, b): 剥离数字前缀后比对（如 "memory" 与 "41694_memory" 归一化后一致视为同一库）
- [x] 修复设置页传逻辑名被误杀的问题，只有归一化后仍不同才拒绝并抛出 FORBIDDEN_DATABASE

### [P0-4] harvest_gateway 信标补全参数 (page_actions.js:272-295)
- [x] 补齐传参: harvestGateway 接收 `{ _cfg: cfg, _client: client, saveMemory, pitfallSave }`
- [x] saveMemory 与 pitfallSave 动态 import 绑定: 通过 MagpieMemoryHub(cfg, safeOpts) 闭包内单次构建获取工具执行句柄，剔除 _action 信标避免递归触发
- [x] 彻底解决设置页触发扫描时因缺少存储回调导致 0 入库的问题

### [P1-6] turnNo 真实轮次 + 快照项目隔离 (memory.middleware.js:161-211、632、815)
- [x] turnNo 真实轮次: 新增 countUserTurns 统计本次请求 messages 数组中 role === "user" 的条数（兜底兼容 contents / input，至少 1 轮），彻底纠正之前每次请求重置为 1 的缺陷
- [x] 快照项目隔离: buildIndex 索引构建与 principle 置顶统一根据 opts.project 过滤，只允许 row.project === currentProject 或 row.project === "global"，彻底杜绝跨项目租户记忆串扰

### [P1-7] testModelConnectivity 可选模型留空 (gateway_harvest.hooks.js:1616-1626)
- [x] classify_model 留空/禁用时，testClassificationModel 与 testModelConnectivity 标记 `{ skipped: true, ok: true }`
- [x] 整体 ok 只由实际已配置的模型运行结果决定，不得因可选模型为空判整体失败

### [P2-1b] 脱敏收敛 (gateway_harvest.hooks.js:64-97)
- [x] 移除本地重复冗余的 scrubSecrets 正则实现，统一由 `./scrub.js` 导入
- [x] 保留 `export { scrubSecrets }` 确保向前兼容

### [P2-5b] dbReset 后清理本地状态 (db_tools.js:230-245)
- [x] dbReset 执行成功后精准清理本地状态: 调用 `clearAuditCursor(project)`，并将 `harvest_queue` 置空 (`[]`)、`pending_patterns` 置空 (`{}`)
- [x] 严禁整体抹平 state，完整保留 secrets / actions / mounts 等持久化配置

## 3. 验收与回归测试结果

- 新建验收测试 `tests/test_v631_b_harvest.mjs`:
  - 覆盖全部 7 项整改及反证门禁测试 (含旧实现漏洞反例)
  - 严格遵守 test_meta 规范: 命名空间隔离、强制 cleanup()、countAllTestResidue 校验 residue.total === 0、scanTestFile 自身元检查 0 违规
  - 运行结果: 100% 通过 (ALL PASS)

- 核心全量回归测试全绿通过:
  1. `node tests/test_gateway_harvest.mjs` -> PASS
  2. `node tests/test_gateway_harvest_hooks.mjs` -> PASS
  3. `node tests/test_multi_protocol.mjs` -> PASS (27 项深度断言)
  4. `node tests/test_denoise_p0.mjs` -> PASS (P0/P1/P2 去噪门禁)
  5. `node tests/test_v6300_security_and_isolation.mjs` -> PASS (7 项安全整改)
  6. `node tests/settings_page_test.mjs` -> PASS (设置页全流程)
  7. `node tests/verify_settings.mjs` -> PASS (设置页行为验收)
  8. `node tests/test_v631_b_harvest.mjs` -> PASS (本专项 7 项整改)
  9. `node tests/test_exports.mjs` -> PASS (导出面白名单合规)


---

## 二十二、v6.31.0 运行时与测试卫生（状态健壮性/编辑距离/编号实体/SQL OFFSET/握手互斥/R2兜底/定时器）

# Agent C: 运行时与测试卫生整改检查点 (v6.3.1)

## 任务目标与文件所有权
严格限定修改文件：
- local_state.js
- semantic_dedup.js
- mcp_client.js
- ncb_mcp.js
- r2.js
- online_models.js
- settings.js
- tests/test_model_ux.mjs
- tests/test_v6300_security_and_isolation.mjs
- tests/test_v631_c_runtime.mjs (新增)
- tests/*.py (清理)

严禁触碰：tools.js / gateway_harvest*.js / db_tools.js / page_actions.js / memory.middleware.js

## 整改项目状态跟踪
- [ ] 1. P2-2 local_state.js 状态健壮性
  - [ ] statePath 优先 MEMHUB_STATE_DIR
  - [ ] 抽公共函数 _recoverCorruptStateFile()：同步写 .corrupt.<ts> 备份，加载 .bak，禁止回写空 {}
  - [ ] forgetR2Mount 补更新 _status.js (或状态字段)
  - [ ] recordPendingEvidence 补齐 pitfall 语义去重 (isSemanticallySimilar)
- [ ] 2. P2-3 semantic_dedup.js 性能与误判
  - [ ] levenshteinDistance 双行滚动数组 (O(min(M,N)) 空间)，512 字符截断
  - [ ] isAlphaTokenMatch: 纯数字严格相等 (===)，含字母才允许 includes (防 80 vs 8080 误判)
- [ ] 3. P2-4 mcp_client.js / ncb_mcp.js
  - [ ] buildSelect OFFSET 使用截断后的 effectiveLimit 计算
  - [ ] create 回查分流：pitfalls 表使用 symptom 列回查
  - [ ] ncb_mcp.initialize() 缓存 this._initPromise 实现并发互斥
- [ ] 4. P2-5a r2.js 凭据兜底
  - [ ] restClient 与 r2Upload 在 cfg 无 secret 时回退 lookupSecret(db)
- [ ] 5. P2-6b online_models.js / settings.js
  - [ ] auditMemoriesWithModel 删除外层悬挂 setTimeout/clearTimeout
  - [ ] rerankSearchResultsWithModel 优先级修正为: rerank_model || audit_model || extract_model || harvest_model
  - [ ] settings.js: pollingTimer / countdownTimer 改为按 cardKey 独立 Map 存储
- [ ] 6. P0-5a 修复 tests/test_model_ux.mjs:395 (Bigram 命中 >= 1)
- [ ] 7. P0-5b 清理 tests/ 下硬编码 .py 脚本 (git rm)
- [ ] 8. 新增 tests/test_v631_c_runtime.mjs，跑通全量测试套件
