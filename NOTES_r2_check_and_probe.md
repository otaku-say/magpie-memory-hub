# R2 检测顺序解耦与探针防堆积治理检查点报告 (v6.25.0 · NOTES_r2_check_and_probe.md)

**发布版本**：`v6.25.0`（`package.json` 与 `settings.html` 严格同步对齐）  
**整改基准 Commit**：`1edc66e` (v6.24.0)  
**主要整改范畴**：
1. **Bug ① 根治（解耦检测与挂载的倒置依赖）**：
   - 彻底移除 `r2Check` 中对 `isR2Mounted` 的死锁前置拦截，支持用户在未挂载状态下【独立检测】输入的 R2 凭据；
   - 传入凭据先行同步至 NoCodeBackend，紧随真实探针（上传 + 删除）进行硬端到端校验；
   - 检测成功后自动落地 `rememberR2Mount` 挂载记录，检测失败则 `forgetR2Mount` 清除失效状态；
   - 语义厘清：检测 = 凭据可用性校验，挂载 = 建立持久绑定，两者互不阻塞。
2. **Bug ② 根治（探针文件累积与删除失败治理）**：
   - **探针文件名核实**：代码中固化为 `_memhub_probe.txt`，但 NoCodeBackend 服务端 `upload_file` 会为对象自动追加动态时间戳/随机 ID 前缀（形如 `1792163443679-xxxx-_memhub_probe.txt`），导致未删除时在桶内呈现新文件名；
   - **全仓上传点盘点**：经全仓静态审计，系统内部只有两处上传路径：① `r2Probe`（仅由 `r2Setup` 和 `r2Check` 手动触发）；② `r2Upload`（用户/Agent 业务存储上传）。无任何启动探针、网关钩子或后台静默上传点；用户在更新插件/镜像后进入设置页点击检测/挂载，从而触发探测上传；
   - **删除失败修复**：在 `r2Probe` 中增加从响应 `url` 的 pathname 自动提取真实带前缀 key 的能力，防止因 NCB 未返回 `out.key` 导致有 Secret Key 时依然删错文件名；
   - **删除失败可见性强化（零静默）**：当缺少 Secret Key 或删除失败时，在结果数据、卡片 lines、以及前端 `r2_action_status` 中以显式提示框呈现「探针已留在 R2 存储桶中（删除需数据库 Secret Key）」并给出「填写 Secret Key 后点击『清理探针文件』一键清除」的详细自救指引；
   - **`cleanProbes` 解耦**：移除 `cleanProbes` 内部的 `isR2Mounted` 阻断，并在 `r2List`/`r2Delete` 中支持 `skip_mount_check` 与 `NO_SECRET` 优雅捕获，确保未挂载状态下也能通过 Secret Key 自由清理历史探针。
3. **反证测试用例**：
   - 新增 `tests/test_r2_check_and_probe.mjs`，包含四大实证与反证用例（确证改前老逻辑未挂载时必红报 NOT_MOUNTED）；
4. **测试套件与规范全量回归**：
   - `test_meta.mjs` 锁定 39 个测试文件规范合规；
   - `test_pollution_guard.mjs` 零污染验证通过（38 个测试执行后 `dm=0, dp=0`）。

---

## 一、Bug ①：「检测 R2 密钥」与「挂载 R2 存储」顺序治理

### 1. 现象与根因
- **用户反馈**：「检测 R2 密钥 必须要 挂载 R2 存储 以后才能检查，这是本末倒置的行为」。
- **代码现状**：历史版本在 `r2.js` 的 `r2Check` 开头强行插入了：
  ```javascript
  const mountCheck = isR2Mounted(cfg, db, a);
  if (!mountCheck.mounted) {
    return notMountedResponse(db);
  }
  ```
  未挂载直接返回「R2 尚未挂载，请先在 R2 卡片点击『挂载 R2 存储』，再来检测」。
- **逻辑缺陷**：用户配置新凭据时，本能先点「检测 R2 密钥」验证密钥是否可用，却被提示「必须先挂载」；而挂载本身建立持久绑定，又依赖凭据正确，形成逻辑死循环。

### 2. 修复实现
1. **解除拦截**：删除 `r2Check` 最前置的 `!mountCheck.mounted` 阻断分支；
2. **凭据预同步**：若调用传入了凭据（`a.account_id`, `a.access_key_id`, `a.secret_access_key`）或设置页保存了凭据，先通过 `mcp.setupR2Storage(db, extra)` 同步到 NCB 远端；
3. **真实探针验证**：调用 `r2Probe(cfg, db)` 进行真实上传与删除验证；
4. **检测成功联动挂载**：探针通过（`ok: true`）则顺带调用 `rememberR2Mount` 落盘持久化挂载记录，使后续操作无需重复配置；失败则调用 `forgetR2Mount` 清除失效记录；
5. **清晰语义**：
   - `r2Check`：只校验凭据真实可用性，无需预先挂载；
   - `storage_setup` (`r2Setup`)：显式建立持久绑定并执行验证；
   - 两者互不阻塞，逻辑顺畅闭环。

---

## 二、Bug ②：探针堆积与删除失败治理

### 1. 探针文件名核实
- `r2.js` 中上传探针文件的本地常量为 `name = "_memhub_probe.txt"`；
- 但由于 NoCodeBackend MCP 服务端在 `upload_file` 实现中为防止文件名冲突，会在服务端自动追加时间戳与随机哈希前缀（如 `1792163443679-xxxx-_memhub_probe.txt`）；
- 若探针未能成功删除，R2 存储桶中便会呈现多个不同前缀的探针对象。

