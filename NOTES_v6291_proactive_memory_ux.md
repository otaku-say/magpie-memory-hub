# 记忆中枢主动查存、一站式检索、安全脱敏与超时兜底整改检查点报告

## 1. 任务背景与执行环境
- **任务代号**: feat/v6291-proactive-memory-ux
- **执行角色**: Agent 2 (主动记忆与检索增强)
- **沙箱 ID**: `7561fceb4f414daf8565c56d35f12227`
- **沙箱工作路径**: `/workspace/magpie-memory-hub`
- **当前分支**: `feat/v6291-proactive-memory-ux`
- **运行时环境**: Node.js `v24.18.1` (Linux aarch64)

---

## 2. 核心整改清单与落地实现

### 1) 动态嗅探真实工具名 + 意图感知引导 (`memory.middleware.js`)
- **动态工具名嗅探 (`sniffToolNames`)**:
  - 从 `body.tools` / `body.functions` 动态检测符合 `/memory_save$/`, `/pitfall_save$/`, `/memory_context$/`, `/memory_search$/`, `/pitfall_search$/` 的真实工具名，全面兼容客户端前缀（如 `mcp__magpie__...`、`custom_agent_...`）或直接工具名；
  - 嗅探不到时安全回退至标准插件注册名（`magpie-memory-hub_...`）。
- **意图感知引导注入 (`[Memory Agent Guide]`)**:
  - **排障意图** (`/Error:|Exception|Traceback|panic:|ENOENT|ECONN|报错|失败|不生效|踩坑|异常|bug/i`):
    - 注入 `[Memory Agent Guide —— 排障与避坑]`；
    - 强化【先查避坑】（引导主动调用 `pitfall_search` 或 `memory_context`）+【修复必存 pitfall_save】（问题解决后必存踩坑）。
  - **规范意图** (`/记住|以后都|不要再|严禁|禁止|必须用|统一用|默认配置|架构原则|铁律/`):
    - 注入 `[Memory Agent Guide —— 规范与准则沉淀]`；
    - 强化【立即调用 memory_save(category="principle")】持久化规范，并提供一站式召回入口。
  - **首轮与严格模式** (`turnNo <= 1` 或 `extract_strength === "strict"`):
    - 注入完整 `[Memory Agent Guide —— 检索与沉淀]`，包含【优先检索】+【及时沉淀】。
  - **普通软模式**:
    - 注入常规轻量指引，并能被 `cleanText` 彻底清洗，杜绝跨轮次污染。

### 2) 一站式召回入口升级 (`tools.js` - `memory_context`)
- **避坑经验融入**:
  - 检索 `pitfalls` 表，将匹配到的 Top 3 踩坑记录以 `- [pitfall/组件] 症状 → 解法` 格式拼入 `[Persistent Memory Context]`；
- **跨项目准则穿透合并**:
  - 当指定了非 "global" 的 project 时，自动合并当前 project 与 "global" 下的 principle 准则，优先排列当前项目准则，全局准则兜底，彻底杜绝全局规范在子项目中丢失；
- **入口描述更新**:
  - `TOOLS.memory_context.description` 更新为推荐的首选一站式检索入口描述。

### 3) 写入门槛放宽与 `_agent_hint` 闭环引导 (`tools.js`)
- **参数放宽**:
  - `TOOLS.pitfall_save.args.required` 放宽为 `["symptom", "solution"]`；
  - `pitfallSave` 内部对缺失的 `component` 默认设为 `"general"`，缺失的 `root_cause` 默认设为 `symptom`，极大降低 Agent 报错时的记录成本；
- **Schema 瘦身**:
  - 从 `TOOLS.memory_save.args.properties` 中隐藏内部专属参数（`origin`, `source_session`, `source_turn`, `content_fingerprint`），对外 Schema 保持轻量；
- **闭环引导 (`_agent_hint`)**:
  - 在 `memorySearch`、`memoryContext`、`pitfallSearch` 的 JSON 响应中统一追加 `_agent_hint: "若本次任务产出了新结论、配置变更或排障解法，请在结束前调用 memory_save 或 pitfall_save 沉淀。"`。

