import {
  TABLES, META_TABLE, SCHEMA_VERSION, VERSION_KEY,
  detectDrift, buildStatements, normalizeSchema, createTableSQL,
  buildDropStatements, isDestructive, describePlan, versionUpsertSQL,
} from "../schema.js";

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b)) ? ok(m) : no(`${m}（得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`);

/** 构造一个"已完全初始化"的当前结构（形态 A：tables 数组） */
function fullSchema() {
  return {
    tables: Object.keys(TABLES).map((t) => ({
      name: t,
      columns: TABLES[t].columns.map((c) => ({ name: c.name, type: c.type })),
      indexes: TABLES[t].indexes.map((i) => ({ name: i.name })),
    })),
  };
}

console.log("=== 1. 读不到结构时必须中止（不许盲目建表）===");
{
  const d1 = detectDrift(null);
  eq(d1.ok, false, "null 输入 → ok=false");
  eq(buildStatements(d1).length, 0, "中止时产出 0 条语句");
  const d2 = detectDrift({});
  eq(d2.ok, false, "空对象 → ok=false");
  const d3 = detectDrift({ error: "unauthorized" });
  eq(d3.ok, false, "报错响应 → ok=false");
  ok(`中止原因: ${d1.reason.slice(0, 24)}…`);
}

console.log("\n=== 2. 幂等：已初始化 → 零语句 ===");
{
  const d = detectDrift(fullSchema());
  eq(d.ok, true, "ok=true");
  eq(d.missingTables, [], "无缺表");
  eq(d.missingColumns, [], "无缺列");
  eq(d.missingIndexes, [], "无缺索引");
  eq(buildStatements(d).length, 0, "重复点击 → 0 条语句（幂等）");
}

console.log("\n=== 3. 全新库 → 建齐三表 + 七索引 ===");
{
  // 模拟"库存在但没有任何插件表"：给一张无关表，保证 normalize 非空
  const cur = { tables: [{ name: "some_other_table", columns: [{ name: "id" }] }] };
  const d = detectDrift(cur);
  eq(d.ok, true, "ok=true");
  eq(d.missingTables.sort(), [META_TABLE, "memories", "pitfalls"].sort(), "三张表全缺");
  const s = buildStatements(d);
  const kinds = s.map((x) => x.kind);
  eq(kinds.filter((k) => k === "create_table").length, 3, "3 条建表");
  eq(kinds.filter((k) => k === "create_index").length, 7, "7 条建索引");
  eq(kinds.filter((k) => k === "add_column").length, 0, "无加列（建表语句已含列）");
  eq(kinds.indexOf("create_table") < kinds.indexOf("create_index"), true, "顺序：先建表后建索引");
  ok(`语句数 ${s.length}`);
}

console.log("\n=== 4. 缺列 → 加成可空（否则有数据的库会加列失败）===");
{
  const cur = fullSchema();
  // 删掉 memories.invalid_at 模拟旧版本
  cur.tables.find((t) => t.name === "memories").columns =
    cur.tables.find((t) => t.name === "memories").columns.filter((c) => c.name !== "invalid_at");
  const d = detectDrift(cur);
  eq(d.missingColumns.length, 1, "检出 1 个缺列");
  const s = buildStatements(d);
  const alter = s.find((x) => x.kind === "add_column");
  eq(/ADD COLUMN invalid_at/.test(alter.sql), true, "生成 ADD COLUMN");
  eq(/NOT NULL/.test(alter.sql), false, "新增列不含 NOT NULL");
  ok(`SQL: ${alter.sql}`);
}

console.log("\n=== 5. 缺索引 → 补建（含唯一索引）===");
{
  const cur = fullSchema();
  cur.tables.forEach((t) => { t.indexes = []; });
  const d = detectDrift(cur);
  eq(d.missingIndexes.length, 7, "检出 7 个缺索引");
  const s = buildStatements(d);
  const uniq = s.filter((x) => x.unique);
  eq(uniq.length, 3, "其中 3 个是唯一索引（含去重的最终保证）");
  eq(s.filter((x) => x.kind === "create_table").length, 0, "不缺表 → 不建表");
}

