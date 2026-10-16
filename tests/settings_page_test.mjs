import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert";

const DIR = "..";
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
    else if (id.includes("model") || id.includes("instance") || id.includes("secret") || id.includes("key") || id.includes("chars") || id.includes("count") || id.includes("url") || id.includes("principles") || id.includes("confidence") || id.includes("account") || id.includes("bucket")) tag = "input";
    else if (id.includes("mode") || id.includes("engine") || id === "on_exist") tag = "select";
    else if (id.includes("compress") || id.includes("disabled") || id.includes("cards") || id.includes("principles") || id.includes("dedup") || id.includes("extract")) tag = "input";
    elements[id] = new MockElement(id, tag);
  }

  // 初始类型
  if (elements.compress) elements.compress.type = "checkbox";
  if (elements.cross_turn_dedup) elements.cross_turn_dedup.type = "checkbox";
  if (elements.inline_extract) elements.inline_extract.type = "checkbox";
  if (elements.disabled) elements.disabled.type = "checkbox";
  if (elements.ccr_cards) elements.ccr_cards.type = "checkbox";
  if (elements.inject_principles) elements.inject_principles.type = "checkbox";
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
    magpie_base_url: "http://127.0.0.1:8000/v1",
    magpie_api_key: "mag_key_abc",
    extractor_model: "group/flash",
    clef_model: "group/clef",
    min_confidence: 0.8,
    clef_mode: "rule",
    compress: true,
    cross_turn_dedup: true,
    compress_engine: "auto",
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
  assert.strictEqual(provisionPayload.magpie_base_url, "http://127.0.0.1:8000/v1");
  assert.strictEqual(provisionPayload.extractor_model, "group/flash");
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
  // 测试 6: 复制 SQL 功能与 CSP 降级
  // ==========================================
  console.log("\n--- 测试 6: 复制 SQL 功能（包含 CSP 拦截降级） ---");
  env.elements.btn_copy_init_sql.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(env.clipboardWrites.length > 0, "剪贴板应收到文本");
  assert.ok(env.clipboardWrites[0].includes("CREATE TABLE IF NOT EXISTS memories"), "应写入建表 SQL");

  env.elements.btn_copy_reset_sql.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(env.clipboardWrites[1].includes("DROP TABLE IF EXISTS"), "应写入清库 SQL");

  // 模拟 CSP 阻断
  env.sandbox.navigator.clipboard.writeText = async () => {
    throw new Error("Blocked by CSP");
  };
  env.elements.btn_copy_init_sql.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(env.elements.sql_fallback_wrap.style.display, "block", "CSP 拦截时降级展示框应显示");
  assert.ok(env.elements.sql_fallback_text.value.includes("CREATE TABLE IF NOT EXISTS memories"), "降级框内应有 SQL");

  env.elements.btn_close_sql.click();
  assert.strictEqual(env.elements.sql_fallback_wrap.style.display, "none", "点击关闭按钮后降级框应隐藏");
  console.log("PASS: 复制初始化 SQL / 清库 SQL 均正确生效，且 CSP 拦截降级展示框工作正常");

  // ==========================================
  // 测试 7: MCP Key 显隐切换
  // ==========================================
  console.log("\n--- 测试 7: MCP Key 密码显隐切换 ---");
  assert.strictEqual(env.elements.mcp_key.type, "password");
  env.elements.toggle_mcp_key.click();
  assert.strictEqual(env.elements.mcp_key.type, "text");
  assert.strictEqual(env.elements.toggle_mcp_key.textContent, "隐藏");
  env.elements.toggle_mcp_key.click();
  assert.strictEqual(env.elements.mcp_key.type, "password");
  assert.strictEqual(env.elements.toggle_mcp_key.textContent, "显示");
  console.log("PASS: MCP Key 密码显隐切换工作正常");

  console.log("\n==========================================");
  console.log("新需求全部验收项 100% 通过！");
  console.log("==========================================");
}

runTests().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
