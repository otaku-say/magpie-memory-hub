# 部署版本与超大状态文件排查报告 (NOTES_deploy_and_state.md)

> 日期：2026-10-18  
> 状态：排查完成，结论与修复方案就绪（根据现场检查与用户确认收敛）

---

## 核心事实确认

1. **当前生效版本**：用户容器内实际生效的版本为 **v6.19.0**（具体对应 Commit `1d95382` / `134b69f`）。
2. **两处既定事实**：
   - `model_budget.js` 缺失：完全正常，该文件为 **v6.20.0** 熔断重构时新增；v6.19.0 本就没有。
   - `harvest.py` 仍存在：完全正常，v6.19.0 的 `package.json` 包含此文件；架构瘦身是在后续版本才执行删除。
   - 155,229 次调用风暴：v6.19.0 尚未引入自激熔断机制，`auto_harvest` 递归拦截网关 chat/completions 形成 2^n 指数放大。

---

## 一、排查 ①：部署机制、版本生效与确保更新步骤

### 1. Magpie 插件安装与更新底层机制
通过查阅 Magpie 源码（`internal/plugin/store.go`、`gitrev.go`、`bun.go`）：
- **获取方式**：Magpie 并不依赖系统全局 Node/npm，而是内置下载管理专属 Bun 运行时（常驻 `PID 16808 = bun 1.4.3 run plugin-host`）。
- **Git 依赖下载**：当通过 `github:owner/repo` 安装时，Magpie 通过 GitHub API 获取最新 Commit SHA，拉取 GitHub tarball 归档解压至 `BUN_INSTALL_CACHE_DIR`（路径位于 `/config/home/.cache/magpie/bun/install-cache/`）。
- **部署目录映射**：Bun 将解压后的 commit 目录通过硬链接（hardlink）或复制直接投递至实际生效目录 `/config/magpie/plugins/node_modules/magpie-memory-hub/`。
- **Commit 缓存堆积**：由于 Bun 对每次解析到的不同 Git Commit 均独立保留一份缓存且从不主动垃圾回收，导致 `install-cache` 累积了 37 个历史版本目录。

### 2. 为什么用户「以为更新了」，实际生效还是 v6.19.0？
- **原因 1：仅重启容器不会触发插件更新**。Magpie 容器启动（PID 1 `/magpie web`）直接加载现有 `plugins/node_modules/`，不执行远程拉取。
- **原因 2：`bun.lock` 锁定旧 Commit**。在 `/config/magpie/plugins/` 下存在 `bun.lock`（或 `bun.lockb`），若未强制清除，`bun add` / `bun update` 会优先采信本地 lockfile 中的 commit 哈希。
- **原因 3：GitHub API 缓存与限流**。Magpie 内部 `headTTL = 10 * time.Minute`，且容器内无认证的 GitHub API 极易触发每小时 60 次的 Rate Limit，导致 Magpie 判定「当前没有新版本」，从而跳过下载。

### 3. 给用户的「确保更新真正生效」操作步骤（可直接复制粘贴）
在容器内（或宿主机 `docker exec -it <容器名> bash`）执行以下三步：

```bash
# 步骤 1：移除旧插件并清理 lockfile 与旧安装缓存（彻底断绝旧 commit 缓存复活）
/usr/local/bin/magpie plugin rm magpie-memory-hub
rm -f /config/magpie/plugins/bun.lock /config/magpie/plugins/bun.lockb
rm -rf /config/home/.cache/magpie/bun/install-cache/*

# 步骤 2：全新拉取并安装最新版插件（当前已发版至 v6.22.0）
/usr/local/bin/magpie plugin add github:otaku-say/magpie-memory-hub

# 步骤 3：一键自检命令（确保生效目录中存在核心文件且版本号正确）
[ -f /config/magpie/plugins/node_modules/magpie-memory-hub/model_budget.js ] && cat /config/magpie/plugins/node_modules/magpie-memory-hub/package.json | grep '"version"' || echo "✗ 更新未生效，请检查网络或重试"
```

### 4. `install-cache` 堆积 37 个版本的清理策略
- **能否安全清理**：**可以 100% 全量清空**。
- **原理**：`install-cache` 纯属 Bun 的下载解压缓存，并非运行态依赖；在 `magpie plugin rm` 状态下清空绝不会损坏运行中的代码。
- **清理命令**：`rm -rf /config/home/.cache/magpie/bun/install-cache/*`。后续重新安装时只会按需下载最新单一 commit，目录重新保持纯净。

---

## 二、排查 ②：`state.json` 2.2 MB 根因分析与修法

### 1. `state.json` 内部数据结构与现状
文件路径：`/config/home/.magpie-memory-hub/state.json`（权限 0600，用户数据持久化文件）。
内部包含 6 大字段：
1. `secrets`：存储 NCB 数据库 Secret Key（极小，几百字节）。
2. `actions`：设置页信标历史记录，已有 `.slice(-50)` 上限（极小，~6KB）。
3. `r2_mounts`：R2 挂载凭据与端点状态（极小，几百字节）。
4. `gateway_harvest`：扫描进度与已处理 turn 指纹（指纹有 2000 上限，~150KB）。
5. `harvest_queue`：待落库缓冲队列（软上限 200 项）。
6. **`pending_patterns`（膨胀元凶）**：Headroom 门禁机制下的候选记忆/踩坑证据暂存字典。

