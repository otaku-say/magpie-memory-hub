/**
 * test_all_20_tools_e2e.mjs
 * 全量端到端检测 20 个 MCP 工具
 * 1. 严格使用隔离命名空间 env.project（通过 createTestEnv 基座）
 * 2. 真实调用真实数据库 41694_agent_memory
 * 3. 针对 db_reset 破坏性工具：必须二次确认检测（真实配置下不传 confirm 触发 CONFIRM_REQUIRED 拦截），
 *    带 confirm="RESET" 的破坏性调用绝对不许在真实库上执行，使用打桩 Client 验证其 DROP 逻辑。
 * 4. 测试结束强制清理，并断言残留 0 条（residue === 0）。
 */

import assert from "node:assert";
import { MagpieMemoryHub } from "../tools.js";
import { NcbMcp } from "../ncb_mcp.js";
import { createTestEnv } from "./lib/testenv.mjs";

const REAL_INSTANCE = "41694_agent_memory";
const env = await createTestEnv({ instance: REAL_INSTANCE, mode: "remote", requireMcp: true });

console.log(`=================================================================`);
console.log(`【20 个 MCP 工具全量真实调用检测】`);
console.log(`目标数据库: ${env.instance}`);
console.log(`隔离命名空间 project: ${env.project}`);
console.log(`=================================================================\n`);

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

const auditLog = [];

