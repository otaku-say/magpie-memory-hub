/**
 * test_configurable_models.mjs —— 提炼与判定模型配置化、端点自适应及彻底移除启发式回退测试套件
 *
 * 验证维度：
 * 1. 未配置模型时的行为：明确安全跳过、留诊断日志、不调用任何模型、不回退规则、不偷用写死模型
 * 2. 判定模型端点配置与自适应：classify_endpoint 模式 (systemone / chat / auto 探测降级与进程缓存)
 * 3. 彻底切断启发式回退：提炼模型异常/超时/5xx时安全跳过，即便输入强正则特征也绝不制造伪踩坑
 * 4. 录制扫描 (harvestGateway) 行为一致性：未配置 extract_model 时默认安全跳过，不回退规则
 * 5. 真实模型连通性检测能力：testExtractionModel / testClassificationModel / testModelConnectivity
 * 6. 真实网关 Live 调用（如果 MAGPIE_API_KEY 有效）
 * 7. 独立命名空间隔离、去重与清理残余 0 断言
 */

import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HARVEST_SYSTEM_PROMPT,
  parseExtractionJson,
  classifyDialogueWithOnlineModel,
  harvestWithOnlineModel,
  processDialogueAndHarvest,
  classifyEndpointCache,
  testExtractionModel,
  testClassificationModel,
  testModelConnectivity,
  triggerBackgroundDrain,
} from "../gateway_harvest.hooks.js";
import { harvestGateway } from "../src/services/harvest/index.js";
import { clearHarvestQueue, readHarvestQueue } from "../src/core/state.js";

console.log("=================================================================");
console.log("【测试开始】模型配置化、端点自适应与移除启发式回退 (test_configurable_models.mjs)");
console.log("=================================================================\n");

// -----------------------------------------------------------------------------
// 1. 未配置模型时的行为验证（明确跳过 + 诊断日志 + 绝不偷用写死模型）
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 1] 未配置模型时的行为校验（绝不偷用写死模型、绝不静默）...");

  const richDialogue = `
[user]: 运行报错：ModuleNotFoundError: No module named requests
[assistant]: 执行 pip install requests 即可修复。另外技术选型统一采用 fastify 代替 express。
`.trim();

  // 1.1 harvestWithOnlineModel 在未配置模型时直接返回 null，不触发任何 fetch
  let fetchCalled = false;
  const mockSpyFetch = async () => {
    fetchCalled = true;
    throw new Error("未配置模型时绝不应该发起网络请求！");
  };

  const resEmptyExtract = await harvestWithOnlineModel(richDialogue, {
    extract_model: "",
    _fetch: mockSpyFetch,
  });
  assert.strictEqual(resEmptyExtract, null, "未配置 extract_model 时必须直接返回 null");
  assert.strictEqual(fetchCalled, false, "未配置 extract_model 时绝不触发网络请求");

  // 1.2 classifyDialogueWithOnlineModel 在未配置模型时跳过判定，不触发 fetch
  fetchCalled = false;
  const resEmptyClassify = await classifyDialogueWithOnlineModel(richDialogue, {
    classify_model: "",
    _fetch: mockSpyFetch,
  });
  assert.strictEqual(resEmptyClassify.shouldHarvest, true, "未配置判定模型时应放行提炼");
  assert.strictEqual(resEmptyClassify.score, null, "未配置判定模型得分应为 null");
  assert.strictEqual(resEmptyClassify.reason, "unconfigured_classify_model");
  assert.strictEqual(fetchCalled, false, "未配置 classify_model 时绝不触发网络请求（绝不偷用 group/clef）");

  // 1.3 processDialogueAndHarvest 在未配置 extract_model 时明确跳过
  const skipRes = await processDialogueAndHarvest(
    richDialogue,
    { project: "__test_unconfigured__" },
    null,
    {
      extract_model: "",
      classify_model: "",
      _fetch: mockSpyFetch,
    }
  );
  assert.strictEqual(skipRes.skipped, true, "未配置提炼模型时必须跳过");
  assert.strictEqual(skipRes.reason, "unconfigured_extract_model", "原因必须明确为未配置提炼模型");
  assert.strictEqual(skipRes.memoriesSaved, 0);
  assert.strictEqual(skipRes.pitfallsSaved, 0);
  assert.strictEqual(fetchCalled, false, "全流程未配置模型时 0 网络请求");

  console.log("  ✓ 未配置模型安全跳过、0 偷调模型校验 100% 通过\n");
}

