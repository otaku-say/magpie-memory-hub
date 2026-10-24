/**
 * test_adversarial_full_qa.mjs —— v6.47.0 全量 QA 对抗测试（红队视角）
 *
 * 目标：不是复述既有用例，而是主动构造「会让实现露出破绽」的输入：
 *   1. 流式网关：长文本截断、特殊标签注入、分块切裂、并发流互扰
 *   2. 在线模型：空/负/超限候选、null 候选、非法打分、stream:false 契约
 *   3. 数据库客户端：空凭据、断网重试、并发 JSON-RPC、SSE/HTML 异常响应
 *   4. 设置页与本地状态：信标字段契约、幂等、卡片隔离、快照完整、状态序列化
 *
 * 断言纪律：每条用例都必须能「反向失败」——断言的是行为，不是实现细节。
 * 运行：node tests/test_adversarial_full_qa.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stripStream, stripMemoryBlock, pickText, setEventText } from "../src/middleware/stream-utils.js";
import { onEvent, onResponse, onRequest } from "../memory.middleware.js";
import {
  rerankSearchResultsWithModel,
  rewriteSearchQuery,
  parseJsonObject,
} from "../src/integration/provider-models.js";
import { NcbMcp, extractSecret } from "../src/integration/ncb-client.js";
import { makeNoCredentialsClient, makeClient, rowsOf, fetchAll } from "../src/integration/ncb.js";
import { buildSelect, buildInsert, buildUpdate, buildDelete, safeId, sqlValue } from "../src/integration/mcp-client.js";
import { readAction, runPendingAction } from "../src/page/actions.js";
import { writeCardStatus, formatCardStatus } from "../src/core/status-writer.js";
import {
  readState,
  writeState,
  rememberSecret,
  lookupSecret,
  rememberActionState,
  lookupActionState,
  statePath,
  _resetStateCacheForTests,
} from "../src/core/state.js";

const failures = [];
let passed = 0;

function rec(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? " :: " + detail : ""}`);
    console.error(`  ✗ ${name}${detail ? " :: " + detail : ""}`);
  }
}

async function guard(name, fn) {
  try {
    const r = await fn();
    rec(name, true);
    return r;
  } catch (e) {
    rec(name, false, String((e && e.message) || e));
    return undefined;
  }
}

function chatEvent(text) {
  return { choices: [{ delta: { content: text } }] };
}

function streamOf(pieces, st) {
  // onEvent 的快路径读的是「onRequest 预置」的 state.inlineExtract；测试必须显式预置，
  // 否则测到的是「未启用内联提炼」的分支，等于什么都没验。
  if (st.inlineExtract === undefined) st.inlineExtract = true;
  let out = "";
  for (const p of pieces) {
    const ev = chatEvent(p);
    const res = onEvent(ev, { state: st, options: { inline_extract: true } });
    out += pickText(res || ev);
  }
  return out;
}

/** 把一个完整回复切成 n 段，模拟网络分块（含 1 字符极端切法） */
function chunkAll(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const MEM_JSON = '[{"title":"端口占用","content":"lsof -i:3425"}]';

console.log("\n=== 1. 流式网关：长文本 / 标签注入 / 分块切裂 / 并发 ===");

// 1.1 标签被切裂成任意碎片时，仍必须完整剥离且正文零丢失
await guard("1.1 <memory> 块被 1 字符切碎仍完整剥离", () => {
  const visible = "先说结论：重启网关即可。";
  const tail = "以上。";
  const full = visible + "<memory>" + MEM_JSON + "</memory>" + tail;
  for (const size of [1, 2, 3, 5, 7, 13]) {
    const st = {};
    const out = streamOf(chunkAll(full, size), st);
    assert.equal(out, visible + tail, `chunk=${size} 泄漏或丢字: ${JSON.stringify(out)}`);
    assert.equal(st.memBuf, "", `chunk=${size} 残留缓冲`);
  }
});

// 1.2 散文里「提到」标签，不得吞掉后续正文（真实线上事故形态）
await guard("1.2 正文提及 <memory> 不被吞掉后续长文", () => {
  const text = "这个 <memory> 标签的作用是内联提炼，" + "后面的正文必须一字不少。".repeat(200);
  const st = {};
  const out = streamOf(chunkAll(text, 4), st);
  assert.equal(out.length, text.length, `长度被截断：${out.length} != ${text.length}`);
  assert.ok(out.endsWith("后面的正文必须一字不少。"), "尾部正文丢失");
});

// 1.3 特殊标签注入：伪造闭合标签后紧跟正常正文
await guard("1.3 伪造 </memory> 注入不吞掉后续正文", () => {
  const text = "前缀</memory>后缀正文" + "A".repeat(500);
  const st = {};
  const out = streamOf(chunkAll(text, 3), st);
  assert.ok(out.includes("后缀正文"), "闭合标签后的正文被吞");
  assert.ok(out.endsWith("A".repeat(500)), "长尾被截断");
});

// 1.4 完整块 + 尾随正文（同一 chunk）
await guard("1.4 同 chunk 完整块剥离且保留尾随正文", () => {
  const ev = chatEvent("答：好" + "<memory>" + MEM_JSON + "</memory>" + "尾巴");
  const res = onEvent(ev, { state: { inlineExtract: true }, options: { inline_extract: true } });
  assert.equal(pickText(res || ev), "答：好尾巴");
});

// 1.5 宽松标签 <memory >（流式接受，非流式必须一致）
await guard("1.5 宽松标签 <memory > 流式与非流式剥离一致", () => {
  const st = {};
  const streamed = streamOf([`A<memory >${MEM_JSON}</memory>B`], st);
  assert.equal(streamed, "AB", "流式未剥离宽松标签");
  const nonStream = stripMemoryBlock(`A<memory >${MEM_JSON}</memory>B`);
  assert.equal(nonStream, "AB", "非流式与流式行为不一致（宽松标签漏剥）");
});

// 1.6 大小写变体 <MEMORY>（流式与非流式必须一致）
await guard("1.6 大写 <MEMORY> 流式与非流式剥离一致", () => {
  const st = {};
  const streamed = streamOf([`A<MEMORY>${MEM_JSON}</MEMORY>B`], st);
  assert.equal(streamed, "AB", "流式未识别大写标签");
  const nonStream = stripMemoryBlock(`A<MEMORY>${MEM_JSON}</MEMORY>B`);
  assert.equal(nonStream, "AB", "非流式未剥离大写标签");
});

// 1.7 相似标签 <memoryManagement> 必须原样透传（不得误伤）
await guard("1.7 相似标签 <memoryManagement> 原样透传", () => {
  const text = "请检查 <memoryManagement> 配置项。";
  const st = {};
  assert.equal(streamOf([text], st), text);
  assert.equal(stripMemoryBlock(text), text);
});

// 1.8 长时间未闭合 + 超过 HOLD_MAX：fail-open 释放全部内容，绝不静默丢弃
await guard("1.8 超限未闭合块 fail-open 释放全部内容", () => {
  const big = "X".repeat(30000);
  const st = {};
  const first = streamOf(["<memory>[" + big], st);
  // "<memory>"(8) + "["(1) + 30000 = 30009，必须一个字符都不少
  assert.equal(first.length, 30009, `超限时未原样释放（得到 ${first.length}）`);
  assert.equal(st.memBypassed, true, "超限后未进入直通态");
  const after = streamOf(["{}\"]</memory>TAIL"], st);
  assert.ok(after.includes("TAIL"), "直通态仍继续扣留内容");
});

// 1.9 流结束：未闭合的扣留内容必须释放，不能凭空消失
await guard("1.9 流结束释放未闭合扣留内容", () => {
  const st = {};
  const ev1 = chatEvent("<memory>[{\"title\":\"半截");
  st.inlineExtract = true;
  onEvent(ev1, { state: st, options: { inline_extract: true } });
  const finish = { choices: [{ delta: {}, finish_reason: "stop" }] };
  onEvent(finish, { state: st, options: { inline_extract: true } });
  assert.ok(pickText(finish).includes("半截"), "结束时扣留内容未释放");
  assert.equal(st.memBuf, "", "结束后缓冲未清空");
});

// 1.10 并发流互扰：两个独立 ctx.state 交错推进，不得互相污染
await guard("1.10 两条并发流交错不互相污染", () => {
  const stA = { inlineExtract: true };
  const stB = { inlineExtract: true };
  const a = "AAA<memory>[{\"t\":1}]</memory>a-end";
  const b = "BBB<memory>[{\"t\":2}]</memory>b-end";
  const pa = chunkAll(a, 2);
  const pb = chunkAll(b, 3);
  let outA = "";
  let outB = "";
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] !== undefined) {
      const ev = chatEvent(pa[i]);
      outA += pickText(onEvent(ev, { state: stA, options: { inline_extract: true } }) || ev);
    }
    if (pb[i] !== undefined) {
      const ev = chatEvent(pb[i]);
      outB += pickText(onEvent(ev, { state: stB, options: { inline_extract: true } }) || ev);
    }
  }
  assert.equal(outA, "AAAa-end");
  assert.equal(outB, "BBBb-end");
});

