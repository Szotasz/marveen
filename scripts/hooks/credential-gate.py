#!/usr/bin/env python3
"""Credential gate for outgoing letters (CREDGATE1003).

PreToolUse hook, a sibling of the email approval gate and the copy gate: it
reads the outgoing letter through the SAME shared extractor (email_extract)
and stops a letter that carries a credential -- a password, PIN, Wi-Fi key or
login keyword followed by a value-shaped token (credential_lib.detect).

A letter with a credential goes out only when ALL of these hold:
  1. the value is not on the install's SHARED list (a value known to be the
     same for several customers: a common device password, a partner's or the
     install's own credential);
  2. the value has not gone to a different, unrelated recipient before
     (config `auto_shared`): a second customer receiving the same value is
     evidence that it is nobody's own. The only way past this check is an
     owner-approved ALIAS (fingerprint -> allowed recipient set, approval
     category `credential_alias`), for one customer at two addresses;
  3. a one-shot ACKNOWLEDGEMENT exists for THIS letter (the approval gate's
     content anchor: recipients + subject + body), recorded with
     `scripts/credential-gate-cli.py ack`: "this is the recipient's own,
     unique credential". The acknowledgement never lifts 1 or 2.

Never logged or printed: the value or the letter's text. A hit is reported as
keyword, line, length and an 8-hex prefix of its HMAC fingerprint.

Scope: Bash calls the copy gate classifies as sends, the send-shaped MCP
tools, manage_email, and draft tools (a draft is a letter someone will send).
Everything else exits 0 untouched.

Modes (config `mode` or CREDENTIAL_GATE_MODE): block (default), or warn (log
and allow, for a rollout). Exit codes (PreToolUse contract): 0 allow, 2 block.
Fail-closed for a letter in scope: an unreadable letter or recipient list, a
broken config, key or state file, an unwritable log -- each denies with its
reason named. A crash on a letter in scope exits 2, never 1.
"""
import importlib.util
import json
import os
import re
import sqlite3
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import credential_lib as cl  # noqa: E402
from email_extract import (collect_email_envelope, collect_mcp_body,  # noqa: E402
                           collect_mcp_recipients)

_SEND_TOOL = re.compile(r"send_email|gmail__(reply|reply_all|send_message|forward)$", re.I)
_LETTER_TOOL = re.compile(r"manage_email|draft", re.I)
ALIAS_CATEGORY = "credential_alias"
CLI = "python3 scripts/credential-gate-cli.py"


def _load(module_name: str, file_name: str):
    spec = importlib.util.spec_from_file_location(module_name, os.path.join(_HERE, file_name))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def is_send_invocation(cmd: str) -> bool:
    """The copy gate's classifier: one implementation decides what both see."""
    return _load("outgoing_copy_gate", "outgoing-copy-gate.py").is_send_invocation(cmd)


def content_anchor(env: dict) -> str:
    """The approval gate's anchor (recipients + text), so one letter has ONE
    anchor across both gates."""
    return _load("email_approval_gate", "email-approval-gate.py").content_anchor(env)


def letter_of(tool: str, tool_input: dict):
    """(env, in_scope). env: {to, cc, bcc, text, unreadable_reason}."""
    if tool == "Bash":
        cmd = str(tool_input.get("command") or "")
        if not is_send_invocation(cmd):
            return None, False
        return collect_email_envelope(tool, tool_input), True
    if _SEND_TOOL.search(tool):
        return collect_email_envelope(tool, tool_input), True
    if _LETTER_TOOL.search(tool):
        text = collect_mcp_body(tool_input)
        to, cc, bcc, reason = collect_mcp_recipients(tool_input)
        if not to and tool_input.get("messageId"):
            to = [f"messageId:{tool_input['messageId']}"]
        return {"to": to, "cc": cc, "bcc": bcc, "text": text, "unreadable_reason": reason}, True
    return None, False


