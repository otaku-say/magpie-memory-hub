# R2 挂载状态判定与提示误导修复检查点 (NOTES_r2_state.md)

## 一、问题背景与用户实测事实
1. **用户实测两点反馈**：
   - 确认错误分类正确：当远端返回 SSL alert 40 时，「Secret Key 本身已通过 NoCodeBackend 验证，并非密钥无效！根本原因：NoCodeBackend 拿它保存的 Cloudflare 凭据去连 R2 时，被 Cloudflare 拒绝了 TLS 握手」这一分类文案准确有价值，必须保留。
   - 提示误导问题：**R2 存储未挂载时，点击「检测 R2 密钥」也会报错（报 TLS 握手失败/凭据被拒），容易误导用户以为密钥有问题；而挂载 R2 之后检测提示正常**。
2. **核心逻辑根因**：
   - R2 尚未挂载时，NoCodeBackend 远端该数据库实例并未与 Cloudflare R2 建立存储通道。
   - 当前代码在 `r2Check`（以及 `storage_list` / `storage_delete` / `clean_probes`）中**完全缺失「是否已挂载」的拦截与判断**，直接盲目向远端发起真实上传探测（`r2Probe`）或 REST 请求。
   - 远端因未绑定 R2 抛出 TLS 握手失败（HTTP 500 / alert 40），被捕获为「R2 凭据在 Cloudflare 侧被拒绝」，引向错误的密钥排查方向。

## 二、「是否已挂载」的判据分析（代码依据）
1. **现有代码代码现状**：
   - `r2.js:334-394` (`r2Setup`)：调用 MCP `setupR2Storage`，随后做 `r2Probe`，成功时返回 `ok: true, verdict: "VERIFIED"`，但**完全没有将挂载成功状态持久化落盘**。
   - `r2.js:396-444` (`r2Check`)：仅读取参数与配置并派生桶名，随后直接调用 `r2Probe(cfg, db)`，**零挂载状态检查**。
   - `r2.js:525-535` (`r2List`) / `r2.js:541-555` (`r2Delete`) / `r2.js:618-670` (`cleanProbes`)：直接调用 REST 接口或 `r2List`，**零挂载状态检查**。
   - `local_state.js:35-50` (`readState`)：当前仅维护 `current`, `secrets`, `actions`, `gateway_harvest`, `pending_patterns`，**完全没有 R2 挂载标记**。
2. **真实可靠的判据设计**：
   - **必填凭据检查**：Account ID、Access Key ID、Secret Access Key。若用户连必填凭据都没填全，且本地无挂载记录，必然未挂载。
   - **持久化挂载状态**：在 `local_state.js` 引入 `r2_mounts[database]`，存储 `{ mounted: true, bucket, public_url, at }`。
   - **挂载落地时机**：只有在 `r2Setup` 真实探针验证通过（`probe.ok === true`）时，才正式调用 `rememberR2Mount(db, info)` 记录挂载成功。
   - **平滑兼容与兜底**：若 `local_state` 尚未记录，可兼容读取当前工作目录 `_status.json` 中上次 `storage_setup` / `r2_check` 的成功状态；若均无记录，判定为未挂载。
   - **统一判定函数**：在 `local_state.js` 与 `r2.js` 导出 `lookupR2Mount(db)` 与 `isR2Mounted(cfg, db, args)`。

## 三、依赖 R2 的同类操作清扫
在以下所有依赖 R2 的入口统一接入 `isR2Mounted` 守卫，未挂载时直接返回明确提示，不走远端真实请求：
1. `r2Check`：检测 R2 密钥
2. `cleanProbes`：清理探针文件
3. `r2List` (`storage_list`)：列出对象
4. `r2Delete` (`storage_delete`)：删除对象
5. `r2Upload` (`storage_upload`)：上传文件

**统一提示文案**：
- 标题：`R2 尚未挂载`
- 说明：`未挂载时无法检测/操作，因为还没有可验证的存储通道`
- 解决办法：`请先在 R2 卡片点击「挂载 R2 存储」，完成挂载后再来检测`

## 四、关于 TLS 错误归因与 Secret Key 检测结论
1. **为什么检测 Secret Key 会牵扯到 R2？**
   - NoCodeBackend 无独立的密钥验证端点（如 `/auth/verify` 或 `ping`），验证 Secret Key 走的是其 REST 只读根接口 `GET https://api.nocodebackend.com/files?Instance=<real_db>`。
   - NCB 服务端在鉴权通过后，连带去查询该 Instance 绑定的 R2 存储通道。若未挂载或远端凭据失效，NCB 连 Cloudflare 产生 TLS 错误返回 HTTP 500。
   - **结论**：这是 NCB 服务端内部对 R2 的连带校验行为。文案必须讲透：Secret Key 本身已通过验证（完全有效），此报错来自 NCB 远端连带访问 R2 存储通道失败，与用户密钥本身无关。
2. **排除「Docker 容器缺 openssl」猜想**：
   - 报错堆栈 `rec_layer_s3.c` 为 Node 内置 OpenSSL，运行完全正常；
   - `SSL alert 40` 是对端发来的告警，并非本机缺库；
   - 报错发生在远端 HTTP 500 响应体中，说明请求已成功送达 NCB 服务器，失败发生在 NCB → Cloudflare 之间；
   - 用户检测 MCP Key 完全成功，证明容器网络与 TLS 一切正常。
   - **整改**：排查文案明确指引 Cloudflare Token 权限与控制台配置，严禁建议用户在容器安装 openssl；清理 `db_tools.js` 中关于「本机 TLS 握手异常 / 检查证书链」的误导性分支。
