/**
 * 交叉校验：tools.js 真正写入 memories / pitfalls 的每个字段，
 * 必须在 schema.js 的声明里存在。
 *
 * 为什么需要它：曾经 schema.js 漏声明 scope，照声明初始化出的库在
 * memory_save 时报 "Unknown column 'scope' in 'field list'" —— 一个只在
 * 新库上才会暴露的致命缺陷。这个脚本把「声明漏列」变成一次可自动发现的失败。
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { TABLES } from "../schema.js";

const TOOLS_SRC = readFileSync(new URL("../tools.js", import.meta.url), "utf8");
const HOOKS_SRC = readFileSync(new URL("../gateway_harvest.hooks.js", import.meta.url), "utf8");

/** 从 src 的 pos 处（指向 `{`）解析出对象字面量的顶层键 */
function keysOfLiteral(text) {
  const keys = new Set();
  let depth = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // 深度 1 的每一行可能含【多个】键（如 `project, component, symptom, root_cause: x, solution,`）
    if (depth === 1) {
      // 按顶层逗号切分，逐段取行首标识符
      for (const part of splitTopLevel(trimmed)) {
        // 顶层片段以标识符开头即为一个键：
        //   `project`                    → 简写键
        //   `root_cause: rootCause`      → 键: 值
        const m = part.match(/^\s*([a-z_][a-z0-9_]*)\s*(?::|$)/);
        if (m) keys.add(m[1]);
      }
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth <= 0) break;
  }
  return keys;
}

/** 按顶层（不在括号内）的逗号切分 */
function splitTopLevel(line) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of line) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 取出 src 里 client.create("<table>", X) 里 X 指向的对象字面量文本（支持多处写入点与变量追溯） */
function createdKeysInSrc(src, table) {
  const call = `client.create("${table}",`;
  const allKeys = new Set();
  let pos = 0;
  while (true) {
    const i = src.indexOf(call, pos);
    if (i < 0) break;
    pos = i + call.length;
    let j = pos;
    while (src[j] === " ") j++;
    if (src[j] === "{") {
      for (const k of keysOfLiteral(src.slice(j))) allKeys.add(k);
      continue;
    }
    // 是变量名 → 回溯它的定义
    const name = src.slice(j, src.indexOf(")", j)).trim();
    if (name.includes("drain") || name.includes("Payload")) {
      const targetPayload = table === "memories" ? "memoryPayload" : "pitfallPayload";
      const pdef = src.lastIndexOf(`const ${targetPayload} = {`);
      if (pdef >= 0) {
        for (const k of keysOfLiteral(src.slice(src.indexOf("{", pdef)))) allKeys.add(k);
      }
    }
    const def = src.lastIndexOf(`const ${name} = {`);
    if (def >= 0) {
      for (const k of keysOfLiteral(src.slice(src.indexOf("{", def)))) allKeys.add(k);
    }
  }
  return allKeys;
}

function createdKeys(table) {
  const k1 = createdKeysInSrc(TOOLS_SRC, table);
  const k2 = createdKeysInSrc(HOOKS_SRC, table);
  return new Set([...k1, ...k2]);
}

const DB_MANAGED = new Set(["id", "created_at", "updated_at"]);
let fail = 0;

for (const table of ["memories", "pitfalls"]) {
  const wrote = createdKeys(table);
  const declared = new Set(TABLES[table].columns.map((c) => c.name));
  const missing = [...wrote].filter((k) => !declared.has(k));
  console.log(`\n【${table}】代码写入 ${wrote.size} 字段 / schema 声明 ${declared.size} 列`);
  console.log(`  写入: ${[...wrote].sort().join(", ")}`);
  if (missing.length) {
    fail++;
    console.log(`  ✗ schema 缺少代码要写的列: ${missing.join(", ")}`);
  } else {
    console.log(`  ✓ 全部已声明`);
  }
  assert.strictEqual(missing.length, 0, `${table} 表代码写入的列必须在 schema.js 中全部声明`);
  const extra = [...declared].filter((k) => !wrote.has(k) && !DB_MANAGED.has(k));
  if (extra.length) console.log(`  ℹ 声明但代码不直接写（由数据库维护，或仅在特定通道写入）: ${extra.join(", ")}`);
  const need = [...wrote].filter((k) => !DB_MANAGED.has(k));
  console.log(`  迁移断言：新库建表后这 ${need.length} 列必须存在（否则写入会 400）`);
}

/* ------------------------------------------------------------------ *
 * 旧列名残留校验（查询侧）
 *
 * 上面那些检查只比对「写入侧」字段 —— 曾因此漏过一个大 bug：
 * memory_context 的查询过滤写成 { status: "active" }，而列早已改名
 * lifecycle_status，NCB 直接报「未知列名 status」，整个工具不可用。
 * 同时读取侧 r.status 恒为 undefined，superseded 过滤静默失效。
 * 教训：改名只查写入侧是不够的，查询侧（WHERE / 读取字段）同样会残留。
 * ------------------------------------------------------------------ */
/* 旧名 → 新名。
 * 现已彻底删除所有针对数据库列改名的兼容代码，因此在数据库语境中一律不允许出现旧列名。 */
