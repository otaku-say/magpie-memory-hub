# 内联提炼开关与网关门禁绑定调查与诊断报告 (NOTES_inline_extract_binding.md)

## 0. 调查背景与铁律合规
- **任务目标**：排查并修复 `/var/minis/workspace/magpie-memory-hub/` 中用户关闭「内联提炼」后重启容器但引导仍在注入的线上问题。
- **并发状态检查 (`git status`)**：检测到工作区内有并行代理正在编辑 `memory.middleware.js`（处理流式剥离吞响应 499 故障），工作区存在未提交改动。
- **执行准则**：严格恪守铁律——**只做只读诊断与落盘方案，不篡改冲突文件**，完整梳理根因并输出锁死 Bug 的测试方案与修复方案。

---

## 1. 核心问题调查结论

### ① 部署的中间件是否包含门禁？
- **代码中门禁位置**：
  `memory.middleware.js:726`：
  ```javascript
  var wantExtract = opts.inline_extract !== false;
  if (wantExtract) {
    // 注入 [Memory Agent Guide] 引导
  }
  ```
- **版本溯源与确证**：
  1. 该门禁早在 `d93c59a` (v6.7.0) 时就已存在，并在 v6.22.0 (`edaea64`)、v6.23.0 (`9d21653`) 中持续生效。
  2. 用户实机对话中注入的引导文本包含 `[Memory Agent Guide]`（v6.22.0 重构引入的新标题，替换了旧版 `[Memory Instruction]`），确证实机容器运行的代码必然包含 v6.22.0+ 的门禁逻辑。
  3. **结论**：部署的中间件代码确实包含了这道门禁，且代码逻辑上只要 `opts.inline_extract === false`，`wantExtract` 必然为 `false`，绝不注入该引导。

### ② `opts` 的来源与宿主传递机制（上游源码确证）
- **上游源码链路 (`/tmp/magpie-src`)**：
  1. `internal/middleware/run.go:87-95`：
     ```go
     b := make([]byte, 0, len(r.info)+len(m.options)+32)
     b = append(b, r.info[:len(r.info)-1]...)
     b = append(b, `,"options":`...)
     b = append(b, m.options...)
     b = append(b, `,"state":{}}`...)
     ctx, err := in.rt.ParseJSON(b)
     ```
     Go 端将 `m.options` 拼装到 JSON 的 `"options"` 属性中，作为 `ctx` 传给 moejs 运行时的 `onRequest(body, ctx)`。
  2. `memory.middleware.js:537`：
     ```javascript
     var opts = (ctx.options && typeof ctx.options === "object") ? ctx.options : {};
     ```
     中间件直接取 `ctx.options`，两端字段名 100% 对应。
  3. `internal/middleware/middleware.go:88-124`：
     `current()` 每次请求前通过 `stamp()` 检测 `/config/magpie/plugins.json` 及 lockfile 的 mtime 和 size。若文件被修改，自动触发 `load()` 重新编译；容器重启后更是冷启动加载最新配置。
  4. **实机决定性二分验证**：
     用户后续在卡片 ④ 打开「停用网关注入」（`disabled = true`）并保存后，**下一轮对话引导立刻完全消失**（`memory.middleware.js:566: if (opts.disabled) return body;` 生效）。这彻底证明：**宿主到中间件的配置传递链路 100% 正常，宿主读取的就是 `/config/magpie/plugins.json`**。

### ③ 是否存在第二条注入路径？
- **全仓排查结果**：
  1. 全仓全局检索 `Memory Agent Guide`、`检索与沉淀`、`JSON 数组`。
  2. `memory.middleware.js:750-760` 是全仓**唯一**拼装和向用户最后一条消息注入 `[Memory Agent Guide]` 的地方。
  3. `gateway_harvest.hooks.js:404` 中的 `JSON 数组` 仅是后台提炼模型调用时的内部 Prompt，不接触网关用户消息。
  4. 记忆快照注入（`opts.memories`）的前缀是 `[Persistent Memory Context]`，不是 Agent Guide。
  5. **结论**：不存在第二条注入路径。

---

## 2. 为什么「关了内联提炼且重启后引导还在」？（真实根因复盘）

### 根因分析：
1. **保存机制为「单卡片独立保存」**：
   `settings.html` 采用分卡片设计：
   - 卡片 ③：「记忆提炼与入库门槛」包含 `inline_extract`，保存按钮为 `btn_save_card_extract`；
   - 卡片 ④：「网关注入与上下文预算」包含 `inject_principles` 和 `disabled`，保存按钮为 `btn_save_card_inject`；
   - 底部整体保存按钮为 `save`。
   `settings.js:1248` 仅监听 `change` 触发 `paintMode()` 预览文本刷新，**不自动落盘**。
