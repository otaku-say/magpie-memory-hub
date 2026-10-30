#!/usr/bin/env node
/**
 * 模块职责：零工具记忆通道 CLI（不依赖 MCP 的 save / pitfall / search / context / doctor）
 * 依赖：./tools.js（宿主门面）
 * 被接入：package.json files；由 opts.cli_channel 指向的命令字符串调用
 *
 * 为什么需要它（mem0 的实证）：把「记忆可用性」绑在「工具可用性」上，就是把可用性
 * 绑在一个随时会缺席的前提上。任何 agent 都有 bash；MCP 只能是加速通道。
 * 于是无 MCP 的客户端（ishellpro 等）不应该只能「不幻觉」，而应该真能读写记忆。
 *
 * 用法：
 *   node memory-cli.js save --title "..." --content "..." [--project p] [--category fact] [--env-scope os=windows] [--tags a,b]
 *   node memory-cli.js pitfall --symptom "..." --solution "..." [--project p] [--component x] [--env-scope ...]
 *   node memory-cli.js search --query "..." [--project p] [--limit 5]
 *   node memory-cli.js context --query "..." [--project p]
 *   node memory-cli.js doctor
 *
 * 环境变量（可选，缺省走插件本地状态里的库与会话凭据）：
 *   MEMHUB_NCB_INSTANCE / MEMHUB_NCB_SECRET / MEMHUB_MCP_KEY / MEMHUB_PROJECT
 *
 * 退出码：0 成功；1 参数或执行失败；2 配置不可用。
 */
import { MagpieMemoryHub } from "./tools.js";
import { readOptions } from "./src/core/config.js";
import { makeClient, fetchAll } from "./src/integration/ncb.js";
import { suggestEnvScope } from "./src/domain/env-hints.js";
import { envScopeOf } from "./src/domain/env-scope.js";

