# NOTES_v642_b: 实现 ARCH-4 宿主权威目录透传与 Magpie 便携模式兼容

## 1. 任务背景与核心问题

- **任务定位**：在沙箱分支 `feat/v642-b-portable` 中实现 **ARCH-4**：把宿主 `input.directory` / `ctx.directory` 透传给 `resolveGatewayDir`，无缝兼容 Magpie 便携模式（Portable Mode，录制路径为 `<exe>/data/gateway-conversations`）。
- **底层机制与宿主契约对标**：
  - 宿主源码 `magpie-main/internal/appdir/appdir.go:45-103` 与 `internal/plugin/host.go:996`：
    - Magpie 支持便携模式（Portable Mode）：当可执行程序同级存在 `data` 目录或 `.portable` 标记文件时，`settings.Dir()` 指向 `<exe>/data`。
    - 历史对话录制保存在 `filepath.Join(settings.Dir(), "gateway-conversations")`。
    - 宿主在插件初始化时通过 `input.directory` 传递权威目录（`settings.Dir()`）；在每次工具调用时通过 `ctx.directory` 传递权威目录。
  - 原插件代码中：
    - `tools.js` 的 `readOptions` 未读取宿主 `directory`；
    - `MagpieMemoryHub(input, options)` 未将 `input.directory` 透传给 `autoHarvest`；
    - `TOOLS.harvest_gateway.run` 未将 `ctx.directory` 透传给 `harvestGateway`；
    - `gateway_harvest.js` 的 `harvestGateway` 在调用 `resolveGatewayDir` 时仅传递 `options.dir || cfg.gatewayConvDir`，丢失宿主上下文；
    - `resolveGatewayDir` 未接受 `hostDir` 参数，无法利用宿主权威路径。
- **铁律约束（严禁放宽既有路径白名单）**：
  - 严禁放宽既有路径白名单或修改 `isHomeOrRootAllowed`、`isWhitelistedGatewayDir`、`checkPathForbidden`、`HARD_FORBIDDEN_PREFIXES`。
  - 宿主透传的 `hostDir`（以及由其推导的 `hostConvCandidate`）必须无条件接受 `validateGatewayDir` / `checkPathForbidden` 校验；一旦命中系统敏感目录（如 `/root/private_secrets`、`/etc`、`~/.ssh`、`/var/log` 等）或非法相对跳转 `..`，必须立即阻断并抛出 `[SECURITY_BLOCKED]`，坚决防范恶意借道与逃逸。

---

## 2. 详细改造方案

### 2.1 gateway_harvest.js
1. **`resolveGatewayDir(customDir, hostDir)` 扩展与优先级对齐**：
   - 支持多态入参：`resolveGatewayDir(customDir, hostDir)` 或 `resolveGatewayDir({ dir, hostDir, directory })`。
   - 解析优先级链条：
     1. 显式指定的自定义目录 `customDir` / `options.dir`（经 `validateGatewayDir` 校验）；
     2. 环境变量 `MEMHUB_GATEWAY_CONV_DIR`（经 `validateGatewayDir` 校验）；
     3. 宿主权威传入的 `hostDir`（兼容 `<exe>/data` 或 `<exe>/data/gateway-conversations`，强制经 `validateGatewayDir` 校验）；
     4. 运行时 `cwd` 下的 `gateway-conversations`（`Bun` 宿主 `cwd` 为 `settings.Dir()`）；
     5. `XDG_CONFIG_HOME/magpie/gateway-conversations`；
     6. 官方 Docker 容器路径 `/config/magpie/gateway-conversations`；
     7. 用户主目录 `~/.config/magpie/gateway-conversations`；
     8. 若均不存在，优先回退到已验证的宿主权威候选路径。
2. **`harvestGateway(args, context)` 宿主目录全链路提取与透传**：
   - 提取 `hostDir` 来源：
     - `context._ctx?.directory`（MCP 工具调用阶段宿主传入）
     - `context.directory`（直接调用宿主 context）
     - `context._input?.directory` / `context.input?.directory`（插件入口 input 注入）
     - `cfg.hostDirectory` / `cfg.directory`（readOptions 归一化提取）
     - `options.hostDirectory` / `options.hostDir`（选项显式指定）
   - 调用 `resolveGatewayDir(options.dir || cfg.gatewayConvDir, hostDir)` 完成探测。

