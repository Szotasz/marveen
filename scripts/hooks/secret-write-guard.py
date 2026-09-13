#!/usr/bin/env python3
"""PreToolUse hook: block writing a LITERAL secret value into a file.

An agent that pastes a real credential into source (a leaked private key, an AWS
access key, an Anthropic/OpenAI/GitHub/Slack token) is one `git add` away from
committing it. This guard inspects the CONTENT an agent is about to Write/Edit and
blocks (exit 2) only on a HIGH-CONFIDENCE literal secret -- a key block or a
provider token with an unmistakable prefix. It is deliberately narrow:

  - It matches secret VALUES, never references. `cat store/.dashboard-token`,
    `Bearer $(...)`, `process.env.X`, a `.env.example` placeholder -> NOT a match.
  - Anything it cannot parse -> FAIL-OPEN (exit 0). A guard that crashes must
    never wedge the fleet, so every error path allows the write.

Only Write / Edit / MultiEdit carry file content; other tools are ignored. On a
match it prints the offending pattern name to stderr (shown to the agent) and
exits 2 so the write is denied and the agent can route the secret to a real
secret store or reference it by env/id instead.
"""
import sys
import os
import re
import json

# High-confidence literal-secret signatures. Each is specific enough that a match
# is almost never a false positive. Order/name is what the agent sees on block.
PATTERNS = [
    ("private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    ("AWS access key id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("OpenAI API key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9]{40,}")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}")),
    ("Slack token", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Stripe live secret key", re.compile(r"\bsk_live_[0-9A-Za-z]{24,}")),
]

# Placeholder / example values that legitimately look secret-ish. If the matched
# span is one of these, it is not a real leak -> allow.
PLACEHOLDER_RX = re.compile(r"(?:EXAMPLE|XXXX|PLACEHOLDER|YOUR[_-]?|\.\.\.|<[^>]+>)", re.IGNORECASE)


def _content_from(tool_name, tool_input):
    """Extract the text this tool would write into a file, or '' if none."""
    if not isinstance(tool_input, dict):
        return ""
    parts = []
    # Write
    if isinstance(tool_input.get("content"), str):
        parts.append(tool_input["content"])
    # Edit: the replacement is what lands on disk
    if isinstance(tool_input.get("new_string"), str):
        parts.append(tool_input["new_string"])
    # MultiEdit
    edits = tool_input.get("edits")
    if isinstance(edits, list):
        for e in edits:
            if isinstance(e, dict) and isinstance(e.get("new_string"), str):
                parts.append(e["new_string"])
    return "\n".join(parts)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unparseable -> fail open

    tool = payload.get("tool_name") or ""
    if tool not in ("Write", "Edit", "MultiEdit"):
        sys.exit(0)

    try:
        content = _content_from(tool, payload.get("tool_input"))
    except Exception:
        sys.exit(0)
    if not content:
        sys.exit(0)

    for name, rx in PATTERNS:
        m = rx.search(content)
        if not m:
            continue
        span = m.group(0)
        # Skip obvious placeholders/examples.
        window = content[max(0, m.start() - 20): m.end() + 20]
        if PLACEHOLDER_RX.search(window):
            continue
        sys.stderr.write(
            "SECRET-WRITE-GUARD: a beirni kivant tartalom valodinak tuno titkot "
            f"tartalmaz ({name}). A muvelet blokkolva. Ne irj literal kredencialt "
            "fajlba: hasznalj kornyezeti valtozot / secret store-t, vagy hivatkozz "
            "id-vel (pl. $(cat store/.dashboard-token)). Ha ez szandekos teszt-adat, "
            "tedd .env.example-be placeholderrel."
        )
        sys.exit(2)  # block

    sys.exit(0)


if __name__ == "__main__":
    main()
