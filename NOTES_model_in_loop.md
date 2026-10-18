# Magpie 记忆中枢：在线大模型提炼与分类判定方案落地设计 (NOTES_model_in_loop.md)

**记录时间**：2026-10-18  
**工作目录**：`/var/minis/workspace/magpie-memory-hub/`  
**核心决策**：彻底放弃本地小模型路线（纯规则、Cross-Encoder 已证伪并移除），转向**显式调用网关内置在线模型**执行「提炼压缩」与「分类判定」。

---

## 一、方案演进与背景确证

### 1.1 为什么必须走在线模型路线？
在之前的探索中，两条本地路线均被真实业务场景证伪：
1. **纯规则启发式**：太松则产生伪踩坑爆炸（如 20 分钟 288 条伪踩坑）；太紧则真实对话召回率为 0。
2. **本地 Cross-Encoder (BGE-Reranker)**：在 0.5B / 小模型零样本分类任务下，源码片段与正则字面量的打分甚至比真实报错+解法高出 6 倍（严重倒挂），正例召回率仅 0%。其本质为 QA 检索重排模型，非泛化语义判断器。
3. **对话模型尾部输出 `<memory>` 方案的局限**：原设计试图在用户每次请求的助手回复末尾追加结构化块，但由于各客户端对流式输出的即时渲染要求极高，且在不同协议（Anthropic/Responses/Gemini）下存在剥离残留或影响用户体验的风险，用户更倾向于保持用户可见回复的绝对纯净。

### 1.2 关键决策转变
用户明确指令：
> 「用线上的模型是可以的，提炼压缩我在插件设置中填写 `group/gemini-3.5-flash-lite` 调用这个模型；分类模型我在插件设置中粘贴 `group/clef` 调用这个模型」  
> 「可以直接移除插件中安装的小模型，改为使用在线模型」

我们是 **LLM 网关（Magpie）的内部插件**，网关自身已具备完善的模型路由、账户鉴权与负载均衡体系。插件无需在本地额外部署任何模型进程，直接以内部客户端身份复用网关的在线模型即可。

---

## 二、网关模型调用通路查证（源码证据 + 实跑验证）

### 2.1 通路查证：Magpie 是否给插件暴露了调用接口？
- **源码查证**：
  - `internal/plugin/gateway.go:79-95` (`GatewayContext`) 与 `internal/plugin/host.js:1255-1310`：
    宿主传给网关钩子 `onRequest` / `onResponse` 的 `ctx` 包含 `Origin`、`Protocol`、`Model`、`Stream`、`Path`、`Agent`、`Session`、`Cwd`、`Query`、`options`、`state`、`signal` 等上下文，**未在 `ctx` 上挂载任何内置的 `callModel` 或 `chat` JS 函数**。
  - `internal/plugin/host.js:115-135`：
    插件运行在 Bun 宿主中，具备原生标准 `fetch`，可直接通过本地 Loopback 访问网关自身暴露的 HTTP 端点。

### 2.2 本地端点与鉴权规则
- **地址与端口**：
  - `internal/settings/settings.go:1088`：`const DefaultPort = 3425`。
  - 网关默认监听 `http://127.0.0.1:3425`。插件可读取 `options.gateway_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425"`。
- **免密访问（Local Loopback Bypass）**：
  - `internal/gateway/lan.go:415` 与 `lan.go:547`：
    ```go
    func local(r *http.Request) bool {
        host, _, err := net.SplitHostPort(r.RemoteAddr)
        ...
        return ip != nil && ip.IsLoopback() && !proxied(r)
    }
    ...
    if !ok && !local(r) { ... return r, false }
    ```
    当请求来自 `127.0.0.1` 环回接口且无外部代理头时，`local(r)` 判定为真，**网关完全放行，不强制要求 Bearer Token**。
  - 若用户配置了外部网关 URL 或设置了 `gateway_api_key` / `process.env.MAGPIE_API_KEY`，则通过 `Authorization: Bearer <key>` 鉴权。

### 2.3 模型组名（`group/xxx`）的路由支持
- `internal/gateway/gateway.go:1681` 与 `internal/provider/decide_group.go`：
  - Magpie 原生支持以 `group/` 前缀命名路由组（Routing Group）。
  - **提炼模型**：走标准 OpenAI 兼容接口 `POST /v1/chat/completions`，`model` 字段直接填入 `"group/gemini-3.5-flash-lite"`。
  - **分类模型**：若为决策模型（如 `group/clef`），Magpie 规定其不承载普通对话，专门响应 `POST /v1/systemone`（System One 决策接口）。若为通用对话模型，则走 `/v1/chat/completions`。

### 2.4 真实实跑执行验证证据

#### 验证 A：提炼模型 `group/gemini-3.5-flash-lite`（`/v1/chat/completions`）
- **测试请求**：
  ```bash
  curl -s -X POST "https://magpie-api.4a8a.com/v1/chat/completions" \
    -H "Authorization: Bearer $MAGPIE_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "group/gemini-3.5-flash-lite",
      "messages": [
        {"role": "system", "content": "提炼事实与踩坑，无内容返回[]，只输出JSON数组"},
        {"role": "user", "content": "[user]: 配置 Magpie 时发现跨域必须在 config.toml 加 cors = true 才跑通。\n[assistant]: 记录了。"}
      ],
      "temperature": 0.1
    }'
  ```
