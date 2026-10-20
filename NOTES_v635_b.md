# v6.35 Agent B 封堵 /home 与 /root 路径借道与环境变量绕过规划 (NOTES_v635_b.md)

## 1. 任务背景与文件所有权
- **沙箱 ID**：`bed18e430eb645d08549f93a48ba4cfc`
- **代码目录**：`/workspace/m`
- **工作分支**：`feat/v635-b-path`
- **文件所有权约束（严格独占）**：
  - `gateway_harvest.js`
  - `tests/test_v635_b_path.mjs`
  - `NOTES_v635_b.md`
- **严禁修改**：`tools.js` / `model_budget.js` / `online_models.js` / `local_state.js` / `semantic_dedup.js` / `package.json` / `settings.*` / `README.md` / `DEVNOTES.md` / `test_meta.mjs` / 其他 tests。

---

## 2. 整改项清单与技术方案

### 2.1 【P1-3】封堵 /home 与 /root 任意深度借道 GatewayConversations 放行漏洞 (gateway_harvest.js)
- **根因分析**：
  1. 上一轮仅对 `/var` 根域增加了子域白名单（`isVarSubdomainAllowed`），而 `/home` 与 `/root` 仍沿用「只要路径中包含 GatewayConversations 子串就放行」的弱匹配；
  2. 实测中攻击者可构造任意深层敏感路径（如 `/root/private_secrets/GatewayConversations`、`/home/otheruser/private_repo/GatewayConversations`）或软链接（如 `/tmp/link_to_root/private_secrets/GatewayConversations`）借道逃逸；
  3. 环境变量 `MEMHUB_GATEWAY_CONV_DIR` 被白名单直接信任，未校验其目标路径是否落在敏感黑名单或敏感子路径（例如指向 `/root/.ssh` 仍能被放行）。

- **修复方案**：
  1. **新增并导出 `isHomeOrRootAllowed(p, customHome = null)`**：
     - 对位于 `/home/<user>` 或 `/root` 下的路径进行归属与层级校验；
     - 仅当满足以下条件之一才返回 `true`：
       - 是【当前运行用户 `os.homedir()`】的直接子路径 `GatewayConversations`（或 `gateway-conversations`，首层子目录精确匹配）
       - 是当前运行用户 home 下的 `.config/magpie`（含子路径）
     - 其余所有情况（非当前用户目录、未授权深层目录如 `private_secrets`、`.ssh` 等）一律返回 `false`；
     - 不属于 `/home` 或 `/root` 域的路径返回 `true`（不属于本规则管辖范围，由后续规则判定）。
  2. **严格规范校验顺序**：
     - 在 `isWhitelistedGatewayDir(p)` 中：先执行 `isVarSubdomainAllowed(p)`（/var 域），再执行 `isHomeOrRootAllowed(p)`（/home 与 /root 域），最后才做白名单特征与环境变量匹配；
     - 在 `checkPathForbidden(norm)` 中：先执行敏感子路径与系统前缀拦截，再跑 `isVarSubdomainAllowed`，接着跑 `isHomeOrRootAllowed`，最后执行白名单目录放行判定。
  3. **环境变量 `MEMHUB_GATEWAY_CONV_DIR` 同等安全校验**：
     - 在 `isWhitelistedGatewayDir` 中，即便匹配 `MEMHUB_GATEWAY_CONV_DIR`，该环境变量目录自身必须通过 `isVarSubdomainAllowed` 与 `isHomeOrRootAllowed` 校验；
     - 在 `validateGatewayDir` 中，无论是用户传入参数还是 `MEMHUB_GATEWAY_CONV_DIR`，解析出的真实路径必须强制通过 `checkPathForbidden`，绝不因设置了环境变量而绕过黑名单。
  4. **保留祖先回溯安全成果**：
     - 在 `validateGatewayDir` 祖先链向上回溯解析软链接时，对重构出的 `realPath` 无条件执行 `checkPathForbidden(realPath)`。

---

## 3. 双向反证测试方案与验收策略
- **新建测试**：`tests/test_v635_b_path.mjs`
- **双向反证设计**：
  - **必须拒绝（反证门 A）**：
    1. `/root/private_secrets/GatewayConversations` 必须被拦截并抛出 `[SECURITY_BLOCKED]`；
    2. `/home/otheruser/private_repo/GatewayConversations` 必须被拦截并抛出 `[SECURITY_BLOCKED]`；
    3. `/tmp/link_to_root/private_secrets/GatewayConversations`（祖先软链指向 /root）必须被拦截并抛出 `[SECURITY_BLOCKED]`；
    4. `/root/.ssh/GatewayConversations` 必须被拦截并抛出 `[SECURITY_BLOCKED]`；
    5. `MEMHUB_GATEWAY_CONV_DIR` 指向 `/root/.ssh` 或 `/root/private_secrets` 时必须被拒绝并抛出 `[SECURITY_BLOCKED]`。
  - **必须放行（反证门 B）**：
    1. `<os.homedir()>/GatewayConversations`（含 `~/GatewayConversations`）必须 100% 合法放行；
    2. `<os.homedir()>/.config/magpie`（含子路径 `GatewayConversations`）必须 100% 合法放行；
    3. `/var/minis/x/GatewayConversations` 必须合法放行；
    4. `/tmp/ok/GatewayConversations` 必须合法放行；
    5. `MEMHUB_GATEWAY_CONV_DIR` 指向 tmpdir 下普通目录时必须合法放行。
  - **规范合规自检**：
    - 对本测试文件进行 `test_meta` 规范扫描，断言 0 规范违规，无数据库写泄漏。
