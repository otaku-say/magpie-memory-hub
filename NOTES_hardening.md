# 记忆中枢三项健壮性加固检查点 (NOTES_hardening.md)

## 项目背景与不变量
- 目标目录：`/var/minis/workspace/magpie-memory-hub/`
- 两大核心不变量：
  1. 绝不改写历史消息前缀（保 KV-Cache）
  2. 绝不丢消息（加法式保命）
- 硬性约束：
  - 不许修改 `compress.js`, `tools.js`, `r2.js`, `db_tools.js`
  - 不许修改版本号，不许 git commit/push，改动保留在工作区
  - 每处改动后断言 `assert s.count(old) == 1`（或一次性精确替换）
  - 全部现有测试 + 新增测试全绿通过

---

## 加固项一：设置页 `options.set` 加防抖（规避 429 静默丢配置）
### 1. 源码核实证据
- Magpie 沙箱源码 `/root/magpie/internal/gui/pluginpage.go:301-340`:
  `pageSetAllowed(spec, now)` 规则：`now.Sub(last) < time.Second` 则拦截并返回 `HTTP 429 ("a page sets its options once a second at most")`。
- 官方插件 `@magpie-community/packages/usage` 的 `page/app.js` 采用 1100ms 防抖规避。

### 2. 改造方案 (`settings.js`)
- 实现 `queuedOptionsSet(payload, immediate)` 机制：
  - 内部维护 1100ms 计时器与最新 pending payload。
  - 快速连点多个开关/按钮或连续保存时，自动合并配置并重置 1100ms 计时器，只有最后一次真正落盘，避免 429。
  - 关键操作立即 flush：信标提交（`submitAction` 含 `_action`）、显式点击底部「保存全部设置」（`save`）或各卡片「保存本卡片」（`saveCard` / `saveR2`），以 `immediate: true` 立即取消排队计时器并落盘，保证时效敏感信标零延迟。
  - 必须完整保留「先 `options.get()` 再合并」逻辑，保护 `memories` 快照与其他卡片字段不丢失。

---

## 加固二：流式剥离隔离「思维链」内容
### 1. 背景与依据
- 思考模型（如 DeepSeek-R1 / Claude 3.7 Sonnet thinking 等）会产生上千字思维链。
- `onEventInner` 中 `st.answer` 有 `ANSWER_CAP = 4000` 字符上限；如果直接把推理内容累加进 `st.answer`，会挤爆缓冲区，导致真正的答复正文被截断丢弃。
- 官方 `@magpie-community/middleware-think-tags` 处理了 `<think>...</think>` 等标签。

### 2. 改造方案 (`memory.middleware.js`)
- 采集缓冲 (`st.answer`) 过滤：
  - OpenAI 风格：`delta.reasoning_content`（且无 `delta.content`），跳过累加进 `st.answer`。
  - Anthropic 风格：`delta.thinking`（或 `content_block_start/delta` 的 thinking 块），跳过累加进 `st.answer`。
  - Gemini 风格：`part.thought === true`，跳过累加进 `st.answer`（已有局部跳过，需确保完整）。
  - 正文标签式思维链：流式正文中如果出现 `<think>...</think>` 或 `<thinking>...</thinking>`，在累加到 `st.answer` 前剥离纯思考文本，正文回答才累加进缓冲区。
- 客户端流式输出保障（核心不变量）：
  - 思考内容剥离**仅影响采集缓冲区 `ctx.state.answer`**！
  - 给客户端透传的 event 内容**逐字节不变**（除现有的 `<memory>` 标签剥离外，绝对不改动用户的思考内容输出）。
  - 拿不准的情况宁可保留，遵守加法式保命。

---

## 加固三：`ctx.reject(418)` 存活探针
### 1. 背景与依据
- 第三方插件 `heaven-1314/magpie-plugin-claude-scrub` 使用 `ctx.reject(418, msg)` 做存活确认。
- Magpie 网关 `ctx.reject(code, msg)` 支持 400-599 状态码阻断请求并返回消息。

### 2. 改造方案 (`memory.middleware.js`)
- 在 `onRequestInner` 入口处进行精准匹配：
  - 提取最后一条用户消息文本。
  - 当且仅当文本精准等于探针串 `"__MEMHUB_PROBE__"` 时触发。
  - 防御性调用：检查 `typeof ctx.reject === "function"`。如果不存在，则降级继续正常流程。
  - 若存在，执行：
    ```javascript
    return ctx.reject(418, JSON.stringify({
      status: "ok",
      probe: "__MEMHUB_PROBE__",
      plugin: PLUGIN_NAME,
      version: 5,
      disabled: !!opts.disabled,
      memories_count: (opts.memories && opts.memories.length) || 0,
      compress: opts.compress !== false,
      protocol: proto,
      turn_no: ctx.state.turnNo,
      timestamp: Date.now ? Date.now() : 0
    }));
    ```
- 测试覆盖：在 `tests/test_probe.mjs` 中构建单元测试，验证各种协议输入下的探针拦截、返回数据 schema、以及 `ctx.reject` 缺失时的 fail-open 表现。

---

## 阶段进度检查点
- [x] 阶段 0：上游沙箱源码调研验证 + 本地现有 25 个测试基线验证全绿
- [x] 阶段 1：加固一 settings.js options.set 防抖与立即 flush 改造
- [x] 阶段 2：加固二 memory.middleware.js 思维链内容隔离（只隔离缓冲，透传零篡改）
- [x] 阶段 3：加固三 memory.middleware.js __MEMHUB_PROBE__ 存活探针与 test_hardening.mjs
- [x] 阶段 4：全部测试套件验证 + 最终报告撰写
