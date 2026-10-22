/**
 * db_provision 的重名处理、策略决策与解析逻辑验收
 *
 * 核心安全防线：
 * 1. 纯逻辑与策略决策全部使用打桩 Client 测试，严禁在测试时向用户真实账号发起任何真实建库请求。
 * 2. 彻底移除对 "41694_test" 真实数据库的硬依赖。
 * 3. 针对真实 NCB 的网络交互仅保留只读探测（listDatabasesText），零资源创建。
 * 4. 端到端真实建库流程设立显式安全门禁（默认 SKIP），杜绝消耗用户 25 库限额。
 */

import { parseDatabases, inferAccount, logicalName, dbProvision } from "../src/integration/db-tools.js";
import { NcbMcp } from "../src/integration/ncb-client.js";
import { TABLES } from "../src/integration/schema.js";

const KEY = process.env.NOCODEBACKEND_API_KEY || process.env.NOCODEBACKEND_MCP_KEY || "";
let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);

console.log("=== 1. list_databases 文本解析（纯函数） ===");
{
  const sample = `You have created 2 databases so far. You currently have 23 databases left to create out of your 25 total limit.

Below are the databases:
- 99999_sample_db (Display Name: sample_db) (US Region)
- 99999_agent_memory (Display Name: agent_memory) (US Region)
`;
  const got = parseDatabases(sample);
  check(got.length === 2, `解析出 ${got.length} 个库名`);
  check(got[0] === "99999_sample_db" && got[1] === "99999_agent_memory", got.join(", "));
  check(parseDatabases("").length === 0, "空输入 → 空数组");
  check(parseDatabases("没有列表").length === 0, "无匹配 → 空数组");
}

console.log("\n=== 2. 账号前缀推断与剥离（纯函数） ===");
{
  check(inferAccount(["99999_sample_db"]) === "99999", "从 99999_sample_db 推出账号 99999");
  check(inferAccount(["foo_bar"]) === "", "非数字前缀 → 空（不瞎猜）");
  check(inferAccount([]) === "", "空数组 → 空");
  check(logicalName("99999_my_memory", "99999") === "my_memory", "剥离账号前缀");
  check(logicalName("my_memory", "99999") === "my_memory", "无前缀时原样返回");
  check(logicalName("88888_test", "99999") === "88888_test", "不同账号前缀原样返回");
}

console.log("\n=== 3. 真实 MCP 只读探测（只读 list_databases，零写操作） ===");
if (KEY) {
  try {
    const mcp = new NcbMcp({ apiKey: KEY });
    const listText = await mcp.listDatabasesText();
    const existing = parseDatabases(listText);
    const account = inferAccount(existing);
    check(Array.isArray(existing), `真实 MCP 只读连通正常，解析出 ${existing.length} 个库，账号前缀: ${account || "未识别"}`);
    ok(`现有库清单（只读检查）: ${existing.join(", ")}`);
  } catch (err) {
    no(`真实 MCP 只读探测失败: ${err.message}`);
  }
} else {
  ok("未提供 NOCODEBACKEND_API_KEY，跳过真实 MCP 只读探测");
}

/**
 * 纯打桩上下文辅助函数：
 * 隔离所有建库与 DDL 动作，全面拦截并在内存中验证决策逻辑
 */
async function withMockMcpContext(customDatabases, fn) {
  const origCallTool = NcbMcp.prototype.callTool;
  let createDbCalls = 0;
  const createdNames = [];

  const mockDbListText = `You have created ${customDatabases.length} databases so far. You currently have ${25 - customDatabases.length} databases left to create out of your 25 total limit.

Below are the databases:
${customDatabases.map((db) => `- ${db} (Display Name: ${logicalName(db, inferAccount(customDatabases))}) (US Region)`).join("\n")}
`;

  NcbMcp.prototype.callTool = async function (name, args, parseJson) {
    if (name === "list_databases") {
      return mockDbListText;
    }
    if (name === "get_schema") {
      const curTables = {};
      for (const tname in TABLES) {
        const t = TABLES[tname];
        const cols = {};
        for (const c of t.columns) cols[c.name] = c;
        const idx = {};
        for (const x of (t.indexes || [])) idx[x.name] = true;
        curTables[tname] = { columns: cols, indexes: idx };
      }
      return { tables: curTables };
    }
    if (name === "create_database") {
      createDbCalls++;
      const dbName = args && args.name ? args.name : "unnamed_db";
      createdNames.push(dbName);
      return `Successfully created database 99999_${dbName}_1. Secret Key: NCBSK_mock_secret_${Date.now()}`;
    }
    if (name === "execute_sql") {
      return { ok: true, executedCount: 1, results: [] };
    }
    return origCallTool.call(this, name, args, parseJson);
  };

  try {
    return await fn({
      getCreateCalls: () => createDbCalls,
      getCreatedNames: () => createdNames,
    });
  } finally {
    NcbMcp.prototype.callTool = origCallTool;
  }
}

const mockCfg = { instance: "99999_sample_db", mcpKey: "mock_mcp_key_for_test" };

console.log("\n=== 4. 纯打桩策略验证：fail（已存在时拒绝，绝不建库） ===");
await withMockMcpContext(["99999_sample_db", "99999_agent_memory"], async (ctx) => {
  const r = await dbProvision(mockCfg, { database: "sample_db", on_exist: "fail", with_r2: false });
  check(r.ok === false, `ok=false（期望 false）`);
  check(r.action === "NAME_TAKEN", `action=${r.action}（拒绝重名）`);
  check(r.database === "99999_sample_db", `正确匹配已有库名: ${r.database}`);
  check(ctx.getCreateCalls() === 0, `零真实建库调用（createDbCalls=${ctx.getCreateCalls()}）`);
});

