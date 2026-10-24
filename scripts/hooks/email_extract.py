#!/usr/bin/env python3
"""Shared email-payload extraction (EMAILKAPU901 PR1).

Single source of truth for recovering the OUTGOING LETTER (recipients, subject,
body) from a send invocation, used by BOTH gates:
  - scripts/hooks/outgoing-copy-gate.py (copy audit: accents, names, em dash)
  - the level-2 email approval gate (PR2): content-hash anchor over
    to + cc + subject + body -- the approval record pins the EXACT letter, and
    a send is allowed only on an exact match.

The extraction boundary (Marveen, msg 17900) is deterministic-or-deny:
  - readable literal (--body "...", < /abs/path, heredoc, MCP fields) -> text
  - anything shell-expanded at run time ($(cat), `...`, $VAR, unresolvable
    path, pipe) -> unreadable_reason, and the CALLER must fail closed.
The SAME boundary applies to recipients (msg 17936): a --to that comes from a
variable is not "approximately right", it is unreadable -> deny. A body+subject
hash alone would let an approved letter be re-sent to a DIFFERENT recipient.

collect_bash_body / collect_mcp_body moved here VERBATIM from
outgoing-copy-gate.py (behavior-neutral; parity proven byte-for-byte against a
golden captured from the pre-move code -- scripts/__tests__/email-extract-parity.test.py).
"""
import hashlib
import html
import json
import os
import re
import subprocess

def collect_bash_body(cmd: str):
    """Return (text, unreadable_reason). text is '' when nothing was recovered."""
    parts = []
    for m in re.finditer(r"--(?:body|subject)[= ]+(\"([^\"]*)\"|'([^']*)'|(\S+))", cmd):
        val = m.group(2) or m.group(3) or m.group(4) or ""
        # A shell-expanded --body ($(cat f), `cat f`, $VAR) reaches this hook
        # UNEXPANDED: what we would audit is the literal command text, not the
        # letter. That is worse than useless -- it fires on words that happen to
        # sit in the PATH while the real copy goes uninspected. Measured
        # 2026-08-11 on a live customer letter: `--body "$(cat .../hidli_zaro_
        # level.txt)"` blocked on "level" from the FILENAME, and the letter
        # itself was never read. Same fail-closed rule as the `<` branch below.
        if re.search(r"\$\(|`|\$\{?\w", val):
            return ("\n".join(parts),
                    "a --body shell-behelyettesitest tartalmaz, amit a hook nem old fel "
                    f"({val[:60]}...) -- igy a parancs szoveget vizsgalnam, nem a levelet")
        parts.append(val)
    # heredoc payloads sit inline in the command string
    for m in re.finditer(r"<<-?\s*'?(\w+)'?\n(.*?)\n\1", cmd, re.S):
        parts.append(m.group(2))
    # A single `<` only. Without the lookarounds a heredoc (`<<'EOF'`) matches
    # here and the quoted delimiter is taken for a filename -- caught by the
    # first live probe of this gate, which blocked with "'EOF': No such file".
    # `(?<![<=])`: a `=<` is curl's `-F "name=<file"` (read by the file-body
    # forms below), not a shell redirect; the quoted form would otherwise be
    # taken as a redirect to a path ending in the closing quote.
    redirect = re.search(r"(?<![<=])<(?!<)\s*([^\s|;&<>]+)", cmd)
    if redirect:
        raw = redirect.group(1)
        path = os.path.expandvars(os.path.expanduser(raw))
        if "$" in path:
            return ("\n".join(parts), f"a torzs egy fel nem oldhato utvonalrol jon ({raw})")
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                parts.append(fh.read())
        except OSError as exc:
            return ("\n".join(parts), f"a torzs-fajl nem olvashato ({path}: {exc})")
    # GATEBINVAK916: curl's `@file` payload (-d/--data/--data-binary/--json/
    # --data-urlencode @path). Before this branch the body of such a call was
    # never read: on the Resend path that made every @file letter -- clean ones
    # too -- fail closed with the generic "no inspectable text" reason, and the
    # real content was never audited. --data-raw is deliberately NOT here: it
    # sends a literal "@path", it reads no file.
    # Every curl/wget shape that sends a FILE as the body, each with its own
    # label: an unreadable one then says WHICH shape failed, instead of the
    # generic "no inspectable text" that this change exists to retire
    # (Marveen's #1507 review: `--data-urlencode name@file` LOOKED handled --
    # the flag was in the @ regex -- but the name@ form never matched).
    for label, rx in _FILE_BODY_FORMS:
        for m in rx.finditer(cmd):
            ref = m.group(1)
            if ref in ("-", "."):
                # stdin: a heredoc is already in `parts`; a pipe is not readable.
                if not parts:
                    return ("", f"a torzs stdin-rol jon ({label} {ref}), heredoc nelkul -- a hook nem latja")
                continue
            text, reason = _read_body_file(ref, label)
            if reason:
                return ("\n".join(parts), reason)
            parts.append(text)
    if not parts and re.search(r"\|\s*(python3?|node|tsx)?[^|]*send", cmd):
        return ("", "a torzs egy pipe-bol jon, a hook nem latja")
    return ("\n".join(parts), None)


# GATEBINVAK916: the file-body shapes. Each flag must stand alone (leading
# space or start), so an address like x@y.hu or an @ inside a quoted payload is
# never taken for a file. Measured list (Marveen's #1507 review, against the
# gate's own _CURL_BODY_OPTS): the six @-flags, plus the five shapes that also
# send a FILE but were not read: --data-urlencode name@file, -F/--form
# name=@file or name=<file, wget --post-file / --body-file, curl -T.
# NOT here, deliberately: --data-raw (sends a literal "@path", reads nothing)
# and --form-string (literal). The inline literal flags (-d '...',
# --post-data '...') stay outside this branch as before.
_REF = r"['\"]?([^\s'\"|;&<>]+)"
_FILE_BODY_FORMS = (
    ("@", re.compile(
        r"(?:^|\s)(?:-d|--data|--data-binary|--data-ascii|--json|--data-urlencode)"
        r"(?:=|\s+|(?<=-d))['\"]?@([^\s'\"|;&<>]+)")),
    ("--data-urlencode name@", re.compile(
        r"(?:^|\s)--data-urlencode(?:=|\s+)['\"]?[A-Za-z0-9_.-]+@([^\s'\"|;&<>]+)")),
    ("-F/--form name=@|<", re.compile(
        r"(?:^|\s)(?:-F|--form)(?:=|\s+)['\"]?[^\s'\"=]+=[@<]([^\s'\";|&<>]+)")),
    ("wget --post-file/--body-file", re.compile(
        r"(?:^|\s)--(?:post|body)-file(?:=|\s+)" + _REF)),
    ("curl -T/--upload-file", re.compile(
        r"(?:^|\s)(?:-T|--upload-file)(?:=|\s+)" + _REF)),
)


