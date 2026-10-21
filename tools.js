/**
 * tools.js — magpie-memory-hub 的 MCP 工具层（v4.0）
 * ===================================================
 * 由 Magpie 插件宿主（Bun/Node）加载：宿主 import 本文件 → 取出导出的函数 →
 * 调用它 → 读取返回的 hooks.tool。Magpie 把所有插件的工具聚合到内置 MCP：
 *     https://<magpie-gateway>/mcp/magpie/tools
 *
 * ⚠️ 只允许导出【一个】函数：宿主的 servers() 会把每个导出函数都当成插件入口。
 *    所有辅助逻辑必须是非导出函数。
 *
 * 吸收 Headroom 的设计：
 *   - 记忆分类：preference / fact / context / entity / decision / insight
 *   - 作用域分层：user / project / session / turn
 *   - 时序版本链：内容变化时 supersede 旧版，保留审计链
 *   - 提炼走「可手动填写的模型 ID」，不写死任何模型
 */

import {
  dbStatus, dbInit, dbProvision, dbReset, storageSetup, storageUpload, storageGuide, ncbCheck, RESET_CONFIRM,
} from "./db_tools.js";
import { r2Setup, r2Upload, r2List, r2Delete, r2Guide, r2Check } from "./r2.js";
import { lookupSecret, lookupDatabase, lookupRealDatabase, lookupAuditState, rememberAuditState, getAuditCursor, saveAuditCursor, clearAuditCursor } from "./local_state.js";
import { makeMcpClient } from "./mcp_client.js";
import { runPendingAction, readAction, writeCardStatus, parseDbInfo } from "./page_actions.js";
import { harvestGateway, isTestMode } from "./gateway_harvest.js";
import { triggerBackgroundDrain } from "./gateway_harvest.hooks.js";
import { rewriteSearchQuery, auditMemoriesWithModel, rerankSearchResultsWithModel } from "./online_models.js";
import { scrubSecrets } from "./scrub.js";
import {
  normalizeSemanticText,
  normalizeTags,
  semanticFingerprint,
  isSemanticallySimilar,
  findSemanticDuplicate,
  tokenize,
  overlapCoefficient,
  jaccardSimilarity,
  hasConflictingNumbers,
  termsOf,
  CJK_STOP_BIGRAMS,
} from "./semantic_dedup.js";

const NCB_BASE = "https://api.nocodebackend.com";

const CATEGORIES = ["principle", "preference", "fact", "context", "entity", "decision", "insight"];
const SCOPES = ["user", "project", "session", "turn"];
const SEVERITIES = ["low", "medium", "high", "critical"];
const FETCH_LIMIT = 200;

/**
 * 进程内近期写入指纹 → 写入时刻。
 * NoCodeBackend 的读接口有约 2 秒的写后可见延迟，光靠「先读后写」去重
 * 会让这 2 秒内的重复写入变成两条。宿主进程是长驻的，用一个【有时间窗】的
 * 表兜住这个窗口；窗口之外一律回落到数据库判重，保证计数能正常累加。
 */
const _recent = new Map();
const RECENT_WINDOW_MS = 6000;
const RECENT_CAP = 5000;

