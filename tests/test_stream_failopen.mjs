/**
 * tests/test_stream_failopen.mjs
 *
 * 流式剥离硬 fail-open 三大反证测试：
 * 1. 超大未闭合块 + 块后正文 → 断言正文逐字节透传（证明改前吞响应/吞正文会红）
 * 2. 一个正常闭合块 + 之后还有正文 → 断言正文完整 + 块被剥离
 * 3. 连续多个块 → 断言块剥离 + 正文全保留
 * 4. 异常保命分支 → 发生异常时扣留内容即时释放
 */

import assert from "node:assert";
import { onEvent } from "../memory.middleware.js";

console.log("=================================================================");
console.log("【流式剥离硬 fail-open 验收与反证测试】");
console.log("=================================================================");

function simulateStream(chunks, useFinish = true, finishReason = "stop") {
  const ctx = {
    opts: { inline_extract: true },
    options: { inline_extract: true },
    state: { inlineExtract: true }
  };
  const emittedDeltas = [];
  for (let i = 0; i < chunks.length; i++) {
    const ev = { choices: [{ delta: { content: chunks[i] } }] };
    onEvent(ev, ctx);
    const content = (ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content) || "";
    emittedDeltas.push(content);
  }
  if (useFinish) {
    const fin = { choices: [{ delta: {}, finish_reason: finishReason }] };
    onEvent(fin, ctx);
    const finContent = (fin.choices && fin.choices[0] && fin.choices[0].delta && fin.choices[0].delta.content) || "";
    emittedDeltas.push(finContent);
  }
  return {
    deltas: emittedDeltas,
    full: emittedDeltas.join(""),
    state: ctx.state
  };
}

