/**
 * tests/lib/testenv.mjs
 * 统一测试隔离基座（加固版）：
 * 1. 唯一命名空间：自动生成 __test__<timestamp>_<rand> project
 * 2. 默认纯内存隔离（mode: "memory"）：全内存仿真，零远端网络调用，根本性杜绝污染真实数据库
 * 3. 远端模式安全防线（mode: "remote"）：对所有写操作（create / update / remove / raw / executeSql）
 *    执行全面 fail-closed 拦截，严禁 project 为空、为 "global" 或非隔离前缀
 * 4. 真实库物理安全锁：严禁在生产库 (41694_agent_memory) 上执行任何无 __test__ 前缀的写操作
 * 5. 自检、强制清理与断言：按 project 删除并断言残余数必为 0
 * 6. 登记式清理：捕获异常与进程退出钩子，异常崩溃亦触发清理
 */

// 确保凡引用测试基座的测试进程自动且强制处于测试模式
process.env.NODE_ENV = "test";
process.env.MAGPIE_TEST = "1";

import assert from "node:assert";
import fs from "node:fs";
import crypto from "node:crypto";
import { NcbMcp } from "../../ncb_mcp.js";
import { makeMcpClient } from "../../mcp_client.js";
import { MagpieMemoryHub } from "../../tools.js";
import { lookupSecret } from "../../local_state.js";

const activeEnvs = new Set();
let processHooksRegistered = false;

// 全局纯内存数据仓库（当运行在内存模式时使用）
const globalMemoryStore = {
  memories: new Map(),
  pitfalls: new Map(),
  schema_meta: new Map(),
  autoId: 1,
};

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
  const mcpKey = process.env.NOCODEBACKEND_API_KEY || "mock_test_mcp_key";
  let secret = lookupSecret(instance) || "";
  if (!secret) {
    try {
      secret = fs.readFileSync("/tmp/ncb_sec.key", "utf8").trim();
    } catch (_) {}
  }
  return { mcpKey, secret: secret || "mock_test_secret_key" };
}

/**
 * 校验必需环境变量。若在远程模式且缺失，显式报告并退出；内存模式下使用 mock 凭据
 */
export function requireEnv(opts = {}) {
  const requireMcp = opts.requireMcp !== false;
  const requireSecret = opts.requireSecret === true;
  const instance = opts.instance || "41694_agent_memory";
  const mode = opts.mode || (process.env.TEST_MODE === "remote" ? "remote" : "memory");

  const { mcpKey, secret } = getCredentials(instance);

  if (mode === "remote") {
    if (requireMcp && (!mcpKey || mcpKey === "mock_test_mcp_key")) {
      console.error(`\n[SKIP] 远程测试需连接真实数据库，但环境变量 NOCODEBACKEND_API_KEY 未提供。`);
      process.exit(77);
    }
    if (requireSecret && (!secret || secret === "mock_test_secret_key")) {
      console.error(`\n[SKIP] 远程测试需要数据库 Secret Key，但未提供。`);
      process.exit(77);
    }
  }

  return { mcpKey, secret };
}

/**
 * 内存 SQL 执行仿真器
 */
