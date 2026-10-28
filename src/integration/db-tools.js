/**
 * 模块职责：数据库结构管理与 R2 存储工具实现（探针/建库/初始化/重置/差集检测）
 * 依赖：src/integration/ncb.js, src/integration/schema.js, src/core/state.js, src/integration/r2-storage.js, src/integration/provider-models.js
 * 被依赖：src/integration/db-tools.js, src/index.js, page_actions.js, tests
 */

import { NcbMcp, extractSecret, extractInstance } from "./ncb-client.js";
import {
  detectDrift, buildStatements, buildDropStatements, describePlan,
  versionUpsertSQL, SCHEMA_VERSION, TABLES, META_TABLE, VERSION_KEY, toNcbTables,
} from "./schema.js";
import { rememberSecret, lookupSecret, forgetSecret, rememberDatabase, knownDatabases, lookupRealDatabase, clearAuditCursor, clearHarvestQueue, readStateForWrite, writeState } from "../core/state.js";
import { r2Setup, r2Upload, r2Guide, resolveRealDatabase } from "./r2-storage.js";
import { explainUnknownErrorWithModel, attachAiDiagnosis } from "./provider-models.js";

/** 清库需要显式确认串，避免 agent 误触。 */
export const RESET_CONFIRM = "RESET";

function mcpOf(cfg, signal) {
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
  return new NcbMcp({ apiKey: key, signal: signal || (cfg && cfg.signal) || null });
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
export async function fetchPublicSchema(database, opts) {
  const externalSignal = (opts && (opts.signal || (opts instanceof (typeof AbortSignal !== "undefined" ? AbortSignal : Object) ? opts : null))) || null;
  if (externalSignal && externalSignal.aborted) {
    return { ok: false, error: "操作已被取消 (aborted)" };
  }
  const url = "https://app.nocodebackend.com/api/public/schema?instance=" + encodeURIComponent(database);
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
  let abortListener = null;
  if (ctrl && externalSignal) {
    abortListener = () => ctrl.abort();
    externalSignal.addEventListener("abort", abortListener, { once: true });
  }
  try {
    const res = await fetch(url, { signal: ctrl ? ctrl.signal : undefined });
    /* v6.48.0 修复：原先在此处就 clearTimeout，而 body 尚未读取；响应头到达后 body
     * 卡住（慢速滴流/半死连接）便再无兜底超时。清理统一移到 finally。 */
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { return { ok: false, error: "返回不是 JSON" }; }
    if (res.status >= 400 || !body || !body.tables) {
      return { ok: false, error: `HTTP ${res.status}` , body };
    }
    return { ok: true, schema: body, via: "public-schema" };
  } catch (e) {
    const isAbort = externalSignal && externalSignal.aborted;
    return { ok: false, error: isAbort ? "操作已被取消 (aborted)" : String(e && e.message || e) };
  } finally {
    if (timer) clearTimeout(timer);
    if (externalSignal && typeof abortListener === "function") externalSignal.removeEventListener("abort", abortListener);
  }
}

/* ------------------------------------------------------------------ *
 * db_status —— 只读：报告当前结构 vs 期望结构的差集
 * ------------------------------------------------------------------ */
export async function dbStatus(cfg, args) {
  const rawDb = dbOf(cfg, args);
  const db = (await resolveRealDatabase(cfg, rawDb)) || rawDb;
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
  const rawDb = dbOf(cfg, args);
  const db = (await resolveRealDatabase(cfg, rawDb)) || rawDb;
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

/**
 * 校验传入库名与配置库名是否指向同一逻辑库（去掉数字前缀归一化比对）
 */
export function isSameDatabaseTarget(a, b) {
  const strA = String(a || "").trim().toLowerCase();
  const strB = String(b || "").trim().toLowerCase();
  if (!strA || !strB) return false;

  const mA = strA.match(/^(\d+)_(.*)$/);
  const mB = strB.match(/^(\d+)_(.*)$/);
  const prefixA = mA ? mA[1] : null;
  const prefixB = mB ? mB[1] : null;

  // a) 若两侧都有前缀且前缀不等 → 直接 false（不同账号，防止跨账号越权清库）
  if (prefixA !== null && prefixB !== null && prefixA !== prefixB) {
    return false;
  }

  // b) 若一侧无前缀一侧有前缀 → 视为同一库（逻辑名 vs 真实名），允许比对主体
  // c) 若双侧前缀相同 → 去掉前缀比较余下部分
  const restA = mA ? mA[2] : strA;
  const restB = mB ? mB[2] : strB;
  return Boolean(restA && restB && restA === restB);
}

export async function dbReset(cfg, args) {
  const configuredDb = String((cfg && (cfg.instance || cfg.ncb_instance)) || "").trim();
  if (args && args.database) {
    const passedDb = String(args.database).trim();
    if (!configuredDb || !isSameDatabaseTarget(passedDb, configuredDb)) {
      const err = new Error(`安全防护拦截：拒绝清空外来数据库或系统表！目标数据库 "${passedDb}" 与当前配置的目标实例 "${configuredDb}" 不匹配。`);
      err.code = "FORBIDDEN_DATABASE";
      throw err;
    }
  }

  if (!configuredDb) {
    const err = new Error("未指定数据库名（请在设置页填 ncb_instance，或在配置中指定目标实例）");
    err.code = "NO_DATABASE";
    throw err;
  }

  // d) dbReset 执行 DROP 前，强制使用配置侧的库名（cfg.instance/ncb_instance 解析出的真实库名），绝不使用 args.database 直接执行；args.database 只用于校验
  const rawDb = configuredDb;
  const db = (await resolveRealDatabase(cfg, rawDb)) || rawDb;
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
  if (failed.length === 0) {
    try {
      if (typeof clearHarvestQueue === "function") {
        clearHarvestQueue();
      }
      const st = readStateForWrite();
      // 遍历 state.audit.cursors 清空全部 project（不仅当前）
      if (st.audit && st.audit.cursors && typeof st.audit.cursors === "object") {
        for (const prj of Object.keys(st.audit.cursors)) {
          if (typeof clearAuditCursor === "function") {
            try { clearAuditCursor(prj); } catch (_) {}
          }
        }
      }
      /* 走普通写入通道：若 state 恰好残留 __corrupt 标记，这里会重建干净基座并在
       * corrupt_recovery 里留下重放窗口，避免「清库清理动作因状态损坏而静默失效」。 */
      const freshState = readStateForWrite();
      if (freshState.audit && typeof freshState.audit === "object") {
        freshState.audit.cursors = {};
      }
      // 清空 gateway_harvest 指纹缓存与文件处理状态
      freshState.gateway_harvest = { files: {}, processed_fingerprints: [] };
      // 清空 harvest_queue 与 pending_patterns
      freshState.harvest_queue = [];
      freshState.pending_patterns = {};
      // 严禁整体抹平 secrets/actions/r2_mounts
      writeState(freshState);
    } catch (_) {}
  }
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
  const want = String((args && args.database) || (cfg && (cfg.instance || cfg.ncb_instance)) || "").trim();
  if (!want) {
    const err = new Error("未指定数据库名（数据库名称是必填的）");
    err.code = "NO_DATABASE";
    throw err;
  }
  // 重名策略：reuse（默认，复用不新建）/ auto_rename（允许新建带后缀的库）/ fail（报错让用户改名）
  const onExist = String((args && args.on_exist) || "reuse").toLowerCase().trim();
  if (!["reuse", "fail", "auto_rename"].includes(onExist)) {
    return { ok: false, action: "ABORT", reason: `未知 on_exist 策略 "${args && args.on_exist}"（只允许 reuse / fail / auto_rename）` };
  }
  const withR2 = Boolean(args && args.with_r2 === true);

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
      if (sec) {
        secretCaptured = rememberSecret(actual, sec);
        notes.push("已自动保存建库时返回的新 Secret Key（无需手动填写）。");
      }
      notes.push("名为 " + found + " 的库已存在；按 auto_rename 策略新建了 " + actual +
        "（注意：这会是一个**独立的空库**，与原库数据不相通）。");
    }
  } else {
    const r = await mcp.createDatabase(want, toNcbTables(), { enableAuth: false, region: args && args.region });
    created = true;
    actual = extractInstance(r, "") || full;
    const sec = extractSecret(r);
    if (sec) {
      secretCaptured = rememberSecret(actual, sec);
      notes.push("已自动保存建库时返回的新 Secret Key（无需手动填写）。");
    }
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

/* ------------------------------------------------------------------ *
 * ncb_check —— 检测 MCP Key 有效性与数据库/结构状态（只读）
 * ------------------------------------------------------------------ */

export function explainMcpFailure(err) {
  const m = String(err || "");
  if (/Unauthorized|401|403|Forbidden|invalid api key|invalid token|auth|user email|access to user profile/i.test(m)) {
    return {
      kind: "INVALID_MCP_KEY",
      title: "MCP Key 无效或未授权",
      detail: "NoCodeBackend 拒绝了 MCP 认证请求，通常是 API Token 填写有误、已过期或已被删除。",
      actions: [
        "① 登录 NoCodeBackend 控制台 → 顶部 Developer 菜单",
        "② 复制有效的 API Token 并注意去除首尾空格",
        "③ 粘贴到插件设置页「MCP Key」输入框中并保存",
      ],
    };
  }
  if (/timeout|abort|ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(m)) {
    return {
      kind: "NETWORK_ERROR",
      title: "无法连接 NoCodeBackend 服务",
      detail: "请求 NoCodeBackend 服务端超时或网络无法连通：" + m.slice(0, 100),
      actions: [
        "① 检查当前网络与 DNS 设置是否正常",
        "② 确认能够正常访问 https://app.nocodebackend.com",
      ],
    };
  }
  return {
    kind: "MCP_CALL_FAILED",
    title: "NoCodeBackend MCP 调用失败",
    detail: m.slice(0, 150),
    actions: [
      "① 请检查 NoCodeBackend 控制台服务状态",
      "② 重新生成 API Token 并重试",
    ],
  };
}

export async function ncbCheck(cfg, args) {
  const a = args || {};
  const key = (a && a.mcp_key) || (cfg && (cfg.mcp_key || cfg.mcpKey)) || "";
  const want = (a && a.database) || (cfg && (cfg.instance || cfg.ncb_instance)) || "";

  if (!key) {
    const diag = {
      kind: "NO_MCP_KEY",
      title: "未配置 MCP Key",
      detail: "当前未提供 MCP Key，无法与 NoCodeBackend 进行控制面通信。",
      actions: [
        "① 登录 NoCodeBackend 控制台 → 顶部 Developer 菜单",
        "② 生成或复制 API Token",
        "③ 填写到插件设置页的 MCP Key 输入框并保存",
      ],
    };
    return {
      ok: false,
      verdict: "FAILED",
      database: want,
      database_exists: false,
      database_count: 0,
      schema: null,
      foreign_tables: [],
      title: diag.title,
      lines: [
        "未配置 MCP Key（字段为空）",
        "无法调用 NoCodeBackend 的控制面接口",
        "请在设置页配置 MCP Key 后重试",
      ],
      diagnosis: diag,
    };
  }

  const signal = (cfg && cfg.signal) || null;
  if (signal && signal.aborted) {
    const abortErr = new Error("操作已被取消 (aborted)");
    abortErr.name = "AbortError";
    throw abortErr;
  }

  const mcp = new NcbMcp({ apiKey: key, signal });
  let dbListText = "";
  try {
    dbListText = await mcp.listDatabasesText();
  } catch (e) {
    if (e.name === "AbortError" || (signal && signal.aborted)) {
      throw e;
    }
    const errMsg = String((e && e.message) || e);
    const diag = explainMcpFailure(errMsg);
    const res = {
      ok: false,
      verdict: "FAILED",
      database: want,
      database_exists: false,
      database_count: 0,
      schema: null,
      foreign_tables: [],
      title: diag.title,
      lines: [
        "验证 MCP Key 失败：无法列举数据库",
        `错误明细：${errMsg.slice(0, 100)}`,
        diag.actions[0] || "请检查 MCP Key 是否正确",
      ],
      diagnosis: diag,
    };
    if (diag.kind === "MCP_CALL_FAILED") {
      try {
        const aiDiag = await explainUnknownErrorWithModel({
          error: errMsg,
          component: "ncb_check",
          database: want,
          options: cfg,
        });
        if (aiDiag) attachAiDiagnosis(res, aiDiag);
      } catch (_) {}
    }
    return res;
  }

  const existing = parseDatabases(dbListText);
  const count = existing.length;
  const account = inferAccount(existing);
  const full = account ? account + "_" + logicalName(want, account) : want;
  const found = existing.find(
    (x) => x === want || x === full || (account && logicalName(x, account) === logicalName(want, account))
  ) || "";

  if (!found) {
    return {
      ok: true,
      verdict: "VERIFIED",
      database: want || full || "",
      database_exists: false,
      database_count: count,
      schema: null,
      foreign_tables: [],
      title: "MCP Key 有效，目标库尚未创建",
      lines: [
        `密钥可用，账号下已有 ${count} 个数据库`,
        `目标库 ${want || "(未指定)"} 尚未存在`,
        "可点击「一键创建」自动建库并配置表结构",
      ],
      diagnosis: null,
    };
  }

  // 目标库存在：获取结构并检测 drift
  try {
    const { rememberDatabase } = await import("../core/state.js");
    rememberDatabase(found);
  } catch (_) {}
  let schemaRes = null;
  let foreignTables = [];
  try {
    const rawSchema = await mcp.getSchema(found);
    const drift = detectDrift(rawSchema);
    const initialized = drift.ok && drift.missingTables.length === 0 &&
      drift.missingColumns.length === 0 && drift.missingIndexes.length === 0;
    schemaRes = {
      initialized,
      missing_tables: drift.missingTables || [],
      missing_columns: (drift.missingColumns || []).map((x) => `${x.table}.${x.column.name}`),
      missing_indexes: (drift.missingIndexes || []).map((x) => `${x.table}.${x.index.name || (x.index.columns && x.index.columns.join("_")) || "idx"}`),
    };
    foreignTables = (drift.unknownTables || []).map((x) => ({
      table: x.table,
      columns: Array.isArray(x.columns) ? x.columns.length : (typeof x.columns === "object" && x.columns ? Object.keys(x.columns).length : Number(x.columns) || 0),
    }));
  } catch (e) {
    schemaRes = { initialized: false, error: String((e && e.message) || e) };
  }

  const isInit = schemaRes && schemaRes.initialized;
  const lines = [
    `密钥可用，账号下有 ${count} 个数据库`,
    `目标库 ${found} 存在`,
  ];
  if (isInit) {
    lines.push("结构完整，3 张核心表与索引均已就绪");
  } else if (schemaRes && schemaRes.error) {
    lines.push(`读取结构异常：${schemaRes.error}`);
    lines.push("可能无权读取表结构，请检查 MCP Key 权限");
  } else {
    lines.push("核心表或索引存在缺失，建议点击「初始化结构」");
  }

  const res = {
    ok: true,
    verdict: "VERIFIED",
    database: found,
    database_exists: true,
    database_count: count,
    schema: schemaRes,
    foreign_tables: foreignTables,
    title: isInit ? "MCP Key 有效，数据库已就绪" : "MCP Key 有效，目标库结构待补齐",
    lines,
    diagnosis: null,
  };

  if (schemaRes && schemaRes.error) {
    try {
      const aiDiag = await explainUnknownErrorWithModel({
        error: schemaRes.error,
        component: "ncb_check",
        database: found,
        options: cfg,
      });
      if (aiDiag) attachAiDiagnosis(res, aiDiag);
    } catch (_) {}
  }

  return res;
}

/* ------------------------------------------------------------------ *
 * secret_check —— 检测数据库 Secret Key 是否有效（只读验证，不上传文件）
 * ------------------------------------------------------------------ */
export async function secretCheck(cfg, args) {
  const rawDb = String((args && args.database) || (cfg && (cfg.instance || cfg.ncb_instance)) || "").trim();
  // 关键：必须解析成 NCB 要求的真实库名（带账号数字前缀，如 41694_agent_memory）
  // 传逻辑名会直接被 NCB 报 403 (Invalid secret_key)
  const db = await resolveRealDatabase(cfg, rawDb);
  const manual = String((args && args.secret) || (cfg && (cfg.ncb_secret || cfg.secret)) || "").trim();
  const captured = db ? (lookupSecret(db) || lookupSecret(rawDb)) : (lookupSecret("") || "");
  const secretToUse = manual || captured || "";
  const source = manual ? "手动填写" : (captured ? "自动捕获" : "未提供");

  // 分支 1：未填且无可用捕获值
  if (!secretToUse) {
    return {
      ok: false,
      verdict: "EMPTY",
      source: "未提供",
      database: db || rawDb,
      title: "未填写 Secret Key",
      lines: [
        "未检测到数据库 Secret Key（设置页未填写，本地也无自动捕获记录）",
        "Secret Key 只在建库时返回一次，MCP Key 无法读取它，插件也拿不到 —— 必须手动去 NoCodeBackend 控制台复制",
        "获取途径：打开 NoCodeBackend 控制台 → 找到该数据库 → 复制 Secret Key 填入",
        "自救路径：如无法找回旧密钥，可点击「一键创建数据库」并选择新建（auto_rename 策略）来获得一把新密钥",
      ],
    };
  }

  // 分支 2：格式明显不对（如含空格、长度过短、或者误填了 mcp_ key）
  const isMcpKey = secretToUse.startsWith("mcp_") || secretToUse.startsWith("mcp_sec_");
  const hasWhitespace = /\s/.test(secretToUse);
  const isTooShort = secretToUse.length < 16;
  if (isMcpKey || hasWhitespace || isTooShort) {
    return {
      ok: false,
      verdict: "MALFORMED",
      source,
      database: db || rawDb,
      title: "Secret Key 格式明显不对",
      lines: [
        `目标数据库：${db || rawDb}（来源：${source}）`,
        isMcpKey
          ? "格式错误：当前填入的是 MCP Key（账号级），并非数据库 Secret Key（库级）"
          : (hasWhitespace ? "格式错误：密钥中包含空格或换行，请检查并清除空白字符" : "格式错误：密钥长度过短，可能复制不完整"),
        "提示：Secret Key 仅在建库时返回一次，用于 REST 接口鉴权",
        "解决办法：前往 NoCodeBackend 控制台 → 该数据库 → 重新复制完整的 Secret Key",
      ],
    };
  }

  const url = "https://api.nocodebackend.com/files?Instance=" + encodeURIComponent(db || rawDb);
  const externalSignal = (cfg && cfg.signal) || null;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const abortListener = () => ctrl.abort();
  const timer = ctrl ? setTimeout(() => { if (externalSignal) externalSignal.removeEventListener("abort", abortListener); ctrl.abort(); }, 15000) : null;
  if (ctrl && externalSignal) {
    externalSignal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + secretToUse },
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (timer) clearTimeout(timer); if (externalSignal && typeof abortListener === "function") externalSignal.removeEventListener("abort", abortListener);

    if (res.status < 400) {
      return {
        ok: true,
        verdict: "VALID",
        source,
        database: db || rawDb,
        title: "Secret Key 有效（" + source + "）",
        lines: [
          `数据库：${db || rawDb}`,
          `密钥来源：${source}`,
          "REST 接口鉴权通过：R2 对象列举与清理权限正常",
          source === "自动捕获" ? "当前正在使用建库时自动保存的密钥，建议在设置页显式填写一份备用" : "密钥已通过远端验证，与当前数据库完全匹配",
        ],
      };
    }

    // 远端返回错误：细分原因（区分「密钥无效」与「NCB 远端连 R2 发生异常」与「网关宕机 502/503/504」）
    let errorDetail = "";
    try {
      const body = await res.json();
      if (body && (body.error || body.message)) {
        errorDetail = body.error || body.message;
      }
    } catch (_) {
      errorDetail = res.statusText || ("HTTP " + res.status);
    }
    if (!errorDetail) {
      errorDetail = res.statusText || ("HTTP " + res.status);
    }

    // 远端网关异常（502 Bad Gateway / 503 Service Unavailable / 504 Gateway Timeout / 520-526）
    // 此时请求未被 NCB 鉴权核心处理，必须判为 ok: false，绝不误判为密钥有效
    const isGatewayError = res.status === 502 || res.status === 503 || res.status === 504 || (res.status >= 520 && res.status <= 526);
    if (isGatewayError) {
      return {
        ok: false,
        verdict: "GATEWAY_ERROR",
        source,
        database: db || rawDb,
        title: `NoCodeBackend 远端网关异常（HTTP ${res.status}）`,
        lines: [
          `目标数据库：${db || rawDb}（来源：${source}）`,
          `远端接口返回：${errorDetail}（HTTP ${res.status}）`,
          "远端反向代理或服务器暂时不可用（Bad Gateway / Gateway Timeout），请求未能到达 NoCodeBackend 鉴权服务。",
          "处理建议：请检查 NoCodeBackend 服务是否正常运行，或稍后重试。",
        ],
      };
    }

    const errStr = String(errorDetail || "");
    const isTlsHandshake = /handshake failure|SSL alert number 40|EPROTO|sslv3/i.test(errStr);
    const isInvalidBucket = /bucket name is not valid|InvalidBucketName/i.test(errStr);

    if (res.status === 500 && isTlsHandshake) {
      return {
        ok: true,
        verdict: "R2_TLS_ERROR",
        source,
        database: db || rawDb,
        title: "Secret Key 有效（已通过鉴权），但远端连 Cloudflare R2 发生 TLS 握手失败",
        lines: [
          `目标数据库：${db || rawDb}（来源：${source}）`,
          `远端接口返回：${errorDetail}（HTTP ${res.status}）`,
          "【排查关键】密钥本身有效（鉴权已通过）。并非密钥无效。这个报错来自 NoCodeBackend 侧访问该库的 R2 存储通道失败，与你的密钥无关。若要让 R2 相关功能可用，请先挂载 R2 存储。",
          "根本原因：此报错来自 NoCodeBackend 远端对 R2 存储通道的连带校验（与你的密钥无关）。NoCodeBackend 拿它保存的 Cloudflare 凭据去连 R2 时，被 Cloudflare 拒绝了 TLS 握手（SSL alert 40）。",
          "常见原因与指引：① 若尚未挂载 R2，请先前往 R2 卡片点击『挂载 R2 存储』；② 若已挂载，请检查 Cloudflare 侧 R2 API Token 权限（须选【Admin Read & Write】）或在 NCB 控制台更新 R2 连接（注意：此握手发生在远端与 Cloudflare 之间，与本地 Docker / 容器 TLS 环境无关，切勿在容器内安装 openssl）。",
        ],
      };
    }

    if (res.status === 500 && isInvalidBucket) {
      return {
        ok: true,
        verdict: "R2_BUCKET_INVALID",
        source,
        database: db || rawDb,
        title: "Secret Key 有效（已通过鉴权），但关联的 R2 存储桶名非法",
        lines: [
          `目标数据库：${db || rawDb}（来源：${source}）`,
          `远端接口返回：${errorDetail}（HTTP ${res.status}）`,
          "【排查关键】密钥本身有效（鉴权已通过）。并非密钥无效。这个报错来自 NoCodeBackend 侧访问该库的 R2 存储通道失败，与你的密钥无关。若要让 R2 相关功能可用，请先挂载 R2 存储。",
          "根本原因：当前关联的 Cloudflare R2 存储桶名不符合 S3/R2 命名规范（例如包含了下划线 _）。",
          "处理步骤：请点本插件的「挂载 R2 存储」，插件会自动将下划线转为连字符重新挂载合法桶名（如 41694-agent-memory）。",
        ],
      };
    }

    if (res.status === 500) {
      const retObj = {
        ok: true,
        verdict: "UPSTREAM_ERROR",
        source,
        database: db || rawDb,
        title: "Secret Key 有效（已通过鉴权），但远端存储通道异常",
        lines: [
          `目标数据库：${db || rawDb}（来源：${source}）`,
          `远端接口返回：${errorDetail}（HTTP ${res.status}）`,
          "【排查关键】密钥本身有效（鉴权已通过）。并非密钥无效。这个报错来自 NoCodeBackend 侧访问该库的 R2 存储通道失败，与你的密钥无关。若要让 R2 相关功能可用，请先挂载 R2 存储。",
          "处理步骤：NoCodeBackend 鉴权已通过；若需使用对象存储功能，请先在 R2 卡片完成挂载或在控制台检查配置。",
        ],
      };
      try {
        const aiDiag = await explainUnknownErrorWithModel({
          error: errorDetail,
          component: "secret_check",
          database: db || rawDb,
          options: cfg,
        });
        if (aiDiag) attachAiDiagnosis(retObj, aiDiag);
      } catch (_) {}
      return retObj;
    }

    if (res.status > 500) {
      return {
        ok: false,
        verdict: "GATEWAY_ERROR",
        source,
        database: db || rawDb,
        title: `NoCodeBackend 远端服务器异常（HTTP ${res.status}）`,
        lines: [
          `目标数据库：${db || rawDb}（来源：${source}）`,
          `远端接口返回：${errorDetail}（HTTP ${res.status}）`,
          "远端服务器返回非预期的 5xx 状态码，请求未能被正常鉴权处理。",
        ],
      };
    }

    // 分支 3：真实密钥被拒绝（401/403 或显式 Invalid secret_key）
    // 关键修复：清除本地失效的缓存密钥，避免后续操作持续拿旧密钥撞 403
    forgetSecret(db || rawDb);
    const failedSource = source === "自动捕获" ? "自动捕获（已失效，已自动清除）" : (source === "手动填写" ? "手动填写（已失效）" : source);
    return {
      ok: false,
      verdict: "INVALID",
      source: failedSource,
      database: db || rawDb,
      title: "密钥被 NoCodeBackend 拒绝（鉴权失败）",
      lines: [
        `目标数据库：${db || rawDb}（来源：${failedSource}）`,
        `远端接口返回：${errorDetail}（HTTP ${res.status}）`,
        "【已自动处理】已自动清除本地缓存的失效密钥，避免持续死循环撞 403。",
        "两个最常见原因：",
        "① 误把 MCP Key 当成 Secret Key（MCP Key 无法访问 REST 接口）",
        "② 数据库删除重建后 NCB 换了新密钥，当前手里保存的是旧密钥",
        "自救指引：请到 NoCodeBackend 控制台复制当前 Secret Key 手动填入设置页；若无法找回，可点击「一键创建数据库」重新建库以自动捕获新密钥。",
      ],
    };
  } catch (err) {
    if (timer) clearTimeout(timer); if (externalSignal && typeof abortListener === "function") externalSignal.removeEventListener("abort", abortListener);
    const errMsg = String((err && err.message) || err);
    const retObj = {
      ok: false,
      verdict: "ERROR",
      source,
      database: db || rawDb,
      title: "检测 Secret Key 失败（连接异常）",
      lines: [
        `目标数据库：${db || rawDb}`,
        `连接失败：${errMsg.slice(0, 150)}`,
        "无法连接到 api.nocodebackend.com，请检查网络连接后重试",
      ],
    };
    try {
      const aiDiag = await explainUnknownErrorWithModel({
        error: errMsg,
        component: "secret_check",
        database: db || rawDb,
        options: cfg,
      });
      if (aiDiag) attachAiDiagnosis(retObj, aiDiag);
    } catch (_) {}
    return retObj;
  }
}

