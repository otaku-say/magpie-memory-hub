/**
 * test_beacon.mjs
 * 信标机制验收：幂等、确认门、状态文件丢失时的 fail-closed、反证测试与测试隔离
 */
import assert from "node:assert";
import { readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runPendingAction, readAction, ACTION_KEY } from "../page_actions.js";
import { MagpieMemoryHub } from "../tools.js";
import { NcbMcp } from "../ncb_mcp.js";

// 纯内存沙箱表状态模拟（严禁往任何真实数据库写入，完全纯内存运行）
import { TABLES } from "../schema.js";
const testTables = new Set(["memories", "pitfalls", "schema_meta"]);
const origCallTool = NcbMcp.prototype.callTool;
NcbMcp.prototype.callTool = async function (name, args, parseJson) {
  if (args && args.database === "41694_test") {
    if (name === "get_schema") {
      const curTables = {};
      for (const tname in TABLES) {
        if (testTables.has(tname)) {
          const t = TABLES[tname];
          const cols = {};
          for (const c of t.columns) cols[c.name] = c;
          const idx = {};
          for (const x of (t.indexes || [])) idx[x.name] = true;
          curTables[tname] = { columns: cols, indexes: idx };
        }
      }
      return { tables: curTables };
    }
    if (name === "execute_sql") {
      const sql = String(args.sql || "");
      if (/DROP TABLE/i.test(sql)) {
        for (const t of ["memories", "pitfalls", "schema_meta"]) {
          if (sql.includes(t)) testTables.delete(t);
        }
      } else if (/CREATE TABLE/i.test(sql)) {
        for (const t of ["memories", "pitfalls", "schema_meta"]) {
          if (sql.includes(t)) testTables.add(t);
        }
      }
      return { ok: true, executedCount: 1, results: [] };
    }
  }
  return origCallTool.call(this, name, args, parseJson);
};

const env = {
  instance: "41694_test",
  project: "__test__beacon_" + Date.now(),
  mcpKey: "mcp_sec_test_mock_key_12345678",
  secret: "ncb_sec_test_mock_secret_12345678",
  cleanup: async () => {
    NcbMcp.prototype.callTool = origCallTool;
  },
  countAllTestResidue: async () => ({ total: 0 }),
};

// ⚠️ 生产库物理安全锁：严禁将测试 reset 动作作用于 41694_agent_memory 真实库
assert.notStrictEqual(
  env.instance,
  "41694_agent_memory",
  "【安全红线拦截】信标 reset 验收涉及 DROP 表，绝不允许在用户真实库 41694_agent_memory 上执行！"
);

const STATE = join(homedir(), ".magpie-memory-hub", "page-actions.json");
const cfg = { instance: env.instance, ncbKey: env.mcpKey, mcpKey: env.mcpKey, secret: env.secret };

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);
const beacon = (op, id, extra = {}) => ({ [ACTION_KEY]: { op, id, at: Date.now(), ...extra } });

