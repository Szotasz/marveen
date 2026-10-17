#!/usr/bin/env python3
"""Level-aware email approval gate for the MAIN agent (EMAILKAPU901 PR2).

Wired in the repo's .claude/settings.json (PreToolUse: Bash + *send_email* +
*manage_email*), i.e. for sessions rooted at PROJECT_ROOT -- the main agent.
Sub-agents keep their unconditional hard-deny (scripts/email-send-gate.mjs in
their own settings); a sub-agent session that also loads this hook is still
blocked by that one, so this gate can never widen sub-agent rights.

The `email_send.level` in store/autonomy-config.json becomes a real switch:
  level 1  -> hard deny (signal-only autonomy).
  level 2  -> CHECK-BEFORE-SEND: the send is allowed only against an APPROVED,
              UNCONSUMED, IN-WINDOW approval whose content_hash equals the
              sha256 anchor of THIS letter's envelope (to + cc + bcc + subject +
              body). A body+subject hash alone would let an approved letter be
              re-sent to a different recipient -- hence every recipient field, bcc included (msg 17936, EMAILBCCHORGONY903).
  level 3  -> allow (autonomous; the outgoing-copy-gate still audits copy).

Tool scope comes from the shared name classifier
(email_extract.classify_mail_tool), which keys on the base-name suffix, so a
tool prefix (mcp__gmail__v2_reply_all) or a server of any name
(mcp__server-gmail-autoauth-mcp__reply_all) is in scope like the bare name.
send_draft carries only a draftId, so no envelope can be anchored: level 1
deny, level 2 deny with a pointer to send_email with the full envelope (which
the anchor CAN pin), level 3 allow. A draft tool puts nothing on the wire and
stays out of scope.

THE SENDERS CHECK THEMSELVES. A hook sees a command's text, not what runs:
a glob or variable script path, an interpreter option (python3 -u / -X utf8)
or a program read from stdin passes this hook as "not a send", and the
email_send level did not apply at all. So the project's own senders
(scripts/support-mail/send.py, scripts/graph-mail.ts) run the level check
THEMSELVES on the exact letter they deliver (scripts/hooks/sender_check.py,
built on this module's level reader, standing list and anchor): level 1
refuses, level 2 consumes the approval of the delivered envelope (or applies
the standing list), level 3 sends. To keep ONE consumption per send, this hook
passes a level-2 Bash send through WITHOUT consuming only when the WHOLE
command is one literal call of this project's own sender
(canonical_sender_send). Any OTHER spelling that still runs this project's
own sender (a cd prefix, a wrapper, a second command...) is denied WITHOUT
consuming and without an anchor (names_own_sender): the sender would anchor
the envelope it parses itself, so a hook anchor could never be the one it
consumes. Every other Bash send (another mailer, a sender copy elsewhere) is
levelled here as before.

RECIPIENT LEDGER, opt-in: with MAIN_AGENT_RECIPIENT_LEDGER=1 in the install's
.env, the verified-recipient ledger (store/verified-recipients.json, the one
the sub-agent gate enforces) applies to the main agent too: every to/cc/bcc
address of a send, a draft or a manage_email call, and of a Bash send, must be
in it, at every level and BEFORE any approval is consumed; the senders check
every address they deliver to as well. Off by default: whether the main agent
is held to the ledger is the install owner's decision.

At level 2 there is ONE narrow bypass, the standing recipient list
(store/email-standing-recipients.json, EMAILALLANDOCIMZETT926): a letter whose
sole recipient is on that list, with no cc and no bcc, is allowed without an
approval. It exists because the owner wants notifications to his own address
without clicking, and the alternative he was about to reach for -- raising the
level to 3 -- is far wider: the level knows nothing about WHO the letter goes
to, so it would also release every supplier letter. The list is checked only at
level 2; level 1 stays a hard deny, so "signal only" keeps meaning that.
Because that path authorises with no human deciding on THAT letter, it carries
two obligations the rest of the gate does not (review of #1608): it LEAVES A
TRACE the owner can read -- an append-only local log plus an entry in the
dashboard's daily log, and an unrecordable send is denied -- and the level-2
DENY MESSAGE does not name the list file or the way onto it. The old wording
did, and since the agent can write store/ itself, the gate's own refusal was
the manual for getting around it. The right to send still comes from the
owner; the route to it is no longer handed out by the thing doing the
refusing.
The list alone no longer grants anything (the review's third ask): an entry makes
an address a CANDIDATE, and a one-time, owner-resolved approval
(category email_standing_recipient, content_hash = sha256 of the normalised
address) makes it live. That approval is neither consumed nor time-windowed --
a standing right that expires or dies on first use is just a per-letter approval
under another name -- and the owner's LAST resolved decision wins, so a later
rejection revokes the right without anyone editing the file. Whoever can write
the list still cannot grant themselves the right; that separation is the whole
point, and it only holds where the approvals path is out of the agent's reach.

Anchor semantics (Marveen msg 17900, 5+1 conditions):
  1. the hash is computed from the SAME extraction the copy gate audits
     (email_extract.collect_email_envelope -- single implementation);
  2. an approval is ONE-SHOT: consumed atomically on allow;
  3. a TIME WINDOW (~30 min from approval) bounds the hash match;
  4. FAIL-CLOSED: unreadable letter, unrecoverable recipient, missing config,
     or unreachable approvals DB all DENY -- "cannot decide" never means
     "allowed";
  5. the deny message hands the agent the exact hash + a readable summary, so
     the approval's action_description is human-readable and the resend can
     only succeed with byte-identical content.

Exit codes (PreToolUse contract): 0 = allow, 2 = block. A crash must never
exit 1 (non-blocking) -- the __main__ net converts it to 2 on send paths.
The net only covers main(), so only the standard library loads at module
level (HOOKDEPLOAD1008): the two repo dependencies, email_extract.py and
outgoing-copy-gate.py, are loaded where they are first needed, and a load
failure is a deny that names the file. A syntax error in THIS file, or a
broken interpreter, still exits 1 before any of it runs; only the hook
command that starts the file can catch that.
EVERY malformed input (unparseable stdin included) blocks: unlike the copy
gate, which audits and stays alive on harness faults, this gate authorizes,
so "cannot decide" is always a deny.
"""
import email.utils
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
STORE_DIR = os.environ.get("EMAIL_APPROVAL_GATE_STORE",
                           os.path.join(_ROOT, "store"))
DB_PATH = os.path.join(STORE_DIR, "claudeclaw.db")
CONFIG_PATH = os.path.join(STORE_DIR, "autonomy-config.json")
# EMAILALLANDOCIMZETT926: a standing recipient list, consulted at level 2 ONLY.
# The owner asked for one address (his own) to receive notifications without a
# per-letter approval, WITHOUT widening the gate to every recipient -- which is
# what raising the level to 3 would do, because the level knows nothing about
# who the letter goes to.
STANDING_PATH = os.path.join(STORE_DIR, "email-standing-recipients.json")


def _window_from_env():
    """(seconds, error). HOOKDEPLOAD1008: a non-integer override used to
    raise at module load, before the __main__ net: exit 1, which PreToolUse
    treats as NON-blocking. The error is kept here, and the send path denies
    with it."""
    raw = os.environ.get("EMAIL_APPROVAL_WINDOW_S", "1800")
    try:
        return int(raw), None
    except ValueError:
        return None, f"EMAIL_APPROVAL_WINDOW_S={raw!r} nem egesz szam"


# ~30 minutes from approval (resolved_at) to send; env override is for tests.
WINDOW_S, _WINDOW_ERR = _window_from_env()

