/**
 * SQL 转义的对抗性验证 —— MCP-only 方案的安全底线。
 *
 * 判据只有一条：把恶意/怪异文本写进库，再读回来，**逐字节相等**。
 * 只检查「没报错」是不够的——转义错了可能静默写坏数据。
 */
import { makeMcpClient, sqlValue, buildSelect, buildInsert, buildUpdate, buildDelete, safeIdent } from "../mcp_client.js";

const DB = process.env.NCB_TEST_DB || "41694_agent_memory";   // 41694_test 的 fingerprint 列曾是 CHAR(32)，而 db_init 只增不改、修不了它
const KEY = process.env.NOCODEBACKEND_API_KEY || "";
let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);

console.log("=== 1. 标识符白名单：注入标识符必须被拒 ===");
{
  const bad = [
    ["memories; DROP TABLE memories", "table"],
    ["`memories`", "table"],
    ["memories`", "table"],
    ["information_schema.tables", "table"],
    ["", "table"],
  ];
  let blocked = 0;
  for (const [n, kind] of bad) {
    try { safeIdent(n, kind); } catch (e) { blocked++; }
  }
  check(blocked === bad.length, `${blocked}/${bad.length} 个非法表名被拒`);

  const badCols = ["id`=1 OR 1=1 --", "id); DROP TABLE memories;--", "unknown_col", ""];
  let cb = 0;
  for (const c of badCols) {
    try { safeIdent(c, "column", "memories"); } catch (e) { cb++; }
  }
  check(cb === badCols.length, `${cb}/${badCols.length} 个非法列名被拒`);
  ok(`合法名可用: ${safeIdent("memories", "table")} ${safeIdent("fingerprint", "column", "memories")}`);
}

console.log("\n=== 2. 值转义：这些写法都不能逃出字符串字面量 ===");
{
  const cases = [
    ["单引号", "it's a test"],
    ["反斜杠+引号（最危险）", "back\\'slash"],
    ["连续反斜杠", "a\\\\b"],
    ["经典注入", "' OR 1=1 -- "],
    ["分号注入", "'; DROP TABLE memories; --"],
    ["注释注入", "/* x */ --"],
    ["换行", "line1\nline2"],
    ["回车+换行", "a\r\nb"],
    ["制表", "a\tb"],
    ["双引号", 'he said "hi"'],
    ["反引号", "`tick`"],
    ["百分号与下划线", "%_%"],
    ["中文与 emoji", "记忆🧠✅测试"],
    ["NUL 字节", "a\u0000b"],
    ["SUB 字符", "a\u001ab"],
    ["超长", "x".repeat(3000) + "'"],
    ["纯引号", "'''"],
    ["JSON 片段", '{"a":"b\'c"}'],
    ["SQL 关键字", "SELECT * FROM users WHERE 1=1"],
  ];
  let bad = 0;
  for (const [label, v] of cases) {
    const lit = sqlValue(v);
    // 必须被单引号包裹
    const wrapped = lit.startsWith("'") && lit.endsWith("'");
    // 把包裹引号去掉后，内部不应有【未转义】的单引号
    const inner = wrapped ? lit.slice(1, -1) : lit;
    let unescaped = 0;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "'") {
        // 数前面连续反斜杠的个数，偶数个意味着这个引号是"裸"的
        let bs = 0;
        for (let j = i - 1; j >= 0 && inner[j] === "\\"; j--) bs++;
        if (bs % 2 === 0) unescaped++;
      }
    }
    if (!wrapped || unescaped > 0) {
      bad++;
      console.log(`  ✗ ${label}: 包裹=${wrapped} 裸引号=${unescaped}  → ${lit.slice(0, 80)}`);
    }
  }
  check(bad === 0, `${cases.length} 种危险值全部被正确包裹/转义`);
}

console.log("\n=== 3. 真实往返：写进库再读回来，逐字节相等 ===");
const mcp = makeMcpClient({ instance: DB, mcpKey: KEY });
const stamp = Date.now();
const roundTrips = [
  "it's a test",
  "back\\'slash",
  "a\\\\b",
  "' OR 1=1 -- ",
  "'; DROP TABLE memories; --",
  "line1\nline2\nline3",
  'he said "hi" and it\'s fine',
  "记忆🧠 中文测试 ✅",
  "mixed \\\\ '' \"\" `tick` %_%",
  "json: {\"k\":\"v's\"}",
];
let rtFail = 0;
for (const v of roundTrips) {
  const fp = "fp_esc_" + stamp + "_" + Math.abs(hash(v));
  try {
    await mcp.create("memories", {
      project: "esc_probe", fingerprint: fp, title: "转义往返测试",
      content: v, status: "active", scope: "project", category: "fact", confidence_score: 100,
    });
    const res = await mcp.list("memories", { project: "esc_probe", fingerprint: fp, limit: 1 });
    const row = (res.data || [])[0];
    if (!row) { rtFail++; no(`读回为空: ${JSON.stringify(v).slice(0, 40)}`); continue; }
    const got = String(row.content);
    if (got === v) {
      ok(`往返一致: ${JSON.stringify(v).length > 34 ? JSON.stringify(v).slice(0, 34) + "…" : JSON.stringify(v)}`);
    } else {
      rtFail++;
      no(`往返不一致!\n      写入: ${JSON.stringify(v)}\n      读回: ${JSON.stringify(got)}`);
    }
    // 清理
    if (row.id) await mcp.remove("memories", row.id);
  } catch (e) {
    rtFail++;
    no(`异常 ${JSON.stringify(v).slice(0, 30)}: ${String(e && e.message || e).slice(0, 120)}`);
  }
}
check(rtFail === 0, `${roundTrips.length} 种值往返逐字节一致`);

console.log("\n=== 4. UPDATE / DELETE 的 id 必须是数字 ===");
{
  let blocked = 0;
  for (const bad of ["1 OR 1=1", "1; DROP TABLE memories", "'1'", "abc", ""]) {
    try { buildUpdate("memories", bad, { title: "x" }); } catch (e) { blocked++; }
  }
  check(blocked === 5, `5 个非法 id 全被拒`);
  let db = 0;
  for (const bad of ["1 OR 1=1", "x"]) {
    try { buildDelete("memories", bad); } catch (e) { db++; }
  }
  check(db === 2, "DELETE 的非法 id 被拒");
}

console.log("\n=== 5. 生成的 SQL 形状（人工可读核对）===");
{
  const s1 = buildSelect("memories", { project: "p", limit: 5 });
  ok(`SELECT: ${s1}`);
  const s2 = buildInsert("memories", { project: "p", title: "it's" });
  ok(`INSERT: ${s2}`);
  const s3 = buildUpdate("memories", 7, { title: "a'b" });
  ok(`UPDATE: ${s3}`);
  const s4 = buildDelete("memories", 7);
  ok(`DELETE: ${s4}`);
  check(!/;\s*(DROP|DELETE|UPDATE|INSERT)/i.test(s1 + s2 + s3 + s4), "生成的语句里没有夹带额外语句");
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ SQL 转义与注入防线全部通过");
process.exit(fail ? 1 : 0);
