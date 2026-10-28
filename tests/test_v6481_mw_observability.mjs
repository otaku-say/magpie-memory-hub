/**
 * test_v6481_mw_observability.mjs
 * v6.48.1 中间件观测能力回归：
 *   1. fail-open 降级日志从「全局前 3 条」改为「按 hook 计数 + 前 20 全记 + 每 100 采样」后不再永久静默；
 *   2. onRequest 新增慢路径归因日志，且正常请求不得产生噪声。
 * 纯离线：零网络、零数据库、零真实状态文件；不写任何持久化数据。
 */
const fail = [];
let pass = 0;

async function check(name, fn) {
  try {
    const ok = await fn();
    if (ok === true) { pass++; console.log("  OK   " + name); }
    else { fail.push(name); console.log("  FAIL " + name); }
  } catch (e) {
    fail.push(name + " :: " + (e && e.message));
    console.log("  FAIL " + name + " :: " + (e && e.message));
  }
}

function captureLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  try { fn(); } finally { console.log = orig; }
  return logs;
}

const { _mwFailOpen } = await import("../src/middleware/stream-utils.js");

console.log("=== 1. 前 20 次全量记录 ===");
await check("onRequest 前 20 次每次都留日志", () => {
  const logs = captureLogs(() => {
    for (let i = 1; i <= 20; i++) _mwFailOpen("onRequest", new Error("boom-" + i), null);
  });
  return logs.length === 20;
});

console.log("=== 2. 第 21~99 次静默（刷屏保护仍生效）===");
await check("第 21~99 次不打印", () => {
  const logs = captureLogs(() => {
    for (let i = 21; i <= 99; i++) _mwFailOpen("onRequest", new Error("x"), null);
  });
  return logs.length === 0;
});

console.log("=== 3. 第 100 次采样（原先永久静默的缺陷点）===");
await check("第 100 次必须留下采样日志", () => {
  const logs = captureLogs(() => _mwFailOpen("onRequest", new Error("sample"), null));
  return logs.length === 1 && logs[0].indexOf("第 100 次") !== -1;
});

console.log("=== 4. 按 hook 独立计数 ===");
await check("onEvent 从第 1 次独立计数", () => {
  const logs = captureLogs(() => _mwFailOpen("onEvent", new Error("e"), null));
  return logs.length === 1 && logs[0].indexOf("onEvent") !== -1 && logs[0].indexOf("第 1 次") !== -1;
});

console.log("=== 5. 日志内容含异常名且消息被截断 ===");
await check("日志带 Error 名，消息截断后总长受限", () => {
  const long = new Error("y".repeat(500));
  const logs = captureLogs(() => _mwFailOpen("onResponse", long, null));
  const line = logs[0] || "";
  return line.indexOf("Error") !== -1 && line.length <= 260;
});

console.log("=== 6. 反证：正常请求不得产生慢路径噪声 ===");
const { onRequest } = await import("../src/middleware/request-inject.js");
await check("普通请求不打慢路径日志", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hello world" }] };
  const ctx = { state: {}, options: { memories: [] }, protocol: "chat" };
  const logs = captureLogs(() => onRequest(body, ctx));
  return logs.filter((l) => l.indexOf("慢路径") !== -1).length === 0;
});

await check("fail-open 仍返回原始 body（加日志不改变语义）", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const r = onRequest(body, { state: {}, options: {}, protocol: "chat" });
  return r === body;
});

console.log("=================================================");
console.log("通过: " + pass + " / 失败: " + fail.length);
if (fail.length) { console.log("失败项:\n - " + fail.join("\n - ")); process.exit(1); }
console.log("v6.48.1 中间件观测回归通过");
