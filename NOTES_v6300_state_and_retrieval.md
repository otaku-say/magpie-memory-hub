# 检查点：v6300 状态机与中文分词检索整改任务

## 角色与分支
- 角色：数据状态机与中文分词检索增强 Agent（沙箱 1）
- 分支：feat/v6300-state-and-retrieval
- 沙箱 ID：aa8f1812331643068673810a570196ea

## 任务拆解与整改完成情况
1. [x] tools.js: termsOf(q) 中文 Bigram 分词与常见疑问虚词剥离（CJK_STOP_BIGRAMS 过滤）
   - 对中文连续串提取 2-gram 并过滤 CJK_STOP_BIGRAMS = new Set(["怎么", "如何", "什么", "为什", "么办", "请问", "帮我", "一下", "这个", "那个"])。
   - 彻底解决无空格自然中文问句（如“端口冲突怎么处理”）召回率为 0 的严重问题。
2. [x] tools.js: memoryContext 精简投影白名单（排除 full_text），接入 rewriteSearchQuery 双路词面扩展打分
   - memoryContext 补齐 columns 精简投影白名单，防止穿透拉取庞大 full_text。
   - 接入 rewriteSearchQuery 双路词面扩展与打分机制，大幅提升上下文召回语义覆盖度。
3. [x] tools.js & gateway_harvest.hooks.js: pitfallSave 增加 !r.invalid_at 过滤，接入 Layer ② isSemanticallySimilar 语义比对
   - 杜绝软删除踩坑被复活并卡死。
   - 接入 Layer ② isSemanticallySimilar 语义比对，支持语义相似踩坑去重合并累加。
4. [x] tools.js: memoryAuditUndo 撤销去重按 dupRec 真实值扣减主记录 recurrence，数学守恒
   - 按 dupRec (Number(c.row.recurrence) || 1) 真实累加值扣减主记录 recurrence，确保数学守恒，杜绝主记录计数膨胀。
5. [x] tools.js: memoryAudit 踩坑规则去重放宽 sameComp 限制，支持跨组件语义合并
   - 放宽 sameComp 限制，支持跨组件相同现象或语义相似的踩坑合并软失效。
6. [x] memory.middleware.js: 艾宾浩斯衰减 retention 修复短路：Math.max(tUsed, tUpd)
   - retention 修复时间戳短路：tUsed 与 tUpd 取 Math.max(tUsed, tUpd)，使检索命中后更新的 last_used_at 真实参与衰减加权。
7. [x] settings.js: sync_snapshot 回写设置 next.memories_version = Date.now()，配合 O(1) 索引快速缓存
   - sync_snapshot 收到快照结果后回写 next.memories_version = Date.now()，配合中间件实现 O(1) 索引快速缓存。
8. [x] tools.js: fetchAll 支持 max_pages 参数（默认 5，上限 20），消除穿透查询 RPC 放大
   - 支持 max_pages 控制拉取上限（默认 5 页，上限 20 页），防止穿透查询时的串行 RPC 放大。
9. [x] gateway_harvest.js: 离线扫描增加 < 60 字符短路与 classifyDialogueWithOnlineModel 前置分类过滤
   - 增加 < 60 字符短路与 classifyDialogueWithOnlineModel 前置分类过滤，防止打满模型预算。
10. [x] 加塞紧急修复：SCAFFOLDING_PATTERNS 补充上下文/提示词剥离，调整超时上限（提炼 30s，分类 15s），防 499 客户端取消异常
   - SCAFFOLDING_PATTERNS 增加 [Persistent Memory Context]、[Memory Agent Guide]、[Memory Context]、--- Context from the delegating agent --- 清洗规则；
   - harvestWithOnlineModel 默认超时放宽至 30000ms；classifyDialogueWithOnlineModel 默认超时放宽至 15000ms；
   - test_denoise_p0.mjs 补全相应剥离断言。

## 验证结论
- tests/test_v6300_state_and_retrieval.mjs: 100% 通过
- tests/test_auto_dedup_and_undo.mjs: 100% 通过
- tests/test_search_enhancement_and_scale.mjs: 100% 通过
- tests/test_denoise_p0.mjs: 100% 通过
- tests/test_gateway_harvest.mjs: 100% 通过
- tests/test_gateway_harvest_hooks.mjs: 100% 通过
- tests/test_dedup_and_audit.mjs: 100% 通过
- 全流程隔离环境零残留断言通过。
