---
name: utemezett-feladat-eletciklus
description: Lifecycle of a scheduled task (~/.claude/scheduled-tasks, /api/schedules) -- writing a one-shot (dated cron) wake-up with scripts/egyszeri.py, measuring a late or missing run, re-pointing time-bound checks when a plan moves, and closing a one-shot that fired. Use when you write a one-shot wake-up or check, before you claim that a scheduled task "was late" or "did not run", when a release window or deadline moves, and when a fired one-shot has to be disabled.
---

# Scheduled task lifecycle

## When to use

- Writing a one-shot wake-up or check (a dated cron: `M H D Mo *`).
- Before claiming that the scheduler was late or did not fire.
- A plan change: a window or a deadline moves, and timed checks are still tied to the old time.
- Closing a one-shot that has fired.

## Procedure

0. **Write a one-shot with the script, not by hand.** From the install directory:
   `python3 scripts/egyszeri.py --name <name> --cron 'M H D Mo *' --agent <agent> --desc '<description>' --prompt-file <file> [--cleanup-by <own later one-shot>] [--dry-run]`
   In one step it creates the task, sets telegramChatId (a PUT after the POST, `none` by default), merges the entry
   into the schedule registry if the install keeps one (store/schedule-registry.json), appends the cleanup line to the
   `--cleanup-by` task for a sub-agent's one-shot, and reads everything back (API and disk). It refuses, writing
   nothing (exit 1): a cron that is not dated or already passed; Cyrillic homoglyphs or en/em dashes in the prompt; an
   existing name; a main-agent one-shot whose prompt has no `/toggle` step; a sub-agent prompt that calls
   `/api/schedules`; a sub-agent one-shot without `--cleanup-by`. Exit 2 means half-written (the task exists, a later
   step failed): finish that step by hand. forceSend is the default; `--no-force-send` only on purpose, never for a
   time-bound wake-up. The main agent's raw POST with a dated cron is denied by scripts/hooks/schedule-dated-post-gate.py.
1. **List before writing:** `GET /api/schedules?include=prompt` -- is there already a task for the same thing?
   (Fields: name, schedule, agent, enabled, skipIfBusy, forceSend, type, and the prompt when asked for. There is
   no last-run field.)
2. **The cron runs in the scheduler's time zone** (SCHEDULER_TZ, else TZ, else UTC). Check it before writing, and put
   the time in the description in both forms (the scheduler's zone and the reader's local time).
3. **A time-critical wake-up has to absorb the recipient's turn.** With `skipIfBusy: false` the runner retries while the
   target pane is busy or has pending input; it does not skip, but it is as late as the recipient's current turn is
   long. Put the wake-up earlier, or set forceSend (the prompt then enters the running turn like a mid-turn message).
   A deadline promised to a person is the limit of the send, not its time: the sending task goes before it.
4. **A dated cron is not a one-shot.** `10 5 11 9 *` fires every year on September 11. After it ran, read `enabled`
   first (GET, or the task-config.json on disk): if it is already false, do NOT toggle -- `POST
   /api/schedules/<name>/toggle` flips, so it would switch the task back on. Toggle only an enabled task; toggle, do
   not delete. The main agent's own one-shot may end with the toggle as its last step. A sub-agent cannot: its write to
   `/api/schedules` is denied by scripts/self-pace-gate.mjs. A sub-agent one-shot's last step is "report it in the
   result message", and a later one-shot of the main agent disables it (`--cleanup-by` writes that line).
5. **On a plan change, in the same turn,** list the timed checks that depend on the old time, and disable or rewrite
   the ones whose premise is gone. A stale check sends someone a contradicting message about a question already
   answered.
6. **A prompt that sends something** measures and reports the send result (the message id, or the error caught). "Send
   it" alone gives a run that looks done while the recipient received nothing.
7. **A sub-agent's future window needs a trigger written by the main agent** in the same turn: a sub-agent cannot
   schedule itself, so an agreed "starts tomorrow at 05:00" without a trigger does not slip, it does not happen.
8. **Write the premise into the one-shot's prompt** ("this runs because X"). When X is decided or gone, rewrite the
   prompt (`PUT /api/schedules/<name>` with `{"prompt": ...}`) or disable the task at once, not when it fires.