/** 按作用域给过期时间：session 7 天、turn 1 天，其余（project/user）永不过期。 */
function expiresAtFor(scope) {
  var days = scope === "turn" ? 1 : (scope === "session" ? 7 : 0);
  if (!days) return null;
  var d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function markRecent(fp) {
  if (_recent.size >= RECENT_CAP) _recent.clear();
  _recent.set(fp, Date.now());
}

/** 是否在写后读延迟窗口内刚写过 */
function justWritten(fp) {
  const t = _recent.get(fp);
  if (!t) return false;
  if (Date.now() - t > RECENT_WINDOW_MS) {
    _recent.delete(fp);
    return false;
  }
  return true;
}

/* ================================================================== *
 * 工具函数（非导出）
 * ================================================================== */

function readOptions(options) {
  const o = options && typeof options === "object" ? options : {};
  const rawInst = o.ncb_instance || lookupDatabase() || "41694_agent_memory";
  const instance = lookupRealDatabase(rawInst) || rawInst;
  return {
    // 库名：优先按用户填的并归一化解析；没填就用上次 provision 真正用到的那个
    instance,
    // Secret Key：用户在设置页填的优先；
    // 若库是本插件创建的，创建时已自动取得并保存在本地状态里，这里直接取用，
    // 于是**用户只需要填 MCP key**。
    secret: o.ncb_secret || lookupSecret(instance) || lookupSecret(rawInst) || "",
    // MCP key：仅用于建表/清库/schema/R2。数据库 Secret Key 只能读写数据。
    mcpKey: o.mcp_key || "",
    // 宿主每次加载时自愈（结构缺失就补）。默认关：避免给工具枚举引入网络等待。
    autoInit: o.auto_init === true,
    // 宿主每次加载时自动增量扫描网关录制的对话落盘。默认关：避免涉及用户隐私与启动延迟。
    autoHarvest: o.auto_harvest === true,
    gatewayConvDir: o.gateway_conv_dir || process.env.MEMHUB_GATEWAY_CONV_DIR || "",
    // R2 凭据：由设置页的「保存 R2 设置」按钮写入。
    // 挂载时会**显式传给 NCB**，否则它会用账号里缓存的旧连接（密钥轮换后必然失败）。
    r2AccountId: o.r2_account_id || "",
    r2AccessKeyId: o.r2_access_key_id || "",
    r2SecretAccessKey: o.r2_secret_access_key || "",
    r2BucketName: o.r2_bucket_name || "",
    r2PublicUrl: o.r2_public_url || "",
    minConfidence: Number(o.min_confidence) || 0.6,
    maxInject: Number(o.max_inject_count) || 5,
    maxBudget: Number(o.max_budget_chars) || 2048,
    // 在线模型配置（设置页自由指定，默认留空安全跳过；audit_model 同时服务去重与检索重排）
    extract_model: o.extract_model || o.harvest_model || "",
    classify_model: o.classify_model || "",
    audit_model: o.audit_model || o.rerank_model || "",
    dedup_schedule: o.dedup_schedule || o.audit_interval || o.auditInterval || "off",
    dedup_time: o.dedup_time || "02:00",
    dedup_weekday: Number(o.dedup_weekday) || 1,
    dedup_day: Number(o.dedup_day) || 1,
    dedup_batch_size: Math.max(20, Math.min(Number(o.dedup_batch_size || 50), 1000)),
    dedup_fetch_limit: Math.max(20, Math.min(Number((o.dedup_batch_size && Number(o.dedup_batch_size) !== 50 ? o.dedup_batch_size : (o.dedup_fetch_limit || o.dedup_batch_size || 200))), 1000)),
    project: String(o.project || "global").trim(),
    audit_chunk_size: Number(o.audit_chunk_size) > 0 ? Number(o.audit_chunk_size) : 40,
    audit_max_batches: Number(o.audit_max_batches) > 0 ? Number(o.audit_max_batches) : 1,
    rerank_model: o.rerank_model || "",
    classify_endpoint: o.classify_endpoint || "auto",
    search_rewrite: o.search_rewrite !== false,
    search_rerank: o.search_rerank !== false,
    gateway_url: o.gateway_url || o.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425",
    gateway_api_key: o.gateway_api_key || o.api_key || process.env.MAGPIE_API_KEY || "",
    // v6.20.0 调用预算与熔断（可配置，保守默认；见 model_budget.js）
    harvest_max_per_min: Number(o.harvest_max_per_min ?? o.model_max_per_min) > 0 ? Math.floor(Number(o.harvest_max_per_min ?? o.model_max_per_min)) : 20,
    harvest_max_total: Number(o.harvest_max_total ?? o.model_max_total) > 0 ? Math.floor(Number(o.harvest_max_total ?? o.model_max_total)) : 2000,
    // EVO-4: 高频经验结晶与踩坑复发阈值（可配置，保守默认）
    crystallization_threshold: Number(o.crystallization_threshold ?? o.crystallizationThreshold) > 0
      ? Math.floor(Number(o.crystallization_threshold ?? o.crystallizationThreshold))
      : 5,
    pitfall_recurrence_threshold: Number(o.pitfall_recurrence_threshold ?? o.pitfallRecurrenceThreshold) > 0
      ? Math.floor(Number(o.pitfall_recurrence_threshold ?? o.pitfallRecurrenceThreshold))
      : 3,
    _fetch: o._fetch,
  };
}

/** FNV-1a 双轮 64bit → 32 位十六进制指纹（同步、确定性） */
/** 语义规范化：小写、去标点与多余空白，使同一事实的不同写法落到同一指纹 */
function normalize(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[\s]+/g, "")
    .replace(/[`'"“”‘’.,;:!?()\[\]{}<>|\\/+=*&^%$#@~·—－_,，。；：！？（）【】《》「」]/g, "");
}

function fingerprint(text) {
  const s = normalize(text);
  const fnv = (seed) => {
    let h = BigInt(seed);
    const prime = 1099511628211n;
    const mask = (1n << 64n) - 1n;
    for (let i = 0; i < s.length; i++) {
      h ^= BigInt(s.charCodeAt(i));
      h = (h * prime) & mask;
    }
    return h.toString(16).padStart(16, "0");
  };
  return (fnv(14695981039346656037n) + fnv(1099511628211n)).slice(0, 32);
}

/* ---------------- NoCodeBackend 客户端 ----------------
 *
 * 默认走 **MCP**（用户要求「只用高权限 MCP key」）：
 *   MCP 侧没有结构化 CRUD 工具（query_data_api 实测 401，它是给前端 session 用的），
 *   所以数据读写通过 execute_sql 完成 —— 拼 SQL 的注入防线全在 mcp_client.js 里
 *   （标识符白名单 + 值严格转义，已有对抗性往返测试）。
 *
 * 只有在【没有 MCP key、但有 Secret Key】时才退回原来的 REST 客户端，
 * 让已经配好 Secret Key 的老用户不至于中断。
 */
const NO_CRED_ERR_MSG = "NO_CREDENTIALS: 未配置有效的 NoCodeBackend 凭据";
const ALLOWED_NO_CRED_PROPS = new Set(["list", "create", "update", "remove", "raw"]);

function makeNoCredentialsClient() {
  const throwNoCred = () => {
    const err = new Error(NO_CRED_ERR_MSG);
    err.code = "NO_CREDENTIALS";
    throw err;
  };
  const target = {
    _isNoCredentials: true,
    list: async () => throwNoCred(),
    create: async () => throwNoCred(),
    update: async () => throwNoCred(),
    remove: async () => throwNoCred(),
    raw: async () => throwNoCred(),
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "then") return undefined;
      if (prop === "_isNoCredentials") return true;
      if (ALLOWED_NO_CRED_PROPS.has(prop)) return t[prop];
      return undefined;
    },
  });
}

function isCfgShape(o) {
  if (!o || typeof o !== "object") return false;
  return Boolean(
    o.instance || o.ncb_instance || o.secret || o.ncb_secret || o.mcpKey || o.mcp_key ||
    o.gateway_url || o.audit_model || o.extract_model || o.dedup_batch_size || o.dedup_fetch_limit
  );
}

export function makeClient(cfg, signal) {
  try {
    if (!cfg || typeof cfg !== "object" || !isCfgShape(cfg)) {
      return makeNoCredentialsClient();
    }
    const o = (cfg && cfg.instance && typeof cfg.secret === "string" && typeof cfg.mcpKey === "string") ? cfg : readOptions(cfg);
    const sig = signal || (cfg && cfg.signal) || (o && o.signal) || null;
    if (o && (o.mcpKey || o.mcp_key)) {
      return makeMcpClient(o, sig);
    }
    if (o && (o.secret || o.ncb_secret)) {
      return makeRestClient(o, sig);
    }
    return makeNoCredentialsClient();
  } catch (_e) {
    return makeNoCredentialsClient();
  }
}

function makeRestClient(cfg, signal) {
  const instance = (cfg && (cfg.instance || cfg.ncb_instance)) || "";
  const secret = (cfg && (cfg.secret || cfg.ncb_secret)) || "";
  async function call(method, action, table, { data, params, id, signal: callSignal } = {}) {
    const qs = new URLSearchParams(Object.assign({ Instance: instance }, params || {}));
    const suffix = id === undefined || id === null ? "" : "/" + encodeURIComponent(id);
    const url = `${NCB_BASE}/${action}/${table}${suffix}?${qs.toString()}`;

    const headers = { "Content-Type": "application/json" };
    if (secret) headers.Authorization = "Bearer " + secret;

    const effectiveSignal = callSignal || signal || (cfg && cfg.signal) || null;
    if (effectiveSignal && effectiveSignal.aborted) {
      const abortErr = new Error("操作已被取消 (aborted)");
      abortErr.name = "AbortError";
      throw abortErr;
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: effectiveSignal || (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(15000) : undefined),
      });
    } catch (e) {
      if (e && (e.name === "AbortError" || (effectiveSignal && effectiveSignal.aborted))) {
        const abortErr = new Error("操作已被取消 (aborted)");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      throw e;
    }
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      json = { _raw: raw.slice(0, 300) };
    }

    if (!res.ok) {
      const detail = json.error || json.message || json._raw || "";
      let hint = "";
      if (/secret_key/i.test(String(detail))) {
        hint = " —— Secret Key 不正确。请在「记忆中枢设置」里填入该 NoCodeBackend 数据库的 Secret Key。";
      } else if (res.status === 401 || res.status === 403) {
        hint = " —— 该表未对外开放，必须配置正确的数据库 Secret Key。";
      }
      throw new Error(`NCB ${action}/${table} 失败 (HTTP ${res.status}): ${String(detail).slice(0, 200)}${hint}`);
    }
    if (json && json.status === "failed") {
      throw new Error(`NCB ${action}/${table} 失败: ${json.error || JSON.stringify(json).slice(0, 200)}`);
    }
    return json;
  }

  return {
    list: (table, params) => call("GET", "read", table, { params }),
    create: (table, data) => call("POST", "create", table, { data }),
    update: (table, id, data) => call("PUT", "update", table, { data, id }),
    remove: (table, id) => call("DELETE", "delete", table, { id }),
  };
}

function rowsOf(res) {
  if (!res) return [];
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res)) return res;
  return [];
}

function mergeCommaSeparated(base, ...extras) {
  const set = new Set();
  const add = (val) => {
    if (!val) return;
    if (Array.isArray(val)) {
      val.forEach(add);
      return;
    }
    String(val).split(/[,;\s，；、|]+/).forEach((item) => {
      const trimmed = item.trim();
      if (trimmed) set.add(trimmed);
    });
  };
  add(base);
  extras.forEach(add);
  return Array.from(set).join(",");
}

function trackMemoryRetrievals(client, rows) {
  if (!client || typeof client.update !== "function" || !Array.isArray(rows) || !rows.length) return;
  const now = nowSql();
  const updates = rows
    .filter((r) => r && r.id)
    .slice(0, 5)
    .map((r) =>
      client.update("memories", r.id, {
        retrieval_count: (Number(r.retrieval_count) || 0) + 1,
        last_used_at: now,
      })
    );
  Promise.allSettled(updates).catch(() => {});
}

/** 分页取回（NCB 默认每页 10 条，默认 order_by: updated_at DESC） */
export async function fetchAll(client, table, params, maxPagesArg) {
  if (!client || typeof client !== "object" || typeof client.list !== "function") return [];
  const p = Object.assign({}, params || {});
  const rawMax = maxPagesArg != null ? maxPagesArg : p.max_pages;
  delete p.max_pages;
  const maxPages = Math.max(1, Math.min(Number(rawMax) || 5, 20));
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await client.list(table, Object.assign({ limit: FETCH_LIMIT, page, order_by: "updated_at DESC" }, p));
    const batch = rowsOf(res);
    if (!batch.length) break;
    out.push(...batch);
    const meta = res && res.metadata;
    const hasMore = (meta && typeof meta.hasMore === "boolean") ? meta.hasMore : (batch.length >= FETCH_LIMIT);
    if (!hasMore) break;
  }
  return out;
}

/* ---------------- 检索打分 ---------------- */

export { termsOf, CJK_STOP_BIGRAMS };

/** 记忆：标题(5) 标签(3) 实体(3) 正文(1) —— EVO-3 修复实体检索失明与独立打分 */
function scoreMemory(row, terms) {
  if (!terms.length) return 1;
  const title = String(row.title || "").toLowerCase();
  const tags = String(row.tags || "").toLowerCase();
  const entities = (Array.isArray(row.related_entities)
    ? row.related_entities.join(",")
    : String(row.related_entities || "")
  ).toLowerCase();
  const content = String(row.content || "").toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (title.includes(t)) s += 5;
    if (tags.includes(t)) s += 3;
    if (entities.includes(t)) s += 3;
    if (content.includes(t)) s += 1;
  }
  return s;
}

/** 踩坑：把现象/根因/解法/组件全部纳入命中面 */
function scorePitfall(row, terms) {
  if (!terms.length) return 1;
  const head = [row.component, row.symptom].filter(Boolean).join(" ").toLowerCase();
  const tags = String(row.tags || "").toLowerCase();
  const body = [row.root_cause, row.solution].filter(Boolean).join(" ").toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (head.includes(t)) s += 5;
    if (tags.includes(t)) s += 3;
    if (body.includes(t)) s += 1;
  }
  return s;
}

/** Headroom 式时序新鲜度：越新越靠前（对数衰减，避免压倒命中分） */
function freshness(row) {
  const t = Date.parse(String(row.last_used_at || row.updated_at || row.created_at || "").replace(" ", "T") + "Z");
  if (!t || isNaN(t)) return 0;
  const days = (Date.now() - t) / 86400000;
  return days <= 0 ? 1 : 1 / (1 + Math.log10(1 + days));
}

function rankMemory(row) {
  const rawScore = Number(row.confidence_score);
  const conf = (!isNaN(rawScore) ? rawScore : 100) / 100;
  const acc = Math.min(Number(row.retrieval_count) || 0, 10);
  return conf * (1 + 0.1 * acc) * (0.5 + 0.5 * freshness(row));
}

function cut(s, n) {
  const v = String(s == null ? "" : s);
  return v.length > n ? v.slice(0, n) + "…" : v;
}

function jsonOut(o) {
  return JSON.stringify(o, null, 2);
}

/* ================================================================== *
 * 记忆写入（含指纹去重 + 时序版本链）
 * ================================================================== */
/** 统一的 SQL 时间戳字符串（NCB 不生效 DEFAULT CURRENT_TIMESTAMP，必须显式写）。 */
function nowSql() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** 检查记忆是否有效（未标记 invalid_at 且未超过 expires_at） */
function isMemoryValid(row, nowMs = Date.now()) {
  if (!row) return false;
  if (row.invalid_at) return false;
  if (row.expires_at) {
    const str = String(row.expires_at).trim();
    const iso = str.replace(" ", "T") + (str.includes("Z") ? "" : "Z");
    const t = Date.parse(iso);
    if (!isNaN(t) && t <= nowMs) return false;
  }
  return true;
}

/** 检查两个标签集合是否存在交集 */
function hasTagsIntersection(t1, t2) {
  if (!t1 || !t2) return false;
  const set1 = new Set(String(t1).split(/[,;\s，、|]+/).map(normalizeSemanticText).filter(Boolean));
  if (!set1.size) return false;
  const set2 = new Set(String(t2).split(/[,;\s，、|]+/).map(normalizeSemanticText).filter(Boolean));
  if (!set2.size) return false;
  for (const x of set1) {
    if (set2.has(x)) return true;
  }
  return false;
}

async function saveMemory(client, cfg, m, ctx) {
  const project = String(m.project || "global").trim();
  const category = CATEGORIES.includes(m.category) ? m.category : "fact";
  const scopeLevel = SCOPES.includes(m.scope_level) ? m.scope_level : "project";
  const callerAgent = (ctx && (ctx.agent || (ctx._ctx && ctx._ctx.agent))) || "";
  const clientVal = (m.client && String(m.client).trim())
    || (callerAgent && String(callerAgent).trim())
    || (m.agent && String(m.agent).trim())
    || "unknown";
  const origin = String(m.origin || "tool").trim();
  const rawTitle = String(m.title || "").trim();
  const rawContent = String(m.content || "").trim();
  if (!rawTitle) throw new Error("title 不能为空");
  if (!rawContent) throw new Error("content 不能为空");

  const title = scrubSecrets(rawTitle);
  const content = scrubSecrets(rawContent);
  const fullText = (m.full_text != null && String(m.full_text).trim() !== "")
    ? scrubSecrets(String(m.full_text))
    : content;
  const tags = scrubSecrets(String(m.tags || "").trim().toLowerCase());
  const relatedEntities = scrubSecrets(String(m.related_entities || "").trim());
  const rawConf = typeof m.confidence === "number"
    ? m.confidence
    : (m.confidence !== undefined && m.confidence !== null && m.confidence !== "" && !isNaN(Number(m.confidence)) ? Number(m.confidence) : 1);
  let confidence = rawConf <= 1 ? Math.round(rawConf * 100) : Math.round(rawConf);
  confidence = Math.max(0, Math.min(100, confidence));

  const callerSession = (ctx && (ctx.session || (ctx._ctx && ctx._ctx.session))) || "";
  const callerTurn = (ctx && (typeof ctx.turn === "number" ? ctx.turn : (ctx._ctx && typeof ctx._ctx.turn === "number" ? ctx._ctx.turn : null)));
  const rawSession = (m.source_session && String(m.source_session).trim())
    || (callerSession && String(callerSession).trim())
    || "";
  const sourceSession = rawSession ? rawSession.slice(0, 128) : null;
  const parsedTurn = typeof m.source_turn === "number" ? m.source_turn : (m.source_turn ? Number(m.source_turn) : null);
  const sourceTurn = (typeof parsedTurn === "number" && !isNaN(parsedTurn) && parsedTurn >= 1)
    ? Math.floor(parsedTurn)
    : (callerTurn && callerTurn >= 1 ? Math.floor(callerTurn) : null);

  const initialRecurrence = typeof m.recurrence === "number" && m.recurrence >= 1 ? Math.floor(m.recurrence) : 1;
  const fp = (m.content_fingerprint && String(m.content_fingerprint).trim()) || semanticFingerprint(project, category, title, content, tags);

  // 0) 进程内近期写入 → 挡掉写后读延迟窗口里的重复
  if (justWritten("m:" + fp)) {
    return { action: "NOOP", id: null, note: "刚刚写入过（写后读延迟窗口内），已忽略重复" };
  }

  // 0.5) A③ 踩坑优先：检查 pitfalls 表中是否已存在该工程问题（principle 准则豁免，不得被 pitfalls 覆盖）
  if (category !== "principle") {
    try {
      const pitfallRows = rowsOf(await client.list("pitfalls", { project, limit: FETCH_LIMIT }));
      const normTitle = normalizeSemanticText(title);
      const matchedPitfall = pitfallRows.find((p) => {
        if (p.invalid_at) return false;
        if (p.lifecycle_status && p.lifecycle_status !== "active") return false;
        if (hasConflictingNumbers(title, p.symptom)) return false;
        const pSym = normalizeSemanticText(p.symptom);
        if (pSym && (pSym === normTitle || normTitle.includes(pSym) || pSym.includes(normTitle))) {
          if (!hasConflictingNumbers(title, p.symptom)) return true;
        }
        const tTok = tokenize(title);
        const sTok = tokenize(p.symptom);
        if (overlapCoefficient(tTok.tokens, sTok.tokens) >= 0.5 || jaccardSimilarity(tTok.tokens, sTok.tokens) >= 0.3) {
          if (!hasConflictingNumbers(title, p.symptom)) return true;
        }
        return isSemanticallySimilar(title, content, p.symptom, p.solution || p.root_cause);
      });
      if (matchedPitfall) {
        const next = (Number(matchedPitfall.recurrence) || 1) + initialRecurrence;
        const now = nowSql();
        try {
          await client.update("pitfalls", matchedPitfall.id, {
            recurrence: next,
            last_occurred_at: now,
            updated_at: now,
          });
          markRecent("p:" + (matchedPitfall.content_fingerprint || fp));
          return {
            action: "NOOP",
            id: matchedPitfall.id,
            table: "pitfalls",
            recurrence: next,
            note: `踩坑优先：该问题在 pitfalls 表中已存在（id=${matchedPitfall.id}），以踩坑记录为准，累加踩坑复发计数，不重复写入 memories`,
          };
        } catch (e) {
          if (!/404|not found/i.test(String(e.message))) throw e;
        }
      }
    } catch (_) {
      // fail-open
    }
  }

  // 1) 候选集拉取（按 project + lifecycle_status='active' 过滤，按 updated_at DESC 排序）
  const queryParams = { project, lifecycle_status: "active", order_by: "updated_at DESC", limit: FETCH_LIMIT };
  const allActiveRows = rowsOf(await client.list("memories", queryParams));
  let categoryRows = allActiveRows.filter((r) => !category || r.category === category);

  // 2) Layer ① 语义指纹查重 + Layer ② 局部滑动窗口语义相似度比对
  const dup = findSemanticDuplicate(categoryRows, title, content, fp);
  if (dup) {
    const next = (Number(dup.recurrence) || 1) + initialRecurrence;
    const now = nowSql();

    // EVO-1: 智能增量扩充检测（同标题重复 + 无数字冲突 + 信息量增长 ≥ 1.25 或显式传 supersede: true）
    const normNewTitle = normalizeSemanticText(title);
    const normOldTitle = normalizeSemanticText(dup.title);
    const isSameTitle = (normNewTitle && normNewTitle === normOldTitle) ||
      (String(dup.title || "").trim().toLowerCase() === String(title || "").trim().toLowerCase());

    const noNumberConflict = !hasConflictingNumbers(title, dup.title) &&
      !hasConflictingNumbers(content, dup.content || dup.full_text || "");

    const oldContentStr = String(dup.content || dup.full_text || "").trim();
    const newContentStr = String(content || "").trim();
    const hasSignificantGrowth = newContentStr.length >= (oldContentStr.length * 1.25);
    const isExplicitSupersede = m.supersede === true || m.supersede === "true";

    // BUG-3: 命中 dup 时，即便标题不一致（isSameTitle 为 false），只要显式传 supersede: true，也必须进入 ENRICHED 融合路径
    const shouldEnrich = noNumberConflict && (isExplicitSupersede || (isSameTitle && hasSignificantGrowth));

    // EVO-4: 高频经验自动升维结晶（preference / decision 且 recurrence 达到阈值且 confidence_score ≥ 80）
    const crystallizationThreshold = Number(m.crystallization_threshold ?? cfg?.crystallization_threshold ?? 5) || 5;
    const isCrystallizable = ["preference", "decision"].includes(String(dup.category || "").toLowerCase());
    const effectiveConfidence = (m.confidence !== undefined && m.confidence !== null && m.confidence !== "")
      ? confidence
      : (dup.confidence_score != null ? Number(dup.confidence_score) : confidence);
    const isCrystallized = isCrystallizable && (next >= crystallizationThreshold) && (effectiveConfidence >= 80);
    const targetCategory = isCrystallized ? "principle" : dup.category;

    if (shouldEnrich) {
      const mergedContent = (newContentStr.length >= oldContentStr.length) ? content : (dup.content || content);
      const oldFullTextStr = String(dup.full_text || dup.content || "").trim();
      const newFullTextStr = String(fullText || "").trim();
      const mergedFullText = (newFullTextStr.length >= oldFullTextStr.length) ? fullText : (dup.full_text || fullText);

      const existingTags = String(dup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const newTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const mergedTags = Array.from(new Set([...existingTags, ...newTags])).join(", ");

      const existingEntities = String(dup.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
      const newEntities = String(relatedEntities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
      const mergedEntities = Array.from(new Set([...existingEntities, ...newEntities])).join(", ");

      const nextRevision = (Number(dup.revision) || 1) + 1;
      const targetTitle = (isExplicitSupersede && title) ? title : dup.title;
      const newFp = semanticFingerprint(project, targetCategory, targetTitle, mergedContent, mergedTags);

      const updatePayload = {
        title: targetTitle,
        content: mergedContent,
        full_text: mergedFullText,
        tags: mergedTags || dup.tags,
        related_entities: mergedEntities || dup.related_entities,
        recurrence: next,
        revision: nextRevision,
        updated_at: now,
      };
      if (isCrystallized) {
        updatePayload.category = "principle";
      }
      if (newFp) {
        updatePayload.content_fingerprint = newFp;
      }

      try {
        await client.update("memories", dup.id, Object.assign({}, updatePayload, { updated_at: updatePayload.updated_at || nowSql() }));
        markRecent("m:" + (newFp || dup.content_fingerprint || fp));
        return {
          action: "ENRICHED",
          id: dup.id,
          category: targetCategory,
          recurrence: next,
          revision: nextRevision,
          retrieval_count: Number(dup.retrieval_count) || 0,
          note: isCrystallized
            ? "智能增量扩充成功，融合更详尽细节，已升维为 principle"
            : "智能增量扩充成功，融合更详尽细节，保留原记忆ID并递增版本",
        };
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    } else {
      // BUG-3: NOOP 分支除了 recurrence/updated_at，还要把本次传入的 tags 与 related_entities 取并集回写
      const existingTags = String(dup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const incomingTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const mergedTags = Array.from(new Set([...existingTags, ...incomingTags])).join(", ");

      const existingEntities = String(dup.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
      const incomingEntities = String(relatedEntities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
      const mergedEntities = Array.from(new Set([...existingEntities, ...incomingEntities])).join(", ");

      const updatePayload = {
        recurrence: next,
        tags: mergedTags || dup.tags,
        related_entities: mergedEntities || dup.related_entities,
        updated_at: now,
      };
      if (isCrystallized) {
        updatePayload.category = "principle";
        const newFp = semanticFingerprint(project, "principle", dup.title, dup.content, mergedTags || dup.tags);
        if (newFp) updatePayload.content_fingerprint = newFp;
      }
      try {
        await client.update("memories", dup.id, Object.assign({}, updatePayload, { updated_at: updatePayload.updated_at || nowSql() }));
        markRecent("m:" + (updatePayload.content_fingerprint || dup.content_fingerprint || fp));
        const baseNote = dup.content_fingerprint === fp ? "内容未变化，累加复发计数" : "语义相似去重命中，累加复发计数";
        const note = isCrystallized ? (baseNote + "，已升维为 principle") : baseNote;
        return {
          action: "NOOP",
          id: dup.id,
          category: targetCategory,
          recurrence: next,
          retrieval_count: Number(dup.retrieval_count) || 0,
          note,
        };
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    }
  }

  // 2.1) A② 跨类别去重：同 project + 归一化 title + 不同 category
  const normTitle = normalizeSemanticText(title);
  const otherCategoryRows = allActiveRows.filter((r) => r.category !== category);
  const crossDup = otherCategoryRows.find((r) => {
    if (hasConflictingNumbers(title, r.title)) return false;
    if (hasConflictingNumbers(content, r.content || r.full_text || "")) return false;
    const rNormTitle = normalizeSemanticText(r.title);
    if (rNormTitle && rNormTitle === normTitle) return true;
    return isSemanticallySimilar(title, content, r.title, r.content || r.full_text);
  });

  if (crossDup) {
    const next = (Number(crossDup.recurrence) || 1) + initialRecurrence;
    const now = nowSql();
    const existingTags = String(crossDup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
    const newTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
    const mergedTags = Array.from(new Set([...existingTags, ...newTags])).join(", ");

    const existingEntities = String(crossDup.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
    const newEntities = String(relatedEntities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
    const mergedEntities = Array.from(new Set([...existingEntities, ...newEntities])).join(", ");

    // 【P1-3】principle 准则保护：若新记录是 principle 且旧记录不是 principle，
    // 升级旧记录为 principle 并保留准则内容与指纹，绝不允许把 principle 降级为普通分类
    const isNewPrinciple = category === "principle" && crossDup.category !== "principle";

    // EVO-4: 升维保护
    const crystallizationThreshold = Number(m.crystallization_threshold ?? cfg?.crystallization_threshold ?? 5) || 5;
    const isCrystallizable = ["preference", "decision"].includes(String(crossDup.category || "").toLowerCase()) ||
                             ["preference", "decision"].includes(String(category || "").toLowerCase());
    const effectiveConfidence = (m.confidence !== undefined && m.confidence !== null && m.confidence !== "")
      ? confidence
      : (crossDup.confidence_score != null ? Number(crossDup.confidence_score) : confidence);
    const isCrystallized = !isNewPrinciple && isCrystallizable && (next >= crystallizationThreshold) && (effectiveConfidence >= 80);

    const targetCategory = (isNewPrinciple || isCrystallized) ? "principle" : crossDup.category;

    const updatePayload = {
      recurrence: next,
      tags: mergedTags || crossDup.tags,
      related_entities: mergedEntities || crossDup.related_entities,
      updated_at: now,
    };
    if (isNewPrinciple) {
      updatePayload.category = "principle";
      if (content) updatePayload.content = content;
      if (fullText) updatePayload.full_text = fullText;
      if (title) updatePayload.title = title;
      if (fp) updatePayload.content_fingerprint = fp;
    } else if (isCrystallized) {
      updatePayload.category = "principle";
      const newFp = semanticFingerprint(project, "principle", crossDup.title, crossDup.content, mergedTags || crossDup.tags);
      if (newFp) updatePayload.content_fingerprint = newFp;
    }

    try {
      await client.update("memories", crossDup.id, Object.assign({}, updatePayload, { updated_at: now }));
      markRecent("m:" + (fp || crossDup.content_fingerprint));
      let crossNote = isNewPrinciple
        ? ("跨类别去重命中（既有记录分类: " + crossDup.category + " 已升级为 principle），已保留准则版本并累加复发计数")
        : ("跨类别去重命中（既有记录分类: " + crossDup.category + "，传入分类: " + category + "），已合并至既有记录并累加复发计数");
      if (isCrystallized) {
        crossNote += "，已升维为 principle";
      }
      return {
        action: "NOOP",
        id: crossDup.id,
        category: targetCategory,
        recurrence: next,
        retrieval_count: Number(crossDup.retrieval_count) || 0,
        note: crossNote,
      };
    } catch (e) {
      if (!/404|not found/i.test(String(e.message))) throw e;
    }
  }

  // 3) 支持显式指定 supersede_id 与按标题版本链取代
  const targetSupersedeId = (m.supersede_id != null && m.supersede_id !== "" && !isNaN(Number(m.supersede_id)))
    ? Number(m.supersede_id)
    : null;
  const targetSupersedeRow = targetSupersedeId ? allActiveRows.find((r) => r.id === targetSupersedeId) : null;

  const superseded = categoryRows.filter(
    (r) =>
      r.lifecycle_status === "active" &&
      String(r.title || "").trim().toLowerCase() === title.toLowerCase()
  );

  const baseRevision = superseded.reduce(function (mx, r) { return Math.max(mx, Number(r.revision) || 1); }, 0);
  const explicitRevision = targetSupersedeRow ? (Number(targetSupersedeRow.revision) || 1) : 0;
  const newRevision = Math.max(baseRevision, explicitRevision) + 1;

  const payload = {
    project,
    category,
    scope_level: scopeLevel,
    client: clientVal,
    origin,
    title,
    content,
    full_text: fullText,
    tags,
    related_entities: relatedEntities,
    content_fingerprint: fp,
    confidence_score: confidence,
    lifecycle_status: "active",
    /* 【外键列，必须写 NULL 而非 0】
     * NCB 会按 `*_id` 列名自动建外键：superseded_by_id → memories.id。
     * 写 0 会触发外键违约（没有 id=0 的行），整个 memory_save 直接失败。
     * NULL 是外键的合法值，语义也正是「未被任何行取代」。 */
    superseded_by_id: null,
    /* 修订版本号 = 被取代那批里最大的修订号 + 1。没有旧版时就是 1。 */
    revision: newRevision,
    recurrence: initialRecurrence,
    retrieval_count: 0,
    invalid_at: null,
    invalid_reason: '',
    // 会话级/轮次级记忆带 TTL（默认 7 / 1 天）；project/user 级永不过期
    expires_at: expiresAtFor(scopeLevel),
    last_used_at: null,
    /* 【必须显式写时间戳】实测 NCB 不生效 DEFAULT CURRENT_TIMESTAMP，
     * 省略这两列会落库为 NULL —— 而 freshness() 依赖它们，会永远返回 0。 */
    created_at: nowSql(),
    updated_at: nowSql(),
    source_session: sourceSession,
    source_turn: sourceTurn,
  };

  /* 数据库上有 (project, content_fingerprint) 唯一索引：它才是去重的最终保证，
   * 因为 NCB 的读有约 2 秒写后可见延迟，靠「先读后写」会漏掉并发/紧邻的重复。
   * 被索引拦下时按 NOOP 处理，不向上抛错。 */
  let created;
  try {
    created = await client.create("memories", payload);
  } catch (e) {
    if (/duplicate entry/i.test(String(e.message))) {
      markRecent("m:" + fp);
      const dupRow = rowsOf(await client.list("memories", { project, limit: FETCH_LIMIT })).filter(
        (r) => r.content_fingerprint === fp
      )[0];
      if (dupRow) {
        const next = (Number(dupRow.recurrence) || 1) + initialRecurrence;
        const crystallizationThreshold = Number(m.crystallization_threshold ?? cfg?.crystallization_threshold ?? 5) || 5;
        const isCrystallizable = ["preference", "decision"].includes(String(dupRow.category || "").toLowerCase());
        const effectiveConfidence = (m.confidence !== undefined && m.confidence !== null && m.confidence !== "")
          ? confidence
          : (dupRow.confidence_score != null ? Number(dupRow.confidence_score) : confidence);
        const isCrystallized = isCrystallizable && (next >= crystallizationThreshold) && (effectiveConfidence >= 80);
        const targetCategory = isCrystallized ? "principle" : dupRow.category;

        const existingTags = String(dupRow.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const incomingTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const mergedTags = Array.from(new Set([...existingTags, ...incomingTags])).join(", ");

        const existingEntities = String(dupRow.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
        const incomingEntities = String(relatedEntities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
        const mergedEntities = Array.from(new Set([...existingEntities, ...incomingEntities])).join(", ");

        const updatePayload = {
          recurrence: next,
          tags: mergedTags || dupRow.tags,
          related_entities: mergedEntities || dupRow.related_entities,
          updated_at: nowSql(),
        };
        if (isCrystallized) {
          updatePayload.category = "principle";
          const newFp = semanticFingerprint(project, "principle", dupRow.title, dupRow.content, mergedTags || dupRow.tags);
          if (newFp) updatePayload.content_fingerprint = newFp;
        }
        try {
          await client.update("memories", dupRow.id, Object.assign({}, updatePayload, { updated_at: updatePayload.updated_at || nowSql() }));
        } catch (_) {}
        const note = isCrystallized ? "唯一索引拦下重复，累加复发计数，已升维为 principle" : "唯一索引拦下重复，累加复发计数";
        return { action: "NOOP", id: dupRow.id, category: targetCategory, recurrence: next, retrieval_count: Number(dupRow.retrieval_count) || 0, note };
      }
      return { action: "NOOP", id: null, note: "唯一索引拦下重复（写后读延迟内读不到既有行）" };
    }
    throw e;
  }
  const newId = created && (created.id || created.insertId);
  markRecent("m:" + fp);

  // EVO-9a: 处理显式 supersede_id 与旧版 supersede 版本链
  const allSupersedeIds = new Set();
  if (targetSupersedeId) allSupersedeIds.add(targetSupersedeId);
  for (const s of superseded) {
    if (s && s.id) allSupersedeIds.add(s.id);
  }

  if (allSupersedeIds.size > 0 && newId) {
    let updatedCount = 0;
    for (const sid of allSupersedeIds) {
      try {
        const invReason = (sid === targetSupersedeId) ? `superseded-by:${newId}` : "superseded";
        await client.update("memories", sid, {
          lifecycle_status: "superseded",
          superseded_by_id: newId,
          invalid_at: nowSql(),
          invalid_reason: invReason,
          updated_at: nowSql(),
        });
        updatedCount++;
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    }
    const returnSupersededId = targetSupersedeId || (superseded[0] && superseded[0].id);
    return {
      action: "UPDATE",
      id: newId,
      category,
      superseded_id: returnSupersededId,
      superseded_count: updatedCount || allSupersedeIds.size,
      recurrence: initialRecurrence,
      note: targetSupersedeId ? `已显式取代旧记录 id=${targetSupersedeId}` : undefined,
    };
  }

  // EVO-9a 冲突感知：saveMemory 返回 ADD 时扫描同主题但含冲突数字的旧记录
  const normCurTitle = normalizeSemanticText(title);
  const curTokens = tokenize(title);
  const stripNums = (s) => String(s || "").replace(/\d+(?:\.\d+)*/g, "").trim();
  const curTitleNoNums = normalizeSemanticText(stripNums(title));
  const curTokensNoNums = tokenize(stripNums(title)).tokens;

  const conflictCandidates = [];
  for (const r of allActiveRows) {
    if (!r || !r.id || r.id === newId) continue;
    if (r.lifecycle_status !== "active" || r.invalid_at) continue;

    const rTitleStr = String(r.title || "").trim();
    const normRowTitle = normalizeSemanticText(rTitleStr);
    const rowTokens = tokenize(rTitleStr);

    // 1. 标题相似判定（同主题）
    const exactOrInclude = Boolean(
      (normCurTitle && normRowTitle && (normCurTitle === normRowTitle || normCurTitle.includes(normRowTitle) || normRowTitle.includes(normCurTitle))) ||
      (rTitleStr.toLowerCase() === title.toLowerCase())
    );
    const tokenOverlap = overlapCoefficient(curTokens.tokens, rowTokens.tokens) >= 0.4 ||
                         jaccardSimilarity(curTokens.tokens, rowTokens.tokens) >= 0.25;

    // 针对标题含版本/端口数字的归一化比对（如 Node 18 配置 vs Node 20 配置）
    const rowTitleNoNums = normalizeSemanticText(stripNums(rTitleStr));
    const rowTokensNoNums = tokenize(stripNums(rTitleStr)).tokens;
    const noNumsMatch = Boolean(
      (curTitleNoNums && rowTitleNoNums && (curTitleNoNums === rowTitleNoNums || curTitleNoNums.includes(rowTitleNoNums) || rowTitleNoNums.includes(curTitleNoNums))) ||
      (overlapCoefficient(curTokensNoNums, rowTokensNoNums) >= 0.4 || jaccardSimilarity(curTokensNoNums, rowTokensNoNums) >= 0.25)
    );

    const isTopicSimilar = exactOrInclude || tokenOverlap || noNumsMatch;
    if (!isTopicSimilar) continue;

    // 2. hasConflictingNumbers 判定（标题或正文存在数字冲突）
    const hasNumConflict = hasConflictingNumbers(title, r.title) ||
                           hasConflictingNumbers(content, r.content || r.full_text || "");

    if (hasNumConflict) {
      const summary = String(r.content || r.full_text || "").trim().slice(0, 100);
      conflictCandidates.push({
        id: r.id,
        title: r.title,
        content: summary,
      });
      if (conflictCandidates.length >= 3) break;
    }
  }

  const addResult = { action: "ADD", id: newId, category, recurrence: initialRecurrence };
  if (conflictCandidates.length > 0) {
    addResult.conflict_candidates = conflictCandidates;
    addResult.note = "可能存在配置冲突，建议用 supersede_id 取代或 memory_forget 淘汰";
  }
  return addResult;
}

/* ================================================================== *
 * 工具入参零摩擦容错归一化 (EVO-6)
 * ================================================================== */

function normalizeToolArgs(rawArgs, cfg) {
  if (!rawArgs || typeof rawArgs !== "object") rawArgs = {};
  const args = Object.assign({}, rawArgs);

  // 1. 同义参数映射（仅在目标字段缺省或为空时映射，绝不覆盖已有正确入参）
  // q / keyword / query → query
  if (args.query == null || args.query === "") {
    if (args.keyword != null && args.keyword !== "") args.query = args.keyword;
    else if (args.q != null && args.q !== "") args.query = args.q;
  }
  // error / issue → symptom
  if (args.symptom == null || args.symptom === "") {
    if (args.error != null && args.error !== "") args.symptom = args.error;
    else if (args.issue != null && args.issue !== "") args.symptom = args.issue;
  }
  // fix / resolve → solution
  if (args.solution == null || args.solution === "") {
    if (args.fix != null && args.fix !== "") args.solution = args.fix;
    else if (args.resolve != null && args.resolve !== "") args.solution = args.resolve;
  }
  // name / topic → title
  if (args.title == null || args.title === "") {
    if (args.name != null && args.name !== "") args.title = args.name;
    else if (args.topic != null && args.topic !== "") args.title = args.topic;
  }
  // text / body → content
  if (args.content == null || args.content === "") {
    if (args.text != null && args.text !== "") args.content = args.text;
    else if (args.body != null && args.body !== "") args.content = args.body;
  }

  // 2. tags / related_entities 容错：若为数组则 join(",")；若为字符串保持
  if (Array.isArray(args.tags)) {
    args.tags = args.tags.join(",");
  }
  if (Array.isArray(args.related_entities)) {
    args.related_entities = args.related_entities.join(",");
  }

  // 3. args.project 缺省或为空时，继承 cfg.project（仅当 cfg.project 非 "global" 时继承，否则用 "global"）
  const curProj = args.project != null ? String(args.project).trim() : "";
  if (!curProj) {
    const cfgProj = cfg && cfg.project ? String(cfg.project).trim() : "";
    if (cfgProj && cfgProj !== "global") {
      args.project = cfgProj;
    } else {
      args.project = "global";
    }
  }

  return args;
}

/* ================================================================== *
 * 工具实现
 * ================================================================== */

async function memorySave(client, cfg, rawArgs, ctx) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const r = await saveMemory(client, cfg, Object.assign({ origin: "tool" }, args), ctx);
  return jsonOut(r);
}

async function memorySearch(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const rawQuery = String(args.query || "").trim();
  const origTerms = termsOf(rawQuery);

  const fetchParams = {
    lifecycle_status: "active",
    columns: [
      "id",
      "project",
      "category",
      "scope_level",
      "client",
      "origin",
      "title",
      "content",
      "tags",
      "related_entities",
      "confidence_score",
      "recurrence",
      "retrieval_count",
      "last_used_at",
      "updated_at",
      "lifecycle_status",
      "invalid_at",
      "expires_at",
    ],
  };
  const projectArg = args.project ? String(args.project).trim() : "";
  if (args.category) fetchParams.category = String(args.category).trim();
  if (args.scope_level) fetchParams.scope_level = String(args.scope_level).trim();
  if (args.client) fetchParams.client = String(args.client).trim();
  if (args.origin) fetchParams.origin = String(args.origin).trim();

  let all = [];
  if (projectArg && projectArg !== "global") {
    // 跨项目全局穿透检索：支持 project IN (args.project, 'global')
    const [projRows, globalRows] = await Promise.all([
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: projectArg })),
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: "global" })),
    ]);
    const seen = new Set();
    for (const r of projRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
    for (const r of globalRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
  } else {
    if (projectArg) fetchParams.project = projectArg;
    all = await fetchAll(client, "memories", fetchParams);
  }

  let pool = all;
  if (projectArg) {
    if (projectArg === "global") {
      pool = pool.filter((r) => String(r.project || "") === "global");
    } else {
      pool = pool.filter((r) => String(r.project || "") === projectArg || String(r.project || "") === "global");
    }
  }
  if (args.category) pool = pool.filter((r) => String(r.category || "") === args.category);
  const targetScope = args.scope_level;
  if (targetScope) pool = pool.filter((r) => String(r.scope_level || "") === targetScope);
  if (args.client) pool = pool.filter((r) => String(r.client || "") === String(args.client));
  if (args.origin) pool = pool.filter((r) => String(r.origin || "") === String(args.origin));
  // 历史版本默认不返回（Headroom：查询默认排除 superseded）
  if (args.include_history !== true) pool = pool.filter((r) => r.lifecycle_status !== "superseded");
  pool = pool.filter((r) => isMemoryValid(r));

  // 优先级 2：在线提炼模型改写自然语言查询（在配置了模型且开启改写时）
  let rewrittenInfo = null;
  let rewrittenTerms = [];
  if (rawQuery) {
    try {
      rewrittenInfo = await rewriteSearchQuery({
        query: rawQuery,
        options: cfg,
      });
      if (rewrittenInfo && rewrittenInfo.rewrittenQuery) {
        rewrittenTerms = termsOf(rewrittenInfo.rewrittenQuery);
      }
    } catch (_) {
      // 严格 fail-open：模型异常或超时，降级为原查询纯词面检索
      rewrittenInfo = null;
      rewrittenTerms = [];
    }
  }

  const hasOrig = origTerms.length > 0;
  const hasRewrite = rewrittenTerms.length > 0;

  const scored = pool
    .map((r) => {
      if (!hasOrig && !hasRewrite) {
        return { row: r, hit: 1, origHit: 1, rewriteHit: 0 };
      }
      const origHit = hasOrig ? scoreMemory(r, origTerms) : 0;
      const rewriteHit = hasRewrite ? scoreMemory(r, rewrittenTerms) : 0;

      // 双路融合打分：
      // 1. 同时命中两路：叠加奖励分（原词 + 改写词同时命中，相关度最高）；
      // 2. 仅命中原词（如直接搜索专业术语）：原样召回，绝不丢弃；
      // 3. 仅命中改写词（自然语言问句）：由改写词成功召回原本无法命中的记忆！
      let combinedHit = 0;
      if (hasOrig && hasRewrite) {
        combinedHit = origHit + rewriteHit;
      } else if (hasOrig) {
        combinedHit = origHit;
      } else if (hasRewrite) {
        combinedHit = rewriteHit;
      }

      return { row: r, hit: combinedHit, origHit, rewriteHit };
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => {
      if (projectArg && projectArg !== "global") {
        const aProj = String(a.row.project || "") === projectArg ? 1 : 0;
        const bProj = String(b.row.project || "") === projectArg ? 1 : 0;
        if (aProj !== bProj) return bProj - aProj;
      }
      return b.hit - a.hit || rankMemory(b.row) - rankMemory(a.row);
    });

  // 检索增强：模型语义重排与精准挑选（在配置了模型且开启 rerank 时）
  let rerankUsed = false;
  let rerankModel = null;
  const shouldRerank = (args.search_rerank !== false) && (cfg.search_rerank !== false);
  if (shouldRerank && rawQuery && scored.length >= 1) {
    try {
      // 扩大粗筛召回窗口（取 top 15~25 条候选），让重排模型从中挑选最相关的结果
      const candidatePool = scored.slice(0, Math.max(limit * 2, 20));
      const rerankRes = await rerankSearchResultsWithModel({
        query: rawQuery,
        candidates: candidatePool.map((x) => x.row),
        options: cfg,
        maxTop: limit,
      });

      if (rerankRes && Array.isArray(rerankRes.ranked) && rerankRes.ranked.length > 0) {
        rerankUsed = true;
        rerankModel = rerankRes.modelUsed;
        const scoreMap = new Map();
        for (const item of rerankRes.ranked) {
          scoreMap.set(item.id, item);
        }

        // 重排胜出项置顶，其余候选按原粗排次序后置
        const topRanked = [];
        const restRanked = [];
        for (const x of scored) {
          if (scoreMap.has(x.row.id)) {
            const rInfo = scoreMap.get(x.row.id);
            topRanked.push(Object.assign({}, x, {
              _rerank_score: rInfo.score,
              _rerank_reason: rInfo.reason,
            }));
          } else {
            restRanked.push(x);
          }
        }
        topRanked.sort((a, b) => b._rerank_score - a._rerank_score);
        // 红线保证：结果集永不比纯词面更少，无缝拼接
        scored.length = 0;
        scored.push(...topRanked, ...restRanked);
      }
    } catch (_) {
      // fail-open：模型异常或超时，原样保留纯词面排序
      rerankUsed = false;
      rerankModel = null;
    }
  }

  const out = scored.slice(0, limit).map((x) => ({
    id: x.row.id,
    project: x.row.project,
    category: x.row.category,
    scope_level: x.row.scope_level,
    client: x.row.client || "unknown",
    origin: x.row.origin || "tool",
    title: x.row.title,
    content: x.row.content,
    tags: x.row.tags,
    related_entities: x.row.related_entities || null,
    confidence: x.row.confidence_score,
    recurrence: Number(x.row.recurrence) || 1,
    retrieval_count: Number(x.row.retrieval_count) || 0,
    last_used_at: x.row.last_used_at || null,
    updated_at: x.row.updated_at,
    _hit: x.hit,
    _rerank_score: x._rerank_score || null,
    _rerank_reason: x._rerank_reason || null,
  }));

  trackMemoryRetrievals(client, scored.slice(0, limit).map((x) => x.row));

  return jsonOut({
    total_active: all.length,
    matched: scored.length,
    returned: out.length,
    query_rewritten: rewrittenInfo ? rewrittenInfo.rewrittenQuery : null,
    rewrite_used: Boolean(rewrittenInfo && rewrittenInfo.rewrittenQuery),
    rerank_used: rerankUsed,
    rerank_model: rerankModel,
    memories: out,
    _agent_hint: "若本次任务产出了新结论、配置变更或排障解法，请在结束前调用 memory_save 或 pitfall_save 沉淀。",
  });
}

async function memoryList(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
  const projectArg = args.project ? String(args.project).trim() : "";
  const fetchParams = { lifecycle_status: "active" };
  if (args.client) fetchParams.client = String(args.client).trim();

  let all = [];
  if (projectArg && projectArg !== "global") {
    // 跨项目全局穿透：支持 project IN (args.project, 'global')，当前项目专属优先
    const [projRows, globalRows] = await Promise.all([
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: projectArg })),
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: "global" })),
    ]);
    const seen = new Set();
    for (const r of projRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
    for (const r of globalRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
    all = all.filter((r) => r.lifecycle_status !== "superseded" && isMemoryValid(r));
    all = all.filter((r) => String(r.project || "") === projectArg || String(r.project || "") === "global");
  } else {
    if (projectArg) fetchParams.project = projectArg;
    all = (await fetchAll(client, "memories", fetchParams)).filter(
      (r) => r.lifecycle_status !== "superseded" && isMemoryValid(r)
    );
    if (projectArg) all = all.filter((r) => String(r.project || "") === projectArg);
  }

  if (args.client) all = all.filter((r) => String(r.client || "") === String(args.client));

  const sorted = all.slice().sort((a, b) => {
    if (projectArg && projectArg !== "global") {
      const aProj = String(a.project || "") === projectArg ? 1 : 0;
      const bProj = String(b.project || "") === projectArg ? 1 : 0;
      if (aProj !== bProj) return bProj - aProj;
    }
    return rankMemory(b) - rankMemory(a);
  }).slice(0, limit);

  // EVO-10: knowledge_profile 自省画像计算
  const threshold = Number(cfg?.crystallization_threshold ?? 5) || 5;
  let principleCount = 0;
  let preferenceCount = 0;
  let decisionCount = 0;
  const nearCandidates = [];

  for (const r of all) {
    const cat = String(r.category || "").toLowerCase();
    if (cat === "principle") principleCount++;
    else if (cat === "preference") preferenceCount++;
    else if (cat === "decision") decisionCount++;

    if (cat === "preference" || cat === "decision") {
      const rec = Number(r.recurrence) || 1;
      if (rec >= threshold - 1) {
        nearCandidates.push({
          id: r.id,
          title: r.title,
          recurrence: rec,
          threshold,
        });
      }
    }
  }

  nearCandidates.sort((a, b) => b.recurrence - a.recurrence);
  const nearCrystallization = nearCandidates.slice(0, 5);

  const knowledgeProfile = {
    principle_count: principleCount,
    preference_count: preferenceCount,
    decision_count: decisionCount,
    near_crystallization: nearCrystallization,
    total_active: all.length,
  };

  return jsonOut({
    total_active: all.length,
    returned: sorted.length,
    memories: sorted.map((r) => ({
      id: r.id, project: r.project, category: r.category,
      scope_level: r.scope_level,
      client: r.client || "unknown",
      origin: r.origin || "tool",
      title: r.title, tags: r.tags,
      recurrence: Number(r.recurrence) || 1,
      retrieval_count: Number(r.retrieval_count) || 0,
      last_used_at: r.last_used_at || null,
    })),
    knowledge_profile: knowledgeProfile,
  });
}

async function memoryContext(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const maxItems = Number(args.max_items) || cfg.maxInject || 5;
  const budget = Number(args.max_chars) || cfg.maxBudget || 2048;
  const rawQuery = String(args.query || "").trim();
  const origTerms = termsOf(rawQuery);
  const projectArg = args.project ? String(args.project).trim() : "";

  const fetchParams = {
    lifecycle_status: "active",
    columns: [
      "id",
      "project",
      "category",
      "scope_level",
      "client",
      "origin",
      "title",
      "content",
      "tags",
      "related_entities",
      "confidence_score",
      "recurrence",
      "retrieval_count",
      "last_used_at",
      "updated_at",
      "lifecycle_status",
      "invalid_at",
      "expires_at",
    ],
  };

  // 1. 获取 memories（支持跨项目全局穿透：project + global）
  let pool = [];
  if (projectArg && projectArg !== "global") {
    const [projRows, globalRows] = await Promise.all([
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: projectArg })),
      fetchAll(client, "memories", Object.assign({}, fetchParams, { project: "global" })),
    ]);
    const seen = new Set();
    const all = [];
    for (const r of projRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
    for (const r of globalRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.title}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
    pool = all.filter((r) => r.lifecycle_status !== "superseded" && isMemoryValid(r));
    pool = pool.filter((r) => String(r.project || "") === projectArg || String(r.project || "") === "global");
  } else {
    if (projectArg) fetchParams.project = projectArg;
    const all = await fetchAll(client, "memories", fetchParams);
    pool = all.filter((r) => r.lifecycle_status !== "superseded" && isMemoryValid(r));
    if (projectArg) pool = pool.filter((r) => String(r.project || "") === projectArg);
  }

  // 2. 自动合并当前 project 与 global 下的 principle 准则，当前项目优先，全局兜底，杜绝全局准则丢失
  const maxPrinciples = Number(args.max_principles ?? cfg.max_principles ?? 2) || 2;
  const principles = pool
    .filter((r) => String(r.category || "").toLowerCase() === "principle")
    .sort((a, b) => {
      if (projectArg && projectArg !== "global") {
        const aProj = String(a.project || "") === projectArg ? 1 : 0;
        const bProj = String(b.project || "") === projectArg ? 1 : 0;
        if (aProj !== bProj) return bProj - aProj;
      }
      return rankMemory(b) - rankMemory(a);
    })
    .slice(0, maxPrinciples);

  // 双路词面扩展打分：在线提炼模型改写自然语言查询（fail-open）
  let rewrittenInfo = null;
  let rewrittenTerms = [];
  if (rawQuery) {
    try {
      rewrittenInfo = await rewriteSearchQuery({
        query: rawQuery,
        options: cfg,
      });
      if (rewrittenInfo && rewrittenInfo.rewrittenQuery) {
        rewrittenTerms = termsOf(rewrittenInfo.rewrittenQuery);
      }
    } catch (_) {
      rewrittenInfo = null;
      rewrittenTerms = [];
    }
  }

  const hasOrig = origTerms.length > 0;
  const hasRewrite = rewrittenTerms.length > 0;

  const principleIds = new Set(principles.map((p) => p.id));
  const scored = pool
    .filter((r) => !principleIds.has(r.id))
    .map((r) => {
      if (!hasOrig && !hasRewrite) {
        return { row: r, hit: 1, origHit: 1, rewriteHit: 0 };
      }
      const origHit = hasOrig ? scoreMemory(r, origTerms) : 0;
      const rewriteHit = hasRewrite ? scoreMemory(r, rewrittenTerms) : 0;

      let combinedHit = 0;
      if (hasOrig && hasRewrite) {
        combinedHit = origHit + rewriteHit;
      } else if (hasOrig) {
        combinedHit = origHit;
      } else if (hasRewrite) {
        combinedHit = rewriteHit;
      }

      return { row: r, hit: combinedHit, origHit, rewriteHit };
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => {
      if (projectArg && projectArg !== "global") {
        const aProj = String(a.row.project || "") === projectArg ? 1 : 0;
        const bProj = String(b.row.project || "") === projectArg ? 1 : 0;
        if (aProj !== bProj) return bProj - aProj;
      }
      return b.hit - a.hit || rankMemory(b.row) - rankMemory(a.row);
    });

  // 3. 同时拉取 pitfalls 表，支持跨项目穿透，匹配 Top 3 踩坑经验
  let pitfallPool = [];
  try {
    const pitfallColumns = [
      "id", "project", "component", "client", "symptom", "root_cause", "solution",
      "recurrence", "last_occurred_at", "updated_at", "invalid_at"
    ];
    let rawPitfalls = [];
    if (projectArg && projectArg !== "global") {
      const [projPits, globalPits] = await Promise.all([
        fetchAll(client, "pitfalls", { project: projectArg, columns: pitfallColumns }),
        fetchAll(client, "pitfalls", { project: "global", columns: pitfallColumns }),
      ]);
      const seenPits = new Set();
      for (const r of projPits) {
        const pid = r.id != null ? r.id : `${r.project}:${r.symptom}`;
        if (!seenPits.has(pid)) {
          seenPits.add(pid);
          rawPitfalls.push(r);
        }
      }
      for (const r of globalPits) {
        const pid = r.id != null ? r.id : `${r.project}:${r.symptom}`;
        if (!seenPits.has(pid)) {
          seenPits.add(pid);
          rawPitfalls.push(r);
        }
      }
    } else {
      const pitParams = { columns: pitfallColumns };
      if (projectArg) pitParams.project = projectArg;
      rawPitfalls = await fetchAll(client, "pitfalls", pitParams);
    }
    pitfallPool = rawPitfalls.filter((r) => r && !r.invalid_at && (r.symptom || r.component));
    if (projectArg) {
      if (projectArg === "global") {
        pitfallPool = pitfallPool.filter((r) => String(r.project || "") === "global");
      } else {
        pitfallPool = pitfallPool.filter(
          (r) => String(r.project || "") === projectArg || String(r.project || "") === "global"
        );
      }
    }
  } catch (_) {
    pitfallPool = [];
  }

  const scoredPitfalls = pitfallPool
    .map((r) => {
      if (!hasOrig && !hasRewrite) {
        return { row: r, hit: 1 };
      }
      const origHit = hasOrig ? scorePitfall(r, origTerms) : 0;
      const rewriteHit = hasRewrite ? scorePitfall(r, rewrittenTerms) : 0;
      let combinedHit = 0;
      if (hasOrig && hasRewrite) {
        combinedHit = origHit + rewriteHit;
      } else if (hasOrig) {
        combinedHit = origHit;
      } else if (hasRewrite) {
        combinedHit = rewriteHit;
      }
      return { row: r, hit: combinedHit };
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => {
      if (projectArg && projectArg !== "global") {
        const aProj = String(a.row.project || "") === projectArg ? 1 : 0;
        const bProj = String(b.row.project || "") === projectArg ? 1 : 0;
        if (aProj !== bProj) return bProj - aProj;
      }
      return b.hit - a.hit || (Number(b.row.recurrence) || 0) - (Number(a.row.recurrence) || 0);
    });
  const topPitfalls = scoredPitfalls.slice(0, 3).map((x) => x.row);

  // 4. 组装 [Persistent Memory Context] 块
  let block = "[Persistent Memory Context]\n";
  let n = 0;
  const matchedMemories = [];

  // 说明：曾用 process.argv 检测测试文件名来切换输出格式（省略 #id），
  // 这会让「测试通过」依赖文件名而生产行为不一致，已移除。格式在测试与生产完全统一。

  for (const pr of principles) {
    if (n >= maxItems) break;
    const idTag = pr.id != null ? `#${pr.id}` : "";
    const prEntStr = Array.isArray(pr.related_entities)
      ? pr.related_entities.join(",")
      : String(pr.related_entities || "").trim();
    const prEntPart = prEntStr ? ` | 实体: ${cut(prEntStr, 120)}` : "";
    const line = `- [principle${idTag}] ${cut(pr.title, 120)}${prEntPart}: ${cut(pr.content, 400)}\n`;
    if (block.length + line.length > budget) break;
    block += line;
    matchedMemories.push(pr);
    n++;
  }

  const pitfallThreshold = Number(args.pitfall_recurrence_threshold ?? cfg?.pitfall_recurrence_threshold ?? 3) || 3;

  for (const pit of topPitfalls) {
    if (n >= maxItems) break;
    const comp = pit.component || "general";
    const idTag = pit.id != null ? `#${pit.id}` : "";
    const rec = Number(pit.recurrence) || 1;
    const isFrequent = rec >= pitfallThreshold;
    const prefix = isFrequent ? ("[高频复发×" + rec + "] ") : "";
    const suffix = isFrequent ? " 建议核查根因是否已根治" : "";
    const line = "- " + prefix + "[pitfall/" + cut(comp, 40) + idTag + "] " + cut(pit.symptom, 160) + " → " + cut(pit.solution, 240) + suffix + "\n";
    if (block.length + line.length > budget) break;
    block += line;
    n++;
  }

  for (const x of scored) {
    if (n >= maxItems) break;
    const idTag = x.row.id != null ? `#${x.row.id}` : "";
    const cat = x.row.category || "fact";
    const isPitfall = String(cat).toLowerCase().indexOf("pitfall") === 0;
    const rec = Number(x.row.recurrence) || 1;
    const isFrequent = isPitfall && rec >= pitfallThreshold;
    const prefix = isFrequent ? ("[高频复发×" + rec + "] ") : "";
    const suffix = isFrequent ? " 建议核查根因是否已根治" : "";
    // EVO-3：实体独立展示，便于 Agent 判断记录归属领域
    const entStr = Array.isArray(x.row.related_entities)
      ? x.row.related_entities.join(",")
      : String(x.row.related_entities || "").trim();
    const entPart = entStr ? ` | 实体: ${cut(entStr, 120)}` : "";
    const line = "- " + prefix + "[" + cat + idTag + "] " + cut(x.row.title, 120) + entPart + ": " + cut(x.row.content, 400) + suffix + "\n";
    if (block.length + line.length > budget) break;
    block += line;
    matchedMemories.push(x.row);
    n++;
  }

  if (n > 0) {
    block += "（摘要已截断，可用 memory_get(id=…) 看全文）\n";
  }

  // P1-7: 异步非阻塞递增 retrieval_count 并更新 last_used_at
  trackMemoryRetrievals(client, matchedMemories);

  return jsonOut({
    injected: n,
    chars: block.length,
    block: n ? block.trim() : "",
    _agent_hint: "若本次任务产出了新结论、配置变更或排障解法，请在结束前调用 memory_save 或 pitfall_save 沉淀。",
  });
}

async function pitfallSave(client, cfg, rawArgs, ctx) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const project = String(args.project || "global").trim();
  const callerAgent = (ctx && (ctx.agent || (ctx._ctx && ctx._ctx.agent))) || "";
  const clientVal = (args.client && String(args.client).trim())
    || (callerAgent && String(callerAgent).trim())
    || (args.agent && String(args.agent).trim())
    || "unknown";
  const rawSymptom = String(args.symptom || "").trim();
  const rawSolution = String(args.solution || "").trim();
  if (!rawSymptom) throw new Error("symptom 不能为空");
  if (!rawSolution) throw new Error("solution 不能为空");

  const symptom = scrubSecrets(rawSymptom);
  const solution = scrubSecrets(rawSolution);
  const rawComponent = String(args.component || "").trim();
  const component = scrubSecrets(rawComponent || "general");
  const rawRootCause = String(args.root_cause || "").trim();
  const hasExplicitRootCause = Boolean(args.root_cause != null && String(args.root_cause).trim() !== "");
  const rootCause = scrubSecrets(rawRootCause || symptom);

  const severity = SEVERITIES.includes(args.severity) ? args.severity : "medium";
  const errorType = String(args.error_type || "").trim();
  const tags = scrubSecrets(String(args.tags || "").trim().toLowerCase());

  /* 来源可追溯性（空值语义同 saveMemory）：
   * 无会话上下文或直接调用时为 NULL，严禁伪造假数据。 */
  const callerSession = (ctx && (ctx.session || (ctx._ctx && ctx._ctx.session))) || "";
  const callerTurn = (ctx && (typeof ctx.turn === "number" ? ctx.turn : (ctx._ctx && typeof ctx._ctx.turn === "number" ? ctx._ctx.turn : null)));
  const rawSession = (args.source_session && String(args.source_session).trim())
    || (callerSession && String(callerSession).trim())
    || "";
  const sourceSession = rawSession ? rawSession.slice(0, 128) : null;
  const parsedTurn = typeof args.source_turn === "number" ? args.source_turn : (args.source_turn ? Number(args.source_turn) : null);
  const sourceTurn = (typeof parsedTurn === "number" && !isNaN(parsedTurn) && parsedTurn >= 1)
    ? Math.floor(parsedTurn)
    : (callerTurn && callerTurn >= 1 ? Math.floor(callerTurn) : null);

  const fp = (args.content_fingerprint && String(args.content_fingerprint).trim()) || semanticFingerprint(project, "pitfall", component, symptom);
  const solFp = fingerprint((solution || "") + ":" + (rootCause || ""));
  const recentKey = "p:" + fp + ":" + solFp;
  const initialRecurrence = typeof args.recurrence === "number" && args.recurrence >= 1 ? Math.floor(args.recurrence) : 1;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  if (!isTestMode() && justWritten(recentKey)) {
    return jsonOut({ action: "NOOP", id: null, note: "刚刚写入过（写后读延迟窗口内），已忽略重复" });
  }

  // A③ 踩坑优先：若 memories 表中存在该问题的冗余记忆，软失效之（排除 category==="principle"，绝不物理删除）
  try {
    const memRows = rowsOf(await client.list("memories", { project, lifecycle_status: "active", limit: FETCH_LIMIT }));
    const normSym = normalizeSemanticText(symptom);
    const supersededMems = memRows.filter((m) => {
      if (m.category === "principle") return false;
      if (hasConflictingNumbers(m.title, symptom)) return false;
      const mTitle = normalizeSemanticText(m.title);
      if (mTitle && (mTitle === normSym || mTitle.includes(normSym) || normSym.includes(mTitle))) {
        if (!hasConflictingNumbers(m.title, symptom)) return true;
      }
      const tTok = tokenize(m.title);
      const sTok = tokenize(symptom);
      if (overlapCoefficient(tTok.tokens, sTok.tokens) >= 0.5 || jaccardSimilarity(tTok.tokens, sTok.tokens) >= 0.3) {
        if (!hasConflictingNumbers(m.title, symptom)) return true;
      }
      return isSemanticallySimilar(m.title, m.content || m.full_text, symptom, solution || rootCause);
    });
    for (const oldMem of supersededMems) {
      try {
        await client.update("memories", oldMem.id, {
          lifecycle_status: "superseded",
          invalid_at: now,
          invalid_reason: "superseded_by_pitfall",
          updated_at: now,
        });
      } catch (_) {}
    }
  } catch (_) {
    // fail-open
  }

  const allPitfalls = rowsOf(await client.list("pitfalls", { project, limit: FETCH_LIMIT }));
  const activePitfalls = allPitfalls.filter((r) => !r.invalid_at);
  let dup = activePitfalls.find((r) => r.content_fingerprint === fp);
  if (!dup) {
    dup = activePitfalls.find((r) => {
      if (hasConflictingNumbers(r.symptom, symptom)) return false;
      const rSym = normalizeSemanticText(r.symptom);
      const curSym = normalizeSemanticText(symptom);
      if (rSym && curSym && (rSym === curSym || rSym.includes(curSym) || curSym.includes(rSym))) {
        if (!hasConflictingNumbers(r.symptom, symptom)) return true;
      }
      const rTok = tokenize(r.symptom);
      const sTok = tokenize(symptom);
      if (overlapCoefficient(rTok.tokens, sTok.tokens) >= 0.5 || jaccardSimilarity(rTok.tokens, sTok.tokens) >= 0.3) {
        if (!hasConflictingNumbers(r.symptom, symptom)) return true;
      }
      return isSemanticallySimilar(symptom, solution || rootCause, r.symptom, r.solution || r.root_cause);
    });
  }

  function isPlaceholderRootCause(rc, sym) {
    if (!rc || !String(rc).trim()) return true;
    const s = String(rc).trim();
    if (sym && s === String(sym).trim()) return true;
    if (/未知|待查|临时|unknown|todo|tbd/i.test(s)) return true;
    return false;
  }

  function isMeaningfulIronlaw(rc, sym, sol) {
    const rcStr = String(rc || "").trim();
    const symStr = String(sym || "").trim();
    const solStr = String(sol || "").trim();
    if (!rcStr || !solStr) return false;
    if (rcStr.toLowerCase() === symStr.toLowerCase()) return false;
    const placeholderRe = /未知|待查|临时|unknown|todo|tbd/i;
    if (placeholderRe.test(rcStr) || placeholderRe.test(solStr)) return false;
    return true;
  }

  async function checkAndApplyIronlaw(outObj, targetRecurrence, targetComponent, targetSymptom, targetRootCause, targetSolution, targetTags) {
    const crystallizationThreshold = Number(args.crystallization_threshold ?? cfg?.crystallization_threshold ?? 5) || 5;
    const rec = Number(targetRecurrence) || 1;
    if (rec < crystallizationThreshold) {
      return outObj;
    }
    if (!isMeaningfulIronlaw(targetRootCause, targetSymptom, targetSolution)) {
      return outObj;
    }

    try {
      const comp = String(targetComponent || "general").trim();
      const symTrimmed = String(targetSymptom || "").trim().slice(0, 60);
      const ironTitle = `【踩坑铁律】${comp}: ${symTrimmed}`;
      const ironContent = `【症状】${targetSymptom}\n【根因】${targetRootCause}\n【解法】${targetSolution}`;

      const existingTags = String(targetTags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!existingTags.includes("pitfall-ironlaw")) {
        existingTags.push("pitfall-ironlaw");
      }
      const ironTags = Array.from(new Set(existingTags)).join(", ");

      const memRows = rowsOf(await client.list("memories", { project, limit: FETCH_LIMIT }));
      const existingPrinciple = memRows.find(
        (r) => r.category === "principle" && !r.invalid_at && (r.lifecycle_status === "active" || !r.lifecycle_status) && String(r.title || "").trim() === ironTitle
      );

      let ironId;
      if (existingPrinciple) {
        const ironNext = (Number(existingPrinciple.recurrence) || 1) + 1;
        const existingPTags = String(existingPrinciple.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const mergedIronTags = Array.from(new Set([...existingPTags, ...existingTags])).join(", ");
        await client.update("memories", existingPrinciple.id, {
          recurrence: ironNext,
          content: ironContent,
          full_text: ironContent,
          tags: mergedIronTags,
          updated_at: nowSql(),
        });
        ironId = existingPrinciple.id;
      } else {
        const ironFp = semanticFingerprint(project, "principle", ironTitle, ironContent, ironTags);
        try {
          const createdMem = await client.create("memories", {
            project,
            category: "principle",
            scope_level: "project",
            client: clientVal,
            origin: "tool",
            title: ironTitle,
            content: ironContent,
            full_text: ironContent,
            tags: ironTags,
            related_entities: comp,
            content_fingerprint: ironFp,
            confidence_score: 1.0,
            lifecycle_status: "active",
            superseded_by_id: null,
            revision: 1,
            recurrence: 1,
            retrieval_count: 0,
            invalid_at: null,
            invalid_reason: "",
            expires_at: null,
            last_used_at: null,
            created_at: nowSql(),
            updated_at: nowSql(),
            source_session: sourceSession,
            source_turn: sourceTurn,
          });
          ironId = createdMem && (createdMem.id || createdMem.insertId);
          if (ironId) {
            markRecent("m:" + ironFp);
          }
        } catch (e) {
          if (/duplicate entry/i.test(String(e.message))) {
            const memRowsAgain = rowsOf(await client.list("memories", { project, limit: FETCH_LIMIT }));
            const dupP = memRowsAgain.find(
              (r) => r.category === "principle" && !r.invalid_at && (String(r.title || "").trim() === ironTitle || r.content_fingerprint === ironFp)
            );
            if (dupP) {
              const ironNext = (Number(dupP.recurrence) || 1) + 1;
              await client.update("memories", dupP.id, {
                recurrence: ironNext,
                content: ironContent,
                full_text: ironContent,
                tags: ironTags,
                updated_at: nowSql(),
              });
              ironId = dupP.id;
            }
          }
        }
      }

      if (ironId) {
        outObj.ironlaw_created = true;
        outObj.ironlaw_id = ironId;
      }
    } catch (_) {}
    return outObj;
  }

  if (dup) {
    const next = (Number(dup.recurrence) || 1) + initialRecurrence;
    const oldSol = String(dup.solution || "").trim();
    const newSol = String(solution || "").trim();
    const oldRc = String(dup.root_cause || "").trim();
    const oldSym = String(dup.symptom || "").trim();

    // BUG-1 (2): 数字冲突守卫：新旧 solution 存在数字冲突时禁止演进覆盖，改为返回 NOOP 并在 note 说明数字冲突
    const hasSolConflict = hasConflictingNumbers(oldSol, newSol);
    if (hasSolConflict) {
      try {
        await client.update("pitfalls", dup.id, { recurrence: next, last_occurred_at: now, updated_at: now });
        markRecent(recentKey);
        const out = await checkAndApplyIronlaw({
          action: "NOOP",
          id: dup.id,
          recurrence: next,
          note: "方案存在数字冲突，禁止演进覆盖，累加复发计数",
        }, next, dup.component || component, dup.symptom || symptom, dup.root_cause || rootCause, oldSol, dup.tags);
        return jsonOut(out);
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    }

    // 演进条件 1: 新 solution 更详尽（长度 ≥ 旧×1.3 且无数字冲突）
    const isSolutionMoreDetailed = !hasSolConflict && (
      (oldSol.length === 0 && newSol.length > 0) ||
      (oldSol.length > 0 && newSol.length >= oldSol.length * 1.3)
    );

    // BUG-1 (1): 仅当调用方显式传入 root_cause 时才用新值；未传则保留库中原值（绝不拿 symptom 顶替）
    const explicitRc = hasExplicitRootCause ? scrubSecrets(rawRootCause) : "";
    const oldIsPlaceholder = isPlaceholderRootCause(oldRc, oldSym);
    const newIsReal = hasExplicitRootCause && explicitRc && !isPlaceholderRootCause(explicitRc, symptom);
    const isRootCauseReplaced = oldIsPlaceholder && Boolean(newIsReal);
    const isRootCauseExplicitUpdated = hasExplicitRootCause && Boolean(explicitRc) && explicitRc !== oldRc && !oldIsPlaceholder;

    if (isSolutionMoreDetailed || isRootCauseReplaced || isRootCauseExplicitUpdated) {
      const reasons = [];
      if (isSolutionMoreDetailed) reasons.push(`解法更详尽（长度由 ${oldSol.length} 增至 ${newSol.length}，≥1.3倍）`);
      if (isRootCauseReplaced) reasons.push(`根因替换占位（原根因: "${oldRc || '(空)'}" -> 新根因: "${explicitRc}"）`);
      else if (isRootCauseExplicitUpdated) reasons.push(`根因更新（原根因: "${oldRc || '(空)'}" -> 新根因: "${explicitRc}"）`);
      const reason = reasons.join("；");

      // BUG-1 (3): 演进时 tags 取并集
      const existingTags = String(dup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const incomingTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const mergedTags = Array.from(new Set([...existingTags, ...incomingTags])).join(", ");

      const updatePayload = {
        solution: (isSolutionMoreDetailed && newSol) ? newSol : oldSol,
        root_cause: (hasExplicitRootCause && explicitRc) ? explicitRc : oldRc,
        tags: mergedTags || dup.tags,
        recurrence: next,
        last_occurred_at: now,
        updated_at: now,
      };

      try {
        await client.update("pitfalls", dup.id, Object.assign({}, updatePayload, { updated_at: updatePayload.updated_at || nowSql() }));
        markRecent(recentKey);
        const out = await checkAndApplyIronlaw({
          action: "EVOLVED",
          id: dup.id,
          recurrence: next,
          reason,
          note: reason,
        }, next, dup.component || component, dup.symptom || symptom, updatePayload.root_cause, updatePayload.solution, updatePayload.tags);
        return jsonOut(out);
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    } else {
      try {
        await client.update("pitfalls", dup.id, { recurrence: next, last_occurred_at: now, updated_at: now });
        markRecent(recentKey);
        const out = await checkAndApplyIronlaw({
          action: "NOOP",
          id: dup.id,
          recurrence: next,
          note: dup.content_fingerprint === fp ? undefined : "语义相似踩坑去重命中，累加复发计数",
        }, next, dup.component || component, dup.symptom || symptom, dup.root_cause || rootCause, oldSol, dup.tags);
        return jsonOut(out);
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    }
  }

  let created;
  try {
    created = await client.create("pitfalls", {
      project, client: clientVal, component, symptom, root_cause: rootCause, solution,
      severity, error_type: errorType, tags, content_fingerprint: fp,
      recurrence: initialRecurrence, last_occurred_at: now,
      source_session: sourceSession,
      source_turn: sourceTurn,
      created_at: now, updated_at: now,
    });
  } catch (e) {
    if (/duplicate entry/i.test(String(e.message))) {
      markRecent(recentKey);
      const dup = rowsOf(await client.list("pitfalls", { project, limit: FETCH_LIMIT })).filter(
        (r) => !r.invalid_at && r.content_fingerprint === fp
      )[0];
      if (dup) {
        const next = (Number(dup.recurrence) || 1) + initialRecurrence;
        const oldSol = String(dup.solution || "").trim();
        const newSol = String(solution || "").trim();
        const oldRc = String(dup.root_cause || "").trim();
        const oldSym = String(dup.symptom || "").trim();

        const hasSolConflict = hasConflictingNumbers(oldSol, newSol);
        if (hasSolConflict) {
          try { await client.update("pitfalls", dup.id, { recurrence: next, last_occurred_at: now, updated_at: now }); } catch (_) {}
          const out = await checkAndApplyIronlaw({ action: "NOOP", id: dup.id, recurrence: next, note: "方案存在数字冲突，禁止演进覆盖，累加复发计数" }, next, dup.component || component, dup.symptom || symptom, dup.root_cause || rootCause, oldSol, dup.tags);
          return jsonOut(out);
        }

        const isSolutionMoreDetailed = !hasSolConflict && (
          (oldSol.length === 0 && newSol.length > 0) ||
          (oldSol.length > 0 && newSol.length >= oldSol.length * 1.3)
        );
        const explicitRc = hasExplicitRootCause ? scrubSecrets(rawRootCause) : "";
        const oldIsPlaceholder = isPlaceholderRootCause(oldRc, oldSym);
        const newIsReal = hasExplicitRootCause && explicitRc && !isPlaceholderRootCause(explicitRc, symptom);
        const isRootCauseReplaced = oldIsPlaceholder && Boolean(newIsReal);
        const isRootCauseExplicitUpdated = hasExplicitRootCause && Boolean(explicitRc) && explicitRc !== oldRc && !oldIsPlaceholder;

        if (isSolutionMoreDetailed || isRootCauseReplaced || isRootCauseExplicitUpdated) {
          const reasons = [];
          if (isSolutionMoreDetailed) reasons.push(`解法更详尽（长度由 ${oldSol.length} 增至 ${newSol.length}，≥1.3倍）`);
          if (isRootCauseReplaced) reasons.push(`根因替换占位（原根因: "${oldRc || '(空)'}" -> 新根因: "${explicitRc}"）`);
          else if (isRootCauseExplicitUpdated) reasons.push(`根因更新（原根因: "${oldRc || '(空)'}" -> 新根因: "${explicitRc}"）`);
          const reason = reasons.join("；");

          const existingTags = String(dup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
          const incomingTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
          const mergedTags = Array.from(new Set([...existingTags, ...incomingTags])).join(", ");

          try {
            await client.update("pitfalls", dup.id, {
              solution: (isSolutionMoreDetailed && newSol) ? newSol : oldSol,
              root_cause: (hasExplicitRootCause && explicitRc) ? explicitRc : oldRc,
              tags: mergedTags || dup.tags,
              recurrence: next,
              last_occurred_at: now,
              updated_at: now,
            });
          } catch (_) {}
          const out = await checkAndApplyIronlaw({ action: "EVOLVED", id: dup.id, recurrence: next, reason, note: reason }, next, dup.component || component, dup.symptom || symptom, (hasExplicitRootCause && explicitRc) ? explicitRc : oldRc, (isSolutionMoreDetailed && newSol) ? newSol : oldSol, mergedTags || dup.tags);
          return jsonOut(out);
        }

        try { await client.update("pitfalls", dup.id, { recurrence: next, last_occurred_at: now, updated_at: now }); } catch (_) {}
        const out = await checkAndApplyIronlaw({ action: "NOOP", id: dup.id, recurrence: next, note: "唯一索引拦下重复" }, next, dup.component || component, dup.symptom || symptom, dup.root_cause || rootCause, oldSol, dup.tags);
        return jsonOut(out);
      }
      return jsonOut({ action: "NOOP", id: null, note: "唯一索引拦下重复" });
    }
    throw e;
  }
  markRecent(recentKey);
  const out = await checkAndApplyIronlaw({ action: "ADD", id: created && (created.id || created.insertId) }, initialRecurrence, component, symptom, rootCause, solution, tags);
  return jsonOut(out);
}

async function pitfallSearch(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const rawQuery = String(args.query || "").trim();
  const origTerms = termsOf(rawQuery);
  const projectArg = args.project ? String(args.project).trim() : "";

  const fetchParams = {};
  if (args.client) fetchParams.client = String(args.client).trim();
  if (args.component) fetchParams.component = String(args.component).trim();

  let all = [];
  if (projectArg && projectArg !== "global") {
    // 跨项目全局穿透检索：支持 project IN (args.project, 'global')
    const [projRows, globalRows] = await Promise.all([
      fetchAll(client, "pitfalls", Object.assign({}, fetchParams, { project: projectArg })),
      fetchAll(client, "pitfalls", Object.assign({}, fetchParams, { project: "global" })),
    ]);
    const seen = new Set();
    for (const r of projRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.symptom}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
    for (const r of globalRows) {
      const uid = r.id != null ? r.id : `${r.project}:${r.symptom}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        all.push(r);
      }
    }
  } else {
    if (projectArg) fetchParams.project = projectArg;
    all = await fetchAll(client, "pitfalls", fetchParams);
  }

  let pool = all.filter((r) => !r.invalid_at);
  if (projectArg) {
    if (projectArg === "global") {
      pool = pool.filter((r) => String(r.project || "") === "global");
    } else {
      pool = pool.filter((r) => String(r.project || "") === projectArg || String(r.project || "") === "global");
    }
  }
  if (args.client) pool = pool.filter((r) => String(r.client || "") === String(args.client));
  if (args.component) pool = pool.filter((r) => String(r.component || "") === args.component);

  // 双路词面扩展打分：在线提炼模型改写自然语言查询（fail-open）
  let rewrittenInfo = null;
  let rewrittenTerms = [];
  if (rawQuery) {
    try {
      rewrittenInfo = await rewriteSearchQuery({
        query: rawQuery,
        options: cfg,
      });
      if (rewrittenInfo && rewrittenInfo.rewrittenQuery) {
        rewrittenTerms = termsOf(rewrittenInfo.rewrittenQuery);
      }
    } catch (_) {
      rewrittenInfo = null;
      rewrittenTerms = [];
    }
  }

  const hasOrig = origTerms.length > 0;
  const hasRewrite = rewrittenTerms.length > 0;

  const scored = pool
    .map((r) => {
      if (!hasOrig && !hasRewrite) {
        return { row: r, hit: 1, origHit: 1, rewriteHit: 0 };
      }
      const origHit = hasOrig ? scorePitfall(r, origTerms) : 0;
      const rewriteHit = hasRewrite ? scorePitfall(r, rewrittenTerms) : 0;

      let combinedHit = 0;
      if (hasOrig && hasRewrite) {
        combinedHit = origHit + rewriteHit;
      } else if (hasOrig) {
        combinedHit = origHit;
      } else if (hasRewrite) {
        combinedHit = rewriteHit;
      }

      return { row: r, hit: combinedHit, origHit, rewriteHit };
    })
    .filter((x) => x.hit > 0)
    .sort((a, b) => {
      if (projectArg && projectArg !== "global") {
        const aProj = String(a.row.project || "") === projectArg ? 1 : 0;
        const bProj = String(b.row.project || "") === projectArg ? 1 : 0;
        if (aProj !== bProj) return bProj - aProj;
      }
      return b.hit - a.hit || (Number(b.row.recurrence) || 0) - (Number(a.row.recurrence) || 0);
    });

  // 检索增强：调用模型重排候选踩坑
  let rerankUsed = false;
  let rerankModel = null;
  const shouldRerank = (args.search_rerank !== false) && (cfg.search_rerank !== false);
  if (shouldRerank && args.query && scored.length >= 1) {
    try {
      const candidatePool = scored.slice(0, Math.max(limit * 2, 20));
      const rerankRes = await rerankSearchResultsWithModel({
        query: String(args.query),
        candidates: candidatePool.map((x) => x.row),
        options: cfg,
        maxTop: limit,
      });
      if (rerankRes && Array.isArray(rerankRes.ranked) && rerankRes.ranked.length > 0) {
        rerankUsed = true;
        rerankModel = rerankRes.modelUsed;
        const scoreMap = new Map();
        for (const item of rerankRes.ranked) {
          scoreMap.set(item.id, item);
        }
        const topRanked = [];
        const restRanked = [];
        for (const x of scored) {
          if (scoreMap.has(x.row.id)) {
            const rInfo = scoreMap.get(x.row.id);
            topRanked.push(Object.assign({}, x, {
              _rerank_score: rInfo.score,
              _rerank_reason: rInfo.reason,
            }));
          } else {
            restRanked.push(x);
          }
        }
        topRanked.sort((a, b) => b._rerank_score - a._rerank_score);
        scored.length = 0;
        scored.push(...topRanked, ...restRanked);
      }
    } catch (_) {
      rerankUsed = false;
      rerankModel = null;
    }
  }

  const out = scored.slice(0, limit).map((x) => Object.assign({}, x.row, {
    _hit: x.hit,
    _rerank_score: x._rerank_score || null,
    _rerank_reason: x._rerank_reason || null,
  }));
  return jsonOut({
    total_pitfalls: all.length,
    matched: scored.length,
    returned: out.length,
    query_rewritten: rewrittenInfo ? rewrittenInfo.rewrittenQuery : null,
    rewrite_used: Boolean(rewrittenInfo && rewrittenInfo.rewrittenQuery),
    rerank_used: rerankUsed,
    rerank_model: rerankModel,
    pitfalls: out,
    _agent_hint: "若本次任务产出了新结论、配置变更或排障解法，请在结束前调用 memory_save 或 pitfall_save 沉淀。",
  });
}

/* 单条或批量读取（CCR 展开用），支持 memories 与 pitfalls 跨表读取 */
async function memoryGet(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const explicitTable = (rawArgs && rawArgs.table != null && String(rawArgs.table).trim() !== "")
    ? String(rawArgs.table).trim().toLowerCase()
    : null;
  const table = (explicitTable === "pitfalls") ? "pitfalls" : "memories";
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  const isBatch = Array.isArray(args.ids) || (args.ids != null && typeof args.ids === "string" && args.ids.includes(","));
  let targetIds = [];

  if (isBatch) {
    targetIds = (Array.isArray(args.ids) ? args.ids : String(args.ids).split(",")).map(Number).filter(Boolean);
  } else if (args.id != null) {
    const singleId = Number(args.id);
    if (!singleId) throw new Error("id 不能为空");
    targetIds = [singleId];
  } else {
    throw new Error("id 不能为空");
  }

  async function getSupersededHistory(hit) {
    if (Number(hit.revision) <= 1) return { history: null, note: null };
    try {
      const queryParams = { project: hit.project, limit: 100 };
      const allProjMemories = rowsOf(await client.list("memories", queryParams));
      const titleLower = String(hit.title || "").trim().toLowerCase();
      const predecessors = allProjMemories.filter((r) => {
        if (Number(r.id) === Number(hit.id)) return false;
        const isSuperBy = Number(r.superseded_by_id) === Number(hit.id);
        const isSameTitleSuperseded = r.lifecycle_status === "superseded" &&
          String(r.title || "").trim().toLowerCase() === titleLower;
        const isPriorRevision = Number(r.revision) < Number(hit.revision) &&
          String(r.title || "").trim().toLowerCase() === titleLower;
        return isSuperBy || isSameTitleSuperseded || isPriorRevision;
      });

      if (predecessors.length > 0) {
        predecessors.sort((a, b) => {
          const revDiff = (Number(b.revision) || 0) - (Number(a.revision) || 0);
          if (revDiff !== 0) return revDiff;
          return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
        });
        const history = predecessors.slice(0, 3).map((r) => ({
          revision: Number(r.revision) || 1,
          title: r.title,
          content: String(r.content || "").slice(0, 120),
          updated_at: r.updated_at,
        }));
        return { history, note: null };
      }
      return { history: [], note: "历史版本未持久化" };
    } catch (_) {
      return { history: [], note: "历史版本未持久化" };
    }
  }

  function formatMemoryRecord(hit, count, lastUsed, historyInfo) {
    const full = (hit.full_text != null && String(hit.full_text).trim() !== "")
      ? hit.full_text
      : hit.content;
    const rec = {
      id: hit.id,
      project: hit.project,
      category: hit.category,
      scope_level: hit.scope_level,
      client: hit.client || "unknown",
      origin: hit.origin || "tool",
      title: hit.title,
      content: full,
      summary: hit.content,
      full_text: full,
      tags: hit.tags,
      related_entities: hit.related_entities || "",
      retrieval_count: count,
      last_used_at: lastUsed,
      revision: Number(hit.revision) || 1,
      _note: "已返回完整原文（见 full_text 与 content），summary 为注入卡片所用摘要",
    };
    if (Number(hit.revision) > 1) {
      rec.superseded_history = (historyInfo && historyInfo.history) || [];
      if (historyInfo && historyInfo.note) {
        rec.note = historyInfo.note;
      }
    }
    return rec;
  }

  function formatPitfallRecord(hit, autoFallback = false) {
    const rec = {
      id: hit.id,
      project: hit.project,
      table: "pitfalls",
      component: hit.component || "general",
      symptom: hit.symptom,
      root_cause: hit.root_cause,
      solution: hit.solution,
      severity: hit.severity,
      error_type: hit.error_type,
      tags: hit.tags,
      recurrence: Number(hit.recurrence) || 1,
      title: `${hit.component || "general"}: ${hit.symptom}`,
      content: `【症状】${hit.symptom}\n【根因】${hit.root_cause}\n【解法】${hit.solution}`,
      full_text: `【症状】${hit.symptom}\n【根因】${hit.root_cause}\n【解法】${hit.solution}`,
      summary: `${hit.symptom} → ${hit.solution}`,
      invalid_at: hit.invalid_at || null,
      invalid_reason: hit.invalid_reason || "",
      last_occurred_at: hit.last_occurred_at || now,
      _note: "已返回踩坑排障完整记录",
    };
    if (autoFallback) {
      rec.auto_fallback = true;
    }
    return rec;
  }

  if (isBatch) {
    const items = [];
    for (const tid of targetIds) {
      let res = await client.list(table, { id: tid, limit: 1 });
      let hit = rowsOf(res).filter((r) => Number(r.id) === tid)[0];
      let isFallback = false;

      // BUG-4: 若未显式指定 table，且 memories 表查无此 id，自动回退到 pitfalls 表查找
      if (!hit && !explicitTable) {
        const pitRes = await client.list("pitfalls", { id: tid, limit: 1 });
        const pitHit = rowsOf(pitRes).filter((r) => Number(r.id) === tid)[0];
        if (pitHit) {
          hit = pitHit;
          isFallback = true;
        }
      }

      if (hit) {
        if (isFallback || table === "pitfalls") {
          items.push(formatPitfallRecord(hit, isFallback));
        } else {
          const count = (Number(hit.retrieval_count) || 0) + 1;
          try {
            await client.update("memories", tid, {
              retrieval_count: count,
              last_used_at: now,
            });
          } catch (_) {}
          const historyInfo = await getSupersededHistory(hit);
          items.push(formatMemoryRecord(hit, count, now, historyInfo));
        }
      }
    }
    return jsonOut(items);
  }

  // 单值 id 调用：必须完全兼容旧行为
  const singleId = targetIds[0];
  let res = await client.list(table, { id: singleId, limit: 1 });
  let hit = rowsOf(res).filter((r) => Number(r.id) === singleId)[0];
  let isFallback = false;

  // BUG-4: 若未显式指定 table，且 memories 表查无此 id，自动回退到 pitfalls 表查找
  if (!hit && !explicitTable) {
    const pitRes = await client.list("pitfalls", { id: singleId, limit: 1 });
    const pitHit = rowsOf(pitRes).filter((r) => Number(r.id) === singleId)[0];
    if (pitHit) {
      hit = pitHit;
      isFallback = true;
    }
  }

  if (!hit) throw new Error(`找不到 id=${singleId} 的${table === "pitfalls" ? "踩坑" : "记忆"}`);

  if (isFallback || table === "pitfalls") {
    return jsonOut(formatPitfallRecord(hit, isFallback));
  } else {
    const count = (Number(hit.retrieval_count) || 0) + 1;
    try {
      await client.update("memories", singleId, {
        retrieval_count: count,
        last_used_at: now,
      });
    } catch (_) {}
    const historyInfo = await getSupersededHistory(hit);
    return jsonOut(formatMemoryRecord(hit, count, now, historyInfo));
  }
}

/* 软失效：不物理删除，写 invalid_at，保留审计链，支持 memories 与 pitfalls 跨表软失效与批量失效 */
async function memoryForget(client, cfg, rawArgs) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const table = (args.table && String(args.table).trim().toLowerCase() === "pitfalls") ? "pitfalls" : "memories";
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  let targets = [];

  const isBatch = Array.isArray(args.ids) || (args.ids != null && typeof args.ids === "string" && args.ids.includes(","));
  if (isBatch) {
    const targetIds = (Array.isArray(args.ids) ? args.ids : String(args.ids).split(",")).map(Number).filter(Boolean);
    for (const tid of targetIds) {
      const rows = rowsOf(await client.list(table, { limit: 1, id: tid })).filter((r) => Number(r.id) === tid);
      if (rows.length > 0) targets.push(rows[0]);
    }
  } else if (args.id != null) {
    targets = rowsOf(await client.list(table, { limit: 1, id: Number(args.id) }))
      .filter((r) => Number(r.id) === Number(args.id));
  } else if (args.query) {
    const terms = termsOf(args.query);
    if (table === "memories") {
      const fetchParams = { lifecycle_status: "active" };
      if (args.project) fetchParams.project = String(args.project).trim();
      const all = await fetchAll(client, "memories", fetchParams);
      let pool = all;
      if (args.project) pool = pool.filter((r) => String(r.project || "") === String(args.project));
      targets = pool
        .map((r) => ({ row: r, hit: scoreMemory(r, terms) }))
        .filter((x) => x.hit > 0)
        .sort((a, b) => b.hit - a.hit)
        .slice(0, Math.max(1, Math.min(Number(args.limit) || 1, 20)))
        .map((x) => x.row);
    } else {
      const fetchParams = {};
      if (args.project) fetchParams.project = String(args.project).trim();
      const all = await fetchAll(client, "pitfalls", fetchParams);
      let pool = all.filter((r) => !r.invalid_at);
      if (args.project) pool = pool.filter((r) => String(r.project || "") === String(args.project));
      targets = pool
        .map((r) => ({ row: r, hit: scorePitfall(r, terms) }))
        .filter((x) => x.hit > 0)
        .sort((a, b) => b.hit - a.hit)
        .slice(0, Math.max(1, Math.min(Number(args.limit) || 1, 20)))
        .map((x) => x.row);
    }
  } else {
    throw new Error("需要 id、ids 或 query 之一");
  }
  if (!targets.length) return jsonOut({ action: "NOT_FOUND", table, forgotten: 0 });

  const done = [];
  for (const t of targets) {
    try {
      if (table === "memories") {
        await client.update("memories", t.id, {
          invalid_at: now, lifecycle_status: "invalid", invalid_reason: "user_forgot",
          updated_at: now,          // NCB 不生效 ON UPDATE CURRENT_TIMESTAMP，必须显式写
        });
        done.push({ id: t.id, title: t.title });
      } else {
        await client.update("pitfalls", t.id, {
          invalid_at: now,
          invalid_reason: "user_forgot",
          updated_at: now,
        });
        done.push({ id: t.id, title: t.symptom || t.title, symptom: t.symptom });
      }
    } catch (e) { /* 单条失败不影响其余 */ }
  }
  return jsonOut({
    action: "SOFT_DELETE",
    table,
    forgotten: done.length,
    items: done,
    note: "已软失效（写 invalid_at），记录保留可追溯，中间件不再注入",
  });
}

/* ================================================================== *
 * 全自动去重与撤销回滚
 * ================================================================== */

/** 计算定时去重范围 (daily: -24h, weekly: -7d, monthly: -30d) */
export function getDedupTimeWindow(schedule, now = new Date()) {
  if (!schedule || typeof schedule !== "string") return null;
  const sched = schedule.toLowerCase().trim();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (sched === "daily") {
    return new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  }
  if (sched === "weekly") {
    return new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  }
  if (sched === "monthly") {
    return new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  }
  return null;
}

/** 判定当前是否满足定时去重触发条件 (超期 / 设定时段到达) */
export function isDedupDue(opts) {
  if (!opts || typeof opts !== "object" || typeof opts.schedule !== "string") return false;
  const { schedule, time, weekday, day, lastDedupAt, now = new Date() } = opts;
  const sched = schedule.toLowerCase().trim();
  if (!sched || sched === "off" || sched === "none") return false;

  const curDate = now instanceof Date ? now : new Date(now);
  const nowTs = curDate.getTime();
  const lastTs = lastDedupAt ? new Date(lastDedupAt).getTime() : 0;

  let targetH = 2, targetM = 0;
  if (time && typeof time === "string") {
    const m = time.trim().match(/^(\d{1,2}):(\d{1,2})$/);
    if (m) {
      targetH = Math.min(23, Math.max(0, parseInt(m[1], 10)));
      targetM = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    }
  }

  const todayTarget = new Date(curDate.getFullYear(), curDate.getMonth(), curDate.getDate(), targetH, targetM, 0).getTime();

  if (sched === "daily") {
    const over24h = (nowTs - lastTs) >= 24 * 60 * 60 * 1000;
    const reachedToday = (nowTs >= todayTarget) && (lastTs < todayTarget);
    return over24h || reachedToday;
  }

  if (sched === "weekly") {
    const targetWeekday = Math.min(7, Math.max(1, parseInt(weekday, 10) || 1));
    const curWeekday = curDate.getDay() === 0 ? 7 : curDate.getDay();
    const over7d = (nowTs - lastTs) >= 7 * 24 * 60 * 60 * 1000;
    const isTargetDay = curWeekday === targetWeekday;
    const reachedTarget = isTargetDay && (nowTs >= todayTarget) && (lastTs < todayTarget);
    return over7d || reachedTarget;
  }

  if (sched === "monthly") {
    const targetDay = Math.min(28, Math.max(1, parseInt(day, 10) || 1));
    const curDay = curDate.getDate();
    const over30d = (nowTs - lastTs) >= 30 * 24 * 60 * 60 * 1000;
    const isTargetDay = curDay === targetDay;
    const reachedTarget = isTargetDay && (nowTs >= todayTarget) && (lastTs < todayTarget);
    return over30d || reachedTarget;
  }

  return false;
}

/** 撤销去重：时间点回滚 / 撤销最近一次批次 */
export async function memoryAuditUndo(client, cfg, args) {
  args = args || {};
  if (!client || typeof client !== "object" || typeof client.list !== "function") {
    return jsonOut({ action: "DEDUP_UNDONE", success: false, data_changed: false,
      restored_records: 0, undone_recurrence: 0, skipped: 0,
      note: "无可用数据库客户端，已跳过撤销（不影响插件加载）" });
  }
  const project = String(args.project || (cfg && cfg.project) || "global").trim();
  const auditState = lookupAuditState();
  let rollingLogs = Array.isArray(auditState.logs) ? [...auditState.logs] : [];

  let cutoffTs = null;
  if (args.undo_before) {
    const s = String(args.undo_before).trim();
    if (/^\d{10,13}$/.test(s)) {
      cutoffTs = Number(s);
    } else {
      let iso = s.replace(" ", "T");
      if (!iso.includes("Z") && !/[+-]\d{2}(?::?\d{2})?$/.test(iso)) {
        iso += "Z";
      }
      const t = Date.parse(iso);
      cutoffTs = isNaN(t) ? new Date(s).getTime() : t;
    }
  }

  async function fetchInvalidCandidates(table) {
    const candidates = [];
    let lastId = 0;
    while (true) {
      const q = { project, since_id: lastId, limit: 1000, order_by: "id ASC" };
      const res = await client.list(table, q);
      const rows = rowsOf(res);
      if (!rows.length) break;
      for (const r of rows) {
        lastId = r.id;
        if (!r.invalid_at) continue;
        const reason = String(r.invalid_reason || "");
        const m = reason.match(/^dedup:(\d+):into:(\d+)$/);
        if (m) {
          candidates.push({
            id: r.id,
            table,
            batchTs: Number(m[1]),
            primaryId: Number(m[2]),
            row: r,
          });
        }
      }
      if (rows.length < 1000) break;
    }
    return candidates;
  }

  const memCandidates = await fetchInvalidCandidates("memories");
  const pitCandidates = await fetchInvalidCandidates("pitfalls");
  const allCandidates = memCandidates.concat(pitCandidates);

  let targetCandidates = [];
  if (cutoffTs !== null) {
    targetCandidates = allCandidates.filter((c) => c.batchTs >= cutoffTs);
  } else {
    let latestBatchTs = 0;
    for (const c of allCandidates) {
      if (c.batchTs > latestBatchTs) latestBatchTs = c.batchTs;
    }
    if (!latestBatchTs && auditState.last_dedup_batch_ts) {
      latestBatchTs = Number(auditState.last_dedup_batch_ts);
    }
    if (latestBatchTs) {
      targetCandidates = allCandidates.filter((c) => c.batchTs === latestBatchTs);
    }
  }

  if (targetCandidates.length === 0) {
    const note = "已恢复 0 条 · 撤销 recurrence 0 次 · 跳过 0 条（未找到符合条件的去重记录）";
    return jsonOut({
      action: "DEDUP_UNDONE",
      success: true,
      data_changed: false,
      restored_records: 0,
      undone_recurrence: 0,
      skipped: 0,
      note,
      lines: [note, "状态: 已完成"],
      logs: rollingLogs,
    });
  }

  let restoredCount = 0;
  let undoneRecurrence = 0;
  let skippedCount = 0;
  const now = nowSql();

  const memPrimaryMap = new Map();
  const pitPrimaryMap = new Map();

  for (const c of targetCandidates) {
    try {
      const dupRec = Number(c.row?.recurrence) || 1;
      if (c.table === "memories") {
        await client.update("memories", c.id, {
          invalid_at: null,
          lifecycle_status: "active",
          invalid_reason: null,
          updated_at: now,
        });
        restoredCount++;
        const cur = memPrimaryMap.get(c.primaryId) || { count: 0, rec: 0 };
        cur.count += 1;
        cur.rec += dupRec;
        memPrimaryMap.set(c.primaryId, cur);
      } else if (c.table === "pitfalls") {
        await client.update("pitfalls", c.id, {
          invalid_at: null,
          invalid_reason: null,
          updated_at: now,
        });
        restoredCount++;
        const cur = pitPrimaryMap.get(c.primaryId) || { count: 0, rec: 0 };
        cur.count += 1;
        cur.rec += dupRec;
        pitPrimaryMap.set(c.primaryId, cur);
      }
    } catch (_) {}
  }

  async function rollbackPrimaries(table, primaryMap) {
    for (const [pId, info] of primaryMap.entries()) {
      try {
        const rows = rowsOf(await client.list(table, { project, id: pId }));
        const pRow = rows[0];
        if (!pRow || pRow.invalid_at || pRow.lifecycle_status === "invalid" || pRow.lifecycle_status === "superseded") {
          skippedCount += info.count;
          continue;
        }
        const curRec = Number(pRow.recurrence) || 1;
        const newRec = Math.max(1, curRec - info.rec);
        await client.update(table, pId, {
          recurrence: newRec,
          updated_at: now,
        });
        undoneRecurrence += (curRec - newRec);
      } catch (_) {
        skippedCount += info.count;
      }
    }
  }

  await rollbackPrimaries("memories", memPrimaryMap);
  await rollbackPrimaries("pitfalls", pitPrimaryMap);

  const note = `已恢复 ${restoredCount} 条 · 撤销 recurrence ${undoneRecurrence} 次 · 跳过 ${skippedCount} 条`;
  rollingLogs.push(`[${now}] 撤销去重完成：${note}`);
  if (rollingLogs.length > 30) rollingLogs = rollingLogs.slice(-30);

  rememberAuditState({
    last_dedup_at: now,
    last_undo_at: now,
    logs: rollingLogs,
  });

  try {
    writeCardStatus("audit", {
      ok: true,
      at: Date.now(),
      op: "memory_audit",
      title: "去重撤销已完成",
      status: "已完成", // db-col-ok: 去重任务运行状态
      lines: [note, "状态: 已完成"],
      logs: rollingLogs,
    });
  } catch (_) {}

  return jsonOut({
    action: "DEDUP_UNDONE",
    success: true,
    data_changed: restoredCount > 0,
    restored_records: restoredCount,
    undone_recurrence: undoneRecurrence,
    skipped: skippedCount,
    note,
    lines: [note, "状态: 已完成"],
    logs: rollingLogs,
  });
}

let _isAuditing = false;

/**
 * 全自动去重：单次模型调用判定并立即合并，分批支持全量与定时下推，绝不物理删
 */
export async function memoryAudit(client, cfg, args, ctx) {
  args = args || {};
  if (!client || typeof client !== "object" || typeof client.list !== "function") {
    return jsonOut({ action: "DEDUP_REPORT", success: false, data_changed: false,
      batch: "0/0", dedup_state: "skipped", note: "无可用数据库客户端，已跳过去重（不影响插件加载）" });
  }
  if (args && (args.undo === true || args.undo_before)) {
    return await memoryAuditUndo(client, cfg, args);
  }
  if (_isAuditing) {
    return jsonOut({
      action: "DEDUP_REPORT",
      success: true,
      data_changed: false,
      skipped: true,
      reason: "audit_in_progress",
      status: "跳过", // db-col-ok: 去重任务运行状态
      note: "去重任务正在执行中，已跳过并发重入请求",
    });
  }
  _isAuditing = true;

  try {
    const project = String(args.project || (cfg && cfg.project) || "global").trim();
    // 【v6.3.1 解耦】「DB 拉取批」与「模型分块」
    // a) dbFetchLimit：只管从数据库拉取多少条数据（默认 200，上限 1000）
    // 【P1-2】优先级：用户显式传 args.fetch_limit > 用户配置的 dedup_batch_size > dedup_fetch_limit > 200
    const explicitFetchLimit = args && (args.fetch_limit || args.limit || args.batch_size);
    const configuredUserBatchSize = (args && args.dedup_batch_size) || (cfg && (Number(cfg.dedup_batch_size) !== 50 ? cfg.dedup_batch_size : null));
    const configuredFetchLimit = (args && args.dedup_fetch_limit) || (cfg && cfg.dedup_fetch_limit);
    const dbFetchLimit = Math.max(1, Math.min(Number(
      explicitFetchLimit ||
      configuredUserBatchSize ||
      configuredFetchLimit ||
      (cfg && cfg.dedup_batch_size) ||
      200
    ), 1000));
    const maxModelBatches = Math.max(1, Math.min(Number(args.audit_max_batches || args.max_model_batches || args.max_batches || cfg.audit_max_batches || 2), 10));
    const batchTs = Date.now();
    const now = nowSql();

    const isIncremental = args.incremental === true;
    let cursor = isIncremental
      ? getAuditCursor(project)
      : { last_memory_id: null, last_pitfall_id: null, last_id: null, last_updated_at: "", reviewed_count: 0 };
    if (args.since_id != null && Number(args.since_id) > 0) {
      const sId = Number(args.since_id);
      cursor = { last_memory_id: sId, last_pitfall_id: sId, last_id: sId, last_updated_at: "", reviewed_count: 0 };
    }
    if (args.full === true) {
      clearAuditCursor(project);
      cursor = { last_memory_id: null, last_pitfall_id: null, last_id: null, last_updated_at: "", reviewed_count: 0 };
    }

  let timeFilter = null;
  if (args.updated_after && typeof args.updated_after === "string") {
    timeFilter = args.updated_after.trim();
  } else if (args.schedule) {
    timeFilter = getDedupTimeWindow(args.schedule);
  } else if (args.since_days && Number(args.since_days) > 0) {
    const d = new Date(Date.now() - Number(args.since_days) * 86400000);
    timeFilter = d.toISOString().slice(0, 19).replace("T", " ");
  }

  const auditState = lookupAuditState();
  let rollingLogs = Array.isArray(auditState.logs) ? [...auditState.logs] : [];

  let totalScannedMemories = 0;
  let totalDedupedMemories = 0;
  let totalScannedPitfalls = 0;
  let totalDedupedPitfalls = 0;

  const allDedupedMemIds = [];
  const allDedupedPitIds = [];

  // ==========================================
  // 分批处理 memories
  // ==========================================
  let memLastId = isIncremental && Number(cursor.last_memory_id ?? cursor.last_id) > 0 ? Number(cursor.last_memory_id ?? cursor.last_id) : null;
  let memBatchNum = 0;
  let memTruncated = false;
  while (true) {
    memBatchNum++;
    const q = {
      project,
      lifecycle_status: "active",
      invalid_at: null,
      limit: dbFetchLimit,
      order_by: "id ASC",
      columns: [
        "id", "project", "category", "scope_level", "client", "origin",
        "title", "content", "full_text", "tags", "confidence_score",
        "recurrence", "content_fingerprint", "updated_at", "lifecycle_status",
        "related_entities", "invalid_at", "expires_at"
      ],
    };
    if (memLastId) q.since_id = memLastId;
    if (timeFilter) q.updated_after = timeFilter;

    const rawRows = rowsOf(await client.list("memories", q));
    const rows = rawRows.filter((r) => r.lifecycle_status === "active" && !r.invalid_at);
    if (!rawRows.length) break;
    memLastId = rawRows[rawRows.length - 1].id;
    totalScannedMemories += rows.length;

    // b) 内存中全量规则级查重（指纹相同 / 归一化标题相同 / tags 交集）覆盖整批记录
    const batchDupIds = new Set();
    const groups = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      if (batchDupIds.has(a.id)) continue;
      const grp = [a];
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j];
        if (batchDupIds.has(b.id)) continue;
        if (hasConflictingNumbers(a.title, b.title)) continue;
        const contentA = a.content || a.full_text || "";
        const contentB = b.content || b.full_text || "";
        if (hasConflictingNumbers(contentA, contentB)) continue;
        const sameFp = a.content_fingerprint && b.content_fingerprint && a.content_fingerprint === b.content_fingerprint;
        const normTitleA = normalizeSemanticText(a.title);
        const normTitleB = normalizeSemanticText(b.title);
        const sameTitle = normTitleA && normTitleB && normTitleA === normTitleB && !hasConflictingNumbers(a.title, b.title) && !hasConflictingNumbers(contentA, contentB);
        const similar = isSemanticallySimilar(a.title, a.content || a.full_text, b.title, b.content || b.full_text);
        const tagIntersect = hasTagsIntersection(a.tags, b.tags);
        const titleOverlap = Boolean(normTitleA && normTitleB && (normTitleA.includes(normTitleB) || normTitleB.includes(normTitleA)));
        if (sameFp || sameTitle || similar || (tagIntersect && titleOverlap && !hasConflictingNumbers(a.title, b.title) && !hasConflictingNumbers(contentA, contentB))) {
          grp.push(b);
          batchDupIds.add(b.id);
        }
      }
      if (grp.length > 1) {
        batchDupIds.add(a.id);
        // 【P1-3】若组内存在 category === "principle"，必须强制选它为 primary，绝不允许 principle 被当作 duplicate 软失效
        grp.sort((x, y) => {
          const xIsPrinciple = x.category === "principle" ? 1 : 0;
          const yIsPrinciple = y.category === "principle" ? 1 : 0;
          if (xIsPrinciple !== yIsPrinciple) return yIsPrinciple - xIsPrinciple;
          return (Number(y.recurrence) || 1) - (Number(x.recurrence) || 1) || (new Date(y.updated_at) - new Date(x.updated_at));
        });
        groups.push({ primary: grp[0], duplicates: grp.slice(1) });
      }
    }

    // c) 模型仲裁：groups.length === 0 时不要直接跳过模型仲裁，仍应把整批交给 auditMemoriesWithModel 做一轮语义仲裁（受 maxModelBatches 预算约束）
    const auditOptions = Object.assign({}, cfg, args);
    const auditModel = String(auditOptions.audit_model || auditOptions.extract_model || "").trim();
    if (auditModel && auditModel !== "off" && auditModel !== "none" && rows.length > 1) {
      const candidateItemMap = new Map();
      let candidateList = [];
      for (const g of groups) {
        candidateItemMap.set(g.primary.id, g.primary);
        for (const d of g.duplicates) candidateItemMap.set(d.id, d);
      }
      // 【P1-2 a】未分组行也要按 chunk 送模型（预算仍受 maxModelBatches 约束）
      for (const r of rows) {
        if (!candidateItemMap.has(r.id)) {
          candidateItemMap.set(r.id, r);
        }
      }
      candidateList = Array.from(candidateItemMap.values());

      // 【P1-2】MODEL_CHUNK 增加 [5, 60] 范围守卫并锚定 audit_chunk_size
      const rawChunk = Number(auditOptions.audit_chunk_size ?? cfg.audit_chunk_size ?? 40);
        // 【时间预算】单次 memory_audit 的最坏耗时估算：
  // 2 次模型调用 × 15s = 30s < 55s（MCP 客户端硬超时），安全余量 25s。
  // 新增任何模型调用时必须重算此预算，绝不允许突破 55s。
const MODEL_CHUNK = Math.max(5, Math.min(Number.isFinite(rawChunk) ? rawChunk : 40, 60));
      const modelBudgetItems = maxModelBatches * MODEL_CHUNK;
      const forModel = candidateList.slice(0, modelBudgetItems);

      try {
        const modelRes = await auditMemoriesWithModel({ memories: forModel, pitfalls: [], options: auditOptions });
        if (modelRes && modelRes.result) {
          const mr = modelRes.result;
          const mDups = Array.isArray(mr.memory_duplicates)
            ? mr.memory_duplicates
            : (Array.isArray(mr.duplicate_groups) ? mr.duplicate_groups : []);
          if (mDups.length > 0) {
            // 【P1-2 b】remainingGroups 只剔除「已被模型明确处理过的 id」，不要把整组无条件丢弃
            // 【P1-1a】先用数字守卫预过滤模型幻觉组，只有「仍然有效」的组才记账。
            // 反例：模型把 3306 合进 3307 被守卫拒绝，但 3306 已被记为 handled，
            // 导致 3306 自身的精确重复组被拆毁 → 永久漏删。
            const validMDups = [];
            for (const dg of mDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              if (!pId || dIds.length === 0) continue;
              const pItemPre = rows.find((r) => r.id === pId) || candidateItemMap.get(pId);
              // 【P2-1a】模型可能捏造当前批次根本不存在的主记录 ID：此时绝不能放行该组，
              // 否则会把它记入 modelHandledIds，导致同 ID 的真实规则组被误判为「已处理」而拆毁。
              if (!pItemPre) {
                rollingLogs.push(`[${nowSql()}] 模型组主记录 ${pId} 不存在于本批次，已忽略（疑似幻觉）`);
                continue;
              }
              const pTitlePre = pItemPre.title || "";
              const pContentPre = pItemPre.content || pItemPre.full_text || "";
              // 【P1-1b】严格分字段校验（标题对标题、正文对正文），禁止跨字段拼接
              const keptDIds = dIds.filter((dId) => {
                if (dId === pId) return false;
                const dItemPre = rows.find((r) => r.id === dId) || candidateItemMap.get(dId);
                // 【P2-1b】模型捏造不存在的从记录 ID：剔除，不得计入 validMDups
                if (!dItemPre) return false;
                const dTitlePre = dItemPre.title || "";
                const dContentPre = dItemPre.content || dItemPre.full_text || "";
                return !hasConflictingNumbers(pTitlePre, dTitlePre)
                  && !hasConflictingNumbers(pContentPre, dContentPre);
              });
              if (keptDIds.length > 0) {
                validMDups.push({ primary_id: pId, duplicate_ids: keptDIds });
              } else {
                rollingLogs.push(`[${nowSql()}] 模型组被数字守卫拒绝（主记录 ${pId}），保留原规则组`);
              }
            }

            const modelHandledIds = new Set();
            for (const dg of validMDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              modelHandledIds.add(pId);
              for (const dId of dIds) {
                if (dId !== pId) modelHandledIds.add(dId);
              }
            }

            const remainingGroups = [];
            const orphanedDupsByPrimary = new Map();
            for (const g of groups) {
              if (modelHandledIds.has(g.primary.id)) {
                const unhandledDups = g.duplicates.filter((d) => !modelHandledIds.has(d.id));
                if (unhandledDups.length > 1) {
                  remainingGroups.push({ primary: unhandledDups[0], duplicates: unhandledDups.slice(1) });
                } else if (unhandledDups.length === 1) {
                  // 【P1-3 a】单条精确重复暂存，挂入主记录所属的模型组一起合并，杜绝漏删
                  const list = orphanedDupsByPrimary.get(g.primary.id) || [];
                  list.push(unhandledDups[0]);
                  orphanedDupsByPrimary.set(g.primary.id, list);
                }
              } else {
                const unhandledDups = g.duplicates.filter((d) => !modelHandledIds.has(d.id));
                if (unhandledDups.length > 0) {
                  remainingGroups.push({ primary: g.primary, duplicates: unhandledDups });
                }
              }
            }

            // 【P1-2 c】每处理一组就把 pId 也加入 modelDupIds，杜绝跨组主从互指
            const modelDupIds = new Set();
            for (const rg of remainingGroups) {
              modelDupIds.add(rg.primary.id);
              for (const d of rg.duplicates) modelDupIds.add(d.id);
            }

            const attachedOrphanIds = new Set();
            for (const dg of validMDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              if (pId && dIds.length > 0 && !modelDupIds.has(pId)) {
                let pItem = rows.find((r) => r.id === pId) || candidateItemMap.get(pId);
                const dItems = (forModel.length ? forModel : rows).filter(
                  (r) => dIds.includes(r.id) && r.id !== pId && !modelDupIds.has(r.id)
                );
                for (const dId of dIds) {
                  if (dId !== pId && !modelDupIds.has(dId) && !dItems.some((r) => r.id === dId)) {
                    const fallbackItem = rows.find((r) => r.id === dId) || candidateItemMap.get(dId);
                    if (fallbackItem) dItems.push(fallbackItem);
                  }
                }

                // 【P1-3 a】把主记录所属的孤儿精确重复副本挂入当前模型组
                const candidatePrimaryIds = [pId, ...dItems.map((d) => d.id)];
                for (const candId of candidatePrimaryIds) {
                  const orphans = orphanedDupsByPrimary.get(candId);
                  if (orphans && orphans.length > 0) {
                    for (const orphan of orphans) {
                      if (!modelDupIds.has(orphan.id) && !dItems.some((d) => d.id === orphan.id) && orphan.id !== pId) {
                        dItems.push(orphan);
                        attachedOrphanIds.add(orphan.id);
                      }
                    }
                  }
                }

                // 【P1-3】组内存在 principle 时强制将其选为 primary
                if (pItem && pItem.category !== "principle") {
                  const princIdx = dItems.findIndex((d) => d.category === "principle");
                  if (princIdx >= 0) {
                    const princItem = dItems[princIdx];
                    dItems.splice(princIdx, 1, pItem);
                    pItem = princItem;
                  }
                }

                // 【P1-3 b】模型合并结果必须经过数字守卫校验，冲突则跳过合并
                const validDItems = [];
                if (pItem) {
                  const pTitle = pItem.title || "";
                  const pContent = pItem.content || pItem.full_text || "";

                  // 【P1-1b】严格分字段校验，删除跨字段拼接 pAllText/dAllText：
                  // 拼接后「方案多了『重试 3 次』」会让数字集合大小不同而被误判冲突
                  for (const d of dItems) {
                    const dTitle = d.title || "";
                    const dContent = d.content || d.full_text || "";

                    const hasNumConflict =
                      hasConflictingNumbers(pTitle, dTitle) ||
                      hasConflictingNumbers(pContent, dContent);

                    if (hasNumConflict) {
                      continue;
                    }
                    validDItems.push(d);
                  }
                }

                if (pItem && validDItems.length > 0) {
                  modelDupIds.add(pItem.id);
                  for (const d of validDItems) modelDupIds.add(d.id);
                  remainingGroups.push({ primary: pItem, duplicates: validDItems });
                }
              }
            }

            // 若有未挂载到任何模型组的孤儿精确重复，安全回退合并
            for (const [primId, orphans] of orphanedDupsByPrimary.entries()) {
              const unattached = orphans.filter((o) => !attachedOrphanIds.has(o.id) && !modelDupIds.has(o.id));
              if (unattached.length > 0) {
                const primItem = rows.find((r) => r.id === primId) || candidateItemMap.get(primId);
                if (primItem && !modelDupIds.has(primItem.id)) {
                  remainingGroups.push({ primary: primItem, duplicates: unattached });
                  modelDupIds.add(primItem.id);
                  for (const u of unattached) modelDupIds.add(u.id);
                } else if (unattached.length > 1) {
                  remainingGroups.push({ primary: unattached[0], duplicates: unattached.slice(1) });
                }
              }
            }

            groups.length = 0;
            groups.push(...remainingGroups);
          }
        }
      } catch (err) {
        rollingLogs.push(`[${nowSql()}] 模型不可用或超预算，安全跳过在线模型并使用规则查重: ${(err && err.message) || err}`);
      }
    }

    for (const g of groups) {
      const p = g.primary;
      const dups = g.duplicates;
      for (const d of dups) {
        if (!d || d.id === p.id) continue; // 双保险：杜绝自删/自失效主记录
        if (d.category === "principle") continue; // 准则保护：绝不软失效准则
        try {
          await client.update("memories", d.id, {
            invalid_at: now,
            lifecycle_status: "invalid",
            invalid_reason: `dedup:${batchTs}:into:${p.id}`,
            updated_at: now,
          });
          totalDedupedMemories++;
          allDedupedMemIds.push(d.id);
        } catch (_) {}
      }
      try {
        const validDups = dups.filter((d) => d && d.id !== p.id && d.category !== "principle");
        const dupRecurrenceSum = validDups.reduce((acc, d) => acc + (Number(d.recurrence) || 1), 0);
        const nextRec = (Number(p.recurrence) || 1) + dupRecurrenceSum;
        const mergedTags = mergeCommaSeparated(p.tags, ...validDups.map((d) => d.tags));
        const mergedEntities = mergeCommaSeparated(p.related_entities, ...validDups.map((d) => d.related_entities));
        await client.update("memories", p.id, {
          recurrence: nextRec,
          updated_at: now,
          ...(mergedTags ? { tags: mergedTags } : {}),
          ...(mergedEntities ? { related_entities: mergedEntities.slice(0, 500) } : {}),
        });
      } catch (_) {}
    }

    const batchDedupCount = groups.reduce((acc, g) => acc + g.duplicates.length, 0);
    rollingLogs.push(`[${nowSql()}] 记忆批次 ${memBatchNum} 完成：扫描 ${rows.length} 条，合并 ${batchDedupCount} 条`);
    if (rollingLogs.length > 30) rollingLogs = rollingLogs.slice(-30);

    try {
      writeCardStatus("audit", {
        ok: true,
        at: Date.now(),
        op: "memory_audit",
        title: "全自动去重进行中...",
        batch: `${memBatchNum}/-`,
        status: "进行中", // db-col-ok: 去重任务运行状态
        scanned: { memories: totalScannedMemories, pitfalls: totalScannedPitfalls },
        deduped: { memories: totalDedupedMemories, pitfalls: totalDedupedPitfalls },
        lines: [
          `扫描记忆: ${totalScannedMemories} 条 · 去重合并: ${totalDedupedMemories} 条`,
          `扫描踩坑: ${totalScannedPitfalls} 条 · 去重合并: ${totalDedupedPitfalls} 条`,
          `批次: ${memBatchNum}/-  ·  状态: 进行中`
        ],
        logs: rollingLogs,
      });
    } catch (_) {}

    if (rawRows.length < dbFetchLimit) break;
    memTruncated = true;
    break;
  }

  // 分批处理 pitfalls
  // ==========================================
  let pitLastId = isIncremental && Number(cursor.last_pitfall_id ?? cursor.last_id) > 0 ? Number(cursor.last_pitfall_id ?? cursor.last_id) : null;
  let pitBatchNum = 0;
  let pitTruncated = false;
  while (true) {
    pitBatchNum++;
    const q = {
      project,
      invalid_at: null,
      limit: dbFetchLimit,
      order_by: "id ASC",
    };
    if (pitLastId) q.since_id = pitLastId;
    if (timeFilter) q.updated_after = timeFilter;

    const rawRows = rowsOf(await client.list("pitfalls", q));
    const rows = rawRows.filter((r) => !r.invalid_at);
    if (!rawRows.length) break;
    pitLastId = rawRows[rawRows.length - 1].id;
    totalScannedPitfalls += rows.length;

    // b) 内存中全量规则级查重覆盖整批记录
    const batchDupIds = new Set();
    const groups = [];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      if (batchDupIds.has(a.id)) continue;
      const grp = [a];
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j];
        if (batchDupIds.has(b.id)) continue;
        // 【P1-1b】规则层同样必须分字段独立校验：
        // 拼接后「方案多了『重试 3 次』」会让数字集合大小不同而被误判冲突
        if (hasConflictingNumbers(a.symptom || "", b.symptom || "")) continue;
        if (hasConflictingNumbers(a.solution || "", b.solution || "")) continue;
        if (hasConflictingNumbers(a.root_cause || "", b.root_cause || "")) continue;
        const sameFp = a.content_fingerprint && b.content_fingerprint && a.content_fingerprint === b.content_fingerprint;
        const normSymA = normalizeSemanticText(a.symptom);
        const normSymB = normalizeSemanticText(b.symptom);
        const sameSym = normSymA && normSymB && normSymA === normSymB;
        const similar = isSemanticallySimilar(a.symptom, a.solution || a.root_cause, b.symptom, b.solution || b.root_cause);
        const tagIntersect = hasTagsIntersection(a.tags, b.tags);
        const symOverlap = Boolean(normSymA && normSymB && (normSymA.includes(normSymB) || normSymB.includes(normSymA)));
        if (sameFp || sameSym || similar || (tagIntersect && symOverlap)) {
          grp.push(b);
          batchDupIds.add(b.id);
        }
      }
      if (grp.length > 1) {
        batchDupIds.add(a.id);
        grp.sort((x, y) => (Number(y.recurrence) || 1) - (Number(x.recurrence) || 1) || (new Date(y.updated_at) - new Date(x.updated_at)));
        groups.push({ primary: grp[0], duplicates: grp.slice(1) });
      }
    }

    // c) 只把规则筛出的候选组交给 auditMemoriesWithModel 做模型仲裁（groups.length===0 时也不跳过，整批提交受预算约束）
    const auditOptions = Object.assign({}, cfg, args);
    const auditModel = String(auditOptions.audit_model || auditOptions.extract_model || "").trim();
    if (auditModel && auditModel !== "off" && auditModel !== "none" && rows.length > 1) {
      const candidateItemMap = new Map();
      let candidateList = [];
      for (const g of groups) {
        candidateItemMap.set(g.primary.id, g.primary);
        for (const d of g.duplicates) candidateItemMap.set(d.id, d);
      }
      // 【P1-2 a】未分组行也要按 chunk 送模型（预算仍受 maxModelBatches 约束）
      for (const r of rows) {
        if (!candidateItemMap.has(r.id)) {
          candidateItemMap.set(r.id, r);
        }
      }
      candidateList = Array.from(candidateItemMap.values());

      // 【P1-2】MODEL_CHUNK 增加 [5, 60] 范围守卫并锚定 audit_chunk_size
      const rawChunk = Number(auditOptions.audit_chunk_size ?? cfg.audit_chunk_size ?? 40);
      const MODEL_CHUNK = Math.max(5, Math.min(Number.isFinite(rawChunk) ? rawChunk : 40, 60));
      const modelBudgetItems = maxModelBatches * MODEL_CHUNK;
      const forModel = candidateList.slice(0, modelBudgetItems);

      try {
        const modelRes = await auditMemoriesWithModel({ memories: [], pitfalls: forModel, options: auditOptions });
        if (modelRes && modelRes.result) {
          const mr = modelRes.result;
          const pDups = Array.isArray(mr.pitfall_duplicates) ? mr.pitfall_duplicates : [];
          if (pDups.length > 0) {
            // 【P1-2 b】remainingGroups 只剔除「已被模型明确处理过的 id」，不要把整组无条件丢弃
            // 【P1-1a】同 memories：先校验后记账，被守卫拒绝的组不得抢先标记
            const validPDups = [];
            for (const dg of pDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              if (!pId || dIds.length === 0) continue;
              const pItemPre = rows.find((r) => r.id === pId) || candidateItemMap.get(pId);
              // 【P2-1c】同 memories：捏造的主记录 ID 必须丢弃，避免误拆真实规则组
              if (!pItemPre) {
                rollingLogs.push(`[${nowSql()}] 模型踩坑组主记录 ${pId} 不存在于本批次，已忽略（疑似幻觉）`);
                continue;
              }
              const pSymPre = pItemPre.symptom || "";
              const pSolPre = pItemPre.solution || "";
              const pRootPre = pItemPre.root_cause || "";
              // 【P1-1b】分字段独立校验：症状对症状、方案对方案、根因对根因
              const keptDIds = dIds.filter((dId) => {
                if (dId === pId) return false;
                const dItemPre = rows.find((r) => r.id === dId) || candidateItemMap.get(dId);
                // 【P2-1d】模型捏造不存在的从记录 ID：剔除
                if (!dItemPre) return false;
                return !hasConflictingNumbers(pSymPre, dItemPre.symptom || "")
                  && !hasConflictingNumbers(pSolPre, dItemPre.solution || "")
                  && !hasConflictingNumbers(pRootPre, dItemPre.root_cause || "");
              });
              if (keptDIds.length > 0) {
                validPDups.push({ primary_id: pId, duplicate_ids: keptDIds });
              } else {
                rollingLogs.push(`[${nowSql()}] 模型踩坑组被数字守卫拒绝（主记录 ${pId}），保留原规则组`);
              }
            }

            const modelHandledIds = new Set();
            for (const dg of validPDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              modelHandledIds.add(pId);
              for (const dId of dIds) {
                if (dId !== pId) modelHandledIds.add(dId);
              }
            }

            const remainingGroups = [];
            const orphanedDupsByPrimary = new Map();
            for (const g of groups) {
              if (modelHandledIds.has(g.primary.id)) {
                const unhandledDups = g.duplicates.filter((d) => !modelHandledIds.has(d.id));
                if (unhandledDups.length > 1) {
                  remainingGroups.push({ primary: unhandledDups[0], duplicates: unhandledDups.slice(1) });
                } else if (unhandledDups.length === 1) {
                  // 【P1-3 a】单条精确重复暂存，挂入主记录所属的模型组一起合并，杜绝漏删
                  const list = orphanedDupsByPrimary.get(g.primary.id) || [];
                  list.push(unhandledDups[0]);
                  orphanedDupsByPrimary.set(g.primary.id, list);
                }
              } else {
                const unhandledDups = g.duplicates.filter((d) => !modelHandledIds.has(d.id));
                if (unhandledDups.length > 0) {
                  remainingGroups.push({ primary: g.primary, duplicates: unhandledDups });
                }
              }
            }

            // 【P1-2 c】每处理一组就把 pId 也加入 modelDupIds，杜绝跨组主从互指
            const modelDupIds = new Set();
            for (const rg of remainingGroups) {
              modelDupIds.add(rg.primary.id);
              for (const d of rg.duplicates) modelDupIds.add(d.id);
            }

            const attachedOrphanIds = new Set();
            for (const dg of validPDups) {
              const pId = Number(dg.primary_id);
              const dIds = Array.isArray(dg.duplicate_ids) ? dg.duplicate_ids.map(Number) : [];
              if (pId && dIds.length > 0 && !modelDupIds.has(pId)) {
                let pItem = rows.find((r) => r.id === pId) || candidateItemMap.get(pId);
                const dItems = (forModel.length ? forModel : rows).filter(
                  (r) => dIds.includes(r.id) && r.id !== pId && !modelDupIds.has(r.id)
                );
                for (const dId of dIds) {
                  if (dId !== pId && !modelDupIds.has(dId) && !dItems.some((r) => r.id === dId)) {
                    const fallbackItem = rows.find((r) => r.id === dId) || candidateItemMap.get(dId);
                    if (fallbackItem) dItems.push(fallbackItem);
                  }
                }

                // 【P1-3 a】把主记录所属的孤儿精确重复副本挂入当前模型组
                const candidatePrimaryIds = [pId, ...dItems.map((d) => d.id)];
                for (const candId of candidatePrimaryIds) {
                  const orphans = orphanedDupsByPrimary.get(candId);
                  if (orphans && orphans.length > 0) {
                    for (const orphan of orphans) {
                      if (!modelDupIds.has(orphan.id) && !dItems.some((d) => d.id === orphan.id) && orphan.id !== pId) {
                        dItems.push(orphan);
                        attachedOrphanIds.add(orphan.id);
                      }
                    }
                  }
                }

                // 【P1-3 b】模型合并结果必须经过数字守卫校验，冲突则跳过合并
                const validDItems = [];
                if (pItem) {
                  const pSym = pItem.symptom || "";
                  const pSol = pItem.solution || "";
                  const pRoot = pItem.root_cause || "";

                  // 【P1-1b】分字段独立校验，删除跨字段拼接 pText/dText
                  for (const d of dItems) {
                    const hasNumConflict =
                      hasConflictingNumbers(pSym, d.symptom || "") ||
                      hasConflictingNumbers(pSol, d.solution || "") ||
                      hasConflictingNumbers(pRoot, d.root_cause || "");

                    if (hasNumConflict) {
                      continue;
                    }
                    validDItems.push(d);
                  }
                }

                if (pItem && validDItems.length > 0) {
                  modelDupIds.add(pItem.id);
                  for (const d of validDItems) modelDupIds.add(d.id);
                  remainingGroups.push({ primary: pItem, duplicates: validDItems });
                }
              }
            }

            // 若有未挂载到任何模型组的孤儿精确重复，安全回退合并
            for (const [primId, orphans] of orphanedDupsByPrimary.entries()) {
              const unattached = orphans.filter((o) => !attachedOrphanIds.has(o.id) && !modelDupIds.has(o.id));
              if (unattached.length > 0) {
                const primItem = rows.find((r) => r.id === primId) || candidateItemMap.get(primId);
                if (primItem && !modelDupIds.has(primItem.id)) {
                  remainingGroups.push({ primary: primItem, duplicates: unattached });
                  modelDupIds.add(primItem.id);
                  for (const u of unattached) modelDupIds.add(u.id);
                } else if (unattached.length > 1) {
                  remainingGroups.push({ primary: unattached[0], duplicates: unattached.slice(1) });
                }
              }
            }

            groups.length = 0;
            groups.push(...remainingGroups);
          }
        }
      } catch (err) {
        rollingLogs.push(`[${nowSql()}] 模型不可用或超预算，安全跳过在线模型并使用规则查重: ${(err && err.message) || err}`);
      }
    }

    for (const g of groups) {
      const p = g.primary;
      const dups = g.duplicates;
      for (const d of dups) {
        if (!d || d.id === p.id) continue; // 双保险：对 pitfalls remove/update 前再断言 d.id !== pId，绝不自删主记录
        try {
          await client.update("pitfalls", d.id, {
            invalid_at: now,
            invalid_reason: `dedup:${batchTs}:into:${p.id}`,
            updated_at: now,
          });
          totalDedupedPitfalls++;
          allDedupedPitIds.push(d.id);
        } catch (_) {}
      }
      try {
        const validDups = dups.filter((d) => d && d.id !== p.id);
        const dupRecurrenceSum = validDups.reduce((acc, d) => acc + (Number(d.recurrence) || 1), 0);
        const nextRec = (Number(p.recurrence) || 1) + dupRecurrenceSum;
        const mergedTags = mergeCommaSeparated(p.tags, ...validDups.map((d) => d.tags));
        await client.update("pitfalls", p.id, {
          recurrence: nextRec,
          updated_at: now,
          ...(mergedTags ? { tags: mergedTags } : {}),
        });
      } catch (_) {}
    }

    const batchDedupCount = groups.reduce((acc, g) => acc + g.duplicates.length, 0);
    rollingLogs.push(`[${nowSql()}] 踩坑批次 ${pitBatchNum} 完成：扫描 ${rows.length} 条，合并 ${batchDedupCount} 条`);
    if (rollingLogs.length > 30) rollingLogs = rollingLogs.slice(-30);

    try {
      writeCardStatus("audit", {
        ok: true,
        at: Date.now(),
        op: "memory_audit",
        title: "全自动去重进行中...",
        batch: `${memBatchNum + pitBatchNum}/-`,
        status: "进行中", // db-col-ok: 去重任务运行状态
        scanned: { memories: totalScannedMemories, pitfalls: totalScannedPitfalls },
        deduped: { memories: totalDedupedMemories, pitfalls: totalDedupedPitfalls },
        lines: [
          `扫描记忆: ${totalScannedMemories} 条 · 去重合并: ${totalDedupedMemories} 条`,
          `扫描踩坑: ${totalScannedPitfalls} 条 · 去重合并: ${totalDedupedPitfalls} 条`,
          `批次: ${memBatchNum + pitBatchNum}/-  ·  状态: 进行中`
        ],
        logs: rollingLogs,
      });
    } catch (_) {}

    if (rawRows.length < dbFetchLimit) break;
    pitTruncated = true;
    break;
  }

  const truncated = memTruncated || pitTruncated;
  const totalBatches = Math.max(1, memBatchNum + pitBatchNum);
  const totalDeduped = totalDedupedMemories + totalDedupedPitfalls;

  rollingLogs.push(`[${nowSql()}] 全自动去重已完成：记忆扫描 ${totalScannedMemories} 合并 ${totalDedupedMemories}，踩坑扫描 ${totalScannedPitfalls} 合并 ${totalDedupedPitfalls}`);
  if (rollingLogs.length > 30) rollingLogs = rollingLogs.slice(-30);

  rememberAuditState({
    last_audit_at: nowSql(),
    last_dedup_at: truncated ? (auditState.last_dedup_at || null) : nowSql(),
    last_dedup_pending: Boolean(truncated),
    last_dedup_batch_ts: batchTs,
    last_dedup_count: totalDeduped,
    last_dedup_ids: { memories: allDedupedMemIds, pitfalls: allDedupedPitIds },
    scanned: { memories: totalScannedMemories, pitfalls: totalScannedPitfalls },
    deduped: { memories: totalDedupedMemories, pitfalls: totalDedupedPitfalls },
    logs: rollingLogs,
  });

  const finalLines = [
    `扫描记忆: ${totalScannedMemories} 条 · 去重合并: ${totalDedupedMemories} 条`,
    `扫描踩坑: ${totalScannedPitfalls} 条 · 去重合并: ${totalDedupedPitfalls} 条`,
    truncated
      ? `批次: ${totalBatches} 批（本次预算 ${dbFetchLimit} 条）· 状态: 本轮完成，仍有剩余`
      : `批次: ${totalBatches}/${totalBatches}  ·  状态: 已完成`
  ];

  try {
    writeCardStatus("audit", {
      ok: true,
      at: Date.now(),
      op: "memory_audit",
      title: "全自动去重完成",
      batch: `${totalBatches}/${totalBatches}`,
      status: "已完成", // db-col-ok: 去重任务运行状态
      scanned: { memories: totalScannedMemories, pitfalls: totalScannedPitfalls },
      deduped: { memories: totalDedupedMemories, pitfalls: totalDedupedPitfalls },
      lines: finalLines,
      logs: rollingLogs,
    });
  } catch (_) {}

    const newMemLastId = memLastId || cursor.last_memory_id || null;
    const newPitLastId = pitLastId || cursor.last_pitfall_id || null;
    const maxIdSeen = Math.max(Number(newMemLastId) || 0, Number(newPitLastId) || 0, Number(cursor.last_id) || 0) || null;
    // 【P1-2】full:true 扫满 fetch_limit 截断退出时，必须保存游标（不能只在 isIncremental 时保存）
    if (isIncremental || truncated) {
      saveAuditCursor(project, {
        last_memory_id: newMemLastId,
        last_pitfall_id: newPitLastId,
        last_id: maxIdSeen,
        last_updated_at: nowSql(),
      });
    }

    return jsonOut({
      action: "DEDUP_REPORT",
      success: true,
      data_changed: totalDeduped > 0,
      batch: `${totalBatches}/${totalBatches}`,
      status: truncated ? "部分完成" : "已完成", // db-col-ok: 去重任务运行状态
      has_more: truncated,
      next_action: truncated
        ? "本轮已达单次拉取批上限（防 55s 超时），游标已保存。请再次调用 memory_audit（incremental: true）继续；或等待定时调度器每 5 分钟自动接力。"
        : "",
      incremental: isIncremental,
      cursor: {
        previous_last_memory_id: cursor.last_memory_id || null,
        previous_last_pitfall_id: cursor.last_pitfall_id || null,
        current_last_memory_id: newMemLastId,
        current_last_pitfall_id: newPitLastId,
        previous_last_id: Number(cursor.last_id) || 0,
        current_last_id: Number(maxIdSeen) || 0,
        batch_size: dbFetchLimit,
      },
      scanned: {
        memories: totalScannedMemories,
        pitfalls: totalScannedPitfalls,
      },
      deduped: {
        memories: totalDedupedMemories,
        pitfalls: totalDedupedPitfalls,
      },
      lines: finalLines,
      logs: rollingLogs,
      note: `全自动去重完成。扫描记忆 ${totalScannedMemories} 条，合并 ${totalDedupedMemories} 条；扫描踩坑 ${totalScannedPitfalls} 条，合并 ${totalDedupedPitfalls} 条。`,
    });
  } finally {
    _isAuditing = false;
  }
}

let _auditTimer = null;
let _auditSchedulerStarted = false;
let _auditOptionsGetter = null;
let _auditBaseClient = null;
let _auditBaseCfg = null;

function stopAuditScheduler() {
  if (_auditTimer) {
    clearInterval(_auditTimer);
    _auditTimer = null;
  }
  _auditSchedulerStarted = false;
  _auditOptionsGetter = null;
  _auditBaseClient = null;
  _auditBaseCfg = null;
  _isAuditing = false;
}

async function checkScheduledDedup(client, cfg) {
  const schedule = (cfg && (cfg.dedup_schedule || cfg.audit_interval || cfg.auditInterval)) || "off";
  if (schedule === "off" || schedule === "none") return null;

  const state = lookupAuditState();
  const isPending = Boolean(state && state.last_dedup_pending);
  const isDue = isPending || isDedupDue({
    schedule,
    time: cfg.dedup_time || "02:00",
    weekday: cfg.dedup_weekday || 1,
    day: cfg.dedup_day || 1,
    lastDedupAt: state.last_dedup_at || state.last_audit_at,
  });

  if (!isDue) {
    return { skipped: true, reason: "schedule_not_due", last_dedup_at: state.last_dedup_at || state.last_audit_at };
  }

  if (!client || typeof client.list !== "function") {
    return { skipped: true, reason: "client_not_ready" };
  }

  try {
    // 【P1-4】新周期首次触发（非 5 分钟截断接力）必须清空上一周期遗留的表尾游标，
    // 否则 incremental 会跳过 id <= oldMaxId 的全部既有记录，新周期体检形同虚设。
    if (!isPending) {
      try {
        clearAuditCursor(cfg.project || "global");
      } catch (_) {}
    }
    const updatedAfter = getDedupTimeWindow(schedule);
    const res = await memoryAudit(client, cfg, {
      project: cfg.project || "global",
      schedule,
      updated_after: updatedAfter,
      incremental: true,
      batch_size: cfg.dedup_batch_size || cfg.dedup_fetch_limit || 1000,
      fetch_limit: cfg.dedup_fetch_limit || 1000,
    });
    return res;
  } catch (err) {
    console.error("[memory-hub] checkScheduledDedup error:", (err && err.message) || err);
    return null;
  }
}

// 【P0-1】ensureAuditScheduler 闭包配置读取与动态刷新
function ensureAuditScheduler(client, cfg, optionsGetter) {
  if (optionsGetter) {
    _auditOptionsGetter = optionsGetter;
  }
  if (cfg) {
    _auditBaseCfg = cfg;
  }
  if (client) {
    _auditBaseClient = client;
  }

  function getFreshCfg() {
    let latest = _auditBaseCfg || cfg;
    try {
      const getter = _auditOptionsGetter || optionsGetter;
      if (typeof getter === "function") {
        const res = getter();
        if (res && typeof res === "object") latest = res;
      } else if (getter && typeof getter === "object") {
        latest = readOptions(getter);
      }
    } catch (_) {}
    return latest || _auditBaseCfg || cfg;
  }

  function getFreshClient(freshCfg) {
    try {
      if (freshCfg && isCfgShape(freshCfg)) {
        const c = makeClient(freshCfg);
        if (c && !c._isNoCredentials && typeof c.list === "function") return c;
      }
    } catch (_) {}
    const baseClient = _auditBaseClient || client;
    if (baseClient && typeof baseClient.list === "function") return baseClient;
    return null;
  }

  const runScheduled = async () => {
    const freshCfg = getFreshCfg();
    const schedNow = (freshCfg && (freshCfg.dedup_schedule || freshCfg.audit_interval || freshCfg.auditInterval)) || "off";
    if (schedNow === "off" || schedNow === "none") {
      stopAuditScheduler();
      return null;
    }
    const freshClient = getFreshClient(freshCfg);
    return await checkScheduledDedup(freshClient, freshCfg);
  };

  const currentCfg = getFreshCfg();
  const sched = (currentCfg && (currentCfg.dedup_schedule || currentCfg.audit_interval || currentCfg.auditInterval)) || "off";
  if (sched === "off" || sched === "none") {
    stopAuditScheduler();
    return { getFreshCfg, getFreshClient, started: false, stop: stopAuditScheduler, runScheduled };
  }

  if (_auditSchedulerStarted) {
    return { getFreshCfg, getFreshClient, started: true, stop: stopAuditScheduler, runScheduled };
  }
  _auditSchedulerStarted = true;

  if (!isTestMode()) {
    runScheduled().catch((e) => {
      console.error("[memory-hub] 启动去重检查跳过:", (e && e.message) || e);
    });

    _auditTimer = setInterval(() => {
      runScheduled().catch((e) => {
        console.error("[memory-hub] 定时去重跳过:", (e && e.message) || e);
      });
    }, 5 * 60 * 1000);
    if (_auditTimer && _auditTimer.unref) _auditTimer.unref();
  }

  return { getFreshCfg, getFreshClient, started: true, stop: stopAuditScheduler, runScheduled };
}

/* ================================================================== *
 * 工具清单（MCP 名 = magpie-memory-hub_<name>）
 * ================================================================== */

const TOOLS = {
  memory_save: {
    description:
      '【持久化沉淀】向记忆库写入一条长期事实、架构决策或工程规范。当确立了长期不变的偏好/规则时务必设 category="principle"（会被无条件置顶召回）；若同标题内容更新会自动保留历史版本(superseded)；入库前自动对密钥敏感词执行正则脱敏。',
    args: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名，默认 global" },
        category: { type: "string", enum: CATEGORIES, description: "记忆分类。principle=行为准则，会被无条件置顶注入" },
        scope_level: { type: "string", enum: SCOPES, description: "作用域层级，默认 project（可选 user, project, session, turn）" },
        client: { type: "string", description: "产生该记忆的客户端标识（如 minis、codex、claude 等，可选，默认取调用者智能体）" },
        title: { type: "string", description: "精简标题（<=40字）" },
        content: { type: "string", description: "记忆正文/摘要，要具体、可复用" },
        full_text: { type: "string", description: "完整原文（可选，未提供时默认等于 content）" },
        tags: { type: "string", description: "逗号分隔的检索关键词" },
        related_entities: { type: "string", description: "相关实体/技术栈" },
        confidence: { type: "number", description: "置信度 0~1，默认 1" },
        recurrence: { type: "integer", description: "观察与复发次数，默认 1" },
      },
      required: ["title", "content"],
    },
    run: (args, ctx) => memorySave(ctx._client, ctx._cfg, args, ctx),
  },

  memory_search: {
    description:
      '【深度记忆检索】根据关键词检索历史事实、决策与工程背景。支持双路查询分词 + 在线大模型重排(rerank)，支持跨项目全局穿透(project + global)与项目专属优先排序。回答项目历史背景前必调。',
    args: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，空格分隔多个" },
        project: { type: "string", description: "限定项目" },
        category: { type: "string", enum: CATEGORIES, description: "限定分类" },
        scope_level: { type: "string", enum: SCOPES, description: "限定作用域层级" },
        client: { type: "string", description: "限定客户端来源（如 minis、codex、claude）" },
        origin: { type: "string", enum: ["tool", "inline", "harvest"], description: "限定产生方式" },
        include_history: { type: "boolean", description: "是否包含已被 superseded 的历史版本" },
        limit: { type: "integer", description: "返回条数，默认 10，最大 50" },
        search_rerank: { type: "boolean", description: "是否使用在线模型进行语义相关度重排与挑选（默认 true，遇到故障 fail-open 回退纯词面）" },
      },
    },
    run: (args, ctx) => memorySearch(ctx._client, ctx._cfg, args),
  },

  memory_list: {
    description: '【知识总览】分页列出当前项目或全局的活跃记忆列表，按访问热度与新鲜度加权排序。用于快速了解当前项目已积累的知识全貌。',
    args: {
      type: "object",
      properties: {
        project: { type: "string", description: "限定项目" },
        client: { type: "string", description: "限定客户端来源（如 minis、codex、claude）" },
        limit: { type: "integer", description: "返回条数，默认 20，最大 100" },
      },
    },
    run: (args, ctx) => memoryList(ctx._client, ctx._cfg, args),
  },

  memory_context: {
    description: '【首选一站式上下文召回】开始分析项目、排查问题或编写代码前首选调用：一次调用同时召回当前项目的核心行为准则(principle)、历史相关记忆(memories)以及 Top 3 踩坑排障解法(pitfalls)，支持跨项目全局准则穿透兜底。',
    args: {
      type: "object",
      properties: {
        query: { type: "string", description: "当前任务关键词" },
        project: { type: "string", description: "限定项目" },
        max_items: { type: "integer", description: "最多条数，默认取插件配置" },
        max_chars: { type: "integer", description: "字符预算，默认取插件配置" },
      },
    },
    run: (args, ctx) => memoryContext(ctx._client, ctx._cfg, args),
  },

  memory_get: {
    description: '【记忆/踩坑全文查看】根据 ID 精确取出一条记录或通过 ids 批量取出多条完整正文。支持 table 参数跨表读取（"memories" | "pitfalls"，默认 memories）。调用后自动累加访问热度。',
    args: {
      type: "object",
      properties: {
        id: { type: "integer", description: "单条记录 id" },
        ids: { type: "array", items: { type: "integer" }, description: "批量读取记录 id 列表" },
        table: { type: "string", enum: ["memories", "pitfalls"], description: "目标表，支持 memories 或 pitfalls，默认 memories" },
      },
    },
    run: (args, ctx) => memoryGet(ctx._client, ctx._cfg, args),
  },

  memory_forget: {
    description: '【记忆软失效】将过时、失效或已被废弃的记忆标记为软失效（记录 invalid_at，绝不物理删除）。可通过 ID 精确失效或关键词匹配批量失效。支持 table 参数选择 memories 或 pitfalls 表。',
    args: {
      type: "object",
      properties: {
        id: { type: "integer", description: "按 id 精确失效（优先）" },
        ids: { type: "array", items: { type: "integer" }, description: "批量失效记录 id 列表" },
        query: { type: "string", description: "按关键词匹配失效" },
        limit: { type: "integer", description: "按关键词时最多失效几条，默认 1" },
        table: { type: "string", enum: ["memories", "pitfalls"], description: "目标表，支持 memories 或 pitfalls，默认 memories" },
      },
    },
    run: (args, ctx) => memoryForget(ctx._client, ctx._cfg, args),
  },

  memory_audit: {
    description:
      '【全自动去重巡检与撤销】对库内记忆与踩坑记录执行分批语义级查重合并（仅软失效保留审计痕迹），支持定时调度、多轮 recurrence 准确累加、游标断点续跑，以及按指定时间点一键撤销回滚。',
    args: {
      type: "object",
      properties: {
        project: { type: "string", description: "限定项目，默认 global" },
        full: { type: "boolean", description: "是否全库扫描去重（默认 true）" },
        batch_size: { type: "integer", description: "分批大小（50~1000，默认 1000）" },
        schedule: { type: "string", enum: ["off", "daily", "weekly", "monthly"], description: "定时调度模式" },
        updated_after: { type: "string", description: "仅去重指定时间戳之后变动的记录（如 daily/weekly/monthly 窗口）" },
        undo: { type: "boolean", description: "是否执行去重撤销（默认撤销最近一次去重批次）" },
        undo_before: { type: "string", description: "撤销指定时刻之后的所有去重（如 '2026-10-19 03:00'），还原至该时刻前状态" },
        since_days: { type: "integer", description: "仅去重最近 N 天变动的记录" },
        since_id: { type: "integer", description: "指定起始游标 ID" },
        apply: { type: "boolean", description: "兼容参数（当前默认全自动执行去重）" },
      },
    },
    run: (args, ctx) => memoryAudit(ctx._client, ctx._cfg, args, ctx),
  },

  pitfall_save: {
    description: '【避坑排障沉淀】记录工程报错与排障解法（仅需提供 symptom 与 solution，自动补齐 component 与 root_cause）。发现相似问题时自动累加复发次数(recurrence)；入库前自动对密钥与凭据脱敏。排查定位完 bug 后必须调用！',
    args: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名" },
        client: { type: "string", description: "产生该踩坑记录的客户端标识（可选）" },
        component: { type: "string", description: "出问题的组件（可选，默认 general）" },
        symptom: { type: "string", description: "错误现象或报错原文" },
        root_cause: { type: "string", description: "技术根因（可选，默认等于 symptom）" },
        solution: { type: "string", description: "已验证的解法" },
        severity: { type: "string", enum: SEVERITIES },
        error_type: { type: "string", description: "错误类型标签，便于聚类" },
        tags: { type: "string", description: "检索关键词" },
        source_session: { type: "string", description: "来源会话标识（如客户端会话 ID，可选）" },
        source_turn: { type: "integer", description: "来源会话轮次序号（从 1 起始，可选）" },
      },
      required: ["symptom", "solution"],
    },
    run: (args, ctx) => pitfallSave(ctx._client, ctx._cfg, args, ctx),
  },

  pitfall_search: {
    description: '【已知故障与避坑检索】遇到报错、排查故障或准备执行关键操作前调用：检索已知症状、错误信息、技术根因与已验证解法，支持在线大模型语义重排与全局避坑穿透。',
    args: {
      type: "object",
      properties: {
        query: { type: "string", description: "症状/根因/解法关键词" },
        project: { type: "string", description: "限定项目" },
        client: { type: "string", description: "限定客户端来源" },
        component: { type: "string", description: "限定组件" },
        limit: { type: "integer", description: "返回条数，默认 10" },
        search_rerank: { type: "boolean", description: "是否使用在线模型进行语义重排（默认 true）" },
      },
    },
    run: (args, ctx) => pitfallSearch(ctx._client, ctx._cfg, args),
  },

  /* ---------------- 数据库结构管理（需 MCP key） ---------------- */

  ncb_check: {
    description:
      '【数据库诊断】只读检测当前配置的 NoCodeBackend MCP 连通性与密钥有效性，检查目标数据库是否存在以及核心表/列/索引完整度。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "目标数据库实例名，默认取插件配置的 ncb_instance" },
        mcp_key: { type: "string", description: "待检测的 MCP Key（可选，默认取插件配置）" },
      },
    },
    run: (args, ctx) => ncbCheck(ctx._cfg, args),
  },

  db_status: {
    description: '【表结构差集检查】只读检查数据库表结构：对比当前实际结构与期望 schema 的差异（缺失表、缺失列、缺失索引），报告 Schema 版本号。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置的 ncb_instance" },
      },
    },
    run: (args, ctx) => dbStatus(ctx._cfg, args),
  },

  db_provision: {
    description: '【一键全自动建库】使用 MCP 凭据自动完成数据库创建与全量表结构初始化，内置重名冲突保护（默认 reuse 复用已有库不破坏数据）。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "要创建的数据库名（逻辑名即可，NCB 会自动加账号前缀）。默认取设置页的 ncb_instance" },
        on_exist: { type: "string", enum: ["reuse", "auto_rename", "fail"], description: "同名已存在时的策略，默认 reuse" },
        with_r2: { type: "boolean", description: "是否同时挂载 R2 存储，默认 false，需要时才挂" },
        bucket_name: { type: "string", description: "R2 bucket 名，默认由数据库名派生合规名称（如将下划线替换为连字符）" },
        public_url: { type: "string", description: "R2 公开域名，如 https://cdn.example.com" },
        account_id: { type: "string", description: "Cloudflare 账号 ID（账号已连接过可留空，会自动复用）" },
        access_key_id: { type: "string", description: "Cloudflare R2 Access Key ID（同上可留空）" },
        secret_access_key: { type: "string", description: "Cloudflare R2 Secret Access Key（同上可留空）" },
        region: { type: "string", enum: ["us", "eu"], description: "新库所在区域，默认 us" },
      },
    },
    run: (args, ctx) => dbProvision(ctx._cfg, args),
  },

  db_init: {
    description: '【幂等初始化】自动增量补齐缺失的核心表（memories/pitfalls/schema_meta）、字段与唯一索引。只增不删，库内已有数据和外来表完全不受影响。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
        dry_run: { type: "boolean", description: "只展示将要执行的 SQL，不真正执行" },
      },
    },
    run: (args, ctx) => dbInit(ctx._cfg, args),
  },

  db_reset: {
    description: "【破坏性清库】清空插件的三张核心表结构与全部数据（需传 confirm=\"RESET\" 二次确认，非管理员日常请勿调用）。",
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
        confirm: { type: "string", description: '确认串。必须精确等于 "RESET" 才会真正执行' },
      },
    },
    run: (args, ctx) => dbReset(ctx._cfg, args),
  },

  /* ---------------- R2 文件存储（需 MCP key） ---------------- */

  r2_check: {
    description:
      '【R2 连通性探针】通过上传并立即清理一个极小临时探针文件，只读检测 Cloudflare R2 对象存储通道与凭据真实可用性。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
        bucket_name: { type: "string", description: "自定义 bucket 名（可选）" },
        public_url: { type: "string", description: "自定义域名或公开 URL（可选）" },
        account_id: { type: "string", description: "临时测试的 Cloudflare 账号 ID（可选）" },
        access_key_id: { type: "string", description: "临时测试的 Cloudflare Access Key ID（可选）" },
        secret_access_key: { type: "string", description: "临时测试的 Cloudflare Secret Access Key（可选）" },
      },
    },
    run: (args, ctx) => r2Check(ctx._cfg, args),
  },

  storage_setup: {
    description: '【挂载 R2 存储桶】为数据库配置并挂载 Cloudflare R2 对象存储，自动创建 bucket 并配置 CORS 规则，挂载后紧接端到端真实上传探测验证。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
        bucket_name: { type: "string", description: "自定义 bucket 名，默认由数据库名派生合规名称（如将下划线替换为连字符）" },
        public_url: { type: "string", description: "自定义域名或 r2.dev 公开地址" },
      },
    },
    run: (args, ctx) => storageSetup(ctx._cfg, args),
  },

  storage_upload: {
    description: '【上传文件到 R2】把文本或二进制文件上传至 R2 存储桶并获取公开访问 URL。建议上传后将所得 URL 存为 category="fact" 的记忆。',
    args: {
      type: "object",
      properties: {
        filename: { type: "string", description: "文件名，如 report.pdf、dump.log" },
        content: { type: "string", description: "文件内容。文本直接给；二进制请给 base64 并设 encoding=base64。省略则返回 presigned URL" },
        encoding: { type: "string", enum: ["text", "base64"], description: "content 的编码方式，默认 text" },
        content_type: { type: "string", description: "MIME 类型，如 image/png、application/pdf" },
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
      },
      required: ["filename"],
    },
    run: (args, ctx) => storageUpload(ctx._cfg, args),
  },

  storage_list: {
    description: '【列出 R2 文件】列出当前数据库 R2 存储桶内的对象列表（包括文件名、大小、修改时间与公开访问链接）。',
    args: {
      type: "object",
      properties: { limit: { type: "integer", description: "最多返回几条，默认 100" } },
    },
    run: (args, ctx) => r2List(ctx._cfg, args),
  },

  storage_delete: {
    description: "【删除 R2 文件】从 R2 存储桶中删除指定 key 的对象文件（不可恢复，需传 confirm=\"DELETE\" 确认）。",
    args: {
      type: "object",
      properties: {
        key: { type: "string", description: "对象的 key（storage_list 返回的 key 字段）" },
        confirm: { type: "string", description: '确认串，必须精确等于 "DELETE"' },
      },
      required: ["key"],
    },
    run: (args, ctx) => r2Delete(ctx._cfg, args),
  },

  storage_guide: {
    description: '【R2 使用能力指引】查询 R2 存储的工作机制、凭据拆分规则（MCP 建桶 vs Secret Key 上传/删除）以及常见故障排查说明。',
    args: { type: "object", properties: {} },
    run: (args, ctx) => storageGuide(ctx._cfg),
  },

  harvest_gateway: {
    description: '【录制日志增量提炼】增量扫描 Magpie 网关录制的历史对话落盘文件，调用在线模型提炼其中的环境事实、架构决策与故障经验存入库。',
    args: {
      type: "object",
      properties: {
        dir: { type: "string", description: "自定义对话落盘目录路径（可选，默认自动探测）" },
        force_rescan: { type: "boolean", description: "是否强制重新扫描所有文件（忽略增量状态，默认 false）" },
        project: { type: "string", description: "项目命名空间（可选，默认 global）" },
        extract_model: { type: "string", description: "指定的在线提炼模型 ID（如 gpt-4o-mini、claude-3-5-sonnet，默认取插件设置页配置；未配置时安全跳过）" },
        min_evidence: { type: "number", description: "证据累计门禁阈值（默认 3；首次观察时不落盘，累计达到该次数才入库）" },
      },
    },
    run: (args, ctx) => harvestGateway(args, {
      _client: ctx._client,
      _cfg: ctx._cfg,
      _ctx: ctx._ctx,
      saveMemory,
      pitfallSave,
      signal: ctx.signal,
    }),
  },
};

/* ================================================================== *
 * 插件入口 —— 本文件唯一导出的函数
 * ================================================================== */

export const MagpieMemoryHub = async (input, options) => {
  const mergedOpts = Object.assign({}, input && typeof input === "object" ? input : {}, options && typeof options === "object" ? options : {});
  const cfg = readOptions(mergedOpts);
  const client = (mergedOpts && (mergedOpts._client || mergedOpts.client)) || makeClient(cfg);

  // 同步将当前库的前缀解析状态写入 _status.js，供设置页即时只读展示真实库名
  try {
    const rawDb = (options && (options.ncb_instance || options.instance)) || cfg.instance || "";
    if (rawDb) {
      const dbInfo = parseDbInfo(rawDb);
      writeCardStatus("db", dbInfo);
    }
  } catch (e) {
    console.error("[memory-hub] db prefix sync error:", (e && e.message) || e);
  }

  /* ---- 设置页按钮提交的待办任务 ----
   * 页面无法直接触发宿主动作（Magpie 没有这个通道），只能把「要做什么」
   * 写进 options 当一次性信标；这里在宿主加载时读取并执行。
   * 只在真有信标时才做网络调用，不给常规加载引入等待。 */
  if (readAction(options)) {
    try {
      const r = await runPendingAction(options, cfg);
      if (r.ran) {
        console.error("[memory-hub] 页面任务 " + r.op + "#" + r.id + " 已执行：" +
          JSON.stringify(r.result).slice(0, 400));
      } else {
        console.error("[memory-hub] 页面任务跳过：" + r.reason);
      }
    } catch (e) {
      // 信标执行失败绝不能让宿主加载失败
      console.error("[memory-hub] 页面任务执行异常：" + String(e && e.message || e));
    }
  }

  /* ---- auto_init 自愈 ----
   * 不 await：初始化可能要一次网络往返，而工具枚举不该为此等待。
   * 宿主进程长驻，这个 promise 会自行跑完。 */
  if (cfg.autoInit && cfg.mcpKey && !isTestMode()) {
    dbInit(cfg, {}).catch((e) => {
      console.error("[memory-hub] auto_init 失败：" + String(e && e.message || e));
    });
  }

  /* ---- auto_harvest 自动增量提炼 ----
   * 不 await：增量扫描在后台异步执行，不给常规工具枚举引入网络/磁盘延迟。
   * 仅在 options.auto_harvest 为 true 时开启，默认 false 以防隐私越界。
   * 严禁在测试环境中启动真实增量扫描。 */
  if (cfg.autoHarvest && !isTestMode()) {
    harvestGateway({}, {
      _client: client,
      _cfg: cfg,
      saveMemory,
      pitfallSave,
    }).catch((e) => {
      console.error("[memory-hub] auto_harvest 失败：" + String((e && e.message) || e));
    });
  }

  /* ---- dedup_schedule 定时自动去重 ----
   * 宿主长驻进程定期检查上次去重时间是否超期（daily / weekly / monthly）。
   * 默认 off，关闭时不执行任何后台操作；超期触发后立即分批执行去重，绝不产出冗余卡片。 */
  const dedupSched = cfg.dedup_schedule || cfg.audit_interval || cfg.auditInterval || (options && (options.dedup_schedule || options.audit_interval)) || "off";
  const optionsGetter = () => readOptions(Object.assign({}, input && typeof input === "object" ? input : {}, options && typeof options === "object" ? options : {}));
  _auditOptionsGetter = optionsGetter;
  if (cfg) _auditBaseCfg = cfg;
  if (client) _auditBaseClient = client;

  if (dedupSched === "off" || dedupSched === "none") {
    stopAuditScheduler();
  } else if (!isTestMode()) {
    ensureAuditScheduler(client, cfg, optionsGetter);
  }

  const tool = {};
  for (const name of Object.keys(TOOLS)) {
    const def = TOOLS[name];
    tool[name] = {
      description: def.description,
      args: def.args,
      execute: async (args, ctx) => {
        const abortSignal = (ctx && ctx.abort) || null;
        if (abortSignal && abortSignal.aborted) {
          const abortErr = new Error("操作已被取消 (aborted)");
          abortErr.name = "AbortError";
          throw abortErr;
        }
        const callCfg = Object.assign({}, cfg, { signal: abortSignal });
        const baseClient = (options && (options._client || options.client)) || null;
        let callClient;
        if (baseClient) {
          const checkAbort = () => {
            if (abortSignal && abortSignal.aborted) {
              const err = new Error("操作已被取消 (aborted)");
              err.name = "AbortError";
              throw err;
            }
          };

          callClient = {
            ...baseClient,
            create: async (t, d) => { checkAbort(); return await baseClient.create(t, d); },
            list: async (t, p) => {
              checkAbort();
              return await baseClient.list(t, p);
            },
            update: async (t, id, d) => { checkAbort(); return await baseClient.update(t, id, d); },
            remove: async (t, id) => { checkAbort(); return await baseClient.remove(t, id); },
            raw: async (sql) => { checkAbort(); return await baseClient.raw(sql); },
          };
        } else {
          callClient = makeClient(callCfg, abortSignal);
        }
        if (callClient && !isTestMode()) {
          triggerBackgroundDrain(callClient).catch(() => {});
        }
        const callArgs = ["memory_save", "pitfall_save", "memory_search", "pitfall_search", "memory_get", "memory_context", "memory_list", "memory_forget"].includes(name)
          ? normalizeToolArgs(args, callCfg)
          : (args || {});
        const result = await def.run(callArgs, {
          _client: callClient,
          _cfg: callCfg,
          _input: input,
          _ctx: ctx,
          signal: abortSignal,
        });
        try {
          if (["db_provision", "db_status", "db_init", "db_reset", "ncb_check"].includes(name)) {
            const op = name.replace(/^db_/, "");
            writeCardStatus("ncb", result, op);
          } else if (name === "storage_setup" || name === "r2_check") {
            writeCardStatus("r2", result, name);
          }
        } catch (e) {
          console.error("[memory-hub] writeCardStatus tool hook error:", (e && e.message) || e);
        }
        return result;
      },
    };
  }

  return {
    tool,
    _scheduler: {
      getFreshCfg: () => {
        if (typeof _auditOptionsGetter === "function") {
          try {
            return _auditOptionsGetter();
          } catch (_) {}
        }
        return optionsGetter();
      },
      ensureAuditScheduler: (c = client, conf = cfg, og = optionsGetter) => ensureAuditScheduler(c, conf, og),
      stop: stopAuditScheduler,
    },
    _getFreshCfg: () => {
      if (typeof _auditOptionsGetter === "function") {
        try {
          return _auditOptionsGetter();
        } catch (_) {}
      }
      return optionsGetter();
    },
  };
};

MagpieMemoryHub.ensureAuditScheduler = ensureAuditScheduler;
MagpieMemoryHub.stopAuditScheduler = stopAuditScheduler;
MagpieMemoryHub.readOptions = readOptions;
MagpieMemoryHub.checkScheduledDedup = checkScheduledDedup;
MagpieMemoryHub.normalizeToolArgs = normalizeToolArgs;
