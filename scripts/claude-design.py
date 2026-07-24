#!/usr/bin/env python3
"""Access Claude Design (claude.ai/design) via its MCP-over-HTTP endpoint.

Free/no-extra-auth: uses the shared claude.ai OAuth token in ~/.claude/.credentials.json
(the same login your Claude Code install already has). Requires the owner to have granted
the `agent_design_projects` consent once at claude.ai/design/settings.
Stdlib only. Drives the endpoint directly -> no MCP registration, no Telegram churn.

Usage:
  claude-design.py systems                      # list design systems
  claude-design.py projects                     # list your Design projects
  claude-design.py get <project_id>             # project metadata
  claude-design.py files <project_id> [path]    # list files in a project dir (default /)
  claude-design.py read <project_id> <path>     # print a file's contents (e.g. a .dc.html)
  add --json to any command for raw JSON.

Write ops (create_project / write_files / etc.) exist on the MCP but are intentionally
NOT wrapped here yet -- add them deliberately when a task needs them.
"""
import json, os, sys, urllib.request, urllib.error

URL = "https://api.anthropic.com/v1/design/mcp"
CREDS = os.path.expanduser("~/.claude/.credentials.json")


def _token():
    d = json.load(open(CREDS))
    def find(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(v, str) and "access" in k.lower():
                    return v
                r = find(v)
                if r:
                    return r
        elif isinstance(o, list):
            for v in o:
                r = find(v)
                if r:
                    return r
        return None
    t = find(d)
    if not t:
        sys.exit("claude-design: no claude.ai access token in ~/.claude/.credentials.json (run `claude auth login`).")
    return t


_HDR = None
_ID = [0]


def _hdr():
    global _HDR
    if _HDR is None:
        ver = "2.1.217"
        try:
            import subprocess
            out = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=5).stdout
            import re
            m = re.search(r"\d+\.\d+\.\d+", out)
            if m:
                ver = m.group(0)
        except Exception:
            pass
        _HDR = {
            "Authorization": "Bearer " + _token(),
            "User-Agent": "claude-code/" + ver,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
    return _HDR


def _rpc(method, params):
    _ID[0] += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _ID[0], "method": method, "params": params}).encode()
    try:
        raw = urllib.request.urlopen(urllib.request.Request(URL, data=body, headers=_hdr()), timeout=60).read().decode()
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300]
        if e.code == 403 and "needs_consent" in detail:
            sys.exit("claude-design: needs consent. Owner must approve agent access at claude.ai/design/settings.")
        sys.exit(f"claude-design: HTTP {e.code}: {detail}")
    out = None
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line:
            continue
        try:
            out = json.loads(line)
        except Exception:
            continue
    return out or {}


def _init():
    _rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "claude-code-fleet", "version": "1.0"}})


def _call(name, args):
    _init()
    r = _rpc("tools/call", {"name": name, "arguments": args})
    if "error" in r:
        sys.exit(f"claude-design: {json.dumps(r['error'])[:300]}")
    res = r.get("result", {})
    txt = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
    return txt


def main():
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv
    if not args:
        print(__doc__)
        return
    cmd = args[0]
    if cmd == "systems":
        out = _call("list_design_systems", {})
    elif cmd == "projects":
        out = _call("list_projects", {})
    elif cmd == "get":
        out = _call("get_project", {"project_id": args[1]})
    elif cmd == "files":
        path = args[2] if len(args) > 2 else "/"
        out = _call("list_files", {"project_id": args[1], "path": path})
    elif cmd == "read":
        out = _call("read_file", {"project_id": args[1], "path": args[2]})
    else:
        sys.exit(f"unknown command: {cmd}\n{__doc__}")

    if as_json:
        print(out)
        return
    # pretty-print list-ish JSON, else raw
    try:
        parsed = json.loads(out)
    except Exception:
        print(out)
        return
    if isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, dict) and "name" in item:
                extra = item.get("id") or item.get("type") or ""
                print(f"- {item['name']}  {('['+item['type']+']') if item.get('type') else ''} {item.get('id','')}".rstrip())
            elif isinstance(item, dict) and "path" in item:
                sz = f" ({item['size']}b)" if item.get("size") else ""
                print(f"- {item['path']} [{item.get('type','')}]" + sz)
            else:
                print("-", json.dumps(item)[:200])
    else:
        print(json.dumps(parsed, ensure_ascii=False, indent=2)[:2000])


if __name__ == "__main__":
    main()
