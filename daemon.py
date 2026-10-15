#!/usr/bin/env python3
"""
daemon.py — Magpie Memory MCP Server v2.0
==========================================
标准 MCP JSON-RPC over Stdio 服务端。
数据通道: 通过 minis-mcp-cli 子进程调用 NoCodeBackend MCP 的 execute_sql，
         彻底绕过 REST API 认证问题。

工具清单:
  - search_memories   搜索记忆（关键词/项目/分类）
  - record_memory     写入记忆（自动 ADD/UPDATE/NOOP 去重）
  - query_pitfalls    查询工程踩坑记录
  - record_pitfall    写入踩坑记录（自动去重 + recurrence 计数）
  - list_all          列出全部活跃记忆
"""

import os
import sys
import json
import hashlib
import subprocess
from datetime import datetime, timezone

NCB_DB = os.environ.get("NCB_INSTANCE", "41694_agent_memory")
MCP_CLI = "minis-mcp-cli"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def fingerprint(text):
    return hashlib.sha256(text.strip().lower().encode()).hexdigest()[:32]


def exec_sql(sql):
    """通过 minis-mcp-cli 调 NCB MCP 的 execute_sql，返回解析后的结果"""
    args = json.dumps({"database": NCB_DB, "sql": sql})
    try:
        proc = subprocess.run(
            [MCP_CLI, "call", "NoCodeBackend MCP", "execute_sql", args],
            capture_output=True, text=True, timeout=30
        )
        if proc.returncode != 0:
            return {"error": proc.stderr.strip() or "execute_sql failed"}
        raw = json.loads(proc.stdout)
        # 从 MCP 响应中提取实际结果
        content = raw.get("result", {}).get("content", [{}])
        text = content[0].get("text", "{}") if content else "{}"
        return json.loads(text)
    except subprocess.TimeoutExpired:
        return {"error": "execute_sql timeout"}
    except Exception as e:
        return {"error": str(e)}


def sql_escape(val):
    """简单 SQL 字符串转义"""
    if val is None:
        return "NULL"
    s = str(val).replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"')
    return f"'{s}'"


# ==================== 业务逻辑 ====================

def search_memories(query=None, project=None, category=None, limit=20):
    conditions = ["status='active'"]
    if project:
        conditions.append(f"project={sql_escape(project)}")
    if category:
        conditions.append(f"category={sql_escape(category)}")
    if query:
        kw = f"%{query}%"
        conditions.append(f"(title LIKE {sql_escape(kw)} OR content LIKE {sql_escape(kw)} OR tags LIKE {sql_escape(kw)})")
    where = " AND ".join(conditions)
    sql = f"SELECT * FROM memories WHERE {where} ORDER BY access_count DESC LIMIT {int(limit)}"
    res = exec_sql(sql)
    if "error" in res:
        return res
    results = res.get("results", [{}])
    return results[0].get("rows", []) if results else []


def record_memory(project="global", category="fact", title="", content="", tags=""):
    fp = fingerprint(f"{project}:{category}:{title}:{content}")

    # 1. 指纹去重 → NOOP
    check = exec_sql(f"SELECT id, access_count FROM memories WHERE fingerprint={sql_escape(fp)} LIMIT 1")
    rows = check.get("results", [{}])
    rows = rows[0].get("rows", []) if rows else []
    if rows:
        rid = rows[0]["id"]
        ac = int(rows[0].get("access_count", 1)) + 1
        exec_sql(f"UPDATE memories SET access_count={ac} WHERE id={rid}")
        return {"action": "NOOP", "id": rid, "access_count": ac}

    # 2. 标题去重 → UPDATE（软删旧版）
    old_check = exec_sql(
        f"SELECT id FROM memories WHERE project={sql_escape(project)} AND category={sql_escape(category)} "
        f"AND title={sql_escape(title)} AND status='active' LIMIT 1"
    )
    old_rows = old_check.get("results", [{}])
    old_rows = old_rows[0].get("rows", []) if old_rows else []

    # 3. 写入新记录
    sql_insert = (
        f"INSERT INTO memories (project, category, title, content, tags, fingerprint) "
        f"VALUES ({sql_escape(project)}, {sql_escape(category)}, {sql_escape(title)}, "
        f"{sql_escape(content)}, {sql_escape(tags)}, {sql_escape(fp)})"
    )
    insert_res = exec_sql(sql_insert)
    new_id = insert_res.get("results", [{}])
    new_id = new_id[0].get("insertId") if new_id else None

    # 如果有旧版本，标记为 superseded
    if old_rows and new_id:
        old_id = old_rows[0]["id"]
        exec_sql(f"UPDATE memories SET status='superseded' WHERE id={old_id}")
        return {"action": "UPDATE", "new_id": new_id, "superseded_id": old_id}

    return {"action": "ADD", "id": new_id}


def list_all_memories(limit=50):
    sql = f"SELECT * FROM memories WHERE status='active' ORDER BY access_count DESC LIMIT {int(limit)}"
    res = exec_sql(sql)
    rows = res.get("results", [{}])
    return rows[0].get("rows", []) if rows else []


def query_pitfalls(component=None, query=None, limit=10):
    conditions = []
    if component:
        conditions.append(f"component={sql_escape(component)}")
    if query:
        kw = f"%{query}%"
        conditions.append(f"(symptom LIKE {sql_escape(kw)} OR solution LIKE {sql_escape(kw)})")
    where = "WHERE " + " AND ".join(conditions) if conditions else ""
    sql = f"SELECT * FROM pitfalls {where} ORDER BY recurrence DESC LIMIT {int(limit)}"
    res = exec_sql(sql)
    rows = res.get("results", [{}])
    return rows[0].get("rows", []) if rows else []


