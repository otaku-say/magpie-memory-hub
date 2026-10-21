/**
 * 模块职责：工具入参零摩擦容错归一化（同义字段映射、数组字符串互转与 project 继承）
 * 依赖：无
 * 被依赖：src/tools/**, src/index.js
 */

export function normalizeToolArgs(rawArgs, cfg) {
  if (!rawArgs || typeof rawArgs !== "object") rawArgs = {};
  const args = Object.assign({}, rawArgs);

  // 1. 同义参数映射（仅在目标字段缺省或为空时映射，绝不覆盖已有正确入参）
  // q / keyword / query → query
  if (args.query == null || args.query === "") {
    if (args.keyword != null && args.keyword !== "") args.query = args.keyword;
    else if (args.q != null && args.q !== "") args.query = args.q;
  }
  // error / issue → symptom
  if (args.symptom == null || args.symptom === "") {
    if (args.error != null && args.error !== "") args.symptom = args.error;
    else if (args.issue != null && args.issue !== "") args.symptom = args.issue;
  }
  // fix / resolve → solution
  if (args.solution == null || args.solution === "") {
    if (args.fix != null && args.fix !== "") args.solution = args.fix;
    else if (args.resolve != null && args.resolve !== "") args.solution = args.resolve;
  }
  // name / topic → title
  if (args.title == null || args.title === "") {
    if (args.name != null && args.name !== "") args.title = args.name;
    else if (args.topic != null && args.topic !== "") args.title = args.topic;
  }
  // text / body → content
  if (args.content == null || args.content === "") {
    if (args.text != null && args.text !== "") args.content = args.text;
    else if (args.body != null && args.body !== "") args.content = args.body;
  }
  // cause / reason → root_cause (BUG-37-4b)
  if (args.root_cause == null || args.root_cause === "") {
    if (args.cause != null && args.cause !== "") args.root_cause = args.cause;
    else if (args.reason != null && args.reason !== "") args.root_cause = args.reason;
  }

  // 2. tags / related_entities 容错：若为数组则 join(",")；若为字符串保持
  if (Array.isArray(args.tags)) {
    args.tags = args.tags.join(",");
  }
  if (Array.isArray(args.related_entities)) {
    args.related_entities = args.related_entities.join(",");
  }

  // 3. args.project 缺省或为空时，继承 cfg.project（仅当 cfg.project 非 "global" 时继承，否则用 "global"）
  const curProj = args.project != null ? String(args.project).trim() : "";
  if (!curProj) {
    const cfgProj = cfg && cfg.project ? String(cfg.project).trim() : "";
    if (cfgProj && cfgProj !== "global") {
      args.project = cfgProj;
    } else {
      args.project = "global";
    }
  }

  return args;
}

/* ================================================================== *
 * 工具实现
 * ================================================================== */
