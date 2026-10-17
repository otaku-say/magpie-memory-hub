# 网关钩子超时与自动采集零产出根因分析及修复方案 (NOTES_hook_timeout.md)

## 1. 现象与根因定位

### 1.1 现象
用户环境：Magpie v0.1.1279（Docker）、插件 v6.13.1、`auto_harvest` 已开启。
探针日志输出：
```
plugin: [memory-hub][hook] onRequest 已被调用 | auto_harvest=true | options 键数=31 | gatewayTimeoutMs=undefined
```
用户在前端重新保存设置后，探针依然打印 `gatewayTimeoutMs=undefined`，网关自动采集持续零产出。

### 1.2 源码证据链：`p.options` 的真实构造来源与用户判断确认

经阅读上游 Magpie v0.1.1279 源码，确认用户的判断**完全正确**。完整源码证据链如下：

1. **`internal/plugin/host.go:979` 与 `store.go:431`（插件选项的持久化机制）**
   - 宿主从 `plugins.json` 读取配置列表：`l := Load()`。
   - 构造传给 plugin host 的插件项：
     ```go
     items = append(items, item{e.Spec, Target(e.Spec), e.Options, Gateway(Target(e.Spec))})
     ```
   - 在 `store.go:431` 中，当插件已存在被再次安装或更新时：
     ```go
     e.Options = l.Plugins[i].Options
     ```
     **宿主完全不会读取 `package.json` 中的 `magpie.options` 默认值与已有 options 做任何合并**。
   - 设置页通过 `POST /api/plugin-pages/options` 保存配置时，`SetPageOptions` 直接调用 `l.Plugins[i].Options = opts`，用前端提交的 JSON 对象全量覆盖。

2. **`internal/plugin/host.js:1186`（宿主传给钩子的 options）**
   - 在 `loadPlugins` 中：
     ```javascript
     if (gateway) gatewayHooks.push({
       spec: p.spec,
       options: p.options ?? {},
       onRequest: gateway.onRequest,
       onResponse: gateway.onResponse,
       onError: gateway.onError
     })
     ```
     钩子拿到的是 `p.options ?? {}`，即持久化在 `plugins.json` 中的裸配置。

3. **`internal/plugin/host.js:1225`（默认超时退化）**
   - 宿主计算网关钩子超时：
     ```javascript
     const gatewayTimeout = (h) =>
       Number.isInteger(h.options.gatewayTimeoutMs) &&
       h.options.gatewayTimeoutMs >= 100 &&
       h.options.gatewayTimeoutMs <= 10000
         ? h.options.gatewayTimeoutMs
         : 1000
     ```
   - 当 `h.options.gatewayTimeoutMs` 为 `undefined` 时，执行超时被严格钳制在**默认 1000ms（1 秒）**。

4. **`internal/plugin/host.js:1320`（超时 Abort 与静默吞掉）**
   - 在 `gatewayFinish` 中：
     ```javascript
     const ctl = new AbortController()
     const timer = setTimeout(() => ctl.abort(), gatewayTimeout(h))
     ctx.signal = AbortSignal.any([total, ctl.signal])
     try {
       await bounded(Promise.resolve().then(() => h.onResponse(structuredClone(p.reply), ctx)), ctx.signal)
     } catch {
       if (!signal.aborted) send({ event: "log", level: "warn", message: `${h.spec}: gateway response hook failed or timed out` })
     } finally {
       clearTimeout(timer)
       ctl.abort()
     }
     ```
   - 一旦 `onResponse` 耗时达到 1000ms，宿主定时器到期直接调用 `ctl.abort()`，`bounded` 立即抛出 `AbortError` 并被 catch 吞掉（fail-open）。

5. **设置页持久化字段缺失**
   - 本项目 `settings.js` 中的 `CARD_FIELDS.harvest` 仅声明了 `["auto_harvest"]`，`NUM` 注册表中也没有 `gatewayTimeoutMs`。
   - `collect()` 函数仅收集 DOM 中已注册字段或 `current` 中已有字段。
   - 因此 `gatewayTimeoutMs` 从未被写入 `plugins.json`，即使重新保存设置也无法补齐。

6. **零产出闭环**
   - `onResponse` 内部的提炼虽然耗时极低（<1ms），但在落库阶段需要向远程 NoCodeBackend 发起 HTTP JSON-RPC（`execute_sql`）。
   - 提取出的环境事实、架构决策、踩坑解法逐项进行查重（`list`）与创建（`create`），涉及 2~6 次远程 HTTP 往返，串行耗时极易超过 1000ms。
   - 结果在 1000ms 处被宿主强行 abort 中断，异常被吞，导致自动采集零产出。

---

## 2. 修复方案设计

### 2.1 治本方案：钩子不依赖 `gatewayTimeoutMs` 的非阻塞落库与本地队列
1. **解耦网关响应与网络落库**：
   - `onResponse` 仅负责极速的本地计算部分（提取对话、规则提炼、指纹生成、本地防重与 pending 门禁检查）。该过程在内存中 1~5ms 内完成。
   - 提炼出的待写入项放入落库队列 `pending_harvest_queue`，并持久化到 `local_state.js`。
   - 在后台非阻塞触发异步消费 `drainHarvestQueue()`（不 `await`，不绑定易被宿主 abort 的 `ctx.signal`）。
   - 网关钩子立即返回（返回时间 < 5ms），宿主 1000ms 定时器绝无机会触发 abort。
2. **多重消费兜底机制**：
   - 宿主后台异步消费：在常驻宿主 Node/Bun 进程中持续完成远程 NCB HTTP 写入。
   - 工具调用连带消费：在 `tools.js`（每次用户或助手调用工具时）检测并消费未完成的队列。
   - 支持同步等待开关（测试与显式等待兼容）：若传入 `options.wait_for_flush: true` 或直接调用 `processDialogueAndHarvest`，依然支持同步等待完成。
3. **并发查重与写入优化**：
   - 将多项 candidate 的入库由串行改为并发处理，显著压低远程落库总时长。

### 2.2 治标方案：将 `gatewayTimeoutMs` 加入设置页持久化
1. **字段注册**：
   - 在 `settings.js` 的 `CARD_FIELDS.harvest` 增加 `"gatewayTimeoutMs"`。
   - 在 `NUM` 注册表中增加 `gatewayTimeoutMs: 8000`。
2. **隐藏控件与默认值保障**：
   - 在 `settings.html` 中增加 `<input type="hidden" id="gatewayTimeoutMs" value="8000">`。
   - 在 `collect()` 与卡片保存逻辑中，确保无论用户点击单卡片保存还是底部保存，均将合法的数值（8000）持久化到 options。
3. **测试断言同步**：
   - 如实更新 `tests/settings_page_test.mjs` 与 `tests/verify_settings.mjs` 中的持久化断言。
