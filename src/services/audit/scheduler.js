/**
 * 模块职责：定时去重后台调度器管理、触发检查与召回频次统计
 * 依赖：src/core/**, src/integration/**, src/services/audit/auditor.js, local_state.js
 * 被依赖：src/tools/**, src/index.js, tools.js
 */

import { nowSql, readOptions } from "../../core/config.js";
import { isTestMode } from "../../../gateway_harvest.js";
import { isDedupDue, getDedupTimeWindow } from "../../core/time.js";
import { makeClient, isCfgShape } from "../../integration/ncb.js";
import { lookupAuditState, clearAuditCursor } from "../../../local_state.js";
import { memoryAudit, resetIsAuditing } from "./auditor.js";

export function trackMemoryRetrievals(client, rows) {
  if (!client || typeof client.update !== "function" || !Array.isArray(rows) || !rows.length) return;
  const now = nowSql();
  const updates = rows
    .filter((r) => r && r.id)
    .slice(0, 5)
    .map((r) =>
      client.update("memories", r.id, {
        retrieval_count: (Number(r.retrieval_count) || 0) + 1,
        last_used_at: now,
      })
    );
  Promise.allSettled(updates).catch(() => {});
}


let _auditTimer = null;
let _auditSchedulerStarted = false;
export let _auditOptionsGetter = null;
let _auditBaseClient = null;
let _auditBaseCfg = null;

export function setAuditSchedulerContext(og, baseCfg, baseClient) {
  _auditOptionsGetter = og;
  if (baseCfg) _auditBaseCfg = baseCfg;
  if (baseClient) _auditBaseClient = baseClient;
}

export function stopAuditScheduler() {
  if (_auditTimer) {
    clearInterval(_auditTimer);
    _auditTimer = null;
  }
  _auditSchedulerStarted = false;
  _auditOptionsGetter = null;
  _auditBaseClient = null;
  _auditBaseCfg = null;
  resetIsAuditing();
}

export async function checkScheduledDedup(client, cfg) {
  const schedule = (cfg && (cfg.dedup_schedule || cfg.audit_interval || cfg.auditInterval)) || "off";
  if (schedule === "off" || schedule === "none") return null;

  const state = lookupAuditState();
  const isPending = Boolean(state && state.last_dedup_pending);
  const isDue = isPending || isDedupDue({
    schedule,
    time: cfg.dedup_time || "02:00",
    weekday: cfg.dedup_weekday || 1,
    day: cfg.dedup_day || 1,
    lastDedupAt: state.last_dedup_at || state.last_audit_at,
  });

  if (!isDue) {
    return { skipped: true, reason: "schedule_not_due", last_dedup_at: state.last_dedup_at || state.last_audit_at };
  }

  if (!client || typeof client.list !== "function") {
    return { skipped: true, reason: "client_not_ready" };
  }

  try {
    // 【P1-4】新周期首次触发（非 5 分钟截断接力）必须清空上一周期遗留的表尾游标，
    // 否则 incremental 会跳过 id <= oldMaxId 的全部既有记录，新周期体检形同虚设。
    if (!isPending) {
      try {
        clearAuditCursor(cfg.project || "global");
      } catch (_) {}
    }
    const updatedAfter = getDedupTimeWindow(schedule);
    const res = await memoryAudit(client, cfg, {
      project: cfg.project || "global",
      schedule,
      updated_after: updatedAfter,
      incremental: true,
      batch_size: cfg.dedup_batch_size || cfg.dedup_fetch_limit || 1000,
      fetch_limit: cfg.dedup_fetch_limit || 1000,
    });
    return res;
  } catch (err) {
    console.error("[memory-hub] checkScheduledDedup error:", (err && err.message) || err);
    return null;
  }
}

// 【P0-1】ensureAuditScheduler 闭包配置读取与动态刷新
export function ensureAuditScheduler(client, cfg, optionsGetter) {
  // 兼容单参数传 cfg 场景：ensureAuditScheduler({ dedup_schedule: "daily" })
  if (client && !cfg && typeof client === "object" && typeof client.list !== "function" && typeof client.query !== "function") {
    cfg = client;
    client = null;
  }

  const isNoSched = (cfg && cfg._no_scheduler === true) || (optionsGetter && optionsGetter._no_scheduler === true);
  if (isNoSched) {
    return {
      getFreshCfg,
      getFreshClient,
      started: _auditSchedulerStarted,
      stop: stopAuditScheduler,
      runScheduled,
    };
  }

  if (optionsGetter) {
    _auditOptionsGetter = optionsGetter;
  }
  if (cfg) {
    _auditBaseCfg = cfg;
  }
  if (client) {
    _auditBaseClient = client;
  }

  function getFreshCfg() {
    let latest = _auditBaseCfg || cfg;
    try {
      const getter = _auditOptionsGetter || optionsGetter;
      if (typeof getter === "function") {
        const res = getter();
        if (res && typeof res === "object") latest = res;
      } else if (getter && typeof getter === "object") {
        latest = readOptions(getter);
      }
    } catch (_) {}
    return latest || _auditBaseCfg || cfg;
  }

  function getFreshClient(freshCfg) {
    try {
      if (freshCfg && isCfgShape(freshCfg)) {
        const c = makeClient(freshCfg);
        if (c && !c._isNoCredentials && typeof c.list === "function") return c;
      }
    } catch (_) {}
    const baseClient = _auditBaseClient || client;
    if (baseClient && typeof baseClient.list === "function") return baseClient;
    return null;
  }

  async function runScheduled() {
    const freshCfg = getFreshCfg();
    const schedNow = (freshCfg && (freshCfg.dedup_schedule || freshCfg.audit_interval || freshCfg.auditInterval)) || "off";
    if (schedNow === "off" || schedNow === "none") {
      stopAuditScheduler();
      return null;
    }
    const freshClient = getFreshClient(freshCfg);
    return await checkScheduledDedup(freshClient, freshCfg);
  };

  const currentCfg = getFreshCfg();
  const sched = (currentCfg && (currentCfg.dedup_schedule || currentCfg.audit_interval || currentCfg.auditInterval)) || "off";
  if (sched === "off" || sched === "none") {
    stopAuditScheduler();
    return { getFreshCfg, getFreshClient, started: false, stop: stopAuditScheduler, runScheduled };
  }

  if (_auditSchedulerStarted) {
    return { getFreshCfg, getFreshClient, started: true, stop: stopAuditScheduler, runScheduled };
  }
  _auditSchedulerStarted = true;

  if (!isTestMode()) {
    runScheduled().catch((e) => {
      console.error("[memory-hub] 启动去重检查跳过:", (e && e.message) || e);
    });

    _auditTimer = setInterval(() => {
      runScheduled().catch((e) => {
        console.error("[memory-hub] 定时去重跳过:", (e && e.message) || e);
      });
    }, 5 * 60 * 1000);
    if (_auditTimer && _auditTimer.unref) _auditTimer.unref();
  }

  return { getFreshCfg, getFreshClient, started: true, stop: stopAuditScheduler, runScheduled };
}

/* ================================================================== *
 * 工具清单（MCP 名 = magpie-memory-hub_<name>）
 * ================================================================== */
