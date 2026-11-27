#!/usr/bin/env python3
"""Send an email FROM the configured support mailbox via SMTP (implicit TLS:465).

Usage:
  python3 send.py --to a@b.hu --subject "..." --body "..." [--cc you@example.com] [--html] [--attach FILE]...
Body can also be piped on stdin if --body is omitted.
Mailbox / hosts come from config (.env); password is pulled from the vault at
runtime (never stored/printed). --html sends the body as an HTML alternative.
--attach (repeatable) adds a file; like scripts/graph-mail.ts it must sit inside
the attachment drop directory (<repo>/store/mail-attachments, fixed; the
directory itself must not be a symlink), anything else is refused (exit 3):
putting a file there is the deliberate act that authorises sending it. A
regular file only, at most MAX_ATTACH_BYTES, with no control character in its name. The
attachments' name, sha256 and size join the letter sender_check checks, so an
approval covers the exact files.

Exit 3 = refused, nothing sent (the reason on stderr, "KULDES MEGTAGADVA: ..."):
the checks of scripts/hooks/sender_check.py on the exact letter this run
delivers -- the email_send level (level 1; level 2 without a matching unused
approval or a live standing recipient), and, when the install turned the
recipient ledger on for the main agent, an address not in
store/verified-recipients.json. Checked (without consuming) before the vault
or SMTP is touched, and once more, consuming, after the SMTP login.
"""
import sys, os, ssl, smtplib, argparse, imaplib, time, hashlib, mimetypes, stat
from email.message import EmailMessage
from email.utils import getaddresses, formatdate, make_msgid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

# The checks this sender runs itself, around the vault and SMTP (see the
# docstring). A missing or broken module is a refusal like every other one:
# exit 3, never a traceback with exit 1.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))
try:
    import sender_check
except BaseException as _check_exc:  # noqa: BLE001 -- deliberate fail-closed net
    print("KULDES MEGTAGADVA: a kuldo-oldali ellenorzes (scripts/hooks/sender_check.py) nem "
          f"toltheto be ({_check_exc!r}); fail-closed, ellenorizetlen level nem mehet ki.",
          file=sys.stderr)
    sys.exit(3)

# A gazda masolati cime: a kimeno support-levelek alapertelmezett CC-je.
# CONFIG-VEZERELT, URES ALAPERTELMEZESSEL -- a Marveen termekkent szallitodik, tehat
# a repoban NEM allhat egyetlen telepites gazdajanak a cime sem. Aki nem allitja be,
# annal a viselkedes bajt-azonos a korabbival (nincs CC). A mi telepitesunkon a
# SUPPORT_OWNER_CC a .env-ben all, ami nem verziokovetett.
# (A template-identity-hygiene teszt fogta meg az elso, hardcode-olt valtozatot --
#  jogosan: az minden vevo telepitesen a mi cimunkre CC-zett volna.)
# ONLY from the project .env, never from os.environ: the CC is a recipient, and
# an environment value can be set by any shell spelling in front of the send
# (`SUPPORT_OWNER_CC=... python3 ...`), which no gate reads -- an approved
# letter then also went to that address.
OWNER_CC = lib.env_file_value("SUPPORT_OWNER_CC")
# Behaviour change, said out loud: an owner CC that used to come from the
# environment is no longer used.
if os.environ.get("SUPPORT_OWNER_CC") and os.environ.get("SUPPORT_OWNER_CC") != OWNER_CC:
    print("FIGYELEM: a SUPPORT_OWNER_CC kornyezeti valtozot a kuldo nem olvassa, csak a projekt "
          ".env-jet (" + (f"ott: {OWNER_CC}" if OWNER_CC else "ott nincs beallitva, a level gazda-CC nelkul megy")
          + "). Allitsd be a .env-ben.", file=sys.stderr)


