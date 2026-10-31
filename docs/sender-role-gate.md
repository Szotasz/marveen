# sender-role-gate: PreToolUse hook

## Problem

An agent in a shared chat (a Telegram group, a Teams channel) takes requests from its owner and from
colleagues. To the model both are just instructions, so a colleague, or a hidden instruction inside a
colleague's message, can make the agent run the same risky tool the owner can: send a mail, run a shell
command. Permission rules see the tool, not who asked for it.

## What the hook does

`scripts/hooks/sender-role-gate.py` denies the agent's configured risky tools in any turn that carries a chat
message from a sender who is not listed as an owner. Every other call goes through untouched, and a turn with
no chat envelope at all (the terminal, a scheduled task, an inter-agent message) is not restricted.

The role is decided per turn, from the session transcript, at the moment of the tool call. All chat envelopes
of the current turn count, and the strictest one wins:

- the prompts that started the turn (a batch of several counts together);
- a message that arrived while the agent was working: its `queue-operation` `enqueue` line counts from the
  moment it is written, before the model has seen the message, and its later `remove` does not undo it;
- the `queued_command` line that hands such a message to the model.

Only a chat message is read for envelopes. Claude Code marks one with `origin.kind: "channel"`; text typed at the
terminal or an inter-agent message is not read, whatever it quotes. An `enqueue` line has no origin, so it counts
when its text begins with an envelope.

The sender id is read from the envelope: Telegram `user_id`, Teams `aad_object_id`. A sender who is not in the
table, a channel without a known sender attribute, an envelope with a repeated attribute, and a forged owner
envelope typed inside a colleague's message all make the turn a member turn. So does an envelope whose
attribute text does not parse cleanly, and a chat message in which no envelope can be read.

## Configuration

Per sub-agent, in `store/agent-sender-role-gates.json` (per install, gitignored), keyed by the agent's name:
`{"<name>": {...}}`, the value being the gate below. Only the dashboard (and the owner by hand) writes this file: it is on
the install-file gate's protected list (`scripts/hooks/db-write-gate.mjs`), so no agent, the main agent included, can
write it with a tool. The launcher and the gate read the table ONLY from there (GROMZOGATECONF1030 (c)).

Before, the table sat in the agent's own `agents/<name>/agent-config.json`, which the agent itself can write: a deceived
agent could widen its own gate for its next restart. A `senderRoleGate` still in that file is now ignored (the launcher
logs a warning). At the dashboard's start a one-time move copies those values into the store: it runs only while the
store file does not exist, and then writes it (`{}` when no agent had a gate), so a value an agent writes into its
own `agent-config.json` later never reaches the store. An unreadable store fails closed: every sub-agent's gate is
wired with a malformed policy (every tool denied in a member turn), and no agent gets the team scope.

The value, for one agent:

```json
"senderRoleGate": {
  "riskyTools": ["mcp__ms365__send_mail", "mcp__ms365__create_draft_email", "Bash"],
  "roles": [
    { "channel": "telegram", "sender": "<owner's Telegram user id>", "role": "owner" },
    { "channel": "teams", "sender": "<owner's AAD object id>", "role": "owner" }
  ],
  "senderKeys": { "slack": "user_id" }
}
```

- `riskyTools`: glob patterns (case-sensitive). `-` and `_` are the same character here, so
  `mcp__ms365__send_mail` also covers the Graph MCP's `mcp__ms365__send-mail`.
- `allowTools`: optional, glob patterns as above. In a member turn every tool that does NOT match is denied
  too, so a tool installed later is closed for a colleague by default, not open. It adds to `riskyTools`
  (a tool on both is denied). Its presence alone turns the gate on, and an empty list allows nothing in a
  member turn. Meant for an agent that serves its owner and a team chat in one session (below).
- `roles`: who is an owner. Anyone else is a member.
- `senderKeys`: optional, for a channel other than Telegram and Teams: which envelope attribute holds the
  sender id.

The key is off by default. With the key missing, or `riskyTools` missing or empty and no `allowTools`, the
hook is not wired at all. At the agent's start the launcher copies the `senderRoleGate` value onto the hook's command line in the
generated `.claude/settings.json` (`--policy`, base64url), next to every other gate, so a change to the table
takes effect at the agent's next start.

Fail-closed: a malformed `senderRoleGate` value treats every tool as risky and every chat sender as a member
(an owner at the terminal is still not blocked). An unreadable or empty transcript, a turn start that cannot be
confirmed within 64 MiB from the end, or a half-written or undecodable line inside the turn also count as a member
turn. A `roles` entry listed twice keeps the stricter role.

## The main agent, and a team chat in one session (gromzo)

