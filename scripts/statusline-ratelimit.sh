#!/bin/bash
# Claude Code statusLine command -- and, as a side effect, the fleet's only
# token-free source of truth about the subscription quota.
#
# WHY THIS EXISTS: the owner asked to be warned when the 5-hour or the weekly
# Claude quota runs out. The agent itself cannot report that -- it is the one
# without tokens -- so the warning has to come from outside Claude. Scraping the
# tmux pane for banner wording is guesswork (measured 2026-08-18: the wordings
# closest to the question did not match), but Claude Code hands the statusLine
# command a JSON payload that ALREADY carries the numbers:
#
#   rate_limits.five_hour.{used_percentage,resets_at}
#   rate_limits.seven_day.{used_percentage,resets_at}
#
# (Optional block: present only for subscription accounts, after the first API
# response of a session.) This script stores that block in
# store/.claude-rate-limits.json on every render, costing zero tokens, and
# scripts/limit-monitor.sh -- a plain systemd timer, no Claude involved --
# reads the file and alerts the owner.
#
# Contract: stdin = payload JSON, stdout = one status line. Never fails loudly:
# a broken status line would be visible in every pane forever.

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$INSTALL_DIR/store/.claude-rate-limits.json"

PAYLOAD="$(cat)"

printf '%s' "$PAYLOAD" | RL_OUT="$OUT" python3 -c '
import json, os, sys, time

out = os.environ["RL_OUT"]
try:
    d = json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit(0)

model = (d.get("model") or {}).get("display_name") or ""
cw = d.get("context_window") or {}
used = cw.get("used_percentage")
rl = d.get("rate_limits") or {}

# Persist the quota block for the out-of-Claude monitor. Written only when the
# payload actually carries it: an empty write would look like a fresh, healthy
# reading and would silently disarm the alert.
if rl:
    rec = {
        "written_at": int(time.time()),
        "session_id": d.get("session_id"),
        "cwd": d.get("cwd"),
        "rate_limits": rl,
    }
    tmp = out + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(rec, f)
        os.replace(tmp, out)
    except Exception:
        pass

parts = []
if model:
    parts.append(model)
if isinstance(used, (int, float)):
    parts.append("ctx %d%%" % round(used))
for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
    w = rl.get(key) or {}
    p = w.get("used_percentage")
    if isinstance(p, (int, float)):
        parts.append("%s %d%%" % (label, round(p)))
print(" | ".join(parts))
' 2>/dev/null || printf ''
