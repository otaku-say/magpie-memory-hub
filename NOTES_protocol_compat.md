# Magpie 记忆插件多协议深度核验与加固检查点

## 1. 上游 Magpie 源码核验基准
- **核对时间**：2026-10-17 02:25:00 +0800
- **Git Commit**：`81313b912128e2c6d8991caf6667b55c27cfb1cd`（短哈希 `81313b91`）
- **Commit 日期**：Sat Oct 17 01:50:12 2026 +0800
- **Commit 说明**：`gui: the core script budget makes room for 10-16's core work (#2612)`
- **与上一轮结论对比**：
  - 核心协议枚举与上下文契约未变（`chat`、`responses`、`anthropic`、`gemini`）。
  - `gatewayHooks` 与 `gwmw.Agents` 的生命周期及执行顺序未变。
  - 最新提交涉及 Codex 后台长会话 compaction 与 DSH 会话标记，对中间件和异步钩子的协议契约零破坏。

---

## 2. 四协议真实形状对照表（上游源码级依据）

| 维度 | `chat` (OpenAI Chat Completions) | `anthropic` (Anthropic Messages) | `responses` (OpenAI Responses) | `gemini` (Google Gemini generateContent) |
|---|---|---|---|---|
| **上游解析代码** | `internal/gateway/chat.go:73` (`parseChat`) | `internal/gateway/anthropic.go:115` (`parseAnthropic`) | `internal/gateway/responses.go:254` (`parseResponses`) | `internal/gateway/gemini.go:215` (`parseGemini`) |
| **请求体消息字段** | `body.messages` (数组) | `body.messages` (数组)；`body.system` 为顶层字符串/块 | `body.input` (字符串 或 `rItem` 数组) | `body.contents` (数组) |
| **消息/轮次定位** | `role: "user"` (或 assistant/system/tool) | `role: "user"` (或 assistant) | 字符串即 user；或 `it.type === "message" && it.role === "user"` | `c.role === "user"` (或 role 省略) |
| **文本所在路径** | `m.content` (字符串) 或 `m.content[].text` (`type === "text"`) | `m.content` (字符串) 或 `m.content[].text` (`type === "text"` / `tool_result`) | `input` (字符串) 或 `it.content` (字符串/块数组 `type === "input_text"`/`"text"`) | `c.parts[].text` (非 `thought: true`) |
| **流式事件形状 (SSE)** | `internal/gateway/chat.go:1151` (`chatEncoder`)<br>`data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"content":"..."},"finish_reason":null}]}` | `internal/gateway/anthropic.go:1425` (`anthropicEncoder`)<br>`event: content_block_delta`<br>`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}` | `internal/gateway/responses.go:1483` (`responsesEncoder`)<br>`event: response.output_text.delta`<br>`data: {"type":"response.output_text.delta","delta":"..."}` | `internal/gateway/gemini.go:600` (`geminiEncoder`)<br>`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]},"index":0}]}` |
| **流式文本提取** | `event.choices[0].delta.content` | `event.delta.text` (当 `type === "content_block_delta"`) | `event.delta` (当 `type === "response.output_text.delta"`) | `event.candidates[0].content.parts[].text` |
| **流式结束判定 (Finish)** | `event.choices[0].finish_reason !== null` | `event.type === "message_delta" && event.delta.stop_reason` 或 `event.type === "message_stop"` | `event.type === "response.completed"` (含完整 `response` 对象) | `event.candidates[0].finishReason !== undefined` (如 `"STOP"`) |
| **非流式响应形状** | `internal/gateway/chat.go:1245` (`renderChat`)<br>`{"choices":[{"message":{"role":"assistant","content":"..."}}]}` | `internal/gateway/anthropic.go:1561` (`renderAnthropic`)<br>`{"role":"assistant","content":[{"type":"text","text":"..."}]}` | `internal/gateway/responses.go:1837` (`renderResponses`)<br>`{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}]}` | `internal/gateway/gemini.go:702` (`renderGemini`)<br>`{"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]}}]}` |
| **非流式文本路径** | `reply.choices[0].message.content` | `reply.content[].text` (`type === "text"`) | `reply.output[].content[].text` (`type === "output_text"`/`"text"`) | `reply.candidates[0].content.parts[].text` (`!thought`) |
| **注入 Schema 强校验约束** | 可直接拼字符串，或在 content 数组插入 `{type: "text", text: "..."}` | 强校验块类型！非法 type 会被 400 拒收；必须是 `{type: "text", text: "..."}` | 强校验！user 输入块严格要求 `{type: "input_text", text: "..."}`，不可塞错类型 | 极其严格！Gemini `parts` 不允许存在任何非法字段（如 `type`），必须是纯 `{text: "..."}` |

---

## 3. 异步网关钩子（gateway_harvest.hooks.js）关键缺陷查证与修复方案
- **缺陷 1：Responses 响应端提取完全失效**
  - 上游源码证据：`internal/gateway/responses.go:1845`，assistant 消息的 content block 类型为 `"output_text"`：
    `content: []map[string]any{{"type": "output_text", "text": p.Text, "annotations": []any{}}}`
  - 旧代码逻辑：`gateway_harvest.hooks.js:144` 仅判断 `item?.type === "text"`，导致 Responses 输出内容完全提取不到（返回空字符串）。
  - 修复：必须兼容 `item?.type === "output_text" || item?.type === "text"`。
- **缺陷 2：Responses 请求端输入完全丢失**
  - 旧代码逻辑：`buildDialogueText` 只检查 `body.messages`、`body.prompt` 和 `body.contents`，完全漏掉了 Responses 的 `body.input`！
  - 修复：增加对 `body.input`（纯字符串形态与对象数组形态）的解析提取，按 `[user]: ...` 拼装对话。
- **缺陷 3：Gemini 思考内容（thought）污染**
  - 上游源码证据：Gemini 2.5 具备思考输出，`part.thought === true`，不属于最终助手正文。
  - 修复：在提取请求和响应时过滤 `p.thought`。

---

## 4. System One 专项复核结论
- **源码路由注册**：`internal/gateway/gateway.go:649`
  `mux.HandleFunc("POST /v1/systemone", s.serveSystemOne)`
- **服务实现**：`internal/gateway/decide.go:441`
  `serveSystemOne` 直接读取请求体并调用 `provider.RouteDecider` 或 `s.serveDecisionGroup`。
- **中间件链路**：
  `internal/gateway/middleware.go:21` 中的 `serveAgent` 是触发 `gatewayHooks` 和 `gwmw.Agents` 中间件的唯一入口。
  `serveSystemOne` **绝不调用** `serveAgent`。
- **数据面性质**：
  System One 是模型路由分类器（Jev / Clef 决策），payload 为 `{"model": "...", "state": {"message": "hi"}, "questions": {...}}`，不包含多轮会话上下文，不是 Agent 会话链路。
- **结论**：本插件中间件不需要也无法介入 `/v1/systemone` 流量。
