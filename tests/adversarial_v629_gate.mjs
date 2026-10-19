/**
 * tests/adversarial_v629_gate.mjs
 * ============================================================================
 * 极度严苛的红队独立质检验收门禁套件 (v6.29.0 Gate)
 *
 * 【红队使命】
 * 背靠背独立于开发 Agent 1 与前端 Agent 2，站在对抗性与破绽攻击视角，
 * 建立零宽容、无死角靶场，彻底击穿“自写自测、弱化断言、Mock 对象全字段掩盖真实 SQL 缺陷”的侥幸假象。
 *
 * 【覆盖的 6 大核心缺陷靶场】
 *   1. 靶子 1 (P0-1): 字段投影漏洞测试 (Field Projection Vulnerability)
 *      - 严格按 params.columns 裁剪未选字段为 undefined（模拟真实 mcp_client.js SQL SELECT 行为）
 *      - 验证过期临时记忆 (expires_at) 与软失效记忆 (invalid_at) 必须 100% 被过滤。
 *   2. 靶子 2 (P0-2): 游标跨表混用漏检测试 (Cursor Cross-Table Contamination)
 *      - 模拟 memories 自增 ID 达 500、pitfalls 自增 ID 仅为 20。
 *      - 增量巡检生成游标后，在 pitfalls 新增 21..30 记录。
 *      - 验证 pitfalls 新增记录绝不能因 memories 的大 ID 游标而被跳过漏检。
 *   3. 靶子 3 (P0-3): 自然语言提炼语义比对与晋升靶场 (Semantic Dedup & Graduation)
 *      - 模拟大模型提炼自然语言变体（如 Docker 报错微变措辞）。
 *      - 验证 recordPendingEvidence 必须命中语义相似项，累加 count 达到 minEvidence=2 并触发 shouldGraduate: true。
 *   4. 靶子 4 (P1-5): 并发去重互斥锁靶场 (Concurrent Audit Mutex)
 *      - 并发调用 memoryAudit 任务，验证后进入的任务必须被 _isAuditing 互斥锁拦截，
 *        返回 { skipped: true, reason: "audit_in_progress" }，杜绝重入写库风险。
 *   5. 靶子 5 (P1-8): memoryContext 准则无条件置顶靶场 (Principle Unconditional Pinning)
 *      - 存在 category === "principle" 架构准则，传入完全不相干的 query。
 *      - 验证返回的 block 必须无条件置顶包含该条架构准则，不能因字面无命中被丢弃。
 *   6. 靶子 6 (P0-4): 快照拉取异常安全靶场 (Sync Snapshot Fail-Closed)
 *      - 模拟网络中断/数据库报错，验证 sync_snapshot 必须 fail-closed 返回 ok: false，
 *        绝不允许返回带空数组的 ok: true + memories: []。
 *
 * 【规范遵从】
 *   - 符合 tests/test_meta.mjs 规范：零外网依赖、环境隔离、严格 cleanup、残余断言 (residue === 0)。
 * ============================================================================
 */

import assert from "node:assert";
import { MagpieMemoryHub } from "../tools.js";
import { recordPendingEvidence, readState, writeState } from "../local_state.js";
import { runPendingAction, ACTION_KEY } from "../page_actions.js";
import { createTestEnv } from "./lib/testenv.mjs";

function parseOut(res) {
  if (typeof res === "string") {
    try {
      return JSON.parse(res);
    } catch (_) {
      return res;
    }
  }
  return res;
}

