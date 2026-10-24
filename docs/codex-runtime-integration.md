# Codex runtime integration

The optional `MARVEEN_AGENT_BACKEND=codex` backend runs the main channel and
short-lived text workers using a ChatGPT-authenticated Codex app-server. The
existing Claude backend remains the default. This integration is a prerequisite
for the owner-rules wiring described in
`docs/superpowers/specs/owner-rules-system-wiring-handoff-2026-10-23.md`.

This branch selectively ports the Codex runtime from the deployed local revision
`5dd85cae`. It does not merge the nine local commits or their unrelated
self-healing changes, disk guard changes, historical evidence, or production
configuration. Newer develop guards for fleet freeze, schedule registry, current
schedule definitions, pull delivery, usage limits, main respawn holds, and guarded
prompt emission must remain effective.

## Operation

Install and authenticate Codex separately as the service user; the runtime uses
`MARVEEN_CODEX_BIN` or the user's private Codex installation. Configure the existing
Telegram MCP plugin with `MARVEEN_CODEX_TELEGRAM_PLUGIN`. No credentials are shipped.
`channels.sh` selects the optional launcher. The launcher validates login before
replacing the main channel. Dashboard recovery replaces only the main pane.
Claude TUI monitors must not send Claude keystrokes into the Codex main channel.

The foreground conversation uses on-request approval with automatic review.
Background workers cannot request approval and use the configured sandbox.
Scheduled occurrences have durable identities and lifecycle records. Ambiguous
started work is interrupted for manual review, never blindly replayed. Fixtures
exercise these records without a real model or channel API.

## Release

Review and merge this prerequisite into develop before merging the separate
owner-rules PR. Production rollout must use the approved release and `update.sh`;
never replace the dirty production tree or stash unrelated changes. Live smoke
checks remain pending until release approval and deployment preflight pass.
