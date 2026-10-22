#!/usr/bin/env node
/**
 * tests/test_v646_c_feedback_and_explain.mjs
 *
 * 模块职责：v6.4.6-C 记忆质量反馈协议 + 检索可解释性追踪（explain:true）的针对性验证
 * 依赖：node:assert、tests/lib/testenv.mjs、tools.js、src/domain/scoring.js
 * 被依赖：tests/test_meta.mjs（计数锁定 91）、CI
 *
 * 覆盖点：
 *   1. memory_forget 反馈四分支：
 *      - not_helpful：confidence -25（下限 0），不写 invalid_at，记录仍可检索；
 *      - stale：软失效 + invalid_reason="feedback:stale" + action=FORGET；
 *      - wrong：软失效 + invalid_reason="feedback:wrong"；
 *      - 无 feedback：保持旧行为（SOFT_DELETE + invalid_reason="user_forgot"）。
 *   2. 【反证】非法 feedback（"banana"）必须抛错且绝不静默误删；pitfalls 表不接受 feedback。
 *   3. memory_get 的 feedback="helpful"：confidence +10（封顶 100）、recurrence +1，并回显 feedback_applied。
 *   4. memory_search / pitfall_search 的 explain:true：每条命中带完整 score_details，顶层带 timings 五段耗时。
 *   5. 【反证】explain 缺省（false）时零侵入：顶层键集合与旧格式逐字节一致，绝不出现 score_details / timings。
 *   6. 【契约级】对外 MCP inputSchema 必须显式声明 explain / feedback：
 *      memory_search.explain / pitfall_search.explain（boolean）
 *      memory_forget.feedback（enum not_helpful|stale|wrong）、memory_get.feedback（enum helpful）。
 *      只调 execute() 无法发现「漏声明」，故此处直接断言 args.properties（终审 QA-F1）。
 *   7. 【配置驱动】设置页 explain_debug 全链路：readOptions 透真布尔 → 工具层 explain 判定
 *      必须 `args.explain === true || cfg.explain_debug === true`，只勾开关也真实产出明细；
 *      开关关闭时必须精确回退到精简格式（终审 QA-F2）。
 *   8. 全流程零残留：清理后残余计数必须为 0。
 */
import assert from "node:assert";
import { createTestEnv } from "./lib/testenv.mjs";
import { MagpieMemoryHub } from "../tools.js";
import { explainScoreDetails, createExplainTimer } from "../src/domain/scoring.js";

const parseOut = (raw) => (typeof raw === "string" ? JSON.parse(raw) : raw);
const MEMORY_KEYS = [
  "total_active", "matched", "returned", "query_rewritten", "rewrite_used",
  "rerank_used", "rerank_model", "memories", "_agent_hint",
];
const PITFALL_KEYS = [
  "total_pitfalls", "matched", "returned", "query_rewritten", "rewrite_used",
  "rerank_used", "rerank_model", "pitfalls", "_agent_hint",
];
const TIMING_KEYS = ["total_ms", "rewrite_ms", "fetch_ms", "score_ms", "rerank_ms"];

const env = await createTestEnv();
const P = env.project;
const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

const hub = await MagpieMemoryHub(
  { search_rewrite: false, search_rerank: false, audit_model: "off" },
  { client: env.client, ncb_instance: env.instance }
);

const seedMemory = (title, extra = {}) => env.client.create("memories", Object.assign({
  project: P, category: "fact", scope_level: "project", client: "minis", origin: "tool",
  title, content: `${title} 正文：explainprobe 与反馈协议验证样本`,
  tags: "explainprobe,feedback", related_entities: "explainprobe",
  confidence_score: 100, recurrence: 1, retrieval_count: 0,
  last_used_at: nowSql(), updated_at: nowSql(), created_at: nowSql(),
  lifecycle_status: "active", invalid_at: null, invalid_reason: "", expires_at: null, revision: 1,
}, extra));

