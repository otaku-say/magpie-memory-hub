# Magpie 记忆插件传输层拦截方案评估：Provider 代理 vs 异步网关钩子 (PR #2118)

**评估时间**：2026-10-17  
**上游 HEAD 依据**：commit `138188a36de6e77a1d2c5d331814c336aea32663`（2026-10-16 23:29:45 +0800）  
**关键特性提交**：commit `9b04c4e20ff8bf10c745a53f562f5007b82d007d`（PR #2118, 2026-10-16 20:17:43 +0800）  
**最终判定**：采用**异步网关请求钩子（Async Gateway Hooks）方案**，放弃 Provider 代理方案。

---

## 1. 核心判定规则对照（硬性检验）

根据委托代理与用户的明确判定铁律：
> 只要异步网关钩子（`magpie.hooks` / `*.hooks.*`，PR #2118）能够满足下面两条，**就只做异步钩子方案，Provider 代理方案完全不做**：
> 1. 能拿到**完整的请求体与响应内容**（采集的前提）
> 2. **不在模型请求的关键路径上** —— 即我们的代码抛异常/变慢，**不会影响用户的模型请求**

### 1.1 检验项 1：能否拿到完整的请求体与响应内容？—— 【完全满足 (PASS)】
- **源码文件**：`internal/gateway/gateway_hooks.go` 第 9-32 行
  ```go
  func gatewayResponse(w http.ResponseWriter, r *http.Request, proto provider.Protocol, body []byte, run *plugin.GatewayRun) (http.ResponseWriter, func()) {
      capture := &conversationWriter{captureResponseWriter: &captureResponseWriter{
          ResponseWriter: w, full: &spool{limit: conversationBodyMax, pattern: "magpie-hook-*"},
      }}
      return capture, func() {
          ...
          output, err := capture.full.read()
          ...
          reply, err := gatewayReply(proto, output)
          ...
          run.Finish(r.Context(), reply, success, body)
      }
  }
  ```
- **源码文件**：`internal/plugin/gateway.go` 第 209-212 行
  ```go
  params := map[string]any{
      "operation": "finish", "id": r.id, "token": r.token,
      "reply": append(json.RawMessage(nil), reply...), "success": success,
  }
  if len(request) != 0 && json.Valid(request[0]) {
      params["request"] = append(json.RawMessage(nil), request[0]...)
  }
  ```
- **源码文件**：`internal/plugin/host.js` 第 1313-1317 行
  ```javascript
  ctx.signal = AbortSignal.any([total, ctl.signal])
  ctx.success = p.success === true
  if (p.request !== undefined) ctx.request = structuredClone(p.request)
  await bounded(Promise.resolve().then(() => h.onResponse(structuredClone(p.reply), ctx)), ctx.signal)
  ```
- **证据证明**：
  1. **请求体**：在 `onRequest(body, ctx)` 中能直接拿到客户端发起的 `body`；在 `onResponse(reply, ctx)` 中也能通过 `ctx.request` 拿到原始请求体。
  2. **响应内容**：网关底层的 `gatewayReply` 已经自动通过协议解码器（Chat, Responses, Anthropic, Gemini）将多 chunk 的流式 SSE 字节流拼装成最终的完整响应 JSON，传给 `reply`！采集逻辑不需要手写任何复杂的 SSE 分块重组。

---

### 1.2 检验项 2：是否不在模型请求的关键路径上？—— 【完全满足 (PASS)】
- **源码文件**：`internal/plugin/gateway.go` 第 213-217 行
  ```go
  go func() {
      ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 11*time.Second)
      defer cancel()
      _ = r.h.call(ctx, "gatewayRequest", params, nil)
  }()
  ```
  网关调用通过 **`go func()` 独立协程** 发起，并使用 **`context.WithoutCancel(ctx)`** 剥离客户端 HTTP 请求上下文，在客户端连接生命周期结束之后依然能够安全运行。
- **源码文件**：`internal/plugin/host.js` 第 1317-1320 行
  ```javascript
  try {
      await bounded(Promise.resolve().then(() => h.onResponse(structuredClone(p.reply), ctx)), ctx.signal)
  } catch {
      if (!signal.aborted) send({ event: "log", level: "warn", message: `${h.spec}: gateway response hook failed or timed out` })
  }
  ```
  Bun 宿主捕获所有 `onResponse` 的抛错或超时，仅记录 warn 日志，**绝不向网关或客户端返回失败**。
