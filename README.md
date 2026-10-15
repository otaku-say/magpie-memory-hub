# magpie-memory-hub

[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-blue.svg)](https://usemagpie.ai)
[![NoCodeBackend Powered](https://img.shields.io/badge/Storage-NoCodeBackend-emerald.svg)](https://nocodebackend.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**magpie-memory-hub** 是专为 [Magpie](https://github.com/yetone/magpie) 设计的高性能企业级长期记忆与工程避坑网关中间件。

它拥有**图形化配置面板（开关/下拉选择器/一键复制 MCP 配置）**，深度融合了 **Mem0**（增量状态机与访问衰减）、**Headroom**（Failure-Learning 启发式提取与 Token 预算保护）、**Context-Mode**（运行时系统降噪）以及 **NoCodeBackend** 云端关系型索引底座。

---

## 核心特性与架构

1. **图形化控制台与一键配置 (Graphical UI & One-Click MCP Export)**：
   - 完全告别裸写 JSON 的繁琐操作，原生内嵌在 Magpie 侧边栏与插件页面中；
   - 提供直观的 **iOS 风格开关、下拉选择框**；
   - **MCP 服务一键复制**：提供一键复制包含命令、路径与凭据的标准 JSON 配置，随时无缝接入 Claude Desktop、Cursor、Cline 与 Minis。

2. **幂等安装与卸载 (Strictly Idempotent Lifecycle)**：
   - 无论添加或移除多少次，均不会污染宿主系统环境；
   - 依赖与状态完全解耦，云端数据库具备防重指纹（SHA-256 Fingerprint），重复写入自动 NOOP。

3. **微秒级倒排索引扫描 (Zero Latency Overhead)**：
   - 运行在 Magpie 的 Go `moejs` 纯内存引擎中；
   - 前置自动清洗 `<system-reminder>` 等运行时框架噪声；
   - 采用倒排索引快速匹配，耗时 < 0.1ms。

4. **严格的 Token/字符预算硬顶 (Context Budget Guard)**：
   - 杜绝传统记忆系统暴击上下文导致扣费翻倍的问题；
   - 提供 1024 / 2048 / 4096 / 8192 等预算预设。

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
4. 添加后在 Magpie 侧边栏即可直接打开 **记忆中枢设置** 图形化面板。

### 方式二：作为独立 MCP Server 挂载

在设置面板中直接点击 **「📋 复制 JSON 配置」**，或在你的 MCP 配置文件中添加：

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

## 关键参数表

| 参数名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `opt_auto_inject` | `true` | 全局记忆自动前置注入开关 |
| `opt_inject_pitfalls` | `true` | 是否同时注入工程避坑经验 |
| `opt_auto_supersede` | `true` | 新经验推翻旧经验时自动打上淘汰标记 |
| `opt_max_inject_count` | `5` | 单次最大注入条数 |
| `opt_max_budget_chars` | `2048` | 单次注入总字符预算上限 |
| `NCB_INSTANCE` | `41694_agent_core_hub` | 关联的 NoCodeBackend 数据库实例 |

---

## 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。
