---
name: ledger-live-drain
description: Every 2 minutes it checks whether an unanswered inbound message is left in the conversation ledger, and if so, brings it to the surface so that the running session replies to it without a respawn
---

Run it silently:

```bash
python3 {{PROJECT_ROOT}}/scripts/hooks/ledger-live-drain.py
```

- If the output is EMPTY: every inbound message has been answered. Do NOT do anything and do NOT write anything, stay silent.
- If the output is an `OPEN_QUESTION chat_id=... message_id=...` block: that is an inbound message from this channel that was lost earlier and is still unanswered. Read the text of the block, and reply to it NOW with the usual channel reply tool (to the chat_id given in the block), just as if it had arrived now.

The script is deterministic and safe: it does not bring up a question fresher than 60 seconds (it does not cut into a reply that is being written right now), and it brings the same message to the surface only once.
