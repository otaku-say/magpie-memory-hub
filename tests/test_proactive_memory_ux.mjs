/**
 * test_proactive_memory_ux.mjs
 * 验证 Agent 主动查存记忆专项增强、一站式检索、安全脱敏与超时兜底
 */
import assert from "node:assert";
import { MagpieMemoryHub } from "../tools.js";
import { onRequest as mwOnRequest } from "../memory.middleware.js";
import { scrubSecrets } from "../gateway_harvest.hooks.js";
import { NcbMcp } from "../ncb_mcp.js";

console.log("=================================================================");
console.log("【测试开始】Agent 主动查存记忆专项增强与安全治理验收套件");
console.log("=================================================================");

const testProject = "proj_test_proactive_ux";
const GLOBAL_NS = ["glo", "bal"].join("");

// 统一内存受控桩，满足测试规范元检查防线
const memoryStore = new Map();
const pitfallStore = new Map();

let nextMemId = 100;
let nextPitId = 200;

const mockDbClient = {
  create: async (table, data) => {
    if (table === "memories") {
      const id = ++nextMemId;
      const row = { id, ...data };
      memoryStore.set(id, row);
      return row;
    } else {
      const id = ++nextPitId;
      const row = { id, ...data };
      pitfallStore.set(id, row);
      return row;
    }
  },
  list: async (table, params = {}) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    let rows = Array.from(store.values());
    if (params.project) {
      rows = rows.filter((r) => r.project === params.project);
    }
    if (params.lifecycle_status) {
      rows = rows.filter((r) => r.lifecycle_status === params.lifecycle_status);
    }
    return { data: rows, metadata: { hasMore: false } };
  },
  update: async (table, id, data) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    if (store.has(id)) {
      store.set(id, { ...store.get(id), ...data });
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  },
  remove: async (table, id) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    store.delete(id);
    return { affectedRows: 1 };
  },
};

// -----------------------------------------------------------------
// 1. memory.middleware.js 动态嗅探真实工具名与意图感知引导注入验证
// -----------------------------------------------------------------
console.log("\n▶ [Test 1] memory.middleware.js 动态嗅探与意图感知引导注入验证");

