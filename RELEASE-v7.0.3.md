# v7.0.3 —— 让 `env_scope` 读得回来

在真实生产库上做回环校验时发现的漏洞：**列写进去了，但没有任何工具能把它读出来**。

## 现象

`db_status` 显示 schema v7、`missing_columns: []`，`memory_save` 带 `env_scope` 写入成功，
但 `memory_get(40)` 返回的字段里没有 `env_scope`。

原因：这些工具的输出不是原始行，而是**字段白名单**（逐字段显式列出）。
`env_scope` 不在白名单里，就永远看不到。

## 为什么这是问题

注入卡片会给受限记忆打上〔仅 os=windows〕的标，并附上 `id=…`。
一旦用户问「为什么这条没召回 / 为什么召回了」，唯一能查的就是那个 id——
可 `memory_get` 不显示作用域，**标注无法溯源**。
一个可解释性靠后端的特性，结果是前端看不见。

## 改动

| 位置 | 改动 |
|---|---|
| `src/tools/memory-get.js` 记忆投影 | 加 `env_scope: hit.env_scope \|\| ""` |
| `src/tools/memory-get.js` 踩坑投影 | 同上 |
| `src/tools/memory-search.js` 结果投影 | 加 `env_scope: x.row.env_scope \|\| null` |

`memory_context` / `pitfall_search` / `memory_list` 返回原始行，不需要改。

无作用域时回显空串 / `null`，不伪造、不改语义。

## 验证

```
test_v700_env_scope   17 项（新增 3 项回显用例）
test_v700_capability_gate   44 项
tests/e2e/gateway-real      15 项
全量：96 套件通过 / 4 跳过 / 0 失败
```

附加一份真实生产回环证据：当前的库 `41694_agent_memory` 已确认 `schema_version: 7`、
`pending.total: 0`，`memory_save` 带 `env_scope` 写入与 `memory_forget` 软失效均正常。
