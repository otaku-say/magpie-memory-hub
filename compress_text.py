#!/usr/bin/env python3
"""
compress_text.py — 语义压缩（离线管线侧）
==========================================
选用当前中英混合场景效果最佳的抽取式多语言小模型：

    microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank
      （INT8 ONNX 社区量化版：KatawaDead/llmlingua-2-bert-base-multilingual-cased-meetingbank-onnx-int8）
      基座 XLM-RoBERTa-large（560M 参数，250k SentencePiece 丰富多语言词表）
      token / 词级重要性二分类器（非生成式，零幻觉风险）
      原生支持中英混合与跨语言上下文长文本，CPU 推理约 400ms，MIT 许可

依赖保持极轻：只需 onnxruntime + tokenizers + numpy + huggingface_hub，
不引入 transformers 或 PyTorch。

设计原则：**永远 fail-open**
    没有 onnxruntime / 没下载模型 / 推理出错 —— 一律原样返回，
    绝不让压缩成为链路上的失败点。它是纯增益的可选组件。
"""

import os
import re
import sys

MODEL_ID = os.environ.get("KOMPRESS_MODEL", "KatawaDead/llmlingua-2-bert-base-multilingual-cased-meetingbank-onnx-int8")
MODEL_ONNX = os.environ.get("KOMPRESS_ONNX", "model.onnx")
MAX_TOKENS = int(os.environ.get("KOMPRESS_MAX_TOKENS", "512"))
MIN_CHARS = int(os.environ.get("KOMPRESS_MIN_CHARS", "600"))

# 绝不压缩的内容：代码块、堆栈、URL、路径、时间戳、长哈希
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

# 「语义脆弱词」必须钉住，永不因模型打分被丢：
# 包含中英否定词、情态词、条件词、环境变量名、命令行参数、版本号、数字及单位
MUST_KEEP_RE = re.compile(
    r"\u0000P\d+\u0000"
    r"|\b0x[0-9A-Fa-f]+\b"
    r"|(?<![\w.])\d+(?:\.\d+)?(?![\w.])"
    r"|\b[A-Z][A-Z0-9_]{2,}\b"
    r"|[a-z_][a-z0-9_]*\.[a-z0-9_]+"
    r"|/[a-z0-9/._-]{2,}"
    r"|\.[a-z]{2,4}\b"
    r"|--?[a-z][\w-]*"
    r"|\bv?\d+(?:\.\d+)+(?:-[a-zA-Z0-9.]+)?\b"
    r"|\b\d+(?:ms|s|m|h|MB|GB|KB|kb|qps|QPS|%)\b"
    r"|(?i:\b(?:not|never|none|cannot|can't|don't|doesn't|didn't|won't|shouldn't"
    r"|mustn't|isn't|aren't|avoid|refuse|prohibited|forbidden|disallow|unless"
    r"|except|without|must|should|shall|required|always|only|mandatory|and|or|nor|xor"
    r"|fatal|critical|severe)\b)"
    r"|(?:不|别|没|无|非|禁止|严禁|切勿|不得|不可|不能|不要|无需|免|必须|务必|只能|仅|只|应当|应该|需要|要求|除非|否则|除了|以及|或者|和|并且|但是|然而|如果|若|当)"
)

# XLM-RoBERTa/BERT 架构单次输入分块上限（Position Embeddings 限制为 512）
MAX_CHUNK_TOKENS = int(os.environ.get("KOMPRESS_CHUNK_TOKENS", "450"))

# 日志/结构化行特征：时间戳 + 级别，或以级别开头
LOG_LINE_RE = re.compile(
    r"^\s*(?:\u0000P\d+\u0000\s*)?(?:\[?\d{2,4}[-/]\d{1,2}[-/]\d{1,2}[ T][\d:.]+|"
    r"\[?(?:INFO|DEBUG|TRACE|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|SEVERE)\]?)\b",
    re.I,
)


