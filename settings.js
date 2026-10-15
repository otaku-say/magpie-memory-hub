/* settings.js — Magpie Memory Hub Settings v2.0 */

document.addEventListener("DOMContentLoaded", function () {
  loadOptions();
  updateMcpConfig();

  // 监听输入变化实时更新 MCP 配置
  var inputs = ["opt_mcp_path", "opt_ncb_instance"];
  inputs.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("input", updateMcpConfig);
  });

  // 保存按钮
  document.getElementById("btn_save").addEventListener("click", saveAll);

  // 复制按钮
  document.getElementById("btn_copy_config").addEventListener("click", function () {
    var ta = document.getElementById("mcp_config");
    if (ta) {
      navigator.clipboard.writeText(ta.value).then(function () {
        showStatus("save_status", "ok", "✅ MCP 配置已复制到剪贴板");
      });
    }
  });
});

function loadOptions() {
  if (typeof magpie === "undefined" || !magpie.getOptions) return;
  var opts = magpie.getOptions();
  if (!opts) return;

  setVal("opt_ncb_instance", opts.ncb_instance);
  setVal("opt_max_inject", opts.max_inject_count);
  setVal("opt_max_budget", opts.max_budget_chars);
  setVal("opt_extractor_model", opts.extractor_model);
  setVal("opt_mcp_path", opts.mcp_path);

  // 加载数据库统计
  var mems = opts.memories;
  if (Array.isArray(mems)) {
    document.getElementById("stat_memories").textContent = mems.filter(function(m) { return m.status === "active"; }).length;
  }
}

function setVal(id, val) {
  var el = document.getElementById(id);
  if (el && val !== undefined && val !== null && val !== "") el.value = val;
}

function normalizeMcpPath(input) {
  var val = (input || "").trim();
  if (!val) val = "/agent_memory";
  val = val.replace(/^\/+/, "").replace(/\/+$/, "");
  if (val.toLowerCase().endsWith("/mcp")) val = val.slice(0, -4).replace(/\/+$/, "");
  else if (val.toLowerCase() === "mcp") val = "";
  return val ? "/" + val + "/mcp" : "/mcp";
}

function getGatewayHost() {
  // 推断 Magpie 网关域名
  try {
    var loc = window.location.hostname || "";
    if (loc.includes("magpie")) {
      return window.location.origin.replace("-web", "-api").replace("magpie.", "magpie-api.");
    }
  } catch (e) {}
  return "https://magpie-api.example.com";
}

function updateMcpConfig() {
  var host = getGatewayHost();
  var path = normalizeMcpPath(document.getElementById("opt_mcp_path").value);
  var fullUrl = host + path;

  var config = {
    mcpServers: {
      "magpie-memory-hub": {
        url: fullUrl,
        headers: { Authorization: "Bearer $$MAGPIE_API_KEY" },
        note: "Magpie Memory Hub — Long-term Memory MCP Server"
      }
    }
  };
  document.getElementById("mcp_config").value = JSON.stringify(config, null, 2);
}

function saveAll() {
  if (typeof magpie === "undefined" || !magpie.setOptions) {
    showStatus("save_status", "err", "❌ Magpie bridge 未就绪");
    return;
  }
  var opts = {
    ncb_instance: document.getElementById("opt_ncb_instance").value.trim(),
    max_inject_count: parseInt(document.getElementById("opt_max_inject").value) || 5,
    max_budget_chars: parseInt(document.getElementById("opt_max_budget").value) || 2048,
    extractor_model: document.getElementById("opt_extractor_model").value.trim(),
    mcp_path: normalizeMcpPath(document.getElementById("opt_mcp_path").value)
  };
  magpie.setOptions(opts);
  showStatus("save_status", "ok", "✅ 配置已保存");
}

function showStatus(id, type, msg) {
  var el = document.getElementById(id);
  if (!el) return;
  el.className = "status " + type;
  el.textContent = msg;
  setTimeout(function () { el.className = "status"; }, 3000);
}
