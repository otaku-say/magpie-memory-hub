/**
 * 模块职责：分级日志中枢（off/error/info/debug）——Node 侧文件落盘、环形缓冲、设置页导出快照与关日志自动清理
 * 依赖：src/core/env.js（测试模式判定：日志目录随 state 目录隔离进 tmpdir，测试零污染）
 * 被依赖：src/index.js, src/core/status-writer.js, src/page/actions.js, src/services/**, src/integration/provider-models.js, src/domain/token-budget.js
 * 边界说明：网关中间件（request-inject/stream-utils 等）运行在无文件系统的受限运行时，
 *   绝不能 import 本模块——它们按 ctx.options.log_level 自行过滤后输出到网关控制台。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTestMode } from "./env.js";

const LEVELS = { off: 0, error: 1, info: 2, debug: 3 };
const RING_CAP = 800;              // 环形缓冲条数上限（导出快照取这个窗口）
const FILE_CAP = 2 * 1024 * 1024;  // 单日志文件硬上限，超限保留尾部
const FILE_KEEP = 1024 * 1024;
const FLUSH_DEBOUNCE_MS = 1000;    // 导出快照节流：脏了最多 1s 落一次盘
const LINE_MAX = 2000;             // 单条日志截断长度

const LOGS_JSON_PATH = fileURLToPath(new URL("../../_logs.json", import.meta.url));
const LOGS_JS_PATH = fileURLToPath(new URL("../../_logs.js", import.meta.url));

let _level = 0;
let _dir = "";
let _file = "";
let _ring = [];
let _flushTimer = null;

function defaultLogsDir() {
  if (isTestMode()) return path.join(os.tmpdir(), "memhub-test-state-" + process.pid, "logs");
  return path.join(os.homedir(), ".magpie-memory-hub", "logs");
}

function fmtTs(d) {
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function serializeArg(a) {
  if (typeof a === "string") return a;
  try {
    const s = JSON.stringify(a);
    return typeof s === "string" ? s : String(a);
  } catch (_) {
    return String(a);
  }
}

function appendLine(line) {
  try {
    fs.appendFileSync(_file, line + "\n", "utf8");
    const st = fs.statSync(_file);
    if (st.size > FILE_CAP) {
      const buf = fs.readFileSync(_file, "utf8");
      const cut = buf.length - FILE_KEEP;
      const nl = buf.indexOf("\n", Math.max(0, cut));
      fs.writeFileSync(_file, nl >= 0 ? buf.slice(nl + 1) : buf.slice(Math.max(0, cut)), "utf8");
    }
  } catch (_) {
    /* 日志落盘失败绝不能反噬业务 */
  }
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushLogsSnapshot();
  }, FLUSH_DEBOUNCE_MS);
  if (typeof _flushTimer.unref === "function") _flushTimer.unref();
}

function emit(levelName, num, args) {
  if (_level < num || num < 1) return;
  let msg = "";
  for (const a of args) msg += (msg ? " " : "") + serializeArg(a);
  if (msg.length > LINE_MAX) msg = msg.slice(0, LINE_MAX) + "…";
  const line = "[" + fmtTs(new Date()) + "] [" + levelName + "] " + msg;
  _ring.push({ t: Date.now(), level: levelName, msg: line });
  if (_ring.length > RING_CAP) _ring.splice(0, _ring.length - RING_CAP);
  appendLine(line);
  try {
    (num === 1 ? console.error : console.log)(line);
  } catch (_) {}
  scheduleFlush();
}

/**
 * 初始化（或切换）日志等级。等级为 off 时立即清理插件产生的全部日志产物：
 * 日志目录（logs/）与设置页导出快照（_logs.json / _logs.js）。
 * opts.dir 仅供测试注入隔离目录。
 */
export function initLogger(cfg, opts) {
  const raw = String((cfg && cfg.log_level) || (opts && opts.log_level) || "off");
  _level = Object.prototype.hasOwnProperty.call(LEVELS, raw) ? LEVELS[raw] : 0;
  _dir = (opts && typeof opts.dir === "string" && opts.dir) || defaultLogsDir();
  _file = path.join(_dir, "memhub.log");
  _ring = [];
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  /* 若中间件运行时与 Node 侧共享全局对象，这里同步一次等级（不共享也无害：
   * 中间件各自从 ctx.options.log_level 现读）。 */
  try {
    globalThis.__MEMHUB_LOG_LEVEL__ = _level;
  } catch (_) {}
  if (_level === 0) {
    const cleaned = cleanupLogs();
    return { level: "off", dir: _dir, cleaned };
  }
  try {
    fs.mkdirSync(_dir, { recursive: true });
  } catch (_) {}
  return { level: raw, dir: _dir };
}

/** 清理全部日志产物。返回删除的文件/目录数（测试断言用）。 */
export function cleanupLogs() {
  let removed = 0;
  const dir = _dir || defaultLogsDir();
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  } catch (_) {}
  for (const p of [LOGS_JSON_PATH, LOGS_JS_PATH]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed++;
      }
    } catch (_) {}
  }
  _ring = [];
  return { removed };
}

/**
 * 把环形缓冲落成设置页可读快照：_logs.json（真相源）+ _logs.js（window.__memhubLogs，
 * 设置页用动态 script 标签加载，与 _status.js 同模式）。节流由 scheduleFlush 负责，
 * 测试可直接调用强制落盘。
 */
export function flushLogsSnapshot() {
  if (_level < 1) return false;
  const name = Object.keys(LEVELS).find((k) => LEVELS[k] === _level) || "off";
  const payload = {
    generated_at: new Date().toISOString(),
    level: name,
    count: _ring.length,
    entries: _ring.slice()
  };
  try {
    const json = JSON.stringify(payload, null, 2);
    const tmpJ = LOGS_JSON_PATH + ".tmp";
    fs.writeFileSync(tmpJ, json, "utf8");
    fs.renameSync(tmpJ, LOGS_JSON_PATH);
    const tmpS = LOGS_JS_PATH + ".tmp";
    fs.writeFileSync(tmpS, "window.__memhubLogs = " + json + ";\n", "utf8");
    fs.renameSync(tmpS, LOGS_JS_PATH);
    return true;
  } catch (_) {
    return false;
  }
}

export function currentLogLevel() {
  return _level;
}

export function logError(...args) {
  emit("error", 1, args);
}

export function logInfo(...args) {
  emit("info", 2, args);
}

export function logDebug(...args) {
  emit("debug", 3, args);
}
