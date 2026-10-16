# Magpie Memory Hub 拔除 stdout 死链路审计与删除检查点 (NOTES_deadchain.md)

**记录时间**：2026-10-17  
**工作目录**：`/var/minis/workspace/magpie-memory-hub/`  
**任务目标**：移除之前为未生效的自动记忆添加的、已经无用的代码（stdout 死链路）。

---

## 一、死链路背景与确证事实

在官方 Docker 部署环境（`gcr.io/distroless/cc-debian12:nonroot`）下：
1. 中间件（moejs 运行时）通过 `console.log("[MEMORY_HARVEST]{json}")` 输出对话。
2. Go 网关中间件驱动代码将该输出仅记入容器日志（`log.Printf`），与任何外部独立进程的 stdout 毫无管道关联。
3. 容器内无 Python 运行时，`harvest.py` 根本无法在容器内常驻运行。
4. 真实生产环境已改用官方原生异步网关请求钩子（`gateway_harvest.hooks.js`，基于 `magpie.hooks`，网关异步直传完整 reply），完全脱离 stdout 链路。
5. 结论：`中间件累加 st.answer -> harvest() -> console.log -> 无人消费` 是一条 100% 从未生效的死链路。

---

## 二、全仓消费者搜索结果 (Consumer Search Results)

| 符号 / 代码段 | 所在文件及位置 | 搜索匹配与消费者分析 | 结论 |
|---|---|---|---|
| `HARVEST_TAG` | `memory.middleware.js:24`<br>`harvest.py:45` | 全仓仅在 `memory.middleware.js`（`harvest` 日志输出）与 `harvest.py`（`read_turns` 匹配行前缀）中出现，无任何其它代码读取。 | **全量移除**（仅服务于死链） |
| `harvest(ctx)` | `memory.middleware.js:995` | 全仓仅在 `onEventInner`（完成事件）与 `onResponseInner`（非流式末尾）被调用，作用仅是拼接 JSON 打印日志。 | **全量移除**（仅服务于死链） |
| 两处 `harvest(ctx)` 调用 | `memory.middleware.js:1171, 1226` | 仅在流式结束和非流式结束调用 `harvest(ctx)`。 | **全量移除**（仅服务于死链） |
| `ANSWER_CAP` | `memory.middleware.js:28` | 仅用于限制 `st.answer` 累加上限（4000 字符）以及 `harvest` 中切片。 | **全量移除**（仅服务于死链） |
| `PROMPT_CAP` | `memory.middleware.js:29` | 仅用于 `harvest` 中切片 `promptText`（1500 字符）。 | **全量移除**（仅服务于死链） |
| `st.answer` / `ctx.state.answer` 累加与状态 | `memory.middleware.js:564, 1000, 1138-1139, 1152-1153, 1184, 1223` | 生产代码中除 `harvest(ctx)` 消费外无任何读者。测试集 `test_hardening.mjs` 与 `test_multi_protocol.mjs` 中有断言，注释明确写着「供离线提炼」「采集缓冲」。设置页、数据库、网关接口均不读取。 | **全量移除**（仅服务于死链） |
| `ctx.state.harvested` | `memory.middleware.js:565, 997, 998` | 仅用于 `harvest(ctx)` 防重入判定。 | **全量移除**（仅服务于死链） |
| `isPureThinkingEvent` | `memory.middleware.js:1020` | 仅在 `onEventInner` 累加 `st.answer` 前用于跳过 reasoning_content / thinking 事件。客户端透传完全不走此函数。 | **全量移除**（仅服务于死链衍生缓冲保护） |
| `stripThinkingFromPiece` & `_thinkCarry`, `_thinkInside`, `_thinkCloseTag` | `memory.middleware.js:1042-1116` | 仅在流式累加 `st.answer` 时剥离思维链，防止 4000 字符缓冲区挤爆。客户端流式输出始终原样透传。 | **全量移除**（仅服务于死链衍生缓冲保护） |
| `stripThinkingWhole` | `memory.middleware.js:1118-1123` | 仅在非流式赋给 `ctx.state.answer` 时剥离思维链。客户端消息正文使用 `stripMemoryBlock` 处理 `<memory>`。 | **全量移除**（仅服务于死链衍生缓冲保护） |
| `read_turns(stream, follow)` | `harvest.py:1448-1465` | 仅供 `harvest.py` 的 stdout/日志流消费循环使用。 | **全量移除**（仅服务于死链消费端） |
| `for turn in read_turns(stream, follow):` | `harvest.py:1564` | `harvest.py` 内部 `run()` 函数对 `read_turns` 的消费循环。 | **全量移除**（仅服务于死链消费端） |

---

## 三、待确认未删清单及理由 (Pending Retentions & Justifications)

1. **`ctx.state.promptText`**：
   - **保留理由**：在 `onRequestInner` 中设置，被 `tests/test_multi_protocol.mjs` 用于断言多协议下的 prompt 提取无误（测试行 81、125）。保留该状态无性能损耗，且保留了请求解析的诊断字段。