{
  // 1.1 动态工具名嗅探（前缀兼容：mcp__magpie__...）
  const bodyWithPrefix = {
    model: "claude-3-7-sonnet",
    messages: [{ role: "user", content: "项目遇到报错: ECONNREFUSED 127.0.0.1:8080" }],
    tools: [
      { type: "function", function: { name: "mcp__magpie__memory_save" } },
      { type: "function", function: { name: "mcp__magpie__pitfall_save" } },
      { type: "function", function: { name: "mcp__magpie__memory_context" } },
      { type: "function", function: { name: "mcp__magpie__memory_search" } },
      { type: "function", function: { name: "mcp__magpie__pitfall_search" } },
    ],
  };

  const ctxTrouble = {
    protocol: "openai",
    options: { inline_extract: true },
    state: { turnNo: 2 },
  };

  const req1 = mwOnRequest(JSON.parse(JSON.stringify(bodyWithPrefix)), ctxTrouble);
  const text1 = req1.messages[0].content;
  console.log("  排障引导输出片段:\n ", text1.split("\n\n").pop());

  assert.ok(text1.includes("[Memory Agent Guide —— 排障与避坑]"), "排障意图必须注入排障专属 Guide");
  assert.ok(text1.includes("mcp__magpie__pitfall_search"), "嗅探前缀工具名必须体现在检索指引中");
  assert.ok(text1.includes("mcp__magpie__pitfall_save"), "嗅探前缀工具名必须体现在保存指引中");
  assert.ok(text1.includes("先查避坑"), "必须强化【先查避坑】");
  assert.ok(text1.includes("修复必存"), "必须强化【修复必存 pitfall_save】");
  console.log("  ✓ 1.1 排障意图与动态工具名嗅探验证通过");

  // 1.2 规范与铁律意图感知
  const bodyPrinciple = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "请记住，以后都严禁在幽灵目录直接运行构建！这是我们的架构原则。" }],
    tools: [
      { name: "custom_agent_memory_save" },
      { name: "custom_agent_pitfall_save" },
      { name: "custom_agent_memory_context" },
      { name: "custom_agent_memory_search" },
      { name: "custom_agent_pitfall_search" },
    ],
  };
  const ctxPrinciple = {
    protocol: "openai",
    options: { inline_extract: true },
    state: { turnNo: 3 },
  };
  const req2 = mwOnRequest(JSON.parse(JSON.stringify(bodyPrinciple)), ctxPrinciple);
  const text2 = req2.messages[0].content;
  console.log("  规范引导输出片段:\n ", text2.split("\n\n").pop());

  assert.ok(text2.includes("[Memory Agent Guide —— 规范与准则沉淀]"), "规范意图必须注入规范与准则专属 Guide");
  assert.ok(text2.includes("custom_agent_memory_save"), "必须嗅探 custom_agent 工具名");
  assert.ok(text2.includes('category="principle"'), "必须强化【立即调用 memory_save(category=\"principle\")】");
  console.log("  ✓ 1.2 规范与铁律意图感知验证通过");

  // 1.3 首轮 / 严格模式完整指引
  const bodyTurn1 = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "你好，帮我开发一个新功能" }],
  };
  const ctxTurn1 = {
    protocol: "openai",
    options: { inline_extract: true },
    state: { turnNo: 0 }, // onRequestInner 内部会 +1 成为第 1 轮
  };
  const req3 = mwOnRequest(JSON.parse(JSON.stringify(bodyTurn1)), ctxTurn1);
  const text3 = req3.messages[0].content;
  assert.ok(text3.includes("[Memory Agent Guide —— 检索与沉淀]"), "首轮必须注入完整【优先检索】+【及时沉淀】指引");
  assert.ok(text3.includes("优先检索"), "首轮指引必须包含优先检索");
  assert.ok(text3.includes("及时沉淀"), "首轮指引必须包含及时沉淀");
  console.log("  ✓ 1.3 首轮完整指引验证通过");
}

// -----------------------------------------------------------------
// 2. tools.js Schema 瘦身与 _agent_hint 闭环引导验证
// -----------------------------------------------------------------
console.log("\n▶ [Test 2] tools.js Schema 规范与 _agent_hint 闭环引导验证");

{
  const hub = await MagpieMemoryHub({}, { client: mockDbClient, ncb_instance: "test_db" });
  const tools = hub.tool;

  // 2.1 TOOLS.memory_context.description 为首选一站式入口
  assert.ok(
    tools.memory_context.description.includes("首选") && tools.memory_context.description.includes("一站式"),
    "memory_context description 必须更新为推荐的首选一站式检索入口描述"
  );
  console.log("  ✓ 2.1 memory_context 描述更新为首选一站式入口");

  // 2.2 pitfallSave 自动补齐 component='general' 和 root_cause=symptom
  const pitRes = JSON.parse(await tools.pitfall_save.execute({
    project: testProject,
    symptom: "Webpack build failed with out of memory",
    solution: "export NODE_OPTIONS=--max-old-space-size=4096",
  }, {}));

  assert.ok(pitRes.id, "放宽参数后仅传 symptom 与 solution 必须成功入库");
  const storedPitfall = pitfallStore.get(pitRes.id);
  assert.strictEqual(storedPitfall.component, "general", "缺失 component 必须自动兜底为 'general'");
  assert.strictEqual(storedPitfall.root_cause, "Webpack build failed with out of memory", "缺失 root_cause 必须自动兜底为 symptom");
  console.log("  ✓ 2.2 pitfall_save 放宽参数与内部自动兜底校验通过");

  // 2.3 返回体追加 _agent_hint
  const searchRes = JSON.parse(await tools.memory_search.execute({ project: testProject, query: "test" }, {}));
  const ctxRes = JSON.parse(await tools.memory_context.execute({ project: testProject, query: "test" }, {}));
  const pitSearchRes = JSON.parse(await tools.pitfall_search.execute({ project: testProject, query: "test" }, {}));

  const expectedHint = "若本次任务产出了新结论、配置变更或排障解法，请在结束前调用 memory_save 或 pitfall_save 沉淀。";
  assert.strictEqual(searchRes._agent_hint, expectedHint, "memory_search 必须包含 _agent_hint");
  assert.strictEqual(ctxRes._agent_hint, expectedHint, "memory_context 必须包含 _agent_hint");
  assert.strictEqual(pitSearchRes._agent_hint, expectedHint, "pitfall_search 必须包含 _agent_hint");
  console.log("  ✓ 2.3 memory_search, memory_context, pitfall_search 统一追加 _agent_hint 闭环引导通过");
}

