import path from "node:path";
/**
 * 模块职责：运行环境检测工具（从 offline-scan.js 下沉，解除循环依赖）
 * 依赖：无
 * 被依赖：src/services/audit/scheduler.js, src/services/harvest/offline-scan.js
 */
export function isTestMode() {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.MAGPIE_TEST === "1" ||
    process.env.MEMHUB_TEST === "1"
  ) {
    return true;
  }
  if (typeof process !== "undefined" && Array.isArray(process.argv)) {
    return process.argv.some((arg) => {
      if (typeof arg !== "string") return false;
      const base = path.basename(arg);
      // 1) 匹配测试脚本文件名规则：以 test_ 开头或 .test.mjs / .test.js 结尾
      if (/^test_.*\.mjs$/i.test(base) || /\.test\.(?:mjs|js)$/i.test(base)) {
        return true;
      }
      // 2) 仅当以 .mjs 结尾且父目录名精确等于 "tests"
      if (arg.endsWith(".mjs")) {
        try {
          const resolved = path.resolve(arg);
          if (path.basename(path.dirname(resolved)) === "tests") {
            return true;
          }
        } catch (_) {}
      }
      return false;
    });
  }
  return false;
}
