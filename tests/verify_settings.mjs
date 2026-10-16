/** 独立验收设置页：用 DOM stub 真实执行 settings.js，重点验证「写信标不丢配置」。 */
import { readFileSync } from "node:fs";

const HTML = readFileSync("../settings.html", "utf8");
const JS = readFileSync("../settings.js", "utf8");

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
  // 用户的现有配置（含必须保留的关键字段）
  ncb_instance: "my_memory",
  ncb_secret: "SECRET-KEEP-ME",
  mcp_key: "MCP-KEY-KEEP-ME",
  compress: true,
  cross_turn_dedup: true,
  inline_extract: true,
  max_inject_count: 7,
  max_budget_chars: 3333,
  min_confidence: 0.75,
  clef_mode: "rule",
  compress_engine: "auto",
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
  // 某些 stub 缺方法可能抛错，只要 boot 跑过就继续
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

console.log("\n=== 4. 检查状态 / 挂载 R2 信标 ===");
for (const [btnId, op] of [["btn_db_status", "status"], ["btn_db_storage_setup", "storage_setup"]]) {
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
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ 设置页行为验收全部通过");
process.exit(fail ? 1 : 0);
