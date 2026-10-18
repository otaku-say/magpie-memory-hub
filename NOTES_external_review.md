# 外部大模型分析清单逐条核实与整改报告 (NOTES_external_review.md)

## 0. 审计背景与执行纪律

本次审计针对外部大模型分析清单（`/var/minis/attachments/uploads/Pasted_2026-10-18T12-26-31Z.txt`，共 24 项：P0×5 / P1×13 / P2×4 / P3×2）对 `magpie-memory-hub` 进行**逐条实地走读 + 代码确凿证据核实 + 判定 + 整改方案制定**。

### 执行原则与硬约束门禁：
1. **绝不改写历史消息前缀**：保 KV-Cache，任何改写历史消息前缀的做法坚决禁止；
2. **绝不碰 system prompt 热区**：注入只能落在最后一条用户消息；
3. **注入路径（moejs 中间件）不能有任何 I/O 或模型调用**：无网络、250ms 硬限额；
4. **显式保存（`memory_save`/`pitfall_save`）必须直达数据库，绝不挂模型**；
5. **模型名必须可配置，禁止硬编码**；
6. **`fail-open` 的正确含义是「跳过」，不是「换一套规则继续跑」**；
7. **不许为了变绿而弱化断言**。

### 并行施工协同状态：
- 开工 `git status` 探测显示，另一个并行代理正在工作区积极修复「模型调用失控放大」（事故消耗 155229 次调用），引入了 `model_budget.js` 并正在调试 `tests/test_call_storm_fix.mjs`，工作区存在未提交代码改动（`gateway_harvest.hooks.js`、`package.json`、`tools.js`、`settings.html` 等）。
- **协同纪律遵循**：
  1. 坚决**不修改现有源码文件**，避免代码冲突踩踏与覆盖未完成的自激风暴修复；
  2. 涉及「模型调用/额度/限流」的条目（#6、#7、#8 及 #9、#10 的 hooks 部分）**只标注、给出整改方案与契约，不实现**，由主调度统一合流；
  3. 版本号暂不提升至 `6.21.0`（避免与并行代理当前的 `6.20.0` 冲突），完整方案先落盘本检查点 `NOTES_external_review.md`。

---

## 一、24 项清单逐条核实表

