/** 验证 r2_setup 能否如实报出「NCB 说成功、实际失败」的情况。 */
import { r2Setup, r2Probe, explainProbeFailure } from "../r2.js";

const KEY = process.env.NOCODEBACKEND_API_KEY || "";
const DB = "41694_agent_memory";
let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);

console.log("=== 1. 纯探测（不挂载，只看现在能不能用）===");
{
  const p = await r2Probe({ instance: DB, mcpKey: KEY });
  if (p.ok) {
    ok(`R2 当前可用（上传成功，返回 url）`);
  } else {
    ok(`R2 当前不可用 —— 探测如实报出错误`);
    console.log(`      原始错误: ${String(p.error).slice(0, 150)}`);
    const ex = explainProbeFailure(p.error);
    console.log(`      判定: [${ex.kind}] ${ex.title}`);
    console.log(`      原因: ${ex.detail.slice(0, 120)}`);
    ex.actions.forEach((a, i) => console.log(`      ${i + 1}. ${a.slice(0, 110)}`));
    check(ex.kind !== "UNKNOWN", `被归类为明确原因（${ex.kind}），不是 UNKNOWN`);
  }
}

console.log("\n=== 2. r2Setup：NCB 说成功 ≠ 真的成功 ===");
{
  const r = await r2Setup({ instance: DB, mcpKey: KEY }, { database: DB });
  console.log(`  NCB 自称:  ok=${r.ncb_reported.ok}  bucket_created=${r.ncb_reported.bucket_created}  ` +
              `reused_existing_connection=${r.ncb_reported.reused_existing_connection}`);
  console.log(`  真实探测:  ${r.probe.uploaded ? "上传成功" : "上传失败"}`);
  console.log(`  最终判定:  ok=${r.ok}  verdict=${r.verdict}`);
  check(typeof r.verdict === "string", `给出明确 verdict: ${r.verdict}`);
  check(r.ok === (r.verdict === "VERIFIED"), "ok 与 verdict 一致（不采信 NCB 返回值）");

  if (!r.ok) {
    console.log(`  --- 会展示给用户的诊断 ---`);
    if (r.diagnosis) {
      console.log(`    [${r.diagnosis.kind}] ${r.diagnosis.title}`);
      r.diagnosis.actions.forEach((a, i) => console.log(`    ${i + 1}. ${a.slice(0, 120)}`));
      check(r.diagnosis.kind !== "UNKNOWN", "诊断明确");
    } else {
      no("探测失败但没有给出诊断");
    }
  }
}

console.log("\n=== 3. 关键论点：不看 NCB 返回值，只看真实探测 ===");
{
  const r = await r2Setup({ instance: DB, mcpKey: KEY }, { database: DB });
  if (r.ncb_reported.ok === true && r.ok === false) {
    ok("已识破「NCB 报 ok:true 但实际不可用」—— 正是静默失败场景");
  } else if (r.ncb_reported.ok === true && r.ok === true) {
    ok("NCB 报成功且真实探测也成功（一致）");
  } else {
    ok(`NCB 报 ok=${r.ncb_reported.ok}，真实探测 ok=${r.ok}`);
  }
}

console.log("\n=== 4. 凭据来源追踪 ===");
{
  const r1 = await r2Setup({ instance: DB, mcpKey: KEY }, { database: DB });
  ok(`未传凭据时: ${r1.credentials_source}`);
  const r2 = await r2Setup({ instance: DB, mcpKey: KEY }, {
    database: DB, account_id: "test-acc", access_key_id: "test-ak", secret_access_key: "test-sk",
  });
  ok(`显式传凭据时: ${r2.credentials_source}`);
  check(/传入/.test(r2.credentials_source), "能区分「本次调用传入」与「设置页保存的」");
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ R2 挂载验证逻辑通过");
process.exit(fail ? 1 : 0);
