# ADR-001：根目录保留薄门面（re-export），实现移入 `src/`

## Status

Accepted（已落地，见提交 `cec2380` … `a673dd6`，合入 `integ2` 于 `8ec2574`）

## Date

2026-10-22（决策与首次落地：2026-10-21 ~ 2026-10-22，v6.43.0 目录结构重构）

## Context

### 决策背景

v6.43.0 之前，仓库根目录的 16 个 `.js` 文件合计 **17 048 行**，其中四个是巨石：

| 文件 | 行数（`8f495b0`） | 承担职责 |
|---|---:|---|
| `tools.js` | 4 488 | MCP 工具注册 + 9 个记忆/踩坑工具 + 审计 + 采集 + 全部辅助函数 |
| `gateway_harvest.hooks.js` | 1 805 | 网关请求/响应钩子 + 采集流水线 + 在线模型调用 |
| `memory.middleware.js` | 1 409 | 请求注入 + 流式事件 + 响应清洗 |
| `gateway_harvest.js` | 1 213 | 离线扫描 + 提炼 + 分类 + 项目解析 |

问题不是「文件大」本身，而是：

1. **没有分层**。工具入口、数据库客户端、领域算法、状态管理混在同一批文件里，
   无法回答「这段逻辑属于哪一层」。
2. **没有单一真相源**。`local_state.js`、`r2.js`、`schema.js`、`scrub.js` 等被
   30+ 个模块引用，却各自都是全量实现，改一处要在十几个地方同步。
3. **测试定位困难**。测试失败时只能定位到「某个 4 000 行文件里的某个函数」，
   而 CONSTRAINTS.md 又明确禁止**按行数硬拆**（「强行把单一职责函数切成碎片，耦合反而更高」）。
4. **模块头部注释缺失**。CONSTRAINTS.md 要求「每个模块顶部有中文注释（职责 / 依赖 / 被依赖）」，
   但根目录文件因为承担太多职责，根本写不出准确的「依赖 / 被依赖」两行。

### 被否决的替代方案

#### 方案 A：直接搬迁（`git mv` + 改引用）

**做法**：把根目录文件 `git mv` 进 `src/` 对应子目录，然后批量改写所有引用。

**实测结果**：**造成 75 个测试失败**（记录于 `AGENTS.md`「已知的历史教训」表：
「移动文件破坏引用 | `import`、`readFileSync("x.js")`、`import.meta.url` 三类路径全断，
75 个测试崩溃」）。

根因是**引用分三类，而 codemod 只覆盖了第一类**。实测（`8ec2574` 基线，
扫描 `src/` + `tests/` 全部 `.js`/`.mjs`）：

| 引用类型 | 边数 | 涉及文件数 | 典型写法 | codemod 覆盖 |
|---|---:|---:|---|:--:|
| ① ESM import | 248 | 104 | `import { X } from "./tools.js";` | ✅ |
| ② readFileSync 字符串路径 | 1 | 1 | `fs.readFileSync("tools.js", "utf8")` | ❌ |
| ③ import.meta.url / new URL | 19 | 10 | `new URL("../tools.js", import.meta.url)` | ❌ |

- **① ESM import** 占 248/268 ≈ **92.5%**，是唯一「长得像 import」的引用，
  因此也正是 codemod 唯一能自动覆盖的一类。覆盖率 92.5% 听起来不低，
  但**剩下 7.5% 恰恰是静默失败**的类型。
- **② readFileSync 字符串路径**（`tests/test_v631_a_tools.mjs`）的路径是裸字符串，
  根本不出现在 `import` 语句里，codemod 的正则永远看不到它。
  更糟的是它**不会立刻报错**：文件搬走后 `readFileSync("tools.js")` 要么读到
  另一个目录下的同名文件，要么抛 ENOENT，二者都表现为「断言失败」而不是「路径写错了」。
- **③ import.meta.url / new URL**（19 条，10 个文件）的路径是**运行时拼出来的 URL 对象**，
  且基准是**模块自身所在目录**。文件从根目录移进 `src/core/` 后，相对层级从 `../`
  变成 `../../`，所有 `new URL("../xxx.js", import.meta.url)` 都必须同步改写。
  这类引用在静态分析里和字符串字面量混在一起，极易误判。

> 结论：**codemod 覆盖 92.5% 的引用，剩下的 7.5% 是最隐蔽的两类**。
> 用「92.5% 通过率」去论证「搬迁是安全的」是错误的推理方式——
> 破坏恰好集中在最难排查的地方。

#### 方案 B：按行数硬拆巨石

**做法**：把 `tools.js` 按行数切成若干文件。

**否决理由**：CONSTRAINTS.md 架构约束表明确写明「**不按行数硬拆**」，
「强行把单一职责函数切成碎片，耦合反而更高」，违反后果为「人工评审」不通过。
切在多行注释/正则中间还会产生 `SyntaxError`，函数被切成半截（历史上出现过
`fingerprint` 14 行 → 3 行的事故）。

