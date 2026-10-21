/**
 * tests/test_v639_a_write.mjs
 * =================================================================
 * v6.39-a 铁律置信度量纲、占位正则、软失效正文数字守卫与 EVO-16 增强专项测试套件
 *
 * 覆盖 4 大核心任务及全量双向反证矩阵：
 * 1. 【BUG-38-1 置信度量纲错配双向反证】
 *    - a) 铁律写入后查回 confidence_score === 100（反证：绝非 1、绝非 1.0）；
 *    - b) 召回能力双向反证：构造 2 条普通 principle(confidence_score=100) + 1 条铁律，调 memory_context，断言铁律成功出现在返回 block 中；
 *    - c) 铁律内容演进后 content_fingerprint 重算反证：二次更新铁律（解法更详尽）时，content_fingerprint 必须更新且与旧值不同。
 *
 * 2. 【BUG-38-4a 占位正则漏历史套话双向反证】
 *    - a) 占位套话反证："执行过程中出现 XXX，已处置解决" 命中占位正则，recurrence=5 严格禁止升维成铁律；
 *    - b) 真实根因反证："TCP KeepAlive 未开启导致连接被静默回收" 判定非占位，正常升维成铁律。
 *
 * 3. 【BUG-38-4b 软失效 memories 漏检正文数字冲突双向反证】
 *    - a) 正文数字冲突反证：已有 memory 正文含 "3306"，新踩坑 solution 含 "3307" → memory 严禁被软失效；
 *    - b) 正文无数字冲突语义相似反证：正文无数字冲突且语义匹配 → memory 正常软失效为 superseded。
 *
 * 4. 【EVO-16 pitfallSave NOOP 分支 tags 合并 + 铁律实体透传双向反证】
 *    - a) NOOP tags 合并反证：重复触发无增益踩坑（NOOP）传入新 tags → 库中 tags 成功合并新 tag；
 *    - b) 铁律实体透传反证：升维铁律时透传 related_entities → 铁律 related_entities 包含 component 与传入实体的并集。
 *
 * 5. 【元规范自检与零残留】
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
  const env = await createTestEnv("v639_a_write");
  console.log("=================================================================");
  console.log("【v6.39-a 铁律置信度量纲、占位正则与 EVO-16 双向反证套件】");
  console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
  console.log("=================================================================\n");

  try {
    const hub = await MagpieMemoryHub({}, { client: env.client, ncb_instance: env.instance });
    const pitSave = hub.tool["pitfall_save"];
    const memSave = hub.tool["memory_save"];
    const memContext = hub.tool["memory_context"];

    // =============================================================
    // 1. BUG-38-1: 铁律置信度量纲错配双向反证与召回验证
    // =============================================================
    console.log("▶ [Test 1] BUG-38-1 铁律置信度量纲 (100) 与召回验证双向反证...");

    const pitSymptom1 = "MySQL 连接池瞬时耗尽 Connection pool exhausted under high concurrency";
    const pitRc1 = "数据库最大连接数 max_connections 配置过小且缺少应用端连接等待超时兜底";
    const pitSol1 = "调大 max_connections 至 2000 并配置 HikariCP connectionTimeout=3000ms";

    // 1.a 触发铁律创建（recurrence=5）
    const ironCreateRes = parseOut(await pitSave.execute({
      project: env.project,
      component: "mysql",
      symptom: pitSymptom1,
      root_cause: pitRc1,
      solution: pitSol1,
      recurrence: 5,
      tags: "mysql, pool, database",
    }, {}));

    assert.strictEqual(ironCreateRes.action, "ADD");
    assert.strictEqual(ironCreateRes.ironlaw_created, true, "recurrence>=5 且非占位必须创建铁律");
    assert.ok(ironCreateRes.ironlaw_id, "必须返回铁律记录 ID");

    // 查库验证 confidence_score 必须为 100，绝非 1.0 或 1
    const ironMemRecord = rowsOf(await env.client.list("memories", { id: ironCreateRes.ironlaw_id, limit: 1 }))[0];
    assert.ok(ironMemRecord, "必须在 memories 表查到铁律");
    assert.strictEqual(
      ironMemRecord.confidence_score,
      100,
      "【反证门 1.a 通过】：铁律写入后 confidence_score 必须为整数量纲 100（非 1、非 1.0）"
    );
    assert.notStrictEqual(ironMemRecord.confidence_score, 1, "反证失败：confidence_score 绝不能为 1");
    assert.notStrictEqual(ironMemRecord.confidence_score, 1.0, "反证失败：confidence_score 绝不能为 1.0");
    console.log("  ✓ 1.a 铁律置信度整数量纲反证通过（confidence_score === 100）");

    // 1.b 必须验证能否被 memory_context 召回：
    // 构造 2 条普通 principle (confidence_score=100) + 1 条刚刚生成的铁律
    const p1 = parseOut(await memSave.execute({
      project: env.project,
      category: "principle",
      title: "核心系统架构准则：所有服务必须配置优雅停机与熔断降级",
      content: "系统全局架构规范：对外提供 HTTP/RPC 服务的微服务必须接入 Sentinel 熔断保护与 30s 优雅下线",
      confidence: 1, // 经过 saveMemory 标准化后为 100
      tags: "architecture, principle, mysql, database",
    }, {}));
    assert.strictEqual(p1.action, "ADD");

    const p2 = parseOut(await memSave.execute({
      project: env.project,
      category: "principle",
      title: "数据变更安全规范：线上 DDL 必须走 gh-ost 影子表变更",
      content: "数据库操作准则：大表结构变更严禁直接执行 ALTER TABLE，必须通过 gh-ost 规避主从延迟与锁表",
      confidence: 1, // 经过 saveMemory 标准化后为 100
      tags: "mysql, ddl, database, safety",
    }, {}));
    assert.strictEqual(p2.action, "ADD");

    // 调用 memory_context 检索，query 命中全部
    const contextRecallRes = parseOut(await memContext.execute({
      project: env.project,
      query: "mysql 数据库 连接池 架构 规范",
      max_items: 5,
      max_principles: 3,
    }, {}));

    assert.ok(contextRecallRes && contextRecallRes.block, "memory_context 必须返回有效 block 上下文");
    assert.ok(
      contextRecallRes.block.includes("【踩坑铁律】mysql: MySQL 连接池瞬时耗尽"),
      "【反证门 1.b 通过】：铁律置信度修正为 100 后，成功被 memory_context 召回并出现在置顶 block 中！"
    );
    console.log("  ✓ 1.b 铁律置信度召回验证反证通过（在 2 条普通 principle 竞争下成功进入 context block）");

    // 1.c 既有铁律二次更新时 content_fingerprint 重算反证
    const initialFp = ironMemRecord.content_fingerprint;
    assert.ok(initialFp, "铁律初始 content_fingerprint 必须存在");

    // 通过解法更详尽（>1.3倍）触发 EVOLVED 演进更新
    const evolvedSolution = pitSol1 + "；进阶排障：同步开启 MySQL performance_schema 并排查慢查询事务未释放导致的连接堆积漏洞";
    const ironEvolveRes = parseOut(await pitSave.execute({
      project: env.project,
      component: "mysql",
      symptom: pitSymptom1,
      root_cause: pitRc1,
      solution: evolvedSolution,
      recurrence: 1,
      tags: "mysql, pool, database, advanced",
    }, {}));

    assert.strictEqual(ironEvolveRes.action, "EVOLVED", "解法显著扩充必须触发 EVOLVED");
    assert.strictEqual(ironEvolveRes.ironlaw_created, true, "演进触发铁律更新");
    assert.strictEqual(ironEvolveRes.ironlaw_id, ironCreateRes.ironlaw_id, "铁律更新必须保留同一 ID");

    const updatedIronMem = rowsOf(await env.client.list("memories", { id: ironCreateRes.ironlaw_id, limit: 1 }))[0];
    assert.ok(updatedIronMem, "必须读到更新后的铁律");
    assert.notStrictEqual(
      updatedIronMem.content_fingerprint,
      initialFp,
      "【反证门 1.c 通过】：铁律内容演进更新时，content_fingerprint 必须重算更新，不得保留旧指纹！"
    );
    assert.ok(updatedIronMem.content.includes("慢查询事务未释放"), "铁律内容必须包含演进后的新解法");
    console.log("  ✓ 1.c 铁律二次更新指纹演进重算反证通过（content_fingerprint 成功更新）\n");

    // =============================================================
    // 2. BUG-38-4a: 占位正则漏历史套话双向反证
    // =============================================================
    console.log("▶ [Test 2] BUG-38-4a 占位正则补历史套话双向反证...");

    // 2.a 反向反证：包含历史模板套话 "执行过程中出现 XXX，已处置解决"，即使 recurrence=5 严禁升维为铁律
    const catchphraseSymptom = "Nginx 504 网关超时错误";
    const catchphraseRootCause = `执行过程中出现 ${catchphraseSymptom}，已处置解决`;
    const catchphraseSol = "重启上游应用容器服务";

    const catchphrasePit = parseOut(await pitSave.execute({
      project: env.project,
      component: "nginx",
      symptom: catchphraseSymptom,
      root_cause: catchphraseRootCause,
      solution: catchphraseSol,
      recurrence: 5, // 虽达到 5 次，但根因为套话
      tags: "nginx, timeout",
    }, {}));

    assert.strictEqual(catchphrasePit.action, "ADD");
    assert.ok(
      !catchphrasePit.ironlaw_created,
      "【反证门 2.a 通过】：历史模板套话「已处置解决」命中占位正则，recurrence=5 严禁升维为铁律！"
    );
    assert.ok(!catchphrasePit.ironlaw_id, "套话踩坑不得返回 ironlaw_id");

    const checkNoCatchphraseIron = rowsOf(await env.client.list("memories", { project: env.project, category: "principle" }))
      .filter((r) => r.title && r.title.includes(catchphraseSymptom));
    assert.strictEqual(checkNoCatchphraseIron.length, 0, "memories 表中严禁产生历史套话的假铁律");
    console.log("  ✓ 2.a 历史模板套话占位反证通过（命中占位正则，严格阻断假铁律升维）");

    // 2.b 正向反证：真实具体根因，recurrence=5 正常升维为铁律
    const realTcpSymptom = "微服务长连接静默中断引发连接池重置抖动";
    const realTcpRootCause = "TCP KeepAlive 未开启导致连接被静默回收";
    const realTcpSol = "在 Netty 传输层开启 SO_KEEPALIVE 并设置 tcp_keepalive_time 为 60 秒";

    const realTcpPit = parseOut(await pitSave.execute({
      project: env.project,
      component: "network",
      symptom: realTcpSymptom,
      root_cause: realTcpRootCause,
      solution: realTcpSol,
      recurrence: 5,
      tags: "network, tcp, keepalive",
    }, {}));

    assert.strictEqual(realTcpPit.action, "ADD");
    assert.strictEqual(
      realTcpPit.ironlaw_created,
      true,
      "【反证门 2.b 通过】：真实技术根因（TCP KeepAlive...）不命中占位正则，正常升维为铁律！"
    );
    assert.ok(realTcpPit.ironlaw_id, "真实根因升维必须返回 ironlaw_id");
    console.log("  ✓ 2.b 真实技术根因正常升维反证通过（未误伤真实根因）\n");

    // =============================================================
    // 3. BUG-38-4b: 软失效 memories 漏检正文数字冲突双向反证
    // =============================================================
    console.log("▶ [Test 3] BUG-38-4b 软失效 memories 漏检正文数字冲突双向反证...");

    // 3.a 正向反证：正文含不同数字（3306 vs 3307），踩坑存入时严禁软失效该 memory
    const memWith3306 = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "MySQL 数据库监听端口配置规范",
      content: "基础架构数据源默认连接线上标准 MySQL 实例，监听在 3306 端口提供主读服务",
    }, {}));
    assert.strictEqual(memWith3306.action, "ADD");

    // pitfall 具有相似主题，但 solution 指定不同端口 3307
    const pitWith3307 = parseOut(await pitSave.execute({
      project: env.project,
      component: "mysql",
      symptom: "MySQL 数据库监听端口配置规范",
      root_cause: "本地测试环境 3306 端口被本地测试实例占用",
      solution: "配置微服务连接隔离端口 3307 规避冲突",
      tags: "mysql, port",
    }, {}));
    assert.strictEqual(pitWith3307.action, "ADD");

    // 检查 memWith3306 状态：绝不能被软失效
    const checkMem3306 = rowsOf(await env.client.list("memories", { id: memWith3306.id, limit: 1 }))[0];
    assert.ok(checkMem3306, "3306 记忆必须存在");
    assert.strictEqual(
      checkMem3306.lifecycle_status,
      "active",
      "【反证门 3.a 通过】：正文含数字冲突（3306 vs 3307）的 memory 绝不得被误软失效，必须维持 active！"
    );
    assert.strictEqual(checkMem3306.invalid_at, null, "invalid_at 必须恒为 null");
    console.log("  ✓ 3.a 正文数字冲突守卫反证通过（3306 记忆未被 3307 踩坑误软失效）");

    // 3.b 反向反证：正文无数字冲突且语义完全一致，踩坑存入时必须正常软失效该冗余 memory
    const memRedundant = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "Redis 哨兵节点超时配置规范",
      content: "Redis 哨兵节点心跳探活配置说明：网络抖动下哨兵可能误判主节点下线",
    }, {}));
    assert.strictEqual(memRedundant.action, "ADD");

    const pitRedundant = parseOut(await pitSave.execute({
      project: env.project,
      component: "redis",
      symptom: "Redis 哨兵节点超时配置规范",
      root_cause: "网络瞬断引发误判主节点下线",
      solution: "调大 sentinel down-after-milliseconds 阈值消除误判",
    }, {}));
    assert.strictEqual(pitRedundant.action, "ADD");

    const checkMemRedundant = rowsOf(await env.client.list("memories", { id: memRedundant.id, limit: 1 }))[0];
    assert.ok(checkMemRedundant, "冗余记忆必须存在");
    assert.strictEqual(
      checkMemRedundant.lifecycle_status,
      "superseded",
      "【反证门 3.b 通过】：无数字冲突且语义重叠的 memory 必须正常软失效为 superseded！"
    );
    assert.ok(checkMemRedundant.invalid_at != null, "invalid_at 必须有软失效时间戳");
    console.log("  ✓ 3.b 无数字冲突语义相似正常软失效反证通过（功能未被改坏）\n");

    // =============================================================
    // 4. EVO-16: pitfallSave NOOP tags 合并 + 铁律实体透传双向反证
    // =============================================================
    console.log("▶ [Test 4] EVO-16 pitfallSave NOOP 分支 tags 合并与铁律实体透传双向反证...");

    // 4.a NOOP 分支 tags 合并反证：
    // 初次存入踩坑记录，带 tags: "nginx, gateway"
    const pitNoopBase = parseOut(await pitSave.execute({
      project: env.project,
      component: "nginx",
      symptom: "Nginx Client Max Body Size 413 Request Entity Too Large",
      root_cause: "默认 client_max_body_size 为 1M 拦截大文件上传",
      solution: "在 http/server 块配置 client_max_body_size 50M",
      tags: "nginx, gateway",
    }, {}));
    assert.strictEqual(pitNoopBase.action, "ADD");

    // 再次存入完全相同内容（无信息增益，触发 NOOP），但带来新 tags: "nginx, upload, filesize"
    const pitNoopRepeat = parseOut(await pitSave.execute({
      project: env.project,
      component: "nginx",
      symptom: "Nginx Client Max Body Size 413 Request Entity Too Large",
      root_cause: "默认 client_max_body_size 为 1M 拦截大文件上传",
      solution: "在 http/server 块配置 client_max_body_size 50M",
      tags: "nginx, upload, filesize",
    }, {}));
    assert.strictEqual(pitNoopRepeat.action, "NOOP", "无增益重复踩坑必须为 NOOP");

    // 查库验证 pitfalls 记录中的 tags 已经与新 tags 合并
    const pitInDbAfterNoop = rowsOf(await env.client.list("pitfalls", { id: pitNoopBase.id, limit: 1 }))[0];
    assert.ok(pitInDbAfterNoop, "踩坑记录必须存在");
    const mergedTagsList = String(pitInDbAfterNoop.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase());
    assert.ok(mergedTagsList.includes("nginx"), "tags 必须包含原有的 nginx");
    assert.ok(mergedTagsList.includes("gateway"), "tags 必须包含原有的 gateway");
    assert.ok(
      mergedTagsList.includes("upload") && mergedTagsList.includes("filesize"),
      "【反证门 4.a 通过】：NOOP 分支必须将本次传入的新 tags（upload, filesize）与既有 tags 取并集写回数据库！"
    );
    console.log("  ✓ 4.a pitfallSave NOOP 分支 tags 合并反证通过（库中 tags 成功合并新标签）");

    // 4.b 铁律实体透传反证：
    // 创建铁律时同时传入 component: "redis" 与 related_entities: "cache, sentinel, cluster"
    const ironEntitySymptom = "Redis 集群脑裂导致写丢失与数据不一致";
    const ironEntityRc = "网络分区使得两半区分别选举 master 产生双主写冲突";
    const ironEntitySol = "配置 min-replicas-to-write 1 与 min-replicas-max-lag 10 阻止隔离区接受写入";

    const ironEntityRes = parseOut(await pitSave.execute({
      project: env.project,
      component: "redis",
      symptom: ironEntitySymptom,
      root_cause: ironEntityRc,
      solution: ironEntitySol,
      recurrence: 5,
      tags: "redis, cluster, split-brain",
      related_entities: "cache, sentinel, cluster",
    }, {}));

    assert.strictEqual(ironEntityRes.action, "ADD");
    assert.strictEqual(ironEntityRes.ironlaw_created, true);
    assert.ok(ironEntityRes.ironlaw_id);

    const ironEntityMem = rowsOf(await env.client.list("memories", { id: ironEntityRes.ironlaw_id, limit: 1 }))[0];
    assert.ok(ironEntityMem, "铁律记忆必须查到");
    const entityList = String(ironEntityMem.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase());
    assert.ok(
      entityList.includes("redis"),
      "铁律 related_entities 必须包含 component (redis)"
    );
    assert.ok(
      entityList.includes("cache") && entityList.includes("sentinel") && entityList.includes("cluster"),
      "【反证门 4.b 通过】：铁律 related_entities 必须合并调用方传入的 related_entities 实体验证通过！"
    );
    console.log("  ✓ 4.b 铁律 related_entities 实体透传反证通过（包含 component 与传入实体并集）\n");

    // =============================================================
    // 5. 元规范自检与零残留
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
console.log("✅ v6.39-a 全部 4 大任务与双向反证门 100% 顺利通过！");
console.log("=================================================================");
