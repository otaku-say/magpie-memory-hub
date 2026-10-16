# Magpie 记忆插件多协议支持查证与实现检查点

## 1. 上游 Magpie 源码核对基准
- **核对时间**：2026-10-16 23:29:45 +0800
- **Git Commit**：`138188a36de6e77a1d2c5d331814c336aea32663`（短哈希 `138188a3`）
- **版本/分支**：origin/main (HEAD detached at origin/main)
- **协议枚举定义位置**：`/root/magpie/internal/provider/provider.go:34-42`
  ```go
  type Protocol string

  const (
      Chat      Protocol = "chat"      // OpenAI Chat Completions
      Responses Protocol = "responses" // OpenAI Responses
      Anthropic Protocol = "anthropic" // Anthropic Messages
      Gemini    Protocol = "gemini"    // Google Gemini's generateContent
  )
  var Protocols = []Protocol{Chat, Responses, Anthropic}
  ```
- **中间件上下文 `ctx.protocol` 定义位置**：
  - `/root/magpie/internal/gwmw/gwmw.go:27-34`:
    ```go
    type Info struct {
        Protocol string `json:"protocol"` // the agent's API: anthropic, chat, responses, gemini
        Model    string `json:"model"`
        Stream   bool   `json:"stream"`
        Path     string `json:"path"`
        Agent    string `json:"agent,omitempty"`
    }
    ```
  - `/root/magpie/internal/gateway/middleware.go:27`:
    ```go
    info := gwmw.Info{Protocol: string(from), Model: modelOf(body), Stream: streamOf(body), Path: r.URL.Path, Agent: agentOf(r)}
    ```
  - `/root/magpie/internal/middleware/run.go:53-73`:
    序列化 `Info` 为 JSON，并注入 moejs 的 `ctx` 对象（即 `ctx.protocol`）。
  - **结论**：`ctx.protocol` 的真实取值严格集合为：`"chat"`、`"anthropic"`、`"responses"`、`"gemini"`。

---

## 2. 四种协议的处理矩阵

| 协议名称 | Wire API 路由 | 请求体消息字段 | 角色与文本路径 | 流式增量事件形状 | 流式写回方式 | 非流式响应形状 |
|---|---|---|---|---|---|---|
| `chat` | `POST /v1/chat/completions` | `body.messages` | `role: "user"`<br>字符串：`m.content`<br>块数组：`m.content[].text` (`type === "text"`) | `ev.choices[0].delta.content` | `ev.choices[0].delta.content = text` | `body.choices[0].message.content` |
| `anthropic` | `POST /v1/messages` | `body.messages` | `role: "user"`<br>字符串：`m.content`<br>块数组：`m.content[].text` (`type === "text"`) | `ev.type === "content_block_delta"`<br>`ev.delta.type === "text_delta"`<br>文本在 `ev.delta.text` | `ev.delta.text = text` | `body.content[].text` (`type === "text"`) |
| `responses` | `POST /v1/responses`<br>`POST /backend-api/codex` | `body.input`<br>（**可为纯字符串或对象数组**） | ① 纯字符串：`body.input`<br>② 对象数组：`item.role === "user"`<br>`item.content` 为字符串或 `item.content[].text` (`type === "input_text" \| "text"`) | `ev.type === "response.output_text.delta"`<br>文本在 `ev.delta` | `ev.delta = text` | `body.output[].content[].text` (`type === "output_text"`) |
| `gemini` | `POST /v1beta/models/{model}:streamGenerateContent` | `body.contents` | `item.role === "user"` 或 `item.role` 缺失<br>文本在 `item.parts[].text`（需排除 `thought: true`） | `ev.candidates[0].content.parts[0].text` | `part.text = text` | `body.candidates[0].content.parts[].text` |

### 注入时的前缀插入规范（严格保 KV-Cache）
1. `chat` / `anthropic`:
   - 字符串：`m.content = injected.trim() + "\n\n" + m.content;`
   - 数组：`m.content = [{ type: "text", text: injected.trim() }].concat(m.content);`
2. `responses`:
   - 纯字符串：`body.input = injected.trim() + "\n\n" + body.input;`
   - 数组（字符串 content）：`item.content = injected.trim() + "\n\n" + item.content;`
   - 数组（数组 content）：`item.content = [{ type: "input_text", text: injected.trim() }].concat(item.content);`（注：Responses Schema 严格校验输入块类型为 `input_text`）
3. `gemini`:
   - 若 `item.parts[0]` 为文本块且非 thought：`item.parts[0].text = injected.trim() + "\n\n" + item.parts[0].text;`
   - 否则：`item.parts.unshift({ text: injected.trim() });`（注：Gemini Part 强校验禁止传入 `type` 等非法字段）

---

## 3. System One 的真实形态与中间件关系（查证结论）

### 结论
**`/v1/systemone` 绝不经过插件中间件，本插件不需要且无法处理它。**

### 源码证据
1. **未挂载中间件**：
   - `/root/magpie/internal/gateway/gateway.go:649`:
     ```go
     mux.HandleFunc("POST /v1/systemone", s.serveSystemOne)
     ```
   - `/root/magpie/internal/gateway/decide.go:441-525`:
     `s.serveSystemOne` 直接解析请求体，调用 `s.serveDecideTries` -> `s.postDecide`，**完全不调用 `s.serveAgent`**。
   - `/root/magpie/internal/gateway/middleware.go:18-35`:
     只有通过 `s.serveAgent(...)` 调用的请求才会触发 `gwmw.Agents` 中间件链。
   - `docs/subsystems/gateway-middleware.md:31`:
     *"Only requests agents send go through serveAgent. magpie's own requests (thread titles, the router's classifier, the search and vision stand-ins) call serve directly."*
2. **请求体不是对话格式**：
   - `/root/magpie/internal/gateway/systemone_key_usage_test.go:33`:
     请求体结构为：
     ```json
     {
       "model": "jev/jev-latest",
       "state": { "message": "hi" },
       "questions": { "intent": { "type": "choice" } }
     }
     ```
   - 响应格式为分类决策结果：`{"model": "...", "answers": { ... }}`。
   - 它没有 `messages`、`contents`、`input` 结构，不是 Agent 会话链路，而是网关路由层的分类器决策 API。

---

## 4. 上游近期改动对本插件的影响分析
1. **Commit `9b04c4e2`（2026-10-16 20:17:43）**：
   - 引入了异步网关钩子（Bun 插件 host 运行，支持 `async onRequest` 与 `onResponse`）。
   - 文件：`internal/gateway/middleware.go:25-33`。
   - 对本插件的影响：本插件属于同步 moejs 中间件（`*.middleware.js`），在 `gatewayHooks` 之后作为 `gwmw.Agents` 运行，调用顺序和数据契约完全未受破坏。
2. **Commit `e80fc7dc`（2026-10-16 21:31:35）**：
   - 调整了 `internal/middleware/middleware_test.go:142-154` 中 `TestFailOpen` 的超时时间（非 spin 场景放宽回 250ms），确保高负载下不超时。
   - 中间件单次执行限额依然为：`onRequest` 250ms，`onEvent` 50ms/事件，`onResponse` 250ms。
