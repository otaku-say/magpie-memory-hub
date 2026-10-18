/**
 * test_traceability.mjs —— 记忆与踩坑「来源可追溯性」全量测试套件
 * ====================================================================
 * 覆盖三处写入通道：
 *   1. 异步网关钩子（gateway_harvest.hooks.js）
 *   2. MCP 工具层（tools.js - MagpieMemoryHub tool 接口）
 *   3. 录制离线提炼（gateway_harvest.js）
 * 包含正向断言（有值且符合预期）与严格反证断言（无会话时为 null，超长截断，空对象防御，绝不伪造虚假数据）。
 * 纯内存 Mock 客户端，对生产库 0 写入 0 污染。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION, TABLES } from "../schema.js";
import {
  countTurnsFromMessages,
  processDialogueAndHarvest,
} from "../gateway_harvest.hooks.js";
import { harvestGateway } from "../gateway_harvest.js";
import { MagpieMemoryHub } from "../tools.js";

let testsRun = 0;
function test(name, fn) {
  testsRun++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

async function asyncTest(name, fn) {
  testsRun++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const memoryStore = new Map();
const pitfallStore = new Map();
let nextId = 1;

function makeMockClient() {
  const records = { memories: [], pitfalls: [] };
  const mockDbClient = {
    records,
    list: async (table, params) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const rows = [];
      for (const row of store.values()) {
        if (params && params.project && row.project !== params.project) continue;
        rows.push({ ...row });
      }
      return { data: rows };
    },
    create: async (table, payload) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const id = nextId++;
      const row = { id, ...payload };
      store.set(id, row);
      records[table].push(row);
      return { id, insertId: id };
    },
    update: async (table, id, patch) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const row = store.get(id);
      if (row) Object.assign(row, patch);
      const rec = records[table].find((r) => r.id === id);
      if (rec) Object.assign(rec, patch);
      return { id };
    },
  };
  return mockDbClient;
}

function cleanup() {
  memoryStore.clear();
  pitfallStore.clear();
}

async function runAll() {
  console.log("=== 1. schema.js 结构与版本声明校验 ===");
  test("SCHEMA_VERSION 升为 4", () => {
    assert.equal(SCHEMA_VERSION, 4);
  });

  test("memories 与 pitfalls 表均声明了 source_session 与 source_turn", () => {
    const memCols = TABLES.memories.columns.map((c) => c.name);
    const pitCols = TABLES.pitfalls.columns.map((c) => c.name);
    assert.ok(memCols.includes("source_session"), "memories 应包含 source_session");
    assert.ok(memCols.includes("source_turn"), "memories 应包含 source_turn");
    assert.ok(pitCols.includes("source_session"), "pitfalls 应包含 source_session");
    assert.ok(pitCols.includes("source_turn"), "pitfalls 应包含 source_turn");
  });

  console.log("\n=== 2. countTurnsFromMessages 跨协议轮次推导测试 ===");
  test("OpenAI / Anthropic: user 消息计数推导", () => {
    const body1 = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "help me with python" },
      ],
    };
    assert.equal(countTurnsFromMessages(body1), 2);

    const body2 = {
      messages: [
        { role: "user", content: "first question" },
      ],
    };
    assert.equal(countTurnsFromMessages(body2), 1);
  });

  test("Gemini: contents 中非 model/system 计数推导", () => {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "hello" }] },
        { role: "user", parts: [{ text: "tell me more" }] },
        { role: "model", parts: [{ text: "sure" }] },
        { role: "user", parts: [{ text: "thanks" }] },
      ],
    };
    assert.equal(countTurnsFromMessages(body), 3);
  });

  test("Responses API 轮次推导", () => {
    const bodyInputArray = {
      input: [
        { role: "user", content: "task 1" },
        { role: "assistant", content: "done 1" },
        { role: "user", content: "task 2" },
      ],
    };
    assert.equal(countTurnsFromMessages(bodyInputArray), 2);

    const bodyInputStr = { input: "single task text" };
    assert.equal(countTurnsFromMessages(bodyInputStr), 1);
  });

  test("【反证】无 user 消息或空输入时严格返回 null（绝不伪造默认轮次）", () => {
    assert.equal(countTurnsFromMessages(null), null);
    assert.equal(countTurnsFromMessages({}), null);
    assert.equal(countTurnsFromMessages({ messages: [] }), null);
    assert.equal(countTurnsFromMessages({ prompt: "legacy prompt" }), null);
    assert.equal(
      countTurnsFromMessages({
        messages: [
          { role: "system", content: "sys prompt" },
          { role: "assistant", content: "unprompted greeting" },
        ],
      }),
      null
    );
    assert.equal(countTurnsFromMessages({ contents: [{ role: "model", parts: [{ text: "hi" }] }] }), null);
    // 边界反证：Gemini 纯系统提示词绝不可被计为用户轮次
    assert.equal(countTurnsFromMessages({ contents: [{ role: "system", parts: [{ text: "sys" }] }] }), null);
    // 边界反证：空对象与非正文 parts 绝不可被误计
    assert.equal(countTurnsFromMessages({ contents: [null, undefined, {}] }), null);
    assert.equal(countTurnsFromMessages({ input: [null, undefined, {}] }), null);
    assert.equal(countTurnsFromMessages({ input: [{ role: "assistant" }] }), null);
  });

  console.log("\n=== 3. 异步网关钩子（gateway_harvest.hooks.js）写入溯源测试 ===");
  const mockTraceFetch = async (url, opts) => {
    let bodyText = "";
    try {
      const b = typeof opts?.body === "string" ? JSON.parse(opts.body) : opts?.body;
      bodyText = b?.messages?.map((m) => m.content).join("\n") || "";
    } catch (e) {
      bodyText = "";
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify([
              {
                category: "decision",
                title: "技术选型",
                content: bodyText.includes("/opt/venv")
                  ? "请激活虚拟环境：source /opt/venv/bin/activate 运行。"
                  : (bodyText.includes("/data/venv")
                    ? "请激活虚拟环境：source /data/venv/bin/activate 运行。"
                    : (bodyText.includes("fastify")
                      ? "必须统一使用 fastify 替代 express。"
                      : "技术选型统一采用 vite 替代 webpack 构建前端。")),
                tags: "convention",
                confidence: 0.95,
              },
              {
                category: "pitfall",
                title: "pytest 缺失",
                content: "运行出现 command not found: pytest，改用 python -m unittest 执行测试。",
                tags: "pytest",
                confidence: 0.95,
              },
            ]),
          },
        }],
      }),
    };
  };

  await asyncTest("正向：带 session 与 turn 时 memories 与 pitfalls 正确落盘", async () => {
    const client = makeMockClient();
    const dialogue = `[user]: 记下来：请帮我配置运行环境。
[assistant]: 执行 source /home/testuser/venv/bin/activate 激活 Python 环境。
技术选型统一采用 vite 替代 webpack 构建前端。
运行出现 command not found: pytest，改用 python -m unittest 执行测试。`;

    const meta = {
      project: "__test_trace__",
      agent: "test-agent",
      session: "sess-hook-positive-123",
      turn: 3,
    };

    const res = await processDialogueAndHarvest(dialogue, meta, client, {
      bypass_gate: true,
      extract_model: "mock-model",
      _fetch: mockTraceFetch,
    });
    assert.ok(res.memoriesSaved > 0 || res.pitfallsSaved > 0, "应有提炼入库");

    for (const m of client.records.memories) {
      assert.equal(m.source_session, "sess-hook-positive-123", "memory source_session 必须匹配");
      assert.equal(m.source_turn, 3, "memory source_turn 必须匹配");
    }
    for (const p of client.records.pitfalls) {
      assert.equal(p.source_session, "sess-hook-positive-123", "pitfall source_session 必须匹配");
      assert.equal(p.source_turn, 3, "pitfall source_turn 必须匹配");
    }
  });

  await asyncTest("【反证】无 session 与 turn 时严格落盘为 null（绝不伪造随机 UUID）", async () => {
    const client = makeMockClient();
    const dialogue = `[user]: 记下来：请帮我配置测试目录环境。
[assistant]: 执行 source /home/nulluser/venv/bin/activate 激活 Python 环境。`;

    const meta = {
      project: "__test_trace_null__",
      agent: "test-agent",
    };

    await processDialogueAndHarvest(dialogue, meta, client, {
      bypass_gate: true,
      extract_model: "mock-model",
      _fetch: mockTraceFetch,
    });

    assert.ok(client.records.memories.length > 0, "应有记忆产生");
    for (const m of client.records.memories) {
      assert.strictEqual(m.source_session, null, "无 session 时必须严格为 null，严禁假会话 ID");
      assert.strictEqual(m.source_turn, null, "无 turn 时必须严格为 null，严禁假轮次");
    }
  });

  await asyncTest("【反证】超长 session 自动截断至 128 字符（安全防爆）", async () => {
    const client = makeMockClient();
    const dialogue = `[user]: 记下来：必须统一使用 fastify 替代 express。
[assistant]: 收到，服务端框架决策已记录。`;

    const overlong = "session_" + "x".repeat(200);
    const meta = {
      project: "__test_trace_overlong__",
      agent: "test-agent",
      session: overlong,
      turn: "5", // 字符串数字测试自动解析
    };

    await processDialogueAndHarvest(dialogue, meta, client, {
      bypass_gate: true,
      extract_model: "mock-model",
      _fetch: mockTraceFetch,
    });
    assert.ok(client.records.memories.length > 0);
    for (const m of client.records.memories) {
      assert.equal(m.source_session.length, 128, "超长 session 必须安全截断至 128 字符");
      assert.equal(m.source_turn, 5, "字符串数字 turn 必须安全转为整数");
    }
  });

  console.log("\n=== 4. MCP 工具层（tools.js）写入溯源测试 ===");
  await asyncTest("memory_save 正向参数透传与上下文回退", async () => {
    const client = makeMockClient();
    const hub = await MagpieMemoryHub({}, { _client: client, client });
    const memSave = hub.tool["memory_save"];

    // 1. 直接传参
    await memSave.execute({
      project: "__test_trace__",
      title: "溯源测试条目 1",
      content: "使用 Redis 7.0",
      source_session: "sess-tool-direct-999",
      source_turn: 4,
    });

    const row1 = client.records.memories.find((r) => r.title === "溯源测试条目 1");
    assert.ok(row1);
    assert.equal(row1.source_session, "sess-tool-direct-999");
    assert.equal(row1.source_turn, 4);

    // 2. 从 ctx 回退
    await memSave.execute({
      project: "__test_trace__",
      title: "溯源测试条目 2",
      content: "使用 Node 22",
    }, { session: "sess-tool-ctx-888", turn: 2 });

    const row2 = client.records.memories.find((r) => r.title === "溯源测试条目 2");
    assert.ok(row2);
    assert.equal(row2.source_session, "sess-tool-ctx-888");
    assert.equal(row2.source_turn, 2);
  });

  await asyncTest("memory_save 【反证】无参数且无 ctx 时写入 null，超长时截断", async () => {
    const client = makeMockClient();
    const hub = await MagpieMemoryHub({}, { _client: client, client });
    const memSave = hub.tool["memory_save"];

    await memSave.execute({
      project: "__test_trace__",
      title: "溯源测试条目 3 无会话",
      content: "内容文本",
    });

    const row3 = client.records.memories.find((r) => r.title === "溯源测试条目 3 无会话");
    assert.ok(row3);
    assert.strictEqual(row3.source_session, null, "无 session 时必须为 null");
    assert.strictEqual(row3.source_turn, null, "无 turn 时必须为 null");

    // 超长 session 截断断言
    await memSave.execute({
      project: "__test_trace__",
      title: "溯源测试条目 4 超长会话",
      content: "内容文本",
      source_session: "long_session_".repeat(20),
    });
    const row4 = client.records.memories.find((r) => r.title === "溯源测试条目 4 超长会话");
    assert.ok(row4);
    assert.equal(row4.source_session.length, 128);
  });

  await asyncTest("pitfall_save 正向参数透传与【反证】无会话时为 null", async () => {
    const client = makeMockClient();
    const hub = await MagpieMemoryHub({}, { _client: client, client });
    const pitSave = hub.tool["pitfall_save"];

    // 正向
    await pitSave.execute({
      project: "__test_trace__",
      component: "docker",
      symptom: "port bind failure",
      root_cause: "port occupied",
      solution: "change port to 8081",
      source_session: "sess-pit-direct-777",
      source_turn: 5,
    });

    const row1 = client.records.pitfalls[0];
    assert.ok(row1);
    assert.equal(row1.source_session, "sess-pit-direct-777");
    assert.equal(row1.source_turn, 5);

    // 反证：不传时为 null
    await pitSave.execute({
      project: "__test_trace__",
      component: "nginx",
      symptom: "502 Bad Gateway",
      root_cause: "backend down",
      solution: "restart service",
    });

    const row2 = client.records.pitfalls[1];
    assert.ok(row2);
    assert.strictEqual(row2.source_session, null, "无 session 时 pitfall 必须为 null");
    assert.strictEqual(row2.source_turn, null, "无 turn 时 pitfall 必须为 null");
  });

  console.log("\n=== 5. 录制离线提炼（gateway_harvest.js）写入溯源测试 ===");
  await asyncTest("录制扫描提炼透传 session 与 turnIndex，无 session 时严格为 null", async () => {
    const tmpDir = path.join(os.tmpdir(), "test_trace_rec_" + Date.now());
    const sessDir1 = path.join(tmpDir, "session_pos");
    const sessDir2 = path.join(tmpDir, "session_null");
    fs.mkdirSync(sessDir1, { recursive: true });
    fs.mkdirSync(sessDir2, { recursive: true });

    fs.writeFileSync(path.join(sessDir1, "turn.json"), JSON.stringify({
      agent: "rec-agent",
      session: "sess-rec-xyz-789",
      input: [{ role: "user", text: "请记录：环境配置指南" }],
      output: [{ role: "assistant", text: "请激活虚拟环境：source /data/venv/bin/activate 运行。" }]
    }));

    fs.writeFileSync(path.join(sessDir2, "turn.json"), JSON.stringify({
      agent: "rec-agent",
      // 无 session
      input: [{ role: "user", text: "请记录：环境配置指南 2" }],
      output: [{ role: "assistant", text: "请激活虚拟环境：source /opt/venv/bin/activate 运行。" }]
    }));

    const capturedCalls = [];
    await harvestGateway({
      dir: tmpDir,
      project: "__test_trace__",
      force_rescan: true,
      extract_model: "mock-model",
      _fetch: mockTraceFetch,
    }, {
      _client: {},
      _cfg: {},
      saveMemory: async (c, cfg, payload) => {
        capturedCalls.push(payload);
        return { action: "CREATED" };
      },
      pitfallSave: async () => ({ action: "CREATED" }),
    });

    const call1 = capturedCalls.find((c) => c.content && c.content.includes("/data/venv/bin/activate"));
    assert.ok(call1, "应该提炼出第一条录制记忆");
    assert.equal(call1.source_session, "sess-rec-xyz-789", "录制 session 正确透传");
    assert.equal(call1.source_turn, 1, "录制首轮 turn 为 1");

    const call2 = capturedCalls.find((c) => c.content && c.content.includes("/opt/venv/bin/activate"));
    assert.ok(call2, "应该提炼出第二条录制记忆");
    assert.strictEqual(call2.source_session, null, "无 session 时严格为 null");
    assert.equal(call2.source_turn, 1);

    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 清理隔离内存记录并断言残余为 0
  cleanup();
  const residue = { total: memoryStore.size + pitfallStore.size };
  assert.strictEqual(residue.total, 0, "清理后内存残余必须为 0");

  console.log("\n=======================================================");
  console.log(`🎉 来源可追溯性测试全部通过！共运行 ${testsRun} 项断言。`);
  console.log("=======================================================");
}

runAll().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
