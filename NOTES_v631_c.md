# Agent C: 运行时与测试卫生整改检查点 (v6.3.1)

## 任务目标与文件所有权
严格限定修改文件：
- local_state.js
- semantic_dedup.js
- mcp_client.js
- ncb_mcp.js
- r2.js
- online_models.js
- settings.js
- tests/test_model_ux.mjs
- tests/test_v6300_security_and_isolation.mjs
- tests/test_v631_c_runtime.mjs (新增)
- tests/*.py (清理)

严禁触碰：tools.js / gateway_harvest*.js / db_tools.js / page_actions.js / memory.middleware.js

## 整改项目状态跟踪
- [ ] 1. P2-2 local_state.js 状态健壮性
  - [ ] statePath 优先 MEMHUB_STATE_DIR
  - [ ] 抽公共函数 _recoverCorruptStateFile()：同步写 .corrupt.<ts> 备份，加载 .bak，禁止回写空 {}
  - [ ] forgetR2Mount 补更新 _status.js (或状态字段)
  - [ ] recordPendingEvidence 补齐 pitfall 语义去重 (isSemanticallySimilar)
- [ ] 2. P2-3 semantic_dedup.js 性能与误判
  - [ ] levenshteinDistance 双行滚动数组 (O(min(M,N)) 空间)，512 字符截断
  - [ ] isAlphaTokenMatch: 纯数字严格相等 (===)，含字母才允许 includes (防 80 vs 8080 误判)
- [ ] 3. P2-4 mcp_client.js / ncb_mcp.js
  - [ ] buildSelect OFFSET 使用截断后的 effectiveLimit 计算
  - [ ] create 回查分流：pitfalls 表使用 symptom 列回查
  - [ ] ncb_mcp.initialize() 缓存 this._initPromise 实现并发互斥
- [ ] 4. P2-5a r2.js 凭据兜底
  - [ ] restClient 与 r2Upload 在 cfg 无 secret 时回退 lookupSecret(db)
- [ ] 5. P2-6b online_models.js / settings.js
  - [ ] auditMemoriesWithModel 删除外层悬挂 setTimeout/clearTimeout
  - [ ] rerankSearchResultsWithModel 优先级修正为: rerank_model || audit_model || extract_model || harvest_model
  - [ ] settings.js: pollingTimer / countdownTimer 改为按 cardKey 独立 Map 存储
- [ ] 6. P0-5a 修复 tests/test_model_ux.mjs:395 (Bigram 命中 >= 1)
- [ ] 7. P0-5b 清理 tests/ 下硬编码 .py 脚本 (git rm)
- [ ] 8. 新增 tests/test_v631_c_runtime.mjs，跑通全量测试套件
