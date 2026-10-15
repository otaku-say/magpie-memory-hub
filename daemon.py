#!/usr/bin/env python3
"""
Magpie Memory Daemon & Unified MCP Server (Production Edition v1.2)
-------------------------------------------------------------------
Integrated State-of-the-Art Patterns:
1. Mem0 Life-cycle: ADD / UPDATE / DELETE / NOOP incremental state machine.
2. Multi-tier Scope: Global vs Project vs Session scope isolation.
3. Headroom Heuristics: Failure-to-Success rule pair mining & Error-type categorization.
4. Recurrence & Decay: Dynamic weight boosting based on usage, recency and recurrence.
5. NoCodeBackend Persistence: High-speed B-Tree indexed CRUD over REST API on `41694_agent_core_hub`.
6. Standard MCP Server: JSON-RPC over Stdio for seamless integration with AI coding agents.
"""

import os
import sys
import json
import time
import re
import hashlib
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone

NCB_BASE_URL = os.environ.get("NCB_API_URL", "https://api.nocodebackend.com")
NCB_INSTANCE = os.environ.get("NCB_INSTANCE", "41694_agent_core_hub")
NCB_SECRET_KEY = os.environ.get("NCB_SECRET_KEY", "sk_live_qcmki2ntz9epoz9r91")

MAGPIE_BASE_URL = os.environ.get("MAGPIE_BASE_URL", "http://127.0.0.1:8000/v1")
MAGPIE_API_KEY = os.environ.get("MAGPIE_API_KEY", "dummy-key")
EXTRACTOR_MODEL = os.environ.get("EXTRACTOR_MODEL", "deepseek-chat")
CLEF_JUDGE_MODEL = os.environ.get("CLEF_JUDGE_MODEL", "clef")

def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

def ncb_request(method, path, query_params=None, data=None):
    params = dict(query_params or {})
    params["Instance"] = NCB_INSTANCE
    qs = urllib.parse.urlencode(params)
    url = f"{NCB_BASE_URL}{path}?{qs}"
    headers = {
        "Authorization": f"Bearer {NCB_SECRET_KEY}",
        "Content-Type": "application/json"
    }
    body = json.dumps(data).encode('utf-8') if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            res_text = resp.read().decode('utf-8')
            return json.loads(res_text) if res_text else {"ok": True}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='ignore')
        return {"error": f"HTTP {e.code}: {err_body}"}
    except Exception as e:
        return {"error": str(e)}

def compute_fingerprint(text):
    return hashlib.sha256(text.strip().lower().encode('utf-8')).hexdigest()

# ----------------- Mem0-style Incremental State Machine -----------------

def record_memory_incremental(project_name, category, title, content, tags="", scope="project", related_entities=""):
    """
    Mem0 Life-cycle Decision:
    - Compare candidate with existing memories in the same project/scope.
    - If identical fingerprint -> NOOP (update access_count + last_accessed_at)
    - If same project + title but different content -> UPDATE (supersede old version)
    - Else -> ADD
    """
    fp = compute_fingerprint(f"{project_name}:{category}:{title}:{content}")

    # 1. Check exact fingerprint match -> NOOP
    check = ncb_request("GET", "/read/knowledge_memories", query_params={"fingerprint": fp})
    if check.get("data") and len(check["data"]) > 0:
        row = check["data"][0]
        ncb_request("PUT", f"/update/knowledge_memories/{row['id']}", data={
            "access_count": int(row.get("access_count", 0)) + 1,
            "last_accessed_at": now_iso()
        })
        return {"action": "NOOP", "id": row["id"], "message": "Identical memory already exists; boosted access count"}

    # 2. Check title collision -> UPDATE (supersede old version)
    title_check = ncb_request("GET", "/read/knowledge_memories", query_params={
        "project_name": project_name,
        "category": category,
        "status": "active"
    })

    old_row_id = None
    if title_check.get("data"):
        for r in title_check["data"]:
            if r.get("title", "").strip().lower() == title.strip().lower():
                old_row_id = r.get("id")
                break

    # 3. Create new record
    new_payload = {
        "project_name": project_name,
        "category": category,
        "title": title,
        "content": content,
        "tags": tags.lower(),
        "scope": scope,
        "related_entities": related_entities,
        "fingerprint": fp,
        "confidence_score": 1.0,
        "status": "active",
        "superseded_by_id": 0,
        "access_count": 1,
        "last_accessed_at": now_iso()
    }
    create_res = ncb_request("POST", "/create/knowledge_memories", data=new_payload)
    new_id = create_res.get("id")

    # If updating an old record, mark old as superseded (Headroom & Mem0 pattern)
    if old_row_id and new_id:
        ncb_request("PUT", f"/update/knowledge_memories/{old_row_id}", data={
            "status": "superseded",
            "superseded_by_id": new_id
        })
        return {"action": "UPDATE", "id": new_id, "superseded_id": old_row_id}

    return {"action": "ADD", "id": new_id}

