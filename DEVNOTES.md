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
