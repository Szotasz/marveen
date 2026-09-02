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
              sha256 anchor of THIS letter's four fields (to + cc + subject +
              body). A body+subject hash alone would let an approved letter be
              re-sent to a different recipient -- hence all four (msg 17936).
  level 3  -> allow (autonomous; the outgoing-copy-gate still audits copy).

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
# ~30 minutes from approval (resolved_at) to send; env override is for tests.
WINDOW_S = int(os.environ.get("EMAIL_APPROVAL_WINDOW_S", "1800"))

sys.path.insert(0, _HERE)
from email_extract import collect_email_envelope  # noqa: E402

_SEND_TOOL = re.compile(r"send_email|manage_email", re.I)


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


def content_anchor(env: dict) -> str:
    """sha256 over the four-field envelope. Canonical JSON so the same letter
    always yields the same anchor; `text` is subject+body exactly as the copy
    gate audits it, from the shared extractor."""
    canon = json.dumps({"to": env["to"], "cc": env["cc"], "text": env["text"]},
                       ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


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
            " AND content_hash=? AND consumed_at IS NULL AND resolved_at >= unixepoch()-?"
            " ORDER BY resolved_at DESC LIMIT 1", (anchor, WINDOW_S)).fetchone()
        if row:
            # Atomic one-shot: only the UPDATE that flips NULL->now wins.
            cur = con.execute(
                "UPDATE approvals SET consumed_at=unixepoch()"
                " WHERE id=? AND consumed_at IS NULL", (row[0],))
            con.commit()
            return ("allowed", row[0]) if cur.rowcount > 0 else ("race", row[0])
        for verdict, cond in (
            ("pending", "status='pending'"),
            ("consumed", "status='approved' AND consumed_at IS NOT NULL"),
            ("expired", f"status='approved' AND consumed_at IS NULL AND resolved_at < unixepoch()-{int(WINDOW_S)}"),
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
        pass  # MCP email send: always in scope
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
         f"Tartalom-horgony (sha256; to+cc+targy+torzs): {anchor}\n"
         f"{summarize(env)}\n"
         "Jovahagyas kerese: POST /api/approvals a sajat agent_id-ddal, "
         'category="email_send", content_hash=a fenti horgony, action_description='
         "az olvashato osszefoglalo (cimzett + targy + torzs eleje).\n"
         "Jovahagyas UTAN PONTOSAN ugyanezt a hivast kuldd ujra -- a horgony csak "
         "byte-azonos levelre egyezik, es a jovahagyas egyszer hasznalhato, "
         f"{WINDOW_S // 60} percig ervenyes.")


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
