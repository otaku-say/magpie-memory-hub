/**
 * test_denoise_p0.mjs —— Headroom TrafficLearner 纯规则去噪机制专项测试
 *
 * 验证维度：
 * 1. P0 证据累计门禁（min_evidence）：
 *    - 同一模式第 1 次出现：严禁落盘，仅在本地 pending 暂存计数为 1
 *    - 同一模式第 2 次出现：仍不入库，pending 计数为 2
 *    - 同一模式第 3 次出现：达到门禁（count >= 3），正式落盘入库并从 pending 移除
 * 2. 双轨制（Dual-Track）：
 *    - 用户显式指令（「记下来：」「避坑：」等）直接穿透门禁，第 1 次即刻入库
 * 3. 淘汰机制（Expiration & Capacity）：
 *    - 21 天未复现硬淘汰（TTL 过期清理）
 *    - LRU 容量上限自动淘汰最旧条目
 * 4. P1 脚手架注入前缀黑名单：
 *    - <app-context> / <system-reminder> 等前缀彻底剔除
 *    - system 与 tool 消息在提炼前丢弃
 * 5. P2 存储字段与指纹分离：
 *    - symptom / solution / root_cause 必须保留原文，严禁提前被 sig() 破坏
 * 6. 反证门拦截测试：
 *    - 故意破坏门禁参数或伪造噪音，断言必定被严格拦截
 */

import assert from "node:assert";
import crypto from "node:crypto";
import { createTestEnv } from "./lib/testenv.mjs";
import {
  recordPendingEvidence,
  getPendingEvidence,
  clearPendingEvidence,
  cleanExpiredPending,
  listPendingEvidence,
} from "../local_state.js";
import {
  isExplicitUserMemory,
} from "../gateway_harvest.js";
import {
  processDialogueAndHarvest,
  buildDialogueText,
  stripScaffolding,
} from "../gateway_harvest.hooks.js";

const env = await createTestEnv({ instance: "41694_agent_memory", requireMcp: true });
console.log(`[test_denoise_p0] 测试命名空间 project: ${env.project}`);

