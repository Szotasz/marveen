#!/usr/bin/env python3
"""jegyzetek.py -- the team's NOTES page ("Jegyzetek") on the dashboard.

WHY: small "I'll check it tomorrow" items were slipping through: too small for a card
of their own, and lost once they lived only in a chat message. The owner's idea
(Telegram msg 4149, 2026-09-26): one list with who / what / written on / due; everyone
reads it morning and evening and deletes the line when it is done or no longer relevant.
It started as a standing kanban card; the owner asked for a separate page instead so the
board stays uncluttered (msg 4153). The data lives in /api/notes (team_notes table), and
the dashboard shows it under Kanban as "Jegyzetek".

`kinek` is an agent name, `gazda`, or `mindenki`. Deletion is soft: who, when and why
stay visible on the page for 7 days, so nothing vanishes silently.

Usage:
    python3 scripts/jegyzetek.py lista [--kinek NEV]
    python3 scripts/jegyzetek.py uj KINEK "mit" [--hatarido YYYY-MM-DD] [--ki NEV]
    python3 scripts/jegyzetek.py torol ID [--ok "miert"] [--ki NEV]
    python3 scripts/jegyzetek.py lejart            # due today or earlier
    python3 scripts/jegyzetek.py ertesit reggel|este [--dry-run]

`ertesit` sends each RUNNING sub-agent that has lines (own or `mindenki`) one
inter-agent message with its lines and the delete command. Agents with nothing on the
list are NOT woken; a stopped agent with lines is printed as NEM FUT. marveen is
skipped: the morning brief and the evening close read the list themselves.
"""
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://localhost:%s" % os.environ.get("MARVEEN_WEB_PORT", "3420")
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def token():
    with open(os.path.join(ROOT, "store", ".dashboard-token")) as f:
        return f.read().strip()


def api(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        sys.exit("FAIL: %s %s -> HTTP %s %s" % (method, path, e.code, e.read().decode()[:300]))


def load():
    notes = []
    for r in api("GET", "/api/notes"):
        notes.append({"id": r["id"], "kinek": r["assignee"], "mit": r["content"],
                      "felirva": datetime.datetime.fromtimestamp(r["created_at"]).date().isoformat(),
                      "hatarido": r.get("due_date") or "-"})
    return notes


def fmt(n):
    return "- #%s | %s | %s | felirva %s | hatarido %s" % (
        n["id"], n["kinek"], n["mit"], n["felirva"], n["hatarido"])


def arg(args, name, default=None):
    if name in args:
        i = args.index(name)
        v = args[i + 1]
        del args[i:i + 2]
        return v
    return default


def today():
    return datetime.date.today().isoformat()


def for_agent(notes, name):
    return [n for n in notes if n["kinek"] in (name, "mindenki")]


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    cmd, args = argv[0], list(argv[1:])

    if cmd == "lista":
        kinek = arg(args, "--kinek")
        notes = load()
        sel = for_agent(notes, kinek.lower()) if kinek else notes
        print("\n".join(fmt(n) for n in sel) or "(nincs sor)")
        return 0

    if cmd == "uj":
        ki = arg(args, "--ki", "marveen")
        hatarido = arg(args, "--hatarido", "-")
        if len(args) != 2:
            sys.exit("hasznalat: uj KINEK \"mit\" [--hatarido EEEE-HH-NN]")
        if hatarido != "-" and not DATE_RE.fullmatch(hatarido):
            sys.exit("a hatarido alakja EEEE-HH-NN vagy -")
        payload = {"assignee": args[0].lower(), "content": args[1].strip(), "created_by": ki}
        if hatarido != "-":
            payload["due_date"] = hatarido
        nid = api("POST", "/api/notes", payload)["id"]
        # read back: a lost write would otherwise look exactly like a successful one
        hit = [n for n in load() if n["id"] == nid]
        if not hit:
            sys.exit("FAIL: a #%s sor visszaolvasva nincs a listan" % nid)
        print("OK " + fmt(hit[0]))
        return 0

    if cmd == "torol":
        ki = arg(args, "--ki", "marveen")
        ok = arg(args, "--ok", "kesz")
        if len(args) != 1:
            sys.exit("hasznalat: torol ID [--ok \"miert\"]")
        nid = args[0].lstrip("#")
        api("DELETE", "/api/notes/" + nid, {"by": ki, "reason": ok})
        if any(n["id"] == nid for n in load()):
            sys.exit("FAIL: a #%s sor torles utan is aktiv" % nid)
        print("OK torolve #" + nid)
        return 0

    if cmd == "lejart":
        t = today()
        sel = [n for n in load() if n["hatarido"] != "-" and n["hatarido"] <= t]
        print("\n".join(fmt(n) for n in sel) or "(nincs lejart sor)")
        return 0

    if cmd == "ertesit":
        dry = "--dry-run" in args
        args = [a for a in args if a != "--dry-run"]
        mikor = args[0] if args else ""
        if mikor not in ("reggel", "este"):
            sys.exit("hasznalat: ertesit reggel|este")
        notes = load()
        agents = api("GET", "/api/agents")
        running = [a.get("name") for a in agents if a.get("running")]
        for name in [a.get("name") for a in agents]:
            if name == "marveen":
                continue
            mine = for_agent(notes, name)
            if not mine:
                continue
            if name not in running:
                # not woken: a message to a stopped agent only fails an hour later.
                # Printed so the caller (and the evening close) can see who missed it.
                print(name, "NEM FUT, nem kapta meg: " + ", ".join("#" + n["id"] for n in mine))
                continue
            lead = ("Reggeli atnezes: ezek a sorok allnak rad a Jegyzetek oldalon."
                    if mikor == "reggel" else
                    "Esti atnezes: ami ezekbol kesz vagy mar nem aktualis, TOROLD.")
            text = ("[JEGYZETEK] " + lead + "\n" + "\n".join(fmt(n) for n in mine) +
                    "\nTorles (a sajat mappadbol):"
                    " python3 ../../scripts/jegyzetek.py torol ID --ki " + name + " --ok \"kesz\"\n"
                    "Uj sor: python3 ../../scripts/jegyzetek.py uj KINEK \"mit\" --hatarido EEEE-HH-NN --ki " + name)
            if dry:
                print("--- " + name + "\n" + text)
                continue
            r = subprocess.run(["bash", os.path.join(ROOT, "scripts", "agent-msg.sh"),
                                "marveen", name, "-"], input=text, text=True,
                               capture_output=True)
            print(name, (r.stdout or r.stderr).strip())
        return 0

    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
