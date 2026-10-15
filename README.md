# magpie-memory-hub

[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-blue.svg)](https://usemagpie.ai)
[![NoCodeBackend Powered](https://img.shields.io/badge/Storage-NoCodeBackend-emerald.svg)](https://nocodebackend.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**magpie-memory-hub** 是专为 [Magpie](https://github.com/yetone/magpie) 设计的高性能企业级长期记忆与工程避坑网关中间件。

它拥有**图形化配置面板（开关/下拉选择器/提炼与 Clef 仲裁模型/一键复制 MCP 配置）**，深度融合了 **Mem0**（增量状态机与访问衰减）、**Headroom**（Failure-Learning 启发式提取与 Token 预算保护）、**Context-Mode**（运行时系统降噪）以及 **NoCodeBackend** 云端关系型索引底座。

---

## 核心架构与设计问答

### 1. 为什么需要提炼模型与 Clef 判断模型？
- **事实提取模型（Extractor Model）**：负责从完整的对话上下文、工具执行结果中提炼出结构化的三元组 `{project, category, summary, content, tags}`。推荐选择成本极低、速度极快的小模型（如 `deepseek-chat` / `gpt-4o-mini`）。
- **质量仲裁模型（Clef Judge Model）**：负责对提取出来的候选经验做把关，剔除一次性的临时会话废话，只给长期有工程价值的事实打出高置信度（Score），并判定新老冲突。

---

## 核心特性与架构

1. **完整图形化控制台 (Graphical UI & Multi-Model Setting)**：
   - 原生内嵌在 Magpie 侧边栏与插件页面中；
   - **模型专属配置卡片**：直观选择「事实提取模型」与「Clef 质量仲裁模型」，并设置最低入库置信度阈值；
   - **MCP 服务一键复制**：提供一键复制包含命令、路径与凭据的标准 JSON 配置，随时无缝接入 Claude Desktop、Cursor、Cline 与 Minis；提供“全选文本”兜底。

2. **幂等安装与卸载 (Strictly Idempotent Lifecycle)**：
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

在设置面板中直接点击 **「📋 一键复制配置」**，或在你的 MCP 配置文件中添加：

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

## 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。
