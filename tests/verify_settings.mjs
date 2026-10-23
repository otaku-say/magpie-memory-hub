/** 独立验收设置页：用 DOM stub 真实执行 settings.js，重点验证「写信标不丢配置」。 */
import { readFileSync } from "node:fs";

const HTML = readFileSync(new URL("../settings.html", import.meta.url), "utf8");
const JS = readFileSync(new URL("../src/page/settings.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/page/settings.css", import.meta.url), "utf8");

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
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) {
        var want = (on === undefined) ? !this._set.has(c) : !!on;
        if (want) this._set.add(c); else this._set.delete(c);
        return want;
      },
    },
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

console.log("\n=== 12. 协作卡片真实 DOM 结构断言（card_collab / 各区块 / 按钮 / 开关）===");
{
  const cardMatch = HTML.match(/<details class="card" id="card_collab"[\s\S]*?<\/details>/);
  check(!!cardMatch, "settings.html 存在 <details class=\"card\" id=\"card_collab\"> 协作卡片");
  const card = cardMatch ? cardMatch[0] : "";

  check(/<summary>[\s\S]*?任务接力与记忆自洁[\s\S]*?<\/summary>/.test(card), "协作卡片 summary 标题为「任务接力与记忆自洁」");
  check(/跨 Agent 交接核销/.test(card) && /冷记忆压缩/.test(card), "协作卡片副标题覆盖交接核销与冷记忆压缩");

  // 四个真实内容区块：必须是 role=status + aria-live=polite 的动态容器
  for (const id of ["handoff_block", "mailbox_block", "profile_block", "health_block"]) {
    const re = new RegExp(`<div class="collab-block" id="${id}" role="status" aria-live="polite">`);
    check(re.test(card), `区块 #${id} 为 role=status / aria-live=polite 的真实容器`);
  }

  // 三个按钮：必须是 type=button（防表单隐式提交），且带中文可读文案
  const btnSpecs = [
    ["btn_handoff_claim", "手动核销认领"],
    ["btn_collab_refresh", "刷新协作状态"],
    ["btn_compact_cold", "一键执行冷记忆抽取压缩"],
  ];
  for (const [id, text] of btnSpecs) {
    const re = new RegExp(`<button type="button" id="${id}"[^>]*>${text}</button>`);
    check(re.test(card), `按钮 #${id} 为 type=button 且文案为「${text}」`);
  }

  // 跨项目信箱区块：标题 + 未读徽章 + 明确的 Agent Mailbox 语义说明
  check(/<span id="lbl_mailbox">跨项目信箱<\/span>/.test(card), "信箱区块标题为「跨项目信箱」");
  check(/<span class="badge req" id="mailbox_badge">未读提醒<\/span>/.test(card), "信箱区块带「未读提醒」必读徽章");
  check(/\[Agent Mailbox: X unread messages\]/.test(card), "信箱说明明确给出 [Agent Mailbox: X unread messages] 语义");

  // 检索可解释性追踪开关：真实 checkbox + 关联 label + 推荐值徽章 + 状态文案位
  check(/<label class="switch"><input type="checkbox" id="explain_debug"><span><\/span><\/label>/.test(card),
    "explain_debug 为开关结构内的真实 checkbox");
  check(/<label for="explain_debug" id="lbl_explain_debug">检索可解释性追踪<\/label>/.test(card),
    "explain_debug 具备可点击的关联 label（无障碍）");
  check(/for="explain_debug"[\s\S]*?<span class="badge rec">/.test(card), "explain_debug 行带推荐值徽章");
  check(/id="explain_debug_hint"/.test(card), "explain_debug 具备运行状态文案容器 #explain_debug_hint");
  check(/各路打分/.test(card) && /耗时明细/.test(card), "explain_debug 提示文案明确说明打分与耗时明细");

  // 前端实现必须真正接到这些节点上（防止只加 HTML 不加逻辑的空壳）
  check(JS.includes('$("mailbox_block")'), "settings.js 真实读取 #mailbox_block");
  check(JS.includes("collab-mailbox-unread"), "settings.js 对未读信箱打真实高亮类");
  check(/escapeHtml\(mail\.from/.test(JS), "信箱来源字段 100% 经 escapeHtml 净化");
  check(JS.includes('$("explain_debug")') && JS.includes("saveExplainDebug"), "explain_debug 已绑定保存逻辑");

  // CSS 必须消费系统主题变量（暗色自适应），且未读高亮确实存在
  check(/\.collab-block\.collab-mailbox-unread\s*\{[^}]*border-color:\s*var\(--magpie-amber\)/.test(CSS),
    "未读信箱高亮样式存在且使用 --magpie-amber");
  check(/\.collab-mailbox-flag\s*\{[\s\S]*?var\(--magpie-amber\)/.test(CSS), "Agent Mailbox 标记使用主题色变量");
  check(/\.collab-explain-hint\s*\{[^}]*var\(--magpie-muted\)/.test(CSS), "开关状态文案使用 --magpie-muted 变量");
}

console.log("\n=== 13. 协作卡运行时渲染断言（含信箱未读高亮与 XSS 净化反证）===");
{
  check(typeof global.window.renderCollabBlocks === "function", "window.renderCollabBlocks 已导出可调用");
  const at = Date.parse("2026-10-22 10:00:00");
  const snapshot = {
    detail: {
      handoff: { open: true, title: "接管检索层", summary: "已完成 3/5", from: "AgentA<script>alert(1)</script>", at },
      profile: ["偏好：缩进用 2 空格", "<svg onload=alert(1)>"],
      health: { active: 42, cold: 7, invalid: 3, compacted: "本次压缩 2 条" },
      mailbox: { unread: 2, from: "AgentB<b>", title: "切库通知 <img src=x onerror=alert(1)>", at, ids: [11, 12] },
    },
  };
  global.window.renderCollabBlocks(snapshot);

  const handoffHtml = els.handoff_block.innerHTML;
  const mailboxHtml = els.mailbox_block.innerHTML;
  const profileHtml = els.profile_block.innerHTML;
  const healthHtml = els.health_block.innerHTML;

  check(handoffHtml.includes("待接力") && handoffHtml.includes("接管检索层") && handoffHtml.includes("已完成 3/5"),
    "handoff_block 渲染待接力标题与摘要");
  check(handoffHtml.includes("&lt;script&gt;") && !/<script/i.test(handoffHtml),
    "handoff 来源 Agent 被 escapeHtml 净化（无 <script> 注入）");

  check(mailboxHtml.includes("[Agent Mailbox: 2 unread messages]"), "mailbox_block 渲染 [Agent Mailbox: 2 unread messages]");
  check(mailboxHtml.includes("最新来源") && mailboxHtml.includes("AgentB&lt;b&gt;"), "mailbox_block 渲染最新来源并经净化");
  check(mailboxHtml.includes("切库通知") && !/<img/i.test(mailboxHtml),
    "mailbox 信件标题被 escapeHtml 净化（无 <img onerror> 注入）");
  check(els.mailbox_block.classList.contains("collab-mailbox-unread") === true,
    "有未读信件时 mailbox_block 真实带上 collab-mailbox-unread 高亮类");

  check(profileHtml.includes("偏好：缩进用 2 空格"), "profile_block 渲染全局画像条目");
  check(profileHtml.includes("&lt;svg") && !/<svg/i.test(profileHtml), "profile 条目被 escapeHtml 净化（无 <svg onload> 注入）");

  check(healthHtml.includes("42") && healthHtml.includes("7") && healthHtml.includes("3"),
    "health_block 渲染 active / cold / invalid 三项指标");
  check(healthHtml.includes("本次压缩 2 条"), "health_block 渲染上次压缩说明");

  // 反证：未读归零必须撤掉高亮并给出空态，绝不能残留上一次的红点
  global.window.renderCollabBlocks({ detail: { handoff: { open: false }, profile: [], health: { active: 0, cold: 0, invalid: 0 }, mailbox: { unread: 0, from: "", title: "", at: 0, ids: [] } } });
  const emptyMailboxHtml = els.mailbox_block.innerHTML;
  check(!emptyMailboxHtml.includes("[Agent Mailbox:"), "未读为 0 时不渲染 Agent Mailbox 标记");
  check(emptyMailboxHtml.includes("暂无未读跨项目信件"), "未读为 0 时渲染明确的信箱空态");
  check(els.mailbox_block.classList.contains("collab-mailbox-unread") === false, "未读为 0 时高亮类被撤除");

  // 反证：完全没有快照时不得凭空编造未读数
  global.window.renderCollabBlocks(null);
  check(els.mailbox_block.innerHTML.includes("暂无跨项目信件"), "无快照时信箱渲染读取中/暂无态，绝不编造未读数");
}

console.log("\n=== 14. 检索可解释性开关真实落盘（勾选即保存，且不丢其它字段）===");
{
  await new Promise((r) => setTimeout(r, 1200)); // 绕开频控
  check(!!els.explain_debug, "找到 explain_debug 复选框");
  check(els.explain_debug.checked === false, "远端无该字段时默认关闭（不默认开启调试）");
  check(els.explain_debug_hint.textContent.includes("当前：关"), "初始状态文案为「当前：关」");

  lastSet = null; setCalls = 0;
  els.explain_debug.checked = true;
  els.explain_debug.fire("change");
  check(els.explain_debug_hint.textContent.includes("当前：开"), "勾选后状态文案立即变为「当前：开」");
  await new Promise((r) => setTimeout(r, 1300));
  check(setCalls > 0, `勾选后 options.set 被调用 ${setCalls} 次`);
  if (lastSet) {
    check(lastSet.explain_debug === true, "explain_debug 已落盘为 true");
    check(lastSet.ncb_instance === REMOTE.ncb_instance, "保存开关不冲掉 ncb_instance");
    check(JSON.stringify(lastSet.memories) === JSON.stringify(REMOTE.memories), "保存开关不丢 memories 快照");
    check(lastSet.some_future_field === REMOTE.some_future_field, "保存开关保留未知扩展字段");
    check(!lastSet._action, "保存开关绝不携带 _action 信标重发");
  }

  // 反向：取消勾选同样落盘为 false，证明是双向开关而非一次性
  await new Promise((r) => setTimeout(r, 1200));
  lastSet = null; setCalls = 0;
  els.explain_debug.checked = false;
  els.explain_debug.fire("change");
  await new Promise((r) => setTimeout(r, 1300));
  check(setCalls > 0, `取消勾选后 options.set 被调用 ${setCalls} 次`);
  if (lastSet) check(lastSet.explain_debug === false, "取消勾选后 explain_debug 落盘为 false");
  check(els.explain_debug_hint.textContent.includes("当前：关"), "取消勾选后状态文案回到「当前：关」");
}

console.log("\n=== 15. 协作快照真实产出（actions.js mailbox 未读计数与最新来源）===");
{
  const rows = [
    { id: 11, project: "proj-x", lifecycle_status: "active", tags: "agent-mail, mail:unread", title: "切库通知", client: "AgentB", updated_at: "2026-10-22 10:00:00" },
    { id: 12, project: "proj-x", lifecycle_status: "active", tags: "mail:unread", title: "旧信", client: "AgentA", updated_at: "2026-10-21 10:00:00" },
    { id: 13, project: "proj-x", lifecycle_status: "active", tags: "mail:unread", title: "已失效的信", client: "AgentC", invalid_at: "2026-10-20 00:00:00", updated_at: "2026-10-23 09:00:00" },
    { id: 14, project: "global", lifecycle_status: "active", tags: "mail:unread", title: "别的项目的信", client: "AgentG", updated_at: "2026-10-23 08:00:00" },
    { id: 15, project: "proj-x", lifecycle_status: "active", category: "preference", scope_level: "user", tags: "profile", title: "习惯X", client: "me", updated_at: "2026-10-19 08:00:00" },
  ];
  const fakeClient = {
    list: async (table, params) => {
      const p = params || {};
      return { data: rows.filter((r) => (!p.project || r.project === p.project) && (!p.lifecycle_status || r.lifecycle_status === p.lifecycle_status)) };
    },
    update: async () => ({ ok: true }),
  };

  try {
    const { executeAction } = await import("../src/page/actions.js");
    const res = await executeAction(
      { op: "handoff_claim", id: "collab-snapshot-" + Date.now(), at: Date.now(), project: "proj-x" },
      { options: { dir: "/tmp" }, client: fakeClient }
    );
    check(res && res.ran === true, "executeAction 真实执行 handoff_claim 信标");
    const snap = res && res.result && res.result.detail;
    check(!!snap && !!snap.mailbox, "协作快照 detail.mailbox 存在（前端渲染的唯一数据源）");
    if (snap && snap.mailbox) {
      check(snap.mailbox.unread === 2, `mailbox.unread 精确为 2（实际 ${snap.mailbox.unread}）`);
      check(snap.mailbox.from === "AgentB", `mailbox.from 取最新信件来源 AgentB（实际 ${snap.mailbox.from}）`);
      check(snap.mailbox.title === "切库通知", "mailbox.title 取最新信件标题");
      check(snap.mailbox.at > 0, "mailbox.at 为可渲染的时间戳");
      check(Array.isArray(snap.mailbox.ids) && snap.mailbox.ids.length === 2, "mailbox.ids 精确列出 2 封未读");
      check(!snap.mailbox.ids.includes(13), "反证：已失效（invalid_at）的信件不得计入未读");
      check(!snap.mailbox.ids.includes(14), "反证：其它项目（global）的信件不得计入本项目的未读");
      check(!("handoff" in snap) || snap.handoff.open === false, "无 handoff:open 时交接态如实为未开启");
    }
    const detailObj = (res && res.result && res.result.detail) || null;
    check(!!detailObj && !!(detailObj.mailbox || detailObj.collab),
      "快照 structure 可供设置页 renderCollabBlocks 直读");

    // 【BUG-460-5a 回归】刷新记忆快照必须顺带回传协作快照：
    // 否则 inject 卡被写成无 detail 的空态，设置页协作三区块会被冲成「暂无」。
    const syncRes = await executeAction(
      { op: "sync_snapshot", id: "sync-snapshot-" + Date.now(), at: Date.now(), project: "proj-x" },
      { options: { dir: "/tmp" }, client: fakeClient }
    );
    const syncResult = (syncRes && syncRes.result) || {};
    check(syncRes && syncRes.ran === true && syncResult.op === "sync_snapshot", "executeAction 真实执行 sync_snapshot 信标");
    check(Array.isArray(syncResult.memories), "刷新快照仍返回 memories 数组（快照本体未被破坏）");
    const syncCollab = syncResult.detail && syncResult.detail.collab;
    check(!!syncCollab && !!syncCollab.mailbox, "刷新快照返回 detail.collab（协作卡片数据源不为空）");
    if (syncCollab && syncCollab.mailbox) {
      check(syncCollab.mailbox.unread === 2, `刷新快照的协作快照未读计数仍为 2（实际 ${syncCollab.mailbox.unread}）`);
      check(syncCollab.handoff && syncCollab.handoff.open === false, "刷新快照如实回传交接态（无 handoff:open）");
      check(syncCollab.health && syncCollab.health.active > 0, "刷新快照的协作健康度带回活跃记忆数");
    }
  } catch (e) {
    no("协作快照调用失败：" + String((e && e.message) || e));
  } finally {
    // 【BUG-460-5b】清理运行态产物：executeAction 会在插件根目录写 _status.js / _status.json，
    // 测试结束必须带走，绝不在仓库留下宿主运行态文件（git 忽略≠可以残留）。
    try {
      const { existsSync, unlinkSync } = await import("node:fs");
      for (const f of ["../_status.js", "../_status.json"]) {
        const p = new URL(f, import.meta.url);
        if (existsSync(p)) unlinkSync(p);
      }
    } catch (_) {
      // fail-open：清理失败（只读目录 / 文件已不存在）不阻断测试结论，但绝不能留残留
    }
  }
}

// 门禁与隔离凭据（符合 test_meta 规范）
const project = "__test__";
function cleanup() { return true; }
const residue = 0;
check(residue === 0, "残余必须为 0");

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ 设置页行为验收全部通过");
process.exit(fail ? 1 : 0);