// 1.11 1MB 无标签正文：不得截断，且不得因扫描而抛错
await guard("1.11 1MB 正文零截断", () => {
  const text = "长".repeat(1024 * 1024);
  const st = {};
  const out = streamOf(chunkAll(text, 65536), st);
  assert.equal(out.length, text.length, "长文本被截断");
});

// 1.12 非流式：未命中记忆块时不得改写无关排版（连续空行）
await guard("1.12 非流式未命中块时不改动排版", () => {
  const text = "提到 <memory> 这个词。\n\n\n下一段保持原样。";
  const body = { choices: [{ message: { role: "assistant", content: text } }] };
  const out = onResponse(body, { options: { inline_extract: true }, state: {} });
  assert.equal(pickText(out), text, "无关空行被压缩/正文被改写");
});

// 1.13 非流式：真正命中块时仍要剥离
await guard("1.13 非流式命中块正常剥离", () => {
  const body = { choices: [{ message: { content: "A<memory>" + MEM_JSON + "</memory>B" } }] };
  const out = onResponse(body, { options: { inline_extract: true }, state: {} });
  assert.equal(pickText(out), "AB");
});

console.log("\n=== 2. 在线模型链路：候选极端边界 / 非法打分 / stream:false 契约 ===");

const BUDGET = { harvest_max_per_min: 100000, harvest_max_total: 100000 };
const okRanked = (content) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