- **官方文档说明**（`docs/subsystems/gateway-request-hooks.md`）：
  > "Notification is fire-and-forget, with a fresh timeout signal independent of the finished HTTP request. It never waits for an observer's network operation before returning client EOF."
  > "Streaming bytes are forwarded immediately."
- **证据证明**：客户端早已全速收到模型响应，`onResponse` 的任何异常、超时、GC 停顿都对用户请求毫无波及（真正的 100% fail-open）。

---

### 1.3 检验项 3：能否访问网络和本地持久化？—— 【完全满足 (PASS)】
- 运行环境是 Bun 插件宿主，具备完整的 Node/Bun 标准库能力：
  - `fetch`：全量网络 I/O 支持（支持调用 NoCodeBackend REST API、外部 webhook 等）；
  - `node:fs`：完整支持本地文件读写与状态存储；
  - 直接支持调用本项目的 `mcp_client.js`、`local_state.js` 等模块。

---

## 2. 方案对比与决策

| 维度 | 方案 A：Provider 代理 (Transport Intercept) | 方案 B：异步网关钩子 (PR #2118 Async Hooks) |
| :--- | :--- | :--- |
| **执行时机** | 模型请求核心传输层 (`Provider.Do()`) | 非关键路径后台异步触发 (`onResponse`) |
| **Fail-Open 保证** | 脆弱：插件挂掉或慢，用户请求立刻 502/断流 | **天然绝对 Fail-Open**：网关独立协程，异常全吞，0 影响 |
| **流式保真度** | 依赖 JS `body.tee()`，存在分块重排、粘包、死锁风险 | **100% 物理保真**：网关原生输出直达客户端，无任何二次中转 |
| **多协议支持** | 需手写 OpenAI/Claude/Gemini 等各协议的 SSE 解析 | **网关原生统一**：`reply` 直接给出解码好的统一响应 JSON |
| **用户体验** | 需用户手动在 Magpie 中新增 Provider 账号并改路由 | **零感知**：只需配置项开启，自动覆盖全量网关请求 |
| **架构整洁度** | 需伪装 Provider、处理虚拟 auth、代码冗长脆弱 | **极简优雅**：一个独立的 `gateway_harvest.hooks.js` 钩子文件 |

**明确决策**：按照规则，**只实现方案 B（异步网关钩子）**，Provider 方案完全不做。

---

## 3. 实现规划与架构落地

1. **新增文件**：
   - 本地仓库新增：`gateway_harvest.hooks.js`
   - 导出两个标准钩子：
     - `export async function onRequest(body, ctx)`
     - `export async function onResponse(reply, ctx)`
2. **在 `package.json` 中注册**：
   - 保持 `main: "./tools.js"`（22个 MCP 工具）不变；
   - 保持 `magpie.middleware: "./memory.middleware.js"` 不变；
   - 在 `"magpie"` 字段中新增 `"hooks": "./gateway_harvest.hooks.js"`。
3. **默认关闭（Zero Impact by Default）**：
   - 读取 `ctx.options.auto_harvest`；若未显式置为 `true`，钩子第一行直接返回，0 开销。
4. **提炼与入库复用**：
   - 提炼逻辑直接复用 `gateway_harvest.js` 中的核心提炼规则函数：`mineEnvironmentFacts`、`mineArchitecturalDecisions`、`mineFailures`；
   - 入库逻辑复用基于 `mcp_client.js` 的 `makeMcpClient` 执行结构化插入；
   - 基于 `content_fingerprint` 唯一指纹与近期内存缓存进行双重去重，杜绝重复写入；
   - 严格在内部 `try ... catch` 捕获所有异常，绝不向宿主或调用方抛出任何错误。
5. **测试保障**：
   - 新增独立测试文件 `tests/test_gateway_harvest_hooks.mjs`，包含：
     1. fail-open 故意抛错验证；
     2. 默认关闭验证；
     3. 完整请求+流式合并响应提取验证；
     4. 提炼结果与现行 `harvest.py` / `gateway_harvest.js` 的对齐验证；
     5. 写库与清理验证（残余断言为 0）。
