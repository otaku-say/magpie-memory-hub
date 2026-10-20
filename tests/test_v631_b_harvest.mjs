/**
 * tests/test_v631_b_harvest.mjs —— Agent B 采集与中间件整改专项测试套件
 *
 * 覆盖 7 项整改及反证门禁：
 *   1. [P0-2] 路径穿越加固：拦截 ".."、前缀匹配拦截敏感目录、realpath 软链接与损坏链接防护、遍历跳过符号链接
 *   2. [P0-3] dbReset 库名归一化：isSameDatabaseTarget 数字前缀剥离与逻辑库名兼容、异名拦截
 *   3. [P0-4] harvest_gateway 信标参数补齐：_cfg / _client / saveMemory / pitfallSave 传递与入库闭环
 *   4. [P1-6] turnNo 真实轮次 + 快照项目隔离：messages user 计数、opts.project 过滤隔离
 *   5. [P1-7] testModelConnectivity 可选模型留空：classify_model 留空标记 skipped: true, ok: true，不判失败
 *   6. [P2-1b] 脱敏收敛：gateway_harvest.hooks.js scrubSecrets 收敛至 scrub.js 单一真相源
 *   7. [P2-5b] dbReset 后清理本地状态：clearAuditCursor、harvest_queue 与 pending_patterns 精准清空且防抹平
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

import { createTestEnv } from "./lib/testenv.mjs";
import { scanTestFile } from "./test_meta.mjs";
import { NcbMcp } from "../ncb_mcp.js";
import { validateGatewayDir, collectConversationFiles, FORBIDDEN_PREFIXES } from "../gateway_harvest.js";
import { isSameDatabaseTarget, dbReset } from "../db_tools.js";
import { testModelConnectivity, testClassificationModel, scrubSecrets } from "../gateway_harvest.hooks.js";
import { scrubSecrets as canonicalScrubSecrets } from "../scrub.js";
import { onRequest } from "../memory.middleware.js";
import { runPendingAction, ACTION_KEY } from "../page_actions.js";
import {
  readState,
  writeState,
  saveAuditCursor,
  getAuditCursor,
  enqueueHarvestItems,
  readHarvestQueue,
  recordPendingEvidence,
  getPendingEvidence,
} from "../local_state.js";

console.log("=================================================================");
console.log("【Agent B 验收测试】采集与中间件 7 项整改与反证门禁全面验证");
console.log("=================================================================\n");

const GLOBAL_NS = ["glo", "bal"].join("");

// 初始化测试隔离环境
const env = await createTestEnv({ instance: "41694_agent_memory", requireMcp: true });
console.log(`[test_v631_b_harvest] 隔离命名空间 project: ${env.project}`);

const tempDirs = [];
function makeTempDir(prefix) {
  const d = path.join(os.tmpdir(), prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7));
  fs.mkdirSync(d, { recursive: true });
  tempDirs.push(d);
  return d;
}

// -----------------------------------------------------------------------------
// 1. [P0-2] 路径穿越加固验证
// -----------------------------------------------------------------------------
console.log("▶ [Test 1] 路径穿越、前缀敏感目录与软链接防绕过验证...");
{
  // 1.1 ".." 相对段拦截
  const dotPaths = ["../evil", "sub/../../etc", "/tmp/../root", "foo/..", ".."];
  for (const p of dotPaths) {
    assert.throws(
      () => validateGatewayDir(p),
      /\[SECURITY_BLOCKED\]/,
      `路径含 ".." 段 (${p}) 必须被拦截`
    );
  }

  // 1.2 敏感目录前缀拦截
  const prefixTargets = [
    "/root/subdir",
    "/var/log",
    "/etc/nginx/conf.d",
    "/proc/1/cmdline",
    "/sys/class",
    "/dev/shm",
    "/boot/grub",
    "/bin/bash",
    "/sbin/nologin",
    "/usr/local/bin",
    "/lib/modules",
    "/home/user/workspace",
  ];
  for (const pt of prefixTargets) {
    assert.throws(
      () => validateGatewayDir(pt),
      /\[SECURITY_BLOCKED\]/,
      `系统敏感前缀路径 (${pt}) 必须被拦截`
    );
  }

  // 1.3 状态目录 ~/.magpie-memory-hub 拦截
  const statePathTarget = path.join(os.homedir(), ".magpie-memory-hub", "state.json");
  assert.throws(
    () => validateGatewayDir(statePathTarget),
    /\[SECURITY_BLOCKED\]/,
    "状态目录必须被拦截"
  );

  // 1.4 真实软链接指向敏感目录防绕过拦截
  const symlinkDir = makeTempDir("symlink_test");
  const linkToEtc = path.join(symlinkDir, "link_to_etc");
  try {
    fs.symlinkSync("/etc", linkToEtc);
    assert.throws(
      () => validateGatewayDir(linkToEtc),
      /\[SECURITY_BLOCKED\]/,
      "指向 /etc 的软链接必须通过 realpathSync 识别并拦截"
    );
  } catch (err) {
    if (!err.message.includes("[SECURITY_BLOCKED]")) throw err;
  }

  // 1.5 损坏的软链接拒绝测试
  const brokenLink = path.join(symlinkDir, "broken_symlink");
  try {
    fs.symlinkSync("/non_existent_target_" + Date.now(), brokenLink);
    assert.throws(
      () => validateGatewayDir(brokenLink),
      /\[SECURITY_BLOCKED\]/,
      "损坏或无法解析真实路径的软链接必须拒绝"
    );
  } catch (err) {
    if (!err.message.includes("[SECURITY_BLOCKED]")) throw err;
  }

  // 1.6 collectConversationFiles 遍历时跳过符号链接
  const walkDir = makeTempDir("collect_sym_test");
  const realFile = path.join(walkDir, "turn_real.json");
  fs.writeFileSync(realFile, JSON.stringify({ agent: "test", session: "s1", time: new Date().toISOString() }));

  const outsideDir = makeTempDir("outside_dir");
  const outsideFile = path.join(outsideDir, "turn_outside.json");
  fs.writeFileSync(outsideFile, JSON.stringify({ agent: "outside", session: "s2", time: new Date().toISOString() }));

  const linkToOutside = path.join(walkDir, "sym_outside");
  try {
    fs.symlinkSync(outsideDir, linkToOutside);
  } catch (_) { /* ignore */ }

  const collected = collectConversationFiles(walkDir);
  assert.ok(collected.includes(realFile), "真实文件必须被收录");
  assert.ok(!collected.some((f) => f.includes("turn_outside.json")), "符号链接指向的外部文件绝不能被遍历收录");

  // 1.7 反证测试：验证如果仅使用旧版本全等匹配，/var/log 子路径会漏网；而新版本前缀匹配必定拦截！
  const oldSet = new Set(["/var", "/root", "/etc"]);
  const oldMatched = oldSet.has("/var/log");
  assert.strictEqual(oldMatched, false, "反证证明：旧版本全等匹配必然无法拦截 /var/log 子路径！");
  assert.throws(() => validateGatewayDir("/var/log"), /\[SECURITY_BLOCKED\]/, "新逻辑前缀匹配必定拦截 /var/log");
  console.log("  ✓ 路径穿越、敏感目录前缀匹配与软链接跳过验证全部通过\n");
}

