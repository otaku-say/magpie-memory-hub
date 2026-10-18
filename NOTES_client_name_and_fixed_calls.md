# Magpie 客户端标识定制、图标机制与固定探针调用调研与落地方案

> **状态记录**：工作区检测到并行代理正在处理 R2 检测顺序与探针（`package.json`, `page_actions.js`, `r2.js`, `settings.html`, `settings.js` 包含未提交修改）。
> 按照工作区铁律，本阶段执行**深度只读诊断 + 上游源码审计 + 方案落盘**，确保不冲撞并行改动，同时提供 100% 具备落地条件的实施蓝图。

---

## 一、Magpie 识别客户端的底层机制与「客户端」列改写方案

### 1. 上游源码定位
经过对 Magpie 上游源码（`/tmp/magpie` 与 `/tmp/magpie-src`）的逐行审查，客户端识别与记录的核心链路如下：

#### (1) 网关层识别客户端：`internal/gateway/gateway.go:60-78`
```go
// agentOf is the agent a request came from: the one its token names
// (TokenFor), else the one its User-Agent does.
func agentOf(r *http.Request) string {
	if id, ok := strings.CutPrefix(callerKey(r), Token+"-"); ok && id != "" {
		return usage.AgentOf(id)
	}
	if isClaudeDesktop(r) {
		return "claude-desktop"
	}
	if isClaudeScience(r) {
		// Claude Science's client, an Anthropic SDK's User-Agent
		return ScienceID
	}
	ua := r.Header.Get("User-Agent")
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(ua)), "cursor") {
		return "cursor-local"
	}
	return usage.AgentOf(ua)
}
```

#### (2) 密钥提取逻辑：`internal/gateway/lan.go:486-505`
`callerKey(r)` 依次检查 `Authorization: Bearer <token>`、`x-api-key`、`x-goog-api-key` 和 `?key=`。如果 token 以 `magpie-` 开头（如 `magpie-Memory`），则截取后半部分传给 `usage.AgentOf`。

#### (3) 客户端名称归一化：`internal/usage/usage.go:317-338`
```go
// AgentOf names the agent behind a client User-Agent. Known agents map to
// their magpie id; anything else keeps its product name.
func AgentOf(ua string) string {
	ua = strings.TrimSpace(ua)
	name, _, _ := strings.Cut(ua, "/")
	name, _, _ = strings.Cut(name, " ")
	l := strings.ToLower(name)
	for _, k := range knownAgents() {
		if slices.Contains(k.Names, l) {
			return k.ID
		}
	}
	for _, k := range knownAgents() {
		if slices.ContainsFunc(k.UA, func(p string) bool { return strings.HasPrefix(l, p) }) {
			return k.ID
		}
	}
	if name == "" {
		return "other"
	}
	return name
}
```

#### (4) 远程 Magpie 转发头：`internal/gateway/remote_magpie.go:50-59`
仅当请求的 `User-Agent` 以 `magpie/` 开头时，网关才会提取 `X-Magpie-Agent` 头；普通客户端调用中，`X-Magpie-Agent` 会被删除。

---

### 2. 为什么当前实测显示为 `Bun`？
在 Bun 运行环境中，通过 `fetch(url, options)` 发起 HTTP 请求时，如果未显式指定 `User-Agent` 请求头，Bun 运行时会自动注入：
`User-Agent: Bun/<version> (Linux aarch64)`
根据 `usage.AgentOf(ua)`：
`strings.Cut(ua, "/")` 会提取出 `name = "Bun"`。由于 `"bun"` 不在 Magpie 内置已知 Agent 列表中，Magpie 直接将原始提取字符串 `"Bun"` 作为 Agent/Client 记录在用量账本中。
因此，Magpie 面板的「客户端」列显示为 **`Bun`**。

---

### 3. 目标实现：在面板「客户端」列显示为 `Memory`
在插件发起的所有内部模型调用中，显式添加以下请求头：
- `User-Agent: Memory/1.0`
- `X-Magpie-Agent: Memory`（前向兼容远程网关）
- `X-Memhub-Internal: 1`（防自激标记）

