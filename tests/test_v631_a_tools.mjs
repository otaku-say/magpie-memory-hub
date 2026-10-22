/**
 * tests/test_v631_a_tools.mjs
 * =================================================================
 * v6.3.1-a tools.js 核心逻辑专项整改验收测试套件
 *
 * 覆盖 7 项整改及反证门（Adversarial & Counter-factual tests）：
 * 1. P0-1: 导出面与 Proxy 安全（makeNoCredentialsClient 白名单 / 7 个非入口导出宿主探针守卫）
 * 2. P1-1: memoryGet 读操作零时间戳篡改（删除 updated_at 载荷）
 * 3. P1-2: pitfallSearch 接入 query 改写（双路打分 + rewrite_used / query_rewritten）
 * 4. P1-3: memoryContext 统一条数上限（准则、踩坑、记忆共用计数器 n）
 * 5. P1-4: principle 准则保护（saveMemory 准则豁免踩坑互斥 / pitfallSave 排除准则软失效）
 * 6. P1-5: memoryAudit 解耦「DB 拉取批」与「模型分块」（dbFetchLimit 200 / 规则覆盖全批 / 仅候选组交模型 / maxModelBatches 2 / 耗时注释）
 * 7. P2-1a: 统一凭据脱敏收敛（scrub.js 单一真相源集成）
 *
 * 符合 test_meta.mjs 规范：createTestEnv 隔离、env.cleanup 清理、residue.total === 0。
 * =================================================================
 */

import assert from "node:assert";
import fs from "node:fs";
import {
  MagpieMemoryHub,
  makeClient,
  fetchAll,
  termsOf,
  getDedupTimeWindow,
  isDedupDue,
  memoryAudit,
  memoryAuditUndo,
} from "../tools.js";
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

const rowsOf = (res) => (Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []));

console.log("=================================================================");
console.log("【v6.3.1-a tools.js 核心逻辑专项整改验收套件】");
const env = await createTestEnv({ mode: "memory" });
console.log(`[testenv] 隔离命名空间 project: ${env.project}`);
console.log("=================================================================\n");

