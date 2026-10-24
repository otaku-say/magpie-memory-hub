/**
 * 模块职责：NoCodeBackend MCP HTTP JSON-RPC 客户端实现（通信/序列化/DDL/R2封装）
 * 依赖：无
 * 被依赖：src/integration/ncb.js, src/integration/db-tools.js, src/integration/r2-storage.js, src/integration/mcp-client.js
 */

export const MCP_ENDPOINT = "https://app.nocodebackend.com/api/mcp/http";

/** 默认超时（毫秒）。DDL 可能较慢，给足余量。 */
const DEFAULT_TIMEOUT = 15000;

/** 把可能为 SSE 的响应体解析成 JSON-RPC 结果。 */
function parseRpcBody(text) {
  if (!text) return null;
  var t = text.trim();
  // SSE：可能有多行 data:，取最后一条带 result/error 的
  if (t.startsWith("event:") || t.indexOf("\ndata:") >= 0 || t.startsWith("data:")) {
    var lines = t.split(/\r?\n/);
    var last = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf("data:") === 0) {
        var payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          var obj = JSON.parse(payload);
          if (obj && (obj.result !== undefined || obj.error !== undefined)) last = obj;
        } catch (e) { /* 非 JSON 的心跳，跳过 */ }
      }
    }
    return last;
  }
  try { return JSON.parse(t); } catch (e) { return null; }
}

/** 从 JSON-RPC 响应里取出 tools/call 的文本结果。 */
function unwrapToolText(resp) {
  if (!resp) return "";
  if (resp.error) {
    throw new Error("MCP 错误: " + (resp.error.message || JSON.stringify(resp.error)));
  }
  var r = resp.result;
  if (!r) return "";
  // tools/call → { content: [ { type:"text", text:"..." } ] }
  if (Array.isArray(r.content)) {
    var parts = [];
    for (var i = 0; i < r.content.length; i++) {
      var c = r.content[i];
      if (c && c.type === "text") parts.push(c.text);
    }
    return parts.join("\n");
  }
  // tools/list → { tools: [...] }
  if (Array.isArray(r.tools)) return JSON.stringify(r.tools);
  return typeof r === "string" ? r : JSON.stringify(r);
}

/** tools/call 的文本结果通常是 JSON 字符串，尽量解析成对象；解析不了就原样返回字符串。 */
function maybeJson(text) {
  if (typeof text !== "string") return text;
  var t = text.trim();
  if (!t) return "";
  if (t[0] !== "{" && t[0] !== "[") return text;
  try { return JSON.parse(t); } catch (e) { return text; }
}

/**
 * NCB MCP 客户端。
 * @param {object} opts
 *   - apiKey: MCP key（账号级）。缺失时所有调用会抛出可读错误。
 *   - endpoint: 覆盖默认端点（测试用）
 *   - timeout: 单次请求超时毫秒
 */
export function NcbMcp(opts) {
  opts = opts || {};
  this.apiKey = opts.apiKey || "";
  this.endpoint = opts.endpoint || MCP_ENDPOINT;
  this.timeout = opts.timeout || DEFAULT_TIMEOUT;
  this.signal = opts.signal || null;
  /* fetch 可注入：生产走全局 fetch，测试用桩彻底杜绝「测试偷偷打真网」的情况
   * （曾发生过静态工具名测试因未注入而访问线上 API 的事故）。 */
  this.fetchImpl = typeof opts.fetch === "function" ? opts.fetch : null;
  /* 只读调用（握手/列工具/读结构）允许有限重试；写操作默认不重试，
   * 避免网络抖动导致 INSERT 被执行两次。 */
  var r = Number(opts.retries);
  this.retries = Number.isFinite(r) ? Math.max(0, Math.min(3, Math.floor(r))) : 2;
  this._seq = 0;
  this._sessionId = null;
  this._initPromise = null;
  this._ready = false;
}

