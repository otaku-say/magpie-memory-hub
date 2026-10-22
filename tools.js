/**
 * 模块职责：Magpie 插件 MCP 工具层薄门面（仅保留主插件入口与白名单辅助导出）
 * 依赖：src/index.js, src/integration/ncb.js, src/domain/scoring.js, src/core/time.js, src/services/audit/**
 * 被依赖：Magpie 插件宿主网关、84套测试套件
 * // 2 次模型调用 × 15s = 30s < 55s（MCP 客户端硬超时），安全余量 25s。
 * // import { scrubSecrets } from "./src/core/sanitize.js";
 */

export { MagpieMemoryHub } from "./src/index.js";
export { makeClient, fetchAll } from "./src/integration/ncb.js";
export { termsOf, CJK_STOP_BIGRAMS } from "./src/domain/scoring.js";
export { getDedupTimeWindow, isDedupDue } from "./src/core/time.js";
export { memoryAuditUndo } from "./src/services/audit/undo.js";
export { memoryAudit } from "./src/services/audit/auditor.js";
