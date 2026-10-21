/**
 * tests/test_v638_a_write.mjs
 * =================================================================
 * v6.38-a 修复知识黑洞、跨类正文数字冲突与 EVO-11 踩坑升维铁律专项测试套件
 *
 * 覆盖 3 大核心任务及全量双向反证矩阵：
 * 1. 【BUG-37-1 知识黑洞双向反证】
 *    - 软失效后正常写入反证：踩坑记录被 memory_forget 软失效后，saveMemory 同主题必须成功 ADD 写入 memories，绝不 NOOP,table:"pitfalls"；
 *    - 活跃踩坑优先反证：未失效的踩坑正常触发「踩坑优先」NOOP 并累加 recurrence。
 *
 * 2. 【BUG-37-3 跨类去重漏检正文数字冲突双向反证】
 *    - 跨类正文数字冲突反证：同主题不同 category 且正文含数字冲突（如 80 vs 8080）必须 ADD，不得作为重复 NOOP；
 *    - 跨类无数字冲突去重反证：同主题不同 category 且无数字冲突、语义重复必须正常 NOOP 命中去重。
 *
 * 3. 【EVO-11 高频踩坑跨表升维 principle 双向反证】
 *    - 真实高频触发反证：recurrence >= 5 且根因/解法真实非占位，必须生成 principle 铁律且库中能查到；
 *    - 未达阈值反证：recurrence = 4 未达阈值时不得生成 principle；
 *    - 占位根因反证：根因等于 symptom 或含"待查"等占位符时不得生成 principle；
 *    - 幂等更新反证：已存在同 project + 同 title 的 principle 再次触发时就地更新并递增 recurrence，库中仅保留 1 条记录。
 *
 * 4. 【元规范自检与零残留】
 *    - scanTestFile 门禁自检 0 违规，createTestEnv 隔离运行，结束后 0 残留断言。
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { MagpieMemoryHub } from "../tools.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []);

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

async function run() {
  const env = await createTestEnv("v638_a_write");
  console.log("=================================================================");
  console.log("【v6.38-a 修复知识黑洞、跨类数字冲突与 EVO-11 踩坑升维双向反证套件】");
  console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
  console.log("=================================================================\n");

  try {
    const hub = await MagpieMemoryHub({}, { client: env.client, ncb_instance: env.instance });
    const pitSave = hub.tool["pitfall_save"];
    const memSave = hub.tool["memory_save"];
    const memForget = hub.tool["memory_forget"];

    // =============================================================
    // 1. BUG-37-1: 知识黑洞双向反证
    // =============================================================
    console.log("▶ [Test 1] BUG-37-1 知识黑洞软失效过滤双向反证...");

    // 1.1 先写入一条踩坑记录
    const pit1 = parseOut(await pitSave.execute({
      project: env.project,
      component: "nginx",
      symptom: "502 Bad Gateway upstream connection timeout",
      solution: "增大 proxy_read_timeout 至 60s 并在 upstream 配置 keepalive 32",
    }, {}));
    assert.strictEqual(pit1.action, "ADD", "初次存入踩坑必须为 ADD");
    assert.ok(pit1.id, "踩坑必须返回有效 ID");

    // 1.b 反向反证：踩坑未失效时，saveMemory 同主题必须正常触发「踩坑优先」NOOP，防重功能不破坏
    const memBeforeForget = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "502 Bad Gateway upstream connection timeout",
      content: "Nginx 网关 upstream 超时故障处理经验",
    }, {}));
    assert.strictEqual(memBeforeForget.action, "NOOP", "未失效踩坑存在时，saveMemory 必须触发 NOOP");
    assert.strictEqual(memBeforeForget.table, "pitfalls", "必须指出优先命中了 pitfalls 表");
    assert.strictEqual(memBeforeForget.id, pit1.id, "必须关联到该踩坑 ID");
    console.log("  ✓ 1.b 活跃踩坑正常触发「踩坑优先」NOOP 反证通过（防重机制健全）");

    // 软失效该踩坑记录
    const forgetRes = parseOut(await memForget.execute({
      table: "pitfalls",
      id: pit1.id,
    }, {}));
    assert.strictEqual(forgetRes.action, "SOFT_DELETE", "软失效必须返回 SOFT_DELETE");

    // 验证数据库中该踩坑已具备 invalid_at
    const checkPitSoft = rowsOf(await env.client.list("pitfalls", { id: pit1.id, limit: 1 }))[0];
    assert.ok(checkPitSoft.invalid_at != null, "踩坑记录 invalid_at 必须非空");

    // 1.a 正向反证：软失效一条踩坑后，再 saveMemory 同主题 → 必须 ADD 进 memories，绝不 NOOP,table:\"pitfalls\"
    const memAfterForget = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "502 Bad Gateway upstream connection timeout",
      content: "Nginx 网关 upstream 超时新架构决策：统一走 Envoy 网格调度",
    }, {}));
    assert.strictEqual(
      memAfterForget.action,
      "ADD",
      "【反证门 1.a 通过】：软失效后 saveMemory 必须成功 ADD 落库 memories，绝不能返回 NOOP table: pitfalls！"
    );
    assert.ok(memAfterForget.id, "必须生成 memories 表新记录 ID");

    const checkMemInDb = rowsOf(await env.client.list("memories", { id: memAfterForget.id, limit: 1 }))[0];
    assert.ok(checkMemInDb, "数据库中必须能够查到新存入的 memories 记录");
    assert.strictEqual(checkMemInDb.project, env.project);
    console.log("  ✓ 1.a 软失效后知识黑洞修复反证通过（成功 ADD 落库，知识未被吞噬）\n");

    // =============================================================
    // 2. BUG-37-3: 跨类去重漏检正文数字冲突双向反证
    // =============================================================
    console.log("▶ [Test 2] BUG-37-3 跨类去重漏检正文数字冲突双向反证...");

    // 先存入 fact 记忆：网关端口配置: 监听 80
    const portFact = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "网关端口配置",
      content: "网关默认配置：监听 80 端口提供 HTTP 服务",
    }, {}));
    assert.strictEqual(portFact.action, "ADD", "fact 记录初次存入必须为 ADD");

    // 2.a 正向反证：以 decision 类别存入「网关端口配置」，正文含数字冲突（80 vs 8080）
    // 修复前：crossDup 仅比对 title，同 title 直接跨类 NOOP，8080 丢失
    // 修复后：正文 80 与 8080 发生数字冲突，crossDup 放行，正常 ADD
    const portDecisionConflict = parseOut(await memSave.execute({
      project: env.project,
      category: "decision",
      title: "网关端口配置",
      content: "新架构决策：网关迁移到高位端口，监听 8080 端口提供服务",
    }, {}));
    assert.strictEqual(
      portDecisionConflict.action,
      "ADD",
      "【反证门 2.a 通过】：跨类别且正文存在数字冲突（80 vs 8080）时必须 ADD，不得作为重复被 crossDup NOOP 丢弃！"
    );
    assert.notStrictEqual(portDecisionConflict.id, portFact.id, "数字冲突记录必须生成全新 ID");
    console.log("  ✓ 2.a 跨类正文数字冲突反证通过（80 vs 8080 成功 ADD 未被误判为跨类重复）");

    // 2.b 反向反证：跨类 + 无数字冲突且语义重复 → 仍须正常 NOOP，不能把去重改坏
    const strategyFact = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "服务灰度发布策略",
      content: "全站服务采用金丝雀分批灰度发布机制保证平滑升级",
    }, {}));
    assert.strictEqual(strategyFact.action, "ADD");

    const strategyDecisionDup = parseOut(await memSave.execute({
      project: env.project,
      category: "decision",
      title: "服务灰度发布策略",
      content: "全站服务采用金丝雀分批灰度发布机制保证平滑升级",
    }, {}));
    assert.strictEqual(
      strategyDecisionDup.action,
      "NOOP",
      "【反证门 2.b 通过】：跨类无数字冲突且语义完全一致时仍须触发跨类去重 NOOP！"
    );
    assert.strictEqual(strategyDecisionDup.id, strategyFact.id, "跨类去重 NOOP 必须指向原记录 ID");
    console.log("  ✓ 2.b 跨类无数字冲突语义重复反证通过（正常触发 crossDup NOOP）\n");

    // =============================================================
    // 3. EVO-11: 高频踩坑跨表升维 principle 双向反证
    // =============================================================
    console.log("▶ [Test 3] EVO-11 高频踩坑跨表升维 principle 双向反证...");

    // 3.b 反向反证 1：recurrence = 4 未达阈值（默认 5）→ 不得生成 principle
    const pitRec4 = parseOut(await pitSave.execute({
      project: env.project,
      component: "redis",
      symptom: "Redis 哨兵主从切换集群只读异常",
      root_cause: "网络瞬断导致哨兵投票未达到 quorum 门槛未能选举新 master",
      solution: "调整 sentinel monitor 的 quorum 为 2 并设置 down-after-milliseconds 为 3000ms",
      recurrence: 4,
      tags: "redis, sentinel",
    }, {}));
    assert.strictEqual(pitRec4.action, "ADD");
    assert.ok(!pitRec4.ironlaw_created, "recurrence=4 未达结晶阈值不得生成 principle");
    assert.ok(!pitRec4.ironlaw_id, "未生成 principle 时不得返回 ironlaw_id");

    const checkNoP = rowsOf(await env.client.list("memories", { project: env.project, category: "principle" }))
      .filter((r) => r.title && r.title.includes("Redis 哨兵主从切换集群只读异常"));
    assert.strictEqual(checkNoP.length, 0, "【反证门 3.b 通过】：recurrence=4 时 memories 表中严禁出现对应 principle！");
    console.log("  ✓ 3.b 未达阈值反证通过（recurrence=4 不生成 principle 铁律）");

    // 3.c 反向反证 2：根因为占位符（等于 symptom 或含待查）→ 不得生成
    // 3.c.1 根因等于 symptom 占位符
    const pitRcEqSym = parseOut(await pitSave.execute({
      project: env.project,
      component: "kafka",
      symptom: "KafkaBrokerNotAvailableException 在高峰期频繁抛出",
      root_cause: "KafkaBrokerNotAvailableException 在高峰期频繁抛出", // 占位：等于 symptom
      solution: "临时重启 broker 服务节点",
      recurrence: 5,
      tags: "kafka, broker",
    }, {}));
    assert.strictEqual(pitRcEqSym.action, "ADD");
    assert.ok(!pitRcEqSym.ironlaw_created, "【反证门 3.c.1 通过】：根因等于 symptom 占位符不得生成 principle");

    // 3.c.2 根因包含待查/未知
    const pitRcPlaceholderWord = parseOut(await pitSave.execute({
      project: env.project,
      component: "es",
      symptom: "Elasticsearch cluster block exception [429/too many requests]",
      root_cause: "具体根因待查，疑似写入熔断", // 占位：含待查
      solution: "扩容 data 节点并调整 threadpool.write.queue_size",
      recurrence: 5,
      tags: "es, cluster",
    }, {}));
    assert.strictEqual(pitRcPlaceholderWord.action, "ADD");
    assert.ok(!pitRcPlaceholderWord.ironlaw_created, "【反证门 3.c.2 通过】：根因含待查关键词不得生成 principle");
    console.log("  ✓ 3.c 占位根因反证通过（root_cause 等于 symptom 或含待查均严禁生成 principle）");

    // 3.a 正向反证：recurrence >= 5 且根因/解法真实 → 必须生成 principle 铁律，且库中能查到
    const realRootCause = "MySQL 8.0 默认 sql_mode 包含 ONLY_FULL_GROUP_BY 导致未聚合列查询语法报错崩溃";
    const realSolution = "在 my.cnf 明确配置 sql_mode 规范，并重构 SQL 使用 ANY_VALUE() 显式聚合消除歧义";
    const pitSymptom = "Expression of SELECT list is not in GROUP BY clause and contains nonaggregated column";

    const pitIronlaw = parseOut(await pitSave.execute({
      project: env.project,
      component: "mysql",
      symptom: pitSymptom,
      root_cause: realRootCause,
      solution: realSolution,
      recurrence: 5, // 达到结晶阈值
      tags: "mysql, group-by",
    }, {}));

    assert.strictEqual(pitIronlaw.action, "ADD");
    assert.strictEqual(
      pitIronlaw.ironlaw_created,
      true,
      "【反证门 3.a 通过】：recurrence>=5 且根因/解法真实必须触发 ironlaw_created: true"
    );
    assert.ok(pitIronlaw.ironlaw_id, "必须返回生成的 ironlaw_id");

    // 查库验证 principle 详细字段规范
    const expectedIronTitle = `【踩坑铁律】mysql: ${pitSymptom.slice(0, 60)}`;
    const ironMem = rowsOf(await env.client.list("memories", { id: pitIronlaw.ironlaw_id, limit: 1 }))[0];
    assert.ok(ironMem, "memories 表中必须能够精确查到生成的 principle 记录");
    assert.strictEqual(ironMem.category, "principle", "分类必须精确等于 principle");
    assert.strictEqual(ironMem.title, expectedIronTitle, "title 必须为【踩坑铁律】<component>: <symptom 前60字>");
    assert.ok(
      ironMem.content.includes("症状") && ironMem.content.includes("根因") && ironMem.content.includes("解法"),
      "content 必须包含 症状、根因、解法 三要素"
    );
    assert.ok(ironMem.content.includes(realRootCause), "content 必须包含真实根因");
    assert.ok(ironMem.content.includes(realSolution), "content 必须包含真实解法");
    assert.ok(
      ironMem.tags.includes("mysql") && ironMem.tags.includes("pitfall-ironlaw"),
      "tags 必须合并原踩坑 tags 并追加 pitfall-ironlaw"
    );
    console.log("  ✓ 3.a 升维生成 principle 反证通过（库中精确查到且包含三要素与 pitfall-ironlaw 标签）");

    // 3.d 反向反证 3：principle 已存在时再次触发 → 更新而非重复创建（库里该 title 只有 1 条）
    const pitAgain = parseOut(await pitSave.execute({
      project: env.project,
      component: "mysql",
      symptom: pitSymptom,
      root_cause: realRootCause,
      solution: realSolution,
      recurrence: 1, // 累加复发次数（5 -> 6）
      tags: "mysql, performance",
    }, {}));

    assert.strictEqual(pitAgain.action, "NOOP", "重复踩坑命中应为 NOOP");
    assert.strictEqual(pitAgain.recurrence, 6, "踩坑 recurrence 递增至 6");
    assert.strictEqual(pitAgain.ironlaw_created, true, "再次触发依然返回 ironlaw_created: true");
    assert.strictEqual(pitAgain.ironlaw_id, pitIronlaw.ironlaw_id, "再次触发必须指向同一条 principle ID");

    // 数据库断言：库中同 title 的 principle 严格只有 1 条，recurrence 累加为 2
    const allPrinciplesWithTitle = rowsOf(await env.client.list("memories", { project: env.project, category: "principle", limit: 50 }))
      .filter((r) => !r.invalid_at && r.title === expectedIronTitle);
    assert.strictEqual(
      allPrinciplesWithTitle.length,
      1,
      "【反证门 3.d 通过】：principle 已存在时再次触发必须就地更新，库中该 title 记录严格只有 1 条！"
    );
    assert.strictEqual(
      Number(allPrinciplesWithTitle[0].recurrence),
      2,
      "existing principle 的 recurrence 必须累加递增为 2"
    );
    console.log("  ✓ 3.d 再次触发更新而非重复创建反证通过（库里同 title 严格仅 1 条且 recurrence 递增）\n");

    // =============================================================
    // 4. 元规范自检与零残留
    // =============================================================
    console.log("▶ [自检] test_meta 规范合规自检与零残留断言...");
    const selfPath = fileURLToPath(import.meta.url);
    const selfCode = fs.readFileSync(selfPath, "utf8");
    const scanRes = scanTestFile(selfPath, selfCode);
    if (scanRes.issues.length > 0) {
      console.error("❌ 本测试存在 test_meta 规范违规:");
      for (const iss of scanRes.issues) console.error("   -", iss);
    }
    assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 100% 符合 test_meta 规范");
    console.log("  ✓ test_meta 自检 0 违规");

  } catch (err) {
    console.error("❌ 测试执行异常:", err);
    throw err;
  } finally {
    console.log(`\n[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "测试结束后数据库必须 0 残留");
    console.log("✅ 【零残留断言通过】：测试数据已彻底清除！");
  }
}

await run();
console.log("=================================================================");
console.log("✅ v6.38-a 修复与 EVO-11 全部双向反证门 100% 顺利通过！");
console.log("=================================================================");
