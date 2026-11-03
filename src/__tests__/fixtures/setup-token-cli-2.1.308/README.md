# `claude setup-token` start output (Claude Code CLI 2.1.308)

`start.txt` is the raw PTY stream, escapes included, of `claude setup-token`
run through `scripts/setup-token-pty.py` (512x24) on 2026-10-22, with a fresh
`CLAUDE_CONFIG_DIR`, an empty `TELEGRAM_STATE_DIR` and `BROWSER` pointed at a
no-op. It ends where the prompt waits for the code; the relay's stdin was then
closed, so no login happened.

One edit after capture: the `code_challenge` and `state` values (43 chars each)
were replaced with same-length `FIXTURE...` placeholders. Everything else,
including the OSC 8 hyperlink around the URL and the `\r\r\n` line endings, is
byte for byte.

The output after a submitted code is NOT captured here: that needs a real
login, which the owner does at the end (SETUPTOKENWIZ1022). The token tests
build that part by hand and say so.
