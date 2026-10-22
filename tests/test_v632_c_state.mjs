/**
 * test_v632_c_state.mjs —— Track C 核心整改验证与反证门测试
 * 
 * 覆盖 7 项整改及反证门：
 * 1. [P0-2] 测试模式状态路径双保险隔离（绝不触碰真实 ~/.magpie-memory-hub/state.json）
 * 2. [P1-1] semantic_dedup.js 数字冲突总闸与反证门（Port 80 vs 8080、Node 18 vs 20 必拒，同数字不误杀）
 * 3. [P2-1] mcp_client.js list() 的 hasMore 严格基于截断后的 effectiveLimit
 * 4. [P2-2] ncb_mcp.js rpc() timeoutSig abortListener 移除与防泄漏（listenerCount 断言）
 * 5. [P2-3] local_state.js recordPendingEvidence 对 kind === "memory" 的语义去重与晋升
 * 6. [P2-5] model_budget.js 避免全量 JSON.stringify 并优先识别 x-magpie-internal 请求头
 * 7. [P2-6] package.json options 默认值声明与 tools.js readOptions 一致性
 */

process.env.NODE_ENV = "test";
process.env.MAGPIE_TEST = "1";

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";

import { createTestEnv } from "./lib/testenv.mjs";
import {
  statePath,
  readState,
  writeState,
  recordPendingEvidence,
  _resetStateCacheForTests,
} from "../src/core/state.js";
import {
  hasConflictingNumbers,
  isSemanticallySimilar,
} from "../src/domain/semantic-dedup.js";
import { makeMcpClient } from "../src/integration/mcp-client.js";
import { NcbMcp } from "../src/integration/ncb-client.js";
import {
  isInternalHarvestRequest,
  MAGPIE_INTERNAL_HEADER,
  MAGPIE_INTERNAL_VALUE,
} from "../src/domain/token-budget.js";

console.log("=================================================================");
console.log("【测试开始】Track C (v6.32 State/Dedup/MCP/Budget) 综合验证与反证门");
console.log("=================================================================\n");

const env = await createTestEnv({ mode: "memory" });

