/**
 * schema.js —— 数据库结构的【唯一真相源】与幂等迁移。
 *
 * 设计原则（按用户要求「防止未来误点影响已有表结构、字段和值」）：
 *   1. 只增不删：只 CREATE TABLE / ADD COLUMN / CREATE INDEX，永不 DROP、永不 MODIFY、永不改类型。
 *   2. 先探测后执行：先读当前 schema，算出差集，只对差集生成语句；无差集就是 no-op（幂等）。
 *   3. 结构版本号：记录在 memhub_meta 表里，用于判断是否需要迁移，而不是判断「是否已初始化」。
 *   4. 与执行通道解耦：本模块只产出【语句计划】，实际执行由调用方注入（MCP / REST / 用户复制）。
 *
 * 注意：本文件不 import 任何宿主 API，可在 Bun 宿主与 Node 测试里直接跑。
 */

/** 结构版本号。每次改动 TABLES 都要 +1，并在 MIGRATIONS 里补一条说明。 */
export const SCHEMA_VERSION = 3;

/** 各版本做了什么（给人看，也用于生成变更说明）。 */
export const MIGRATIONS = {
  1: "初始结构：memories / pitfalls / memhub_meta 三表 + 两个唯一索引",
  2: "新增 client 来源字段（memories / pitfalls）与 full_content 全文存储（memories）",
  3: "数据库表与字段语义重构：删除 dead fields (entities/hits/source)，重命名为语义明确字段 (scope_level, content_fingerprint, retrieval_count, related_entities, full_text, superseded_by_id, lifecycle_status, revision, last_used_at)，新增 origin 产生方式，改默认值 client='unknown'，重命名元数据表为 schema_meta",
};

/**
 * 表结构声明。
 *  - columns: 语义化列定义（name / type / args / notNull / default），便于做差集比对
 *  - indexes: 索引定义，unique 为真时是去重的最终保证
 */