def _read_body_file(ref: str, label: str):
    """(text, unreadable_reason) for a file named as a request body."""
    shown = f"@{ref}" if label == "@" else f"{label} {ref}"  # as the user typed it
    path = os.path.expandvars(os.path.expanduser(ref))
    if "$" in path:
        return ("", f"a torzs egy fel nem oldhato utvonalrol jon ({shown})")
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            data = fh.read()
    except OSError as exc:
        return ("", f"a torzs-fajl ({shown}) nem olvashato ({path}: {exc})")
    return _payload_text(data, ref)


# The prose fields of a JSON payload. A JSON body is audited through these,
# DECODED: the raw file would show "\u00e1" for "a" with an accent, and the
# accent audit would read escape sequences instead of the letter.
_PAYLOAD_TEXT_FIELDS = ("subject", "text", "html", "body", "content", "message")


def _payload_text(data: str, raw: str):
    """(text, unreadable_reason) for a payload read from an @file."""
    try:
        obj = json.loads(data)
    except ValueError:
        return (data, None)  # not JSON: the file IS the text
    if not isinstance(obj, dict):
        return ("", f"a torzs-fajl (@{raw}) JSON, de nem objektum -- a hook nem tudja, mi benne a szoveg")
    got = [str(obj[f]) for f in _PAYLOAD_TEXT_FIELDS if obj.get(f)]
    if not got:
        return ("", f"a torzs-fajl (@{raw}) JSON-jaban nincs ismert szoveg-mezo "
                    f"({', '.join(_PAYLOAD_TEXT_FIELDS)})")
    return ("\n".join(got), None)


def collect_mcp_body(tool_input: dict, tool_name: str = ""):
    # By NAME when the caller knows it (MS365MAIL1024 round 2): a non-Graph tool
    # with an object body keeps the flat read, and a Graph tool without a Graph
    # shape is still read the Graph way. The shape remains the fallback for the
    # callers that have no name (collect_email_envelope's Bash path passes "").
    if (is_ms365_tool(tool_name) if tool_name else is_ms365_shaped(tool_input)):
        return ms365_text(tool_input)
    fields = ("body", "text", "html", "htmlBody", "message", "subject", "content", "forwardText")
    got = [str(tool_input[f]) for f in fields if tool_input.get(f)]
    return "\n".join(got)

# --- recipients (new in PR1; consumed by the PR2 approval gate) --------------
# Same unreadable boundary as the body branches above: shell substitution in a
# recipient value means the hook would hash the COMMAND TEXT while the real
# recipient is decided at run time -- deny, never approximate.
_SHELL_SUBST = re.compile(r"\$\(|`|\$\{?\w")


def collect_bash_recipients(cmd: str):
    """Return (to, cc, bcc, unreadable_reason); recipient lists hold literal
    values. bcc is part of the envelope since EMAILBCCHORGONY903: an anchor
    that ignores it lets an approved letter be re-sent WITH an added --bcc,
    delivering to a recipient nobody approved."""
    to, cc, bcc = [], [], []
    buckets = {"to": to, "cc": cc, "bcc": bcc}
    for m in re.finditer(r"--(to|cc|bcc)[= ]+(\"([^\"]*)\"|'([^']*)'|(\S+))", cmd):
        val = m.group(3) or m.group(4) or m.group(5) or ""
        if _SHELL_SUBST.search(val):
            return (to, cc, bcc,
                    f"a --{m.group(1)} shell-behelyettesitest tartalmaz, amit a hook "
                    f"nem old fel ({val[:60]}...) -- a cimzett futasidoben dol el")
        buckets[m.group(1)].append(val)
    return (to, cc, bcc, None)


def collect_mcp_recipients(tool_input: dict):
    """Return (to, cc, bcc, unreadable_reason). Values are kept RAW (no
    splitting, no lowercasing): the hash anchor needs exact bytes, not address
    semantics. bcc: see collect_bash_recipients (EMAILBCCHORGONY903)."""
    def norm(v):
        if v is None or v == "":
            return []
        if isinstance(v, (list, tuple)):
            return [str(x) for x in v]
        return [str(v)]
    return (norm(tool_input.get("to")), norm(tool_input.get("cc")),
            norm(tool_input.get("bcc")), None)


# --- HTML body and attachments (EMAILHTMLHORGONY929) -------------------------
# A send.py-style command can carry the letter's HTML alternative (--html <file>)
# and attachments (--attach <file>, repeatable). Neither is in `text` (the copy
# gate audits the plain letter), so an anchor over to/cc/bcc/text alone let an
# APPROVED letter go out with a different HTML body or with an added or changed
# attachment: the owner received something other than what was approved. The
# envelope carries their sha256 digests; the approval gate's anchor takes them
# only when present, so every existing anchor stays byte-identical. Same
# unreadable boundary as the body and the recipients: a shell-expanded, empty
# or unreadable path is not approximated -- the caller denies.
#
# The flag is read the way argparse reads it (a tester's finding): it may be quoted
# ("--attach") or an unambiguous prefix (--att, --ht); after "=" the value is
# literal; after whitespace the next token is the value ONLY if it does not start
# with "-", because argparse takes such a token as the next option. So a
# store_true switch of the same name is not a file flag: scripts/support-mail/
# send.py's --html ("... --html --cc x") stays a switch, and the anchor of that
# letter is unchanged. The value is captured in a lookahead, so a token after a
# switch (another --attach) is still seen by the next match. --html-wrap is not
# --html (the flag must end in "=" or whitespace).
_FILE_FLAG_RE = re.compile(
    r"(?:^|\s)([\"']?)--(html|htm|ht|attach|attac|atta|att)\1"
    r"(?=(=|\s+)(?:\"([^\"]*)\"|'([^']*)'|([^\s|;&<>]+)))")


