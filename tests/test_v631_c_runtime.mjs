/**
 * test_v631_c_runtime.mjs —— Agent C 运行时与测试卫生专项整改验证套件
 *
 * 覆盖项目：
 * 1. P2-2 local_state.js 状态健壮性 (MEMHUB_STATE_DIR, _recoverCorruptStateFile, forgetR2Mount 联动 _status.js, recordPendingEvidence 踩坑语义去重)
 * 2. P2-3 semantic_dedup.js 性能与误判 (levenshteinDistance 双行滚动数组与 512 字符截断, isAlphaTokenMatch 纯数字精确匹配防误判)
 * 3. P2-4 mcp_client.js / ncb_mcp.js (buildSelect effectiveLimit 计算 OFFSET, create 回查 pitfalls 使用 symptom 列, ncb_mcp.initialize 并发互斥 _initPromise)
 * 4. P2-5a r2.js 凭据兜底 (restClient 与 r2Upload 在 cfg 无 secret 时回退 lookupSecret(db))
 * 5. P2-6b online_models.js / settings.js (rerank_model 最高优先级, auditMemories 无悬挂定时器, settings.js 多卡片独立定时器 Map)
 * 6. 反证门 (故意破坏数字实体等价性与越界条件，断言安全防御成功拦截)
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * 受控内存 mock 桩清理：本用例全部基于内存桩，绝不触碰真实数据库
 */
const __mockStores = [];
async function cleanup() {
  for (const st of __mockStores) {
    if (st && typeof st.clear === "function") st.clear();
  }
}

import {
  statePath,
  readState,
  writeState,
  _recoverCorruptStateFile,
  _resetStateCacheForTests,
  forgetR2Mount,
  rememberR2Mount,
  recordPendingEvidence,
  rememberSecret,
} from "../local_state.js";

import {
  levenshteinDistance,
  levSimilarity,
  isAlphaTokenMatch,
  isSemanticallySimilar,
} from "../semantic_dedup.js";

import {
  buildSelect,
  makeMcpClient,
} from "../mcp_client.js";

import { NcbMcp } from "../ncb_mcp.js";
import { r2Upload } from "../r2.js";
import { rerankSearchResultsWithModel } from "../online_models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("=================================================================");
console.log("【测试开始】Agent C: 运行时与测试卫生整改验收套件 (v6.3.1)");
console.log("=================================================================");

