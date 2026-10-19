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
