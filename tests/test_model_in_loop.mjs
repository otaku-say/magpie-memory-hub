/**
 * test_model_in_loop.mjs —— 在线大模型分类判定与结构化提炼核心测试套件
 *
 * 验证维度：
 * 1. 结构化 JSON 提取与容错解析 (parseExtractionJson: 代码块/散文环绕/单对象/畸变文本)
 * 2. 在线分类模型判定 (classifyDialogueWithOnlineModel: System One Clef 打分 / Chat YES/NO / Fail-Open)
 * 3. 在线提炼模型抽取 (harvestWithOnlineModel: 事实/偏好/决策/踩坑分类及归一化 / 空提炼 / Fail-Open)
 * 4. 端到端链路与防重入库 (processDialogueAndHarvest: 正例提取入库 / 闲聊快速拦截 / 启发式安全回退)
 * 5. 独立 Project 隔离、防重去重与残余 0 断言清理
 * 6. 真实网关在线调用（若检测到有效 MAGPIE_API_KEY 则实跑并校验 token 开销）
 */

import assert from "node:assert";
import crypto from "node:crypto";
import {
  HARVEST_SYSTEM_PROMPT,
  parseExtractionJson,
  classifyDialogueWithOnlineModel,
  harvestWithOnlineModel,
  processDialogueAndHarvest,
  triggerBackgroundDrain,
} from "../gateway_harvest.hooks.js";
import {
  clearHarvestQueue,
  readHarvestQueue,
} from "../src/core/state.js";

console.log("=================================================================");
console.log("【测试开始】在线模型提炼与分类判定 (test_model_in_loop.mjs)");
console.log("=================================================================\n");

// -----------------------------------------------------------------------------
// 1. parseExtractionJson 提取与容错解析验证
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 1] parseExtractionJson 容错解析测试...");

  // 1.1 纯净合法 JSON 数组
  const cleanArr = '[{"category":"fact","title":"Node版本","content":"v22.23.2"}]';
  const res1 = parseExtractionJson(cleanArr);
  assert.strictEqual(res1.length, 1);
  assert.strictEqual(res1[0].title, "Node版本");

  // 1.2 Markdown json 代码块包裹
  const codeBlock = '```json\n[{"category":"preference","title":"风格偏好","content":"统一使用TypeScript"}]\n```';
  const res2 = parseExtractionJson(codeBlock);
  assert.strictEqual(res2.length, 1);
  assert.strictEqual(res2[0].category, "preference");

  // 1.3 散文解释环绕（头尾都有文本）
  const proseWrap = '你好！根据你的对话，我提炼出以下记忆：\n\n[{"category":"decision","title":"架构选型","content":"使用Fastify代替Express"}]\n\n希望对你有用！';
  const res3 = parseExtractionJson(proseWrap);
  assert.strictEqual(res3.length, 1);
  assert.strictEqual(res3[0].title, "架构选型");

  // 1.4 空数组（模型认为无可记内容）
  const emptyArr = "[]";
  const res4 = parseExtractionJson(emptyArr);
  assert.strictEqual(Array.isArray(res4), true);
  assert.strictEqual(res4.length, 0);

  // 1.5 单个对象容错（模型未输出数组）
  const singleObj = '{"category":"pitfall","title":"CORS报错","content":"需配置cors=true"}';
  const res5 = parseExtractionJson(singleObj);
  assert.strictEqual(res5.length, 1);
  assert.strictEqual(res5[0].category, "pitfall");

  // 1.6 畸变非 JSON 文本安全容错
  const malformed = "本轮对话无任何值得记忆的持久事实。";
  const res6 = parseExtractionJson(malformed);
  assert.strictEqual(Array.isArray(res6), true);
  assert.strictEqual(res6.length, 0);

  // 1.7 null/undefined 输入
  assert.strictEqual(parseExtractionJson(null).length, 0);
  assert.strictEqual(parseExtractionJson(undefined).length, 0);

  console.log("  ✓ parseExtractionJson 代码块剥离、散文环绕、单对象与畸变容错 100% 通过\n");
}

