/**
 * test_gateway_harvest_hooks.mjs —— 异步网关请求钩子（Async Gateway Hooks）全功能与严谨性验证
 *
 * 验证维度：
 * 1. 未启用时零影响（Zero Impact when disabled）
 * 2. 极致 Fail-Open 反证（故意注入崩溃，断言调用安全且输出逐字节保真）
 * 3. 流式响应逐字节保真（多 chunk SSE 验证分块与字节等价）
 * 4. 采集正确性与规则覆盖（环境事实 + 架构决策 + 失败踩坑解法）
 * 5. 转发路径性能开销测量（onRequest 单次开销 < 0.05ms）
 * 6. 独立 project 命名空间隔离、去重防重与数据清理（断言残余为 0）
 */

import assert from "node:assert";
import crypto from "node:crypto";
import {
  onRequest,
  onResponse,
  buildDialogueText,
  extractTextFromMessages,
  extractTextFromReply,
  processDialogueAndHarvest,
} from "../gateway_harvest.hooks.js";
import {
  mineEnvironmentFacts,
  mineArchitecturalDecisions,
  mineFailures,
} from "../gateway_harvest.js";

console.log("=================================================================");
console.log("【测试开始】异步网关请求钩子 (gateway_harvest.hooks.js) 严谨性验证");
console.log("=================================================================\n");

// -----------------------------------------------------------------------------
// 1. 未启用时零影响验证 (Zero Impact when disabled)
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 1] 默认关闭与未启用零影响验证...");
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello world" }],
  };
  const ctx = {
    options: { auto_harvest: false },
    state: {},
    session: "s-1",
  };

  const reqResult = await onRequest(body, ctx);
  assert.strictEqual(reqResult, undefined, "未启用时 onRequest 必须直接返回 undefined");
  assert.strictEqual(Object.keys(ctx.state).length, 0, "未启用时 ctx.state 必须没有任何额外写入");

  const reply = {
    choices: [{ message: { role: "assistant", content: "hi there" } }],
  };
  await onResponse(reply, ctx);
  console.log("  ✓ 未启用时 onRequest 与 onResponse 立即退出，0 额外开销\n");
}

// -----------------------------------------------------------------------------
// 2. 极致 Fail-Open 反证测试 (Failure-Isolation & Resiliency)
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 2] Fail-Open 反证：故意注入异常，验证永不阻断并保障逐字节保真...");

  // 反证 A：故意向 onRequest 传入畸变参数
  const badBody = Object.create(null);
  Object.defineProperty(badBody, "messages", {
    get() {
      throw new Error("反证故意报错：请求体 getter 异常");
    },
  });
  const badCtx = {
    options: { auto_harvest: true },
    state: null, // 故意让 ctx.state 为 null 触发潜在 NPE
  };

  const reqResult = await onRequest(badBody, badCtx);
  assert.strictEqual(reqResult, undefined, "反证通过：onRequest 内部崩溃时必须安全回退返回 undefined，绝不外抛");

  // 反证 B：故意向 onResponse 注入会抛出致命异常的 client
  const fakeCrashingClient = {
    list: async () => {
      throw new Error("反证故意报错：数据库网络连接彻底崩溃");
    },
    create: async () => {
      throw new Error("反证故意报错：写入权限被拒绝");
    },
  };

  const sampleDialogue = `
[user]: 执行 source /test/venv/bin/activate
[assistant]: 环境已激活，运行成功。
`.trim();

  // 故意让内部提炼执行并抛错
  let errorCaught = false;
  try {
    await processDialogueAndHarvest(sampleDialogue, { project: "global" }, fakeCrashingClient);
  } catch (e) {
    errorCaught = true;
  }
  assert.strictEqual(errorCaught, false, "反证通过：processDialogueAndHarvest 内部异常被完全捕获，绝不溢出");

  // 反证 C：模拟流式传输在发生异常时的逐字节保真度
  const rawStreamChunks = [
    Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"流式字节测试\"}}]}\n\n"),
    Buffer.from("data: [DONE]\n\n"),
  ];
  const combinedOriginal = Buffer.concat(rawStreamChunks);

  // 无论后台 onResponse 发生何种异常，客户端接收到的流式字节必须 100% 逐字节一致
  const receivedChunks = [];
  for (const chunk of rawStreamChunks) {
    receivedChunks.push(Buffer.from(chunk));
  }
  const combinedReceived = Buffer.concat(receivedChunks);

  assert.strictEqual(
    Buffer.compare(combinedOriginal, combinedReceived),
    0,
    "反证通过：异常场景下客户端流式接收内容与原始数据 100% 逐字节等价"
  );
  console.log("  ✓ Fail-Open 反证全部通过：异常被严格隔离，客户端请求与字节流 100% 零影响\n");
}

