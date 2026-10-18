# 清理向后兼容代码第二阶段执行计划与检查点 (NOTES_remove_compat_2.md)

## 1. 原则与用户长期授权
- 用户长期授权：「**插件代码不用做过时内容的兼容**」+「**不需要的测试都移除**」+「**不用规则判定**」（改用在线模型）。
- 绝不改动版本号、不执行 git commit / git push。
- 严禁向用户生产库写入任何测试数据（必须隔离 `__test__`、测试后清理且残余断言为 0）。
- 直接删，不留兼容分支、不留 @deprecated 的兼容导出。
- fail-open 的正确语义是「跳过本次采集 + 留一行诊断日志」，绝不退回噪音规则。

## 2. 协作边界与文件所有权（并行代理防护）
- **禁止修改（另一个代理负责「移除本地模型」）**：
  - `tools.js`
  - `page_actions.js`
  - `model_check.js`
  - `README.md`
  - `package.json`
- **本任务责任范围**：
  - `gateway_harvest.js`
  - `gateway_harvest.hooks.js`
  - `tests/` 下相关测试文件

## 3. 待办事项状态

### 待办 1：`gateway_harvest.js` 遗留规则与测试兼容分支清理 [未做]
- [ ] 移除 `harvestGateway` 中的 `else if (options.heuristic_fallback === true)` 分支
- [ ] 移除 3 个被标记 `@deprecated` 的规则函数：`mineFailures` / `mineEnvironmentFacts` / `mineArchitecturalDecisions`
- [ ] 检查并清理仅为上述 3 个规则函数服务的死代码（辅助正则、常量集合、专用 helper）
- [ ] 清理打破的旧测试 / 僵尸测试（`tests/adversarial_verify.mjs`、`tests/test_denoise_p0.mjs`、`tests/test_gateway_harvest_hooks.mjs` 等）
- [ ] 同步更新 `test_meta.mjs` 等清单断言，绝不为了让测试变绿而弱化有效断言

### 待办 2：`gateway_harvest.hooks.js` 的 `// 4. Legacy single prompt` 裁决清理 [未做]
- [ ] 确认全仓无合法生产链路依赖 `body.prompt` 分支
- [ ] 移除 `gateway_harvest.hooks.js` 中 `countTurnsFromMessages` 的 `body.prompt` 分支
- [ ] 若有专门测 `body.prompt` 的僵尸测试，连带清理

### 检查与验收 [未做]
- [ ] 每完成一项立刻跑一次关联测试并记录
- [ ] `rg` 收尾自查确认 `heuristic_fallback` / `mineFailures` / `mineEnvironmentFacts` / `mineArchitecturalDecisions` / `body.prompt`（该分支）在全仓无生产调用方
- [ ] 全套测试运行并记录真实输出
- [ ] 输出完整中文收尾报告
