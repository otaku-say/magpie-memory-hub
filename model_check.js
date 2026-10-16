/**
 * model_check.js —— 本地多语言小模型的「检测 / 一键下载 / 版本比对 / 更新覆盖」。
 *
 * 选型（实测调研结论）：`microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank`
 * 的 INT8 ONNX 版本 —— 专为抽取式 Token 级上下文压缩训练，原生多语言（中文可用），
 * 174MB、CPU 约 150ms、MIT 许可。现有的 Kompress-v2-base 是纯英文模型，
 * **对中文的压缩率实测为 0%**（按空格切词，中文整段被视为一个词）。
 *
 * 本模块只跑在 Bun/Node 宿主侧（有文件系统与网络）；moejs 中间件不能 import 它。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/** 插件根目录绝对路径 */
export const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));

/** 模型清单：逐个文件校验大小与 sha256，避免半截/被改坏的文件被当成可用。 */
export const MODEL_SPEC = {
  repo: "KatawaDead/llmlingua-2-bert-base-multilingual-cased-meetingbank-onnx-int8",
  name: "LLMLingua-2 mBERT（多语言，INT8）",
  approx_bytes: 178693007 + 2919362 + 995526 + 934,
  files: {
    "model.onnx": { size: 178693007, sha256: "2753018e58d0bfaeb76109fba436d152ebddf734fb32603df204d5c3fb5deada" },
    "tokenizer.json": { size: 2919362, sha256: "bf1b59b7b11c95f194f51708d918eea378e09d05f84c0e1656dc5180e8117088" },
    "vocab.txt": { size: 995526, sha256: "fe0fda7c425b48c516fc8f160d594c8022a0808447475c1a7c6d6479763f310c" },
    "config.json": { size: 934, sha256: "d36f6315e811927b093bb93d76df6cfabdd91d5336c78bfda5f42caf799da494" },
  },
  mirrors: ["https://hf-mirror.com", "https://huggingface.co"],
  license: "MIT",
};

/**
 * 模型存储路径决策：
 * 【重要持久化保证】：
 * 模型绝对不能存放在插件自身的工作/代码目录内！因为执行 `magpie plugin update` 时，
 * Magpie 会完整替换/重写插件目录，若放在插件目录下每次插件更新都会丢失 174MB 模型文件并强制重下。
 *
 * 正确落点：Magpie 官方 Docker 镜像中配置了 `HOME=/config/home`，且声明了持久卷 `VOLUME /config`。
 * 因此 `os.homedir()` 解析出的是 `/config/home`，其子路径 `~/.magpie-memory-hub/models/...`
 * （即 `/config/home/.magpie-memory-hub/models/llmlingua2-mbert-int8`）
 * 严格落在宿主机的持久化挂载卷（Persistent Volume）内，镜像升级、容器重建或插件更新均不丢失。
 */
export function modelDir() {
  if (process.env.MEMHUB_MODEL_DIR) return path.resolve(process.env.MEMHUB_MODEL_DIR);
  try {
    return path.join(os.homedir(), ".magpie-memory-hub", "models", "llmlingua2-mbert-int8");
  } catch (e) {
    return "";
  }
}

/**
 * 持久性自查：判断给定的目录是否落在插件代码目录内部。
 * 若用户错误配置了 MEMHUB_MODEL_DIR 指向插件内部，将触发告警。
 */
