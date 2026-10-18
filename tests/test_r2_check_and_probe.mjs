/**
 * test_r2_check_and_probe.mjs —— R2 独立检测与探针防堆积治理验收测试
 *
 * 核心验证：
 * 1. Bug ①：未挂载时「检测 R2 密钥」必须能【独立运行】，不被 isR2Mounted 阻断；
 *    反证验证：若包含老逻辑 isR2Mounted 阻断，必定返回 NOT_MOUNTED；修复后成功返回 VERIFIED。
 * 2. Bug ②：探针删除失败时的可见性与指引，必须明确告诉用户「探针已留在桶里，因为缺 Secret Key 且给出清理方法」；
 *    反证验证：静默不提残留或未给清理指引将被严格拦截。
 * 3. Bug ② 修复：从 out.url 自动提取带前缀的真实对象 key，使有 Secret Key 时能正确删除；
 * 4. cleanProbes 解耦：未挂载时「清理探针文件」亦能独立运行（只要有 Secret Key）。
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { r2Check, r2Probe, r2Setup, cleanProbes, isR2Mounted, notMountedResponse } from "../r2.js";
import { NcbMcp } from "../ncb_mcp.js";
import { rememberR2Mount, forgetR2Mount, statePath } from "../local_state.js";

const DB = "41694_agent_memory";

console.log("=================================================================");
console.log("【R2 独立检测与探针防堆积治理验收与反证测试】");
console.log("=================================================================\n");

const stPath = statePath();
let origState = null;
if (stPath && fs.existsSync(stPath)) {
  try {
    origState = fs.readFileSync(stPath, "utf8");
  } catch (err) {
    origState = null;
  }
}

try {
  // -------------------------------------------------------------------
  // 测试 1: 未挂载时「检测 R2 密钥」能独立运行 (Bug ① 修复与反证)
  // -------------------------------------------------------------------
  console.log("--- 测试 1: 未挂载时「检测 R2 密钥」能独立运行 (Bug ①) ---");
  {
    // 准备环境：强制置为未挂载状态
    forgetR2Mount(DB);
    const initialMount = isR2Mounted({}, DB);
    assert.strictEqual(initialMount.mounted, false, "测试前提：数据库必须处于未挂载状态");

    // 反证门确认：模拟旧逻辑，未挂载时调 notMountedResponse 会被判定为 NOT_MOUNTED
    const falsifyOldLogic = notMountedResponse(DB);
    assert.strictEqual(falsifyOldLogic.ok, false, "反证验证：改前逻辑未挂载时 ok=false");
    assert.strictEqual(falsifyOldLogic.verdict, "NOT_MOUNTED", "反证验证：改前逻辑返回 NOT_MOUNTED 阻断检测");
    console.log("  ✓ [反证确认] 改前逻辑在未挂载时直接返回 NOT_MOUNTED，阻止独立检测");

    // 正向验证：打桩 MCP 接口模拟合法凭据上传
    const origCallTool = NcbMcp.prototype.callTool;
    try {
      NcbMcp.prototype.callTool = async function (name, args) {
        if (name === "setup_r2_storage") {
          return { ok: true, bucket_created: true };
        }
        if (name === "upload_file") {
          return { ok: true, url: "https://pub.example.com/test-probe.txt", key: "test-probe.txt" };
        }
        return { ok: true };
      };

      const res = await r2Check(
        { instance: DB, mcpKey: "mock_mcp_key" },
        { account_id: "acc_123", access_key_id: "ak_123", secret_access_key: "sk_123" }
      );

      assert.strictEqual(res.ok, true, "修复后：未挂载时输入凭据能够独立完成检测 (ok=true)");
      assert.strictEqual(res.verdict, "VERIFIED", "修复后：verdict 必须为 VERIFIED");
      assert.strictEqual(res.title, "R2 凭据验证通过（可用）", "必须显示凭据验证通过标题");
      assert.ok(
        res.lines.some((l) => l.includes("凭据真实有效，R2 存储通道已就绪")),
        "lines 中必须提示凭据可用且通道就绪"
      );

      // 验证检测成功后顺带写入挂载记录
      const postMount = isR2Mounted({}, DB);
      assert.strictEqual(postMount.mounted, true, "检测成功后必须自动写入挂载记录");
      console.log("  ✓ [正向验证] 未挂载时检测 R2 凭据顺利独立执行并落地挂载记录！");
    } finally {
      NcbMcp.prototype.callTool = origCallTool;
    }
  }

  // -------------------------------------------------------------------
  // 测试 2: 缺 Secret Key 时探针删除失败明确可见性与清理指引 (Bug ②)
  // -------------------------------------------------------------------
  console.log("\n--- 测试 2: 探针删除失败时明确提示用户残留与清理指引 (Bug ②) ---");
  {
    const origCallTool = NcbMcp.prototype.callTool;
    try {
      NcbMcp.prototype.callTool = async function (name) {
        if (name === "setup_r2_storage") return { ok: true };
        if (name === "upload_file") {
          // 模拟 NCB MCP 平台特性：返回带时间戳前缀的唯一对象 key
          return {
            ok: true,
            url: "https://pub.example.com/1792345678-abcd-_memhub_probe.txt",
            key: "1792345678-abcd-_memhub_probe.txt",
          };
        }
        return { ok: true };
      };

      // 仅有 MCP Key，无 Secret Key（无法调用 REST DELETE 删除探针）
      const probeRes = await r2Probe({ instance: DB, mcpKey: "mock_mcp_key", secret: "" }, DB);
      assert.strictEqual(probeRes.ok, true, "真实上传探针成功");
      assert.strictEqual(probeRes.cleaned, false, "无 Secret Key 时探针无法自动删除 (cleaned=false)");
      assert.ok(probeRes.clean_note.includes("探针文件已留在 R2 存储中"), "clean_note 必须明确告知探针残留");
      assert.ok(probeRes.clean_note.includes("Secret Key"), "clean_note 必须说明缺 Secret Key");
      assert.ok(probeRes.clean_note.includes("清理探针文件"), "clean_note 必须指引使用「清理探针文件」");

      // 检查 r2Check 上层封装的提示透出
      const checkRes = await r2Check({ instance: DB, mcpKey: "mock_mcp_key", secret: "" }, {});
      assert.strictEqual(checkRes.probe.cleaned, false, "r2Check 如实反映探针未能删除");
      assert.ok(
        checkRes.lines.some((l) => l.includes("探针残留提示") && l.includes("Secret Key")),
        "r2Check lines 中必须明确包含探针残留与 Secret Key 提示"
      );
      assert.ok(
        checkRes.note.includes("探针文件未能删除") || checkRes.note.includes("探针文件已留在"),
        "r2Check note 必须包含警示标记"
      );
      console.log("  ✓ [正向验证] 探针删除失败时零静默，明确提示留在桶内并给出清理指引！");
    } finally {
      NcbMcp.prototype.callTool = origCallTool;
    }
  }

  // -------------------------------------------------------------------
  // 测试 3: 从 URL pathname 自动提取带前缀的真实对象 key (Bug ② 根因)
  // -------------------------------------------------------------------
  console.log("\n--- 测试 3: 从 URL pathname 提取真实对象 key 确保删除匹配 (Bug ②) ---");
  {
    const origCallTool = NcbMcp.prototype.callTool;
    const origFetch = globalThis.fetch;
    let deletedKey = "";

    try {
      NcbMcp.prototype.callTool = async function (name) {
        if (name === "upload_file") {
          // 模拟 NCB 只返回 url，没有 key 字段的场景
          return { ok: true, url: "https://pub.example.com/1792999999-uniq-_memhub_probe.txt" };
        }
        return { ok: true };
      };

      globalThis.fetch = async function (url, opts) {
        if (opts && opts.method === "DELETE") {
          const m = url.match(/\/files\/([^?]+)/);
          if (m) deletedKey = decodeURIComponent(m[1]);
          return {
            status: 200,
            text: async () => JSON.stringify({ ok: true, deleted: true }),
          };
        }
        return { status: 200, text: async () => "{}" };
      };

      const probeRes = await r2Probe(
        { instance: DB, mcpKey: "mock_mcp_key", secret: "valid_secret_123" },
        DB
      );

      assert.strictEqual(probeRes.ok, true, "探针上传成功");
      assert.strictEqual(probeRes.cleaned, true, "提供有效 Secret Key 时探针成功删除");
      assert.strictEqual(
        deletedKey,
        "1792999999-uniq-_memhub_probe.txt",
        "必须从 url pathname 中准确提取带时间戳前缀的真实 key 进行删除"
      );
      console.log("  ✓ [正向验证] 准确从 URL 解析带动态前缀的真实对象 key，成功执行 REST 删除！");
    } finally {
      NcbMcp.prototype.callTool = origCallTool;
      globalThis.fetch = origFetch;
    }
  }

  // -------------------------------------------------------------------
  // 测试 4: 未挂载时「清理探针文件」亦能独立运行 (Bug ① 与 Bug ② 联动)
  // -------------------------------------------------------------------
  console.log("\n--- 测试 4: 未挂载时「清理探针文件」亦能独立运行 ---");
  {
    forgetR2Mount(DB);
    assert.strictEqual(isR2Mounted({}, DB).mounted, false, "测试前提：未挂载状态");

    const origFetch = globalThis.fetch;
    let deletedList = [];
    try {
      globalThis.fetch = async function (url, opts) {
        if (!opts || opts.method === "GET") {
          return {
            status: 200,
            text: async () => JSON.stringify({
              files: [
                "normal_file.png",
                "1792000000-_memhub_probe.txt",
                "1792111111-_memhub_probe.txt",
              ],
            }),
          };
        }
        if (opts.method === "DELETE") {
          const m = url.match(/\/files\/([^?]+)/);
          if (m) deletedList.push(decodeURIComponent(m[1]));
          return {
            status: 200,
            text: async () => JSON.stringify({ ok: true }),
          };
        }
        return { status: 200, text: async () => "{}" };
      };

      const cleanRes = await cleanProbes({ instance: DB, secret: "mock_secret" }, {});
      assert.strictEqual(cleanRes.ok, true, "未挂载时执行清理探针 ok=true（绝不报 NOT_MOUNTED）");
      assert.strictEqual(cleanRes.action, "CLEANED", "action 必须为 CLEANED");
      assert.strictEqual(cleanRes.found_count, 2, "准确扫描到 2 个带 _memhub_probe 的探针文件");
      assert.strictEqual(cleanRes.deleted_count, 2, "全部 2 个探针均已删除");
      assert.deepStrictEqual(
        deletedList,
        ["1792000000-_memhub_probe.txt", "1792111111-_memhub_probe.txt"],
        "删除的目标 key 必须完全匹配探测探针"
      );
      console.log("  ✓ [正向验证] cleanProbes 不受未挂载限制，成功扫描并清理 2 个残留探针！");
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  console.log("\n=================================================================");
  console.log("🎉 R2 独立检测与探针防堆积治理所有测试全部通过！");
  console.log("=================================================================");
} finally {
  // 安全还原本地状态
  try {
    if (origState !== null && stPath) {
      fs.writeFileSync(stPath, origState);
    }
  } catch (err) {
    console.warn("还原本地状态文件告警:", err.message);
  }
}
