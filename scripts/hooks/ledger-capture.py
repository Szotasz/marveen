#!/usr/bin/env python3
"""UserPromptSubmit hook: capture inbound channel messages into the rolling
transcript (direction='in') BEFORE the agent processes the prompt. Deterministic
and agent-independent. agent_id is derived from the session's cwd so the hook is
generic across all three channel agents and never cross-contaminates. Never
blocks the prompt (always exit 0).

PROVIDER-AGNOSTIC: every channel plugin emits the same <channel source="..">
envelope, so the capture matches any `plugin:<provider>:<name>` source rather
than one hardcoded provider. Hardcoding a single provider silently drops the
whole conversation on every other channel -- and the failure is invisible,
because the replay still produces a non-empty block from the one provider that
IS captured.
"""
import sys
import os
import json
import re
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

# <channel source="plugin:telegram:telegram" chat_id="X" message_id="Y" ... ts="Z">
#   TEXT
# </channel>
# The source is `plugin:<provider>:<server>` for every channel plugin
# (telegram, discord, slack, ...). Matching the shape instead of one literal
# keeps a new provider working without a code change.
CHANNEL_RX = re.compile(
    r'<channel\s+source="plugin:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+"([^>]*)>(.*?)</channel>',
    re.DOTALL,
)


def _trace(reason, **fields):
    """One line, and ONLY when the hook ran and stored nothing.

    WHY: every failure path in this hook is silent. A regex miss, a missing
    chat_id/message_id, a ledger exception and an unparseable payload all leave
    the same trace -- none. So "the hook never ran" and "it ran and matched
    nothing" are indistinguishable from outside, and a gap in the transcript
    cannot be attributed to either. That is not a gap in someone's diligence: it
    is a property of the code, and it makes the question unanswerable rather
    than merely unanswered.

    Measured on one install, 2026-09-04: in a 42-minute window the ledger held
    six outbound replies and one inbound row, and 12 of the 19 Telegram
    message_ids spanning it were unaccounted for. The loss is one-directional --
    a missing inbound row can only ever produce a false "they never replied",
    never a false "answered" -- so the visible cost is the owner being asked a
    question they already answered.

    Deliberately ONLY on the empty outcome: the happy path stays silent, so this
    costs nothing in the common case and every line written is a question worth
    asking. COUNTS ONLY, never message text -- the trace must not become a second
    copy of the transcript.
    """
    try:
        path = os.path.join(os.path.dirname(ledger_lib.db_path()),
                            "ledger-capture-trace.log")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("%s\t%s\t%s\n" % (
                time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                reason,
                " ".join("%s=%s" % kv for kv in sorted(fields.items())),
            ))
    except Exception:
        pass  # a trace must never block the prompt either


def _attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        _trace("payload-unparseable")
        sys.exit(0)
    agent_id = ledger_lib.agent_id_from_payload(payload)
    prompt = payload.get("prompt") or ""
    matched = stored = skipped = failed = 0
    for m in CHANNEL_RX.finditer(prompt):
        matched += 1
        attrs, text = m.group(1), m.group(2)
        chat_id = _attr(attrs, "chat_id")
        message_id = _attr(attrs, "message_id")
        ts = _attr(attrs, "ts")
        # Voice / video_note that arrived WITHOUT a transcript keeps its
        # attachment identity in the ledger, so a respawned session can still
        # download + transcribe it (the STT-success path strips these attrs and
        # carries the transcript in the body instead, so nothing is stored then).
        att_kind = _attr(attrs, "attachment_kind")
        att_file_id = _attr(attrs, "attachment_file_id")
        if chat_id and message_id:
            try:
                ledger_lib.log_inbound(
                    agent_id, chat_id, message_id, text.strip(), ts,
                    attachment_kind=att_kind, attachment_file_id=att_file_id,
                )
                stored += 1
            except Exception as exc:
                failed += 1
                _trace("ledger-error", agent=agent_id, err=type(exc).__name__)
                # never block the prompt on a ledger error
        else:
            skipped += 1
    if stored == 0:
        # `has_tag` separates "no channel wrapper reached this prompt at all"
        # from "one did and nothing came of it" -- the same distinction the
        # counts below make within a matched wrapper.
        _trace("no-row", agent=agent_id, matched=matched, skipped=skipped,
               failed=failed, prompt_len=len(prompt),
               has_tag=int("<channel" in prompt))
    sys.exit(0)


if __name__ == "__main__":
    main()
