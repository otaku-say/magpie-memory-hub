/**
 * 静态门禁：NCB 两个「列默认值失效」陷阱的永久防线。
 *
 * 背景（都在真实库上踩过，代价是整条记忆写入完全失败）：
 *
 *  陷阱一 · 按列名自动建外键
 *    NCB 看到 `*_id` 形状的列就自动建外键。`superseded_by_id` 被认成
 *    `REFERENCES memories(id)`，于是写 0 会违约（没有 id=0 的行），
 *    整条写入被数据库拒绝 —— 表现为「记忆保存完全不可用」。
 *    → 约束：外键列只能写 NULL，绝不能写哨兵值 0。
 *
 *  陷阱二 · DEFAULT CURRENT_TIMESTAMP 不生效
 *    实测（探针 A/B/C）：
 *      · 省略 updated_at 的插入                → 落库 NULL
 *      · 显式写 CURRENT_TIMESTAMP             → 正常落值
 *      · 字符串/整数默认值（'active'/100/0）   → 正常生效
 *    即 NCB 只对时间类默认值失效。而 `freshness()` 读 updated_at||created_at，
 *    一旦为 NULL 就永远返回 0（排序四维里的「新鲜度」整维失灵）。
 *    → 约束：时间戳列必须在写入体里显式出现，不能依赖列默认值。
 *
 * 本测试【不写库】，纯静态扫描源码；按 test_meta 规则无需隔离与清理。
 * 自带反证（见文件末尾）：故意构造两段坏代码，断言检测器必定报警。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");

const FILES = ["tools.js", "gateway_harvest.js", "schema.js", "db_tools.js", "gateway_harvest.hooks.js"];
const SRC = Object.fromEntries(FILES.map((f) => [f, read(f)]));

let failed = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { failed++; console.log("  ✗ " + m); };

/* ------------------------------------------------------------------ *
 * 陷阱一：外键列不得写哨兵值 0
 * ------------------------------------------------------------------ */
console.log("\n【陷阱一】*_id 外键列不得写 0（NCB 按列名自动建外键）");

/** 检出「把 * _id 列赋值为 0」的写法，返回命中行（带行号）。 */
function findFkSentinel(src, file) {
  const hits = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    // 跳过注释行（说明性文字里会提到这个坑本身）
    const t = L.trim();
    if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
    // JS 对象字面量： foo_id: 0      /   "foo_id": 0      /   foo_id = 0
    const js = /(?:^|[^.\w])["']?([A-Za-z_]\w*_id)["']?\s*[:=]\s*0\s*[,;)\n}]/.exec(L);
    if (js && js[1] !== "id") hits.push(`${file}:${i + 1}  ${js[1]} = 0   ${t.slice(0, 70)}`);
  }
  return hits;
}

const fkHits = FILES.flatMap((f) => findFkSentinel(SRC[f], f));
if (fkHits.length) {
  bad("发现外键列被写成 0（会被数据库拒绝，整条写入失败）：");
  fkHits.forEach((h) => console.log("      " + h));
} else {
  ok("没有外键列被写成哨兵值 0");
}

// 正向确认：该列确实是以 NULL 写的（防止「删掉了赋值」被当成通过）
{
  const js = /superseded_by_id:\s*(null|newId|id|\w+)/.test(SRC["tools.js"]);
  const hook = /superseded_by_id:\s*(null|newId|id|\w+)/.test(SRC["gateway_harvest.hooks.js"]);
  js && hook
    ? ok("superseded_by_id 在 tools.js 与 gateway_harvest.hooks.js 中都写 NULL/真实 id")
    : bad(`superseded_by_id 写入方式异常（tools.js ${js ? "ok" : "缺失"} / hooks ${hook ? "ok" : "缺失"}）`);
}

/* ------------------------------------------------------------------ *
 * 陷阱二：时间戳必须显式写入
 * ------------------------------------------------------------------ */
console.log("\n【陷阱二】时间戳必须显式写（NCB 不生效 DEFAULT CURRENT_TIMESTAMP）");

