/**
 * 模块职责：memory_save MCP 工具入口（入参归一化、保存并格式化输出）
 * 依赖：src/tools/args.js, src/services/save/memory-saver.js, src/domain/scoring.js
 * 被依赖：src/index.js
 */

import { normalizeToolArgs } from "./args.js";
import { saveMemory } from "../services/save/memory-saver.js";
import { jsonOut } from "../domain/scoring.js";

export async function memorySave(client, cfg, rawArgs, ctx) {
  const args = normalizeToolArgs(rawArgs, cfg);
  const result = await saveMemory(client, cfg, args, ctx);
  return jsonOut(result);
}
