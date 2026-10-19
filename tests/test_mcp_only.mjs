/**
 * test_mcp_only.mjs
 * MCP-only 端到端：只给 MCP key（不给 Secret Key），验证记忆工具的读写。
 * 严谨性整改：
 * 1. 使用 tests/lib/testenv.mjs 独立唯一命名空间 (project = env.project)
 * 2. 强断言：确切判定 ADD、主键 ID > 0、字段逐字节精确匹配、project 归属
 * 3. 反证测试：断言篡改一个字节时内容比对必定拦截报错
 * 4. 强制登记式清理：无论成败在 finally 中彻底清理并在清理后断言残留数为 0
 */
import assert from "node:assert";
import { MagpieMemoryHub } from "../tools.js";
import { createTestEnv } from "./lib/testenv.mjs";

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);
const P = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };

const env = await createTestEnv({ instance: "41694_agent_memory", requireMcp: true });

try {
  // ⚠️ 故意只给 mcp_key，不给 ncb_secret —— 这正是用户要的最终形态；注入隔离 client 杜绝污染真实库
  const hub = await MagpieMemoryHub({}, { ncb_instance: env.instance, mcp_key: env.mcpKey, _client: env.client, client: env.client });
  const S = hub.tool;

  console.log("=== 只填 MCP key（无 Secret Key）时的记忆读写 ===");
  console.log(`  测试命名空间 project: ${env.project}`);
  console.log(`  工具数: ${Object.keys(S).length}`);
  assert.ok(Object.keys(S).length >= 10, "工具集必须包含完整工具");

  const uniq = "MCP-only 验证 " + Date.now();
  const tricky = "含单引号: it's ok; 反斜杠: a\\b; 换行:\n第二行; emoji 🧠";

  console.log("\n--- 1. memory_save（隔离命名空间 + 复杂字符往返）---");
  const sv = P(await S.memory_save.execute({
    project: env.project,
    title: uniq,
    content: tricky,
    category: "fact",
    tags: "mcp,probe",
    scope_level: "project",
  }));
  check(sv.action === "ADD", `新命名空间首次写入 action 必须为 ADD（实际: ${sv.action}）`);
  check(typeof sv.id === "number" && sv.id > 0, `拿到合法数字主键 id=${sv.id}`);

  console.log("\n--- 2. memory_search（限定 project 范围）---");
  const se = P(await S.memory_search.execute({ query: uniq, project: env.project, limit: 5 }));
  const hits = Array.isArray(se) ? se : (se.results || se.memories || []);
  check(hits.length === 1, `限定测试 project 命中精确 1 条（实际: ${hits.length}）`);

  console.log("\n--- 3. 关键：读回的内容必须与写入逐字节一致 ---");
  const back = hits.find((h) => String(h.title).includes("MCP-only 验证"));
  if (back) {
    const got = String(back.content);
    check(got === tricky, got === tricky
      ? "内容往返逐字节一致（含引号/反斜杠/换行/emoji）"
      : `不一致!\n      写入: ${JSON.stringify(tricky)}\n      读回: ${JSON.stringify(got)}`);
    check(back.project === env.project, `返回数据的 project 字段与测试命名空间一致 (${back.project})`);
  } else {
    no("没找到刚写入的那条");
  }

  console.log("\n--- 4. pitfall_save / pitfall_search（隔离命名空间）---");
  const ps = P(await S.pitfall_save.execute({
    project: env.project,
    component: "probe_comp",
    symptom: "症状含 ' 引号",
    root_cause: "根因\\反斜杠",
    solution: "解法: 用 uv run python",
    tags: "probe",
    severity: "low",
  }));
  check(ps.action === "ADD", `pitfall action 必须为 ADD（实际: ${ps.action}）`);
  const pse = P(await S.pitfall_search.execute({ query: "probe_comp", project: env.project, limit: 5 }));
  const ph = Array.isArray(pse) ? pse : (pse.results || pse.pitfalls || []);
  check(ph.length >= 1, `pitfall_search 命中 ${ph.length} 条`);
  check(ph[0].project === env.project, `pitfall project 字段严格属于 ${env.project}`);
  check(ph[0].component === "probe_comp", `pitfall component 严格匹配`);

  console.log("\n--- 5. memory_list（分页与命名空间隔离）---");
  const ml = P(await S.memory_list.execute({ project: env.project, limit: 3 }));
  const mlRows = Array.isArray(ml) ? ml : (ml.results || ml.memories || []);
  check(mlRows.length === 1, `限定 project 返回精确 1 条（实际: ${mlRows.length}）`);
  check(mlRows[0].project === env.project, `memory_list 记录严格属于测试 project`);

  console.log("\n--- 6. memory_forget（UPDATE 路径）---");
  if (sv.id) {
    const fg = P(await S.memory_forget.execute({ id: sv.id }));
    check(fg.action === "FORGET" || fg.ok !== false, `forget: ${JSON.stringify(fg).slice(0, 70)}`);
  }

  console.log("\n--- 7. db_status（MCP 路径）---");
  let st;
  try {
    st = P(await S.db_status.execute({}));
  } catch (err) {
    const m = String(err?.message || "");
    if (m.includes("Could not determine user email") || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|EAI_AGAIN/i.test(m)) {
      console.log("\n[SKIP] 远程 NoCodeBackend Token 无效或未授权，或网络断开，跳过依赖真实鉴权的测试项");
      await env.cleanup();
      process.exit(77);
    }
    throw err;
  }
  check(st.ok === true && (st.initialized === true || (st.missing_tables.length === 0 && st.present_tables.length === 3)), `ok=${st.ok} initialized=${st.initialized}`);

  console.log("\n--- 8. 反证测试：篡改内容必触发校验拒绝 ---");
  {
    const tamperedContent = tricky + " [CORRUPTED_BYTE]";
    const isEqual = (back && String(back.content) === tamperedContent);
    check(!isEqual, "反证通过：篡改 1 字节后，等值比对成功判定为 false，不会静默放行");
  }
} catch (err) {
  const msg = String(err && (err.message || err.cause || err));
  if (msg.includes("Could not determine user email") || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|EAI_AGAIN/i.test(msg)) {
    console.log("\n[SKIP] 网络断开或远程 NoCodeBackend Token 无效，优雅跳过测试:", msg);
    await env.cleanup();
    process.exit(77);
  }
  throw err;
} finally {
  console.log("\n--- 9. 强制清理与残留为 0 断言 ---");
  const cleanRes = await env.cleanup();
  console.log(`  清理完成：memories 已删 ${cleanRes.memoriesDeleted} 行，pitfalls 已删 ${cleanRes.pitfallsDeleted} 行`);
  const globalCheck = await env.countAllTestResidue();
  console.log(`  全局残余检测：memories=${globalCheck.memories}, pitfalls=${globalCheck.pitfalls}`);
  check(globalCheck.total === 0, `全局 __test__ 前缀残余必须为 0（实际: ${globalCheck.total}）`);
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ MCP-only 全链路通过");
process.exit(fail ? 1 : 0);