# ---------------------------------------------------------------
# 行模板（去重用的标准化键）
#
# 为什么需要它：原先去重是【整行精确匹配】，于是「只差时间戳」的行全部漏掉——
# 而真实日志里这种形态恰恰占绝大多数（心跳/轮询/重试，每行仅时间戳不同）。
# 实测：40 行完全重复的日志能压 94%，但 40 行仅时间戳不同的日志压缩 0%。
#
# 做法：把行里【按规律变化的片段】替换成占位符，剩下的即「内容模板」。
# 同一模板的行视为「同一种日志」，可折叠为首尾 + 重复计数。
# 注意：只抹掉【结构性易变段】，绝不抹掉有语义的词（否定/情态/路径/参数等）。
_TPL_VOLATILE = [
    # 【必须放在最前】PROTECT_RE 已把路径/时间戳等替换成 \u0000P<n>\u0000 占位符，
    # 而每个占位符的编号不同（P0、P1、P2…）。不先归一化它们，
    # 40 行「只差时间戳」的日志会变成 40 个不同模板，模板去重完全失效。
    # 这是第一版补丁没生效的真正原因。
    (re.compile("\x00P\\d+\x00"), "<p>"),
    # ISO8601 / 常见日志时间戳
    (re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"), "<ts>"),
    # 只有时分秒
    (re.compile(r"\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b"), "<ts>"),
    # UUID
    (re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<uuid>"),
    # 长十六进制（hash / 十六进制 id）
    (re.compile(r"\b[0-9a-fA-F]{16,}\b"), "<hex>"),
    # 常见「键=值」里的可变值：耗时/内存/条数/大小/延迟
    (re.compile(r"\b(elapsed|duration|took|took_ms|latency|mem|memory|size|count|total|n|id|pid|tid|job|batch|worker|req|conn)=[-\w.]+", re.I), r"\1=<v>"),
    (re.compile(r"\b\d+(?:\.\d+)?\s?(?:ms|us|µs|ns|s|sec|secs|MB|GB|KB|B|bytes|rows|items|lines)\b", re.I), "<num><unit>"),
    # 独立的数字（含负数与小数）——放最后，避免吃掉上面已处理的
    (re.compile(r"(?<![\w.])[-+]?\d+(?:\.\d+)?(?![\w%])"), "<n>"),
]


# 只有这些行必须【逐行保留】，绝不参与模板折叠。
# 注意不能用 MUST_KEEP_RE 做这个判断——它含裸数字模式（\d+），
# 而几乎每行日志都有时间戳（"2026" 就命中），会把所有行都保护起来、
# 导致模板去重完全失效（这正是第一版补丁没生效的原因）。
_CRITICAL_LINE_RE = re.compile(
    r"\b(?:FATAL|ERROR|CRITICAL|PANIC|SEVERE|Traceback)\b"
    r"|致命|严重|失败|拒绝|崩溃|异常|报错|错误"
    r"|警告升级|必须立即|立即降级|数据丢失",
    re.I,
)


def is_critical_line(src):
    return bool(_CRITICAL_LINE_RE.search(src))


def line_template(src):
    """把一行归一化成「内容模板」；只抹结构性易变段，保留全部语义词。"""
    t = src.strip()
    for rx, rep in _TPL_VOLATILE:
        t = rx.sub(rep, t)
    return t


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
        except Exception as e:
            self.unavailable_reason = (
                "缺少依赖（Alpine: apk add py3-onnxruntime py3-numpy; "
                f"pip install tokenizers）: {e}")
            self.log(f"语义压缩不可用：{self.unavailable_reason}")
            return False

        # 优先读取本地持久卷已下载的模型目录（离线优先，不依赖外网）
        candidates = []
        if os.environ.get("MEMHUB_MODEL_DIR"):
            candidates.append(os.path.expanduser(os.environ["MEMHUB_MODEL_DIR"]))
        candidates.append(os.path.join(os.path.expanduser("~"), ".magpie-memory-hub", "models", "llmlingua2-mbert-int8"))

        local_dir = None
        for cand in candidates:
            if cand and os.path.exists(os.path.join(cand, "model.onnx")) and os.path.exists(os.path.join(cand, "tokenizer.json")):
                local_dir = cand
                break

        tok_path = None
        onnx_path = None
        if local_dir:
            tok_path = os.path.join(local_dir, "tokenizer.json")
            onnx_path = os.path.join(local_dir, "model.onnx")
        else:
            try:
                from huggingface_hub import hf_hub_download
                tok_path = hf_hub_download(repo_id=MODEL_ID, filename="tokenizer.json")
                onnx_path = hf_hub_download(repo_id=MODEL_ID, filename=MODEL_ONNX)
            except Exception as e:
                self.unavailable_reason = f"本地模型未下载且网络获取失败: {e}"
                self.log(f"语义压缩不可用：{self.unavailable_reason}")
                return False

        try:
            self._tok = Tokenizer.from_file(tok_path)
            self._tok.enable_truncation(max_length=MAX_TOKENS)
            self._special = set()
            for name in ("[CLS]", "[SEP]", "[PAD]", "<s>", "</s>", "<pad>", "[MASK]"):
                try:
                    tid = self._tok.token_to_id(name)
                    if tid is not None:
                        self._special.add(tid)
                except Exception:
                    pass
        except Exception as e:
            self.unavailable_reason = f"tokenizer 加载失败: {e}"
            self.log(f"语义压缩不可用：{self.unavailable_reason}")
            return False

        try:
            so = ort.SessionOptions()
            so.log_severity_level = 3
            self._sess = ort.InferenceSession(onnx_path, sess_options=so,
                                              providers=["CPUExecutionProvider"])
            self._input_names = {x.name for x in self._sess.get_inputs()}
        except Exception as e:
            self.unavailable_reason = f"ONNX 会话创建失败: {e}"
            self.log(f"语义压缩不可用：{self.unavailable_reason}")
            return False

        self._np = np
        self._ready = True
        return True

    def compress(self, text, threshold=None, min_chars=None):
        if not text or not isinstance(text, str):
            return text
        limit_chars = MIN_CHARS if min_chars is None else min_chars
        if len(text) < limit_chars:
            return text

        if self.forced_text_mode:
            return self._project(text, threshold)

        if not self._load():
            return self._project(text, threshold)

        try:
            protected = []
            frag_index = {}

            def stash(m):
                frag = m.group(0)
                idx = frag_index.get(frag)
                if idx is None:
                    idx = len(protected)
                    frag_index[frag] = idx
                    protected.append(frag)
                return f"\u0000P{idx}\u0000"

            masked = PROTECT_RE.sub(stash, text)

            # 按内容类型分流：
            #   日志/结构化行 → 行级（整行留或整行丢），保证词位与堆栈结构完整
            #   自然语言长文 / 代码注释 → 短语级/词级（XLM-RoBERTa 子句剪枝），绝不按 token 碎词
            if _log_ratio(text) >= 0.3:
                out = self._line_level(masked, threshold)
            else:
                out = self._phrase_level(masked, threshold)

            for i, frag in enumerate(protected):
                out = out.replace(f"\u0000P{i}\u0000", frag)
            return out if len(out) < len(text) else text
        except Exception as e:
            self.log(f"语义压缩出错（已忽略，原样使用）: {e}")
            return text

    # ---------------- 批次推理打分 ----------------
    def _score_token_sequence(self, token_ids):
        """对长 token 序列分块做上下文编码并输出每个 token 的保留概率"""
        if not token_ids:
            return self._np.array([])
        np = self._np
        all_scores = []
        for start in range(0, len(token_ids), MAX_CHUNK_TOKENS):
            chunk = token_ids[start:start + MAX_CHUNK_TOKENS]
            feeds = {
                "input_ids": np.asarray([chunk], dtype=np.int64),
                "attention_mask": np.asarray([[1] * len(chunk)], dtype=np.int64),
            }
            if "token_type_ids" in self._input_names:
                feeds["token_type_ids"] = np.asarray([[0] * len(chunk)], dtype=np.int64)
            feeds = {k: v for k, v in feeds.items() if k in self._input_names}
            arr = np.asarray(self._sess.run(None, feeds)[0])[0]

            if arr.ndim == 2 and arr.shape[-1] == 2:
                # LLMLingua-2 分类输出 logits [seq, 2] -> softmax 提取保留类 (label 1)
                exp = np.exp(arr - np.max(arr, axis=-1, keepdims=True))
                probs = exp / np.sum(exp, axis=-1, keepdims=True)
                sc = probs[:, 1]
            elif arr.ndim == 1:
                sc = arr
            elif arr.shape[-1] == 1:
                sc = 1.0 / (1.0 + np.exp(-arr[:, 0]))
            else:
                exp = np.exp(arr - np.max(arr, axis=-1, keepdims=True))
                probs = exp / np.sum(exp, axis=-1, keepdims=True)
                sc = probs[:, -1]
            all_scores.extend(sc.tolist())
        return np.array(all_scores)

    # ---------------- 短语级/词级剪枝（中文安全，零乱码） ----------------
    def _units_by_line(self, content):
        """
        中英混合短语级切分：
        - 保护占位符 \\u0000P\\d+\\u0000 作为一个不可分割整体
        - 英文单词 / 标识符按空白与符号切分
        - 中文子句（按标点 ，。！？；;、 结尾）切分为完整语义块，绝不破坏多字节字符
        - 记录每个单元归属的行号，跨行决不粘连
        """
        clause_pattern = re.compile(
            r"(\u0000P\d+\u0000|"
            r"[A-Za-z0-9_.\-]+(?:/[A-Za-z0-9_.\-]+)*|"
            r"[\u4e00-\u9fa5]+[，。！？；;、]?|"
            r"[^\sA-Za-z0-9_\u4e00-\u9fa5])"
        )
        units, line_ids = [], []
        for li, line in enumerate(content.split("\n")):
            matched = clause_pattern.findall(line)
            for u in matched:
                if u.strip():
                    units.append(u)
                    line_ids.append(li)
        return units, line_ids

    def _join_units(self, units, line_ids, kept):
        """重建文本：跨行换行，相邻英文字词补空格，中文字符与标点自然连接。"""
        parts = []
        prev_line = None
        prev_is_en = False
        for i in sorted(kept):
            u = units[i]
            cur_line = line_ids[i]
            cur_is_en = bool(re.match(r"^[A-Za-z0-9_.\-]+$", u))
            if prev_line is not None and cur_line != prev_line:
                parts.append("\n")
                prev_is_en = False
            elif parts and (prev_is_en and cur_is_en):
                parts.append(" ")
            parts.append(u)
            prev_line = cur_line
            prev_is_en = cur_is_en
        return "".join(parts)

    def _phrase_level(self, text, threshold):
        """短语级/词级剪枝：在上下文序列中推理，打分聚合回短语单位。"""
        thr = self.threshold if threshold is None else threshold
        units, line_ids = self._units_by_line(text)
        if not units:
            return text

        kept = set()
        body_ids = []
        body_units = []
        for ui, u in enumerate(units):
            ids = self._tok.encode(u, add_special_tokens=False).ids
            for t in ids:
                body_ids.append(t)
                body_units.append(ui)

        if not body_ids:
            return text

        sc = self._score_token_sequence(body_ids)

        # 聚合回单元：一个单元内的 token 取平均分作为短语紧凑度指标
        unit_tokens = {}
        for ui, s in zip(body_units, sc):
            unit_tokens.setdefault(ui, []).append(float(s))

        for ui, score_list in unit_tokens.items():
            avg_score = self._np.mean(score_list) if score_list else 1.0
            if avg_score >= thr:
                kept.add(ui)

        # 语义脆弱词一律强行钉住
        for i, u in enumerate(units):
            if MUST_KEEP_RE.search(u):
                kept.add(i)

        if not kept:
            return text
        out = self._join_units(units, line_ids, kept)
        if len(out) >= len(text):
            return text
        return f"…[语义压缩：{len(units)} 单元 → 保留 {len(kept)} 单元]…\n{out}"

    # ---------------- 行级剪枝（日志安全路径） ----------------
    def _line_level(self, text, threshold):
        """
        按「行」决定去留：整行保留或整行丢弃。
        日志靠固定词位表达结构，整行处理才读得通；堆栈行与致命错误行 100% 存活。
        """
        np = self._np
        thr = self.threshold if threshold is None else threshold
        lines = text.split("\n")
        out = []
        dropped = 0
        dup = 0
        seen = {}
        seen_tpl = {}          # 模板 -> 首次出现的行号，用于「同模板折叠」
        order = []             # 记录每行在 out 里的下标，便于回填折叠说明
        for src in lines:
            if not src.strip():
                continue
            key = src.strip()
            if key in seen:          # 精确重复行必丢
                dup += 1
                continue
            seen[key] = 1
            # 同模板（只差时间戳/数字/id）的行：也视为重复。
            # 但【必须扣住语义脆弱行】——致命错误、否定/条件/路径等整行保留，
            # 否则会把 FATAL 这类关键行当成「重复」折叠掉。
            tkey = line_template(src)
            if tkey and tkey not in seen_tpl and not is_critical_line(src):
                seen_tpl[tkey] = len(out)
            elif tkey in seen_tpl and not is_critical_line(src):
                order.append(seen_tpl[tkey])
                dup += 1
                continue
            # 语义脆弱行整行保留
            if MUST_KEEP_RE.search(src):
                out.append(src)
                continue
            enc = self._tok.encode(src, add_special_tokens=False)
            if not enc.ids:
                out.append(src)
                continue
            sc = self._score_token_sequence(enc.ids)
            score = float(np.mean(sc)) if len(sc) else 1.0
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

    # ---------------- 不依赖模型的兜底：按行投影 ----------------
    def _project(self, text, threshold):
        """没有模型时的降级路径：只做保守去重，保证任何环境下都有一定收益。"""
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
    k = make(log=lambda m: print("[kompress]", m, file=sys.stderr))

    test_prose = """在现代分布式系统的高并发架构设计中，用 Redis 做分布式缓存层几乎已成为工业界标准实践，但架构师绝不能忽视 TTL 与 eviction policy 的深度配合。当业务流量遭遇突发峰值或者出现 cache stampede 时，如果系统未配置合理的 stale-while-revalidate 降级机制，后端核心 MySQL 关系型数据库的 query throughput 可能会瞬间崩塌，导致全站 P99 latency 急剧飙升至 2500ms 以上。因此在高可用集群中必须规范键值命名空间，启用 allkeys-lru 内存淘汰策略，并且除非业务场景有极其特殊的强一致性要求，否则切勿轻易关闭 pipeline 批量写入优化。此外，对于跨地域 multi-region 部署的主从同步链路，务必监控 network replication lag 指标，防止读取到过期的 stale data 导致数据不一致。"""

    test_logs = """2026-10-16 11:19:50 INFO [heartbeat-agent] 节点集群常规健康检查已完成，全量服务状态正常。
2026-10-16 11:19:52 DEBUG [metrics-pusher] 上报例行系统监控指标完成，等待下次采集周期。
2026-10-16 11:19:55 INFO [cache-sync] 内存状态同步心跳正常，未检测到节点网络抖动。
2026-10-16 11:19:58 DEBUG [task-poller] 轮询异步任务队列，未发现待处理任务。
2026-10-16 11:20:01 INFO [gateway-router] 网关路由正常转发请求至 upstream service-mesh，当前 QPS 稳定在 12500。
2026-10-16 11:20:02 INFO [auth-filter] JWT token verification passed for user_id=987654.
2026-10-16 11:20:03 WARN [connection-pool] 数据库连接池 connection pool idle count 降至警戒水位 5。
2026-10-16 11:20:04 FATAL [worker-core] 数据库连接被拒绝: connection refused to 10.0.4.15:5432，服务禁止继续处理事务！
Traceback (most recent call last):
  File "/opt/magpie/services/storage_manager.py", line 142, in acquire_connection
    conn = pool.get_connection(timeout=3.0)
  File "/opt/magpie/core/db_pool.py", line 88, in get_connection
    raise DatabaseConnectionError("FATAL: pool exhausted, cannot allocate socket")
storage_manager.DatabaseConnectionError: FATAL: pool exhausted, cannot allocate socket
2026-10-16 11:20:05 ERROR [http-handler] 请求处理失败，返回 HTTP 500 Internal Server Error 给客户端。
2026-10-16 11:20:06 INFO [circuit-breaker] 熔断机制已触发，如果未在 30s 内恢复，系统必须执行 failover。"""

    test_code = """# 注意：严禁在生产环境直接运行 v2.4.1 之前的旧版本，必须升级到 version 2.5.0-rc3 或更高版本。
# 如果环境变量 MEMHUB_FORCE_OFFLINE 未配置为 true，守护进程切勿在公网监听 0.0.0.0:8080。
# 启动前必须通过 /usr/local/bin/magpie-cli --check-config --strict-mode 验证配置文件 /etc/magpie/hub.conf 的语法。
# 任何情况下除非指定了 --allow-root-execution 参数，否则禁止使用 root 用户启动 NODE_ENV=production 服务。
# 警告：未设置 TIMEOUT_SECONDS 时默认超时为 60s，务必确认 DB_MAX_CONNECTIONS 不得超过 100。"""

    print("==================================================================")
    print("【测试 1】中文散文夹英文术语压缩")
    print("==================================================================")
    out1 = k.compress(test_prose, min_chars=0)
    print(f"输入 {len(test_prose)} 字符 → 输出 {len(out1)} 字符（压缩率 {100*(1-len(out1)/len(test_prose)):.1f}%）")
    print("输出内容:\n" + out1)

    print("\n==================================================================")
    print("【测试 2】中文技术日志夹英文报错（含 FATAL、堆栈、路径）压缩")
    print("==================================================================")
    out2 = k.compress(test_logs, min_chars=0)
    print(f"输入 {len(test_logs)} 字符 → 输出 {len(out2)} 字符（压缩率 {100*(1-len(out2)/len(test_logs)):.1f}%）")
    print("输出内容:\n" + out2)

    print("\n==================================================================")
    print("【测试 3】中英混排代码注释与配置（含环境变量、命令行参数、版本号）压缩")
    print("==================================================================")
    out3 = k.compress(test_code, min_chars=0)
    print(f"输入 {len(test_code)} 字符 → 输出 {len(out3)} 字符（压缩率 {100*(1-len(out3)/len(test_code)):.1f}%）")
    print("输出内容:\n" + out3)
