# NOTES_traceability.md —— 记忆与踩坑「来源可追溯性」调研与落地设计方案

> **状态记录**：已完成第一步（全量只读源码剖析 + 沙箱真实用例运行实测）。  
> **撞车避让**：检测到工作区内另一并行代理正在修改 `gateway_harvest.js`、`gateway_harvest.hooks.js`、`tools.js`、`db_tools.js`、`harvest.py`、`settings.html` 等文件（处理 `NOTES_user_issues_v2.md` 的 6 项修复与 NCB 字段核对）。  
> **执行策略**：严格遵守并发隔离约束，**本阶段不直接修改冲突代码文件**，将完整落地设计、实测数据与代码实现对照详尽落盘于本文档，待并行代理完工后即可无缝实施。

---

## 一、第一步调研结论：三处通道到底能拿到什么？

依据上游 Magpie 源码（沙箱沙盒 ID：`2a18dfd672c2409eabbc434aa96faaf0`，源码路径 `/root/magpie`，跟踪依据 commit：`7660399a121af67db4efd56ecb6bd4fb04dc53f1`，HEAD on `origin/main`）。

### 1. 异步钩子侧（`gateway_harvest.hooks.js`）
- **Go 核心定义**（`internal/plugin/gateway.go:79-89`）：
  ```go
  type GatewayContext struct {
      Origin   string `json:"origin"`   // local, remote, 或 gateway-key
      Protocol string `json:"protocol"` // chat, anthropic, responses, gemini
      Model    string `json:"model"`    // 模型名称，如 claude-3-7-sonnet
      Stream   bool   `json:"stream"`   // 是否流式
      Path     string `json:"path"`     // 请求路由，如 /v1/chat/completions
      Agent    string `json:"agent"`    // 识别到的客户端代理标识，如 claude-code
      Session  string `json:"session"`  // 会话标识，截断至最多 128 字节
      Cwd      string `json:"cwd"`      // 工作目录
      Query    string `json:"query"`    // 提取的用户主要请求文本
  }
  ```
- **Session 来源与提取规则**（`internal/gateway/gateway.go:6087-6130`）：
  ```go
  var sessionHeaders = []string{
      "x-opencode-session", "x-session-affinity", "x-session-id",
      "session_id", "session-id", "x-claude-code-session-id",
      "x-conversation-id", "x-deepseek-harness-session-id",
  }
  const SessionHeader = "X-Magpie-Session"

  func sessionOf(in http.Header) string {
      for _, h := range append([]string{SessionHeader}, sessionHeaders...) {
          if v := strings.TrimSpace(in.Get(h)); v != "" {
              if len(v) > 128 { v = v[:128] }
              return v
          }
      }
      return ""
  }
  ```
- **实测验证结果**（通过真实 Go+Bun 插件沙箱测试 `TestInspectCtx` 观测）：
  - 当客户端在 HTTP Header 中携带会话头时（如 `X-Magpie-Session` 或 `x-claude-code-session-id`）：
    `onRequest` 与 `onResponse` 的 `ctx.session` **精确返回该会话字符串**（实测值 `sess-uuid-12345`）。
  - 当普通客户端未传递任何会话头时：
    `ctx.session` 返回空字符串 `""`。
  - **轮次推导能力**：
    在 `onRequest(body, ctx)` 与 `onResponse(reply, ctx)` 中，`body.messages`（或 `body.contents`/`body.input`）包含当前请求的历史对话消息。通过统计历史中 user 角色消息条数，可精确得出当前交互处于该对话的**第几轮（`source_turn`）**。

### 2. 读录制侧（`gateway_harvest.js`）
- **录制生成逻辑**（`internal/gateway/conversations.go:50-70`）：
  ```go
  func recordConversation(w http.ResponseWriter, r *http.Request, proto provider.Protocol, body []byte) (http.ResponseWriter, func()) {
      id := sessionOf(r.Header)
      generation := sessions.GatewayRecordingGeneration()
      if !settings.Load().GatewayConversations || id == "" {
          return w, func() {}
      }
  ...
  ```
  **重要事实**：Magpie 的录制机制有硬前置条件：`id == ""` 时**根本不会生成录制文件**！
  即：“Only a session the client named is recorded: magpie never makes one up”。
