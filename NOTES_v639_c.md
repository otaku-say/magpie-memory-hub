# v6.39-c 修复记录：_no_scheduler 隔离标记根治后台 drain 覆写宿主调度器配置

## 1. 任务背景与文件所有权原则
- **BUG-38-3（中危）**：后台队列非空时，`gateway_harvest.hooks.js` 中的 `getHub()` 会调用 `MagpieMemoryHub` 构造临时实例。由于 `tools.js:4115` 在 `MagpieMemoryHub` 内部无条件执行 `_auditOptionsGetter = optionsGetter;`，导致宿主全局 `_auditOptionsGetter` 被后台消费时的临时配置快照覆写。后续宿主在修改 `dedup_time`、`project` 等配置时，读取到的依然是后台消费时的临时配置快照。
- **历史方案局限**：上一轮方案通过"探测并继承活跃排期再传"仅防止了误调用 `stopAuditScheduler()`，但无法阻断全局 getter 闭包被新临时实例覆写。
- **文件所有权遵守**：
  - 修改文件：
    - `tools.js`：MagpieMemoryHub 入口区（约 4100-4130 行）+ 调度器管理区（约 3570-3650 行）
    - `gateway_harvest.hooks.js`：getHub（约 1224-1270 行）
  - 新增文件：
    - `NOTES_v639_c.md`
    - `tests/test_v639_c_nosched.mjs`
  - **严禁修改**：saveMemory / pitfallSave / checkAndApplyIronlaw / isPlaceholderRootCause / memoryGet / memoryList / memoryContext / memorySearch / pitfallSearch / semantic_dedup.js / test_meta.mjs。

---

## 2. 根因深度剖析

### BUG-38-3：后台 drain 构造临时 hub 覆写宿主全局 `_auditOptionsGetter`
1. **覆写路径**：
   - 当异步队列中有待消费项时，`triggerBackgroundDrain` 中的 `callSaveMemory` / `callPitfallSave` 调用 `getHub()`。
   - `getHub()` 未复用已有 hub 时，执行 `await MagpieMemoryHub(hubInput, hubOpts)` 构造临时实例。
   - `MagpieMemoryHub` 内部无条件执行：
     ```js
     const optionsGetter = () => readOptions(Object.assign({}, input, options));
     _auditOptionsGetter = optionsGetter;
     if (cfg) _auditBaseCfg = cfg;
     if (client) _auditBaseClient = client;
     ```
   - 该操作直接将模块级全局变量 `_auditOptionsGetter` 覆盖为捕获了本次临时调用参数的闭包。
2. **不良后果**：
   - 宿主随后若动态更新自身配置（例如修改 `dedup_schedule`、`dedup_time` 或切换 `project`），调用 `ensureAuditScheduler().getFreshCfg()` 将无法感知最新配置，始终读取被后台消费冻结的旧快照。

---

## 3. 根治方案设计

### 3.1 引入 `_no_scheduler: true` 隔离标记
在 `tools.js` 的 `MagpieMemoryHub` 入口解析隔离标记：
```js
const noScheduler = (options && options._no_scheduler === true) || (input && input._no_scheduler === true);
```
当 `noScheduler === true` 时：
- **跳过整个调度器生命周期管理**：
  - 不调用 `ensureAuditScheduler`
  - 不调用 `stopAuditScheduler`
  - **绝不赋值 `_auditOptionsGetter`**
  - 不修改 `_auditBaseCfg` 与 `_auditBaseClient`
- **保留完整工具能力**：
  - 构造并返回完整 `tool` 映射（包含 `memory_save`、`pitfall_save` 等），供后台 drain 安全调用。

### 3.2 `ensureAuditScheduler` 调度器管理区防御与单参兼容
在 `tools.js` 的 `ensureAuditScheduler(client, cfg, optionsGetter)` 中：
1. 兼容单参数调用 `ensureAuditScheduler({ dedup_schedule: "daily" })`（当第一个参数非客户端实例时自动作为 cfg 处理）；
2. 增加对 `_no_scheduler` 的防御短路：若传入配置包含 `_no_scheduler === true`，直接返回当前状态快照，不修改任何内部引用与全局 getter。

### 3.3 `gateway_harvest.hooks.js` 临时 Hub 构造透传隔离标记
在 `gateway_harvest.hooks.js` 的 `getHub()` 中构造临时实例时：
```js
const hubOpts = {
  ...activeCfg,
  ...(options && typeof options === "object" ? options : {}),
  _client: safeClient,
  _cfg: activeCfg,
  _no_scheduler: true,
};
const hubInput = {
  ...activeCfg,
  _no_scheduler: true,
};
```
彻底阻断后台消费创建临时 Hub 对宿主调度器配置造成的任何副作用。

---

## 4. 双向反证测试矩阵 (`tests/test_v639_c_nosched.mjs`)
1. **反证门 a（宿主配置防覆写与防误停）**：
   - 先通过 `ensureAuditScheduler({ dedup_schedule: "daily" })` 启动宿主调度器，记录 `getFreshCfg().dedup_schedule === "daily"`；
   - 构造 `_no_scheduler: true` 的 hub（模拟 drain 临时实例）；
   - 反证断言：`getFreshCfg().dedup_schedule` 依然为 `"daily"`（未被覆写为 off 或其他值），`started` 依然为 `true`。
2. **反证门 b（临时 Hub 工具功能完整可用）**：
   - 验证 `_no_scheduler: true` 构造的实例拥有完整的 `tool["memory_save"]` 与 `tool["pitfall_save"]`，且能正常执行写库/入库操作。
3. **反证门 c（主路径无回归）**：
   - 不传 `_no_scheduler` 时，正常的调度器生命周期管理与配置覆盖行为 100% 保持原有行为不变。
4. **反证门 d（真实 Drain 链路宿主 Getter 防覆写）**：
   - 宿主提供动态更新的 `liveGetter`；
   - 填充队列项并触发真实 `triggerBackgroundDrain`；
   - 消费完成后动态变更宿主配置（如 `dedup_time: "04:30"`, `project: "updated_p"`）；
   - 反证断言：`getFreshCfg()` 能即时感知变更，宿主 getter 绝未被后台临时实例覆写。
5. **规范合规**：
   - 执行 `scanTestFile` 元检查自检；
   - 遵守命名空间隔离与清理逻辑，测试后残余记录数恒为 0 (`residue === 0`)。
