/**
 * test_v700_capability_gate.mjs
 * v7.0.0 能力门控、环境作用域与幻觉检测的全量对抗回归。
 *
 * 锁住四条不变量：
 *   ① 无工具环境绝不出现任何工具名（档 0 静默）；
 *   ② 有工具但非本插件时绝不写死默认名（档 1 能力未确认）；
 *   ③ 环境作用域不匹配的记忆绝不进注入（空作用域仍通用）；
 *   ④ 模型调未通告工具时必须在响应层被确定性识别（不靠采样猜）。
 *
 * 纯离线：零网络、零真实数据库、零文件系统副作用。
 */
import assert from "node:assert";
import { onRequest } from "../memory.middleware.js";
import { onResponse } from "../memory.middleware.js";
import {
  detectCapabilities,
  advertisedToolNames,
  isDispatcherName,
  isListerName,
  suffixHits,
  resolveToolCall,
  parseScope,
  matchEnvScope,
  envScopeOf,
  isToolForbidden,
  globToRegExp,
} from "../src/middleware/capability.js";
import { buildAgentGuide, buildContextBlock } from "../src/middleware/inject-builder.js";
import { collectToolCalls } from "../src/middleware/response-hook.js";

let pass = 0;
const fail = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  OK   " + name);
  } catch (e) {
    fail.push(name + " :: " + (e && e.message));
    console.log("  FAIL " + name + " :: " + (e && e.message));
  }
}

const NL = String.fromCharCode(10);
const LEGACY = ["magpie-memory-hub", "memory", "context"].join("_");

function toolsOpenAI(names) {
  return names.map((n) => ({ type: "function", function: { name: n } }));
}

/* ================= 1. 协议兼容 ================= */
console.log(NL + "▶ [1] 五种协议的工具清单提取");

check("OpenAI chat（function.name）", () => {
  assert.deepStrictEqual(advertisedToolNames({ tools: toolsOpenAI(["mcp__magpie__memory_context"]) }), ["mcp__magpie__memory_context"]);
});
check("OpenAI responses（扁平 name）", () => {
  assert.deepStrictEqual(advertisedToolNames({ tools: [{ type: "function", name: "memory_save" }] }), ["memory_save"]);
});
check("Anthropic（name + input_schema）", () => {
  assert.deepStrictEqual(advertisedToolNames({ tools: [{ name: "pitfall_search", input_schema: {} }] }), ["pitfall_search"]);
});
check("Gemini functionDeclarations", () => {
  assert.deepStrictEqual(advertisedToolNames({ tools: [{ functionDeclarations: [{ name: "memory_context" }] }] }), ["memory_context"]);
});
check("老式 functions", () => {
  assert.deepStrictEqual(advertisedToolNames({ functions: [{ name: "memory_search" }] }), ["memory_search"]);
});

/* ================= 2. 后缀边界 ================= */
console.log(NL + "▶ [2] 工具名后缀匹配边界");

check("包装前缀命中", () => {
  assert.strictEqual(suffixHits("mcp__magpie__memory_context", "memory_context"), true);
  assert.strictEqual(suffixHits("custom_memory-mcp_x-memory_save", "memory_save"), true);
});
check("非边界后缀不命中（反证）", () => {
  assert.strictEqual(suffixHits("my_memory_contextual", "memory_context"), false);
  assert.strictEqual(suffixHits("memory_context2", "memory_context"), false);
});
check("detectCapabilities 统计读写能力", () => {
  const caps = detectCapabilities({ tools: toolsOpenAI(["mcp__magpie__memory_context"]) });
  assert.strictEqual(caps.hasTools, true);
  assert.strictEqual(caps.readOk, true);
  assert.strictEqual(caps.writeOk, false);
  assert.strictEqual(caps.present, true);
});

/* ================= 3. 幻觉归类 ================= */
console.log(NL + "▶ [3] resolveToolCall 幻觉归类");

