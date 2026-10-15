# magpie-memory-hub

[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-blue.svg)](https://usemagpie.ai)
[![NoCodeBackend Powered](https://img.shields.io/badge/Storage-NoCodeBackend-emerald.svg)](https://nocodebackend.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**magpie-memory-hub** 是专为 [Magpie](https://github.com/yetone/magpie) 设计的高性能企业级长期记忆与工程避坑网关中间件。

它借鉴了 **Headroom** 的 Failure-Learning 启发式提取思想与 **Token-Budget** 严格预算控制，将无感知的上下文注入、云端持久化（NoCodeBackend）以及标准 MCP 服务融为一体。

---

## 核心特性

1. **微秒级网关前置注入 (Zero Latency Overhead)**：
   - 中间件运行在 Magpie 的 Go `moejs` 纯内存引擎中；
   - 采用 **倒排索引（Inverted Index）** 算法匹配关键词，扫描耗时比传统全遍历快 4~5 倍（单次 < 0.1ms）；
   - 全协议原生适配：完美兼容 OpenAI Chat Completions、Anthropic Messages 与 Google Gemini。

2. **严格的 Token / 字符预算控制 (Context Budget Guard)**：
   - 彻底解决传统记忆插件暴击上下文窗口导致扣费翻倍的缺陷；
   - 默认限制单次注入上限与总字符预算（默认 2048 字符 / 5 条命中记录），超额自动按置信度截断。

3. **云端无限持久化 (NoCodeBackend Tier-2 终身引擎)**：
   - 结构化存储：长期知识与架构决策 (`knowledge_memories`)、工程避坑宝典 (`engineering_pitfalls`)、多模态产物 (`build_artifacts`) 与任务追踪 (`task_journals`)；
   - 内容防重指纹（`fingerprint` SHA-256）与版本更替（`superseded_by_id`）机制；
   - 直通 Cloudflare R2 对象存储，支持无限大文件、二进制与架构图托管。

4. **双向互通标准 MCP 服务 (Stdio JSON-RPC)**：
   - 自带标准 MCP 接口，可直接作为 MCP Server 挂载到 Claude Desktop、Cursor、Cline、Minis 等客户端，供 Agent 主动搜索与沉淀经验。

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
3. 输入仓库地址：`otaku-say/magpie-memory-hub`；
4. 插件将自动被 Bun 下载并加载为网关中间件！

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
