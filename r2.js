/**
 * r2.js —— Cloudflare R2 文件存储（经 NoCodeBackend MCP 代管）。
 *
 * 实测确认的能力边界（2026-10-16）：
 *   可用：
 *     setup_r2_storage —— 自动创建 bucket 并配置 CORS。
 *       账号若已有 Cloudflare 连接会**自动复用凭据**（实测返回 reused_existing_connection:true），
 *       此时无需任何 Cloudflare 参数；否则需要提供 account_id / access_key_id / secret_access_key。
 *     upload_file      —— 带 fileData 直接上传并返回公开 URL；不带则返回 presigned 上传 URL。
 *   MCP 侧不可用、但【Secret Key 的 REST 侧可用】（实测 2026-10-16）：
 *     · 列举桶内对象   GET    /files?Instance=...
 *     · 删除对象       DELETE /files/{key}?Instance=...
 *     · 上传（multipart）POST /upload?Instance=...  —— 比 MCP 的 base64 上传更省，二进制尤其明显
 *   仍然做不到的：
 *     · 服务端生成**下载**用的 presigned URL（下载只能靠 bucket 的公开域名）
 *     · 读取底层 Cloudflare 凭据（NCB 不暴露，只存在平台控制面）
 */
import { NcbMcp } from "./ncb_mcp.js";

function clientOf(cfg) {
  const key = (cfg && (cfg.mcpKey || cfg.mcp_key)) || "";
  if (!key) {
    const err = new Error(
      "未配置 MCP key。R2 存储的创建与上传都走 NoCodeBackend 的 MCP，" +
      "需要在设置页填写 MCP key。"
    );
    err.code = "NO_MCP_KEY";
    throw err;
  }
  return new NcbMcp({ apiKey: key });
}

/** 从各种命名里取数据库名（readOptions 产出的是 instance）。 */
function dbOf(cfg, args) {
  const db = (args && args.database) || (cfg && (cfg.instance || cfg.ncb_instance)) || "";
  if (!db) {
    const err = new Error("未指定数据库名（请在设置页填 ncb_instance）");
    err.code = "NO_DATABASE";
    throw err;
  }
  return db;
}

const REST_BASE = "https://api.nocodebackend.com";

/** NoCodeBackend 的 REST 客户端（用数据库 Secret Key 认证）。 */
function restClient(cfg) {
  const secret = (cfg && (cfg.secret || cfg.ncb_secret)) || "";
  const instance = (cfg && (cfg.instance || cfg.ncb_instance)) || "";
  if (!secret) {
    const err = new Error(
      "未配置数据库 Secret Key。R2 的「列举/删除/上传」走 NoCodeBackend 的 REST，" +
      "需要 Secret Key；只有「创建 bucket」需要 MCP key。"
    );
    err.code = "NO_SECRET";
    throw err;
  }
  if (!instance) {
    const err = new Error("未指定数据库名");
    err.code = "NO_DATABASE";
    throw err;
  }
  return { secret, instance };
}

/** 发一次 REST 请求；返回 { status, body }。 */
async function rest(cfg, method, path, opts) {
  const { secret, instance } = restClient(cfg);
  const o = opts || {};
  const url = REST_BASE + path + "?Instance=" + encodeURIComponent(instance);
  const headers = { Authorization: "Bearer " + secret };
  let payload;
  if (o.json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(o.json);
  } else if (o.form !== undefined) {
    payload = o.form;                       // FormData：让 fetch 自己设 boundary
  }
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeout || 60000) : null;
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: ctrl ? ctrl.signal : undefined });
  } catch (e) {
    if (timer) clearTimeout(timer);
    throw new Error("连接 NoCodeBackend 失败：" + String(e && e.message || e));
  }
  if (timer) clearTimeout(timer);
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body };
}

/**
 * 列出该库 R2 桶内的对象。
 * 注意：这条能力在 Secret Key 的 REST 上，MCP 的 23 个工具里没有。
 */
export async function r2List(cfg, args) {
  const { status, body } = await rest(cfg, "GET", "/files", {});
  if (status >= 400) {
    return { ok: false, error: `HTTP ${status}`, body };
  }
  const files = (body && body.files) || [];
  return {
    ok: true,
    count: files.length,
    files: files.slice(0, (args && args.limit) || 100),
    truncated: files.length > ((args && args.limit) || 100),
  };
}

/**
 * 删除桶内一个对象。key 就是上传时返回的 key（不是完整 URL）。
 * 这是破坏性操作，需要显式传 confirm="DELETE"。
 */
export async function r2Delete(cfg, args) {
  const key = args && (args.key || args.filename);
  if (!key) throw new Error("缺少 key（上传时返回的那个 key，不是完整 URL）");
  if ((args && args.confirm) !== "DELETE") {
    return {
      ok: false, action: "CONFIRM_REQUIRED", key,
      warning: '删除不可恢复。确认请再次调用并传 confirm="DELETE"。',
    };
  }
  const { status, body } = await rest(cfg, "DELETE", "/files/" + encodeURIComponent(key), {});
  return {
    ok: status < 400 && !(body && body.status === "failed"),
    key, http: status, result: body,
  };
}

/**
 * 为数据库配置 R2：自动建 bucket + 配 CORS。
 * 所有 Cloudflare 参数都是可选的 —— 账号已有连接时 NCB 会自动复用。
 */
