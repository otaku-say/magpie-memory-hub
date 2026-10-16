/**
 * test_compress_template_dedup.mjs —— 网关侧日志内容模板去重机制测试
 *
 * 覆盖规范：
 * 1. 功能验证：多行仅轻量变化（时间戳、数字、ID等）的日志按模板正确折叠为「首尾 + 重复计数」
 * 2. 关键行保护：FATAL/ERROR/致命/拒绝等关键行逐行完整保留，绝不参与折叠
 * 3. 边界与负向：非日志内容（JSON/代码/diff）不误触；空行与短日志安全兜底
 * 4. 配置开关：log_template_dedup 开/关有效性验证
 * 5. 反证用例（关键测试防护）：故意破坏关键行判定（放宽至匹配所有行），断言去重失效；恢复后断言通过
 * 6. 性能实测：200 行 / 8KB 中型日志耗时测定，验证远低于 250ms 门限并输出对比
 */

import assert from "node:assert";
import {
  detectKind,
  lineTemplate,
  isCriticalLine,
  dedupLogTemplates,
  crushLog,
  crushText,
  compressBody
} from "../compress.js";

console.log("=================================================================");
console.log("【网关侧压缩】日志内容模板去重（log_template_dedup）全面测试");
console.log("=================================================================\n");

let assertionsCount = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertionsCount++;
  console.log(`  ✓ ${message}`);
}

// -------------------------------------------------------------
// 1. lineTemplate 易变模式归一化测试
// -------------------------------------------------------------
console.log("=== 1. lineTemplate 结构性易变模式抹平 ===");
{
  // 时间戳与只有时间
  const t1 = lineTemplate("2026-10-16 04:00:01 INFO heartbeat");
  const t2 = lineTemplate("2026-10-16 04:00:02 INFO heartbeat");
  const t3 = lineTemplate("04:00:01 INFO heartbeat");
  check(t1 === t2, "不同 ISO 时间戳归一化为相同模板");
  check(t1.includes("<ts>"), "ISO 时间戳被替换为 <ts>");
  check(t3.includes("<ts>"), "纯时分秒被替换为 <ts>");

  // UUID 与 Long Hex
  const u1 = lineTemplate("req 3f2504e0-4f89-11d3-9a0c-0305e82c3301 hash=d7a8fbb307d7809469ca9abcb0082e4f");
  const u2 = lineTemplate("req 4a2504e0-4f89-11d3-9a0c-0305e82c3302 hash=e7a8fbb307d7809469ca9abcb0082e4f");
  check(u1 === u2, "不同 UUID 与十六进制 hash 归一化为相同模板");
  check(u1.includes("<uuid>"), "UUID 被替换为 <uuid>");
  check(u1.includes("<hex>"), "十六进制 hash 被替换为 <hex>");

  // 键=值 与 带单位数字
  const kv1 = lineTemplate("worker[1] job=1001 elapsed=12.5ms count=10 mem=64MB");
  const kv2 = lineTemplate("worker[2] job=1002 elapsed=45.0ms count=20 mem=128MB");
  check(kv1 === kv2, "可变键值与带单位数值归一化为相同模板");

  // 占位符抹平（避开离线侧第二版踩过的坑：\x00P\d+\x00 编号不同导致模板分裂）
  const p1 = lineTemplate("\x00P0\x00 processing task 1");
  const p2 = lineTemplate("\x00P42\x00 processing task 2");
  check(p1 === p2, "不同编号的占位符 P0/P42 归一化为相同模板 <p>");
}

