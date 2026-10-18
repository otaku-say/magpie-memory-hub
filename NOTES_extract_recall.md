# NOTES_extract_recall.md —— 自动采集真实对话召回率诊断与修复全记录

## 1. 问题背景与定性
用户环境：Magpie v0.1.1279 + 插件 v6.14.1，开启 `auto_harvest=true`、`gatewayTimeoutMs=8000`。
日志显式证明：
```
[memory-hub][hook] onRequest 已被调用 | auto_harvest=true | options 键数=32 | gatewayTimeoutMs=8000
[memory-hub][diag] pipeline: client=有 memoriesSaved=0 pitfallsSaved=0 pending=0 queue=0
[memory-hub][diag] drain: {"processed":0,"memoriesSaved":0,"pitfallsSaved":0}
```
经过排除排他锁、超时、client 为空、库名映射等工程问题后，确认根因在于提炼抽取阶段：
`processDialogueAndHarvest` 被正常调用，但提炼产出为 0 条。
前期过度加固引入了两个极端限制：
1. 激进的代码块粗暴全量剥离（`stripCodeBlocks` 将全部 ```...``` 与 ~~~...~~~ 替换为空字符串），导致技术对话中包含的真实报错信息（如 ModuleNotFoundError / EADDRINUSE）和处置命令行（如 pip install / kill）被彻底抹杀，造成「带代码块技术对话产出 0 条」、「含报错+解法产出 0 条」；
2. 提取正则过于窄化僵硬，只识别特定书面陈述句（如「不要使用 A，必须统一使用 B」），对真实中文技术对话中常见的正序/倒序口语表达（如「跑测试统一用 vitest」、「统一改用 pnpm，别再用 npm 了」）完全脱靶。

---

## 2. 真实对话回放与深度诊断表（8 类场景）

我们构造了 8 段高度贴近真实技术对话的回放样本，逐段记录产出条数与 filter 拦截原因：

