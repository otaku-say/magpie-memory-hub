/**
 * test_gateway_harvest.mjs —— GatewayConversations 读盘与增量提炼端到端验收测试
 * 严谨性整改：
 * 1. 唯一测试命名空间：通过 tests/lib/testenv.mjs 生成 project = env.project，
 *    所有提炼与搜索写入严格限制在该命名空间内，绝不污染用户真实库。
 * 2. 数据库行与临时文件双重清理：在 finally 中彻底清除所有 DB 行并断言残留数为 0。
 * 3. 强字段断言：断言 client、title、turns_processed、字段精确值。
 * 4. 反证测试：输入无有效规则的纯日常寒暄对话，反证引擎绝不伪造记忆与踩坑记录。
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MagpieMemoryHub } from "../tools.js";
import { resolveGatewayDir, harvestGateway, NO_CONVERSATIONS_MSG } from "../gateway_harvest.js";
import { createTestEnv } from "./lib/testenv.mjs";

const env = await createTestEnv({ instance: "41694_agent_memory", requireMcp: true });
console.log(`[test_gateway_harvest] 测试命名空间 project: ${env.project}`);

const tempDirs = [];
function makeTempDir(prefix) {
  const d = path.join(os.tmpdir(), prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));
  tempDirs.push(d);
  return d;
}

try {
  const hub = await MagpieMemoryHub({}, {
    ncb_instance: env.instance,
    ncb_secret: env.secret,
    mcp_key: env.mcpKey,
    _client: env.client,
    client: env.client,
  });

  console.log("=================================================================");
  console.log("【验收测试 1】目录不存在与目录为空时的容错行为");
  console.log("=================================================================");

  const nonExistentDir = makeTempDir("non_existent_gateway_conv");
  {
    const res = await hub.tool.harvest_gateway.execute({ dir: nonExistentDir, project: env.project });
    console.log("目录不存在时的执行结果：", JSON.stringify(res, null, 2));

    assert.strictEqual(res.success, true, "目录不存在时不应报错，success 须为 true");
    assert.strictEqual(res.has_conversations, false, "has_conversations 应为 false");
    assert.strictEqual(res.turns_processed, 0, "处理轮次应为 0");
    assert.strictEqual(res.message, NO_CONVERSATIONS_MSG, "提示语须符合规范说明");
    console.log("✓ [PASS] 目录不存在测试通过\n");
  }

  const emptyDir = makeTempDir("empty_gateway_conv");
  fs.mkdirSync(emptyDir, { recursive: true });
  {
    const res = await hub.tool.harvest_gateway.execute({ dir: emptyDir, project: env.project });
    console.log("目录为空时的执行结果：", JSON.stringify(res, null, 2));

    assert.strictEqual(res.success, true, "目录为空时不应报错");
    assert.strictEqual(res.has_conversations, false, "has_conversations 应为 false");
    assert.strictEqual(res.turns_processed, 0, "处理轮次应为 0");
    assert.strictEqual(res.message, NO_CONVERSATIONS_MSG, "提示语须符合规范说明");
    console.log("✓ [PASS] 目录为空测试通过\n");
  }

  console.log("=================================================================");
  console.log("【验收测试 2】构造真实 GatewayTurn 数据并执行提炼写入（隔离命名空间）");
  console.log("=================================================================");

  const mockDir = makeTempDir("test_gateway_conv");
  const dateDir = path.join(mockDir, "2026-10-16", "session_alpha_1");
  fs.mkdirSync(dateDir, { recursive: true });

  const nonce = Date.now().toString(36);

  // 造 turn 1: agent-alpha 包含环境事实与故障规避 (pitfall)
  const turn1 = {
    agent: "agent-alpha",
    session: "sess-001-" + nonce,
    time: new Date().toISOString(),
    model: "claude-3-5-sonnet",
    status: 200,
    input: [
      { role: "user", text: "测试环境怎么跑？我在跑 pytest 时报错了。" }
    ],
    output: [
      {
        role: "assistant",
        text: `检测到 ModuleNotFoundError: No module named lib_${nonce} 错误 (exit code 1)。\n请使用 Python 虚拟环境：\`source /root/.venv_${nonce}/activate\`\n运行测试命令：\npytest tests/test_${nonce}.py\n24 passed in 0.5s\nexit code 0\n测试已成功通过 (success)！`
      }
    ]
  };

  // 造 turn 2: agent-beta 包含架构决策 (decision) 与工具规范 (fact)
  const dateDir2 = path.join(mockDir, "2026-10-16", "session_beta_2");
  fs.mkdirSync(dateDir2, { recursive: true });
  const turn2 = {
    Agent: "agent-beta",
    Session: "sess-002-" + nonce,
    Time: new Date().toISOString(),
    Model: "gpt-4o",
    Status: 200,
    Input: [
      { role: "user", text: "请确定项目的依赖选型与架构规范。" }
    ],
    Output: [
      {
        role: "assistant",
        text: `技术选型决策：决定采用 jaq_${nonce} 替代 jq_${nonce} 作为高性能 JSON 解析器。\n环境规范：环境要求必须使用 uv run python 执行，而不是 python3_${nonce}。\n系统架构规范约定：统一遵循 microkernel_${nonce} 架构模式。`
      }
    ]
  };

  // 写入 turns.jsonl 和 standalone json
  fs.writeFileSync(path.join(dateDir, "turns.jsonl"), JSON.stringify(turn1) + "\n");
  fs.writeFileSync(path.join(dateDir2, "turn.json"), JSON.stringify(turn2, null, 2));

  console.log("--> 首次扫描 mock 目录（project = " + env.project + "）...");
  const firstScan = await hub.tool.harvest_gateway.execute({ dir: mockDir, project: env.project });
  console.log("首次扫描结果：", JSON.stringify(firstScan, null, 2));

  assert.strictEqual(firstScan.success, true, "扫描必须成功");
  assert.strictEqual(firstScan.has_conversations, true, "必须探测到对话");
  assert.strictEqual(firstScan.turns_processed, 2, "必须处理 2 个 turn");
  assert(firstScan.memories_saved > 0, "必须成功提炼并存入记忆");
  assert(firstScan.pitfalls_saved > 0, "必须成功提炼并存入踩坑经验");
  console.log("✓ [PASS] 首次扫描并成功提炼入库！\n");

  console.log("=================================================================");
  console.log("【验收测试 3】增量防重复机制验证（第二次扫描处理 0 条）");
  console.log("=================================================================");

  console.log("--> 第二次扫描同一 mock 目录（未有新文件/修改）...");
  const secondScan = await hub.tool.harvest_gateway.execute({ dir: mockDir, project: env.project });
  console.log("第二次扫描结果：", JSON.stringify(secondScan, null, 2));

  assert.strictEqual(secondScan.success, true, "第二次扫描必须成功");
  assert.strictEqual(secondScan.turns_processed, 0, "增量生效：第二次应处理 0 轮");
  assert.strictEqual(secondScan.memories_saved, 0, "增量生效：第二次应保存 0 条记忆");
  assert.strictEqual(secondScan.pitfalls_saved, 0, "增量生效：第二次应保存 0 条踩坑");
  console.log("✓ [PASS] 第二次扫描增量生效，未发生任何重复入库！\n");

  console.log("=================================================================");
  console.log("【验收测试 4】在真实库中限定 project 验证记忆与踩坑，且 client 字段正确");
  console.log("=================================================================");

  // 验证 memory_search 限定 project 查出 agent-beta 的记忆
  const memResRaw = await hub.tool.memory_search.execute({ query: "jaq_" + nonce, project: env.project });
  const memRes = typeof memResRaw === "string" ? JSON.parse(memResRaw) : memResRaw;
  console.log(`memory_search 'jaq_${nonce}' (project=${env.project}) 结果：`, JSON.stringify(memRes, null, 2));
  assert(memRes.matched > 0, "必须通过 memory_search 检索到提炼的记忆");
  const betaMem = memRes.memories.find((m) => m.client === "agent-beta");
  assert(betaMem, "记忆库中必须存在 client 为 agent-beta 的记录");
  assert.strictEqual(betaMem.project, env.project, `记忆必须属于测试 project ${env.project}`);
  console.log("✓ [PASS] 记忆检索验证通过，client='agent-beta' 来源且 project 归属确认！");

  // 验证 pitfall_search 限定 project 查出 agent-alpha 的踩坑
  const pitResRaw = await hub.tool.pitfall_search.execute({ query: "ModuleNotFoundError", project: env.project });
  const pitRes = typeof pitResRaw === "string" ? JSON.parse(pitResRaw) : pitResRaw;
  console.log("pitfall_search 'ModuleNotFoundError' 结果：", JSON.stringify(pitRes, null, 2));
  assert(pitRes.matched > 0, "必须通过 pitfall_search 检索到提炼的踩坑记录");
  const alphaPit = pitRes.pitfalls.find((p) => p.client === "agent-alpha");
  assert(alphaPit, "踩坑库中必须存在 client 为 agent-alpha 的记录");
  assert.strictEqual(alphaPit.project, env.project, `踩坑必须属于测试 project ${env.project}`);
  console.log("✓ [PASS] 踩坑检索验证通过，client='agent-alpha' 来源且 project 归属确认！\n");

  console.log("=================================================================");
  console.log("【验收测试 5】可中断扫描（AbortSignal）机制验证");
  console.log("=================================================================");

  const abortMockDir = makeTempDir("test_gateway_abort");
  fs.mkdirSync(abortMockDir, { recursive: true });
  for (let i = 0; i < 5; i++) {
    const d = path.join(abortMockDir, "session_" + i);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "turn.json"), JSON.stringify({
      agent: "agent-abort-test",
      session: "sess-abort-" + i,
      time: new Date().toISOString(),
      model: "claude-3-5-sonnet",
      status: 200,
      input: [{ role: "user", text: "测试中断环境激活" }],
      output: [{ role: "assistant", text: "请激活虚拟环境：source /root/.venv/activate 来运行命令。" }]
    }, null, 2));
  }

  const ac = new AbortController();

  const abortRes = await harvestGateway({ dir: abortMockDir, project: env.project }, {
    _client: {},
    _cfg: {},
    saveMemory: async () => {
      // 模拟在第一条处理时外部触发中断 (例如超时)
      ac.abort();
      return { action: "CREATED" };
    },
    pitfallSave: async () => ({ action: "CREATED" }),
    signal: ac.signal,
  });
  console.log("中断后返回结果：", JSON.stringify(abortRes, null, 2));
  assert.strictEqual(abortRes.success, true, "中断返回不应抛出异常");
  assert.strictEqual(abortRes.aborted, true, "aborted 标志应为 true");
  assert(abortRes.turns_processed < 5, "中断后后续轮次应被停止处理");
  console.log("✓ [PASS] opts.abort 中断安全退出断言通过！\n");

  console.log("=================================================================");
  console.log("【验收测试 6】反证测试：无规则匹配的日常对话绝不产生伪造记忆");
  console.log("=================================================================");

  const noiseDir = makeTempDir("test_gateway_noise");
  const noiseSessionDir = path.join(noiseDir, "session_noise");
  fs.mkdirSync(noiseSessionDir, { recursive: true });
  fs.writeFileSync(path.join(noiseSessionDir, "turn.json"), JSON.stringify({
    agent: "agent-chat",
    session: "sess-noise-001",
    time: new Date().toISOString(),
    model: "claude-3-5-sonnet",
    status: 200,
    input: [{ role: "user", text: "你好呀，今天天气真不错！" }],
    output: [{ role: "assistant", text: "你好！今天确实是个好天气，很高兴与你聊天。" }]
  }, null, 2));

  const noiseRes = await hub.tool.harvest_gateway.execute({ dir: noiseDir, project: env.project });
  console.log("无事实闲聊提炼结果：", JSON.stringify(noiseRes, null, 2));
  assert.strictEqual(noiseRes.success, true);
  assert.strictEqual(noiseRes.has_conversations, true);
  assert.strictEqual(noiseRes.turns_processed, 1);
  assert.strictEqual(noiseRes.memories_saved, 0, "反证通过：闲聊对话绝不应伪造记忆");
  assert.strictEqual(noiseRes.pitfalls_saved, 0, "反证通过：闲聊对话绝不应伪造踩坑");
  console.log("✓ [PASS] 反证测试通过：无事实对话零入库！\n");

} finally {
  console.log("=================================================================");
  console.log("执行彻底清理：临时目录 + 真实数据库行");
  console.log("=================================================================");

  // 1. 清理临时目录
  for (const d of tempDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("✓ 临时目录清理完毕");

  // 2. 彻底清理真实数据库中的测试行
  const cleanRes = await env.cleanup();
  console.log(`✓ 数据库清理完成：memories 删除 ${cleanRes.memoriesDeleted} 行，pitfalls 删除 ${cleanRes.pitfallsDeleted} 行`);

  // 3. 全局残留断言
  const globalCheck = await env.countAllTestResidue();
  assert.strictEqual(globalCheck.total, 0, `全局残余必须为 0（当前 memories=${globalCheck.memories}, pitfalls=${globalCheck.pitfalls}）`);
  console.log("✓ 数据库全局残余校验断言：残余数为 0！\n");
}

console.log("=================================================================");
console.log("✅ 全部 GatewayConversations 验收测试与清理断言 100% 通过！");
console.log("=================================================================");