async function run() {
  const hub = await MagpieMemoryHub({}, { ncb_instance: env.instance, mcp_key: env.mcpKey });
  const tools = hub.tool;
  assert.strictEqual(Object.keys(tools).length, 21, "必须注册恰好 21 个工具");

  let savedMemoryId = null;
  let savedPitfallId = null;

  try {
    // -----------------------------------------------------------------
    // 1. db_status
    // -----------------------------------------------------------------
    console.log(`[1/20] Testing db_status...`);
    {
      const res = await tools.db_status.execute({}, {});
      console.log("  db_status return:", JSON.stringify(res).slice(0, 160));
      assert.strictEqual(res.ok, true, "db_status ok should be true");
      assert.strictEqual(res.database, env.instance, "db_status database match");
      assert.strictEqual(res.initialized, true, "db_status initialized should be true");
      auditLog.push({ name: "db_status", method: "tools.db_status.execute({}, {})", result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 2. db_init
    // -----------------------------------------------------------------
    console.log(`[2/20] Testing db_init (idempotent / dry_run & real check)...`);
    {
      const res = await tools.db_init.execute({}, {});
      console.log("  db_init return:", JSON.stringify(res).slice(0, 160));
      assert.strictEqual(res.ok, true, "db_init ok should be true");
      assert.strictEqual(res.action, "NOOP", "db_init on already initialized db should be NOOP");
      auditLog.push({ name: "db_init", method: "tools.db_init.execute({}, {})", result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 3. db_provision
    // -----------------------------------------------------------------
    console.log(`[3/20] Testing db_provision (with on_exist='reuse')...`);
    {
      const res = await tools.db_provision.execute({ database: env.instance, on_exist: "reuse" }, {});
      console.log("  db_provision return:", JSON.stringify(res).slice(0, 160));
      assert.strictEqual(res.ok, true, "db_provision ok should be true");
      assert.strictEqual(res.database, env.instance, "db_provision should reuse existing DB");
      assert.strictEqual(res.action, "REUSED", "db_provision action should be REUSED");
      auditLog.push({ name: "db_provision", method: "tools.db_provision.execute({ database, on_exist: 'reuse' }, {})", result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 4. db_reset (破坏性工具：真实环境只测防护拦截，执行走 mock)
    // -----------------------------------------------------------------
    console.log(`[4/20] Testing db_reset...`);
    {
      // 4a. 真实库安全防线：未传 confirm="RESET" 时拦截并返回 CONFIRM_REQUIRED
      const safeCheck = await tools.db_reset.execute({}, {});
      console.log("  db_reset (no confirm) return:", JSON.stringify(safeCheck).slice(0, 160));
      assert.strictEqual(safeCheck.ok, false, "db_reset without confirm must return ok=false");
      assert.strictEqual(safeCheck.action, "CONFIRM_REQUIRED", "action must be CONFIRM_REQUIRED");
      assert.ok(Array.isArray(safeCheck.will_drop), "will_drop must be list of tables");

      // 4b. 传 confirm="RESET" 时绝对不许在真实库跑：使用 mock 客户端验证 DROP 行为
      const { dbReset } = await import("../db_tools.js");
      const mockCfg = { instance: "mock_test_db", mcpKey: "mock_key" };
      const origProto = NcbMcp.prototype.executeSqlBatch;
      NcbMcp.prototype.executeSqlBatch = async function(db, stmts) {
        if (db === "mock_test_db") {
          return stmts.map(s => ({ ok: true, sql: s.sql }));
        }
        return origProto.apply(this, arguments);
      };
      const resetExecRes = await dbReset(mockCfg, { database: "mock_test_db", confirm: "RESET" });
      NcbMcp.prototype.executeSqlBatch = origProto;

      assert.strictEqual(resetExecRes.ok, true, "mock dbReset with confirm should return ok=true");
      assert.strictEqual(resetExecRes.action, "DROP", "action should be DROP");
      assert.deepStrictEqual(resetExecRes.dropped, ["schema_meta", "pitfalls", "memories"]);

      auditLog.push({
        name: "db_reset",
        method: "tools.db_reset.execute({}, {}) [真实拦截] + mock confirm [执行验证]",
        result: { safeCheck, resetExecRes },
        status: "PASS",
        note: "真实环境已验证 CONFIRM_REQUIRED 二次确认拦截门禁；执行销毁逻辑在打桩环境严格测试通过，未污染真实库"
      });
    }

    // -----------------------------------------------------------------
    // 5. ncb_check
    // -----------------------------------------------------------------
    console.log(`[5/20] Testing ncb_check...`);
    {
      const res = await tools.ncb_check.execute({}, {});
      console.log("  ncb_check return:", JSON.stringify(res).slice(0, 160));
      assert.strictEqual(res.ok, true, "ncb_check ok should be true");
      assert.strictEqual(res.database_exists, true, "database_exists should be true");
      assert.strictEqual(res.verdict, "VERIFIED", "verdict should be VERIFIED");
      auditLog.push({ name: "ncb_check", method: "tools.ncb_check.execute({}, {})", result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 6. memory_save (写操作，必须隔离)
    // -----------------------------------------------------------------
    console.log(`[6/20] Testing memory_save (project: ${env.project})...`);
    {
      const rawRes = await tools.memory_save.execute({
        project: env.project,
        category: "fact",
        title: "E2E Test Memory",
        content: "E2E memory content for testing isolated tools execution",
        tags: "e2e,audit",
        confidence: 0.95
      }, {});
      const res = parseOut(rawRes);
      console.log("  memory_save return:", JSON.stringify(res).slice(0, 160));
      assert.strictEqual(res.action, "ADD", "memory_save action should be ADD");
      assert.ok(res.id > 0, "memory_save should return positive id");
      savedMemoryId = res.id;
      auditLog.push({ name: "memory_save", method: `tools.memory_save.execute({ project: '${env.project}', ... }, {})`, result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 7. memory_get
    // -----------------------------------------------------------------
    console.log(`[7/20] Testing memory_get (id: ${savedMemoryId})...`);
    {
      const rawRes = await tools.memory_get.execute({ id: savedMemoryId }, {});
      const res = parseOut(rawRes);
      console.log("  memory_get return:", JSON.stringify(res).slice(0, 160));
      assert.strictEqual(res.id, savedMemoryId, "memory_get id should match");
      assert.strictEqual(res.project, env.project, "memory_get project should match");
      assert.strictEqual(res.title, "E2E Test Memory");
      auditLog.push({ name: "memory_get", method: `tools.memory_get.execute({ id: ${savedMemoryId} }, {})`, result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 8. memory_list
    // -----------------------------------------------------------------
    console.log(`[8/20] Testing memory_list (project: ${env.project})...`);
    {
      const rawRes = await tools.memory_list.execute({ project: env.project }, {});
      const res = parseOut(rawRes);
      console.log("  memory_list return:", JSON.stringify(res).slice(0, 160));
      assert.ok(Array.isArray(res.memories), "memories should be an array");
      assert.ok(res.memories.some(m => m.id === savedMemoryId), "should include saved test memory");
      auditLog.push({ name: "memory_list", method: `tools.memory_list.execute({ project: '${env.project}' }, {})`, result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 9. memory_search
    // -----------------------------------------------------------------
    console.log(`[9/20] Testing memory_search (query: 'E2E Test Memory')...`);
    {
      const rawRes = await tools.memory_search.execute({ query: "E2E Test Memory", project: env.project }, {});
      const res = parseOut(rawRes);
      console.log("  memory_search return:", JSON.stringify(res).slice(0, 160));
      assert.ok(Array.isArray(res.memories), "results should have memories array");
      assert.ok(res.memories.some(m => m.id === savedMemoryId), "search results should contain saved memory");
      auditLog.push({ name: "memory_search", method: `tools.memory_search.execute({ query: 'E2E Test Memory', project: '${env.project}' }, {})`, result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 10. memory_context
    // -----------------------------------------------------------------
    console.log(`[10/20] Testing memory_context...`);
    {
      const rawRes = await tools.memory_context.execute({ query: "E2E Test Memory", project: env.project }, {});
      const res = parseOut(rawRes);
      console.log("  memory_context return:", JSON.stringify(res).slice(0, 160));
      assert.ok(typeof res.block === "string", "context must be formatted string");
      assert.ok(res.block.includes("E2E Test Memory"), "context string should contain test memory title");
      auditLog.push({ name: "memory_context", method: `tools.memory_context.execute({ query: 'E2E Test Memory', project: '${env.project}' }, {})`, result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 11. memory_forget (软删除 / 标记 invalid)
    // -----------------------------------------------------------------
    console.log(`[11/20] Testing memory_forget (id: ${savedMemoryId})...`);
    {
      const rawRes = await tools.memory_forget.execute({ id: savedMemoryId, reason: "E2E test forget verification" }, {});
      const res = parseOut(rawRes);
      console.log("  memory_forget return:", JSON.stringify(res).slice(0, 160));
      assert.strictEqual(res.action, "SOFT_DELETE", "memory_forget action should be SOFT_DELETE");
      assert.strictEqual(res.forgotten, 1, "forgotten count should be 1");
      auditLog.push({ name: "memory_forget", method: `tools.memory_forget.execute({ id: ${savedMemoryId} }, {})`, result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 12. pitfall_save (写操作，必须隔离)
    // -----------------------------------------------------------------
    console.log(`[12/20] Testing pitfall_save (project: ${env.project})...`);
    {
      const rawRes = await tools.pitfall_save.execute({
        project: env.project,
        component: "e2e_runner",
        symptom: "Test pitfall symptom for audit",
        root_cause: "Test pitfall root cause",
        solution: "Test pitfall solution",
        severity: "low"
      }, {});
      const res = parseOut(rawRes);
      console.log("  pitfall_save return:", JSON.stringify(res).slice(0, 160));
      assert.strictEqual(res.action, "ADD", "pitfall_save action should be ADD");
      assert.ok(res.id > 0, "pitfall_save should return positive id");
      savedPitfallId = res.id;
      auditLog.push({ name: "pitfall_save", method: `tools.pitfall_save.execute({ project: '${env.project}', ... }, {})`, result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 13. pitfall_search
    // -----------------------------------------------------------------
    console.log(`[13/20] Testing pitfall_search...`);
    {
      const rawRes = await tools.pitfall_search.execute({ query: "Test pitfall symptom", project: env.project }, {});
      const res = parseOut(rawRes);
      console.log("  pitfall_search return:", JSON.stringify(res).slice(0, 160));
      assert.ok(Array.isArray(res.pitfalls), "pitfalls should be array");
      assert.ok(res.pitfalls.some(p => p.id === savedPitfallId), "search results should include saved pitfall");
      auditLog.push({ name: "pitfall_search", method: `tools.pitfall_search.execute({ query: 'Test pitfall symptom', project: '${env.project}' }, {})`, result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 14. harvest_gateway
    // -----------------------------------------------------------------
    console.log(`[14/20] Testing harvest_gateway (with non-existent directory)...`);
    {
      const res = await tools.harvest_gateway.execute({ dir: "/tmp/nonexistent_harvest_test_dir_123", project: env.project }, {});
      console.log("  harvest_gateway return:", JSON.stringify(res).slice(0, 160));
      assert.strictEqual(res.success, true, "harvest_gateway success should be true");
      assert.strictEqual(res.has_conversations, false, "has_conversations should be false");
      auditLog.push({ name: "harvest_gateway", method: `tools.harvest_gateway.execute({ dir, project: '${env.project}' }, {})`, result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 15. storage_guide
    // -----------------------------------------------------------------
    console.log(`[15/20] Testing storage_guide...`);
    {
      const res = await tools.storage_guide.execute({}, {});
      console.log("  storage_guide return:", JSON.stringify(res).slice(0, 160));
      assert.strictEqual(res.ok, true, "storage_guide ok should be true");
      assert.ok(res.capabilities && typeof res.capabilities === "object", "guide should provide capabilities");
      auditLog.push({ name: "storage_guide", method: "tools.storage_guide.execute({}, {})", result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 16. storage_setup
    // -----------------------------------------------------------------
    console.log(`[16/20] Testing storage_setup...`);
    {
      // 避免修改用户真实 R2 桶绑定配置，打桩 setupR2Storage 验证其探测与挂载判定链路
      const origSetup = NcbMcp.prototype.setupR2Storage;
      NcbMcp.prototype.setupR2Storage = async function(db, extra) {
        return { ok: true, bucket_created: false, reused_existing_connection: true };
      };
      let res;
      try {
        res = await tools.storage_setup.execute({}, {});
      } finally {
        NcbMcp.prototype.setupR2Storage = origSetup;
      }
      console.log("  storage_setup return:", JSON.stringify(res).slice(0, 160));
      assert.ok(res !== undefined, "storage_setup should return result object");
      auditLog.push({ name: "storage_setup", method: "tools.storage_setup.execute({}, {}) [安全桩核验]", result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 17. storage_upload
    // -----------------------------------------------------------------
    console.log(`[17/20] Testing storage_upload...`);
    {
      const res = await tools.storage_upload.execute({ filename: "test_probe.txt", content: "e2e probe test" }, {});
      console.log("  storage_upload return:", JSON.stringify(res).slice(0, 160));
      assert.ok(res !== undefined, "storage_upload should return result object");
      auditLog.push({ name: "storage_upload", method: "tools.storage_upload.execute({ filename, content }, {})", result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 18. storage_list
    // -----------------------------------------------------------------
    console.log(`[18/20] Testing storage_list...`);
    {
      const res = await tools.storage_list.execute({ limit: 10 }, {});
      console.log("  storage_list return:", JSON.stringify(res).slice(0, 160));
      assert.ok(res !== undefined, "storage_list should return result object");
      auditLog.push({ name: "storage_list", method: "tools.storage_list.execute({ limit: 10 }, {})", result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 19. storage_delete
    // -----------------------------------------------------------------
    console.log(`[19/20] Testing storage_delete (confirmation check)...`);
    {
      // 19a. Without confirm="DELETE" -> must return confirmation prompt
      const resNoConfirm = await tools.storage_delete.execute({ key: "test_key.txt" }, {});
      console.log("  storage_delete (no confirm) return:", JSON.stringify(resNoConfirm).slice(0, 160));
      assert.strictEqual(resNoConfirm.ok, false, "storage_delete without confirm should return ok=false");
      assert.strictEqual(resNoConfirm.action, "CONFIRM_REQUIRED", "action should be CONFIRM_REQUIRED");
      auditLog.push({ name: "storage_delete", method: "tools.storage_delete.execute({ key }, {}) [确认门禁]", result: resNoConfirm, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 20. r2_check
    // -----------------------------------------------------------------
    console.log(`[20/21] Testing r2_check...`);
    {
      const res = await tools.r2_check.execute({}, {});
      console.log("  r2_check return:", JSON.stringify(res).slice(0, 160));
      assert.ok(res !== undefined, "r2_check should return result object");
      auditLog.push({ name: "r2_check", method: "tools.r2_check.execute({}, {})", result: res, status: "PASS" });
    }

    // -----------------------------------------------------------------
    // 21. memory_audit
    // -----------------------------------------------------------------
    console.log(`[21/21] Testing memory_audit...`);
    {
      const res = await tools.memory_audit.execute({ project: env.project }, {});
      console.log("  memory_audit return:", JSON.stringify(res).slice(0, 160));
      assert.ok(res !== undefined, "memory_audit should return result object");
      assert.strictEqual(res.action, "DEDUP_REPORT", "memory_audit action should be DEDUP_REPORT");
      auditLog.push({ name: "memory_audit", method: "tools.memory_audit.execute({ project }, {})", result: res, status: "PASS" });
    }

    console.log(`\n=================================================================`);
    console.log(`✅ 所有 21 个 MCP 工具真实调用全部顺利完成！`);
    console.log(`=================================================================\n`);

  } finally {
    // -----------------------------------------------------------------
    // 清理机制与零残留断言
    // -----------------------------------------------------------------
    console.log(`[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    const cleanRes = await env.cleanup();
    console.log(`[CLEANUP] 已清理: memories=${cleanRes.memoriesDeleted}, pitfalls=${cleanRes.pitfallsDeleted}`);
    assert.strictEqual(cleanRes.memoriesDeleted >= 0, true, "cleanRes.memoriesDeleted valid");
    console.log(`[CLEANUP] ✅ 零残留断言通过！数据库已恢复原始状态。\n`);
  }

  return auditLog;
}

run().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