### 约束条件

搬迁方案必须同时满足以下硬约束：

1. `package.json` 的 `"main": "./tools.js"`、`"magpie".hooks": "./gateway_harvest.hooks.js"`、
   `"magpie".middleware": "./memory.middleware.js"` 是**宿主契约**，路径不可变。
2. `tests/test_exports.mjs` 锁定 `tools.js` 的导出面只能有 9 个白名单符号。
3. CONSTRAINTS.md 规定根目录**只有 3 个宿主入口门面**，且门面只做 re-export，
   去掉注释与 import/export 后**残留代码必须为 0**。
4. 导出面不变——84 套测试全部依赖它。
5. **不得移动既有小文件的同时做拆分**：两者必须分开做。

## Decision

**根目录文件保留薄门面（thin facade，仅 re-export），实现移入 `src/`。**

具体地：

### 1. 目录分层

`src/` 下按职责划为 7 个一级子目录（与 `verify_delivery.py` 第 6 项的白名单一致）：

| 目录 | 职责 |
|---|---|
| `src/core/` | 基础设施：配置、宿主本地状态、时间窗口、凭据脱敏 |
| `src/domain/` | 领域逻辑：指纹、相关性评分、语义去重、模型调用预算、有效性校验 |
| `src/integration/` | 外部集成：NoCodeBackend、Cloudflare R2、MCP 客户端、Schema、在线模型 |
| `src/middleware/` | 网关中间件：请求注入、流式事件、响应清洗 |
| `src/services/` | 业务服务：`save/` 记忆写入、`audit/` 去重审计、`harvest/` 对话采集 |
| `src/tools/` | MCP 工具入口（9 个记忆/踩坑工具） |
| `src/page/` | 设置页：信标执行器 + 前端脚本 |

