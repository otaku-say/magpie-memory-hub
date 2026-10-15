#!/usr/bin/env python3
"""
Magpie Memory Daemon & Unified MCP Server
------------------------------------------
1. Daemon Worker:
   - Polls Magpie logs / memory buffer.
   - Invokes Magpie small model (Extractor) to generate candidate knowledge & pitfalls.
   - Invokes Clef (Judge) to score and refine facts.
   - Writes validated facts to NoCodeBackend `41694_agent_core_hub`.
   - Periodically syncs high-confidence memories back into Magpie plugin options (`hot_memories`).

2. MCP Server (JSON-RPC):
   - Exposes memory tools for Agents:
     * search_memories(query, project_name)
     * record_memory(project_name, category, title, content, tags)
     * query_pitfalls(component, symptom)
     * record_pitfall(project_name, component, symptom, root_cause, solution, severity)
     * store_artifact(project_name, artifact_type, title, file_url, description)
"""

import os
import sys
import json
import time
import hashlib
import urllib.request
import urllib.error
from datetime import datetime

NCB_BASE_URL = os.environ.get("NCB_API_URL", "https://api.nocodebackend.com")
NCB_INSTANCE = os.environ.get("NCB_INSTANCE", "41694_agent_core_hub")
NCB_SECRET_KEY = os.environ.get("NCB_SECRET_KEY", "sk_live_qcmki2ntz9epoz9r91")

MAGPIE_BASE_URL = os.environ.get("MAGPIE_BASE_URL", "http://127.0.0.1:8000/v1")
MAGPIE_API_KEY = os.environ.get("MAGPIE_API_KEY", "dummy-key")
EXTRACTOR_MODEL = os.environ.get("EXTRACTOR_MODEL", "deepseek-chat")
CLEF_JUDGE_MODEL = os.environ.get("CLEF_JUDGE_MODEL", "clef")

def ncb_request(method, path, query_params=None, data=None):
    params = dict(query_params or {})
    params["Instance"] = NCB_INSTANCE
    from urllib.parse import urlencode
    qs = urlencode(params)
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

# ----------------- Core Memory Operations -----------------

def record_memory(project_name, category, title, content, tags=""):
    fp = compute_fingerprint(f"{project_name}:{category}:{title}")
    # Check duplicate
    check = ncb_request("GET", "/read/knowledge_memories", query_params={"fingerprint": fp})
    if check.get("data") and len(check["data"]) > 0:
        return {"ok": True, "message": "Memory already exists (idempotent skip)", "id": check["data"][0]["id"]}

    payload = {
        "project_name": project_name,
        "category": category,
        "title": title,
        "content": content,
        "tags": tags.lower(),
        "fingerprint": fp,
        "confidence_score": 1.0,
        "status": "active",
        "superseded_by_id": 0,
        "access_count": 0
    }
    return ncb_request("POST", "/create/knowledge_memories", data=payload)

def search_memories(query=None, project_name=None):
    params = {}
    if project_name:
        params["project_name"] = project_name
    if query:
        params["tags[like]"] = query
    res = ncb_request("GET", "/read/knowledge_memories", query_params=params)
    return res.get("data", [])

def record_pitfall(project_name, component, symptom, root_cause, solution, severity="medium", tags=""):
    fp = compute_fingerprint(f"{project_name}:{component}:{symptom}")
    check = ncb_request("GET", "/read/engineering_pitfalls", query_params={"fingerprint": fp})
    if check.get("data") and len(check["data"]) > 0:
        return {"ok": True, "message": "Pitfall already exists (idempotent skip)", "id": check["data"][0]["id"]}

    payload = {
        "project_name": project_name,
        "component": component,
        "symptom": symptom,
        "root_cause": root_cause,
        "solution": solution,
        "severity": severity,
        "fingerprint": fp,
        "tags": tags.lower()
    }
    return ncb_request("POST", "/create/engineering_pitfalls", data=payload)

def query_pitfalls(component=None, query=None):
    params = {}
    if component:
        params["component"] = component
    if query:
        params["symptom[like]"] = query
    res = ncb_request("GET", "/read/engineering_pitfalls", query_params=params)
    return res.get("data", [])


# ----------------- MCP Server Standard Protocol -----------------

def handle_mcp_call(method, params, req_id):
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "magpie-memory-hub", "version": "1.0.0"}
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
                        "description": "Search long-term memories and architecture rules in NoCodeBackend memory hub.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "query": {"type": "string", "description": "Keyword or tag to search for"},
                                "project_name": {"type": "string", "description": "Filter by project name (optional)"}
                            }
                        }
                    },
                    {
                        "name": "record_memory",
                        "description": "Persist a valuable engineering memory or rule into the long-term memory hub.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "project_name": {"type": "string", "description": "Project or repository name"},
                                "category": {"type": "string", "description": "architecture, rule, or preference"},
                                "title": {"type": "string", "description": "Short concise summary title"},
                                "content": {"type": "string", "description": "Detailed factual guideline or rule"},
                                "tags": {"type": "string", "description": "Comma-separated keywords for indexing"}
                            },
                            "required": ["project_name", "category", "title", "content"]
                        }
                    },
                    {
                        "name": "query_pitfalls",
                        "description": "Look up known engineering pitfalls, bug root causes and solutions.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "component": {"type": "string", "description": "Component or tool name"},
                                "query": {"type": "string", "description": "Error symptom keyword"}
                            }
                        }
                    },
                    {
                        "name": "record_pitfall",
                        "description": "Record an engineering bug, root cause and verified solution to prevent future recurrence.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "project_name": {"type": "string", "description": "Project name"},
                                "component": {"type": "string", "description": "Component that failed"},
                                "symptom": {"type": "string", "description": "Error message or behavior"},
                                "root_cause": {"type": "string", "description": "Technical root cause"},
                                "solution": {"type": "string", "description": "Verified fix or workaround"},
                                "severity": {"type": "string", "enum": ["low", "medium", "high", "critical"]},
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
            res_data = search_memories(args.get("query"), args.get("project_name"))
        elif tool_name == "record_memory":
            res_data = record_memory(
                args.get("project_name"), args.get("category"),
                args.get("title"), args.get("content"), args.get("tags", "")
            )
        elif tool_name == "query_pitfalls":
            res_data = query_pitfalls(args.get("component"), args.get("query"))
        elif tool_name == "record_pitfall":
            res_data = record_pitfall(
                args.get("project_name"), args.get("component"),
                args.get("symptom"), args.get("root_cause"),
                args.get("solution"), args.get("severity", "medium"),
                args.get("tags", "")
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
        # Default self-test mode
        print("Self-testing NoCodeBackend Memory Hub connection...")
        r = record_memory("magpie-test", "rule", "Always Test Before Ship", "Verify all endpoints before declaring done.", "test,qa")
        print("Record memory result:", r)
        search = search_memories("test", "magpie-test")
        print("Search result:", search)
        print("Self-test completed.")
