function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.innerText = msg;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3000);
}

let currentOptions = {};

function updateMcpBox() {
  const instEl = document.getElementById('opt_ncb_instance');
  const secEl = document.getElementById('opt_ncb_secret');
  const instance = (instEl && instEl.value) ? instEl.value : '41694_agent_core_hub';
  const secret = (secEl && secEl.value) ? secEl.value : 'sk_live_qcmki2ntz9epoz9r91';

  const mcpConfig = {
    "mcpServers": {
      "magpie-memory-hub": {
        "command": "python3",
        "args": ["/var/minis/workspace/magpie-memory-hub/daemon.py", "--mcp"],
        "env": {
          "NCB_INSTANCE": instance,
          "NCB_SECRET_KEY": secret
        }
      }
    }
  };

  const ta = document.getElementById('mcp_config_display');
  if (ta) {
    ta.value = JSON.stringify(mcpConfig, null, 2);
  }
  const maskEl = document.getElementById('display_secret_masked');
  if (maskEl) {
    maskEl.innerText = secret.slice(0, 10) + '...';
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
  copyToClipboard(text, "✅ MCP 配置 JSON 已成功复制到剪贴板！");
}

function copyMcpCommand() {
  const cmd = "python3 /var/minis/workspace/magpie-memory-hub/daemon.py --mcp";
  copyToClipboard(cmd, "✅ 启动命令已复制：python3 daemon.py --mcp");
}

function populateModelSuggestions(modelList) {
  if (!Array.isArray(modelList) || !modelList.length) return;
  const dl = document.getElementById('suggested_models');
  if (!dl) return;

  const existing = new Set(Array.from(dl.options).map(o => o.value));
  for (const m of modelList) {
    const val = typeof m === 'string' ? m : (m.id || m.model || m.name);
    if (val && !existing.has(val)) {
      const opt = document.createElement('option');
      opt.value = val;
      dl.appendChild(opt);
      existing.add(val);
    }
  }
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
  if (opts.ncb_instance) {
    const el = document.getElementById('opt_ncb_instance');
    if (el) el.value = opts.ncb_instance;
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
    extractor_model: document.getElementById('opt_extractor_model').value.trim() || "deepseek-chat",
    clef_model: document.getElementById('opt_clef_model').value.trim() || "clef",
    min_confidence: parseFloat(document.getElementById('opt_min_confidence').value),
    ncb_instance: document.getElementById('opt_ncb_instance').value.trim(),
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
      // 1. 读取插件选项
      const opts = await window.magpie.options.get();
      applyOptionsToUI(opts);

      // 2. 动态读取 Magpie 网关已配置的可用模型列表
      try {
        const usageData = await window.magpie.read("usage:summary", {});
        if (usageData && usageData.Models) {
          populateModelSuggestions(usageData.Models);
        }
      } catch (e) {
        // Usage summary read optional
      }

      try {
        const provData = await window.magpie.read("providers:list", {});
        if (Array.isArray(provData)) {
          populateModelSuggestions(provData);
        }
      } catch (e) {
        // Provider list read optional
      }
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

// 绑定 DOM 事件监听（纯外部监听器，零内联事件）
document.addEventListener("DOMContentLoaded", () => {
  const btnSave = document.getElementById('btn_save_all');
  if (btnSave) btnSave.addEventListener('click', saveAllOptions);

  const btnCopyJson = document.getElementById('btn_copy_json');
  if (btnCopyJson) btnCopyJson.addEventListener('click', copyMcpJson);

  const btnCopyCmd = document.getElementById('btn_copy_cmd');
  if (btnCopyCmd) btnCopyCmd.addEventListener('click', copyMcpCommand);

  const btnSelectAll = document.getElementById('btn_select_all');
  if (btnSelectAll) btnSelectAll.addEventListener('click', selectAllText);

  const instInput = document.getElementById('opt_ncb_instance');
  const secInput = document.getElementById('opt_ncb_secret');
  if (instInput) instInput.addEventListener('input', updateMcpBox);
  if (secInput) secInput.addEventListener('input', updateMcpBox);

  updateMcpBox();
  initPage();
});