依赖方向自上而下（`index → tools → services → integration → core`，`domain` 位于
`integration` 之下、`core` 之下），反向依赖禁止（细节见
[ARCHITECTURE.md](ARCHITECTURE.md#依赖方向规则)）。

### 2. 门面规则

- 根目录保留 15 个 `.js` 文件，每个 6–14 行，**内容只有 `export` 声明与注释头**。
- 其中 **3 个是宿主入口门面**（`tools.js`、`memory.middleware.js`、`gateway_harvest.hooks.js`），
  受 CONSTRAINTS.md「根目录只有 3 个宿主入口门面」与「残留代码为 0」双重约束。
- 其余 **12 个是兼容门面**，只为保住①③两类引用而存在。
- 门面用 `export * from` 或具名 `export { X } from` 转出，**不写任何实现**。
- 每个文件保留标准注释头（模块职责 / 依赖 / 被依赖），与 `src/` 内模块格式一致。

### 3. 迁移方式：**物理移动实现 + 保留门面**，而非直接 `git mv`

由于三类引用中②③无法被 codemod 覆盖，迁移必须在**保持根目录文件路径不变**的前提下，
只把函数体搬到 `src/`，让①类引用**根本不需要改写**——根文件仍在原位，指向它的
import 继续有效。②③两类引用因为指向的仍是同一个路径，**同样零改动**。

这正是「保留门面」的核心价值：它把「搬迁 268 条引用」这个高风险动作，
降级为「新增 49 个文件 + 复制函数体」这个零引用变更。

### 4. 分批落地顺序

实现与拆分**严格分开**，每批一个 commit（`CONSTRAINTS.md`：
「不得移动既有小文件的同时做拆分」）：

| 批次 | 内容 | 提交 |
|---|---|---|
| Stage 1 | 抽出 `core/` 与 `domain/` 模块 | `cec2380` |
| Stage 2 | 抽出 `integration/ncb.js` | `5d37219` |
| Stage 3 | 抽出 `services/save/` 与 `services/audit/` | `5cb263d` |
| Stage 4 | 抽出 `tools/` 处理器与 `src/index.js` | `489afa4` |
| Stage 5 | `tools.js` 转为薄门面并更新测试读取路径 | `5a782af` |
| Phase 1 | 抽出 `middleware/stream-utils`、`event-stream`、`response-hook` | `f4749aa` |
| Phase 2 | 抽出 `middleware/inject-builder`、`request-inject` | `d3ffc88` |
| Phase 3 | 抽出 `services/harvest/*` 10 个模块 | `e74a912` |
| Phase 4 | `gateway_harvest.hooks.js` 转为薄门面 | `83f8189` |
| v6.43.0 | 合并为一次发布：3 个巨石 4 488/1 409/1 213 行 → 14/8/6 行 | `e7b7a20` |
| 后续 | 逐个把剩余根文件门面化（`schema.js` / `semantic_dedup.js` / `model_budget.js` / `ncb_mcp.js` / `mcp_client.js` / `db_tools.js` / `r2.js` / `online_models.js` / `page_actions.js` / `local_state.js` / `scrub.js`） | `5e93fd5` … `a673dd6` |

落地结果：根目录 `.js` 从 16 个 / 17 048 行降为 15 个 / 103 行；
`src/` 新增 49 个模块 / 17 165 行；**总行数几乎不变**（净增约 220 行，全部来自
各模块新增的注释头与分层后的显式 import）——这是「纯移动」的预期特征。

## Consequences

### 正面后果

- **零引用破坏**。268 条引用一条都不用改。直接搬迁会失败 75 个测试，
  保留门面把失败数降到 **0**。
- **宿主契约零变更**。`package.json` 的三个入口路径、`settings.html` 的
  `src/page/settings.*` 相对引用全部保持原样，宿主与前端零感知。
- **分层清晰可查**。每个模块都能在注释头写清「职责 / 依赖 / 被依赖」，
  满足 CONSTRAINTS.md 对模块注释头的要求。
- **单一真相源**。`scrub.js` → `src/core/sanitize.js`、`local_state.js` → `src/core/state.js`、
  `schema.js` → `src/integration/schema.js` 等实现各有唯一居所。
- **可回滚**。门面机制让「撤销重构」退化为删目录 + 恢复根文件。

### 负面后果（必须正视）

1. **根目录看起来「文件很多」**。
   15 个 `.js` 躺在根目录，每个 6–14 行，视觉上像是「有一堆模块」，
   实际上其中 12 个只是转发壳。新人第一眼容易误判工程规模，
   必须靠本文档的「当前的门面清单」表来消歧。

2. **`test_structure.mjs` 需要维护白名单**。
   CONSTRAINTS.md 规定「根目录只有 3 个宿主入口门面」，但实现上为了保住②③类引用，
   实际有 15 个根 `.js` 文件。两者必须靠一份**显式白名单**对齐，否则门禁会误报。
   白名单形如：

   ```
   宿主入口门面（3）：tools.js / memory.middleware.js / gateway_harvest.hooks.js
   兼容门面（12）  ：gateway_harvest.js / local_state.js / scrub.js / ncb_mcp.js /
                     mcp_client.js / db_tools.js / r2.js / schema.js /
                     semantic_dedup.js / model_budget.js / online_models.js /
                     page_actions.js
   ```

   **每新增或删除一个根门面，白名单必须同步更新**，否则「结构门禁」会变成
   「需要改白名单才能变绿的门禁」——这正是 CONSTRAINTS.md 反对的「为了让改动通过
   而弱化约束」。

3. **门禁脚本存在缺口（当前状态，需补齐）**。
   实测于 `8ec2574`：`tests/check_cycles.mjs`、`tests/test_structure.mjs`、
   `tests/check_split_equiv.mjs` **在仓库树中并不存在**（全部远端分支历史中也未出现过）。
   也就是说 CONSTRAINTS.md 声明的「无循环依赖」「门面只做 re-export」「拆分等价性」
   三条架构约束**目前没有机器检查兜底**。实测静态导入图存在 2 条循环依赖
   （`index → page/actions → harvest/index → harvest-pipeline → index`，
   以及 `page/actions → harvest/index → harvest-pipeline → offline-scan → page/actions`），
   它们经由门面的活绑定收敛，当前不产生运行期 `undefined`，但缺少自动化门禁意味着
   后续改动可能在无人察觉的情况下引入真正的循环。

   **待办**：补齐上述三个脚本，其中 `test_structure.mjs` 必须内置第 2 条的白名单。

4. **`export *` 的导出面比具名导出宽**。
   `gateway_harvest.js` / `gateway_harvest.hooks.js` 等使用 `export *`，
   实现文件新增导出即等于门面新增导出，可能越过 `tests/test_exports.mjs` 的白名单。
   目前 `tools.js` 用的是具名 `export { X } from`（9 项白名单），
   是更严格的做法；`export *` 仅用于不受导出面门禁约束的兼容门面。

5. **重构不等于解耦**。
   本次是**纯移动**：总行数几乎不变，`core → domain`、`services → page`、
   `services → index` 三处反向依赖依然存在（见 ARCHITECTURE.md 的依赖方向规则表）。
   这些是后续单独排期的议题，与本次 ADR 无关。

### 后续行动

| 事项 | 负责 | 状态 |
|---|---|---|
| 补齐 `tests/test_structure.mjs`（含 15 个根门面白名单） | 待排期 | ⬜ 未开始 |
| 补齐 `tests/check_cycles.mjs`（拦截上文 2 条既有循环） | 待排期 | ⬜ 未开始 |
| 补齐 `tests/check_split_equiv.mjs` | 待排期 | ⬜ 未开始 |
| 消除 `services → page` / `services → index` 反向依赖 | 待排期 | ⬜ 未开始 |
| 为 `export *` 兼容门面补导出面白名单断言 | 待排期 | ⬜ 未开始 |

### 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 分层模型、模块清单、门面机制、守护脚本现状
- `CONSTRAINTS.md` — 本 ADR 所属约束的唯一权威来源
- `AGENTS.md` — 「已知的历史教训」中记录的 75 个测试崩溃事故