def collect_bash_attachments(cmd: str):
    """Return (html_sha256 or None, attachments, unreadable_reason); attachments
    is a list of {"name", "sha256", "size"} sorted by name then digest, so the
    order of the flags on the command line does not change the anchor."""
    html, atts = None, []
    for m in _FILE_FLAG_RE.finditer(cmd):
        flag = "html" if m.group(2).startswith("ht") else "attach"
        ref = next(g for g in (m.group(4), m.group(5), m.group(6)) if g is not None)
        if m.group(3) != "=" and ref.startswith("-"):
            continue  # the next token is an option: a switch of this name, not a file
        if not ref or _SHELL_SUBST.search(ref):
            return (None, [], f"a --{flag} ures vagy shell-behelyettesitest tartalmaz ({ref[:60]}) "
                              "-- a fajl futasidoben dol el")
        path = os.path.expanduser(ref)
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError as exc:
            return (None, [], f"a --{flag} fajl nem olvashato ({path}: {exc})")
        digest = hashlib.sha256(data).hexdigest()
        if flag == "html":
            if html is not None:
                return (None, [], "tobb --html egy hivasban -- nem donthato el, melyik a level HTML-je")
            html = digest
        else:
            atts.append({"name": os.path.basename(path), "sha256": digest, "size": len(data)})
    atts.sort(key=lambda a: (a["name"], a["sha256"]))
    return (html, atts, None)


# The claude.ai Gmail connector's send-shaped tools (mcp__claude_ai_Gmail__*):
# no "send_email" in the name, so the name-based test above never saw them.
# Kept for importers; the gates classify with classify_mail_tool below, which
# matches every name this pattern matches.
CONNECTOR_SEND_RE = re.compile(r"gmail__(reply|reply_all|send_message|forward)$", re.I)


# --- tool-name classification -------------------------------------------------
# ONE classifier for the main agent's mail gates (email-approval-gate.py,
# outgoing-copy-gate.py, credential-gate.py) and, as a JS twin, for the
# sub-agent gate (scripts/email-send-gate.mjs classifyMailTool). Both copies
# are bound by the shared case list scripts/hooks/mail-tool-name-cases.json,
# which src/__tests__/email-gate-matcher-drift.test.ts runs through both.
#
# Why the base-name SUFFIX: vendor/gmail-mcp-fork prepends its tool prefix
# (--tool-prefix / GMAIL_MCP_TOOL_PREFIX) to every tool name VERBATIM, with no
# separator guaranteed ("v2_", "v2", "work-", ...). The patterns the gates
# carried described what stands BEFORE the base name (`gmail__reply_all$`,
# `(^|__)draft_email$`, `(^|__)manage_email$`), so every prefixed name slipped
# past them: mcp__gmail__v2_reply_all was not a send for any gate, and
# mcp__gmail__v2_draft_email skipped the sub-agent recipient ledger. A verbatim
# prefix leaves exactly one invariant intact, that the base name is the END of
# the tool name, so the test is endswith(base) and nothing is assumed about
# what precedes it. The same holds for the server segment: reply_all and
# send_draft are sends on a server of any name (the vendored server registered
# as server-gmail-autoauth-mcp never matched `gmail__reply_all$`).
#
# The classifier covers every name the patterns it replaces matched:
#   - send_email and the three draft names keep the SUBSTRING match the
#     widest of the old gates used;
#   - manage_email is the suffix: a prefixed mcp__x__v2_manage_email is the
#     multiplexer, a look-alike such as manage_emails_bulk is not (the
#     sub-agent gate's pinned rule). The approval gate, whose scope always
#     matched the substring, keeps that on top (its scope_kind);
#   - `gmail__(reply|reply_all|send_message|forward)$` implies "gmail" in the
#     name plus the suffix, which is what the connector test checks;
#   - the generic words send_message / reply / forward count only with "gmail"
#     somewhere in the qualified name, because the Telegram plugin's tool is
#     `..._telegram__reply` and the mail gates must never fire on it;
#   - send_gmail_message / draft_gmail_message (the Google Workspace MCP's
#     Gmail send and draft tools) carry neither "send_email" nor a known
#     draft name, so they are matched by name (substring) as send_email and
#     draft kinds;
#   - send_draft is NEW: it sends an existing draft by draftId and no gate knew
#     it. The vendored server ships it next to draft_email, so a sub-agent
#     could draft (ledger-checked) and then send the draft with no gate at all.
#   - send_mail / send_mail_auto (the harder-mail MCP's sends) are suffixes too
#     (HARDERMAILGATES1019): measured 2026-10-19, no gate saw them. They are
#     connector_send, not send_email: a reply names the original message
#     (reply_to_uid + reply_folder) instead of a `to`, as a connector reply does
#     by messageId, and the sub-agent gate's thread-reply narrowing reads
#     send_email-shaped Gmail fields, which must never release these. Its
#     create_draft is a draft by the substring rule above.
# A read tool whose name happens to END in a send-shaped base is classified as
# a send: that false positive fails closed, the direction a mail gate may err
# in. lowercase + endswith/in, no regex, so the two copies cannot drift on
# `$`-before-newline semantics.
_CONNECTOR_GENERIC_SUFFIXES = ("send_message", "reply", "forward")
_DRAFT_NAMES = ("draft_email", "create_draft", "update_draft", "draft_gmail_message")
_MAILBOX_SEND_SUFFIXES = ("send_mail", "send_mail_auto")
# Microsoft Graph MCP names, hyphens normalized (MS365MAIL1024).
_MS365_SEND_SUFFIXES = ("send_mail", "send_shared_mailbox_mail", "reply_mail_message",
                        "reply_all_mail_message", "forward_mail_message", "reply_shared_mailbox_mail",
                        "reply_all_shared_mailbox_mail", "forward_shared_mailbox_mail",
                        "forward_calendar_event", "reply_to_group_thread")