check("逐字命中 / 别名 / 未通告 / 全无工具", () => {
  const caps = detectCapabilities({ tools: toolsOpenAI(["mcp__magpie__memory_context"]) });
  assert.strictEqual(resolveToolCall("mcp__magpie__memory_context", caps).kind, "advertised");
  assert.strictEqual(resolveToolCall("memory_context", caps).kind, "unadvertised");
  assert.strictEqual(resolveToolCall("memory_context", caps).logical, "memory_context");
  assert.strictEqual(resolveToolCall("read_file", caps).kind, "other");
  const none = detectCapabilities({ messages: [] });
  assert.strictEqual(resolveToolCall("memory_context", none).kind, "unavailable");
});

/* ================= 4. 档 0 ================= */
console.log(NL + "▶ [4] 档 0 —— 无工具环境静默");

check("无 tools 时 buildAgentGuide 返回空串", () => {
  const g = buildAgentGuide("项目遇到报错: ECONNREFUSED", { inline_extract: true }, { messages: [] }, { state: { turnNo: 2 } });
  assert.strictEqual(g, "");
});
check("guide_on_no_tools=true 仅陈述式提示，不含任何工具名", () => {
  const g = buildAgentGuide("项目遇到报错", { inline_extract: true, guide_on_no_tools: true }, { messages: [] }, { state: { turnNo: 2 } });
  assert.ok(g.includes("无工具环境"));
  assert.ok(!g.includes(LEGACY));
  assert.ok(!/`[a-z_]*_(?:memory|pitfall)_[a-z_]+`/.test(g));
  assert.ok(/禁止声称/.test(g));
});
check("cli_channel 配置后给命令，仍不给 MCP 工具名", () => {
  const g = buildAgentGuide("项目遇到报错", {
    inline_extract: true, guide_on_no_tools: true, cli_channel: "node /x/memory-cli.js",
  }, { messages: [] }, { state: { turnNo: 2 } });
  assert.ok(g.includes("memory-cli.js"), "必须给出 CLI 通道");
  assert.ok(!g.includes(LEGACY), "不得回退到头硬编码工具名");
});

/* ================= 5. 档 1 / 档 2 ================= */
console.log(NL + "▶ [5] 档 1 能力未确认 / 档 2 使用真实名");

check("有无关工具时不得写死默认名", () => {
  /* 不能用 run_code：它属于元工具分发器，会（正确地）降到档 1.5。
   * 档 1 的前提是“有工具、没分发器、也没有本插件工具”。 */
  const body = { messages: [], tools: toolsOpenAI(["read_file", "write_file"]) };
  const g = buildAgentGuide("项目遇到报错", { inline_extract: true }, body, { state: { turnNo: 2 } });
  assert.ok(g.includes("能力未确认"));
  assert.ok(!g.includes(LEGACY));
  assert.ok(!g.includes("pitfall_save"));
});
check("使用带包装前缀的真实工具名", () => {
  const names = ["mcp__magpie__memory_context", "mcp__magpie__memory_search",
    "mcp__magpie__pitfall_search", "mcp__magpie__memory_save", "mcp__magpie__pitfall_save"];
  const g = buildAgentGuide("项目遇到报错", { inline_extract: true }, { messages: [], tools: toolsOpenAI(names) }, { state: { turnNo: 2 } });
  assert.ok(g.includes("mcp__magpie__pitfall_search"));
  assert.ok(g.includes("mcp__magpie__pitfall_save"));
  assert.ok(!g.includes(LEGACY));
  assert.ok(g.includes("保存必须是真的"));
  assert.ok(g.includes("禁止换名重试"));
});
check("只有写入工具时不得凭空给出检索工具", () => {
  const g = buildAgentGuide("请记住这条规范", { inline_extract: true },
    { messages: [], tools: toolsOpenAI(["x_memory_save"]) }, { state: { turnNo: 2 } });
  assert.ok(g.includes("x_memory_save"));
  assert.ok(!/memory_context|memory_search|pitfall_search/.test(g));
});
check("capability_gate=off 退回旧行为（含默认工具名）", () => {
  const g = buildAgentGuide("项目遇到报错", { inline_extract: true, capability_gate: "off" }, { messages: [] }, { state: { turnNo: 2 } });
  assert.ok(g.includes(LEGACY));
});

