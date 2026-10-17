# 检查点：测试污染生产库定位与修复

## 背景与问题描述
用户真实库：NoCodeBackend `41694_agent_memory`。
测试执行时发现真实生产库发生数据污染（行数增加）：
- 单独跑 `tests/test_gateway_harvest_hooks.mjs` 前后：memories 23, pitfalls 566（未变）
- 跑完整套 `tests/` 后：pitfalls 从 566 涨到 572，目前测量值为 573（memories: 23, pitfalls: 573）。
说明测试套件中至少有一个测试在未经有效隔离的情况下向真实生产库执行写入。

## 目标与计划
1. 编写查询脚本，调用 MCP `execute_sql` 获取真实库行数。
2. 逐一运行 `tests/` 下的各个测试文件，记录运行前后 `memories` 与 `pitfalls` 行数，精确二分定位导致污染的测试。
3. 查明未隔离/绕过隔离的代码原因。
4. 修复方案：优先纯内存/桩，加固 `testenv.mjs`（覆盖所有写方法，fail-closed），加固 `test_meta.mjs` 门禁与反证，加入真实库行数自动化守卫断言。
5. 清理方案：整理污染数据清单与清理 SQL（不直接执行，交由确认）。
6. 全量回归测试与行数零变化验证。
