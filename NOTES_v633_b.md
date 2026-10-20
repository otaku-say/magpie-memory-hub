# v6.33 Agent B 豁免与路径绕过修复规划

## 1. 任务背景与文件所有权
- **沙箱 ID**：`002823e6db47441ab8317a6db82cb85e`
- **代码目录**：`/workspace/m`
- **工作分支**：`feat/v633-b-guard`
- **文件所有权约束（严格独占）**：
  - `model_budget.js`
  - `gateway_harvest.js`
  - `local_state.js`
  - `tests/test_v633_b_guard.mjs`
  - `NOTES_v633_b.md`
- **严禁修改**：`tools.js` / `semantic_dedup.js` / `package.json` / `settings.*` / `test_meta.mjs` / `DEVNOTES.md` / 其他 tests。

---

## 2. 整改项清单与技术方案

### 2.1 【P0-2 最紧急】Gemini/Responses 内部请求豁免失效，自激风险重现（model_budget.js 约 193-214）
- **根因**：裁剪 `JSON.stringify` 后只检查 `body.contents` 和 `body.input` 的末尾元素，遗漏了 `body.systemInstruction`、`body.instructions`、`body.contents[0]`、`body.input[0]` 等可能承载 System Prompt 的关键位置。导致沙箱实测三类内部模型调用在未透传请求头时全部返回 `false`，自激放大风险重现。
- **修复方案**：
  1. 优先校验内部请求头 `x-magpie-internal` 与 `x-memhub-internal`（保持已有高速路径）；
  2. 请求体指纹改为检查「所有可能承载 system prompt 的位置」：
     - `body.system`
     - `body.systemInstruction`
     - `body.instructions`
     - `body.contents[0]` 及 `body.contents` 末尾元素
     - `body.input[0]` 及 `body.input` 末尾元素（支持 string 及 array）
     - `body.messages[0]`（system）及 `body.messages` 末尾元素（user）
  3. 每个候选位置只提取前 2000 字符，绝不全量序列化长上下文；
  4. 任一位置命中 `INTERNAL_PROMPT_MARKERS` 即刻返回 `true`。
- **反证验证**：分别构造 Gemini（contents + systemInstruction）与 Responses（input + instructions）内部调用，断言返回 `true`；普通用户请求断言返回 `false`。

---

### 2.2 【P0-3】目标子目录不存在时祖先软链接绕过（gateway_harvest.js 约 270-295）
- **根因**：向上回溯祖先 `parentReal` 时只校验了 `HARD_FORBIDDEN_PREFIXES`（未包含 `/var`、`/root`、`/home`），且未把 `realPath` 更新为解析后的真实祖先重构路径。导致父级软链接指向 `/var/log` 或 `/root` 且子目录尚不存在时，通过父级软链接直接绕过校验。
- **修复方案**：
  1. 向上回溯存在的父级祖先目录时，对解析出的 `parentReal` 执行完整防护校验（`checkPathForbidden`，涵盖 `HARD_FORBIDDEN_PREFIXES` + 敏感子路径黑名单 + 状态目录 + 白名单逻辑）；
  2. 一旦解析出 `parentReal`，立即基于相对路径计算并更新 `realPath`，对重构后的 `realPath` 同步执行完整防护校验；
  3. 继续向上校验祖先链，任一层命中黑名单即抛出 `[SECURITY_BLOCKED]`；
  4. 保留合法的白名单放行（如 `~/GatewayConversations`、`/var/minis`、`/var/folders` 及环境变量指定目录）。
- **反证验证**：
  - `/tmp/link_to_var_log/nonexistent_child` 必须坚决拦截；
  - `/tmp/link_to_root/.ssh/nonexistent` 必须坚决拦截；
  - `/tmp/normal_dir/nonexistent_child` 必须正常放行。

---

### 2.3 【P1-4】statePath() process.argv 测试检测正则过宽，生产状态被误重定向到 /tmp（local_state.js 约 35-40）
- **根因**：原正则 `/(^|[\/])test|\btests?\b/i` 过于宽泛，会匹配任何包含 `/test` 的部署路径（如 `/var/minis/test-env`、`/home/user/test-project`），误将生产环境的 `state.json` 重定向到系统易失目录 `/tmp`。
- **修复方案**：
  1. 只认明确的环境变量测试信号：`MAGPIE_TEST === "1"`、`NODE_ENV === "test"`、`MEMHUB_TEST === "1"`；
  2. 针对 `process.argv`，严格采用 `path` 解析判定：
     - 必须以 `.mjs` 结尾；
     - 所在父目录名称必须精确等于 `"tests"`（`path.basename(path.dirname(path.resolve(arg))) === "tests"`）；
     - 彻底杜绝任意包含 `test` 子串的误匹配。
- **反证验证**：
  - 当 `argv` 包含 `/var/minis/test-env/run.mjs` 且不含测试环境变量时，`statePath()` 必须稳定指向宿主 `~/.magpie-memory-hub/state.json`；
  - 当 `argv` 为 `tests/test_v633_b_guard.mjs` 时，`statePath()` 必须指向独立的 `tmpdir` 隔离目录。

---

## 3. 测试与验证策略
- **新建测试**：`tests/test_v633_b_guard.mjs`，包含三大反证门与 `test_meta` 规范自检；
- **全套回归**：
  - `node tests/test_gateway_harvest.mjs`
  - `node tests/test_gateway_harvest_hooks.mjs`
  - `node tests/test_call_storm_fix.mjs`
  - `node tests/test_state_bloat_and_dead_letter.mjs`
  - `node tests/test_lookup_secret.mjs`
  - `node tests/test_v632_b_security.mjs`
  - `node tests/test_v632_c_state.mjs`
  - `node tests/test_v633_b_guard.mjs`
