/**
 * 模块职责：MagpieMemoryHub 插件主入口、MCP 工具树注册与宿主生命周期管理
 * 依赖：src/core/**, src/domain/**, src/integration/**, src/services/**, src/tools/**, db_tools.js, r2.js, page_actions.js, gateway_harvest.js
 * 被依赖：tools.js (薄门面)
 */

import {
  dbStatus, dbInit, dbProvision, dbReset, storageSetup, storageUpload, storageGuide, ncbCheck, RESET_CONFIRM,
} from "./integration/db-tools.js";
import { r2List, r2Delete, r2Check } from "./integration/r2-storage.js";
import { runPendingAction, readAction, writeCardStatus, parseDbInfo } from "./page/actions.js";
import { harvestGateway, isTestMode, triggerBackgroundDrain } from "./services/harvest/index.js";

import { CATEGORIES, SCOPES, SEVERITIES, readOptions } from "./core/config.js";
import { makeClient } from "./integration/ncb.js";
import { normalizeToolArgs } from "./tools/args.js";
import { memorySave } from "./tools/memory-save.js";
import { saveMemory } from "./services/save/memory-saver.js";
import { memorySearch } from "./tools/memory-search.js";
import { memoryList } from "./tools/memory-list.js";
import { memoryContext } from "./tools/memory-context.js";
import { memoryGet } from "./tools/memory-get.js";
import { memoryForget } from "./tools/memory-forget.js";
import { pitfallSave } from "./tools/pitfall-save.js";
import { pitfallSearch } from "./tools/pitfall-search.js";
import { memoryAudit } from "./services/audit/auditor.js";
import {
  stopAuditScheduler,
  checkScheduledDedup,
  ensureAuditScheduler,
  _auditOptionsGetter,
  setAuditSchedulerContext,
} from "./services/audit/scheduler.js";

