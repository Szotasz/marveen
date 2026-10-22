#!/usr/bin/env python3
"""Requester-side helper for the Telegram approval buttons.

The email approval gate (scripts/hooks/email-approval-gate.py) denies an unapproved send and tells
the agent to POST /api/approvals with the content_hash it computed. For the Telegram buttons to show
the WHOLE envelope, the request must also carry that envelope, bound to the hash. This helper builds
that request body from the very same PreToolUse-shaped input the gate sees, so the agent does not
assemble it by hand and cannot drift from the gate.

Usage:
  approval-envelope.py --agent <agent id> [--subject <subject>] < pretooluse.json
  stdin: {"tool_name": ..., "tool_input": {...}}, exactly what the gate receives.
  --subject: optional; it must be exactly the FIRST line of the extracted text (everything before the
             first newline). The extractor joins the subject and the body with one newline, so a
             subject that comes first (--subject before --body, a JSON payload's subject field) is that
             line, and the hash covers it. Anything else is refused: the server would show it as the
             subject. Bash path only: on the MCP send path the subject is the LAST field of the text,
             so the first line is the body's first line, and --subject is refused there (exit 2) even
             when it matches. The letter itself is shown in full either way.

Stdout (one JSON line, the POST /api/approvals body):
  {"agent_id", "category": "email_send", "content_hash", "action_description", "action_payload"}
  action_payload is a JSON STRING: {"envelope_v":1,"to":[..],"cc":[..],"bcc":[..],"text":"..",
  "subject"?:"..","html_sha256"?:"..","attachments"?:[{"name","sha256","size"}]}

Exit codes: 0 = body written; 2 = anything else (unreadable letter, not a send, bad input, a
dependency that does not load): stdout stays EMPTY and the reason goes to stderr.

The hash comes from the gate's own content_anchor() and the envelope from the gate's own extractor
(email_extract.collect_email_envelope), both loaded by importlib from scripts/hooks/. Neither file is
modified, and no logic is copied. The helper only reads: no network, no store, no secret. Run it as
`python3 -I` so the interpreter does not pick up modules from the working directory.
"""
import argparse
import importlib.util
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_HOOKS = os.path.join(_HERE, "hooks")
CATEGORY = "email_send"
_AGENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_HASH = re.compile(r"^[0-9a-f]{64}$")


def fail(msg):
    sys.stderr.write(f"approval-envelope: {msg}\n")
    sys.exit(2)


def _load(modname, filename):
    path = os.path.join(_HOOKS, filename)
    try:
        spec = importlib.util.spec_from_file_location(modname, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    except BaseException as exc:  # noqa: BLE001 -- SyntaxError, missing file, a dependency's sys.exit
        fail(f"a kapu fuggosege (scripts/hooks/{filename}) nem toltheto be ({exc!r})")
    return mod


def is_send(gate, tool, tool_input):
    """Is this call a send? The classifiers (scope_kind, manage_email_is_send, is_send_invocation)
    are the gate's own, imported. The BRANCHING that combines them is a rewrite of
    scripts/hooks/email-approval-gate.py main() (Bash -> is_send_invocation; any other tool ->
    scope_kind, where None and "draft" put nothing on the wire and manage_email counts only when
    it is a send), and must be kept in step with it; the parity tests pin the common cases, not
    future drift."""
    if tool == "Bash":
        return bool(gate._load_is_send_invocation()(str(tool_input.get("command") or "")))
    kind = gate.scope_kind(tool)
    if kind is None or kind == "draft":
        return False
    if kind == "manage_email":
        return bool(gate.manage_email_is_send(tool_input))
    return True


def build(payload, agent, subject, gate, extract):
    """Return the POST body dict, or exit 2 through fail()."""
    if not isinstance(payload, dict):
        fail("a bemenet nem JSON-objektum")
    tool = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input")
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    if not is_send(gate, tool, tool_input):
        fail(f"ez a hivas nem levelkuldes ({tool!r}) -- nincs mit jovahagyatni")

    env = extract.collect_email_envelope(tool, tool_input)
    if env.get("unreadable_reason"):
        fail(f"a level nem horgonyozhato: {env['unreadable_reason']}")
    if not str(env.get("text") or "").strip():
        fail("a hivasbol nem nyerheto ki level-szoveg")
    if not env.get("to"):
        fail("a hivasbol nem nyerheto ki cimzett")

    # MCP: the extractor puts the subject field LAST, so the first line is the body's. A --subject
    # matching it would label a body line as the subject: refuse it whatever it says.
    if subject is not None and tool != "Bash":
        fail("MCP-uton nem adhato --subject: ott a targy a szoveg vegen van, nem az elso sora "
             "(hagyd el a --subject-et)")
    if subject is not None and subject != env["text"].split("\n", 1)[0]:
        fail("a --subject nem a hash-elt szoveg elso sora (MCP-uton a targy a szoveg vegen van: "
             "hagyd el a --subject-et)")

    try:
        anchor = gate.content_anchor(env)
    except UnicodeEncodeError:
        fail("a level pareden felezett (lone surrogate) karaktert tartalmaz, nem hash-elheto")
    if not _HASH.match(anchor):
        fail("a horgony nem 64 hex karakter")

    envelope = {"envelope_v": 1, "to": env["to"], "cc": env["cc"], "bcc": env["bcc"], "text": env["text"]}
    if subject is not None:
        envelope["subject"] = subject
    if env.get("html_sha256"):
        envelope["html_sha256"] = env["html_sha256"]
    if env.get("attachments"):
        envelope["attachments"] = env["attachments"]

    # Self-check: the anchor recomputed from the payload we are about to hand out must be the one
    # we hand out, i.e. the payload carries everything the hash covers and nothing is lost.
    if gate.content_anchor(envelope) != anchor:
        fail("belso hiba: a payload-bol ujraszamolt horgony eltér")

    description = gate.summarize(env)
    if env.get("bcc"):
        description += " | BCC: " + ", ".join(env["bcc"])
    return {
        "agent_id": agent,
        "category": CATEGORY,
        "content_hash": anchor,
        "action_description": description,
        "action_payload": json.dumps(envelope, ensure_ascii=False, separators=(",", ":")),
    }


def main():
    ap = argparse.ArgumentParser(description="Build the POST /api/approvals body for an email_send approval.")
    ap.add_argument("--agent", required=True)
    ap.add_argument("--subject")
    try:
        args = ap.parse_args()
    except SystemExit as exc:
        sys.exit(2 if exc.code else 0)  # argparse uses 2 already; keep an explicit contract
    if not _AGENT_ID.match(args.agent):
        fail("a --agent nem ervenyes ugynok-azonosito")
    if args.subject is not None and (not args.subject.strip() or "\n" in args.subject or "\r" in args.subject):
        fail("a --subject ures vagy tobbsoros")
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 -- any unreadable input is a refusal
        fail("a stdin nem ertelmezheto JSON")

    gate = _load("email_approval_gate", "email-approval-gate.py")
    extract = _load("email_extract", "email_extract.py")
    body = build(payload, args.agent, args.subject, gate, extract)
    sys.stdout.buffer.write((json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 -- never exit 1 with a half-written answer
        sys.stderr.write(f"approval-envelope: belso hiba ({exc!r})\n")
        sys.exit(2)