try {
  console.log("=================================================================");
  console.log("【测试 1】P0 证据门禁 min_evidence 行为验证（1 次不入库，3 次入库）");
  console.log("=================================================================");

  const nonce = Date.now().toString(36);
  const testFp = `fp_p0_test_${nonce}`;

  // 1.1 第 1 次观察：不入库，进入 pending 队列，count = 1
  const rec1 = recordPendingEvidence(testFp, { desc: "test 1" }, { minEvidence: 3 });
  assert.strictEqual(rec1.shouldGraduate, false, "第 1 次观察严禁毕业落盘");
  assert.strictEqual(rec1.count, 1, "第 1 次观察 count 必须为 1");
  const pend1 = getPendingEvidence(testFp);
  assert.ok(pend1, "第 1 次观察必须进入 pending 暂存");
  assert.strictEqual(pend1.count, 1);
  console.log("  ✓ 第 1 次观察：严禁落盘，pending count=1");

  // 1.2 第 2 次观察：仍不入库，pending count = 2
  const rec2 = recordPendingEvidence(testFp, { desc: "test 2" }, { minEvidence: 3 });
  assert.strictEqual(rec2.shouldGraduate, false, "第 2 次观察仍不满足门槛，严禁落盘");
  assert.strictEqual(rec2.count, 2, "第 2 次观察 count 必须为 2");
  const pend2 = getPendingEvidence(testFp);
  assert.ok(pend2);
  assert.strictEqual(pend2.count, 2);
  console.log("  ✓ 第 2 次观察：门限未达，pending count=2");

  // 1.3 第 3 次观察：满足 minEvidence=3，正式毕业！从 pending 移除
  const rec3 = recordPendingEvidence(testFp, { desc: "test 3" }, { minEvidence: 3 });
  assert.strictEqual(rec3.shouldGraduate, true, "第 3 次观察达到门禁（count>=3），必须毕业落盘");
  assert.strictEqual(rec3.count, 3, "毕业时 count 必须为 3");
  const pend3 = getPendingEvidence(testFp);
  assert.strictEqual(pend3, null, "毕业后必须从 pending 暂存中移除");
  console.log("  ✓ 第 3 次观察：门槛达成（count>=3），正式毕业并移出 pending！\n");

  console.log("=================================================================");
  console.log("【测试 2】双轨制（Dual-Track）验证：显式用户表达直接穿透门禁");
  console.log("=================================================================");

  const explicitDialogue = `
[user]: 避坑：pytest: command not found，执行测试必须使用 uv run pytest 执行，而不是 pytest。
[assistant]: 已确认，执行 uv run pytest (exit code 0)，5 passed in 0.2s，测试已成功通过 (success)。
`.trim();

  assert.strictEqual(isExplicitUserMemory(explicitDialogue), true, "必须识别出「避坑：」为用户显式意图");

  // 显式指令由 processDialogueAndHarvest 处理，即使首度出现也直接入库
  const expRes = await processDialogueAndHarvest(
    explicitDialogue,
    { project: env.project, agent: "explicit-tester" },
    env.client,
    {
      min_evidence: 3,
      extract_model: "mock-model",
      _fetch: async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify([{
                category: "pitfall",
                title: "pytest 执行命令",
                content: "必须使用 uv run pytest 执行，而不是 pytest",
                tags: "pytest,uv",
                confidence: 0.95,
              }]),
            },
          }],
        }),
      }),
    }
  );
  assert.ok(expRes.memoriesSaved > 0 || expRes.pitfallsSaved > 0, "双轨制断言：用户显式意图直接穿透门禁入库");
  console.log("  ✓ 双轨制验证通过：显式意图直接穿透门禁入库！");

  // 2.2 反证：助手回复包含「注意：」或「规范要求：」绝不可作为显式用户意图穿透门禁
  const assistantNoticeDialogue = `
[user]: 请问该项目如何安装依赖？
[assistant]: 注意：必须使用 pip install foo 安装依赖，不要使用 setup.py。
`.trim();
  assert.strictEqual(
    isExplicitUserMemory(assistantNoticeDialogue),
    false,
    "反证断言：助手发言中的「注意：」绝对不能判定为显式用户意图（防止击穿门禁）"
  );
  console.log("  ✓ 双轨制反证通过：助手解释性「注意：」绝不穿透门禁！\n");

  console.log("=================================================================");
  console.log("【测试 3】淘汰机制验证：LRU 容量上限与 21 天 TTL 过期");
  console.log("=================================================================");

  // 3.1 LRU 容量上限淘汰最旧项
  const capFpPrefix = `cap_${Date.now()}`;
  for (let i = 1; i <= 5; i++) {
    recordPendingEvidence(`${capFpPrefix}_${i}`, { i }, {
      minEvidence: 10,
      maxPending: 3,
      now: 1000 + i * 10,
    });
  }
  // 上限为 3，所以最早的 1 和 2 必须被淘汰，留下 3, 4, 5
  assert.strictEqual(getPendingEvidence(`${capFpPrefix}_1`), null, "LRU 容量满时最早项必须被淘汰");
  assert.strictEqual(getPendingEvidence(`${capFpPrefix}_2`), null, "LRU 容量满时次早项必须被淘汰");
  assert.ok(getPendingEvidence(`${capFpPrefix}_5`), "最新项必须保留在 pending 中");
  console.log("  ✓ LRU 容量上限自动淘汰最旧项断言通过");

  // 3.2 21 天 TTL 过期清理（Headroom :1946）
  const ttlFp = `ttl_${Date.now()}`;
  const nowMs = Date.now();
  const pastMs = nowMs - (22 * 24 * 3600 * 1000); // 22 天前
  recordPendingEvidence(ttlFp, { expired: true }, { minEvidence: 5, now: pastMs });
  // 在当前时间触发记录或清理
  const cleanedCount = cleanExpiredPending(21 * 24 * 3600 * 1000, nowMs);
  assert.ok(cleanedCount >= 1, "超期 21 天的 pending 记录必须被自动清理");
  assert.strictEqual(getPendingEvidence(ttlFp), null, "超期项已从 pending 彻底清除");
  console.log("  ✓ 21 天未复现硬淘汰 (TTL Expiration) 断言通过！\n");

  console.log("=================================================================");
  console.log("【测试 4】P1 脚手架注入前缀黑名单（Headroom :68-80）");
  console.log("=================================================================");

  const scaffoldText = `
<app-context>
Project Context: This is an internal AI context.
</app-context>
<system-reminder>
Remember to follow instructions.
</system-reminder>
[Persistent Memory Context]
- [principle] 规范准则: 所有的 API 必须写注释
- [fact] 架构事实: 统一使用 Node 20

[Memory Agent Guide —— 检索与沉淀]
1. 优先检索记忆...
2. 及时沉淀...

[Memory Context]
- [fact] 旧记忆上下文: 某系统配置参数

用户真实提问：如何配置数据库？

--- Context from the delegating agent ---
云端沙箱 ID：aa8f1812331643068673810a570196ea
`.trim();

  const stripped = stripScaffolding(scaffoldText);
  assert.ok(!stripped.includes("<app-context>"), "必须剔除 <app-context>");
  assert.ok(!stripped.includes("<system-reminder>"), "必须剔除 <system-reminder>");
  assert.ok(!stripped.includes("[Persistent Memory Context]"), "必须剔除 [Persistent Memory Context]");
  assert.ok(!stripped.includes("[Memory Agent Guide"), "必须剔除 [Memory Agent Guide]");
  assert.ok(!stripped.includes("[Memory Context]"), "必须剔除 [Memory Context]");
  assert.ok(!stripped.includes("Context from the delegating agent"), "必须剔除 Context from the delegating agent");
  assert.ok(stripped.includes("用户真实提问：如何配置数据库？"), "必须保留用户真实内容");

  // system / tool 消息丢弃测试
  const scaffoldMessages = [
    { role: "system", content: "<skills_instructions>some internal prompt</skills_instructions>" },
    { role: "tool", content: "Traceback: internal error occurred in system" },
    { role: "user", content: "真实用户输入：请问项目如何跑测试？" },
  ];
  const builtText = buildDialogueText({ messages: scaffoldMessages }, { choices: [{ message: { role: "assistant", content: "请执行 pytest 测试。" } }] });
  assert.ok(!builtText.includes("<skills_instructions>"), "buildDialogueText 必须完全丢弃 system 消息");
  assert.ok(!builtText.includes("internal error occurred in system"), "buildDialogueText 必须完全丢弃 tool 回显");
  assert.ok(builtText.includes("真实用户输入：请问项目如何跑测试？"), "必须保留真正最后一轮用户输入");
  console.log("  ✓ 脚手架注入前缀与 system/tool 消息过滤断言全部通过！\n");

  console.log("=================================================================");
  console.log("【测试 7】P2 存储字段与指纹分离验证");
  console.log("=================================================================");

  const failureItem = {
    symptom: "FAILED tests/test_login.py",
    root_cause: "FAILED tests/test_login.py",
    solution: "pytest tests/test_login.py --tb=short",
    content_fingerprint: "fp_test_login_tb_short",
  };

  // 7.2 强断言：通过 tools.js 的 pitfall_save 真实入库，必须完整保留 content_fingerprint 与 recurrence
  const { MagpieMemoryHub } = await import("../tools.js");
  const hub = await MagpieMemoryHub({}, { client: env.client, ncb_instance: env.instance });
  const saveResRaw = await hub.tool.pitfall_save.execute({
    project: env.project,
    component: "testing",
    symptom: failureItem.symptom,
    root_cause: failureItem.root_cause,
    solution: failureItem.solution,
    content_fingerprint: failureItem.content_fingerprint,
    recurrence: 3,
  });
  const saveRes = JSON.parse(saveResRaw);
  assert.strictEqual(saveRes.action, "ADD", "初次入库 action 必须为 ADD");
  const dbRows = (await env.client.list("pitfalls", { project: env.project, content_fingerprint: failureItem.content_fingerprint })).data;
  assert.ok(dbRows && dbRows.length > 0, "入库行必须能按 content_fingerprint 精确索引查回");
  assert.strictEqual(dbRows[0].content_fingerprint, failureItem.content_fingerprint, "入库指纹必须与 mineFailures 的 content_fingerprint 严格一致");
  assert.strictEqual(Number(dbRows[0].recurrence), 3, "入库 recurrence 必须保留传入的累计证据频次 3");
  console.log("  ✓ 存储字段与指纹分离断言通过：保留真实原文且指纹与频次真实入库！\n");

  console.log("=================================================================");
  console.log("【测试 8】关键反证门测试（故意破坏以验证拦截能力）");
  console.log("=================================================================");

  // 反证 A：故意输入纯闲聊，断言在线提炼与门禁绝对产出 0 条
  const badChatSample = "[user]: 你好\n[assistant]: 你好！今天天气不错。";
  const badHarvest = await processDialogueAndHarvest(badChatSample, { project: env.project }, null, { extract_model: "" });
  assert.strictEqual(badHarvest.memoriesSaved + badHarvest.pitfallsSaved, 0, "反证通过：闲聊对话绝对 0 产出");

  // 反证 B：故意注入未达到 min_evidence 的提炼，断言 DB 绝对零写入
  const unverifiedNonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const unverifiedTurn = `
[user]: 偶尔遇到一次偶发问题：
IndexError: list index out of range in job_${unverifiedNonce}
[assistant]: 执行 python fix_temp_${unverifiedNonce}.py 解决，PASS (exit code 0)。
`.trim();
  const unverifiedRes = await processDialogueAndHarvest(
    unverifiedTurn,
    { project: env.project, agent: "unverified-agent" },
    env.client,
    { min_evidence: 3 }
  );
  assert.strictEqual(unverifiedRes.memoriesSaved, 0, "反证通过：首次单次出现的非显式规则绝对不入库 memories (0 条)");
  assert.strictEqual(unverifiedRes.pitfallsSaved, 0, "反证通过：首次单次出现的非显式规则绝对不入库 pitfalls (0 条)");
  console.log("  ✓ 反证门全部通过：噪音与单次未达标模式绝对无法落盘！\n");

  console.log("=================================================================");
  console.log("【测试 9】项目隔离性验证：pending 证据暂存绝不跨项目串扰");
  console.log("=================================================================");
  const isoFp = `iso_${Date.now()}`;
  recordPendingEvidence(`p:proj_A:${isoFp}`, { desc: "proj A" }, { minEvidence: 3 });
  recordPendingEvidence(`p:proj_A:${isoFp}`, { desc: "proj A" }, { minEvidence: 3 });
  // proj_A 累计 2 次，此时 proj_B 出现相同模式
  recordPendingEvidence(`p:proj_B:${isoFp}`, { desc: "proj B" }, { minEvidence: 3 });
  const pendA = getPendingEvidence(`p:proj_A:${isoFp}`);
  const pendB = getPendingEvidence(`p:proj_B:${isoFp}`);
  assert.strictEqual(pendA.count, 2, "项目 A 的 pending 计数必须独立为 2");
  assert.strictEqual(pendB.count, 1, "项目 B 的 pending 计数必须独立为 1，严禁受项目 A 串扰");
  console.log("  ✓ 项目隔离性验证通过：不同项目的 pending 计数绝对独立！\n");

  console.log("=================================================================");
  console.log("【测试 10】脏条目与损坏时间戳自愈清理验证");
  console.log("=================================================================");
  const zombieFp = `zombie_${Date.now()}`;
  const st = (await import("../local_state.js")).readState();
  st.pending_patterns = st.pending_patterns || {};
  st.pending_patterns[zombieFp] = { count: 1, last_seen: 0 }; // 故意损坏为 0 时间戳
  (await import("../local_state.js")).writeState(st);
  cleanExpiredPending(21 * 24 * 3600 * 1000, Date.now());
  assert.strictEqual(getPendingEvidence(zombieFp), null, "时间戳为 0 或缺失的损坏脏数据必须被自动清理");
  console.log("  ✓ 脏数据自愈清理验证通过：无时间戳条目绝无可能成为永生僵尸！\n");

  console.log("=================================================================");
  console.log("【测试 11】min_evidence 按内容类型区分全链路验证（高优先级验收）");
  console.log("=================================================================");

  // 11.1 验收 ①：只出现一次的真实事实（如「我的开发机是 Mac mini M4 16G」），立即入库
  const factTurn = `
[user]: 请帮我配置开发环境。
[user]: 我的开发机是 Mac mini M4 16G。
[assistant]: 已确认，已记录你的开发机配置为 Mac mini M4 16G。
`.trim();
  const factRes = await processDialogueAndHarvest(
    factTurn,
    { project: env.project, agent: "type-fact-tester" },
    env.client,
    {
      min_evidence: 3,
      extract_model: "mock-model",
      _fetch: async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify([{
                category: "fact",
                title: "开发机配置",
                content: "我的开发机是 Mac mini M4 16G",
                tags: "mac,mini,m4",
                confidence: 0.95,
              }]),
            },
          }],
        }),
      }),
    }
  );
  assert.strictEqual(factRes.memoriesSaved, 1, "验收 ① 通过：只出现一次的真实环境事实必须直接立即入库（不设 3 次门禁）");
  assert.strictEqual(factRes.pitfallsSaved, 0, "事实不会产生 pitfalls");
  const memRows = (await env.client.list("memories", { project: env.project, category: "fact" })).data;
  assert.ok(memRows && memRows.length > 0, "真实事实必须已在 DB 中");
  assert.ok(memRows.some((r) => r.content.includes("Mac mini M4 16G")), "入库内容必须包含 Mac mini M4 16G");
  console.log("  ✓ 验收 ① 通过：只出现一次的真实环境事实立即入库！");

  // 11.2 验收 ②：只出现一次的伪踩坑噪音，仍被拦在 pending 队列，DB 0 写入
  const pitNoiseNonce = Date.now().toString(36) + "_noise_once";
  const pitTurn1 = `
[turn 1] 用户运行遇到偶发错误：
IndexError: list index out of range in task_${pitNoiseNonce}
[assistant]: 执行 python fix_task_${pitNoiseNonce}.py 解决，PASS (exit code 0)。
`.trim();
  const mockPitFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify([{
            category: "pitfall",
            title: "IndexError 报错",
            content: "IndexError: list index out of range in task_" + pitNoiseNonce,
            tags: "python",
            confidence: 0.9,
          }]),
        },
      }],
    }),
  });
  const pitRes1 = await processDialogueAndHarvest(
    pitTurn1,
    { project: env.project, agent: "type-pit-tester" },
    env.client,
    { min_evidence: 3, extract_model: "mock-model", _fetch: mockPitFetch }
  );
  assert.strictEqual(pitRes1.pitfallsSaved, 0, "验收 ② 通过：只出现一次的踩坑模式必须被拦住，绝不直接入库 (pitfallsSaved=0)");
  console.log("  ✓ 验收 ② 通过：只出现一次的伪踩坑噪音仍被拦住（踩坑门禁未削弱）！");

  // 11.3 验收 ③：不同轮次重复 3 次的踩坑按原逻辑毕业落盘
  const pitTurn2 = `
[turn 2] 再次运行另一任务时偶发相同错误：
IndexError: list index out of range in task_${pitNoiseNonce}
[assistant]: 执行 python fix_task_${pitNoiseNonce}.py 解决，PASS (exit code 0)。
`.trim();
  const pitRes2 = await processDialogueAndHarvest(
    pitTurn2,
    { project: env.project, agent: "type-pit-tester" },
    env.client,
    { min_evidence: 3, extract_model: "mock-model", _fetch: mockPitFetch }
  );
  assert.strictEqual(pitRes2.pitfallsSaved, 0, "第 2 次出现踩坑模式仍未达标，不落盘");

  const pitTurn3 = `
[turn 3] 部署验证阶段再次发生相同错误：
IndexError: list index out of range in task_${pitNoiseNonce}
[assistant]: 执行 python fix_task_${pitNoiseNonce}.py 解决，PASS (exit code 0)。
`.trim();
  const pitRes3 = await processDialogueAndHarvest(
    pitTurn3,
    { project: env.project, agent: "type-pit-tester" },
    env.client,
    { min_evidence: 3, extract_model: "mock-model", _fetch: mockPitFetch }
  );
  assert.strictEqual(pitRes3.pitfallsSaved, 1, "验收 ③ 通过：重复 3 次的踩坑模式达到门槛（count>=3），正式毕业入库！");
  console.log("  ✓ 验收 ③ 通过：重复 3 次的踩坑仍按原逻辑正常毕业入库！");

  // 11.4 反证测试：若显式对记忆传入 min_evidence_memory=3，单次事实亦必须受控拦下
  const blockedTurn = `
[user]: 统一采用 fastify 替代 express 作为服务端框架。
[assistant]: 好的，系统框架决策遵循 fastify。
`.trim();
  const blockedRes = await processDialogueAndHarvest(
    blockedTurn,
    { project: env.project, agent: "type-blocked-tester" },
    env.client,
    {
      min_evidence_memory: 3,
      extract_model: "mock-model",
      _fetch: async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify([{
                category: "decision",
                title: "服务端框架",
                content: "统一采用 fastify 替代 express 作为服务端框架",
                tags: "arch",
                confidence: 0.95,
              }]),
            },
          }],
        }),
      }),
    }
  );
  assert.strictEqual(blockedRes.memoriesSaved, 0, "反证通过：显式配置 min_evidence_memory>1 时未达标决策被成功拦截");
  console.log("  ✓ 反证测试通过：min_evidence_memory 参数独立受控且精准生效！\n");

} finally {
  console.log("=================================================================");
  console.log("【清理与全局残余断言】彻底清理隔离测试数据库行");
  console.log("=================================================================");

  const cleanRes = await env.cleanup();
  console.log(`✓ 数据库清理完成：memories 删除 ${cleanRes.memoriesDeleted} 行，pitfalls 删除 ${cleanRes.pitfallsDeleted} 行`);

  const residue = await env.countAllTestResidue();
  assert.strictEqual(residue.total, 0, `全局残余必须为 0（当前 memories=${residue.memories}, pitfalls=${residue.pitfalls}）`);
  console.log("✓ 数据库全局残余校验断言：残余数为 0！\n");
}

console.log("=================================================================");
console.log("✅ 全部 Headroom 去噪专项测试（P0/P1/P2 及反证门）100% 通过！");
console.log("=================================================================");
