/** MCP-only 端到端：只给 MCP key（不给 Secret Key），验证记忆工具的读写。 */
import { MagpieMemoryHub } from "../tools.js";

const DB = "41694_test";
const KEY = process.env.NOCODEBACKEND_API_KEY || "";
let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);
const P = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };

// ⚠️ 故意只给 mcp_key，不给 ncb_secret —— 这正是用户要的最终形态
const hub = await MagpieMemoryHub({}, { ncb_instance: DB, mcp_key: KEY });
const S = hub.tool;

console.log("=== 只填 MCP key（无 Secret Key）时的记忆读写 ===");
console.log(`  工具数: ${Object.keys(S).length}`);

const uniq = "MCP-only 验证 " + Date.now();
const tricky = "含单引号: it's ok; 反斜杠: a\\b; 换行:\n第二行; emoji 🧠";

console.log("\n--- memory_save（内容含引号/反斜杠/换行）---");
const sv = P(await S.memory_save.execute({
  title: uniq, content: tricky, category: "fact", tags: "mcp,probe", scope: "project",
}));
check(sv.action === "ADD" || sv.action === "NOOP", `action=${sv.action}`);
check(!!sv.id, `拿到 id=${sv.id}`);

console.log("\n--- memory_search ---");
const se = P(await S.memory_search.execute({ query: uniq, limit: 5 }));
const hits = Array.isArray(se) ? se : (se.results || se.memories || []);
check(hits.length > 0, `命中 ${hits.length} 条`);

console.log("\n--- 关键：读回的内容必须与写入逐字节一致 ---");
const back = hits.find((h) => String(h.title).includes("MCP-only 验证"));
if (back) {
  const got = String(back.content);
  check(got === tricky, got === tricky
    ? "内容往返逐字节一致（含引号/反斜杠/换行/emoji）"
    : `不一致!\n      写入: ${JSON.stringify(tricky)}\n      读回: ${JSON.stringify(got)}`);
} else {
  no("没找到刚写入的那条");
}

console.log("\n--- pitfall_save / pitfall_search ---");
const ps = P(await S.pitfall_save.execute({
  component: "probe_comp", symptom: "症状含 ' 引号", root_cause: "根因\\反斜杠",
  solution: "解法: 用 uv run python", tags: "probe", severity: "low",
}));
check(ps.action === "ADD" || ps.action === "NOOP", `pitfall action=${ps.action}`);
const pse = P(await S.pitfall_search.execute({ query: "probe_comp", limit: 5 }));
const ph = Array.isArray(pse) ? pse : (pse.results || pse.pitfalls || []);
check(ph.length > 0, `pitfall_search 命中 ${ph.length} 条`);

console.log("\n--- memory_list（分页/limit 路径）---");
const ml = P(await S.memory_list.execute({ limit: 3 }));
const mlRows = Array.isArray(ml) ? ml : (ml.results || ml.memories || []);
check(mlRows.length <= 3, `memory_list 返回 ${mlRows.length} 条（≤3）`);

console.log("\n--- memory_forget（UPDATE 路径）---");
if (sv.id) {
  const fg = P(await S.memory_forget.execute({ id: sv.id }));
  check(fg.action === "FORGET" || fg.ok !== false, `forget: ${JSON.stringify(fg).slice(0, 70)}`);
}

console.log("\n--- db_status（MCP 路径）---");
const st = P(await S.db_status.execute({}));
check(st.ok === true && st.initialized === true, `initialized=${st.initialized}`);

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ MCP-only 全链路通过");
process.exit(fail ? 1 : 0);