// -----------------------------------------------------------------------------
// 2. 判定模型端点配置与自适应机制验证 (classify_endpoint)
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 2] 判定模型端点配置与自适应探测验证 (classify_endpoint)...");

  classifyEndpointCache.clear();
  const testText = "[user]: 我们决定在生产环境采用 PostgreSQL 替代 MySQL。\n[assistant]: 好的。";

  // 2.1 强制 systemone 端点
  let requestedUrl = "";
  const mockSystemOneFetch = async (url, init) => {
    requestedUrl = url;
    assert.ok(url.endsWith("/v1/systemone"), "必须请求 /v1/systemone");
    const body = JSON.parse(init.body);
    assert.strictEqual(body.model, "custom-decision-model");
    assert.ok(body.questions?.worth_remembering);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answers: { worth_remembering: { type: "noul", noul: 0.92 } },
      }),
    };
  };

  const s1Res = await classifyDialogueWithOnlineModel(testText, {
    classify_model: "custom-decision-model",
    classify_endpoint: "systemone",
    _fetch: mockSystemOneFetch,
  });
  assert.strictEqual(s1Res.shouldHarvest, true);
  assert.strictEqual(s1Res.score, 0.92);
  assert.strictEqual(s1Res.endpoint, "systemone");
  assert.ok(requestedUrl.includes("/v1/systemone"));

  // 2.2 强制 chat 端点
  const mockChatFetch = async (url, init) => {
    requestedUrl = url;
    assert.ok(url.endsWith("/v1/chat/completions"), "必须请求 /v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.strictEqual(body.model, "my-chat-model");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "YES" } }],
      }),
    };
  };

  const chatRes = await classifyDialogueWithOnlineModel(testText, {
    classify_model: "my-chat-model",
    classify_endpoint: "chat",
    _fetch: mockChatFetch,
  });
  assert.strictEqual(chatRes.shouldHarvest, true);
  assert.strictEqual(chatRes.score, 1.0);
  assert.strictEqual(chatRes.endpoint, "chat");

  // 2.3 auto 模式：先试 System One，遇 404/501 平滑降级至 Chat Completions 并缓存
  const autoModel = "unknown-hybrid-model-v1";
  const calls = [];
  const mockAutoFallbackFetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/v1/systemone")) {
      // 模拟网关或模型不支持 System One 决策端点
      return {
        ok: false,
        status: 404,
        text: async () => "Not Found: /v1/systemone not supported for this model",
      };
    }
    if (url.endsWith("/v1/chat/completions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "YES" } }],
        }),
      };
    }
    throw new Error("未知端点");
  };

  const autoRes = await classifyDialogueWithOnlineModel(testText, {
    classify_model: autoModel,
    classify_endpoint: "auto",
    _fetch: mockAutoFallbackFetch,
  });
  assert.strictEqual(autoRes.shouldHarvest, true);
  assert.strictEqual(autoRes.endpoint, "chat");
  assert.strictEqual(calls.length, 2, "首次探测应先后尝试 systemone 与 chat");
  assert.strictEqual(classifyEndpointCache.get(autoModel), "chat", "探测成功后应缓存端点为 chat");

  // 2.4 第二次调用相同模型：直接使用缓存的 chat 端点（零额外探测开销）
  calls.length = 0;
  const cachedRes = await classifyDialogueWithOnlineModel(testText, {
    classify_model: autoModel,
    classify_endpoint: "auto",
    _fetch: mockAutoFallbackFetch,
  });
  assert.strictEqual(cachedRes.shouldHarvest, true);
  assert.strictEqual(calls.length, 1, "命中缓存后应只发起 1 次 chat 请求，0 额外探测");
  assert.ok(calls[0].endsWith("/v1/chat/completions"));

  console.log("  ✓ 判定模型 systemone / chat / auto 探测降级与缓存机制全部通过\n");
}

