import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import {
  downloadModel,
  downloadSingleFile,
  computeSha256,
  MODEL_SPEC,
  checkLocalModel,
  modelDir,
  fetchUpstreamMeta,
} from "../model_check.js";
import { runPendingAction, executeActionForTest } from "./test_helpers.mjs";

console.log("==================================================================");
console.log("【验收项 3.1】真实下载全部 4 个模型文件并做全量 SHA-256 校验");
console.log("==================================================================");
const targetDir = modelDir();
console.log("模型落点目录 (持久卷):", targetDir);

const startTime = Date.now();
const progressMilestones = [];
const downloadResult = await downloadModel({}, { dir: targetDir }, (p) => {
  if (p.status === "verifying" || p.status === "done" || p.percent % 20 === 0) {
    const log = `  [${p.file}] 阶段=${p.status} 进度=${p.percent}% 已完成=${(p.overall_done/1048576).toFixed(1)}MB / ${(p.overall_total/1048576).toFixed(1)}MB (来源: ${p.mirror || "默认"})`;
    if (progressMilestones.length === 0 || progressMilestones[progressMilestones.length - 1] !== log) {
      progressMilestones.push(log);
      console.log(log);
    }
  }
});
const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n下载完成！总耗时: ${durationSec} 秒`);

console.log("\n--- 逐个文件 SHA-256 与大小比对清单 ---");
for (const [name, spec] of Object.entries(MODEL_SPEC.files)) {
  const filePath = path.join(targetDir, name);
  assert.ok(fs.existsSync(filePath), `文件 ${name} 必须存在`);
  const actualSize = fs.statSync(filePath).size;
  assert.strictEqual(actualSize, spec.size, `文件 ${name} 大小必须精确匹配`);
  const actualSha = await computeSha256(filePath);
  assert.strictEqual(actualSha, spec.sha256, `文件 ${name} SHA-256 必须精确匹配`);
  console.log(`  ✓ ${name}:`);
  console.log(`      大小: ${actualSize} 字节 (匹配: ${spec.size})`);
  console.log(`      SHA256: ${actualSha}`);
  console.log(`      期望:   ${spec.sha256} (一致)`);
}

const manifestPath = path.join(targetDir, "manifest.json");
assert.ok(fs.existsSync(manifestPath), "manifest.json 必须成功生成");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
console.log("\n生成的 manifest.json 内容摘要:");
console.log(JSON.stringify({
  repo: manifest.repo,
  upstream_commit: manifest.upstream_commit,
  installed_at: new Date(manifest.installed_at).toISOString(),
  mirror: manifest.mirror,
  files_count: Object.keys(manifest.files).length
}, null, 2));

console.log("\n==================================================================");
console.log("【验收项 3.2】断点续传验证（模拟下载中途中断后无缝续传）");
console.log("==================================================================");
{
  const resumeTestDir = "/tmp/test_breakpoint_resume";
  fs.rmSync(resumeTestDir, { recursive: true, force: true });
  fs.mkdirSync(resumeTestDir, { recursive: true });

  // 复制已就绪的 model.onnx, tokenizer.json, config.json，确保测试只聚焦 vocab.txt
  fs.copyFileSync(path.join(targetDir, "model.onnx"), path.join(resumeTestDir, "model.onnx"));
  fs.copyFileSync(path.join(targetDir, "tokenizer.json"), path.join(resumeTestDir, "tokenizer.json"));
  fs.copyFileSync(path.join(targetDir, "config.json"), path.join(resumeTestDir, "config.json"));

  // 截取 vocab.txt 前 200,000 字节写入 vocab.txt.tmp
  const vocabFull = fs.readFileSync(path.join(targetDir, "vocab.txt"));
  const partialBuf = vocabFull.subarray(0, 200000);
  const tmpVocab = path.join(resumeTestDir, "vocab.txt.tmp");
  fs.writeFileSync(tmpVocab, partialBuf);
  console.log(`模拟中断场景：已生成 vocab.txt.tmp，已有字节数: ${fs.statSync(tmpVocab).size}（总需: ${MODEL_SPEC.files["vocab.txt"].size}）`);

  let resumeOffset = -1;
  await downloadModel({}, { dir: resumeTestDir }, (p) => {
    if (p.file === "vocab.txt") {
      if (resumeOffset === -1 && p.done_bytes > 0) resumeOffset = p.done_bytes;
      console.log(`  [断点续传进度] ${p.file} 状态=${p.status} 字节=${p.done_bytes}/${p.total_bytes}`);
    }
  });

  const finalVocab = path.join(resumeTestDir, "vocab.txt");
  assert.ok(fs.existsSync(finalVocab), "断点续传后 vocab.txt 必须存在");
  assert.ok(!fs.existsSync(tmpVocab), "vocab.txt.tmp 必须已原子替换");
  const finalSha = await computeSha256(finalVocab);
  assert.strictEqual(finalSha, MODEL_SPEC.files["vocab.txt"].sha256, "续传后 SHA-256 必须一致");
  console.log(`✓ 断点续传成功！初始续传点: ${resumeOffset} 字节，最终 SHA-256 严格匹配！`);
}

console.log("\n==================================================================");
console.log("【验收项 3.3】篡改拦截验证（故意改动一个字节，必须检出并拒绝）");
console.log("==================================================================");
{
  const tamperTestDir = "/tmp/test_tamper_reject";
  fs.rmSync(tamperTestDir, { recursive: true, force: true });
  fs.mkdirSync(tamperTestDir, { recursive: true });

  // 复制已有正常文件
  fs.copyFileSync(path.join(targetDir, "model.onnx"), path.join(tamperTestDir, "model.onnx"));
  fs.copyFileSync(path.join(targetDir, "tokenizer.json"), path.join(tamperTestDir, "tokenizer.json"));
  fs.copyFileSync(path.join(targetDir, "vocab.txt"), path.join(tamperTestDir, "vocab.txt"));

  // 构造 config.json.tmp：真实 config.json 但篡改末尾 1 个字节
  const realConfig = fs.readFileSync(path.join(targetDir, "config.json"));
  const tamperedBuf = Buffer.from(realConfig);
  tamperedBuf[tamperedBuf.length - 1] ^= 0x01; // 翻转最后 1 位
  const tamperedTmp = path.join(tamperTestDir, "config.json.tmp");
  fs.writeFileSync(tamperedTmp, tamperedBuf);

  // 构造一个旧版本的 config.json，确保失败时旧模型不被破坏
  const existingConfig = path.join(tamperTestDir, "config.json");
  const oldConfigContent = '{"version": "old_model_config"}';
  fs.writeFileSync(existingConfig, oldConfigContent);

  console.log(`已构造篡改文件: config.json.tmp (大小=${tamperedBuf.length}字节，篡改了末位 1 字节)`);
  let caughtError = null;
  try {
    const dummyUrl = `https://hf-mirror.com/${MODEL_SPEC.repo}/resolve/main/config.json`;
    await downloadSingleFile(
      dummyUrl,
      tamperedTmp,
      existingConfig,
      MODEL_SPEC.files["config.json"].size,
      MODEL_SPEC.files["config.json"].sha256,
      () => {},
      "hf-mirror"
    );
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError, "篡改文件必须被拒绝并抛错");
  console.log("检出并拒绝的错误信息:", caughtError.message);
  assert.ok(caughtError.message.includes("SHA-256 校验失败"), "错误信息必须明确指明 SHA-256 校验失败");
  assert.ok(!fs.existsSync(tamperedTmp), "被篡改的 .tmp 文件必须被立即销毁");
  assert.strictEqual(fs.readFileSync(existingConfig, "utf8"), oldConfigContent, "已有旧文件完好无损");
  console.log("✓ 篡改防御验证通过：校验失败立刻拒绝，坏文件已删除，旧模型零损坏！");
}

