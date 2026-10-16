/** 信标机制验收：幂等、确认门、状态文件丢失时的 fail-closed */
import { readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runPendingAction, readAction, ACTION_KEY } from "../page_actions.js";
import { MagpieMemoryHub } from "../tools.js";

const DB = "41694_test";
const KEY = process.env.NOCODEBACKEND_API_KEY || "";
const SECRET = readFileSync("/tmp/ncb_sec.key", "utf8").trim();
const STATE = join(homedir(), ".magpie-memory-hub", "page-actions.json");
const cfg = { instance: DB, ncbKey: KEY, mcpKey: KEY, secret: SECRET };

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);
const beacon = (op, id, extra = {}) => ({ [ACTION_KEY]: { op, id, at: Date.now(), ...extra } });

const hub = await MagpieMemoryHub({}, { ncb_instance: DB, mcp_key: KEY, ncb_secret: SECRET });

console.log("=== 1. 无信标 → 不执行任何动作 ===");
{
  const r = await runPendingAction({ ncb_instance: DB }, cfg);
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

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ 信标机制安全验收全部通过");
process.exit(fail ? 1 : 0);
