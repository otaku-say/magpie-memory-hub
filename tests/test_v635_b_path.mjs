/**
 * tests/test_v635_b_path.mjs
 *
 * v6.35 Agent B 专项反证门测试套件：
 * 1. 【反证门 1】isHomeOrRootAllowed 单元测试与边界校验
 * 2. 【反证门 2】/home 与 /root 敏感路径借道拦截反证（必须拒绝）：
 *    - /root/private_secrets/GatewayConversations
 *    - /home/otheruser）或未授权深层目录（如/private_repo/GatewayConversations
 *    - /tmp/link_to_root/private_secrets/GatewayConversations（软链接）
 *    - /root/.ssh/GatewayConversations
 * 3. 【反证门 3】合法路径白名单放行（必须放行）：
 *    - <os.homedir()>/GatewayConversations 与 ~/GatewayConversations
 *    - <os.homedir()>/.config/magpie（含子路径）
 *    - /var/minis/x/GatewayConversations
 *    - /tmp/ok/GatewayConversations
 * 4. 【反证门 4】MEMHUB_GATEWAY_CONV_DIR 双向反证：
 *    - 指向 /root/.ssh 或 /root/private_secrets 时必须拒绝
 *    - 指向 tmpdir 下普通目录时必须合法放行
 * 5. 【元检查自检】符合 test_meta 规范自检（0 规范违规，无写库泄漏）
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isHomeOrRootAllowed,
  isVarSubdomainAllowed,
  isWhitelistedGatewayDir,
  validateGatewayDir,
  resolveGatewayDir,
} from "../gateway_harvest.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【v6.35 Agent B 专项反证门测试套件：/home 与 /root 路径借道封堵】");
console.log("=================================================================\n");

// -----------------------------------------------------------------------------
// 1. 【反证门 1】isHomeOrRootAllowed 单元校验
// -----------------------------------------------------------------------------
console.log("▶ [反证门 1] isHomeOrRootAllowed 边界与归属判定反证...");
{
  // 1.1 非 /home 与 /root 域一律返回 true（交由后续规则处理）
  assert.strictEqual(
    isHomeOrRootAllowed(null),
    true,
    "反证 1.1a：null 路径默认通过"
  );
  assert.strictEqual(
    isHomeOrRootAllowed("/tmp/ok/GatewayConversations"),
    true,
    "反证 1.1b：/tmp 路径不受 home/root 规则限制"
  );
  assert.strictEqual(
    isHomeOrRootAllowed("/var/minis/x/GatewayConversations"),
    true,
    "反证 1.1c：/var 路径不受 home/root 规则限制"
  );

  // 1.2 /home 与 /root 自身必须拒绝
  assert.strictEqual(
    isHomeOrRootAllowed("/root"),
    false,
    "反证 1.2a：/root 根自身必须拒绝"
  );
  assert.strictEqual(
    isHomeOrRootAllowed("/home"),
    false,
    "反证 1.2b：/home 根自身必须拒绝"
  );

  // 1.3 当前运行用户的合法子路径必须放行
  const myHome = os.homedir();
  assert.strictEqual(
    isHomeOrRootAllowed(path.join(myHome, "GatewayConversations")),
    true,
    "反证 1.3a：<os.homedir()>/GatewayConversations 必须放行"
  );
  assert.strictEqual(
    isHomeOrRootAllowed(path.join(myHome, "gateway-conversations")),
    true,
    "反证 1.3b：<os.homedir()>/gateway-conversations 必须放行"
  );
  assert.strictEqual(
    isHomeOrRootAllowed(path.join(myHome, ".config", "magpie")),
    true,
    "反证 1.3c：<os.homedir()>/.config/magpie 必须放行"
  );
  assert.strictEqual(
    isHomeOrRootAllowed(path.join(myHome, ".config", "magpie", "GatewayConversations")),
    true,
    "反证 1.3d：<os.homedir()>/.config/magpie/GatewayConversations 必须放行"
  );

  // 1.4 非当前用户或未授权深层目录必须拒绝
  assert.strictEqual(
    isHomeOrRootAllowed("/root/private_secrets/GatewayConversations"),
    false,
    "反证 1.4a：/root/private_secrets/GatewayConversations 必须拒绝"
  );
  assert.strictEqual(
    isHomeOrRootAllowed("/root/.ssh/GatewayConversations"),
    false,
    "反证 1.4b：/root/.ssh/GatewayConversations 必须拒绝"
  );
  assert.strictEqual(
    isHomeOrRootAllowed("/home/otheruser）或未授权深层目录（如/private_repo/GatewayConversations"),
    false,
    "反证 1.4c：/home/otheruser）或未授权深层目录（如/private_repo/GatewayConversations 必须拒绝"
  );

  // 1.5 模拟普通非 root 用户环境 (customHome = /home/alice)
  const mockHome = "/home/alice";
  assert.strictEqual(
    isHomeOrRootAllowed("/home/alice/GatewayConversations", mockHome),
    true,
    "反证 1.5a：alice home 下直接子目录 GatewayConversations 放行"
  );
  assert.strictEqual(
    isHomeOrRootAllowed("/home/alice/.config/magpie/chats", mockHome),
    true,
    "反证 1.5b：alice home 下 .config/magpie 子路径放行"
  );
  assert.strictEqual(
    isHomeOrRootAllowed("/home/alice/private_secrets/GatewayConversations", mockHome),
    false,
    "反证 1.5c：alice home 下深层嵌套目录即便含 GatewayConversations 也必须拒绝"
  );
  assert.strictEqual(
    isHomeOrRootAllowed("/home/bob/GatewayConversations", mockHome),
    false,
    "反证 1.5d：其他用户 bob 的目录一律拒绝"
  );
  assert.strictEqual(
    isHomeOrRootAllowed("/root/GatewayConversations", mockHome),
    false,
    "反证 1.5e：非 root 运行时 /root 下一律拒绝"
  );

  console.log("  ✓ 反证门 1 全部通过：isHomeOrRootAllowed 归属与直接子目录边界判定精准！\n");
}

// -----------------------------------------------------------------------------
// 2. 【反证门 2】必须拒绝：恶意借道与敏感祖先软链接彻底拦截
// -----------------------------------------------------------------------------
console.log("▶ [反证门 2] 敏感路径借道 GatewayConversations 拦截反证（必须拒绝）...");
{
  const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), "test_v635_b_deny_"));

  try {
    // 2.1 /root/private_secrets/GatewayConversations 必须拒绝
    assert.strictEqual(
      isWhitelistedGatewayDir("/root/private_secrets/GatewayConversations"),
      false,
      "反证门 2.1a：isWhitelistedGatewayDir 对 /root/private_secrets/GatewayConversations 必须返回 false"
    );
    assert.throws(
      () => validateGatewayDir("/root/private_secrets/GatewayConversations"),
      /\[SECURITY_BLOCKED\]/,
      "反证门 2.1b：validateGatewayDir 对 /root/private_secrets/GatewayConversations 必须抛出 [SECURITY_BLOCKED]"
    );

    // 2.2 /home/otheruser）或未授权深层目录（如/private_repo/GatewayConversations 必须拒绝
    assert.strictEqual(
      isWhitelistedGatewayDir("/home/otheruser）或未授权深层目录（如/private_repo/GatewayConversations"),
      false,
      "反证门 2.2a：isWhitelistedGatewayDir 对 /home/otheruser）或未授权深层目录（如/private_repo/GatewayConversations 必须返回 false"
    );
    assert.throws(
      () => validateGatewayDir("/home/otheruser）或未授权深层目录（如/private_repo/GatewayConversations"),
      /\[SECURITY_BLOCKED\]/,
      "反证门 2.2b：validateGatewayDir 对 /home/otheruser）或未授权深层目录（如/private_repo/GatewayConversations 必须抛出 [SECURITY_BLOCKED]"
    );

    // 2.3 构造祖先软链指向 /root：/tmp/link_to_root/private_secrets/GatewayConversations 必须拒绝
    const symlinkToRoot = path.join(testTmp, "link_to_root");
    fs.symlinkSync("/root", symlinkToRoot);
    const evilSymlinkTarget = path.join(symlinkToRoot, "private_secrets", "GatewayConversations");

    assert.strictEqual(
      isWhitelistedGatewayDir(evilSymlinkTarget),
      false,
      "反证门 2.3a：isWhitelistedGatewayDir 对指向 /root/private_secrets 的软链必须返回 false"
    );
    assert.throws(
      () => validateGatewayDir(evilSymlinkTarget),
      /\[SECURITY_BLOCKED\]/,
      "反证门 2.3b：validateGatewayDir 对指向 /root/private_secrets 的软链必须抛出 [SECURITY_BLOCKED]"
    );

    // 2.4 /root/.ssh/GatewayConversations 必须拒绝
    assert.strictEqual(
      isWhitelistedGatewayDir("/root/.ssh/GatewayConversations"),
      false,
      "反证门 2.4a：isWhitelistedGatewayDir 对 /root/.ssh/GatewayConversations 必须返回 false"
    );
    assert.throws(
      () => validateGatewayDir("/root/.ssh/GatewayConversations"),
      /\[SECURITY_BLOCKED\]/,
      "反证门 2.4b：validateGatewayDir 对 /root/.ssh/GatewayConversations 必须抛出 [SECURITY_BLOCKED]"
    );
  } finally {
    try {
      fs.rmSync(testTmp, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }

  console.log("  ✓ 反证门 2 全部通过：/home 与 /root 敏感借道及祖先软链 100% 拦截！\n");
}

// -----------------------------------------------------------------------------
// 3. 【反证门 3】必须放行：合法白名单路径与当前用户直接子目录放行
// -----------------------------------------------------------------------------
console.log("▶ [反证门 3] 合法白名单路径双向放行反证（绝不误杀）...");
{
  const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), "test_v635_b_allow_"));

  try {
    const myHome = os.homedir();

    // 3.1 <os.homedir()>/GatewayConversations 与 ~/GatewayConversations 必须放行
    const userConvDir = path.join(myHome, "GatewayConversations");
    assert.strictEqual(
      isWhitelistedGatewayDir(userConvDir),
      true,
      "反证门 3.1a：<os.homedir()>/GatewayConversations 必须在白名单内"
    );
    assert.ok(
      validateGatewayDir(userConvDir),
      "反证门 3.1b：<os.homedir()>/GatewayConversations 必须放行"
    );
    assert.ok(
      validateGatewayDir("~/GatewayConversations"),
      "反证门 3.1c：~/GatewayConversations 展开后必须放行"
    );

    // 3.2 <os.homedir()>/.config/magpie 必须放行
    const userMagpieDir = path.join(myHome, ".config", "magpie");
    const userMagpieConvDir = path.join(userMagpieDir, "GatewayConversations");
    assert.strictEqual(
      isWhitelistedGatewayDir(userMagpieDir),
      true,
      "反证门 3.2a：<os.homedir()>/.config/magpie 必须在白名单内"
    );
    assert.ok(
      validateGatewayDir(userMagpieDir),
      "反证门 3.2b：<os.homedir()>/.config/magpie 必须放行"
    );
    assert.ok(
      validateGatewayDir(userMagpieConvDir),
      "反证门 3.2c：<os.homedir()>/.config/magpie/GatewayConversations 必须放行"
    );

    // 3.3 /var/minis/x/GatewayConversations 必须放行
    assert.strictEqual(
      isWhitelistedGatewayDir("/var/minis/x/GatewayConversations"),
      true,
      "反证门 3.3a：/var/minis/x/GatewayConversations 必须在白名单内"
    );
    assert.ok(
      validateGatewayDir("/var/minis/x/GatewayConversations"),
      "反证门 3.3b：/var/minis/x/GatewayConversations 必须放行"
    );

    // 3.4 /tmp/ok/GatewayConversations 必须放行
    const okTmpDir = path.join(testTmp, "ok", "GatewayConversations");
    fs.mkdirSync(okTmpDir, { recursive: true });
    assert.strictEqual(
      isWhitelistedGatewayDir(okTmpDir),
      true,
      "反证门 3.4a：/tmp/ok/GatewayConversations 必须在白名单内"
    );
    assert.ok(
      validateGatewayDir(okTmpDir),
      "反证门 3.4b：/tmp/ok/GatewayConversations 必须放行"
    );
  } finally {
    try {
      fs.rmSync(testTmp, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }

  console.log("  ✓ 反证门 3 全部通过：合法当前用户目录、Minis 目录与临时目录 100% 正常放行！\n");
}

// -----------------------------------------------------------------------------
// 4. 【反证门 4】MEMHUB_GATEWAY_CONV_DIR 环境变量双向校验反证
// -----------------------------------------------------------------------------
console.log("▶ [反证门 4] MEMHUB_GATEWAY_CONV_DIR 环境变量绕过封堵与双向反证...");
{
  const savedEnv = process.env.MEMHUB_GATEWAY_CONV_DIR;
  const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), "test_v635_b_env_"));

  try {
    // 4.1 指向 /root/.ssh 时必须被拒绝
    process.env.MEMHUB_GATEWAY_CONV_DIR = "/root/.ssh";
    assert.strictEqual(
      isWhitelistedGatewayDir("/root/.ssh"),
      false,
      "反证门 4.1a：MEMHUB_GATEWAY_CONV_DIR 指向 /root/.ssh 时 isWhitelistedGatewayDir 必须返回 false"
    );
    assert.throws(
      () => validateGatewayDir(process.env.MEMHUB_GATEWAY_CONV_DIR),
      /\[SECURITY_BLOCKED\]/,
      "反证门 4.1b：validateGatewayDir 传入 /root/.ssh 必须抛出 [SECURITY_BLOCKED]"
    );
    assert.throws(
      () => resolveGatewayDir(),
      /\[SECURITY_BLOCKED\]/,
      "反证门 4.1c：resolveGatewayDir 在 MEMHUB_GATEWAY_CONV_DIR=/root/.ssh 时必须抛出 [SECURITY_BLOCKED]"
    );

    // 4.2 指向 /root/private_secrets 时必须被拒绝
    process.env.MEMHUB_GATEWAY_CONV_DIR = "/root/private_secrets";
    assert.strictEqual(
      isWhitelistedGatewayDir("/root/private_secrets"),
      false,
      "反证门 4.2a：MEMHUB_GATEWAY_CONV_DIR 指向 /root/private_secrets 时必须拒绝"
    );
    assert.throws(
      () => validateGatewayDir(process.env.MEMHUB_GATEWAY_CONV_DIR),
      /\[SECURITY_BLOCKED\]/,
      "反证门 4.2b：validateGatewayDir 在 /root/private_secrets 时必须抛出 [SECURITY_BLOCKED]"
    );
    assert.throws(
      () => resolveGatewayDir(),
      /\[SECURITY_BLOCKED\]/,
      "反证门 4.2c：resolveGatewayDir 在 MEMHUB_GATEWAY_CONV_DIR=/root/private_secrets 时必须拒绝"
    );

    // 4.3 指向 tmpdir 下普通合法目录时必须放行
    const allowedTmpConvDir = path.join(testTmp, "custom_harvest_conv");
    fs.mkdirSync(allowedTmpConvDir, { recursive: true });
    process.env.MEMHUB_GATEWAY_CONV_DIR = allowedTmpConvDir;

    assert.strictEqual(
      isWhitelistedGatewayDir(allowedTmpConvDir),
      true,
      "反证门 4.3a：MEMHUB_GATEWAY_CONV_DIR 指向合法 tmpdir 时 isWhitelistedGatewayDir 必须返回 true"
    );
    const validatedResult = validateGatewayDir(allowedTmpConvDir);
    assert.strictEqual(
      validatedResult,
      allowedTmpConvDir,
      "反证门 4.3b：validateGatewayDir 对合法 tmpdir 必须正确返回路径"
    );
    const resolvedResult = resolveGatewayDir();
    assert.strictEqual(
      resolvedResult,
      allowedTmpConvDir,
      "反证门 4.3c：resolveGatewayDir 必须优先解析并返回合法 MEMHUB_GATEWAY_CONV_DIR"
    );
  } finally {
    if (savedEnv !== undefined) {
      process.env.MEMHUB_GATEWAY_CONV_DIR = savedEnv;
    } else {
      delete process.env.MEMHUB_GATEWAY_CONV_DIR;
    }
    try {
      fs.rmSync(testTmp, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }

  console.log("  ✓ 反证门 4 全部通过：MEMHUB_GATEWAY_CONV_DIR 敏感逃逸被彻底封堵，合法配置安全放行！\n");
}

// -----------------------------------------------------------------------------
// 5. 【元检查自检】test_meta 规范元检查自证
// -----------------------------------------------------------------------------
console.log("▶ [元检查自检] 对本测试文件进行 test_meta 规范合规性自检...");
{
  const thisFile = fileURLToPath(import.meta.url);
  const rawContent = fs.readFileSync(thisFile, "utf8");
  const scanRes = scanTestFile(thisFile, rawContent);

  if (scanRes.issues.length > 0) {
    console.error("❌ test_v635_b_path.mjs 存在 test_meta 规范违规:");
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
console.log("✅ 全部 4 大专项反证门与元检查自检 100% 通过！");
console.log("=================================================================");
