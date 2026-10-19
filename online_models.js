/**
 * model_ux.js — Magpie 记忆中枢：在线模型体验增强模块
 * ==========================================================
 * 核心目标：
 * 1. 优先级 1：把「看不懂的报错」变成「人话 + 修复步骤」
 *    - 针对 NoCodeBackend / Cloudflare R2 / MCP / 网关底层的未知原始报错；
 *    - 绝不编造：内置真实已知踩坑小抄（TLS 握手、桶名下划线、模块缺失、Secret Key 失效、SQL 权限缺失等）；
 *    - 成本可控：仅在已配置在线模型且现有规则无法识别的未知错误时调用，已识别错误 0 调用；
 *    - fail-open：模型异常、超时或无法解析时原样保留现有诊断，绝不阻断正常流程。
 *
 * 2. 优先级 2：`memory_search` 自然语言查询改写与双路检索
 *    - 将口语化、问句改写为高召回率的实体关键词与标签；
 *    - 双路检索合并：原查询 + 改写查询共同打分，防范改写失真；
 *    - 成本可控：配置项 `search_rewrite` 开关控制，未配置模型时 0 请求；
 *    - fail-open：改写异常或超时时无缝回落为原查询纯词面检索。
 *
 * ⚠️ 恪守四大红线：
 *   - 显式保存路径（memory_save / pitfall_save）直达数据库，绝不接模型；
 *   - 绝不让模型执行自动删除；
 *   - 注入路径（中间件）绝不上模型；
 *   - fail-open + 成本可控。
 */

/**
 * 本插件已知踩坑小抄（Prompt 增强知识库）
 * 汇聚了团队在 NCB、Cloudflare R2 与网关对接中沉淀的真实根因与解决路径。
 */
export const KNOWN_ERRORS_CHEAT_SHEET = `
【本插件已知报错与解决小抄（严格事实，切勿编造）】：
1. 错误包含 "write EPROTO" / "sslv3 alert handshake failure" / "SSL alert number 40"：
   - 一句话结论：NoCodeBackend 远端连 Cloudflare R2 发生 TLS 握手失败。
   - 核心根因：此握手发生在远端 NoCodeBackend 与 Cloudflare 之间，与本地 Node/Docker 容器 TLS 环境完全无关（切勿在本地安装 openssl）。通常是 Cloudflare R2 API Token 被删除/轮换，或创建令牌时权限只勾选了 Object Read & Write（必须是 Admin Read & Write 才能建桶和配 CORS）。
   - 可执行步骤：① 登录 Cloudflare 控制台重新生成 R2 API Token，权限务必选择【Admin Read & Write】；② 登录 NoCodeBackend 控制台 -> 该数据库 -> R2 Storage 页面更新或重新绑定 R2 连接凭据；③ 回到本插件重新点击「挂载 R2 存储」或调用 r2_check。

2. 错误包含 "The specified bucket name is not valid." / "InvalidBucketName"：
   - 一句话结论：Cloudflare R2 存储桶名称不合法。
   - 核心根因：S3/R2 命名规范要求桶名只能由小写字母、数字和连字符(-)组成，严禁包含下划线(_)。数据库名如 41694_agent_memory 若直接作为桶名会被 Cloudflare 拒绝。
   - 可执行步骤：① 在设置页或参数中将桶名中的下划线替换为连字符（例如 41694-agent-memory）；② 在插件中重新调用 storage_setup 或挂载 R2 存储（插件内置命名转换会自动转为连字符）。

3. 错误包含 "ERR_MODULE_NOT_FOUND" / "Cannot find module"：
   - 一句话结论：Node.js/Bun 运行时未找到指定的依赖模块或文件。
   - 核心根因：package.json 的 files 打包白名单遗漏了该文件、本地未运行依赖安装，或代码中 import 相对路径拼写有误。
   - 可执行步骤：① 检查 package.json 的 files 白名单，确认所需文件已被纳入发布包；② 检查 node_modules 确认相应依赖已安装；③ 核对 import 语句中的文件名大小写与相对层级。

4. 错误包含 "Invalid secret_key" / "Invalid secret key" / "403 Forbidden"（且访问 REST 接口）：
   - 一句话结论：数据库 Secret Key 鉴权失败。
   - 核心根因：① 误将账号级 MCP Key（以 mcp_ 或 mcp_sec_ 开头）复制填入了数据库 Secret Key 一栏；② 数据库被删除重建过，NoCodeBackend 为新库生成了新密钥，而本地仍保留着旧密钥。
   - 可执行步骤：① 打开 NoCodeBackend 控制台 -> 进入目标数据库实例详情页 -> 复制专属该库的 Secret Key（注意：不是顶部 Developer 菜单里的 MCP Key）；② 填入本插件设置页「数据库 Secret Key」输入框中保存；③ 若无法找回旧密钥且库内无重要数据，可在设置页点击「一键创建」新建数据库以获得新密钥。

5. 错误包含 "You do not have access to execute SQL on this database" / "Permission denied on SQL"：
   - 一句话结论：当前 MCP Key 对目标数据库无 SQL 执行权限。
   - 核心根因：填写的 MCP Token 属于另一个 NoCodeBackend 账号，或者目标数据库归属于其它团队空间、或者数据库已被转移/删除。
   - 可执行步骤：① 登录 NoCodeBackend 控制台，确认目标数据库是否存在于当前登录账号下；② 在顶部 Developer 菜单重新复制该账号的 API Token，并更新至插件设置页的 MCP Key；③ 确认数据库名中的账号数字前缀（如 41694_）与当前账号完全一致。

6. 错误包含 "ECONNREFUSED" / "ENOTFOUND" / "ETIMEDOUT" / "fetch failed"：
   - 一句话结论：网络连接中断或远端服务不可达。
   - 核心根因：本地网络故障、DNS 解析失败，或 NoCodeBackend 远端服务器短暂不可达。
   - 可执行步骤：① 检查当前网络与 DNS 设置；② 在浏览器中尝试访问 https://app.nocodebackend.com 验证远端服务状态；③ 稍后重试操作。
`;

