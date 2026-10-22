/**
 * tests/test_v6300_milestone_gate.mjs
 * ============================================================================
 * v6.30.0 里程碑红队对抗靶场门禁套件 (Milestone Gate)
 *
 * 【红队使命】
 * 针对 v6.30.0 核心架构整改点，实施独立、严苛、背靠背的反证对抗测试，
 * 建立零宽容验证靶场，严禁弱化断言与静默吞错，杜绝任何假过假放行。
 *
 * 【覆盖的 8 大核心红队反证靶场】
 *   1. 靶子 1 (中文无空格自然问句检索):
 *      - 输入 query: "端口冲突怎么处理"
 *      - 目标命中: 标题为 "Nginx 端口冲突解决方案" 的记忆
 *      - 验证点: Bigram 双字切词与常见疑问虚词剥离有效，杜绝自然中文问句零召回。
 *   2. 靶子 2 (软失效踩坑防死循环复活):
 *      - 验证已标记 invalid_at 的踩坑记录绝不能被 pitfall_save 命中为 NOOP 且不清除 invalid_at。
 *   3. 靶子 3 (memoryAuditUndo 复发计数数学守恒):
 *      - 构造合并副本 recurrence=3，撤销后主记录必须准确扣减 3，而不是只扣 1，确保数学守恒。
 *   4. 靶子 4 (scrubSecrets 全格式脱敏靶场):
 *      - 构造包含 AWS Key (AKIA...)、长 JWT、Slack Token、Postgres 连接串明文密码的文本，
 *        验证脱敏后必须 100% 替换为 ***REDACTED***。
 *   5. 靶子 5 (db_reset 越权跨库防御靶场):
 *      - 传入非当前配置的目标数据库名，验证必须抛错拦截，杜绝越权跨库清库。
 *   6. 靶子 6 (harvest_gateway 根目录路径穿越拦截):
 *      - 传入 dir: "/" 或 dir: "/etc" 等系统敏感路径，验证必须安全拦截抛错。
 *   7. 靶子 7 (state.json 损坏自愈靶场):
 *      - 故意写入非法 JSON 损坏 state.json，调用 readState() 验证绝不能将其抹平成空对象，
 *        必须生成 .corrupt 备份并尝试从 .bak 恢复。
 *   8. 靶子 8 (内存提炼脚手架污染与超时防御):
 *      - 构造带有 [Persistent Memory Context]、[Memory Agent Guide]、
 *        --- Context from the delegating agent --- 的复杂长文本，
 *        断言 stripScaffolding 100% 剥离脚手架，绝不泄漏至提炼 Prompt；
 *      - 断言 harvestWithOnlineModel 默认超时为 30000ms（30s），杜绝 12s 假超时导致网关 499。
 *
 * 【规范遵从】
 *   - 符合 tests/test_meta.mjs 规范：零外网依赖、环境隔离、严格 cleanup、残余断言 (residue === 0)。
 * ============================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MagpieMemoryHub, memoryAuditUndo } from "../tools.js";
import { createTestEnv } from "./lib/testenv.mjs";
import { dbReset } from "../src/integration/db-tools.js";
import { harvestGateway, stripScaffolding } from "../src/services/harvest/index.js";
import { scrubSecrets, harvestWithOnlineModel } from "../gateway_harvest.hooks.js";
import {
  readState,
  writeState,
  statePath,
  _resetStateCacheForTests,
  STATE_DIRNAME,
  STATE_FILENAME,
} from "../src/core/state.js";

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

const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []);

// ============================================================================
// 靶子 1: 中文无空格自然问句检索 (Natural Chinese Bigram Search)
// ============================================================================
async function testTarget1_ChineseBigramSearch(env, hub) {
  console.log("\n=======================================================");
  console.log("【靶子 1】中文无空格自然问句检索 (Natural Chinese Bigram Search)");
  console.log("=======================================================");

  // 1. 写入标题为 "Nginx 端口冲突解决方案" 的有效记忆
  const memRes = parseOut(
    await hub.tool.memory_save.execute({
      project: env.project,
      category: "decision",
      title: "Nginx 端口冲突解决方案",
      content: "修改 nginx.conf 中的 listen 80 为 8080 端口，重启服务即可解决端口冲突问题",
      tags: "nginx,port,network",
    })
  );
  assert.ok(memRes.id, "记忆写入必须成功并返回 id");

  // 2. 靶向测试：无空格自然中文问句 "端口冲突怎么处理"（虚词剥离 + Bigram 切词）
  const query = "端口冲突怎么处理";
  const searchRes = parseOut(
    await hub.tool.memory_search.execute({
      query,
      project: env.project,
      limit: 10,
      search_rerank: false, // 纯词面打分测试
    })
  );

  const memories = Array.isArray(searchRes.memories) ? searchRes.memories : searchRes;
  const hit = memories.some((m) => m.title && m.title.includes("Nginx 端口冲突解决方案"));
  assert.ok(
    hit,
    `[红队反证击穿] 输入 query: "${query}" 未能召回标题为 "Nginx 端口冲突解决方案" 的记忆！Bigram 切词或虚词剥离失效。返回结果: ${JSON.stringify(memories)}`
  );
  console.log(`  ✓ 成功召回: "${query}" -> 命中 "${memories[0].title}" (score > 0)`);

  // 3. 反证测试：完全不相关的自然语言问句绝不能误命中该记忆
  const badQuery = "Kafka 分区消费性能调优最佳实践";
  const badRes = parseOut(
    await hub.tool.memory_search.execute({
      query: badQuery,
      project: env.project,
      limit: 10,
      search_rerank: false,
    })
  );
  const badMemories = Array.isArray(badRes.memories) ? badRes.memories : badRes;
  const badHit = badMemories.some((m) => m.title && m.title.includes("Nginx 端口冲突解决方案"));
  assert.strictEqual(badHit, false, "[反证门失败] 不相干的 query 故意传入却误命中了 Nginx 记忆！");
  console.log(`  ✓ 反证通过：不相关 query "${badQuery}" 准确排除 Nginx 记忆`);
  console.log("  ✓ 靶子 1 通过：Bigram 双字切词与常见疑问虚词剥离验证通过！");
}

// ============================================================================
// 靶子 2: 软失效踩坑防死循环复活 (Soft-invalidated Pitfall Anti-Zombie Protection)
// ============================================================================
async function testTarget2_SoftInvalidatedPitfallRevival(env, hub) {
  console.log("\n=======================================================");
  console.log("【靶子 2】软失效踩坑防死循环复活 (Soft-invalidated Pitfall Anti-Zombie Protection)");
  console.log("=======================================================");

  const symptom = "PostgreSQL 5432 端口被占用服务启动失败";
  const solution = "kill -9 占用进程或修改 port = 5433";

  // 1. 直接在数据库中构造一条已标记 invalid_at 的软失效踩坑记录
  const nowStr = new Date().toISOString().slice(0, 19).replace("T", " ");
  const initialInvalidPit = await env.client.create("pitfalls", {
    project: env.project,
    client: "test",
    component: "postgres",
    symptom,
    solution,
    root_cause: symptom,
    recurrence: 1,
    invalid_at: nowStr,
    invalid_reason: "user_marked_invalid",
    created_at: nowStr,
    updated_at: nowStr,
  });
  const pitId = initialInvalidPit.id;
  assert.ok(pitId, "初始软失效踩坑记录必须创建成功");

  // 验证当前库中该记录已处于软失效状态
  const checkInvalid = rowsOf(await env.client.list("pitfalls", { project: env.project, id: pitId }));
  assert.ok(checkInvalid[0].invalid_at, "该记录必须成功处于软失效状态");

  // 2. 再次发生该踩坑并调用 pitfall_save
  // 必须验证：绝不能将软失效记录命中为 NOOP 且不清除 invalid_at（防止死循环僵尸记录）
  const saveRes2 = parseOut(
    await hub.tool.pitfall_save.execute({
      project: env.project,
      component: "postgres",
      symptom,
      solution,
    })
  );

  // 检查当前库中针对该 symptom 的可用活跃记录状态
  const activePitfalls = rowsOf(await env.client.list("pitfalls", { project: env.project })).filter(
    (p) => p.symptom === symptom && !p.invalid_at
  );

  assert.ok(
    activePitfalls.length >= 1,
    `[红队反证击穿] 软失效记录在 pitfall_save 后未产生可用活跃记录！返回结果: ${JSON.stringify(saveRes2)}`
  );

  // 若返回了原来的 ID，则 invalid_at 必须被清空复活；若返回了新 ID，新记录必须有效且非软失效
  if (saveRes2.id === pitId) {
    const refreshed = rowsOf(await env.client.list("pitfalls", { project: env.project, id: pitId }))[0];
    assert.strictEqual(refreshed.invalid_at, null, "若复用原 ID，invalid_at 必须被清除激活");
  } else {
    assert.ok(saveRes2.id !== null, "必须创建新记录并返回合法 id");
  }

  // 3. 反证测试：对于正常活跃记录，重复写入必须触发 NOOP 累加 recurrence
  // 此时 activePitfalls[0] 已是活跃记录，写入前清理指纹缓存
  const activeSymptom = "MySQL 3306 慢查询报警处理";
  const activeSolution = "添加复合索引 idx_user_status_created";
  const activePit1 = await env.client.create("pitfalls", {
    project: env.project,
    client: "test",
    component: "mysql",
    symptom: activeSymptom,
    solution: activeSolution,
    root_cause: activeSymptom,
    recurrence: 1,
    invalid_at: null,
    created_at: nowStr,
    updated_at: nowStr,
  });
  assert.ok(activePit1.id, "活跃踩坑记录创建成功");

  // 对已知活跃踩坑再次调用 pitfall_save，验证能够命中已有记录并正常累加 recurrence
  const saveRes3 = parseOut(
    await hub.tool.pitfall_save.execute({
      project: env.project,
      component: "mysql",
      symptom: activeSymptom,
      solution: activeSolution,
    })
  );
  assert.strictEqual(saveRes3.action, "NOOP", "[反证门失败] 正常活跃踩坑记录重复写入必须返回 NOOP 累加");
  assert.strictEqual(saveRes3.id, activePit1.id, "NOOP 必须返回原活跃记录 ID");
  console.log("  ✓ 反证通过：活跃踩坑重复写入正确触发 NOOP 累加，软失效记录绝无卡死僵尸现象");
  console.log("  ✓ 靶子 2 通过：软失效踩坑防死循环复活机制验证通过！");
}

// ============================================================================
// 靶子 3: memoryAuditUndo 复发计数数学守恒 (Recurrence Mathematical Conservation)
// ============================================================================
async function testTarget3_RecurrenceMathConservation(env) {
  console.log("\n=======================================================");
  console.log("【靶子 3】memoryAuditUndo 复发计数数学守恒 (Recurrence Mathematical Conservation)");
  console.log("=======================================================");

  // 1. 构造主记录 A：recurrence = 4
  const primaryMem = await env.client.create("memories", {
    project: env.project,
    category: "decision",
    title: "Kafka 分区再均衡调优实践",
    content: "调大 heartbeat.interval.ms 与 session.timeout.ms",
    recurrence: 4,
    invalid_at: null,
    lifecycle_status: "active",
  });
  const primaryId = primaryMem.id;

  // 2. 构造去重合并软失效副本 B：自身 recurrence = 3
  // 模拟由 batchTs = 1792400000000 合并进入主记录 A
  const batchTs = 1792400000000;
  const duplicateMem = await env.client.create("memories", {
    project: env.project,
    category: "decision",
    title: "Kafka 分区再均衡调优方案",
    content: "调大 heartbeat.interval.ms 与 session.timeout.ms",
    recurrence: 3,
    invalid_at: "2026-10-19 12:00:00",
    invalid_reason: `dedup:${batchTs}:into:${primaryId}`,
    lifecycle_status: "superseded",
  });

  // 3. 执行撤销去重回滚
  const undoResult = parseOut(
    await memoryAuditUndo(
      env.client,
      { project: env.project },
      { project: env.project, undo_before: String(batchTs) }
    )
  );

  console.log("  撤销执行结果:", undoResult.note || undoResult);
  assert.strictEqual(undoResult.success, true, "撤销去重任务必须返回 success: true");

  // 4. 校验副本 B 必须恢复为 active 且 invalid_at 为 null
  const restoredB = rowsOf(await env.client.list("memories", { project: env.project, id: duplicateMem.id }))[0];
  assert.strictEqual(restoredB.invalid_at, null, "副本 B 的 invalid_at 必须恢复为 null");
  assert.strictEqual(restoredB.lifecycle_status, "active", "副本 B 的 lifecycle_status 必须恢复为 active");

  // 5. 核心数学守恒断言：
  // 主记录原 recurrence = 4，合并副本 recurrence = 3，撤销后主记录必须扣减 3 恢复为 1 (4 - 3 = 1)！
  // 绝不能只扣减 1 变成 3 (4 - 1 = 3)！
  const refreshedPrimary = rowsOf(await env.client.list("memories", { project: env.project, id: primaryId }))[0];
  const finalRecurrence = Number(refreshedPrimary.recurrence);
  console.log(`  主记录 recurrence 变化: 4 -> ${finalRecurrence} (期望: 1)`);

  assert.strictEqual(
    finalRecurrence,
    1,
    `[红队反证击穿] 数学守恒破产！撤销 recurrence=3 的合并副本后，主记录 recurrence 为 ${finalRecurrence}，期望精准扣减为 1！`
  );
  assert.strictEqual(undoResult.undone_recurrence, 3, "撤销汇总指标 undone_recurrence 必须准确等于 3");

  console.log("  ✓ 靶子 3 通过：去重撤销 recurrence 数学守恒验证通过！");
}

// ============================================================================
// 靶子 4: scrubSecrets 全格式脱敏靶场 (Universal Secret Scrubbing)
// ============================================================================
async function testTarget4_UniversalSecretScrubbing(env, hub) {
  console.log("\n=======================================================");
  console.log("【靶子 4】scrubSecrets 全格式脱敏靶场 (Universal Secret Scrubbing)");
  console.log("=======================================================");

  // 构造包含各类真实工业级凭据格式的恶意/泄露文本样本
  const awsKey1 = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
  const awsKey2 = ["AS", "IA", "IOSFODNN7EXAMPLE"].join("");
  const slackToken = ["xo", "xb-", "123456789012-", "1234567890123-", "abcdefghijklmnopqrstuvwx"].join("");
  const longJwt = ["ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.", "ey", "JzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join("");
  const pgConnStr = "postgres://user_admin:SuperSecretPass123!@127.0.0.1:5432/production_db";
  const cnSecret = "生产环境数据库密码是 MySecretPassw0rd999";

  const rawPoisonedText = `
部署配置清单：
1. AWS Access Key 1: ${awsKey1}
2. AWS Session Key: ${awsKey2}
3. Slack Bot: ${slackToken}
4. Auth JWT: ${longJwt}
5. 数据库连接串: ${pgConnStr}
6. 中文凭据口令: ${cnSecret}
7. 普通安全公开地址: https://github.com/my-org/open-project
`.trim();

  // 1. 函数级脱敏断言 (scrubSecrets)
  const scrubbed = scrubSecrets(rawPoisonedText);

  assert.ok(!scrubbed.includes(awsKey1), `[脱敏失败] AWS Key 1 未被脱敏: ${awsKey1}`);
  assert.ok(!scrubbed.includes(awsKey2), `[脱敏失败] AWS Key 2 未被脱敏: ${awsKey2}`);
  assert.ok(!scrubbed.includes("SuperSecretPass123!"), "[脱敏失败] 数据库明文密码未被脱敏！");
  assert.ok(!scrubbed.includes(longJwt), "[脱敏失败] 三段式长 JWT 未被脱敏！");
  assert.ok(!scrubbed.includes("abcdefghijklmnopqrstuvwx"), "[脱敏失败] Slack Bot Token 未被脱敏！");
  assert.ok(!scrubbed.includes("MySecretPassw0rd999"), "[脱敏失败] 中文口令密码未被脱敏！");

  // 验证替换为 ***REDACTED***
  assert.ok(scrubbed.includes("***REDACTED***"), "必须包含 ***REDACTED*** 占位符");

  // 2. 端到端入库脱敏校验 (memory_save / pitfall_save)
  const saveRes = parseOut(
    await hub.tool.memory_save.execute({
      project: env.project,
      category: "fact",
      title: "生产数据库与第三方凭据记录",
      content: rawPoisonedText,
    })
  );
  assert.ok(saveRes.id, "脱敏后必须成功入库");

  const storedMem = rowsOf(await env.client.list("memories", { project: env.project, id: saveRes.id }))[0];
  assert.ok(!storedMem.content.includes(awsKey1), "入库 content 严禁包含 AWS Key 1");
  assert.ok(!storedMem.content.includes("SuperSecretPass123!"), "入库 content 严禁包含明文数据库密码");
  assert.ok(!storedMem.content.includes(longJwt), "入库 content 严禁包含长 JWT");
  assert.ok(!storedMem.content.includes("abcdefghijklmnopqrstuvwx"), "入库 content 严禁包含 Slack Token");
  assert.ok(!storedMem.content.includes("MySecretPassw0rd999"), "入库 content 严禁包含中文口令明文");

  // 3. 反证测试：普通无敏感信息的文本绝不能被误删误篡改
  assert.ok(
    scrubbed.includes("https://github.com/my-org/open-project"),
    "[反证门失败] 普通合法 URL 遭遇误脱敏篡改！"
  );
  console.log("  ✓ 反证通过：普通公开 URL 保留完好，5 种全格式凭据 100% 被替换为 ***REDACTED***");
  console.log("  ✓ 靶子 4 通过：scrubSecrets 全格式脱敏靶场通过！");
}

// ============================================================================
// 靶子 5: db_reset 越权跨库防御靶场 (Cross-Database Reset Prevention)
// ============================================================================
async function testTarget5_CrossDatabaseResetDefense() {
  console.log("\n=======================================================");
  console.log("【靶子 5】db_reset 越权跨库防御靶场 (Cross-Database Reset Prevention)");
  console.log("=======================================================");

  const legitDb = "41694_agent_memory";
  const cfg = {
    instance: legitDb,
    ncb_instance: legitDb,
    mcp_key: "mock_test_mcp_token",
  };

  // 故意传入非当前配置的目标数据库名
  const rogueDb = "other_user_production_db";

  let caughtError = null;
  try {
    await dbReset(cfg, {
      database: rogueDb,
      confirm: "RESET",
    });
  } catch (err) {
    caughtError = err;
  }

  assert.ok(
    caughtError !== null,
    `[红队反证击穿] db_reset 传入外来数据库名 '${rogueDb}' 竟然未抛错拦截！存在跨库越权破坏风险！`
  );
  console.log(`  ✓ 越权拦截成功: ${caughtError.message}`);

  // 反证测试：传入合法的自身当前配置数据库名，不会因跨库越权检查而报错
  // （在未真正执行破坏的情况下验证参数校验通过）
  let legitErr = null;
  try {
    // 传入未 confirm 的合法库名，验证不会报跨库越权错
    const checkRes = await dbReset(cfg, { database: legitDb, confirm: "" });
    assert.strictEqual(checkRes.action, "CONFIRM_REQUIRED", "合法库名应正常返回确认提示");
  } catch (err) {
    legitErr = err;
  }
  assert.strictEqual(legitErr, null, "[反证门失败] 合法配置数据库名不应被误判为跨库越权！");
  console.log("  ✓ 反证通过：自身合法配置数据库名正常通过权限检查");
  console.log("  ✓ 靶子 5 通过：db_reset 越权跨库防御靶场通过！");
}

// ============================================================================
// 靶子 6: harvest_gateway 根目录路径穿越拦截 (Path Traversal Prevention)
// ============================================================================
async function testTarget6_HarvestPathTraversalDefense(env) {
  console.log("\n=======================================================");
  console.log("【靶子 6】harvest_gateway 根目录路径穿越拦截 (Path Traversal Prevention)");
  console.log("=======================================================");

  const dangerousPaths = ["/", "/etc", "/root"];

  for (const dangerousPath of dangerousPaths) {
    let caughtErr = null;
    try {
      await harvestGateway(
        { dir: dangerousPath, project: env.project },
        { client: env.client, cfg: { project: env.project }, saveMemory: async () => ({ id: 1 }), pitfallSave: async () => ({ id: 1 }) }
      );
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(
      caughtErr !== null,
      `[红队反证击穿] harvestGateway 传入系统敏感根路径 '${dangerousPath}' 竟然未安全拦截！`
    );
    console.log(`  ✓ 路径拦截成功: '${dangerousPath}' -> ${caughtErr.message}`);
  }

  // 反证测试：安全临时子目录允许正常解析与处理
  const safeTempDir = path.join(os.tmpdir(), `safe_test_gw_${Date.now()}`);
  fs.mkdirSync(safeTempDir, { recursive: true });
  try {
    let safeErr = null;
    try {
      const safeRes = await harvestGateway(
        { dir: safeTempDir, project: env.project },
        { client: env.client, cfg: { project: env.project }, saveMemory: async () => ({ id: 1 }), pitfallSave: async () => ({ id: 1 }) }
      );
      assert.ok(safeRes && safeRes.success !== undefined, "安全临时目录应正常返回执行结果");
    } catch (err) {
      safeErr = err;
    }
    assert.strictEqual(safeErr, null, `[反证门失败] 安全临时目录 '${safeTempDir}' 被错误拦截: ${safeErr?.message}`);
    console.log(`  ✓ 反证通过：合法安全目录正常放行，无路径越权误报`);
  } finally {
    try {
      fs.rmSync(safeTempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      void cleanupErr;
    }
  }

  console.log("  ✓ 靶子 6 通过：harvest_gateway 路径穿越与根目录防御靶场通过！");
}

// ============================================================================
// 靶子 7: state.json 损坏自愈靶场 (State Corruption Self-Healing)
// ============================================================================
async function testTarget7_StateCorruptionSelfHealing() {
  console.log("\n=======================================================");
  console.log("【靶子 7】state.json 损坏自愈靶场 (State Corruption Self-Healing)");
  console.log("=======================================================");

  const sp = statePath();
  assert.ok(sp, "必须能够获取 statePath");

  const dir = path.dirname(sp);
  fs.mkdirSync(dir, { recursive: true });

  // 1. 保存现场（原始 state.json 与 state.json.bak）
  const origState = fs.existsSync(sp) ? fs.readFileSync(sp, "utf8") : null;
  const bakPath = sp + ".bak";
  const origBak = fs.existsSync(bakPath) ? fs.readFileSync(bakPath, "utf8") : null;

  try {
    // 2. 写入已知的有效 .bak 备份
    const knownGoodBak = {
      current: "test_bak_inst",
      secrets: { backup_key: "preserved_val" },
      actions: { lastDoneId: "done_123" },
      _ok: true,
    };
    fs.writeFileSync(bakPath, JSON.stringify(knownGoodBak), "utf8");

    // 3. 故意写入非法 JSON 损坏 state.json
    fs.writeFileSync(sp, "{{{<<< ILLEGAL CORRUPTED JSON CONTENT >>>}}}", "utf8");
    _resetStateCacheForTests();

    // 4. 调用 readState()
    const st = readState();

    // 断言 1: 必须生成 .corrupt 备份文件
    const files = fs.readdirSync(dir);
    const corruptBackups = files.filter((f) => f.startsWith(STATE_FILENAME + ".corrupt"));
    assert.ok(
      corruptBackups.length >= 1,
      `[红队反证击穿] state.json 损坏时未生成 .corrupt 备份文件！目录内容: ${files.join(", ")}`
    );
    console.log(`  ✓ 成功生成损坏快照备份: ${corruptBackups[corruptBackups.length - 1]}`);

    // 断言 2: 绝不能抹平为空对象，必须从 .bak 恢复有效数据
    assert.strictEqual(
      st.secrets?.backup_key,
      "preserved_val",
      "[红队反证击穿] readState 未能从 state.json.bak 恢复数据，历史状态被抹平！"
    );
    console.log("  ✓ 成功从 state.json.bak 恢复历史状态与凭据缓存");

    // 5. 反证测试：当 state.json 完好无损时，readState 正常加载且绝不产生新的 .corrupt 文件
    const corruptCountBefore = fs.readdirSync(dir).filter((f) => f.startsWith(STATE_FILENAME + ".corrupt")).length;
    fs.writeFileSync(sp, JSON.stringify({ current: "intact_state", secrets: { ok: true } }), "utf8");
    _resetStateCacheForTests();
    const intactSt = readState();
    assert.strictEqual(intactSt.current, "intact_state", "正常 state 必须正常读取");
    const corruptCountAfter = fs.readdirSync(dir).filter((f) => f.startsWith(STATE_FILENAME + ".corrupt")).length;
    assert.strictEqual(corruptCountAfter, corruptCountBefore, "[反证门失败] 正常文件读取时不应生成 .corrupt 备份！");
    console.log("  ✓ 反证通过：未损坏状态文件正常加载，不生成任何额外 .corrupt 备份");

    // 清理本次测试生成的 .corrupt 测试文件
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(STATE_FILENAME + ".corrupt")) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch (unlinkErr) {
          void unlinkErr;
        }
      }
    }
  } finally {
    // 恢复现场
    if (origState !== null) {
      fs.writeFileSync(sp, origState, "utf8");
    } else {
      try {
        fs.unlinkSync(sp);
      } catch (unlinkErr) {
        void unlinkErr;
      }
    }
    if (origBak !== null) {
      fs.writeFileSync(bakPath, origBak, "utf8");
    } else {
      try {
        fs.unlinkSync(bakPath);
      } catch (unlinkErr) {
        void unlinkErr;
      }
    }
    _resetStateCacheForTests();
  }

  console.log("  ✓ 靶子 7 通过：state.json 损坏自愈与防抹平保护验证通过！");
}

// ============================================================================
// 靶子 8: 内存提炼脚手架污染与超时防御 (Memory Harvest Scaffolding Strip & 30s Timeout)
// ============================================================================
async function testTarget8_HarvestScaffoldingAndTimeout() {
  console.log("\n=======================================================");
  console.log("【靶子 8】内存提炼脚手架污染与超时防御 (Scaffolding Strip & 30s Timeout)");
  console.log("=======================================================");

  // 1. 脚手架污染剥离验证
  const rawDialogueWithScaffolding = `
[Persistent Memory Context]
- 【避坑准则】生产容器禁止直接绑定 127.0.0.1，应配置反向代理
- 【系统偏好】默认使用 41694_agent_memory 实例

[Memory Agent Guide —— 检索与沉淀]
1. 优先检索：排查报错前优先调用 memory_context
2. 及时沉淀：产出新结论及时调用 memory_save
无相关需求时忽略本提示，绝不为了凑数操作。

--- Context from the delegating agent ---
云端沙箱 ID：832efdf46c8b46a6891eea0a42afeb6d
沙箱执行范式：aiod-cli exec
分支：feat/v6300-qa-and-docs

用户真实问题：排查发现 Redis 6379 端口连接池耗尽导致前端 500 报错，已确认是 max_connections 配置过小，修改为 500 后恢复。
`.trim();

  const stripped = stripScaffolding(rawDialogueWithScaffolding);

  // 必须断言三大脚手架头 100% 被清洗剥离
  assert.ok(
    !stripped.includes("[Persistent Memory Context]"),
    "[红队反证击穿] stripScaffolding 未剥离 [Persistent Memory Context]！"
  );
  assert.ok(
    !stripped.includes("[Memory Agent Guide"),
    "[红队反证击穿] stripScaffolding 未剥离 [Memory Agent Guide]！"
  );
  assert.ok(
    !stripped.includes("--- Context from the delegating agent ---"),
    "[红队反证击穿] stripScaffolding 未剥离 '--- Context from the delegating agent ---'！"
  );
  assert.ok(
    !stripped.includes("云端沙箱 ID：832efdf46c8b46a6891eea0a42afeb6d"),
    "[红队反证击穿] 代理任务元信息泄露进清洗结果！"
  );

  // 用户核心对话内容必须 100% 完好保留
  assert.ok(
    stripped.includes("用户真实问题：排查发现 Redis 6379 端口连接池耗尽导致前端 500 报错"),
    "真实对话核心知识必须完整保留"
  );
  console.log("  ✓ stripScaffolding 成功剥离三大注入脚手架，用户真实报错提炼文本保留完好！");

  // 2. harvestWithOnlineModel 默认超时断言 (30000ms / 30s)
  // 通过模拟 fetch 拦截 options，捕获 AbortSignal 超时时间，杜绝 12000ms 假超时导致的网关 499
  let observedTimeoutMs = null;
  const mockFetch = async (_url, init) => {
    // 从 context 中探测有效 signal 或模拟打桩
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ facts: [], decisions: [], pitfalls: [] }),
            },
          },
        ],
      }),
    };
  };

  // 通过检查代码与实测，验证 harvestWithOnlineModel 的超时参数默认取 30000
  // 测试传入空 harvest_timeout_ms
  const origSetTimeout = globalThis.setTimeout;
  let timerMsCaptured = null;
  globalThis.setTimeout = (cb, ms) => {
    if (typeof ms === "number" && (ms === 30000 || ms === 12000)) {
      timerMsCaptured = ms;
    }
    return origSetTimeout(cb, ms);
  };

  try {
    await harvestWithOnlineModel("测试文本内容足够用于模型提炼", {
      extract_model: "test-model",
      _fetch: mockFetch,
    });
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }

  assert.strictEqual(
    timerMsCaptured,
    30000,
    `[红队反证击穿] harvestWithOnlineModel 默认超时为 ${timerMsCaptured}ms，必须为 30000ms (30s)！杜绝 12s 假超时导致网关 499 故障。`
  );
  console.log(`  ✓ harvestWithOnlineModel 默认超时已确认为 30000ms (30s)`);

  console.log("  ✓ 靶子 8 通过：脚手架污染彻底清洗 & 30s 超时防 499 机制验证通过！");
}

// ============================================================================
// 主执行入口
// ============================================================================
async function run() {
  console.log("=================================================================");
  console.log("【v6.30.0 里程碑红队对抗门禁套件 tests/test_v6300_milestone_gate.mjs 启动】");
  console.log("=================================================================");

  const env = await createTestEnv({ mode: "memory" });
  console.log(`[Gate Init] 隔离命名空间: ${env.project}`);

  const hub = await env.createHub();

  try {
    await testTarget1_ChineseBigramSearch(env, hub);
    await testTarget2_SoftInvalidatedPitfallRevival(env, hub);
    await testTarget3_RecurrenceMathConservation(env);
    await testTarget4_UniversalSecretScrubbing(env, hub);
    await testTarget5_CrossDatabaseResetDefense();
    await testTarget6_HarvestPathTraversalDefense(env);
    await testTarget7_StateCorruptionSelfHealing();
    await testTarget8_HarvestScaffoldingAndTimeout();

    console.log("\n=================================================================");
    console.log("【红队独立质检靶场测试结果总览】");
    console.log("=================================================================");
    console.log("✓ [靶子 1] 中文无空格自然问句检索 (Bigram 切词): PASS (GREEN)");
    console.log("✓ [靶子 2] 软失效踩坑防死循环复活: PASS (GREEN)");
    console.log("✓ [靶子 3] memoryAuditUndo 复发计数数学守恒: PASS (GREEN)");
    console.log("✓ [靶子 4] scrubSecrets 全格式脱敏靶场: PASS (GREEN)");
    console.log("✓ [靶子 5] db_reset 越权跨库防御靶场: PASS (GREEN)");
    console.log("✓ [靶子 6] harvest_gateway 根目录路径穿越拦截: PASS (GREEN)");
    console.log("✓ [靶子 7] state.json 损坏自愈靶场: PASS (GREEN)");
    console.log("✓ [靶子 8] 内存提炼脚手架污染与超时防御: PASS (GREEN)");
    console.log("=================================================================");
    console.log("统计: 共运行 8 个核心靶场，通过 8 个，反证缺陷暴露 0 个");
    console.log("=================================================================");
    console.log("\n🎉 [红队门禁放行] v6.30.0 里程碑核心靶场全部 GREEN 放行！");
  } finally {
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, `[残余断言失败] 测试结束后仍有 ${residue.total} 条残留！`);
    console.log(`✓ [隔离清理断言] 环境清理完成，残余确认为 0 条。`);
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ [GATE FAIL] 红队门禁反证拦截失败:", err);
    process.exit(1);
  });
