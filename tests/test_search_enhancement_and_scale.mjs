/**
 * test_search_enhancement_and_scale.mjs
 * =================================================================
 * 检索增强与规模化（检索重排、精简投影、增量体检游标与复合索引）专项验证
 *
 * 验证矩阵：
 * 1. 检索增强 (Search Rerank)：
 *    - 语义重排：候选列表经在线模型重排后，精准优先语义匹配项而非表面词频；
 *    - 轻量投影：发送给重排模型的候选仅包含摘要（<=200字），绝不发送数万字全文；
 *    - 严格 Fail-Open：模型挂掉/超时/超预算时无缝降级纯词面排序，结果条数绝不减少；
 *    - 双路检索元数据：返回携带 rerank_used 与 rerank_model。
 *
 * 2. 万条规模化精简投影 (Lean Projection & DB Pushdown)：
 *    - SQL 构造器支持 columns 白名单投影，只拉取必要列；
 *    - 增量游标 (since_id)、批量指定 (id_in) 与时间窗口 (updated_after) 安全拼装；
 *    - 标识符与值白名单防御注入。
 *
 * 3. 记忆体检增量扫描 (Scalable Auditing & Incremental Cursor)：
 *    - 增量游标记忆：记录上次扫描最大 ID，避免上万条重复全量扫描；
 *    - 断点续跑：新增记录后从游标处继续，只扫描增量记录；
 *    - 全量重置：full=true 显式重置游标；
 *    - 时间窗过滤：since_days 下推数据库索引条件。
 *
 * 4. 复合索引与 Schema 版本升级：
 *    - memories 表复合索引 idx_memories_lookup (project, lifecycle_status, updated_at)；
 *    - pitfalls 表复合索引 idx_pitfalls_lookup (project, updated_at)；
 *    - SCHEMA_VERSION 升级至 6 且向下兼容。
 *
 * 5. 全流程零残留断言。
 * =================================================================
 */
import assert from "node:assert";
import { createTestEnv } from "./lib/testenv.mjs";
import { MagpieMemoryHub } from "../tools.js";
import { buildSelect, safeIdent } from "../mcp_client.js";
import { SCHEMA_VERSION, TABLES } from "../schema.js";
import { getAuditCursor, saveAuditCursor, clearAuditCursor } from "../local_state.js";
import { rerankSearchResultsWithModel } from "../online_models.js";

const parseOut = (raw) => (typeof raw === "string" ? JSON.parse(raw) : raw);
const rowsOf = (res) => Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);

