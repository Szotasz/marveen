# Slack "working…" progress indicator

A Slack counterpart of [`telegram-progress-indicator.md`](telegram-progress-indicator.md):
a lightweight, plugin-independent "the agent is working…" indicator, plus a
watchdog (sentry) that turns a stuck turn into a clear error. Built entirely
with Claude Code hooks + a standalone watchdog, so it needs **no changes to
the Slack channel plugin** and survives plugin updates.

## Why

Slack's modern Web API (`chat.postMessage`) has no bot "typing…" bubble -
that only ever existed on the legacy RTM API (a `type: typing` websocket
frame), which new Slack apps have not been allowed to use for years. So the
official Slack channel plugin cannot show one either. The fix is the exact
same one already built for Telegram: post an honest, persistent placeholder
instead of a fake, expiring "typing" signal.

1. Message received -> a visible `✍️ Dolgozom rajta…` placeholder appears
   (in the same thread as the inbound message, if any).
2. Answer sent -> the placeholder is deleted and the real reply lands as a
   fresh `chat.postMessage` call.
3. Turn never completes (agent crashed / wedged / unreachable) -> the
   placeholder is rewritten into a clear error, so the user always gets
   **either an answer or an explicit failure**.

## Design choice: delete + repost, not edit-in-place

Slack has two ways to remove/replace the placeholder: `chat.update` (edit in
place) or `chat.delete` + a fresh `chat.postMessage`. This deliberately uses
**delete + repost for the real answer**, not edit-in-place:

- A `chat.update` edit does **not** push a notification in Slack (silent,
  no highlight/badge) - using it for the final answer would mean the user's
  answer arrives invisibly, same failure mode the Telegram doc rejected the
  "typing…" action for (looks fine in the log, useless in practice).
- `chat.postMessage` for the real answer always lands as a normal, notifying
  message.