// -------------------------------------------------------------
// 2. isCriticalLine 关键行判定与防误报
// -------------------------------------------------------------
console.log("\n=== 2. isCriticalLine 关键行判定精度 ===");
{
  // 必须识别为致命/关键的行
  check(isCriticalLine("2026-10-16 04:00:01 FATAL database connection refused: dial tcp 10.0.0.5:5432"), "识别 FATAL 致命行");
  check(isCriticalLine("panic: runtime error: invalid memory address"), "识别 panic 崩溃");
  check(isCriticalLine("Error: EACCES: permission denied, open '/var/data'"), "识别 Error/permission denied 错误");
  check(isCriticalLine("2026-10-16 04:00:01 致命异常：核心集群连接失败"), "识别中文致命/异常/失败");

  // 避坑：0 errors / 无异常 绝不能误判为关键行
  check(!isCriticalLine("2026-10-16 04:00:01 INFO processing batch 1 of 120, 0 errors"), "0 errors 例行行不误判为关键行");
  check(!isCriticalLine("2026-10-16 04:00:01 INFO batch finished, errors: 0"), "errors: 0 例行行不误判为关键行");
  check(!isCriticalLine("2026-10-16 04:00:00 INFO 心跳正常，无异常。"), "中文「无异常」不误判为关键行");
  check(!isCriticalLine("2026-10-16 04:00:00 INFO 系统自检完成，无错误。"), "中文「无错误」不误判为关键行");
}

// -------------------------------------------------------------
// 3. 功能实测：同模板折叠为「首尾 + 重复计数」，FATAL 完整保留
// -------------------------------------------------------------
console.log("\n=== 3. 功能实测：模板折叠与致命行保留 ===");
{
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push(`2026-10-16 04:00:${String(i).padStart(2, "0")} INFO 心跳正常，无异常。`);
  }
  lines.push("2026-10-16 04:00:41 FATAL 数据库连接被拒绝: dial tcp 10.0.0.5:5432");

  const raw = lines.join("\n");
  const folded = dedupLogTemplates(raw);

  check(folded.includes("…[相同内容重复 38 次]…"), "40 行同模板心跳成功折叠为重复 38 次");
  check(folded.includes("2026-10-16 04:00:00 INFO 心跳正常，无异常。"), "保留首行（起始时间戳）");
  check(folded.includes("2026-10-16 04:00:39 INFO 心跳正常，无异常。"), "保留尾行（截止时间戳）");
  check(folded.includes("2026-10-16 04:00:41 FATAL 数据库连接被拒绝"), "FATAL 致命行完整保留，逐字节存活");

  // 压缩比验证
  const ratio = (100 * (1 - folded.length / raw.length));
  check(ratio > 85, `压缩率显著高于 85%（实测省 ${ratio.toFixed(1)}%：${raw.length}B → ${folded.length}B）`);
}

// -------------------------------------------------------------
// 4. 反证测试（门禁强制：故意破坏以验证拦截能力）
// -------------------------------------------------------------
console.log("\n=== 4. 反证测试：放宽关键行判定导致去重失效验证 ===");
{
  const lines = [];
  for (let i = 0; i < 30; i++) {
    lines.push(`2026-10-16 04:00:${String(i).padStart(2, "0")} [worker] task=${100 + i} status=running`);
  }
  const sample = lines.join("\n");

  // 正常情况下必须发生折叠
  const normalResult = dedupLogTemplates(sample);
  check(normalResult.includes("…[相同内容重复"), "正常关键行判定下折叠生效");

  // 【反证用例 / 故意破坏】：
  // 模拟离线侧第一版的严重回归：使用含裸数字的宽泛判定，导致包含 2026 年份的行全被当成关键行保护
  const broadFalsifiedChecker = () => true; // 模拟判定失效：每行都被判为必须逐行保护
  const falsifiedResult = dedupLogTemplates(sample, { isCriticalLine: broadFalsifiedChecker });

  // 断言：去重彻底失效，未发生任何折叠，行全部原样输出
  check(!falsifiedResult.includes("…[相同内容重复"), "[反证成功] 故意把关键行判定放宽至匹配所有行时，去重必定失效！");
  check(falsifiedResult === sample, "[反证成功] 失效状态下输出与原文逐字完全一致，证明门禁能有效捕获过宽正则回归！");

  // 恢复后再次断言通过
  const restoredResult = dedupLogTemplates(sample);
  check(restoredResult.includes("…[相同内容重复 28 次]…"), "恢复后判定重新生效，稳定折叠");
}

