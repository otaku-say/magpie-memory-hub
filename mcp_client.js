/**
 * mcp_client.js —— 只用 MCP key 的数据读写客户端。
 *
 * 背景：用户要求「只用高权限 MCP key」，不再依赖数据库 Secret Key。
 * 但 MCP 侧没有结构化 CRUD 工具（`query_data_api` 实测 401，它是给前端 session 用的），
 * 所以数据读写只能走 `execute_sql` —— 这意味着**必须自己拼 SQL**。
 *
 * 注入防线（这是本文件最重要的部分）：
 *   1. **标识符白名单**：表名与列名一律对照 schema.js 的 TABLES 声明校验，
 *      不在白名单里就直接抛错。这样标识符位置**根本不可能**被注入。
 *   2. **值严格转义**：字符串按 MySQL 规则转义（先转义反斜杠再转义单引号，
 *      顺序不能反），数字校验有限性，null/boolean 分别映射。
 *   3. **不接收任何 SQL 片段**：调用方只能传 表名/列名/值，没有拼接口子。
 *
 * 注意：记忆内容是**从对话里来的任意文本**，含单引号、反斜杠、换行、
 * emoji 的概率极高，所以转义必须过硬 —— 见 /tmp 的对抗性测试。
 */
import { TABLES } from "./schema.js";
import { NcbMcp } from "./ncb_mcp.js";
import { lookupRealDatabase } from "./local_state.js";
import { resolveRealDatabase } from "./r2.js";

/** 表名白名单 */
const ALLOWED_TABLES = Object.keys(TABLES);
/** 列名白名单：表名 → 列名集合 */
const ALLOWED_COLUMNS = (() => {
  const m = {};
  for (const t of ALLOWED_TABLES) {
    m[t] = new Set(TABLES[t].columns.map((c) => c.name));
  }
  return m;
})();

/** 校验标识符（表名/列名）。不在白名单里一律抛错。 */
export function safeIdent(name, kind, table) {
  const n = String(name || "");
  if (kind === "table") {
    if (!ALLOWED_TABLES.includes(n)) {
      throw new Error(`未知表名 "${n}"（只允许 ${ALLOWED_TABLES.join(" / ")}）`);
    }
    return "`" + n + "`";
  }
  const cols = ALLOWED_COLUMNS[table];
  if (!cols || !cols.has(n)) {
    throw new Error(`未知列名 "${n}"（表 ${table} 的合法列：${cols ? [...cols].join(", ") : "无"}）`);
  }
  return "`" + n + "`";
}

/** 把值转成 SQL 字面量。字符串按 MySQL 规则转义。 */
export function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("数值非法（NaN/Infinity）");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  let s = String(v);
  // ⚠️ 顺序要紧：必须先转义反斜杠，再转义单引号。
  //    反了就变成 \\' 这种可被继续利用的形态。
  s = s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\0/g, "\\0")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u001a/g, "\\Z");
  return "'" + s + "'";
}

/** 从 execute_sql 的返回里取出第一条结果。 */
function firstResult(out) {
  if (!out) return {};
  if (out.ok === false) {
    throw new Error("SQL 执行失败：" + String(out.error || "未知错误"));
  }
  const rs = out.results || [];
  if (!rs.length) {
    // 有的语句形态可能不带 results（例如纯 DDL）
    return { rows: [], affectedRows: out.affectedRows || 0, insertId: out.insertId || 0 };
  }
  return rs[0] || {};
}