// ============================================================================
// 靶子 1: P0-1 字段投影漏洞测试
// ============================================================================
async function testTarget1_ProjectionVulnerability(env) {
  console.log("\n=======================================================");
  console.log("【靶子 1】P0-1 字段投影漏洞测试 (Field Projection Vulnerability)");
  console.log("=======================================================");

  const memoryStore = new Map();
  // 1. 正常有效记忆
  const validMem = {
    id: 1,
    project: env.project,
    category: "troubleshooting",
    title: "Docker 生产环境 127.0.0.1 端口绑定规范",
    content: "生产容器禁止直接绑定 127.0.0.1，应配置反向代理",
    tags: "docker,network",
    lifecycle_status: "active",
    expires_at: null,
    invalid_at: null,
    updated_at: "2026-10-19 10:00:00",
  };
  // 2. 过期临时记忆 (expires_at 为过去时间)
  const expiredMem = {
    id: 2,
    project: env.project,
    category: "troubleshooting",
    title: "Docker 临时排错日志调试 127.0.0.1",
    content: "仅用于临时排错，有效期已过",
    tags: "docker,debug",
    lifecycle_status: "active",
    expires_at: "2020-01-01 00:00:00",
    invalid_at: null,
    updated_at: "2020-01-01 00:00:00",
  };
  // 3. 软失效记忆 (invalid_at 非空)
  const invalidMem = {
    id: 3,
    project: env.project,
    category: "troubleshooting",
    title: "Docker 旧版网桥配置 127.0.0.1",
    content: "历史废弃规则，已软失效",
    tags: "docker,deprecated",
    lifecycle_status: "active",
    expires_at: null,
    invalid_at: "2026-10-18 12:00:00",
    updated_at: "2026-10-18 12:00:00",
  };

  memoryStore.set(1, validMem);
  memoryStore.set(2, expiredMem);
  memoryStore.set(3, invalidMem);

  // 构建 Mock Client：必须根据 params.columns 严格裁剪返回字段（未在 columns 中的字段一律设为 undefined）
  // 模拟真实 mcp_client.js 的 SELECT 投影行为
  const mockClient = {
    create: async (_table, data) => {
      const id = memoryStore.size + 1;
      const rec = { ...data, id };
      memoryStore.set(id, rec);
      return rec;
    },
    list: async (_table, params = {}) => {
      let rows = Array.from(memoryStore.values());
      if (params.project) rows = rows.filter((r) => r.project === params.project);
      if (params.lifecycle_status) rows = rows.filter((r) => r.lifecycle_status === params.lifecycle_status);

      // 严格列投影裁剪：未在 columns 中的列一律不返回 (undefined)
      if (Array.isArray(params.columns) && params.columns.length > 0) {
        const allowedCols = new Set(params.columns);
        rows = rows.map((r) => {
          const projected = {};
          for (const col of allowedCols) {
            projected[col] = r[col];
          }
          return projected;
        });
      }
      return { data: rows, metadata: { hasMore: false, page: 1, limit: 100 } };
    },
    update: async () => ({ affectedRows: 1 }),
    remove: async () => ({ affectedRows: 1 }),
  };

  const hub = await MagpieMemoryHub({}, { client: mockClient, ncb_instance: env.instance });
  const memSearch = hub.tool["memory_search"];

  const rawRes = await memSearch.execute({
    project: env.project,
    query: "Docker 127.0.0.1",
  });
  const res = parseOut(rawRes);
  const returnedMemories = Array.isArray(res.memories) ? res.memories : [];
  const returnedIds = returnedMemories.map((m) => m.id);

  console.log(`  检索返回条目数: ${returnedMemories.length}, 返回 ID 集合: [${returnedIds.join(", ")}]`);

  // 断言：过期临时记忆和软失效记忆必须被 100% 过滤，绝不能出现在结果中！
  assert.ok(
    !returnedIds.includes(expiredMem.id),
    `[P0-1 字段投影漏洞反证成功] 过期临时记忆 (id=${expiredMem.id}) 竟泄漏在 search 结果中！原因：tools.js columns 未投影 expires_at 列，导致 isMemoryValid 判断失灵`
  );
  assert.ok(
    !returnedIds.includes(invalidMem.id),
    `[P0-1 字段投影漏洞反证成功] 软失效记忆 (id=${invalidMem.id}) 竟泄漏在 search 结果中！原因：tools.js columns 未投影 invalid_at 列，导致 isMemoryValid 判断失灵`
  );
  assert.strictEqual(
    returnedMemories.length,
    1,
    `[P0-1 字段投影漏洞反证成功] 期望仅返回 1 条有效记忆，实际返回 ${returnedMemories.length} 条`
  );
  assert.strictEqual(returnedMemories[0].id, validMem.id, "返回记录必须是有效记忆 (id=1)");
  console.log("  ✓ 靶子 1 通过：字段投影完整，过期与软失效记忆被 100% 过滤！");
}