- **文件存储结构**（`internal/sessions/gateway.go:135-155`）：
  目录规范：`~/.config/magpie/gateway-conversations/YYYY-MM-DD/<sha256(agent, session)>/turns.jsonl`
  每行包含：
  ```json
  {
    "agent": "...",
    "session": "...",
    "time": "2026-10-17T05:12:34.567Z",
    "model": "...",
    "status": 200,
    "input": [...],
    "output": [...]
  }
  ```
- **扫描侧结论**：
  在 `gateway_harvest.js` 扫描 `turns.jsonl` 时：
  - `turn.session`（或 `turn.Session`）**100% 存在且非空**。
  - 单个 `turns.jsonl` 内每行记录即为一次独立的 sequential turn，文件内行索引（从 1 开始计）即为精确的 `source_turn`。
  - 此外每轮带时间戳 `turn.time`。

### 3. 离线 Python 侧（`harvest.py`）
- `save_memory(ncb, cfg, m, cache)` 与 `save_pitfall(ncb, cfg, p, cache)` 直接接收数据字典并写入 NCB。
- 只要在入库字典中注入 `source_session` 与 `source_turn`，即可与 NCB 数据库保持完全一致的写入能力。

### 4. 工具调用侧（`tools.js`）
- Agent 通过 MCP 显式调用 `memory_save` / `pitfall_save` 时：
  - 工具参数允许传入 `source_session`（可选，会话标识）与 `source_turn`（可选，轮次序号）。
  - 若调用上下文未提供（例如通用脚本直接调用），默认写入 `null`。

---

## 二、字段设计与决议

### 1. 最终决定增加的字段
在 `memories` 表与 `pitfalls` 表中各增加两个语义精确的字段：

1. **`source_session`**：`VARCHAR(128)`, `nullable: true`
   - **语义**：产生此条知识的来源会话标识。
   - **取值**：
     - 若为网关钩子/录制扫描：客户端发送的会话 ID（如 Claude Code UUID、OpenCode session ID、Web 会话 ID）。
     - 若客户端未携带会话头：可回退为首轮用户提问的 SHA256 指纹前缀（`conv-xxxxxxxx`，完全契合 Magpie 上游 `conversationID` 算法），或保留为 NULL / 空串。
     - 若为 Agent 通过 MCP 工具手动沉淀：传入的当前 session 标识，未指定时为 NULL。
2. **`source_turn`**：`INT`, `nullable: true`
   - **语义**：产生此条知识的来源会话轮次序号（从 1 起始的正整数）。
   - **取值**：
     - 网关钩子：依据请求中历史 user 消息数量计算（`turns_count`）。
     - 读录制扫描：依据 `turns.jsonl` 中的行序号。
     - 无法推导或非会话产生：NULL。

### 2. 否决的方向与原因
- **否决「增加时间定位列 `source_time`」**：
  `memories` 与 `pitfalls` 原表已存在 `created_at`（精确到秒的时间戳，入库时自动或显式打点）；录制文件与钩子采集均为准实时入库，无需冗余增加时间列，避免字段膨胀。
- **否决「增加内容摘要指纹列 `source_fingerprint`」**：
  表中已存在 `content_fingerprint`（32 字节唯一十六进制指纹，且建有唯一索引防重），直接由内容与上下文哈希得出，完全能用于人工与自动化精确溯源，无须重复增加指纹字段。
- **否决「伪造假会话 ID（如用随机 UUID 冒充）」**：
  严禁伪造不存在的会话标识。拿不到会话标识时坦诚置为 NULL 或依据规范规则派生。

---

## 三、空值语义说明（避免未来被误判为 Bug）

`source_session` 与 `source_turn` 在以下情况下为 `null` 是**完全合法且符合设计预期的正常行为**：
1. **Agent 通过 MCP 工具显式保存（`memory_save`/`pitfall_save`）**：若宿主未注入 `session` 上下文，且 Agent 未显式传参，记录为 `null`。
2. **简单 HTTP 客户端直接调用 Magpie**：如通过 `curl` 或单次脚本直接调用 `/v1/chat/completions`，客户端未声明任何会话头（`X-Magpie-Session`、`x-session-id` 等），此时无原生会话概念。
3. **独立或跨会话重放任务**：如离线测试用例直接调用底层存储函数。

