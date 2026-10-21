/**
 * 模块职责：设置页信标状态写入器（从 page/actions.js 下沉，解除循环依赖）
 * 依赖：node:fs, node:path, node:url
 * 被依赖：src/services/audit/auditor.js, src/services/audit/undo.js, src/services/harvest/offline-scan.js, src/page/actions.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupRealDatabase } from "../../local_state.js";

const STATUS_JS_PATH = fileURLToPath(new URL("../../_status.js", import.meta.url));
const STATUS_JSON_PATH = fileURLToPath(new URL("../../_status.json", import.meta.url));

export function writeCardStatus(key, payloadOrResult, opHint, customStatusPath) {
  if (key !== "ncb" && key !== "r2" && key !== "model" && key !== "gateway" && key !== "db" && key !== "audit" && key !== "inject") {
    console.error(`[memory-hub] writeCardStatus: invalid key "${key}", must be "ncb", "r2", "model", "gateway", "audit", "db" or "inject"`);
    return false;
  }

  let tmpJsonPath = null;
  let tmpJsPath = null;

  try {
    const rawPath = typeof customStatusPath === "string" ? customStatusPath : (typeof customStatusPath === "object" && customStatusPath ? (customStatusPath.jsPath || customStatusPath.path || "") : "");
    const jsPath = rawPath || STATUS_JS_PATH;
    const jsonPath = jsPath.replace(/\.js$/, ".json");
    const nonce = process.pid + "." + Date.now() + "." + Math.random().toString(36).slice(2, 8);
    tmpJsonPath = jsonPath + ".tmp." + nonce;
    tmpJsPath = jsPath + ".tmp." + nonce;

    // 1. 读回现有内容（优先从真相源 _status.json 读，退避时解析 _status.js）
    let current = {};
    if (fs.existsSync(jsonPath)) {
      try {
        current = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      } catch (_) {
        current = {};
      }
    } else if (fs.existsSync(jsPath)) {
      try {
        const text = fs.readFileSync(jsPath, "utf8");
        const m = text.match(/window\.__memhubStatus\s*=\s*(\{[\s\S]*\});?\s*$/);
        if (m) {
          current = JSON.parse(m[1]);
        }
      } catch (_) {
        current = {};
      }
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      current = {};
    }

    // 2. 格式化本次更新的卡片项
    if (key === "db") {
      const entry = Object.assign({ at: Date.now() }, payloadOrResult || {});
      current.db = entry;
    } else {
      const entry = formatCardStatus(key, payloadOrResult, opHint);
      current[key] = entry;

      // 顺带更新 db 前缀状态（如果 payloadOrResult 携带了数据库信息）
      if (payloadOrResult && payloadOrResult.database) {
        const dbInfo = parseDbInfo(payloadOrResult.database);
        if (dbInfo && (dbInfo.prefix || !current.db || !current.db.prefix)) {
          current.db = Object.assign({ at: Date.now() }, dbInfo);
        }
      }
    }

    // 3. 序列化
    const jsonStr = JSON.stringify(current, null, 2);
    const jsStr = `window.__memhubStatus = ${jsonStr};\n`;

    // 4. 原子写内部真相源 _status.json
    fs.writeFileSync(tmpJsonPath, jsonStr, "utf8");
    fs.renameSync(tmpJsonPath, jsonPath);

    // 5. 原子写设置页 script 标签目标 _status.js
    fs.writeFileSync(tmpJsPath, jsStr, "utf8");
    fs.renameSync(tmpJsPath, jsPath);

    return true;
  } catch (err) {
    try { if (fs.existsSync(tmpJsonPath)) fs.unlinkSync(tmpJsonPath); } catch (_) {}
    try { if (fs.existsSync(tmpJsPath)) fs.unlinkSync(tmpJsPath); } catch (_) {}

    console.error("[memory-hub] writeCardStatus failed (directory read-only or not writable):", (err && err.message) || err);
    return false;
  }
}

export function formatCardStatus(key, rawResult, opHint) {
  let res = rawResult;
  if (typeof res === "string") {
    try {
      res = JSON.parse(res);
    } catch (_) {
      res = { error: res };
    }
  }
  if (!res || typeof res !== "object") {
    res = { error: String(res) };
  }

  const at = typeof res.at === "number" ? res.at : Date.now();
  const op = String(opHint || res.op || "unknown");
  const ok = res.ok !== false && res.verdict !== "FAILED" && res.verdict !== "FAILED_VERIFY";

  // 若传入的已具备完整的 title 和 lines，则直接标准化后返回
  if (typeof res.title === "string" && Array.isArray(res.lines) && res.lines.length >= 2) {
    const card = {
      at,
      op,
      ok,
      title: res.title,
      lines: res.lines.map(String).slice(0, 5),
    };
    if (res.progress) card.progress = res.progress;
    if (Array.isArray(res.memories)) card.memories = res.memories;
    return card;
  }

  let title = "";
  let lines = [];

  if (key === "ncb") {
    if (op === "provision") {
      if (ok) {
        title = res.action === "CREATED" ? "一键创建完成（新建数据库）" : "一键创建完成（复用既有库）";
        lines.push(`数据库：${res.database || "已就绪"}`);
        if (res.schema && typeof res.schema === "object") {
          const applied = res.schema.applied != null ? res.schema.applied : 0;
          lines.push(`结构变更：已应用 ${applied} 处表结构/索引设置`);
        } else {
          lines.push("核心表与索引均已就绪（3 表 / 4 索引）");
        }
        if (res.secret_captured) {
          lines.push("已自动捕获并保存 Secret Key，数据读写直接可用");
        }
        if (res.r2) {
          lines.push(res.r2.ok ? `R2 存储：已挂载（${res.r2.bucket || "默认桶"}）` : "R2 存储：挂载未生效，需检查凭据");
        }
      } else {
        title = "一键创建失败";
        if (res.reason) lines.push(`原因：${res.reason}`);
        else if (res.error) lines.push(`错误：${res.error}`);
        else lines.push("无法完成数据库创建与结构初始化");
        if (res.suggestion) lines.push(res.suggestion);
        else lines.push("请在设置页确认 MCP Key 是否有效");
        lines.push("确认 MCP Key 拥有 NoCodeBackend 控制台建库权限");
      }
    } else if (op === "init") {
      if (ok) {
        title = res.action === "NOOP" ? "数据库结构已就绪（无需变更）" : "数据库初始化完成";
        lines.push(`数据库：${res.database || "当前库"}`);
        lines.push(`应用变更：${res.applied != null ? res.applied : 0} 处`);
        lines.push(res.note || "3 张核心表及唯一索引已处于最新状态");
      } else {
        title = "数据库初始化失败";
        lines.push(`原因：${res.error || res.reason || "DDL 执行中断"}`);
        if (res.failed && res.failed.length) lines.push(`失败语句：${res.failed.length} 条`);
        lines.push("请检查 MCP Key 权限或稍后重试");
      }
    } else if (op === "status") {
      if (ok) {
        title = res.initialized ? "数据库结构完整就绪" : "数据库结构存在缺失";
        lines.push(`数据库：${res.database || "当前库"}`);
        if (res.initialized) {
          lines.push("核心表状态：3 张表与索引均已就绪");
        } else {
          const missing = (res.missing_tables || []).concat(res.missing_columns || []);
          lines.push(`缺失项：${missing.join(", ") || "需补齐结构"}`);
        }
        lines.push(res.read_only ? "当前模式：只读检查（未填 MCP Key）" : "当前模式：完整管理（已填 MCP Key）");
      } else {
        title = "数据库状态检查失败";
        lines.push(`原因：${res.reason || res.error || "无法获取数据库结构"}`);
        lines.push(res.hint || "请检查网络连接及数据库实例名是否正确");
      }
    } else if (op === "reset") {
      if (res.action === "CONFIRM_REQUIRED") {
        title = "清库需要二次确认";
        lines.push(`目标数据库：${res.database || "当前库"}`);
        lines.push("操作将永久删除 memories/pitfalls/schema_meta 及其数据");
        lines.push("若确认清空，请在工具或信标中传入 confirm='RESET'");
      } else if (ok) {
        title = "记忆库三表已清空";
        lines.push(`数据库：${res.database || "当前库"}`);
        lines.push(`已删除表：${(res.dropped || []).join(", ") || "memories, pitfalls, schema_meta"}`);
        lines.push("表结构与数据已彻底清除，可随时点击「初始化」重建");
      } else {
        title = "清空数据库失败";
        lines.push(`原因：${res.error || res.reason || "删除表失败"}`);
        lines.push("请检查 MCP Key 是否拥有 DROP TABLE 权限");
      }
    } else if (op === "ncb_check") {
      title = res.title || (ok ? "MCP Key 有效" : "MCP Key 验证失败");
      if (Array.isArray(res.lines) && res.lines.length) {
        lines.push(...res.lines);
      } else {
        lines.push(ok ? "MCP Key 验证成功" : "MCP Key 验证未通过");
        if (res.database) lines.push(`目标数据库：${res.database}`);
        if (res.diagnosis && res.diagnosis.detail) lines.push(res.diagnosis.detail);
      }
    } else if (op === "secret_check") {
      title = res.title || (ok ? "Secret Key 有效" : "Secret Key 验证未通过");
      if (Array.isArray(res.lines) && res.lines.length) {
        lines.push(...res.lines);
      } else {
        lines.push(ok ? "Secret Key 验证成功" : "Secret Key 验证未通过");
        if (res.database) lines.push(`目标数据库：${res.database}`);
        if (res.source) lines.push(`密钥来源：${res.source}`);
      }
    } else {
      title = ok ? "操作执行成功" : "操作执行失败";
      lines.push(`操作类型：${op}`);
      if (res.database) lines.push(`数据库：${res.database}`);
      if (res.note || res.reason || res.error) lines.push(res.note || res.reason || res.error);
    }
  } else if (key === "r2") {
    if (op === "storage_setup" || op === "r2_check") {
      if (ok) {
        title = op === "r2_check" ? "R2 凭据验证通过（可用）" : "R2 存储挂载成功";
        lines.push(`数据库：${res.database || "当前库"}`);
        lines.push(`存储桶：${res.bucket_name || "已绑定"}`);
        if (res.public_url) lines.push(`公开域名：${res.public_url}`);
        if (res.probe && res.probe.cleaned === false) {
          lines.push(res.probe.clean_note ? `探针残留提示：${res.probe.clean_note}` : "真实上传验证成功；探针文件留在 R2（删除需 Secret Key）");
          lines.push("清理方法：在设置页填写数据库 Secret Key 后，点击「清理探针文件」即可一键清除。");
        } else {
          lines.push("真实上传与删除探针测试成功，存储通道就绪");
        }
      } else {
        const diag = res.diagnosis;
        title = diag && diag.title ? diag.title : (op === "r2_check" ? "R2 凭据验证失败" : "R2 挂载未生效");
        if (Array.isArray(res.lines) && res.lines.some((l) => l.includes("【智能诊断】"))) {
          lines.push(...res.lines);
        } else {
          lines.push(`数据库：${res.database || "当前库"}`);
          if (diag && diag.detail) lines.push(diag.detail);
          else if (res.probe && res.probe.error) lines.push(`探针失败：${res.probe.error}`);
          else if (res.error) lines.push(`错误：${res.error}`);
          else lines.push("真实上传探针失败，存储无法正常工作");

          if (diag && Array.isArray(diag.actions) && diag.actions.length) {
            lines.push(diag.actions[0]);
            if (diag.actions[1] && lines.length < 5) lines.push(diag.actions[1]);
          } else {
            lines.push("请到 NoCodeBackend 控制台确认 Cloudflare R2 连接与权限");
          }
        }
      }
    } else if (op === "clean_probe") {
      title = res.title || (ok ? "探针清理完成" : "探针清理失败");
      if (Array.isArray(res.lines) && res.lines.length) {
        lines.push(...res.lines);
      } else {
        lines.push(`数据库：${res.database || "当前库"}`);
        if (res.note || res.error || res.suggestion) {
          lines.push(res.note || res.error || res.suggestion);
        }
      }
    } else {
      title = ok ? "R2 操作完成" : "R2 操作失败";
      lines.push(`操作：${op}`);
      if (res.database) lines.push(`数据库：${res.database}`);
      if (res.note || res.error) lines.push(res.note || res.error);
    }
  } else if (key === "gateway") {
    title = res.title || (ok ? "网关对话提炼就绪" : "未检测到对话录制");
    if (Array.isArray(res.lines) && res.lines.length) {
      lines.push(...res.lines);
    } else if (res.message) {
      lines.push(res.message);
    } else {
      lines.push(ok ? "网关对话提炼功能正常运行" : "未检测到对话录制。请在 Magpie 设置里开启 GatewayConversations（本地录制对话，插件据此提炼记忆）。");
    }
  } else if (key === "model") {
    title = res.title || (ok ? "在线模型连通就绪" : "在线模型检测未通过");
    if (Array.isArray(res.lines) && res.lines.length) {
      lines.push(...res.lines);
    } else if (res.error) {
      lines.push(`错误：${res.error}`);
    } else {
      lines.push(ok ? "在线模型配置有效且响应正常" : "在线模型未配置或检测未通过");
    }
  } else if (key === "inject") {
    title = res.title || "记忆快照已就绪";
    lines = Array.isArray(res.lines) ? res.lines.slice() : ["活跃记忆快照已提取完成"];
  } else if (key === "audit") {
    title = res.title || (ok ? "全自动去重完成" : "全自动去重未完成");
    if (Array.isArray(res.lines) && res.lines.length) {
      lines.push(...res.lines);
    } else if (res.message) {
      lines.push(res.message);
    } else {
      lines.push(ok ? "全自动去重已完成" : "去重任务执行异常");
    }
  }

  while (lines.length < 2) {
    lines.push(ok ? "操作已正常完成" : "请根据提示排查后重试");
  }

  const outCard = {
    at,
    op,
    ok,
    title: title || (ok ? "操作成功" : "操作失败"),
    lines: lines.slice(0, 5),
  };
  if (res.progress) outCard.progress = res.progress;
  if (Array.isArray(res.logs)) outCard.logs = res.logs;
  if (Array.isArray(res.memories)) outCard.memories = res.memories;
  return outCard;
}

export function parseDbInfo(rawName, fallbackLogical) {
  const s = String(rawName || "").trim();
  const fallback = String(fallbackLogical || "").trim();
  const candidate = s || fallback;
  if (!candidate) {
    return { logical: "", prefix: "", full: "" };
  }

  // 1. 若候选名称本身已经以数字前缀开头（如 41694_agent_memory）
  const directMatch = candidate.match(/^(\d+_)(.*)$/);
  if (directMatch) {
    return {
      logical: directMatch[2] || candidate,
      prefix: directMatch[1],
      full: candidate,
    };
  }

  // 2. 复用 local_state.js 的 lookupRealDatabase 同步归一化查找真实库名
  let resolved = "";
  try {
    resolved = lookupRealDatabase(candidate);
  } catch (_) {}

  const resolvedMatch = String(resolved || "").match(/^(\d+_)(.*)$/);
  if (resolvedMatch) {
    return {
      logical: candidate,
      prefix: resolvedMatch[1],
      full: resolved,
    };
  }

  // 3. 尚未解析出带前缀的真实名（显示占位）
  return {
    logical: candidate,
    prefix: "",
    full: resolved || candidate,
  };
}