### 2.2 tools.js
1. **`readOptions(options)` 补齐宿主目录提取**：
   - 提取 `hostDirectory: o.hostDirectory || o.host_directory || o.directory || ""`。
2. **`MagpieMemoryHub(input, options)` 宿主初始化透传**：
   - 归一化提取 `hostDir = (input && input.directory) || (options && options.directory) || ""`，注入 `mergedOpts`。
   - 在 `autoHarvest` 调度调用 `harvestGateway` 时，透传 `_input: input`。
3. **`TOOLS.harvest_gateway.run` 工具调用透传**：
   - 在 `run: (args, ctx) => harvestGateway(args, { ... })` 中，透传 `_input: ctx._input`，保留 `_ctx: ctx._ctx`（携带 `ctx.directory`）。

---

## 3. 双向反证测试矩阵 (tests/test_v642_b_portable.mjs)

| 门禁分类 | 测试用例 | 验证与反证设计 |
| :--- | :--- | :--- |
| **正向门禁 1** | `resolveGatewayDir` 便携模式父目录解析 | 传入宿主便携数据目录 `<portable_root>/data`，自动解析并返回 `<portable_root>/data/gateway-conversations` |
| **正向门禁 2** | `resolveGatewayDir` 完整目录直接解析 | 传入已包含 `gateway-conversations` 尾段的路径，正确保留并解析 |
| **正向门禁 3** | `resolveGatewayDir` 物理存在目录优先命中 | 当磁盘上存在便携目录时，候选扫描优先命中便携目录，先于系统级默认目录 |
| **正向门禁 4** | `resolveGatewayDir` 优先级阶梯反证 | `customDir` > `MEMHUB_GATEWAY_CONV_DIR` > `hostDir` > 默认回退 |
| **安全反证 5** | 严禁放宽：敏感前缀 `/root/private_secrets` 拦截 | 宿主 `hostDir` 传入 `/root/private_secrets`，必须抛出 `[SECURITY_BLOCKED]` 拒绝 |
| **安全反证 6** | 严禁放宽：系统目录 `/etc` 拦截 | 宿主 `hostDir` 传入 `/etc/magpie/data`，必须抛出 `[SECURITY_BLOCKED]` 拒绝 |
| **安全反证 7** | 严禁放宽：凭据目录 `~/.ssh` 拦截 | 宿主 `hostDir` 传入 `~/.ssh/data`，必须抛出 `[SECURITY_BLOCKED]` 拒绝 |
| **安全反证 8** | 严禁放宽：`/var/log` 非法子域拦截 | 宿主 `hostDir` 传入 `/var/log/magpie/data`，必须抛出 `[SECURITY_BLOCKED]` 拒绝 |
| **安全反证 9** | 严禁放宽：相对跳转 `..` 拦截 | 宿主 `hostDir` 传入 `/tmp/a/../b/data` 含 `..` 段，必须抛出 `[SECURITY_BLOCKED]` 拒绝 |
| **安全反证 10** | 严禁放宽：跨用户 home 越权拦截 | 模拟非 root 用户，传入其他用户 `/home/otheruser/data`，必须拒绝 |
| **全链路正向 11** | `harvestGateway` 通过 `_ctx.directory` 透传 | `harvestGateway` 成功定位并扫描便携模式落盘目录 |
| **全链路正向 12** | `harvestGateway` 通过 `_input.directory` 透传 | `MagpieMemoryHub` 入口传入的 `input.directory` 能够生效 |
| **全链路安全 13** | `harvestGateway` 传入非法 `_ctx.directory` 拦截 | `harvestGateway` 在 `_ctx.directory` 命中黑名单时抛出 `[SECURITY_BLOCKED]` |
| **MCP 工具入口 14**| `tool.harvest_gateway.execute` 真实契约验证 | 宿主 `execute(args, { directory })` 成功透传且隔离合规 |
| **元检查自验 15**| `test_meta.mjs` 静态合规扫描 | 0 违规，写库隔离与清理断言 100% 闭环 |