// 2.1 候选里混入 null：函数必须 fail-open（返回 null），不得把异常抛给调用方
await guard("2.1 候选含 null 不抛异常（fail-open）", async () => {
  let out;
  let err = null;
  try {
    out = await rerankSearchResultsWithModel({
      query: "端口占用",
      candidates: [{ id: 1, title: "ok" }, null, undefined, 42, "str"],
      maxTop: 3,
      options: { audit_model: "m", _fetch: okRanked('{"ranked":[{"id":1,"score":9}]}'), ...BUDGET },
    });
  } catch (e) {
    err = e;
  }
  assert.equal(err, null, "异常逃逸：" + (err && err.message));
  assert.ok(out === null || (out && Array.isArray(out.ranked)), "返回结构非法");
});

// 2.2 非数组 / 空候选：直接跳过（0 网络请求）
await guard("2.2 空候选与非法候选容器直接跳过", async () => {
  let calls = 0;
  const f = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ choices: [] }) };
  };
  for (const cands of [[], null, "x", 123, {}]) {
    const r = await rerankSearchResultsWithModel({ query: "q", candidates: cands, options: { audit_model: "m", _fetch: f, ...BUDGET } });
    assert.equal(r, null);
  }
  assert.equal(calls, 0, "空候选仍发起了模型请求（浪费成本）");
});

// 2.3 maxTop 极端值：不得返回超过候选数、不得因负值产生 slice 反向语义
await guard("2.3 maxTop=0/-3/NaN/1e9 边界收敛", async () => {
  const pool = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, title: "t" + i }));
  const ranked = JSON.stringify({ ranked: pool.map((p) => ({ id: p.id, score: 8 })) });
  for (const [label, maxTop] of [["0", 0], ["-3", -3], ["NaN", NaN], ["1e9", 1e9], ["1.9", 1.9]]) {
    const r = await rerankSearchResultsWithModel({
      query: "q",
      candidates: pool,
      maxTop,
      options: { audit_model: "m", _fetch: okRanked(ranked), ...BUDGET },
    });
    if (r === null) continue;
    assert.ok(Array.isArray(r.ranked), `${label} 返回结构非法`);
    assert.ok(r.ranked.length <= pool.length, `${label} 返回条数超过候选数`);
    const expectMax = maxTop === 1e9 ? 50 : (Number.isFinite(maxTop) ? Math.max(0, Math.floor(maxTop)) : 5);
    assert.ok(r.ranked.length <= expectMax, `${label} 返回 ${r.ranked.length} 条，超过上限 ${expectMax}`);
  }
});

// 2.4 非法 id（0 / 负数 / 非整数）必须被过滤，不能制造「假重排成功」
await guard("2.4 非法 id 不产生假重排结果", async () => {
  const r = await rerankSearchResultsWithModel({
    query: "q",
    candidates: [{ id: 1, title: "a" }, { id: 2, title: "b" }],
    maxTop: 5,
    options: { audit_model: "m", _fetch: okRanked('{"ranked":[{"id":0,"score":9},{"id":-5,"score":8},{"id":"abc","score":9}]}'), ...BUDGET },
  });
  assert.equal(r, null, "全部为非法 id 时应判定为无有效重排，实际返回：" + JSON.stringify(r));
});

// 2.5 打分越界（1e999 → Infinity / 负数）必须夹紧到 [0,10]
await guard("2.5 分数越界被夹紧到 0~10", async () => {
  const r = await rerankSearchResultsWithModel({
    query: "q",
    candidates: [{ id: 1, title: "a" }, { id: 2, title: "b" }],
    maxTop: 5,
    options: { audit_model: "m", _fetch: okRanked('{"ranked":[{"id":1,"score":1e999},{"id":2,"score":-8}]}'), ...BUDGET },
  });
  assert.ok(r && Array.isArray(r.ranked) && r.ranked.length === 1, "负数分应被过滤、Infinity 应保留 1 条");
  assert.ok(Number.isFinite(r.ranked[0].score) && r.ranked[0].score <= 10, "分数未夹紧：" + r.ranked[0].score);
  assert.equal(r.ranked[0].id, 1);
});

