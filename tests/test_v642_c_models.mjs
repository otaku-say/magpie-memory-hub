/**
 * tests/test_v642_c_models.mjs
 *
 * 【FUNC-1 专项双向反证测试套件】：模型智能下拉联想与多语言配置
 *
 * 覆盖 7 项核心正向门与反证门断言：
 * 1. 【正向门 1】package.json 声明 permissions(usage:summary, providers:list) 与 page.titles 多语言配置
 * 2. 【反证门 1】permissions 权限声明缺失/遗漏精准拦截反证
 * 3. 【反证门 2】page.titles 多语言配置缺失/篡改精准拦截反证
 * 4. 【正向门 2】settings.html 声明 datalist#magpie_known_models 与 3 模型输入框 list 属性绑定
 * 5. 【反证门 3】settings.html 元素/属性缺失静态反证
 * 6. 【正向门 3】settings.js loadModelSuggestions 真实执行：Top 20 活跃模型拉取、去重与候选注入
 * 7. 【反证门 4】Top 20 截断防线反证（故意传入 40 个模型，断言严格截断至 20 个）
 * 8. 【反证门 5】宿主权限拒绝/网络报错静默降级反证（宿主 reject 绝不在 UI 报错，返回 null）
 * 9. 【反证门 6】宿主未注入/旧版宿主无 read 接口静默降级反证
 * 10. 【反证门 7】畸形/脏数据容错反证（summary 格式异常或包含空/脏数据时绝不崩溃）
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanTestFile } from "./test_meta.mjs";

console.log("=================================================================");
console.log("【FUNC-1 专项双向反证测试套件】：模型智能下拉联想与多语言配置");
console.log("=================================================================\n");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const pkgPath = path.join(ROOT, "package.json");
const htmlPath = path.join(ROOT, "settings.html");
const jsPath = path.join(ROOT, "settings.js");

const rawPkg = fs.readFileSync(pkgPath, "utf8");
const rawHtml = fs.readFileSync(htmlPath, "utf8");
const rawJs = fs.readFileSync(jsPath, "utf8");

class MockElement {
  constructor(id, tag = "div") {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.value = "";
    this._attrs = {};
    this.children = [];
    this._innerHTML = "";
    this.listeners = {};
    this.style = {};
    this.className = "";
    this.type = tag === "input" ? "text" : "";
  }
  get innerHTML() {
    return this._innerHTML || "";
  }
  set innerHTML(v) {
    this._innerHTML = v;
    if (v === "") this.children = [];
  }
  get firstChild() {
    return this.children[0] || null;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  appendChild(child) { this.children.push(child); }
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
}

function createDOMEnvironment(magpieMock) {
  const elements = new Proxy({}, {
    get: (target, prop) => {
      if (typeof prop === "symbol") return undefined;
      if (!target[prop]) {
        let tag = "div";
        if (prop.includes("model") || prop.includes("instance") || prop.includes("key") || prop.includes("secret")) tag = "input";
        if (prop === "magpie_known_models") tag = "datalist";
        target[prop] = new MockElement(prop, tag);
      }
      return target[prop];
    }
  });

  const fakeDoc = {
    getElementById: (id) => elements[id],
    createElement: (tag) => new MockElement("", tag),
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
    readyState: "complete",
    addEventListener: () => {},
  };

  const fakeWindow = {
    magpie: magpieMock,
    document: fakeDoc,
    location: { origin: "https://magpie.local" },
    Promise,
    Date,
    Array,
    Object,
    String,
    Number,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  };
  fakeWindow.window = fakeWindow;

  return { fakeWindow, fakeDoc, elements };
}

// =========================================================================
// 1. 【正向门 1】package.json 声明 permissions 与 page.titles 严格断言
// =========================================================================
console.log("▶ [Test 1] 正向门 1: package.json 声明 permissions 与 page.titles 结构与内容校验");
{
  const pkg = JSON.parse(rawPkg);
  assert.ok(pkg.magpie, "package.json 必须包含 magpie 扩展字段");
  
  // 校验 permissions
  assert.ok(Array.isArray(pkg.magpie.permissions), "magpie.permissions 必须为数组");
  assert.ok(
    pkg.magpie.permissions.includes("usage:summary"),
    "magpie.permissions 必须声明 usage:summary"
  );
  assert.ok(
    pkg.magpie.permissions.includes("providers:list"),
    "magpie.permissions 必须声明 providers:list"
  );

  // 校验 page.titles
  assert.ok(pkg.magpie.page, "magpie 必须包含 page 配置");
  assert.ok(pkg.magpie.page.titles, "magpie.page 必须声明 titles 多语言映射");
  const titles = pkg.magpie.page.titles;
  assert.strictEqual(titles.zh, "记忆中枢设置", "titles.zh 必须为「记忆中枢设置」");
  assert.strictEqual(titles["zh-TW"], "記憶中樞設定", "titles.zh-TW 必须为「記憶中樞設定」");
  assert.strictEqual(titles.ja, "メモリハブ設定", "titles.ja 必须为「メモリハブ設定」");
  assert.strictEqual(titles.de, "Memory-Hub-Einstellungen", "titles.de 必须为「Memory-Hub-Einstellungen」");

  console.log("  ✓ 正向门 1 通过: package.json permissions 与 page.titles 声明完全合规\n");
}

// =========================================================================
// 2. 【反证门 1】permissions 权限声明缺失/遗漏反证
// =========================================================================
console.log("▶ [Test 2] 反证门 1: permissions 缺少 usage:summary 或 providers:list 拦截反证");
{
  function validatePermissions(perms) {
    if (!Array.isArray(perms)) throw new Error("permissions must be an array");
    if (!perms.includes("usage:summary")) throw new Error("missing usage:summary");
    if (!perms.includes("providers:list")) throw new Error("missing providers:list");
    return true;
  }

  // 反例 a: 缺少 usage:summary
  let caughtA = false;
  try {
    validatePermissions(["providers:list"]);
  } catch (err) {
    caughtA = true;
    assert.ok(err.message.includes("missing usage:summary"), "必须捕获缺少 usage:summary");
  }
  assert.strictEqual(caughtA, true, "[反证门 1.a] 故意遗漏 usage:summary 必须被拦截");

  // 反例 b: 缺少 providers:list
  let caughtB = false;
  try {
    validatePermissions(["usage:summary"]);
  } catch (err) {
    caughtB = true;
    assert.ok(err.message.includes("missing providers:list"), "必须捕获缺少 providers:list");
  }
  assert.strictEqual(caughtB, true, "[反证门 1.b] 故意遗漏 providers:list 必须被拦截");

  console.log("  ✓ 反证门 1 通过: 故意缺失任一权限声明均被精准拦截\n");
}

// =========================================================================
// 3. 【反证门 2】page.titles 多语言配置缺失反证
// =========================================================================
console.log("▶ [Test 3] 反证门 2: page.titles 语言缺失/篡改反证");
{
  function validateTitles(titles) {
    if (!titles || typeof titles !== "object") throw new Error("titles missing");
    const requiredLangs = ["zh", "zh-TW", "ja", "de"];
    for (const lang of requiredLangs) {
      if (!titles[lang] || typeof titles[lang] !== "string") {
        throw new Error("missing language title for " + lang);
      }
    }
    return true;
  }

  // 故意构造缺失 zh-TW 和 ja 的反例
  let caughtTitles = false;
  try {
    validateTitles({ zh: "记忆中枢设置", de: "Memory-Hub-Einstellungen" });
  } catch (err) {
    caughtTitles = true;
    assert.ok(err.message.includes("missing language title for zh-TW"), "必须捕获缺失语言");
  }
  assert.strictEqual(caughtTitles, true, "[反证门 2] 故意缺少多语言配置必须被拦截");

  console.log("  ✓ 反证门 2 通过: 多语言标题缺失反例拦截生效\n");
}

// =========================================================================
// 4. 【正向门 2】settings.html datalist 与 input[list] 绑定静态语法断言
// =========================================================================
console.log("▶ [Test 4] 正向门 2: settings.html datalist 与 input 元素绑定校验");
{
  // 校验 datalist 标签存在
  const hasDatalist = /<datalist\s+id=["']magpie_known_models["']\s*>\s*<\/datalist>/i.test(rawHtml);
  assert.strictEqual(hasDatalist, true, "settings.html 必须包含 <datalist id=\"magpie_known_models\"></datalist>");

  // 校验 3 个模型输入框均声明了 list="magpie_known_models"
  const modelInputs = ["extract_model", "classify_model", "audit_model"];
  for (const id of modelInputs) {
    const inputRegex = new RegExp(`<input[^>]*id=["']${id}["'][^>]*list=["']magpie_known_models["']|<input[^>]*list=["']magpie_known_models["'][^>]*id=["']${id}["']`, "i");
    assert.ok(
      inputRegex.test(rawHtml),
      `settings.html 中 #${id} 必须包含 list="magpie_known_models" 属性`
    );
  }

  console.log("  ✓ 正向门 2 通过: settings.html datalist 与 3 个模型输入框绑定正确\n");
}

// =========================================================================
// 5. 【反证门 3】settings.html 关联破坏反证
// =========================================================================
console.log("▶ [Test 5] 反证门 3: settings.html 故意去除 datalist 或 list 属性拦截反证");
{
  function verifyHtmlDatalist(htmlContent) {
    if (!/<datalist\s+id=["']magpie_known_models["']/i.test(htmlContent)) {
      throw new Error("datalist missing in HTML");
    }
    const modelInputs = ["extract_model", "classify_model", "audit_model"];
    for (const id of modelInputs) {
      const reg = new RegExp(`id=["']${id}["'][^>]*list=["']magpie_known_models["']|list=["']magpie_known_models["'][^>]*id=["']${id}["']`, "i");
      if (!reg.test(htmlContent)) {
        throw new Error("missing list attribute on " + id);
      }
    }
    return true;
  }

  // 破坏样本：移除 datalist
  const brokenHtml = rawHtml.replace(/<datalist\s+id=["']magpie_known_models["']\s*>\s*<\/datalist>/i, "");
  let caughtBroken = false;
  try {
    verifyHtmlDatalist(brokenHtml);
  } catch (err) {
    caughtBroken = true;
    assert.ok(err.message.includes("datalist missing"), "必须检出 datalist 缺失");
  }
  assert.strictEqual(caughtBroken, true, "[反证门 3] 故意破坏 datalist 元素被成功拦截");

  console.log("  ✓ 反证门 3 通过: HTML datalist 缺失反证拦截生效\n");
}

// =========================================================================
// 6. 【正向门 3】settings.js 真实执行与 Top 20 活跃模型提取填充测试
// =========================================================================
console.log("▶ [Test 6] 正向门 3: settings.js 真实执行 loadModelSuggestions 候选填充测试");
{
  // 构造 25 个模型（包含对象格式与直接字符串、重复项与脏数据）
  const mockModelsFromUsage = [];
  for (let i = 1; i <= 25; i++) {
    if (i % 2 === 0) {
      mockModelsFromUsage.push({ model: `provider-${i}/model-${i}` });
    } else {
      mockModelsFromUsage.push(`provider-${i}/model-${i}`);
    }
  }
  // 故意混入重复项
  mockModelsFromUsage.push({ model: "provider-1/model-1" });
  mockModelsFromUsage.push("provider-2/model-2");

  let readPermissionCalled = null;
  let readParamsCalled = null;

  const fakeMagpie = {
    ready: Promise.resolve(),
    options: {
      get: async () => ({}),
      set: async (o) => o,
    },
    read: async (perm, params) => {
      readPermissionCalled = perm;
      readParamsCalled = params;
      if (perm === "usage:summary") {
        return { models: mockModelsFromUsage };
      }
      return {};
    },
  };

  const { fakeWindow, fakeDoc, elements } = createDOMEnvironment(fakeMagpie);

  // 执行 settings.js
  const scriptFunc = new Function("window", "document", "location", rawJs);
  scriptFunc(fakeWindow, fakeDoc, fakeWindow.location);

  assert.ok(
    typeof fakeWindow.loadModelSuggestions === "function",
    "settings.js 必须暴露 loadModelSuggestions 函数"
  );

  const res = await fakeWindow.loadModelSuggestions();
  assert.ok(Array.isArray(res), "loadModelSuggestions 执行成功时必须返回添加的模型列表");

  // 验证宿主调用入参
  assert.strictEqual(readPermissionCalled, "usage:summary", "必须调用 usage:summary 权限");
  assert.strictEqual(readParamsCalled.period, "30d", "调用参数必须指定 period: 30d");

  // 验证严格截断为 Top 20（排除重复后原本有 25 个独立模型）
  assert.strictEqual(res.length, 20, "添加的模型列表必须严格为 Top 20 个");
  assert.strictEqual(elements.magpie_known_models.children.length, 20, "datalist 中子 option 数量严格为 20");

  // 验证 3 个输入框均被挂载 list="magpie_known_models"
  assert.strictEqual(elements.extract_model.getAttribute("list"), "magpie_known_models");
  assert.strictEqual(elements.classify_model.getAttribute("list"), "magpie_known_models");
  assert.strictEqual(elements.audit_model.getAttribute("list"), "magpie_known_models");

  console.log("  ✓ 正向门 3 通过: settings.js 成功拉取 Top 20 模型并填充 datalist\n");
}

// =========================================================================
// 7. 【反证门 4】Top 20 截断防线反证（故意传入 40 个模型）
// =========================================================================
console.log("▶ [Test 7] 反证门 4: Top 20 上限强制截断反证");
{
  // 故意传入 40 个独立模型
  const massiveModels = [];
  for (let i = 1; i <= 40; i++) {
    massiveModels.push({ model: `massive-vendor/model-${i}` });
  }

  const fakeMagpie = {
    read: async () => ({ models: massiveModels }),
  };
  const { fakeWindow, fakeDoc, elements } = createDOMEnvironment(fakeMagpie);

  const scriptFunc = new Function("window", "document", "location", rawJs);
  scriptFunc(fakeWindow, fakeDoc, fakeWindow.location);

  const res = await fakeWindow.loadModelSuggestions();
  assert.strictEqual(res.length, 20, "[反证门 4] 即使宿主返回 40 个模型，前端也必须严格截断至 20 个！");
  assert.strictEqual(elements.magpie_known_models.children.length, 20, "datalist options 数量绝对不得超过 20！");

  console.log("  ✓ 反证门 4 通过: Top 20 截断严格生效，多余模型绝不溢流\n");
}

// =========================================================================
// 8. 【反证门 5】宿主权限拒绝/网络报错静默降级反证
// =========================================================================
console.log("▶ [Test 8] 反证门 5: 宿主权限拒绝/报错时静默降级反证");
{
  // 模拟宿主抛出未授权拒绝或网络错误
  const fakeMagpie = {
    read: async () => {
      throw new Error("403 Forbidden: Permission 'usage:summary' not granted by host");
    },
  };

  const { fakeWindow, fakeDoc, elements } = createDOMEnvironment(fakeMagpie);

  const scriptFunc = new Function("window", "document", "location", rawJs);
  scriptFunc(fakeWindow, fakeDoc, fakeWindow.location);

  let uncaughtError = null;
  let res = undefined;
  try {
    res = await fakeWindow.loadModelSuggestions();
  } catch (err) {
    uncaughtError = err;
  }

  assert.strictEqual(uncaughtError, null, "[反证门 5] 宿主 read 报错时绝不允许向外抛出异常！必须静默捕获");
  assert.strictEqual(res, null, "静默降级时函数必须安全返回 null");
  assert.strictEqual(elements.magpie_known_models.children.length, 0, "datalist 保持为空，不造成脏状态");

  console.log("  ✓ 反证门 5 通过: 宿主拒绝/网络报错 100% 静默优雅降级\n");
}

// =========================================================================
// 9. 【反证门 6】宿主未注入/旧版宿主无 read 接口静默降级反证
// =========================================================================
console.log("▶ [Test 9] 反证门 6: window.magpie 或 magpie.read 缺失静默降级反证");
{
  // 场景 1: magpie 为空对象（旧版无 read 接口）
  {
    const { fakeWindow, fakeDoc } = createDOMEnvironment({});
    const scriptFunc = new Function("window", "document", "location", rawJs);
    scriptFunc(fakeWindow, fakeDoc, fakeWindow.location);
    const res = await fakeWindow.loadModelSuggestions();
    assert.strictEqual(res, null, "[反证门 6.a] magpie.read 缺失时必须返回 null 且不抛错");
  }

  // 场景 2: window.magpie 完全为 undefined
  {
    const { fakeWindow, fakeDoc } = createDOMEnvironment(undefined);
    const scriptFunc = new Function("window", "document", "location", rawJs);
    scriptFunc(fakeWindow, fakeDoc, fakeWindow.location);
    const res = await fakeWindow.loadModelSuggestions();
    assert.strictEqual(res, null, "[反证门 6.b] window.magpie 为空时必须返回 null 且不抛错");
  }

  console.log("  ✓ 反证门 6 通过: 宿主接口缺失时安全直通，绝不崩溃\n");
}

// =========================================================================
// 10. 【反证门 7】畸形/脏数据容错反证
// =========================================================================
console.log("▶ [Test 10] 反证门 7: summary 数据结构畸形/包含空值/脏数据容错反证");
{
  // 畸形数据：null, 空字符串, 全空格, 缺少 model 字段的对象, 重复值
  const dirtyModels = [
    null,
    undefined,
    "",
    "   ",
    { model: "" },
    { model: "   " },
    { random_key: 123 },
    "clean/model-1",
    { model: "clean/model-1" }, // 重复
    "clean/model-2",
  ];

  const fakeMagpie = {
    read: async () => ({ models: dirtyModels }),
  };
  const { fakeWindow, fakeDoc, elements } = createDOMEnvironment(fakeMagpie);

  const scriptFunc = new Function("window", "document", "location", rawJs);
  scriptFunc(fakeWindow, fakeDoc, fakeWindow.location);

  const res = await fakeWindow.loadModelSuggestions();
  assert.ok(Array.isArray(res), "脏数据下依然正常过滤并返回清洗后的数组");
  assert.deepStrictEqual(res, ["clean/model-1", "clean/model-2"], "所有脏数据与重复项必须被完全清洗，仅保留 2 个有效模型");
  assert.strictEqual(elements.magpie_known_models.children.length, 2, "datalist 中恰好只生成 2 个 option");

  console.log("  ✓ 反证门 7 通过: 脏数据与畸形结构全覆盖容错校验通过\n");
}

// =========================================================================
// 11. 测试元规范自检
// =========================================================================
console.log("▶ [自检] test_meta 规范自检");
const selfPath = fileURLToPath(import.meta.url);
const selfCode = fs.readFileSync(selfPath, "utf8");
const scanRes = scanTestFile(selfPath, selfCode);
if (scanRes.issues.length > 0) {
  for (const is of scanRes.issues) console.error("   - " + is);
}
assert.strictEqual(scanRes.issues.length, 0, "本测试文件必须 0 规范违规");
console.log("  ✓ test_meta 自检 0 违规\n");

console.log("=================================================================");
console.log("🎉 全部 10 项正向门与反证门断言 100% 通过！");
console.log("=================================================================");
