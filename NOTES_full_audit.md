# NOTES_full_audit.md — magpie-memory-hub 全量端到端检测与审计记录

- 版本: v6.17.0 (前序版本 `v6.16.0` commit `2c0bf9f`)
- 审计时间: 2026-10-18
- 目标:
  1. 20 个 MCP 工具逐个真实调用（严格隔离命名空间、零残留清理断言、非破坏性调用）
  2. 真实数据库表/字段/字段类型逐列核对（`get_schema` vs `schema.js`）
  3. 全链路与关键不变量检测（多协议注入、历史前缀字节级不变、流式剥离、fail-open、显式保存绝不接模型、设置页信标与卡片、R2守卫与探针、在线模型四项能力、打包白名单、库名密钥三级解析）
  4. 发现问题整改与全套测试回归验证

---

## 一、20 个 MCP 工具全量真实调用验证结果

测试基于 `tests/test_all_20_tools_e2e.mjs`，数据库 `41694_agent_memory`，隔离命名空间 `__test__...`，测试结束强制执行清理并断言残余为 0。

| # | 工具名称 | 调用方式 | 真实返回（截要） | 判定 | 说明 / 根因说明 |
|---|---|---|---|---|---|
| 1 | `db_status` | `tools.db_status.execute({}, {})` | `{"ok":true,"database":"41694_agent_memory","schema_version":4,"initialized":true,"pending":{"total":0}}` | 正常 | 结构完整已就绪，只读探测无污染 |
| 2 | `db_init` | `tools.db_init.execute({}, {})` | `{"ok":true,"database":"41694_agent_memory","action":"NOOP","note":"结构已完整，无需改动"}` | 正常 | 幂等无操作，只增不删策略生效 |
| 3 | `db_provision` | `tools.db_provision.execute({database, on_exist: 'reuse'}, {})` | `{"ok":true,"action":"REUSED","database":"41694_agent_memory","existed_before":true}` | 正常 | 自动检测并复用已有库，绝不重复建库劈开数据 |
| 4 | `db_reset` | `tools.db_reset.execute({}, {})` (无 confirm) + mock 执行验证 | `{"ok":false,"action":"CONFIRM_REQUIRED","will_drop":["schema_meta","pitfalls","memories"]}` | 正常 | 真实库强制二次确认门禁拦截；执行 DROP 在打桩环境通过，真实库 0 触碰 |
| 5 | `ncb_check` | `tools.ncb_check.execute({}, {})` | `{"ok":true,"verdict":"VERIFIED","database_exists":true,"schema":{"initialized":true}}` | 正常 | 凭据与目标数据库、表结构完整度核验通过 |
| 6 | `memory_save` | `tools.memory_save.execute({project: env.project, title, content, ...})` | `{"action":"ADD","id":759}` (JSON字符串) | 正常 | 隔离命名空间成功持久化，返回有效主键 ID |
| 7 | `memory_get` | `tools.memory_get.execute({id: 759}, {})` | `{"id":759,"project":"__test__...","title":"E2E Test Memory", ...}` | 正常 | 准确获取全文字段，并触发检索计数与时间戳更新 |
| 8 | `memory_list` | `tools.memory_list.execute({project: env.project}, {})` | `{"total_active":1,"returned":1,"memories":[{"id":759,...}]}` | 正常 | 按隔离 project 准确列出活跃记忆 |
| 9 | `memory_search` | `tools.memory_search.execute({query, project}, {})` | `{"total_active":1,"matched":1,"returned":1,"memories":[{"id":759,...}]}` | 正常 | 双路召回检索成功命中目标条目 |
| 10 | `memory_context` | `tools.memory_context.execute({query, project}, {})` | `{"injected":1,"chars":110,"block":"[Persistent Memory Context]\n..."}` | 正常 | 格式化上下文块输出完整，受预算约束 |
| 11 | `memory_forget` | `tools.memory_forget.execute({id: 759}, {})` | `{"action":"SOFT_DELETE","forgotten":1,"items":[{"id":759,...}]}` | 正常 | 软失效（写 invalid_at），保留审计链 |
| 12 | `pitfall_save` | `tools.pitfall_save.execute({project, component, symptom, ...})` | `{"action":"ADD","id":62}` (JSON字符串) | 正常 | 隔离命名空间成功落库，指纹排重生效 |
| 13 | `pitfall_search` | `tools.pitfall_search.execute({query, project}, {})` | `{"total_pitfalls":1,"matched":1,"returned":1,"pitfalls":[{"id":62,...}]}` | 正常 | 关键词多字段联合打分召回成功 |
| 14 | `harvest_gateway` | `tools.harvest_gateway.execute({dir: '/tmp/nonexistent...', project}, {})` | `{"success":true,"has_conversations":false,"message":"未检测到对话录制..."}` | 正常 | 目录不存在时优雅降级并输出友好提示 |
| 15 | `storage_guide` | `tools.storage_guide.execute({}, {})` | `{"ok":true,"endpoint":"Cloudflare R2...","capabilities":{...}}` | 正常 | 准确说明可用与不可用接口能力边界 |
| 16 | `storage_setup` | `tools.storage_setup.execute({}, {})` | `{"ok":true,"verdict":"VERIFIED","database":"41694_agent_memory","bucket_name":"41694-agent-memory"}` | 正常 | R2 挂载通道验证，探针探测就绪 |
| 17 | `storage_upload` | `tools.storage_upload.execute({filename, content}, {})` | `{"ok":true,"via":"mcp","url":"https://...r2.cloudflarestorage.com/..."}` | 需修→已修复 | 详见问题 1：当数据库重建导致 Secret Key 失效报 403 时，自动平滑后备降级走 MCP `upload_file` 直传成功 |
| 18 | `storage_list` | `tools.storage_list.execute({limit: 10}, {})` | `{"ok":false,"error":"HTTP 403","hint":"数据库 Secret Key 无效（可能数据库已重建换了新密钥）..."}` | 需修→已修复 | 详见问题 2：NCB MCP 无 list 端点必须走 Secret Key，针对 403 补充人话报错诊断与指引 |
| 19 | `storage_delete` | `tools.storage_delete.execute({key: "test_key.txt"}, {})` | `{"ok":false,"action":"CONFIRM_REQUIRED","warning":"删除不可恢复..."}` | 正常 | 破坏性接口强二次确认门禁拦截生效；补充 Secret Key 403 明确排查指引 |
| 20 | `r2_check` | `tools.r2_check.execute({}, {})` | `{"ok":true,"verdict":"VERIFIED","database":"41694_agent_memory"}` | 正常 | 真实探针检测通过，凭据与通道可用 |