/** 构造 SELECT。支持指定投影列 (columns)、等值匹配、游标 (since_id/id_in/updated_after) 及 limit/offset/order_by。 */
export function buildSelect(table, params) {
  const t = safeIdent(table, "table");
  const p = params || {};
  const where = [];

  // 1. 指定投影列（Lean Projection）：若传 columns 数组，只 SELECT 指定的安全列，大幅节省网络与内存
  let selectCols = "*";
  if (Array.isArray(p.columns) && p.columns.length > 0) {
    selectCols = p.columns.map((col) => safeIdent(col, "column", table)).join(", ");
  }

  // 2. 普通已知列等值匹配（排除控制参数）
  for (const k of Object.keys(p)) {
    if (
      k === "limit" ||
      k === "page" ||
      k === "offset" ||
      k === "order_by" ||
      k === "columns" ||
      k === "since_id" ||
      k === "id_in" ||
      k === "updated_after" ||
      k === "max_pages"
    ) {
      continue;
    }
    where.push(safeIdent(k, "column", table) + (p[k] === null ? " IS NULL" : " = " + sqlValue(p[k])));
  }

  // 3. 规模化增量游标与批量下推过滤
  if (p.since_id !== undefined && p.since_id !== null && p.since_id !== "") {
    where.push(safeIdent("id", "column", table) + " > " + safeId(p.since_id));
  }
  if (Array.isArray(p.id_in) && p.id_in.length > 0) {
    const validIds = p.id_in.map(safeId);
    where.push(safeIdent("id", "column", table) + " IN (" + validIds.join(", ") + ")");
  }
  if (p.updated_after !== undefined && p.updated_after !== null && String(p.updated_after).trim() !== "") {
    where.push(safeIdent("updated_at", "column", table) + " >= " + sqlValue(p.updated_after));
  }

  let sql = "SELECT " + selectCols + " FROM " + t;
  if (where.length) sql += " WHERE " + where.join(" AND ");
  if (p.order_by && typeof p.order_by === "string") {
    const rawOrder = p.order_by.trim();
    const ORDER_BY_REGEX = /^[a-zA-Z0-9_]+(?:\s+(?:ASC|DESC))?(?:\s*,\s*[a-zA-Z0-9_]+(?:\s+(?:ASC|DESC))?)*$/i;
    if (!ORDER_BY_REGEX.test(rawOrder)) {
      throw new Error(`非法 order_by 格式 "${rawOrder}"（只允许列名加可选 ASC/DESC）`);
    }
    const clauses = rawOrder.split(/\s*,\s*/).map((clause) => {
      const parts = clause.trim().split(/\s+/);
      const col = safeIdent(parts[0], "column", table);
      const dir = parts[1] && /^desc$/i.test(parts[1]) ? "DESC" : "ASC";
      return `${col} ${dir}`;
    });
    if (clauses.length) {
      sql += " ORDER BY " + clauses.join(", ");
    }
  }
  const limRaw = String(p.limit == null ? "" : p.limit).trim();
  const rawLimit = /^\d+$/.test(limRaw) && Number(limRaw) > 0 ? Math.floor(Number(limRaw)) : 200;
  const effectiveLimit = Math.min(rawLimit, 1000);
  sql += " LIMIT " + effectiveLimit;
  const pageRaw = String(p.page == null ? "" : p.page).trim();
  const page = /^\d+$/.test(pageRaw) ? Number(pageRaw) : 0;
  const offRaw = String(p.offset == null ? "" : p.offset).trim();
  const offset = /^\d+$/.test(offRaw) ? Number(offRaw) : (page > 1 ? (page - 1) * effectiveLimit : 0);
  if (offset > 0) sql += " OFFSET " + Math.floor(offset);
  return sql;
}

/** 构造 INSERT。 */
export function buildInsert(table, data) {
  const t = safeIdent(table, "table");
  const cols = [];
  const vals = [];
  for (const k of Object.keys(data || {})) {
    const v = data[k];
    if (v === undefined) continue;
    cols.push(safeIdent(k, "column", table));
    vals.push(sqlValue(v));
  }
  if (!cols.length) throw new Error("INSERT 没有任何字段");
  return "INSERT INTO " + t + " (" + cols.join(", ") + ") VALUES (" + vals.join(", ") + ")";
}

/**
 * 校验主键 id：必须是正整数。
 *
 * 踩过的坑：早先只判断 `Number.isFinite(Number(id))`，而 `Number("")` 是 0、
 * `Number("  ")` 也是 0 —— 空串会静默变成 `WHERE id = 0`。虽然删不到东西，
 * 但语义上必须拒绝：主键不存在 0，放行等于掩盖调用方的 bug。
 */
export function safeId(id) {
  if (id === null || id === undefined) throw new Error("缺少 id");
  const s = String(id).trim();
  if (!/^\d+$/.test(s)) throw new Error(`id 必须是正整数（收到 ${JSON.stringify(id)}）`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`id 超出安全范围（收到 ${JSON.stringify(id)}）`);
  return n;
}