### 4) 跨项目全局穿透检索支持 (`tools.js`)
- 在 `memorySearch`、`memoryContext`、`pitfallSearch` 中，当 `args.project` 非 "global" 时，支持检索 `project IN (args.project, 'global')`；
- 排序与呈现严格遵守「当前项目专属优先，全局准则/避坑兜底」，既不遗漏全局沉淀，又优先匹配当前项目专属上下文。

### 5) 入库前敏感凭据自动脱敏 (`tools.js` & `gateway_harvest.hooks.js`)
- 实现轻量正则脱敏函数 `scrubSecrets(text)`：
  - 自动过滤 `sk-...` 为 `sk-***REDACTED***`；
  - 自动过滤 `ghp_...`（及 gho/ghu/ghs/ghr）为 `ghp_***REDACTED***`；
  - 自动过滤 `Bearer ...` 为 `Bearer ***REDACTED***`；
  - 自动过滤 `scheme://user:password@host` 数据库连接串密码为 `***REDACTED***`；
  - 自动过滤 key-value 中的 `password / api_key` 等敏感字段；
- 在 `saveMemory`、`pitfallSave` 以及 `enqueueHarvestItems` 入口处执行强制脱敏，确保敏感凭据绝不落库、绝不上报。

### 6) 默认网络超时兜底 (`mcp_client.js` & `ncb_mcp.js` & `tools.js`)
- `ncb_mcp.js` 的 `DEFAULT_TIMEOUT` 调整为 `15000` (15s)；
- `ncb_mcp.js` 与 `tools.js` 的 `fetch` 调用均使用 `signal: effectiveSignal || AbortSignal.timeout(15000)`，彻底杜绝挂死。

---

## 3. 测试与验证实录

### 3.1 专项单测 (`tests/test_proactive_memory_ux.mjs`)
编写并执行了 6 大维度全覆盖的单元测试，包含：
1. `memory.middleware.js` 动态前缀工具名嗅探（`mcp__magpie__...`、`custom_agent_...`）；
2. 排障意图感知、规范原则意图感知、首轮完整引导注入断言；
3. `TOOLS.memory_context.description` 描述校验；
4. `TOOLS.pitfall_save` 放宽参数入库与自动兜底校验；
5. `_agent_hint` 在三大检索接口中的闭环返回校验；
6. `memory_context` 一站式召回（Top 3 避坑经验 + 全局与项目准则合并 + 事实记忆）；
7. `memory_search` 跨项目全局穿透与专属优先排序校验；
8. `scrubSecrets` 正则脱敏在 `memory_save` 与 `pitfall_save` 的入库脱敏校验；
9. `NcbMcp` 15000ms 默认超时与 AbortError 干净中断校验；
10. 测试环境 cleanup 与残余为 0 校验。

**执行结果**: 全部通过（6 大项全部 PASS）。

### 3.2 规范与门禁验证
1. **导出面合规 (`tests/test_exports.mjs`)**:
   - `tools.js` 与 `memory.middleware.js` 导出严格符合白名单，无多余未授权导出，100% PASS。
2. **静态工具名断言 (`tests/test_tool_names_static.mjs`)**:
   - 所有在代码中出现的工具标识符均为已注册工具或合法白名单符号，100% PASS。
3. **架构同步与模式校验 (`tests/check_schema_sync.mjs`, `tests/test_schema.mjs`)**:
   - 表结构声明与代码写入字段严格对齐，100% PASS。
4. **中断与退出安全 (`tests/test_abort.mjs`)**:
   - `ctx.abort` 中断与超时拦截正常，100% PASS。
5. **网关异步采集与流式保真 (`tests/test_gateway_harvest_hooks.mjs`)**:
   - 11 项全功能与逐字节保真测试，100% PASS。
6. **红队靶场门禁 (`tests/adversarial_v629_gate.mjs`)**:
   - 6 大核心缺陷反证靶场全部 GREEN 放行。
7. **测试元规范审查 (`tests/test_meta.mjs`)**:
   - 全库 45 个测试文件静态合规审查，无 DB 泄露、无假过，100% PASS。

---

## 4. 安全合规保证
- 代码库及测试用例中严禁硬编码任何真实密钥或敏感凭据；
- 所有敏感凭据在入库前均经过 `scrubSecrets` 正则脱敏；
- 测试用例使用内存 Mock 桩与隔离命名空间，测试结束后残留确认为 0。
