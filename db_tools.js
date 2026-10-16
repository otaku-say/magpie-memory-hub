/**
 * db_tools.js —— 数据库结构管理与 R2 存储工具的实现。
 *
 * 权限模型（实测确认，2026-10-16）：
 *   - 数据读写（记忆存取）→ 数据库 **Secret Key**（REST CRUD）
 *   - 建表/清库/schema/R2 → **MCP key**（HTTP JSON-RPC）
 * 两者是不同凭据：Secret Key 的 REST API 只有 6 类 CRUD 共 27 个端点，
 * 任何 DDL 端点实测均 404，所以结构操作必须走 MCP key。
 */
import { NcbMcp, extractSecret, extractInstance } from "./ncb_mcp.js";
import {
  detectDrift, buildStatements, buildDropStatements, describePlan,
  versionUpsertSQL, SCHEMA_VERSION, TABLES, META_TABLE, VERSION_KEY, toNcbTables,
} from "./schema.js";
import { rememberSecret, lookupSecret, rememberDatabase, knownDatabases } from "./local_state.js";
import { r2Setup, r2Upload, r2Guide } from "./r2.js";

/** 清库需要显式确认串，避免 agent 误触。 */
export const RESET_CONFIRM = "RESET";

function mcpOf(cfg) {
  const key = (cfg && (cfg.mcp_key || cfg.mcpKey)) || "";
  if (!key) {
    const err = new Error(
      "未配置 MCP key。数据库 Secret Key 只能读写数据，无法建表——" +
      "「初始化/清空数据库」需要 MCP key（在 NoCodeBackend 后台 Developer 页面获取）。" +
      "请在插件设置页填写 mcp_key。"
    );
    err.code = "NO_MCP_KEY";
    throw err;
  }
  return new NcbMcp({ apiKey: key });
}

function dbOf(cfg, args) {
  // 兼容两种命名：readOptions 映射出的是 instance；直接传原始 options 时是 ncb_instance
  const db = (args && args.database) || (cfg && (cfg.instance || cfg.ncb_instance)) || "";
  if (!db) {
    const err = new Error("未指定数据库名（请在设置页填 ncb_instance，或给工具传 database 参数）");
    err.code = "NO_DATABASE";
    throw err;
  }
  return db;
}

/**
 * 读数据库结构的**降级通道**：走 NCB 的 public schema 端点。
 *
 * 实测（2026-10-16）：`GET https://app.nocodebackend.com/api/public/schema?instance=<库>`
 * **不需要任何凭据**就返回完整表结构（带 Secret Key 也行）。
 * 于是即使没填 MCP key，插件也能做只读的结构检查——只是不能建表。
 */