_MS365_DRAFT_SEND_SUFFIXES = ("send_draft_message", "send_shared_mailbox_draft")
_MS365_DRAFT_SUFFIXES = ("create_draft_email", "create_shared_mailbox_draft", "create_reply_draft",
                         "create_reply_all_draft", "create_forward_draft",
                         "create_shared_mailbox_reply_draft", "create_shared_mailbox_reply_all_draft",
                         "create_shared_mailbox_forward_draft", "update_mail_message",
                         "update_shared_mailbox_message")

# Kinds (the same vocabulary as classifyMailTool in email-send-gate.mjs):
#   "send_email"     address-carrying direct send (to/cc/bcc fields)
#   "connector_send" reply_all, or a Gmail send_message / reply / forward
#                    (often addressed by messageId), or a send_mail /
#                    send_mail_auto (a reply addressed by reply_to_uid)
#   "send_draft"     sends an existing draft by draftId: no envelope visible
#   "manage_email"   the multiplexer: the operation decides
#   "draft"          writes a draft (draft_email / create_draft / update_draft)
#   None             not an outbound mail tool (reads, search, labels, delete)
MAIL_TOOL_KINDS = ("send_email", "connector_send", "send_draft", "manage_email", "draft")


def classify_mail_tool(tool_name):
    """Classify a (possibly prefixed, qualified) tool name. Strictest kind
    first, so a name that fits two kinds lands in the one that gates harder."""
    n = str(tool_name or "").lower().replace("-", "_")
    if not n or n == "bash":
        return None
    if "send_email" in n or "send_gmail_message" in n:
        return "send_email"
    if n.endswith("reply_all"):
        return "connector_send"
    if "gmail" in n and n.endswith(_CONNECTOR_GENERIC_SUFFIXES):
        return "connector_send"
    if n.endswith(_MAILBOX_SEND_SUFFIXES):
        return "connector_send"
    if n.endswith(_MS365_SEND_SUFFIXES):
        return "connector_send"
    if n.endswith(_MS365_DRAFT_SEND_SUFFIXES):
        return "send_draft"
    if n.endswith("send_draft"):
        return "send_draft"
    if n.endswith("manage_email"):
        return "manage_email"
    if n.endswith(_MS365_DRAFT_SUFFIXES):
        return "draft"
    if any(d in n for d in _DRAFT_NAMES):
        return "draft"
    return None


# --- Microsoft Graph letters (MS365MAIL1024) ------------------------------------
# The ms365 MCP server names its tools with hyphens and carries the letter
# Graph-shaped: body.Message.{subject, body:{contentType, content},
# toRecipients/ccRecipients/bccRecipients:[{emailAddress:{address, name?}}]},
# a reply's Comment, a forward's ToRecipients, a group-thread post's Post.
# The server reads keys in ANY case (so a key twice in different case is
# ambiguous -> reason), and moves a stray top-level field into body (so a
# stray is read wherever it sits). Reading is STRICT for the anchor (any
# field the anchor does not cover is a reason: fail-closed) and LENIENT for
# the copy audit's text (subject, body content, comment, post content).
# SECURITY review on MS365MAIL1024: the anchor now knows WHICH Graph send it
# anchors (per-tool body keys, an op token, one address per recipient entry,
# contentType in the anchor); the lenient text reader is case-strict about
# duplicates, because a "Subject" and a "subject" could otherwise be audited
# as one text and delivered as the other.
# Per Graph send: the top-level keys (path parameters) each send takes, besides body.
# A key another send takes is NOT allowed on this one (MS365MAIL1024 round 2): a
# userId accepted on send-mail was never read by the server, so the anchor would
# cover a field that does not exist, and stay silent about one that does.
_MS365_SEND_TOP_KEYS = {
    "send_mail": frozenset({"body"}),
    "send_shared_mailbox_mail": frozenset({"body", "userid"}),
    "reply_mail_message": frozenset({"body", "messageid"}),
    "reply_all_mail_message": frozenset({"body", "messageid"}),
    "forward_mail_message": frozenset({"body", "messageid"}),
    "reply_shared_mailbox_mail": frozenset({"body", "messageid", "userid"}),
    "reply_all_shared_mailbox_mail": frozenset({"body", "messageid", "userid"}),
    "forward_shared_mailbox_mail": frozenset({"body", "messageid", "userid"}),
    "forward_calendar_event": frozenset({"body", "eventid"}),
    "reply_to_group_thread": frozenset({"body", "groupid", "conversationthreadid"}),
}
_MS365_ANCHOR_TOKEN_RE = re.compile(r"^(messageId|userId|eventId|groupThread|op|saveToSentItems):")
_MS365_MESSAGE_KEYS = frozenset({"subject", "body", "torecipients", "ccrecipients", "bccrecipients"})
_MS365_CONTENT_KEYS = frozenset({"contenttype", "content"})
_MS365_RECIPIENT_FIELDS = ("torecipients", "ccrecipients", "bccrecipients")
# Per Graph send: the body keys Graph actually reads. Any other body key is not delivered and not anchored.
_MS365_SEND_BODY_KEYS = {
    "send_mail": frozenset({"message", "savetosentitems"}),
    "send_shared_mailbox_mail": frozenset({"message", "savetosentitems"}),
    "reply_mail_message": frozenset({"message", "comment"}),
    "reply_all_mail_message": frozenset({"message", "comment"}),
    "reply_shared_mailbox_mail": frozenset({"message", "comment"}),
    "reply_all_shared_mailbox_mail": frozenset({"message", "comment"}),
    "forward_mail_message": frozenset({"message", "comment", "torecipients"}),
    "forward_shared_mailbox_mail": frozenset({"message", "comment", "torecipients"}),
    "forward_calendar_event": frozenset({"torecipients", "comment"}),
    "reply_to_group_thread": frozenset({"post"}),
}
_MS365_TOP_GRAPH_KEYS = frozenset({"torecipients", "ccrecipients", "bccrecipients"})
_MS365_ADDR_RE = re.compile(r"^[^\s<>,;:\"'()\[\]@]+@[^\s<>,;:\"'()\[\]@]+$")