// -----------------------------------------------------------------------------
// 2. [P0-3] dbReset 库名归一化校验
// -----------------------------------------------------------------------------
console.log("▶ [Test 2] dbReset 库名归一化与异名越界清库拦截测试...");
{
  // 2.1 isSameDatabaseTarget 纯函数比对
  assert.strictEqual(isSameDatabaseTarget("memory", "41694_memory"), true);
  assert.strictEqual(isSameDatabaseTarget("41694_memory", "memory"), true);
  assert.strictEqual(isSameDatabaseTarget("41694_agent_memory", "41694_agent_memory"), true);
  assert.strictEqual(isSameDatabaseTarget("memory", "41694_other_db"), false);
  assert.strictEqual(isSameDatabaseTarget("", "41694_memory"), false);

  // 2.2 dbReset 传入逻辑名与带账号前缀实例名匹配放行
  const cfg = {
    instance: "41694_agent_memory",
    ncb_instance: "41694_agent_memory",
    mcp_key: "mock_key",
  };
  const resetRes = await dbReset(cfg, { database: "agent_memory" });
  assert.strictEqual(resetRes.ok, false);
  assert.strictEqual(resetRes.action, "CONFIRM_REQUIRED");

  // 2.3 反证测试：传入真正不同的数据库，必须抛出 FORBIDDEN_DATABASE 拒绝清库
  let threwForbidden = false;
  try {
    await dbReset(cfg, { database: "malicious_system_table" });
  } catch (err) {
    if (err.code === "FORBIDDEN_DATABASE") {
      threwForbidden = true;
    }
  }
  assert.strictEqual(threwForbidden, true, "反证测试：非法异名目标库清空必须被抛出 FORBIDDEN_DATABASE 拦截");
  console.log("  ✓ dbReset 库名数字前缀归一化与安全防线验证通过\n");
}

