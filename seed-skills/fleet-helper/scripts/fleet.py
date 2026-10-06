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
import urllib.parse
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


def kanban_comment(card_id, author, content):
    """POST a comment. Hand-rolling this as `python3 -c json.dumps | curl --data-binary`
    was written out by hand three times on 2026-09-19 alone; the payload carries
    newlines and non-ASCII text, so a `-d "{...}"` shell string is both fragile and
    (with backticks or $()) unsafe. Returns the API body -- an `id` means it landed.

    scripts/kartya-es-ertesites.py is the more gated path for the same write (accent
    gate, owner notification, the automated marker) AND IT IS THE RIGHT ONE WHERE IT
    RUNS -- but its roster is a literal (`FLEET`/`GAZDA`, src line ~172), so on an
    install whose agents are not in that set it refuses every --author (measured
    2026-09-27). These wrappers carry no roster: they take whatever the dashboard
    accepts. Prefer the gated tool when your agent is in its FLEET; use these when it
    is not, and remember what they do not check.
    """
    return api("POST", f"/api/kanban/{_card(card_id)}/comments",
               {"author": author, "content": content})


def kanban_move(card_id, status, actor):
    """POST a status move. `actor` is REQUIRED and is not decoration: the move route
    passes it to fireKanbanDispatch, and resolveKanbanDispatch suppresses the echo only
    when the mover IS the assignee. Omit it and a move of YOUR OWN card to in_progress
    queues a full task-assignment message back at you -- measured 2026-09-27, twice
    (messages 21 and 22), from two throwaway selftest cards. Nothing fails: the move
    answers {"ok":true} and the echo arrives later, costing an agent round.

    See kanban_comment on which path to prefer, and note that a move made here leaves
    NO comment, while the gated tool ties every move to one."""
    return api("POST", f"/api/kanban/{_card(card_id)}/move", {"status": status, "actor": actor})


def kanban_set(card_id, fields, actor):
    """PUT a PARTIAL field set. Safe on this endpoint (unlike /api/memories/<id>):
    updateKanbanCard merges `{...card, ...fields}`, so omitted columns keep their
    value -- measured in src/db.ts. Writable: title, description, status, assignee,
    priority, project, parent_id, due_date, sort_order, archived_at. Anything else
    is rejected with a 400 and the card is not touched (#1257).

    This is the only path to the columns kartya-es-ertesites.py does not expose at
    all -- due_date, project, parent_id, sort_order -- which the audit scripts read.

    `actor` is REQUIRED, for the same reason as in kanban_move: the PUT route takes it
    out of the body (src/web/routes/kanban.ts, `const { actor, ...data }`) and hands it
    to updateKanbanCard, which writes it on the status-change audit event. Without it
    a status set through here is recorded with no author.
    """
    if "actor" in fields:
        raise ValueError("actor is not a card field: pass it as the actor argument")
    return api("PUT", f"/api/kanban/{_card(card_id)}", {**fields, "actor": actor})


def _card(card_id):
    """The card id as one path segment (the routes decodeURIComponent it)."""
    return urllib.parse.quote(str(card_id), safe="")


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


def _usage(line):
    """A missing argument is a usage error (exit 2, nothing sent), not an IndexError."""
    sys.stderr.write(f"usage: fleet.py {line}\n")
    return 2


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
    elif cmd == "kanban-comment":
        # kanban-comment <id> <author> <text|->   ("-" reads the text from stdin)
        if len(rest) != 3:
            return _usage("kanban-comment <id> <author> <text|->")
        body = sys.stdin.read() if rest[2] == "-" else rest[2]
        _out(kanban_comment(rest[0], rest[1], body))
    elif cmd == "kanban-move":
        # kanban-move <id> <status> <actor>   (actor is required -- see kanban_move)
        if len(rest) != 3:
            return _usage("kanban-move <id> <status> <actor>")
        _out(kanban_move(rest[0], rest[1], rest[2]))
    elif cmd == "kanban-set":
        # kanban-set <id> <field> <value> <actor>   (value "null" clears the column)
        if len(rest) != 4:
            return _usage("kanban-set <id> <field> <value> <actor>")
        _out(kanban_set(rest[0], {rest[1]: None if rest[2] == "null" else rest[2]}, rest[3]))
    else:
        sys.stderr.write(f"unknown command: {cmd}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