2. **`stripMemoryBlock(text)`**：
   - **保留理由**：在 `onResponseInner` 中用于剥离客户端返回中的 `<memory>` 标签，直接关乎用户屏幕清洁度（UX），严禁删除。
3. **`stripStream(piece, st)` 及 `st.memHold` / `st.memBuf` / `st.memPending`**：
   - **保留理由**：流式去除 `<memory>` 标签及加法式保命机制，属于核心用户体验与消息完整性保护，严禁删除。
4. **`process_turn(cfg, ncb, turn, caches, dry_run)` (in `harvest.py`)**：
   - **保留理由**：虽然原 stdout 主循环消费了它，但 `process_turn` 本身作为独立的离线对话规则抽取函数，保留其完整性可供独立调用或单测使用，无副作用。
5. **`compress.js`**：
   - **保留理由**：硬性要求「不许动 compress.js」，负责请求体上下文语义压缩，与 stdout 采集链无关。

---

## 四、测试调整方案

1. **`tests/test_hardening.mjs`**：
   - 保留「加固三（__MEMHUB_PROBE__ 存活探针 418 响应全部 5 组测试）」；
   - 保留「加固一（设置页 queuedOptionsSet 1100ms 防抖与 _action 立即 flush）」；
   - 调整「加固二（思维链隔离）」：
     - 保留断言：「流式正文客户端收到的 chunk 逐字节 100% 保持原样」；
     - 保留断言：「OpenAI delta.reasoning_content 客户端逐字节不变」；
     - 保留断言：「Anthropic thinking 结构客户端逐字节不变」；
     - 保留断言：「非流式 onResponse body 客户端逐字节不变」；
     - 移除针对死链路内部缓冲 `ctx.state.answer` 的断言。
2. **`tests/test_multi_protocol.mjs`**：
   - 移除 3 处针对 `ctx.state.answer`（明确注明「供离线提炼」）的断言（行 210、275、318）；
   - 保留所有四种协议的记忆注入、历史保密性、流式 `<memory>` 剥离与加法式保命断言。


---

## 五、追加关联真 Bug 修复（散文提及 `<memory>` 标签导致正文截断）

### 1. 真实复现机理
在流式响应中，若模型在散文中【提到】`<memory>` 标签（如「使用 `<memory>` 标签来保存」）：
- 旧代码在识别到 `<memory` 时无条件置 `memHold = 1`，持续等待 `</memory>`。
- 散文自然无闭合标签，导致标签之后全部正文被扣入 `st.memBuf`。
- 更严重的是：各协议的完成事件（如 Chat 的 `finish_reason: "stop"`、Anthropic 的 `message_stop` / `message_delta`、Responses 的 `response.completed`）的 chunk 结构中，原文本字段通常为 undefined 或空。`setEventText` 因强校验 `typeof d.content === "string"`，导致 finish 时未能将扣留内容写回事件，整段正文被静默丢弃。

### 2. 修复实施
1. **精准甄别真记忆块**：
   - 提取 `<memory...>` 后，严格校验跳过空白必须紧跟 `[` 或 `{`（约定 JSON 格式）；
   - 若紧跟散文汉字/英文字符，判定为散文提及，直接原样透传，`memHold` 保持 0。
2. **多协议 finish 写入健壮化**：
   - `isFinish(obj)` 补齐 Anthropic `message_delta`（含 `stop_reason`）的判定；
   - `setEventText` 重构，支持在 Chat、Anthropic、Responses、Gemini 的 finish 事件上写入释放文本 `toRelease`。
3. **非流式 `stripMemoryBlock` 正则收敛**：
   - 改为 `/<memory>\s*(?:\[|\{)[\s\S]*?<\/memory>/gi`，散文中提及标签在非流式下同样 100% 保留。
4. **状态隔离防泄漏**：
   - `onRequestInner` 严格重置 `memHold`、`memBuf`、`memPending`、`memHoldChunks`。

---

## 六、全量测试执行真实输出总结

1. `node --check memory.middleware.js`: 语法检查通过（退出码 0）
2. `python3 -c "import ast;ast.parse(open('harvest.py').read())"`: AST 解析通过（退出码 0）
3. `node tests/test_meta.mjs`: 27 个测试文件元检查 100% 通过
4. `node tests/test_failopen.mjs`: fail-open 外壳验收全部通过
5. `node tests/test_multi_protocol.mjs`: 27 项多协议 + 防吞正文深度断言全绿通过
6. `node tests/test_exports.mjs`: 插件与中间件导出面合规性 100% 通过
7. `node tests/test_gateway_harvest_hooks.mjs`: 6 项异步网关钩子深度测试全绿
8. `node tests/test_hardening.mjs`: 3 项加固及思维链透传保真断言全绿
9. `node tests/check_schema_sync.mjs`: schema 声明与列名对齐，版本号严格同步
10. `node tests/test_gateway_harvest.mjs`: 6 项网关提炼集成与清理断言 100% 通过
11. `node tests/test_tool_names_static.mjs`: 22 个工具名静态检查全部通过