# GMAILCONNECTOR914: the claude.ai Gmail connector's send-shaped tools carry
# neither word (mcp__claude_ai_Gmail__send_message / reply / forward), so the
# gate exited 0 on them and an unapproved connector send was never denied.
# The scope test is now the shared classifier (email_extract.classify_mail_tool),
# which also reaches prefixed names and send_draft. It lives in email_extract.py,
# which loads lazily (HOOKDEPLOAD1008), so a name that cannot be any mail kind is
# let through BEFORE the load: every name the classifier can put in scope holds
# one of these words, so this is a superset of it, and a read-only call never
# needs the module (classify_tool below).
_MAYBE_MAIL_TOOL = re.compile(r"send|reply|forward|draft|manage_email", re.I)

# manage_email is a MULTIPLEXER, not a send tool: the same MCP tool searches the
# mailbox, reads a thread, writes a draft AND sends. Scoping this gate on the
# tool NAME alone therefore denies reading the inbox whenever email_send sits at
# level 1 -- measured on a live install 2026-09-04, where `operation=search` and
# `operation=draft` were both refused with "a kuldes tiltott". That is not the
# gate this is meant to be: a draft-only workflow REQUIRES reading and drafting,
# and the level exists to stop the SEND.
#
# So manage_email is in scope only for the calls that actually put a letter on
# the wire: a send operation WITHOUT an explicit draft:true. Anything else
# passes, drafts included (MANAGEDRAFT905). Fail-closed on doubt: a missing or
# unreadable operation counts as a send, because that is the case where we
# cannot prove it is not one. `send_email` needs no such test -- it only sends.
_MANAGE_EMAIL_SEND_OPS = {"send", "reply", "reply_all", "replyall", "forward"}


def _is_explicit_draft(tool_input: dict) -> bool:
    """Did the call EXPLICITLY ask for a draft? Only a literal true (bool) or the
    exact string "true" counts; everything else is treated as a send.

    Deliberately the SAME strict test as the sibling gate
    (scripts/email-send-gate.mjs: `draft === true || draft === 'true'`), so a
    call cannot be a draft for one gate and a send for the other. Anything
    fuzzier ("True", "yes", 1) stays a send: fail-closed."""
    draft = tool_input.get("draft")
    return draft is True or draft == "true"


# MAILCCGATE1016: the owner wants a copy of every letter the main agent sends.
# The rule lived only in memory; measured over four days, at least six letters
# left through send_email without it, and the owner noticed. So it is a gate
# now, and it runs at EVERY email_send level (the owner's CC is not an approval
# question). The address comes from MAIL_OWNER_CC in the install .env only (see
# owner_cc_address); unset or empty means the check is off, so a fresh install
# is unchanged. A draft is checked too: send_draft carries only a draft id, so the
# letter it sends can only be checked where the draft is written. An update of
# an existing draft is not checked: it may carry only the changed fields, and a
# missing cc there would be a false deny.
_DRAFT_TOOL = re.compile(r"draft_email|create_draft|draft_gmail_message", re.I)
_ADDR = re.compile(r"[^\s<>,;:\"'()\[\]]+@[^\s<>,;:\"'()\[\]]+")