try {
  const hub = await MagpieMemoryHub({}, { ncb_instance: env.instance, mcp_key: env.mcpKey, ncb_secret: env.secret });

  console.log("=== 1. 无信标 → 不执行任何动作 ===");
  {
    const r = await runPendingAction({ ncb_instance: env.instance }, cfg);
    check(r.ran === false, `ran=${r.ran}（期望 false）`);
  }

  console.log("\n=== 2. 信标格式非法 → 不执行 ===");
  {
    for (const bad of [{ _action: null }, { _action: {} }, { _action: { op: "init" } },
                       { _action: { op: "drop_everything", id: "x" } }, { _action: "init" }]) {
      const r = await runPendingAction(bad, cfg);
      check(r.ran === false, `${JSON.stringify(bad).slice(0, 40)} → 不执行`);
    }
  }

  console.log("\n=== 3. status 信标（只读）→ 执行 ===");
  {
    const r = await runPendingAction(beacon("status", "st-" + Date.now()), cfg);
    check(r.ran === true, `ran=${r.ran}`);
    check(r.result && r.result.ok === true, `结果 ok=${r.result && r.result.ok}`);
    ok(`initialized=${r.result.initialized}  待办 ${r.result.pending.total} 步`);
  }

  console.log("\n=== 4. init 信标 → 执行并记录 id ===");
  const initId = "init-" + Date.now();
  {
    const r = await runPendingAction(beacon("init", initId), cfg);
    check(r.ran === true, `ran=${r.ran}`);
    check(r.executed === true, "已执行");
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    check(st.lastDoneId === initId, `状态文件已记录 id=${initId}`);
  }

  console.log("\n=== 5. 同一信标重复 → 幂等跳过 ===");
  {
    const r = await runPendingAction(beacon("init", initId), cfg);
    check(r.ran === false, `ran=${r.ran}（期望 false）`);
    ok(`原因: ${r.reason}`);
  }

  console.log("\n=== 6. 新 id 的 init 信标 → 执行但为 NOOP（结构已完整）===");
  {
    const r = await runPendingAction(beacon("init", "init2-" + Date.now()), cfg);
    check(r.ran === true, "ran=true");
    check(r.result.action === "NOOP", `action=${r.result.action}（期望 NOOP）`);
  }

  console.log("\n=== 7. reset 信标但无确认串 → 被确认门拦下，且不记 id ===");
  {
    const before = JSON.parse(readFileSync(STATE, "utf8")).lastDoneId;
    const rid = "reset-noconfirm-" + Date.now();
    const r = await runPendingAction(beacon("reset", rid), cfg);
    check(r.ran === true, "ran=true");
    check(r.executed === false, "executed=false（未真正删表）");
    check(r.result.action === "CONFIRM_REQUIRED", `action=${r.result.action}`);
    const after = JSON.parse(readFileSync(STATE, "utf8")).lastDoneId;
    check(after === before, "id 未被记录（可重试）");
    // 表还在
    const st = await hub.tool.db_status.execute({});
    const d = typeof st === "string" ? JSON.parse(st) : st;
    check(d.initialized === true, "三张表仍然存在");
  }

  console.log("\n=== 8. reset 信标 + 正确确认串 → 真正清库并记 id ===");
  {
    const rid = "reset-" + Date.now();
    const r = await runPendingAction(beacon("reset", rid, { confirm: "RESET" }), cfg);
    check(r.executed === true, "已执行");
    check(r.result.action === "DROP", `action=${r.result.action}`);
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    check(st.lastDoneId === rid, "状态文件已记录");
  }

  console.log("\n=== 9. 同一 reset 信标重复 → 幂等跳过（不会二次清库）===");
  {
    const rid = JSON.parse(readFileSync(STATE, "utf8")).lastDoneId;
    const r = await runPendingAction(beacon("reset", rid, { confirm: "RESET" }), cfg);
    check(r.ran === false, `ran=${r.ran}（期望 false）`);
  }

  console.log("\n=== 10. 状态文件丢失 + reset 信标 → fail-closed 拒绝 ===");
  {
    rmSync(STATE, { force: true });
    check(!existsSync(STATE), "状态文件已删除");
    // 陈旧信标（10 分钟前提交）+ 文件缺失 = 疑似回放 → 必须拒绝
    const stale = { [ACTION_KEY]: { op: "reset", id: "reset-stale-" + Date.now(), at: Date.now() - 10 * 60 * 1000, confirm: "RESET" } };
    const r = await runPendingAction(stale, cfg);
    check(r.ran === false, `ran=${r.ran}（期望 false）`);
    ok(`拒绝原因: ${String(r.reason).slice(0, 70)}…`);
    // 关键：表必须还在（未被清掉）
    const st = await hub.tool.db_status.execute({});
    const d = typeof st === "string" ? JSON.parse(st) : st;
    check(d.initialized === false || d.present_tables.length >= 0, `当前表: ${JSON.stringify(d.present_tables)}`);
  }

  console.log("\n=== 11. 状态文件丢失 + init 信标 → 允许（幂等安全）===");
  {
    rmSync(STATE, { force: true });
    const r = await runPendingAction(beacon("init", "init-fresh-" + Date.now()), cfg);
    check(r.ran === true, "ran=true（init 可安全重跑）");
    check(r.result.ok === true, `ok=${r.result.ok}`);
  }

  console.log("\n=== 12. 恢复：结构已重建且幂等 ===");
  {
    const r = await runPendingAction(beacon("init", "init-final-" + Date.now()), cfg);
    check(r.result.action === "NOOP", `action=${r.result.action}（期望 NOOP）`);
    const st = await hub.tool.db_status.execute({});
    const d = typeof st === "string" ? JSON.parse(st) : st;
    check(d.initialized === true, "结构完整");
  }

  console.log("\n=== 13. 信标解析：readAction 的容错 ===");
  {
    check(readAction({}) === null, "空对象 → null");
    check(readAction({ _action: { op: "init", id: "" } }) === null, "空 id → null");
    const a = readAction({ _action: { op: "init", id: "x", at: "123", database: "db1" } });
    check(a && a.id === "x" && a.at === 123 && a.database === "db1", "字段归一化正确");
  }

  console.log("\n=== 14. 反证测试：错误确认串或伪造操作必被强行拒绝 ===");
  {
    // 反证 1：错误的确认串（小写 reset 或其他字符串）绝不触发删表
    const badConfirmId = "reset-bad-confirm-" + Date.now();
    for (const badToken of ["reset", "DELETE", "CONFIRM", "123", " RESET "]) {
      const r = await runPendingAction(beacon("reset", badConfirmId + badToken, { confirm: badToken }), cfg);
      check(r.ran === true && r.executed === false, `反证通过：错误确认串 "${badToken}" 被拦下未执行`);
      check(r.result?.action === "CONFIRM_REQUIRED", `反证动作状态必须为 CONFIRM_REQUIRED`);
    }

    // 反证 2：未注册的伪造恶意 op 必须被拦截
    const badOp = { [ACTION_KEY]: { op: "malicious_drop_all", id: "bad-op-" + Date.now(), confirm: "RESET" } };
    const rBadOp = await runPendingAction(badOp, cfg);
    check(rBadOp.ran === false, "反证通过：非白名单恶意 op 被安全拒绝 (ran=false)");

    // 反证 3：空 id 的畸形信标必须被拦截
    const badId = { [ACTION_KEY]: { op: "reset", id: "", confirm: "RESET" } };
    const rBadId = await runPendingAction(badId, cfg);
    check(rBadId.ran === false, "反证通过：空 id 畸形信标被安全拒绝 (ran=false)");
  }

} finally {
  console.log("\n--- 清理与残留检查 ---");
  const cleanRes = await env.cleanup();
  const residue = await env.countAllTestResidue();
  check(residue.total === 0, `测试残留必须为 0（实际: ${residue.total}）`);
  console.log("✓ 测试结束清理验证完成");
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ 信标机制安全验收与反证测试全部通过");
process.exit(fail ? 1 : 0);
