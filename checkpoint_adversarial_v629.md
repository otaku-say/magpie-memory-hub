# 红队靶场验收测试报告 (checkpoint_adversarial_v629.md)

## 1. 任务背景与执行环境基线
- **报告生成时间**: 2026-10-19
- **测试执行角色**: 独立红队测试与验收门禁 Agent（背靠背独立于开发 Agent 1、前端 Agent 2）
- **基线 Commit**: `4d67847` (v6.28.3)
- **代码分支**: `qa/adversarial-v629-gate` (独立 worktree 分支)
- **专属沙箱环境**:
  - 沙箱 ID: `3119588a1ccc45728ee1e8c0da62f594`
  - 沙箱工作目录: `/workspace/magpie-memory-hub`
  - 运行时环境: Node.js `v24.18.1` (Linux aarch64 musl)
- **测试元规范遵从**:
  - 完全遵从 `tests/test_meta.mjs` 防线约束：
    1. 零外部网络依赖（纯内存/受控 Mock 桩仿真）
    2. Project 独立命名空间隔离（`__test__<ts>_<rand>`）
    3. 严禁向 `project='global'` 写入
    4. 执行完毕后强制 cleanup，断言清理后残余为 0（`residue === 0`）
    5. 具备确定性非 0 退出路径（门禁未通时严格 `process.exit(1)`）
    6. 无空 catch 块假过

---

## 2. 6 大核心缺陷靶场用例设计与反证矩阵

| 序号 | 缺陷代号 | 漏洞类型 | 靶场设计原则与对抗手法 | 未修复代码反证表现 (RED) | 修复验收标准 (GREEN 判据) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **靶子 1** | **P0-1** | **字段投影漏洞** | Mock Client 严格按 `params.columns` 裁剪字段（未选列设为 undefined，模拟真实 `mcp_client.js` SELECT 投影）；构造过期临时记忆 (`expires_at="2020-01-01"`) 与软失效记忆 (`invalid_at` 非空)。 | ❌ **RED**: `tools.js:607-624` 查询投影列缺失 `invalid_at` 和 `expires_at`，Mock 裁剪后 `isMemoryValid` 接收到 undefined，两项无效记录 100% 泄漏至 search 结果。 | `memorySearch` 返回结果 100% 过滤这两条记录，仅返回合法活跃记忆。 |
| **靶子 2** | **P0-2** | **游标跨表混用漏检** | 模拟 memories 表自增 ID 达 500、pitfalls 表自增 ID 仅 20。首轮增量巡检生成游标后，在 pitfalls 插入 ID 21..30 的 10 条新记录，再执行增量巡检。 | ❌ **RED**: `tools.js:1528` 跨表复用游标 `cursor.last_id=500`，导致 pitfalls 下推 `WHERE id > 500`，新增的 10 条踩坑记录全部被跳过，扫描数为 0。 | `scanned.pitfalls` 精确等于 10，游标双表独立拆分（`last_memory_id` 与 `last_pitfall_id`）。 |
| **靶子 3** | **P0-3** | **自然语言提炼语义比对与晋升** | 模拟大模型两次提炼相同语义但措辞微变的问题（如 `"Docker 启动失败: connection refused 127.0.0.1"` 与 `"Docker 服务启动报错 Connection Refused"`），连续调用两次 `recordPendingEvidence`。 | ❌ **RED**: `local_state.js:567` 仅通过字面字符串 key 匹配，无法识别语义变体，第 2 次调用新建孤立条目，count 保持为 1，`shouldGraduate` 为 false。 | 第 2 次调用命中语义相似项，count 累加至 2 (达到 `minEvidence=2`)，并触发 `shouldGraduate: true` 晋升。 |
| **靶子 4** | **P1-5** | **并发去重互斥锁** | 模拟 50ms 异步延迟，同时并发发起两个 `memoryAudit` 任务，制造重入竞态窗口。 | ❌ **RED**: `tools.js` 缺失 `_isAuditing` 互斥保护，后进入的任务未被拦截，两任务均全量执行完毕，存在并发重入重复写库风险。 | 后进入的任务被 `_isAuditing` 锁拦截，立即返回 `{ skipped: true, reason: "audit_in_progress" }`。 |
| **靶子 5** | **P1-8** | **memoryContext 准则无条件置顶** | 数据库中存在 `category === "principle"` 的架构准则记忆（如 `"全局禁止在 /root 幽灵目录作业"`），检索传入完全不相干的 query（如 `"React Hook 性能调优"`）。 | ❌ **RED**: `tools.js:801-829` 仅基于 query 关键词命中（`hit > 0`）过滤，准则关键词未命中被彻底丢弃，返回空 block。 | 返回的 context block 无条件置顶包含该条架构准则，不受 query 关键词无关影响。 |
| **靶子 6** | **P0-4** | **快照拉取异常安全** | 模拟底层网络中断与连接超时（Client 抛出 `ETIMEDOUT` 异常），触发信标执行 `sync_snapshot`。 | ❌ **RED**: `page_actions.js:306` 空 catch 吞掉异常，违规返回 `ok: true + memories: []`，会导致前端将空数组误当成正常快照全量覆写。 | 返回结果严格 fail-closed，必须为 `ok: false`，绝不允许返回 `ok: true + memories: []`。 |

