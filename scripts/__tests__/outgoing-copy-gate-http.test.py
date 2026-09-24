#!/usr/bin/env python3
"""GATEHTTP924: the copy gate audits human-facing HTTP sends made with curl.

Before this, the Bash arm recognised exactly one kind of send (email). A curl
to the community API, to Discord's REST API or to the Telegram Bot API left
with no audit at all: measured 2026-09-24, an em-dash comment passed exit 0 on
all three, while the same text through the Telegram reply tool was blocked.

Contract pinned here:
  - a SEND (POST/PUT/PATCH, or an implicit POST from a data flag) to a covered
    target is audited: em dash -> exit 2, clean prose -> exit 0;
  - all three body shapes are read: inline -d, @file, quoted heredoc (@-);
  - an unreadable body (run-time substitution) BLOCKS (fail-closed);
  - a READ (GET of the feed, getUpdates) passes untouched;
  - /api/messages (inter-agent, federation) is NOT pulled into the full audit:
    it keeps its own homoglyph-only gate;
  - the community API is recognised by its PATH even when the base URL is an
    unresolved shell variable ($B/feed/...), the everyday vault-held form.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")

BAD = "Szia, ez egy teszt — gondolatjellel."
GOOD = "Szia, ez egy rendes mondat, gondolatjel nélkül."


def run_gate(cmd: str) -> int:
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    proc = subprocess.run([sys.executable, GATE], input=payload.encode(), capture_output=True)
    return proc.returncode


tmp = tempfile.mkdtemp(prefix="cghttp-")
bad_file = os.path.join(tmp, "bad.json")
good_file = os.path.join(tmp, "good.json")
with open(bad_file, "w", encoding="utf-8") as fh:
    json.dump({"content": BAD}, fh, ensure_ascii=False)
with open(good_file, "w", encoding="utf-8") as fh:
    json.dump({"content": GOOD}, fh, ensure_ascii=False)

MIO = "https://api.marveen.io/agent/v1"
CASES = [
    # community API
    ("community comment, inline -d, em dash BLOCKS",
     f"curl -s -X POST {MIO}/feed/posts/abc/comments -d '{json.dumps({'content': BAD})}'", 2),
    ("community comment, inline -d, clean passes",
     f"curl -s -X POST {MIO}/feed/posts/abc/comments -d '{json.dumps({'content': GOOD})}'", 0),
    ("community new post, quoted heredoc, em dash in content BLOCKS",
     f"curl -s {MIO}/feed/posts --data-binary @- <<'JSON'\n"
     + json.dumps({"title": "Cim", "content": BAD}) + "\nJSON", 2),
    ("community comment via $B base + @file, em dash BLOCKS",
     f'curl -s -X POST "$B/feed/posts/abc/comments" --data-binary @{bad_file}', 2),
    ("community comment via $B base + @file, clean passes",
     f'curl -s -X POST "$B/feed/posts/abc/comments" --data-binary @{good_file}', 0),
    ("community mention reply, em dash BLOCKS",
     f"curl -s -X POST {MIO}/mentions/m1/reply -d '{json.dumps({'content': BAD})}'", 2),
    ("community body from $(...) is unreadable -> BLOCKS (fail-closed)",
     f'curl -s -X POST {MIO}/feed/posts -d "{{\\"content\\":\\"$(cat x)\\"}}"', 2),
    ("community feed READ passes untouched",
     f"curl -s -H 'Authorization: Bearer K' '{MIO}/feed?limit=10'", 0),
    ("community bare POST without a body passes (nothing of ours is sent)",
     f"curl -s -X POST {MIO}/feed/posts/abc/comments", 0),
    # Discord REST
    ("Discord REST message, em dash BLOCKS",
     "curl -s -X POST https://discord.com/api/v10/channels/1/messages "
     f"-H 'Authorization: Bot X' -d '{json.dumps({'content': BAD})}'", 2),
    ("Discord REST message edit (PATCH), em dash BLOCKS",
     "curl -s -X PATCH https://discord.com/api/v10/channels/1/messages/2 "
     f"-d '{json.dumps({'content': BAD})}'", 2),
    ("Discord REST history READ passes",
     "curl -s https://discord.com/api/v10/channels/1/messages?limit=5", 0),
    # Telegram Bot API
    ("Telegram sendMessage, form-encoded text behind a second -d, em dash BLOCKS",
     f"curl -s https://api.telegram.org/botXYZ/sendMessage -d chat_id=1 -d text='{BAD}'", 2),
    ("Telegram sendMessage, clean passes",
     "curl -s https://api.telegram.org/botXYZ/sendMessage -d chat_id=1 -d text='Rendes mondat.'", 0),
    ("Telegram getUpdates READ passes",
     "curl -s https://api.telegram.org/botXYZ/getUpdates", 0),
    # scope boundary
    ("inter-agent /api/messages stays OUT of the full audit (homoglyph-only gate)",
     "curl -s -X POST http://localhost:3420/api/messages "
     f"-d '{json.dumps({'from': 'a', 'to': 'b', 'content': BAD})}'", 0),
    ("an unrelated POST is not a channel send",
     f"curl -s -X POST https://example.com/api/items -d '{json.dumps({'content': BAD})}'", 0),
]

failed = []
for name, cmd, want in CASES:
    got = run_gate(cmd)
    ok = got == want
    if not ok:
        failed.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: exit={got} want={want}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All outgoing-copy-gate HTTP-channel tests passed.")