| 用例编号 | 对话场景分类 | 典型对话内容 | 修复前产出条数 | 修复前拦截卡点分析 | 修复后产出条数 | 修复后提取内容摘要 |
| :--- | :--- | :--- | :---: | :--- | :---: | :--- |
| **场景 1** | 用户明确偏好/规范（带代码块与口语） | 用户：「我们团队约定好了，以后所有包管理统一改用 pnpm，别再用 npm 或 yarn 了。跑测试统一用 vitest。」<br>助手：「收到！后续我会严格使用 pnpm 和 vitest。请确保本地安装了 pnpm：\n```bash\nnpm i -g pnpm\n```」 | **0 条** | 1. 现有 toolPatterns 要求「先否定后肯定」，不支持「统一改用 X，别再用 Y 了」反向语序；<br>2. 现有 directToolRe 语序为「统一用 X 运行测试」，不支持倒序「跑测试统一用 X」。 | **3 条** (memories=3) | 1. 工具规范: pnpm 代替 npm<br>2. 工具规范: 包管理采用 pnpm<br>3. 工具规范: 跑测试采用 vitest |
| **场景 2** | 架构决策（技术选型与目录约定） | 用户：「架构上我们团队决定采用 Fastify 替换 Express 作为后端核心框架，所有路由中间件统一存放在 src/middlewares 目录中。」<br>助手：「很好的决策...已记录架构选型：Fastify，中间件目录：src/middlewares。」 | 1 条 (选型) / 目录规范 **0 条** | 现有 dirConvRe 强制要求前缀 `(?:代码目录\|目录结构\|模块存放\|文件规范)[：:\s]*`，普通自然对话中用户直接陈述「所有路由中间件统一存放在...」被正则漏检。 | **2 条** (memories=2) | 1. 选型决策: 采用 Fastify 替换 Express<br>2. 目录规范: 路由中间件 存放在 src/middlewares/ |
| **场景 3** | 真实报错后给解法（代码块报错+命令修复） | 用户：「运行测试失败了，报错如下：\n```\nModuleNotFoundError: No module named 'pytest_asyncio'\n```\n怎么处理？」<br>助手：「这是因为缺少 pytest-asyncio 依赖包。你可以运行以下命令安装：\n```bash\npip install pytest-asyncio\n```\n安装完成后重新运行测试：\n```bash\npytest tests/\n```\n运行结果：3 passed in 0.12s，已成功解决。」 | **0 条** | **过度过滤**：`stripCodeBlocks` 把代码块内容全部替换为空，导致 `ModuleNotFoundError` 报错行与 `pip install pytest-asyncio` 解法命令全部消失，`mineFailures` 无输入行。 | **3 条** (memories=2, pitfalls=1) | 1. 踩坑: ModuleNotFoundError -> pip install pytest-asyncio<br>2. 事实: 可用测试命令 `pytest`<br>3. 事实: 可用测试命令 `pytest tests/` |
| **场景 4** | 纯技术讨论（React 原理探讨，不含具体规范） | 用户：「你能解释一下 React 18 的并发渲染（Concurrent Mode）和 Fiber 架构的底层工作原理吗？」<br>助手：「React Fiber 是一种基于链表的数据结构...」 | **0 条** | 纯原理探讨，无命令、无规范、无报错。正常不产出（符合预期）。 | **0 条** | 保持 0 条，杜绝伪概念噪音 |
| **场景 5** | 代码块为主（编写具体业务代码） | 用户：「帮我用 TypeScript 写一个带 immediate 参数的防抖函数 debounce。」<br>助手：「这是防抖函数的实现：\n```typescript\nexport function debounce...```」 | **0 条** | 业务代码块（`typescript`）整块被安全剥离，不产生任何误判（符合预期）。 | **0 条** | 保持 0 条，杜绝源码语法噪音 |
| **场景 6** | 闲聊 | 用户：「今天周五了，感觉工作做完了好轻松啊！」<br>助手：「祝贺！周末好好放松一下，祝你周末愉快！」 | **0 条** | 无技术实体与规范，正常不产出（符合预期）。 | **0 条** | 保持 0 条 |
| **场景 7** | 用户口语化指定偏好规范（含「记住，」提示） | 用户：「记住，以后写 Python 必须使用 python3，不要用 python2，并且统一用 ruff 格式化代码。」<br>助手：「好的，我已经记住了：Python 环境使用 python3，代码格式化统一使用 ruff。」 | **0 条** | 1. `isExplicitUserMemory` 只认冒号/空格，用户输入「记住，」带中文逗号被判定为非显式；<br>2. 任务倒序「代码格式化统一用 ruff」未被旧正则覆盖。 | **3 条** (memories=3) | 1. 工具规范: python3 代替 python2<br>2. 工具规范: 采用 ruff<br>3. 工具规范: 代码格式化采用 ruff |
| **场景 8** | 端口冲突排查与服务启动报错（实际排查流程） | 用户：「启动开发服务器失败了：\n```\nError: listen EADDRINUSE: address already in use :::3000\n```\n帮我解决一下。」<br>助手：「3000 端口被占用了。你可以用以下命令干掉占用进程并重新启动：\n```bash\nkill -9 $(lsof -t -i:3000)\nnpm run dev\n```\n执行后服务正常启动，resolved。」 | **0 条** | **过度过滤**：`stripCodeBlocks` 剥空了代码块，导致 `address already in use` 报错与 `kill -9` 解法命令全部丢失。 | **1 条** (pitfalls=1) | 1. 踩坑: EADDRINUSE: address already in use :::3000 -> kill -9 $(lsof -t -i:3000) |

---

## 3. 散文结论与代码块剥离机理查清

关于 `buildDialogueText` 与代码块剥离后文本的实测查清：
1. `buildDialogueText` 提取了最后一轮 `[user]: ...` 与本次回复 `[assistant]: ...`。
2. 助手的**散文结论**（例如「这是因为缺少依赖...已成功解决 (resolved)」）确实完整保留在 `buildDialogueText` 输出中。
3. **但致命的是代码块剥离环节**：
   在旧版 `stripCodeBlocks` 逻辑中：
   ```javascript
   text.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
   ```
   喂入真实对话后，实际留存的文本变成了：
   ```
   [user]: 运行测试失败了，报错如下：

   怎么处理？

   [assistant]: 这是因为缺少 pytest-asyncio 依赖包。你可以运行以下命令安装：

   安装完成后重新运行测试：

   运行结果：3 passed in 0.12s，已成功解决。
   ```
   可以看到：用户的**报错堆栈被全盘抹杀**，助手的**解法命令被整块吃空**！
   `mineFailures` 随后执行正则扫描时，根本找不到任何可匹配的报错特征，也找不到任何可执行命令，最终造成了真实开发对话下采集产出恒为 0！

---

## 4. 修复方案与安全红线防守机制