#### 验证推演：
1. 请求到达 Magpie 网关，`callerKey` 为常规 token（如 `magpie` 或自定义 key，不含 `magpie-` 前缀）；
2. 网关执行 `ua := r.Header.Get("User-Agent")`，获取到 `"Memory/1.0"`；
3. 执行 `name, _, _ := strings.Cut("Memory/1.0", "/")`，得到 `name = "Memory"`；
4. 检查已知列表，未匹配，返回 `name`（即 `"Memory"`）；
5. 网关账本记录 `Record.Agent = "Memory"`；
6. Magpie 面板的「客户端」列完美呈现为 **`Memory`**！

---

### 4. 自定义客户端标识作为「防自激第二重判据」的评估
在 `model_budget.js` 的 `isInternalHarvestRequest(body, ctx)` 中：
- **评估结论**：
  - **可靠性**：作为**辅助加分项（Secondary Defense）**非常可靠。因为 `User-Agent` 是标准 HTTP 头，中间代理与网关不会丢弃，且 Magpie 会将解析出的客户端写入 `ctx.agent`。
  - **风险点**：上一轮已确认「不能用模型名当判据」，同理，若外部用户恰好编写了一个客户端名为 `Memory` 的普通 Agent，如果仅因 `agent === "Memory"` 就无条件豁免，会导致该用户的正常对话被错误漏采。
  - **落地决策**：
    - **主防线仍保持**：`ctx.state.memhubInternal === true`、`X-Memhub-Internal: 1` 请求头，以及 `INTERNAL_PROMPT_MARKERS` 请求体特征指纹；
    - **加分项**：在检查请求头与 `ctx.agent` 时，若捕获到 `Memory` 且同时包含至少一个系统提示词内部特征（或 `systemone` 决策特征），即刻触发快速豁免；若请求头中存在 `User-Agent: Memory/1.0` 或 `X-Magpie-Agent: Memory`，直接作为合法内部请求源识别。

---

## 二、`data-icon` 属性机制与图标显示调研报告

### 1. `data-icon` 的取值来源
- **由谁决定**：**后端计算并下发，前端模板渲染绑定**。
- **源码定位**：
  1. 后端计算：`internal/usageapi/usageapi.go:268-273, 286`
     ```go
     who := func(id string) Named {
         if a := agents[id]; a != nil {
             return Named{ID: id, Name: a.Name, Icon: a.Icon}
         }
         return Named{ID: id, Name: id, Icon: "generic"}
     }
     // ...
     lr := Row{Row: r, AgentName: a.Name, Icon: a.Icon, ProviderName: which(r.Provider).Name}
     ```
  2. 前端表格渲染：`internal/gui/assets/plugins/usage/page.js:1606`
     ```javascript
     who.append(icon(r.icon || "generic"), el("span", "", ...));
     ```
  3. 图标 DOM 节点构建：`internal/gui/assets/app.js:285-320`
     ```javascript
     function icon(name) {
       const kept = keptIcons?.get(name || "")?.shift();
       if (kept) { kept.removeAttribute("title"); return kept; }
       const e = el("span", "ic");
       e.dataset.icon = name || "";
       if (name === "generic") {
         e.classList.add("generic");
         e.append(svg("M8 2.2 13.2 5.1v5.8L8 13.8 2.8 10.9V5.1Z M8 8v5.8 M2.8 5.1 8 8l5.2-2.9", 16, 1.4));
         return e;
       }
       // name 对应 icons/${name}.svg 或 icons/${name}.png
     ```

### 2. 取值匹配逻辑与合法清单
- **匹配逻辑**：后端维护 `agent.Clients()` 注册表，包含内置 Agent、通过 `magpie.agent` 注册的 Agent 插件、以及静态 `others`（`magpie`, `curl`, `pi-desktop`）。
- **如果客户端名为 `Memory`**：
  `agents["Memory"]` 为 `nil`，后端回退返回 `Icon: "generic"`，前端渲染为 `data-icon="generic"`（即当前的立体方盒子图标）。