export function isInsidePluginDir(dir) {
  if (!dir) return false;
  try {
    const target = path.resolve(dir);
    const rel = path.relative(PLUGIN_ROOT, target);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch (_) {
    return false;
  }
}

export function human(bytes) {
  if (!bytes) return "0 B";
  const mb = bytes / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(1) + " MB";
}

/** 读取本地已保存的 manifest.json */
export function readManifest(dir) {
  const d = dir || modelDir();
  const mfPath = path.join(d, "manifest.json");
  try {
    if (fs.existsSync(mfPath)) {
      return JSON.parse(fs.readFileSync(mfPath, "utf8"));
    }
  } catch (_) {}
  return null;
}

/** 只查大小，不读全文件（200MB 读一遍哈希太慢，检测要秒回）。 */
export function statModel(dir) {
  const d = dir || modelDir();
  const insidePlugin = isInsidePluginDir(d);
  const out = {
    dir: d,
    present: true,
    inside_plugin_dir: insidePlugin,
    files: [],
    missing: [],
    wrongSize: [],
    bytes: 0,
    manifest: readManifest(d),
  };
  if (!d) {
    out.present = false;
    out.missing.push("(无法确定模型目录)");
    return out;
  }
  for (const name of Object.keys(MODEL_SPEC.files)) {
    const p = path.join(d, name);
    const want = MODEL_SPEC.files[name].size;
    let st = null;
    try {
      st = fs.statSync(p);
    } catch (e) {
      st = null;
    }
    if (!st || !st.isFile()) {
      out.missing.push(name);
      continue;
    }
    out.bytes += st.size;
    out.files.push({ name, size: st.size });
    if (st.size !== want) out.wrongSize.push({ name, got: st.size, want });
  }
  out.present = out.missing.length === 0 && out.wrongSize.length === 0;
  return out;
}

/**
 * 请求上游元数据（实测对接 HuggingFace / hf-mirror 的 API）。
 * 返回 { ok: true, commit, lastModified, repo, source } 或 { ok: false, error }
 */
export async function fetchUpstreamMeta(timeoutMs = 6000, signal = null) {
  if (signal && signal.aborted) {
    return { ok: false, error: "操作已被取消 (aborted)" };
  }
  const errors = [];
  for (const mirror of MODEL_SPEC.mirrors) {
    if (signal && signal.aborted) {
      return { ok: false, error: "操作已被取消 (aborted)" };
    }
    const url = `${mirror}/api/models/${MODEL_SPEC.repo}`;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let abortListener = null;
      if (signal) {
        abortListener = () => ac.abort();
        signal.addEventListener("abort", abortListener, { once: true });
      }
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { "User-Agent": "magpie-memory-hub/6.1" },
      });
      clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      if (res.ok) {
        const json = await res.json();
        const commit = String(json.sha || "");
        const lastModified = String(json.lastModified || "");
        if (commit) {
          return {
            ok: true,
            commit,
            lastModified,
            repo: MODEL_SPEC.repo,
            mirror,
          };
        }
      } else {
        errors.push(`${mirror} HTTP ${res.status}`);
      }
    } catch (err) {
      if (signal && signal.aborted) {
        return { ok: false, error: "操作已被取消 (aborted)" };
      }
      errors.push(`${mirror}: ${err && err.message ? err.message : err}`);
    }
  }
  return { ok: false, error: errors.join("; ") || "无法连接上游 API" };
}

/**
 * 检测本地小模型是否就绪及版本比对。
 * 支持 options.checkUpstream: boolean（默认为 false）
 * 返回统一结构：{ ok, verdict, title, lines, diagnosis?, model_dir, upstream_meta? }
 */
