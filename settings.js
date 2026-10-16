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
    ncb: ["ncb_instance", "mcp_key", "ncb_secret", "on_exist"],
    r2: ["r2_account_id", "r2_access_key_id", "r2_secret_access_key", "r2_bucket_name", "r2_public_url"],
    extract: ["inline_extract", "clef_mode", "extractor_model", "clef_model", "min_confidence"],
    inject: ["inject_principles", "ccr_cards", "max_inject_count", "max_budget_chars", "max_principles"],
    compress: ["compress", "cross_turn_dedup", "compress_engine", "compress_max_chars", "compress_min_chars"],
    gateway: ["magpie_base_url", "magpie_api_key", "auto_init", "disabled"]
  };

  var TEXT = [
    "ncb_instance", "ncb_secret", "magpie_base_url", "magpie_api_key",
    "extractor_model", "clef_model", "mcp_key",
    "r2_account_id", "r2_access_key_id", "r2_secret_access_key",
    "r2_bucket_name", "r2_public_url"
  ];
  var SELECT = ["clef_mode", "compress_engine", "on_exist"];
  var NUM = { min_confidence: 0.6, max_inject_count: 5, max_budget_chars: 2048,
              compress_max_chars: 3000, compress_min_chars: 1200, max_principles: 2 };
  var BOOL = ["inline_extract", "disabled", "compress", "cross_turn_dedup", "ccr_cards", "inject_principles", "auto_init"];

  var current = {};
  var lastSubmitTime = 0;

  var INIT_SQL =
"-- 1. 创建 memories 表\n" +
"CREATE TABLE IF NOT EXISTS memories (\n" +
"  id INT AUTO_INCREMENT PRIMARY KEY,\n" +
"  project VARCHAR(128) NULL DEFAULT 'global',\n" +
"  category VARCHAR(64) NULL DEFAULT 'fact',\n" +
"  scope VARCHAR(32) NULL DEFAULT 'project',\n" +
"  title VARCHAR(512) NOT NULL,\n" +
"  content TEXT NOT NULL,\n" +
"  tags VARCHAR(512) NULL DEFAULT '',\n" +
"  entities VARCHAR(512) NULL DEFAULT '',\n" +
"  related VARCHAR(512) NULL DEFAULT '',\n" +
"  source VARCHAR(64) NULL DEFAULT '',\n" +
"  fingerprint VARCHAR(64) NOT NULL,\n" +
"  confidence_score INT NULL DEFAULT 100,\n" +
"  status VARCHAR(16) NULL DEFAULT 'active',\n" +
"  superseded_by INT NULL DEFAULT 0,\n" +
"  version INT NULL DEFAULT 1,\n" +
"  hits INT NULL DEFAULT 0,\n" +
"  access_count INT NULL DEFAULT 1,\n" +
"  invalid_at DATETIME,\n" +
"  last_accessed_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,\n" +
"  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,\n" +
"  updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP\n" +
");\n\n" +
"-- 2. 创建 memories 索引\n" +
"CREATE UNIQUE INDEX idx_memories_uniq_fp ON memories (project, fingerprint);\n" +
"CREATE INDEX idx_memories_scope ON memories (project, status);\n\n" +
"-- 3. 创建 pitfalls 表\n" +
"CREATE TABLE IF NOT EXISTS pitfalls (\n" +
"  id INT AUTO_INCREMENT PRIMARY KEY,\n" +
"  project VARCHAR(128) NULL DEFAULT 'global',\n" +
"  component VARCHAR(128) NOT NULL,\n" +
"  symptom TEXT NOT NULL,\n" +
"  root_cause TEXT NOT NULL,\n" +
"  solution TEXT NOT NULL,\n" +
"  severity VARCHAR(16) NULL DEFAULT 'medium',\n" +
"  error_type VARCHAR(64) NULL DEFAULT '',\n" +
"  tags VARCHAR(512) NULL DEFAULT '',\n" +
"  fingerprint VARCHAR(64) NOT NULL,\n" +
"  recurrence INT NULL DEFAULT 1,\n" +
"  invalid_at DATETIME,\n" +
"  last_occurred_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,\n" +
"  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,\n" +
"  updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP\n" +
");\n\n" +
"-- 4. 创建 pitfalls 索引\n" +
"CREATE UNIQUE INDEX idx_pitfalls_uniq_fp ON pitfalls (project, fingerprint);\n\n" +
"-- 5. 创建 memhub_meta 元数据表\n" +
"CREATE TABLE IF NOT EXISTS memhub_meta (\n" +
"  id INT AUTO_INCREMENT PRIMARY KEY,\n" +
"  k VARCHAR(64) NOT NULL,\n" +
"  v TEXT,\n" +
"  updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP\n" +
");\n\n" +
"-- 6. 创建 memhub_meta 索引\n" +
"CREATE UNIQUE INDEX idx_memhub_meta_k ON memhub_meta (k);\n\n" +
"-- 7. 写入初始结构版本\n" +
"INSERT INTO memhub_meta (k, v) VALUES ('schema_version', '1') ON DUPLICATE KEY UPDATE v = '1';";

  var RESET_SQL =