def envelope_recipients(to, cc=None):
    """SMTP envelope recipients from the --to and --cc values (SENDMAILLIST928).

    Both flags accept a comma-separated address list. The headers keep the value
    as given; the envelope needs one entry per address, otherwise a list goes out
    as a single RCPT and the server rejects or misroutes it. getaddresses is used
    instead of a plain split so a display name with a comma ("Doe, John <j@x.hu>")
    stays one address. Order is kept, exact duplicates are dropped.

    Fails loudly (ValueError) when a non-empty field yields no usable address:
    newer Pythons' strict parser returns an empty pair for malformed input, and a
    silently empty envelope must never reach the SMTP call."""
    out, seen = [], set()
    for field in (to, cc):
        if not field or not field.strip():
            continue
        found = [addr.strip() for _, addr in getaddresses([field]) if "@" in addr]
        if not found:
            raise ValueError(f"no usable address in {field!r}")
        for addr in found:
            if addr.lower() not in seen:
                seen.add(addr.lower())
                out.append(addr)
    return out


# FIXED, not configurable: neither the environment (any shell spelling in
# front of the send sets it, and no gate reads it) nor the project .env (a
# value like "/" would lift the limit) may move it.
ATTACH_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "store", "mail-attachments")


# Per-file cap: the bytes are read into memory once, then held again as base64 in
# the letter and in the IMAP copy. Nothing beyond the cap is ever read.
MAX_ATTACH_BYTES = 10 * 1024 * 1024


def _refuse_attach(raw, why):
    # The sender's refusal contract (module docstring): exit 3, reason on stderr.
    print(f"KULDES MEGTAGADVA: a csatolmany ({raw!r}) {why}", file=sys.stderr)
    sys.exit(3)