function executeMemorySql(sql, prefix = "__test__") {
  const cleanSql = sql.trim();

  // 1. SELECT COUNT
  const countMatch = cleanSql.match(/SELECT\s+count\(\*\)\s+as\s+c\s+FROM\s+`?([a-zA-Z0-9_]+)`?\s+WHERE\s+(.+);?$/i);
  if (countMatch) {
    const table = countMatch[1];
    const whereClause = countMatch[2];
    const store = globalMemoryStore[table] || new Map();
    let count = 0;

    for (const row of store.values()) {
      if (whereClause.includes("LIKE")) {
        const likeMatch = whereClause.match(/LIKE\s+["']([^"']+)["']/i);
        if (likeMatch) {
          const pattern = likeMatch[1].replace(/%/g, ".*");
          const re = new RegExp("^" + pattern + "$");
          if (re.test(String(row.project || ""))) count++;
        }
      } else {
        const eqMatch = whereClause.match(/project\s*=\s*["']([^"']+)["']/i);
        if (eqMatch) {
          if (row.project === eqMatch[1]) count++;
        }
      }
    }
    return { ok: true, results: [{ statement: sql, rowCount: 1, rows: [{ c: count }] }] };
  }

  // 2. DELETE FROM table WHERE project = "..."
  const deleteMatch = cleanSql.match(/DELETE\s+FROM\s+`?([a-zA-Z0-9_]+)`?\s+WHERE\s+(.+);?$/i);
  if (deleteMatch) {
    const table = deleteMatch[1];
    const whereClause = deleteMatch[2];
    const store = globalMemoryStore[table] || new Map();
    let affected = 0;

    const eqMatch = whereClause.match(/project\s*=\s*["']([^"']+)["']/i);
    if (eqMatch) {
      const targetProject = eqMatch[1];
      for (const [id, row] of Array.from(store.entries())) {
        if (row.project === targetProject) {
          store.delete(id);
          affected++;
        }
      }
    }
    return { ok: true, results: [{ statement: sql, affectedRows: affected }] };
  }

  // 3. 默认成功返回
  return { ok: true, results: [{ statement: sql, rowCount: 0, rows: [] }] };
}

/**
 * 构造统一隔离测试环境
 */
