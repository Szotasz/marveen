#!/usr/bin/env python3
"""Find hooks that run TWICE because the same script is registered under two spellings.

Measured on this machine 2026-09-05 with a two-scope probe:

  identical command string in the user scope and the project scope -> fires ONCE
  different command strings pointing at the SAME script            -> fires TWICE

Claude Code dedupes hooks by the exact command string, so a script registered as
`python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/x.py"` in one scope and as the
fail-open wrapper `bash -c '[ -f /abs/x.py ] && exec python3 /abs/x.py; exit 0'`
in the other runs twice on every matching event: two process spawns, and for a
gate that injects context, two copies of the injection. That is exactly how the
provenance gate came to print two identical PROVENANCE-KAPU blocks for one prompt
(2026-09-04), and the duplicate survived a manual delete because the scaffold
merged it back on the next dashboard start.

A session loads the user scope ($CLAUDE_CONFIG_DIR/settings.json, else
~/.claude/settings.json) AND the project scope (<cwd>/.claude/settings.json), so
this checks each agent's pair, plus duplicates INSIDE one file.

Exit 0 = nothing runs twice. Exit 1 = at least one double-run found.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT_RE = re.compile(r'/([^/\s"\']+\.(?:py|mjs|js|sh))')


def registrations(path):
    """{(event, script_basename): set(command strings)} for one settings file."""
    out = {}
    if not os.path.exists(path):
        return out
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return out
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return out
    for event, entries in hooks.items():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for hook in entry.get("hooks") or []:
                command = (hook or {}).get("command")
                if not isinstance(command, str):
                    continue
                m = SCRIPT_RE.search(command)
                if not m:
                    continue
                out.setdefault((event, m.group(1)), set()).add(command)
    return out


def scope_pairs():
    """(label, user_scope, project_scope) for every session this install starts."""
    pairs = [("main agent", os.path.expanduser("~/.claude/settings.json"),
              os.path.join(ROOT, ".claude", "settings.json"))]
    agents_dir = os.path.join(ROOT, "agents")
    for name in sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []:
        base = os.path.join(agents_dir, name)
        if not os.path.isdir(base):
            continue
        pairs.append((name, os.path.join(base, ".claude-config", "settings.json"),
                      os.path.join(base, ".claude", "settings.json")))
    # Worker sessions live outside the repo (~/.<agent>-worker), and they are
    # started with their own CLAUDE_CONFIG_DIR just like the sub-agents.
    home = os.path.expanduser("~")
    for name in sorted(os.listdir(home)):
        if not name.startswith(".") or "-worker" not in name:
            continue
        base = os.path.join(home, name)
        user = os.path.join(base, ".claude-config", "settings.json")
        project = os.path.join(base, ".claude", "settings.json")
        if os.path.exists(user) or os.path.exists(project):
            pairs.append((name, user, project))
    return pairs


def parse_overrides(argv):
    """--pair label:user:project -- explicit scope pairs instead of discovery.

    Exists so the audit is testable against fixtures without touching the
    operator's real ~/.claude, and so an operator can point it at one session.
    """
    pairs = []
    for arg in argv:
        if not arg.startswith("--pair="):
            continue
        parts = arg[len("--pair="):].split(":")
        if len(parts) != 3:
            raise SystemExit("bad --pair, expected label:user:project -- got " + arg)
        pairs.append((parts[0], parts[1], parts[2]))
    return pairs


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    pairs = parse_overrides(argv) or scope_pairs()
    findings = []
    for label, user, project in pairs:
        u, p = registrations(user), registrations(project)
        for key in sorted(set(u) & set(p)):
            if u[key] != p[key]:
                findings.append((label, key[0], key[1], "ket scope, elteru parancsszoveg"))
        for scope_path, regs in ((user, u), (project, p)):
            for key, commands in sorted(regs.items()):
                if len(commands) > 1:
                    findings.append((label, key[0], key[1],
                                     "egy fajlon belul tobbszor: " + os.path.basename(scope_path)))
    for label, event, script, why in findings:
        print("KETSZER FUT  %-14s %-18s %s  (%s)" % (label, event, script, why))
    if findings:
        print("\n%d hook fut ketszer. Egy scriptet egyetlen parancsszoveggel kell "
              "regisztralni, vagy csak az egyik scope-ban." % len(findings))
        return 1
    print("Nincs ketszer futo hook (%d session-part ellenorizve)." % len(pairs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