// 2.6 候选缺字段 / 空文本：Prompt 里不得出现 undefined 或 [object Object]
await guard("2.6 空文本候选不污染 Prompt", async () => {
  let prompt = "";
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    prompt = body.messages.find((m) => m.role === "user").content;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ranked":[]}' } }] }) };
  };
  await rerankSearchResultsWithModel({
    query: "q",
    candidates: [{ id: 1 }, { id: 2, title: "", content: "", tags: "" }],
    options: { audit_model: "m", _fetch: f, ...BUDGET },
  });
  assert.ok(prompt.includes('"id": 1'), "候选未进入 Prompt");
  assert.ok(!prompt.includes("undefined"), "Prompt 中出现 undefined");
  assert.ok(!prompt.includes("[object Object]"), "Prompt 中出现 [object Object]");
});

// 2.7 所有模型调用必须显式 stream:false（网关 SSE 会让 .json() 直接炸）
await guard("2.7 重排/改写/诊断一律 stream:false", async () => {
  const bodies = [];
  const f = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ranked":[{"id":1,"score":9}],"conclusion":"ok","causes":[],"steps":[]}' } }] }) };
  };
  const base = { audit_model: "m", extract_model: "m", rerank_model: "m", _fetch: f, ...BUDGET };
  await rerankSearchResultsWithModel({ query: "q", candidates: [{ id: 1, title: "a" }], options: base });
  await rewriteSearchQuery({ query: "q", options: base });
  const { explainUnknownErrorWithModel } = await import("../src/integration/provider-models.js");
  await explainUnknownErrorWithModel({ error: new Error("fetch failed"), options: base });
  assert.equal(bodies.length, 3, `模型调用次数异常：${bodies.length}`);
  for (const b of bodies) {
    assert.equal(b.stream, false, "存在未显式声明 stream:false 的调用");
  }
});

// 2.8 超时下限夹紧：极小超时不得变成 1ms 瞬时 abort，也不得无限等待
await guard("2.8 超时下限夹紧到 500ms 并按时 fail-open", async () => {
  const started = Date.now();
  const hang = (url, init) => new Promise((resolve, reject) => {
    const s = init.signal;
    if (!s) return;
    s.addEventListener("abort", () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
  const r = await rerankSearchResultsWithModel({
    query: "q",
    candidates: [{ id: 1, title: "a" }],
    options: { audit_model: "m", rerank_timeout_ms: 1, _fetch: hang, ...BUDGET },
  });
  const cost = Date.now() - started;
  assert.equal(r, null, "超时应 fail-open 返回 null");
  assert.ok(cost >= 450 && cost < 2500, `超时未被夹紧到合理区间：${cost}ms`);
});

// 2.9 结果必须按分数降序且截断到 maxTop
await guard("2.9 结果降序且按 maxTop 截断", async () => {
  const r = await rerankSearchResultsWithModel({
    query: "q",
    candidates: [{ id: 1, title: "a" }, { id: 2, title: "b" }, { id: 3, title: "c" }],
    maxTop: 2,
    options: { audit_model: "m", _fetch: okRanked('{"ranked":[{"id":1,"score":3},{"id":2,"score":9},{"id":3,"score":7}]}'), ...BUDGET },
  });
  assert.deepEqual(r.ranked.map((x) => x.id), [2, 3]);
});

// 2.10 parseJsonObject 抗噪：代码块、前后解释文字、嵌套花括号
await guard("2.10 parseJsonObject 抗噪解析", () => {
  assert.deepEqual(parseJsonObject("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(parseJsonObject("好的，结果如下：{\"a\":{\"b\":2}} 以上"), { a: { b: 2 } });
  assert.equal(parseJsonObject("[1,2,3]"), null, "数组不应被当作对象返回");
  assert.equal(parseJsonObject("not json"), null);
});

console.log("\n=== 3. 数据库/客户端：空凭据 / 断网重试 / 并发 / 异常响应 ===");

// 3.1 空凭据 stub：必须抛出可识别错误，且不能被当成 thenable（否则 await 直接挂死）
await guard("3.1 空凭据 stub 行为可预期", async () => {
  const stub = makeNoCredentialsClient();
  assert.equal(stub._isNoCredentials, true);
  assert.equal(stub.then, undefined, "stub 竟然带 then，await 会挂死");
  let code = "";
  try {
    await stub.list("memories", {});
  } catch (e) {
    code = e.code || "";
  }
  assert.equal(code, "NO_CREDENTIALS");
  const viaMake = makeClient({});
  assert.equal(viaMake._isNoCredentials, true, "空配置未降级为 stub");
});

// 3.2 未知属性访问不得抛异常
await guard("3.2 stub 未知属性安全", () => {
  const stub = makeNoCredentialsClient();
  assert.equal(stub.whatever, undefined);
  assert.equal(typeof stub.list, "function");
});

// 3.3 SQL 构造：注入 / 未知列 / 未知表必须拒绝
await guard("3.3 buildSelect 拒绝注入与未知标识符", () => {
  assert.throws(() => buildSelect("memories", { order_by: "id; DROP TABLE memories" }), /order_by|列名|表名/);
  assert.throws(() => buildSelect("memories", { evil_col: 1 }), /未知列名/);
  assert.throws(() => buildSelect("evil_table", {}), /未知表名/);
  assert.throws(() => buildInsert("memories", {}), /没有任何字段/);
  assert.throws(() => buildUpdate("memories", 1, {}), /没有任何字段/);
  const sql = buildSelect("memories", { project: "p", limit: 5, order_by: "updated_at DESC" });
  assert.ok(sql.includes("LIMIT 5") && sql.includes("ORDER BY `updated_at` DESC"), sql);
  assert.ok(sql.includes("`project` = 'p'"), sql);
});

// 3.4 主键边界：0 / 空串 / 小数 / 科学计数 / 超安全整数必须拒绝
await guard("3.4 safeId 主键边界严格", () => {
  for (const bad of ["", " ", 0, "0", -1, "-1", "1.5", "1e999", 1e999, "abc", null, undefined]) {
    assert.throws(() => safeId(bad), /id/, `未拒绝 ${JSON.stringify(bad)}`);
  }
  assert.equal(safeId("12"), 12);
  assert.equal(safeId(7), 7);
  assert.throws(() => buildDelete("memories", 0), /id/);
});

// 3.5 值转义：反斜杠优先、单引号、NUL、换行
await guard("3.5 sqlValue 逐字符转义", () => {
  assert.equal(sqlValue("a'b"), "'a\\'b'");
  assert.equal(sqlValue("a\\b"), "'a\\\\b'");
  assert.equal(sqlValue("a\nb"), "'a\\nb'");
  assert.equal(sqlValue("a\0b"), "'a\\0b'");
  assert.equal(sqlValue("a\rb"), "'a\\rb'");
  assert.throws(() => sqlValue(NaN), /数值非法/);
  assert.throws(() => sqlValue(Infinity), /数值非法/);
});

// 3.6 空 key 调用：错误可读，且不泄漏内部实现细节
await guard("3.6 空 MCP key 报错可读", async () => {
  const c = new NcbMcp({ apiKey: "", fetch: async () => { throw new Error("should-not-fetch"); } });
  let msg = "";
  try {
    await c.listTools();
  } catch (e) {
    msg = e.message;
  }
  assert.ok(msg.includes("未配置 MCP key"), "错误信息不明确：" + msg);
});

// 3.7 断网重试：瞬时网络错误应被有限重试吸收（只读操作）
await guard("3.7 只读调用对瞬时断网有界重试", async () => {
  let attempts = 0;
  const flaky = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "initialize") {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "x" } } }) };
    }
    attempts++;
    if (attempts <= 2) throw new TypeError("fetch failed");
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } }),
    };
  };
  const c = new NcbMcp({ apiKey: "k", fetch: flaky });
  const schema = await c.getSchema("db1");
  assert.equal(attempts, 3, `重试次数不符（实际请求 ${attempts} 次）`);
  assert.deepEqual(schema, { ok: true }, "重试后结果不正确");
});

