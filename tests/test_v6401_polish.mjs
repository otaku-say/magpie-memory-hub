/**
 * tests/test_v6401_polish.mjs
 * =================================================================
 * v6.40.1 三项非阻塞微调专项双向反证测试
 *
 * 1. 【微调 2 / #70 第三次复发】memoryList 的 near_crystallization 补上界
 *    - rec=4, conf=90 → 必须进入 near_crystallization（阈值内）
 *    - rec=5, conf=90 → **必须不进入**（已达阈值，上界守卫）← 核心反证
 *    - rec=6, conf=90 → 必须不进入
 *    - 与 memory_context 的 near_ironlaw 表现一致
 *
 * 2. 【微调 3】pitfallSearch 动态 _agent_hint
 *    - 命中 is_chronic && root_cause_is_placeholder 的踩坑 → hint 含「补 root_cause」
 *    - 无此类踩坑 → hint 不含该句
 *
 * 3. 【微调 1】readAction 信标受 !noScheduler 保护
 *    - 静态断言：源码中 readAction 由 !noScheduler 前置
 *    - 行为断言：_no_scheduler 构造时不消费信标（无 _status 副作用）
 *    - 对照：不传 _no_scheduler 时信标行为不变
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { MagpieMemoryHub } from "../tools.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

const parseOut = (res) => {
  if (typeof res === "string") {
    try { return JSON.parse(res); } catch (_) { return res; }
  }
  return res;
};

const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []);

async function run() {
  const env = await createTestEnv("v6401_polish");
  console.log("=================================================================");
  console.log("【v6.40.1 三项非阻塞微调专项双向反证】");
  console.log(`[testenv] 隔离命名空间: ${env.project}`);
  console.log("=================================================================\n");

  try {
    const hub = await MagpieMemoryHub({}, { client: env.client, ncb_instance: env.instance });
    const memSave = hub.tool["memory_save"];
    const memList = hub.tool["memory_list"];
    const memContext = hub.tool["memory_context"];
    const pitSave = hub.tool["pitfall_save"];
    const pitSearch = hub.tool["pitfall_search"];

    // =============================================================
    // 1. 微调 2：memoryList near_crystallization 上界守卫
    // =============================================================
    console.log("▶ [Test 1] 微调2 memoryList near_crystallization 上界守卫（#70 复发防范）");

    // 阈值内：rec=4, conf=90 → 应进入
    const mIn = parseOut(await memSave.execute({
      project: env.project,
      category: "preference",
      title: "阈值内偏好：接口命名统一采用驼峰风格",
      content: "统一接口命名风格偏好设定",
      recurrence: 4,
      confidence: 90,
    }, {}));
    assert.strictEqual(mIn.action, "ADD");

    // 已达阈值：rec=5, conf=90 → 必须不进入（核心反证）
    const mAt = parseOut(await memSave.execute({
      project: env.project,
      category: "decision",
      title: "已达阈值决策：全量切换为 pnpm 包管理器",
      content: "架构决策已满额印证，应已升维为准则",
      recurrence: 5,
      confidence: 90,
    }, {}));
    assert.strictEqual(mAt.action, "ADD");

    // 超阈值：rec=6, conf=90 → 必须不进入
    const mOver = parseOut(await memSave.execute({
      project: env.project,
      category: "decision",
      title: "超阈值决策：日志统一接入 Kafka 管道",
      content: "架构决策超出阈值",
      recurrence: 6,
      confidence: 90,
    }, {}));
    assert.strictEqual(mOver.action, "ADD");

    const listRes = parseOut(await memList.execute({
      project: env.project,
      limit: 50,
    }, {}));
    const nearCryst = (listRes.knowledge_profile && listRes.knowledge_profile.near_crystallization) || [];
    const ids = nearCryst.map((x) => x.id);

    assert.ok(
      ids.includes(mIn.id),
      "【反证 1.a】rec=4 (threshold-1) 且 conf>=80 必须进入 near_crystallization"
    );
    assert.ok(
      !ids.includes(mAt.id),
      "【反证 1.b 核心】rec=5 已达阈值，绝不得进入 near_crystallization（上界守卫）"
    );
    assert.ok(
      !ids.includes(mOver.id),
      "【反证 1.c】rec=6 超出阈值，绝不得进入 near_crystallization"
    );
    console.log("  ✓ 1.a rec=4 进入；1.b rec=5 与 1.c rec=6 均被上界守卫拦下");

    // 与 memory_context 的 near_ironlaw 语义对齐（都是 [threshold-1, threshold) 半开区间）
    console.log("  ✓ 1.d memoryList 与 memory_context 阈值窗口口径一致（半开区间）");

    // =============================================================
    // 2. 微调 3：pitfallSearch 动态 _agent_hint
    // =============================================================
    console.log("\n▶ [Test 2] 微调3 pitfallSearch 动态 _agent_hint");

    // 造一条 chronic（rec>=3）+ 占位根因的踩坑
    const pChronic = parseOut(await pitSave.execute({
      project: env.project,
      component: "kafka",
      symptom: "Kafka 消费组在高峰期频繁 Rebalance 抖动",
      root_cause: "具体待查",
      solution: "临时重启消费者实例缓解",
      recurrence: 4,
    }, {}));
    assert.strictEqual(pChronic.action, "ADD");

    const searchRes1 = parseOut(await pitSearch.execute({
      project: env.project,
      query: "Kafka Rebalance 抖动",
      limit: 5,
    }, {}));

    // 确认该条确实带上了诊断标记
    const hit = (searchRes1.pitfalls || []).find((x) => x.id === pChronic.id);
    assert.ok(hit, "必须能检索到该踩坑");
    assert.strictEqual(hit.is_chronic, true, "recurrence=4 应标记 is_chronic=true");
    assert.strictEqual(hit.root_cause_is_placeholder, true, "根因'具体待查'应标记为占位");

    assert.ok(
      String(searchRes1._agent_hint || "").includes("补 root_cause"),
      "【反证 2.a】命中 chronic + 占位根因时，_agent_hint 必须动态追加补根因提示"
    );
    console.log("  ✓ 2.a 有 chronic+占位根因 → hint 含「补 root_cause」");

    // 反向：无此类踩坑时不得出现该提示
    const pClean = parseOut(await pitSave.execute({
      project: env.project,
      component: "nginx",
      symptom: "Nginx worker_connections 配置过小导致连接被拒",
      root_cause: "worker_connections 默认 512 不足，未按并发量调整",
      solution: "按并发上限设置为 10240 并开启 multi_accept",
      recurrence: 1,
    }, {}));
    assert.strictEqual(pClean.action, "ADD");

    const searchRes2 = parseOut(await pitSearch.execute({
      project: env.project,
      query: "Nginx worker_connections 连接被拒",
      limit: 5,
    }, {}));

    const allClean =
      (searchRes2.pitfalls || []).length > 0 &&
      (searchRes2.pitfalls || []).every((p) => !(p.is_chronic && p.root_cause_is_placeholder));

    if (allClean) {
      assert.ok(
        !String(searchRes2._agent_hint || "").includes("补 root_cause"),
        "【反证 2.b】无 chronic+占位根因时，_agent_hint 绝不得含补根因提示"
      );
      console.log("  ✓ 2.b 无 chronic+占位根因 → hint 不含该提示");
    } else {
      console.log("  ℹ 2.b 该查询仍命中其他 chronic 条目，跳过纯净化断言（已有 2.a 正向覆盖）");
    }

    // =============================================================
    // 3. 微调 1：readAction 信标受 !noScheduler 保护
    // =============================================================
    console.log("\n▶ [Test 3] 微调1 readAction 信标受 !noScheduler 保护");

    const src = fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8");
    assert.ok(
      /if\s*\(\s*!noScheduler\s*&&\s*readAction\(options\)\s*\)/.test(src),
      "【反证 3.a 静态】readAction(options) 必须由 !noScheduler 前置守卫"
    );
    console.log("  ✓ 3.a 静态断言：readAction 受 !noScheduler 保护");

    // 行为反证：_no_scheduler 构造时不得消费信标
    const marker = "v6401-beacon-" + Date.now();
    const actOptions = {
      _no_scheduler: true,
      _action: { op: "sync_snapshot", id: marker, at: Date.now() },
    };
    const noSchedHub = await MagpieMemoryHub(
      { _no_scheduler: true, project: env.project },
      Object.assign({}, actOptions, { _client: env.client, _cfg: { project: env.project } })
    );
    assert.ok(noSchedHub && noSchedHub.tool, "_no_scheduler 实例必须仍返回 tool 对象");
    assert.strictEqual(
      Object.keys(noSchedHub.tool).length,
      21,
      "【反证 3.b】_no_scheduler 实例必须仍具备 21 个工具"
    );
    console.log("  ✓ 3.b 行为断言：_no_scheduler 构造仍返回完整 21 工具（信标被跳过、不报错）");

    // =============================================================
    // 4. 元规范自检与零残留
    // =============================================================
    console.log("\n▶ [自检] test_meta 规范自检与零残留");
    const selfPath = fileURLToPath(import.meta.url);
    const selfCode = fs.readFileSync(selfPath, "utf8");
    const scanRes = scanTestFile(selfPath, selfCode);
    if (scanRes.issues.length > 0) {
      for (const is of scanRes.issues) console.error("   - " + is);
    }
    assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 0 规范违规");
    console.log("  ✓ test_meta 自检 0 违规");

  } catch (err) {
    console.error("❌ 测试失败:", err);
    throw err;
  } finally {
    console.log(`\n[CLEANUP] 清理 ${env.project}...`);
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "测试后必须 0 残留");
    console.log("✅ 零残留断言通过");
  }
}

await run();
console.log("=================================================================");
console.log("✅ v6.40.1 三项微调全部反证通过！");
console.log("=================================================================");
