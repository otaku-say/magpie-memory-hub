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
    extract: ["inline_extract", "min_confidence"],
    inject: ["inject_principles", "ccr_cards", "max_inject_count", "max_budget_chars", "max_principles", "disabled"],
    compress: ["compress", "cross_turn_dedup", "compress_max_chars", "compress_min_chars"]
  };

  var TEXT = [
    "ncb_instance", "ncb_secret", "mcp_key",
    "r2_account_id", "r2_access_key_id", "r2_secret_access_key",
    "r2_bucket_name", "r2_public_url"
  ];
  var SELECT = ["on_exist"];
  var NUM = {
    min_confidence: 0.6,
    max_inject_count: 5,
    max_budget_chars: 2048,
    compress_max_chars: 3000,
    compress_min_chars: 1200,
    max_principles: 2
  };
  var BOOL = [
    "auto_init",
    "inline_extract",
    "disabled",
    "compress",
    "cross_turn_dedup",
    "ccr_cards",
    "inject_principles"
  ];

  var current = {};
  var lastSubmitTime = 0;
  var pollingTimer = null;
  var countdownTimer = null;

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

  /* ---------------- 表单填充与收集 ---------------- */
  function fill(o) {
    o = o || {};
    TEXT.forEach(function (k) {
      var el = $(k); if (!el) return;
      el.value = o[k] == null ? "" : String(o[k]);
    });
    Object.keys(NUM).forEach(function (k) {
      var el = $(k); if (!el) return;
      var v = parseFloat(o[k]);
      el.value = isNaN(v) ? NUM[k] : v;
    });
    BOOL.forEach(function (k) {
      var el = $(k); if (!el) return;
      el.checked = !!o[k];
    });
    SELECT.forEach(function (k) {
      var el = $(k); if (!el) return;
      if (k === "on_exist" && !o[k]) {
        el.value = "reuse";
        return;
      }
      if (typeof o[k] === "string") el.value = o[k];
    });
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
    if (o.compress === false) {
      parts.push("请求压缩关");
    } else {
      parts.push("请求压缩开");
    }
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
    if (o.compress && o.compress_min_chars >= o.compress_max_chars)
      return "压缩阈值不合理：『小于此长度不动』应小于『单块压缩后上限』";
    return "";
  }

  /* 卡片 key → 状态容器 id。多处共用，提成常量避免各写一份写歪。 */
  var containerMap = {
    ncb: "db_action_status",
    r2: "r2_action_status",
    model: "model_action_status"
  };

  /* ---------------- 状态展示与结果回传渲染 ---------------- */
  function updateModelButtonState(statusObj) {
    var btn = $("btn_download_model");
    if (!btn) return;
    if (!statusObj) {
      btn.textContent = "一键下载模型";
      btn.disabled = false;
      btn.style.display = "";
      return;
    }
    var prog = statusObj.progress;
    var isDownloading = prog && (prog.status === "downloading" || prog.status === "verifying" || prog.status === "starting");
    if (isDownloading) {
      btn.textContent = "正在下载…";
      btn.disabled = true;
      btn.style.display = "";
      return;
    }
    var isUpdate = statusObj.verdict === "UPDATE_AVAILABLE" ||
      (statusObj.title && (statusObj.title.indexOf("新版本") !== -1 || statusObj.title.indexOf("更新") !== -1));
    if (isUpdate) {
      btn.textContent = "更新模型";
      btn.disabled = false;
      btn.style.display = "";
      return;
    }
    if (statusObj.ok === true) {
      btn.textContent = "模型已就绪";
      btn.disabled = true;
      btn.style.display = "";
      return;
    }
    // 未安装或损坏
    btn.textContent = "一键下载模型";
    btn.disabled = false;
    btn.style.display = "";
  }

  function renderStatusBlock(containerId, statusObj) {
    var el = $(containerId);
    if (!el) return;
    if (!statusObj || !statusObj.title) return;

    if (containerId === "model_action_status") {
      updateModelButtonState(statusObj);
    }

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

    if (statusObj.progress && typeof statusObj.progress.percent === "number") {
      var pct = Math.min(100, Math.max(0, statusObj.progress.percent));
      var fName = statusObj.progress.file || "下载中";
      var statTxt = statusObj.progress.status === "verifying" ? "正在校验 SHA-256…" : (pct + "%");
      html += '<div class="model-progress-box">' +
        '<div class="model-progress-bar"><div class="model-progress-fill" style="width:' + pct + '%;"></div></div>' +
        '<div class="model-progress-meta"><span>' + escapeHtml(fName) + '</span><span class="model-progress-pct">' + escapeHtml(statTxt) + '</span></div>' +
      '</div>';
    }

    if (Array.isArray(statusObj.lines) && statusObj.lines.length > 0) {
      html += '<ul class="action-status-lines">';
      statusObj.lines.forEach(function (line) {
        html += "<li>" + escapeHtml(line) + "</li>";
      });
      html += "</ul>";
    }

    el.innerHTML = html;
  }

  function renderAllStatus(statusData) {
    statusData = statusData || window.__memhubStatus;
    if (!statusData || typeof statusData !== "object") return;
    if (statusData.ncb) renderStatusBlock("db_action_status", statusData.ncb);
    if (statusData.r2) renderStatusBlock("r2_action_status", statusData.r2);
    if (statusData.model) renderStatusBlock("model_action_status", statusData.model);
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

  function waitingHtml(cardKey, left, totalWait) {
    var total = totalWait || WAIT_SECONDS;
    var pct = Math.max(0, Math.min(100, Math.round((total - left) / total * 100)));
    var isDownload = cardKey === "model" && total > WAIT_SECONDS;
    return '' +
      '<div class="action-status-header">' +
        '<span class="action-status-badge wait">⏳ ' + (isDownload ? "下载中" : "等待中") + '</span>' +
        '<strong class="action-status-title">' + (isDownload ? "正在进行后台下载与校验…" : "正在等待宿主执行…") + '</strong>' +
        '<span class="action-status-time">剩余 ' + left + ' 秒</span>' +
      '</div>' +
      '<div class="wait-bar"><i style="width:' + pct + '%"></i></div>' +
      '<ul class="action-status-lines">' +
        (isDownload
          ? '<li>模型约 174MB，支持断点续传与 SHA-256 校验。</li><li>请耐心等待进度回传，完成后将自动刷新。</li>'
          : '<li>页面只能提交任务，真正执行发生在宿主的下一次调用。</li><li>拿到结果会自动显示，无需手动刷新。</li>') +
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
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

    var waitSec = (opHint === "model_download" || targetCard === "model") ? 600 : WAIT_SECONDS;
    var containerId = containerMap[targetCard] || "db_action_status";
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
      box.innerHTML = waitingHtml(targetCard, left, waitSec);
    }
    if (el) { el.style.display = "block"; el.className = "action-status-box waiting"; }
    tick();
    countdownTimer = setInterval(tick, 1000);

    pollingTimer = setInterval(function () {
      loadStatus(function (err, statusData) {
        statusData = statusData || window.__memhubStatus;
        var card = statusData && statusData[targetCard];
        if (card && card.at >= submitTime) {
          renderStatusBlock(containerId, card);
          var prog = card.progress;
          var inProgress = prog && (prog.status === "downloading" || prog.status === "verifying" || prog.status === "starting");
          if (inProgress && card.ok) {
            // 仍在下载中，保持轮询更新进度
            return;
          }
          // 拿到比提交时间更新且已完成的结果 → 停止一切计时
          clearInterval(pollingTimer); pollingTimer = null;
          if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(pollingTimer); pollingTimer = null;
          if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
          var box = $(containerId);
          if (box) {
            box.style.display = "block";
            box.className = "action-status-box warn";
            box.innerHTML = timeoutHtml(targetCard, waitSec);
            bindRetry(box, targetCard);
          }
        }
      });
    }, 2000);
  }

  /** 给「重新查询」按钮绑定一次性重试。 */
  function bindRetry(box, cardKey) {
    var btns = box.querySelectorAll ? box.querySelectorAll("[data-retry]") : [];
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var containerId = containerMap[cardKey] || "db_action_status";
        var b = $(containerId);
        if (b) { b.className = "action-status-box waiting"; b.textContent = "正在重新查询…"; }
        loadStatus(function (e, data) {
          data = data || window.__memhubStatus;
          var card = data && data[cardKey];
          var b2 = $(containerId);
          if (card && b2) { renderStatusBlock(containerId, card); }
          else if (b2) {
            b2.className = "action-status-box warn";
            b2.innerHTML = timeoutHtml(cardKey);
            bindRetry(b2, cardKey);
          }
        });
      });
    }
  }

  /* ---------------- 数据库管理即时状态区 ---------------- */
  /* 把即时反馈画到「该操作所属的那张卡片」。
   * 早先这里硬编码 db_action_status，于是点「检测 R2 密钥」「检测本地小模型」
   * 的提示都画到了 NoCodeBackend 卡片里 —— 用户在自己点的那张卡片上什么都看不到。
   * containerId 省略时保持原行为（写 NoCodeBackend 卡片）。 */
  function paintDbStatus(action, feedbackMsg, feedbackKind, containerId) {
    var el = $(containerId || "db_action_status");
    if (!el) return;
    var act = action || (current && current._action);
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
        storage_setup: "挂载 R2 存储",
        r2_check: "检测 R2 密钥",
        model_check: "检测本地小模型",
        model_download: "下载本地小模型",
        init: "初始化数据库",
        reset: "清空数据库",
        status: "检查结构状态"
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
      "btn_db_provision", "btn_check_ncb", "btn_db_storage_setup", "btn_db_status", "btn_db_reset",
      "btn_confirm_provision", "btn_confirm_reset",
      "btn_check_r2", "btn_check_model", "btn_download_model"
    ];
    ids.forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = !!disabled;
    });
  }

  /* ---------------- 提交信标 ---------------- */
  function submitAction(op, extra) {
    if (!window.magpie || !window.magpie.options) {
      say("桥接未就绪", "bad");
      paintDbStatus(null, "桥接脚本未加载，无法提交任务", "bad");
      return;
    }

    var now = Date.now();
    if (now - lastSubmitTime < 1000) {
      var freqMsg = "操作过于频繁，请稍后再试（频控限制 1 秒/次）";
      say(freqMsg, "warn");
      paintDbStatus(null, freqMsg, "warn");
      return;
    }

    lastSubmitTime = now;
    setActionButtonsDisabled(true);
    paintDbStatus(null, "正在提交信标任务…", "");
    say("正在提交…");

    var targetCard = "ncb";
    if (op === "storage_setup" || op === "r2_check") {
      targetCard = "r2";
    } else if (op === "model_check" || op === "model_download") {
      targetCard = "model";
    }

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
        if (payload.r2_bucket_name) action.bucket_name = payload.r2_bucket_name;
        if (payload.r2_public_url) action.public_url = payload.r2_public_url;
        if (payload.r2_account_id) action.account_id = payload.r2_account_id;
        if (payload.r2_access_key_id) action.access_key_id = payload.r2_access_key_id;
        if (payload.r2_secret_access_key) action.secret_access_key = payload.r2_secret_access_key;
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
      }

      if (extra && extra.confirm) action.confirm = extra.confirm;
      payload._action = action;

      return window.magpie.options.set(payload).then(
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
          } else if (op === "storage_setup") {
            msg = "已提交挂载 R2 存储任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "r2_check") {
            msg = "已提交检测 R2 密钥任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "model_check") {
            msg = "已提交检测本地小模型任务（ID: " + action.id + "）。正在等待宿主执行…";
          } else if (op === "model_download") {
            msg = "已提交一键下载模型任务（ID: " + action.id + "）。正在启动后台下载…";
          } else if (op === "status") {
            msg = "已提交检查状态任务。正在等待宿主执行…";
          } else if (op === "reset") {
            msg = "已提交清空数据库任务（ID: " + action.id + "）。正在等待宿主执行…";
          }
          paintDbStatus(action, msg, "ok", containerMap[targetCard]);
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
          paintDbStatus(action, msg, is429 ? "warn" : "bad", containerMap[targetCard]);
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
      paintDbStatus(null, msg, is429 ? "warn" : "bad");
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

    window.magpie.options.set(next).then(
      function (written) {
        current = written || next;
        fill(current);
        paintMode(current);
        paintDbStatus(current._action);
        if (btn) btn.disabled = false;
        if (warn) say("已保存（" + warn + "）", "warn");
        else say("已保存全部设置", "ok");
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
      var fields = CARD_FIELDS[cardKey] || [];
      fields.forEach(function (k) {
        var el = $(k);
        if (!el) return;
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

      return window.magpie.options.set(next).then(
        function (written) {
          if (btn) btn.disabled = false;
          current = written || next;
          fill(current);
          paintMode(current);
          cardSay(statusId, "已保存本卡片", "ok");
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
      return window.magpie.options.set(next).then(
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

    var saveCardCompressBtn = $("btn_save_card_compress");
    if (saveCardCompressBtn) {
      saveCardCompressBtn.addEventListener("click", function () {
        saveCard("compress", "btn_save_card_compress", "status_card_compress");
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

    // 检测本地小模型
    var checkModelBtn = $("btn_check_model");
    if (checkModelBtn) {
      checkModelBtn.addEventListener("click", function () {
        submitAction("model_check");
      });
    }

    // 一键下载/更新本地小模型
    var downloadModelBtn = $("btn_download_model");
    if (downloadModelBtn) {
      downloadModelBtn.addEventListener("click", function () {
        submitAction("model_download");
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

    ["compress", "disabled", "inline_extract", "ncb_instance", "mcp_key", "ncb_secret", "min_confidence"].forEach(function (k) {
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
    window.__renderMemhubStatus = renderAllStatus;

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