export async function r2Setup(cfg, args) {
  const db = dbOf(cfg, args);
  const mcp = clientOf(cfg);
  const extra = {};
  for (const k of ["bucket_name", "public_url", "account_id", "access_key_id", "secret_access_key"]) {
    const v = (args && args[k]);
    if (v !== undefined && v !== null && String(v).trim() !== "") extra[k] = String(v).trim();
  }

  const out = await mcp.setupR2Storage(db, extra);
  const ok = !(out && out.ok === false);
  return {
    ok,
    database: db,
    bucket_name: (out && out.bucket_name) || extra.bucket_name || "",
    public_url: (out && out.public_url) || extra.public_url || "",
    reused_connection: !!(out && out.reused_existing_connection),
    bucket_created: !!(out && out.bucket_created),
    cors_configured: !!(out && out.cors_configured),
    result: out,
    note: ok
      ? "R2 已挂到该数据库。用 storage_upload 上传文件即可拿到公开 URL。"
      : "R2 配置未成功，详见 result。若账号尚未连接 Cloudflare，请填写 account_id / access_key_id / secret_access_key。",
  };
}

/**
 * 上传文件。
 *   · 给了 content → 直接上传（文本默认 UTF-8；二进制请给 base64 并设 encoding=base64）
 *   · 不给 content → 返回 presigned 上传 URL，供大文件由客户端直传
 */
export async function r2Upload(cfg, args) {
  const db = dbOf(cfg, args);
  const filename = args && args.filename;
  if (!filename) {
    const err = new Error("缺少 filename");
    err.code = "NO_FILENAME";
    throw err;
  }

  const hasContent = args && args.content != null;
  const hasSecret = !!((cfg && (cfg.secret || cfg.ncb_secret)) || "");

  // 有内容 + 有 Secret Key → 走 REST multipart（二进制不用 base64，省 33% 且更快）
  if (hasContent && hasSecret) {
    const isText = args.encoding !== "base64";
    let bytes;
    if (isText) {
      bytes = new TextEncoder().encode(String(args.content));
    } else {
      bytes = Uint8Array.from(atob(String(args.content)), (c) => c.charCodeAt(0));
    }
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: args.content_type || "application/octet-stream" }), filename);
    const { status, body } = await rest(cfg, "POST", "/upload", { form });
    const url = (body && body.url) || "";
    return {
      ok: status < 400 && !!url,
      database: db, filename, url, via: "rest-multipart", http: status, result: body,
      note: url
        ? "上传完成。建议用 memory_save 把 url 存成 category=file 的记忆，日后可检索回该文件。"
        : "上传失败，详见 result。",
    };
  }

  // 否则走 MCP（base64 直传，或返回 presigned 上传 URL）
  const mcp = clientOf(cfg);
  let data;
  if (hasContent) {
    data = args.encoding === "base64" ? String(args.content) : utf8ToBase64(String(args.content));
  }
  const out = await mcp.uploadFile(db, filename, data, args && args.content_type);
  const url = (out && (out.url || out.publicUrl)) || "";
  return {
    ok: !(out && out.ok === false),
    database: db, filename, url,
    presigned_upload_url: !data ? (out && out.uploadUrl) : undefined,
    via: "mcp", result: out,
    note: data
      ? "上传完成。建议用 memory_save 把 url 存成 category=file 的记忆。"
      : "已生成 presigned 上传 URL：客户端 PUT 二进制到该 URL，再把 publicUrl 存进记忆。",
  };
}

/** 把 R2 的可用与不可用能力讲清楚，避免 agent 去用不存在的接口。 */
export function r2Guide() {
  return {
    ok: true,
    endpoint: "Cloudflare R2（由 NoCodeBackend 代管，S3 兼容，零出网费）",
    capabilities: {
      setup: "r2_setup —— 为当前数据库创建 bucket 并配置 CORS；账号已有 Cloudflare 连接时自动复用凭据",
      upload_inline: "r2_upload（带 content）—— 小文件直接上传，返回公开 URL",
      upload_presigned: "r2_upload（不带 content）—— 大文件走 presigned URL 由客户端直传",
      upload_rest: "r2_upload —— 文本/二进制都可；有 Secret Key 时走 REST multipart，更省",
      list: "r2_list —— 列出桶内对象（走 Secret Key 的 REST；MCP 没有这个接口）",
      delete: "r2_delete —— 删除对象，需 confirm=\"DELETE\"（走 Secret Key 的 REST）",
      read: "拿到 url 后直接 GET（bucket 需开启公开访问或绑定自定义域名）",
    },
    // 这些确实做不到，如实列出
    not_available: [
      "服务端生成**下载**用的 presigned URL（下载只能靠 bucket 的公开域名）",
      "读取底层 Cloudflare 凭据（NCB 不暴露，只存在平台控制面）",
    ],
    credential_split:
      "创建 bucket 需要 MCP key；上传/列举/删除需要数据库 Secret Key（REST）。" +
      "若数据库由本插件创建，Secret Key 会随创建自动取得并保存，无需手填。",
    workflow:
      "r2_upload 拿到 url → memory_save 把 url 与说明存成一条 category=file 的记忆 → " +
      "之后用 memory_search 就能找回这个文件。",
  };
}

/* Bun/Node 都有 Buffer；无 Buffer 时退回浏览器式实现。 */
function utf8ToBase64(s) {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  const bytes = unescape(encodeURIComponent(s));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes.charCodeAt(i));
  return btoa(bin);
}
