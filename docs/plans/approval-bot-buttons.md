# Approval bot: Telegram inline buttons the server receives (kanban 80d0e3c6, step 2)

Owner decision (Gyuri, tg 7782, via Marveen msg 2894): option (b), a separate approval bot that only the
dashboard server polls, with a two-step confirmation and defences a+b+c, behind a switch that is OFF by
default. Order: tests and the server branch against a fake Telegram API, PR to develop, the real bot last
with the owner's token.

Stacked on #2156 (approve takes an owner credential): both touch `src/web/routes/approvals.ts`.

## Why a separate bot

The main bot's `getUpdates` belongs to the channels plugin (one poller per token). A press on a button the
main bot sent reaches the plugin process, and nothing that process can hand to the server is unforgeable for
an agent running as the same OS user (a file, or a credential read from disk). A bot polled only by the
server gets the press from Telegram over TLS, inside the server process.

## Pieces

- Setting `APPROVAL_BOT_ENABLED` (boolean, default 0, module channels, requiresRestart).
- Token: `store/.approval-bot-token` (owner-written, 0600). Missing/empty: feature inactive, one warning.
- HMAC key: `store/.approval-bot-key`, 32 random bytes, created 0600 on first start.
- Table `approval_bot_messages(approval_id PK, chat_id, message_id, sent_at, confirm_at)`.
- `src/approval-bot.ts`:
  - callback data `<op>.<id22>.<mac16>`, op in a (approve, step 1) / c (confirm) / x (cancel) / r (reject);
    id22 = the approval UUID as base64url of its 16 bytes; mac16 = HMAC-SHA256(key, op|id|chat|message)
    truncated to 12 bytes, base64url. 41 bytes, under Telegram's 64.
  - `sendApprovalPrompt(approval)`: to the owner chat, with [Jóváhagyom] [Elutasítom]; records the row.
  - `handleCallback(cq)`: every check below, then the step.
  - `startApprovalBotPoller()`: long-poll getUpdates (channel-coordinator client), in-memory offset
    (a re-delivered press after a restart is idempotent: resolve is pending-only, confirm has a window).
  - a tiny Bot API client (sendMessage with reply_markup, editMessageText, answerCallbackQuery),
    injectable so tests run against a fake.
- `notifyOwner`: when the bot is active, the question goes out through it; on failure (e.g. the owner never
  sent /start to the bot) the existing main-bot path runs. Born-approved notes stay on the main path.

## Checks on every press (all required)

1. `from.id` is on the main channel's `allowFrom` (read at press time), the message's chat is that same
   private chat (`chat.id === from.id`), and it equals the chat stored for this approval.
2. The pressed message is the one the server sent for this approval (`message_id` stored), so a message an
   agent sends with the same bot token carries buttons that do nothing, even with a correct HMAC.
3. The HMAC matches (timing-safe).
4. The approval exists, is pending, and has not timed out.
5. Confirm only within 5 minutes of step 1 (`confirm_at`), and only after step 1.

## Steps

- a: `confirm_at = now`; the message is rewritten from the DATABASE (agent, category, action, expiry) with
  [Megerősítem] [Mégse]. Defence a: whatever an agent edited into the text is replaced by the real action
  right before the decision.
- c: `resolveApproval(id, 'approved', 'telegram_button')`; the message becomes the DB action with the result.
  Defence c.
- r: rejected, same rewrite. One step: rejecting gains nobody anything.
- x: `confirm_at = NULL`, back to the first keyboard.
- Already decided (dashboard, timeout, a second press): "Ez a kérés már el van döntve: <status>", no change.

Defence b (not code): `api.telegram.org` stays off every sub-agent egress list, and sandboxed agents (#2149)
cannot reach it; documented in docs and the PR. Both token files join #2153's protected store files.

## Tests (fake Telegram API)

Happy path a -> c; reject; cancel; and each refusal: not on allowFrom, a group chat, another chat, a
message_id the server did not send (with a valid HMAC), a bad HMAC, an unknown approval, timed out,
already resolved, double confirm, confirm without step 1, confirm after the window. Switch off: nothing
goes through the bot, the main-bot path is unchanged (positive control). Send failure: fallback.
