# 失效密钥缓存不自动清除真缺陷排查与修复方案

## 一、真实问题与用户报错复盘

### 用户真实报错原文
```text
Secret Key 无效（被 NCB 拒绝），无法清理探针
目标数据库：41694_agent_memory
Secret Key 鉴权失败（403/401），两个最常见原因：
  ① 误把 MCP Key 当成 Secret Key
  ② 数据库重建后换了新密钥，当前手里是旧的
无法获取桶内文件列表，清理中止
```

### 用户所处场景
- 用户已更新插件，已在 NoCodeBackend (NCB) 控制台或外部重建了数据库 `41694_agent_memory`。
- 重建后，NCB 服务端生成了全新的 Secret Key，原 Secret Key 作废。
- 用户在插件中执行「清理探针文件」（`clean_probes`）或调用 `storage_list` / `secret_check` 时，始终陷入 403 鉴权失败死循环。

---

## 二、根因深度剖析（为什么一直 403 且死循环）

1. **NCB 密钥返回机制与平台边界**：
   - 数据库 Secret Key 专属每个数据库实例，用于访问 NCB REST API（`/files`、`/upload` 等）。
   - NCB 平台设计决定了：**Secret Key 仅在建库时返回一次**，NCB MCP 协议（23 个工具）中没有任何接口可以反查或读取 Secret Key。
2. **插件本地持久化缓存（`local_state.js`）**：
   - 插件通过 `rememberSecret(database, secret)` 将首次建库时捕获的密钥写入本地配置文件持久保存。
   - `lookupSecret(database)` 采用三级匹配机制（① 精确匹配；② 归一化去账号前缀匹配；③ 唯一记录兜底）。
3. **控制台重建导致状态割裂**：
   - 当用户在 **NCB 控制台或外部** 重建数据库时，未经过插件的 `db_provision` 流程，插件**无法捕获到新密钥**。
   - 本地缓存中仍完好无损地记录着**旧库的失效 Secret Key**。
4. **回退兜底优先级（`manual || captured`）命中陷阱**：
   - 在 `secretCheck`、`cleanProbes`、`tools.js` 等所有涉及 Secret 的入口中，取值逻辑均为：
     `secretToUse = manual || captured || ""`
   - 当用户设置页未显式手动填写 Secret Key 时，系统永远自动提取到本地缓存的旧密钥。
5. **缺少失效清理机制（根本缺陷）**：
   - 当远端 REST 接口明确返回 HTTP 403 / 401（或 `Invalid secret_key.`）时，现行代码仅抛出或返回文字错误提示，**从未调用任何清除缓存的逻辑**。
   - 本地甚至没有定义对称的 `forgetSecret(database)` 函数。
   - 结果：**只要用户没手填新密钥，本地缓存就永远是旧密钥，任何操作都持续拿旧密钥去撞 403，永无休止**。

---

## 三、修复方案设计

### 1. 核心状态层：`local_state.js` 新增 `forgetSecret(database)`
- **对称设计**：与 `rememberSecret`、`lookupSecret`、`forgetR2Mount` 保持严格对称。
- **三级清除逻辑**：
  - 精确匹配：删除 `st.secrets[database]`。
  - 归一化匹配：忽略账号前缀（如 `41694_agent_memory` 与 `agent_memory`）并删除匹配项。
  - 兜底清除：若未传参或库内仅有一条记录且匹配，则清除唯一记录。
- **持久化写盘**：调用 `writeState(st)` 落盘。

### 2. 全入口覆盖：5 个使用 Secret Key 的位置全部接入失效清除

| 入口位置 | 文件与函数 | 触发条件 | 处理动作 |
|---|---|---|---|
| **① 密钥检测** | `db_tools.js` -> `secretCheck` | HTTP 401/403 或 `Invalid secret_key` | 调用 `forgetSecret(db \|\| rawDb)`，source 标为 `自动捕获（已失效，已自动清除）`，提示用户手动填入新密钥 |
| **② 探针清理** | `r2.js` -> `cleanProbes` | `listRes` 报 401/403 / `AUTH_FAILED` | 调用 `forgetSecret(db \|\| rawDb)`，在文案中明确提示：「已自动清除本地缓存的失效密钥，请到 NCB 控制台复制当前 Secret Key 填入设置页」 |
| **③ 对象列举** | `r2.js` -> `r2List` (`storage_list`) | HTTP 403 / `invalid secret` | 调用 `forgetSecret(db \|\| rawDb)`，hint 中明确增加「已自动清除本地失效密钥缓存」说明 |
| **④ 对象删除** | `r2.js` -> `r2Delete` (`storage_delete`) | HTTP 403 / `invalid secret` | 调用 `forgetSecret(db \|\| rawDb)`，hint 中明确增加「已自动清除本地失效密钥缓存」说明 |
| **⑤ 对象上传 REST** | `r2.js` -> `r2Upload` (`storage_upload`) | REST POST 报 401/403 / `invalid secret` | 调用 `forgetSecret(db)`，清除失效缓存并平滑降级走 MCP 通道 |

### 3. 重建库后获取新密钥的可执行人话指南

用户在数据库重建后面临找不到密钥的问题，提供两条明确路径：

#### 路径 A：前往 NoCodeBackend 控制台获取/重置
1. 打开浏览器登录 [NoCodeBackend 控制台](https://nocodebackend.com/)。
2. 在左侧或主页进入目标数据库（如 `41694_agent_memory`）。
3. 查找 **Database Settings** 或 **API Keys** 区域：
   - 若能看到 **Secret Key**，点击「复制」；
   - 若平台默认仅创建时显示一次且控制台不可查：查看是否有 **Reset Secret Key**（重置密钥）按钮。点击重置后复制最新生成的密钥（注：重置只会更新鉴权密钥，不会影响库内数据）。
4. 返回插件设置页卡片 1，在 **数据库 Secret Key** 一栏粘贴该密钥，点击「保存」。

#### 路径 B：通过插件「一键创建」重新生成（推荐纯插件方案）
1. 若旧库内本无数据，或无需保留旧数据：
2. 在插件设置页点击「一键创建数据库」：
   - 填写新实例名（或开启 `auto_rename`，如 `agent_memory_v2`）。
3. 点击一键创建后，插件会自动通过 MCP `create_database` 创建新库，并**自动捕获并持久化全新 Secret Key**，同时自动建表建索引。
4. **注意**：新库为空库，旧库中的数据不会自动迁移。

### 4. 设置页密钥状态提示优化
- 在 `secretCheck` 结果与设置页状态中，清晰标明：
  - `当前用的是：手动填写`
  - `当前用的是：自动捕获（正常）`
  - `当前用的是：自动捕获（已失效，已自动清除缓存）`
- 并在失败时置顶高亮提示：「本地缓存已清除，请前往 NoCodeBackend 控制台复制当前 Secret Key 手动填入设置页」。