/* ================= 6. 环境作用域 ================= */
console.log(NL + "▶ [6] 环境作用域解析与匹配");

check("空作用域恒为通用", () => {
  assert.strictEqual(matchEnvScope("", { os: "linux" }), true);
  assert.strictEqual(matchEnvScope(null, { os: "linux" }), true);
});
check("os 不匹配则排除（反证）", () => {
  assert.strictEqual(matchEnvScope("os=windows", { os: "linux", arch: "arm64" }), false);
  assert.strictEqual(matchEnvScope("os=windows", { os: "windows" }), true);
});
check("作用域维度未知时默认不召回（真机测试挖出来的洞）", () => {
  /* v7.0.0 修正：早期实现这里 return true（fail-open），结果没有 os 画像的
   * ishellpro 依然收到「Windows 上要用 X」准则。带作用域就必须正向确认。 */
  assert.strictEqual(matchEnvScope("os=windows,arch=amd64", { os: "windows" }), false);
  assert.strictEqual(matchEnvScope("os=windows", {}), false);
  assert.strictEqual(matchEnvScope("os=windows", null), false);
});
check("显式 requireKnown:false 才放宽为 fail-open", () => {
  assert.strictEqual(matchEnvScope("os=windows,arch=amd64", { os: "windows" }, { requireKnown: false }), true);
  assert.strictEqual(matchEnvScope("os=windows", null, { requireKnown: false }), true);
});
check("无作用域记忆不受严格模式影响", () => {
  assert.strictEqual(matchEnvScope("", {}), true);
  assert.strictEqual(matchEnvScope("", null), true);
});
check("同键多值用 | 分隔", () => {
  assert.strictEqual(matchEnvScope("agent=ishellpro|openminis", { agent: "openminis" }), true);
  assert.strictEqual(matchEnvScope("agent=ishellpro|openminis", { agent: "cindy" }), false);
});
check("env: 保留标签可解析为作用域", () => {
  assert.strictEqual(envScopeOf({ related_entities: "docker,env:os=windows,env:arch=amd64" }), "arch=amd64,os=windows");
  assert.strictEqual(envScopeOf({ related_entities: "docker" }), "");
  assert.strictEqual(envScopeOf({ env_scope: "os=linux", related_entities: "env:os=windows" }), "os=linux");
});
check("parseScope 同时接受 = 与 :", () => {
  assert.deepStrictEqual(parseScope("os=windows, arch:amd64"), { os: "windows", arch: "amd64" });
});

/* ================= 7. 禁用 glob ================= */
console.log(NL + "▶ [7] 客户端画像禁用工具");

check("glob 整串锚定", () => {
  assert.strictEqual(isToolForbidden("cindy_helper", ["cindy_*"]), true);
  assert.strictEqual(isToolForbidden("x_cindy_helper", ["cindy_*"]), false);
  assert.strictEqual(isToolForbidden("x_cindy_helper", ["*cindy_*"]), true);
  assert.strictEqual(isToolForbidden("mcp__magpie__memory_save", ["*_memory_*"]), true);
  assert.strictEqual(isToolForbidden("whatever", []), false);
});
check("glob 特殊字符不当作正则（反证）", () => {
  assert.strictEqual(globToRegExp("a.b").test("axb"), false);
  assert.strictEqual(globToRegExp("a.b").test("a.b"), true);
});
check("画像禁用后工具名从注入里消失", () => {
  const body = { messages: [], tools: toolsOpenAI(["memory_context", "memory_search", "pitfall_search", "memory_save", "pitfall_save"]) };
  const caps = detectCapabilities(body);
  caps.forbidTools = ["memory_*", "pitfall_*"];
  const g = buildAgentGuide("项目遇到报错", { inline_extract: true }, body, { state: { turnNo: 2, caps } });
  assert.ok(g.includes("能力未确认"));
  assert.ok(!g.includes("memory_context"));
});

/* ================= 8. 端到端召回 + KV-Cache ================= */
console.log(NL + "▶ [8] 端到端召回过滤与 KV-Cache 不变量");