console.log("\n=== 6. 库里的无关表：只报告，绝不触碰 ===");
{
  const cur = fullSchema();
  cur.tables.push({ name: "user_orders", columns: [{ name: "id" }, { name: "amount" }] });
  cur.tables.push({ name: "user_profiles", columns: [{ name: "id" }] });
  const d = detectDrift(cur);
  eq(d.unknownTables.length, 2, "报告 2 张无关表");
  eq(d.unknownTables.some((x) => x.table === "user_orders" && x.columns === 2), true, "含列数信息");
  const s = buildStatements(d);
  eq(s.some((x) => JSON.stringify(x).includes("user_orders")), false, "计划里绝不出现无关表");
  eq(s.some((x) => JSON.stringify(x).includes("user_profiles")), false, "计划里绝不出现无关表");
}

console.log("\n=== 7. 初始化路径绝不产生破坏性语句 ===");
{
  const cur = { tables: [{ name: "legacy_table", columns: [{ name: "id" }, { name: "old_col" }] }] };
  const s = buildStatements(detectDrift(cur));
  const bad = s.filter((x) => isDestructive(x.sql));
  eq(bad.length, 0, "0 条破坏性语句");
  eq(/DROP|TRUNCATE|DELETE|MODIFY|CHANGE/i.test(s.map((x) => x.sql).join(";")), false, "全文无 DROP/TRUNCATE/DELETE/MODIFY");
}

console.log("\n=== 8. 清库路径：只删插件自己的表，且顺序安全 ===");
{
  const s = buildDropStatements();
  eq(s.length, 3, "3 条 DROP");
  eq(s.map((x) => x.table), [META_TABLE, "pitfalls", "memories"], "顺序：元数据 → pitfalls → memories");
  eq(s.every((x) => isDestructive(x.sql)), true, "全部是破坏性语句（必须二次确认）");
  eq(/user_orders|some_other/.test(s.map((x) => x.sql).join(";")), false, "绝不涉及无关表");
}

console.log("\n=== 9. 输入形态容错 ===");
{
  const b1 = normalizeSchema({ memories: { columns: [{ name: "id" }, "title"], indexes: ["idx_a"] } });
  eq(Object.keys(b1), ["memories"], "形态 B（顶层即表名）可解析");
  eq(Object.keys(b1.memories.columns).sort(), ["id", "title"], "字符串列名与对象列名都支持");
  eq(Object.keys(b1.memories.indexes), ["idx_a"], "字符串索引名支持");
  const b2 = normalizeSchema(fullSchema());
  eq(Object.keys(b2).length, 3, "形态 A（tables 数组）可解析");
  const b3 = normalizeSchema({ tables: [{ name: "t", fields: [{ column_name: "c1" }, { Field: "c2" }] }] });
  eq(Object.keys(b3.t.columns).sort(), ["c1", "c2"], "兼容 column_name / Field 别名");
}

console.log("\n=== 10. DDL 具备 IF NOT EXISTS 幂等保护 ===");
{
  for (const t of Object.keys(TABLES)) {
    const sql = createTableSQL(t);
    eq(/CREATE TABLE IF NOT EXISTS/.test(sql), true, `${t} 使用 IF NOT EXISTS`);
  }
  eq(/ON DUPLICATE KEY UPDATE/.test(versionUpsertSQL(1)), true, "版本记录用 upsert（重复写不报错）");
  ok(`版本号=${SCHEMA_VERSION}，键名=${VERSION_KEY}`);
  eq(typeof TABLES.memories.columns.find((c) => c.name === "content_fingerprint").notNull, "boolean", "content_fingerprint 非空");
}

console.log("\n=== 11. 计划摘要（给二次确认弹窗用）===");
{
  const cur = { tables: [{ name: "x", columns: [{ name: "id" }] }] };
  const desc = describePlan(buildStatements(detectDrift(cur)));
  eq(desc.total > 0, true, "total > 0");
  eq(desc.create_table.length, 3, "列出 3 张新建表");
  eq(desc.drop_table.length, 0, "初始化不含删表");
  ok(`摘要: ${JSON.stringify(desc).slice(0, 120)}…`);
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ schema.js 幂等与安全验收全部通过");
process.exit(fail ? 1 : 0);