---

## 二、真实数据库表/字段/字段类型逐列核对表

对比基准：`schema.js` TABLES 声明 vs NCB 远端真实返回（`get_schema` 实时接口，数据库 `41694_agent_memory`）。

### 1. `memories` 表（声明 25 列，真实 25 列）
| # | 列名 | 声明类型 | 真实类型 | 类型匹配 | 声明可空 | 真实可空 | 可空匹配 | 声明默认值 | 真实默认值 / 说明 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `id` | INT | integer | ✓ | 否 (PK) | 否 | ✓ | AUTO_INCREMENT | AUTO_INCREMENT |
| 2 | `project` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `'global'` | `'global'` |
| 3 | `category` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `'fact'` | `'fact'` |
| 4 | `scope_level` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `'project'` | `'project'` |
| 5 | `client` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `'unknown'` | `'unknown'` |
| 6 | `origin` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `'tool'` | `'tool'` |
| 7 | `title` | VARCHAR | string | ✓ | 否 | 否 | ✓ | 无 | 无 |
| 8 | `content` | TEXT | string | ✓ | 否 | 否 | ✓ | 无 | 无 |
| 9 | `full_text` | TEXT | string | ✓ | 是 | 是 | ✓ | 无 | NULL |
| 10 | `tags` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `''` | NULL (代码层显式兜底) |
| 11 | `related_entities` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `''` | NULL (代码层显式兜底) |
| 12 | `content_fingerprint` | VARCHAR | string | ✓ | 否 | 否 | ✓ | 无 | 无 (唯一索引字段) |
| 13 | `confidence_score` | INT | integer | ✓ | 是 | 是 | ✓ | 100 | 100 |
| 14 | `retrieval_count` | INT | integer | ✓ | 是 | 是 | ✓ | 0 | 0 |
| 15 | `lifecycle_status` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `'active'` | `'active'` |
| 16 | `superseded_by_id` | INT | integer | ✓ | 是 | 是 | ✓ | NULL | NULL (外键安全约束) |
| 17 | `revision` | INT | integer | ✓ | 是 | 是 | ✓ | 1 | 1 |
| 18 | `last_used_at` | DATETIME | datetime | ✓ | 是 | 是 | ✓ | NULL | NULL |
| 19 | `expires_at` | DATETIME | datetime | ✓ | 是 | 是 | ✓ | NULL | NULL |
| 20 | `invalid_at` | DATETIME | datetime | ✓ | 是 | 是 | ✓ | NULL | NULL |
| 21 | `invalid_reason` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `''` | NULL (代码层显式兜底) |
| 22 | `source_session` | VARCHAR | string | ✓ | 是 | 是 | ✓ | NULL | NULL (可追溯性) |
| 23 | `source_turn` | INT | integer | ✓ | 是 | 是 | ✓ | NULL | NULL (可追溯性) |
| 24 | `created_at` | DATETIME | datetime | ✓ | 是 | 是 | ✓ | CURRENT_TIMESTAMP | NULL (平台不生效，代码层 nowSql 显式写入) |
| 25 | `updated_at` | DATETIME | datetime | ✓ | 是 | 是 | ✓ | CURRENT_TIMESTAMP | NULL (平台不生效，代码层 nowSql 显式写入) |

