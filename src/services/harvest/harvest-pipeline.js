/**
 * 模块职责: 对话提炼与记忆入库流水线 (processDialogueAndHarvest 主体、双轨门禁、指纹去重与后台队列消费)
 * 依赖: ./scaffolding.js (_diag), ./dialog-extract.js (isExplicitUserMemory), ./classify.js (classifyDialogueWithOnlineModel), ./extract.js (harvestWithOnlineModel), ./offline-scan.js (isTestMode), tools.js, src/core/sanitize.js, src/core/state.js, src/domain/semantic-dedup.js
 * 被依赖: src/services/harvest/index.js, src/services/harvest/hook-response.js, gateway_harvest.hooks.js, tools.js, tests
 */

import crypto from "node:crypto";
import { markRecent, justWritten } from "../../core/state-recent.js";
import { scrubSecrets } from "../../core/sanitize.js";
import { _diag } from "./scaffolding.js";
import { isExplicitUserMemory } from "./dialog-extract.js";
import { isTestMode } from "./offline-scan.js";
import { classifyDialogueWithOnlineModel } from "./classify.js";
import { harvestWithOnlineModel } from "./extract.js";
import {
  recordPendingEvidence,
  DEFAULT_MIN_EVIDENCE,
  enqueueHarvestItems,
  readHarvestQueue,
  removeHarvestItems,
  updateHarvestItemRetries,
} from "../../core/state.js";
import { semanticFingerprint } from "../../domain/semantic-dedup.js";
import { saveMemory } from "../save/memory-saver.js";
import { pitfallSave } from "../../tools/pitfall-save.js";

function safeEnqueueHarvestItems(items) {
  if (!Array.isArray(items)) return;
  const scrubbed = items.map((it) => {
    if (!it || !it.data || typeof it.data !== "object") return it;
    const data = Object.assign({}, it.data);
    for (const k of ["title", "content", "full_text", "symptom", "root_cause", "solution", "tags", "related_entities"]) {
      if (typeof data[k] === "string") {
        data[k] = scrubSecrets(data[k]);
      }
    }
    return Object.assign({}, it, { data });
  });
  return enqueueHarvestItems(scrubbed);
}

const RECENT_CAP = 1000;
const recentFingerprints = new Map();

function markRecentTurn(fp) {
  if (!fp) return;
  markRecent(fp);
  if (recentFingerprints.size >= RECENT_CAP) {
    const oldestKey = recentFingerprints.keys().next().value;
    if (oldestKey) recentFingerprints.delete(oldestKey);
  }
  recentFingerprints.set(fp, Date.now());
}

function isRecentTurn(fp) {
  if (!fp) return false;
  if (justWritten(fp)) return true;
  const at = recentFingerprints.get(fp);
  if (!at) return false;
  if (Date.now() - at > 300000) {
    recentFingerprints.delete(fp);
    return false;
  }
  return true;
}

export function turnFingerprint(text) {
  return crypto.createHash("sha256").update(String(text || "").trim()).digest("hex");
}
// 向后兼容别名：仅供旧调用方过渡，语义为对话轮次键，不可用于写库指纹（写库指纹用 domain/fingerprint.js）
export const fingerprint = turnFingerprint;

