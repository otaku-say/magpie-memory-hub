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