def ms365_op(tool_name) -> str | None:
    """The Graph send this tool is (a key of _MS365_SEND_BODY_KEYS), from its normalized name."""
    n = str(tool_name or "").lower().replace("-", "_")
    for op in sorted(_MS365_SEND_BODY_KEYS, key=len, reverse=True):
        if n.endswith(op):
            return op
    return None


def ms365_tool_kind(tool_name) -> str | None:
    """'send' / 'draft_send' / 'draft' for a Microsoft Graph MCP mail tool, by NAME, else None.
    The Graph server names its tools with hyphens; the last segment of the qualified name
    must contain one, so the harder-mail server's underscored send_mail is never Graph."""
    raw = str(tool_name or "").lower()
    last = raw.rsplit("__", 1)[-1]
    if "-" not in last:
        return None
    n = raw.replace("-", "_")
    if any(n.endswith(op) for op in _MS365_SEND_BODY_KEYS):
        return "send"
    if n.endswith(_MS365_DRAFT_SEND_SUFFIXES):
        return "draft_send"
    if n.endswith(_MS365_DRAFT_SUFFIXES) or n.endswith("create_draft_email"):
        return "draft"
    return None


def is_ms365_tool(tool_name) -> bool:
    return ms365_tool_kind(tool_name) is not None


def is_ms365_anchor_token(value) -> bool:
    """An id/op token ms365_send_fields puts into `to` (never a recipient address)."""
    return bool(_MS365_ANCHOR_TOKEN_RE.match(str(value)))


def is_ms365_shaped(tool_input) -> bool:
    """A Microsoft Graph-shaped call: a `body` (key in any case) that is an object, a
    `Message`/`Post` that is an object, or a Graph recipient list at the top. A call
    whose fields all sit at the top level is Graph-shaped too; the server moves them
    into body."""
    if not isinstance(tool_input, dict):
        return False
    for k, v in tool_input.items():
        lk = str(k).lower()
        if isinstance(v, dict) and lk in ("body", "message", "post"):
            return True
        if isinstance(v, list) and lk in _MS365_TOP_GRAPH_KEYS:
            return True
    return False


def ms365_flat_conflict(tool_input) -> str | None:
    """A Graph-shaped call that ALSO carries flat to/cc/bcc is ambiguous: one reader would hide the other's addresses."""
    if not isinstance(tool_input, dict):
        return None
    flat = [k for k in tool_input if str(k).lower() in ("to", "cc", "bcc") and tool_input[k] not in (None, "", [])]
    return f"a hivas lapos ({', '.join(sorted(flat))}) es Graph-alaku cimzettet is visz -- nem egyertelmu" if flat else None


def _ms365_lower(d: dict, where: str):
    """(the dict with lowercased keys, reason). A key twice in different case is ambiguous."""
    out = {}
    for k, v in d.items():
        lk = str(k).lower()
        if lk in out:
            return None, f"{where}: a(z) {lk!r} mezo ketszer szerepel (kis/nagybetu) -- nem egyertelmu"
        out[lk] = v
    return out, None


def _ms365_recipients(value, where: str):
    """[{emailAddress: {address, name?}}] -> (addresses, reason). Strict: nothing else is accepted."""
    if value is None:
        return [], None
    if not isinstance(value, list):
        return [], f"{where}: nem lista"
    out = []
    for i, item in enumerate(value):
        here = f"{where}[{i}]"
        if not isinstance(item, dict):
            return [], f"{here}: nem objektum"
        it, reason = _ms365_lower(item, here)
        if reason:
            return [], reason
        if set(it) - {"emailaddress"}:
            return [], f"{here}: ismeretlen mezo {sorted(set(it) - {'emailaddress'})}"
        ea = it.get("emailaddress")
        if not isinstance(ea, dict):
            return [], f"{here}.emailAddress: nem objektum"
        e, reason = _ms365_lower(ea, f"{here}.emailAddress")
        if reason:
            return [], reason
        if set(e) - {"address", "name"}:
            return [], f"{here}.emailAddress: ismeretlen mezo {sorted(set(e) - {'address', 'name'})}"
        addr = e.get("address")
        if not isinstance(addr, str) or not addr.strip():
            return [], f"{here}.emailAddress.address: hianyzik vagy nem szoveg"
        # One bare address, nothing around it: a '"owner@x" <stranger@y>' entry
        # would let the owner-CC check find the owner while the letter goes to
        # the stranger (SECURITY review on MS365MAIL1024).
        if not _MS365_ADDR_RE.match(addr.strip()):
            return [], f"{here}.emailAddress.address: nem egyetlen puszta cim ({addr[:60]!r})"
        if "name" in e and not isinstance(e["name"], str):
            return [], f"{here}.emailAddress.name: nem szoveg"
        out.append(addr.strip())
    return out, None


def _ms365_content(value, where: str):
    """A Graph itemBody {contentType, content} -> (content, content_type, reason).
    content_type is the lowercased contentType ("text"/"html") or None, so the
    caller can anchor Text and HTML differently."""
    if value is None:
        return "", None, None
    if not isinstance(value, dict):
        return "", None, f"{where}: nem objektum (MIME vagy szoveges torzs nem horgonyozhato)"
    b, reason = _ms365_lower(value, where)
    if reason:
        return "", None, reason
    if set(b) - _MS365_CONTENT_KEYS:
        return "", None, f"{where}: ismeretlen mezo {sorted(set(b) - _MS365_CONTENT_KEYS)}"
    ctype = b.get("contenttype")
    if ctype is not None:
        if not isinstance(ctype, str) or ctype.lower() not in ("text", "html"):
            return "", None, f"{where}.contentType: csak Text vagy HTML"
        ctype = ctype.lower()
    content = b.get("content")
    if content is not None and not isinstance(content, str):
        return "", None, f"{where}.content: nem szoveg"
    if content and ctype is None:
        # The server defaults an absent contentType (to Text today): the anchor
        # must not cover a letter whose rendering the sender did not pin down,
        # because a later default change would re-deliver it as something else.
        return "", None, f"{where}.contentType: hianyzik (Text vagy HTML kell)"
    return content or "", ctype, None


