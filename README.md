# magpie-memory-hub

[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-blue.svg)](https://usemagpie.ai)
[![NoCodeBackend Powered](https://img.shields.io/badge/Storage-NoCodeBackend-emerald.svg)](https://nocodebackend.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**magpie-memory-hub** 是专为 [Magpie](https://github.com/yetone/magpie) 设计的高性能企业级长期记忆与工程避坑网关中间件。

它拥有**CSP 完全合规的现代化图形配置控制台（路由分组模型联动、动态远程 MCP 端点自动推导、iOS 开关、一键复制远程 MCP 配置）**，深度融合了 **Mem0**（增量状态机与访问衰减）、**Headroom**（Failure-Learning 启发式提取与 Token 预算保护）、**Context-Mode**（运行时系统降噪）以及 **NoCodeBackend** 云端关系型索引底座。

---

## 核心架构与模型提炼体系

### 1. 路由分组模型智能联动
- 用户的 Magpie 网关通常在「路由」中配置了丰富的**组合模型与别名**（如 `fast` 极速小模型组、`smart` 强推理组、`clef` 仲裁专用模型等）。
- **v1.6.0 升级**：
  - 提取模型与 Clef 仲裁模型优先关联路由分组（如 `fast` 与 `clef`）；
  - 自动向 Magpie 宿主申请 `usage:summary` 与 `providers:list` 权限，智能将真实活跃的模型组合填充至下拉建议池；
  - 支持任意自由输入自定义模型名称。

### 2. 动态远程 MCP 服务端点（不硬编码域名）
- **动态探测当前访问域名**：自动检测当前页面 Origin（如访问 `https://magpie-web.4a8a.com` 时自动智能推导对应的 API 域名 `https://magpie-api.4a8a.com`）；
- **动态路径与鉴权展示**：
  - 动态端点：`https://<你的网关域名>/41694_agent_core_hub/mcp`；
  - 明确标注需要携带安全鉴权头：
    ```json
    "headers": {
      "Authorization": "Bearer $MAGPIE_API_KEY"
    }
    ```
    （复用 Magpie 网关统一 API Key 鉴权，外部 Agent 无论在沙箱、本地还是公网均可安全直连）。

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

### 方式二：远程 MCP 服务直接挂载（推荐）

在设置面板中直接点击 **「📋 一键复制完整配置」**，或直接写入客户端配置：

```json
{
  "mcpServers": {
    "magpie-memory-hub": {
      "url": "https://magpie-api.4a8a.com/41694_agent_core_hub/mcp",
      "headers": {
        "Authorization": "Bearer $MAGPIE_API_KEY"
      }
    }
  }
}
```

---

## 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。