### 2. `pitfalls` 表（声明 19 列，真实 19 列）
| # | 列名 | 声明类型 | 真实类型 | 类型匹配 | 声明可空 | 真实可空 | 可空匹配 | 声明默认值 | 真实默认值 / 说明 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `id` | INT | integer | ✓ | 否 (PK) | 否 | ✓ | AUTO_INCREMENT | AUTO_INCREMENT |
| 2 | `project` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `'global'` | `'global'` |
| 3 | `client` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `'unknown'` | `'unknown'` |
| 4 | `component` | VARCHAR | string | ✓ | 否 | 否 | ✓ | 无 | 无 |
| 5 | `symptom` | TEXT | string | ✓ | 否 | 否 | ✓ | 无 | 无 |
| 6 | `root_cause` | TEXT | string | ✓ | 否 | 否 | ✓ | 无 | 无 |
| 7 | `solution` | TEXT | string | ✓ | 否 | 否 | ✓ | 无 | 无 |
| 8 | `severity` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `'medium'` | `'medium'` |
| 9 | `error_type` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `'general'` | `'general'` |
| 10 | `tags` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `''` | NULL (代码层显式兜底) |
| 11 | `content_fingerprint` | VARCHAR | string | ✓ | 否 | 否 | ✓ | 无 | 无 (唯一索引字段) |
| 12 | `recurrence` | INT | integer | ✓ | 是 | 是 | ✓ | 1 | 1 |
| 13 | `invalid_at` | DATETIME | datetime | ✓ | 是 | 是 | ✓ | NULL | NULL |
| 14 | `invalid_reason` | VARCHAR | string | ✓ | 是 | 是 | ✓ | `''` | NULL (代码层显式兜底) |
| 15 | `last_occurred_at` | DATETIME | datetime | ✓ | 是 | 是 | ✓ | CURRENT_TIMESTAMP | NULL (代码层 nowSql 写入) |
| 16 | `source_session` | VARCHAR | string | ✓ | 是 | 是 | ✓ | NULL | NULL |
| 17 | `source_turn` | INT | integer | ✓ | 是 | 是 | ✓ | NULL | NULL |
| 18 | `created_at` | DATETIME | datetime | ✓ | 是 | 是 | ✓ | CURRENT_TIMESTAMP | NULL (代码层 nowSql 写入) |
| 19 | `updated_at` | DATETIME | datetime | ✓ | 是 | 是 | ✓ | CURRENT_TIMESTAMP | NULL (代码层 nowSql 写入) |

### 3. `schema_meta` 表（声明 4 列，真实 4 列）
| # | 列名 | 声明类型 | 真实类型 | 类型匹配 | 声明可空 | 真实可空 | 可空匹配 | 声明默认值 | 真实默认值 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `id` | INT | integer | ✓ | 否 (PK) | 否 | ✓ | AUTO_INCREMENT | AUTO_INCREMENT |
| 2 | `k` | VARCHAR | string | ✓ | 否 | 否 | ✓ | 无 | 无 (唯一索引) |
| 3 | `v` | TEXT | string | ✓ | 是 | 是 | ✓ | 无 | NULL |
| 4 | `updated_at` | DATETIME | datetime | ✓ | 是 | 是 | ✓ | CURRENT_TIMESTAMP | NULL |

