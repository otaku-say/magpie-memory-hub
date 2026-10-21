/**
 * 模块职责：数据库结构的唯一真相源与幂等迁移（薄门面，实现在 src/integration/schema.js）
 * 依赖：./src/integration/schema.js
 * 被依赖：8 个模块 + 测试
 * 契约：versionUpsertSQL 显式写 updated_at: (k, v, updated_at)
 */
export * from "./src/integration/schema.js";
