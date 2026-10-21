# Agent A 检查点报告：修复知识黑洞、跨类数字冲突与 EVO-11 踩坑升维 (v6.38-a)

## 一、修改范围与文件所有权约定
- **工作目录**: `/workspace/m`
- **工作分支**: `feat/v638-a-write`
- **文件所有权范围**:
  - 独占修改: `tools.js` 中的 `saveMemory` 与 `pitfallSave` 两个函数区域。
  - 独占新增: `tests/test_v638_a_write.mjs`、`NOTES_v638_a.md`。
  - 严格禁改: `memoryList` / `memoryGet` / `memoryContext` / `memorySearch` / `memoryForget` / `normalizeToolArgs`、`semantic_dedup.js`、`gateway_harvest*.js`、`memory.middleware.js`、`test_meta.mjs` 以及历史测试文件。

---

## 二、整改项深入分析与修复实现

### 1. BUG-37-1 知识黑洞修复（高危）
- **问题定位**: `tools.js:512` 处的 `pitfallRows.find` 回调。
- **现状危害**: 踩坑记录通过 `memory_forget(table: "pitfalls")` 软失效（写入 `invalid_at`）后，`saveMemory` 内部的「踩坑优先」检查未过滤失效踩坑，依然匹配并返回 `NOOP, table: "pitfalls"`；而检索链路已过滤失效记录，导致该主题的新知识既写不进 memories 又搜不出踩坑，形成永久知识黑洞。
- **修复方案**: 在 find 回调第一行增加软失效与生命周期过滤：
  ```javascript
  if (p.invalid_at) return false;
  if (p.lifecycle_status && p.lifecycle_status !== "active") return false;
  ```
- **双向反证验证**:
  - [正向反证 1.a] 踩坑软失效后，再向 memories 写入同主题记忆 → 必须成功 ADD 落库 memories，绝不返回 NOOP。
  - [反向反证 1.b] 踩坑处于活跃未失效状态时，saveMemory 同主题仍必须触发「踩坑优先」返回 NOOP(table: "pitfalls") 并累加 recurrence，杜绝原有防重机制被破坏。

---

### 2. BUG-37-3 跨类去重漏检正文数字冲突修复
- **问题定位**: `tools.js:684` 跨类去重 `crossDup` 判定。
- **现状危害**: `crossDup` 仅比对了标题数字冲突（`hasConflictingNumbers(title, r.title)`），未比对正文。当库内存在 fact 记忆「网关端口配置: 监听 80」，新存入 decision「网关端口配置: 监听 8080」时，因标题无冲突被误判为跨类重复并被 NOOP 拦截，导致 8080 新架构决策丢失且无法触发 EVO-9 冲突预警。
- **修复方案**: 在 `crossDup` 判定中增加正文数字冲突守卫：
  ```javascript
  if (hasConflictingNumbers(title, r.title)) return false;
  if (hasConflictingNumbers(content, r.content || r.full_text || "")) return false;
  ```
- **双向反证验证**:
  - [正向反证 2.a] 跨类且正文含数字冲突（如 80 vs 8080）→ 绝不 NOOP，必须执行 ADD 创建新记录并生成全新 ID。
  - [反向反证 2.b] 跨类且无数字冲突、语义完全一致时 → 仍正常进入跨类去重返回 NOOP。

---

### 3. EVO-11 高频踩坑跨表升维 principle
- **问题定位**: `pitfallSave` 成功执行 ADD/EVOLVED/NOOP 累加复发计数处。
- **需求目标**: 当踩坑复发次数达到结晶门槛（`recurrence >= crystallization_threshold`，默认 5），且根因与解法均为真实非占位时，自动在 memories 表创建或更新一条 category="principle" 的防护铁律。
- **核心规格**:
  - **标题规范**: `【踩坑铁律】<component>: <symptom 前60字>`。
  - **正文规范**: 包含【症状】、【根因】、【解法】三要素。
  - **标签合并**: 合并原踩坑 tags 并追加 `pitfall-ironlaw`。
  - **幂等保护**: 若已存在同 project + 同 title 的 principle，则就地更新并递增 recurrence，库中严格仅保留 1 条记录，绝不重复建行。
  - **返回值增强**: 触发升维时返回体增加 `ironlaw_created: true, ironlaw_id: <id>`（未触发则不含该字段）。
  - **Schema 门禁合规**: 写库语句同一语句内显式包含 `created_at` 与 `updated_at: nowSql()`，外键列严格为 NULL，100% 通过 `test_schema_defaults.mjs`。
- **双向反证验证**:
  - [正向反证 3.a] recurrence >= 5 且根因/解法真实 → 必须生成 principle 铁律，库中精确查到，返回 `ironlaw_created: true`。
  - [反向反证 3.b] recurrence = 4 未达阈值 → 绝不生成 principle，返回体不含 ironlaw_created。
  - [反向反证 3.c] 根因为占位符（等于 symptom 或含「待查/未知」）→ 即使 recurrence >= 5 也严禁生成 principle。
  - [反向反证 3.d] principle 已存在时再次触发 → 就地更新而非重复创建，库中该 title 记录严格只有 1 条，recurrence 累加递增。

---

## 三、双向反证测试矩阵 (tests/test_v638_a_write.mjs)

| 模块 | 正向验证 (Positive) | 反向反证 (Counter-Evidence) |
| :--- | :--- | :--- |
| **BUG-37-1 知识黑洞** | 踩坑软失效后，saveMemory 同主题成功落库 memories，action 为 ADD，生成全新 ID | 踩坑未失效时，saveMemory 同主题严格返回 NOOP，table 指向 pitfalls |
| **BUG-37-3 跨类数字冲突** | 正文存在数字冲突（如 80 vs 8080），saveMemory 跨类别存储成功触发 ADD 落库 | 跨类且无数字冲突、语义重复的记录，正常触发 crossDup 返回 NOOP |
| **EVO-11 升维铁律** | recurrence >= 5 且根因/解法真实时，生成 principle 铁律，含三要素与 pitfall-ironlaw 标签 | recurrence = 4 未达门槛严禁生成；根因等于 symptom 或含待查严禁生成 |
| **EVO-11 幂等更新** | 已存在同 title 铁律时再次触发结晶，库中仅保留 1 条记录，recurrence 累加为 2 | 绝不因重复结晶导致 memories 表中产生同 title 冗余行 |
| **测试元检查规范** | `scanTestFile` 静态扫描本测试 0 违规，符合隔离、清理与零残留规范 | `env.cleanup()` 执行后 `residue.total === 0` 强断言通过 |

---

## 四、验证与回归记录
1. 运行专项测试 `node tests/test_v638_a_write.mjs`：全量反证门 100% 通过，数据库 0 残留。
2. 运行回归套件：
   - `node tests/test_dedup_and_audit.mjs`：100% 通过（去重合并与撤销验证）。
   - `node tests/test_v636_a_evo.mjs`：100% 通过（EVO-1 与 EVO-4 升维套件）。
   - `node tests/test_schema_defaults.mjs`：100% 通过（全部 30 个写入载荷显式包含时间戳，无外键哨兵值 0）。
3. 遵循文件所有权与“禁改计数”原则（对齐 DEVNOTES.md:2040 与 DEVNOTES.md:2226）：
   - `test_meta.mjs` 严格保持只读，未做任何修改；
   - 新增测试由 `tests/test_v638_a_write.mjs` 引入 `scanTestFile` 自检自证合规（0 违规），待合并阶段统一锁定计数。
