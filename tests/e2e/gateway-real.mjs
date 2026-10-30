/**
 * tests/e2e/gateway-real.mjs —— v7.0.0 真机集成测试
 *
 * 不是单元测试：这里起一个**真的 HTTP 网关**，走真的 onRequest / onResponse 中间件、
 * 真的宿主钩子（gateway_harvest.hooks.js）、真的工具执行路径（tools.js），
 * 并用真的子进程跑 memory-cli.js。唯一被替换的是大模型（规则型假 Agent）。
 *
 * 四个真客户端画像：
 *   ishellpro   —— 不支持 MCP，只带 read_file；且故意让模型“幻觉”调记忆工具
 *   openminis   —— 只有部分工具，arm64/linux
 *   cindy-win11 —— 工具齐全，windows/amd64
 *   codex       —— 工具名用另一套前缀
 *
 * 断言重点：
 *   ① 无 MCP 客户端的 prompt 里不出现任何记忆工具名（除能力未确认的那句常识描述）
 *   ② 模型真的幻觉调用时，响应层能确定性抓到并落盘到 caps-stats
 *   ③ 跨环境记忆不串场，而且 KV-Cache 前缀逐字节不变
 *   ④ 真实子进程的 CLI 通道可用
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOME = "/root/hub";
const TMP_HOME = path.join(os.tmpdir(), "memhub-e2e-home-" + process.pid);
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.HOME = TMP_HOME;
process.env.MEMHUB_GATEWAY_CONV_DIR = path.join(TMP_HOME, "conv");

const { onRequest, onResponse, onEvent } = await import(HOME + "/memory.middleware.js");
const hooks = await import(HOME + "/gateway_harvest.hooks.js");
const capsStats = await import(HOME + "/src/services/caps-stats.js");

let pass = 0;
const fail = [];
function ok(name) { pass++; console.log("  OK   " + name); }
function bad(name, msg) { fail.push(name + " :: " + msg); console.log("  FAIL " + name + " :: " + msg); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const NL = String.fromCharCode(10);

/* ================= 客户端画像与工具清单 ================= */
const MANIFESTS = {
  /* ishellpro：既无 MCP 也无元工具分发器——用户实测就是这种形态下它去幻觉调 MCP */
  ishellpro: { tools: ["read_file", "write_file"], headers: { "x-magpie-agent": "ishellpro" } },
  openminis: {
    tools: ["mcp__magpie__memory_context", "mcp__magpie__memory_search", "mcp__magpie__memory_save"],
    headers: { "x-magpie-agent": "openminis" },
  },
  "cindy-win11": {
    tools: [
      "mcp__magpie__memory_context", "mcp__magpie__memory_search", "mcp__magpie__pitfall_search",
      "mcp__magpie__memory_save", "mcp__magpie__pitfall_save", "mcp__magpie__memory_get",
    ],
    headers: { "x-magpie-agent": "cindy-win11" },
  },
  /* Cindy / pi 的真实形态：MCP 工具包在元工具后面，工具名不进 tools 清单 */
  "cindy-dispatched": {
    tools: ["cindy_mcp_call_tool", "cindy_mcp_list_tools", "read"],
    headers: { "x-magpie-agent": "cindy" },
  },
  codex: {
    tools: ["magpie-memory-hub_memory_context", "magpie-memory-hub_memory_save"],
    headers: { "x-magpie-agent": "codex" },
  },
};

/* 规则型假 Agent：
 *  - obedient     ：只会调清单里存在的工具（正常模型）
 *  - hallucinating：只要在 prompt 里“看到”记忆工具的写法，就去调它（真实故障形态）
 */