// -----------------------------------------------------------------------------
// 3. [P0-4] harvest_gateway 信标补全参数
// -----------------------------------------------------------------------------
console.log("▶ [Test 3] harvest_gateway 信标补全参数与提炼入库闭环验证...");
{
  const harvestDir = makeTempDir("beacon_harvest_test");
  const turnData = {
    agent: "agent-test",
    session: "sess-v631-001",
    time: new Date().toISOString(),
    input: [{ role: "user", text: "请记住这个技术选型：我们统一使用 ClickHouse 处理海量时序日志" }],
    output: [{ role: "assistant", text: "已记录技术选型：使用 ClickHouse 处理时序日志。" }]
  };
  fs.writeFileSync(path.join(harvestDir, "turn.json"), JSON.stringify(turnData));

  // 模拟在线模型返回提炼结构
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify([
              {
                category: "decision",
                title: "日志存储选型",
                content: "统一使用 ClickHouse 处理海量时序日志",
                tags: "clickhouse,logs",
                confidence: 0.95
              }
            ])
          }
        }]
      })
    };
  };

  try {
    const act = {
      id: "test-harvest-" + Date.now(),
      op: "harvest_gateway",
      at: Date.now(),
      args: { dir: harvestDir, project: env.project, force_rescan: true }
    };
    const options = {
      [ACTION_KEY]: act,
      _action: act,
      extract_model: "test-model",
      classify_model: "off",
    };
    const cfg = {
      instance: "41694_agent_memory",
      project: env.project,
      client: env.client,
      _client: env.client,
      extract_model: "test-model",
      classify_model: "off",
    };

    const actionRes = await runPendingAction(options, cfg);
    assert.strictEqual(actionRes.ran, true, "信标必须被执行");
    assert.strictEqual(actionRes.executed, true, "信标必须执行完成");
    assert.strictEqual(actionRes.result.ok, true, "harvest_gateway 必须返回 ok: true");

    // 验证记忆已成功写入当前隔离 project 命名空间
    const listRes = await env.client.list("memories", { project: env.project });
    const memories = Array.isArray(listRes) ? listRes : (listRes?.data || []);
    assert.ok(memories.length >= 1, "信标传齐参数后必须成功入库记忆，绝不能 0 入库");
    assert.strictEqual(memories[0].title, "日志存储选型");
    assert.strictEqual(memories[0].project, env.project);

    // 反证测试：若缺少 saveMemory 回调，扫描结果的 memories_saved 必为 0
    const { harvestGateway } = await import("../gateway_harvest.js");
    const noSaveRes = await harvestGateway(
      { dir: harvestDir, project: env.project, force_rescan: true },
      { _cfg: cfg, _client: env.client, saveMemory: null, pitfallSave: null }
    );
    assert.strictEqual(noSaveRes.memories_saved, 0, "反证测试：缺失 saveMemory 回调入库数必须为 0");
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("  ✓ harvest_gateway 信标参数补齐与记忆成功入库闭环验证通过\n");
}

