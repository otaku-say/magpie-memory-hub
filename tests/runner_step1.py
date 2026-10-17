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
    files = sorted([
        f for f in os.listdir(TESTS_DIR)
        if f.endswith(".mjs") and f not in ("test_helpers.mjs", "query_counts.py")
    ])

    print(f"Discovered {len(files)} test files to execute.")
    time.sleep(3)
    curr_m, curr_p = get_counts()
    print(f"INITIAL DB COUNTS -> memories: {curr_m}, pitfalls: {curr_p}\n")

    results = []

    for idx, fname in enumerate(files, 1):
        fpath = os.path.join(TESTS_DIR, fname)
        print(f"[{idx}/{len(files)}] Running {fname}...", flush=True)

        t0 = time.time()
        env = os.environ.copy()
        env["NODE_ENV"] = "test"
        env["MAGPIE_TEST"] = "1"
        proc = subprocess.run(
            ["node", fpath],
            cwd="/var/minis/workspace/magpie-memory-hub",
            capture_output=True,
            text=True,
            timeout=180,
            env=env
        )
        elapsed = time.time() - t0

        # Wait 3 seconds for read-after-write visibility
        time.sleep(3)
        new_m, new_p = get_counts()
        dm = new_m - curr_m
        dp = new_p - curr_p

        status = f"exit={proc.returncode} ({elapsed:.1f}s)"
        changed = ""
        if dm != 0 or dp != 0:
            changed = f" *** POLLUTION DETECTED! dm={dm:+d}, dp={dp:+d} ***"

        print(f"    -> memories: {curr_m} -> {new_m} ({dm:+d}), pitfalls: {curr_p} -> {new_p} ({dp:+d}) [{status}]{changed}", flush=True)
        if proc.returncode != 0:
            print(f"    [STDERR snippet]: {proc.stderr[:300].strip()}", flush=True)

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
        })

        curr_m = new_m
        curr_p = new_p

    print("\n" + "=" * 80)
    print("FINAL SUMMARY TABLE (ALL TESTS ISOLATION VERIFICATION)")
    print("=" * 80)
    print(f"{'Test File':<35} | {'Exit':<5} | {'Memories':<14} | {'Pitfalls':<14} | {'Pollution?'}")
    print("-" * 80)
    total_dm = 0
    total_dp = 0
    polluted_count = 0
    for r in results:
        m_str = f"{r['m_before']} -> {r['m_after']} ({r['dm']:+d})"
        p_str = f"{r['p_before']} -> {r['p_after']} ({r['dp']:+d})"
        is_pol = (r['dm'] != 0 or r['dp'] != 0)
        if is_pol:
            polluted_count += 1
        total_dm += r['dm']
        total_dp += r['dp']
        polluted = "YES ❌" if is_pol else "NO ✓"
        print(f"{r['file']:<35} | {r['exit']:<5} | {m_str:<14} | {p_str:<14} | {polluted}")
    print("=" * 80)
    print(f"Total Tests: {len(results)}, Polluted: {polluted_count}, Net Delta: dm={total_dm:+d}, dp={total_dp:+d}")
    print("=" * 80)

if __name__ == "__main__":
    main()