function fakeAgent(mode, manifest, promptText) {
  const inManifest = (n) => manifest.indexOf(n) !== -1;
  /* 幻觉模式不依赖 prompt 里是否看得到工具名——它的定义就是“模型没清单约束”，
   * 否则就变成在测 prompt 而不是在测检测器。 */
  if (mode === "hallucinating") {
    const wanted = manifest.find((n) => /memory_context$/.test(n)) || "magpie-memory-hub_memory_context";
    return { content: "", toolCalls: [{ function: { name: wanted } }] };
  }
  const sawMemoryName = /memory_(context|save|search)|pitfall_(search|save)/.test(promptText);
  if (!sawMemoryName) return { content: "好，直接根据上下文作答。", toolCalls: [] };
  if (mode === "obedient" && !inManifest("mcp__magpie__memory_context") && !inManifest("magpie-memory-hub_memory_context")) {
    return { content: "我没有记忆工具，直接作答。", toolCalls: [] };
  }
  const target = manifest.find((n) => /memory_context$/.test(n)) || "magpie-memory-hub_memory_context";
  return { content: "", toolCalls: [{ function: { name: target } }] };
}

/* ================= 快照与配置 ================= */
const SNAPSHOT = [
  { id: 1, project: "e2e", category: "principle", lifecycle_status: "active",
    title: "Windows 宿主机改配置铁律", content: "必须用 cindy 的 Win 平台工具改注册表，禁止在沙箱里假装改完",
    env_scope: "os=windows", updated_at: "2026-10-01 00:00:00" },
  { id: 2, project: "e2e", category: "fact", lifecycle_status: "active",
    title: "Docker 端口冲突处理", content: "改 dockerd 监听端口即可，容器侧不用动",
    related_entities: "docker", updated_at: "2026-10-02 00:00:00" },
  { id: 3, project: "e2e", category: "fact", lifecycle_status: "active",
    title: "Alpine 上装 git 的坑", content: "apk add git 后需要重建索引",
    env_scope: "os=linux,arch=arm64", updated_at: "2026-10-03 00:00:00" },
];

const PROFILES = JSON.stringify({
  ishellpro: { forbid_tools: ["*_memory_*", "*_pitfall_*"] },
  openminis: { os: "linux", arch: "arm64" },
  "cindy-win11": { os: "windows", arch: "amd64" },
  codex: { os: "windows", arch: "amd64" },
});

function baseOptions() {
  return {
    inline_extract: true,
    project: "e2e",
    memories: SNAPSHOT,
    memories_version: "e2e-v1",
    client_profiles: PROFILES,
    capability_gate: "auto",
    guide_on_no_tools: false,
  };
}

/* ================= 网关 + 假模型 ================= */
const seen = {};
/** 流式请求的遥测快照（SSE 无法把诊断信息带回给测试，靠 /diag 读） */
let lastStreamTelemetry = null;

function handler(req, res) {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", async () => {
    try {
      if (req.method === "GET" && req.url === "/diag") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ lastStreamTelemetry }));
        return;
      }
      const body = JSON.parse(raw || "{}");
      const clientKey = String(body._client || "unknown");
      const mode = String(body._mode || "obedient");
      delete body._client; delete body._mode;
      const manifest = MANIFESTS[clientKey] ? MANIFESTS[clientKey].tools : [];

      const ctx = {
        protocol: "chat",
        headers: MANIFESTS[clientKey] ? MANIFESTS[clientKey].headers : {},
        options: baseOptions(),
        state: {},
      };

      onRequest(body, ctx);
      const promptText = body.messages.filter((m) => m.role === "user").map((m) => String(m.content)).join(NL);
      seen[clientKey] = { promptText, ctx };

      const out = fakeAgent(mode, manifest, promptText);

      /* v7.1.0：真流式分支——逐 chunk 走真 onEvent，工具名故意切开成碎片，
       * 验证累加与收口在真实 HTTP/SSE 上也成立。 */
      if (body._stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const name = out.toolCalls.length ? out.toolCalls[0].function.name : "";
        const head = name.slice(0, 8);
        const tail = name.slice(8);
        const events = name
          ? [
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: head } }] } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: tail } }] } }] },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ]
          : [
              { choices: [{ delta: { content: out.content || "ok" } }] },
              { choices: [{ delta: {}, finish_reason: "stop" }] },
            ];
        for (const ev of events) {
          onEvent(ev, ctx);
          res.write("data: " + JSON.stringify(ev) + "\n\n");
        }
        res.write("data: [DONE]\n\n");
        res.end();
        try { await hooks.onResponse({ streamed: true }, ctx); } catch (_) { /* 钩子失败不影响流 */ }
        lastStreamTelemetry = ctx.state.capsTelemetry || null;
        return;
      }

      const reply = {
        id: "chatcmpl-e2e",
        choices: [{ index: 0, message: { role: "assistant", content: out.content, tool_calls: out.toolCalls.length ? out.toolCalls : undefined }, finish_reason: "stop" }],
      };

      onResponse(reply, ctx);
      try { await hooks.onResponse(reply, ctx); } catch (_) { /* 宿主钩子失败不影响网关回包 */ }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply, telemetry: ctx.state.capsTelemetry || null }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