export const ERROR_DIAGNOSE_SYSTEM_PROMPT = `你是一个专业的云原生架构与系统故障诊断专家，专门协助排查 Magpie Memory Hub 插件（集成 NoCodeBackend、Cloudflare R2、MCP 协议与大模型网关）的运行异常。

你的核心任务：将底层原始、晦涩的系统报错，转化为开发者和终端用户能一眼看懂的「人话结论」与「可执行的处理步骤」。

【知识小抄（真实历史踩坑总结，请严格参考）】：
${KNOWN_ERRORS_CHEAT_SHEET}

【诊断纪律与红线（必须严格遵守）】：
1. 绝不编造：只依据给定的错误原文与上下文判断；若错误信息不足以确定原因，请如实说明「无法完全确定，推测可能为...」；严禁编造不存在的按钮名称、菜单路径或 CLI 命令。
2. 切中要害：一句话结论必须在 25 字以内，直指本质。
3. 原因精准：列举 2~3 个最可能的技术根因。
4. 步骤可执行：处理步骤必须具体，明确告知「去哪复制什么」「点哪个按钮」「修改哪个配置项」。
5. 输出格式：必须输出合法的 JSON 对象，严禁包裹 \`\`\`json 或 markdown 代码块，严禁输出任何额外说明文字。格式如下：
{
  "conclusion": "一句话结论（25字以内）",
  "causes": [
    "最可能的根因1",
    "可能原因2"
  ],
  "steps": [
    "① 第一步具体操作",
    "② 第二步具体操作",
    "③ 第三步具体操作"
  ]
}`;

export const QUERY_REWRITE_SYSTEM_PROMPT = `你是一个专业的长期记忆检索改写助手。用户的查询可能是口语化、问句或自然语言描述，而记忆库主要依据「标题(权重5)」「标签(权重3)」「正文(权重1)」进行关键词检索。

你的核心任务：将用户的自然语言查询改写为最适合关键词检索的高召回表达。
1. 提取核心技术实体、组件名、配置项、错误特征或架构动作（例如：CORS、跨域、config.toml、nginx、PostgreSQL、token 过期）；
2. 剥离语气助词与时态词（例如：「上次那个」「怎么解决的」「请问」「帮我查查」「之前提到的」）；
3. 补充关键近义词或英文专业术语（例如：跨域 -> CORS，重启 -> restart）；
4. 输出 2~5 个最重要的关键词，用空格分隔。
5. 严禁输出任何解释、标点符号或前缀说明，仅输出空格分隔的关键词文本。`;

