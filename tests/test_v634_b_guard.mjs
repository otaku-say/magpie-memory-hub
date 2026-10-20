/**
 * tests/test_v634_b_guard.mjs
 *
 * v6.34 Agent B 专项守卫反证门测试套件：
 * 1. 【反证门 1】提示词 marker 漂移致自激豁免失效修复（文案一致性、真实 Prompt 识别、Gemini snake_case 覆盖、普通流量免误伤）
 * 2. 【反证门 2】白名单子串绕过修复（/var/log 拒否、祖先软链指向敏感目录拒否、合法白名单放行）
 * 3. 【反证门 3】isTestMode 全路径判定致生产停摆修复（生产环境含 test_ 目录非测试判定、真实测试脚本测试判定、环境变量优先）
 * 4. 【元检查自检】符合 test_meta.mjs 规范自证（0 规范违规）
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isInternalHarvestRequest,
  INTERNAL_PROMPT_MARKERS,
} from "../model_budget.js";
import {
  validateGatewayDir,
  isWhitelistedGatewayDir,
  isVarSubdomainAllowed,
  isTestMode,
} from "../gateway_harvest.js";
import {
  AUDIT_SYSTEM_PROMPT,
  AUDIT_SYSTEM_PROMPT_LEAD,
  QUERY_REWRITE_SYSTEM_PROMPT,
  QUERY_REWRITE_SYSTEM_PROMPT_LEAD,
  ERROR_DIAGNOSE_SYSTEM_PROMPT,
  ERROR_DIAGNOSE_SYSTEM_PROMPT_LEAD,
  RERANK_SYSTEM_PROMPT,
  RERANK_SYSTEM_PROMPT_LEAD,
} from "../online_models.js";
import { HARVEST_SYSTEM_PROMPT } from "../gateway_harvest.hooks.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【v6.34 Agent B 专项反证门测试套件】");
console.log("=================================================================\n");

// -----------------------------------------------------------------------------
// 1. 【反证门 1】提示词 marker 漂移致自激豁免失效修复与防漂移反证门
// -----------------------------------------------------------------------------
console.log("▶ [反证门 1] 提示词 marker 真实文案一致性与 Gemini snake_case 豁免识别...");
{
  // 1.1 真实 Prompt 来源特征句防漂移断言（各提示词首句/特征词必须命中 INTERNAL_PROMPT_MARKERS）
  const realPrompts = [
    { name: "AUDIT_SYSTEM_PROMPT", prompt: AUDIT_SYSTEM_PROMPT, lead: AUDIT_SYSTEM_PROMPT_LEAD },
    { name: "QUERY_REWRITE_SYSTEM_PROMPT", prompt: QUERY_REWRITE_SYSTEM_PROMPT, lead: QUERY_REWRITE_SYSTEM_PROMPT_LEAD },
    { name: "ERROR_DIAGNOSE_SYSTEM_PROMPT", prompt: ERROR_DIAGNOSE_SYSTEM_PROMPT, lead: ERROR_DIAGNOSE_SYSTEM_PROMPT_LEAD },
    { name: "RERANK_SYSTEM_PROMPT", prompt: RERANK_SYSTEM_PROMPT, lead: RERANK_SYSTEM_PROMPT_LEAD },
    { name: "HARVEST_SYSTEM_PROMPT", prompt: HARVEST_SYSTEM_PROMPT, lead: "长期记忆与踩坑经验提炼助手" },
  ];

  for (const item of realPrompts) {
    const matched = INTERNAL_PROMPT_MARKERS.some((mk) => item.prompt.includes(mk));
    assert.strictEqual(
      matched,
      true,
      `防漂移强断言：系统提示词 ${item.name} 必须包含至少一个 INTERNAL_PROMPT_MARKERS 成员！`
    );
    assert.ok(
      INTERNAL_PROMPT_MARKERS.includes(item.lead),
      `防漂移强断言：INTERNAL_PROMPT_MARKERS 必须显式包含 ${item.name} 首句常量 '${item.lead}'`
    );
  }

  // 1.2 P0-1 核心根因复现反证：使用真实 AUDIT_SYSTEM_PROMPT 构造去重请求，必须判定为内部请求
  // a) OpenAI / Chat 格式 messages
  const auditChatReq = {
    messages: [
      { role: "system", content: AUDIT_SYSTEM_PROMPT },
      { role: "user", content: "请对以下两组记忆进行查重合并" },
    ],
  };
  assert.strictEqual(
    isInternalHarvestRequest(auditChatReq, {}),
    true,
    "反证门 1.2a：真实 AUDIT_SYSTEM_PROMPT 在 messages[0] 必须返回 true 豁免！"
  );

  // b) Claude / Anthropic 格式 body.system
  const auditSystemReq = {
    system: AUDIT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "执行记忆查重" }],
  };
  assert.strictEqual(
    isInternalHarvestRequest(auditSystemReq, {}),
    true,
    "反证门 1.2b：真实 AUDIT_SYSTEM_PROMPT 在 body.system 必须返回 true 豁免！"
  );

  // c) Gemini camelCase: body.systemInstruction (对象及字符串)
  const auditGeminiCamelObj = {
    contents: [{ role: "user", parts: [{ text: "执行查重" }] }],
    systemInstruction: {
      parts: [{ text: AUDIT_SYSTEM_PROMPT }],
    },
  };
  assert.strictEqual(
    isInternalHarvestRequest(auditGeminiCamelObj, {}),
    true,
    "反证门 1.2c：Gemini systemInstruction 对象承载 AUDIT_SYSTEM_PROMPT 必须返回 true 豁免！"
  );

  // d) Gemini snake_case: body.system_instruction (对象及字符串，P0-1 根因 b 关键修复)
  const auditGeminiSnakeObj = {
    contents: [{ role: "user", parts: [{ text: "执行查重" }] }],
    system_instruction: {
      parts: [{ text: AUDIT_SYSTEM_PROMPT }],
    },
  };
  assert.strictEqual(
    isInternalHarvestRequest(auditGeminiSnakeObj, {}),
    true,
    "反证门 1.2d：Gemini snake_case body.system_instruction 对象承载 AUDIT_SYSTEM_PROMPT 必须返回 true 豁免！"
  );

  const auditGeminiSnakeStr = {
    contents: [{ role: "user", parts: [{ text: "执行查重" }] }],
    system_instruction: AUDIT_SYSTEM_PROMPT,
  };
  assert.strictEqual(
    isInternalHarvestRequest(auditGeminiSnakeStr, {}),
    true,
    "反证门 1.2e：Gemini snake_case body.system_instruction 字符串承载 AUDIT_SYSTEM_PROMPT 必须返回 true 豁免！"
  );

  // 1.3 其它真实核心 Prompt 覆盖验证
  // QUERY_REWRITE_SYSTEM_PROMPT
  assert.strictEqual(
    isInternalHarvestRequest({ messages: [{ role: "system", content: QUERY_REWRITE_SYSTEM_PROMPT }] }, {}),
    true,
    "反证门 1.3a：真实 QUERY_REWRITE_SYSTEM_PROMPT 必须返回 true 豁免！"
  );
  // HARVEST_SYSTEM_PROMPT
  assert.strictEqual(
    isInternalHarvestRequest({ messages: [{ role: "system", content: HARVEST_SYSTEM_PROMPT }] }, {}),
    true,
    "反证门 1.3b：真实 HARVEST_SYSTEM_PROMPT 必须返回 true 豁免！"
  );
  // RERANK_SYSTEM_PROMPT
  assert.strictEqual(
    isInternalHarvestRequest({ system: RERANK_SYSTEM_PROMPT, messages: [] }, {}),
    true,
    "反证门 1.3c：真实 RERANK_SYSTEM_PROMPT 必须返回 true 豁免！"
  );
  // ERROR_DIAGNOSE_SYSTEM_PROMPT
  assert.strictEqual(
    isInternalHarvestRequest({ messages: [{ role: "system", content: ERROR_DIAGNOSE_SYSTEM_PROMPT }] }, {}),
    true,
    "反证门 1.3d：真实 ERROR_DIAGNOSE_SYSTEM_PROMPT 必须返回 true 豁免！"
  );

  // 1.4 普通外部用户请求反例断言（零误伤保障）
  const normalUserChat = {
    messages: [
      { role: "system", content: "You are an expert full-stack developer assisting a junior engineer." },
      { role: "user", content: "How do I implement JWT token refresh in Express.js?" },
    ],
  };
  assert.strictEqual(
    isInternalHarvestRequest(normalUserChat, {}),
    false,
    "反例反证 1.4a：普通用户 Chat 请求绝不可返回 true 误免！"
  );

  const normalGeminiUser = {
    contents: [{ role: "user", parts: [{ text: "请为我写一段冒泡排序" }] }],
    system_instruction: { parts: [{ text: "你是一个编程助手。" }] },
  };
  assert.strictEqual(
    isInternalHarvestRequest(normalGeminiUser, {}),
    false,
    "反例反证 1.4b：普通用户 Gemini snake_case 请求绝不可返回 true 误免！"
  );

  console.log("  ✓ 反证门 1 全部通过：真实提示词防漂移断言成立，Gemini snake_case 精准豁免，普通流量零误伤\n");
}

// -----------------------------------------------------------------------------
// 2. 【反证门 2】白名单子串绕过修复与敏感根域拦截反证门
// -----------------------------------------------------------------------------
console.log("▶ [反证门 2] /var 根域子域限制、敏感祖先软链接拦截与合法目录放行...");
{
  const testId = Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  const linkVarLog = path.join(os.tmpdir(), `v634_b_link_varlog_${testId}`);
  const normalTmpDir = path.join(os.tmpdir(), `v634_b_normal_${testId}`);

  try {
    try {
      fs.symlinkSync("/var/log", linkVarLog);
    } catch (e) {
      console.warn("建立 /var/log 软链接跳过:", e.message);
    }
    try {
      fs.mkdirSync(normalTmpDir, { recursive: true });
    } catch (e) {
      console.warn("建立普通目录跳过:", e.message);
    }

    // 2.1 isVarSubdomainAllowed 子域判定验证
    assert.strictEqual(isVarSubdomainAllowed("/var/minis"), true, "/var/minis 必须允许");
    assert.strictEqual(isVarSubdomainAllowed("/var/minis/project/GatewayConversations"), true, "/var/minis 子目录必须允许");
    assert.strictEqual(isVarSubdomainAllowed("/var/folders/xyz"), true, "/var/folders 必须允许");
    assert.strictEqual(isVarSubdomainAllowed("/var/tmp/gateway"), true, "/var/tmp 必须允许");
    assert.strictEqual(isVarSubdomainAllowed("/private/var/tmp"), true, "/private/var/tmp 必须允许");
    assert.strictEqual(isVarSubdomainAllowed("/var/log"), false, "/var/log 必须严厉禁止");
    assert.strictEqual(isVarSubdomainAllowed("/var/log/GatewayConversations"), false, "/var/log/GatewayConversations 必须严厉禁止");
    assert.strictEqual(isVarSubdomainAllowed("/var/lib"), false, "/var/lib 必须禁止");
    assert.strictEqual(isVarSubdomainAllowed("/var"), false, "/var 根目录必须禁止");

    // 2.2 故意构造 /var/log/GatewayConversations 路径，即便含白名单子串也必须被拒绝！
    assert.throws(
      () => validateGatewayDir("/var/log/GatewayConversations"),
      /\[SECURITY_BLOCKED\]/,
      "反证门 2.2：/var/log/GatewayConversations 虽含白名单子串，但属于未授权 /var 子域，必须坚决拦截！"
    );

    // 2.3 祖先软链接指向 /var/log，子路径为 GatewayConversations
    const evilSymlinkDir = path.join(linkVarLog, "GatewayConversations");
    assert.throws(
      () => validateGatewayDir(evilSymlinkDir),
      /\[SECURITY_BLOCKED\]/,
      "反证门 2.3：祖先软链接指向 /var/log 且目标含 GatewayConversations，必须被坚决拦截！"
    );

    // 2.4 白名单判定函数 isWhitelistedGatewayDir 对敏感父目录返回 false
    assert.strictEqual(
      isWhitelistedGatewayDir("/var/log/GatewayConversations"),
      false,
      "反证门 2.4a：isWhitelistedGatewayDir 对 /var/log/GatewayConversations 必须返回 false！"
    );
    assert.strictEqual(
      isWhitelistedGatewayDir(evilSymlinkDir),
      false,
      "反证门 2.4b：isWhitelistedGatewayDir 对指向 /var/log 的软链路径必须返回 false！"
    );

    // 2.5 合法目录放行反例断言（合法路径绝不可被误杀）：
    // a) /var/minis 下包含 GatewayConversations
    assert.ok(
      isWhitelistedGatewayDir("/var/minis/workspace/GatewayConversations"),
      "反例反证 2.5a：/var/minis/workspace/GatewayConversations 必须在白名单内！"
    );
    assert.ok(
      validateGatewayDir("/var/minis/workspace/GatewayConversations"),
      "反例反证 2.5b：/var/minis/workspace/GatewayConversations 必须放行！"
    );

    // b) 用户主目录 ~/GatewayConversations
    assert.ok(
      validateGatewayDir("~/GatewayConversations"),
      "反例反证 2.5c：标准用户主目录 ~/GatewayConversations 必须放行！"
    );

    // c) 普通临时目录 /tmp/ok/GatewayConversations
    const okTmpDir = path.join(normalTmpDir, "ok", "GatewayConversations");
    assert.ok(
      validateGatewayDir(okTmpDir),
      "反例反证 2.5d：合法临时目录 /tmp/ok/GatewayConversations 必须放行！"
    );
  } finally {
    try { fs.unlinkSync(linkVarLog); } catch (e) { void e; }
    try { fs.rmSync(normalTmpDir, { recursive: true, force: true }); } catch (e) { void e; }
  }

  console.log("  ✓ 反证门 2 全部通过：/var/log 敏感逃逸被阻断，软链接绕过被杜绝，合法白名单 100% 放行\n");
}

// -----------------------------------------------------------------------------
// 3. 【反证门 3】isTestMode 全路径判定致生产停摆修复与测试识别反证门
// -----------------------------------------------------------------------------
console.log("▶ [反证门 3] isTestMode() 生产路径保护与测试脚本精确识别...");
{
  const savedArgv = [...process.argv];
  const savedMagpieTest = process.env.MAGPIE_TEST;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedMemhubTest = process.env.MEMHUB_TEST;

  try {
    delete process.env.MAGPIE_TEST;
    delete process.env.NODE_ENV;
    delete process.env.MEMHUB_TEST;

    // 3.1 生产环境部署在包含 "test_" 的目录，绝不能被误判为测试环境！
    // 根因：旧代码使用 entry.includes("test_")，导致以下路径全部判定为 true，生产功能瘫痪
    process.argv = ["node", "/var/minis/test_env/app.js"];
    assert.strictEqual(
      isTestMode(),
      false,
      "反证门 3.1a：生产路径 /var/minis/test_env/app.js 绝不可被判为测试环境！"
    );

    process.argv = ["node", "/home/user/test_project/server.js"];
    assert.strictEqual(
      isTestMode(),
      false,
      "反证门 3.1b：生产路径 /home/user/test_project/server.js 绝不可被判为测试环境！"
    );

    process.argv = ["node", "/workspace/m/test_runner_prod/main.js"];
    assert.strictEqual(
      isTestMode(),
      false,
      "反证门 3.1c：生产路径 /workspace/m/test_runner_prod/main.js 绝不可被判为测试环境！"
    );

    // 3.2 真实测试脚本能够被精准识别为测试环境
    // a) basename 匹配 /^test_.*\.mjs$/
    process.argv = ["node", "/workspace/m/tests/test_x.mjs"];
    assert.strictEqual(
      isTestMode(),
      true,
      "反证门 3.2a：标准测试脚本 /workspace/m/tests/test_x.mjs 必须识别为测试环境！"
    );

    // b) 当前测试文件
    process.argv = ["node", "tests/test_v634_b_guard.mjs"];
    assert.strictEqual(
      isTestMode(),
      true,
      "反证门 3.2b：相对路径 tests/test_v634_b_guard.mjs 必须识别为测试环境！"
    );

    // c) 任意 tests/ 目录下的 .mjs 文件（非 test_ 开头，如 adversarial_verify.mjs）
    process.argv = ["node", "/workspace/m/tests/adversarial_verify.mjs"];
    assert.strictEqual(
      isTestMode(),
      true,
      "反证门 3.2c：tests 目录下的 .mjs 测试文件必须识别为测试环境！"
    );

    // d) .test.mjs 或 .test.js 结尾
    process.argv = ["node", "/some/path/worker.test.mjs"];
    assert.strictEqual(
      isTestMode(),
      true,
      "反证门 3.2d：.test.mjs 必须识别为测试环境！"
    );

    // 3.3 环境变量优先判定
    process.argv = ["node", "/var/minis/test_env/app.js"];
    process.env.MAGPIE_TEST = "1";
    assert.strictEqual(
      isTestMode(),
      true,
      "反证门 3.3a：环境变量 MAGPIE_TEST=1 必须优先强制生效为测试模式！"
    );

    delete process.env.MAGPIE_TEST;
    process.env.NODE_ENV = "test";
    assert.strictEqual(
      isTestMode(),
      true,
      "反证门 3.3b：环境变量 NODE_ENV=test 必须优先强制生效为测试模式！"
    );

    delete process.env.NODE_ENV;
    process.env.MEMHUB_TEST = "1";
    assert.strictEqual(
      isTestMode(),
      true,
      "反证门 3.3c：环境变量 MEMHUB_TEST=1 必须优先强制生效为测试模式！"
    );
  } finally {
    process.argv = savedArgv;
    if (savedMagpieTest !== undefined) process.env.MAGPIE_TEST = savedMagpieTest;
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    if (savedMemhubTest !== undefined) process.env.MEMHUB_TEST = savedMemhubTest;
  }

  console.log("  ✓ 反证门 3 全部通过：生产路径 test_ 误判彻底消除，测试环境精准覆盖，环境变量优先保障\n");
}

// -----------------------------------------------------------------------------
// 4. 【元检查自检】test_meta 规范元检查自证
// -----------------------------------------------------------------------------
console.log("▶ [元检查自检] 对本测试文件进行 test_meta 规范合规性自检...");
{
  const thisFile = fileURLToPath(import.meta.url);
  const rawContent = fs.readFileSync(thisFile, "utf8");
  const scanRes = scanTestFile(thisFile, rawContent);

  if (scanRes.issues.length > 0) {
    console.error("❌ test_v634_b_guard.mjs 存在 test_meta 规范违规:");
    for (const is of scanRes.issues) {
      console.error("   -", is);
    }
  }

  assert.strictEqual(
    scanRes.issues.length,
    0,
    "本测试文件自身必须 100% 符合 test_meta 测试规范！"
  );
  assert.strictEqual(
    scanRes.hasDbWrite,
    false,
    "本测试纯防护反证，不触碰数据库写操作"
  );

  console.log("  ✓ 本测试文件经 test_meta 扫描，0 规范违规！\n");
}

console.log("=================================================================");
console.log("✅ 全部 3 大专项反证门与元检查自检 100% 通过！");
console.log("=================================================================");
