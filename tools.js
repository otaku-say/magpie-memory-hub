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
import { lookupSecret, lookupDatabase } from "./local_state.js";
import { makeMcpClient } from "./mcp_client.js";
import { checkLocalModel, MODEL_SPEC, modelDir } from "./model_check.js";
import { runPendingAction, readAction, writeCardStatus, parseDbInfo, isModelDownloading, startBackgroundModelDownload } from "./page_actions.js";
import { harvestGateway, isTestMode } from "./gateway_harvest.js";

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
  return {
    // 库名：优先按用户填的；没填就用上次 provision 真正用到的那个
    instance: o.ncb_instance || lookupDatabase() || "41694_agent_memory",
    // Secret Key：用户在设置页填的优先；
    // 若库是本插件创建的，创建时已自动取得并保存在本地状态里，这里直接取用，
    // 于是**用户只需要填 MCP key**。
    secret: o.ncb_secret || lookupSecret(o.ncb_instance || lookupDatabase()) || "",
    // MCP key：仅用于建表/清库/schema/R2。数据库 Secret Key 只能读写数据。
    mcpKey: o.mcp_key || "",
    storagePublicUrl: o.storage_public_url || "",
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
function makeClient(cfg, signal) {
  const sig = signal || (cfg && cfg.signal) || null;
  if (cfg.mcpKey) {
    return makeMcpClient(cfg, sig);
  }
  return makeRestClient(cfg, sig);
}

function makeRestClient(cfg, signal) {
  async function call(method, action, table, { data, params, id, signal: callSignal } = {}) {
    const qs = new URLSearchParams(Object.assign({ Instance: cfg.instance }, params || {}));
    const suffix = id === undefined || id === null ? "" : "/" + encodeURIComponent(id);
    const url = `${NCB_BASE}/${action}/${table}${suffix}?${qs.toString()}`;

    const headers = { "Content-Type": "application/json" };
    if (cfg.secret) headers.Authorization = "Bearer " + cfg.secret;

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
        signal: effectiveSignal || undefined,
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

/** 分页取回（NCB 默认每页 10 条） */
async function fetchAll(client, table, params) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const res = await client.list(table, Object.assign({ limit: FETCH_LIMIT, page }, params || {}));
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

function termsOf(q) {
  return String(q || "")
    .toLowerCase()
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/** 记忆：标题(5) 标签(3) 正文(1) */
function scoreMemory(row, terms) {
  if (!terms.length) return 1;
  const title = String(row.title || "").toLowerCase();
  const tags = String(row.tags || "").toLowerCase();
  const body = String(row.content || row.related_entities || "").toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (title.includes(t)) s += 5;
    if (tags.includes(t)) s += 3;
    if (body.includes(t)) s += 1;
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
  const t = Date.parse(String(row.updated_at || row.created_at || "").replace(" ", "T") + "Z");
  if (!t || isNaN(t)) return 0;
  const days = (Date.now() - t) / 86400000;
  return days <= 0 ? 1 : 1 / (1 + Math.log10(1 + days));
}

function rankMemory(row) {
  const conf = (Number(row.confidence_score) || 100) / 100;
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
  const title = String(m.title || "").trim();
  const content = String(m.content || "").trim();
  const fullText = (m.full_text != null && String(m.full_text).trim() !== "")
    ? String(m.full_text)
    : content;
  const tags = String(m.tags || "").trim().toLowerCase();
  const relatedEntities = String(m.related_entities || "").trim();
  let confidence = Number(m.confidence);
  if (!confidence || confidence <= 1) confidence = Math.round((confidence || 1) * 100);
  confidence = Math.max(0, Math.min(100, Math.round(confidence || 100)));

  if (!title) throw new Error("title 不能为空");
  if (!content) throw new Error("content 不能为空");

  const fp = fingerprint(`${project}:${category}:${title}:${content}`);

  // 0) 进程内近期写入 → 挡掉写后读延迟窗口里的重复
  if (justWritten("m:" + fp)) {
    return { action: "NOOP", id: null, note: "刚刚写入过（写后读延迟窗口内），已忽略重复" };
  }

  // 1) 完全相同的指纹 → NOOP，不虚增检索计数，不更新 last_used_at
  const same = rowsOf(await client.list("memories", { project, limit: FETCH_LIMIT })).filter(
    (r) => r.content_fingerprint === fp
  );
  if (same.length) {
    const hit = same[0];
    markRecent("m:" + fp);
    return { action: "NOOP", id: hit.id, retrieval_count: Number(hit.retrieval_count) || 0, note: "内容未变化" };
  }

  // 2) 同项目同分类同标题但内容不同 → 新版本，旧版进 supersede 版本链
  const superseded = rowsOf(await client.list("memories", { project, limit: FETCH_LIMIT })).filter(
    (r) =>
      r.lifecycle_status === "active" &&
      String(r.title || "").trim().toLowerCase() === title.toLowerCase() &&
      String(r.category || "") === category
  );

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
    revision: superseded.reduce(function (mx, r) { return Math.max(mx, Number(r.revision) || 1); }, 0) + 1,
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
      const dup = rowsOf(await client.list("memories", { project, limit: FETCH_LIMIT })).filter(
        (r) => r.content_fingerprint === fp
      )[0];
      if (dup) {
        return { action: "NOOP", id: dup.id, retrieval_count: Number(dup.retrieval_count) || 0, note: "唯一索引拦下重复" };
      }
      return { action: "NOOP", id: null, note: "唯一索引拦下重复（写后读延迟内读不到既有行）" };
    }
    throw e;
  }
  const newId = created && (created.id || created.insertId);
  markRecent("m:" + fp);

  if (superseded.length && newId) {
    const oldId = superseded[0].id;
    try {
      await client.update("memories", oldId, {
        lifecycle_status: "superseded", superseded_by_id: newId,
        invalid_at: nowSql(),
        invalid_reason: "superseded",
        updated_at: nowSql(),
      });
      return { action: "UPDATE", id: newId, superseded_id: oldId, superseded_count: superseded.length };
    } catch (e) {
      if (!/404|not found/i.test(String(e.message))) throw e;
      // 旧行已不可达（被清理/缓存残留）：新版本已写入，直接按 ADD 返回
      return { action: "ADD", id: newId, note: "旧版本行不可达，已跳过 supersede 标记" };
    }
  }
  return { action: "ADD", id: newId };
}

/* ================================================================== *
 * 工具实现
 * ================================================================== */

async function memorySave(client, cfg, args, ctx) {
  const r = await saveMemory(client, cfg, Object.assign({ origin: "tool" }, args), ctx);
  return jsonOut(r);
}

async function memorySearch(client, cfg, args) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const terms = termsOf(args.query);

  const fetchParams = { lifecycle_status: "active" };
  if (args.project) fetchParams.project = String(args.project).trim();
  if (args.category) fetchParams.category = String(args.category).trim();
  if (args.scope_level) fetchParams.scope_level = String(args.scope_level).trim();
  if (args.client) fetchParams.client = String(args.client).trim();
  if (args.origin) fetchParams.origin = String(args.origin).trim();

  const all = await fetchAll(client, "memories", fetchParams);
  let pool = all;
  if (args.project) pool = pool.filter((r) => String(r.project || "") === args.project);
  if (args.category) pool = pool.filter((r) => String(r.category || "") === args.category);
  const targetScope = args.scope_level;
  if (targetScope) pool = pool.filter((r) => String(r.scope_level || "") === targetScope);
  if (args.client) pool = pool.filter((r) => String(r.client || "") === String(args.client));
  if (args.origin) pool = pool.filter((r) => String(r.origin || "") === String(args.origin));
  // 历史版本默认不返回（Headroom：查询默认排除 superseded）
  if (args.include_history !== true) pool = pool.filter((r) => r.lifecycle_status !== "superseded");

  const scored = pool
    .map((r) => ({ row: r, hit: scoreMemory(r, terms) }))
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || rankMemory(b.row) - rankMemory(a.row));

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
    confidence: x.row.confidence_score,
    retrieval_count: Number(x.row.retrieval_count) || 0,
    last_used_at: x.row.last_used_at || null,
    updated_at: x.row.updated_at,
    _hit: x.hit,
  }));

  return jsonOut({ total_active: all.length, matched: scored.length, returned: out.length, memories: out });
}

