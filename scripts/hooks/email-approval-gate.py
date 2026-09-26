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
# ~30 minutes from approval (resolved_at) to send; env override is for tests.
WINDOW_S = int(os.environ.get("EMAIL_APPROVAL_WINDOW_S", "1800"))

sys.path.insert(0, _HERE)
from email_extract import collect_email_envelope  # noqa: E402

# GMAILCONNECTOR914: the claude.ai Gmail connector's send-shaped tools carry
# neither word (mcp__claude_ai_Gmail__send_message / reply / forward), so the
# gate exited 0 on them and an unapproved connector send was never denied.
_SEND_TOOL = re.compile(r"send_email|manage_email|gmail__(reply|reply_all|send_message|forward)$", re.I)

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
_MULTIPLEX_TOOL = re.compile(r"manage_email", re.I)
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
    decides what the copy gate audits decides what this gate levels."""
    spec = importlib.util.spec_from_file_location(
        "outgoing_copy_gate", os.path.join(_HERE, "outgoing-copy-gate.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.is_send_invocation


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
        that matters."""
    fields = {"to": env["to"], "cc": env["cc"], "text": env["text"]}
    if env.get("bcc"):
        fields["bcc"] = env["bcc"]
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


def deny(msg: str):
    sys.stderr.write(f"EMAIL JOVAHAGYASI KAPU: TILTVA.\n{msg}\n")
    sys.exit(2)


def summarize(env: dict) -> str:
    to = ", ".join(env["to"]) or "(nincs)"
    cc = ", ".join(env["cc"]) or "-"
    head = env["text"].replace("\n", " ")[:120]
    return f"Cimzett: {to} | CC: {cc} | Szoveg eleje: {head}"


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

    if _SEND_TOOL.search(tool):
        # A multiplexer tool is in scope only when the call is a send; a search,
        # a read or a draft is not what email_send levels.
        if _MULTIPLEX_TOOL.search(tool) and not manage_email_is_send(tool_input):
            sys.exit(0)
    elif tool == "Bash":
        cmd = str(tool_input.get("command") or "")
        if not _load_is_send_invocation()(cmd):
            sys.exit(0)
    else:
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

    # level 2: CHECK-BEFORE-SEND
    env = collect_email_envelope(tool, tool_input)
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

    if verdict == "allowed":
        print(json.dumps({"systemMessage":
            f"email-approval-gate: jovahagyas {detail} felhasznalva (egyszer-hasznalatos), a kuldes mehet."}))
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
         "a kapu sajat korlatja, es egy korlatot nem a korlatozott old fel.")


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
