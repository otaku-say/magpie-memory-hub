/**
 * 模块职责：NoCodeBackend 客户端构建（MCP/REST双模）、参数形状嗅探与基础结果集工具
 * 依赖：../core/config.js, src/integration/mcp-client.js
 * 被依赖：src/services/**, src/tools/**, src/index.js, tools.js
 */

import { NCB_BASE, FETCH_LIMIT, readOptions } from "../core/config.js";
import { makeMcpClient } from "./mcp-client.js";

const NO_CRED_ERR_MSG = "NO_CREDENTIALS: 未配置有效的 NoCodeBackend 凭据";
const ALLOWED_NO_CRED_PROPS = new Set(["list", "create", "update", "remove", "raw"]);

export function makeNoCredentialsClient() {
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

export function isCfgShape(o) {
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


export function makeRestClient(cfg, signal) {
  const instance = (cfg && (cfg.instance || cfg.ncb_instance)) || "";
  const secret = (cfg && (cfg.secret || cfg.ncb_secret)) || "";
  async function call(method, action, table, { data, params, id, signal: callSignal } = {}) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error("未知表名: " + table);
    const qs = new URLSearchParams(Object.assign({ Instance: instance }, params || {}));
    const suffix = id === undefined || id === null ? "" : "/" + encodeURIComponent(id);
    const url = `${NCB_BASE}/${action}/${encodeURIComponent(table)}${suffix}?${qs.toString()}`;

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

export function rowsOf(res) {
  if (!res) return [];
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res)) return res;
  return [];
}

export function mergeCommaSeparated(base, ...extras) {
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