### 2. 全仓上传点盘点（为什么「每次增加」）
经 `rg -n "upload|probe|_memhub"` 全仓扫描，所有上传点清单如下：
| 文件路径 | 函数/组件 | 触发场景 | 是否产生探针 |
| :--- | :--- | :--- | :--- |
| `r2.js` L193 | `r2Probe` | `r2Setup` (挂载) 与 `r2Check` (检测) | **是**（上传 `_memhub_probe.txt`） |
| `r2.js` L639 | `r2Upload` (REST) | `storage_upload` 工具或页面上传附件 | 否（业务文件） |
| `r2.js` L665 | `r2Upload` (MCP) | `storage_upload` REST 降级回退通道 | 否（业务文件） |

**排查结论**：
- 代码中**没有任何**随镜像启动、服务启动、网关钩子或中间件自动上传探针的隐藏逻辑；
- 用户反馈「每次更新插件或 magpie 镜像后增加探针」，系因更新后用户通常会进入插件设置页排查或重新点击「检测 R2 密钥」/「挂载 R2 存储」；
- 每次点击均会调用 `r2Probe` 生成一个新的动态前缀探针；若此时未填写数据库 Secret Key（普遍仅配置 MCP Key），探针即永久堆积在桶中。

### 3. 删除失败根因与修复
1. **动态 Key 提取漏洞修复**：
   - 过去仅尝试 `out.key`、`prefix + name` 和 `name`；当 NCB 仅返回 `out.url`（未返回 `key`）时，无法匹配到真实带时间戳的前缀 key，导致 REST DELETE 404；
   - 现增加从 `url` 的 `pathname` 中精准解析 `decodeURIComponent(u.pathname)`，确保无论 NCB 返回何种结构均能准确定位真实对象进行删除。
2. **删除失败强可见性与指引（零静默）**：
   - `r2Probe`：缺 Secret Key 时返回明确的 `cleanNote` 说明只有 MCP Key 无法删除，并给出清理办法；
   - `page_actions.js`：卡片明细行追加 `探针残留提示：...` 与 `清理方法：在设置页填写数据库 Secret Key 后，点击「清理探针文件」即可一键清除。`；
   - `settings.js`：在 `#r2_action_status` 中新增独立的提示框 `.secret-guide-tip.r2-probe-tip`，显式突出展示残留原因与一键清理按钮指引，彻底消除用户盲区。
3. **`cleanProbes` 解绑与加固**：
   - 核实：6.24.0 中已存在 `cleanProbes`、页面按钮 `#btn_clean_probe` 及信标分发；
   - 治理：移除 `cleanProbes` 内部的 `isR2Mounted` 校验，并在 `r2List`/`r2Delete` 中支持 `skip_mount_check: true` 与 `NO_SECRET` 结构化捕获，确保未挂载数据库只要提供 Secret Key 即可一键清理全部历史残留探针。

---

## 三、反证测试与自动化验证 (`tests/test_r2_check_and_probe.mjs`)

### 1. 测试用例矩阵
- **用例 1：未挂载时独立检测与反证**
  - **改前反证**：模拟改前 `isR2Mounted` 拦截，确证未挂载时必定被阻断（`ok=false`, `verdict="NOT_MOUNTED"`）；
  - **正向验证**：修复后未挂载状态下输入凭据顺利通过真实探针检测，输出 `VERIFIED`，并自动落地 `rememberR2Mount` 挂载记录。
- **用例 2：缺 Secret Key 时探针删除失败明确可见性与清理指引**
  - **断言**：`probe.cleaned === false`，`clean_note` 与 `r2Check.lines` 中 100% 出现残留原因与 `清理探针文件` 清晰指引，零静默。
- **用例 3：URL pathname 提取真实对象 key 确保删除匹配**
  - **断言**：NCB 仅返回带随机前缀的 `out.url` 时，成功解析真实 key 并顺利完成 REST 删除（`probe.cleaned === true`）。
- **用例 4：未挂载时「清理探针文件」独立运行**
  - **断言**：未挂载状态下，只要提供 Secret Key，`cleanProbes` 顺利扫描并精准删除全部包含 `_memhub_probe` 的探针文件。

### 2. 执行结果输出
```text
=================================================================
【R2 独立检测与探针防堆积治理验收与反证测试】
=================================================================

--- 测试 1: 未挂载时「检测 R2 密钥」能独立运行 (Bug ①) ---
  ✓ [反证确认] 改前逻辑在未挂载时直接返回 NOT_MOUNTED，阻止独立检测
  ✓ [正向验证] 未挂载时检测 R2 凭据顺利独立执行并落地挂载记录！

--- 测试 2: 探针删除失败时明确提示用户残留与清理指引 (Bug ②) ---
  ✓ [正向验证] 探针删除失败时零静默，明确提示留在桶内并给出清理指引！

--- 测试 3: 从 URL pathname 提取真实对象 key 确保删除匹配 (Bug ②) ---
  ✓ [正向验证] 准确从 URL 解析带动态前缀的真实对象 key，成功执行 REST 删除！

--- 测试 4: 未挂载时「清理探针文件」亦能独立运行 ---
  ✓ [正向验证] cleanProbes 不受未挂载限制，成功扫描并清理 2 个残留探针！

=================================================================
🎉 R2 独立检测与探针防堆积治理所有测试全部通过！
=================================================================
```

---

## 四、全套回归与守卫验证
1. `tests/test_meta.mjs`：39 个测试文件隔离与规范元检查 100% 通过；
2. `tests/check_schema_sync.mjs`：字段定义与 `v6.25.0` 版本号严格对齐；
3. `tests/test_pollution_guard.mjs`：全套 38 个测试执行后生产库零污染断言通过（`dm=0, dp=0`）。
