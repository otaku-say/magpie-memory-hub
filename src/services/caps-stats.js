/**
 * 模块职责：能力幻觉遥测的落盘与聚合（检测「模型调了未通告的工具」并给出降档建议）
 * 依赖：node:fs, node:os, node:path, src/core/logger.js, src/core/status-writer.js
 * 被依赖：src/services/harvest/hook-response.js, src/page/actions.js（读侧）, settings 页
 *
 * 为什么需要持久化：中间件运行在无文件系统的受限沙箱，只能把检测结果放到
 * ctx.state.capsTelemetry；真正落盘必须由宿主侧钩子（有 fs）完成。
 *
 * 节流：幻觉是稀有事件，但钩子会被每个请求调用。写入限流 60s，
 * 并且在【没有新幻觉】时只做内存累加、不落盘，避免把日志盘写坏。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logError } from "../core/logger.js";

const DIR = path.join(os.homedir(), ".magpie-memory-hub");
const FILE = path.join(DIR, "caps-stats.json");
const WRITE_THROTTLE_MS = 60 * 1000;
const MAX_AGENTS = 50;

let _lastWriteAt = 0;
let _dirty = false;
let _memo = null;

function emptyStats() {
  return { version: 1, updatedAt: 0, agents: {} };
}

function loadStats() {
  try {
    if (!fs.existsSync(FILE)) return emptyStats();
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!raw || typeof raw !== "object" || !raw.agents || typeof raw.agents !== "object") return emptyStats();
    return raw;
  } catch (_) {
    return emptyStats();
  }
}

function saveStats(stats) {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    stats.updatedAt = Date.now();
    const tmp = FILE + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, FILE);
    return true;
  } catch (e) {
    logError("[memory-hub] caps-stats 写盘失败：" + String((e && e.message) || e));
    return false;
  }
}

function agentKeyOf(t) {
  const a = String((t && t.agent) || "").trim();
  return a ? a.slice(0, 64) : "(unknown)";
}

/**
 * 由宿主侧 onResponse 钩子调用。ctx.state.capsTelemetry 为中间件写入的检测结果。
 * 任何异常一律吞掉：遥测绝不能影响主链路。
 */
export function recordCapsTelemetry(ctx, nowMs) {
  try {
    const t = ctx && ctx.state && ctx.state.capsTelemetry;
    if (!t || typeof t !== "object") return null;

    const stats = _memo && _memo.__loaded ? _memo : Object.assign(loadStats(), { __loaded: true });
    _memo = stats;
    const key = agentKeyOf(t);
    const a = stats.agents[key] || (stats.agents[key] = {
      requests: 0, guideInjected: 0, toolCalls: 0, memoryToolCalls: 0,
      hallucinated: 0, lastSeen: 0, lastHallucination: null,
    });

    a.requests += 1;
    if (t.injected) a.guideInjected += 1;
    a.toolCalls += Number(t.toolCalls) || 0;
    a.memoryToolCalls += Number(t.memoryToolCalls) || 0;
    a.lastSeen = Number(t.at) || Date.now();
    a.hasTools = !!t.hasTools;
    a.present = !!t.present;
    if (t.tier != null) a.lastTier = t.tier;

    const hc = Number(t.hallucinatedCount) || 0;
    if (hc > 0) {
      a.hallucinated += hc;
      const first = Array.isArray(t.hallucinated) && t.hallucinated[0] ? t.hallucinated[0] : null;
      a.lastHallucination = { at: a.lastSeen, kind: first ? first.kind : "unadvertised", name: first ? first.name : "" };
      _dirty = true;
    }

    /* 建议：幻觉次数够多且几乎没真正用上工具 → 该客户端应当降档 */
    a.suggestion = null;
    if (a.hallucinated >= 3 && a.memoryToolCalls <= Math.floor(a.requests * 0.1)) {
      a.suggestion = {
        reason: "hallucinated_calls",
        hallucinated: a.hallucinated,
        requests: a.requests,
        profile: { mcp: "no", forbid_tools: ["*_memory_*", "*_pitfall_*"] },
      };
    }

    /* 代理数量封顶，防脏数据无限膨胀 */
    const keys = Object.keys(stats.agents);
    if (keys.length > MAX_AGENTS) {
      keys
        .filter((k) => k !== key)
        .sort((x, y) => (stats.agents[x].lastSeen || 0) - (stats.agents[y].lastSeen || 0))
        .slice(0, keys.length - MAX_AGENTS)
        .forEach((k) => { delete stats.agents[k]; });
      _dirty = true;
    }

    const now = Number(nowMs) || Date.now();
    if (_dirty && now - _lastWriteAt >= WRITE_THROTTLE_MS) {
      const clean = { version: stats.version || 1, updatedAt: 0, agents: stats.agents };
      if (saveStats(clean)) { _lastWriteAt = now; _dirty = false; }
    }
    return a;
  } catch (_) {
    return null;
  }
}

/** 读侧：给设置页 / 排查用 */
export function readCapsStats() {
  return loadStats();
}

/** 测试用：清空内存缓存与节流状态 */
export function _resetCapsStatsCache() {
  _memo = null;
  _dirty = false;
  _lastWriteAt = 0;
}

/**
 * 生成给设置页的一张摘要卡 + 一份可直接合并进 client_profiles 的降档画像。
 * 为什么放这里而不是页面里：页面跑在 connect-src 'none' 的 iframe，拿不到文件；
 * 只能由宿主读盘后写进 _status.js，页面再读 window.__memhubStatus。
 */
export function buildCapsSummary() {
  const stats = loadStats();
  const agents = Object.keys(stats.agents || {});
  if (!agents.length) {
    return {
      op: "caps_stats",
      ok: true,
      title: "能力统计：尚无数据",
      lines: ["还没有任何请求被记录，先让 agent 跑几轮再来看", "统计文件：" + FILE],
    };
  }
  const suggestions = {};
  const rows = [];
  agents
    .sort((a, b) => (stats.agents[b].hallucinated || 0) - (stats.agents[a].hallucinated || 0))
    .forEach((name) => {
      const a = stats.agents[name] || {};
      if (a.suggestion && a.suggestion.profile) suggestions[name] = a.suggestion.profile;
      rows.push({
        agent: name,
        requests: a.requests || 0,
        hallucinated: a.hallucinated || 0,
        memoryToolCalls: a.memoryToolCalls || 0,
        tier: a.lastTier == null ? null : a.lastTier,
        suggested: !!suggestions[name],
      });
    });
  const hall = rows.reduce((n, r) => n + r.hallucinated, 0);
  const suggestCount = Object.keys(suggestions).length;
  const lines = rows
    .slice(0, 4)
    .map((r) => r.agent + "：幻觉 " + r.hallucinated + " 次 / 请求 " + r.requests + " 次" + (r.suggested ? "（建议降档）" : ""));
  lines.push("共 " + hall + " 次幻觉调用；" + (suggestCount ? suggestCount + " 个客户端建议降档" : "暂无降档建议"));
  return {
    op: "caps_stats",
    ok: true,
    title: "能力统计：" + agents.length + " 个客户端",
    lines,
    detail: { agents: rows, suggestions, at: stats.updatedAt || 0 },
  };
}

export function capsStatsPath() {
  return FILE;
}
