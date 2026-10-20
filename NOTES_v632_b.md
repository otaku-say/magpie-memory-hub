# v6.32 Agent B 安全与状态项整改规划

## 1. 任务背景与文件所有权
分支：`feat/v632-b-security`
文件所有权限制（严格）：
- `db_tools.js`
- `gateway_harvest.js`
- `gateway_harvest.hooks.js`
- `page_actions.js`
- `settings.js`
- `tests/test_v632_b_security.mjs`
- `NOTES_v632_b.md`

严禁修改：`tools.js` / `local_state.js` / `semantic_dedup.js` / `mcp_client.js` / `ncb_mcp.js` / `model_budget.js` / `tests/lib/testenv.mjs` / `package.json` / 其他已有测试。

## 2. 整改项清单与技术方案

### 2.1 【P0-1】跨账号前缀越权清库（db_tools.js:203-223）
- **现状**：`isSameDatabaseTarget` 无条件剥离双端任意 `^\d+_` 前缀，导致配置 `41694_memory` 传入 `99999_memory` 也能通过，随后 `dbOf` 优先取 `args.database` 并在该库上 DROP TABLE。
- **修复方案**：
  1. 归一化时提取前缀 `const m = /^(\d+)_/`；若两侧都有前缀且前缀不等 -> 判定不同账号，返回 `false`。
  2. 若一侧无前缀一侧有前缀 -> 视为同一库（逻辑名 vs 物理真实名），比对去除前缀后的部分，相等则允许。
  3. 若双侧前缀相同 -> 去掉前缀比较余下部分。
  4. `dbReset` 执行 DROP 时，强制使用**配置侧库名**（`cfg.instance` / `ncb_instance` 解析出的物理库名），绝不使用 `args.database` 直接执行。`args.database` 仅用于一致性校验。
- **反证验证**：配置 `41694_memory`，传入 `99999_memory` 必须抛出 `FORBIDDEN_DATABASE`。

### 2.2 【P0-3】validateGatewayDir 误杀合法目录（gateway_harvest.js:107-170）
- **现状**：`FORBIDDEN_PREFIXES` 硬编码封禁 `/home`、`/root`、`/var`，导致 `~/GatewayConversations`、`/var/minis`、macOS `/var/folders` 全被拦截。
- **修复方案**：改为「敏感子路径黑名单 + 白名单放行」：
  1. 硬拦截系统目录：`/etc`、`/proc`、`/sys`、`/dev`、`/boot`、`/bin`、`/sbin`、`/usr`、`/lib`、`/lib64`。
  2. `/home`、`/root`、`/var` 改为放行非敏感子路径，仅拦截高危敏感子路径：
     - `.ssh`、`.gnupg`、`.aws`、`.config/gcloud`、`.docker`、`.kube`
     - 状态目录：`os.homedir()/.magpie-memory-hub` 和 `process.env.MEMHUB_STATE_DIR`。
  3. 保留 `..` 段拦截、`realpathSync` 校验、跳过符号链接 `isSymbolicLink`。
- **反证验证**：`~/GatewayConversations`、`/var/minis`、`/tmp/xxx` 放行；`~/.ssh`、`~/.magpie-memory-hub`、``、`/etc` 拦截。

### 2.3 【P1-4】harvest_gateway 信标触发生产副作用 + 去重状态竞态（page_actions.js:272-310、433-512）
- **现状**：调用完整 `MagpieMemoryHub` 获取 `saveMemory`/`pitfallSave` 误触发 `autoInit`、`autoHarvest`、定时调度器。
- **修复方案**：
  1. 避免触发全量副作用，构造最小 opts（显式传入 `auto_init:false`, `auto_harvest:false`, `dedup_schedule:off`，清理 `_action`）或内部安全获取工具句柄。
  2. `memory_audit` 分支：先写“进行中”状态 `writeCardStatus` 落盘，再启动异步 IIFE，杜绝状态倒退或覆盖竞态。

### 2.4 【P1-5】旧去重状态覆盖最新模型检测（settings.js:610-625）
- **现状**：`renderAllStatus` 渲染 `statusData.model` 后无条件被 `statusData.audit` 覆盖 `#model_action_status`。
- **修复方案**：比对两者 `at` 时间戳，仅当 `audit.at > model.at` 且该卡片归属 audit 时才渲染 audit，否则保留 model 结果。或基于操作类型区分卡片状态归属。

### 2.5 【P1-6】dbReset 未清空多项目游标与采集指纹（db_tools.js:246-260）
- **现状**：清库后遗留多项目游标与已采集指纹，造成清库后数据游标脱节或重复采集断流。
- **修复方案**：清库成功后遍历 `state.audit.cursors` 清空**全部 project**（不仅仅是当前 project），并清空 gateway_harvest 指纹缓存（lookupGatewayHarvest 对应的 processed 记录）、`harvest_queue`、`pending_patterns`；严禁整体抹平 secrets/actions/r2_mounts。

### 2.6 【P1-1 部分】gateway_harvest.hooks.js:1313 前置短路绕过数字守卫
- **现状**：在调用 `isSemanticallySimilar` 前的 includes/词集重叠短路判定缺少数字守卫，导致 Port80/Port8080 等包含冲突数字的文本被直接短路命中。
- **修复方案**：短路前置条件追加 `!hasConflictingNumbers(a, b)`（从 `./semantic_dedup.js` 导入）。

## 3. 测试与验证策略
- 单元与集成测试：新建 `tests/test_v632_b_security.mjs`，包含 6 大整改点的针对性反证与边界测试。
- 回归测试：运行全部要求回归的测试套件。
