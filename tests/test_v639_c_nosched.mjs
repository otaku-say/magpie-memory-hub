/**
 * tests/test_v639_c_nosched.mjs
 * =================================================================
 * v6.39-c 增加 _no_scheduler 隔离标记根治后台 drain 覆写宿主调度器配置
 *
 * 1. 【反证门 a：宿主配置防覆写与防误停】
 *    - 先 ensureAuditScheduler({dedup_schedule:"daily"}) 启动
 *    - 记录 getFreshCfg().dedup_schedule 为 "daily"
 *    - 传入 _no_scheduler: true 构造临时 hub（模拟 drain）
 *    - 反证断言：getFreshCfg().dedup_schedule 仍是 "daily"（未被覆写），started 仍为 true（未被 stop）
 * 2. 【反证门 b：临时 Hub 工具功能完整可用】
 *    - _no_scheduler: true 构造的实例拥有可用的 tool["memory_save"] 与 tool["pitfall_save"]
 *    - 功能完整不受影响，写库操作正常完成
 * 3. 【反证门 c：主路径无回归】
 *    - 不传 _no_scheduler 时行为完全不变（正常调度器管理仍生效）
 *    - 反证对照：普通构造传 off 会正常 stop 调度器，传 weekly 会正常更新配置
 * 4. 【反证门 d：drain 端队列非空宿主 getter 防覆写】
 *    - 宿主注册 liveGetter 闭包
 *    - 队列非空时触发 triggerBackgroundDrain（内部调用 getHub 构造临时实例）
 *    - 消费后动态修改宿主配置（如 dedup_time、project）
 *    - 反证断言：getFreshCfg() 依然能感知最新修改，全局 _auditOptionsGetter 绝未被后台临时实例覆写
 * 5. 【元检查规范自检】
 *    - 独立命名空间隔离 + mockDbClient + memoryStore
 *    - cleanup 清理逻辑 + residue === 0 零残余断言
 *    - scanTestFile 自检 0 违规
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MagpieMemoryHub } from "../tools.js";
import { triggerBackgroundDrain } from "../gateway_harvest.hooks.js";
import {
  clearHarvestQueue,
  enqueueHarvestItems,
} from "../src/core/state.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【v6.39-c _no_scheduler 隔离标记防调度器覆写双向反证测试】");
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
const testProject = "__test_v639_c_" + Date.now() + "__";
const memoryStore = new Map();
const pitfallStore = new Map();
let nextId = 2000;

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
// 1. 【反证门 a】宿主配置防覆写与防误停
// -----------------------------------------------------------------
console.log("▶ [反证门 a] 先 ensureAuditScheduler 启动，验证 _no_scheduler 不覆写不误停");
{
  MagpieMemoryHub.stopAuditScheduler();

  // 1.1 先 ensureAuditScheduler({dedup_schedule:"daily"}) 启动
  const hostSched = MagpieMemoryHub.ensureAuditScheduler({
    dedup_schedule: "daily",
    project: testProject,
  });
  check(hostSched && hostSched.started === true, "宿主去重调度器成功启动 (started === true)");
  check(hostSched && hostSched.getFreshCfg().dedup_schedule === "daily", "宿主排期配置确认已生效 (dedup_schedule === daily)");

  // 给 stopAuditScheduler 打桩监测非预期停止
  let stopCalls = 0;
  const origStop = MagpieMemoryHub.stopAuditScheduler;
  MagpieMemoryHub.stopAuditScheduler = () => {
    stopCalls++;
    return origStop();
  };

  try {
    // 1.2 用 _no_scheduler: true 构造临时 hub（模拟 drain 实例，传入默认或无排期配置）
    const drainHub = await MagpieMemoryHub(
      { _no_scheduler: true, project: testProject },
      { _no_scheduler: true, _client: mockDbClient, _cfg: { project: testProject } }
    );

    check(Boolean(drainHub), "_no_scheduler: true 临时 hub 构造成功");
    check(stopCalls === 0, "【反证】构造 _no_scheduler hub 期间 stopAuditScheduler 未被调用（调用次数恒为 0）");

    // 1.3 断言宿主状态未受任何影响
    const schedAfter = MagpieMemoryHub.ensureAuditScheduler();
    check(schedAfter && schedAfter.started === true, "【反证】构造后宿主调度器 started 仍为 true（未被误 stop）");
    check(schedAfter && schedAfter.getFreshCfg().dedup_schedule === "daily", "【反证】宿主 getFreshCfg().dedup_schedule 仍为 daily（未被覆写）");
  } finally {
    MagpieMemoryHub.stopAuditScheduler = origStop;
  }
}

// -----------------------------------------------------------------
// 2. 【反证门 b】_no_scheduler 临时 Hub 工具功能完整可用
// -----------------------------------------------------------------
console.log("\n▶ [反证门 b] 验证 _no_scheduler 构造的 hub 具备完整可用的工具能力");
{
  const drainHub = await MagpieMemoryHub(
    { _no_scheduler: true, project: testProject },
    { _no_scheduler: true, _client: mockDbClient, _cfg: { project: testProject } }
  );

  check(Boolean(drainHub && drainHub.tool), "实例完整暴露 tool 对象");
  check(typeof drainHub.tool.memory_save?.execute === "function", "tool['memory_save'] 可用");
  check(typeof drainHub.tool.pitfall_save?.execute === "function", "tool['pitfall_save'] 可用");

  // 执行真实写入以验证工具功能完好
  const memWriteResRaw = await drainHub.tool.memory_save.execute({
    project: testProject,
    title: "测试 v639-c 隔离记忆写入",
    content: "验证 _no_scheduler 隔离实例下 memory_save 写入链路完整",
    category: "decision",
  });
  const memWriteRes = typeof memWriteResRaw === "string" ? JSON.parse(memWriteResRaw) : memWriteResRaw;
  check(Boolean(memWriteRes && (memWriteRes.id || memWriteRes.action)), "memory_save 写入成功执行");

  const pitWriteResRaw = await drainHub.tool.pitfall_save.execute({
    project: testProject,
    symptom: "测试 v639-c 隔离踩坑写入",
    solution: "验证 _no_scheduler 隔离实例下 pitfall_save 写入链路完整",
  });
  const pitWriteRes = typeof pitWriteResRaw === "string" ? JSON.parse(pitWriteResRaw) : pitWriteResRaw;
  check(Boolean(pitWriteRes && (pitWriteRes.id || pitWriteRes.action)), "pitfall_save 写入成功执行");
}

// -----------------------------------------------------------------
// 3. 【反证门 c】不传 _no_scheduler 时主路径行为完全不变
// -----------------------------------------------------------------
console.log("\n▶ [反证门 c] 验证不传 _no_scheduler 时正常调度器生命周期管理仍生效");
{
  // 3.1 正常传入 dedup_schedule: "weekly" 启动调度器并覆写配置
  await MagpieMemoryHub(
    { dedup_schedule: "weekly", project: testProject },
    { _client: mockDbClient, dedup_schedule: "weekly" }
  );
  const schedWeekly = MagpieMemoryHub.ensureAuditScheduler();
  check(schedWeekly && schedWeekly.started === true, "未传 _no_scheduler 时传入 weekly 正常标记调度器启动");
  check(schedWeekly && schedWeekly.getFreshCfg().dedup_schedule === "weekly", "未传 _no_scheduler 时配置正常更新为 weekly");

  // 3.2 对照反证：不传 _no_scheduler 时传入 off 必须正常触发 stopAuditScheduler
  await MagpieMemoryHub(
    { dedup_schedule: "off", project: testProject },
    { _client: mockDbClient, dedup_schedule: "off" }
  );
  const schedOff = MagpieMemoryHub.ensureAuditScheduler();
  check(schedOff && schedOff.started === false, "【反证对照】未传 _no_scheduler 且 dedup_schedule=off 时正常关闭调度器 (started === false)");
}

// -----------------------------------------------------------------
// 4. 【反证门 d】drain 端真实队列消费链路宿主 getter 防覆写
// -----------------------------------------------------------------
console.log("\n▶ [反证门 d] 真实 triggerBackgroundDrain 队列消费链路宿主 getter 防覆写反证");
{
  // 4.1 宿主启动生产去重调度器，并挂载可动态修改的 liveConfig 闭包
  MagpieMemoryHub.stopAuditScheduler();

  const hostLiveState = {
    dedup_schedule: "daily",
    dedup_time: "03:00",
    project: testProject,
  };
  const liveGetter = () => ({ ...hostLiveState });
  MagpieMemoryHub.ensureAuditScheduler(mockDbClient, hostLiveState, liveGetter);

  const initFresh = MagpieMemoryHub.ensureAuditScheduler().getFreshCfg();
  check(initFresh.dedup_time === "03:00", "宿主 liveGetter 初始配置确认生效 (dedup_time === 03:00)");

  // 4.2 队列非空时触发真实 triggerBackgroundDrain（触发 getHub 构造临时实例）
  clearHarvestQueue();
  enqueueHarvestItems([
    {
      id: "hq_m_v639c_drain_mem",
      table: "memories",
      project: testProject,
      data: {
        title: "v639-c 后台消费项",
        content: "测试后台消费过程绝不污染宿主 liveGetter",
        confidence: 0.85,
      },
    },
    {
      id: "hq_p_v639c_drain_pit",
      table: "pitfalls",
      project: testProject,
      data: {
        symptom: "v639-c 后台踩坑消费项",
        solution: "测试后台消费踩坑项绝不污染宿主 liveGetter",
      },
    },
  ]);

  // 调用真实 triggerBackgroundDrain（不传 options.hub，不传 options.saveMemory，强制走内部 getHub 路径）
  const drainResult = await triggerBackgroundDrain(mockDbClient);
  check(drainResult.memoriesSaved >= 1 || drainResult.processed >= 1, "triggerBackgroundDrain 成功消费队列数据");

  // 4.3 消费后动态修改宿主 liveState（模拟用户在设置页修改时间与项目）
  hostLiveState.dedup_time = "04:30";
  hostLiveState.project = testProject + "_dynamic_switch";

  // 4.4 反证断言：宿主 getter 未被后台临时实例覆写，动态更新立即可感知！
  const refreshedHostCfg = MagpieMemoryHub.ensureAuditScheduler().getFreshCfg();
  check(refreshedHostCfg.dedup_time === "04:30", "【反证】后台 drain 消费后，宿主动态修改 dedup_time 即时生效（未被后台临时快照覆写）");
  check(refreshedHostCfg.project === testProject + "_dynamic_switch", "【反证】后台 drain 消费后，宿主动态修改 project 即时生效（未被后台临时快照覆写）");
  check(refreshedHostCfg.dedup_schedule === "daily", "【反证】宿主 dedup_schedule 仍保持 daily（未被关停）");
  check(MagpieMemoryHub.ensureAuditScheduler().started === true, "【反证】后台消费后宿主调度器仍处于 started 状态");
}

// -----------------------------------------------------------------
// 5. 清理与数据残余断言 (Cleanup & Zero Residue Assert)
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
  MagpieMemoryHub.stopAuditScheduler();
}

await cleanup();

const finalMems = await mockDbClient.list("memories", { project: testProject });
const finalPits = await mockDbClient.list("pitfalls", { project: testProject });
const totalResidue = finalMems.data.length + finalPits.data.length;

assert.strictEqual(totalResidue, 0, `残余断言失败：预期 0，实得 ${totalResidue}`);
check(totalResidue === 0, "测试后数据残余校验断言：residue === 0");

// -----------------------------------------------------------------
// 6. 元检查规范自检 (scanTestFile)
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
console.log("✅ v6.39-c 全部反证门 100% 通过！");
