/**
 * 状态竞争回归测试 —— 复现并锁死这个 bug：
 *
 *   点「检测 MCP Key」成功后，再点「一键创建数据库」，
 *   提示框里「等待中」与「上一次的 MCP 检测成功」来回交替闪烁。
 *
 * 根因：renderAllStatus() 会把 _status.js 里的结果【全量】画一遍，
 *   于是「画出等待态 → 轮询用上一次的旧结果覆盖 → 又画等待态」来回打架。
 *   修复：等待中的卡片只接受比提交时间更新的结果（pendingSince 保护）。
 *
 * 本测试直接复现原始场景并断言容器内容不再被旧结果污染。
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { fail++; console.log(`  ✗ ${m}`); };
const check = (c, m) => c ? ok(m) : no(m);

/* ---------- 极简 DOM stub ---------- */
function makeEl(id) {
  return {
    id, innerHTML: "", textContent: "", value: "", className: "", style: {}, checked: false,
    type: "text", parentNode: null, children: [],
    appendChild(c) {
      this.children.push(c); c.parentNode = this;
      // 模拟浏览器加载 <script src="_status.js"> 成功：脚本执行后把数据挂到 window
      if (c.tagName === "script") {
        setTimeout(() => { if (typeof c.onload === "function") c.onload(); }, 0);
      }
      return c;
    },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    __handlers: {},
    addEventListener(t, fn) { (this.__handlers[t] = this.__handlers[t] || []).push(fn); },
    removeEventListener() {},
    __fire(t) { (this.__handlers[t] || []).forEach((fn) => fn({ target: this, preventDefault() {} })); },
    querySelectorAll() { return []; }, setAttribute() {}, select() {},
    insertBefore(n, ref) { this.children.unshift(n); n.parentNode = this; return n; },
  };
}
const els = {};
function el(id) { if (!els[id]) els[id] = makeEl(id); return els[id]; }
const head = makeEl("head");
const body = makeEl("body");

global.window = global;
global.document = {
  readyState: "complete",
  head, body,
  // HTML 里已声明的元素在真实 DOM 中一定存在，这里按需创建以免 boot 拿到 null
  getElementById: (id) => els[id] || (els[id] = makeEl(id)),
  createElement: (t) => {
    const e = makeEl("new-" + t);
    e.tagName = t;
    // script 元素：不真的加载，由测试手动触发 onload
    e.setAttribute = (k, v) => { e[k] = v; };
    return e;
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  getElementsByTagName: (t) => (t === "head" ? [head] : [body]),
};
Object.defineProperty(global, "navigator", { value: { clipboard: null }, configurable: true, writable: true });
// boot() 里会读 location.origin 来拼 MCP 地址
Object.defineProperty(global, "location", { value: { origin: "http://127.0.0.1:3425" }, configurable: true, writable: true });

/* ---------- 预置：一次「旧的」MCP 检测成功结果 ---------- */
const OLD_AT = 1000;
window.__memhubStatus = {
  ncb: { at: OLD_AT, op: "ncb_check", ok: true, title: "MCP Key 有效，数据库已就绪",
         lines: ["密钥可用", "目标库存在"] },
};

/* ---------- 加载被测脚本 ---------- */
let lastSet = null;
window.magpie = {
  ready: Promise.resolve({}), theme: null,
  onTheme() {},
  options: {
    get: () => Promise.resolve({ ncb_instance: "memory", mcp_key: "K", memories: [] }),
    set: (o) => { lastSet = o; return Promise.resolve(o); },
  },
  read: () => Promise.resolve({}),
};

await import(path.join(process.cwd(), "src/page/settings.js"));
await new Promise((r) => setTimeout(r, 60));   // 等 boot 跑完

console.log("=== 0. 初始状态：应显示旧的 MCP 检测成功结果 ===");
{
  const box = els["db_action_status"];
  check(!!box && String(box.innerHTML).indexOf("MCP Key 有效") !== -1,
    "初始渲染出了旧的检测结果");
}

console.log("\n=== 1. 复现：点「一键创建数据库」，等待态不能被旧结果覆盖 ===");
{
  const btn = els["btn_db_provision"];
  check(!!btn, "找到「一键创建数据库」按钮");
  // 弹窗 → 确认（直接调确认按钮的 click）
  const confirmBtn = els["btn_confirm_provision"];
  check(!!confirmBtn, "找到确认按钮");

  // 触发：先点主按钮（开弹窗），再点确认（发信标）
  if (btn && btn.__fire) btn.__fire("click");
  if (confirmBtn && confirmBtn.__fire) confirmBtn.__fire("click");
  await new Promise((r) => setTimeout(r, 80));

  const box = els["db_action_status"];
  const html = String(box.innerHTML);
  check(html.indexOf("等待") !== -1 || html.indexOf("剩余") !== -1,
    "确认后立刻进入「等待中」状态");
  check(html.indexOf("MCP Key 有效") === -1,
    "等待态里不再混入上一次的 MCP 检测成功提示（这正是原来交替闪烁的原因）");
  check(String(box.className).indexOf("waiting") !== -1,
    "容器带上了 waiting 样式类");
}

console.log("\n=== 2. 关键断言：轮询期间旧结果不得覆盖等待态 ===");
{
  // 模拟若干次轮询（每次都会 loadStatus，而 _status.js 里仍是那条旧结果）
  for (let i = 0; i < 3; i++) {
    if (typeof window.loadStatus === "function") window.loadStatus();
    await new Promise((r) => setTimeout(r, 30));
    const html = String(els["db_action_status"].innerHTML);
    if (html.indexOf("MCP Key 有效") !== -1) {
      no(`第 ${i + 1} 次轮询后等待态被旧结果覆盖了（bug 复现）`);
      break;
    }
    if (i === 2) ok("连续 3 次轮询后，等待态始终未被旧结果覆盖");
  }
}

console.log("\n=== 3. 反例保护：拿到「更新的」结果时必须能正常显示 ===");
{
  // 伪造一条比提交时间更新的结果
  const newer = Date.now() + 5000;
  window.__memhubStatus = Object.assign({}, window.__memhubStatus, {
    ncb: { at: newer, op: "provision", ok: true, title: "一键创建完成", lines: ["数据库：41694_memory", "新增 3 表 / 4 索引"] },
  });
  if (typeof window.loadStatus === "function") window.loadStatus();
  await new Promise((r) => setTimeout(r, 40));
  const html = String(els["db_action_status"].innerHTML);
  check(html.indexOf("一键创建完成") !== -1,
    "更新的结果能正常渲染（防覆盖逻辑没有把新结果也挡掉）");
}

console.log(fail ? `\n❌ 失败 ${fail} 项` : "\n✅ 状态竞争回归全部通过");
process.exit(fail ? 1 : 0);