| # | 严重度 | 外部清单原文摘要 | 仓库代码确凿证据 (文件:行) | 判定 | 理由与硬约束审查 |
|---|---|---|---|---|---|
| 1 | P0 | 记忆写入数据库后从未同步到 `options.memories`，导致中间件注入链路在生产环境永久空转 | `memory.middleware.js:596`<br>`tools.js:449-478`<br>`gateway_harvest.hooks.js:1165-1230`<br>`harvest.py:1826, 1870-1875` | **部分成立** | **现象存在**：`memory.middleware.js` 确实只读 `options.memories` 快照，而 JS 宿主写入 NCB 后没有热通道同步 Goja 中间件。<br>**但改法不可行**：外部建议在每次 `saveMemory` 后调 `magpie plugin options` 写回，在生产环境会触发 Magpie 频繁重载/重启，且 Docker/distroless 镜像无 `magpie` CLI；违反系统稳定性。需通过受控 cron / 设置页离线同步。 |
| 2 | P0 | 默认开启的 `compressBody` 原地改写历史消息前缀，破坏 KV-Cache | `memory.middleware.js:582-593`<br>`compress.js:734, 756`<br>`package.json:60` | **成立** | **确凿存在**：`package.json` 默认 `"compress": true`，`compress.js:746` 原地改写 `body.messages[i].content`，加上墙钟中断，严重击穿上游 KV-Cache，直接违反硬约束 #1。必须默认置为 `false`。 |
| 3 | P0 | `lookupR2Mount` 中 `target` 变量作用域错误抛 `ReferenceError` | `local_state.js:301-311` | **成立** | **确凿存在**：`const target = norm(want);` 声明在 `if (want)` 块内，却在块外第 310 行 `norm(names[0]) === target` 被引用。当 `r2_mounts` 仅有 1 个记录且查询不同库名时，100% 抛 `ReferenceError: target is not defined` 导致服务崩溃。 |
| 4 | P0 | 逻辑库名未解析为真实带前缀库名（`lookupRealDatabase`）导致 403 | `tools.js:83`<br>`gateway_harvest.hooks.js:1134`<br>`mcp_client.js:162` | **成立** | **确凿存在**：默认 `ncb_instance: "memory"`，代码均未调用 `lookupRealDatabase(rawInst)`，导致向 NCB REST API 发起请求时无 `<uid>_` 前缀，触发 403 `Invalid secret_key`。 |
| 5 | P0 | 设置页「立即扫描对话录制」按钮对应的 `harvest_gateway` 信标漏注册且单测弱化断言掩盖 | `page_actions.js:51-62, 283-288`<br>`settings.js:1173`<br>`tests/test_beacon_e2e.mjs:40` | **成立** | **确凿存在**：`page_actions.js` 的 `OPS`、`execute`、`CARD_OF_OP` 均无 `harvest_gateway`，点击按钮 100% 静默丢弃并超时 60s；单测把该信标塞进 `deprecatedOps` 弱化断言伪造全绿，违反硬约束 #7。 |
| 6 | P1 | `testClassificationModel` 在 `auto` 模式下双端点 HTTP 报错仍返回 `ok: true`（假阳性） | `gateway_harvest.hooks.js:639, 1450-1466` | **成立 (标注项)** | **确凿存在**：双端点失败返回 `reason: "classify_all_failed"`，`testClassificationModel` 仅拦截了 `exception` 和 `http_`，穿透返回 `ok: true` 欺骗用户。<br>*(涉及模型调用/检测，标注交由并行代理统一合流)* |
| 7 | P1 | `classifyDialogueWithOnlineModel` 在 `auto` 模式下 `/v1/systemone` 抛网络异常未回退 `/v1/chat/completions` | `gateway_harvest.hooks.js:520-550, 615-635` | **成立 (标注项)** | **确凿存在**：`callSystemOne` 未用 `try/catch` 捕获 `doFetch`，网络超时或断连异常直接跳出到最外层 `catch`，降级逻辑从未走到 `callChat()`。<br>*(涉及模型调用，标注交由并行代理统一合流)* |
| 8 | P1 | 聊天判定分支 `callChat` 用 `includes("YES")` 做子串匹配且空串/异常静默当 `score: 0.0` | `gateway_harvest.hooks.js:573-575` | **成立 (标注项)** | **确凿存在**：空输出或未预期文本被静默置为 `score: 0.0`，进而导致 `shouldHarvest: false` 拦截提炼，直接违反硬约束 #6（异常必须 `fail-open` 放行）。<br>*(涉及模型调用，标注交由并行代理统一合流)* |
| 9 | P1 | 自动提炼管线 4 处数据过滤与状态错误（`min_confidence` 未生效、类别被强行压成 3 类、避坑指纹 key 不一致、后台队列排水返回值被覆写为 0） | `tools.js:104`<br>`gateway_harvest.hooks.js:740, 897, 1005-1009`<br>`gateway_harvest.js:530, 564` | **成立** | **确凿存在**：① `minConfidence` 声明后全仓未用；② 强行将 `principle`/`context`/`entity` 压成 `fact`；③ memories 证据 key 漏传 `project`；④ 并发排水返回 `inProgress` 时已入队计数被覆写为 0。<br>*(hooks 部分由并行代理合流)* |
| 10 | P1 | `triggerBackgroundDrain` 仅拉取前 50 条记忆做去重且缺失 `superseded` 版本演进逻辑 | `gateway_harvest.hooks.js:1189-1230` | **成立 (标注项)** | **确凿存在**：`limit: 50` 偏小且未过滤 `lifecycle_status: "active"`；同标题内容更新时直接裸插 `revision: 1`，导致同标题多条 active 冲突记忆。<br>*(hooks 部分由并行代理合流)* |
| 11 | P1 | `saveMemory` 演进同标题旧记忆时只更新了 `superseded[0]` | `tools.js:466-476`<br>`harvest.py:1109` | **成立** | **确凿存在**：`superseded` 筛选出的所有旧活动记录仅取了 `superseded[0].id` 标记，`superseded[1..n]` 永远残留为 `active`。应循环批量更新。 |
| 12 | P1 | 离线扫描 `harvestGateway` 在中断或 502 时仍把整个 `.jsonl` 写入 `updatedFileStates` | `gateway_harvest.js:432, 619-627` | **成立** | **确凿存在**：`turn` 循环触发 `aborted` 跳出后，紧接着在第 619 行将该文件记入 `updatedFileStates`，导致下次增量扫描因 `mtimeMs/size` 一致而永久跳过剩余轮次。 |
| 13 | P1 | `expires_at` 与 `invalid_at` 在检索、列表、上下文与中间件中未过滤 | `tools.js:500-524, 595-605, 625-635, 740-754`<br>`memory.middleware.js:80-86` | **成立** | **确凿存在**：会话级（7天）与轮次级（1天）记忆虽写入 `expires_at`，但在搜索与中间件注入中均未校验过期；`pitfallSearch` 亦未过滤软失效的 `invalid_at`。 |
| 14 | P1 | `gateway_harvest.js` 定义了 `stripScaffolding` 却漏调用；`gateway_harvest.hooks.js` 重复定义 | `gateway_harvest.js:61, 274`<br>`gateway_harvest.hooks.js:49-68` | **成立** | **确凿存在**：`extractDialogueText` 返回前未经过 `stripScaffolding`，网关脚手架标签污染提炼模型；hooks 模块完全重复复制代码。 |
| 15 | P1 | 中间件直接用 `Date.parse` 解析非 ISO 格式 SQL 时间戳且缓存命中未重新校验 `isValid` | `memory.middleware.js:83, 98, 140, 624` | **成立** | **确凿存在**：`Date.parse("YYYY-MM-DD HH:MM:SS")` 无 `T/Z`，在严格 ES5/Goja 引擎返回 `NaN`；`_cache` 命中时不重新校验 `isValid(m, now)` 导致缓存期到期的记忆继续注入。 |
| 16 | P1 | `_status.json` 路径基准不一致（`process.cwd()` vs `import.meta.url`）且未校验所属数据库 | `local_state.js:336`<br>`r2.js:362, 365`<br>`page_actions.js:39-40` | **成立** | **确凿存在**：`process.cwd()` 在网关运行时为网关目录而非插件目录，导致读写错文件；`r2.js:365` 兜底恢复未校验 `database` 是否匹配，将库 A 的 R2 挂载状态误判给库 B。 |
| 17 | P1 | 假测试：`test_backend_acceptance.mjs` 把路径对象传到了第 3 个参数 `opHint` 位置，掩盖 `page_actions.js:591` 崩溃 Bug | `tests/test_backend_acceptance.mjs:159`<br>`page_actions.js:591-596` | **成立** | **确凿存在**：参数传错位置导致 `customStatusPath` 为空，测试写往默认目录恒绿；且 `jsPath.replace` 在 `try` 块外，传入对象时直接抛 `TypeError` 崩溃。 |
| 18 | P1 | 假测试：`test_hardening.mjs` `<think>` 测试传 `inline_extract: false`；自写 `queuedOptionsSet` 副本 | `tests/test_hardening.mjs:163, 314-360`<br>`memory.middleware.js:1056` | **成立** | **确凿存在**：`inline_extract: false` 时 `stripStream` 根本未执行；`test_hardening.mjs` 自写函数测自己，未加载真实的 `settings.js`。 |
| 19 | P2 | 假测试：`adversarial_verify.mjs` 自写正则测局部变量；`settings_page_test.mjs` 漏检前 417 行 | `tests/adversarial_verify.mjs:11-19`<br>`tests/settings_page_test.mjs:72` | **成立** | **确凿存在**：`adversarial_verify.mjs` 未调用 `cleanText` 而是自写 3 行正则断言；`settings_page_test.mjs` 切片跳过了 `settings.css` 前 417 行的颜色检查。 |
| 20 | P2 | 状态文件原子写使用固定临时文件名 `p + ".tmp"` 并发竞态 | `local_state.js:74`<br>`page_actions.js:96` | **成立** | **确凿存在**：并发写入下，后一个写入的 `renameSync` 会因临时文件已被前一个移走而抛 `ENOENT`，导致状态丢失。应带 `nonce` 随机后缀。 |
| 21 | P2 | 生产代码 `tools.js` 为配合单测硬编码了 `waitWithAbort(15)` | `tools.js:1248`<br>`tests/test_abort.mjs:105` | **成立** | **确凿存在**：生产代码包装器无条件 `setTimeout` 15ms，纯粹迁就单测计时器，应将延迟移入测试桩。 |
| 22 | P2 | `page_actions.js:92` 手写 `p.slice(0, p.lastIndexOf("/"))` 截取目录 | `page_actions.js:92` | **成立** | **确凿存在**：跨平台在 Windows 反斜杠下会截取失败，应统一使用已导入的 `path.dirname(p)`。 |
| 23 | P3 | 死代码与冗余配置（`dedupIdentical`, `CRITICAL_RE`, `rememberAction/lookupAction`, `storagePublicUrl`, `callerAgent`, 重复 `_diag`） | `compress.js:126, 427`<br>`local_state.js:195`<br>`tools.js:91, 1213`<br>`gateway_harvest.js:37` | **成立** | **确凿存在**：多处定义后从未使用的死函数、冗余变量与重复定义的 `_diag`，需做清理与导出复用。 |
| 24 | P3 | 文档与设置页描述与当前架构失配（`extractor_model`、宣称“零云端模型 / 本地规则引擎 / 下载本地小模型”） | `README.md:13, 29, 39, 68`<br>`settings.html:46, 343, 372, 567`<br>`harvest.py:5` | **成立** | **确凿存在**：v6.15.0 已彻底移除本地模型与规则引擎，文档和 UI 仍残留旧文案与旧参数名 `extractor_model`。 |

