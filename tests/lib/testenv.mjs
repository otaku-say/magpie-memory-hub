/**
 * tests/lib/testenv.mjs
 * 统一测试隔离基座：
 * 1. 唯一命名空间：自动生成 __test__<timestamp>_<rand> project
 * 2. 真实 MCP 连接与环境探测：缺失凭据时明确报告并退出，拒绝静默假过
 * 3. 自检：启动时断言当前 project 无残留
 * 4. 强制清理与断言：按 project 删除 memories / pitfalls 并断言残留数必为 0
 * 5. 登记式清理：捕获异常与进程退出钩子，异常崩溃亦触发清理
 * 6. 真实库安全防线：严禁在生产库 (41694_agent_memory) 上执行全表 drop / reset
 */

import assert from "node:assert";
import fs from "node:fs";
import crypto from "node:crypto";
import { NcbMcp } from "../../ncb_mcp.js";
import { makeMcpClient } from "../../mcp_client.js";
import { MagpieMemoryHub } from "../../tools.js";
import { lookupSecret } from "../../local_state.js";

const activeEnvs = new Set();
let processHooksRegistered = false;

function ensureProcessHooks() {
  if (processHooksRegistered) return;
  processHooksRegistered = true;

  const runAllCleanupSyncOrAsync = async (reason) => {
    if (activeEnvs.size === 0) return;
    console.warn(`[testenv] 进程收到中断/异常 (${reason})，执行登记式清理...`);
    const envs = Array.from(activeEnvs);
    for (const env of envs) {
      try {
        await env.cleanup();
      } catch (err) {
        console.error(`[testenv] 紧急清理失败 (${env.project}):`, err.message);
      }
    }
  };

  process.on("unhandledRejection", async (reason) => {
    console.error("[testenv] unhandledRejection:", reason);
    await runAllCleanupSyncOrAsync("unhandledRejection");
    process.exit(1);
  });

  process.on("uncaughtException", async (err) => {
    console.error("[testenv] uncaughtException:", err);
    await runAllCleanupSyncOrAsync("uncaughtException");
    process.exit(1);
  });

  process.on("SIGINT", async () => {
    await runAllCleanupSyncOrAsync("SIGINT");
    process.exit(130);
  });

  process.on("SIGTERM", async () => {
    await runAllCleanupSyncOrAsync("SIGTERM");
    process.exit(143);
  });
}

/**
 * 获取环境中的有效凭据
 */
export function getCredentials(instance = "41694_agent_memory") {
  const mcpKey = process.env.NOCODEBACKEND_API_KEY || "";
  let secret = lookupSecret(instance) || "";
  if (!secret) {
    try {
      secret = fs.readFileSync("/tmp/ncb_sec.key", "utf8").trim();
    } catch (_) {}
  }
  return { mcpKey, secret };
}

/**
 * 校验必需环境变量。若缺失，显式报告并以标准非零 SKIP 码退出，绝不静默假过。
 */
export function requireEnv(opts = {}) {
  const requireMcp = opts.requireMcp !== false;
  const requireSecret = opts.requireSecret === true;
  const instance = opts.instance || "41694_agent_memory";

  const { mcpKey, secret } = getCredentials(instance);

  if (requireMcp && !mcpKey) {
    console.error(`\n[SKIP] 测试需连接真实数据库，但环境变量 NOCODEBACKEND_API_KEY 未提供。`);
    console.error(`       请设置 NOCODEBACKEND_API_KEY 后重试，拒绝静默假过。\n`);
    process.exit(77); // 77 为标准测试跳过退出码 (EX_CONFIG / automake standard)
  }

  if (requireSecret && !secret) {
    console.error(`\n[SKIP] 测试需要数据库 Secret Key，但 /tmp/ncb_sec.key 或 local_state 未提供。`);
    console.error(`       拒绝静默假过。\n`);
    process.exit(77);
  }

  return { mcpKey, secret };
}

async function safeExecuteSql(mcp, instance, sql, maxRetries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await mcp.executeSql(instance, sql);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
  throw lastErr;
}

/**
 * 构造统一隔离测试环境
 */