export const TABLES = {
  memories: {
    comment: "记忆条目",
    columns: [
      { name: "id", type: "INT", args: "AUTO_INCREMENT", pk: true },
      { name: "project", type: "VARCHAR", length: 128, default: "'global'" },
      { name: "category", type: "VARCHAR", length: 64, default: "'fact'" },
      // 声明必须与 tools.js 的 saveMemory payload 逐字段对齐
      { name: "scope_level", type: "VARCHAR", length: 32, default: "'project'" },
      { name: "client", type: "VARCHAR", length: 64, default: "'unknown'" },
      { name: "origin", type: "VARCHAR", length: 32, default: "'tool'" },
      { name: "title", type: "VARCHAR", length: 512, notNull: true },
      { name: "content", type: "TEXT", notNull: true },
      { name: "full_text", type: "TEXT", nullable: true },
      { name: "tags", type: "VARCHAR", length: 512, default: "''" },
      { name: "related_entities", type: "VARCHAR", length: 512, default: "''" },
      /* 指纹目前恰好是 32 位十六进制（tools.js 与 harvest.py 都 slice(0,32)）。
       * 保持 VARCHAR(64) 提供充足余量。 */
      { name: "content_fingerprint", type: "VARCHAR", length: 64, notNull: true },
      { name: "confidence_score", type: "INT", default: "100" },
      // 状态：active / superseded / invalid
      { name: "lifecycle_status", type: "VARCHAR", length: 24, default: "'active'" },
      { name: "superseded_by_id", type: "INT", default: "0" },
      { name: "revision", type: "INT", default: "1" },
      { name: "retrieval_count", type: "INT", default: "0" },
      { name: "invalid_at", type: "DATETIME", nullable: true },
      // 软失效的原因，便于审计（superseded / user_forgot / duplicate / expired）
      { name: "invalid_reason", type: "VARCHAR", length: 64, default: "''" },
      // 会话级/轮次级记忆的到期时间；NULL = 永不过期
      { name: "expires_at", type: "DATETIME", nullable: true },
      // 最后被检索命中或被读取展开的时间；写库时不设置，默认为 NULL；仅在被取用时更新
      { name: "last_used_at", type: "DATETIME", nullable: true },
      { name: "created_at", type: "DATETIME", default: "CURRENT_TIMESTAMP" },
      { name: "updated_at", type: "DATETIME", default: "CURRENT_TIMESTAMP", onUpdate: "CURRENT_TIMESTAMP" },
    ],
    indexes: [
      // 去重的最终保证：NCB 有约 2 秒写后读延迟，靠「先读后写」会漏掉紧邻/并发重复
      { name: "idx_memories_uniq_fp", unique: true, columns: ["project", "content_fingerprint"] },
      { name: "idx_memories_scope", columns: ["project", "lifecycle_status"] },
      // 供「清理已过期记忆」用
      { name: "idx_memories_expires", columns: ["expires_at"] },
    ],
  },

  pitfalls: {
    comment: "踩坑记录",
    columns: [
      { name: "id", type: "INT", args: "AUTO_INCREMENT", pk: true },
      { name: "project", type: "VARCHAR", length: 128, default: "'global'" },
      { name: "client", type: "VARCHAR", length: 64, default: "'unknown'" },
      { name: "component", type: "VARCHAR", length: 128, notNull: true },
      { name: "symptom", type: "TEXT", notNull: true },
      { name: "root_cause", type: "TEXT", notNull: true },
      { name: "solution", type: "TEXT", notNull: true },
      { name: "severity", type: "VARCHAR", length: 16, default: "'medium'" },
      { name: "error_type", type: "VARCHAR", length: 64, default: "''" },
      { name: "tags", type: "VARCHAR", length: 512, default: "''" },
      { name: "content_fingerprint", type: "VARCHAR", length: 64, notNull: true },
      { name: "recurrence", type: "INT", default: "1" },
      { name: "invalid_at", type: "DATETIME", nullable: true },
      { name: "invalid_reason", type: "VARCHAR", length: 64, default: "''" },
      { name: "last_occurred_at", type: "DATETIME", default: "CURRENT_TIMESTAMP" },
      { name: "created_at", type: "DATETIME", default: "CURRENT_TIMESTAMP" },
      { name: "updated_at", type: "DATETIME", default: "CURRENT_TIMESTAMP", onUpdate: "CURRENT_TIMESTAMP" },
    ],
    indexes: [
      { name: "idx_pitfalls_uniq_fp", unique: true, columns: ["project", "content_fingerprint"] },
    ],
  },

  schema_meta: {
    comment: "插件自用元数据（结构版本等）。这是插件唯一的自有表，请勿写入业务数据。",
    columns: [
      { name: "id", type: "INT", args: "AUTO_INCREMENT", pk: true },
      { name: "k", type: "VARCHAR", length: 64, notNull: true },
      { name: "v", type: "TEXT" },
      { name: "updated_at", type: "DATETIME", default: "CURRENT_TIMESTAMP", onUpdate: "CURRENT_TIMESTAMP" },
    ],
    indexes: [
      { name: "idx_schema_meta_k", unique: true, columns: ["k"] },
    ],
  },
};

/**
 * 把上面的 TABLES 声明转成 NoCodeBackend `create_database` 需要的表定义格式。
 *
 * 为什么不各写一份：两处定义一旦不同步，就会出现「建库时漏了某列、
 * 之后 db_init 又补不上」的隐蔽故障（scope 列那次踩的就是这个坑）。
 * 所以这里**从 TABLES 派生**，永远只有一份真相。
 *
 * 类型映射：NCB 的 create_database 接受
 *   VARCHAR / TEXT / INT / BIGINT / DECIMAL / DATETIME / DATE / BOOLEAN / DROPDOWN / FILE / PASSWORD
 * 我们的声明里用到的 VARCHAR / TEXT / INT / DATETIME 都是同名直通。
 * 主键 id 由 NCB 自动加（AUTO_INCREMENT），不需要显式声明。
 */