/**
 * 深度清洗查询词：剥除可能附带在 query 内部的注入脚手架、记忆上下文或派发模板
 * 防止 3000+ 字符的历史上下文被重新送入改写/重排模型，杜绝 499 超时
 */
export function cleanQuery(query) {
  if (!query || typeof query !== "string") return "";
  let s = String(query).trim();
  // 剥除自身注入的持久记忆上下文
  s = s.replace(/\[Persistent Memory Context\][\s\S]*?(?=\n\n|\n\[user\]|\n用户查询|$)/gi, "");
  // 剥除自身注入的引导
  s = s.replace(/\[Memory Agent Guide[\s\S]*?(?=\n\n|\n\[user\]|\n用户查询|$)/gi, "");
  s = s.replace(/\[Memory Context\][\s\S]*?(?=\n\n|\n\[user\]|\n用户查询|$)/gi, "");
  // 剥离子代理委托脚手架
  s = s.replace(/---\s*Context from the delegating agent\s*---[\s\S]*$/gi, "");
  // 剥除常见用户前缀提示
  s = s.replace(/^\[user\]:\s*/i, "");
  s = s.replace(/^用户查询[：:]\s*/i, "");
  // 提取如果末尾带有「用户查询：xxx」的实质内容
  const m = s.match(/(?:^|\n)用户查询[：:]\s*([^\n]+)/i);
  if (m && m[1] && m[1].trim()) {
    s = m[1].trim();
  }
  return s.trim();
}


import {
  modelBudgetCheck,
  modelBudgetRecord,
  getInternalModelHeaders,
} from "./model_budget.js";

/**
 * 健壮解析 JSON 对象
 */
export function parseJsonObject(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  let s = rawText.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    const direct = JSON.parse(s);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct;
    }
  } catch (_) {}

  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = s.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_) {}
  }

  return null;
}

/**
 * 优先级 1：调用在线模型诊断未知原始报错
 *
 * 核心设计：
 * 1. 仅在已配置在线模型且传入了有效报错信息时触发；
 * 2. 必须 fail-open：若网络中断、网关报错或解析失败，直接返回 null，调用方原样保留现有诊断；
 * 3. 绝不编造：提示词注入已知错误小抄，约束输出 JSON 格式。
 */