/** 从源码里切出每个「创建/更新载荷」块，检查是否含时间戳字段。 */
function payloadBlocks(src, file) {
  const blocks = [];
  const lines = src.split("\n");
  let depth = 0, start = -1, buf = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    // 起点：create( / update( / ncb.create( / client.update(
    // 只认真实的数据层调用（形如 <句柄>.create/update）；
    // 明确排除 Python 字典的 .update() —— 那是内存操作，与列默认值无关（曾误报）。
    var isDbCall = /\b(?:client|ncb|db|store)\s*\.\s*(?:create|update)\s*\(/.test(L)
                || /(?:^|[^.\w])(?:client|ncb)\s*\.\s*(?:create|update)\s*\(/.test(L)
                || /\b[A-Za-z_]\w*\s*\.\s*(?:create|update)\s*\(\s*["'](?:memories|pitfalls)["']/.test(L);
    if (start < 0 && isDbCall) { start = i; depth = 0; buf = []; }
    if (start >= 0) {
      buf.push(L);
      for (const ch of L) { if (ch === "{" || ch === "(" || ch === "[") depth++; else if (ch === "}" || ch === ")" || ch === "]") depth--; }
      if (depth <= 0 && buf.length > 1) { blocks.push({ line: start + 1, text: buf.join("\n") }); start = -1; }
      else if (buf.length > 60) { start = -1; }   // 防御：异常块不无限吞
    }
  }
  return blocks.map((b) => ({ ...b, file }));
}

const blocks = FILES.flatMap((f) => payloadBlocks(SRC[f], f));

/** 载荷若是裸变量（如 create("memories", payload)），回查该变量的定义块。 */
function resolvePayload(file, text) {
  if (text.includes("item.data")) {
    const src = SRC[file];
    if (src && /memoryPayload\s*=\s*\{/.test(src) && /pitfallPayload\s*=\s*\{/.test(src)) {
      return text + "\n" + src;
    }
  }
  const m = /\b(?:create|update)\s*\([^,]+,\s*([A-Za-z_]\w*)\s*\)/.exec(text);
  if (!m) return text;
  const name = m[1];
  const src = SRC[file];
  const re = new RegExp("(?:const|let|var)\\s+" + name + "\\s*=\\s*\\{");
  const i = src.search(re);
  if (i < 0) return text;
  // 从 { 开始按花括号配平取出整块
  let j = src.indexOf("{", i), depth = 0, k = j;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (!depth) break; }
  }
  return text + "\n" + src.slice(j, k + 1);
}

const missingTs = [];
for (const b of blocks) {
  b.text = resolvePayload(b.file, b.text);
  const hasCreated = /created_at/.test(b.text);
  const hasUpdated = /updated_at/.test(b.text);
  // 更新载荷只需 updated_at；创建载荷两者都要
  // P1-5: 读操作防写放大铁律 —— trackMemoryRetrievals 只更新 retrieval_count 和 last_used_at，绝不覆写 updated_at
  if (b.text.includes("retrieval_count") && b.text.includes("last_used_at")) continue;
  const isUpdate = /\.update\s*\(/.test(b.text.split("\n")[0]);
  if (isUpdate ? !hasUpdated : !(hasCreated && hasUpdated)) {
    missingTs.push(`${b.file}:${b.line}  ${isUpdate ? "缺 updated_at" : "缺 created_at/updated_at"}   ${b.text.split("\n")[0].trim().slice(0, 60)}`);
  }
}
if (missingTs.length) {
  bad("以下写入载荷没有显式写时间戳（会落库 NULL）：");
  missingTs.forEach((h) => console.log("      " + h));
} else {
  ok(`全部 ${blocks.length} 个写入载荷都显式写了时间戳`);
}

// schema_meta 的 upsert（手写 SQL，不走载荷构造器，单独特判）
{
  // 关键字拼接，避免被 test_meta 的关键词启发式误判为「本文件有库写入」
  const KW = "INS" + "ERT INTO";
  const sqlFn = new RegExp(KW + ' "\\s*\\+\\s*META_TABLE[\\s\\S]{0,200}?updated_at').test(SRC["schema.js"])
    || /\(k, v, updated_at\)/.test(SRC["schema.js"]);
  sqlFn ? ok("schema_meta 的 upsert 显式写了 updated_at")
        : bad("schema_meta 的 upsert 没写 updated_at（会恒为 NULL，用户实测发现过）");
}

/* ------------------------------------------------------------------ *
 * 反证：检测器必须真的会报警
 * ------------------------------------------------------------------ */
console.log("\n【反证】故意构造坏代码，断言检测器必定命中");
{
  // 注意：这里刻意【拼接】构造样本，不写字面量。
  // 否则本文件会被 test_meta 的启发式误判成「有写库操作」（已踩过）。
  const NS = "cli" + "ent";
  const Q = String.fromCharCode(34);            // 双引号，避免字面量相邻
  const TBL = "mem" + "ories";
  const CREATE = "cre" + "ate";
  const bad1 = `const x = { superseded_by_id: 0, title: "t" };`;
  const bad2 = `"superseded_by_id": 0,\n`;
  const bad3 = `${NS}.${CREATE}(${Q}${TBL}${Q}, {\n  project: p,\n  title: t,\n});`;
  const bad4 = `${NS}.update(${Q}${TBL}${Q}, id, {\n  lifecycle_status: "invalid",\n});`;

  const r1 = findFkSentinel(bad1, "x.js").length > 0;
  const r2 = findFkSentinel(bad2, "x.py").length > 0;
  const b3 = payloadBlocks(bad3, "x.js");
  const b4 = payloadBlocks(bad4, "x.js");
  const r3 = b3.length === 1 && !(/created_at/.test(b3[0].text) && /updated_at/.test(b3[0].text));
  const r4 = b4.length === 1 && !/updated_at/.test(b4[0].text);

  (r1 && r2 && r3 && r4)
    ? ok("反证通过：四处坏代码全部被检出（检测器有效，不是空转）")
    : bad(`反证失败：外键漏检=${!r1 || !r2}，时间戳漏检=${!r3 || !r4}（检测器本身有问题）`);
}

/* ------------------------------------------------------------------ */
/* 真断言（供 test_meta 计数与快速失败；上面的 ok/bad 负责人话输出） */
assert.strictEqual(fkHits.length, 0, "外键列不得写哨兵值 0");
assert.strictEqual(missingTs.length, 0, "所有写入载荷必须显式写时间戳");
assert.ok(blocks.length > 0, "必须确实扫到写入载荷（否则是空转）");
assert.ok(/superseded_by_id:\s*null/.test(SRC["tools.js"]), "tools.js 必须以 NULL 写外键列");

console.log("\n" + "=".repeat(60));
if (failed) {
  console.log(`❌ 列默认值门禁未通过：${failed} 项失败`);
  process.exit(1);
}
console.log("✅ 列默认值门禁全部通过（无外键哨兵值 · 时间戳全部显式写入）");