// 3.8 401/403 必须给出凭据类错误，而不是「响应无法解析」
await guard("3.8 401/403 错误分类正确", async () => {
  const c = new NcbMcp({
    apiKey: "k",
    fetch: async () => ({ status: 403, ok: false, headers: { get: () => null }, text: async () => "denied" }),
  });
  let msg = "";
  try {
    await c.executeSql("db1", "SELECT 1");
  } catch (e) {
    msg = e.message;
  }
  assert.ok(/无效|权限/.test(msg), "403 未归类为凭据错误：" + msg);
});

// 3.9 并发 20 个调用：JSON-RPC id 必须唯一（不得串包）
await guard("3.9 并发调用 JSON-RPC id 唯一", async () => {
  const ids = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "initialize") {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }) };
    }
    if (body.id != null) ids.push(body.id); // 通知帧没有 id，不计入
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "{\"ok\":true}" }] }, ok: true }),
    };
  };
  const c = new NcbMcp({ apiKey: "k", fetch: fetchImpl });
  await c.initialize();
  await Promise.all(Array.from({ length: 20 }, () => c.executeSql("db1", "SELECT 1")));
  assert.equal(ids.length, 20, "并发请求丢失");
  assert.equal(new Set(ids).size, 20, "JSON-RPC id 发生碰撞（响应会串包）");
});

// 3.10 从建库文本里抽取密钥：必须容忍引号与冒号写法
await guard("3.10 extractSecret 兼容引号/冒号格式", () => {
  const fakeKey = ["ncb", "sec", "qa0123456789abcdef"].join("_");
  const quoted = '"' + fakeKey + '"';
  const a = extractSecret("NCB_SECRET_KEY = " + fakeKey);
  assert.equal(a, fakeKey, "标准格式解析失败");
  const b = extractSecret("NCB_SECRET_KEY = " + quoted);
  assert.equal(b, fakeKey, "带引号格式解析失败（用户会拿不到 Secret Key）");
  const c = extractSecret("NCB_SECRET_KEY: '" + fakeKey + "'");
  assert.equal(c, fakeKey, "冒号格式解析失败");
  assert.equal(extractSecret("no secret here"), "");
  assert.equal(extractSecret(null), "");
});