const seedPitfall = (symptom, extra = {}) => env.client.create("pitfalls", Object.assign({
  project: P, component: "explainprobe", symptom, root_cause: `explainprobe 根因：${symptom}`,
  solution: `explainprobe 解法：${symptom}`, severity: "medium", error_type: "test",
  tags: "explainprobe,feedback", recurrence: 2, last_occurred_at: nowSql(),
  updated_at: nowSql(), invalid_at: null, invalid_reason: "",
}, extra));

const rowOf = async (table, id) => {
  const rows = (await env.client.list(table, { id, limit: 1 })).data || [];
  return rows.filter((r) => Number(r.id) === Number(id))[0];
};

console.log("=================================================================");
console.log("【v6.4.6-C 记忆质量反馈协议 + 检索可解释性追踪】");
console.log("隔离命名空间 project:", P);
console.log("=================================================================\n");

const forget = hub.tool.memory_forget;
const get = hub.tool.memory_get;
const search = hub.tool.memory_search;
const pitSearch = hub.tool.pitfall_search;

/* -----------------------------------------------------------------
 * 1. 反馈分支：not_helpful 降权而不失效
 * ----------------------------------------------------------------- */
{
  const m = await seedMemory("反馈降权样本", { confidence_score: 100 });
  const res = parseOut(await forget.execute({ id: m.id, feedback: "not_helpful", project: P }));
  assert.strictEqual(res.ok, true, "not_helpful 必须返回 ok:true");
  assert.strictEqual(res.action, "FEEDBACK_DOWNVOTE", "not_helpful 必须返回 FEEDBACK_DOWNVOTE 而不是 FORGET");
  assert.strictEqual(res.confidence_score, 75, "not_helpful 必须精确降低 25 分（100 → 75）");
  assert.strictEqual(res.id, m.id, "降权回包必须携带 id");

  const row = await rowOf("memories", m.id);
  assert.strictEqual(Number(row.confidence_score), 75, "库内 confidence_score 必须落库为 75");
  assert.ok(!row.invalid_at, "not_helpful 绝不写 invalid_at（记录必须仍在检索池内）");
  assert.strictEqual(row.lifecycle_status, "active", "not_helpful 后生命周期必须保持 active");

  // 下限保护：连续降权不得出现负分
  await forget.execute({ id: m.id, feedback: "not_helpful", project: P });
  const floorRes = parseOut(await forget.execute({ id: m.id, feedback: "not_helpful", project: P }));
  assert.strictEqual(floorRes.confidence_score, 25, "第三次降权后应为 25");
  const zeroRes = parseOut(await forget.execute({ id: m.id, feedback: "not_helpful", project: P }));
  assert.strictEqual(zeroRes.confidence_score, 0, "第四次降权触底为 0");
  const clampRes = parseOut(await forget.execute({ id: m.id, feedback: "not_helpful", project: P }));
  assert.strictEqual(clampRes.confidence_score, 0, "触底后继续降权必须夹紧在 0，绝不为负");
  console.log(`  ✓ not_helpful：100 → 75 → … → 0（夹紧），始终未写 invalid_at`);
}

/* -----------------------------------------------------------------
 * 2. 反馈分支：stale / wrong 软失效
 * ----------------------------------------------------------------- */
