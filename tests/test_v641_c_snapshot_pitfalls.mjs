/**
 * tests/test_v641_c_snapshot_pitfalls.mjs
 *
 * 【FUNC-2 专项双向反证测试套件】
 * 验证 page_actions.js 的 sync_snapshot 同步拉取 pitfalls 表活跃记录并转换为中间件兼容快照合入：
 * 1. 【正向门 1】双表融合与中间件结构兼容性映射（category, title, content, symptom, solution, recurrence, etc.）
 * 2. 【正向门 2】按 recurrence 降序排序与 Top 50 截断
 * 3. 【正向门 3】端到端贯通：注入 memory.middleware.js 触发 [高频复发×N] 与核查建议
 * 4. 【反证门 1】invalid_at 软失效严格过滤（正反双向反证）
 * 5. 【反证门 2】lifecycle_status 非 active 状态严格过滤（"invalid" / "superseded" / "archived" 拦截反证）
 * 6. 【反证门 3】双字段交叉失效组合拦截反证（active + invalid_at 剔除，null + superseded 剔除）
 * 7. 【反证门 4】多租户项目隔离与跨项目防泄漏反证（beta_proj 100% 隔离）
 * 8. 【反证门 5】底层异常严格 fail-closed 安全反证（崩溃时返回 ok: false）
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { runPendingAction } from "../page_actions.js";
import { onRequest } from "../memory.middleware.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【FUNC-2 专项双向反证测试套件】：sync_snapshot 踩坑快照双表融合");
console.log("=================================================================\n");

async function main() {
  // =========================================================================
  // 1. 【正向门 1】双表融合与中间件兼容快照结构映射
  // =========================================================================
  console.log("▶ [Test 1] 正向门 1: 踩坑记录双表融合与字段投影映射断言");
  {
    const mockMemories = [
      { id: 101, project: "alpha_proj", title: "Alpha 部署规范", content: "使用 k8s 部署", updated_at: "2026-10-21 12:00:00" },
      { id: 102, project: "global", title: "全局 Git 规范", content: "遵循 Conventional Commits", updated_at: "2026-10-21 12:05:00" },
    ];

    const mockPitfalls = [
      {
        id: 201,
        project: "alpha_proj",
        component: "RedisCluster",
        symptom: "Redis 6379 连接超时断开",
        root_cause: "连接池空闲连接未设置 keepalive 被防火墙重置",
        solution: "连接池配置 SO_KEEPALIVE 并设置 idleTimeout=30s",
        tags: "redis,timeout,pool",
        related_entities: "Redis,Cluster",
        recurrence: 6,
        updated_at: "2026-10-21 12:10:00",
        lifecycle_status: "active",
        invalid_at: null,
      },
      {
        id: 202,
        project: "global",
        component: "DockerDaemon",
        symptom: "Docker daemon 无法启动",
        root_cause: "iptables 规则冲突",
        solution: "重置 iptables 规则链并重启 systemd",
        tags: "docker,iptables",
        related_entities: "Docker,Linux",
        recurrence: 2,
        updated_at: "2026-10-21 12:15:00",
        lifecycle_status: "active",
        invalid_at: null,
      },
    ];

    const mockDbClient = {
      list: async (table, params) => {
        const prj = params.project;
        if (table === "memories") {
          return { data: mockMemories.filter((m) => !prj || m.project === prj) };
        }
        if (table === "pitfalls") {
          return { data: mockPitfalls.filter((p) => !prj || p.project === prj) };
        }
        return { data: [] };
      },
    };

    const action = {
      id: "act_func2_p1_" + Date.now(),
      op: "sync_snapshot",
      at: Date.now(),
      project: "alpha_proj",
    };

    const res = await runPendingAction(
      { _action: action, project: "alpha_proj" },
      { client: mockDbClient, project: "alpha_proj" }
    );

    assert.strictEqual(res.ran, true, "信标必须执行");
    assert.strictEqual(res.result.ok, true, "快照同步必须返回成功 ok: true");
    const snapshot = res.result.memories;
    assert.ok(Array.isArray(snapshot), "快照结果必须为数组");
    assert.strictEqual(snapshot.length, 4, "快照必须包含 2 条记忆 + 2 条踩坑记录");

    // 验证踩坑结构字段映射
    const pitfallSnapshot201 = snapshot.find((item) => item.id === 201);
    assert.ok(pitfallSnapshot201, "快照中必须包含 id=201 的踩坑快照");
    assert.strictEqual(pitfallSnapshot201.category, "pitfall", "踩坑 category 必须为 'pitfall'");
    assert.strictEqual(pitfallSnapshot201.scope_level, "project", "scope_level 必须为 'project'");
    assert.strictEqual(pitfallSnapshot201.title, "RedisCluster: Redis 6379 连接超时断开", "title 格式必须为 ${component}: ${symptom}");
    assert.strictEqual(
      pitfallSnapshot201.content,
      "Redis 6379 连接超时断开 → 连接池配置 SO_KEEPALIVE 并设置 idleTimeout=30s",
      "content 格式必须为 ${symptom} → ${solution}"
    );
    assert.strictEqual(pitfallSnapshot201.symptom, "Redis 6379 连接超时断开", "symptom 必须完整映射");
    assert.strictEqual(pitfallSnapshot201.solution, "连接池配置 SO_KEEPALIVE 并设置 idleTimeout=30s", "solution 必须完整映射");
    assert.strictEqual(pitfallSnapshot201.root_cause, "连接池空闲连接未设置 keepalive 被防火墙重置", "root_cause 必须完整映射");
    assert.strictEqual(pitfallSnapshot201.recurrence, 6, "recurrence 必须为数值 6");
    assert.strictEqual(pitfallSnapshot201.retrieval_count, 6, "retrieval_count 必须继承 recurrence=6 以支持 RRF 热度加权");
    assert.strictEqual(pitfallSnapshot201.lifecycle_status, "active", "lifecycle_status 必须为 'active'");
    assert.strictEqual(pitfallSnapshot201.tags, "redis,timeout,pool", "tags 必须完整映射");
    assert.strictEqual(pitfallSnapshot201.related_entities, "Redis,Cluster", "related_entities 必须完整映射");

    console.log("  ✓ 正向门 1 通过: 踩坑字段规范化投影映射 100% 符合中间件要求\n");
  }

  // =========================================================================
  // 2. 【正向门 2】按 recurrence 降序排序与 Top 50 截断
  // =========================================================================
  console.log("▶ [Test 2] 正向门 2: 按 recurrence 降序排列与 Top 50 上限截断断言");
  {
    const manyPitfalls = [];
    // 生成 60 条踩坑记录，recurrence 分别为 1..60
    for (let i = 1; i <= 60; i++) {
      manyPitfalls.push({
        id: 300 + i,
        project: "global",
        component: "comp_" + i,
        symptom: "问题症状 " + i,
        solution: "解决方案 " + i,
        recurrence: i, // 1 到 60
        lifecycle_status: "active",
        invalid_at: null,
      });
    }

    const mockDbClient = {
      list: async (table, params) => {
        if (table === "memories") return { data: [] };
        if (table === "pitfalls") return { data: manyPitfalls };
        return { data: [] };
      },
    };

    const action = {
      id: "act_func2_top50_" + Date.now(),
      op: "sync_snapshot",
      at: Date.now(),
    };

    const res = await runPendingAction({ _action: action }, { client: mockDbClient });
    assert.strictEqual(res.result.ok, true);
    const snapshot = res.result.memories;

    assert.strictEqual(snapshot.length, 50, "踩坑快照必须严格截断至 Top 50 条");

    // 必须按 recurrence 降序排列
    for (let i = 0; i < snapshot.length - 1; i++) {
      assert.ok(
        snapshot[i].recurrence >= snapshot[i + 1].recurrence,
        `第 ${i} 项 recurrence (${snapshot[i].recurrence}) 必须 >= 第 ${i + 1} 项 (${snapshot[i + 1].recurrence})`
      );
    }

    // 第一项必须是 recurrence=60 的记录
    assert.strictEqual(snapshot[0].recurrence, 60, "第 1 项必须为最高复发次数 60");
    // 最后一项必须是 recurrence=11 的记录（1..10 已被截断淘汰）
    assert.strictEqual(snapshot[49].recurrence, 11, "第 50 项必须为截断下界 recurrence=11");

    // 反证断言：低频复发的 1..10 号记录绝不可进入快照
    const hasLowRecurrence = snapshot.some((it) => it.recurrence <= 10);
    assert.strictEqual(hasLowRecurrence, false, "【反证】Top 50 截断必须淘汰低于阈值的低频踩坑");

    console.log("  ✓ 正向门 2 通过: recurrence 降序与 Top 50 截断断言完全通过\n");
  }

  // =========================================================================
  // 3. 【正向门 3】端到端贯通：注入 memory.middleware.js 触发高频复发警示
  // =========================================================================
  console.log("▶ [Test 3] 正向门 3: 端到端贯通 memory.middleware.js 触发高频复发预警");
  {
    const mockDbClient = {
      list: async (table, params) => {
        if (table === "memories") return { data: [] };
        if (table === "pitfalls") {
          return {
            data: [
              {
                id: 401,
                project: "global",
                component: "PostgreSQL",
                symptom: "PostgreSQL 慢查询超出阈值引发 504 网关超时",
                solution: "在 tenant_id 和 created_at 建立复合索引",
                recurrence: 5, // >= 默认 threshold 3
                lifecycle_status: "active",
                invalid_at: null,
              },
            ],
          };
        }
        return { data: [] };
      },
    };

    const action = {
      id: "act_func2_mw_" + Date.now(),
      op: "sync_snapshot",
      at: Date.now(),
    };

    const res = await runPendingAction({ _action: action }, { client: mockDbClient });
    assert.strictEqual(res.result.ok, true);
    const snapshot = res.result.memories;

    // 将快照传入中间件 onRequest
    const reqBody = {
      messages: [
        { role: "user", content: "排查 PostgreSQL 504 网关超时报错" },
      ],
    };

    const middlewareOpts = {
      memories: snapshot,
      pitfall_recurrence_threshold: 3,
      max_budget_chars: 4096,
      max_inject_count: 5,
    };

    const modifiedBody = await onRequest(reqBody, { options: middlewareOpts });
    const lastMsg = modifiedBody.messages[modifiedBody.messages.length - 1];
    const userText = String(lastMsg.content);

    // 验证激活 memory.middleware.js:848 预设的高频踩坑预警
    assert.ok(userText.includes("[高频复发×5]"), "中间件必须命中并渲染高频复发前缀 '[高频复发×5]'");
    assert.ok(userText.includes("建议核查根因是否已根治"), "中间件必须渲染后缀 '建议核查根因是否已根治'");
    assert.ok(userText.includes("PostgreSQL 慢查询"), "中间件必须包含踩坑症状描述");

    console.log("  ✓ 正向门 3 通过: 快照顺利激活 memory.middleware.js 预设高频踩坑预警链路\n");
  }

  // =========================================================================
  // 4. 【反证门 1】invalid_at 软失效严格过滤（正反双向反证）
  // =========================================================================
  console.log("▶ [Test 4] 反证门 1: invalid_at 软失效过滤（正反双向断言）");
  {
    const mockPitfalls = [
      { id: 501, project: "global", symptom: "已失效踩坑 A (时间戳)", solution: "解法", recurrence: 10, invalid_at: "2026-10-20 10:00:00", lifecycle_status: "active" },
      { id: 502, project: "global", symptom: "已失效踩坑 B (ISO8601)", solution: "解法", recurrence: 9, invalid_at: "2026-10-20T10:00:00.000Z", lifecycle_status: "active" },
      { id: 503, project: "global", symptom: "正常活跃踩坑 C", solution: "解法", recurrence: 8, invalid_at: null, lifecycle_status: "active" },
      { id: 504, project: "global", symptom: "正常活跃踩坑 D", solution: "解法", recurrence: 7, invalid_at: undefined, lifecycle_status: "active" },
      { id: 505, project: "global", symptom: "已失效踩坑 E (空串视同无失效)", solution: "解法", recurrence: 6, invalid_at: "", lifecycle_status: "active" },
    ];

    const mockDbClient = {
      list: async (table, params) => {
        if (table === "memories") return { data: [] };
        if (table === "pitfalls") return { data: mockPitfalls };
        return { data: [] };
      },
    };

    const action = {
      id: "act_func2_invalid_" + Date.now(),
      op: "sync_snapshot",
      at: Date.now(),
    };

    const res = await runPendingAction({ _action: action }, { client: mockDbClient });
    assert.strictEqual(res.result.ok, true);
    const snapshot = res.result.memories;

    // 反证 1.a: invalid_at 非空的 501、502 绝对严禁进入快照
    const has501 = snapshot.some((it) => it.id === 501);
    const has502 = snapshot.some((it) => it.id === 502);
    assert.strictEqual(has501, false, "【反证 1.a】已标记 invalid_at 的 501 记录绝对严禁进入快照");
    assert.strictEqual(has502, false, "【反证 1.b】已标记 invalid_at 的 502 记录绝对严禁进入快照");

    // 反向反证：若故意漏滤 invalid_at，必须判定违规
    assert.ok(
      !snapshot.some((it) => it.invalid_at),
      "【反证 1.c】快照结果中任何条目均不得存在 truthy 的 invalid_at"
    );

    // 正常活跃条目 503、504、505 必须完整保留
    assert.ok(snapshot.some((it) => it.id === 503), "活跃记录 503 必须保留");
    assert.ok(snapshot.some((it) => it.id === 504), "活跃记录 504 必须保留");
    assert.ok(snapshot.some((it) => it.id === 505), "未失效记录 505 (invalid_at='') 必须保留");

    console.log("  ✓ 反证门 1 通过: invalid_at 软失效记录被 100% 拦截剔除\n");
  }

  // =========================================================================
  // 5. 【反证门 2】lifecycle_status 非 active 状态严格过滤
  // =========================================================================
  console.log("▶ [Test 5] 反证门 2: lifecycle_status 非 active 状态严格过滤");
  {
    const mockPitfalls = [
      { id: 601, project: "global", symptom: "状态为 invalid", solution: "解法", recurrence: 10, invalid_at: null, lifecycle_status: "invalid" },
      { id: 602, project: "global", symptom: "状态为 superseded", solution: "解法", recurrence: 9, invalid_at: null, lifecycle_status: "superseded" },
      { id: 603, project: "global", symptom: "状态为 archived", solution: "解法", recurrence: 8, invalid_at: null, lifecycle_status: "archived" },
      { id: 604, project: "global", symptom: "状态为 active", solution: "解法", recurrence: 7, invalid_at: null, lifecycle_status: "active" },
      { id: 605, project: "global", symptom: "无 lifecycle 字段 (老数据兜底 active)", solution: "解法", recurrence: 6, invalid_at: null },
    ];

    const mockDbClient = {
      list: async (table, params) => {
        if (table === "memories") return { data: [] };
        if (table === "pitfalls") return { data: mockPitfalls };
        return { data: [] };
      },
    };

    const action = {
      id: "act_func2_status_" + Date.now(),
      op: "sync_snapshot",
      at: Date.now(),
    };

    const res = await runPendingAction({ _action: action }, { client: mockDbClient });
    assert.strictEqual(res.result.ok, true);
    const snapshot = res.result.memories;

    // 反证 2.a: invalid, superseded, archived 绝对严禁进入快照
    assert.strictEqual(snapshot.some((it) => it.id === 601), false, "【反证 2.a】lifecycle_status='invalid' 记录必须被过滤");
    assert.strictEqual(snapshot.some((it) => it.id === 602), false, "【反证 2.b】lifecycle_status='superseded' 记录必须被过滤");
    assert.strictEqual(snapshot.some((it) => it.id === 603), false, "【反证 2.c】lifecycle_status='archived' 记录必须被过滤");

    // 活跃记录 604、老数据 605 必须正常收录
    assert.strictEqual(snapshot.some((it) => it.id === 604), true, "lifecycle_status='active' 记录 604 必须进入快照");
    assert.strictEqual(snapshot.some((it) => it.id === 605), true, "未显式指定状态的老数据 605 必须进入快照");

    console.log("  ✓ 反证门 2 通过: 非 active 生命周期状态被 100% 拦截\n");
  }

  // =========================================================================
  // 6. 【反证门 3】双字段交叉失效组合拦截反证
  // =========================================================================
  console.log("▶ [Test 6] 反证门 3: 双字段交叉失效组合拦截反证");
  {
    const mockPitfalls = [
      { id: 701, project: "global", symptom: "虽然 status=active 但 invalid_at 非空", recurrence: 10, invalid_at: "2026-10-21 11:00:00", lifecycle_status: "active" },
      { id: 702, project: "global", symptom: "虽然 invalid_at=null 但 status=superseded", recurrence: 10, invalid_at: null, lifecycle_status: "superseded" },
      { id: 703, project: "global", symptom: "双条件均合法活跃", recurrence: 10, invalid_at: null, lifecycle_status: "active" },
    ];

    const mockDbClient = {
      list: async (table, params) => {
        if (table === "memories") return { data: [] };
        if (table === "pitfalls") return { data: mockPitfalls };
        return { data: [] };
      },
    };

    const res = await runPendingAction({ _action: { op: "sync_snapshot", id: "act_cross_" + Date.now() } }, { client: mockDbClient });
    const snapshot = res.result.memories;

    assert.strictEqual(snapshot.some((it) => it.id === 701), false, "【反证 3.a】status=active 但 invalid_at 非空必须被剔除");
    assert.strictEqual(snapshot.some((it) => it.id === 702), false, "【反证 3.b】invalid_at=null 但 status=superseded 必须被剔除");
    assert.strictEqual(snapshot.some((it) => it.id === 703), true, "双条件均活跃的 703 必须被收录");

    console.log("  ✓ 反证门 3 通过: 双字段交叉组合失效被精确拦截\n");
  }

  // =========================================================================
  // 7. 【反证门 4】多租户项目隔离与跨项目防泄漏反证
  // =========================================================================
  console.log("▶ [Test 7] 反证门 4: 多租户项目隔离与跨项目踩坑防泄漏反证");
  {
    const mockPitfalls = [
      { id: 801, project: "alpha_proj", symptom: "Alpha 项目踩坑", recurrence: 5, invalid_at: null, lifecycle_status: "active" },
      { id: 802, project: "global", symptom: "全局共享踩坑", recurrence: 3, invalid_at: null, lifecycle_status: "active" },
      { id: 803, project: "beta_proj", symptom: "Beta 涉密项目踩坑（禁止泄漏）", recurrence: 20, invalid_at: null, lifecycle_status: "active" },
    ];

    const mockDbClient = {
      list: async (table, params) => {
        const prj = params.project;
        if (table === "memories") return { data: [] };
        if (table === "pitfalls") {
          return { data: mockPitfalls.filter((p) => !prj || p.project === prj) };
        }
        return { data: [] };
      },
    };

    const action = {
      id: "act_func2_iso_" + Date.now(),
      op: "sync_snapshot",
      at: Date.now(),
      project: "alpha_proj",
    };

    const res = await runPendingAction(
      { _action: action, project: "alpha_proj" },
      { client: mockDbClient, project: "alpha_proj" }
    );

    const snapshot = res.result.memories;
    const hasBeta = snapshot.some((it) => it.project === "beta_proj" || it.id === 803);
    assert.strictEqual(hasBeta, false, "【反证 4.a】专属项目上下文下严禁泄露外部项目 (beta_proj) 的踩坑！");

    const hasAlpha = snapshot.some((it) => it.id === 801 && it.project === "alpha_proj");
    const hasGlobal = snapshot.some((it) => it.id === 802 && it.project === "global");
    assert.strictEqual(hasAlpha, true, "alpha_proj 专属踩坑必须被收录");
    assert.strictEqual(hasGlobal, true, "global 全局共享踩坑必须被收录");

    console.log("  ✓ 反证门 4 通过: 多租户项目隔离断言有效，beta_proj 零泄漏\n");
  }

  // =========================================================================
  // 8. 【反证门 5】底层异常严格 fail-closed 安全反证
  // =========================================================================
  console.log("▶ [Test 8] 反证门 5: 底层崩溃严格 fail-closed 安全反证");
  {
    const crashingClient = {
      list: async () => {
        throw new Error("SimulatedPartitionError: NCB API unreachable");
      },
    };

    const action = {
      id: "act_func2_fail_" + Date.now(),
      op: "sync_snapshot",
      at: Date.now(),
    };

    const res = await runPendingAction({ _action: action }, { client: crashingClient });
    assert.strictEqual(res.ran, true, "信标必须执行");
    assert.strictEqual(res.result.ok, false, "【反证 5】底层报错时必须 fail-closed 返回 ok: false，严禁返回伪成功");
    assert.ok(
      res.result.lines.some((l) => l.includes("SimulatedPartitionError")),
      "必须携带真实错误原因"
    );

    console.log("  ✓ 反证门 5 通过: 异常场景严格 fail-closed，绝无空数组伪成功\n");
  }

  // =========================================================================
  // 9. 测试元规范自检
  // =========================================================================
  console.log("▶ [自检] test_meta 规范自检");
  const selfPath = fileURLToPath(import.meta.url);
  const selfCode = fs.readFileSync(selfPath, "utf8");
  const scanRes = scanTestFile(selfPath, selfCode);
  if (scanRes.issues.length > 0) {
    for (const is of scanRes.issues) console.error("   - " + is);
  }
  assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 0 规范违规");
  console.log("  ✓ test_meta 自检 0 违规\n");

  console.log("=================================================================");
  console.log("🎉 全部 8 项正向门与反证门断言 100% 通过！");
  console.log("=================================================================");
}

main().catch((err) => {
  console.error("❌ 测试套件执行失败:", err);
  process.exit(1);
});
