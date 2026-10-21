/**
 * 模块职责：网关中间件主体骨架，串联 onRequest、onEvent、onResponse 管道钩子
 * 依赖：./request-inject.js, ./event-stream.js, ./response-hook.js
 * 被依赖：根目录 memory.middleware.js 门面
 * 零拷贝快路径宿主判定准则：typeof ctx.report === "function"
 */

export { onRequest } from "./request-inject.js";
export { onEvent } from "./event-stream.js";
export { onResponse } from "./response-hook.js";