for (const fb of ["stale", "wrong"]) {
  const m = await seedMemory(`反馈软失效样本-${fb}`);
  const res = parseOut(await forget.execute({ id: m.id, feedback: fb, project: P }));
  assert.strictEqual(res.ok, true, `${fb} 必须返回 ok:true`);
  assert.strictEqual(res.action, "FORGET", `${fb} 必须返回 action=FORGET`);
  assert.strictEqual(res.reason, `feedback:${fb}`, `${fb} 回包 reason 必须为 feedback:${fb}`);

  const row = await rowOf("memories", m.id);
  assert.ok(row.invalid_at, `${fb} 必须在库内写入 invalid_at（软失效而非物理删除）`);
  assert.strictEqual(row.invalid_reason, `feedback:${fb}`, `${fb} 必须精确记录 invalid_reason`);
  assert.strictEqual(row.lifecycle_status, "invalid", `${fb} 后生命周期必须转 invalid`);

  const found = parseOut(await search.execute({ query: "explainprobe", project: P, search_rerank: false }));
  assert.ok(!found.memories.some((x) => Number(x.id) === Number(m.id)), `${fb} 软失效记录必须从检索结果中消失`);
  assert.ok(row.title, `${fb} 记录正文保留可追溯（仅软失效）`);
  console.log(`  ✓ ${fb}：invalid_at 已写入，reason=feedback:${fb}，检索已排除`);
}

/* -----------------------------------------------------------------
 * 3. 无 feedback：旧行为保持不变
 * ----------------------------------------------------------------- */
{
  const m = await seedMemory("普通软删除样本");
  const res = parseOut(await forget.execute({ id: m.id, project: P }));
  assert.strictEqual(res.action, "SOFT_DELETE", "无 feedback 时必须保持旧 SOFT_DELETE 语义");
  assert.strictEqual(res.forgotten, 1, "无 feedback 时删除条数必须为 1");
  const row = await rowOf("memories", m.id);
  assert.strictEqual(row.invalid_reason, "user_forgot", "无 feedback 时 invalid_reason 必须仍为 user_forgot");
  assert.ok(row.invalid_at, "无 feedback 时必须写入 invalid_at");
  console.log("  ✓ 无 feedback：SOFT_DELETE + invalid_reason=user_forgot 行为未变");
}

/* -----------------------------------------------------------------
 * 4. 反证：非法 feedback 绝不静默误删
 * ----------------------------------------------------------------- */
{
  const m = await seedMemory("反证-非法反馈不得误删", { confidence_score: 90 });
  await assert.rejects(
    () => forget.execute({ id: m.id, feedback: "banana", project: P }),
    /不支持的 feedback/,
    "反证：非法 feedback 必须显式报错，不得静默回落成软删除"
  );
  const row = await rowOf("memories", m.id);
  assert.ok(!row.invalid_at, "反证：非法 feedback 报错后记录绝不能被失效");
  assert.strictEqual(Number(row.confidence_score), 90, "反证：非法 feedback 报错后 confidence 不得被改动");

  const pit = await seedPitfall("反证-踩坑表不接受 feedback");
  await assert.rejects(
    () => forget.execute({ id: pit.id, feedback: "stale", table: "pitfalls", project: P }),
    /仅支持 memories/,
    "反证：pitfalls 表传入 feedback 必须报错，避免用记忆反馈语义污染踩坑表"
  );
  const pitRow = await rowOf("pitfalls", pit.id);
  assert.ok(!pitRow.invalid_at, "反证：报错后踩坑记录不得被失效");
  console.log("  ✓ 反证：非法 feedback / pitfalls+feedback 均显式报错且零副作用");
}

/* -----------------------------------------------------------------
 * 5. memory_get 的 helpful 提权
 * ----------------------------------------------------------------- */
{
  const m = await seedMemory("反馈提权样本-封顶", { confidence_score: 100, recurrence: 1 });
  const res = parseOut(await get.execute({ id: m.id, feedback: "helpful", project: P }));
  assert.strictEqual(res.feedback_applied, "helpful", "helpful 必须在返回 JSON 中回显 feedback_applied");
  assert.strictEqual(res.id, m.id, "提权返回体必须携带 id");
  let row = await rowOf("memories", m.id);
  assert.strictEqual(Number(row.confidence_score), 100, "confidence 必须封顶 100（100 分记录提权后仍为 100）");
  assert.strictEqual(Number(row.recurrence), 2, "helpful 必须使 recurrence +1");
  assert.strictEqual(Number(row.retrieval_count), 1, "helpful 顺带累加一次访问热度");

  const m2 = await seedMemory("反馈提权样本-加10", { confidence_score: 70, recurrence: 1 });
  await get.execute({ id: m2.id, feedback: "helpful", project: P });
  row = await rowOf("memories", m2.id);
  assert.strictEqual(Number(row.confidence_score), 80, "helpful 必须精确提升 10 分（70 → 80）");
  assert.strictEqual(Number(row.recurrence), 2, "第二条样本 recurrence 同样 +1");

  const plain = parseOut(await get.execute({ id: m2.id, project: P }));
  assert.ok(!("feedback_applied" in plain), "未传 feedback 时返回体不得凭空出现 feedback_applied（零侵入）");
  console.log("  ✓ helpful：+10 封顶 100、recurrence +1、回显 feedback_applied，默认路径无该字段");
}