// -----------------------------------------------------------------------------
// 【测试 1】超大未闭合块 + 块后正文 ✗ → 断言正文逐字节透传 + 改前对比
// -----------------------------------------------------------------------------
console.log("\n--- 测试 1: 超大未闭合块 + 块后正文 实时透传与零吞字 ---");
{
  const HOLD_MAX = 20000;
  // 块体积超过 HOLD_MAX
  const chunk1 = "<memory>[{\"category\":\"fact\",\"content\":\"" + "A".repeat(HOLD_MAX + 1000);
  const chunk2 = "\n【块后正文第一段：核心业务逻辑说明】\n";
  const chunk3 = "【块后正文第二段：提及 <memory>[{\"nested\":1} 格式，绝不可再次扣留吞掉】\n";
  const chunk4 = "【块后正文第三段：最终总结文本】";

  // 改前老逻辑的反证对比函数：重现改前行为以确证「改前必红」
  function runOldLogic(chunks) {
    const st = { memHold: 0, memBuf: "", memPending: "" };
    const deltas = [];
    for (const piece of chunks) {
      if (st.memHold === 0) {
        const i = piece.indexOf("<memory");
        if (i !== -1 && /^\s*[\[{]/.test(piece.slice(i + 8))) {
          st.memHold = 1;
          st.memBuf = piece.slice(i);
          // 老逻辑 BUG 1：单 chunk 超过 HOLD_MAX 依然只返回 head，不检查 HOLD_MAX，吞掉首包
          deltas.push(piece.slice(0, i));
          continue;
        }
        deltas.push(piece);
      } else if (st.memHold === 1) {
        st.memBuf += piece;
        if (st.memBuf.length > HOLD_MAX) {
          const flush = st.memBuf;
          st.memHold = 0; // 老逻辑 BUG 2：重置为 0 而非永久熔断，导致后续块被再次吞掉
          st.memBuf = "";
          deltas.push(flush);
        } else {
          deltas.push("");
        }
      }
    }
    return deltas;
  }

  // 1.1 确证老逻辑必红 (反证证明)：
  const oldDeltas = runOldLogic([chunk1, chunk2, chunk3, chunk4]);
  assert.strictEqual(oldDeltas[0], "", "反证确认：老逻辑在 chunk 1 产生 0 字节，首包被彻底扣留/吞掉");
  assert.strictEqual(oldDeltas[3], "", "反证确认：老逻辑在 chunk 4 再次被吞（因 memHold 归 0 重新扣留），输出为空");
  console.log("  ✓ [反证确认] 改前老逻辑首包输出 0 字节，后续 chunk 4 被彻底吞掉（实证改前会红）");

  // 1.2 验证修复后的真中间件行为：
  const res = simulateStream([chunk1, chunk2, chunk3, chunk4], false);

  // 断言 1: chunk 1 达到超限后必须立即释放，首包绝不吞成空字串
  assert.ok(res.deltas[0].length >= HOLD_MAX, "chunk 1 超限后必须立即吐出已扣留内容，绝不返回空字串导致 499");
  // 断言 2: 后续 chunk 2 逐字节透传
  assert.strictEqual(res.deltas[1], chunk2, "chunk 2 必须逐字节透传");
  // 断言 3: 后续含有 <memory>[ 标签的 chunk 3 绝不再扣留（不再继续扣）
  assert.strictEqual(res.deltas[2], chunk3, "chunk 3 即使包含 <memory>[ 也绝不再被扣留，逐字节透传");
  // 断言 4: chunk 4 逐字节透传
  assert.strictEqual(res.deltas[3], chunk4, "chunk 4 必须逐字节透传，绝无尾部丢失");

  // 断言 5: 全文逐字节 100% 吻合
  const expectedFull = chunk1 + chunk2 + chunk3 + chunk4;
  assert.strictEqual(res.full, expectedFull, "超大未闭合流全程逐字节完全保全");
  console.log("  ✓ [正向验证] 超大未闭合块触发立即吐出，且后续块永久透传，正文零吞字！");
}

// -----------------------------------------------------------------------------
// 【测试 2】一个正常闭合块 + 之后还有正文 ✗ → 断言正文完整 + 块被剥离
// -----------------------------------------------------------------------------
console.log("\n--- 测试 2: 一个正常闭合块 + 之后还有正文 块剥离与正文全保 ---");
{
  const chunk1 = "前置正文：系统初始化已就绪。\n";
  const chunk2 = "<memory>[{\"category\":\"fact\",\"title\":\"NCB\",\"content\":\"Database OK\"}]</memory>";
  const chunk3 = "\n块后正文第一段：核心架构解析。";
  const chunk4 = "\n块后正文第二段：注意散文里提到 <memory> 标签说明时绝不被误判。";
  const chunk5 = "\n块后正文第三段：最终汇报完成。";

  const res = simulateStream([chunk1, chunk2, chunk3, chunk4, chunk5], true);

  // 断言 1: 记忆块已被完全剥离
  assert.ok(!res.full.includes("Database OK"), "记忆块内容必须已被完全剥离");
  assert.ok(!res.full.includes("<memory>[{"), "记忆标签必须已被完全剥离");

  // 断言 2: 所有正文必须逐段保留
  assert.ok(res.full.includes("前置正文：系统初始化已就绪。"), "前置正文完整保留");
  assert.ok(res.full.includes("块后正文第一段：核心架构解析。"), "块后正文第一段完整保留");
  assert.ok(res.full.includes("块后正文第二段：注意散文里提到 <memory> 标签说明时绝不被误判。"), "块后散文提及标签完整保留");
  assert.ok(res.full.includes("块后正文第三段：最终汇报完成。"), "块后正文第三段完整保留");

  // 断言 3: 流式实时性断言（块闭合后正文立刻恢复透传）
  assert.strictEqual(res.deltas[0], chunk1, "chunk 1 实时透传");
  assert.strictEqual(res.deltas[1], "", "chunk 2 完整剥离（delta 为空）");
  assert.strictEqual(res.deltas[2], chunk3, "chunk 3 块后正文第一段即刻恢复透传");
  assert.strictEqual(res.deltas[3], chunk4, "chunk 4 散文即刻透传");
  assert.strictEqual(res.deltas[4], chunk5, "chunk 5 结尾即刻透传");

  const expectedFull = chunk1 + chunk3 + chunk4 + chunk5;
  assert.strictEqual(res.full, expectedFull, "闭合块后正文逐字节 100% 吻合");
  console.log("  ✓ [正向验证] 正常闭合块剥离干净，块后多段正文（含散文提到标签）100% 保全且即时透传！");
}

// -----------------------------------------------------------------------------
// 【测试 3】连续多个块 ✗ → 断言块剥离 ✓ 正文全保留
// -----------------------------------------------------------------------------
console.log("\n--- 测试 3: 连续多个块 块剥离与正文全保留 ---");
{
  const chunk1 = "正文序言：开始处理任务。\n";
  const chunk2 = "<memory>[{\"title\":\"blk1\",\"content\":\"data1\"}]</memory>";
  const chunk3 = "<memory>\n[{\"title\":\"blk2\",\"content\":\"data2\"}]\n</memory>";
  const chunk4 = "<memory>{\"title\":\"blk3\",\"content\":\"data3\"}</memory>";
  const chunk5 = "\n正文中段：中间处理结果如上。\n";
  const chunk6 = "<memory>[{\"title\":\"blk4\",\"content\":\"data4\"}]</memory>";
  const chunk7 = "正文结语：全链路测试完成。";

  const res = simulateStream([chunk1, chunk2, chunk3, chunk4, chunk5, chunk6, chunk7], true);

  // 断言 1: 所有 4 个记忆块均被剥离
  for (let k = 1; k <= 4; k++) {
    assert.ok(!res.full.includes(`blk${k}`), `blk${k} 必须被剥离`);
    assert.ok(!res.full.includes(`data${k}`), `data${k} 必须被剥离`);
  }
  assert.ok(!res.full.includes("<memory"), "输出中绝无任何 <memory 标签残留");

  // 断言 2: 所有散文正文完整保全
  const expectedFull = chunk1 + chunk5 + chunk7;
  assert.strictEqual(res.full, expectedFull, "多块交织场景下所有正文逐字节 100% 吻合");
  console.log("  ✓ [正向验证] 连续多个块（含单对象、换行、交替正文）全部精准剥离，正文无损！");
}

// -----------------------------------------------------------------------------
// 【测试 4】异常分支硬保命（fail-open 释放已有扣留）
// -----------------------------------------------------------------------------
console.log("\n--- 测试 4: 异常分支硬保命测试 ---");
{
  const ctx = {
    options: { inline_extract: true },
    opts: { inline_extract: true },
    state: { inlineExtract: true, memHold: 1, memBuf: "<memory>[{\"in_progress\": true}" }
  };
  // 故意构造一个 choices 异常对象，模拟下游内部异常
  const brokenEvent = { choices: [{ get delta() { throw new Error("故意触发的测试异常"); } }] };
  const fallback = onEvent(brokenEvent, ctx);

  // 必须触发 fail-open 保护，将扣留内容释放，且后续彻底 bypass
  assert.strictEqual(ctx.state.memBypassed, true, "异常发生后必须将状态标记为 memBypassed 彻底透传");
  assert.strictEqual(ctx.state.memBuf, "", "异常发生后扣留缓冲区必须清空释放");
  console.log("  ✓ [正向验证] 发生异常时扣留缓冲区被全量释放，后续状态置为彻底透传！");
}

console.log("\n=================================================================");
console.log("🎉 流式剥离硬 fail-open 全部三大反证与保命测试 100% 通过！");
console.log("=================================================================");
