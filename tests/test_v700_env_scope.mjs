/**
 * test_v700_env_scope.mjs
 * v7.0.0 env_scope 真列、提炼侧 applies_to、负反馈与能力遥测的对抗回归。
 *
 * 锁住四条不变量：
 *   ① 保存侧：显式 env_scope 与 env: 保留标签两条路径归一为同一格式；
 *   ② 去重侧：作用域取并集，不是覆盖（否则二次写入会丢失旧环境标记）；
 *   ③ 提炼侧：平台限定事实必须自动带上作用域，不得写成无修饰的普遍事实；
 *   ④ 遥测侧：幻觉累计到阈值后必须给出降档画像建议。
 *
 * 纯离线：零网络（模型调用用受控 mock），零真实数据库（内存桩）。
 */
import assert from "node:assert";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { saveMemory } from "../src/services/save/memory-saver.js";
import { memoryForget } from "../src/tools/memory-forget.js";
import { harvestWithOnlineModel } from "../src/services/harvest/extract.js";
import { appliesToToScope, normalizeEnvScope, mergeEnvScope } from "../src/domain/env-scope.js";
import { _resetRecentWrite } from "../src/core/state-recent.js";

let pass = 0;
const fail = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  OK   " + name);
  } catch (e) {
    fail.push(name + " :: " + (e && e.message));
    console.log("  FAIL " + name + " :: " + (e && e.message));
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  OK   " + name);
  } catch (e) {
    fail.push(name + " :: " + (e && e.message));
    console.log("  FAIL " + name + " :: " + (e && e.message));
  }
}

const NL = String.fromCharCode(10);
const TEST_PROJECT = "proj_test_env_scope_v700";

/* 受控内存桩：严禁碰真实库（test_meta 规范要求） */
const memoryStore = new Map();
const pitfallStore = new Map();
let nextId = 1;

const mockDbClient = {
  create: async (table, data) => {
    const id = nextId++;
    const row = Object.assign({ id }, data);
    (table === "memories" ? memoryStore : pitfallStore).set(id, row);
    return row;
  },
  list: async (table, params = {}) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    let rows = Array.from(store.values());
    if (params.project) rows = rows.filter((r) => r.project === params.project);
    if (params.lifecycle_status) rows = rows.filter((r) => r.lifecycle_status === params.lifecycle_status);
    return { data: rows, metadata: { hasMore: false } };
  },
  update: async (table, id, data) => {
    const store = table === "memories" ? memoryStore : pitfallStore;
    const cur = store.get(id);
    if (!cur) return { affectedRows: 0 };
    store.set(id, Object.assign({}, cur, data));
    return { affectedRows: 1 };
  },
  remove: async (table, id) => {
    (table === "memories" ? memoryStore : pitfallStore).delete(id);
    return { affectedRows: 1 };
  },
  raw: async () => ({ data: [] }),
};

const cfg = { project: TEST_PROJECT, crystallization_threshold: 99, min_confidence: 0.6, fetch_limit: 200 };

function cleanup() {
  memoryStore.clear();
  pitfallStore.clear();
  nextId = 1;
}

/* ================= 1. 归一与合并 ================= */
console.log(NL + "▶ [1] env_scope 归一与合并");

check("排序去重并小写", () => {
  assert.strictEqual(normalizeEnvScope("OS=Windows, arch=AMD64 , os=windows"), "arch=amd64,os=windows");
});
check("非法片段丢弃而不抛错", () => {
  assert.strictEqual(normalizeEnvScope("os=windows,,foo,=,arch"), "os=windows");
});
check("合并取并集（反证：不得覆盖）", () => {
  assert.strictEqual(mergeEnvScope("os=windows", "arch=amd64"), "arch=amd64,os=windows");
  assert.strictEqual(mergeEnvScope("agent=a", "agent=b"), "agent=a|b");
});
check("applies_to 自然语言归一", () => {
  assert.strictEqual(appliesToToScope("仅限 Windows"), "os=windows");
  assert.strictEqual(appliesToToScope("os=linux,arch=arm64"), "arch=arm64,os=linux");
  assert.strictEqual(appliesToToScope(""), "");
  assert.strictEqual(appliesToToScope("arm64 / alpine"), "agent=alpine,arch=arm64");
});

/* ================= 2. 保存侧 ================= */
console.log(NL + "▶ [2] 保存侧写入 env_scope");