/* -----------------------------------------------------------------
 * 6. 批量读取同样支持 helpful
 * ----------------------------------------------------------------- */
{
  const b1 = await seedMemory("批量提权样本-1", { confidence_score: 50 });
  const b2 = await seedMemory("批量提权样本-2", { confidence_score: 60 });
  const res = parseOut(await get.execute({ ids: [b1.id, b2.id], feedback: "helpful", project: P }));
  assert.ok(Array.isArray(res), "批量读取必须返回数组");
  assert.strictEqual(res.length, 2, "批量读取必须返回两条");
  assert.ok(res.every((x) => x.feedback_applied === "helpful"), "批量路径每一条都必须回显 feedback_applied");
  assert.strictEqual(Number((await rowOf("memories", b1.id)).confidence_score), 60, "批量路径第一条 50 → 60");
  assert.strictEqual(Number((await rowOf("memories", b2.id)).confidence_score), 70, "批量路径第二条 60 → 70");
  console.log("  ✓ 批量读取 helpful：逐条回显并提权");
}

/* -----------------------------------------------------------------
 * 7. explainScoreDetails 单元级：实体加权真实生效
 * ----------------------------------------------------------------- */
{
  const detail = explainScoreDetails(
    { title: "连接池", tags: "mysql", related_entities: "dbpool,redis", content: "正文 irrelevant",
      confidence_score: 80, recurrence: 2, retrieval_count: 6, last_used_at: nowSql() },
    ["dbpool", "nomatch"]
  );
  assert.strictEqual(detail.lexical_score, 3, "实体命中必须计入词面分（实体权重 3 分/词）");
  assert.strictEqual(detail.entity_weight, 3, "实体加权必须单列：1 个实体命中 × 3 分");
  assert.strictEqual(detail.confidence, 80, "明细必须透出 confidence");
  assert.ok(detail.freshness_factor > 0 && detail.freshness_factor <= 1, "新鲜度因子必须落在 (0,1]");
  assert.ok(detail.rank_score > 0, "综合排序分必须为正");

  // 反证：同样查询但实体不命中 → entity_weight 必须为 0
  const miss = explainScoreDetails({ title: "无关标题", tags: "", related_entities: "", content: "无命中正文" }, ["dbpool"]);
  assert.strictEqual(miss.entity_weight, 0, "反证：实体不命中时 entity_weight 必须为 0");
  assert.strictEqual(miss.lexical_score, 0, "反证：完全无关的记录词面分必须为 0");

  const offTimer = createExplainTimer(false);
  offTimer.mark("fetch");
  assert.deepStrictEqual(offTimer.report(), { total_ms: 0, rewrite_ms: 0, fetch_ms: 0, score_ms: 0, rerank_ms: 0 },
    "反证：explain 关闭时计时器必须为空操作，不得产生任何真实耗时字段");
  console.log("  ✓ 明细单元：实体加权 3 分/词，新鲜度/排序分合理，关闭时计时器空转");
}

