/* settings.js — 记忆中枢设置页
 *
 * 页面跑在 Magpie 窗口的沙箱 iframe 里（allow-scripts，connect-src 'none'），
 * 自身不能联网，也不碰 Magpie 的 /api；一切经由 _magpie/bridge.js 与窗口通信：
 *   await magpie.ready           主题就绪
 *   await magpie.options.get()   读本插件的 options（plugins.json）
 *   await magpie.options.set(o)  写回，并返回写后的值
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var CARD_FIELDS = {
    ncb: ["ncb_instance", "mcp_key", "ncb_secret", "on_exist", "auto_init"],
    r2: ["r2_account_id", "r2_access_key_id", "r2_secret_access_key", "r2_bucket_name", "r2_public_url"],
    model: ["extract_model", "classify_model", "audit_model", "dedup_schedule", "dedup_time", "dedup_weekday", "dedup_day", "dedup_batch_size", "classify_endpoint", "search_rewrite", "search_rerank", "harvest_max_per_min", "harvest_max_total"],
    harvest: ["auto_harvest", "gatewayTimeoutMs"],
    extract: ["inline_extract", "min_confidence"],
    inject: ["inject_principles", "ccr_cards", "max_inject_count", "max_budget_chars", "max_principles", "disabled"]
  };

  var TEXT = [
    "ncb_instance", "ncb_secret", "mcp_key",
    "r2_account_id", "r2_access_key_id", "r2_secret_access_key",
    "r2_bucket_name", "r2_public_url",
    "extract_model", "classify_model", "audit_model", "dedup_time"
  ];
  var SELECT = ["on_exist", "classify_endpoint", "dedup_schedule", "dedup_weekday"];
  var NUM = {
    min_confidence: 0.6,
    max_inject_count: 5,
    max_budget_chars: 2048,
    max_principles: 2,
    gatewayTimeoutMs: 8000,
    harvest_max_per_min: 20,
    harvest_max_total: 2000,
    dedup_day: 1,
    dedup_batch_size: 50
  };
  var BOOL = [
    "auto_init",
    "auto_harvest",
    "inline_extract",
    "disabled",
    "ccr_cards",
    "inject_principles",
    "search_rewrite",
    "search_rerank"
  ];

  var current = {};
  var lastSubmitTime = 0;
  var pollingTimers = new Map();
  var countdownTimers = new Map();

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ---------------- MCP 地址 ---------------- */
  function mcpUrl() {
    var o = location.origin;
    if (o.indexOf("-web.") !== -1) o = o.replace("-web.", "-api.");
    return o.replace(/\/+$/, "") + "/mcp/magpie/tools";
  }

  /* ---------------- 状态行与各卡片反馈 ---------------- */
  /* ---------------- 带 1100ms 防抖的排队保存器 ----------------
   * 依据：Magpie 源码 internal/gui/pluginpage.go 的 pageSetAllowed 规则，
   * 限制两次 options.set 间隔须 ≥ 1000ms，违者返回 HTTP 429。
   * 防抖排队器机制：
   *   1. 连续快速改动/连击时，合并 payload 并防抖 1100ms，仅最后一次真正落盘，绝不丢配置；
   *   2. 关键动作（例如提交信标 _action、点「保存」按钮）立即 flush 队列，保证时效敏感信标零延迟；
   *   3. 若距离上次底层落盘不足 1000ms，即使要求 immediate 也会安全排队至频控窗口结束，规避 429；
   *   4. 无论何种写入，始终保留已有的 options 与 memories 快照。
   */
  var queuedTimer = null;
  var queuedPayload = null;
  var queuedResolvers = [];
  var lastUnderlyingSetTime = 0;

  function flushQueuedOptionsSet() {
    if (queuedTimer) {
      clearTimeout(queuedTimer);
      queuedTimer = null;
    }
    if (!queuedPayload) return Promise.resolve(current);

    var toSend = queuedPayload;
    var resolvers = queuedResolvers;
    queuedPayload = null;
    queuedResolvers = [];

    if (!window.magpie || !window.magpie.options || typeof window.magpie.options.set !== "function") {
      var noBridgeErr = new Error("桥接未就绪");
      for (var j = 0; j < resolvers.length; j++) resolvers[j].reject(noBridgeErr);
      return Promise.reject(noBridgeErr);
    }

    lastUnderlyingSetTime = Date.now();
    return window.magpie.options.set(toSend).then(
      function (written) {
        current = written || toSend;
        for (var i = 0; i < resolvers.length; i++) {
          resolvers[i].resolve(written);
        }
        return written;
      },
      function (err) {
        for (var i = 0; i < resolvers.length; i++) {
          resolvers[i].reject(err);
        }
      }
    );
  }

  function queuedOptionsSet(payload, immediate) {
    if (!queuedPayload) {
      queuedPayload = Object.assign({}, payload || {});
    } else {
      Object.assign(queuedPayload, payload || {});
    }

    return new Promise(function (resolve, reject) {
      queuedResolvers.push({ resolve: resolve, reject: reject });

      var isImmediate = !!(immediate || (payload && payload._action));
      var now = Date.now();
      var timeSinceLast = now - lastUnderlyingSetTime;

      if (isImmediate && (lastUnderlyingSetTime === 0 || timeSinceLast >= 1000)) {
        flushQueuedOptionsSet();
      } else {
        if (queuedTimer) clearTimeout(queuedTimer);
        var delay = isImmediate ? Math.max(1100 - timeSinceLast, 50) : 1100;
        queuedTimer = setTimeout(flushQueuedOptionsSet, delay);
      }
    });
  }

  var statusTimer = null;
  function say(msg, kind) {
    var el = $("status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
    if (statusTimer) clearTimeout(statusTimer);
    if (msg) {
      statusTimer = setTimeout(function () {
        el.textContent = "";
        el.className = "status";
      }, 4000);
    }
  }

  var cardStatusTimers = {};
  function cardSay(statusId, msg, kind) {
    var el = $(statusId);
    if (!el) return;
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
    if (cardStatusTimers[statusId]) clearTimeout(cardStatusTimers[statusId]);
    if (msg) {
      cardStatusTimers[statusId] = setTimeout(function () {
        el.textContent = "";
        el.className = "status";
      }, 4000);
    }
  }

  /* ---------------- 时间与定时去重表单辅助 ---------------- */
  function formatDateTime(d) {
    if (!d) return "";
    var date = (d instanceof Date) ? d : new Date(d);
    if (isNaN(date.getTime())) return "";
    var y = date.getFullYear();
    var mon = date.getMonth() + 1;
    var day = date.getDate();
    var h = date.getHours();
    var min = date.getMinutes();
    var monStr = mon < 10 ? "0" + mon : "" + mon;
    var dayStr = day < 10 ? "0" + day : "" + day;
    var hStr = h < 10 ? "0" + h : "" + h;
    var minStr = min < 10 ? "0" + min : "" + min;
    return y + "-" + monStr + "-" + dayStr + " " + hStr + ":" + minStr;
  }

  function normalizeUndoTime(str) {
    if (!str) return "";
    var s = String(str).trim();
    if (!s) return "";
    s = s.replace(/\//g, "-");
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (m) {
      var y = m[1];
      var mon = parseInt(m[2], 10);
      var d = parseInt(m[3], 10);
      var h = m[4] !== undefined ? parseInt(m[4], 10) : 0;
      var min = m[5] !== undefined ? parseInt(m[5], 10) : 0;
      if (mon < 1 || mon > 12 || d < 1 || d > 31 || h < 0 || h > 23 || min < 0 || min > 59) return null;
      var monStr = mon < 10 ? "0" + mon : "" + mon;
      var dayStr = d < 10 ? "0" + d : "" + d;
      var hStr = h < 10 ? "0" + h : "" + h;
      var minStr = min < 10 ? "0" + min : "" + min;
      return y + "-" + monStr + "-" + dayStr + " " + hStr + ":" + minStr;
    }
    if (/^\d{10,13}$/.test(s)) {
      var ts = Number(s);
      if (s.length === 10) ts *= 1000;
      return formatDateTime(new Date(ts));
    }
    var parsed = Date.parse(s.replace(/-/g, "/"));
    if (!isNaN(parsed)) {
      return formatDateTime(new Date(parsed));
    }
    return null;
  }

  function updateDedupUI() {
    var schedEl = $("dedup_schedule");
    var sched = schedEl ? schedEl.value : "off";
    var wrapWeekday = $("wrap_dedup_weekday");
    var wrapDay = $("wrap_dedup_day");

    if (wrapWeekday) wrapWeekday.style.display = (sched === "weekly") ? "inline-flex" : "none";
    if (wrapDay) wrapDay.style.display = (sched === "monthly") ? "inline-flex" : "none";

    var hourEl = $("dedup_hour");
    var minEl = $("dedup_minute");
    var h = hourEl ? parseInt(hourEl.value, 10) : 2;
    var m = minEl ? parseInt(minEl.value, 10) : 0;
    if (isNaN(h) || h < 0) h = 0;
    if (h > 23) h = 23;
    if (isNaN(m) || m < 0) m = 0;
    if (m > 59) m = 59;
    var hStr = h < 10 ? "0" + h : "" + h;
    var minStr = m < 10 ? "0" + m : "" + m;
    var timeStr = hStr + ":" + minStr;

    var timeInput = $("dedup_time");
    if (timeInput) timeInput.value = timeStr;

    var previewEl = $("dedup_preview");
    if (!previewEl) return;

    if (sched === "off") {
      previewEl.textContent = "已关闭定时去重";
    } else if (sched === "daily") {
      previewEl.textContent = "每天的 " + timeStr + " 执行一次";
    } else if (sched === "weekly") {
      var weekMap = { "1": "周一", "2": "周二", "3": "周三", "4": "周四", "5": "周五", "6": "周六", "7": "周日" };
      var wVal = $("dedup_weekday") ? String($("dedup_weekday").value || "1") : "1";
      var wName = weekMap[wVal] || "周一";
      previewEl.textContent = "每周 " + wName + " 的 " + timeStr + " 执行一次";
    } else if (sched === "monthly") {
      var d = $("dedup_day") ? parseInt($("dedup_day").value, 10) : 1;
      d = (isNaN(d) || d < 1) ? 1 : Math.min(28, d);
      previewEl.textContent = "每月 " + d + " 号 " + timeStr + " 执行一次";
    } else {
      previewEl.textContent = "已关闭定时去重";
    }
  }

  /* ---------------- 表单填充与收集 ---------------- */
  function fill(o) {
    o = o || {};
    TEXT.forEach(function (k) {
      var el = $(k); if (!el) return;
      if (k === "dedup_time" && !o[k]) {
        el.value = "02:00";
        return;
      }
      el.value = o[k] == null ? "" : String(o[k]);
    });
    Object.keys(NUM).forEach(function (k) {
      var el = $(k); if (!el) return;
      var v = parseFloat(o[k]);
      el.value = isNaN(v) ? NUM[k] : v;
    });
    BOOL.forEach(function (k) {
      var el = $(k); if (!el) return;
      if (k === "inline_extract" || k === "inject_principles" || k === "search_rewrite" || k === "search_rerank") {
        el.checked = o[k] !== false;
        return;
      }
      el.checked = !!o[k];
    });
    SELECT.forEach(function (k) {
      var el = $(k); if (!el) return;
      if (k === "on_exist" && !o[k]) {
        el.value = "reuse";
        return;
      }
      if (k === "classify_endpoint" && !o[k]) {
        el.value = "auto";
        return;
      }
      if (k === "dedup_schedule" && !o[k]) {
        el.value = o.audit_interval || "off";
        return;
      }
      if (k === "dedup_weekday" && !o[k]) {
        el.value = "1";
        return;
      }
      if (typeof o[k] === "string" || typeof o[k] === "number") el.value = String(o[k]);
    });

    // 定时去重表单联动填充：拆解 HH:MM 到小时和分钟
    var timeRaw = String(o.dedup_time || "02:00").trim();
    var tParts = timeRaw.split(":");
    var hourVal = parseInt(tParts[0], 10);
    var minVal = parseInt(tParts[1], 10);
    if (isNaN(hourVal) || hourVal < 0 || hourVal > 23) hourVal = 2;
    if (isNaN(minVal) || minVal < 0 || minVal > 59) minVal = 0;
    if ($("dedup_hour")) $("dedup_hour").value = hourVal;
    if ($("dedup_minute")) $("dedup_minute").value = minVal;
    if ($("dedup_time")) {
      $("dedup_time").value = (hourVal < 10 ? "0" + hourVal : "" + hourVal) + ":" + (minVal < 10 ? "0" + minVal : "" + minVal);
    }
    if ($("dedup_schedule") && o.dedup_schedule) {
      $("dedup_schedule").value = o.dedup_schedule;
    }
    if ($("dedup_weekday") && o.dedup_weekday) {
      $("dedup_weekday").value = String(o.dedup_weekday);
    }
    if ($("dedup_day") && o.dedup_day != null) {
      var dv = parseInt(o.dedup_day, 10);
      $("dedup_day").value = isNaN(dv) ? 1 : Math.max(1, Math.min(28, dv));
    }
    updateDedupUI();
  }

  function collect() {
    var next = {};
    // 保留外部写入的字段（memories 缓存数组、_action、custom 字段等），避免保存时被冲掉
    Object.keys(current).forEach(function (k) { next[k] = current[k]; });
    TEXT.forEach(function (k) {
      var el = $(k); if (!el) return;
      next[k] = el.value.trim();
    });
    Object.keys(NUM).forEach(function (k) {
      var el = $(k); if (!el) return;
      var v = parseFloat(el.value);
      next[k] = isNaN(v) ? NUM[k] : v;
    });
    BOOL.forEach(function (k) {
      var el = $(k); if (!el) return;
      next[k] = el.checked;
    });
    SELECT.forEach(function (k) {
      var el = $(k); if (!el) return;
      next[k] = el.value;
    });

    // 定时去重表单组合：小时与分钟拼回 HH:MM
    var h = $("dedup_hour") ? parseInt($("dedup_hour").value, 10) : 2;
    var m = $("dedup_minute") ? parseInt($("dedup_minute").value, 10) : 0;
    if (isNaN(h) || h < 0) h = 0; if (h > 23) h = 23;
    if (isNaN(m) || m < 0) m = 0; if (m > 59) m = 59;
    var timeStr = (h < 10 ? "0" + h : "" + h) + ":" + (m < 10 ? "0" + m : "" + m);
    next.dedup_time = timeStr;
    if ($("dedup_time")) $("dedup_time").value = timeStr;

    if ($("dedup_schedule")) next.dedup_schedule = $("dedup_schedule").value;
    if ($("dedup_weekday")) next.dedup_weekday = parseInt($("dedup_weekday").value, 10) || 1;
    if ($("dedup_day")) {
      var d = parseInt($("dedup_day").value, 10);
      next.dedup_day = (isNaN(d) || d < 1) ? 1 : Math.min(28, d);
    }
    if (typeof next.gatewayTimeoutMs !== "number" || isNaN(next.gatewayTimeoutMs)) {
      next.gatewayTimeoutMs = (typeof current.gatewayTimeoutMs === "number" && !isNaN(current.gatewayTimeoutMs)) ? current.gatewayTimeoutMs : 8000;
    }
    if (!Array.isArray(next.memories)) next.memories = [];
    return next;
  }

  function describeMode(o) {
    o = o || {};
    var db = String(o.ncb_instance || "").trim();
    var key = String(o.mcp_key || "").trim();
    var secret = String(o.ncb_secret || "").trim();
    if (!db || (!key && !secret)) {
      if (!db && !key && !secret) {
        return "⚠️ 未完成配置：请填写下方 MCP Key 与数据库名称，然后点击「一键创建数据库」";
      }
      if (!db) {
        return "⚠️ 未完成配置：请填写数据库名称，然后点击「一键创建数据库」";
      }
      return "⚠️ 未完成配置：请填写 MCP Key，然后点击「一键创建数据库」";
    }

    var parts = [];
    parts.push("数据库：" + db);
    parts.push("内联提炼 " + (o.inline_extract !== false ? "开" : "关"));
    var conf = (o.min_confidence != null && !isNaN(parseFloat(o.min_confidence))) ? o.min_confidence : 0.6;
    parts.push("入库门槛 " + conf);
    if (o.disabled) parts.push("网关注入已停用");
    return parts.join(" · ");
  }

  function paintMode(o) {
    var el = $("mode");
    if (!el) return;
    o = o || {};
    var db = String(o.ncb_instance || "").trim();
    var key = String(o.mcp_key || "").trim();
    var secret = String(o.ncb_secret || "").trim();
    var notConfigured = !db || (!key && !secret);
    var textEl = $("mode_text");
    if (textEl) {
      textEl.textContent = describeMode(o);
    } else {
      el.textContent = describeMode(o);
    }
    el.className = "mode" + (notConfigured ? " warn" : " ok");
  }

  function check(o) {
    if (!o.ncb_instance) return "数据库名称为空，记忆将无法存取";
    if (!o.ncb_secret && !o.mcp_key) return "未填 Secret Key 或 MCP Key：新建库请填写 MCP Key";
    if (o.min_confidence != null && (o.min_confidence < 0 || o.min_confidence > 1))
      return "最低入库置信度应在 0~1 之间";
    if (o.harvest_max_per_min != null && (o.harvest_max_per_min < 1 || o.harvest_max_per_min > 600))
      return "每分钟调用上限应在 1~600 之间";
    if (o.harvest_max_total != null && (o.harvest_max_total < 10 || o.harvest_max_total > 100000))
      return "单进程累计上限应在 10~100000 之间";
    return "";
  }

  /* 卡片 key → 状态容器 id。多处共用，提成常量避免各写一份写歪。 */
  /* 正在等待更新的卡片 → 提交时间戳。
   * 为什么需要它：renderAllStatus 会把 _status.js 里的结果全量画一遍，
   * 于是「刚画出等待态 → 轮询用上一次的旧结果覆盖 → 又画等待态」会来回打架，
   * 用户看到两个提示交替闪。所以等待中的卡片只接受【比提交时间更新】的结果。 */
  var pendingSince = {};

  var containerMap = {
    ncb: "db_action_status",
    r2: "r2_action_status",
    model: "model_action_status",
    gateway: "harvest_action_status",
    inject: "inject_action_status"
  };

  /**
   * 通过 op 或 cardKey 推导归属卡片 key（统一纯函数派生）：
   * - ncb: provision, ncb_check, secret_check, init, reset, status
   * - r2: storage_setup, r2_check, clean_probe
   * - model: model_check
   * - gateway: harvest_gateway
   */
  function cardOfOp(op) {
    if (!op || typeof op !== "string") return "ncb";
    var s = String(op).toLowerCase().trim();
    if (s === "r2" || s === "storage_setup" || s === "r2_check" || s === "clean_probe") {
      return "r2";
    }
    if (s === "model" || s === "model_check" || s === "memory_audit" || s === "audit" || s === "dedup_undo") {
      return "model";
    }
    if (s === "gateway" || s === "harvest" || s === "harvest_gateway") {
      return "gateway";
    }
    if (s === "inject" || s === "sync_snapshot") {
      return "inject";
    }
    return "ncb";
  }

  /**
   * 通过 op 或 cardKey 推导目标卡片状态容器 DOM ID。
   * 全局唯一卡片状态路由函数，所有写状态、等待、倒计时每一帧、超时、重试、轮询渲染、页面初始化均必须走它，严禁各处手写默认容器。
   */
  function containerOfOp(op) {
    var cardKey = cardOfOp(op);
    return containerMap[cardKey] || "db_action_status";
  }

  if (typeof window !== "undefined") {
    window.__cardOfOp = cardOfOp;
    window.__containerOfOp = containerOfOp;
  }

  /* ---------------- 状态展示与结果回传渲染 ---------------- */
  function renderStatusBlock(containerId, statusObj) {
    var el = $(containerId);
    if (!el) return;
    if (!statusObj || !statusObj.title) return;

    el.style.display = "block";
    var okClass = statusObj.ok ? "ok" : "bad";
    el.className = "action-status-box " + okClass;

    var html = '<div class="action-status-header">';
    html += '<span class="action-status-badge ' + okClass + '">' + (statusObj.ok ? "✓ 成功" : "✗ 失败") + "</span>";
    html += '<strong class="action-status-title">' + escapeHtml(statusObj.title) + "</strong>";
    if (statusObj.at) {
      var timeStr = new Date(statusObj.at).toLocaleString("zh-CN", { hour12: false });
      html += '<span class="action-status-time">' + escapeHtml(timeStr) + "</span>";
    }
    html += "</div>";

    if (Array.isArray(statusObj.lines) && statusObj.lines.length > 0) {
      html += '<ul class="action-status-lines">';
      statusObj.lines.forEach(function (line) {
        html += "<li>" + escapeHtml(line) + "</li>";
      });
      html += "</ul>";
    }

    if (containerId === "harvest_action_status") {
      var isMissing = !statusObj.ok || (statusObj.title && statusObj.title.indexOf("未检测到") !== -1) ||
        (Array.isArray(statusObj.lines) && statusObj.lines.some(function (l) { return l.indexOf("未检测到") !== -1; }));
      if (isMissing) {
        html += '<div class="harvest-guide-tip">' +
          '<strong>💡 开启指引（备选路径）：</strong>若需扫描本地对话录制，请打开 <strong>设置 → 插件</strong>，找到内置插件 <strong>「会话」</strong> 把它打开（显示 <strong>「正在记录网关对话」</strong>）。插件本页<strong>无法代你开启</strong>，需先在 Magpie 插件页打开。<br><em>（提示：若已开启上方的「自动记忆」，网关会直接提供对话，无需开启「会话」录制。）</em>' +
        '</div>';
      }
    }

    if (containerId === "db_action_status") {
      var secVal = $("ncb_secret") ? $("ncb_secret").value.trim() : "";
      if (!secVal) {
        html += '<div class="secret-guide-tip">' +
          '<strong>💡 Secret Key 提示：</strong>当前未在设置页显式填写 Secret Key。Secret Key 只在建库时返回一次，MCP Key 无法读取，插件也无法自行取回；R2 的列举与探针清理需要它。若需获取，请前往 <strong>NoCodeBackend 控制台 → 该数据库 → 复制 Secret Key</strong> 填入。' +
        '</div>';
      }
    }

    if (containerId === "r2_action_status") {
      var hasProbeResidue = (statusObj && statusObj.probe && statusObj.probe.cleaned === false) ||
        (Array.isArray(statusObj.lines) && statusObj.lines.some(function (l) { return l.indexOf("探针残留提示") !== -1 || l.indexOf("探针文件已留在") !== -1; }));
      if (hasProbeResidue) {
        html += '<div class="secret-guide-tip r2-probe-tip">' +
          '<strong>⚠️ 探针残留提示：</strong>检测探针已写入 R2 存储桶，但因删除需要数据库 Secret Key（当前未填或失效，只有 MCP Key 时只能上传不能删除），探针未能自动删除。<br>' +
          '<strong>清理方法：</strong>请在上方「数据库设置」中填入 <strong>Secret Key</strong>，然后点击下方 <strong>「清理探针文件」</strong> 按钮即可一键批量删除所有探针。' +
        '</div>';
      }
    }

    el.innerHTML = html;
  }

  var knownDbPrefix = "";

  function renderDbPrefix(dbData) {
    var prefixEl = $("instance_prefix");
    var fullEl = $("instance_full_name");
    var tipEl = $("instance_full_tip");
    var inputEl = $("ncb_instance");
    if (!prefixEl) return;

    if (dbData && typeof dbData === "object") {
      if (dbData.prefix) {
        knownDbPrefix = String(dbData.prefix);
      }
    }

    var currentVal = (inputEl && inputEl.value.trim()) || (current && current.ncb_instance) || "";
    var m = currentVal.match(/^(\d+_)(.*)$/);
    var prefixToDisplay = "";
    var fullName = currentVal;

    if (m) {
      prefixToDisplay = m[1];
      knownDbPrefix = m[1];
      fullName = currentVal;
    } else if (knownDbPrefix) {
      prefixToDisplay = knownDbPrefix;
      fullName = currentVal ? (knownDbPrefix + currentVal) : "";
    } else if (dbData && dbData.prefix) {
      prefixToDisplay = dbData.prefix;
      fullName = dbData.full || (currentVal ? (dbData.prefix + currentVal) : "");
    }

    if (prefixToDisplay) {
      prefixEl.textContent = prefixToDisplay;
      prefixEl.title = "已解析的账号数字前缀（不可修改）";
      prefixEl.className = "input-prefix mono";
      if (fullEl) fullEl.textContent = fullName || "—";
      if (tipEl) {
        tipEl.textContent = "（NCB 远端真实库名）";
        tipEl.style.display = "inline";
      }
    } else {
      prefixEl.textContent = "—";
      prefixEl.title = "尚未获取到前缀，点「检测 MCP Key」获取";
      prefixEl.className = "input-prefix mono unk";
      if (fullEl) fullEl.textContent = currentVal || "—";
      if (tipEl) {
        tipEl.textContent = "（点「检测 MCP Key」获取前缀）";
        tipEl.style.display = "inline";
      }
    }
  }

  function renderAllStatus(statusData) {
    statusData = statusData || window.__memhubStatus;
    if (!statusData || typeof statusData !== "object") return;
    if (statusData.db) {
      renderDbPrefix(statusData.db);
    }
    var cardKeys = ["ncb", "r2", "model", "gateway", "inject"];
    for (var i = 0; i < cardKeys.length; i++) {
      var key = cardKeys[i];
      var cid = containerOfOp(key);
      var card = statusData[key];
      if (!card) continue;
      // 该卡片正在等待更新的结果 → 不用旧结果覆盖等待态
      if (pendingSince[key] && !(card.at >= pendingSince[key])) continue;
      renderStatusBlock(cid, card);
    }

    if (statusData.audit) {
      var auditCard = statusData.audit;
      var modelCard = statusData.model;
      var auditAt = Number((auditCard && auditCard.at) || 0);
      var modelAt = Number((modelCard && modelCard.at) || 0);
      // 只有 audit.at > model.at 时才允许用 audit 覆盖 model_action_status，防止旧去重状态覆盖最新模型检测
      var shouldRenderAuditToStatus = (!modelCard || auditAt > modelAt) && (!pendingSince.model || (auditCard.at >= pendingSince.model));
      if (shouldRenderAuditToStatus) {
        renderStatusBlock("model_action_status", auditCard);
      }
      var logBox = $("dedup_rolling_logs");
      if (logBox && Array.isArray(auditCard.logs) && auditCard.logs.length > 0) {
        var htmlLogs = auditCard.logs.map(function (line) {
          return '<div class="log-line">' + escapeHtml(line) + '</div>';
        }).join("");
        logBox.innerHTML = htmlLogs;
        logBox.scrollTop = logBox.scrollHeight;
      }
      if (auditCard.at) {
        var timeStr = formatDateTime(auditCard.at);
        var dedupCount = (auditCard.deduped && ((auditCard.deduped.memories || 0) + (auditCard.deduped.pitfalls || 0))) || 0;
        var lastTextEl = $("last_audit_at_text");
        if (lastTextEl) lastTextEl.textContent = timeStr;
        var summaryEl = $("last_dedup_summary");
        if (summaryEl) summaryEl.textContent = "上次去重：合并 " + dedupCount + " 条 · 时间 " + timeStr;
        var undoInput = $("undo_before_time");
        if (undoInput && !undoInput.value) {
          undoInput.value = timeStr;
        }
      }
    }
  }

  function loadStatus(callback) {
    if (typeof document === "undefined" || !document.createElement) {
      if (window.__memhubStatus) renderAllStatus(window.__memhubStatus);
      if (typeof callback === "function") callback(null, window.__memhubStatus);
      return;
    }
    var head = document.head || (document.getElementsByTagName && document.getElementsByTagName("head")[0]) || document.body || document.documentElement;
    if (!head) {
      if (window.__memhubStatus) renderAllStatus(window.__memhubStatus);
      if (typeof callback === "function") callback(null, window.__memhubStatus);
      return;
    }

    var oldScript = (document.querySelector && document.querySelector("script[data-memhub-status]")) || null;
    if (oldScript && oldScript.parentNode) {
      oldScript.parentNode.removeChild(oldScript);
    }

    var script = document.createElement("script");
    script.setAttribute("data-memhub-status", "true");
    script.src = "_status.js?t=" + Date.now();

    var done = false;
    var finish = function (data) {
      if (done) return;
      done = true;
      if (script.parentNode) script.parentNode.removeChild(script);
      if (data) renderAllStatus(data);
      if (typeof callback === "function") callback(null, data);
    };

    script.onload = function () {
      finish(window.__memhubStatus || null);
    };
    script.onerror = function () {
      finish(null);
    };

    head.appendChild(script);
  }

  /* 等待宿主动作的倒计时 + 重试。
   *
   * 为什么必须显式给出「倒计时 + 重试」：
   *   宿主动作是**异步**的（页面只写一个信标，宿主在下次被调用时才执行，
   *   结果经 _status.js 回传）。这个等待窗口最长 60 秒，期间如果只显示一句
   *   「已提交」，用户会以为按钮坏了。所以必须把「在等什么、还要等多久、
   *   等不到怎么办」三件事都摆在卡片里。
   */
  var WAIT_SECONDS = 60;

  function waitingHtml(cardKey, left, totalWait, opHint) {
    var total = totalWait || WAIT_SECONDS;
    var pct = Math.max(0, Math.min(100, Math.round((total - left) / total * 100)));
    var isModelCheck = opHint === "model_check" || cardKey === "model";
    var title = isModelCheck ? "正在检测在线模型…" : "正在等待宿主执行…";
    var badge = isModelCheck ? "⏳ 检测中" : "⏳ 等待中";
    var lines = isModelCheck
      ? '<li>已提交真实检测模型任务，宿主将实际调用模型并校验返回。</li><li>拿到结果会自动显示在此卡片，无需手动刷新。</li>'
      : '<li>页面只能提交任务，真正执行发生在宿主的下一次调用。</li><li>拿到结果会自动显示，无需手动刷新。</li>';
    return '' +
      '<div class="action-status-header">' +
        '<span class="action-status-badge wait">' + badge + '</span>' +
        '<strong class="action-status-title">' + title + '</strong>' +
        '<span class="action-status-time">剩余 ' + left + ' 秒</span>' +
      '</div>' +
      '<div class="wait-bar"><i style="width:' + pct + '%"></i></div>' +
      '<ul class="action-status-lines">' +
        lines +
      '</ul>';
  }

  function timeoutHtml(cardKey, totalWait) {
    var total = totalWait || WAIT_SECONDS;
    return '' +
      '<div class="action-status-header">' +
        '<span class="action-status-badge warn">⌛ 超时</span>' +
        '<strong class="action-status-title">宿主尚未回传结果</strong>' +
      '</div>' +
      '<ul class="action-status-lines">' +
        '<li>已等待 ' + total + ' 秒。常见原因：宿主还没被调用、或 _status.js 所在目录不可写。</li>' +
        '<li>可点下方「重新查询」，或与 agent 对话一次触发宿主加载后再查。</li>' +
      '</ul>' +
      '<div class="btn-row" style="margin-top:10px;">' +
        '<button type="button" class="tiny" data-retry="' + cardKey + '">重新查询</button>' +
      '</div>';
  }

  function startPollingStatus(targetCard, submitTime, opHint) {
    var resolvedCard = cardOfOp(opHint || targetCard);
    var containerId = containerOfOp(opHint || targetCard);

    if (pollingTimers.has(resolvedCard)) {
      clearInterval(pollingTimers.get(resolvedCard));
      pollingTimers.delete(resolvedCard);
    }
    if (countdownTimers.has(resolvedCard)) {
      clearInterval(countdownTimers.get(resolvedCard));
      countdownTimers.delete(resolvedCard);
    }

    // 等待期间只接受「比提交时间更新」的结果，避免旧结果把等待态刷掉（会来回闪）
    pendingSince[resolvedCard] = submitTime;
    var waitSec = WAIT_SECONDS;
    var el = $(containerId);
    var deadline = Date.now() + waitSec * 1000;

    // 立刻画出等待态，并每秒刷新倒计时 —— 用户点完按钮马上就有反馈
    function tick() {
      var box = $(containerId);
      if (!box) return;
      var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (left <= 0) return;
      box.style.display = "block";
      box.className = "action-status-box waiting";
      box.innerHTML = waitingHtml(resolvedCard, left, waitSec, opHint);
    }
    if (el) { el.style.display = "block"; el.className = "action-status-box waiting"; }
    tick();
    var cTimer = setInterval(tick, 1000);
    countdownTimers.set(resolvedCard, cTimer);

    var pTimer = setInterval(function () {
      loadStatus(function (err, statusData) {
        statusData = statusData || window.__memhubStatus;
        var isAuditOp = (opHint === "memory_audit" || opHint === "audit" || opHint === "dedup_undo");
        var card = statusData && (isAuditOp ? (statusData.audit || statusData.model) : statusData[resolvedCard]);
        if (card && card.at >= submitTime) {
          renderStatusBlock(containerId, card);
          var prog = card.progress;
          var inProgress = (prog && (prog.status === "downloading" || prog.status === "verifying" || prog.status === "starting")) || (card.status === "进行中");
          if (inProgress && card.ok !== false) {
            // 仍在处理中，延长超时时限，保持轮询更新进度
            deadline = Date.now() + waitSec * 1000;
            return;
          }
          // 拿到比提交时间更新且已完成的结果 → 停止该卡片一切计时
          if ((card.op === "sync_snapshot" || opHint === "sync_snapshot") && card.ok && Array.isArray(card.memories) && window.magpie && window.magpie.options) {
            try {
              var next = collect();
              next.memories = card.memories;
              next.memories_version = Date.now();
              delete next._action;
              queuedOptionsSet(next, true);
            } catch (_) {}
          }
          if (pollingTimers.has(resolvedCard)) {
            clearInterval(pollingTimers.get(resolvedCard));
            pollingTimers.delete(resolvedCard);
          }
          if (countdownTimers.has(resolvedCard)) {
            clearInterval(countdownTimers.get(resolvedCard));
            countdownTimers.delete(resolvedCard);
          }
          return;
        }
        if (Date.now() >= deadline) {
          if (pollingTimers.has(resolvedCard)) {
            clearInterval(pollingTimers.get(resolvedCard));
            pollingTimers.delete(resolvedCard);
          }
          if (countdownTimers.has(resolvedCard)) {
            clearInterval(countdownTimers.get(resolvedCard));
            countdownTimers.delete(resolvedCard);
          }
          delete pendingSince[resolvedCard];       // 超时：允许显示现有结果
          var box = $(containerId);
          if (box) {
            box.style.display = "block";
            box.className = "action-status-box warn";
            box.innerHTML = timeoutHtml(resolvedCard, waitSec);
            bindRetry(box, resolvedCard);
          }
        }
      });
    }, 2000);
    pollingTimers.set(resolvedCard, pTimer);
  }

  /** 给「重新查询」按钮绑定一次性重试。 */
  function bindRetry(box, cardKey) {
    var btns = box.querySelectorAll ? box.querySelectorAll("[data-retry]") : [];
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var resolvedCard = cardOfOp(cardKey);
        var containerId = containerOfOp(cardKey);
        var b = $(containerId);
        if (b) { b.className = "action-status-box waiting"; b.textContent = "正在重新查询…"; }
        loadStatus(function (e, data) {
          data = data || window.__memhubStatus;
          var card = data && data[resolvedCard];
          var b2 = $(containerId);
          if (card && b2) { renderStatusBlock(containerId, card); }
          else if (b2) {
            b2.className = "action-status-box warn";
            b2.innerHTML = timeoutHtml(resolvedCard);
            bindRetry(b2, resolvedCard);
          }
        });
      });
    }
  }

  /* ---------------- 数据库管理即时状态区 ---------------- */
  /* 把即时反馈精准画到「该操作所属的那张卡片」。
   * 所有写入提示框的状态都精准归属于对应卡片容器，禁止串台写到顶部 NCB 容器；
   * 由 containerOfOp 统管容器推导，严禁手写 fallback 到 db_action_status。 */
  function paintDbStatus(action, feedbackMsg, feedbackKind, targetOrContainer) {
    var act = action || (current && current._action);
    var target = (act && act.op) || targetOrContainer;
    var containerId = containerOfOp(target);
    var el = $(containerId);
    if (!el) return;
    if (!feedbackMsg && (!act || !act.op)) {
      if (!el.innerHTML) {
        el.style.display = "none";
      }
      return;
    }
    el.style.display = "block";
    el.className = "db-status-box" + (feedbackKind ? " " + feedbackKind : "");

    var html = "";
    if (feedbackMsg) {
      html += '<div class="db-status-title">' + escapeHtml(feedbackMsg) + '</div>';
    }
    if (act && act.op) {
      var opLabels = {
        provision: "一键创建数据库",
        ncb_check: "检测 MCP Key",
        secret_check: "检测 Secret Key",
        storage_setup: "挂载 R2 存储",
        r2_check: "检测 R2 密钥",
        clean_probe: "清理探针文件",
        model_check: "真实检测模型",
        memory_audit: "全自动去重",
        dedup_undo: "还原到指定时间点",
        init: "初始化数据库",
        reset: "清空数据库",
        status: "检查结构状态",
        harvest_gateway: "立即扫描对话录制",
        sync_snapshot: "刷新记忆快照"
      };
      var opName = opLabels[act.op] || act.op;
      var timeStr = act.at ? new Date(act.at).toLocaleString("zh-CN", { hour12: false }) : "未知时间";
      html += '<div class="db-status-detail">';
      html += '当前任务：<strong>' + escapeHtml(opName) + '</strong>（op: <code>' + escapeHtml(act.op) + '</code>，id: <code>' + escapeHtml(act.id) + '</code>）<br>';
      html += '提交时间：' + escapeHtml(timeStr) + '<br>';
      html += '说明：宿主将在下次被调用时读取并执行；已启动结果轮询。若长时间无输出，可让 agent 调用 <code>db_status</code> 查看。';
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function setActionButtonsDisabled(disabled) {
    var ids = [
      "btn_db_provision", "btn_check_ncb", "btn_check_secret", "btn_db_storage_setup", "btn_db_status", "btn_db_reset",
      "btn_confirm_provision", "btn_confirm_reset",
      "btn_check_r2", "btn_clean_probe", "btn_check_model", "btn_memory_audit", "btn_dedup_undo",
      "btn_harvest_gateway", "btn_sync_snapshot"
    ];
    ids.forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = !!disabled;
    });
  }

  /* ---------------- 提交信标 ---------------- */
  function submitAction(op, extra) {
    var targetCard = cardOfOp(op);
    var currentContainerId = containerOfOp(op);

    if (!window.magpie || !window.magpie.options) {
      say("桥接未就绪", "bad");
      paintDbStatus(null, "桥接脚本未加载，无法提交任务", "bad", op);
      return;
    }

    var now = Date.now();
    if (now - lastSubmitTime < 1000) {
      var freqMsg = "操作过于频繁，请稍后再试（频控限制 1 秒/次）";
      say(freqMsg, "warn");
      paintDbStatus(null, freqMsg, "warn", op);
      return;
    }

    lastSubmitTime = now;
    setActionButtonsDisabled(true);
    // 立即向当前点击卡片的状态容器渲染即时等待反馈，消除「点不动/没反应」现象
    paintDbStatus(null, "正在提交信标任务…", "", op);
    say("正在提交…");

    // 全量替换防丢：必须先 get() 获取远端全部 options，再合并写入
    Promise.resolve(window.magpie.options.get()).then(function (remote) {
      if (remote && typeof remote === "object") {
        Object.keys(remote).forEach(function (k) { current[k] = remote[k]; });
      }
      var payload = collect();
      var action = {
        op: op,
        id: op + "-" + Date.now(),
        at: Date.now()
      };
      var db = payload.ncb_instance || ($("ncb_instance") && $("ncb_instance").value.trim());
      if (db) action.database = db;

      if (op === "provision") {
        action.on_exist = ($("on_exist") && $("on_exist").value) || payload.on_exist || "reuse";
        action.with_r2 = false; // 一键创建数据库绝不默认创建 R2 存储（按要求仅在 R2 卡片点挂载时创建）
      } else if (op === "storage_setup") {
        if (payload.r2_bucket_name) action.bucket_name = payload.r2_bucket_name;
        if (payload.r2_public_url) action.public_url = payload.r2_public_url;
        if (payload.r2_account_id) action.account_id = payload.r2_account_id;
        if (payload.r2_access_key_id) action.access_key_id = payload.r2_access_key_id;
        if (payload.r2_secret_access_key) action.secret_access_key = payload.r2_secret_access_key;
      } else if (op === "r2_check") {
        var acc = payload.r2_account_id || ($("r2_account_id") ? $("r2_account_id").value.trim() : "");
        var ak = payload.r2_access_key_id || ($("r2_access_key_id") ? $("r2_access_key_id").value.trim() : "");
        var sk = payload.r2_secret_access_key || ($("r2_secret_access_key") ? $("r2_secret_access_key").value.trim() : "");
        var bkt = payload.r2_bucket_name || ($("r2_bucket_name") ? $("r2_bucket_name").value.trim() : "");
        var pub = payload.r2_public_url || ($("r2_public_url") ? $("r2_public_url").value.trim() : "");
        action.account_id = acc;
        action.access_key_id = ak;
        action.secret_access_key = sk;
        action.bucket_name = bkt;
        action.public_url = pub;
      } else if (op === "secret_check" || op === "clean_probe") {
        var sec = payload.ncb_secret || ($("ncb_secret") ? $("ncb_secret").value.trim() : "");
        if (sec) action.secret = sec;
      } else if (op === "memory_audit") {
        if (extra && extra.undo) action.undo = true;
        if (extra && extra.undo_before) action.undo_before = extra.undo_before;
        if (extra && extra.args) action.args = extra.args;
      }

      if (extra && extra.confirm) action.confirm = extra.confirm;
      payload._action = action;

      return queuedOptionsSet(payload, true).then(
        function (written) {
          setActionButtonsDisabled(false);
          current = written || payload;
          fill(current);
          paintMode(current);
          var msg = "";
          if (op === "provision") {
            msg = "已提交一键创建任务（ID: " + action.id + "）。宿主将在执行后回传结果…";
          } else if (op === "ncb_check") {
            msg = "已提交检测 MCP Key 任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "secret_check") {
            msg = "已提交检测 Secret Key 任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "storage_setup") {
            msg = "已提交挂载 R2 存储任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "r2_check") {
            msg = "已提交检测 R2 密钥任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "clean_probe") {
            msg = "已提交清理探针文件任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "model_check") {
            msg = "已提交真实检测模型任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "memory_audit") {
            msg = action.undo ? ("已提交撤销去重任务（ID: " + action.id + "）。正在等待宿主执行…") : ("已提交全自动去重任务（ID: " + action.id + "）。正在等待宿主执行…");
          } else if (op === "status") {
            msg = "已提交检查状态任务。正在等待宿主执行…";
          } else if (op === "reset") {
            msg = "已提交清空数据库任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "harvest_gateway") {
            msg = "已提交扫描对话录制任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "sync_snapshot") {
            msg = "已提交刷新记忆快照任务（ID: " + action.id + "）。正在等待宿主执行…";
          }
          paintDbStatus(action, msg, "ok", op);
          say("信标已提交", "ok");
          startPollingStatus(targetCard, action.at, op);
        },
        function (e) {
          setActionButtonsDisabled(false);
          var errStr = String((e && (e.message || e)) || "");
          var is429 = (e && e.status === 429) || errStr.indexOf("429") !== -1 || /too many requests/i.test(errStr);
          var msg = is429
            ? "操作过于频繁，请稍后再试（频控限制 1 秒/次）"
            : ("提交失败：" + errStr);
          paintDbStatus(action, msg, is429 ? "warn" : "bad", op);
          say(msg, is429 ? "warn" : "bad");
        }
      );
    }).catch(function (e) {
      setActionButtonsDisabled(false);
      var errStr = String((e && (e.message || e)) || "");
      var is429 = (e && e.status === 429) || errStr.indexOf("429") !== -1 || /too many requests/i.test(errStr);
      var msg = is429
        ? "操作过于频繁，请稍后再试（频控限制 1 秒/次）"
        : ("获取配置失败：" + errStr);
      paintDbStatus(null, msg, is429 ? "warn" : "bad", op);
      say(msg, is429 ? "warn" : "bad");
    });
  }

  /* ---------------- 底部整体保存 ---------------- */
  function save() {
    if (!window.magpie || !window.magpie.options) {
      say("桥接未就绪", "bad");
      return;
    }
    var next = collect();
    var warn = check(next);
    var btn = $("save");
    if (btn) btn.disabled = true;
    say("保存中…");

    queuedOptionsSet(next, true).then(
      function (written) {
        current = written || next;
        fill(current);
        paintMode(current);
        paintDbStatus(current._action);
        if (btn) btn.disabled = false;
        if (warn) say("已保存（" + warn + "）", "warn");
        else {
          var note = "";
          if (!next.ncb_secret) {
            note = "（未填写 Secret Key：R2 的列举/删除需要它，留空时这两项不可用，记忆读写不受影响）";
          }
          say("已保存全部设置" + note, "ok");
        }
      },
      function (e) {
        if (btn) btn.disabled = false;
        say("保存失败：" + (e && e.message ? e.message : e), "bad");
      }
    );
  }

  /* ---------------- 单卡片独立保存 ---------------- */
  function saveCard(cardKey, btnId, statusId) {
    if (!window.magpie || !window.magpie.options) {
      cardSay(statusId, "桥接未就绪", "bad");
      return;
    }
    var btn = $(btnId);
    if (btn) btn.disabled = true;
    cardSay(statusId, "保存中…");

    Promise.resolve(window.magpie.options.get()).then(function (remote) {
      // 先拿到远端全量配置，只覆盖该卡片专属字段，其它卡片与 memories 快照逐字段保留
      var next = Object.assign({}, remote || {});
      delete next._action;
      var fields = CARD_FIELDS[cardKey] || [];
      fields.forEach(function (k) {
        var el = $(k);
        if (!el) {
          if (k === "gatewayTimeoutMs") {
            next[k] = (typeof next[k] === "number" && !isNaN(next[k])) ? next[k] : 8000;
          }
          return;
        }
        if (BOOL.indexOf(k) !== -1) {
          next[k] = el.checked;
        } else if (NUM[k] !== undefined) {
          var v = parseFloat(el.value);
          next[k] = isNaN(v) ? NUM[k] : v;
        } else if (SELECT.indexOf(k) !== -1) {
          next[k] = el.value;
        } else {
          next[k] = el.value.trim();
        }
      });

      if (cardKey === "model") {
        var ch = $("dedup_hour") ? parseInt($("dedup_hour").value, 10) : 2;
        var cm = $("dedup_minute") ? parseInt($("dedup_minute").value, 10) : 0;
        if (isNaN(ch) || ch < 0) ch = 0; if (ch > 23) ch = 23;
        if (isNaN(cm) || cm < 0) cm = 0; if (cm > 59) cm = 59;
        next.dedup_time = (ch < 10 ? "0" + ch : "" + ch) + ":" + (cm < 10 ? "0" + cm : "" + cm);
        if ($("dedup_time")) $("dedup_time").value = next.dedup_time;
        if ($("dedup_schedule")) next.dedup_schedule = $("dedup_schedule").value;
        if ($("dedup_weekday")) next.dedup_weekday = parseInt($("dedup_weekday").value, 10) || 1;
        if ($("dedup_day")) {
          var cd = parseInt($("dedup_day").value, 10);
          next.dedup_day = (isNaN(cd) || cd < 1) ? 1 : Math.min(28, cd);
        }
      }

      return queuedOptionsSet(next, true).then(
        function (written) {
          if (btn) btn.disabled = false;
          current = written || next;
          fill(current);
          paintMode(current);
          var note = "";
          if (cardKey === "ncb" && !next.ncb_secret) {
            note = "（未填写 Secret Key：R2 的列举/删除需要它，留空时这两项不可用，记忆读写不受影响）";
          }
          cardSay(statusId, "已保存本卡片" + note, "ok");
        },
        function (e) {
          if (btn) btn.disabled = false;
          var m = String((e && e.message) || e);
          var is429 = /429|too many requests/i.test(m);
          cardSay(statusId, is429 ? "操作过于频繁，请稍后再试（频控 1 秒/次）" : ("保存失败：" + m), is429 ? "warn" : "bad");
        }
      );
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      cardSay(statusId, "读取配置失败：" + String((e && e.message) || e), "bad");
    });
  }

  /* ---------------- 独立保存 R2 设置（卡片 2） ---------------- */
  function r2Say(msg, kind) {
    cardSay("r2_status", msg, kind);
  }

  function saveR2() {
    if (!window.magpie || !window.magpie.options) {
      r2Say("桥接未就绪", "bad");
      return;
    }
    var btn = $("btn_save_r2");
    if (btn) btn.disabled = true;
    r2Say("保存中…");

    Promise.resolve(window.magpie.options.get()).then(function (remote) {
      var next = Object.assign({}, remote || {});
      var filled = 0, any = 0;
      var R2_FIELDS = CARD_FIELDS.r2;
      R2_FIELDS.forEach(function (k) {
        var el = $(k);
        if (!el) return;
        var v = String(el.value || "").trim();
        next[k] = v;
        any++;
        if (v) filled++;
      });
      return queuedOptionsSet(next, true).then(
        function (written) {
          if (btn) btn.disabled = false;
          current = written || next;
          fill(current);
          paintMode(current);
          if (filled === 0) {
            r2Say("已保存本卡片（凭据留空，挂载时 NCB 将复用已有连接）", "warn");
          } else {
            r2Say("已保存本卡片（已填 " + filled + "/" + any + " 项）", "ok");
          }
        },
        function (e) {
          if (btn) btn.disabled = false;
          var m = String((e && e.message) || e);
          var is429 = /429|too many requests/i.test(m);
          r2Say(is429 ? "操作过于频繁，请稍后再试（频控 1 秒/次）" : ("保存失败：" + m), is429 ? "warn" : "bad");
        }
      );
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      r2Say("读取配置失败：" + String((e && e.message) || e), "bad");
    });
  }

  function copyMcpUrl() {
    var el = $("mcp_url");
    if (!el) return;
    var url = el.value;
    var done = function () { say("已复制", "ok"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () {
        el.select();
        document.execCommand("copy");
        done();
      });
      return;
    }
    el.select();
    document.execCommand("copy");
    done();
  }

  /* ---------------- 弹窗与确认交互 ---------------- */
  function openProvisionModal() {
    var modal = $("modal_provision");
    if (!modal) return;
    modal.style.display = "flex";
  }

  function closeProvisionModal() {
    var modal = $("modal_provision");
    if (!modal) return;
    modal.style.display = "none";
  }

  function openResetModal() {
    var modal = $("modal_reset");
    var targetEl = $("reset_target_name");
    var input = $("reset_instance_input");
    var confirmBtn = $("btn_confirm_reset");
    if (!modal) return;

    var expected = ($("ncb_instance") && $("ncb_instance").value.trim()) || current.ncb_instance || "";
    if (targetEl) targetEl.textContent = expected || "（尚未配置数据库名）";
    if (input) {
      input.value = "";
      input.placeholder = expected || "请先在上方配置数据库名";
    }
    if (confirmBtn) confirmBtn.disabled = true;
    modal.style.display = "flex";
  }

  function closeResetModal() {
    var modal = $("modal_reset");
    if (!modal) return;
    modal.style.display = "none";
  }

  function checkResetMatch() {
    var input = $("reset_instance_input");
    var confirmBtn = $("btn_confirm_reset");
    if (!input || !confirmBtn) return;
    var expected = ($("ncb_instance") && $("ncb_instance").value.trim()) || current.ncb_instance || "";
    var match = !!(expected && input.value.trim() === expected);
    confirmBtn.disabled = !match;
  }

  /* ---------------- 启动与事件绑定 ---------------- */
  function boot() {
    var mcpUrlEl = $("mcp_url");
    if (mcpUrlEl) mcpUrlEl.value = mcpUrl();

    // 底部全局保存
    var saveBtn = $("save");
    if (saveBtn) saveBtn.addEventListener("click", save);

    // MCP 地址复制
    var copyBtn = $("copy");
    if (copyBtn) copyBtn.addEventListener("click", copyMcpUrl);

    // 各卡片独立保存按钮绑定
    var saveCardNcbBtn = $("btn_save_card_ncb");
    if (saveCardNcbBtn) {
      saveCardNcbBtn.addEventListener("click", function () {
        saveCard("ncb", "btn_save_card_ncb", "status_card_ncb");
      });
    }

    var saveR2Btn = $("btn_save_r2");
    if (saveR2Btn) saveR2Btn.addEventListener("click", saveR2);

    var saveCardHarvestBtn = $("btn_save_card_harvest");
    if (saveCardHarvestBtn) {
      saveCardHarvestBtn.addEventListener("click", function () {
        saveCard("harvest", "btn_save_card_harvest", "status_card_harvest");
      });
    }

    var saveCardExtractBtn = $("btn_save_card_extract");
    if (saveCardExtractBtn) {
      saveCardExtractBtn.addEventListener("click", function () {
        saveCard("extract", "btn_save_card_extract", "status_card_extract");
      });
    }

    var saveCardInjectBtn = $("btn_save_card_inject");
    if (saveCardInjectBtn) {
      saveCardInjectBtn.addEventListener("click", function () {
        saveCard("inject", "btn_save_card_inject", "status_card_inject");
      });
    }

    var saveCardModelBtn = $("btn_save_card_model");
    if (saveCardModelBtn) {
      saveCardModelBtn.addEventListener("click", function () {
        saveCard("model", "btn_save_card_model", "status_card_model");
      });
    }

    // MCP Key 切换密码显隐
    var toggleMcpBtn = $("toggle_mcp_key");
    if (toggleMcpBtn) {
      toggleMcpBtn.addEventListener("click", function () {
        var el = $("mcp_key");
        if (!el) return;
        if (el.type === "password") {
          el.type = "text";
          toggleMcpBtn.textContent = "隐藏";
        } else {
          el.type = "password";
          toggleMcpBtn.textContent = "显示";
        }
      });
    }

    // 一键创建数据库
    var provisionBtn = $("btn_db_provision");
    if (provisionBtn) {
      provisionBtn.addEventListener("click", openProvisionModal);
    }

    var cancelProvisionBtn = $("btn_cancel_provision");
    if (cancelProvisionBtn) cancelProvisionBtn.addEventListener("click", closeProvisionModal);

    var confirmProvisionBtn = $("btn_confirm_provision");
    if (confirmProvisionBtn) {
      confirmProvisionBtn.addEventListener("click", function () {
        closeProvisionModal();
        submitAction("provision");
      });
    }

    // 检测 MCP Key
    var checkNcbBtn = $("btn_check_ncb");
    if (checkNcbBtn) {
      checkNcbBtn.addEventListener("click", function () {
        submitAction("ncb_check");
      });
    }

    // 检测 Secret Key
    var checkSecretBtn = $("btn_check_secret");
    if (checkSecretBtn) {
      checkSecretBtn.addEventListener("click", function () {
        submitAction("secret_check");
      });
    }

    // 挂载 R2 存储
    var storageBtn = $("btn_db_storage_setup");
    if (storageBtn) {
      storageBtn.addEventListener("click", function () {
        submitAction("storage_setup");
      });
    }

    // 检测 R2 密钥
    var checkR2Btn = $("btn_check_r2");
    if (checkR2Btn) {
      checkR2Btn.addEventListener("click", function () {
        submitAction("r2_check");
      });
    }

    // 清理探针文件
    var cleanProbeBtn = $("btn_clean_probe");
    if (cleanProbeBtn) {
      cleanProbeBtn.addEventListener("click", function () {
        submitAction("clean_probe");
      });
    }

    // 真实检测模型
    var checkModelBtn = $("btn_check_model");
    if (checkModelBtn) {
      checkModelBtn.addEventListener("click", function () {
        submitAction("model_check");
      });
    }

    // 立即全量去重
    var memoryAuditBtn = $("btn_memory_audit");
    if (memoryAuditBtn) {
      memoryAuditBtn.addEventListener("click", function () {
        submitAction("memory_audit", { args: { full: true } });
      });
    }

    // 还原去重
    var dedupUndoBtn = $("btn_dedup_undo");
    if (dedupUndoBtn) {
      dedupUndoBtn.addEventListener("click", function () {
        var rawTime = $("undo_before_time") ? $("undo_before_time").value.trim() : "";
        var undoTime = "";
        if (rawTime) {
          undoTime = normalizeUndoTime(rawTime);
          if (!undoTime) {
            say("时间点格式无法识别，请使用 YYYY-MM-DD HH:MM 格式（如：2026-10-19 03:00）", "bad");
            if ($("undo_before_time")) $("undo_before_time").focus();
            return;
          }
          if ($("undo_before_time")) $("undo_before_time").value = undoTime;
        }
        submitAction("memory_audit", { undo: true, undo_before: undoTime || undefined });
      });
    }

    // 定时去重表单动态联动与预览
    ["dedup_schedule", "dedup_weekday", "dedup_day", "dedup_hour", "dedup_minute"].forEach(function (id) {
      var el = $(id);
      if (el) {
        el.addEventListener("input", updateDedupUI);
        el.addEventListener("change", updateDedupUI);
      }
    });

    // 立即扫描对话录制
    var harvestGatewayBtn = $("btn_harvest_gateway");
    if (harvestGatewayBtn) {
      harvestGatewayBtn.addEventListener("click", function () {
        submitAction("harvest_gateway");
      });
    }

    // 刷新记忆快照
    var syncSnapshotBtn = $("btn_sync_snapshot");
    if (syncSnapshotBtn) {
      syncSnapshotBtn.addEventListener("click", function () {
        submitAction("sync_snapshot");
      });
    }

    // 检查状态
    var statusBtn = $("btn_db_status");
    if (statusBtn) {
      statusBtn.addEventListener("click", function () {
        submitAction("status");
      });
    }

    // 清空数据库
    var resetBtn = $("btn_db_reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", openResetModal);
    }

    var cancelResetBtn = $("btn_cancel_reset");
    if (cancelResetBtn) cancelResetBtn.addEventListener("click", closeResetModal);

    var resetInput = $("reset_instance_input");
    if (resetInput) {
      resetInput.addEventListener("input", checkResetMatch);
    }

    var confirmResetBtn = $("btn_confirm_reset");
    if (confirmResetBtn) {
      confirmResetBtn.addEventListener("click", function () {
        var input = $("reset_instance_input");
        var expected = ($("ncb_instance") && $("ncb_instance").value.trim()) || current.ncb_instance || "";
        if (!expected || !input || input.value.trim() !== expected) {
          say("输入的数据库名不匹配，无法清空", "bad");
          return;
        }
        closeResetModal();
        submitAction("reset", { confirm: "RESET" });
      });
    }

    // 点击弹窗外部关闭
    var provisionModal = $("modal_provision");
    if (provisionModal) {
      provisionModal.addEventListener("click", function (e) {
        if (e.target === provisionModal) closeProvisionModal();
      });
    }
    var resetModal = $("modal_reset");
    if (resetModal) {
      resetModal.addEventListener("click", function (e) {
        if (e.target === resetModal) closeResetModal();
      });
    }

    ["disabled", "inline_extract", "auto_harvest", "ncb_instance", "mcp_key", "ncb_secret", "min_confidence"].forEach(function (k) {
      var el = $(k);
      if (el) el.addEventListener("change", function () { paintMode(collect()); });
      if (el && (el.type === "text" || el.type === "password" || el.type === "number")) {
        el.addEventListener("input", function () { paintMode(collect()); });
      }
    });

    // 状态回传暴露，供测试与动态调用
    window.loadStatus = loadStatus;
    window.renderStatus = renderAllStatus;
    window.renderAllStatus = renderAllStatus;
    window.renderDbPrefix = renderDbPrefix;
    window.__renderMemhubStatus = renderAllStatus;
    window.fill = fill;
    window.collect = collect;
    window.updateDedupUI = updateDedupUI;

    // 数据库名称输入联动前缀展示
    var ncbInput = $("ncb_instance");
    if (ncbInput) {
      ncbInput.addEventListener("input", function () { renderDbPrefix(); });
    }

    if (!window.magpie || !window.magpie.options) {
      say("桥接脚本未加载", "bad");
      loadStatus();
      return;
    }

    Promise.resolve(window.magpie.ready)
      .then(function () { return window.magpie.options.get(); })
      .then(function (o) {
        current = o || {};
        fill(current);
        paintMode(current);
        paintDbStatus(current._action);
        renderDbPrefix(window.__memhubStatus ? window.__memhubStatus.db : null);
        var warn = check(current);
        if (warn) say(warn, "warn");
        loadStatus();
      })
      .catch(function (e) {
        say("读取配置失败：" + (e && e.message ? e.message : e), "bad");
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
