# v6.32 Track C (State / Dedup / MCP / Budget) Implementation Notes

## 目标与整改清单
本任务负责 Track C（独占文件：local_state.js、semantic_dedup.js、mcp_client.js、ncb_mcp.js、model_budget.js、tests/lib/testenv.mjs、package.json、tests/test_v632_c_state.mjs）。

### 1. [P0-2] 测试状态隔离（双保险）
- **问题**：测试可能污染或抹平宿主机真实 `~/.magpie-memory-hub/state.json`。
- **方案**：
  - `local_state.js`: `statePath()` 检测测试环境（`MAGPIE_TEST === "1"` / `NODE_ENV === "test"` / `MEMHUB_TEST === "1"`）且无显式 `MEMHUB_STATE_DIR` 时，自动重定向到 `os.tmpdir()/memhub-test-state-<pid>` 并递归建目录。
  - `tests/lib/testenv.mjs`: `setup()` 最早阶段生成独立临时目录赋予 `process.env.MEMHUB_STATE_DIR`，在 `cleanup()` 时清理。
  - **反证**：测试运行期间绝不能触碰 `os.homedir()/.magpie-memory-hub`。

### 2. [P1-1] semantic_dedup.js 数字冲突总闸
- **问题**：文本存在不同数字实体（如 Port 80 vs 8080，Node 18 vs 20）时易被语义相似度误判为重复。
- **方案**：
  - 校验 `hasConflictingNumbers` 并确保其在 `isSemanticallySimilar` 最顶层作为第一道守卫（短路返回 false）：`if (hasConflictingNumbers(title1, title2) || hasConflictingNumbers(content1, content2)) return false;`。
  - **反证**：测试 Port 80 vs 8080、Node 18 vs Node 20 必定返回 false，相同数字不误伤。

### 3. [P2-1] mcp_client.js hasMore 基于截断后的 effectiveLimit
- **问题**：`list()` 中计算 `hasMore` 时如果使用未截断的 `limit`，在 limit > 1000 时逻辑出现偏差或恒为 false/true。
- **方案**：
  - `hasMore` 计算必须严格使用 `effectiveLimit`（与 SQL LIMIT / 实际拉取条数一致）。

### 4. [P2-2] ncb_mcp.js rpc() timeoutSig 监听器泄漏修复
- **问题**：`rpc()` 绑定的 timeoutSig abortListener 在请求完成后未注销，造成内存泄漏及 EventEmitter 警告。
- **方案**：
  - 在 `finally` 块中通过 `removeEventListener` 注销 abort 监听。

### 5. [P2-3] local_state.js recordPendingEvidence 补充 memory 类型语义去重
- **问题**：`recordPendingEvidence` 仅对 `pitfall` 做了 `isSemanticallySimilar` 语义去重，`memory` 仍走精确指纹。
- **方案**：
  - 为 `kind === "memory"` 补充基于 `isSemanticallySimilar` 的语义去重分支，受 `minEvidence` 门禁。

### 6. [P2-5] model_budget.js 请求体指纹开销优化与 x-magpie-internal 请求头识别
- **问题**：全量 `JSON.stringify(body)` 开销过大；且未优先识别 `x-magpie-internal: memory-hub` 请求头。
- **方案**：
  - 优先检测 `headers['x-magpie-internal'] === 'memory-hub'`。
  - 指纹计算改为仅截取最后一条 user message 前 N 个字符（如 500 字符），避免全 body 序列化。

### 7. [P2-6] package.json 默认配置声明补齐
- **方案**：
  - 在 package.json 的 `magpie.options` 补齐 `search_rerank`、`dedup_fetch_limit`、`dedup_batch_size`、`harvest_max_per_min`、`harvest_max_total`、`audit_max_batches`、`audit_chunk_size` 的默认值声明。

## 验收计划
1. 新建 `tests/test_v632_c_state.mjs`，包含上述 7 项整改的严格正反测试与反证门。
2. 回归现有核心测试集，确保所有测试全绿。
3. 校验宿主机 `~/.magpie-memory-hub/state.json` 的 mtime 在测试前后完全不变。
4. Git 提交并推送至 `feat/v632-c-state`。
