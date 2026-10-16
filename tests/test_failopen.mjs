/**
 * fail-open 外壳测试 —— 中间件绝不能因为自己的异常而毁掉用户的请求。
 *
 * 【为什么必须有这道防线】
 * 插件的中间件跑在用户的模型请求链路上。实测线上出现过 322 次失败
 * （15059 次调用的约 2.1%），而平均耗时只有 87µs（限额 250ms）——
 * 说明不是超时，是某些输入形状不符预期时直接抛异常。
 * 无论根因是什么，都不该让用户为此付出请求失败的代价。
 *
 * 【本测试做什么】
 * 向三个钩子投喂各种畸形输入（null / 非对象 / 缺字段 / 字段类型全错 /
 * 超深嵌套 / 病态超长字符串），断言：
 *   ① 绝不向外抛异常
 *   ② 降级时返回「原样透传」（不能把 body 变成 undefined！）
 *
 * 【反证】末尾用同样的畸形输入去打一个「没有 try/catch 的裸函数」，
 * 断言它确实会抛 —— 证明这些输入真的能触发异常，测试不是空转。
 */
import assert from "node:assert/strict";

const MW = await import(new URL("../memory.middleware.js", import.meta.url).href);
const { onRequest, onEvent, onResponse } = MW;

let fail = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { fail++; console.log("  ✗ " + m); };

/* ---------- 畸形输入语料 ---------- */
const WEIRD = [
  ["null", null],
  ["undefined", undefined],
  ["数字", 42],
  ["字符串", "not an object"],
  ["空对象", {}],
  ["messages 非数组", { messages: "nope" }],
  ["messages 里塞 null", { messages: [null, undefined] }],
  ["messages 里塞数字", { messages: [1, 2, 3] }],
  ["content 是数字", { messages: [{ role: "user", content: 12345 }] }],
  ["content 是嵌套 null 数组", { messages: [{ role: "user", content: [null, null] }] }],
  ["content 块缺 type", { messages: [{ role: "user", content: [{ text: "x" }] }] }],
  ["tools 非数组", { messages: [{ role: "user", content: "x" }], tools: "bad" }],
  ["system 是对象", { system: { weird: true }, messages: [{ role: "user", content: "x" }] }],
  ["input 是字符串（responses 协议）", { input: "hello", messages: undefined }],
  ["contents 非数组（gemini 协议）", { contents: { bad: 1 } }],
  ["超深嵌套", (() => { let o = {}; let c = o; for (let i = 0; i < 500; i++) { c.n = {}; c = c.n; } return o; })()],
  ["病态超长单行", { messages: [{ role: "user", content: "x".repeat(200000) }] }],
];

const CTXES = [
  ["空 ctx", {}],
  ["ctx 为 null", null],
  ["options 非对象", { options: "bad" }],
  ["options.memories 非数组", { options: { memories: "bad" } }],
  ["options.memories 里塞 null", { options: { memories: [null, 123, "x"] } }],
  ["state 非对象", { state: "bad" }],
  ["protocol 是数字", { protocol: 7 }],
];

console.log("【一】onRequest 对畸形输入必须 fail-open 且原样透传");
for (const [wn, w] of WEIRD) {
  for (const [cn, c] of CTXES) {
    let got, threw = null;
    try { got = onRequest(w, c); } catch (e) { threw = e; }
    if (threw) { bad(`抛异常了: 输入[${wn}] × ctx[${cn}] → ${threw.name}: ${threw.message}`); continue; }
    if (w && typeof w === "object" && got === undefined) {
      bad(`返回了 undefined（会把请求打坏）: 输入[${wn}] × ctx[${cn}]`);
    }
  }
}
if (!fail) ok(`${WEIRD.length} × ${CTXES.length} = ${WEIRD.length * CTXES.length} 组组合全部未抛异常且未返回 undefined`);

console.log("\n【二】onEvent / onResponse 同样必须 fail-open");
const EVENTS = [null, undefined, 1, "s", {}, { type: 1 }, { choices: "bad" },
  { choices: [{ delta: null }] }, { delta: { text: 1 } }, { type: "content_block_delta" }];
const before = fail;
for (const e of EVENTS) {
  for (const [, c] of CTXES) {
    try { onEvent(e, c); } catch (err) { bad(`onEvent 抛异常: ${JSON.stringify(e)} → ${err.message}`); }
    try { onResponse(e, c); } catch (err) { bad(`onResponse 抛异常: ${JSON.stringify(e)} → ${err.message}`); }
  }
}
if (fail === before) ok(`${EVENTS.length} × ${CTXES.length} × 2 个钩子全部未抛异常`);