def alias_authorized(anchor: str):
    """(ok, detail) for an alias anchor: the owner's LAST resolved decision on
    it wins, so a later rejection revokes the alias. A missing approvals DB is
    "no alias", not an error: the alias is an exception to a deny, and without
    the DB there is nothing that could grant it."""
    db = os.path.join(cl.store_dir(), "claudeclaw.db")
    if not os.path.exists(db):
        return False, "nincs jovahagyasi adatbazis"
    con = sqlite3.connect(db, timeout=5)
    try:
        con.execute("PRAGMA busy_timeout=5000")
        row = con.execute(
            "SELECT id, status FROM approvals WHERE category=? AND content_hash=?"
            " AND resolved_at IS NOT NULL ORDER BY resolved_at DESC, rowid DESC LIMIT 1",
            (ALIAS_CATEGORY, anchor)).fetchone()
        if row and row[1] == "approved":
            return True, row[0]
        if row:
            return False, f"az alias utolso dontese: {row[1]} ({row[0]})"
        pending = con.execute(
            "SELECT id FROM approvals WHERE category=? AND content_hash=? AND status='pending' LIMIT 1",
            (ALIAS_CATEGORY, anchor)).fetchone()
        return False, (f"az alias jovahagyasa fuggoben ({pending[0]})" if pending
                       else "nincs jovahagyott alias")
    finally:
        con.close()


def shared_by_history(data: dict, hits: list, recipients: list):
    """Hits whose value already went to a recipient set that does not cover
    this letter's recipients, and no approved alias covers them either.
    Returns [(hit, earlier_recipients, alias_detail)]."""
    out = []
    for h in hits:
        seen = data["seen"].get(h["fp"])
        if not seen:
            continue
        allowed = set(seen.get("recipients") or [])
        detail = None
        alias = data["aliases"].get(h["fp"])
        if alias:
            ok, detail = alias_authorized(alias.get("anchor", ""))
            if ok:
                allowed |= set(alias.get("recipients") or [])
        if not set(recipients) <= allowed:
            out.append((h, sorted(seen.get("recipients") or []), detail))
    return out


def take_ack(data: dict, anchor: str):
    """Consume the one-shot acknowledgement for this anchor (inside the
    caller's state lock). Returns the ack or None."""
    for ack in data["acks"]:
        if ack.get("anchor") == anchor and not ack.get("consumed"):
            ack["consumed"] = cl.now_stamp()
            return ack
    return None


def describe(hits: list) -> str:
    return "\n".join(f"  - \"{h['keyword']}\" {h['line']}. sor, {h['length']} karakter, "
                     f"ujjlenyomat {h['fp'][:8]}" for h in hits)


