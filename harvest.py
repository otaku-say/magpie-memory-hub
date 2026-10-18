#!/usr/bin/env python3
"""
harvest.py — 记忆抓取与提炼管线（v5.1）
========================================
中间件把每轮对话写成一行 [MEMORY_HARVEST]{json} 到网关日志，
本脚本消费这些行，提炼后写入 NoCodeBackend。

吸收 Headroom 的两条核心思路：
  1. 【提炼】启发式事实抽取与规则仲裁（零外部模型）
  2. 【失败学习】成功相关性：先定位失败现象，再找它之后真正奏效的做法，
     产出「具体纠正」而不是笼统建议 —— 这类结果进 pitfalls 表

模型 ID 与数据库凭据全部来自配置，不写死任何模型。

用法：
    # 跟随日志（默认）
    python3 harvest.py --log ~/.magpie/magpie.log

    # 从文件一次性处理
    python3 harvest.py --file harvest.jsonl

    # 从标准输入
    tail -f magpie.log | python3 harvest.py

    # 只看会提炼出什么，不写库
    python3 harvest.py --file harvest.jsonl --dry-run

配置优先级：命令行参数 > 环境变量 > 配置文件(~/.magpie-memory-hub.json)
"""

import os
import re
import sys
import json
import time
import hashlib
import argparse
import math
import subprocess
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone

NCB_BASE = "https://api.nocodebackend.com"

CATEGORIES = ["preference", "fact", "context", "entity", "decision", "insight"]

# ---------------------------------------------------------------- 配置


def plugin_options(cfg, logfn):
    """
    从插件 options 读配置（经 `magpie plugin options <name>`）。
    这样「设置页填一次」就够，不必在插件和离线管线各配一遍。
    读不到就返回空字典，不影响其它来源。
    """
    binp = cfg.get("magpie_bin") or "magpie"
    name = cfg.get("plugin_name") or "magpie-memory-hub"
    try:
        r = subprocess.run([binp, "plugin", "options", name],
                           capture_output=True, text=True, timeout=30)
    except Exception:
        return {}
    out = _strip_ansi(r.stdout) + _strip_ansi(r.stderr)
    i = out.find("{")
    if i < 0:
        return {}
    try:
        return json.loads(out[i:out.rfind("}") + 1])
    except Exception:
        return {}


def load_config(args):
    cfg = {
        "ncb_instance": "41694_agent_memory",
        "ncb_secret": "",
        "min_confidence": 0.6,
        "project": "global",
        # --- 快照推送（闭环）：把记忆推回网关，供中间件注入 ---
        "magpie_bin": "magpie",
        "plugin_name": "magpie-memory-hub",
        "push_snapshot": True,
        "snapshot_cap": 500,
        "snapshot_interval": 60,
        "dormant_days": 45,
        # --- 任务 A: 失败学习证据门槛 ---
        "min_evidence": 3,
        "evidence_file": os.path.expanduser("~/.magpie-memory-hub-evidence.json"),
        "evidence_max_entries": 5000,
        "evidence_ttl_days": 90,
        # --- 任务 B: 作用域提升 ---
        "enable_promotion": True,
        "promotion_min_hits": 3,
        "promotion_min_confidence": None,
        "promotion_batch_limit": 50,
    }
    path = os.path.expanduser(args.config or "~/.magpie-memory-hub.json")
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception as e:
            log(f"配置文件读取失败，忽略: {e}")

    env_map = {
        "ncb_instance": "NCB_INSTANCE",
        "ncb_secret": "NCB_SECRET_KEY",
        "project": "MEMORY_PROJECT",
        "magpie_bin": "MAGPIE_BIN",
        "min_evidence": "MIN_EVIDENCE",
        "evidence_file": "EVIDENCE_FILE",
        "enable_promotion": "ENABLE_PROMOTION",
        "promotion_min_hits": "PROMOTION_MIN_HITS",
        "promotion_batch_limit": "PROMOTION_BATCH_LIMIT",
    }
    for k, ev in env_map.items():
        if os.environ.get(ev):
            cfg[k] = os.environ[ev]

    # 先应用「定位 magpie 所需」的两个参数，否则下面会去调不存在的 magpie
    for k in ("magpie_bin", "plugin_name"):
        v = getattr(args, k, None)
        if v:
            cfg[k] = v

    # 插件 options 作为一层来源（优先级低于命令行，高于文件与环境变量）。
    # 设置页里的实例/密钥/模型/阈值都会被这里读到，避免两处配置漂移。
    po = plugin_options(cfg, log)
    for k in ("ncb_instance", "ncb_secret",
              "min_confidence",
              "min_evidence", "evidence_file", "enable_promotion",
              "promotion_min_hits", "promotion_batch_limit"):
        v = po.get(k)
        if v not in (None, ""):
            cfg[k] = v
    cfg["_from_plugin_options"] = bool(po)

    for k in ("ncb_instance",
              "project", "magpie_bin",
              "evidence_file"):
        v = getattr(args, k, None)
        if v:
            cfg[k] = v
    if getattr(args, "min_evidence", None) is not None:
        cfg["min_evidence"] = args.min_evidence
    if getattr(args, "no_promotion", False):
        cfg["enable_promotion"] = False
    if getattr(args, "promotion_min_hits", None) is not None:
        cfg["promotion_min_hits"] = args.promotion_min_hits
    if getattr(args, "promotion_batch_limit", None) is not None:
        cfg["promotion_batch_limit"] = args.promotion_batch_limit

    # 类型校正
    try:
        cfg["min_evidence"] = int(cfg["min_evidence"])
    except Exception:
        cfg["min_evidence"] = 3
    try:
        cfg["promotion_min_hits"] = int(cfg["promotion_min_hits"])
    except Exception:
        cfg["promotion_min_hits"] = 3
    try:
        cfg["promotion_batch_limit"] = int(cfg["promotion_batch_limit"])
    except Exception:
        cfg["promotion_batch_limit"] = 50
    if isinstance(cfg.get("enable_promotion"), str):
        cfg["enable_promotion"] = cfg["enable_promotion"].lower() not in ("0", "false", "no", "off")
    return cfg


def log(msg):
    sys.stderr.write(f"[harvest] {msg}\n")
    sys.stderr.flush()


# ------------------------------------------------------------- NCB 客户端


class NCB:
    def __init__(self, instance, secret):
        self.instance = instance
        self.secret = secret

    def _call(self, method, action, table, data=None, params=None, rid=None):
        qs = urllib.parse.urlencode(dict({"Instance": self.instance}, **(params or {})))
        suffix = "" if rid is None else f"/{urllib.parse.quote(str(rid))}"
        url = f"{NCB_BASE}/{action}/{table}{suffix}?{qs}"
        headers = {"Content-Type": "application/json"}
        if self.secret:
            headers["Authorization"] = f"Bearer {self.secret}"
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                out = json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="ignore")[:200]
            hint = ""
            if "secret_key" in detail:
                hint = "（数据库 Secret Key 不正确）"
            elif e.code in (401, 403):
                hint = "（该表未对外开放，必须配置正确的 Secret Key）"
            raise RuntimeError(f"NCB {action}/{table} HTTP {e.code}: {detail}{hint}")
        if isinstance(out, dict) and out.get("status") == "failed":
            raise RuntimeError(f"NCB {action}/{table}: {out.get('error')}")
        return out

    def rows(self, table, params=None):
        out = self._call("GET", "read", table, params=dict({"limit": 200}, **(params or {})))
        return out.get("data") or []

    def create(self, table, data):
        return self._call("POST", "create", table, data=data)

    def update(self, table, rid, data):
        return self._call("PUT", "update", table, data=data, rid=rid)

    def all(self, table, params=None):
        """翻页取全（NCB 默认每页 10~200）"""
        acc, page = [], 1
        while page <= 20:
            p = dict({"limit": 200, "page": page}, **(params or {}))
            out = self._call("GET", "read", table, params=p)
            batch = out.get("data") or []
            if not batch:
                break
            acc.extend(batch)
            meta = out.get("metadata") or {}
            if not meta.get("hasMore"):
                break
            page += 1
        return acc


def normalize_semantic_text(text):
    if not text:
        return ""
    s = str(text).lower()
    for ch in "`*#_~[]「」『』“”‘’\"'":
        s = s.replace(ch, "")
    for ch in "的之地得":
        s = s.replace(ch, "")
    synonyms = [
        ("端点与工具特性", "端点与特性"), ("工具特性与端点", "端点与特性"),
        ("接口与特性", "端点与特性"), ("端点及特性", "端点与特性"),
        ("特性说明", "特性"), ("工具特性", "特性"), ("功能特性", "特性"),
        ("依赖管理", "管理依赖"), ("进行依赖管理", "管理依赖"), ("依赖包管理", "管理依赖"),
        ("记忆保存", "保存记忆"), ("严禁", "禁止"), ("不可", "禁止"), ("不要", "禁止"),
        ("切勿", "禁止"), ("采用", "使用"), ("利用", "使用"), ("直达", "直接"),
        ("进行", ""), ("关于", ""), ("对于", ""), ("具备", "提供"), ("拥有", "提供")
    ]
    for old, new in synonyms:
        s = s.replace(old, new)
    import re
    s = re.sub(r"[，。！？、；：:,\.!\?;\\/\-_|~～\(\)（）《》〈〉【】〔〕\s\t\r\n]+", "", s)
    return s


