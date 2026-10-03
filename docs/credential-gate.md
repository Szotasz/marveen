# credential-gate: PreToolUse hook

## Problem

An agent that writes customer letters can paste a credential into one: a
device's admin password, a Wi-Fi key, a login. When that value is the
recipient's own, unique credential (a new account, their own device), it may
be the right thing to send. When it is a value several customers share, or a
partner's or the install's own, one letter hands it to someone who must not
have it, and nothing in the send path notices.

## What the hook does

`scripts/hooks/credential-gate.py` runs before every tool call that can carry a
letter: Bash commands the copy gate classifies as sends, the send-shaped MCP
tools, `manage_email`, and draft tools (a draft is a letter someone will send).
It reads the letter through the same shared extractor the other mail gates use
(`scripts/hooks/email_extract.py`) and looks for a credential **keyword**
(password, PIN, Wi-Fi/WLAN key, admin, login, Hungarian forms included)
followed on the same line, or alone on the next, by a **value-shaped** token: a
digit, an internal capital, a symbol, or a bare word right after a colon.
Placeholders (`[...]`, `***`, `xxx`, `${VAR}`), all-caps words, e-mail
addresses and URLs are not values. Inside a URL only `user:pass@` and
`password=...` count.

A letter with a credential goes out only when all three hold:

1. the value is not on the **shared list** (values known to be shared);
2. the value has not gone to a **different recipient** before (the second,
   unrelated recipient of the same value is evidence that it is nobody's own).
   The only way past this is an **alias**: the fingerprint plus an allowed
   recipient set (one customer, several addresses), live only once an approval
   of category `credential_alias` on its hash is approved;
3. a one-shot **acknowledgement** exists for this exact letter (recipients +
   subject + body, the same anchor the email approval gate uses): "this is the
   recipient's own, unique credential". It never lifts 1 or 2, and an
   acknowledgement given while the value counted as shared is void.

The deny message names the keyword, the line, the length and an 8-hex
fingerprint prefix, and the command that would resolve it. **The value itself
is never printed, logged or stored.** Fingerprints are HMAC-SHA256 under one
install-level key, so the shared list and the log cannot be brute-forced back
into a short password, and every agent of the install gets the same
fingerprint for the same value.

Fail-closed: an unreadable letter or recipient list, a broken config, key or
state file, or an unwritable log denies (exit 2) with the reason named. A
letter with no credential passes untouched and leaves no trace.

## Files (all under the store directory, `CREDENTIAL_GATE_STORE`)

| file | what | override |
|---|---|---|
| `credential-gate.key` | the install's HMAC key, created 0600 on first use; refused if group- or world-readable | `CREDENTIAL_GATE_KEY_FILE` |
| `credential-gate.json` | optional config (below) | `CREDENTIAL_GATE_CONFIG` |
| `credential-gate-state.json` | shared list, acknowledgements, first recipients, aliases (fingerprints only) | `CREDENTIAL_GATE_STATE` |
| `credential-gate.log` | one JSON line per decision with a credential: keyword, line, length, fingerprint prefix | `CREDENTIAL_GATE_LOG` |

Config keys (all optional): `mode` (`block`, default, or `warn`: log and
allow, for a rollout; `CREDENTIAL_GATE_MODE` overrides it), `keywords` /
`extra_keywords` (regexes, case-insensitive, whole words), `glue_words`,
`window` (40), `min_length` (4), `scan_tokens` (3), `auto_shared` (true).
An unknown key is an error, not a silent no-op.

## The CLI

```bash
# acknowledge ONE letter (the anchor is in the deny message)
python3 scripts/credential-gate-cli.py ack --anchor <sha256> --by <who> --reason "<why it is the recipient's own>"
# put a value on the shared list: read from stdin, never from the command line
python3 scripts/credential-gate-cli.py shared-add --note "<what it is>"
python3 scripts/credential-gate-cli.py shared-remove --fp <prefix>
# one customer, several addresses; --request files the approval on the dashboard
python3 scripts/credential-gate-cli.py alias --fp <prefix> --to <addr> --to <addr> --request --by <who>
python3 scripts/credential-gate-cli.py status
```

## How to enable it

**Sub-agents:** set `"credentialGate": true` in the agent's security profile.
The scaffold then wires the hook on the email-gate matcher at the next spawn
(and the startup migration repairs an already-scaffolded agent). The switch
is off by default and no shipped template sets it: with it off, the rendered
`settings.json` is byte-identical to an install without this hook
(`src/__tests__/credential-gate-wiring.test.ts`). Switching it off later does
not remove an entry an agent already has; removing a gate stays a deliberate
act.

**Main agent:** its settings are not rendered by the scaffold. Add the hook
next to the other mail gates in `.claude/settings.json`, on the same matchers:

```json
{ "matcher": "Bash", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/credential-gate.py\"", "timeout": 10 } ] },
{ "matcher": ".*send_email.*", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/credential-gate.py\"", "timeout": 10 } ] },
{ "matcher": ".*manage_email.*", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/credential-gate.py\"", "timeout": 10 } ] },
{ "matcher": ".*[Gg]mail.*__.*", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/credential-gate.py\"", "timeout": 10 } ] },
{ "matcher": ".*draft_email.*", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/credential-gate.py\"", "timeout": 10 } ] }
```

A send script that composes the letter itself and calls the mail gates with a
synthesized command can call this hook the same way (stdin JSON
`{"tool_name": "Bash", "tool_input": {"command": ...}}`, exit 0 or 2).

## What it does not see

- A letter composed and sent by code the hook cannot read: a script that
  builds the body at run time, or a send that runs on another machine. The
  hook sees the tool call, not what the script does later.
- Attachments, images, and an HTML body passed as a separate file to a Bash
  send (the inline text and the MCP `html` fields are read).
- A value that is not value-shaped: a capitalized dictionary word after a
  keyword without a colon, or a value two or more lines below its label.
- Whether an acknowledged value really is the recipient's own: the
  acknowledgement is a deliberate, logged statement, not a proof. The shared
  list and the cross-recipient check are the hard stops.