export async function fetchPublicSchema(database) {
  const url = "https://app.nocodebackend.com/api/public/schema?instance=" + encodeURIComponent(database);
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
  try {
    const res = await fetch(url, { signal: ctrl ? ctrl.signal : undefined });
    if (timer) clearTimeout(timer);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { return { ok: false, error: "返回不是 JSON" }; }
    if (res.status >= 400 || !body || !body.tables) {
      return { ok: false, error: `HTTP ${res.status}` , body };
    }
    return { ok: true, schema: body, via: "public-schema" };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ------------------------------------------------------------------ *
 * db_status —— 只读：报告当前结构 vs 期望结构的差集
 * ------------------------------------------------------------------ */
export async function dbStatus(cfg, args) {
  const db = dbOf(cfg, args);
  const hasMcp = !!((cfg && (cfg.mcpKey || cfg.mcp_key)) || "");

  if (!hasMcp) {
    // 降级：没有 MCP key 也能只读检查结构（走 public schema，无需凭据）
    const pub = await fetchPublicSchema(db);
    if (!pub.ok) {
      return {
        ok: false, database: db, action: "NO_MCP_KEY",
        reason: "未配置 MCP key，且降级通道也读不到结构：" + (pub.error || "未知错误"),
        hint: "建表/清库必须用 MCP key；只读检查可用数据库 Secret Key 或直接匿名访问。",
      };
    }
    const drift = detectDrift(pub.schema);
    return {
      ok: true, database: db, schema_version: SCHEMA_VERSION,
      via: pub.via, read_only: true,
      initialized: drift.ok && drift.missingTables.length === 0 &&
        drift.missingColumns.length === 0 && drift.missingIndexes.length === 0,
      missing_tables: drift.missingTables,
      missing_columns: drift.missingColumns.map((x) => `${x.table}.${x.column.name}`),
      foreign_tables: drift.unknownTables.map((x) => ({ table: x.table, columns: x.columns })),
      note: "当前只有只读能力（未配置 MCP key）。要自动建表/清库，请在设置页填 MCP key。",
    };
  }

  const mcp = mcpOf(cfg);
  const schema = await mcp.getSchema(db);
  const drift = detectDrift(schema);
  if (!drift.ok) {
    return { ok: false, database: db, reason: drift.reason };
  }
  const plan = describePlan(buildStatements(drift));
  const cur = (schema && schema.tables) || {};
  return {
    ok: true,
    database: db,
    schema_version: SCHEMA_VERSION,
    initialized: plan.total === 0,
    pending: plan,
    present_tables: Object.keys(cur).filter((t) => TABLES[t]),
    missing_tables: drift.missingTables,
    missing_columns: drift.missingColumns.map((x) => `${x.table}.${x.column.name}`),
    // 库里有、但插件不认识的表 —— 只报告，永不触碰
    foreign_tables: drift.unknownTables.map((x) => ({ table: x.table, columns: x.columns })),
    note: plan.total === 0
      ? "结构已完整，无需初始化。"
      : `还需 ${plan.total} 步才能完成初始化。`,
  };
}

/* ------------------------------------------------------------------ *
 * db_init —— 幂等初始化：只增不删，先探测后执行
 * ------------------------------------------------------------------ */
export async function dbInit(cfg, args) {
  const db = dbOf(cfg, args);
  const dryRun = !!(args && args.dry_run);
  const mcp = mcpOf(cfg);

  const schema = await mcp.getSchema(db);
  const drift = detectDrift(schema);
  if (!drift.ok) {
    // 读不到结构时必须中止：宁可不动，也不能盲目建表
    return { ok: false, database: db, action: "ABORT", reason: drift.reason };
  }

  const stmts = buildStatements(drift);
  const plan = describePlan(stmts);
  if (stmts.length === 0) {
    return {
      ok: true, database: db, action: "NOOP",
      note: "结构已完整，无需改动（重复点击是安全的）。",
      plan, foreign_tables: drift.unknownTables.map((x) => x.table),
    };
  }
  if (dryRun) {
    return {
      ok: true, database: db, action: "DRYRUN", plan,
      statements: stmts.map((s) => s.sql),
      foreign_tables: drift.unknownTables.map((x) => x.table),
    };
  }

  // 执行：语句 → 版本记录
  const all = stmts.concat([{ kind: "version_record", sql: versionUpsertSQL(SCHEMA_VERSION) }]);
  const results = await mcp.executeSqlBatch(db, all);
  const failed = results.filter((r) => !r.ok);
  const benign = results.filter((r) => r.benign).length;

  return {
    ok: failed.length === 0,
    database: db,
    action: "CREATE",
    applied: results.length - failed.length,
    benign_skips: benign,           // 重复建索引等「目标已达成」的情况
    failed: failed.map((f) => ({ sql: f.sql.slice(0, 160), error: f.error || (f.out && f.out.error) || "unknown" })),
    plan,
    foreign_tables: drift.unknownTables.map((x) => x.table),
    note: failed.length === 0
      ? "初始化完成。整个过程只做 CREATE/ADD，未修改或删除任何既有列与数据。"
      : "部分语句失败，请查看 failed 明细；既有结构与数据未被破坏。",
  };
}

/* ------------------------------------------------------------------ *
 * db_reset —— 清空：删除插件自己的三张表（结构 + 数据）
 * ------------------------------------------------------------------ */
export async function dbReset(cfg, args) {
  const db = dbOf(cfg, args);
  const confirm = (args && args.confirm) || "";
  if (confirm !== RESET_CONFIRM) {
    // 二次确认：必须显式传 confirm="RESET"，防止 agent 误触
    const mcp0 = mcpOf(cfg);
    let plan = null;
    try {
      const schema = await mcp0.getSchema(db);
      plan = describePlan(buildDropStatements(schema));
    } catch (e) { /* 探测失败不影响提示 */ }
    return {
      ok: false,
      action: "CONFIRM_REQUIRED",
      database: db,
      will_drop: buildDropStatements().map((s) => s.table),
      dropped_data: "这些表内的**全部数据与结构**都会被删除，不可恢复。",
      warning: "这是破坏性操作。若确认，请再次调用并传 confirm=\"RESET\"。",
    };
  }

  const mcp = mcpOf(cfg);
  const drops = buildDropStatements();
  const results = await mcp.executeSqlBatch(db, drops);
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    database: db,
    action: "DROP",
    dropped: drops.map((s) => s.table),
    failed: failed.map((f) => ({ sql: f.sql, error: f.error || (f.out && f.out.error) || "unknown" })),
    note: failed.length === 0
      ? "已清空插件三张表（结构 + 数据）。库中其它表未被触碰。"
      : "部分删除失败，详见 failed。",
    hint: "可随时重新调用 db_init 重建结构。",
  };
}

/* ------------------------------------------------------------------ *
 * 重名检测：从 list_databases 的文本清单里解析出已有库名
 * ------------------------------------------------------------------ */

/** 从 "You have created N databases...\n- 41694_test (Display Name: test) (US Region)" 解析库名。 */
export function parseDatabases(text) {
  const out = [];
  const re = /^\s*[-*]\s+([A-Za-z0-9_]+)\s*\(/gm;
  let m;
  while ((m = re.exec(String(text || "")))) out.push(m[1]);
  return out;
}

/** 推断账号前缀（现有库名里第一个下划线之前的部分）。 */
export function inferAccount(names) {
  for (const n of names || []) {
    const i = n.indexOf("_");
    if (i > 0 && /^\d+$/.test(n.slice(0, i))) return n.slice(0, i);
  }
  return "";
}

/** 去掉账号前缀，拿到逻辑名。 */
export function logicalName(name, account) {
  const n = String(name || "");
  if (account && n.startsWith(account + "_")) return n.slice(account.length + 1);
  return n;
}

/* ------------------------------------------------------------------ *
 * db_provision —— 一键创建插件所需的一切（只填 MCP key 即可）
 *
 * 为什么必须【先查再建】：
 *   实测发现 NoCodeBackend 遇到重名**不会报错**，而是静默加后缀——
 *   请求 `memhub` 而已存在时，会建成 `41694_memhub_1`。
 *   若不预检，插件就会另建一个空库，**数据被劈成两半**。
 * ------------------------------------------------------------------ */
export async function dbProvision(cfg, args) {
  const mcp = mcpOf(cfg);
  const want = String((args && args.database) || (cfg && cfg.instance) || "").trim();
  if (!want) {
    const err = new Error("未指定数据库名（数据库名称是必填的）");
    err.code = "NO_DATABASE";
    throw err;
  }
  // 重名策略：reuse（默认，复用不新建）/ auto_rename（允许新建带后缀的库）/ fail（报错让用户改名）
  const onExist = String((args && args.on_exist) || "reuse");
  const withR2 = !(args && args.with_r2 === false);

  // 1) 先列出现有库（账号内命名空间；跨账号不会冲突，因为 NCB 会强制加账号前缀）
  let existing = [];
  try {
    existing = parseDatabases(await mcp.listDatabasesText());
  } catch (e) {
    // 列不出来就绝不能建库：宁可不动，也不要凭猜测建出一个重复的库
    return { ok: false, action: "ABORT", reason: "无法列出已有数据库：" + String(e && e.message || e) };
  }
  const account = inferAccount(existing);
  const full = account ? account + "_" + logicalName(want, account) : want;
  const found = existing.find(
    (x) => x === want || x === full || logicalName(x, account) === logicalName(want, account)
  ) || "";

  let actual = found || full;
  let created = false;
  let secretCaptured = false;
  const notes = [];

  if (found) {
    if (onExist === "fail") {
      return {
        ok: false, action: "NAME_TAKEN", database: found,
        suggestion: "换一个数据库名，或者把 on_exist 设为 reuse（复用已有库，只补结构、不破坏数据）。",
        existing_databases: existing,
      };
    }
    if (onExist === "reuse") {
      actual = found;
      notes.push("数据库 " + found + " 已存在 → 按 reuse 策略复用它：只补齐缺失的表/列/索引，不会新建、不会破坏已有数据。");
    } else {
      // auto_rename：交给 NCB 自动加后缀（它会建成 <name>_1），并如实报告实际名字
      const r = await mcp.createDatabase(want, toNcbTables(), { enableAuth: false, region: args && args.region });
      created = true;
      actual = extractInstance(r, "") || want;
      const sec = extractSecret(r);
      if (sec) { secretCaptured = rememberSecret(actual, sec); }
      notes.push("名为 " + found + " 的库已存在；按 auto_rename 策略新建了 " + actual +
        "（注意：这会是一个**独立的空库**，与原库数据不相通）。");
    }
  } else {
    const r = await mcp.createDatabase(want, toNcbTables(), { enableAuth: false, region: args && args.region });
    created = true;
    actual = extractInstance(r, "") || full;
    const sec = extractSecret(r);
    if (sec) { secretCaptured = rememberSecret(actual, sec); }
    if (actual !== full) {
      notes.push("请求的库名是 " + full + "，NCB 实际建成了 " + actual + "（已按实际名字继续）。");
    }
  }
  // 记住本次真正使用的库，后续以为准
  try { rememberDatabase(actual); } catch (e) { /* 忽略 */ }

  // 2) 补齐结构：create_database 不会建索引，也不带 created_at/updated_at，
  //    这里用同一套差集逻辑补上（只增不删）。
  let init = null;
  try {
    init = await dbInit(Object.assign({}, cfg, { instance: actual }), { database: actual });
  } catch (e) {
    init = { ok: false, error: String(e && e.message || e) };
  }

  // 3) 挂 R2（可选）
  let r2 = null;
  if (withR2) {
    try {
      r2 = await r2Setup(Object.assign({}, cfg, { instance: actual }), {
        database: actual,
        bucket_name: args && args.bucket_name,
        public_url: args && args.public_url,
        account_id: args && args.account_id,
        access_key_id: args && args.access_key_id,
        secret_access_key: args && args.secret_access_key,
      });
    } catch (e) {
      r2 = { ok: false, error: String(e && e.message || e) };
    }
  }

  return {
    ok: !!(init && init.ok) && (!r2 || r2.ok !== false),
    action: created ? "CREATED" : "REUSED",
    database: actual,
    requested_name: want,
    existed_before: !!found,
    created_new_database: created,
    secret_captured: secretCaptured,
    schema: init && { action: init.action, applied: init.applied, pending: init.pending, foreign_tables: init.foreign_tables },
    r2: r2 && { ok: r2.ok, bucket: r2.result && r2.result.bucket_name, public_url: r2.result && r2.result.public_url },
    notes,
    next: created
      ? (secretCaptured
        ? "已自动取得并保存该库的 Secret Key（无需手填），数据读写可直接用。"
        : "未能自动取得 Secret Key，请在设置页手动填写。")
      : "复用了已有库；Secret Key 请确认设置页已填（本插件不会覆盖它）。",
  };
}

/* ------------------------------------------------------------------ *
 * storage_setup —— 配置该数据库的 R2 存储（自动建 bucket + CORS）
 * ------------------------------------------------------------------ */
export async function storageSetup(cfg, args) {
  return await r2Setup(cfg, args);
}

/* ------------------------------------------------------------------ *
 * storage_upload —— 上传文件到 R2，返回公开 URL
 *   - 传 content：直接上传（文本或 base64）
 *   - 不传 content：返回 presigned 上传 URL，供大文件由客户端直传
 * ------------------------------------------------------------------ */
export async function storageUpload(cfg, args) {
  return await r2Upload(cfg, args);
}

/* ------------------------------------------------------------------ *
 * storage_guide —— 告诉 agent 该怎么用 R2（把能力边界讲清楚）
 * ------------------------------------------------------------------ */
export function storageGuide(cfg) {
  return r2Guide();
}

