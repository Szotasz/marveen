#!/usr/bin/env python3
"""Idempotent check + repair for the 2026-09-02 Telegram sub-agent reply fix.

Spec: ~/.claude/skills/telegram-subagent-reply-fix/SKILL.md. Two points are
guarded, because either one alone reproduces the bug (a sub-agent's answer
shows up only in its tmux pane, never on Telegram):

  1. scripts/hooks/channel-inbox-drain.py emits the drained inbox entry with
     source="plugin:telegram:telegram" (the live --channels format that every
     reply-forcing hook recognises), not source="telegram". Git-tracked, so an
     ./update.sh can revert it.
  2. agents/<name>/.claude/settings.json of every Telegram-capable sub-agent
     carries the same four hooks as the main agent's settings:
       UserPromptSubmit : ledger-capture.py, telegram-reply-directive.py
       PostToolUse      : ledger-outbound.py  (matcher mcp__plugin_telegram_telegram__reply)
       Stop             : telegram-reply-guard.py
     Not git-tracked, but a re-scaffold / profile rewrite regenerates them
     from the template, which only carries telegram-reply-directive.

Every hook entry this script writes is the fail-open wrapper with an ABSOLUTE
path (`bash -c '[ -f /abs/x.py ] && exec python3 /abs/x.py; exit 0'`), the
same form agent-scaffold.ts uses. It NEVER mirrors the main agent's
settings.json: that file spells its hooks as
`python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/x.py"`, and inside a sub-agent
session CLAUDE_PROJECT_DIR is agents/<name>/, where scripts/hooks/ does not
exist -- python3 then exits 2, which on UserPromptSubmit blocks the prompt and
leaves the agent deaf (measured 2026-09-24, all four sub-agents).

An entry counts as PRESENT only when it has that exact wrapper form AND its
path is this checkout's scripts/hooks/<script>. A bare $CLAUDE_PROJECT_DIR
form, an old-home absolute path or any other spelling is reported as BAD-FORM
and, in repair mode, replaced IN PLACE (same group, same index). A missing
entry is appended. Nothing else in the files is touched; a backup is written
before any write.

Output contract (parsed by the telegram-subagent-hook-check scheduled task):
  - one "OK ..." / "MISSING ..." / "BAD-FORM ..." / "repaired ..." line per check
  - last line "All clear." when nothing was (or is any longer) missing or bad
  - --check-only: report only, exit 1 when anything is missing or bad
  - repair mode: after repairing, print which agents to restart and the curl
    command (POST /api/agents/<name>/restart with {"fresh": true}; a
    --continue resume may come up without the channels plugin); exit 0

Usage:
  python3 scripts/hooks/telegram-subagent-reply-fix.py            # check + repair
  python3 scripts/hooks/telegram-subagent-reply-fix.py --check-only

REPLY_FIX_PROJECT_ROOT=<dir> overrides the project root (test harness only).

Recreated 2026-09-24 (Kígyó): the original was an untracked file that never
made it from the MacBook to the Mac mini (the 2026-09-24 update.sh auto-stash
trees hold no untracked files, so the update did not eat it). Restored from
the SKILL.md spec; kept untracked on purpose, like the original.
2026-09-24 pm (Kígyó, review K1/K2/F1/É1): dropped the main-settings mirror,
added form validation + in-place replace, restart via /restart fresh.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

# Sub-agents with their own Telegram bot. Add a name here when a new agent gets
# agents/<name>/.claude/channels/telegram/.env, then run this script.
TELEGRAM_SUBAGENTS = ["cella", "kigyo", "konnektor", "ordogugyved"]

PROJECT_ROOT = Path(os.environ.get("REPLY_FIX_PROJECT_ROOT") or Path(__file__).resolve().parents[2])
HOOKS_DIR = PROJECT_ROOT / "scripts" / "hooks"
DRAIN_PY = HOOKS_DIR / "channel-inbox-drain.py"
DASHBOARD_PORT = 3420
TOKEN_PATH = PROJECT_ROOT / "store" / ".dashboard-token"

DRAIN_BAD = "attrs = [('source', 'telegram')]"
DRAIN_GOOD = "attrs = [('source', 'plugin:telegram:telegram')]"

# (event, matcher or None, script basename, timeout). Timeouts follow the main
# agent's settings.json (15/10/15/10) so the fleet stays on one set of values.
REQUIRED_HOOKS = [
    ("UserPromptSubmit", None, "ledger-capture.py", 15),
    ("UserPromptSubmit", None, "telegram-reply-directive.py", 10),
    ("PostToolUse", "mcp__plugin_telegram_telegram__reply", "ledger-outbound.py", 15),
    ("Stop", None, "telegram-reply-guard.py", 10),
]

_SCRIPT_RE = re.compile(r"/scripts/hooks/([A-Za-z0-9_.-]+)")
# The one accepted form. Group 1 and 2 must be the same path (checked in code).
_WRAPPER_RE = re.compile(r"^bash -c '\[ -f (\S+) \] && exec (?:python3|bash) (\S+); exit 0'$")


def wrapper_command(script: str) -> str:
    """Fail-open form: a missing script makes the hook a silent no-op."""
    p = HOOKS_DIR / script
    return f"bash -c '[ -f {p} ] && exec python3 {p}; exit 0'"


def canonical_hook(script: str, timeout: int) -> dict:
    """Always the wrapper with an absolute path under THIS checkout. See the
    module docstring for why the main agent's settings are never mirrored."""
    return {"type": "command", "command": wrapper_command(script), "timeout": timeout}


