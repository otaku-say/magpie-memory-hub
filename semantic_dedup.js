/**
 * semantic_dedup.js —— 记忆中枢语义级去重引擎
 *
 * 核心设计：
 *   Layer ① 语义归一化指纹（廉价/快速/无损）：
 *     去除标点、空白、助词、括号、大小写，归一化常见同义词与前后缀（如「端点与工具特性」↔「端点与特性」）。
 *     使字面微调变体直接收敛至相同哈希，充分发挥数据库唯一索引的天然去重能力。
 *   Layer ② 局部滑动窗口语义相似度比对（token Jaccard + Overlap + Levenshtein）：
 *     在入库前与同项目同分类的最近 N 条活跃记忆做相似度比对。
 *     含专有技术名词实体防护（避免句式相仿但实体不同的误报）。
 *     命中语义相似则不新建记录，转而累加既有记忆的 recurrence 观察计数并刷新 updated_at。
 */

import crypto from "node:crypto";

/**
 * 文本语义归一化（Layer ①）
 */
export function normalizeSemanticText(text) {
  if (!text) return "";
  let s = String(text).toLowerCase();

  // 1. 去除 Markdown 标记、各类引号、括号与修饰符号
  s = s.replace(/[`*#_~\[\]「」『』“”‘’"']/g, "");

  // 2. 弱化中文结构助词与无实义虚词
  s = s.replace(/[的之地得]/g, "");

  // 3. 常见同义表达与前后缀变体归一化（长词优先替换）
  const SYNONYM_MAP = [
    // MCP 端点与特性表述
    [/端点与工具特性/g, "端点与特性"],
    [/工具特性与端点/g, "端点与特性"],
    [/接口与特性/g, "端点与特性"],
    [/端点及特性/g, "端点与特性"],
    [/特性说明/g, "特性"],
    [/工具特性/g, "特性"],
    [/功能特性/g, "特性"],

    // 依赖管理表述
    [/依赖管理/g, "管理依赖"],
    [/进行依赖管理/g, "管理依赖"],
    [/依赖包管理/g, "管理依赖"],

    // 显式记忆保存表述
    [/记忆保存/g, "保存记忆"],

    // 动作与否定词归一化
    [/严禁/g, "禁止"],
    [/不可/g, "禁止"],
    [/不要/g, "禁止"],
    [/切勿/g, "禁止"],
    [/采用/g, "使用"],
    [/利用/g, "使用"],
    [/直达/g, "直接"],

    // 常见填充词弱化
    [/进行/g, ""],
    [/关于/g, ""],
    [/对于/g, ""],
    [/具备/g, "提供"],
    [/拥有/g, "提供"],
  ];

  for (const [pattern, replacement] of SYNONYM_MAP) {
    s = s.replace(pattern, replacement);
  }

  // 4. 去除所有中英文标点、符号与空白字符
  s = s.replace(/[，。！？、；：:,\.!\?;\\\/\-_|~～\(\)（）《》〈〉【】〔〕\s\t\r\n]+/gu, "");

  return s;
}

/**
 * tags 排序归一化（Layer ① 增强）
 * 1. 按逗号、分号、空格、顿号等分隔
 * 2. 对每个 tag 执行语义归一化（小写、去除标点与修饰）
 * 3. 过滤空值并去重
 * 4. 字典序排序
 * 5. 严格截取前 5 个（防模型输出噪音 tags 导致指纹发散）
 * 6. 逗号拼接
 */
export function normalizeTags(tags) {
  if (!tags) return "";
  let list = [];
  if (Array.isArray(tags)) {
    list = tags;
  } else if (typeof tags === "string") {
    list = tags.split(/[,;\s，；、|]+/);
  } else {
    return "";
  }
  const cleaned = list
    .map((t) => normalizeSemanticText(t))
    .filter((t) => t && t.length > 0);
  const unique = Array.from(new Set(cleaned));
  // 严格只取前 5 个最主要 tags，防模型输出后续过量噪音 tags
  const top5 = unique.slice(0, 5);
  top5.sort();
  return top5.join(",");
}

/**
 * 计算语义归一化指纹
 * 支持可选 tags 参数：归一化排序并取前 5 个并入指纹，增强写时去重并防模型噪音 tags。
 */
export function semanticFingerprint(project, category, title, content, tags) {
  const normTitle = normalizeSemanticText(title);
  const normContent = normalizeSemanticText(content);
  const normTags = normalizeTags(tags);
  const text = `${project}:${category}:${normTitle}:${normContent}${normTags ? `:${normTags}` : ""}`;
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/**
 * 分词并提取语义单元（英文单词 + 中文单字/双字 n-gram）
 */
export function tokenize(text) {
  const norm = normalizeSemanticText(text);
  const tokens = new Set();

  // 1. 英文与数字专有标识（如 pnpm, react18, api, search）
  const words = norm.match(/[a-z0-9_-]+/g) || [];
  for (const w of words) tokens.add(w);

  // 2. 中文单字与双字元
  const cjk = norm.replace(/[a-z0-9_-]+/g, "");
  for (let i = 0; i < cjk.length; i++) {
    tokens.add(cjk[i]);
    if (i < cjk.length - 1) tokens.add(cjk.slice(i, i + 2));
  }

  return { tokens, str: norm };
}

/** Jaccard 相似度 |A ∩ B| / |A ∪ B| */
export function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/** 词集包含率/重叠系数 |A ∩ B| / min(|A|, |B|) */
export function overlapCoefficient(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) intersection++;
  }
  return intersection / Math.min(setA.size, setB.size);
}

/**
 * Alpha token 匹配检查：
 * 纯数字 token 走 === 严格全等（防止 "80" 与 "8080" 误判为同一实体）；
 * 含字母 token 才允许 includes 子串包含匹配。
 */
/**
 * 数字冲突守卫（v6.32.0 新增，全仓库共用）
 *
 * 背景：normalizeSemanticText 会移除空格，使 "Port 80" 变成 "port80"，
 * 从而绕过 /^\d+$/ 的纯数字检查，导致 "Port 80" 与 "Port 8080"、
 * "Node 18" 与 "Node 20" 被误判为同一实体。
 *
 * 本函数直接在**原始文本**上提取数字串并比对：
 *  - 两侧都无数字              => 不冲突
 *  - 两侧数字集合完全相同       => 不冲突
 *  - 任一侧数字集合不同        => 冲突（禁止合并）
 *
 * @param {string} a 原始文本 A
 * @param {string} b 原始文本 B
 * @returns {boolean} true 表示存在数字冲突，调用方必须拒绝判为同一实体
 */
export function hasConflictingNumbers(a, b) {
  const extract = (t) => {
    const raw = String(t == null ? "" : t);
    // 抓取独立的数字串（含小数与常见版本号写法 v1.2.3 / 1.2.3）
    const nums = raw.match(/\d+(?:\.\d+)*/g) || [];
    return new Set(nums.map((x) => String(Number(x) === Number(x) ? Number(x) : x)));
  };
  const na = extract(a);
  const nb = extract(b);
  if (na.size === 0 && nb.size === 0) return false;
  if (na.size === 0 || nb.size === 0) return false; // 一侧无数字，不构成冲突
  if (na.size !== nb.size) return true;
  for (const x of na) {
    if (!nb.has(x)) return true;
  }
  return false;
}

export function isAlphaTokenMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a === b) return true;
  const aIsDigit = /^\d+$/.test(a);
  const bIsDigit = /^\d+$/.test(b);
  if (aIsDigit || bIsDigit) {
    return a === b;
  }
  // v6.32.0：字母粘连数字（port80 / node18）必须先做数字冲突校验，
  // 否则 includes 会把 port80 与 port8080 判为同一实体
  if (hasConflictingNumbers(a, b)) return false;
  return a.includes(b) || b.includes(a);
}

/** Levenshtein 编辑距离（双行滚动数组 O(min(M,N)) 空间，输入上限 512 字符截断） */
export function levenshteinDistance(s1, s2) {
  if (typeof s1 !== "string") s1 = String(s1 || "");
  if (typeof s2 !== "string") s2 = String(s2 || "");
  if (s1.length > 512) s1 = s1.slice(0, 512);
  if (s2.length > 512) s2 = s2.slice(0, 512);

  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  // 保证 s2 为较短字符串以节约空间（O(min(M,N))）
  if (s1.length < s2.length) {
    const tmp = s1; s1 = s2; s2 = tmp;
  }

  const m = s1.length;
  const n = s2.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const c1 = s1[i - 1];
    for (let j = 1; j <= n; j++) {
      if (c1 === s2[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = Math.min(prev[j], curr[j - 1], prev[j - 1]) + 1;
      }
    }
    const temp = prev;
    prev = curr;
    curr = temp;
  }
  return prev[n];
}

/** 基于编辑距离的归一化相似度 (0 ~ 1) */
export function levSimilarity(s1, s2) {
  if (typeof s1 !== "string") s1 = String(s1 || "");
  if (typeof s2 !== "string") s2 = String(s2 || "");
  if (s1.length > 512) s1 = s1.slice(0, 512);
  if (s2.length > 512) s2 = s2.slice(0, 512);
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(s1, s2);
  return 1 - dist / maxLen;
}

/**
 * 判断两个记忆条目是否表达「同一事实」（Layer ② 语义判重）
 */
export function isSemanticallySimilar(title1, content1, title2, content2) {
  // P1-1 核心：统一前置数字冲突总闸（短路一切误判，防止 Port 80 vs 8080、Node 18 vs 20 误判为同一实体）
  if (hasConflictingNumbers(title1, title2) || hasConflictingNumbers(content1, content2)) {
    return false;
  }

  const t1 = tokenize(title1);
  const t2 = tokenize(title2);
  const c1 = tokenize(content1);
  const c2 = tokenize(content2);

  // 1. 归一化文本完全一致
  if (t1.str && t1.str === t2.str && c1.str && c1.str === c2.str) return true;

  // 2. 专有实体技术词与序号交集检查（防止句式相同但技术实体/编号不同的误判，如 React 18 vs Node.js 20，或 条目 3 vs 条目 4）
  const alpha1 = new Set(t1.str.match(/[a-z0-9_-]+/g) || []);
  const alpha2 = new Set(t2.str.match(/[a-z0-9_-]+/g) || []);
  if (alpha1.size > 0 && alpha2.size > 0) {
    let sharedAlpha = 0;
    for (const a of alpha1) {
      for (const b of alpha2) {
        if (isAlphaTokenMatch(a, b)) {
          sharedAlpha++;
          break;
        }
      }
    }
    if (sharedAlpha === 0) return false;

    // 纯数字实体必须精确相等：若双方均包含数字编号/版本/端口，但没有相同的数字实体，则严禁判为同一实体
    const nums1 = [...alpha1].filter((x) => /^\d+$/.test(x));
    const nums2 = [...alpha2].filter((x) => /^\d+$/.test(x));
    if (nums1.length > 0 && nums2.length > 0) {
      const hasSharedNum = nums1.some((n1) => nums2.includes(n1));
      if (!hasSharedNum) return false;
    }
  }

  // 3. 计算多维相似度指标
  const tJaccard = jaccardSimilarity(t1.tokens, t2.tokens);
  const tOverlap = overlapCoefficient(t1.tokens, t2.tokens);
  const tLev = levSimilarity(t1.str, t2.str);

  const cJaccard = jaccardSimilarity(c1.tokens, c2.tokens);
  const cOverlap = overlapCoefficient(c1.tokens, c2.tokens);
  const cLev = levSimilarity(c1.str, c2.str);

  const contentRelevant = cOverlap >= 0.38 || cJaccard >= 0.22 || cLev >= 0.28;

  // 4. 标题完全归一相同，且内容具有相关性（内容不冲突/变体表述）
  if (t1.str && t1.str === t2.str && contentRelevant) return true;

  // 5. 判定门限：
  // 5.1 标题高度相似（同义词、语序倒装、修饰变体）且内容具备相关性
  const titleVeryClose = (tOverlap >= 0.75 && tJaccard >= 0.45) || tLev >= 0.68;
  if (titleVeryClose && contentRelevant) return true;

  // 5.2 标题与内容双向高重合
  if (tOverlap >= 0.8 && cOverlap >= 0.5) return true;
  if (tLev >= 0.75 && cLev >= 0.5) return true;

  // 5.3 内容极高重合（详略不同的变体）且标题具备基本关联
  if (cOverlap >= 0.85 && cJaccard >= 0.6 && tOverlap >= 0.4) return true;

  // 5.4 综合加权相似度得分
  const combined = (tJaccard * 0.35 + tLev * 0.25) + (cJaccard * 0.25 + cLev * 0.15);
  return combined >= 0.6 && contentRelevant;
}

/**
 * 从已存在的候选记忆列表中寻找语义重复项
 * @param {Array<Object>} candidates - 候选记忆列表（同 project + 同 category）
 * @param {string} title - 待检测标题
 * @param {string} content - 待检测内容
 * @param {string} normFp - 待检测归一化指纹
 * @returns {Object|null} 匹配到的已有记忆条目
 */
export function findSemanticDuplicate(candidates, title, content, normFp) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  // 1. 优先比对 content_fingerprint
  if (normFp) {
    const exact = candidates.find((r) => r.content_fingerprint === normFp);
    if (exact) return exact;
  }

  // 2. 逐条进行 Layer ② 语义相似度比对
  for (const cand of candidates) {
    if (cand.lifecycle_status && cand.lifecycle_status !== "active") continue;
    const candTitle = String(cand.title || "");
    const candContent = String(cand.content || cand.full_text || "");
    if (isSemanticallySimilar(title, content, candTitle, candContent)) {
      return cand;
    }
  }

  return null;
}
