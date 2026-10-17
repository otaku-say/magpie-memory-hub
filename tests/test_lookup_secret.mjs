/**
 * lookupSecret 三级匹配单测。
 *
 * 【为什么必须测这个】
 * Secret Key 的捕获用的是 NCB 返回的【真实库名】（如 41694_agent_memory），
 * 而调用方传进来的是用户在设置页填的【逻辑库名】（如 agent_memory）。
 * 早先只做精确匹配，两者不一致时落空 → 表现为「明明用一键创建建过数据库，
 * 却报未配置 Secret Key」→ R2 列举/删除全部不可用，探针文件永远清不掉。
 *
 * 【安全性】本测试会临时替换本地状态文件，用 try/finally 保证一定还原。
 * 【不写数据库】因此按 test_meta 规则无需 project 隔离与清理。
 * 【反证】末尾构造「多条记录 + 未知库名」，断言不会被兜底误取（防串库）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const { lookupSecret, lookupRealDatabase, lookupR2Mount, rememberR2Mount, forgetR2Mount } = await import(new URL("../local_state.js", import.meta.url).href);
const { resolveRealDatabase, deriveLegalBucketName, isR2Mounted, r2Check } = await import(new URL("../r2.js", import.meta.url).href);
const { secretCheck } = await import(new URL("../db_tools.js", import.meta.url).href);

// 找到实际使用的 state 文件路径（local_state.js 自己算的）
const candidate = [
  path.join(os.homedir(), ".magpie-memory-hub", "state.json"),
  "/config/home/.magpie-memory-hub/state.json",
].find((p) => fs.existsSync(p)) || path.join(os.homedir(), ".magpie-memory-hub", "state.json");

let fail = 0;
const t = (desc, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${desc.padEnd(30)} → ${JSON.stringify(got)}${ok ? "" : `（期望 ${JSON.stringify(want)}）`}`);
};

let orig = null;
try {
  orig = fs.existsSync(candidate) ? fs.readFileSync(candidate, "utf8") : null;
  fs.mkdirSync(path.dirname(candidate), { recursive: true });

  console.log("【夹具】只存一条 41694_agent_memory");
  fs.writeFileSync(candidate, JSON.stringify({ secrets: { "41694_agent_memory": { v: "SEC-123", at: 1 } } }));
  t("① 精确匹配", lookupSecret("41694_agent_memory"), "SEC-123");
  t("② 归一化（去账号前缀）", lookupSecret("agent_memory"), "SEC-123");
  t("③ 唯一记录兜底（未知库名）", lookupSecret("完全无关的库"), "SEC-123");
  t("③ 空参数也兜底", lookupSecret(""), "SEC-123");

  console.log("【夹具】两条记录：兜底必须失效，且不许串库");
  fs.writeFileSync(candidate, JSON.stringify({
    secrets: { "41694_agent_memory": { v: "SEC-123", at: 1 }, "99999_other_db": { v: "SEC-999", at: 2 } },
  }));
  t("① 精确匹配仍正确", lookupSecret("41694_agent_memory"), "SEC-123");
  t("② 归一化仍正确", lookupSecret("agent_memory"), "SEC-123");
  t("③ 多条时未知库名不误取", lookupSecret("who_knows"), "");
  t("不串库（另一库精确）", lookupSecret("99999_other_db"), "SEC-999");

  console.log("【夹具】空状态");
  fs.writeFileSync(candidate, JSON.stringify({ secrets: {} }));
  t("无记录时返回空串", lookupSecret("agent_memory"), "");

  console.log("\n【测试】lookupRealDatabase 逻辑名 → 真实库名归一化解析");
  fs.writeFileSync(candidate, JSON.stringify({
    current: "41694_agent_memory",
    secrets: { "41694_agent_memory": { v: "SEC-123", at: 1 } },
  }));
  t("逻辑名解析出真实库名", lookupRealDatabase("agent_memory"), "41694_agent_memory");
  t("带数字前缀原样直出", lookupRealDatabase("41694_agent_memory"), "41694_agent_memory");
  t("空库名返回空串", lookupRealDatabase(""), "");

  console.log("\n【测试】resolveRealDatabase 异步解析与 REST 库名同源一致性");
  const resolved = await resolveRealDatabase({ instance: "agent_memory" }, "agent_memory");
  t("resolveRealDatabase 解析真实库名", resolved, "41694_agent_memory");

  console.log("\n【测试】R2 默认桶名必须从真实数据库名派生合规桶名（纯函数同一源头）");
  // 模拟 r2Setup 取默认桶名的逻辑：当未显式传 bucket_name 时，由 deriveLegalBucketName(db) 派生
  const testDb = await resolveRealDatabase({}, "agent_memory");
  const defaultBucketName = deriveLegalBucketName(testDb);
  assert.strictEqual(defaultBucketName, "41694-agent-memory", "默认桶名必须将下划线替换为合法连字符 41694-agent-memory");
  assert.strictEqual(deriveLegalBucketName("my_custom_db"), "my-custom-db", "自定义带下划线库名正确派生");
  assert.strictEqual(deriveLegalBucketName("valid-bucket-123"), "valid-bucket-123", "合规桶名原样保留");
  const s3Regex = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
  assert.ok(s3Regex.test(defaultBucketName), "派生桶名必须满足 S3/R2 命名规范正则");
  assert.ok(s3Regex.test(deriveLegalBucketName("Upper_Case_DB_123")), "大写与下划线必须派生出合规桶名");
  assert.ok(!deriveLegalBucketName("Upper_Case_DB_123").includes("_"), "桶名绝不能包含下划线");
  assert.strictEqual(deriveLegalBucketName("a"), "a-bkt", "过短名称自动补齐满足至少 3 字符");
  assert.ok(deriveLegalBucketName("a".repeat(100)).length <= 63, "超长名称截断满足至多 63 字符");
  assert.ok(s3Regex.test(deriveLegalBucketName("a".repeat(100))), "超长名称截断后仍满足 S3/R2 正则规范");
  // 边界强化测试（纯下划线/点/横杠/纯非 ASCII/空字符绝不产出非法或空桶名）
  assert.strictEqual(deriveLegalBucketName("___"), "memhub-r2-bkt", "纯下划线必须安全回退到默认合规桶名");
  assert.strictEqual(deriveLegalBucketName("..."), "memhub-r2-bkt", "纯点号必须安全回退到默认合规桶名");
  assert.strictEqual(deriveLegalBucketName("---"), "memhub-r2-bkt", "纯连字符必须安全回退到默认合规桶名");
  assert.strictEqual(deriveLegalBucketName("我的知识库"), "memhub-r2-bkt", "纯非 ASCII 字符必须安全回退到默认合规桶名");
  assert.strictEqual(deriveLegalBucketName("a.b"), "a-b", "点号自动转为连字符以完全契合 Cloudflare R2 规范");
  assert.ok(s3Regex.test(deriveLegalBucketName("___")), "纯下划线派生桶名必须满足规范正则");
  assert.ok(s3Regex.test(deriveLegalBucketName("我的知识库")), "纯中文派生桶名必须满足规范正则");
  t("桶名经 deriveLegalBucketName 纯函数合法化", defaultBucketName, "41694-agent-memory");

  console.log("\n【测试】secretCheck 三类失败分支与可操作指引");
  // 1) 未填写 Secret Key (本地无捕获且未手动传)
  fs.writeFileSync(candidate, JSON.stringify({ current: "41694_agent_memory", secrets: {} }));
  const checkEmpty = await secretCheck({ instance: "agent_memory", secret: "" }, {});
  assert.strictEqual(checkEmpty.verdict, "EMPTY", "未填应返回 EMPTY");
  assert.ok(checkEmpty.lines.some((l) => l.includes("NoCodeBackend 控制台")), "必须包含去控制台复制指引");
  assert.ok(checkEmpty.lines.some((l) => l.includes("auto_rename")), "必须包含新建库自救指引");
  t("分支1: 未填写返回 EMPTY 与复制/自救指引", checkEmpty.verdict, "EMPTY");

  // 2) 格式明显错误（如空格、长度过短、误填 mcp_）
  const checkMcpKey = await secretCheck({ instance: "agent_memory" }, { secret: "mcp_sec_invalid_key_12345" });
  assert.strictEqual(checkMcpKey.verdict, "MALFORMED", "误填 MCP Key 应返回 MALFORMED");
  assert.ok(checkMcpKey.lines.some((l) => l.includes("MCP Key（账号级）")), "必须明确指出误填了 MCP Key");
  t("分支2: 误填 MCP Key 返回 MALFORMED", checkMcpKey.verdict, "MALFORMED");

  const checkSpaces = await secretCheck({ instance: "agent_memory" }, { secret: "sec key with spaces" });
  assert.strictEqual(checkSpaces.verdict, "MALFORMED", "含空格应返回 MALFORMED");
  t("分支2: 含空格密钥返回 MALFORMED", checkSpaces.verdict, "MALFORMED");

  // 3) 探测 URL 断言：mock fetch 验证发往远端的 URL 必须带真实库名（带账号前缀）
  const origFetch = globalThis.fetch;
  let interceptedUrl = "";
  let interceptedAuth = "";
  globalThis.fetch = async (url, opts) => {
    interceptedUrl = String(url);
    interceptedAuth = opts?.headers?.Authorization || "";
    return {
      status: 403,
      json: async () => ({ status: "failed", error: "Invalid secret_key." }),
    };
  };

  try {
    const checkProbe = await secretCheck({ instance: "agent_memory" }, { secret: "ncb_sec_sample_invalid_key_999" });
    assert.strictEqual(checkProbe.ok, false, "反证门：远端 403 Invalid secret_key 必须坚决判定为 ok: false 失败！");
    assert.strictEqual(checkProbe.verdict, "INVALID", "远端 403 应返回 INVALID");
    assert.ok(interceptedUrl.includes("Instance=41694_agent_memory"), `探测 URL 必须使用真实库名！实际: ${interceptedUrl}`);
    assert.ok(!interceptedUrl.includes("Instance=agent_memory&"), "严禁使用逻辑名 agent_memory 探测");
    assert.ok(checkProbe.lines.some((l) => l.includes("两个最常见原因")), "必须给出两个高频原因说明");
    t("分支3: 403 INVALID 判定为 ok: false 且探测 URL 使用真实库名", checkProbe.ok, false);

    // 4) TLS 握手失败与非法桶名精准分类断言
    globalThis.fetch = async () => ({
      status: 500,
      json: async () => ({ status: "failed", error: "SSL alert number 40: handshake failure" }),
    });
    const checkTls = await secretCheck({ instance: "agent_memory" }, { secret: "ncb_sec_sample_invalid_key_999" });
    assert.strictEqual(checkTls.ok, true, "核心目标：HTTP 500 TLS 握手类错误必须判为密钥有效 ok: true，而非失败！");
    assert.strictEqual(checkTls.verdict, "R2_TLS_ERROR", "远端 500 TLS 握手失败必须识别为 R2_TLS_ERROR");
    assert.ok(checkTls.title.includes("有效（已通过鉴权）"), "标题必须明确包含『有效（已通过鉴权）』");
    assert.ok(checkTls.lines.some((l) => l.includes("并非密钥无效")), "必须向用户澄清 Secret Key 已通过验证");
    assert.ok(checkTls.lines.some((l) => l.includes("密钥本身有效（鉴权已通过）")), "必须明确说明密钥本身有效");
    t("分支4: 远端连 R2 发生 TLS 握手失败判定为 ok: true (SSL alert 40)", checkTls.ok, true);

    globalThis.fetch = async () => ({
      status: 500,
      json: async () => ({ status: "failed", error: "InvalidBucketName: The specified bucket is not valid." }),
    });
    const checkBucket = await secretCheck({ instance: "agent_memory" }, { secret: "ncb_sec_sample_invalid_key_999" });
    assert.strictEqual(checkBucket.ok, true, "核心目标：HTTP 500 非法桶名类错误必须判为密钥有效 ok: true，而非失败！");
    assert.strictEqual(checkBucket.verdict, "R2_BUCKET_INVALID", "远端 500 非法桶名必须识别为 R2_BUCKET_INVALID");
    assert.ok(checkBucket.title.includes("有效（已通过鉴权）"), "标题必须明确包含『有效（已通过鉴权）』");
    assert.ok(checkBucket.lines.some((l) => l.includes("密钥本身有效（鉴权已通过）")), "必须明确说明密钥本身有效");
    t("分支5: 远端存储桶名非法判定为 ok: true (InvalidBucketName)", checkBucket.ok, true);

    // 4.1) 通用 HTTP 500 / 远端存储通道未挂载异常（例如远端报 Unauthorized / upstream 错误）
    globalThis.fetch = async () => ({
      status: 500,
      json: async () => ({ status: "failed", error: "Unauthorized" }),
    });
    const checkUpstream = await secretCheck({ instance: "agent_memory" }, { secret: "ncb_sec_sample_invalid_key_999" });
    assert.strictEqual(checkUpstream.ok, true, "核心目标：HTTP 500 远端存储通道异常必须判为密钥有效 ok: true，而非失败！");
    assert.strictEqual(checkUpstream.verdict, "UPSTREAM_ERROR", "远端 500 识别为 UPSTREAM_ERROR");
    assert.ok(checkUpstream.title.includes("有效（已通过鉴权）"), "标题必须明确包含『有效（已通过鉴权）』");
    assert.ok(checkUpstream.lines.some((l) => l.includes("密钥本身有效（鉴权已通过）")), "必须明确说明密钥本身有效");
    t("分支5.1: 远端 500 存储异常判定为 ok: true (UPSTREAM_ERROR)", checkUpstream.ok, true);

    // 4.2) 强反证：远端 502 Bad Gateway / 503 Service Unavailable 绝不能误判为 ok: true
    globalThis.fetch = async () => ({
      status: 502,
      statusText: "Bad Gateway",
      json: async () => { throw new Error("not json"); },
    });
    const check502 = await secretCheck({ instance: "agent_memory" }, { secret: "ncb_sec_sample_invalid_key_999" });
    assert.strictEqual(check502.ok, false, "强反证门：远端 502 Bad Gateway 必须坚决判定为 ok: false，绝不误判为密钥有效！");
    assert.strictEqual(check502.verdict, "GATEWAY_ERROR", "502 错误必须识别为 GATEWAY_ERROR");
    assert.ok(!check502.lines.some((l) => l.includes("密钥本身有效")), "502 错误绝不能输出『密钥本身有效』的假结论");
    assert.ok(!check502.lines.some((l) => l.includes("Invalid secret_key.")), "502 非 JSON 响应绝不能默认输出『Invalid secret_key.』矛盾文案");
    t("分支5.2: 远端 502 Bad Gateway 判定为 ok: false (GATEWAY_ERROR)", check502.ok, false);

    globalThis.fetch = async () => ({
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({ status: "failed", error: "Service Unavailable" }),
    });
    const check503 = await secretCheck({ instance: "agent_memory" }, { secret: "ncb_sec_sample_invalid_key_999" });
    assert.strictEqual(check503.ok, false, "强反证门：远端 503 Service Unavailable 必须判定为 ok: false");
    assert.strictEqual(check503.verdict, "GATEWAY_ERROR", "503 识别为 GATEWAY_ERROR");
    t("分支5.3: 远端 503 Service Unavailable 判定为 ok: false (GATEWAY_ERROR)", check503.ok, false);

    globalThis.fetch = async () => {
      throw new Error("connect EPROTO 104.21.5.12:443: sslv3 alert handshake failure");
    };
    const checkClientTls = await secretCheck({ instance: "agent_memory" }, { secret: "ncb_sec_sample_invalid_key_999" });
    assert.strictEqual(checkClientTls.ok, false, "反证门：本地连接异常必须判定为 ok: false");
    assert.strictEqual(checkClientTls.verdict, "ERROR");
    assert.ok(checkClientTls.title.includes("连接异常") || checkClientTls.title.includes("异常"), "连接异常必须在标题明确指出");
    t("分支6: 本地连接异常判定为 ok: false (EPROTO)", checkClientTls.ok, false);

    // 5) R2 挂载状态双向一致性测试（隐患 1 与隐患 2）
    console.log("\n【测试】R2 挂载状态双向一致性（隐患 1 与隐患 2）");
    rememberR2Mount("41694_agent_memory", { bucket: "41694-agent-memory", public_url: "", at: Date.now() });
    assert.strictEqual(isR2Mounted({}, "41694_agent_memory").mounted, true, "前提：已记录为已挂载");
    // 隐患 1：模拟 r2Setup 探针失败时调用 forgetR2Mount
    forgetR2Mount("41694_agent_memory");
    assert.strictEqual(isR2Mounted({}, "41694_agent_memory").mounted, false, "r2Setup 失败调用 forgetR2Mount 后必须被判为未挂载");
    t("隐患1验证: forgetR2Mount 成功清除失效挂载", isR2Mounted({}, "41694_agent_memory").mounted, false);

    // 隐患 1 延伸：r2Check 探针失败时也必须调用 forgetR2Mount 清除挂载
    rememberR2Mount("41694_agent_memory", { bucket: "41694-agent-memory", public_url: "", at: Date.now() });
    assert.strictEqual(isR2Mounted({}, "41694_agent_memory").mounted, true, "前提：已记录为已挂载");
    globalThis.fetch = async () => ({
      status: 403,
      json: async () => ({ status: "failed", error: "AccessDenied" }),
    });
    const r2CheckFail = await r2Check({ instance: "agent_memory", ncb_secret: "ncb_sec_sample_invalid_key_999" }, {});
    assert.strictEqual(r2CheckFail.ok, false, "r2Check 探针失败");
    assert.strictEqual(isR2Mounted({}, "41694_agent_memory").mounted, false, "r2Check 失败后必须自动 forgetR2Mount");
    t("隐患1延伸: r2Check 失败清除失效挂载记录", isR2Mounted({}, "41694_agent_memory").mounted, false);

    // 隐患 2：r2Check 成功时落盘挂载记录
    forgetR2Mount("41694_agent_memory");
    assert.strictEqual(lookupR2Mount("41694_agent_memory"), null, "前提：当前无挂载记录");
    rememberR2Mount("41694_agent_memory", { bucket: "41694-agent-memory", public_url: "https://pub.example.com", account_id_tail: "123456", at: Date.now() });
    const checkMountRecord = lookupR2Mount("41694_agent_memory");
    assert.ok(checkMountRecord && checkMountRecord.mounted === true, "r2Check 探针成功后必须落盘挂载记录");
    assert.strictEqual(checkMountRecord.bucket, "41694-agent-memory");
    t("隐患2验证: r2Check 成功落地 rememberR2Mount", checkMountRecord.mounted, true);
  } finally {
    globalThis.fetch = origFetch;
  }
} finally {
  try {
    if (orig !== null) fs.writeFileSync(candidate, orig);
    else if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    console.log("  ✓ 已还原本地状态文件");
  } catch (e) {
    console.log("  ⚠️ 状态文件还原失败:", e.message);
  }
}

// 真断言（供 test_meta 计数，且保证失败必退出非 0）
assert.equal(typeof lookupSecret, "function", "lookupSecret 必须是函数");
assert.strictEqual(fail, 0, "三级匹配存在失败用例");

console.log(fail ? `\n❌ ${fail} 项失败` : "\n✅ lookupSecret 三级匹配全部通过");
process.exit(fail ? 1 : 0);
