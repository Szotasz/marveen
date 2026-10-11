#!/usr/bin/env python3
"""jegyzetek.py -- the team's NOTES page ("Jegyzetek") on the dashboard.

WHY: small "I'll check it tomorrow" items were slipping through: too small for a card
of their own, and lost once they lived only in a chat message. This is one list with
who / what / written on / due; everyone reads it morning and evening and deletes the
line when it is done or no longer relevant. The data lives in /api/notes (team_notes
table), and the dashboard shows it under Kanban as "Jegyzetek".

`KINEK` (assignee) is an agent name, the owner, or `mindenki` (everyone); it is stored
lower-case. Deletion is soft: who, when and why stay visible on the page for 7 days,
so nothing vanishes silently.

Usage:
    python3 scripts/jegyzetek.py lista [--kinek NAME]
    python3 scripts/jegyzetek.py uj KINEK "what" --ki NAME [--hatarido YYYY-MM-DD]
    python3 scripts/jegyzetek.py torol ID --ki NAME [--ok "why"]
    python3 scripts/jegyzetek.py lejart            # due today or earlier
    python3 scripts/jegyzetek.py ertesit reggel|este [--dry-run]

`--ki` names who writes or deletes the line. It is required: the row records it, and a
default would put a guessed name on it.

`ertesit` (morning / evening) sends each RUNNING agent that has lines (its own or
`mindenki`) one inter-agent message with the line ids and the commands to read and
delete them. The note text itself is NOT relayed: the message goes out in the main
agent's name, and a note is any writer's free text. Agents with nothing on the list are
not woken; a stopped agent with lines is printed as NOT RUNNING. The main agent is
skipped. Exit 1 if any message could not be sent.

Environment: MARVEEN_API_BASE, else the port chain of scripts/agent-msg.sh
(MARVEEN_WEB_PORT, WEB_PORT, WEB_PORT in .env, 3420); MARVEEN_TOKEN_FILE (default
store/.dashboard-token); MAIN_AGENT_ID (else .env, else marveen).
"""
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
# Note ids are 6 lower-case hex characters (routes/notes.ts newNoteId). Anything
# else is refused before it can reach a URL path.
ID_RE = re.compile(r"[0-9a-f]{6}")


class CliError(Exception):
    """A message for the caller, printed without a traceback; exit 1."""


def read_env_keys(keys):
    """The named keys of <root>/.env, read WITHOUT sourcing the file (it carries tokens)."""
    out = {}
    try:
        with open(os.path.join(ROOT, ".env"), encoding="utf-8") as fh:
            for line in fh:
                k, sep, v = line.rstrip("\n").partition("=")
                if sep and k in keys and k not in out:
                    out[k] = v.strip().strip("'\"")
    except OSError:
        pass
    return out


def api_base():
    base = os.environ.get("MARVEEN_API_BASE")
    if base:
        return base.rstrip("/")
    port = (os.environ.get("MARVEEN_WEB_PORT") or os.environ.get("WEB_PORT")
            or read_env_keys(("WEB_PORT",)).get("WEB_PORT") or "3420")
    return "http://localhost:%s" % port


def main_agent_id():
    return (os.environ.get("MAIN_AGENT_ID")
            or read_env_keys(("MAIN_AGENT_ID",)).get("MAIN_AGENT_ID") or "marveen")


def token():
    path = os.environ.get("MARVEEN_TOKEN_FILE") or os.path.join(ROOT, "store", ".dashboard-token")
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError as e:
        raise CliError("cannot read the dashboard token (%s): %s" % (path, e.strerror))


