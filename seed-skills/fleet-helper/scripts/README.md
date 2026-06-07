# fleet-helper

Shared, dependency-free Python helpers for a ClaudeClaw-style agent fleet. The
goal: do deterministic work (fetch / filter / SQL / format / escape) in Python
instead of burning model tokens doing it inside the LLM turn. Python 3 stdlib
only.

No secrets or personal data are baked in: the dashboard token is read from
`store/.dashboard-token` at call time, paths come from `CLAW_DIR` (or are
auto-detected), and any personal sender/keyword lists live in a gitignored
`mail_rules.json` (see `mail_rules.example.json`).

## fleet.py - dashboard API + kanban + MarkdownV2
CLI (fewer tokens than a curl block) or import as a module:

```bash
python3 fleet.py mdv2 "Tomorrow (8:00) - report!"   # escaped MarkdownV2
python3 fleet.py mem-save  <agent> "text" warm "k1, k2"
python3 fleet.py mem-search <agent> "query" warm
python3 fleet.py msg <from> <to> "message"
python3 fleet.py agents
python3 fleet.py kanban-due | kanban-stuck <sec> | kanban-status <status>
```

MarkdownV2: `escape_mdv2()` escapes literal text. Escape the dynamic text first,
then add your own `*...*` bold markers around the escaped pieces.

## mail_triage.py - rule-based unread-mail filter (macOS Mail.app)
Auth-free (osascript), returns JSON, never sends and never marks read. Buckets:
`important` / `review` / `dropped`. Real senders/keywords go in `mail_rules.json`.

## The heartbeat gate pattern (the interesting part)

Frequent agent "heartbeats" (periodic checks every N minutes) often wake the LLM
just to run deterministic checks (read mail, query a DB, scan a calendar) and
then decide there's nothing to report. That is mostly wasted tokens.

The naive fix - "skip the LLM turn when nothing changed" - can be unsafe: if your
channel transport (e.g. a Telegram MCP server over a stdio pipe) relies on the
agent making a periodic local tool call to stay connected, skipping the turn
entirely lets the pipe go idle and disconnect (losing inbound messages).

The pattern that captures the savings WITHOUT that risk:

1. Keep the heartbeat turn, but make it cheap. The heartbeat's mandatory first
   action is to run a single `gate.py` via the shell. **That one Bash call IS the
   keep-alive local tool call** - the transport stays warm.
2. `gate.py` does all the deterministic checks (mail filter, kanban SQL, calendar
   scan) outside the model and prints a compact JSON with a `has_signal` flag.
3. If `has_signal == false`: the model writes one short line and stops. No
   external message, and crucially no in-model AppleScript / SQL / filtering.
4. If `has_signal == true`: the model only does the judgment (is this worth
   surfacing? phrase it) and sends the notification.

The token saving does not come from skipping the turn (the keep-alive call was
already mandatory) - it comes from replacing "LLM reasons through
AppleScript+SQL+filtering each cycle" with "LLM runs one gate + reads a tiny
JSON". Zero changes to the scheduler/runner core are required: it is purely a
heartbeat-prompt rewrite plus the gate script.

Scheduling caveats (learned the hard way in a live test):

1. **Avoid cron collisions with other heartbeats.** If two heartbeats land in the
   same minute in the same session, one consistently loses (gets absorbed by the
   other's turn) and its cycle silently never runs. A `*/30` task (:00,:30)
   always collides with a `*/15` task (:00,:15,:30,:45). Do NOT schedule a gated
   heartbeat on :00/:15/:30/:45 (or any minute another heartbeat uses) - pick
   offset minutes, e.g. `7,23,37,53 * * * *`. This was the actual reason our
   first three live cycles never fired - not `skipIfBusy`.
2. **`skipIfBusy`:** a gated heartbeat still needs its turn to run for the
   keep-alive to fire. With `skipIfBusy:true`, a busy session can drop the cycle
   entirely. Where the keep-alive matters, prefer `skipIfBusy:false` (queue the
   prompt); the per-cycle work is cheap by design, so queuing is harmless.

`gate_example.py` is a reference gate (mail + kanban + calendar) you can adapt.

## Layout
```
fleet.py                 # shared lib + CLI
mail_triage.py           # unread-mail filter
gate_example.py          # reference heartbeat gate (keep-alive == the gate call)
mail_rules.example.json  # copy to mail_rules.json (gitignored) with real values
```

## Safety notes
- Token is read from `store/.dashboard-token` at call time. Never print or commit it.
- Kanban helpers are READ-ONLY; mutations stay in your own audited flows.
- `mail_rules.json` (your real senders) must be gitignored (see `.gitignore`).

## License
MIT, consistent with the parent project (ClaudeClaw / marveen).
