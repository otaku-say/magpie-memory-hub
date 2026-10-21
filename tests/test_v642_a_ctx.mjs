/**
 * tests/test_v642_a_ctx.mjs
 * =================================================================
 * v6.42-a ARCH-3：GatewayContext 深度接入双向反证专项测试
 *
 * 核心目标与契约守卫：
 * 1. 【ctx.report 诊断上报双向反证】
 *    - 正向：auto_harvest 开启时上报 "ready"；
 *    - 反证 1：auto_harvest 关闭时上报 "skipped"；
 *    - 反证 2：内部模型调用豁免时上报 "skipped"；
 *    - 反证 3：remote 流量未授权时上报 "skipped"；
 *    - 反证 4：ctx.report 不存在或内部抛错时 fail-open。
 *
 * 2. 【ctx.origin 隐私守卫双向反证】
 *    - 反证 1：origin === "remote" 且未配 allow_remote_harvest 时，onRequest 与 onResponse 坚决拦截，零入库；
 *    - 正向 1：origin === "remote" 且显式 allow_remote_harvest: true 时正常放行提炼；
 *    - 正向 2：origin 为 "local" / "gateway-key" / 空值时默认放行；
 *    - 反证 2：直接调用 onResponse 时的独立 remote 隐私守卫拦截。
 *
 * 3. 【ctx.cwd 与 project 推导核心契约双向反证（极关键！）】
 *    - 反证 1（核心规范）：默认不配置（undefined/null/""），绝不按 cwd 分项目，100% 保持 "global"！
 *    - 反证 2（核心规范）：显式配置 "global"，绝不按 cwd 分项目，100% 保持 "global"！
 *    - 正向 1：仅在显式配置 project: "auto" 时，才根据 cwd 自动推导末级项目名；
 *    - 正向 2：显式自定义 project 名时，100% 保持用户指定名称，绝不被 cwd 覆盖；
 *    - 反证 3：通用无区分度根目录（root, home, workspace, tmp 等）与非法目录名在 auto 模式下安全回退 "global"；
 *    - 正向 3：跨平台 Windows 反斜杠路径与反转传参容错兼容。
 *
 * 4. 【ctx.query 纯净提问兜底双向反证】
 *    - 正向：标准请求体优先提取正文 user turn，不依赖兜底；
 *    - 反证 1：空请求体/无 user 轮次时，使用 ctx.query 兜底构造用户提问；
 *    - 反证 2：两者均为空时绝不伪造虚假对话；
 *    - 正向 2：支持字符串与对象（ctx / state）形态的 query 兜底。
 *
 * 5. 【端到端数据库隔离写入与元规范门禁】
 *    - 端到端 auto 模式与 default 模式落库隔离对比；
 *    - remote 未授权零写库反证；
 *    - createTestEnv 隔离 + cleanup 清理 + totalResidue === 0 校验；
 *    - scanTestFile 静态扫描 0 违规。
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  onRequest,
  onResponse,
  buildDialogueText,
  deriveProjectFromCwd,
  deriveProject,
  processDialogueAndHarvest,
} from "../gateway_harvest.hooks.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

console.log("=================================================================");
console.log("【v6.42-a ARCH-3 GatewayContext 深度接入专项双向反证】");
console.log("=================================================================\n");

async function run() {
  const env = await createTestEnv("v642_ctx");
  console.log(`[testenv] 隔离命名空间: ${env.project}`);

  const memoryStore = new Map();
  const pitfallStore = new Map();
  let nextId = 1;

  const mockDbClient = {
    list: async (table, params = {}) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const rows = [];
      for (const row of store.values()) {
        if (params.project && row.project !== params.project) continue;
        if (params.content_fingerprint && row.content_fingerprint !== params.content_fingerprint) continue;
        rows.push({ ...row });
      }
      return { data: rows };
    },
    create: async (table, data) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const id = nextId++;
      const saved = { ...data, id };
      store.set(id, saved);
      return saved;
    },
    remove: async (table, id) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const had = store.delete(id);
      return { affectedRows: had ? 1 : 0 };
    },
    update: async (table, id, data) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const cur = store.get(id);
      if (!cur) return { affectedRows: 0 };
      const updated = { ...cur, ...data };
      store.set(id, updated);
      return { affectedRows: 1 };
    },
  };

  const mockExtraction = [
    {
      category: "fact",
      title: "Order 服务端口配置",
      content: "生产环境 Order 服务监听 9090 端口",
      tags: "order,port",
      confidence: 0.95,
    },
    {
      category: "pitfall",
      symptom: "启动死锁踩坑",
      root_cause: "未执行 migrate 命令导致锁冲突",
      solution: "部署前必须先执行 migrate 命令",
      tags: "order,migrate",
    },
  ];

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(mockExtraction) } }],
    }),
  });

  // =================================================================
  // 门禁一：ctx.report 诊断上报双向反证
  // =================================================================
  console.log("\n▶ [Test 1] ctx.report 诊断上报双向反证");
  {
    // 1.a 正向：auto_harvest 开启时上报 ready
    const readyReports = [];
    const ctxReady = {
      options: { auto_harvest: true },
      report: (code, count) => readyReports.push({ code, count }),
    };
    await onRequest({ messages: [{ role: "user", content: "hello" }] }, ctxReady);
    assert.strictEqual(readyReports.length, 1, "【正向 1.a】开启 auto_harvest 时必须调用一次 ctx.report");
    assert.strictEqual(readyReports[0].code, "ready", "【正向 1.a】开启 auto_harvest 时必须上报 ready 状态");
    assert.strictEqual(ctxReady.state.harvestRequested, true, "【正向 1.a】ctx.state.harvestRequested 必须被标记为 true");
    console.log("  ✓ 1.a 开启 auto_harvest 正常上报 ready，宿主可观测性正常激活");

    // 1.b 反证：auto_harvest 未开启时上报 skipped
    const skippedReports = [];
    const ctxSkipped = {
      options: { auto_harvest: false },
      report: (code, count) => skippedReports.push({ code, count }),
    };
    await onRequest({ messages: [{ role: "user", content: "hello" }] }, ctxSkipped);
    assert.strictEqual(skippedReports.length, 1, "【反证 1.b】未开启 auto_harvest 时必须调用 ctx.report");
    assert.strictEqual(skippedReports[0].code, "skipped", "【反证 1.b】未开启 auto_harvest 时必须上报 skipped 状态");
    assert.strictEqual(Boolean(ctxSkipped.state?.harvestRequested), false, "【反证 1.b】未开启时不激活 harvestRequested");
    console.log("  ✓ 1.b 未开启 auto_harvest 准确上报 skipped，绝无多余开销");

    // 1.c 反证：内部模型调用豁免时上报 skipped
    const internalReports = [];
    const ctxInternal = {
      options: { auto_harvest: true },
      report: (code, count) => internalReports.push({ code, count }),
    };
    const internalReqBody = {
      messages: [{ role: "system", content: "你是一个专业的长期记忆与踩坑经验提炼助手" }],
    };
    await onRequest(internalReqBody, ctxInternal);
    assert.strictEqual(internalReports.length, 1, "【反证 1.c】内部模型调用豁免时必须调用 ctx.report");
    assert.strictEqual(internalReports[0].code, "skipped", "【反证 1.c】内部模型调用豁免时必须上报 skipped");
    assert.strictEqual(ctxInternal.state.memhubInternal, true, "【反证 1.c】内部请求必须标记 memhubInternal");
    console.log("  ✓ 1.c 内部模型调用豁免上报 skipped，切断指数自激环");

    // 1.d 反证：ctx.report 不存在或内部抛错时不阻断流程 (Fail-Open)
    const ctxNoReport = {
      options: { auto_harvest: true },
    };
    const resNoReport = await onRequest({ messages: [{ role: "user", content: "hello" }] }, ctxNoReport);
    assert.strictEqual(resNoReport, undefined, "【反证 1.d】无 ctx.report 时 onRequest 正常返回 undefined");

    const ctxThrowReport = {
      options: { auto_harvest: true },
      report: () => { throw new Error("模拟宿主 report RPC 故障"); },
    };
    const resThrow = await onRequest({ messages: [{ role: "user", content: "hello" }] }, ctxThrowReport);
    assert.strictEqual(resThrow, undefined, "【反证 1.d】ctx.report 抛错时 onRequest 必须 fail-open 返回 undefined");
    console.log("  ✓ 1.d ctx.report 缺失与异常场景 fail-open 防线 100% 稳健");
  }

  // =================================================================
  // 门禁二：ctx.origin 与 Remote 隐私守卫双向反证
  // =================================================================
  console.log("\n▶ [Test 2] ctx.origin 与 Remote 隐私守卫双向反证");
  {
    // 2.a 反证：remote 来源默认未授权被拦截 (onRequest & onResponse)
    const remoteReports = [];
    const ctxRemoteDefault = {
      origin: "remote",
      options: { auto_harvest: true }, // 未配 allow_remote_harvest
      report: (code, count) => remoteReports.push({ code, count }),
    };
    await onRequest({ messages: [{ role: "user", content: "remote request" }] }, ctxRemoteDefault);
    assert.strictEqual(remoteReports.length, 1, "【反证 2.a】未授权 remote 必须触发上报");
    assert.strictEqual(remoteReports[0].code, "skipped", "【反证 2.a】未授权 remote 必须上报 skipped 隐私拦截");
    assert.strictEqual(Boolean(ctxRemoteDefault.state?.harvestRequested), false, "【反证 2.a】未授权 remote 不得激活 harvestRequested");

    // onResponse 独立守卫反证：即使绕过 onRequest，onResponse 也坚决不执行
    let remoteProcessed = false;
    const ctxRemoteResp = {
      origin: "remote",
      options: {
        auto_harvest: true,
        _force_test: true,
        _client: {
          create: async () => { remoteProcessed = true; return { id: 999 }; },
        },
        _fetch: mockFetch,
      },
      request: { messages: [{ role: "user", content: "配置 Redis 端口 6379 踩坑记录" }] },
    };
    await onResponse({ choices: [{ message: { role: "assistant", content: "Redis 端口配置建议 6379。" } }] }, ctxRemoteResp);
    assert.strictEqual(remoteProcessed, false, "【反证 2.a】未授权 remote 流量在 onResponse 中坚决禁止落库与提炼");
    console.log("  ✓ 2.a 默认隐私守卫成功拦截未授权 remote 流量（onRequest skipped + onResponse 零提炼）");

    // 2.b 正向：显式开启 allow_remote_harvest: true 时放行
    const remoteAllowedReports = [];
    const ctxRemoteAllowed = {
      origin: "remote",
      options: { auto_harvest: true, allow_remote_harvest: true },
      report: (code, count) => remoteAllowedReports.push({ code, count }),
    };
    await onRequest({ messages: [{ role: "user", content: "allowed remote" }] }, ctxRemoteAllowed);
    assert.strictEqual(remoteAllowedReports.length, 1, "【正向 2.b】开启 allow_remote_harvest 必须触发上报");
    assert.strictEqual(remoteAllowedReports[0].code, "ready", "【正向 2.b】显式授权的 remote 流量上报 ready");
    assert.strictEqual(ctxRemoteAllowed.state.harvestRequested, true, "【正向 2.b】显式授权的 remote 流量激活 harvestRequested");
    console.log("  ✓ 2.b 显式配置 allow_remote_harvest: true 正常放行 remote 流量");

    // 2.c 正向：local / gateway-key / 未传 origin 默认放行
    for (const testOrigin of ["local", "gateway-key", "", undefined]) {
      const reports = [];
      const ctxLocal = {
        origin: testOrigin,
        options: { auto_harvest: true },
        report: (code, count) => reports.push({ code, count }),
      };
      await onRequest({ messages: [{ role: "user", content: "test origin" }] }, ctxLocal);
      assert.strictEqual(reports[0]?.code, "ready", `【正向 2.c】origin='${testOrigin}' 默认属于安全本地或网关流量，必须上报 ready`);
      assert.strictEqual(ctxLocal.state.harvestRequested, true, `【正向 2.c】origin='${testOrigin}' 必须激活 harvestRequested`);
    }
    console.log("  ✓ 2.c local / gateway-key / 未传 origin 流量默认放行，符合宿主安全规范");
  }

  // =================================================================
  // 门禁三：ctx.cwd 与 project 推导核心契约双向反证（重中之重！）
  // =================================================================
  console.log("\n▶ [Test 3] ctx.cwd 与 project 推导核心契约双向反证");
  {
    const sampleCwd = "/Users/developer/repos/order-service";

    // 3.a 核心反证：默认未配置 project，绝不按 cwd 自动分项目，必须保持 "global"
    assert.strictEqual(
      deriveProjectFromCwd(sampleCwd, undefined),
      "global",
      "【核心反证 3.a】未配置 project 时传入 cwd 绝不能切分项目，必须保持 global！"
    );
    assert.strictEqual(
      deriveProjectFromCwd(sampleCwd, null),
      "global",
      "【核心反证 3.a】project 为 null 时必须保持 global！"
    );
    assert.strictEqual(
      deriveProjectFromCwd(sampleCwd, ""),
      "global",
      "【核心反证 3.a】project 为空字符串时必须保持 global！"
    );
    console.log("  ✓ 3.a 默认未配置场景：即使传入有效 cwd，也绝不自动按 cwd 分项目（100% 保持 global）");

    // 3.b 核心反证：显式配置 project: "global"，绝不按 cwd 分项目，必须保持 "global"
    assert.strictEqual(
      deriveProjectFromCwd(sampleCwd, "global"),
      "global",
      "【核心反证 3.b】显式 project==='global' 时传入 cwd 绝不能切分项目，必须保持 global！"
    );
    assert.strictEqual(
      deriveProjectFromCwd(sampleCwd, "  global  "),
      "global",
      "【核心反证 3.b】带空白的 global 必须保持 global！"
    );
    console.log("  ✓ 3.b 显式 global 场景：绝不自动按 cwd 分项目（100% 保持既有行为）");

    // 3.c 正向：仅在显式 project: "auto" 时，才根据 cwd 自动推导末级项目名
    assert.strictEqual(
      deriveProjectFromCwd(sampleCwd, "auto"),
      "order-service",
      "【正向 3.c】显式 project==='auto' 时必须推导出 order-service"
    );
    assert.strictEqual(
      deriveProjectFromCwd("/var/data/projects/billing-gateway", "auto"),
      "billing-gateway",
      "【正向 3.c】显式 project==='auto' 时必须推导出 billing-gateway"
    );
    console.log("  ✓ 3.c 显式 project==='auto' 时成功根据 cwd 末级目录推导有效项目名");

    // 3.d 正向：显式自定义项目名时保持原样，绝不被 cwd 覆盖
    assert.strictEqual(
      deriveProjectFromCwd(sampleCwd, "my-custom-project"),
      "my-custom-project",
      "【正向 3.d】显式指定项目名时必须使用指定的名称"
    );
    console.log("  ✓ 3.d 显式自定义项目名保持原样，优先级高于 cwd");

    // 3.e 边界反证：通用根目录与非法字符在 auto 模式下安全回退 global
    const genericRoots = [
      "/root", "/home", "/users", "/tmp", "/var", "/workspace",
      "/work", "/src", "/app", "/desktop", "/documents", "/downloads",
      "/home/", "/workspace///"
    ];
    for (const gRoot of genericRoots) {
      assert.strictEqual(
        deriveProjectFromCwd(gRoot, "auto"),
        "global",
        `【反证 3.e】通用根目录 '${gRoot}' 在 auto 模式下必须安全回退为 global，杜绝无意义污染`
      );
    }

    const invalidCwds = [
      "", null, undefined, 123, "/a", "/workspace/bad*proj", "/projects/invalid name"
    ];
    for (const inv of invalidCwds) {
      assert.strictEqual(
        deriveProjectFromCwd(inv, "auto"),
        "global",
        `【反证 3.e】无效 cwd '${inv}' 在 auto 模式下必须安全回退为 global`
      );
    }
    console.log("  ✓ 3.e 通用根目录与非法路径在 auto 模式下全部安全回退 global");

    // 3.f 跨平台正向：Windows 路径兼容与反转传参容错
    const winCwd = "C:\\Users\\admin\\projects\\fintech_core";
    assert.strictEqual(
      deriveProjectFromCwd(winCwd, "auto"),
      "fintech_core",
      "【跨平台正向 3.f】Windows 路径分隔符必须正确归一化推导"
    );

    // 反转传参容错兼容 deriveProject(configuredProject, cwd)
    assert.strictEqual(
      deriveProject("auto", sampleCwd),
      "order-service",
      "【容错正向 3.f】deriveProject(configuredProject, cwd) 别名调用符合预期"
    );
    assert.strictEqual(
      deriveProjectFromCwd("auto", sampleCwd),
      "order-service",
      "【容错正向 3.f】deriveProjectFromCwd 参数反转自动纠偏符合预期"
    );
    console.log("  ✓ 3.f Windows 反斜杠与参数反转兼容性验证通过");
  }

  // =================================================================
  // 门禁四：ctx.query 纯净提问兜底双向反证
  // =================================================================
  console.log("\n▶ [Test 4] ctx.query 纯净提问兜底双向反证");
  {
    const reply = { choices: [{ message: { role: "assistant", content: "通过 export PORT=8080 解决端口冲突。" } }] };

    // 4.a 正向：标准包含 user 消息的请求体优先提取 userText
    const bodyWithUser = {
      messages: [{ role: "user", content: "请问如何解决 8080 端口占用？" }],
    };
    const textStandard = buildDialogueText(bodyWithUser, reply, "这是宿主兜底 query");
    assert.ok(textStandard.includes("请问如何解决 8080 端口占用？"), "【正向 4.a】优先提取 messages 中的用户提问");
    assert.ok(!textStandard.includes("这是宿主兜底 query"), "【正向 4.a】存在真实 userText 时绝不污染兜底 query");
    console.log("  ✓ 4.a 标准请求体优先使用原始 messages 提问，不误用兜底");

    // 4.b 反证：请求体缺少 user 消息时，使用 ctx.query 兜底
    const emptyBodies = [
      null,
      {},
      { messages: [] },
      { messages: [{ role: "system", content: "You are a helpful assistant." }] },
    ];
    for (const emptyBody of emptyBodies) {
      const textFallback = buildDialogueText(emptyBody, reply, "如何配置 Nginx 反向代理？");
      assert.ok(textFallback.includes("[user]: 如何配置 Nginx 反向代理？"), "【反证 4.b】缺少 user 消息时成功使用 queryFallback 兜底");
      assert.ok(textFallback.includes("[assistant]: 通过 export PORT=8080 解决端口冲突。"), "【反证 4.b】回复内容完整拼接");
    }
    console.log("  ✓ 4.b 各种缺失 user 消息的非标/流式请求体成功使用 ctx.query 纯净提问兜底");

    // 4.c 正向：支持对象形式 queryFallback (ctx / ctx.state)
    const ctxLike = { query: "对象形式提问兜底" };
    const textObjFallback = buildDialogueText(null, reply, ctxLike);
    assert.ok(textObjFallback.includes("[user]: 对象形式提问兜底"), "【正向 4.c】支持直接传入包含 query 的 ctx 对象");

    const ctxStateLike = { state: { query: "state 状态提问兜底" } };
    const textStateFallback = buildDialogueText(null, reply, ctxStateLike);
    assert.ok(textStateFallback.includes("[user]: state 状态提问兜底"), "【正向 4.c】支持传入包含 state.query 的上下文对象");
    console.log("  ✓ 4.c ctx 与 ctx.state 对象形态的 query 兜底解析完全无误");

    // 4.d 反证：请求体与 query 均为空时，绝不伪造虚假提问
    const textNeither = buildDialogueText({}, reply, "");
    assert.ok(!textNeither.includes("[user]:"), "【反证 4.d】两者均无有效提问时绝不生成伪造的 user 轮次");
    console.log("  ✓ 4.d 空请求体且无 query 兜底时拒绝无中生有");
  }

  // =================================================================
  // 门禁五：端到端真实落库与隔离双向反证
  // =================================================================
  console.log("\n▶ [Test 5] 端到端真实落库与隔离双向反证");
  {
    // 5.a 端到端正向：auto 模式下真实数据写入 cwd 推导项目
    const autoProjectName = `${env.project}_order_svc`;
    const autoCwd = `/workspace/repos/${autoProjectName}`;
    const ctxAuto = {
      origin: "local",
      cwd: autoCwd,
      query: "部署 Order 服务的生产端口与踩坑总结",
      options: {
        auto_harvest: true,
        project: "auto", // 显式开启 auto
        extract_model: "mock-model",
        _force_test: true,
        _client: mockDbClient,
        _fetch: mockFetch,
        bounded_await: true,
      },
      request: null, // 模拟缺失 body，触发 query 兜底
      state: {},
    };

    const replyPayload = {
      choices: [{
        message: {
          role: "assistant",
          content: "记住：生产环境 Order 服务必须监听 9090 端口，且部署前需执行 migrate 命令避开死锁踩坑。",
        },
      }],
    };

    await onResponse(replyPayload, ctxAuto);

    // 验证写入的记忆 project 属于推导出的 autoProjectName
    const autoMemories = await mockDbClient.list("memories", { project: autoProjectName });
    assert.ok(autoMemories.data.length > 0, "【端到端正向 5.a】auto 模式必须成功将记忆写入推导出的项目命名空间");
    assert.strictEqual(autoMemories.data[0].project, autoProjectName, "【端到端正向 5.a】记忆 project 字段必须与 cwd 推导一致");
    console.log(`  ✓ 5.a auto 模式端到端提炼落库成功：已写入项目 ${autoProjectName} (记录数: ${autoMemories.data.length})`);

    // 5.b 端到端核心反证：默认模式（未配置 project: "auto"）传入 cwd 绝不按 cwd 分项目！
    const defaultProjName = `${env.project}_default_group`;
    const ctxDefault = {
      origin: "local",
      cwd: `/workspace/repos/should_not_use_this_cwd`,
      query: "默认配置项目的配置经验总结",
      options: {
        auto_harvest: true,
        project: defaultProjName, // 显式指定 defaultProjName（非 "auto"）
        extract_model: "mock-model",
        _force_test: true,
        _client: mockDbClient,
        _fetch: mockFetch,
        bounded_await: true,
      },
      request: null,
      state: {},
    };

    await onResponse(replyPayload, ctxDefault);

    // 验证写入的是 defaultProjName，而不是 should_not_use_this_cwd
    const defaultMemories = await mockDbClient.list("memories", { project: defaultProjName });
    const leakedCwdMemories = await mockDbClient.list("memories", { project: "should_not_use_this_cwd" });
    assert.ok(defaultMemories.data.length > 0, "【端到端反证 5.b】非 auto 模式必须将记忆写入配置的默认项目");
    assert.strictEqual(leakedCwdMemories.data.length, 0, "【端到端反证 5.b】非 auto 模式绝不能将数据写入 cwd 目录名命名空间！");
    console.log(`  ✓ 5.b 非 auto 模式端到端反证成功：写入指定项目 ${defaultProjName}，零 cwd 误切分泄漏`);
  }

  // =================================================================
  // 门禁六：清理资源与残余数断言
  // =================================================================
  console.log("\n▶ [Test 6] 命名空间清理与残余数断言");
  {
    for (const [id] of memoryStore.entries()) {
      await mockDbClient.remove("memories", id);
    }
    for (const [id] of pitfallStore.entries()) {
      await mockDbClient.remove("pitfalls", id);
    }
    const memRemain = await mockDbClient.list("memories");
    const pitRemain = await mockDbClient.list("pitfalls");
    const totalResidue = memRemain.data.length + pitRemain.data.length;
    assert.strictEqual(totalResidue, 0, `【门禁 6】测试结束残余必须为 0，实测: ${totalResidue}`);
    await env.cleanup();
    console.log("  ✓ 资源清理成功，残余数断言通过: totalResidue === 0");
  }

  // =================================================================
  // 门禁七：test_meta 元规范自检静态扫描
  // =================================================================
  console.log("\n▶ [Test 7] test_meta 规范元扫描自检");
  {
    const thisFile = fileURLToPath(import.meta.url);
    const content = fs.readFileSync(thisFile, "utf8");
    const metaRes = scanTestFile(thisFile, content);
    assert.strictEqual(
      metaRes.issues.length,
      0,
      `【门禁 7】test_meta 扫描发现违规: ${JSON.stringify(metaRes.issues)}`
    );
    console.log("  ✓ test_meta 静态扫描合规通过 (0 违规)");
  }

  console.log("\n=================================================================");
  console.log("✅ v6.42-a ARCH-3 GatewayContext 全部双向反证门禁 100% 通过！");
  console.log("=================================================================\n");
}

run().catch((err) => {
  console.error("❌ 测试执行失败:", err);
  process.exit(1);
});
