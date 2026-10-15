# magpie-memory-hub

[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-blue.svg)](https://usemagpie.ai)
[![NoCodeBackend Powered](https://img.shields.io/badge/Storage-NoCodeBackend-emerald.svg)](https://nocodebackend.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**magpie-memory-hub** 是专为 [Magpie](https://github.com/yetone/magpie) 设计的高性能企业级长期记忆与工程避坑网关中间件。

它深度融合了 **Mem0**（增量状态机与访问衰减）、**Headroom**（Failure-Learning 启发式提取与 Token 预算保护）、**Context-Mode**（运行时系统噪声清洗）以及 **NoCodeBackend** 云端高并发关系型索引底座。

---

## 核心架构与先进特性

1. **Mem0 风格的增量演化状态机 (Incremental State Machine)**：
   - 提取新经验时，通过哈希指纹和上下文对比，自动执行四分流：`ADD`（全新入库）、`UPDATE`（新推翻旧，旧方案打上 `superseded` 标记）、`NOOP`（已有完全一致经验，仅递增权重）、`DELETE`。
   - 杜绝传统记忆系统反复重复插入导致的上下文漂移。

2. **多维作用域隔离 (Multi-tier Scope)**：
   - 支持 `global`（全局不可逾越的纪律与偏好）、`project`（具体仓库或项目的架构约定）、`session`（当前任务的瞬时上下文）三层作用域。

3. **故障频次与衰减排序 (Recurrence & Decay Policy)**：
   - 避坑宝典库自动统计同一 Bug 的 `recurrence_count`（复现频次）与 `last_occurred_at`（最近复现时间）；
   - 动态打分公式：$$\text{Score} = \text{Confidence} \times (1 + 0.1 \times \min(\text{AccessCount}, 10))$$，高频被验证的有效规则自动前置。

4. **微秒级倒排索引与系统降噪 (Inverted Index & Noise Cleaning)**：
   - 中间件运行在 Magpie 的 Go `moejs` 纯内存引擎中；
   - 自动过滤 `<system-reminder>`、`<task-notification>` 等平台内部运行时标签；
   - 严格的 Token/字符预算硬顶（默认 2048 字符 / 5 条命中），杜绝撑爆上下文窗口。

5. **云端无限持久化 (NoCodeBackend Tier-2 终身底座)**：
   - 经过 B-Tree 索引优化的 4 张高内聚数据表；
   - 直通 Cloudflare R2 对象存储，支持无限大文件、二进制与架构图托管。

---

## 安装与使用

### 方式一：在 Magpie 中一键添加（推荐）

打开终端执行：
```bash
magpie plugin add github:otaku-say/magpie-memory-hub
```
或者在 Magpie 桌面客户端中：
1. 打开 **设置 → 插件 (Plugins)**；
2. 点击 **添加插件 (Add Plugin)**；
3. 输入 `otaku-say/magpie-memory-hub` 确认即可自动加载生效！

### 方式二：作为独立 MCP Server 挂载

在你的 MCP 配置文件（如 `claude_desktop_config.json` 或 Agent 设置）中添加：

```json
{
  "mcpServers": {
    "magpie-memory-hub": {
      "command": "python3",
      "args": ["/path/to/magpie-memory-hub/daemon.py", "--mcp"],
      "env": {
        "NCB_INSTANCE": "41694_agent_core_hub",
        "NCB_SECRET_KEY": "你的_NCB_SECRET_KEY"
      }
    }
  }
}
```

---

## 插件配置选项 (Options)

在 Magpie 中打开该插件的「选项」即可通过 JSON 或图形化表单动态调整：

| 选项键名 | 类型 | 默认值 | 作用说明 |
| :--- | :--- | :--- | :--- |
| `disabled` | boolean | `false` | 全局旁路开关（设置为 true 时完全不修改请求） |
| `inject_pitfalls` | boolean | `true` | 是否同时注入匹配的工程避坑经验与历史翻车根因 |
| `max_inject_count` | number | `5` | 单次请求允许注入的最大记忆条数 |
| `max_budget_chars` | number | `2048` | 单次注入文本的总字符预算硬顶（防止爆 Token） |
| `min_confidence` | number | `0.75` | 记忆置信度过滤阈值（0.0 ~ 1.0） |
| `ncb_instance` | string | `41694_agent_core_hub` | 关联的 NoCodeBackend 数据库实例 |
| `r2_domain` | string | `https://agent-core-hub.4a8a.com` | Cloudflare R2 资源访问加速域名 |

---

## 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。欢迎提交 Pull Request 与 Issue！
