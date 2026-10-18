# Magpie Memory Hub: Cross-Encoder 语义判别运行可行性调查报告 (NOTES_cross_encoder_feasibility.md)

**记录时间**：2026-10-18  
**工作目录**：`/var/minis/workspace/magpie-memory-hub/`  
**核心议题**：针对自动采集在真实对话下产出为 0、规则判定走向「太松噪音泛滥 (288条/20m)」与「太窄零产出」两极的问题，评估在 Magpie / Bun 运行时内引入 **Cross-Encoder 零样本语义判别（两阶级联架构）** 的工程与运行可行性。

---

## 一、官方 Magpie 镜像与现有小模型真相调查

### 1. 矛盾点
此前工程判定「官方 Magpie 镜像基于 distroless、容器内没有 Python，stdout 链路与 harvest.py 无法运行」（见 `NOTES_deadcode.md:14`、`NOTES_deadchain.md:11`）。  
但与此矛盾的是：设置页和 `model_check` 均提示"本地小模型已就绪"，模型文件落盘在 `/config/home/.magpie-memory-hub/models/KatawaDead--llmlingua-2-bert-base-multilingual-cased-meetingbank-onnx-int8/`。  
**究竟现有小模型推理跑在哪里？官方镜像里到底有没有可用 Python？**

### 2. 调用链深入代码溯源（文件 + 行号实证）

经过对全仓代码的完整搜索与调用拓扑静态分析，确认以下铁证：

1. **`model_check.js` 所谓的"已就绪" 100% 只是只读文件校验，从未执行过任何推理**：
   - `model_check.js:84-129` (`statModel(dir)`)：仅通过 `fs.existsSync(p)` 和 `fs.statSync(p).size === want` 检查 `model.onnx`、`tokenizer.json`、`vocab.txt`、`config.json` 4 个文件是否存在以及体积是否匹配。
   - `model_check.js:208-251` (`checkLocalModel(options)`)：在 `st.present` 为真时，直接构造返回对象：
     ```javascript
     // model_check.js:209-222
     let verdict = "READY";
     let title = "本地小模型已就绪";
     // ...
     lines.push("离线推理可正常使用，数据不出本机。");
     ```
   - **整个 `model_check.js` 模块中没有任何 `onnxruntime` 引用，没有任何 `InferenceSession` 创建，也没有任何对模型前向计算的验证！** 它只是一个通过 HTTP `fetch()` 下载文件并验 SHA-256 的静态下载器（`model_check.js:410-488`）。

2. **网关请求压缩链路中完全没有模型推理**：
   - `compress.js:14-16`：模块头部明确写明：
     ```javascript
     // compress.js:14-16
     *   ❌ Kompress-v2    —— ModernBERT INT8 ONNX，moejs 跑不了（放到离线管线）
     *   ❌ CodeCompressor —— 需要 tree-sitter/AST，moejs 跑不了
     ```
   - `compress.js` 在网关处理中运行于 `moejs` 同步引擎，实际只执行了纯 JavaScript 的正则和规则启发式（`SmartCrusher`、`LogCrush`），没有 ONNX，没有 Python。

3. **`compress_text.py` 的 ONNX 推理在生产环境中从未被调用**：
   - `compress_text.py:126-170`：定义了 `class Kompress`，其中 `_load()` 尝试导入 Python `onnxruntime`、`numpy`、`tokenizers`。
   - 全仓**唯一**导入 `compress_text` 的位置在 `harvest.py:1592`：
     ```python
     # harvest.py:1592
     import compress_text
     _compressor = compress_text.make(...)
     ```
   - 该导入位于 `harvest.py:1581` 的 `def get_compressor(cfg, logfn):` 函数内。
   - **`get_compressor` 在定义后，在 `harvest.py` 全文及整个项目中从未被任何一处代码调用**（全仓对 `get_compressor` 的引用仅有第 1581 行的函数声明）。
   - 全仓没有任何 Node/Bun 侧模块（`tools.js`, `gateway_harvest.js`, `gateway_harvest.hooks.js`, `page_actions.js`）使用 `child_process.spawn` 或 `exec` 调起 `compress_text.py`。

