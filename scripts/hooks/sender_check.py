#!/usr/bin/env python3
"""The checks a SENDER runs on the exact letter it is about to deliver.

Used by this project's own senders, before any vault, SMTP or Graph call:
  - scripts/support-mail/send.py imports it (check());
  - scripts/graph-mail.ts runs it as a CLI (JSON letter on stdin; exit 0 =
    send, 3 = refused, the reason on stderr; anything else is a refusal too).

Why the sender and not only the main agent's PreToolUse hook: the hook reads
the COMMAND TEXT. A glob or variable script path, an interpreter option
(python3 -u, -X utf8), or a program read from stdin is not a send for it, so
the email_send level never applied (measured: each of those exits 0 at level
1). And where the hook does anchor a letter, it anchors the flags it can read,
while the sender delivers what IT parses: an argparse abbreviation (--t / --c)
or an owner CC taken from the environment reached an address the approval
never covered. The sender sees the letter after the shell is done with it.

What is checked, in this order:
  0. the outgoing-copy CONTENT checks of the main agent's copy gate
     (outgoing-copy-gate.py, loaded by path: the same audit(), the same
     dictionary, the same name rules from store/outgoing-copy-gate-rules.json;
     the hook's OUTGOING_COPY_GATE_RULES override is ignored), with the hook's
     email-path policy: a problem or an INVALID rules file refuses, a missing
     or empty rules file allows with a loud warning. The hook only audits a
     command it recognises as a send, so the spellings above skipped it too.
     First, so a refused letter never consumes its level-2 approval;
  1. the verified-recipient ledger, ONLY when the install turned it on for the
     main agent (MAIN_AGENT_RECIPIENT_LEDGER=1 in .env): every delivered
     address, the configured owner CC included, must be in
     store/verified-recipients.json, each recipient value must parse as
     single addresses (recipient_ledger.parse_addresses), and the parsed set
     must equal the set the sender is about to deliver to;
  2. the email_send level, with the main agent's approval gate's OWN reader,
     standing list and anchor (email-approval-gate.py, loaded by path the way
     credential-gate.py loads it): level 1 refuses; level 2 sends to a live
     standing recipient (one explicit `to`, no explicit cc, the trace written
     first) or consumes the one approved, unused, in-window approval whose
     content_hash is the anchor of THIS delivered envelope (atomically: one
     send per approval), else refuses and prints the anchor; level 3 sends.
     A missing or unreadable config is level 2, as in the hook.

Every path is this project's own (<root>/store/...): the hook's test-only
environment overrides (EMAIL_APPROVAL_GATE_STORE, EMAIL_APPROVAL_WINDOW_S)
do not apply here, because a sender runs in the agent's own shell, where
`VAR=... python3 send.py` would otherwise point the check at a config nobody
curated. Any failure inside the check refuses (fail-closed).
"""
import importlib.util
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(_HERE))
STORE = os.path.join(ROOT, "store")
DEFAULT_WINDOW_S = 1800


class Refused(Exception):
    """The sender must not deliver; the message says why."""