"-- 清空并删除插件三张表（表结构与全部数据一并删除，不可恢复）\n" +
"DROP TABLE IF EXISTS memhub_meta;\n" +
"DROP TABLE IF EXISTS pitfalls;\n" +
"DROP TABLE IF EXISTS memories;";

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
        return "⚠️ 未完成配置：请填写 MCP Key 与数据库名称，然后点击「一键创建数据库」";
      }
      if (!db) {
        return "⚠️ 未完成配置：请填写数据库名称，然后点击「一键创建数据库」";
      }
      return "⚠️ 未完成配置：请填写 MCP Key，然后点击「一键创建数据库」";
    }

    var noLlm = o.inline_extract !== false && !String(o.extractor_model || "").trim();
    var parts = [];
    parts.push(noLlm
      ? "✅ 零外部模型：提炼由正在跑的那个模型顺手完成"
      : "ℹ️ 外部提炼模型：" + (String(o.extractor_model || "").trim() || "（未填）"));
    parts.push(o.clef_mode === "llm" ? "clef 模型仲裁" : "规则仲裁");
    if (o.compress === false) parts.push("请求压缩已关");
    else parts.push("请求压缩开");
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
    var noLlm = o.inline_extract !== false && !String(o.extractor_model || "").trim();
    var textEl = $("mode_text");
    if (textEl) {
      textEl.textContent = describeMode(o);
    } else {
      el.textContent = describeMode(o);
    }
    el.className = "mode" + (notConfigured ? " warn" : (noLlm ? " ok" : ""));
  }

  function check(o) {
    if (!o.ncb_instance) return "数据库名称为空，记忆将无法存取";
    if (!o.ncb_secret && !o.mcp_key) return "未填 Secret Key 或 MCP Key：新建库请填写 MCP Key";
    if (!o.magpie_base_url && o.extractor_model) return "填了提炼模型，但没填 Magpie 地址";
    if (o.magpie_base_url && !o.extractor_model && !o.clef_model)
      return "未填任何模型 ID，memory_extract 将不可用";
    if (o.compress && o.compress_min_chars >= o.compress_max_chars)
      return "压缩阈值不合理：『小于此长度不动』应小于『单块压缩后上限』";
    return "";
  }

  /* ---------------- 数据库管理状态区 ---------------- */
  function paintDbStatus(action, feedbackMsg, feedbackKind) {
    var el = $("db_action_status");
    if (!el) return;
    var act = action || (current && current._action);
    if (!feedbackMsg && (!act || !act.op)) {
      el.style.display = "none";
      el.innerHTML = "";
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
        storage_setup: "挂载 R2 存储",
        init: "初始化数据库",
        reset: "清空数据库",
        status: "检查结构状态"
      };
      var opName = opLabels[act.op] || act.op;
      var timeStr = act.at ? new Date(act.at).toLocaleString("zh-CN", { hour12: false }) : "未知时间";
      html += '<div class="db-status-detail">';
      html += '当前任务：<strong>' + escapeHtml(opName) + '</strong>（op: <code>' + escapeHtml(act.op) + '</code>，id: <code>' + escapeHtml(act.id) + '</code>）<br>';
      html += '提交时间：' + escapeHtml(timeStr) + '<br>';
      html += '说明：宿主将在下次被调用时读取并执行；由于沙箱限制，执行结果无法在本页直接读回，请让 agent 调用 <code>db_provision</code> / <code>db_status</code> 查看最新状态。';
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function setActionButtonsDisabled(disabled) {
    var ids = [
      "btn_db_provision", "btn_db_storage_setup", "btn_db_status", "btn_db_reset",
      "btn_confirm_provision", "btn_confirm_reset"
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
            msg = "已提交一键创建任务（ID: " + action.id + "）。宿主将在下次被调用时自动执行建库建表与存储挂载；结果请让 agent 调用 db_provision / db_status 查看。";
          } else if (op === "storage_setup") {
            msg = "已提交挂载 R2 存储任务（ID: " + action.id + "）。宿主将在下次被调用时执行；结果请让 agent 调用 db_status 查看。";
          } else if (op === "status") {
            msg = "已提交检查状态任务。宿主将在下次被调用时执行，结果请让 agent 调用 db_status 工具查看。";
          } else if (op === "reset") {
            msg = "已提交清空数据库任务（ID: " + action.id + "）。宿主将在下次被调用时执行；由于沙箱限制，结果无法在本页直接读回。";
          }
          paintDbStatus(action, msg, "ok");
          say("信标已提交", "ok");
        },
        function (e) {
          setActionButtonsDisabled(false);
          var errStr = String((e && (e.message || e)) || "");
          var is429 = (e && e.status === 429) || errStr.indexOf("429") !== -1 || /too many requests/i.test(errStr);
          var msg = is429
            ? "操作过于频繁，请稍后再试（频控限制 1 秒/次）"
            : ("提交失败：" + errStr);
          paintDbStatus(action, msg, is429 ? "warn" : "bad");
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
            r2Say("已保存，但 R2 凭据全为空 —— 挂载时 NCB 会用它账号里缓存的连接", "warn");
          } else {
            r2Say("已保存 " + filled + "/" + any + " 个 R2 字段；现在可以去点「挂载 R2 存储」", "ok");
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

  function copySql(text, title) {
    var showFallback = function () {
      var wrap = $("sql_fallback_wrap");
      var area = $("sql_fallback_text");
      var tEl = $("sql_fallback_title");
      if (wrap && area) {
        if (tEl) tEl.textContent = title || "SQL 语句";
        area.value = text;
        wrap.style.display = "block";
        area.focus();
        area.select();
        say("剪贴板不可用，已在下方展开 SQL，请手动复制", "warn");
      }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { say("已复制 " + (title || "SQL") + " 到剪贴板", "ok"); },
        function () { showFallback(); }
      );
    } else {
      showFallback();
    }
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

    var saveCardGatewayBtn = $("btn_save_card_gateway");
    if (saveCardGatewayBtn) {
      saveCardGatewayBtn.addEventListener("click", function () {
        saveCard("gateway", "btn_save_card_gateway", "status_card_gateway");
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

    // 挂载 R2 存储
    var storageBtn = $("btn_db_storage_setup");
    if (storageBtn) {
      storageBtn.addEventListener("click", function () {
        submitAction("storage_setup");
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

    // 复制 SQL
    var copyInitSqlBtn = $("btn_copy_init_sql");
    if (copyInitSqlBtn) {
      copyInitSqlBtn.addEventListener("click", function () {
        copySql(INIT_SQL, "初始化 SQL");
      });
    }

    var copyResetSqlBtn = $("btn_copy_reset_sql");
    if (copyResetSqlBtn) {
      copyResetSqlBtn.addEventListener("click", function () {
        copySql(RESET_SQL, "清库 SQL");
      });
    }

    var closeSqlBtn = $("btn_close_sql");
    if (closeSqlBtn) {
      closeSqlBtn.addEventListener("click", function () {
        var wrap = $("sql_fallback_wrap");
        if (wrap) wrap.style.display = "none";
      });
    }

    ["extractor_model", "clef_mode", "compress", "disabled", "inline_extract", "ncb_instance", "mcp_key", "ncb_secret"].forEach(function (k) {
      var el = $(k);
      if (el) el.addEventListener("change", function () { paintMode(collect()); });
      if (el && (el.type === "text" || el.type === "password")) el.addEventListener("input", function () { paintMode(collect()); });
    });

    if (!window.magpie || !window.magpie.options) {
      say("桥接脚本未加载", "bad");
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