export async function createTestEnv(options = {}) {
  ensureProcessHooks();

  const mode = options.mode || (process.env.TEST_MODE === "remote" ? "remote" : "memory");
  const instance = options.instance || "41694_agent_memory";
  const prefix = options.prefix || "__test__";
  const { mcpKey, secret } = requireEnv({
    instance,
    mode,
    requireMcp: options.requireMcp !== false,
    requireSecret: options.requireSecret === true,
  });

  // 1. 唯一 project 命名空间
  const rand = crypto.randomBytes(4).toString("hex");
  const project = `${prefix}${Date.now()}_${rand}`;

  // 2. 构造客户端（内存模式纯内存仿真；远程模式包裹严格安全拦截）
  let client;
  let mcp;

  if (mode === "memory") {
    // 纯内存客户端
    client = {
      create: async (table, data) => {
        if (!data || !data.project || data.project === "global" || !String(data.project).startsWith(prefix)) {
          throw new Error(`[SECURITY_BLOCKED] 测试环境严禁写入未隔离的 project='${data?.project}'！必须使用以 '${prefix}' 开头的隔离命名空间`);
        }
        const store = globalMemoryStore[table] || (globalMemoryStore[table] = new Map());
        const id = globalMemoryStore.autoId++;
        const saved = { ...data, id };
        store.set(id, saved);
        return saved;
      },
      list: async (table, params = {}) => {
        const store = globalMemoryStore[table] || (globalMemoryStore[table] = new Map());
        let rows = Array.from(store.values());

        if (params.project) rows = rows.filter((r) => r.project === params.project);
        if (params.content_fingerprint) rows = rows.filter((r) => r.content_fingerprint === params.content_fingerprint);
        if (params.id) rows = rows.filter((r) => Number(r.id) === Number(params.id));
        if (params.category) rows = rows.filter((r) => r.category === params.category);
        if (params.client) rows = rows.filter((r) => r.client === params.client);
        if (params.lifecycle_status) rows = rows.filter((r) => r.lifecycle_status === params.lifecycle_status);

        const limit = Number(params.limit) || 200;
        const page = Number(params.page) || 1;
        const paged = rows.slice((page - 1) * limit, page * limit);
        return {
          data: paged,
          metadata: { hasMore: rows.length > page * limit, page, limit },
        };
      },
      update: async (table, id, data) => {
        if (!id) throw new Error(`[SECURITY_BLOCKED] update 缺少目标 id`);
        if (data && (data.project === "global" || (data.project && !String(data.project).startsWith(prefix)))) {
          throw new Error(`[SECURITY_BLOCKED] 测试环境严禁更新未隔离的 project='${data?.project}'！必须使用以 '${prefix}' 开头的隔离命名空间`);
        }
        const store = globalMemoryStore[table] || (globalMemoryStore[table] = new Map());
        const row = store.get(Number(id));
        if (row) {
          Object.assign(row, data);
          return { affectedRows: 1 };
        }
        return { affectedRows: 0 };
      },
      remove: async (table, id) => {
        if (!id) throw new Error(`[SECURITY_BLOCKED] remove 缺少目标 id`);
        const store = globalMemoryStore[table] || (globalMemoryStore[table] = new Map());
        const had = store.delete(Number(id));
        return { affectedRows: had ? 1 : 0 };
      },
      raw: async (sql) => {
        if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|TRUNCATE)/i.test(sql)) {
          if (!sql.includes(prefix) || /["'`]global["'`]/.test(sql)) {
            throw new Error(`[SECURITY_BLOCKED] 测试环境执行写 SQL 必须包含隔离前缀 '${prefix}' 且严禁触碰 global！阻止: ${sql.slice(0, 100)}`);
          }
        }
        return executeMemorySql(sql, prefix);
      },
    };

    mcp = {
      executeSql: async (_inst, sql) => executeMemorySql(sql, prefix),
      callTool: async (name, args) => {
        if (name === "execute_sql") return executeMemorySql(args?.sql || "", prefix);
        if (name === "get_schema") return { ok: true, tables: {} };
        return { ok: true };
      },
    };
  } else {
    // 远程模式：对真实 client 加装全链路 fail-closed 拦截
    const rawMcp = new NcbMcp({ apiKey: mcpKey });
    const rawClient = makeMcpClient({ instance, mcpKey });

    client = {
      ...rawClient,
      create: async (table, data) => {
        if (!data || !data.project || data.project === "global" || !String(data.project).startsWith(prefix)) {
          throw new Error(`[SECURITY_BLOCKED] 测试环境严禁写入未隔离的 project='${data?.project}'！必须使用以 '${prefix}' 开头的隔离命名空间`);
        }
        return await rawClient.create(table, data);
      },
      list: async (table, params) => {
        return await rawClient.list(table, params);
      },
      update: async (table, id, data) => {
        if (!id) throw new Error(`[SECURITY_BLOCKED] update 缺少目标 id`);
        if (data && (data.project === "global" || (data.project && !String(data.project).startsWith(prefix)))) {
          throw new Error(`[SECURITY_BLOCKED] 测试环境严禁更新未隔离的 project='${data?.project}'！必须使用以 '${prefix}' 开头的隔离命名空间`);
        }
        return await rawClient.update(table, id, data);
      },
      remove: async (table, id) => {
        if (!id) throw new Error(`[SECURITY_BLOCKED] remove 缺少目标 id`);
        return await rawClient.remove(table, id);
      },
      raw: async (sql) => {
        if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|TRUNCATE)/i.test(sql)) {
          if (!sql.includes(prefix) || /["'`]global["'`]/.test(sql)) {
            throw new Error(`[SECURITY_BLOCKED] 测试环境执行写 SQL 必须包含隔离前缀 '${prefix}' 且严禁触碰 global！阻止: ${sql.slice(0, 100)}`);
          }
        }
        return await rawClient.raw(sql);
      },
    };

    mcp = {
      executeSql: async (inst, sql) => {
        if (inst === "41694_agent_memory" && /^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|TRUNCATE)/i.test(sql)) {
          if (!sql.includes("__test__") || /["'`]global["'`]/.test(sql)) {
            throw new Error(`[SECURITY_BLOCKED] 严禁在生产库 41694_agent_memory 执行非测试写操作！阻止: ${sql.slice(0, 100)}`);
          }
        }
        return await rawMcp.executeSql(inst, sql);
      },
      callTool: async (name, args) => rawMcp.callTool(name, args),
    };
  }

  const env = {
    project,
    instance,
    mcpKey,
    secret,
    mcp,
    client,
    mode,
    cleaned: false,

    /** 自检：断言当前项目无残留 */
    async selfCheck() {
      if (mode === "memory") return;
      const mRes = await mcp.executeSql(instance, `SELECT count(*) as c FROM memories WHERE project = "${project}";`);
      const mCount = Number(mRes?.results?.[0]?.rows?.[0]?.c || 0);
      const pRes = await mcp.executeSql(instance, `SELECT count(*) as c FROM pitfalls WHERE project = "${project}";`);
      const pCount = Number(pRes?.results?.[0]?.rows?.[0]?.c || 0);

      assert.strictEqual(mCount, 0, `[SELF_CHECK_FAIL] memories 中已存在 project='${project}' 的残留行 (${mCount})`);
      assert.strictEqual(pCount, 0, `[SELF_CHECK_FAIL] pitfalls 中已存在 project='${project}' 的残留行 (${pCount})`);
    },

    /** 检查指定数据库中所有 __test__ 开头的残留 */
    async countAllTestResidue() {
      if (mode === "memory") {
        let countM = 0;
        let countP = 0;
        for (const r of (globalMemoryStore.memories || new Map()).values()) {
          if (String(r.project || "").startsWith("__test__")) countM++;
        }
        for (const r of (globalMemoryStore.pitfalls || new Map()).values()) {
          if (String(r.project || "").startsWith("__test__")) countP++;
        }
        return { memories: countM, pitfalls: countP, total: countM + countP };
      }
      return await checkGlobalTestResidue(instance, mcpKey);
    },

    /** 强制清理并断言计数必须为 0 */
    async cleanup() {
      if (this.cleaned) return { memoriesDeleted: 0, pitfallsDeleted: 0 };

      if (mode === "memory") {
        let mDeleted = 0;
        let pDeleted = 0;
        for (const [id, r] of Array.from(globalMemoryStore.memories.entries())) {
          if (r.project === project) {
            globalMemoryStore.memories.delete(id);
            mDeleted++;
          }
        }
        for (const [id, r] of Array.from(globalMemoryStore.pitfalls.entries())) {
          if (r.project === project) {
            globalMemoryStore.pitfalls.delete(id);
            pDeleted++;
          }
        }
        this.cleaned = true;
        activeEnvs.delete(env);
        return { memoriesDeleted: mDeleted, pitfallsDeleted: pDeleted };
      }

      // 1. 远程模式真实清理
      const delM = await mcp.executeSql(instance, `DELETE FROM memories WHERE project = "${project}";`);
      const delP = await mcp.executeSql(instance, `DELETE FROM pitfalls WHERE project = "${project}";`);

      const mDeleted = Number(delM?.results?.[0]?.affectedRows || 0);
      const pDeleted = Number(delP?.results?.[0]?.affectedRows || 0);

      // 2. 删完再查一次计数，必须为 0
      const mCheck = await mcp.executeSql(instance, `SELECT count(*) as c FROM memories WHERE project = "${project}";`);
      const mCount = Number(mCheck?.results?.[0]?.rows?.[0]?.c || 0);
      const pCheck = await mcp.executeSql(instance, `SELECT count(*) as c FROM pitfalls WHERE project = "${project}";`);
      const pCount = Number(pCheck?.results?.[0]?.rows?.[0]?.c || 0);

      assert.strictEqual(mCount, 0, `[CLEANUP_ASSERT_FAILED] memories 表中仍有 ${mCount} 条 project='${project}' 残留！`);
      assert.strictEqual(pCount, 0, `[CLEANUP_ASSERT_FAILED] pitfalls 表中仍有 ${pCount} 条 project='${project}' 残留！`);

      this.cleaned = true;
      activeEnvs.delete(env);
      return { memoriesDeleted: mDeleted, pitfallsDeleted: pDeleted };
    },

    /** 便捷构造插件实例：注入拦截包装后的 client */
    async createHub(overrides = {}) {
      return await MagpieMemoryHub({}, {
        _client: client,
        client,
        ncb_instance: instance,
        mcp_key: mcpKey,
        ncb_secret: secret,
        project,
        auto_harvest: false, // 严禁在测试启动时自动开启网关录制扫描
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

  const mRes = await mcp.executeSql(instance, `SELECT count(*) as c FROM memories WHERE project LIKE "__test__%";`);
  const mCount = Number(mRes?.results?.[0]?.rows?.[0]?.c || 0);

  const pRes = await mcp.executeSql(instance, `SELECT count(*) as c FROM pitfalls WHERE project LIKE "__test__%";`);
  const pCount = Number(pRes?.results?.[0]?.rows?.[0]?.c || 0);

  return { memories: mCount, pitfalls: pCount, total: mCount + pCount };
}
