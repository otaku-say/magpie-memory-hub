import subprocess
import json
import sys
import time

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

if __name__ == "__main__":
    m, p = get_counts()
    print(f"memories: {m}, pitfalls: {p}")
