#!/usr/bin/env python3
"""IMAP reader for the FenySoft NAS mailbox, feeding the morning briefing.

  python3 scripts/nas-mail.py verify              -- connect, log in, report the folder
  python3 scripts/nas-mail.py list [--hours 12] [--all] [--json]

Read-only throughout: the mailbox is opened with readonly=True and headers are
fetched with BODY.PEEK, so nothing is ever marked as seen. Bodies are never
fetched -- the briefing only needs sender, subject and time.

The Synology DSM has no mail-reading HTTP API, so IMAP is the only route; see
the `nas-mail-imap` card for why this beats scraping the web client.

Credentials live in a gitignored KEY=value file (store/nas-mail-ugyfelkod),
same shape as the graph-mail one. The path is overridable so an operator can
move it out of the repo without touching code. The password is never printed,
never logged and never included in an error message.
"""
import argparse
import email
import imaplib
import json
import os
import re
import ssl
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from email.header import decode_header
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CREDS_PATH = Path(os.environ.get("MARVEEN_NAS_MAIL_CREDS", ROOT / "store" / "nas-mail-ugyfelkod"))

# The briefing asks for "the last 12 hours"; anything longer belongs to a
# manual query, not to the morning message.
DEFAULT_HOURS = 12
CONNECT_TIMEOUT_S = 20

# Headers worth fetching. The last three are the bulk-mail signals used by
# is_noise() -- fetching them costs nothing extra since it is one round trip.
HEADER_FIELDS = "FROM SUBJECT DATE LIST-UNSUBSCRIBE AUTO-SUBMITTED PRECEDENCE"

# Sender local-parts that never carry a message worth waking up for.
NOISE_SENDERS = ("noreply", "no-reply", "donotreply", "do-not-reply", "newsletter", "mailer-daemon")

# Subject keywords, matched accent-insensitively on WORD boundaries -- see
# _fold(). Substring matching would flag "akcióterv" as a promotion.
NOISE_SUBJECT_WORDS = (
    "hírlevél",
    "newsletter",
    "akció",
    "kupon",
    "kedvezmény",
    "unsubscribe",
    "leiratkozás",
    "webshop",
    "black friday",
)


def _fold(text: str) -> str:
    """Lowercase and strip accents, so "HÍRLEVÉL" and "hirlevel" compare equal.

    Hungarian senders are inconsistent about accents in subject lines; a plain
    lowercase compare misses half of them.
    """
    decomposed = unicodedata.normalize("NFD", text.lower())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def parse_credentials(content: str) -> dict:
    """Parse the gitignored KEY=value credentials file.

    Pure and filesystem-free so the contract is unit-testable. Raises
    ValueError naming every missing key -- never echoing any value, because the
    message ends up in logs.
    """
    raw: dict[str, str] = {}

    for line in content.split("\n"):
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)  # split ONCE: the password may contain '='
        value = value.strip()

        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]

        raw[key.strip().upper()] = value

    missing = [k for k in ("HOST", "USER", "PASSWORD") if not raw.get(k)]

    if missing:
        raise ValueError(
            f"nas-mail: incomplete credentials, missing {', '.join(missing)} "
            f"(expected HOST / PORT / TLS / USER / PASSWORD in {CREDS_PATH})"
        )

    port_raw = raw.get("PORT", "").strip()

    try:
        port = int(port_raw) if port_raw else 993
    except ValueError:
        raise ValueError(f"nas-mail: PORT is not a number in {CREDS_PATH}") from None

    return {
        "host": raw["HOST"],
        "port": port,
        "tls": raw.get("TLS", "true").strip().lower() not in ("false", "0", "no"),
        "user": raw["USER"],
        "password": raw["PASSWORD"],
    }


def load_credentials() -> dict:
    if not CREDS_PATH.exists():
        # Spell the keys out rather than pointing at a template file: the
        # template lives under the gitignored store/, so a fresh install has
        # no copy of it to read.
        raise SystemExit(
            f"nas-mail: credentials file not found at {CREDS_PATH}. "
            f"Create it with HOST / PORT / TLS / USER / PASSWORD lines (chmod 600), "
            f"or point MARVEEN_NAS_MAIL_CREDS elsewhere."
        )

    return parse_credentials(CREDS_PATH.read_text(encoding="utf-8"))


def decode_header_value(raw) -> str:
    """Decode a MIME encoded-word header into plain text.

    Handles the mixed encodings Hungarian mailers emit (UTF-8 base64 from
    modern clients, ISO-8859-2 quoted-printable from older ones) and collapses
    the folding whitespace, which would otherwise break the one-line summary.
    """
    if not raw:
        return ""

    parts = []

    for chunk, enc in decode_header(raw):
        if isinstance(chunk, bytes):
            try:
                parts.append(chunk.decode(enc or "utf-8", "replace"))
            except LookupError:  # charset name the codec registry does not know
                parts.append(chunk.decode("utf-8", "replace"))
        else:
            parts.append(chunk)

    return re.sub(r"\s+", " ", "".join(parts)).strip()


def is_noise(sender: str, subject: str, headers: dict) -> bool:
    """True if the message is bulk mail the briefing should skip.

    Header signals first (machine-readable, no guessing), then sender and
    subject heuristics.
    """
    lookup = {str(k).lower(): str(v) for k, v in (headers or {}).items()}

    if lookup.get("list-unsubscribe"):
        return True  # RFC 2369 -- the sender itself declares this is bulk

    auto = lookup.get("auto-submitted", "").strip().lower()

    if auto and auto != "no":  # RFC 3834: "no" means NOT auto-generated
        return True

    if lookup.get("precedence", "").strip().lower() in ("bulk", "junk", "list"):
        return True

    if any(word in (sender or "").lower() for word in NOISE_SENDERS):
        return True

    folded = _fold(subject or "")

    return any(re.search(rf"\b{re.escape(_fold(w))}\b", folded) for w in NOISE_SUBJECT_WORDS)


