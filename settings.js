function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.innerText = msg;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3000);
}

let currentOptions = {};

/**
 * 动态推测并获取当前 Magpie 网关的外部访问域名
 * 优先顺序：
 * 1. 用户自定义配置的 mcp_host
 * 2. 当前窗口所在的 window.location.origin (例如由 magpie-web 自动映射为 magpie-api)
 * 3. 兜底域名
 */
function getEffectiveGatewayHost() {
  const customHost = document.getElementById('opt_mcp_host');
  if (customHost && customHost.value.trim()) {
    let h = customHost.value.trim();
    if (!h.startsWith('http://') && !h.startsWith('https://')) {
      h = 'https://' + h;
    }
    return h.replace(/\/+$/, '');
  }

  try {
    if (window.location && window.location.origin && window.location.origin !== "null") {
      let host = window.location.origin;
      if (host.includes('-web.')) {
        return host.replace('-web.', '-api.');
      }
      return host.replace(/\/+$/, '');
    }
  } catch (e) {}

  return "https://magpie-api.4a8a.com";
}

/**
 * 规范化用户输入的任意 MCP 路径：
 * 无论输入 "test", "/test", "/test/", "/test/mcp", "41694_agent_core_hub"
 * 均自动规范化为开头的 "/"，并严格在结尾追加且仅追加一次 "/mcp"
 */
function normalizeMcpPath(input) {
  let val = (input || "").trim();
  if (!val) {
    val = "/41694_agent_core_hub";
  }
  // 去除首尾空白与斜杠
  val = val.replace(/^\/+/, '').replace(/\/+$/, '');
  // 如果用户已经手动输入了 mcp 结尾，去除它以统一规范
  if (val.toLowerCase().endsWith('/mcp')) {
    val = val.slice(0, -4).replace(/\/+$/, '');
  } else if (val.toLowerCase() === 'mcp') {
    val = '';
  }
  return val ? '/' + val + '/mcp' : '/mcp';
}

function updateMcpBox() {
  const host = getEffectiveGatewayHost();
  const pathInput = document.getElementById('opt_mcp_path');
  const rawPath = pathInput ? pathInput.value : '';
  const mcpPath = normalizeMcpPath(rawPath);

  const fullMcpUrl = host + mcpPath;
  const urlDisplay = document.getElementById('display_mcp_url');
  if (urlDisplay) urlDisplay.innerText = fullMcpUrl;

  const hostInput = document.getElementById('opt_mcp_host');
  if (hostInput && !hostInput.value) {
    hostInput.placeholder = host;
  }

  // 1. 远程 HTTP/SSE MCP 配置（标准 MCP 客户端规范，复用 MAGPIE_API_KEY）
  const remoteMcpConfig = {
    "mcpServers": {
      "magpie-memory-hub": {
        "url": fullMcpUrl,
        "headers": {
          "Authorization": "Bearer $$MAGPIE_API_KEY"
        },
        "note": "Magpie Long-term Memory Hub (Reusing Magpie Gateway API Key)"
      }
    }
  };

  const ta = document.getElementById('mcp_config_display');
  if (ta) {
    ta.value = JSON.stringify(remoteMcpConfig, null, 2);
  }
}


function selectAllText() {
  const ta = document.getElementById('mcp_config_display');
  if (ta) {
    ta.focus();
    ta.select();
    showToast("已全选配置内容，可直接按 Ctrl+C / Cmd+C 复制！");
  }
}

function copyToClipboard(text, successMsg) {
  const ta = document.getElementById('mcp_config_display');
  if (ta) {
    ta.focus();
    ta.select();
  }

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (e) {
    copied = false;
  }

  if (!copied && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg);
    }).catch(() => {
      showToast("已自动为您全选，请按 Ctrl+C / Cmd+C 复制！");
    });
  } else {
    showToast(copied ? successMsg : "已自动为您全选，请按 Ctrl+C / Cmd+C 复制！");
  }
}

function copyMcpJson() {
  const ta = document.getElementById('mcp_config_display');
  const text = ta ? ta.value : '';
  copyToClipboard(text, "✅ 远程 MCP 配置已成功复制到剪贴板！");
}

function copyMcpUrl() {
  const host = getEffectiveGatewayHost();
  const pathInput = document.getElementById('opt_mcp_path');
  const mcpPath = normalizeMcpPath(pathInput ? pathInput.value : '');
  const fullUrl = host + mcpPath;
  copyToClipboard(fullUrl, "✅ 远程端点已复制：" + fullUrl);
}


function copyLocalCommand() {
  const cmd = `python3 /var/minis/workspace/magpie-memory-hub/daemon.py --mcp`;
  copyToClipboard(cmd, "✅ 本地 Stdio 启动命令已复制！");
}