/** 构造 UPDATE（必须带合法 id）。 */
export function buildUpdate(table, id, data) {
  const t = safeIdent(table, "table");
  const n = safeId(id);
  const sets = [];
  for (const k of Object.keys(data || {})) {
    const v = data[k];
    if (v === undefined) continue;
    sets.push(safeIdent(k, "column", table) + " = " + sqlValue(v));
  }
  if (!sets.length) throw new Error("UPDATE 没有任何字段");
  return "UPDATE " + t + " SET " + sets.join(", ") + " WHERE " + safeIdent("id", "column", table) + " = " + n;
}

/** 构造 DELETE（必须带合法 id）。 */
export function buildDelete(table, id) {
  const t = safeIdent(table, "table");
  const n = safeId(id);
  return "DELETE FROM " + t + " WHERE " + safeIdent("id", "column", table) + " = " + n;
}

/**
 * 造一个与原来 REST 客户端**接口完全一致**的对象，
 * 这样 tools.js 的业务逻辑一行都不用改。
 */
export function makeMcpClient(cfg, signal) {
  const rawDb = (cfg && (cfg.instance || cfg.ncb_instance)) || "";
  let db = lookupRealDatabase(rawDb) || rawDb;
  const sig = signal || (cfg && cfg.signal) || null;
  const mcp = new NcbMcp({ apiKey: (cfg && (cfg.mcpKey || cfg.mcp_key)) || "", signal: sig });

  let resolvedDbPromise = null;
  const resolveDb = () => {
    if (!resolvedDbPromise) {
      if (/^\d+_/.test(db)) {
        resolvedDbPromise = Promise.resolve(db);
      } else {
        resolvedDbPromise = resolveRealDatabase(cfg, rawDb).then((real) => {
          if (real && /^\d+_/.test(real)) {
            db = real;
          }
          return db;
        }).catch(() => db);
      }
    }
    return resolvedDbPromise;
  };

  // 冷启动自动触发前缀解析缓存
  if (!/^\d+_/.test(db) && (cfg && (cfg.mcpKey || cfg.mcp_key))) {
    resolveDb();
  }

  async function run(sql) {
    const targetDb = await resolveDb();
    const out = await mcp.executeSql(targetDb, sql);
    return firstResult(out);
  }

  return {
    // 与 REST 版 list 的返回形状对齐：{ data: [...], metadata: { hasMore, page, limit } }
    list: async (table, params) => {
      const p = params || {};
      const limRaw = String(p.limit == null ? "" : p.limit).trim();
      const limit = /^\d+$/.test(limRaw) && Number(limRaw) > 0 ? Math.floor(Number(limRaw)) : 200;
      const r = await run(buildSelect(table, params));
      const rows = Array.isArray(r.rows) ? r.rows : [];
      return {
        data: rows,
        metadata: {
          hasMore: rows.length >= limit,
          page: Number(p.page) || 1,
          limit,
        },
      };
    },
    create: async (table, data) => {
      const r = await run(buildInsert(table, data));
      const id = r.insertId || 0;
      if (!id) {
        // 拿不到 insertId 时回查一次，保证调用方拿得到 id
        try {
          let backQuery;
          if (data.content_fingerprint) {
            backQuery = { project: data.project, content_fingerprint: data.content_fingerprint, order_by: "id DESC", limit: 1 };
          } else if (table === "pitfalls") {
            backQuery = { project: data.project, symptom: data.symptom, order_by: "id DESC", limit: 1 };
          } else {
            backQuery = { project: data.project, title: data.title, order_by: "id DESC", limit: 1 };
          }
          const back = await run(buildSelect(table, backQuery));
          const row = (back.rows || [])[0];
          return Object.assign({}, data, { id: (row && row.id) || 0 });
        } catch (e) { /* 回查失败就返回 0，由调用方容错 */ }
      }
      return Object.assign({}, data, { id });
    },
    update: async (table, id, data) => {
      const r = await run(buildUpdate(table, id, data));
      return { affectedRows: r.affectedRows || 0 };
    },
    remove: async (table, id) => {
      const r = await run(buildDelete(table, id));
      return { affectedRows: r.affectedRows || 0 };
    },
    /** 供需要时直接跑 SQL（例如 COUNT）。 */
    raw: run,
  };
}