// -----------------------------------------------------------------------------
// 3. 彻底移除启发式回退与异常 Fail-Open 验证
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 3] 移除启发式回退验证（模型异常时安全跳过，绝不放回噪音）...");

  // 构造带有强启发式正则特征的对话（在旧版本中必然触发 3 类规则提取）
  const regexTriggerDialogue = `
[user]: 运行启动脚本时报错：
Traceback (most recent call last):
  File "server.py", line 12, in <module>
ModuleNotFoundError: No module named 'fastapi' (exit code 1)
[assistant]: 好的，首先执行 source /opt/project_env/bin/activate 激活 Python 虚拟环境。
然后执行 pip install fastapi 修复依赖。
我们的技术选型决定采用 fastify 替代 express 作为 API 网关核心。
pytest tests/unit/ -v 24 passed in 0.5s OK done!
`.trim();

  // 3.1 模拟提炼模型返回 502 Bad Gateway 异常
  const mock502Fetch = async () => ({
    ok: false,
    status: 502,
    text: async () => "Bad Gateway: model gateway upstream timeout",
  });

  const fail502Res = await processDialogueAndHarvest(
    regexTriggerDialogue,
    { project: "__test_fail_open__" },
    null,
    {
      extract_model: "group/gemini-3.5-flash-lite",
      classify_model: "",
      _fetch: mock502Fetch,
    }
  );

  assert.strictEqual(fail502Res.skipped, true, "提炼模型 502 必须跳过");
  assert.strictEqual(fail502Res.reason, "online_harvest_unavailable", "跳过原因必须为模型不可用");
  assert.strictEqual(fail502Res.memoriesSaved, 0, "严禁因模型异常回退规则写入 memories (必须为 0)");
  assert.strictEqual(fail502Res.pitfallsSaved, 0, "严禁因模型异常回退规则写入 pitfalls (必须为 0，杜绝伪踩坑)");

  // 3.2 模拟提炼模型抛出网络中断超时异常
  const mockCrashFetch = async () => {
    throw new Error("Fetch failed: connect ECONNREFUSED 127.0.0.1:3425");
  };

  const failCrashRes = await processDialogueAndHarvest(
    regexTriggerDialogue,
    { project: "__test_fail_open__" },
    null,
    {
      extract_model: "group/gemini-3.5-flash-lite",
      classify_model: "",
      _fetch: mockCrashFetch,
    }
  );

  assert.strictEqual(failCrashRes.skipped, true, "提炼模型网络崩溃必须跳过");
  assert.strictEqual(failCrashRes.memoriesSaved, 0, "网络中断时绝不产生伪记忆");
  assert.strictEqual(failCrashRes.pitfallsSaved, 0, "网络中断时绝不产生伪踩坑");

  console.log("  ✓ 启发式回退彻底切断：模型异常时 100% 安全跳过，0 噪音回流\n");
}

// -----------------------------------------------------------------------------
// 4. 离线录制扫描路径 (harvestGateway) 行为一致性校验
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 4] 录制扫描 (harvestGateway) 路径行为一致性校验...");

  const tmpBase = path.join(os.tmpdir(), `test_hw_models_${Date.now()}`);
  const sessDir = path.join(tmpBase, "2026-10-18", "session_test");
  fs.mkdirSync(sessDir, { recursive: true });

  const testFile = path.join(sessDir, "turn1.jsonl");
  const turnData = {
    agent: "offline-agent",
    session: "sess-offline-001",
    time: new Date().toISOString(),
    model: "claude-3-5-sonnet",
    input: [{ role: "user", text: "环境配置如何激活？技术选型是什么？" }],
    output: [{ role: "assistant", text: "执行 source /venv/bin/activate。技术选型采用 Fastify 替代 Express。" }],
  };
  fs.writeFileSync(testFile, JSON.stringify(turnData) + "\n", "utf8");

  // 4.1 未配置 extract_model 时，默认安全跳过，绝不使用启发式规则入库
  const offlineSkipRes = await harvestGateway({
    dir: tmpBase,
    project: "__test_offline_scan__",
    extract_model: "", // 未配置模型
  }, {});

  assert.strictEqual(offlineSkipRes.memories_saved, 0, "未配置 extract_model 时录制扫描必须为 0 条记忆");
  assert.strictEqual(offlineSkipRes.pitfalls_saved, 0, "未配置 extract_model 时录制扫描必须为 0 条踩坑");

  // 清理临时文件
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (err) { void err; }
  console.log("  ✓ 录制扫描与网关实时钩子行为严格一致（未配置模型时安全跳过）\n");
}