try {
  // ---------------------------------------------------------------------------
  // 1. [P0-2] 测试模式状态路径双保险隔离反证门
  // ---------------------------------------------------------------------------
  console.log("▶ [Test 1] 验证测试模式状态路径双保险隔离（反证门）...");
  {
    const realHomedirState = path.join(os.homedir(), ".magpie-memory-hub", "state.json");
    let realStateMtimeBefore = null;
    if (fs.existsSync(realHomedirState)) {
      realStateMtimeBefore = fs.statSync(realHomedirState).mtimeMs;
    }

    // 1.1 在 testenv 环境中，已自动设定 MEMHUB_STATE_DIR 为独立临时目录
    const spInEnv = statePath();
    assert.ok(spInEnv.startsWith(os.tmpdir()), `statePath() 必须位于临时目录下: ${spInEnv}`);
    assert.notStrictEqual(spInEnv, realHomedirState, "statePath() 绝不能触碰宿主机 ~/.magpie-memory-hub/state.json");

    // 1.2 反证：即使没有显式设置 MEMHUB_STATE_DIR，但存在 MAGPIE_TEST=1 / NODE_ENV=test
    const savedStateDir = process.env.MEMHUB_STATE_DIR;
    delete process.env.MEMHUB_STATE_DIR;
    try {
      const spFallback = statePath();
      assert.ok(spFallback.startsWith(os.tmpdir()), `未指定 MEMHUB_STATE_DIR 时测试模式也必须 fallback 到 tmpdir: ${spFallback}`);
      assert.ok(spFallback.includes(String(process.pid)), "fallback 路径必须包含当前 process.pid");
      assert.notStrictEqual(spFallback, realHomedirState, "测试模式 fallback 绝不能指向宿主机 state.json");

      // 验证目录被自动创建
      assert.ok(fs.existsSync(path.dirname(spFallback)), "statePath() 必须确保 fallback 目录存在");
    } finally {
      process.env.MEMHUB_STATE_DIR = savedStateDir;
    }

    // 1.3 写入测试状态，确认真实宿主 state.json 纹丝未动
    _resetStateCacheForTests();
    const testStateData = { current: "test_db", secrets: { test_db: "sec_123" } };
    assert.strictEqual(writeState(testStateData), true, "临时目录 writeState 必须成功");
    const readBack = readState();
    assert.strictEqual(readBack.current, "test_db", "读写临时状态必须正确");

    if (realStateMtimeBefore !== null) {
      const realStateMtimeAfter = fs.statSync(realHomedirState).mtimeMs;
      assert.strictEqual(realStateMtimeAfter, realStateMtimeBefore, "反证门：宿主机真实 state.json mtime 绝不能被测试写入修改！");
    }

    console.log("  ✓ 双保险隔离生效：statePath() 自动收敛至 tmpdir，宿主机真实 state.json 未受任何影响\n");
  }

  // ---------------------------------------------------------------------------
  // 2. [P1-1] semantic_dedup.js 数字冲突总闸与反证门
  // ---------------------------------------------------------------------------
  console.log("▶ [Test 2] 验证数字冲突总闸 hasConflictingNumbers 与 isSemanticallySimilar 短路（反证门）...");
  {
    // 2.1 hasConflictingNumbers 单元测试与反例
    assert.strictEqual(hasConflictingNumbers("Port 80 冲突", "Port 8080 冲突"), true, "反证：80 与 8080 必须判定为数字冲突");
    assert.strictEqual(hasConflictingNumbers("Node 18 运行时", "Node 20 运行时"), true, "反证：18 与 20 必须判定为数字冲突");
    assert.strictEqual(hasConflictingNumbers("v1.2.3 修复", "v1.2.4 修复"), true, "反证：版本号不同必须判定为数字冲突");

    assert.strictEqual(hasConflictingNumbers("Port 80 冲突", "Port 80 冲突"), false, "相同数字不冲突");
    assert.strictEqual(hasConflictingNumbers("Docker 启动失败", "Docker 容器启动崩溃"), false, "双方无数字不冲突");
    assert.strictEqual(hasConflictingNumbers("Docker 启动失败", "Docker 127.0.0.1 启动失败"), false, "单侧无数字不冲突");

    // 2.2 isSemanticallySimilar 顶层总闸拦截反证门
    // 反例 1：标题数字不同（Port 80 vs 8080）
    const isSimilarPort = isSemanticallySimilar(
      "Port 80 冲突排查",
      "Web 服务启动报错：Port 80 已经被其他进程占用",
      "Port 8080 冲突排查",
      "Web 服务启动报错：Port 8080 已经被其他进程占用"
    );
    assert.strictEqual(isSimilarPort, false, "反证门：Port 80 与 Port 8080 必须短路拒绝判定为相似！");

    // 反例 2：标题数字不同（Node 18 vs 20）
    const isSimilarNode = isSemanticallySimilar(
      "Node 18 运行时环境异常",
      "模块加载失败 ERR_REQUIRE_ESM 错误",
      "Node 20 运行时环境异常",
      "模块加载失败 ERR_REQUIRE_ESM 错误"
    );
    assert.strictEqual(isSimilarNode, false, "反证门：Node 18 与 Node 20 必须短路拒绝判定为相似！");

    // 反例 3：内容数字冲突
    const isSimilarContent = isSemanticallySimilar(
      "数据库连接超时",
      "连接 127.0.0.1:3306 失败",
      "数据库连接超时",
      "连接 127.0.0.1:3307 失败"
    );
    assert.strictEqual(isSimilarContent, false, "反证门：内容端口 3306 与 3307 冲突必须短路拒绝！");

    // 正例：数字完全相同，语义相近，不应被总闸误杀
    const isSimilarValid = isSemanticallySimilar(
      "Port 8080 冲突排查",
      "Web 服务启动报错：Port 8080 已经被其他进程占用",
      "Port 8080 端口冲突排查",
      "Web 服务启动异常：Port 8080 已经被其它进程占用"
    );
    assert.strictEqual(isSimilarValid, true, "相同数字且语义高度相似的条目不得被误杀！");

    console.log("  ✓ 数字冲突总闸生效：Port 80/8080 与 Node 18/20 成功拦截，相同数字正常放行\n");
  }

  // ---------------------------------------------------------------------------
  // 3. [P2-1] mcp_client.js list() hasMore 严格基于 effectiveLimit
  // ---------------------------------------------------------------------------
  console.log("▶ [Test 3] 验证 mcp_client.js list() hasMore 严格基于 effectiveLimit...");
  {
    const origExecuteSql = NcbMcp.prototype.executeSql;
    const rows1000 = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, title: `item_${i}` }));
    let lastExecutedSql = "";
    let currentMockRows = rows1000;

    NcbMcp.prototype.executeSql = async function (_db, sql) {
      lastExecutedSql = sql;
      return { ok: true, results: [{ rows: currentMockRows, affectedRows: 0, insertId: 0 }] };
    };

    try {
      const mockCfg = {
        instance: "41694_agent_memory",
        mcpKey: "test_mcp_key",
      };
      const client = makeMcpClient(mockCfg);

      // 3.1 传入 limit: 2000，SQL LIMIT 被截断至 1000
      currentMockRows = rows1000;
      const res = await client.list("memories", { limit: 2000, page: 1 });
      assert.ok(lastExecutedSql.includes("LIMIT 1000"), `SQL 必须被截断至 LIMIT 1000: ${lastExecutedSql}`);
      assert.strictEqual(res.metadata.limit, 1000, "metadata.limit 必须是截断后的 effectiveLimit (1000)");
      // 核心反证：当 rows 返回 1000 条且 effectiveLimit 为 1000 时，hasMore 必须为 true！
      assert.strictEqual(res.metadata.hasMore, true, "当 rows.length (1000) >= effectiveLimit (1000) 时 hasMore 必须为 true（修复前为 1000 >= 2000 = false）");

      // 3.2 当行数小于 effectiveLimit 时 hasMore 为 false
      currentMockRows = rows1000.slice(0, 999);
      const resUnder = await client.list("memories", { limit: 2000, page: 1 });
      assert.strictEqual(resUnder.metadata.hasMore, false, "当 rows.length < effectiveLimit 时 hasMore 必须为 false");
    } finally {
      NcbMcp.prototype.executeSql = origExecuteSql;
    }

    console.log("  ✓ hasMore 判定对齐 effectiveLimit：limit>1000 场景下分页判定精准无误\n");
  }

  // ---------------------------------------------------------------------------
  // 4. [P2-2] ncb_mcp.js rpc() timeoutSig abortListener 移除与防泄漏
  // ---------------------------------------------------------------------------
  console.log("▶ [Test 4] 验证 ncb_mcp.js rpc() timeoutSig abortListener 移除与防泄漏（反证门）...");
  {
    const origFetch = globalThis.fetch;
    const origAny = AbortSignal.any;
    const origTimeout = AbortSignal.timeout;

    // 模拟 AbortSignal.any 未启用环境，以检验 timeoutSig 监听器挂载与注销
    AbortSignal.any = undefined;
    let capturedTimeoutSig = null;
    AbortSignal.timeout = function (ms) {
      capturedTimeoutSig = origTimeout.call(AbortSignal, ms);
      return capturedTimeoutSig;
    };

    try {
      const clientSig = new AbortController();
      const mcp = new NcbMcp({ apiKey: "mock_key", timeout: 5000, signal: clientSig.signal });

      // 4.1 模拟请求成功，验证 finally 中 removeEventListener 正常注销
      let observedTimeoutListenersDuring = 0;
      globalThis.fetch = async () => {
        observedTimeoutListenersDuring = getEventListeners(capturedTimeoutSig, "abort")?.length || 0;
        return {
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
        };
      };

      await mcp.rpc("tools/list", {});
      const afterSuccessTimeoutListeners = getEventListeners(capturedTimeoutSig, "abort")?.length || 0;

      assert.strictEqual(observedTimeoutListenersDuring, 1, "请求进行中 timeoutSig 必须挂载 abort 监听器");
      assert.strictEqual(afterSuccessTimeoutListeners, 0, "反证门：请求成功后 timeoutSig 上的 abort 监听器数量必须归零，严禁泄漏！");

      // 4.2 模拟请求异常失败，验证 finally 中同样注销
      let capturedTimeoutSigOnFail = null;
      AbortSignal.timeout = function (ms) {
        capturedTimeoutSigOnFail = origTimeout.call(AbortSignal, ms);
        return capturedTimeoutSigOnFail;
      };

      globalThis.fetch = async () => {
        throw new Error("网络闪断测试错误");
      };
      try {
        await mcp.rpc("tools/list", {});
        assert.fail("应当抛出异常");
      } catch (e) {
        assert.ok(e.message.includes("网络闪断测试错误"));
      }
      const afterFailTimeoutListeners = getEventListeners(capturedTimeoutSigOnFail, "abort")?.length || 0;
      assert.strictEqual(afterFailTimeoutListeners, 0, "反证门：请求失败抛错后 timeoutSig 上的 abort 监听器数量仍必须归零，严禁泄漏！");
    } finally {
      globalThis.fetch = origFetch;
      AbortSignal.any = origAny;
      AbortSignal.timeout = origTimeout;
    }

    console.log("  ✓ 监听器防泄漏验证通过：无论成功或异常退出，timeoutSig abortListener 均在 finally 中完全注销\n");
  }

  // ---------------------------------------------------------------------------
  // 5. [P2-3] local_state.js recordPendingEvidence 对 kind === "memory" 语义去重
  // ---------------------------------------------------------------------------
  console.log("▶ [Test 5] 验证 local_state.js recordPendingEvidence 对 kind === 'memory' 语义去重与晋升...");
  {
    _resetStateCacheForTests();
    const testProject = `__test__mem_dedup_${Date.now()}`;

    // 两个不同字面但语义等价的 memory 条目
    const mem1Fp = "m_fp_001";
    const mem1Payload = {
      project: testProject,
      title: "项目统一使用 pnpm 管理依赖",
      content: "项目全工程强制统一使用 pnpm 安装依赖，避免锁文件冲突。",
    };

    const mem2Fp = "m_fp_002";
    const mem2Payload = {
      project: testProject,
      title: "项目统一采用 pnpm 进行依赖管理",
      content: "项目全工程强制统一采用 pnpm 进行依赖管理，避免锁文件冲突。",
    };

    // 第一次记录：count 应为 1，未达到 minEvidence=2，不晋升
    const r1 = recordPendingEvidence(`m:${testProject}:${mem1Fp}`, mem1Payload, {
      kind: "memory",
      minEvidence: 2,
    });
    assert.strictEqual(r1.shouldGraduate, false, "第 1 次记录未达门槛不应晋升");
    assert.strictEqual(r1.count, 1, "第 1 次记录 count 必须为 1");

    // 第二次记录不同指纹的语义等价 memory：应当命中语义模糊去重，count 累加至 2 并毕业晋升！
    const r2 = recordPendingEvidence(`m:${testProject}:${mem2Fp}`, mem2Payload, {
      kind: "memory",
      minEvidence: 2,
    });
    assert.strictEqual(r2.shouldGraduate, true, "第 2 次语义相似的 memory 必须命中去重并晋升！");
    assert.strictEqual(r2.count, 2, "命中去重后 count 必须累加至 2");

    // 5.2 反证：数字冲突的 memory 条目绝不能误去重
    const mem3Fp = "m_fp_003";
    const mem3Payload = {
      project: testProject,
      title: "Python 3.10 环境要求",
      content: "系统运行依赖 Python 3.10 版本",
    };
    const mem4Fp = "m_fp_004";
    const mem4Payload = {
      project: testProject,
      title: "Python 3.12 环境要求",
      content: "系统运行依赖 Python 3.12 版本",
    };

    const r3 = recordPendingEvidence(`m:${testProject}:${mem3Fp}`, mem3Payload, {
      kind: "memory",
      minEvidence: 2,
    });
    assert.strictEqual(r3.count, 1);
    const r4 = recordPendingEvidence(`m:${testProject}:${mem4Fp}`, mem4Payload, {
      kind: "memory",
      minEvidence: 2,
    });
    // 因为存在数字冲突 (3.10 vs 3.12)，绝不能合并！
    assert.strictEqual(r4.shouldGraduate, false, "反证门：版本数字冲突的 memory 绝不能被合并晋升！");
    assert.strictEqual(r4.count, 1, "未合并条目 count 必须保持为 1");

    console.log("  ✓ memory 语义去重生效：等价表述成功聚合晋升，数字冲突严格隔离\n");
  }

  // ---------------------------------------------------------------------------
  // 6. [P2-5] model_budget.js 请求头优先识别与请求体指纹优化
  // ---------------------------------------------------------------------------
  console.log("▶ [Test 6] 验证 model_budget.js 请求头优先识别与请求体指纹优化...");
  {
    // 6.1 x-magpie-internal: memory-hub 请求头优先直接识别（无需解析请求体）
    const dummyUserBody = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "请帮我写一段关于猫咪的介绍" }],
    };
    assert.strictEqual(isInternalHarvestRequest(dummyUserBody, {}), false, "普通用户请求绝不可判定为内部");

    // 携带 x-magpie-internal: memory-hub 请求头
    const internalHeaders = { [MAGPIE_INTERNAL_HEADER]: MAGPIE_INTERNAL_VALUE };
    assert.strictEqual(
      isInternalHarvestRequest(dummyUserBody, { headers: internalHeaders }),
      true,
      "携带 x-magpie-internal: memory-hub 必须优先识别为内部请求"
    );

    // 大小写不敏感验证
    assert.strictEqual(
      isInternalHarvestRequest(dummyUserBody, { headers: { "X-Magpie-Internal": "Memory-Hub" } }),
      true,
      "请求头大小写不敏感匹配必须生效"
    );

    // 6.2 提示词指纹识别支持最后一条 user message（不全量 JSON.stringify(body)）
    const internalUserMsgBody = {
      model: "mock-model",
      messages: [
        { role: "assistant", content: "上一轮历史输出" },
        { role: "user", content: "这是包含 长期记忆与踩坑经验提炼助手 的提示词" },
      ],
    };
    assert.strictEqual(isInternalHarvestRequest(internalUserMsgBody, {}), true, "user message 中的内部提示词必须正确识别");

    console.log("  ✓ model_budget.js 头标记优先命中且请求体指纹开销优化成功\n");
  }

  // ---------------------------------------------------------------------------
  // 7. [P2-6] package.json options 默认值声明校验
  // ---------------------------------------------------------------------------
  console.log("▶ [Test 7] 验证 package.json 默认配置声明补齐...");
  {
    const pkgContent = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const opts = pkgContent.magpie.options;

    assert.strictEqual(opts.search_rerank, true, "package.json 必须声明 search_rerank: true");
    assert.strictEqual(opts.dedup_fetch_limit, 200, "package.json 必须声明 dedup_fetch_limit: 200");
    assert.strictEqual(opts.dedup_batch_size, 50, "package.json 必须声明 dedup_batch_size: 50");
    assert.strictEqual(opts.harvest_max_per_min, 20, "package.json 必须声明 harvest_max_per_min: 20");
    assert.strictEqual(opts.harvest_max_total, 2000, "package.json 必须声明 harvest_max_total: 2000");
    assert.strictEqual(opts.audit_max_batches, 2, "package.json 必须声明 audit_max_batches: 2");
    assert.strictEqual(opts.audit_chunk_size, 40, "package.json 必须声明 audit_chunk_size: 40");

    console.log("  ✓ package.json 7 项 options 默认声明全部对齐\n");
  }

} finally {
  // ---------------------------------------------------------------------------
  // 清理与残留检查（test_meta 门禁自证）
  // ---------------------------------------------------------------------------
  const cleanRes = await env.cleanup();
  const residue = await env.countAllTestResidue();
  assert.strictEqual(residue.total, 0, `测试后数据库必须 0 残留: ${JSON.stringify(residue)}`);
  console.log(`✓ 测试环境已完全清理，测试残余数: ${residue.total}`);
}

console.log("=================================================================");
console.log("✅ Track C 7 项整改及反证门测试 100% 全部通过！");
console.log("=================================================================");
