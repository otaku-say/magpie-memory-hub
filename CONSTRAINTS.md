# Constraints

Last reviewed: 2026-10-21

本文件是 **magpie-memory-hub** 的质量底线契约。任何 Agent（人或模型）在改代码前必须先读本文件，
**不得为了让某次改动通过而弱化本文件**。

---

## Floor（永远执行，无需额外配置）

- **测试失败数必须为 0**。`bash tests/run_all.sh` 或逐套运行，出现 `失败 N`（N > 0）即视为不通过。
- **不得跳过或删除测试**。以下行为一律禁止，除非 commit message 明确写明原因并获人工批准：
  - 新增 `it.skip` / `describe.skip` / `test.skip` / `xit` / `xdescribe`
  - 删除 `tests/*.mjs` 文件
  - 从保留的测试中抽掉 `assert` 语句
  - 把强断言改为 `assert.ok(true)` 之类的空断言
- **不得弱化计数断言**。`tests/test_meta.mjs` 里的测试文件总数是精确锁定值，**只能由主控在合并后统一调整**，
  任何单个分支不得自行修改。
- **不得新增错误抑制**：新增 `eslint-disable`、`@ts-ignore`、`/* istanbul ignore */` 需在 PR 说明理由。
- **不得写未实现的桩**：`throw new Error("Not implemented")`、`TODO: implement`、返回硬编码假数据的占位实现。
- **空 catch 仅允许用于明确的 fail-open 降级路径**，且必须带注释说明降级后果（本项目大量使用 fail-open，
  这是设计而非疏忽；但没有注释的空 catch 视为可疑）。
- **源码中不得出现密钥**：`sk-`、`Bearer `、`ncb_` 开头的长串、`.env` 内容。

---

## 架构约束（本项目的结构性底线）

| 约束 | 检查方式 | 违反后果 |
|:--|:--|:--|
| 根目录只有 3 个宿主入口门面（`tools.js` / `memory.middleware.js` / `gateway_harvest.hooks.js`） | `tests/test_structure.mjs` | 门面里藏实现会重新变成巨石文件 |
| 门面只做 re-export，去掉注释与 import/export 后**残留代码为 0** | `tests/test_structure.mjs` | — |
| 无循环依赖 | `tests/check_cycles.mjs` | ESM 循环依赖会在某条调用链上变成 `undefined` |
| 导出面不变 | `tests/test_exports.mjs` | 84 套测试全部依赖导出面 |
| 每个模块顶部有中文注释（职责 / 依赖 / 被依赖） | `tests/test_structure.mjs` | — |
| **不按行数硬拆** | 人工评审 | 强行把单一职责函数切成碎片，耦合反而更高 |

---

## 重构专用约束（v6.43.0 起）

任何**纯移动/纯拆分**类改动必须满足：

- **函数名集合完全一致**（对照重构前基线）：`tests/check_split_equiv.mjs`
- **同名函数的行数差 ≤ 5 行**：证明是原样搬运，不是顺手改逻辑
- **不得移动既有小文件的同时做拆分**：两者必须分开做，否则全局引用会断（已实测造成 75 个测试失败）
- **不得在一个文件里同时 `import` 和本地声明同名符号**：会导致 `SyntaxError: Identifier already declared`

---

## 检查器

```bash
node tests/test_meta.mjs          # 测试套件规范与计数
node tests/test_exports.mjs       # 导出面
node tests/check_schema_sync.mjs  # schema 与代码字段对齐
node tests/check_cycles.mjs       # 循环依赖
node tests/test_structure.mjs     # 目录结构与门面纯净度
node tests/check_split_equiv.mjs  # 拆分等价性
python3 verify_delivery.py        # 交付机器验收（六项）
```

**`CONSTRAINTS.md` 是唯一权威来源**，脚本只是它的镜像。两者冲突时以本文件为准。

---

## 已知的合理例外

| 例外 | 原因 |
|:--|:--|
| `catch (_) {}` 出现在 `stripStream` / `onEvent` 等 fail-open 路径 | 设计如此：宁可漏剥离标签也不丢用户内容 |
| 部分模块超过 400 行（`memory-saver.js`、`auditor.js`、`hook-runner.js`） | 职责单一但代码本身长；硬拆会增加调用链与参数穿透 |
| 测试中的 `assert.ok(true, "反证")` | 反证门常用写法，但必须真的有反证逻辑在上面 |