const VALUE_FLAGS = new Set([
  "project", "category", "env-scope", "env_scope", "tags", "title", "content",
  "symptom", "solution", "component", "root-cause", "root_cause", "query",
  "limit", "severity", "client", "scope-level", "scope_level", "table"
]);
const BOOL_FLAGS = new Set(["help", "json", "apply", "dry-run"]);

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.slice(0, 2) !== "--") { out._.push(a); continue; }
    const key = a.slice(2);
    if (key.indexOf("=") !== -1) {
      const eq = key.indexOf("=");
      out[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    if (BOOL_FLAGS.has(key)) { out[key] = true; continue; }
    if (VALUE_FLAGS.has(key)) {
      const v = argv[i + 1];
      if (v === undefined || v.slice(0, 2) === "--") { out[key] = ""; continue; }
      out[key] = v;
      i++;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function camel(o, from, to) {
  if (o[from] != null && o[to] == null) o[to] = o[from];
  return o;
}

function fail(msg, code) {
  process.stderr.write(String(msg) + "\n");
  process.exit(code || 1);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const HELP = `magpie-memory-hub memory-cli —— 零工具记忆通道

  save     --title <标题> --content <正文> [--project p] [--category fact] [--env-scope os=windows] [--tags a,b]
  pitfall  --symptom <现象> --solution <解法> [--project p] [--component x] [--env-scope ...]
  search   --query <关键词> [--project p] [--limit 5]
  context  --query <关键词> [--project p]
  doctor   打印当前配置来源（不输出任何密钥）
  audit-env  存量环境作用域审计：扫描 env_scope 为空的记录并给出建议
             [--apply 落库 | --limit N | --table memories|pitfalls|both]

退出码：0 成功 / 1 执行失败 / 2 配置不可用
`;

/**
 * 存量回填审计。默认只出报告（dry-run），--apply 才真正改库。
 * 为什么默认不写：这是改用户真实数据。误标的代价比漏标大——
 * 一条通用事实被标成 os=windows 后，它在其他环境就永远召不回来了。
 */
async function auditEnv(input, argv) {
  const cfg = readOptions(input);
  const client = makeClient(cfg);
  const tableArg = String(argv.table || "both").toLowerCase();
  const tables = tableArg === "memories" ? ["memories"] : (tableArg === "pitfalls" ? ["pitfalls"] : ["memories", "pitfalls"]);
  const limit = Math.max(1, Math.min(Number(argv.limit) || 500, 2000));
  const apply = argv.apply === true && argv["dry-run"] !== true;
  const project = argv.project || input.project || "";

  const report = { ok: true, apply: apply, project: project || "(all)", scanned: 0, candidates: [], ambiguous: [], applied: 0, failed: [] };
  for (const table of tables) {
    const params = { lifecycle_status: "active", order_by: "updated_at DESC" };
    if (project) params.project = project;
    let rows = [];
    try { rows = await fetchAll(client, table, params); } catch (e) { report.failed.push({ table: table, error: String((e && e.message) || e) }); continue; }
    if (rows.length > limit) rows = rows.slice(0, limit);
    for (const row of rows) {
      if (!row) continue;
      report.scanned++;
      if (envScopeOf(row)) continue;   // 已有作用域的不动
      const text = [row.title, row.content, row.symptom, row.root_cause, row.solution, row.tags].filter(Boolean).join(" \n ");
      const hint = suggestEnvScope(text);
      if (hint.ambiguous) { report.ambiguous.push({ table: table, id: row.id, reason: hint.reason }); continue; }
      if (!hint.scope) continue;
      const item = { table: table, id: row.id, title: String(row.title || row.symptom || "").slice(0, 60), suggested: hint.scope, reason: hint.reason };
      report.candidates.push(item);
      if (apply) {
        try {
          await client.update(table, row.id, { env_scope: hint.scope });
          report.applied++;
        } catch (e) {
          report.failed.push({ table: table, id: row.id, error: String((e && e.message) || e) });
        }
      }
    }
  }
  return report;
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const cmd = String(argv._[0] || "help").toLowerCase();
  if (cmd === "help" || cmd === "--help" || argv.help) {
    process.stdout.write(HELP);
    return;
  }

  const input = {};
  if (process.env.MEMHUB_NCB_INSTANCE) input.ncb_instance = process.env.MEMHUB_NCB_INSTANCE;
  if (process.env.MEMHUB_NCB_SECRET) input.ncb_secret = process.env.MEMHUB_NCB_SECRET;
  if (process.env.MEMHUB_MCP_KEY) input.mcp_key = process.env.MEMHUB_MCP_KEY;
  if (process.env.MEMHUB_PROJECT) input.project = process.env.MEMHUB_PROJECT;

  /* audit-env 不需要 MCP 工具树，直接用底层 client，也避免建 hub 的副作用 */
  if (cmd === "audit-env" || cmd === "audit_env") {
    try { emit(await auditEnv(input, argv)); } catch (e) { fail('[memory-cli] audit-env 失败：' + String((e && e.message) || e), 1); }
    return;
  }

  let hub;
  try {
    hub = await MagpieMemoryHub(input, { _no_scheduler: true });
  } catch (e) {
    fail("[memory-cli] 初始化失败：" + String((e && e.message) || e), 2);
  }
  const tools = (hub && hub.tool) || {};

  const project = argv.project || input.project || "global";

  if (cmd === "doctor") {
    emit({
      ok: true,
      tools: Object.keys(tools).length,
      project,
      ncb_instance: input.ncb_instance || "(from plugin state)",
      has_secret: !!(input.ncb_secret || process.env.MEMHUB_NCB_SECRET) || "see plugin state",
      node: process.version,
    });
    return;
  }

  if (cmd === "save") {
    if (!tools.memory_save) fail("[memory-cli] memory_save 不可用", 2);
    if (!argv.title || !argv.content) fail("[memory-cli] save 需要 --title 与 --content", 1);
    const args = { project, title: argv.title, content: argv.content };
    if (argv.category) args.category = argv.category;
    if (argv.tags) args.tags = argv.tags;
    camel(argv, "env-scope", "env_scope");
    if (argv.env_scope) args.env_scope = argv.env_scope;
    camel(argv, "scope-level", "scope_level");
    if (argv.scope_level) args.scope_level = argv.scope_level;
    if (argv.client) args.client = argv.client;
    emit(JSON.parse(await tools.memory_save.execute(args, {})));
    return;
  }

  if (cmd === "pitfall") {
    if (!tools.pitfall_save) fail("[memory-cli] pitfall_save 不可用", 2);
    if (!argv.symptom || !argv.solution) fail("[memory-cli] pitfall 需要 --symptom 与 --solution", 1);
    const args = { project, symptom: argv.symptom, solution: argv.solution };
    if (argv.component) args.component = argv.component;
    if (argv.severity) args.severity = argv.severity;
    camel(argv, "root-cause", "root_cause");
    if (argv.root_cause) args.root_cause = argv.root_cause;
    camel(argv, "env-scope", "env_scope");
    if (argv.env_scope) args.env_scope = argv.env_scope;
    emit(JSON.parse(await tools.pitfall_save.execute(args, {})));
    return;
  }

  if (cmd === "search") {
    if (!tools.memory_search) fail("[memory-cli] memory_search 不可用", 2);
    if (!argv.query) fail("[memory-cli] search 需要 --query", 1);
    const limit = Math.max(1, Math.min(Number(argv.limit) || 5, 20));
    emit(JSON.parse(await tools.memory_search.execute({ project, query: argv.query, limit }, {})));
    return;
  }

  if (cmd === "context") {
    if (!tools.memory_context) fail("[memory-cli] memory_context 不可用", 2);
    if (!argv.query) fail("[memory-cli] context 需要 --query", 1);
    emit(JSON.parse(await tools.memory_context.execute({ project, query: argv.query }, {})));
    return;
  }

  fail("[memory-cli] 未知子命令：" + cmd + "\n" + HELP, 1);
}

main().catch((e) => fail("[memory-cli] 异常：" + String((e && e.message) || e), 1));
