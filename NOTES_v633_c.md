# v6.33 Track C (Config Drift & Number Normalization) Implementation Notes

## 任务目标与文件所有权
严格限定修改文件：
- semantic_dedup.js
- package.json
- settings.html
- settings.js
- tests/test_meta.mjs
- DEVNOTES.md
- tests/test_v633_c_config.mjs (新增)
- NOTES_v633_c.md (本文件)

严禁修改：tools.js / model_budget.js / gateway_harvest.js / local_state.js / mcp_client.js / ncb_mcp.js / 其他 tests。

## 核心整改项设计与落地

### 1. 【P1-1 核心】hasConflictingNumbers 末位零丢失导致版本号冲突漏检（semantic_dedup.js）
- **根因分析**：
  原实现使用 `Number(x)` 进行数字归一化，由于 JavaScript 中 `Number("3.10") === 3.1`，末尾的零被完全抹除。导致：
  - "Python 3.1" 与 "Python 3.10" 提取出的数字集合均为 `{"3.1"}`，被误判为无冲突；
  - "Go 1.2" 与 "Go 1.20" 被误判为无冲突；
  - 生产中 pitfall_save 误把 Python 3.10 的报错识别为 Python 3.1 的重复条目并丢弃。
- **修复方案**：
  - 彻底废除 `Number()` 归一化；
  - 提取原始数字/版本号字符串（匹配 `\d+(?:\.\d+)*`）；
  - 逐段按 `.` 拆分，执行「逐段去前导零」规范化（如 "3.10" -> ["3","10"]，"03.1" -> ["3","1"]，"0080" -> ["80"]）；
  - 用「段数组」的规范形式作为比较基准（即规范字符串 `segments.join(".")` 构成的集合）；
  - 两侧段数组完全一致视为同一数字，任一不同判定为冲突；
  - 纯整数（"80" vs "8080"）段数组不同，判定为冲突，与历史行为完全兼容。
- **反证门矩阵**：
  - "Python 3.1" vs "Python 3.10" => 冲突 true（反证门 1）
  - "Go 1.2" vs "Go 1.20" => 冲突 true
  - "v1.2.3" vs "v1.2.30" => 冲突 true
  - "Node 18" vs "Node 20" => 冲突 true
  - "port 8080" vs "端口 8080" => 冲突 false（反证门 2）
  - "03.1" vs "3.1" => 冲突 false

### 2. 【P2-1】配置默认值与文档/断言漂移
- **package.json 与 settings.html / settings.js 默认值对齐**：
  - package.json 中 `dedup_batch_size` 默认 50，但 settings.html (line 366) 及 settings.js (line 39) 写为 1000；
  - 统一将其调整为 50，与 `tools.js` readOptions 默认值完全一致。
  - settings.html 的徽章提示与描述同步更新为「默认 50 / 推荐 50」。
- **tests/test_meta.mjs 第 160 行断言文案对齐**：
  - 第 160 行断言当前数字为 52，但提示文案遗留为「期望精确 50 个」；
  - 修正提示文案为「期望精确 52 个」，数字 52 保持不变（主控在最终多分支合并后统一锁定最终测试文件总数）。
- **DEVNOTES.md 第 22.3 节复选框勾选**：
  - 勾选第 22.3 节（`3. P2-4 mcp_client.js / ncb_mcp.js` 及其 3 项子任务）复选框为已完成 `[x]`。
- **引擎内部配置默认值核验**：
  - 核查 `dedup_fetch_limit` (200)、`audit_chunk_size` (40)、`audit_max_batches` (2)；
  - 在 package.json 和 tools.js 中默认值已完全对齐（200、40、2）；settings.html 保持极简，不暴露不必要的底层微调参数。

## 验收计划
1. 新建 `tests/test_v633_c_config.mjs`，包含上述 2 项整改的完备反证测试。
2. 运行回归测试套件并确保全部通过。
3. 检查 git diff 确保仅改动授权文件。
4. 提交并推送到远端 `feat/v633-c-config` 分支。