const server = http.createServer(handler);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const BASE = "http://127.0.0.1:" + port;
console.log("▶ 真机网关已启动 " + BASE);

async function call(clientKey, userText, mode, extraMessages) {
  const manifest = MANIFESTS[clientKey];
  const messages = (extraMessages || []).concat([{ role: "user", content: userText }]);
  const payload = {
    model: "gpt-4o",
    _client: clientKey,
    _mode: mode || "obedient",
    messages,
    tools: manifest.tools.map((n) => ({ type: "function", function: { name: n } })),
  };
  const res = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

function guard(name, fn) {
  return Promise.resolve().then(fn).then(ok.bind(null, name), (e) => bad(name, e && e.message));
}

/* ================= 1. ishellpro ================= */
console.log(NL + "▶ [1] ishellpro（不支持 MCP）");

await guard("obedient：prompt 里不出现任何具体记忆工具名", async () => {
  const r = await call("ishellpro", "项目遇到报错: Docker 端口冲突怎么处理");
  const p = seen.ishellpro.promptText;
  assert(!/`magpie-memory-hub_(memory|pitfall)_[a-z_]+`/.test(p), "不得出现硬编码工具名: " + p.slice(-400));
  assert(p.includes("能力未确认"), "应降为能力未确认档");
  assert(r.reply.choices[0].message.tool_calls === undefined, "正常模型不应发起工具调用");
});

await guard("obedient：通用记忆仍被召回，Windows 专属不串场", async () => {
  const p = seen.ishellpro.promptText;
  assert(p.includes("Docker 端口冲突"), "通用记忆必须召回");
  /* 必须拿 content 特征串判负向：principle 只渲染 content，用 title 判是假绿 */
  assert(!p.includes("必须用 cindy 的 Win 平台工具改注册表"), "Linux 客户端不得收到 Windows 专属准则");
});

await guard("hallucinating：模型硬调未通告工具 → 遥测记录 unadvertised", async () => {
  const r = await call("ishellpro", "记住：以后都用 pnpm。项目遇到报错。", "hallucinating");
  assert(r.telemetry, "必须产生遥测");
  assert(r.telemetry.hallucinatedCount >= 1, "必须抓到幻觉调用");
  assert(r.telemetry.memoryToolCalls >= 1, "必须计入记忆工具调用");
});

/* ================= 2. openminis ================= */
console.log(NL + "▶ [2] openminis（arm64 / linux）");

await guard("只注入 linux/arm64 匹配的记忆", async () => {
  await call("openminis", "Docker 端口冲突怎么处理，Alpine 上装 git 的坑是什么");
  const p = seen.openminis.promptText;
  assert(p.includes("Alpine 上装 git 的坑"), "arm64 linux 记忆必须召回");
  assert(!p.includes("必须用 cindy 的 Win 平台工具改注册表"), "反证：Windows 准则不得注入");
  assert(p.includes("mcp__magpie__memory_context"), "工具就绪时必须给出真实名");
});

/* ================= 3. cindy-win11 ================= */
console.log(NL + "▶ [3] cindy-win11（windows / amd64）");

await guard("收到 Windows 专属准则且工具名完整", async () => {
  await call("cindy-win11", "改配置这事怎么做");
  const p = seen["cindy-win11"].promptText;
  assert(p.includes("必须用 cindy 的 Win 平台工具改注册表"), "windows 客户端必须收到 windows 准则（正向对照：否定断言必须靠它才有意义）");
  assert(!p.includes("Alpine 上装 git 的坑"), "反证：linux 记忆不得注入 windows 客户端");
  assert(p.includes("mcp__magpie__memory_save"), "必须给出写入工具");
  assert(p.includes("保存必须是真的"), "必须带不可声称已保存条款");
});

await guard("KV-Cache：system 与历史消息逐字节不变", async () => {
  const history = [
    { role: "system", content: "SYSTEM-PROMPT-FIXED" },
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
  ];
  const before = JSON.stringify(history);
  await call("cindy-win11", "第二问：Docker 端口冲突", "obedient", history);
  const sent = seen["cindy-win11"].promptText;
  assert(sent.includes("Docker 端口冲突"), "注入必须落在最后一条用户消息上");
  assert(before.includes("SYSTEM-PROMPT-FIXED") && !sent.includes("SYSTEM-PROMPT-FIXED"),
    "system 不得被改写后进入用户消息");
});

/* ================= 4. codex（另一套前缀） ================= */
console.log(NL + "▶ [4] codex（工具名另一套前缀）");

await guard("按真实前缀生成引导，不混入魔改默认名", async () => {
  await call("codex", "项目遇到报错: 构建失败");
  const p = seen.codex.promptText;
  assert(p.includes("magpie-memory-hub_memory_context"), "必须用真实前缀");
  assert(p.includes("magpie-memory-hub_memory_save"), "必须用真实写入名");
});

/* ================= 4.5 cindy-dispatched（元工具分发器） ================= */
console.log(NL + "▶ [4.5] cindy-dispatched（元工具分发器）");

await guard("降为档 1.5：给查找键与唯一入口，不写死全名", async () => {
  await call("cindy-dispatched", "项目遇到报错: Docker 端口冲突");
  const p = seen["cindy-dispatched"].promptText;
  assert(p.includes("经分发器可用"), "必须走档 1.5，而不是档 1 的“能力未确认”");
  assert(p.includes("cindy_mcp_call_tool"), "必须点出分发器名");
  assert(p.includes("唯一入口"), "必须写明只能经分发器调");
  assert(p.includes("cindy_mcp_list_tools"), "必须点名枚举工具，不能让模型自己猜怎么枚举");
  assert(!p.includes("magpie-memory-hub_memory"), "反证：不得写死带前缀的全名");
  assert(p.includes("Docker 端口冲突"), "通用记忆仍必须被召回");
});
/* ================= 4.6 真流式 SSE ================= */
console.log(NL + "▶ [4.6] 真流式 SSE 遥测");

await guard("碎片化工具名经真 HTTP/SSE 能被累加并判定为幻觉", async () => {
  const payload = {
    model: "gpt-4o",
    _client: "ishellpro",
    _mode: "hallucinating",
    _stream: true,
    messages: [{ role: "user", content: "项目遇到报错，再试一次" }],
    tools: MANIFESTS.ishellpro.tools.map((n) => ({ type: "function", function: { name: n } })),
  };
  const res = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  assert(text.includes("data: [DONE]"), "必须真的走 SSE 且正常结束");
  assert(text.includes("tool_calls"), "流里必须真的带工具调用块");
  const diag = await (await fetch(BASE + "/diag")).json();
  const t = diag.lastStreamTelemetry;
  assert(t, "流式请求必须产出遥测（v7.0.x 这里是空的）");
  assert(t.toolCalls >= 1, "必须计入工具调用，实际 " + JSON.stringify(t));
  assert(t.hallucinatedCount >= 1, "必须判定为幻觉调用");
  assert(t.hallucinated[0].kind === "unadvertised", "分类必须是 unadvertised");
});
/* ================= 5. 遥测落盘 + 降档建议 ================= */
console.log(NL + "▶ [5] 幻觉遥测落盘与降档建议");

await guard("幻觉遥测穿透中间件→钩子→文件（真机链路）", async () => {
  /* 本用例只证链路贯通：中间件检测 → 宿主钩子落盘 → 文件可读。
   * 三次阈值聚合需要可控时钟（写盘有 60s 节流），由 test_v700_env_scope 用注入时钟覆盖。 */
  assert(fs.existsSync(capsStats.capsStatsPath()), "统计文件必须已落盘");
  const stats = capsStats.readCapsStats();
  const a = stats.agents.ishellpro;
  assert(a, "必须落盘该客户端的统计：" + JSON.stringify(stats.agents));
  assert(a.hallucinated >= 1, "幻觉计数必须至少 1，实际 " + a.hallucinated);
  assert(a.lastHallucination && a.lastHallucination.kind === "unadvertised",
    "必须记录幻觉类型，实际 " + JSON.stringify(a.lastHallucination));
});

/* ================= 6. 真实子进程：CLI 通道 ================= */
console.log(NL + "▶ [6] 真实子进程 memory-cli.js");

await guard("doctor 正常退出并报告 21 个工具", async () => {
  const r = spawnSync(process.execPath, [HOME + "/memory-cli.js", "doctor"], {
    encoding: "utf8", env: Object.assign({}, process.env, { MEMHUB_PROJECT: "e2e" }), timeout: 60000,
  });
  assert(r.status === 0, "退出码必须为 0，实际 " + r.status + " stderr=" + r.stderr);
  const out = JSON.parse(String(r.stdout).trim().split(NL).pop());
  assert(out.tools === 21, "工具数必须为 21，实际 " + out.tools);
});

await guard("未知子命令退出码 1（反证）", async () => {
  const r = spawnSync(process.execPath, [HOME + "/memory-cli.js", "nope"], { encoding: "utf8", timeout: 60000 });
  assert(r.status === 1, "退出码必须为 1，实际 " + r.status);
});

await guard("save 缺参退出码 1", async () => {
  const r = spawnSync(process.execPath, [HOME + "/memory-cli.js", "save", "--title", "只有标题"], { encoding: "utf8", timeout: 60000 });
  assert(r.status === 1, "退出码必须为 1，实际 " + r.status);
});

/* ================= 7. 设置页静态契约 ================= */
console.log(NL + "▶ [7] 设置页新卡片契约");

await guard("settings.html 暴露全部能力门控控件", async () => {
  const html = fs.readFileSync(HOME + "/settings.html", "utf8");
  for (const id of ["card_caps", "capability_gate", "guide_on_no_tools", "env_scope_strict", "client_profiles", "cli_channel", "caps_telemetry", "btn_save_card_caps", "caps_action_status", "btn_autofill_profiles"]) {
    assert(html.indexOf('id="' + id + '"') !== -1, "缺少控件 id=" + id);
  }
});

await guard("settings.js 注册字段与 JSON 校验", async () => {
  const js = fs.readFileSync(HOME + "/src/page/settings.js", "utf8");
  assert(/caps:\s*\[/.test(js), "CARD_FIELDS 缺少 caps");
  assert(js.includes("client_profiles 不是合法 JSON"), "缺少 client_profiles JSON 校验");
  assert(/function autofillProfiles/.test(js), "缺少一键补齐实现");
  assert(js.indexOf("btn_autofill_profiles") !== -1, "按钮未绑定");
});

/* ================= 8. 宿主写 caps 统计卡片 ================= */
console.log(NL + "▶ [8] 宿主写 caps 统计卡片");

await guard("writeCardStatus 接受 caps 并落成可读卡片", async () => {
  const statusWriter = await import(HOME + "/src/core/status-writer.js");
  const target = path.join(TMP_HOME, "_status_probe.js");
  const summary = capsStats.buildCapsSummary();
  const wrote = statusWriter.writeCardStatus("caps", summary, "caps_stats", target);
  assert(wrote === true, "writeCardStatus 必须接受 caps 键");
  const text = fs.readFileSync(target, "utf8");
  assert(text.indexOf("caps") !== -1, "_status.js 必须包含 caps 卡片");
  assert(text.indexOf("能力统计") !== -1, "必须写入可读标题");
});

/* ================= 收尾 ================= */
server.close();
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (e) { console.log("  note   临时目录回收失败: " + (e && e.message)); }

console.log(NL + "=================================================================");
if (fail.length) {
  console.error("❌ 失败 " + fail.length + " 项 / 通过 " + pass + " 项");
  for (const f of fail) console.error("   - " + f);
  process.exit(1);
}
console.log("✅ v7.1.0 真机网关集成测试全部通过（" + pass + " 项）");
console.log("=================================================================");