check("Windows 专属记忆不得注入 arm64 会话，通用记忆仍注入", () => {
  const snapshot = [
    { id: 1, project: "p1", category: "principle", lifecycle_status: "active",
      title: "Windows 宿主机改配置", content: "必须用 cindy 的 Win 平台工具改注册表",
      env_scope: "os=windows", updated_at: "2026-10-01 00:00:00" },
    { id: 2, project: "p1", category: "fact", lifecycle_status: "active",
      title: "Docker 端口冲突", content: "改 dockerd 监听端口即可",
      related_entities: "docker", updated_at: "2026-10-02 00:00:00" },
  ];
  const body = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "SYSTEM-PROMPT" },
      { role: "user", content: "早先的问题" },
      { role: "assistant", content: "早先的回答" },
      { role: "user", content: "Docker 端口冲突怎么处理" },
    ],
    tools: toolsOpenAI(["mcp__magpie__memory_context"]),
  };
  const before = JSON.stringify([body.messages[0], body.messages[1], body.messages[2]]);
  const ctx = {
    protocol: "chat",
    headers: { "x-magpie-agent": "openminis" },
    options: {
      inline_extract: true, project: "p1", memories: snapshot, memories_version: "v-test-1",
      client_profiles: JSON.stringify({ openminis: { os: "linux", arch: "arm64" } }),
    },
    state: {},
  };
  const out = onRequest(JSON.parse(JSON.stringify(body)), ctx);
  const lastUser = out.messages[out.messages.length - 1].content;
  assert.ok(lastUser.includes("Docker 端口冲突"), "通用记忆必须照常召回");
  /* 必须拿 content 判负向：principle 只渲染 content，用 title 判是假绿 */
  assert.ok(!lastUser.includes("必须用 cindy 的 Win 平台工具改注册表"), "反证：Windows 专属准则不得注入 alpine 会话");
  assert.strictEqual(JSON.stringify([out.messages[0], out.messages[1], out.messages[2]]), before,
    "KV-Cache 不变量：system 与历史消息必须逐字节不变");
  assert.strictEqual(ctx.state.env.mcp, "yes");
  assert.strictEqual(ctx.state.envAgent, "openminis");
});
check("图像禁止工具 + 有 MCP 时仍降档（不得双向放宽）", () => {
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "项目遇到报错: 失败" }],
    tools: toolsOpenAI(["mcp__magpie__memory_context", "mcp__magpie__pitfall_search", "mcp__magpie__memory_save"]),
  };
  const ctx = {
    protocol: "chat",
    headers: { "x-magpie-agent": "ishellpro" },
    options: { inline_extract: true, client_profiles: JSON.stringify({ ishellpro: { mcp: "no", forbid_tools: ["*_memory_*", "*_pitfall_*"] } }) },
    state: {},
  };
  const out = onRequest(JSON.parse(JSON.stringify(body)), ctx);
  assert.ok(out.messages[0].content.includes("能力未确认"));
  assert.ok(!out.messages[0].content.includes("mcp__magpie__memory_context"));
});
check("CCR 卡片：无工具时不得提 memory_get", () => {
  const block = buildContextBlock([], [{ id: 9, category: "fact", title: "长条目", content: "x".repeat(200) }],
    { ccr_cards: true, max_inject_count: 5, max_budget_chars: 4096, _canExpand: false });
  assert.ok(block.includes("id=9"));
  assert.ok(!block.includes("memory_get"));
});

/* ================= 9. 响应层幻觉检测 ================= */
console.log(NL + "▶ [9] 响应层幻觉检测");

