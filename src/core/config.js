/**
 * 模块职责：统一配置解析、SQL时间戳与常量定义
 * 依赖：src/core/state.js
 * 被依赖：src/core/**, src/domain/**, src/integration/**, src/services/**, src/tools/**, src/index.js
 */

import { lookupSecret, lookupDatabase, lookupRealDatabase } from "./state.js";

export const NCB_BASE = "https://api.nocodebackend.com";

export const CATEGORIES = ["principle", "preference", "fact", "context", "entity", "decision", "insight"];
export const SCOPES = ["user", "project", "session", "turn"];
export const SEVERITIES = ["low", "medium", "high", "critical"];
export const FETCH_LIMIT = 200;

/** 按作用域给过期时间：session 7 天、turn 1 天，其余（project/user）永不过期。 */
export function expiresAtFor(scope) {
  var days = scope === "turn" ? 1 : (scope === "session" ? 7 : 0);
  if (!days) return null;
  var d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** 统一的 SQL 时间戳字符串（NCB 不生效 DEFAULT CURRENT_TIMESTAMP，必须显式写）。 */
export function nowSql() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function readOptions(options) {
  const o = options && typeof options === "object" ? options : {};
  const rawInst = o.ncb_instance || lookupDatabase() || "41694_agent_memory";
  const instance = lookupRealDatabase(rawInst) || rawInst;
  return {
    // 宿主权威目录（由 input.directory / ctx.directory / settings.Dir() 透传）
    hostDirectory: o.hostDirectory || o.host_directory || o.directory || "",
    // 库名：优先按用户填的并归一化解析；没填就用上次 provision 真正用到的那个
    instance,
    // Secret Key：用户在设置页填的优先；
    // 若库是本插件创建的，创建时已自动取得并保存在本地状态里，这里直接取用，
    // 于是**用户只需要填 MCP key**。
    secret: o.ncb_secret || lookupSecret(instance) || lookupSecret(rawInst) || "",
    // MCP key：仅用于建表/清库/schema/R2。数据库 Secret Key 只能读写数据。
    mcpKey: o.mcp_key || "",
    // 宿主每次加载时自愈（结构缺失就补）。默认关：避免给工具枚举引入网络等待。
    autoInit: o.auto_init === true,
    // 宿主每次加载时自动增量扫描网关录制的对话落盘。默认关：避免涉及用户隐私与启动延迟。
    autoHarvest: o.auto_harvest === true,
    gatewayConvDir: o.gateway_conv_dir || process.env.MEMHUB_GATEWAY_CONV_DIR || "",
    // R2 凭据：由设置页的「保存 R2 设置」按钮写入。
    // 挂载时会**显式传给 NCB**，否则它会用账号里缓存的旧连接（密钥轮换后必然失败）。
    r2AccountId: o.r2_account_id || "",
    r2AccessKeyId: o.r2_access_key_id || "",
    r2SecretAccessKey: o.r2_secret_access_key || "",
    r2BucketName: o.r2_bucket_name || "",
    r2PublicUrl: o.r2_public_url || "",
    minConfidence: Number(o.min_confidence) || 0.6,
    maxInject: Number(o.max_inject_count) || 5,
    maxBudget: Number(o.max_budget_chars) || 2048,
    // 在线模型配置（设置页自由指定，默认留空安全跳过；audit_model 同时服务去重与检索重排）
    extract_model: o.extract_model || o.harvest_model || "",
    classify_model: o.classify_model || "",
    audit_model: o.audit_model || o.rerank_model || "",
    dedup_schedule: o.dedup_schedule || o.audit_interval || o.auditInterval || "off",
    dedup_time: o.dedup_time || "02:00",
    dedup_weekday: Number(o.dedup_weekday) || 1,
    dedup_day: Number(o.dedup_day) || 1,
    dedup_batch_size: Math.max(20, Math.min(Number(o.dedup_batch_size || 50), 1000)),
    dedup_fetch_limit: Math.max(20, Math.min(Number((o.dedup_batch_size && Number(o.dedup_batch_size) !== 50 ? o.dedup_batch_size : (o.dedup_fetch_limit || o.dedup_batch_size || 200))), 1000)),
    project: String(o.project || "global").trim(),
    audit_chunk_size: Number(o.audit_chunk_size) > 0 ? Number(o.audit_chunk_size) : 40,
    audit_max_batches: Number(o.audit_max_batches) > 0 ? Number(o.audit_max_batches) : 1,
    rerank_model: o.rerank_model || "",
    classify_endpoint: o.classify_endpoint || "auto",
    model_timeout_sec: (Number.isFinite(Number(o.model_timeout_sec)) && Number(o.model_timeout_sec) > 0)
      ? Math.max(5, Math.min(120, Math.floor(Number(o.model_timeout_sec))))
      : 30,
    /* v6.48.0 修复：两者都未显式传入时，rerank 应回落到声明默认 15s，而不是继承
     * model_timeout_sec 的 30s 默认值（那时 safeTimeoutMs 的 15000 兜底永远走不到）。
     * 只有用户显式给了 model_timeout_sec 才允许继承它。 */
    rerank_timeout_sec: (Number.isFinite(Number(o.rerank_timeout_sec)) && Number(o.rerank_timeout_sec) > 0)
      ? Math.max(3, Math.min(60, Math.floor(Number(o.rerank_timeout_sec))))
      : ((Number.isFinite(Number(o.model_timeout_sec)) && Number(o.model_timeout_sec) > 0) ? undefined : 15),
    rerank_max_candidates: (Number.isFinite(Number(o.rerank_max_candidates)) && Number(o.rerank_max_candidates) > 0)
      ? Math.max(3, Math.min(25, Math.floor(Number(o.rerank_max_candidates))))
      : 10,
    search_rewrite: o.search_rewrite !== false,
    search_rerank: o.search_rerank !== false,
    // 检索可解释性调试开关（设置页「检索可解释性追踪」勾选即落盘）：
    // 开启后 memory_search / pitfall_search 即使不显式传 explain 也会返回 score_details + timings。
    // 严格只认真布尔 true，避免字符串 "false" 之类的真值漂移。
    explain_debug: o.explain_debug === true,
    gateway_url: o.gateway_url || o.api_base_url || process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425",
    gateway_api_key: o.gateway_api_key || o.api_key || process.env.MAGPIE_API_KEY || "",
    // v6.20.0 调用预算与熔断（可配置，保守默认；见 model_budget.js）
    harvest_max_per_min: Number(o.harvest_max_per_min ?? o.model_max_per_min) > 0 ? Math.floor(Number(o.harvest_max_per_min ?? o.model_max_per_min)) : 20,
    harvest_max_total: Number(o.harvest_max_total ?? o.model_max_total) > 0 ? Math.floor(Number(o.harvest_max_total ?? o.model_max_total)) : 2000,
    // EVO-4: 高频经验结晶与踩坑复发阈值（可配置，保守默认）
    crystallization_threshold: Number(o.crystallization_threshold ?? o.crystallizationThreshold) > 0
      ? Math.floor(Number(o.crystallization_threshold ?? o.crystallizationThreshold))
      : 5,
    pitfall_recurrence_threshold: Number(o.pitfall_recurrence_threshold ?? o.pitfallRecurrenceThreshold) > 0
      ? Math.floor(Number(o.pitfall_recurrence_threshold ?? o.pitfallRecurrenceThreshold))
      : 3,
    _fetch: o._fetch,
  };
}

/** FNV-1a 双轮 64bit → 32 位十六进制指纹（同步、确定性） */
