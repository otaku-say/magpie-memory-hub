/**
 * tests/test_v633_b_guard.mjs
 *
 * v6.33 Agent B 专项守卫反证门测试：
 * 1. 【反证门 1】Gemini / Responses 内部请求豁免有效性与普通用户请求免误判
 * 2. 【反证门 2】目标子目录不存在时祖先软链接指向敏感目录的拦截与合法目录放行
 * 3. 【反证门 3】statePath() 生产部署路径测试误判拦截与测试环境隔离识别
 * 4. 【元检查自检】符合 test_meta.mjs 规范自证
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isInternalHarvestRequest, INTERNAL_PROMPT_MARKERS } from "../src/domain/token-budget.js";
import { validateGatewayDir } from "../src/services/harvest/index.js";
import { statePath } from "../src/core/state.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【v6.33 Agent B 专项反证门测试套件】");
console.log("=================================================================\n");

// -----------------------------------------------------------------------------
// 1. 【反证门 1】Gemini / Responses 内部请求豁免有效性与普通请求反证
// -----------------------------------------------------------------------------
console.log("▶ [反证门 1] Gemini / Responses 内部请求豁免识别与普通流量免误杀...");
{
  // 1.1 Gemini 内部请求（contents + systemInstruction 对象）
  const geminiInternalObj = {
    contents: [{ role: "user", parts: [{ text: "提取这段会话" }] }],
    systemInstruction: {
      parts: [{ text: "你是一个长期记忆与踩坑经验提炼助手，负责提炼结构化记忆。" }],
    },
  };
  assert.strictEqual(
    isInternalHarvestRequest(geminiInternalObj, {}),
    true,
    "反证门 1.1：Gemini systemInstruction 对象命中 marker 必须返回 true 豁免！"
  );

  // 1.2 Gemini 内部请求（contents + systemInstruction 字符串）
  const geminiInternalStr = {
    contents: [{ role: "user", parts: [{ text: "分析对话" }] }],
    systemInstruction: "你是一个会话价值判定器，评估用户与模型的交互内容。",
  };
  assert.strictEqual(
    isInternalHarvestRequest(geminiInternalStr, {}),
    true,
    "反证门 1.2：Gemini systemInstruction 字符串命中 marker 必须返回 true 豁免！"
  );

  // 1.3 Gemini 内部请求（contents[0] 包含 marker）
  const geminiContents0 = {
    contents: [
      { role: "user", parts: [{ text: "系统故障诊断专家，请分析下列错误日志" }] },
      { role: "model", parts: [{ text: "收到" }] },
    ],
  };
  assert.strictEqual(
    isInternalHarvestRequest(geminiContents0, {}),
    true,
    "反证门 1.3：Gemini contents[0] 命中 marker 必须返回 true 豁免！"
  );

  // 1.4 Responses 内部请求（instructions 字符串 + input 数组）
  const responsesInternalStr = {
    instructions: "你是长期记忆检索改写助手，负责生成高质量搜索词。",
    input: ["关于微服务鉴权架构的历史设计"],
  };
  assert.strictEqual(
    isInternalHarvestRequest(responsesInternalStr, {}),
    true,
    "反证门 1.4：Responses instructions 命中 marker 必须返回 true 豁免！"
  );

  // 1.5 Responses 内部请求（input[0] 包含 marker）
  const responsesInput0 = {
    input: [
      { role: "system", content: "长期记忆中枢体检与质量审阅专家，正在审阅现有记录" },
      { role: "user", content: "开始审查" },
    ],
  };
  assert.strictEqual(
    isInternalHarvestRequest(responsesInput0, {}),
    true,
    "反证门 1.5：Responses input[0] 命中 marker 必须返回 true 豁免！"
  );

  // 1.6 body.system 字段命中 marker（如 Claude / Anthropic 形态）
  const claudeStyle = {
    system: "你是一个记忆中枢检索增强与语义重排专家。",
    messages: [{ role: "user", content: "请对候选集打分" }],
  };
  assert.strictEqual(
    isInternalHarvestRequest(claudeStyle, {}),
    true,
    "反证门 1.6：body.system 命中 marker 必须返回 true 豁免！"
  );

  // 1.7 请求头高速透传识别（保留已有头机制）
  assert.strictEqual(
    isInternalHarvestRequest({}, { headers: { "x-magpie-internal": "memory-hub" } }),
    true,
    "反证门 1.7：请求头 x-magpie-internal 命中必须返回 true 豁免！"
  );
  assert.strictEqual(
    isInternalHarvestRequest({}, { headers: { "x-memhub-internal": "1" } }),
    true,
    "反证门 1.7b：请求头 x-memhub-internal 命中必须返回 true 豁免！"
  );

  // 1.8 反证门（普通外部用户请求绝不可误判为内部请求）
  const normalGemini = {
    contents: [
      { role: "user", parts: [{ text: "你好，请帮我用 Python 编写一段快排算法。" }] },
    ],
  };
  assert.strictEqual(
    isInternalHarvestRequest(normalGemini, {}),
    false,
    "反例反证 1.8a：普通 Gemini 用户请求绝不可返回 true 误免！"
  );

  const normalResponses = {
    instructions: "You are a general purpose programming assistant.",
    input: ["How do I configure nginx for websockets?"],
  };
  assert.strictEqual(
    isInternalHarvestRequest(normalResponses, {}),
    false,
    "反例反证 1.8b：普通 Responses 用户请求绝不可返回 true 误免！"
  );

  const normalChat = {
    messages: [
      { role: "system", content: "You are a helpful and harmless AI assistant." },
      { role: "user", content: "Can you summarize the plot of Inception?" },
    ],
  };
  assert.strictEqual(
    isInternalHarvestRequest(normalChat, {}),
    false,
    "反例反证 1.8c：普通 Chat 用户请求绝不可返回 true 误免！"
  );

  console.log("  ✓ 反证门 1 全部通过：内部请求双路豁免精准生效，普通用户流量零误伤\n");
}

// -----------------------------------------------------------------------------
// 2. 【反证门 2】目标子目录不存在时祖先软链接指向敏感目录的拦截
// -----------------------------------------------------------------------------
console.log("▶ [反证门 2] 目标子目录不存在时祖先软链接绕过防护与合法放行...");
{
  const testId = Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  const linkVarLog = path.join(os.tmpdir(), `v633_b_link_varlog_${testId}`);
  const linkRoot = path.join(os.tmpdir(), `v633_b_link_root_${testId}`);
  const normalDir = path.join(os.tmpdir(), `v633_b_normal_${testId}`);

  try {
    try {
      fs.symlinkSync("/var/log", linkVarLog);
    } catch (e) {
      console.warn("建立 /var/log 软链接跳过:", e.message);
    }
    try {
      fs.symlinkSync("/root", linkRoot);
    } catch (e) {
      console.warn("建立 /root 软链接跳过:", e.message);
    }
    try {
      fs.mkdirSync(normalDir, { recursive: true });
    } catch (e) {
      console.warn("建立普通目录跳过:", e.message);
    }

    // 2.1 故意构造祖先软链接指向 /var/log，子目录尚不存在
    const evilVarLogChild = path.join(linkVarLog, "nonexistent_harvest_child_dir");
    assert.throws(
      () => validateGatewayDir(evilVarLogChild),
      /\[SECURITY_BLOCKED\]/,
      "反证门 2.1：祖先软链接指向 /var/log 且子目录不存在时，必须被 [SECURITY_BLOCKED] 坚决拦截！"
    );

    // 2.2 故意构造祖先软链接指向 /root，子目录指向 .ssh/nonexistent
    const evilRootSshChild = path.join(linkRoot, ".ssh", "nonexistent_child_dir");
    assert.throws(
      () => validateGatewayDir(evilRootSshChild),
      /\[SECURITY_BLOCKED\]/,
      "反证门 2.2：祖先软链接指向 /root/.ssh 且子目录不存在时，必须被 [SECURITY_BLOCKED] 坚决拦截！"
    );

    // 2.3 故意构造祖先软链接指向 /root，子目录指向其它不存在的敏感私有目录
    const evilRootSecretChild = path.join(linkRoot, "private_secrets", "nonexistent_child_dir");
    assert.throws(
      () => validateGatewayDir(evilRootSecretChild),
      /\[SECURITY_BLOCKED\]/,
      "反证门 2.3：祖先软链接指向 /root 未白名单子目录时，必须被 [SECURITY_BLOCKED] 坚决拦截！"
    );

    // 2.4 反证门（正常合法目录放行）：普通临时目录下不存在的子目录必须放行
    const normalChild = path.join(normalDir, "legitimate_nonexistent_child");
    let normalOk = false;
    let normalResolved = null;
    try {
      normalResolved = validateGatewayDir(normalChild);
      normalOk = true;
    } catch (e) {
      normalOk = false;
      console.error("合法子目录被误拦:", e.message);
    }
    assert.strictEqual(
      normalOk,
      true,
      "反例反证 2.4：普通合法目录下的未创建子目录必须放行，绝不可误杀！"
    );
    assert.strictEqual(normalResolved, normalChild, "解析返回路径必须匹配预期");

    // 2.5 官方标准录制目录及白名单放行
    assert.ok(
      validateGatewayDir("~/GatewayConversations"),
      "反例反证 2.5a：标准 ~/GatewayConversations 必须放行"
    );
    assert.ok(
      validateGatewayDir("/var/minis"),
      "反例反证 2.5b：Minis 白名单目录必须放行"
    );
  } finally {
    // 强制清理测试创建的软链接与目录
    try { fs.unlinkSync(linkVarLog); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(linkRoot); } catch (e) { /* ignore */ }
    try { fs.rmdirSync(normalDir); } catch (e) { /* ignore */ }
  }

  console.log("  ✓ 反证门 2 全部通过：祖先软链接越权被全面拦截，合法目录正常放行\n");
}