export async function explainUnknownErrorWithModel({
  error,
  component = "general",
  database = "",
  options = {},
}) {
  const rawError = String((error && error.message) || error || "").trim();
  if (!rawError) return null;

  // 检查是否配置了在线模型（优先使用 extract_model，次选 classify_model）
  const model = String(options.extract_model || options.harvest_model || options.classify_model || "").trim();
  if (!model || model === "off" || model === "none") {
    return null;
  }

  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  const timeoutMs = Number(options.diagnose_timeout_ms) || 15000;
  const doFetch = options._fetch || globalThis.fetch;

  // 调用预算熔断（v6.20.0 事故修复）：错误诊断属于后台辅助调用，超限直接跳过。
  if (!modelBudgetCheck(options).allowed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = getInternalModelHeaders(apiKey);

  const userContent = `【排查上下文】：
- 发生组件/工具：${component}
- 关联数据库：${database || "未指定"}
- 底层原始报错：
${rawError.slice(0, 2000)}

请根据上述报错信息与上下文，给出人话结论、原因分析与具体可执行的处理步骤。`;

  try {
    const url = `${baseUrl}/v1/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: ERROR_DIAGNOSE_SYSTEM_PROMPT },
        { role: "user", content: userContent },
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
      return null;
    }

    const json = await res.json();
    const rawOutput = json?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonObject(rawOutput);

    if (!parsed || !parsed.conclusion) {
      return null;
    }

    return {
      model,
      conclusion: String(parsed.conclusion).trim(),
      causes: Array.isArray(parsed.causes) ? parsed.causes.map((c) => String(c).trim()).filter(Boolean) : [],
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((s) => String(s).trim()).filter(Boolean) : [],
    };
  } catch (_) {
    // 严格 fail-open：超时或异常时返回 null，绝不阻断
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 优先级 1 结果融合：将模型翻译出的「人话结论 + 修复步骤」融合进既有诊断结果
 *
 * @param {object} res - 既有检测工具返回的对象（含 ok, verdict, lines, diagnosis 等）
 * @param {object} aiDiag - explainUnknownErrorWithModel 返回的结构化诊断
 */
export function attachAiDiagnosis(res, aiDiag) {
  if (!res || !aiDiag || !aiDiag.conclusion) return res;

  res.ai_diagnosis = aiDiag;

  // 1. 若已有结构化 diagnosis，注入并更新标题与 actions
  if (res.diagnosis && typeof res.diagnosis === "object") {
    res.diagnosis.ai_diagnosis = aiDiag;
    if (aiDiag.conclusion) {
      res.diagnosis.human_verdict = aiDiag.conclusion;
    }
    if (Array.isArray(aiDiag.steps) && aiDiag.steps.length > 0) {
      // 保留原有 actions，优先置顶模型的针对性步骤
      res.diagnosis.actions = [...aiDiag.steps];
    }
  }

  // 2. 格式化注入 lines 数组（展示在设置页卡片与 MCP 返回中）
  if (Array.isArray(res.lines)) {
    const aiLines = [
      `【智能诊断】${aiDiag.conclusion}`,
    ];
    if (Array.isArray(aiDiag.causes) && aiDiag.causes.length > 0) {
      aiLines.push(`可能原因：${aiDiag.causes.join("；")}`);
    }
    if (Array.isArray(aiDiag.steps) && aiDiag.steps.length > 0) {
      aiLines.push("建议修复步骤：");
      for (const step of aiDiag.steps) {
        aiLines.push(`  ${step}`);
      }
    }
    // 将智能诊断追加到 lines 中
    res.lines.push(...aiLines);
  }

  return res;
}

/**
 * 优先级 2：调用在线提炼模型将自然语言查询改写为关键词
 *
 * 核心设计：
 * 1. 成本可控：默认开启，可通过 options.search_rewrite === false 显式关闭；
 * 2. 未配置 extract_model 时直接返回 null（0 网络请求，0 额外成本）；
 * 3. 严格 fail-open：模型不可用或超时（3.5s）时返回 null，调用方回落为原词检索。
 */
export async function rewriteSearchQuery({
  query,
  options = {},
}) {
  const rawQuery = cleanQuery(query);
  if (!rawQuery) return null;

  // 开关检查：允许用户在设置中关闭改写
  if (options.search_rewrite === false) {
    return null;
  }

  // 未配置提炼模型时，安全跳过改写
  const model = String(options.extract_model || options.harvest_model || "").trim();
  if (!model || model === "off" || model === "none") {
    return null;
  }

  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  const timeoutMs = Number(options.search_rewrite_timeout_ms) || 12000;
  const doFetch = options._fetch || globalThis.fetch;

  // 调用预算熔断（v6.20.0 事故修复）：搜索改写超限直接跳过，调用方回落纯词面检索。
  if (!modelBudgetCheck(options).allowed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = getInternalModelHeaders(apiKey);

  try {
    const url = `${baseUrl}/v1/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: QUERY_REWRITE_SYSTEM_PROMPT },
        { role: "user", content: `用户查询：${rawQuery}` },
      ],
      temperature: 0.1,
      max_tokens: 60,
    };

    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    try { modelBudgetRecord(); } catch (_) {}

    if (!res.ok) {
      return null;
    }

    const json = await res.json();
    let rewritten = String(json?.choices?.[0]?.message?.content || "").trim();

    // 基础清洗：去除包裹的双引号、换行、markdown 前缀
    rewritten = rewritten.replace(/^["'`]+|["'`]+$/g, "").replace(/[\r\n]+/g, " ").trim();

    if (!rewritten || rewritten.toLowerCase() === rawQuery.toLowerCase()) {
      return null;
    }

    return {
      originalQuery: rawQuery,
      rewrittenQuery: rewritten,
      model,
    };
  } catch (_) {
    // fail-open：改写失败返回 null
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 记忆全自动去重 System Prompt（单次模型调用完成判定与合并结果生成）
 */
export const AUDIT_SYSTEM_PROMPT = `你是一个专业的长期记忆中枢全自动去重专家。
你的任务是在单次调用中同时完成「判定 + 生成合并结果」，识别重复记忆与踩坑条目。

【判定规则与合并标准】：
1. 记忆查重 (memory_duplicates)：
   - 识别表达同一事实、同一偏好或同一决策的重复/变体记忆；
   - 选定一条主记录 primary_id（优先保留信息更详尽、复发频次更高或更新的记录）；
   - 列出需合并软删除的多余副本 duplicate_ids（这些副本将被软失效，主记录 recurrence 将累加）。
2. 踩坑查重 (pitfall_duplicates)：
   - 识别同一组件、相同报错现象与根因的重复踩坑记录；
   - 选定主记录 primary_id 并列出需合并的多余副本 duplicate_ids。

【输出规范】：
严格输出合法 JSON 对象，严禁包裹 markdown 代码块，格式如下：
{
  "memory_duplicates": [
    {
      "primary_id": 1,
      "duplicate_ids": [2],
      "reason": "表达相同事实"
    }
  ],
  "pitfall_duplicates": [
    {
      "primary_id": 10,
      "duplicate_ids": [11],
      "reason": "相同组件报错"
    }
  ]
}`;

/**
 * 方案 B：使用在线模型进行记忆体检与语义查重
 * - 独立模型配置：优先使用 audit_model，若留空回退到 extract_model
 * - 客户端标识：统一使用 Memory 客户端头（面板清晰可辨）
 * - 成本控制与 fail-open：模型异常或超时时无缝回退至规则判重
 */
export async function auditMemoriesWithModel({
  memories = [],
  pitfalls = [],
  options = {},
}) {
  const model = String(options.audit_model || options.extract_model || options.harvest_model || "").trim();
  if (!model || model === "off" || model === "none") {
    return null;
  }

  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  const timeoutMs = Number(options.audit_timeout_ms) || 25000;
  const doFetch = options._fetch || globalThis.fetch;

  if (!modelBudgetCheck(options).allowed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 必须使用 Memory 客户端标识（和提炼一致，面板可区分）
  const headers = getInternalModelHeaders(apiKey);

  const memSummary = memories.map((m) => ({
    id: m.id,
    category: m.category,
    title: m.title,
    content: m.content || m.full_text,
    recurrence: m.recurrence,
    tags: m.tags,
  }));

  const pitSummary = pitfalls.map((p) => ({
    id: p.id,
    component: p.component,
    symptom: p.symptom,
    root_cause: p.root_cause,
    solution: p.solution,
    recurrence: p.recurrence,
  }));

  const userContent = `【待去重记忆列表】：\n${JSON.stringify(memSummary, null, 2)}\n\n【待去重踩坑列表】：\n${JSON.stringify(pitSummary, null, 2)}\n\n请在单次调用中同时完成「判定 + 生成合并结果」，输出 memory_duplicates 与 pitfall_duplicates（严格输出合法 JSON）。`;

  try {
    const url = `${baseUrl}/v1/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: AUDIT_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    };

    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    try { modelBudgetRecord(); } catch (_) {}

    if (!res.ok) return null;

    const json = await res.json();
    const rawContent = json?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonObject(rawContent) || {};
    if (Array.isArray(parsed.duplicate_groups) && !parsed.memory_duplicates) {
      parsed.memory_duplicates = parsed.duplicate_groups;
    } else if (Array.isArray(parsed.memory_duplicates) && !parsed.duplicate_groups) {
      parsed.duplicate_groups = parsed.memory_duplicates;
    }
    return {
      modelUsed: model,
      result: parsed,
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检索增强与语义重排 System Prompt
 */
export const RERANK_SYSTEM_PROMPT = `你是一个专业的记忆中枢检索增强与语义重排专家。
智能体根据用户的问题/任务，从知识库中粗筛召回了一组候选记忆/踩坑记录。
你的任务是：根据与用户查询的「真实语义相关度」和「对解决问题的价值」，从候选列表中挑选最相关的条目并进行重排打分。

【重排要求】：
1. 深入理解用户真实意图（识别同义词、中英文术语与不同表述，例如「数据库密码」与「DB 凭据」）；
2. 过滤仅有表面字面重合但实际毫不相关的噪音项；
3. 输出每个候选的 relevance_score (0~10分，10为完全匹配并能解答，0为毫不相关) 与一句话简明理由；
4. 严格输出合法 JSON 对象，严禁包裹 markdown 代码块，格式如下：
{
  "ranked": [
    { "id": 12, "score": 9.5, "reason": "精准解答了该凭据与权限配置" }
  ]
}`;

/**
 * 检索增强：调用在线模型对粗筛召回的候选进行语义重排与挑选
 *
 * 核心设计：
 * 1. 成本可控：默认开启，可通过 options.search_rerank === false 显式关闭；
 * 2. 模型解析：优先使用 options.rerank_model，若留空回退到 extract_model / audit_model；
 * 3. 严格 fail-open：模型不可用、超时（4.5s）或预算超限时返回 null，调用方原样回落为纯词面粗排排序；
 * 4. 统一 headers：使用 Memory 客户端标识，网关清晰可辨。
 */
export async function rerankSearchResultsWithModel({
  query,
  candidates = [],
  options = {},
  maxTop = 5,
}) {
  const rawQuery = cleanQuery(query);
  if (!rawQuery || !Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  // 开关检查：允许用户在设置中关闭检索增强
  if (options.search_rerank === false) {
    return null;
  }

  // 模型解析：优先使用 audit_model，若留空回退到 extract_model（兼容 options.rerank_model）
  const model = String(options.audit_model || options.extract_model || options.rerank_model || options.harvest_model || "").trim();
  if (!model || model === "off" || model === "none") {
    return null;
  }

  const baseUrl = (options.gateway_url || options.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/+$/, "");
  const apiKey = options.gateway_api_key || options.api_key || process.env.MAGPIE_API_KEY || "";
  const timeoutMs = Number(options.rerank_timeout_ms) || 15000;
  const doFetch = options._fetch || globalThis.fetch;

  // 调用预算熔断守卫
  if (!modelBudgetCheck(options).allowed) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = getInternalModelHeaders(apiKey);

  // 提取轻量摘要（Lean Projection）：绝不把数万字全文送给重排模型
  const candidateSummaries = candidates.slice(0, 25).map((c) => {
    const title = String(c.title || (c.component ? `${c.component}: ${c.symptom}` : "")).trim();
    const tags = String(c.tags || "").trim();
    const textBody = String(c.content || c.solution || c.root_cause || "").trim();
    const summary = textBody.length > 200 ? textBody.slice(0, 200) + "..." : textBody;
    return {
      id: c.id,
      title,
      tags: tags || undefined,
      summary: summary || undefined,
    };
  });

  const userContent = `【用户查询】：\n${rawQuery}\n\n【粗筛候选列表（共 ${candidateSummaries.length} 条）】：\n${JSON.stringify(candidateSummaries, null, 2)}\n\n请针对用户查询，从上述候选中挑选最相关、最具价值的条目并重排打分（最高返回 ${maxTop} 条），输出合法 JSON。`;

  try {
    const url = `${baseUrl}/v1/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: RERANK_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    };

    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    try { modelBudgetRecord(); } catch (_) {}

    if (!res.ok) return null;

    const json = await res.json();
    const rawContent = json?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonObject(rawContent);
    if (!parsed) return null;

    let rankedList = Array.isArray(parsed.ranked)
      ? parsed.ranked
      : Array.isArray(parsed.ranked_ids)
      ? parsed.ranked_ids
      : Array.isArray(parsed.results)
      ? parsed.results
      : [];

    const validRanked = rankedList
      .filter((item) => item && item.id != null)
      .map((item) => ({
        id: Number(item.id),
        score: typeof item.score === "number" ? item.score : 5,
        reason: String(item.reason || "").trim(),
      }))
      .filter((item) => Number.isFinite(item.id) && item.score >= 2);

    if (validRanked.length === 0) return null;

    // 按得分降序排序
    validRanked.sort((a, b) => b.score - a.score);

    return {
      modelUsed: model,
      ranked: validRanked.slice(0, maxTop),
    };
  } catch (_) {
    // 严格 fail-open：模型超时或异常返回 null，调用方原样回落
    return null;
  } finally {
    clearTimeout(timer);
  }
}

