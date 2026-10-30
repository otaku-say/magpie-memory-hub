# v7.1.0 —— 流式遥测 · 存量审计 · 枚举可跳过

补齐 v7.0.3 发布时自己点名的两个盲区。

## 一、流式幻觉遥测（真 bug）

v7.0.x 的遥测只挂在 `onResponse`。走 SSE 的客户端根本不会触发它，
所以统计一直是空的——**不是报错，是静默无数据**。这比报错更难发现。

### 改法

`onEvent` 逐 chunk 累加工具名，必须在它原有的零拷贝快路径**之前**：

```js
if (st.caps && !(ctx.options && ctx.options.caps_telemetry === false)) {
  try {
    accumulateToolCalls(event, st);
    if (isFinish(event)) flushToolCallPartials(st);
  } catch (_) { /* 遥测绝不打断流 */ }
}
```

关键细节：

- **工具名是碎片**。OpenAI 流式把 `memory_context` 拆成多个 `delta.tool_calls[0].function.name`，
  所以按 `index` 跨事件拼接，收口时才入表。不拼就会存成半截名字，等于白存。
- **四套语法归一处**：`src/domain/tool-calls.js` 同时处理 chat 的 `message` / `delta`、
  Anthropic 的 `content_block_start`、responses 的 `response.output_item.added`、Gemini 的 `functionCall`。
  流式与非流式共用一套提取，不会两份规则慢慢跑偏。
- **不改变事件**：`onEvent` 只读不写，快路径语义不变（测试断言事件 JSON 前后逐字节相等）。
- **零开销开关**：`caps_telemetry: false` 时不建缓冲区。

宿主侧 `hook-response` 在落盘前先 `finalizeFromStream(ctx.state)`，
把 `onEvent` 累到的名字收口成遥测记录。

## 二、存量 `env_scope` 审计

```bash
node memory-cli.js audit-env                    # 只出报告（默认）
node memory-cli.js audit-env --apply            # 真的写入
node memory-cli.js audit-env --limit 200 --table memories
```

启发式在 `src/domain/env-hints.js`，原则是**宁可不给，也不给错**：

| 输入 | 建议 |
|---|---|
| Windows 上用 PowerShell 改注册表 | `os=windows` |
| systemctl restart docker | `os=linux` |
| brew install jq | `os=macos` |
| alpine 的 arm64 镜像里 apk add git | `os=linux,arch=arm64` |
| **Windows 和 Linux 都要改** | **不给（判定为对比描述）** |
| 这个项目的日志统一用 JSON | 不给 |

为什么默认不写：存量回填改的是真实数据。一条通用事实被误标成 `os=windows` 之后，
它在其他环境就永远召不回来了，而且**没人会去发现**。漏标只是少一个优化，误标是静默丢数据。

## 三、枚举可跳过

档 1.5 第一步补一句：

> 若你已从系统提示或工具清单里确知这些名字，可跳过这一步直接进入经分发器调用。

模型常常已经能看到工具名，没必要每个新会话都烧一次 `list_tools`。

## 验证

```
test_v710_stream_and_audit  17 项（提取器 / 碎片累加 / 收口幂等 / 真实 onEvent / 启发式）
test_v700_capability_gate   44 项
test_v700_env_scope         17 项
tests/e2e/gateway-real      16 项（新增真 HTTP/SSE 流式用例）
全量：97 套件通过 / 4 跳过 / 0 失败
```

真机流式用例：网关真的发 `text/event-stream`，工具名故意切成 `magpie-m` + `emory-hub_memory_context` 两段，
断言最终被拼回完整名并判定为 `unadvertised`。