def owner_cc_address() -> str:
    """MAIL_OWNER_CC from the install .env ONLY, lowercased, or '' when the
    check is off. Never from the process environment: an empty value that ends
    up in the launch environment would switch the gate off with no trace (the
    mail senders read their recipient settings from .env only for the same
    reason). The .env is the one next to the store this gate uses, i.e. the
    install root in production, and the test's own root when a test points
    EMAIL_APPROVAL_GATE_STORE at a temporary store."""
    try:
        with open(os.path.join(os.path.dirname(STORE_DIR), ".env"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MAIL_OWNER_CC="):
                    return line.split("=", 1)[1].strip().strip("'\"").lower()
    except OSError:  # no .env: the check is off, as on a fresh install
        pass
    return ""


def owner_cc_missing(tool_input: dict, owner: str) -> bool:
    """True when the owner's address is in none of the call's to / cc / bcc
    fields. Read straight from the MCP input, not through email_extract: that
    collector only reads send_email-shaped tools, and a draft or a manage_email
    call would come back with no recipients at all."""
    found = set()
    for field in ("to", "cc", "bcc"):
        v = tool_input.get(field)
        for raw in (v if isinstance(v, (list, tuple)) else [v]):
            if raw:
                found.update(a.lower().rstrip(".") for a in _ADDR.findall(str(raw)))
    return owner not in found


# The pre-classifier send-name test, kept ONLY for owner_cc_scope when the
# extractor does not load (classify_tool -> "unclassified"), so a broken
# email_extract.py cannot switch the owner-CC check off at level 3.
_OWNER_CC_SEND_FALLBACK = re.compile(r"send_email|gmail__(reply|reply_all|send_message|forward)$", re.I)


def owner_cc_scope(tool: str, kind, tool_input: dict):
    """(is_mcp_draft, is_mcp_send) for the MAILCCGATE1016 check, from the
    shared classifier's kind. A draft is a draft-writing tool other than
    update_draft (an update may carry only the changed fields) or an explicit
    manage_email draft; a send is every address-carrying or connector send and
    a manage_email send. send_draft is neither: it carries only a draft id, and
    its letter was checked where the draft was written."""
    if kind == "unclassified":
        return bool(_DRAFT_TOOL.search(tool)), bool(_OWNER_CC_SEND_FALLBACK.search(tool))
    is_draft = (kind == "draft" and bool(_DRAFT_TOOL.search(tool))) or (
        kind == "manage_email" and _is_explicit_draft(tool_input))
    is_send = kind in ("send_email", "connector_send") or (
        kind == "manage_email" and manage_email_is_send(tool_input))
    return is_draft, is_send


def owner_cc_gate(tool_input: dict, is_draft_only: bool) -> None:
    """Deny (exit 2) when MAIL_OWNER_CC is set and the owner is in none of the
    call's to / cc / bcc. Returns normally when the check is off or passes."""
    owner = owner_cc_address()
    if not owner or not owner_cc_missing(tool_input, owner):
        return
    what = "piszkozat" if is_draft_only else "level"
    no_fields = not any(tool_input.get(f) for f in ("to", "cc", "bcc"))
    if no_fields and tool_input.get("messageId"):
        # A messageId-addressed reply/forward has no recipient field at
        # all, so "put the owner in cc" cannot be followed there.
        how = (f"Ez a hivas az eredeti uzenetre valaszol (messageId), cimzett-mezo "
               f"nelkul, igy a cc nem adhato hozza. Valaszolj send_email-lel: "
               f"threadId / inReplyTo + a teljes boritek (to, subject, body), "
               f"a cc-ben {owner}.")
    else:
        how = f"Tedd a cc-be ({owner}), aztan kuldd ujra."
    deny(f"A gazda masolata hianyzik: a {what} cimzettjei kozott (to, cc, bcc) "
         f"nincs ott a(z) {owner} cim.\n{how}\nA gazda minden kimeno "
         "levelrol masolatot ker (MAIL_OWNER_CC az install .env-jeben).")


def manage_email_is_send(tool_input: dict) -> bool:
    """Is this manage_email call a send? Unreadable operation -> True (closed).

    MANAGEDRAFT905: the send OPERATIONS are also the only way to write a
    THREADED draft with this MCP tool -- `{"operation":"reply","draft":true}`
    is the exact call the sibling gate (scripts/email-send-gate.mjs) sends the
    agent back to write, and which it lets through on `draft === true`. Keying
    on the operation alone therefore denied the draft-only workflow itself at
    level 1: measured on the live install 2026-09-04, a reply draft to a
    customer thread was refused with "a kuldes tiltott", and the only way
    around it would have been an untreaded new letter -- the very thing the
    reply-as-new gate stops. A draft puts nothing on the wire; the level exists
    to stop the SEND. Fail-closed stays: only an explicit draft:true passes,
    a missing/ambiguous flag is a send.
    """
    op = tool_input.get("operation")
    if not isinstance(op, str) or not op.strip():
        return True
    if op.strip().lower().replace("-", "_") not in _MANAGE_EMAIL_SEND_OPS:
        return False
    return not _is_explicit_draft(tool_input)


def _load_is_send_invocation():
    """Import is_send_invocation from outgoing-copy-gate.py (dashed filename,
    so importlib by path). Single implementation: the same classifier that
    decides what the copy gate audits decides what this gate levels.

    HOOKDEPLOAD1008: a load failure here was already a deny (the __main__ net), but
    its message told the agent to make the CALL checkable, and no rewrite of a
    command helps when the classifier itself does not load. Without it no Bash
    call can be told apart from a send, so every one is refused until the
    module loads again; the deny names the file to repair."""
    try:
        spec = importlib.util.spec_from_file_location(
            "outgoing_copy_gate", os.path.join(_HERE, "outgoing-copy-gate.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.is_send_invocation
    except Exception as exc:  # noqa: BLE001 -- SyntaxError, missing file, anything: fail-closed
        deny("A kapu fuggosege (scripts/hooks/outgoing-copy-gate.py) nem toltheto be "
             f"({exc!r}) -- fail-closed: nem dontheto el, hogy egy Bash-hivas levelet "
             "kuld-e, ezert minden Bash-hivas tiltva, amig a modul nem javul. A javitas "
             "fajl-szerkeszto eszkozzel mehet: ez a kapu csak a Bash- es a levelezo "
             "eszkozokon fut.")


def read_email_level():
    """Return (level, note). Missing category / unreadable config -> level 2:
    fail-closed but recoverable through an approval, instead of a hard lockout
    on an install whose config never listed the category."""
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg = json.load(fh)
        for cat in cfg.get("categories") or []:
            if cat.get("key") == "email_send":
                level = int(cat.get("level"))
                mx = cat.get("maxLevel")
                if isinstance(mx, int):
                    level = min(level, mx)
                return max(1, min(3, level)), None
        return 2, "az email_send kategoria hianyzik az autonomy-configbol -> level 2 (fail-closed)"
    except Exception as exc:  # noqa: BLE001 -- unreadable config is a fail-closed input
        return 2, f"az autonomy-config nem olvashato ({exc!r}) -> level 2 (fail-closed)"


def read_standing():
    """Return (addresses, note). A MISSING file means no standing rights, which
    is the normal state and not a fault. A CORRUPT or wrongly shaped file also
    yields no rights -- fail-closed -- but returns a note, because an empty set
    from a broken file looks exactly like an empty set from no file, and that is
    the silent failure this gate cannot afford.

    Accepted shapes: {"recipients": [...]} or a bare list. Each entry is either
    an address string or {"address": ..., "note": ...}; the note is for the
    human reading the file, the gate ignores it."""
    if not os.path.exists(STANDING_PATH):
        return set(), None
    try:
        with open(STANDING_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001 -- unreadable list grants nothing
        return set(), (f"az allando cimzett-lista nem olvashato ({exc!r}) -> "
                       "nincs allando jog (fail-closed)")
    raw = data.get("recipients") if isinstance(data, dict) else data
    if not isinstance(raw, list):
        return set(), ("az allando cimzett-lista alakja nem lista -> nincs "
                       "allando jog (fail-closed)")
    out = set()
    for item in raw:
        addr = item.get("address") if isinstance(item, dict) else item
        if not isinstance(addr, str):
            continue
        _, parsed = email.utils.parseaddr(addr.strip())
        parsed = parsed.strip().lower()
        if "@" in parsed:
            out.add(parsed)
    return out, None


def standing_match(env: dict, standing):
    """The address this letter may be sent to WITHOUT an approval, or None.

    Deliberately narrow, because this is the one path that authorises without a
    human in the loop for THIS letter:
      - exactly ONE recipient resolves out of `to`, and it is on the list;
      - cc and bcc are empty.
    The extractor keeps recipients RAW and does NOT split them, so a single
    `to` entry can carry several comma-joined addresses; getaddresses expands
    that, and the count is taken AFTER expansion. Anything that does not parse
    to exactly one known address falls through to the approval path -- never to
    an allow."""
    if not standing:
        return None
    for field in ("cc", "bcc"):
        if any(str(v).strip() for v in (env.get(field) or [])):
            return None
    addrs = [a.strip().lower()
             for _, a in email.utils.getaddresses([str(v) for v in (env.get("to") or [])])
             if a and a.strip()]
    if len(addrs) != 1:
        return None
    return addrs[0] if addrs[0] in standing else None


# --- EMAILALLANDOCIMZETT926 / SZAMONKERHETOSEG ----------------------------
# The standing list is the ONLY path on this gate that puts a letter on the
# wire without a human deciding on THAT letter. Its entire accountability is
# therefore the trace it leaves, and the trace has to reach the OWNER -- a
# systemMessage is read by the very process this gate exists to constrain, so
# on its own it is not a record, it is a receipt handed to the sender.
# Every approval-free send is recorded twice:
#   - locally, in an append-only log next to the list (last-resort record);
#   - in the dashboard's daily log, which is where the owner actually reads.
# The two failure modes are handled DIFFERENTLY, on purpose:
#   - a failed LOCAL append DENIES the send. It is a file append into the same
#     directory the gate just read the list from; if that cannot be done, the
#     send cannot be recorded at all, and an unrecordable approval-free send is
#     precisely the invisible hole this list would otherwise open.
#   - a failed DASHBOARD post does NOT deny. The owner's own notifications must
#     not hinge on the dashboard being up. Instead the local line says in words
#     that the owner was not reached, and so does the systemMessage, so the gap
#     is itself on the record rather than being the absence of one.
STANDING_LOG = os.path.join(STORE_DIR, "email-standing-sends.log")


def _install_setting(key: str, default: str) -> str:
    """Env first, then the install .env, then the default. Never an
    install-specific hardcode (distribution rule)."""
    v = os.environ.get(key)
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_ROOT, ".env"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(key + "="):
                    val = line.split("=", 1)[1].strip()
                    if val:
                        return val
    except Exception:  # noqa: BLE001 -- a missing .env just means the default
        pass
    return default


def _env_file_setting(key: str, default: str = "") -> str:
    """The install .env value of `key`, else the default -- NEVER os.environ.
    For a setting that decides who may receive a letter: a sender runs in the
    agent's own shell, where `KEY=... python3 ...` sets the environment. The
    .env is the one next to the store this gate reads (<root>/.env for
    <root>/store), so a test that points the store elsewhere brings its own."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(STORE_DIR)), ".env"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(key + "="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
    except Exception:  # noqa: BLE001 -- a missing .env just means the default
        pass
    return default


LEDGER_SWITCH = "MAIN_AGENT_RECIPIENT_LEDGER"


def ledger_enabled() -> bool:
    """Is the verified-recipient ledger on for the main agent (and the senders)?"""
    return _env_file_setting(LEDGER_SWITCH).lower() in ("1", "true", "yes", "on")


def _standing_log_append(line: str) -> None:
    """Append ONE timestamped line. Deliberately lets OSError out: the caller
    turns it into a deny. Local time with offset, never UTC -- same reason as
    the copy gate's log (an entry that cannot be placed in time checks
    nothing)."""
    from datetime import datetime
    stamp = datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")
    with open(STANDING_LOG, "a", encoding="utf-8") as fh:
        fh.write(f"{stamp} {line}\n")


def _post_daily_log(text: str):
    """Best-effort daily-log entry on the dashboard. Returns (ok, detail).
    Never raises: its failure is data for the local log, not an exception."""
    import urllib.request
    try:
        with open(os.path.join(STORE_DIR, ".dashboard-token"), encoding="utf-8") as fh:
            token = fh.read().strip()
        if not token:
            return False, "ures dashboard-token"
        url = "http://127.0.0.1:%s/api/daily-log" % _install_setting("WEB_PORT", "3420")
        body = json.dumps({"agent_id": _install_setting("MAIN_AGENT_ID", "marveen"),
                           "content": text}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=4) as resp:
            code = getattr(resp, "status", None) or resp.getcode()
            if 200 <= int(code) < 300:
                return True, "ok"
            return False, f"HTTP {code}"
    except Exception as exc:  # noqa: BLE001 -- the local log carries the failure
        return False, repr(exc)


def standing_trace(addr: str, env: dict):
    """Record an approval-free send. Returns None when the owner was reached,
    otherwise the reason he was not -- which the caller puts into the
    systemMessage, so the sending agent cannot believe the owner saw it.

    Raises OSError when the LOCAL append fails; the caller denies on that."""
    from datetime import datetime
    head = env.get("text", "").replace("\n", " ").strip()[:120] or "(nincs szoveg)"
    owner_entry = (
        f"## {datetime.now().astimezone().strftime('%H:%M')} -- Level ment ki "
        "JOVAHAGYAS NELKUL (allando cimzett)\n"
        f"Cimzett: {addr}\n"
        f"Level eleje: {head}\n"
        "Ez a level az allando cimzett-lista alapjan ment ki, per-level jovahagyas "
        "nelkul. Ha erre a cimre nem akarod ezt, vedd ki a cimet a listabol.")
    ok, detail = _post_daily_log(owner_entry)
    _standing_log_append(
        f"allando cimzett, jovahagyas nelkuli kuldes | cimzett={addr} | "
        f"level-eleje={head!r} | gazda-ertesites="
        + ("ok" if ok else f"NEM MENT KI ({detail})"))
    return None if ok else detail

# --- BIRALOI KERES 3: a lista felvetel, nem elesites -----------------------
# The review's strongest ask: an address must not become live merely by being
# written into the list file. The list says WHICH addresses are candidates; a
# one-time, owner-resolved approval says which of them may actually be written
# to without a per-letter decision. Two separate acts, on purpose -- whoever can
# edit the file still cannot grant themselves the right.
#
# This approval is deliberately UNLIKE the per-letter one, and both differences
# are load-bearing:
#   - it is NOT consumed. A standing right that dies on first use is just a
#     per-letter approval wearing a different name.
#   - it is NOT time-windowed. The 30-minute window exists so an approved letter
#     cannot be re-sent days later; a standing recipient is a standing decision,
#     and an expiring one would silently turn every notification into a deny.
# What it IS: the owner's LAST resolved decision about this address. A later
# `rejected` row therefore revokes the right without anyone touching the file,
# which is the only revocation path that works when the file is not writable by
# the person who wants the right gone.
STANDING_CATEGORY = "email_standing_recipient"


def standing_anchor(addr: str) -> str:
    """sha256 over the NORMALISED address, matching read_standing's
    normalisation (parseaddr + lowercase), so the owner's approval and the
    list entry can never disagree about what was approved."""
    return hashlib.sha256(addr.strip().lower().encode("utf-8")).hexdigest()


def standing_authorized(addr: str):
    """Return (ok, detail) for THIS address. Raises on any DB problem -- the
    caller turns that into a fail-closed deny, exactly as the per-letter path
    does: "cannot decide" never means "allowed"."""
    if not os.path.exists(DB_PATH):
        raise OSError(f"approvals DB hianyzik ({DB_PATH})")
    anchor = standing_anchor(addr)
    con = sqlite3.connect(DB_PATH, timeout=5)
    try:
        con.execute("PRAGMA busy_timeout=5000")
        # The LAST resolved decision wins, so a later rejection revokes an
        # earlier approval. rowid breaks same-second ties deterministically.
        row = con.execute(
            f"SELECT id, status FROM approvals WHERE category='{STANDING_CATEGORY}'"
            " AND content_hash=? AND resolved_at IS NOT NULL"
            " ORDER BY resolved_at DESC, rowid DESC LIMIT 1", (anchor,)).fetchone()
        if row and row[1] == "approved":
            return True, row[0]
        if row:
            return False, f"a gazda utolso dontese erre a cimre: {row[1]} ({row[0]})"
        pending = con.execute(
            f"SELECT id FROM approvals WHERE category='{STANDING_CATEGORY}'"
            " AND content_hash=? AND status='pending' LIMIT 1", (anchor,)).fetchone()
        if pending:
            return False, f"a cim elesitese FUGGOBEN van a gazdanal ({pending[0]})"
        return False, "ehhez a cimhez nincs gazdai elesites"
    finally:
        con.close()

def content_anchor(env: dict) -> str:
    """sha256 over the envelope: to + cc + bcc + text (subject+body exactly as
    the copy gate audits it, from the shared extractor). Canonical JSON so the
    same letter always yields the same anchor.

    EMAILBCCHORGONY903: bcc joins the canon, but ONLY when non-empty. Two
    reasons, both load-bearing:
      - the gap this closes: without bcc in the hash, to=[owner], cc=[],
        bcc=[stranger] anchored identically to the approved bcc-less letter,
        so one approval could deliver to a recipient nobody approved;
      - the conditional inclusion keeps every bcc-less anchor BYTE-IDENTICAL
        to the pre-fix value, so open approvals (recorded before this change)
        stay valid for the letters they approved. There is no ambiguity to
        exploit: the extractor decides bcc deterministically, and any
        non-empty bcc changes the hash -- fail-closed in the only direction
        that matters.

    EMAILHTMLHORGONY929: the HTML body's and the attachments' sha256 join the
    canon the same way, ONLY when present: an approved letter re-sent with a
    different HTML or an added/changed attachment has another anchor, and a
    plain letter's anchor is unchanged.

    `render` follows the same rule: the render mode a sender delivers the body
    in (send.py --html / --html-wrap, graph-mail.ts --html), set by the
    senders' own check (sender_check.py) and absent for a plain letter, so an
    approved plain letter cannot go out as HTML. A separate field, so no body
    text can forge it."""
    fields = {"to": env["to"], "cc": env["cc"], "text": env["text"]}
    if env.get("bcc"):
        fields["bcc"] = env["bcc"]
    if env.get("render"):
        fields["render"] = env["render"]
    if env.get("html_sha256"):
        fields["html_sha256"] = env["html_sha256"]
    if env.get("attachments"):
        fields["attachments"] = env["attachments"]
    canon = json.dumps(fields, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


# SQLite's unixepoch() only exists from 3.38 (2022-02). The hook runs under
# the HOST's python3, whose bundled sqlite3 can be older than the one node's
# better-sqlite3 carries -- measured 2026-09-02 on the live install: python
# sqlite3 3.37.2, so every such call raised OperationalError. That is
# not a crash the operator ever sees as a version problem: find_and_consume
# raises, the caller turns any DB fault into a fail-closed deny, and the
# message reads "approvals not available" -- i.e. at level 2 a genuinely
# APPROVED letter is refused and the reason looks like a missing approval.
# CI stayed green throughout because its SQLite is newer, so the suite tested
# every host except the one the gate actually runs on.
# strftime('%s') is present in every SQLite that ships a date function; the
# CAST keeps the comparison integer-to-integer against resolved_at.
NOW_S = "CAST(strftime('%s','now') AS INTEGER)"


def find_and_consume(anchor: str):
    """Return (verdict, detail). verdict: 'allowed' (consumed approval id),
    'pending', 'consumed', 'expired', 'none', 'race'. Raises on any DB problem
    -- the caller turns that into a fail-closed deny."""
    if not os.path.exists(DB_PATH):
        raise OSError(f"approvals DB hianyzik ({DB_PATH})")
    con = sqlite3.connect(DB_PATH, timeout=5)
    try:
        con.execute("PRAGMA busy_timeout=5000")
        row = con.execute(
            "SELECT id FROM approvals WHERE category='email_send' AND status='approved'"
            f" AND content_hash=? AND consumed_at IS NULL AND resolved_at >= {NOW_S}-?"
            " ORDER BY resolved_at DESC LIMIT 1", (anchor, WINDOW_S)).fetchone()
        if row:
            # Atomic one-shot: only the UPDATE that flips NULL->now wins.
            cur = con.execute(
                f"UPDATE approvals SET consumed_at={NOW_S}"
                " WHERE id=? AND consumed_at IS NULL", (row[0],))
            con.commit()
            return ("allowed", row[0]) if cur.rowcount > 0 else ("race", row[0])
        for verdict, cond in (
            ("pending", "status='pending'"),
            ("consumed", "status='approved' AND consumed_at IS NOT NULL"),
            ("expired", f"status='approved' AND consumed_at IS NULL AND resolved_at < {NOW_S}-{int(WINDOW_S)}"),
        ):
            hit = con.execute(
                f"SELECT id FROM approvals WHERE category='email_send' AND content_hash=? AND {cond} LIMIT 1",
                (anchor,)).fetchone()
            if hit:
                return (verdict, hit[0])
        return ("none", None)
    finally:
        con.close()


# --- verified-recipient ledger on the main agent (opt-in, LEDGER_SWITCH) -----
# The same evidence store the sub-agent gate enforces (scripts/recipient-ledger.mjs),
# read through its Python twin scripts/hooks/recipient_ledger.py, which loads
# lazily like email_extract.py: only a call that needs the ledger needs it, and
# its load failure is a deny that names the file.
RECIPIENT_FIELDS = ("to", "cc", "bcc", "recipients", "recipient", "recipient_email")
LEDGER_SOURCE_HELP = "mail:<messageId> | site:<url> | owner | crm:<ref> | order:<id> | doc:<ref>"


def _load_recipient_ledger():
    try:
        sys.path.insert(0, _HERE)
        import recipient_ledger
        recipient_ledger.load_ledger  # noqa: B018 -- a stub without it is a load failure
        recipient_ledger.parse_addresses  # noqa: B018
    except Exception as exc:  # noqa: BLE001 -- SyntaxError, ImportError, anything: fail-closed
        deny(f"A kapu fuggosege (scripts/hooks/recipient_ledger.py) nem toltheto be ({exc!r}) "
             "-- fail-closed: a cimzett nem ellenorizheto, ezert a hivas nem mehet at.")
    return recipient_ledger


def ledger_gate(kind: str, tool_input: dict, cmd: str) -> None:
    """Deny (exit 2) unless every recipient address of the call is in the
    ledger. Returns normally when the call is clean or carries no address
    field (a thread reply by messageId, a send_draft: nothing was typed)."""
    rl = _load_recipient_ledger()
    if kind == "bash":
        to, cc, bcc, reason = _load_email_extract().collect_bash_recipients(cmd)
        if reason:
            deny("A cimzett nem olvashato ki determinisztikusan, igy a cimzett-ledger nem "
                 f"ellenorizheti: {reason}.\n"
                 "Fail-closed: adj meg literal --to/--cc/--bcc cimet (shell-valtozo NELKUL).")
        fields = {"to": to, "cc": cc, "bcc": bcc}
    else:
        fields = {f: tool_input.get(f) for f in RECIPIENT_FIELDS}
    addresses, unparseable = [], []
    for f in RECIPIENT_FIELDS:
        value = fields.get(f)
        if value is None or value == "" or value == []:
            continue
        a, u = rl.parse_addresses(value)
        addresses += [x for x in a if x not in addresses]
        unparseable += [x for x in u if x not in unparseable]
    if unparseable:
        deny(f"Nem ertelmezheto cimzett: {' | '.join(unparseable)}.\n"
             "A cimzett-mezo minden eleme (vesszovel vagy pontosvesszovel elvalasztva) "
             "pontosan EGY cim legyen: \"cim@pelda.hu\" vagy \"Nev <cim@pelda.hu>\". "
             "Ket cim egy elemben, cim a megjelenitett nevben vagy tobb <...> nem "
             "ellenorizheto a cimzett-ledgerrel (fail-closed).")
    if kind == "bash" and not addresses:
        # A Bash sender always has a recipient: when the hook cannot see it
        # (a positional sendmail address, a To: header in a piped file), it
        # cannot vouch for it.
        deny("A Bash-kuldesbol nem nyerheto ki cimzett, igy a cimzett-ledger nem "
             "ellenorizheti (pozicionalis cim vagy fajlban levo To: fejlec).\n"
             "Fail-closed: hasznalj explicit --to (es --cc/--bcc) flaget, aztan kuldd ujra.")
    if not addresses:
        return
    cli = os.path.join(_ROOT, "scripts", "recipient-ledger.mjs")
    try:
        known = rl.load_ledger(os.path.join(STORE_DIR, "verified-recipients.json"))
    except rl.LedgerUnreadable as exc:
        if exc.missing:
            fix = (f"Az elso igazolt cim felvetele letrehozza:\n  node {cli} add <cim> --source <forras> "
                   f"--note \"<honnan>\"\n  --source: {LEDGER_SOURCE_HELP}")
        else:
            fix = ("Javitsd a fajlt kezzel, vagy allitsd vissza mentesbol: amig hasznalhatatlan, a "
                   "recipient-ledger.mjs `add` parancsa megtagadja az irast.")
        deny(f"A cimzett-ledger nem hasznalhato: {exc}. Fail-closed: olvashatatlan "
             "bizonyitek-tar mellett egy cim sem igazolt.\n" + fix)
    bad = [a for a in addresses if rl.normalize_address(a) not in known]
    if bad:
        deny(f"Nem igazolt cimzett: {', '.join(bad)}.\n"
             "A cimzett-ledger (store/verified-recipients.json) nem ismeri ezt a cimet, es "
             "ismeretlen cimre meg piszkozat sem mehet. Ne talalgass: keresd meg a cimet egy "
             "valodi forrasban (a toluk kapott level From fejlece, az elo oldaluk, a rendeles, "
             "a szerzodes), aztan vedd fel a ledgerbe:\n"
             f"  node {cli} add {bad[0]} --source <forras> --note \"<honnan>\"\n"
             f"  --source: {LEDGER_SOURCE_HELP}\n"
             "Ha nem talalsz forrast, a cim NINCS meg: mondd meg a gazdanak, ne kuldj levelet.")


# --- the level-2 pass-through for this project's own senders ----------------
# The senders consume the level-2 approval themselves (sender_check.py), so a
# Bash send of one of them must not be charged here too. The pass-through is
# deliberately NARROW, because whatever it lets through is not levelled by the
# hook: the WHOLE command must be exactly
#
#   python3 <SENDER.py> FLAGS...   or   [npx] tsx <SENDER.ts> send FLAGS...
#   [<<'EOF' ... EOF | < FILE] [2>&1] [| tail -N | head -N]
#
#   SENDER  literally <root>/scripts/support-mail/send.py or
#           <root>/scripts/graph-mail.ts (<root> = this hook's own project,
#           a path that is its own realpath), or the same relative path when
#           the payload's cwd IS <root>. No `cd`, no other path semantics: a
#           sender copy elsewhere (another checkout, an old worktree) may not
#           check anything itself, so it is levelled here as before.
#   FLAGS   the sender's own flags, spelled exactly (`--flag value` or
#           `--flag=value`), each value ONE literal word that does not start
#           with '-'; no `$`, backtick or command substitution anywhere; a
#           heredoc only with a QUOTED delimiter, and nothing after it.
#
# Anything else -- a second command, a wrapper, a variable, an unknown flag --
# is not passed through. When such a command still runs THIS project's own
# sender (names_own_sender), it is denied without consuming the approval and
# without an anchor: the sender checks itself, so a consumption here would
# burn the owner's approval and leave the sender none, and the hook's anchor
# (built from the flags it can read) is not the one the sender computes from
# the envelope it parses. The deny names the canonical forms. A command that
# runs some other mailer or a sender copy elsewhere is levelled here exactly as
# before.
_SENDER_FLAGS = {
    "send.py": ({"--to", "--cc", "--subject", "--body"}, {"--no-owner-cc", "--html", "--html-wrap"}),
    "graph-mail.ts": ({"--to", "--cc", "--subject", "--body", "--attach"}, {"--html"}),
}
_CANONICAL_RELATIVE = {"scripts/support-mail/send.py": "send.py", "scripts/graph-mail.ts": "graph-mail.ts"}


class _NotCanonical(ValueError):
    pass


class _ShapeScanner:
    def __init__(self, s: str):
        self.s, self.i, self.n = s, 0, len(s)

    def fail(self, why):
        raise _NotCanonical(why)

    def peek(self, k=0):
        j = self.i + k
        return self.s[j] if j < self.n else ""

    def skip_ws(self):
        while self.i < self.n:
            if self.s[self.i] in " \t":
                self.i += 1
            elif self.s.startswith("\\\n", self.i):
                self.i += 2  # line continuation
            else:
                break

    def word(self):
        """One LITERAL word; anything run-time ($, backtick, glob...) fails."""
        text, start = "", self.i
        while self.i < self.n:
            c = self.s[self.i]
            if c in " \t\n;&|<>()":
                break
            if c == "'":
                j = self.s.find("'", self.i + 1)
                if j < 0:
                    self.fail("unclosed '")
                text += self.s[self.i + 1:j]
                self.i = j + 1
            elif c == '"':
                j = self.i + 1
                while True:
                    if j >= self.n:
                        self.fail('unclosed "')
                    d = self.s[j]
                    if d == '"':
                        break
                    if d in "$`":
                        self.fail("$ or backtick inside double quotes")
                    if d == "\\" and j + 1 < self.n and self.s[j + 1] in '"\\\n':
                        if self.s[j + 1] != "\n":
                            text += self.s[j + 1]
                        j += 2
                        continue
                    text += d
                    j += 1
                self.i = j + 1
            elif c == "\\" and self.peek(1) == "\n":
                break
            elif re.match(r"[\w@.+:,/%=-]", c):
                text += c
                self.i += 1
            else:
                self.fail(f"character {c!r} outside quotes")
        if self.i == start:
            self.fail("empty word")
        return text

    def words_until_operator(self):
        out = []
        while True:
            self.skip_ws()
            if self.i >= self.n or self.peek() in "\n;&|<>()" or self.s.startswith("2>&1", self.i):
                return out
            out.append(self.word())


def _canonical_sender(word: str, cwd) -> str:
    """The sender's short name when `word` names this project's own sender
    by the literal rules above, else ''."""
    for rel, short in _CANONICAL_RELATIVE.items():
        canon = _ROOT + "/" + rel
        if os.path.realpath(canon) != canon:
            continue  # the project root runs through a symlink: never pass
        if word == canon:
            return short
        if word == rel and isinstance(cwd, str) and cwd == _ROOT and os.path.realpath(cwd) == _ROOT:
            return short
    return ""


def canonical_sender_send(cmd: str, cwd) -> bool:
    """True ONLY when the whole command is one literal send of this project's
    own sender (see above)."""
    try:
        sc = _ShapeScanner(cmd.strip(" \t\n"))
        words = sc.words_until_operator()
        if words[:1] == ["python3"]:
            k = 1
        elif words[:2] == ["npx", "tsx"]:
            k = 2
        elif words[:1] == ["tsx"]:
            k = 1
        else:
            return False
        if k >= len(words):
            return False
        short = _canonical_sender(words[k], cwd)
        if not short or (short == "send.py") != (words[0] == "python3"):
            return False
        value_flags, bool_flags = _SENDER_FLAGS[short]
        args = words[k + 1:]
        if short == "graph-mail.ts":
            if args[:1] != ["send"]:
                return False
            args = args[1:]
        j = 0
        while j < len(args):
            name, eq, value = args[j].partition("=")
            if name in value_flags:
                if not eq:
                    j += 1
                    if j >= len(args):
                        return False
                    value = args[j]
                if value.startswith("-"):
                    return False
            elif not (name in bool_flags and not eq):
                return False
            j += 1
        heredoc, seen_stdin, seen_2to1 = None, False, False
        while True:
            sc.skip_ws()
            if sc.s.startswith("2>&1", sc.i) and not seen_2to1:
                seen_2to1 = True
                sc.i += 4
                continue
            if sc.peek() == "<" and not seen_stdin and not seen_2to1:
                seen_stdin = True
                if sc.s.startswith("<<", sc.i):
                    sc.i += 2
                    if sc.peek() in "<-":
                        return False
                    sc.skip_ws()
                    m = re.compile(r"'(\w+)'|\"(\w+)\"").match(sc.s, sc.i)
                    if not m:
                        return False  # an unquoted delimiter expands the body
                    sc.i = m.end()
                    heredoc = m.group(1) or m.group(2)
                else:
                    sc.i += 1
                    sc.skip_ws()
                    sc.word()
                continue
            break
        if sc.peek() == "|" and sc.peek(1) != "|":
            sc.i += 1
            tt = sc.words_until_operator()
            if not tt or tt[0] not in ("tail", "head") or not (
                    (len(tt) == 2 and re.match(r"^-\d+$", tt[1]))
                    or (len(tt) == 3 and tt[1] == "-n" and tt[2].isdigit())):
                return False
        sc.skip_ws()
        if heredoc is not None:
            if sc.peek() != "\n":
                return False
            lines = sc.s[sc.i + 1:].split("\n")
            if heredoc not in lines:
                return False
            return not any(line.strip() for line in lines[lines.index(heredoc) + 1:])
        return sc.i >= sc.n
    except _NotCanonical:
        return False


def names_own_sender(cmd: str, cwd) -> bool:
    """Does any word of `cmd` name THIS project's own sender file, read
    literally or against the payload cwd or a `cd DIR` target in the command
    (realpath on both sides)? Used only to DENY: a false positive refuses a
    call, it never lets one through."""
    import shlex
    try:
        lexer = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        words = list(lexer)
    except ValueError:
        words = cmd.split()
    targets = set()
    for rel in _CANONICAL_RELATIVE:
        p = os.path.realpath(os.path.join(_ROOT, rel))
        if os.path.exists(p):
            targets.add(p)
    if not targets:
        return False
    here = cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None
    bases = [here] if here else []
    for i, w in enumerate(words[:-1]):
        if w == "cd":
            d = os.path.expanduser(words[i + 1])
            if os.path.isabs(d):
                bases.append(d)
            elif here:
                bases.append(os.path.join(here, d))
    for w in words:
        if os.path.basename(w) not in ("send.py", "graph-mail.ts", "graph-mail.js"):
            continue
        cands = [w] if os.path.isabs(w) else [os.path.join(b, w) for b in bases if os.path.isabs(b)]
        if any(os.path.realpath(c) in targets for c in cands):
            return True
    return False


def canonical_forms_text() -> str:
    """The Bash send forms whose level-2 approval the SENDER consumes."""
    return ("`python3 scripts/support-mail/send.py --flag 'ertek' ...` vagy "
            "`npx tsx scripts/graph-mail.ts send --flag 'ertek' ...` a projekt gyokerebol, cd "
            "nelkul, vagy ugyanez a projekt abszolut (szimlink nelkuli) utvonalaval; a torzs "
            "literal, vagy <<'EOF' heredoc, utana semmi mas parancs")


def deny(msg: str):
    sys.stderr.write(f"EMAIL JOVAHAGYASI KAPU: TILTVA.\n{msg}\n")
    sys.exit(2)


def _load_email_extract():
    """The extractor module, loaded where the gate first needs it
    (HOOKDEPLOAD1008). A module-level import of a broken email_extract.py (a
    syntax error, a conflicted merge) raised before the __main__ net: exit 1,
    which PreToolUse treats as NON-blocking, so the letter went out UNCHECKED.
    Here any load failure is a deny with the reason, and a call that is not a
    send never needs the module."""
    try:
        sys.path.insert(0, _HERE)
        import email_extract
        email_extract.collect_email_envelope  # noqa: B018 -- a stub without it is a load failure
        email_extract.classify_mail_tool  # noqa: B018
    except Exception as exc:  # noqa: BLE001 -- SyntaxError, ImportError, anything: fail-closed
        deny(f"A kapu fuggosege (scripts/hooks/email_extract.py) nem toltheto be ({exc!r}) "
             "-- fail-closed: a level nem mehet ki, amig a modul nem javul.")
    return email_extract


def _load_collect_email_envelope():
    return _load_email_extract().collect_email_envelope


def classify_tool(tool: str):
    """The tool's mail kind (email_extract.classify_mail_tool), or
    "unclassified" when the extractor does not load. Levels 1 and 3 never read
    the letter, so a broken extractor must not change their decision
    (HOOKDEPLOAD1008): such a call is treated as a SEND -- level 1 denies,
    level 3 allows as before, and level 2 meets the extractor's own load deny.
    A manage_email call keeps its operation test, as before the classifier."""
    try:
        sys.path.insert(0, _HERE)
        import email_extract
        return email_extract.classify_mail_tool(tool)
    except Exception:  # noqa: BLE001 -- the level-2 path names the load failure
        return "manage_email" if "manage_email" in tool.lower() else "unclassified"


def scope_kind(tool: str):
    """The kind this gate acts on: the shared classifier, plus the substring
    `manage_email` this gate's scope always matched (a look-alike such as
    manage_emails_bulk stays in scope here, judged by its operation)."""
    kind = classify_tool(tool)
    if kind is None and "manage_email" in tool.lower():
        return "manage_email"
    return kind


def summarize(env: dict) -> str:
    to = ", ".join(env["to"]) or "(nincs)"
    cc = ", ".join(env["cc"]) or "-"
    head = env["text"].replace("\n", " ")[:120]
    extra = ""
    if env.get("html_sha256"):
        extra += f" | HTML sha256: {env['html_sha256'][:16]}"
    if env.get("attachments"):
        extra += " | Csatolmany: " + ", ".join(f"{a['name']} ({a['sha256'][:16]})" for a in env["attachments"])
    return f"Cimzett: {to} | CC: {cc} | Szoveg eleje: {head}{extra}"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        # FAIL-CLOSED, deliberately DIVERGING from the copy gate (Marveen's
        # #1149 review): the copy gate AUDITS and chooses session-liveness on
        # a broken harness payload; this gate AUTHORIZES, and an unreadable
        # payload on a send-matched call must not authorize anything. Loud
        # deny beats a silent fail-open on the one hook whose whole job is
        # the deny. (Costs: a systematically broken harness blocks Bash on
        # the main agent -- visible immediately, which is the point.)
        deny("A hook-payload nem ertelmezheto (nem-JSON stdin) -- fail-closed, "
             "mert ez a kapu ENGEDELYEZ: ertelmezhetetlen hivas nem kaphat engedelyt.")
    tool = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input")
    tool_input = tool_input if isinstance(tool_input, dict) else {}

    kind = None
    cmd = ""
    if tool == "Bash":
        cmd = str(tool_input.get("command") or "")
        if not _load_is_send_invocation()(cmd):
            sys.exit(0)
        if ledger_enabled():
            ledger_gate("bash", tool_input, cmd)
    else:
        if not _MAYBE_MAIL_TOOL.search(tool):
            sys.exit(0)  # no mail kind is possible: the extractor is not needed
        kind = scope_kind(tool)
        # MAILCCGATE1016: the owner-CC check, before the level (it applies at
        # every level) and for drafts too. MCP tools only: the Bash senders
        # carry their own owner-CC default (scripts/support-mail/send.py,
        # SUPPORT_OWNER_CC).
        is_mcp_draft, is_mcp_send = owner_cc_scope(tool, kind, tool_input)
        if is_mcp_draft or is_mcp_send:
            owner_cc_gate(tool_input, is_mcp_draft and not is_mcp_send)
        if kind is None:
            sys.exit(0)  # reads, labels: nothing goes on the wire
        # The ledger comes first: it applies to drafts and at every level, and
        # it must never run AFTER an approval was consumed.
        if ledger_enabled():
            ledger_gate(kind, tool_input, cmd)
        if kind == "draft":
            sys.exit(0)  # a draft puts nothing on the wire; the level stops SENDS
        # A multiplexer tool is in scope only when the call is a send; a search,
        # a read or a draft is not what email_send levels.
        if kind == "manage_email" and not manage_email_is_send(tool_input):
            sys.exit(0)

    level, note = read_email_level()
    prefix = f"({note})\n" if note else ""
    if level >= 3:
        sys.exit(0)
    if level <= 1:
        deny(prefix +
             "Az email_send autonomia-szint 1 (csak jelez): a kuldes tiltott.\n"
             "Jelezd a gazdanak inter-agent uzenettel vagy a dashboardon; a szint "
             "emelese a store/autonomy-config.json-ban a gazda dontese.")
    if tool == "Bash" and canonical_sender_send(cmd, payload.get("cwd")):
        # This project's own sender, called literally: it enforces level 2
        # itself (sender_check.py) on the envelope it delivers, standing list
        # included, and consumes the approval there. Not consuming here keeps
        # exactly one consumption per send.
        print(json.dumps({"systemMessage":
            "email-approval-gate: email_send level 2 -- a kuldo maga ellenorzi a jovahagyast "
            "(vagy az allando cimzett-listat), es elutasitaskor kiirja a level horgonyat."}))
        sys.exit(0)
    if tool == "Bash" and names_own_sender(cmd, payload.get("cwd")):
        deny(prefix +
             "email_send level 2: ez a parancs a projekt SAJAT kuldojet futtatja, de nem a "
             "kanonikus alakban. A kuldo maga ellenorzi es hasznalja fel a jovahagyast a sajat "
             "maga altal kezbesitett boritekra, ezert a kapu itt NEM hasznal fel jovahagyast, es "
             "nem ad horgonyt (az ugysem az lenne, amit a kuldo szamol).\n"
             f"Futtasd igy: {canonical_forms_text()}. Level 2-n a kuldo elutasitaskor kiirja a "
             "level horgonyat, azzal kerj jovahagyast.")
    if kind == "send_draft":
        # The call carries only a draftId: the gate sees neither the recipient
        # nor the text, so there is nothing an approval could be anchored to.
        deny(prefix +
             "email_send level 2 (CHECK-BEFORE-SEND): a send_draft nem horgonyozhato. "
             "A hivas csak egy draftId-t visz, a piszkozat cimzettjet es szoveget a kapu "
             "nem latja, igy nincs mihez jovahagyast kotni.\n"
             "Kuldd a levelet send_email-lel, TELJES boritekkal (to + cc + bcc + subject + "
             "body, ugyanaz, ami a piszkozatban van): arra a kapu kiadja a tartalom-horgonyt, "
             "azzal kerj jovahagyast, es a jovahagyas utan ugyanaz a hivas atmegy.")

    # level 2: CHECK-BEFORE-SEND
    if _WINDOW_ERR:
        deny(prefix + f"A kapu beallitasa hibas ({_WINDOW_ERR}) -- fail-closed, "
             "a level nem mehet ki.")
    env = _load_collect_email_envelope()(tool, tool_input)
    if env["unreadable_reason"]:
        deny(prefix +
             f"A level nem horgonyozhato: {env['unreadable_reason']}.\n"
             "Fail-closed: tedd a hivast determinisztikusan olvashatova (inline "
             "--to/--cc/--subject/--body vagy MCP-mezok, shell-valtozo NELKUL), "
             "aztan kuldd ujra.")
    if not env["text"].strip():
        deny(prefix + "A hivasbol nem nyerheto ki level-szoveg -- fail-closed.")
    if not env["to"]:
        deny(prefix +
             "A hivasbol nem nyerheto ki cimzett (a horgony a cimzettet is fedi).\n"
             "Hasznalj explicit --to flaget vagy MCP to-mezot, aztan kuldd ujra.")

    # The standing list is checked BEFORE the anchor, and only here -- i.e.
    # only at level 2. Level 1 stays a hard deny: "signal only" must not have a
    # back door, and the owner's plan is to sit at 2. Level 3 never reaches
    # this point at all.
    standing, standing_note = read_standing()
    if standing_note:
        prefix = prefix + f"({standing_note})\n"
    hit = standing_match(env, standing)
    if hit:
        # The list makes the address a CANDIDATE; only the owner's one-time
        # approval makes it live. Checked before the trace, because an address
        # that is not live has no approval-free send to record.
        try:
            live, live_detail = standing_authorized(hit)
        except Exception as exc:  # noqa: BLE001 -- unreachable DB is fail-closed
            deny(prefix +
                 f"email_send level 2: {hit} rajta van az allando cimzett-listan, de az "
                 f"elesitese nem ellenorizheto ({exc!r}) -- nem-eldontheto, ezert "
                 "fail-closed TILTVA. Ha a dashboard/DB helyreallt, kuldd ujra.")
        if not live:
            deny(prefix +
                 f"email_send level 2: {hit} szerepel az allando cimzett-listan, DE NINCS "
                 f"ELESITVE -- {live_detail}.\n"
                 "Egy cim attol valik elese, hogy a gazda EGYSZER jovahagyta, NEM attol, "
                 "hogy felkerult a listara. A felvetel javaslat, az elesites dontes.\n"
                 f"Cim-horgony (sha256): {standing_anchor(hit)}\n"
                 "Elesites KERESE: POST /api/approvals a sajat agent_id-ddal, "
                 f'category="{STANDING_CATEGORY}", content_hash=a fenti cim-horgony, '
                 "action_description=melyik cimet es miert. A dontes a gazdae: a sajat "
                 "keresedet NE hagyd jova.\n"
                 "Addig ez a level a szokasos, level-enkenti jovahagyasi uton mehet.")
        # The trace is part of the AUTHORISATION here, not a side effect of it:
        # this is the one allow-path with no human deciding on THIS letter, so a
        # send that cannot be recorded does not go out at all.
        try:
            owner_gap = standing_trace(hit, env)
        except OSError as exc:
            deny(prefix +
                 f"email_send level 2: {hit} rajta van az allando cimzett-listan, DE a "
                 f"kuldes nem rogzitheto ({exc!r}) -- fail-closed TILTVA.\n"
                 "A lista az egyetlen ut, amin emberi dontes nelkul megy ki level, ezert "
                 f"a NYOMA a feltetele: ha a {os.path.basename(STANDING_LOG)} nem irhato, "
                 "a jog sem all. Tedd irhatova, aztan kuldd ujra.")
        note = ("A kuldes a gazda napi naplojaba is bekerult."
                if owner_gap is None else
                f"FIGYELEM: a gazdat NEM sikerult ertesiteni ({owner_gap}). A helyi "
                f"{os.path.basename(STANDING_LOG)} rogzitette a kuldest ES az ertesites "
                "hianyat is, de a gazda ettol meg nem tud rola -- ha a level fontos, "
                "szolj neki a csatornan.")
        print(json.dumps({"systemMessage":
            f"email-approval-gate: {hit} allando cimzett, a kuldes jovahagyas nelkul "
            f"mehet. Minden mas cimzett tovabbra is jovahagyas-koteles. {note}"}))
        sys.exit(0)

    anchor = content_anchor(env)
    try:
        verdict, detail = find_and_consume(anchor)
    except Exception as exc:  # noqa: BLE001 -- DB unreachable is fail-closed, not no-right
        deny(prefix +
             f"A jovahagyasok nem elerheto(k) ({exc!r}) -- nem-eldontheto, ezert "
             "fail-closed TILTVA. Ha a dashboard/DB helyreallt, kuldd ujra.")

    copy_note = ""
    if tool == "Bash":
        copy_note = ("\nMegjegyzes: ez a Bash-kuldes nem a projekt sajat kuldojet futtatja, ezert a "
                     "kapu maga hasznalja fel a jovahagyast. A projekt kuldoinek alakja: "
                     f"{canonical_forms_text()}.")
    if verdict == "allowed":
        print(json.dumps({"systemMessage":
            f"email-approval-gate: jovahagyas {detail} felhasznalva (egyszer-hasznalatos), a kuldes mehet."
            + copy_note}))
        sys.exit(0)

    reasons = {
        "pending": f"A(z) {detail} jovahagyas meg FUGGOBEN van -- varj a gazda donteseig, aztan kuldd ujra.",
        "consumed": f"A(z) {detail} jovahagyas MAR FEL LETT HASZNALVA (egyszer-hasznalatos) -- uj jovahagyas kell.",
        "expired": f"A(z) {detail} jovahagyas IDOABLAKA lejart ({WINDOW_S // 60} perc) -- uj jovahagyas kell.",
        "race": "A jovahagyast egy parhuzamos kuldes hasznalta fel -- uj jovahagyas kell.",
        "none": "Ehhez a levelhez NINCS jovahagyas.",
    }
    deny(prefix +
         f"email_send level 2 (CHECK-BEFORE-SEND). {reasons[verdict]}\n"
         f"Tartalom-horgony (sha256; to+cc+bcc+targy+torzs): {anchor}\n"
         f"{summarize(env)}\n"
         "Jovahagyas kerese: POST /api/approvals a sajat agent_id-ddal, "
         'category="email_send", content_hash=a fenti horgony, action_description='
         "az olvashato osszefoglalo (cimzett + targy + torzs eleje).\n"
         "Jovahagyas UTAN PONTOSAN ugyanezt a hivast kuldd ujra -- a horgony csak "
         "byte-azonos levelre egyezik, es a jovahagyas egyszer hasznalhato, "
         f"{WINDOW_S // 60} percig ervenyes.\n"
         "Ha ez visszatero, EGY cimzettnek szolo level (tipikusan a gazda sajat "
         "ertesitese), a gazda beallithatja a cimet allando cimzettnek. KERD TOLE "
         "a csatornan es vard meg a valaszat. A beallitast MAGAD NE vegezd el: ez "
         "a kapu sajat korlatja, es egy korlatot nem a korlatozott old fel." + copy_note)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate fail-closed net
        # Same contract as the copy gate: an unhandled crash would exit 1,
        # which PreToolUse treats as NON-blocking -- the send would run
        # unchecked. On this gate every matched path is a send path, so
        # blocking is always the safe failure mode.
        sys.stderr.write(
            f"EMAIL JOVAHAGYASI KAPU: TILTVA, belso hiba a vizsgalat kozben ({exc!r}).\n"
            "Fail-closed: tedd vizsgalhatova a hivast, aztan kuldd ujra.\n")
        sys.exit(2)
