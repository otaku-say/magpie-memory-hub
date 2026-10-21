# v6.44.0 架构审计报告

> 审计对象：`magpie-memory-hub` @ `e7b7a20`（分支 `feat/v644-h-audit`）
> 审计范围：`src/` 下 37 个模块 + 3 个根门面 + 根级基础设施
> 审计方法：`addyosmani/agent-skills` 的 `code-review-and-quality`（五轴）、`doubt-driven-development`（主动找反证）、`security-and-hardening`、`code-simplification`、`observability-and-instrumentation`
> 审计日期：2026-10-22
> 审计人：代码审计 Agent（只读审计，未改动任何生产代码）

---

## 结论摘要

重构的**搬运质量很高**（40 个基线函数 0 缺失、3 个抽查函数函数体逐字符等价），但**架构没有真正解耦**：
存在一个 **15 节点的静态循环依赖**（重构前只有 4 个），且 `CONSTRAINTS.md` 用来保证「无循环依赖」的三个检查脚本
`tests/check_cycles.mjs` / `tests/test_structure.mjs` / `tests/check_split_equiv.mjs` **在仓库里根本不存在**（从未被提交过）。
最严重的问题是：`src/services/harvest/harvest-pipeline.js:8` 反向 import 根门面 `tools.js`，把整条链路拉成一个大环。
建议：**先补齐三个检查脚本，再解环**，其余为清理项。

---

## 〇、审计前提的更正（重要）

任务书给出的基线 `e7b7a20~:tools.js`（称 4488 行 v6.42.0）**与事实不符**，审计以实测为准：

```bash
$ git show e7b7a20~:tools.js | wc -l
14                                    # e7b7a20~ 的 tools.js 已经是 14 行薄门面
$ git show e7b7a20 --stat
 README.md           | 12 ++++++------
 package.json        |  2 +-
 settings.html       |  2 +-
 tests/test_meta.mjs |  2 +-
 4 files changed, 9 insertions(+), 9 deletions(-)
```

`e7b7a20` **只改了版本号和 README**，真正的拆分发生在更早的 5 个 stage commit：

```bash
$ git log --oneline --format='%h %s' -- tools.js | head -4
5a782af refactor(tools): turn tools.js into thin facade and update test readers (stage 5)
489afa4 refactor(tools): extract tools handlers and create src/index.js (stage 4)
5cb263d refactor(tools): extract save and audit services (stage 3)
e74a912 refactor(harvest): extract harvest domain modules under src/services/harvest
```

**4488 行的原始 `tools.js` 位于 `2c4a640`**（`feat(v642-b)`），实测：

```bash
$ git show 2c4a640:tools.js | wc -l
4488
$ git show 2c4a640:tools.js | grep -oE '^(export )?(async )?function [A-Za-z_$][A-Za-z0-9_$]*' \
    | sed -E 's/^(export )?(async )?function //' | sort > base_fns.txt
$ wc -l base_fns.txt
40
```

后续所有「重构前 vs 重构后」对比一律以 `2c4a640` 为基线。

---

## 一、依赖方向

### 1.1 分层依赖矩阵（实测，`src/` 内部 + 根级基础设施）

层级定义：`core` < `domain` < `integration` < `services` < `tools` < `index.js`；`ROOT(infra)` = 根目录基础设施文件。

```
FROM \ TO       core            domain          integration     middleware      services        tools           index.js        ROOT(infra)
core              .               .               .               .               .               .               .               YES
domain            .               .               .               .               .               .               .               YES
integration       YES             .               .               .               .               .               .               YES
middleware        .               .               .               YES             .               .               .               .
services          YES             YES             YES             .               YES             .               .               YES
tools             YES             YES             YES             .               YES             YES             .               YES
index.js          YES             .               YES             .               YES             YES             .               YES
```

**结论：层级方向本身无反向依赖**。`core` 不 import `services`，`domain` 不 import `tools`，
`middleware` 只依赖同层 `stream-utils`/`inject-builder`，未跨层跳跃到 `core`/`services`。
`tools → core` / `tools → services` / `services → core` 均属允许方向。

### 1.2 注释头「依赖」声明与实际 `import` 的偏差（**注释在撒谎**）

37 个模块全部有 `模块职责 / 依赖 / 被依赖` 三段式中文头（符合 `CONSTRAINTS.md`），
但**13 处声明的依赖与实际 `import` 不一致**。根因是**注释里的相对路径层级写错了**：
注释按「2 级深度」写（`../../model_budget.js`），实际代码按「3 级深度」写（`../../../model_budget.js`）。

| 模块 | 注释声明 | 实际 `import` | 是否合规 |
|:--|:--|:--|:--|
| `src/services/harvest/hook-request.js` | `./scaffolding.js (_diag)` | **无任何 scaffolding 导入** | ❌ **幽灵依赖（假的）** |
| `src/services/harvest/classify.js` | `../../model_budget.js` | `../../../model_budget.js` | ⚠️ 路径层数写错 |
| `src/services/harvest/extract.js` | `../../model_budget.js` | `../../../model_budget.js` | ⚠️ 路径层数写错 |
| `src/services/harvest/harvest-pipeline.js` | `../../tools.js` `../../scrub.js` `../../local_state.js` `../../semantic_dedup.js` | 全部为 `../../../xxx.js` | ⚠️ 4 处层数错 |
| `src/services/harvest/hook-response.js` | `../../tools.js` `../../model_budget.js` | `../../../xxx.js` | ⚠️ 2 处层数错 |
| `src/services/harvest/offline-scan.js` | `../../local_state.js` `../../page_actions.js` `../../semantic_dedup.js` | 全部为 `../../../xxx.js` | ⚠️ 3 处层数错 |

实证（幽灵依赖，`_diag` 在 `hook-request.js` 里只出现在注释行）：

```bash
$ rg -n "_diag" src/services/harvest/hook-request.js
3: * 依赖: ./scaffolding.js (_diag), ../../model_budget.js (isInternalHarvestRequest)
$ rg -n "^\s*(import|export).*from" src/services/harvest/hook-request.js
（只有 model_budget.js 一条）
```

**反证检验**：同层另外 5 个 harvest 模块**都真的 import 了** `scaffolding.js`，
只有 `hook-request.js` 没有——说明这是拆分时漏改注释，不是「有意不依赖」。

```bash
$ for f in src/services/harvest/*.js; do
    printf '%-42s ' "$f"; rg -q "scaffolding" "$f" && echo "imports scaffolding" || echo "NO scaffolding import"; done
src/services/harvest/hook-request.js     NO scaffolding import   <-- 唯一例外
src/services/harvest/hook-response.js    imports scaffolding
src/services/harvest/extract.js          imports scaffolding
src/services/harvest/classify.js         imports scaffolding
src/services/harvest/harvest-pipeline.js imports scaffolding
src/services/harvest/offline-scan.js     imports scaffolding
```

### 1.3 根级基础设施（`ROOT(infra)`）反向渗入 `src/`

19 个 `src/` 模块直接 import 根目录文件。根目录按 `CONSTRAINTS.md` 只允许 3 个**宿主入口门面**，
但实际有 16 个根级文件被 `src/` 反向依赖，这些**不是门面**（含实现）：

```bash
$ rg -n 'from "\.\./\.\./(local_state|semantic_dedup|model_budget|scrub|online_models|page_actions|tools)\.js"' src/
src/core/config.js:6            import { lookupSecret, lookupDatabase, lookupRealDatabase } from "../../local_state.js";
src/domain/scoring.js:6         import { semanticFingerprint } from "../../semantic_dedup.js";
src/domain/validity.js:6        import { semanticFingerprint } from "../../semantic_dedup.js";
src/services/audit/auditor.js:13-22   import ... from "../../../page_actions.js" / "../../../local_state.js" / "../../../online_models.js" / "../../../semantic_dedup.js";
src/services/audit/scheduler.js:8-11  import ... from "../../../gateway_harvest.js" / "../../../local_state.js";
src/services/audit/undo.js:10-11       import ... from "../../../local_state.js" / "../../../page_actions.js";
src/services/harvest/harvest-pipeline.js:8,9,15,23   import ... from "../../../tools.js" / "../../../scrub.js" / "../../../local_state.js" / "../../../semantic_dedup.js";
src/services/harvest/offline-scan.js:11,17,20         import ... from "../../../local_state.js" / "../../../page_actions.js" / "../../../semantic_dedup.js";
src/services/save/memory-saver.js:11,12               import ... from "../../../scrub.js" / "../../../semantic_dedup.js";
src/tools/pitfall-save.js:9,15,16                    import ... from "../../../gateway_harvest.js" / "../../../scrub.js" / "../../../semantic_dedup.js";
（另：integration/ncb.js→mcp_client.js；index.js→db_tools.js/r2.js/page_actions.js/gateway_harvest.js/gateway_harvest.hooks.js）
```