/** 发一次 JSON-RPC。失败抛异常（含可读原因）。 */
NcbMcp.prototype._rpcOnce = async function (method, params, isNotification, callOpts) {
  var externalSignal = (callOpts && callOpts.signal) || this.signal;
  if (externalSignal && externalSignal.aborted) {
    var abortErr = new Error("操作已被取消 (aborted)");
    abortErr.name = "AbortError";
    throw abortErr;
  }
  if (!this.apiKey) {
    throw new Error("未配置 MCP key：初始化/清库需要 MCP key（数据库 Secret Key 只能读写数据，无法建表）");
  }
  var body = { jsonrpc: "2.0", method: method };
  if (!isNotification) body.id = ++this._seq;
  if (params !== undefined) body.params = params;

  var headers = {
    "Authorization": "Bearer " + this.apiKey,
    "Content-Type": "application/json",
    // 服务端可能回 JSON 也可能回 SSE，两种都声明接受
    "Accept": "application/json, text/event-stream",
  };
  if (this._sessionId) headers["Mcp-Session-Id"] = this._sessionId;

  var effectiveSignal = externalSignal || null;
  var fetchSignal = null;
  var ctrl = null;
  var timer = null;
  var abortListener = null;
  var timeoutSig = null;

  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    timeoutSig = AbortSignal.timeout(this.timeout || 15000);
    if (effectiveSignal) {
      if (typeof AbortSignal.any === "function") {
        fetchSignal = AbortSignal.any([effectiveSignal, timeoutSig]);
      } else {
        ctrl = new AbortController();
        abortListener = function () { ctrl.abort(); };
        effectiveSignal.addEventListener("abort", abortListener, { once: true });
        timeoutSig.addEventListener("abort", abortListener, { once: true });
        fetchSignal = ctrl.signal;
      }
    } else {
      fetchSignal = timeoutSig;
    }
  } else {
    ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (ctrl) {
      timer = setTimeout(function () { ctrl.abort(); }, this.timeout || 15000);
      if (effectiveSignal) {
        abortListener = function () { ctrl.abort(); };
        effectiveSignal.addEventListener("abort", abortListener, { once: true });
      }
      fetchSignal = ctrl.signal;
    }
  }

  var resp;
  var doFetch = this.fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw new Error("当前运行时不支持 fetch，无法连接 NoCodeBackend MCP");
  try {
    resp = await doFetch(this.endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
      signal: fetchSignal || effectiveSignal || (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(15000) : undefined),
    });
  } catch (e) {
    var isExternal = externalSignal && externalSignal.aborted;
    var msg = isExternal
      ? "操作已被取消 (aborted)"
      : (e && e.name === "AbortError" ? ("请求超时（" + this.timeout + "ms）") : String(e && e.message || e));
    var err = new Error("连接 NoCodeBackend MCP 失败：" + msg);
    if (isExternal || (e && e.name === "AbortError")) err.name = "AbortError";
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) {
      if (effectiveSignal) {
        try { effectiveSignal.removeEventListener("abort", abortListener); } catch (_) {}
      }
      if (timeoutSig) {
        try { timeoutSig.removeEventListener("abort", abortListener); } catch (_) {}
      }
    }
  }

  // 记录会话（无状态端点通常不返回，返回了就用上）
  try {
    var sid = resp.headers && resp.headers.get && resp.headers.get("Mcp-Session-Id");
    if (sid) this._sessionId = sid;
  } catch (e) { /* 忽略 */ }

  if (resp.status === 202) return null;           // 通知类：服务端已接收
  var text = await resp.text();

  if (resp.status === 401 || resp.status === 403) {
    throw new Error("MCP key 无效或权限不足（HTTP " + resp.status + "）");
  }
  if (resp.status >= 400) {
    var hint = text.slice(0, 200);
    throw new Error("NoCodeBackend MCP 返回 HTTP " + resp.status + "：" + hint);
  }
  var parsed = parseRpcBody(text);
  if (parsed === null) {
    throw new Error("NoCodeBackend MCP 响应无法解析：" + String(text).slice(0, 200));
  }
  return parsed;
};

/**
 * 带「有界重试」的 JSON-RPC 入口。
 * 只重试网络层瞬时失败（fetch failed / ECONNRESET / ETIMEDOUT / ENOTFOUND / EAI_AGAIN），
 * 且必须由调用方显式传 { retry: true } —— 写操作永不被自动重放。
 * 超时与主动取消（AbortError）不重试：重试只会把延迟和用户等待翻倍。
 */
NcbMcp.prototype.rpc = async function (method, params, isNotification, callOpts) {
  var attempts = (callOpts && callOpts.retry === true) ? this.retries : 0;
  var lastErr = null;
  for (var attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await this._rpcOnce(method, params, isNotification, callOpts);
    } catch (e) {
      lastErr = e;
      var msg = String((e && e.message) || e);
      var transient = !(e && e.name === "AbortError") &&
        /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|连接 NoCodeBackend MCP 失败/.test(msg);
      var timedOut = /请求超时/.test(msg);
      if (!transient || timedOut || attempt === attempts) throw e;
      await new Promise(function (resolve) { setTimeout(resolve, 150 * (attempt + 1)); });
    }
  }
  throw lastErr;
};

/** 握手（幂等，可重复调用；失败会抛出可读错误；并发互斥复用 promise）。 */
NcbMcp.prototype.initialize = async function () {
  if (this._ready) return this._serverInfo;
  if (this._initPromise) return this._initPromise;
  this._initPromise = (async () => {
    try {
      var res = await this.rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "magpie-memory-hub", version: "1" },
      });
      this._serverInfo = (res && res.result && res.result.serverInfo) || {};
      // 规范要求握手后发通知；失败不影响后续调用
      try { await this.rpc("notifications/initialized", undefined, true); } catch (e) { /* 忽略 */ }
      this._ready = true;
      return this._serverInfo;
    } finally {
      this._initPromise = null;
    }
  })();
  return this._initPromise;
};

/** 列出服务端工具名。 */
NcbMcp.prototype.listTools = async function () {
  await this.initialize();
  var res = await this.rpc("tools/list", {}, false, { retry: true });
  var tools = (res && res.result && res.result.tools) || [];
  return tools.map(function (t) { return t.name; });
};

