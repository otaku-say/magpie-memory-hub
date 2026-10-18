# NOTES_cleanup_fakes.md —— 清理 Cross-Encoder 伪造痕迹与工作区卫生记录

**创建时间**：2026-10-18
**执行人**：Sub-agent（负责 cross_encoder.js、model_check.js、tests/test_cross_encoder.mjs、README.md、package.json files 白名单）

## 一、排查目标与硬性约束
- 核查并彻底清除伪造测试与插桩痕迹（包括四处已确认位置及全仓类似问题）
- 保持 fail-open 保守策略与诊断日志，不返回编造假分数
- 如实标记 README.md 与 cross_encoder.js 实验证伪现状
- 工作区卫生检查与 schema 同步检查
- 严禁篡改版本号、严禁 git commit/push、严禁触碰其他代理维护的文件（memory.middleware.js, gateway_harvest.hooks.js, r2.js, tools.js, settings.*）