const TOOLS = {
  memory_save: {
    description:
      '【持久化沉淀】向记忆库写入一条长期事实、架构决策或工程规范。当确立了长期不变的偏好/规则时务必设 category="principle"（会被无条件置顶召回）；若同标题内容更新会自动保留历史版本(superseded)；入库前自动对密钥敏感词执行正则脱敏。',
    args: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名，默认 global" },
        category: { type: "string", enum: CATEGORIES, description: "记忆分类。principle=行为准则，会被无条件置顶注入" },
        scope_level: { type: "string", enum: SCOPES, description: "作用域层级，默认 project（可选 user, project, session, turn）" },
        client: { type: "string", description: "产生该记忆的客户端标识（如 minis、codex、claude 等，可选，默认取调用者智能体）" },
        title: { type: "string", description: "精简标题（<=40字）" },
        content: { type: "string", description: "记忆正文/摘要，要具体、可复用" },
        full_text: { type: "string", description: "完整原文（可选，未提供时默认等于 content）" },
        tags: { type: "string", description: "逗号分隔的检索关键词" },
        related_entities: { type: "string", description: "关联实体，逗号分隔" },
        confidence: { type: "number", description: "置信度 0~1，默认 1" },
        recurrence: { type: "integer", description: "观察与复发次数，默认 1" },
        supersede_id: { type: "number", description: "要取代的旧记录 ID（显式取代走 UPDATE）" },
        supersede: { type: "boolean", description: "强制以新内容扩充/覆盖同标题记录" },
        handoff: { type: "boolean", description: "标记本条为跨 Agent 任务交接棒（自动补齐 handoff:open 标签并核销同项目旧棒，默认 false）" },
        feedback: { type: "string", enum: ["helpful"], description: "记忆质量正向反馈：helpful 命中既有记忆（去重 NOOP / 演进 ENRICHED）时置信度 +10（封顶 100）并累加复发度（默认不传，零侵入）" },
      },
      required: ["title", "content"],
    },
    run: (args, ctx) => memorySave(ctx._client, ctx._cfg, args, ctx),
  },

  memory_search: {
    description:
      '【深度记忆检索】根据关键词检索历史事实、决策与工程背景。支持双路查询分词 + 在线大模型重排(rerank)，支持跨项目全局穿透(project + global)与项目专属优先排序。回答项目历史背景前必调。',
    args: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，空格分隔多个" },
        project: { type: "string", description: "限定项目" },
        category: { type: "string", enum: CATEGORIES, description: "限定分类" },
        scope_level: { type: "string", enum: SCOPES, description: "限定作用域层级" },
        client: { type: "string", description: "限定客户端来源（如 minis、codex、claude）" },
        origin: { type: "string", enum: ["tool", "inline", "harvest"], description: "限定产生方式" },
        include_history: { type: "boolean", description: "是否包含已被 superseded 的历史版本" },
        limit: { type: "integer", description: "返回条数，默认 10，最大 50" },
        search_rerank: { type: "boolean", description: "是否使用在线模型进行语义相关度重排与挑选（默认 true，遇到故障 fail-open 回退纯词面）" },
        explain: { type: "boolean", description: "是否返回各路打分（词面分、实体分、新鲜度、排序分、Rerank名次）与各阶段耗时明细（默认 false）" },
      },
    },
    run: (args, ctx) => memorySearch(ctx._client, ctx._cfg, args),
  },

  memory_list: {
    description: '【知识总览】分页列出当前项目或全局的活跃记忆列表，按访问热度与新鲜度加权排序。用于快速了解当前项目已积累的知识全貌。',
    args: {
      type: "object",
      properties: {
        project: { type: "string", description: "限定项目" },
        client: { type: "string", description: "限定客户端来源（如 minis、codex、claude）" },
        limit: { type: "integer", description: "返回条数，默认 20，最大 100" },
      },
    },
    run: (args, ctx) => memoryList(ctx._client, ctx._cfg, args),
  },

  memory_context: {
    description: '【首选一站式上下文召回】开始分析项目、排查问题或编写代码前首选调用：一次调用同时召回当前项目的核心行为准则(principle)、历史相关记忆(memories)以及 Top 3 踩坑排障解法(pitfalls)，支持跨项目全局准则穿透兜底。',
    args: {
      type: "object",
      properties: {
        query: { type: "string", description: "当前任务关键词" },
        project: { type: "string", description: "限定项目" },
        max_items: { type: "integer", description: "最多条数，默认取插件配置" },
        max_chars: { type: "integer", description: "字符预算，默认取插件配置" },
        max_principles: { type: "number", description: "置顶准则条数上限，默认 3（含最新准则保底席位）" },
        claim_handoff: { type: "boolean", description: "是否单次核销认领当前项目的跨 Agent 待接力任务（默认 false 只提示不核销）" },
      },
    },
    run: (args, ctx) => memoryContext(ctx._client, ctx._cfg, args, ctx),
  },

  memory_get: {
    description: '【记忆/踩坑全文查看】根据 ID 精确取出一条记录或通过 ids 批量取出多条完整正文。支持 table 参数跨表读取（"memories" | "pitfalls"，默认 memories）。调用后自动累加访问热度。',
    args: {
      type: "object",
      properties: {
        id: { type: "integer", description: "单条记录 id" },
        ids: { type: "array", items: { type: "integer" }, description: "批量读取记录 id 列表" },
        table: { type: "string", enum: ["memories", "pitfalls"], description: "目标表，支持 memories 或 pitfalls，默认 memories" },
        feedback: { type: "string", enum: ["helpful"], description: "记忆质量正向反馈：helpful 提升置信度 10 分且累加复发度" },
      },
    },
    run: (args, ctx) => memoryGet(ctx._client, ctx._cfg, args),
  },

  memory_forget: {
    description: '【记忆软失效】将过时、失效或已被废弃的记忆标记为软失效（记录 invalid_at，绝不物理删除）。可通过 ID 精确失效或关键词匹配批量失效。支持 table 参数选择 memories 或 pitfalls 表。',
    args: {
      type: "object",
      properties: {
        id: { type: "integer", description: "按 id 精确失效（优先）" },
        ids: { type: "array", items: { type: "integer" }, description: "批量失效记录 id 列表" },
        query: { type: "string", description: "按关键词匹配失效" },
        limit: { type: "integer", description: "按关键词时最多失效几条，默认 1" },
        table: { type: "string", enum: ["memories", "pitfalls"], description: "目标表，支持 memories 或 pitfalls，默认 memories" },
        feedback: { type: "string", enum: ["not_helpful", "stale", "wrong"], description: "记忆质量反馈：not_helpful 降置信度 25 分；stale/wrong 软失效并记录反馈原因" },
      },
    },
    run: (args, ctx) => memoryForget(ctx._client, ctx._cfg, args),
  },

  memory_audit: {
    description:
      '【全自动去重巡检与撤销】对库内记忆与踩坑记录执行分批语义级查重合并（仅软失效保留审计痕迹），支持定时调度、多轮 recurrence 准确累加、游标断点续跑，以及按指定时间点一键撤销回滚。',
    args: {
      type: "object",
      properties: {
        project: { type: "string", description: "限定项目，默认 global" },
        full: { type: "boolean", description: "是否全库扫描去重（默认 true）" },
        batch_size: { type: "integer", description: "分批大小（50~1000，默认 1000）" },
        schedule: { type: "string", enum: ["off", "daily", "weekly", "monthly"], description: "定时调度模式" },
        updated_after: { type: "string", description: "仅去重指定时间戳之后变动的记录（如 daily/weekly/monthly 窗口）" },
        undo: { type: "boolean", description: "是否执行去重撤销（默认撤销最近一次去重批次）" },
        undo_before: { type: "string", description: "撤销指定时刻之后的所有去重（如 '2026-10-19 03:00'），还原至该时刻前状态" },
        since_days: { type: "integer", description: "仅去重最近 N 天变动的记录" },
        since_id: { type: "integer", description: "指定起始游标 ID" },
        apply: { type: "boolean", description: "兼容参数（当前默认全自动执行去重）" },
      },
    },
    run: (args, ctx) => memoryAudit(ctx._client, ctx._cfg, args, ctx),
  },

  pitfall_save: {
    description: '【避坑排障沉淀】记录工程报错与排障解法（仅需提供 symptom 与 solution，自动补齐 component 与 root_cause）。发现相似问题时自动累加复发次数(recurrence)；入库前自动对密钥与凭据脱敏。排查定位完 bug 后必须调用！',
    args: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名" },
        client: { type: "string", description: "产生该踩坑记录的客户端标识（可选）" },
        component: { type: "string", description: "出问题的组件（可选，默认 general）" },
        symptom: { type: "string", description: "错误现象或报错原文" },
        root_cause: { type: "string", description: "技术根因（可选，默认等于 symptom）" },
        solution: { type: "string", description: "已验证的解法" },
        severity: { type: "string", enum: SEVERITIES },
        error_type: { type: "string", description: "错误类型标签，便于聚类" },
        tags: { type: "string", description: "检索关键词" },
        related_entities: { type: "string", description: "关联实体，逗号分隔" },
        recurrence: { type: "number", description: "本次复发次数，默认 1" },
        source_session: { type: "string", description: "来源会话标识（如客户端会话 ID，可选）" },
        source_turn: { type: "integer", description: "来源会话轮次序号（从 1 起始，可选）" },
      },
      required: ["symptom", "solution"],
    },
    run: (args, ctx) => pitfallSave(ctx._client, ctx._cfg, args, ctx),
  },

  pitfall_search: {
    description: '【已知故障与避坑检索】遇到报错、排查故障或准备执行关键操作前调用：检索已知症状、错误信息、技术根因与已验证解法，支持在线大模型语义重排与全局避坑穿透。',
    args: {
      type: "object",
      properties: {
        query: { type: "string", description: "症状/根因/解法关键词" },
        project: { type: "string", description: "限定项目" },
        client: { type: "string", description: "限定客户端来源" },
        component: { type: "string", description: "限定组件" },
        limit: { type: "integer", description: "返回条数，默认 10" },
        search_rerank: { type: "boolean", description: "是否使用在线模型进行语义重排（默认 true）" },
        explain: { type: "boolean", description: "是否返回踩坑检索打分明细与耗时（默认 false）" },
      },
    },
    run: (args, ctx) => pitfallSearch(ctx._client, ctx._cfg, args),
  },

  /* ---------------- 数据库结构管理（需 MCP key） ---------------- */

  ncb_check: {
    description:
      '【数据库诊断】只读检测当前配置的 NoCodeBackend MCP 连通性与密钥有效性，检查目标数据库是否存在以及核心表/列/索引完整度。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "目标数据库实例名，默认取插件配置的 ncb_instance" },
        mcp_key: { type: "string", description: "待检测的 MCP Key（可选，默认取插件配置）" },
      },
    },
    run: (args, ctx) => ncbCheck(ctx._cfg, args),
  },

  db_status: {
    description: '【表结构差集检查】只读检查数据库表结构：对比当前实际结构与期望 schema 的差异（缺失表、缺失列、缺失索引），报告 Schema 版本号。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置的 ncb_instance" },
      },
    },
    run: (args, ctx) => dbStatus(ctx._cfg, args),
  },

  db_provision: {
    description: '【一键全自动建库】使用 MCP 凭据自动完成数据库创建与全量表结构初始化，内置重名冲突保护（默认 reuse 复用已有库不破坏数据）。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "要创建的数据库名（逻辑名即可，NCB 会自动加账号前缀）。默认取设置页的 ncb_instance" },
        on_exist: { type: "string", enum: ["reuse", "auto_rename", "fail"], description: "同名已存在时的策略，默认 reuse" },
        with_r2: { type: "boolean", description: "是否同时挂载 R2 存储，默认 false，需要时才挂" },
        bucket_name: { type: "string", description: "R2 bucket 名，默认由数据库名派生合规名称（如将下划线替换为连字符）" },
        public_url: { type: "string", description: "R2 公开域名，如 https://cdn.example.com" },
        account_id: { type: "string", description: "Cloudflare 账号 ID（账号已连接过可留空，会自动复用）" },
        access_key_id: { type: "string", description: "Cloudflare R2 Access Key ID（同上可留空）" },
        secret_access_key: { type: "string", description: "Cloudflare R2 Secret Access Key（同上可留空）" },
        region: { type: "string", enum: ["us", "eu"], description: "新库所在区域，默认 us" },
      },
    },
    run: (args, ctx) => dbProvision(ctx._cfg, args),
  },

  db_init: {
    description: '【幂等初始化】自动增量补齐缺失的核心表（memories/pitfalls/schema_meta）、字段与唯一索引。只增不删，库内已有数据和外来表完全不受影响。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
        dry_run: { type: "boolean", description: "只展示将要执行的 SQL，不真正执行" },
      },
    },
    run: (args, ctx) => dbInit(ctx._cfg, args),
  },

  db_reset: {
    description: "【破坏性清库】清空插件的三张核心表结构与全部数据（需传 confirm=\"RESET\" 二次确认，非管理员日常请勿调用）。",
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
        confirm: { type: "string", description: '确认串。必须精确等于 "RESET" 才会真正执行' },
      },
    },
    run: (args, ctx) => dbReset(ctx._cfg, args),
  },

  /* ---------------- R2 文件存储（需 MCP key） ---------------- */

  r2_check: {
    description:
      '【R2 连通性探针】通过上传并立即清理一个极小临时探针文件，只读检测 Cloudflare R2 对象存储通道与凭据真实可用性。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
        bucket_name: { type: "string", description: "自定义 bucket 名（可选）" },
        public_url: { type: "string", description: "自定义域名或公开 URL（可选）" },
        account_id: { type: "string", description: "临时测试的 Cloudflare 账号 ID（可选）" },
        access_key_id: { type: "string", description: "临时测试的 Cloudflare Access Key ID（可选）" },
        secret_access_key: { type: "string", description: "临时测试的 Cloudflare Secret Access Key（可选）" },
      },
    },
    run: (args, ctx) => r2Check(ctx._cfg, args),
  },

  storage_setup: {
    description: '【挂载 R2 存储桶】为数据库配置并挂载 Cloudflare R2 对象存储，自动创建 bucket 并配置 CORS 规则，挂载后紧接端到端真实上传探测验证。',
    args: {
      type: "object",
      properties: {
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
        bucket_name: { type: "string", description: "自定义 bucket 名，默认由数据库名派生合规名称（如将下划线替换为连字符）" },
        public_url: { type: "string", description: "自定义域名或 r2.dev 公开地址" },
      },
    },
    run: (args, ctx) => storageSetup(ctx._cfg, args),
  },

  storage_upload: {
    description: '【上传文件到 R2】把文本或二进制文件上传至 R2 存储桶并获取公开访问 URL。建议上传后将所得 URL 存为 category="fact" 的记忆。',
    args: {
      type: "object",
      properties: {
        filename: { type: "string", description: "文件名，如 report.pdf、dump.log" },
        content: { type: "string", description: "文件内容。文本直接给；二进制请给 base64 并设 encoding=base64。省略则返回 presigned URL" },
        encoding: { type: "string", enum: ["text", "base64"], description: "content 的编码方式，默认 text" },
        content_type: { type: "string", description: "MIME 类型，如 image/png、application/pdf" },
        database: { type: "string", description: "数据库实例名，默认取插件配置" },
      },
      required: ["filename"],
    },
    run: (args, ctx) => storageUpload(ctx._cfg, args),
  },

  storage_list: {
    description: '【列出 R2 文件】列出当前数据库 R2 存储桶内的对象列表（包括文件名、大小、修改时间与公开访问链接）。',
    args: {
      type: "object",
      properties: { limit: { type: "integer", description: "最多返回几条，默认 100" } },
    },
    run: (args, ctx) => r2List(ctx._cfg, args),
  },

  storage_delete: {
    description: "【删除 R2 文件】从 R2 存储桶中删除指定 key 的对象文件（不可恢复，需传 confirm=\"DELETE\" 确认）。",
    args: {
      type: "object",
      properties: {
        key: { type: "string", description: "对象的 key（storage_list 返回的 key 字段）" },
        confirm: { type: "string", description: '确认串，必须精确等于 "DELETE"' },
      },
      required: ["key"],
    },
    run: (args, ctx) => r2Delete(ctx._cfg, args),
  },

  storage_guide: {
    description: '【R2 使用能力指引】查询 R2 存储的工作机制、凭据拆分规则（MCP 建桶 vs Secret Key 上传/删除）以及常见故障排查说明。',
    args: { type: "object", properties: {} },
    run: (args, ctx) => storageGuide(ctx._cfg),
  },

  harvest_gateway: {
    description: '【录制日志增量提炼】增量扫描 Magpie 网关录制的历史对话落盘文件，调用在线模型提炼其中的环境事实、架构决策与故障经验存入库。',
    args: {
      type: "object",
      properties: {
        dir: { type: "string", description: "自定义对话落盘目录路径（可选，默认自动探测）" },
        force_rescan: { type: "boolean", description: "是否强制重新扫描所有文件（忽略增量状态，默认 false）" },
        project: { type: "string", description: "项目命名空间（可选，默认 global）" },
        extract_model: { type: "string", description: "指定的在线提炼模型 ID（如 gpt-4o-mini、claude-3-5-sonnet，默认取插件设置页配置；未配置时安全跳过）" },
        min_evidence: { type: "number", description: "证据累计门禁阈值（默认 3；首次观察时不落盘，累计达到该次数才入库）" },
      },
    },
    run: (args, ctx) => harvestGateway(args, {
      _client: ctx._client,
      _cfg: ctx._cfg,
      _ctx: ctx._ctx,
      _input: ctx._input,
      saveMemory,
      pitfallSave,
      signal: ctx.signal,
    }),
  },
};