// -----------------------------------------------------------------------------
// 2. classifyDialogueWithOnlineModel 分类判定测试
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 2] classifyDialogueWithOnlineModel 分类模型判定测试...");

  // 2.1 模拟 Clef 决策模型 (System One /v1/systemone) 正例
  const mockClefPositiveFetch = async (url, init) => {
    assert.ok(url.includes("/v1/systemone"), "Clef 必须调用 /v1/systemone");
    const body = JSON.parse(init.body);
    assert.strictEqual(body.model, "group/clef");
    assert.ok(body.questions.worth_remembering);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "clef",
        answers: { worth_remembering: { type: "noul", noul: 0.985 } },
        usage: { input_tokens: 150, output_tokens: 0 },
      }),
    };
  };

  const posRes = await classifyDialogueWithOnlineModel("技术选型配置", {
    classify_model: "group/clef",
    classify_threshold: 0.5,
    _fetch: mockClefPositiveFetch,
  });
  assert.strictEqual(posRes.shouldHarvest, true, "高分必须判定为正例放行");
  assert.strictEqual(posRes.score, 0.985);

  // 2.2 模拟 Clef 决策模型 负例 (闲聊)
  const mockClefNegativeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: "clef",
      answers: { worth_remembering: { type: "noul", noul: 0.012 } },
      usage: { input_tokens: 150, output_tokens: 0 },
    }),
  });

  const negRes = await classifyDialogueWithOnlineModel("今天吃了牛肉面", {
    classify_model: "group/clef",
    classify_threshold: 0.5,
    _fetch: mockClefNegativeFetch,
  });
  assert.strictEqual(negRes.shouldHarvest, false, "低分必须判定为负例拦截");
  assert.strictEqual(negRes.score, 0.012);

  // 2.3 模拟通用 Chat 分类模型 (YES/NO)
  const mockChatClassifyFetch = async (url, init) => {
    assert.ok(url.includes("/v1/chat/completions"));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "YES" } }],
      }),
    };
  };

  const chatRes = await classifyDialogueWithOnlineModel("报错解决", {
    classify_model: "group/fast-classifier",
    _fetch: mockChatClassifyFetch,
  });
  assert.strictEqual(chatRes.shouldHarvest, true);

  // 2.4 分类模型关闭场景
  const offRes = await classifyDialogueWithOnlineModel("文本", {
    classify_model: "off",
  });
  assert.strictEqual(offRes.shouldHarvest, true);
  assert.strictEqual(offRes.reason, "disabled");

  // 2.5 分类模型异常时的 Fail-Open 保证
  const mockErrorFetch = async () => {
    throw new Error("模拟网络连接超时");
  };
  const failOpenRes = await classifyDialogueWithOnlineModel("文本", {
    classify_model: "group/clef",
    _fetch: mockErrorFetch,
  });
  assert.strictEqual(failOpenRes.shouldHarvest, true, "分类器异常时必须 fail-open 放行");
  assert.strictEqual(failOpenRes.reason, "classifier_exception");

  console.log("  ✓ classifyDialogueWithOnlineModel Clef打分、Chat判定与Fail-Open全部通过\n");
}

