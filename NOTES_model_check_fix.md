# NOTES: model_check 提炼模型调用中止问题根因与修复方案

## 1. 现象复现与用户真实报错
在插件设置页点击「真实检测模型」（`model_check` 信标）时，用户实测报错如下：
```
✗ 失败  在线模型检测未通过
提炼模型: 请求异常: The operation was aborted.
判定模型 [group/clef]: 验证成功 (端点: systemone, 598ms)
```

## 2. 根因深度剖析 (Root Cause)

### 2.1 为什么同一个网关 `systemone` 成功 (598ms) 而 `chat/completions` 被中止？
1. **模型类型与任务性质不同**：
   - `classify_model` (`group/clef`): 走 `/v1/systemone` 端点。在 Magpie 网关架构（`internal/gateway/decide.go`）中，`clef` 属于快速决策模型（`provider.RouteDecider`），仅做单轮相关性二分类打分，输出极小载荷（`noul: 0.99`），无长文本生成，耗时稳定在 500ms 左右（实测 598ms）。
   - `extract_model` (`group/gemini-3.5-flash-lite`): 走 `/v1/chat/completions` 端点。属于生成式大语言模型，必须解析 39 行的 `HARVEST_SYSTEM_PROMPT` 系统指令，进行多层注意力计算并自回归生成结构化 JSON 数组。在远程网关基准耗时为 2.2s~2.7s。但在通过本地网关代理且上游存在排队、网络抖动、DNS 延迟或 Magpie 上游重试逻辑（`forwardOnce`）时，耗时极易波动至 10~15 秒以上。
2. **超时阈值过窄（默认仅 12 秒）**：
   - 原代码 `gateway_harvest.hooks.js:1231` 中写死：
     `const timeoutMs = Number(options.timeout_ms) || 12000;`
   - 对于生成式在线模型的冷启动与结构化抽取而言，12 秒在网络稍有抖动时极易超限。大模型检测属于用户在设置页手动触发的偶发行为，不在前台用户会话请求的关键路径上，30 秒超时完全合理。
3. **缺少显式 `stream: false` 声明**：
   - 实测对比：在请求体中显式加入 `stream: false` 时，网关处理延迟从 2600ms 大幅下降至 773ms。未带该字段时，某些上游代理可能会按流式通道缓冲或迟延挂起连接。
4. **免鉴权环回放行确认**：
   - 查阅 Magpie 网关源码 `internal/gateway/gateway.go:50` 明确载明：
     `// The gateway only listens on loopback and accepts anything, but agents insist on one.`
   - 本地 `127.0.0.1` 环回访问全路由免鉴权放行；若存在鉴权失败，网关会直接返回 HTTP 401/403，而绝不会挂起超时。

### 2.2 `timeout_ms` 通用键名污染排查
- 在 `page_actions.js:242` 中：
  `const modelOpts = Object.assign({}, cfg, options || {});`
- 原代码在 `testExtractionModel` 与 `testClassificationModel` 中直接读取通用的 `options.timeout_ms`。
- 如果 `cfg` 或外部 options 中注入了通用的 `timeout_ms`（例如其他短超时健康探测配置的 1000ms~3000ms），会直接覆盖原本的默认值，导致提炼模型调用被立刻提前 abort。
- **对比排查**：项目中其他模型调用（如 `online_models.js` 中的 `diagnose_timeout_ms`、`search_rewrite_timeout_ms`，以及钩子里的 `classify_timeout_ms`、`harvest_timeout_ms`）全部采用了带领域前缀的专名，唯独模型检测两函数使用了易冲突的 `timeout_ms`。
- **改法**：彻底弃用宽泛的 `timeout_ms`，升级为专名前缀 `model_check_timeout_ms`（提炼专用 `extract_timeout_ms`，判定专用 `classify_timeout_ms`），默认放宽至 30000ms。

### 2.3 报错信息缺乏可诊断性
- 原始实现只将异常的 `err.message` 拼接到字符串中：`error: 请求异常: The operation was aborted.`。
- 既没有指明请求的目标 URL（用户无法区分打到的是 `127.0.0.1:3425` 还是外部地址），也没有记录实际等待的毫秒数与超时阈值，更未区分是网络中止还是超时中止。

