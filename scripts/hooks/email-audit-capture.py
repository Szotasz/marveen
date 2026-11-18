#!/usr/bin/env python3
"""PreToolUse + PostToolUse + PostToolUseFailure hook: record one audit row per
OUTGOING LETTER attempt (EMAILAUDIT1109, card 7df70b2e).

WHY THIS EXISTS. tool_call_log already logs every tool call, but for a send it
keeps a single field -- _input_summary's generic fallback, i.e. the first string
in the tool input, which is the recipient. Measured 2026-11-09 on six real
sends: 21..62 characters, recipient only. cc, bcc, subject, the provider's
message id, the approval that authorised it, and whether a gate refused the
send are all unrecoverable. That table is also pruned, so it cannot be an audit
trail under any schema.

THREE EVENTS, ONE ROW. The envelope is readable BEFORE the call; the result
only exists AFTER it. So the row is opened on PreToolUse and closed on
PostToolUse, correlated by Claude Code's tool_use_id -- the same key
tool_call_log.trace_id carries, present in both payloads. Neither half assumes
the other ran: the API upserts.

WHY NOT A POST-ONLY HOOK, which would need no correlation: a send a gate
BLOCKS fires no PostToolUse at all (TOOLLOGVAKSIKER921 measured the same shape
for failures: a blocked or failed call does not reach PostToolUse). The attempt
a gate refused is the single most audit-relevant event there is, and a Post-only
hook cannot see it. Such a row simply keeps outcome NULL, which the schema
documents as "no outcome was recorded" -- never as success.

IT NEVER BLOCKS. Every path exits 0, including a crash: this hook authorises
nothing, and an audit fault must not become a new way to lose a letter. That is
the opposite of email-approval-gate.py, which authorises and therefore denies
whenever it cannot decide. The cost of the choice is explicit: a write that
fails leaves a gap, and the gap is measurable (an outcome row whose intent_at is
NULL, or a missing row for a send tool_call_log did see).

WHY IT CALLS INTO THE GATE INSTEAD OF REIMPLEMENTING. classify_mail_tool,
collect_email_envelope and collect_subject come from email_extract.py (the
gates' own extractor), and the envelope anchor comes from
email-approval-gate.py's content_anchor -- loaded by path, because moving a
working security gate's hash function for an audit feature's convenience is a
change to the gate, which this card does not justify. A second implementation
of either would drift, and then the trail and the gate would disagree about
what was sent.
"""
import hashlib
import json
import os
import sys