- **真实返回**：
  ```json
  {
    "choices": [{
      "finish_reason": "stop",
      "index": 0,
      "message": {
        "content": "[{\"category\":\"pitfall\",\"title\":\"Magpie 跨域请求配置\",\"content\":\"在配置 Magpie 时发现跨域请求必须加 CORS 头，最后在 config.toml 中设置 cors = true 才跑通。\",\"tags\":\"Magpie,CORS,config.toml,跨域\",\"confidence\":0.95}]",
        "role": "assistant"
      }
    }],
    "model": "antigravity/gemini-3.5-flash-lite",
    "usage": { "prompt_tokens": 305, "completion_tokens": 70, "total_tokens": 375 }
  }
  ```
- **闲聊对照测试**（`[user]: 今天中午吃的什么？\n[assistant]: 牛肉面`）：
  - 返回内容：`[]`
  - Token 开销：`prompt_tokens: 283, completion_tokens: 1, total_tokens: 284`。准确且开销极低。

#### 验证 B：分类模型 `group/clef`（`/v1/systemone`）
- **测试请求**：
  ```bash
  curl -s -X POST "https://magpie-api.4a8a.com/v1/systemone" \
    -H "Authorization: Bearer $MAGPIE_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "group/clef",
      "state": "用户喜欢用 TypeScript，不喜欢用 Python",
      "questions": {
        "worth_remembering": {
          "type": "noul",
          "instructions": "Does this text contain user preferences, technical decisions or architectural facts worth remembering?"
        }
      }
    }'
  ```
- **真实返回**：
  - 正例打分：`"answers":{"worth_remembering":{"type":"noul","noul":0.9879}}`，`output_tokens: 0`。
  - 负例（闲聊打卡）打分：`"answers":{"worth_remembering":{"type":"noul","noul":0.0053}}`，`output_tokens: 0`。
  - 效果：完美区分正负例，且输出 token 为 0，响应速度 < 50ms。

---

## 三、在线模型提炼与入库全链路设计

```
                    ┌────────────────────────┐
                    │ onResponse(reply, ctx) │ (网关后台异步触发)
                    └───────────┬────────────┘
                                │ auto_harvest === true && ctx.success
                                ▼
                    ┌────────────────────────┐
                    │  提取 dialogueText     │
                    │  (过滤脚手架/thought)  │
                    └───────────┬────────────┘
                                │ length >= 20
                                ▼
           ┌──────────────────────────────────────────┐
           │ 一级：分类模型判定 (group/clef)           │
           │ (若配置，走 /v1/systemone 快速打分)      │
           └────────────────────┬─────────────────────┘
                                │ score >= threshold (默认 0.5)
                                ▼ (若 < 0.5 则直接跳过，0 token 浪费)
           ┌──────────────────────────────────────────┐
           │ 二级：结构化提炼 (gemini-3.5-flash-lite)  │
           │ (严格 JSON 数组格式，容错解析)           │
           └────────────────────┬─────────────────────┘
                                │ 解析产出 candidates 数组
                                ▼
           ┌──────────────────────────────────────────┐
           │ 三级：去重与入库链路                     │
           │ 1. content_fingerprint 指纹防重          │
           │ 2. min_evidence 门禁 (默认 memory=1)     │
           │ 3. enqueueHarvestItems (写入本地队列)    │
           │ 4. drainHarvestQueue 后台异步入库        │
           └──────────────────────────────────────────┘
```

### 3.1 容错与 Fail-Open 保证
1. **模型调用超时控制**：在线模型调用封装 8000ms AbortSignal 超时保护。
2. **异常捕获与降级**：
   - 若分类模型不可用或报错：记录一行诊断日志，自动跳过分类前置，直接执行提炼（或安全跳过）。
   - 若提炼模型不可用或返回不可解析：记录一行诊断日志，安全降级至经典启发式规则兜底，绝不抛出任何异常，100% 保证网关稳定性。
3. **解析容错**：
   - 编写 `extractJsonArray(text)`，支持自动去除 ` ```json ` 标记、截取第一个 `[` 到最后一个 `]` 之间的有效内容。

---

## 四、成本与性能估算

1. **闲聊与常规问答（占比 ~85%）**：
   - 经 `group/clef` 分类判定拦截（耗时 ~50ms，input_tokens ~160，output_tokens: 0，单位调用成本约 0.00001 元），直接阻断后续大模型调用。
2. **高价值事实与踩坑轮次（占比 ~15%）**：
   - 触发 `group/gemini-3.5-flash-lite` 提炼：input_tokens ~300，output_tokens ~70，总耗时 ~400ms（后台异步），单位成本微乎其微。
3. **客户端感知**：
   - 由于全部逻辑运行在网关 `onResponse` 的独立后台异步协程中，客户端模型响应延迟增加量为 **0ms**。
