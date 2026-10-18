# 流式剥离吞响应致 499 故障根治检查点报告 (v6.24.0 · NOTES_stream_swallow_fix.md)

**发布版本**：`v6.24.0`（`package.json` 与 `settings.html` 严格同步对齐）  
**整改基准 Commit**：`9d21653` (v6.23.0)  
**主要整改范畴**：
1. **诱因根治**：从 prompt 引导中彻底剔除「无工具时回复末尾追加 `<memory>JSON 数组</memory>`」的兜底指令，引导只保留 `memory_save` 与 `pitfall_save` 工具调用；
2. **中间件核心加固 (`stripStream` 硬 fail-open)**：
   - 扣留超限（`HOLD_MAX`）立即把扣留内容原样吐出，且该流彻底置为 `memBypassed = true; memHold = -1;`，后续所有块逐字节透传，绝不再扣留；
   - 单 chunk 超限判定：修正历史逻辑单包超限仍被扣住返回空字串的缺陷；
   - 流结束但未闭合：在 `isFinish` 保命分支中全量释放已有扣留，零字丢失；
   - 任何异常保命：`stripStream` 内部与 `onEvent` 顶层均捕获异常，第一时间将当前扣留缓冲区原样拼回，绝不吞用户内容；
   - 块闭合后恢复正常透传：支持多块连续处理及块后正文实时透传；
3. **三大反证测试**：新增 `tests/test_stream_failopen.mjs`，包含对改前老逻辑的精确反证（确证改前吞首包、吞后续正文会红）；
4. **元门禁与全套测试回归**：`test_meta.mjs` 锁定 38 个单测，全套测试 100% 通过。

---

## 一、病根剖析与实机链路

### 1. 现象复现链路
- 当大模型未被分配工具调用能力或无法调用 MCP 工具时，旧版中间件在 Prompt 中引导：「若你的工具列表里没有它，改为在回复末尾追加 `<memory>JSON 数组</memory>` 块」。
- 实测该引导诱发部分大模型在流式输出中产出数千至上万 tokens 的未闭合 `<memory>[\n...` 块。
- 中间件 `stripStream` 进入 `st.memHold = 1` 状态开始扣留缓冲，直到 `HOLD_MAX` (20000 字符)。
- 在此期间，中间件持续向客户端返回空字串 `""`，客户端在 30s~60s 内未收到任何有效 token，只有 keepalive，最终触发客户端超时取消或用户主动中断，网关返回 HTTP 499 (Client Closed Request)。

### 2. 旧版 `stripStream` 的四重缺陷
1. **单包超限依然被吞**：`hold === 0` 中进入扣留时直接 `return st.memHead;`，未校验当前 `rem` 是否已超过 `HOLD_MAX`。即使单包已有 25,000 字符，首包依然返回 `""`，被完全吞掉；
2. **超限后未能永久熔断**：旧代码在 `st.memBuf.length > HOLD_MAX` 时将 `st.memHold` 重置为 `0`，导致后续正文中若再次出现 `<memory>[`，又被重新扣留吞掉；
3. **异常吞字漏洞**：外层 `try/catch` 捕获异常后直接返回原 event，留在 `st.memBuf` 和 `st.memPending` 中的字符被遗弃在状态机中，用户正文彻底丢失；
4. **多块与块后散文脆弱性**：一块闭合后，如果后文散文提到了 `<memory` 且紧随 `[`（如 `[2024]`），容易被再次诱发误吞。

---

## 二、三步任务完成情况

### ① 引导清理核对
- **核对结果**：已彻底完成。
- **校验命令**：`rg -n "JSON 数组|无工具时" memory.middleware.js` 输出为空（0 行残留）。
- **引导现状**：
  - strict 模式：保留 `memory_save`、`pitfall_save`、`memory_context`、`memory_search`、`pitfall_search` 工具指导，明确「无工具调用能力时跳过保存，绝不在回复里输出 <memory> 标签块」；
  - soft 模式：只保留工具保存指导，同样明确禁止输出 `<memory>` 标签块。

### ② `stripStream` 硬 fail-open 核心实现

各释放分支实现要点：

#### 1. 永久熔断直通分支 (Bypass)
```javascript
if (st.memBypassed || st.memHold === -1) {
  var prefix = (st.memPending || "") + (st.memBuf || "");
  st.memPending = "";
  st.memBuf = "";
  return prefix + (piece || "");
}
```

#### 2. 单包即超限即时吐出分支 (`hold === 0`)
```javascript
if (st.memBuf.length > holdLimit) {
  var flush0 = st.memHead + st.memBuf;
  st.memHold = -1;
  st.memBypassed = true;
  st.memBuf = "";
  st.memPending = "";
  return flush0;
}
```

