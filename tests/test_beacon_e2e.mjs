/**
 * test_beacon_e2e.mjs
 * 信标端到端贯通测试 —— 补上「页面发得出去 ≠ 宿主接得住」这个盲区。
 * 严谨性整改：
 * 1. 使用 tests/lib/testenv.mjs 隔离测试环境
 * 2. 强断言：卡片结构完整性（title/lines/ok）、合并写不丢失
 * 3. 反证测试：断言未在白名单的伪造信标必定被 readAction 拦截为 null
 * 4. 彻底清理：清理临时状态文件与 DB，断言残留数为 0
 */
import assert from "node:assert";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createTestEnv } from "./lib/testenv.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = process.cwd();

const { readAction, runPendingAction, writeCardStatus, OPS, STATUS_JSON_PATH } = await import(path.join(ROOT, "page_actions.js"));

const env = await createTestEnv({ instance: "41694_agent_memory", requireMcp: true });
console.log(`[test_beacon_e2e] 隔离命名空间 project: ${env.project}`);

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);

try {
  /* ---------- 从页面源码里抓出它到底会发哪些 op ---------- */
  const js = readFileSync(path.join(ROOT, "src/page/settings.js"), "utf8");
  const allSentOps = new Set();
  for (const m of js.matchAll(/submitAction\(\s*"([a-z_]+)"/g)) allSentOps.add(m[1]);
  for (const m of js.matchAll(/submitAction\(\s*"([a-z_]+)"\s*,\s*\{/g)) allSentOps.add(m[1]);
  // 弹窗确认那两处是间接调用，手工补上
  allSentOps.add("provision");
  allSentOps.add("reset");

  // harvest_gateway 是网关对话提炼专有信标，已下线的本地模型下载信标（model_download）已彻底移除
  const deprecatedOps = new Set(["model_download"]);
  const sentOps = new Set([...allSentOps].filter((op) => !deprecatedOps.has(op)));

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
    const pageActionsPath = existsSync(path.join(ROOT, "src/page/actions.js"))
      ? path.join(ROOT, "src/page/actions.js")
      : path.join(ROOT, "page_actions.js");
    const src = readFileSync(pageActionsPath, "utf8");
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

  console.log("\n=== 4. 真实跑一遍：检测信标各自把结果写进哪张卡片 ===");
  {
    const cases = [
      ["ncb_check", "ncb"],
      ["secret_check", "ncb"],
      ["r2_check", "r2"],
      ["clean_probe", "r2"],
      ["model_check", "model"],
    ];
    for (const [op, wantCard] of cases) {
      if (existsSync(STATUS_JSON_PATH)) rmSync(STATUS_JSON_PATH, { force: true });
      let r;
      try {
        r = await runPendingAction(
          { _action: { op, id: op + "-e2e-" + Date.now(), at: Date.now() } },
          { instance: env.instance, mcpKey: env.mcpKey, secret: env.secret }
        );
      } catch (e) {
        no(`${op} 执行抛异常: ${String(e && e.message).slice(0, 80)}`);
        continue;
      }
      check(r && r.ran === true, `${op} 被宿主真实执行（ran=${r && r.ran}）`);

      let written = null;
      if (existsSync(STATUS_JSON_PATH)) {
        written = JSON.parse(readFileSync(STATUS_JSON_PATH, "utf8"));
      }
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

  console.log("\n=== 5. 合并写：各卡片的结果必须共存，不能互相覆盖 ===");
  {
    rmSync(STATUS_JSON_PATH, { force: true });
    for (const op of ["ncb_check", "r2_check"]) {
      await runPendingAction(
        { _action: { op, id: op + "-merge-" + Date.now(), at: Date.now() } },
        { instance: env.instance, mcpKey: env.mcpKey, secret: env.secret }
      );
    }
    writeCardStatus("gateway", {
      at: Date.now(),
      op: "harvest_gateway",
      ok: true,
      title: "网关对话提炼就绪",
      lines: ["已扫描对话轮次：0", "数据来源：Magpie 本地录制"]
    });
    let written = null;
    if (existsSync(STATUS_JSON_PATH)) {
      written = JSON.parse(readFileSync(STATUS_JSON_PATH, "utf8"));
    }
    if (written) {
      check(["ncb", "r2", "gateway"].every((k) => !!written[k]),
        `卡片结果共存（实际：${Object.keys(written).join(",")}）`);
    } else {
      no("状态文件不存在");
    }
  }

  console.log("\n=== 6. 反证测试：伪造/未注册信标必定被拒绝 ===");
  {
    const bogusCases = [
      "unregistered_op",
      "malicious_eval",
      "drop_all_database",
      "exec_command",
      "__proto__",
      "model_download",
    ];
    let blockedCount = 0;
    for (const bad of bogusCases) {
      const res = readAction({ _action: { op: bad, id: "bogus-" + Date.now(), at: Date.now() } });
      if (res === null) blockedCount++;
      else no(`反证失败：非法信标 ${bad} 竟被宿主认领: ${JSON.stringify(res)}`);
    }
    check(blockedCount === bogusCases.length, `反证通过：${bogusCases.length} 处非法信标全部被拦截 (返回 null)`);
  }

} finally {
  console.log("\n--- 清理与残余断言 ---");
  if (existsSync(STATUS_JSON_PATH)) rmSync(STATUS_JSON_PATH, { force: true });
  const cleanRes = await env.cleanup();
  const residue = await env.countAllTestResidue();
  check(residue.total === 0, `全局残余必须为 0（实际: ${residue.total}）`);
  console.log("✓ 临时状态文件与 DB 清理完毕");
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ 信标端到端贯通与反证测试全部通过");
process.exit(fail ? 1 : 0);