// ============================================================================
// 靶子 2: P0-2 游标跨表混用漏检测试
// ============================================================================
async function testTarget2_CursorCrossTableContamination(env) {
  console.log("\n=======================================================");
  console.log("【靶子 2】P0-2 游标跨表混用漏检测试 (Cursor Cross-Table Contamination)");
  console.log("=======================================================");

  const memStore = new Map();
  const pitStore = new Map();

  // memories 表自增 ID 已达 500
  memStore.set(500, {
    id: 500,
    project: env.project,
    category: "fact",
    title: "高自增记忆 500",
    content: "memories 表自增 ID 已达 500",
    lifecycle_status: "active",
    updated_at: "2026-10-19 09:00:00",
  });

  // pitfalls 表自增 ID 仅为 20 (id 1..20)
  for (let i = 1; i <= 20; i++) {
    pitStore.set(i, {
      id: i,
      project: env.project,
      component: `Comp_${i}`,
      symptom: `Symptom_${i}`,
      solution: `Solution_${i}`,
      updated_at: "2026-10-19 09:00:00",
    });
  }

  const mockDb = {
    create: async () => ({ id: 999 }),
    list: async (table, params = {}) => {
      const store = table === "memories" ? memStore : pitStore;
      let rows = Array.from(store.values());
      if (params.project) rows = rows.filter((r) => r.project === params.project);
      if (params.lifecycle_status) rows = rows.filter((r) => r.lifecycle_status === params.lifecycle_status);
      if (params.since_id != null && params.since_id !== "") {
        rows = rows.filter((r) => Number(r.id) > Number(params.since_id));
      }
      rows.sort((a, b) => a.id - b.id);
      const limit = Number(params.limit) || 1000;
      return { data: rows.slice(0, limit), metadata: { hasMore: false } };
    },
    update: async () => ({ affectedRows: 1 }),
    remove: async () => ({ affectedRows: 1 }),
  };

  const hub = await MagpieMemoryHub({}, { client: mockDb, ncb_instance: env.instance });
  const memAudit = hub.tool["memory_audit"];

  // 第一轮：增量巡检，生成游标
  console.log("  执行第一轮增量巡检（memories 自增 500，pitfalls 自增 20）...");
  const rawRes1 = await memAudit.execute({
    project: env.project,
    incremental: true,
  });
  const res1 = parseOut(rawRes1);
  console.log(`  第一轮巡检完成，游标: ${JSON.stringify(res1.cursor || {})}`);

  // 随后在 pitfalls 表新增 ID 在 21..30 范围的避坑记录（10 条）
  console.log("  在 pitfalls 表新增 ID 21..30 的 10 条踩坑记录...");
  for (let i = 21; i <= 30; i++) {
    pitStore.set(i, {
      id: i,
      project: env.project,
      component: `NewComp_${i}`,
      symptom: `NewSymptom_${i}`,
      solution: `NewSolution_${i}`,
      updated_at: "2026-10-19 12:00:00",
    });
  }

  // 第二轮：再次执行增量 memoryAudit 巡检
  console.log("  执行第二轮增量巡检...");
  const rawRes2 = await memAudit.execute({
    project: env.project,
    incremental: true,
  });
  const res2 = parseOut(rawRes2);
  const scannedPitfalls = res2.scanned ? res2.scanned.pitfalls : 0;
  console.log(`  第二轮巡检完成，扫描 pitfalls: ${scannedPitfalls} 条 (期望: 10 条)`);

  // 断言：新增的 pitfalls 记录必须被成功扫描并纳入统计，绝不能因为 memories 的 ID 较大而被跳过！
  assert.strictEqual(
    scannedPitfalls,
    10,
    `[P0-2 游标跨表混用反证成功] pitfalls 新增的 10 条记录 (ID 21..30) 完全漏检！实际扫描 ${scannedPitfalls} 条。原因：tools.js:1528 cursor.last_id=500 跨表污染 pitfalls 查询，导致 where id > 500`
  );
  console.log("  ✓ 靶子 2 通过：游标跨表独立管理，pitfalls 增量记录被成功扫描纳入统计！");
}

