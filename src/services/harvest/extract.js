/**
 * 模块职责: 在线提炼模型调用 (extract_model)、结构化提炼、JSON 解析与字段归一化，以及模型连通性检测
 * 依赖: ./scaffolding.js (_diag), ./dialog-extract.js (parseExtractionJson), ./classify.js (testClassificationModel), ../../model_budget.js
 * 被依赖: src/services/harvest/harvest-pipeline.js, src/services/harvest/offline-scan.js, gateway_harvest.hooks.js, gateway_harvest.js
 */

import { _diag } from "./scaffolding.js";
import { parseExtractionJson } from "./dialog-extract.js";
import { testClassificationModel } from "./classify.js";
import {
  modelBudgetCheck,
  modelBudgetRecord,
  getInternalModelHeaders,
} from "../../../model_budget.js";

export const HARVEST_SYSTEM_PROMPT = `你是一个专业的长期记忆与踩坑经验提炼助手。从对话中严格提炼出值得跨会话持久化的重要信息。

【必须记录的内容】：
1. 长期铁律/架构原则 (principle)：用户确立的长期铁律、最高准则或核心架构原则（例如「严禁在前端代码中暴露任何密钥凭据」「单测断言失败必须立即中断流水线」）。
2. 偏好/约定 (preference)：用户表达的持久习惯、偏好风格或硬性约束（例如「统一使用 TypeScript」「不要使用 any」）。
3. 架构决策 (decision)：经确认的技术选型、组件替代、接口协议约定（例如「API 网关采用 fastify 替代 express」）。
4. 环境事实 (fact)：项目路径、可用的生效端口、确定的配置文件及生效选项、环境变量（例如「跨域必须在 config.toml 中配置 cors = true」）。
5. 真实踩坑与解法 (pitfall)：真实遇到的具体报错/异常现象，以及最终确证有效的解决办法（必须包含现象、根因、解法三要素，分别明确给出 root_cause 与 solution）。

【严禁记录的内容】：
- 闲聊、客套、问候、感谢（如「你好」「谢谢你的帮助」）。
- 宽泛的概念科普、通用语法讲解、未经运行测试的零散代码片段。
- 临时性排查提问或未验证的中间推测。
- 无复用价值的日常操作流水账。

【输出规范】：
- 若对话中没有任何值得持久化的内容，必须且仅返回空数组: []
- 若有值得记录的内容，返回合法的 JSON 数组，每个对象包含以下键：
  {
    "category": "principle" | "fact" | "preference" | "decision" | "pitfall",
    "title": "简明标题（20字以内，点明核心实体与动作）",
    "content": "核心事实、原则或踩坑详情（必须具体，包含关键参数或报错与解法）",
    "tags": "3~5个逗号分隔的同义检索词/别名/关键词（必须包含不同表述的检索同义词，如关于数据库密码必须包含：数据库,密码,凭据,db,credential,password 等，确保用户用不同同义词搜索时均可精准命中）",
    "related_entities": "逗号分隔的相关实体/技术栈/模块名（例如 Redis, Fastify, Docker；无特定实体时给空字符串 \"\"）",
    "confidence": 0.8到1.0之间的置信度数值,
    "root_cause": "技术根因（category 为 pitfall 时必填，说明引发报错的技术原因；非 pitfall 类可为空串 \"\"）",
    "solution": "已验证的解法（category 为 pitfall 时必填，说明确证有效的解决步骤；非 pitfall 类可为空串 \"\"）"
  }
- 严禁包裹 \`\`\`json 代码块，严禁输出任何 markdown 格式或额外说明文字，仅输出原始 JSON 数组。`;

