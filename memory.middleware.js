/**
 * 模块职责：网关中间件根目录薄门面
 * 依赖：./src/middleware/memory.middleware.js
 * 被依赖：宿主网关、各单元测试
 * 零拷贝快路径宿主判定准则：typeof ctx.report === "function"
 */

export { onRequest, onEvent, onResponse } from "./src/middleware/memory.middleware.js";
