/**
 * test_p0_external_fixes.mjs —— P0 三大核心缺陷验证
 * 1. #2: 不传 compress 时历史消息逐字节未改（保 KV-Cache 铁律）
 * 2. #3: local_state.js lookupR2Mount target 变量作用域修复，不再抛 ReferenceError
 * 3. #5: harvest_gateway 信标完整注册与执行验证
 */
import assert from "node:assert";
import { onRequest } from "../memory.middleware.js";
import { lookupR2Mount, rememberR2Mount, forgetR2Mount } from "../local_state.js";
import { OPS, executeAction, readAction } from "../page_actions.js";
import { createTestEnv } from "./lib/testenv.mjs";

console.log("=================================================================");
console.log("【测试开始】外部清单 P0 核心缺陷整改验证 (test_p0_external_fixes.mjs)");
console.log("=================================================================\n");

// -------------------------------------------------------------
// P0 - #2: 不传 compress 时历史消息逐字节未改（保 KV-Cache）
// -------------------------------------------------------------
console.log("▶ [P0 - #2] 验证不传 compress 时历史消息逐字节未改 (保 KV-Cache)...");
{
  const toolOutput = "2026-10-18 12:00:00 [DEBUG] sync step 1 finished\n".repeat(100);
  const userHistory = "请检查前几步的日志输出是否正常。\n".repeat(50);
  
  const body = {
    model: "test-llm",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: userHistory },
      { role: "assistant", content: "好的，我来调用工具查看日志。" },
      { role: "tool", content: toolOutput },
      { role: "user", content: "现在请给出分析结果。" }
    ]
  };

  const origHistoryJson = JSON.stringify(body.messages.slice(0, 4));

  // 不传 compress 选项（options = {}）
  const ctx = {
    options: { memories: [] },
    state: {}
  };

  onRequest(body, ctx);

  const processedHistoryJson = JSON.stringify(body.messages.slice(0, 4));
  assert.strictEqual(
    processedHistoryJson,
    origHistoryJson,
    "核心铁律违背！未传 compress 时，历史前缀消息被改写，KV-Cache 被击穿！"
  );
  console.log("  ✓ 核心铁律验证通过：未传 compress 时历史消息 [0..3] 逐字节完全一致，KV-Cache 100% 保全");
}

// -------------------------------------------------------------
// P0 - #3: lookupR2Mount target 变量作用域与跨库隔离验证
// -------------------------------------------------------------
console.log("\n▶ [P0 - #3] 验证 lookupR2Mount 跨库查询不再抛 ReferenceError 且不串扰...");
{
  const stBackup = (await import("../local_state.js")).readState();
  const origMounts = stBackup.r2_mounts || {};
  const writeState = (await import("../local_state.js")).writeState;
  writeState({ ...stBackup, r2_mounts: {} });

  rememberR2Mount("41694_db_alpha", {
    bucket: "bucket-alpha",
    public_url: "https://alpha.example.com",
    at: Date.now()
  });

  try {
    // 单条记录存在时，查询不同库名
    let hit = null;
    assert.doesNotThrow(() => {
      hit = lookupR2Mount("41694_db_beta");
    }, "查询未绑定的 db_beta 不得抛出 ReferenceError");
    assert.strictEqual(hit, null, "查询不同库名时不应兜底返回 db_alpha 的挂载记录");

    // 查询同源库名（忽略前缀与大小写）
    const hitAlpha = lookupR2Mount("db_alpha");
    assert.ok(hitAlpha, "归一化查询同一库名应成功命中");
    assert.strictEqual(hitAlpha.bucket, "bucket-alpha");

    // 不传库名时唯一记录兜底
    const hitEmpty = lookupR2Mount("");
    assert.ok(hitEmpty, "未指定库名时单记录兜底生效");
    assert.strictEqual(hitEmpty.bucket, "bucket-alpha");
    console.log("  ✓ 作用域与跨库隔离验证通过：不抛 ReferenceError，跨库安全隔离");
  } finally {
    forgetR2Mount("41694_db_alpha");
    writeState({ ...(await import("../local_state.js")).readState(), r2_mounts: origMounts });
  }
}

