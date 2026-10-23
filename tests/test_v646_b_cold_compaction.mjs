#!/usr/bin/env node
/**
 * tests/test_v646_b_cold_compaction.mjs
 *
 * 模块职责：v6.4.6-B 零 LLM 冷记忆抽取式压缩 + 主动矛盾检测巡检的针对性验证
 * 依赖：node:assert、src/services/audit/auditor.js
 * 被依赖：tests/test_meta.mjs（计数锁定 90）、CI
 *
 * 覆盖点：
 *   1. compactColdContent：纯正则抽取（首句摘要 ≤120 字 + 关键 Token），字符节省 ≥60%；
 *   2. compactColdMemories：冷记忆四重判定（非 principle / >240 / 60 天 / 无 compacted 标签），
 *      原文无损留存 full_text、content 替换为浓缩摘要、tags 追加 compacted；
 *   3. 幂等性：二次调用 0 条；【反证】仅因 tags 带 compacted 而被跳过——摘掉标签后必须再次被压缩；
 *   4. memoryAudit：同项目同主题数字冲突 → contradictions 预警；
 *      【反证】同主题同数字、异主题异数字、跨项目均不得误报。
 */
import assert from "node:assert";
import { compactColdContent, compactColdMemories, memoryAudit } from "../src/services/audit/auditor.js";

console.log("=================================================================");
console.log("【v6.4.6-B 零 LLM 冷记忆压缩 + 主动矛盾检测】");
console.log("=================================================================\n");

const DAY = 86400000;
const testProject = "__test_v646_b_" + Date.now() + "__";
const otherProject = testProject + "other__";

const memoryStore = new Map();
const pitfallStore = new Map();
let nextId = 9000;
let updateCalls = 0;