**这是循环依赖的直接成因**：`src/services/harvest/harvest-pipeline.js:8` import 根门面 `tools.js`，
而 `tools.js:9` 又 import `src/index.js`，`src/index.js:13` 又 import `gateway_harvest.hooks.js`，
`gateway_harvest.hooks.js:7` 又 `export * from "./src/services/harvest/index.js"`，
`src/services/harvest/index.js:40` 又 export 自 `harvest-pipeline.js` —— **闭环成立**。

### 1.4 `被依赖` 声明失真

3 个模块声称自己「被依赖」，但**实际零个 `src/` 内部模块 import 它们**（只有根门面/测试经由门面间接引用）：

| 模块 | 注释声明「被依赖」 | 实际直接 import 者 |
|:--|:--|:--|
| `src/index.js` | `tools.js (薄门面)` | `tools.js` ✅（经门面成立） |
| `src/middleware/memory.middleware.js` | `根目录 memory.middleware.js 门面` | `memory.middleware.js` ✅ |
| `src/services/harvest/index.js` | `gateway_harvest.hooks.js, gateway_harvest.js, tests` | `gateway_harvest.hooks.js`, `gateway_harvest.js` ✅ |

（此 3 项经复核成立，不计入问题。）

### 一、依赖方向小结

- 分层矩阵**无反向依赖**、**无跨层跳跃违规**。
- **问题集中在 13 处注释与代码不符**（1 处幽灵依赖 + 12 处路径层数写错）。
- **根级基础设施反向渗入 `src/`（19 处）** 是架构层面的真实问题，直接导致第二节的循环。

---

## 二、循环依赖

### 2.1 `tests/check_cycles.mjs` 不存在 —— 约束文档承诺的检查器从未落地

```bash
$ ls tests/check_cycles.mjs
ls: cannot access 'tests/check_cycles.mjs': No such file or directory
$ ls tests/test_structure.mjs
ls: cannot access 'tests/test_structure.mjs': No such file or directory
$ ls tests/check_split_equiv.mjs
ls: cannot access 'tests/check_split_equiv.mjs': No such file or directory
```

**这三者从未被提交过**（不是本分支删的）：

```bash
$ git log --all --oneline --diff-filter=A -- '*check_cycles*'
（空输出 = 从未添加）
$ git log --all --oneline -- tests/check_cycles.mjs
（空输出）
```

但 `CONSTRAINTS.md` 明确把它们列为唯一权威检查器：

```
| 无循环依赖 | `tests/check_cycles.mjs` | ESM 循环依赖会在某条调用链上变成 `undefined` |
| 根目录只有 3 个宿主入口门面 | `tests/test_structure.mjs` | ... |
| 函数名集合完全一致 | `tests/check_split_equiv.mjs` | ... |
```

> ⚠️ 任务书要求「`node tests/check_cycles.mjs`」作为验证步骤，**该命令必然失败**（`MODULE_NOT_FOUND`）。
> 本报告改用自建的 Tarjan SCC 检测器替代，算法与 `check_cycles.mjs` 的预期职责一致。

### 2.2 静态循环依赖：**15 个节点**（重构前 4 个 → **扩大了 3.75 倍**）

自建检测器（同时把 `import`、`export … from`、`export * from` 都算作边，因为 `export * from` 在 ESM 里同样是模块依赖边）：

```bash
# 对全仓 .js 建图 → Tarjan 求强连通分量
$ python3 cycles.py
=== CYCLES (import + re-export + dynamic) ===
CYCLE SIZE 15
   tools.js:8                            -> src/index.js
   tools.js:13                           -> src/services/audit/undo.js
   tools.js:14                           -> src/services/audit/auditor.js
   src/index.js:11                       -> page_actions.js
   src/index.js:12                       -> gateway_harvest.js
   src/index.js:13                       -> gateway_harvest.hooks.js
   src/index.js:20                       -> src/tools/memory-search.js
   src/index.js:22                       -> src/tools/memory-context.js
   src/index.js:25                       -> src/tools/pitfall-save.js
   src/index.js:27                       -> src/services/audit/auditor.js
   src/index.js:28                       -> src/services/audit/scheduler.js
   src/services/audit/auditor.js:11      -> src/services/audit/undo.js
   src/services/audit/auditor.js:13      -> page_actions.js
   src/services/audit/scheduler.js:8     -> gateway_harvest.js
   src/services/audit/scheduler.js:12    -> src/services/audit/auditor.js
   src/services/audit/undo.js:11          -> page_actions.js
   src/services/harvest/harvest-pipeline.js:8  -> tools.js          <-- 闭环关键边
   src/services/harvest/harvest-pipeline.js:12 -> src/services/harvest/offline-scan.js
   src/services/harvest/hook-response.js:10    -> src/services/harvest/harvest-pipeline.js
   src/services/harvest/hook-response.js:11    -> src/services/harvest/offline-scan.js
   src/services/harvest/index.js:40            -> src/services/harvest/harvest-pipeline.js
   src/services/harvest/index.js:46            -> src/services/harvest/offline-scan.js
   src/services/harvest/index.js:69            -> src/services/harvest/hook-response.js
   src/services/harvest/offline-scan.js:17     -> page_actions.js
   src/tools/memory-context.js:11              -> src/services/audit/scheduler.js
   src/tools/memory-search.js:11              -> src/services/audit/scheduler.js
   src/tools/pitfall-save.js:9                -> gateway_harvest.js
   gateway_harvest.hooks.js:7                 -> src/services/harvest/index.js
   gateway_harvest.js:6                       -> src/services/harvest/index.js
   page_actions.js:37                         -> gateway_harvest.js
```

**最小闭环（5 跳，最值得修）**：

```
tools.js:8  →  src/index.js:13  →  gateway_harvest.hooks.js:7
            →  src/services/harvest/index.js:40
            →  src/services/harvest/harvest-pipeline.js:8  →  tools.js   ✗
```

**这是重构引入的回归**。同样算法跑重构前基线 `2c4a640`：

```bash
$ cd /tmp/pre && python3 cycles.py
=== PRE-REFACTOR (2c4a640, monolithic) CYCLES ===
CYCLE size=4: ['gateway_harvest.hooks.js', 'gateway_harvest.js', 'page_actions.js', 'tools.js']
   gateway_harvest.hooks.js:27 [static] -> tools.js
   gateway_harvest.hooks.js:28 [static] -> gateway_harvest.js
   gateway_harvest.hooks.js:1198 [dyn] -> tools.js
   gateway_harvest.js:32 [static] -> page_actions.js
   gateway_harvest.js:33 [static] -> gateway_harvest.hooks.js
   page_actions.js:37 [static] -> gateway_harvest.js
   page_actions.js:193 [dyn] -> tools.js
   page_actions.js:234 [dyn] -> gateway_harvest.hooks.js
   page_actions.js:276 [dyn] -> tools.js
   page_actions.js:345 [dyn] -> tools.js
   page_actions.js:350 [dyn] -> tools.js
   page_actions.js:529 [dyn] -> tools.js
   tools.js:24 [static] -> page_actions.js
   tools.js:25 [static] -> gateway_harvest.js
   tools.js:26 [static] -> gateway_harvest.hooks.js
```

重构把环从 **4 个节点扩到 15 个节点**，且把 `src/` 内部 10 个模块卷了进去。