async function run() {
  console.log("=================================================================");
  console.log("【检索增强与规模化专项测试】");
  const env = await createTestEnv();
  console.log("隔离命名空间 project:", env.project);
  console.log("=================================================================\n");

  const hub = await MagpieMemoryHub({
    extract_model: "test-extract-model",
    audit_model: "test-audit-model",
    rerank_model: "test-rerank-model",
    audit_interval: "daily",
  }, {
    client: env.client,
    ncb_instance: env.instance,
  });

  const memSave = hub.tool["memory_save"];
  const memSearch = hub.tool["memory_search"];
  const pitSave = hub.tool["pitfall_save"];
  const pitSearch = hub.tool["pitfall_search"];
  const memAudit = hub.tool["memory_audit"];

  // =================================================================
  // --- [Test 1] 万条规模化 SQL 构造器与投影精简 (Lean Projection) ---
  // =================================================================
  console.log("--- [Test 1] SQL 构造器与精简投影 (Lean Projection) 验证 ---");
  {
    // 1.1 校验指定投影列 columns
    const cols = ["id", "project", "category", "title", "tags"];
    const sqlCols = buildSelect("memories", { project: "test_proj", columns: cols, limit: 10 });
    assert.ok(sqlCols.startsWith("SELECT `id`, `project`, `category`, `title`, `tags` FROM `memories`"), "必须只投影指定列");
    assert.ok(sqlCols.includes("WHERE `project` = 'test_proj'"), "WHERE 条件必须正确");
    assert.ok(!sqlCols.includes("SELECT *"), "指定列时绝不能是 SELECT *");

    // 1.2 校验增量游标 since_id
    const sqlSince = buildSelect("memories", { project: "test_proj", since_id: 100, limit: 20 });
    assert.ok(sqlSince.includes("`id` > 100"), "since_id 必须生成 `id` > 100");

    // 1.3 校验批量 ID 过滤 id_in
    const sqlIdIn = buildSelect("memories", { id_in: [10, 20, 30] });
    assert.ok(sqlIdIn.includes("`id` IN (10, 20, 30)"), "id_in 必须生成安全的 IN 语句");

    // 1.4 校验时间窗过滤 updated_after
    const sqlTime = buildSelect("memories", { updated_after: "2026-10-01 00:00:00" });
    assert.ok(sqlTime.includes("`updated_at` >= '2026-10-01 00:00:00'"), "updated_after 必须生成时间范围条件");

    // 1.5 注入防线断言：非法列名在 columns 中必须报错拒绝
    assert.throws(() => {
      buildSelect("memories", { columns: ["id", "drop_table_injection;--"] });
    }, /未知列名/, "非白名单列名必须被拒绝");

    console.log("  ✓ 精简投影 columns、游标 since_id、id_in 与时间窗 SQL 验证通过！\n");
  }

  // =================================================================
  // --- [Test 2] 检索增强 Rerank 核心算法与 Fail-Open 容错 ---
  // =================================================================
  console.log("--- [Test 2] 检索增强 Rerank 算法与 Fail-Open 容错验证 ---");
  {
    // 2.1 模拟在线模型语义重排
    let mockFetchCalled = false;
    let sentCandidateSummaryLen = 0;
    const mockFetchSuccess = async (url, opts) => {
      mockFetchCalled = true;
      const body = JSON.parse(opts.body);
      const userPrompt = body.messages[1].content;
      // 验证发送给模型的候选列表经过了 Lean Projection 截断
      sentCandidateSummaryLen = userPrompt.length;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ranked: [
                    { id: 2, score: 9.8, reason: "精准解答了凭据配置细节" },
                    { id: 1, score: 3.5, reason: "仅提及部分关键词但非核心答案" },
                  ],
                }),
              },
            },
          ],
        }),
      };
    };

    const candidates = [
      { id: 1, title: "通用服务器配置指南", content: "这里有一大段上万字的文档...".repeat(50) },
      { id: 2, title: "NoCodeBackend 连接 Cloudflare R2 凭据配置", content: "填入 Admin Read & Write 令牌即可解决 write EPROTO 报错" },
    ];

    const rerankRes = await rerankSearchResultsWithModel({
      query: "R2 凭据怎么配置解决 TLS 报错",
      candidates,
      options: {
        rerank_model: "mock-model",
        _fetch: mockFetchSuccess,
      },
      maxTop: 2,
    });

    assert.ok(mockFetchCalled, "必须发起重排模型调用");
    assert.strictEqual(rerankRes.modelUsed, "mock-model");
    assert.strictEqual(rerankRes.ranked[0].id, 2, "模型重排必须优先选中最具语义相关度的 ID=2");
    assert.ok(sentCandidateSummaryLen < 3000, "精简投影必须限制请求体大小，绝不发送全量上万字");

    // 2.2 严格 Fail-Open 断言：模型网络异常、超时或抛错时必须返回 null
    const mockFetchError = async () => {
      throw new Error("Gateway connection timed out");
    };
    const failOpenRes = await rerankSearchResultsWithModel({
      query: "test query",
      candidates,
      options: {
        rerank_model: "mock-model",
        _fetch: mockFetchError,
      },
    });
    assert.strictEqual(failOpenRes, null, "模型异常时必须严格 fail-open 返回 null");

    // 2.3 开关关闭断言：search_rerank === false 时 0 模型调用
    let callCount = 0;
    const disabledRes = await rerankSearchResultsWithModel({
      query: "test",
      candidates,
      options: {
        search_rerank: false,
        rerank_model: "mock-model",
        _fetch: async () => { callCount++; return { ok: true }; },
      },
    });
    assert.strictEqual(disabledRes, null);
    assert.strictEqual(callCount, 0, "关闭 search_rerank 开关时必须为 0 模型调用");

    console.log("  ✓ 检索增强重排准确性、轻量摘要投影与 Fail-Open 验证通过！\n");
  }

  // =================================================================
  // --- [Test 3] memory_search 与 pitfall_search 端到端检索增强 ---
  // =================================================================
  console.log("--- [Test 3] memory_search 与 pitfall_search 端到端集成验证 ---");
  {
    // 入库测试条目
    const mem1 = parseOut(await memSave.execute({
      project: env.project,
      category: "fact",
      title: "关于 Redis 缓存部署注意事项",
      content: "Redis 缓存超时需要配置 maxmemory-policy 为 allkeys-lru，避免内存撑爆。",
      tags: "redis, cache, memory",
    }));

    const mem2 = parseOut(await memSave.execute({
      project: env.project,
      category: "decision",
      title: "NoCodeBackend 与 Cloudflare R2 凭据设定标准",
      content: "创建 R2 令牌时权限必须选择 Admin Read & Write，否则 NoCodeBackend 无法自动建桶。",
      tags: "nocodebackend, r2, credentials, storage",
    }));

    // 注入 mock rerank model 至 client 配置
    const origFetch = globalThis.fetch;
    let rerankInSearchTriggered = false;

    // 自定义带有重排模型的 Hub 实例执行搜索
    const hubWithRerank = await MagpieMemoryHub({
      rerank_model: "test-rerank-llm",
      search_rerank: true,
      _fetch: async (url, opts) => {
        if (url.includes("/v1/chat/completions")) {
          const body = JSON.parse(opts.body);
          if (body.messages[0].content.includes("检索增强")) {
            rerankInSearchTriggered = true;
            return {
              ok: true,
              json: async () => ({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        ranked: [
                          { id: mem2.id, score: 9.9, reason: "命中 R2 凭据设定核心规则" },
                        ],
                      }),
                    },
                  },
                ],
              }),
            };
          }
        }
        return origFetch(url, opts);
      },
    }, {
      client: env.client,
      ncb_instance: env.instance,
    });

    const searchRes = parseOut(await hubWithRerank.tool.memory_search.execute({
      query: "云存储与R2鉴权凭证怎么配",
      project: env.project,
    }));

    assert.ok(searchRes.rerank_used, "检索增强开启时 rerank_used 必须为 true");
    assert.strictEqual(searchRes.rerank_model, "test-rerank-llm", "rerank_model 必须为指定的重排模型");
    assert.ok(searchRes.memories.length >= 1, "必须返回记忆");
    assert.strictEqual(searchRes.memories[0].id, mem2.id, "重排后最具语义匹配度的条目必须排在第一位");
    assert.ok(searchRes.memories[0]._rerank_score > 9, "第一条必须附带重排打分");

    // 验证降级保险：当重排关闭时，结果集依然正常返回（结果永不丢失）
    const searchResPlain = parseOut(await hubWithRerank.tool.memory_search.execute({
      query: "Redis 缓存",
      project: env.project,
      search_rerank: false,
    }));
    assert.strictEqual(searchResPlain.rerank_used, false, "显式关闭重排时 rerank_used 为 false");
    assert.ok(searchResPlain.returned >= 1, "纯词面检索依然正常返回结果");

    console.log("  ✓ memory_search 检索增强、打分置顶与结果集双路保险通过！\n");
  }

  // =================================================================
  // --- [Test 4] 记忆体检增量扫描与断点续跑 (Incremental Cursor) ---
  // =================================================================
  console.log("--- [Test 4] 记忆体检增量游标扫描与断点续跑验证 ---");
  {
    const subProj = `${env.project}_incr`;
    clearAuditCursor(subProj);

    // 第一批数据入库：ID 较小
    const p1 = parseOut(await pitSave.execute({
      project: subProj,
      component: "db_pool",
      symptom: "MySQL 连接池耗尽报 Too many connections",
      root_cause: "连接未在 finally 块中释放导致连接泄露",
      solution: "改用 try-with-resources 自动释放连接",
    }));

    // 第一次体检（从头开始，无历史游标）
    const audit1 = parseOut(await memAudit.execute({
      project: subProj,
      incremental: true,
      limit: 10,
    }));

    assert.strictEqual(audit1.incremental, true, "应处于增量模式");
    assert.strictEqual(audit1.cursor.previous_last_id, 0, "首次体检 previous_last_id 为 0");
    assert.ok(audit1.cursor.current_last_id >= p1.id, "体检后游标必须推进到当前批次最大 ID");

    // 验证本地状态已持久化记录该游标
    const savedCursor1 = getAuditCursor(subProj);
    assert.strictEqual(savedCursor1.last_id, audit1.cursor.current_last_id, "本地状态必须记录当前游标");

    // 第二批数据入库：ID 严格大于第一批
    const p2 = parseOut(await pitSave.execute({
      project: subProj,
      component: "mq_consumer",
      symptom: "RabbitMQ 消费者消息堆积",
      root_cause: "消费者单线程处理耗时 IO 导致背压",
      solution: "开启并发消费线程池",
    }));

    // 第二次体检（增量断点续跑）：必须只扫描新插入的记录
    const audit2 = parseOut(await memAudit.execute({
      project: subProj,
      incremental: true,
      limit: 10,
    }));

    assert.strictEqual(audit2.cursor.previous_last_id, audit1.cursor.current_last_id, "前序游标必须从上次结束处续接");
    assert.ok(audit2.cursor.current_last_id >= p2.id, "新游标必须推进到第二批最新 ID");
    assert.strictEqual(audit2.scanned.pitfalls, 1, "增量模式下只扫描 ID 大于游标的新记录（绝不全量扫旧数据）");

    // 强制全量扫描验证（full: true）
    const auditFull = parseOut(await memAudit.execute({
      project: subProj,
      full: true,
      limit: 10,
    }));
    assert.strictEqual(auditFull.cursor.previous_last_id, 0, "full 模式必须重置前序游标");
    assert.strictEqual(auditFull.scanned.pitfalls, 2, "全量模式应扫齐该项目下全部 2 条踩坑记录");

    clearAuditCursor(subProj);
    console.log("  ✓ 增量游标记忆、断点续跑与全量重置验证通过！\n");
  }

  // =================================================================
  // --- [Test 5] Schema 复合索引与结构版本断言 ---
  // =================================================================
  console.log("--- [Test 5] Schema 复合索引与结构版本断言 ---");
  {
    assert.strictEqual(SCHEMA_VERSION, 6, "SCHEMA_VERSION 必须升级至 6");
    const memIndexes = TABLES.memories.indexes.map((x) => x.name);
    assert.ok(memIndexes.includes("idx_memories_lookup"), "memories 表必须包含 idx_memories_lookup 复合索引");

    const pitIndexes = TABLES.pitfalls.indexes.map((x) => x.name);
    assert.ok(pitIndexes.includes("idx_pitfalls_lookup"), "pitfalls 表必须包含 idx_pitfalls_lookup 复合索引");

    const memLookup = TABLES.memories.indexes.find((x) => x.name === "idx_memories_lookup");
    assert.deepStrictEqual(memLookup.columns, ["project", "lifecycle_status", "updated_at"], "复合索引列必须对齐");

    const pitLookup = TABLES.pitfalls.indexes.find((x) => x.name === "idx_pitfalls_lookup");
    assert.deepStrictEqual(pitLookup.columns, ["project", "updated_at"], "踩坑复合索引列必须对齐");

    console.log("  ✓ 复合索引 idx_memories_lookup / idx_pitfalls_lookup 与版本 6 校验通过！\n");
  }

  // =================================================================
  // --- [CLEANUP] 环境清理与零残留检查 ---
  // =================================================================
  console.log(`[CLEANUP] 开始清理隔离命名空间 ${env.project}...`);
  await env.cleanup();
  const residualMem = rowsOf(await env.client.list("memories", { project: env.project }));
  const residualPit = rowsOf(await env.client.list("pitfalls", { project: env.project }));
  assert.strictEqual(residualMem.length, 0, "memories 表测试命名空间必须零残留");
  assert.strictEqual(residualPit.length, 0, "pitfalls 表测试命名空间必须零残留");
  console.log("✅ 【零残留断言通过】：测试数据已彻底清除！\n");

  console.log("=================================================================");
  console.log("🎉 全部检索增强与规模化专项测试 100% 成功通过！");
  console.log("=================================================================");
}

run().catch((e) => {
  console.error("❌ 测试失败:", e);
  process.exit(1);
});