`chat.update` is still used, deliberately, for the **watchdog's error
rewrite**: that is a backstop condition, not the normal path, so silence is
acceptable there (the placeholder itself already got the user's attention).

## How it works

Four small stdlib-Python pieces, mirroring the Telegram set exactly. Token +
state dir are resolved exactly like the plugin: `SLACK_STATE_DIR` if set
(per-agent), else the install-scoped `<install>/.claude/channels/slack` once
it holds the `.env` (#915), else the legacy shared `~/.claude/channels/slack`.
So each piece stays correct per-agent.

| Piece | Trigger | Job |
|-------|---------|-----|
| `slack_progress.py` | `UserPromptSubmit` hook | If the prompt contains a Slack `<channel … source="plugin:slack-channel:slack" chat_id … >` block, post the placeholder (in-thread via `thread_ts` if present) and record its `ts` in a per-session state file. |
| `slack_progress_reply_clear.py` | `PostToolUse` hook (matcher `slack.*reply`) | Delete the placeholder(s) for the replied `(chat_id, thread_ts)` the instant a reply is sent. **Primary clear path.** A `chat.delete` that fails retryably keeps the entry, marked `replied` (see below). |
| `slack_progress_clear.py` | `Stop` hook | Delete any placeholder still recorded at turn end, **and enforce delivery** (same one-nudge-then-fallback contract as the Telegram Stop hook). `replied` entries are outside the enforcement; their delete is only retried. |
| `slack_progress_watchdog.py` | launchd / systemd, ~60s | Scan every agent's per-agent state dir; for an orphan (agent down + placeholder old, OR a hung reply-tool call, OR a generic wedged backstop) either deliver the recovered answer for real, or rewrite the placeholder into the error text via `chat.update`. For a `replied` entry: retry the delete on every tick, deliver nothing. |

### Why the thread is part of the key - and why loosely

Telegram's `chat_id` already identifies a single DM or group, so matching on
it alone is precise. A Slack **channel** can have several concurrent threads
in flight, each with its own placeholder - matching on `chat_id` alone in the
reply-clear hook could delete the wrong thread's placeholder. So the thread
takes part in the key.

Strict equality on the pair was wrong, though: a legitimate reply often
carries a `thread_ts` that is not byte-equal to the inbound block's. An
install's outbound rules may tell the agent to answer a threaded inbound
**without** `thread_ts`; the optional parameter is sometimes passed as `""`;
and a reply threaded *under the inbound message itself* carries that
message's `ts`, which the entry never used to record. Every one of those
missed, left the placeholder pending, and drove the Stop hook into the
duplicate-reply + transcript-dump cascade (the `slack-progress-hook-loop`
incident).

The hook therefore filters by `chat_id` first, then narrows by thread in
three tiers, taking the first non-empty one:

1. **exact** - same thread, or threaded under the inbound message
   (`thread_ts` equals the entry's `src_ts`, now recorded by
   `slack_progress.py`);
2. **loose** - either side is top-level (`""` and missing both normalise to
   `None`);
3. **fallback** - nothing matched but this chat has pending placeholders; a
   reply to the chat is still the answer to that turn.

The asymmetry is deliberate. Clearing one placeholder too eagerly removes a
"working on it" marker; leaving one behind corrupts the conversation with a
duplicate reply and a raw transcript. Contract test:
`scripts/__tests__/slack-reply-clear.test.sh`.

### A failed `chat.delete` is not a cleared placeholder (`replied` entries)

The reply-clear hook used to take the entry out of the pending file whatever
`chat.delete` said -- the exception was swallowed, and Slack's HTTP-200
`{"ok": false}` was never looked at. After a rate limit or a network blip the
placeholder stayed in Slack while the file, the only thing the Stop hook and
the watchdog read, no longer knew about it: a permanent "working on it…"
under an answered message.

Simply keeping the entry would have been worse than the bug. An unmarked
leftover means *"no reply was sent"* to the Stop hook -- it blocks the turn, the
agent answers a second time, the transcript follows -- and the watchdog would
re-post the recovered answer on top. So the hook's `api()` now raises on an
`ok:false` envelope, the failure is classified like the watchdog's, and a kept
entry is **marked**:

| `chat.delete` outcome | Entry |
| --- | --- |
| deleted | dropped |
| **terminal** rejection (`message_not_found`, `channel_not_found`, `cant_delete_message`, `invalid_auth`, ...) | dropped, the Slack error goes to `debug.log` -- waiting cannot help |
| **retryable** failure (HTTP 429 / 5xx, connection error or timeout, `ratelimited`, `internal_error`, `service_unavailable`, `fatal_error`, `request_timeout`) | **kept, with `"replied": true`** |

`replied` means *the answer went out, only the cleanup is owed*, and every
reader treats it as delete-only:

- **reply-clear hook**: a `replied` leftover takes no part in the tier matching
  above. A top-level leftover is an *exact* match for a top-level reply and
  would otherwise win the tier alone, shadowing the live placeholder of the
  turn actually being answered. Its delete is simply retried whenever its chat
  is replied to again.
- **Stop hook**: never enforces on it -- no block, no fallback delivery. It
  retries the delete after the delivery work (so a slow Slack cannot eat the
  budget of the part that matters; not at all on the Stop that blocks), and a
  second retryable failure leaves the entry in the file.
- **watchdog**: retries the delete on every tick, at any age and whatever the
  agent's state, and never posts an answer or an error rewrite for it.
  Retryable keeps it (mtime preserved), terminal drops it, the 24h stale bound
  caps the retries. Because such a marker can belong to a *live* session, the
  watchdog re-reads the marker right before it writes (`settle()`): a
  placeholder the submit hook appended during the API calls is never
  overwritten.

Contract: the failed-delete cases of `scripts/__tests__/slack-reply-clear.test.sh`
(its stub now has the same failure injection as the watchdog suite's -- it
could only say `ok:true` before, which is what hid this) and cases (t)-(x) of
`scripts/__tests__/slack-watchdog-wedged.test.sh`.

### Reply enforcement

Same contract as Telegram: if the turn ends with a placeholder still
pending, the `Stop` hook blocks once and instructs the agent to call the
Slack `reply` tool properly; if it still doesn't, the agent's last transcript
answer is delivered as a guaranteed fallback via `chat.postMessage`.

### Watchdog guards (TGORPHAN908, shared with Telegram)

- **Stale upper bound**: a placeholder older than 24h (`SLACK_WATCHDOG_STALE_SEC`)
  marks a dead round, not a stuck one. Nothing is delivered; the marker is
  dropped and the placeholder message deleted. Without this, a fleet restart
  after a long outage walked weeks-old orphans into the backstop and posted
  internal work logs to the owner's channel.
- **Round-scoped answer**: the recovered answer is read only from the round
  that posted the placeholder (anchored on the timestamped user prompt at the
  marker's mtime), never from a later internal turn's text.
- **Already delivered**: if that round's own `reply` call did return a result,
  the marker is leftover bookkeeping - the placeholder is cleared silently,
  nothing is resent.

### Delivery failures (Slack-specific, not shared with Telegram)

Slack reports application errors as **HTTP 200 + `{"ok": false, "error":
"..."}`**; the Telegram Bot API uses HTTP 4xx, which `urlopen` raises on by
itself. A straight port therefore treated a rejected `chat.postMessage` as
delivered: `delivered=real-answer` in the log, placeholder deleted, marker
dropped -- the user got neither the answer nor an error, and nothing said so.
The watchdog's `api()` now raises on an `ok:false` envelope, and every
failure is classified:

| Class | What | Watchdog reaction |
| --- | --- | --- |
| **retryable** | HTTP 429 / 5xx, connection errors and timeouts, Slack `ratelimited`, `internal_error`, `service_unavailable`, `fatal_error` | nothing reached Slack: the placeholder is untouched and the **marker is kept** (with only the entries that failed, and with its mtime preserved -- the mtime is the marker's age and the round anchor for the transcript window). The next tick retries; the 24h stale bound is what eventually gives up. |
| **terminal** | everything else: `channel_not_found`, `not_in_channel`, `is_archived`, `invalid_auth`, `thread_not_found`, `msg_too_long`, ... | waiting cannot help: the placeholder is rewritten into the generic error (`chat.update`) so the user sees a failure instead of an eternal "working...", the Slack error goes to `debug.log`, and the marker is dropped. |

A failed `chat.delete` after a successful post is only logged (the answer got
through). A failed generic-error `chat.update` follows the same split:
retryable keeps the marker, terminal is logged and dropped. Contract cases
(n)-(s) in `scripts/__tests__/slack-watchdog-wedged.test.sh`, driven by the
stub's failure injection (`stub_mode "<method|*> <mode> [count]"`, mode =
`ok` | `ok_false:<error>` | `http:<status>`).

The `Stop` hook's fallback path (`slack_progress_clear.py`) still uses a plain
`api()` and is covered by its own review items (timeout budget, round
scoping); it is not changed here. The one place the Stop hook does classify a
failure is the delete retry of a `replied` entry (previous section).

## Install

```bash
bash ~/ClaudeClaw/scripts/install-slack-progress-hook.sh
```

Idempotent, auto-run by `scripts/sync-hooks.sh` on every update (any
`scripts/install-*-hook.sh` is picked up automatically).

> **The guarantee: the active provider's installer wins on every update.**
> `sync-hooks.sh` runs *every* `install-*-progress-hook.sh` on *every* update,
> in glob order (Slack first, Telegram last). Each installer first reads
> `CHANNEL_PROVIDER` and, if it is not its own provider, retires its own
> leftovers and exits -- so whatever order they run in, an update ends with
> exactly one provider's watchdog live: the one in `CHANNEL_PROVIDER`. Nothing
> done by hand survives this: a `--force` retire of the active provider is
> re-installed by the next update, and there is deliberately no flag to
> install the inactive one -- two watchdogs on a box whose `.env` names one
> provider is exactly the state the gate exists to prevent. Change
> `CHANNEL_PROVIDER` if you want a different end state. Contract:
> `scripts/__tests__/sync-hooks-provider-gate.test.sh`
> runs both installers in glob order for both providers, twice, and asserts
> the second run is a byte-identical no-op.

It:

0. **Provider gate.** Reads `CHANNEL_PROVIDER` from the install `.env`
   (resolved like `src/channel-provider.ts`: exact known value, anything
   else - empty, `none`, a typo - means `telegram`). If it is not `slack`,
   the installer retires any leftover Slack plumbing and exits with that
   retire's status (0 unless it failed) without touching anything else. The
   Telegram installer has the mirror gate.
   This is what makes the pair order-independent under `sync-hooks.sh`,
   which runs *every* installer on *every* update, Slack first and Telegram
   last: without the gate a Slack install ended each update with both hook
   sets wired and both watchdog timers enabled - the Telegram installer
   re-wired its hooks right after the Slack one had retired them (its own
   retire of Slack being refused by the active-provider guard).
1. Retires the Telegram progress plumbing (`scripts/retire-progress-watchdog.sh telegram`)
   so exactly one provider's indicator is live. The Telegram installer does
   the same in reverse; `scripts/doctor.sh` warns about drift between
   `CHANNEL_PROVIDER` and the live watchdog timers. A failing retire never
   blocks step 2, but it is never silent either -- see *A failed retire is
   never silent* below.
2. Installs the watchdog as a **launchd** agent (macOS) or **systemd** user
   service+timer (Linux), running every ~60s **straight from the repo
   checkout** - no `~/.claude/hooks` copy, so the daemon can never drift from
   the repo. The unit also pins `MARVEEN_ROOT` to the install root: launchd
   and systemd pass no shell environment to a job, and the watchdog's own
   self-location (two directories up from
   `<root>/scripts/hooks/slack_progress_watchdog.py`) is the primary mechanism
   with this as the belt (TGWDOGVAK913).

### A failed retire is never silent

Both installers used to call `retire-progress-watchdog.sh` with `|| true`, in
the gate branch and in the cross-retire alike. That turned a broken retire
script into a silent no-op: on macOS the script could not even be parsed (next
section), the cross-provider retire did not happen, the gate's "retire my
leftovers and exit 0" branch did nothing -- and no line of output said so.

Both now go through `retire_provider()`:

- a non-zero retire is printed on stderr with its exit code and the exact
  command to re-run (`⚠ retire-progress-watchdog.sh <provider> FAILED (exit N)`);
- **gate branch**: the retire is the branch's whole job, so its status is the
  installer's exit code;
- **active-provider branch**: still never fatal -- the active provider's
  watchdog is installed regardless -- but the failure is repeated in the
  end-of-run summary (*both providers' progress machinery may be live*) and
  becomes the exit code.

A non-zero installer is safe for its only caller: `sync-hooks.sh` reports it
and carries on with the next installer, and `update.sh` does the same with
`sync-hooks.sh`. The retire script itself fails loudly too: a user-global
`settings.json` it cannot parse is an explicit error and a non-zero exit, not
a traceback followed by success.

### macOS: `/bin/bash` is bash 3.2

Every macOS ships bash 3.2.57 as `/bin/bash`, and that is what runs these
scripts there (their shebang, and any caller without a Homebrew `PATH`). bash
3.2 does not skip a here-document body while it scans a command substitution
for the closing paren, so this shape

```bash
OUT="$(python3 - "$arg" <<'PYEOF'
# it's enough for the Python to contain ONE apostrophe
PYEOF
)"
```

is a parse error for the *whole script* (`unexpected EOF while looking for
matching ''`), while bash 4+ accepts it -- every Linux run stays green. The
retire script had exactly this, so it never ran on a Mac. Its settings surgery
now lives in `scripts/lib/retire_progress_hooks.py`, with the same stdout
contract the shell side parses (`REMOVED <event>: <command>` lines, then
`COUNT <n>`). It sits under `scripts/lib/`, not `scripts/hooks/`: it is not a
hook, and `hook-registration-completeness.test.ts` requires everything in
`scripts/hooks/` to be registered or exempted.

Rule for these scripts: **no here-document inside `$( ... )`**. The retire
suite lints for it and runs `/bin/bash -n` on the script; the installer suites
`bash -n` the installers the same way.

### Where the settings hooks live (#1305)

The installer does **not** install the three settings hooks, and since #1305
(ISSUE1305HOOKSCOPE) it must not: writing fleet hooks into the user-global
`~/.claude/settings.json` made them fire in the owner's own, unrelated Claude
Code sessions. They are repo-shipped instead:

| Surface | What it wires |
| --- | --- |
| `.claude/settings.json` (tracked, project scope, `$CLAUDE_PROJECT_DIR` form) | the main agent |
| `templates/settings.json.template` (existence-guarded `[ -f … ] && exec`) | every seeded agent |

Both carry the same three: `UserPromptSubmit -> slack_progress.py`,
`PostToolUse("slack.*reply") -> slack_progress_reply_clear.py`,
`Stop -> slack_progress_clear.py`. The Telegram set sits next to them
unconditionally; that costs nothing, because each hook is provider-scoped
internally and no-ops on the other provider's turns. Only the **watchdog
daemon** - which polls on a timer whether or not a turn is in flight - has to
be gated to the active provider.

`MARVEEN_ENV_FILE=<path>` makes the installers (and the retire script) read
that file instead of `<install>/.env` - a test hook only, so the contract
tests never depend on the checkout's own `.env`.

### The PostToolUse matcher

The matcher is the loose regex `slack.*reply`, fixed in the two settings
surfaces above: it matches the real reply tool name
`mcp__plugin_slack-channel_slack__reply` regardless of the exact plugin id,
mirroring the Telegram matcher `telegram.*reply`. An install that needs a
stricter or different matcher edits `.claude/settings.json` (and the template
for seeded agents) - there is no installer flag any more, because the
installer no longer writes any settings file. The pre-#1305
`SLACK_REPLY_TOOL_MATCHER` environment override is gone.

The hook scripts themselves are more forgiving than the matcher: they only
check that the tool name contains `slack` and `reply`, so a slightly-off
matcher still degrades gracefully (the PostToolUse hook simply won't fire,
leaving the Stop hook and watchdog as backstops) instead of erroring.

## Language

The user-facing texts (the placeholder, the watchdog's error rewrite) and the
Stop hook's block instruction come in Hungarian and English. Resolution, per
hook run: `MARVEEN_LANG` env if set, else the install's `.lang` file (written
by `install.sh` at the install root, found by walking up from the agent's state
dir), else `hu`. Values: `hu`, `en`.

## Tuning

- `slack_progress_watchdog.py`: `DOWN_GRACE_SEC` (default 120s), `WEDGED_SEC`
  (default 15m), `SLACK_WATCHDOG_WEDGED_UP_SEC` (default 180s for a detected
  hung reply-tool call), `SLACK_WATCHDOG_STALE_SEC` (default 24h upper bound).
- `MARVEEN_ROOT` env var overrides the fleet root the watchdog scans.
- `SLACK_API_BASE` overrides the Slack Web API base (tests point it at a
  local stub); defaults to `https://slack.com/api`.

## Tests

```bash
bash scripts/__tests__/install-slack-progress-hook.test.sh
bash scripts/__tests__/install-telegram-progress-hook.test.sh
bash scripts/__tests__/slack-reply-clear.test.sh                  # incl. the failed-delete / `replied` contract, Stop hook's part too
bash scripts/__tests__/slack-watchdog-wedged.test.sh              # incl. delivery-failure cases (n)-(s), `replied` leftovers (t)-(x)
bash scripts/__tests__/retire-progress-watchdog.test.sh
bash scripts/__tests__/sync-hooks-provider-gate.test.sh   # both installers, glob order, both providers
```

### The installer / retire suites never touch the host's service manager

`launchctl` acts on the user's real launchd domain and `systemctl --user` on
the real user manager **whatever `$HOME` says**. Run unshimmed on a Mac, these
suites registered real jobs from their temp plists
(`com.testbot.slack-progress-watchdog`, `com.testbot.telegram-progress-watchdog`),
which outlived the run and kept firing every 60s against a deleted path. So:

- every run of an installer or of the retire script goes through one helper
  (`run_installer` / `run_retire`) that puts logging PATH shims for
  `launchctl`, `systemctl` and `pidof` in front (they exit 1, like an absent
  manager); the `DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR` neutralisation
  stays underneath as a belt;
- `uname` is shimmed too (`FAKE_UNAME`), and the full-run cases loop over
  **both daemon branches** -- `[Linux]` systemd, `[Darwin]` launchd -- wherever
  the suite runs, with leftovers planted in that branch's own form (plist vs
  `.timer` + `.service`). A macOS-only defect can no longer hide on Linux, or
  the other way round;
- the scripts run under `/bin/bash` when there is one (bash 3.2 on a Mac, even
  with a newer bash first in `PATH`);
- each suite asserts that the branch under test really reached its *shimmed*
  manager (`launchctl load <plist>` / `pidof systemd` in the shim log), has a
  static check that no case starts a script outside the helper, and -- on a
  host that has a launchd -- ends with the acceptance check itself:
  `launchctl list | grep testbot` must be empty.

Everything reads a temp `.env` through `MARVEEN_ENV_FILE`; no case depends on
the checkout's own `.env` (the retire suite's active-provider case used to
`SKIP` without one).

## Remove

```bash
bash scripts/retire-progress-watchdog.sh slack --force
```

This stops + removes the watchdog daemon (launchd agent on macOS, systemd user
timer on Linux) and unwires any `slack_progress*` entry from the **user-global**
`~/.claude/settings.json` - a pre-#1305 leftover, since nothing writes there any
more. It never touches the repo-shipped `.claude/settings.json`: those hooks are
tracked files, removed by editing the repo, not by a script. The hook files
under `~/.claude/hooks/` (also pre-#1305 leftovers) are left in place; they are
inert once unwired. If the script cannot do its job (e.g. a user-global
`settings.json` that is not valid JSON) it says so and exits non-zero.

Note that while `CHANNEL_PROVIDER=slack`, the next update's `sync-hooks.sh`
re-installs the indicator (the installer is meant to keep the active
provider's plumbing live). A removal that should survive updates means
switching `CHANNEL_PROVIDER` - the provider gate then retires the Slack
plumbing on the next update by itself.
