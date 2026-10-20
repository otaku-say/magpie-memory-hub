# Agent A 检查点报告：调度器与审计仲裁修复 (v6.33-a)

## 任务背景
- **沙箱 ID**: `79634008d18942a9b894f3409bcdd4b1`
- **代码目录**: `/workspace/m`
- **工作分支**: `feat/v633-a-tools`
- **文件所有权**: 独占修改 `tools.js` 与 `tests/test_v633_a_tools.mjs`，严禁修改其他共享文件。

## 4 项整改方案与技术实现

### 1. 【P0-1 最紧急】ensureAuditScheduler 传参短路导致定时去重 100% 瘫痪
- **问题根因**:
  宿主调用 `MagpieMemoryHub(input, options)` 时，宿主传入的 `input` 是带有上下文的 truthy 对象（如 `{ magpie: ... }`）。原代码在传给调度器闭包时使用 `() => readOptions(input || options)`，导致 `input || options` 恒返回 `input`，用户在 `options` 中配置的 `dedup_schedule`、`mcp_key` 等关键字段被完全丢弃，`dedup_schedule` 恒为 `"off"`，定时去重在生产环境完全无法启动。
  同时，原实现中 `if (_auditSchedulerStarted) return;` 仅仅早退，当设置页更新配置重新调用入口时，闭包中的 getter 与 client 无法动态刷新。
- **修复方案**:
  1. 将调度器配置读取闭包改为两者对象合并，且 `options` 拥有高优先级后写覆盖：
     `() => readOptions(Object.assign({}, input && typeof input === "object" ? input : {}, options && typeof options === "object" ? options : {}))`。
  2. 修复 `ensureAuditScheduler` 的早退逻辑：若定时器已在运行，不重复创建定时器，但主动刷新模块级闭包中的 `_auditOptionsGetter`、`_auditBaseCfg` 与 `_auditBaseClient`，保证设置页修改后定时器下一次触发能感知最新配置；同时提供 `stopAuditScheduler` 可控停止入口。
- **反证门 1 设计**:
  构造 `input = { magpie: { host: "test" } }` 与 `options = { dedup_schedule: "daily", mcp_key: "key_v633_test" }`，断言 `getFreshCfg()` 读到的 `dedup_schedule` 为 `"daily"` 且 `mcpKey` 为 `"key_v633_test"`；断言当 `input` 为空而 `options` 有值时亦能正确解析；断言定时器已启动时动态修改 `options` 能够即时通过 `getFreshCfg()` 读取最新配置。

---

### 2. 【P1-1】memoryAudit 标题短路未校验正文数字冲突
- **问题根因**:
  在 `memoryAudit` 的内存规则查重阶段（记忆表约 1997-2001 行、踩坑表约 2190-2194 行），`sameTitle` / `sameSym` 与 `titleOverlap` / `symOverlap` 短路判定仅调用了 `hasConflictingNumbers(a.title, b.title)` 或 `hasConflictingNumbers(a.symptom, b.symptom)`，未校验正文（content/full_text）与排障方案（solution/root_cause）中的数字冲突。导致标题相同（例如均为「数据库连接超时」）但正文指定不同端口（3306 与 3307）或不同参数的记录被短路误判为重复并合并。
- **修复方案**:
  在记忆表判定重复前，追加 `!hasConflictingNumbers(a.content || a.full_text, b.content || b.full_text)`；在踩坑表判定重复前，将 `symptom + " " + solution + " " + root_cause` 拼接文本执行 `!hasConflictingNumbers(textA, textB)`，出现数字冲突一律拒绝合并。
- **反证门 2 设计**:
  分别在记忆表与踩坑表中插入标题/现象完全相同（如「数据库连接超时治理方案」），但正文/方案中包含不同端口数字（3306 vs 3307）的记录，执行 `memory_audit`（full: true），断言两条记录均保持 `invalid_at == null`，绝不被误合并。

---

### 3. 【P1-2】memoryAudit 模型仲裁漏审未分组行 & 误丢弃确定性规则组 & 跨组主从互指
- **问题根因**:
  - a) 当规则分组 `groups.length > 0` 时，原代码仅将命中规则组的记录放进 `candidateList`，未被规则覆盖的行被完全丢弃，导致需要依靠大模型语义理解的同义改写记录被漏审。
  - b) 当模型返回部分分组结果时，原代码 `remainingGroups` 使用 `modelReviewedIds` 将所有送给模型的规则组全部无条件过滤掉，导致确定性规则组（如精确内容指纹重合组）若模型未返回即被直接丢弃。
  - c) `modelDupIds` 仅记录了从记录 ID，未记录作为主记录的 `pId`，导致模型跨组返回时存在同一 ID 在 A 组为主、在 B 组为从的互指冲突，进而导致主记录被误软删。
- **修复方案**:
  - a) `candidateList` 优先放入规则候选组记录，随后将未分组的剩余记录按预算追加至候选列表，送入模型仲裁（受 `maxModelBatches` 预算约束）。
  - b) `remainingGroups` 仅剔除「已被模型明确处理过的 ID」（记录在 `modelHandledIds` 中），未被模型处理或部分处理的确定性规则组予以安全保留。
  - c) 模型仲裁解析每处理一组，不仅记录从记录 ID，亦将主记录 `pItem.id` 计入 `modelDupIds`，且新组的主从记录均不得存在于 `modelDupIds` 中，彻底杜绝跨组主从互指。
- **反证门 3 设计**:
  1. 构造「精确指纹规则组（未在模型返回中出现）」+「同义改写无规则组记录（由模型仲裁指出重复）」，执行审计，断言模型返回后，精确指纹规则组绝不被丢弃，同义改写记录成功合并。
  2. 构造模型恶意/幻觉跨组主从互指响应（A 组 primary=X, dups=[Y]；B 组 primary=Z, dups=[X]），断言 X 绝不被写入 `invalid_at`，主从互指被安全规避。

---

### 4. 【P1-3】MODEL_CHUNK 误读 dedup_batch_size 与预算超支
- **问题根因**:
  在 `memoryAudit` 中，`MODEL_CHUNK` 错误地读取了 `dedup_batch_size`（限制到 60）而非 `audit_chunk_size`（40）。当用户配置较大批次时，`candidateList.slice(0, modelBudgetItems)` 切取了 120 条记录，而底层 `auditMemoriesWithModel` 内部按 40 分块，导致产生 3 次外部模型调用而非预期的 2 次调用，超过预算并引入 55s 超时风险。
- **修复方案**:
  `MODEL_CHUNK` 一律读取 `cfg.audit_chunk_size ?? 40`，将单次送模型的条数硬顶为 `audit_chunk_size * maxModelBatches`。
- **反证门 4 设计**:
  配置 `audit_chunk_size = 40`、`max_model_batches = 2`，准备 100 条待去重记录，模拟模型调用探针，断言送入模型的最大记录数精确受限为 80 条（2 * 40），产生的模型分块调用次数绝不超过 2 次。

## 测试与合规自检计划
- 新建 `tests/test_v633_a_tools.mjs`，包含上述 4 大反证门及清理断言，100% 符合 `test_meta.mjs` 规范。
- 依次运行所有必测测试套件确保 0 失败。