---

## 四、具体实施蓝图（供并行代理收工后执行）

### 1. `schema.js` 修改点
- `SCHEMA_VERSION`: 由 3 递增至 4。
- `MIGRATIONS[4]`:
  `"新增来源可追溯性字段：memories 与 pitfalls 表增加 source_session (VARCHAR 128) 与 source_turn (INT)"`
- `TABLES.memories.columns` 追加：
  ```js
  { name: "source_session", type: "VARCHAR", length: 128, nullable: true },
  { name: "source_turn", type: "INT", nullable: true },
  ```
- `TABLES.pitfalls.columns` 追加：
  ```js
  { name: "source_session", type: "VARCHAR", length: 128, nullable: true },
  { name: "source_turn", type: "INT", nullable: true },
  ```

### 2. `tools.js` 修改点
- `memorySave` payload 新增：
  ```js
  source_session: String(args.source_session || (context && context.session) || '').trim() || null,
  source_turn: Number.isInteger(args.source_turn) ? Number(args.source_turn) : null,
  ```
- `pitfallSave` payload 新增：
  ```js
  source_session: String(args.source_session || (context && context.session) || '').trim() || null,
  source_turn: Number.isInteger(args.source_turn) ? Number(args.source_turn) : null,
  ```
- `TOOLS.memory_save` 与 `TOOLS.pitfall_save` 的 properties 中增加两字段定义。

### 3. `gateway_harvest.hooks.js` 修改点
- 在 `onRequest` / `onResponse` 计算轮次：
  ```js
  function countTurnsFromMessages(body) {
    if (!body) return 1;
    if (Array.isArray(body.messages)) {
      const u = body.messages.filter(m => m && (m.role === 'user' || !m.role));
      return Math.max(1, u.length);
    }
    if (Array.isArray(body.contents)) {
      const u = body.contents.filter(c => c && c.role !== 'model');
      return Math.max(1, u.length);
    }
    return 1;
  }
  ```
- 在调用 `processDialogueAndHarvest` 时，`meta` 对象传入：
  ```js
  const meta = {
    project: opts.project || "global",
    agent: ctx.agent || "gateway",
    session: ctx.session || (ctx.state && ctx.state.session) || "",
    turn: countTurnsFromMessages(requestBody),
  };
  ```
- 在 `processDialogueAndHarvest` 入库 `memories` 与 `pitfalls` 时将 `source_session: meta.session || null` 与 `source_turn: meta.turn || null` 写入数据库。

### 4. `gateway_harvest.js` 修改点
- 在 `harvestGateway` 扫描 `turns` 循环中：
  ```js
  let turnIndex = 0;
  for (const turn of turns) {
    turnIndex++;
    const sessId = String(turn.session || turn.Session || "").trim();
    // 写入 memories:
    await saveMemory(client, cfg, {
      ...
      source_session: sessId || null,
      source_turn: turnIndex,
    });
    // 写入 pitfalls:
    await pitfallSave(client, cfg, {
      ...
      source_session: sessId || null,
      source_turn: turnIndex,
    });
  }
  ```

### 5. `harvest.py` 修改点
- 在 `save_memory` 与 `save_pitfall` 的 `ncb.create` 字典中增加：
  ```python
  "source_session": m.get("source_session") or None,
  "source_turn": int(m["source_turn"]) if m.get("source_turn") is not None else None,
  ```

### 6. 测试与门禁配套
1. 更新 `tests/check_schema_sync.mjs`：确保代码写入字段与 schema 声明 100% 对齐（全绿）。
2. 新增 `tests/test_traceability.mjs`：
   - 用例 1（正向）：提供 session 与 turn 时，断言入库时两字段有值且非空。
   - 用例 2（反向）：无 session 时调用，断言不崩溃且两字段为 `null`，严禁伪造假数据。
3. 运行 `node tests/test_pollution_guard.mjs` 确保测试对生产库零污染。