- **合法图标清单**（取自 `internal/gui/assets/icons/`）：
  - 默认通用：`generic`（方盒子）
  - 宿主与工具：`magpie`（小鸟）、`curl`
  - 厂商/模型家族：`openai`, `anthropic`, `google-color`, `deepseek-color`, `gemini-color`, `claude-color`, `mistral-color`, `meta-color`, `qwen-color`, `moonshot`, `zhipu-color`, `minimax-color`, `doubao-color` 等
  - 知名 Agent：`codex-color`, `claudecode-color`, `cursor`, `cline`, `zed`, `goose`, `grok`, `kimi`, `trae`, `windsurf`, `vscode`, `opencode` 等

### 3. 能否让插件内部调用显示其他图标（如 `magpie` 小鸟）？
- **结论（如实说明，不弄虚作假）**：
  1. **HTTP 请求头中无法直接指定图标**：Magpie 网关未提供任何类似 `X-Icon` 的协议头，`r.icon` 纯粹根据 `r.Agent` 在 `agent.Clients()` 表中查找；
  2. **若强行将 User-Agent 设为 `magpie`**：
     - 图标确实会变成 `data-icon="magpie"`（小鸟图标）；
     - **但是**：「客户端」列也会被强制显示为 **`magpie`**（且带有 `[own]` 内部调用徽标），**这就无法满足用户「自定义客户端名为 Memory」的核心诉求**；
  3. **鱼和熊掌兼得的最佳官方方案**：
     - 请求头发送 `User-Agent: Memory/1.0`，使客户端列显示为 `Memory`；
     - 在 Magpie 面板的「用量」页面中，Magpie 原生提供了 `ClientAgents` 功能（`internal/usage/client_agents.go`）：
       用户可在界面中点击 `Memory` 客户端右侧菜单 -> 选择「将此客户端的调用计入」-> 选择 `magpie`（或其它已知 Agent）。配置后，该客户端将展示对应 Agent 的图标（如小鸟图标），且在详情弹窗中依然保留 `Client: Memory` 来源。

---

## 三、「固定长度调用」的来源核查与全量清单

### 1. 用户观察到的模式确证
用户截图中的指标：
```
客户端 Bun ✗ group/clef              ✗ 输入 1214 ✗ 输出 0    ← 【恒定】
客户端 Bun ✗ group/gemini-3.5-flash-lite  ✗ 输入 1747 ✗ 输出 1    ← 【恒定】
客户端 Bun ✗ group/gemini-3.5-flash-lite  ✗ 输入 1747 ✗ 输出 177/227…  ← 输出不固定
```
- **`clef` 输入 1214 / 输出 0 的根因**：
  - 来源：`gateway_harvest.hooks.js:1472-1540` 中的 `testClassificationModel`；
  - 机制：向 `/v1/systemone` 发送固定的测试决策请求体：
    `state`: `"[user]: 我们已决定在生产环境采用 PostgreSQL 替代 MySQL。\n[assistant]: 好的，已记录技术选型。"`
    `questions`: `worth_remembering` (instructions: "Does this text contain user preferences, technical decisions, environment facts, or bug fixes worth remembering?")
  - 该 prompt 与协议模板在模型分词器下恰好恒定为 **1214 input tokens**；
  - `/v1/systemone` 仅返回概率分布（`noul` 打分），不生成任何补全 token，因此**输出恒为 0**。
- **`gemini-3.5-flash-lite` 输入 1747 的根因**：
  - 来源：`gateway_harvest.hooks.js:1377-1469` 中的 `testExtractionModel`；
  - 机制：向 `/v1/chat/completions` 发送固定的提炼测试提示词：
    `system`: `HARVEST_SYSTEM_PROMPT`（完整的长篇结构化提炼指令与规范）
    `user`: `"[user]: 这个项目统一使用 pnpm 管理依赖。\n[assistant]: 好的，已记录项目环境规范。"`
  - `HARVEST_SYSTEM_PROMPT` + 测试对话在 Gemini 分词器中分词结果恰好恒定为 **1747 input tokens**；
  - **输出为 1**：Gemini 某些轮次判断无新增提炼，仅返回规范要求的空数组 `[]`（恰好 1 个 token）；
  - **输出为 177 / 227**：Gemini 提炼出了包含 `category, title, content, tags, confidence` 的标准 JSON 对象，输出长度约 177~227 tokens。

