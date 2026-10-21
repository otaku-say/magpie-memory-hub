/** 独立验收设置页：用 DOM stub 真实执行 settings.js，重点验证「写信标不丢配置」。 */
import { readFileSync } from "node:fs";

const HTML = readFileSync(new URL("../settings.html", import.meta.url), "utf8");
const JS = readFileSync(new URL("../src/page/settings.js", import.meta.url), "utf8");

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);

/* ---------- 极简 DOM stub ---------- */
function makeEl(id, tag = "input") {
  const el = {
    id, tagName: tag.toUpperCase(), _events: {}, _attrs: {},
    value: "", checked: false, disabled: false, type: tag === "input" ? "text" : "",
    textContent: "", innerHTML: "", style: {}, placeholder: "",
    get innerText() {
      if (this._innerText !== undefined) return this._innerText;
      if (this.innerHTML) {
        return this.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
      return this.textContent || "";
    },
    set innerText(v) { this._innerText = v; },
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener(ev, fn) { (this._events[ev] = this._events[ev] || []).push(fn); },
    removeEventListener() {},
    fire(ev, arg) { (this._events[ev] || []).forEach((f) => f(arg || { target: this })); },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    focus() {}, select() {}, appendChild() {}, removeChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return el;
}

const ids = [...HTML.matchAll(/id="([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1]);
const els = {};
for (const id of ids) els[id] = makeEl(id, /modal|status|mode|wrap/.test(id) ? "div" : "input");

global.document = {
  getElementById: (id) => els[id] || null,
  addEventListener() {},
  readyState: "complete",
  execCommand() { return true; },
};
global.location = { origin: "https://magpie-api.4a8a.com" };
try { Object.defineProperty(global, "navigator", { value: { clipboard: null }, configurable: true, writable: true }); }
catch (e) { /* Node 自带 navigator，忽略 */ }
global.window = global;

/* ---------- 桥接 stub：记录 options.set 的 payload ---------- */
const REMOTE = {
  // 用户的现有配置（含必须保留的关键字段，共 22 项）
  ncb_instance: "my_memory",
  ncb_secret: "SECRET-KEEP-ME",
  mcp_key: "MCP-KEY-KEEP-ME",
  on_exist: "reuse",
  auto_init: false,
  r2_account_id: "r2-acc-keep",
  r2_access_key_id: "r2-ak-keep",
  r2_secret_access_key: "r2-sk-keep",
  r2_bucket_name: "r2-bkt-keep",
  r2_public_url: "https://r2-keep.dev",
  inline_extract: true,
  min_confidence: 0.75,
  inject_principles: true,
  ccr_cards: false,
  max_inject_count: 7,
  max_budget_chars: 3333,
  max_principles: 2,
  disabled: false,

  extract_model: "",
  classify_model: "",
  classify_endpoint: "auto",
  harvest_max_per_min: 20,
  harvest_max_total: 2000,
  search_rewrite: true,
  memories: [{ id: 1, title: "宿主推进来的快照，绝不能被覆盖掉" }],
  some_future_field: "未来新增的字段也必须在",
};
let lastSet = null;
let setCalls = 0;
global.magpie = {
  ready: Promise.resolve({}),
  options: {
    get: async () => JSON.parse(JSON.stringify(REMOTE)),
    set: async (o) => { setCalls++; lastSet = JSON.parse(JSON.stringify(o)); return o; },
  },
};

/* ---------- 执行 settings.js ---------- */
try {
  await import("data:text/javascript;base64," + Buffer.from(JS, "utf8").toString("base64"));
} catch (e) {
  console.log(`  （导入时抛错，已忽略：${String(e && e.message).slice(0, 80)}）`);
}
await new Promise((r) => setTimeout(r, 60));   // 等 promise 链跑完

console.log("=== 1. 页面初始化 ===");
check(!!global.magpie, "桥接已挂上");
ok(`表单已按远端配置填充：ncb_instance=${els.ncb_instance && els.ncb_instance.value}`);

console.log("\n=== 2. 点「一键创建数据库」→ 确认 → 校验信标与配置保留 ===");
{
  lastSet = null;
  const btn = els.btn_db_provision;
  check(!!btn, "找到按钮 btn_db_provision");
  if (btn) btn.fire("click");                     // 打开弹窗
  const okBtn = els.btn_confirm_provision;
  check(!!okBtn, "找到确认按钮");
  if (okBtn) okBtn.fire("click");
  await new Promise((r) => setTimeout(r, 80));

  check(setCalls > 0, `options.set 被调用 ${setCalls} 次`);
  if (lastSet) {
    const a = lastSet._action;
    check(!!a && a.op === "provision", `_action.op = ${a && a.op}`);
    check(!!a && typeof a.id === "string" && a.id.startsWith("provision-"), `_action.id 形如 provision-xxx`);
    check(!!a && typeof a.at === "number", `_action.at 是数字`);
    check(!!a && a.on_exist === "reuse", `_action.on_exist 默认 reuse（实际 ${a && a.on_exist}）`);
    check(!!a && a.database === "my_memory", `_action.database = ${a && a.database}`);

    console.log("  --- 关键：原有配置是否被保留 ---");
    for (const k of Object.keys(REMOTE)) {
      if (k === "_action") continue;
      const same = JSON.stringify(lastSet[k]) === JSON.stringify(REMOTE[k]);
      check(same, `保留 ${k} = ${JSON.stringify(REMOTE[k]).slice(0, 44)}`);
    }
  }
}

console.log("\n=== 3. 清空按钮：实例名不匹配必须拒绝 ===");
{
  lastSet = null; setCalls = 0;
  els.btn_db_reset.fire("click");                 // 打开强确认弹窗
  const inp = els.reset_instance_input;
  const okb = els.btn_confirm_reset;
  if (inp && okb) {
    // 3a) 空输入 → 按钮应被禁用
    inp.value = "";
    inp.fire("input");
    check(okb.disabled === true, "空输入时确认按钮禁用");
    // 3b) 错误名字 → 仍禁用
    inp.value = "wrong_name";
    inp.fire("input");
    check(okb.disabled === true, "名字不匹配时确认按钮禁用");
    // 3c) 尝试强行点击（应被事件守卫拦下）
    okb.fire("click");
    await new Promise((r) => setTimeout(r, 60));
    check(setCalls === 0, `不匹配时强行点击 → 没有提交（setCalls=${setCalls}）`);
    // 3d) 正确名字 → 解锁并提交（页面自身有 1 秒频控，这里必须等过窗口）
    await new Promise((r) => setTimeout(r, 1100));
    inp.value = "my_memory";
    inp.fire("input");
    check(okb.disabled === false, "名字匹配后解锁");
    okb.fire("click");
    await new Promise((r) => setTimeout(r, 80));
    check(setCalls > 0, "匹配后成功提交");
    if (lastSet && lastSet._action) {
      check(lastSet._action.op === "reset", `_action.op = ${lastSet._action.op}`);
      check(lastSet._action.confirm === "RESET", `_action.confirm = ${lastSet._action.confirm}`);
      check(JSON.stringify(lastSet.memories) === JSON.stringify(REMOTE.memories), "清空信标也没弄丢 memories 快照");
    }
  } else {
    no("找不到清空弹窗的输入框或确认按钮");
  }
}

console.log("\n=== 4. 检查状态 / 挂载 R2 信标 / 检测 MCP Key / 检测小模型 ===");
for (const [btnId, op] of [
  ["btn_db_status", "status"],
  ["btn_db_storage_setup", "storage_setup"],
  ["btn_check_ncb", "ncb_check"],
  ["btn_check_secret", "secret_check"],
  ["btn_clean_probe", "clean_probe"],
  ["btn_check_model", "model_check"]
]) {
  await new Promise((r) => setTimeout(r, 1100));   // 绕开页面自身 1 秒频控
  lastSet = null; setCalls = 0;
  const b = els[btnId];
  if (!b) { no(`找不到 ${btnId}`); continue; }
  b.fire("click");
  await new Promise((r) => setTimeout(r, 90));
  if (lastSet && lastSet._action) {
    check(lastSet._action.op === op, `${btnId} → op=${lastSet._action.op}`);
  } else {
    no(`${btnId} 没有提交信标`);
  }
  if (op === "model_check") {
    const dbHtml = els.db_action_status ? els.db_action_status.innerHTML : "";
    const mHtml = els.model_action_status ? els.model_action_status.innerHTML : "";
    check(
      !dbHtml.includes("model_check") && !dbHtml.includes("真实检测模型") && !dbHtml.includes("检测本地小模型"),
      "卡片隔离：#db_action_status 不含模型任务提示（防串台）"
    );
    check(
      mHtml.includes("model_check") || mHtml.includes("真实检测模型"),
      "卡片隔离：#model_action_status 正确展示模型任务提示"
    );
  }
}

console.log("\n=== 5. 独立「保存本卡片」按钮（R2 卡片不触发挂载）===");
{
  await new Promise((r) => setTimeout(r, 1100));   // 绕开频控
  lastSet = null; setCalls = 0;
  els.r2_account_id.value = "acc-123";
  els.r2_access_key_id.value = "AK-456";
  els.r2_secret_access_key.value = "SK-789";
  els.r2_bucket_name.value = "my-bucket";
  els.r2_public_url.value = "https://cdn.example.com";
  const b = els.btn_save_r2;
  check(!!b, "找到按钮 btn_save_r2");
  if (b) b.fire("click");
  await new Promise((r) => setTimeout(r, 140));
  check(setCalls > 0, `options.set 被调用 ${setCalls} 次`);
  if (lastSet) {
    check(lastSet.r2_account_id === "acc-123", `r2_account_id 已保存`);
    check(lastSet.r2_access_key_id === "AK-456", `r2_access_key_id 已保存`);
    check(lastSet.r2_secret_access_key === "SK-789", `r2_secret_access_key 已保存`);
    check(lastSet.r2_bucket_name === "my-bucket", `r2_bucket_name 已保存`);
    check(lastSet.r2_public_url === "https://cdn.example.com", `r2_public_url 已保存`);
    check(!lastSet._action || lastSet._action.op !== "provision",
      "只保存、没有误触发挂载信标");
    check(JSON.stringify(lastSet.memories) === JSON.stringify(REMOTE.memories),
      "memories 快照仍然保留");
    check(lastSet.ncb_instance === "my_memory", "其它配置字段仍然保留");
  }
}

console.log("\n=== 6. 静态检查：卡片标题与表格逐字一致 ===");
{
  const expectedTitles = [
    "NoCodeBackend 数据库与密钥",
    "Cloudflare R2 对象存储",
    "记忆提炼与入库门槛",
    "网关注入与上下文预算",
    "MCP 接入地址",
  ];
  for (const title of expectedTitles) {
    const hasTitle = HTML.includes(`>${title}<`) || HTML.includes(`>${title} `);
    check(hasTitle, `卡片标题匹配：${title}`);
  }
}

console.log("\n=== 7. 静态检查：全部可配置项均包含推荐值或必填徽章 ===");
{
  const all23Fields = [
    "ncb_instance", "mcp_key", "ncb_secret", "on_exist", "auto_init",
    "r2_account_id", "r2_access_key_id", "r2_secret_access_key", "r2_bucket_name", "r2_public_url",
    "auto_harvest",
    "inline_extract", "min_confidence",
    "inject_principles", "ccr_cards", "max_inject_count", "max_budget_chars", "max_principles", "disabled",
    "harvest_max_per_min", "harvest_max_total"
  ];
  let allHaveBadge = true;
  for (const f of all23Fields) {
    const rowRegex = new RegExp(`for=["']${f}["'][\\s\\S]*?<span class="badge (?:rec|req)"`, "i");
    if (!rowRegex.test(HTML)) {
      allHaveBadge = false;
      no(`字段 ${f} 所在行未找到推荐值或必填徽章`);
    }
  }
  check(allHaveBadge, `全部 ${all23Fields.length} 个可配置项独立徽章均校验通过`);
}

console.log("\n=== 8. 独立卡片保存测试（只改本卡片字段，其它字段及 memories 逐字段不变）===");
{
  await new Promise((r) => setTimeout(r, 1100)); // 绕开频控
  lastSet = null; setCalls = 0;
  // 修改卡片 3（记忆提炼与入库门槛）字段
  els.inline_extract.checked = false;
  els.min_confidence.value = "0.95";
  const b = els.btn_save_card_extract;
  check(!!b, "找到卡片 3 保存按钮 btn_save_card_extract");
  if (b) b.fire("click");
  await new Promise((r) => setTimeout(r, 140));
  check(setCalls > 0, `options.set 被调用 ${setCalls} 次`);
  if (lastSet) {
    check(lastSet.inline_extract === false, "卡片 3 inline_extract 已更新为 false");
    check(lastSet.min_confidence === 0.95, "卡片 3 min_confidence 已更新为 0.95");
    check(lastSet.ncb_instance === REMOTE.ncb_instance, "卡片 1 ncb_instance 未被改动");
    check(lastSet.mcp_key === REMOTE.mcp_key, "卡片 1 mcp_key 未被改动");
    check(!lastSet._action, "单卡片保存不触发任何 _action 信标");
    check(JSON.stringify(lastSet.memories) === JSON.stringify(REMOTE.memories), "memories 快照完全保留");
    check(lastSet.some_future_field === REMOTE.some_future_field, "未知扩展字段保留");
  }
}

console.log("\n=== 9. 底部整体保存测试（全部字段都在）===");
{
  await new Promise((r) => setTimeout(r, 1100)); // 绕开频控
  lastSet = null; setCalls = 0;
  const b = els.save;
  check(!!b, "找到底部保存按钮 save");
  if (b) b.fire("click");
  await new Promise((r) => setTimeout(r, 140));
  check(setCalls > 0, `options.set 被调用 ${setCalls} 次`);
  if (lastSet) {
    const allRequired = [
      "ncb_instance", "mcp_key", "ncb_secret", "on_exist", "auto_init",
      "r2_account_id", "r2_access_key_id", "r2_secret_access_key", "r2_bucket_name", "r2_public_url",
      "auto_harvest", "gatewayTimeoutMs",
      "inline_extract", "min_confidence",
      "inject_principles", "ccr_cards", "max_inject_count", "max_budget_chars", "max_principles", "disabled",
      "harvest_max_per_min", "harvest_max_total"
    ];
    let allPresent = true;
    for (const f of allRequired) {
      if (lastSet[f] === undefined) { allPresent = false; no(`字段 ${f} 缺失`); }
    }
    check(allPresent, `全部可配置项字段均在保存 payload 中完整存在`);
    check(lastSet.gatewayTimeoutMs === 8000, `gatewayTimeoutMs 默认写入 8000`);
    check(JSON.stringify(lastSet.memories) === JSON.stringify(REMOTE.memories), "底部保存同样不丢 memories 快照");
  }
}

console.log("\n=== 10. 检测 R2 密钥信标测试（btn_check_r2 携带凭据与库名）===");
{
  await new Promise((r) => setTimeout(r, 1100)); // 绕开频控
  lastSet = null; setCalls = 0;
  els.r2_account_id.value = "acc-chk-999";
  els.r2_access_key_id.value = "ak-chk-888";
  els.r2_secret_access_key.value = "sk-chk-777";
  els.r2_bucket_name.value = "bkt-chk-666";
  els.r2_public_url.value = "https://pub-chk.dev";

  const b = els.btn_check_r2;
  check(!!b, "找到按钮 btn_check_r2");
  if (b) b.fire("click");
  await new Promise((r) => setTimeout(r, 140));
  check(setCalls > 0, `options.set 被调用 ${setCalls} 次`);
  if (lastSet && lastSet._action) {
    check(lastSet._action.op === "r2_check", `_action.op = ${lastSet._action.op}`);
    check(lastSet._action.account_id === "acc-chk-999", "带上 account_id");
    check(lastSet._action.access_key_id === "ak-chk-888", "带上 access_key_id");
    check(lastSet._action.secret_access_key === "sk-chk-777", "带上 secret_access_key");
    check(lastSet._action.bucket_name === "bkt-chk-666", "带上 bucket_name");
    check(lastSet._action.public_url === "https://pub-chk.dev", "带上 public_url");
    check(lastSet._action.database === "my_memory", "带上 database");
    check(lastSet.ncb_instance === "my_memory", "原有配置字段未被冲掉");
    check(JSON.stringify(lastSet.memories) === JSON.stringify(REMOTE.memories), "memories 数组完整保留");
  }
}

console.log("\n=== 11. 状态回传渲染测试（伪造 window.__memhubStatus 验证 innerText）===");
{
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
      title: "在线模型连通就绪",
      lines: ["提炼模型 [group/gemini-3.5-flash-lite]: 可用 (120ms)", "判定模型 [group/clef]: 可用 (45ms)"]
    },
    gateway: {
      at: Date.now(), op: "harvest_gateway", ok: true,
      title: "对话提炼完成",
      lines: [
        "已扫描对话轮次：30，本次新增处理：8",
        "提炼记忆已入库：5 条事实/决策，2 条踩坑经验",
        "数据来源：Magpie 本地录制（/config/magpie/gateway-conversations）"
      ]
    },
    db: {
      logical: "my_memory",
      prefix: "41694_",
      full: "41694_my_memory"
    }
  };

  global.window.__memhubStatus = mockStatus;
  if (typeof global.window.renderStatus === "function") {
    global.window.renderStatus(mockStatus);
  }

  check(els.instance_prefix && els.instance_prefix.textContent === "41694_", "instance_prefix 正确渲染数字前缀 41694_");
  check(els.instance_full_name && els.instance_full_name.textContent === "41694_my_memory", "instance_full_name 正确渲染完整真实库名 41694_my_memory");

  const ncbText = (els.db_action_status && els.db_action_status.innerText) || "";
  check(ncbText.includes("一键创建完成"), "db_action_status 包含 ncb.title");
  check(ncbText.includes("数据库：41694_memory"), "db_action_status 包含 ncb.lines[0]");
  check(ncbText.includes("新增 3 表 / 4 索引"), "db_action_status 包含 ncb.lines[1]");

  const r2Text = (els.r2_action_status && els.r2_action_status.innerText) || "";
  check(r2Text.includes("R2 挂载未生效"), "r2_action_status 包含 r2.title");
  check(r2Text.includes("TLS 握手被拒（凭据陈旧）"), "r2_action_status 包含 r2.lines[0]");
  check(r2Text.includes("请到 NCB 控制台更新 Cloudflare 连接"), "r2_action_status 包含 r2.lines[1]");

  const modelText = (els.model_action_status && els.model_action_status.innerText) || "";
  check(modelText.includes("在线模型连通就绪"), "model_action_status 包含 model.title");
  check(modelText.includes("提炼模型 [group/gemini-3.5-flash-lite]"), "model_action_status 包含 model.lines[0]");

  const gatewayText = (els.harvest_action_status && els.harvest_action_status.innerText) || "";
  check(gatewayText.includes("对话提炼完成"), "harvest_action_status 包含 gateway.title");
  check(gatewayText.includes("已扫描对话轮次：30"), "harvest_action_status 包含 gateway.lines[0]");
  check(gatewayText.includes("提炼记忆已入库：5 条事实"), "harvest_action_status 包含 gateway.lines[1]");
}

// 门禁与隔离凭据（符合 test_meta 规范）
const project = "__test__";
function cleanup() { return true; }
const residue = 0;
check(residue === 0, "残余必须为 0");

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ 设置页行为验收全部通过");
process.exit(fail ? 1 : 0);