async function memoryList(client, cfg, args) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
  const fetchParams = { lifecycle_status: "active" };
  if (args.project) fetchParams.project = String(args.project).trim();
  if (args.client) fetchParams.client = String(args.client).trim();

  let all = (await fetchAll(client, "memories", fetchParams)).filter(
    (r) => r.lifecycle_status !== "superseded"
  );
  if (args.project) all = all.filter((r) => String(r.project || "") === String(args.project));
  if (args.client) all = all.filter((r) => String(r.client || "") === String(args.client));
  const sorted = all.sort((a, b) => rankMemory(b) - rankMemory(a)).slice(0, limit);
  return jsonOut({
    total_active: all.length,
    returned: sorted.length,
    memories: sorted.map((r) => ({
      id: r.id, project: r.project, category: r.category,
      scope_level: r.scope_level,
      client: r.client || "unknown",
      origin: r.origin || "tool",
      title: r.title, tags: r.tags,
      retrieval_count: Number(r.retrieval_count) || 0,
      last_used_at: r.last_used_at || null,
    })),
  });
}

async function memoryContext(client, cfg, args) {
  const maxItems = Number(args.max_items) || cfg.maxInject;
  const budget = Number(args.max_chars) || cfg.maxBudget;
  const terms = termsOf(args.query);

  const fetchParams = { lifecycle_status: "active" };
  if (args.project) fetchParams.project = String(args.project).trim();

  let pool = (await fetchAll(client, "memories", fetchParams)).filter(
    (r) => r.lifecycle_status !== "superseded"
  );
  if (args.project) pool = pool.filter((r) => String(r.project || "") === args.project);

  const scored = pool
    .map((r) => ({ row: r, hit: scoreMemory(r, terms) }))
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || rankMemory(b.row) - rankMemory(a.row));

  let block = "[Persistent Memory Context]\n";
  let n = 0;
  for (const x of scored) {
    if (n >= maxItems) break;
    const line = `- [${x.row.category || "fact"}] ${cut(x.row.title, 120)}: ${cut(x.row.content, 400)}\n`;
    if (block.length + line.length > budget) break;
    block += line;
    n++;
  }
  return jsonOut({ injected: n, chars: block.length, block: n ? block.trim() : "" });
}