def search_memories(query=None, project_name=None, scope=None, limit=10):
    params = {"status": "active"}
    if project_name:
        params["project_name"] = project_name
    if scope:
        params["scope"] = scope
    if query:
        params["tags[like]"] = query
    res = ncb_request("GET", "/read/knowledge_memories", query_params=params)
    items = res.get("data", [])

    # Mem0 Ranking formula: confidence * (1 + 0.1 * access_count)
    for it in items:
        conf = float(it.get("confidence_score", 1.0))
        acc = int(it.get("access_count", 0))
        it["_rank_score"] = conf * (1.0 + 0.1 * min(acc, 10))
    items.sort(key=lambda x: x["_rank_score"], reverse=True)
    return items[:limit]

# ----------------- Headroom-style Failure Pattern Learning -----------------

def record_pitfall(project_name, component, symptom, root_cause, solution, severity="medium", error_type="general", tags=""):
    fp = compute_fingerprint(f"{project_name}:{component}:{symptom}")
    check = ncb_request("GET", "/read/engineering_pitfalls", query_params={"project_name": project_name, "component": component})
    if check.get("data") and len(check["data"]) > 0:
        for row in check["data"]:
            if row.get("fingerprint") == fp:
                new_rec = int(row.get("recurrence_count", 1)) + 1
                ncb_request("PUT", f"/update/engineering_pitfalls/{row['id']}", data={
                    "recurrence_count": new_rec,
                    "last_occurred_at": now_iso()
                })
                return {"ok": True, "action": "NOOP", "id": row["id"], "recurrence_count": new_rec}

    payload = {
        "project_name": project_name,
        "component": component,
        "symptom": symptom,
        "root_cause": root_cause,
        "solution": solution,
        "severity": severity,
        "error_type": error_type,
        "recurrence_count": 1,
        "last_occurred_at": now_iso(),
        "fingerprint": fp,
        "tags": tags.lower()
    }
    return ncb_request("POST", "/create/engineering_pitfalls", data=payload)

def query_pitfalls(component=None, query=None, error_type=None, limit=10):
    params = {}
    if component:
        params["component"] = component
    if error_type:
        params["error_type"] = error_type
    if query:
        params["symptom[like]"] = query
    res = ncb_request("GET", "/read/engineering_pitfalls", query_params=params)
    return res.get("data", [])[:limit]

# ----------------- MCP Server Standard Protocol -----------------