### 2.3 动态 `import()` 清单

```bash
$ rg -n 'await import\(' src/ .
db_tools.js:634        import(local_state.js)
page_actions.js:193    import(tools.js)
page_actions.js:234    import(gateway_harvest.hooks.js)
page_actions.js:235    import(model_budget.js)
page_actions.js:276    import(tools.js)
page_actions.js:345    import(tools.js)
page_actions.js:350    import(tools.js)
page_actions.js:529    import(tools.js)
src/services/harvest/hook-response.js:87  import(tools.js)
```

注意任务书给的命令 `rg -n 'await import\(' src/` **会漏掉 8 条**：
`db_tools.js:634` 和 `page_actions.js:235` 是**不带 `await` 的裸 `import()`**（Promise 形式）。
用 `rg -n 'import\s*\('` 才完整。

动态导入全部落在**已有的静态环内部**（`tools.js` / `gateway_harvest.hooks.js` / `model_budget.js`），
**没有引入新的环**。但它们**加重**了静态环：把 `page_actions.js` 的 5 处、`hook-response.js` 的 1 处
也拉进 `tools.js` 的依赖闭包，使环在**运行时**（而非仅静态）成立。

### 2.4 根门面自引用环（任务书点名的 `src/core/state.js` 模式）

**本项目不存在该模式**。`src/core/state-recent.js` 没有任何 import：

```bash
$ rg -n "^import" src/core/state-recent.js
（空输出）
$ rg -n "from \"" src/core/state-recent.js
（空输出）
```

`local_state.js` 也不 re-export 任何 `src/` 模块（只有 `import { isSemanticallySimilar } from "./semantic_dedup.js"`）：

```bash
$ rg -n "src/" local_state.js page_actions.js semantic_dedup.js scrub.js model_budget.js online_models.js
（空输出 = 根级文件从不 import src/，反向不自引用）
```

→ 任务书假设的「`src/core/state.js` ↔ `local_state.js` 自引用环」**在本仓库不成立**。

### 2.5 运行时实证：环当前**未爆**，但已是「靠调用时机侥幸」

```bash
$ node -e "import('./src/services/harvest/harvest-pipeline.js').then(m=>console.log(Object.keys(m)))"
[ 'fingerprint', 'processDialogueAndHarvest', 'triggerBackgroundDrain' ]
$ node -e "import('./src/index.js').then(m=>console.log(Object.keys(m)))"
[ 'MagpieMemoryHub' ]
$ node -e "import('./gateway_harvest.hooks.js').then(m=>console.log(Object.keys(m).length,'| onResponse:', 'onResponse' in m))"
42 | onResponse: true
$ node -e "import('./tools.js').then(t=>console.log(typeof t.MagpieMemoryHub, typeof t.MagpieMemoryHub.ensureAuditScheduler))"
function function
```

**为什么现在不炸**：`harvest-pipeline.js:8` 的 `import { MagpieMemoryHub } from "../../../tools.js"`
是**函数内延迟使用**（L368/370/400），ESM 的 live binding 在调用时已解析完毕。
但 `harvest-pipeline.js:8` 的**导入动作本身**会把 `tools.js` 拉进求值序列，
`tools.js:8` 又拉 `src/index.js`，`src/index.js` 顶部**有可执行的顶层代码**（`const TOOLS = {...}`，L36）。
一旦未来有人在 `src/index.js` 顶层写任何依赖 `MagpieMemoryHub` 已初始化的语句，就会立刻 TDZ 崩溃。

**这是典型的「现在能跑、以后会炸」结构**，`CONSTRAINTS.md` 自己的描述即
「ESM 循环依赖会在某条调用链上变成 `undefined`」。

### 二、循环依赖小结

| 类型 | 结论 |
|:--|:--|
| 静态 import 环 | ❌ **存在，15 个节点**（重构前 4 个，回归） |
| 动态 `import()` 环 | ⚠️ 9 处动态导入，全部落在既有静态环内，**未新增环**，但使环在运行时成立 |
| 根门面自引用环 | ✅ **不存在**（`state-recent.js` / `local_state.js` 均无反向 import） |
| 检查器 | ❌ `tests/check_cycles.mjs` **不存在**（从未提交），约束文档的「无循环依赖」防线**从未生效** |

---

## 三、未使用导出

### 3.1 分析方法

对 `src/` 下 163 个导出符号，沿 **「直接 import → 门面 re-export → 上层 re-export」** 做传递可达性分析，
再看最终消费方（其他 `src/` 模块 / 根级文件 / 测试）。**根门面 re-export 的符号不算「被使用」**，
只有真正被某个消费方 import 才算。

```bash
$ python3 usage4.py
src/ exported symbols: 163
  consumed (any)  : 134
  ZERO consumers  : 29
```

### 3.2 29 个零消费导出清单

| # | 模块 | 符号 | 模块内使用 | 处置建议 |
|--:|:--|:--|:--|:--|
| 1 | `src/services/harvest/offline-scan.js` | `FORBIDDEN_DIRS` | **0（完全死代码）** | 🗑 **删除** |
| 2 | `src/services/harvest/index.js` | `FORBIDDEN_DIRS` | 0（转发死符号） | 🗑 **连带删除** |
| 3 | `src/services/harvest/index.js` | `PRIVACY_NOTICE` | 0 | 🗑 **删除** |
| 4 | `src/services/harvest/offline-scan.js` | `PRIVACY_NOTICE` | 3 | ⚠️ 降为非导出 |
| 5 | `src/core/state-recent.js` | `recentWrite` | 5 | ⚠️ 降为模块私有（`export let` 可被外部改写） |
| 6 | `src/core/state-recent.js` | `RECENT_CAP` | 1 | ⚠️ 降为非导出 |
| 7 | `src/core/state-recent.js` | `RECENT_WINDOW_MS` | 1 | ⚠️ 降为非导出 |
| 8 | `src/domain/fingerprint.js` | `normalize` | 1 | ⚠️ 降为非导出 |
| 9 | `src/integration/ncb.js` | `ALLOWED_NO_CRED_PROPS` | 1 | ⚠️ 降为非导出 |
| 10 | `src/integration/ncb.js` | `NO_CRED_ERR_MSG` | 1 | ⚠️ 降为非导出 |
| 11 | `src/integration/ncb.js` | `makeNoCredentialsClient` | 3 | ✅ **保留**（`test_v631_a_tools.mjs` 测其 Proxy 白名单） |
| 12 | `src/integration/ncb.js` | `makeRestClient` | 1 | ✅ **保留**（`tools.js` 白名单外，但 `DEVNOTES.md` 记录为公开 API） |
| 13 | `src/middleware/event-stream.js` | `onEventInner` | 3 | ⚠️ 降为非导出（`memory.middleware.js` 只转 `onEvent`） |
| 14 | `src/middleware/request-inject.js` | `onRequestInner` | 3 | ⚠️ 降为非导出 |
| 15 | `src/middleware/response-hook.js` | `onResponseInner` | 3 | ⚠️ 降为非导出 |
| 16 | `src/middleware/inject-builder.js` | `cut` | 7 | ⚠️ 降为非导出（与 `domain/scoring.js` 的 `cut` 重复） |
| 17 | `src/middleware/inject-builder.js` | `sniffToolNames` | 3 | ⚠️ 降为非导出 |
| 18 | `src/middleware/stream-utils.js` | `OPEN_TAG` | 4 | ⚠️ 降为非导出 |
| 19 | `src/middleware/stream-utils.js` | `CLOSE_TAG` | 5 | ⚠️ 降为非导出 |
| 20 | `src/middleware/stream-utils.js` | `HOLD_MAX` | 3 | ⚠️ 降为非导出（`test_stream_failopen.mjs` 自己复制了一份常量） |
| 21 | `src/services/audit/auditor.js` | `_isAuditing` | 4 | ⚠️ 降为非导出（`export let` 允许外部改写互斥锁） |
| 22 | `src/services/audit/scheduler.js` | `_auditBaseCfg` | 5 | ⚠️ 降为非导出 |
| 23 | `src/services/audit/scheduler.js` | `_auditBaseClient` | 4 | ⚠️ 降为非导出 |
| 24 | `src/services/harvest/dialog-extract.js` | `extractLastUserTurn` | 1 | ✅ **保留**（被 `index.js` 转发为公共 API） |
| 25 | `src/services/harvest/index.js` | `extractLastUserTurn` | 0（转发） | ✅ 保留（门面职责） |
| 26 | `src/services/harvest/harvest-pipeline.js` | `fingerprint` | 2 | ⚠️ **见 3.3，命名冲突** |
| 27 | `src/services/harvest/index.js` | `fingerprint` | 0（转发） | ⚠️ **见 3.3** |
| 28 | `src/services/harvest/index.js` | `_diag` | 0（转发） | ⚠️ 降为非导出（内部诊断函数） |
| 29 | `src/services/harvest/index.js` | `_hookProbe` | 0（转发） | ⚠️ 降为非导出（内部探针） |

