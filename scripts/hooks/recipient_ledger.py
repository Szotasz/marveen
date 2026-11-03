#!/usr/bin/env python3
"""Python reader of the verified-recipient ledger (store/verified-recipients.json).

The ledger and its CLI are scripts/recipient-ledger.mjs. This module is its
Python twin for the main agent's side, used only when the install turns the
ledger on for the main agent (MAIN_AGENT_RECIPIENT_LEDGER=1 in .env):
  - scripts/hooks/email-approval-gate.py -- the main agent's hook;
  - scripts/hooks/sender_check.py -- the check the senders
    (scripts/support-mail/send.py, scripts/graph-mail.ts) run themselves.

The semantics mirror recipient-ledger.mjs exactly (normalizeAddress /
parseAddresses / inspectLedger), and two shared case lists bind the copies:
scripts/hooks/recipient-address-cases.json (the parser) and
scripts/hooks/recipient-ledger-file-cases.json (one verdict per file),
both run through both languages by src/__tests__/email-send-gate.test.ts.
Reimplemented instead of spawning node: a hook runs under a non-interactive
PATH where node can be missing.

Standard library only; no side effect at import.
"""
import json
import re


class LedgerUnreadable(Exception):
    """The ledger cannot be used as evidence. `missing` tells the two cases
    apart: a missing file is fixed by `add` (it creates the file); a present
    but unusable one is not -- recipient-ledger.mjs `add` refuses to write over
    it, so it has to be repaired or restored first."""

    def __init__(self, msg, missing):
        super().__init__(msg)
        self.missing = missing


class RecipientRefused(Exception):
    """An unparseable recipient piece or an address the ledger does not know."""


def _js_string(value) -> str:
    """String(value ?? '') for the scalar shapes a tool input can carry."""
    if value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def normalize_address(raw) -> str:
    s = _js_string(raw).strip()
    m = re.search(r"<([^>]+)>", s)
    return (m.group(1) if m else s).strip().lower()


# Twin of recipient-ledger.mjs parseAddresses -- see the rationale there.
# fullmatch (not ^...$): Python's $ also matches before a trailing newline,
# JS's does not. Whitespace is spelled out as ASCII for the same reason.
_ADDR_SEPARATOR = re.compile(r"[,;]")
_ADDR_TRIM = re.compile(r"^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+\Z")
_ANGLE_FORM = re.compile(r"([^<>]*)<([^<>]*)>")
_QUOTED = re.compile(r'"(.*)"')
_BARE_ADDRESS = re.compile(r"[^ \t\r\n\f\v\"<>()\[\]\\,;:@]+@[^ \t\r\n\f\v\"<>()\[\]\\,;:@]+")


def _trim(s: str) -> str:
    return _ADDR_TRIM.sub("", s)


def _parse_address_piece(piece: str):
    ats = piece.count("@")
    addr = piece
    if "<" in piece or ">" in piece:
        m = _ANGLE_FORM.fullmatch(piece)
        if not m:
            return None
        addr = _trim(m.group(2))
        if ats > 1:
            # the one two-'@' form: a display name that IS the address
            display = _trim(m.group(1))
            q = _QUOTED.fullmatch(display)
            display = _trim(q.group(1)) if q else display
            if display.lower() != addr.lower():
                return None
    elif ats > 1:
        return None
    return addr.lower() if _BARE_ADDRESS.fullmatch(addr) else None


def parse_addresses(value):
    """Return (addresses, unparseable) -- recipient-ledger.mjs parseAddresses."""
    addresses, unparseable = [], []
    if value is None:
        return addresses, unparseable
    items = value if isinstance(value, (list, tuple)) else [value]
    for item in items:
        if item is None:
            continue
        if isinstance(item, (list, tuple, dict)):
            unparseable.append(json.dumps(item, ensure_ascii=False, separators=(",", ":")))
            continue
        for raw in _ADDR_SEPARATOR.split(_js_string(item)):
            piece = _trim(raw)
            if "@" not in piece:
                continue
            addr = _parse_address_piece(piece)
            if addr is None:
                unparseable.append(piece)
            else:
                addresses.append(addr)
    return addresses, unparseable


def _reject_constant(name):
    raise ValueError(f"not a JSON constant: {name}")


def load_ledger(path):
    """Return the recipients mapping of the ledger at `path`; raise
    LedgerUnreadable otherwise (recipient-ledger.mjs inspectLedger)."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except FileNotFoundError:
        raise LedgerUnreadable(f"the ledger does not exist ({path})", missing=True)
    except OSError as exc:
        raise LedgerUnreadable(f"the ledger cannot be read ({path}: {exc})", missing=False)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise LedgerUnreadable(f"the ledger is not valid UTF-8 ({path})", missing=False)
    try:
        # NaN / Infinity are not JSON: JS's JSON.parse rejects them, so this
        # reader must too (one verdict per file). A BOM is rejected by both.
        parsed = json.loads(text, parse_constant=_reject_constant)
    except ValueError as exc:
        raise LedgerUnreadable(f"the ledger is not valid JSON ({path}: {exc})", missing=False)
    if not isinstance(parsed, dict):
        raise LedgerUnreadable(f"the ledger is not a JSON object ({path})", missing=False)
    recipients = parsed.get("recipients")
    if not isinstance(recipients, dict):
        raise LedgerUnreadable(f"the ledger has no recipients map ({path})", missing=False)
    return recipients


def verified_addresses(value, recipients):
    """The addresses of one recipient field, each verified against the loaded
    ledger mapping `recipients` (load_ledger). Raises RecipientRefused on any
    unparseable piece or unknown address."""
    addresses, unparseable = parse_addresses(value)
    if unparseable:
        raise RecipientRefused("unparseable recipient (exactly ONE address per item): "
                               + " | ".join(unparseable))
    unknown = [a for a in addresses if normalize_address(a) not in recipients]
    if unknown:
        raise RecipientRefused("recipient not in the verified-recipient ledger: "
                               + ", ".join(dict.fromkeys(unknown)))
    return addresses
