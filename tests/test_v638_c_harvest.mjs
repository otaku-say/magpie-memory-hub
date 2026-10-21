/**
 * tests/test_v638_c_harvest.mjs
 * =================================================================
 * v6.38-c 修复后台副作用与离线扫描占位消除双向反证验收套件
 *
 * 1. 【BUG-37-2 后台队列误杀调度器】
 *    - drain 运行前后，打桩监测 stopAuditScheduler 未被调用
 *    - ensureAuditScheduler.started 保持为 true
 *    - 优先复用 options.hub
 *    - 反证门：对照验证调度器显式关闭逻辑正常生效
 * 2. 【BUG-37-2 置信度量纲对齐】
 *    - 传 confidence: 0.82 写入记忆，读回 confidence_score 必须为 82
 *    - 历史遗留仅含 confidence_score: 75 时自动标准化为 75
 *    - 反证门：落库置信度绝不得被重置为默认值 100
 * 3. 【BUG-37-4a 离线扫描占位消除与实体透传】
 *    - 离线提炼无根因的对话，root_cause 绝不得包含「已处置解决」，必须为空串 ""
 *    - 正常有根因与实体的对话，root_cause 与 related_entities 完整保留
 *    - saveMemory 载荷必须透传 related_entities
 * 4. 【测试元规范自检】
 *    - 独立命名空间隔离 + cleanup + residue === 0 残余断言
 *    - scanTestFile 自检 0 违规
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MagpieMemoryHub } from "../tools.js";
import {
  triggerBackgroundDrain,
  processDialogueAndHarvest,
} from "../gateway_harvest.hooks.js";
import { harvestGateway } from "../gateway_harvest.js";
import {
  clearHarvestQueue,
  enqueueHarvestItems,
  readHarvestQueue,
} from "../local_state.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【v6.38-c 后台队列调度器防护、置信度量纲与离线扫描占位消除测试】");
console.log("=================================================================\n");

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log("  ✓ " + msg);
  } else {
    console.error("  ✗ " + msg);
    failures++;
  }
}

// -----------------------------------------------------------------
// 测试隔离基座 (Memory & Pitfall Store + mockDbClient)
// -----------------------------------------------------------------
const testProject = "__test_v638_c_" + Date.now() + "__";
const memoryStore = new Map();
const pitfallStore = new Map();
let nextId = 1000;

const mockDbClient = {
  list: async (table, params) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    const rows = [];
    for (const row of store.values()) {
      if (params && params.project && row.project !== params.project) continue;
      if (params && params.content_fingerprint && row.content_fingerprint !== params.content_fingerprint) continue;
      rows.push({ ...row });
    }
    return { data: rows, rows };
  },
  create: async (table, data) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    const id = nextId++;
    const saved = { ...data, id };
    store.set(id, saved);
    return saved;
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
    const had = store.delete(id);
    return { affectedRows: had ? 1 : 0 };
  },
};

// -----------------------------------------------------------------
// 1. 【BUG-37-2】后台队列误杀调度器防护双向反证
// -----------------------------------------------------------------
console.log("▶ [反证门 1] BUG-37-2 后台异步队列消费不得误杀宿主生产调度器");
{
  // 1.1 前置启动生产去重调度器
  MagpieMemoryHub.stopAuditScheduler();
  await MagpieMemoryHub({ dedup_schedule: "daily" }, { _client: mockDbClient });

  const schedBefore = MagpieMemoryHub.ensureAuditScheduler();
  check(schedBefore && schedBefore.started === true, "前置确认：去重调度器已处于启动状态 (started === true)");

  // 给 stopAuditScheduler 打桩计数，监视非预期调用
  let stopCalls = 0;
  const originalStop = MagpieMemoryHub.stopAuditScheduler;
  MagpieMemoryHub.stopAuditScheduler = () => {
    stopCalls++;
    return originalStop();
  };

  try {
    // 触发后台队列消费（不传 options，模拟 tools.js 内部的 backgroundDrain 调用）
    await triggerBackgroundDrain(mockDbClient);

    check(stopCalls === 0, "【反证】triggerBackgroundDrain 运行期间 stopAuditScheduler 调用次数恒为 0");
    const schedAfter = MagpieMemoryHub.ensureAuditScheduler();
    check(schedAfter && schedAfter.started === true, "【反证】后台消费后生产调度器仍保持启动状态 (started === true)");

    // 1.2 显式透传 options.cfg 的场景
    await triggerBackgroundDrain(mockDbClient, { cfg: { dedup_schedule: "daily" } });
    check(stopCalls === 0, "显式透传 cfg.dedup_schedule 时 stopAuditScheduler 未被调用");

    // 1.3 优先复用 options.hub
    const fakeHub = {
      tool: {
        memory_save: { execute: async () => ({ action: "NOOP", id: 1 }) },
        pitfall_save: { execute: async () => ({ action: "NOOP", id: 2 }) },
      },
    };
    await triggerBackgroundDrain(mockDbClient, { hub: fakeHub });
    check(stopCalls === 0, "传入 options.hub 时直接复用，绝不触发调度器判定逻辑");
  } finally {
    // 恢复打桩
    MagpieMemoryHub.stopAuditScheduler = originalStop;
  }

  // 1.4 对照反证：显式调用 stopAuditScheduler 时调度器正常关闭
  originalStop();
  const schedFinal = MagpieMemoryHub.ensureAuditScheduler();
  check(schedFinal && schedFinal.started === false, "【反证对照】显式调用 stopAuditScheduler 确实会关闭调度器 (started === false)");
}

// -----------------------------------------------------------------
// 2. 【BUG-37-2】置信度量纲对齐与防重置双向反证
// -----------------------------------------------------------------
console.log("\n▶ [反证门 2] BUG-37-2 记忆置信度量纲对齐（严防重置为 100）");
{
  clearHarvestQueue();

  // 2.1 正常提炼入队：传入 0~1 浮点数置信度 (0.82)
  enqueueHarvestItems([{
    id: "hq_m_v638c_float",
    table: "memories",
    project: testProject,
    data: {
      project: testProject,
      title: "架构解耦原则",
      content: "模块间仅通过纯接口通信",
      confidence: 0.82,
      confidence_score: 82,
      client: "agent-v638c",
      source_session: "sess-v638c",
      source_turn: 1,
    },
  }]);

  // 2.2 兼容历史遗留队列数据：仅含 confidence_score: 75（无 confidence 字段）
  enqueueHarvestItems([{
    id: "hq_m_v638c_legacy",
    table: "memories",
    project: testProject,
    data: {
      project: testProject,
      title: "数据库并发控制规范",
      content: "写操作采用乐观锁机制",
      confidence_score: 75,
      client: "agent-v638c",
      source_session: "sess-v638c",
      source_turn: 2,
    },
  }]);

  // 2.3 满分场景：confidence: 1.0
  enqueueHarvestItems([{
    id: "hq_m_v638c_full",
    table: "memories",
    project: testProject,
    data: {
      project: testProject,
      title: "系统安全铁律",
      content: "严禁明文打印密钥",
      confidence: 1.0,
      confidence_score: 100,
      client: "agent-v638c",
      source_session: "sess-v638c",
      source_turn: 3,
    },
  }]);

  // 执行后台队列消费
  const drainRes = await triggerBackgroundDrain(mockDbClient);
  check(drainRes.processed === 3, "3 条置信度测试队列项成功消费并落库");

  const listRes = await mockDbClient.list("memories", { project: testProject });
  const memFloat = listRes.data.find((m) => m.title === "架构解耦原则");
  const memLegacy = listRes.data.find((m) => m.title === "数据库并发控制规范");
  const memFull = listRes.data.find((m) => m.title === "系统安全铁律");

  check(Boolean(memFloat), "0.82 浮点置信度记忆已落库");
  check(memFloat && memFloat.confidence_score === 82, "【反证】confidence: 0.82 落库读回 confidence_score 必须为 82");
  check(memFloat && memFloat.confidence_score !== 100, "【反证】confidence: 0.82 绝不得被重置为默认 100");

  check(Boolean(memLegacy), "历史遗留 confidence_score 记忆已落库");
  check(memLegacy && memLegacy.confidence_score === 75, "【反证】遗留 confidence_score: 75 读回必须保留 75");
  check(memLegacy && memLegacy.confidence_score !== 100, "【反证】遗留 confidence_score: 75 绝不得被重置为默认 100");

  check(Boolean(memFull), "满分置信度记忆已落库");
  check(memFull && memFull.confidence_score === 100, "本意为满分置信度 (1.0) 正常落库为 100");
}

// -----------------------------------------------------------------
// 3. 【BUG-37-4a】离线扫描去除占位根因与实体透传双向反证
// -----------------------------------------------------------------
console.log("\n▶ [反证门 3] BUG-37-4a 离线扫描去除占位根因并透传 related_entities");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test_v638c_gw_"));
  const dateDir = path.join(tmpDir, "2026-10-21", "session_offline_test");
  fs.mkdirSync(dateDir, { recursive: true });

  const turnData = {
    agent: "agent-scanner",
    session: "sess-offline-001",
    time: new Date().toISOString(),
    input: [{ role: "user", text: "避坑：环境构建报错与数据库连接异常排障" }],
    output: [{ role: "assistant", text: "已排查修复相关依赖配置" }],
  };
  fs.writeFileSync(path.join(dateDir, "turn_001.json"), JSON.stringify(turnData), "utf8");

  const capturedMemories = [];
  const capturedPitfalls = [];

  const mockSaveMemory = async (client, cfg, data, ctx) => {
    capturedMemories.push(data);
    return { id: nextId++, action: "ADD" };
  };

  const mockPitfallSave = async (client, cfg, data, ctx) => {
    capturedPitfalls.push(data);
    return { id: nextId++, action: "ADD" };
  };

  // 构造模拟在线提炼响应：
  // 1. 无根因踩坑（未提供 root_cause）
  // 2. 正常包含真实根因与相关实体的踩坑
  // 3. 正常包含相关实体的记忆
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify([
            {
              category: "pitfall",
              title: "ModuleNotFoundError 报错处理",
              content: "激活虚拟环境 source /venv/bin/activate",
              symptom: "ModuleNotFoundError 报错处理",
              solution: "source /venv/bin/activate",
              tags: "python,venv",
              // 故意缺失 root_cause 与 related_entities
            },
            {
              category: "pitfall",
              title: "PortBindException 端口占用",
              content: "更改容器映射端口至 8081",
              symptom: "listen tcp :8080: bind: address already in use",
              root_cause: "宿主机已有守护进程占用 8080 端口",
              solution: "docker run -p 8081:8080",
              tags: "docker,port",
              related_entities: "Docker,Linux",
            },
            {
              category: "fact",
              title: "消息队列中间件选型",
              content: "生产高吞吐链路统一采用 Kafka 集群",
              tags: "mq,kafka",
              related_entities: "Apache Kafka,Zookeeper",
            },
          ]),
        },
      }],
    }),
  });

  const scanResult = await harvestGateway({
    dir: tmpDir,
    project: testProject,
    extract_model: "mock-model",
    classify_model: "off",
    min_evidence_pitfall: 1,
    min_evidence_memory: 1,
    _fetch: mockFetch,
  }, {
    client: mockDbClient,
    cfg: {},
    saveMemory: mockSaveMemory,
    pitfallSave: mockPitfallSave,
  });

  check(scanResult.success === true, "harvestGateway 执行成功");
  check(capturedPitfalls.length === 2, "捕获到 2 条踩坑提炼入库");
  check(capturedMemories.length === 1, "捕获到 1 条记忆提炼入库");

  // 3.1 无根因踩坑反证
  const noCausePitfall = capturedPitfalls.find((p) => p.symptom === "ModuleNotFoundError 报错处理");
  check(Boolean(noCausePitfall), "无根因踩坑项已捕获");
  check(noCausePitfall && !noCausePitfall.root_cause.includes("已处置解决"),
    "【反证】无根因踩坑 root_cause 绝不得包含「已处置解决」占位文案");
  check(noCausePitfall && noCausePitfall.root_cause === "",
    "【反证】无根因踩坑 root_cause 必须为空字符串（留待后续自演进）");
  check(noCausePitfall && noCausePitfall.related_entities === "",
    "未提供相关实体时 related_entities 为空字符串");

  // 3.2 正常有根因踩坑正向与反证
  const withCausePitfall = capturedPitfalls.find((p) => p.symptom === "listen tcp :8080: bind: address already in use");
  check(Boolean(withCausePitfall), "真实有根因踩坑项已捕获");
  check(withCausePitfall && withCausePitfall.root_cause === "宿主机已有守护进程占用 8080 端口",
    "正常提供根因的对话必须正确写入真实 root_cause");
  check(withCausePitfall && withCausePitfall.related_entities === "Docker,Linux",
    "踩坑的 related_entities 实体信息完整透传");

  // 3.3 记忆相关实体正向与反证
  const mqMemory = capturedMemories.find((m) => m.title === "消息队列中间件选型");
  check(Boolean(mqMemory), "记忆提炼项已捕获");
  check(mqMemory && mqMemory.related_entities === "Apache Kafka,Zookeeper",
    "saveMemory 载荷成功透传 related_entities（反证：旧代码会遗漏该字段）");

  // 清理临时目录
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    if (err && err.code !== "ENOENT") console.error("tmp cleanup:", err);
  }
}

// -----------------------------------------------------------------
// 4. 清理与全局残余断言 (Cleanup & Zero Residue Assert)
// -----------------------------------------------------------------
console.log("\n▶ [隔离清理] 执行测试数据清理并断言残余为 0...");
async function cleanup() {
  const mems = await mockDbClient.list("memories", { project: testProject });
  for (const m of mems.data) {
    await mockDbClient.remove("memories", m.id);
  }
  const pits = await mockDbClient.list("pitfalls", { project: testProject });
  for (const p of pits.data) {
    await mockDbClient.remove("pitfalls", p.id);
  }
  clearHarvestQueue();
}

await cleanup();

const finalMems = await mockDbClient.list("memories", { project: testProject });
const finalPits = await mockDbClient.list("pitfalls", { project: testProject });
const totalResidue = finalMems.data.length + finalPits.data.length;

assert.strictEqual(totalResidue, 0, `残余断言失败：预期 0，实得 ${totalResidue}`);
check(totalResidue === 0, "测试后数据残余校验断言：residue === 0");

// -----------------------------------------------------------------
// 5. 元检查规范自检 (scanTestFile)
// -----------------------------------------------------------------
console.log("\n▶ [自检] test_meta 规范合规性自检...");
{
  const selfPath = fileURLToPath(import.meta.url);
  const selfContent = fs.readFileSync(selfPath, "utf8");
  const scanRes = scanTestFile(selfPath, selfContent);
  if (scanRes.issues.length > 0) {
    for (const is of scanRes.issues) {
      console.error("   - " + is);
    }
  }
  assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 0 规范违规");
  check(scanRes.issues.length === 0, "test_meta 自检 0 违规");
}

console.log("\n=================================================================");
if (failures > 0) {
  console.error(`❌ 共 ${failures} 项断言失败`);
  process.exit(1);
}
console.log("✅ v6.38-c 全部反证门 100% 通过！");
console.log("=================================================================");