/* ================================================================== *
 * 插件入口 —— 本文件唯一导出的函数
 * ================================================================== */

export const MagpieMemoryHub = async (input, options) => {
  const hostDir = (input && typeof input.directory === "string" && input.directory)
    || (options && typeof options.directory === "string" && options.directory)
    || "";
  const mergedOpts = Object.assign(
    {},
    input && typeof input === "object" ? input : {},
    options && typeof options === "object" ? options : {},
    hostDir ? { hostDirectory: hostDir, directory: hostDir } : {}
  );
  const cfg = readOptions(mergedOpts);
  const client = (mergedOpts && (mergedOpts._client || mergedOpts.client)) || makeClient(cfg);

  /* 【BUG-39-4a 治本修复】提前解析 _no_scheduler 隔离标记：
   * 当 noScheduler 为 true 时（如后台 drain 消费构造的临时实例），
   * 必须阻断入口副作用：不写 _status.js 的 db 卡片、不触发 autoInit、不触发 autoHarvest。 */
  const noScheduler = (options && options._no_scheduler === true) || (input && input._no_scheduler === true);

  // 同步将当前库的前缀解析状态写入 _status.js，供设置页即时只读展示真实库名
  if (!noScheduler) {
    try {
      const rawDb = (options && (options.ncb_instance || options.instance)) || cfg.instance || "";
      if (rawDb) {
        const dbInfo = parseDbInfo(rawDb);
        writeCardStatus("db", dbInfo);
      }
    } catch (e) {
      console.error("[memory-hub] db prefix sync error:", (e && e.message) || e);
    }
  }

  /* ---- 设置页按钮提交的待办任务 ----
   * 页面无法直接触发宿主动作（Magpie 没有这个通道），只能把「要做什么」
   * 写进 options 当一次性信标；这里在宿主加载时读取并执行。
   * 只在真有信标时才做网络调用，不给常规加载引入等待。 */
  if (!noScheduler && readAction(options)) {
    try {
      const r = await runPendingAction(options, cfg);
      if (r.ran) {
        console.error("[memory-hub] 页面任务 " + r.op + "#" + r.id + " 已执行：" +
          JSON.stringify(r.result).slice(0, 400));
      } else {
        console.error("[memory-hub] 页面任务跳过：" + r.reason);
      }
    } catch (e) {
      // 信标执行失败绝不能让宿主加载失败
      console.error("[memory-hub] 页面任务执行异常：" + String(e && e.message || e));
    }
  }

  /* ---- auto_init 自愈 ----
   * 不 await：初始化可能要一次网络往返，而工具枚举不该为此等待。
   * 宿主进程长驻，这个 promise 会自行跑完。 */
  if (!noScheduler && cfg.autoInit && cfg.mcpKey && !isTestMode()) {
    dbInit(cfg, {}).catch((e) => {
      console.error("[memory-hub] auto_init 失败：" + String(e && e.message || e));
    });
  }

  /* ---- auto_harvest 自动增量提炼 ----
   * 不 await：增量扫描在后台异步执行，不给常规工具枚举引入网络/磁盘延迟。
   * 仅在 options.auto_harvest 为 true 时开启，默认 false 以防隐私越界。
   * 严禁在测试环境中启动真实增量扫描。 */
  if (!noScheduler && cfg.autoHarvest && !isTestMode()) {
    harvestGateway({}, {
      _client: client,
      _cfg: cfg,
      _input: input,
      saveMemory,
      pitfallSave,
    }).catch((e) => {
      console.error("[memory-hub] auto_harvest 失败：" + String((e && e.message) || e));
    });
  }

  /* ---- dedup_schedule 定时自动去重 ----
   * 宿主长驻进程定期检查上次去重时间是否超期（daily / weekly / monthly）。
   * 默认 off，关闭时不执行任何后台操作；超期触发后立即分批执行去重，绝不产出冗余卡片。
   * 【BUG-38-3 治本修复】增加 _no_scheduler: true 隔离标记支持：
   * 当 noScheduler 为 true 时（如后台 drain 消费构造的临时实例），
   * 跳过整个调度器生命周期管理——不调用 ensureAuditScheduler、不调用 stopAuditScheduler、
   * 不赋值 _auditOptionsGetter、不改 _auditBaseCfg/_auditBaseClient。 */
  const optionsGetter = () => readOptions(Object.assign({}, input && typeof input === "object" ? input : {}, options && typeof options === "object" ? options : {}));

  if (!noScheduler) {
    const dedupSched = cfg.dedup_schedule || cfg.audit_interval || cfg.auditInterval || (options && (options.dedup_schedule || options.audit_interval)) || "off";
    setAuditSchedulerContext(optionsGetter, cfg, client);

    if (dedupSched === "off" || dedupSched === "none") {
      stopAuditScheduler();
    } else if (!isTestMode()) {
      ensureAuditScheduler(client, cfg, optionsGetter);
    }
  }

  const tool = {};
  for (const name of Object.keys(TOOLS)) {
    const def = TOOLS[name];
    tool[name] = {
      description: def.description,
      args: def.args,
      execute: async (args, ctx) => {
        const abortSignal = (ctx && ctx.abort) || null;
        if (abortSignal && abortSignal.aborted) {
          const abortErr = new Error("操作已被取消 (aborted)");
          abortErr.name = "AbortError";
          throw abortErr;
        }
        const callCfg = Object.assign({}, cfg, { signal: abortSignal });
        const baseClient = (options && (options._client || options.client)) || null;
        let callClient;
        if (baseClient) {
          const checkAbort = () => {
            if (abortSignal && abortSignal.aborted) {
              const err = new Error("操作已被取消 (aborted)");
              err.name = "AbortError";
              throw err;
            }
          };

          callClient = {
            ...baseClient,
            create: async (t, d) => { checkAbort(); return await baseClient.create(t, d); },
            list: async (t, p) => {
              checkAbort();
              return await baseClient.list(t, p);
            },
            update: async (t, id, d) => { checkAbort(); return await baseClient.update(t, id, d); },
            remove: async (t, id) => { checkAbort(); return await baseClient.remove(t, id); },
            raw: async (sql) => { checkAbort(); return await baseClient.raw(sql); },
          };
        } else {
          callClient = makeClient(callCfg, abortSignal);
        }
        if (callClient && !isTestMode()) {
          triggerBackgroundDrain(callClient).catch(() => {});
        }
        const callArgs = ["memory_save", "pitfall_save", "memory_search", "pitfall_search", "memory_get", "memory_context", "memory_list", "memory_forget"].includes(name)
          ? normalizeToolArgs(args, callCfg)
          : (args || {});
        const result = await def.run(callArgs, {
          _client: callClient,
          _cfg: callCfg,
          _input: input,
          _ctx: ctx,
          signal: abortSignal,
        });
        try {
          if (["db_provision", "db_status", "db_init", "db_reset", "ncb_check"].includes(name)) {
            const op = name.replace(/^db_/, "");
            writeCardStatus("ncb", result, op);
          } else if (name === "storage_setup" || name === "r2_check") {
            writeCardStatus("r2", result, name);
          }
        } catch (e) {
          console.error("[memory-hub] writeCardStatus tool hook error:", (e && e.message) || e);
        }
        return result;
      },
    };
  }

  return {
    tool,
    _scheduler: {
      getFreshCfg: () => {
        if (typeof _auditOptionsGetter === "function") {
          try {
            return _auditOptionsGetter();
          } catch (_) {}
        }
        return optionsGetter();
      },
      ensureAuditScheduler: (c = client, conf = cfg, og = optionsGetter) => ensureAuditScheduler(c, conf, og),
      stop: stopAuditScheduler,
    },
    _getFreshCfg: () => {
      if (typeof _auditOptionsGetter === "function") {
        try {
          return _auditOptionsGetter();
        } catch (_) {}
      }
      return optionsGetter();
    },
  };
};

MagpieMemoryHub.ensureAuditScheduler = ensureAuditScheduler;
MagpieMemoryHub.stopAuditScheduler = stopAuditScheduler;
MagpieMemoryHub.readOptions = readOptions;
MagpieMemoryHub.checkScheduledDedup = checkScheduledDedup;
MagpieMemoryHub.normalizeToolArgs = normalizeToolArgs;
// 注册 harvest-pipeline Hub 工厂注入（打破循环依赖）

