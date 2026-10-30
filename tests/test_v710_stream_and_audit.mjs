/**
 * test_v710_stream_and_audit.mjs
 * v7.1.0 流式幻觉遥测 + 存量 env_scope 审计启发式的对抗回归。
 *
 * 背景：v7.0.x 的遥测只挂在 onResponse，走 SSE 的客户端根本不触发，
 * 统计一直是空的——不是报错，是静默无数据。本套件锁住流式路径。
 *
 * 纯离线：零网络、零真实数据库。
 */
import assert from "node:assert";
import { onRequest, onEvent } from "../memory.middleware.js";
import {
  extractToolCalls,
  accumulateToolCalls,
  flushToolCallPartials,
  MAX_NAMES,
} from "../src/domain/tool-calls.js";
import { buildCapsTelemetry, finalizeFromStream, detectCapabilities } from "../src/middleware/capability.js";
import { suggestEnvScope } from "../src/domain/env-hints.js";

let pass = 0;
const fail = [];
function check(name, fn) {
  try { fn(); pass++; console.log("  OK   " + name); }
  catch (e) { fail.push(name + " :: " + (e && e.message)); console.log("  FAIL " + name + " :: " + (e && e.message)); }
}
const NL = String.fromCharCode(10);

function tools(names) {
  return names.map((n) => ({ type: "function", function: { name: n } }));
}

/* ================= 1. 提取器 ================= */
console.log(NL + "▶ [1] 四协议 tool_call 提取（含流式形态）");

check("chat 非流式 message", () => {
  const r = extractToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "a" } }] } }] });
  assert.deepStrictEqual(r.map((x) => x.name), ["a"]);
  assert.strictEqual(r[0].complete, true);
});

check("chat 流式 delta 标记为碎片", () => {
  const r = extractToolCalls({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "memory_" } }] } }] });
  assert.deepStrictEqual(r.map((x) => x.name), ["memory_"]);
  assert.strictEqual(r[0].complete, false);
  assert.strictEqual(r[0].index, 0);
});

check("Anthropic content_block_start", () => {
  const r = extractToolCalls({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "b" } });
  assert.deepStrictEqual(r.map((x) => x.name), ["b"]);
  assert.strictEqual(r[0].complete, true);
});

check("responses output_item.added", () => {
  const r = extractToolCalls({ type: "response.output_item.added", item: { type: "function_call", name: "c" } });
  assert.deepStrictEqual(r.map((x) => x.name), ["c"]);
});

check("Gemini functionCall", () => {
  const r = extractToolCalls({ candidates: [{ content: { parts: [{ functionCall: { name: "d" } }] } }] });
  assert.deepStrictEqual(r.map((x) => x.name), ["d"]);
});

/* ================= 2. 流式累加 ================= */
console.log(NL + "▶ [2] 碎片累加与收口");

check("同名碎片按 index 拼接成一个完整名", () => {
  const st = {};
  accumulateToolCalls({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "magpie-memory-hub_" } }] } }] }, st);
  accumulateToolCalls({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "memory_context" } }] } }] }, st);
  assert.deepStrictEqual(st._toolCallNames, [], "碎片阶段不得入表");
  flushToolCallPartials(st);
  assert.deepStrictEqual(st._toolCallNames, ["magpie-memory-hub_memory_context"]);
});

check("多个 index 各自独立拼接（反证：不得串在一起）", () => {
  const st = {};
  accumulateToolCalls({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "aa_" } }] } }] }, st);
  accumulateToolCalls({ choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "bb_" } }] } }] }, st);
  accumulateToolCalls({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "x" } }] } }] }, st);
  accumulateToolCalls({ choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "y" } }] } }] }, st);
  flushToolCallPartials(st);
  assert.deepStrictEqual(st._toolCallNames.sort(), ["aa_x", "bb_y"]);
});

check("累加有上限，不会无界膨胀", () => {
  const st = {};
  for (let i = 0; i < MAX_NAMES + 10; i++) {
    accumulateToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "t" + i } }] } }] }, st);
  }
  assert.strictEqual(st._toolCallNames.length, MAX_NAMES);
});

/* ================= 3. 遥测收口 ================= */
console.log(NL + "▶ [3] 遥测收口");

