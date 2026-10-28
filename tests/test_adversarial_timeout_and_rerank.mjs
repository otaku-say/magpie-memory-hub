import assert from "node:assert/strict";
/* 对抗测试 A：配置链路连通性 + 超时边界矩阵 + 候选上限 + fail-open + cleanQuery */
import { readOptions } from "../src/core/config.js";
import { rerankSearchResultsWithModel, rewriteSearchQuery } from "../src/integration/provider-models.js";
import { harvestWithOnlineModel } from "../src/services/harvest/extract.js";

const fail = [];
const rec = (name, ok, detail) => { console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " :: " + detail : ""}`); if (!ok) fail.push(name + " :: " + detail); };

/* ---------- 1. readOptions 白名单是否放行新字段 ---------- */
const rawOpts = { ncb_instance: "db", audit_model: "m", extract_model: "m", harvest_max_per_min: 99999, harvest_max_total: 99999,
  model_timeout_sec: 45, rerank_timeout_sec: 20, rerank_max_candidates: 6 };
const cfg = readOptions(rawOpts);
console.log("\n=== 1. readOptions 生产配置归一化 ===");
console.log("raw  :", JSON.stringify({ model_timeout_sec: 45, rerank_timeout_sec: 20, rerank_max_candidates: 6 }));
console.log("cfg  :", JSON.stringify({ model_timeout_sec: cfg.model_timeout_sec, rerank_timeout_sec: cfg.rerank_timeout_sec, rerank_max_candidates: cfg.rerank_max_candidates }));
const plumbed = cfg.model_timeout_sec === 45 && cfg.rerank_timeout_sec === 20 && cfg.rerank_max_candidates === 6;
rec("readOptions 透传三个新配置字段", plumbed, plumbed ? "" : "全部丢失（undefined）→ 生产链路读不到用户设置");

/* ---------- 工具：拦截 setTimeout 记录 delay ---------- */
const origST = globalThis.setTimeout;
let delays = [];
globalThis.setTimeout = (fn, ms, ...a) => { delays.push(ms); return origST(fn, 0, ...a); }; // 立即触发，加速
const origClear = globalThis.clearTimeout;
const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ranked":[]}' } }] }) });
const cands = [{ id: 1, title: "a" }, { id: 2, title: "b" }, { id: 3, title: "t" }];

async function measure(fn) {
  delays = [];
  try { await fn(); } catch (e) { return { err: e && e.message }; }
  return { delay: delays[0] };
}

/* ---------- 2. 超时边界矩阵（消费端直接传入） ---------- */
console.log("\n=== 2. model_timeout_sec 边界矩阵（rerank 消费端） ===");
const cases = [
  ["未设置", undefined], ["0", 0], ["负数 -30", -30], ["NaN", NaN], ["空串 ''", ""],
  ["非法串 'abc'", "abc"], ["小数 0.5", 0.5], ["极小 0.001", 0.001],
  ["极大 1e9", 1e9], ["Infinity", Infinity], ["布尔 true", true], ["数组 [5]", [5]],
  ["字符串 '45'", "45"], ["null", null]
];
for (const [label, v] of cases) {
  const r = await measure(() => rerankSearchResultsWithModel({
    query: "q", candidates: cands, maxTop: 2,
    options: { audit_model: "m", model_timeout_sec: v, harvest_max_per_min: 99999, harvest_max_total: 99999, _fetch: okFetch },
  }));
  const d = r.err ? "抛错:" + r.err : r.delay;
  const safe = !r.err && typeof r.delay === "number" && r.delay > 0;
  rec(`model_timeout_sec=${label} → setTimeout(${d}ms)`, safe, safe ? "" : "非正数/溢出：setTimeout 会被 Node 夹到 1ms → 全部模型调用瞬时 abort");
}

/* ---------- 3. rerank_max_candidates 边界 ---------- */
console.log("\n=== 3. rerank_max_candidates 边界矩阵 ===");
for (const [label, v] of [["0", 0], ["-5", -5], ["NaN", NaN], ["'abc'", "abc"], ["1", 1], ["2", 2], ["25", 25], ["26", 26], ["1e9", 1e9], ["10.9", 10.9], ["true", true], ["''", ""]]) {
  let n = -1;
  const f = async (u, init) => {
    const body = JSON.parse(init.body);
    const m = body.messages.find((x) => x.role === "user").content.match(/共 (\d+) 条/);
    n = Number(m[1]);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ranked":[{"id":1,"score":9}]}' } }] }) };
  };
  const pool = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, title: "t" + i }));
  let err = null;
  try {
    await rerankSearchResultsWithModel({ query: "q", candidates: pool, maxTop: 3, options: { audit_model: "m", rerank_max_candidates: v, harvest_max_per_min: 99999, harvest_max_total: 99999, _fetch: f } });
  } catch (e) { err = e.message; }
  rec(`rerank_max_candidates=${label} → 送入 ${n} 条`, !err && n >= 3 && n <= 25 && n <= 40, err || (n >= 3 && n <= 25 ? "" : "越界"));
}

/* ---------- 4. fail-open 反证 ---------- */
console.log("\n=== 4. 异常渗透 / fail-open ===");
const badFetchList = {
  "499 状态": async () => ({ ok: false, status: 499, json: async () => ({ error: "timeout" }) }),
  "500 非 JSON": async () => ({ ok: true, status: 500, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
  "HTML 正文": async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("<html>"); } }),
  "空 choices": async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }),
  "content 非 JSON": async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "抱歉我无法回答" } }] }) }),
  "同步抛错": () => { throw new Error("boom"); },
  "返回 undefined": async () => undefined,
  "AbortError": async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
};
for (const [k, f] of Object.entries(badFetchList)) {
  let r, e2 = null;
  try { r = await rerankSearchResultsWithModel({ query: "q", candidates: cands, maxTop: 2, options: { audit_model: "m", _fetch: f } }); }
  catch (e) { e2 = e.message; }
  rec(`rerank / ${k} → ${e2 ? "抛出 " + e2 : JSON.stringify(r)}`, !e2 && r === null, e2 ? "异常逃逸，未 fail-open" : "");

  let r2, e3 = null;
  try { r2 = await rewriteSearchQuery({ query: "q", options: { extract_model: "m", _fetch: f } }); }
  catch (e) { e3 = e.message; }
  rec(`rewrite / ${k} → ${e3 ? "抛出 " + e3 : JSON.stringify(r2)}`, !e3 && (r2 === null || typeof r2 === "object"), e3 ? "异常逃逸" : "");

  let r3, e4 = null;
  try { r3 = await harvestWithOnlineModel("用户: hi\n助手: ok", { extract_model: "m", _fetch: f }); }
  catch (e) { e4 = e.message; }
  rec(`harvest / ${k} → ${e4 ? "抛出 " + e4 : JSON.stringify(r3)}`, !e4 && (r3 === null || typeof r3 === "object"), e4 ? "异常逃逸" : "");
}

/* ---------- 5. 真实生产链路：readOptions 后的实际超时 ---------- */
console.log("\n=== 5. 生产链路实测（options = readOptions(...)） ===");
// 5.1 优先取专用的 rerank_timeout_sec (20s)
const prod = readOptions({ ...rawOpts });
const r5 = await measure(() => rerankSearchResultsWithModel({ query: "q", candidates: cands, maxTop: 2, options: { ...prod, _fetch: okFetch } }));
rec(`同时设置时 rerank 优先采信 rerank_timeout_sec: ${r5.delay}ms`, r5.delay === 20000, "专用超时优先级错误");

// 5.2 仅设置全局 model_timeout_sec (45s) 时回退
const prodFallback = readOptions({ ncb_instance: "db", audit_model: "m", model_timeout_sec: 45, harvest_max_per_min: 99999, harvest_max_total: 99999 });
const r5Fallback = await measure(() => rerankSearchResultsWithModel({ query: "q", candidates: cands, maxTop: 2, options: { ...prodFallback, _fetch: okFetch } }));
rec(`仅设全局 model_timeout_sec=45 时 rerank 正确回退: ${r5Fallback.delay}ms`, r5Fallback.delay === 45000, "全局回退失败");

/* ---------- 6. cleanQuery 回归 ---------- */
const { cleanQuery } = await import("../src/integration/provider-models.js");
console.log("\n=== 6. cleanQuery 附加改动回归 ===");
const q1 = "排障清单：\n- 先查避坑：检查 499 超时\n- 修复必存：保存经验";
console.log("输入:", JSON.stringify(q1), "\n输出:", JSON.stringify(cleanQuery(q1)));
rec("含项目符号的合法查询不被吞掉", cleanQuery(q1).includes("499"), "查询行被整行删除（数据丢失）");
const q2 = "【用户查询】：\n499 error";
rec("【用户查询】换行形式仍能抽取", cleanQuery(q2).trim() === "499 error", JSON.stringify(cleanQuery(q2)));

globalThis.setTimeout = origST; globalThis.clearTimeout = origClear;
console.log(`\n=== A 组结果：${fail.length === 0 ? "全部通过" : fail.length + " 项失败"} ===`);
for (const f of fail) console.log("  - " + f);

assert.strictEqual(fail.length, 0, "对抗测试所有项目必须全部绿灯通过");
assert.ok(plumbed, "readOptions 生产配置必须完整透传三个新字段");
