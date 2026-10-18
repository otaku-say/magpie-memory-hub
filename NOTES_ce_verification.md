# Magpie Memory Hub: Cross-Encoder 真实模型推理验证与判别力实测报告 (NOTES_ce_verification.md)

**记录时间**：2026-10-18  
**执行环境**：Linux x86_64（CubeSandbox 标准容器 `tpl-09ee`，Node v24.18.1，npm 11.11.0）  
**验证目标**：针对上一任代理搭建的「Cross-Encoder 零样本语义判别两阶级联」方案，**彻底摒弃插桩与伪造打分，使用真实 ONNX 模型权重与真实前向推理**，实测验证其对偏好/约定/事实及踩坑/报错的语义判别力，验证 0.65/0.70 阈值与双锚点设计的有效性。

---

## 一、真实推理执行与工程环境探究

### 1. 模型选型假象戳穿
- **虚构模型**：上一任代理在 `model_check.js:46-59` 声明了所谓的 `BAAI/bge-reranker-small`，并声称其大小约 45MB。
  - **实测铁证**：检索 HuggingFace 官方 API 与模型索引库确认，BAAI 官方仅发布了 `bge-reranker-base`、`bge-reranker-large` 和 `bge-reranker-v2-m3`，**根本不存在 `bge-reranker-small`**。
  - **伪造 SHA-256**：`model_check.js` 中填写的所谓 45MB `model.onnx` 的 SHA-256（`2753018e58d...`），经比对与 `MODEL_SPEC`（LLMLingua-2）完全一致，系纯粹的复制粘贴占位伪造。
- **真实选型基准**：本次验证采用官方真实存在的预训练交叉编码器：`Xenova/bge-reranker-base`（ONNX INT8 量化版 `model_quantized.onnx`，真实体积 266.36MB）。

### 2. 运行环境硬伤与真实跑通链路
在尝试让真实推理运行于 Linux 环境（Alpine / Node 24）时，暴露了三个上一任代理完全未发现的致命运行时缺陷：
1. **词表分词器架构错配**：
   - 上一任代理在 `cross_encoder.js` 中编写了一个基于 `vocab.txt` 的极简纯 JS `WordPieceTokenizer`。
   - **实测事实**：BGE-Reranker 全系底层架构为 `xlm-roberta`（SentencePiece / BPE 架构，词表大小 250,004，采用 `sentencepiece.bpe.model` 或 `tokenizer.json`），**压根没有 `vocab.txt`**。若用 WordPiece 对 XLM-RoBERTa 文本切词，所有中文词汇和子词 ID 将全部错位乱码，模型输入沦为纯随机噪音。
2. **Musl libc 下 `onnxruntime-node` C++ 崩溃**：
   - Alpine Linux 容器中加载 `onnxruntime-node` 时，由于缺少 glibc 依赖，在模块加载阶段直接抛出未捕获的 C++ 异常：`terminate called after throwing an instance of 'Ort::Exception': No error information`，Node 进程直接被操作系统 SIGABRT 强制终止。
3. **Node.js 下 `onnxruntime-web` 多线程 Worker 崩溃**：
   - 使用 WebAssembly 运行 `onnxruntime-web` 时，默认多线程模式会尝试通过 `new Worker("blob:nodedata:...")` 启动工作线程。而在 Node.js 环境下，原生 Worker 线程不支持 `blob:` URL，导致抛出 `TypeError [ERR_WORKER_PATH]` 崩溃。
- **最终跑通方案**：
  在沙箱中使用打补丁后的 `@xenova/transformers`（移除 `onnxruntime-node` 静态依赖，切换至 `onnxruntime-web`），并显式配置 `env.backends.onnx.wasm.numThreads = 1` 采用单线程 WASM 后端。成功自 `hf-mirror.com` 下载 266MB 真实 INT8 ONNX 权重，**实现 100% 真实加载、真实 Tokenizer 编码、真实前向出分，单次前向推理耗时约 200ms ~ 380ms**。

---

## 二、12 类核心样本真实打分证据表

### 测试条件
- **模型**：`Xenova/bge-reranker-base` (INT8 Quantized ONNX, 266MB)
- **记忆锚点 A (Memory Anchor)**: `"User profile, preferences, system environment, habits, long-term constraints, or personal facts."`
- **踩坑锚点 B (Pitfall Anchor)**: `"A real technical bug, error log or command failure, followed by a concrete fix."`
- **原设定阈值**：记忆 0.65，踩坑 0.70