**表结构核对结论**：
- 真实库表列数与声明 100% 对齐（25+19+4=48 列，0 冗余列，0 缺失列）。
- 类型完全等价匹配（`INT`↔`integer`，`VARCHAR/TEXT`↔`string`，`DATETIME`↔`datetime`）。
- 主键与唯一索引约束生效。NCB 的两个已知平台特性（不生效 `DEFAULT CURRENT_TIMESTAMP`、`DEFAULT ''` 转为 `DEFAULT NULL`）在代码层（`nowSql()`、空值属性合并等）全部做到了严格的兜底保障。

---

## 三、发现的问题清单与修复消除记录

### 问题 1: `storage_upload` 在数据库重建导致 Secret Key 失效时未降级后备至 MCP `upload_file`
- **现象**：当数据库重建后，本地缓存的历史 Secret Key 失效，调用 `storage_upload` 直接返回 HTTP 403 `{"error": "Invalid secret_key."}`，上传失败。
- **复现**：配置有效 `mcp_key` 但 `ncb_secret` 为旧密钥，调用 `storage_upload({ filename: "a.txt", content: "..." })`。
- **根因**：`r2Upload` 工具描述声明支持「走数据库 Secret Key 或 MCP Key 直传」，但在代码实现中，一旦检测到存在 `secret`，便只尝试 REST multipart，遇到 403/401 报错时直接 return 失败结果，未回退后备至 `mcp.uploadFile`。
- **修法**：在 `r2.js` 的 `r2Upload` 中，当 REST multipart 上传抛出异常或返回 HTTP ≥ 400 时，不直接宣告失败，而是平滑回退降级到 MCP `clientOf(cfg).uploadFile(...)` 通道完成直传。
- **消除验证**：实测调用 `storage_upload`，在 Secret Key 报 403 时自动触发 MCP 后备通道，成功上传到 R2 并返回公开 URL：`https://...r2.cloudflarestorage.com/...`（`via: "mcp"`，`ok: true`）。

### 问题 2: `storage_list` 与 `storage_delete` 遇 403 缺乏人话排查指引
- **现象**：当数据库 Secret Key 失效时，调用 `storage_list` 返回冰冷的 `{"error": "HTTP 403", "body": {"error": "Invalid secret_key."}}`，Agent 或用户不知道原因。
- **复现**：以旧 Secret Key 调用 `storage_list`。
- **根因**：NoCodeBackend MCP 原生 23 个工具中未提供 `list_files` / `delete_file` 接口，这两个操作底层只能依赖数据库 Secret Key 发起 REST 调用；当密钥因重建失效时，REST 接口拒绝访问，缺乏业务层错误转换。
- **修法**：在 `r2.js` 的 `r2List` 和 `r2Delete` 错误分支中，针对 403 / `Invalid secret_key` 显式附带 `hint`，明确解释平台架构边界（MCP 服务未提供列举/删除文件能力，必须使用 Secret Key）并指引用户前往控制台复制最新密钥。
- **消除验证**：调用 `storage_list` 返回中附带 `hint: "数据库 Secret Key 无效（可能数据库已重建换了新密钥）。列出文件必须使用 Secret Key（NCB MCP 未提供 list_files 工具）。请在 NoCodeBackend 控制台复制最新的 Secret Key 填入设置页。"`。

### 问题 3: `forgetR2Mount` 清除挂载后被 `_status.json` 僵尸复活
- **现象**：运行 `test_lookup_secret.mjs` 时，`forgetR2Mount` 执行后调用 `isR2Mounted` 断言未挂载失败，仍返回 `mounted: true`。
- **复现**：在 `_status.json` 中存在历史 `r2.ok: true` 的情况下，调用 `forgetR2Mount("41694_agent_memory")`，随后 `isR2Mounted({}, "41694_agent_memory")` 返回 true。
- **根因**：
  1. `forgetR2Mount` 仅删除了 `state.json` 中的 `r2_mounts` 项，未清理宿主 cwd 下的 `_status.json`；
  2. `isR2Mounted` 在本地状态无记录时，会后备读取 `_status.json` 的历史状态，从而把刚解绑的库「僵尸复活」并重新写入 `state.json`；
  3. `lookupR2Mount` 中的第 ③ 级「唯一记录兜底」在调用方限定了具体库名但库名不匹配时，依然武断返回唯一记录，造成跨库串台。
- **修法**：
  1. `local_state.js` 的 `forgetR2Mount` 在删除 `state.json` 记录的同时，同步清除 `_status.json` 中的 `r2` 卡片项；
  2. `lookupR2Mount` 修复第 ③ 级兜底：仅在未限定目标库名，或目标库名归一化后与唯一记录同源时才生效，杜绝跨库误取。