export async function checkLocalModel(options = {}) {
  const checkUpstream = typeof options === "object" && options ? !!options.checkUpstream : false;
  const signal = typeof options === "object" && options ? options.signal : null;
  const st = statModel();
  const d = st.dir;
  const manifest = st.manifest;
  const insidePlugin = st.inside_plugin_dir;

  const base = {
    model: MODEL_SPEC.name,
    repo: MODEL_SPEC.repo,
    dir: d,
    license: MODEL_SPEC.license,
    inside_plugin_dir: insidePlugin,
    manifest: manifest || undefined,
  };

  const lines = [];

  // 1. 绝对路径输出与持久性自查警告
  const locNote = insidePlugin
    ? "（⚠️ 警告：位于插件目录内，插件更新时将被清空！）"
    : "（位于 Magpie 持久卷，插件更新不丢失）";
  lines.push("模型目录：" + d + " " + locNote);

  if (insidePlugin) {
    lines.push("⚠️ 持久性警告：当前模型目录落在插件工作区内部！执行 magpie plugin update 时该目录会被覆盖删除导致模型丢失。建议移除环境变量 MEMHUB_MODEL_DIR 或设为持久卷路径（如 ~/.magpie-memory-hub/models/...）。");
  }

  // 2. 判断文件是否齐全
  if (st.present) {
    let verdict = "READY";
    let title = "本地小模型已就绪";
    let remoteMeta = null;

    if (checkUpstream) {
      remoteMeta = await fetchUpstreamMeta(5000, signal);
      if (remoteMeta.ok) {
        base.upstream_meta = remoteMeta;
        const localCommit = manifest && manifest.upstream_commit ? manifest.upstream_commit : "";
        const remoteCommit = remoteMeta.commit;

        const localShort = localCommit ? localCommit.slice(0, 7) : (manifest && manifest.installed_at ? new Date(manifest.installed_at).toISOString().slice(0, 10) : "未知");
        const remoteShort = remoteCommit ? remoteCommit.slice(0, 7) : "最新";

        lines.push(`本地版本标识：${localShort}`);
        lines.push(`上游版本标识：${remoteShort}（${remoteMeta.mirror}）`);

        if (localCommit && remoteCommit && localCommit !== remoteCommit) {
          verdict = "UPDATE_AVAILABLE";
          title = "本地小模型发现上游新版本";
          lines.push("版本比对结论：上游权重有更新，可在本页点「更新模型」进行无损覆盖。");
        } else {
          verdict = "UP_TO_DATE";
          title = "本地小模型已就绪（最新版）";
          lines.push("版本比对结论：本地权重与上游一致，已是最新版本，无需更新。");
        }
      } else {
        lines.push("上游版本比对：无法连接 HuggingFace API（" + remoteMeta.error + "），判据已退化为本地文件与 manifest 完整性。");
        lines.push("版本状态：本地 4 个权重文件完整，离线语义压缩可正常使用。");
      }
    } else {
      if (manifest && manifest.upstream_commit) {
        lines.push(`本地版本标识：${manifest.upstream_commit.slice(0, 7)}（${manifest.mirror || "hf-mirror"}）`);
      }
      lines.push("体积：" + human(st.bytes) + "（" + st.files.length + " 个核心文件齐全）");
      lines.push("离线推理可正常使用，数据不出本机。");
    }

    return Object.assign(base, {
      ok: true,
      verdict,
      title,
      lines,
    });
  }

  // 3. 未就绪：区分「完全没装」与「装了一半/被改坏」
  const partial = st.files.length > 0;
  if (partial) {
    lines.push("模型文件不完整或已损坏 —— 检测到：" + st.files.map((f) => f.name).join("、"));
  } else {
    lines.push("尚未下载本地小模型（LLMLingua-2 mBERT INT8，174MB）");
  }
  if (st.missing.length) lines.push("缺失文件：" + st.missing.join("、"));
  for (const w of st.wrongSize) {
    lines.push("大小不符：" + w.name + "（实际 " + human(w.got) + "，应为 " + human(w.want) + "）");
  }
  lines.push("预计体积约 " + human(MODEL_SPEC.approx_bytes) + "，许可证 " + MODEL_SPEC.license);
  lines.push("可在本页点「一键下载模型」，或让 agent 调用 model_download 工具。");

  return Object.assign(base, {
    ok: false,
    verdict: partial ? "DAMAGED" : "MISSING",
    title: partial ? "本地小模型不完整，需要重新下载" : "本地小模型尚未安装",
    lines,
    diagnosis: {
      kind: partial ? "MODEL_DAMAGED" : "MODEL_MISSING",
      detail: partial
        ? "目录里有部分文件，但存在缺失或大小不符，说明上次下载被中断或文件被改坏。"
        : "离线语义压缩需要该模型；未就绪时该压缩档位自动跳过（不影响其它功能）。",
      actions: [
        "① 点本卡的「一键下载模型」（约 174MB，支持断点续传与 sha256 校验）",
        "② 或让 agent 调用 model_download 工具",
        "③ 国内网络会自动优先走 hf-mirror.com 镜像",
      ],
    },
  });
}

/**
 * 流式计算文件的 SHA-256 哈希值
 */
export function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * 单个文件的断点续传与校验下载
 */
