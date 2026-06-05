# channel-reply-guard — Stop hook

## Problem

A Marveen agent that talks to a user over a channel (Telegram / Slack / Discord)
sometimes *generates* its reply as plain text but forgets to call the channel
send-tool. When that happens the answer only lands in the CLI transcript and
**never reaches the user** — the user is left waiting, with no idea whether the
agent is working or stuck.

## What the hook does

`scripts/channel-reply-guard.sh` runs on the `Stop` event. At the end of every
turn it checks:

1. Did the **last user message come from a channel**? (It looks for the
   `<channel source="plugin:telegram...">` / `← telegram` markers.)
2. If so, was there a **channel send-tool call** after that message?
   (Any tool whose name contains `telegram`, `reply`, `slack`, or `discord`.)

If the message was from a channel but **no send-tool was called**, the hook
returns `{"decision":"block"}` with a reminder, so the model sends the reply
before the turn ends.

Heartbeat / scheduled-task prompts (where staying silent is correct) are
explicitly skipped — they may end without a send.

## How to enable it

Add it to the `Stop` hooks in your `.claude/settings.json` (alongside any
existing Stop hooks):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/scripts/channel-reply-guard.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

(Use an absolute path if `${CLAUDE_PROJECT_DIR}` is not available in your setup.)

After editing `settings.json`, open the `/hooks` menu once (or restart the
session) so the hook is picked up.

## Relation to #210

PR #210 stops sub-agents from stealing the Telegram poller and lets heartbeats
answer direct messages — it protects the *inbound* path. This hook protects the
*outbound* path: it guarantees the agent's reply actually leaves through the
channel. The two are complementary.
