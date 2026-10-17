import os
import sys
import time
import json
import subprocess

TESTS_DIR = "/var/minis/workspace/magpie-memory-hub/tests"

def get_counts():
    cmd = [
        "minis-mcp-cli", "call", "NoCodeBackend MCP", "execute_sql",
        json.dumps({
            "database": "41694_agent_memory",
            "sql": "SELECT (SELECT COUNT(*) FROM memories) AS m, (SELECT COUNT(*) FROM pitfalls) AS p"
        })
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"execute_sql failed: {res.stderr}")
    data = json.loads(res.stdout)
    text = data["result"]["content"][0]["text"]
    sql_res = json.loads(text)
    row = sql_res["results"][0]["rows"][0]
    return int(row["m"]), int(row["p"])

def main():
    exclude = {
        "test_meta.mjs",
        "test_helpers.mjs",
        "test_pollution_guard.mjs",
        "query_counts.py",
        "runner_step1.py",
        "diagnose_pollution.py"
    }
    files = sorted([
        f for f in os.listdir(TESTS_DIR)
        if f.endswith(".mjs") and f not in exclude
    ])

    print(f"=== Starting pollution diagnosis for {len(files)} test files ===", flush=True)
    print("Baseline stabilization: sleep 6s...", flush=True)
    time.sleep(6)
    curr_m, curr_p = get_counts()
    print(f"BASELINE: memories={curr_m}, pitfalls={curr_p}\n", flush=True)

    results = []

    for idx, fname in enumerate(files, 1):
        fpath = os.path.join(TESTS_DIR, fname)
        print(f"[{idx}/{len(files)}] Running {fname}...", end="", flush=True)

        t0 = time.time()
        # Run with standard environment WITHOUT injecting NODE_ENV or MAGPIE_TEST
        proc = subprocess.run(
            ["node", fpath],
            cwd="/var/minis/workspace/magpie-memory-hub",
            capture_output=True,
            text=True,
            timeout=60,
        )
        elapsed = time.time() - t0

        # Wait 6s for NCB write visibility delay
        time.sleep(6)
        new_m, new_p = get_counts()

        dm = new_m - curr_m
        dp = new_p - curr_p

        status_str = f" exit={proc.returncode} ({elapsed:.1f}s) | m: {curr_m}->{new_m} ({dm:+d}) | p: {curr_p}->{new_p} ({dp:+d})"
        if dm != 0 or dp != 0:
            status_str += " ❌ POLLUTION DETECTED!"
        else:
            status_str += " ✓"
        print(status_str, flush=True)

        results.append({
            "file": fname,
            "exit": proc.returncode,
            "m_before": curr_m,
            "m_after": new_m,
            "dm": dm,
            "p_before": curr_p,
            "p_after": new_p,
            "dp": dp,
            "elapsed": round(elapsed, 2),
            "stdout_tail": proc.stdout[-300:] if proc.stdout else "",
            "stderr_tail": proc.stderr[-300:] if proc.stderr else "",
        })

        curr_m = new_m
        curr_p = new_p

    print("\n" + "=" * 95)
    print("COMPLETE TABLE: TEST -> ROW COUNT CHANGES (tests/ without test_meta.mjs)")
    print("=" * 95)
    print(f"| {'#':<3} | {'Test File':<35} | {'Exit':<5} | {'Memories':<15} | {'Pitfalls':<15} | {'Pollution?':<10} |")
    print(f"|{'-'*5}|{'-'*37}|{'-'*7}|{'-'*17}|{'-'*17}|{'-'*12}|")
    total_dm = 0
    total_dp = 0
    polluted_files = []
    for idx, r in enumerate(results, 1):
        m_str = f"{r['m_before']} -> {r['m_after']} ({r['dm']:+d})"
        p_str = f"{r['p_before']} -> {r['p_after']} ({r['dp']:+d})"
        is_pol = (r['dm'] != 0 or r['dp'] != 0)
        if is_pol:
            polluted_files.append((r['file'], r['dm'], r['dp']))
        total_dm += r['dm']
        total_dp += r['dp']
        polluted = "❌ YES" if is_pol else "✓ NO"
        print(f"| {idx:<3} | {r['file']:<35} | {r['exit']:<5} | {m_str:<15} | {p_str:<15} | {polluted:<10} |")
    print("=" * 95)
    print(f"SUMMARY: Total Tests={len(results)}, Polluted Tests={len(polluted_files)}, Net dm={total_dm:+d}, Net dp={total_dp:+d}")
    if polluted_files:
        print("\nPOLLUTED TESTS LIST:")
        for pf, pdm, pdp in polluted_files:
            print(f"  ❌ {pf}: dm={pdm:+d}, dp={pdp:+d}")
    else:
        print("\nNo pollution detected in single-pass run!")
    print("=" * 95)

if __name__ == "__main__":
    main()
