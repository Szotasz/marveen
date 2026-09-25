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


def api(method, path, payload=None, timeout=20, want_headers=False):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base_url() + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode()
            headers = dict(r.headers.items())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"API {method} {path} -> {e.code}: {e.read().decode()[:200]}")
    try:
        parsed = json.loads(body)
    except ValueError:
        parsed = body
    return (parsed, headers) if want_headers else parsed


def save_memory(agent, content, category="warm", keywords=""):
    return api("POST", "/api/memories", {"agent_id": agent, "content": content,
                                         "category": category, "keywords": keywords})


# MEMKERESVAK917: this used to return the body and drop r.headers on the floor.
# The memory search is deliberately forgiving -- when nothing matches the query
# as asked, it answers with whatever the leftover filler words pulled in, and
# that answer is byte-identical to a real hit in the BODY. The only thing that
# tells them apart is the X-Memory-Search response header. An agent calling this
# helper could not opt in: there is no `-D` to add to a Python function.
#
# So the label comes back WITH the rows, and `relaxed` gets its own warning
# string, because the whole failure mode is a caller who skims the rows.
def search_memory(agent, q, category=None, strict=False):
    from urllib.parse import quote
    path = f"/api/memories?agent={quote(agent)}&q={quote(q)}"
    if category:
        # No limit widening here on purpose. Until #1384 the tier filter ran
        # AFTER the limit, so a category search truncated in silence and this
        # asked for limit=200 to work around it. #1384 pushed the filter into
        # the search SQL, so the default window now holds rows the caller
        # actually asked for, and a hardcoded 200 would just be a bigger page
        # than every other call site uses.
        path += f"&category={quote(category)}"
    if strict:
        path += "&strict=1"
    rows, headers = api("GET", path, want_headers=True)
    label = ""
    for k, v in headers.items():
        if k.lower() == "x-memory-search":
            label = v
            break
    relaxed = "relaxed=true" in label
    out = {
        "label": label,
        "relaxed": relaxed,
        "strict": strict,
        "hits": len(rows) if isinstance(rows, list) else None,
        "rows": rows,
    }
    if relaxed:
        out["warning"] = ("relaxed=true -- semmi nem illeszkedett UGY, AHOGY KERTED. "
                          "Ezek mentett kozelitesek, NEM bizonyitek. Hiany-allitashoz "
                          "futtasd ujra strict=1-gyel.")
    return out


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


def escape_mdv2_keep_bold(text):
    """Escape for MarkdownV2 but leave '*' untouched, so hand-authored '*bold*'
    markers survive. Use this for long, hand-written messages (e.g. the morning
    brief) where the formatting is inline in the prose rather than wrapped around
    programmatic labels. Only '*' is preserved: every other special is escaped,
    so pair your asterisks or Telegram rejects the message with a 400."""
    return "".join(
        ch if ch == "*" else ("\\" + ch if ch in _MDV2_SPECIAL else ch)
        for ch in str(text)
    )


def outgoing_gate_check(text):
    """Return a list of problems the outgoing-copy-gate hook would reject.
    Cheaper to run here than to have the send blocked."""
    problems = []
    if "\u2014" in text or "\u2013" in text:
        problems.append("em/en dash present (the gate rejects it)")
    if " -- " in text.replace("\\-", "-"):
        problems.append("space-hyphen-hyphen-space present (the gate rejects it)")
    stars = text.count("*") - text.count("\\*")
    if stars % 2:
        problems.append("odd number of unescaped '*' (Telegram 400: unclosed entity)")
    return problems


def _out(v):
    print(json.dumps(v, ensure_ascii=False, indent=2) if isinstance(v, (dict, list)) else v)


def main(argv):
    if not argv:
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "mdv2":
        print(escape_mdv2(rest[0] if rest else sys.stdin.read()))
    elif cmd == "mdv2b":
        src = rest[0] if rest else sys.stdin.read()
        bad = outgoing_gate_check(src)
        if bad:
            sys.stderr.write("BLOCKED before send:\n- " + "\n- ".join(bad) + "\n")
            return 2
        print(escape_mdv2_keep_bold(src))
    elif cmd == "mem-save":
        _out(save_memory(rest[0], rest[1], rest[2] if len(rest) > 2 else "warm",
                         rest[3] if len(rest) > 3 else ""))
    elif cmd == "mem-search":
        res = search_memory(rest[0], rest[1], rest[2] if len(rest) > 2 else None,
                            strict=(len(rest) > 3 and rest[3] in ("strict", "1", "true")))
        # stderr as well as the JSON field: the rows are what a reader's eye
        # goes to, and a rescued near-miss looks exactly like a real hit there.
        if res.get("warning"):
            sys.stderr.write("FIGYELEM: " + res["warning"] + "\n")
        _out(res)
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
