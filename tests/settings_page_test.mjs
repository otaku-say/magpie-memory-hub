import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert";

import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));  // 不依赖调用者的工作目录

const DIR = fs.existsSync("settings.html") ? "." : "..";
const htmlPath = path.join(DIR, "settings.html");
const cssPath = path.join(DIR, "settings.css");
const jsPath = path.join(DIR, "settings.js");

const html = fs.readFileSync(htmlPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");

console.log("==========================================");
console.log("1. 静态检查验证");
console.log("==========================================");

// 1.1 检查内联事件属性 (例如 onclick="...", oninput="..." 等)
const inlineEventRegex = /\son[a-z]+=["'\`]/gi;
const inlineMatches = html.match(inlineEventRegex);
if (inlineMatches) {
  console.error("FAIL: 发现内联事件属性:", inlineMatches);
  process.exit(1);
} else {
  console.log("PASS: settings.html 中无任何内联事件属性");
}

// 1.2 检查外部资源引用 (不允许 CDN / http(s) 脚本或样式)
const extResourceRegex = /<(?:script|link)[^>]+(?:src|href)=["'](https?:|\/\/)[^"']+/gi;
const extMatches = html.match(extResourceRegex);
if (extMatches) {
  console.error("FAIL: 发现外部资源引用:", extMatches);
  process.exit(1);
} else {
  console.log("PASS: settings.html 中无任何外部资源引用");
}

// 1.3 检查 JS 中引用的所有 id 是否在 HTML 中存在
const idInHtml = new Set();
const idAttrRegex = /\bid=["']([^"']+)["']/g;
let m;
while ((m = idAttrRegex.exec(html)) !== null) {
  idInHtml.add(m[1]);
}

const idInJs = new Set();
const jsIdRegex = /(?:\$|getElementById)\(\s*["']([^"']+)["']\s*\)/g;
while ((m = jsIdRegex.exec(js)) !== null) {
  idInJs.add(m[1]);
}

const missingIds = [];
for (const id of idInJs) {
  if (!idInHtml.has(id)) {
    missingIds.push(id);
  }
}
if (missingIds.length > 0) {
  console.error("FAIL: settings.js 中引用了 HTML 中不存在的 id:", missingIds);
  process.exit(1);
} else {
  console.log("PASS: settings.js 中所有 id 引用均存在于 settings.html 中 (共 " + idInJs.size + " 个)");
}

// 1.4 检查 CSS 中是否使用了硬编码颜色
const hexColorRegex = /#([0-9a-fA-F]{3,8})\b/g;
const rgbColorRegex = /\brgba?\(/g;
const newCssSection = css.slice(css.indexOf("/* ---- 危险与次级按钮 ---- */"));
const hexInNewCss = newCssSection.match(hexColorRegex);
const rgbInNewCss = newCssSection.match(rgbColorRegex);
if (hexInNewCss || rgbInNewCss) {
  console.error("FAIL: 新增 CSS 样式中发现了硬编码颜色:", hexInNewCss, rgbInNewCss);
  process.exit(1);
} else {
  console.log("PASS: 新增 CSS 样式中无任何硬编码颜色，完全使用 --magpie-* 主题变量");
}

console.log("\n==========================================");
console.log("2. 真实执行 settings.js 与 DOM Stub 交互测试");
console.log("==========================================");

class MockElement {
  constructor(id, tag = "div") {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.value = "";
    this.type = tag === "button" ? "button" : (tag === "input" ? "text" : "");
    this.checked = false;
    this.disabled = false;
    this.style = { display: "" };
    this.textContent = "";
    this.innerHTML = "";
    this.className = "";
    this.placeholder = "";
    this.listeners = {};
  }
  get innerText() {
    if (this._innerText !== undefined) return this._innerText;
    if (this.innerHTML) {
      return this.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    return this.textContent || "";
  }
  set innerText(v) {
    this._innerText = v;
  }
  addEventListener(evt, fn) {
    if (!this.listeners[evt]) this.listeners[evt] = [];
    this.listeners[evt].push(fn);
  }
  dispatchEvent(evt) {
    const list = this.listeners[evt.type || evt] || [];
    for (const fn of list) {
      fn.call(this, typeof evt === "object" ? evt : { type: evt, target: this });
    }
  }
  click() {
    this.dispatchEvent({ type: "click", target: this });
  }
  focus() {}
  select() {}
}

function createDOMStub(initialOptions) {
  const elements = {};
  for (const id of idInHtml) {
    let tag = "div";
    if (id.startsWith("btn_") || id === "save" || id === "copy" || id === "toggle_mcp_key") tag = "button";
    else if (id.includes("instance") || id.includes("secret") || id.includes("key") || id.includes("chars") || id.includes("count") || id.includes("url") || id.includes("principles") || id.includes("confidence") || id.includes("account") || id.includes("bucket")) tag = "input";
    else if (id === "on_exist") tag = "select";
    else if (id.includes("compress") || id.includes("disabled") || id.includes("cards") || id.includes("principles") || id.includes("dedup") || id.includes("extract") || id === "auto_init") tag = "input";
    elements[id] = new MockElement(id, tag);
  }

  // 初始类型
  if (elements.compress) elements.compress.type = "checkbox";
  if (elements.cross_turn_dedup) elements.cross_turn_dedup.type = "checkbox";
  if (elements.inline_extract) elements.inline_extract.type = "checkbox";
  if (elements.disabled) elements.disabled.type = "checkbox";
  if (elements.ccr_cards) elements.ccr_cards.type = "checkbox";
  if (elements.inject_principles) elements.inject_principles.type = "checkbox";
  if (elements.auto_init) elements.auto_init.type = "checkbox";
  if (elements.mcp_key) elements.mcp_key.type = "password";
  if (elements.ncb_secret) elements.ncb_secret.type = "password";
  if (elements.r2_secret_access_key) elements.r2_secret_access_key.type = "password";

  let savedOptions = JSON.parse(JSON.stringify(initialOptions));
  const setCalls = [];

  const magpie = {
    ready: Promise.resolve(),
    options: {
      get: async () => JSON.parse(JSON.stringify(savedOptions)),
      set: async (payload) => {
        setCalls.push(JSON.parse(JSON.stringify(payload)));
        savedOptions = JSON.parse(JSON.stringify(payload));
        return savedOptions;
      }
    }
  };

  const clipboardWrites = [];
  const navigator = {
    clipboard: {
      writeText: async (t) => {
        clipboardWrites.push(t);
      }
    }
  };

  const doc = {
    getElementById: (id) => elements[id] || null,
    readyState: "complete",
    addEventListener: () => {},
    execCommand: () => true
  };

  const sandbox = {
    document: doc,
    window: {
      magpie,
      ready: Promise.resolve(),
      options: magpie.options
    },
    magpie,
    navigator,
    location: { origin: "https://magpie-web.example.com" },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    parseFloat,
    isNaN,
    Array,
    Object,
    String,
    Number,
    Promise,
    console
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = doc;
  sandbox.window.navigator = navigator;
  sandbox.window.location = sandbox.location;

  return { sandbox, elements, magpie, setCalls, clipboardWrites };
}

async function runTests() {
  const initialConfig = {
    ncb_instance: "agent_memory", // 用户填的逻辑名
    ncb_secret: "",              // 留空，由插件创建后自动获取
    mcp_key: "mcp_sec_key_xyz",  // 唯一必填的 MCP 密钥
    on_exist: "reuse",           // 重名策略
    auto_init: false,
    r2_account_id: "r2_acc_123",
    r2_access_key_id: "{{SECRET_lkwmrmvd}}",
    r2_secret_access_key: "{{SECRET_tftpt17h}}",
    r2_bucket_name: "",
    r2_public_url: "",
    min_confidence: 0.8,
    compress: true,
    cross_turn_dedup: true,
    compress_max_chars: 3000,
    compress_min_chars: 1200,
    max_inject_count: 5,
    max_budget_chars: 2048,
    inline_extract: true,
    inject_principles: true,
    ccr_cards: false,
    max_principles: 2,
    disabled: false,
    // 关键外部保留字段：
    custom_external_field: "do_not_lose_me",
    memories: [{ id: 101, title: "important memory" }]
  };

  const env = createDOMStub(initialConfig);

  const script = new vm.Script(js);
  const context = vm.createContext(env.sandbox);
  script.runInContext(context);

  await new Promise((r) => setTimeout(r, 50));
  console.log("PASS: settings.js 在 DOM stub 中启动成功");

  // 断言初始表单填充正确
  assert.strictEqual(env.elements.ncb_instance.value, "agent_memory");
  assert.strictEqual(env.elements.mcp_key.value, "mcp_sec_key_xyz");
  assert.strictEqual(env.elements.on_exist.value, "reuse");
  assert.strictEqual(env.elements.ncb_secret.value, "");
  assert.strictEqual(env.elements.auto_init.checked, false);
  console.log("PASS: 表单字段 fill() 初始填充正确（ncb_secret 留空，mcp_key 已填）");

  // ==========================================
  // 测试 2: 「一键创建数据库」提交信标 op: "provision"
  // ==========================================
  console.log("\n--- 测试 2: 点击「一键创建数据库」提交信标 op: 'provision' ---");
  env.elements.btn_db_provision.click();
  assert.strictEqual(env.elements.modal_provision.style.display, "flex", "modal_provision 应弹出");

  env.elements.btn_confirm_provision.click();
  assert.strictEqual(env.elements.modal_provision.style.display, "none", "modal_provision 应关闭");

  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(env.setCalls.length, 1, "options.set 应被调用 1 次");

  const provisionPayload = env.setCalls[0];
  assert.ok(provisionPayload._action, "payload 必须包含 _action");
  assert.strictEqual(provisionPayload._action.op, "provision");
  assert.ok(provisionPayload._action.id.startsWith("provision-"), "action.id 应以 provision- 开头");
  assert.strictEqual(provisionPayload._action.on_exist, "reuse", "重名策略必须带上 reuse");
  assert.strictEqual(provisionPayload._action.database, "agent_memory");

  // 关键断言：原有配置字段一个都没丢！
  assert.strictEqual(provisionPayload.ncb_instance, "agent_memory");
  assert.strictEqual(provisionPayload.mcp_key, "mcp_sec_key_xyz");
  assert.strictEqual(provisionPayload.on_exist, "reuse");
  assert.strictEqual(provisionPayload.auto_init, false);
  assert.strictEqual(provisionPayload.min_confidence, 0.8);
  assert.strictEqual(provisionPayload.compress, true);
  assert.strictEqual(provisionPayload.custom_external_field, "do_not_lose_me", "外部自定义字段不能被冲掉");
  assert.deepStrictEqual(provisionPayload.memories, [{ id: 101, title: "important memory" }], "memories 数组不能被冲掉");

  console.log("PASS: 一键创建数据库信标正确提交 op='provision' on_exist='reuse'，且原有配置字段全部保留！");

  // ==========================================
  // 测试 3: 「挂载 R2 存储」信标 op: "storage_setup"
  // ==========================================
  console.log("\n--- 测试 3: 点击「挂载 R2 存储」提交信标 op: 'storage_setup' ---");
  await new Promise((r) => setTimeout(r, 1100)); // 避开频控

  env.elements.r2_bucket_name.value = "my-mem-bucket";
  env.elements.btn_db_storage_setup.click();

  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(env.setCalls.length, 2, "options.set 应被调用第 2 次");
  const storagePayload = env.setCalls[1];
  assert.ok(storagePayload._action);
  assert.strictEqual(storagePayload._action.op, "storage_setup");
  assert.strictEqual(storagePayload._action.database, "agent_memory");
  assert.strictEqual(storagePayload._action.bucket_name, "my-mem-bucket");
  assert.strictEqual(storagePayload.custom_external_field, "do_not_lose_me");

  console.log("PASS: 挂载 R2 存储信标正确提交 op='storage_setup'！");

  // ==========================================
  // 测试 4: 「清空数据库」强二次确认与实例名校验
  // ==========================================
  console.log("\n--- 测试 4: 点击「清空数据库」强二次确认与实例名校验 ---");
  env.elements.btn_db_reset.click();
  assert.strictEqual(env.elements.modal_reset.style.display, "flex");
  assert.strictEqual(env.elements.reset_target_name.textContent, "agent_memory");
  assert.strictEqual(env.elements.btn_confirm_reset.disabled, true, "打开时确认按钮必须禁用");

  // 输入不匹配的名字
  env.elements.reset_instance_input.value = "wrong_name";
  env.elements.reset_instance_input.dispatchEvent("input");
  assert.strictEqual(env.elements.btn_confirm_reset.disabled, true, "不匹配时确认按钮必须禁用");

  env.elements.btn_confirm_reset.click();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(env.setCalls.length, 2, "输入不匹配时绝不能调用 options.set");

  // 等待频控冷却
  await new Promise((r) => setTimeout(r, 1100));

  // 输入正确名字
  env.elements.reset_instance_input.value = "agent_memory";
  env.elements.reset_instance_input.dispatchEvent("input");
  assert.strictEqual(env.elements.btn_confirm_reset.disabled, false, "名字完全匹配时确认按钮必须激活");

  env.elements.btn_confirm_reset.click();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(env.setCalls.length, 3, "options.set 应被调用第 3 次");

  const resetPayload = env.setCalls[2];
  assert.ok(resetPayload._action);
  assert.strictEqual(resetPayload._action.op, "reset");
  assert.strictEqual(resetPayload._action.confirm, "RESET", "清库操作必须带 confirm: 'RESET'");
  assert.strictEqual(resetPayload._action.database, "agent_memory");

  console.log("PASS: 清空按钮在名字不匹配时拒绝提交，匹配时提交且 confirm === 'RESET'");

  // ==========================================
  // 测试 5: 连点频控测试
  // ==========================================
  console.log("\n--- 测试 5: 频控拦截与连点提示测试 ---");
  env.elements.btn_db_reset.click();
  env.elements.reset_instance_input.value = "agent_memory";
  env.elements.reset_instance_input.dispatchEvent("input");
  env.elements.btn_confirm_reset.click();

  assert.strictEqual(env.setCalls.length, 3, "频控时间内连续调用 options.set 应被拦截");
  const statusBoxHtml = env.elements.db_action_status.innerHTML;
  const statusText = env.elements.status.textContent;
  const hasFreqMsg = statusBoxHtml.includes("频繁") || statusBoxHtml.includes("频控") ||
                     statusText.includes("频繁") || statusText.includes("频控");
  assert.ok(hasFreqMsg, "连点被拦截后必须给出用户可读的提示 (包含'频繁'或'频控')");
  console.log("PASS: 连点两次成功触发频控保护，提示用户: " + (statusText || statusBoxHtml));

  // 测试 429 异常捕获
  await new Promise((r) => setTimeout(r, 1100));
  const origSet = env.magpie.options.set;
  env.magpie.options.set = async () => {
    const err = new Error("HTTP 429 Too Many Requests");
    err.status = 429;
    throw err;
  };
  env.elements.btn_db_status.click();
  await new Promise((r) => setTimeout(r, 50));
  const statusAfter429 = env.elements.db_action_status.innerHTML;
  assert.ok(statusAfter429.includes("频繁") || statusAfter429.includes("429"), "远端 429 必须给出明确提示");
  console.log("PASS: 远端返回 429 时正确捕获并给出用户可读提示");
  env.magpie.options.set = origSet;

  // ==========================================
  // 测试 6: 点击「检测 R2 密钥」提交信标 op: 'r2_check'
  // ==========================================
  console.log("\n--- 测试 6: 点击「检测 R2 密钥」提交信标 op: 'r2_check' ---");
  await new Promise((r) => setTimeout(r, 1100));
  env.elements.r2_account_id.value = "acc-check-001";
  env.elements.r2_access_key_id.value = "{{SECRET_8r9j03u4}}";
  env.elements.r2_secret_access_key.value = "{{SECRET_z6x9m5y2}}";
  env.elements.r2_bucket_name.value = "bkt-check-001";
  env.elements.r2_public_url.value = "https://r2-check.example.com";

  env.elements.btn_check_r2.click();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(env.setCalls.length, 4, "options.set 应被调用第 4 次");

  const r2CheckPayload = env.setCalls[3];
  assert.ok(r2CheckPayload._action, "必须包含 _action");
  assert.strictEqual(r2CheckPayload._action.op, "r2_check", "信标 op 必须为 r2_check");
  assert.strictEqual(r2CheckPayload._action.account_id, "acc-check-001", "必须带上 account_id");
  assert.strictEqual(r2CheckPayload._action.access_key_id, "{{SECRET_8r9j03u4}}", "必须带上 access_key_id");
  assert.strictEqual(r2CheckPayload._action.secret_access_key, "{{SECRET_z6x9m5y2}}", "必须带上 secret_access_key");
  assert.strictEqual(r2CheckPayload._action.bucket_name, "bkt-check-001", "必须带上 bucket_name");
  assert.strictEqual(r2CheckPayload._action.public_url, "https://r2-check.example.com", "必须带上 public_url");
  assert.strictEqual(r2CheckPayload.custom_external_field, "do_not_lose_me", "原有配置不丢失");
  assert.deepStrictEqual(r2CheckPayload.memories, [{ id: 101, title: "important memory" }], "memories 数组不丢失");
  console.log("PASS: 点击「检测 R2 密钥」提交信标 op='r2_check' 且带齐 R2 凭据字段，原有配置不丢失");

  // ==========================================
  // 测试 7: 点击「检测 MCP Key」与「检测本地小模型」信标
  // ==========================================
  console.log("\n--- 测试 7: 点击「检测 MCP Key」与「检测本地小模型」提交信标 ---");
  await new Promise((r) => setTimeout(r, 1100));
  env.elements.btn_check_ncb.click();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(env.setCalls.length, 5, "options.set 应被调用第 5 次");
  const ncbCheckPayload = env.setCalls[4];
  assert.strictEqual(ncbCheckPayload._action.op, "ncb_check", "op 必须为 ncb_check");
  assert.strictEqual(ncbCheckPayload._action.database, "agent_memory");
  console.log("PASS: 点击「检测 MCP Key」提交信标 op='ncb_check'");

  await new Promise((r) => setTimeout(r, 1100));
  env.elements.btn_check_model.click();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(env.setCalls.length, 6, "options.set 应被调用第 6 次");
  const modelCheckPayload = env.setCalls[5];
  assert.strictEqual(modelCheckPayload._action.op, "model_check", "op 必须为 model_check");
  console.log("PASS: 点击「检测本地小模型」提交信标 op='model_check'");

  // ==========================================
  // 测试 8: MCP Key 显隐切换
  // ==========================================
  console.log("\n--- 测试 8: MCP Key 密码显隐切换 ---");
  assert.strictEqual(env.elements.mcp_key.type, "password");
  env.elements.toggle_mcp_key.click();
  assert.strictEqual(env.elements.mcp_key.type, "text");
  assert.strictEqual(env.elements.toggle_mcp_key.textContent, "隐藏");
  env.elements.toggle_mcp_key.click();
  assert.strictEqual(env.elements.mcp_key.type, "password");
  assert.strictEqual(env.elements.toggle_mcp_key.textContent, "显示");
  console.log("PASS: MCP Key 密码显隐切换工作正常");

  // ==========================================
  // 测试 9: 状态回传渲染测试 (window.__memhubStatus)
  // ==========================================
  console.log("\n--- 测试 9: 状态回传渲染测试 (window.__memhubStatus) ---");
  const mockStatus = {
    ncb: {
      at: Date.now(), op: "provision", ok: true,
      title: "一键创建完成",
      lines: ["数据库：41694_memory", "新增 3 表 / 4 索引"]
    },
    r2: {
      at: Date.now(), op: "storage_setup", ok: false,
      title: "R2 挂载未生效",
      lines: ["TLS 握手被拒（凭据陈旧）", "请到 NCB 控制台更新 Cloudflare 连接"]
    },
    model: {
      at: Date.now(), op: "model_check", ok: true,
      title: "本地模型就绪",
      lines: ["模型路径：models/multilingual.onnx", "大小：48MB"]
    }
  };

  env.sandbox.window.__memhubStatus = mockStatus;
  env.sandbox.window.renderStatus(mockStatus);

  const ncbText = env.elements.db_action_status.innerText;
  assert.ok(ncbText.includes("一键创建完成"), "db_action_status 包含 ncb.title");
  assert.ok(ncbText.includes("数据库：41694_memory"), "db_action_status 包含 ncb line 1");
  assert.ok(ncbText.includes("新增 3 表 / 4 索引"), "db_action_status 包含 ncb line 2");

  const r2Text = env.elements.r2_action_status.innerText;
  assert.ok(r2Text.includes("R2 挂载未生效"), "r2_action_status 包含 r2.title");
  assert.ok(r2Text.includes("TLS 握手被拒（凭据陈旧）"), "r2_action_status 包含 r2 line 1");
  assert.ok(r2Text.includes("请到 NCB 控制台更新 Cloudflare 连接"), "r2_action_status 包含 r2 line 2");

  const modelText = env.elements.model_action_status.innerText;
  assert.ok(modelText.includes("本地模型就绪"), "model_action_status 包含 model.title");
  assert.ok(modelText.includes("models/multilingual.onnx"), "model_action_status 包含 model line 1");
  assert.ok(modelText.includes("48MB"), "model_action_status 包含 model line 2");
  console.log("PASS: 状态回传正确渲染到 #db_action_status、#r2_action_status 与 #model_action_status，innerText 均包含标题与每一行明细！");

  // ==========================================
  // 测试 10: 静态校验 22 个可配置项独立徽章完整性
  // ==========================================
  console.log("\n--- 测试 10: 全部 22 个可配置项独立徽章校验 ---");
  const all22Fields = [
    "ncb_instance", "mcp_key", "ncb_secret", "on_exist", "auto_init",
    "r2_account_id", "r2_access_key_id", "r2_secret_access_key", "r2_bucket_name", "r2_public_url",
    "inline_extract", "min_confidence",
    "inject_principles", "ccr_cards", "max_inject_count", "max_budget_chars", "max_principles", "disabled",
    "compress", "cross_turn_dedup", "compress_max_chars", "compress_min_chars"
  ];
  for (const f of all22Fields) {
    const rowRegex = new RegExp(`for=["']${f}["'][\\s\\S]*?<span class="badge (?:rec|req)"`, "i");
    assert.ok(rowRegex.test(html), `字段 ${f} 所在行必须有推荐值或必填徽章`);
  }
  console.log(`PASS: 全部 ${all22Fields.length} 个可配置项独立徽章均校验通过！`);

  console.log("\n==========================================");
  console.log("新需求全部验收项 100% 通过！");
  console.log("==========================================");
  process.exit(0);
}

runTests().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