/* -----------------------------------------------------------------
 * 8. memory_search explain:true 结构
 * ----------------------------------------------------------------- */
{
  await seedMemory("可解释性检索样本-甲", { confidence_score: 95, related_entities: "explainprobe" });
  const ex = parseOut(await search.execute({ query: "explainprobe", project: P, explain: true, search_rerank: false }));
  assert.ok(ex.memories.length >= 1, "explain:true 必须仍然返回命中记录");
  assert.ok(ex.timings, "explain:true 必须在顶层返回 timings");
  assert.deepStrictEqual(Object.keys(ex.timings).sort(), [...TIMING_KEYS].sort(), "timings 必须完整包含五段耗时");
  for (const k of TIMING_KEYS) {
    assert.strictEqual(typeof ex.timings[k], "number", `timings.${k} 必须为数字`);
    assert.ok(ex.timings[k] >= 0, `timings.${k} 必须非负`);
  }
  const phaseSum = ex.timings.rewrite_ms + ex.timings.fetch_ms + ex.timings.score_ms + ex.timings.rerank_ms;
  assert.ok(ex.timings.total_ms + 5 >= phaseSum, `total_ms(${ex.timings.total_ms}) 不得小于各阶段之和(${phaseSum})`);

  const top = ex.memories[0];
  assert.ok(top.score_details, "explain:true 时每条命中必须携带 score_details");
  for (const k of ["lexical_score", "rewrite_score", "entity_weight", "freshness_factor", "rank_score", "confidence", "fusion_score", "final_rank"]) {
    assert.ok(k in top.score_details, `score_details 必须包含 ${k}`);
  }
  assert.strictEqual(top.score_details.rewrite_score, 0, "未改写时改写词面分必须为 0");
  assert.ok(top.score_details.lexical_score > 0, "命中记录词面分必须 > 0");
  assert.ok(top.score_details.entity_weight >= 3, "命中 related_entities 必须产生实体加权");
  assert.strictEqual(top.score_details.fusion_score, top._hit, "fusion_score 必须与 _hit 一致");
  assert.ok(ex.memories.every((x, i) => x.score_details.final_rank === i + 1), "final_rank 必须与返回次序一致");
  console.log(`  ✓ memory_search explain：命中 ${ex.memories.length} 条，score_details 9 字段 + timings 五段齐全`);
}

/* -----------------------------------------------------------------
 * 9. memory_search 缺省零侵入（与旧格式逐字节兼容）
 * ----------------------------------------------------------------- */
{
  const plain = parseOut(await search.execute({ query: "explainprobe", project: P, search_rerank: false }));
  assert.deepStrictEqual(Object.keys(plain), MEMORY_KEYS, "缺省 explain 时顶层键集合与顺序必须与旧格式完全一致");
  assert.ok(plain.memories.every((m) => !("score_details" in m)), "反证：缺省 explain 时命中记录不得出现 score_details");
  assert.ok(!("timings" in plain), "反证：缺省 explain 时不得出现 timings");
  assert.ok(plain.memories.every((m) => !("final_rank" in m)), "反证：缺省 explain 时不得出现 final_rank");

  const explicitOff = parseOut(await search.execute({ query: "explainprobe", project: P, explain: false, search_rerank: false }));
  assert.deepStrictEqual(Object.keys(explicitOff), MEMORY_KEYS, "explain:false 必须与缺省表现完全一致");
  assert.ok(!("timings" in explicitOff), "explain:false 不得输出 timings");
  console.log("  ✓ 缺省 / explain:false：键集合与旧格式逐字节一致，零多余字段");
}

