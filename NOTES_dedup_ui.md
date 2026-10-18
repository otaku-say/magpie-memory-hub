# 定时去重表单改造与后台异步化检查点记录 (NOTES_dedup_ui.md)

## 1. 提交与推送状态
- **Commit Hash**: `3566b01`
- **Commit Message**: `feat: 改造定时去重表单与回滚交互，去重任务后台异步化`
- **Branch**: `main`
- **Remote Status**: 已推送到 `origin/main`（`05b2ec1..3566b01`）
- **版本号**: `v6.28.3`（`package.json` 与 `settings.html` 严格同步）

## 2. 已完成事项清单 (100% 全部完成)

### ① 定时去重表单样式重构与交互联动
- **频率下拉**: `关闭 (off)` / `每天 (daily)` / `每周 (weekly)` / `每月 (monthly)`
- **条件字段动态显隐**:
  - 选「每周」→ 显示【星期几】下拉（周一 ~ 周日，值 1~7），隐藏几号输入框
  - 选「每月」→ 显示【几号】数字框（1~28，带外挂「天」后缀单元），隐藏星期下拉
  - 选「每天」或「关闭」→ 隐藏上述两个条件字段
- **时间分离为「小时 + 分钟」独立数字框**:
  - 小时框（`0~23`，步长 1，带外挂「小时」后缀单元）
  - 分钟框（`0~59`，步长 1，带外挂「分钟」后缀单元）
  - 消除原生数字输入框上下箭头（spinners），文字居中整洁
- **下方自然语言实时预览 (`#dedup_preview`)**:
  - 每天: `每天的 01:30 执行一次`
  - 每周: `每周 周一 的 01:30 执行一次`
  - 每月: `每月 13 号 01:30 执行一次`
  - 关闭: `已关闭定时去重`
  - 支持 `input`/`change` 实时计算更新
- **存储契约严格不变**:
  - `fill()`: 将 `"01:30"` 拆分为小时 `1` 和分钟 `30` 分别填入两框
  - `collect()`: 将小时与分钟拼回标准两位补零的 `"HH:MM"` 字符串存入 `dedup_time`
  - 后端存储键 `dedup_schedule`, `dedup_time`, `dedup_weekday`, `dedup_day` 完整保持

### ② 【真 Bug】全量去重后台异步执行（消除 60s 前端超时与加载阻塞）
- **根因消除**: 修改 `page_actions.js`，当 `action.op === "memory_audit"` 时立即返回 `status: "进行中"` 的启动响应（耗时 ~40ms），绝不阻塞 `runPendingAction`，消除宿主加载插件卡死与 `client.list is not a function` 崩溃
- **后台 Fire-and-forget**: 异步自建独立 Client 运行 `memory_audit.execute`，分批通过 `writeCardStatus("audit", ...)` 持续回传状态和滚动日志
- **前端轮询修复**: `settings.js` 中 `startPollingStatus` 支持识别 `statusData.audit`，在 `status === "进行中"` 时持续刷新并延长 deadline，避免假超时

### ③ 撤销/还原按钮改形态与时间格式统一
- **移除旧按钮**: 删除了底部 `btn-row` 中独立的「撤销上次去重」按钮
- **新按钮形态**: 将【还原】按钮 (`#btn_dedup_undo`) 放置在「回滚时间点 (可选)」输入框 (`#undo_before_time`) 右侧（内联 `.input-group` 容器）
- **时间格式统一为 `YYYY-MM-DD HH:MM`**:
  - 提示文案统一为 `如 2026-10-19 03:00`
  - 预填值采用 `formatDateTime` 格式化为 `YYYY-MM-DD HH:MM`（不再带秒、不再用斜杠）
  - `normalizeUndoTime` 宽容解析支持 `YYYY/MM/DD HH:MM`、带秒 `YYYY-MM-DD HH:MM:SS` 及时间戳；非法格式弹出精准示例指引并聚焦
  - 留空点击【还原】自动触发撤销最近一次去重

### ④ 样式与明暗模式自检
- 100% 使用 `--magpie-*` 主题变量与 `color-mix`，全文零硬编码颜色
- 使用浏览器真实渲染，在亮色模式与暗色模式下分别进行了截图视觉验收

### ⑤ 门禁与自动化测试全绿
- `verify_settings.mjs`: 全部 11 个大项通过，残余为 0
- `settings_page_test.mjs`: 静态检查 + 16 个真实交互测试全部通过（新增测试 14、15、16）
- `test_meta.mjs`: 43 个测试文件元检查通过
- `check_schema_sync.mjs`: schema 声明与写入完全对齐，版本号严格同步

## 3. 未完成事项与阻塞排查
- **未完成事项**: 无（本次需求涉及的 5 项内容全部完成并通过测试验证）。
- **当前状态**: 代码干净、工作树已提交并推送到 GitHub 远端 `main` 分支。
- **后续扩展建议**（非阻塞）:
  - 若未来需要在更多地方复用外挂单位输入框，可将 `.input-with-suffix` 抽象至公共组件库中。
