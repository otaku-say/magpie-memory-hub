#!/usr/bin/env python3
"""
交付验收脚本：不依赖 Agent 自述，机器判定重构是否可信。
用法：在仓库根目录运行 python3 verify_delivery.py
"""
import os, re, subprocess

GATES = ["tools.js", "memory.middleware.js", "gateway_harvest.hooks.js"]

def js_files(root="src"):
    out = []
    if not os.path.isdir(root):
        return out
    for d, _, fs in os.walk(root):
        for f in fs:
            if f.endswith(".js"):
                out.append(os.path.join(d, f))
    return sorted(out)

print("=" * 60)
print("重构交付机器验收")
print("=" * 60)

# ---------- 1. 语法 ----------
errs = []
for f in js_files() + [g for g in GATES if os.path.exists(g)]:
    r = subprocess.run(["node", "--check", f], capture_output=True, text=True)
    if r.returncode != 0:
        line = (r.stderr or "").strip().split("\n")
        errs.append((f, line[0][:90] if line else "unknown"))
print(f"\n[1] 语法错误: {len(errs)}")
for f, e in errs[:6]:
    print(f"    ✗ {f}: {e}")

# ---------- 2. import 与本地声明冲突 ----------
conf = []
for f in js_files():
    s = open(f, encoding="utf-8").read()
    imps = set()
    for m in re.finditer(r'import\s*\{([^}]+)\}\s*from', s, re.S):
        for n in m.group(1).split(","):
            n = n.strip().split(" as ")[-1].strip()
            if n:
                imps.add(n)
    loc = set()
    for m in re.finditer(r'^(?:export\s+)?(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)', s, re.M):
        loc.add(m.group(1))
    c = sorted(imps & loc)
    if c:
        conf.append((f, c))
print(f"\n[2] import/本地声明冲突: {len(conf)}")
for f, c in conf[:6]:
    print(f"    ✗ {f}: {c}")

# ---------- 3. 门面行数 ----------
print("\n[3] 根门面行数")
face_ok = True
for g in GATES:
    if not os.path.exists(g):
        print(f"    ✗ {g}: 缺失")
        face_ok = False
        continue
    n = sum(1 for _ in open(g, encoding="utf-8"))
    ok = n < 40
    print(f"    {'✓' if ok else '✗'} {g}: {n} 行")
    if not ok:
        face_ok = False

# ---------- 4. 门面是否只做 re-export ----------
print("\n[4] 门面纯净度（不应含实现）")
for g in GATES:
    if not os.path.exists(g):
        continue
    s = open(g, encoding="utf-8").read()
    # 去掉注释与 import/export 行后，看还剩多少实质代码
    body = re.sub(r"/\*[\s\S]*?\*/", "", s)
    body = re.sub(r"//[^\n]*", "", body)
    body = re.sub(r"^\s*(import|export)\b[^\n]*$", "", body, flags=re.M)
    residual = [ln.strip() for ln in body.split("\n") if ln.strip()]
    ok = len(residual) == 0
    print(f"    {'✓' if ok else '✗'} {g}: 非导入导出残留 {len(residual)} 行")
    if residual[:3]:
        for r in residual[:3]:
            print(f"        {r[:70]}")

# ---------- 5. 函数名集合比对（对照 8f495b0 的 tools.js）----------
print("\n[5] 函数名集合比对（vs 8f495b0:tools.js）")
try:
    base = subprocess.run(["git", "show", "8f495b0:tools.js"],
                          capture_output=True, text=True).stdout
    base_names = set(re.findall(
        r'^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)', base, re.M))
    now = ""
    for f in js_files() + [g for g in GATES if os.path.exists(g)]:
        now += open(f, encoding="utf-8").read()
    now_names = set(re.findall(
        r'^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)', now, re.M))
    missing = sorted(base_names - now_names)
    print(f"    原 tools.js 函数: {len(base_names)} | 现状: {len(now_names)}")
    print(f"    {'✓ 无缺失' if not missing else '✗ 缺失: ' + str(missing[:8])}")
except Exception as e:
    print(f"    跳过（{e}）")

# ---------- 6. 目录分层 ----------
print("\n[6] src 一级目录")
allowed = {"core", "domain", "integration", "services", "tools", "middleware", "page"}
if os.path.isdir("src"):
    actual = {d for d in os.listdir("src") if os.path.isdir(os.path.join("src", d))}
    extra = actual - allowed
    print(f"    {'✓' if not extra else '✗ 非法目录: ' + str(extra)} {sorted(actual)}")

print("\n" + "=" * 60)
verdict = (not errs) and (not conf) and face_ok
print("机器验收结论:", "✅ 通过（仍需跑全量）" if verdict else "❌ 不通过")
print("=" * 60)
