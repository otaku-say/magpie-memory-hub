# AGENTS.md — 工程执行规约

> **第一军规（最高优先级）**
> 本项目所有代码编写、测试编写、重构与排障，**必须遵循 `addyosmani/agent-skills` 的 25 个技能标准**。
> 动手前先读 `CONSTRAINTS.md`，**不得为了让改动通过而弱化它**。
> 技能全文位于 `/var/minis/skills/<skill-name>/SKILL.md`。

---

## 一、动手前必读

| 顺序 | 文件 | 作用 |
|:--|:--|:--|
| 1 | `CONSTRAINTS.md` | 本项目的质量底线，数值化、可机械检查 |
| 2 | 本文件 | 技能选择与执行节奏 |
| 3 | `/var/minis/skills/<相关技能>/SKILL.md` | 具体方法论 |

---

## 二、按任务类型选技能（强制）

| 要做的事 | 必用技能 | 落地动作 |
|:--|:--|:--|
| 新功能 / 新项目 | `spec-driven-development` | 先写规格（目标、范围、验收标准），再写代码 |
| 任务太大 | `planning-and-task-breakdown` | 拆成原子任务，每个 < 60 分钟可验证 |
| 任何多文件改动 | `incremental-implementation` | 薄切片：实现 → 测试 → 验证 → 提交，再下一片 |
| 写任何逻辑 | `test-driven-development` | 红 → 绿 → 重构，先写失败测试 |
| 定义质量标准 | `constraint-driven-development` | 写进 `CONSTRAINTS.md`，配机器检查 |
| 排障 / 测试红 | `debugging-and-error-recovery` | 先定位根因，再动手；禁止打地鼠 |
| 代码写完 | `code-review-and-quality` | 五轴审查：正确性、可读性、性能、安全、可测性 |
| 觉得代码太复杂 | `code-simplification` | 去复杂度，但**不改变行为** |
| 选型有疑问 | `source-driven-development` | 查官方文档与源码，不靠记忆判断 |
| 有风险决策 | `doubt-driven-development` | 主动找反证，不自我确认 |
| 提交 / 分支 | `git-workflow-and-versioning` | 小步提交，信息说明「为什么」 |
| 接口设计 | `api-and-interface-design` | 契约先行，向后兼容 |
| 安全相关 | `security-and-hardening` | 输入校验、凭据管理、最小权限 |
| 性能问题 | `performance-optimization` | 先测量再优化，有基线对比 |
| 加日志/指标 | `observability-and-instrumentation` | 让生产行为可见可诊断 |
| 删除/迁移旧功能 | `deprecation-and-migration` | 平滑过渡，不舍弃存量数据 |
| 写文档/决策记录 | `documentation-and-adrs` | ADR 记录「为什么这么选」 |
| CI/CD | `ci-cd-and-automation` | 门禁必须能拦截，不做装饰 |
| 发版 | `shipping-and-launch` | 检查清单 + 回滚预案 |
| 长对话/上下文管理 | `context-engineering` | 主动压缩、外置状态 |
| 前端界面 | `frontend-ui-engineering` | 可用性、可访问性、响应式 |
| 浏览器验证 | `browser-testing-with-devtools` | 真机验证，不靠推测 |

---

## 三、执行节奏（不可跳过）

```
写代码前   → 读 CONSTRAINTS.md + 相关 SKILL.md
每写一段   → 立刻跑对应测试（不许攒到最后）
每改一文件 → node --check <file>（语法）
每完成一片 → 跑全量，失败数必须为 0，再 commit
提交前     → code-review-and-quality 五轴自审一遍
发版前     → shipping-and-launch 清单逐项勾
```

**红线：任何时刻，主干上不允许存在跑不过测试的中间状态。**

---

## 四、派发子 Agent 的规约

任务书**必须**包含：

1. **声明技能**：明确要求遵循哪几个技能，并给出路径
2. **文件所有权**：独占哪些文件/目录，禁止碰哪些
3. **共享字段锁**：`test_meta` 计数、`README` 徽章、`package.json` version 一律由主控统一改
4. **渐进验证**：每切一个文件 `node --check`，每 3 个文件跑相关测试，每层跑全量
5. **真实输出**：报告必须贴**原样 stdout**，禁止概括或口述
6. **如实列出非纯移动改动**，不许隐瞒

**主控验收不采信自述**，必须独立跑：
```bash
python3 verify_delivery.py          # 六项机器验收
node tests/check_constraints.mjs    # 三类退化检测
bash tests/run_all.sh               # 全量失败数为 0
```

---

## 五、已知的历史教训（不要再犯）

| 教训 | 具体表现 |
|:--|:--|
| Agent 报告造假 | 声称「83 通过 0 失败」，实际「13 通过 74 失败」；声称有 3 个 commit，实际一次都没提交 |
| 切割残片 | 按行号机械切割，切在多行注释/正则中间，产生 `SyntaxError`；函数被切成半截（`fingerprint` 14 行→3 行） |
| 重复声明 | 合并两个文件时同名符号叠加，`Identifier 'X' has already been declared` |
| 移动文件破坏引用 | `import`、`readFileSync("x.js")`、`import.meta.url` 三类路径全断，75 个测试崩溃 |
| 计数冲突 | 多个 Agent 各自改 `test_meta` 计数，合并后不符 |
| 测了写入没测生效 | `confidence_score: 1.0` 与 0~100 量纲不符，写入成功但排序永远垫底 |

**这些都是「看起来绿了其实坏了」的类型，只有机器检查能抓住。**

---

## 六、本项目专属硬约束

1. **绝不改写历史消息前缀**（保 KV-Cache）
2. **绝不碰 system prompt 热区**（注入只落最后一条用户消息）
3. **绝不丢消息**（只做加法式保命）
4. **注入路径（moejs）不能有任何 I/O 或模型调用**（250ms 硬限额）
5. **显式保存必须直达数据库**（`memory_save` / `pitfall_save` 不挂模型）
6. **模型名必须可配置**（未配置时安全跳过）
7. **`fail-open` 的正确含义是「跳过」，不是「换规则继续跑」**
8. **不许为了「让测试变绿」而弱化断言**