# sqlite3, urllib.request and importlib.util are imported WHERE THEY ARE USED:
# on the Pre branch this hook starts for every tool call (matcher '*'), and
# only a real mail call ever needs them. Measured 2026-11-09 on this host:
# bare `python3 -I -S` start 6 ms, this hook with the full import set 44 ms
# (the already-shipped tool-log-capture.py measures 42 ms on the same payload).

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port() -> str:
    v = os.environ.get("WEB_PORT")
    if v and v.strip().isdigit():
        return v.strip()
    try:
        with open(os.path.join(_project_root(), ".env"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("WEB_PORT="):
                    p = line.split("=", 1)[1].strip()
                    if p.isdigit():
                        return p
    except Exception:
        pass
    return "3420"


def _token():
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token"), encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def _load_by_path(name: str, filename: str):
    """Load a hooks/ module whose file name is not a valid identifier."""
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _approval_id(anchor: str):
    """The approval whose content_hash is THIS envelope, newest first.

    Read-only, straight from the DB: there is no API endpoint for it, and the
    approvals path must stay out of reach of anything the agent can write. Both
    an already-consumed and a still-open approval count -- the gate consumes on
    allow, and the hook may run on either side of that.
    """
    if not anchor:
        return None
    import sqlite3
    db = os.path.join(_project_root(), "store", "claudeclaw.db")
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        row = con.execute(
            "SELECT id FROM approvals WHERE content_hash=? AND category IN "
            "('email_send','email_standing_recipient') ORDER BY requested_at DESC LIMIT 1",
            (anchor,),
        ).fetchone()
        con.close()
        return row[0] if row else None
    except Exception:
        return None


def _provider_message_id(resp):
    """Best-effort provider message id from a send's response.

    Shapes differ per server, so the known keys are tried and nothing is
    invented: an id that cannot be found stays None rather than becoming a
    guessed value in an audit column.
    """
    KEYS = ("messageId", "message_id", "id", "threadId", "draftId")
    if isinstance(resp, dict):
        for k in KEYS:
            v = resp.get(k)
            if isinstance(v, (str, int)) and str(v).strip():
                return str(v)[:200]
        for v in resp.values():
            if isinstance(v, dict):
                got = _provider_message_id(v)
                if got:
                    return got
    if isinstance(resp, list):
        for v in resp:
            got = _provider_message_id(v)
            if got:
                return got
    if isinstance(resp, str):
        import re
        m = re.search(r"(?:message[_ ]?id|messageId)[\"'\s:=]+([A-Za-z0-9_\-]{8,})", resp)
        if m:
            return m.group(1)[:200]
    return None


def _fallback_trace(payload: dict, anchor: str) -> str:
    """When the harness gives no tool_use_id, derive a key BOTH halves compute
    the same way: session + tool + envelope anchor. Prefixed so a derived key is
    never mistaken for a native one in the stored row."""
    seed = f"{payload.get('session_id') or ''}|{payload.get('tool_name') or ''}|{anchor}"
    return "derived:" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32]


def _post(body: dict) -> None:
    token = _token()
    if not token:
        return
    import urllib.request
    url = f"http://localhost:{_web_port()}/api/email-audit"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass  # never block the agent


def _is_bash_send(cmd: str) -> bool:
    """The Bash path has no tool name to classify, so the gate's own send
    recogniser decides. Its set is narrow by design (letters to humans); a
    command it does not recognise is simply not audited here, and that scope
    limit is the gate's, not this hook's."""
    if not cmd:
        return False
    try:
        gate = _load_by_path("email_approval_gate_for_audit", "email-approval-gate.py")
        is_send = gate._load_is_send_invocation()
        return bool(is_send(cmd))
    except Exception:
        return False


# PERFORMANCE PREFILTER, NOT A CLASSIFIER. On the Pre branch the matcher is '*',
# so this process starts for every tool call; without a cheap exit each one pays
# the import of email_extract and ledger_lib (measured: 44 ms vs a 6 ms bare
# start). The word list is deliberately WIDER than classify_mail_tool -- every
# name that classifier calls mail contains one of these words, and
# src/__tests__/email-audit-prefilter.test.ts runs the SHARED case list
# (scripts/hooks/mail-tool-name-cases.json) through both to keep it that way. A
# prefilter narrower than the classifier would reintroduce exactly the gap the
# gates were measured to have: a name-based filter that the Google Workspace
# tool names slipped past.
_MAIL_WORD_HINTS = ("mail", "message", "reply", "forward", "draft", "send")


def _maybe_mail_tool(tool_name: str) -> bool:
    # Bash always goes through: its command text, not its name, decides.
    if tool_name == "Bash":
        return True
    n = str(tool_name).lower().replace("-", "_")
    return any(w in n for w in _MAIL_WORD_HINTS)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return

    event = payload.get("hook_event_name") or ""
    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    if not tool_name:
        return
    if not _maybe_mail_tool(tool_name):
        return

    try:
        extract = __import__("email_extract")
    except Exception:
        return

    kind = extract.classify_mail_tool(tool_name)
    if kind is None:
        if tool_name != "Bash":
            return
        cmd = str(tool_input.get("command") or "") if isinstance(tool_input, dict) else ""
        if not _is_bash_send(cmd):
            return
        kind = "bash_send"

    # A draft is not an outgoing letter; it is audited by card 7330a32c's gate
    # logging, not here. Keeping it out means a row in this table always means
    # "something was meant to leave the building".
    if kind == "draft":
        return

    try:
        env = extract.collect_email_envelope(tool_name, tool_input)
    except Exception:
        env = {"to": [], "cc": [], "bcc": [], "text": "", "unreadable_reason": "extraction raised"}

    anchor = ""
    try:
        gate = _load_by_path("email_approval_gate_for_audit", "email-approval-gate.py")
        anchor = gate.content_anchor(env)
    except Exception:
        anchor = ""

    trace = payload.get("tool_use_id") or _fallback_trace(payload, anchor)

    try:
        ledger_lib = __import__("ledger_lib")
        agent_id = ledger_lib.agent_id_from_payload(payload)
    except Exception:
        agent_id = None

    common = {
        "trace_id": str(trace),
        "tool_name": tool_name,
        "mail_kind": kind,
        "agent_id": agent_id,
        "session_id": payload.get("session_id") or None,
    }

    if event == "PreToolUse":
        text = str(env.get("text") or "")
        _post({
            **common,
            "phase": "intent",
            "to": [str(x) for x in (env.get("to") or [])],
            "cc": [str(x) for x in (env.get("cc") or [])],
            "bcc": [str(x) for x in (env.get("bcc") or [])],
            "subject": extract.collect_subject(tool_name, tool_input),
            # The body is a digest, never the text: the trail answers who wrote
            # to whom about what, it is not a second copy of the mailbox.
            "body_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest() if text else None,
            "envelope_hash": anchor or None,
            "attachments": env.get("attachments") or None,
            "approval_id": _approval_id(anchor),
            "unreadable_reason": env.get("unreadable_reason") or None,
        })
        return

    # PostToolUse / PostToolUseFailure. The event name decides, exactly as in
    # tool-log-capture.py: a failed call never reaches PostToolUse, so a
    # response-shape check alone would mark every failure a success.
    resp = payload.get("tool_response")
    failed = event == "PostToolUseFailure" or (isinstance(resp, dict) and resp.get("is_error"))
    err = payload.get("error")
    _post({
        **common,
        "phase": "outcome",
        "outcome": "failed" if failed else "sent",
        "provider_message_id": None if failed else _provider_message_id(resp),
        "error_text": str(err)[:500] if err else None,
    })


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # an audit fault must never block a letter
    sys.exit(0)