await checkAsync("显式 env_scope 归一后入库", async () => {
  cleanup();
  const r = await saveMemory(mockDbClient, cfg, {
    project: TEST_PROJECT, title: "win-only", content: "仅在 Windows 上生效的配置",
    category: "fact", env_scope: "OS=Windows",
  }, {});
  const row = memoryStore.get(r.id);
  assert.strictEqual(row.env_scope, "os=windows");
});

await checkAsync("env: 保留标签自动推导（零迁移路径）", async () => {
  cleanup();
  const r = await saveMemory(mockDbClient, cfg, {
    project: TEST_PROJECT, title: "tag-derived", content: "从 related_entities 推导作用域",
    category: "fact", related_entities: "docker,env:arch=arm64",
  }, {});
  assert.strictEqual(memoryStore.get(r.id).env_scope, "arch=arm64");
});

await checkAsync("二次写入去重时作用域取并集", async () => {
  cleanup();
  /* 必须先清进程内「刚写过」缓存：不清的话第二次写会走 justWritten 快路径直接 NOOP，
   * 根本不会进入去重合并分支，测的就不是并集逻辑了（真实部署中间隔远超 2s 窗口）。 */
  _resetRecentWrite();
  await saveMemory(mockDbClient, cfg, {
    project: TEST_PROJECT, title: "merge-case", content: "同一条事实的完整描述文本",
    category: "fact", env_scope: "os=windows",
  }, {});
  _resetRecentWrite();
  const r2 = await saveMemory(mockDbClient, cfg, {
    project: TEST_PROJECT, title: "merge-case", content: "同一条事实的完整描述文本",
    category: "fact", env_scope: "arch=amd64",
  }, {});
  const rows = Array.from(memoryStore.values());
  assert.strictEqual(rows.length, 1, "指纹相同不得新增行");
  assert.strictEqual(rows[0].env_scope, "arch=amd64,os=windows", "作用域必须取并集，反证：覆盖会丢掉 os=windows");
  assert.ok(r2);
});

/* ================= 3. 提炼侧 ================= */
console.log(NL + "▶ [3] 提炼侧 applies_to → env_scope");

await checkAsync("模型给的 applies_to 落入 env_scope", async () => {
  const items = [
    { category: "fact", title: "仅 Win 有效", content: "注册表改法", tags: "win,reg", confidence: 0.95, applies_to: "仅限 Windows" },
    { category: "fact", title: "通用事实", content: "任何平台都适用", tags: "common", confidence: 0.95, applies_to: "" },
  ];
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(items) } }] }),
  });
  const out = await harvestWithOnlineModel("[user]: 对话正文", {
    extract_model: "mock-model", _fetch: mockFetch, min_confidence: 0.6,
  });
  assert.ok(out && Array.isArray(out.memories));
  const win = out.memories.find((m) => m.title === "仅 Win 有效");
  const generic = out.memories.find((m) => m.title === "通用事实");
  assert.strictEqual(win.env_scope, "os=windows");
  assert.strictEqual(generic.env_scope, "", "通用事实不得被莫名加上作用域");
});

/* ================= 4. 负反馈（复用 memory_forget，不另起通道） ================= */
console.log(NL + "▶ [4] 负反馈走 memory_forget");

await checkAsync("not_helpful 降置信度且不碰 recurrence", async () => {
  cleanup();
  const r = await saveMemory(mockDbClient, cfg, {
    project: TEST_PROJECT, title: "fb", content: "待反馈的记忆正文", category: "fact", confidence: 1,
  }, {});
  const before = memoryStore.get(r.id);
  const rec0 = Number(before.recurrence) || 1;
  await memoryForget(mockDbClient, cfg, { id: r.id, feedback: "not_helpful" });
  const after = memoryStore.get(r.id);
  assert.ok(Number(after.confidence_score) < Number(before.confidence_score), "not_helpful 必须降置信度");
  assert.strictEqual(Number(after.recurrence) || 1, rec0, "负反馈不得增加复发度");
  assert.ok(!after.invalid_at, "not_helpful 只降权，不软失效");
});

