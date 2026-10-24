import assert from "node:assert/strict";
import {
  rerankSearchResultsWithModel,
  explainUnknownErrorWithModel,
  rewriteSearchQuery
} from "../src/integration/provider-models.js";
import { harvestWithOnlineModel } from "../src/services/harvest/extract.js";

console.log("=== 测试开始: 在线模型超时与重排优化专项测试 ===");

// 1. 验证 rerankSearchResultsWithModel
{
  console.log("\n--- 1.1 验证 rerank 载荷包含 stream: false、截断候选、清洗 Query 噪音 ---");
  let capturedPayload = null;
  let capturedSignal = null;
  const mockFetch = async (url, init) => {
    capturedPayload = JSON.parse(init.body);
    capturedSignal = init.signal;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ranked: [
                  { id: 1, score: 9.5, reason: "精确定位" }
                ]
              })
            }
          }
        ]
      })
    };
  };

  const candidates = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    title: `Candidate ${i + 1}`,
    tags: "tag1, tag2",
    content: `Detail content for candidate ${i + 1}`,
  }));

  const noisyQuery = `[Memory Agent Guide —— 排障与避坑]
- 先查避坑：检测到排障/报错场景，请先主动调用 magpie-memory-hub_pitfall_search
- 修复必存：排障解决后，结束本轮前务必调用 magpie-memory-hub_pitfall_save

【用户查询】：
499 error timeout rerank deepseek`;

  const options = {
    audit_model: "test-model",
    model_timeout_sec: 25,
    rerank_timeout_sec: 18,
    rerank_max_candidates: 6,
    _fetch: mockFetch,
  };

  const res = await rerankSearchResultsWithModel({
    model: "test-model",
    rawQuery: noisyQuery,
    candidates,
    options,
    maxTop: 5,
  });

  assert.equal(capturedPayload.stream, false, "rerank payload 必须显式声明 stream: false");
  assert.equal(capturedPayload.model, "test-model");
  
  // 检查 user prompt 中候选数量是否被截断至 rerank_max_candidates (6 条)
  const userMsg = capturedPayload.messages.find(m => m.role === "user").content;
  assert.match(userMsg, /粗筛候选列表（共 6 条）/, "候选数量必须严格截断至 6 条");
  assert.doesNotMatch(userMsg, /\[Memory Agent Guide/, "Prompt 必须剥离系统引导词");
  assert.match(userMsg, /499 error timeout rerank deepseek/, "真实用户查询必须保留");

  assert.ok(res && Array.isArray(res.ranked), "重排结果返回包含 ranked 数组的对象");
  assert.equal(res.ranked[0].id, 1);
  assert.equal(res.modelUsed, "test-model");
  console.log("PASS: 1.1 rerank 优化与流式防挂死断言全部通过");
}

// 2. 验证 fail-open 行为
{
  console.log("\n--- 1.2 验证 rerank 遇到 499 / 网络中断时 Fail-Open 平滑降级 ---");
  const failingFetch = async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };

  const candidates = [{ id: 101, title: "Candidate 101" }, { id: 102, title: "Candidate 102" }];
  const options = {
    audit_model: "test-model",
    rerank_timeout_sec: 5,
    _fetch: failingFetch,
  };

  const res = await rerankSearchResultsWithModel({
    model: "test-model",
    rawQuery: "test",
    candidates,
    options,
    maxTop: 5,
  });

  assert.equal(res, null, "底层 provider 函数发生异常时必须 fail-open 返回 null");
  console.log("PASS: 1.2 rerank fail-open 容错降级验证通过");
}

// 3. 验证 diagnoseErrorWithModel、rewriteSearchQuery、harvestWithOnlineModel
{
  console.log("\n--- 1.3 验证所有其它模型调用均携带 stream: false ---");
  
  // diagnose
  let diagPayload = null;
  await explainUnknownErrorWithModel({
    error: "Error test",
    options: {
      extract_model: "test-model",
      model_timeout_sec: 20,
      _fetch: async (_, init) => {
        diagPayload = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "建议修复" } }] }),
        };
      }
    }
  });
  assert.equal(diagPayload.stream, false, "diagnose 必须携带 stream: false");

  // rewrite
  let rewritePayload = null;
  await rewriteSearchQuery({
    query: "如何排查超时",
    options: {
      extract_model: "test-model",
      model_timeout_sec: 20,
      _fetch: async (_, init) => {
        rewritePayload = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "超时 排查 499" } }] }),
        };
      }
    }
  });
  assert.equal(rewritePayload.stream, false, "rewrite 必须携带 stream: false");

  // harvest
  let harvestPayload = null;
  await harvestWithOnlineModel("用户: 怎么配置\n助手: 修改配置即可", {
    extract_model: "test-model",
    model_timeout_sec: 35,
    _fetch: async (_, init) => {
      harvestPayload = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "[]" } }] }),
      };
    }
  });
  assert.equal(harvestPayload.stream, false, "harvest 必须携带 stream: false");

  console.log("PASS: 1.3 全模型调用 stream: false 断言全部通过");
}

console.log("\n=== 全部专项测试 100% 验证通过！===");
