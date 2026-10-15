# magpie-memory-hub

[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-blue.svg)](https://usemagpie.ai)
[![NoCodeBackend Powered](https://img.shields.io/badge/Storage-NoCodeBackend-emerald.svg)](https://nocodebackend.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**magpie-memory-hub** 是专为 [Magpie](https://github.com/yetone/magpie) 设计的高性能企业级长期记忆与工程避坑网关中间件。

它拥有**CSP 完全合规的现代化图形配置控制台（动态模型自动探测、iOS 开关、下拉建议、一键导出 MCP 配置）**，深度融合了 **Mem0**（增量状态机与访问衰减）、**Headroom**（Failure-Learning 启发式提取与 Token 预算保护）、**Context-Mode**（运行时系统降噪）以及 **NoCodeBackend** 云端关系型索引底座。

---

## 核心架构与模型提炼体系

### 1. 为什么模型不能写死？
- 用户的 Magpie 网关通常聚合了来自不同供应商的上百个模型，或者挂载了自建的私有模型（如 `clef`、本地 Ollama 或自部署模型）。
- **v1.5.0 全新架构**：
  - 自动向 Magpie 宿主申请 `usage:summary` 与 `providers:list` 权限；
  - 自动读取网关中**真实配置、活跃的所有模型列表**并注入前端 `<datalist>` 智能建议池；
  - 同时支持**任意自定义模型名称直接输入**，彻底告别写死选项的硬编码弊端！

---

## 核心特性与架构

1. **CSP 严格合规图形化控制台 (Zero Inline Script & Dynamic Models)**：
   - 彻底移除了所有 `<script>` 内联代码与 `onclick` 等内联属性，所有事件完全由外部 `settings.js` 通过 `addEventListener` 驱动，100% 免疫浏览器与 Magpie 的 CSP 拦截阻断；
   - **动态模型智能建议**：事实提取模型与 Clef 仲裁模型支持下拉点选网关现有模型，亦可直接自由输入；
   - **一键 MCP 挂载复制**：支持一键将完整的 JSON 配置写入剪贴板，支持仅复制启动命令与全选快捷键复制。

2. **微秒级倒排索引扫描 (Zero Latency Overhead)**：
   - 运行在 Magpie 的 Go `moejs` 纯内存引擎中；
   - 前置自动清洗 `<system-reminder>` 等运行时框架噪声；
   - 采用倒排索引快速匹配，耗时 < 0.1ms。

3. **严格的 Token/字符预算硬顶 (Context Budget Guard)**：
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
