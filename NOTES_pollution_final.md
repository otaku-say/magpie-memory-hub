# 检查点：测试污染最终收尾排查

## 背景
主控实测证据：
跑完整个 `tests/` 全套（除 `test_meta.mjs`）前后，真实生产库 `41694_agent_memory` 中 `pitfalls` 出现 +1 污染。
此前代理声称完全隔离，但实测仍有 1 处测试漏网直接写入真实库。

## 排查计划与执行纪律
1. 落盘检查点 NOTES_pollution_final.md（当前）。
2. 构建自动排查脚本：
   - 逐个独立运行 `tests/` 下的每一个测试文件（不设置任何外部环境变量，模拟主控运行环境 `node test_xxx.mjs`）。
   - 每个测试运行后严格等待 6 秒（规避 NoCodeBackend 读写可见性延迟），通过 MCP `execute_sql` 查询 `41694_agent_memory` 的行数。
   - 严格记录每个测试执行前后的 `memories` 和 `pitfalls` 行数变动，形成完整的真实行数变化表。
3. 对行数增加的测试进行代码级深入排查：
   - 查看为何绕过了已有的隔离机制（如 `tools.js`、`testenv.mjs`、`gateway_harvest.js`、未受控 client、缺少 `NODE_ENV=test` 锁等）。
   - 查验是否有其它测试同样隐蔽地连接了真实库。
4. 根治修复：
   - 不依赖脆弱的 `NODE_ENV=test`；
   - 确保 `tools.js`、`gateway_harvest.js`、`db_tools.js`、`r2.js` 等所有写入通道默认安全（fail-closed 或纯内存桩）；
   - 加固 `tests/test_pollution_guard.mjs`，确保覆盖全套测试并严格等待 6 秒断言行数零变动。
5. 最终验证：
   - 运行整个 `tests/` 全套（除 `test_meta.mjs`），查询前后真实库行数，用真实输出证明 0 污染。
6. 提供待清理污染数据的清单与 SQL（绝不执行删除）。
