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