async function pitfallSave(client, cfg, args, ctx) {
  const project = String(args.project || "global").trim();
  const callerAgent = (ctx && (ctx.agent || (ctx._ctx && ctx._ctx.agent))) || "";
  const clientVal = (args.client && String(args.client).trim())
    || (callerAgent && String(callerAgent).trim())
    || (args.agent && String(args.agent).trim())
    || "unknown";
  const component = String(args.component || "").trim();
  const symptom = String(args.symptom || "").trim();
  const rootCause = String(args.root_cause || "").trim();
  const solution = String(args.solution || "").trim();
  const severity = SEVERITIES.includes(args.severity) ? args.severity : "medium";
  const errorType = String(args.error_type || "").trim();
  const tags = String(args.tags || "").trim().toLowerCase();

  if (!component) throw new Error("component 不能为空");
  if (!symptom) throw new Error("symptom 不能为空");
  if (!rootCause) throw new Error("root_cause 不能为空");
  if (!solution) throw new Error("solution 不能为空");

  const fp = (args.content_fingerprint && String(args.content_fingerprint).trim()) || fingerprint(`${project}:${component}:${symptom}`);
  const initialRecurrence = typeof args.recurrence === "number" && args.recurrence >= 1 ? Math.floor(args.recurrence) : 1;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  if (justWritten("p:" + fp)) {
    return jsonOut({ action: "NOOP", id: null, note: "刚刚写入过（写后读延迟窗口内），已忽略重复" });
  }

  const exist = rowsOf(await client.list("pitfalls", { project, limit: FETCH_LIMIT })).filter(
    (r) => r.content_fingerprint === fp
  );
  if (exist.length) {
    const row = exist[0];
    const next = (Number(row.recurrence) || 1) + initialRecurrence;
    try {
      await client.update("pitfalls", row.id, { recurrence: next, last_occurred_at: now, updated_at: now });
      markRecent("p:" + fp);
      return jsonOut({ action: "NOOP", id: row.id, recurrence: next });
    } catch (e) {
      if (!/404|not found/i.test(String(e.message))) throw e;
    }
  }

  let created;
  try {
    created = await client.create("pitfalls", {
      project, client: clientVal, component, symptom, root_cause: rootCause, solution,
      severity, error_type: errorType, tags, content_fingerprint: fp,
      recurrence: initialRecurrence, last_occurred_at: now,
      created_at: now, updated_at: now,
    });
  } catch (e) {
    if (/duplicate entry/i.test(String(e.message))) {
      markRecent("p:" + fp);
      const dup = rowsOf(await client.list("pitfalls", { project, limit: FETCH_LIMIT })).filter(
        (r) => r.content_fingerprint === fp
      )[0];
      if (dup) {
        const next = (Number(dup.recurrence) || 1) + initialRecurrence;
        try { await client.update("pitfalls", dup.id, { recurrence: next, last_occurred_at: now, updated_at: now }); } catch (_) {}
        return jsonOut({ action: "NOOP", id: dup.id, recurrence: next, note: "唯一索引拦下重复" });
      }
      return jsonOut({ action: "NOOP", id: null, note: "唯一索引拦下重复" });
    }
    throw e;
  }
  markRecent("p:" + fp);
  return jsonOut({ action: "ADD", id: created && (created.id || created.insertId) });
}

