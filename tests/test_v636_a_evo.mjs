/**
 * tests/test_v636_a_evo.mjs
 * =================================================================
 * v6.36-a EVO-1 与 EVO-4 核心功能与双向反证专项验收测试套件
 *
 * 覆盖：
 * 1. 【EVO-1 双向反证门】记忆认知智能增量扩充
 *    - 正向反证：同标题简短记忆补充架构细节（长度增长 ≥ 1.25 倍且无数字冲突）
 *      -> 触发 action: "ENRICHED"，保留原 ID，递增 revision，融合 content/tags/entities。
 *    - 反向反证 1：信息量无显著增长（长度增长 < 1.25 倍且无 supersede）
 *      -> 严格维持原 action: "NOOP"，正文与 revision 保持不变。
 *    - 反向反证 2：数字冲突守卫（如 80 端口 vs 8080 端口）
 *      -> 严禁增量合并原记录，杜绝版本号/端口号误并。
 *    - 显式指示：无数字冲突下传入 supersede: true 时，即使长度增长 < 1.25 倍亦必须触发 ENRICHED。
 *
 * 2. 【EVO-4 升维双向反证门】preference/decision 高频经验升维结晶
 *    - 正向反证：preference 记忆累加至阈值（默认 5）且 confidence ≥ 80
 *      -> 自动升级 category 为 principle（写库），note 说明「已升维为 principle」。
 *    - 反向反证 1：未达阈值（recurrence = 4 < 5）-> 严禁升级，维持原 category。
 *    - 反向反证 2：可信度不足（recurrence = 5 但 confidence = 70 < 80）-> 严禁升级。
 *    - 反向反证 3：非 preference/decision 类别（如 fact，recurrence = 5，confidence = 90）-> 严禁升级。
 *    - 配置化覆盖：配置 crystallization_threshold: 3 时，达到 3 即可提前触发升维。
 *
 * 3. 【EVO-4 踩坑双向反证门】踩坑高频复发报警与根因提示
 *    - 正向反证：踩坑 recurrence ≥ 3 时，memory_context 与 middleware 均添加前缀 [高频复发×N] 与行尾建议核查根因。
 *    - 反向反证：踩坑 recurrence < 3 时，严格不出现 [高频复发×N] 与根因提示。
 *    - 配置化覆盖：配置 pitfall_recurrence_threshold: 2 时，recurrence = 2 即可触发报警。
 *
 * 4. 【测试规范元检查与零残留】
 *    - scanTestFile 自检 0 违规，测试结束后 0 残留断言。
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { MagpieMemoryHub } from "../tools.js";
import { onRequest } from "../memory.middleware.js";
import { scanTestFile } from "./test_meta.mjs";
import { createTestEnv } from "./lib/testenv.mjs";

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

const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []);

console.log("=================================================================");
console.log("【v6.36-a EVO-1 与 EVO-4 双向反证验收套件】");
const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

const clearRecords = async () => {
  for (const tbl of ["memories", "pitfalls"]) {
    const rows = rowsOf(await env.client.list(tbl, { project: env.project, limit: 1000 }));
    for (const r of rows) {
      try {
        await env.client.remove(tbl, r.id);
      } catch (err) {
        void err;
      }
    }
  }
};

async function run() {
  try {
    const hub = await MagpieMemoryHub({}, {
      client: env.client,
      ncb_instance: env.instance,
    });
    const memSave = hub.tool["memory_save"];
    const memContext = hub.tool["memory_context"];
    const pitSave = hub.tool["pitfall_save"];

    // =============================================================
    // 1. 【反证门 1】EVO-1 记忆认知智能增量扩充双向反证
    // =============================================================
    console.log("▶ [反证门 1] EVO-1 记忆认知智能增量扩充双向反证...");
    await clearRecords();

    // 1.1 正向用例：简短记忆更新架构细节（新内容长度显著增长 ≥ 1.25 倍，无数字冲突）
    const resShort = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "会话缓存架构",
      content: "使用 Redis 缓存会话数据",
      tags: "redis, cache",
      related_entities: "Redis",
    }, {}));
    assert.strictEqual(resShort.action, "ADD", "初次存入应为 ADD");
    const originalId = resShort.id;

    const longDetailContent = "使用 Redis 缓存会话数据，采用 Redis Cluster 架构实现高可用，配置 3 主 3 从与哨兵监控，TTL 为 30 分钟";
    assert.ok(
      longDetailContent.length >= "使用 Redis 缓存会话数据".length * 1.25,
      "测试样本长度必须满足 >= 1.25 倍阈值"
    );

    const resEnriched = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "会话缓存架构",
      content: longDetailContent,
      content_fingerprint: "fp_enriched_1",
      tags: "cluster, architecture",
      related_entities: "Redis Cluster, Sentinel",
    }, {}));

    // 断言正向增量扩充
    assert.strictEqual(resEnriched.action, "ENRICHED", "显著扩充细节且同标题无冲突必须触发 ENRICHED");
    assert.strictEqual(resEnriched.id, originalId, "ENRICHED 必须保留原记录 ID");
    assert.strictEqual(resEnriched.recurrence, 2, "ENRICHED 必须累加 recurrence 计数");
    assert.strictEqual(resEnriched.revision, 2, "ENRICHED 必须递增 revision 版本号");
    assert.ok(resEnriched.note.includes("智能增量扩充成功"), "note 必须说明智能增量扩充成功");

    // 查询数据库验证内容、标签和实体的融合
    const rows1 = rowsOf(await env.client.list("memories", { project: env.project, id: originalId }));
    assert.strictEqual(rows1.length, 1, "必须仅有一条活跃主记录");
    const m1 = rows1[0];
    assert.strictEqual(m1.content, longDetailContent, "数据库中的 content 必须更新为详尽内容");
    assert.ok(m1.tags.includes("redis") && m1.tags.includes("cluster"), "tags 必须取并集融合");
    assert.ok(m1.related_entities.includes("Redis") && m1.related_entities.includes("Sentinel"), "entities 必须取并集融合");
    console.log("  ✓ 正向通过：显著细节扩充正确触发 ENRICHED，融合原记录与版本递增");

    // 1.2 反向用例 a：信息量无显著增长（< 1.25 倍且无 supersede）必须维持 NOOP
    const resShort2 = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "生产日志规范",
      content: "统一使用 winston 记录生产环境日志",
    }, {}));
    const id2 = resShort2.id;

    // 微小变动，长度增加不足 1.25 倍
    const tinyChangeContent = "统一使用 winston 记录生产环境日志规范";
    assert.ok(
      tinyChangeContent.length < "统一使用 winston 记录生产环境日志".length * 1.25,
      "微小变动长度必须 < 1.25 倍"
    );

    const resNoop = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "生产日志规范",
      content: tinyChangeContent,
      content_fingerprint: "fp_noop_tiny",
    }, {}));

    assert.strictEqual(resNoop.action, "NOOP", "【反证】：信息量无显著增长时必须严格维持 NOOP");
    assert.strictEqual(resNoop.id, id2, "NOOP 必须指向原记录");
    assert.strictEqual(resNoop.recurrence, 2, "NOOP 累加复发计数");

    const rows2 = rowsOf(await env.client.list("memories", { project: env.project, id: id2 }));
    assert.strictEqual(rows2[0].content, "统一使用 winston 记录生产环境日志", "【反证】：NOOP 下数据库正文绝不得被微小修改覆盖");
    console.log("  ✓ 反向 a 通过：信息量无显著增长严格维持 NOOP，内容不被冲掉");

    // 1.3 反向用例 b：数字冲突守卫（存在端口/版本号数字冲突时严禁增量合并）
    const resPort80 = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "服务端口监听配置",
      content: "网关服务默认监听 80 端口",
    }, {}));
    const idPort80 = resPort80.id;

    const resPort8080 = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "服务端口监听配置",
      content: "网关服务默认监听 8080 端口，前端代理使用反向代理转发",
      content_fingerprint: "fp_port_8080",
    }, {}));

    assert.notStrictEqual(resPort8080.action, "ENRICHED", "【反证】：数字冲突 (80 vs 8080) 严禁误判为增量扩充 ENRICHED");
    const rowsPort = rowsOf(await env.client.list("memories", { project: env.project, id: idPort80 }));
    assert.strictEqual(rowsPort[0].content, "网关服务默认监听 80 端口", "【反证】：原 80 端口记录绝不得被 8080 记录覆盖");
    console.log("  ✓ 反向 b 通过：数字冲突守卫生效，不同端口/版本号严禁增量合并");

    // 1.4 显式指示：无数字冲突下显式传 supersede: true 时，即使增长不足 1.25 倍亦必须触发 ENRICHED
    const resPool = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "连接池自适应策略",
      content: "MySQL 连接池配置为自适应弹性分配",
    }, {}));
    const idPool = resPool.id;

    const resExplicitSupersede = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "连接池自适应策略",
      content: "MySQL 连接池配置为自适应弹性动态扩容",
      content_fingerprint: "fp_supersede_pool",
      supersede: true,
    }, {}));

    assert.strictEqual(resExplicitSupersede.action, "ENRICHED", "显式传 supersede: true 必须强制触发增量扩充 ENRICHED");
    assert.strictEqual(resExplicitSupersede.id, idPool, "保留原 ID");
    assert.strictEqual(resExplicitSupersede.revision, 2, "revision 递增");
    console.log("  ✓ 显式指示通过：supersede: true 成功触发 ENRICHED 更新原记录");

    // =============================================================
    // 2. 【反证门 2】EVO-4 高频经验自动升维结晶双向反证
    // =============================================================
    console.log("\n▶ [反证门 2] EVO-4 高频经验自动升维结晶双向反证...");
    await clearRecords();

    // 2.1 正向用例：preference 记忆 recurrence 达到 5 且 confidence >= 80 升维 principle
    const resPref = parseOut(await memSave.execute({
      project: env.project,
      category: "preference",
      title: "代码格式化规范",
      content: "项目中统一使用 Prettier 并在保存时自动格式化",
      content_fingerprint: "fp_pref_1",
      confidence: 90,
    }, {}));
    const prefId = resPref.id;
    assert.strictEqual(resPref.category, "preference", "初始分类应为 preference");

    // 累加 4 次达到 recurrence = 5
    let lastPrefRes;
    for (let i = 2; i <= 5; i++) {
      lastPrefRes = parseOut(await memSave.execute({
        project: env.project,
        category: "preference",
        title: "代码格式化规范",
        content: "项目中统一使用 Prettier 并在保存时自动格式化",
        content_fingerprint: "fp_pref_" + i,
        confidence: 90,
      }, {}));
    }
    assert.strictEqual(lastPrefRes.recurrence, 5, "复发计数应为 5");
    assert.strictEqual(lastPrefRes.category, "principle", "达到阈值且 confidence>=80 必须升维为 principle");
    assert.ok(lastPrefRes.note.includes("已升维为 principle"), "note 必须明确说明「已升维为 principle」");

    // 查询数据库确认为 principle
    const rowsPref = rowsOf(await env.client.list("memories", { project: env.project, id: prefId }));
    assert.strictEqual(rowsPref[0].category, "principle", "数据库中记录的 category 必须更新为 principle");
    console.log("  ✓ 正向通过：preference 记忆 recurrence 达 5 且 confidence=90 成功升维 principle 并写库");

    // 2.2 反向用例 a：未达阈值（recurrence = 4 < 5）必须不触发升维
    const resThresh = parseOut(await memSave.execute({
      project: env.project,
      category: "decision",
      title: "状态管理方案",
      content: "复杂模块统一采用 Zustand 进行全局状态管理",
      content_fingerprint: "fp_thresh_1",
      confidence: 90,
    }, {}));
    const threshId = resThresh.id;

    for (let i = 2; i <= 4; i++) { // 总共 4 次
      lastPrefRes = parseOut(await memSave.execute({
        project: env.project,
        category: "decision",
        title: "状态管理方案",
        content: "复杂模块统一采用 Zustand 进行全局状态管理",
        content_fingerprint: "fp_thresh_" + i,
        confidence: 90,
      }, {}));
    }
    assert.strictEqual(lastPrefRes.recurrence, 4, "复发计数应为 4");
    assert.strictEqual(lastPrefRes.category, "decision", "【反证】：recurrence=4 未达 5 严禁升维");
    assert.ok(!lastPrefRes.note.includes("已升维为 principle"), "【反证】：未升维时 note 绝不得包含升维提示");
    const rowsThresh = rowsOf(await env.client.list("memories", { project: env.project, id: threshId }));
    assert.strictEqual(rowsThresh[0].category, "decision", "数据库中依然保留 decision 分类");
    console.log("  ✓ 反向 a 通过：recurrence=4 未达阈值严格不升维");

    // 2.3 反向用例 b：confidence < 80 即使 recurrence = 5 也绝不升维
    const resLowConf = parseOut(await memSave.execute({
      project: env.project,
      category: "preference",
      title: "编辑器主题偏好",
      content: "暗色主题推荐使用 Tokyo Night",
      content_fingerprint: "fp_lowconf_1",
      confidence: 70, // < 80
    }, {}));
    const lowConfId = resLowConf.id;

    for (let i = 2; i <= 5; i++) {
      lastPrefRes = parseOut(await memSave.execute({
        project: env.project,
        category: "preference",
        title: "编辑器主题偏好",
        content: "暗色主题推荐使用 Tokyo Night",
        content_fingerprint: "fp_lowconf_" + i,
        confidence: 70,
      }, {}));
    }
    assert.strictEqual(lastPrefRes.recurrence, 5, "复发计数达到 5");
    assert.strictEqual(lastPrefRes.category, "preference", "【反证】：confidence=70 < 80 严禁升维为 principle");
    assert.ok(!lastPrefRes.note.includes("已升维为 principle"), "【反证】：低置信度时 note 绝不包含升维提示");
    const rowsLowConf = rowsOf(await env.client.list("memories", { project: env.project, id: lowConfId }));
    assert.strictEqual(rowsLowConf[0].category, "preference", "数据库中保持原 preference 分类");
    console.log("  ✓ 反向 b 通过：confidence=70 低于 80 严格不升维");

    // 2.4 反向用例 c：非 preference / decision 类别（如 fact）即使 recurrence = 5、confidence = 90 也绝不升维
    const resFact = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "Node 运行版本",
      content: "生产容器统一运行在 Node 24 LTS 环境",
      content_fingerprint: "fp_fact_1",
      confidence: 95,
    }, {}));
    const factId = resFact.id;

    for (let i = 2; i <= 5; i++) {
      lastPrefRes = parseOut(await memSave.execute({
        project: env.project,
        category: "fact",
        title: "Node 运行版本",
        content: "生产容器统一运行在 Node 24 LTS 环境",
        content_fingerprint: "fp_fact_" + i,
        confidence: 95,
      }, {}));
    }
    assert.strictEqual(lastPrefRes.recurrence, 5, "复发计数达到 5");
    assert.strictEqual(lastPrefRes.category, "fact", "【反证】：fact 分类非偏好/决策类别，严禁升维为 principle");
    const rowsFact = rowsOf(await env.client.list("memories", { project: env.project, id: factId }));
    assert.strictEqual(rowsFact[0].category, "fact", "数据库保持 fact 分类");
    console.log("  ✓ 反向 c 通过：fact 普通事实类严禁升维为 principle");

    // 2.5 配置化结晶阈值：通过 cfg.crystallization_threshold 自定义提前升维
    const hubCustomCryst = await MagpieMemoryHub({
      crystallization_threshold: 3,
    }, {
      client: env.client,
      ncb_instance: env.instance,
    });
    const memSaveCustom = hubCustomCryst.tool["memory_save"];

    const resCustom = parseOut(await memSaveCustom.execute({
      project: env.project,
      category: "decision",
      title: "微服务通信协议",
      content: "服务间通信统一采用 gRPC 协议",
      content_fingerprint: "fp_grpc_1",
      confidence: 88,
    }, {}));
    const customId = resCustom.id;

    // 累加 2 次达到 recurrence = 3
    for (let i = 2; i <= 3; i++) {
      lastPrefRes = parseOut(await memSaveCustom.execute({
        project: env.project,
        category: "decision",
        title: "微服务通信协议",
        content: "服务间通信统一采用 gRPC 协议",
        content_fingerprint: "fp_grpc_" + i,
        confidence: 88,
      }, {}));
    }
    assert.strictEqual(lastPrefRes.recurrence, 3, "复发计数为 3");
    assert.strictEqual(lastPrefRes.category, "principle", "自定义 crystallization_threshold: 3 命中提前升维");
    assert.ok(lastPrefRes.note.includes("已升维为 principle"), "包含已升维为 principle");
    const rowsCustom = rowsOf(await env.client.list("memories", { project: env.project, id: customId }));
    assert.strictEqual(rowsCustom[0].category, "principle", "数据库已结晶为 principle");
    console.log("  ✓ 自定义配置通过：crystallization_threshold: 3 成功按配置提前触发升维");

    // =============================================================
    // 3. 【反证门 3】EVO-4 踩坑高频复发报警与根因提示双向反证
    // =============================================================
    console.log("\n▶ [反证门 3] EVO-4 踩坑高频复发报警与根因提示双向反证...");
    await clearRecords();

    // 3.1 正向用例：踩坑 recurrence = 3 时，在 memory_context 文本中带有 [高频复发×3] 与行尾提示
    const resPit3 = parseOut(await pitSave.execute({
      project: env.project,
      component: "redis",
      symptom: "Redis 哨兵模式下节点脑裂报错",
      solution: "配置 min-replicas-to-write 2 与超时阈值",
      recurrence: 3,
    }, {}));
    assert.ok(resPit3.id, "踩坑记录存入成功");

    const ctxRes = parseOut(await memContext.execute({
      project: env.project,
      query: "Redis 哨兵 脑裂",
    }, {}));
    const block3 = ctxRes.block;
    console.log("  memory_context 生成文本片段:\n" + block3);

    assert.ok(block3.includes("[高频复发×3]"), "memory_context 踩坑 recurrence=3 必须包含 [高频复发×3]");
    assert.ok(block3.includes("建议核查根因是否已根治"), "memory_context 必须在行尾追加「建议核查根因是否已根治」");
    console.log("  ✓ 正向通过：memory_context 踩坑 recurrence=3 成功注入高频前缀与根因行尾提示");

    // 3.2 memory.middleware.js 中间件注入正向验证
    const mockMwBody = {
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "请排查 Redis 脑裂 报错" }],
    };
    const mockMwCtx = {
      options: {
        project: env.project,
        memories: [
          {
            id: resPit3.id,
            project: env.project,
            category: "pitfall",
            title: "Redis 哨兵模式下节点脑裂报错",
            content: "配置 min-replicas-to-write 2",
            recurrence: 3,
            symptom: "Redis 哨兵模式下节点脑裂报错",
          },
        ],
      },
      state: {},
    };
    const mwRes = onRequest(mockMwBody, mockMwCtx);
    const userText = mwRes.messages[0].content;
    assert.ok(userText.includes("[高频复发×3]"), "中间件注入文本必须包含 [高频复发×3]");
    assert.ok(userText.includes("建议核查根因是否已根治"), "中间件注入文本行尾必须包含「建议核查根因是否已根治」");
    console.log("  ✓ 正向通过：memory.middleware.js 中间件注入成功包含 [高频复发×3] 与根因提示");

    // 3.3 反向用例：踩坑 recurrence = 2（未达阈值）绝不注入高频报警与提示
    await clearRecords();
    const resPit2 = parseOut(await pitSave.execute({
      project: env.project,
      component: "mysql",
      symptom: "MySQL 慢查询锁等待超时",
      solution: "优化复合索引并开启慢查询日志",
      recurrence: 2,
    }, {}));

    const ctxRes2 = parseOut(await memContext.execute({
      project: env.project,
      query: "MySQL 慢查询",
    }, {}));
    const block2 = ctxRes2.block;
    assert.ok(block2.includes("[pitfall/mysql]"), "正常包含踩坑记录");
    assert.ok(!block2.includes("[高频复发"), "【反证】：recurrence=2 严禁包含 [高频复发×N]");
    assert.ok(!block2.includes("建议核查根因是否已根治"), "【反证】：recurrence=2 严禁包含根因提示");
    console.log("  ✓ 反向通过：recurrence=2 未达阈值绝不包含高频复发前缀与根因提示");

    // 3.4 配置化踩坑阈值验证：pitfall_recurrence_threshold = 2
    const ctxResCustomThresh = parseOut(await memContext.execute({
      project: env.project,
      query: "MySQL 慢查询",
      pitfall_recurrence_threshold: 2,
    }, {}));
    assert.ok(ctxResCustomThresh.block.includes("[高频复发×2]"), "配置阈值为 2 时 recurrence=2 成功触发报警");
    assert.ok(ctxResCustomThresh.block.includes("建议核查根因是否已根治"), "配置阈值为 2 时成功追加根因提示");
    console.log("  ✓ 配置化通过：pitfall_recurrence_threshold: 2 成功触发");

    // =============================================================
    // 4. 元规范自检与零残留
    // =============================================================
    console.log("\n▶ [自检] test_meta 规范合规自检与零残留断言...");
    const selfPath = fileURLToPath(import.meta.url);
    const selfCode = fs.readFileSync(selfPath, "utf8");
    const scanRes = scanTestFile(selfPath, selfCode);
    if (scanRes.issues.length > 0) {
      console.error("❌ 本测试存在 test_meta 规范违规:");
      for (const iss of scanRes.issues) console.error("   -", iss);
    }
    assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 100% 符合 test_meta 规范");
    console.log("  ✓ test_meta 自检 0 违规");

  } catch (err) {
    console.error("❌ 测试执行异常:", err);
    throw err;
  } finally {
    console.log(`\n[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "测试结束后数据库必须 0 残留");
    console.log("✅ 【零残留断言通过】：测试数据已彻底清除！");
  }
}

await run();
console.log("=================================================================");
console.log("✅ v6.36-a EVO-1 与 EVO-4 全部反证门 100% 顺利通过！");
console.log("=================================================================");
