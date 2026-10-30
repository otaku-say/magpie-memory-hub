/**
 * 模块职责：从自由文本推测环境作用域（存量回填用）
 * 依赖：无（纯函数）
 * 被依赖：memory-cli.js（audit-env 子命令）
 *
 * 设计原则：**宁可不给建议，也不给错的建议**。
 * 存量回填是改真实数据，误标的代价比漏标大得多：一条通用事实被标成
 * os=windows 之后，它在其他环境就永远召不回来了，而且没人会去发现。
 * 所以：
 *   1. 只在单一平台族命中时给建议；同时提到多个平台 → 判定为“对比描述”，跳过；
 *   2. 默认只出报告，落库必须显式 --apply；
 *   3. 不推测客户端/主机名这类无法从文本判断的维度。
 */

var OS_SIGNALS = {
  windows: [/\u6ce8\u518c\u8868/, /powershell/i, /\bwin32\b/i, /\bwindows\b/i, /\bwin11\b/i, /\bwin10\b/i, /\bcmd\.exe\b/i, /\bIIS\b/],
  linux: [/\blinux\b/i, /\bsystemd\b/i, /\bsystemctl\b/, /\bapt-get\b/i, /\bapt install\b/i, /\byum install\b/i, /\bapk add\b/i, /\/etc\//, /\bsysctl\b/, /\bubuntu\b/i, /\bdebian\b/i, /\bcentos\b/i, /\balpine\b/i],
  macos: [/\bmacos\b/i, /\bmac os\b/i, /\bdarwin\b/i, /\bhomebrew\b/i, /\bbrew install\b/i, /\/Library\//]
};

var ARCH_SIGNALS = {
  arm64: [/\barm64\b/i, /\baarch64\b/i, /\bapple silicon\b/i],
  amd64: [/\bamd64\b/i, /\bx86_64\b/i, /\bx64\b/i]
};

function familiesHit(signals, text) {
  var hits = {};
  var names = Object.keys(signals);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var res = signals[name];
    for (var j = 0; j < res.length; j++) {
      if (res[j].test(text)) {
        hits[name] = 1;
        break;
      }
    }
  }
  return Object.keys(hits);
}

/**
 * @returns {{ scope: string, os: string[], arch: string[], ambiguous: boolean, reason: string }}
 */
function suggestEnvScope(text) {
  var src = String(text == null ? "" : text);
  var os = familiesHit(OS_SIGNALS, src);
  var arch = familiesHit(ARCH_SIGNALS, src);

  if (os.length > 1) {
    return { scope: "", os: os, arch: arch, ambiguous: true, reason: "同时提到多个平台，属于对比描述" };
  }
  if (arch.length > 1) {
    return { scope: "", os: os, arch: arch, ambiguous: true, reason: "同时提到多种架构，属于对比描述" };
  }

  var parts = [];
  var matched = [];
  if (os.length === 1) { parts.push("os=" + os[0]); matched.push(os[0]); }
  if (arch.length === 1) { parts.push("arch=" + arch[0]); matched.push(arch[0]); }

  return {
    scope: parts.join(","),
    os: os,
    arch: arch,
    ambiguous: false,
    reason: parts.length ? "单一环境信号：" + matched.join("+") : "无环境信号"
  };
}

export { OS_SIGNALS, ARCH_SIGNALS, suggestEnvScope };
