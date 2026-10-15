# magpie-memory-hub

Magpie 网关透明长期记忆插件 v2.0。

## 核心架构

```
用户对话 → Magpie Gateway → middleware.js(onRequest: 注入记忆)
                                        → 转发 LLM
                          ← middleware.js(onResponse: 输出 [MEMORY_HARVEST] 日志)

daemon.py (MCP Stdio Server)  ←→  minis-mcp-cli  ←→  NoCodeBackend MCP (execute_sql)
                                                          ↓
                                                   41694_agent_memory 数据库
                                                   (memories + pitfalls 表)
```

## 工作原理

1. **onRequest** — 从 `ctx.options.memories` 倒排索引匹配关键词，注入相关记忆到 system prompt
2. **onResponse** — 将对话 payload 通过 `console.log("[MEMORY_HARVEST]...")` 输出
3. **daemon.py** — MCP stdio server，提供 5 个工具（search/record memories, query/record pitfalls, list_all）
4. **数据通道** — 通过 `minis-mcp-cli` 子进程调用 NCB MCP 的 `execute_sql`，零认证问题

## 数据库

- 实例: `41694_agent_memory`
- 表: `memories`（长期记忆）+ `pitfalls`（踩坑记录）
- RLS: `public_readwrite`（公开读写）

## MCP 工具

| 工具 | 说明 |
|------|------|
| `search_memories` | 关键词搜索记忆（标题/内容/标签） |
| `record_memory` | 写入记忆（自动 ADD/UPDATE/NOOP 去重） |
| `query_pitfalls` | 搜索踩坑记录 |
| `record_pitfall` | 写入踩坑（自动去重+recurrence 计数） |
| `list_all` | 列出全部活跃记忆 |

## 安装

```bash
magpie plugin add github:otaku-say/magpie-memory-hub
```

## 本地测试

```bash
python3 daemon.py --test      # 自检
python3 daemon.py              # 启动 MCP stdio server
```
