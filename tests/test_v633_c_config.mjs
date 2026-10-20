/**
 * test_v633_c_config.mjs —— 数字归一化修复与配置漂移对齐验收测试
 *
 * 覆盖 2 项核心整改及反证门：
 * 1. 【P1-1 核心】hasConflictingNumbers 末位零丢失导致版本号冲突漏检（semantic_dedup.js）
 *    - 单元测试：Python 3.1 vs 3.10、Go 1.2 vs 1.20、v1.2.3 vs v1.2.30 等版本号冲突反证；
 *    - 语义比对：isSemanticallySimilar 严格短路防误合并；
 *    - 端到端：pitfall_save / memory_save 在真实 tools 流程下防误杀误并，相同版本等价表述正常去重累加。
 * 2. 【P2-1】配置默认值与文档/断言漂移
 *    - package.json / settings.html / settings.js 三端 dedup_batch_size: 50 完全对齐；
 *    - tests/test_meta.mjs 第 160 行提示文案对齐「期望精确 52 个」；
 *    - DEVNOTES.md 第 22.3 节复选框勾选完成状态校验；
 *    - 引擎底层参数 dedup_fetch_limit (200)、audit_chunk_size (40)、audit_max_batches (2) 对齐核验。
 */

process.env.NODE_ENV = "test";
process.env.MAGPIE_TEST = "1";

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTestEnv } from "./lib/testenv.mjs";
import { MagpieMemoryHub } from "../tools.js";
import {
  hasConflictingNumbers,
  isSemanticallySimilar,
} from "../semantic_dedup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function parseOut(res) {
  if (typeof res === "string") {
    try {
      return JSON.parse(res);
    } catch (_) {
      return res;
    }
  }
  return res;
}

console.log("=================================================================");
console.log("【测试开始】Track C: 数字归一化修复与配置漂移对齐综合验收套件 (v6.33)");
console.log("=================================================================\n");

const env = await createTestEnv({ mode: "memory" });