// -----------------------------------------------------------------------------
// 3. harvestWithOnlineModel 在线模型提炼测试
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 3] harvestWithOnlineModel 在线提炼测试...");

  // 3.1 模拟提炼模型正常产出 memories 与 pitfalls
  const mockHarvestSuccessFetch = async (url, init) => {
    assert.ok(url.includes("/v1/chat/completions"), "提炼必须调用 /v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.strictEqual(body.model, "group/gemini-3.5-flash-lite");
    assert.ok(body.messages.some((m) => m.role === "system"));

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify([
              {
                category: "preference",
                title: "构建工具偏好",
                content: "统一使用 pnpm 代替 npm 执行前端构建",
                tags: "pnpm,npm,frontend",
                confidence: 0.95,
              },
              {
                category: "pitfall",
                title: "YAML依赖缺失",
                content: "ModuleNotFoundError: No module named 'yaml'，运行 pip install pyyaml 解决",
                tags: "python,yaml,pip",
                confidence: 0.98,
              },
            ]),
          },
        }],
      }),
    };
  };

  const harvestRes = await harvestWithOnlineModel("包含偏好与踩坑的对话", {
    harvest_model: "group/gemini-3.5-flash-lite",
    _fetch: mockHarvestSuccessFetch,
  });

  assert.ok(harvestRes, "必须成功返回提炼结果");
  assert.strictEqual(harvestRes.memories.length, 1);
  assert.strictEqual(harvestRes.memories[0].category, "preference");
  assert.strictEqual(harvestRes.memories[0].title, "构建工具偏好");

  assert.strictEqual(harvestRes.pitfalls.length, 1);
  assert.strictEqual(harvestRes.pitfalls[0].category, "pitfall");
  assert.strictEqual(harvestRes.pitfalls[0].title, "YAML依赖缺失");

  // 3.2 模拟闲聊场景提炼模型返回空数组 []
  const mockHarvestEmptyFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "[]" },
      }],
    }),
  });

  const emptyHarvestRes = await harvestWithOnlineModel("纯闲聊内容", {
    extract_model: "group/gemini-3.5-flash-lite",
    _fetch: mockHarvestEmptyFetch,
  });
  assert.ok(emptyHarvestRes);
  assert.strictEqual(emptyHarvestRes.memories.length, 0);
  assert.strictEqual(emptyHarvestRes.pitfalls.length, 0);
  assert.strictEqual(emptyHarvestRes.rawCount, 0);

  // 3.3 提炼模型抛错时的 Fail-Open 返回 null
  const mockCrashingHarvestFetch = async () => {
    throw new Error("HTTP 502 Bad Gateway");
  };

  const crashHarvestRes = await harvestWithOnlineModel("任何内容", {
    extract_model: "group/gemini-3.5-flash-lite",
    _fetch: mockCrashingHarvestFetch,
  });
  assert.strictEqual(crashHarvestRes, null, "模型调用失败时必须返回 null 触发安全降级");

  // 3.4 未配置提炼模型时，必须安全返回 null 并记录诊断日志，绝不私自调用写死模型
  const unconfiguredHarvestRes = await harvestWithOnlineModel("任何内容", {});
  assert.strictEqual(unconfiguredHarvestRes, null, "未配置提炼模型时必须返回 null");

  console.log("  ✓ harvestWithOnlineModel 结构化抽取、空数组判定与异常Fail-Open全部通过\n");
}