function applyOptionsToUI(opts) {
  currentOptions = opts || {};
  if (opts.disabled !== undefined) {
    const el = document.getElementById('opt_auto_inject');
    if (el) el.checked = !opts.disabled;
  }
  if (opts.inject_pitfalls !== undefined) {
    const el = document.getElementById('opt_inject_pitfalls');
    if (el) el.checked = !!opts.inject_pitfalls;
  }
  if (opts.auto_supersede !== undefined) {
    const el = document.getElementById('opt_auto_supersede');
    if (el) el.checked = !!opts.auto_supersede;
  }
  if (opts.max_inject_count) {
    const el = document.getElementById('opt_max_inject_count');
    if (el) el.value = String(opts.max_inject_count);
  }
  if (opts.max_budget_chars) {
    const el = document.getElementById('opt_max_budget_chars');
    if (el) el.value = String(opts.max_budget_chars);
  }
  if (opts.extractor_model) {
    const el = document.getElementById('opt_extractor_model');
    if (el) el.value = opts.extractor_model;
  }
  if (opts.clef_model) {
    const el = document.getElementById('opt_clef_model');
    if (el) el.value = opts.clef_model;
  }
  if (opts.min_confidence) {
    const el = document.getElementById('opt_min_confidence');
    if (el) el.value = String(opts.min_confidence);
  }
  if (opts.mcp_host) {
    const el = document.getElementById('opt_mcp_host');
    if (el) el.value = opts.mcp_host;
  }
  if (opts.mcp_path) {
    const el = document.getElementById('opt_mcp_path');
    if (el) el.value = opts.mcp_path;
  }
  if (opts.ncb_instance) {
    const el = document.getElementById('opt_ncb_instance');
    if (el) el.value = opts.ncb_instance;
  }
  if (opts.ncb_secret) {
    const el = document.getElementById('opt_ncb_secret');
    if (el) el.value = opts.ncb_secret;
  }
  if (opts.r2_domain) {
    const el = document.getElementById('opt_r2_domain');
    if (el) el.value = opts.r2_domain;
  }
  updateMcpBox();
}

async function saveAllOptions() {
  const newOpts = {
    ...currentOptions,
    disabled: !document.getElementById('opt_auto_inject').checked,
    inject_pitfalls: document.getElementById('opt_inject_pitfalls').checked,
    auto_supersede: document.getElementById('opt_auto_supersede').checked,
    max_inject_count: parseInt(document.getElementById('opt_max_inject_count').value, 10),
    max_budget_chars: parseInt(document.getElementById('opt_max_budget_chars').value, 10),
    extractor_model: document.getElementById('opt_extractor_model').value.trim(),
    clef_model: document.getElementById('opt_clef_model').value.trim(),
    min_confidence: parseFloat(document.getElementById('opt_min_confidence').value),
    mcp_host: document.getElementById('opt_mcp_host').value.trim(),
    mcp_path: normalizeMcpPath(document.getElementById('opt_mcp_path').value),
    ncb_instance: document.getElementById('opt_ncb_instance').value.trim(),
    ncb_secret: document.getElementById('opt_ncb_secret').value.trim(),
    r2_domain: document.getElementById('opt_r2_domain').value.trim()
  };

  try {
    if (window.magpie && window.magpie.options && window.magpie.options.set) {
      await window.magpie.options.set(newOpts);
    } else {
      window.parent.postMessage({ magpie: 1, id: Date.now(), method: "options.set", params: { options: newOpts } }, "*");
    }
    showToast("✅ 全部配置已保存，网关中间件已热重载！");
  } catch (err) {
    showToast("保存失败: " + err.message);
  }
}

async function initPage() {
  updateMcpBox();
  try {
    if (window.magpie && window.magpie.ready) {
      await window.magpie.ready;
      const opts = await window.magpie.options.get();
      applyOptionsToUI(opts);
    } else {
      window.parent.postMessage({ magpie: 1, id: 1, method: "hello" }, "*");
      window.parent.postMessage({ magpie: 1, id: 2, method: "options.get" }, "*");
    }
  } catch (e) {
    console.warn("Init fallback:", e);
  }
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (!m || m.magpie !== 1) return;
  if (m.result && m.result.options) {
    applyOptionsToUI(m.result.options);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const btnSave = document.getElementById('btn_save_all');
  if (btnSave) btnSave.addEventListener('click', saveAllOptions);

  const btnCopyJson = document.getElementById('btn_copy_json');
  if (btnCopyJson) btnCopyJson.addEventListener('click', copyMcpJson);

  const btnCopyUrl = document.getElementById('btn_copy_url');
  if (btnCopyUrl) btnCopyUrl.addEventListener('click', copyMcpUrl);

  const btnCopyLocal = document.getElementById('btn_copy_local_cmd');
  if (btnCopyLocal) btnCopyLocal.addEventListener('click', copyLocalCommand);

  const btnSelectAll = document.getElementById('btn_select_all');
  if (btnSelectAll) btnSelectAll.addEventListener('click', selectAllText);

  const hostInput = document.getElementById('opt_mcp_host');
  const pathInput = document.getElementById('opt_mcp_path');
  const instInput = document.getElementById('opt_ncb_instance');
  const secInput = document.getElementById('opt_ncb_secret');

  if (hostInput) hostInput.addEventListener('input', updateMcpBox);
  if (pathInput) pathInput.addEventListener('input', updateMcpBox);
  if (instInput) instInput.addEventListener('input', updateMcpBox);
  if (secInput) secInput.addEventListener('input', updateMcpBox);

  updateMcpBox();
  initPage();
});