def _ms365_body_text(content, content_type, parts):
    """An itemBody's content into the anchor parts: HTML is marked, so the same
    letter sent as Text and as HTML never shares an anchor (what the recipient
    sees differs)."""
    if content_type == "html":
        parts.append(f"[{content_type}]\n{content}" if content else "[html]")
    else:
        parts.append(content)


def ms365_send_fields(tool_input: dict, tool_name: str = ""):
    """(to, cc, bcc, text, reason) for a Graph-shaped SEND, read strictly: any field the anchor
    does not cover (attachments, from, replyTo, headers, importance, a MIME body, a stray
    top-level field the server would move into body) is a reason, so the caller fails closed.
    The ids the call answers or sends from go into `to` as tokens, and so does the Graph
    operation itself (op:<name>, from the tool name): an approval for a reply must not answer
    a reply-all of the same message, and a body key one Graph send reads (a forward's
    ToRecipients) is an undelivered field on another (sendMail never delivers body.ToRecipients)."""
    empty = ([], [], [], "")
    op = ms365_op(tool_name)
    if op is None:
        return (*empty, f"nem ismert Graph-kuldes ({tool_name!r}) -- nem horgonyozhato")
    flat = ms365_flat_conflict(tool_input)
    if flat:
        return (*empty, flat)
    top, reason = _ms365_lower(tool_input, "a hivas")
    if reason:
        return (*empty, reason)
    extra = set(top) - _MS365_SEND_TOP_KEYS[op]
    if extra:
        return (*empty, f"a {op} hivasban nem vart mezo {sorted(extra)}")
    body, reason = (_ms365_lower(top["body"], "body") if isinstance(top.get("body"), dict)
                    else (None, "body: hianyzik vagy nem objektum (MIME vagy szoveges torzs nem horgonyozhato)"))
    if reason:
        return (*empty, reason)
    extra = set(body) - _MS365_SEND_BODY_KEYS[op]
    if extra:
        return (*empty, f"a {op} body-jaban nem kezbesitett/nem horgonyozhato mezo {sorted(extra)}")
    to, cc, bcc, parts = [], [], [], []
    msg = body.get("message")
    if msg is not None:
        if not isinstance(msg, dict):
            return (*empty, "body.Message: nem objektum")
        m, reason = _ms365_lower(msg, "body.Message")
        if reason:
            return (*empty, reason)
        extra = set(m) - _MS365_MESSAGE_KEYS
        if extra:
            return (*empty, f"ismeretlen mezo a body.Message-ben {sorted(extra)} -- a level a horgony nelkul valtozhatna")
        subject = m.get("subject")
        if subject is not None and not isinstance(subject, str):
            return (*empty, "body.Message.subject: nem szoveg")
        if subject:
            parts.append(subject)
        content, content_type, reason = _ms365_content(m.get("body"), "body.Message.body")
        if reason:
            return (*empty, reason)
        _ms365_body_text(content, content_type, parts)
        for field, bucket in zip(_MS365_RECIPIENT_FIELDS, (to, cc, bcc)):
            got, reason = _ms365_recipients(m.get(field), f"body.Message.{field}")
            if reason:
                return (*empty, reason)
            bucket.extend(got)
    got, reason = _ms365_recipients(body.get("torecipients"), "body.ToRecipients")
    if reason:
        return (*empty, reason)
    to.extend(got)
    comment = body.get("comment")
    if comment is not None and not isinstance(comment, str):
        return (*empty, "body.Comment: nem szoveg")
    if comment:
        parts.append(comment)
    post = body.get("post")
    if post is not None:
        if not isinstance(post, dict):
            return (*empty, "body.Post: nem objektum")
        p, reason = _ms365_lower(post, "body.Post")
        if reason:
            return (*empty, reason)
        if set(p) - {"body"}:
            return (*empty, f"ismeretlen mezo a body.Post-ban {sorted(set(p) - {'body'})}")
        content, content_type, reason = _ms365_content(p.get("body"), "body.Post.body")
        if reason:
            return (*empty, reason)
        _ms365_body_text(content, content_type, parts)
    stsi = body.get("savetosentitems")
    if stsi is not None and not isinstance(stsi, bool):
        # A bool check, not a truthy one: in Python 0 == False and 1 == True, so
        # a 0/1 SaveToSentItems would slip a changed value past the anchor.
        return (*empty, "body.SaveToSentItems: nem igaz/hamis")
    if stsi is not None:
        # The copy-to-Sent-Items decision is part of what is approved (a send
        # with it off leaves no trace in the owner's mailbox), so it joins the
        # anchor when present -- absent keeps every existing anchor unchanged.
        to.append(f"saveToSentItems:{'true' if stsi else 'false'}")
    for key, label in (("messageid", "messageId"), ("userid", "userId"), ("eventid", "eventId")):
        v = top.get(key)
        if v is None:
            continue
        if not isinstance(v, str) or not v:
            return (*empty, f"{label}: nem szoveg vagy ures")
        to.append(f"{label}:{v}")
    g, t = top.get("groupid"), top.get("conversationthreadid")
    if g is not None or t is not None:
        if not (isinstance(g, str) and g and isinstance(t, str) and t):
            return (*empty, "groupId / conversationThreadId: hianyzik vagy nem szoveg")
        to.append(f"groupThread:{g}/{t}")
    to.append(f"op:{op}")
    return to, cc, bcc, "\n".join(parts), None


