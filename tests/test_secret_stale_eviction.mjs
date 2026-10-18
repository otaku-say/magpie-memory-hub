/**
 * test_secret_stale_eviction.mjs —— 403 失效密钥自动清除与指引验证（全入口覆盖）
 *
 * 【反证测试目标】
 * 1. 验证 local_state.js 中 forgetSecret 的精准、归一化与唯一记录清除能力。
 * 2. 模拟数据库重建场景：本地保留旧密钥缓存，远端返回 403 Invalid secret_key 时：
 *    - secretCheck 自动清除本地失效密钥缓存
 *    - 再次调用 secretCheck 时，断言系统已无可用密钥，返回 EMPTY 并提示用户手动填入
 * 3. 覆盖所有涉及 Secret Key 的 5 个入口：
 *    - secret_check (db_tools.js)
 *    - clean_probes (r2.js)
 *    - storage_list (r2.js -> r2List)
 *    - storage_delete (r2.js -> r2Delete)
 *    - storage_upload (r2.js -> r2Upload 的 REST 分支 + MCP 回退)
 *
 * 【Mock 说明——本测试是纯离线测试，零真实网络】
 * - REST 通道：全局 stub `globalThis.fetch`，统一返回 403 Invalid secret_key，
 *   且同时提供 `.text()`（r2.js 的 rest() 用它解析）、`.json()`（db_tools.js 的
 *   secretCheck 用它解析）、`.status` 与 `.statusText`。
 * - MCP 通道：stub `NcbMcp.prototype.callTool`。r2Upload 在 REST 403 后会按生产
 *   逻辑平滑降级到 MCP `upload_file` 回退上传；不 stub 就会走到真实网络（或因
 *   被 stub 的 fetch 返回 403 而抛 "MCP key 无效" 导致测试崩溃）。stub 返回一
 *   个伪造的成功上传结果，并记录调用，断言回退路径确实被走过。
 *
 * 【隔离性与零残留】
 * 测试期间备份本地 state.json，并在 finally 中彻底还原（fetch 与 callTool 的
 * stub 同样在 finally 中还原），零残留。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const { lookupSecret, rememberSecret, forgetSecret, rememberR2Mount, readState } = await import(
  new URL("../local_state.js", import.meta.url).href
);
const { secretCheck } = await import(new URL("../db_tools.js", import.meta.url).href);
const { r2List, r2Delete, cleanProbes, r2Upload } = await import(
  new URL("../r2.js", import.meta.url).href
);
const { NcbMcp } = await import(new URL("../ncb_mcp.js", import.meta.url).href);

const candidate = [
  path.join(os.homedir(), ".magpie-memory-hub", "state.json"),
  "/config/home/.magpie-memory-hub/state.json",
].find((p) => fs.existsSync(p)) || path.join(os.homedir(), ".magpie-memory-hub", "state.json");

let origState = null;
let testFailures = 0;

function check(desc, cond) {
  if (!cond) {
    testFailures++;
    console.error(`  ✗ FAIL: ${desc}`);
  } else {
    console.log(`  ✓ PASS: ${desc}`);
  }
}

try {
  origState = fs.existsSync(candidate) ? fs.readFileSync(candidate, "utf8") : null;
  fs.mkdirSync(path.dirname(candidate), { recursive: true });

  console.log("\n--- [1] 单元测试: forgetSecret 对称清除能力 ---");
  // 准备多条密钥
  fs.writeFileSync(
    candidate,
    JSON.stringify({
      current: "41694_agent_memory",
      secrets: {
        "41694_agent_memory": { v: "SEC-OLD-1", at: 1 },
        "other_database": { v: "SEC-OTHER", at: 2 },
      },
    })
  );

  // 1. 归一化清除测试（传 agent_memory 清除 41694_agent_memory）
  // 注意：不能用 lookupSecret("41694_agent_memory") === "" 来断言“已清除”，因为
  // lookupSecret 有“唯一记录兜底”语义——删剩一条时查任意库名都会兜底命中剩下的那条。
  // 直接检查 state.secrets 的键才是精准断言（更严格，而非放水）。
  const removedNorm = forgetSecret("agent_memory");
  check("归一化匹配清除成功", removedNorm === true);
  const afterNorm = (readState().secrets) || {};
  check("41694_agent_memory 记录已被清除", !("41694_agent_memory" in afterNorm));
  check("未关联库 other_database 保持不变", lookupSecret("other_database") === "SEC-OTHER");

  // 2. 唯一记录兜底清除测试
  const removedFallback = forgetSecret("");
  check("空参数唯一记录兜底清除成功", removedFallback === true);
  const afterFallback = (readState().secrets) || {};
  check("所有密钥记录已被清空", Object.keys(afterFallback).length === 0);
  check("清空后 lookupSecret 已无任何返回", lookupSecret("other_database") === "" && lookupSecret("41694_agent_memory") === "");

  console.log("\n--- [2] 反证测试: 403 触发 secretCheck 自动清除 + 再次调用提示手动填写 ---");
  const origFetch = globalThis.fetch;
  const origCallTool = NcbMcp.prototype.callTool;
  let mcpCalls = [];
  try {
    // 写入模拟的重建前失效旧密钥
    fs.writeFileSync(
      candidate,
      JSON.stringify({
        current: "41694_agent_memory",
        secrets: {
          "41694_agent_memory": { v: "SEC-STALE-KEY-403", at: Date.now() },
        },
      })
    );

    // 此时本地存在自动捕获的旧密钥
    check("调用前本地存在缓存旧密钥", lookupSecret("41694_agent_memory") === "SEC-STALE-KEY-403");

    // 模拟远端 REST 返回 403 Invalid secret_key。
    // 必须同时提供 .text()（r2.js rest() 用它做 JSON.parse）和 .json()
    //（db_tools.js secretCheck 用它解析），否则会 TypeError 崩溃。
    globalThis.fetch = async () => ({
      status: 403,
      statusText: "Forbidden",
      headers: { get: () => null },
      text: async () => JSON.stringify({ status: "failed", error: "Invalid secret_key." }),
      json: async () => ({ status: "failed", error: "Invalid secret_key." }),
    });

    // stub MCP 通道：r2Upload 在 REST 403 后会按生产逻辑降级走 MCP upload_file
    // 回退；不 stub 就会打到真实网络（或被上面的 fetch stub 以 403 挡掉而抛错）。
    // stub 只返回伪造的成功上传，并记录调用以供断言回退路径确实被执行。
    NcbMcp.prototype.callTool = async function (name, args, asJson) {
      mcpCalls.push({ name, args });
      if (name === "list_databases") return "- 41694_agent_memory\n";
      return { ok: true, url: "https://mocked.example/test.txt", key: "test.txt" };
    };

    // 第一次调用：检测失效密钥
    const checkRes1 = await secretCheck({ instance: "agent_memory" }, {});
    check("第一次调用检测失败 ok === false", checkRes1.ok === false);
    check("判定类型为 INVALID", checkRes1.verdict === "INVALID");
    check("来源标注为已失效已自动清除", checkRes1.source.includes("自动捕获（已失效，已自动清除）"));
    check("反证核心：调用后本地失效缓存被立即清除", lookupSecret("41694_agent_memory") === "");
    check("提示文案包含自动清除说明", checkRes1.lines.some((l) => l.includes("已自动清除本地缓存的失效密钥")));

    // 第二次调用：再次调用，断言缓存已被清除，进入未提供状态并提示去控制台复制
    const checkRes2 = await secretCheck({ instance: "agent_memory" }, {});
    check("第二次调用结果 ok === false", checkRes2.ok === false);
    check("反证核心：由于缓存已被清除，第二次调用判为 EMPTY", checkRes2.verdict === "EMPTY");
    check("第二次调用来源为未提供", checkRes2.source === "未提供");
    check("第二次调用明确引导去控制台手动复制", checkRes2.lines.some((l) => l.includes("NoCodeBackend 控制台")));

    console.log("\n--- [3] 入口覆盖测试: cleanProbes 遇 403 自动清除缓存 ---");
    // 重新写入旧密钥和挂载记录
    rememberSecret("41694_agent_memory", "SEC-STALE-FOR-PROBE");
    rememberR2Mount("41694_agent_memory", { bucket: "41694-agent-memory", public_url: "", at: Date.now() });
    check("准备工作：已写入旧密钥", lookupSecret("41694_agent_memory") === "SEC-STALE-FOR-PROBE");

    const probeRes = await cleanProbes({ instance: "agent_memory" }, {});
    check("cleanProbes 返回失败", probeRes.ok === false);
    check("cleanProbes 返回 AUTH_FAILED", probeRes.action === "AUTH_FAILED");
    check("cleanProbes 403 后本地旧密钥被清除", lookupSecret("41694_agent_memory") === "");
    check("cleanProbes 包含自动清除指引", probeRes.lines.some((l) => l.includes("已自动清除本地缓存的失效密钥")));

    console.log("\n--- [4] 入口覆盖测试: storage_list (r2List) 遇 403 自动清除缓存 ---");
    rememberSecret("41694_agent_memory", "SEC-STALE-FOR-LIST");
    check("准备工作：已写入旧密钥", lookupSecret("41694_agent_memory") === "SEC-STALE-FOR-LIST");

    const listRes = await r2List({ instance: "agent_memory", secret: lookupSecret("agent_memory") }, {});
    check("r2List 返回失败", listRes.ok === false);
    check("r2List 403 后本地旧密钥被清除", lookupSecret("41694_agent_memory") === "");
    check("r2List hint 提示已自动清除本地失效密钥缓存", listRes.hint.includes("已自动清除本地失效密钥缓存"));

    console.log("\n--- [5] 入口覆盖测试: storage_delete (r2Delete) 遇 403 自动清除缓存 ---");
    rememberSecret("41694_agent_memory", "SEC-STALE-FOR-DEL");
    check("准备工作：已写入旧密钥", lookupSecret("41694_agent_memory") === "SEC-STALE-FOR-DEL");

    const delRes = await r2Delete({ instance: "agent_memory", secret: lookupSecret("agent_memory") }, { key: "dummy.txt", confirm: "DELETE" });
    check("r2Delete 返回失败", delRes.ok === false);
    check("r2Delete 403 后本地旧密钥被清除", lookupSecret("41694_agent_memory") === "");
    check("r2Delete hint 提示已自动清除本地失效密钥缓存", delRes.hint.includes("已自动清除本地失效密钥缓存"));

    console.log("\n--- [6] 入口覆盖测试: storage_upload (r2Upload REST) 遇 403 自动清除缓存 ---");
    rememberSecret("41694_agent_memory", "SEC-STALE-FOR-UPLOAD");
    rememberR2Mount("41694_agent_memory", { bucket: "41694-agent-memory", public_url: "", at: Date.now() });
    check("准备工作：已写入旧密钥", lookupSecret("41694_agent_memory") === "SEC-STALE-FOR-UPLOAD");

    // 上传时传入 secret，走 REST 分支，遇到 403 时清除本地失效 secret，并平滑回退到 MCP。
    // MCP 通道已被上面 stub（伪造成功上传），因此全程零真实网络。
    mcpCalls = [];
    const uploadRes = await r2Upload(
      { instance: "agent_memory", secret: lookupSecret("agent_memory"), mcpKey: "test_mcp" },
      { filename: "test.txt", content: "test-content" }
    );
    check("r2Upload REST 403 后降级走了 MCP 回退", mcpCalls.some((c) => c.name === "upload_file"));
    check("r2Upload MCP 回退上传成功", uploadRes.ok === true);
    check("r2Upload REST 分支遇到 403 后清除本地旧密钥", lookupSecret("41694_agent_memory") === "");

  } finally {
    globalThis.fetch = origFetch;
    NcbMcp.prototype.callTool = origCallTool;
  }
} finally {
  try {
    if (origState !== null) {
      fs.writeFileSync(candidate, origState);
    } else if (fs.existsSync(candidate)) {
      fs.unlinkSync(candidate);
    }
    console.log("\n✓ 测试完成，已安全还原本地状态文件，无任何测试残留。");
  } catch (err) {
    console.error("还原测试状态文件失败:", err);
  }
}

// 严谨退出与断言门禁
assert.strictEqual(testFailures, 0, `共有 ${testFailures} 项断言失败`);
console.log("\n🎉 [PASS] 所有 403 失效密钥清除与反证测试全部通过！");
process.exit(0);