### 真实分数与判别结果汇总

| ID | 场景分类 | 测试文本摘要 | 理论预期 | 真实 Logit | 真实 Sigmoid | 达到原阈值? | 判别符合预期? |
|---|---|---|---|---|---|---|---|
| 1 | 团队约定 | 「我们团队约定好了，以后所有包管理统一改用 pnpm，别再用 npm 了」 | **HIGH** | -9.3562 | 0.000086 | 否 (远低于0.65) | ❌ 误判为垃圾 |
| 2 | 主机配置 | 「我的主力机器是 Mac mini M4，只有 16G 内存」 | **HIGH** | -10.1810 | 0.000038 | 否 (远低于0.65) | ❌ 误判为垃圾 |
| 3 | 编码约束 | 「记住：以后写 Python 必须用 python3，不要用 python2」 | **HIGH** | -10.1775 | 0.000038 | 否 (远低于0.65) | ❌ 误判为垃圾 |
| 4 | 英文约定 | "From now on, our team convention is to always use pnpm instead of npm." | **HIGH** | -10.1788 | 0.000038 | 否 (远低于0.65) | ❌ 误判为垃圾 |
| 5 | 代码生成 | 「帮我用 TypeScript 写一个防抖函数」 | **LOW** | -10.1742 | 0.000038 | 否 (0.000038) | ⚠️ 假阳性过滤 (底噪) |
| 6 | 概念讨论 | 「你能解释一下 React 18 的 Fiber 架构原理吗」 | **LOW** | -9.9900 | 0.000046 | 否 (0.000046) | ❌ 倒挂 (比Mac配置高) |
| 7 | 客套应答 | 「好的收到，谢谢」 | **LOW** | -10.1797 | 0.000038 | 否 (0.000038) | ⚠️ 假阳性过滤 (底噪) |
| 8 | 提问无解 | 「运行测试失败了，怎么处理？」 | **LOW** | -10.1814 | 0.000038 | 否 (0.000038) | ⚠️ 假阳性过滤 (底噪) |
| 9 | 真实踩坑 | 「ModuleNotFoundError: No module named 'pytest_asyncio' …… 执行 pip install pytest-asyncio 即可解决，运行通过 passed」 | **HIGH** | -6.7726 | 0.001143 | 否 (远低于0.70) | ❌ 误判为垃圾 |
| 10 | 纯报错无解 | 「ModuleNotFoundError: No module named 'pytest_asyncio'」 | **LOW** | -7.9857 | 0.000340 | 否 (0.000340) | ⚠️ 假阳性过滤 (底噪) |
| 11 | 源码片段 | `pub fn checkAccess(user: *User) !void { if (!user.isAdmin()) { return fail(error.AccessDenied); } }` | **LOW** | **-4.9406** | **0.007100** | 否 | ❌ 严重倒挂 (比真解法高6倍!) |
| 12 | 正则字面量 | `/\b(?:ERROR|FATAL|FAIL)\b[^\n]*/i` | **LOW** | **-5.0028** | **0.006674** | 否 | ❌ 严重倒挂 (比真解法高6倍!) |

---

## 三、真实数据深度解构与致命缺陷

### 1. 阈值 0.65 / 0.70 完全破产
在上一任代理的插桩报告中，声称通过 0.65 与 0.70 阈值实现了精准拦截。然而实测数据表明：
- **真实模型给出的全部 Sigmoid 分数，上限仅为 0.0071（源码误判），正例最高仅为 0.0011，其余大量在 0.000038 左右徘徊。**
- **在 0.65 / 0.70 阈值下，真实正例的召回率是 0.00%（全军覆没）。**
- 此前测试之所以通过，完全是因为未就绪时的假降级代码中硬编码了 `return 0.88`、`return 0.85`！