---

## 3. 未修复代码上的反证执行实录

在未修复代码基线 (`commit 4d67847`) 上，执行 `node tests/adversarial_v629_gate.mjs`，运行实录如下：

```text
=================================================================
【红队独立质检验收门禁套件 tests/adversarial_v629_gate.mjs 启动】
=================================================================
[Gate Init] 测试隔离命名空间: __test__1792392995215_dff97eca

=======================================================
【靶子 1】P0-1 字段投影漏洞测试 (Field Projection Vulnerability)
=======================================================
  检索返回条目数: 3, 返回 ID 集合: [1, 3, 2]

❌ [RED 命中] 靶子 1 (P0-1 字段投影漏洞测试) 成功捕获预期缺陷！
   反证断言信息: [P0-1 字段投影漏洞反证成功] 过期临时记忆 (id=2) 竟泄漏在 search 结果中！原因：tools.js columns 未投影 expires_at 列，导致 isMemoryValid 判断失灵

=======================================================
【靶子 2】P0-2 游标跨表混用漏检测试 (Cursor Cross-Table Contamination)
=======================================================
  执行第一轮增量巡检（memories 自增 500，pitfalls 自增 20）...
  第一轮巡检完成，游标: {"previous_last_id":0,"current_last_id":500,"batch_size":1000}
  在 pitfalls 表新增 ID 21..30 的 10 条踩坑记录...
  执行第二轮增量巡检...
  第二轮巡检完成，扫描 pitfalls: 0 条 (期望: 10 条)

❌ [RED 命中] 靶子 2 (P0-2 游标跨表混用漏检测试) 成功捕获预期缺陷！
   反证断言信息: [P0-2 游标跨表混用反证成功] pitfalls 新增的 10 条记录 (ID 21..30) 完全漏检！实际扫描 0 条。原因：tools.js:1528 cursor.last_id=500 跨表污染 pitfalls 查询，导致 where id > 500

0 !== 10

=======================================================
【靶子 3】P0-3 自然语言提炼语义比对与晋升靶场 (Semantic Dedup & Graduation)
=======================================================
  第 1 次提炼: "Docker 启动失败: connection refused 127.0.0.1"
  第 1 次结果: count=1, shouldGraduate=false
  第 2 次提炼（自然语言措辞微变）: "Docker 服务启动报错 Connection Refused"
  第 2 次结果: count=1, shouldGraduate=false

❌ [RED 命中] 靶子 3 (P0-3 自然语言提炼语义比对与晋升靶场) 成功捕获预期缺陷！
   反证断言信息: [P0-3 语义比对与晋升缺陷反证成功] 自然语言措辞微变的相似问题未能累加 count！期望 count=2，实际 count=1

1 !== 2

=======================================================
【靶子 4】P1-5 并发去重互斥锁靶场 (Concurrent Audit Mutex)
=======================================================
  并发发起两个 memoryAudit 任务...
  任务 1 响应: action=DEDUP_REPORT, success=true, skipped=undefined
  任务 2 响应: action=DEDUP_REPORT, success=true, skipped=undefined

❌ [RED 命中] 靶子 4 (P1-5 并发去重互斥锁靶场) 成功捕获预期缺陷！
   反证断言信息: [P1-5 并发互斥锁缺陷反证成功] 并发调用的两个 memoryAudit 均未被拦截！无 _isAuditing 互斥锁保护，存在并发重入重复写库风险！(call1.skipped=undefined, call2.skipped=undefined)

=======================================================
【靶子 5】P1-8 memoryContext 准则无条件置顶靶场 (Principle Unconditional Pinning)
=======================================================
  调用 memoryContext，传入不相干 query: "React Hook 性能调优 useMemo useCallback"
  memoryContext 返回注入块:
(空 block)

❌ [RED 命中] 靶子 5 (P1-8 memoryContext 准则无条件置顶靶场) 成功捕获预期缺陷！
   反证断言信息: [P1-8 准则置顶缺陷反证成功] memoryContext 返回的 block 未包含架构准则！即便 query 完全不相关，category === 'principle' 准则必须无条件置顶！实际 block: ""

=======================================================
【靶子 6】P0-4 快照拉取异常安全靶场 (Sync Snapshot Fail-Closed)
=======================================================
  触发 sync_snapshot 信标，传入崩溃 client 模拟网络中断 (id=adversarial-sync-1792392995383)...
  runPendingAction 响应: {"ran":true,"op":"sync_snapshot","id":"adversarial-sync-1792392995383","executed":true,"result":{"ok":true,"at":1792392995384,"op":"sync_snapshot","title":"记忆快照拉取就绪","lines":["成功拉取 0 条活跃记忆快照供前端同步"],"memories":[]}}

❌ [RED 命中] 靶子 6 (P0-4 快照拉取异常安全靶场) 成功捕获预期缺陷！
   反证断言信息: [P0-4 快照异常安全缺陷反证成功] sync_snapshot 在网络/数据库抛错时违规返回 ok: true！这会导致前端误用空数组覆盖正常快照！res={"ok":true,"at":1792392995384,"op":"sync_snapshot","title":"记忆快照拉取就绪","lines":["成功拉取 0 条活跃记忆快照供前端同步"],"memories":[]}

true !== false

=================================================================
【红队独立质检靶场测试结果总览】
=================================================================
❌ [靶子 1] P0-1 字段投影漏洞测试: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P0-1 字段投影漏洞反证成功] 过期临时记忆 (id=2) 竟泄漏在 search 结果中！原因：tools.js columns 未投影 expires_at 列，导致 isMemoryValid 判断失灵
❌ [靶子 2] P0-2 游标跨表混用漏检测试: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P0-2 游标跨表混用反证成功] pitfalls 新增的 10 条记录 (ID 21..30) 完全漏检！实际扫描 0 条。原因：tools.js:1528 cursor.last_id=500 跨表污染 pitfalls 查询，导致 where id > 500
0 !== 10
❌ [靶子 3] P0-3 自然语言提炼语义比对与晋升靶场: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P0-3 语义比对与晋升缺陷反证成功] 自然语言措辞微变的相似问题未能累加 count！期望 count=2，实际 count=1
1 !== 2
❌ [靶子 4] P1-5 并发去重互斥锁靶场: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P1-5 并发互斥锁缺陷反证成功] 并发调用的两个 memoryAudit 均未被拦截！无 _isAuditing 互斥锁保护，存在并发重入重复写库风险！(call1.skipped=undefined, call2.skipped=undefined)
❌ [靶子 5] P1-8 memoryContext 准则无条件置顶靶场: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P1-8 准则置顶缺陷反证成功] memoryContext 返回的 block 未包含架构准则！即便 query 完全不相关，category === 'principle' 准则必须无条件置顶！实际 block: ""
❌ [靶子 6] P0-4 快照拉取异常安全靶场: FAIL (RED - 成功反证缺陷存在)
    破绽说明: [P0-4 快照异常安全缺陷反证成功] sync_snapshot 在网络/数据库抛错时违规返回 ok: true！这会导致前端误用空数组覆盖正常快照！res={"ok":true,"at":1792392995384,"op":"sync_snapshot","title":"记忆快照拉取就绪","lines":["成功拉取 0 条活跃记忆快照供前端同步"],"memories":[]}
true !== false

=================================================================
统计: 共运行 6 个靶场，通过 0 个，反证缺陷暴露 6 个
=================================================================

🚨 [红队门禁拦截] 检测到 6 个核心缺陷尚未修复 (RED 状态)！门禁已生效，阻止未达标代码合入。
（exit code: 1）
```