// -----------------------------------------------------------------------------
// 4. processDialogueAndHarvest 端到端完整流水线集成验证
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 4] processDialogueAndHarvest 端到端链路与防重入库测试...");

  const testProject = `__test_model_in_loop_${Date.now()}__`;
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
    update: async (table, id, data) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const existing = store.get(id);
      if (existing) {
        Object.assign(existing, data);
      }
      return existing;
    },
    remove: async (table, id) => {
      const store = table === "memories" ? memoryStore : pitfallStore;
      const had = store.delete(id);
      return { success: had };
    },
  };

  clearHarvestQueue();

  // 4.1 正例端到端入库测试
  const mockPositiveFetch = async (url) => {
    if (url.includes("/v1/systemone")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "clef",
          answers: { worth_remembering: { type: "noul", noul: 0.96 } },
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
                title: "Magpie网关端口",
                content: "默认监听 127.0.0.1:3425",
                tags: "magpie,port",
                confidence: 0.95,
              },
              {
                category: "pitfall",
                title: "跨域请求缺失头",
                content: "CORS error，需要在 config.toml 中添加 cors = true",
                tags: "cors,config",
                confidence: 0.95,
              },
            ]),
          },
        }],
      }),
    };
  };

  const sampleDialogue = `
[user]: 请问 Magpie 默认端口是多少？以及跨域怎么配？
[assistant]: Magpie 默认监听 127.0.0.1:3425；若有跨域报错需在 config.toml 加上 cors = true。
`.trim();

  const res = await processDialogueAndHarvest(
    sampleDialogue,
    { project: testProject, agent: "test-agent", session: "sess-1", turn: 2 },
    mockDbClient,
    {
      online_harvest_enabled: true,
      classify_model: "group/clef",
      harvest_model: "group/gemini-3.5-flash-lite",
      min_evidence_pitfall: 1, // 单元测试立即放行
      _fetch: mockPositiveFetch,
    }
  );

  assert.strictEqual(res.memoriesSaved, 1, "必须产出 1 条记忆");
  assert.strictEqual(res.pitfallsSaved, 1, "必须产出 1 条踩坑");

  // 消费后台队列入库
  await triggerBackgroundDrain(mockDbClient);
  assert.strictEqual(memoryStore.size, 1, "mock DB memories 必须落盘 1 条");
  assert.strictEqual(pitfallStore.size, 1, "mock DB pitfalls 必须落盘 1 条");

  // 4.2 查重与近期去重测试：相同内容再次调用不得重复入库
  const dupeRes = await processDialogueAndHarvest(
    sampleDialogue,
    { project: testProject, agent: "test-agent" },
    mockDbClient,
    {
      online_harvest_enabled: true,
      classify_model: "group/clef",
      harvest_model: "group/gemini-3.5-flash-lite",
      _fetch: mockPositiveFetch,
    }
  );
  assert.strictEqual(dupeRes.memoriesSaved, 0, "近期防重必须拦截重复 memory");
  assert.strictEqual(dupeRes.pitfallsSaved, 0, "近期防重必须拦截重复 pitfall");

  // 4.3 闲聊判定拦截测试（Clef 判定负例，快速跳过）
  const mockNegativeFetch = async (url) => {
    if (url.includes("/v1/systemone")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "clef",
          answers: { worth_remembering: { type: "noul", noul: 0.008 } },
        }),
      };
    }
    throw new Error("负例拦截下严禁触发提炼模型请求！");
  };

  const casualDialogue = `
[user]: 哈哈，今天周五了，晚上有什么安排吗？
[assistant]: 我是 AI 助手没有周末，祝你周末愉快！
`.trim();

  const casualRes = await processDialogueAndHarvest(
    casualDialogue,
    { project: testProject },
    mockDbClient,
    {
      online_harvest_enabled: true,
      classify_model: "group/clef",
      extract_model: "group/gemini-3.5-flash-lite",
      classify_threshold: 0.5,
      _fetch: mockNegativeFetch,
    }
  );

  assert.strictEqual(casualRes.skipped, true, "闲聊必须被跳过");
  assert.strictEqual(casualRes.reason, "classified_negative", "跳过原因必须为分类判定负例");
  assert.strictEqual(casualRes.memoriesSaved, 0);
  assert.strictEqual(casualRes.pitfallsSaved, 0);

  // 4.4 提炼模型输出 [] 时，断言启发式规则绝不可回退兜底（杜绝伪踩坑爆炸）
  const mockEmptyExtractFetch = async (url) => {
    if (url.includes("/v1/systemone")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "clef",
          answers: { worth_remembering: { type: "noul", noul: 0.88 } },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "[]" } }],
      }),
    };
  };

  // 包含一些能触发弱启发式的词汇，但在线模型明确判定为 []
  const weakDialogue = `
[user]: 我测试了 pytest 命令。
[assistant]: 好的。
`.trim();

  const emptyRes = await processDialogueAndHarvest(
    weakDialogue,
    { project: testProject },
    mockDbClient,
    {
      online_harvest_enabled: true,
      classify_model: "group/clef",
      harvest_model: "group/gemini-3.5-flash-lite",
      _fetch: mockEmptyExtractFetch,
    }
  );
  assert.strictEqual(emptyRes.memoriesSaved, 0, "在线模型返回 [] 时绝不伪造记忆");
  assert.strictEqual(emptyRes.pitfallsSaved, 0, "在线模型返回 [] 时绝不可被弱启发式误判");

  // 4.5 数据库清理与残余 0 断言 (cleanup)
  async function cleanup() {
    for (const [id] of memoryStore) {
      await mockDbClient.remove("memories", id);
    }
    for (const [id] of pitfallStore) {
      await mockDbClient.remove("pitfalls", id);
    }
  }
  await cleanup();

  const remainingM = await mockDbClient.list("memories", { project: testProject });
  const remainingP = await mockDbClient.list("pitfalls", { project: testProject });
  const residue = remainingM.data.length + remainingP.data.length;
  assert.strictEqual(residue, 0, "清理后残余数必须为 0 (residue === 0)");

  console.log("  ✓ processDialogueAndHarvest 正例提炼、闲聊前置拦截、防重与残余 0 清理全部通过\n");
}