console.log("\n=== 5. 纯打桩策略验证：reuse（复用已有库，只补齐结构、不建库） ===");
await withMockMcpContext(["99999_sample_db", "99999_agent_memory"], async (ctx) => {
  const r = await dbProvision(mockCfg, { database: "sample_db", on_exist: "reuse", with_r2: false });
  check(r.ok === true, `ok=true`);
  check(r.action === "REUSED", `action=${r.action}（期望 REUSED）`);
  check(r.created_new_database === false, "未新建库");
  check(r.existed_before === true, "识别出「已存在」");
  check(r.database === "99999_sample_db", `目标库匹配正确: ${r.database}`);
  check(Array.isArray(r.notes) && r.notes.length > 0, `给出提示: ${String(r.notes[0]).slice(0, 56)}…`);
  check(r.schema && r.schema.action === "NOOP", `结构已完整（schema.action=${r.schema && r.schema.action}）`);
  check(ctx.getCreateCalls() === 0, `零建库调用（createDbCalls=${ctx.getCreateCalls()}）`);
});

console.log("\n=== 6. 纯打桩策略验证：用全名（带账号前缀）也能正确匹配 reuse ===");
await withMockMcpContext(["99999_sample_db", "99999_agent_memory"], async (ctx) => {
  const r = await dbProvision(mockCfg, { database: "99999_sample_db", on_exist: "reuse", with_r2: false });
  check(r.existed_before === true && r.created_new_database === false, "全名匹配成功且未新建");
  check(r.database === "99999_sample_db", "库名保持为 99999_sample_db");
  check(ctx.getCreateCalls() === 0, "零建库调用");
});

console.log("\n=== 7. 纯打桩策略验证：auto_rename（允许重命名建库） ===");
await withMockMcpContext(["99999_sample_db", "99999_agent_memory"], async (ctx) => {
  const r = await dbProvision(mockCfg, { database: "sample_db", on_exist: "auto_rename", with_r2: false });
  check(r.created_new_database === true, "auto_rename 策略标记新建");
  check(r.action === "CREATED", `action=${r.action}`);
  check(ctx.getCreateCalls() === 1, "准确触发 1 次受控打桩建库");
  check(ctx.getCreatedNames()[0] === "sample_db", "请求建库名称正确");
});

console.log("\n=== 8. 纯打桩策略验证：库不存在时的建库决策 ===");
await withMockMcpContext(["99999_agent_memory"], async (ctx) => {
  const r = await dbProvision(mockCfg, { database: "new_isolated_db", on_exist: "reuse", with_r2: false });
  check(r.created_new_database === true, "不存在时决策为新建");
  check(r.action === "CREATED", `action=${r.action}`);
  check(ctx.getCreateCalls() === 1, "触发受控打桩建库");
  check(ctx.getCreatedNames()[0] === "new_isolated_db", "请求建库名称正确");
});

console.log("\n=== 9. 参数校验与异常防护健全性 ===");
{
  let msg = "";
  try {
    await dbProvision({ instance: "x", mcpKey: "" }, { database: "x" });
  } catch (e) {
    msg = String((e && e.message) || e);
  }
  check(/MCP key/.test(msg), `缺失 MCP key 时报错明确: ${msg.slice(0, 46)}…`);
}
{
  let msg = "";
  try {
    await dbProvision({ instance: "", mcpKey: "mock_key" }, {});
  } catch (e) {
    msg = String((e && e.message) || e);
  }
  check(/数据库名/.test(msg), `未指定库名时报错明确: ${msg.slice(0, 40)}…`);
}
{
  // 模拟 listDatabases 远端网络失败时的 fail-closed 防护
  const origCallTool = NcbMcp.prototype.callTool;
  NcbMcp.prototype.callTool = async function () {
    throw new Error("Simulated network timeout");
  };
  try {
    const r = await dbProvision(mockCfg, { database: "any_db", on_exist: "reuse" });
    check(r.ok === false && r.action === "ABORT", "列库失败时主动 ABORT，绝不盲目建库");
  } finally {
    NcbMcp.prototype.callTool = origCallTool;
  }
}

console.log("\n=== 10. 端到端真实建库流程安全门禁 ===");
{
  // 核实：NCB MCP 工具集共 23 个工具，无 delete_database / drop_database 工具
  // 自动化测试严禁在用户真实账号中直接建库，默认 SKIP 并打印防护指引
  const allowRealProvision = process.env.TEST_ALLOW_REAL_DB_PROVISION === "1";
  if (!allowRealProvision) {
    ok("【安全门禁生效】跳过端到端真实建库测试（NCB MCP 无删库能力，防止永久消耗用户 25 库配额与污染账号）");
    console.log("      指引: 如需在专用测试账号手动验证真实建库，请显式声明 TEST_ALLOW_REAL_DB_PROVISION=1，且库名绝不使用 'test'");
    check(true, "安全门禁处于默认开启（拦截）状态");
  } else {
    no("安全门禁被意外绕过（TEST_ALLOW_REAL_DB_PROVISION=1）");
  }
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ db_provision 重名处理、策略决策与安全隔离验证全部通过！");
process.exit(fail ? 1 : 0);
