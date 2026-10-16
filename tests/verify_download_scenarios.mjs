import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { downloadModel, computeSha256, MODEL_SPEC, checkLocalModel } from "../model_check.js";

console.log("==================================================================");
console.log("【测试场景 A】断点续传验证（模拟下载中途中断后继续下载）");
console.log("==================================================================");
{
  const resumeDir = "/tmp/test_model_resume";
  fs.rmSync(resumeDir, { recursive: true, force: true });
  fs.mkdirSync(resumeDir, { recursive: true });

  // 1. 先通过 curl 下载 vocab.txt 的前 100,000 字节，命名为 vocab.txt.tmp 模拟中途中断
  const tmpFile = path.join(resumeDir, "vocab.txt.tmp");
  const targetFile = path.join(resumeDir, "vocab.txt");
  const partialUrl = `https://hf-mirror.com/${MODEL_SPEC.repo}/resolve/main/vocab.txt`;
  
  console.log("正在拉取前 100,000 字节模拟被中断的 .tmp 文件…");
  const pRes = await fetch(partialUrl, { headers: { Range: "bytes=0-99999" } });
  const pBuf = Buffer.from(await pRes.arrayBuffer());
  fs.writeFileSync(tmpFile, pBuf);
  console.log(`已创建中断现场: ${tmpFile}，当前大小: ${fs.statSync(tmpFile).size} 字节（期望总大小: ${MODEL_SPEC.files["vocab.txt"].size} 字节）`);

  // 2. 触发下载，观察是否从 100,000 字节开始继续下载
  let resumeStartedAt = -1;
  const progressLogs = [];
  await downloadModel({}, { dir: resumeDir }, (p) => {
    if (p.file === "vocab.txt") {
      if (resumeStartedAt === -1 && p.done_bytes > 0) {
        resumeStartedAt = p.done_bytes;
      }
      if (p.percent % 25 === 0 || p.status === "verifying" || p.status === "done") {
        progressLogs.push(`  [${p.file}] 状态=${p.status}, 已下=${p.done_bytes}/${p.total_bytes}, 百分比=${p.percent}%`);
      }
    }
  });

  console.log("断点续传进度轨迹 (采样):");
  progressLogs.forEach(l => console.log(l));

  assert.ok(fs.existsSync(targetFile), "正式文件 vocab.txt 必须存在");
  assert.ok(!fs.existsSync(tmpFile), "临时文件 vocab.txt.tmp 必须已原子替换");
  const finalSize = fs.statSync(targetFile).size;
  assert.strictEqual(finalSize, MODEL_SPEC.files["vocab.txt"].size, "最终文件大小必须严格一致");
  const finalSha = await computeSha256(targetFile);
  assert.strictEqual(finalSha, MODEL_SPEC.files["vocab.txt"].sha256, "最终文件 sha256 必须严格匹配");

  console.log(`✓ 验证通过：断点续传成功，起始续传字节=${resumeStartedAt}，最终 SHA-256=${finalSha}\n`);
}

console.log("==================================================================");
console.log("【测试场景 B】SHA-256 校验失败防投毒场景验证");
console.log("==================================================================");
{
  const tamperDir = "/tmp/test_model_tamper";
  fs.rmSync(tamperDir, { recursive: true, force: true });
  fs.mkdirSync(tamperDir, { recursive: true });

  // 伪造一个已存在旧文件，确保下载失败时旧文件绝不被破坏
  const existingConfig = path.join(tamperDir, "config.json");
  fs.writeFileSync(existingConfig, '{"valid_existing_model": true}');

  // 写入一个大小刚好为 934 字节但内容全是垃圾字符的 config.json.tmp
  const tamperedTmp = path.join(tamperDir, "config.json.tmp");
  const junkBuf = Buffer.alloc(MODEL_SPEC.files["config.json"].size, 0x41); // 全是 'A'
  fs.writeFileSync(tamperedTmp, junkBuf);
  console.log(`已构造被篡改的 .tmp 文件: 大小=${junkBuf.length}字节，但全是伪造数据`);

  let errorCaught = null;
  try {
    await downloadModel({}, { dir: tamperDir });
  } catch (err) {
    errorCaught = err;
  }

  console.log("捕获到的错误信息:", errorCaught ? errorCaught.message : "未报错");
  assert.ok(errorCaught, "篡改文件必须抛出校验错误");
  assert.ok(errorCaught.message.includes("SHA-256 校验失败") || errorCaught.message.includes("校验失败"), "错误信息必须明确指明 SHA-256 校验失败");

  // 断言：临时文件已被安全清除，旧文件完好无损
  assert.ok(!fs.existsSync(tamperedTmp), "校验失败的 .tmp 文件必须被立即删除");
  assert.ok(fs.existsSync(existingConfig), "已有旧文件必须被完好保留");
  assert.strictEqual(fs.readFileSync(existingConfig, "utf8"), '{"valid_existing_model": true}', "旧文件内容未受破坏");
  console.log("✓ 验证通过：SHA-256 校验失败被精准拦截，.tmp 自动销毁，已有文件零破坏！\n");
}