export async function harvestWithOnlineModel(dialogueText, options = {}) {
  const model = String(options.extract_model || options.harvest_model || "").trim();
  if (!model || model === "off" || model === "none") {
    _diag("harvest_model_missing", "未配置提炼模型 (extract_model 为空)，跳过提炼");
    return null;
  }

  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  const timeoutMs = Number(options.harvest_timeout_ms) || 30000;
  const doFetch = options._fetch || globalThis.fetch;

  // 调用预算熔断（v6.20.0 事故修复）：超限则直接跳过提炼（返回 null = 安全跳过），
  // 不改变 fail-open 语义，只打一行诊断。
  const _hBudget = modelBudgetCheck(options);
  if (!_hBudget.allowed) {
    _diag("budget_skip_harvest", `模型调用预算超限(${_hBudget.reason}, 60s=${_hBudget.perMinute}, 累计=${_hBudget.total})，跳过本次提炼`);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = getInternalModelHeaders(apiKey);

  try {
    const url = `${baseUrl}/v1/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: HARVEST_SYSTEM_PROMPT },
        { role: "user", content: dialogueText.slice(0, 8000) },
      ],
      temperature: 0.1,
    };

    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    try { modelBudgetRecord(); } catch (_) {}

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      _diag("online_harvest_http_err", `HTTP ${res.status}: ${errText.slice(0, 100)}`);
      return null;
    }

    const json = await res.json();
    const rawContent = json?.choices?.[0]?.message?.content || "";
    const items = parseExtractionJson(rawContent);

    const memories = [];
    const pitfalls = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const title = String(item.title || "").trim();
      const content = String(item.content || "").trim();
      if (!title || !content) continue;

      const category = String(item.category || "fact").toLowerCase();
      const tags = String(item.tags || "auto-harvest").trim();
      const confidence = typeof item.confidence === "number" ? item.confidence : 0.95;
      const minConf = Number(options.min_confidence ?? options.minConfidence ?? 0.6);
      if (confidence < minConf) continue;

      const related_entities = item.related_entities ? String(item.related_entities).trim() : "";

      if (category === "pitfall" || category === "failure" || /踩坑|报错|error|failure/i.test(category)) {
        const root_cause = item.root_cause ? String(item.root_cause).trim() : "";
        const solution = item.solution ? String(item.solution).trim() : content;
        pitfalls.push({
          title,
          content,
          symptom: item.symptom ? String(item.symptom).trim() : title,
          solution,
          root_cause,
          component: item.component || (tags.split(",")[0] || "general"),
          tags,
          related_entities,
          confidence,
          category: "pitfall",
        });
      } else {
        const VALID_CATS = ["principle", "preference", "fact", "context", "entity", "decision", "insight"];
        memories.push({
          title,
          content,
          tags,
          related_entities,
          confidence,
          category: VALID_CATS.includes(category) ? category : "fact",
        });
      }
    }

    return { memories, pitfalls, rawCount: items.length };
  } catch (err) {
    _diag("online_harvest_exception", (err && err.message) || String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function testExtractionModel(options = {}) {
  const model = String(options.extract_model || options.harvest_model || "").trim();
  if (!model) {
    return { ok: false, error: "未配置提炼模型 (extract_model 为空)" };
  }

  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  // 弃用通用 timeout_ms，采用专名；检测为手动触发，默认放宽至 30 秒 (30000ms)
  const timeoutMs = Number(options.model_check_timeout_ms || options.extract_timeout_ms) || 30000;
  const doFetch = options._fetch || globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  const url = `${baseUrl}/v1/chat/completions`;
  const headers = getInternalModelHeaders(apiKey);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: HARVEST_SYSTEM_PROMPT },
          { role: "user", content: "[user]: 这个项目统一使用 pnpm 管理依赖。\n[assistant]: 好的，已记录项目环境规范。" },
        ],
        temperature: 0.1,
        stream: false, // 显式禁用流式传输，提升响应速度并杜绝 chunk 挂起
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        ok: false,
        model,
        endpoint: "/v1/chat/completions",
        usedUrl: url,
        timeoutMs,
        latencyMs,
        status: res.status,
        error: `网关返回 HTTP ${res.status}: ${errText.slice(0, 200)} (URL: ${url}, 耗时: ${latencyMs}ms)`,
      };
    }

    const json = await res.json();
    const rawContent = json?.choices?.[0]?.message?.content || "";
    const items = parseExtractionJson(rawContent);

    return {
      ok: true,
      model,
      endpoint: "/v1/chat/completions",
      usedUrl: url,
      timeoutMs,
      latencyMs,
      itemCount: items.length,
      sampleResult: items,
      rawOutput: rawContent.slice(0, 200),
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isAborted = (err && (err.name === "AbortError" || /aborted/i.test(err.message))) || controller.signal.aborted;
    const errorType = isAborted ? (latencyMs >= timeoutMs - 500 ? "TIMEOUT" : "ABORTED") : "REQUEST_ERROR";
    const detailMsg = isAborted
      ? (latencyMs >= timeoutMs - 500
          ? `调用超时 (${latencyMs}ms > 限制 ${timeoutMs}ms)`
          : `请求被中断 (${(err && err.message) || "Aborted"}, 耗时: ${latencyMs}ms)`)
      : ((err && err.message) || String(err));

    return {
      ok: false,
      model,
      endpoint: "/v1/chat/completions",
      usedUrl: url,
      timeoutMs,
      latencyMs,
      errorType,
      error: `请求异常: ${detailMsg} (URL: ${url})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function testModelConnectivity(type = "all", options = {}) {
  const result = { at: new Date().toISOString() };
  if (type === "all" || type === "extract" || type === "extraction") {
    result.extract = await testExtractionModel(options);
  }
  if (type === "all" || type === "classify" || type === "classification") {
    result.classify = await testClassificationModel(options);
  }
  const configuredItems = [];
  if (result.extract && !result.extract.skipped) configuredItems.push(result.extract);
  if (result.classify && !result.classify.skipped) configuredItems.push(result.classify);

  if (configuredItems.length === 0) {
    result.ok = (!result.extract || result.extract.ok) && (!result.classify || result.classify.ok);
  } else {
    result.ok = configuredItems.every((item) => item.ok);
  }
  return result;
}
