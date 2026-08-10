#!/usr/bin/env python3
"""UserPromptSubmit hook: write a minimal task-state stub when a prompt arrives
and no live record exists for the agent.

Problem solved: the agent-taskstate record is normally written by the PreCompact
hook, which only runs at heartbeat time. An early crash (before the first
heartbeat) leaves nothing to replay at SessionStart, so context is lost.
This hook closes the gap by writing a thin stub at prompt-arrival time.

Guard (CRITICAL): only writes when no live record exists (no file, or
consumed=true). Never overwrites an agent-written live record (consumed=false),
no matter how thin it looks. The pendingDecision field is irreplaceable without
Janos input, so we must not clobber it.

Stub is marked with stub=true so future code can distinguish it from a
heartbeat-written record. The PreCompact heartbeat write always supersedes:
it also sets consumed=false + fresh ts (atomic overwrite), so the richer record
replaces the stub on the next heartbeat cycle.

Pattern: deterministic, token-free, fail-open (always exit 0). Never blocks the
prompt.
"""
import sys
import os
import json
import re
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


SUMMARY_MAX = 120
NEXT_ACTION = (
    "[GEPI CSONK] A keres feldolgozasa folyamatban. "
    "Nincs visszatoltendo kontextus -- ez az elso prompt a heartbeat elott keletkezett."
)

# Wrapper patterns: the real task content lives INSIDE these tags.
# The surrounding notice text (SCHEDULED TASK NOTICE -- the next <scheduled-task
# source="..."> ... </scheduled-task>) also contains a truncated <scheduled-task>
# placeholder with source="..." -- the negative lookahead skips it.
_CHANNEL_RX = re.compile(
    r'<channel\s+source="plugin:telegram:telegram"[^>]*>(.*?)</channel>',
    re.DOTALL,
)
_SCHEDULED_TASK_RX = re.compile(
    r'<scheduled-task\s+source="(?!\.\.\.)[^"]*">(.*?)</scheduled-task>',
    re.DOTALL,
)
_TRUSTED_PEER_RX = re.compile(
    r'<trusted-peer\s+[^>]*>(.*?)</trusted-peer>',
    re.DOTALL,
)


def _install_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _taskstate_dir():
    # Test override: TASKSTATE_DIR_OVERRIDE lets tests point at a temp dir.
    override = os.environ.get("TASKSTATE_DIR_OVERRIDE")
    if override:
        return override
    return os.path.join(_install_dir(), "store", "agent-taskstate")


def _record_path(agent_id):
    safe = re.sub(r"[^a-zA-Z0-9_-]", "", agent_id)
    return os.path.join(_taskstate_dir(), f"{safe}.json")


def _has_live_record(agent_id):
    """True when a non-consumed record exists -- do not overwrite."""
    path = _record_path(agent_id)
    if not os.path.exists(path):
        return False
    try:
        with open(path) as f:
            data = json.load(f)
        return not data.get("consumed", False)
    except Exception:
        return False  # unreadable -> treat as absent, allow stub


def _write_stub(agent_id, summary):
    stub = {
        "agent": agent_id,
        "doneSteps": [],
        "alreadyDelegated": [],
        "nextAction": NEXT_ACTION,
        "pendingDecision": "",
        "summary": summary,
        "ts": int(time.time() * 1000),
        "consumed": False,
        "stub": True,  # machine-generated; PreCompact heartbeat supersedes this
    }
    store_dir = _taskstate_dir()
    os.makedirs(store_dir, exist_ok=True)
    path = _record_path(agent_id)
    tmp = path + ".stub.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(stub, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)  # atomic on POSIX


def _first_line(text, max_len=SUMMARY_MAX):
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line[:max_len]
    return ""


_WRAPPER_FALLBACKS = [
    (_CHANNEL_RX,        "[Telegram uzenet]"),
    (_SCHEDULED_TASK_RX, "[Utemezett feladat]"),
    (_TRUSTED_PEER_RX,   "[Inter-agent uzenet]"),
]


def _extract_summary(text, max_len=SUMMARY_MAX):
    """Extract a meaningful first line from potentially wrapped prompt text.

    Real prompts are often wrapped in structured tags whose header text
    (e.g. "SCHEDULED TASK NOTICE -- the next ...") would be a useless summary.
    We extract from the innermost wrapper content in priority order.
    When a wrapper matches but the inner content is empty (e.g. image-only
    Telegram message), we return a type-specific placeholder so the tag header
    never leaks into the summary.
    """
    for rx, placeholder in _WRAPPER_FALLBACKS:
        m = rx.search(text or "")
        if m:
            inner = _first_line(m.group(1), max_len)
            return inner if inner else placeholder
    return _first_line(text, max_len)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    try:
        agent_id = ledger_lib.agent_id_from_cwd(payload.get("cwd"))
        prompt = payload.get("prompt") or ""

        if _has_live_record(agent_id):
            sys.exit(0)  # live record -- do not touch

        summary = _extract_summary(prompt)
        if not summary:
            sys.exit(0)  # nothing meaningful to stub

        _write_stub(agent_id, summary)
    except Exception:
        pass  # never block the prompt on any error

    sys.exit(0)


if __name__ == "__main__":
    main()