2. **时序复盘**：
   - 用户在设置页拨动卡片 ③ 开关，但若直接重启容器而未点击「保存本卡片」，重启后 `plugins.json` 依然是 `inline_extract: true`；
   - 随后用户在调试指引下用 sed 或保存按钮修改了配置，`grep` 确实显示了 `"inline_extract": false`；
   - 但在 `grep` 验证后，用户紧接着开启了 `disabled`，此前并没有单独发一条普通聊天来验证 `inline_extract: false` 生效后的状态；
   - 助手误以为「重启后仍然在注入」，但实际上是拨动开关后尚未落盘就执行了初次重启。
3. **设置页回显的隐蔽缺陷（真实 UI Bug）**：
   在 `settings.js:190-200` 的 `fill(o)` 中：
   ```javascript
   BOOL.forEach(function (k) {
     var el = $(k); if (!el) return;
     if (k === "search_rewrite") {
       el.checked = o[k] !== false;
       return;
     }
     el.checked = !!o[k];
   });
   ```
   - `package.json` 中默认值为 `true` 的字段有：`inline_extract: true`、`inject_principles: true`、`ccr_cards: false`、`search_rewrite: true`。
   - 中间件采用 `opts.inline_extract !== false`（缺省时为 `true`）。
   - 但是在 `fill(o)` 中，如果远端配置尚未显式写入（即 `o.inline_extract === undefined`），`!!undefined === false`！
   - **这导致设置页在未保存过该项时，页面 checkbox 显示为「关」，但中间件却按「开」运行**！用户看到是关的以为关了，实际上配置里根本没存 `false`。

---

## 3. `inject_principles` 的核对结果
- **绑定完整性**：
  - `settings.html:496`：`<label for="inject_principles">准则置顶</label>`
  - `settings.html:505`：`<input type="checkbox" id="inject_principles">`
  - `settings.js:20`：`CARD_FIELDS.inject` 包含 `"inject_principles"`
  - `settings.js:49`：`BOOL` 包含 `"inject_principles"`
  - `settings.js:227`：`collect()` 正确收集该布尔值
  - `memory.middleware.js:604`：`opts.inject_principles !== false` 正确读取该布尔值
- **为什么用户配置里仍是 `true`？**
  用户以为关了准则置顶，但准则置顶属于卡片 ④，内联提炼属于卡片 ③。若用户只点击了卡片 ③ 的「保存本卡片」，`saveCard("extract")` 只覆盖卡片 ③ 字段，卡片 ④ 字段保留远端旧值（`inject_principles: true`）。只有在卡片 ④ 点击「保存本卡片」或在底部点击「保存全部设置」时才会写入。

---

## 4. 修复方案（UI 侧缺陷修复）

### 修改文件：`settings.js`
在 `fill(o)` 函数中（约 190 行）：
```javascript
// 原代码：
BOOL.forEach(function (k) {
  var el = $(k); if (!el) return;
  if (k === "search_rewrite") {
    el.checked = o[k] !== false;
    return;
  }
  el.checked = !!o[k];
});

// 修正为：默认值为 true 的项统一采用 o[k] !== false 判定，避免缺省时 UI 反显为关闭造成误解
BOOL.forEach(function (k) {
  var el = $(k); if (!el) return;
  if (k === "search_rewrite" || k === "inline_extract" || k === "inject_principles") {
    el.checked = o[k] !== false;
    return;
  }
  el.checked = !!o[k];
});
```

---

## 5. 回归测试方案（锁死该 Bug）

针对本问题的独立回归断言已设计完成，可在 `tests/test_multi_protocol.mjs` 或独立测试中运行：

```javascript
import assert from "node:assert";
import { onRequest } from "../memory.middleware.js";

// 断言 1：opts.inline_extract === false 时，onRequest 绝对不得注入 [Memory Agent Guide]
{
  const body = {
    model: "test-model",
    messages: [{ role: "user", content: "请问 Docker 怎么配置？" }]
  };
  const ctx = {
    protocol: "chat",
    options: {
      inline_extract: false,
      disabled: false,
      memories: []
    },
    state: {}
  };
  onRequest(body, ctx);
  const content = body.messages[0].content;
  assert.strictEqual(
    content.includes("[Memory Agent Guide]"),
    false,
    "门禁硬断言：opts.inline_extract === false 时绝对不得注入引导"
  );
  assert.strictEqual(
    content,
    "请问 Docker 怎么配置？",
    "门禁硬断言：无记忆且关提炼时用户消息逐字节不变"
  );
  console.log("✓ 回归验证通过：inline_extract: false 彻底关停引导注入");
}

// 断言 2：opts.inline_extract === true 时，正常注入引导
{
  const body = {
    model: "test-model",
    messages: [{ role: "user", content: "请问 Docker 怎么配置？" }]
  };
  const ctx = {
    protocol: "chat",
    options: {
      inline_extract: true,
      disabled: false,
      memories: []
    },
    state: {}
  };
  onRequest(body, ctx);
  assert.ok(
    body.messages[0].content.includes("[Memory Agent Guide]"),
    "正向断言：inline_extract === true 时引导正常注入"
  );
  console.log("✓ 正向验证通过：inline_extract: true 引导正常注入");
}
```