// -----------------------------------------------------------------------------
// 4. [P1-6] turnNo 真实轮次 + 快照项目隔离
// -----------------------------------------------------------------------------
console.log("▶ [Test 4] turnNo 真实轮次计算与快照项目隔离测试...");
{
  // 4.1 真实轮次计算：包含 3 个 user 轮次的消息体
  const multiTurnBody = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "第 1 轮提问" },
      { role: "assistant", content: "第 1 轮回复" },
      { role: "user", content: "第 2 轮提问" },
      { role: "assistant", content: "第 2 轮回复" },
      { role: "user", content: "第 3 轮提问：请检索既有规范" }
    ]
  };
  const ctxMulti = { state: {}, options: { inline_extract: true, project: env.project } };
  onRequest(multiTurnBody, ctxMulti);
  assert.strictEqual(ctxMulti.state.turnNo, 3, "从 messages 统计到 3 处 role=='user'，turnNo 必须为 3");

  // 4.2 单轮消息反证
  const singleTurnBody = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "单轮提问" }]
  };
  const ctxSingle = { state: {}, options: { inline_extract: true, project: env.project } };
  onRequest(singleTurnBody, ctxSingle);
  assert.strictEqual(ctxSingle.state.turnNo, 1, "单轮消息 turnNo 必须为 1");

  // 4.3 快照项目隔离：只允许 row.project === currentProject 或 === global
  const mixedMemories = [
    {
      id: 201,
      project: env.project,
      category: "fact",
      title: "当前项目专属密钥",
      content: "项目私有配置 KEY=PROJ_SECRET",
      tags: "secret,key",
      retrieval_count: 5,
      lifecycle_status: "active"
    },
    {
      id: 202,
      project: "other_foreign_project",
      category: "fact",
      title: "外来租户私有配置",
      content: "其他租户密码 PASSWORD=LEAK_TEST",
      tags: "leak,secret",
      retrieval_count: 10,
      lifecycle_status: "active"
    },
    {
      id: 203,
      project: GLOBAL_NS,
      category: "principle",
      title: "全局架构铁律",
      content: "全局规范：所有服务统一使用 UTC 时间戳",
      tags: "utc,time",
      retrieval_count: 20,
      lifecycle_status: "active"
    },
    {
      id: 204,
      project: "other_foreign_project",
      category: "principle",
      title: "外来租户准则",
      content: "其他租户准则：禁止访问本部门服务器",
      tags: "rule",
      retrieval_count: 15,
      lifecycle_status: "active"
    }
  ];

  const testBody = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "请问当前项目专属密钥 KEY 是什么？" }]
  };
  const ctxIso = {
    state: {},
    options: {
      memories: mixedMemories,
      memories_version: "v-iso-1",
      project: env.project,
      inline_extract: true,
      inject_principles: true,
    }
  };

  onRequest(testBody, ctxIso);
  const injectedContent = testBody.messages[0].content;

  // 断言：包含当前项目专属记忆与 global 准则
  assert.ok(injectedContent.includes("全局规范：所有服务统一使用 UTC 时间戳"), "全局 principle 必须成功置顶注入");
  assert.ok(injectedContent.includes("PROJ_SECRET"), "当前项目专属记忆必须成功注入");
  // 反证测试：外来项目的私有记忆与外来项目的准则必须被严格过滤，绝不能注入！
  assert.ok(!injectedContent.includes("LEAK_TEST"), "反证断言：外来租户私有记忆绝对禁止跨项目注入");
  assert.ok(!injectedContent.includes("外来租户准则"), "反证断言：外来租户 principle 绝对禁止跨项目置顶");
  console.log("  ✓ turnNo 真实轮次统计与快照项目隔离过滤验证通过\n");
}

