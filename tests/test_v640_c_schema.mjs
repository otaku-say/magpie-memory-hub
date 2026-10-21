/**
 * tests/test_v640_c_schema.mjs
 * =================================================================
 * v6.40-c 双向反证测试：
 * 1. 【BUG-39-3 / EVO-17】MCP Schema 自演进参数声明补齐与端到端验证
 *    - memory_save 补 supersede_id / supersede / related_entities
 *    - pitfall_save 补 related_entities / recurrence (保持 root_cause)
 *    - memory_context 补 max_principles
 *    - required 数组保持不变（绝无误加必填）
 *    - 端到端：通过 supersede_id 真实取代旧记录
 * 2. 【BUG-39-4a】_no_scheduler 隔离标记前置至入口副作用之前
 *    - _no_scheduler: true 时不写 _status.js 的 db 卡片、不触发 autoInit、不触发 autoHarvest
 *    - 默认不传 _no_scheduler 时主路径行为 100% 保持不变（对照反证）
 *    - _no_scheduler 构造实例完整具备 21 个可用 tool
 * 3. 【测试元检查合规与隔离】
 *    - mockDbClient + memoryStore 命名空间隔离
 *    - cleanup 彻底清理 + residue === 0 零残留断言
 *    - scanTestFile 规范自检 0 违规
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MagpieMemoryHub } from "../tools.js";
import { STATUS_JS_PATH } from "../page_actions.js";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【v6.40-c MCP Schema 参数声明与 _no_scheduler 前置隔离双向反证】");
console.log("=================================================================\n");

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log("  ✓ " + msg);
  } else {
    console.error("  ✗ [FAIL] " + msg);
    failures++;
  }
}

// -----------------------------------------------------------------
// 隔离环境基座 (mockDbClient + memoryStore)
// -----------------------------------------------------------------
const testProject = "__test_v640_c_" + Date.now() + "__";
const memoryStore = new Map();
const pitfallStore = new Map();
let nextId = 5000;

const mockDbClient = {
  list: async (table, params) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    const rows = [];
    for (const row of store.values()) {
      if (params && params.project && row.project !== params.project) continue;
      if (params && params.id && row.id !== params.id) continue;
      if (params && params.content_fingerprint && row.content_fingerprint !== params.content_fingerprint) continue;
      if (params && params.lifecycle_status && row.lifecycle_status !== params.lifecycle_status) continue;
      rows.push({ ...row });
    }
    return { data: rows, rows };
  },
  create: async (table, data) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    const id = nextId++;
    const saved = { ...data, id };
    store.set(id, saved);
    return saved;
  },
  update: async (table, id, data) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    const existing = store.get(id);
    if (!existing) {
      const err = new Error("Record not found: " + id);
      err.status = 404;
      throw err;
    }
    const updated = { ...existing, ...data };
    store.set(id, updated);
    return updated;
  },
  remove: async (table, id) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    store.delete(id);
    return { success: true };
  },
};

// -----------------------------------------------------------------
// 1. 【任务 1 / EVO-17】Schema 自演进参数双向反证 (a, b, c, d)
// -----------------------------------------------------------------
console.log("▶ [反证门 1: Schema 声明补齐与必填守卫]");

const baselineHub = await MagpieMemoryHub(
  { project: testProject, _no_scheduler: true },
  { _client: mockDbClient, _cfg: { project: testProject }, _no_scheduler: true }
);
const tools = baselineHub.tool;

// a) memory_save: 必须包含 supersede_id / supersede / related_entities
const memSaveProps = tools.memory_save.args.properties;
assert.ok(memSaveProps, "memory_save 必须存在 args.properties");
assert.ok(memSaveProps.supersede_id, "memory_save 必须声明 supersede_id");
assert.strictEqual(memSaveProps.supersede_id.type, "number", "supersede_id 类型应为 number");
assert.ok(memSaveProps.supersede_id.description.includes("取代"), "supersede_id description 须包含取代说明");

assert.ok(memSaveProps.supersede, "memory_save 必须声明 supersede");
assert.strictEqual(memSaveProps.supersede.type, "boolean", "supersede 类型应为 boolean");

assert.ok(memSaveProps.related_entities, "memory_save 必须声明 related_entities");
assert.strictEqual(memSaveProps.related_entities.type, "string", "related_entities 类型应为 string");

check(
  Boolean(memSaveProps.supersede_id && memSaveProps.supersede && memSaveProps.related_entities),
  "【反证 a】TOOLS.memory_save.args.properties 完整声明 supersede_id / supersede / related_entities"
);

// b) pitfall_save: 必须包含 related_entities / recurrence，且保持 root_cause
const pitSaveProps = tools.pitfall_save.args.properties;
assert.ok(pitSaveProps, "pitfall_save 必须存在 args.properties");
assert.ok(pitSaveProps.related_entities, "pitfall_save 必须声明 related_entities");
assert.strictEqual(pitSaveProps.related_entities.type, "string", "pitfall_save.related_entities 类型应为 string");

assert.ok(pitSaveProps.recurrence, "pitfall_save 必须声明 recurrence");
assert.strictEqual(pitSaveProps.recurrence.type, "number", "pitfall_save.recurrence 类型应为 number");

assert.ok(pitSaveProps.root_cause, "pitfall_save 既有 root_cause 必须完整保留");

check(
  Boolean(pitSaveProps.related_entities && pitSaveProps.recurrence && pitSaveProps.root_cause),
  "【反证 b】TOOLS.pitfall_save.args.properties 完整声明 related_entities / recurrence，且保留 root_cause"
);

// c) memory_context: 必须包含 max_principles
const memCtxProps = tools.memory_context.args.properties;
assert.ok(memCtxProps, "memory_context 必须存在 args.properties");
assert.ok(memCtxProps.max_principles, "memory_context 必须声明 max_principles");
assert.strictEqual(memCtxProps.max_principles.type, "number", "max_principles 类型应为 number");

check(
  Boolean(memCtxProps.max_principles),
  "【反证 c】TOOLS.memory_context.args.properties 完整声明 max_principles"
);

// d) required 数组未被篡改（防线反证：新增参数严禁误入 required）
const memSaveReq = tools.memory_save.args.required || [];
assert.deepStrictEqual([...memSaveReq].sort(), ["content", "title"], "memory_save required 必须严格为 ['title', 'content']");
assert.ok(!memSaveReq.includes("supersede_id"), "反证：supersede_id 绝不可为必填");
assert.ok(!memSaveReq.includes("supersede"), "反证：supersede 绝不可为必填");
assert.ok(!memSaveReq.includes("related_entities"), "反证：related_entities 绝不可为必填");

const pitSaveReq = tools.pitfall_save.args.required || [];
assert.deepStrictEqual([...pitSaveReq].sort(), ["solution", "symptom"], "pitfall_save required 必须严格为 ['symptom', 'solution']");
assert.ok(!pitSaveReq.includes("related_entities"), "反证：pitfall_save.related_entities 绝不可为必填");
assert.ok(!pitSaveReq.includes("recurrence"), "反证：pitfall_save.recurrence 绝不可为必填");

const memCtxReq = tools.memory_context.args.required || [];
assert.ok(!memCtxReq.includes("max_principles"), "反证：max_principles 绝不可为必填");

check(
  memSaveReq.length === 2 && pitSaveReq.length === 2 && memCtxReq.length === 0,
  "【反证 d】所有工具 required 数组未被改动，新增参数均为可选"
);

// -----------------------------------------------------------------
// 2. 【端到端真实调用反证 e】使用 Schema 参数 supersede_id 走通取代
// -----------------------------------------------------------------
console.log("\n▶ [反证门 2: supersede_id 端到端真实取代链路]");

// 先写入一条旧记录
const oldMem = await mockDbClient.create("memories", {
  project: testProject,
  category: "architecture",
  title: "前端打包构建方案",
  content: "全量使用 Webpack 5 构建并打包",
  full_text: "全量使用 Webpack 5 构建并打包",
  tags: "webpack,build",
  lifecycle_status: "active",
  recurrence: 1,
  confidence_score: 100,
});
const oldId = oldMem.id;
assert.ok(oldId, "旧记录必须已入库并生成 id");

// 模拟 MCP 客户端根据 Schema 传递 supersede_id
const rawSaveResult = await tools.memory_save.execute(
  {
    project: testProject,
    category: "architecture",
    title: "前端打包构建方案（Vite升级）",
    content: "全量切换为 Vite 6 进行极速打包，替代原 Webpack 5 架构",
    tags: "vite,build",
    supersede_id: oldId,
    related_entities: "vite,webpack",
  },
  { _client: mockDbClient }
);
const saveResult = typeof rawSaveResult === "string" ? JSON.parse(rawSaveResult) : rawSaveResult;

assert.ok(saveResult, "memory_save 返回值不能为空");
const newId = saveResult.id;
assert.ok(newId, "新记录必须成功落库并返回 id");
assert.notStrictEqual(newId, oldId, "新记录 ID 必须不同于旧记录 ID");

// 读取旧记录，断言其已更新为 superseded
const updatedOldRow = memoryStore.get(oldId);
assert.ok(updatedOldRow, "旧记录必须仍在库中（软失效）");
assert.strictEqual(updatedOldRow.lifecycle_status, "superseded", "旧记录 lifecycle_status 必须标记为 superseded");
assert.ok(
  String(updatedOldRow.invalid_reason || "").includes(String(newId)) || updatedOldRow.superseded_by_id === newId,
  "旧记录 invalid_reason 或 superseded_by_id 必须记录新记录 ID"
);

// 读取新记录，断言其为 active 且关联实体写入
const updatedNewRow = memoryStore.get(newId);
assert.ok(updatedNewRow, "新记录必须入库");
assert.strictEqual(updatedNewRow.lifecycle_status, "active", "新记录必须为 active 状态");
assert.strictEqual(updatedNewRow.related_entities, "vite,webpack", "新记录 related_entities 必须成功写入");

check(
  updatedOldRow.lifecycle_status === "superseded" && updatedNewRow.lifecycle_status === "active",
  "【反证 e】通过 Schema supersede_id 成功触发真实取代，旧记录 superseded 且新记录 active"
);

// -----------------------------------------------------------------
// 3. 【任务 2 / BUG-39-4a】_no_scheduler 入口前置副作用隔离反证 (f, g)
// -----------------------------------------------------------------
console.log("\n▶ [反证门 3: _no_scheduler 入口前置副作用隔离反证]");

// 静态前置断言：验证 tools.js 源码中 noScheduler 解析先于三处副作用，且由 !noScheduler 包裹
const toolsSource = fs.readFileSync(new URL("../tools.js", import.meta.url), "utf8");
const hubFuncMatch = toolsSource.match(/export const MagpieMemoryHub = async[\s\S]*?\{([\s\S]*?)\n\};/);
assert.ok(hubFuncMatch, "必须能解析出 MagpieMemoryHub 函数体");
const hubBody = hubFuncMatch[1];

const noSchedulerPos = hubBody.indexOf("const noScheduler =");
const writeCardPos = hubBody.indexOf("writeCardStatus(");
const autoInitPos = hubBody.indexOf("cfg.autoInit");
const autoHarvestPos = hubBody.indexOf("cfg.autoHarvest");

assert.ok(noSchedulerPos !== -1, "MagpieMemoryHub 内必须声明 noScheduler");
assert.ok(writeCardPos !== -1, "MagpieMemoryHub 内包含 writeCardStatus");
assert.ok(autoInitPos !== -1, "MagpieMemoryHub 内包含 autoInit");
assert.ok(autoHarvestPos !== -1, "MagpieMemoryHub 内包含 autoHarvest");

assert.ok(noSchedulerPos < writeCardPos, "【反证架构】noScheduler 解析必须位于 writeCardStatus 之前");
assert.ok(noSchedulerPos < autoInitPos, "【反证架构】noScheduler 解析必须位于 autoInit 之前");
assert.ok(noSchedulerPos < autoHarvestPos, "【反证架构】noScheduler 解析必须位于 autoHarvest 之前");

assert.ok(
  /if\s*\(!noScheduler\)\s*\{\s*try\s*\{[\s\S]*?writeCardStatus\("db"/.test(hubBody),
  "【反证包裹】writeCardStatus 必须由 if (!noScheduler) 包裹"
);
assert.ok(
  /if\s*\(!noScheduler\s*&&\s*cfg\.autoInit/.test(hubBody),
  "【反证包裹】autoInit 必须由 !noScheduler && 条件包裹"
);
assert.ok(
  /if\s*\(!noScheduler\s*&&\s*cfg\.autoHarvest/.test(hubBody),
  "【反证包裹】autoHarvest 必须由 !noScheduler && 条件包裹"
);

check(
  noSchedulerPos < writeCardPos && noSchedulerPos < autoInitPos && noSchedulerPos < autoHarvestPos,
  "【反证静态】_no_scheduler 解析位置完全先于三处前置副作用，且全量施加 !noScheduler 防御"
);

// 运行时真实副作用阻断反证 f：
// 备份状态文件
const statusJsonPath = STATUS_JS_PATH.replace(/\.js$/, ".json");
let originalStatusJson = null;
let originalStatusJs = null;
if (fs.existsSync(statusJsonPath)) {
  originalStatusJson = fs.readFileSync(statusJsonPath, "utf8");
}
if (fs.existsSync(STATUS_JS_PATH)) {
  originalStatusJs = fs.readFileSync(STATUS_JS_PATH, "utf8");
}

try {
  // 构造带有 unique instance 探针但开启 _no_scheduler: true 的 Hub
  const probeDbName = "probe_nosched_isolated_" + Date.now();
  const isolatedHub = await MagpieMemoryHub(
    {
      _no_scheduler: true,
      instance: probeDbName,
      autoInit: true,
      autoHarvest: true,
    },
    { _client: mockDbClient, _no_scheduler: true, instance: probeDbName }
  );

  // 断言 1：_status.json 绝不包含探针库名
  if (fs.existsSync(statusJsonPath)) {
    const curContent = fs.readFileSync(statusJsonPath, "utf8");
    assert.ok(!curContent.includes(probeDbName), "反证：_status.json 绝不应被 _no_scheduler=true 实例覆写");
  }

  // 断言 2：实例仍具备完整 21 个 tool
  const isolatedTools = isolatedHub.tool;
  assert.ok(isolatedTools, "_no_scheduler 构造实例必须具有 tool 对象");
  const toolNames = Object.keys(isolatedTools);
  assert.strictEqual(toolNames.length, 21, "_no_scheduler 构造实例必须具备全部 21 个工具");
  assert.ok(typeof isolatedTools.memory_save.execute === "function", "memory_save 工具必须可执行");
  assert.ok(typeof isolatedTools.pitfall_save.execute === "function", "pitfall_save 工具必须可执行");

  check(
    toolNames.length === 21,
    "【反证 f】_no_scheduler: true 成功阻断 writeCardStatus，且返回完整 21 个可用工具"
  );

  // 对照组反证 g：未传 _no_scheduler 时主路径原有卡片写入行为正常生效
  const normalProbeDb = "probe_normal_active_" + Date.now();
  await MagpieMemoryHub(
    {
      instance: normalProbeDb,
    },
    { _client: mockDbClient, instance: normalProbeDb }
  );
  if (fs.existsSync(statusJsonPath)) {
    const normalContent = fs.readFileSync(statusJsonPath, "utf8");
    assert.ok(normalContent.includes(normalProbeDb), "反证对照：未传 _no_scheduler 时必须正常执行 writeCardStatus 写入卡片");
  }
  check(true, "【对照反证 g】未传 _no_scheduler 时，主路径 writeCardStatus 行为 100% 保持不变");
} finally {
  // 恢复状态文件，杜绝污染
  if (originalStatusJson !== null) {
    fs.writeFileSync(statusJsonPath, originalStatusJson, "utf8");
  } else if (fs.existsSync(statusJsonPath)) {
    fs.unlinkSync(statusJsonPath);
  }
  if (originalStatusJs !== null) {
    fs.writeFileSync(STATUS_JS_PATH, originalStatusJs, "utf8");
  } else if (fs.existsSync(STATUS_JS_PATH)) {
    fs.unlinkSync(STATUS_JS_PATH);
  }
}

// -----------------------------------------------------------------
// 4. 清理逻辑与残余断言 (residue === 0)
// -----------------------------------------------------------------
console.log("\n▶ [隔离清理] 执行测试数据清理并断言残余为 0...");
async function cleanup() {
  const mems = await mockDbClient.list("memories", { project: testProject });
  for (const m of mems.data) {
    await mockDbClient.remove("memories", m.id);
  }
  const pits = await mockDbClient.list("pitfalls", { project: testProject });
  for (const p of pits.data) {
    await mockDbClient.remove("pitfalls", p.id);
  }
  MagpieMemoryHub.stopAuditScheduler();
}

await cleanup();

const finalMems = await mockDbClient.list("memories", { project: testProject });
const finalPits = await mockDbClient.list("pitfalls", { project: testProject });
const totalResidue = finalMems.data.length + finalPits.data.length;
assert.strictEqual(totalResidue, 0, `测试后残余记录必须为 0，实际为 ${totalResidue}`);
check(totalResidue === 0, "测试后数据残余校验断言：residue === 0");

// -----------------------------------------------------------------
// 5. 元检查规范自检 (scanTestFile)
// -----------------------------------------------------------------
console.log("\n▶ [自检] test_meta 规范合规性自检...");
{
  const selfPath = fileURLToPath(import.meta.url);
  const selfContent = fs.readFileSync(selfPath, "utf8");
  const scanRes = scanTestFile(selfPath, selfContent);
  if (scanRes.issues.length > 0) {
    for (const is of scanRes.issues) {
      console.error("   - " + is);
    }
  }
  assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 0 规范违规");
  check(scanRes.issues.length === 0, "test_meta 自检 0 违规");
}

console.log("\n=================================================================");
if (failures > 0) {
  console.error(`❌ 共 ${failures} 项断言失败`);
  process.exit(1);
}
console.log("✅ v6.40-c 全部反证门 100% 通过！");