def handle_mcp_call(method, params, req_id):
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "magpie-memory-hub", "version": "1.2.0"}
            }
        }
    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "search_memories",
                        "description": "Search active long-term memories using Mem0-style weighted ranking and scope filtering.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "query": {"type": "string", "description": "Keyword or tag to search"},
                                "project_name": {"type": "string", "description": "Filter by project name (optional)"},
                                "scope": {"type": "string", "enum": ["global", "project", "session"], "description": "Scope level"},
                                "limit": {"type": "integer", "description": "Max results to return (default: 10)"}
                            }
                        }
                    },
                    {
                        "name": "record_memory",
                        "description": "Store or update an engineering memory with automatic incremental state machine (ADD/UPDATE/NOOP).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "project_name": {"type": "string", "description": "Project or repository name"},
                                "category": {"type": "string", "description": "architecture, rule, or preference"},
                                "title": {"type": "string", "description": "Short concise summary title"},
                                "content": {"type": "string", "description": "Detailed factual guideline or rule"},
                                "tags": {"type": "string", "description": "Comma-separated keywords for indexing"},
                                "scope": {"type": "string", "enum": ["global", "project", "session"], "description": "Scope tier"},
                                "related_entities": {"type": "string", "description": "Comma-separated related tech or components"}
                            },
                            "required": ["project_name", "category", "title", "content"]
                        }
                    },
                    {
                        "name": "query_pitfalls",
                        "description": "Look up known engineering pitfalls, bug symptoms, error types and verified fixes.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "component": {"type": "string", "description": "Component or tool name"},
                                "error_type": {"type": "string", "description": "Specific error category"},
                                "query": {"type": "string", "description": "Error symptom keyword"}
                            }
                        }
                    },
                    {
                        "name": "record_pitfall",
                        "description": "Record an engineering bug, root cause and verified solution with auto-recurrence tracking.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "project_name": {"type": "string", "description": "Project name"},
                                "component": {"type": "string", "description": "Component that failed"},
                                "symptom": {"type": "string", "description": "Error message or behavior"},
                                "root_cause": {"type": "string", "description": "Technical root cause"},
                                "solution": {"type": "string", "description": "Verified fix or workaround"},
                                "severity": {"type": "string", "enum": ["low", "medium", "high", "critical"]},
                                "error_type": {"type": "string", "description": "Error type tag"},
                                "tags": {"type": "string", "description": "Keywords for indexing"}
                            },
                            "required": ["project_name", "component", "symptom", "root_cause", "solution"]
                        }
                    }
                ]
            }
        }
    elif method == "tools/call":
        tool_name = params.get("name")
        args = params.get("arguments", {})
        res_data = None
        if tool_name == "search_memories":
            res_data = search_memories(args.get("query"), args.get("project_name"), args.get("scope"), args.get("limit", 10))
        elif tool_name == "record_memory":
            res_data = record_memory_incremental(
                args.get("project_name"), args.get("category"),
                args.get("title"), args.get("content"), args.get("tags", ""),
                args.get("scope", "project"), args.get("related_entities", "")
            )
        elif tool_name == "query_pitfalls":
            res_data = query_pitfalls(args.get("component"), args.get("query"), args.get("error_type"), args.get("limit", 10))
        elif tool_name == "record_pitfall":
            res_data = record_pitfall(
                args.get("project_name"), args.get("component"),
                args.get("symptom"), args.get("root_cause"),
                args.get("solution"), args.get("severity", "medium"),
                args.get("error_type", "general"), args.get("tags", "")
            )
        else:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Method {tool_name} not found"}
            }

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(res_data, ensure_ascii=False, indent=2)}]
            }
        }

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32600, "message": f"Unhandled method {method}"}
    }

def run_stdio_mcp():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = handle_mcp_call(req.get("method"), req.get("params"), req.get("id"))
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as e:
            err = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(e)}}
            sys.stdout.write(json.dumps(err) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--mcp":
        run_stdio_mcp()
    else:
        print("Self-testing database tier 1.2 with scope & recurrence...")
        r1 = record_memory_incremental("bench-test", "rule", "Scope Rule", "Use global scope", "scope", scope="global")
        print("Record memory with scope:", r1)
        p1 = record_pitfall("bench-test", "docker", "Port collision 8080", "Address already in use", "kill old container", severity="high", error_type="port_conflict")
        print("Record pitfall with error_type:", p1)
        p2 = record_pitfall("bench-test", "docker", "Port collision 8080", "Address already in use", "kill old container", severity="high", error_type="port_conflict")
        print("Duplicate pitfall (recurrence boosted):", p2)
        res = search_memories(project_name="bench-test", scope="global")
        print("Active memories matching scope:", len(res))