/** 通用工具调用，返回文本；asJson=true 时尽量解析成对象。 */
NcbMcp.prototype.callTool = async function (name, args, asJson, callOpts) {
  await this.initialize();
  var res = await this.rpc("tools/call", { name: name, arguments: args || {} }, false, callOpts);
  var text = unwrapToolText(res);
  return asJson === false ? text : maybeJson(text);
};

/* ------------------------------------------------------------------ *
 * 语义化封装（插件真正用到的几个）
 * ------------------------------------------------------------------ */

/** 读数据库结构（返回 {instance, tables:{表名:{columns:{列名:{...}}}}}）。 */
NcbMcp.prototype.getSchema = function (database) {
  // 注意：这里返回的是对象的 JSON 文本，需按对象解析；不可解析时原样返回字符串
  // 只读且幂等：允许有界重试，避免一次网络抖动就让整次初始化失败。
  return this.callTool("get_schema", { database: database }, undefined, { retry: true });
};

/** 执行 SQL。sql 可以是单条，也可以是分号分隔的多条（服务端逐条执行）。 */
NcbMcp.prototype.executeSql = function (database, sql) {
  return this.callTool("execute_sql", { database: database, sql: sql });
};

/**
 * 创建数据库（可同时建表）。
 * 返回的是 Markdown 文本（不是 JSON），其中**包含自动生成的 Secret Key**——
 * 这也是唯一能拿到它的时机（实测：get_integration_prompts 取不回密钥值）。
 */
NcbMcp.prototype.createDatabase = function (name, tables, opts) {
  var o = opts || {};
  var args = { name: name, tables: tables || [] };
  if (o.enableAuth !== undefined) args.enableAuth = o.enableAuth;
  if (o.region) args.region = o.region;
  return this.callTool("create_database", args, false);   // 强制返回文本
};

/** 列出账号下的数据库（返回纯文本清单，便于解析是否存在）。 */
NcbMcp.prototype.listDatabasesText = function () {
  return this.callTool("list_databases", {}, false);
};

/** 从 create_database 的返回里抽取自动生成的 Secret Key。 */
export function extractSecret(text) {
  if (typeof text !== "string") {
    try { text = JSON.stringify(text); } catch (e) { return ""; }
  }
  var m = text.match(/NCB_SECRET_KEY\s*=\s*([A-Za-z0-9_\-]{12,})/);
  if (m) return m[1];
  m = text.match(/\b(ncb_sec_[A-Za-z0-9_\-]{12,})/);
  return m ? m[1] : "";
}

/** 从 create_database 的返回里抽取数据库真实实例名（NCB 可能会加账号前缀）。 */
export function extractInstance(text, fallback) {
  if (typeof text === "string") {
    var m = text.match(/Database\s+"([A-Za-z0-9_]+)"\s+Created/i);
    if (m) return m[1];
  }
  return fallback || "";
}

/** 列出账号下的数据库。 */
NcbMcp.prototype.listDatabases = function () {
  return this.callTool("list_databases", {}, undefined, { retry: true });
};

/** 配置该数据库的 R2 存储（自动建 bucket + CORS）。 */
NcbMcp.prototype.setupR2Storage = function (database, extra) {
  var args = Object.assign({ database: database }, extra || {});
  return this.callTool("setup_r2_storage", args);
};

/** 上传文件到该库的 R2（不传 fileData 时返回 presigned URL）。 */
NcbMcp.prototype.uploadFile = function (database, filename, fileData, contentType) {
  var args = { database: database, filename: filename };
  if (fileData !== undefined && fileData !== null) args.fileData = fileData;
  if (contentType) args.contentType = contentType;
  return this.callTool("upload_file", args);
};

/** 执行多条 SQL，逐条给出结果；任一条失败不影响其它条（返回明细）。 */
NcbMcp.prototype.executeSqlBatch = async function (database, statements) {
  var results = [];
  for (var i = 0; i < statements.length; i++) {
    var stmt = statements[i];
    var sql = typeof stmt === "string" ? stmt : stmt.sql;
    var label = typeof stmt === "string" ? "" : stmt.kind;
    try {
      var out = await this.executeSql(database, sql);
      // 服务端返回形如 { ok:true, executedCount:1, results:[...] } 或 { ok:false, error:"..." }
      var err = out && out.error ? String(out.error) : "";
      // 幂等容错：MySQL 不支持 CREATE INDEX IF NOT EXISTS，重复建索引必然报这两类错。
      // 它们表示「目标状态已达成」，因此算成功而非失败。
      var benign = /Duplicate key name|Duplicate entry|already exists|Duplicate column name/i.test(err);
      var ok = !(out && out.ok === false) || benign;
      results.push({ sql: sql, kind: label, ok: ok, benign: benign && !!(out && out.ok === false), out: out });
    } catch (e) {
      results.push({ sql: sql, kind: label, ok: false, error: String(e && e.message || e) });
    }
  }
  return results;
};