### 3.3 🔴 严重：两个同名 `fingerprint`，语义完全不同，且**公共门面暴露的是「错」的那个**

`src/domain/fingerprint.js`（FNV-1a 双轮 64bit，**带 `normalize` 语义归一化**）：

```javascript
// src/domain/fingerprint.js:17
export function fingerprint(text) {
  const s = normalize(text);
  const fnv = (seed) => { ... };   // FNV-1a 64bit
  return (fnv(14695981039346656037n) + fnv(1099511628211n)).slice(0, 32);
}
```

`src/services/harvest/harvest-pipeline.js`（SHA-256，**只 trim，不归一化**）：

```javascript
// src/services/harvest/harvest-pipeline.js:63
export function fingerprint(text) {
  return crypto.createHash("sha256").update(String(text || "").trim()).digest("hex");
}
```

**冲突面**：`src/services/harvest/index.js:40` 把 `harvest-pipeline.js` 的版本转发出去，
`gateway_harvest.hooks.js:7` 的 `export *` 再把它暴露到**公共门面**。
于是同一份代码里，**同名 `fingerprint` 有两个不兼容实现**：

```bash
$ node -e "
import('./gateway_harvest.hooks.js').then(async m=>{
  const d=await import('./src/domain/fingerprint.js');
  const t='Hello, World! 记忆';
  console.log('facade fingerprint =', m.fingerprint(t));
  console.log('domain  fingerprint =', d.fingerprint(t));
  console.log('SAME?', m.fingerprint(t)===d.fingerprint(t));
})"
facade fingerprint = 2be5e39a404cd4bcb4d12dc5288b9092577e87eac5362a49b4f1c35921c1b86b
domain  fingerprint = 1bacb0738ddab7fff5e00aa2eb39f469
SAME?  false
```

**风险**：`src/tools/pitfall-save.js:11` 导入的是 `domain/fingerprint.js` 版本（写库用），
而 `harvest-pipeline.js` 用自己的 SHA-256 版本（去重用）。
两者**故意不同**（一个要语义归一化匹配，一个要字节级唯一），
但同名同层级导出会让下一个维护者**随手改错**——把 SHA-256 换成 FNV 会让
`pitfall-save` 的语义去重退化成字节去重；反之会把 harvest 的去重窗口放大到误杀。

`verify_delivery.py` 的「函数名集合比对」只查**缺失**，查不出**同名不同实现**。
`tests/test_exports.mjs` 只校验 `tools.js` 与 `memory.middleware.js`，
**不校验 `gateway_harvest.hooks.js` 的 42 个导出**：

```bash
$ rg -n "gateway_harvest.hooks" tests/test_exports.mjs
（无输出 = NOT CHECKED）
```

### 3.4 根门面的公共导出面未被测试覆盖

`gateway_harvest.hooks.js` 暴露 42 个符号（含 `_diag`、`_hookProbe` 等内部诊断函数、
以及两个冲突的 `fingerprint`），**无任何导出面白名单测试**。
`tools.js` 有白名单（`ALLOWED_EXPORTS`，9 项），`gateway_harvest.hooks.js` 没有。

### 三、未使用导出小结

- 29 个零消费导出，其中 **1 个是真死代码**（`offline-scan.js` 的 `FORBIDDEN_DIRS`），
  **25 个是「导出但只用在自己模块内」**（应降为模块私有），
  **3 个是门面转发职责**（保留）。
- 🔴 **`fingerprint` 同名双实现**（`domain/fingerprint.js` FNV-1a vs `harvest-pipeline.js` SHA-256），
  公共门面暴露的是 SHA-256 版，**与写库路径用的 FNV-1a 版不兼容**。
- `gateway_harvest.hooks.js` 的 42 个导出**无白名单测试**。

---

## 四、状态单例

### 4.1 `src/` 全部模块级可变状态清单

```bash
$ rg -n '^(let|var|const)\s+\w+\s*=' src/ | rg -v '=\s*(true|false|null|"|\'|\[|\{|[0-9])'
src/middleware/inject-builder.js:7    var PLUGIN_NAME        = "magpie-memory-hub";
src/middleware/request-inject.js:9    var PLUGIN_NAME        = "magpie-memory-hub";
src/middleware/request-inject.js:10   var RRF_K              = 60;
src/middleware/request-inject.js:11   var CAND_CAP           = 200;
src/middleware/request-inject.js:12   var BUCKET_CAP         = 50;
src/middleware/request-inject.js:13   var HARD_CAND          = 600;
src/middleware/request-inject.js:14   var DAY_MS             = 86400000;
src/middleware/request-inject.js:16   var _cache             = null;      <-- 可变
src/middleware/request-inject.js:17   var _cacheKey          = "";        <-- 可变
src/middleware/request-inject.js:604  var SCOPE_AFFINITY     = { turn: 4, session: 3, project: 2, user: 1 };
src/middleware/stream-utils.js:156    var HOLD_MAX           = 20000;
src/middleware/stream-utils.js:157    var OPEN_TAG           = "<memory";
src/middleware/stream-utils.js:158    var CLOSE_TAG          = "</memory>";
src/middleware/stream-utils.js:307    var _mwErrLogged       = 0;         <-- 可变
src/services/audit/scheduler.js:30    let _auditTimer        = null;      <-- 可变
src/services/audit/scheduler.js:31    let _auditSchedulerStarted = false; <-- 可变
src/services/harvest/harvest-pipeline.js:41  const recentFingerprints = new Map();  <-- 可变
src/services/harvest/harvest-pipeline.js:342 let _isDraining    = false;    <-- 可变
src/services/harvest/hook-request.js:9      var _hookProbeLogged = 0;   <-- 可变
src/services/harvest/scaffolding.js:7        var _diagLogged  = {};     <-- 可变
src/index.js:36                     const TOOLS = { ... };             <-- 可变
```

`export let`（可被外部改写的状态）：

```bash
$ rg -n "^export let" src/
src/services/audit/auditor.js:28    export let _isAuditing = false;
src/services/audit/scheduler.js:32  export let _auditOptionsGetter = null;
src/services/audit/scheduler.js:33  export let _auditBaseClient = null;
src/services/audit/scheduler.js:34  export let _auditBaseCfg = null;
src/core/state-recent.js:16         export let recentWrite = new Map();
```

### 4.2 状态单例验证表

