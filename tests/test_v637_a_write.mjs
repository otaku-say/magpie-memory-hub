/**
 * tests/test_v637_a_write.mjs
 * =================================================================
 * v6.37-a 写入链路修复与演进增强专项验收与双向反证测试套件
 *
 * 覆盖 3 大核心整改项及全量双向反证矩阵：
 * 1. 【BUG-1 踩坑演进根因保护/数字冲突/标签合并双向反证】
 *    - 真实根因保护反证：仅扩充方案未显式传 root_cause 时，库中真实根因严格保留，绝不被 symptom 覆盖；
 *    - 显式更新根因反证：显式传入新 root_cause 时，库中根因成功演进更新；
 *    - 解法数字冲突反证：新旧方案存在数字冲突时（如 2048MB vs 8192MB），禁止演进覆盖，必须返回 NOOP 并在 note 报警；
 *    - 演进标签合并反证：演进成功时，新旧 tags 自动取并集融合回写。
 *
 * 2. 【BUG-3 saveMemory 显式 supersede 与 NOOP 标签实体保留双向反证】
 *    - 显式 supersede 穿透反证：命中 dup 时即便标题不一致（isSameTitle 为 false），显式传 supersede: true 仍必须进入 ENRICHED；
 *    - NOOP 标签实体合并反证：NOOP 分支下数据库正文不被冲刷，新传入的 tags 与 related_entities 成功取并集回写。
 *
 * 3. 【EVO-9a 冲突感知与显式 supersede_id 双向反证】
 *    - 冲突感知反证：新增记忆时存在同主题但含冲突数字的旧记录，ADD 返回体必须附带 conflict_candidates 与建议提示；
 *    - 无冲突反证：新增记忆无冲突时，conflict_candidates 必须为空；
 *    - supersede_id 显式取代反证：显式传入 supersede_id 时，目标旧记录被软失效且 invalid_reason 为 superseded-by:<newId>。
 *
 * 4. 【测试规范元检查与零残留】
 *    - scanTestFile 自检 0 违规，测试结束后 0 残留断言。
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
  const env = await createTestEnv("v637_a_write");
  console.log("=================================================================");
  console.log("【v6.37-a 写入链路修复与演进增强双向反证验收套件】");
  console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
  console.log("=================================================================\n");

  try {
    const hub = await MagpieMemoryHub({}, { client: env.client, ncb_instance: env.instance });
    const pitSave = hub.tool["pitfall_save"];
    const memSave = hub.tool["memory_save"];

    // =============================================================
    // 1. BUG-1: pitfallSave 根因保护、数字冲突与 tags 合并双向反证
    // =============================================================
    console.log("▶ [Test 1] BUG-1 pitfallSave 根因保护、数字冲突与 tags 并集双向反证...");

    // 1.1 真实根因保护反证：首次存入真实根因，二次只传更详尽解法（未传 root_cause）
    const realRootCause = "底层 TCP Socket 连接池句柄泄漏，未在 catch 块调用 release()";
    const pit1Init = parseOut(await pitSave.execute({
      project: env.project,
      symptom: "SocketTimeoutException on downstream connection",
      root_cause: realRootCause,
      solution: "临时规避：重启服务实例",
      tags: "socket, timeout",
    }, {}));
    assert.strictEqual(pit1Init.action, "ADD", "初次存入应为 ADD");
    const pit1Id = pit1Init.id;

    // 二次调用：提供更详尽方案（>1.3倍），但绝不传 root_cause
    const detailedSolution = "正式解决方案：修改 ConnectionPoolConfig，增加 maxIdleTime 5000ms 与 testOnBorrow 保活探测，并在 finally 显式调用 release()";
    const pit1Evolve = parseOut(await pitSave.execute({
      project: env.project,
      symptom: "SocketTimeoutException on downstream connection",
      solution: detailedSolution, // 长度显著增加
      tags: "pool, leak",
    }, {}));

    assert.strictEqual(pit1Evolve.action, "EVOLVED", "解法显著详尽时必须触发 EVOLVED");
    assert.strictEqual(pit1Evolve.id, pit1Id, "EVOLVED 必须更新既有原记录 ID");

    // 数据库断言：真实根因绝不能被覆盖成 symptom 占位符！tags 必须取并集
    const checkPit1 = rowsOf(await env.client.list("pitfalls", { id: pit1Id, limit: 1 }))[0];
    assert.strictEqual(
      checkPit1.root_cause,
      realRootCause,
      "【反证门 1.1 通过】：未显式传入 root_cause 时，库中原真实根因必须严格保留，绝不能被占位符 symptom 覆盖！"
    );
    assert.strictEqual(checkPit1.solution, detailedSolution, "解法必须已更新为详尽方案");
    assert.ok(checkPit1.tags.includes("socket") && checkPit1.tags.includes("leak"), "【反证门 1.1b 通过】：tags 必须取并集");
    console.log("  ✓ 1.1 真实根因保护反证通过（未传 root_cause 绝不被 symptom 冲刷，tags 取并集）");

    // 1.2 显式传新根因必须更新反证
    const updatedRootCause = "经排查确认为第三方 SDK 内部连接池未关闭 KeepAlive 探针导致句柄泄漏";
    const pit1UpdateRc = parseOut(await pitSave.execute({
      project: env.project,
      symptom: "SocketTimeoutException on downstream connection",
      root_cause: updatedRootCause,
      solution: detailedSolution,
      tags: "sdk, upgrade",
    }, {}));
    assert.strictEqual(pit1UpdateRc.action, "EVOLVED", "显式传新根因必须触发 EVOLVED");
    const checkPit1Rc = rowsOf(await env.client.list("pitfalls", { id: pit1Id, limit: 1 }))[0];
    assert.strictEqual(
      checkPit1Rc.root_cause,
      updatedRootCause,
      "【正向门 1.2 通过】：显式传入新根因时，库中 root_cause 必须成功更新！"
    );
    assert.ok(checkPit1Rc.tags.includes("sdk") && checkPit1Rc.tags.includes("upgrade"), "tags 持续融合并集");
    console.log("  ✓ 1.2 显式传入新根因更新验证通过！");

    // 1.3 方案数字冲突禁止演进覆盖反证（如 2048MB vs 8192MB）
    const pit2Init = parseOut(await pitSave.execute({
      project: env.project,
      symptom: "OutOfMemoryError: Java heap space on Elasticsearch",
      solution: "JVM 堆内存配置为 -Xmx2048m",
      tags: "jvm, heap",
    }, {}));
    const pit2Id = pit2Init.id;

    // 二次存入方案更长，但数字冲突（2048m vs 8192m）
    const conflictingSolution = "JVM 堆内存优化：为避免内存溢出，需将参数调整为 -Xmx8192m 并开启 G1GC 深入调优以保证集群稳定性";
    const pit2Conflict = parseOut(await pitSave.execute({
      project: env.project,
      symptom: "OutOfMemoryError: Java heap space on Elasticsearch",
      solution: conflictingSolution,
    }, {}));

    assert.strictEqual(
      pit2Conflict.action,
      "NOOP",
      "【反证门 1.3 通过】：方案存在数字冲突时严禁 EVOLVED 覆盖，必须返回 NOOP！"
    );
    assert.ok(
      pit2Conflict.note && pit2Conflict.note.includes("数字冲突"),
      "note 中必须明确指出数字冲突"
    );

    const checkPit2 = rowsOf(await env.client.list("pitfalls", { id: pit2Id, limit: 1 }))[0];
    assert.strictEqual(checkPit2.solution, "JVM 堆内存配置为 -Xmx2048m", "【反证门 1.3b 通过】：数据库中原方案绝不能被数字冲突方案覆盖");
    assert.strictEqual(Number(checkPit2.recurrence), 2, "NOOP 正常累加复发计数");
    console.log("  ✓ 1.3 数字冲突禁止演进反证通过（2048m vs 8192m 严格维持 NOOP）");

    // =============================================================
    // 2. BUG-3: saveMemory 显式 supersede 与 NOOP 标签实体保留
    // =============================================================
    console.log("\n▶ [Test 2] BUG-3 saveMemory 显式 supersede 与 NOOP 标签实体保留双向反证...");

    // 2.1 标题不同时显式传 supersede: true 仍必须进入 ENRICHED 反证
    const mem1Init = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "Redis 会话架构设计",
      content: "采用 Redis 缓存会话数据，集群架构部署",
      tags: "redis, session",
      related_entities: "Redis",
    }, {}));
    const mem1Id = mem1Init.id;

    // 命中语义重复但标题措辞不同（isSameTitle 为 false），显式指定 supersede: true
    const mem1Supersede = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "Redis 会话架构指南", // 标题不一致，但命中语义重复
      content: "采用 Redis 缓存会话数据，集群架构部署，支持跨机房多活与主从热备",
      tags: "cluster, multi-dc",
      related_entities: "Redis Sentinel",
      supersede: true, // 显式指示
    }, {}));

    assert.strictEqual(
      mem1Supersede.action,
      "ENRICHED",
      "【反证门 2.1 通过】：即便标题不一致，只要显式传 supersede: true，必须进入 ENRICHED 融合！"
    );
    assert.strictEqual(mem1Supersede.id, mem1Id, "ENRICHED 保留原主键 ID");
    assert.strictEqual(mem1Supersede.revision, 2, "revision 递增为 2");

    const checkMem1 = rowsOf(await env.client.list("memories", { id: mem1Id, limit: 1 }))[0];
    assert.ok(checkMem1.content.includes("跨机房多活"), "正文内容已成功融合新细节");
    assert.ok(checkMem1.tags.includes("redis") && checkMem1.tags.includes("multi-dc"), "tags 必须融合并集");
    assert.ok(checkMem1.related_entities.includes("Redis") && checkMem1.related_entities.includes("Sentinel"), "entities 必须融合并集");
    console.log("  ✓ 2.1 标题不同显式 supersede: true 成功触发 ENRICHED 验证通过！");

    // 2.2 NOOP 分支合并 tags 与 related_entities 回写反证
    const mem2Init = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "前端代码规范检查",
      content: "统一使用 ESLint 进行代码规范静态扫描",
      tags: "eslint, linter",
      related_entities: "ESLint",
    }, {}));
    const mem2Id = mem2Init.id;

    // 微小修改且未传 supersede -> 触发 NOOP，传入新 tags 与新 entities
    const mem2Noop = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "前端代码规范检查",
      content: "统一使用 ESLint 进行代码规范静态扫描。", // 微小改动
      tags: "style, linter",
      related_entities: "Prettier, ESLint",
    }, {}));

    assert.strictEqual(mem2Noop.action, "NOOP", "微小修改必须维持 NOOP");
    assert.strictEqual(mem2Noop.id, mem2Id, "NOOP 指向原记录");
    assert.strictEqual(mem2Noop.recurrence, 2, "NOOP 累加 recurrence");

    const checkMem2 = rowsOf(await env.client.list("memories", { id: mem2Id, limit: 1 }))[0];
    // 正文绝不被覆盖
    assert.strictEqual(checkMem2.content, "统一使用 ESLint 进行代码规范静态扫描", "【反证门 2.2a 通过】：NOOP 下正文严禁被微小修改覆盖");
    // tags 与 entities 必须取并集回写
    assert.ok(
      checkMem2.tags.includes("eslint") && checkMem2.tags.includes("style") && checkMem2.tags.includes("linter"),
      "【反证门 2.2b 通过】：NOOP 分支必须将本次传入的 tags 取并集回写入库！"
    );
    assert.ok(
      checkMem2.related_entities.includes("ESLint") && checkMem2.related_entities.includes("Prettier"),
      "【反证门 2.2c 通过】：NOOP 分支必须将本次传入的 related_entities 取并集回写入库！"
    );
    console.log("  ✓ 2.2 NOOP 分支 tags 与 related_entities 并集回写反证通过！");

    // =============================================================
    // 3. EVO-9a: 冲突感知与显式指定 supersede_id 双向反证
    // =============================================================
    console.log("\n▶ [Test 3] EVO-9a 冲突感知与显式指定 supersede_id 双向反证...");

    // 3.1 真冲突时 ADD 附带 conflict_candidates 反证
    const port80Res = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "网关服务端口监听配置",
      content: "网关服务生产环境默认监听 80 端口",
    }, {}));
    assert.strictEqual(port80Res.action, "ADD", "首条端口配置入库应为 ADD");
    const port80Id = port80Res.id;

    // 存入同主题但含冲突端口（8080 vs 80）的新配置
    const port8080Res = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "网关服务端口配置规范", // 相似主题
      content: "网关服务升级后调整为默认监听 8080 端口，前端代理使用反向转发",
    }, {}));

    assert.strictEqual(port8080Res.action, "ADD", "新配置作为 ADD 入库");
    assert.ok(
      Array.isArray(port8080Res.conflict_candidates) && port8080Res.conflict_candidates.length > 0,
      "【反证门 3.1 通过】：存在配置数字冲突时，ADD 返回体必须附带 conflict_candidates！"
    );
    assert.strictEqual(port8080Res.conflict_candidates[0].id, port80Id, "冲突候选必须准确命中旧记录 ID");
    assert.ok(
      port8080Res.note && port8080Res.note.includes("可能存在配置冲突"),
      "必须在 note 提示可能存在配置冲突，建议用 supersede_id 取代或 memory_forget 淘汰"
    );
    console.log("  ✓ 3.1 真冲突检测反证通过（成功附带 conflict_candidates 与建议提示）");

    // 3.2 无冲突时 conflict_candidates 必须为空反证
    const noConflictRes = parseOut(await memSave.execute({
      project: env.project,
      category: "preference",
      title: "数据库全量备份时间规范",
      content: "数据库生产环境每日凌晨 03:00 自动执行全量备份与冷备快照",
    }, {}));
    assert.strictEqual(noConflictRes.action, "ADD", "独立事实入库为 ADD");
    assert.ok(
      !noConflictRes.conflict_candidates || noConflictRes.conflict_candidates.length === 0,
      "【反证门 3.2 通过】：无配置冲突时，conflict_candidates 必须严格为空！"
    );
    assert.ok(
      !noConflictRes.note || !noConflictRes.note.includes("可能存在配置冲突"),
      "无冲突时不应出现冲突警告提示"
    );
    console.log("  ✓ 3.2 无冲突反证通过（conflict_candidates 严格为空）");

    // 3.3 显式指定 supersede_id 取代旧记录反证
    const newPortId = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "网关服务最终监听端口",
      content: "经架构委员会审批，网关服务最终统一监听 8443 安全端口",
      supersede_id: port80Id, // 显式取代 80 端口旧记录
    }, {}));

    assert.strictEqual(newPortId.action, "UPDATE", "显式 supersede_id 取代应返回 UPDATE");
    assert.strictEqual(newPortId.superseded_id, port80Id, "返回体必须指出被取代的旧 ID");

    // 验证数据库中旧记录软失效状态与 invalid_reason
    const checkOldPort = rowsOf(await env.client.list("memories", { id: port80Id, limit: 1 }))[0];
    assert.strictEqual(checkOldPort.lifecycle_status, "superseded", "旧记录状态必须标记为 superseded");
    assert.strictEqual(
      checkOldPort.invalid_reason,
      `superseded-by:${newPortId.id}`,
      "【反证门 3.3 通过】：invalid_reason 必须精确记录为 superseded-by:<newId>！"
    );
    assert.strictEqual(checkOldPort.superseded_by_id, newPortId.id, "superseded_by_id 外键列必须正确记录新记录 ID");
    assert.ok(checkOldPort.invalid_at != null, "invalid_at 必须已记录时间戳");
    console.log("  ✓ 3.3 supersede_id 显式取代反证通过（旧记录软失效且 invalid_reason 为 superseded-by:<newId>）");

    // =============================================================
    // 4. 元规范自检与零残留
    // =============================================================
    console.log("\n▶ [自检] test_meta 规范合规自检与零残留断言...");
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
console.log("✅ v6.37-a 写入链路全部双向反证门 100% 顺利通过！");
console.log("=================================================================");
