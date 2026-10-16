/** 独立验收：前缀漂移探测器零改写（硬验收点）+ 漂移判定 + 易变模式识别 */
const c = await import("../compress.js");
let fail = 0;
const ok = (m) => console.log("  ✓ " + m);
const no = (m) => { console.log("  ✗ " + m); fail++; };

const mkBody = (sysText, lastUser) => ({
  model: "m1",
  system: sysText,
  messages: [
    { role: "user", content: "第一轮提问" },
    { role: "assistant", content: "第一轮回复" },
    { role: "user", content: lastUser || "当前提问" },
  ],
});

console.log("=== 1. 硬验收点：探测器必须零改写 ===");
{
  const cases = [
    ["普通 system", "你是助手"],
    ["含 UUID", "会话 3f2504e0-4f89-11d3-9a0c-0305e82c3301 已开始"],
    ["含时间戳", "Current time: 2026-10-16T12:00:00Z"],
    ["含 JWT", "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop"],
    ["含 hex hash", "sha256=d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"],
    ["system 是数组", [{ type: "text", text: "你是助手" }, { type: "text", text: "2026-10-16" }]],
  ];
  let allClean = true;
  for (const [name, sys] of cases) {
    const b = mkBody(sys);
    const before = JSON.stringify(b);
    const st = {};
    try {
      const r = c.analyzeCacheStability(b, st);
      const after = JSON.stringify(b);
      if (after !== before) { no(`${name}: body 被改动了！`); allClean = false; continue; }
      if (!r || typeof r.prefixChanged !== "boolean") { no(`${name}: 返回结构不对`); allClean = false; continue; }
    } catch (e) { no(`${name}: 抛异常 ${e.message}`); allClean = false; }
  }
  if (allClean) ok(`6 种输入下 body 全部逐字未改，返回结构合法`);
}

console.log("\n=== 2. 漂移检测有效性 ===");
{
  const st = {};
  const b1 = mkBody("你是助手，当前日期 2026-10-16。");
  const r1 = c.analyzeCacheStability(b1, st);
  r1.prefixChanged === false ? ok(`首轮 prefixChanged=false（无历史可比）`) : no(`首轮就报漂移：${r1.prefixChanged}`);

  const st2 = {};
  const a1 = c.analyzeCacheStability(mkBody("你是助手，当前日期 2026-10-16。"), st2);
  const a2 = c.analyzeCacheStability(mkBody("你是助手，当前日期 2026-10-16。"), st2);
  a2.prefixChanged === false ? ok("前缀不变 → prefixChanged=false") : no("前缀没变却报漂移");

  const st3 = {};
  c.analyzeCacheStability(mkBody("你是助手，当前日期 2026-10-16。"), st3);
  const d = c.analyzeCacheStability(mkBody("你是助手，当前日期 2026-10-17。"), st3);
  d.prefixChanged === true ? ok("日期变了 → prefixChanged=true") : no("日期变了却没报漂移");

  // 最后一条用户消息不应计入前缀
  const st4 = {};
  c.analyzeCacheStability(mkBody("你是助手", "第一问"), st4);
  const e = c.analyzeCacheStability(mkBody("你是助手", "完全不同的第二问"), st4);
  e.prefixChanged === false ? ok("只有末条用户消息变 → 不算漂移（正确，它是尾部不是前缀）") : no("末条变化被误判为前缀漂移");
}

console.log("\n=== 3. 四类易变模式识别 ===");
{
  const cases = [
    ["UUID", "3f2504e0-4f89-11d3-9a0c-0305e82c3301", true],
    ["ISO 时间戳", "2026-10-16T12:34:56Z", true],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop", true],
    ["SHA256", "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592", true],
    ["普通文本", "这是一句普通的话，没有任何易变标识。", false],
    ["版本号", "版本 1.2.3", false],
  ];
  for (const [name, txt, shouldHit] of cases) {
    const st = {};
    const r = c.analyzeCacheStability(mkBody(txt), st);
    const hit = (r.volatileHits || 0) > 0;
    (hit === shouldHit) ? ok(`${name}: ${hit ? "识别到" : "未误报"}`) : no(`${name}: 期望命中=${shouldHit} 实际=${hit}`);
  }
}

console.log("\n=== 4. fail-open ===");
{
  let clean = true;
  for (const bad of [null, undefined, {}, { messages: null }, { model: "x" }]) {
    try { c.analyzeCacheStability(bad, {}); } catch (e) { no(`输入 ${JSON.stringify(bad)} 抛异常: ${e.message}`); clean = false; }
  }
  if (clean) ok("5 种畸形输入均未抛异常");
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ 探测器独立验收通过");
process.exit(fail ? 1 : 0);
