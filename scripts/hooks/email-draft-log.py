#!/usr/bin/env python3
"""PostToolUse hook: one daily-log line for agent brainy when an agent wrote an
e-mail DRAFT (card f90928e3, part B, AC17).

    [Levélvázlat] <to>, tárgy: <subject, max 80 chars>, <YYYY-MM-DD HH:MM Europe/Budapest>

The sibling of the "[Levél elküldve]" line scripts/graph-mail.ts writes after a
send. The entry belongs to brainy whichever agent wrote the draft (Brainy's
decision): it is the coordinator's journal, not the writing agent's.

WHAT IS A DRAFT: exactly what email-approval-gate.py calls one. The gate's own
functions are imported (scope_kind + owner_cc_scope, the pair its owner-CC check
uses), not re-implemented, so a call cannot be a draft for the gate and a send
for this hook. A draft is a draft-writing tool other than update_draft, or a
manage_email call with a literal draft true / "true" (the gate's strict
_is_explicit_draft). A Bash call is never a draft: the gate has no draft notion
for Bash.

WHAT IT NEVER DOES: block, alter or decide anything. It always exits 0, prints
nothing on stdout (no decision JSON), and reports problems on stderr only. It
writes nothing for a failed tool result (PostToolUseFailure, is_error / isError,
an "Error..." text), an unknown tool, or an unreadable payload. The entry holds
the recipients (to only, like the send entry), the subject and the time: never
the body, cc, bcc or an attachment.

Timeout 2 s on the dashboard POST. Run: python3 email-draft-log.py < payload.json
"""
import importlib.util
import json
import os
import re
import sys
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

LOG_AGENT = "brainy"
SUBJECT_MAX = 80
RECIPIENTS_MAX = 10
RECIPIENT_CHARS_MAX = 120
POST_TIMEOUT_S = 2
# The live CDP browser and its sibling: never a dashboard, never touched.
FORBIDDEN_PORTS = (18800, 18899)


def _note(msg: str) -> None:
    sys.stderr.write(f"email-draft-log: {msg}\n")


def _load_gate():
    """email-approval-gate.py (dashed name: by path). Its top level only reads
    settings; main() runs under __main__ alone, so importing does not gate."""
    spec = importlib.util.spec_from_file_location(
        "email_approval_gate", os.path.join(_HERE, "email-approval-gate.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _looks_failed(payload: dict) -> bool:
    """True unless the payload shows a completed, non-error tool call."""
    if payload.get("hook_event_name") == "PostToolUseFailure":
        return True
    if "tool_response" not in payload or payload["tool_response"] is None:
        return True
    resp = payload["tool_response"]

    def err_text(t) -> bool:
        return isinstance(t, str) and t.lstrip().lower().startswith("error")

    if isinstance(resp, dict):
        if resp.get("is_error") or resp.get("isError") or resp.get("error"):
            return True
        content = resp.get("content")
        resp = content if isinstance(content, (list, str)) else ""
    if isinstance(resp, str):
        return err_text(resp)
    if isinstance(resp, list):
        for block in resp:
            if isinstance(block, dict):
                if block.get("is_error") or block.get("isError") or err_text(block.get("text")):
                    return True
    return False


def _clean(text) -> str:
    return re.sub(r"\s+", " ", str(text)).strip()


def _subject(tool_input: dict) -> str:
    chars = list(_clean(tool_input.get("subject") or ""))
    if not chars:
        return "(nincs tárgy)"
    if len(chars) <= SUBJECT_MAX:
        return "".join(chars)
    return "".join(chars[:SUBJECT_MAX - 1]) + "…"


def _recipients(tool_input: dict) -> str:
    v = tool_input.get("to")
    raw = v if isinstance(v, (list, tuple)) else [v]
    got = [_clean(x)[:RECIPIENT_CHARS_MAX] for x in raw if x not in (None, "") and _clean(x)]
    if not got:
        return "(nincs címzett)"
    more = len(got) - RECIPIENTS_MAX
    shown = ", ".join(got[:RECIPIENTS_MAX])
    return shown + (f" (+{more})" if more > 0 else "")


def _budapest_now() -> str:
    from datetime import datetime
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/Budapest")).strftime("%Y-%m-%d %H:%M")
    except Exception:  # noqa: BLE001 -- no tz database: the host clock is Budapest on this install
        return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")


def entry_text(tool_input: dict) -> str:
    return f"[Levélvázlat] {_recipients(tool_input)}, tárgy: {_subject(tool_input)}, {_budapest_now()}"


def _post(gate, text: str) -> None:
    """Raises on any failure; the caller turns it into one stderr line."""
    with open(os.path.join(gate.STORE_DIR, ".dashboard-token"), encoding="utf-8") as fh:
        token = fh.read().strip()
    if not token:
        raise RuntimeError("empty dashboard token")
    port = int(gate._install_setting("WEB_PORT", "3420"))
    if not 1 <= port <= 65535 or port in FORBIDDEN_PORTS:
        raise RuntimeError(f"refused WEB_PORT {port}")
    body = json.dumps({"agent_id": LOG_AGENT, "content": text}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/daily-log", data=body, method="POST",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=POST_TIMEOUT_S) as resp:
        code = getattr(resp, "status", None) or resp.getcode()
        if not 200 <= int(code) < 300:
            raise RuntimeError(f"HTTP {code}")


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:  # noqa: BLE001
        return
    if not isinstance(payload, dict):
        return
    tool = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input")
    if not tool or tool == "Bash" or not isinstance(tool_input, dict):
        return
    gate = _load_gate()
    if not gate._MAYBE_MAIL_TOOL.search(tool):
        return
    kind = gate.scope_kind(tool)
    if kind is None:
        return
    is_draft, is_send = gate.owner_cc_scope(tool, kind, tool_input)
    if not is_draft or is_send:
        return
    if _looks_failed(payload):
        return
    _post(gate, entry_text(tool_input))


if __name__ == "__main__":
    try:
        main()
    except BaseException as exc:  # noqa: BLE001 -- a log hook must never block a tool call
        _note(f"nem készült napló-bejegyzés ({type(exc).__name__}: {str(exc)[:200]})")
    sys.exit(0)
