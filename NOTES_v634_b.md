# v6.34 Agent B 豁免漂移与白名单修复规划 (NOTES_v634_b.md)

## 1. 任务背景与文件所有权
- **沙箱 ID**：`c6de3847008c4a23905eb2db34e23c9e`
- **代码目录**：`/workspace/m`
- **工作分支**：`feat/v634-b-guard`
- **文件所有权约束（严格独占）**：
  - `model_budget.js`
  - `online_models.js`
  - `gateway_harvest.js`
  - `tests/test_v634_b_guard.mjs`
  - `NOTES_v634_b.md`
- **严禁修改**：`tools.js` / `local_state.js` / `semantic_dedup.js` / `package.json` / `settings.*` / `README.md` / `DEVNOTES.md` / `test_meta.mjs` / 其他 tests。

---

## 2. 整改项清单与技术方案

### 2.1 【P0-1 最紧急】自激豁免因「提示词文案与实际不一致」再次失效 (model_budget.js 约 115、176; online_models.js 约 380)
- **根因 a**：`INTERNAL_PROMPT_MARKERS` 中填写的文案为「长期记忆中枢体检与质量审阅专家」，而 `online_models.js` 中 `AUDIT_SYSTEM_PROMPT` 实际首句为「长期记忆中枢全自动去重专家」，两者字面不一致，导致去重调用经 `isInternalHarvestRequest` 识别为 `false`，自激放大风险重现。
- **根因 b**：漏检 Gemini API 官方使用的 snake_case 命名 `body.system_instruction`（及下划线复数/对象）。
- **修复方案**：
  1. 在 `online_models.js` 中导出各核心 System Prompt 的首句常量（如 `AUDIT_SYSTEM_PROMPT_LEAD` 等），确立文案单一真实来源；
  2. 将实际首句「长期记忆中枢全自动去重专家」加入 `model_budget.js` 的 `INTERNAL_PROMPT_MARKERS`，并保留历史文案保障向前兼容；
  3. `isInternalHarvestRequest` 增强字段提取：支持 `body.system_instruction`（snake_case）与 `body.systemInstruction`（camelCase）等所有承载形式（支持字符串与对象/parts 形态）；
  4. 新增防漂移自检机制：在测试中遍历所有真实 Prompt 常量，断言其特征文案必须存在于 `INTERNAL_PROMPT_MARKERS` 中，阻断未来代码修改再度漂移。
- **反证验证**：分别以真实的 `AUDIT_SYSTEM_PROMPT` / `QUERY_REWRITE_SYSTEM_PROMPT` / `HARVEST_SYSTEM_PROMPT` / `RERANK_SYSTEM_PROMPT` / `ERROR_DIAGNOSE_SYSTEM_PROMPT` 构造请求，断言 `isInternalHarvestRequest` 均返回 `true`；普通用户请求断言返回 `false`。

### 2.2 【P0-2】白名单只看子串导致任意父目录可放置 GatewayConversations (gateway_harvest.js 约 145-158、277-288)
- **根因 a**：`isWhitelistedGatewayDir` 仅凭正则匹配 `GatewayConversations` 子串直接返回 `true`，未检查父级真实根域，导致例如 `/var/log/GatewayConversations` 及指向非授权目录的软链直接逃逸。
- **根因 b**：祖先回溯遍历时，针对已被判定为白名单的分支跳过了 `checkPathForbidden(parentReal)`。
- **修复方案**：
  1. 白名单两阶段校验：
     - 先校验父目录与祖先真实路径（realpath）是否命中系统黑名单（`HARD_FORBIDDEN_PREFIXES` 与敏感凭据子路径）；
     - 限制 `/var` 根域：在 `/var` 或 `/private/var` 下仅放行 `minis` / `folders` / `tmp` 三个授权子域，其它所有路径（如 `/var/log`）一律禁止；
  2. 祖先回溯重构路径安全加固：无论是否判定为白名单，回溯中对 `parentReal` 以及重构后的 `realPath` 均无条件执行 `checkPathForbidden`。
- **反证验证**：
  - `/var/log/GatewayConversations` 与指向 `/var/log` 的祖先软链接必须被坚决拦截并抛出 `[SECURITY_BLOCKED]`；
  - `/var/minis/x/GatewayConversations`、`~/GatewayConversations`、`/tmp/ok/GatewayConversations` 必须合法放行。

### 2.3 【P1-4】isTestMode 用完整路径子串判定导致生产部署在含 test_ 的目录时全面停摆 (gateway_harvest.js 约 551-559)
- **根因**：原判定通过 `entry.includes(test_)` 对完整 `argv[1]` 作包含判断，当生产环境部署路径包含 `test_`（如 `/var/minis/test_env/app.js`）时，误判为测试环境，导致 `auto_init` / `auto_harvest` / `dedup_schedule` / 实时提炼在生产中全部停摆。
- **修复方案**：
  - 与 `local_state.js` 对齐：针对 `process.argv`，仅取 `path.basename(arg)` 严格匹配测试脚本规则（如 `^test_.*\.mjs$`、`\.test\.(mjs|js)$ `），或要求脚本必须以 `.mjs` 结尾且其所在父目录名称精确等于 `tests`，彻底废弃全路径子串弱匹配。
- **反证验证**：
  - 当 `argv[1] = /var/minis/test_env/app.js` 且无测试环境变量时，断言 `isTestMode() === false`；
  - 当 `argv[1] = /workspace/m/tests/test_x.mjs` 时，断言 `isTestMode() === true`。

---

## 3. 测试与验证策略
- **新建测试**：`tests/test_v634_b_guard.mjs`，包含 3 项专项反证门与 `test_meta` 规范自检；
- **回归套件**：
  - `node tests/test_meta.mjs`（前置校验）
  - `node tests/test_call_storm_fix.mjs`
  - `node tests/test_gateway_harvest.mjs`
  - `node tests/test_gateway_harvest_hooks.mjs`
  - `node tests/test_v633_b_guard.mjs`
  - `node tests/test_v634_b_guard.mjs`