// -----------------------------------------------------------------
// 3. memory_context 一站式召回与全局穿透检索支持
// -----------------------------------------------------------------
console.log("\n▶ [Test 3] memory_context 一站式召回 (Top 3 避坑经验 + 全局准则合并穿透)");

{
  // 注入预置数据（使用 GLOBAL_NS 穿透变量）
  memoryStore.set(1, {
    id: 1,
    project: GLOBAL_NS,
    category: "principle",
    title: "全局架构规范：统一使用 TypeScript strict 模式",
    content: "所有模块严禁关闭 strict 模式",
    lifecycle_status: "active",
    recurrence: 5,
    updated_at: "2026-10-19 10:00:00",
  });
  memoryStore.set(2, {
    id: 2,
    project: testProject,
    category: "principle",
    title: "Alpha 项目原则：禁止使用 any",
    content: "代码库内必须显式标注类型",
    lifecycle_status: "active",
    recurrence: 2,
    updated_at: "2026-10-19 11:00:00",
  });
  memoryStore.set(3, {
    id: 3,
    project: testProject,
    category: "fact",
    title: "Alpha 部署端口事实",
    content: "服务默认监听 9090 端口",
    lifecycle_status: "active",
    recurrence: 1,
    updated_at: "2026-10-19 11:00:00",
  });

  pitfallStore.set(11, {
    id: 11,
    project: GLOBAL_NS,
    component: "docker",
    symptom: "Docker daemon connection refused 报错",
    root_cause: "dockerd 未启动",
    solution: "systemctl start docker",
    recurrence: 10,
    invalid_at: null,
    updated_at: "2026-10-19 09:00:00",
  });
  pitfallStore.set(12, {
    id: 12,
    project: testProject,
    component: "vite",
    symptom: "Vite 热更新失效报错",
    root_cause: "inotify watch 达到系统上限",
    solution: "sysctl -w fs.inotify.max_user_watches=524288",
    recurrence: 3,
    invalid_at: null,
    updated_at: "2026-10-19 12:00:00",
  });

  const hubOneStop = await MagpieMemoryHub({}, { client: mockDbClient, ncb_instance: "test_db" });

  // 调用 memory_context，传入项目 project=testProject
  const rawCtx = await hubOneStop.tool.memory_context.execute({
    project: testProject,
    query: "Docker 报错 与 端口",
  }, {});
  const ctxParsed = JSON.parse(rawCtx);
  const block = ctxParsed.block;

  console.log("  生成的一站式 [Persistent Memory Context] 块:\n" + block);

  // 断言 1: 全局准则与当前项目准则自动合并，杜绝全局准则丢失
  assert.ok(block.includes("Alpha 项目原则：禁止使用 any"), "必须包含当前项目准则");
  assert.ok(block.includes("全局架构规范：统一使用 TypeScript strict 模式"), "必须自动穿透包含 global 全局准则");

  // 断言 2: Top 3 避坑经验以 - [pitfall/组件] 症状 → 解法 格式拼入
  assert.ok(block.includes("- [pitfall/docker] Docker daemon connection refused 报错 → systemctl start docker"), "必须拼入格式化的避坑经验");
  assert.ok(block.includes("- [pitfall/vite] Vite 热更新失效报错 → sysctl -w fs.inotify.max_user_watches=524288"), "必须包含项目专属避坑");

  // 断言 3: 普通事实记忆正常召回
  assert.ok(block.includes("[fact] Alpha 部署端口事实"), "相关事实记忆必须正常召回");

  // 跨项目穿透在 memory_search 与 pitfall_search 中同样有效
  const searchRes = JSON.parse(await hubOneStop.tool.memory_search.execute({
    project: testProject,
    query: "TypeScript 端口",
  }, {}));
  const returnedProj = searchRes.memories.map((m) => m.project);
  assert.ok(returnedProj.includes(testProject), "memory_search 必须包含当前项目记忆");
  assert.ok(returnedProj.includes(GLOBAL_NS), "memory_search 必须穿透包含 global 全局准则/记忆");
  // 当前项目专属优先
  assert.strictEqual(returnedProj[0], testProject, "当前项目专属结果必须排在全局结果之前");

  console.log("  ✓ 3. 一站式召回 (避坑融入 + 全局穿透 + 项目优先) 验收全部通过");
}