The main agent has no `agents/<name>/agent-config.json`; its table lives in `store/main-agent-config.json`
(per install, gitignored), same shape (`{"senderRoleGate": {...}}`). At the main session's launch
(`scripts/channels.sh`, and the dashboard's respawn paths) the table rides the session-only `--settings` file
(`store/.main-extra-plugins.settings.json`, see `scripts/main-extra-plugins-settings.sh`) as a PreToolUse
hook, so the sub-agents, which read the install-root project settings, never get it. A change takes effect at
the main session's next start.

For the gromzo channel with `MXD_SCOPE=both` (the owner DM and the team in one session): the plugin writes the
sender's role and whether the owner's device is verified into the envelope as two attributes (`sender_role="owner"`
or `"colleague"`, and `verified="true"` or `"false"`). The owner is both together, so the sender key is the list of
the two (the sender is their values joined with `|`); and an envelope that states `verified` as anything but `"true"`
is never an owner's, whatever the keys say (GROMZOGATECONF1030: `sender_role="owner"` alone also comes from an
unverified device of the owner):

```json
"senderRoleGate": {
  "allowTools": ["mcp__plugin_gromzo-channel_gromzo__reply", "mcp__plugin_gromzo-channel_gromzo__typing", "ToolSearch"],
  "roles": [
    { "channel": "gromzo", "sender": "owner|true", "role": "owner" },
    { "channel": "slack", "sender": "<owner's Slack user id>", "role": "owner" }
  ],
  "senderKeys": { "gromzo": ["sender_role", "verified"], "slack": "user_id" }
}
```

A `store/main-agent-config.json` that exists but is not a readable JSON object (a truncated write, a hand
edit, not UTF-8) wires the gate anyway, with a policy the hook reads as malformed: in a non-owner's turn every
tool is denied. Only a missing file means no gate. (A sub-agent's unreadable `agent-config.json` still means no
gate; the main session differs because it may carry the team chat.)

Invariant: team messages reach a session only when gromzo is in its `--channels` list, and gromzo is never the
main channel provider (`ChannelProviderType` has no gromzo), so it reaches the main session only as an extra
(`CHANNEL_PLUGINS_EXTRA`). The launchers that add the extras (`scripts/channels.sh`, the dashboard respawns in
`channel-monitor.ts`) are the ones that write and pass this `--settings` file. `scripts/stuck-modal-guard.sh`
respawns with the main plugin only and no `--settings`: no gromzo inbound, no gate. Any new launch path that puts
gromzo into `--channels` must pass the same file.

`ToolSearch` belongs on the list: Claude Code defers MCP tools, so the agent must load the `reply` schema with
`ToolSearch` before it can call it. Without it a colleague's turn can never be answered (measured 2026-10-27, CLI
2.1.310, gromzo-channel 0.3.2: the gate denied `ToolSearch`, then the agent could not reply). It loads tool
definitions only, no data, and every tool it loads is still checked against this list when called. Stated out loud
(Dani 50795): with it, a colleague's turn can see the NAMES and descriptions of the installed tools (that a Gmail or
a Drive MCP exists, for example) and may mention them to the colleague. That is an inventory of the owner's setup,
not data from it; the tools themselves stay closed in that turn.

Every chat the session listens on needs its owner row: with `allowTools` set, a turn from a channel whose
owner is not listed is a member turn, and the owner there is held to the allow-list too. gromzo-channel must be
0.3.1 or later: 0.3.0 also put `source` into its meta, Claude Code (2.1.310) then writes a second `source`
attribute, and such an envelope counts as a member turn even for the owner.

What the gate does not cover in one session: what is already in the context. The owner profile in CLAUDE.md,
the loaded memory index, hook-injected blocks and the owner's earlier turns can reach a colleague's reply
without any tool. The plugin's instructions forbid it for a colleague's message; that is an instruction, not
a gate (the owner accepted this residual, 2026-10-27).

## Limits

- The restriction lasts one turn. Text a colleague sent in an earlier turn no longer restricts a later turn
  started by the owner, even if the model still has that text in its context.
- In `claude -p` (stream-json) runs a channel message leaves no line in the transcript at all (measured with
  CLI 2.1.296), so the gate cannot see it there. It is built for the interactive sessions the fleet runs.
- The main agent is covered only through `store/main-agent-config.json` (above), not through the dashboard's
  agent settings.
- A message the owner types at the terminal while the agent is working, if it begins with an envelope tag, counts
  as that sender's message for the rest of the turn (its enqueue line has no origin to tell it apart).
- An `agent-config.json` that is not valid JSON does not wire the hook (the launcher already treats such a file
  as broken).
- An agent that can write its own `agent-config.json` can change the table for its NEXT start, as it can every
  other key in that file (`toolDeny`, `capabilities`). The running gate is not affected.
- A chat plugin that writes an attribute value with an unescaped double quote makes that envelope unreadable,
  which counts as a member turn.
- On a risky call the hook reads the transcript backwards to the start of the previous turn, at most 64 MiB.