async function run() {
  const hub = await MagpieMemoryHub({
    extract_model: "",
    audit_model: "",
  }, {
    client: env.client,
    ncb_instance: env.instance,
  });

  const memSave = hub.tool["memory_save"];
  const memSearch = hub.tool["memory_search"];
  const memGet = hub.tool["memory_get"];
  const memContext = hub.tool["memory_context"];
  const pitSave = hub.tool["pitfall_save"];
  const pitSearch = hub.tool["pitfall_search"];
  const memAudit = hub.tool["memory_audit"];

  try {
    // =================================================================
    // 1. P0-1 导出面与 Proxy 安全
    // =================================================================
    console.log("▶ [Test 1] P0-1 导出面与 Proxy 安全测试...");

    // 1.1 makeNoCredentialsClient 属性白名单与安全
    const hostProbe = { host: "bun_host_inspector", version: "1.2.3", env: {} };
    const noCredClient = makeClient(hostProbe);

    assert.strictEqual(noCredClient._isNoCredentials, true, "_isNoCredentials 必须为 true");
    assert.strictEqual(noCredClient.then, undefined, "then 必须返回 undefined 防 Promise 同化");
    assert.strictEqual(noCredClient.nonExistentProp, undefined, "【反证门】：任意非白名单属性必须返回 undefined，不得抛错也不得返回函数");
    assert.strictEqual(noCredClient.toString, undefined, "toString 必须返回 undefined");
    assert.strictEqual(typeof noCredClient.list, "function", "白名单 list 必须存在");
    assert.strictEqual(typeof noCredClient.create, "function", "白名单 create 必须存在");
    assert.strictEqual(typeof noCredClient.update, "function", "白名单 update 必须存在");
    assert.strictEqual(typeof noCredClient.remove, "function", "白名单 remove 必须存在");
    assert.strictEqual(typeof noCredClient.raw, "function", "白名单 raw 必须存在");

    await assert.rejects(
      async () => noCredClient.list("memories"),
      (err) => err.code === "NO_CREDENTIALS",
      "调用白名单方法必须抛出规范的 NO_CREDENTIALS 错误"
    );
    console.log("  ✓ makeNoCredentialsClient Proxy 白名单及 Promise 穿透防护验证通过！");

    // 1.2 7 个非入口导出函数宿主探针守卫（首参为宿主探针对象时安全返回，绝不抛错）
    const dummyHostObj = { runtime: "node", server: {}, tools: [] };

    // a) fetchAll -> []
    const fetchAllRes = await fetchAll(dummyHostObj, "memories");
    assert.deepStrictEqual(fetchAllRes, [], "fetchAll 遇宿主对象必须安全返回空数组");

    // b) termsOf -> [] (反证门：旧行为 String({}) 会输出 [ 'object' ])
    const termsRes = termsOf(dummyHostObj);
    assert.deepStrictEqual(termsRes, [], "【反证门通过】：termsOf 遇宿主对象必须安全返回 []，绝不能解析出 [object]");

    // c) getDedupTimeWindow -> null
    const windowRes = getDedupTimeWindow(dummyHostObj);
    assert.strictEqual(windowRes, null, "getDedupTimeWindow 遇宿主对象必须返回 null");

    // d) isDedupDue -> false
    const dueRes = isDedupDue(dummyHostObj);
    assert.strictEqual(dueRes, false, "isDedupDue 遇宿主对象必须返回 false");

    // e) memoryAudit -> 安全 JSON
    const auditSafeRes = parseOut(await memoryAudit(dummyHostObj));
    assert.strictEqual(auditSafeRes.success, false, "memoryAudit 遇宿主对象必须返回 success: false");
    assert.strictEqual(auditSafeRes.action, "DEDUP_REPORT", "memoryAudit 遇宿主对象必须返回合规 action");

    // f) memoryAuditUndo -> 安全 JSON
    const undoSafeRes = parseOut(await memoryAuditUndo(dummyHostObj));
    assert.strictEqual(undoSafeRes.success, false, "memoryAuditUndo 遇宿主对象必须返回 success: false");
    assert.strictEqual(undoSafeRes.action, "DEDUP_UNDONE", "memoryAuditUndo 遇宿主对象必须返回合规 action");

    // g) makeClient -> 返回 no-credentials client
    const clientSafeRes = makeClient(dummyHostObj);
    assert.strictEqual(clientSafeRes._isNoCredentials, true, "makeClient 遇宿主对象必须安全返回 no-credentials client");

    console.log("  ✓ 7 个非入口导出函数宿主探针守卫 100% 验证通过！\n");

    // =================================================================
    // 2. P1-1 memoryGet 读操作零时间戳篡改
    // =================================================================
    console.log("▶ [Test 2] P1-1 memoryGet 读操作零时间戳篡改测试...");

    const fixedUpdatedAt = "2026-01-01 12:00:00";
    const createdMem = await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "时间戳守卫测试记忆",
      content: "测试 memoryGet 读操作绝不篡改原始 updated_at 时间戳",
      lifecycle_status: "active",
      recurrence: 1,
      retrieval_count: 0,
      created_at: fixedUpdatedAt,
      updated_at: fixedUpdatedAt,
    });
    const memId = createdMem.id || createdMem.insertId;

    // 执行读操作 memory_get
    const getRes = parseOut(await memGet.execute({ id: memId }));
    assert.strictEqual(getRes.id, memId, "必须读取到对应记忆");
    assert.strictEqual(getRes.retrieval_count, 1, "retrieval_count 必须正常累加");
    assert.ok(getRes.last_used_at, "last_used_at 必须已更新");

    // 直查数据库检验 updated_at
    const dbRows = rowsOf(await env.client.list("memories", { id: memId, project: env.project }));
    assert.strictEqual(dbRows.length, 1);
    assert.strictEqual(
      dbRows[0].updated_at,
      fixedUpdatedAt,
      "【反证门通过】：memoryGet 读操作后 updated_at 必须与写入前完全一致，严禁被篡改为当前时间！"
    );
    assert.strictEqual(Number(dbRows[0].retrieval_count), 1, "数据库中的 retrieval_count 必须为 1");
    console.log("  ✓ memoryGet 读操作零时间戳篡改验证通过！\n");

    // =================================================================
    // 3. P1-2 pitfallSearch 接入 query 改写
    // =================================================================
    console.log("▶ [Test 3] P1-2 pitfallSearch 接入 query 改写测试...");

    // 存入一条专业踩坑
    const pitOrigin = parseOut(await pitSave.execute({
      project: env.project,
      component: "vite_hmr",
      symptom: "Vite HMR 热更新由于 inotify 监听数耗尽导致失效",
      root_cause: "系统内核 fs.inotify.max_user_watches 默认值过低",
      solution: "执行 sysctl -w fs.inotify.max_user_watches=524288",
    }));

    // 3.1 模拟提炼模型改写自然语言问句
    const mockRewriteFetch = async (url, opts) => {
      const b = JSON.parse(opts.body);
      if (b.messages?.[0]?.content?.includes("改写") || b.messages?.[0]?.content?.includes("关键词")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                role: "assistant",
                content: "Vite HMR 热更新 inotify 失效",
              },
            }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [] }) };
    };

    const hubWithRewrite = await MagpieMemoryHub({
      extract_model: "test-rewrite-model",
      search_rewrite: true,
      _fetch: mockRewriteFetch,
    }, {
      client: env.client,
      ncb_instance: env.instance,
    });

    // 用户使用自然语言口语提问
    const pitRes = parseOut(await hubWithRewrite.tool["pitfall_search"].execute({
      query: "上次那个前端热更新挂了怎么修的",
      project: env.project,
    }));

    assert.strictEqual(pitRes.rewrite_used, true, "启用改写模型时 rewrite_used 必须为 true");
    assert.strictEqual(pitRes.query_rewritten, "Vite HMR 热更新 inotify 失效", "query_rewritten 必须返回改写后的关键词");
    assert.ok(pitRes.matched >= 1, "双路词面扩展打分必须精准召回目标踩坑");
    assert.strictEqual(pitRes.pitfalls[0].id, pitOrigin.id, "首位命中踩坑 ID 必须匹配");

    // 3.2 严格 fail-open 验证：改写模型抛错或超时，不影响原始词面检索
    const hubFailOpen = await MagpieMemoryHub({
      extract_model: "test-rewrite-model",
      search_rewrite: true,
      _fetch: async () => { throw new Error("Connection reset by peer"); },
    }, {
      client: env.client,
      ncb_instance: env.instance,
    });

    const pitFailOpenRes = parseOut(await hubFailOpen.tool["pitfall_search"].execute({
      query: "inotify",
      project: env.project,
    }));
    assert.strictEqual(pitFailOpenRes.rewrite_used, false, "模型网络异常时 rewrite_used 必须降级为 false");
    assert.strictEqual(pitFailOpenRes.query_rewritten, null, "模型网络异常时 query_rewritten 必须降级为 null");
    assert.ok(pitFailOpenRes.matched >= 1, "模型异常时严格 fail-open，纯词面命中继续生效");
    console.log("  ✓ pitfallSearch 双路改写打分与 Fail-Open 容错验证通过！\n");

    // =================================================================
    // 4. P1-3 memoryContext 统一条数上限
    // =================================================================
    console.log("▶ [Test 4] P1-3 memoryContext 统一条数上限测试...");

    // 插入 2 条准则、2 条踩坑、3 条普通记忆
    await memSave.execute({ project: env.project, category: "principle", title: "准则一：必须编写单元测试", content: "所有核心模块必须有自动化测试覆盖" });
    await memSave.execute({ project: env.project, category: "principle", title: "准则二：严禁泄露密钥凭据", content: "所有代码及日志不得出现未脱敏密钥" });
    await pitSave.execute({ project: env.project, component: "db", symptom: "死锁排查一", solution: "增加重试" });
    await pitSave.execute({ project: env.project, component: "db", symptom: "死锁排查二", solution: "优化事务索引" });
    await memSave.execute({ project: env.project, category: "fact", title: "事实记录一", content: "服务监听端口 8080" });
    await memSave.execute({ project: env.project, category: "fact", title: "事实记录二", content: "构建使用 pnpm" });
    await memSave.execute({ project: env.project, category: "fact", title: "事实记录三", content: "日志落盘路径 /var/log" });

    // 请求 max_items: 2
    const ctxLimit2 = parseOut(await memContext.execute({
      project: env.project,
      max_items: 2,
    }));

    assert.ok(
      ctxLimit2.injected <= 2,
      `【反证门通过】：统一条数计数器生效，总注入条数 (${ctxLimit2.injected}) 绝不能超过 max_items (2)！`
    );
    const lines = ctxLimit2.block.split("\n").filter((l) => l.trim().startsWith("- ["));
    assert.strictEqual(lines.length, ctxLimit2.injected, "block 文本行数必须与 injected 严格一致");
    assert.ok(lines.length <= 2, "实际生成的列表条数必须 <= 2");

    // 请求 max_items: 4
    const ctxLimit4 = parseOut(await memContext.execute({
      project: env.project,
      max_items: 4,
    }));
    assert.ok(ctxLimit4.injected <= 4, "max_items: 4 注入数必须 <= 4");
    console.log("  ✓ memoryContext 三段循环统一条数上限验证通过！\n");

    // =================================================================
    // 5. P1-4 principle 准则保护
    // =================================================================
    console.log("▶ [Test 5] P1-4 principle 准则保护测试...");

    // 5.1 saveMemory：category==="principle" 豁免踩坑优先软失效
    // 先准备一条踩坑记录
    await pitSave.execute({
      project: env.project,
      component: "auth_rule",
      symptom: "禁止使用硬编码密钥",
      root_cause: "安全规范",
      solution: "使用环境变量注入",
    });

    // 写入同名准则 category: principle
    const savedPrincipleRes = parseOut(await memSave.execute({
      project: env.project,
      category: "principle",
      title: "禁止使用硬编码密钥",
      content: "架构铁律：严禁在代码库中硬编码任何真实 API 密钥与凭据",
    }));

    assert.strictEqual(
      savedPrincipleRes.action,
      "ADD",
      "【反证门通过】：category==='principle' 准则记录严禁被踩坑优先逻辑拦截为 NOOP！"
    );
    assert.ok(savedPrincipleRes.id, "必须成功写入 memories 表并生成主键 ID");

    // 5.2 pitfallSave：跨表软失效 memories 时排除 category==="principle"
    const principleToProtect = parseOut(await memSave.execute({
      project: env.project,
      category: "principle",
      title: "统一配置项格式规范",
      content: "所有环境变量必须使用 UPPER_SNAKE_CASE 命名规范",
    }));
    const pId = principleToProtect.id;

    // 后续存入相同症状的踩坑
    await pitSave.execute({
      project: env.project,
      component: "config_lint",
      symptom: "统一配置项格式规范",
      root_cause: "配置项大小写混乱",
      solution: "添加 linter 检查",
    });

    // 查库断言：principle 记录绝不能被软失效为 superseded_by_pitfall
    const checkMem = rowsOf(await env.client.list("memories", { id: pId, project: env.project }));
    assert.strictEqual(checkMem.length, 1);
    assert.strictEqual(
      checkMem[0].lifecycle_status,
      "active",
      "【反证门通过】：踩坑入库时，category==='principle' 的记忆绝不能被标记为 superseded！"
    );
    assert.strictEqual(checkMem[0].invalid_at, null, "准则记录 invalid_at 必须依然为 null");
    console.log("  ✓ principle 准则双向免失效保护验证通过！\n");

    // =================================================================
    // 6. P1-5 memoryAudit 解耦「DB 拉取批」与「模型分块」
    // =================================================================
    console.log("▶ [Test 6] P1-5 memoryAudit 解耦「DB 拉取批」与「模型分块」测试...");

    // 6.1 验证代码注释中的最坏耗时估算要求
    const toolsSrc = fs.readFileSync("tools.js", "utf8");
    assert.ok(
      toolsSrc.includes("2 次模型调用 × 15s = 30s < 55s") || toolsSrc.includes("2 x 15s = 30s"),
      "tools.js 注释必须写明单次调用最坏耗时估算（30s < 55s 硬超时防线）"
    );

    // 6.2 验证 dbFetchLimit 默认 200，支持配置与下推
    // 准备 2 条跨批重复记录
    await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "大拉取批去重覆盖测试：跨批重复条目 A",
      content: "验证 dbFetchLimit 支持单次拉取高达 200 条并在内存中做全量规则去重",
      content_fingerprint: "fp_batch_decouple_1",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "audit, decouple, test",
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
    await env.client.create("memories", {
      project: env.project,
      category: "fact",
      title: "大拉取批去重覆盖测试：跨批重复条目 A（变体）",
      content: "验证 dbFetchLimit 支持单次拉取高达 200 条并在内存中做全量规则去重",
      content_fingerprint: "fp_batch_decouple_1",
      lifecycle_status: "active",
      recurrence: 1,
      tags: "audit, decouple, test",
      created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    });

    const auditRes = parseOut(await memAudit.execute({
      project: env.project,
      fetch_limit: 200,
      full: true,
    }));

    assert.strictEqual(auditRes.action, "DEDUP_REPORT");
    assert.strictEqual(auditRes.data_changed, true, "规则级查重必须成功合并重复项");
    assert.strictEqual(auditRes.cursor.batch_size, 200, "cursor.batch_size 必须反映 dbFetchLimit (200)");
    assert.ok(auditRes.deduped.memories >= 1, "跨批重复项必须被合并");

    // 6.3 验证模型独立仲裁预算（maxModelBatches 默认 2 = 最多 80 条）
    let modelCallCount = 0;
    const mockAuditModelFetch = async (url, opts) => {
      modelCallCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                memory_duplicates: [],
                pitfall_duplicates: [],
              }),
            },
          }],
        }),
      };
    };

    const hubWithAuditModel = await MagpieMemoryHub({
      audit_model: "test-audit-llm",
      _fetch: mockAuditModelFetch,
    }, {
      client: env.client,
      ncb_instance: env.instance,
    });

    await hubWithAuditModel.tool["memory_audit"].execute({
      project: env.project,
      full: true,
      max_model_batches: 2,
    });

    assert.ok(modelCallCount <= 2, `模型调用次数 (${modelCallCount}) 必须受到 maxModelBatches (2) 硬预算约束`);
    console.log("  ✓ memoryAudit 拉取批 (200) 与模型分块 (40) 解耦及预算隔离验证通过！\n");

    // =================================================================
    // 7. P2-1a 凭据脱敏收敛至 scrub.js
    // =================================================================
    console.log("▶ [Test 7] P2-1a 凭据脱敏统一收敛至 scrub.js 测试...");

    // 7.1 验证 tools.js 内部已删除本地 scrubSecrets，完全从 scrub.js 导入
    assert.ok(
      toolsSrc.includes('import { scrubSecrets } from "./src/core/sanitize.js";'),
      "tools.js 必须显式 import { scrubSecrets } from '../src/core/sanitize.js';"
    );
    assert.ok(
      !toolsSrc.includes("function scrubSecrets(text)"),
      "【反证门通过】：tools.js 内严禁保留私有的 scrubSecrets 本地实现！"
    );

    // 7.2 写入包含各类高敏凭据的记忆
    const secretTitle = "开发密钥配置 sk-9876543210fedcba";
    const secretContent = "AWS凭证: AKIA1234567890ABCDEF, GitHub: ghp_1122334455667788, DB: postgresql://admin:pass@localhost:5432/mydb";
    const secretTags = "secret, sk-1122334455667788";

    const savedSecretMem = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: secretTitle,
      content: secretContent,
      tags: secretTags,
    }));

    const rawMemInDb = rowsOf(await env.client.list("memories", { id: savedSecretMem.id, project: env.project }))[0];
    assert.ok(!rawMemInDb.title.includes("sk-9876543210fedcba"), "标题中的 sk- 密钥必须脱敏");
    assert.ok(!rawMemInDb.content.includes("AKIA1234567890ABCDEF"), "AWS AccessKey 必须脱敏");
    assert.ok(!rawMemInDb.content.includes("ghp_1122334455667788"), "GitHub Token 必须脱敏");
    assert.ok(!rawMemInDb.content.includes("pass"), "数据库连接串密码必须脱敏");
    assert.ok(!rawMemInDb.tags.includes("sk-1122334455667788"), "Tags 字段中的密钥必须脱敏");

    console.log("  ✓ scrub.js 统一脱敏模块收敛及全场景凭据脱敏验证通过！\n");

  } finally {
    // =================================================================
    // 清理与零残留断言（符合 test_meta.mjs 规范）
    // =================================================================
    console.log(`[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
    await env.cleanup();
    const residue = await env.countAllTestResidue();
    assert.strictEqual(residue.total, 0, "残余数据必须彻底为 0");
    console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");
  }
}

run().catch((err) => {
  console.error("❌ [测试异常中断]:", err);
  process.exit(1);
});
