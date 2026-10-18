/**
 * test_r2_verify.mjs —— R2 存储挂载判决逻辑与异常分类验收（零真实网络污染版）
 *
 * 核心安全防线：
 * 1. 彻底切断对生产数据库 41694_agent_memory 的真实 setup_r2_storage 调用，杜绝向 NCB 提交测试凭据篡改配置。
 * 2. 纯逻辑与判决状态机采用受控打桩验证，确保断言严密性不衰减。
 * 3. 包含反证与异常覆盖：TLS 握手拒绝、Secret Key 失效、权限不足与未知错误分类。
 */

import { r2Setup, explainProbeFailure } from "../r2.js";
import { NcbMcp } from "../ncb_mcp.js";

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);

console.log("=== 1. 纯逻辑异常分类诊断验证 (explainProbeFailure) ===");
{
  // 1.1 TLS / EPROTO 凭据过期场景
  const errTls = "write EPROTO 10603199FFFF0000:error:0A000410:SSL routines:ssl3_read_bytes:sslv3 alert handshake failure";
  const exTls = explainProbeFailure(errTls);
  check(exTls.kind === "STALE_CREDENTIALS", `TLS 握手失败识别为 STALE_CREDENTIALS (实际: ${exTls.kind})`);
  check(Array.isArray(exTls.actions) && exTls.actions.length >= 3, "包含至少 3 条明确处置指引");

  // 1.2 数据库 Secret Key 失效
  const errSec = "Invalid secret_key provided";
  const exSec = explainProbeFailure(errSec);
  check(exSec.kind === "BAD_SECRET_KEY", `密钥失效识别为 BAD_SECRET_KEY (实际: ${exSec.kind})`);

  // 1.3 凭据无效 (403 / SignatureDoesNotMatch)
  const errCred = "SignatureDoesNotMatch: The request signature we calculated does not match";
  const exCred = explainProbeFailure(errCred);
  check(exCred.kind === "BAD_CREDENTIALS", `鉴权签名不匹配识别为 BAD_CREDENTIALS (实际: ${exCred.kind})`);

  // 1.4 非法桶名
  const errBkt = "InvalidBucketName: Bucket name must not contain uppercase";
  const exBkt = explainProbeFailure(errBkt);
  check(exBkt.kind === "INVALID_BUCKET_NAME", `非法桶名识别为 INVALID_BUCKET_NAME (实际: ${exBkt.kind})`);

  // 1.5 未知错误安全回退
  const errUnk = "Something completely weird happened";
  const exUnk = explainProbeFailure(errUnk);
  check(exUnk.kind === "UNKNOWN", `未知异常安全归类为 UNKNOWN (实际: ${exUnk.kind})`);
}

console.log("\n=== 2. r2Setup 判决防线：NCB 虚报成功 ≠ 真实可用（受控打桩） ===");
{
  const origCallTool = NcbMcp.prototype.callTool;

  try {
    // 模拟 NCB MCP setup_r2_storage 虚报成功（常见平台行为）
    // 模拟真实探针上传失败 (TLS 握手被拒)
    NcbMcp.prototype.callTool = async function (name) {
      if (name === "setup_r2_storage") {
        return { ok: true, bucket_created: false, reused_existing_connection: true };
      }
      if (name === "upload_file") {
        throw new Error("write EPROTO 10603199FFFF0000:ssl3_read_bytes:sslv3 alert handshake failure");
      }
      return { ok: true };
    };

    const mockCfg = { instance: "99999_agent_memory", mcpKey: "mock_key", secret: "mock_sec" };
    const r = await r2Setup(mockCfg, { database: "99999_agent_memory" });

    check(r.ncb_reported.ok === true, "如实捕获 NCB 自称 ok=true");
    check(Boolean(r.probe.error), `探针探测如实判定失败: ${r.probe.error.slice(0, 40)}…`);
    check(r.ok === false, "最终判定 ok=false（绝不采信 NCB 虚报）");
    check(r.verdict === "FAILED_VERIFY", `最终给出 FAILED_VERIFY (实际: ${r.verdict})`);
    check(r.ok === (r.verdict === "VERIFIED"), "ok 与 verdict 一致（不采信 NCB 返回值）");
    check(r.diagnosis && r.diagnosis.kind === "STALE_CREDENTIALS", "诊断明确为 STALE_CREDENTIALS");
  } finally {
    NcbMcp.prototype.callTool = origCallTool;
  }
}

console.log("\n=== 3. 关键论点：不看 NCB 返回值，以真实探测结果为唯一真理 ===");
{
  const origCallTool = NcbMcp.prototype.callTool;

  try {
    NcbMcp.prototype.callTool = async function (name) {
      if (name === "setup_r2_storage") {
        return { ok: true, bucket_created: true, reused_existing_connection: false };
      }
      if (name === "upload_file") {
        return { url: "https://pub-r2.example.com/probe.txt", key: "probe.txt" };
      }
      return { ok: true };
    };

    const mockCfg = { instance: "99999_agent_memory", mcpKey: "mock_key", secret: "mock_sec" };
    const r = await r2Setup(mockCfg, { database: "99999_agent_memory" });

    check(r.ok === true, "真实探针成功时最终 ok=true");
    check(r.verdict === "VERIFIED", `verdict 为 VERIFIED (实际: ${r.verdict})`);
    check(r.diagnosis === null, "验证成功时无异常诊断");
  } finally {
    NcbMcp.prototype.callTool = origCallTool;
  }
}

console.log("\n=== 4. 凭据来源追踪验证 ===");
{
  const origCallTool = NcbMcp.prototype.callTool;

  try {
    NcbMcp.prototype.callTool = async function (name) {
      if (name === "setup_r2_storage") return { ok: true };
      if (name === "upload_file") return { url: "https://pub-r2.example.com/probe.txt" };
      return { ok: true };
    };

    const DB = "99999_agent_memory";
    // 4.1 插件设置页保存的凭据
    const r1 = await r2Setup({
      instance: DB,
      mcpKey: "mock_key",
      secret: "mock_sec",
      r2AccountId: "saved-acc-id",
    }, { database: DB });
    ok(`未显式传凭据时: ${r1.credentials_source}`);
    check(r1.credentials_source === "插件设置页保存的", "识别设置页保存凭据");

    // 4.2 本次调用显式传入凭据
    const r2 = await r2Setup({
      instance: DB,
      mcpKey: "mock_key",
      secret: "mock_sec",
      r2AccountId: "saved-acc-id",
    }, {
      database: DB,
      account_id: "override-acc-id",
      access_key_id: "override-ak",
      secret_access_key: "override-sk",
    });
    ok(`显式传凭据时: ${r2.credentials_source}`);
    check(r2.credentials_source === "本次调用传入", "能区分「本次调用传入」与「设置页保存的」");
    check(/传入/.test(r2.credentials_source), "正则匹配「传入」成功");
  } finally {
    NcbMcp.prototype.callTool = origCallTool;
  }
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ R2 挂载验证逻辑通过（零真实网络副作用）");
process.exit(fail ? 1 : 0);