// -----------------------------------------------------------------------------
// 3. 【反证门 3】statePath() process.argv 误判拦截与测试环境隔离识别
// -----------------------------------------------------------------------------
console.log("▶ [反证门 3] statePath() 测试检测正则精确化与生产路径保护...");
{
  const savedArgv = [...process.argv];
  const savedStateDir = process.env.MEMHUB_STATE_DIR;
  const savedMagpieTest = process.env.MAGPIE_TEST;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedMemhubTest = process.env.MEMHUB_TEST;

  try {
    // 抹去所有可能干扰的环境变量
    delete process.env.MEMHUB_STATE_DIR;
    delete process.env.MAGPIE_TEST;
    delete process.env.NODE_ENV;
    delete process.env.MEMHUB_TEST;

    const expectedProdState = path.join(os.homedir(), ".magpie-memory-hub", "state.json");

    // 3.1 故意模拟生产部署路径中包含 "test" 子串（如 /var/minis/test-env/run.mjs）
    process.argv = ["node", "/var/minis/test-env/run.mjs"];
    const prodStateMinis = statePath();
    assert.strictEqual(
      prodStateMinis,
      expectedProdState,
      "反例反证 3.1a：argv 含 /var/minis/test-env/run.mjs 时，生产状态绝不能被误导向 /tmp！"
    );

    // 3.2 模拟用户目录项目名包含 "test-project"
    process.argv = ["node", "/home/deploy/test-project/server.mjs"];
    const prodStateProject = statePath();
    assert.strictEqual(
      prodStateProject,
      expectedProdState,
      "反例反证 3.1b：argv 含 /home/deploy/test-project/server.mjs 时，必须稳定指向宿主 ~/.magpie-memory-hub！"
    );

    // 3.3 测试环境识别：确实在 tests/ 目录下的 .mjs 脚本
    process.argv = ["node", "tests/test_v633_b_guard.mjs"];
    const testStateRel = statePath();
    assert.ok(
      testStateRel && testStateRel.startsWith(os.tmpdir()),
      "反证门 3.3a：argv 为 tests/xxx.mjs 时，必须精准识别为测试模式并收敛到 tmpdir！"
    );
    assert.ok(
      testStateRel.includes(String(process.pid)),
      "测试模式 statePath 必须包含当前 process.pid 隔离目录"
    );

    // 3.4 绝对路径 tests/ 目录下的测试脚本
    process.argv = ["node", "/workspace/m/tests/test_call_storm_fix.mjs"];
    const testStateAbs = statePath();
    assert.ok(
      testStateAbs && testStateAbs.startsWith(os.tmpdir()),
      "反证门 3.4：argv 为绝对路径 /workspace/m/tests/xxx.mjs 时必须正确识别为测试模式！"
    );

    // 3.5 环境变量测试信号优先判定
    process.argv = ["node", "app.js"];
    process.env.MAGPIE_TEST = "1";
    assert.ok(
      statePath().startsWith(os.tmpdir()),
      "反证门 3.5：环境变量 MAGPIE_TEST=1 必须正确触发测试模式！"
    );
  } finally {
    // 恢复现场
    process.argv = savedArgv;
    if (savedStateDir !== undefined) process.env.MEMHUB_STATE_DIR = savedStateDir;
    if (savedMagpieTest !== undefined) process.env.MAGPIE_TEST = savedMagpieTest;
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    if (savedMemhubTest !== undefined) process.env.MEMHUB_TEST = savedMemhubTest;
  }

  console.log("  ✓ 反证门 3 全部通过：测试检测精准收敛，生产状态路径安全零回退\n");
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
    console.error("❌ test_v633_b_guard.mjs 存在 test_meta 规范违规:");
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
console.log("✅ 全部 3 大反证门与元检查自检 100% 通过！");
console.log("=================================================================");