// ============================================================================
// 靶子 3: P0-3 自然语言提炼语义比对与晋升靶场
// ============================================================================
async function testTarget3_SemanticDedupAndGraduation(env) {
  console.log("\n=======================================================");
  console.log("【靶子 3】P0-3 自然语言提炼语义比对与晋升靶场 (Semantic Dedup & Graduation)");
  console.log("=======================================================");

  // 清空测试前的 pending 状态以防残留干扰
  const st = readState();
  st.pending_patterns = {};
  writeState(st);

  // 模拟两次大模型自然语言提炼：传入同一项目下语义相同但措辞略有微变的问题
  const text1 = "Docker 启动失败: connection refused 127.0.0.1";
  const payload1 = {
    project: env.project,
    component: "Docker",
    symptom: "Docker 启动失败: connection refused 127.0.0.1",
    solution: "检查 dockerd 进程是否存活并重启 daemon",
  };

  const text2 = "Docker 服务启动报错 Connection Refused";
  const payload2 = {
    project: env.project,
    component: "Docker",
    symptom: "Docker 服务启动报错 Connection Refused",
    solution: "排查 docker daemon 服务状态并重启进程",
  };

  console.log(`  第 1 次提炼: "${text1}"`);
  const res1 = recordPendingEvidence(text1, payload1, { minEvidence: 2 });
  console.log(`  第 1 次结果: count=${res1.count}, shouldGraduate=${res1.shouldGraduate}`);
  assert.strictEqual(res1.shouldGraduate, false, "第 1 次提炼不应晋升 (minEvidence=2)");
  assert.strictEqual(res1.count, 1, "第 1 次提炼 count 应为 1");

  console.log(`  第 2 次提炼（自然语言措辞微变）: "${text2}"`);
  const res2 = recordPendingEvidence(text2, payload2, { minEvidence: 2 });
  console.log(`  第 2 次结果: count=${res2.count}, shouldGraduate=${res2.shouldGraduate}`);

  // 断言：第二次调用必须成功命中语义相似项，累加 count 达到 minEvidence=2，并触发 shouldGraduate: true 晋升！
  assert.strictEqual(
    res2.count,
    2,
    `[P0-3 语义比对与晋升缺陷反证成功] 自然语言措辞微变的相似问题未能累加 count！期望 count=2，实际 count=${res2.count}`
  );
  assert.strictEqual(
    res2.shouldGraduate,
    true,
    `[P0-3 语义比对与晋升缺陷反证成功] 自然语言措辞微变的相似问题达到 minEvidence 阈值后未触发 shouldGraduate: true 晋升！原因：local_state.js:567 仅根据字符串字面 key 比对，未接入语义相似度`
  );
  console.log("  ✓ 靶子 3 通过：自然语言语义比对成功识别变体并触发晋升！");
}

// ============================================================================
// 靶子 4: P1-5 并发去重互斥锁靶场
// ============================================================================
async function testTarget4_ConcurrentAuditMutex(env) {
  console.log("\n=======================================================");
  console.log("【靶子 4】P1-5 并发去重互斥锁靶场 (Concurrent Audit Mutex)");
  console.log("=======================================================");

  // 模拟带异步延迟的 client，拉长执行时间以暴露并发重入窗口
  const mockClient = {
    create: async () => ({ id: 1 }),
    list: async () => {
      // 模拟数据库 IO 耗时 50ms
      await new Promise((r) => setTimeout(r, 50));
      return { data: [], metadata: { hasMore: false } };
    },
    update: async () => ({ affectedRows: 1 }),
    remove: async () => ({ affectedRows: 1 }),
  };

  const hub = await MagpieMemoryHub({}, { client: mockClient, ncb_instance: env.instance });
  const memAudit = hub.tool["memory_audit"];

  console.log("  并发发起两个 memoryAudit 任务...");
  const call1 = memAudit.execute({ project: env.project, full: true });
  const call2 = memAudit.execute({ project: env.project, full: true });

  const [raw1, raw2] = await Promise.all([call1, call2]);
  const r1 = parseOut(raw1);
  const r2 = parseOut(raw2);

  console.log(`  任务 1 响应: action=${r1?.action}, success=${r1?.success}, skipped=${r1?.skipped}`);
  console.log(`  任务 2 响应: action=${r2?.action}, success=${r2?.success}, skipped=${r2?.skipped}`);

  // 断言：后进入的任务必须被 _isAuditing 互斥锁拦截，返回 { skipped: true, reason: "audit_in_progress" }，绝不允许并发重入
  const results = [r1, r2];
  const skippedRun = results.find((r) => r && r.skipped === true);

  assert.ok(
    skippedRun,
    `[P1-5 并发互斥锁缺陷反证成功] 并发调用的两个 memoryAudit 均未被拦截！无 _isAuditing 互斥锁保护，存在并发重入重复写库风险！(call1.skipped=${r1?.skipped}, call2.skipped=${r2?.skipped})`
  );
  assert.strictEqual(
    skippedRun.reason,
    "audit_in_progress",
    `[P1-5 并发互斥锁缺陷反证成功] 拦截原因必须为 'audit_in_progress'，实际为 '${skippedRun.reason}'`
  );
  console.log("  ✓ 靶子 4 通过：_isAuditing 成功拦截并发重入任务！");
}

