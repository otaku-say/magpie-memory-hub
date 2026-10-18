# Magpie 记忆中枢：模型完全可配置化与移除启发式回退技术方案 (NOTES_configurable_models.md)

**记录时间**：2026-10-18  
**工作目录**：`/var/minis/workspace/magpie-memory-hub/`  
**核心目标**：
1. **解除硬编码**：提炼模型与判定模型彻底改为由用户在设置项中自由指定，默认值完全留空，未配置时安全跳过并记录诊断日志，绝不偷用写死模型。
2. **端点自适应**：判定模型支持 `auto` / `systemone` / `chat` 三种端点模式，`auto` 模式优先探测 System One，失败或不支持时自动平滑回退至 Chat Completions，并带进程级端点缓存。
3. **彻底切断启发式回退**：移除网关钩子与录制扫描中「在线模型不可用时静默切回正则规则」的兜底逻辑，模型不可用时安全跳过，根除伪踩坑死灰复燃风险。
4. **真实健康检测**：提供真实调用与响应校验的模型检测函数，输出延迟与可读失败原因。

---

## 一、方案背景与用户要求

### 1.1 用户原始诉求
> 「**提炼模型、判定模型 都不要固定**，我需要在**插件设置中指定**，未来我可能用其他模型」

在之前的实现中，虽然引入了在线大模型判定与提炼（Model-in-the-Loop），但存在两大严重隐患：
1. **模型名称硬编码**：
   - 判定模型写死了 `options.classify_model || "group/clef"`；
   - 提炼模型写死了 `options.harvest_model || "group/gemini-3.5-flash-lite"`；
   - 判定端点写死了通过正则 `/clef|jev/i` 判定是否走 `/v1/systemone`，用户无法指定任意其他模型或自定义端点。
2. **静默启发式回退带来噪音回流**：
   - `gateway_harvest.hooks.js` 在模型未配置、网络超时或 5xx 异常时，通过 `if (!onlineProcessed && options.heuristic_fallback !== false)` 静默退回执行 `mineFailures` / `mineEnvironmentFacts` / `mineArchitecturalDecisions`。
   - 历史事实证明：那套启发式正则在复杂开发对话下会产生大量伪踩坑（20 分钟曾产生 288 条垃圾数据）。Fail-Open 的正确语义是**「安全跳过本次采集，绝不阻断正常业务」**，绝不是**「换一套会制造噪音的规则继续灌库」**！

---

## 二、配置项与默认值策略设计

### 2.1 `package.json` 中的 `magpie.options` 规范
在 `package.json` 的 `magpie.options` 中新增三个标准配置项：

| 配置项 | 类型 | 默认值 | 作用与说明 |
| :--- | :--- | :--- | :--- |
| `extract_model` | `string` | `""` (留空) | 结构化知识提炼模型。默认留空，设置页提示占位符如 `group/gemini-3.5-flash-lite`。 |
| `classify_model` | `string` | `""` (留空) | 前置会话价值判定模型。默认留空，设置页提示占位符如 `group/clef`。 |
| `classify_endpoint` | `string` | `"auto"` | 判定模型调用的接口端点：`"auto"`（自适应探测）、`"systemone"`（决策端点）、`"chat"`（对话端点）。 |

### 2.2 默认值与未配置时的行为契约
1. **默认留空**：`extract_model` 与 `classify_model` 默认为空字符串 `""`，绝不内置任何硬编码兜底模型名称。
2. **未配置时的行为**：
   - **提炼模型未配置 (`!extract_model`)**：
     - 网关钩子直接跳过提炼入库流程；
     - 记录诊断日志：`[memory-hub][diag] harvest_skipped: 未配置提炼模型 (extract_model 为空)，安全跳过本次采集`；
     - 绝不调用任何模型接口，也绝不回退至正则规则。
   - **判定模型未配置 (`!classify_model`)**：
     - 若提炼模型已配置但判定模型未配置，则跳过前置过滤（放行直接进入提炼，由提炼模型判断是否产出）；
     - 记录诊断日志：`[memory-hub][diag] classify_skipped: 未配置判定模型 (classify_model 为空)，跳过前置过滤`；
     - 绝不私自调用 `group/clef`。
3. **模型服务不可用时的行为**：
   - 当在线模型返回 HTTP 错误（如 401/404/500/502/503）或网络超时中断时：
   - 记录诊断日志：`[memory-hub][diag] online_harvest_unavailable: HTTP ${status} / 网络超时，安全跳过采集`；
   - 本次采集安全退出，新增入库数记为 0，**绝不回退至启发式正则**！

---

## 三、判定模型端点自适应机制设计 (`classify_endpoint`)