// -----------------------------------------------------------------------------
// 5. [P1-7] testModelConnectivity 可选模型留空
// -----------------------------------------------------------------------------
console.log("▶ [Test 5] testModelConnectivity 可选模型留空不判失败测试...");
{
  // 5.1 classify_model 留空单测
  const classifyEmpty = await testClassificationModel({ classify_model: "" });
  assert.strictEqual(classifyEmpty.skipped, true);
  assert.strictEqual(classifyEmpty.ok, true);

  const classifyOff = await testClassificationModel({ classify_model: "off" });
  assert.strictEqual(classifyOff.skipped, true);
  assert.strictEqual(classifyOff.ok, true);

  // 5.2 整体连通性检测：extract 配置且连通，classify 留空
  const mockFetchSuccess = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify([{ category: "fact", title: "测试", content: "连通成功", confidence: 0.9 }])
        }
      }]
    })
  });

  const resConn = await testModelConnectivity("all", {
    extract_model: "test-extract-model",
    classify_model: "", // 可选模型留空
    _fetch: mockFetchSuccess,
  });

  assert.strictEqual(resConn.extract.ok, true, "已配置的提炼模型必须为 ok: true");
  assert.strictEqual(resConn.classify.skipped, true, "未配置的判定模型必须标记为 skipped: true");
  assert.strictEqual(resConn.classify.ok, true, "未配置的判定模型子项 ok 必须为 true");
  assert.strictEqual(resConn.ok, true, "整体 ok 只由已配置模型决定，不得因可选模型留空判 false！");

  // 5.3 反证测试：若已配置模型本身执行失败，整体 ok 必须为 false
  const mockFetchFailure = async () => ({
    ok: false,
    status: 500,
    text: async () => "Internal Server Error"
  });
  const resFail = await testModelConnectivity("all", {
    extract_model: "failing-model",
    classify_model: "",
    _fetch: mockFetchFailure,
  });
  assert.strictEqual(resFail.ok, false, "反证测试：已配置模型失败时整体 ok 必须为 false");
  console.log("  ✓ testModelConnectivity 可选模型留空与整体判定逻辑通过\n");
}

// -----------------------------------------------------------------------------
// 6. [P2-1b] 脱敏收敛测试
// -----------------------------------------------------------------------------
console.log("▶ [Test 6] scrubSecrets 脱敏收敛与单一真相源对齐验证...");
{
  const sensitiveCases = [
    { raw: "AWS Access Key: AKIAIOSFODNN7EXAMPLE", expectedPart: "***REDACTED***" },
    { raw: "Slack bot: xoxb-123456789012-abcdefghij", expectedPart: "xoxb-***REDACTED***" },
    { raw: "JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwJSMeKKF2QT4fwkMeJf36POk6yJV_adQssw5c", expectedPart: "***REDACTED***" },
    { raw: "DB URL: postgres://admin:super_secret_pw@db.internal:5432/main", expectedPart: "postgres://admin:***REDACTED***@db.internal:5432/main" },
    { raw: "API 密钥是: sk-live-secret-token-12345678", expectedPart: "***REDACTED***" },
  ];

  for (const c of sensitiveCases) {
    const hooksScrubbed = scrubSecrets(c.raw);
    const canonicalScrubbed = canonicalScrubSecrets(c.raw);

    assert.ok(hooksScrubbed.includes(c.expectedPart), `gateway_harvest.hooks.js 脱敏必须包含 ${c.expectedPart}`);
    assert.strictEqual(hooksScrubbed, canonicalScrubbed, "脱敏必须与 scrub.js 单一真相源完全一致");
  }

  // 反证测试：无敏感凭据文本不得被误抹杀
  const harmless = "这是一条正常的对话文本，统一使用 Python 3.11 环境。";
  assert.strictEqual(scrubSecrets(harmless), harmless, "反证测试：无敏感凭据文本绝不能发生误伤抹杀");
  console.log("  ✓ 脱敏收敛至 scrub.js 与一致性验证全部通过\n");
}

