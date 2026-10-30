# v7.0.1 —— 元工具分发器（Cindy / pi 形态）修复

v7.0.0 上线后，Cindy 自己收到的注入变成了「能力未确认」——而它完全能调记忆工具。

## 根因

Cindy / pi 这类宿主**不把 MCP 工具直标在 `body.tools` 里**，而是包在一个通用分发器后面
（`cindy_mcp_call_tool` / `run_code` 等），真正的工具名只是分发器的一个参数。
于是 `detectCapabilities()` 看不到 `magpie-memory-hub_memory_context`，全部降到档 1。

这不是检测写错了，是**分档设计漏了一整类客户端**：把「保守」当成了「正确」。

## 修法：新增档 1.5

| 档 | 条件 | 行为 |
|---|---|---|
| 0 | 未通告任何工具 | 整块不注入 |
| 1 | 有工具、没分发器、没本插件工具 | 「能力未确认」 |
| **1.5** | **有元工具分发器** | **「经分发器可用」：给查找键 + 唯一入口** |
| 2 | 通告了本插件工具 | 用真实名 |

档 1.5 的文本长这样：

```
[Memory Agent Guide —— 经分发器可用]
- 本会话未直接通告记忆工具，但存在通用工具分发器 `cindy_mcp_call_tool`：记忆工具很可能包在它后面。
- 查找键：检索类工具名形如 memory_context / memory_search / pitfall_search，写入类形如 memory_save / pitfall_save，展开单条形如 memory_get。先按分发器自身的方式枚举，确认清单里确实含有这些名字再动手。
- 唯一入口：一旦确认，必须**经分发器**调用；不得把这些名字当普通工具直接调（大多数客户端会直接报工具不存在）。
- 若枚举后发现没有本插件的工具，直接以上面的上下文作答，禁止猜名字、禁止声称已保存。
- 保存必须是真的：分发器未返回成功前，不得声称「已记住」，也不得编造返回的 id。
```

两个约束缺一不可：

- **不给查找键** → 模型不知道去找什么，等于退回档 1 的“什么都不做”；
- **不给唯一入口** → 模型会拿查找键当普通工具直接调，恰好复现我们想除掉的幻觉。

## 分发器识别规则

```js
var DISPATCHER_RE = /(?:^|[_\-.])(call_?tool|invoke_?tool|execute_?tool|run_?code|code_?run|mcp_?call|tool_?call)$/i;
```

`cindy_mcp_call_tool` / `call_tool` / `run_code` / `mcp__x__call_tool` 命中；
`cindy_mcp_list_tools` / `read_file` 不命中。

## 可选的显式指定

`client_profiles` 支持 `tools_via`，把「猜」变成「已知」：

```json
{ "cindy": { "tools_via": "cindy_mcp_call_tool" } }
```

配上之后注入会多一行“已按客户端画像确认分发器为 `X`，直接用它”。

## 一个连带发现

`run_code`（Code Mode）也算分发器——这解释了一个原有用例为什麽一直绿：
它用 `["read_file", "run_code"]` 测档 1，而带 `run_code` 的客户端按新规则属于档 1.5。
单元测试与真机测试的档 1 用例都已改成真正“既无 MCP 也无分发器”的工具集。

## 验证

```
test_v700_capability_gate   40 项（新增 5 项分发器用例）
test_v700_env_scope         14 项
tests/e2e/gateway-real      15 项（新增 cindy-dispatched 客户端）
全量：96 套件通过 / 4 跳过 / 0 失败
```
