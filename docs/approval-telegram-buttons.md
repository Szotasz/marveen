# Email approval with Telegram buttons

An `email_send` approval request can reach the owner on Telegram with two inline
buttons under it, "✅ Jóváhagyom" and "❌ Elutasítom". A press is decided by
code: the patched Telegram channel plugin turns it into one HTTP request, and
the dashboard checks it. The model never sees the press, and nothing is decided
in natural language.

The send gate does not change. The button only flips `approvals.status`; the
letter still goes out only through the gate's own check (the content hash, one
use, inside the send window, 30 minutes by default).

## Contents

- [Requester steps](#requester-steps)
- [When the buttons appear, and when not](#when-the-buttons-appear-and-when-not)
- [The decision endpoint](#the-decision-endpoint-post-apiapprovalsidtelegram)
- [One nonce per button](#one-nonce-per-button)
- [Channel coordinator redaction](#channel-coordinator-redaction)
- [Letter content after the decision](#letter-content-after-the-decision)
- [The `apv` line in /status](#the-apv-line-in-status)
- [Legacy `resolved_by` alphabet](#legacy-resolved_by-alphabet)
- [Deployment](#deployment)
- [Rollback](#rollback)
- [Accepted limitation](#accepted-limitation)
- [Not yet measured live](#not-yet-measured-live)
- [RAG production run approval (permission bot)](#rag-production-run-approval-permission-bot)

## Requester steps

1. The agent tries to send. At level 2 the email approval gate
   (`scripts/hooks/email-approval-gate.py`) denies the call and prints the
   content anchor (`content_hash`) of the letter.
2. The agent runs the requester helper on the same PreToolUse input the gate
   saw (`{"tool_name": ..., "tool_input": {...}}`), from the same working
   directory and environment as the send. A relative path or a `$VAR` in an
   `--attach` value resolves differently elsewhere, and a different hash means
   no buttons (fail-closed).

   ```bash
   python3 -I scripts/approval-envelope.py --agent <agent-id> [--subject <subject>] \
     < pretooluse.json > approval-request.json
   ```

   - Exit 0: one JSON line on stdout, the `POST /api/approvals` body
     (`agent_id`, `category: "email_send"`, `content_hash`,
     `action_description`, `action_payload`). `action_payload` is a JSON
     string: `{"envelope_v":1,"to":[...],"cc":[...],"bcc":[...],"text":"...",
     "subject"?, "html_sha256"?, "attachments"?}`.
   - Exit 2: stdout is empty and the reason is on stderr. This covers an
     unreadable letter (shell substitution, an unreadable attachment, a lone
     surrogate), a call that is not a send, bad input, and a hook module that
     does not load.
   - `--subject` is allowed on the Bash send path only, and only when it is
     exactly the first line of the hashed text (the extractor joins subject and
     body with one newline, so a `--subject` given before `--body` is that
     line). On an MCP send the subject is the last field of the text, so the
     first line is the body's: the helper refuses any `--subject` there
     (exit 2), even one that matches. Leave it out; the letter is shown in full
     either way.
   - The helper reads only: no network, no store, no secret. It loads the
     gate's own extractor and anchor function, so its hash cannot drift from
     the gate's.
3. The agent posts the body as a file, never as a shell-quoted string:

   ```bash
   curl -s -X POST http://localhost:3420/api/approvals \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat <install>/store/.dashboard-token)" \
     --data-binary @approval-request.json
   ```

4. The owner decides, with a button or on the dashboard.
5. The agent retries the byte-identical send. The gate consumes the approval
   once, inside the window.

## When the buttons appear, and when not

The dashboard puts buttons under the notification only when all of these hold.
Otherwise the plain notification goes out ("Döntés: Dashboard"), and the reason
is logged without any hash or letter content.

- The category is `email_send`, the request has a `content_hash`, and the
  `action_payload` is an `envelope_v: 1` envelope whose recomputed anchor equals
  that `content_hash` (a bound envelope).
- The owner resolves strictly to a positive Telegram user id, and that id is the
  chat the notification goes to.
- The main channel state directory is the install-scoped one
  (`<install>/.claude/channels/telegram`). The plugin derives the dashboard
  address from it.
- The dashboard's notification bot is the bot the main channel plugin polls
  (equal bot ids, the part of the token before the colon). Neither token is
  logged.
- The whole notification fits in ONE message: every identifying line, the full
  body and the tail, at most 3788 UTF-16 code units. That is Telegram's 4096,
  minus the 8 units of the test-run prefix (always deducted), minus 300 units
  kept free for the outcome line the plugin appends after a decision.
- Both button nonces were stored on the row before the message went out.

A longer letter is not split under buttons. It gets the plain notification with
the line "A levél túl hosszú a gombos jóváhagyáshoz (nem fér egy üzenetbe), a
dashboardon dönts." Reason: the bot's own messages in the owner's chat can be
edited (for example through the plugin's `edit_message` tool). A body split
over several button-less messages could be rewritten before the owner decides.
Kept in the button message, the body cannot change without the buttons going
with it.

A letter whose first line was given as the subject shows it as
"Első sor (a kérő szerint tárgy): ...". The label says what is proven (it is
the first line of the hashed text) and whose claim the rest is. With no subject,
the line reads "Tárgy: a levél szövegében szerepel (nem külön hitelesített mező)".

## The decision endpoint: `POST /api/approvals/:id/telegram`

The plugin sends this, and only this, for a press. The legacy
`PATCH /api/approvals/:id` refuses the reserved `owner:telegram:` attribution
with a 400. So a plugin newer than the dashboard gets a 404 from an old server,
decides nothing, and leaves the buttons in place.

Request (bearer token as for every `/api/*` call):

```json
{"status": "approved|rejected", "resolved_by": "owner:telegram:<from.id>",
 "telegram_message_id": 123, "telegram_chat_id": "<chat.id>",
 "telegram_chat_type": "private", "callback_nonce": "<22 chars>",
 "callback_protocol": 1}
```

Checks, in this order: the request shape, the strict owner, then a private
chat whose id is the owner's id, then one conditional UPDATE. Nothing before
the UPDATE reads the approval, so a caller that is not the owner gets the same
answer for a pending, a decided and a nonexistent id. The UPDATE needs a pending
`email_send` row with a content hash, a deadline that has not passed (checked
here, whether or not the timeout sweeper has run), the stored message id, and
the hash of the pressed button's nonce. Exactly one call wins, against another
press, the legacy PATCH and the sweeper alike.

| Status | Body |
|---|---|
| 200 | `{ok: true, approval, outcome_text}` |
| 400 | `{ok: false, reason: "bad_request"}` |
| 403 | `reason`: `not_owner`, `chat_mismatch`, `message_mismatch`, `bad_nonce` |
| 404 | `reason`: `not_found` |
| 409 | `reason`: `already_resolved` (with `status`, and `outcome_text` when there is one), `expired`, `not_bound`, `wrong_category` |

On 200, and on a 409 `already_resolved`, `expired` or `not_bound`, the plugin
takes the buttons off and appends the outcome line when the text still fits.
On any other answer, or a timeout (10 s, no retry), it only shows a toast and
leaves the buttons in place. The plugin checks first, without any HTTP request,
that the data matches the exact format, the presser is on the channel's
`allowFrom` list, and the chat is private with `chat.id == from.id`. It refuses
outright when an HTTP proxy variable is set without a `NO_PROXY` entry of
exactly `127.0.0.1`, because the plugin runtime would send the request through
the proxy.

## One nonce per button

Callback data: `apv:<a|r>:<approval id, 32 lowercase hex>:<nonce>`, 61 bytes
(Telegram allows 64). Each button gets its own nonce: 16 random bytes,
base64url, no padding. The row stores only the sha256 of each nonce, in
`callback_nonce_hash_approve` and `callback_nonce_hash_reject`. No API response,
list or log line carries those columns. A win clears both hashes. The approve
nonce cannot reject and the reject nonce cannot approve (`bad_nonce`). A row is
bound once, before its button message goes out. If that message fails, the row
stays `not_bound`, and every press on it is refused.

## Channel coordinator redaction

The standalone channel coordinator (the backfill poller that runs only while
the native channel is down) never stores or forwards approval-button data. Any
callback data starting with `apv:` (prefix match, case-insensitive, leading
whitespace allowed) is replaced with `apv:<redacted>` in `incoming_events` and
in the hand-off text. A callback row stored before the redaction existed is
redacted again when it is replayed. The coordinator does not decide the press:
the owner presses again once the native channel is back, or decides on the
dashboard.

## Letter content after the decision

For `email_send`, `action_payload` is the whole letter, BCC included, and
`GET /api/approvals` hands it to every holder of the bearer token. Nothing
reads it after the decision: the notifier reads it at creation time, the
`/approvals` chat command lists pending rows only, and both send paths match on
`content_hash`. So once the letter can no longer be sent, the payload is
replaced with `{"envelope_v":1,"cleared":true}`:

- on reject and timeout (legacy PATCH, the Telegram button, the timeout sweep),
  in the same UPDATE as the decision;
- on consume through `POST /api/approvals/:id/consume`, in the same UPDATE;
- by the timeout sweeper (every 60 s) for rows closed outside the dashboard
  code: a letter the Python gate consumed (it writes `consumed_at` directly),
  an approved letter left unconsumed past the send window
  (`EMAIL_APPROVAL_WINDOW_S`, 1800 s by default), and a rejected or
  timed-out row decided by older code. The sweeper touches only an
  `envelope_v: 1` payload; an `email_send` row with any other payload (from an
  older requester) is left as it is.

An approved letter keeps its payload until it is consumed or its window
passes. Only an `envelope_v: 1` payload is ever cleared, on every path above:
a NULL payload, an `email_send` payload in any other format, and every other
category keep their payload exactly as before.

The `action_description` is not touched, and it keeps the BCC recipients: the
helper's description names them. A list read after the decision still shows
them there; only the payload copy of the letter is cleared.

## The `apv` line in /status

The `Telegram plugin-patch` row of `/status` covers the approval-button patch
as `(jóváhagyás-gombok)`. A marker alone is not enough for `rendben`: the
inserted block must be the current module source exactly as the patcher copies
it, under the BEGIN label of that source, followed by the env-snapshot line,
with exactly one call line and no other marked line. Possible results per cached
plugin version:

- `rendben (<versions>)`: every expected patch is in place;
- `HIÁNYZIK (jóváhagyás-gombok): ...`: the patch is missing (with the reason the
  patcher recorded): the buttons do not work, decide on the dashboard;
- `ELTÉR (jóváhagyás-gombok): ...`: the block differs from the source (edited
  by hand, or stale); the next channel start replaces it;
- `NEM ELLENŐRIZHETŐ (jóváhagyás-gombok): ...`: the module source cannot be read.

## Legacy `resolved_by` alphabet

`resolved_by` on the legacy `PATCH /api/approvals/:id`, and `agent_id` on
`POST /api/approvals`, are free text, limited to an allowlist so that no
look-alike can dress up as the reserved prefix:

- printable ASCII (0x20 to 0x7E);
- the 18 Hungarian accented letters, precomposed only: á é í ó ö ő ú ü ű and
  Á É Í Ó Ö Ő Ú Ü Ű.

Anything else is a 400, including an en dash, an emoji, curly quotes, a
decomposed accent, and any Cyrillic, Greek, combining or invisible character.
Inside that alphabet, a value that claims the `owner:telegram:` prefix (case
and whitespace ignored) is also a 400. The prefix is valid only on the decision
endpoint.

## Deployment

Both steps restart live services. Do them only with the operator's approval.

1. Dashboard first. Rebuild, then restart the dashboard. The start runs the
   additive migration (the two nonce-hash columns) and serves the new endpoint
   and the button notification. Restart the channel coordinator service from
   the same build, so the redaction is live before the first button goes out.
2. Then the plugin. Restart the main channel. `scripts/channels.sh` runs
   `scripts/patch-telegram-plugin.py` at every channel start; it copies the
   block into the cached plugin and inserts the call line. Check `/status` for
   `rendben`.

In the other order, a patched plugin would meet a dashboard without the
endpoint: the press gets a 404 and decides nothing, but the owner sees a
broken button.

## Rollback

Reverse order, and strip the plugin patch first:

1. Take the patch out of the cached plugin: `strip_apv()` in
   `scripts/patch-telegram-plugin.py`, or delete by hand the lines from
   `// MARVEEN-PATCH(apv-buttons) BEGIN` to `... END`, the
   `MARVEEN_APV_ENV_AT_LOAD` snapshot line and the call line. The file is then
   byte-identical to the one patched without it. Do this before the code goes
   back: an older patcher does not know this patch, so it would leave the block
   in place. Restart the main channel.
2. Then revert the dashboard (and the coordinator) and restart them. The nonce
   columns stay. Nothing reads them, and they hold only hashes.

## Accepted limitation

Accepted as is, not fixed by the buttons:

> The holder of the shared bearer token can already decide any approval today
> with the legacy PATCH, by creating a dashboard user, or by a password reset.
> The buttons do not fix this; the nonce only makes the `owner:telegram:*`
> attribution authentic. A separate auth scope is a separate decision.

What the nonce does and does not protect against:

- It protects against an attacker who has only HTTP access with the bearer
  token: the owner id, the chat id and the message id are all readable over the
  API, but the nonce is not.
- It protects against a reader of the database: the database holds only the
  sha256 of each nonce.
- It does NOT protect against a direct write to the database by the same Unix
  user the dashboard runs as. That user can set the row's status directly,
  without any nonce.
- It does NOT protect against the holder of the bot token. That holder can
  call `getUpdates` in a race with the plugin's poller and catch the owner's
  callback update. The update carries the pressed button's nonce, and the
  message carries the other button's callback data too, so the decision can be
  reversed. This takes an active attack and precise timing, and was not
  measured. There is no mitigation in this feature; it is handled by protecting
  the bot token and by the separate owner auth scope.

## Not yet measured live

Two assumptions are covered by tests with a fake Bot API, but not by a run
against Telegram:

- An `editMessageText` without `reply_markup` removes the inline keyboard. Both
  the plugin's own settle step and the reason for one-message-only buttons rely
  on this. If it turns out false, a button message could be edited while
  keeping its buttons.
- The unit of the 4096 limit (UTF-16 code units, code points, or something
  else). The budget counts UTF-16 code units, which are never fewer than code
  points, and keeps 300 units in reserve.

## RAG production run approval (permission bot)

Categories `rag_production_d` and `permission_bot_probe` (card 9a77b3e5) use a
separate flow, "D". The owner's buttons come from a second bot, the permission
bot, never from the main bot; only that bot's button counts as the owner's
permission for a run.

The flow:

1. The runner files `POST /api/approvals` with a bound, canonical payload
   (`kind`, `package_sha256`, `run_id`, write window) and its `content_hash`.
   The `rag_production_` prefix is reserved (case-insensitive), `agent_id` must
   be a bare agent id, `owner_approved_message_id` is refused (400).
2. The dashboard sends the owner one message with two buttons through the
   permission bot. It sends nothing, and not through the main bot either, if
   the permission bot cannot be resolved (see `PERMISSION_BOT_ID` below), if the
   main bot is unknown (`main_bot_unresolved`), if the permission bot is the main
   bot, or if the strict owner is unresolved (`owner_unresolved`).
3. The press comes back through the relay as
   `POST /api/approvals/:id/permission-bot` (the id may carry 32 hex digits
   without dashes). The decision needs the bound nonce, message id, the strict
   owner and the permission bot's id; it writes an `approval_owner_resolutions`
   trace in the same transaction. That trace is the owner-verified evidence.
4. `POST /api/approvals/:id/consume-run` uses the approval once: category,
   owner-verified, payload still the hash's, package, `run_id`, write window,
   not used before. Every attempt with a well-formed id leaves an
   `approval_events` row, including a field-level 400 and a 503.

**`PERMISSION_BOT_ID`.** The id of the permission bot (digits only, the part of
its token before the colon) is pinned in the process environment or the
install `.env` and read once at startup. It is not read through
`config-overrides.json` and is not in the settings registry, so neither the
Settings API nor the onboarding `.env` writer (it refuses the key and any value
with a line break or NUL) can set it. This is a hardening, not a proof that no
Bearer path exists: see the residual risk below. The Vault token
`telegram-engedely-bot-token` is only the credential to send with, and is used
only while its bot id equals the pin. If the pin is missing or malformed, or
the token belongs to another bot, the send is refused and both
`/permission-bot` and `/consume-run` answer 503 `permission_bot_unavailable`
(the consume attempt is recorded as an event). Evidence and checks compare
against the pin. Set it in `.env` as `PERMISSION_BOT_ID=<digits>` and restart
the dashboard.

**Vault write-lock.** `POST /api/vault`, `DELETE /api/vault/:id`,
`POST /api/vault/import` and `PUT /api/operator/vault/:id` refuse the entry
`telegram-engedely-bot-token` (403, "locked"). The lock is enforced in the
storage layer too (`setSecret` / `deleteSecret` in `src/web/vault.ts`), so a
route that builds the same id, such as `POST /api/connectors` with the name
`telegram-engedely-bot` (slug plus `-token`), is refused as well (403) before
anything is installed. There is no internal bypass. The operator puts the token
in place out-of-band (not through the API). Reads are unchanged.

**Runner note.** `consume-run` requires the body `category` to equal the
approval row's category, so a `permission_bot_probe` row can never authorise a
`rag_production_d` run: the runner must file and consume with category
`rag_production_d`.

**Residual risk.** The fleet shares one dashboard Bearer token. A holder cannot
forge the owner's decision (the nonce lives only in the button) or swap the
permission bot, but can call `consume-run` first with a known package hash and
`run_id` and so make the real runner get `already_consumed` (denial, not
forgery). Whoever can read the permission bot's token out-of-band could still
race the relay's `getUpdates`; restricting that token's readers is a
precondition for enabling D live.

The Bearer is also the key to installing an MCP server, which runs code on the
host (card 4d70f8b1). So a Bearer holder is, in the end, a code-execution
holder and could change `.env` or the Vault file directly, bypassing every
API-level fence above. The fences close the API routes we know of (Settings,
Vault, connectors, onboarding); they do not defend against a compromised
Bearer. That risk is tracked on card 4d70f8b1 and remains open.