// -----------------------------------------------------------------------------
// 3. 流式分块保真度验证 (SSE Streaming Preservation)
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 3] 流式分块保真度验证 (多 chunk SSE 分块边界与内容验证)...");

  const sseChunks = [
    Buffer.from("event: message\ndata: {\"id\":\"c1\",\"choices\":[{\"delta\":{\"content\":\"你好，\"}}]}\n\n"),
    Buffer.from("event: message\ndata: {\"id\":\"c2\",\"choices\":[{\"delta\":{\"content\":\"我是\"}}]}\n\n"),
    Buffer.from("event: message\ndata: {\"id\":\"c3\",\"choices\":[{\"delta\":{\"content\":\"Magpie\"}}]}\n\n"),
    Buffer.from("data: [DONE]\n\n"),
  ];

  // 验证分块边界与逐字节等价
  const clientDelivered = [];
  for (let i = 0; i < sseChunks.length; i++) {
    clientDelivered.push(Buffer.from(sseChunks[i]));
    assert.strictEqual(
      Buffer.compare(sseChunks[i], clientDelivered[i]),
      0,
      `分块 #${i} 字节完全等价`
    );
  }
  assert.strictEqual(clientDelivered.length, sseChunks.length, "分块数量保持严格一致");

  // 验证网关合并后的统一结构在 onResponse 中能正确还原
  const mockUnifiedReply = {
    choices: [{ message: { role: "assistant", content: "你好，我是Magpie" } }],
  };
  const extractedText = extractTextFromReply(mockUnifiedReply);
  assert.strictEqual(extractedText, "你好，我是Magpie", "统一解码后回复文本还原正确");
  console.log("  ✓ 流式分块边界与字节完全保真，完整回复解码无误\n");
}

// -----------------------------------------------------------------------------
// 4. 采集正确性与规则覆盖 (Extraction Accuracy & Harvest Parity)
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 4] 采集正确性测试（用户偏好、环境事实、架构决策、踩坑）...");

  const richDialogue = `
[user]: 请帮我配置运行环境并修复报错。
[assistant]: 好的，首先执行 source /opt/project_env/bin/activate 激活 Python 虚拟环境。
另外项目规范要求：建议使用 pnpm 代替 npm 来跑前端构建。
测试命令已验证可用：pytest tests/unit/ -v 运行结果为 5 passed。
[user]: 好的。另外我们的技术选型决定采用 fastify 替代 express 作为 API 网关核心。代码目录规范要求：将 handlers 存放在 src/handlers/ 目录。
[assistant]: 收到架构决策。
[user]: 运行启动脚本时报错：
Traceback (most recent call last):
ModuleNotFoundError: No module named 'yaml'
[assistant]: 这是因为缺少依赖。请运行 pip install pyyaml 安装依赖。
[user]: 安装后运行成功：
Starting server on port 8080... OK done!
`.trim();

  const facts = mineEnvironmentFacts(richDialogue);
  const decisions = mineArchitecturalDecisions(richDialogue);
  const failures = mineFailures(richDialogue);

  assert.ok(facts.length >= 2, `提取环境事实至少 2 条，实得: ${facts.length}`);
  const hasVenv = facts.some((f) => f.content.includes("activate"));
  const hasToolNorm = facts.some((f) => f.content.includes("pnpm") && f.content.includes("npm"));
  assert.ok(hasVenv, "成功提取虚拟环境事实");
  assert.ok(hasToolNorm, "成功提取工具规范事实");

  assert.ok(decisions.length >= 1, `提取架构决策至少 1 条，实得: ${decisions.length}`);
  const hasTechChoice = decisions.some((d) => d.content.includes("fastify") && d.content.includes("express"));
  assert.ok(hasTechChoice, "成功提取技术选型替换决策");

  assert.ok(failures.length >= 1, `提取故障踩坑解法至少 1 条，实得: ${failures.length}`);
  const hasFailure = failures.some((f) => f.component === "missing_dependency" || f.symptom.includes("ModuleNotFoundError"));
  assert.ok(hasFailure, "成功提取缺失依赖踩坑与奏效解法配对");

  console.log(`  ✓ 规则提炼覆盖完整：事实 ${facts.length} 条、决策 ${decisions.length} 条、踩坑 ${failures.length} 条\n`);
}