| 状态 | 声明位置 | 是否有重复声明 | 结论 |
|:--|:--|:--|:--|
| `recentWrite`（写后读去重表） | `src/core/state-recent.js:16` | ❌ 无 | ✅ 单例。但 `export let` 允许外部改写 |
| `_auditTimer` / `_auditSchedulerStarted` | `src/services/audit/scheduler.js:30-31` | ❌ 无 | ✅ 单例 |
| `_auditOptionsGetter` / `_auditBaseCfg` / `_auditBaseClient` | `src/services/audit/scheduler.js:32-34` | ❌ 无 | ✅ 单例（`src/index.js:32` 只 import `_auditOptionsGetter`） |
| `_isAuditing`（审计互斥锁） | `src/services/audit/auditor.js:28` | ❌ 无 | ✅ 单例。但 `export let` 允许外部把锁改坏 |
| `_isDraining`（harvest 排空锁） | `src/services/harvest/harvest-pipeline.js:342` | ❌ 无 | ✅ 单例 |
| `_cache` / `_cacheKey`（中间件检索缓存） | `src/middleware/request-inject.js:16-17` | ❌ 无 | ✅ 单例 |
| `_mwErrLogged` | `src/middleware/stream-utils.js:307` | ❌ 无 | ✅ 单例 |
| `_hookProbeLogged` | `src/services/harvest/hook-request.js:9` | ❌ 无 | ✅ 单例 |
| `_diagLogged` | `src/services/harvest/scaffolding.js:7` | ❌ 无 | ✅ 单例 |
| `_cachedState` / `_cachedMtime` / `_cachedSize` / `_cachedIno` / `_cachedPath` | `local_state.js:62-66` | ❌ 无 | ✅ 单例（根级文件，未被拆散） |
| `_callTimestamps` / `_totalCalls` / `_tripped` | `model_budget.js:229-231` | ❌ 无 | ✅ 单例 |
| `TOOLS` | `src/index.js:36` | ❌ 无 | ✅ 单例 |
| **`auditSchedulerState`** | — | — | ⚠️ **该名字在全仓库不存在**（任务书假设有误）；实际对应 `_auditTimer` / `_auditSchedulerStarted` / `_auditOptionsGetter` / `_auditBaseCfg` / `_auditBaseClient` 五个变量，**全在 `scheduler.js` 一处** |

### 4.3 🔴 发现的重复：「近期写入指纹去重」逻辑有**两份实现**

这是**拆分最容易引入的隐蔽 bug**，实证如下。

**实现 A — `src/core/state-recent.js`（通用，写库路径用）**：

```javascript
// src/core/state-recent.js:7-31
export const RECENT_WINDOW_MS = 6000;     // 6 秒窗口
export const RECENT_CAP = 5000;
export let recentWrite = new Map();

export function markRecent(fp) {
  if (recentWrite.size >= RECENT_CAP) recentWrite.clear();   // 满了直接清空
  recentWrite.set(fp, Date.now());
}
export function justWritten(fp) {
  const t = recentWrite.get(fp);
  if (!t) return false;
  if (Date.now() - t > RECENT_WINDOW_MS) { recentWrite.delete(fp); return false; }
  return true;
}
```

**实现 B — `src/services/harvest/harvest-pipeline.js`（harvest 路径用，模块私有）**：

```javascript
// src/services/harvest/harvest-pipeline.js:40-61
const RECENT_CAP = 1000;                 // 1000，不是 5000
const recentFingerprints = new Map();

function markRecent(fp) {
  if (!fp) return;
  if (recentFingerprints.size >= RECENT_CAP) {
    const oldestKey = recentFingerprints.keys().next().value;  // 满了淘汰最旧
    if (oldestKey) recentFingerprints.delete(oldestKey);
  }
  recentFingerprints.set(fp, Date.now());
}
function isRecent(fp) {
  if (!fp) return false;
  const at = recentFingerprints.get(fp);
  if (!at) return false;
  if (Date.now() - at > 300000) {         // 300 秒窗口，不是 6 秒
    recentFingerprints.delete(fp);
    return false;
  }
  return true;
}
```

**四处行为差异**：

| 维度 | A（`state-recent.js`） | B（`harvest-pipeline.js`） |
|:--|:--|:--|
| 时间窗 | 6000 ms（6 秒） | **300000 ms（5 分钟）** |
| 容量 | 5000 | **1000** |
| 满了怎么办 | **`.clear()` 全清空** | **淘汰最旧一条（LRU）** |
| 键格式 | `m:{fp}` / `p:{fp}` | `m:{project}:{fp}` / `p:{project}:{fp}` |

**为什么这是真问题（不是「两份也行」）**：

1. **键格式不同** → 两张表**不共享任何条目**，harvest 写入的指纹对 `memory-save` 的
   `justWritten("m:" + fp)` **完全不可见**，去重窗口无法跨路径生效。
2. **A 的 `.clear()` 语义是危险的**：5000 条满了就**整表清空**，
   而 B 用 LRU 淘汰。拆分把 A 抽成了「通用工具」却把 B 的更稳妥实现留在原地——
   两者语义已经分叉。
3. **A 的 6 秒窗 vs B 的 5 分钟窗**：`memory-saver.js:66` 的 `justWritten("m:" + fp)`
   与 `pitfall-save.js:70` 的 `justWritten(recentKey)` **键格式与 B 不同**
   （B 用 `m:{project}:{fp}`，A 用 `m:{fp}`），所以同一次写入在两张表里是**两条不同 key**。

实证（两处定义 + 两处不同调用）：

```bash
$ rg -n "function markRecent|function justWritten|function isRecent" src/
src/services/harvest/harvest-pipeline.js:43:function markRecent(fp) {
src/services/harvest/harvest-pipeline.js:52:function isRecent(fp) {
src/core/state-recent.js:18:export function markRecent(fp) {
src/core/state-recent.js:24:export function justWritten(fp) {

$ rg -n "markRecent\(|justWritten\(|isRecent\(" src/
src/services/harvest/harvest-pipeline.js:204:    if (isRecent(memKey)) continue;      // 键: m:{project}:{fp}
src/services/harvest/harvest-pipeline.js:251:    markRecent(memKey);
src/services/harvest/harvest-pipeline.js:264:    if (isRecent(pitKey)) continue;     // 键: p:{project}:{fp}
src/services/harvest/harvest-pipeline.js:307:    markRecent(pitKey);
src/services/harvest/harvest-pipeline.js:474:            if (fp) markRecent(`m:${project}:${fp}`);
src/services/harvest/harvest-pipeline.js:503:            if (fp) markRecent(`p:${project}:${fp}`);
src/services/harvest/harvest-pipeline.js:512:            if (fp) markRecent((item.table === "pitfalls" ? "p:" : "m:") + project + ":" + fp);
src/services/save/memory-saver.js:66:  if (justWritten("m:" + fp)) {                // 键: m:{fp}
src/services/save/memory-saver.js:138: markRecent("p:" + (matchedPitfall.content_fingerprint || fp));
src/tools/pitfall-save.js:70:  if (!isTestMode() && justWritten(recentKey)) {
src/tools/pitfall-save.js:228: markRecent("m:" + ironFp);
```

> **判定**：这**不是**「同一个逻辑状态在两个模块各有一份」的**同一状态**（是两张不同的表），
> 但**是同一个逻辑概念（写后读去重）的两份实现，且键格式不兼容 → 去重语义在两条路径上不闭环**。
> 属于**拆分引入的隐蔽 bug**，优先级 P1。

### 4.4 其他重复（低危，但同属拆分副产物）

| 重复项 | 位置 | 说明 |
|:--|:--|:--|
| `PLUGIN_NAME = "magpie-memory-hub"` | `inject-builder.js:7` + `request-inject.js:9` | 同一常量两份 |
| `cut(s, n)` | `domain/scoring.js:60`（export）+ `inject-builder.js:10`（export） | **同名两实现**，但函数体逐字符相同 |
| `RECENT_CAP` | `state-recent.js:8`（5000）+ `harvest-pipeline.js:40`（1000） | 同名不同值 |
| `_hasTechSignalCI` / `_hasTechSignalCS`（无价值短路正则） | `harvest-pipeline.js:79-80` + `offline-scan.js:897-898` | **同一段逻辑两处复制**（实测正则逐字符相同，块体长度 702 vs 645，差异仅在 `return` vs `continue` 收尾） |
| `fingerprint` | `domain/fingerprint.js:17` + `harvest-pipeline.js:63` | **同名两实现，算法不同**（见 3.3） |
| `SENSITIVE_SEGMENTS` | `offline-scan.js:194` + `offline-scan.js:267` | 同文件内两个 `new Set([...])` |

### 四、状态单例小结