4. **官方镜像环境确证**：
   - 官方 Magpie Docker 镜像基于 `gcr.io/distroless/cc-debian12:nonroot`。
   - 该镜像内**无 `/bin/sh`、无 `/bin/bash`、无包管理器，更无 `python` 或 `python3`**。
   - 官方 Magpie 是单一静态 Go 编译二进制，内嵌 moejs 执行中间件，并通过插件系统以 Bun 运行插件。

### 3. 第一项结论
- **官方 Magpie 镜像内绝对没有 Python 运行时。**
- **现有「本地小模型压缩功能」在生产链路中是一个「只下载了 4 个权重文件、在设置页展示绿色就绪状态、但实际从未被加载执行」的空转死链路。**
- 这解释了为什么此前判定"无 Python"与"小模型报告就绪"并存：**因为小模型就绪仅代表文件存在，它从第一天起就根本没有跑过！**

---

## 二、Bun 侧加载 ONNX 运行时可行性评估

既然 Python 子进程无法在生产容器中工作，模型判别必须在 Magpie 插件宿主（Bun）环境中运行。对 Bun 侧的三种方案评估如下：

| 方案 | 原理 | 优势 | 劣势与致命风险 | 可行性结论 |
|---|---|---|---|---|
| **(a) Python 子进程** | `child_process.spawn("python3", ["infer.py"])` | 原生 PyTorch/onnxruntime 生态成熟 | 官方 distroless 容器无 Python，执行报 `ENOENT`；要求宿主预装 Python + C 编译链，违背插件自包含零配置铁律。 | ❌ **生产彻底不可行** |
| **(b) `onnxruntime-node` (N-API)** | Bun 加载 Node 原生 `.node` 模块 + C++ 共享库 | C++ 原生执行，多线程 SIMD，单次推理 <50ms | 1. 跨平台体积爆炸：Linux x64/arm64、macOS arm64 各需 ~50MB 动态库，总计 >180MB，严重超出 GitHub 单文件与仓库限制。<br>2. 动态链接缺失：distroless debian12 缺失 OpenMP (`libgomp.so.1`)，`dlopen` 报找不到符号。<br>3. Bun N-API 对复杂 C++ 异常与线程池兼容性不稳定，偶发 segfault。 | ⚠️ **高风险、无法随插件分发** |
| **(c) `onnxruntime-web` (WASM)** | 编译为 WebAssembly 字节码运行在 Bun V8/JavaScriptCore Wasm 引擎 | 1. **零原生二进制依赖**：单套 `.wasm` 全平台通用（x86/ARM/macOS/Linux/Windows）。<br>2. **无环境污染**：不依赖 libc/libgomp。<br>3. **非阻塞异步适配**：我们已把提炼写库重构为后台队列异步执行（`drainHarvestQueue`），单次 100-300ms 的 WASM 推理耗时完全可容忍。 | 纯 CPU WASM 推理速度比原生慢约 2~3 倍；首次实例化 WASM 模块有约 300ms 冷启动开销。 | ✅ **推荐可行方案** |

### 推荐路径与技术选型
- **推荐方案**：采用 **(c) `onnxruntime-web` (WebAssembly 后端)**。
- **理由**：
  1. 插件分发与运行环境必须做到「零原生编译、零平台绑定、零动态库依赖」，WASM 是唯一能直接在 distroless 容器内 Bun 宿主中无条件运行的虚拟机格式；
  2. 异步网关钩子（`gateway_harvest.hooks.js`）现已完全通过后台非阻塞队列进行消费，单候选 150ms 左右的纯 CPU WASM 计算不会阻塞 HTTP 主链路（fail-open 绝对安全）；
  3. 模型选用用户推荐的 **`BAAI/bge-reranker-small`（ONNX INT8，约 45MB）**。INT8 使得模型体积缩小 75%，且整数乘加指令在现代 WASM SIMD 下具备极高吞吐。
