/**
 * 模块职责：记忆核心写入事务处理（指纹去重、语义去重、时序版本链 supersede 与冲突检测）
 * 依赖：src/core/**, src/integration/**, scrub.js, semantic_dedup.js
 * 被依赖：src/tools/memory-save.js, src/index.js
 */

import { CATEGORIES, SCOPES, FETCH_LIMIT, nowSql, expiresAtFor } from "../../core/config.js";
import { markRecent, justWritten } from "../../core/state-recent.js";
import { rowsOf, fetchAll } from "../../integration/ncb.js";
import { freshness } from "../../domain/scoring.js";
import { scrubSecrets } from "../../core/sanitize.js";
import {
  normalizeSemanticText,
  semanticFingerprint,
  isSemanticallySimilar,
  findSemanticDuplicate,
  tokenize,
  overlapCoefficient,
  jaccardSimilarity,
  hasConflictingNumbers,
} from "../../domain/semantic-dedup.js";

export async function saveMemory(client, cfg, m, ctx) {
  const project = String(m.project || "global").trim();
  const category = CATEGORIES.includes(m.category) ? m.category : "fact";
  const scopeLevel = SCOPES.includes(m.scope_level) ? m.scope_level : "project";
  const callerAgent = (ctx && (ctx.agent || (ctx._ctx && ctx._ctx.agent))) || "";
  const clientVal = (m.client && String(m.client).trim())
    || (callerAgent && String(callerAgent).trim())
    || (m.agent && String(m.agent).trim())
    || "unknown";
  const origin = String(m.origin || "tool").trim();
  const rawTitle = String(m.title || "").trim();
  const rawContent = String(m.content || "").trim();
  if (!rawTitle) throw new Error("title 不能为空");
  if (!rawContent) throw new Error("content 不能为空");

  const title = scrubSecrets(rawTitle);
  const content = scrubSecrets(rawContent);
  const fullText = (m.full_text != null && String(m.full_text).trim() !== "")
    ? scrubSecrets(String(m.full_text))
    : content;
  const tags = scrubSecrets(String(m.tags || "").trim().toLowerCase());
  const relatedEntities = scrubSecrets(String(m.related_entities || "").trim());
  const rawConf = typeof m.confidence === "number"
    ? m.confidence
    : (m.confidence !== undefined && m.confidence !== null && m.confidence !== "" && !isNaN(Number(m.confidence)) ? Number(m.confidence) : 1);
  let confidence = rawConf <= 1 ? Math.round(rawConf * 100) : Math.round(rawConf);
  confidence = Math.max(0, Math.min(100, confidence));

  const callerSession = (ctx && (ctx.session || (ctx._ctx && ctx._ctx.session))) || "";
  const callerTurn = (ctx && (typeof ctx.turn === "number" ? ctx.turn : (ctx._ctx && typeof ctx._ctx.turn === "number" ? ctx._ctx.turn : null)));
  const rawSession = (m.source_session && String(m.source_session).trim())
    || (callerSession && String(callerSession).trim())
    || "";
  const sourceSession = rawSession ? rawSession.slice(0, 128) : null;
  const parsedTurn = typeof m.source_turn === "number" ? m.source_turn : (m.source_turn ? Number(m.source_turn) : null);
  const sourceTurn = (typeof parsedTurn === "number" && !isNaN(parsedTurn) && parsedTurn >= 1)
    ? Math.floor(parsedTurn)
    : (callerTurn && callerTurn >= 1 ? Math.floor(callerTurn) : null);

  const initialRecurrence = typeof m.recurrence === "number" && m.recurrence >= 1 ? Math.floor(m.recurrence) : 1;
  const fp = (m.content_fingerprint && String(m.content_fingerprint).trim()) || semanticFingerprint(project, category, title, content, tags);

  // 0) 进程内近期写入 → 挡掉写后读延迟窗口里的重复
  if (justWritten("m:" + project + ":" + fp) || justWritten("m:" + fp)) {
    return { action: "NOOP", id: null, note: "刚刚写入过（写后读延迟窗口内），已忽略重复" };
  }

  // 1) 候选集拉取（按 project + lifecycle_status='active' 过滤，按 updated_at DESC 排序）
  const queryParams = { project, lifecycle_status: "active", order_by: "updated_at DESC", limit: FETCH_LIMIT };
  const allActiveRows = rowsOf(await client.list("memories", queryParams));
  let categoryRows = allActiveRows.filter((r) => !category || r.category === category);

  // BUG-38-2 / BUG-39-2: 支持显式指定 supersede_id（严格校验项目归属与有效性，前置到踩坑优先拦截之前）
  const hasSupersedeParam = m.supersede_id !== undefined && m.supersede_id !== null && m.supersede_id !== "";
  const targetSupersedeId = (hasSupersedeParam && !isNaN(Number(m.supersede_id)) && Number(m.supersede_id) > 0)
    ? Number(m.supersede_id)
    : null;
  let targetSupersedeRow = targetSupersedeId
    ? allActiveRows.find((r) =>
        r.id === targetSupersedeId &&
        r.project === project &&
        !r.invalid_at &&
        (!r.lifecycle_status || r.lifecycle_status === "active")
      )
    : null;
  if (targetSupersedeId && !targetSupersedeRow) {
    try {
      const fetched = rowsOf(await client.list("memories", { id: targetSupersedeId, limit: 1 }));
      if (fetched.length > 0) {
        const cand = fetched[0];
        if (cand && cand.project === project && !cand.invalid_at
            && (!cand.lifecycle_status || cand.lifecycle_status === "active")) {
          targetSupersedeRow = cand;
        }
      }
    } catch (_) {}
  }
  if (hasSupersedeParam && (!targetSupersedeId || !targetSupersedeRow)) {
    return {
      action: "NOOP",
      id: null,
      note: "supersede_id 指向不存在/跨项目/已失效的记录，已忽略取代意图",
    };
  }
  const hasValidSupersede = Boolean(targetSupersedeId && targetSupersedeRow);

  // 0.5) A③ 踩坑优先：检查 pitfalls 表中是否已存在该工程问题（principle 准则豁免，且显式 supersede 时跳过）
  if (category !== "principle" && !hasValidSupersede) {
    try {
      const pitfallRows = rowsOf(await client.list("pitfalls", { project, limit: FETCH_LIMIT }));
      const normTitle = normalizeSemanticText(title);
      const matchedPitfall = pitfallRows.find((p) => {
        if (p.invalid_at) return false;
        if (p.lifecycle_status && p.lifecycle_status !== "active") return false;
        if (hasConflictingNumbers(title, p.symptom)) return false;
        const pSym = normalizeSemanticText(p.symptom);
        if (pSym && (pSym === normTitle || normTitle.includes(pSym) || pSym.includes(normTitle))) {
          if (!hasConflictingNumbers(title, p.symptom)) return true;
        }
        const tTok = tokenize(title);
        const sTok = tokenize(p.symptom);
        if (overlapCoefficient(tTok.tokens, sTok.tokens) >= 0.5 || jaccardSimilarity(tTok.tokens, sTok.tokens) >= 0.3) {
          if (!hasConflictingNumbers(title, p.symptom)) return true;
        }
        return isSemanticallySimilar(title, content, p.symptom, p.solution || p.root_cause);
      });
      if (matchedPitfall) {
        const next = (Number(matchedPitfall.recurrence) || 1) + initialRecurrence;
        const now = nowSql();
        try {
          await client.update("pitfalls", matchedPitfall.id, {
            recurrence: next,
            last_occurred_at: now,
            updated_at: now,
          });
          markRecent("p:" + (matchedPitfall.content_fingerprint || fp));
          return {
            action: "NOOP",
            id: matchedPitfall.id,
            table: "pitfalls",
            recurrence: next,
            note: `踩坑优先：该问题在 pitfalls 表中已存在（id=${matchedPitfall.id}），以踩坑记录为准，累加踩坑复发计数，不重复写入 memories`,
          };
        } catch (e) {
          if (!/404|not found/i.test(String(e.message))) throw e;
        }
      }
    } catch (_) {
      // fail-open
    }
  }

  // 当 targetSupersedeId 有效时，跳过 dup 与 crossDup 的 NOOP 短路（显式取代是最高优先级意图）
  const isTransientBatonOrMail = /\b(?:handoff:open|mail:unread)\b/i.test(tags);
  // 当 targetSupersedeId 有效或为交接棒/信件时，跳过常规 dup 与 crossDup 检查
  if (!hasValidSupersede && !isTransientBatonOrMail) {
    // 2) Layer ① 语义指纹查重 + Layer ② 局部滑动窗口语义相似度比对
    const dup = findSemanticDuplicate(categoryRows, title, content, fp);
  if (dup) {
    const next = (Number(dup.recurrence) || 1) + initialRecurrence;
    const now = nowSql();

    // EVO-1: 智能增量扩充检测（同标题重复 + 无数字冲突 + 信息量增长 ≥ 1.25 或显式传 supersede: true）
    const normNewTitle = normalizeSemanticText(title);
    const normOldTitle = normalizeSemanticText(dup.title);
    const isSameTitle = (normNewTitle && normNewTitle === normOldTitle) ||
      (String(dup.title || "").trim().toLowerCase() === String(title || "").trim().toLowerCase());

    const noNumberConflict = !hasConflictingNumbers(title, dup.title) &&
      !hasConflictingNumbers(content, dup.content || dup.full_text || "");

    const oldContentStr = String(dup.content || dup.full_text || "").trim();
    const newContentStr = String(content || "").trim();
    const hasSignificantGrowth = newContentStr.length >= (oldContentStr.length * 1.25);
    const isExplicitSupersede = m.supersede === true || m.supersede === "true";

    // BUG-3: 命中 dup 时，即便标题不一致（isSameTitle 为 false），只要显式传 supersede: true，也必须进入 ENRICHED 融合路径
    const shouldEnrich = noNumberConflict && (isExplicitSupersede || (isSameTitle && hasSignificantGrowth));

    // EVO-4: 高频经验自动升维结晶（preference / decision 且 recurrence 达到阈值且 confidence_score ≥ 80）
    const crystallizationThreshold = Number(m.crystallization_threshold ?? cfg?.crystallization_threshold ?? 5) || 5;
    const isCrystallizable = ["preference", "decision"].includes(String(dup.category || "").toLowerCase());
    const effectiveConfidence = (m.confidence !== undefined && m.confidence !== null && m.confidence !== "")
      ? confidence
      : (dup.confidence_score != null ? Number(dup.confidence_score) : confidence);
    const isCrystallized = isCrystallizable && (next >= crystallizationThreshold) && (effectiveConfidence >= 80);
    const targetCategory = isCrystallized ? "principle" : dup.category;

    if (shouldEnrich) {
      const mergedContent = (newContentStr.length >= oldContentStr.length) ? content : (dup.content || content);
      const oldFullTextStr = String(dup.full_text || dup.content || "").trim();
      const newFullTextStr = String(fullText || "").trim();
      const mergedFullText = (newFullTextStr.length >= oldFullTextStr.length) ? fullText : (dup.full_text || fullText);

      const existingTags = String(dup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const newTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const mergedTags = Array.from(new Set([...existingTags, ...newTags])).join(", ");

      const existingEntities = String(dup.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
      const newEntities = String(relatedEntities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
      const mergedEntities = Array.from(new Set([...existingEntities, ...newEntities])).join(", ");

      const nextRevision = (Number(dup.revision) || 1) + 1;
      const targetTitle = (isExplicitSupersede && title) ? title : dup.title;
      const newFp = semanticFingerprint(project, targetCategory, targetTitle, mergedContent, mergedTags);

      const updatePayload = {
        title: targetTitle,
        content: mergedContent,
        full_text: mergedFullText,
        tags: mergedTags || dup.tags,
        related_entities: mergedEntities || dup.related_entities,
        recurrence: next,
        revision: nextRevision,
        updated_at: now,
      };
      if (isCrystallized) {
        updatePayload.category = "principle";
      }
      if (newFp) {
        updatePayload.content_fingerprint = newFp;
      }

      try {
        await client.update("memories", dup.id, Object.assign({}, updatePayload, { updated_at: updatePayload.updated_at || nowSql() }));
        markRecent("m:" + (newFp || dup.content_fingerprint || fp)); markRecent("m:" + project + ":" + (newFp || dup.content_fingerprint || fp));
        return {
          action: "ENRICHED",
          id: dup.id,
          category: targetCategory,
          recurrence: next,
          revision: nextRevision,
          retrieval_count: Number(dup.retrieval_count) || 0,
          note: isCrystallized
            ? "智能增量扩充成功，融合更详尽细节，已升维为 principle"
            : "智能增量扩充成功，融合更详尽细节，保留原记忆ID并递增版本",
        };
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    } else {
      // BUG-3: NOOP 分支除了 recurrence/updated_at，还要把本次传入的 tags 与 related_entities 取并集回写
      const existingTags = String(dup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const incomingTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const mergedTags = Array.from(new Set([...existingTags, ...incomingTags])).join(", ");

      const existingEntities = String(dup.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
      const incomingEntities = String(relatedEntities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
      const mergedEntities = Array.from(new Set([...existingEntities, ...incomingEntities])).join(", ");

      const updatePayload = {
        recurrence: next,
        tags: mergedTags || dup.tags,
        related_entities: mergedEntities || dup.related_entities,
        updated_at: now,
      };
      if (isCrystallized) {
        updatePayload.category = "principle";
        const newFp = semanticFingerprint(project, "principle", dup.title, dup.content, mergedTags || dup.tags);
        if (newFp) updatePayload.content_fingerprint = newFp;
      }
      try {
        await client.update("memories", dup.id, Object.assign({}, updatePayload, { updated_at: updatePayload.updated_at || nowSql() }));
        markRecent("m:" + (updatePayload.content_fingerprint || dup.content_fingerprint || fp)); markRecent("m:" + project + ":" + (updatePayload.content_fingerprint || dup.content_fingerprint || fp));
        const baseNote = dup.content_fingerprint === fp ? "内容未变化，累加复发计数" : "语义相似去重命中，累加复发计数";
        const note = isCrystallized ? (baseNote + "，已升维为 principle") : baseNote;
        return {
          action: "NOOP",
          id: dup.id,
          category: targetCategory,
          recurrence: next,
          retrieval_count: Number(dup.retrieval_count) || 0,
          note,
        };
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    }
  }

  // 2.1) A② 跨类别去重：同 project + 归一化 title + 不同 category
  const normTitle = normalizeSemanticText(title);
  const otherCategoryRows = allActiveRows.filter((r) => r.category !== category);
  const crossDup = otherCategoryRows.find((r) => {
    if (hasConflictingNumbers(title, r.title)) return false;
    if (hasConflictingNumbers(content, r.content || r.full_text || "")) return false;
    const rNormTitle = normalizeSemanticText(r.title);
    if (rNormTitle && rNormTitle === normTitle) return true;
    return isSemanticallySimilar(title, content, r.title, r.content || r.full_text);
  });

  if (crossDup) {
    const next = (Number(crossDup.recurrence) || 1) + initialRecurrence;
    const now = nowSql();
    const existingTags = String(crossDup.tags || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
    const newTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
    const mergedTags = Array.from(new Set([...existingTags, ...newTags])).join(", ");

    const existingEntities = String(crossDup.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
    const newEntities = String(relatedEntities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
    const mergedEntities = Array.from(new Set([...existingEntities, ...newEntities])).join(", ");

    // 【P1-3】principle 准则保护：若新记录是 principle 且旧记录不是 principle，
    // 升级旧记录为 principle 并保留准则内容与指纹，绝不允许把 principle 降级为普通分类
    const isNewPrinciple = category === "principle" && crossDup.category !== "principle";

    // EVO-4: 升维保护
    const crystallizationThreshold = Number(m.crystallization_threshold ?? cfg?.crystallization_threshold ?? 5) || 5;
    const isCrystallizable = ["preference", "decision"].includes(String(crossDup.category || "").toLowerCase()) ||
                             ["preference", "decision"].includes(String(category || "").toLowerCase());
    const effectiveConfidence = (m.confidence !== undefined && m.confidence !== null && m.confidence !== "")
      ? confidence
      : (crossDup.confidence_score != null ? Number(crossDup.confidence_score) : confidence);
    const isCrystallized = !isNewPrinciple && isCrystallizable && (next >= crystallizationThreshold) && (effectiveConfidence >= 80);

    const targetCategory = (isNewPrinciple || isCrystallized) ? "principle" : crossDup.category;

    const updatePayload = {
      recurrence: next,
      tags: mergedTags || crossDup.tags,
      related_entities: mergedEntities || crossDup.related_entities,
      updated_at: now,
    };
    if (isNewPrinciple) {
      updatePayload.category = "principle";
      if (content) updatePayload.content = content;
      if (fullText) updatePayload.full_text = fullText;
      if (title) updatePayload.title = title;
      if (fp) updatePayload.content_fingerprint = fp;
    } else if (isCrystallized) {
      updatePayload.category = "principle";
      const newFp = semanticFingerprint(project, "principle", crossDup.title, crossDup.content, mergedTags || crossDup.tags);
      if (newFp) updatePayload.content_fingerprint = newFp;
    }

    try {
      await client.update("memories", crossDup.id, Object.assign({}, updatePayload, { updated_at: now }));
      markRecent("m:" + (fp || crossDup.content_fingerprint)); markRecent("m:" + project + ":" + (fp || crossDup.content_fingerprint));
      let crossNote = isNewPrinciple
        ? ("跨类别去重命中（既有记录分类: " + crossDup.category + " 已升级为 principle），已保留准则版本并累加复发计数")
        : ("跨类别去重命中（既有记录分类: " + crossDup.category + "，传入分类: " + category + "），已合并至既有记录并累加复发计数");
      if (isCrystallized) {
        crossNote += "，已升维为 principle";
      }
      return {
        action: "NOOP",
        id: crossDup.id,
        category: targetCategory,
        recurrence: next,
        retrieval_count: Number(crossDup.retrieval_count) || 0,
        note: crossNote,
      };
    } catch (e) {
      if (!/404|not found/i.test(String(e.message))) throw e;
    }
  }
  }

  // 3) 按标题版本链取代与构建修订版本号
  const superseded = categoryRows.filter(
    (r) =>
      r.lifecycle_status === "active" &&
      !r.invalid_at &&
      String(r.title || "").trim().toLowerCase() === title.toLowerCase()
  );

  const baseRevision = superseded.reduce(function (mx, r) { return Math.max(mx, Number(r.revision) || 1); }, 0);
  const explicitRevision = targetSupersedeRow ? (Number(targetSupersedeRow.revision) || 1) : 0;
  const newRevision = Math.max(baseRevision, explicitRevision) + 1;

  const payload = {
    project,
    category,
    scope_level: scopeLevel,
    client: clientVal,
    origin,
    title,
    content,
    full_text: fullText,
    tags,
    related_entities: relatedEntities,
    content_fingerprint: fp,
    confidence_score: confidence,
    lifecycle_status: "active",
    /* 【外键列，必须写 NULL 而非 0】
     * NCB 会按 `*_id` 列名自动建外键：superseded_by_id → memories.id。
     * 写 0 会触发外键违约（没有 id=0 的行），整个 memory_save 直接失败。
     * NULL 是外键的合法值，语义也正是「未被任何行取代」。 */
    superseded_by_id: null,
    /* 修订版本号 = 被取代那批里最大的修订号 + 1。没有旧版时就是 1。 */
    revision: newRevision,
    recurrence: initialRecurrence,
    retrieval_count: 0,
    invalid_at: null,
    invalid_reason: '',
    // 会话级/轮次级记忆带 TTL（默认 7 / 1 天）；project/user 级永不过期
    expires_at: expiresAtFor(scopeLevel),
    last_used_at: null,
    /* 【必须显式写时间戳】实测 NCB 不生效 DEFAULT CURRENT_TIMESTAMP，
     * 省略这两列会落库为 NULL —— 而 freshness() 依赖它们，会永远返回 0。 */
    created_at: nowSql(),
    updated_at: nowSql(),
    source_session: sourceSession,
    source_turn: sourceTurn,
  };

  /* 数据库上有 (project, content_fingerprint) 唯一索引：它才是去重的最终保证，
   * 因为 NCB 的读有约 2 秒写后可见延迟，靠「先读后写」会漏掉并发/紧邻的重复。
   * 被索引拦下时按 NOOP 处理，不向上抛错。 */
  let created;
  try {
    created = await client.create("memories", payload);
  } catch (e) {
    if (/duplicate entry/i.test(String(e.message))) {
      markRecent("m:" + project + ":" + fp); markRecent("m:" + fp);
      const dupRow = rowsOf(await client.list("memories", { project, limit: FETCH_LIMIT })).filter(
        (r) => r.content_fingerprint === fp
      )[0];
      if (dupRow) {
        const next = (Number(dupRow.recurrence) || 1) + initialRecurrence;
        const crystallizationThreshold = Number(m.crystallization_threshold ?? cfg?.crystallization_threshold ?? 5) || 5;
        const isCrystallizable = ["preference", "decision"].includes(String(dupRow.category || "").toLowerCase());
        const effectiveConfidence = (m.confidence !== undefined && m.confidence !== null && m.confidence !== "")
          ? confidence
          : (dupRow.confidence_score != null ? Number(dupRow.confidence_score) : confidence);
        const isCrystallized = isCrystallizable && (next >= crystallizationThreshold) && (effectiveConfidence >= 80);
        const targetCategory = isCrystallized ? "principle" : dupRow.category;

        const existingTags = String(dupRow.tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const incomingTags = String(tags || "").split(/[,;\s，、]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const mergedTags = Array.from(new Set([...existingTags, ...incomingTags])).join(", ");

        const existingEntities = String(dupRow.related_entities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
        const incomingEntities = String(relatedEntities || "").split(/[,;\s，、]+/).map((s) => s.trim()).filter(Boolean);
        const mergedEntities = Array.from(new Set([...existingEntities, ...incomingEntities])).join(", ");

        const updatePayload = {
          recurrence: next,
          tags: mergedTags || dupRow.tags,
          related_entities: mergedEntities || dupRow.related_entities,
          updated_at: nowSql(),
        };
        if (isCrystallized) {
          updatePayload.category = "principle";
          const newFp = semanticFingerprint(project, "principle", dupRow.title, dupRow.content, mergedTags || dupRow.tags);
          if (newFp) updatePayload.content_fingerprint = newFp;
        }
        try {
          await client.update("memories", dupRow.id, Object.assign({}, updatePayload, { updated_at: updatePayload.updated_at || nowSql() }));
        } catch (_) {}
        const note = isCrystallized ? "唯一索引拦下重复，累加复发计数，已升维为 principle" : "唯一索引拦下重复，累加复发计数";
        return { action: "NOOP", id: dupRow.id, category: targetCategory, recurrence: next, retrieval_count: Number(dupRow.retrieval_count) || 0, note };
      }
      return { action: "NOOP", id: null, note: "唯一索引拦下重复（写后读延迟内读不到既有行）" };
    }
    throw e;
  }
  const newId = created && (created.id || created.insertId);
  markRecent("m:" + project + ":" + fp); markRecent("m:" + fp);

  // v6.46: 交接棒接力链核销 + 跨项目画像收敛（实现收敛于文件末尾私有辅助函数）
  await _processHandoffAndProfile(client, project, newId, allActiveRows, m, category, scopeLevel, tags, title, content, fullText, relatedEntities, confidence);

  // EVO-9a: 处理显式 supersede_id 与旧版 supersede 版本链
  const allSupersedeIds = new Set();
  if (hasValidSupersede && targetSupersedeId) allSupersedeIds.add(targetSupersedeId);
  for (const s of superseded) {
    if (s && s.id) allSupersedeIds.add(s.id);
  }

  if (allSupersedeIds.size > 0 && newId) {
    let updatedCount = 0;
    for (const sid of allSupersedeIds) {
      try {
        const invReason = (hasValidSupersede && sid === targetSupersedeId) ? `superseded-by:${newId}` : "superseded";
        await client.update("memories", sid, {
          lifecycle_status: "superseded",
          superseded_by_id: newId,
          invalid_at: nowSql(),
          invalid_reason: invReason,
          updated_at: nowSql(),
        });
        updatedCount++;
      } catch (e) {
        if (!/404|not found/i.test(String(e.message))) throw e;
      }
    }
    const returnSupersededId = (hasValidSupersede && targetSupersedeId) || (superseded[0] && superseded[0].id);
    return {
      action: "UPDATE",
      id: newId,
      category,
      superseded_id: returnSupersededId,
      superseded_count: updatedCount || allSupersedeIds.size,
      recurrence: initialRecurrence,
      note: (hasValidSupersede && targetSupersedeId) ? `已显式取代旧记录 id=${targetSupersedeId}` : undefined,
    };
  }

  // EVO-9a 冲突感知：saveMemory 返回 ADD 时扫描同主题但含冲突数字的旧记录
  const normCurTitle = normalizeSemanticText(title);
  const curTokens = tokenize(title);
  const stripNums = (s) => String(s || "").replace(/\d+(?:\.\d+)*/g, "").trim();
  const curTitleNoNums = normalizeSemanticText(stripNums(title));
  const curTokensNoNums = tokenize(stripNums(title)).tokens;

  const conflictCandidates = [];
  for (const r of allActiveRows) {
    if (!r || !r.id || r.id === newId) continue;
    if (r.lifecycle_status !== "active" || r.invalid_at) continue;

    const rTitleStr = String(r.title || "").trim();
    const normRowTitle = normalizeSemanticText(rTitleStr);
    const rowTokens = tokenize(rTitleStr);

    // 1. 标题相似判定（同主题）
    const exactOrInclude = Boolean(
      (normCurTitle && normRowTitle && (normCurTitle === normRowTitle || normCurTitle.includes(normRowTitle) || normRowTitle.includes(normCurTitle))) ||
      (rTitleStr.toLowerCase() === title.toLowerCase())
    );
    const tokenOverlap = overlapCoefficient(curTokens.tokens, rowTokens.tokens) >= 0.4 ||
                         jaccardSimilarity(curTokens.tokens, rowTokens.tokens) >= 0.25;

    // 针对标题含版本/端口数字的归一化比对（如 Node 18 配置 vs Node 20 配置）
    const rowTitleNoNums = normalizeSemanticText(stripNums(rTitleStr));
    const rowTokensNoNums = tokenize(stripNums(rTitleStr)).tokens;
    const noNumsMatch = Boolean(
      (curTitleNoNums && rowTitleNoNums && (curTitleNoNums === rowTitleNoNums || curTitleNoNums.includes(rowTitleNoNums) || rowTitleNoNums.includes(curTitleNoNums))) ||
      (overlapCoefficient(curTokensNoNums, rowTokensNoNums) >= 0.4 || jaccardSimilarity(curTokensNoNums, rowTokensNoNums) >= 0.25)
    );

    const isTopicSimilar = exactOrInclude || tokenOverlap || noNumsMatch;
    if (!isTopicSimilar) continue;

    // 2. hasConflictingNumbers 判定（标题或正文存在数字冲突）
    const hasNumConflict = hasConflictingNumbers(title, r.title) ||
                           hasConflictingNumbers(content, r.content || r.full_text || "");

    if (hasNumConflict) {
      const summary = String(r.content || r.full_text || "").trim().slice(0, 100);
      conflictCandidates.push({
        id: r.id,
        title: r.title,
        content: summary,
      });
      if (conflictCandidates.length >= 3) break;
    }
  }

  const addResult = { action: "ADD", id: newId, category, recurrence: initialRecurrence };
  if (conflictCandidates.length > 0) {
    addResult.conflict_candidates = conflictCandidates;
    addResult.note = "可能存在配置冲突，建议用 supersede_id 取代或 memory_forget 淘汰";
  }
  return addResult;
}

/* ================================================================== *
 * 工具入参零摩擦容错归一化 (EVO-6)
 * ================================================================== */

/* ================================================================== *
 * 私有辅助：交接棒（Handoff）接力链核销 与 跨项目开发者画像收敛
 * 说明：仅本模块内部使用，不对外导出；全部 fail-open，绝不影响主写入事务
 * ================================================================== */

const HANDOFF_OPEN_TAG_RE = /\bhandoff:open\b/i;

/**
 * 新交接棒写入后，把同项目内旧的 open 交接棒标记为已被取代。
 * 单一有效接力棒原则：旧棒留着会让新 Agent 接到过期的"下一步"。
 */
async function _supersedeStaleHandoffs(client, project, newId, allActiveRows, tags) {
  if (!HANDOFF_OPEN_TAG_RE.test(String(tags || ""))) return 0;
  const stale = (allActiveRows || []).filter((r) =>
    r && Number(r.id) !== Number(newId) && !r.invalid_at &&
    (!r.lifecycle_status || r.lifecycle_status === "active") &&
    String(r.project || project) === project &&
    HANDOFF_OPEN_TAG_RE.test(String(r.tags || ""))
  );
  let supersededCount = 0;
  for (const s of stale) {
    try {
      await client.update("memories", s.id, {
        tags: String(s.tags || "").replace(/\bhandoff:open\b/gi, "handoff:superseded"),
        lifecycle_status: "superseded",
        superseded_by_id: newId,
        invalid_at: nowSql(),
        invalid_reason: "handoff_superseded-by:" + newId,
        updated_at: nowSql(),
      });
      supersededCount++;
    } catch (e) {
      if (!/404|not found/i.test(String(e.message))) throw e;
    }
  }
  return supersededCount;
}

/**
 * 跨项目画像收敛：同一 preference/principle 标题在 >= 2 个不同项目出现时，
 * 在 project="global" / scope_level="user" 下合成一条全局开发者习惯（幂等）。
 */
async function _promoteCrossProjectProfile(client, project, m, category, tags, title, content, fullText, relatedEntities, confidence) {
  const cat = String(category || "").toLowerCase();
  if (cat !== "preference" && cat !== "principle") return null;
  if (!project || project === "global") return null;
  if (m && (m.profile_promote === false || m.profile_promote === "false")) return null;
  const normTitle = normalizeSemanticText(title);
  if (!normTitle || normTitle.length < 4) return null;

  const rows = await fetchAll(client, "memories", { lifecycle_status: "active" });
  const projects = new Set([project]);
  for (const r of rows) {
    if (!r || r.invalid_at) continue;
    if (r.lifecycle_status && r.lifecycle_status !== "active") continue;
    if (String(r.project || "") === "global") continue;
    if (normalizeSemanticText(r.title) !== normTitle) continue;
    projects.add(String(r.project || ""));
  }
  if (projects.size < 2) return null;

  // 幂等：global 下已有同标题画像则复用，避免每次印证都新增一条
  const existingGlobal = (await fetchAll(client, "memories", { project: "global" }))
    .filter((r) => r && !r.invalid_at && normalizeSemanticText(r.title) === normTitle);
  if (existingGlobal.length > 0) return existingGlobal[0];

  const now = nowSql();
  const profileTags = "profile, profile:converged, " + cat;
  const payload = {
    project: "global",
    category: cat,
    scope_level: "user",
    client: "system",
    origin: "profile-convergence",
    title,
    content,
    full_text: fullText || content,
    tags: profileTags,
    related_entities: relatedEntities,
    content_fingerprint: semanticFingerprint("global", cat, title, content, profileTags),
    confidence_score: confidence,
    lifecycle_status: "active",
    superseded_by_id: null,
    revision: 1,
    recurrence: projects.size,
    retrieval_count: 0,
    invalid_at: null,
    invalid_reason: "",
    expires_at: expiresAtFor("user"),
    last_used_at: null,
    created_at: now,
    updated_at: now,
    source_session: null,
    source_turn: null,
  };
  const created = await client.create("memories", payload);
  return created || null;
}

/**
 * 新记忆落库后的派生事务：接力棒链核销 + 跨项目画像收敛。
 * 任何一步失败都 fail-open —— 派生能力缺失绝不能让主写入丢数据。
 */
async function _processHandoffAndProfile(client, project, newId, allActiveRows, m, category, scopeLevel, tags, title, content, fullText, relatedEntities, confidence) {
  if (!newId) return null;
  let handoffSuperseded = 0;
  try {
    handoffSuperseded = await _supersedeStaleHandoffs(client, project, newId, allActiveRows, tags);
  } catch (_) {
    // fail-open：核销失败只会留下多条 open 交接棒，不影响本次写入结果
  }
  let profile = null;
  if (scopeLevel !== "session" && scopeLevel !== "turn") {
    try {
      profile = await _promoteCrossProjectProfile(client, project, m, category, tags, title, content, fullText, relatedEntities, confidence);
    } catch (_) {
      // fail-open：画像收敛属于增强能力，失败时静默降级（无全局画像，本地记忆照常可用）
      profile = null;
    }
  }
  return { handoff_superseded: handoffSuperseded, profile };
}