---

## 二、不成立 / 部分成立条目详细说明与反证证据

### 条目 #1：记忆写入数据库后未同步到 `options.memories`（判定：部分成立）
- **现象分析**：外部清单指出生产环境中间件 `memory.middleware.js` 依赖 `options.memories` 数组做纯同步内存注入，而 JS 宿主写库后从未推回 `options.memories`。该现象**在代码层面确实存在**（`memory.middleware.js:596` 确实只读 `opts.memories`）。
- **为什么外部建议方案不成立**：
  1. **严重违反系统稳定性**：外部建议在 `saveMemory`（`tools.js:478`）和 `triggerBackgroundDrain`（`gateway_harvest.hooks.js:1230`）每次入库成功后调用 `magpie plugin options` 写回配置。然而在 Magpie 网关架构下，调用 `magpie plugin options` 会改写 `plugins.json` 并**直接触发插件进程重启**！如果每次工具调用保存一条记忆、或后台队列每排水一条记忆就重启一次插件，网关将陷入无限重启风暴；
  2. **生产环境物理不可行**：官方 Magpie Docker 镜像（如 distroless 基础镜像）中根本没有全局的 `magpie` CLI 二进制（实测 `which magpie` 返回空），执行子进程调用必抛 `ENOENT` 失败；
  3. **硬约束协同**：中间件当前定位是「高性能零 I/O 辅助注入」，而智能体在复杂场景下主要通过内置的 20 个 MCP 工具（如 `memory_context`、`memory_search`）直连 NCB 数据库按需检索。