check("流式累加的名 → 判定为幻觉（无工具客户端）", () => {
  const caps = detectCapabilities({ tools: tools(["read_file"]) });
  const st = { caps: caps, guideInjected: true, guideTier: 1, envAgent: "ishellpro" };
  st._toolCallNames = ["magpie-memory-hub_memory_context"];
  const t = finalizeFromStream(st);
  assert.ok(t, "必须产出遥测");
  assert.strictEqual(t.hallucinatedCount, 1);
  assert.strictEqual(t.hallucinated[0].kind, "unadvertised");
  assert.strictEqual(t.agent, "ishellpro");
  assert.strictEqual(st.capsTelemetry, t, "必须回写 ctx.state");
});

check("无工具、无引导、无调用 → 不产生任何遥测", () => {
  const st = { caps: detectCapabilities({ messages: [] }) };
  assert.strictEqual(finalizeFromStream(st), null);
});

check("重复收口幂等（不得覆盖已有遥测）", () => {
  const caps = detectCapabilities({ tools: tools(["read_file"]) });
  const st = { caps: caps, guideInjected: true };
  st._toolCallNames = ["x_memory_save"];
  const a = finalizeFromStream(st);
  const b = finalizeFromStream(st);
  assert.strictEqual(a, b);
});

/* ================= 4. 真实 onEvent 链路 ================= */
console.log(NL + "▶ [4] onEvent 真实链路");

check("流式事件被 onEvent 累加，且不改变事件本身", () => {
  const body = {
    model: "gpt-4o", stream: true,
    messages: [{ role: "user", content: "项目遇到报错" }],
    tools: tools(["read_file"]),
  };
  const ctx = { protocol: "chat", options: {}, state: {} };
  onRequest(body, ctx);
  const e1 = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "magpie-memory-hub_" } }] } }] };
  const snapshot = JSON.stringify(e1);
  onEvent(e1, ctx);
  onEvent({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "memory_context" } }] } }] }, ctx);
  onEvent({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }, ctx);
  assert.strictEqual(JSON.stringify(e1), snapshot, "onEvent 不得改写事件内容");
  const t = finalizeFromStream(ctx.state);
  assert.ok(t && t.hallucinatedCount === 1, "必须抓到幻觉：" + JSON.stringify(ctx.state._toolCallNames));
});

check("caps_telemetry=false 时完全不累加（零开销开关）", () => {
  const body = {
    model: "gpt-4o", stream: true,
    messages: [{ role: "user", content: "项目遇到报错" }],
    tools: tools(["read_file"]),
  };
  const ctx = { protocol: "chat", options: { caps_telemetry: false }, state: {} };
  onRequest(body, ctx);
  onEvent({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "x_memory_save" } }] } }] }, ctx);
  assert.strictEqual(ctx.state._toolCallNames, undefined, "开关关闭时不应建立缓冲区");
});

/* ================= 5. 存量审计启发式 ================= */
console.log(NL + "▶ [5] env-hints 启发式");

check("单一平台信号直接给出建议", () => {
  assert.strictEqual(suggestEnvScope("Windows 上用 PowerShell 改注册表").scope, "os=windows");
  assert.strictEqual(suggestEnvScope("systemctl restart docker 即可").scope, "os=linux");
  assert.strictEqual(suggestEnvScope("brew install jq").scope, "os=macos");
  assert.strictEqual(suggestEnvScope("arm64 上要重建索引").scope, "arch=arm64");
});

check("同时提到多平台 → 判定为对比描述，不给建议（反证）", () => {
  const r = suggestEnvScope("Windows 和 Linux 都要改这个配置");
  assert.strictEqual(r.scope, "");
  assert.strictEqual(r.ambiguous, true);
});

check("无环境信号 → 空建议，绝不瞎标", () => {
  const r = suggestEnvScope("这个项目的日志统一用 JSON 格式");
  assert.strictEqual(r.scope, "");
  assert.strictEqual(r.ambiguous, false);
});

check("os 与 arch 可同时命中", () => {
  assert.strictEqual(suggestEnvScope("alpine 的 arm64 镜像里 apk add git").scope, "os=linux,arch=arm64");
});

console.log(NL + "=================================================================");
if (fail.length) {
  console.error("❌ 失败 " + fail.length + " 项 / 通过 " + pass + " 项");
  for (const f of fail) console.error("   - " + f);
  process.exit(1);
}
console.log("✅ v7.1.0 流式遥测与存量审计启发式 对抗回归全部通过（" + pass + " 项）");
console.log("=================================================================");