export async function downloadSingleFile(fileUrl, tmpPath, finalPath, expectedSize, expectedSha256, onFileProgress, mirrorName, signal = null) {
  if (signal && signal.aborted) {
    const abortErr = new Error("操作已被取消 (aborted)");
    abortErr.name = "AbortError";
    throw abortErr;
  }
  let curSize = 0;
  if (fs.existsSync(tmpPath)) {
    try {
      curSize = fs.statSync(tmpPath).size;
    } catch (_) {
      curSize = 0;
    }
  }

  // 若已有 tmp 文件超出预期大小，说明坏了，直接删掉重下
  if (curSize > expectedSize) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    curSize = 0;
  } else if (curSize === expectedSize) {
    // 已经下满了，先直接验 sha256
    onFileProgress(curSize, expectedSize, "verifying");
    const hash = await computeSha256(tmpPath);
    if (hash === expectedSha256) {
      fs.renameSync(tmpPath, finalPath);
      onFileProgress(expectedSize, expectedSize, "done");
      return true;
    } else {
      // 校验失败，删除被篡改/损坏的 tmp 并立即拒绝报错
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      throw new Error(`SHA-256 校验失败（文件被篡改或损坏）: 期望 ${expectedSha256}，实际 ${hash}`);
    }
  }

  const headers = {
    "User-Agent": "magpie-memory-hub/6.1",
  };
  if (curSize > 0) {
    headers["Range"] = `bytes=${curSize}-`;
  }

  // 停滞超时：30 秒内没有任何新 chunk 数据进入则抛出超时
  const STALL_TIMEOUT_MS = 30000;
  const ac = new AbortController();
  let stallTimer = null;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      ac.abort(new Error(`下载连接停滞（超过 ${STALL_TIMEOUT_MS / 1000} 秒未收到数据）`));
    }, STALL_TIMEOUT_MS);
  };

  let abortListener = null;
  if (signal) {
    abortListener = () => {
      ac.abort(new Error("操作已被取消 (aborted)"));
    };
    signal.addEventListener("abort", abortListener, { once: true });
  }

  resetStallTimer();
  let res;
  try {
    res = await fetch(fileUrl, {
      headers,
      signal: ac.signal,
      redirect: "follow",
    });
  } catch (err) {
    if (stallTimer) clearTimeout(stallTimer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    if (signal && signal.aborted) {
      const abortErr = new Error("操作已被取消 (aborted)");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    throw err;
  }

  if (res.status === 416) {
    // 范围不满足，若本地刚好等于 expectedSize
    if (stallTimer) clearTimeout(stallTimer);
    if (curSize === expectedSize) {
      const hash = await computeSha256(tmpPath);
      if (hash === expectedSha256) {
        fs.renameSync(tmpPath, finalPath);
        onFileProgress(expectedSize, expectedSize, "done");
        return true;
      }
    }
    // 否则删掉重下
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    curSize = 0;
    return downloadSingleFile(fileUrl, tmpPath, finalPath, expectedSize, expectedSha256, onFileProgress, mirrorName);
  }

  if (res.status !== 200 && res.status !== 206) {
    if (stallTimer) clearTimeout(stallTimer);
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const isPartial = res.status === 206;
  const writeFlag = isPartial ? "a" : "w";
  if (!isPartial) {
    curSize = 0;
  }

  const writeStream = fs.createWriteStream(tmpPath, { flags: writeFlag });
  let downloadedBytes = curSize;

  try {
    const reader = res.body.getReader();
    while (true) {
      resetStallTimer();
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        await new Promise((resolve, reject) => {
          writeStream.write(Buffer.from(value), (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        downloadedBytes += value.length;
        onFileProgress(downloadedBytes, expectedSize, "downloading");
      }
    }
    await new Promise((resolve) => writeStream.end(resolve));
  } catch (err) {
    writeStream.destroy();
    throw err;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }

  // 落地大小严格校验
  const finalSize = fs.statSync(tmpPath).size;
  if (finalSize !== expectedSize) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw new Error(`下载文件大小不匹配: 期望 ${expectedSize} 字节，实际 ${finalSize} 字节`);
  }

  // SHA-256 完整性严格校验
  onFileProgress(downloadedBytes, expectedSize, "verifying");
  const actualHash = await computeSha256(tmpPath);
  if (actualHash !== expectedSha256) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw new Error(`SHA-256 校验失败: 期望 ${expectedSha256}，实际 ${actualHash}`);
  }

  // 原子替换正式文件（无损覆盖：旧文件在校验成功前保持完好）
  fs.renameSync(tmpPath, finalPath);
  onFileProgress(expectedSize, expectedSize, "done");
  return true;
}

/**
 * 一键下载安装或更新模型。
 * 逐个下载 4 个核心文件：
 * - 优先走国内镜像 hf-mirror.com，失败回退官方 huggingface.co
 * - 断点续传（Range 请求）
 * - SHA-256 校验通过后原子落地（无损覆盖，绝不先删旧文件）
 * - 完成后生成 manifest.json
 * - onProgress 回调通知进度
 */
export async function downloadModel(cfg = {}, args = {}, onProgress = () => {}) {
  const signal = (args && args.signal) || (cfg && cfg.signal) || null;
  const d = (args && args.dir) || modelDir();
  if (!d) throw new Error("无法解析模型目标存储目录");

  fs.mkdirSync(d, { recursive: true });

  const force = args && args.force === true;
  const fileNames = Object.keys(MODEL_SPEC.files);
  const totalFiles = fileNames.length;
  let overallDoneBytes = 0;
  const overallTotalBytes = MODEL_SPEC.approx_bytes;

  let successfulMirror = MODEL_SPEC.mirrors[0];

  for (let i = 0; i < totalFiles; i++) {
    const name = fileNames[i];
    const spec = MODEL_SPEC.files[name];
    const finalPath = path.join(d, name);
    const tmpPath = path.join(d, name + ".tmp");

    // 若非强制下载，且正式文件已经存在且大小/哈希完全匹配，则直接复用
    if (!force && fs.existsSync(finalPath)) {
      try {
        const curSt = fs.statSync(finalPath);
        if (curSt.size === spec.size) {
          const hash = await computeSha256(finalPath);
          if (hash === spec.sha256) {
            overallDoneBytes += spec.size;
            onProgress({
              file: name,
              file_index: i + 1,
              total_files: totalFiles,
              done_bytes: spec.size,
              total_bytes: spec.size,
              overall_done: overallDoneBytes,
              overall_total: overallTotalBytes,
              percent: Math.min(100, Math.floor((overallDoneBytes / overallTotalBytes) * 100)),
              status: "done",
            });
            continue;
          }
        }
      } catch (_) {}
    }

    let fileDownloaded = false;
    let lastError = null;

    // 尝试镜像下载
    for (const mirror of MODEL_SPEC.mirrors) {
      const fileUrl = `${mirror}/${MODEL_SPEC.repo}/resolve/main/${name}`;
      try {
        const onFileProgress = (fDone, fTotal, status) => {
          const curOverall = overallDoneBytes + fDone;
          const pct = Math.min(100, Math.floor((curOverall / overallTotalBytes) * 100));
          onProgress({
            file: name,
            file_index: i + 1,
            total_files: totalFiles,
            done_bytes: fDone,
            total_bytes: fTotal,
            overall_done: curOverall,
            overall_total: overallTotalBytes,
            percent: pct,
            status,
            mirror,
          });
        };

        await downloadSingleFile(fileUrl, tmpPath, finalPath, spec.size, spec.sha256, onFileProgress, mirror, signal);
        fileDownloaded = true;
        successfulMirror = mirror;
        overallDoneBytes += spec.size;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!fileDownloaded) {
      throw new Error(`下载文件 ${name} 失败: ${lastError ? lastError.message : "所有镜像均不可用"}`);
    }
  }

  // 全部下载完成，获取上游 commit 写入 manifest.json
  let upstreamCommit = "";
  let upstreamLastModified = "";
  try {
    const meta = await fetchUpstreamMeta(5000, signal);
    if (meta.ok) {
      upstreamCommit = meta.commit;
      upstreamLastModified = meta.lastModified;
    }
  } catch (_) {}

  const manifest = {
    repo: MODEL_SPEC.repo,
    name: MODEL_SPEC.name,
    upstream_commit: upstreamCommit,
    last_modified: upstreamLastModified,
    installed_at: Date.now(),
    mirror: successfulMirror,
    files: MODEL_SPEC.files,
  };

  const mfPath = path.join(d, "manifest.json");
  const mfTmp = mfPath + ".tmp";
  try {
    fs.writeFileSync(mfTmp, JSON.stringify(manifest, null, 2), "utf8");
    fs.renameSync(mfTmp, mfPath);
  } catch (err) {
    console.error("[model_check] 写入 manifest.json 失败:", err);
  }

  onProgress({
    file: "完成",
    file_index: totalFiles,
    total_files: totalFiles,
    done_bytes: overallTotalBytes,
    total_bytes: overallTotalBytes,
    overall_done: overallTotalBytes,
    overall_total: overallTotalBytes,
    percent: 100,
    status: "done",
    mirror: successfulMirror,
  });

  return {
    ok: true,
    dir: d,
    manifest,
    files: fileNames,
  };
}