#### 3. 累计超限即时吐出与永久熔断分支 (`hold === 1`)
```javascript
if (st.memBuf.length > holdLimit) {
  var flush = st.memBuf;
  st.memHold = -1;
  st.memBypassed = true;
  st.memBuf = "";
  st.memPending = "";
  return flush;
}
```

#### 4. 正常闭合块剥离与透传恢复分支
```javascript
var end = st.memBuf.indexOf(CLOSE_TAG);
if (end !== -1) {
  st.memHold = 0;   // 块闭合，恢复正常透传
  var tail = st.memBuf.slice(end + CLOSE_TAG.length);
  st.memBuf = "";
  return tail ? stripStream(tail, st) : "";
}
```

#### 5. 流结束 (`isFinish`) 兜底保命分支
```javascript
if (isFinish(event)) {
  if (st.inlineExtract) {
    var toRelease = "";
    if (st.memPending) {
      toRelease += st.memPending;
      st.memPending = "";
    }
    if (st.memBuf) {
      toRelease += st.memBuf;
      st.memBuf = "";
      st.memHold = 0;
    }
    if (toRelease) {
      var curVis = pickText(event) || "";
      setEventText(event, curVis + toRelease);
    }
  }
}
```

#### 6. 异常安全分支 (Exception Fail-Open)
```javascript
function stripStream(piece, st) {
  try {
    return _stripStreamInner(piece, st);
  } catch (err) {
    var toRelease = (st.memPending || "") + (st.memBuf || "");
    st.memPending = "";
    st.memBuf = "";
    st.memHold = -1;
    st.memBypassed = true;
    return toRelease + (piece || "");
  }
}
```
并在外层 `onEvent` 异常捕获中加入状态机残存缓冲区释放逻辑，双保险杜绝丢字。

---

## 三、测试用例与反证确证 (`tests/test_stream_failopen.mjs`)

### 1. 测试用例矩阵
- **测试 1：超大未闭合块 + 块后正文**
  - **断言**：单包 25,000 字符立即全量释放（首包不为空）；后续包含 `<memory>[` 的正文块绝不再被扣留；全文逐字节 100% 吻合。
  - **改前反证**：改前老逻辑在 chunk 1 输出 0 字节；在 chunk 4 输出 0 字节（再次被吞）。测试中包含对老逻辑的反证校验，确证「改前必红」。
- **测试 2：一个正常闭合块 + 之后还有正文**
  - **断言**：记忆块被 100% 剥离；块后正文实时恢复透传，散文中提到的 `<memory>` 标签完整保留；全文逐字节吻合。
- **测试 3：连续多个块**
  - **断言**：4 个记忆块（含单对象、换行、不同位置）全部被剥离；前序、中段、结语正文 100% 完整保留。
- **测试 4：异常分支硬保命**
  - **断言**：发生异常时，已有扣留缓冲区即刻全量释放，状态置为彻底透传。

### 2. 执行输出
```text
=================================================================
【流式剥离硬 fail-open 验收与反证测试】
=================================================================

--- 测试 1: 超大未闭合块 + 块后正文 实时透传与零吞字 ---
  ✓ [反证确认] 改前老逻辑首包输出 0 字节，后续 chunk 4 被彻底吞掉（实证改前会红）
  ✓ [正向验证] 超大未闭合块触发立即吐出，且后续块永久透传，正文零吞字！

--- 测试 2: 一个正常闭合块 + 之后还有正文 块剥离与正文全保 ---
  ✓ [正向验证] 正常闭合块剥离干净，块后多段正文（含散文提到标签）100% 保全且即时透传！

--- 测试 3: 连续多个块 块剥离与正文全保留 ---
  ✓ [正向验证] 连续多个块（含单对象、换行、交替正文）全部精准剥离，正文无损！

--- 测试 4: 异常分支硬保命测试 ---
[memory-hub] onEvent 已降级(fail-open): Error: 故意触发的测试异常
  ✓ [正向验证] 发生异常时扣留缓冲区被全量释放，后续状态置为彻底透传！

=================================================================
🎉 流式剥离硬 fail-open 全部三大反证与保命测试 100% 通过！
=================================================================
```

---

## 四、版本与发布确认
- `package.json`：`"version": "6.24.0"`
- `settings.html`：`<span class="version-tag">v6.24.0</span>`
- `tests/check_schema_sync.mjs`：版本对齐校验通过。
- `tests/test_meta.mjs`：38 个单测元检查全部通过。