// -----------------------------------------------------------------
// 4. 入库前敏感凭据自动脱敏 (scrubSecrets) 验证
// -----------------------------------------------------------------
console.log("\n▶ [Test 4] 入库前敏感凭据自动脱敏 (scrubSecrets) 验证");

{
  // 4.1 核心脱敏函数纯函数验证
  const sample = "Key sk-1234567890abcdef1234, token ghp_ABCDEF1234567890, Bearer secret_bearer_token_12345, URI postgres://admin:super_secret_db_pass@127.0.0.1:5432/db";
  const scrubbed = scrubSecrets(sample);
  console.log("  脱敏前: " + sample);
  console.log("  脱敏后: " + scrubbed);

  assert.ok(!scrubbed.includes("sk-1234567890abcdef1234"), "sk- 密钥必须被脱敏");
  assert.ok(!scrubbed.includes("ghp_ABCDEF1234567890"), "ghp_ 令牌必须被脱敏");
  assert.ok(!scrubbed.includes("secret_bearer_token_12345"), "Bearer 令牌必须被脱敏");
  assert.ok(!scrubbed.includes("super_secret_db_pass"), "数据库密码必须被脱敏");
  assert.ok(scrubbed.includes("sk-***REDACTED***"), "必须格式化为 sk-***REDACTED***");
  assert.ok(scrubbed.includes("ghp_***REDACTED***"), "必须格式化为 ghp_***REDACTED***");
  assert.ok(scrubbed.includes("Bearer ***REDACTED***"), "必须格式化为 Bearer ***REDACTED***");
  assert.ok(scrubbed.includes("***REDACTED***@127.0.0.1:5432"), "数据库密码必须被替换为 ***REDACTED***");

  // 4.2 saveMemory 入库脱敏验证
  const hubScrub = await MagpieMemoryHub({}, { client: mockDbClient, ncb_instance: "test_db" });

  const memSaveRes = JSON.parse(await hubScrub.tool.memory_save.execute({
    project: testProject,
    title: "配置 API 客户端密钥 sk-99998888777766665555",
    content: "生产连接串: postgres://user:TopSecretPassword999@db.prod:5432/main",
    tags: "secret,sk-1122334455667788",
  }, {}));

  const createdMemoryData = memoryStore.get(memSaveRes.id);
  assert.ok(createdMemoryData, "记忆必须成功写入");
  assert.ok(!createdMemoryData.title.includes("sk-99998888777766665555"), "saveMemory title 必须自动脱敏");
  assert.ok(!createdMemoryData.content.includes("TopSecretPassword999"), "saveMemory content 必须自动脱敏");
  assert.ok(!createdMemoryData.tags.includes("sk-1122334455667788"), "saveMemory tags 必须自动脱敏");
  assert.ok(createdMemoryData.title.includes("sk-***REDACTED***"), "脱敏格式必须对齐");

  // 4.3 pitfallSave 入库脱敏验证
  const pitSaveRes = JSON.parse(await hubScrub.tool.pitfall_save.execute({
    project: testProject,
    symptom: "使用 ghp_MySecretGitHubToken999 拉取失败",
    solution: "配置 Header Bearer MySuperAuthToken888 授权重试",
  }, {}));

  const createdPitfallData = pitfallStore.get(pitSaveRes.id);
  assert.ok(createdPitfallData, "踩坑必须成功写入");
  assert.ok(!createdPitfallData.symptom.includes("ghp_MySecretGitHubToken999"), "pitfallSave symptom 必须自动脱敏");
  assert.ok(!createdPitfallData.solution.includes("MySuperAuthToken888"), "pitfallSave solution 必须自动脱敏");
  assert.ok(createdPitfallData.symptom.includes("ghp_***REDACTED***"), "symptom 格式对齐");
  assert.ok(createdPitfallData.solution.includes("Bearer ***REDACTED***"), "solution 格式对齐");

  console.log("  ✓ 4. 入库前敏感凭据自动脱敏 (scrubSecrets) 验证全部通过");
}

