/**
 * test_v649_log_level.mjs
 * v6.49.0 日志等级功能全量对抗回归：
 *   配置归一化 / off 自动清理 / 分级过滤 / 落盘与截断 / 环形缓冲与导出快照 /
 *   中间件等级门（无 fs 运行时约束） / 设置页与文档契约对齐。
 * 纯离线：零网络、零真实数据库；日志目录注入 tmpdir 隔离，结束回收。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
let pass = 0;
const NL = String.fromCharCode(10);

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

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memhub-log-test-"));
}

function captureConsole(fn) {
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  console.error = (...a) => logs.push("ERR:" + a.map(String).join(" "));
  try { fn(); } finally { console.log = origLog; console.error = origErr; }
  return logs;
}

const { readOptions } = await import("../src/core/config.js");
const logger = await import("../src/core/logger.js");

console.log("=== 1. 配置归一化 ===");
await check("缺省 -> off", () => readOptions({ ncb_instance: "db" }).log_level === "off");
await check("非法值 -> off", () => readOptions({ ncb_instance: "db", log_level: "verbose" }).log_level === "off");
await check("合法值透传（error/info/debug）", () =>
  readOptions({ log_level: "error" }).log_level === "error" &&
  readOptions({ log_level: "info" }).log_level === "info" &&
  readOptions({ log_level: "debug" }).log_level === "debug");

console.log("=== 2. off：全静默 + 自动清理 ===");
await check("initLogger(off) 清理既有日志产物", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "memhub.log"), "old", "utf8");
  const r = logger.initLogger({ log_level: "off" }, { dir });
  return r.level === "off" && r.cleaned.removed >= 1 && !fs.existsSync(path.join(dir, "memhub.log"));
});
await check("off 时 logError 全静默（无 console、无文件）", () => {
  const dir = tmpDir();
  logger.initLogger({ log_level: "off" }, { dir });
  const logs = captureConsole(() => logger.logError("should-not-appear"));
  return logs.length === 0 && !fs.existsSync(path.join(dir, "memhub.log"));
});
await check("off 时 flushLogsSnapshot 拒绝写快照", () => {
  const dir = tmpDir();
  logger.initLogger({ log_level: "off" }, { dir });
  return logger.flushLogsSnapshot() === false;
});

console.log("=== 3. error / info / debug 分级过滤 ===");
await check("error 级：只记 error", () => {
  const dir = tmpDir();
  logger.initLogger({ log_level: "error" }, { dir });
  logger.logError("E1-marker");
  logger.logInfo("I1-marker");
  logger.logDebug("D1-marker");
  const txt = fs.readFileSync(path.join(dir, "memhub.log"), "utf8");
  return txt.includes("E1-marker") && !txt.includes("I1-marker") && !txt.includes("D1-marker");
});
await check("info 级：记 error+info，不记 debug", () => {
  const dir = tmpDir();
  logger.initLogger({ log_level: "info" }, { dir });
  logger.logError("E2-marker");
  logger.logInfo("I2-marker");
  logger.logDebug("D2-marker");
  const txt = fs.readFileSync(path.join(dir, "memhub.log"), "utf8");
  return txt.includes("E2-marker") && txt.includes("I2-marker") && !txt.includes("D2-marker");
});
await check("debug 级：全量记录，console 镜像 error 走 console.error", () => {
  const dir = tmpDir();
  logger.initLogger({ log_level: "debug" }, { dir });
  const logs = captureConsole(() => {
    logger.logError("E3-marker");
    logger.logDebug("D3-marker");
  });
  const txt = fs.readFileSync(path.join(dir, "memhub.log"), "utf8");
  return txt.includes("E3-marker") && txt.includes("D3-marker") &&
    logs.some((l) => l.startsWith("ERR:") && l.includes("E3-marker"));
});

console.log("=== 4. 环形缓冲 + 导出快照 ===");
await check("快照含最近 800 条且 _logs.js 挂 window.__memhubLogs", () => {
  const dir = tmpDir();
  logger.initLogger({ log_level: "info" }, { dir });
  for (let i = 0; i < 900; i++) logger.logInfo("ring-" + i);
  const okFlush = logger.flushLogsSnapshot();
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, "_logs.json"), "utf8"));
  const js = fs.readFileSync(path.join(ROOT, "_logs.js"), "utf8");
  return okFlush === true && json.count === 800 &&
    json.entries[0].msg.includes("ring-100") && json.entries[799].msg.includes("ring-899") &&
    js.startsWith("window.__memhubLogs = ");
});
await check("超长单条被截断到 2000 字符", () => {
  const dir = tmpDir();
  logger.initLogger({ log_level: "info" }, { dir });
  logger.logInfo("x".repeat(5000));
  const txt = fs.readFileSync(path.join(dir, "memhub.log"), "utf8");
  return txt.includes("x".repeat(2000) + "…") && !txt.includes("x".repeat(2100));
});
await check("文件超 2MB 自动截尾（上限恒成立且保留尾部）", () => {
  const dir = tmpDir();
  logger.initLogger({ log_level: "info" }, { dir });
  captureConsole(() => {
    /* 单条被 LINE_MAX 截到约 2KB：需 1000+ 条才能真实越过 2MB 上限 */
    for (let i = 0; i < 1100; i++) logger.logInfo("B".repeat(3000));
  });
  const size = fs.statSync(path.join(dir, "memhub.log")).size;
  /* 不变量：总写入约 3MB，文件必须始终被压在 2MB+单行 余量内，且截尾后保有足量内容 */
  return size > 512 * 1024 && size < 2.15 * 1024 * 1024;
});