def _open_in_drop_dir(root, name):
    """A read-only fd for root/name, opened from a descriptor of root with
    O_NOFOLLOW on both: a file swapped for a symlink after the path check
    cannot lead the open out of the drop directory, and root itself (the
    UNRESOLVED drop directory path) may not be a symlink. Only DIRECT children of
    the drop directory are attachable, so no subdirectory can be moved out
    from under an open descriptor. Without these flags the platform cannot
    hold the limit, so the attachment is refused (fail-closed)."""
    if not (hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY") and os.open in os.supports_dir_fd):
        raise OSError("a platform nem tamogatja a biztonsagos megnyitast (O_NOFOLLOW, O_DIRECTORY, dir_fd)")
    fd = os.open(root, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
    try:
        # O_NONBLOCK: a FIFO must not hang the open; fstat below refuses it
        return os.open(name, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0), dir_fd=fd)
    finally:
        os.close(fd)


def read_attachments(paths):
    """[(name, bytes)] for --attach, each confined to ATTACH_DIR. The name is
    the basename of the path as given, as the mail gates' extractor
    (email_extract.collect_bash_attachments) names it, so one file has one
    anchor everywhere; the bytes are read once, from the descriptor."""
    if not paths:
        return []
    root = os.path.realpath(ATTACH_DIR)
    out = []
    for raw in paths:
        real = os.path.realpath(raw)
        if real == root or os.path.commonpath([root, real]) != root:
            _refuse_attach(raw, f"nincs a csatolmany-mappaban ({root}); masold oda, aztan kuldd ujra")
        if os.path.dirname(real) != root:
            _refuse_attach(raw, f"csak a csatolmany-mappa ({root}) kozvetlen fajlja csatolhato, alkonyvtare nem")
        name = os.path.basename(raw)
        # The name goes into a header. A control character (CR, LF, VT, FF, FS/GS/RS ...) or bytes that are not
        # UTF-8 would make the message builder raise (a traceback, exit 1): refuse them here, exit 3.
        if any(ord(c) < 32 or c == "\x7f" for c in name):
            _refuse_attach(raw, "neve vezerlokaraktert (pl. CR/LF) tartalmaz")
        try:
            name.encode("utf-8")
        except UnicodeEncodeError:
            _refuse_attach(raw, "neve nem ervenyes UTF-8")
        try:
            # ATTACH_DIR as configured, NOT its realpath: a drop directory that is itself a symlink to
            # somewhere else fails the O_NOFOLLOW open of the directory instead of becoming the "drop directory".
            fd = _open_in_drop_dir(ATTACH_DIR, os.path.basename(real))
        except OSError as exc:
            _refuse_attach(raw, f"nem nyithato meg a csatolmany-mappaban ({exc.strerror or exc})")
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                _refuse_attach(raw, "nem sima fajl")
            with os.fdopen(fd, "rb") as fh:
                fd = None
                data = fh.read(MAX_ATTACH_BYTES + 1)
            if len(data) > MAX_ATTACH_BYTES:
                _refuse_attach(raw, f"nagyobb, mint a megengedett {MAX_ATTACH_BYTES} bajt")
            out.append((name, data))
        except OSError as exc:
            _refuse_attach(raw, f"nem olvashato ({exc.strerror or exc})")
        finally:
            if fd is not None:
                os.close(fd)
    return out


# ISSUE3181SENDPY (#3181): the audit copy's folder. It used to be a fixed
# "INBOX.Sent", which is the Sent folder on a Courier-style server (ours) but
# only an ordinary folder on, for example, a Dovecot server whose Sent folder is
# "Sent". Order: the SUPPORT_SENT_FOLDER config value; else the mailbox the
# server flags \Sent in its LIST reply (RFC 6154 special-use); else "INBOX.Sent".
SENT_FALLBACK = "INBOX.Sent"


def _list_line_text(item):
    """One imaplib LIST item as text. A name sent as a literal arrives as a
    tuple (b'(\\Sent) "/" {13}', b'Sent Messages'): the literal is the name."""
    if isinstance(item, tuple):
        head = item[0].decode("utf-8", "replace") if isinstance(item[0], bytes) else str(item[0])
        lit = item[1].decode("utf-8", "replace") if isinstance(item[1], bytes) else str(item[1])
        head = head.rsplit("{", 1)[0].rstrip()
        return head + " " + '"' + lit.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return item.decode("utf-8", "replace") if isinstance(item, bytes) else str(item)


def parse_list_line(item):
    """(flags, name) of one LIST reply line, or None when it does not parse.
    flags are lower-cased (\\sent, \\noselect, ...); the name is unquoted
    (quoted with \\-escapes, or a bare atom); the delimiter is not needed."""
    text = _list_line_text(item).strip()
    if not text.startswith("("):
        return None
    close = text.find(")")
    if close < 0:
        return None
    flags = {f.lower() for f in text[1:close].split()}
    rest = text[close + 1:].lstrip()
    # the delimiter: a quoted single char ("." "/" or an escaped one) or NIL
    if rest.upper().startswith("NIL"):
        rest = rest[3:].lstrip()
    elif rest.startswith('"'):
        end = rest.find('"', 2 if rest[1:2] == "\\" else 1)
        if end < 0:
            return None
        rest = rest[end + 1:].lstrip()
    else:
        return None
    if not rest:
        return None
    if rest.startswith('"'):
        out, i = [], 1
        while i < len(rest):
            c = rest[i]
            if c == "\\" and i + 1 < len(rest):
                out.append(rest[i + 1]); i += 2; continue
            if c == '"':
                return flags, "".join(out)
            out.append(c); i += 1
        return None
    return flags, rest.split()[0]


def sent_folder_from_list(items):
    """The first selectable mailbox the LIST reply flags \\Sent, else None."""
    for item in items or []:
        parsed = parse_list_line(item)
        if parsed and "\\sent" in parsed[0] and "\\noselect" not in parsed[0]:
            return parsed[1]
    return None


def choose_sent_folder(configured, list_items):
    """(folder, source): the configured value, else the \\Sent mailbox, else the fallback."""
    if configured and configured.strip():
        return configured.strip(), "SUPPORT_SENT_FOLDER"
    flagged = sent_folder_from_list(list_items)
    if flagged:
        return flagged, "\\Sent"
    return SENT_FALLBACK, "fallback"


def imap_mailbox_arg(name):
    """The mailbox as an IMAP argument: imaplib sends it as given, so a name
    with a space or a quote must be a quoted string."""
    if name and all(c.isalnum() or c in "._-/&+" for c in name):
        return name
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main():
    # allow_abbrev=False: with argparse's default prefix matching, `--t x` /
    # `--c x` silently meant --to / --cc, so a recipient arrived under a
    # spelling the mail gates do not read (they take recipients from the exact
    # --to / --cc / --bcc). Now an abbreviation is an argparse error.
    ap = argparse.ArgumentParser(allow_abbrev=False)
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body", default=None)
    # A GAZDA-CC MOSTANTOL ALAPERTELMEZES, NEM EMLEKEZET (Marveen, mert eset 2026-09-14).
    # A CLAUDE.md kimondja, hogy MINDEN kimeno levelnek CC-znie kell a gazdat, kivetel nelkul.
    # Ez a szabaly eddig CSAK PROZABAN letezett: a `--cc` opcionalis volt, default None.
    # Merve: a mai negy Comline-levelbol HAROM CC nelkul ment ki (INBOX.Sent fejlecek), ezert a
    # gazda a sajat postalada-jaban nem latta a megoldast, es ugy jelezte vissza, mintha az ugy
    # meg allna. Nem a szabaly volt rossz, hanem az, hogy nem volt KODUTBA kotve.
    ap.add_argument("--cc", default=OWNER_CC or None,
                    help="CC-cim (alapertelmezes: a SUPPORT_OWNER_CC config-ertek, ha be van "
                         "allitva); kikapcsolas: --no-owner-cc")
    ap.add_argument("--no-owner-cc", action="store_true",
                    help="KIMONDOTT lemondas a gazda-CC-rol -- csak akkor, ha a cimzettnek nem szabad latnia")
    ap.add_argument("--html", action="store_true")
    # --html-wrap takes PLAIN text and builds the light HTML itself, keeping the
    # original text as the text/plain alternative. Prefer it over --html: --html
    # replaces the plain part with a useless "look at this in an HTML client"
    # stub, which is what plain-text readers and previews then show.
    ap.add_argument("--html-wrap", action="store_true")
    ap.add_argument("--attach", action="append", default=[],
                    help="file to attach (repeatable); only from the attachment drop directory")
    a = ap.parse_args()
    # Was --cc given on the command line (as opposed to the configured default)?
    cc_given = any(x == "--cc" or x.startswith("--cc=") for x in sys.argv[1:])
    # A lemondas CSAK az alapertelmezett (config-bol jott) erteket ejti ki: egy
    # kimondott --cc-t nem dob el. Ha nincs beallitva OWNER_CC, nincs mit ejteni.
    if a.no_owner_cc and OWNER_CC and a.cc == OWNER_CC:
        a.cc = None
    body = a.body if a.body is not None else sys.stdin.read()

    msg = EmailMessage()
    msg["From"] = f"{lib.FROM_NAME} <{lib.FROM_ADDRESS}>"
    msg["To"] = a.to
    if a.cc:
        msg["Cc"] = a.cc
    msg["Subject"] = a.subject
    # ISSUE3181SENDPY: Date and Message-ID before the send, so the delivered
    # letter and the audit copy carry the same ones (smtplib adds neither). They
    # are not part of `letter` below, so the approval anchor does not change.
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=lib.FROM_ADDRESS.rsplit("@", 1)[-1] if "@" in (lib.FROM_ADDRESS or "") else None)
    if a.html_wrap:
        import html_wrap
        msg.set_content(body)
        msg.add_alternative(html_wrap.to_html(body), subtype="html")
    elif a.html:
        msg.set_content("A levél HTML formátumú; nézd HTML-képes kliensben.")
        msg.add_alternative(body, subtype="html")
    else:
        msg.set_content(body)
    attachments = read_attachments(a.attach)
    for name, data in attachments:
        ctype, _ = mimetypes.guess_type(name)
        maintype, subtype = (ctype.split("/", 1) if ctype else ("application", "octet-stream"))
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    # The same {name, sha256, size} list the mail gates extract from the command
    # line (email_extract.collect_bash_attachments), in the same order, so the
    # approval anchor this sender checks is the one the owner approved.
    att_env = sorted(({"name": n, "sha256": hashlib.sha256(d).hexdigest(), "size": len(d)}
                      for n, d in attachments), key=lambda x: (x["name"], x["sha256"]))

    try:
        rcpts = envelope_recipients(a.to, a.cc)
        to_addrs = envelope_recipients(a.to)
    except ValueError as e:
        sys.exit(f"send.py: refusing to send, {e}")
    seen_to = {t.lower() for t in to_addrs}
    cc_addrs = [r for r in rcpts if r.lower() not in seen_to]
    # The level (and, when it is on, the ledger) on the exact envelope this run
    # delivers. The render mode is part of the
    # approved letter: an approved plain letter cannot go out as HTML. The
    # standing list sees what the caller typed: the configured owner CC is not
    # part of that view, as it never was for the hook.
    explicit_cc = [a.cc] if a.cc and not (a.cc == OWNER_CC and not cc_given) else []
    letter = {
        "to": to_addrs, "cc": cc_addrs, "text": f"{a.subject}\n{body}",
        "render": "--html-wrap" if a.html_wrap else ("--html" if a.html else ""),
        "attachments": att_env,
        "raw_to": a.to, "raw_cc": a.cc,
        "explicit_to": [a.to], "explicit_cc": explicit_cc,
        "default_cc": envelope_recipients(OWNER_CC) if (OWNER_CC and a.cc == OWNER_CC and not cc_given) else [],
    }

    def checked(phase):
        try:
            notes = sender_check.check(letter, phase=phase)
        except Exception as exc:  # noqa: BLE001 -- sender_check.Refused, or anything: refuse
            print(f"KULDES MEGTAGADVA: {exc}", file=sys.stderr)
            sys.exit(3)
        for line in notes:
            print(line, file=sys.stderr)

    # APPROVALPRECHECK1122: the pre phase decides without consuming, before the
    # vault or SMTP; the full check (which consumes a level-2 approval or
    # records a standing send) runs only once the connection is logged in, right
    # before delivery. A vault or SMTP failure no longer burns the approval.
    checked("pre")
    # FQDN EHLO name is REQUIRED: some SMTP providers reject EHLO with a private/bare
    # IP ([192.168.x.x]) -> "421 4.4.2 timeout exceeded". local_hostname forces a
    # proper FQDN; derive it from the mailbox domain.
    ehlo_host = lib.EMAIL.split("@")[-1] if "@" in lib.EMAIL else "localhost"
    pw = lib.password()
    with smtplib.SMTP_SSL(lib.SMTP_HOST, lib.SMTP_PORT,
                          local_hostname=ehlo_host,
                          context=ssl.create_default_context(), timeout=45) as s:
        s.login(lib.EMAIL, pw)
        checked("full")  # a refusal exits 3 here; leaving the with-block closes the connection
        s.send_message(msg, to_addrs=rcpts)
    print(f"SENT from {lib.FROM_ADDRESS} to {a.to}" + (f" cc {a.cc}" if a.cc else " CC NELKUL (--no-owner-cc)"))

    # AUDIT TRAIL (SUPPJOGVAK901): SMTP send alone does NOT populate the mailbox
    # Sent folder, so an outgoing auto-reply used to leave no readable record --
    # a later "did we ever send X to a paying customer?" question then had no
    # source to answer from. Append a copy to Sent over IMAP so every send is
    # auditable. Fail-safe: the mail is ALREADY sent by this point, so an append
    # error is logged (stderr) but never raised -- the reply must not be treated
    # as failed just because its audit copy could not be filed.
    folder = SENT_FALLBACK
    try:
        M = imaplib.IMAP4_SSL(lib.IMAP_HOST, lib.IMAP_PORT,
                              ssl_context=ssl.create_default_context())
        M.login(lib.EMAIL, pw)
        configured = lib.SENT_FOLDER
        list_items = []
        if not configured:
            # A failed LIST never stops the copy: the fallback folder is used, and said.
            try:
                typ, list_items = M.list()
                if typ != "OK":
                    list_items = []
            except Exception as e:  # noqa: BLE001
                print(f"audit: LIST failed ({e}), using {SENT_FALLBACK}", file=sys.stderr)
                list_items = []
        folder, source = choose_sent_folder(configured, list_items)
        M.append(imap_mailbox_arg(folder), "(\\Seen)",
                 imaplib.Time2Internaldate(time.time()), msg.as_bytes())
        M.logout()
        print(f"audit: copy appended to {folder} ({source})")
    except Exception as e:
        print(f"audit: Sent-append to {folder} FAILED (mail WAS sent to {a.to}): {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
