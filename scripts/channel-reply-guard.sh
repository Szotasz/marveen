#!/bin/bash
# channel-reply-guard — Stop hook
#
# When the last user message came from a channel (Telegram/Slack/Discord) but the
# turn ended WITHOUT a channel send-tool call, this hook blocks the stop and asks
# the model to actually send the reply — instead of only generating it as text
# into the CLI transcript, where the user never sees it.
#
# Reads the Stop event's stdin JSON for transcript_path, inspects the last user
# message and the assistant tool calls produced after it.

INPUT=$(cat)

python3 - "$INPUT" << 'PYEOF'
import json, sys, os

try:
    data = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)  # unparseable input -> do not block

transcript = data.get("transcript_path", "")
if not transcript or not os.path.exists(transcript):
    sys.exit(0)

# Tool-name fragments that mean an actual channel send
SEND_TOOLS = ("telegram", "reply", "slack", "discord")

try:
    lines = open(transcript, encoding="utf-8").read().splitlines()
except Exception:
    sys.exit(0)

# Walk events; remember the index of the last user message.
events = []
last_user_idx = None
for ln in lines:
    if not ln.strip():
        continue
    try:
        ev = json.loads(ln)
    except Exception:
        continue
    events.append(ev)
    role = ev.get("message", {}).get("role") or ev.get("role")
    if role == "user":
        last_user_idx = len(events) - 1

if last_user_idx is None:
    sys.exit(0)

def text_of(ev):
    msg = ev.get("message", ev)
    c = msg.get("content", "")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)
    return str(c)

user_text = text_of(events[last_user_idx])
is_channel = (
    'source="plugin:telegram' in user_text
    or '<channel source=' in user_text
    or '← telegram' in user_text  # "← telegram"
)
if not is_channel:
    sys.exit(0)  # not a channel message -> nothing to enforce

# Heartbeat / scheduled-task prompts may legitimately stay silent.
if (
    'scheduled-task:' in user_text
    or '[Heartbeat:' in user_text
    or 'untrusted source="scheduled-task' in user_text
):
    sys.exit(0)

# Was there a channel send-tool call after the last user message?
sent = False
for ev in events[last_user_idx + 1:]:
    msg = ev.get("message", ev)
    content = msg.get("content", [])
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "tool_use":
                name = (part.get("name") or "").lower()
                if any(t in name for t in SEND_TOOLS):
                    sent = True
                    break
    if sent:
        break

if sent:
    sys.exit(0)

# No channel send -> block and remind the model.
print(json.dumps({
    "decision": "block",
    "reason": (
        "The user's last message arrived from a channel (Telegram/Slack/Discord), "
        "but this turn did NOT call the channel send-tool (e.g. the telegram reply "
        "tool). Your text answer only went into the CLI transcript and never reached "
        "the user. Send the reply NOW via the channel send-tool (use the chat_id from "
        "the inbound <channel> tag)."
    )
}))
sys.exit(0)
PYEOF
