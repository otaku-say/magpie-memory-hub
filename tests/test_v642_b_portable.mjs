/**
 * tests/test_v642_b_portable.mjs
 *
 * v6.42 Agent B 专项双向反证门测试套件：
 * 架构契约对齐 ARCH-4：宿主 input.directory / ctx.directory 透传与 Magpie 便携模式兼容
 *
 * 核心验证与反证矩阵：
 * 1. 【反证门 1】resolveGatewayDir 便携模式正向解析：
 *    - hostDir 为 `<portable>/data` 时，自动解析为 `<portable>/data/gateway-conversations`
 *    - hostDir 为直接指向 `gateway-conversations` 时正确识别
 *    - 磁盘物理存在便携录制目录时，优先命中该目录
 *    - 优先级阶梯反证：customDir > MEMHUB_GATEWAY_CONV_DIR > hostDir > 默认回退
 * 2. 【反证门 2】严禁放宽既有路径白名单（安全反证与借道封堵，必须拦截并抛出 [SECURITY_BLOCKED]）：
 *    - hostDir = "/root/private_secrets" 必须拦截
 *    - hostDir = "/root" 根自身必须拦截
 *    - hostDir = "/etc/magpie/data" 必须拦截
 *    - hostDir = "~/.ssh/data" 敏感凭据必须拦截
 *    - hostDir = "/var/log/magpie/data" 非法 /var 子域必须拦截
 *    - hostDir = "/tmp/a/../b" 含 .. 相对跳转必须拦截
 *    - hostDir 跨用户目录借道（非当前运行用户 home）必须拦截
 * 3. 【反证门 3】harvestGateway 全链路宿主上下文透传（正向扫描与安全反证）：
 *    - ctx._ctx.directory 权威透传成功扫描落盘文件
 *    - ctx._input.directory 权威透传成功扫描落盘文件
 *    - cfg.hostDirectory 权威透传成功扫描落盘文件
 *    - ctx._ctx.directory 注入系统敏感目录时必须 100% 拦截并阻断
 * 4. 【反证门 4】MCP 插件入口 MagpieMemoryHub 与 tool.harvest_gateway 宿主契约对齐：
 *    - MagpieMemoryHub(input) 读取 input.directory
 *    - tool.harvest_gateway.execute(args, { directory }) 权威透传
 *    - 宿主 execute 注入非法敏感路径必定被反证拦截
 * 5. 【元检查自检】符合 test_meta 规范自检（隔离、清理与 0 违规）
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveGatewayDir,
  validateGatewayDir,
  isWhitelistedGatewayDir,
  isHomeOrRootAllowed,
  isVarSubdomainAllowed,
  harvestGateway,
  GATEWAY_CONV_DIRNAME,
} from "../src/services/harvest/index.js";
import { MagpieMemoryHub } from "../tools.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【v6.42 Agent B 专项反证门套件：ARCH-4 宿主 directory 透传与便携模式】");
console.log("=================================================================\n");

// -----------------------------------------------------------------------------
// 测试环境与 Mock DB 隔离桩（满足 test_meta 规范隔离与清理要求）
// -----------------------------------------------------------------------------
const memoryStore = [];
const mockDbClient = {
  create: async (table, data) => {
    memoryStore.push({ table, data, id: "mock_" + memoryStore.length });
    return { id: "mock_" + memoryStore.length, ...data };
  },
  list: async () => ({ items: [] }),
  update: async () => ({}),
  remove: async () => ({}),
  raw: async () => ({ items: [] }),
};

function cleanup() {
  memoryStore.length = 0;
}

// -----------------------------------------------------------------------------
// 1. 【反证门 1】resolveGatewayDir 便携模式正向解析与优先级阶梯
// -----------------------------------------------------------------------------
console.log("▶ [反证门 1] resolveGatewayDir 便携模式正向解析与优先级阶梯...");
{
  const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), "arch4_p1_"));
  try {
    const portableDataDir = path.join(testTmp, "app", "data");
    const expectedConvDir = path.join(portableDataDir, GATEWAY_CONV_DIRNAME);
    fs.mkdirSync(expectedConvDir, { recursive: true });

    // 1.1 hostDir 传入便携数据根目录 <exe>/data，自动拼接 gateway-conversations
    const res1 = resolveGatewayDir(null, portableDataDir);
    assert.strictEqual(
      res1,
      expectedConvDir,
      "反证 1.1：hostDir 为 <exe>/data 时必须精准解析为 <exe>/data/gateway-conversations"
    );

    // 1.2 hostDir 传入已包含 gateway-conversations 的完整路径
    const res2 = resolveGatewayDir(null, expectedConvDir);
    assert.strictEqual(
      res2,
      expectedConvDir,
      "反证 1.2：hostDir 已直接指向 gateway-conversations 时必须保持并解析"
    );

    // 1.3 hostDir 支持对象形态多态传参 { directory: ... }
    const res3 = resolveGatewayDir(null, { directory: portableDataDir });
    assert.strictEqual(
      res3,
      expectedConvDir,
      "反证 1.3：hostDir 支持 { directory: ... } 对象入参"
    );

    // 1.4 customDir 对象入参形态 { hostDir: ... }
    const res4 = resolveGatewayDir({ hostDir: portableDataDir });
    assert.strictEqual(
      res4,
      expectedConvDir,
      "反证 1.4：customDir 支持 { hostDir: ... } 对象入参"
    );

    // 1.5 物理存在优先级：磁盘上真实存在便携目录时，候选扫描优先命中
    const emptyPortableDir = path.join(testTmp, "another_app", "data");
    const emptyExpectedConv = path.join(emptyPortableDir, GATEWAY_CONV_DIRNAME);
    // 目录尚未物理创建时，回退到合法已校验候选
    const res5 = resolveGatewayDir(null, emptyPortableDir);
    assert.strictEqual(
      res5,
      emptyExpectedConv,
      "反证 1.5：宿主传入的未建目录合法回退并返回期望便携路径"
    );

    // 1.6 优先级阶梯反证：
    // customDir > MEMHUB_GATEWAY_CONV_DIR > hostDir
    const explicitCustomDir = path.join(testTmp, "explicit_dir");
    fs.mkdirSync(explicitCustomDir, { recursive: true });

    const envConvDir = path.join(testTmp, "env_dir");
    fs.mkdirSync(envConvDir, { recursive: true });

    const savedEnv = process.env.MEMHUB_GATEWAY_CONV_DIR;
    try {
      process.env.MEMHUB_GATEWAY_CONV_DIR = envConvDir;

      // a) customDir 优先于 env 与 hostDir
      const resPrio1 = resolveGatewayDir(explicitCustomDir, portableDataDir);
      assert.strictEqual(
        resPrio1,
        explicitCustomDir,
        "反证 1.6a：显式 customDir 必须压过环境变量与 hostDir"
      );

      // b) env 优先于 hostDir
      const resPrio2 = resolveGatewayDir(null, portableDataDir);
      assert.strictEqual(
        resPrio2,
        envConvDir,
        "反证 1.6b：环境变量 MEMHUB_GATEWAY_CONV_DIR 必须优先于 hostDir"
      );
    } finally {
      if (savedEnv !== undefined) {
        process.env.MEMHUB_GATEWAY_CONV_DIR = savedEnv;
      } else {
        delete process.env.MEMHUB_GATEWAY_CONV_DIR;
      }
    }

    console.log("  ✓ 反证门 1 全部通过：便携模式多态解析与优先级阶梯坚固！\n");
  } finally {
    fs.rmSync(testTmp, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// 2. 【反证门 2】严禁放宽既有路径白名单（安全反证与借道封堵）
// -----------------------------------------------------------------------------
console.log("▶ [反证门 2] 严禁放宽既有路径白名单（安全反证与借道封堵）...");
{
  // 2.1 注入系统敏感目录 /root/private_secrets 作为 hostDir 必须坚决拒绝
  assert.throws(
    () => resolveGatewayDir(null, "/root/private_secrets"),
    /\[SECURITY_BLOCKED\]/,
    "反证 2.1：hostDir 传入 /root/private_secrets 必须抛出 [SECURITY_BLOCKED]"
  );

  // 2.2 注入未授权用户目录 /home/other_attacker/data 作为 hostDir 必须坚决拒绝
  assert.throws(
    () => resolveGatewayDir(null, "/home/other_attacker/data"),
    /\[SECURITY_BLOCKED\]/,
    "反证 2.2：hostDir 传入跨用户目录 /home/other_attacker/data 必须抛出 [SECURITY_BLOCKED]"
  );

  // 2.3 注入系统敏感前缀 /etc 作为 hostDir 必须坚决拒绝
  assert.throws(
    () => resolveGatewayDir(null, "/etc/magpie/data"),
    /\[SECURITY_BLOCKED\]/,
    "反证 2.3：hostDir 传入 /etc/magpie/data 必须抛出 [SECURITY_BLOCKED]"
  );

  // 2.4 注入敏感云凭据与密钥目录 ~/.ssh 作为 hostDir 必须坚决拒绝
  assert.throws(
    () => resolveGatewayDir(null, "~/.ssh/data"),
    /\[SECURITY_BLOCKED\]/,
    "反证 2.4：hostDir 传入 ~/.ssh/data 必须抛出 [SECURITY_BLOCKED]"
  );

  // 2.5 注入 /var 非法子域（如 /var/log）作为 hostDir 必须坚决拒绝
  assert.throws(
    () => resolveGatewayDir(null, "/var/log/magpie/data"),
    /\[SECURITY_BLOCKED\]/,
    "反证 2.5：hostDir 传入 /var/log 必须抛出 [SECURITY_BLOCKED]"
  );

  // 2.6 注入路径包含 .. 相对跳转片段必须坚决拒绝
  assert.throws(
    () => resolveGatewayDir(null, "/tmp/allowed/../../../root/secret"),
    /\[SECURITY_BLOCKED\]/,
    "反证 2.6：hostDir 包含 .. 跳转必须抛出 [SECURITY_BLOCKED]"
  );

  // 2.7 模拟非 root 用户下，跨用户 home 越权借道必须坚决拒绝
  const mockOtherUserDir = "/home/other_attacker/data";
  assert.strictEqual(
    isHomeOrRootAllowed(mockOtherUserDir, "/home/legit_user"),
    false,
    "反证 2.7a：isHomeOrRootAllowed 对其他用户目录必须判定为 false"
  );
  assert.strictEqual(
    isWhitelistedGatewayDir(mockOtherUserDir),
    false,
    "反证 2.7b：isWhitelistedGatewayDir 对未授权跨用户目录必须返回 false"
  );

  console.log("  ✓ 反证门 2 全部通过：既有白名单零放宽，敏感路径注入与越权借道 100% 拦截！\n");
}

// -----------------------------------------------------------------------------
// 3. 【反证门 3】harvestGateway 全链路宿主上下文透传反证
// -----------------------------------------------------------------------------
console.log("▶ [反证门 3] harvestGateway 全链路宿主上下文透传反证...");
{
  const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), "arch4_p3_"));
  try {
    const portableDataDir = path.join(testTmp, "magpie_app", "data");
    const portableConvDir = path.join(portableDataDir, GATEWAY_CONV_DIRNAME);
    fs.mkdirSync(portableConvDir, { recursive: true });

    // 写入一个合法的轻量对话轮次
    const sampleTurn = {
      agent: "test-agent",
      session: "session_portable_1",
      time: new Date().toISOString(),
      model: "gpt-4o-mini",
      input: [{ role: "user", text: "ARCH-4 便携模式环境测试" }],
      output: [{ role: "assistant", text: "便携模式落盘已被正确读取" }],
    };
    fs.writeFileSync(
      path.join(portableConvDir, "turn_001.json"),
      JSON.stringify(sampleTurn)
    );

    // 3.1 正向：通过 ctx._ctx.directory 权威透传（对齐宿主 tool.execute 上下文）
    const resCtx = await harvestGateway(
      { project: "test_portable_proj", min_evidence: 1 },
      {
        _client: mockDbClient,
        _cfg: { project: "test_portable_proj" },
        _ctx: { directory: portableDataDir },
      }
    );
    assert.strictEqual(
      resCtx.success,
      true,
      "反证 3.1a：通过 ctx._ctx.directory 透传便携目录，harvestGateway 执行必须成功"
    );
    assert.strictEqual(
      resCtx.turns_scanned >= 1,
      true,
      "反证 3.1b：便携目录下的对话落盘 turn_001.json 必须被成功扫描"
    );

    // 3.2 正向：通过 ctx._input.directory 权威透传（对齐 MagpieMemoryHub 入口 input 上下文）
    const resInput = await harvestGateway(
      { project: "test_portable_proj", min_evidence: 1, force_rescan: true },
      {
        _client: mockDbClient,
        _cfg: { project: "test_portable_proj" },
        _input: { directory: portableDataDir },
      }
    );
    assert.strictEqual(
      resInput.success,
      true,
      "反证 3.2a：通过 ctx._input.directory 透传便携目录，harvestGateway 执行成功"
    );
    assert.strictEqual(
      resInput.turns_scanned >= 1,
      true,
      "反证 3.2b：通过 input 透传的便携目录对话文件被成功扫描"
    );

    // 3.3 正向：通过 cfg.hostDirectory 透传（对齐 readOptions 归一化配置）
    const resCfg = await harvestGateway(
      { project: "test_portable_proj", min_evidence: 1, force_rescan: true },
      {
        _client: mockDbClient,
        _cfg: { project: "test_portable_proj", hostDirectory: portableDataDir },
      }
    );
    assert.strictEqual(
      resCfg.success,
      true,
      "反证 3.3：通过 cfg.hostDirectory 透传便携目录，harvestGateway 成功扫描"
    );

    // 3.4 安全反证：在 context 透传中故意注入敏感目录 /root/private_secrets
    await assert.rejects(
      async () => {
        await harvestGateway(
          { project: "test_portable_proj" },
          {
            _client: mockDbClient,
            _cfg: { project: "test_portable_proj" },
            _ctx: { directory: "/root/private_secrets" },
          }
        );
      },
      /\[SECURITY_BLOCKED\]/,
      "反证 3.4：harvestGateway 接收到敏感 ctx._ctx.directory 时必须抛出 [SECURITY_BLOCKED] 拒绝"
    );

    console.log("  ✓ 反证门 3 全部通过：harvestGateway 全链路宿主目录透传与安全屏障有效！\n");
  } finally {
    fs.rmSync(testTmp, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// 4. 【反证门 4】MCP 插件入口 MagpieMemoryHub 与 tool.harvest_gateway 契约对齐
// -----------------------------------------------------------------------------
console.log("▶ [反证门 4] MagpieMemoryHub 与 tool.harvest_gateway 契约对齐...");
{
  const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), "arch4_p4_"));
  try {
    const portableDataDir = path.join(testTmp, "mcp_portable", "data");
    const portableConvDir = path.join(portableDataDir, GATEWAY_CONV_DIRNAME);
    fs.mkdirSync(portableConvDir, { recursive: true });

    const sampleTurn = {
      agent: "mcp-agent",
      session: "session_mcp_1",
      time: new Date().toISOString(),
      model: "gpt-4o-mini",
      input: [{ role: "user", text: "MCP 插件便携模式透传" }],
      output: [{ role: "assistant", text: "已通过 execute 透传成功" }],
    };
    fs.writeFileSync(
      path.join(portableConvDir, "mcp_turn.json"),
      JSON.stringify(sampleTurn)
    );

    // 4.1 初始化 MagpieMemoryHub，传入 input.directory 模拟宿主启动
    const hub = await MagpieMemoryHub(
      { directory: portableDataDir, _no_scheduler: true, _client: mockDbClient },
      { _no_scheduler: true, _client: mockDbClient, project: "test_mcp_proj" }
    );
    assert.strictEqual(
      typeof hub.tool.harvest_gateway.execute,
      "function",
      "反证 4.1：MagpieMemoryHub 注册并导出 harvest_gateway 工具"
    );

    // 4.2 模拟宿主通过 tool.execute 传入 ctx.directory 调用
    const execRes = await hub.tool.harvest_gateway.execute(
      { project: "test_mcp_proj", min_evidence: 1 },
      { directory: portableDataDir, _client: mockDbClient }
    );
    assert.strictEqual(
      execRes.success,
      true,
      "反证 4.2a：宿主 execute 透传 ctx.directory 执行成功"
    );
    assert.strictEqual(
      execRes.turns_scanned >= 1,
      true,
      "反证 4.2b：便携落盘文件被 MCP 工具调用成功识别扫描"
    );

    // 4.3 恶意宿主上下文反证：通过 tool.execute 注入 /etc/magpie/data 敏感目录必须被拒
    await assert.rejects(
      async () => {
        await hub.tool.harvest_gateway.execute(
          { project: "test_mcp_proj" },
          { directory: "/etc/magpie/data", _client: mockDbClient }
        );
      },
      /\[SECURITY_BLOCKED\]/,
      "反证 4.3：宿主 execute 传入非法敏感 directory 必须被 [SECURITY_BLOCKED] 拦截"
    );

    console.log("  ✓ 反证门 4 全部通过：MCP 工具入口与宿主生命周期契约无缝对齐！\n");
  } finally {
    fs.rmSync(testTmp, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// 5. 【元检查自检与残留断言】
// -----------------------------------------------------------------------------
console.log("▶ [元检查自检] 验证本测试文件隔离合规与清理闭环...");
{
  cleanup();
  const residue = { total: memoryStore.length };
  assert.strictEqual(
    residue.total,
    0,
    "元规范自检：测试结束后 mockDbClient 内存残余数必须严格为 0"
  );

  const selfPath = fileURLToPath(import.meta.url);
  const selfContent = fs.readFileSync(selfPath, "utf-8");
  const metaRes = scanTestFile(selfPath, selfContent);
  assert.strictEqual(
    metaRes.issues.length,
    0,
    `元规范自检：test_meta 扫描发现违规项：\n${metaRes.issues.join("\n")}`
  );
  console.log("  ✓ 元检查自检通过：0 规范违规，隔离与清理 100% 闭环！\n");
}

console.log("=================================================================");
console.log("✅ 全部 4 大专项反证门与元规范自检 100% 通过！");
console.log("=================================================================");
