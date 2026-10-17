# NOTES_user_issues_v2.md - 排查与修复工作记录

## 任务目标
解决用户实测反馈与本轮交接发现的核心问题：
1. R2 桶名非法（`_` 在 S3/R2 桶名中不合法，需派生合法桶名，抽纯函数，钉住创建与列举/删除两处）。
2. Secret Key 检测报 TLS 握手失败（EPROTO sslv3 alert handshake failure SSL alert 40 / 500）。查清真实请求与网络中间层原因，改进错误分类。
3. 本地小模型检测结果被自动隐藏。修改为常驻显示，不被自动轮询/超时清除。
4. 全量核对真实 NCB 数据库 `41694_agent_memory` 的表/字段/字段类型，比对并更新 `schema.js`，增强 `check_schema_sync.mjs`。
5. [追加] 卡片日志提示框隔离：`settings.js` 中所有写入提示框的状态都必须精准归属于对应卡片容器，禁止串台写到顶部 NCB 容器；抽敛 `cardOfOp(op)` / `containerOfOp(op)` 函数统管。
6. [追加] Pitfalls 乱配对真实反例排查与根治：针对清库后出现的 symptom/solution 文档正文乱配对反例，查明放行分支、同轮去重、严格过滤与门禁，并加回归测试与反证。
7. [核心高优] `min_evidence` 必须按内容类型区分：解决真实线上 memories 自动采集为 0、全部被 3 次门限拦截的缺陷；踩坑与命令重试维持 3 次门槛，事实/偏好/决策/环境画像门槛设为 1（立即入库不设门禁），并维持显式穿透双轨制。
8. [接手修复] 修好 `tests/test_denoise_p0.mjs`：定位并修复前一个代理重构 `isExplicitUserMemory` 时误删「避坑」关键字引入的代码回归。

## 现状盘点与修复成果
1. **test_denoise_p0 失败修复**：
   - 根因：前一个代理在 `gateway_harvest.js` 中收紧 `isExplicitUserMemory` 正则时，本意是剔除通用的「注意：」「规则：」，但不慎将「避坑」遗漏（仅保留了「避坑指南|踩坑记录|避坑备忘」），导致断言 `isExplicitUserMemory(explicitDialogue) === true` 失败。属于典型**代码回归**。
   - 修复：在正则表达式中补齐 `避坑`（同时保留其余显式意图词），测试恢复 100% 绿色。
2. **min_evidence 按内容类型区分**：
   - 根因：`gateway_harvest.hooks.js` 与 `gateway_harvest.js` 中将低频高价值的环境事实（如「我的开发机是 Mac mini M4 16G」）与踩坑重试共用 `min_evidence = 3` 门限；事实在对话中通常只陈述一次，永远无法累计到 3 次，导致真实库中 memories 自动产出为 0。
   - 修复：按 Headroom traffic_learner 哲学，将门槛按内容重复特性解耦：
     - 踩坑 / 命令重试（failures）：保持 `minEvidencePitfall`（默认 3 次才落盘）。
     - 事实 / 偏好 / 决策 / 环境画像（facts/decisions）：`minEvidenceMemory` 门槛默认为 1（直接落盘，不设门禁），同时支持配置覆盖；用户显式表达维持双轨直接穿透。
   - 验收：在 `test_denoise_p0.mjs` 增加【测试 11】，验证单次环境事实立即入库、单次伪踩坑噪音被拦在 pending、重复 3 次踩坑毕业落盘，以及显式配置门槛反证。
3. **卡片串台彻底根治**：
   - 根因：`settings.js` 中此前在页面初始化（`paintDbStatus(current._action)`）、底部保存、轮询重试等分支多处硬编码或默认回退到 `db_action_status`，且未对各操作的目标卡片容器做唯一映射，导致点击「检测本地小模型」时，顶部的 NoCodeBackend 卡片也显示了小模型的任务提示。
   - 修复：抽出全局唯一的纯函数 `cardOfOp(op)` 与 `containerOfOp(op)`，统一管理：
     - `ncb`: `db_action_status`
     - `r2`: `r2_action_status`
     - `model`: `model_action_status`
     - `gateway`: `harvest_action_status`
     所有写状态、等待/倒计时每一帧、超时重试、轮询回传渲染与页面初始化均统一调用 `containerOfOp(op)`，严禁任何地方手写默认容器。
   - 验收：在 `settings_page_test.mjs` 与 `verify_settings.mjs` 中增加强断言：触发 `model_check` 后，`#db_action_status` 严禁出现小模型字样，`#model_action_status` 必须包含；并增加反证门（故意写错容器必报错）。
4. **R2 桶名合法化确认**：
   - 确认创建（`r2Setup` / `storageSetup` / `dbProvision`）与列举/删除/检测（`r2Check` / `r2List` / `cleanProbes`）统一使用 `r2.js` 导出的纯函数 `deriveLegalBucketName`。
   - 并在 `test_lookup_secret.mjs` 补充 S3/R2 合法字符集正则 `^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`、下划线转换、首尾符号剥离、连续点/连字符合并、3-63 字符截断与补齐的完备断言。
5. **小模型提示框常驻确认**：
   - 确认小模型检测/下载完成后的状态提示框常驻显示在 `#model_action_status`，不被 `cardSay` 的 5 秒定时器清除，轮询结束后保留成功或失败状态。
6. **TLS 握手错误分类与测试**：
   - 确认 `db_tools.js` / `r2.js` 已区分远端 R2 TLS 握手失败（`R2_TLS_ERROR`，提示密钥有效但 R2 连接被拒绝）与本机到 NCB TLS 异常（`isClientTls`），并在 `test_lookup_secret.mjs` 增加分支 4、5、6 的 mock 真实断言。

## 约束检查
- 数据库结构只读（SELECT / get_schema），不写生产数据。测试用隔离 `__test__` + 清理 + 残余 0 断言。
- 不许改版本号（保持 6.12.0），不许 git commit/push。
- 每处改动前后加断言验证。
- 跑全套指定测试并贴出完整真实输出。