def load_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def atomic_write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


def backup(path: Path) -> Path:
    bak = path.with_name(path.name + f".bak-{time.strftime('%Y%m%d-%H%M%S')}")
    bak.write_bytes(path.read_bytes())
    return bak


def script_names_in(command: str) -> set[str]:
    return set(_SCRIPT_RE.findall(command or ""))


def entry_state(command: str, script: str) -> str:
    """'ok' | 'bad' | 'absent' for one hook command against one required script."""
    if script not in script_names_in(command):
        return "absent"
    m = _WRAPPER_RE.match(command or "")
    if not m or m.group(1) != m.group(2):
        return "bad"  # bare $CLAUDE_PROJECT_DIR form, or any non-wrapper spelling
    if Path(m.group(1)) != HOOKS_DIR / script:
        return "bad"  # old home path, other checkout, typo
    return "ok"


# --- check 0: the hook scripts themselves ------------------------------------

def check_scripts() -> tuple[bool, list[str]]:
    """The wrapper is fail-open, so a missing script would hide silently."""
    lines = []
    ok = True
    for _event, _matcher, script, _timeout in REQUIRED_HOOKS:
        if not (HOOKS_DIR / script).is_file():
            ok = False
            lines.append(f"MISSING script: {HOOKS_DIR / script} does not exist (cannot repair; "
                         "the wrapper hook is a silent no-op until it is back)")
    return ok, lines


# --- check 1: channel-inbox-drain.py source attribute --------------------------

def check_drain(repair: bool) -> tuple[bool, str]:
    """Returns (ok, line)."""
    if not DRAIN_PY.exists():
        return False, f"MISSING drain: {DRAIN_PY} does not exist (cannot repair)"
    text = DRAIN_PY.read_text(encoding="utf-8")
    if DRAIN_GOOD in text:
        return True, "OK drain: channel-inbox-drain.py emits source=plugin:telegram:telegram"
    if DRAIN_BAD not in text:
        return False, ("MISSING drain: channel-inbox-drain.py has neither the fixed nor the known-bad "
                       "source line -- upstream changed the format, inspect _format_entry() by hand")
    if not repair:
        return False, "MISSING drain: channel-inbox-drain.py emits source=telegram (reverted)"
    bak = backup(DRAIN_PY)
    DRAIN_PY.write_text(text.replace(DRAIN_BAD, DRAIN_GOOD, 1), encoding="utf-8")
    return True, f"repaired drain: channel-inbox-drain.py source attr set to plugin:telegram:telegram (backup {bak.name})"