console.log("=== 5. 中间件等级门（无 fs 运行时约束）===");
const su = await import("../src/middleware/stream-utils.js");
await check("_mwLogLevel 缺省 info / off=0 / error=1 / debug=3", () =>
  su._mwLogLevel({}) === 2 && su._mwLogLevel({ options: { log_level: "off" } }) === 0 &&
  su._mwLogLevel({ options: { log_level: "error" } }) === 1 &&
  su._mwLogLevel({ options: { log_level: "debug" } }) === 3);
await check("off 时 fail-open 静默（反证：不打印）", () => {
  const logs = captureConsole(() => su._mwFailOpen("onRequest", new Error("boom"), null, { options: { log_level: "off" } }));
  return logs.length === 0;
});
await check("info 时 fail-open 照常打印", () => {
  const logs = captureConsole(() => su._mwFailOpen("onRequest", new Error("boom2"), null, { options: { log_level: "info" } }));
  return logs.length === 1 && logs[0].includes("boom2");
});

console.log("=== 6. debug 全量请求耗时（onRequest）===");
const ri = await import("../src/middleware/request-inject.js");
await check("debug 级每次请求打耗时行", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hello log" }] };
  const ctx = { state: {}, options: { memories: [], log_level: "debug" }, protocol: "chat" };
  const logs = captureConsole(() => ri.onRequest(body, ctx));
  return logs.some((l) => l.includes("onRequest") && l.includes("ms proto=chat"));
});
await check("off 级不打耗时与慢路径（反证）", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hello quiet" }] };
  const ctx = { state: {}, options: { memories: [], log_level: "off" }, protocol: "chat" };
  const logs = captureConsole(() => ri.onRequest(body, ctx));
  return logs.filter((l) => l.includes("[memory-hub]")).length === 0;
});

console.log("=== 7. 契约对齐（设置页 / package.json / 三层接线）===");
await check("settings.html 有 log_level 选择器与导出按钮", () => {
  const h = fs.readFileSync(path.join(ROOT, "settings.html"), "utf8");
  return h.includes('id="log_level"') && h.includes('id="btn_export_logs"') &&
    h.includes('id="btn_save_card_logs"') && h.includes("v7.1.0");
});
await check("settings.js 注册 SELECT/卡片/校验/导出函数", () => {
  const j = fs.readFileSync(path.join(ROOT, "src/page/settings.js"), "utf8");
  return j.includes('"log_level"') && j.includes('log: ["log_level"]') &&
    j.includes("function exportLogs") && j.includes("function loadLogsSnapshot");
});
await check("package.json 声明 log_level 默认 off", () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return p.version === "7.1.0" && p.magpie.options.log_level === "off";
});
await check("Node 侧已收口（无裸 console.* 带 [memory-hub]）", () => {
  const files = [
    "src/index.js", "src/page/actions.js", "src/services/audit/scheduler.js",
    "src/services/harvest/offline-scan.js", "src/core/status-writer.js",
    "src/domain/token-budget.js", "src/integration/provider-models.js",
    "src/services/harvest/hook-request.js", "src/services/harvest/scaffolding.js",
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8")
      .split(NL).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join(NL);
    if (/console\.(log|error|warn)\(.*\[memory-hub\]/.test(src)) {
      console.log("    泄漏于: " + f);
      return false;
    }
  }
  return true;
});
await check("中间件模块未引入 node:fs（受限运行时红线）", () => {
  for (const f of ["src/middleware/stream-utils.js", "src/middleware/request-inject.js",
    "src/middleware/event-stream.js", "src/middleware/response-hook.js", "src/middleware/inject-builder.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    if (/node:fs|require\(["']fs/.test(src)) return false;
  }
  return true;
});

console.log("=== 8. 清理回收 ===");
await check("清理测试快照与隔离目录", () => {
  logger.initLogger({ log_level: "off" }, {});
  for (const p of [path.join(ROOT, "_logs.json"), path.join(ROOT, "_logs.js")]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* 清理失败不影响断言 */ }
  }
  return !fs.existsSync(path.join(ROOT, "_logs.json"));
});

console.log("=================================================");
console.log("通过: " + pass + " / 失败: " + fail.length);
if (fail.length) { console.log("失败项:" + NL + " - " + fail.join(NL + " - ")); process.exit(1); }
console.log("v6.49.0 日志等级功能全量对抗回归通过");