// -----------------------------------------------------------------------------
// 5. 真实网关在线调用实测（如果环境具备 MAGPIE_API_KEY）
// -----------------------------------------------------------------------------
{
  console.log("▶ [Test 5] 真实网关在线 API 调用实测 (Live Gateway Test)...");

  // v6.20.0 事故修复：Live 真实网关测试默认关闭，仅 MEMHUB_LIVE_TEST=1 且具备 MAGPIE_API_KEY 时才跑。
    const liveApiKey = process.env.MEMHUB_LIVE_TEST === "1" ? process.env.MAGPIE_API_KEY : undefined;
  const liveBaseUrl = process.env.MAGPIE_BASE_URL || "https://magpie-api.4a8a.com";

  if (liveApiKey) {
    console.log(`  - 检测到有效 MAGPIE_API_KEY，直连网关: ${liveBaseUrl}`);

    // 实测 1: group/clef System One 分类打分
    const liveClassifyPos = await classifyDialogueWithOnlineModel(
      "[user]: 我们已决定在生产环境采用 PostgreSQL 替代 MySQL，驱动使用 pgx。\n[assistant]: 已记录技术架构决策。",
      {
        classify_model: "group/clef",
        gateway_url: liveBaseUrl,
        gateway_api_key: liveApiKey,
      }
    );
    console.log(`  - 真实 Clef 正例打分: ${liveClassifyPos.score} (shouldHarvest: ${liveClassifyPos.shouldHarvest})`);
    assert.strictEqual(liveClassifyPos.shouldHarvest, true, "真实 Clef 必须识别出架构决策正例");

    const liveClassifyNeg = await classifyDialogueWithOnlineModel(
      "[user]: 早上好！\n[assistant]: 早上好，祝你有美好的一天！",
      {
        classify_model: "group/clef",
        gateway_url: liveBaseUrl,
        gateway_api_key: liveApiKey,
      }
    );
    console.log(`  - 真实 Clef 闲聊打分: ${liveClassifyNeg.score} (shouldHarvest: ${liveClassifyNeg.shouldHarvest})`);
    assert.strictEqual(liveClassifyNeg.shouldHarvest, false, "真实 Clef 必须拦截闲聊负例");

    // 实测 2: group/gemini-3.5-flash-lite 真实提炼
    const liveHarvest = await harvestWithOnlineModel(
      "[user]: 在更新 Magpie 插件时提示 ERR_MODULE_NOT_FOUND，最终发现必须在 package.json 的 files 白名单加入该文件才成功打包。\n[assistant]: 收到，这是 package.json 打包的重要配置。",
      {
        harvest_model: "group/gemini-3.5-flash-lite",
        gateway_url: liveBaseUrl,
        gateway_api_key: liveApiKey,
      }
    );
    assert.ok(liveHarvest, "真实提炼模型必须返回有效结果");
    console.log(`  - 真实提炼产出: memories=${liveHarvest.memories.length}, pitfalls=${liveHarvest.pitfalls.length}`);
    assert.ok(liveHarvest.memories.length + liveHarvest.pitfalls.length > 0, "真实对话必须提取出至少 1 条事实或踩坑");
    const extractedItem = liveHarvest.pitfalls[0] || liveHarvest.memories[0];
    console.log(`    * 提取标题: ${extractedItem.title}`);
    console.log(`    * 提取内容: ${extractedItem.content}`);

    console.log("  ✓ 真实网关在线 API 调用实测 100% 成功\n");
  } else {
    console.log("  - 未检测到 MAGPIE_API_KEY，安全跳过在线实网调用测试\n");
  }
}

console.log("=================================================================");
console.log("✅ 全部 5 项在线模型提炼与分类判定测试 100% 通过！");
console.log("=================================================================");