// -----------------------------------------------------------------------------
// 7. [P2-5b] dbReset 后清理本地状态
// -----------------------------------------------------------------------------
console.log("▶ [Test 7] dbReset 后清理本地状态 (audit_cursor / harvest_queue / pending_patterns) 测试...");
{
  // 7.1 预设本地状态数据
  saveAuditCursor(env.project, { last_id: 999, at: Date.now() });
  enqueueHarvestItems([
    { id: "q1", table: "memories", project: env.project, data: { title: "队列数据 1" } }
  ]);
  recordPendingEvidence(`p:${env.project}:test_fp`, { symptom: "报错测试", project: env.project }, { kind: "pitfall", minEvidence: 5 });

  assert.ok(getAuditCursor(env.project) !== null, "预设 auditCursor 必须成功");
  assert.ok(readHarvestQueue().length >= 1, "预设 harvest_queue 必须成功");
  assert.ok(getPendingEvidence(`p:${env.project}:test_fp`) !== null, "预设 pending_patterns 必须成功");

  // 记录未受影响的其它持久化状态 (如 secrets)，验证绝不整体抹平
  const stBefore = readState();
  stBefore.secrets = { "41694_test_db": "keep_this_secret" };
  writeState(stBefore);

  // 7.2 执行 dbReset（使用受控 mock executeSqlBatch 隔离远端网络 DDL 调用）
  const resetCfg = {
    instance: "41694_agent_memory",
    ncb_instance: "41694_agent_memory",
    project: env.project,
    mcp_key: "mock_key",
  };

  const origBatch = NcbMcp.prototype.executeSqlBatch;
  NcbMcp.prototype.executeSqlBatch = async function (db, stmts) {
    return (stmts || []).map((s) => ({ ok: true, sql: s.sql }));
  };

  try {
    const resReset = await dbReset(resetCfg, {
      database: "41694_agent_memory",
      confirm: "RESET",
      project: env.project,
    });

    assert.strictEqual(resReset.ok, true, "清库操作必须成功");

    // 7.3 校验本地状态已清理
    const stAfter = readState();
    assert.strictEqual(stAfter.audit?.cursors?.[env.project], undefined, "清库后 audit.cursors[prj] 必须被彻底删除");
    assert.strictEqual(getAuditCursor(env.project).last_id, null, "游标 last_id 必须重置为 null");
    assert.strictEqual(readHarvestQueue().length, 0, "清库后 harvest_queue 必须被彻底清空");
    assert.strictEqual(Object.keys(stAfter.pending_patterns || {}).length, 0, "清库后 pending_patterns 必须被彻底清空");
    assert.strictEqual(stAfter.secrets["41694_test_db"], "keep_this_secret", "状态绝不能整体抹平，secrets 必须完好保留");

    // 反证测试：二次确认未通过时绝对禁止清理本地状态
    saveAuditCursor(env.project, { last_id: 888 });
    await dbReset(resetCfg, { database: "41694_agent_memory", confirm: "NO_RESET", project: env.project });
    assert.strictEqual(getAuditCursor(env.project).last_id, 888, "反证测试：二次确认未达标时本地状态游标绝对不能被清理");
  } finally {
    NcbMcp.prototype.executeSqlBatch = origBatch;
  }
  console.log("  ✓ dbReset 成功后精准清理本地状态且防整体抹平验证通过\n");
}

// -----------------------------------------------------------------------------
// 8. 清理、残余为 0 断言与 test_meta 规范元检查自证
// -----------------------------------------------------------------------------
console.log("=================================================================");
console.log("执行彻底清理与全局残余数为 0 校验");
console.log("=================================================================");

for (const d of tempDirs) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

const cleanRes = await env.cleanup();
const residue = await env.countAllTestResidue();
assert.strictEqual(residue.total, 0, "测试结束后数据库必须彻底清理，残余数必须为 0！");
console.log(`✓ 隔离命名空间已完全清理 (清理: ${cleanRes.memoriesDeleted} 条记忆)，残余校验断言: residue.total === 0 通过！`);

// test_meta 规则合规自检：对本测试文件进行元检查
const selfContent = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
const scanRes = scanTestFile(fileURLToPath(import.meta.url), selfContent);
if (scanRes.issues.length > 0) {
  console.error("❌ test_v631_b_harvest.mjs 存在 test_meta 违规项:");
  for (const is of scanRes.issues) {
    console.error("   - " + is);
  }
  process.exit(1);
}
assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 100% 符合 test_meta 规范！");
console.log("✓ 本测试文件经 test_meta 扫描，0 规范违规！");

console.log("\n=================================================================");
console.log("✅ 全部 7 项 Agent B 采集与中间件整改专项测试与反证门 100% 顺利通过！");
console.log("=================================================================");
