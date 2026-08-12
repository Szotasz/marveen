# Telegram-reply enforcement (2026-08-02)

## Symptom

A recurring failure: when the owner writes on Telegram, the agent sometimes answers
as plain assistant text (which only lands in the tmux session) instead of through
the `mcp__plugin_telegram_telegram__reply` tool, so the owner, who reads Telegram
and not tmux, sees nothing and has to re-prompt ("miért nem telegramra válaszolsz?").

This had recurred **11 times** by 2026-08-02 (10 prior incidents are catalogued in
the `feedback_always_use_telegram` memory).

## Root cause

The rule lived **only as passive context**: `CLAUDE.md` plus several memory files.
Nothing mechanically enforced it, so compliance depended on the model choosing the
reply tool on every turn. It reliably lapsed when attention drifted, classically
during long runs of plain-text scheduled-heartbeat turns, whose momentum carried
into a plain-text answer when a real Telegram message arrived mid-stream.

Concrete gaps found:

1. **No `Stop` hook anywhere.** The harness never checked, at end-of-turn, whether
   a Telegram message had actually been answered via the reply tool.
2. **Voice was protected, text was not.** `voice-reply-directive.py` already
   injected a reply directive for *voice* messages on `UserPromptSubmit`; there was
   no equivalent for plain-text Telegram messages.
3. **Cosmetic matcher bug.** The `PostToolUse` matcher for the outbound-ledger hook
   was written with dots (`mcp__plugin.telegram.telegram__reply`) instead of
   underscores. It matched by accident (matcher is regex, `.` matches `_`), so
   outbound replies *were* logged, but the pattern was misleading and fragile.

## Fix (implemented)

Move the rule from *documented* to *enforced*, reusing the existing
`conversation_log` ledger (no new state model):

- **`scripts/hooks/telegram-reply-guard.py`**: a `Stop` hook. On every stop it
  calls `ledger_lib.open_question_with_age(agent_id)` (the most recent inbound with
  no later outbound). If an unanswered Telegram message exists it **blocks** the
  stop with a directive to send the reply via the reply tool. Guards against
  false-blocks and loops:
  - pure acknowledgements ("ok", "köszi 👍", emoji-only) → allow;
  - inbound older than `TG_GUARD_STALE_SECONDS` (default 30 min) → allow;
  - after `TG_GUARD_MAX_BLOCKS` (default 3) blocks on the same message → allow
    (hard backstop so a wedged model is never trapped);
  - any error → allow (a guard hook must never wedge the session).
- **`scripts/hooks/telegram-reply-directive.py`**: a `UserPromptSubmit` hook that
  injects a reply-tool reminder at the top of the turn whenever an inbound Telegram
  text message is present (the text-message twin of `voice-reply-directive.py`), so
  the model rarely reaches the Stop-hook block at all.
- **Matcher fix** in `.claude/settings.json`: dots → underscores for the
  `ledger-outbound.py` `PostToolUse` matcher.

Wiring lives in the version-controlled project `.claude/settings.json` (`Stop` +
`UserPromptSubmit` blocks). Note: `boot-hook-prune.py` scans only user/agent
settings, not the project settings, so it will not prune these hooks.

## Verification

`scripts/__tests__/telegram-reply-guard.test.py` drives the hook against an
isolated ledger DB (`LEDGER_DB_PATH`) and asserts the decision for each scenario:
unanswered question → block; answered (outbound logged) → allow; acknowledgement →
allow; stale → allow; max-block backstop → allow; no-inbound (heartbeat-only turn)
→ allow. All pass.

## Re-sync regression check (upstream)

This fix is being submitted upstream (Szotasz/marveen). When a later update
re-syncs it back, verify it did not break:

1. `python3 scripts/__tests__/telegram-reply-guard.test.py` still exits 0.
2. `.claude/settings.json` still contains the `Stop` →
   `telegram-reply-guard.py` entry and the underscore matcher.
3. Live check: send a Telegram message, answer as plain text on purpose, confirm
   the Stop hook blocks and forces the reply tool.

Tracked on the kanban board (project `marveen`) so the upstream-sync flow revisits
it on merge-back.

## Activation note

Hooks are loaded at session start, so the guard becomes active on the next
`channels.sh` / session restart after this change is deployed.