- **正确整改结论**：保留 `memory.middleware.js` 内存快照机制，但在没有热更新内存通道的前提下，绝不能在数据写入主链路中调用重载命令；可通过外部受控定时任务或设置页手动信标触发全量快照刷新。

---

## 三、涉及「模型调用/额度/限流」的条目标注清单（交由并行代理统一处理）

由于并行代理正在重构 `gateway_harvest.hooks.js` 与 `model_budget.js` 以彻底根除自激放大事故（15.5万次调用），以下条目与该模块紧密交织，**按指令只做标注与接口契约规范，绝不在本分支单独实现，避免代码踩踏**：

1. **#6：`testClassificationModel` 假阳性修复 (`gateway_harvest.hooks.js:1450`)**
   - **契约要求**：当模型返回 `reason: "classify_all_failed"`、`systemone_cached_fail` 或被限流熔断时，`testClassificationModel` 必须严格返回 `ok: false`，错误信息展示实际 `res.errText` 或熔断提示。
2. **#7：`classifyDialogueWithOnlineModel` 网络超时未降级修复 (`gateway_harvest.hooks.js:520`)**
   - **契约要求**：在 `callSystemOne` 中必须增加 `try/catch` 捕获 `doFetch` 的网络/超时异常，异常时返回 `{ ok: false, status: 0, errText: ... }`，确保 `auto` 模式能平滑进入 `callChat()` 降级分支。