def api(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(api_base() + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        raise CliError("%s %s -> HTTP %s %s" % (method, path, e.code, e.read().decode()[:300]))
    except (urllib.error.URLError, OSError) as e:
        raise CliError("%s %s -> dashboard not reachable at %s (%s)" % (
            method, path, api_base(), getattr(e, "reason", e)))


def load():
    notes = []
    for r in api("GET", "/api/notes"):
        notes.append({"id": r["id"], "kinek": r["assignee"].lower(), "mit": r["content"],
                      "felirva": datetime.datetime.fromtimestamp(r["created_at"]).date().isoformat(),
                      "hatarido": r.get("due_date") or "-"})
    return notes


def fmt(n):
    return "- #%s | %s | %s | written %s | due %s" % (
        n["id"], n["kinek"], n["mit"], n["felirva"], n["hatarido"])


def arg(args, name, default=None):
    if name in args:
        i = args.index(name)
        if i + 1 >= len(args):
            raise CliError("%s needs a value" % name)
        v = args[i + 1]
        del args[i:i + 2]
        return v
    return default


def note_id(raw):
    nid = raw.lstrip("#").lower()
    if not ID_RE.fullmatch(nid):
        raise CliError("not a note id: %r (6 hex characters, e.g. 3fa9c1)" % raw)
    return nid


def today():
    return datetime.date.today().isoformat()


def for_agent(notes, name):
    return [n for n in notes if n["kinek"] in (name.lower(), "mindenki")]


def run(argv):
    if not argv:
        print(__doc__)
        return 2
    cmd, args = argv[0], list(argv[1:])

    if cmd == "lista":
        kinek = arg(args, "--kinek")
        notes = load()
        sel = for_agent(notes, kinek) if kinek else notes
        print("\n".join(fmt(n) for n in sel) or "(no lines)")
        return 0

    if cmd == "uj":
        ki = arg(args, "--ki")
        hatarido = arg(args, "--hatarido", "-")
        if len(args) != 2 or not ki:
            raise CliError('usage: uj KINEK "what" --ki NAME [--hatarido YYYY-MM-DD]')
        if hatarido != "-" and not DATE_RE.fullmatch(hatarido):
            raise CliError("--hatarido must be YYYY-MM-DD or -")
        payload = {"assignee": args[0].strip().lower(), "content": args[1].strip(), "created_by": ki}
        if hatarido != "-":
            payload["due_date"] = hatarido
        nid = api("POST", "/api/notes", payload)["id"]
        # read back: a lost write would otherwise look exactly like a successful one
        hit = [n for n in load() if n["id"] == nid]
        if not hit:
            raise CliError("line #%s is not on the list when read back" % nid)
        print("OK " + fmt(hit[0]))
        return 0

    if cmd == "torol":
        ki = arg(args, "--ki")
        ok = arg(args, "--ok", "done")
        if len(args) != 1 or not ki:
            raise CliError('usage: torol ID --ki NAME [--ok "why"]')
        nid = note_id(args[0])
        api("DELETE", "/api/notes/" + urllib.parse.quote(nid, safe=""), {"by": ki, "reason": ok})
        if any(n["id"] == nid for n in load()):
            raise CliError("line #%s is still active after the delete" % nid)
        print("OK deleted #" + nid)
        return 0

    if cmd == "lejart":
        t = today()
        sel = [n for n in load() if n["hatarido"] != "-" and n["hatarido"] <= t]
        print("\n".join(fmt(n) for n in sel) or "(nothing due)")
        return 0

    if cmd == "ertesit":
        dry = "--dry-run" in args
        args = [a for a in args if a != "--dry-run"]
        mikor = args[0] if args else ""
        if mikor not in ("reggel", "este"):
            raise CliError("usage: ertesit reggel|este [--dry-run]")
        main_id = main_agent_id()
        notes = load()
        agents = api("GET", "/api/agents")
        running = [a.get("name") for a in agents if a.get("running")]
        failed = []
        for name in [a.get("name") for a in agents]:
            if not name or name == main_id:
                continue
            mine = for_agent(notes, name)
            if not mine:
                continue
            ids = ", ".join("#" + n["id"] for n in mine)
            if name not in running:
                # not woken: a message to a stopped agent only fails an hour later.
                # Printed so the caller (and the evening close) can see who missed it.
                print(name, "NOT RUNNING, not sent: " + ids)
                continue
            lead = ("Morning review: %d line(s) on the Notes page are yours: %s." % (len(mine), ids)
                    if mikor == "reggel" else
                    "Evening review: delete what is done or no longer relevant among %s." % ids)
            text = ("[JEGYZETEK] " + lead +
                    "\nRead them: python3 ../../scripts/jegyzetek.py lista --kinek " + name +
                    "\nDelete one: python3 ../../scripts/jegyzetek.py torol ID --ki " + name + ' --ok "done"' +
                    "\nNew line: python3 ../../scripts/jegyzetek.py uj KINEK \"what\" --ki " + name +
                    " --hatarido YYYY-MM-DD")
            if dry:
                print("--- " + name + "\n" + text)
                continue
            r = subprocess.run(["bash", os.path.join(ROOT, "scripts", "agent-msg.sh"),
                                main_id, name, "-"], input=text, text=True,
                               capture_output=True)
            print(name, (r.stdout or r.stderr).strip())
            if r.returncode != 0:
                failed.append(name)
        if failed:
            print("FAIL: not sent to " + ", ".join(failed), file=sys.stderr)
            return 1
        return 0

    print(__doc__)
    return 2


def main(argv):
    try:
        return run(argv)
    except CliError as e:
        print("FAIL: " + str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