# --- check 2: per-agent settings.json hooks -----------------------------------

def check_agent(name: str, repair: bool) -> tuple[bool, list[str], bool]:
    """Returns (ok, lines, repaired)."""
    path = PROJECT_ROOT / "agents" / name / ".claude" / "settings.json"
    if not path.exists():
        return False, [f"MISSING {name}: {path} does not exist (agent not scaffolded?)"], False
    try:
        settings = load_json(path)
    except json.JSONDecodeError as exc:
        return False, [f"MISSING {name}: settings.json is not valid JSON ({exc}); not touching it"], False
    hooks = settings.get("hooks") or {}
    lines: list[str] = []
    # (event, matcher, script, timeout, group-or-None, index-or-None): group set
    # means "replace in place", None means "append".
    todo: list[tuple[str, str | None, str, int, dict | None, int | None]] = []
    for event, matcher, script, timeout in REQUIRED_HOOKS:
        label = f"{event}[{matcher}]" if matcher else event
        state = "absent"
        bad_loc: tuple[dict, int, str] | None = None
        for grp in hooks.get(event) or []:
            if (grp.get("matcher") or None) != matcher:
                continue
            for i, h in enumerate(grp.get("hooks") or []):
                s = entry_state(h.get("command", ""), script)
                if s == "ok":
                    state = "ok"
                    break
                if s == "bad" and bad_loc is None:
                    bad_loc = (grp, i, h.get("command", ""))
            if state == "ok":
                break
        if state == "ok":
            lines.append(f"OK {name}: {label} {script}")
            continue
        if bad_loc is not None:
            grp, i, cmd = bad_loc
            lines.append(f"BAD-FORM {name}: {label} {script} :: {cmd}")
            todo.append((event, matcher, script, timeout, grp, i))
        else:
            lines.append(f"MISSING {name}: {label} {script}")
            todo.append((event, matcher, script, timeout, None, None))
    if not todo:
        return True, lines, False
    if not repair:
        return False, lines, False
    bak = backup(path)
    hooks = settings.setdefault("hooks", {})
    for event, matcher, script, timeout, grp, i in todo:
        entry = canonical_hook(script, timeout)
        label = f"{event}[{matcher}]" if matcher else event
        if grp is not None and i is not None:
            grp["hooks"][i] = entry
            lines.append(f"repaired {name}: replaced {script} in {label} (bad form -> wrapper)")
            continue
        groups = hooks.setdefault(event, [])
        target = None
        for g in groups:
            if (g.get("matcher") or None) == matcher:
                target = g
                break
        if target is None:
            target = {"hooks": []}
            if matcher:
                target["matcher"] = matcher
            groups.append(target)
        target.setdefault("hooks", []).append(entry)
        lines.append(f"repaired {name}: added {script} to {label}")
    atomic_write_json(path, settings)
    lines.append(f"backup {name}: {bak}")
    return True, lines, True


def main(argv: list[str]) -> int:
    check_only = "--check-only" in argv
    repair = not check_only
    all_ok = True
    restart: list[str] = []

    ok, lines = check_scripts()
    for ln in lines:
        print(ln)
    all_ok = all_ok and ok

    ok, line = check_drain(repair)
    print(line)
    all_ok = all_ok and ok

    for name in TELEGRAM_SUBAGENTS:
        ok, lines, repaired = check_agent(name, repair)
        for ln in lines:
            print(ln)
        all_ok = all_ok and ok
        if repaired:
            restart.append(name)

    if restart:
        print(f"repaired: {', '.join(restart)} -- settings.json hooks load at session start, restart them "
              "(fresh: a --continue resume may come up without the channels plugin):")
        print(f"TOKEN=$(cat {TOKEN_PATH})")
        for name in restart:
            print(f"curl -s -X POST http://localhost:{DASHBOARD_PORT}/api/agents/{name}/restart "
                  f"-H \"Authorization: Bearer $TOKEN\" -H \"Content-Type: application/json\" "
                  f"-d '{{\"fresh\": true}}'")

    if all_ok:
        print("All clear.")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
