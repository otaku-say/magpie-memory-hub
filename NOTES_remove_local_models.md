# NOTES: 移除本地小模型设施（CheckPoint / 检查点）

> 记录移除 `magpie-memory-hub` 中遗留的本地小模型设施（LLMLingua-2 mBERT INT8 等）的过程、证据、改动清单与验证状态。

---

## 一、关键前提复核结论（带代码文件与行号证据）

经系统核查代码库，确认本地压缩模型 `llmlingua2-mbert-int8` 在生产环境中**从未真正执行过推理**，属于彻底的死代码与假就绪设施：

### 1. `model_check.js` 的「就绪」仅检查文件大小，全模块无任何推理代码
- **文件与行号**：`model_check.js:89-125`（`statModel` 函数）与 `model_check.js:219-253`（`checkLocalModel` 函数）。
- **实测证据**：
  - `model_check.js:89` 注释直白写道：`/** 只查大小，不读全文件（200MB 读一遍哈希太慢，检测要秒回）。 */`；
  - `model_check.js:111-124` 仅执行 `st = fs.statSync(p)` 并比对 `st.size !== want`；
  - `model_check.js:219-253`：一旦文件大小吻合（`st.present === true`），即判定 `verdict = "READY"`，输出文案 `title = "本地小模型已就绪"`、`离线推理可正常使用，数据不出本机`；
  - **全模块没有引入任何 ONNX 运行时（无 `onnxruntime`、无 `ort`、无 `onnxruntime-web`），没有创建过任何 `InferenceSession`，没有执行过任何前向计算或张量运算**。它只是一个纯粹的静态 HTTP 下载器与文件体积比对器。

### 2. `compress_text.py` 的推理入口在全仓为死代码
- **文件与行号**：`compress_text.py:126-170`、`harvest.py:1581-1603`。
- **实测证据**：
  - `compress_text.py:126-170` 定义了 `class Kompress`，封装了 `onnxruntime` / `tokenizers` 推理；
  - 全仓唯一导入 `compress_text` 的地方是 `harvest.py:1592`（`import compress_text`）；
  - 该导入包裹在 `harvest.py:1581` 的 `def get_compressor(cfg, logfn):` 函数中；
  - **检索全仓对 `get_compressor` 的引用：除了第 1581 行定义本身外，没有任何业务代码调用该函数**（调用处为 0）；
  - 全仓没有任何 Node/Bun 模块（`tools.js`, `gateway_harvest.js`, `gateway_harvest.hooks.js`, `page_actions.js`）使用 `child_process.spawn` 或 `exec` 调起 `compress_text.py`。因此该 Python 推理链条从未被激活。

### 3. 官方部署镜像为 Distroless，根本没有 Python 环境
- **文件与行号**：`NOTES_deadcode.md:14`、`NOTES_cross_encoder_feasibility.md:54-59`。
- **实测证据**：
  - Magpie 生产运行在 `gcr.io/distroless/cc-debian12:nonroot` 容器中，没有 Python 解释器、没有 pip、没有 shell，仅有 Go 二进制宿主与内嵌的 JS 引擎；
  - 依赖 Python + onnxruntime 的离线压缩脚本在生产容器内根本不可能执行。

---

## 二、打算移除/更新的文件清单

### 1. 核心移除（彻底删除 / 剥离本地模型）
- `model_check.js`：**彻底删除**（整个文件专门服务于 llmlingua2 及其下载检测）。
- `compress_text.py`：**彻底删除**（孤立的 onnxruntime 推理代码）。
- `harvest.py`：**剥离死代码**：
  - 移除第 1550-1574 行关于 `ENGINES` 及 llmlingua2 的死配置；
  - 移除第 1581-1603 行从未被调用的 `get_compressor` 及其懒加载逻辑；
  - 保留核心离线文本处理与规则仲裁能力。
- `tools.js`：
  - 移除 `import { checkLocalModel, MODEL_SPEC, modelDir } from "./model_check.js";`；
  - 移除工具字典中的 `model_check` 工具；
  - 移除工具字典中的 `model_download` 工具；
  - 工具总数从 22 减少至 20。
- `package.json`：
  - `files` 白名单中移除 `"compress_text.py"` 与 `"model_check.js"`；
  - 检查并清理 options 中与本地模型相关的冗余项。
- `README.md`：
  - 移除 `model_check` / `model_download` 工具介绍与本地模型安装章节；
  - 如实记录「已改用在线模型（Gemini 提炼 + Clef 分类）及原因」。

### 2. 测试集同步
- 移除只服务于本地模型的孤立测试（如已在 git status 中标出的 `verify_download_scenarios.mjs`、`verify_full_model.mjs` 等）；
- `tests/test_tool_names_static.mjs`：
  - 同步真实注册工具数断言（22 → 20）；
  - 确保工具名一致性扫描全部通过；
- `tests/test_meta.mjs`：
  - 确保测试文件扫描总数与规范全部通过。

### 3. 设置页相关（按约束处理）
- 由于并行代理可能正在修改设置页，且硬性约束要求「不要动 settings.*」，设置页中残留的本地模型相关 DOM / 逻辑将在报告中明确列出联动清单，供合并时一并处理，避免代码冲突。

---

## 三、当前执行进度（状态追踪）

- [x] 1. 前提复核（三点结论与行号证据已落盘）
- [ ] 2. 移除 `model_check.js` 与 `compress_text.py`
- [ ] 3. 重构 `harvest.py` 移除 `get_compressor` 与 `ENGINES`
- [ ] 4. 修改 `tools.js` 移除 `model_check` 与 `model_download` 工具
- [ ] 5. 修改 `package.json` 移除 files 白名单中的相关文件
- [ ] 6. 同步 `tests/test_tool_names_static.mjs` 工具总数断言（22 -> 20）与反证
- [ ] 7. 运行 `test_meta.mjs`、`test_tool_names_static.mjs` 等全量测试并记录输出
- [ ] 8. 清查全仓「假就绪」自欺欺人检测并修正
- [ ] 9. 更新 `README.md`
