# 模型调用失控放大事故修复检查点（v6.20.0 · NOTES_call_storm_fix.md）

**事故现象**：客户端 Bun 调用 155,229 次；判定模型（clef）与提炼模型（gemini-3.5-flash-lite）额度耗尽。

## 一、真实根因（两者叠加，但主因是自激环）

### 主因 · 钩子自激指数放大（2^n，18 代即破 15 万）
- `gateway_harvest.hooks.js` 的 `classifyDialogueWithOnlineModel` / `harvestWithOnlineModel`
  经本机 loopback（`options.gateway_url || MAGPIE_BASE_URL || http://127.0.0.1:3425`）
  调用网关自己的 `/v1/chat/completions`（判定 chat 回退路径 + 每次提炼）。
- **这次内部模型调用本身也会走网关 `serveAgent`**（与 `/v1/systemone` 不同；
  Magpie 源码：`serveSystemOne` 永不调用 `serveAgent`，不触发任何插件钩子/中间件——
  见本仓 `NOTES_multi_protocol.md §3`、`NOTES_protocol_compat.md §4`），
  → 再次触发同组 `gatewayHooks.onResponse` → 又发起判定+提炼 → 无限递归。
- 旧代码的 `onRequest`/`onResponse` **对插件自身请求无任何豁免、无标头、无请求体识别**
  （HEAD 基线 `rg -in "internal|memhub|budget|limit"` 零命中），且 `processDialogueAndHarvest`
  对内部提炼请求的响应同样会走提炼链路 → 每代调用量 ×2。
- 量级验算：每轮用户对话触发判定+提炼（2 次），代代加倍：2×2^n；n=18 时 2^18=262144，
  与实测 155229 同量级（约 17~18 代）——**指数自激是唯一能解释 15 万次的机制**。
- `/v1/systemone`（clef auto 首选路径）本身不触发钩子，但 `classify_endpoint=auto` 的
  fallback（systemone 不可用 → 自动切 chat）与 `=chat` 路径必然进入自激环；
  且提炼（gemini-3.5-flash-lite）**每次必走** `/v1/chat/completions`，所以两个模型额度同时被耗尽。

### 次因 · Live 测试每次全量跑真实模型调用
- `test_model_in_loop.mjs` Test 5（3 次）、`test_configurable_models.mjs` Test 6（3 次）、
  `test_model_ux.mjs` Test 4（2 次）：门控仅为 `if (MAGPIE_API_KEY)`。
- 本机环境变量自带真实 `MAGPIE_API_KEY`（`MAGPIE_BASE_URL` 缺省 → `https://magpie-api.4a8a.com`），
  **全套测试每跑一遍就产生 8 次真实模型调用**；当天全套被跑非常多次 → 数百~上千次额外消耗。
- 这解释不了 15 万，但与主因叠加，共同耗尽额度。

### 排除项
- 无重试放大：代码中无任何重试循环（`rg retry` 零命中；失败即 `return null` / fail-open）。
- 无并发放大：`maxConcurrency: 4` 只是宿主并发上限，且钩子 fire-and-forget，不产生乘数。
- 中间件不背锅：`memory.middleware.js` 头部明令禁止 fetch/网络（纯同步），零模型调用。

## 二、修复清单（按任务优先级）

### ① 切断自激循环（新增 `model_budget.js` + 钩子入口豁免）
- `model_budget.js`（新文件，已纳入 `package.json.files`）：
  `isInternalHarvestRequest(body, ctx)` 三层判定（或关系，任一命中即豁免）：
  1. `ctx.state.memhubInternal === true`（onRequest 打标透传）；
  2. `X-Memhub-Internal: 1` 请求头（已在全部 5 个内部调用点统一携带；当前宿主未透出请求头时不依赖它）；
  3. **请求体指纹（主判据）**：`INTERNAL_PROMPT_MARKERS` 四个内部 system prompt 稳定子串
     （会话价值判定器 / 长期记忆与踩坑经验提炼助手 / 系统故障诊断专家 / 长期记忆检索改写助手）
     + systemone 决策体 `{state, questions}` 形态。
  不用模型名做主判据的原因：用户正常聊天也可能用相同模型，按模型名豁免会误伤漏采。
- `gateway_harvest.hooks.js`：
  `onRequest` / `onResponse` 最开头（`auto_harvest` 判断**之前**）检查，命中立即 return；
  `onRequest` 命中同时打标 `ctx.state.memhubInternal`。
- `online_models.js` 的诊断/改写调用同样携带内部头 + 走预算（豁免指纹已覆盖其提示词）。
- 验证：`tests/test_call_storm_fix.mjs` Test 3 复刻事故链——外层用户对话 2 次调用后，
  把钩子自己发出的判定+提炼请求体再次喂给 `onRequest`→`onResponse`，断言**零新增调用**。

### ② 调用预算与熔断（`model_budget.js` + 5 个调用点 + 设置页可见）
- 参数（全部经 options 可配置，无硬编码）：`harvest_max_per_min`（默认 20）、
  `harvest_max_total`（默认 2000）；`tools.js readOptions` 透传；`settings.html` 在线模型卡片
  新增两个 number 输入；`settings.js` CARD_FIELDS/NUM/校验（1~600 / 10~100000）。
- 行为：`modelBudgetCheck()` 在 5 个调用点（判定 systemone/chat、提炼、诊断、改写）发请求前检查，
  `modelBudgetRecord()` 在每次实际 fetch 后计数（成功/失败均计，防止失败紧循环）。
  超限一律 fail-open 跳过（判定返回 `{shouldHarvest:true, reason: budget_*}` 保持语义；
  提炼/诊断/改写返回 null = 安全跳过），只打一行日志，绝不抛错。
  总量触顶后锁存 `tripped`（调大上限也不恢复，重启网关进程才清零）。