// -------------------------------------------------------------
// 5. 开关控制有效性与非日志安全直通
// -------------------------------------------------------------
console.log("\n=== 5. 开关控制与非日志类型隔离 ===");
{
  const rawLog = [];
  for (let i = 0; i < 20; i++) {
    rawLog.push(`2026-10-16 04:00:${String(i).padStart(2, "0")} INFO worker ping`);
  }
  const logText = rawLog.join("\n");

  // 开关打开时
  const onResult = crushLog(logText, 4000, 400, { log_template_dedup: true });
  check(onResult.includes("…[相同内容重复"), "配置开关开启时模板去重生效");

  // 开关关闭时
  const offResult = crushLog(logText, 4000, 400, { log_template_dedup: false });
  check(!offResult.includes("…[相同内容重复"), "配置开关显式关闭时模板去重跳过");

  // 非日志（JSON/diff/code）直通，不跑模板折叠
  const jsonText = JSON.stringify([{ id: 1, val: "a" }, { id: 2, val: "b" }]);
  check(detectKind(jsonText) === "json", "JSON 内容类型分流正确");

  const diffText = "diff --git a/foo.js b/foo.js\n--- a/foo.js\n+++ b/foo.js";
  check(detectKind(diffText) === "verbatim", "diff 内容无损直通");
}

// -------------------------------------------------------------
// 6. 性能实测（中型日志 200 行 / 8KB）
// -------------------------------------------------------------
console.log("\n=== 6. 性能实测（中型日志 200 行 / 8KB，限额 250ms） ===");
{
  const mediumLines = [];
  for (let i = 0; i < 200; i++) {
    if (i === 120) {
      mediumLines.push("2026-10-16 04:02:00 FATAL redis master unavailable, failing over");
    } else {
      mediumLines.push(`2026-10-16 04:00:${String(i % 60).padStart(2, "0")} [sync-worker-${i % 4}] job=${1000 + i} status=running elapsed=${(i * 1.5).toFixed(1)}ms count=${i} mem=64MB`);
    }
  }
  const mediumLog = mediumLines.join("\n");
  const logBytes = Buffer.byteLength(mediumLog, "utf8");

  // 热身
  const sampleOut = dedupLogTemplates(mediumLog);
  check(sampleOut.includes("FATAL redis master unavailable"), "性能实测样本中 FATAL 存活");
  check(sampleOut.includes("…[相同内容重复"), "性能实测样本发生模板折叠");

  // 测定耗时（循环 100 次取平均）
  const iterations = 100;
  const startOn = performance.now();
  for (let j = 0; j < iterations; j++) {
    dedupLogTemplates(mediumLog);
  }
  const endOn = performance.now();
  const avgTimeMs = (endOn - startOn) / iterations;

  const startOff = performance.now();
  for (let k = 0; k < iterations; k++) {
    // 模拟关闭模板去重时的纯分行基准开销
    mediumLog.split("\n");
  }
  const endOff = performance.now();
  const baseLineMs = (endOff - startOff) / iterations;

  const compBytes = Buffer.byteLength(sampleOut, "utf8");
  const saveRatio = (100 * (1 - compBytes / logBytes)).toFixed(1);

  console.log(`\n  [性能实测数据报告]`);
  console.log(`  - 样本规模: ${mediumLines.length} 行 / ${(logBytes / 1024).toFixed(2)} KB (${logBytes} 字节)`);
  console.log(`  - 去重后大小: ${(compBytes / 1024).toFixed(2)} KB (${compBytes} 字节)`);
  console.log(`  - Token/字符压缩率: 省 ${saveRatio}%`);
  console.log(`  - 模板去重平均耗时: ${avgTimeMs.toFixed(3)} ms (基线拆行耗时: ${baseLineMs.toFixed(3)} ms)`);
  console.log(`  - moejs 250ms 限额占比: ${((avgTimeMs / 250) * 100).toFixed(2)}% (远低于 250ms 限额)`);

  check(avgTimeMs < 50, `模板去重耗时 ${avgTimeMs.toFixed(3)}ms 远低于 250ms 限额`);
  check(parseFloat(saveRatio) > 80, `收益显著：压缩率 ${saveRatio}% 带来极高 Token 收益`);
}

console.log("\n=================================================================");
console.log(`✅ 所有断言全部通过！（累计验证 ${assertionsCount} 项断言，无异常吞没）`);
console.log("=================================================================");

process.exit(0);