### 2. 四大关键问题核查结论
1. **有没有在【非用户点击】时也发起这种固定长度的调用？**
   - **核查结论：绝无此类行为**。
   - `testModelConnectivity`（及子函数 `testExtractionModel` / `testClassificationModel`）在整个插件中**仅且仅被 `page_actions.js:222`（`action.op === "model_check"`）显式调用**；
   - 自动采集钩子 `onResponse`、中间件 `onRequest`、后台队列消费器均不会触发任何连通性检测。
2. **`model_check` 的探针调用是否只在设置页点击时发生？**
   - **核查结论：是的，100% 仅在设置页用户点击「真实检测模型」按钮时发生**（对应 `settings.js:1176`）。
3. **插件所有模型调用点与 Prompt 特征清单**：
   | 调用场景 | 对应函数 | 目标接口 | Prompt 是否固定 | 输入 Token 特征 | 触发时机 |
   | :--- | :--- | :--- | :--- | :--- | :--- |
   | **判定连通性检测** | `testClassificationModel` | `/v1/systemone` 或 `/v1/chat/completions` | **100% 固定** | **恒定 1214** | 仅设置页点击「真实检测模型」 |
   | **提炼连通性检测** | `testExtractionModel` | `/v1/chat/completions` | **100% 固定** | **恒定 1747** | 仅设置页点击「真实检测模型」 |
   | **在线会话价值判定** | `classifyDialogueWithOnlineModel` | `/v1/systemone` 或 `/v1/chat/completions` | **动态** | 随用户实际对话长度动态变化 | 正常对话完成时（`onResponse`） |
   | **在线跨会话记忆提炼** | `harvestWithOnlineModel` | `/v1/chat/completions` | **动态** | SystemPrompt 固定，UserPrompt 为用户真实对话，随长度动态变化 | 判定通过后（`onResponse`） |
   | **未知底层错误诊断** | `explainUnknownErrorWithModel` | `/v1/chat/completions` | **动态** | SystemPrompt 注入小抄，UserPrompt 包含具体报错堆栈 | 仅当工具发生未知报错时 |
   | **检索查询语义改写** | `rewriteSearchQuery` | `/v1/chat/completions` | **动态** | 随用户在 `memory_search` 中传入的 query 变化 | 仅当调用检索且启用改写时 |
4. **是否存在「每轮对话多打一次固定调用」的 bug？**
   - **核查结论：不存在**。
   - 对话后置钩子 `onResponse` 严格遵循：自激拦截 -> 纯闲聊短路 -> 1 次判定 -> （若判定为正）1 次提炼。全程无任何多余的固定测试打桩。

---

## 四、代码落地方案（待并行代理收工后合入）

### 1. `model_budget.js` 改动
定义标准客户端标识常量与请求头生成工具：
```javascript
export const MEMHUB_CLIENT_NAME = "Memory";
export const MEMHUB_USER_AGENT = "Memory/1.0";

/**
 * 统一构造插件内部发起的大模型请求头
 */
export function getInternalModelHeaders(apiKey = "") {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": MEMHUB_USER_AGENT,
    "X-Magpie-Agent": MEMHUB_CLIENT_NAME,
    [MEMHUB_INTERNAL_HEADER]: MEMHUB_INTERNAL_VALUE,
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}
```
并在 `isInternalHarvestRequest(body, ctx)` 中将 `ctx.agent === MEMHUB_CLIENT_NAME` 及 `User-Agent` 纳入防自激请求头识别判定。

### 2. `gateway_harvest.hooks.js` 改动
在以下 4 处统一使用 `getInternalModelHeaders`：
1. `callSystemOne()` (行 475)
2. `callChat()` (行 535)
3. `harvestWithOnlineModel()` (行 677)
4. `testExtractionModel()` (行 1400)

### 3. `online_models.js` 改动
在以下 2 处统一使用 `getInternalModelHeaders`：
1. `explainUnknownErrorWithModel()` (行 167)
2. `rewriteSearchQuery()` (行 306)

---
*本检查点文档已落盘，随时可供执行与查验。*
