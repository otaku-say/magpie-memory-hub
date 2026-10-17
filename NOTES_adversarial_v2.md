# 对抗测试记录 NOTES_adversarial_v2.md

## 轮次概览
- **基准上游 Magpie Commit**：`e085d6e9262786815c0f6c5ff65c5a585916cc9e`（Sat Oct 17 12:04:53 2026 +0800）—"cli, gateway: magpie heap writes the running magpie's Go heap profile, with its memory numbers"
- **测试环境数据库基准行数**：`memories = 0, pitfalls = 0`（NCB 数据库 `41694_agent_memory`，0 污染）

---

## 轮 1：主动攻击与发现（发现 8 项缺陷）

### 发现清单
1. **[BUG 1 - page_actions.js] `parseDbInfo` 逻辑库名被 `opHint` 静默覆写**：
   - 现象：`writeCardStatus("ncb", res, "ncb_check")` 会把 `opHint`（如 `"ncb_check"`）作为 fallback 传给 `parseDbInfo`。`parseDbInfo` 的 `directMatch` 分支错误地优先使用 fallback，导致 `db.logical` 被篡改为 `"ncb_check"`。
   - 根因：`directMatch` 分支写成了 `fallback && !/^\d+_/.test(fallback) ? fallback : directMatch[2]`。
   - 影响：设置页状态 `_status.js` 中 `db.logical` 变成操作名，破坏状态数据一致性。

2. **[BUG 2 - tools.js] `pitfallSave` 彻底丢弃 `content_fingerprint` 与 `recurrence`**：
   - 现象：`gateway_harvest.js` 提炼出的去噪指纹 `pFp`（基于掩码后文本）和 `recurrence` 传给 `pitfallSave` 后被完全丢弃，重新用 raw symptom 计算哈希，并写死 `recurrence: 1`。
   - 根因：`tools.js` 的 `pitfallSave` 未支持接收传入的 `content_fingerprint` 与 `recurrence` 参数。
   - 影响：P2 存储字段与指纹分离彻底破产，入库指纹退化为原文哈希，导致同类不同参数的错误无法聚类与累计。

3. **[BUG 3 - gateway_harvest.hooks.js] 重复踩坑未更新 `recurrence` 与 `last_occurred_at`**：
   - 现象：当已知 pitfall 再次被观察到时，查重 `isDupe === true` 仅执行 `markRecent; continue;`，未在远端数据库更新频次。
   - 根因：缺少更新分支。
   - 影响：远端库中的踩坑频次永远停留在初始值，无法如实反映高频复发踩坑。

4. **[BUG 4 - gateway_harvest.js] 双轨制穿透门禁被模型回复普通「注意：」滥用**：
   - 现象：`isExplicitUserMemory` 扫描包含 `[assistant]: ...` 的完整文本，当助手说「注意：请使用 pip 安装...」时，误判为显式用户意图并穿透 P0 门禁。
   - 根因：未限定在用户发言段内，且未限定指令起始位置。
   - 影响：大量常规助手解释直接穿透门禁落盘，严重破坏 P0 去噪门禁。

5. **[BUG 5 - gateway_harvest.js & hooks.js] `pending_patterns` 暂存队列缺少项目隔离**：
   - 现象：pitfall 暂存 key 仅为 `p:${fp}`（fp 无项目），导致测试项目（如 `__test__`）与用户 `global` 项目共享同一个 pending 计数器，造成跨项目状态污染与计数竞争。
   - 根因：未带 `project` 命名空间。
   - 影响：测试跑批会误将用户的 pending 项提早毕业或清理，违背隔离原则。

6. **[BUG 6 - harvest.py] Python 离线管线与 JS 主管线实现分叉**：
   - 现象：`harvest.py` 默认 `min_evidence = 5`（JS 为 3）；缺少 `is_explicit_user_memory` 双轨穿透；`save_pitfall` 与 `record_pitfall` 丢弃 `p["content_fingerprint"]`；`process_turn` 硬编码覆写 `component = "auto"`。
   - 根因：双语同逻辑未同步对齐。
   - 影响：Python 扫描管线行为与网关异步钩子管线行为不一致。

