/**
 * 交叉校验：tools.js 真正写入 memories / pitfalls 的每个字段，
 * 必须在 schema.js 的声明里存在。
 *
 * 为什么需要它：曾经 schema.js 漏声明 scope，照声明初始化出的库在
 * memory_save 时报 "Unknown column 'scope' in 'field list'" —— 一个只在
 * 新库上才会暴露的致命缺陷。这个脚本把「声明漏列」变成一次可自动发现的失败。
 */
import { readFileSync } from "node:fs";
import { TABLES } from "../schema.js";

const SRC = readFileSync(new URL("../tools.js", import.meta.url), "utf8");

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

/** 取出 client.create("<table>", X) 里 X 指向的对象字面量文本 */
function createdKeys(table) {
  const call = `client.create("${table}",`;
  const i = SRC.indexOf(call);
  if (i < 0) throw new Error(`找不到 client.create("${table}")`);
  let j = i + call.length;
  while (SRC[j] === " ") j++;
  if (SRC[j] === "{") {
    return keysOfLiteral(SRC.slice(j));
  }
  // 是变量名 → 回溯它的定义
  const name = SRC.slice(j, SRC.indexOf(")", j)).trim();
  const def = SRC.lastIndexOf(`const ${name} = {`);
  if (def < 0) throw new Error(`找不到 ${name} 的定义`);
  return keysOfLiteral(SRC.slice(SRC.indexOf("{", def)));
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
  const extra = [...declared].filter((k) => !wrote.has(k) && !DB_MANAGED.has(k));
  if (extra.length) console.log(`  ℹ 声明但代码不直接写（DB 维护或兼容旧库）: ${extra.join(", ")}`);
  const need = [...wrote].filter((k) => !DB_MANAGED.has(k));
  console.log(`  迁移断言：新库建表后这 ${need.length} 列必须存在（否则写入会 400）`);
}

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

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ schema 声明与代码写入完全对齐，版本号严格同步");
process.exit(fail ? 1 : 0);
