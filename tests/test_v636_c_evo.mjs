/**
 * tests/test_v636_c_evo.mjs
 * =================================================================
 * v6.36-c EVO-2/5/6 核心功能专项验收与双向反证测试套件
 *
 * 覆盖 3 大整改项及双向反证矩阵：
 * 1. 【EVO-2 踩坑解法自演进+淘汰】
 *    - 正向反证：新 solution 长度 ≥ 1.3 倍，触发 action: "EVOLVED" 并更新记录；
 *    - 正向反证：新 root_cause 替换占位根因，触发 action: "EVOLVED" 并更新记录；
 *    - 反向反证：无增益时严格维持 action: "NOOP"，仅累加 recurrence，不篡改原记录；
 *    - 踩坑软失效：memoryForget 支持 table: "pitfalls"（写 invalid_at），并在返回体标记 table；
 *    - 隔离反证：软失效 pitfalls 绝不污染或误伤 memories 表。
 * 2. 【EVO-5 注入摘要带 #id 句柄与跨表 memory_get】
 *    - 上下文句柄：memoryContext 每个输出行包含 - [category#id] 格式；
 *    - 块尾提示：注入条数 > 0 时块尾包含（摘要已截断，可用 memory_get(id=…) 看全文）；
 *    - 跨表读取：memoryGet 支持 table: "pitfalls" 提取踩坑全文；
 *    - 批量读取：memoryGet 支持 ids: [..] 批量读取返回数组；
 *    - 兼容断言：单值 id: .. 调用完全兼容返回单条对象。
 * 3. 【EVO-6 工具入口零摩擦参数容错】
 *    - 同义参数映射：error/issue -> symptom, fix/resolve -> solution, name/topic -> title, text/body -> content, q/keyword -> query；
 *    - 数组类型容错：tags 与 related_entities 传入 Array 自动 join(",")，传入 string 保持；
 *    - 项目名称继承：args.project 缺省时继承非 global 的 cfg.project；
 *    - 语义不变性反证：已有正确参数优先级最高，绝不被同义参数改写。
 * 4. 【test_meta 规范元检查自证】
 *    - 独立命名空间隔离、强制 cleanup、residue.total === 0 断言、scanTestFile 自检 0 违规。
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

const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []);

console.log("=================================================================");
console.log("【v6.36-c EVO-2/5/6 核心功能专项验收与双向反证测试套件】");
const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

async function run() {
  try {
    const hub = await MagpieMemoryHub({}, { client: env.client, ncb_instance: env.instance });

    // =================================================================
    // 1. 【EVO-2】踩坑解法自演进 (EVOLVED vs NOOP) 双向反证
    // =================================================================
    console.log("▶ [Test 1] EVO-2 踩坑解法自演进 (EVOLVED vs NOOP) 双向反证...");

    // 1.1 正向反证 A：新 solution 更详尽（长度 ≥ 1.3 倍）触发 EVOLVED
    const pit1Init = parseOut(await hub.tool["pitfall_save"].execute({
      project: env.project,
      symptom: "TypeError: Cannot read property of undefined in AuthModule",
      solution: "临时规避：重启服务", // 长度 9
    }));
    assert.strictEqual(pit1Init.action, "ADD", "初次写入踩坑必须为 ADD");
    const pit1Id = pit1Init.id;

    // 再次存入同 symptom，解法增长为 38 字 (38 >= 9 * 1.3 = 11.7)
    const betterSolution = "根治方案：在 AuthModule 中增加空值守护并对 options 默认赋空对象，彻底避免 undefined 属性访问异常";
    const pit1Evolve = parseOut(await hub.tool["pitfall_save"].execute({
      project: env.project,
      symptom: "TypeError: Cannot read property of undefined in AuthModule",
      solution: betterSolution,
    }));

    assert.strictEqual(
      pit1Evolve.action,
      "EVOLVED",
      "【反证门 1.1 通过】：解法显著详尽时，必须触发 action: 'EVOLVED'！"
    );
    assert.strictEqual(pit1Evolve.id, pit1Id, "EVOLVED 必须更新既有原记录 ID");
    assert.strictEqual(pit1Evolve.recurrence, 2, "EVOLVED 必须累加 recurrence 计数");
    assert.ok(pit1Evolve.reason.includes("解法更详尽"), "EVOLVED 返回说明必须指出解法更详尽");

    // 验证库中记录已被真实更新
    const checkPit1 = rowsOf(await env.client.list("pitfalls", { id: pit1Id, limit: 1 }))[0];
    assert.strictEqual(checkPit1.solution, betterSolution, "库中 solution 必须已更新为详尽新方案");
    assert.strictEqual(Number(checkPit1.recurrence), 2, "库中 recurrence 必须为 2");
    console.log("  ✓ 1.1 解法更详尽自演进 (EVOLVED) 验证通过！");

    // 1.2 正向反证 B：新 root_cause 替换占位根因触发 EVOLVED
    const pit2Init = parseOut(await hub.tool["pitfall_save"].execute({
      project: env.project,
      symptom: "ECONNRESET on redis pool",
      root_cause: "临时待查未知根因", // 占位根因
      solution: "重试连接",
    }));
    const pit2Id = pit2Init.id;

    // 再次存入同 symptom，solution 长度不增加，但替换为真实根因
    const realRootCause = "Redis 服务端 timeout 设置为 30s，空闲连接被静默关闭，客户端池未开启保活探针";
    const pit2Evolve = parseOut(await hub.tool["pitfall_save"].execute({
      project: env.project,
      symptom: "ECONNRESET on redis pool",
      root_cause: realRootCause,
      solution: "重试连接",
    }));

    assert.strictEqual(
      pit2Evolve.action,
      "EVOLVED",
      "【反证门 1.2 通过】：替换占位根因为真实根因时，必须触发 action: 'EVOLVED'！"
    );
    assert.strictEqual(pit2Evolve.id, pit2Id, "EVOLVED 必须更新原记录 ID");
    assert.ok(pit2Evolve.reason.includes("根因替换占位"), "说明必须包含根因替换占位原因");

    const checkPit2 = rowsOf(await env.client.list("pitfalls", { id: pit2Id, limit: 1 }))[0];
    assert.strictEqual(checkPit2.root_cause, realRootCause, "库中 root_cause 必须更新为真实根因");
    console.log("  ✓ 1.2 替换占位根自演进 (EVOLVED) 验证通过！");

    // 1.3 反向反证 C：无增益时严格维持 NOOP
    const pit3Init = parseOut(await hub.tool["pitfall_save"].execute({
      project: env.project,
      symptom: "Port 9090 already in use",
      root_cause: "既有进程未杀",
      solution: "killall node",
    }));
    const pit3Id = pit3Init.id;

    // 再次存入完全相同内容（无更长方案，无根因演进）
    const pit3Noop = parseOut(await hub.tool["pitfall_save"].execute({
      project: env.project,
      symptom: "Port 9090 already in use",
      root_cause: "既有进程未杀",
      solution: "killall node",
    }));

    assert.strictEqual(
      pit3Noop.action,
      "NOOP",
      "【反证门 1.3 通过】：方案未增长且根因无演进时，必须严格维持 action: 'NOOP'！"
    );
    assert.strictEqual(pit3Noop.id, pit3Id, "NOOP 返回相同记录 ID");
    assert.strictEqual(pit3Noop.recurrence, 2, "NOOP 累加复发计数");

    const checkPit3 = rowsOf(await env.client.list("pitfalls", { id: pit3Id, limit: 1 }))[0];
    assert.strictEqual(checkPit3.solution, "killall node", "方案保持不变");
    assert.strictEqual(checkPit3.root_cause, "既有进程未杀", "根因保持不变");
    console.log("  ✓ 1.3 无增益严格维持 NOOP 验证通过！\n");

    // =================================================================
    // 2. 【EVO-2】踩坑软失效与隔离反证 (memoryForget table: "pitfalls")
    // =================================================================
    console.log("▶ [Test 2] EVO-2 memoryForget 跨表软失效与双向隔离测试...");

    // 2.1 软失效踩坑记录
    const pitToForget = parseOut(await hub.tool["pitfall_save"].execute({
      project: env.project,
      symptom: "Webpack 4 chunk load error",
      solution: "降级 plugin",
    }));

    // 软失效该踩坑
    const forgetPitRes = parseOut(await hub.tool["memory_forget"].execute({
      id: pitToForget.id,
      table: "pitfalls",
    }));

    assert.strictEqual(forgetPitRes.action, "SOFT_DELETE", "软失效必须返回 SOFT_DELETE");
    assert.strictEqual(forgetPitRes.table, "pitfalls", "返回体中必须标明 table: 'pitfalls'");
    assert.strictEqual(forgetPitRes.forgotten, 1, "失效条数必须为 1");

    // 查库断言：写了 invalid_at，未物理删除
    const rawPit = rowsOf(await env.client.list("pitfalls", { id: pitToForget.id, limit: 1 }))[0];
    assert.ok(rawPit.invalid_at != null, "pitfall 必须已写入 invalid_at");
    assert.strictEqual(rawPit.invalid_reason, "user_forgot", "invalid_reason 必须为 user_forgot");

    // 检索断言：软失效后不再被 pitfall_search 召回
    const pitSearchCheck = parseOut(await hub.tool["pitfall_search"].execute({
      project: env.project,
      query: "Webpack 4 chunk",
    }));
    assert.strictEqual(pitSearchCheck.matched, 0, "软失效踩坑记录绝不能被检索召回");

    // 2.2 隔离反证：软失效 pitfalls 绝不误伤 memories 表
    const memSafe = parseOut(await hub.tool["memory_save"].execute({
      project: env.project,
      title: "Webpack 4 chunk 架构迁移背景",
      content: "保留历史背景供参考",
    }));

    // 再次按关键词软失效 pitfalls 表，确保不会波及 memories
    await hub.tool["memory_forget"].execute({
      query: "Webpack 4 chunk",
      table: "pitfalls",
    });

    const checkMemSafe = rowsOf(await env.client.list("memories", { id: memSafe.id, limit: 1 }))[0];
    assert.strictEqual(
      checkMemSafe.invalid_at,
      null,
      "【反证门 2.2 通过】：针对 pitfalls 表的软失效绝不能误伤 memories 表记录！"
    );
    assert.strictEqual(checkMemSafe.lifecycle_status, "active", "memory 状态必须保持 active");
    console.log("  ✓ 2.1 & 2.2 踩坑软失效与跨表隔离验证通过！\n");

    // =================================================================
    // 3. 【EVO-5】注入摘要带 #id 句柄与跨表 memory_get
    // =================================================================
    console.log("▶ [Test 3] EVO-5 注入摘要带 #id 句柄与截断提示...");

    // 写入准则、踩坑、事实记忆各一条
    const prRes = parseOut(await hub.tool["memory_save"].execute({
      project: env.project,
      category: "principle",
      title: "EVO 研发核心原则",
      content: "所有模块必须具备自动化反证测试保障",
    }));
    const pitCtxRes = parseOut(await hub.tool["pitfall_save"].execute({
      project: env.project,
      component: "gateway",
      symptom: "EVO 任务 context token overflow 报错",
      solution: "配置 max_chars 截断与精简投影",
    }));
    const factRes = parseOut(await hub.tool["memory_save"].execute({
      project: env.project,
      category: "fact",
      title: "EVO 测试端口配置",
      content: "测试环境独立监听 9091",
    }));

    // 调用 memory_context 召回
    const ctxRes = parseOut(await hub.tool["memory_context"].execute({
      project: env.project,
      query: "EVO token 报错 与 端口",
    }));

    const blockText = ctxRes.block;
    console.log("  [EVO-5 memory_context 生成的一站式 block]:\n" + blockText + "\n");

    // 3.1 断言每一行带 #id 句柄
    assert.ok(
      blockText.includes(`- [principle#${prRes.id}]`),
      `【反证门 3.1 通过】：准则行必须包含 - [principle#${prRes.id}] 句柄！`
    );
    assert.ok(
      blockText.includes(`- [pitfall/gateway#${pitCtxRes.id}]`),
      `【反证门 3.1 通过】：避坑行必须包含 - [pitfall/gateway#${pitCtxRes.id}] 句柄！`
    );
    assert.ok(
      blockText.includes(`- [fact#${factRes.id}]`),
      `【反证门 3.1 通过】：事实记忆行必须包含 - [fact#${factRes.id}] 句柄！`
    );

    // 3.2 块尾提示断言
    assert.ok(
      blockText.includes("（摘要已截断，可用 memory_get(id=…) 看全文）"),
      "【反证门 3.2 通过】：上下文块尾必须包含全文查看引导提示行！"
    );

    // 3.3 反向断言：空 project 召回时 injected===0 且不输出多余提示行
    const emptyCtxRes = parseOut(await hub.tool["memory_context"].execute({
      project: "__completely_non_existent_project__",
      query: "impossible_query_xyz",
    }));
    assert.strictEqual(emptyCtxRes.injected, 0, "空召回应 injected=0");
    assert.strictEqual(emptyCtxRes.block, "", "空召回 block 必须为空字符串，不得悬挂提示");
    console.log("  ✓ 3. 上下文 #id 句柄与引导提示验证通过！\n");

    // =================================================================
    // 4. 【EVO-5】memoryGet 跨表读取与批量读取
    // =================================================================
    console.log("▶ [Test 4] EVO-5 memoryGet 跨表与批量读取测试...");

    // 4.1 跨表读取 pitfalls
    const getPitfall = parseOut(await hub.tool["memory_get"].execute({
      id: pitCtxRes.id,
      table: "pitfalls",
    }));
    assert.strictEqual(getPitfall.id, pitCtxRes.id, "必须成功读取踩坑 ID");
    assert.strictEqual(getPitfall.table, "pitfalls", "返回体 table 必须为 pitfalls");
    assert.ok(getPitfall.full_text.includes("context token overflow"), "full_text 必须包含完整故障与解法");
    assert.ok(getPitfall.solution.includes("配置 max_chars"), "solution 必须完整返回");

    // 4.2 批量读取 memories (ids: [...]) 返回数组
    const batchMems = parseOut(await hub.tool["memory_get"].execute({
      ids: [prRes.id, factRes.id],
      table: "memories",
    }));
    assert.ok(Array.isArray(batchMems), "【反证门 4.2 通过】：ids 批量调用必须返回数组！");
    assert.strictEqual(batchMems.length, 2, "批量返回条数必须为 2");
    const gotIds = batchMems.map((m) => m.id);
    assert.ok(gotIds.includes(prRes.id), "批量结果必须包含准则 ID");
    assert.ok(gotIds.includes(factRes.id), "批量结果必须包含事实 ID");

    // 4.3 批量读取 pitfalls (ids: [...])
    const batchPits = parseOut(await hub.tool["memory_get"].execute({
      ids: [pit1Id, pitCtxRes.id],
      table: "pitfalls",
    }));
    assert.ok(Array.isArray(batchPits), "批量踩坑调用必须返回数组");
    assert.strictEqual(batchPits.length, 2, "批量踩坑返回 2 条");

    // 4.4 单值 id 兼容性验证
    const singleMem = parseOut(await hub.tool["memory_get"].execute({
      id: prRes.id,
    }));
    assert.ok(!Array.isArray(singleMem), "单值 id 调用必须保持返回单一对象兼容性");
    assert.strictEqual(singleMem.id, prRes.id, "单值 id 必须精确对应");
    assert.strictEqual(singleMem.title, "EVO 研发核心原则", "单值 title 必须正确");
    console.log("  ✓ 4. memoryGet 跨表与批量读取验证通过！\n");

    // =================================================================
    // 5. 【EVO-6】工具入口零摩擦参数容错 (normalizeToolArgs)
    // =================================================================
    console.log("▶ [Test 5] EVO-6 工具入口零摩擦参数容错测试...");

    // 5.1 pitfall_save 同义参数映射 (error -> symptom, fix -> solution)
    const synonymPit = parseOut(await hub.tool["pitfall_save"].execute({
      project: env.project,
      error: "Synonym Test Error Message",
      fix: "Synonym Test Fix Procedure",
      tags: ["alpha", "beta", "gamma"], // 数组 tags 容错
    }));
    assert.strictEqual(synonymPit.action, "ADD", "同义参数调用 pitfall_save 必须成功保存");
    const checkSynonymPit = rowsOf(await env.client.list("pitfalls", { id: synonymPit.id, limit: 1 }))[0];
    assert.strictEqual(checkSynonymPit.symptom, "Synonym Test Error Message", "error 必须映射到 symptom");
    assert.strictEqual(checkSynonymPit.solution, "Synonym Test Fix Procedure", "fix 必须映射到 solution");
    assert.strictEqual(checkSynonymPit.tags, "alpha,beta,gamma", "数组 tags 必须自动 join 为逗号分隔");

    // 5.2 memory_save 同义参数映射 (name -> title, text -> content, related_entities 数组)
    const synonymMem = parseOut(await hub.tool["memory_save"].execute({
      project: env.project,
      name: "Synonym Memory Title",
      text: "Synonym Memory Content Body",
      related_entities: ["Node.js", "TypeScript", "V8"],
    }));
    assert.strictEqual(synonymMem.action, "ADD", "同义参数调用 memory_save 必须成功保存");
    const checkSynonymMem = rowsOf(await env.client.list("memories", { id: synonymMem.id, limit: 1 }))[0];
    assert.strictEqual(checkSynonymMem.title, "Synonym Memory Title", "name 必须映射到 title");
    assert.strictEqual(checkSynonymMem.content, "Synonym Memory Content Body", "text 必须映射到 content");
    assert.strictEqual(checkSynonymMem.related_entities, "Node.js,TypeScript,V8", "数组 related_entities 必须 join");

    // 5.3 memory_search 同义参数 (q -> query)
    const searchQRes = parseOut(await hub.tool["memory_search"].execute({
      project: env.project,
      q: "Synonym Memory",
    }));
    assert.ok(searchQRes.matched >= 1, "q 参数必须映射到 query 正常检索召回");

    // 5.4 project 缺省时智能继承 cfg.project (仅非 global 时继承)
    const customProj = "my_custom_subproject_123";
    const normProjTest1 = MagpieMemoryHub.normalizeToolArgs(
      { name: "Doc", text: "Some text" },
      { project: customProj }
    );
    assert.strictEqual(normProjTest1.project, customProj, "【反证门 5.4a 通过】：缺省 project 必须继承非 global 的 cfg.project！");

    const normProjTest2 = MagpieMemoryHub.normalizeToolArgs(
      { name: "Doc", text: "Some text" },
      { project: "global" }
    );
    assert.strictEqual(normProjTest2.project, "global", "【反证门 5.4b 通过】：cfg.project 为 global 时保持 global");

    // 5.5 语义不变性反证：已有正确参数绝不被同义参数覆盖
    const normSemantics = MagpieMemoryHub.normalizeToolArgs(
      {
        title: "Original Standard Title",
        name: "Conflicting Name",
        symptom: "Original Symptom",
        error: "Conflicting Error",
        solution: "Original Solution",
        fix: "Conflicting Fix",
        query: "Original Query",
        q: "Conflicting Q",
        content: "Original Content",
        text: "Conflicting Text",
        tags: "already,joined,tags",
      },
      { project: "ignored_cfg_project" }
    );
    assert.strictEqual(normSemantics.title, "Original Standard Title", "title 绝不能被 name 覆盖");
    assert.strictEqual(normSemantics.symptom, "Original Symptom", "symptom 绝不能被 error 覆盖");
    assert.strictEqual(normSemantics.solution, "Original Solution", "solution 绝不能被 fix 覆盖");
    assert.strictEqual(normSemantics.query, "Original Query", "query 绝不能被 q 覆盖");
    assert.strictEqual(normSemantics.content, "Original Content", "content 绝不能被 text 覆盖");
    assert.strictEqual(normSemantics.tags, "already,joined,tags", "字符串 tags 必须原样保持");
    console.log("  ✓ 5. 入参零摩擦容错与语义不变性验证通过！\n");

    // =================================================================
    // 6. 【元检查自检】test_meta 规范元检查自证
    // =================================================================
    console.log("▶ [Test 6] test_meta 规范合规性自检...");
    const selfPath = fileURLToPath(import.meta.url);
    const rawContent = fs.readFileSync(selfPath, "utf8");
    const scanRes = scanTestFile(selfPath, rawContent);
    if (scanRes.issues.length > 0) {
      for (const is of scanRes.issues) {
        console.error("   -", is);
      }
    }
    assert.strictEqual(
      scanRes.issues.length,
      0,
      `【反证门 6 通过】：本测试文件自身必须 100% 符合 test_meta 测试规范！发现 ${scanRes.issues.length} 处违规`
    );
    console.log("  ✓ 本测试文件经 test_meta 扫描，0 规范违规！\n");

  } finally {
    console.log("[CLEANUP] 开始清理隔离命名空间...");
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "【零残留断言通过】：测试后数据库残留必须为 0！");
    console.log("✅ 零残留断言通过，测试命名空间已彻底清理干净\n");
  }
}

await run();

console.log("=================================================================");
console.log("🎉 全部 EVO-2/5/6 双向反证门与元检查自检 100% 成功通过！");
console.log("=================================================================");
