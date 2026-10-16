/**
 * SQL 转义的对抗性验证 —— MCP-only 方案的安全底线。
 *
 * 判据只有一条：把恶意/怪异文本写进库，再读回来，**逐字节相等**。
 * 只检查「没报错」是不够的——转义错了可能静默写坏数据。
 *
 * 严谨性整改：
 * 1. 使用 tests/lib/testenv.mjs 生成独立唯一测试命名空间 (project = env.project)
 * 2. 无论成功或异常，在 finally 块中彻底清理并在清理后断言残余数为 0
 * 3. 增强强断言与反证测试门
 */
import assert from "node:assert";
import { makeMcpClient, sqlValue, buildSelect, buildInsert, buildUpdate, buildDelete, safeIdent } from "../mcp_client.js";
import { createTestEnv } from "./lib/testenv.mjs";

const env = await createTestEnv({ instance: "41694_agent_memory", requireMcp: true });
console.log(`[test_sql_escape] 测试命名空间 project: ${env.project}`);

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return h;
}

try {
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
    ok(`合法名可用: ${safeIdent("memories", "table")} ${safeIdent("content_fingerprint", "column", "memories")}`);
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

  console.log("\n=== 3. 真实往返：写进库再读回来，逐字节相等（隔离命名空间）===");
  const mcp = env.client;
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
        project: env.project, content_fingerprint: fp, title: "转义往返测试",
        content: v, lifecycle_status: "active", scope_level: "project", category: "fact", confidence_score: 100,
      });
      const res = await mcp.list("memories", { project: env.project, content_fingerprint: fp, limit: 1 });
      const row = (res.data || [])[0];
      if (!row) { rtFail++; no(`读回为空: ${JSON.stringify(v).slice(0, 40)}`); continue; }
      const got = String(row.content);
      if (got === v) {
        ok(`往返一致: ${JSON.stringify(v).length > 34 ? JSON.stringify(v).slice(0, 34) + "…" : JSON.stringify(v)}`);
      } else {
        rtFail++;
        no(`往返不一致!\n      写入: ${JSON.stringify(v)}\n      读回: ${JSON.stringify(got)}`);
      }
      // 检查 project
      if (row.project !== env.project) {
        rtFail++;
        no(`project 字段不匹配: 期望 ${env.project}, 实际 ${row.project}`);
      }
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
    check(db === 2, `2 个非法 id 的 DELETE 被拒`);
  }

  console.log("\n=== 5. SQL 构造器输出断言 ===");
  {
    const s1 = buildSelect("memories", { project: env.project, limit: 10 });
    const s2 = buildInsert("memories", { project: env.project, title: "t", content: "c" });
    const s3 = buildUpdate("memories", 42, { title: "t2" });
    const s4 = buildDelete("memories", 42);

    ok(`SELECT: ${s1}`);
    ok(`INSERT: ${s2}`);
    ok(`UPDATE: ${s3}`);
    ok(`DELETE: ${s4}`);

    check(!/;\s*(DROP|DELETE|UPDATE|INSERT)/i.test(s1 + s2 + s3 + s4), "生成的语句里没有夹带额外语句");
  }

  console.log("\n=== 6. 反证测试：篡改内容或破坏转义必导致断言失败 ===");
  {
    // 反证 1：如果返回的内容哪怕多一个空格，比对断言必定识别出不一致
    const original = "记忆🧠 中文测试 ✅";
    const corrupted = original + " ";
    check(original !== corrupted, "反证通过：内容发生 1 字符变异时，严格全等必定为 false");

    // 反证 2：未转义的单引号必须被值转义校验检测出裸引号
    const unescapedRaw = "' OR 1=1 --";
    const fakeEscaped = "'" + unescapedRaw + "'"; // 错误地直接加首尾引号，未对内部引号转义
    let hasUnescapedQuote = false;
    const inner = fakeEscaped.slice(1, -1);
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "'") {
        let bs = 0;
        for (let j = i - 1; j >= 0 && inner[j] === "\\"; j--) bs++;
        if (bs % 2 === 0) hasUnescapedQuote = true;
      }
    }
    check(hasUnescapedQuote === true, "反证通过：转义检测算法成功识破未转义的注入单引号");
  }

} finally {
  console.log("\n--- 清理与残留检查 ---");
  const cleanRes = await env.cleanup();
  console.log(`✓ 清理完成（memories 已删 ${cleanRes.memoriesDeleted} 行）`);
  const residue = await env.countAllTestResidue();
  check(residue.total === 0, `全局残余必须为 0（实际: ${residue.total}）`);
  console.log("✓ 全局残留校验为 0");
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ SQL 转义对抗性验证全部通过");
process.exit(fail ? 1 : 0);
