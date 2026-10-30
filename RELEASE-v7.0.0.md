# v7.0.0 —— 能力门控 · 环境作用域 · 幻觉遥测

本轮解决两个线上幻觉，并把「记忆可用性」从「MCP 工具一定存在」这个前提上解耦。

## 一、无 MCP 客户端不再被命令调工具

v6.49 及之前，`sniffToolNames()` 在 `body.tools` 为空时返回硬编码默认名，
注入文本于是变成「请调用 `magpie-memory-hub_memory_context`」。
ishellpro 这类客户端根本没注册该工具，模型只能幻觉调用或编造「已保存」。

现在按本次请求**实际通告的工具**分三档：

| 档 | 条件 | 行为 |
|---|---|---|
| 0 | 未通告任何工具 | 整块不注入（默认） |
| 1 | 有工具但非本插件 | 「能力未确认」，一个具体工具名都不写 |
| 2 | 通告了本插件工具 | 用真实名 + 「禁止换名重试」 |

新增 `src/middleware/capability.js`：兼容 OpenAI chat / responses / Anthropic /
Gemini / 老式 functions 五种结构；工具名用**边界后缀**匹配
（`mcp__magpie__memory_context` 命中，`my_memory_contextual` 不命中）。

## 二、环境作用域：schema v7

- `memories` / `pitfalls` 增加 `env_scope VARCHAR(256)`，空值 = 通用（存量数据零迁移）。
- `related_entities` 里的 `env:os=windows` 保留标签仍兼容，三条路径归一为同一格式。
- 二次写入去重时作用域**取并集**，不是覆盖。
- 提炼提示新增「环境限定守则」：平台限定事实必须写 `applies_to`；
  `appliesToToScope()` 把「仅限 Windows」归一成 `os=windows`。

**设计错误修正（真机测试挖出来的）**：首版对未知环境维度 fail-open，
导致没有 os 画像的 ishellpro 依然收到 Windows 准则。现改为 fail-closed：
带作用域的记忆必须正向确认才召回，无作用域记忆不受影响。开关 `env_scope_strict`（默认开）。

## 三、零工具写入通道

新增根目录 `memory-cli.js`（`save / pitfall / search / context / doctor`），
配置 `cli_channel` 后无 MCP 的客户端会用 CLI 读写记忆。
参照 mem0：MCP 只能是加速通道，不能是唯一通道。

## 四、幻觉遥测与自愈建议

响应层直接核对模型发出的 tool_call 名是否在本次通告清单里——**确定性检测，不是率估算**：

- `unadvertised`：通告了工具，但这个名字不在清单里
- `unavailable`：本请求根本没通告任何工具，模型凭空造了一个

中间件无 fs，检测结果经 `ctx.state.capsTelemetry` 交给宿主钩子落盘
（`src/services/caps-stats.js`，60s 节流）。累计 ≥3 且几乎没用上工具时，输出
`client_profiles` 降档建议。

## 五、设置页

新卡片「能力门控与环境作用域」：`capability_gate` / `guide_on_no_tools` /
`env_scope_strict` / `caps_telemetry` / `cli_channel` / `client_profiles`。
`client_profiles` 是自由编辑 JSON，**非法 JSON 拒绝保存**。

另带「一键补齐 client_profiles」：宿主加载时把 `caps-stats.json` 的降档建议写进 `_status.js`
（`caps` 卡片），页面一键写入文本域，仍需手动点保存——不静默改配置。

## 六、测试

- `tests/test_v700_capability_gate.mjs`：35 项
- `tests/test_v700_env_scope.mjs`：12 项
- `tests/e2e/gateway-real.mjs`：真 HTTP 网关 + 真中间件 + 真宿主钩子 + 真子进程 CLI，
  四个客户端画像（ishellpro / openminis / cindy-win11 / codex），13 项

全量：96 套件通过 / 4 跳过（缺真实 NCB 凭证的既有跳过）/ 0 失败；e2e 通过。

## 七、升级指引

```bash
# 1. 升级插件
/usr/local/bin/magpie plugin rm magpie-memory-hub
rm -f /config/magpie/plugins/bun.lock /config/magpie/plugins/bun.lockb
rm -rf /config/home/.cache/magpie/bun/install-cache/*
/usr/local/bin/magpie plugin add github:otaku-say/magpie-memory-hub

# 2. 补列（schema v7）——只加列，不动数据
grep '"version"' /config/magpie/plugins/node_modules/magpie-memory-hub/package.json
```

在设置页或让 agent 调 `db_init` 完成加列。
`db_status` 应显示 Schema 版本 7。

### 建议的首次配置

`client_profiles`：

```json
{
  "ishellpro": { "forbid_tools": ["*_memory_*", "*_pitfall_*"] },
  "openminis": { "os": "linux", "arch": "arm64", "forbid_tools": ["cindy_*"] },
  "cindy-win11": { "os": "windows", "arch": "amd64" }
}
```

`cli_channel`（可选，给无 MCP 客户端一条真写入通道）：

```
node /config/magpie/plugins/node_modules/magpie-memory-hub/memory-cli.js
```

## 八、刻意回滚的一个决定

曾给 `memory_get` 加 `feedback="unhelpful"`，与仓库已确立的「降权属于 `memory_forget`」
契约冲突且功能重复（`memory_forget` 已有 `not_helpful` 降 25）。已完整回滚。