export async function processDialogueAndHarvest(dialogueText, meta = {}, client = null, options = {}) {
  if (!dialogueText || dialogueText.length < 20) {
    return { memoriesSaved: 0, pitfallsSaved: 0, pendingSaved: 0, skipped: true, reason: "dialogue too short" };
  }

  // v6.20.0 事故修复·无价值短路（零模型调用前置拦截）：
  // 纯闲聊/问候/感谢（< 60 字符且无任何技术信号）直接跳过，连判定模型都不调。
  // 显式记忆沉淀指令（"记住…"/"避坑…"）不受此短路影响，仍走正常提炼链路。
  // 注意：短路只看纯文本信号，不看模型名——不硬编码任何模型。
  if (!isExplicitUserMemory(dialogueText)) {
    const _probe = String(dialogueText).slice(0, 400);
    // 技术信号分两组判定（注意：常量组必须大小写敏感，否则 [A-Z]{3} 会误匹配任意英文词）：
    const _hasTechSignalCI = /[a-z_]{2,}\.[a-z]{2,}|[\\/][\w.-]+|```|\b(error|报错|异常|配置|端口|bug|fix|deploy|api|sql|cors|token|key|安装|依赖|版本|数据库|架构|选型|规范|偏好|记住|踩坑)\b/i.test(_probe);
    const _hasTechSignalCS = /[A-Z][A-Z0-9_]{2,}/.test(_probe);
    if (dialogueText.length < 60 && !_hasTechSignalCI && !_hasTechSignalCS) {
      return { memoriesSaved: 0, pitfallsSaved: 0, pendingSaved: 0, skipped: true, reason: "trivial_chatter_shortcircuit" };
    }
  }

  const project = String(meta.project || "global").trim();
  const agent = String(meta.agent || "gateway").trim();

  /* 来源可追溯性（空值语义说明）：
   * source_session 与 source_turn 为 NULL 是完全合法且符合设计的正常行为：
   * 1. 客户端未携带会话标识头（如 curl 或单次脚本调用）；
   * 2. 请求体缺少 user 消息或单次非对话式调用；
   * 3. 离线/测试直接调用 processDialogueAndHarvest。
   * 严禁无会话信息时伪造虚假数据，拿不到时必须为 NULL。
   * 严格截断至至多 128 字符（契合 VARCHAR 128 限制）。
   */
  const rawSession = (meta && meta.session && String(meta.session).trim()) || "";
  const sourceSession = rawSession ? rawSession.slice(0, 128) : null;
  const parsedTurn = meta && (typeof meta.turn === "number" ? meta.turn : (meta.turn ? Number(meta.turn) : null));
  const sourceTurn = (typeof parsedTurn === "number" && !isNaN(parsedTurn) && parsedTurn >= 1) ? Math.floor(parsedTurn) : null;

  // 严禁在测试环境中向 global 真实写入
  if (project === "global" && isTestMode()) {
    return { memoriesSaved: 0, pitfallsSaved: 0, pendingSaved: 0, skipped: true, reason: "test environment blocked global write" };
  }

  // 双轨制：显式记忆沉淀指令直接穿透门禁
  const isExplicit = isExplicitUserMemory(dialogueText) || options.bypass_gate === true;

  // 门槛按内容的重复特性区分（对齐 Headroom traffic_learner 设计哲学）：
  // - 踩坑 / 命令重试：属于重复出现的报错模式，保留门禁（默认 3 次才落盘）
  // - 事实 / 偏好 / 决策 / 环境画像：低频高价值知识（通常只陈述一次），门槛默认为 1（不设门禁直接入库）
  const minEvidencePitfall = typeof options.min_evidence_pitfall === "number"
    ? options.min_evidence_pitfall
    : (typeof options.min_evidence === "number"
      ? options.min_evidence
      : (typeof meta.min_evidence === "number" ? meta.min_evidence : DEFAULT_MIN_EVIDENCE));

  const minEvidenceMemory = typeof options.min_evidence_memory === "number"
    ? options.min_evidence_memory
    : 1;

  // 提取事实与踩坑候选：完全由用户在设置中指定的在线模型提炼
  const extractModel = String(options.extract_model || options.harvest_model || "").trim();
  if (!extractModel || extractModel === "off" || extractModel === "none") {
    // 未配置提炼模型：明确跳过本次采集并记录诊断日志，绝不静默、绝不偷偷使用写死模型、绝不回退规则
    _diag("harvest_skipped", "未配置提炼模型 (extract_model 为空)，安全跳过本次采集");
    return {
      memoriesSaved: 0,
      pitfallsSaved: 0,
      pendingSaved: 0,
      skipped: true,
      reason: "unconfigured_extract_model",
    };
  }

  let facts = [];
  let decisions = [];
  let failures = [];

  try {
    // 1. 分类模型快速过滤（若用户配置）
    const classRes = await classifyDialogueWithOnlineModel(dialogueText, options);
    if (classRes && !classRes.shouldHarvest) {
      _diag("classify_negative", `score=${classRes.score}`);
      return {
        memoriesSaved: 0,
        pitfallsSaved: 0,
        pendingSaved: 0,
        skipped: true,
        reason: "classified_negative",
        score: classRes.score,
      };
    }

    // 2. 在线模型结构化提炼
    const onlineRes = await harvestWithOnlineModel(dialogueText, options);
    if (onlineRes === null) {
      // 提炼模型不可用或异常：安全跳过本次采集并留一行诊断日志，绝不回退启发式规则
      _diag("harvest_unavailable_skip", "提炼模型服务不可用或异常，安全跳过本次采集");
      return {
        memoriesSaved: 0,
        pitfallsSaved: 0,
        pendingSaved: 0,
        skipped: true,
        reason: "online_harvest_unavailable",
      };
    }

    for (const m of onlineRes.memories) {
      if (m.category === "decision") decisions.push(m);
      else facts.push(m);
    }
    failures = onlineRes.pitfalls;
  } catch (err) {
    _diag("online_harvest_err", (err && err.message) || String(err));
    return {
      memoriesSaved: 0,
      pitfallsSaved: 0,
      pendingSaved: 0,
      skipped: true,
      reason: "online_harvest_exception",
    };
  }

  // 核心安全红线：彻底切断启发式兜底回退！
  // 绝不因模型未产出或不可用而静默切回规则制造伪踩坑噪音（fail-open 的正确含义是跳过本次，绝非换一套会制造噪音的规则）

  let memoriesSaved = 0;
  let pitfallsSaved = 0;
  let pendingSaved = 0;

  // 1. 入库 memories（环境事实与架构决策）
  // 关键：事实与架构决策是低频高价值知识（通常只陈述一次），门槛默认为 1（直接入库，不设门禁）
  // 若显式传入 minEvidenceMemory > 1 且非显式表达，则受控进入 pending 证据门禁
  const memoryCandidates = facts.concat(decisions);
  for (const item of memoryCandidates) {
    const title = String(item.title || "").trim();
    const content = String(item.content || "").trim();
    if (!title || !content) continue;

    const fp = semanticFingerprint(project, item.category || "fact", title, content, item.tags);
    const memKey = `m:${project}:${fp}`;
    if (isRecentTurn(memKey)) continue;

    // 门禁按类型区分：非显式表达且显式指定了 minEvidenceMemory > 1 时进入 pending 门禁
    if (!isExplicit && minEvidenceMemory > 1) {
      const pendingRes = recordPendingEvidence(memKey, { ...item, project, agent }, {
        kind: "memory",
        minEvidence: minEvidenceMemory,
        turnKey: turnFingerprint(dialogueText.slice(0, 300)),
      });
      if (!pendingRes.shouldGraduate) {
        pendingSaved++;
        continue;
      }
    }

    // 1. 入库 memories（环境事实与架构决策）
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const queueId = `hq_m_${fp}`;
    const memoryPayload = {
      project,
      category: item.category || "fact",
      scope_level: item.scope_level || "project",
      client: agent,
      origin: "harvest",
      title,
      content,
      full_text: content,
      tags: item.tags || "auto-harvest",
      related_entities: item.related_entities ? String(item.related_entities).trim() : "",
      content_fingerprint: fp,
      confidence: typeof item.confidence === "number" ? (item.confidence > 1 ? item.confidence / 100 : item.confidence) : 0.8,
      confidence_score: Math.round(((typeof item.confidence === "number" ? (item.confidence > 1 ? item.confidence / 100 : item.confidence) : 0.8)) * 100),
      lifecycle_status: "active",
      superseded_by_id: null,
      revision: 1,
      recurrence: 1,
      retrieval_count: 0,
      created_at: now,
      updated_at: now,
      invalid_at: null,
      invalid_reason: "",
      expires_at: null,
      last_used_at: null,
      source_session: sourceSession,
      source_turn: sourceTurn,
    };
    safeEnqueueHarvestItems([{ id: queueId, table: "memories", data: memoryPayload, project, fp }]);
    if (recentFingerprints.size >= RECENT_CAP) { o = recentFingerprints.keys().next().value; if (o) recentFingerprints.delete(o); }
    recentFingerprints.set(memKey, Date.now());
    memoriesSaved++;
  }

  // 2. 入库 pitfalls（踩坑与失败规避）
  const turnKey = turnFingerprint(dialogueText.slice(0, 300));
  for (const item of failures) {
    const component = String(item.component || (item.tags && item.tags.split(",")[0]) || "general").trim();
    const symptom = String(item.symptom || item.title || "").trim();
    if (!symptom) continue;

    const fp = item.content_fingerprint || semanticFingerprint(project, "pitfall", component, symptom);
    const pitKey = `p:${project}:${fp}`;
    if (isRecentTurn(pitKey)) continue;

    let recurrence = 1;
    // P0 证据门禁：非显式表达必须在 pending 累计达到 minEvidencePitfall（同一轮次 turnKey 去重）
    if (!isExplicit && minEvidencePitfall > 1) {
      const pendingRes = recordPendingEvidence(pitKey, { ...item, project, agent, component, symptom }, {
        kind: "pitfall",
        minEvidence: minEvidencePitfall,
        turnKey,
      });
      if (!pendingRes.shouldGraduate) {
        pendingSaved++;
        continue;
      }
      recurrence = pendingRes.count;
    }

    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const queueId = `hq_p_${fp}`;
    const rootCause = item.root_cause ? String(item.root_cause).trim() : "";
    const solution = item.solution ? String(item.solution).trim() : (item.content ? String(item.content).trim() : "");
    const pitfallPayload = {
      project,
      client: agent,
      component,
      symptom,
      root_cause: rootCause,
      solution: solution,
      severity: item.severity || "medium",
      error_type: item.error_type || "general",
      tags: item.tags || "auto-harvest,gateway",
      related_entities: item.related_entities ? String(item.related_entities).trim() : "",
      content_fingerprint: fp,
      recurrence,
      created_at: now,
      updated_at: now,
      invalid_at: null,
      invalid_reason: "",
      last_occurred_at: now,
      source_session: sourceSession,
      source_turn: sourceTurn,
    };
    safeEnqueueHarvestItems([{ id: queueId, table: "pitfalls", data: pitfallPayload, project, fp }]);
    if (recentFingerprints.size >= RECENT_CAP) { o = recentFingerprints.keys().next().value; if (o) recentFingerprints.delete(o); }
    recentFingerprints.set(pitKey, Date.now());
    pitfallsSaved++;
  }

  _diag("pipeline", "client=" + (client ? "有" : "无") + " memoriesSaved=" + memoriesSaved +
    " pitfallsSaved=" + pitfallsSaved + " pending=" + pendingSaved +
    " queue=" + (typeof readHarvestQueue === "function" ? (readHarvestQueue() || []).length : "?"));

  // 若传入了 client，由唯一受控的消费器统一执行落库（防并发重入与重复插入）
  let memoriesEnriched = 0;
  let pitfallsEvolved = 0;
  if (client && !client._isNoCredentials) {
    try {
      const drainRes = await triggerBackgroundDrain(client, options);
      _diag("drain", JSON.stringify(drainRes).slice(0, 200));
      if (drainRes && !drainRes.inProgress) {
        if (typeof drainRes.memoriesSaved === "number") {
          memoriesSaved = drainRes.memoriesSaved;
        }
        if (typeof drainRes.pitfallsSaved === "number") {
          pitfallsSaved = drainRes.pitfallsSaved;
        }
        if (typeof drainRes.memoriesEnriched === "number") {
          memoriesEnriched = drainRes.memoriesEnriched;
        }
        if (typeof drainRes.pitfallsEvolved === "number") {
          pitfallsEvolved = drainRes.pitfallsEvolved;
        }
      }
    } catch (_) {}
  }

  return { memoriesSaved, pitfallsSaved, memoriesEnriched, pitfallsEvolved, pendingSaved, skipped: false };
}

let _isDraining = false;
export async function triggerBackgroundDrain(client, options = {}) {
  if (!client || _isDraining) return { processed: 0, memoriesSaved: 0, pitfallsSaved: 0, inProgress: _isDraining };
  _isDraining = true;
  let totalMemoriesSaved = 0;
  let totalPitfallsSaved = 0;
  let totalMemoriesEnriched = 0;
  let totalPitfallsEvolved = 0;
  const actions = { CREATED: 0, ENRICHED: 0, EVOLVED: 0, NOOP: 0 };

  let hubInstance = null;
  const safeClient = {
    ...client,
    update: client.update ? client.update.bind(client) : async () => ({ affectedRows: 0 }),
  };

  async function getHub() {
    // 直接导入 saveMemory/pitfallSave，不再经过 Hub 工厂（解除循环依赖）
    if (!hubInstance) {
      hubInstance = {
        tool: {
          memory_save: { execute: async (data, ctx) => {
            const res = await saveMemory(safeClient, (options && options.cfg) || {}, data, ctx);
            return typeof res === "string" ? res : JSON.stringify(res);
          }},
          pitfall_save: { execute: async (data, ctx) => {
            const res = await pitfallSave(safeClient, (options && options.cfg) || {}, data, ctx);
            return typeof res === "string" ? res : JSON.stringify(res);
          }},
        },
      };
    }
    return hubInstance;
  }

  async function callSaveMemory(data, ctx) {
    if (options && typeof options.saveMemory === "function") {
      if (options.saveMemory.length >= 3) {
        return await options.saveMemory(safeClient, (options && options.cfg) || {}, data, ctx);
      }
      return await options.saveMemory(data, ctx);
    }
    const h = await getHub();
    const res = await h.tool.memory_save.execute(data, ctx);
    return typeof res === "string" ? JSON.parse(res) : res;
  }

  async function callPitfallSave(data, ctx) {
    if (options && typeof options.pitfallSave === "function") {
      if (options.pitfallSave.length >= 3) {
        return await options.pitfallSave(safeClient, (options && options.cfg) || {}, data, ctx);
      }
      return await options.pitfallSave(data, ctx);
    }
    const h = await getHub();
    const res = await h.tool.pitfall_save.execute(data, ctx);
    return typeof res === "string" ? JSON.parse(res) : res;
  }

  try {
    let totalProcessed = 0;
    while (true) {
      const queue = readHarvestQueue();
      if (!queue || queue.length === 0) break;
      let batchSuccess = 0;
      const successIds = [];
      const deadLetterIds = [];
      for (const item of queue) {
        try {
          if (item.table === "memories") {
            const project = item.project || item.data?.project || "global";
            const rawData = item.data || {};
            const rawConf = rawData.confidence !== undefined
              ? rawData.confidence
              : (rawData.confidence_score !== undefined ? (Number(rawData.confidence_score) > 1 ? Number(rawData.confidence_score) / 100 : Number(rawData.confidence_score)) : 0.8);
            const memPayload = {
              ...rawData,
              project,
              confidence: typeof rawConf === "number" && !isNaN(rawConf) ? (rawConf > 1 ? rawConf / 100 : rawConf) : 0.8,
            };
            const ctx = {
              agent: memPayload.client,
              session: memPayload.source_session,
              turn: memPayload.source_turn,
            };
            const res = await callSaveMemory(memPayload, ctx);
            const act = String((res && (res.action || (res.status ? res.status : ""))) || "").toUpperCase();
            _diag("drain_action", `item ${item.id} table=memories action=${act || "UNKNOWN"} id=${res && res.id}`);

            if (act === "ADD" || act === "CREATED" || act === "UPDATE") {
              totalMemoriesSaved++;
              actions.CREATED = (actions.CREATED || 0) + 1;
            } else if (act === "ENRICHED") {
              totalMemoriesEnriched++;
              actions.ENRICHED = (actions.ENRICHED || 0) + 1;
              _diag("drain_enriched", `item ${item.id} memory enriched id=${res.id} recurrence=${res.recurrence} rev=${res.revision}`);
            } else {
              actions.NOOP = (actions.NOOP || 0) + 1;
            }
            if (res && (res.crystallized || (res.category === "principle" && memPayload.category !== "principle"))) {
              _diag("drain_crystallized", `item ${item.id} memory crystallized into principle id=${res.id}`);
            }
            const fp = item.fp || item.data?.content_fingerprint || "";
            if (fp) markRecentTurn(`m:${project}:${fp}`);
            successIds.push(item.id);
            batchSuccess++;
          } else if (item.table === "pitfalls") {
            const project = item.project || item.data?.project || "global";
            const pitPayload = {
              ...item.data,
              project,
            };
            const ctx = {
              agent: pitPayload.client,
              session: pitPayload.source_session,
              turn: pitPayload.source_turn,
            };
            const res = await callPitfallSave(pitPayload, ctx);
            const act = String((res && (res.action || (res.status ? res.status : ""))) || "").toUpperCase();
            _diag("drain_action", `item ${item.id} table=pitfalls action=${act || "UNKNOWN"} id=${res && res.id}`);

            if (act === "ADD" || act === "CREATED") {
              totalPitfallsSaved++;
              actions.CREATED = (actions.CREATED || 0) + 1;
            } else if (act === "EVOLVED") {
              totalPitfallsEvolved++;
              actions.EVOLVED = (actions.EVOLVED || 0) + 1;
              _diag("drain_evolved", `item ${item.id} pitfall evolved id=${res.id} recurrence=${res.recurrence} reason=${res.reason || ""}`);
            } else {
              actions.NOOP = (actions.NOOP || 0) + 1;
            }
            const fp = item.fp || item.data?.content_fingerprint || "";
            if (fp) markRecentTurn(`p:${project}:${fp}`);
            successIds.push(item.id);
            batchSuccess++;
          }
        } catch (itemErr) {
          const msg = String((itemErr && itemErr.message) || itemErr || "");
          if (/duplicate|ER_DUP_ENTRY|already exists|1062/i.test(msg)) {
            const fp = item.fp || item.data?.content_fingerprint || "";
            const project = item.project || item.data?.project || "global";
            if (fp) markRecentTurn((item.table === "pitfalls" ? "p:" : "m:") + project + ":" + fp);
            successIds.push(item.id);
            batchSuccess++;
            actions.NOOP = (actions.NOOP || 0) + 1;
            _diag("drain_action", `item ${item.id} duplicate index caught, marked as NOOP`);
          } else {
            const currentRetries = (Number(item.retries) || 0) + 1;
            item.retries = currentRetries;
            if (currentRetries >= 3 && !deadLetterIds.includes(item.id)) {
              deadLetterIds.push(item.id);
              _diag("dead_letter_evicted", `item ${item.id} table=${item.table} retries=${currentRetries} err=${msg.slice(0, 100)}`);
            } else {
              updateHarvestItemRetries(item.id, msg);
            }
          }
        }
      }
      const toRemove = [...successIds, ...deadLetterIds];
      if (toRemove.length > 0) {
        removeHarvestItems(toRemove);
      }
      totalProcessed += batchSuccess;
      if (batchSuccess === 0 && deadLetterIds.length === 0) {
        break;
      }
    }
    return {
      processed: totalProcessed,
      memoriesSaved: totalMemoriesSaved,
      pitfallsSaved: totalPitfallsSaved,
      memoriesEnriched: totalMemoriesEnriched,
      pitfallsEvolved: totalPitfallsEvolved,
      actions,
    };
  } finally {
    _isDraining = false;
  }
}