try {
  // ===========================================================================
  // 1. 【P1-1 核心】hasConflictingNumbers 单元测试与多段版本号反证门
  // ===========================================================================
  console.log("▶ [Test 1] 验证 hasConflictingNumbers 末位零版本号冲突反证门...");
  {
    // 1.1 关键反证门：末位零版本号必须判定为冲突
    assert.strictEqual(
      hasConflictingNumbers("Python 3.1", "Python 3.10"),
      true,
      "[反证门 1.1] Python 3.1 vs Python 3.10 必须判定为数字冲突！"
    );
    assert.strictEqual(
      hasConflictingNumbers("Go 1.2", "Go 1.20"),
      true,
      "[反证门 1.2] Go 1.2 vs Go 1.20 必须判定为数字冲突！"
    );
    assert.strictEqual(
      hasConflictingNumbers("v1.2.3", "v1.2.30"),
      true,
      "[反证门 1.3] v1.2.3 vs v1.2.30 必须判定为数字冲突！"
    );
    assert.strictEqual(
      hasConflictingNumbers("Node 18", "Node 20"),
      true,
      "[反证门 1.4] Node 18 vs Node 20 必须判定为数字冲突！"
    );
    assert.strictEqual(
      hasConflictingNumbers("Port 80", "Port 8080"),
      true,
      "[反证门 1.5] Port 80 vs Port 8080 必须判定为数字冲突！"
    );
    assert.strictEqual(
      hasConflictingNumbers("127.0.0.1:80", "127.0.0.1:8080"),
      true,
      "[反证门 1.6] 127.0.0.1:80 vs 127.0.0.1:8080 必须判定为数字冲突！"
    );

    // 1.2 反证门：相同数字/等价前导零规范化必须放行（不冲突）
    assert.strictEqual(
      hasConflictingNumbers("port 8080", "端口 8080"),
      false,
      "[反证门 1.7] port 8080 vs 端口 8080 相同端口号绝不能误判为冲突"
    );
    assert.strictEqual(
      hasConflictingNumbers("Python 03.1", "Python 3.1"),
      false,
      "[反证门 1.8] 前导零规范化：03.1 vs 3.1 视为同一版本号，不冲突"
    );
    assert.strictEqual(
      hasConflictingNumbers("Docker 启动失败", "Docker 容器启动崩溃"),
      false,
      "[反证门 1.9] 双侧均无数字不冲突"
    );
    assert.strictEqual(
      hasConflictingNumbers("Docker 启动失败", "Docker 127.0.0.1 启动失败"),
      false,
      "[反证门 1.10] 单侧无数字不冲突"
    );

    // 1.3 语义比对防御：isSemanticallySimilar 顶层短路拦截
    const similarDiffVersion = isSemanticallySimilar(
      "Python 3.1 环境依赖报错",
      "系统运行缺少依赖模块，需配置环境",
      "Python 3.10 环境依赖报错",
      "系统运行缺少依赖模块，需配置环境"
    );
    assert.strictEqual(
      similarDiffVersion,
      false,
      "[反证门 1.11] isSemanticallySimilar 必须因版本号 3.1 vs 3.10 冲突直接短路返回 false！"
    );

    const sameVersionSimilar = isSemanticallySimilar(
      "Python 3.10 环境依赖报错",
      "系统运行缺少依赖模块，需配置环境",
      "Python 3.10 环境缺少依赖报错",
      "系统运行缺少依赖模块，需要配置环境"
    );
    assert.strictEqual(
      sameVersionSimilar,
      true,
      "[正例门 1.12] 相同版本号 3.10 的等价表述必须正常判定为语义相似"
    );

    console.log("  ✓ hasConflictingNumbers 与 isSemanticallySimilar 12 项正反测试全部通过\n");
  }

  // ===========================================================================
  // 2. 【P1-1 端到端】pitfall_save 与 memory_save 防误杀实测
  // ===========================================================================
  console.log("▶ [Test 2] 验证 pitfall_save / memory_save 在不同版本号下独立入库防误杀...");
  {
    const hub = await MagpieMemoryHub({}, { client: env.client, ncb_instance: env.instance });
    const pitSave = hub.tool["pitfall_save"];
    const memSave = hub.tool["memory_save"];

    // 2.1 pitfall_save: Python 3.1 vs Python 3.10
    const p1 = parseOut(
      await pitSave.execute({
        project: env.project,
        symptom: "Python 3.1 运行时缺少依赖模块",
        solution: "升级依赖或使用兼容版本",
      })
    );
    assert.strictEqual(p1.action, "ADD", "第 1 条 Python 3.1 必须正常入库");

    // 保存 Python 3.10 的报错：绝不能被当成 Python 3.1 的重复条目丢弃！
    const p2 = parseOut(
      await pitSave.execute({
        project: env.project,
        symptom: "Python 3.10 运行时缺少依赖模块",
        solution: "安装 Python 3.10 对应的新版模块",
      })
    );
    assert.strictEqual(
      p2.action,
      "ADD",
      "[反证门 2.1] Python 3.10 绝不能被当成 Python 3.1 的重复项丢弃！必须独立入库"
    );
    assert.notStrictEqual(p1.id, p2.id, "Python 3.1 与 Python 3.10 必须具有不同 ID");

    // 反证：相同版本号 3.10 的等价表述，必须命中去重累加 recurrence
    const p3 = parseOut(
      await pitSave.execute({
        project: env.project,
        symptom: "Python 3.10 运行时缺失依赖包",
        solution: "安装 Python 3.10 对应的新版模块",
      })
    );
    assert.strictEqual(p3.action, "NOOP", "反证门 2.2: 相同版本号 3.10 等价表述必须命中去重");
    assert.strictEqual(p3.id, p2.id, "必须命中并合并至已有的 Python 3.10 记录");
    assert.strictEqual(p3.recurrence, 2, "recurrence 计数必须累加至 2");

    // 2.2 memory_save: Go 1.2 vs Go 1.20
    const m1 = parseOut(
      await memSave.execute({
        project: env.project,
        title: "Go 1.2 编译规范与路径设置",
        content: "Go 1.2 要求严格配置 GOPATH 与 GOROOT 环境变量进行构建",
      })
    );
    assert.strictEqual(m1.action, "ADD", "第 1 条 Go 1.2 必须正常入库");

    const m2 = parseOut(
      await memSave.execute({
        project: env.project,
        title: "Go 1.20 编译规范与路径设置",
        content: "Go 1.20 默认开启 Go Modules 模式，不依赖传统 GOPATH 构建",
      })
    );
    assert.strictEqual(
      m2.action,
      "ADD",
      "[反证门 2.3] Go 1.20 绝不能被当成 Go 1.2 的重复项合并！必须独立入库"
    );
    assert.notStrictEqual(m1.id, m2.id, "Go 1.2 与 Go 1.20 必须具有不同 ID");

    console.log("  ✓ pitfall_save 与 memory_save 端到端防误杀与正常累加反证全部通过\n");
  }

  // ===========================================================================
  // 3. 【P2-1】配置默认值与文档/断言漂移核查
  // ===========================================================================
  console.log("▶ [Test 3] 验证配置默认值与文档/断言漂移...");
  {
    // 3.1 package.json vs settings.html vs settings.js 对齐 dedup_batch_size: 50
    const pkgPath = path.join(ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const htmlPath = path.join(ROOT, "settings.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    const jsPath = path.join(ROOT, "settings.js");
    const js = fs.readFileSync(jsPath, "utf8");

    assert.strictEqual(
      pkg.magpie.options.dedup_batch_size,
      50,
      "package.json dedup_batch_size 必须为 50"
    );

    // settings.html 校验
    assert.ok(
      html.includes('id="dedup_batch_size" min="50" max="1000" step="50" value="50"'),
      "settings.html dedup_batch_size input 默认 value 必须为 50"
    );
    assert.ok(
      /for=["']dedup_batch_size["'][\s\S]*?<span class=["']badge rec["']>默认 50<\/span>/.test(html),
      "settings.html dedup_batch_size badge 必须展示为「默认 50」"
    );
    assert.ok(
      html.includes("推荐 50"),
      "settings.html dedup_batch_size 提示中必须包含「推荐 50」"
    );

    // settings.js NUM 对象校验
    assert.ok(
      /dedup_batch_size:\s*50\b/.test(js),
      "settings.js NUM 默认值必须为 dedup_batch_size: 50"
    );

    // 3.2 tests/test_meta.mjs 提示文案对齐
    const metaPath = path.join(ROOT, "tests/test_meta.mjs");
    const metaContent = fs.readFileSync(metaPath, "utf8");
    // 语义化断言：校验「断言数字」与「提示文案中的数字」一致，
    // 不硬编码具体数值，避免主控合并锁定新总数时误伤
    const mAssert = metaContent.match(/assert\.strictEqual\(testFiles\.length,\s*(\d+),\s*["']([^"']*)["']/);
    assert.ok(mAssert, "tests/test_meta.mjs 必须存在测试总数断言");
    const declaredCount = mAssert[1];
    const msgText = mAssert[2];
    const msgNums = msgText.match(/\d+/g) || [];
    assert.ok(msgNums.length > 0, "测试总数断言的提示文案必须包含数字");
    assert.strictEqual(
      msgNums[0],
      declaredCount,
      `测试总数断言的提示文案数字(${msgNums[0]})必须与断言数字(${declaredCount})一致，杜绝文案漂移`
    );

    // 3.3 DEVNOTES.md 第 22.3 节复选框勾选校验
    const devnotesPath = path.join(ROOT, "DEVNOTES.md");
    const devnotes = fs.readFileSync(devnotesPath, "utf8");
    const sec22Match = devnotes.match(
      /- \[x\] 3\. P2-4 mcp_client\.js \/ ncb_mcp\.js[\s\S]*?- \[x\] buildSelect OFFSET[\s\S]*?- \[x\] create 回查分流[\s\S]*?- \[x\] ncb_mcp\.initialize/
    );
    assert.ok(
      !!sec22Match,
      "DEVNOTES.md 第 22.3 节及其子项复选框必须全部勾选为完成 [- [x]]"
    );

    // 3.4 引擎底层配置默认值一致性核查
    assert.strictEqual(
      pkg.magpie.options.dedup_fetch_limit,
      200,
      "package.json 声明 dedup_fetch_limit: 200"
    );
    assert.strictEqual(
      pkg.magpie.options.audit_max_batches,
      2,
      "package.json 声明 audit_max_batches: 2"
    );
    assert.strictEqual(
      pkg.magpie.options.audit_chunk_size,
      40,
      "package.json 声明 audit_chunk_size: 40"
    );

    console.log("  ✓ 配置默认值与文档/断言漂移 4 项核查全部通过\n");
  }

} finally {
  // ===========================================================================
  // 清理与残留检查（test_meta 门禁自证）
  // ===========================================================================
  const cleanRes = await env.cleanup();
  const residue = await env.countAllTestResidue();
  assert.strictEqual(residue.total, 0, `测试后数据库必须 0 残留: ${JSON.stringify(residue)}`);
  console.log(`✓ 测试环境已完全清理，测试残余数: ${residue.total}`);
}

console.log("=================================================================");
console.log("✅ Track C 2 项整改及反证门测试 100% 全部通过！");
console.log("=================================================================");