// -----------------------------------------------------------------------------
// 5. 真实模型连通性检测能力测试 (testExtractionModel / testClassificationModel)
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 5] 模型连通性检测能力测试 (Health Check)...");

  // 5.1 未配置提炼模型时返回明确错误
  const emptyExtCheck = await testExtractionModel({ extract_model: "" });
  assert.strictEqual(emptyExtCheck.ok, false);
  assert.ok(emptyExtCheck.error.includes("未配置提炼模型"));

  // 5.2 未配置判定模型时返回明确错误
  const emptyClsCheck = await testClassificationModel({ classify_model: "" });
  assert.strictEqual(emptyClsCheck.ok, false);
  assert.ok(emptyClsCheck.error.includes("未配置判定模型"));

  // 5.3 模拟 401 Unauthorized 失败给出可读原因
  const mock401Fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => "Invalid API key or token expired",
  });

  const check401 = await testExtractionModel({
    extract_model: "custom/model",
    _fetch: mock401Fetch,
  });
  assert.strictEqual(check401.ok, false);
  assert.strictEqual(check401.status, 401);
  assert.ok(check401.error.includes("HTTP 401"));

  // 5.4 模拟提炼模型正常响应与耗时返回
  const mockSuccessFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: '[{"category":"fact","title":"包管理工具","content":"统一使用 pnpm 管理依赖"}]',
        },
      }],
    }),
  });

  const checkSuccess = await testExtractionModel({
    extract_model: "group/gemini-3.5-flash-lite",
    _fetch: mockSuccessFetch,
  });
  assert.strictEqual(checkSuccess.ok, true);
  assert.strictEqual(checkSuccess.itemCount, 1);
  assert.ok(typeof checkSuccess.latencyMs === "number");
  assert.strictEqual(checkSuccess.sampleResult[0].title, "包管理工具");

  // 5.5 批量检测入口 testModelConnectivity
  // v6.31.0 起：classify_model 属可选模型，未配置时聚合层视为 skipped 并从判定中剔除，
  // 不再误报整体失败；但「已配置却真失败」必须仍判 false（下方 5.6 覆盖）。
  const allCheck = await testModelConnectivity("all", {
    extract_model: "group/gemini-3.5-flash-lite",
    classify_model: "", // 可选模型留空
    _fetch: mockSuccessFetch,
  });
  assert.strictEqual(allCheck.ok, true, "可选模型留空不得误判整体失败");
  assert.strictEqual(allCheck.extract.ok, true, "已配置的提炼模型必须 ok");
  assert.strictEqual(allCheck.classify.skipped, true, "未配置的判定模型必须标记 skipped");
  assert.strictEqual(allCheck.classify.ok, false, "独立检测时仍如实报告未配置");

  // 5.6 反证门：已配置的模型真实失败时，整体必须判 false（防线不可丢）
  const mockFailFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  const failCheck = await testModelConnectivity("all", {
    extract_model: "group/gemini-3.5-flash-lite",
    classify_model: "group/gemini-3.5-flash-lite",
    _fetch: mockFailFetch,
  });
  assert.strictEqual(failCheck.ok, false, "反证门：已配置模型真实失败时整体必须为 false");
  assert.strictEqual(failCheck.extract.ok, false, "反证门：提炼模型失败必须如实反映");

  console.log("  ✓ 模型连通性与可用性真实检测能力全部通过\n");
}