check("四种协议的 tool_call 提取", () => {
  assert.deepStrictEqual(collectToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "a" } }] } }] }), ["a"]);
  assert.deepStrictEqual(collectToolCalls({ content: [{ type: "tool_use", name: "b" }] }), ["b"]);
  assert.deepStrictEqual(collectToolCalls({ output: [{ type: "function_call", name: "c" }] }), ["c"]);
  assert.deepStrictEqual(collectToolCalls({ candidates: [{ content: { parts: [{ functionCall: { name: "d" } }] } }] }), ["d"]);
});
check("调了未通告的记忆工具 → 记录 unadvertised", () => {
  const ctx = {
    protocol: "chat",
    options: { inline_extract: true },
    state: { caps: detectCapabilities({ tools: toolsOpenAI(["read_file"]) }), guideInjected: true, guideTier: 1 },
  };
  const body = { choices: [{ message: { tool_calls: [{ function: { name: "magpie-memory-hub_memory_context" } }] } }] };
  onResponse(body, ctx);
  const t = ctx.state.capsTelemetry;
  assert.ok(t, "必须产生遥测记录");
  assert.strictEqual(t.hallucinatedCount, 1);
  assert.strictEqual(t.hallucinated[0].kind, "unadvertised");
  assert.strictEqual(t.hallucinated[0].logical, "memory_context");
});
check("完全无工具却调工具 → 记录 unavailable", () => {
  const ctx = { protocol: "chat", options: {}, state: { caps: detectCapabilities({ messages: [] }) } };
  const body = { choices: [{ message: { tool_calls: [{ function: { name: "memory_save" } }] } }] };
  onResponse(body, ctx);
  assert.strictEqual(ctx.state.capsTelemetry.hallucinated[0].kind, "unavailable");
});
check("正常调用不报幻觉", () => {
  const ctx = { protocol: "chat", options: {}, state: { caps: detectCapabilities({ tools: toolsOpenAI(["mcp__magpie__memory_context"]) }) } };
  const body = { choices: [{ message: { tool_calls: [{ function: { name: "mcp__magpie__memory_context" } }] } }] };
  onResponse(body, ctx);
  assert.strictEqual(ctx.state.capsTelemetry.hallucinatedCount, 0);
  assert.strictEqual(ctx.state.capsTelemetry.memoryToolCalls, 1);
});

/* ================= 10. 自证门 ================= */
console.log(NL + "▶ [10] 门控不得误伤正常客户端");

check("无 header 时回落首个身份候选且不丢能力", () => {
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Docker 端口冲突怎么处理" }],
    tools: toolsOpenAI(["mcp__magpie__memory_context"]),
  };
  const ctx = { protocol: "chat", agent: "cindy", options: { inline_extract: true }, state: {} };
  const out = onRequest(JSON.parse(JSON.stringify(body)), ctx);
  assert.strictEqual(ctx.state.caps.present, true);
  assert.ok(out.messages[0].content.includes("[Memory Agent Guide"));
});

/* ================= 11. 元工具分发器（Cindy / pi 形态） ================= */
console.log(NL + "▶ [11] 元工具分发器档 1.5");

check("分发器名识别", () => {
  assert.strictEqual(isDispatcherName("cindy_mcp_call_tool"), true);
  assert.strictEqual(isDispatcherName("call_tool"), true);
  assert.strictEqual(isDispatcherName("run_code"), true);
  assert.strictEqual(isDispatcherName("mcp__magpie__call_tool"), true);
  assert.strictEqual(isDispatcherName("cindy_mcp_list_tools"), false);
  assert.strictEqual(isDispatcherName("read_file"), false);
});

check("detectCapabilities 暴露 dispatchers", () => {
  const caps = detectCapabilities({ tools: toolsOpenAI(["cindy_mcp_call_tool", "read_file"]) });
  assert.strictEqual(caps.hasTools, true);
  assert.strictEqual(caps.present, false);
  assert.strictEqual(caps.hasDispatcher, true);
  assert.deepStrictEqual(caps.dispatchers, ["cindy_mcp_call_tool"]);
});