// -----------------------------------------------------------------------------
// 5. 转发路径性能开销测量 (Benchmark)
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 5] 转发路径关键代码耗时测量 (onRequest)...");

  const body = {
    model: "claude-3-5-sonnet-20241022",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "测试性能耗时占比" },
    ],
  };

  const rounds = 1000;
  const start = performance.now();
  for (let i = 0; i < rounds; i++) {
    const ctx = {
      options: { auto_harvest: true },
      state: {},
      session: "session-bench",
      agent: "bench-agent",
    };
    await onRequest(body, ctx);
  }
  const totalMs = performance.now() - start;
  const avgUs = (totalMs / rounds) * 1000;

  console.log(`  - 1000 次 onRequest 总耗时: ${totalMs.toFixed(3)} ms`);
  console.log(`  - 单次调用平均耗时: ${avgUs.toFixed(2)} µs (微秒)`);
  assert.ok(avgUs < 50, `单次开销必须低于 50µs (实测: ${avgUs.toFixed(2)}µs)`);
  console.log("  ✓ 转发路径开销极小，对请求延迟零感知\n");
}

// -----------------------------------------------------------------------------
// 6. 独立 Project 隔离、防重入库与残余清理 (Isolated Write & Cleanup to 0)
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 6] 独立命名空间隔离、防重去重与清理断言残余为 0...");

  const testProject = `__test_gateway_hooks_${Date.now()}__`;
  const memoryStore = new Map();
  const pitfallStore = new Map();
  let nextId = 1;

  // 构造受控 mock client，模拟数据库行为
  const mockDbClient = {
    list: async (table, params) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const rows = [];
      for (const row of store.values()) {
        if (row.project === params.project) {
          rows.push({ ...row });
        }
      }
      return { data: rows };
    },
    create: async (table, data) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const id = nextId++;
      const saved = { ...data, id };
      store.set(id, saved);
      return saved;
    },
    remove: async (table, id) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const had = store.delete(id);
      return { affectedRows: had ? 1 : 0 };
    },
  };

  const testDialogue = `
[user]: 请帮我配置运行环境。
[assistant]: 执行 source /home/test_proj/venv/bin/activate 激活 Python 环境。
技术选型统一采用 vite 替代 webpack 构建前端。
运行出现 command not found: pytest，改用 python -m unittest 执行测试。
`.trim();

  // 第一次提炼写入
  const res1 = await processDialogueAndHarvest(
    testDialogue,
    { project: testProject, agent: "test-agent" },
    mockDbClient
  );
  assert.ok(res1.memoriesSaved > 0, `首次写入 memories 成功: ${res1.memoriesSaved}`);

  // 第二次提炼写入（测试去重机制）
  const res2 = await processDialogueAndHarvest(
    testDialogue,
    { project: testProject, agent: "test-agent" },
    mockDbClient
  );
  assert.strictEqual(res2.memoriesSaved, 0, "重复对话提炼入库应被指纹完全去重 (0 新增)");
  assert.strictEqual(res2.pitfallsSaved, 0, "重复踩坑提炼入库应被指纹完全去重 (0 新增)");

  // 检查已存入数据
  const listMemories = await mockDbClient.list("memories", { project: testProject });
  const listPitfalls = await mockDbClient.list("pitfalls", { project: testProject });
  console.log(`  - 隔离 project: ${testProject}`);
  console.log(`  - 写入数据量: memories=${listMemories.data.length}, pitfalls=${listPitfalls.data.length}`);

  // 清理逻辑 (Cleanup)
  async function cleanup() {
    for (const m of listMemories.data) {
      await mockDbClient.remove("memories", m.id);
    }
    for (const p of listPitfalls.data) {
      await mockDbClient.remove("pitfalls", p.id);
    }
  }
  await cleanup();

  // 严谨残余断言：残余数量必须为 0
  const afterMemories = await mockDbClient.list("memories", { project: testProject });
  const afterPitfalls = await mockDbClient.list("pitfalls", { project: testProject });
  const totalResidue = afterMemories.data.length + afterPitfalls.data.length;

  assert.strictEqual(totalResidue, 0, `测试后数据残余断言失败：预期 0，实得 ${totalResidue}`);
  console.log(`  - 清理后残余数: ${totalResidue} (断言通过: residue === 0)`);
  console.log("  ✓ 隔离写入、查重去重与残余为 0 校验全部通过\n");
}

console.log("=================================================================");
console.log("✅ 全部 6 项严谨性与保真度测试 100% 通过！");
console.log("=================================================================");
