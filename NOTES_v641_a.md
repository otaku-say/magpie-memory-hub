# NOTES_v641_a: 实现 ARCH-2 中间件零拷贝快路径与宿主/测试双向反证

## 1. 任务背景与核心问题

- **任务定位**：在分支 `feat/v641-a-mw` 中实现 **ARCH-2**：对齐宿主网关底层零拷贝机制。
- **底层机制对标**：
  - 宿主 `magpie-main/internal/middleware/run.go:224` 中：
    ```go
    res, err := in.call(h, limit, v, ctx)
    switch {
    case err != nil:
        return nil, err
    case res.IsUndefined():
        return nil, nil // 直接跳过 in.rt.AppendJSON 序列化，原字节零拷贝透传
    ...
    return in.rt.AppendJSON(nil, res)
    ```
    当中间件返回 `undefined` 时，Go 侧完全跳过 `in.rt.AppendJSON` 序列化，直接复用原网络字节切片并直通下游。
  - 原插件代码中，`onEventInner` 无论是否修改，最后均执行 `return event;`。在流式对话中，模型每吐出一个 token 生成一个 SSE chunk，Go 宿主都要对未发生任何修改的 chunk 进行全量 AST→JSON 重序列化与内存分配，造成每轮流式请求数千次冗余拷贝与性能开销。
- **核心约束与防线**：
  1. **宿主判定准则**：严格使用 `typeof ctx.report === "function"` 判断是否运行在宿主环境中（特别注意：宿主 `ctx.reject` 不存在！）。
  2. **测试环境兼容性**：在单测与本地测试环境下（`ctx` 为普通对象，`ctx.report` 未定义），必须保持返回 `event` 对象，100% 维持既有断言兼容性。
  3. **双向反证门**：正向验证未修改时返回 `undefined`、测试环境返回 `event`；反向反证修改场景（标签剥离、流结束缓冲释放）绝不得误返回 `undefined`；异常 fail-open 按宿主/单测自适应保命。
  4. **文件所有权遵守**：本分支严格只修改 `memory.middleware.js`，新增 `tests/test_v641_a_mw.mjs` 与 `NOTES_v641_a.md`。严格遵守 DEVNOTES 规范，不修改 `test_meta.mjs` 中的文件计数，由新测试通过 `scanTestFile` 自验。

---

## 2. 详细实现细节

### 2.1 memory.middleware.js 修改点

1. **`onEventInner(event, ctx)` 零拷贝快路径与修改跟踪**：
   ```js
   function onEventInner(event, ctx) {
     ctx = ctx || {};
     var isHostRuntime = Boolean(ctx && typeof ctx.report === "function");
     if (!ctx.state) return isHostRuntime ? undefined : event;
     var st = ctx.state;

     // 快路径：若未开启内联剥离，或流已进入直通态且无待释放缓冲，零开销直接返回
     if (!st.inlineExtract || ((st.memBypassed || st.memHold === -1) && !st.memPending && !st.memBuf)) {
       return isHostRuntime ? undefined : event;
     }

     var mutated = false;
     var piece = pickText(event);
     if (piece) {
       /* 用户可见的部分去掉 <memory> 块 */
       if (st.inlineExtract) {
         var visible = stripStream(piece, st);
         if (visible !== piece) {
           setEventText(event, visible);
           mutated = true;
         }
       }
     }
     if (isFinish(event)) {
       if (st.inlineExtract) {
         // 流结束保命：若有扣留未闭合的待定尾部或未闭合块，原样释放
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
           mutated = true;
         }
       }
     }
     if (!mutated && isHostRuntime) {
       return undefined; // 触发宿主零拷贝快路径
     }
     return event;
   }
   ```

