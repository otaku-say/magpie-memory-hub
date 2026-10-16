/**
 * 信标端到端贯通测试 —— 补上「页面发得出去 ≠ 宿主接得住」这个盲区。
 *
 * 背景：曾经出过两个真 bug —— `r2_check` 与 `model_check` 两个按钮，
 * 页面侧测试全绿（确实提交了 `op`），但**宿主侧 OPS 里没有这两个 op**，
 * 于是 readAction() 把它们判为非法信标直接忽略，用户点了按钮永远没反应。
 *
 * 教训：只验「发送侧」的测试会让断掉的链子看起来是通的。
 * 本脚本从**页面真正写出的 payload** 出发，逐个确认：
 *   ① 宿主认这个 op（readAction 不返回 null）
 *   ② 宿主有对应的执行分支且**真的能跑出结果**
 *   ③ 结果被写进**正确那张卡片**的 key
 */
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = process.cwd();

const { readAction, runPendingAction, OPS, STATUS_JSON_PATH } = await import(path.join(ROOT, "page_actions.js"));

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);

/* ---------- 从页面源码里抓出它到底会发哪些 op ---------- */
const js = readFileSync(path.join(ROOT, "settings.js"), "utf8");
const sentOps = new Set();
for (const m of js.matchAll(/submitAction\(\s*"([a-z_]+)"/g)) sentOps.add(m[1]);
for (const m of js.matchAll(/submitAction\(\s*"([a-z_]+)"\s*,\s*\{/g)) sentOps.add(m[1]);
// 弹窗确认那两处是间接调用，手工补上
sentOps.add("provision");
sentOps.add("reset");

console.log("=== 1. 页面会发出的 op 清单 ===");
console.log("  " + [...sentOps].sort().join(", "));

console.log("\n=== 2. 关键断言：每一个「页面会发的 op」宿主都必须认 ===");
{
  let bad = [];
  for (const op of sentOps) {
    const r = readAction({ _action: { op, id: op + "-e2e", at: Date.now() } });
    if (!r) bad.push(op);
  }
  check(bad.length === 0, bad.length
    ? `宿主不认这些 op（点了按钮会毫无反应）：${bad.join(", ")}`
    : `全部 ${sentOps.size} 个 op 宿主都认`);
}

console.log("\n=== 3. 每个 op 都要有执行分支与卡片归属 ===");
{
  const src = readFileSync(path.join(ROOT, "page_actions.js"), "utf8");
  // status 走的是 execute() 末尾的 else 兜底分支（dbStatus），不必显式列 op
  const viaElse = new Set(["status"]);
  const missingExec = [...sentOps].filter((op) =>
    !viaElse.has(op) && !new RegExp(`action\\.op === "${op}"`).test(src));
  check(missingExec.length === 0, missingExec.length
    ? `这些 op 没有执行分支：${missingExec.join(", ")}`
    : "每个 op 都有执行分支");

  // 卡片归属：不能所有非 r2 的都落到 ncb
  const cardMap = src.match(/const CARD_OF_OP = \{([^}]*)\}/);
  check(!!cardMap, "存在显式的 CARD_OF_OP 卡片归属表");
  if (cardMap) {
    const declared = [...cardMap[1].matchAll(/([a-z_]+)\s*:/g)].map((m) => m[1]);
    const missingCard = [...sentOps].filter((op) => !declared.includes(op));
    check(missingCard.length === 0, missingCard.length
      ? `这些 op 没写卡片归属，结果会写错卡片：${missingCard.join(", ")}`
      : `全部 op 都有明确卡片归属（${declared.length} 条）`);
  }
  check(Object.keys(OPS).length >= sentOps.size,
    `OPS 表条目数 ${Object.keys(OPS).length} ≥ 页面发出的 op 数 ${sentOps.size}`);
}

console.log("\n=== 4. 真实跑一遍：三个检测信标各自把结果写进哪张卡片 ===");
{
  const cases = [
    ["ncb_check", "ncb"],
    ["r2_check", "r2"],
    ["model_check", "model"],
  ];
  for (const [op, wantCard] of cases) {
    if (existsSync(STATUS_JSON_PATH)) rmSync(STATUS_JSON_PATH, { force: true });
    let r;
    try {
      r = await runPendingAction({ _action: { op, id: op + "-e2e-" + Date.now(), at: Date.now() } }, { instance: process.env.NCB_TEST_DB || "41694_agent_memory", mcpKey: "" });
    } catch (e) {
      no(`${op} 执行抛异常: ${String(e && e.message).slice(0, 80)}`);
      continue;
    }
    check(r && r.ran === true, `${op} 被宿主真实执行（ran=${r && r.ran}）`);

    let written = null;
    try {
      written = JSON.parse(readFileSync(STATUS_JSON_PATH, "utf8"));
    } catch (e) { /* 文件可能不存在 */ }
    if (!written) { no(`${op} 没有写出状态文件`); continue; }
    const keys = Object.keys(written);
    check(keys.includes(wantCard), `${op} 结果写进了 ${wantCard} 卡片（实际写进：${keys.join(",")}）`);
    const card = written[wantCard];
    if (card) {
      check(typeof card.title === "string" && card.title.length > 0, `${op} 给出了人话标题：「${card.title}」`);
      check(Array.isArray(card.lines) && card.lines.length > 0, `${op} 给出了 ${card.lines ? card.lines.length : 0} 条明细`);
      check(typeof card.ok === "boolean", `${op} 带明确的成功/失败标记 ok=${card.ok}`);
    }
  }
}

console.log("\n=== 5. 合并写：三张卡片的结果必须共存，不能互相覆盖 ===");
{
  if (existsSync(STATUS_JSON_PATH)) rmSync(STATUS_JSON_PATH, { force: true });
  for (const op of ["ncb_check", "r2_check", "model_check"]) {
    await runPendingAction({ _action: { op, id: op + "-merge-" + Date.now(), at: Date.now() } }, { instance: process.env.NCB_TEST_DB || "41694_agent_memory", mcpKey: "" });
  }
  let written = null;
  try { written = JSON.parse(readFileSync(STATUS_JSON_PATH, "utf8")); } catch (e) {}
  if (written) {
    check(["ncb", "r2", "model"].every((k) => !!written[k]),
      `三张卡片结果共存（实际：${Object.keys(written).join(",")}）`);
  } else {
    no("状态文件不存在");
  }
  rmSync(STATUS_JSON_PATH, { force: true });
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ 信标端到端贯通全部通过");
process.exit(fail ? 1 : 0);