- **Tokenizer 解决办法**：
  BGE-Reranker-Small 采用标准 BERT 多语言 WordPiece 词表（`vocab.txt`）。在纯 JS 中实现标准 WordPiece 分词器仅需 ~120 行代码，直接读取下载的 `vocab.txt`，单句分词耗时 < 0.2ms，**零额外 npm 依赖**。

---

## 三、替代方案评估：纯 JS 静态轻量语义相似度

若环境无法加载 ONNX WASM，是否可退化为「纯 JS 内置小型词向量表做余弦相似度」？

### 诚实评估（判别力分析）：
1. **静态词向量缺乏上下文与语法结构理解**：
   词向量（如 Word2Vec / GloVe）是词袋模型的平均。它对否定词、条件限定词几乎不敏感。例如：
   - 句子 A：「我们统一用 vitest，不要用 jest」
   - 句子 B：「请帮我写一个 jest 测试」
   在词袋余弦相似度下，两者的词重叠度非常高，静态余弦得分可能高达 0.85+，无法区分「规范陈述」与「一次性临时提问」。
2. **零样本判别能力极弱**：
   Cross-Encoder 的本质是 Query 与 Passage 的全注意力交叉（Full Cross-Attention），每一层都在计算 Query 锚点与候选项中每个 token 的关联；而词向量内积只有浅层共现，无法表达「什么是长期偏好、什么是短期报错处置」。
3. **结论**：
   **纯 JS 词向量判别力极弱，容易迅速退化为新的「误判/漏判」泥潭，不推荐作为语义判别方案。**
   若 ONNX WASM 引擎不可用或模型未就绪，**必须坚守 fail-open 原则：安全跳过模型判别，绝不使用低劣的启发式替代硬凑。**

---

## 四、两阶级联总体落地架构设计

```
[原始完整对话文本 (User + Assistant)]
                 │
                 ▼
┌────────────────────────────────────────────────────────┐
│  Stage 0: 极轻量正则粗筛 (输入裁剪，耗时 < 0.1ms，纯正则)  │
│  - 剥离脚手架与调试前缀 (<app-context>, <system-reminder> 等)│
│  - 剔除纯问句 (以 ？/问号结尾、"请问"、"如何"等问询句)        │
│  - 剔除纯客套应答 ("好的"、"谢谢"、"不客气"、"祝周末愉快")     │
│  - 剔除代码块正文 (保留命令行与单行输出关键片段)             │
│  - 产出候选语义单元切片 (Candidate Sentences/Blocks)      │
└──────────────────────────────────┬─────────────────────┘
                                   │ 筛选出候选语义切片
                                   ▼
┌────────────────────────────────────────────────────────┐
│  Stage 1: Cross-Encoder 零样本语义打分 (ONNX WASM)      │
│                                                        │
│  锚点 A (偏好与长期事实):                                │
│    "User profile, preferences, system environment,    │
│     habits, long-term constraints, or personal facts." │
│    Passage: candidate -> Sigmoid(Logit) >= 阈值 (默认 0.65)│
│    --> 归入 category: "fact" / "decision"              │
│                                                        │
│  锚点 B (技术踩坑与报错处置):                             │
│    "A real technical bug, error log or command         │
│     failure, followed by a concrete fix."              │
│    Passage: candidate -> Sigmoid(Logit) >= 阈值 (默认 0.70)│
│    --> 归入 category: "pitfall"                        │
└──────────────────────────────────┬─────────────────────┘
                                   │ 达标候选
                                   ▼
┌────────────────────────────────────────────────────────┐
│  既有工程纪律与入库门禁 (保持不变)                       │
│  - content_fingerprint 计算与查重                        │
│  - min_evidence 门禁 (事实/偏好 1次入库，踩坑 3次毕业)    │
│  - 显式时间戳与隔离字段                                   │
│  - 后台非阻塞异步安全落盘 (drainHarvestQueue)             │
└────────────────────────────────────────────────────────┘
```
