# 收尾 + 发版前对抗测试追踪检查点

创建时间: 2026-10-18
当前状态: 进行中

## 一、第一部分：设置页「无人区」遗留清理与在线模型配置
- [x] 1. 扫描 settings.html / settings.js / settings.css / page_actions.js
- [x] 2. 移除本地小模型相关全部 UI 与逻辑（btn_download_model, updateModelButtonState, .model-progress-box, LLMLingua-2 描述文案等）
- [x] 3. 补上在线模型配置项（extract_model, classify_model, classify_endpoint, search_rewrite，默认留空/auto/true）
- [x] 4. 添加/打通「真实检测模型」按钮及后端信标/逻辑（调用 testModelConnectivity 实际向网关发起请求并校验 JSON 结构与延迟）
- [x] 5. 同步更新测试断言（tests/settings_page_test.mjs, tests/verify_settings.mjs, tests/test_beacon_e2e.mjs）
- [x] 6. 运行 node tests/test_meta.mjs 与 test_pollution_guard.mjs 验证全绿（31 个文件元检查 PASS，30 个全量测试生产库零污染 PASS）

## 二、第二部分：对抗测试（攻击与复现收敛）
- [ ] 1. 第一轮对抗审查（全仓扫历史遗留：本地小模型、规则提炼、heuristic_fallback、body.prompt 等；新机制漏洞、不变量违背、弱断言等）
- [ ] 2. 修复第一轮问题并复现验证
- [ ] 3. 后续轮次对抗测试，直到整轮 0 发现
- [ ] 4. 跑 test_meta.mjs + test_pollution_guard.mjs

## 三、最终交付验证
- [ ] 全套测试真实输出记录
- [ ] 发版结论评估