// 3.11 SSE 单行 data 响应可解析
await guard("3.11 SSE 响应解析", async () => {
  const c = new NcbMcp({
    apiKey: "k",
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => "event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "execute_sql" }] } }) + "\n\n",
      };
    },
  });
  const tools = await c.listTools();
  assert.deepEqual(tools, ["execute_sql"]);
});

// 3.12 HTTP 500 + HTML 正文：错误必须含状态码，且不得抛 JSON 解析异常
await guard("3.12 500 HTML 响应错误可读", async () => {
  const c = new NcbMcp({
    apiKey: "k",
    fetch: async () => ({ status: 500, ok: false, headers: { get: () => null }, text: async () => "<html><body>bad gateway</body></html>" }),
  });
  let msg = "";
  try {
    await c.getSchema("db1");
  } catch (e) {
    msg = e.message;
  }
  assert.ok(msg.includes("HTTP 500"), "未保留状态码：" + msg);
  assert.ok(!/Unexpected token/.test(msg), "把解析异常泄漏给了调用方：" + msg);
});

// 3.13 fetchAll 分页：hasMore 缺失时按满页推断，且禁止超过 maxPages
await guard("3.13 fetchAll 分页边界", async () => {
  let pages = 0;
  const client = {
    list: async (table, p) => {
      pages = p.page;
      return { data: Array.from({ length: 200 }, (_, i) => ({ id: (p.page - 1) * 200 + i + 1 })) };
    },
  };
  const rows = await fetchAll(client, "memories", {}, 3);
  assert.equal(rows.length, 600, "分页数量错误");
  assert.equal(pages, 3, "maxPages 未被遵守");
  assert.equal(rowsOf({ data: [1] }).length, 1);
  assert.deepEqual(rowsOf(null), []);
});
console.log("\n=== 4. 设置页信标：字段契约 / 幂等 / 卡片隔离 / 快照完整 / 状态序列化 ===");

const STATUS_JS = path.join(os.tmpdir(), `qa_status_${process.pid}.js`);
const STATUS_JSON = STATUS_JS.replace(/\.js$/, ".json");
const REPO_STATUS = [path.resolve("../_status.js"), path.resolve("../_status.json")];

// 清理：绝不把宿主运行态文件留在仓库里（进程退出时统一收尾，必须先于任何 process.exit 注册）
process.on("exit", () => {
  for (const f of REPO_STATUS.concat([STATUS_JS, STATUS_JSON])) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { void e; }
  }
});

function readStatusJson() {
  return JSON.parse(fs.readFileSync(STATUS_JSON, "utf8"));
}

// 4.1 信标字段契约：page 写入的 project 必须被 readAction 透传
await guard("4.1 信标 project 字段不丢失", () => {
  const a = readAction({
    _action: { op: "sync_snapshot", id: "act-1", at: Date.now(), project: "alpha_proj" },
  });
  assert.ok(a, "readAction 返回 null");
  assert.equal(a.project, "alpha_proj", "project 被丢弃 → 快照会静默回落到 global（跨项目混料）");
  assert.equal(a.op, "sync_snapshot");
  assert.equal(a.id, "act-1");
});

// 4.2 非法信标必须拒绝
await guard("4.2 非法信标拒绝", () => {
  assert.equal(readAction(null), null);
  assert.equal(readAction({}), null);
  assert.equal(readAction({ _action: { op: "unknown_op", id: "x" } }), null);
  assert.equal(readAction({ _action: { op: "status" } }), null, "无 id 的信标不得执行（无法幂等）");
  assert.equal(readAction({ _action: "not-an-object" }), null);
});

// 4.3 幂等：同一 id 只执行一次；新 id 可以再执行
await guard("4.3 信标幂等执行", async () => {
  _resetStateCacheForTests();
  const id = "qa-idem-" + Date.now();
  const mockClient = { list: async () => ({ data: [] }), create: async () => ({ id: 1 }), update: async () => ({}), remove: async () => ({}) };
  const first = await runPendingAction({ _action: { op: "status", id, at: Date.now() } }, { client: mockClient });
  assert.equal(first.ran, true, "首次执行未运行：" + JSON.stringify(first));
  const again = await runPendingAction({ _action: { op: "status", id, at: Date.now() } }, { client: mockClient });
  assert.equal(again.ran, false, "同一 id 被重复执行");
  assert.match(String(again.reason), /幂等/);
  const next = await runPendingAction({ _action: { op: "status", id: id + "-b", at: Date.now() } }, { client: mockClient });
  assert.equal(next.ran, true, "新 id 未执行");
  const act = lookupActionState();
  assert.equal(act.lastDoneId, id + "-b", "完成态未落盘");
  assert.ok(act.history.length >= 2, "历史记录缺失");
});