check("有分发器时降为档 1.5（不是档 1，也不写死全名）", () => {
  const body = { messages: [], tools: toolsOpenAI(["cindy_mcp_call_tool", "cindy_mcp_list_tools", "read"]) };
  const st = { turnNo: 2 };
  const g = buildAgentGuide("项目遇到报错", { inline_extract: true }, body, { state: st });
  assert.ok(g.includes("经分发器可用"), "必须给出档 1.5 标题");
  assert.strictEqual(st.guideTier, 1.5, "档位必须记为 1.5");
  assert.ok(g.includes("cindy_mcp_call_tool"), "必须点出分发器名");
  assert.ok(g.includes("查找键"), "必须给查找键");
  assert.ok(g.includes("唯一入口"), "必须写明只能经分发器调");
  assert.ok(g.includes("保存必须是真的"), "必须带不可声称已保存条款");
  assert.ok(!g.includes("magpie-memory-hub_memory"), "反证：不得写死带前缀的全名，否则模型会绕过分发器");
});

check("分发器 + 本插件工具仍在时保持档 2", () => {
  const body = {
    messages: [],
    tools: toolsOpenAI(["cindy_mcp_call_tool", "mcp__magpie__memory_context"]),
  };
  const g = buildAgentGuide("项目遇到报错", { inline_extract: true }, body, { state: { turnNo: 2 } });
  assert.ok(g.includes("mcp__magpie__memory_context"), "有真名时必须优先用真名");
  assert.ok(!g.includes("经分发器可用"), "反证：不应降为 1.5");
});

check("画像 tools_via 让档 1.5 从猜变已知", () => {
  const body = { messages: [], tools: toolsOpenAI(["some_call_tool"]) };
  const caps = detectCapabilities(body);
  caps.toolsVia = "some_call_tool";
  const g = buildAgentGuide("项目遇到报错", { inline_extract: true }, body, { state: { turnNo: 2, caps } });
  assert.ok(g.includes("已按客户端画像确认分发器"), "必须识别 tools_via");
  assert.ok(g.includes("`some_call_tool`"), "必须点出画像指定名");
});

/* ================= 12. 枚举工具（分发器的兄弟） ================= */
console.log(NL + "▶ [12] 枚举工具点名");

check("枚举工具名识别", () => {
  assert.strictEqual(isListerName("cindy_mcp_list_tools"), true);
  assert.strictEqual(isListerName("list_tools"), true);
  assert.strictEqual(isListerName("tools_list"), true);
  assert.strictEqual(isListerName("cindy_mcp_call_tool"), false);
  assert.strictEqual(isListerName("read_file"), false);
});

check("detectCapabilities 同时暴露 dispatchers 与 listers", () => {
  const caps = detectCapabilities({
    tools: toolsOpenAI(["cindy_mcp_call_tool", "cindy_mcp_list_tools", "read"]),
  });
  assert.deepStrictEqual(caps.dispatchers, ["cindy_mcp_call_tool"]);
  assert.deepStrictEqual(caps.listers, ["cindy_mcp_list_tools"]);
  assert.strictEqual(caps.hasLister, true);
});

check("档 1.5 直接点名枚举工具，而不是“按分发器自身的方式”", () => {
  const body = { messages: [], tools: toolsOpenAI(["cindy_mcp_call_tool", "cindy_mcp_list_tools"]) };
  const g = buildAgentGuide("项目遇到报错", { inline_extract: true }, body, { state: { turnNo: 2 } });
  assert.ok(g.includes("第一步：用 `cindy_mcp_list_tools`"), "必须点名枚举工具");
  assert.ok(!g.includes("按分发器自身的方式枚举"), "反证：不得退回含糊说法");
});

check("没有枚举工具时仍给可执行的上位说法（不得直接崩）", () => {
  const body = { messages: [], tools: toolsOpenAI(["some_call_tool"]) };
  const g = buildAgentGuide("项目遇到报错", { inline_extract: true }, body, { state: { turnNo: 2 } });
  assert.ok(g.includes("按分发器自身的方式枚举"), "无枚举工具时必须给上位说法");
});

console.log(NL + "=================================================================");
if (fail.length) {
  console.error("❌ 失败 " + fail.length + " 项 / 通过 " + pass + " 项");
  for (const f of fail) console.error("   - " + f);
  process.exit(1);
}
console.log("✅ v7.0.3 能力门控 / 环境作用域 / 幻觉检测 对抗回归全部通过（" + pass + " 项）");
console.log("=================================================================");