7. **[BUG 7 - local_state.js] TTL 清理对无时间戳或 0 时间戳项静默失效（永生僵尸）**：
   - 现象：`v && v.last_seen && (now - v.last_seen > ttlMs)`，当条目损坏缺少 `last_seen` 或值为 0 时跳过，永远无法被清理。
   - 根因：假定 `v.last_seen` 必然存在且为正数。
   - 影响：损坏的脏数据长期常驻 `pending_patterns`。

8. **[BUG 8 - test_denoise_p0.mjs] 弱断言与缺失反证**：
   - 现象：测试 7 仅断言 `mineFailures` 内存返回值，未断言 `pitfallSave` 真实入库指纹；缺少助手「注意：」不穿透的反证测试；缺少 pending 跨项目隔离测试。
   - 根因：测试覆盖不完整，导致 BUG 2 与 BUG 4 长期潜伏。

---

## 轮 1 已修记录
- `page_actions.js`：修正 `parseDbInfo` 提取逻辑，优先保留 `directMatch[2]` 真实逻辑名；`writeCardStatus` 移除错误的 `opHint` 作为 fallback 传递。
- `tools.js`：`pitfallSave` 允许传入 `content_fingerprint` 与 `recurrence`，去重命中时累加 `recurrence` 并更新 `last_occurred_at`。
- `gateway_harvest.hooks.js`：踩坑查重命中时执行 `client.update` 累加 `recurrence` 并刷新 `last_occurred_at`；踩坑 pending key 增加 `project` 命名空间。
- `gateway_harvest.js`：`isExplicitUserMemory` 增加角色分段识别，过滤助手发言段，仅在用户段检测起始显式意图；踩坑 pending key 增加 `targetProject` 命名空间。
- `harvest.py`：对齐默认 `min_evidence = 3`；实现 `is_explicit_user_memory` 判定；`save_pitfall` 与 `record_pitfall` 优先使用 `content_fingerprint`；`process_turn` 保留 `mine_failures` 推导出的 `component`。
- `local_state.js`：新增 `getEntryTimestamp`，严格校验时间戳有效性，在清理和容量淘汰中彻底清除 0 时间戳和损坏项；容量超限采用 `while` 循环确保绝不越界。
- `tests/test_denoise_p0.mjs`：增加助手「注意：」不穿透反证测试；增加 `pitfall_save` 指纹与频次真实入库强断言；增加 pending 跨项目隔离测试；增加脏条目自愈测试。

---

## 轮 2：复验与二次攻击（零发现，收敛达成）
- **扫描范围**：
  - 静态工具名检查：`node tests/test_tool_names_static.mjs` -> 全绿 (0 errors)
  - 架构与表结构同步：`node tests/check_schema_sync.mjs` -> 全绿
  - 核心元检查规范：`node tests/test_meta.mjs` -> 30 个测试规范全部 PASS
  - 降噪专项全量测试：`node tests/test_denoise_p0.mjs` -> 10 个专项与反证测试全部 PASS，残余为 0
  - 网关提炼双通道回归：`node tests/test_gateway_harvest.mjs` & `node tests/test_gateway_harvest_hooks.mjs` -> 全部 PASS
  - 生产库零污染守卫：`node tests/test_pollution_guard.mjs` -> 29 个全量测试跑通，生产库行数跑前跑后严格 `memories=0, pitfalls=0`（绝对零污染）
- **攻击方向排查**：
  1. 门禁计数器绕过/指纹碰撞：已加项目命名空间，隔离测试通过。
  2. 弱断言：已补强端到端指纹入库校验与反证门。
  3. 未声明变量：全量 `node --check` 与 `python3 -m py_compile` 校验无误。
  4. 静默失效：工具名全集静态扫描无未知引用。
  5. 双轨制滥用：助手回复解释性「注意：」已加角色段隔离，反证拦截通过。
- **轮 2 发现数**：0
- **收敛状态**：已收敛（轮 1 发现 8 项并已全部修复验证；轮 2 零发现）。