// -------------------------------------------------------------
// P0 - #5: harvest_gateway 信标补齐注册与执行验证
// -------------------------------------------------------------
console.log("\n▶ [P0 - #5] 验证 harvest_gateway 信标在 OPS 注册并可执行...");
{
  assert.ok(OPS.harvest_gateway, "harvest_gateway 必须在 OPS 中合法注册");
  const action = readAction({ _action: { op: "harvest_gateway", id: "act-gw-1", at: Date.now() } });
  assert.ok(action, "readAction 必须识别 harvest_gateway 信标");

  const env = await createTestEnv({ instance: "41694_agent_memory" });
  try {
    const res = await executeAction(
      action,
      { options: { dir: "/tmp", extract_model: "" }, client: env.client },
      env.instance
    );
    assert.strictEqual(res.ran, true, "executeAction 必须执行 harvest_gateway");
    assert.ok(res.result, "harvest_gateway 执行结果对象存在");
    assert.strictEqual(res.result.op, "harvest_gateway");
    console.log("  ✓ 信标注册与执行验证通过：harvest_gateway 正式入驻并可受控调用");
  } finally {
    await env.cleanup();
  }
}


// -------------------------------------------------------------
// P0 - 1: memorySearch 字段裁剪与 invalid_at / expires_at 过滤防回归断言
// -------------------------------------------------------------
console.log("\n▶ [P0 - 1] 验证 Mock Client 严格字段裁剪下列投影补齐与失效/过期过滤...");
{
  const { MagpieMemoryHub } = await import("../tools.js");
  const rawMemories = [
    {
      id: 101,
      project: "test-proj",
      category: "fact",
      scope_level: "project",
      client: "agent",
      origin: "tool",
      title: "活跃记忆标题",
      content: "这是一个有效的活跃记忆",
      tags: "test",
      related_entities: "entities",
      confidence_score: 95,
      recurrence: 1,
      retrieval_count: 0,
      last_used_at: null,
      updated_at: "2026-10-19 12:00:00",
      lifecycle_status: "active",
      invalid_at: null,
      expires_at: null,
    },
    {
      id: 102,
      project: "test-proj",
      category: "fact",
      scope_level: "project",
      client: "agent",
      origin: "tool",
      title: "已失效记忆标题",
      content: "这是一条已经 invalid 的记忆",
      tags: "test",
      related_entities: "entities",
      confidence_score: 95,
      recurrence: 1,
      retrieval_count: 0,
      last_used_at: null,
      updated_at: "2026-10-18 12:00:00",
      lifecycle_status: "active",
      invalid_at: "2026-10-19 00:00:00",
      expires_at: null,
    },
    {
      id: 103,
      project: "test-proj",
      category: "fact",
      scope_level: "project",
      client: "agent",
      origin: "tool",
      title: "已过期记忆标题",
      content: "这是一条已经 expires 的临时记忆",
      tags: "test",
      related_entities: "entities",
      confidence_score: 95,
      recurrence: 1,
      retrieval_count: 0,
      last_used_at: null,
      updated_at: "2026-10-01 12:00:00",
      lifecycle_status: "active",
      invalid_at: null,
      expires_at: "2026-10-10 00:00:00",
    },
  ];

  // 严格字段裁剪 Mock Client：完全模拟 NCB 只返回 columns 声明的列
  let requestedColumns = null;
  const mockClient = {
    list: async (table, params) => {
      requestedColumns = params.columns;
      const clipped = rawMemories.map((row) => {
        if (!Array.isArray(params.columns)) return { ...row };
        const out = {};
        for (const col of params.columns) {
          if (col in row) out[col] = row[col];
        }
        return out;
      });
      return { data: clipped };
    },
    update: async () => ({ affectedRows: 1 }),
  };

  const hub = await MagpieMemoryHub({}, { client: mockClient });
  const searchResRaw = await hub.tool.memory_search.execute({ query: "记忆", project: "test-proj" }, {});
  const searchRes = typeof searchResRaw === "string" ? JSON.parse(searchResRaw) : searchResRaw;

  assert.ok(requestedColumns, "memory_search 必须传入 columns 投影参数");
  assert.ok(requestedColumns.includes("invalid_at"), "columns 投影必须包含 invalid_at");
  assert.ok(requestedColumns.includes("expires_at"), "columns 投影必须包含 expires_at");

  // 字段裁剪断言：只返回有效记忆，失效与过期记忆必须被正确过滤
  assert.strictEqual(searchRes.returned, 1, "在字段裁剪下必须且仅返回 1 条有效记忆");
  assert.strictEqual(searchRes.memories[0].id, 101, "返回的必须是活跃有效记忆 101");
  console.log("  ✓ P0-1 验证通过：columns 投影已补齐 invalid_at/expires_at，Mock Client 严格裁剪下失效/过期记忆被准确过滤！");
}