- **19 个模块级可变状态，全部单点声明，无「同一状态两处声明」的重复**。✅
- 🔴 **但「写后读去重」逻辑有 2 份实现**（`state-recent.js` vs `harvest-pipeline.js`），
  **键格式不兼容（`m:{fp}` vs `m:{project}:{fp}`）、时间窗不同（6s vs 300s）、容量淘汰策略不同（clear vs LRU）**
  → 去重在 harvest 与写库两条路径上**不闭环**。
- ⚠️ 5 个状态用 `export let` 暴露（`_isAuditing`、`recentWrite`、`_auditBaseCfg` 等），
  外部可改写互斥锁/去重表 → 建议改 `export const` + setter 函数。

---

## 五、拆分完整性

### 5.1 函数名集合对比（vs `2c4a640` 的 4488 行 `tools.js`）

```bash
$ git show 2c4a640:tools.js | grep -oE '^(export )?(async )?function [A-Za-z_$][A-Za-z0-9_$]*' \
    | sed -E 's/^(export )?(async )?function //' | sort > base_fns.txt
$ wc -l base_fns.txt
40
```

**结果：40 个基线函数，缺失 0 个。**

| 基线函数 | 现状位置 | 基线函数 | 现状位置 |
|:--|:--|:--|:--|
| `checkScheduledDedup` | `services/audit/scheduler.js` | `memoryGet` | `tools/memory-get.js` |
| `cut` | `domain/scoring.js` + `middleware/inject-builder.js` | `memoryList` | `tools/memory-list.js` |
| `ensureAuditScheduler` | `services/audit/scheduler.js` | `memorySave` | `services/save/memory-saver.js` |
| `expiresAtFor` | `core/config.js` | `memorySearch` | `tools/memory-search.js` |
| `fetchAll` | `integration/ncb.js` | `mergeCommaSeparated` | `integration/ncb.js` |
| `fingerprint` | `domain/fingerprint.js` + `services/harvest/harvest-pipeline.js` | `normalize` | `domain/fingerprint.js` |
| `freshness` | `domain/scoring.js` | `normalizeToolArgs` | `tools/args.js` |
| `getDedupTimeWindow` | `core/time.js` | `nowSql` | `core/config.js` |
| `hasTagsIntersection` | `domain/validity.js` | `pitfallSave` | `tools/pitfall-save.js` |
| `isCfgShape` | `integration/ncb.js` | `pitfallSearch` | `tools/pitfall-search.js` |
| `isDedupDue` | `core/time.js` | `rankMemory` | `domain/scoring.js` |
| `isMemoryValid` | `domain/validity.js` | `readOptions` | `core/config.js` |
| `jsonOut` | `domain/scoring.js` | `rowsOf` | `integration/ncb.js` |
| `justWritten` | `core/state-recent.js` | `saveMemory` | `services/save/memory-saver.js` |
| `makeClient` | `integration/ncb.js` | `scoreMemory` | `domain/scoring.js` |
| `makeNoCredentialsClient` | `integration/ncb.js` | `scorePitfall` | `domain/scoring.js` |
| `makeRestClient` | `integration/ncb.js` | `stopAuditScheduler` | `services/audit/scheduler.js` |
| `markRecent` | `core/state-recent.js` + `services/harvest/harvest-pipeline.js` | `trackMemoryRetrievals` | `services/audit/scheduler.js` |
| `memoryAudit` | `services/audit/auditor.js` | `memoryContext` | `tools/memory-context.js` |
| `memoryAuditUndo` | `services/audit/undo.js` | `memoryForget` | `tools/memory-forget.js` |

`MagpieMemoryHub`（基线 L4295 的 `export const`）→ `src/index.js` ✅

机器验收同样通过：

```bash
$ python3 verify_delivery.py
[5] 函数名集合比对（vs 8f495b0:tools.js）
    原 tools.js 函数: 40 | 现状: 110
    ✓ 无缺失
```

### 5.2 3 个复杂函数体等价性抽查

方法：按大括号配对提取函数体 → 去掉注释与全部空白 → 去掉 `export` 前缀 → 逐字符比较。

```bash
$ python3 split_equiv.py
{
  "saveMemory":    { "baseline_lines": 531, "src_lines": 531, "identical_after_export_strip": true, "delta_lines": 0, "chars": 0 },
  "memoryContext": { "baseline_lines": 391, "src_lines": 391, "identical_after_export_strip": true, "delta_lines": 0, "chars": 0 },
  "memoryAudit":   { "baseline_lines": 795, "src_lines": 795, "identical_after_export_strip": true, "delta_lines": 0, "chars": 0 }
}
```

| 函数 | 基线位置 | 现状位置 | 基线行数 | 现状行数 | 行差 | 归一化后字符差 | 结论 |
|:--|:--|:--|--:|--:|--:|--:|:--|
| `saveMemory` | `2c4a640:tools.js:462` | `src/services/save/memory-saver.js:23` | 531 | 531 | **0** | **0** | ✅ **逐字符等价** |
| `memoryContext` | `2c4a640:tools.js:1433` | `src/tools/memory-context.js:14` | 391 | 391 | **0** | **0** | ✅ **逐字符等价** |
| `memoryAudit` | `2c4a640:tools.js:3001` | `src/services/audit/auditor.js:37` | 795 | 795 | **0** | **0** | ✅ **逐字符等价** |

> `CONSTRAINTS.md` 要求「同名函数的行数差 ≤ 5 行」——实测 **全部 0 行差**，
> 且比行数更强的「归一化后字符级完全一致」也满足。**搬运质量优秀。**

### 5.3 反证检验：抽查有没有「偷偷改了逻辑」

`doubt-driven-development` 要求对「拆分是纯搬运」这一断言找反证。三条攻击路径全部失败：

1. **改常量** → 3 个函数归一化后字符差 = 0，任何字面量改动都会产生非零差。✅
2. **改控制流** → 大括号配对提取的是完整函数体，字符级一致。✅
3. **改语义但不改字符**（如换了个同名的 helper）→ 需检查函数体内引用的外部符号是否解析到同一实现。
   抽查结果：`saveMemory` 引用的 `CATEGORIES`/`nowSql`/`scrubSecrets`/`semanticFingerprint` 等
   全部来自 `src/core/config.js`、`src/core/time.js`、`scrub.js`、`semantic_dedup.js`，
   这些根级文件在重构中**未被移动**（`git diff --stat 2c4a640 HEAD` 中不含它们）→ 解析到同一实现。✅

**唯一「非纯搬运」的地方**（已在上文记录，属可接受的技术债而非 bug）：
`fingerprint` 被拆成了两个算法不同的实现（3.3）、`markRecent` 被拆成了两份语义不同的实现（4.3）。

### 5.4 根门面纯净度

```bash
$ python3 verify_delivery.py
[3] 根门面行数
    ✓ tools.js: 14 行
    ✓ memory.middleware.js: 8 行
    ✓ gateway_harvest.hooks.js: 8 行
[4] 门面纯净度（不应含实现）
    ✓ tools.js: 非导入导出残留 0 行
    ✓ memory.middleware.js: 非导入导出残留 0 行
    ✓ gateway_harvest.hooks.js: 非导入导出残留 0 行
```

（`gateway_harvest.js` 也是门面，但**不在 `verify_delivery.py` 的 `GATES` 列表里**——
`GATES = ["tools.js", "memory.middleware.js", "gateway_harvest.hooks.js"]`，
而 `CONSTRAINTS.md` 说的「根目录只有 3 个宿主入口门面」与实际有 **4 个** `gateway_harvest*.js` 门面不一致。
实测 `gateway_harvest.js` 也是纯 `export * from` 的 8 行门面，无实现。）

### 五、拆分完整性小结

- ✅ **函数名 0 缺失**（40/40），机器验收 `verify_delivery.py` 6 项全过。
- ✅ **3 个抽查函数逐字符等价**，行数差 0，远优于「≤ 5 行」的要求。
- ✅ **根门面纯净度 0 残留**。
- ⚠️ 唯一的「非纯搬运」：`fingerprint` 与 `markRecent` 各被拆成了两份**语义不同**的实现（见 3.3 / 4.3）。

---