const mockDbClient = {
  list: async (table, params = {}) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    let rows = [];
    for (const row of store.values()) {
      if (params.project && row.project !== params.project) continue;
      if (params.id && row.id !== params.id) continue;
      if (params.since_id && row.id <= params.since_id) continue;
      if (params.lifecycle_status && row.lifecycle_status !== params.lifecycle_status) continue;
      rows.push({ ...row });
    }
    rows.sort((a, b) => a.id - b.id);
    if (params.limit) rows = rows.slice(0, Number(params.limit));
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
    updateCalls++;
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

function cleanup() {
  memoryStore.clear();
  pitfallStore.clear();
}
function residueCount() {
  return memoryStore.size + pitfallStore.size;
}
function oldStamp(days) {
  return new Date(Date.now() - days * DAY).toISOString().slice(0, 19).replace("T", " ");
}
function seed(row) {
  const id = row.id || nextId++;
  memoryStore.set(id, { lifecycle_status: "active", invalid_at: null, updated_at: oldStamp(1), ...row, id });
  return id;
}

const longColdContent = [
  "生产环境 MySQL 连接池耗尽导致接口整片 502，这是归档排查记录，后续同类事故请先按此顺序核验。",
  "第一步先跑 https://ops.example.com/runbook/mysql-pool 上的标准流程，逐项记录连接数、等待队列与超时分布，",
  "并确认监控面板上「连接使用率」与「慢查询数」是否同时抬头，只有两者同步飙升才说明是池子被打满而不是下游变慢；",
  "第二步定位是否为长事务未提交，检查 src/integration/ncb.js 的 finally 分支是否漏了 release，",
  "同时翻一遍 src/services/audit/auditor.js 里的批量写库路径，确认每批结束后连接都被归还，没有在异常分支里被提前 return 掉；",
  "第三步看服务端日志里的 ERR_POOL_TIMEOUT 与 too many connections 是否在同一秒大量出现，",
  "如果两者时间戳完全对齐，基本可以判定是突发流量把池子瞬间打穿，而不是连接泄漏慢慢耗尽；",
  "第四步核对上游实例端口 3306 的监听数与 max_connections=500 是否已经打满，",
  "再用 SHOW PROCESSLIST 抽样看是否有大量 Sleep 状态的连接长期占位，Sleep 占比超过 60% 就要怀疑应用侧没有正确关闭；",
  "第五步把连接池归还超时从 30s 调到 10s 观察，若仍不下降则临时扩容读副本并限流，",
  "限流阈值先按峰值的 70% 设置，避免限流本身把正常请求也拦掉，观察两个发布周期后再逐步放开；",
  "第六步把本次判据写回运维手册，并补充告警阈值（使用率 > 85% 即预警），",
  "同时在值班交接单里注明：该故障的根因判据是 Sleep 连接占比而非绝对连接数，避免下一班同学误判方向。",
].join("\n");

cleanup();

// -----------------------------------------------------------------
// 1. compactColdContent：纯正则抽取压缩
// -----------------------------------------------------------------
console.log("▶ [1] compactColdContent 纯正则抽取：首句摘要 + 关键 Token + 字符节省 ≥60%");
{
  const res = compactColdContent(longColdContent);
  const tokens = res.tokens.join(" | ");
  assert.ok(res.original_length === longColdContent.length, "original_length 必须等于原文字符数");
  assert.ok(res.summary.length <= 120, `首句摘要必须 ≤120 字，实际 ${res.summary.length}`);
  assert.ok(res.summary.startsWith("生产环境 MySQL 连接池耗尽"), "摘要必须保留首句语义，不得从中间截断");
  assert.ok(res.text.length <= res.original_length * 0.4, `压缩后必须节省 ≥60% 字符（原文 ${res.original_length} → 实际 ${res.text.length}）`);
  assert.ok(res.saved_ratio >= 0.6, `saved_ratio 必须 ≥0.6，实际 ${res.saved_ratio.toFixed(3)}`);
  assert.ok(/runbook\/mysql-pool/.test(tokens), "必须正则提取出 URL Token");
  assert.ok(/ncb\.js/.test(tokens), "必须正则提取出文件路径 Token");
  assert.ok(/ERR_POOL_TIMEOUT/.test(tokens), "必须正则提取出错误码 Token");
  assert.ok(/3306/.test(tokens), "必须正则提取出端口 Token");
  assert.ok(/max_connections/.test(tokens), "必须正则提取出配置键值 Token");
  assert.ok(res.text.includes(res.summary) && res.text.includes("3306"), "浓缩正文必须同时含摘要与关键 Token");
  assert.notStrictEqual(res.text, longColdContent, "反证：压缩结果不得等于原文（否则等于没压缩）");

  // 反证：若只是粗暴截断前 120 字，URL / 错误码 / 端口必然全部丢失
  const naiveTruncate = longColdContent.slice(0, 120);
  assert.ok(!naiveTruncate.includes("3306") && res.text.includes("3306"),
    "反证：裸截断会丢端口，抽取式压缩必须保住端口——证明不是截断冒充压缩");

  const empty = compactColdContent("");
  assert.strictEqual(empty.text, "", "空输入必须返回空串，不得抛错");
  assert.strictEqual(empty.saved_ratio, 0, "空输入 saved_ratio 必须为 0");
  console.log(`  ✓ 抽取压缩通过：${res.original_length} → ${res.text.length} 字符（节省 ${(res.saved_ratio * 100).toFixed(1)}%），Token: ${tokens}`);
}

// -----------------------------------------------------------------
// 2. compactColdMemories：冷记忆判定 + full_text 原文留存 + tags 打标
// -----------------------------------------------------------------
console.log("\n▶ [2] compactColdMemories 冷记忆抽取压缩：原文留存 full_text、tags 追加 compacted");
{
  const expectedColdStamp = oldStamp(120);
  const idCold = seed({ project: testProject, category: "context", title: "MySQL 连接池事故归档", tags: "mysql,deploy", content: longColdContent, updated_at: expectedColdStamp });
  const idPrinciple = seed({ project: testProject, category: "principle", title: "连接池铁律", tags: "mysql", content: longColdContent, updated_at: oldStamp(120) });
  const idFresh = seed({ project: testProject, category: "context", title: "最新排查", tags: "mysql", content: longColdContent, updated_at: oldStamp(3) });
  const idShort = seed({ project: testProject, category: "context", title: "短记录", tags: "mysql", content: "短记忆不足 240 字，不参与冷压缩。", updated_at: oldStamp(200) });
  const idTagged = seed({ project: testProject, category: "context", title: "已压缩过", tags: "mysql,compacted", content: longColdContent, updated_at: oldStamp(300) });

  const res = await compactColdMemories(mockDbClient, { project: testProject, limit: 100 });
  assert.strictEqual(res.compacted, 1, `本次必须只压缩 1 条冷记忆，实际 ${res.compacted}`);
  assert.deepStrictEqual(res.ids, [idCold], "被压缩的记录必须正是那条冷记忆");

  const cold = memoryStore.get(idCold);
  assert.strictEqual(cold.full_text, longColdContent, "原文必须无损留存进 full_text");
  assert.ok(cold.content.length <= longColdContent.length * 0.4, "content 必须被替换为浓缩摘要");
  assert.ok(cold.content.includes("3306"), "浓缩正文必须保住端口等关键 Token");
  assert.ok(String(cold.tags).split(",").includes("compacted"), "tags 必须追加 compacted 标记");
  assert.ok(String(cold.tags).includes("mysql"), "原有 tags 必须保留，不得清空");
  // 【变异 M2 反证】冷压缩是后台瘦身维护，updated_at 必须与压缩前逐字节完全相等，严禁篡改时间戳导致冷记忆满血复活霸榜
  assert.strictEqual(cold.updated_at, expectedColdStamp, "【变异 M2 反证】压缩写库 payload 绝不得改写 updated_at，时间戳必须逐字节等于压缩前");

  assert.strictEqual(memoryStore.get(idPrinciple).content, longColdContent, "principle 类记忆绝不允许被压缩");
  assert.strictEqual(memoryStore.get(idFresh).content, longColdContent, "60 天内更新过的记忆绝不允许被压缩");
  assert.strictEqual(memoryStore.get(idShort).content, "短记忆不足 240 字，不参与冷压缩。", "≤240 字的记忆绝不允许被压缩");
  assert.strictEqual(memoryStore.get(idTagged).full_text, undefined, "带 compacted 标签的记录不得被改写（幂等）");
  assert.ok(!String(memoryStore.get(idPrinciple).tags).includes("compacted"), "principle 不得被打上 compacted 标签");

  // -----------------------------------------------------------------
  // 3. 幂等性：重复调用必须 0 条；【反证】幂等门真的在看 tags
  // -----------------------------------------------------------------
  console.log("\n▶ [3] 幂等性：二次调用 0 条；【反证】摘掉 compacted 标签后必须重新被压缩");
  const callsAfterFirst = updateCalls;
  const again = await compactColdMemories(mockDbClient, { project: testProject, limit: 100 });
  assert.strictEqual(again.compacted, 0, "二次调用必须 0 条（已带 compacted 标签绝不重复压缩）");
  assert.strictEqual(updateCalls, callsAfterFirst, "二次调用不得产生任何 update 写库动作");
  assert.strictEqual(memoryStore.get(idCold).content, cold.content, "幂等：二次调用后 content 不得再变");

  // 反证：把 idTagged 的 compacted 标签摘掉——它长、冷、非 principle，唯一挡住它的就是标签
  memoryStore.get(idTagged).tags = "mysql";
  const tampered = await compactColdMemories(mockDbClient, { project: testProject, limit: 100 });
  assert.strictEqual(tampered.compacted, 1, "反证：摘掉 compacted 标签后该条必须被重新压缩，证明幂等门确实在判定 tags");
  assert.deepStrictEqual(tampered.ids, [idTagged], "反证：被压缩的必须正是摘掉标签的那条记录");
  assert.strictEqual(memoryStore.get(idTagged).full_text, longColdContent, "反证：重新压缩时原文同样必须留存 full_text");
  console.log("  ✓ 冷压缩 + 幂等 + 反证全部通过");
}

// -----------------------------------------------------------------
// 4. memoryAudit 主动矛盾检测巡检
// -----------------------------------------------------------------
console.log("\n▶ [4] memoryAudit 矛盾巡检：同项目同主题数字冲突必须预警；反证三例不得误报");
{
  memoryStore.clear();
  pitfallStore.clear();
  const nowStamp = oldStamp(1);
  const ruleContent = (n, port) => `生产库 max_connections=${n}，端口 ${port}，超时 30s，超出即熔断。`;

  const idRuleA = seed({ project: testProject, category: "principle", title: "MySQL 连接池上限规范", tags: "mysql,rule", content: ruleContent(500, 3306), updated_at: nowStamp });
  const idRuleB = seed({ project: testProject, category: "principle", title: "MySQL 连接池上限规范", tags: "mysql,rule", content: ruleContent(1000, 3306), updated_at: nowStamp });

  // 反证一：同主题但数字完全一致 → 属于重复而非矛盾
  const idSame1 = seed({ project: testProject, category: "preference", title: "Redis 超时设定", tags: "redis,rule", content: ruleContent(200, 6379), updated_at: nowStamp });
  const idSame2 = seed({ project: testProject, category: "preference", title: "Redis 超时设定", tags: "redis,rule", content: ruleContent(200, 6379), updated_at: nowStamp });
  // 反证二：同项目但主题不同、数字也不同 → 不得误报
  const idDiff = seed({ project: testProject, category: "principle", title: "Redis 缓存穿透治理", tags: "redis", content: ruleContent(64, 6379), updated_at: nowStamp });
  // 反证三：跨项目同主题数字冲突 → 不得误报
  const idCross = seed({ project: otherProject, category: "principle", title: "MySQL 连接池上限规范", tags: "mysql,rule", content: ruleContent(4000, 3307), updated_at: nowStamp });

  // memoryAudit 经 jsonOut 序列化为 JSON 字符串返回（宿主层直接透传），此处解析后断言字段
  const auditRes = JSON.parse(await memoryAudit(mockDbClient, { project: testProject, audit_model: "off" }, { project: testProject }, {}));
  assert.strictEqual(auditRes.action, "DEDUP_REPORT", "审计必须返回 DEDUP_REPORT");
  assert.ok(Array.isArray(auditRes.contradictions), "审计结果必须输出 contradictions 预警数组");
  assert.strictEqual(auditRes.contradictions.length, 1, `必须且仅预警 1 组矛盾，实际 ${auditRes.contradictions.length}：${JSON.stringify(auditRes.contradictions)}`);

  const pair = auditRes.contradictions[0];
  const pairIds = [pair.a_id, pair.b_id].sort((x, y) => x - y);
  assert.deepStrictEqual(pairIds, [idRuleA, idRuleB].sort((x, y) => x - y), "矛盾对必须精确命中 500 与 1000 那两条规则");
  assert.strictEqual(pair.project, testProject, "矛盾预警必须携带 project");
  assert.ok(String(pair.a_title).includes("MySQL 连接池"), "矛盾预警必须携带可读标题");
  assert.ok(pair.numbers_a.length > 0 && pair.numbers_b.length > 0, "矛盾预警必须给出双方冲突数字");

  // 反证：把两条规则的数字改成一致后，同一次审计不得再报矛盾
  assert.ok(!auditRes.contradictions.some((c) => [c.a_id, c.b_id].includes(idSame1)), "反证：数字一致的同主题规则不得被判为矛盾");
  assert.ok(!auditRes.contradictions.some((c) => [c.a_id, c.b_id].includes(idDiff)), "反证：主题不同的规则不得被判为矛盾");
  assert.ok(!auditRes.contradictions.some((c) => [c.a_id, c.b_id].includes(idCross)), "反证：跨项目规则不得被判为矛盾");
  console.log(`  ✓ 矛盾巡检通过：精准命中 ${pair.a_id} ↔ ${pair.b_id}（${pair.numbers_a} vs ${pair.numbers_b}），三例反证均未误报`);
}

// -----------------------------------------------------------------
// 5. 隔离清理与残余断言
// -----------------------------------------------------------------
cleanup();
const residue = residueCount();
assert.strictEqual(residue, 0, "清理后残余必须为 0，杜绝污染真实库");
console.log(`\n▶ [5] 隔离清理完成：残余 ${residue} 条`);

console.log("\n=================================================================");
console.log("✅ v6.4.6-B 冷记忆抽取压缩 + 矛盾巡检测试 100% 通过！");
console.log("=================================================================");