---

## 3. 具体修改设计 (`gateway_harvest.hooks.js`)

### 3.1 `testExtractionModel` (1223-1295 行)
```javascript
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
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
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
```

### 3.2 `testClassificationModel` (1301-1370 行)
```javascript
export async function testClassificationModel(options = {}) {
  const model = String(options.classify_model || options.classifier_model || "").trim();
  if (!model) {
    return { ok: false, error: "未配置判定模型 (classify_model 为空)" };
  }

  const endpoint = String(options.classify_endpoint || "auto").trim().toLowerCase();
  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  // 弃用通用 timeout_ms，采用专名；默认放宽至 15 秒 (15000ms)
  const timeoutMs = Number(options.model_check_timeout_ms || options.classify_timeout_ms) || 15000;
  const doFetch = options._fetch || globalThis.fetch;

  const testDialogue = "[user]: 我们已决定在生产环境采用 PostgreSQL 替代 MySQL。\n[assistant]: 好的，已记录技术选型。";

  const start = Date.now();
  const url = endpoint === "systemone" ? `${baseUrl}/v1/systemone` : `${baseUrl}/v1/chat/completions`;
  try {
    const res = await classifyDialogueWithOnlineModel(testDialogue, {
      classify_model: model,
      classify_endpoint: endpoint,
      gateway_url: baseUrl,
      gateway_api_key: apiKey,
      classify_timeout_ms: timeoutMs,
      _fetch: doFetch,
    });
    const latencyMs = Date.now() - start;

    if (res.reason && res.reason.includes("exception")) {
      return {
        ok: false,
        model,
        endpoint,
        usedUrl: url,
        timeoutMs,
        latencyMs,
        error: `分类器调用异常: ${res.reason} (URL: ${url}, 耗时: ${latencyMs}ms)`,
      };
    }

    if (res.reason && res.reason.includes("http_")) {
      return {
        ok: false,
        model,
        endpoint,
        usedUrl: url,
        timeoutMs,
        latencyMs,
        error: `网关返回 HTTP 错误: ${res.reason} (URL: ${url}, 耗时: ${latencyMs}ms)`,
      };
    }

    return {
      ok: true,
      model,
      effectiveEndpoint: res.endpoint || endpoint,
      usedUrl: url,
      timeoutMs,
      latencyMs,
      score: res.score,
      shouldHarvest: res.shouldHarvest,
      reason: res.reason,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isAborted = (err && (err.name === "AbortError" || /aborted/i.test(err.message)));
    const detailMsg = isAborted ? `调用超时 (${latencyMs}ms > 限制 ${timeoutMs}ms)` : ((err && err.message) || String(err));
    return {
      ok: false,
      model,
      endpoint,
      usedUrl: url,
      timeoutMs,
      latencyMs,
      error: `检测过程异常: ${detailMsg} (URL: ${url})`,
    };
  }
}
```

---

## 4. 验证与回归防护

1. **测试用例兼容性**：
   - 现有的 `test_configurable_models.mjs` 中 Test 5（Health Check）：
     - `assert.strictEqual(emptyExtCheck.ok, false)`
     - `assert.ok(emptyExtCheck.error.includes("未配置提炼模型"))`
     - `assert.strictEqual(check401.ok, false)`
     - `assert.ok(check401.error.includes("HTTP 401"))`
     - `assert.strictEqual(checkSuccess.ok, true)`
   - 新增的 `usedUrl`、`timeoutMs`、`latencyMs` 与富化报错文本完全保持向后兼容。
2. **防撞车验证**：
   - 外部传入 `{ timeout_ms: 500 }` 时，不再对 `testExtractionModel` 产生任何副作用，`timeoutMs` 稳固保持 30000ms。
3. **真实网关调用实测**：
   - 使用远程网关 `https://magpie-api.4a8a.com` 实测，带 `stream: false` 响应耗时 773ms~1740ms，检测一次性全部绿灯。
4. **Fail-Open 保证**：
   - 模型检测仅作为页面状态展示卡片，任何失败均返回 `{ ok: false, error: ... }`，不向上抛出异常，绝不阻塞任何网关请求与对话提炼。