def record_pitfall(project="global", component="", symptom="", root_cause="", solution="", severity="medium"):
    fp = fingerprint(f"{project}:{component}:{symptom}")

    # 指纹去重 → 递增 recurrence
    check = exec_sql(f"SELECT id, recurrence FROM pitfalls WHERE fingerprint={sql_escape(fp)} LIMIT 1")
    rows = check.get("results", [{}])
    rows = rows[0].get("rows", []) if rows else []
    if rows:
        rid = rows[0]["id"]
        rc = int(rows[0].get("recurrence", 1)) + 1
        exec_sql(f"UPDATE pitfalls SET recurrence={rc} WHERE id={rid}")
        return {"action": "NOOP", "id": rid, "recurrence": rc}

    sql_insert = (
        f"INSERT INTO pitfalls (project, component, symptom, root_cause, solution, severity, fingerprint) "
        f"VALUES ({sql_escape(project)}, {sql_escape(component)}, {sql_escape(symptom)}, "
        f"{sql_escape(root_cause)}, {sql_escape(solution)}, {sql_escape(severity)}, {sql_escape(fp)})"
    )
    res = exec_sql(sql_insert)
    new_id = res.get("results", [{}])
    new_id = new_id[0].get("insertId") if new_id else None
    return {"action": "ADD", "id": new_id}


# ==================== MCP 协议层 ====================

TOOLS = [
    {
        "name": "search_memories",
        "description": "搜索活跃的长期记忆。支持关键词、项目名、分类过滤。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词（匹配标题/内容/标签）"},
                "project": {"type": "string", "description": "按项目名过滤"},
                "category": {"type": "string", "description": "按分类过滤 (fact/rule/preference/architecture)"},
                "limit": {"type": "integer", "description": "最大返回条数，默认20"}
            }
        }
    },
    {
        "name": "record_memory",
        "description": "写入一条长期记忆。自动去重：指纹相同→NOOP(计数+1)，标题相同内容不同→UPDATE(新增版本)，全新→ADD。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "项目名，默认 global"},
                "category": {"type": "string", "description": "分类: fact/rule/preference/architecture"},
                "title": {"type": "string", "description": "简明标题"},
                "content": {"type": "string", "description": "详细内容"},
                "tags": {"type": "string", "description": "逗号分隔的标签"}
            },
            "required": ["title", "content"]
        }
    },
    {
        "name": "query_pitfalls",
        "description": "查询工程踩坑记录。按组件/症状关键词搜索。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "component": {"type": "string", "description": "组件名"},
                "query": {"type": "string", "description": "症状关键词"}
            }
        }
    },
    {
        "name": "record_pitfall",
        "description": "记录一个工程踩坑。自动去重：相同指纹→递增 recurrence 计数。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "项目名"},
                "component": {"type": "string", "description": "出问题的组件"},
                "symptom": {"type": "string", "description": "错误现象/报错信息"},
                "root_cause": {"type": "string", "description": "根因"},
                "solution": {"type": "string", "description": "已验证的解决方案"},
                "severity": {"type": "string", "enum": ["low", "medium", "high", "critical"]}
            },
            "required": ["component", "symptom", "root_cause", "solution"]
        }
    },
    {
        "name": "list_all",
        "description": "列出全部活跃记忆，按访问次数排序。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "最大返回条数，默认50"}
            }
        }
    }
]


def handle(method, params, req_id):
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": req_id, "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "magpie-memory-hub", "version": "2.0.0"}
        }}
    if method == "notifications/initialized":
        return None  # notification, no response
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = params.get("name", "")
        args = params.get("arguments", {})
        dispatch = {
            "search_memories": lambda: search_memories(args.get("query"), args.get("project"), args.get("category"), args.get("limit", 20)),
            "record_memory": lambda: record_memory(args.get("project", "global"), args.get("category", "fact"), args.get("title", ""), args.get("content", ""), args.get("tags", "")),
            "query_pitfalls": lambda: query_pitfalls(args.get("component"), args.get("query"), args.get("limit", 10)),
            "record_pitfall": lambda: record_pitfall(args.get("project", "global"), args.get("component", ""), args.get("symptom", ""), args.get("root_cause", ""), args.get("solution", ""), args.get("severity", "medium")),
            "list_all": lambda: list_all_memories(args.get("limit", 50)),
        }
        fn = dispatch.get(name)
        if not fn:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Unknown tool: {name}"}}
        try:
            result = fn()
            return {"jsonrpc": "2.0", "id": req_id, "result": {
                "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}]
            }}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32000, "message": str(e)}}
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32600, "message": f"Unknown method: {method}"}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = handle(req.get("method"), req.get("params", {}), req.get("id"))
            if resp is not None:
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
        except Exception as e:
            err = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(e)}}
            sys.stdout.write(json.dumps(err) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        print("=== Self-test ===")
        r1 = record_memory("test-proj", "fact", "测试标题", "测试内容", "test,demo")
        print("record_memory:", json.dumps(r1, ensure_ascii=False))
        r2 = search_memories(query="测试")
        print("search_memories:", json.dumps(r2, ensure_ascii=False, indent=2))
        r3 = record_memory("test-proj", "fact", "测试标题", "测试内容", "test,demo")
        print("duplicate (NOOP):", json.dumps(r3, ensure_ascii=False))
        # cleanup
        exec_sql("DELETE FROM memories WHERE project='test-proj'")
        print("cleanup done")
    else:
        main()