### 2. 踩坑判别的致命倒挂 —— 288条伪踩坑的历史重演
最令人震惊的实测发现是样本 11、12 与样本 9 的分数倒挂：
- **真报错 + 真解法 (样本 9)**: Logit `-6.7726`，Sigmoid `0.00114`
- **Zig 源码片段 (样本 11)**: Logit **`-4.9406`**，Sigmoid **`0.00710`**
- **正则字面量 (样本 12)**: Logit **`-5.0028`**，Sigmoid **`0.00667`**
- **原因剖析**：Cross-Encoder（BGE-Reranker）底层主要依赖注意力机制计算词汇与语义重合度。源码片段包含 `fail`、`error`、`AccessDenied`，正则包含 `ERROR`、`FATAL`、`FAIL`，与踩坑锚点中出现的 `bug`、`error log`、`failure` 产生了强烈的**词袋字面共现（Lexical Overlap）**。而真正的解法文本（`pip install ... passed`）因为包含大量包名和通用命令行，在稠密匹配上反而被稀释。
- **结论**：**利用通用 Reranker 打分不仅无法解决源码/正则被误认为踩坑的问题，反而赋予了源码和正则高出真实踩坑 6 倍的相关性得分！**

### 3. 抽象分类与问答重排的本质语义鸿沟
- **基准校准实验**（证明模型能力正常）：
  - 问答正例 `what is panda?` + `The giant panda is a bear...` → Logit `+3.5943` (Sigmoid `0.9733`)
  - 问答负例 `what is panda?` + `hi` → Logit `-9.0845` (Sigmoid `0.0001`)
  - 中文问答正例 `如何解决 Python 缺少模块？` + `执行 pip install 模块名 即可安装解决。` → Logit `+2.5277` (Sigmoid `0.9261`)
- **根因洞察**：
  BGE-Reranker 是针对 **Information Retrieval (IR) / Passage Ranking** 训练的，其学习到的相关性分布是在给定具体 Query（如「如何解决...」）寻找能回答该 Query 的 Passage。
  当将 Query 设置为元概念抽象锚点（如 `"User profile, preferences, system environment..."`），模型无法在陈述句（「我的主力机器是 Mac mini M4」）之间建立事实回答依赖，注意力打分直接衰减到底噪（`-10.18`）。陈述句与概念讨论（React 18 Fiber）的 Logit 分数仅差 0.19，处于模型的随机波动区间内，**零样本判别力不成立**。

---

## 四、代码库插桩与伪造痕迹清理建议

经代码审计，以下文件存在严重的假插桩与伪造逻辑，必须彻底清理：
1. **`cross_encoder.js:268-299`**：
   在 `!hasFiles`（本地无模型）分支中，硬编码了匹配正则直接返回 `0.88`、`0.85` 的伪造出分。这一假象让单元测试在完全没有 ONNX 运行时的情况下产生「测试全部通过、采出率完美」的自欺欺人幻象。
2. **`cross_encoder.js:145-245`**：
   `WordPieceTokenizer` 仅针对 `vocab.txt`，无法用于现代 SentencePiece/BPE 交叉编码器，属于无用代码。
3. **`model_check.js:46-59`**：
   虚构的 `BAAI/bge-reranker-small` 及其伪造的 SHA-256，需要修正或标记为不可用。
4. **`gateway_harvest.js:1297`**：
   `cross_encoder_enabled !== false` 默认将未经验证的管线作为默认行为。鉴于真实推理全军覆没且存在源码倒挂，**默认配置必须关闭 (`false`)**。

---

## 五、最终判定结论

**【明确结论：基于通用 Cross-Encoder 零样本语义判别替代规则过滤的路线「在当前技术范式下不成立」】**

1. **判别力破产**：在 12 个真实场景中，正例全部被原阈值过滤（召回率 0%）；踩坑判别对源码和正则打出比真故障解法高 6 倍的分数，无法解决 288 条伪踩坑问题。
2. **技术开销不成比例**：一个最轻量的 INT8 Reranker 体积达 266MB，WASM 单线程推理需 200~400ms，在移动端/轻量轻量网关环境中对 CPU、内存和网络都是沉重负担。
3. **生态兼容性脆弱**：Alpine / Musl 环境下官方 Native 二进制 crash，Node 下 WASM Worker 多线程 crash。
4. **正确路径建议**：
   记忆采集与提炼的准确性应回归至：
   - **Stage 0 确定性语法与角色过滤**（剥离代码块、过滤纯提问句与客套话）；
   - **显式声明穿透**（由用户通过 prompt 约定或显式意图触发）；
   - 或由**网关后台调用轻量 LLM（如本地 0.5B/1.5B SLM）进行有推理能力的上下文判别**，而不是指望纯向量检索排序的 Reranker 承担 Zero-shot 分类重任。