/* -----------------------------------------------------------------
 * 10. pitfall_search explain:true 与缺省零侵入
 * ----------------------------------------------------------------- */
{
  await seedPitfall("可解释性踩坑样本");
  const ex = parseOut(await pitSearch.execute({ query: "explainprobe", project: P, explain: true, search_rerank: false }));
  assert.ok(ex.pitfalls.length >= 1, "pitfall_search explain:true 必须返回命中");
  assert.deepStrictEqual(Object.keys(ex.timings).sort(), [...TIMING_KEYS].sort(), "踩坑检索 timings 同样必须五段齐全");
  const top = ex.pitfalls[0];
  assert.ok(top.score_details, "踩坑命中必须携带 score_details");
  for (const k of ["lexical_score", "rewrite_score", "recurrence_weight", "freshness_factor", "rank_score", "fusion_score", "final_rank"]) {
    assert.ok(k in top.score_details, `踩坑 score_details 必须包含 ${k}`);
  }
  assert.ok(top.score_details.lexical_score > 0, "踩坑词面分必须 > 0");
  assert.ok(top.score_details.recurrence_weight > 0, "复发权重必须 > 0（recurrence=2）");

  const plain = parseOut(await pitSearch.execute({ query: "explainprobe", project: P, search_rerank: false }));
  assert.deepStrictEqual(Object.keys(plain), PITFALL_KEYS, "反证：缺省 explain 时踩坑检索顶层键集合必须与旧格式一致");
  assert.ok(plain.pitfalls.every((p) => !("score_details" in p)), "反证：缺省 explain 时踩坑命中不得出现 score_details");
  assert.ok(!("timings" in plain), "反证：缺省 explain 时踩坑检索不得出现 timings");
  console.log("  ✓ pitfall_search explain：明细 + timings 齐全；缺省零侵入");
}

/* -----------------------------------------------------------------
 * 11. 【契约级】对外 MCP inputSchema 必须显式声明 explain / feedback
 *
 * 为什么必须单独断言：execute() 跑通只证明「内部实现存在」，
 * 而对外契约活在 args.properties 里——漏声明即等于参数永远传不进来，
 * 能力对调用方（LLM / 宿主）根本不存在（终审 QA-F1：假闭环）。
 * 所以此处直接读 hub.tool.<name>.args.properties，而非调 execute()。
 * ----------------------------------------------------------------- */
{
  const assertProp = (toolName, tool, prop, type, keywords) => {
    assert.ok(tool.args, `${toolName} 必须有 args 契约`);
    assert.strictEqual(tool.args.type, "object", `${toolName}.args.type 必须为 object`);
    assert.ok(tool.args.properties, `${toolName}.args.properties 必须存在`);
    const p = tool.args.properties[prop];
    assert.ok(p, `契约：${toolName}.args.properties 必须显式声明 ${prop}`);
    assert.strictEqual(p.type, type, `${toolName}.${prop} 必须声明 type=${type}`);
    assert.strictEqual(typeof p.description, "string", `${toolName}.${prop} 必须带 description（否则 LLM 不知道何时用）`);
    for (const kw of keywords) {
      assert.ok(p.description.includes(kw), `${toolName}.${prop} 的 description 必须说明「${kw}」，实际：${p.description}`);
    }
    return p;
  };

  const sProp = assertProp("memory_search", search, "explain", "boolean", ["是否", "默认 false"]);
  assert.ok(/打分|评分/.test(sProp.description), "memory_search.explain 描述必须说明返回打分明细");
  assert.ok(/耗时|timings/.test(sProp.description), "memory_search.explain 描述必须说明返回耗时明细");

  const pProp = assertProp("pitfall_search", pitSearch, "explain", "boolean", ["是否", "默认 false"]);
  assert.ok(/打分|评分/.test(pProp.description), "pitfall_search.explain 描述必须说明打分明细");
  assert.ok(/耗时|timings/.test(pProp.description), "pitfall_search.explain 描述必须说明耗时明细");

  const fProp = assertProp("memory_forget", forget, "feedback", "string", ["置信度"]);
  assert.deepStrictEqual(fProp.enum, ["not_helpful", "stale", "wrong"],
    "memory_forget.feedback 必须用 enum 精确锁死三档，杜绝自由文本被当成合法反馈");
  assert.ok(/stale|wrong/.test(fProp.description), "memory_forget.feedback 描述必须说明 stale/wrong 的软失效语义");

  const gProp = assertProp("memory_get", get, "feedback", "string", ["置信度"]);
  assert.deepStrictEqual(gProp.enum, ["helpful"], "memory_get.feedback 必须用 enum 锁死为 helpful（不得混入降权档位）");
  assert.ok(/recurrence|复发/.test(gProp.description), "memory_get.feedback 描述必须说明累加复发度");

  // 反证 a：新增参数只能是「追加」，不得顺手删掉任何既有契约字段
  assert.ok(search.args.properties.query, "反证：补 explain 后 memory_search.query 必须仍在");
  assert.ok(search.args.properties.search_rerank, "反证：补 explain 后 memory_search.search_rerank 必须仍在");
  assert.ok(pitSearch.args.properties.query, "反证：补 explain 后 pitfall_search.query 必须仍在");
  assert.ok(forget.args.properties.id && forget.args.properties.ids && forget.args.properties.query,
    "反证：补 feedback 后 memory_forget 的 id/ids/query 必须全部仍在");
  assert.ok(get.args.properties.id && get.args.properties.ids && get.args.properties.table,
    "反证：补 feedback 后 memory_get 的 id/ids/table 必须全部仍在");

  // 反证 b：required 不得因新增可选参数而变（explain / feedback 都是可选的）
  assert.deepStrictEqual(search.args.required || [], [], "反证：memory_search 不得有必填项");
  assert.ok(!(forget.args.required || []).includes("feedback"), "反证：feedback 是可选参数，绝不能进 required");
  assert.ok(!(get.args.required || []).includes("feedback"), "反证：feedback 是可选参数，绝不能进 required");

  // 反证 c：契约声明必须与真实实现同源——声明了却读不到就是假契约
  const mem = await seedMemory("契约同源样本", { confidence_score: 90 });
  const viaSchema = parseOut(await search.execute({ query: "explainprobe", project: P, explain: true, search_rerank: false }));
  assert.ok(viaSchema.timings && viaSchema.memories.some((x) => x.score_details),
    "反证：schema 声明了 explain 就必须真的产出 timings / score_details");
  const forgetViaSchema = parseOut(await forget.execute({ id: mem.id, feedback: "not_helpful", project: P }));
  assert.strictEqual(forgetViaSchema.action, "FEEDBACK_DOWNVOTE", "反证：schema 声明了 feedback 就必须真的生效");
  console.log("  ✓ 契约：4 个工具的 explain/feedback 显式声明齐全，enum 锁死，既有字段零回退");
}