- **消除验证**：`test_lookup_secret.mjs` 中的 `隐患1验证: forgetR2Mount 成功清除失效挂载` 与 `隐患1延伸: r2Check 失败清除失效挂载记录` 全部 100% 绿灯通过。

---

## 四、全套自动化测试真实执行输出

执行命令：`node tests/test_meta.mjs` & 全量 32 套件回归运行。

```
=================================================================
【测试元检查】正在扫描 32 个测试文件规范合规性（已通过反证门拦截测试）
=================================================================

✓ [PASS] adversarial_verify.mjs
✓ [PASS] check_schema_sync.mjs
✓ [PASS] settings_page_test.mjs
✓ [PASS] test_abort.mjs [写库+隔离+清理齐全]
✓ [PASS] test_all_20_tools_e2e.mjs [写库+隔离+清理齐全]
✓ [PASS] test_backend_acceptance.mjs
✓ [PASS] test_beacon.mjs
✓ [PASS] test_beacon_e2e.mjs
✓ [PASS] test_compress_template_dedup.mjs
✓ [PASS] test_configurable_models.mjs [写库+隔离+清理齐全]
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
✓ [PASS] test_provision.mjs
✓ [PASS] test_r2_verify.mjs
✓ [PASS] test_schema.mjs
✓ [PASS] test_schema_defaults.mjs
✓ [PASS] test_sql_escape.mjs [写库+隔离+清理齐全]
✓ [PASS] test_status_race.mjs
✓ [PASS] test_tool_names_static.mjs
✓ [PASS] test_traceability.mjs [写库+隔离+清理齐全]
✓ [PASS] verify_settings.mjs
✓ [PASS] verify_sub2.mjs

=================================================================
✅ 测试元检查全部通过！所有 32 个测试均符合隔离与严谨性规范。
=================================================================
```

全量测试套件执行耗时与结果摘要：
```
Running 32 test files...
  adversarial_verify.mjs             ... ✓ PASS (362ms)
  check_schema_sync.mjs              ... ✓ PASS (1460ms)
  settings_page_test.mjs             ... ✓ PASS (13620ms)
  test_abort.mjs                     ... ✓ PASS (688ms)
  test_all_20_tools_e2e.mjs          ... ✓ PASS (27038ms)
  test_backend_acceptance.mjs        ... ✓ PASS (13444ms)
  test_beacon.mjs                    ... ✓ PASS (570ms)
  test_beacon_e2e.mjs                ... ✓ PASS (10901ms)
  test_compress_template_dedup.mjs   ... ✓ PASS (1373ms)
  test_configurable_models.mjs       ... ✓ PASS (5042ms)
  test_denoise_p0.mjs                ... ✓ PASS (662ms)
  test_exports.mjs                   ... ✓ PASS (562ms)
  test_failopen.mjs                  ... ✓ PASS (676ms)
  test_gateway_harvest.mjs           ... ✓ PASS (688ms)
  test_gateway_harvest_hooks.mjs     ... ✓ PASS (2706ms)
  test_hardening.mjs                 ... ✓ PASS (2789ms)
  test_lookup_secret.mjs             ... ✓ PASS (470ms)
  test_mcp_only.mjs                  ... ✓ PASS (2999ms)
  test_meta.mjs                      ... ✓ PASS (470ms)
  test_model_in_loop.mjs             ... ✓ PASS (5558ms)
  test_model_ux.mjs                  ... ✓ PASS (4541ms)
  test_multi_protocol.mjs            ... ✓ PASS (461ms)
  test_provision.mjs                 ... ✓ PASS (3019ms)
  test_r2_verify.mjs                 ... ✓ PASS (3524ms)
  test_schema.mjs                    ... ✓ PASS (351ms)
  test_schema_defaults.mjs           ... ✓ PASS (462ms)
  test_sql_escape.mjs                ... ✓ PASS (455ms)
  test_status_race.mjs               ... ✓ PASS (705ms)
  test_tool_names_static.mjs         ... ✓ PASS (471ms)
  test_traceability.mjs              ... ✓ PASS (562ms)
  verify_settings.mjs                ... ✓ PASS (14229ms)
  verify_sub2.mjs                    ... ✓ PASS (364ms)

Total: 32, Passed: 32, Failed: 0
```