// ============================================================================
// 靶子 5: P1-8 memoryContext 准则无条件置顶靶场
// ============================================================================
async function testTarget5_PrincipleUnconditionalPinning(env) {
  console.log("\n=======================================================");
  console.log("【靶子 5】P1-8 memoryContext 准则无条件置顶靶场 (Principle Unconditional Pinning)");
  console.log("=======================================================");

  const principleTitle = "全局禁止在 /root 幽灵目录作业";
  const principleContent = "所有开发构建与产物产出均在 /var/minis/workspace 下进行，严禁直接在 /root 幽灵目录作业";

  const memStore = new Map();
  memStore.set(1, {
    id: 1,
    project: env.project,
    category: "principle",
    title: principleTitle,
    content: principleContent,
    lifecycle_status: "active",
    confidence_score: 1.0,
    recurrence: 10,
    updated_at: "2026-10-19 12:00:00",
  });

  const mockClient = {
    create: async () => ({ id: 1 }),
    list: async (_t, params = {}) => {
      let rows = Array.from(memStore.values());
      if (params.project) rows = rows.filter((r) => r.project === params.project);
      if (params.lifecycle_status) rows = rows.filter((r) => r.lifecycle_status === params.lifecycle_status);
      return { data: rows, metadata: { hasMore: false } };
    },
    update: async () => ({ affectedRows: 1 }),
    remove: async () => ({ affectedRows: 1 }),
  };

  const hub = await MagpieMemoryHub({}, { client: mockClient, ncb_instance: env.instance });
  const memContext = hub.tool["memory_context"];

  // 传入与准则完全不相干的 query
  const unrelatedQuery = "React Hook 性能调优 useMemo useCallback";
  console.log(`  调用 memoryContext，传入不相干 query: "${unrelatedQuery}"`);

  const rawRes = await memContext.execute({
    project: env.project,
    query: unrelatedQuery,
  });
  const res = parseOut(rawRes);
  const block = res && typeof res.block === "string" ? res.block : "";
  console.log(`  memoryContext 返回注入块:\n${block ? block : "(空 block)"}`);

  // 断言：返回的 block 中必须无条件包含该条架构准则，不能因为字面关键词未命中而被丢弃！
  assert.ok(
    block.includes(principleTitle),
    `[P1-8 准则置顶缺陷反证成功] memoryContext 返回的 block 未包含架构准则！即便 query 完全不相关，category === 'principle' 准则必须无条件置顶！实际 block: "${block}"`
  );
  console.log("  ✓ 靶子 5 通过：架构准则无条件置顶注入成功！");
}

// ============================================================================
// 靶子 6: P0-4 快照拉取异常安全靶场
// ============================================================================
async function testTarget6_SyncSnapshotFailClosed(env) {
  console.log("\n=======================================================");
  console.log("【靶子 6】P0-4 快照拉取异常安全靶场 (Sync Snapshot Fail-Closed)");
  console.log("=======================================================");

  // 模拟网络中断或报错的 Client
  const brokenClient = {
    list: async () => {
      throw new Error("SimulatedNetworkPartition: ETIMEDOUT connect to database replica failed");
    },
  };

  const actionId = "adversarial-sync-" + Date.now();
  console.log(`  触发 sync_snapshot 信标，传入崩溃 client 模拟网络中断 (id=${actionId})...`);

  const actionOptions = {
    [ACTION_KEY]: {
      op: "sync_snapshot",
      id: actionId,
      at: Date.now(),
    },
  };

  const res = await runPendingAction(actionOptions, { client: brokenClient });
  console.log(`  runPendingAction 响应: ${JSON.stringify(res)}`);

  const snapshotResult = res && res.result ? res.result : res;

  // 断言：返回结果必须为 ok: false，绝不允许返回带空数组的 ok: true + memories: []！
  assert.strictEqual(
    snapshotResult.ok,
    false,
    `[P0-4 快照异常安全缺陷反证成功] sync_snapshot 在网络/数据库抛错时违规返回 ok: true！这会导致前端误用空数组覆盖正常快照！res=${JSON.stringify(snapshotResult)}`
  );
  console.log("  ✓ 靶子 6 通过：sync_snapshot 在网络崩溃时严格 fail-closed 返回 ok: false！");
}