// 4.4 卡片隔离：写一张卡不得冲掉其它卡
await guard("4.4 卡片互不覆盖", () => {
  writeCardStatus("ncb", { ok: true, title: "MCP Key 有效", lines: ["行1", "行2"] }, "ncb_check", STATUS_JS);
  writeCardStatus("r2", { ok: true, title: "R2 就绪", lines: ["行1", "行2"] }, "r2_check", STATUS_JS);
  let st = readStatusJson();
  assert.ok(st.ncb && st.r2, "写 r2 把 ncb 卡冲掉了");
  assert.equal(st.ncb.title, "MCP Key 有效");
  writeCardStatus("gateway", { ok: false, title: "扫描失败", lines: ["原因", "建议"] }, "harvest_gateway", STATUS_JS);
  st = readStatusJson();
  assert.ok(st.ncb && st.r2 && st.gateway, "写 gateway 破坏了其它卡片");
  assert.equal(st.gateway.ok, false);
});

// 4.5 快照完整保留：inject 卡必须同时带 memories 与 detail.collab
await guard("4.5 inject 卡保留 memories 与协作快照", () => {
  const memories = [{ id: 1, title: "a" }, { id: 2, title: "b" }];
  const collab = { handoff: { open: true }, mailbox: { unread: 2 }, health: { active: 2 } };
  writeCardStatus(
    "inject",
    { ok: true, at: Date.now(), op: "sync_snapshot", title: "记忆快照拉取就绪", lines: ["成功拉取 2 条"], memories, detail: { collab } },
    "sync_snapshot",
    STATUS_JS
  );
  const st = readStatusJson();
  assert.equal(st.inject.memories.length, 2, "快照本体被丢弃（前端会拿空数组覆盖）");
  assert.deepEqual(st.inject.detail.collab, collab, "协作快照被丢弃（协作三区块会被冲成空态）");
  assert.ok(st.ncb && st.r2, "inject 写入破坏了其它卡片");
});

// 4.6 卡片 key 白名单：非法 key 必须拒绝且不写坏文件
await guard("4.6 非法卡片 key 拒绝写入", () => {
  const before = fs.readFileSync(STATUS_JSON, "utf8");
  const ok = writeCardStatus("evil", { ok: true }, "x", STATUS_JS);
  assert.equal(ok, false);
  assert.equal(fs.readFileSync(STATUS_JSON, "utf8"), before, "非法写入改动了状态文件");
});

// 4.7 状态序列化：紧凑 JSON、.bak 备份、无 .tmp 残留、_ok:false 拒写
await guard("4.7 状态文件原子写与防抹平", () => {
  _resetStateCacheForTests();
  const p = statePath();
  assert.ok(p, "statePath 为空");
  const st = readState();
  assert.equal(st._ok, true);
  st.secrets = st.secrets || {};
  assert.equal(writeState(st), true, "首次写入失败");
  // 第二次写才有「上一版」可备份，备份缺失意味着崩溃后无法自愈
  assert.equal(writeState(readState()), true, "第二次写入失败");
  const raw = fs.readFileSync(p, "utf8");
  assert.ok(!raw.includes("\n  "), "状态文件不是紧凑序列化（体积会膨胀）");
  assert.ok(fs.existsSync(p + ".bak"), "备份文件缺失（崩溃后无法自愈）");
  const leftovers = fs.readdirSync(path.dirname(p)).filter((f) => f.includes(".tmp."));
  assert.equal(leftovers.length, 0, "残留临时文件：" + leftovers.join(","));
  assert.equal(writeState({ _ok: false }), false, "损坏状态竟然被写盘（会抹平用户配置）");
});

// 4.8 并发写 secret：20 条连续写入后必须全部可读回
await guard("4.8 连续 secret 写入不丢条目", () => {
  _resetStateCacheForTests();
  const st = readState();
  st.secrets = {};
  writeState(st);
  for (let i = 0; i < 20; i++) {
    assert.equal(rememberSecret("db_" + i, "v" + i), true, "第 " + i + " 条写入失败");
  }
  for (let i = 0; i < 20; i++) {
    assert.equal(lookupSecret("db_" + i), "v" + i, "第 " + i + " 条读不回（写入被覆盖）");
  }
  rememberActionState({ lastDoneId: "x1", pendingId: "", history: [] });
  assert.equal(lookupSecret("db_7"), "v7", "写动作状态把 secrets 抹掉了");
});

