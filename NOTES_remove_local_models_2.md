# NOTES: 移除本地小模型设施（接力收尾计划与进度）

> 本文件由收尾代理创建，记录彻底清除本地小模型（LLMLingua-2 / mBERT INT8 / model_check / compress_text）的工作台账、各步骤已做/未做状态及验证记录。

---

## 一、当前紧急问题与现状基线

### 1. 运行时断裂（紧急隐患）—— 已彻底解决
在 `page_actions.js` 中，之前的代理移除了 `import ... from "./model_check.js"`，但函数体内遗留了 6 处直接调用：
- `page_actions.js`: `"存储目录：" + modelDir()`
- `page_actions.js`: `total_bytes: MODEL_SPEC.approx_bytes`
- `page_actions.js`: ``落点目录：${modelDir()}``
- `page_actions.js`: `_modelDownloadTask = downloadModel(cfg, action, onProgress)`
- `page_actions.js`: `"存储目录：" + modelDir() + "（Magpie 持久卷）"`
- `page_actions.js`: `result = await checkLocalModel({ checkUpstream: true })`
- `isModelDownloading` / `startBackgroundModelDownload` 专有函数存留
- `runPendingAction` 中 `model_check` / `model_download` 分支存留
**处理结果**：已全部彻底删除，OPS 白名单与 CARD_OF_OP 中的 model 映射均已清理完毕。

### 2. 代码所有权执行情况
- **已负责清理并验证**：
  - `model_check.js`（物理删除，615 行）
  - `compress_text.py`（物理删除，170 行）
  - `tools.js`（移除 `model_check` / `model_download`，工具数 22 → 20）
  - `page_actions.js`（彻底清除本地模型 6 处调用 + 2 个函数 + 2 个分支）
  - `harvest.py`（移除 `ENGINES` / `_compressor` / `get_compressor` / `compress_engine`）
  - `package.json`（files 列表移除两文件，移除 options 中的 `compress_engine`）
  - `README.md`（移除本地模型章节，说明改用在线模型及原因，更新工具数为 20）
  - `tests/`（同步工具数 22 → 20、反证测试、meta 测试、beacon 等）
- **绝未改动（遵守硬性约束）**：
  - `gateway_harvest.hooks.js`
  - `gateway_harvest.js`
  - `memory.middleware.js`
  - `settings.*`

---

## 二、任务清单与进度状态（已做/未做）

| 序号 | 任务内容 | 状态 | 说明 |
| :--- | :--- | :---: | :--- |
| 1 | 修复 `page_actions.js` 运行时断裂，彻底移除模型相关调用与分支 | [x] 已完成 | 清理 6 处引用、2 个辅助函数、2 个分支，语法检查通过 |
| 2 | 删除 `model_check.js` 与 `compress_text.py` | [x] 已完成 | 彻底物理删除两个孤立文件 |
| 3 | 修改 `tools.js` 移除导入与 2 个工具定义（22 → 20） | [x] 已完成 | 真实注册工具数精准为 20 个 |
| 4 | 清理 `harvest.py` 死代码 | [x] 已完成 | 移除 `ENGINES`、`_compressor`、`get_compressor`、`compress_engine` |
| 5 | 清理 `package.json` | [x] 已完成 | files 白名单与 options 配置字段清理，版本号 6.14.1 保持不变 |
| 6 | 更新 `README.md` | [x] 已完成 | 移除本地模型章节，如实说明改用在线模型及原因，更新工具数 22 → 20 |
| 7 | 测试同步：`tests/test_tool_names_static.mjs` | [x] 已完成 | 强断言 20 个工具，加反证断言下线工具拦截 |
| 8 | 测试同步：`tests/test_meta.mjs` 及其他测试 | [x] 已完成 | 锁定 30 个测试文件；同步 `test_beacon_e2e.mjs` 下线信标拦截反证 |
| 9 | 逐项验证与全套测试运行 | [x] 已完成 | 运行全套测试，记录真实测试输出 |
| 10 | 全仓 `rg` 终极自查 | [x] 已完成 | 确认全仓代码无任何遗留引用 |

---

## 三、设置页（settings.*）联动清理待办清单（交接用）

受硬性约束「不要动 settings.*」限制，当前设置页文件保持原样，以下为后续合并时建议处理的待办项：
1. **`settings.html` (约 520-534 行)**：
   - 移除「离线语义压缩引擎」整行，包括：
     - `<label>离线语义压缩引擎</label>` 描述块
     - `<button id="btn_check_model">检测本地小模型</button>`
     - `<button id="btn_download_model">一键下载模型</button>`
     - `<div class="action-status-box" id="model_action_status"></div>`
2. **`settings.js`**：
   - 移除 `btn_check_model` 与 `btn_download_model` 点击事件绑定与提交 `model_check`/`model_download` 信标逻辑
   - 移除 `CARD_STATUS_BOX` 中 `model: "model_action_status"` 映射及针对 model 卡片和下载进度的渲染逻辑（`renderModelDownloadProgress`、`isDownload` 等）
3. **`settings.css` (约 954-985 行)**：
   - 移除 `.model-progress-box`, `.model-progress-bar`, `.model-progress-fill`, `.model-progress-meta`, `.model-progress-pct` 等样式定义