export function toNcbTables() {
  var out = [];
  for (var tname in TABLES) {
    var t = TABLES[tname];
    var cols = [];
    for (var i = 0; i < t.columns.length; i++) {
      var c = t.columns[i];
      if (c.pk) continue;                       // 主键交给 NCB 生成
      var col = { name: c.name, type: c.type };
      if (c.length) col.length = c.length;
      if (c.notNull) col.notNull = true;
      // 只带「真实字面量」默认值；CURRENT_TIMESTAMP 这类函数式默认值
      // NCB 的建库接口不接受，留空由 db_init 后补。
      var d = c.default;
      if (typeof d === "string" && d.length && !/^(CURRENT_TIMESTAMP|NULL)$/i.test(d)) {
        col.defaultValue = d.replace(/^'|'$/g, "");   // 去掉 SQL 单引号
      }
      cols.push(col);
    }
    out.push({ name: tname, columns: cols });
  }
  return out;
}

/** 元数据表名（清库时也要删掉它）。 */
export const META_TABLE = "schema_meta";
/** 记录结构版本号的键名。 */
export const VERSION_KEY = "schema_version";

/* ------------------------------------------------------------------ *
 * DDL 生成
 * ------------------------------------------------------------------ */

function columnDDL(col) {
  // 类型与长度必须紧贴：VARCHAR(128)，不能是 VARCHAR (128)
  var parts = [col.name, col.type + (col.length ? "(" + col.length + ")" : "")];
  if (col.args) parts.push(col.args);
  if (col.pk) parts.push("PRIMARY KEY");
  if (col.notNull) parts.push("NOT NULL");
  else if (col.type !== "TEXT" && !col.pk && col.nullable !== true) parts.push("NULL");
  if (col.default !== undefined) parts.push("DEFAULT " + col.default);
  if (col.onUpdate) parts.push("ON UPDATE " + col.onUpdate);
  return parts.join(" ");
}

/** 生成「建表（若不存在）」语句。 */
export function createTableSQL(name) {
  var t = TABLES[name];
  if (!t) throw new Error("未知表: " + name);
  var cols = t.columns.map(columnDDL).join(",\n  ");
  return "CREATE TABLE IF NOT EXISTS " + name + " (\n  " + cols + "\n)";
}

/** 生成「建索引（若不存在）」语句。MySQL 不支持 CREATE INDEX IF NOT EXISTS，需先查。 */
export function createIndexSQL(table, idx) {
  return "CREATE " + (idx.unique ? "UNIQUE " : "") + "INDEX " + idx.name +
    " ON " + table + " (" + idx.columns.join(", ") + ")";
}

/* ------------------------------------------------------------------ *
 * 差集计算（幂等的核心）
 * ------------------------------------------------------------------ */

/**
 * 把调用方读到的当前 schema 规范化成 { 表名: { 列名: {...}, 索引名集合 } }。
 *
 * 兼容两种输入形态（不同来源字段名不完全一致，这里做兜底）：
 *   A) { tables: [ { name, columns: [ {name} | "colname" ], indexes: [ {name} | "idxname" ] } ] }
 *   B) { memories: { columns: [...] }, pitfalls: {...} }
 * 无法识别的输入 → 返回空对象（调用方据此判定「读不到结构」并中止，绝不盲目建表）。
 */
