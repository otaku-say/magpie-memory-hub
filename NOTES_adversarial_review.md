# 对抗式代码审查检查点 (NOTES_adversarial_review.md)

## 状态总览
- 审查目标：透明记忆插件 `/var/minis/workspace/magpie-memory-hub/`
- 当前时间：2026-10-17
- 对抗审查轮次：共 3 轮
- 最终轮次结论：**第 3 轮零发现，代码全面收敛，28 个测试 100% 绿灯！**

---

## 审查轮次与收敛记录

### 第一轮审查（Round 1：全链路扫描与发现）
- **发现 1【静默失效/截断丢失】`tools.js` 中 `fetchAll` 分页假死 & `pitfallSearch` 等未下推 SQL 过滤条件**：
  - `mcp_client.js` 的 `makeMcpClient.list` 返回 `{ data: rows }`，没有返回 `metadata`；而 `fetchAll` 依赖 `res.metadata && res.metadata.hasMore`，当缺少 `metadata` 时直接 `break`，永远只拉取了第 1 页 200 条；
  - `pitfallSearch` 传给 `fetchAll` 的参数是 `{}`（空对象），没有下推 `project`、`component`、`client`；
  - `memorySearch`、`memoryList`、`memoryContext`、`memoryForget` 传给 `fetchAll` 时也没有下推 `project` 等字段。当数据库中总条数超过 200 条时，任何指定了 `project` 的新记录在查询时都会因为被截断在 200 条外而被 Node.js 内存 filter 全部静默抛弃！
- **发现 2【不一致 Bug】`gateway_harvest.js` 与 `harvest.py` 规则不一致**：
  - 故障学习 `mineFailures`：`harvest.py` 规定 `"severity": "high" if etype in ("missing_dependency", "port_conflict") else "medium"`，而 `gateway_harvest.js` 硬编码为 `severity: "medium"`；
  - 工具链规范：`harvest.py` 支持模式 A（先否定后肯定「不要用 X，必须用 Y」）和模式 B（先肯定后否定），产出 tags 为 `environment,toolchain`；而 `gateway_harvest.js` 缺少模式 A，tags 为 `environment,tooling`；
  - 架构决策模式：`harvest.py` 中有模式 B（技术选型采用 X 作为 Y）和模式 C（英文决策 Adopt/Use X instead of Y），而 `gateway_harvest.js` 缺失。
- **发现 3【数据污染/Prompt清洗遗漏】`memory.middleware.js` 中 `cleanText` 漏清洗 strict 模式的 `[Memory Check` 块**：
  - `cleanText` 中只清洗了 `[Memory Instruction]`，漏掉了 strict 模式注入的 `[Memory Check —— 结束本轮回复前必做一次]`。在多轮对话回传时，该指令不会被清洗，被当作用户 prompt 进行分词和检索，严重污染召回。
- **发现 4【测试代码历史遗留 Bug】`verify_download_scenarios.mjs` 与 `verify_full_model.mjs` 引用了不存在的模型文件**：
  - 模型规范 `MODEL_SPEC.files` 实际只有 4 个文件（`model.onnx`, `tokenizer.json`, `vocab.txt`, `config.json`）；
  - 测试中试图读取不存在的 `tokenizer_config.json` 和 `special_tokens_map.json`，导致属性未定义和 `ENOENT` 异常退出。
- **发现 5【测试环境权限隔离假象】`test_beacon.mjs` 的数据库实例与物理隔离拦截**：
  - `test_beacon.mjs` 传入了不存在的 `41694_test` 实例名，导致 `createTestEnv` 启动时 `selfCheck` 抛出 `You do not have access to execute SQL on this database`。

---

### 第二轮审查（Round 2：修复与深入自审）
- **已修复项**：
  1. `mcp_client.js`：返回标准 `metadata: { hasMore: rows.length >= limit, page, limit }`；
  2. `tools.js`：`fetchAll` 兼容支持 `hasMore`（`batch.length >= FETCH_LIMIT`）；`memorySearch`、`memoryList`、`memoryContext`、`pitfallSearch`、`memoryForget` 下推参数；
  3. `memory.middleware.js`：`cleanText` 增加对 `[Memory Check` 块的清洗正则；
  4. `gateway_harvest.hooks.js`：`onRequest` 记录 `ctx.state.requestBody = body;`；
  5. `gateway_harvest.js`：对齐 `severity` 逻辑与工具规范模式 A/B；
  6. `tests/verify_download_scenarios.mjs` 与 `tests/verify_full_model.mjs`：使用真实存在的 `vocab.txt` 和 `config.json` 进行断点续传与防投毒校验；
  7. `tests/test_beacon.mjs`：使用纯内存 mock 隔离，确保绝不触碰真实库、满足零残留和安全红线要求。
- **深入自审发现并修复**：
  - 编写专用对抗性反证测试 `tests/adversarial_verify.mjs`，自审发现了 `gateway_harvest.js` 中模式 A 对“必须统一改用”等连续修饰副词的贪婪匹配缺陷，已修复完善。

---

### 第三轮审查（Round 3：全量验证与收敛）
- **全量测试验证**：
  - 静态语法检查：全库 JS 文件与测试文件全部通过；
  - `node tests/test_meta.mjs`：扫描全部 28 个测试，规范合规性与反证门全部 PASS；
  - 全量测试套件执行：28 个测试文件全部 PASSED，无一失败；
  - 数据库零残留断言：全部写库测试结束后全局 `__test__` 残留行数均为 0；
  - 版本号与 Schema 检查：严格对齐为 v6.10.0；
- **本轮发现**：**0**（无任何新发现，系统全面收敛）。