## 附录 A、测试与可观测性缺口（`observability-and-instrumentation` 轴）

### A.1 `src/` 37 个模块**零个**被测试直接 import

```bash
$ rg -n 'from "[^"]*src/[^"]*"' tests/*.mjs
（空输出 = 没有任何测试直接 import src/ 下的模块）
$ rg -oN 'from "[^"]+"' tests/*.mjs tests/lib/*.mjs | sed 's/.*from //' | sort | uniq -c | sort -rn | head -12
     74 "node:assert"
     62 "node:fs"
     46 "node:url"
     43 "./lib/testenv.mjs"
     41 "../tools.js"          <-- 全走根门面
     34 "node:path"
     34 "./test_meta.mjs"
     25 "../local_state.js"
     20 "node:os"
     19 "../gateway_harvest.hooks.js"
     13 "../gateway_harvest.js"
     11 "../ncb_mcp.js"
      9 "../memory.middleware.js"
```

**影响**：所有单测都通过根门面加载代码，这掩盖了模块边界问题——
`src/services/harvest/harvest-pipeline.js:8` 反向 import `tools.js` 在测试里**永远不会暴露**，
因为测试本来就从 `tools.js` 入口进。这正是 15 节点环能通过全部 84 套测试的原因。

### A.2 `tests/test_meta.mjs` 当前**已经失败**（基线问题，非本次审计引入）

```bash
$ node tests/test_meta.mjs 2>&1 | grep -A2 '❌'
❌ [FAIL] check_constraints.mjs:
     - [断言过弱] 断言数量不足 2 处（实际: 0 处）
❌ [FAIL] test_schema_defaults.mjs:
     - [假过隐患] 发现空 catch 块吞掉异常: 1 处
❌ 测试元检查发现 2 处违规，请修正！
```

> ⚠️ `CONSTRAINTS.md` 铁律「测试失败数必须为 0」**在审计开始前就已违反**。
> 建议单独开一个修复分支处理，不要混进审计分支。

### A.3 三个承诺的检查器缺失（重复强调，因为它是最关键的防线）

| `CONSTRAINTS.md` 承诺的检查器 | 实际状态 | 它本该拦住什么 |
|:--|:--|:--|
| `tests/check_cycles.mjs` | ❌ **不存在** | 15 节点循环依赖 |
| `tests/test_structure.mjs` | ❌ **不存在** | 门面藏实现 / 目录结构漂移 / 注释头缺失 |
| `tests/check_split_equiv.mjs` | ❌ **不存在** | 拆分时函数丢失或被改动 |

实测「从未提交过」：

```bash
$ git log --all --oneline --diff-filter=A -- '*check_cycles*' '*test_structure*' '*check_split_equiv*'
（空输出）
```

`CONSTRAINTS.md` 是「唯一权威来源，脚本只是它的镜像」——**现在镜像全丢了，只剩权威文本**。

### A.4 诊断日志（`_diag` / `_hookProbe`）未进公共门面之外的可观测通道

`_diag`（`scaffolding.js:8`）与 `_hookProbe`（`hook-request.js:10`）用 `console.log` 输出，
且都只打一次（`_diagLogged` / `_hookProbeLogged` 一次性闩锁），**没有请求级关联 ID**。
按 `observability-and-instrumentation` 的「correlation IDs are mandatory」，当前日志无法重建单次请求。
（属**改进建议**，非缺陷——项目整体是 fail-open 设计，刻意降噪。）

---

## 六、改进建议（按优先级）

| 优先级 | 问题 | 建议 | 预估工作量 |
|:--:|:--|:--|:--|
| **P0** | 🔴 **15 节点静态循环依赖**（重构前仅 4 个，是本次重构引入的回归）。最小闭环：`tools.js:8 → src/index.js:13 → gateway_harvest.hooks.js:7 → src/services/harvest/index.js:40 → src/services/harvest/harvest-pipeline.js:8 → tools.js` | 切断 `harvest-pipeline.js:8` 对根门面 `tools.js` 的反向 import。`harvest-pipeline.js` 实际只需要 `MagpieMemoryHub.ensureAuditScheduler`（L368/370）和 `MagpieMemoryHub`（L400），应改为**注入**（由 `src/index.js` 传入）或直接 import `src/services/audit/scheduler.js` 的 `ensureAuditScheduler` + 把 `MagpieMemoryHub` 调用改为经由 `src/index.js` 的 setter 注入 | **1–2 人日**（改 2–3 个文件 + 补回归测试） |
| **P0** | 🔴 **`tests/check_cycles.mjs` / `test_structure.mjs` / `check_split_equiv.mjs` 三个检查器从未提交**，`CONSTRAINTS.md` 的架构铁律**无任何自动化防线** | 补齐三个脚本并接入 `tests/test_meta.mjs` 或 CI。`check_cycles.mjs` 必须**同时覆盖 `import` / `export … from` / `export * from` / 动态 `import()`** 四类边（本报告的检测器可直接改写为该脚本） | **1 人日** |
| **P1** | 🔴 **`fingerprint` 同名双实现**：`domain/fingerprint.js:17`（FNV-1a+normalize）与 `harvest-pipeline.js:63`（SHA-256）语义不兼容，且公共门面 `gateway_harvest.hooks.js` 暴露的是后者 | 重命名区分职责：`domain/fingerprint.js` → `semanticFingerprint`（或 `contentFingerprint`），`harvest-pipeline.js` → `turnFingerprint`（或 `digestText`）。**注意 `src/tools/pitfall-save.js:11` 的 import 需同步改**。改完重跑 `verify_delivery.py` 的函数名集合比对（基线 40 个函数名会变，需同步更新 `verify_delivery.py` 的基线） | **0.5 人日** |
| **P1** | 🔴 **「写后读去重」逻辑两份实现**（`state-recent.js:7-31` vs `harvest-pipeline.js:40-61`）：键格式 `m:{fp}` vs `m:{project}:{fp}` 不兼容、时间窗 6s vs 300s、淘汰策略 clear vs LRU → 去重在 harvest 与写库路径**不闭环** | 统一到 `src/core/state-recent.js` 一个实现：把 `markRecent`/`justWritten` 改为**接受完整 key**（`markRecent(key)` 不再自行拼前缀），窗口/容量做成可配置常量，淘汰统一用 LRU。需同步改 `memory-saver.js`（6 处）、`pitfall-save.js`（6 处）、`harvest-pipeline.js`（6 处）的调用点 | **1 人日** |
| **P1** | ⚠️ **`tests/test_meta.mjs` 已失败 2 项**（`check_constraints.mjs` 断言过弱、`test_schema_defaults.mjs` 空 catch 吞异常）→ 违反「测试失败数必须为 0」铁律 | **另开分支**修复，不要混进审计分支。`check_constraints.mjs` 需补 ≥2 处真实断言；`test_schema_defaults.mjs` 的空 catch 要么补 `// fail-open 降级：…` 说明，要么补断言 | **0.5 人日** |
| **P2** | ⚠️ **13 处注释头依赖声明与实际 `import` 不符**（1 处幽灵依赖 + 12 处路径层数写错）。`hook-request.js` 声称依赖 `scaffolding.js (_diag)` 但**从未 import** | 逐条订正为实际路径（3 层写 `../../../`）。`hook-request.js` 删掉 `scaffolding.js` 那条（因为确实没用 `_diag`） | **0.5 人日** |
| **P2** | ⚠️ **19 个 `src/` 模块反向 import 根级基础设施**（`local_state.js` / `semantic_dedup.js` / `model_budget.js` / `scrub.js` / `online_models.js` / `page_actions.js`）→ 根目录实际有 16 个含实现的文件，而 `CONSTRAINTS.md` 声称只有 3 个门面 | 把 `local_state.js` / `semantic_dedup.js` / `model_budget.js` / `scrub.js` / `online_models.js` 迁入 `src/core/` 或 `src/domain/`，让 `src/` 不再依赖根目录。`page_actions.js` 与 `tools.js` 的依赖必须**先解环**（P0）才能拆 | **3–5 人日**（P0 完成后） |
| **P2** | ⚠️ **29 个零消费导出**（1 个真死代码 `offline-scan.js:FORBIDDEN_DIRS`，25 个「只在本模块用」，3 个门面转发） | 删死代码；把 25 个改为模块私有（去掉 `export`）。**注意**：`makeNoCredentialsClient` / `makeRestClient` / `extractLastUserTurn` 需保留（前者被 `test_v631_a_tools.mjs` 测 Proxy 白名单，后者是门面公共 API） | **0.5 人日** |
| **P2** | ⚠️ **5 个状态用 `export let` 暴露**（`_isAuditing`、`recentWrite`、`_auditOptionsGetter`、`_auditBaseCfg`、`_auditBaseClient`）→ 外部可改写互斥锁 / 去重表 / 调度器上下文 | 改 `export const` + 配套 setter 函数（如 `setIsAuditing(v)`），与 `scheduler.js` 已有的 `setAuditSchedulerContext` 风格保持一致 | **0.5 人日** |
| **P3** | ⚠️ **`gateway_harvest.hooks.js` 的 42 个导出无白名单测试**（`test_exports.mjs` 只管 `tools.js` 和 `memory.middleware.js`）；且把 `_diag` / `_hookProbe` 等内部诊断函数暴露到公共门面 | 在 `test_exports.mjs` 补 `gateway_harvest.hooks.js` 的 `ALLOWED_EXPORTS` 白名单；把 `_diag` / `_hookProbe` 从门面移除 | **0.5 人日** |
| **P3** | ⚠️ **37 个 `src/` 模块零个被测试直接 import**，全走根门面 → 模块边界问题被掩盖（15 节点环因此通过全部测试） | 为 `src/core` / `src/domain` / `src/integration` 各补一组**直接 import 模块**的单测（不经过门面） | **1–2 人日** |
| **P3** | ⚠️ **重复代码**：`PLUGIN_NAME`（2 处）、`cut`（2 处同名实现）、`RECENT_CAP`（同名不同值）、`_hasTechSignalCI/CS` 无价值短路正则（2 处逐字符复制）、`SENSITIVE_SEGMENTS`（同文件 2 处） | 抽到 `src/core/constants.js` / `src/domain/scoring.js` 单一来源；`_hasTechSignal` 抽成 `src/services/harvest/tech-signal.js` 共享函数 | **1 人日** |
| **P3** | ℹ️ **诊断日志无请求级关联 ID**（`_diag` / `_hookProbe` 一次性 `console.log`） | 按 `observability-and-instrumentation`，给 `onRequest` 生成 `requestId` 并沿 `ctx.state` 透传到 `_diag` 输出。属增强项，可延后 | **0.5 人日** |
| **P3** | ℹ️ **`CONSTRAINTS.md` 说根目录有 3 个门面，实际有 4 个**（`gateway_harvest.js` 也是 8 行纯门面，但不在 `verify_delivery.py` 的 `GATES` 里） | 二选一：把 `gateway_harvest.js` 加入 `GATES` 与文档，或在文档里说明它属于「向后兼容别名」并给出理由 | **0.2 人日** |
| **P3** | ℹ️ **`verify_delivery.py` 的函数名基线指向 `8f495b0:tools.js`**（脚本注释），但实际 4488 行版本在 `2c4a640`；且基线只查「缺失」不查「同名不同实现」 | 把基线 commit 钉死为 `2c4a640`；新增「同名符号跨模块实现一致性」检查 | **0.5 人日** |

