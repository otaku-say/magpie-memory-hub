/**
 * tests/test_v640_b_supersede.mjs
 * =================================================================
 * v6.40-b 修复 BUG-39-2 supersede_id 三处漏洞专项双向反证测试套件
 *
 * 覆盖 3 大核心漏洞与全量双向反证门：
 * a) 跨项目越权反证门：
 *    project_A 存入 fact，project_B 尝试以其 id 作为 supersede_id 保存
 *    → 必须被拒绝/忽略（严格返回 NOOP，不写库），project_A 记录绝不被跨项目篡改，状态仍为 active，invalid_at 仍为 null。
 * b) 已失效记录防误"激活"反证门：
 *    已 soft-delete（invalid_at 非空或非 active）的记录 id 作为 supersede_id 保存
 *    → 必须被拒绝/忽略（严格返回 NOOP），不得被当作有效取代目标。
 * c) 正常同项目同标题取代正向门：
 *    同项目同标题显式传 supersede_id
 *    → 仍必须成功（返回 UPDATE + 旧记录标记 superseded 并指向新 ID，新记录 revision 递增）。
 * d) 踩坑优先穿透反证门：
 *    库中存在同名踩坑时，显式传 supersede_id
 *    → 必须穿透踩坑优先拦截，成功返回 UPDATE，绝不被拦截为 table="pitfalls" 的 NOOP。
 * e) 缺省行为保全反证门：
 *    不传 supersede_id 时，原有的踩坑优先拦截与语义查重 NOOP 机制 100% 保持不变。
 *
 * 元规范自检与零残留防线：
 * - 引用 createTestEnv / env.project 隔离
 * - 强制 cleanup 与 residue.total === 0 强断言
 * - scanTestFile 静态自检 0 违规
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MagpieMemoryHub } from "../tools.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

const parseOut = (res) => {
  if (typeof res === "string") {
    try {
      return JSON.parse(res);
    } catch (_) {
      return res;
    }
  }
  return res;
};

const rowsOf = (res) => {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res.rows)) return res.rows;
  return [];
};

console.log("=================================================================");
console.log("【v6.40-b 修复 supersede_id 三漏洞专项双向反证测试套件】");
const env = await createTestEnv({ mode: "memory" });
const envB = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 主测试隔离命名空间 A: ${env.project}`);
console.log(`[testenv] 跨项目隔离命名空间 B: ${envB.project}`);
console.log("=================================================================\n");

try {
  const hubA = await env.createHub({ crystallization_threshold: 5 });
  const hubB = await envB.createHub({ crystallization_threshold: 5 });

  const memForgetA = hubA.tool["memory_forget"];

  // =================================================================
  // a) 跨项目越权反证门
  // =================================================================
  console.log("▶ [Test a] 【跨项目越权反证门】project_A 存 fact，project_B 传其 id 作为 supersede_id...");

  // a.1 在 project_A 中存入一条关键事实记录
  const factA = parseOut(await hubA.tool.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "跨项目安全规范",
    content: "生产密钥严格隔离在 project_A 专有 KMS 空间内，禁止任何外部引用",
  }, {}));
  assert.strictEqual(factA.action, "ADD", "project_A 记录初次入库必须为 ADD");
  assert.ok(factA.id, "必须生成有效记录 ID");

  // a.2 在 project_B 中尝试用 factA.id 进行显式取代
  const crossAttackRes = parseOut(await hubB.tool.memory_save.execute({
    project: envB.project,
    category: "decision",
    title: "跨项目安全规范",
    content: "试图跨项目越权篡改：将密钥空间切换为 project_B 共享目录",
    supersede_id: factA.id,
  }, {}));

  // 断言：跨项目取代必须被明确拒绝，返回 NOOP
  assert.strictEqual(
    crossAttackRes.action,
    "NOOP",
    "【反证门 a.1 通过】：跨项目传 supersede_id 必须被严格拒绝并返回 NOOP"
  );
  assert.strictEqual(crossAttackRes.id, null, "跨项目拒绝时 id 必须为 null，绝不写入新记录");
  assert.ok(
    String(crossAttackRes.note || "").includes("supersede_id 指向不存在/跨项目/已失效的记录"),
    "必须返回明确的越权与失效拦截告警 note"
  );

  // a.3 校验底层数据完整性：project_A 的记录必须完好如初，绝不允许被跨项目篡改
  const checkRowA = rowsOf(await env.client.list("memories", { id: factA.id, limit: 1 }))[0];
  assert.ok(checkRowA, "project_A 记录必须存在");
  assert.strictEqual(
    checkRowA.lifecycle_status,
    "active",
    "【反证门 a.2 通过】：project_A 记录 lifecycle_status 仍必须为 active，绝不被篡改为 superseded"
  );
  assert.strictEqual(
    checkRowA.invalid_at,
    null,
    "【反证门 a.3 通过】：project_A 记录 invalid_at 仍必须为 null，绝不被软失效"
  );
  assert.strictEqual(
    checkRowA.superseded_by_id,
    null,
    "【反证门 a.4 通过】：project_A 记录 superseded_by_id 仍必须为 null"
  );

  // a.4 检查 project_B 数据库：严禁产生任何污染记录
  const listB = rowsOf(await envB.client.list("memories", { project: envB.project, limit: 10 }));
  assert.strictEqual(
    listB.length,
    0,
    "【反证门 a.5 通过】：被拒绝的跨项目越权写入不得在 project_B 留下任何数据残余"
  );
  console.log("  ✓ a. 跨项目越权反证门全部通过（越权被拦截且原项目记录未受任何篡改）！\n");

  // =================================================================
  // b) 已失效记录防误"激活"反证门
  // =================================================================
  console.log("▶ [Test b] 【已失效记录防误'激活'反证门】以已软失效记录 id 作为 supersede_id...");

  // b.1 先创建一条记忆并将其软失效
  const memToForget = parseOut(await hubA.tool.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "旧版本网关端口配置",
    content: "微服务网关对外暴露端口为 8080",
  }, {}));
  assert.strictEqual(memToForget.action, "ADD");
  assert.ok(memToForget.id);

  // 软失效该记录
  const forgetRes = parseOut(await memForgetA.execute({
    id: memToForget.id,
    project: env.project,
  }, {}));
  assert.strictEqual(forgetRes.action, "SOFT_DELETE", "记录必须成功软失效");

  const checkForgotten = rowsOf(await env.client.list("memories", { id: memToForget.id, limit: 1 }))[0];
  assert.ok(checkForgotten.invalid_at != null, "确认记录 invalid_at 已打上时间戳");

  // b.2 尝试以已软失效记录的 id 作为 supersede_id 保存
  const deadSupersedeRes = parseOut(await hubA.tool.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "新版本网关端口配置",
    content: "微服务网关对外暴露端口切换为 8443",
    supersede_id: memToForget.id,
  }, {}));

  // 断言：已失效记录不得被当作有效取代目标，必须返回明确 NOOP
  assert.strictEqual(
    deadSupersedeRes.action,
    "NOOP",
    "【反证门 b.1 通过】：以已失效记录作为 supersede_id 必须被拒绝并返回 NOOP"
  );
  assert.strictEqual(deadSupersedeRes.id, null);
  assert.ok(
    String(deadSupersedeRes.note || "").includes("supersede_id 指向不存在/跨项目/已失效的记录"),
    "必须返回明确的已失效拦截 note"
  );

  // 确认已失效记录未被异常修改
  const checkForgottenAfter = rowsOf(await env.client.list("memories", { id: memToForget.id, limit: 1 }))[0];
  assert.ok(checkForgottenAfter.invalid_at != null, "已失效记录 invalid_at 依然有效");
  assert.strictEqual(checkForgottenAfter.superseded_by_id, null, "不得被赋予新的 superseded_by_id");
  console.log("  ✓ b. 已失效记录防误激活反证门全部通过！\n");

  // =================================================================
  // c) 正常同项目同标题取代正向门
  // =================================================================
  console.log("▶ [Test c] 【正常同项目取代正向门】合法同项目显式 supersede_id 取代...");

  // c.1 创建正常旧事实
  const validOld = parseOut(await hubA.tool.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "存储引擎选型决策",
    content: "初期采用 SQLite 单文件存储引擎以降低运维复杂度",
  }, {}));
  assert.strictEqual(validOld.action, "ADD");
  assert.ok(validOld.id);

  // c.2 显式取代旧记录（fact -> decision）
  const validSupersedeRes = parseOut(await hubA.tool.memory_save.execute({
    project: env.project,
    category: "decision",
    title: "存储引擎选型决策",
    content: "随着业务并发规模扩大，全面演进为 PostgreSQL 集群架构",
    supersede_id: validOld.id,
  }, {}));

  assert.strictEqual(
    validSupersedeRes.action,
    "UPDATE",
    "【正向门 c.1 通过】：合法 supersede_id 必须成功取代并返回 UPDATE"
  );
  assert.ok(validSupersedeRes.id && validSupersedeRes.id !== validOld.id, "必须生成全新版本记录 ID");
  assert.strictEqual(validSupersedeRes.superseded_id, validOld.id, "返回体必须指明被取代的旧记录 ID");

  // c.3 验证数据库旧记录被置为 superseded 且版本递增
  const checkValidOld = rowsOf(await env.client.list("memories", { id: validOld.id, limit: 1 }))[0];
  assert.strictEqual(checkValidOld.lifecycle_status, "superseded", "旧记录必须被置为 superseded");
  assert.strictEqual(checkValidOld.invalid_reason, `superseded-by:${validSupersedeRes.id}`);
  assert.strictEqual(checkValidOld.superseded_by_id, validSupersedeRes.id);
  assert.ok(checkValidOld.invalid_at != null);

  const checkValidNew = rowsOf(await env.client.list("memories", { id: validSupersedeRes.id, limit: 1 }))[0];
  assert.strictEqual(checkValidNew.lifecycle_status, "active");
  assert.strictEqual(checkValidNew.revision, (Number(checkValidOld.revision) || 1) + 1, "版本号必须正确递增");
  console.log("  ✓ c. 正常同项目同标题取代正向门全部通过！\n");

  // =================================================================
  // d) 踩坑优先穿透反证门
  // =================================================================
  console.log("▶ [Test d] 【踩坑优先穿透反证门】存在同名踩坑时，显式传 supersede_id 必须穿透拦截...");

  // d.1 在 memories 表中存入一条基础方案记录（不含内存溢出报错关键词，保持活跃）
  const memD1 = parseOut(await hubA.tool.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "前端构建打包方案",
    content: "项目基础配置：统一采用前端模块化打包与资源构建工具链",
  }, {}));
  assert.strictEqual(memD1.action, "ADD", "基础方案初次入库必须为 ADD");
  assert.ok(memD1.id, "必须生成有效基础记录 ID");

  // d.2 在 pitfalls 表中存入一条构建报错踩坑
  const pitfallD = parseOut(await hubA.tool.pitfall_save.execute({
    project: env.project,
    component: "build",
    symptom: "前端构建报 heap out of memory 内存溢出",
    solution: "配置 NODE_OPTIONS=--max-old-space-size=4096 并在 CI 开启分包缓存",
  }, {}));
  assert.strictEqual(pitfallD.action, "ADD", "踩坑初次入库必须为 ADD");

  // 验证 memD1 仍为 active
  const checkMemD1 = rowsOf(await env.client.list("memories", { id: memD1.id, limit: 1 }))[0];
  assert.strictEqual(checkMemD1.lifecycle_status, "active", "基础方案仍为 active 状态");
  assert.strictEqual(checkMemD1.invalid_at, null, "基础方案 invalid_at 为 null");

  // d.3 显式传 supersede_id: memD1.id 取代旧方案，新记忆标题与正文完全匹配上述踩坑
  const supersedePenetrateRes = parseOut(await hubA.tool.memory_save.execute({
    project: env.project,
    category: "decision",
    title: "前端构建报 heap out of memory 内存溢出",
    content: "经架构决策，全面升级为现代化打包工具，彻底消灭前端构建报 heap out of memory 内存溢出隐患",
    supersede_id: memD1.id,
  }, {}));

  // 断言：显式 supersede 意图必须穿透「0.5) 踩坑优先」，绝不得被拦成 table="pitfalls" 的 NOOP
  assert.strictEqual(
    supersedePenetrateRes.action,
    "UPDATE",
    "【反证门 d.1 通过】：显式传 supersede_id 必须穿透踩坑优先拦截，成功返回 UPDATE！"
  );
  assert.strictEqual(
    supersedePenetrateRes.superseded_id,
    memD1.id,
    "被取代 ID 必须精确等于传入的 supersede_id"
  );
  assert.ok(
    supersedePenetrateRes.table !== "pitfalls",
    "【反证门 d.2 通过】：严禁被拦截到 pitfalls 表"
  );
  console.log("  ✓ d. 踩坑优先穿透反证门全部通过（显式取代未被踩坑拦截）！\n");

  // =================================================================
  // e) 缺省行为保全反证门
  // =================================================================
  console.log("▶ [Test e] 【缺省行为保全反证门】不传 supersede_id 时原有踩坑优先与语义查重完全不变...");

  // e.1 不传 supersede_id，写入与 pitfallD 症状同名的普通记忆 → 必须被「踩坑优先」拦截返回 NOOP, table: "pitfalls"
  const defaultPitfallBlock = parseOut(await hubA.tool.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "前端构建报 heap out of memory 内存溢出",
    content: "排查前端构建报 heap out of memory 内存溢出重复故障",
  }, {}));

  assert.strictEqual(
    defaultPitfallBlock.action,
    "NOOP",
    "【反证门 e.1 通过】：不传 supersede_id 时踩坑优先拦截机制完好生效"
  );
  assert.strictEqual(
    defaultPitfallBlock.table,
    "pitfalls",
    "【反证门 e.2 通过】：拦截目标表必须为 pitfalls"
  );
  assert.strictEqual(
    defaultPitfallBlock.id,
    pitfallD.id,
    "【反证门 e.3 通过】：必须关联至既有踩坑记录"
  );

  // e.2 不传 supersede_id，语义相似重复写入 memories → 必须命中正常语义查重返回 NOOP 并关联原 ID
  const memUnique = parseOut(await hubA.tool.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "微服务网关路由选型",
    content: "当前网关路由统一基于 Envoy 与 Istio Service Mesh 实现流量治理",
  }, {}));
  assert.strictEqual(memUnique.action, "ADD");

  const memDupRes = parseOut(await hubA.tool.memory_save.execute({
    project: env.project,
    category: "fact",
    title: "微服务网关路由选型",
    content: "网关路由统一基于 Envoy 与 Istio Mesh 架构完成流量调度与治理",
  }, {}));

  assert.strictEqual(
    memDupRes.action,
    "NOOP",
    "【反证门 e.4 通过】：不传 supersede_id 的重复内容必须正常触发语义查重 NOOP"
  );
  assert.strictEqual(memDupRes.id, memUnique.id, "重复写入必须关联原记忆 ID");
  assert.ok(
    String(memDupRes.note || "").includes("累加复发计数"),
    "必须包含累加复发计数说明"
  );
  console.log("  ✓ e. 缺省行为保全反证门全部通过（踩坑优先与查重防重机制完整保留）！\n");

  // =================================================================
  // 元规范自检
  // =================================================================
  console.log("▶ [Test Meta] 【元检查自检】对本测试文件进行 test_meta 规范扫描...");
  const thisFile = fileURLToPath(import.meta.url);
  const rawContent = fs.readFileSync(thisFile, "utf8");
  const scanRes = scanTestFile(thisFile, rawContent);

  if (scanRes.issues.length > 0) {
    console.error("❌ test_v640_b_supersede.mjs 存在 test_meta 规范违规:");
    for (const is of scanRes.issues) {
      console.error("   -", is);
    }
  }

  assert.strictEqual(
    scanRes.issues.length,
    0,
    "本测试文件自身必须 100% 符合 test_meta 测试规范！"
  );
  assert.strictEqual(
    scanRes.hasDbWrite,
    true,
    "本测试包含写库操作，已严格集成 createTestEnv 隔离与 cleanup 机制"
  );
  console.log("  ✓ 元检查经 test_meta 静态扫描，0 规范违规！\n");

} finally {
  console.log("[CLEANUP] 开始清理隔离命名空间...");
  await env.cleanup();
  await envB.cleanup();
  const residue = await env.countAllTestResidue();
  assert.strictEqual(residue.total, 0, `[残余断言失败] 清理后仍有残余记录: ${JSON.stringify(residue)}`);
  console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
}

console.log("=================================================================");
console.log("🎉 全部 v6.40-b BUG-39-2 五大双向反证测试 100% 成功通过！");
console.log("=================================================================");
