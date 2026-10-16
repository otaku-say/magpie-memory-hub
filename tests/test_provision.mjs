/** db_provision 的重名处理与解析逻辑验收（不新建数据库，避免消耗配额） */
import { parseDatabases, inferAccount, logicalName, dbProvision } from "../db_tools.js";
import { NcbMcp } from "../ncb_mcp.js";

const KEY = process.env.NOCODEBACKEND_API_KEY || "";
let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);

console.log("=== 1. list_databases 文本解析 ===");
{
  const sample = `You have created 5 databases so far. You currently have 20 databases left to create out of your 25 total limit.

Below are the databases:
- 41694_test (Display Name: test) (US Region)
- 41694_agent_memory (Display Name: agent_memory) (US Region)
`;
  const got = parseDatabases(sample);
  check(got.length === 2, `解析出 ${got.length} 个库名`);
  check(got[0] === "41694_test" && got[1] === "41694_agent_memory", got.join(", "));
  check(parseDatabases("").length === 0, "空输入 → 空数组");
  check(parseDatabases("没有列表").length === 0, "无匹配 → 空数组");
}

console.log("\n=== 2. 账号前缀推断与剥离 ===");
{
  check(inferAccount(["41694_test"]) === "41694", "从 41694_test 推出账号 41694");
  check(inferAccount(["foo_bar"]) === "", "非数字前缀 → 空（不瞎猜）");
  check(inferAccount([]) === "", "空数组 → 空");
  check(logicalName("41694_my_memory", "41694") === "my_memory", "剥离账号前缀");
  check(logicalName("my_memory", "41694") === "my_memory", "无前缀时原样返回");
}

console.log("\n=== 3. 用真实 MCP 取现有库清单 ===");
const mcp = new NcbMcp({ apiKey: KEY });
const listText = await mcp.listDatabasesText();
const existing = parseDatabases(listText);
const account = inferAccount(existing);
ok(`账号前缀 = ${account}，现有 ${existing.length} 个库`);
ok(`库名: ${existing.join(", ")}`);

const cfg = { instance: "41694_test", mcpKey: KEY };
const target = existing.find((x) => logicalName(x, account) === "test") || "41694_test";
ok(`测试目标库: ${target}`);

console.log("\n=== 4. on_exist=fail：重名必须被拦下，且不得建库 ===");
{
  const before = parseDatabases(await mcp.listDatabasesText()).length;
  const r = await dbProvision(cfg, { database: "test", on_exist: "fail", with_r2: false });
  check(r.ok === false, `ok=${r.ok}（期望 false）`);
  check(r.action === "NAME_TAKEN", `action=${r.action}`);
  ok(`建议: ${String(r.suggestion).slice(0, 50)}…`);
  const after = parseDatabases(await mcp.listDatabasesText()).length;
  check(after === before, `库数量未变（${before} → ${after}），没有偷偷建新库`);
}

console.log("\n=== 5. on_exist=reuse（默认）：复用已有库，不新建 ===");
{
  const before = parseDatabases(await mcp.listDatabasesText()).length;
  const r = await dbProvision(cfg, { database: "test", on_exist: "reuse", with_r2: false });
  check(r.ok === true, `ok=${r.ok}`);
  check(r.action === "REUSED", `action=${r.action}（期望 REUSED）`);
  check(r.created_new_database === false, "没有新建库");
  check(r.existed_before === true, "识别出「已存在」");
  check(r.database === target, `实际使用 ${r.database}`);
  check(Array.isArray(r.notes) && r.notes.length > 0, `给出提示: ${String(r.notes[0]).slice(0, 56)}…`);
  check(r.schema && r.schema.action === "NOOP", `结构已完整（schema.action=${r.schema && r.schema.action}）`);
  const after = parseDatabases(await mcp.listDatabasesText()).length;
  check(after === before, `库数量未变（${before} → ${after}）`);
}

console.log("\n=== 6. 用逻辑名（不带账号前缀）也能正确匹配 ===");
{
  const r = await dbProvision(cfg, { database: "test", on_exist: "reuse", with_r2: false });
  check(r.existed_before === true && r.created_new_database === false,
    "填逻辑名 test → 正确匹配到 41694_test，未新建");
}

console.log("\n=== 7. 没有 MCP key 时给可读错误，而不是崩 ===");
{
  let msg = "";
  try { await dbProvision({ instance: "x", mcpKey: "" }, { database: "x" }); }
  catch (e) { msg = String(e && e.message || e); }
  check(/MCP key/.test(msg), `错误可读: ${msg.slice(0, 46)}…`);
}

console.log("\n=== 8. 未指定库名时给可读错误 ===");
{
  let msg = "";
  try { await dbProvision({ instance: "", mcpKey: KEY }, {}); }
  catch (e) { msg = String(e && e.message || e); }
  check(/数据库名/.test(msg), `错误可读: ${msg.slice(0, 40)}…`);
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ 重名处理与解析逻辑全部通过");
process.exit(fail ? 1 : 0);
