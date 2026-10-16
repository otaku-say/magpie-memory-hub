#!/usr/bin/env python3
"""
compress_text.py — 语义压缩（离线管线侧）
==========================================
把 Headroom 用的那个文本重要性小模型拿来用：

    chopratejas/kompress-v2-base
      基座 answerdotai/ModernBERT-base，INT8 ONNX 约 140MB，Apache-2.0
      token 级重要性二分类器（非生成式，无幻觉风险）
      每个 token 得到一个 0~1 的保留概率，低于阈值的词元丢弃

依赖刻意做轻：只需 onnxruntime + tokenizers + numpy + huggingface_hub，
不引入 transformers（那会拖进 PyTorch 等一大堆东西）。

为什么放在离线管线而不是中间件：
    中间件跑在 moejs（Go 内嵌 JS 引擎）里，不能加载原生模块或 WASM，
    且 onRequest 只有 250ms。ONNX 推理必须放到独立进程。

为什么值得做：
    网关中间件的纯 JS 压缩对「工具输出（JSON/日志）」效果很好（实测省 91%），
    但对**自然语言长文**只能截断。这个小模型专治自然语言，
    在把长对话送进提炼模型之前压一道，直接砍掉提炼 Token 成本。

设计原则：**永远 fail-open**
    没有 onnxruntime / 没下载模型 / 推理出错 —— 一律原样返回，
    绝不让压缩成为链路上的失败点。它是纯增益的可选组件。
"""

import os
import re
import sys

MODEL_ID = os.environ.get("KOMPRESS_MODEL", "chopratejas/kompress-v2-base")
MODEL_ONNX = os.environ.get("KOMPRESS_ONNX", "onnx/kompress-int8-wo.onnx")
MAX_TOKENS = int(os.environ.get("KOMPRESS_MAX_TOKENS", "4096"))
MIN_CHARS = int(os.environ.get("KOMPRESS_MIN_CHARS", "600"))

# 绝不压缩的内容：代码块、堆栈、URL、路径、时间戳、长哈希——它们是关键信息
PROTECT_RE = re.compile(
    r"```[\s\S]*?```"
    r"|^\s*(?:at\s+[\w.$]+\(|Traceback|File \")[^\n]*"
    r"|https?://\S+"
    r"|/[\w.\-/]{6,}"
    r"|\b\d{4}-\d{2}-\d{2}[ T][\d:.]+"
    r"|\b[0-9a-fA-F]{16,}\b",
    re.M,
)

TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_]")
CJK_RE = re.compile(r"[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

# 「语义脆弱词」必须钉住，永不因模型打分被丢。
# 依据 Headroom 的实测结论：丢掉 not 不是「降级指令」，而是【变成相反的指令】；
# 丢掉 or/and 会改变「哪个条件必须成立」。它在 40 个真实文本上实测：
# 否定词保留率 73.5%→91.9%，情态词 65.5%→96.8%，压缩率只损失 0.2 个百分点。
# 中文同理：丢掉「不/禁止/必须/只能」会直接反转语义，必须钉住。
MUST_KEEP_RE = re.compile(
    # 不可重建的 token
    r"\b0x[0-9A-Fa-f]+\b"
    r"|(?<![\w.])\d+(?:\.\d+)?(?![\w.])"
    r"|[A-Z_]{2,}"
    r"|[a-z_][a-z0-9_]*\.[a-z0-9_]+"
    r"|/[a-z0-9/._-]{2,}"
    r"|\.[a-z]{2,4}\b"
    r"|--?[a-z][\w-]*"
    r"|\b[A-Z][a-z]+[A-Z]\w*"
    # 英文：否定 / 情态 / 布尔连接词
    r"|(?i:\b(?:not|never|none|cannot|can't|don't|doesn't|didn't|won't|shouldn't"
    r"|mustn't|isn't|aren't|avoid|refuse|prohibited|forbidden|disallow|unless"
    r"|except|without|must|should|shall|required|always|only|mandatory|and|or|nor|xor)\b)"
    # 中文：否定 / 禁止 / 情态 / 条件 / 连接
    r"|(?:不|别|没|无|非|禁止|严禁|切勿|不得|不可|不能|不要|无需|免|必须|务必|只能|仅|只|应当|应该|需要|要求|除非|否则|除了|以及|或者|和|并且|但是|然而|如果|若|当)"
)

# 模型训练时的块大小：v2 的 chunk_words=50
CHUNK_WORDS = int(os.environ.get("KOMPRESS_CHUNK_WORDS", "350"))

# 日志/结构化行的特征：时间戳 + 级别，或大量行以级别开头。
# 这类内容靠「固定词位」表达结构，词级抽干会让它读不通
# （实测："INFO processing batch 0 of 25 with 0 errors" → "INFO 0 25 0 and 0 retries"）。
# 对日志一律走【行级】：整行留或整行丢，结构不被破坏。
LOG_LINE_RE = re.compile(
    r"^\s*(?:\[?\d{2,4}[-/]\d{1,2}[-/]\d{1,2}[ T][\d:.]+|"
    r"\[?(?:INFO|DEBUG|TRACE|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|SEVERE)\]?)\b",
    re.I,
)


def _log_ratio(text):
    lines = [l for l in text.split("\n") if l.strip()]
    if not lines:
        return 0.0
    hits = sum(1 for l in lines if LOG_LINE_RE.search(l))
    return hits / len(lines)


class Kompress:
    """文本重要性压缩器。任何一步失败都退化为「原样返回」。"""

    def __init__(self, threshold=0.5, log=None, project=False):
        self.threshold = threshold
        self.log = log or (lambda m: None)
        self.forced_text_mode = project   # 强制走「按行投影」模式（不依赖模型）
        self._sess = None
        self._tok = None
        self._np = None
        self._ready = False
        self._tried = False
        self.unavailable_reason = ""

    # ---------------- 懒加载 ----------------
    def _load(self):
        if self._tried:
            return self._ready
        self._tried = True
        try:
            import numpy as np
            import onnxruntime as ort
            from tokenizers import Tokenizer
            from huggingface_hub import hf_hub_download
        except Exception as e:
            self.unavailable_reason = (
                "缺少依赖（Alpine: apk add py3-onnxruntime py3-numpy; "
                f"pip install tokenizers huggingface_hub）: {e}")
            self.log(f"语义压缩不可用：{self.unavailable_reason}")
            return False

        try:
            tok_path = hf_hub_download(repo_id=MODEL_ID, filename="tokenizer.json")
            self._tok = Tokenizer.from_file(tok_path)
            self._tok.enable_truncation(max_length=MAX_TOKENS)
            # 裸 Tokenizer 没有 all_special_ids，手工取出来；
            # 否则 [CLS]/[SEP] 会混进行平均分，把评分带偏。
            self._special = set()
            for name in ("[CLS]", "[SEP]", "[PAD]", "<s>", "</s>", "<pad>", "[MASK]"):
                tid = None
                try:
                    tid = self._tok.token_to_id(name)
                except Exception:
                    tid = None
                if tid is not None:
                    self._special.add(tid)
        except Exception as e:
            self.unavailable_reason = f"tokenizer 不可得（首次需联网下载）: {e}"
            self.log(f"语义压缩不可用：{self.unavailable_reason}")
            return False

        try:
            onnx_path = hf_hub_download(repo_id=MODEL_ID, filename=MODEL_ONNX)
        except Exception as e:
            self.unavailable_reason = f"ONNX 权重不可得（约 140MB，首次需下载）: {e}"
            self.log(f"语义压缩不可用：{self.unavailable_reason}")
            return False

        try:
            so = ort.SessionOptions()
            so.log_severity_level = 3
            self._sess = ort.InferenceSession(onnx_path, sess_options=so,
                                              providers=["CPUExecutionProvider"])
            self._np = np
            self._ready = True
            self.log(f"语义压缩已就绪：{MODEL_ID}（阈值 {self.threshold}）")
            return True
        except Exception as e:
            self.unavailable_reason = f"ONNX 会话创建失败: {e}"
            self.log(f"语义压缩不可用：{self.unavailable_reason}")
            return False

    # ---------------- 推理 ----------------
    def _keep_flags(self, text, threshold):
        """返回与文本 token 一一对应的保留标记。"""
        np = self._np
        enc = self._tok.encode(text)
        ids = list(enc.ids)
        if not ids:
            return [], []
        feeds = {
            "input_ids": np.asarray([ids], dtype=np.int64),
            "attention_mask": np.asarray([[1] * len(ids)], dtype=np.int64),
        }
        names = {i.name for i in self._sess.get_inputs()}
        feeds = {k: v for k, v in feeds.items() if k in names}
        logits = self._sess.run(None, feeds)[0]          # [1, seq, L]
        arr = np.asarray(logits)[0]

        if arr.ndim == 1:
            scores = arr
        elif arr.shape[-1] == 1:
            scores = 1.0 / (1.0 + np.exp(-arr[:, 0]))    # 单 logit → sigmoid
        else:
            x = arr - arr.max(axis=-1, keepdims=True)
            e = np.exp(x)
            probs = e / e.sum(axis=-1, keepdims=True)
            scores = probs[:, -1]                        # 最后一类 = 保留概率

        thr = self.threshold if threshold is None else threshold
        flags = [bool(s >= thr) for s in scores[:len(ids)]]
        if len(flags) < len(ids):
            flags += [True] * (len(ids) - len(flags))
        return ids, flags

    def compress(self, text, threshold=None):
        if not text or not isinstance(text, str):
            return text
        if len(text) < MIN_CHARS:
            return text

        if self.forced_text_mode:
            return self._project(text, threshold)

        if not self._load():
            return self._project(text, threshold)

        try:
            protected = []
            frag_index = {}

            def stash(m):
                # 按【内容】编号而非按出现次数：同一片段复用同一占位符，
                # 否则内容重复的行会拿到不同占位符，精确去重彻底失效。
                frag = m.group(0)
                idx = frag_index.get(frag)
                if idx is None:
                    idx = len(protected)
                    frag_index[frag] = idx
                    protected.append(frag)
                return f"\u0000P{idx}\u0000"

            masked = PROTECT_RE.sub(stash, text)

            # 中文（及日韩）必须走行级剪枝：
            # WordPiece 会把中文按字切，token 级丢弃会打碎词语
            # （"如何"→"何"、"配置"→"配"），且多字节 UTF-8 会被从中间切
            # 开产生 U+FFFD。行级「整行留或整行丢」物理上不可能乱码。
            # 按内容类型分流：
            #   日志/结构化行 → 行级（整行留或整行丢），保住词位结构
            #   自然语言散文 → 词级（Headroom 同款），粒度更细
            # 两者都天然兼容中文：中文整句是一个「词/行」，同生共死，不会碎。
            if _log_ratio(masked) >= 0.3:
                lvl = self._line_level(masked, threshold)
                out = lvl if lvl != masked else self._word_level(masked, threshold)
            else:
                out = self._word_level(masked, threshold)

            for i, frag in enumerate(protected):
                out = out.replace(f"\u0000P{i}\u0000", frag)
            return out if len(out) < len(text) else text
        except Exception as e:
            self.log(f"语义压缩出错（已忽略，原样使用）: {e}")
            return text

    # ---------------- 词级剪枝（Headroom 同款，中文安全） ----------------
    def _words_by_line(self, content):
        """按空白切词，并记录每个词来自哪一行（重建时不能跨行粘连，否则会把无关事实拼在一起）。"""
        words, line_ids = [], []
        for li, line in enumerate(content.split("\n")):
            for w in line.split():
                words.append(w)
                line_ids.append(li)
        return words, line_ids

    def _join_kept(self, words, line_ids, kept):
        """重建：跨行边界换行，行内用空格。"""
        parts = []
        prev = None
        for i in sorted(kept):
            if prev is not None:
                parts.append("\n" if line_ids[i] != prev else " ")
            parts.append(words[i])
            prev = line_ids[i]
        return "".join(parts)

    def _word_level(self, text, threshold):
        """
        按【空白分隔的词】剪枝，而不是按 token。
        这是兼容中文的关键：中文没有空格，整句会成为一个「词」，
        它的全部 token 同生共死 —— 物理上不可能碎词或产生乱码。
        代价是中文粒度粗（整句取舍），换来的是绝对安全。
        """
        np = self._np
        thr = self.threshold if threshold is None else threshold
        words, line_ids = self._words_by_line(text)
        if not words:
            return text

        kept = set()
        # 逐词编码后拼成块：对齐是「构造出来」的，不依赖预分词器，绝不会错位
        body_ids = []
        body_word = []
        for wi, w in enumerate(words):
            ids = self._tok.encode(w, add_special_tokens=False).ids
            for t in ids:
                body_ids.append(t)
                body_word.append(wi)

        if not body_ids:
            return text

        names = {x.name for x in self._sess.get_inputs()}
        for start in range(0, len(body_ids), CHUNK_WORDS * 6):
            end_i = min(start + CHUNK_WORDS * 6, len(body_ids))
            chunk = body_ids[start:end_i]
            chunk_words_idx = body_word[start:end_i]
            feeds = {
                "input_ids": np.asarray([chunk], dtype=np.int64),
                "attention_mask": np.asarray([[1] * len(chunk)], dtype=np.int64),
            }
            feeds = {k: v for k, v in feeds.items() if k in names}
            arr = np.asarray(self._sess.run(None, feeds)[0])[0]
            if arr.ndim == 1:
                sc = arr
            elif arr.shape[-1] == 1:
                sc = 1.0 / (1.0 + np.exp(-arr[:, 0]))
            else:
                x = arr - arr.max(axis=-1, keepdims=True)
                pr = np.exp(x)
                sc = (pr / pr.sum(axis=-1, keepdims=True))[:, -1]
            # 同一个词的 token 取【最大】分：只要有一处重要就整词保留，偏保守
            agg = {}
            for idx in range(len(chunk)):
                w = chunk_words_idx[idx]
                v = float(sc[idx]) if idx < len(sc) else 1.0
                if w not in agg or v > agg[w]:
                    agg[w] = v
            for w, v in agg.items():
                if v >= thr:
                    kept.add(w)

        # 语义脆弱词一律钉住
        for i, w in enumerate(words):
            if MUST_KEEP_RE.search(w):
                kept.add(i)

        if not kept:
            return text
        out = self._join_kept(words, line_ids, kept)
        if len(out) >= len(text):
            return text
        return f"…[语义压缩：{len(words)} 词 → 保留 {len(kept)} 词]…\n{out}"

    # ---------------- 行级剪枝（日志安全路径） ----------------
    def _line_level(self, text, threshold):
        """
        按「行」决定去留：整行保留或整行丢弃。
        日志靠固定词位表达结构，整行处理才读得通；且物理上不可能乱码。
        """
        np = self._np
        thr = self.threshold if threshold is None else threshold
        lines = text.split("\n")
        enc = self._tok.encode_batch(lines)
        special = self._special
        out = []
        dropped = 0
        dup = 0
        seen = {}
        for i, e in enumerate(enc):
            src = lines[i]
            if not src.strip():
                continue
            key = src.strip()
            if key in seen:          # 精确重复行必丢，最无争议的压缩
                dup += 1
                continue
            seen[key] = 1
            # 语义脆弱行整行保留
            if MUST_KEEP_RE.search(src):
                out.append(src)
                continue
            ids = [t for t in e.ids if t not in special]
            if not ids:
                out.append(src)
                continue
            feeds = {
                "input_ids": np.asarray([ids], dtype=np.int64),
                "attention_mask": np.asarray([[1] * len(ids)], dtype=np.int64),
            }
            names = {x.name for x in self._sess.get_inputs()}
            feeds = {k: v for k, v in feeds.items() if k in names}
            arr = np.asarray(self._sess.run(None, feeds)[0])[0]
            if arr.ndim == 1:
                sc = arr
            elif arr.shape[-1] == 1:
                sc = 1.0 / (1.0 + np.exp(-arr[:, 0]))
            else:
                x = arr - arr.max(axis=-1, keepdims=True)
                pr = np.exp(x)
                sc = (pr / pr.sum(axis=-1, keepdims=True))[:, -1]
            score = float(np.mean(sc)) if len(sc) else 1.0
            # 行级用更宽松的阈值：宁可多留，不可把日志抽干
            if score >= min(thr, 0.2):
                out.append(src)
            else:
                dropped += 1
        if not out or (not dropped and not dup):
            return text
        res = "\n".join(out)
        if len(res) >= len(text):
            return text
        note = f"…[日志压缩：{len(lines)} 行 → 保留 {len(out)} 行"
        if dup:
            note += f"，去重 {dup}"
        if dropped:
            note += f"，低价值 {dropped}"
        return note + "]…\n" + res

    # ---------------- 不依赖模型的兜底：按 token 投影 ----------------
    def _project(self, text, threshold):
        """
        没有模型时的降级路径：按 token 密度做「保留不重复用语」的投影。
        只做保守裁剪（丢纯重复短语），保证任何环境下都有一定收益。
        """
        try:
            lines = text.split("\n")
            seen = set()
            out = []
            dropped = 0
            for ln in lines:
                k = ln.strip()
                if not k:
                    continue
                if k in seen and len(k) < 200:
                    dropped += 1
                    continue
                seen.add(k)
                out.append(ln)
            if not dropped:
                return text
            res = "\n".join(out)
            if len(res) >= len(text):
                return text
            return f"…[已去重 {dropped} 行]…\n{res}"
        except Exception:
            return text


def make(log=None, threshold=0.5):
    """工厂：调用方拿到的一定是可用对象（不可用时 compress() 原样返回）。"""
    return Kompress(threshold=threshold, log=log)


if __name__ == "__main__":
    import unicodedata
    k = make(log=lambda m: print("[kompress]", m, file=sys.stderr))

    lines = []
    for i in range(25):
        lines.append("2026-10-16 04:00:00 INFO 心跳正常，无异常。")
        lines.append(f"2026-10-16 04:00:{i%60:02d} INFO 处理第 {i} 批任务，耗时 {i*3}ms，队列长度 {100-i}。")
        lines.append(f"INFO processing batch {i} of 25 with 0 errors and 0 retries")
    # 语义脆弱行：绝不能丢这些词
    lines.append("2026-10-16 04:01:00 FATAL 数据库连接被拒绝，服务禁止继续启动。")
    lines.append("重要：除非配置项 required=true，否则不要自动重试，必须手动确认。")
    lines.append("You must NOT delete the /var/lib/data directory unless approved.")
    sample = "\n".join(lines)

    out = k.compress(sample)
    print(f"输入 {len(sample)} 字符 → 输出 {len(out)} 字符（省 {100*(1-len(out)/max(1,len(sample))):.1f}%）")

    def has_bad(s):
        return "\ufffd" in s

    checks = [
        ("无乱码 U+FFFD", not has_bad(out)),
        ("FATAL 存活", "FATAL" in out),
        ("中文否定「禁止」存活", "禁止" in out),
        ("中文否定「不要」存活", "不要" in out),
        ("中文情态「必须」存活", "必须" in out),
        ("中文条件「除非」存活", "除非" in out),
        ("英文否定 NOT 存活", "NOT" in out or "not" in out),
        ("路径 /var/lib/data 存活", "/var/lib/data" in out),
    ]
    for name, okk in checks:
        print(f"  {'✓' if okk else '✗'} {name}")

    print("\n---- 输出前 300 字符 ----")
    print(out[:300].replace("\n", "⏎"))