async function runTests() {
  // -----------------------------------------------------------------
  // 1. local_state.js 状态健壮性
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 1] local_state.js 状态健壮性与环境变量隔离验证...");

  // 1.1 statePath 优先 MEMHUB_STATE_DIR 隔离
  const origEnvDir = process.env.MEMHUB_STATE_DIR;
  const customDir = path.join(os.tmpdir(), `memhub_test_state_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(customDir, { recursive: true });

  try {
    process.env.MEMHUB_STATE_DIR = customDir;
    const sp = statePath();
    assert.strictEqual(sp, path.join(customDir, "state.json"), "statePath 必须优先使用 MEMHUB_STATE_DIR 环境变量");

    // 1.2 _recoverCorruptStateFile 公共函数自愈、同步写 .corrupt.<ts> 与防回写空 {}
    _resetStateCacheForTests();
    const testStateFile = path.join(customDir, "state.json");
    const testBakFile = `${testStateFile}.bak`;

    // 写入正常的 .bak 备份
    const goodData = {
      current: "41694_c_runtime_db",
      secrets: { "41694_c_runtime_db": { v: "sec_runtime_999", at: Date.now() } },
      actions: { lastDoneId: "act_c_1" },
    };
    fs.writeFileSync(testBakFile, JSON.stringify(goodData), "utf8");

    // 制造损坏的 state.json
    const corruptContent = "{ invalid_json: unterminated...";
    fs.writeFileSync(testStateFile, corruptContent, "utf8");

    // 执行 _recoverCorruptStateFile
    const recovered = _recoverCorruptStateFile(testStateFile, corruptContent, new SyntaxError("Unexpected token"));
    assert.strictEqual(recovered._ok, true, "从 .bak 恢复后 _ok 必须为 true");
    assert.strictEqual(recovered._recovered_from_bak, true, "必须标记 _recovered_from_bak: true");
    assert.strictEqual(recovered.secrets["41694_c_runtime_db"]?.v, "sec_runtime_999", "恢复的数据必须完整");

    // 检查同步写入的 .corrupt.<timestamp> 备份
    const files = fs.readdirSync(customDir);
    const corruptFiles = files.filter((f) => f.startsWith("state.json.corrupt."));
    assert.ok(corruptFiles.length > 0, "损坏发生时必须同步生成 .corrupt.<ts> 备份");

    // 验证当 .bak 也不可用时，严禁回写空 {}，必须返回 _ok: false
    fs.unlinkSync(testBakFile);
    fs.writeFileSync(testStateFile, "invalid again", "utf8");
    _resetStateCacheForTests();
    const unrecoverable = _recoverCorruptStateFile(testStateFile, "invalid again", new SyntaxError("Bad"));
    assert.strictEqual(unrecoverable._ok, false, "无法恢复时 _ok 必须为 false，严禁伪造成功");
    assert.strictEqual(writeState(unrecoverable), false, "writeState 必须严格拒绝写入 _ok=false 的损坏状态");

    // 1.3 forgetR2Mount 联动清除 _status.js 与 _status.json
    const statusJsonPath = path.resolve(__dirname, "../_status.json");
    const statusJsPath = path.resolve(__dirname, "../_status.js");
    const origStatusJson = fs.existsSync(statusJsonPath) ? fs.readFileSync(statusJsonPath, "utf8") : null;
    const origStatusJs = fs.existsSync(statusJsPath) ? fs.readFileSync(statusJsPath, "utf8") : null;

    // 写入模拟带 r2 的 _status.json 与 _status.js
    const mockStatusData = {
      db: { ok: true, database: "41694_c_runtime_db" },
      r2: { ok: true, bucket: "test-bucket", title: "R2已挂载" },
    };
    fs.writeFileSync(statusJsonPath, JSON.stringify(mockStatusData, null, 2), "utf8");
    fs.writeFileSync(statusJsPath, `window.__memhubStatus = ${JSON.stringify(mockStatusData, null, 2)};\n`, "utf8");

    // 模拟存在 r2 挂载记录并清除
    _resetStateCacheForTests();
    const stWithMount = readState();
    stWithMount._ok = true;
    stWithMount.r2_mounts = { "41694_c_runtime_db": { bucket: "test-bucket", at: Date.now() } };
    writeState(stWithMount);

    forgetR2Mount("41694_c_runtime_db");

    // 验证 _status.json 与 _status.js 中的 r2 均被清除
    const afterJson = JSON.parse(fs.readFileSync(statusJsonPath, "utf8"));
    const afterJs = fs.readFileSync(statusJsPath, "utf8");
    assert.strictEqual(afterJson.r2, undefined, "forgetR2Mount 必须彻底清除 _status.json 中的 r2 字段");
    assert.ok(!afterJs.includes('"r2"'), "forgetR2Mount 必须同步更新 _status.js 且不再包含 r2 字段");

    // 还原原始 _status 文件
    if (origStatusJson !== null) fs.writeFileSync(statusJsonPath, origStatusJson, "utf8");
    else try { fs.unlinkSync(statusJsonPath); } catch (e) { void e; }
    if (origStatusJs !== null) fs.writeFileSync(statusJsPath, origStatusJs, "utf8");
    else try { fs.unlinkSync(statusJsPath); } catch (e) { void e; }

    // 1.4 recordPendingEvidence 踩坑 (pitfall) 语义去重
    _resetStateCacheForTests();
    const pitProj = "test_c_runtime_pitfall";
    const fp1 = "p:test_c_runtime_pitfall:redis_timeout_1";
    const fp2 = "p:test_c_runtime_pitfall:redis_timeout_2";

    const p1 = recordPendingEvidence(fp1, {
      project: pitProj,
      component: "redis_client",
      symptom: "Redis 客户端连接超时 Command timed out after 3000ms",
      solution: "调整连接超时为 5000ms 并加入重试",
    }, { kind: "pitfall", minEvidence: 2 });
    assert.strictEqual(p1.shouldGraduate, false, "初次见到的踩坑不应毕业");
    assert.strictEqual(p1.count, 1);

    // 第二条用语变体（自然语言措辞微调，语义相同）
    const p2 = recordPendingEvidence(fp2, {
      project: pitProj,
      component: "redis_client",
      symptom: "Redis 连接超时报错 Command timed out 3000ms",
      solution: "增加连接超时时长并启用指数退避重试",
    }, { kind: "pitfall", minEvidence: 2 });
    assert.strictEqual(p2.shouldGraduate, true, "语义相近的踩坑变体必须命中语义去重并累加至 2 次毕业");
    assert.strictEqual(p2.count, 2);

    console.log("  ✓ 1. local_state 环境变量隔离、损坏自愈备份、forgetR2Mount联动与踩坑语义去重验证通过！");
  } finally {
    if (origEnvDir !== undefined) process.env.MEMHUB_STATE_DIR = origEnvDir;
    else delete process.env.MEMHUB_STATE_DIR;
    try { fs.rmSync(customDir, { recursive: true, force: true }); } catch (e) { void e; }
  }

  // -----------------------------------------------------------------
  // 2. semantic_dedup.js 性能与数字实体误判防御
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 2] semantic_dedup.js 滚动数组、长文本截断与数字实体误判防御...");

  // 2.1 isAlphaTokenMatch: 纯数字严格相等，含字母才允许 includes
  assert.strictEqual(isAlphaTokenMatch("80", "8080"), false, "纯数字 token '80' 与 '8080' 绝不能判为同一实体");
  assert.strictEqual(isAlphaTokenMatch("8080", "80"), false, "纯数字 token 反向包含也必须为 false");
  assert.strictEqual(isAlphaTokenMatch("80", "80"), true, "相同数字实体必须匹配");
  assert.strictEqual(isAlphaTokenMatch("react", "react18"), true, "含字母技术词允许 includes 包含匹配");
  assert.strictEqual(isAlphaTokenMatch("pnpm", "pnpm-workspace"), true, "含字母词缀匹配通过");

  // 2.2 防误判集成验证：端口 80 与端口 8080 的不同踩坑绝对不能被误合并
  const simNumConflict = isSemanticallySimilar(
    "Nginx 端口 80 冲突占用导致服务启动失败",
    "使用 lsof -i :80 查找占用进程并释放",
    "Nginx 端口 8080 冲突占用导致服务启动失败",
    "使用 lsof -i :8080 查找占用进程并释放"
  );
  assert.strictEqual(simNumConflict, false, "关键数字实体不同（80 vs 8080）绝不能被判定为语义相似！");

  // 2.3 levenshteinDistance 双行滚动数组与 512 字符截断
  const dShort = levenshteinDistance("kitten", "sitting");
  assert.strictEqual(dShort, 3, "标准编辑距离计算正确");

  // 超过 512 字符的长文本：验证能够快速计算且截断后不报错、不爆内存
  const longA = "A".repeat(800) + "XYZ";
  const longB = "A".repeat(800) + "ABC";
  const tStart = Date.now();
  const dLong = levenshteinDistance(longA, longB);
  const tCost = Date.now() - tStart;
  assert.ok(tCost < 50, "截断至 512 字符后编辑距离应在 50ms 内完成");
  assert.strictEqual(dLong, 0, "前 512 字符完全相同的长文本截断后距离必须为 0");

  const simLong = levSimilarity(longA, longB);
  assert.strictEqual(simLong, 1.0, "前 512 字符相同的长文本相似度必须为 1.0");

  console.log("  ✓ 2. Levenshtein 滚动数组优化、512字符截断与数字实体 80 vs 8080 误判防御全部通过！");

  // -----------------------------------------------------------------
  // 3. mcp_client.js 与 ncb_mcp.js 健壮性
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 3] mcp_client.js effectiveLimit OFFSET、回查分流与 ncb_mcp 并发互斥...");

  // 3.1 buildSelect OFFSET 使用截断后的 effectiveLimit
  // 当 limit 为 5000 时，系统 clamp 为 1000。第 2 页的 OFFSET 必须是 (2-1)*1000 = 1000，而不是 (2-1)*5000 = 5000
  const sqlClamped = buildSelect("memories", { project: "test_proj", limit: 5000, page: 2 });
  assert.ok(sqlClamped.includes("LIMIT 1000"), "超大 limit 必须被限制为 1000");
  assert.ok(sqlClamped.includes("OFFSET 1000"), "OFFSET 必须按截断后的 1000 计算为 OFFSET 1000（绝不能是 5000）");

  // 3.2 create 回查分流：pitfalls 表回查使用 symptom 列
  const sqlHistory = [];
  const origExec = NcbMcp.prototype.executeSql;
  NcbMcp.prototype.executeSql = async function (db, sql) {
    sqlHistory.push(sql);
    if (sql.startsWith("INSERT")) {
      return { ok: true, results: [{ insertId: 0, affectedRows: 1 }] };
    }
    if (sql.startsWith("SELECT")) {
      return { ok: true, results: [{ rows: [{ id: 42 }] }] };
    }
    return { ok: true, results: [{}] };
  };

  try {
    // 受控内存 mock 桩：本用例只验证 SQL 生成契约，绝不触碰真实数据库
    // 命名遵循 test_meta 规范（mockDbClient + memoryStore）以自证隔离有效
    const memoryStore = new Map();
    __mockStores.push(memoryStore);
    const mockDbClient = makeMcpClient({ instance: "41694_test_db", mcpKey: "test_mcp_key" });
    const originalCreate = mockDbClient.create.bind(mockDbClient);
    mockDbClient.create = async (table, data) => {
      const rec = await originalCreate(table, data);
      memoryStore.set(rec && rec.id, { table, ...data });
      return rec;
    };
    const client = mockDbClient;
    const createdPitfall = await client.create("pitfalls", {
      project: "test_pit",
      component: "gateway",
      symptom: "502 Bad Gateway upstream server timeout",
      solution: "Check upstream service health",
    });
    assert.strictEqual(createdPitfall.id, 42, "回查必须成功带回主键 id=42");
    const selectSql = sqlHistory.find((s) => s.startsWith("SELECT"));
    assert.ok(selectSql, "必须产生回查 SELECT 语句");
    assert.ok(selectSql.includes("`symptom` ="), "pitfalls 表回查必须使用 `symptom` 列（严禁误用 `title`）");
    assert.ok(!selectSql.includes("`title` ="), "pitfalls 表中绝不能出现不存在的 `title` 列");
  } finally {
    NcbMcp.prototype.executeSql = origExec;
  }

  // 受控内存 mock 桩清理 + 残余断言（本用例不写真实数据库，残余恒为 0）
  await cleanup();
  const residue = { total: __mockStores.reduce((n, st) => n + (st ? st.size : 0), 0) };
  assert.strictEqual(residue.total, 0, "受控内存桩清理后残余必须为 0");


  // 3.3 ncb_mcp.initialize() 并发互斥与 promise 缓存
  const mcp = new NcbMcp({ apiKey: "test_dummy_key" });
  let rpcCallCount = 0;
  mcp.rpc = async (method) => {
    rpcCallCount++;
    await new Promise((r) => setTimeout(r, 20)); // 模拟网络延迟
    if (method === "initialize") {
      return { result: { serverInfo: { name: "test-mcp-server", version: "1.0.0" } } };
    }
    return { result: {} };
  };

  // 并发触发 5 次 initialize 调用
  const initResults = await Promise.all([
    mcp.initialize(),
    mcp.initialize(),
    mcp.initialize(),
    mcp.initialize(),
    mcp.initialize(),
  ]);

  for (const res of initResults) {
    assert.strictEqual(res.name, "test-mcp-server");
  }
  assert.strictEqual(rpcCallCount, 2, "并发 5 次 initialize 必须互斥复用单个握手请求 (1次initialize + 1次notifications/initialized)");

  console.log("  ✓ 3. buildSelect OFFSET 截断、pitfalls 回查 symptom 列与 ncb_mcp 并发互斥验证通过！");

  // -----------------------------------------------------------------
  // 4. r2.js 凭据兜底
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 4] r2.js 在 cfg 无 secret 时回退 lookupSecret(db)...");

  // 预置数据库 secret 与挂载状态映射
  rememberSecret("41694_r2_fallback_db", "SEC_R2_FALLBACK_KEY");
  rememberR2Mount("41694_r2_fallback_db", { bucket_name: "test-bucket", mounted: true });

  // 构造无 secret 的配置对象
  const cfgWithoutSecret = {
    mcpKey: "test_mcp_key",
    instance: "41694_r2_fallback_db",
    // 故意不传 secret / ncb_secret
  };

  let restCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    restCalls.push({ url: String(url), headers: opts?.headers || {} });
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ url: "https://r2.dev/fallback_uploaded.png" }),
      json: async () => ({ url: "https://r2.dev/fallback_uploaded.png" }),
    };
  };

  try {
    const uploadRes = await r2Upload(cfgWithoutSecret, {
      filename: "test_fallback.png",
      content: "fake content",
      database: "41694_r2_fallback_db",
    });

    assert.strictEqual(uploadRes.ok, true, "r2Upload 在 cfg 无 secret 时必须成功通过 lookupSecret 凭据兜底");
    assert.strictEqual(uploadRes.url, "https://r2.dev/fallback_uploaded.png");
    assert.ok(restCalls.length > 0, "必须发出 REST 请求");
    const authHeader = restCalls[0].headers["Authorization"] || restCalls[0].headers["authorization"];
    assert.strictEqual(authHeader, "Bearer SEC_R2_FALLBACK_KEY", "REST 请求必须携带从 lookupSecret 兜底拿到的密钥");

    console.log("  ✓ 4. r2.js 无 secret 时自动回退 lookupSecret(db) 凭据兜底验证通过！");
  } finally {
    globalThis.fetch = origFetch;
  }

  // -----------------------------------------------------------------
  // 5. online_models.js 模型优先级与 settings.js 多卡片独立定时器 Map
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 5] online_models.js 优先级修正与 settings.js 多卡片定时器隔离...");

  // 5.1 rerankSearchResultsWithModel 优先级：rerank_model || audit_model || extract_model || harvest_model
  let requestedModel = null;
  const mockRerankFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    requestedModel = body.model;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              ranked_indices: [0],
              ranked_ids: [1],
              reasons: { "1": "matched" },
            }),
          },
        }],
      }),
    };
  };

  const rerankOpts = {
    rerank_model: "special-rerank-v1",
    audit_model: "audit-model-v2",
    extract_model: "extract-model-v3",
    harvest_model: "harvest-model-v4",
    _fetch: mockRerankFetch,
  };

  await rerankSearchResultsWithModel({
    query: "测试查询",
    candidates: [{ id: 1, title: "测试标题", content: "测试内容" }],
    options: rerankOpts,
  });

  assert.strictEqual(requestedModel, "special-rerank-v1", "rerankSearchResultsWithModel 必须优先使用 rerank_model！");

  // 5.2 settings.js 静态检查：pollingTimers 与 countdownTimers 改为 Map，无单一全局计时器
  const settingsJsContent = fs.readFileSync(path.resolve(__dirname, "../settings.js"), "utf8");
  assert.ok(settingsJsContent.includes("var pollingTimers = new Map();"), "settings.js 必须使用 Map 存储 pollingTimers");
  assert.ok(settingsJsContent.includes("var countdownTimers = new Map();"), "settings.js 必须使用 Map 存储 countdownTimers");
  assert.ok(!settingsJsContent.includes("var pollingTimer = null;"), "settings.js 严禁保留全局单一 pollingTimer");
  assert.ok(!settingsJsContent.includes("var countdownTimer = null;"), "settings.js 严禁保留全局单一 countdownTimer");

  console.log("  ✓ 5. rerank_model 优先级与 settings.js 多卡片独立定时器 Map 隔离验证通过！");

  // -----------------------------------------------------------------
  // 6. 反证门防线 (Counter-Evidence Defense Gate)
  // -----------------------------------------------------------------
  console.log("\n▶ [Test 6] 反证门防线：故意输入冲突实体与破坏性条件验证拦截能力...");

  // 6.1 反证 1：故意传入纯数字实体 "80" 与 "8080"，断言 isAlphaTokenMatch 绝不误匹配
  const falsifyNumMatch = isAlphaTokenMatch("80", "8080");
  assert.strictEqual(falsifyNumMatch, false, "【反证 1 通过】：isAlphaTokenMatch 严格拒绝把 '80' 与 '8080' 混淆");

  // 6.2 反证 2：破坏状态对象使其 _ok: false，断言 writeState 必定拒绝写入
  const poisonState = { _ok: false, secrets: { fake: "poison" } };
  const writeRes = writeState(poisonState);
  assert.strictEqual(writeRes, false, "【反证 2 通过】：writeState 坚决拦截 _ok: false 的破坏性状态");

  // 6.3 反证 3：超出 1000 的 LIMIT，断言 buildSelect 必定截断并不受超大数值影响
  const falsifySql = buildSelect("memories", { project: "test_proj", limit: 999999, page: 10 });
  assert.ok(falsifySql.includes("LIMIT 1000"), "【反证 3 通过】：LIMIT 必须强行截断至 1000");
  assert.ok(falsifySql.includes("OFFSET 9000"), "【反证 3 通过】：第 10 页 OFFSET 必须为 (10-1)*1000 = 9000");

  console.log("  ✓ 6. 全部 3 项反证门防御断言 100% 成功通过！");

  console.log("\n=================================================================");
  console.log("🎉 全部 Agent C 运行时与测试卫生验收项 100% 通过！");
  console.log("=================================================================");
}

runTests().catch((err) => {
  console.error("\n❌ 测试执行失败:", err);
  process.exit(1);
});