def ms365_recipients(tool_input: dict, include_top: bool = True):
    """(to, cc, bcc, reason) of a Graph-shaped call, for the recipient checks (owner CC, ledger,
    a draft): only the recipient fields are read, each strictly, wherever the server would take
    them from -- the top level (a stray the server moves into body), body itself (create-draft-email,
    update-mail-message), body.Message, and body.ToRecipients (a forward)."""
    flat = ms365_flat_conflict(tool_input)
    if flat:
        return [], [], [], flat
    to, cc, bcc = [], [], []
    top, reason = _ms365_lower(tool_input, "a hivas")
    if reason:
        return [], [], [], reason
    # include_top=False: the owner-CC check must not count an address in a stray top-level
    # field the server may not deliver; the ledger and the drafts read it, the stricter way.
    places = [("a hivas", top)] if include_top else []
    msg = top.get("message")
    if msg is not None and include_top:
        if not isinstance(msg, dict):
            return [], [], [], "a hivas.Message: nem objektum"
        m, reason = _ms365_lower(msg, "a hivas.Message")
        if reason:
            return [], [], [], reason
        places.append(("a hivas.Message", m))
    body = top.get("body")
    if isinstance(body, dict):
        b, reason = _ms365_lower(body, "body")
        if reason:
            return [], [], [], reason
        places.append(("body", b))
        msg = b.get("message")
        if msg is not None:
            if not isinstance(msg, dict):
                return [], [], [], "body.Message: nem objektum"
            m, reason = _ms365_lower(msg, "body.Message")
            if reason:
                return [], [], [], reason
            places.append(("body.Message", m))
    for where, d in places:
        for field, bucket in zip(_MS365_RECIPIENT_FIELDS, (to, cc, bcc)):
            got, reason = _ms365_recipients(d.get(field), f"{where}.{field}")
            if reason:
                return [], [], [], reason
            bucket.extend(x for x in got if x not in bucket)
    return to, cc, bcc, None


def ms365_text_checked(tool_input):
    """The letter text of a Graph-shaped call for the copy audit, from wherever the server
    takes it (the top level, body, a Message or Post in either, an itemBody). A key twice
    in different case is a reason (the server could take the other one)."""
    parts = []
    def take(d, where, depth=0):
        if not isinstance(d, dict) or depth > 3:
            return None
        low, reason = _ms365_lower(d, where)
        if reason:
            return reason
        for key in ("subject", "comment"):
            if isinstance(low.get(key), str) and low[key]:
                parts.append(low[key])
        if isinstance(low.get("content"), str) and low["content"]:
            parts.append(low["content"])
        for key in ("body", "message", "post"):
            if isinstance(low.get(key), dict):
                reason = take(low[key], f"{where}.{key}", depth + 1)
                if reason:
                    return reason
        return None
    reason = take(tool_input, "a hivas")
    return ("\n".join(parts), reason) if not reason else ("", reason)


def ms365_text(tool_input) -> str:
    return ms365_text_checked(tool_input)[0]


# --- harder-mail letters (HARDERMAILGATES1019) --------------------------------
# What a harder-mail call carries beyond the shared to/cc/subject/body: the
# account it sends from, a reply's original (reply_to_uid + reply_folder, the
# server resolves the recipient from it, so a reply may carry no `to`), and a
# body_format. The classifier above decides THAT these tools are gated; the
# helpers below only read their letter.
HARDER_RENDERED_FORMATS = ("markdown", "html")
_HARDER_RENDER_TIMEOUT_S = 8
# The input fields the send anchor covers. Any other field (an attachment)
# changes the letter without changing the anchor, so its presence is
# fail-closed until the anchor learns it.
HARDER_SEND_FIELDS = frozenset(
    {"account", "to", "cc", "subject", "body", "reply_to_uid", "reply_folder", "body_format"})


def is_harder_mail_tool(tool_name) -> bool:
    """A harder-mail letter tool: a send by its suffix, or any tool of the
    harder-mail server (its create_draft is a generic name another MCP may
    carry, so the draft is recognised by the server segment)."""
    n = str(tool_name or "").lower()
    return n.endswith(_MAILBOX_SEND_SUFFIXES) or "__harder-mail__" in n or "__harder_mail__" in n


def _harder_mail_python():
    """The python of the harder-mail server's venv: HARDER_MAIL_PYTHON, else the
    `command` of the harder-mail MCP entry in this session's Claude config
    ($CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json). None if not found."""
    explicit = os.environ.get("HARDER_MAIL_PYTHON", "").strip()
    if explicit:
        return explicit
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~")
    try:
        with open(os.path.join(base, ".claude.json"), encoding="utf-8") as fh:
            entry = (json.load(fh).get("mcpServers") or {}).get("harder-mail") or {}
    except (OSError, ValueError):
        return None
    command = entry.get("command")
    return command if isinstance(command, str) and command else None


def collect_harder_mail_text(tool_input: dict):
    """(text, unreadable_reason) for a harder-mail draft/send carrying body_format
    markdown/html (design 6.3a): the TEXT the server puts in the plain part, from
    the server's own `python -m harder_mail_mcp.render`, plus the subject. The raw
    markup is never audited instead: a tag inside a word ("k<b>uldom</b>") splits
    it for the accent check, so the raw text can pass what the reader sees.
    Render missing, failing or rejecting -> unreadable (fail-closed)."""
    fmt = str(tool_input.get("body_format") or "plain")
    if fmt == "plain":
        return collect_mcp_body(tool_input), None
    if fmt not in HARDER_RENDERED_FORMATS:
        return "", f"ismeretlen body_format ({fmt[:20]!r}) -- csak plain, markdown vagy html lehet"
    python = _harder_mail_python()
    if not python:
        return "", ("a harder-mail render nem talalhato (HARDER_MAIL_PYTHON vagy a .claude.json "
                    "harder-mail bejegyzese kell), a formazott level szovege igy nem vizsgalhato")
    if not os.path.isabs(python):
        return "", (f"a harder-mail render interpretere nem abszolut utvonal ({python[:80]!r}) -- "
                    "PATH-bol feloldott python mas modult futtathatna")
    # Security review: `-m` puts the cwd on sys.path, and the hook runs in the
    # agent's working dir -- a harder_mail_mcp/render.py planted there would answer
    # "clean" for the real one (measured). -I keeps cwd, PYTHON* env and the user
    # site off the path; the fixed cwd is belt and braces.
    try:
        proc = subprocess.run([python, "-I", "-m", "harder_mail_mcp.render", "--format", fmt],
                              input=str(tool_input.get("body") or ""), capture_output=True,
                              text=True, timeout=_HARDER_RENDER_TIMEOUT_S,
                              cwd=os.path.dirname(python) or "/")
    except (OSError, subprocess.SubprocessError) as exc:
        return "", f"a harder-mail render nem futtathato ({type(exc).__name__})"
    if proc.returncode == 1:
        return "", "a harder-mail render elutasitotta a levelet: " + proc.stderr.strip()[:600]
    if proc.returncode != 0:
        return "", f"a harder-mail render hibaval lepett ki (rc={proc.returncode})"
    try:
        text = str(json.loads(proc.stdout)["text"])
    except (ValueError, KeyError, TypeError):
        return "", "a harder-mail render kimenete nem ertelmezheto"
    subject = str(tool_input.get("subject") or "")
    # The floor (security review): the interpreter comes from config the agent
    # can write, so a stand-in render could answer "clean". The raw body, its
    # tags stripped and entities decoded here, is audited too, so the audit is
    # never weaker than a deterministic local reading of the same letter.
    floor = _strip_markup(str(tool_input.get("body") or ""))
    return "\n".join(part for part in (text, floor, subject) if part), None