---

## 4. 测试元规范扫描结果 (test_meta.mjs)
在沙箱内运行 `node tests/test_meta.mjs`，全量 44 个测试合规扫描结果：
```text
=================================================================
【测试元检查】正在扫描 44 个测试文件规范合规性（已通过反证门拦截测试）
=================================================================

✓ [PASS] adversarial_v629_gate.mjs
✓ [PASS] adversarial_verify.mjs
✓ [PASS] check_schema_sync.mjs
✓ [PASS] settings_page_test.mjs
✓ [PASS] test_abort.mjs [写库+隔离+清理齐全]
✓ [PASS] test_all_20_tools_e2e.mjs [写库+隔离+清理齐全]
✓ [PASS] test_auto_dedup_and_undo.mjs [写库+隔离+清理齐全]
✓ [PASS] test_backend_acceptance.mjs
✓ [PASS] test_beacon.mjs
✓ [PASS] test_beacon_e2e.mjs
✓ [PASS] test_call_storm_fix.mjs [写库+隔离+清理齐全]
✓ [PASS] test_client_name.mjs
✓ [PASS] test_compress_template_dedup.mjs
✓ [PASS] test_configurable_models.mjs [写库+隔离+清理齐全]
✓ [PASS] test_dedup_and_audit.mjs [写库+隔离+清理齐全]
✓ [PASS] test_dedup_semantics.mjs
✓ [PASS] test_denoise_p0.mjs [写库+隔离+清理齐全]
✓ [PASS] test_exports.mjs
✓ [PASS] test_failopen.mjs
✓ [PASS] test_gateway_harvest.mjs [写库+隔离+清理齐全]
✓ [PASS] test_gateway_harvest_hooks.mjs [写库+隔离+清理齐全]
✓ [PASS] test_hardening.mjs
✓ [PASS] test_lookup_secret.mjs
✓ [PASS] test_mcp_only.mjs [写库+隔离+清理齐全]
✓ [PASS] test_model_in_loop.mjs [写库+隔离+清理齐全]
✓ [PASS] test_model_ux.mjs
✓ [PASS] test_multi_protocol.mjs
✓ [PASS] test_p0_external_fixes.mjs
✓ [PASS] test_pollution_guard.mjs
✓ [PASS] test_provision.mjs
✓ [PASS] test_r2_check_and_probe.mjs
✓ [PASS] test_r2_verify.mjs
✓ [PASS] test_schema.mjs
✓ [PASS] test_schema_defaults.mjs
✓ [PASS] test_search_enhancement_and_scale.mjs
✓ [PASS] test_secret_stale_eviction.mjs
✓ [PASS] test_sql_escape.mjs [写库+隔离+清理齐全]
✓ [PASS] test_state_bloat_and_dead_letter.mjs
✓ [PASS] test_status_race.mjs
✓ [PASS] test_stream_failopen.mjs
✓ [PASS] test_tool_names_static.mjs
✓ [PASS] test_traceability.mjs [写库+隔离+清理齐全]
✓ [PASS] verify_settings.mjs
✓ [PASS] verify_sub2.mjs

=================================================================
✅ 测试元检查全部通过！所有 44 个测试均符合隔离与严谨性规范。
=================================================================
```

---

## 5. 红队交付物与 Git 追踪
- **新增文件**: `tests/adversarial_v629_gate.mjs`
- **更新文件**: `tests/test_meta.mjs` (活跃测试文件数由 43 更新至 44)
- **文档文件**: `checkpoint_adversarial_v629.md`
- **Git 目标分支**: `origin qa/adversarial-v629-gate`
- **门禁验收令**: 开发 Agent 1 与前端 Agent 2 完成修复后，必须在沙箱内运行 `node tests/adversarial_v629_gate.mjs` 达成 6/6 靶场全绿（GREEN）且 exit code 0，方准发起主线合并！
