# Agent A 检查点：tools.js 核心逻辑整改 (v6.3.1)

## 任务背景
在分支 `feat/v631-a-tools` 上，独占修改 `tools.js` 完成 7 项整改，并新建专项测试 `tests/test_v631_a_tools.mjs`，确保全量测试通过并提交推送。

## 7 项核心整改项完成状态

1. **P0-1 导出面与 Proxy 安全 (tools.js)** [已完成]
   - `makeNoCredentialsClient`: Proxy 白名单只拦截 `list` / `create` / `update` / `remove` / `raw`，其余属性安全返回 `undefined`。保留 `_isNoCredentials: true` 与 `then: undefined`（防 Promise 同化）。
   - 所有非入口导出函数 (`fetchAll`, `termsOf`, `getDedupTimeWindow`, `isDedupDue`, `memoryAudit`, `memoryAuditUndo`, `makeClient`) 在入口处增加宿主探针守卫：若首个参数是宿主对象（无 `list` 函数且不是合法 cfg 形状），安全返回空值或安全响应，绝不抛错。

2. **P1-1 memoryGet 读操作零时间戳篡改 (tools.js)** [已完成]
   - 删除 memoryGet update 载荷中的 `updated_at: nowSql()`，仅保留 `retrieval_count` 与 `last_used_at`。

3. **P1-2 pitfallSearch 接入 query 改写 (tools.js)** [已完成]
   - 对齐 memorySearch：调用 `rewriteSearchQuery` 进行双路打分 (`origHit + rewriteHit`)，返回体增加 `rewrite_used` 与 `query_rewritten` 字段，严格 fail-open。

4. **P1-3 memoryContext 统一条数上限 (tools.js)** [已完成]
   - 准则 (principles)、踩坑 (pitfalls)、记忆 (memories) 三段循环统一共用计数器 `n`，每段循环开头 `if (n >= maxItems) break;`，彻底杜绝注入条数超限。

5. **P1-4 principle 准则保护 (tools.js)** [已完成]
   - `saveMemory`: `category === principle` 豁免「踩坑优先软失效」逻辑（不能被 pitfalls 表覆盖失效）。
   - `pitfallSave`: 跨表软失效 memories 时排除 `category === principle` 的记录。

6. **P1-5 memoryAudit 解耦「DB 拉取批」与「模型分块」(tools.js)** [已完成]
   - 新增 `dbFetchLimit`（默认 200，上限 1000，取自 `args.fetch_limit || cfg.dedup_fetch_limit`）。
   - 内存级全量规则去重（指纹相同 / 归一化标题相同 / tags 交集）覆盖整批拉取的记录。
   - 仅将规则筛出的候选组提交给 `auditMemoriesWithModel`（模型分块 40 条已由 online_models 处理）。
   - 独立模型仲裁预算：`maxModelBatches`（默认 2 = 最多 2 次分块调用），超出部分仅用规则结果 fail-open。
   - cursor 按 `dbFetchLimit` 推进，返回体保留 `has_more` / `next_action`。
   - 注释注明单次调用最坏耗时估算：2 次模型调用 × 15s = 30s < 55s。

7. **P2-1a 脱敏收敛 (tools.js)** [已完成]
   - 移除 `tools.js` 内本地 `scrubSecrets` 实现，统一为 `import { scrubSecrets } from ./scrub.js;`。

## 验收检查
- [x] 编写 `tests/test_v631_a_tools.mjs` 覆盖全部 7 项整改及反证测试
- [x] 跑通全量指定测试用例：
  - `node tests/test_meta.mjs` (47/47 通过)
  - `node tests/test_exports.mjs` (100% 通过)
  - `node tests/test_proactive_memory_ux.mjs` (100% 通过)
  - `node tests/test_dedup_and_audit.mjs` (100% 通过)
  - `node tests/test_auto_dedup_and_undo.mjs` (100% 通过)
  - `node tests/test_model_ux.mjs` (100% 通过)
  - `node tests/test_v631_a_tools.mjs` (100% 通过)
- [x] 检查代码零密钥泄露
- [x] git commit & git push origin feat/v631-a-tools
