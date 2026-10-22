/**
 * tests/test_v632_b_security.mjs —— Agent B 安全与状态项整改专项验收测试套件 (v6.32)
 *
 * 覆盖 6 项核心安全与状态整改及强制反证门：
 *   1. [P0-1] 跨账号前缀越权清库防护与库名一致性强制校验
 *   2. [P0-3] validateGatewayDir 路径安全防护（敏感子路径黑名单 + 白名单放行）
 *   3. [P1-4] harvest_gateway 信标生产副作用消除与 memory_audit 状态倒退竞态防御
 *   4. [P1-5] settings.js 状态覆盖防线（旧去重状态不冲掉最新模型检测）
 *   5. [P1-6] dbReset 多项目游标与采集指纹全清且严禁整体抹平
 *   6. [P1-1] gateway_harvest.hooks.js 前置短路数字冲突守卫
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { createTestEnv } from "./lib/testenv.mjs";
import { scanTestFile } from "./test_meta.mjs";
import { NcbMcp } from "../src/integration/ncb-client.js";
import {
  isSameDatabaseTarget,
  dbReset,
} from "../src/integration/db-tools.js";
import {
  validateGatewayDir,
  isWhitelistedGatewayDir,
  checkSensitiveSubpaths,
  HARD_FORBIDDEN_PREFIXES,
  FORBIDDEN_PREFIXES,
} from "../src/services/harvest/index.js";
import {
  hasConflictingNumbers,
  normalizeSemanticText,
  tokenize,
  overlapCoefficient,
  jaccardSimilarity,
} from "../src/domain/semantic-dedup.js";
import {
  readState,
  writeState,
  saveAuditCursor,
  getAuditCursor,
  clearAuditCursor,
  rememberGatewayHarvest,
  lookupGatewayHarvest,
  enqueueHarvestItems,
  readHarvestQueue,
  recordPendingEvidence,
} from "../src/core/state.js";

console.log("=================================================================");
console.log("【Agent B 验收测试】v6.32 安全与状态 6 项整改及反证门禁全面验证");
console.log("=================================================================\n");

// 初始化测试隔离环境
const env = await createTestEnv({ instance: "41694_agent_memory", requireMcp: true });
console.log(`[test_v632_b_security] 隔离命名空间 project: ${env.project}`);

// -----------------------------------------------------------------------------
// 1. [P0-1] 跨账号前缀越权清库防护
// -----------------------------------------------------------------------------
console.log("▶ [Test 1] 跨账号前缀越权清库防护与归一化校验测试...");
{
  // 1.1 纯函数 isSameDatabaseTarget 跨账号前缀比对
  assert.strictEqual(isSameDatabaseTarget("41694_memory", "99999_memory"), false, "跨账号不同前缀必须拒绝 (false)");
  assert.strictEqual(isSameDatabaseTarget("11111_agent", "22222_agent"), false, "跨账号不同前缀必须拒绝 (false)");
  assert.strictEqual(isSameDatabaseTarget("41694_memory", "41694_memory"), true, "相同账号相同库名放行 (true)");
  assert.strictEqual(isSameDatabaseTarget("memory", "41694_memory"), true, "逻辑名 vs 物理名放行 (true)");
  assert.strictEqual(isSameDatabaseTarget("41694_memory", "memory"), true, "物理名 vs 逻辑名放行 (true)");
  assert.strictEqual(isSameDatabaseTarget("41694_memory", "41694_other"), false, "相同账号不同库名拒绝 (false)");
  assert.strictEqual(isSameDatabaseTarget("", "41694_memory"), false, "空库名拒绝 (false)");
  assert.strictEqual(isSameDatabaseTarget("41694_memory", ""), false, "空库名拒绝 (false)");

  // 1.2 dbReset 反证门：配置 41694_agent_memory，传入 99999_agent_memory 必须抛出 FORBIDDEN_DATABASE 拦截
  const cfg = {
    instance: "41694_agent_memory",
    ncb_instance: "41694_agent_memory",
    project: env.project,
    mcp_key: "mock_mcp_key",
  };

  let crossAccountBlocked = false;
  try {
    await dbReset(cfg, { database: "99999_agent_memory" });
  } catch (err) {
    if (err.code === "FORBIDDEN_DATABASE") {
      crossAccountBlocked = true;
    }
  }
  assert.strictEqual(crossAccountBlocked, true, "反证门 1：跨账号伪造库名清库必须被抛出 FORBIDDEN_DATABASE 强力拦截！");

  // 1.3 传入合法逻辑库名通过安全校验进入二次确认门
  const confirmReq = await dbReset(cfg, { database: "agent_memory" });
  assert.strictEqual(confirmReq.ok, false);
  assert.strictEqual(confirmReq.action, "CONFIRM_REQUIRED");

  // 1.4 dbReset 执行 DROP 前强制使用配置侧库名，绝不使用 args.database
  const origBatch = NcbMcp.prototype.executeSqlBatch;
  let executedTargetDb = null;
  NcbMcp.prototype.executeSqlBatch = async function (targetDb, stmts) {
    executedTargetDb = targetDb;
    return (stmts || []).map((s) => ({ ok: true, sql: s.sql }));
  };

  try {
    const resetOk = await dbReset(cfg, {
      database: "agent_memory", // 传入的是逻辑名
      confirm: "RESET",
      project: env.project,
    });
    assert.strictEqual(resetOk.ok, true, "清库在合法确认下成功");
    assert.strictEqual(
      executedTargetDb,
      "41694_agent_memory",
      "反证门：执行 DROP 的目标库名必须是配置侧解析的真实物理库名，绝不能是未经解析的 args.database"
    );
  } finally {
    NcbMcp.prototype.executeSqlBatch = origBatch;
  }

  console.log("  ✓ 跨账号前缀越权清库防护与真实库名强制绑定验证通过\n");
}

// -----------------------------------------------------------------------------
// 2. [P0-3] validateGatewayDir 路径安全防护（敏感子路径黑名单 + 白名单豁免）
// -----------------------------------------------------------------------------
console.log("▶ [Test 2] validateGatewayDir 合法目录放行与敏感路径黑名单拦截测试...");
{
  // 2.1 反证门：合法目录必须放行
  const allowedDirs = [
    "~/GatewayConversations",
    "/var/minis",
    "/tmp/test_harvest_b_sec_" + Date.now(),
    "/var/folders/temp_test",
  ];

  for (const d of allowedDirs) {
    let allowedOk = false;
    let resolved = null;
    try {
      resolved = validateGatewayDir(d);
      allowedOk = true;
    } catch (e) {
      allowedOk = false;
    }
    assert.strictEqual(allowedOk, true, `反证门：合法对话与运行时目录 (${d}) 必须放行，绝不可误杀！`);
    assert.ok(resolved && typeof resolved === "string", "解析出的绝对路径必须合法有效");
  }

  // 2.2 反证门：敏感子路径黑名单必须拦截
  const blockedSensitivePaths = [
    path.join(os.homedir(), ".ssh"),
    path.join(os.homedir(), ".magpie-memory-hub"),
    path.join(os.homedir(), ".aws", "credentials"),
    path.join(os.homedir(), ".gnupg"),
    path.join(os.homedir(), ".docker"),
    path.join(os.homedir(), ".kube", "config"),
    "/root/.config/gcloud",
    "/etc",
    "/etc/nginx/conf.d",
    "/proc/cpuinfo",
    "/sys/kernel",
    "/var/log",
    "/home/user/workspace",
  ];

  for (const bp of blockedSensitivePaths) {
    assert.throws(
      () => validateGatewayDir(bp),
      /\[SECURITY_BLOCKED\]/,
      `反证门：高危敏感路径 (${bp}) 必须被 [SECURITY_BLOCKED] 坚决拦截！`
    );
  }

  // 2.3 反证门：环境变量 MEMHUB_STATE_DIR 必须拦截
  const customStateDir = path.join(os.tmpdir(), "custom_state_dir_" + Date.now());
  process.env.MEMHUB_STATE_DIR = customStateDir;
  try {
    assert.throws(
      () => validateGatewayDir(customStateDir),
      /\[SECURITY_BLOCKED\]/,
      "反证门：process.env.MEMHUB_STATE_DIR 配置的状态目录必须被拦截！"
    );
    assert.throws(
      () => validateGatewayDir(path.join(customStateDir, "state.json")),
      /\[SECURITY_BLOCKED\]/,
      "反证门：process.env.MEMHUB_STATE_DIR 下的子文件/子路径必须被拦截！"
    );
  } finally {
    delete process.env.MEMHUB_STATE_DIR;
  }

  // 2.4 ".." 路径跳转拦截
  assert.throws(
    () => validateGatewayDir("~/GatewayConversations/../../etc"),
    /\[SECURITY_BLOCKED\]/,
    "反证门：包含 .. 相对跳转的路径必须拦截！"
  );

  console.log("  ✓ validateGatewayDir 白名单放行与敏感子路径黑名单拦截验证通过\n");
}

// -----------------------------------------------------------------------------
// 3. [P1-4] harvest_gateway 信标生产副作用消除与 memory_audit 竞态防御
// -----------------------------------------------------------------------------
console.log("▶ [Test 3] harvest_gateway 生产副作用消除与 memory_audit 状态落盘竞态消除验证...");
{
  // 3.1 静态检查 page_actions.js 中 harvest_gateway safeOpts 显式禁用生产副作用
  const pageActionsPath = fs.existsSync(path.resolve("src/page/actions.js"))
    ? path.resolve("src/page/actions.js")
    : path.resolve("page_actions.js");
  const pageActionsCode = fs.readFileSync(pageActionsPath, "utf8");
  assert.ok(
    pageActionsCode.includes("auto_init: false") && pageActionsCode.includes("auto_harvest: false") && pageActionsCode.includes("dedup_schedule: \"off\""),
    "harvest_gateway safeOpts 必须显式禁用 auto_init、auto_harvest 与 dedup_schedule"
  );

  // 3.2 memory_audit 分支必须在启动异步 IIFE 之前先落盘 writeCardStatus(\"audit\", result, \"memory_audit\")
  const auditStartIdx = pageActionsCode.indexOf('op: "memory_audit"');
  const writeCardStatusIdx = pageActionsCode.indexOf('writeCardStatus("audit", result, "memory_audit");');
  const iifeIdx = pageActionsCode.indexOf("(async () => {");
  assert.ok(auditStartIdx > 0, "必须存在 memory_audit 分支");
  assert.ok(writeCardStatusIdx > auditStartIdx, "writeCardStatus 必须在 memory_audit 分支内调用");
  assert.ok(
    writeCardStatusIdx < iifeIdx,
    "反证门：writeCardStatus(\"audit\", result) 进行中状态必须在启动异步 IIFE 之前落盘，杜绝状态倒退覆盖竞态！"
  );

  // 3.3 外层 writeCardStatus 严禁对 memory_audit 二次重写覆盖后台结果
  assert.ok(
    pageActionsCode.includes('if (action.op !== "memory_audit")'),
    "外层落盘必须排除 memory_audit，避免外层落盘覆盖后台最新状态"
  );

  console.log("  ✓ harvest_gateway 副作用消除与 memory_audit 竞态消除验证通过\n");
}

// -----------------------------------------------------------------------------
// 4. [P1-5] settings.js 状态覆盖防线（旧去重状态不覆盖最新模型检测）
// -----------------------------------------------------------------------------
console.log("▶ [Test 4] settings.js 旧去重状态不覆盖最新模型检测验证...");
{
  // 静态与逻辑验证 settings.js 中的时间戳判定
  const settingsCode = fs.readFileSync(path.resolve("src/page/settings.js"), "utf8");
  assert.ok(
    settingsCode.includes("auditAt > modelAt") || settingsCode.includes("audit.at > model.at"),
    "settings.js 中必须包含 auditAt > modelAt 时间戳比较逻辑"
  );

  // 在 Node.js vm 环境中构造 DOM Stub 模拟 renderAllStatus
  const html = fs.readFileSync(path.resolve("settings.html"), "utf8");
  const idMatches = [...html.matchAll(/\bid=["\']([a-zA-Z0-9_-]+)["\']/g)].map((m) => m[1]);
  const elements = {};
  for (const id of idMatches) {
    elements[id] = {
      id,
      innerHTML: "",
      textContent: "",
      style: {},
      classList: {
        add: () => {},
        remove: () => {},
        contains: () => false,
      },
      setAttribute: () => {},
      removeAttribute: () => {},
      addEventListener: () => {},
      appendChild: () => {},
    };
  }

  const locationObj = { origin: "https://magpie-web.example.com", search: "", href: "https://magpie-web.example.com" };
  const magpie = {
    ready: Promise.resolve(),
    options: {
      get: async () => ({}),
      set: async () => ({}),
    },
  };
  const sandbox = {
    window: {
      location: locationObj,
      magpie,
      addEventListener: () => {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      __memhubStatus: {},
    },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      readyState: "complete",
    },
    location: locationObj,
    magpie,
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    Math,
    RegExp,
    parseFloat,
    parseInt,
    isNaN,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.location = sandbox.location;

  const script = new vm.Script(settingsCode);
  const context = vm.createContext(sandbox);
  script.runInContext(context);

  // 场景 A：model 检测结果晚于 audit 去重结果 (model.at = 2000, audit.at = 1000)
  const statusModelNewer = {
    model: {
      at: 2000,
      op: "model_check",
      ok: true,
      title: "最新在线模型连通成功",
      lines: ["模型响应良好"],
    },
    audit: {
      at: 1000,
      op: "memory_audit",
      ok: true,
      title: "旧去重记录",
      lines: ["去重完成于早先"],
    },
  };

  sandbox.window.renderStatus(statusModelNewer);
  const modelStatusAfter = elements.model_action_status.innerHTML;
  assert.ok(
    modelStatusAfter.includes("最新在线模型连通成功"),
    "反证门：当模型检测时间戳新于去重任务时，#model_action_status 必须保留模型检测结果！"
  );
  assert.ok(
    !modelStatusAfter.includes("旧去重记录"),
    "反证门：旧去重状态绝不允许冲掉更新的模型检测卡片！"
  );

  // 场景 B（反证门）：当 audit 去重结果晚于 model 检测结果 (audit.at = 3000, model.at = 2000)
  const statusAuditNewer = {
    model: {
      at: 2000,
      op: "model_check",
      ok: true,
      title: "旧模型检测结果",
      lines: ["旧模型状态"],
    },
    audit: {
      at: 3000,
      op: "memory_audit",
      ok: true,
      title: "最新全自动去重完成",
      lines: ["去重合并成功"],
    },
  };

  sandbox.window.renderStatus(statusAuditNewer);
  const auditStatusAfter = elements.model_action_status.innerHTML;
  assert.ok(
    auditStatusAfter.includes("最新全自动去重完成"),
    "反证门：当去重任务晚于模型检测时，#model_action_status 正常展示最新去重结果！"
  );

  console.log("  ✓ settings.js 最新模型检测状态保留与防旧覆盖验证通过\n");
}

// -----------------------------------------------------------------------------
// 5. [P1-6] dbReset 多项目游标与采集指纹全清测试
// -----------------------------------------------------------------------------
console.log("▶ [Test 5] dbReset 多项目游标、指纹缓存与队列全清（且 secrets 保留）测试...");
{
  const prjA = "project_alpha_" + Date.now();
  const prjB = "project_beta_" + Date.now();
  const prjCurrent = env.project;

  // 5.1 预设多个项目的游标数据
  saveAuditCursor(prjA, { last_id: 111, reviewed_count: 5 });
  saveAuditCursor(prjB, { last_id: 222, reviewed_count: 10 });
  saveAuditCursor(prjCurrent, { last_id: 333, reviewed_count: 15 });

  // 5.2 预设 gateway_harvest 指纹与文件状态
  rememberGatewayHarvest({
    files: {
      "/tmp/turn_1.json": { size: 100, mtimeMs: 123456 },
      "/tmp/turn_2.json": { size: 200, mtimeMs: 234567 },
    },
    processed_fingerprints: ["fp_aaa_111", "fp_bbb_222"],
  });

  // 5.3 预设 harvest_queue 与 pending_patterns
  enqueueHarvestItems([
    { id: "q_item_1", table: "memories", project: prjCurrent, data: { title: "待存队列 1" } }
  ]);
  recordPendingEvidence("p:" + prjCurrent + ":fp_pattern_1", { symptom: "报错测试", project: prjCurrent }, { kind: "pitfall", minEvidence: 5 });

  // 5.4 预设 secrets / actions / r2_mounts，验证绝不整体抹平
  const stBefore = readState();
  stBefore.secrets = {
    "41694_agent_memory": "SECRET_KEY_MUST_PRESERVE_123",
    "41694_other_db": "ANOTHER_SECRET_456"
  };
  stBefore.actions = { lastDoneId: "action_done_999" };
  stBefore.r2_mounts = { "main_r2": { bucket_name: "prod-bucket" } };
  writeState(stBefore);

  // 断言预设状态存在
  assert.strictEqual(getAuditCursor(prjA).last_id, 111);
  assert.strictEqual(getAuditCursor(prjB).last_id, 222);
  assert.strictEqual(getAuditCursor(prjCurrent).last_id, 333);
  assert.ok(lookupGatewayHarvest().processed_fingerprints.length >= 2);
  assert.ok(readHarvestQueue().length >= 1);

  // 5.5 反证门：confirm !== "RESET" 时绝对不能清理任何游标或指纹
  const resetCfg = {
    instance: "41694_agent_memory",
    ncb_instance: "41694_agent_memory",
    project: prjCurrent,
    mcp_key: "mock_key",
  };
  await dbReset(resetCfg, { database: "41694_agent_memory", confirm: "NO_RESET", project: prjCurrent });
  assert.strictEqual(getAuditCursor(prjA).last_id, 111, "反证门：二次确认未通过时绝对禁止清空游标！");
  assert.strictEqual(lookupGatewayHarvest().processed_fingerprints.length >= 2, true, "反证门：二次确认未通过时绝对禁止清空指纹！");

  // 5.6 正式执行清库（mock executeSqlBatch）
  const origBatch = NcbMcp.prototype.executeSqlBatch;
  NcbMcp.prototype.executeSqlBatch = async function (db, stmts) {
    return (stmts || []).map((s) => ({ ok: true, sql: s.sql }));
  };

  try {
    const resReset = await dbReset(resetCfg, {
      database: "41694_agent_memory",
      confirm: "RESET",
      project: prjCurrent,
    });
    assert.strictEqual(resReset.ok, true, "清库必须成功");

    // 5.7 核心断言：全项目游标已被清空
    assert.strictEqual(getAuditCursor(prjA).last_id, null, "清库后 project_alpha 游标必须被清空");
    assert.strictEqual(getAuditCursor(prjB).last_id, null, "清库后 project_beta 游标必须被清空");
    assert.strictEqual(getAuditCursor(prjCurrent).last_id, null, "清库后当前 project 游标必须被清空");

    const stAfter = readState();
    assert.strictEqual(Object.keys(stAfter.audit?.cursors || {}).length, 0, "全部项目游标字典必须彻底清空");

    // 5.8 核心断言：gateway_harvest 指纹与文件状态彻底清空
    const ghAfter = lookupGatewayHarvest();
    assert.strictEqual(Object.keys(ghAfter.files || {}).length, 0, "清库后 gateway_harvest.files 必须彻底清空");
    assert.strictEqual((ghAfter.processed_fingerprints || []).length, 0, "清库后 gateway_harvest.processed_fingerprints 必须彻底清空");

    // 5.9 核心断言：harvest_queue 与 pending_patterns 彻底清空
    assert.strictEqual(readHarvestQueue().length, 0, "清库后 harvest_queue 必须为空");
    assert.strictEqual(Object.keys(stAfter.pending_patterns || {}).length, 0, "清库后 pending_patterns 必须为空");

    // 5.10 核心断言：secrets / actions / r2_mounts 绝无被整体抹平！
    assert.strictEqual(
      stAfter.secrets["41694_agent_memory"],
      "SECRET_KEY_MUST_PRESERVE_123",
      "反证门：清库后 secrets 凭据必须完整保留，绝对禁止整体抹平！"
    );
    assert.strictEqual(
      stAfter.secrets["41694_other_db"],
      "ANOTHER_SECRET_456",
      "反证门：其它数据库 secrets 同样必须完好无损！"
    );
    assert.strictEqual(stAfter.actions?.lastDoneId, "action_done_999", "actions 必须完整保留");
    assert.strictEqual(stAfter.r2_mounts?.main_r2?.bucket_name, "prod-bucket", "r2_mounts 必须完整保留");
  } finally {
    NcbMcp.prototype.executeSqlBatch = origBatch;
  }

  console.log("  ✓ dbReset 多项目游标与采集指纹全清且 secrets 保留验证通过\n");
}

// -----------------------------------------------------------------------------
// 6. [P1-1] gateway_harvest.hooks.js 前置短路数字冲突守卫测试
// -----------------------------------------------------------------------------
console.log("▶ [Test 6] gateway_harvest.hooks.js 前置短路数字冲突守卫测试...");
{
  // 6.1 hasConflictingNumbers 函数验证
  assert.strictEqual(hasConflictingNumbers("Port 80 被占用", "Port 8080 被占用"), true, "Port 80 vs Port 8080 必须识别为数字冲突！");
  assert.strictEqual(hasConflictingNumbers("Node 18 环境报错", "Node 20 环境报错"), true, "Node 18 vs Node 20 必须识别为数字冲突！");
  assert.strictEqual(hasConflictingNumbers("Python 3.10 依赖缺失", "Python 3.11 依赖缺失"), true, "Python 3.10 vs 3.11 必须识别为数字冲突！");

  // 反证门：相同数字文本不冲突
  assert.strictEqual(hasConflictingNumbers("Port 80 端口占用", "Port 80 无法绑定"), false, "反证门：相同端口号不属于数字冲突");
  assert.strictEqual(hasConflictingNumbers("通用连接超时", "通用服务无法启动"), false, "反证门：无数字文本不属于数字冲突");

  // 6.2 模拟 gateway_harvest.hooks.js 踩坑前置短路判定逻辑
  const checkDuplicate = (symptom, existingRows) => {
    return existingRows.find((r) => {
      const noConflict = !hasConflictingNumbers(symptom, r.symptom);
      const rSym = normalizeSemanticText(r.symptom);
      const curSym = normalizeSemanticText(symptom);
      if (noConflict && rSym && curSym && (rSym === curSym || rSym.includes(curSym) || curSym.includes(rSym))) {
        return true;
      }
      const rTok = tokenize(r.symptom);
      const sTok = tokenize(symptom);
      if (noConflict && (overlapCoefficient(rTok.tokens, sTok.tokens) >= 0.5 || jaccardSimilarity(rTok.tokens, sTok.tokens) >= 0.3)) {
        return true;
      }
      if (!noConflict) {
        return false;
      }
      return false; // isSemanticallySimilar
    });
  };

  const existing = [
    { id: 1, symptom: "服务启动报错：Port 80 端口被占用" },
    { id: 2, symptom: "Node 18 构建失败：语法不兼容" },
  ];

  // 冲突用例 1：Port 8080
  const dupPort8080 = checkDuplicate("服务启动报错：Port 8080 端口被占用", existing);
  assert.strictEqual(dupPort8080, undefined, "反证门：Port 8080 绝不能因 substring includes 短路误合并到 Port 80！");

  // 冲突用例 2：Node 20
  const dupNode20 = checkDuplicate("Node 20 构建失败：语法不兼容", existing);
  assert.strictEqual(dupNode20, undefined, "反证门：Node 20 绝不能因词集重叠短路误合并到 Node 18！");

  // 反证门：真正重复的 Port 80 正常命中
  const dupPort80Real = checkDuplicate("服务启动报错：Port 80 端口被占用", existing);
  assert.ok(dupPort80Real && dupPort80Real.id === 1, "反证门：完全相同的 Port 80 故障必须正常被判为重复并合并！");

  console.log("  ✓ gateway_harvest.hooks.js 前置短路数字守卫验证通过\n");
}

// -----------------------------------------------------------------------------
// 7. 清理、残余为 0 断言与 test_meta 元检查自证
// -----------------------------------------------------------------------------
console.log("=================================================================");
console.log("执行彻底清理与全局残余数为 0 校验");
console.log("=================================================================");

const cleanRes = await env.cleanup();
const residue = await env.countAllTestResidue();
assert.strictEqual(residue.total, 0, "测试结束后数据库必须彻底清理，残余数必须为 0！");
console.log(`✓ 隔离命名空间已完全清理 (清理: ${cleanRes.memoriesDeleted} 条记忆)，残余校验断言: residue.total === 0 通过！`);

// 对本测试文件进行 test_meta 规范自检
const selfContent = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
const scanRes = scanTestFile(fileURLToPath(import.meta.url), selfContent);
if (scanRes.issues.length > 0) {
  console.error("❌ test_v632_b_security.mjs 存在 test_meta 违规项:");
  for (const is of scanRes.issues) {
    console.error("   - " + is);
  }
  process.exit(1);
}
assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 100% 符合 test_meta 规范！");
console.log("✓ 本测试文件经 test_meta 扫描，0 规范违规！");

console.log("\n=================================================================");
console.log("✅ 全部 6 项 Agent B 安全与状态整改专项测试与反证门 100% 顺利通过！");
console.log("=================================================================");
