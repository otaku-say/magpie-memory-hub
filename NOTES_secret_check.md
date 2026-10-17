# NOTES: 检测 Secret Key 体验优化与 R2 挂载状态一致性

## 1. 背景与问题定义

用户在 Magpie Memory Hub 设置页点击「检测 Secret Key」时，遇到以下体验问题：
1. **报了吓人的 TLS 错误，但密钥其实是有效的**：
   - 现存判定逻辑将 HTTP 500 / EPROTO / TLS 握手失败（如 Cloudflare R2 TLS alert 40）一律作为探测失败 (`ok: false`)，在设置页呈现为大红标 ✗ 失败。
   - 实际上，NoCodeBackend 在 REST 请求 (`GET /files?Instance=<db>`) 鉴权通过后，才去向下游 Cloudflare R2 发起连接。若 R2 通道未挂载或凭据失效，NCB 返回 500 + TLS 报错。
   - 用户误以为自己填写的 Secret Key 是错的，产生极大困惑。
2. **密钥真正无效时**：
   - NCB 返回 HTTP 403 `{"error":"Invalid secret_key."}`，这是真正的密钥鉴权失败，需继续判为 ✗ 失败。
3. **两个遗留隐患**：
   - 隐患 1：`r2Setup` 失败时不清除旧的挂载记录（`forgetR2Mount` 未被调用），导致旧挂载记录残留，`isR2Mounted` 仍误报 true。
   - 隐患 2：`r2Check` 成功时不落盘挂载记录，未点过「挂载」仅点「检测」的用户下次仍被判未挂载。

## 2. 核心目标

让「检测 Secret Key」只回答一个问题：**这个密钥本身对不对**。
- 若存在不碰 R2 的独立验证端点，优先采用该干净端点。
- 若不存在独立端点，保留 `/files` 探测，但将「鉴权已通过但下游 R2 失败」（500 / TLS 等）判定为密钥有效（`ok: true`, verdict: `VALID_BUT_R2_UNAVAILABLE` 或类似语义），并在提示中明确告知用户密钥本身通过鉴权，报错来自远端 R2 通道。

## 3. 探测计划

利用环境中的 MCP Key 和无效 Key，实测 NoCodeBackend REST API 端点：
- `/files?Instance=...`
- `/api/files?Instance=...`
- `/api/v1/...`
- `/databases`
- `/tables?Instance=...`
- `/rows?Instance=...`
- `/query?Instance=...`
- `/me`, `/account`, `/instances`, `/projects`
记录各端点对不同 Key 的响应码与行为，确定是否有不触碰 R2 的端点。


## 4. 第一步：NCB 真实 REST 接口能力探测结论（实测记录）

通过系统化探测脚本对 `api.nocodebackend.com` 和 `app.nocodebackend.com` 发起多组实测对比：
1. **测试用例**：
   - 凭据 A：有效 MCP Key（`$NOCODEBACKEND_API_KEY`）
   - 凭据 B：真实有效数据库 Secret Key（来自本地捕获）
   - 凭据 C：故意构造的非法密钥（`sec_invalid_key_test_...`）
   - 凭据 D：无 Authorization 请求头（空鉴权）
2. **端点实测响应结果**：
   - `GET /files?Instance=41694_agent_memory`：
     - MCP Key / 无效 Key：`HTTP 403 {"status":"failed","error":"Invalid secret_key."}`
     - 无 Header：`HTTP 401 {"status":"failed","error":"Unauthorized. Provide a valid session cookie."}`
     - 有效 Secret Key（未挂载 R2 库）：`HTTP 500 {"status":"failed","error":"Unauthorized"}` 或 `SSL alert 40`
     - 有效 Secret Key（已挂载 R2 库）：`HTTP 200 {"status":"success","files":[...]}`
   - `GET /read/memories?Instance=...&limit=1`：
     - MCP Key / 无效 Key：`HTTP 403 {"status":"failed","error":"Invalid secret_key."}`
     - 有效 Secret Key（已初始化表）：`HTTP 200 {"status":"success","data":[],...}`
     - 有效 Secret Key（未初始化表/空库）：`HTTP 500 {"status":"failed","error":"Table '...' doesn't exist"}`
   - `GET /databases`, `/instances`, `/projects`, `/tables`, `/schema`, `/query`, `/me`, `/account`, `/v1/*`, `/api/*`：
     - 所有凭据下均返回 `HTTP 404 HTML`（Express 默认 404 页面，端点根本不存在）
   - `GET /`, `/health`：
     - 所有请求（包括无鉴权）均返回 `HTTP 200`（公网健康检查，不校验任何密钥）
3. **探测明确结论**：
   - **不存在任何不依赖表结构、不触碰 R2 的独立 Secret Key 验证端点**（如 `/auth/verify`、`/ping` 等）。
   - `/read/<table_name>` 端点强烈依赖业务表预先存在，对于刚建库尚未初始化的场景会报 500 表不存在，无法作为通用的数据库密钥探测器。
   - `/files?Instance=<db>` 是 NCB 针对每个数据库实例暴露的标准存储根端点。其核心特性是：**NCB 内部先执行 Bearer Secret Key 鉴权；若鉴权失败直接 403 拦截并返回 Invalid secret_key，绝不向下游发起请求；只有在鉴权完全通过后，才向下游 Cloudflare R2 发起连接**。因此，若收到 HTTP 500 / TLS 握手失败 / Unauthorized，**100% 证明密钥本身鉴权已经通过**。

## 5. 第二步：判定改动与文案优化（db_tools.js）

保留 `/files` 作为统一探测端点，彻底重构判定与展示文案：
1. **密钥无效分支（保持 ✗ 失败）**：
   - 条件：`res.status === 403 || res.status === 401`
   - 判定：`ok: false, verdict: "INVALID"`
   - 标题：`密钥被 NoCodeBackend 拒绝（鉴权失败）`
2. **密钥有效但 R2 异常/未挂载分支（改为 ✓ 成功）**：
   - 条件：`res.status >= 500`（涵盖 TLS alert 40、InvalidBucketName、Unauthorized、upstream error）
   - 判定：`ok: true, verdict: "R2_TLS_ERROR" | "R2_BUCKET_INVALID" | "UPSTREAM_ERROR"`
   - 标题：`Secret Key 有效（已通过鉴权），但远端连 Cloudflare R2 发生 TLS 握手失败 / 存储通道异常`
   - 核心文案：**「【排查关键】密钥本身有效（鉴权已通过）。并非密钥无效。这个报错来自 NoCodeBackend 侧访问该库的 R2 存储通道失败，与你的密钥无关。若要让 R2 相关功能可用，请先挂载 R2 存储。」**
   - 效果：设置页呈现绿标 `✓ 成功`，彻底消除用户对密钥正确性的误解。

## 6. 隐患 1 与隐患 2 修复（r2.js）

1. **隐患 1：`r2Setup` 失败时不清除旧的挂载记录**：
   - 在 `r2.js` 引入 `forgetR2Mount`。
   - `r2Setup` 在 `probe.ok === false` 的失败分支显式调用 `forgetR2Mount(db)`，确保凭据失效或挂载失败时，`local_state.r2_mounts` 中的陈旧记录被彻底清除，避免后续调用误判为已挂载。
2. **隐患 2：`r2Check` 成功时不落盘挂载记录**：
   - `r2Check` 在真实探针成功分支（`probe.ok === true`）显式调用 `rememberR2Mount(db, ...)`，确保用户只点「检测 R2 密钥」成功时也能持久化落盘挂载记录。
