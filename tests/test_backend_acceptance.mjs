/**
 * test_backend_acceptance.mjs
 * 端到端验收脚本：
 * 1. ncb_check：有效 MCP key、故意写错 MCP key、缺少 MCP key 三种情况
 * 2. r2_check：凭据检测与返回结构
 * 3. 状态文件写入：_status.js 创建、合法 JS 执行验证、合并写不覆盖
 * 4. 只读目录降级：不抛异常
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { MagpieMemoryHub } from "../tools.js";
import { ncbCheck } from "../db_tools.js";
import { r2Check } from "../r2.js";
import { runPendingAction, writeCardStatus, STATUS_JS_PATH, STATUS_JSON_PATH, ACTION_KEY } from "../page_actions.js";

const REAL_MCP_KEY = process.env.NOCODEBACKEND_API_KEY || "";
let REAL_SECRET = "";
try {
  REAL_SECRET = readFileSync("/tmp/ncb_sec.key", "utf8").trim();
} catch (_) {}

console.log("=================================================================");
console.log("【验收项一】ncb_check 工具在不同凭据下的表现");
console.log("=================================================================");

// 1.1 缺少 MCP key
{
  const res = await ncbCheck({ instance: "41694_test" }, { mcp_key: "" });
  console.log("1.1 缺少 MCP key 返回：");
  console.log(JSON.stringify(res, null, 2));
  if (res.ok !== false || res.verdict !== "FAILED" || !res.diagnosis || res.diagnosis.kind !== "NO_MCP_KEY") {
    throw new Error("1.1 断言失败：缺少 MCP key 时应返回 ok:false, verdict:FAILED, kind:NO_MCP_KEY");
  }
  console.log("  ✓ 缺少 MCP key 断言通过\n");
}

// 1.2 故意写错 MCP key
{
  const res = await ncbCheck({ instance: "41694_test" }, { mcp_key: "invalid_mcp_token_xyz" });
  console.log("1.2 故意写错 MCP key 返回：");
  console.log(JSON.stringify(res, null, 2));
  if (res.ok !== false || res.verdict !== "FAILED" || !res.diagnosis || res.diagnosis.kind !== "INVALID_MCP_KEY") {
    throw new Error("1.2 断言失败：写错 MCP key 时应返回 ok:false, verdict:FAILED, kind:INVALID_MCP_KEY");
  }
  console.log("  ✓ 故意写错 MCP key 断言通过\n");
}

// 1.3 真实正确 MCP key（针对已存在库 41694_agent_memory）
if (REAL_MCP_KEY) {
  const res = await ncbCheck({ instance: "41694_agent_memory", mcp_key: REAL_MCP_KEY }, {});
  console.log("1.3 正确 MCP key（目标库存在且结构就绪）返回：");
  console.log(JSON.stringify(res, null, 2));
  if (res.ok !== true || res.verdict !== "VERIFIED" || res.database_exists !== true || !res.schema || typeof res.schema.initialized !== "boolean") {
    throw new Error("1.3 断言失败：正确 MCP key 且库存在时应返回 ok:true, verdict:VERIFIED, database_exists:true");
  }
  console.log("  ✓ 正确 MCP key（库存在）断言通过\n");

  const resNew = await ncbCheck({ instance: "41694_uncreated_demo", mcp_key: REAL_MCP_KEY }, {});
  console.log("1.4 正确 MCP key（目标库尚未创建）返回：");
  console.log(JSON.stringify(resNew, null, 2));
  if (resNew.ok !== true || resNew.verdict !== "VERIFIED" || resNew.database_exists !== false) {
    throw new Error("1.4 断言失败：正确 MCP key 且库未建时应返回 ok:true, database_exists:false");
  }
  console.log("  ✓ 正确 MCP key（库未建）断言通过\n");
} else {
  console.log("  ℹ 跳过 1.3 / 1.4：未提供环境变量 NOCODEBACKEND_API_KEY\n");
}

console.log("=================================================================");
console.log("【验收项二】r2_check 工具返回结构验证");
console.log("=================================================================");
{
  const res = await r2Check({ instance: "41694_test", mcpKey: REAL_MCP_KEY || "dummy" }, {});
  console.log("r2_check 返回结构：");
  console.log(JSON.stringify(res, null, 2));
  const keys = ["ok", "verdict", "database", "bucket_name", "public_url", "credentials_source", "probe", "diagnosis", "note"];
  for (const k of keys) {
    if (!(k in res)) throw new Error(`r2_check 结果缺少必需字段: ${k}`);
  }
  console.log("  ✓ r2_check 返回结构完全符合规范\n");
}

console.log("=================================================================");
console.log("【验收项三】状态文件 (_status.js) 端到端与合并写验证");
console.log("=================================================================");

// 清理旧状态文件确保测试从零开始
try { if (existsSync(STATUS_JS_PATH)) unlinkSync(STATUS_JS_PATH); } catch (_) {}
try { if (existsSync(STATUS_JSON_PATH)) unlinkSync(STATUS_JSON_PATH); } catch (_) {}

// 3.1 信标触发写入 ncb 状态
console.log("3.1 触发信标并断言 _status.js 生成...");
const actionResult = await runPendingAction({
  ncb_instance: "41694_test",
  [ACTION_KEY]: { op: "status", id: "beacon_test_" + Date.now(), at: Date.now() },
}, { instance: "41694_test", mcpKey: REAL_MCP_KEY, secret: REAL_SECRET });

console.log("信标执行结果 ran:", actionResult.ran);
if (!existsSync(STATUS_JS_PATH)) {
  throw new Error(`断言失败：_status.js 未被创建 (${STATUS_JS_PATH})`);
}
console.log("  ✓ _status.js 文件成功创建");

// 3.2 验证 _status.js 是合法 JS 且能在浏览器上下文安全执行
const jsContent = readFileSync(STATUS_JS_PATH, "utf8");
console.log("\n_status.js 真实文件内容：");
console.log("----------------------------------------");
console.log(jsContent.trim());
console.log("----------------------------------------");

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(jsContent, ctx);

if (!ctx.window.__memhubStatus || !ctx.window.__memhubStatus.ncb) {
  throw new Error("断言失败：window.__memhubStatus.ncb 不存在");
}
const ncbCard = ctx.window.__memhubStatus.ncb;
console.log("读取到的 window.__memhubStatus.ncb:", JSON.stringify(ncbCard));
if (typeof ncbCard.ok !== "boolean" || typeof ncbCard.title !== "string" || !Array.isArray(ncbCard.lines)) {
  throw new Error("断言失败：ncb 状态卡缺少 ok/title/lines");
}
console.log("  ✓ _status.js 为合法 JS，且包含合规的 ncb 状态卡");

// 3.3 再写一次 r2，断言合并写不覆盖 ncb
console.log("\n3.3 写入 r2 状态卡，验证合并写...");
writeCardStatus("r2", {
  at: Date.now(),
  op: "storage_setup",
  ok: false,
  title: "R2 挂载未生效",
  lines: ["TLS 握手被拒（凭据陈旧）", "请到 NCB 控制台更新 Cloudflare 连接"]
});

const mergedJs = readFileSync(STATUS_JS_PATH, "utf8");
console.log("\n合并后的 _status.js 内容：");
console.log("----------------------------------------");
console.log(mergedJs.trim());
console.log("----------------------------------------");

const ctx2 = { window: {} };
vm.createContext(ctx2);
vm.runInContext(mergedJs, ctx2);

if (!ctx2.window.__memhubStatus.ncb) {
  throw new Error("断言失败：写入 r2 后，原有的 ncb 卡片被意外抹掉！");
}
if (!ctx2.window.__memhubStatus.r2) {
  throw new Error("断言失败：r2 卡片未写入！");
}
console.log("  ✓ 合并写验证通过：ncb 与 r2 状态均完整共存");

console.log("\n=================================================================");
console.log("【验收项四】只读目录静默降级测试");
console.log("=================================================================");
{
  // 采用不可写路径（父级为普通文件，操作系统级阻断写入，即使 root 用户也无法创建）
  const blockedFile = "/tmp/blocked_file_" + Date.now();
  writeFileSync(blockedFile, "i_am_a_file");
  const unwritableJsPath = join(blockedFile, "_status.js");

  let threw = false;
  try {
    const success = writeCardStatus("ncb", { title: "test", lines: ["a", "b"] }, "status", unwritableJsPath);
    console.log("不可写路径写入返回值:", success, "（期望返回 false 且绝不抛出未捕获异常）");
    if (success !== false) threw = true;
  } catch (e) {
    threw = true;
    console.error("未预期抛出异常：", e);
  } finally {
    try { unlinkSync(blockedFile); } catch (_) {}
  }

  if (threw) {
    throw new Error("断言失败：不可写路径下 writeCardStatus 抛出了未捕获异常或未返回 false！");
  }
  console.log("  ✓ 不可写路径静默降级断言通过（console.error 记录日志，未向外抛出异常）\n");
}

console.log("=================================================================");
console.log("【验收项五】宿主工具 execute 钩子调用验证");
console.log("=================================================================");
{
  const hub = await MagpieMemoryHub({}, {
    ncb_instance: "41694_test",
    mcp_key: REAL_MCP_KEY,
    ncb_secret: REAL_SECRET,
  });

  if (!hub.tool.ncb_check) throw new Error("hub.tool 缺少 ncb_check 工具");
  if (!hub.tool.r2_check) throw new Error("hub.tool 缺少 r2_check 工具");
  if (hub.tool.memory_extract) throw new Error("hub.tool 不应再包含 memory_extract 工具");

  console.log("调用 hub.tool.ncb_check.execute()...");
  const toolRes = await hub.tool.ncb_check.execute({ database: "41694_test" });
  console.log("工具执行返回 title:", toolRes.title);

  // 验证状态文件已被工具 hook 自动更新
  const jsAfterTool = readFileSync(STATUS_JS_PATH, "utf8");
  const ctx3 = { window: {} };
  vm.createContext(ctx3);
  vm.runInContext(jsAfterTool, ctx3);

  if (!ctx3.window.__memhubStatus.ncb || ctx3.window.__memhubStatus.ncb.op !== "ncb_check") {
    throw new Error(`工具 hook 写入状态失败：op 期望 ncb_check，实际为 ${ctx3.window.__memhubStatus.ncb?.op}`);
  }
  console.log("  ✓ 工具 hook 成功将 ncb_check 结果同步写入 _status.js");
}

console.log("\n🎉 所有验收项全部通过！");
