---
name: fleet-helper
description: Shared, dependency-free Python helpers for the agent fleet - dashboard API (memory, messages, kanban), Telegram MarkdownV2 escaping, and rule-based Mail.app triage. Use to do deterministic work (fetch/filter/SQL/format/escape) in Python instead of burning model tokens doing it in the LLM turn. The dashboard token is read from store/.dashboard-token at call time, never hardcoded.
---

# fleet-helper

Move deterministic work (fetch / filter / SQL / format / escape) out of the model
and into Python, so heartbeats and scheduled tasks stop spending tokens
re-deriving the same plumbing each cycle. Python 3 stdlib only, no pip deps.

No secrets or personal data are baked in: the dashboard token is read from
`store/.dashboard-token` at call time, the project root comes from `CLAW_DIR`
(or is auto-detected), and any personal sender/keyword lists live in a gitignored
`mail_rules.json` (see `scripts/mail_rules.example.json`).

## When to use
- Saving/searching memory, posting daily-log, sending inter-agent messages.
- Reading kanban (due today / stuck / by status) without writing SQL by hand.
- Escaping text for a Telegram MarkdownV2 message.
- An email heartbeat: pre-filter unread mail to a compact JSON before the model
  reasons about it.
- Building a token-cheap heartbeat gate (see "The heartbeat gate pattern" below).

## Scripts
- `scripts/fleet.py` - dashboard API + kanban read helpers + MarkdownV2 escaper
  (CLI and importable module).
- `scripts/mail_triage.py` - rule-based unread Mail.app filter (macOS), JSON out,
  never sends and never marks read.
- `scripts/gate_example.py` - reference heartbeat gate; its shell invocation IS
  the mandatory keep-alive tool call (the LLM turn is not skipped, just cheap).
- `scripts/mail_rules.example.json` - copy to `mail_rules.json` (gitignored) with
  your real senders/keywords.
- `scripts/README.md` - full usage and the heartbeat gate pattern write-up.

## Quick start
```bash
P=seed-skills/fleet-helper/scripts
python3 $P/fleet.py mdv2 "Tomorrow (8:00) - report!"   # escaped MarkdownV2
python3 $P/fleet.py kanban-due
python3 $P/mail_triage.py 90                            # unread <= 90 min -> JSON
```

## The heartbeat gate pattern (the high-value idea)
Frequent heartbeats often wake the model just to run deterministic checks and
then stay silent - wasted tokens. Naively skipping the turn can be unsafe if your
channel transport (e.g. a Telegram MCP over a stdio pipe) relies on a periodic
local tool call to stay connected. The safe pattern: keep the turn but make it
cheap - the heartbeat's first action runs a `gate.py` via the shell (that one
Bash call IS the keep-alive), the gate does the deterministic checks and prints a
`has_signal` flag; on `false` the model writes one line and stops, on `true` it
only does the judgment + notification. Zero scheduler/runner changes. See
`scripts/README.md` for the full rationale and two hard-won scheduling lessons
(avoid cron collisions with other heartbeats; `skipIfBusy` trade-off).

## Safety
- Token is read from `store/.dashboard-token` at call time; never printed or committed.
- Kanban helpers are READ-ONLY; mutations stay in your own audited flows.
- `mail_rules.json` (your real senders) is gitignored.
