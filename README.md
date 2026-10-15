# magpie-memory-hub

[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-blue.svg)](https://usemagpie.ai)
[![NoCodeBackend Powered](https://img.shields.io/badge/Storage-NoCodeBackend-emerald.svg)](https://nocodebackend.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**magpie-memory-hub** 是专为 [Magpie](https://github.com/yetone/magpie) 设计的高性能企业级长期记忆与工程避坑网关中间件。

它拥有**CSP 完全合规的现代化图形配置控制台（纯手动输入模型/分组 ID、独立 API Key 安全绑定、动态路径自定义与自动追加 `/mcp`）**，深度融合了 **Mem0**（增量状态机与访问衰减）、**Headroom**（Failure-Learning 启发式提取与 Token 预算保护）、**Context-Mode**（运行时系统降噪）以及 **NoCodeBackend** 云端关系型索引底座。

---

## 核心设计与特性演进

### 1. 提炼模型与仲裁模型：彻底支持手动填写模型/分组 ID
- **为什么改成纯手动输入？**
  - 在实际生产网关中，模型通常是由多个上游或账户聚合而成的组合路由别名（例如将多个 Cloudflare 账号模型组合成的 **`group/clef`**，或极速提取分组 **`fast`**）；
  - 去除硬编码下拉菜单限制，允许直接自由填写任意单个模型 ID 或组合路由分组 ID。

### 2. 挂载路径自定义：输入任意前缀，结尾自动规范化追加 `/mcp`
- 挂载路径完全开放自由定制，不再固定死；
- 输入 `/test` 或 `test` $\rightarrow$ 自动规范化推导为 `域名/test/mcp`；
- 输入 `/41694_agent_core_hub` $\rightarrow$ 自动规范化推导为 `域名/41694_agent_core_hub/mcp`；
- 兼容任意自定义路径前缀，且杜绝重复斜杠与多次重复追加。

### 3. NoCodeBackend 独立 API Key / Secret Key 通信
- 在 NoCodeBackend 数据库管理菜单中生成专属的 API Key（如 `ncb_sec_...`）；
- 插件图形化面板支持直接保存此 Key，并在后台 Daemon 通信与一键生成的 MCP 配置中优先应用，实现与业务数据库的物理隔离与安全加固。

### 4. 动态远程 MCP 服务端点（不硬编码域名）
- 自动检测当前页面 Origin，自动将 Web 域名映射为网关 API 域名（例如推导为 `https://magpie-api.4a8a.com/test/mcp`）；
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

### 方式二：远程 MCP 服务直接挂载

在设置面板中直接点击 **「📋 一键复制完整配置」**，或直接写入客户端配置：

```json
{
  "mcpServers": {
    "magpie-memory-hub": {
      "url": "https://magpie-api.4a8a.com/41694_agent_core_hub/mcp",
      "headers": {
        "Authorization": "Bearer $$MAGPIE_API_KEY"
      }
    }
  }
}
```

---

## 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。
