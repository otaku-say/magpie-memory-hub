# 验证脚本

这些脚本针对**真实**的 NoCodeBackend API 运行（会真的建表/写库），不是 mock。
运行前设置环境变量：

```bash
export NOCODEBACKEND_API_KEY='<你的 MCP key>'
```

| 脚本 | 验什么 | 需要 MCP key | 需要 Secret Key |
|---|---|---|---|
| `test_schema.mjs` | schema.js 的差集计算与幂等（纯本地，不联网） | 否 | 否 |
| `check_schema_sync.mjs` | schema 声明 ↔ 代码实际写入是否对齐（防止漏列这种致命 bug） | 否 | 否 |
| `test_sql_escape.mjs` | **SQL 注入防线**：标识符白名单 + 值转义 + 真实往返逐字节比对 | 是 | 否 |
| `test_beacon.mjs` | 设置页信标：幂等、确认门、状态文件丢失时的 fail-closed | 是 | 是 |
| `test_mcp_only.mjs` | **只填 MCP key** 时的记忆读写全链路 | 是 | 否 |
| `test_provision.mjs` | `db_provision` 的重名检测与三种策略（**不会新建库**） | 是 | 否 |
| `verify_settings.mjs` | 设置页行为：DOM stub 真实执行，重点验「写信标不丢配置」 | 否 | 否 |

容易踩的坑：`test_beacon.mjs` / `test_provision.mjs` 会读写
`~/.magpie-memory-hub/` 下的状态文件；跑之前建议先备份或清掉。