export function normalizeSchema(raw) {
  var out = {};
  if (!raw) return out;

  function putTable(tname, tdef) {
    if (!tname || !tdef) return;
    var cols = {};
    var rawCols = tdef.columns || tdef.fields || [];
    if (Array.isArray(rawCols)) {
      for (var i = 0; i < rawCols.length; i++) {
        var c = rawCols[i];
        var cn = typeof c === "string" ? c : (c && (c.name || c.column || c.column_name || c.Field));
        if (cn) cols[String(cn)] = (typeof c === "object" && c) || {};
      }
    } else if (rawCols && typeof rawCols === "object") {
      for (var k in rawCols) cols[k] = rawCols[k] || {};
    }
    var idx = {};
    var rawIdx = tdef.indexes || tdef.indices || [];
    if (Array.isArray(rawIdx)) {
      for (var j = 0; j < rawIdx.length; j++) {
        var x = rawIdx[j];
        var xn = typeof x === "string" ? x : (x && (x.name || x.index || x.Key_name || x.key_name));
        if (xn) idx[String(xn)] = true;
      }
    } else if (rawIdx && typeof rawIdx === "object") {
      for (var k2 in rawIdx) idx[k2] = true;
    }
    out[tname] = { columns: cols, indexes: idx, _raw: tdef };
  }

  if (Array.isArray(raw.tables)) {
    for (var i = 0; i < raw.tables.length; i++) {
      var t = raw.tables[i];
      if (t && t.name) putTable(t.name, t);
    }
  } else if (raw.tables && typeof raw.tables === "object") {
    for (var n in raw.tables) putTable(n, raw.tables[n]);
  } else if (raw.schema && typeof raw.schema === "object") {
    for (var n2 in raw.schema) putTable(n2, raw.schema[n2]);
  } else {
    // 形态 B：顶层就是表名
    for (var n3 in raw) {
      if (raw[n3] && typeof raw[n3] === "object") putTable(n3, raw[n3]);
    }
  }
  return out;
}

/**
 * 判断某个声明的索引在当前结构里是否已存在。
 *
 * ⚠️ 实测踩坑：NoCodeBackend 的 get_schema **不返回索引名**，而是把索引信息挂在
 * 列的 `indexed` / `unique` 布尔标志上（例如复合唯一索引 (project, fingerprint)
 * 会让这两列都变成 indexed:true, unique:true）。而 `SHOW INDEX` 被 NCB 的 SQL
 * 沙箱拦截（"Blocked statement: Command not allowed"），无法枚举索引名。
 * 因此只能按「列标志」推断：
 *   唯一索引 → 该索引涉及的**每一列**都必须 unique === true
 *   普通索引 → 该索引涉及的**每一列**都必须 indexed === true
 * 若某个来源恰好给了索引名（indexes 集合），优先按名字精确判断。
 *
 * 可能误判方向说明：多列各有自己的索引时，本规则可能「误以为」复合索引已存在
 * （假阳性）。此时只是跳过建索引，不会破坏任何东西；而假阴性会导致重复执行
 * CREATE INDEX，由 executeSqlBatch 对 Duplicate key name 的容错兜住。两侧都不会致命。
 */
function indexPresent(have, idx) {
  if (have && have.indexes && have.indexes[idx.name]) return true;
  var cols = (have && have.columns) || {};
  for (var i = 0; i < idx.columns.length; i++) {
    var c = cols[idx.columns[i]];
    if (!c) return false;
    if (idx.unique ? c.unique !== true : c.indexed !== true) return false;
  }
  return true;
}

/**
 * 计算差集：当前结构 vs 期望结构。
 * 返回 { ok, reason, missingTables, missingColumns, missingIndexes, unknownTables }
 *   - ok=false 表示无法判定（例如读不到结构），调用方必须中止，不得执行任何 DDL。
 *   - unknownTables 是「库里存在但声明里没有」的表 —— 只报告，绝不触碰。
 */
export function detectDrift(current) {
  var cur = normalizeSchema(current);
  var res = {
    ok: true, reason: "",
    missingTables: [], missingColumns: [], missingIndexes: [], unknownTables: [],
  };
  var isValidEmpty = current && !current.error && (current.tables != null || current.schema != null);
  if ((!cur || Object.keys(cur).length === 0) && !isValidEmpty) {
    res.ok = false;
    res.reason = "读不到当前数据库结构（可能密钥无效、实例名错误或网络不通）";
    return res;
  }

  for (var tname in TABLES) {
    var want = TABLES[tname];
    var have = cur[tname];
    if (!have) {
      res.missingTables.push(tname);
      // 表都不存在，其索引必然缺失（建表语句已含列，索引单独补）
      for (var ii = 0; ii < want.indexes.length; ii++) {
        res.missingIndexes.push({ table: tname, index: want.indexes[ii] });
      }
      continue;
    }
    for (var ci = 0; ci < want.columns.length; ci++) {
      var col = want.columns[ci];
      if (!have.columns[col.name]) {
        res.missingColumns.push({ table: tname, column: col });
      }
    }
    for (var xi = 0; xi < want.indexes.length; xi++) {
      var idx = want.indexes[xi];
      if (!indexPresent(have, idx)) {
        res.missingIndexes.push({ table: tname, index: idx });
      }
    }
  }

  for (var cn in cur) {
    if (!TABLES[cn]) {
      res.unknownTables.push({
        table: cn,
        columns: Object.keys(cur[cn].columns || {}).length,
      });
    }
  }
  return res;
}