def _gate():
    """email-approval-gate.py as a module, pinned to THIS project's store."""
    spec = importlib.util.spec_from_file_location(
        "email_approval_gate_sender_check", os.path.join(_HERE, "email-approval-gate.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.STORE_DIR = STORE
    mod.DB_PATH = os.path.join(STORE, "claudeclaw.db")
    mod.CONFIG_PATH = os.path.join(STORE, "autonomy-config.json")
    mod.STANDING_PATH = os.path.join(STORE, "email-standing-recipients.json")
    mod.STANDING_LOG = os.path.join(STORE, "email-standing-sends.log")
    mod.WINDOW_S, mod._WINDOW_ERR = DEFAULT_WINDOW_S, None
    # The daily-log notice of a standing send reads WEB_PORT / MAIN_AGENT_ID;
    # the hook takes them from the process environment first, where a
    # `WEB_PORT=1 python3 ...` prefix would silently send the owner's notice
    # nowhere. Here they come from the project .env only.
    mod._install_setting = lambda key, default: mod._env_file_setting(key, default)
    return mod


COPY_RULES_ENV = "OUTGOING_COPY_GATE_RULES"


def _copy_gate():
    """outgoing-copy-gate.py as a module, its name rules read from THIS
    project's store: the hook's test-only rules override is not honoured."""
    saved = os.environ.pop(COPY_RULES_ENV, None)
    try:
        spec = importlib.util.spec_from_file_location(
            "outgoing_copy_gate_sender_check", os.path.join(_HERE, "outgoing-copy-gate.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        if saved is not None:
            os.environ[COPY_RULES_ENV] = saved
    return mod


def _copy_check(text):
    """Return a warning line or None; raise Refused when the letter may not go."""
    try:
        gate = _copy_gate()
        if gate.RULES_STATE == gate.RULES_INVALID:
            raise Refused("KIMENO-SZOVEG ELLENORZES: a NEV-SZABALY fajl LETEZIK, de ervenytelen "
                          f"({gate._LOCAL_RULES}): nem parse-olhato JSON, rossz sema vagy hibas regex. "
                          "Javitsd a fajlt, aztan kuldd ujra.")
        if not str(text or "").strip():
            raise Refused("KIMENO-SZOVEG ELLENORZES: ures level (targy + torzs), nincs mit kikuldeni.")
        problems = gate.audit(text)
    except Refused:
        raise
    except BaseException as exc:  # noqa: BLE001 -- deliberate fail-closed net
        raise Refused(f"KIMENO-SZOVEG ELLENORZES: belso hiba ({exc!r}); fail-closed, egy "
                      "vizsgalhatatlan level nem mehet ki.")
    if problems:
        raise Refused("KIMENO-SZOVEG ELLENORZES: a level nem mehet ki igy.\n"
                      + "\n".join(f"  - {p}" for p in problems)
                      + "\nJavitsd a szoveget es kuldd ujra.")
    if gate.RULES_STATE in (gate.RULES_MISSING, gate.RULES_EMPTY):
        return ("KIMENO-SZOVEG ELLENORZES: FIGYELEM, a NEV-SZABALY fajl "
                + ("HIANYZIK" if gate.RULES_STATE == gate.RULES_MISSING else "URES")
                + f" ({gate._LOCAL_RULES}), ez a level a nev-ellenorzes NELKUL megy.")
    return None


def _ledger_check(gate, letter):
    sys.path.insert(0, _HERE)
    import recipient_ledger as rl
    try:
        known = rl.load_ledger(os.path.join(STORE, "verified-recipients.json"))
        verified = []
        for raw in (letter.get("raw_to"), letter.get("raw_cc")):
            if raw:
                verified += rl.verified_addresses(raw, known)
    except (rl.LedgerUnreadable, rl.RecipientRefused) as exc:
        raise Refused(f"{exc}. Csak a cimzett-ledgerben (store/verified-recipients.json) levo cimre "
                      "megy level, a gazda-CC-re is; uj cimet forrassal vegyel fel: "
                      "node scripts/recipient-ledger.mjs add <cim> --source <forras>")
    delivered = {rl.normalize_address(a) for a in list(letter["to"]) + list(letter.get("cc") or [])}
    if not delivered or delivered != {a.lower() for a in verified}:
        raise Refused("a kuldo sajat cimbontasa mas cimeket adott, mint a ledger-ellenorzes "
                      f"(kuldes: {sorted(delivered)}, ellenorizve: {sorted(set(verified))}); fail-closed")


def check(letter):
    """Return the messages to print on success; raise Refused otherwise.

    letter: {"to": [...], "cc": [...]   the addresses the sender delivers to,
             "text": subject + "\\n" + body,
             "render": "" | "--html" | "--html-wrap",
             "attachments": [{"name", "sha256", "size"}]   (optional),
             "raw_to": str, "raw_cc": str | None   the values as the sender got them,
             "explicit_to": [...], "explicit_cc": [...]   what the caller typed
                (no configured default), for the standing list,
             "default_cc": [...]   the CC the sender added from its own config
                (send.py's owner CC), if any}"""
    if not isinstance(letter, dict) or not isinstance(letter.get("to"), list) or not letter["to"]:
        raise Refused("a level cimzettje nem olvashato ki; fail-closed")
    notes = []
    warning = _copy_check(letter.get("text"))
    if warning:
        notes.append(warning)
    gate = _gate()
    if gate.ledger_enabled():
        _ledger_check(gate, letter)
    level, note = gate.read_email_level()
    if note:
        notes.append(note)
    if level >= 3:
        return notes + ["email_send level 3"]
    if level <= 1:
        raise Refused("az email_send autonomia-szint 1 (csak jelez): a kuldes tiltott; a szint "
                      "emelese a store/autonomy-config.json-ban a gazda dontese")
    env = {"to": list(letter["to"]), "cc": list(letter.get("cc") or []), "text": str(letter.get("text") or "")}
    if letter.get("render"):
        env["render"] = str(letter["render"])
    if letter.get("attachments"):
        env["attachments"] = letter["attachments"]

    # The standing list, exactly as the hook applies it: the view is what the
    # caller typed (the hook never saw a sender's configured default CC).
    standing, standing_note = gate.read_standing()
    if standing_note:
        notes.append(standing_note)
    hit = gate.standing_match({"to": list(letter.get("explicit_to") or []),
                               "cc": list(letter.get("explicit_cc") or []), "bcc": []}, standing)
    if hit:
        # The hook's match reads the typed value; the sender may split it
        # differently ("evil@x, y" <standing@x> is one address for the parser
        # and two for a comma split). A standing send is only one whose
        # DELIVERED envelope is that single address, plus at most the CC the
        # sender adds from its own configuration.
        sys.path.insert(0, _HERE)
        import recipient_ledger as rl
        delivered_to = [rl.normalize_address(a) for a in letter["to"]]
        extra_cc = {rl.normalize_address(a) for a in letter.get("cc") or []}
        if delivered_to != [hit] or not extra_cc <= {rl.normalize_address(a) for a in letter.get("default_cc") or []}:
            notes.append(f"{hit}: a kezbesitett boritek nem csak ez az egy cim, igy nem allando-cimzett level")
            hit = None
    if hit:
        try:
            live, live_detail = gate.standing_authorized(hit)
        except Exception as exc:  # noqa: BLE001 -- unreachable DB is a refusal
            raise Refused(f"{hit} rajta van az allando cimzett-listan, de az elesitese nem "
                          f"ellenorizheto ({exc!r}); fail-closed")
        if not live:
            # The same decision as the hook: a listed address that the owner
            # has not made live is refused, with the address anchor to ask for.
            raise Refused(f"email_send level 2: {hit} szerepel az allando cimzett-listan, DE NINCS "
                          f"ELESITVE ({live_detail}). Cim-horgony (sha256): {gate.standing_anchor(hit)}; "
                          f"elesites kerese: POST /api/approvals, category=\"{gate.STANDING_CATEGORY}\". "
                          "A dontes a gazdae: a sajat keresedet NE hagyd jova.")
        try:
            owner_gap = gate.standing_trace(hit, env)
        except OSError as exc:
            raise Refused(f"{hit} allando cimzett, de a kuldes nem rogzitheto ({exc!r}); "
                          "a nyoma a feltetele, fail-closed")
        return notes + [f"email_send level 2: {hit} allando cimzett, jovahagyas nelkul mehet"
                        + ("" if owner_gap is None else
                           f" (FIGYELEM: a gazdat NEM sikerult ertesiteni: {owner_gap})")]

    anchor = gate.content_anchor(env)
    try:
        verdict, detail = gate.find_and_consume(anchor)
    except Exception as exc:  # noqa: BLE001 -- DB unreachable is a refusal
        raise Refused(f"a jovahagyasok nem elerhetok ({exc!r}); fail-closed")
    if verdict == "allowed":
        return notes + [f"email_send level 2: a(z) {detail} jovahagyas felhasznalva (egyszer-hasznalatos)"]
    reasons = {
        "pending": f"a(z) {detail} jovahagyas meg FUGGOBEN van, varj a gazda donteseig",
        "consumed": f"a(z) {detail} jovahagyas MAR FEL LETT HASZNALVA (egyszer-hasznalatos)",
        "expired": f"a(z) {detail} jovahagyas IDOABLAKA lejart",
        "race": "a jovahagyast egy parhuzamos kuldes hasznalta fel",
        "none": "ehhez a levelhez NINCS jovahagyas",
    }
    raise Refused(
        "\n".join(notes + [
            f"email_send level 2 (CHECK-BEFORE-SEND): {reasons[verdict]}.",
            f"Tartalom-horgony (sha256; a kuldo altal kezbesitett boritek): {anchor}",
            f"{gate.summarize(env)}" + (f" | Megjelenites: {env['render']}" if env.get("render") else ""),
            "Jovahagyas kerese: POST /api/approvals, category=\"email_send\", content_hash=a fenti "
            "horgony; a jovahagyas UTAN pontosan ugyanezt a kuldest futtasd ujra (a horgony csak "
            f"byte-azonos levelre egyezik, egyszer hasznalhato, {DEFAULT_WINDOW_S // 60} percig ervenyes).",
        ]))


def main():
    try:
        letter = json.loads(sys.stdin.read())
        for line in check(letter):
            print(line, file=sys.stderr)
    except Refused as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(3)
    except BaseException as exc:  # noqa: BLE001 -- any failure refuses (fail-closed)
        if isinstance(exc, SystemExit) and exc.code in (0, None):
            raise
        print(f"a kuldo-oldali ellenorzes hibaval allt le ({exc!r}); fail-closed", file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    main()
