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

The sender id is read from the envelope: Telegram `user_id`, Teams `aad_object_id`. A sender who is not in the
table, a channel without a known sender attribute, an envelope with a repeated attribute, and a forged owner
envelope typed inside a colleague's message all make the turn a member turn.

## Configuration

Per agent, in `agents/<name>/agent-config.json`:

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
- `roles`: who is an owner. Anyone else is a member.
- `senderKeys`: optional, for a channel other than Telegram and Teams: which envelope attribute holds the
  sender id.

The key is off by default. With the key missing, or `riskyTools` missing or empty, the hook is not wired at
all. The launcher wires it at the agent's next start; edits to the table take effect on the next tool call.

Fail-closed: a malformed `senderRoleGate` value treats every tool as risky and every chat sender as a member
(an owner at the terminal is still not blocked). An unreadable or empty transcript, a turn start that cannot be
found within 64 MiB from the end, or a half-written line inside the turn also count as a member turn.

## Limits

- The restriction lasts one turn. Text a colleague sent in an earlier turn no longer restricts a later turn
  started by the owner, even if the model still has that text in its context.
- In `claude -p` (stream-json) runs a channel message leaves no line in the transcript at all (measured with
  CLI 2.1.296), so the gate cannot see it there. It is built for the interactive sessions the fleet runs.
- The main agent is not covered: the gate is wired for sub-agents only.
- An `agent-config.json` that is not valid JSON does not wire the hook (the launcher already treats such a file
  as broken).
- On a risky call the hook reads the transcript backwards to the start of the previous turn, at most 64 MiB.