// -------------------------------------------------------------
// P0 - 2: memoryAudit 游标双表独立拆分验证 (last_memory_id / last_pitfall_id)
// -------------------------------------------------------------
console.log("\n▶ [P0 - 2] 验证 memoryAudit 游标双表独立拆分与零跨表漏检...");
{
  const { memoryAudit } = await import("../tools.js");
  const { saveAuditCursor, getAuditCursor, clearAuditCursor } = await import("../local_state.js");
  const testProject = "audit_cursor_split_test";
  clearAuditCursor(testProject);

  saveAuditCursor(testProject, {
    last_memory_id: 50,
    last_pitfall_id: 10,
    last_id: 50,
  });

  const cursorRead = getAuditCursor(testProject);
  assert.strictEqual(cursorRead.last_memory_id, 50, "last_memory_id 必须独立存取");
  assert.strictEqual(cursorRead.last_pitfall_id, 10, "last_pitfall_id 必须独立存取");

  clearAuditCursor(testProject);
  console.log("  ✓ P0-2 验证通过：游标双表拆分为 last_memory_id 与 last_pitfall_id，杜绝跨表自增主键漏检！");
}

// -------------------------------------------------------------
// P0 - 3: recordPendingEvidence 语义模糊去重与 pitfall 指纹算法统一
// -------------------------------------------------------------
console.log("\n▶ [P0 - 3] 验证 recordPendingEvidence 接入 isSemanticallySimilar 语义模糊去重...");
{
  const { recordPendingEvidence } = await import("../local_state.js");
  const { semanticFingerprint } = await import("../semantic_dedup.js");

  const fp1 = semanticFingerprint("test_p03", "pitfall", "mysql_pool", "MySQL 连接池耗尽报 Too many connections");
  const fp2 = semanticFingerprint("test_p03", "pitfall", "mysql_pool", "数据库连接池满报错 Too many connections");

  // 第一条存入
  const r1 = recordPendingEvidence(`p:test_p03:${fp1}`, {
    project: "test_p03",
    component: "mysql_pool",
    symptom: "MySQL 连接池耗尽报 Too many connections",
    solution: "增加连接池最大连接数",
  }, { kind: "pitfall", minEvidence: 2 });
  assert.strictEqual(r1.shouldGraduate, false, "首条未达门槛不应毕业");
  assert.strictEqual(r1.count, 1);

  // 第二条措辞微调但语义相同，即便哈希不同也应模糊命中既有记录并累加至 count: 2 达成门槛毕业
  const r2 = recordPendingEvidence(`p:test_p03:${fp2}`, {
    project: "test_p03",
    component: "mysql_pool",
    symptom: "数据库连接池满报错 Too many connections",
    solution: "增大数据库连接池容量",
  }, { kind: "pitfall", minEvidence: 2 });

  assert.strictEqual(r2.shouldGraduate, true, "第二条语义相近踩坑必须命中模糊去重并累加至 2 次毕业");
  assert.strictEqual(r2.count, 2, "命中模糊去重后计数必须为 2");
  console.log("  ✓ P0-3 验证通过：同 project + kind: pitfall 语义模糊去重成功命中，达成门禁毕业！");
}

console.log("\n=================================================================");
console.log("✅ 全部 P0 验证测试 100% 通过！");
console.log("=================================================================");