/**
 * 把差集翻译成**只增不删**的 DDL 语句计划。
 * 顺序很重要：先建表 → 再加列 → 最后加索引（索引依赖列存在）。
 */
export function buildStatements(drift) {
  if (!drift || !drift.ok) return [];
  var stmts = [];
  for (var i = 0; i < drift.missingTables.length; i++) {
    stmts.push({ kind: "create_table", table: drift.missingTables[i], sql: createTableSQL(drift.missingTables[i]) });
  }
  for (var j = 0; j < drift.missingColumns.length; j++) {
    var mc = drift.missingColumns[j];
    stmts.push({
      kind: "add_column", table: mc.table, column: mc.column.name,
      // 新增列一律允许 NULL 且有默认值：库里有数据时加 NOT NULL 列会失败
      sql: "ALTER TABLE " + mc.table + " ADD COLUMN " +
        columnDDL(Object.assign({}, mc.column, { notNull: false, nullable: true })),
    });
  }
  for (var k = 0; k < drift.missingIndexes.length; k++) {
    var mi = drift.missingIndexes[k];
    stmts.push({
      kind: "create_index", table: mi.table, index: mi.index.name,
      unique: !!mi.index.unique,
      sql: createIndexSQL(mi.table, mi.index),
    });
  }
  return stmts;
}

/** 一条语句是否是破坏性的（清库用；初始化路径永远不会产生）。 */
export function isDestructive(sql) {
  return /^\s*(DROP|TRUNCATE|DELETE|ALTER\s+TABLE\s+\S+\s+(DROP|MODIFY|CHANGE|RENAME))/i.test(String(sql || ""));
}

/** 清库语句计划：删掉插件自己的三张表（连同结构与数据）。 */
export function buildDropStatements() {
  var stmts = [];
  // 先删索引随表一起走，无需单独 DROP INDEX
  var order = [META_TABLE, "pitfalls", "memories"];
  for (var i = 0; i < order.length; i++) {
    stmts.push({ kind: "drop_table", table: order[i], sql: "DROP TABLE IF EXISTS " + order[i] });
  }
  return stmts;
}

/** 初始化完成后的版本记录语句。 */
export function versionUpsertSQL(version) {
  var v = String(version);
  return "INSERT INTO " + META_TABLE + " (k, v) VALUES ('" + VERSION_KEY + "', '" + v +
    "') ON DUPLICATE KEY UPDATE v = '" + v + "'";
}

/** 人类可读的计划摘要（给二次确认弹窗用）。 */
export function describePlan(stmts) {
  var by = { create_table: [], add_column: [], create_index: [], drop_table: [] };
  for (var i = 0; i < stmts.length; i++) {
    var s = stmts[i];
    if (!by[s.kind]) by[s.kind] = [];
    if (s.kind === "create_table") by[s.kind].push(s.table);
    else if (s.kind === "add_column") by[s.kind].push(s.table + "." + s.column);
    else if (s.kind === "create_index") by[s.kind].push((s.unique ? "唯一索引 " : "索引 ") + s.index + " @ " + s.table);
    else if (s.kind === "drop_table") by[s.kind].push(s.table);
  }
  return {
    total: stmts.length,
    create_table: by.create_table, add_column: by.add_column,
    create_index: by.create_index, drop_table: by.drop_table,
  };
}