def semantic_fingerprint(project, category, title, content):
    norm_title = normalize_semantic_text(title)
    norm_content = normalize_semantic_text(content)
    text = f"{project}:{category}:{norm_title}:{norm_content}"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def fingerprint(text):
    return hashlib.sha256(str(text).strip().lower().encode("utf-8")).hexdigest()[:32]


def now_str():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ------------------------------------------------- 失败学习（Headroom 式）

# 失败特征：报错原文 / 非零退出 / 明确失败词
FAIL_PATTERNS = [
    r"(?i)\b(?:Traceback \(most recent call last\)|ModuleNotFoundError|ImportError|SyntaxError|TypeError|ValueError|AttributeError|KeyError|IndexError|NameError)\b[^\n]*",
    r"(?i)\b(?:command not found|No such file or directory|Permission denied|Address already in use|connection refused|timed out)\b[^\n]*",
    r"(?i)\b(?:ERROR|FATAL|FAILED|FAIL|Error:)\b[^\n]{0,120}",
    r"(?i)\bexit code\s*(?!0\b)\d+\b[^\n]*",
    r"(?i)\bHTTP[/ ]?\d*[ -]?(?:4\d\d|5\d\d)\b[^\n]*",
]

# 成功特征：真正奏效之后出现的信号
OK_PATTERNS = [
    r"(?i)\b(?:success|succeeded|passed|PASS|OK|done|fixed|resolved|works? now|green)\b[^\n]{0,80}",
    r"(?i)\bexit code\s*0\b[^\n]*",
    r"(?i)\b\d+ (?:passed|passing)\b[^\n]*",
]