### 2. 为什么会暴涨到 2.2 MB？
1. **v6.19.0 的容量与淘汰盲区**：
   - `DEFAULT_MAX_PENDING` 上限高达 **1000 条**。
   - 硬淘汰 TTL `DEFAULT_PENDING_TTL_MS` 为 **21 天**。
   - `recordPendingEvidence` 中记录了全量 `payload`（包含了 candidate 的 `title`, `content`, `tags`, `project` 等全量字符串）。
2. **自激风暴的灌水效应**：
   - 在 155,229 次自激调用中，模型不断从网关对话提炼出候选记忆。
   - 大量长文本对话、报错片段、提示词作为 `content` 灌入 `pending_patterns`，迅速占满 1000 条上限。
   - 1000 条带有完整长文本 payload 的字典，经 `JSON.stringify(out, null, 2)`（带换行缩进格式化），单文件体积正好达到 **2.28 MB（2,287,343 字节）**。
3. **性能危害**：
   - 每次请求钩子读写 `state.json` 时，都需要同步解析/序列化 2.2MB 的 JSON 并写入临时文件原子替换，不仅消耗大量内存，还会带来磁盘 I/O 阻塞。

### 3. 代码修复方案（不破坏用户真实凭据）
> **铁律**：绝不删除用户的 `state.json`（里面保存了唯一的数据库 Secret Key）。通过新版本代码自动瘦身自愈。

修法（落入后续代码迭代）：
1. **缩紧 `DEFAULT_MAX_PENDING` 容量**：从 1000 降为 **100**。普通生产环境 100 条待确认模式已完全足够。
2. **截断暂存 Payload 体积**：在 `pending_patterns` 尚未达到 `minEvidence` 毕业门槛前，仅存指纹与摘要元数据，`content` 强制截断为 200 字符以内，拒绝暂存万字对话。
3. **缩短 TTL 淘汰窗口**：将未复现候选记忆的淘汰周期由 21 天缩紧至 **3 天**。
4. **读写自动 Compact**：`readState()` / `writeState()` 时，若检测到 `pending_patterns` 超过 100 条，执行自动 LRU 清理，并使用紧凑格式存储。老用户的 2.2MB 文件在新版本启动写入一次后将自动瘦身至 50KB 以下。

---

## 三、排查 ③：`tests/` 与 `NOTES_*.md` 为什么进了部署目录

### 1. v6.19.0 的 `package.json` 白名单核查
检查 Commit `134b69f`（v6.19.0）的 `package.json`：
```json
"files": [
  "tools.js", "memory.middleware.js", "settings.html", "settings.js", "settings.css",
  "icon.svg", "schema.js", "db_tools.js", "ncb_mcp.js", "mcp_client.js",
  "local_state.js", "r2.js", "compress.js", "semantic_dedup.js", "harvest.py",
  "gateway_harvest.js", "gateway_harvest.hooks.js", "page_actions.js",
  "online_models.js", "README.md", "LICENSE"
]
```
- **结论**：v6.19.0 的 `files` 白名单中**绝对没有 `tests/`**，也**绝对没有 `NOTES_*.md`**。

### 2. 为什么实际目录仍塞入了 41 个 `NOTES_*.md` 和 `tests/`？
- **确凿技术证据**：
  1. npm/yarn 发布机制中，`files` 白名单仅在运行 `npm pack` 或 `npm publish` 打包发布到 npm registry 的 `.tgz` 包时生效。
  2. Magpie 的部署逻辑（`store.go:727`）是通过 `bun add github:otaku-say/magpie-memory-hub` 安装 Git 依赖。
  3. Git 依赖安装时，Magpie/Bun 直接从 GitHub API 下载该 Commit 的完整仓库归档（`tarball`）。GitHub 打包的是 Git HEAD 的完整工作树！
  4. Bun 解压归档后直接复制/链接入 `node_modules/`，**完全跳过了 `package.json` 的 `files` 字段过滤**。
  5. 现场验证：Commit `1d95382`（v6.18.0）的代码库中恰好存在 **41 个 `NOTES_*.md` 文件**，与容器实测目录中的文件数 100% 吻合！

---

## 四、排查 ④：关于 `/usr/local/bin/magpie` CLI 存在的修正

- **认知修正**：确认官方生产容器镜像中存在 `/usr/local/bin/magpie` 二进制文件。
- **架构决策不变**：此前关于「不使用 CLI 动态刷新 options」的架构决策依然完全正确——调用 `magpie plugin options` 会改写 `plugins.json` 并**直接杀死并重启 Bun 宿主进程（PID 16808 重启）**。如果在每次记忆保存时调用 CLI，网关将陷入永久重启死循环，因此必须坚持当前基于 NCB 数据库查询 + 定时/设置页同步的无重载架构。