3. **#8：`callChat` YES/NO 判定边界与 `fail-open` 放行 (`gateway_harvest.hooks.js:573`)**
   - **契约要求**：改用词边界正则 `/\bYES\b/i` 与 `/\bNO\b/i`；当模型返回空串或无法解析时，返回 `{ ok: false, reason: "chat_invalid_output" }`，上层严格遵循 `fail-open` 默认放行提炼（`shouldHarvest: true`），但在自检测试中报 `ok: false`。
4. **#9 中的 hooks 类别与计数部分 (`gateway_harvest.hooks.js:740, 1005`)**
   - **契约要求**：提炼类别放行 `CATEGORIES` 全部 7 类（不强压 `fact`）；`triggerBackgroundDrain` 在 `inProgress: true` 时不覆写已入队计数。
5. **#10：`triggerBackgroundDrain` 队列去重与演进 (`gateway_harvest.hooks.js:1189`)**
   - **契约要求**：去重查询上限提升至 200 并指定 `lifecycle_status: "active"`；同标题记忆写入时复用 `tools.js` 的 `superseded` 演进逻辑。

---

## 四、具体整改实施方案（待并行代理合并后统一落地）

### 1. KV-Cache 保护与压缩默认关闭 (#2)
- **文件**：`package.json`、`settings.html`、`memory.middleware.js`
- **改法**：
  - `package.json` 中 `"compress": true` 改为 `"compress": false`；
  - `memory.middleware.js:582` 改为 `if (opts.compress === true)`；
  - `compress.js:734` 移除非确定性的墙钟超时判断，仅保留字符预算；
  - 保证历史消息前缀 100% 字节不变，保全上游 KV-Cache。

### 2. 跨库挂载 ReferenceError 修复 (#3)
- **文件**：`local_state.js:300-311`
- **改法**：
  - 将 `const target = want ? norm(want) : "";` 提升至 `if (want)` 之前；
  - 第 310 行改为 `if (!want && names.length === 1) return mounts[names[0]];`，避免库名不匹配时错误返回库 A 的记录。

### 3. 逻辑库名解析与前缀补齐 (#4)
- **文件**：`tools.js:83`、`mcp_client.js:162`
- **改法**：
  - 在 `tools.js:83` 引入 `lookupRealDatabase`：
    ```javascript
    const rawInst = o.ncb_instance || lookupDatabase() || "41694_agent_memory";
    const instance = lookupRealDatabase(rawInst) || rawInst;
    ```
  - 在 `mcp_client.js:162` 中同样对 `cfg.instance || cfg.ncb_instance` 进行 `lookupRealDatabase` 转换。

### 4. 设置页扫描对话录制信标注册与假测试修复 (#5)
- **文件**：`page_actions.js`、`tests/test_beacon_e2e.mjs`
- **改法**：
  - 在 `page_actions.js` 的 `OPS` 中补齐 `harvest_gateway`；
  - 在 `CARD_OF_OP` 中将 `harvest_gateway` 映射到 `"gateway"` 卡片；
  - 在 `execute()` 中增加 `harvest_gateway` 分支，调用 `harvestGateway`；
  - 从 `tests/test_beacon_e2e.mjs:40` 中彻底移除 `deprecatedOps` 弱化断言。