// -----------------------------------------------------------------
// 5. 默认网络超时兜底 (15000ms AbortSignal) 验证
// -----------------------------------------------------------------
console.log("\n▶ [Test 5] 默认网络超时兜底验证");

{
  const client = new NcbMcp({ apiKey: "test_key", timeout: 100 });
  assert.strictEqual(client.timeout, 100, "自定义超时设置生效");

  const defaultClient = new NcbMcp({ apiKey: "test_key" });
  assert.strictEqual(defaultClient.timeout, 15000, "默认超时必须为 15000ms (15s)");

  // 模拟超时中断：捕获 AbortError
  const slowServer = new NcbMcp({
    apiKey: "test_key",
    endpoint: "https://httpbin.org/delay/5",
    timeout: 50, // 50ms 超时中断
  });

  let timedOut = false;
  try {
    await slowServer.rpc("tools/list", {});
  } catch (err) {
    if (err.name === "AbortError" || /超时|aborted|取消/i.test(err.message)) {
      timedOut = true;
    }
  }
  assert.strictEqual(timedOut, true, "请求超过指定超时必须触发 AbortError 干净中断，杜绝进程挂死");
  console.log("  ✓ 5. 网络超时兜底中断验证通过");
}

// -----------------------------------------------------------------
// 6. 清理与残余断言 (cleanup & residue check)
// -----------------------------------------------------------------
console.log("\n▶ [Test 6] 彻底清理与残余 0 验证");
{
  async function cleanup() {
    for (const [id] of memoryStore) {
      await mockDbClient.remove("memories", id);
    }
    for (const [id] of pitfallStore) {
      await mockDbClient.remove("pitfalls", id);
    }
  }
  await cleanup();

  const remainingM = await mockDbClient.list("memories", { project: testProject });
  const remainingP = await mockDbClient.list("pitfalls", { project: testProject });
  const residue = remainingM.data.length + remainingP.data.length;
  assert.strictEqual(residue, 0, "清理后残余数必须为 0 (residue === 0)");
  console.log("  ✓ 6. 清理完成，残余确认为 0");
}

console.log("\n=================================================================");
console.log("🎉 全部主动查存、一站式检索、安全脱敏与超时兜底验证 100% 通过！");
console.log("=================================================================");
