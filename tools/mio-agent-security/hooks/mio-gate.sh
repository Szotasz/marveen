#!/bin/bash
# mio-gate.sh: PreToolUse gate for the marveen.io agent security package.
#
# MEASURED CONTRACT (Claude Code 2.1.220, probes in the package PR):
#   - PreToolUse CAN deny a tool call before it runs (permissionDecision).
#   - PostToolUse can only observe; it CANNOT withhold or replace the tool
#     output the model sees. Inbound filtering therefore cannot be a
#     post-hook sanitizer: this gate DENIES direct marveen.io fetches and
#     routes the agent to the mio-fetch wrapper, which sanitizes BEFORE
#     anything reaches the model.
#
# What it does:
#   WebFetch to *.marveen.io            -> deny, use mio-fetch
#   Bash command touching marveen.io    -> deny, unless it is a mio-fetch /
#                                          mio-upload wrapper invocation
#   everything else                     -> untouched (exit 0, no output)
#
# Known limit (by design, see README): this runs on the MEMBER's machine and
# protects a good-faith agent from being steered; a hostile local user can
# remove it. Bash matching is heuristic; obfuscated commands can evade it.
set -uo pipefail

IN="$(cat)"

MIO_HOOK_INPUT="$IN" python3 - << 'PYEOF'
import json, os, re, sys

data = json.loads(os.environ["MIO_HOOK_INPUT"])
tool = data.get("tool_name", "")
tool_input = data.get("tool_input", {}) or {}

PLATFORM = re.compile(r"(?i)(^|[./@])marveen\.io\b")

def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)

if tool == "WebFetch":
    url = str(tool_input.get("url", ""))
    if PLATFORM.search(url):
        deny("mio-gate: direct fetch of marveen.io content is blocked. "
             "Use the sanitizing wrapper instead: mio-fetch <url>")

if tool == "Bash":
    cmd = str(tool_input.get("command", ""))
    if PLATFORM.search(cmd):
        if re.search(r"(^|[\s/;|&])mio-(fetch|upload)(\s|$)", cmd):
            sys.exit(0)  # wrapper invocation, allowed
        deny("mio-gate: direct network access to marveen.io is blocked. "
             "Read via 'mio-fetch <url>', upload via 'mio-upload <file>'.")

sys.exit(0)
PYEOF