_BLOCK_TAG = re.compile(r"</?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote)\b[^>]*>", re.I)


def _strip_markup(body: str) -> str:
    """Tags out (a block tag is a line break, an inline tag joins its word, so
    "k<b>uldom</b>" reads "kuldom"), entities decoded."""
    return html.unescape(re.sub(r"<[^>]*>", "", _BLOCK_TAG.sub("\n", body)))


def _harder_send_envelope(ti: dict, to: list, reason):
    """(to, reason, extra) for a harder-mail send: the reply's original is the
    recipient anchor when there is no `to`, and the account, a non-plain
    body_format and the original join the anchor (extra)."""
    extra = {}
    unknown = sorted(k for k, v in ti.items() if k not in HARDER_SEND_FIELDS and v not in (None, ""))
    if unknown:
        reason = (f"a hivasban a horgony altal nem fedett mezo van ({', '.join(unknown)}) -- "
                  "egy ilyen mezo a levelet a horgony valtozasa nelkul valtoztatna meg")
    if ti.get("account"):
        extra["account"] = str(ti["account"])
    # Design 6.3b: the same body as plain, markdown or html is three different
    # letters. Only a non-plain format joins the anchor, so a plain letter's
    # anchor (with or without an explicit body_format="plain") stays unchanged.
    if ti.get("body_format") not in (None, "", "plain"):
        extra["body_format"] = str(ti["body_format"])
    if ti.get("reply_to_uid") not in (None, ""):
        # Structured, not ':'-joined: a ':' in the folder must not collide with a uid.
        extra["reply_to"] = [str(ti.get("reply_folder") or ""), str(ti["reply_to_uid"])]
        if not to:
            to = ["reply_to:" + json.dumps(extra["reply_to"], ensure_ascii=False)]
    return to, reason, extra


def collect_email_envelope(tool_name: str, tool_input: dict):
    """PR2 entry point: one dict for the recipient+content hash anchor (to/cc/bcc/text), built from the
    SAME collectors the copy gate runs (no second extraction implementation).
    Returns {"to", "cc", "bcc", "text", "unreadable_reason"}; text is the combined
    subject+body exactly as the copy gate audits it. On the Bash path the dict
    also carries "html_sha256" and "attachments" when the command names them
    (EMAILHTMLHORGONY929). The CALLER decides policy
    (e.g. an empty recipient list on a send is itself grounds to deny)."""
    html_sha256, attachments, harder = None, [], {}
    # A prefixed name (mcp__gmail__v2_reply_all) is extracted like the bare one.
    if classify_mail_tool(tool_name) in ("send_email", "connector_send"):
        ti = tool_input if isinstance(tool_input, dict) else {}
        if ms365_tool_kind(tool_name) == "send":
            # A Graph send, decided by NAME alone (MS365MAIL1024 round 2): a non-Graph
            # mail tool with an object `body` keeps its flat path below, and a Graph
            # send with no Graph shape (no body, a MIME string body, a non-list
            # top-level toRecipients, a lone top-level Subject) still lands here --
            # strictly read, so the anchor covers it or the caller denies, instead
            # of sliding to the flat path where its recipients were never seen.
            to, cc, bcc, text, reason = ms365_send_fields(ti, tool_name)
            return {"to": to, "cc": cc, "bcc": bcc, "text": text, "unreadable_reason": reason}
        text = collect_mcp_body(ti, tool_name)
        to, cc, bcc, reason = collect_mcp_recipients(ti)
        # A connector reply/forward addresses the ORIGINAL message: its
        # recipient is fixed by messageId, not by a `to` field, so the id is
        # the recipient anchor (GMAILCONNECTOR914). Same bytes-exact rule as
        # the addresses: an approval for one message cannot answer another.
        if not to and ti.get("messageId"):
            to = [f"messageId:{ti['messageId']}"]
        if is_harder_mail_tool(tool_name):
            to, reason, harder = _harder_send_envelope(ti, to, reason)
    elif tool_name == "Bash":
        cmd = str((tool_input or {}).get("command") or "") if isinstance(tool_input, dict) else ""
        text, reason = collect_bash_body(cmd)
        if not reason:
            to, cc, bcc, reason = collect_bash_recipients(cmd)
        else:
            to, cc, bcc = [], [], []
        if not reason:
            html_sha256, attachments, reason = collect_bash_attachments(cmd)
    else:
        return {"to": [], "cc": [], "bcc": [], "text": "",
                "unreadable_reason": f"nem email-kuldo tool ({tool_name!r})"}
    env = {"to": to, "cc": cc, "bcc": bcc, "text": text, "unreadable_reason": reason}
    if html_sha256:
        env["html_sha256"] = html_sha256
    if attachments:
        env["attachments"] = attachments
    env.update(harder)
    return env