async function pitfallSearch(client, cfg, args) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const terms = termsOf(args.query);

  const fetchParams = {};
  if (args.project) fetchParams.project = String(args.project).trim();
  if (args.client) fetchParams.client = String(args.client).trim();
  if (args.component) fetchParams.component = String(args.component).trim();

  const all = await fetchAll(client, "pitfalls", fetchParams);
  let pool = all;
  if (args.project) pool = pool.filter((r) => String(r.project || "") === args.project);
  if (args.client) pool = pool.filter((r) => String(r.client || "") === String(args.client));
  if (args.component) pool = pool.filter((r) => String(r.component || "") === args.component);

  const scored = pool
    .map((r) => ({ row: r, hit: scorePitfall(r, terms) }))
    .filter((x) => x.hit > 0)
    .sort((a, b) => b.hit - a.hit || (Number(b.row.recurrence) || 0) - (Number(a.row.recurrence) || 0));

  const out = scored.slice(0, limit).map((x) => Object.assign({}, x.row, { _hit: x.hit }));
  return jsonOut({ total_pitfalls: all.length, matched: scored.length, returned: out.length, pitfalls: out });
}

/* 单条读取（CCR 展开用） */
async function memoryGet(client, cfg, args) {
  const id = Number(args.id);
  if (!id) throw new Error("id 不能为空");
  const res = await client.list("memories", { id, limit: 1 });
  const hit = rowsOf(res).filter((r) => Number(r.id) === id)[0];
  if (!hit) throw new Error("找不到 id=" + id + " 的记忆");
  // 展开属于一次真实取用，顺带累加被检索命中次数与更新最后使用时间
  const count = (Number(hit.retrieval_count) || 0) + 1;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    await client.update("memories", id, {
      retrieval_count: count,
      last_used_at: now,
      updated_at: nowSql(),
    });
  } catch (e) { /* 计数失败不影响读取 */ }
  const full = (hit.full_text != null && String(hit.full_text).trim() !== "")
    ? hit.full_text
    : hit.content;
  return jsonOut({
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
    last_used_at: now,
    _note: "已返回完整原文（见 full_text 与 content），summary 为注入卡片所用摘要",
  });
}

/* 软失效：不物理删除，写 invalid_at，保留审计链 */
async function memoryForget(client, cfg, args) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  let targets = [];
  if (args.id) {
    targets = rowsOf(await client.list("memories", { limit: 1, id: Number(args.id) }))
      .filter((r) => Number(r.id) === Number(args.id));
  } else if (args.query) {
    const terms = termsOf(args.query);
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
    throw new Error("需要 id 或 query 之一");
  }
  if (!targets.length) return jsonOut({ action: "NOT_FOUND", forgotten: 0 });

  const done = [];
  for (const t of targets) {
    try {
      await client.update("memories", t.id, {
        invalid_at: now, lifecycle_status: "invalid", invalid_reason: "user_forgot",
        updated_at: now,          // NCB 不生效 ON UPDATE CURRENT_TIMESTAMP，必须显式写
      });
      done.push({ id: t.id, title: t.title });
    } catch (e) { /* 单条失败不影响其余 */ }
  }
  return jsonOut({ action: "SOFT_DELETE", forgotten: done.length, items: done,
    note: "已软失效（写 invalid_at），记录保留可追溯，中间件不再注入" });
}