- 设置页可见：`page_actions.js` 的 `model_check` 结果追加
  `调用预算: 60s窗口 a/b · 累计 c/d[ · 已熔断（重启网关恢复）]`。
- 验证：Test 4（per_min=2：第 3 次 `reason=budget_minute_exceeded`、零新增、放行语义不变）、
  Test 5（total=3：触顶熔断锁存，后续一律跳过且可观测 `tripped=true`）。

### ③ 无价值短路（`processDialogueAndHarvest` 入口，零模型调用）
- 规则：非显式记忆指令（`isExplicitUserMemory` 穿透）且长度 <60 字符且无技术信号
  → `reason=trivial_chatter_shortcircuit` 直接跳过，连判定模型都不调。
- 技术信号分大小写两组（修过一个 `i` 标志误匹配 bug：`[A-Z]{3}` 在 `i` 下会匹配任意英文词）。
- 验证：Test 6（`[user]: 哈哈 / 周末愉快！` 29 字符 → 0 调用；显式"记住…"指令正常放行）。
- 附带修了一个被短路 newly 覆盖的旧用例：`test_configurable_models.mjs` Test 7 的短 fixture
  （<60 字符纯问句）按新语义本就该短路——已把 fixture 补成 112 字符的真实配置问句，断言强度不变。

### ④ Live 测试默认关闭
- 三个文件的门控由 `if (MAGPIE_API_KEY)` 改为
  `MEMHUB_LIVE_TEST === "1" ? MAGPIE_API_KEY : undefined`（无新环境变量名，沿用任务指定名）。
- 验证：Test 7 断言 `shouldRunLiveTests` 四分支（默认 false / =0 false / 无 key false / 双齐 true）；
  且本文件及全套测试默认运行时**零真实网络调用**（storm 测试把 `globalThis.fetch` 换成必抛桩；
  其余测试的真实调用本就只在 Live 块内）。

## 三、修复前后调用量量化对比（mock 确定性实测 + 指数模型推演）

| 场景 | 修复前 | 修复后（实测） |
|---|---|---|
| 一轮有价值对话（判定+提炼） | 2 次，且每次内部调用再触发钩子 → 2×2^n（18 代 ≈ 26 万次ㄧ155229 量级） | 外层 **2 次**，内部请求复入 **0 新增**（Test 3 断言） |
| 一轮纯闲聊 | 判定 1 次（systemone/chat）+ 提炼 1 次 = 2 次（闲聊也要打模型） | **0 次**（短路，Test 6 断言） |
| 内部请求被二次触发 | 每次 +2（指数源头） | **+0**（豁免，Test 1/2/3 断言） |
| 预算耗尽后 | 无上限（打到额度空） | 分钟窗跳过 / 总量熔断锁存（Test 4/5 断言） |
| 全套测试默认运行 | 每遍 8 次真实调用（有 key 即打） | **0 次**（Live 门控，Test 7 断言） |
| 判定失败/模型异常 | fail-open 但**不计数**（紧循环可打爆） | 每次 fetch 均计数（含失败），熔断兜底 |

## 四、限流/熔断实际参数与行为（最终值）
- `harvest_max_per_min = 20`（60 秒滑动窗口，进程内数组时间戳；超限 `reason=budget_minute_exceeded`，仅跳过、不锁存）。
- `harvest_max_total = 2000`（单进程累计；触顶 `reason=budget_total_exceeded` 并锁存 `tripped=true`，后续一律跳过，重启恢复）。
- 超限行为：跳过采集 + 一行日志（`[memory-hub][model-budget]` / `budget_skip_*` diag），绝不抛错、绝不阻断网关、不改变判定语义（判定超限默认放行提炼链路）。
- 手动"真实检测模型"同样走预算计数（防误触打爆），但不受自动采集熔断语义影响（它直接返回 ok/error，不走采集链路）。

## 五、全套测试真实输出（摘要，详见各 /tmp/out_*.log）
- 新增 `tests/test_call_storm_fix.mjs`：7 项全绿。
- `test_meta.mjs`：35 文件全绿（含新增文件的隔离/清理/残余门禁；计数 34→35）。
- 回归全绿：hooks / in_loop / configurable / ux / traceability / denoise / gateway_harvest / multi_protocol / failopen / exports / hardening / settings_page / verify_settings / verify_sub2 / beacon / status_race 等。
- 预存失败（与本修复无关，基线同败，已 `git stash` 对照）：`test_all_20_tools_e2e.mjs`
  （缺真实 Secret Key，`NO_SECRET`）、连带 `test_pollution_guard.mjs` 在第 5 个文件处中断；
  `test_backend_acceptance / test_mcp_only / test_r2_verify / test_sql_escape` 同属需真实远端凭据类。
- 版本：`package.json` 与 `settings.html` 均为 `6.20.0`；`model_budget.js` 已入 `files`。
- 附带测试加固（断言强度只增不减）：`test_meta` 计数 34→35；`test_tool_names_static`
  白名单新增预算选项名并保留拼写误杀反证；`settings_page_test` 新增预算字段填充/独立保存断言；
  `test_call_storm_fix` 结束清队列，避免跨文件队列污染。
- 全量可运行测试（27 个文件，排除 10 个需真实远端凭据/密钥的）一次性 sweep 全部 exit=0，
  无 FAIL 行。