const RENAMED_AWAY = {
  status: "lifecycle_status",
  version: "revision",
  access_count: "retrieval_count",
  hits: "retrieval_count",
  fingerprint: "content_fingerprint",
  related: "related_entities",
  entities: "related_entities",
  full_content: "full_text",
  superseded_by: "superseded_by_id",
  last_accessed_at: "last_used_at",
  scope: "scope_level",
};
/* 合法的同名用法（与数据库列无关），逐条给出理由，不做宽泛豁免 */
const LEGIT_CTX = [
  /res\.status|response\.status|\bstatusText\b|statusCode|\bstatus\s*:\s*\d{3}\b/,   // HTTP 状态
  /out\.get\("status"\)|\.get\("status"\)\s*==\s*"failed"/,    // 子进程结果字典
  /git status|status\s*[:=]\s*["'](?:ok|failed)["']/,          // 非 DB 的普通状态字段
  /\bversion\s*[:=]\s*(?:["']|SCHEMA_|String\()/,              // 版本号常量
];
const CODE_FILES = ["tools.js", "db_tools.js", "gateway_harvest.js", "gateway_harvest.hooks.js", "page_actions.js",
                    "memory.middleware.js", "schema.js"];
/* 反证：确认「豁免机制」不会把真 bug 一起放行（见文件末尾断言） */
console.log("\n【旧列名残留校验（查询侧）】");
let staleHits = [];
for (const f of CODE_FILES) {
  let src = "";
  try { src = readFileSync(new URL("../" + f, import.meta.url), "utf8"); } catch { continue; }
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const t = L.trim();
    if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (LEGIT_CTX.some((re) => re.test(L))) continue;
    /* 行内豁免：源码里写 `db-col-ok: <理由>` 即可放行。
     * 理由必须写在那一行旁边，评审时一眼能看到为什么它是安全的。 */
    if (/db-col-ok\s*:/.test(L)) continue;
    for (const [col, fresh] of Object.entries(RENAMED_AWAY)) {
      // 作为对象键（JS 字面量 / Python 字典）、字典读取、SQL WHERE 或行对象属性读取
      const asKey = new RegExp(`(?:^|[^\\w.])["']?${col}["']?\\s*:`);
      const asGet = new RegExp(`\\.get\\(\\s*["']${col}["']\\s*\\)`);
      const inSql = new RegExp(`\\b${col}\\b\\s*(?:=|!=|<>|IS)\\s`, "i");
      const asProp = new RegExp(`\\b(?:r|row|m|hit|item|dup|cq)\\b\\.${col}\\b`);
      if (asKey.test(L) || asGet.test(L) || (/SELECT|WHERE|UPDATE|INSERT/i.test(L) && inSql.test(L)) || asProp.test(L)) {
        staleHits.push(`${f}:${i + 1}  「${col}」（应改用 ${fresh}）→ ${t.slice(0, 58)}`);
      }
    }
  }
}
if (staleHits.length) {
  fail++;
  console.log(`  ✗ 发现 ${staleHits.length} 处可能仍在用【改名前的旧列名】：`);
  staleHits.slice(0, 12).forEach((h) => console.log("      " + h));
  if (staleHits.length > 12) console.log(`      …另有 ${staleHits.length - 12} 处`);
} else {
  console.log("  ✓ 查询侧没有旧列名残留");
}
assert.strictEqual(staleHits.length, 0, "查询侧不得存在任何改名前旧列名残留");

/* ------------------------------------------------------------------ *
 * 版本号同步校验：package.json version vs settings.html
 * ------------------------------------------------------------------ */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const html = readFileSync(new URL("../settings.html", import.meta.url), "utf8");
const matchVer = html.match(/class="version-tag">v([^<]+)<\/span>/);
console.log(`\n【版本号同步校验】package.json: ${pkg.version} vs settings.html: ${matchVer ? matchVer[1] : "未找到"}`);
if (!matchVer || matchVer[1] !== pkg.version) {
  fail++;
  console.log(`  ✗ settings.html 中的版本号 (v${matchVer ? matchVer[1] : "null"}) 与 package.json (${pkg.version}) 不一致！`);
} else {
  console.log(`  ✓ 版本号完全对齐 (v${pkg.version})`);
}

/* 反证：未标记的旧列名必被抓到，标记过的必被放行 —— 否则门禁是空转 */
{
  const probeBad = `const f = { status: "active" };`;
  const probeOk  = `const f = { status: "active" };  // db-col-ok: UI 状态字段`;
  const hit = (line) => !/db-col-ok\s*:/.test(line) && /(?:^|[^\w.])["']?status["']?\s*:/.test(line);
  const c1 = hit(probeBad), c2 = hit(probeOk);
  console.log("\n【反证】旧列名检测器的有效性");
  if (c1 && !c2) console.log("  ✓ 反证通过：未标记的坏行被检出，标记过的被放行");
  else { fail++; console.log(`  ✗ 反证失败：坏行检出=${c1}（应 true），豁免行放行=${!c2}（应 true）`); }
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ schema 声明与代码写入完全对齐，版本号严格同步");
process.exit(fail ? 1 : 0);
