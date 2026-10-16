# magpie-memory-hub

Magpie 的**透明记忆网关**。把流经 Magpie 的对话沉淀为长期记忆，在后续提问时自动注入相关经验，并通过 MCP 向所有 agent 提供记忆工具。

## 两种运行模式

| | 零外部模型（推荐） | 外部提炼模型 |
|---|---|---|
| 事实提炼 | **内联抽取**：让正在跑的那个模型自己在回复末尾产出 `<memory>` 块 | 额外调一次提炼模型 |
| 仲裁 | **规则**（置信度 + 信息量 + 相似度） | clef 模型 |
| 额外调用 | **0** | 每轮 1~2 次 |
| 额外成本 | **0** | 按模型计费 |
| 配置 | `inline_extract` 开 + `extractor_model` 留空 + `clef_mode=rule` | 填模型 ID |

零外部模型模式的机制来自 [Headroom](https://github.com/headroomlabs-ai/headroom)：**提炼不需要另起一个模型，让本来就要跑的那个顺势完成**。中间件在请求里注入一条提炼指令，回复末尾的 `<memory>` 块被解析入库、并从用户可见输出里剥掉。

## 架构

```
                    ┌──────────────── Mgpie 网关（Go 进程）────────────────┐
   Agent ──请求──▶  │ moejs 中间件（memory.middleware.js）                │
                    │   ① 压缩历史工具输出（compress.js，纯 JS 规则）      │
                    │   ② 按关键词+热度+新鲜度检索记忆，注入 system prompt │
                    │   ③ 注入内联提炼指令 / 剥离回复里的 <memory> 块      │
                    └───────────────────────┬───────────────────────────┘
                                            │ [MEMORY_HARVEST] 日志
                                            ▼
                    ┌────────── 离线管线（harvest.py，独立进程）──────────┐
                    │ ① 失败→成功相关性挖掘（正则，零模型）               │
                    │ ② 语义压缩（Kompress ONNX，可选）                  │
                    │ ③ 提炼（可选，含 clef 仲裁）                       │
                    │ ④ 写入 NoCodeBackend                              │
                    │ ⑤ magpie plugin options 推快照（带版本号）          │
                    └───────────────────────┬───────────────────────────┘
                                            │ 快照 ≤1s 生效
                                            ▼
                                    回到网关中间件，闭环

   Agent ◄──MCP── /mcp/magpie/tools （Magpie 内置，聚合本插件 9 个工具）
```

**为什么中间件不能直连数据库**：moejs 是 Go 内嵌的 JS 引擎，无网络、无线程、无原生模块，`onRequest` 限额 250ms。它只读一个由离线管线推进 `plugins.json` 的记忆快照。这也决定了检索必须在内存数组上完成。

## 安装

```bash
magpie plugin add github:otaku-say/magpie-memory-hub
```

在 **设置 → 插件** 里开启内置的 **Plugin tools**，然后在 **插件页「记忆中枢」** 里填数据库信息。

**把 MCP 接给 agent**：在 **资源库 → MCP 服务器** 添加

```
https://<你的网关>/mcp/magpie/tools
```

Magpie 会自动写进各 agent 的配置，无需手工改文件。工具名形如 `magpie-memory-hub_memory_search`。

## 数据库

用 [NoCodeBackend](https://nocodebackend.com) 建一个库，两张表：

```sql
CREATE TABLE memories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project VARCHAR(128) DEFAULT 'global',
  category VARCHAR(64) DEFAULT 'fact',
  title VARCHAR(512) NOT NULL,
  content TEXT NOT NULL,
  tags VARCHAR(512) DEFAULT '',
  entities VARCHAR(512) DEFAULT '',
  related VARCHAR(512) DEFAULT '',
  source VARCHAR(64) DEFAULT '',
  fingerprint VARCHAR(64) NOT NULL,
  confidence_score INT DEFAULT 100,
  status VARCHAR(16) DEFAULT 'active',
  superseded_by INT DEFAULT 0,
  version INT DEFAULT 1,
  hits INT DEFAULT 0,
  access_count INT DEFAULT 1,
  invalid_at DATETIME NULL,
  last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE pitfalls (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project VARCHAR(128) DEFAULT 'global',
  component VARCHAR(128) NOT NULL,
  symptom TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  solution TEXT NOT NULL,
  severity VARCHAR(16) DEFAULT 'medium',
  error_type VARCHAR(64) DEFAULT '',
  tags VARCHAR(512) DEFAULT '',
  fingerprint VARCHAR(64) NOT NULL,
  recurrence INT DEFAULT 1,
  invalid_at DATETIME NULL,
  last_occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ⚠️ 必须建：这是去重的最终保证
CREATE UNIQUE INDEX idx_memories_uniq_fp ON memories(project, fingerprint);
CREATE UNIQUE INDEX idx_pitfalls_uniq_fp ON pitfalls(project, fingerprint);
```

> **为什么唯一索引是必须的**：NoCodeBackend 的读接口有约 2 秒的写后可见延迟，只靠「先读后写」判重，会漏掉紧邻或并发的重复写入（实测出现过指纹相同却都 active 的两行）。插件在收到 `Duplicate entry` 时会按 NOOP 处理。

## MCP 工具（9 个）

| 工具 | 说明 |
|------|------|
| `memory_save` | 写入记忆。指纹相同→NOOP；同标题内容更新→新版本并 supersede 旧版 |
| `memory_search` | 关键词检索（标题5/标签3/正文1），按置信度·热度·新鲜度排序 |
| `memory_list` | 列出活跃记忆 |
| `memory_context` | 生成可直接注入的记忆上下文块（受条数与字符预算约束） |
| `memory_extract` | 用配置的提炼模型 + clef 仲裁提炼一段对话（**可选**，零外部模型模式下不需要） |
| `memory_get` | 按 id 取出完整内容（配合摘要卡使用） |
| `memory_forget` | 软失效（写 `invalid_at`，保留审计链） |
| `pitfall_save` | 记录工程踩坑，相同指纹复发计数 +1 |
| `pitfall_search` | 检索踩坑 |

## 离线管线

```bash
# 跟随网关日志（常驻）
python3 harvest.py --log ~/.magpie/magpie.log

# 一次性处理（配计划任务）
python3 harvest.py --file harvest.jsonl --push-once

# 只看会提炼出什么，不写库
python3 harvest.py --file harvest.jsonl --dry-run
```

配置优先级：**命令行 > 环境变量 > 配置文件 > 插件 options**。用真实 magpie 时它会自动读插件配置，所以**设置页填一次即可**。

可选依赖（没有则自动降级，不影响运行）：

```bash
# Alpine
apk add py3-onnxruntime py3-numpy
pip install tokenizers huggingface_hub
# Debian/Ubuntu
pip install onnxruntime tokenizers huggingface_hub numpy
```

装了之后可用 `--compress-engine kompress` 在提炼前做语义压缩。

## 凭据模型（先看这一节，能省很多困惑）

NoCodeBackend 有**两种不同权限的凭据**，插件按用途分开使用：

| 能力 | **MCP key**（账号级） | **数据库 Secret Key**（库级） |
|---|---|---|
| 数据读写（记忆 CRUD） | ✅（走 execute_sql） | ✅（走 REST，更快） |
| 读取表结构 | ✅ `get_schema` | ✅ `/api/public/schema`（其实**匿名也能读**） |
| **建表 / 加列 / 建索引 / 删表** | ✅ | ❌ **实测 27 个端点全是 CRUD，任何 DDL 端点都 404** |
| **创建数据库** | ✅ `create_database` | ❌ |
| 创建 R2 bucket | ✅ `setup_r2_storage` | ❌ |
| R2 上传 / 列举 / 删除 | 仅上传 | ✅ |

**结论：建表、建库、挂 R2 必须用 MCP key。** 所以「数据库管理」这一块全部走 MCP。

### 只填 MCP key 就能全自动

`db_provision` 一个调用搞定全部，用户只需要 MCP key 和数据库名：

1. **`list_databases` 查重** —— 这一步不能省（见下方「重名陷阱」）
2. **`create_database`** —— 按 `schema.js` 的声明建库建表，字段类型自动映射
3. **捕获自动生成的 Secret Key** —— 创建时的返回值里带着它，而且是**唯一能拿到它的时机**
   （`get_integration_prompts` 取不回密钥值）。插件把它存到
   `~/.magpie-memory-hub/state.json`（0600、原子写）。官方镜像的 `HOME=/config/home`
   位于唯一持久卷 `/config` 内，所以**容器重建也不丢**。
   → 于是数据读写能走快速的 REST，而**用户一个 Secret Key 都不用填**。
4. **`db_init` 补齐** —— `create_database` 不会建索引，也不带 `created_at`/`updated_at`，
   这一步用同一套差集逻辑补上（只增不删）
5. **`setup_r2_storage`** —— 自动建 bucket 并配 CORS；账号已有 Cloudflare 连接时自动复用凭据

### ⚠️ 重名陷阱（必须知道的坑）

实测：**NoCodeBackend 遇到重名不报错，而是静默加后缀**——

```
请求 memhub（已存在） → 实际建成 41694_memhub_1
```

**不预检就会另建一个空库，把数据劈成两半。** 所以 `db_provision` 强制「先查再建」，并提供三种策略：

| 策略 | 行为 |
|---|---|
| **`reuse`（默认）** | 复用已有库，只补缺失的表/列/索引，**绝不新建、绝不破坏数据** |
| `fail` | 返回 `NAME_TAKEN`，让用户改名 |
| `auto_rename` | 允许 NCB 加后缀（会新建**独立空库**，会明确告警） |

**跨用户不会冲突**：NCB 强制给库名加账号前缀（请求 `memory` → 建成 `41694_memory`），每个账号独立命名空间。

### R2 文件存储

| 操作 | 走哪条路 |
|---|---|
| 创建 bucket + CORS | MCP `setup_r2_storage` |
| 上传 | **REST multipart（优先）**，无 Secret Key 时退回 MCP base64 |
| 列举对象 | REST `GET /files` |
| 删除对象 | REST `DELETE /files/{key}`（需 `confirm:"DELETE"`） |
| 下载 | 靠 bucket 的公开域名（NCB 不提供文件流代理） |

**如实标注做不到的**：服务端生成**下载**用的 presigned URL；读取底层 Cloudflare 凭据。

推荐工作流：`storage_upload` 拿 url → `memory_save` 存成 `category=file` 的记忆 → 日后 `memory_search` 找回。

## 能力清单

### 网关中间件（moejs，纯同步、每请求零 O(n)）
- **记忆注入**：倒排索引 + RRF 融合（词法/新鲜度/热度/作用域四路排名），艾宾浩斯双时态衰减，行为准则无条件置顶
- **请求压缩**：
  - JSON 结构化压缩（照抄 Headroom SmartCrusher 阈值：`min_items_to_analyze=5`、`max_items_after_crush=15`、`variance_threshold=2.0`、`first_fraction=0.3`、`last_fraction=0.15`）
  - **反常保命**：error 项 / 数值异常 / 长度异常 / 变化点 **加法式保留，超出配额也不丢**；输出前有 `audit_safe` 审计，少任何一项就整体放弃压缩
  - 日志压缩（致命行优先保命）、散文语义压缩、**Git status / diff 无损直通**
  - **跨轮逐字去重**：agent 反复重显同一文件时折成指针，遵守「前缀单调性」与「keep-earliest」两条不变量
  - **绝不压缩**：用户自己写的散文（`skip_user_messages`）、system prompt（KV-Cache 热区）、最近一轮
- **流式剥离**：回复里的 `<memory>` 块在 `onEvent` 上逐块剥离；超 20KB 未闭合则原样吐出（fail-open）

### 工具层（Bun 宿主，18 个 MCP 工具）
- 记忆：`memory_save` / `memory_search` / `memory_list` / `memory_context` / `memory_extract` / `memory_get` / `memory_forget`
- 踩坑：`pitfall_save` / `pitfall_search`
- 数据库：`db_status`（只读，零凭据也能用）/ **`db_provision`（一键全自动）** / `db_init`（幂等补齐）/ `db_reset`（需 `confirm:"RESET"`）
- R2：`storage_setup` / `storage_upload` / `storage_list` / `storage_delete`（需 `confirm:"DELETE"`）/ `storage_guide`

### 离线管线（Python）
失败→恢复挖掘、环境事实、架构决策、规则仲裁、快照推送、可选语义压缩

## 几个值得说的实现细节

- **中间件每请求零 O(n)**。记忆快照带版本号，索引按版本号做 O(1) 缓存；否则每次请求都要重建倒排索引（5000 条时实测 252ms，直接击穿 250ms 限额）。优化后同一场景 **1.33ms**。
- **中文用双字组分词**。无词典分词下若把整段中文当成一个 token，「端口冲突怎么处理」永远匹配不到标题里的「端口冲突」，中文召回会大面积失效。
- **行为准则无条件置顶**。`principle` 类记忆的价值在于「你还不知道会踩坑时就提醒你」，走关键词匹配反而会在最需要它的场合缺席。
- **压缩以「词」为单位，不是 token**。WordPiece 会把中文按字切，token 级丢弃会打碎词语（「如何」→「何」）并产生乱码。按空白切词后中文整句同生共死，物理上不可能碎词——这是 [Headroom](https://github.com/headroomlabs-ai/headroom) 的做法。
- **语义脆弱词一律钉住**。丢掉 "not" 不是「降级指令」，而是**变成相反的指令**；中文的「不/禁止/必须/除非」同理。压缩时这些词永不丢弃。
- **流式剥离**。agent 场景几乎全是流式回复，`onResponse` 拿不到内容，所以 `<memory>` 块在 `onEvent` 上逐块剥离；超过 20KB 仍未闭合则原样吐出（fail-open），绝不吞用户内容。
- **为什么没有压缩结果缓存**（实测否决）。加过一版「两级压缩缓存」（跳过集 + 结果集，对齐 Headroom 的 `CompressionCache`），在真实 moejs 上端到端实测后**整体移除**：
  | 量 | 实测值 |
  |---|---|
  | 单次**压缩** 8680 字符块 | 9.1 ms（1.05 µs/字符） |
  | 单次**哈希** 8680 字符块 | 6.9 ms（0.79 µs/字符） |
  | 端到端 on/off（4 轮全新相同请求体，缓存 18 命中 / 6 未命中） | **1.01x** |
  
  根因：**算缓存键要先把全文哈希一遍，而这个哈希的成本是压缩本身的 76%**。省下的 18 次压缩（164ms）与付出的 24 次哈希（166ms）正好抵消。即便构造最有利的场景（每轮请求体完全相同、缓存全命中），收益也只有 1%。真实流量每轮上下文都在变，命中率更低，**必然净亏**。已删代码 5315 字节 / 187 行，`hash32hex` 保留给前缀漂移探测器用。
  
  > 顺带记两个测量陷阱，免得以后有人重蹈：① moejs 里**紧循环测哈希不可信**（孤立测与端到端推出值差 25 倍，最终两者在正确实验下互相印证）；② `compressBody` **原地改写 body**，复用同一 body 迭代会让第二轮起块已变小而提前返回，测出来的只是哈希开销而非缓存收益。

- **注入只落尾部，绝不碰 system prompt**。provider 的 KV-Cache 以**前缀**为单位命中，system prompt 是缓存热区——改它等于让整段缓存失效，省下的注入 token 远抵不上代价。这条不变量来自 Headroom 的 `CacheAligner`（它的注释里写明旧实现因违反此条被整个删除）。注入落在最后一条用户消息上，前缀保持字节稳定。
- **跨轮去重的两条不变量**（来自 Headroom `cross_turn_dedup.py`）：① **前缀单调性**——只与严格更早的块匹配，追加新一轮永不改动更早的轮，因此 prompt-cache 前缀字节稳定；② **keep-earliest**——最早出现处永不改写，所以指针指向的原文始终在上下文里。

## License

MIT