### 5. 同标题旧记忆全量版本演进 (#11)
- **文件**：`tools.js:466-476`
- **改法**：
  - 将针对 `superseded[0]` 的单条更新改为循环批量更新：
    ```javascript
    if (superseded.length && newId) {
      for (const oldRow of superseded) {
        if (!oldRow || !oldRow.id) continue;
        try {
          await client.update("memories", oldRow.id, {
            lifecycle_status: "superseded",
            superseded_by_id: newId,
            invalid_at: nowSql(),
            invalid_reason: "superseded",
            updated_at: nowSql(),
          });
        } catch (_) {}
      }
      return { action: "UPDATE", id: newId, superseded_id: superseded[0].id, superseded_count: superseded.length, recurrence: initialRecurrence };
    }
    ```

### 6. 离线扫描增量状态漏扫修复 (#12)
- **文件**：`gateway_harvest.js:619-627`
- **改法**：
  - 维护 `let fileComplete = true;`，在内层循环遇到 `aborted` 或模型 502 时置 `fileComplete = false;`；
  - 仅在 `!aborted && fileComplete` 时才写入 `updatedFileStates[filePath]`。

### 7. 过期时间 `expires_at` 与失效 `invalid_at` 过滤 (#13)
- **文件**：`tools.js`、`memory.middleware.js`
- **改法**：
  - `memory.middleware.js:80` `isValid` 增加 `if (m.expires_at && parseTime(m.expires_at) <= now) return false;`；
  - `tools.js` 的 `memorySearch`、`memoryList`、`memoryContext` 过滤 `r.invalid_at` 及已过期的 `r.expires_at`；
  - `pitfallSearch` 增加 `.filter((r) => !r.invalid_at)`。

### 8. 脚手架标签清洗与死代码统一 (#14)
- **文件**：`gateway_harvest.js`
- **改法**：
  - 在 `extractDialogueText` 返回前调用 `stripScaffolding(parts.join("\n"))`；
  - 统一导出 `stripScaffolding` 供 hooks 模块导入。

### 9. 时间戳解析规范化与缓存失效感知 (#15)
- **文件**：`memory.middleware.js`
- **改法**：
  - 增加严格的 SQL 空格时间戳转换辅助函数 `parseTime`；
  - 在 `onRequest` 遍历倒排索引候选桶时，增加 `if (!isValid(m, now)) continue;` 二次校验。

### 10. `_status.json` 路径统一与跨库防串扰 (#16)
- **文件**：`local_state.js`、`r2.js`
- **改法**：
  - 统一使用 `fileURLToPath(new URL("./_status.json", import.meta.url))`；
  - `r2.js:365` 读取状态时严格校验 `o.r2.database === db`。

### 11. 假测试全面重构与严谨断言 (#17, #18, #19)
- **文件**：`tests/test_backend_acceptance.mjs`、`tests/test_hardening.mjs`、`tests/adversarial_verify.mjs`、`tests/settings_page_test.mjs`
- **改法**：
  - `test_backend_acceptance.mjs` 修正为 4 参数调用，并将 `page_actions.js:591` 的路径替换移入 `try` 块内；
  - `test_hardening.mjs` 开启 `inline_extract: true` 并传入包含 `<memory>` 的文本断言精准剥离；加载真实 `settings.js` 验证防抖；
  - `adversarial_verify.mjs` 导入真实的 `memory.middleware.js` 验证清洗；
  - `settings_page_test.mjs` 全量扫描 `settings.css` 全部 450+ 行硬编码颜色。

### 12. 状态文件写入安全 Nonce (#20)
- **文件**：`local_state.js:74`、`page_actions.js:96`
- **改法**：使用 `p + ".tmp." + process.pid + "." + Date.now() + "." + Math.random().toString(36).slice(2, 8)`。

### 13. 生产代码移除人工延迟 (#21)
- **文件**：`tools.js:1228-1251`、`tests/test_abort.mjs`
- **改法**：删除 `waitWithAbort` 及其在 `tools.js` 中的 15ms 休眠；在 `test_abort.mjs` 的 mock client 中加入延迟。

### 14. 目录路径跨平台安全 (#22)
- **文件**：`page_actions.js:92`
- **改法**：统一使用 `path.dirname(p)`。

### 15. 死代码清理与文档架构同步 (#23, #24)
- **文件**：`compress.js`、`local_state.js`、`tools.js`、`README.md`、`settings.html`
- **改法**：清理无用符号；更新 README 与设置页文案，全面修正为当前在线模型架构。