用户未来填写的判定模型既可能是极速决策模型（如 `clef`、`jev`），也可能是普通对话模型（如 `gpt-4o-mini`、`gemini-flash`、`qwen-turbo`）。

### 3.1 端点行为定义
- **`systemone`**：直接请求 `${baseUrl}/v1/systemone`，请求体为 `{ model, state, questions: { worth_remembering: { type: "noul", instructions: ... } } }`，解析 `answers.worth_remembering.noul` 得分。
- **`chat`**：直接请求 `${baseUrl}/v1/chat/completions`，发送专用判定 System Prompt，根据模型输出是否含 `YES` 返回 1.0 或 0.0。
- **`auto` (自适应与平滑探测)**：
  1. **进程级缓存优先**：维护 `classifyEndpointCache = new Map<string, "systemone" | "chat">()`。若当前模型已探测过，直接使用缓存端点（0 额外 RTT 开销）。
  2. **先试 System One**：以短超时（如 4000ms）向 `/v1/systemone` 发起探测请求；
  3. **成功判定**：若返回 HTTP 200 且包含有效的数字得分，将该模型记录为 `systemone` 并返回打分；
  4. **失败平滑回退**：若返回 400/404/405/422/501（说明该模型不支持 System One 或网关无此路由），记录诊断日志，并将请求无缝切换至 `/v1/chat/completions`。Chat 请求成功后将该模型记录为 `chat`；
  5. **网络/服务全挂**：若两个端点均无法连通，以 Fail-Open 诊断日志安全跳过。

### 3.2 为什么这样设计？
- **对用户完全透明**：用户无需关心模型属于哪种类型，只需填入模型名，系统自动探测并锁定正确通道。
- **性能与开销最优**：由于进程内只探测一次，后续对话轮次 0 探测成本；且决策模型无需生成 token，大幅节省网关资源。

---

## 四、彻底移除启发式回退与历史代码评估

### 4.1 回退切断点
1. **`gateway_harvest.hooks.js` (实时网关钩子)**：
   - 彻底删除第 734 行附近的 `if (!onlineProcessed && options.heuristic_fallback !== false) { facts = ... }` 块。
   - 当 `onlineProcessed` 为 false 或未配置时，直接返回 `{ memoriesSaved: 0, pitfallsSaved: 0, pendingSaved: 0, skipped: true }`。
2. **`gateway_harvest.js` (离线录制扫描)**：
   - 接入相同的在线提炼与模型配置逻辑；
   - 彻底删除第 1313 行附近的 `if (failures.length === 0 && facts.length === 0 && decisions.length === 0) { failures = mineFailures... }` 启发式回退。

### 4.2 全仓调用方分析 (`mineEnvironmentFacts` / `mineArchitecturalDecisions` / `mineFailures`)
通过 `rg` 全局搜索确认：
- **生产提炼链路**：已完全切断，不再被任何网关实时钩子或自动采集管线调用；
- **旧测试套件**：`tests/test_denoise_p0.mjs`、`tests/adversarial_verify.mjs`、`tests/test_quality_eval.mjs` 等历史单元测试文件中直接 import 了这些函数，并对历史正则边界进行断言。
- **决策结论**：为避免旧单元测试运行报错，保留 `gateway_harvest.js` 中的函数定义与 export 并标记为 `@deprecated`，但从所有实际提炼运行路径中彻底摘除。

---

## 五、真实模型连通性检测能力 (`testModelConnectivity`)

导出以下三个检测函数（位于 `gateway_harvest.hooks.js`）：
1. `testExtractionModel(options)`:
   - 真实向网关 `/v1/chat/completions` 发送带有标准提炼 Prompt 的对话文本；
   - 验证 HTTP 状态码 200、JSON 结构解析、耗时（latencyMs）；
   - 失败时返回包含具体 HTTP 错误或超时原因的可读字符串。
2. `testClassificationModel(options)`:
   - 根据 `classify_endpoint` 或 `auto` 探测真实调用 `/v1/systemone` 或 `/v1/chat/completions`；
   - 验证返回有效打分或 YES/NO，记录探测到的生效端点与延迟；
   - 失败时返回明确的错误原因。
3. `testModelConnectivity(type, options)`:
   - 统一入口，支持单独或批量检测。

---

## 六、跨代理协作清单（给设置页代理）
1. 在设置页 UI 中为 `extract_model` 提供文本输入框，占位符为 `group/gemini-3.5-flash-lite`；
2. 为 `classify_model` 提供文本输入框，占位符为 `group/clef`；
3. 为 `classify_endpoint` 提供下拉选择框，选项为 `auto`（自适应，推荐）、`systemone`（决策模型）、`chat`（对话模型）；
4. 在模型输入框旁增加「测试连通性」按钮，调用后端的测试接口获取真实运行状态与延迟反馈。
