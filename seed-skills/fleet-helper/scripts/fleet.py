#!/usr/bin/env python3
"""
ClaudeClaw fleet helper - shared, deterministic plumbing so agents don't burn
tokens hand-rolling curl/SQL/escaping in the model.

Covers: dashboard API auth (token always read from store/.dashboard-token, never
hardcoded), memory save/search, daily log, inter-agent messages, agent list,
kanban read helpers, and Telegram MarkdownV2 escaping.

Importable as a module or used from the CLI. See README.md for usage.

Config (no hardcoded paths or secrets):
  CLAW_DIR  - project root (the dir containing `store/`). If unset, the project
              root is auto-detected by walking up from the current directory
              until a `store/.dashboard-token` is found.
  CLAW_BASE - dashboard base url (default http://localhost:3420).
"""
import json
import os
import sys
import sqlite3
import urllib.request
import urllib.error


def project_dir():
    env = os.environ.get("CLAW_DIR")
    if env and os.path.isdir(os.path.join(env, "store")):
        return env
    d = os.getcwd()
    while True:
        if os.path.isfile(os.path.join(d, "store", ".dashboard-token")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    raise RuntimeError("project root not found (set CLAW_DIR to the dir containing store/)")


def base_url():
    return os.environ.get("CLAW_BASE", "http://localhost:3420").rstrip("/")


def token():
    with open(os.path.join(project_dir(), "store", ".dashboard-token")) as f:
        return f.read().strip()


def db_path():
    return os.path.join(project_dir(), "store", "claudeclaw.db")


def api(method, path, payload=None, timeout=20):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base_url() + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"API {method} {path} -> {e.code}: {e.read().decode()[:200]}")
    try:
        return json.loads(body)
    except ValueError:
        return body


def save_memory(agent, content, category="warm", keywords=""):
    return api("POST", "/api/memories", {"agent_id": agent, "content": content,
                                         "category": category, "keywords": keywords})


def search_memory(agent, q, category=None):
    from urllib.parse import quote
    path = f"/api/memories?agent={quote(agent)}&q={quote(q)}"
    if category:
        path += f"&category={quote(category)}"
    return api("GET", path)


def daily_log(agent, content):
    return api("POST", "/api/daily-log", {"agent_id": agent, "content": content})


def send_message(from_agent, to_agent, content):
    return api("POST", "/api/messages", {"from": from_agent, "to": to_agent, "content": content})


def list_agents():
    return api("GET", "/api/agents")


def _kanban(where, params=()):
    con = sqlite3.connect(db_path())
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id, title, status, assignee, priority, project, due_date, "
            "updated_at FROM kanban_cards WHERE archived_at IS NULL AND " + where,
            params).fetchall()
    finally:
        con.close()
    return [dict(r) for r in rows]


def kanban_due_today():
    return _kanban(
        "due_date IS NOT NULL AND status != 'done' "
        "AND date(due_date,'unixepoch','localtime') <= date('now','localtime') "
        "ORDER BY due_date")


def kanban_stuck(idle_seconds=14400):
    return _kanban("status = 'in_progress' AND updated_at < strftime('%s','now') - ? "
                   "ORDER BY updated_at", (idle_seconds,))


def kanban_by_status(status):
    return _kanban("status = ? ORDER BY priority DESC, updated_at DESC", (status,))


_MDV2_SPECIAL = r"_*[]()~`>#+-=|{}.!\\"


def escape_mdv2(text):
    """Escape literal text for Telegram MarkdownV2. Escape your dynamic text with
    this, THEN wrap intended formatting (e.g. '*'+escape_mdv2(label)+'*' for bold)."""
    return "".join("\\" + ch if ch in _MDV2_SPECIAL else ch for ch in str(text))


def _out(v):
    print(json.dumps(v, ensure_ascii=False, indent=2) if isinstance(v, (dict, list)) else v)


def main(argv):
    if not argv:
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "mdv2":
        print(escape_mdv2(rest[0] if rest else sys.stdin.read()))
    elif cmd == "mem-save":
        _out(save_memory(rest[0], rest[1], rest[2] if len(rest) > 2 else "warm",
                         rest[3] if len(rest) > 3 else ""))
    elif cmd == "mem-search":
        _out(search_memory(rest[0], rest[1], rest[2] if len(rest) > 2 else None))
    elif cmd == "daily-log":
        _out(daily_log(rest[0], rest[1]))
    elif cmd == "msg":
        _out(send_message(rest[0], rest[1], rest[2]))
    elif cmd == "agents":
        _out([{"name": a.get("name"), "running": a.get("running"),
               "model": a.get("model")} for a in list_agents()])
    elif cmd == "kanban-due":
        _out(kanban_due_today())
    elif cmd == "kanban-stuck":
        _out(kanban_stuck(int(rest[0]) if rest else 14400))
    elif cmd == "kanban-status":
        _out(kanban_by_status(rest[0]))
    else:
        sys.stderr.write(f"unknown command: {cmd}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