def select_recent(entries: list, now: datetime, hours: int = DEFAULT_HOURS) -> list:
    """Keep entries newer than `hours`, newest first.

    An unparsable date is KEPT: a missing timestamp is not evidence that the
    message is old, and silently dropping it would hide real mail.
    """
    cutoff = now - timedelta(hours=hours)
    kept = [e for e in entries if e.get("date") is None or e["date"] >= cutoff]

    return sorted(kept, key=lambda e: (e.get("date") is not None, e.get("date") or now), reverse=True)


def _connect(creds: dict):
    if creds["tls"]:
        return imaplib.IMAP4_SSL(
            creds["host"], creds["port"], ssl_context=ssl.create_default_context(), timeout=CONNECT_TIMEOUT_S
        )

    return imaplib.IMAP4(creds["host"], creds["port"], timeout=CONNECT_TIMEOUT_S)


def _parse_date(raw: str):
    try:
        return parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None


def fetch_inbox(hours: int, keep_all: bool) -> dict:
    """Fetch recent INBOX headers. Read-only: readonly=True + BODY.PEEK."""
    creds = load_credentials()
    now = datetime.now(timezone.utc)
    M = _connect(creds)

    try:
        M.login(creds["user"], creds["password"])
        M.select("INBOX", readonly=True)

        # IMAP SINCE has date granularity only, so ask for one extra day and do
        # the hour-precise cut locally in select_recent().
        since = (now - timedelta(hours=hours) - timedelta(days=1)).strftime("%d-%b-%Y")
        typ, data = M.search(None, "SINCE", since)
        ids = data[0].split() if typ == "OK" and data and data[0] else []

        typ, unseen_data = M.search(None, "UNSEEN")
        unseen = set(unseen_data[0].split()) if typ == "OK" and unseen_data and unseen_data[0] else set()

        entries = []

        for mid in ids:
            typ, msg_data = M.fetch(mid, f"(BODY.PEEK[HEADER.FIELDS ({HEADER_FIELDS})])")

            if typ != "OK" or not msg_data or not isinstance(msg_data[0], tuple):
                continue

            hdr = email.message_from_bytes(msg_data[0][1])
            sender = decode_header_value(hdr.get("From"))
            subject = decode_header_value(hdr.get("Subject"))

            entries.append(
                {
                    "id": mid.decode(),
                    "date": _parse_date(hdr.get("Date", "")),
                    "from": sender,
                    "subject": subject,
                    "unread": mid in unseen,
                    "noise": is_noise(sender, subject, dict(hdr.items())),
                }
            )
    finally:
        try:
            M.logout()
        except Exception:  # a dropped socket must not mask the real error
            pass

    recent = select_recent(entries, now, hours)

    return {
        "mailbox": creds["user"],
        "host": creds["host"],
        "hours": hours,
        "unread_total": len(unseen),
        "messages": recent if keep_all else [e for e in recent if not e["noise"]],
        "filtered_out": sum(1 for e in recent if e["noise"]),
    }


def cmd_verify() -> int:
    creds = load_credentials()
    M = _connect(creds)

    try:
        M.login(creds["user"], creds["password"])
        typ, data = M.select("INBOX", readonly=True)
        total = data[0].decode() if typ == "OK" and data and data[0] else "?"
        typ, unseen = M.search(None, "UNSEEN")
        n_unseen = len(unseen[0].split()) if typ == "OK" and unseen and unseen[0] else 0
        print(f"nas-mail: OK -- {creds['user']}@{creds['host']}, INBOX {total} messages, {n_unseen} unread")
        return 0
    finally:
        try:
            M.logout()
        except Exception:
            pass


def cmd_list(hours: int, keep_all: bool, as_json: bool) -> int:
    result = fetch_inbox(hours, keep_all)

    if as_json:
        print(
            json.dumps(
                {
                    **result,
                    "messages": [
                        {**m, "date": m["date"].isoformat() if m["date"] else None} for m in result["messages"]
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    header = f"{result['mailbox']} -- utolso {result['hours']} ora: {len(result['messages'])} level"

    if result["filtered_out"]:
        header += f" ({result['filtered_out']} hirlevel kiszurve)"

    print(header)

    for m in result["messages"]:
        when = m["date"].astimezone().strftime("%m-%d %H:%M") if m["date"] else "  ?  "
        flag = "*" if m["unread"] else " "
        print(f"  {flag} {when}  {m['from'][:38]:38}  {m['subject'][:60]}")

    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="NAS mailbox reader (read-only)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("verify", help="connect and log in, report INBOX size")
    p_list = sub.add_parser("list", help="list recent INBOX headers")
    p_list.add_argument("--hours", type=int, default=DEFAULT_HOURS)
    p_list.add_argument("--all", action="store_true", help="keep newsletters too")
    p_list.add_argument("--json", action="store_true")
    args = ap.parse_args()

    try:
        if args.cmd == "verify":
            return cmd_verify()

        return cmd_list(args.hours, args.all, args.json)
    except imaplib.IMAP4.error as exc:
        # Never let the exception text carry the credentials into a log.
        print(f"nas-mail: IMAP error -- {type(exc).__name__}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
