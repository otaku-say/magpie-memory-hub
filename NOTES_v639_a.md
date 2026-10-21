# v6.39-a 开发笔记：修复铁律置信度量纲、占位正则、软失效正文数字守卫与 EVO-16 增强

- **执行分支**：feat/v639-a-write
- **基线版本**：fd649e8
- **责任区域**：tools.js（① isPlaceholderRootCause、② 软失效 memories 回调、③ checkAndApplyIronlaw 及 pitfallSave NOOP 分支 tags 合并）
- **新增测试**：tests/test_v639_a_write.mjs

---

## 1. 缺陷分析与需求背景

### 1.1 BUG-38-1 置信度量纲错配（高危）
- **代码位置**：tools.js:1851 `confidence_score: 1.0,`
- **根本原因**：NCB memories 表的 confidence_score 字段为 0~100 整数。rankMemory(410-414) 计算公式为：
  `conf = (!isNaN(rawScore) ? rawScore : 100) / 100;`
  创建铁律时错误写入 `confidence_score: 1.0`，导致 `conf = 0.01`。这使得铁律排序得分仅为普通 principle（100 满分）的 1/100，排在最后，甚至无法进入 memory_context 的置顶槽位（max_principles 默认 2 条）。
- **二次更新遗漏**：既有铁律在 existingPrinciple 分支二次更新时，当解法更详尽或内容发生演进时，漏更新了 `content_fingerprint`，导致指纹陈旧。
- **修复方案**：
  1. 将写入载荷中的 `confidence_score: 1.0` 修正为 `confidence_score: 100`（满分 100）。
  2. 在 existingPrinciple 分支重算 `semanticFingerprint(project, "principle", ironTitle, ironContent, mergedIronTags)` 并写入 `content_fingerprint`。

### 1.2 BUG-38-4a 占位正则漏历史套话（中危）
- **代码位置**：tools.js:1777-1783 `isPlaceholderRootCause` 及 `isMeaningfulIronlaw`
- **根本原因**：正则 `/未知|待查|临时|unknown|todo|tbd/i` 漏掉了历史代码/日志中的模板套话：`"执行过程中出现 <symptom>，已处置解决"`。这类记录缺乏真实根因，若复发达到 5 次会被误升维为假铁律。
- **修复方案**：
  在占位正则中追加 `|已处置解决|执行过程中出现`，确保历史套话被判定为占位根因，绝不触发升维。

### 1.3 BUG-38-4b 软失效 memories 漏检正文数字冲突（中危）
- **代码位置**：tools.js:1730-1743 `supersededMems` 匹配回调
- **根本原因**：软失效冗余 memories 时仅比对了 `hasConflictingNumbers(m.title, symptom)`，未校验正文与 solution/root_cause 的数字冲突。导致正文含不同端口/版本（如 3306 vs 3307）的记忆被误标记软失效。
- **修复方案**：
  在 `supersededMems` 过滤回调中增加：
  `if (hasConflictingNumbers(m.content || m.full_text || "", solution || rootCause || "")) return false;`

### 1.4 EVO-16 pitfallSave NOOP 分支 tags 合并 + 铁律实体透传
- **代码位置**：tools.js:1965-1979（pitfallSave NOOP 分支）及 checkAndApplyIronlaw
- **根本原因**：
  1. 重复踩坑且无信息增益（NOOP 分支）时，丢弃了本次传入的新 tags，没有与库中既有 tags 取并集回写。
  2. checkAndApplyIronlaw 创建铁律时，`related_entities` 仅简单取 `comp`（组件名），丢失了调用方传入的 `args.related_entities`。
- **修复方案**：
  1. 在 pitfallSave 的 NOOP 路径（包含语义相似去重命中、数字冲突覆盖保护、唯一索引拦下重复等）中计算 `mergedTags = Array.from(new Set([...existingTags, ...incomingTags])).join(", ")` 并写回数据库。
  2. 在 checkAndApplyIronlaw 中，解析 `args.related_entities` 并与 `comp` 取并集生成 `ironEntities`，落盘并更新至铁律记录。

---

## 2. 双向反证验收设计（tests/test_v639_a_write.mjs）

1. **BUG-38-1 双向反证**：
   - a) 铁律写入后查回 `confidence_score === 100`（反证：非 1、非 1.0）。
   - b) 召回能力验证：构造 2 条普通 principle(confidence_score=100) + 1 条铁律，调用 memory_context(query 命中全部)，断言铁律成功出现在返回的 block 中。
   - c) 指纹演进反证：二次更新铁律时（新解法扩充），读回记录的 `content_fingerprint` 发生变化，与旧指纹不相等。

2. **BUG-38-4a 占位正则双向反证**：
   - a) 占位根因反证：`root_cause = "执行过程中出现 XXX，已处置解决"`，断言 `isPlaceholderRootCause` 返回 true，且 recurrence=5 时不升维铁律。
   - b) 真实根因反证：`root_cause = "TCP KeepAlive 未开启导致连接被静默回收"`，断言返回 false 且 recurrence=5 时正常升维铁律。

3. **BUG-38-4b 软失效正文数字冲突双向反证**：
   - a) 正文数字冲突反证：已有 memory 正文含 "3306"，新 pitfall solution 含 "3307"，调用 pitfallSave 后断言该 memory 仍为 active，不得被软失效。
   - b) 正文无冲突语义相似反证：正文无冲突且语义重叠，调用 pitfallSave 后该 memory 正常被标记为 superseded。

4. **EVO-16 tags 合并与实体透传双向反证**：
   - a) NOOP tags 合并反证：重复触发相同踩坑（NOOP），传入新 tags，断言库中记录 tags 包含原有与新增 tag 的并集。
   - b) 铁律实体透传反证：传入 `component="redis"` 与 `related_entities="cache, sentinel"` 升维铁律，断言铁律的 `related_entities` 包含 `redis`、`cache`、`sentinel` 的并集。

5. **门禁合规自检与零残留断言**：
   - scanTestFile(thisFile) 自检通过。
   - createTestEnv 隔离运行，结束后 residue === 0。

---

## 3. 验证与回归记录

1. **专项双向反证验收**：
   - 运行 `node tests/test_v639_a_write.mjs`：全部 4 大任务与全量正反向反证门 100% 通过，隔离命名空间测试数据彻底清理，`residue.total === 0` 零残留断言通过。
2. **核心回归套件**：
   - 运行 `node tests/test_v638_a_write.mjs`：100% 通过（BUG-37-1 知识黑洞、BUG-37-3 跨类数字冲突、EVO-11 升维铁律全部保持绿灯）。
   - 运行 `node tests/test_schema_defaults.mjs`：100% 通过（所有 30 个数据库写入载荷显式包含时间戳，无外键哨兵值 0）。
   - 运行 `node tests/test_v636_a_evo.mjs`：100% 通过（EVO-1 与 EVO-4 升维套件全部保持绿灯）。
3. **遵循文件所有权与“禁改计数”原则**（对齐 DEVNOTES.md:2040 与 DEVNOTES.md:2226）：
   - `test_meta.mjs` 严格保持只读，未做任何修改；
   - 新增测试由 `tests/test_v639_a_write.mjs` 引入 `scanTestFile` 执行等价规范自检（0 违规），待合并阶段统一锁定计数。
