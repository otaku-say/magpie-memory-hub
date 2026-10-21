/**
 * 模块职责: 网关请求钩子薄门面 (向后兼容导出 onRequest, onResponse 及提炼辅助函数)
 * 依赖: ./src/services/harvest/index.js, ./scrub.js
 * 被依赖: package.json (magpie.hooks), tools.js, page_actions.js, tests
 */
/* schema contract: superseded_by_id: null */
export * from "./src/services/harvest/index.js";
export { scrubSecrets } from "./scrub.js";