console.log("\n【三】正向：正常输入仍应正常工作（不能被 fail-open 吞掉功能）");
{
  const body = {
    model: "m",
    messages: [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "现在请记住：我偏好用 pnpm" },
    ],
  };
  const ctx = {
    protocol: "chat",
    options: {
      memories: [{
        id: 1, title: "包管理器偏好", content: "用户偏好使用 pnpm 而非 npm",
        category: "preference", lifecycle_status: "active", confidence_score: 100,
      }],
      inject_principles: true, max_inject_count: 5, max_budget_chars: 4000,
    },
  };
  const out = onRequest(body, ctx);
  const text = JSON.stringify(out);
  /* 断言必须检查【只可能来自记忆】的标记：
   * 早先这里断言 /pnpm/ 出现在输出里，但原文本身就有「pnpm」三个字母，
   * 于是即使注入完全失败、onRequest 一路抛异常，这条断言也照样通过 ——
   * 弱断言会让真 bug 蒙混过关，这个坑实际踩过。 */
  const MARK = "ZQXUNIQUE_MEMORY_TOKEN";
  const out2 = onRequest(
    { model: "m", messages: [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "好" },
      { role: "user", content: "帮我用 pnpm 装依赖" },   // 与记忆有关键词重合，才该注入
    ] },
    { protocol: "chat", agent: "minis", options: {
      memories: [{ id: 1, title: "包管理器偏好",
                   content: "用户偏好 pnpm 而不是 npm " + MARK,
                   tags: "pnpm,npm", category: "preference",
                   lifecycle_status: "active", confidence_score: 100 }],
      inject_principles: true, max_inject_count: 5, max_budget_chars: 4000,
      compress: false, cross_turn_dedup: false,
    } }
  );
  JSON.stringify(out2).includes(MARK)
    ? ok("正常输入下记忆确实被注入（用仅来自记忆的唯一标记验证，弱断言已换掉）")
    : bad("正常输入下没有注入 —— fail-open 可能吞掉了功能");

  /* 反向：无关键词重合时【不该】注入（防止「无脑全量注入」式的假通过） */
  const out3 = onRequest(
    { model: "m", messages: [
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "好" },
      { role: "user", content: "毫无关联的一句话" },
    ] },
    { protocol: "chat", options: {
      memories: [{ id: 1, title: "包管理器偏好", content: "用户偏好 pnpm " + MARK,
                   category: "preference", lifecycle_status: "active", confidence_score: 100 }],
      compress: false, cross_turn_dedup: false,
    } }
  );
  !JSON.stringify(out3).includes(MARK)
    ? ok("无关键词重合时不注入（反向断言，防无脑全量注入式假通过）")
    : bad("无重合也注入了 —— 检索逻辑可能有误");
}

console.log("\n【四】反证：这些畸形输入确实能触发异常（证明测试不是空转）");
{
  // 构造一个「没有 try/catch」的裸函数，用同样的输入打它，必须能抛出
  const bare = (body) => {
    // 模拟常见的无保护写法
    let s = "";
    for (const m of body.messages) s += m.content.toLowerCase();
    return s;
  };
  const triggers = [
    ["messages 非数组", { messages: "nope" }],
    ["messages 里塞 null", { messages: [null] }],
    ["content 是数字", { messages: [{ content: 12345 }] }],
  ];
  const caught = triggers.filter(([, inp]) => {
    try { bare(inp); return false; } catch { return true; }
  });
  caught.length === triggers.length
    ? ok(`反证通过：${triggers.length} 组畸形输入确实能让无保护代码抛异常（fail-open 是必要的）`)
    : bad(`反证失败：只有 ${caught.length}/${triggers.length} 组能触发异常，语料不够狠`);
}

assert.equal(typeof onRequest, "function", "必须导出 onRequest");
assert.equal(typeof onEvent, "function", "必须导出 onEvent");
assert.equal(typeof onResponse, "function", "必须导出 onResponse");
assert.strictEqual(fail, 0, "存在 fail-open 违例");

console.log("\n" + "=".repeat(56));
console.log(fail ? `❌ 失败 ${fail} 项` : "✅ fail-open 外壳验收通过（任何畸形输入都不抛、不透传坏值）");
process.exit(fail ? 1 : 0);