def deny(msg: str, log: dict = None):
    if log is not None:
        try:
            cl.append_log(dict(log, decision="deny"))
        except OSError as exc:
            msg += f"\n(A kapu naploja nem irhato: {exc})"
    sys.stderr.write(f"JELSZO-KAPU: TILTVA.\n{msg}\n")
    sys.exit(2)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        deny("A hook-payload nem ertelmezheto (nem-JSON stdin) -- fail-closed.")
    tool = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input")
    tool_input = tool_input if isinstance(tool_input, dict) else {}

    env, in_scope = letter_of(tool, tool_input)
    if not in_scope:
        sys.exit(0)
    log = {"tool": tool}
    if env.get("unreadable_reason"):
        deny(f"A level nem olvashato: {env['unreadable_reason']}.\n"
             "A jelszo-kapu csak olvashato levelet enged ki: tedd a torzset es a cimzetteket "
             "determinisztikusan olvashatova (shell-valtozo nelkul), aztan kuldd ujra.",
             dict(log, reason="olvashatatlan"))
    try:
        cfg = cl.load_config()
        key = cl.load_key()
    except cl.GateConfigError as exc:
        deny(f"A kapu nem tud ellenorizni: {exc}.", dict(log, reason="konfig"))
    hits = cl.detect(env.get("text") or "", cfg, cl.make_fingerprint(key))
    if not hits:
        sys.exit(0)

    recipients = cl.recipients_of(env)
    anchor = content_anchor(env)
    log.update(hits=cl.public_hits(hits), anchor16=anchor[:16], mode=cfg["mode"])
    if not recipients:
        deny(f"A level hitelesito adatot tartalmaz ({len(hits)} talalat), de a cimzettje nem "
             "olvashato ki, igy nem ellenorizheto, kie az adat. Adj meg explicit cimzettet.",
             dict(log, reason="cimzett-nelkul"))
    warn = cfg["mode"] == "warn"
    found = f"A level hitelesito adatot tartalmaz ({len(hits)} talalat):\n{describe(hits)}\n"
    refusal = None  # (reason code, message); decided under the lock, raised after it
    try:
        with cl.State() as st:
            data = st.data
            shared = [h for h in hits if h["fp"] in data["shared"]]
            history = shared_by_history(data, hits, recipients) if cfg["auto_shared"] else []
            if (shared or history) and not warn:
                # An acknowledgement given for a letter whose value counts as
                # shared is VOID: it was given in a context the gate refuses, and
                # a later alias approval must be followed by a fresh, deliberate
                # one -- not by a stale "own" claim waiting in the state.
                void = take_ack(data, anchor)
                if void:
                    void["voided"] = "kozos-lista" if shared else "kozos-elozmeny"
                else:
                    st.write = False
                if shared:
                    refusal = ("kozos-lista", found + "Ez az ertek a KOZOS hitelesito adatok listajan all "
                               "(tobb cimzettnel azonos, vagy partner vagy sajat rendszer adata): ugyfelnek nem "
                               "mehet ki, jelolessel sem. Vedd ki a levelbol.")
                else:
                    h, earlier, detail = history[0]
                    refusal = ("kozos-elozmeny", found +
                               f"A(z) {h['fp'][:8]} ujjlenyomatu ertek mar egy MASIK cimzettnek ment ki "
                               f"({len(earlier)} korabbi cimzett): kozosnek szamit, jelolessel sem mehet ki.\n"
                               "Ha ugyanannak az ugyfelnek egy masik cime: alias-bejegyzes kell, ertek nelkul "
                               f"({CLI} alias --fp {h['fp'][:8]} --to <cim> [--to <cim>] --request), es annak "
                               f"jovahagyasa ({ALIAS_CATEGORY} kategoria); a jeloles (ack) ezt nem oldja, a mar "
                               "megadott jeloles ervenytelen."
                               + (f"\nAz alias allapota: {detail}." if detail else ""))
            elif not warn:
                ack = take_ack(data, anchor)
                if ack:
                    log["ack"] = {"id": ack.get("id"), "by": ack.get("by"), "reason": ack.get("reason")}
                else:
                    st.write = False
                    refusal = ("jeloles-nelkul", found +
                               "Ha ez a cimzett SAJAT eszkozenek vagy fiokjanak EGYEDI adata, "
                               "jelold ezt a levelet, aztan kuldd ujra valtozatlanul:\n"
                               f"  {CLI} ack --anchor {anchor} --by <ki> --reason \"<miert a cimzett sajat, "
                               "egyedi adata, es honnan tudod>\"\n"
                               "Kozos, mas ugyfel, partner vagy sajat rendszer adata NEM mehet ki: "
                               "vedd ki a levelbol.")
            if refusal is None:
                for h in hits:
                    data["seen"].setdefault(h["fp"], {"recipients": recipients, "first": cl.now_stamp()})
            if warn:
                log["would_deny"] = ("kozos-lista" if shared else "kozos-elozmeny" if history
                                     else "jeloles-nelkul")
    except cl.GateConfigError as exc:
        deny(found + f"A kapu allapota nem kezelheto: {exc}.", dict(log, reason="allapot"))
    if refusal:
        deny(refusal[1], dict(log, reason=refusal[0]))
    try:
        cl.append_log(dict(log, decision="warn" if warn else "allow"))
    except OSError as exc:
        if not warn:
            deny(f"A kapu naploja nem irhato ({exc}): naplozatlan dontes nem mehet ki.")
    if warn:
        print(json.dumps({"systemMessage": "JELSZO-KAPU (figyelo mod): a level hitelesito adatot "
                          f"tartalmaz ({len(hits)} talalat), blokkolo modban tiltott lenne "
                          f"({log['would_deny']})."}, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- a crash must block, never exit 1
        sys.stderr.write(f"JELSZO-KAPU: TILTVA (belso hiba: {type(exc).__name__}: {exc}).\n")
        sys.exit(2)