await checkAsync("wrong 软失效并留审计痕迹（不物理删除）", async () => {
  cleanup();
  const r = await saveMemory(mockDbClient, cfg, {
    project: TEST_PROJECT, title: "fb2", content: "写错了的记忆正文", category: "fact", confidence: 1,
  }, {});
  await memoryForget(mockDbClient, cfg, { id: r.id, feedback: "wrong" });
  const after = memoryStore.get(r.id);
  assert.ok(after.invalid_at, "wrong 必须软失效");
  assert.ok(String(after.invalid_reason || "").length > 0, "必须留 invalid_reason 审计痕迹");
  assert.ok(memoryStore.has(r.id), "软失效不得物理删除");
});

/* ================= 5. 能力遥测 ================= */
console.log(NL + "▶ [5] 能力遥测与降档建议");

const tmpHome = path.join(os.tmpdir(), "memhub-caps-home-" + process.pid);
fs.mkdirSync(tmpHome, { recursive: true });
const realHome = process.env.HOME;
process.env.HOME = tmpHome;

const capsStats = await import("../src/services/caps-stats.js");

await checkAsync("累计三次幻觉后给出降档建议", async () => {
  capsStats._resetCapsStatsCache();
  for (let i = 0; i < 3; i++) {
    const ctx = {
      state: {
        capsTelemetry: {
          at: Date.now(), agent: "ishellpro", tier: 1, injected: true, hasTools: true, present: false,
          toolCalls: 1, memoryToolCalls: 0, hallucinatedCount: 1,
          hallucinated: [{ name: "magpie-memory-hub_memory_context", kind: "unadvertised", logical: "memory_context" }],
        },
      },
    };
    capsStats.recordCapsTelemetry(ctx, Date.now() + i * 120000);
  }
  const stats = capsStats.readCapsStats();
  const a = stats.agents.ishellpro;
  assert.ok(a, "必须记录该客户端");
  assert.strictEqual(a.hallucinated, 3);
  assert.ok(a.suggestion, "达阈值必须给出降档建议");
  assert.strictEqual(a.suggestion.profile.mcp, "no");
  assert.ok(Array.isArray(a.suggestion.profile.forbid_tools));
});

await checkAsync("buildCapsSummary 输出可直接合并的降档画像", async () => {
  const summary = capsStats.buildCapsSummary();
  assert.ok(summary && typeof summary.title === "string", "必须返回一张卡片");
  assert.ok(Array.isArray(summary.lines) && summary.lines.length >= 2, "卡片至少两行");
  assert.ok(summary.detail && summary.detail.suggestions, "必须带 suggestions 供页面一键合并");
  assert.strictEqual(summary.detail.suggestions.ishellpro.mcp, "no", "建议画像必须是降档的");
  const row = summary.detail.agents.find((x) => x.agent === "ishellpro");
  assert.ok(row && row.suggested === true, "列表行必须标记已给建议");
});

await checkAsync("无统计时给出友好空态而不是抛错", async () => {
  /* 清缓存不够：buildCapsSummary 读的是文件，必须把文件也删掉才能造出真空态 */
  capsStats._resetCapsStatsCache();
  try { fs.rmSync(capsStats.capsStatsPath(), { force: true }); } catch (e) { console.log("  note   删除统计文件失败: " + (e && e.message)); }
  const empty = capsStats.buildCapsSummary();
  assert.ok(/尚无数据/.test(empty.title), "空态标题必须可识别");
});

await checkAsync("无遥测时不写入任何文件", async () => {
  capsStats._resetCapsStatsCache();
  const before = fs.existsSync(capsStats.capsStatsPath());
  capsStats.recordCapsTelemetry({ state: {} }, Date.now());
  assert.strictEqual(fs.existsSync(capsStats.capsStatsPath()), before);
});

/* 回收：清空桩与临时 HOME，并断言残余为 0（test_meta 规范） */
cleanup();
process.env.HOME = realHome;
const residue = memoryStore.size + pitfallStore.size;
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) { console.log("  note   临时目录回收失败（不影响断言）: " + (e && e.message)); }
assert.strictEqual(residue, 0, "清理后残余必须为 0");

console.log(NL + "=================================================================");
if (fail.length) {
  console.error("❌ 失败 " + fail.length + " 项 / 通过 " + pass + " 项");
  for (const f of fail) console.error("   - " + f);
  process.exit(1);
}
console.log("✅ v7.0.1 env_scope / applies_to / 负反馈 / 能力遥测 对抗回归全部通过（" + pass + " 项）");
console.log("=================================================================");