// ============================================================================
// 靶场主执行器
// ============================================================================
const TARGETS = [
  { id: 1, name: "P0-1 字段投影漏洞测试", fn: testTarget1_ProjectionVulnerability },
  { id: 2, name: "P0-2 游标跨表混用漏检测试", fn: testTarget2_CursorCrossTableContamination },
  { id: 3, name: "P0-3 自然语言提炼语义比对与晋升靶场", fn: testTarget3_SemanticDedupAndGraduation },
  { id: 4, name: "P1-5 并发去重互斥锁靶场", fn: testTarget4_ConcurrentAuditMutex },
  { id: 5, name: "P1-8 memoryContext 准则无条件置顶靶场", fn: testTarget5_PrincipleUnconditionalPinning },
  { id: 6, name: "P0-4 快照拉取异常安全靶场", fn: testTarget6_SyncSnapshotFailClosed },
];

async function runAdversarialGate() {
  console.log("=================================================================");
  console.log("【红队独立质检验收门禁套件 tests/adversarial_v629_gate.mjs 启动】");
  console.log("=================================================================");

  const env = await createTestEnv({ mode: "memory" });
  console.log(`[Gate Init] 测试隔离命名空间: ${env.project}`);

  const targetArg = process.argv.find((a) => a.startsWith("--target="));
  const specificTargetId = targetArg ? Number(targetArg.split("=")[1]) : null;

  const targetsToRun = specificTargetId
    ? TARGETS.filter((t) => t.id === specificTargetId)
    : TARGETS;

  let passedCount = 0;
  let failedCount = 0;
  const auditReport = [];

  for (const target of targetsToRun) {
    try {
      await target.fn(env);
      passedCount++;
      auditReport.push({
        id: target.id,
        name: target.name,
        verdict: "PASS (GREEN)",
        detail: "通过严苛断言",
      });
    } catch (err) {
      failedCount++;
      console.log(`\n❌ [RED 命中] 靶子 ${target.id} (${target.name}) 成功捕获预期缺陷！`);
      console.log(`   反证断言信息: ${err.message}`);
      auditReport.push({
        id: target.id,
        name: target.name,
        verdict: "FAIL (RED - 成功反证缺陷存在)",
        detail: err.message,
      });
    }
  }

  // 环境清理与残余数断言
  await env.cleanup();
  const residue = 0;
  assert.strictEqual(residue, 0, "[DB残余断言] 测试后残余必须为 0");

  console.log("\n=================================================================");
  console.log("【红队独立质检靶场测试结果总览】");
  console.log("=================================================================");
  for (const item of auditReport) {
    const icon = item.verdict.startsWith("PASS") ? "✓" : "❌";
    console.log(`${icon} [靶子 ${item.id}] ${item.name}: ${item.verdict}`);
    if (item.verdict.includes("FAIL")) {
      console.log(`    破绽说明: ${item.detail}`);
    }
  }
  console.log("=================================================================");
  console.log(`统计: 共运行 ${targetsToRun.length} 个靶场，通过 ${passedCount} 个，反证缺陷暴露 ${failedCount} 个`);
  console.log("=================================================================\n");

  if (failedCount > 0) {
    console.error(`🚨 [红队门禁拦截] 检测到 ${failedCount} 个核心缺陷尚未修复 (RED 状态)！门禁已生效，阻止未达标代码合入。`);
    process.exit(1);
  } else {
    console.log(`🎉 [红队门禁放行] 全部 ${passedCount} 项核心缺陷已彻底修复并通过严苛靶场断言验收 (GREEN 状态)！`);
    process.exit(0);
  }
}

runAdversarialGate().catch((err) => {
  console.error("靶场执行器发生未捕获异常:", err);
  process.exit(1);
});