2. **`onEvent(event, ctx)` 顶层异常 fail-open 保护升级**：
   ```js
   export function onEvent(event, ctx) {
     try { return onEventInner(event, ctx); }
     catch (e) {
       /* 顶层异常保命：若 ctx.state 里有扣留内容，必须释放到当前 event，绝不能丢用户内容 */
       var mutated = false;
       if (ctx && ctx.state) {
         try {
           var toRelease = (ctx.state.memPending || "") + (ctx.state.memBuf || "");
           ctx.state.memPending = "";
           ctx.state.memBuf = "";
           ctx.state.memHold = -1;
           ctx.state.memBypassed = true;
           if (toRelease) {
             var curVis = pickText(event) || "";
             setEventText(event, toRelease + curVis);
             mutated = true;
           }
         } catch (_) {}
       }
       var isHostRuntime = Boolean(ctx && typeof ctx.report === "function");
       var fallback = mutated ? event : (isHostRuntime ? undefined : event);
       return _mwFailOpen("onEvent", e, fallback);
     }
   }
   ```

---

## 3. 双向反证测试矩阵 (`tests/test_v641_a_mw.mjs`)

| 门禁分类 | 测试用例 | 验证与反证设计 |
| :--- | :--- | :--- |
| **宿主正向 a** | 普通文本未修改 chunk | 宿主环境下普通 SSE 文本 chunk `onEvent` 返回 `undefined` |
| **宿主正向 b** | ping / 空 delta chunk | ping 事件与空 delta 在宿主环境下返回 `undefined` |
| **宿主正向 c** | 直通态 / 未开启 inlineExtract | `memBypassed = true` 或 `inlineExtract = false` 快速返回 `undefined` |
| **宿主正向 d** | 无积压流结束 chunk | 正常 `finish_reason: "stop"` 无缓冲时返回 `undefined` |
| **核心反证 e** | 记忆块剥离修改 | chunk 包含 `<memory>` 标签被剔除修改时，**绝对不得返回 `undefined`**，必须返回修改后保留可见正文的 `event` 对象 |
| **核心反证 f** | 流结束释放未闭合缓冲 | 流结束时积压的未闭合 `<memory>` 缓冲合并释放到当前事件，**绝对不得返回 `undefined`**，必须返回携带释放内容的 `event` 对象 |
| **异常自适应 g** | fail-open 分支保命 | 无缓冲异常返回 `undefined` 透传；有缓冲异常释放内容并返回 `event`，且标记 `memBypassed = true` |
| **兼容正向 h** | 测试环境未修改文本 | 测试环境（无 `ctx.report`）下未修改普通文本返回 `event` 对象，保持既有单测 100% 兼容 |
| **兼容正向 i** | 测试环境剥离修改 | 测试环境下剥离记忆后返回同一修改后的 `event` 对象 |
| **兼容正向 j** | 极端 / 缺省上下文兼容 | `ctx=null`、`ctx=undefined`、`ctx={}` 均安全回退返回 `event` |
| **兼容正向 k** | 多协议事件兼容 | Anthropic / Responses 协议在测试环境下返回原始 `event` |
| **判定防线 l** | 真实宿主 (有 report，无 reject) | `ctx.reject` 为 `undefined` 依然稳定判定为宿主走快路径（返回 `undefined`） |
| **反证防线 m** | 伪造环境 (仅有 reject，无 report) | 存在 `ctx.reject` 但无 `report` 坚决判定为测试环境（返回 `event`） |
| **静态断言 n** | 源码判定语句无误 | 正则断言源码中严格使用 `typeof ctx.report === "function"`，零 `ctx.reject` 宿主误依赖 |
| **元规范自验 o** | 测试文件 0 违规 | 通过 `test_meta.mjs` 的 `scanTestFile` 静态扫描，断言 0 违规 |

---

## 4. 验证与回归记录
1. 运行专项双向反证：`node tests/test_v641_a_mw.mjs` → **100% PASS**。
2. 运行多协议全量回归：`node tests/test_multi_protocol.mjs` → **100% PASS**（27 项断言全部绿灯）。
3. 运行 fail-open 保护回归：`node tests/test_failopen.mjs` → **100% PASS**。
4. 运行流式保命回归：`node tests/test_stream_failopen.mjs` → **100% PASS**。
5. 运行加固回归：`node tests/test_hardening.mjs` → **100% PASS**。
6. 运行导出面与静态工具名门禁：`node tests/test_exports.mjs` & `node tests/test_tool_names_static.mjs` → **100% PASS**。
7. 测试规范元检查自证：`scanTestFile` **0 违规**。