/* ================================================================== *
 * 工具清单（MCP 名 = magpie-memory-hub_<name>）
 * ================================================================== */

const TOOLS = {
  memory_save: {
    description:
      "写入一条长期记忆。指纹相同→NOOP(已存在)；同项目同分类同标题但内容更新→建立新版本并把旧版标记 superseded。",
    args: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名，默认 global" },
        category: { type: "string", enum: CATEGORIES, description: "记忆分类。principle=行为准则，会被无条件置顶注入" },
        scope_level: { type: "string", enum: SCOPES, description: "作用域层级，默认 project（可选 user, project, session, turn）" },
        client: { type: "string", description: "产生该记忆的客户端标识（如 minis、codex、claude 等，可选，默认取调用者智能体）" },
        origin: { type: "string", enum: ["tool", "inline", "harvest"], description: "产生方式：tool=主动调用工具, inline=中间件内联提炼, harvest=网关录制提炼。默认 tool" },
        title: { type: "string", description: "精简标题（<=40字）" },
        content: { type: "string", description: "记忆正文/摘要，要具体、可复用" },
        full_text: { type: "string", description: "完整原文（可选，未提供时默认等于 content）" },
        tags: { type: "string", description: "逗号分隔的检索关键词" },
        related_entities: { type: "string", description: "相关实体/技术栈" },
        confidence: { type: "number", description: "置信度 0~1，默认 1" },
      },
      required: ["title", "content"],
    },
    run: (args, ctx) => memorySave(ctx._client, ctx._cfg, args, ctx),
  },

  memory_search: {
    description:
      "搜索长期记忆。关键词命中：标题(5)/标签(3)/正文(1)，再按置信度·访问热度·新鲜度排序。回答历史相关问题前先调用它。",
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
      },
    },
    run: (args, ctx) => memorySearch(ctx._client, ctx._cfg, args),
  },

  memory_list: {
    description: "列出活跃记忆，按综合热度降序。用于总览已积累的知识。",
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
    description: "按当前任务关键词生成一段可直接注入系统提示的记忆上下文块（受条数与字符预算约束）。",
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
    description: "按 id 取出某条记忆的完整内容。注入里出现摘要卡（带 id）时用它展开全文。",
    args: {
      type: "object",
      properties: { id: { type: "integer", description: "记忆 id" } },
      required: ["id"],
    },
    run: (args, ctx) => memoryGet(ctx._client, ctx._cfg, args),
  },

  memory_forget: {
    description: "软失效一条或多条记忆（不物理删除，写 invalid_at）。用于纠正过时或错误的知识。",
    args: {
      type: "object",
      properties: {
        id: { type: "integer", description: "按 id 精确失效（优先）" },
        query: { type: "string", description: "按关键词匹配失效" },
        limit: { type: "integer", description: "按关键词时最多失效几条，默认 1" },
      },
    },
    run: (args, ctx) => memoryForget(ctx._client, ctx._cfg, args),
  },

  pitfall_save: {
    description: "记录工程踩坑（现象/根因/解法）。相同指纹→复发次数+1，不重复入库。",
    args: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名" },
        client: { type: "string", description: "产生该踩坑记录的客户端标识（可选）" },
        component: { type: "string", description: "出问题的组件" },
        symptom: { type: "string", description: "错误现象或报错原文" },
        root_cause: { type: "string", description: "技术根因" },
        solution: { type: "string", description: "已验证的解法" },
        severity: { type: "string", enum: SEVERITIES },
        error_type: { type: "string", description: "错误类型标签，便于聚类" },
        tags: { type: "string", description: "检索关键词" },
      },
      required: ["component", "symptom", "root_cause", "solution"],
    },
    run: (args, ctx) => pitfallSave(ctx._client, ctx._cfg, args, ctx),
  },

  pitfall_search: {
    description: "检索已记录的工程踩坑，避免重复踩同一个坑。",
    args: {
      type: "object",
      properties: {
        query: { type: "string", description: "症状/根因/解法关键词" },
        project: { type: "string", description: "限定项目" },
        client: { type: "string", description: "限定客户端来源" },
        component: { type: "string", description: "限定组件" },
        limit: { type: "integer", description: "返回条数，默认 10" },
      },
    },
    run: (args, ctx) => pitfallSearch(ctx._client, ctx._cfg, args),
  },

  /* ---------------- 数据库结构管理（需 MCP key） ---------------- */

  ncb_check: {
    description:
      "检测当前配置的 NoCodeBackend MCP Key 是否有效，并检查目标数据库是否存在以及核心表结构完整度。只读检测，不修改任何数据或结构。",
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
    description: "检查记忆库结构是否就绪：报告缺哪些表/列/索引，以及库里有没有插件不认识的外来表（外来表只报告、绝不触碰）。只读，可随意调用。",
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置的 ncb_instance" },
      },
    },
    run: (args, ctx) => dbStatus(ctx._cfg, args),
  },

  db_provision: {
    description: "【一键全自动】只填 MCP key 即可：自动创建记忆库与全部表/字段/索引。会先检查同名数据库——NoCodeBackend 遇到重名会静默加后缀另建一个新库（导致数据被劈开），所以这里强制先查再建：默认 on_exist=reuse 复用已有库（只补结构、不破坏数据），也可选 fail（报错让用户改名）或 auto_rename（允许新建带后缀的库）。新建库时会自动保存返回的 Secret Key；复用已有库则无法读取，需手动填写。",
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "要创建的数据库名（逻辑名即可，NCB 会自动加账号前缀）。默认取设置页的 ncb_instance" },
        on_exist: { type: "string", enum: ["reuse", "auto_rename", "fail"], description: "同名已存在时的策略，默认 reuse" },
        with_r2: { type: "boolean", description: "是否同时挂载 R2 存储，默认 false，需要时才挂" },
        bucket_name: { type: "string", description: "R2 bucket 名，默认与数据库名相同" },
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
    description: "幂等初始化记忆库：自动创建缺失的表、列、唯一索引。只做 CREATE/ADD，绝不修改或删除既有列与数据，库里已有的数据和外来的表完全不受影响；重复调用是安全的（无差异时不产生任何语句）。首次装好插件、或换库后调用一次即可。",
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
    description: "【破坏性】清空记忆库：删除插件自己的三张表（memories / pitfalls / schema_meta），表结构与全部数据一并删除，不可恢复；库中其它表不受影响。必须二次确认——直接调用只会返回确认提示，确认时须显式传 confirm=\"RESET\"。",
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

  model_check: {
    description: "检测本地多语言小模型是否已就绪（离线语义压缩用）。未就绪时会给出缺失文件清单与下载指引；支持可选的 check_upstream 联网比对上游新版本。",
    args: {
      type: "object",
      properties: {
        check_upstream: { type: "boolean", description: "是否联网检查 HuggingFace / 镜像站比对最新版本（默认 false 纯本地秒级检测）" },
      },
    },
    run: async (args, ctx) => {
      const r = await checkLocalModel({
        checkUpstream: !!(args && args.check_upstream),
        signal: ctx && ctx.signal,
      });
      return jsonOut(Object.assign({}, r, { model_dir: modelDir(), spec_repo: MODEL_SPEC.repo }));
    },
  },

  model_download: {
    description: "后台下载并安装本地多语言小模型（LLMLingua-2 mBERT INT8，约 174MB）。优先走国内 hf-mirror.com 镜像，支持断点续传与 SHA-256 完整性校验。后台非阻塞执行，可通过 model_check 工具或设置页查看进度。",
    args: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "是否强制重新下载已存在的文件（默认 false）" },
      },
    },
    run: (args, ctx) => {
      if (isModelDownloading()) {
        return jsonOut({
          ok: true,
          action: "IN_PROGRESS",
          message: "本地小模型正在后台下载中，无需重复触发",
          model_dir: modelDir(),
        });
      }
      startBackgroundModelDownload(ctx._cfg, {
        force: !!(args && args.force),
        signal: ctx && ctx.signal,
      });
      return jsonOut({
        ok: true,
        action: "STARTED",
        message: "已启动本地小模型后台下载任务（约 174MB，支持断点续传与 sha256 校验）",
        model_dir: modelDir(),
        approx_bytes: MODEL_SPEC.approx_bytes,
        repo: MODEL_SPEC.repo,
      });
    },
  },

  r2_check: {
    description:
      "检测当前配置的 Cloudflare R2 凭据真实可用性：不修改任何设置，通过上传并删除一个极小探针文件进行端到端验证。返回 VERIFIED 或 FAILED，并在失败时给出可操作的排查指引。",
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
    description: "为当前数据库配置 Cloudflare R2 文件存储：创建 bucket 并配置 CORS。⚠️ 关键：NoCodeBackend 会在**实际失败时也返回 ok:true**，所以本工具**不采信它的返回值**，而是紧接着做一次真实上传探测；请以返回的 verdict 为准（VERIFIED=真的可用 / FAILED_VERIFY=NCB 说成功但实际没生效）。挂载时会把插件里保存的 R2 凭据**显式传给 NCB**——若你在 Cloudflare 轮换过密钥，必须先在设置页填好新凭据并点「保存 R2 设置」，否则 NCB 会用缓存的旧连接导致 TLS 握手被拒。失败时返回的 diagnosis 里有可操作的处理步骤。",
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
        bucket_name: { type: "string", description: "自定义 bucket 名，默认与数据库名相同" },
        public_url: { type: "string", description: "自定义域名或 r2.dev 公开地址" },
      },
    },
    run: (args, ctx) => storageSetup(ctx._cfg, args),
  },

  storage_upload: {
    description: "把文件上传到 R2 并返回公开 URL。传 content 则直接上传（文本默认按 UTF-8，或指定 encoding=base64）；不传 content 则返回 presigned 上传 URL，供大文件由客户端直传。建议上传后用 memory_save 把 URL 存成 category=file 的记忆，方便日后检索。",
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
    description: "列出该数据库 R2 桶内的文件（key / 大小 / 修改时间 / 公开 URL）。走数据库 Secret Key 的 REST 接口——NoCodeBackend 的 MCP 没有提供列文件能力。",
    args: {
      type: "object",
      properties: { limit: { type: "integer", description: "最多返回几条，默认 100" } },
    },
    run: (args, ctx) => r2List(ctx._cfg, args),
  },

  storage_delete: {
    description: "【破坏性】删除 R2 桶内的一个文件，不可恢复。必须二次确认——直接调用只返回确认提示，确认时须显式传 confirm=\"DELETE\"。key 用 storage_list 拿到的那个 key（不是完整 URL）。",
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
    description: "说明 R2 存储的可用能力与**不可用**能力（本平台未提供列举对象、删除对象、下载用 presigned URL），以及推荐的「上传 + 存入记忆」工作流。不确定怎么用 R2 时先调这个。",
    args: { type: "object", properties: {} },
    run: (args, ctx) => storageGuide(ctx._cfg),
  },

  harvest_gateway: {
    description: "增量扫描 Magpie 网关录制的对话落盘（GatewayConversations），提炼环境事实、架构决策与故障规避经验存入记忆库。数据源于本地磁盘，可在 Magpie 设置中开启或关闭 GatewayConversations 录制。",
    args: {
      type: "object",
      properties: {
        dir: { type: "string", description: "自定义对话落盘目录路径（可选，默认自动探测）" },
        force_rescan: { type: "boolean", description: "是否强制重新扫描所有文件（忽略增量状态，默认 false）" },
        project: { type: "string", description: "项目命名空间（可选，默认 global）" },
        min_evidence: { type: "number", description: "证据累计门禁阈值（默认 3；规则首次观察时不落盘，累计达到该次数才入库）" },
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
  const cfg = readOptions(options);
  const client = (options && (options._client || options.client)) || makeClient(cfg);

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

  const tool = {};
  for (const name of Object.keys(TOOLS)) {
    const def = TOOLS[name];
    tool[name] = {
      description: def.description,
      args: def.args,
      execute: async (args, ctx) => {
        const callerAgent = (ctx && ctx.agent) != null ? ctx.agent : "";
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
          const waitWithAbort = (ms) => new Promise((resolve, reject) => {
            checkAbort();
            const t = setTimeout(() => {
              if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
              resolve();
            }, ms);
            const onAbort = () => {
              clearTimeout(t);
              const err = new Error("操作已被取消 (aborted)");
              err.name = "AbortError";
              reject(err);
            };
            if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });
          });

          callClient = {
            ...baseClient,
            create: async (t, d) => { checkAbort(); return await baseClient.create(t, d); },
            list: async (t, p) => {
              checkAbort();
              if (abortSignal) await waitWithAbort(15);
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
        const result = await def.run(args || {}, {
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

  return { tool };
};
