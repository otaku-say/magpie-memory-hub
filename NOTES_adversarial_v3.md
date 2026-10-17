# NOTES_adversarial_v3.md —— 发版前对抗测试与漏洞清扫记录

## 基准信息
- 测试目录：`/var/minis/workspace/magpie-memory-hub`
- 生产库初始计数：`memories=7`, `pitfalls=21`（41694_agent_memory）
- 上游 Magpie 依据 commit：`cb05dc2d1bc92aced1206c6271ca1d94f5690435`（origin/main）
- 测试策略：多轮主动对抗攻击，发现缺陷立即复现并修复，补强断言与反证，直至全量测试与元检查一整轮零发现。

---

## 第一轮对抗测试（发现 5 项真实缺陷并全部修复）

### 缺陷 1: `countTurnsFromMessages` 跨协议推导边界逻辑缺陷
- **现象**：当输入 Gemini 请求体且 `contents` 仅包含 `role: "system"` 或空对象 `{}` 时，或者在 Responses API 中传入空对象时，推导结果返回 1，而非预期中的 `null`。
- **复现**：
  ```javascript
  countTurnsFromMessages({ contents: [{ role: "system", parts: [{ text: "sys" }] }] }) // 产出 1，期望 null
  countTurnsFromMessages({ contents: [null, undefined, {}] }) // 产出 1，期望 null
  countTurnsFromMessages({ input: [null, undefined, {}] }) // 产出 1，期望 null
  ```
- **根因**：
  原代码在过滤 Gemini 时仅判定 `c.role !== "model"`，导致无 role 的空对象与 system 角色均被算作 user 轮次；且未校验 `parts` 是否具有真实有效文本。Responses API 类似。
- **修法**：
  重构 `countTurnsFromMessages`：Gemini 严格校验 `c.parts` 且排除 `model` 与 `system`；Responses API 严格校验 user 角色或非空字符串/数组内容；OpenAI/Anthropic 校验 `role === "user"` 与非空 content。

### 缺陷 2: `deriveLegalBucketName` 纯下划线/中文/特殊符号返回空串非法桶名
- **现象**：当传入纯下划线（如 `"___"`）、纯点号（`"..."`）、纯连字符（`"---"`）或中文库名时，函数产出空字符串 `""`，导致调用 R2 创建/配置接口时提交非法空桶名。
- **复现**：
  ```javascript
  deriveLegalBucketName("___") // 产出 ""，无法满足 S3/R2 正则 /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
  deriveLegalBucketName("我的知识库") // 产出 ""
  ```
- **根因**：
  在正则过滤和首尾清理后未处理 `s.length === 0` 的情况，直接跳过了 `< 3` 的补齐逻辑，导致产出空串；且原实现允许点号 `.`，不符合 Cloudflare R2 命名规范（R2 仅支持小写字母、数字与连字符）。
- **修法**：
  非法字符与点号一律转换为 `-`；合并连续连字符并剥离首尾连字符；当有效字符完全为空时，安全回退为合规默认桶名 `"memhub-r2-bkt"`；1-2 字符补齐为 `-bkt`。

### 缺陷 3: `check_schema_sync.mjs` 门禁盲区漏扫 `gateway_harvest.hooks.js`
- **现象**：架构元检查器 `check_schema_sync.mjs` 仅检查了 `tools.js` 的 `createdKeys`，且 `CODE_FILES` 遗漏了核心异步钩子文件 `gateway_harvest.hooks.js`。
- **根因**：文件清单未包含新增的 hooks 异步采集入口，若 hooks 中写入未声明字段或引入历史改名前列名，门禁会完全放行。
- **修法**：
  将 `gateway_harvest.hooks.js` 纳入 `CODE_FILES`；`createdKeys` 统一合并 `tools.js` 与 `gateway_harvest.hooks.js` 的所有 `client.create` 字段并与 `schema.js` 对齐。

### 缺陷 4: `test_traceability.mjs` 规范合规违规导致 `test_meta.mjs` 失败
- **现象**：`node tests/test_meta.mjs` 拦截报错，检测出 `test_traceability.mjs` 存在 4 处测试规范违规。
- **根因**：本地未采用 `mockDbClient` 绑定 `memoryStore`，未声明 `cleanup()` 与残余数为 0 的断言，且缺少显式非 0 退出逻辑。
- **修法**：
  按照标准测试规范重构 `test_traceability.mjs`：统一采用受控内存存储桩、每个测试独立命名空间隔离、执行 `cleanup()` 并在末尾断言 `residue.total === 0`，补充跨协议反证用例。

### 缺陷 5: `harvest.py` 中 `is_explicit_user_memory` 正则遗漏「避坑」关键字
- **现象**：`gateway_harvest.js` 已恢复独立关键字「避坑」，但 `harvest.py` 遗留了历史回归，未包含 `避坑`，导致 Python 离线提炼管线对「避坑：xxx」无法识别为显式意图。
- **复现**：
  ```python
  from harvest import is_explicit_user_memory
  is_explicit_user_memory("用户提问：\n避坑：不要直接在主分支强制推送\n助手回复：好的。") # 返回 False
  ```
- **根因**：双语言实现分叉，JS 修复时未同步更新 Python。
- **修法**：在 `harvest.py` 的 `is_explicit_user_memory` 正则中补齐 `避坑`。并在 `save_memory`、`save_pitfall` 中增加 `source_session` 至多 128 字符截断防御。

---

## 第二轮对抗测试（零缺陷，全量收敛）

- 全量测试套件执行：**31/31 测试文件 100% 绿色通过**。
- `node tests/test_meta.mjs`：**全绿通过**。
- `node tests/test_pollution_guard.mjs`：**全量 30 测试安全执行完毕，真实生产库行数严格为 dm=0, dp=0**。
- 最终生产库复查：`memories: 7`, `pitfalls: 21`（零污染）。
- 本轮发现缺陷：**0 项**。达成收敛！
