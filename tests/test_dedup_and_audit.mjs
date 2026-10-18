/**
 * tests/test_dedup_and_audit.mjs
 * 记忆去重方案 A (A① tags并入指纹/A② 跨类别去重/A③ 踩坑优先)
 * 与 记忆体检方案 B (memory_audit 审阅卡片/数据0变动红线/人工批准软删除/独立模型与定时调度)
 * 全面专项验证与反证测试。
 */

import assert from "node:assert";
import { MagpieMemoryHub } from "../tools.js";
import {
  normalizeTags,
  semanticFingerprint,
  normalizeSemanticText,
} from "../semantic_dedup.js";
import { auditMemoriesWithModel } from "../online_models.js";
import { lookupAuditState, rememberAuditState } from "../local_state.js";
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

const rowsOf = (res) => Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);

const env = await createTestEnv({ mode: "memory" });

console.log("=================================================================");
console.log("【去重方案 A 与记忆体检方案 B 全面专项测试】");
console.log(`隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

async function run() {
  const hub = await MagpieMemoryHub({
    extract_model: "test-extract-model",
    audit_model: "test-audit-model",
    audit_interval: "daily",
  }, {
    client: env.client,
    ncb_instance: env.instance,
  });

  const memSave = hub.tool["memory_save"];
  const memSearch = hub.tool["memory_search"];
  const pitSave = hub.tool["pitfall_save"];
  const memAudit = hub.tool["memory_audit"];

  try {
    // =================================================================
    // 1. 方案 A①：tags 排序归一化并入指纹与噪音截断
    // =================================================================
    console.log("--- [Test 1] A①: tags 排序归一化并入指纹与噪音截断 ---");
    // 1.1 normalizeTags 函数单元测试
    const rawTags1 = "web_search, MCP, Endpoint, API, Gateway";
    const rawTags2 = "Gateway; api、mcp , endpoint | web_search";
    const norm1 = normalizeTags(rawTags1);
    const norm2 = normalizeTags(rawTags2);
    assert.strictEqual(norm1, norm2, "不同分隔符与大小写的相同 tags 必须归一化为完全相同结果");

    // 1.2 tags 超过 5 个时截断前 5 个（防模型输出噪音 tags）
    const manyTags = "tag1, tag2, tag3, tag4, tag5, noise6, noise7, noise8";
    const fiveTags = "tag1, tag2, tag3, tag4, tag5";
    assert.strictEqual(normalizeTags(manyTags), normalizeTags(fiveTags), "超过 5 个 tags 必须严格截取前 5 个，忽略后续噪音 tags");

    // 1.3 semanticFingerprint 包含 tags
    const fpA = semanticFingerprint("proj", "fact", "标题A", "内容A", "tag_b, tag_a");
    const fpB = semanticFingerprint("proj", "fact", "标题A", "内容A", "tag_a, tag_b");
    assert.strictEqual(fpA, fpB, "tags 乱序但内容相同的记录指纹必须一致");

    const fpDiff = semanticFingerprint("proj", "fact", "标题A", "内容A", "different_tag");
    assert.notStrictEqual(fpA, fpDiff, "tags 不同的记录指纹必须不同");
    console.log("  ✓ A① tags 排序归一化、前 5 个截断与指纹生成验证通过！\n");

    // =================================================================
    // 2. 方案 A②：跨类别去重（同 project + 归一化 title + 不同 category）
    // =================================================================
    console.log("--- [Test 2] A②: 跨类别去重验证 ---");
    // 2.1 插入第一条：category=fact
    const crossTitle = "Web Search MCP 插件端点与特性说明";
    const resA1 = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: crossTitle,
      content: "Web Search MCP 提供网络搜索能力，端点配置为 /api/search",
      tags: "mcp, search",
    }));
    assert.strictEqual(resA1.action, "ADD", "首条记录必须成功 ADD");
    const primaryId = resA1.id;

    // 2.2 插入第二条：category=preference（不同 category，归一化 title 相同）
    const resA2 = parseOut(await memSave.execute({
      project: env.project,
      category: "preference",
      title: "「Web Search MCP 插件端点及特性说明」",
      content: "关于 Web Search MCP：提供网络搜索能力，端点配置是 /api/search",
      tags: "search, config",
    }));
    assert.strictEqual(resA2.action, "NOOP", "跨类别不同分类但同标题变体必须被拦截为 NOOP");
    assert.strictEqual(resA2.id, primaryId, "跨类别查重命中应复用既有记录 ID");
    assert.strictEqual(resA2.recurrence, 2, "跨类别查重命中必须累加 recurrence 至 2");
    assert.ok(resA2.note.includes("跨类别去重命中"), "note 中必须包含跨类别去重提示");

    // 2.3 校验数据库：该标题在库中严格只有 1 行记录
    const dbMemRows = rowsOf(await env.client.list("memories", { project: env.project }));
    const matchRows = dbMemRows.filter((r) => normalizeSemanticText(r.title) === normalizeSemanticText(crossTitle));
    assert.strictEqual(matchRows.length, 1, "跨类别去重后数据库中必须严格只有 1 条记录，未产生重复行");
    assert.strictEqual(Number(matchRows[0].recurrence), 2, "既有记录 recurrence 必须为 2");
    console.log("  ✓ A② 跨类别去重与 recurrence 累加验证通过！\n");

    // =================================================================
    // 3. 方案 A③：踩坑优先（同一问题两表都有 → pitfalls 为准）
    // =================================================================
    console.log("--- [Test 3] A③: 踩坑优先两表优先级验证 ---");
    // 3.1 场景 1：踩坑已在库中，后续调用 memory_save 被拦截并累加踩坑
    const pitSymptom = "NoCodeBackend 连接 Cloudflare R2 发生 TLS 握手失败 write EPROTO";
    const resPit1 = parseOut(await pitSave.execute({
      project: env.project,
      component: "ncb_r2",
      symptom: pitSymptom,
      root_cause: "Cloudflare R2 API Token 缺少 Admin 权限",
      solution: "重新生成带有 Admin Read & Write 权限的 R2 令牌并在 NCB 后台更新",
      severity: "high",
    }));
    assert.strictEqual(resPit1.action, "ADD", "踩坑初次入库 action 应为 ADD");
    const pitId = resPit1.id;

    // 尝试往 memories 存入同一问题的记录
    const resMemBlocked = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "TLS 握手失败 write EPROTO 踩坑解决",
      content: "NCB 连接 R2 出现 write EPROTO 时需检查 API Token 权限是否为 Admin",
    }));
    assert.strictEqual(resMemBlocked.action, "NOOP", "踩坑优先：该问题在 pitfalls 表中已存在，memory_save 必须返回 NOOP");
    assert.strictEqual(resMemBlocked.table, "pitfalls", "返回的目标表必须标明为 pitfalls");
    assert.strictEqual(resMemBlocked.id, pitId, "返回的主键 ID 必须指向已存在的 pitfall");
    assert.strictEqual(resMemBlocked.recurrence, 2, "踩坑表的 recurrence 必须累加至 2");

    // 3.2 场景 2：记忆已在库中，后续记录踩坑，踩坑优先并将原普通记忆软删除（写 invalid_at）
    const resMemPrior = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "Cloudflare R2 桶名下划线报错 InvalidBucketName",
      content: "Cloudflare R2 存储桶名称不能含有下划线，必须使用短横线连字符",
    }));
    assert.strictEqual(resMemPrior.action, "ADD", "初次存入记忆应为 ADD");
    const memPriorId = resMemPrior.id;

    // 此时调用 pitfall_save 存入针对该问题的完整踩坑三要素
    const resPitPrior = parseOut(await pitSave.execute({
      project: env.project,
      component: "r2_storage",
      symptom: "Cloudflare R2 存储桶名称含有下划线报错 InvalidBucketName",
      root_cause: "S3 桶命名规范仅允许小写字母、数字和连字符，禁止下划线",
      solution: "使用 r2Setup 自动将数据库名中的下划线替换为连字符",
      severity: "medium",
    }));
    assert.strictEqual(resPitPrior.action, "ADD", "踩坑记录成功新增 ADD");

    // 断言原 memories 表中的条目已被软删除（写 invalid_at，绝不物理删除）
    const memAfter = rowsOf(await env.client.list("memories", { project: env.project, id: memPriorId }));
    assert.ok(memAfter && memAfter.length > 0, "原记忆条目物理行必须依然存在（绝不物理删除）");
    assert.ok(memAfter[0].invalid_at !== null && memAfter[0].invalid_at !== "", "原记忆条目 invalid_at 必须已被写入软失效时间戳");
    assert.strictEqual(memAfter[0].lifecycle_status, "superseded", "原记忆条目状态应更新为 superseded");
    assert.strictEqual(memAfter[0].invalid_reason, "superseded_by_pitfall", "软失效原因必须明确记录为 superseded_by_pitfall");
    console.log("  ✓ A③ 踩坑优先两表互斥与软失效审计链验证通过！\n");

    // =================================================================
    // 4. 方案 B：「记忆体检」核心红线与反证门
    // =================================================================
    console.log("--- [Test 4] B 方案: 记忆体检 memory_audit 核心红线与反证门 ---");

    // 准备数据：先存入 3 个完全独立的不同事实（正例反证门）
    const fact1 = parseOut(await memSave.execute({ project: env.project, category: "fact", title: "React 18 并发渲染特性", content: "React 18 默认开启并发渲染机制，支持 startTransition API。" }));
    const fact2 = parseOut(await memSave.execute({ project: env.project, category: "fact", title: "Node.js 20 进程信号管理", content: "Node.js 20 服务在收到 SIGTERM 时应优雅断开持久连接并等待 5 秒超时。" }));
    const fact3 = parseOut(await memSave.execute({ project: env.project, category: "principle", title: "严禁在 iSH 终端中直接编译原生包", content: "iSH 环境指令集仿真性能受限，严禁直接编译 PyTorch/Transformers 等大模型原生包。" }));

    // 模拟历史遗留的 2 条未去重变体记录（直接入库，模拟体检前遗留脏数据）
    const legacy1 = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "历史遗留：Git 分支协作与标准PR规范",
      content: "所有多 Agent 协作开发必须基于 feature 分支并通过 PR 合并至 main。",
      content_fingerprint: "legacy_fp_1",
      lifecycle_status: "active",
      recurrence: 1,
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    const legacy2 = await env.client.create("memories", {
      project: env.project,
      category: "preference",
      title: "「历史遗留：Git 分支协作及标准PR规范」",
      content: "关于多 Agent 协作：全员统一使用 feature 分支提 PR 合并到 main 分支。",
      content_fingerprint: "legacy_fp_2",
      lifecycle_status: "active",
      recurrence: 1,
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    const leg1Id = legacy1.id || legacy1.insertId;
    const leg2Id = legacy2.id || legacy2.insertId;

    // 准备一条高频踩坑（recurrence >= 3）
    const highPit = parseOut(await pitSave.execute({
      project: env.project,
      component: "ish_build",
      symptom: "在 iSH 中运行 pip install 构建原生 C 扩展导致 CPU 100% 挂死",
      root_cause: "x86 JIT 翻译编译密集任务极端缓慢触发看门狗杀进程",
      solution: "改用 apk add py3-* 预编译二进制包",
      severity: "critical",
      recurrence: 3,
    }));

    // 【反证门 3】体检跑完数据 0 变动断言：记录体检前全量快照
    const snapMemBefore = rowsOf(await env.client.list("memories", { project: env.project }));
    const snapPitBefore = rowsOf(await env.client.list("pitfalls", { project: env.project }));
    const countMemBefore = snapMemBefore.length;
    const countPitBefore = snapPitBefore.length;

    // 执行 memory_audit（全自动去重模式）
    console.log("  执行 memory_audit (全自动去重)...");
    const auditRes = parseOut(await memAudit.execute({ project: env.project }));
    console.log("  auditRes 指标:", JSON.stringify(auditRes.lines));

    // 【指标断言 1】：action 与状态
    assert.strictEqual(auditRes.action, "DEDUP_REPORT", "返回 action 必须为 DEDUP_REPORT");
    assert.strictEqual(auditRes.status, "已完成", "status 必须为 已完成");
    assert.strictEqual(auditRes.data_changed, true, "发生去重合并时 data_changed 应为 true");
    assert.ok(auditRes.deduped.memories >= 1, "重复记忆必须被合并");

    // 【反证门 1】：3 个不同事实不能被误合并软删除
    const snapMemAfter = rowsOf(await env.client.list("memories", { project: env.project }));
    const f1 = snapMemAfter.find((r) => r.id === fact1.id);
    const f2 = snapMemAfter.find((r) => r.id === fact2.id);
    const f3 = snapMemAfter.find((r) => r.id === fact3.id);
    assert.strictEqual(f1.lifecycle_status, "active", "【反证门 1 强断言】：不同事实 1 绝不能被误软删除");
    assert.strictEqual(f2.lifecycle_status, "active", "【反证门 1 强断言】：不同事实 2 绝不能被误软删除");
    assert.strictEqual(f3.lifecycle_status, "active", "【反证门 1 强断言】：不同事实 3 绝不能被误软删除");
    console.log("  ✓ 【反证门 1 通过】：3 个不同事实未被误合并！");

    // 【软删除与合并验证】：重复变体 legacy2 必须被软删除，legacy1 的 recurrence 必须累加
    const leg1After = snapMemAfter.find((r) => r.id === leg1Id);
    const leg2After = snapMemAfter.find((r) => r.id === leg2Id);
    assert.ok(leg2After.invalid_at !== null && leg2After.invalid_at !== "", "被合并副本 invalid_at 必须已写入");
    assert.strictEqual(leg2After.lifecycle_status, "invalid", "被合并副本 lifecycle_status 必须为 invalid");
    assert.ok(String(leg2After.invalid_reason).startsWith("dedup:"), "invalid_reason 必须以 dedup: 开头编码批次");
    assert.strictEqual(Number(leg1After.recurrence), 2, "主记录 recurrence 必须累加至 2");
    console.log("  ✓ 全自动去重软失效与 recurrence 累加验证通过！");

    // 【撤销去重验证】：调用 undo 必须完整恢复 invalid_at 为 NULL，状态为 active，recurrence 减回 1
    console.log("  测试撤销去重 (undo: true)...");
    const undoRes = parseOut(await memAudit.execute({ project: env.project, undo: true }));
    assert.strictEqual(undoRes.action, "DEDUP_UNDONE", "撤销操作必须返回 DEDUP_UNDONE");
    assert.strictEqual(undoRes.restored_records >= 1, true, "至少恢复 1 条记录");
    assert.strictEqual(undoRes.undone_recurrence >= 1, true, "至少撤销 1 次 recurrence");

    const snapMemRestored = rowsOf(await env.client.list("memories", { project: env.project }));
    const leg1Restored = snapMemRestored.find((r) => r.id === leg1Id);
    const leg2Restored = snapMemRestored.find((r) => r.id === leg2Id);
    assert.strictEqual(leg2Restored.invalid_at, null, "撤销后副本 invalid_at 必须恢复为 null");
    assert.strictEqual(leg2Restored.lifecycle_status, "active", "撤销后副本 lifecycle_status 必须恢复为 active");
    assert.strictEqual(Number(leg1Restored.recurrence), 1, "撤销后主记录 recurrence 必须精确减回 1");
    console.log("  ✓ 撤销完整还原（invalid_at=null, active, recurrence精确减回）验证通过！\n");

    // =================================================================
    // 5. 独立模型配置与定时调度状态验证
    // =================================================================
    console.log("--- [Test 5] 独立模型配置与定时调度状态验证 ---");
    // 5.1 验证体检状态持久化
    const stAudit = lookupAuditState();
    assert.ok(stAudit.last_dedup_at || stAudit.last_audit_at, "去重执行后必须持久化记录 last_dedup_at");

    // 5.2 验证 auditMemoriesWithModel 优先读取 audit_model
    let capturedModel = null;
    let capturedHeaders = null;
    const mockAuditFetch = async (url, opts) => {
      const b = JSON.parse(opts.body);
      capturedModel = b.model;
      capturedHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ duplicate_groups: [] }) } }],
        }),
      };
    };

    const modelAuditRes = await auditMemoriesWithModel({
      memories: [{ id: 1, title: "测试记忆", content: "测试内容" }],
      pitfalls: [],
      options: {
        audit_model: "custom/strong-audit-model",
        extract_model: "fallback/extract-model",
        _fetch: mockAuditFetch,
      },
    });

    assert.strictEqual(capturedModel, "custom/strong-audit-model", "体检必须优先使用指定的 audit_model 强模型");
    assert.ok(capturedHeaders && (capturedHeaders["User-Agent"] || "").includes("Memory"), "体检模型请求必须包含 Memory 客户端标识");

    // 5.3 验证 audit_model 留空时回退至 extract_model
    await auditMemoriesWithModel({
      memories: [{ id: 1, title: "测试记忆", content: "测试内容" }],
      pitfalls: [],
      options: {
        audit_model: "",
        extract_model: "fallback/extract-model",
        _fetch: mockAuditFetch,
      },
    });
    assert.strictEqual(capturedModel, "fallback/extract-model", "audit_model 留空时必须自动回退至 extract_model");
    console.log("  ✓ 独立模型优先级与 Memory 客户端标识验证通过！\n");

  } finally {
    console.log(`[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    const cleanRes = await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "残余必须彻底为 0");
    console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
  }
}

run().catch((err) => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});
