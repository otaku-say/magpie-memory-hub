# 外部清单 24 项整改与自激修复合流完成报告 (v6.21.0 · NOTES_external_fixes.md)

**发布版本**：`v6.21.0`（`package.json` 与 `settings.html` 严格同步）
**合流基准**：`3ae1c62` (v6.20.0: 切断模型调用自激放大 + 调用预算熔断 + Live默认关闭 + 闲聊短路)
**整改依据**：`NOTES_external_review.md`（24 项实测走读核实方案）+ `NOTES_call_storm_fix.md`（自激修复记录）

---

## 一、24 项清单整改明细表（逐条状态与落地结论）

| # | 严重度 | 建议摘要 | 最终结论 | 改法与落地文件 |
|---|---|---|---|---|
| 1 | P0 | 每次 saveMemory 调 `magpie plugin options` 刷新中间件 | ❌ **未改 (驳回)** | **硬约束门禁驳回**：生产镜像为 distroless（无 magpie CLI）；调用 plugin options 会触发宿主重启陷入死循环震荡；中间件纯同步内存设计不宜接热通道。 |
| 2 | P0 | `compress` 默认改 `false`，保护 KV-Cache；移除非确定性墙钟中断 | ✅ **已改** | `package.json` 默认设为 `false`；`settings.html` 改为「默认 关（保 KV-Cache）」；`memory.middleware.js` 仅在 `opts.compress === true` 时压缩；`compress.js` 移除非确定性 `Date.now() - startedAt > timeBudgetMs` 墙钟中断，仅保留确定性字符预算。测试断言未传 compress 时历史消息 [0..n-2] 逐字节不变。 |
| 3 | P0 | `lookupR2Mount` 中 `target` 变量作用域错误致 `ReferenceError` | ✅ **已改** | `local_state.js:300` 将 `const target = want ? norm(want) : ""` 提升至外层；第 310 行限制仅在 `!want && names.length === 1` 时单记录兜底，彻底杜绝跨库 ReferenceError 与串扰。 |
| 4 | P0 | 逻辑库名解析为真实带前缀库名（`lookupRealDatabase`）| ✅ **已改** | `tools.js`、`mcp_client.js`、`gateway_harvest.hooks.js` 统一引入 `lookupRealDatabase(rawInst) || rawInst` 解析逻辑库名，解决仅配 `ncb_secret` 时无前缀报 403 的缺陷。 |
| 5 | P0 | 设置页「立即扫描对话录制」信标 `harvest_gateway` 漏注册 | ✅ **已改** | `page_actions.js` 的 `OPS`、`execute`（调用 `harvestGateway`）、`CARD_OF_OP` ("gateway") 补齐注册；从 `tests/test_beacon_e2e.mjs` 中移除 `deprecatedOps` 弱化断言。 |
| 6 | P1 | `testClassificationModel` 双端点报错假阳性返回 `ok: true` | ✅ **已改** | `gateway_harvest.hooks.js` 增加白名单判定：仅当 `res.reason === "systemone" || res.reason === "chat_classifier"` 时返回 `ok: true`，其余所有异常/熔断一律报 `ok: false`。 |
| 7 | P1 | `classifyDialogueWithOnlineModel` auto 模式网络异常未回退 chat | ✅ **已改** | `gateway_harvest.hooks.js` 的 `callSystemOne()` 和 `callChat()` 内部用 `try/catch` 捕获 `doFetch` 网络与超时异常，确保 auto 模式能平滑进入 `callChat()` 降级。 |
| 8 | P1 | `callChat` YES/NO 匹配漏洞与静默置 `score: 0.0` 违反 fail-open | ✅ **已改** | `gateway_harvest.hooks.js` 改用单词边界正则 `/\bYES\b/i` 与 `/\bNO\b/i`；非预期/空输出返回 `chat_invalid_output` 触发上层 fail-open 默认放行提炼。 |
| 9 | P1 | 提炼管线 4 处数据过滤与状态错误 | ✅ **已改** | ① 按 `options.min_confidence ?? 0.6` 过滤低置信度候选；② 放行 `CATEGORIES` 全部 7 类（不压 fact）；③ 统一 memories 证据 key 为 `m:${project}:${fp}` 并传 `turnKey`；④ `drainRes.inProgress` 时不覆写已入队计数。 |
| 10 | P1 | `triggerBackgroundDrain` 去重上限 50 条且缺 superseded 演进 | ✅ **已改** | `gateway_harvest.hooks.js` 查询上限提升至 200 条并指定 `lifecycle_status: "active"`；同标题记忆入库时自动遍历更新旧版为 `superseded`。 |
| 11 | P1 | `saveMemory` 演进同标题旧记忆时只更新了 `superseded[0]` | ✅ **已改** | `tools.js` 与 `harvest.py` 循环遍历所有同标题旧记录，全量标记为 `superseded`，消除残留 active 冲突记录。 |
| 12 | P1 | 离线扫描中断或 502 时仍将文件写入增量已完成状态 | ✅ **已改** | `gateway_harvest.js` 引入 `fileComplete` 状态标识；仅在 `!aborted && fileComplete` 时才更新 `updatedFileStates`，中断后再次运行能继续处理剩余轮次。 |
| 13 | P1 | `expires_at` 与 `invalid_at` 在检索与中间件中未过滤 | ✅ **已改** | `tools.js` 的 `memorySearch`/`memoryList`/`memoryContext` 过滤 `isMemoryValid(r)`；`pitfallSearch` 过滤 `!r.invalid_at`；中间件 `isValid` 过滤已过期记录。 |
| 14 | P1 | `gateway_harvest.js` 定义 `stripScaffolding` 漏调且 hooks 重复定义 | ✅ **已改** | `gateway_harvest.js` 导出并在 `extractDialogueText` 返回前调用 `stripScaffolding`；`gateway_harvest.hooks.js` 统一复用导入，删除重复代码。 |
| 15 | P1 | 中间件直接用 `Date.parse` 解析 SQL 时间戳且缓存命中未校验有效性 | ✅ **已改** | `memory.middleware.js` 增加 `parseTime` 规范化空格时间戳；在遍历缓存倒排索引桶时二次校验 `isValid(m, now)`。 |
| 16 | P1 | `_status.json` 路径基准不一致（cwd vs 插件目录）且跨库串扰 | ✅ **已改** | `local_state.js` 与 `r2.js` 统一使用 `STATUS_JSON_PATH`（`import.meta.url`）；`r2.js` 校验 `o.r2.database === db` 防止跨库串扰。 |
| 17 | P1 | 假测试：`test_backend_acceptance.mjs` 参数传错，掩盖崩溃 Bug | ✅ **已改** | `page_actions.js:591` 将路径转换移入 `try` 块内并安全兼容；`test_backend_acceptance.mjs` 修正为 4 参数调用并断言返回 `false` 降级。 |
| 18 | P1 | 假测试：`test_hardening.mjs` 传 `inline_extract: false` 且自写防抖副本 | ✅ **已改** | `test_hardening.mjs` 开启 `inline_extract: true`，断言 `<think>` 完整保留且 `<memory>` 被剔除；从真实 `settings.js` 加载防抖逻辑验证合并。 |
| 19 | P2 | 假测试：`adversarial_verify.mjs` 自写正则；CSS 颜色漏检前 417 行 | ✅ **已改** | `adversarial_verify.mjs` 导入真实的 `memory.middleware.js` 验证清洗；`settings_page_test.mjs` 全量扫描 `settings.css` 全部 450+ 行并加反证门。 |
| 20 | P2 | 状态文件原子写使用固定临时名引发并发竞态 | ✅ **已改** | `local_state.js` 与 `page_actions.js` 使用 `pid + timestamp + random` 唯一种子临时文件名，并在 catch 中清理。 |
| 21 | P2 | 生产代码 `tools.js` 硬编码 `waitWithAbort(15)` 人工延迟 | ✅ **已改** | 彻底移除 `tools.js` 中的 `waitWithAbort` 及其 15ms 休眠；在 `test_abort.mjs` 的 mock client 中挂载延迟。 |
| 22 | P2 | `page_actions.js:92` 手写字符串切片截取目录 | ✅ **已改** | 统一替换为 `path.dirname(p)`。 |
| 23 | P3 | 死代码清理（`dedupIdentical`, `CRITICAL_RE`, `storagePublicUrl`, 重复 `_diag`） | ✅ **已改** | 清理 `compress.js`、`local_state.js`、`tools.js` 中的无用符号，统一从 `gateway_harvest.js` 导出 `_diag`。 |
| 24 | P3 | 文档与设置页文案滞后于当前在线模型架构 | ✅ **已改** | `README.md` 更正 `extract_model`、`classify_endpoint=auto` 与建表类型；设置页文案移除已废弃的本地离线小模型描述。 |

---

## 二、测试验证

全部 36 个测试文件（包含元检查 `test_meta.mjs`、架构对齐 `check_schema_sync.mjs` 以及新增的 `test_p0_external_fixes.mjs`）一次性全绿通过。