console.log("\n==================================================================");
console.log("【验收项 4】非阻塞验证：execute(op='model_download') 耗时断言");
console.log("==================================================================");
{
  const t0 = performance.now();
  const execResult = await executeActionForTest({
    op: "model_download",
    id: "test-nonblocking-" + Date.now(),
    at: Date.now()
  });
  const elapsedMs = performance.now() - t0;
  console.log(`op='model_download' 返回耗时: ${elapsedMs.toFixed(2)} ms`);
  console.log("返回结构:", JSON.stringify(execResult, null, 2));

  assert.ok(elapsedMs < 100, `execute() 必须立刻返回（耗时 ${elapsedMs.toFixed(2)}ms < 100ms）`);
  assert.strictEqual(execResult.ok, true);
  assert.ok(execResult.action === "STARTED" || execResult.action === "IN_PROGRESS");
  console.log("✓ 非阻塞验证通过：后台异步启动，主执行链路毫秒级秒回！");
}

console.log("\n==================================================================");
console.log("【验收项 5】版本比对与上游 API 真实查询验证");
console.log("==================================================================");
{
  console.log("正在请求上游元数据接口…");
  const upstreamMeta = await fetchUpstreamMeta(5000);
  console.log("上游元数据响应:", JSON.stringify(upstreamMeta, null, 2));
  assert.strictEqual(upstreamMeta.ok, true, "上游元数据必须请求成功");
  assert.ok(upstreamMeta.commit, "上游必须返回 commit hash");

  const checkResult = await checkLocalModel({ checkUpstream: true });
  console.log("\ncheckLocalModel({ checkUpstream: true }) 实际检测结果:");
  console.log("  verdict:", checkResult.verdict);
  console.log("  title:  ", checkResult.title);
  console.log("  lines:");
  checkResult.lines.forEach(l => console.log("    -", l));

  assert.strictEqual(checkResult.ok, true);
  assert.ok(checkResult.verdict === "READY" || checkResult.verdict === "UP_TO_DATE");
  console.log("✓ 版本比对验证通过：成功获取可靠上游 Git Commit SHA，版本比对一致！");
}
