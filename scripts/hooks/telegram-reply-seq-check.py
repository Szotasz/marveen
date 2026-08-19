#!/usr/bin/env python3
"""PreToolUse hook: MECHANICALLY block mcp__plugin_telegram_telegram__reply
calls whose "text" does not start with "{N} " (a sequence number in curly
braces, from scripts/tg-seq.sh).

Root cause this fixes: the "every outgoing Telegram message starts with
{szám}" rule lived only as prose (CLAUDE.md + memory) and self-reminders --
and was manually forgotten SIX times in a single session on 2026-08-18/19
despite two separate "mostantól figyelek rá" promises. Prose-based
self-enforcement demonstrably does not work for this pattern; this hook
moves it from "documented" to "enforced", the same fix already applied to
the "always reply on Telegram" rule via telegram-reply-guard.py (Stop hook).

Safety: only ever blocks the ONE tool call that violates the format. Any
internal error in this hook -> fail-open (exit 0, allow), so a bug here can
never wedge the session -- consistent with every other hook in this
directory.
"""
import sys
import json
import re

SEQ_RX = re.compile(r"^(?:\{\d+\}|\\\{\d+\\\})\s")


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if payload.get("tool_name") != "mcp__plugin_telegram_telegram__reply":
        sys.exit(0)

    tool_input = payload.get("tool_input") or {}
    text = tool_input.get("text")
    if text is None:
        sys.exit(0)  # no text param (e.g. file-only reply) -- nothing to check

    if SEQ_RX.match(text):
        sys.exit(0)  # correct format -> allow

    reason = (
        "🛑 A Telegram-válasz szövege NEM '{szám} '-mal kezdődik. "
        "Előbb futtasd: bash /Users/ceo/Marveen/scripts/tg-seq.sh -- "
        "majd illeszd a kapott számot a szöveg ELEJÉRE '{N} ' alakban, "
        "és hívd újra a reply toolt. (Ez a hívás blokkolva, nem ment ki.)"
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