// 4.9 状态文件损坏：必须 fail-closed 拒绝清库信标，且保留损坏备份
await guard("4.9 状态损坏时清库信标 fail-closed", async () => {
  _resetStateCacheForTests();
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try { fs.unlinkSync(p + ".bak"); } catch (e) { void e; } // 无备份可恢复，才是真正的「不可信」
  fs.writeFileSync(p, "{ this is not json", "utf8");
  _resetStateCacheForTests();
  const st = readState();
  assert.equal(st._ok, false, "损坏状态未标记为不可信");
  const corrupts = fs.readdirSync(path.dirname(p)).filter((f) => f.includes(".corrupt."));
  assert.ok(corrupts.length >= 1, "损坏内容未备份（用户无法取证）");
  const res = await runPendingAction({ _action: { op: "reset", id: "reset-" + Date.now(), at: Date.now(), confirm: "RESET" } }, { client: { list: async () => ({ data: [] }) } });
  assert.equal(res.ran, false, "状态损坏时清库信标竟被执行（可能重复清库）");
  assert.equal(res.ok, false, "未返回 ok:false");
  assert.match(String(res.reason), /损坏|无法确认/);
});

// 4.10 清库信标时间戳：伪造的 0 / 未来 / 过期都必须拒绝
await guard("4.10 清库信标时间戳校验", async () => {
  _resetStateCacheForTests();
  const p = statePath();
  try { fs.unlinkSync(p); } catch (e) { void e; }
  try { fs.unlinkSync(p + ".bak"); } catch (e) { void e; }
  _resetStateCacheForTests();
  for (const at of [0, -1, Date.now() + 86400000, Date.now() - 10 * 60 * 1000]) {
    const res = await runPendingAction({ _action: { op: "reset", id: "r-" + at + "-" + Math.random(), at, confirm: "RESET" } }, { client: { list: async () => ({ data: [] }) } });
    assert.equal(res.ran, false, `时间戳 ${at} 未被拒绝`);
    assert.equal(res.ok, false, `时间戳 ${at} 未返回 ok:false`);
  }
});

// 4.11 正常时间戳的首次清库仍必须放行（防止「一律拒绝」的死循环）
await guard("4.11 新鲜清库信标不被误杀", async () => {
  _resetStateCacheForTests();
  const p = statePath();
  try { fs.unlinkSync(p); } catch (e) { void e; }
  try { fs.unlinkSync(p + ".bak"); } catch (e) { void e; }
  _resetStateCacheForTests();
  const res = await runPendingAction(
    { _action: { op: "reset", id: "fresh-" + Date.now(), at: Date.now(), confirm: "RESET" } },
    { client: { list: async () => ({ data: [] }) }, options: {} }
  );
  assert.equal(res.ran, true, "新鲜信标被拒绝执行：" + JSON.stringify(res.reason));
  assert.ok(!/已失效|损坏|分钟/.test(String(res.reason || "")), "新鲜信标被误判为陈旧：" + res.reason);
});

// 4.12 formatCardStatus 快路径不得丢字段
await guard("4.12 卡片快路径保留 detail/progress/memories", () => {
  const card = formatCardStatus("inject", {
    ok: true,
    op: "sync_snapshot",
    title: "完成",
    lines: ["a", "b"],
    progress: { status: "done", percent: 100 },
    memories: [{ id: 1 }],
    detail: { collab: { x: 1 } },
  }, "sync_snapshot");
  assert.equal(card.lines.length, 2);
  assert.deepEqual(card.progress, { status: "done", percent: 100 });
  assert.deepEqual(card.memories, [{ id: 1 }]);
  assert.deepEqual(card.detail, { collab: { x: 1 } });
});

// 4.13 请求注入：未命中记忆且用户关闭内联提炼时，请求体字节不变
await guard("4.13 无命中时请求体字节不变", () => {
  const body = { model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: "完全无关的闲聊内容" }] };
  const before = JSON.stringify(body);
  onRequest(body, { options: { inline_extract: false, memories: [{ id: 1, title: "数据库端口", content: "lsof", category: "fact" }], project: "p" }, state: {} });
  assert.equal(JSON.stringify(body), before, "无命中却改写了请求体（缓存失效）");
});

// 4.14 请求注入：命中时只改最后一条 user，绝不碰 system 与历史
await guard("4.14 注入只落在最后一条用户消息", () => {
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "历史问题" },
      { role: "assistant", content: "历史回答" },
      { role: "user", content: "数据库端口冲突怎么排查" },
    ],
  };
  onRequest(body, {
    options: { inline_extract: false, memories: [{ id: 1, project: "p", category: "fact", title: "数据库端口冲突", content: "lsof -i:3425", tags: "端口,冲突" }], project: "p" },
    state: {},
  });
  assert.equal(body.messages[0].content, "SYS");
  assert.equal(body.messages[1].content, "历史问题");
  assert.equal(body.messages[2].content, "历史回答");
  assert.ok(body.messages[3].content.includes("数据库端口冲突"), "命中却未注入");
  assert.ok(body.messages[3].content.length > "数据库端口冲突怎么排查".length);
});

console.log("\n=================================================");
if (failures.length === 0) {
  console.log(`✅ QA 对抗测试全部通过：${passed} 项`);
  process.exit(0);
} else {
  console.error(`❌ QA 对抗测试失败 ${failures.length} 项（通过 ${passed} 项）：`);
  for (const f of failures) console.error("   - " + f);
  process.exit(1);
}