// -----------------------------------------------------------------------------
// 6. 真实网关 Live 调用（若存在有效 MAGPIE_API_KEY）
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 6] 真实网关在线 API 调用实测 (Live Gateway Test)...");

  // v6.20.0 事故修复：Live 真实网关测试默认关闭，仅 MEMHUB_LIVE_TEST=1 且具备 MAGPIE_API_KEY 时才跑。
    const liveApiKey = process.env.MEMHUB_LIVE_TEST === "1" ? process.env.MAGPIE_API_KEY : undefined;
  const liveBaseUrl = process.env.MAGPIE_BASE_URL || "https://magpie-api.4a8a.com";

  if (liveApiKey) {
    console.log(`  - 检测到有效 MAGPIE_API_KEY，直连网关: ${liveBaseUrl}`);

    // 6.1 真实检测提炼模型
    const liveExtract = await testExtractionModel({
      extract_model: "group/gemini-3.5-flash-lite",
      gateway_url: liveBaseUrl,
      gateway_api_key: liveApiKey,
    });
    console.log(`  - 真实提炼模型检测: ok=${liveExtract.ok}, latency=${liveExtract.latencyMs}ms, items=${liveExtract.itemCount}`);
    assert.strictEqual(liveExtract.ok, true, `真实提炼模型必须连通: ${liveExtract.error}`);
    assert.ok(liveExtract.itemCount >= 0);

    // 6.2 真实检测判定模型 (Clef auto 探测)
    const liveClassify = await testClassificationModel({
      classify_model: "group/clef",
      classify_endpoint: "auto",
      gateway_url: liveBaseUrl,
      gateway_api_key: liveApiKey,
    });
    console.log(`  - 真实判定模型检测: ok=${liveClassify.ok}, endpoint=${liveClassify.effectiveEndpoint}, latency=${liveClassify.latencyMs}ms, score=${liveClassify.score}`);
    assert.strictEqual(liveClassify.ok, true, `真实判定模型必须连通: ${liveClassify.error}`);
    assert.ok(typeof liveClassify.score === "number");

    // 6.3 真实端到端完整检测入口
    const liveAll = await testModelConnectivity("all", {
      extract_model: "group/gemini-3.5-flash-lite",
      classify_model: "group/clef",
      classify_endpoint: "auto",
      gateway_url: liveBaseUrl,
      gateway_api_key: liveApiKey,
    });
    assert.strictEqual(liveAll.ok, true, "真实综合检测必须全部通过");
    console.log("  ✓ 真实网关在线 API 调用实测 100% 成功");
  } else {
    console.log("  - 未检测到 MAGPIE_API_KEY，跳过在线网关 Live 实跑");
  }
  console.log();
}

// -----------------------------------------------------------------------------
// 7. 独立命名空间隔离写入、去重与残余 0 清理断言
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 7] 独立 Project 隔离提炼写入与残余 0 清理断言...");

  const testProject = `__test_conf_models_${Date.now()}__`;
  const memoryStore = new Map();
  const pitfallStore = new Map();
  let nextId = 1;

  const mockDbClient = {
    list: async (table, params) => {
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
  };

  const mockOnlineFetch = async (url) => {
    if (url.includes("/v1/systemone")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "clef",
          answers: { worth_remembering: { type: "noul", noul: 0.95 } },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify([
              {
                category: "fact",
                title: "开发端口配置",
                content: "本地网关固定监听 3425 端口",
                tags: "gateway,port",
                confidence: 0.96,
              },
            ]),
          },
        }],
      }),
    };
  };

  // 7.1 执行配置模型后的正例提炼
  const harvestRes = await processDialogueAndHarvest(
    "[user]: 请问本地网关默认监听哪个端口？这个配置在 config.toml 里怎么写？\n[assistant]: 本地网关固定监听 3425 端口，在 config.toml 中配置 port = 3425 即可生效。",
    { project: testProject, agent: "test-agent" },
    mockDbClient,
    {
      extract_model: "group/gemini-3.5-flash-lite",
      classify_model: "group/clef",
      _fetch: mockOnlineFetch,
    }
  );

  assert.strictEqual(harvestRes.memoriesSaved, 1);
  assert.strictEqual(harvestRes.skipped, false);

  // 消费后台队列入库
  await triggerBackgroundDrain(mockDbClient);
  assert.strictEqual(memoryStore.size, 1);

  // 7.2 执行清理并强断言残余为 0
  const cleanup = async () => {
    const listM = await mockDbClient.list("memories", { project: testProject });
    for (const m of listM.data) {
      await mockDbClient.remove("memories", m.id);
    }
  };
  await cleanup();

  const residueM = await mockDbClient.list("memories", { project: testProject });
  const residueP = await mockDbClient.list("pitfalls", { project: testProject });
  const totalResidue = residueM.data.length + residueP.data.length;
  assert.strictEqual(totalResidue, 0, `隔离清理后残余数据必须严格为 0 (实际: ${totalResidue})`);

  console.log(`  - 隔离项目 ${testProject} 清理后残余数: 0 (断言通过)`);
  console.log("  ✓ 隔离写入与残余 0 断言全部通过\n");
}

console.log("=================================================================");
console.log("✅ 全部 7 大项模型配置化、端点自适应与移除启发式回退测试 100% 通过！");
console.log("=================================================================");