## Pitfalls

- **The create call keeps only some fields.** `POST /api/schedules` stores name, description, prompt, schedule, agent,
  type, skipIfBusy, forceSend and targetSession; telegramChatId and preCheck are dropped. Set them with
  `PUT /api/schedules/<name>` before the first tick, and read task-config.json back.
- **Where a run reports** (src/web/schedule-runner.ts, resolveTaskChannelTarget): telegramChatId `none` means no chat
  target; a pinned telegramChatId is used as it is; otherwise the main agent's task goes to the install default
  (SCHEDULED_DELIVERY_CHANNEL) if one is set, and any other task to the agent's own bound channel, where two or more
  DM contacts make the runner refuse to pick one (it does not guess). Use `none` for a quiet task or one whose prompt
  names its own recipients, and a chat id for a task bound to one chat.
- **A `task` type run is prefixed with an instruction to report the result to that resolved chat.** For a one-shot meant
  for another person, pin that person's chat in telegramChatId, or use `heartbeat` and name the recipient in the prompt.
- **A fired and done run is not proof that the work happened.** A session that is rate-limited answers with one line,
  and the runner books the run as done. The proof is the run's own product: a comment, a message id, a life-sign file.
- **A run row with delivery `not-arrived`** is not proof either way: a prompt typed into a busy session can arrive as a
  queued command. Before redoing the step by hand, look for its trace (comment, message id) or you run it twice.
- **The run log is not in the task directory.** The runner writes `store/dashboard.log`: "Scheduled task fired",
  "... will retry", "Scheduled task toggled". Strip the ANSI color codes before grep. `GET
  /api/schedules/<name>/runs` lists recent runs (fired or skipped, with the outcome).
- **skipIfBusy: true drops ticks while the recipient works,** and records them as skipped. A stale life-sign alone is
  not a finding: fired with no life-sign after it means the run died; only skipped rows mean busy; no rows at all
  means the scheduler did not start it.
- **The preCheck contract** (src/web/schedule-runner.ts, runPreCheck): stdout exactly `SKIP` means no model turn; any
  other output is prefixed to the prompt; a non-zero exit, a timeout or a missing script lets the model run (fail
  open). The pre-check also runs on the retry path, while the task's own pending retry row exists: a "skip if a retry
  is pending" gate drops the task's own retry.
- **A pre-check guard cannot disable itself on an event it does not watch.** If the expiry event is independent of the
  watched state, put the expiry into the pre-check (print an EXPIRED line instead of SKIP), or disable it by hand when
  the event happens.
- **Disabling:** `PUT /api/schedules/<name>` with `{"enabled": false}`, or the toggle (see 4). The proof is the disk:
  task-config.json `enabled` is false.
- **The prompt has one source:** the task's SKILL.md (task-config.json has no prompt field). A prompt over the size
  limit is refused; keep prompts short and point to files.
- **A fact sentence written into a one-shot in advance** has to be measured again when it is sent; name the source
  (the card, the decision) in the prompt, not the finished sentence.
- **A one-shot that depends on another agent's answer:** send the request in the same step, and put its message id
  into the prompt; without it the one-shot waits for a request that was never sent.
- **A conditional "later" branch in a one-shot is a new commitment.** Name the later task that carries it, or write one.
- **Time gates inside a prompt** use the clock of the agent that runs it (`date`), in one zone, with slack for the
  runner's delay.
- **A one-shot whose condition was met before it fired** has to be disabled at once, or it repeats the action.
- **Do not build the request body with `curl -d "$(python3 -c ...)"`.** Quotes and parentheses in the prompt break the
  shell; write the JSON to a file with a script and send it with `curl --data-binary @file`, then read the task back.
- **Do not write the scheduler's SQLite table directly;** the file-based tasks and the API are the path.

## Checks

- After disabling: `GET /api/schedules` shows `enabled: false`, and so does the task-config.json on disk.
- Lateness: the first "will retry" line versus the "fired" line in store/dashboard.log; the difference is the
  recipient's turn, not the scheduler.
- A registry entry (if the install keeps one) is updated by merge, never replaced: back the file up first, then read the
  old note back.