export async function createTestEnv(options = {}) {
  ensureProcessHooks();

  const instance = options.instance || "41694_agent_memory";
  const prefix = options.prefix || "__test__";
  const { mcpKey, secret } = requireEnv({
    instance,
    requireMcp: options.requireMcp !== false,
    requireSecret: options.requireSecret === true,
  });

  // 1. 唯一 project 命名空间
  const rand = crypto.randomBytes(4).toString("hex");
  const project = `${prefix}${Date.now()}_${rand}`;

  const mcp = new NcbMcp({ apiKey: mcpKey });
  const client = makeMcpClient({ instance, mcpKey });

  const env = {
    project,
    instance,
    mcpKey,
    secret,
    mcp,
    client,
    cleaned: false,

    /** 自检：断言当前项目无残留 */
    async selfCheck() {
      const mRes = await safeExecuteSql(mcp, instance, `SELECT count(*) as c FROM memories WHERE project = "${project}";`);
      const mCount = Number(mRes?.results?.[0]?.rows?.[0]?.c || 0);
      const pRes = await safeExecuteSql(mcp, instance, `SELECT count(*) as c FROM pitfalls WHERE project = "${project}";`);
      const pCount = Number(pRes?.results?.[0]?.rows?.[0]?.c || 0);

      assert.strictEqual(mCount, 0, `[SELF_CHECK_FAIL] memories 中已存在 project='${project}' 的残留行 (${mCount})`);
      assert.strictEqual(pCount, 0, `[SELF_CHECK_FAIL] pitfalls 中已存在 project='${project}' 的残留行 (${pCount})`);
    },

    /** 检查指定数据库中所有 __test__ 开头的残留 */
    async countAllTestResidue() {
      return await checkGlobalTestResidue(instance, mcpKey);
    },

    /** 强制清理并断言计数必须为 0 */
    async cleanup() {
      if (this.cleaned) return { memoriesDeleted: 0, pitfallsDeleted: 0 };

      // 1. 执行真实清理
      const delM = await safeExecuteSql(mcp, instance, `DELETE FROM memories WHERE project = "${project}";`);
      const delP = await safeExecuteSql(mcp, instance, `DELETE FROM pitfalls WHERE project = "${project}";`);

      const mDeleted = Number(delM?.results?.[0]?.affectedRows || 0);
      const pDeleted = Number(delP?.results?.[0]?.affectedRows || 0);

      // 2. 删完再查一次计数，必须为 0
      const mCheck = await safeExecuteSql(mcp, instance, `SELECT count(*) as c FROM memories WHERE project = "${project}";`);
      const mCount = Number(mCheck?.results?.[0]?.rows?.[0]?.c || 0);
      const pCheck = await safeExecuteSql(mcp, instance, `SELECT count(*) as c FROM pitfalls WHERE project = "${project}";`);
      const pCount = Number(pCheck?.results?.[0]?.rows?.[0]?.c || 0);

      assert.strictEqual(mCount, 0, `[CLEANUP_ASSERT_FAILED] memories 表中仍有 ${mCount} 条 project='${project}' 残留！`);
      assert.strictEqual(pCount, 0, `[CLEANUP_ASSERT_FAILED] pitfalls 表中仍有 ${pCount} 条 project='${project}' 残留！`);

      this.cleaned = true;
      activeEnvs.delete(env);
      return { memoriesDeleted: mDeleted, pitfallsDeleted: pDeleted };
    },

    /** 便捷构造插件实例 */
    async createHub(overrides = {}) {
      return await MagpieMemoryHub({}, {
        ncb_instance: instance,
        mcp_key: mcpKey,
        ncb_secret: secret,
        ...overrides,
      });
    },
  };

  // 启动自检
  await env.selfCheck();
  activeEnvs.add(env);

  return env;
}

/**
 * 全局测试残留查询（静态工具）
 */
export async function checkGlobalTestResidue(instance = "41694_agent_memory", mcpKey = "") {
  const key = mcpKey || process.env.NOCODEBACKEND_API_KEY || "";
  if (!key) throw new Error("checkGlobalTestResidue 缺少 mcpKey");
  const mcp = new NcbMcp({ apiKey: key });

  const mRes = await safeExecuteSql(mcp, instance, `SELECT count(*) as c FROM memories WHERE project LIKE "__test__%";`);
  const mCount = Number(mRes?.results?.[0]?.rows?.[0]?.c || 0);

  const pRes = await safeExecuteSql(mcp, instance, `SELECT count(*) as c FROM pitfalls WHERE project LIKE "__test__%";`);
  const pCount = Number(pRes?.results?.[0]?.rows?.[0]?.c || 0);

  return { memories: mCount, pitfalls: pCount, total: mCount + pCount };
}