### 改动点 1：修正过度过滤 —— 代码块按语言分流与精准提取
- **纯源码语言黑名单（彻底剥离）**：
  `SOURCE_CODE_LANGS` 包含 `js, ts, python, zig, rust, go, c, cpp, java, json, yaml, toml, html, css, sql, diff` 等。
  这些代码块中的内容**100% 剥离**，绝不放过任何源码声明、return 或 diff 行。这直接守住了噪音 1（正则代码块）、噪音 2（Zig 源码与 diff）、噪音 3（JSON 属性回显）和场景 5（TypeScript 业务代码）。
- **Shell / 终端交互代码块（保留有效命令行）**：
  `SHELL_LANGS` 包含 `bash, sh, shell, zsh, console, terminal, cmd, powershell`。
  去掉命令行提示符（`$`, `#`, `>`），逐行提取符合 `isLikelyCommandLine`、`ACTION_CMD_RE` 或 `OK_PATTERNS` 的命令行与执行结果，排除源码噪音行与注释行。
- **Output / Log / 无语言标记代码块（提取真实报错与命令）**：
  逐行扫描：
  - 遇到 `isCodeOrSyntaxNoise`（源码声明、JSON 属性、return 等）：**坚决丢弃**；
  - 遇到 `FAIL_PATTERNS` 真实报错行（ModuleNotFoundError, EADDRINUSE 等）：**保留**；
  - 遇到命令行或 `OK_PATTERNS` 成功状态：**保留**；
  - 遇到其他无特征文本：丢弃。

### 改动点 2：放宽偏好与规范抽取句式（支持自然正序与倒序）
1. **`toolPatterns` 模式 A/B 兼容**：
   放宽前后置语序，支持「统一改用 pnpm，别再用 npm 了」与「必须使用 python3，不要用 python2」；支持中文标点与助词。
   添加上下文防重复判定：若前序文本明确包含「架构选型/技术选型/架构决策」，由 `mineArchitecturalDecisions` 专属处理，不重复计入环境工具事实。
2. **倒序任务与工具规范**：
   新增 `taskToolRe`，支持「跑测试统一用 vitest」、「包管理统一改用 pnpm」、「代码格式化统一用 ruff」等高频真实口语模式。
3. **自然陈述目录规范与选型决策**：
   `mineArchitecturalDecisions` 新增自然陈述目录规范 `directDirRe`（支持「所有路由中间件统一存放在 src/middlewares 目录中」）与替换选型支持。
4. **显式意图标点支持**：
   `isExplicitUserMemory` 正则放宽分隔符，增加中文逗号支持（`[:：,，\s]`），支持用户输入「记住，...」。

### 为什么这样改绝不会让「20 分钟 288 条伪踩坑」噪音回归？
1. **源码块继续 100% 隔离**：造成 288 条伪踩坑的主凶是 Zig 源码里的 `return fail(error.AccessDenied)`、JS 里的正则声明以及 JSON 属性回显。这些在 `SOURCE_CODE_LANGS` 机制下整块丢弃，源码绝不可能泄漏到抽取层。
2. **多重过滤器层层把关**：即使在未标记语言的代码块中，依然有 `isCodeOrSyntaxNoise`、`isDocumentationOrScaffolding`、`isGenericToolInvocation` 以及 `isCommandRetryCompatible` 重重过滤。
3. **门禁与双轨制依然生效**：普通踩坑依然遵守 `min_evidence_pitfall=3` 累积门禁，单次伪报错绝不落盘；入库存储字段与指纹计算严格分离。
4. **5 类真实噪音样本回归全绿**：`tests/test_gateway_harvest_hooks.mjs` 中的 Test 7 保持 5 类真实噪音产出均为 0 的断言。

---

## 5. 自动化测试执行结果

本改动已通过全部全套加固测试套件：
1. `node tests/test_gateway_harvest_hooks.mjs`：11 项保真度与严谨性测试 100% 通过（含 5 类真实噪音拦截断言与反证真故障提炼）。
2. `node tests/test_denoise_p0.mjs`：11 项 Headroom 专项测试 100% 通过（门禁、双轨制、淘汰机制、隔离性）。
3. `node tests/test_meta.mjs`：31 个测试文件元检查全绿，0 处违规。
4. `node tests/test_pollution_guard.mjs`：动态执行全套 30 个测试，生产库零污染确认（dm=0, dp=0）。
5. `node tests/check_schema_sync.mjs`：字段声明与代码写入完全对齐，版本号严格同步。
6. `node ./diagnose_recall.mjs`：8 类真实技术对话场景全部符合预期。