def levenshtein_distance(s1, s2):
    m, n = len(s1), len(s2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if s1[i - 1] == s2[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    return dp[m][n]


GENERIC_NOISE_TOOLS = frozenset({
    "cat", "grep", "rg", "awk", "sed", "head", "tail", "sort", "uniq",
    "wc", "xargs", "find", "echo", "true", "false", "test", "more", "less"
})


def extract_executable(cmd_line):
    if not cmd_line:
        return ""
    clean = re.sub(r"^[$#>]\s*", "", str(cmd_line).strip())
    clean = re.sub(r"^(?:sudo|time|nohup|exec|env)\s+", "", clean, flags=re.I)
    m = re.match(r"^([a-zA-Z0-9_.\-]+)", clean)
    if not m:
        return ""
    token = m.group(1).replace("\\", "/")
    return os.path.basename(token).lower()


def is_generic_tool_invocation(line):
    bin_name = extract_executable(line)
    return bin_name in GENERIC_NOISE_TOOLS


def is_likely_command_line(line):
    s = str(line or "").strip()
    if re.match(r"^[$#>]\s+[a-zA-Z0-9_.\-]+", s):
        return True
    bin_name = extract_executable(s)
    if not bin_name:
        return False
    common_bins = {
        "npm", "npx", "pnpm", "yarn", "pip", "pip3", "python", "python3", "uv",
        "cargo", "gem", "brew", "git", "curl", "wget", "docker", "kill", "killall",
        "apt", "apt-get", "systemctl", "service", "pytest", "node", "make", "bash",
        "sh", "source", "chmod", "chown", "mv", "cp", "rm", "mkdir", "cat", "grep",
        "rg", "awk", "sed", "head", "tail", "sort", "uniq", "wc", "xargs", "find"
    }
    return bin_name in common_bins


def normalize_command_args(cmd):
    s = re.sub(r"^[$#>]\s*", "", str(cmd or "").strip())
    s = re.sub(r"\s+", " ", s)
    return [tok for tok in s.split(" ") if tok and not tok.startswith("-")]


def have_substantive_args_overlap(cmd1, cmd2):
    t1 = normalize_command_args(cmd1)[1:]
    t2 = normalize_command_args(cmd2)[1:]
    set2 = {t.lower() for t in t2}
    for t in t1:
        if len(t) >= 3 and t.lower() in set2:
            return True
    return False


def is_command_retry_compatible(failed_cmd, solution_cmd, error_type="general"):
    bin_a = extract_executable(failed_cmd)
    bin_b = extract_executable(solution_cmd)
    if not bin_a or not bin_b:
        return True
    if bin_a in GENERIC_NOISE_TOOLS or bin_b in GENERIC_NOISE_TOOLS:
        return False
    if bin_a == bin_b:
        if error_type == "missing_dependency" and re.search(r"(?:install|add|get)\b", solution_cmd, re.I):
            return True
        s1, s2 = str(failed_cmd).strip(), str(solution_cmd).strip()
        max_len = max(len(s1), len(s2))
        dist = levenshtein_distance(s1, s2)
        norm_dist = (dist / max_len) if max_len > 0 else 0
        return norm_dist <= 0.40 or have_substantive_args_overlap(s1, s2)
    allowed_cross_bins = {
        "missing_dependency": {"pip", "pip3", "npm", "pnpm", "yarn", "cargo", "brew", "apt", "apt-get", "uv"},
        "missing_command": {"apt", "apt-get", "brew", "npm", "pip", "cargo", "uv"},
        "port_conflict": {"kill", "killall", "fuser"},
        "permission": {"chmod", "chown", "sudo"},
        "missing_path": {"mkdir", "touch", "cp", "mv", "ln"},
    }
    valid_target_bins = allowed_cross_bins.get(error_type, set())
    return bin_b in valid_target_bins


def find_preceding_command(lines, at_index):
    for j in range(at_index, max(-1, at_index - 4), -1):
        if j < len(lines):
            l = lines[j].strip()
            if is_likely_command_line(l):
                return l
    return None


SCAFFOLDING_PATTERNS = [
    r"(?is)<app-context[\s\S]*?(?:<\/app-context>|$)",
    r"(?is)<system-reminder[\s\S]*?(?:<\/system-reminder>|$)",
    r"(?is)<permissions instructions[\s\S]*?(?:<\/permissions instructions>|$)",
    r"(?is)<skills_instructions[\s\S]*?(?:<\/skills_instructions>|$)",
    r"(?is)<context[\s\S]*?(?:<\/context>|$)",
    r"(?is)<instructions[\s\S]*?(?:<\/instructions>|$)",
    r"(?i)#\s*agents\.md\s+instructions\s+for[^\n]*",
    r"(?i)another language model started to solve[^\n]*",
    r"(?im)^\[developer instructions\][\s\S]*?(?:\n\n|$)",
]


def strip_scaffolding(text):
    if not text:
        return ""
    s = str(text)
    for pat in SCAFFOLDING_PATTERNS:
        s = re.sub(pat, "", s)
    return s.strip()


def is_explicit_user_memory(text):
    """判定是否为用户显式意图沉淀的记忆/避坑指令（穿透门禁）"""
    if not text:
        return False
    s = str(text)
    if "用户提问：" in s or "[user]:" in s:
        parts = []
        for seg in re.split(r"(?=(?:用户提问：|\[user\]:|助手回复：|\[assistant\]:))", s):
            if seg.startswith("用户提问：") or seg.startswith("[user]:"):
                parts.append(re.sub(r"^(?:用户提问：|\[user\]:)\s*", "", seg))
        s = "\n".join(parts)
    if not s:
        return False
    return bool(re.search(r"(?:^|\n|[。！？；：!?;:\n]\s*)(?:记下来|记住|存入记忆|记入记忆|记入避坑|记录避坑|避坑|备忘|必须记住|一定要记|务必遵守|务必记住|mark|remember)[:：\s]", s, re.I) or
                re.search(r"(?:^|\n|[。！？；：!?;:\n]\s*)(?:避坑指南|踩坑记录|避坑备忘)[:：]", s, re.I))


def is_documentation_or_scaffolding(line):
    """判定是否为文档/任务书/规范说明行（绝非真实执行报错或处置解法）"""
    s = str(line or "").strip()
    if not s:
        return True
    if re.search(r"^[-*+]\s+.*(?:不要改代码|由主控裁决|复现步骤|验收标准|任务书|报告里|需求|约束|原则|回归测试|实测输出)", s):
        return True
    if re.search(r"\*\*(?:不要|严禁|必须|禁止|注意)[^*]+\*\*", s):
        return True
    if re.search(r"^(?:要求|约束|注意|规范|原则|提示|目标|修法|根因|说明)[：:]", s):
        return True
    if re.search(r"^[「“\"'].*FAIL.*[」”\"']", s):
        return True
    return False


def _sig(s):
    """把报错压成可聚类的签名：去掉数字/路径/引号等易变部分"""
    s = re.sub(r"\s+", " ", str(s)).strip()
    s = re.sub(r"['\"`][^'\"`]{0,120}['\"`]", "<str>", s)
    s = re.sub(r"\b0x[0-9a-fA-F]+\b", "<hex>", s)
    s = re.sub(r"\b\d+\b", "<n>", s)
    s = re.sub(r"/(?:[\w.\-]+/)+[\w.\-]+", "<path>", s)
    return s[:200]


def mine_failures(text):
    """
    从一段对话文本里挖「失败 → 之后奏效」的配对。
    返回 [{symptom, solution, error_type}]，只保留确实找到了后续成功信号的那些。
    """
    cleaned = _clean_dialogue_text(text)
    if _is_dialogue_noise(cleaned):
        return []

    lines = [l.strip() for l in cleaned.splitlines()]
    fails = []
    for i, line in enumerate(lines):
        if not line or len(line) < 5:
            continue
        if is_code_or_syntax_noise(line):
            continue
        if is_documentation_or_scaffolding(line):
            continue
        if is_generic_tool_invocation(line):
            continue
        if re.search(r"^[#*+-]\s", line):
            continue
        if re.search(r"[「“\"'][^」”\"']*\bFAIL\b[^」”\"']*[」”\"']", line):
            continue

        line_without_inline = strip_inline_code(line).strip()
        for pat in FAIL_PATTERNS:
            m = re.search(pat, line)
            if m:
                matched_str = m.group(0)
                if not re.search(pat, line_without_inline) and ("(" in matched_str or ")" in matched_str or "." in matched_str):
                    continue
                if re.search(r"\bfail\s*\(", line, re.I):
                    continue
                fails.append({"at": i, "raw": matched_str, "symptom": _sig(matched_str)})
                break

    out = []
    seen = set()
    for f in fails:
        # 在失败之后的一段窗口里找成功信号与处置动作
        window = lines[f["at"] + 1: f["at"] + 60]
        failed_cmd = find_preceding_command(lines, f["at"])
        has_ok_signal = False
        for l in window:
            for pat in OK_PATTERNS:
                if re.search(pat, l):
                    has_ok_signal = True
                    break
            if has_ok_signal:
                break

        solution_line = None
        for l in window:
            trimmed = l.strip()
            if not trimmed or is_pure_status_or_noise(trimmed):
                continue
            if is_documentation_or_scaffolding(trimmed):
                continue
            if is_generic_tool_invocation(trimmed):
                continue

            if ACTION_CMD_RE.search(trimmed) or FIX_DESC_RE.search(trimmed):
                # 命令重试校验
                if failed_cmd and is_likely_command_line(trimmed):
                    prelim_etype = "general"
                    low_f = f["raw"].lower()
                    if "modulenotfound" in low_f or "importerror" in low_f:
                        prelim_etype = "missing_dependency"
                    elif "command not found" in low_f:
                        prelim_etype = "missing_command"
                    elif "no such file" in low_f:
                        prelim_etype = "missing_path"
                    elif "permission denied" in low_f:
                        prelim_etype = "permission"
                    elif "already in use" in low_f:
                        prelim_etype = "port_conflict"
                    elif "connection refused" in low_f or "timed out" in low_f:
                        prelim_etype = "network"
                    if not is_command_retry_compatible(failed_cmd, trimmed, prelim_etype):
                        continue
                elif not failed_cmd and not ACTION_CMD_RE.search(trimmed) and not re.search(r"^[$#>]\s*", trimmed):
                    tokens_a = [t for t in re.split(r"[^\w\u4e00-\u9fa5]+", f["raw"].lower()) if len(t) >= 3]
                    low_trimmed = trimmed.lower()
                    if not any(t in low_trimmed for t in tokens_a):
                        continue

                solution_line = trimmed
                break

        if not solution_line:
            continue
        if not has_ok_signal and not re.search(r"(?:解决|修复|搞定|奏效|恢复|生效|成功|fixed|resolved)", solution_line, re.I):
            continue

        # P2: 存储字段与指纹分离，保留原始文本
        raw_symptom = f["raw"].strip()[:500]
        raw_solution = solution_line.strip()[:500]
        masked_symptom = _sig(raw_symptom)
        masked_solution = _sig(raw_solution)
        key = (masked_symptom, masked_solution)
        if key in seen:
            continue
        seen.add(key)

        content_fp = hashlib.sha256(f"{masked_symptom}|||{masked_solution}".encode("utf-8")).hexdigest()[:32]

        # 错误类型：按特征归类
        etype = "general"
        low = f["raw"].lower()
        if "modulenotfound" in low or "importerror" in low:
            etype = "missing_dependency"
        elif "command not found" in low:
            etype = "missing_command"
        elif "no such file" in low:
            etype = "missing_path"
        elif "permission denied" in low:
            etype = "permission"
        elif "already in use" in low:
            etype = "port_conflict"
        elif "connection refused" in low or "timed out" in low:
            etype = "network"
        elif re.search(r"http[/ ]?\d*\s*[45]\d\d", low):
            etype = "http_error"

        out.append({
            "component": etype,
            "symptom": raw_symptom,
            "solution": raw_solution,
            "root_cause": f"执行过程中出现 {raw_symptom}，后续通过执行 {raw_solution} 成功解决",
            "error_type": etype,
            "severity": "high" if etype in ("missing_dependency", "port_conflict") else "medium",
            "content_fingerprint": content_fp,
        })
    return out


# -------------------------------- 启发式环境事实与架构决策提取（参考 Headroom traffic_learner）

GENERIC_PRONOUNS = frozenset({
    "它", "这个", "那个", "某个", "这里", "那里", "代码", "文件", "系统",
    "脚本", "方法", "方案", "命令", "库", "框架", "技术", "工具",
    "this", "that", "it", "something", "tool", "file"
})

# 明显没有长期价值的模式：一次性寒暄、纯状态播报
NOISE_PATTERNS = [
    r"^\s*(好的|明白|收到|嗯|谢谢|你好|ok|okay|sure|thanks|got it)\s*[。.!！]?$",
    r"^\s*(正在|刚刚|已经)(执行|运行|处理|加载)",
]


def strip_code_blocks(text):
    if not text:
        return ""
    s = re.sub(r"```[\s\S]*?```", "", str(text))
    s = re.sub(r"~~~[\s\S]*?~~~", "", s)
    return s


def strip_inline_code(text):
    if not text:
        return ""
    return re.sub(r"`[^`\r\n]+`", "", str(text))


def is_code_or_syntax_noise(line):
    s = str(line or "").strip()
    if not s:
        return True
    if re.search(r"(?:^\/|\/[gimsuy]*\s*,?$)", s) and ("\\b" in s or "(?i)" in s):
        return True
    if re.search(r"^(?:const|let|var|function|return|import|export|class|def|fn|struct|interface|type)\b", s):
        return True
    if re.search(r"^[+-]\s*(?:var|const|let|function|return|if|else|bool|int|string)\b", s):
        return True
    if re.search(r"^[\"']?[\w.-]+[\"']?\s*:\s*[\"'<]", s):
        return True
    if re.search(r";\s*$", s) and ("=" in s or "(" in s or "{" in s):
        return True
    return False


ACTION_CMD_RE = re.compile(
    r"(?:^|[;&|`\s])(?:sudo\s+)?(?:apt|apt-get|npm|npx|pnpm|yarn|pip|pip3|python3?|uv|cargo|gem|brew|git|export|source|\.|mv|cp|rm|mkdir|chmod|chown|systemctl|service|curl|wget|docker|kill|killall)\s+[^\n]{2,120}",
    re.I
)

FIX_DESC_RE = re.compile(
    r"(?:(?:建议|请|必须|统一|改用|已)?(?:通过|采用|使用|执行|运行|改用|安装|配置|调整|更新|升级|修复|修改|重新)\s*[^\n]{2,80}?(?:解决|修复|搞定|奏效|恢复|生效|成功|pass)|(?:解决(?:方法|方案|办法)?|修复(?:方法|方案|办法)?|处置(?:方法|方案)?|应对措施|workaround)[：:\s]+[^\n]{3,120}|(?:已|后续)?(?:通过|改用|切换到|重新安装|修复为|添加|配置)\s*[^\n]{3,120}|(?:fix(?:ed)?|solution|resolved)\s*(?:[：:]|(?:by|via|with|using|to)\s+)[^\n]{3,120})",
    re.I
)


def is_pure_status_or_noise(line):
    s = str(line or "").strip()
    if is_code_or_syntax_noise(s):
        return True
    if re.search(r"^(?:exit code\s*0|\d+\s+passed|success|ok|passed|done|green)[.!]?$", s, re.I):
        return True
    if re.search(r"^\d+\s+passed\s+in\s+[\d.]+s", s, re.I):
        return True
    return False


def is_likely_file_path(p):
    s = str(p or "").strip()
    if "/" not in s and "\\" not in s:
        return False
    if re.search(r"\b(?:prototype|hasOwnProperty|constructor|__proto__|Object|Function|Array)\b", s):
        return False
    if re.match(r"^[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)+$", s):
        return False
    return True


def is_likely_file_path_or_name(p):
    s = str(p or "").strip()
    if "/" in s or "\\" in s:
        return is_likely_file_path(s)
    if re.match(r"^[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*){2,}$", s):
        return False
    if re.search(r"\b(?:prototype|hasOwnProperty|constructor|__proto__|Object|Function|Array)\b", s):
        return False
    return bool(re.match(r"^[a-zA-Z0-9_.~-]+\.[a-zA-Z0-9_-]+$", s))


def is_valid_path_correction(err_p, ok_p):
    p1 = str(err_p or "").strip()
    p2 = str(ok_p or "").strip()
    if not p1 or not p2 or p1 == p2:
        return False
    if not is_likely_file_path(p2) or not is_likely_file_path_or_name(p1):
        return False
    proto_re = r"\b(?:prototype|hasOwnProperty|constructor|__proto__|Object|Function|Array)\b"
    if re.search(proto_re, p1) or re.search(proto_re, p2):
        return False
    base1 = os.path.basename(p1.replace("\\", "/"))
    base2 = os.path.basename(p2.replace("\\", "/"))
    if base1 and base2 and base1 == base2:
        return True
    max_len = max(len(p1), len(p2))
    allowed_dist = max(2, max_len // 3)
    if levenshtein_distance(p1, p2) <= allowed_dist:
        return True
    base_max_len = max(len(base1), len(base2))
    base_allowed_dist = max(2, base_max_len // 3)
    if levenshtein_distance(base1, base2) <= base_allowed_dist:
        return True
    return False


def _clean_dialogue_text(text):
    if not text:
        return ""
    s = re.sub(r"\x1b\[[0-9;]*m", "", str(text))
    s = strip_scaffolding(s)
    return strip_code_blocks(s).strip()


def _is_dialogue_noise(text):
    s = str(text or "").strip()
    if len(s) < 10:
        return True
    lines = [l.strip() for l in s.splitlines() if l.strip()]
    if lines and all(any(re.search(p, l, re.I) for p in NOISE_PATTERNS) for l in lines):
        return True
    return False


def _is_valid_memory_candidate(cand):
    title = str(cand.get("title") or "").strip()
    content = str(cand.get("content") or "").strip()
    if len(title) < 4 or len(title) > 60:
        return False
    if len(content) < 12 or len(content) > 500:
        return False
    if any(re.search(p, content, re.I) for p in NOISE_PATTERNS):
        return False
    return True


def mine_environment_facts(text):
    """
    从对话文本中提取「环境事实（Environment facts）」。
    覆盖：Python虚拟环境激活、有效测试命令、工具链执行规范(如 uv run python vs python3)、路径纠错、命令可用性。
    返回 [{category, scope_level, title, content, tags, confidence}]，category 统一为 'fact'。
    """
    cleaned = _clean_dialogue_text(text)
    if _is_dialogue_noise(cleaned):
        return []

    results = []

    # 1. Python 虚拟环境激活（参考 Headroom: source <venv>/activate）
    venv_matches = re.finditer(
        r"(?:source|\.)\s+([~/\w.\-]+(?:/|\.)venv[/\w.\-]*/activate|[~/\w.\-]+/activate)",
        cleaned,
        re.I
    )
    for m in venv_matches:
        venv_path = m.group(1).strip()
        results.append({
            "category": "fact",
            "scope_level": "project",
            "title": "Python 虚拟环境激活",
            "content": f"Python virtual environment: `source {venv_path}` before running Python tools.",
            "tags": "environment,python,venv",
            "confidence": 0.85,
        })

    # 2. 有效测试命令（参考 Headroom: pytest in cmd and PASSED in output）
    lines = cleaned.splitlines()
    for i, line in enumerate(lines):
        tm = re.search(
            r"(?:^|\s)(?:[$#>]\s*)?((?:uv\s+run\s+)?pytest(?:\s+[\w./\\-]+)*(?:\s+-[a-zA-Z0-9]+)*)",
            line
        )
        if tm:
            cmd = tm.group(1).strip()
            window = "\n".join(lines[max(0, i - 2): min(len(lines), i + 15)])
            if re.search(r"\b(?:PASSED|passed|OK|\d+\s+passed)\b", window):
                results.append({
                    "category": "fact",
                    "scope_level": "project",
                    "title": "可用测试命令",
                    "content": f"Working test command: `{cmd}`",
                    "tags": "environment,test",
                    "confidence": 0.80,
                })

    # 3. 环境执行工具规范（如 uv run python vs python3 / pnpm vs npm）
    # 工具名：允许带参数（如 "uv run python"、"pnpm dlx tsc"）
    NAME = r"[a-zA-Z0-9_.\-]+(?:\s+[a-zA-Z0-9_.\-]+)*"
    # 工具名与连接词之间常插动词/虚词（"执行""运行""来跑""再"…）。
    # 实测：「环境要求必须使用 uv run python 执行，而不是 python3」这种高频表述，
    # 若要求「工具名紧跟连接词」就完全抓不到——必须容许中间夹一层动作词。
    # 有界通配：容许中间夹一小段自然语言（"来跑构建，"、"执行命令，"…）。
    # 上限 14 字符且不允许换行，配合两端的强锚点（统一/必须 + 而不是/不要用），
    # 既能覆盖真实表述又不会跨句误配。
    GAP = r"[^\n]{0,14}?"
    # 按【模式】显式声明方向，不要靠嗅探连接词文本——
    # 实测踩过：靠 "代替/而非" 关键词判断方向时，"不要用" 不在列表里，
    # 于是 "统一使用 pnpm …不要用 npm" 被抓成了 "使用 npm 代替 pnpm"（方向反了）。
    #   dir="avoid_first"：模式形如「不要 X，必须用 Y」→ g1=X(避免) g2=Y(首选)
    #   dir="prefer_first"：模式形如「统一用 X …而不是 Y」→ g1=X(首选) g2=Y(避免)
    TAIL = r"(?:[\s，,。.]|(?:直接|再|去|手动|单独|只|统统|一律))*"
    tool_patterns = [
        # A: 先否定后肯定
        (r"(?:不要|禁止|避免|切勿|别)(?:直接)?(?:使用|运行|用|调用)\s*[`'\"]?(" + NAME + r")[`'\"]?[，,]\s*"
         r"(?:必须|请|统一|改用|需|要)?\s*(?:使用|改用|通过|用)\s*[`'\"]?(" + NAME + r")[`'\"]?",
         "avoid_first"),
        # B: 先肯定后否定（连接词前后都可能夹动作词/副词）
        (r"(?:环境要求|必须|请|统一|要求|规范)[\s：:]*(?:必须|请|统一|要|需)?\s*(?:使用|通过|用)\s*"
         r"[`'\"]?(" + NAME + r")[`'\"]?" + GAP +
         r"(?:代替|替代|而非|而不是|不要用|不用|别用)" + TAIL +
         r"[`'\"]?(" + NAME + r")[`'\"]?",
         "prefer_first"),
    ]
    for pat, direction in tool_patterns:
        for m in re.finditer(pat, cleaned, re.I):
            g1, g2 = m.group(1).strip(), m.group(2).strip()
            if direction == "avoid_first":
                avoid, preferred = g1, g2
            else:
                preferred, avoid = g1, g2

            if preferred.lower() in GENERIC_PRONOUNS or avoid.lower() in GENERIC_PRONOUNS:
                continue
            if preferred.lower() == avoid.lower() or len(preferred) < 2 or len(avoid) < 2:
                continue
            # 工具名不该是纯数字或过长短语
            if preferred.replace(".", "").isdigit() or avoid.replace(".", "").isdigit():
                continue
            if len(preferred) > 40 or len(avoid) > 40:
                continue

            results.append({
                "category": "fact",
                "scope_level": "project",
                "title": f"环境执行工具: 使用 {preferred} 代替 {avoid}",
                "content": f"环境工具链规范：使用 `{preferred}` 代替 `{avoid}` 执行相关命令。",
                "tags": "environment,toolchain",
                "confidence": 0.85,
            })

    # 4. 路径纠错事实（参考 Headroom: _FILE_X_DOES_NOT_EXIST_RE 与 typo recovery）
    en_path_re = r"File\s+[`'\"]?([^`'\"\s\n]+)[`'\"]?\s+does not exist\.\s+The correct path is\s+[`'\"]?([^`'\"\s\n]+)[`'\"]?\.?"
    for m in re.finditer(en_path_re, cleaned, re.I):
        err_p, ok_p = m.group(1).strip(), m.group(2).strip()
        if err_p and ok_p and err_p != ok_p:
            if not is_valid_path_correction(err_p, ok_p):
                continue
            base = os.path.basename(ok_p.replace("\\", "/"))
            results.append({
                "category": "fact",
                "scope_level": "project",
                "title": f"路径纠正: {base}",
                "content": f"文件 `{err_p}` 不存在，正确路径为 `{ok_p}`。",
                "tags": "environment,path",
                "confidence": 0.85,
            })

    cn_path_re = r"(?:文件|路径)?\s*[`'\"]?([~/\w.\-]+\.[a-zA-Z0-9]+)[`'\"]?\s*(?:不存在|未找到|not found|does not exist).*?(?:正确路径(?:为|是)?|实际路径(?:为|是)?|应为|修正为|改用|迁移到)\s*[`'\"]?([~/\w.\-]+\.[a-zA-Z0-9]+)[`'\"]?"
    for m in re.finditer(cn_path_re, cleaned, re.I | re.S):
        err_p, ok_p = m.group(1).strip(), m.group(2).strip()
        if err_p and ok_p and err_p != ok_p:
            if not is_valid_path_correction(err_p, ok_p):
                continue
            base = os.path.basename(ok_p.replace("\\", "/"))
            results.append({
                "category": "fact",
                "scope_level": "project",
                "title": f"路径纠正: {base}",
                "content": f"文件 `{err_p}` 不存在，正确路径为 `{ok_p}`。",
                "tags": "environment,path",
                "confidence": 0.85,
            })

    # 5. 命令可用性与替代（参考 Headroom: command not found）
    cmd_nf_re = r"[`'\"]?([a-zA-Z0-9_-]+)[`'\"]?:\s*command not found.*?(?:改用|请使用|统一使用|已安装|可使用)\s*[`'\"]?([a-zA-Z0-9_-]+)[`'\"]?"
    for m in re.finditer(cmd_nf_re, cleaned, re.I | re.S):
        c_nf, c_alt = m.group(1).strip(), m.group(2).strip()
        if c_nf and c_alt and c_nf != c_alt:
            results.append({
                "category": "fact",
                "scope_level": "project",
                "title": f"命令替代: {c_nf} 不可用，改用 {c_alt}",
                "content": f"环境缺少命令 `{c_nf}`，改用 `{c_alt}` 执行对应操作。",
                "tags": "environment,command",
                "confidence": 0.80,
            })

    # 降噪与去重过滤
    out = []
    seen = set()
    for c in results:
        if not _is_valid_memory_candidate(c):
            continue
        key = (c["category"], c["title"], c["content"])
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def mine_architectural_decisions(text):
    """
    从对话文本中提取「架构决策（Architectural decisions）」。
    覆盖：技术选型与依赖库替代、技术选型角色定位、目录结构与模块分工收口约定、架构规范。
    返回 [{category, scope_level, title, content, tags, confidence}]，category 统一为 'decision'。
    """
    cleaned = _clean_dialogue_text(text)
    if _is_dialogue_noise(cleaned):
        return []

    results = []

    # 1. 依赖选型与库替代决策（Dependency choices / Tech replacement）
    dep_replace_re = r"(?:技术选型|依赖选型|架构决策|选型决策|决定|方案评估)[：:\s]*(?:统一|决定)?(?:采用|使用|选用|引入)\s*[`'\"]?([a-zA-Z0-9_.\-]+)[`'\"]?\s*(?:替代|取代|代替|替换)\s*[`'\"]?([a-zA-Z0-9_.\-]+)[`'\"]?(?:[，,。.\n]|\s*(?:作为|用于))"
    for m in re.finditer(dep_replace_re, cleaned, re.I):
        dep_new, dep_old = m.group(1).strip(), m.group(2).strip()
        if dep_new.lower() in GENERIC_PRONOUNS or dep_old.lower() in GENERIC_PRONOUNS:
            continue
        if dep_new.lower() == dep_old.lower():
            continue
        results.append({
            "category": "decision",
            "scope_level": "project",
            "title": f"技术选型: 使用 {dep_new} 替代 {dep_old}",
            "content": f"架构技术选型决策：采用 `{dep_new}` 替代 `{dep_old}` 作为项目依赖。",
            "tags": "architecture,dependency,decision",
            "confidence": 0.85,
        })

    # 模式 B: 选型/决策采用 X 作为 Y（FastAPI 作为后端框架等）
    dep_role_re = r"(?:技术选型|架构决策|选型决策)[：:\s]*(?:统一|决定)?(?:采用|使用|选用)\s*[`'\"]?([a-zA-Z0-9_.\-]+)[`'\"]?\s*作为\s*([^，,。\n]{2,30}?)(?:[，,。\n]|$)"
    for m in re.finditer(dep_role_re, cleaned, re.I):
        dep_name, role = m.group(1).strip(), m.group(2).strip()
        if dep_name.lower() in GENERIC_PRONOUNS:
            continue
        results.append({
            "category": "decision",
            "scope_level": "project",
            "title": f"技术选型: 采用 {dep_name} 作为 {role}",
            "content": f"架构技术选型决策：采用 `{dep_name}` 作为 {role}。",
            "tags": "architecture,dependency,decision",
            "confidence": 0.85,
        })

    # 模式 C: 英文决策表达 (Adopt/Use X instead of Y)
    en_dep_re = r"(?:Architectural decision|Decision|Tech stack choice)[：:\s]*(?:Adopt|Use)\s+[`'\"]?([a-zA-Z0-9_.\-]+)[`'\"]?\s+(?:instead of|replacing)\s+[`'\"]?([a-zA-Z0-9_.\-]+)[`'\"]?"
    for m in re.finditer(en_dep_re, cleaned, re.I):
        dep_new, dep_old = m.group(1).strip(), m.group(2).strip()
        if dep_new.lower() in GENERIC_PRONOUNS or dep_old.lower() in GENERIC_PRONOUNS:
            continue
        results.append({
            "category": "decision",
            "scope_level": "project",
            "title": f"技术选型: 使用 {dep_new} 替代 {dep_old}",
            "content": f"架构技术选型决策：采用 `{dep_new}` 替代 `{dep_old}` 作为项目依赖。",
            "tags": "architecture,dependency,decision",
            "confidence": 0.85,
        })

    # 2. 目录规范与文件结构划分约定 (File structure conventions)
    dir_conv_re = r"([a-zA-Z0-9_\u4e00-\u9fa5]{2,15}(?:逻辑|代码|模块|组件|服务|路由|接口|模型|配置))\s*(?:统一|全部|应当)?(?:存放于|存放在|收口到|收拢在|放在|置于)\s*[`'\"]?([a-zA-Z0-9_./\-]+/[a-zA-Z0-9_./\-]*(?:/|\b))[`'\"]?"
    for m in re.finditer(dir_conv_re, cleaned, re.I):
        mod_type, dir_path = m.group(1).strip(), m.group(2).strip()
        if mod_type in GENERIC_PRONOUNS:
            continue
        if not dir_path.endswith("/"):
            dir_path = dir_path + "/"
        results.append({
            "category": "decision",
            "scope_level": "project",
            "title": f"目录规范: {mod_type} 存放在 {dir_path}",
            "content": f"架构目录约定：{mod_type}统一存放在 `{dir_path}` 目录中。",
            "tags": "architecture,structure,convention",
            "confidence": 0.85,
        })

    # 3. 架构规范与设计模式约定 (Architectural pattern conventions)
    pattern_re = r"(?:架构规范|设计约定|架构设计|架构风格)[：:\s]*(?:统一采用|统一遵循|遵循|采用)\s*([a-zA-Z0-9_\u4e00-\u9fa5\-]{2,30}(?:规范|风格|架构|模式))"
    for m in re.finditer(pattern_re, cleaned, re.I):
        standard = m.group(1).strip()
        results.append({
            "category": "decision",
            "scope_level": "project",
            "title": f"架构规范: 遵循 {standard}",
            "content": f"系统架构规范约定：统一采用并遵循 {standard}。",
            "tags": "architecture,pattern,convention",
            "confidence": 0.85,
        })

    # 降噪与去重过滤
    out = []
    seen = set()
    for c in results:
        if not _is_valid_memory_candidate(c):
            continue
        key = (c["category"], c["title"], c["content"])
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


# ------------------------------------------------------------- 入库逻辑


def save_memory(ncb, cfg, m, cache):
    project = str(m.get("project") or cfg["project"]).strip()
    category = m.get("category") if m.get("category") in CATEGORIES else "fact"
    title = str(m.get("title") or "").strip()
    content = str(m.get("content") or "").strip()
    if not title or not content:
        return {"action": "SKIP", "reason": "title/content 为空"}

    fp = str(m.get("content_fingerprint") or semantic_fingerprint(project, category, title, content)).strip()
    if fp in cache:
        return {"action": "NOOP", "cached": True}
    cache.add(fp)

    same = [r for r in ncb.all("memories", {"project": project}) if r.get("content_fingerprint") == fp]
    if same:
        rid = same[0]["id"]
        next_rec = int(same[0].get("recurrence") or 1) + 1
        try:
            ncb.update("memories", rid, {"recurrence": next_rec, "updated_at": now_str()})
        except Exception:
            pass
        return {"action": "NOOP", "id": rid, "recurrence": next_rec}

    superseded = [
        r for r in ncb.all("memories", {"project": project})
        if r.get("lifecycle_status") == "active"
        and str(r.get("title") or "").strip().lower() == title.lower()
        and str(r.get("category") or "") == category
    ]

    conf = m.get("confidence")
    try:
        conf = float(conf)
    except Exception:
        conf = 1.0
    if conf <= 1:
        conf = round(conf * 100)

    # (project, content_fingerprint) 上有唯一索引，它是去重的最终保证：
    # NCB 的读有约 2 秒写后可见延迟，靠「先读后写」会漏掉紧邻的重复写入。
    try:
        scope_val = m.get("scope_level")
        scope_val = scope_val if scope_val in ("user", "project", "session", "turn") else "project"
        res = ncb.create("memories", {
            "project": project,
            "category": category,
            "scope_level": scope_val,
            "client": str(m.get("client") or m.get("agent") or "unknown"),
            "origin": "harvest",
            "title": title,
            "content": content,
            "full_text": str(m.get("full_text") or content),
            "tags": str(m.get("tags") or "").lower(),
            "related_entities": str(m.get("related_entities") or ""),
            "content_fingerprint": fp,
            "confidence_score": int(conf),
            "lifecycle_status": "active",
            # 外键列必须写 None（NULL）而非 0：NCB 按 `*_id` 自动建外键
            # superseded_by_id -> memories.id，写 0 会违约导致整条写入失败。
            "superseded_by_id": None,
            "revision": max([int(r.get("revision") or 1) for r in superseded] or [0]) + 1,
            "recurrence": 1,
            "retrieval_count": 0,
            "invalid_at": None,
            "invalid_reason": "",
            "last_used_at": None,
            # 空值语义说明：
            # source_session 与 source_turn 为 NULL 是完全合法且符合设计的正常行为。
            # 离线合成、无会话头调用或无法推导时写 None（NULL），严禁伪造假数据。
            "source_session": str(m.get("source_session")).strip()[:128] if m.get("source_session") else None,
            "source_turn": int(m["source_turn"]) if m.get("source_turn") is not None else None,
            # 必须显式写：NCB 不生效 DEFAULT CURRENT_TIMESTAMP，省略即 NULL。
            "created_at": now_str(),
            "updated_at": now_str(),
        })
    except RuntimeError as e:
        if "duplicate" in str(e).lower():
            dup = [r for r in ncb.all("memories", {"project": project}) if r.get("content_fingerprint") == fp]
            if dup:
                next_rec = int(dup[0].get("recurrence") or 1) + 1
                try:
                    ncb.update("memories", dup[0]["id"], {"recurrence": next_rec, "updated_at": now_str()})
                except Exception:
                    pass
                return {"action": "NOOP", "id": dup[0]["id"], "recurrence": next_rec, "note": "唯一索引拦下重复"}
            return {"action": "NOOP", "note": "唯一索引拦下重复"}
        raise
    new_id = res.get("id") or res.get("insertId")

    if superseded and new_id:
        old = superseded[0]["id"]
        ncb.update("memories", old, {
            "lifecycle_status": "superseded",
            "superseded_by_id": new_id,
            "invalid_at": now_str(),
            "invalid_reason": "superseded",
            "updated_at": now_str(),
        })
        return {"action": "UPDATE", "id": new_id, "superseded_id": old}
    return {"action": "ADD", "id": new_id}


def save_pitfall(ncb, cfg, p, cache):
    project = str(p.get("project") or cfg["project"]).strip()
    component = str(p.get("component") or "unknown").strip()
    symptom = str(p.get("symptom") or "").strip()
    solution = str(p.get("solution") or "").strip()
    if not symptom or not solution:
        return {"action": "SKIP"}

    fp = str(p.get("content_fingerprint") or fingerprint(f"{project}:{component}:{symptom}")).strip()
    rec = int(p.get("recurrence") or 1)
    if fp in cache:
        return {"action": "NOOP", "cached": True}
    cache.add(fp)

    exist = [r for r in ncb.all("pitfalls", {"project": project}) if r.get("content_fingerprint") == fp]
    if exist:
        rid = exist[0]["id"]
        n = int(exist[0].get("recurrence") or 1) + rec
        ncb.update("pitfalls", rid,
                   {"recurrence": n, "last_occurred_at": now_str(),
                    "updated_at": now_str()})   # NCB 不生效 ON UPDATE，须显式写
        return {"action": "NOOP", "id": rid, "recurrence": n}

    try:
        res = ncb.create("pitfalls", {
            "project": project,
            "client": str(p.get("client") or p.get("agent") or "unknown"),
            "component": component,
            "symptom": symptom,
            "root_cause": str(p.get("root_cause") or "（由失败→成功相关性推断，待人工确认）"),
            "solution": solution,
            "severity": p.get("severity") if p.get("severity") in ("low", "medium", "high", "critical") else "medium",
            "error_type": str(p.get("error_type") or ""),
            "tags": str(p.get("tags") or "").lower(),
            "content_fingerprint": fp,
            "recurrence": rec,
            # 空值语义说明：同 save_memory，无会话信息时写 None（NULL），严禁伪造假数据。
            "source_session": str(p.get("source_session")).strip()[:128] if p.get("source_session") else None,
            "source_turn": int(p["source_turn"]) if p.get("source_turn") is not None else None,
            "last_occurred_at": now_str(),
            # 同上：NCB 不生效列默认值，必须显式写。
            "created_at": now_str(),
            "updated_at": now_str(),
        })
    except RuntimeError as e:
        if "duplicate" in str(e).lower():
            return {"action": "NOOP", "note": "唯一索引拦下重复"}
        raise
    return {"action": "ADD", "id": res.get("id") or res.get("insertId")}


# -------------------------------- 失败学习证据累计（参考 Headroom min_evidence）


class EvidenceCollector:
    """
    失败学习的证据累计器（对齐 Headroom traffic_learner 的 min_evidence 机制）。
    同一指纹的失败模式在本地状态中累计，达到门槛（默认 5）才真正写库。
    支持原子写、损坏自愈、容量上限与 TTL 过期淘汰。
    """

    def __init__(self, file_path="~/.magpie-memory-hub-evidence.json",
                 max_entries=5000, ttl_days=90, logfn=None):
        self.file_path = os.path.expanduser(file_path or "~/.magpie-memory-hub-evidence.json")
        self.max_entries = int(max_entries or 5000)
        self.ttl_days = float(ttl_days or 90)
        self.log = logfn or log
        self.pending = {}   # fp -> {"count": int, "first_seen": float, "last_seen": float, "item": dict}
        self.saved = set()  # set of str fps
        self.load_state()

    def load_state(self):
        path = os.path.expanduser(self.file_path)
        if not os.path.exists(path):
            self.pending = {}
            self.saved = set()
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read().strip()
            if not content:
                self.pending = {}
                self.saved = set()
                return
            data = json.loads(content)
            if not isinstance(data, dict):
                self.log(f"证据状态文件格式异常 ({path})，重置为空状态")
                self.pending = {}
                self.saved = set()
                return
            raw_pending = data.get("pending", {})
            self.pending = raw_pending if isinstance(raw_pending, dict) else {}
            raw_saved = data.get("saved", [])
            self.saved = set(str(x) for x in raw_saved) if isinstance(raw_saved, list) else set()
            # 载入时清理过期条目
            self._cleanup(time.time())
        except Exception as e:
            self.log(f"证据状态文件损坏或无法读取 ({path}): {e}，重置为空状态")
            self.pending = {}
            self.saved = set()

    def save_state(self):
        path = os.path.expanduser(self.file_path)
        dir_name = os.path.dirname(os.path.abspath(path))
        tmp_path = path + f".tmp.{os.getpid()}"
        try:
            os.makedirs(dir_name, exist_ok=True)
            data = {
                "version": 1,  # db-col-ok: 本地状态文件结构版本号，非数据库列
                "updated_at": time.time(),
                "pending": self.pending,
                "saved": list(self.saved)[-2000:],
            }
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, path)
        except Exception as e:
            self.log(f"证据状态文件写入失败 ({path}): {e}")
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

    @staticmethod
    def _entry_ts(entry, key):
        """安全取时间戳：区分「字段缺失」与「值为 0」。
        踩过的坑：原先写 `entry.get("last_seen") or now`，而 0 是 falsy，
        于是时间戳为 0 的条目被替换成 now，TTL 永远不生效；
        更糟的是字段整体缺失时（旧版状态文件/格式变更）同样会永生。
        这里改成：字段缺失或非法 → 返回 None，交给调用方决定。"""
        v = entry.get(key)
        if v is None:
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return f if f > 0 else None

    def _cleanup(self, now):
        ttl_sec = self.ttl_days * 86400.0
        expired = []
        for fp, entry in self.pending.items():
            if not isinstance(entry, dict):
                expired.append(fp)          # 结构损坏的条目直接清掉
                continue
            # 优先 last_seen，回落 first_seen；两者都不可用则保留
            # （宁可留着由 max_entries 兜底，也不要误删已累计的证据）
            ts = self._entry_ts(entry, "last_seen")
            if ts is None:
                ts = self._entry_ts(entry, "first_seen")
            if ts is not None and (now - ts) > ttl_sec:
                expired.append(fp)
        for fp in expired:
            del self.pending[fp]

        if len(self.pending) > self.max_entries:
            # 超过上限时按 last_seen 降序截断，保留最新
            sorted_items = sorted(
                self.pending.items(),
                key=lambda kv: float(kv[1].get("last_seen") or 0.0),
                reverse=True
            )
            self.pending = dict(sorted_items[:self.max_entries])

    def record(self, fp, item, min_evidence=5):
        if min_evidence <= 1:
            return {"ready": True, "count": 1, "already_saved": False}

        if fp in self.saved:
            return {"ready": True, "count": None, "already_saved": True}

        now = time.time()
        self._cleanup(now)

        entry = self.pending.get(fp)
        if entry:
            entry["count"] = int(entry.get("count") or 1) + 1
            entry["last_seen"] = now
            entry["item"] = item
            count = entry["count"]
        else:
            if len(self.pending) >= self.max_entries:
                oldest_key = min(
                    self.pending.keys(),
                    key=lambda k: float(self.pending[k].get("last_seen") or 0.0)
                )
                del self.pending[oldest_key]
            count = 1
            self.pending[fp] = {
                "count": count,
                "first_seen": now,
                "last_seen": now,
                "item": item,
            }

        if count >= min_evidence:
            del self.pending[fp]
            self.saved.add(fp)
            if len(self.saved) > 2000:
                self.saved.pop()
            self.save_state()
            return {"ready": True, "count": count, "already_saved": False}
        else:
            self.save_state()
            return {"ready": False, "count": count, "min_evidence": min_evidence}


_evidence_collectors = {}


def get_evidence_collector(cfg, logfn=None):
    global _evidence_collectors
    path = os.path.expanduser(cfg.get("evidence_file") or "~/.magpie-memory-hub-evidence.json")
    if path not in _evidence_collectors:
        max_entries = int(cfg.get("evidence_max_entries") or 5000)
        ttl_days = float(cfg.get("evidence_ttl_days") or 90)
        _evidence_collectors[path] = EvidenceCollector(
            file_path=path,
            max_entries=max_entries,
            ttl_days=ttl_days,
            logfn=logfn or log,
        )
    return _evidence_collectors[path]


def reset_evidence_collector(path=None):
    global _evidence_collectors
    if path:
        exp = os.path.expanduser(path)
        _evidence_collectors.pop(exp, None)
    else:
        _evidence_collectors.clear()


def record_pitfall(ncb, cfg, p, cache, accumulator=None, dry_run=False, is_explicit=False):
    """
    带有证据门槛的失败模式记录：
    同一指纹在本地状态文件里累计，达到 min_evidence（默认 3）才真正入库。
    min_evidence <= 1 或用户显式指令时立即入库。
    """
    project = str(p.get("project") or cfg.get("project", "global")).strip()
    component = str(p.get("component") or "unknown").strip()
    symptom = str(p.get("symptom") or "").strip()
    solution = str(p.get("solution") or "").strip()
    if not symptom or not solution:
        return {"action": "SKIP"}

    fp = str(p.get("content_fingerprint") or fingerprint(f"{project}:{component}:{symptom}")).strip()
    min_ev = int(cfg.get("min_evidence") if cfg.get("min_evidence") is not None else 3)
    if is_explicit:
        min_ev = 1

    if accumulator is None:
        accumulator = get_evidence_collector(cfg, log)

    res = accumulator.record(fp, p, min_evidence=min_ev)
    if not res["ready"]:
        return {
            "action": "PENDING",
            "content_fingerprint": fp,
            "count": res["count"],
            "min_evidence": res["min_evidence"],
            "symptom": symptom,
            "solution": solution,
        }

    if res.get("count"):
        p["recurrence"] = res["count"]

    if dry_run:
        return {"action": "DRYRUN", "count": res.get("count"), "content_fingerprint": fp, **p}

    return save_pitfall(ncb, cfg, p, cache)


# -------------------------------- 记忆作用域提升（轻量版 scope promotion）


def _get_conf_score(m):
    val = m.get("confidence_score")
    if val is not None:
        try:
            f = float(val)
            return f if f > 1.0 else f * 100.0
        except Exception:
            pass
    val2 = m.get("confidence")
    if val2 is not None:
        try:
            f = float(val2)
            return f * 100.0 if f <= 1.0 else f
        except Exception:
            pass
    return 100.0


def promote_scopes(ncb, cfg, dry_run=False):
    """
    轻量版「记忆提升」（scope promotion）：
    对 scope_level 为 session 或 turn、且 retrieval_count >= N（默认 3）、
    confidence_score >= 阈值、lifecycle_status=active 的记忆，就地改 scope_level 为 project。
    """
    if not cfg.get("enable_promotion", True):
        return []
    if ncb is None:
        return []

    min_hits = int(cfg.get("promotion_min_hits") if cfg.get("promotion_min_hits") is not None else 3)
    if min_hits <= 0:
        return []

    limit = int(cfg.get("promotion_batch_limit") if cfg.get("promotion_batch_limit") is not None else 50)
    if limit <= 0:
        return []

    raw_thresh = cfg.get("promotion_min_confidence")
    if raw_thresh is None:
        raw_thresh = cfg.get("min_confidence", 0.6)
    try:
        f_thresh = float(raw_thresh)
        thresh_score = f_thresh * 100.0 if f_thresh <= 1.0 else f_thresh
    except Exception:
        thresh_score = 60.0

    project = cfg.get("project", "global")
    try:
        mems = ncb.all("memories", {"project": project})
    except Exception as e:
        log(f"记忆提升查询失败: {e}")
        return []

    promoted = []
    for m in mems:
        if len(promoted) >= limit:
            break

        # 检查 lifecycle_status
        if str(m.get("lifecycle_status") or "active").lower() != "active":
            continue
        # 双时态：已失效（invalid_at 已过）的记忆不得提升。
        if m.get("invalid_at"):
            continue

        # 检查 scope_level 是否为 session 或 turn
        scope_lvl = str(m.get("scope_level") or "").lower()
        if scope_lvl not in ("session", "turn"):
            continue

        # 检查 retrieval_count >= min_hits
        rc_cnt = int(m.get("retrieval_count") or 0)
        if rc_cnt < min_hits:
            continue

        # 检查 confidence_score >= 阈值
        conf = _get_conf_score(m)
        if conf < thresh_score:
            continue

        rid = m.get("id")
        if not rid:
            continue

        # 符合条件，就地提升为 project
        if dry_run:
            m["scope_level"] = "project"
            promoted.append({"id": rid, "title": m.get("title"), "dry_run": True})
        else:
            try:
                ncb.update("memories", rid, {
                    "scope_level": "project",
                    "updated_at": now_str(),
                })
                m["scope_level"] = "project"
                promoted.append({"id": rid, "title": m.get("title")})
            except Exception as e:
                log(f"更新记忆 scope_level 失败 id={rid}: {e}")

    return promoted


# ------------------------------------------------- 规则仲裁（不用 LLM）
#
# Headroom 的路线是「不额外调模型，让正在跑的那个模型顺手提炼」；
# 那么仲裁（判断一条记忆值不值得入库）也不该再花一次调用。
# 规则够用的理由：真正要拦的是「重复」和「没信息量」，这两件事都能算出来。

def _norm(s):
    return re.sub(r"[\s]+", "", str(s or "").lower())


def _tokens(s):
    """英文词 + 中文双字组，用于算相似度。"""
    t = str(s or "").lower()
    words = re.findall(r"[a-z0-9_\-]{2,}", t)
    cjk = re.findall(r"[\u4e00-\u9fff]+", t)
    grams = []
    for run in cjk:
        grams += [run[i:i + 2] for i in range(max(0, len(run) - 1))]
    return set(words) | set(grams)


def _jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / max(1, len(a | b))


# 明显没有长期价值的模式：一次性寒暄、纯状态播报


def rule_judge(cfg, ncb, cands, project, stats):
    """
    纯规则仲裁，零模型调用。返回保留下来的候选列表。
    拦截三类：(1) 置信度不足 (2) 没有信息量 (3) 与既有记忆实质重复
    """
    kept = []
    min_conf = float(cfg.get("min_confidence") or 0.6)

    # 取既有记忆一次，用于相似度比对（避免逐条查询）
    known = []
    try:
        for m in ncb.all("memories", {"project": project}):
            if str(m.get("lifecycle_status") or "active") == "active" and not m.get("invalid_at"):
                known.append((_tokens(m.get("title")), _tokens(m.get("content"))))
    except Exception as e:
        stats["errors"].append(f"规则仲裁取既有记忆失败: {e}")

    for c in cands:
        title = str(c.get("title") or "").strip()
        content = str(c.get("content") or "").strip()

        try:
            conf = float(c.get("confidence", 1.0))
        except Exception:
            conf = 1.0
        if conf < min_conf:
            stats.setdefault("dropped", []).append(
                {"title": title, "reason": f"置信度 {conf:.2f} < {min_conf}"})
            continue

        if len(title) < 4 or len(content) < 12:
            stats.setdefault("dropped", []).append(
                {"title": title, "reason": "标题或内容过短，信息量不足"})
            continue

        if any(re.search(p, content, re.I) for p in NOISE_PATTERNS):
            stats.setdefault("dropped", []).append({"title": title, "reason": "寒暄/状态播报类"})
            continue

        # 与既有记忆实质重复：标题高度相似，或内容高度相似
        tt, ct = _tokens(title), _tokens(content)
        dup = False
        for kt, kc in known:
            if _jaccard(tt, kt) >= 0.8 or _jaccard(ct, kc) >= 0.85:
                dup = True
                break
        if dup:
            stats.setdefault("dropped", []).append(
                {"title": title, "reason": "与既有记忆实质重复"})
            continue

        kept.append(c)

    return kept


# ------------------------------------------------- 快照推送（闭环最后一环）
#
# 中间件（moejs）没有任何网络能力，它只读得到 plugins.json 里本插件的
# options.memories。所以本管线必须把记忆【推】回去，官方安全入口是：
#
#     magpie plugin options <name> '<json>'
#
# 它走 plugin.SetOptions()：listMu 加锁 + lastgood 备份 + 原子写，
# 不与会写同一文件的 GUI 抢写。网关中间件在 plugins.json 变更后 ≤1s 重新加载。
#
# 注意：SetOptions 会整体替换 options，所以必须先读回现值再合并。

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _strip_ansi(s):
    return ANSI.sub("", s or "")


def read_magpie_options(cfg, logfn):
    """读回插件当前 options（失败返回 None，表示读不到而不是空）"""
    try:
        r = subprocess.run([cfg["magpie_bin"], "plugin", "options", cfg["plugin_name"]],
                           capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        return None
    except Exception as e:
        logfn(f"读取插件 options 失败: {e}")
        return None
    out = _strip_ansi(r.stdout) + _strip_ansi(r.stderr)
    i = out.find("{")
    if i < 0:
        # 还没设过任何 options（可能只打印了默认建议），当作空开始
        return {}
    try:
        return json.loads(out[i:])
    except Exception:
        # 截到最后一个 } 再试一次
        j = out.rfind("}")
        if j > i:
            try:
                return json.loads(out[i:j + 1])
            except Exception:
                pass
        logfn("解析插件 options 失败，跳过本次推送")
        return None


def write_magpie_options(cfg, opts, logfn):
    try:
        r = subprocess.run([cfg["magpie_bin"], "plugin", "options", cfg["plugin_name"],
                            json.dumps(opts, ensure_ascii=False)],
                           capture_output=True, text=True, timeout=60)
    except Exception as e:
        logfn(f"推送快照失败: {e}")
        return False
    if r.returncode != 0:
        logfn(f"推送快照失败: {_strip_ansi(r.stderr or r.stdout).strip()[:200]}")
        return False
    return True


def rank_importance(m, now_ts):
    """
    与中间件同口径的重要度：置信度 × (1 + 0.1·命中) × (0.5 + 0.5·保留率)
    只用于【决定谁进快照】，与中间件内部的排序是两件事。
    """
    conf = (float(m.get("confidence_score") or 100)) / 100.0
    rc = int(m.get("retrieval_count") or 0)
    stab = 1.0 * (1 + 1.5 * math.log(1 + rc))
    t = m.get("last_used_at") or m.get("updated_at") or m.get("created_at") or ""
    try:
        dt = datetime.strptime(str(t)[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        days = max(0.0, (now_ts - dt.timestamp()) / 86400.0)
    except Exception:
        days = 0.0
    retention = math.exp(-days / stab) if stab > 0 else 1.0
    return conf * (1 + 0.1 * min(rc, 10)) * (0.5 + 0.5 * retention)


def build_snapshot(mems, cap, dormant_days, now_ts):
    """挑出该推给网关的记忆：活跃、未失效、未被取代，按重要度截断"""
    out = []
    for m in mems:
        st = str(m.get("lifecycle_status") or "active")
        if st != "active":
            continue
        if m.get("invalid_at"):
            continue
        # 休眠：久未取用且从未被命中过的，不进快照（保留在库里，可被检索到）
        rc = int(m.get("retrieval_count") or 0)
        if rc <= 1 and dormant_days > 0:
            t = m.get("last_used_at") or m.get("created_at") or ""
            try:
                dt = datetime.strptime(str(t)[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                if (now_ts - dt.timestamp()) / 86400.0 > dormant_days:
                    continue
            except Exception:
                pass
        out.append(m)
    out.sort(key=lambda m: rank_importance(m, now_ts), reverse=True)
    return out[:cap]


# 只推中间件真正用得上的字段：字段越少，plugins.json 越小、解析越快
SNAP_FIELDS = ("id", "project", "category", "scope_level", "client", "origin", "title", "content",
               "tags", "related_entities", "confidence_score", "retrieval_count",
               "lifecycle_status", "invalid_at", "created_at", "updated_at", "last_used_at")


def slim(m):
    return {k: m.get(k) for k in SNAP_FIELDS if m.get(k) is not None}


class SnapshotPusher:
    """按间隔 + 内容变化去重地推送快照（推送会重启插件宿主，不宜过于频繁）"""

    def __init__(self, cfg, logfn):
        self.cfg = cfg
        self.log = logfn
        self.last_at = 0.0
        self.last_sig = ""

    def maybe_push(self, ncb, force=False):
        if not self.cfg.get("push_snapshot"):
            return False
        now_ts = time.time()
        if not force and now_ts - self.last_at < float(self.cfg.get("snapshot_interval") or 60):
            return False

        mems = ncb.all("memories", {"limit": 200})
        snap = build_snapshot(mems, int(self.cfg.get("snapshot_cap") or 500),
                              float(self.cfg.get("dormant_days") or 0), now_ts)
        sig = hashlib.sha256("".join(str(m.get("id", "")) + str(m.get("updated_at", ""))
                                     for m in snap).encode()).hexdigest()[:16]
        if sig == self.last_sig and not force:
            self.last_at = now_ts
            return False

        opts = read_magpie_options(self.cfg, self.log)
        if opts is None:
            return False

        opts["memories"] = [slim(m) for m in snap]
        # 版本号：中间件用它做 O(1) 的缓存键，避免每请求重建倒排索引
        opts["memories_version"] = f"{sig}-{len(snap)}"

        if write_magpie_options(self.cfg, opts, self.log):
            self.last_at = now_ts
            self.last_sig = sig
            self.log(f"已推送快照：{len(snap)} 条记忆（version={opts['memories_version']}）")
            return True
        return False


# ------------------------------------------------------------- 单轮处理


def process_turn(cfg, ncb, turn, caches, dry_run):
    stats = {"memories": [], "pitfalls": [], "errors": [], "compressed": None}
    convo = f"用户提问：\n{turn.get('prompt', '')}\n\n助手回复：\n{turn.get('response', '')}"
    is_explicit = is_explicit_user_memory(convo)
    raw_sess = str(turn.get("session") or turn.get("session_id") or "").strip()
    session_val = raw_sess[:128] if raw_sess else None
    turn_val = int(turn["turn"]) if turn.get("turn") is not None else (int(turn["turn_index"]) if turn.get("turn_index") is not None else None)

    # ---- ① 失败学习（零 LLM 成本，纯启发式）----
    try:
        accumulator = caches.get("evidence") if caches else None
        pit_cache = caches["pitfall"] if caches and "pitfall" in caches else set()
        for p in mine_failures(convo):
            item = dict(p, project=cfg["project"], source_session=session_val, source_turn=turn_val)
            if not item.get("component"):
                item["component"] = "auto"
            res = record_pitfall(ncb, cfg, item, pit_cache,
                                 accumulator=accumulator, dry_run=dry_run, is_explicit=is_explicit)
            stats["pitfalls"].append(res)
    except Exception as e:
        stats["errors"].append(f"失败学习: {e}")

    # ---- ①-B 环境事实与架构决策提取（零 LLM 成本，纯规则 + rule_judge 仲裁）----
    try:
        heuristic_mems = mine_environment_facts(convo) + mine_architectural_decisions(convo)
        if heuristic_mems:
            cands = rule_judge(cfg, ncb, heuristic_mems, cfg["project"], stats)
            for cand in cands:
                item = dict(cand, project=cfg["project"], source="harvest:heuristic", source_session=session_val, source_turn=turn_val)
                if dry_run:
                    stats["memories"].append({"action": "DRYRUN", **item})
                else:
                    stats["memories"].append(save_memory(ncb, cfg, item, caches["memory"]))
    except Exception as e:
        stats["errors"].append(f"启发式记忆提取: {e}")

    # ---- ② 外部模型提炼与仲裁已移除：默认免模型，依赖启发式规则与内联提炼 ----
    return stats




def main():
    ap = argparse.ArgumentParser(description="Magpie 记忆抓取与提炼管线")
    ap.add_argument("--log", help="跟随该日志文件（tail -f 语义）")
    ap.add_argument("--file", help="一次性读取该文件")
    ap.add_argument("--config", help="配置文件路径（默认 ~/.magpie-memory-hub.json）")
    ap.add_argument("--dry-run", action="store_true", help="只展示提炼结果，不写库")
    ap.add_argument("--ncb-instance")
    ap.add_argument("--project")
    ap.add_argument("--magpie-bin", dest="magpie_bin", help="magpie 可执行文件路径")
    ap.add_argument("--no-push", action="store_true", help="不把快照推回网关")
    ap.add_argument("--push-once", action="store_true", help="只推一次快照就退出")
    ap.add_argument("--snapshot-cap", dest="snapshot_cap", type=int, help="快照最多多少条")
    ap.add_argument("--min-evidence", dest="min_evidence", type=int,
                    help="失败学习证据门槛（默认 5；<=1 立即入库）")
    ap.add_argument("--evidence-file", dest="evidence_file",
                    help="本地证据状态文件路径（默认 ~/.magpie-memory-hub-evidence.json）")
    ap.add_argument("--no-promotion", dest="no_promotion", action="store_true",
                    help="关闭记忆作用域提升")
    ap.add_argument("--promotion-min-hits", dest="promotion_min_hits", type=int,
                    help="提升所需的最小访问/命中数（默认 3）")
    ap.add_argument("--promotion-batch-limit", dest="promotion_batch_limit", type=int,
                    help="单轮提升条数上限（默认 50）")
    args = ap.parse_args()

    cfg = load_config(args)

    if not cfg.get("ncb_instance"):
        log("缺少 ncb_instance，退出")
        return 2
    if args.no_push:
        cfg["push_snapshot"] = False
    if getattr(args, "snapshot_cap", None):
        cfg["snapshot_cap"] = args.snapshot_cap
    if not cfg.get("ncb_secret"):
        log("警告：未配置 ncb_secret。表已设为私有，缺少 Secret Key 将无法读写。")

    ncb = None if args.dry_run else NCB(cfg["ncb_instance"], cfg["ncb_secret"])
    caches = {
        "memory": set(),
        "pitfall": set(),
        "evidence": get_evidence_collector(cfg, log),
    }

    if cfg.get("_from_plugin_options"):
        log("配置来源：已合并插件 options（设置页）")
    log(f"实例={cfg['ncb_instance']} 推送快照={cfg.get('push_snapshot')} "
        f"dry_run={args.dry_run}")

    # 只推一次快照就退出（配 cron / 计划任务用）
    if args.push_once:
        if args.dry_run:
            log("dry-run：不推送")
            return 0
        promote_scopes(ncb, cfg, dry_run=False)
        ok = SnapshotPusher(cfg, log).maybe_push(ncb, force=True)
        return 0 if ok else 1

    if args.file:
        with open(args.file, encoding="utf-8") as f:
            stream, follow = f, False
            run(stream, follow, cfg, ncb, caches, args.dry_run,
                SnapshotPusher(cfg, log))
    elif args.log:
        path = os.path.expanduser(args.log)
        log(f"跟随日志 {path}")
        # 文件不存在则等待创建
        for _ in range(600):
            if os.path.exists(path):
                break
            time.sleep(1)
        with open(path, encoding="utf-8", errors="ignore") as f:
            f.seek(0, os.SEEK_END)  # 只看新内容
            run(f, True, cfg, ncb, caches, args.dry_run,
                SnapshotPusher(cfg, log))
    else:
        run(sys.stdin, False, cfg, ncb, caches, args.dry_run,
            SnapshotPusher(cfg, log))
    return 0


def run(stream, follow, cfg, ncb, caches, dry_run, pusher=None):
    """
    旧的 stdout / 日志流采集链路已移除。
    在官方 Docker 部署下该链路从未生效，自动记忆已改用原生网关异步钩子 (gateway_harvest.hooks.js)。
    """
    log("提示：基于 stdout/日志流的 [MEMORY_HARVEST] 抓取链路已废弃移除，自动记忆已改用网关原生异步钩子。")


if __name__ == "__main__":
    sys.exit(main())