/* -----------------------------------------------------------------
 * 12. 设置页 explain_debug 配置全链路（终审 QA-F2：写而不读 = 假承诺）
 *
 * 真实用户路径：设置页勾选「检索可解释性追踪」→ options.explain_debug=true
 * → readOptions 必须原样带出 → 工具里 explain 判定必须把配置算进去。
 * 任何一环断掉，用户看到的都是「勾了没反应」，故逐环反证。
 * ----------------------------------------------------------------- */
{
  // 环节 1：配置解析层——必须产出真布尔，且严格只认 true
  assert.strictEqual(MagpieMemoryHub.readOptions({ explain_debug: true }).explain_debug, true,
    "readOptions 必须把 explain_debug:true 原样透出（F2 断链点 1）");
  assert.strictEqual(MagpieMemoryHub.readOptions({}).explain_debug, false,
    "explain_debug 缺省必须归一化为布尔 false，绝不能是 undefined");
  assert.strictEqual(MagpieMemoryHub.readOptions({ explain_debug: "true" }).explain_debug, false,
    "反证：字符串 \"true\" 不得被当成开启（设置页用 !!checked 落盘，只认真布尔）");
  assert.strictEqual(MagpieMemoryHub.readOptions({ explain_debug: 1 }).explain_debug, false,
    "反证：数字 1 也不得被当成开启，杜绝真值漂移");

  // 环节 2：工具层——只勾设置页、完全不传 explain，也必须真实产出明细
  const debugHub = await MagpieMemoryHub(
    { search_rewrite: false, search_rerank: false, audit_model: "off" },
    { client: env.client, ncb_instance: env.instance, explain_debug: true }
  );
  await seedMemory("配置驱动样本-甲", { confidence_score: 92, related_entities: "explainprobe" });
  await seedPitfall("配置驱动踩坑样本");

  const cfgSearch = parseOut(await debugHub.tool.memory_search.execute({ query: "explainprobe", project: P, search_rerank: false }));
  assert.ok(cfgSearch.timings, "配置驱动：勾选 explain_debug 后不传 explain 也必须产出 timings");
  assert.deepStrictEqual(Object.keys(cfgSearch.timings).sort(), [...TIMING_KEYS].sort(),
    "配置驱动的 timings 必须同样五段齐全");
  assert.ok(cfgSearch.memories.length >= 1, "配置驱动检索必须仍然返回命中");
  assert.ok(cfgSearch.memories.every((x) => x.score_details && typeof x.score_details.lexical_score === "number"),
    "配置驱动时每条命中都必须带 score_details");
  assert.ok(cfgSearch.memories.every((x, i) => x.score_details.final_rank === i + 1),
    "配置驱动的 final_rank 必须与返回次序一致");

  const cfgPit = parseOut(await debugHub.tool.pitfall_search.execute({ query: "explainprobe", project: P, search_rerank: false }));
  assert.ok(cfgPit.timings, "配置驱动：pitfall_search 同样必须产出 timings");
  assert.deepStrictEqual(Object.keys(cfgPit.timings).sort(), [...TIMING_KEYS].sort(),
    "踩坑配置驱动 timings 必须五段齐全");
  assert.ok(cfgPit.pitfalls.length >= 1 && cfgPit.pitfalls.every((x) => x.score_details),
    "配置驱动时每条踩坑命中都必须带 score_details");

  // 环节 3：配置是全局调试开关，优先级高于单次入参（args.explain===false 也压不掉）
  const forced = parseOut(await debugHub.tool.memory_search.execute({ query: "explainprobe", project: P, explain: false, search_rerank: false }));
  assert.ok(forced.timings, "反证：设置页已开启时，单次 explain:false 不得把全局调试开关关掉（调试开关必须可预期）");

  // 反证：同一份数据、开关关闭 → 必须回到精简格式，证明「有明细」确实来自配置而非永远存在
  const quietHub = await MagpieMemoryHub(
    { search_rewrite: false, search_rerank: false, audit_model: "off" },
    { client: env.client, ncb_instance: env.instance, explain_debug: false }
  );
  const quiet = parseOut(await quietHub.tool.memory_search.execute({ query: "explainprobe", project: P, search_rerank: false }));
  assert.deepStrictEqual(Object.keys(quiet), MEMORY_KEYS, "反证：开关关闭时顶层键集合必须与旧格式完全一致");
  assert.ok(!("timings" in quiet), "反证：开关关闭时不得凭空产出 timings");
  assert.ok(quiet.memories.every((m) => !("score_details" in m)), "反证：开关关闭时命中不得带 score_details");
  console.log("  ✓ 配置链路：readOptions→工具判定→真实明细，开关关闭时精确回退到精简格式");
}

/* -----------------------------------------------------------------
 * 13. 隔离清理与残余断言
 * ----------------------------------------------------------------- */
const residue = await env.countAllTestResidue();
await env.cleanup();
const after = await env.countAllTestResidue();
assert.strictEqual(after.total, 0, `清理后残余必须为 0，杜绝污染真实库（清理前 ${residue.total}）`);
console.log(`\n▶ 隔离清理完成：清理前残余 ${residue.total} 条 → 清理后 ${after.total} 条`);

console.log("\n=================================================================");
console.log("✅ v6.4.6-C 反馈协议 + 检索可解释性追踪测试 100% 通过！");
console.log("=================================================================");