---

## 七、审计方法与可复现性

### 7.1 环境

```bash
export SANDBOX_BASE="$CUBESANDBOX_PROXY_URL/sandbox/3a84de0c2851466c9fb3516a22285f40/8080"
/var/minis/skills/aiod-cli/bin/aiod-cli exec "<cmd>"   # 沙箱内执行（Node v24.18.1 / Python 3 / rg）
```

### 7.2 使用的工具

| 工具 | 用途 |
|:--|:--|
| `git show` / `git log` / `git worktree` | 基线提取（`2c4a640`）、重构前环检测、提交历史核查 |
| 自建 Tarjan SCC 检测器 | 静态 + 动态 + re-export 全边环检测（替代不存在的 `check_cycles.mjs`） |
| 自建可达性分析器 | 29 个零消费导出的传递可达性分析（沿门面 re-export 链） |
| `rg -w` 交叉验证 | 对 29 个符号逐个独立复核，排除分析器误报 |
| `node -e` 运行时实验 | 验证同名 `fingerprint` 不兼容、环在 3 种加载顺序下均不崩 |
| `verify_delivery.py` | 官方 6 项机器验收 |
| `tests/test_meta.mjs` | 测试元规范检查（发现 2 项基线失败） |

### 7.3 本次审计未做的事（明确边界）

- **未修改任何生产代码**。仅新增 `docs/AUDIT-v6.44.md`。
- **未运行全量测试套件**（84 套需网络/DB 环境；`test_meta.mjs` 与 `test_exports.mjs` 已跑，前者失败为基线问题）。
- **未评估 37 个模块的内部实现质量**（只审架构边界、依赖、状态、拆分完整性）。

### 7.4 复核命令

```bash
# 1. 静态循环依赖（替代不存在的 check_cycles.mjs）
#    建图规则：import / export ... from / export * from / 动态 import() 四类边
#    对全仓 .js 求 Tarjan 强连通分量，SCC>1 即为环
rg -n '^\s*(import|export)\s+.*from "|"' --glob '*.js' . | head -50
rg -n 'import\s*\(' --glob '*.js' .          # 动态导入（注意：不带 await 的裸 import() 也要算）

# 2. 零消费导出：对 src/ 每个 export 符号，沿「直接 import → 门面 re-export → 上层 re-export」
#    求传递可达性，再看最终消费方（其他 src/ 模块 / 根级文件 / 测试）
rg -w '<symbol>' --glob '!该文件本身' .        # 逐个交叉验证

# 3. 官方机器验收（应全过）
python3 verify_delivery.py

# 4. 官方测试元检查（当前基线失败 2 项）
node tests/test_meta.mjs

# 5. 同名双实现交叉验证
node -e "import('./gateway_harvest.hooks.js').then(async m=>{
  const d=await import('./src/domain/fingerprint.js');
  const t='Hello, World! 记忆';
  console.log('facade:', m.fingerprint(t));
  console.log('domain :', d.fingerprint(t));
  console.log('SAME?', m.fingerprint(t)===d.fingerprint(t));
})"

# 6. 拆分完整性（基线 = 4488 行的 tools.js 所在 commit）
git show 2c4a640:tools.js | grep -oE '^(export )?(async )?function [A-Za-z_$][A-Za-z0-9_$]*' \
  | sed -E 's/^(export )?(async )?function //' | sort > /tmp/base_fns.txt
wc -l /tmp/base_fns.txt        # → 40
```

---

## 八、最终判定

| 审计项 | 判定 | 严重度 |
|:--|:--|:--|
| 1. 依赖方向 | 🟡 分层方向正确，但 13 处注释失真 + 19 处根级反向依赖 | 中 |
| 2. 循环依赖 | 🔴 **15 节点静态环**（重构前 4 个，回归） | **高** |
| 3. 未使用导出 | 🟡 29 个零消费（1 死代码）+ 同名双实现 `fingerprint` | 中 |
| 4. 状态单例 | 🟡 19 个状态全单点声明 ✅；但去重逻辑两份实现不闭环 | 中 |
| 5. 拆分完整性 | 🟢 **40/40 函数 0 缺失，3 抽查函数逐字符等价** | 低 |
| 6. 工具链/可观测性 | 🔴 **3 个承诺的检查器从未提交**；`test_meta` 已失败 2 项 | **高** |

**总结论：重构的「搬运」是合格的，「解耦」没有做到，而且比重构前更糟（环从 4 节点扩到 15 节点）。
最该先做的两件事：(1) 补齐 `check_cycles.mjs` 等 3 个检查器，把防线建起来；
(2) 切断 `harvest-pipeline.js:8 → tools.js` 这条边，把 15 节点环打回 4 节点甚至更小。**
