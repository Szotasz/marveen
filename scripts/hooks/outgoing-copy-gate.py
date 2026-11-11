#!/usr/bin/env python3
"""PreToolUse gate on the MAIN agent's outbound email: Hungarian copy QA.

Why this exists (Szabi, 2026-08-10 12:57): a licence-delivery email went out to a
client with every accent stripped ("Szia Balint, itt van a Marveen licenckulcsod
es a telepito"). It was the second accent incident that day -- the first was a
client-facing spreadsheet the same morning. Szabi asked for a gate that inspects
outgoing copy BEFORE the send and rejects it if something is wrong.

Note the seam this fills. `scripts/email-send-gate.mjs` already gates outbound
email, but it gates SUB-AGENTS (it is wired by writeAgentSettingsFromProfile()
guarded by `name !== MAIN_AGENT_ID`) and it is a hard deny, not a content check.
Nothing at all ran on the main agent's own sends -- and the main agent is the one
that actually writes to customers.

What it checks, all three from standing owner rules in CLAUDE.md:
  1. Hungarian text that is missing its accents (the incident above). Known limit (KAPUES1018): a text with fewer
     than 3 distinct HU markers can pass with an accentless 'es'; see the KNOWN LIMIT comment above
     AMBIGUOUS_TRIGGER.
  2. Em dash (U+2014) -- forbidden in every deliverable.
  3. Owner-specific NAME rules (misspelled surnames etc.) -- loaded from an
     untracked local rules file (GATEPERSIST816), never hardcoded here.

FAIL-CLOSED ON AN UNREADABLE BODY. If the call looks like a send but the body
cannot be recovered (e.g. `send.py ... < $SP/body.txt`, where $SP is a shell
variable this hook cannot resolve), the gate BLOCKS. A send whose content cannot
be inspected defeats the point of the gate, so "I could not read it" must not
mean "let it through". The block message says how to make it inspectable.

Contract: PreToolUse. Reads the hook payload on stdin, exit 0 = allow,
exit 2 = block (stderr goes back to the model).
"""
import html
import json
import os
import re
import sys

# --- what counts as an email send -------------------------------------------
# KAPUHATOKOR822 (2026-08-22, NEGY hamis pozitiv egy delutanon, HAROM
# muvelet-tipuson: inter-agent uzenet, sqlite-iras, fajl-OLVASAS): a korabbi
# szures a TELJES parancs-stringben kereste a kuldes-mintakat, igy egy
# inter-agent curl JSON-torzse ('"to":' a boritekban + 'send.py' a szoveg
# TARTALMABAN), egy hirlevel-szoveget iro sqlite-parancs vagy a send-script
# puszta elolvasasa is kuldesnek latszott. A kapu levelnek olvasta azt, ami
# uzenet A RENDSZERROL -- es pont arrol a temarol nemitotta volna el a
# flottat, amirol a legfontosabb beszelni (Iris tetje: egy valodi incidenst
# nem lehetne jelenteni rola).
#
# A szures ezert PARANCS-POZICIORA megy, nem tartalomra: elobb kivagjuk a
# heredoc-torzseket es az idezett stringeket (a tartalom igy nem tud parancs-
# nak latszani), majd pipeline/szekvencia-szegmensenkent a MEGHIVOTT programot
# nezzuk. Kuldes az, ahol a kuldo program fut:
#   - sendmail / msmtp / swaks a program-pozicioban (ezek csak kuldeni tudnak);
#   - send.py TENYLEGES futtatasa (python vagy kozvetlen ut) --to cimzettel a
#     SAJAT szegmenseben (a --help/olvasas igy nem trigger);
#   - graph-mail futtatasa `send` alparanccsal;
#   - curl/wget, amelynek IDEZETLEN URL-tokenje az api.resend.com-ra mutat
#     (a -d payloadban idezett elofordulas nem szamit -- az tartalom).
# MASODIK KOR (Marveen adverzarialis merese, msg 14282): az elso valtozat a
# quoted stringeket VAKON vagta ki, ezert ket hamis negativot nyitott -- az
# IDEZOJELES URL a curl sajat argumentum-helyen (a curl SZOKASOS irasmodja!)
# es a burkolo hejj `-c` string-argumentuma atment. A gyoker: az idezojel a
# TARTALOM ellen jo hatar, de nem mondja meg, hogy a token URL- vagy
# PROGRAM-POZICIOBAN all-e. Ezert a kivagas helyett QUOTE-TUDATOS tokenizalas
# fut (shlex): az idezett token EGY tokenkent, poziciojaval egyutt erkezik --
# a curl idezojeles URL-argumentuma igy vizsgalhato, mikozben egy -d payload
# belsejeben emlitett domain tovabbra is csak tartalom (az URL-minta a token
# ELEJERE horgonyzott). A wrapper hejj (`sh -c "..."`) string-argumentuma
# rekurzivan elemzodik.
# A heredoc-kivagas SORREND-FUGGETLEN (Marveen 3. kore, msg 14286): a
# hatarolo utani SOR-MARADEK (pl. atiranyitas: <<EOF > fajl) a parancs
# resze es MEGMARAD -- csak a torzs esik ki. Enelkul (a) forditott
# sorrendnel a torzs parancsnak latszott (FP), (b) a bevezeto sor
# eldobasa a heredoc-taplalt VALODI kuldot vesztette volna el (FN).
_HEREDOC = re.compile(r"(<<-?\s*'?(\w+)'?[^\n]*)\n.*?\n\2(?=\s|$)", re.S)
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*=")
# KWSPLIT924: shell reserved words that put the NEXT word in command position.
# The segmenter splits on operators only, so `if true; then sendmail x; fi`
# gave the segment [then, sendmail, x] whose "program" was `then`: the send was
# not recognised and the copy audit was silently skipped (same for do / else /
# elif / { / !, and the condition after if / while / until). They are stripped
# ONLY at the head of a segment, i.e. in command position, never as separators:
# `echo then sendmail x` stays a single echo. `in` is deliberately NOT here: the
# words after it are data, and `for m in sendmail msmtp; do which $m; done` must
# stay false. `for` / `case` are not here either: the word after them is a name
# or a subject, not a command. Mirrored in email-send-gate.mjs (CMD_POSITION_KEYWORDS);
# the shared send-invocation-cases.json binds the two.
_CMD_POSITION_KEYWORDS = frozenset(("if", "then", "else", "elif", "do", "while", "until", "{", "!"))
_SENDER_PROG = re.compile(r"^(sendmail|msmtp|swaks)$", re.I)
# MAILGATEAPIB1027 (Samu 50983): mail / mailx / s-nail send when given an address, a subject, a cc/bcc/from/attach
# option or any operand (a recipient); with none of these (`mail`, `mail -f mbox`, `mail -u user`) they read mail.
_MAIL_PROG = re.compile(r"^(mail|mailx|s-nail)$", re.I)
_MAIL_SEND_OPT = re.compile(r"^-[A-Za-z]*[sbcrtaAq]")
_CURL_SMTP = re.compile(r"^(?:smtps?://|--mail-(?:rcpt|from)(?:=|$))", re.I)


def _mail_prog_sends(rest) -> bool:
    skip = False
    for t in rest:
        if skip:
            skip = False
            continue
        if "@" in t:
            return True
        if t in ("-f", "-u"):
            skip = True
            continue
        if t.startswith("-"):
            if _MAIL_SEND_OPT.match(t):
                return True
            continue
        return True
    return False
_SENDPY = re.compile(r"^send\.py$", re.I)
# SUBAGENTMAILGATE1016: a version-suffixed interpreter (python3.12, python3.13t) is the same python.
_PYTHON = re.compile(r"^python(3(\.\d+t?)?)?$", re.I)
# A ket kapu (ez + scripts/email-send-gate.mjs) SZANDEKOSAN azonos
# felismeres-szemantikat visel, es ezt kozos eset-lista orzi
# (send-invocation-cases.json + konformancia-teszt): a divergencia
# teszt-hibakent jelenjen meg, ne incidenskent (Marveen, msg 14289).
_NODEISH = re.compile(r"^(node|tsx|ts-node|deno|bun|npx)$", re.I)
_GRAPHMAIL = re.compile(r"^graph-mail(\.ts|\.js)?$", re.I)
_WRAPPER_SHELL = re.compile(r"^(sh|bash|zsh|dash)$", re.I)
_CURLISH = re.compile(r"^(curl|wget|http)$", re.I)
# Interpreter kod-string argumentum (python -c / node -e): az interpreternek
# atadott kod MUVELET, nem tartalom -- a kod-szintu kuldes-hivasokra szurunk.
#
# KIMONDOTT HATAR (Marveen, msg 14298): tetszoleges interpreter-kod statikus
# elemzese eldonthetetlen -- ez a kapu a VELETLEN kuldest fogja meg, nem egy
# elszant kikerulot. A lenti exec-heurisztika a NAIV alakokat fedi (a kod
# process-inditast ES kuldo-programnevet egyutt tartalmaz); ennel tobbet nem
# allit, es nem is allithat.
_CODE_SEND = re.compile(
    r"\bsmtplib\b|SMTP\s*\(|\bsendMail\s*\(|\bsendEmail\b|\bmail\.send\b", re.I
)
# Issue #1853 (stylnet): the support-mail sender LOADED AS A MODULE, not run by its
# file name -- `import send`, `from send import main`, runpy, __import__/import_module,
# or a spec built from send.py. The file-name rule below never saw these, so the call
# went past the approval gate. Case-sensitive on purpose (Python names are), and
# `send` must be the whole module name: `import sendgrid_x` or a "send" word in a
# string stays out. Mirrored in email-send-gate.mjs (CODE_SEND_MODULE).
_CODE_SEND_MODULE = re.compile(
    r"\bimport\s+(?:[\w.]+\s*,\s*)*send\b(?![\w.])"
    r"|\bfrom\s+send\s+import\b"
    r"|\brunpy\b[^\n]*\bsend\b"
    r"|\b(?:__import__|import_module)\s*\(\s*['\"]send['\"]"
    r"|\bspec_from_file_location\b[^\n]*\bsend\.py\b"
    # The same class on the Graph sender (src/graph-mail.ts, export sendMail): renamed on
    # import, or reached by a string key -- the call itself then never reads `sendMail(`.
    r"|\bsendMail\s+as\b|\[\s*['\"]sendMail['\"]\s*\]"
)
_CODE_EXECISH = re.compile(
    r"\bsubprocess\b|os\.system|\bpopen\b|child_process|\bexec[A-Za-z]*\s*\(|\bspawn[A-Za-z]*\s*\(",
    re.I,
)
_CODE_SENDER_LIT = re.compile(r"sendmail|msmtp|swaks|send\.py", re.I)


# MAILGATESCRIPT1027: a Microsoft Graph send endpoint (sendMail, or send/reply/replyAll/forward of a message)
# MAILGATESCRIPT1027 R2: no ASCII word character, '-' or non-ASCII letter may follow the action word (the same rule in
# both twins), so send-preview, or reply followed by an accented letter, is no action; any punctuation ends it.
# MAILGATESCRIPT1027 R1: a send needs the endpoint shape AND Graph evidence in the same text (an application
# route of the same shape is no send); `\/` is normalised to `/` first (JSON-escaped URLs).
_GRAPH_SEND = re.compile(
    r"/(?:me|users/[^\n]{1,120}?)/(?:sendMail(?![A-Za-z0-9_-]|[^\x00-\x7f])|messages/[^\n]{1,160}?/(?:send|reply|replyAll|forward)(?![A-Za-z0-9_-]|[^\x00-\x7f]))",
    re.I,
)
_GRAPH_EVIDENCE = re.compile(r"graph\.microsoft\.com|microsoft-graph-client|msgraph|\.api\s*\(", re.I)


def _graph_sends(text: str) -> bool:
    t = text.replace("\\/", "/")
    return bool(_GRAPH_SEND.search(t) and _GRAPH_EVIDENCE.search(t))


# MAILGATEHTTPAPI1027: an HTTP mail API reached from a script (Marveen 50920: a Gmail REST send from
# urllib went past the approval gate, because only SMTP, nodemailer and Graph were known). Each provider
# needs its own evidence AND a send shape in the same text, so a Gmail read (messages list, profile) or a
# text that only names the provider is no send. The evidence is a literal API host or a client call or
# package name, never the bare provider word: after the `\/` normalisation a gate's own regex source and
# comments carry the shapes, and a gate file must not count as a sender. Mirrored in email-send-gate.mjs
# (MAIL_API_RULES); scripts/hooks/mail-api-send-cases.json binds the two twins.
_ACTION_END = r"(?![A-Za-z0-9_-]|[^\x00-\x7f])"
_MAIL_API_RULES = (
    # Gmail: the REST host (also when the URL is assembled from a base) or the Python or Node gmail client;
    # the send shapes are the messages or drafts send call.
    (re.compile(r"gmail\.googleapis\.com|[/]gmail[/]v1[/]|\bbuild\s*\(\s*['\"]gmail['\"]|\bgoogle\.gmail\s*\(|['\"]@googleapis/gmail['\"]", re.I),
     re.compile(r"/(?:messages|drafts)/send" + _ACTION_END + r"|\.(?:messages|drafts)\s*(?:\(\s*\))?\s*\.send\s*\(", re.I)),
    # Resend: the emails endpoint on the API host (and its batch), or the SDK's emails.send( on a client
    # of any name (Samu 50950 A1: `const client = new Resend(k)`), the package being the evidence.
    (re.compile(r"api\.resend\.com|['\"]resend['\"]|\bimport\s+resend\b", re.I),
     re.compile(r"api\.resend\.com/emails(?:/batch)?" + _ACTION_END + r"|\.emails\.send\s*\(", re.I)),
    # SendGrid: v3 mail send on the API host, or the mail client.
    (re.compile(r"api\.sendgrid\.com|['\"]@sendgrid/mail['\"]|\bSendGridAPIClient\s*\(", re.I),
     re.compile(r"api\.sendgrid\.com/v3/mail/send" + _ACTION_END + r"|['\"]@sendgrid/mail['\"]|\bSendGridAPIClient\s*\(", re.I)),
    # Mailgun: the API host with a v3 domain messages path (an assembled URL too), or the client's
    # messages.create( next to the package name. A bare "/messages" is no evidence: the dashboard's own
    # /api/messages is one.
    (re.compile(r"mailgun\.net|['\"]mailgun(?:\.js)?['\"]", re.I),
     re.compile(r"/v3/[^\n]{1,200}?/messages(?:\.mime)?" + _ACTION_END + r"|\.messages\.create\s*\(", re.I)),
    # Postmark: the email endpoints on the API host (single, batch, with a template), or the SDKs (MAILGATEAPIB1027,
    # Samu 50950 B1): the node client's sendEmail family, python postmarker's emails.send family.
    (re.compile(r"api\.postmarkapp\.com|['\"]postmark['\"]|\bpostmarker\b", re.I),
     re.compile(r"api\.postmarkapp\.com/email(?:/batch|/withTemplate)?" + _ACTION_END
                + r"|\.sendEmail(?:Batch|WithTemplate|BatchWithTemplates)?\s*\(|\.emails\.send(?:_batch|_with_template)?\s*\(", re.I)),
)

def _mail_api_sends(text: str) -> bool:
    t = text.replace("\\/", "/")
    return any(ev.search(t) and send.search(t) for ev, send in _MAIL_API_RULES)


def _web_mail_sends(text: str) -> bool:
    """A Microsoft Graph send or an HTTP mail API send in a code string or a script file."""
    return _graph_sends(text) or _mail_api_sends(text)


# MAILGATEHEREDOCFP1027: a send marker that only sits in DATA is no send. A heredoc or a -c string that writes an
# inter-agent message or a probe file carries the sender's words in a string literal ("the gate knows smtplib",
# "client.emails.send(...)"), and the rules, read on the raw text, refused it every day. The interpreter's code is
# read with its prose blanked: a string literal whose text holds whitespace (a sentence, a JSON body, a docstring)
# and every comment become spaces, the length and the line breaks kept. A literal without whitespace stays as it is,
# because that is how a real send carries its evidence: a URL, a package name, a 'sendmail' argv item, 'send'. The
# interpolations of an f-string or a template literal are code and stay. An unterminated literal is left raw, so a
# cut text is judged as before. Not a parser: a JS regex literal holding a quote can shift the scan (stated limit).
# Mirrored in email-send-gate.mjs (maskProseLiterals); scripts/hooks/prose-literal-cases.json binds the two.
_PY_STR_PREFIX = re.compile(r"(?i)(?:rb|br|fr|rf|r|b|u|f)$")


def _mask_prose_literals(text: str, lang) -> str:
    if lang not in ("py", "js"):
        return text
    out = []
    i, n = 0, len(text)

    def blank(s):
        return "".join(c if c == "\n" else " " for c in s)

    while i < n:
        c = text[i]
        if lang == "py" and c == "#":
            j = text.find("\n", i)
            j = n if j == -1 else j
            out.append(blank(text[i:j]))
            i = j
            continue
        if lang == "js" and text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j == -1 else j
            out.append(blank(text[i:j]))
            i = j
            continue
        if lang == "js" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j == -1:
                out.append(text[i:])
                break
            out.append(blank(text[i:j + 2]))
            i = j + 2
            continue
        if c in "'\"" or (lang == "js" and c == "`"):
            prefix = ""
            if lang == "py":
                k = i
                while k > 0 and text[k - 1].isalpha() and i - k < 2:
                    k -= 1
                if k < i and _PY_STR_PREFIX.match(text[k:i]) and (k == 0 or not (text[k - 1].isalnum() or text[k - 1] == "_")):
                    prefix = text[k:i].lower()
            triple = lang == "py" and text.startswith(c * 3, i)
            quote = c * 3 if triple else c
            interp = (lang == "js" and c == "`") or "f" in prefix
            multiline = triple or (lang == "js" and c == "`")
            j = i + len(quote)
            parts = []  # (is_code, text) between the quotes
            buf = []
            closed = False
            while j < n:
                ch = text[j]
                if ch == "\\" and j + 1 < n:
                    buf.append(text[j:j + 2])
                    j += 2
                    continue
                if text.startswith(quote, j):
                    closed = True
                    break
                if ch == "\n" and not multiline:
                    break
                if interp and ((lang == "js" and text.startswith("${", j)) or (lang == "py" and ch == "{" and not text.startswith("{{", j))):
                    start = j + (2 if lang == "js" else 1)
                    depth, k = 1, start
                    while k < n and depth:
                        if text[k] == "{":
                            depth += 1
                        elif text[k] == "}":
                            depth -= 1
                        k += 1
                    if depth:
                        break
                    parts.append((False, "".join(buf)))
                    buf = []
                    parts.append((True, text[j:k]))
                    j = k
                    continue
                if interp and lang == "py" and text.startswith("{{", j):
                    buf.append("{{")
                    j += 2
                    continue
                buf.append(ch)
                j += 1
            if not closed:
                # Raw up to where the scan stopped: its text is not read again as code (a `//` in it is no comment).
                out.append(text[i:j])
                i = j
                continue
            parts.append((False, "".join(buf)))
            # ASCII whitespace only, the same set in both twins (str.isspace and JS \s differ outside ASCII).
            prose = any(any(ch in " \t\n\r\f\v" for ch in s) for code, s in parts if not code)
            out.append(quote)
            for code, s in parts:
                out.append(s if code or not prose else blank(s))
            out.append(quote)
            i = j + len(quote)
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _code_string_sends(code: str, lang=None) -> bool:
    masked = _mask_prose_literals(code, lang)
    if _CODE_SEND.search(masked) or _CODE_SEND_MODULE.search(masked) or _web_mail_sends(masked):
        return True
    return bool(_CODE_EXECISH.search(masked) and _CODE_SENDER_LIT.search(code))
# Token-ELEJERE horgonyzott cel-minta: egy URL-argumentum vagy csupasz
# domain/utvonal illik ra; egy JSON-payload ('{...api.resend.com...}') nem.
_RESEND_TARGET = re.compile(r"^(https?://)?([^/@\s]*\.)?api\.resend\.com(/|$|\s|$)", re.I)

# RESENDGATE826: a resend-celu curl/wget csak akkor KULDES, ha a METODUS az.
# A korabbi minta metodus-vak volt, es egy read-only GET /domains (nincs torzs,
# nincs cimzett) ugyanugy fail-closed elutasitast kapott -- pont egy domain-
# verifikacios MERES akadt el rajta. A szukites iranya szigoru: a metodust
# FELISMERNI kell (explicit -X/--request/--method, vagy implicit POST a
# torzs-flagekbol); ha nem allapithato meg (valtozo, config-fajl, csonka flag),
# marad a fail-closed. Egy "nincs felismerheto torzs -> atmegy" szabaly a
# kaput utne ki, ezert ILYEN AG NINCS.
_CURL_BODY_OPTS = {
    "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
    "--data-ascii", "-F", "--form", "--form-string", "--json",
    "-T", "--upload-file",
    # wget torzs-flagek
    "--post-data", "--post-file", "--body-data", "--body-file",
}
_SAFE_METHODS = {"GET", "HEAD"}


# RESENDGETTWIN1010: a httpie (`http`) metodusa POZICIONALIS (http POST URL),
# a torzse `kulcs=ertek` / `kulcs:=json` elem -- egyiket sem ismeri az alabbi
# curl/wget flag-olvaso, ezert a `http POST .../emails to=...` "read" lett, es a
# kapu atengedte. A httpie-re a metodus itt nem dontheto: fail-closed.
_HTTPIE = re.compile(r"^http$", re.I)


def _curl_resend_verdict(prog, rest):
    """'read' | 'send' | 'unknown' -- unknown a hivo oldalon fail-closed."""
    if _HTTPIE.match(prog):
        return "unknown"
    method = None
    has_body = False
    get_forced = False
    i, n = 0, len(rest)
    while i < n:
        t = rest[i]
        if t in ("-X", "--request", "--method"):
            if i + 1 >= n or not rest[i + 1].isalpha():
                return "unknown"  # csonka vagy valtozo ($METHOD) -- nem dontheto
            method = rest[i + 1].upper()
            i += 2
            continue
        if t.startswith("--request=") or t.startswith("--method="):
            m = t.split("=", 1)[1]
            if not m.isalpha():
                return "unknown"
            method = m.upper()
            i += 1
            continue
        if t in ("-G", "--get"):
            get_forced = True
            i += 1
            continue
        if t in ("-K", "--config"):
            return "unknown"  # a config-fajl rejtett metodust/torzset hordozhat
        if t in _CURL_BODY_OPTS or any(
            t.startswith(o + "=") for o in _CURL_BODY_OPTS if o.startswith("--")
        ):
            has_body = True
            i += 1
            continue
        if t.startswith("-") and not t.startswith("--") and len(t) > 1:
            # egy-kotojeles cluster (-sS, -sX POST, -sd '{}'): a betuk kotegelve
            letters = t[1:]
            if "X" in letters:
                after = letters.split("X", 1)[1]
                if after:
                    if not after.isalpha():
                        return "unknown"
                    method = after.upper()
                else:
                    if i + 1 >= n or not rest[i + 1].isalpha():
                        return "unknown"
                    method = rest[i + 1].upper()
                    i += 1
            elif "d" in letters or "F" in letters or "T" in letters:
                has_body = True
            elif "G" in letters:
                get_forced = True
            elif "K" in letters:
                return "unknown"
            i += 1
            continue
        i += 1
    if method is not None and method not in _SAFE_METHODS:
        return "send"
    if has_body and not get_forced:
        # implicit POST (curl -d/-F/--json/-T alapertelmezese), vagy egy
        # gyanus "GET torzzsel" alak -- mindketto kuldeskent kezelve
        return "send"
    return "read"
# A tovabbi kuldes-jellegu literalok, amikre a parse-hiba eseten (es CSAK
# akkor) konzervativan visszaesunk -- lasd is_send_invocation vegen.
_FALLBACK_LITERALS = re.compile(
    r"send\.py|api\.resend\.com|\bsendmail\b|\bmsmtp\b|\bswaks\b"
    r"|\bsmtplib\b|\bsendMail\s*\(", re.I
)


def _basename(tok: str) -> str:
    return tok.rsplit("/", 1)[-1]


def _mask_subshell_markers(cmd: str) -> str:
    """Idezojelen KIVULI ujsor/`$(`/backtick -> `;` szeparator, hogy a shlex
    szegmens-hatarkent lassa; idezojelen BELUL a szoveg erintetlen (tartalom).

    MAINGATENLCOMMENT1104: a shell comment is dropped HERE, as bash does: an unquoted `#` at the start of a word, up
    to the newline (the newline itself still becomes `;`). shlex's own comment handling is off (_segments_tokens):
    after this mask there is no newline left, so a shlex comment ran to the end of the command and swallowed the next
    line's send; an apostrophe inside a comment flipped this mask into quote mode; and shlex starts a comment at a `#`
    inside a word (`echo a#b; sendmail x` lost the send). The word-start set matches the JS twin's
    stripShellComments (whitespace and ;&|())."""
    out = []
    q = None  # None | "'" | '"'
    i, n = 0, len(cmd)
    parens = []  # Bence 69701: "s" for an open $( , "p" for a plain ( -- which ) closes a command substitution
    subst_close_at = -1
    while i < n:
        ch = cmd[i]
        if q:
            if ch == "\\" and q == '"' and i + 1 < n:
                out.append(cmd[i:i + 2]); i += 2; continue
            if ch == q:
                q = None
            out.append(ch); i += 1; continue
        if ch in "'\"":
            q = ch; out.append(ch); i += 1; continue
        if ch == "\\" and i + 1 < n:
            out.append(cmd[i:i + 2]); i += 2; continue
        # a ) that closes a $( ends no word: `$(echo a)#x` is one word (Bence 69701)
        if ch == "#" and (i == 0 or cmd[i - 1] in " \t\n;&|(" or (cmd[i - 1] == ")" and subst_close_at != i - 1)):
            while i < n and cmd[i] != "\n":
                i += 1
            continue
        if ch == "\n" or ch == "`":
            out.append(";"); i += 1; continue
        if ch == "$" and i + 1 < n and cmd[i + 1] == "(":
            parens.append("s")
            out.append(";"); i += 2; continue
        if ch == "(":
            parens.append("p")
        elif ch == ")" and parens and parens.pop() == "s":
            subst_close_at = i
        out.append(ch); i += 1
    return "".join(out)


def _segments_tokens(cmd: str):
    """[[token, ...], ...] szegmensenkent -- quote-tudatosan, poziciot orizve."""
    import shlex
    lex = shlex.shlex(_mask_subshell_markers(_HEREDOC.sub(r"\1", cmd)),
                      posix=True, punctuation_chars="();|&")
    lex.whitespace_split = True
    lex.commenters = ""  # MAINGATENLCOMMENT1104: the mask drops comments as bash does; shlex's would not
    segments, cur = [], []
    for tok in lex:
        # SEGSPLIT923: shlex(punctuation_chars) returns a RUN of operator
        # characters as ONE token, so `$(date); sendmail ...` (after the
        # subshell mask: `;date); sendmail`) yielded the token ");" -- not in
        # the list, so it did not split, `sendmail` landed mid-segment, and the
        # send was NOT recognised: the copy audit was silently skipped. The JS
        # twin (email-send-gate.mjs) said true on the same input; nothing in
        # the conformance list covered it. A token made ONLY of operator
        # characters is always an operator sequence, so it separates.
        if tok in ("|", "||", "&", "&&", ";", "(", ")", ";;", "|&") or (tok and set(tok) <= set("();|&")):
            if cur:
                segments.append(cur)
            cur = []
        else:
            cur.append(tok)
    if cur:
        segments.append(cur)
    return segments


# SENDWRAP924: a wrapper in front of the sender -- `sudo sendmail x`,
# `time -p sendmail x`, `env -i sendmail x`, `timeout 10 sendmail x` -- made
# the wrapper the "program", so the send was not recognised and the copy audit
# was silently skipped (13 measured shapes, both copies). A wrapper is stepped
# over WITH its own flags: a flag that takes a value consumes it, so in
# `sudo -u sendmail true` the program is `true`, not `sendmail`.
# name -> (short flags taking a value, long flags taking a value, positional
# arguments before the command). An UNKNOWN long flag without `=` may or may
# not take a value, so both readings are tried and either one being a send
# counts: an unknown flag errs toward auditing, never toward skipping.
# `command -v/-V` looks a name up and runs nothing. `function NAME` and
# `coproc [NAME]` put their body in command position. Mirrored in
# email-send-gate.mjs (WRAPPERS / commandHeads); send-invocation-cases.json
# binds the two.
_WRAPPERS = {
    "time": ("fo", ("format", "output"), 0),
    "sudo": ("ughpCUrtDRT", ("user", "group", "host", "prompt", "close-from", "other-user",
                             "role", "type", "chdir", "chroot", "command-timeout"), 0),
    # ENVOPTHEAD1104: env is read by _env_heads (a structural parser); the entry keeps env a wrapper for the depth bound
    "env": ("uCSPaLU", ("unset", "chdir", "split-string", "argv0"), 0),
    "nohup": ("", (), 0),
    "nice": ("n", ("adjustment",), 0),
    "exec": ("a", (), 0),
    "command": ("", (), 0),
    "xargs": ("ILnPsdEa", ("arg-file", "delimiter", "eof", "replace", "max-lines", "max-args",
                           "max-procs", "max-chars", "process-slot-var"), 0),
    "timeout": ("sk", ("signal", "kill-after"), 1),
    # setsid: for future use and symmetry. NOT measured local traffic: the hits the
    # first count found all sat inside quoted remote (ssh) command strings or heredoc
    # bodies, and that pattern was not quote-aware (Marveen's correction, 2026-09-24).
    "setsid": ("", (), 0),
    # ENVOPTHEAD1104 (Bence 69481): launchers whose value options were read as the program, so the command behind
    # them was never judged (measured on develop: all four were no send in front of a real sender).
    "stdbuf": ("ioe", ("input", "output", "error"), 0),
    "ionice": ("cnpPu", ("class", "classdata", "pid", "pgid", "uid"), 0),
    "chrt": ("TPD", ("sched-runtime", "sched-period", "sched-deadline"), 1),  # then the priority, then the command
    "caffeinate": ("tw", (), 0),
}
# JSCDSEND1104 (Bence 69588, Samu 69591): the homebrew coreutils install the GNU launchers with a g prefix (genv,
# gtimeout, gnohup, gnice, gstdbuf); each reads as its pair. (chroot is no wrapper here, so gchroot has no pair.)
_G_PREFIXED = ("env", "timeout", "nohup", "nice", "stdbuf")
for _n in _G_PREFIXED:
    _WRAPPERS["g" + _n] = _WRAPPERS[_n]
_HEAD_DEPTH = 8

# MAILGATEUV1020: a project launcher's `run` subcommand in front of the sender --
# `uv run python .../send.py --to x`, `uv run send.py --to x`, `uv run -m send
# --to x`, `pipx run send.py --to x`, `poetry run python send.py --to x` -- made
# the launcher the "program", so the send was not recognised by either copy
# (measured on develop a6325a49: 26 launcher shapes, all passed; found by the
# #2081 negative control). The launcher is stepped over like a wrapper, past its
# subcommand and its own options, and the word after them is judged as the
# command: `uv run` and `pipx run` take a script path directly, so `send.py`
# there is the program. `uv run -m X` is `python3 -m X`.
# name -> (subcommand, short flags taking a value, long flags taking a value,
# module flags, flag lists measured as complete). uv and pipx: the value flags
# are read from `uv run --help` (uv 0.10.2) and `pipx run --help` (pipx 1.11.1)
# on the dev host. The others were not installed there, so their flags are not
# listed, and every word of their option run that could be the program is
# judged as one (a word after an option may be its value or the command): an
# unknown option errs toward auditing, as with _WRAPPERS.
# Not covered: `uvx` / `uv tool run` (they run an installed package's entry
# point, not a script path), and a module flag inside a short cluster (`-qm`).
# Mirrored in email-send-gate.mjs (LAUNCHERS / launcherHeads);
# send-invocation-cases.json binds the two.
_UV_RUN_LONG_VAL = (
    "extra", "no-extra", "group", "no-group", "only-group", "env-file", "with",
    "with-editable", "with-requirements", "package", "python-platform", "index", "default-index",
    "index-url", "extra-index-url", "find-links", "index-strategy", "keyring-provider",
    "upgrade-package", "resolution", "prerelease", "fork-strategy", "exclude-newer",
    "exclude-newer-package", "no-sources-package", "reinstall-package", "link-mode",
    "config-setting", "config-settings-package", "no-build-isolation-package", "no-build-package",
    "no-binary-package", "cache-dir", "refresh-package", "python", "color", "allow-insecure-host",
    "directory", "project", "config-file",
)
_LAUNCHERS = {
    "uv": ("run", "wifPCp", _UV_RUN_LONG_VAL, ("-m", "--module"), True),
    "pipx": ("run", "", ("index-url", "pip-args", "python", "spec", "with"), (), True),
    **{n: ("run", "", (), (), False)
       for n in ("poetry", "pdm", "hatch", "pipenv", "rye", "conda", "mamba", "micromamba")},
}


def _launcher_heads(toks, spec, _d: int):
    sub, short_val, long_val, module_flags, complete = spec
    # The subcommand may follow the launcher's global options (`uv --directory d run`):
    # every word before it is an option or the value right after one.
    j = -1
    for x in range(1, len(toks)):
        if toks[x] == sub:
            j = x
            break
        if not toks[x].startswith("-") and not (x > 1 and toks[x - 1].startswith("-")):
            break
    if j < 0:
        return [toks]
    heads = []
    if not complete:
        # An unmeasured launcher's options are unknown, so every word in its option
        # run that could be the program is judged as the program: the word after an
        # option may be that option's value, or the command (Dani's #2086 review:
        # `conda run --no-capture-output -n base python send.py` mixes a flag and a
        # value option, which no single reading of all options fits).
        for x in range(j + 1, len(toks)):
            if toks[x] == "--":
                heads.append(toks[x + 1:])
                break
            if toks[x].startswith("-") and len(toks[x]) > 1:
                continue
            heads.append(toks[x:])
            if not (x > j + 1 and toks[x - 1].startswith("-") and len(toks[x - 1]) > 1):
                break
        if not heads:
            heads.append([])
    else:
        i, head = j + 1, None
        while i < len(toks):
            t = toks[i]
            if t == "--":
                i += 1
                break
            if t in module_flags:
                head = ["python3", "-m"] + toks[i + 1:]
                break
            if t.startswith("--"):
                eq = t.find("=")
                if eq > 0 and t[:eq] in module_flags:
                    head = ["python3", "-m", t[eq + 1:]] + toks[i + 1:]
                    break
                i += 2 if eq < 0 and t[2:] in long_val else 1
                continue
            if t.startswith("-") and len(t) > 1:
                k = next((x for x, ch in enumerate(t[1:], 1) if ch in short_val), -1)
                i += 2 if k == len(t) - 1 else 1
                continue
            break
        heads.append(head if head is not None else toks[i:])
    out = []
    for h in heads:
        out += _command_heads(h, _d + 1)
    return out


def _command_heads(toks, _d: int = 0):
    """Every token list that can be the real command of this segment, after the
    leading assignments, command-position keywords and wrappers are stepped over."""
    while toks and (_ENV_ASSIGN.match(toks[0]) or toks[0] in _CMD_POSITION_KEYWORDS):
        toks = toks[1:]
    if not toks:
        return [toks]
    w = _basename(toks[0])
    if _d >= _HEAD_DEPTH:
        # Still a wrapper at the depth bound: the real command is out of sight,
        # so it counts as a send (None) -- the bound errs toward auditing, like
        # an unknown flag does. It used to return the wrapper itself, and nine
        # nested wrappers + sendmail was silently skipped (Samu, #1521 review).
        return [None] if (w in _WRAPPERS or w in _LAUNCHERS or w in ("function", "coproc")) else [toks]
    if w == "function":
        return _command_heads(toks[2:], _d + 1)
    if w == "coproc":
        return _command_heads(toks[1:], _d + 1) + _command_heads(toks[2:], _d + 1)
    if w in ("env", "genv"):
        return _env_heads(toks, _d)
    launcher = _LAUNCHERS.get(w)
    if launcher is not None:
        return _launcher_heads(toks, launcher, _d)
    spec = _WRAPPERS.get(w)
    if spec is None:
        return [toks]
    short_val, long_val, positionals = spec
    i, starts = 1, []
    while i < len(toks):
        t = toks[i]
        if t == "--":
            i += 1
            break
        if t.startswith("--"):
            if "=" not in t and t[2:] in long_val:
                i += 2
                continue
            if "=" not in t:
                starts.append(i + 2)
            i += 1
            continue
        if t.startswith("-") and len(t) > 1:
            if w == "command" and ("v" in t or "V" in t):
                return []
            k = next((j for j, ch in enumerate(t[1:], 1) if ch in short_val), -1)
            i += 2 if k == len(t) - 1 else 1
            continue
        break
    starts.insert(0, i)
    heads = []
    for s in starts:
        heads += _command_heads(toks[s + positionals:], _d + 1)
    return heads


# Bence 69517: GNU env reads a long option by any unique prefix (getopt_long): `--c=DIR` is --chdir, `--spl=` is
# --split-string. Its long options, as of coreutils 9.x.
_ENV_LONG_OPTIONS = ("argv0", "block-signal", "chdir", "debug", "default-signal", "ignore-environment", "ignore-signal",
                     "list-signal-handling", "null", "split-string", "unset", "help", "version")


def _env_long_name(t):
    """The env long option a `--word[=value]` names, by exact name or unique prefix; else None."""
    if not t.startswith("--") or t == "--":
        return None
    word = t[2:].split("=", 1)[0]
    if word in _ENV_LONG_OPTIONS:
        return word
    hits = [o for o in _ENV_LONG_OPTIONS if word and o.startswith(word)]
    return hits[0] if len(hits) == 1 else None


def _env_split_value(t, words, j):
    """(value, index after it) when the env word `t` at `j` is -S / --split-string (also a prefix or a cluster)."""
    if t.startswith("--"):
        if _env_long_name(t) != "split-string":
            return None
        if "=" in t:
            return t.split("=", 1)[1], j + 1
        return (words[j + 1] if j + 1 < len(words) else ""), j + 2
    if t.startswith("-"):
        k = next((x for x, ch in enumerate(t[1:], 1) if ch in _ENV_SHORT_VALUE), -1)
        if k > 0 and t[k] == "S":
            if k < len(t) - 1:
                return t[k + 1:], j + 1
            return (words[j + 1] if j + 1 < len(words) else ""), j + 2
    return None


# JSCDSEND1104: sudo -D/--chdir DIR runs the command in DIR, like env -C (Bence 69517; sudo needs runcwd in sudoers
# to allow it, so it is rare, but the class is the same). sudo's long options, read by unique prefix as getopt_long.
_SUDO_LONG_OPTIONS = ("askpass", "auth-type", "background", "bell", "chdir", "chroot", "close-from", "command-timeout",
                      "edit", "group", "help", "host", "list", "login", "non-interactive", "other-user",
                      "preserve-env", "preserve-groups", "prompt", "remove-timestamp", "reset-timestamp", "role",
                      "set-home", "shell", "type", "user", "validate", "version")
_SUDO_LONG_VALUES = ("auth-type", "chdir", "chroot", "close-from", "command-timeout", "group", "host", "other-user",
                     "prompt", "role", "type", "user")


def _long_name(t, names):
    if not t.startswith("--") or t == "--":
        return None
    word = t[2:].split("=", 1)[0]
    if word in names:
        return word
    hits = [o for o in names if word and o.startswith(word)]
    return hits[0] if len(hits) == 1 else None


# program -> (short options that take a value, the short chdir letter, long option names, long ones with a value).
# env's entry is added below _ENV_SHORT_VALUE / _ENV_LONG_VALUE, so both readers share one list.
_CHDIR_SPECS = {
    "sudo": ("ughpCUrtDRT", "D", _SUDO_LONG_OPTIONS, _SUDO_LONG_VALUES),
}


def _env_chdir_dirs(words, _d=0):
    """ENVOPTHEAD1104 (Bence 69475) / JSCDSEND1104: the directories `env -C DIR` (`--chdir DIR`, `--chdir=DIR`,
    `-CDIR`, a cluster, a unique prefix, and inside an -S value, Bence 69552) and `sudo -D DIR` (the same forms) run
    their command in. A relative script there is resolved under DIR, not the cwd: they are handed to the cd logic as
    `cd DIR` words, which also makes an undecidable DIR a send."""
    out = []
    for i, w in enumerate(words):
        spec = _CHDIR_SPECS.get(_basename(w))
        if spec is None:
            continue
        short_val, chdir_ch, long_names, long_vals = spec
        j = i + 1
        while j < len(words):
            t = words[j]
            if t == "--" or not (t.startswith("-") or _ENV_ASSIGN.match(t)):
                break
            if _basename(w) in ("env", "genv"):
                split = _env_split_value(t, words, j)
                if split is not None:
                    # Bence 69552: env parses the options at the start of the -S value (and the words after it) again
                    value, after = split
                    try:
                        split_words = [x for seg in _segments_tokens(value) for x in seg]
                    except ValueError:
                        split_words = []  # an unsplittable value is already a send by _env_split_heads
                    if _d < _HEAD_DEPTH:
                        out += _env_chdir_dirs(["env"] + split_words + list(words[after:]), _d + 1)
                    break
            long = _long_name(t, long_names) if t.startswith("--") else None
            if t == "-" + chdir_ch or (long == "chdir" and "=" not in t):
                if j + 1 < len(words):
                    out.append(words[j + 1])
                j += 2
                continue
            if long == "chdir":
                out.append(t.split("=", 1)[1])
            elif long in long_vals and "=" not in t:
                j += 1  # its value
            elif t.startswith("-") and not t.startswith("--"):
                k = next((x for x, ch in enumerate(t[1:], 1) if ch in short_val), -1)
                if k > 0 and t[k] == chdir_ch:
                    if k < len(t) - 1:
                        out.append(t[k + 1:])
                    elif j + 1 < len(words):
                        out.append(words[j + 1])
                        j += 1
                elif k == len(t) - 1:
                    j += 1  # the value of another value option
            j += 1
    return out


def _with_env_chdir(cmd_words):
    words = list(cmd_words)
    for d in _env_chdir_dirs(cmd_words):
        words += ["cd", d]
    return words


# Samu 69521: env's options are read STRUCTURALLY, not by a list of the dangerous ones. The GNU coreutils and the
# BSD/macOS env man pages: these take no value (and the three signal options only an attached `=SIG`) ...
_ENV_SHORT_NOVALUE = "i0v"
_ENV_LONG_NOVALUE = ("ignore-environment", "null", "debug", "list-signal-handling", "help", "version", "block-signal",
                     "default-signal", "ignore-signal")
# ... and these take one (-L/-U: macOS env's login class / user). Any other option, a future env version's new one
# included, cannot be stepped over safely: the command behind it is undecidable, which counts as a send.
_ENV_SHORT_VALUE = "uCSPaLU"
_ENV_LONG_VALUE = ("unset", "chdir", "split-string", "argv0")
_CHDIR_SPECS["env"] = _CHDIR_SPECS["genv"] = (_ENV_SHORT_VALUE, "C", _ENV_LONG_OPTIONS, _ENV_LONG_VALUE)


def _env_heads(toks, _d):
    i = 1
    while i < len(toks):
        t = toks[i]
        if _ENV_ASSIGN.match(t):
            # NAME=VALUE ends the options (GNU env stops at the first non-option): the rest is more of them, then the command
            while i < len(toks) and _ENV_ASSIGN.match(toks[i]):
                i += 1
            break
        if t == "--":
            i += 1
            break
        if t == "-":  # the old spelling of -i
            i += 1
            continue
        if t.startswith("--"):
            name = _env_long_name(t)
            if name == "split-string":
                value, after = (t.split("=", 1)[1], i + 1) if "=" in t else ((toks[i + 1] if i + 1 < len(toks) else ""), i + 2)
                return _env_split_heads(value, toks[after:], _d)
            if name in _ENV_LONG_VALUE:
                i += 1 if "=" in t else 2
                continue
            if name in _ENV_LONG_NOVALUE:
                i += 1
                continue
            return [None]
        if t.startswith("-"):
            step = 1
            for x in range(1, len(t)):
                ch = t[x]
                if ch in _ENV_SHORT_NOVALUE:
                    continue
                if ch in _ENV_SHORT_VALUE:
                    joined = x < len(t) - 1
                    if ch == "S":
                        value, after = (t[x + 1:], i + 1) if joined else ((toks[i + 1] if i + 1 < len(toks) else ""), i + 2)
                        return _env_split_heads(value, toks[after:], _d)
                    step = 1 if joined else 2
                    break
                return [None]
            i += step
            continue
        break
    return _command_heads(toks[i:], _d + 1)


def _env_split_heads(value, rest, _d):
    """ENVOPTHEAD1104: `env -S STRING` splits STRING into words and runs them (the words after it appended), so the
    real command is inside the value. It was skipped as an option value, and `env -S "python3 send.py --to a@x"`
    was no send. The value is split by this module's own tokenizer; one that does not split counts as a send."""
    try:
        segs = _segments_tokens(value)
    except ValueError:
        return [None]
    if not segs:
        segs = [[]]
    segs[-1] = list(segs[-1]) + list(rest)
    # Bence 69552: GNU env parses the options at the START of the split words too (`env -S "-C DIR python3 send.py"`
    # runs python3 in DIR, measured with genv 9.10), so the first segment goes back through env's own option parser,
    # as if it were `env <words> <rest>`, not with its first word taken as the program.
    heads = []
    for k, s in enumerate(segs):
        heads += _command_heads((["env"] + list(s)) if k == 0 else s, _d + 1)
    return heads


def _segment_is_send(toks, depth: int) -> bool:
    return any(_head_is_send(h, depth) for h in _command_heads(toks))


# SUBAGENTMAILGATE1016: the sender was recognised only with the script as the
# FIRST interpreter argument and the exact --to flag. The boundary and the
# measured bypasses are written out at pythonHeadSends in email-send-gate.mjs
# (the JS twin); send-invocation-cases.json binds the two. MAILGATEVARARGS1020
# narrowed the undecidable-path branch to the recipient flag (same place).
_PY_OPT_WITH_ARG = {"-X", "-W", "--check-hash-based-pycs"}
_RECIPIENT_FLAG = re.compile(r"^--to?(=|$)")
_UNDECIDABLE_PATH = re.compile(r"[*?[{$]")


# FLEETTOFLAG1025 v4 (Merlin 34827, after three RO rounds of tokenizer patches): no tokenizer reading of the recipient value any
# more. On an UNDECIDABLE program or script the recipient flag is a send, EXCEPT when every --to / --to= value is a KNOWN agent name
# (the install's agents/ directories and its MAIN_AGENT_ID) AND the WHOLE command line has no `@`, no `~` word other than a `~/` path
# and no --cc / --bcc. Every other shape is a send (fail-closed): a continuation, a redirection or a future form next to the value
# simply is not a known agent name, and an address anywhere in the line blocks the exception.
_FLEET_EXEMPT_BLOCK = re.compile(r"@|(?:^|[\s='\"(])~(?!/)|--b?cc\b")
_FLEET_TOKEN_BLOCK = re.compile(r"--(?:cc?|bc{0,2})(?:=|\Z)|~(?!/)")   # on the DEQUOTED words: `--c""c`, `--\cc` are `--cc` to the program;
# (v4.1, Merlin 34962) an argparse abbreviation (--c, --b, --bc) is --cc / --bcc to a default-argparse script: a send
_AGENT_NAME = re.compile(r"[a-z0-9][a-z0-9_-]*\Z")
KNOWN_AGENTS_OVERRIDE = None   # the shared conformance list sets it (send-invocation-cases.json known_agents); None = the install
_LINE_EXEMPT_OK = [False]      # set per top-level is_send_invocation call from the WHOLE command line


def _tok(t: str) -> str:
    """a token as the program sees it after a backslash-newline: the glued leading / trailing newlines cut"""
    return t.strip("\n")


def _recipient_flag(t: str) -> bool:
    """the --to / --t flag on the cut token (RO #56 minor 1: the python `$` also matched before a trailing newline, the JS one not)"""
    return _RECIPIENT_FLAG.match(_tok(t)) is not None


def _known_agents() -> set:
    """the agent names of THIS install: <root>/agents/* directories and MAIN_AGENT_ID in <root>/.env (root = two levels above
    this file). Any read error = an empty set, i.e. no exception (fail-closed)."""
    if KNOWN_AGENTS_OVERRIDE is not None:
        return set(KNOWN_AGENTS_OVERRIDE)
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    names = set()
    try:
        d = os.path.join(root, "agents")
        names |= {n for n in os.listdir(d) if _AGENT_NAME.match(n) and os.path.isdir(os.path.join(d, n))}
    except OSError:
        pass   # no agents/ directory: only the main agent can be known
    try:
        with open(os.path.join(root, ".env"), encoding="utf-8") as f:
            for line in f:
                m = re.match(r"\s*MAIN_AGENT_ID\s*=\s*['\"]?([^'\"\s#]+)", line)
                if m and _AGENT_NAME.match(m.group(1)):
                    names.add(m.group(1))
    except OSError:
        pass   # no .env: the main agent is not known (fail-closed)
    return names


def _line_clean(cmd: str) -> bool:
    """FLEETTOFLAG1025 v4 (Codex 0dd77c650df7): no address marker in the line -- neither in the raw text (`@`, `~`-word, --cc/--bcc)
    nor in any DEQUOTED word of any segment, the substitution-flattened form included (`--c""c "$E"` is `--cc` to the program).
    An unparseable line is not clean (fail-closed)."""
    if _FLEET_EXEMPT_BLOCK.search(cmd):
        return False
    try:
        words = [t for c in (cmd, flatten_substitutions(cmd)) for seg in _segments_tokens(c) for t in seg]
    except ValueError:
        return False
    return not any("@" in w or _FLEET_TOKEN_BLOCK.match(_tok(w)) for w in words)


def _fleet_to_exempt(rest) -> bool:
    """FLEETTOFLAG1025 v4: True (not a letter) only if the whole line passed the address check and every --to / --t value -- the
    very next token, or the part after `=` -- is a known agent name. A missing or empty value is not a name."""
    if not _LINE_EXEMPT_OK[0]:
        return False
    vals = []
    for i, t in enumerate(rest):
        tt = _tok(t)
        if tt in ("--to", "--t"):
            vals.append(_tok(rest[i + 1]) if i + 1 < len(rest) else "")
        elif tt.startswith(("--to=", "--t=")):
            vals.append(tt.split("=", 1)[1])
    if not vals:
        return False
    known = _known_agents()
    return all(v in known for v in vals)


def _undecidable_recipient_sends(rest) -> bool:
    """an undecidable program / script with a recipient flag is a send unless the fleet-agent exception holds"""
    return any(_recipient_flag(t) for t in rest) and not _fleet_to_exempt(rest)


def _python_script_operand(rest):
    """(script, stdin, stdin_redirect) for an interpreter's argument list."""
    stdin_redirect = False
    i = 0
    while i < len(rest):
        t = rest[i]
        if t == "--":
            return (rest[i + 1] if i + 1 < len(rest) else None), False, stdin_redirect
        if t == "-":
            return None, True, stdin_redirect
        if re.match(r"^-[cm]", t):  # code string / module: judged elsewhere
            return None, False, stdin_redirect
        if t in _PY_OPT_WITH_ARG:
            i += 2
            continue
        if t.startswith("<"):
            stdin_redirect = True
            i += 2 if t == "<" else 1
            continue
        if re.match(r"^[0-9]*>", t):   # ASCII digits only, as the JS twin (and bash: a file descriptor is ASCII)
            i += 2 if re.match(r"^[0-9]*>>?$", t) else 1
            continue
        if t.startswith("-") and len(t) > 1:
            i += 1
            continue
        return t, False, stdin_redirect
    return None, False, stdin_redirect


def flatten_substitutions(cmd: str) -> str:
    """Every unquoted command or process substitution as one undecidable word;
    see flattenSubstitutions in email-send-gate.mjs (the JS twin)."""
    out = []
    q = None
    i = 0
    n = len(cmd)
    while i < n:
        ch = cmd[i]
        if q:
            if ch == "\\" and q == '"' and i + 1 < n:
                out.append(ch + cmd[i + 1])
                i += 2
                continue
            if ch == q:
                q = None
            out.append(ch)
            i += 1
            continue
        if ch in ("'", '"'):
            q = ch
            out.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            out.append(ch + cmd[i + 1])
            i += 2
            continue
        opens = ch in ("$", "<", ">") and i + 1 < n and cmd[i + 1] == "("
        if opens or ch == "`":
            depth = 1
            j = i + (2 if opens else 1)
            iq = None
            while j < n and depth > 0:
                c = cmd[j]
                j += 1
                if iq:
                    if c == iq:
                        iq = None
                    continue
                if c in ("'", '"'):
                    iq = c
                    continue
                if ch == "`":
                    if c == "`":
                        depth = 0
                    continue
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
            out.append(" $__SUBST__ ")
            i = j
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _python_head_sends(rest) -> bool:
    recipient = any(_recipient_flag(t) for t in rest)
    script, stdin, stdin_redirect = _python_script_operand(rest)
    if script is not None and _SENDPY.match(_basename(script)):
        return recipient
    if script is not None and _UNDECIDABLE_PATH.search(script):
        return _undecidable_recipient_sends(rest)  # MAILGATEVARARGS1020, FLEETTOFLAG1025 v4
    if stdin or (script is None and stdin_redirect):
        return recipient
    return False


def _head_is_send(toks, depth: int) -> bool:
    if toks is None:  # the depth bound was hit on a wrapper: audit it
        return True
    if not toks:
        return False
    prog = _basename(toks[0])
    rest = toks[1:]
    if _SENDER_PROG.match(prog):
        return True
    if _MAIL_PROG.match(prog) and _mail_prog_sends(rest):
        return True
    # MAILGATEAPIB1027: curl speaks SMTP too (an smtp:// or smtps:// URL, --mail-rcpt, --mail-from)
    if _CURLISH.match(prog) and any(_CURL_SMTP.match(t) for t in rest):
        return True
    # burkolo hejj: a -c string-argumentum maga is parancs -- rekurzio
    if _WRAPPER_SHELL.match(prog) and depth < 3:
        for i, t in enumerate(rest):
            if t == "-c" and i + 1 < len(rest):
                if is_send_invocation(rest[i + 1], _depth=depth + 1):
                    return True
    # interpreter kod-string: python -c / node -e / --eval, ami kuldest hiv
    if _PYTHON.match(prog) or _NODEISH.match(prog):
        for i, t in enumerate(rest):
            if t in ("-c", "-e", "--eval") and i + 1 < len(rest) and _code_string_sends(rest[i + 1], _lang_of(prog)):
                return True
    # send.py futtatasa (kozvetlenul, vagy python/runner utan) --to cimzettel
    candidates = [prog] + (
        [_basename(rest[0])] if rest and (_PYTHON.match(prog) or _NODEISH.match(prog)) else []
    )
    # Issue #1853: `python3 -m send` (or -m pkg.send) is the same sender run by module
    # name; it gets the same --to rule as the file-name form.
    if _PYTHON.match(prog):
        for i, t in enumerate(rest):
            if t == "-m" and i + 1 < len(rest) and rest[i + 1].rsplit(".", 1)[-1] == "send":
                candidates.append("send.py")
    if any(_SENDPY.match(c) for c in candidates) and any(_recipient_flag(t) for t in rest):
        return True
    if _PYTHON.match(prog) and _python_head_sends(rest):
        return True
    # an interpreter or program that cannot be resolved statically ($PY, a glob,
    # a substitution) with a recipient flag: what runs is undecidable here
    # FLEETTOFLAG1025: the address rule -- but a send.py run by it (`$PY scripts/support-mail/send.py --to x`) keeps the bare flag rule
    script = _python_script_operand(rest)[0]   # the script position (interpreter options, redirections skipped), not a data argument
    if _UNDECIDABLE_PATH.search(toks[0]) and (_undecidable_recipient_sends(rest) or (
            script is not None and _SENDPY.match(_basename(script)) and any(_recipient_flag(t) for t in rest))):
        return True
    # graph-mail kimeno alparanccsal (tsx/node runner utan is)
    if any(_GRAPHMAIL.match(_basename(t)) for t in toks) and "send" in rest:
        return True
    # curl/wget: a cel-token akkor is muvelet, ha idezojelben allt -- a
    # horgonyzott minta valasztja el a payload-belseji emlitestol.
    # RESENDGATE826: csak a TENYLEGES kuldes (POST/PUT/... vagy torzs) akad
    # fenn; a read-only GET/HEAD lekerdezes atmegy; a nem-donthato metodus
    # tovabbra is fail-closed.
    if _CURLISH.match(prog) and any(_RESEND_TARGET.match(t) for t in rest):
        return _curl_resend_verdict(prog, rest) != "read"
    return False


def wrapper_depth_hit(cmd: str) -> bool:
    """True when some segment is still a wrapper at the depth bound, so it was
    counted as a send without the real command being seen (HEADDEPTH924). The
    gate uses it to say WHY it blocks: "I could not audit the letter" is the
    wrong reason for `nohup x9 git status` (Marveen, #1522 review)."""
    # Only when the depth bound is the WHOLE reason: if a visible segment is a
    # send on its own (`sendmail x; sudo x9 true`), that send is the reason,
    # and the ordinary wording must stay (Samu, #1523 review).
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        return False
    heads = [h for toks in segments for h in _command_heads(toks)]
    return any(h is None for h in heads) and not any(
        h is not None and _head_is_send(h, 0) for h in heads)


# Issue #1853, the heredoc form: the segmenter drops every heredoc BODY (it is data
# to the shell), but when the command that opens it is an interpreter
# (`python3 - <<'PY'`, `node <<EOF`) the body IS the program, and a send in it went
# unseen. The opening line is read up to its `<<`; when its last command word there
# is python/node-ish, the body is judged with the -c / -e code rule. A heuristic
# of the same naive class as the -c rule (see the boundary note above).
# NARROWED (Geri's #1855 review, a 14-day replay: 1 real catch, 17 false): inside a heredoc
# body the program is mostly PROSE that a script writes (an hourly report whose text held a
# card id with SENDMAIL in it, next to `subprocess`). So the exec + sender-literal half of the
# code rule takes the literal here only as a lowercase, QUOTED command word: a string that
# starts with sendmail/msmtp/swaks or ends a path in send.py, as an argv item or an os.system
# command is written. The real catch (`['python3', '.../send.py', '--to', ...]`) keeps it.
# Development heredocs that patch or test the gates, and mention `import send` in a string,
# still hit the module rule: that is the price of a naive rule, accepted.
# NOT COVERED, named so nobody counts them as covered: a program the classifier never reads --
# `python3 /tmp/x.py`, `python3 < /tmp/x.py`, `cat /tmp/x.py | python3 -`, and
# `python3 -c "exec(open('/tmp/x.py').read())"`; also a here-string fed to an interpreter
# (`python3 <<<'import send'`) and a CommonJS destructuring rename of the Graph sender
# (`const { sendMail: s } = require(...)`).
# A heredoc fed to a SHELL (`bash <<EOF`, `sh -s <<EOF`) is a shell program: its body is
# judged with this classifier itself, one level deeper (Geri/Samu, #1855).
# WRITTEN, THEN RUN IN THE SAME COMMAND (Samu/Geri, #1855: two of the three real gate-passing
# sends in the sample had this shape): `cat > $S/x.py <<'EOF' ... EOF; python3 $S/x.py`. When a
# heredoc writes a file (`cat > P <<TAG` or `cat <<TAG > P`) and the same command runs an
# interpreter or a shell on the same path token P, the body is judged as if it had been fed to
# that program directly. The match is by the exact token: `./x.py` and `x.py` are different. A
# file written by one Bash call and run by ANOTHER stays out of reach (named above).
# PIPED (Samu/Geri, #1855): `cat <<'EOF' | bash` or `| python3 -` hands the body to the
# program through the pipe on the heredoc's opening line, and it is judged the same way.
_HEREDOC_SENDER_ARGV = re.compile(r"""['"](?:[^'"\s]*/)?(?:sendmail|msmtp|swaks|send\.py)(?=['"\s])""")


def _heredoc_body_sends(body: str, lang=None) -> bool:
    masked = _mask_prose_literals(body, lang)
    if _CODE_SEND.search(masked) or _CODE_SEND_MODULE.search(masked):
        return True
    return bool(_CODE_EXECISH.search(masked) and _HEREDOC_SENDER_ARGV.search(body))


def _lang_of(prog: str):
    """The masking language of an interpreter (MAILGATEHEREDOCFP1027): python, a JS runtime, else none."""
    prog = _basename(prog)
    if _PYTHON.match(prog):
        return "py"
    return "js" if _NODEISH.match(prog) else None


_HEREDOC_SHELL = re.compile(r"(?:^|[\s;&|(])(?:\S*/)?(?:bash|sh|zsh|dash)\b[^\n<]*$", re.I)
_HEREDOC_INTERP = re.compile(
    r"(?:^|[\s;&|(])(?:\S*/)?(python3?(?:\.\d+)?|node|tsx|ts-node|deno|bun)\b[^\n<]*$", re.I
)


_HEREDOC_PIPE = re.compile(r"\|\s*(?:\S*/)?(python3?(?:\.\d+)?|node|tsx|ts-node|deno|bun|bash|sh|zsh|dash)\b", re.I)
_HEREDOC_REDIRECT = re.compile(r"(?:^|[\s;&|(])(?:cat|tee)\b[^\n]*?(?:>>?|\btee(?:\s+-a)?)\s*(['\"]?)([^\s'\"<>;&|]+)\1")


def _written_then_run(cmd: str, written: dict, depth: int) -> bool:
    """A heredoc body written to a file that the same command then runs (see the note above)."""
    if not written:
        return False
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        return False
    for toks in segments:
        for head in _command_heads(toks):
            if not head:
                continue
            prog = _basename(head[0])
            args = [t for t in head[1:] if not t.startswith("-")]
            if prog.lower() == "npx" and args:
                args = args[1:]  # npx <runner> <file>
            if not args or args[0] not in written:
                continue
            body = written[args[0]]
            if (_PYTHON.match(prog) or _NODEISH.match(prog)) and _heredoc_body_sends(body, _lang_of(prog)):
                return True
            if _WRAPPER_SHELL.match(prog) and depth < 3 and is_send_invocation(body, _depth=depth + 1):
                return True
    return False


def _heredoc_program_sends(cmd: str, depth: int = 0) -> bool:
    written = {}
    for m in _HEREDOC.finditer(cmd):
        opener = cmd[cmd.rfind("\n", 0, m.start()) + 1:m.start()] + m.group(1)
        w = _HEREDOC_REDIRECT.search(opener)
        if w:
            written[w.group(2)] = cmd[m.end(1) + 1:m.end() - len(m.group(2))]
        piped = _HEREDOC_PIPE.search(m.group(1))
        if piped:
            pbody = cmd[m.end(1) + 1:m.end() - len(m.group(2))]
            if _WRAPPER_SHELL.match(piped.group(1)):
                if depth < 3 and is_send_invocation(pbody, _depth=depth + 1):
                    return True
            elif _heredoc_body_sends(pbody, _lang_of(piped.group(1))):
                return True
        line_start = cmd.rfind("\n", 0, m.start()) + 1
        head = cmd[line_start:m.start()]
        body = cmd[m.end(1) + 1:m.end() - len(m.group(2))]
        interp = _HEREDOC_INTERP.search(head)
        if interp:
            if _heredoc_body_sends(body, _lang_of(interp.group(1))):
                return True
        elif _HEREDOC_SHELL.search(head) and depth < 3:
            if is_send_invocation(body, _depth=depth + 1):
                return True
    return _written_then_run(cmd, written, depth)


def is_send_invocation(cmd: str, _depth: int = 0) -> bool:
    # FLEETTOFLAG1025 v4: the fleet-agent exception is decided on the WHOLE line; a wrapper body (depth > 0) can only tighten it.
    # A module-level flag is enough: the hook is one process per tool call, and the evaluation is single-threaded.
    _LINE_EXEMPT_OK[0] = (_depth == 0 or _LINE_EXEMPT_OK[0]) and _line_clean(cmd)
    if _heredoc_program_sends(cmd, _depth):
        return True
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        # Parse-hiba (pl. lezaratlan idezojel): nem tudunk poziciot mondani.
        # Konzervativ visszaeses: csak akkor auditalunk, ha eros kuldes-literal
        # all a szovegben -- igy egy fura, de valodi kuldes nem csuszik at
        # neman, a tipikus belso parancsok viszont nem kapnak hamis pozitivot.
        return bool(_FALLBACK_LITERALS.search(cmd))
    if any(_segment_is_send(toks, _depth) for toks in segments):
        return True
    # the same command with every substitution as one undecidable word
    # (flatten_substitutions): the outer command keeps the word it would run
    flat = flatten_substitutions(cmd)
    if flat == cmd:
        return False
    try:
        return any(_segment_is_send(toks, _depth) for toks in _segments_tokens(flat))
    except ValueError:
        return bool(_FALLBACK_LITERALS.search(cmd))

# MAILGATESCRIPT1027: a mail send done by a SCRIPT FILE. is_send_invocation sees the command text only,
# so `node send-it.mjs` or `python3 notify.py` ran a mail past the main agent's approval gate. This is the
# port of scriptRunSends in email-send-gate.mjs (the sub-agent gate; see SCRIPTSENDGATE1020 there for the
# rationale and the stated limits): the script an interpreter runs is read, and it is a send when it imports
# an SMTP library or nodemailer, or names a Microsoft Graph send endpoint, itself or in one level of local
# helpers. Unlike the JS twin it is FAIL-CLOSED, because here a "send" only asks for the level check: a script
# that cannot be found or read, or is too large, or whose path is a variable, counts as a send. Deliberately
# NOT part of is_send_invocation (the shared contract of send-invocation-cases.json); email-approval-gate.py
# calls it next to it.
_PY_MAIL_MODULE = r"(?:(?:aio)?smtplib|yagmail)"
_PY_MAIL_IMPORT = re.compile(
    r"^[ \t]*(?:import[ \t]+[^\n#]*\b" + _PY_MAIL_MODULE + r"\b|from[ \t]+" + _PY_MAIL_MODULE + r"\b[^\n]*\bimport\b)"
    r"|\bimport_module\(\s*['\"]" + _PY_MAIL_MODULE + r"['\"]",
    re.M,
)
_NODE_MAIL_MODULE = r"['\"]nodemailer['\"]"
_NODE_MAIL_IMPORT = re.compile(
    r"\brequire\s*\(\s*" + _NODE_MAIL_MODULE + r"\s*\)|^[ \t]*import\b[^\n]*" + _NODE_MAIL_MODULE
    + r"|\bimport\s*\(\s*" + _NODE_MAIL_MODULE + r"\s*\)",
    re.M,
)
# MAILGATESCRIPT1027 R2: groups: 1 = X and 2 = NAMES of `from X import NAMES`, 3 = NAMES of `import NAMES`
_PY_LOCAL_IMPORT = re.compile(
    r"^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import\b(?:[ \t]*\(?[ \t]*([\w., \t]+))?|import[ \t]+([\w., \t]+))", re.M)
_NODE_LOCAL_IMPORT = re.compile(
    # MAILGATESCRIPT1027 R1: `export ... from './x'` (an ESM re-export) loads the helper too
    # MAILGATESCRIPT1027 R2: a type-only import or export loads nothing
    r"(?:^[ \t]*export(?![ \t]+type[ \t]*(?:\{|\*|[A-Za-z_$][\w$]*[ \t]+from\b))\b[^\n]*?\bfrom\s*|\brequire\s*\(\s*|^[ \t]*import(?![ \t]+type[ \t]*(?:\{|\*|[A-Za-z_$][\w$]*[ \t]+from\b))\b[^\n]*?\bfrom\s*|^[ \t]*import\s*|\bimport\s*\(\s*)['\"](\.{1,2}/[^'\"\n]+)['\"]",
    re.M,
)
_NODE_EXTS = ("", ".js", ".mjs", ".cjs", ".ts", "/index.js", "/index.mjs", "/index.ts")
_HELPER_LIMIT = 40
_ADDRESS_FLAG = re.compile(r"^--(?:to|cc|bcc)(?:=(.*))?$", re.S)
_SCRIPT_FILE = re.compile(r"\.(?:py|mjs|cjs|js|ts)$", re.I)
_SHELL_C_FLAG = re.compile(r"^-[a-zA-Z]*c[a-zA-Z]*$")
_SCRIPT_READ_LIMIT = 1024 * 1024
_SHEBANG_READ_LIMIT = 512
_SHELL_C_DEPTH = 3


def _read_script_head(path: str, limit: int = _SCRIPT_READ_LIMIT):
    """The first `limit` bytes of the file as text, or None when it cannot be read."""
    try:
        with open(path, "rb") as fh:
            return fh.read(limit).decode("utf-8", errors="replace")
    except (OSError, ValueError):
        return None


_CD_OPTIONS = ("-P", "-L", "-e", "-@")


def _cd_bases(cwd, cmd_words):
    """MAILGATESCRIPT1027 R1: (bases, undecidable): the directories a relative script may be under -- cwd, and
    every literal `cd DIR` target of the command (cumulative over chained cds, and DIR alone under cwd).
    undecidable: some `cd` names a directory that cannot be known here (a variable, `-`, `~user`, none)."""
    cwd_abs = isinstance(cwd, str) and os.path.isabs(cwd)
    cur = cwd if cwd_abs else None
    bases = [cwd] if cwd_abs else []
    undecidable = False
    i = 0
    while i < len(cmd_words):
        word = cmd_words[i]
        if word not in ("cd", "pushd"):
            i += 1
            continue
        i += 1
        # Samu 69538: pushd DIR changes the directory like cd (its -n is stepped over: a DIR read as a target only adds a
        # candidate); pushd +N / -N rotates the stack, which cannot be known here
        while i < len(cmd_words) and (cmd_words[i] in _CD_OPTIONS or (word == "pushd" and cmd_words[i] == "-n")):
            i += 1
        if i < len(cmd_words) and cmd_words[i] == "--":
            i += 1  # MAILGATESCRIPT1027 R2: `--` ends the options, the next word is DIR even when it starts with `-`
        d = cmd_words[i] if i < len(cmd_words) else None
        tilde = d is not None and (d == "~" or d.startswith("~/"))
        if (not d or d == "-" or (d.startswith("~") and not tilde) or _UNDECIDABLE_PATH.search(d)
                or (word == "pushd" and re.match(r"^[+-]\d+$", d))):
            undecidable = True
            cur = None
            continue
        if tilde:
            new = os.path.expanduser(d)
        elif os.path.isabs(d):
            new = d
        elif cur is not None:
            new = os.path.join(cur, d)
        else:
            # after an undecidable cd: where DIR is cannot be known, but DIR under the cwd is still one candidate
            if cwd_abs:
                bases.append(os.path.join(cwd, d))
            undecidable = True
            cur = None
            continue
        bases.append(new)
        if not tilde and not os.path.isabs(d) and cwd_abs:
            bases.append(os.path.join(cwd, d))
        cur = new
    return list(dict.fromkeys(os.path.normpath(b) for b in bases)), undecidable


def _relative_under_undecidable_cd(script, cwd, cmd_words) -> bool:
    """MAILGATESCRIPT1027 R1: a relative script-shaped operand and a cd that cannot be resolved."""
    if not script or os.path.isabs(script) or script == "~" or script.startswith("~/"):
        return False
    if not (_SCRIPT_FILE.search(script) or "/" in script):
        return False
    return _cd_bases(cwd, cmd_words)[1]


def _resolve_script_paths(script, cwd, cmd_words):
    """Every absolute path the script operand can name: itself when absolute, `~` expanded, a relative
    one under cwd and under every literal `cd DIR` target of the command. May be empty."""
    if not script or _UNDECIDABLE_PATH.search(script):
        return []
    p = script
    if p == "~" or p.startswith("~/"):
        p = os.path.expanduser(p)
    if os.path.isabs(p):
        return [p]
    bases = _cd_bases(cwd, cmd_words)[0]
    out = []
    for b in bases:
        c = os.path.normpath(os.path.join(b, p))
        if c not in out:
            out.append(c)
    return out


def _node_script_operand(prog, rest):
    """node/tsx/bun/deno: the first non-option word is the script (-e/--eval code strings are
    is_send_invocation's). `bun run x` / `deno run x` skip the run word; `npx tsx x` / `npx ts-node x` /
    `npx node x` name the script after the runner, any other npx package is no script."""
    words = []
    for t in rest:
        if t == "--":
            continue
        if t.startswith("-"):
            return None
        words.append(t)
        if len(words) == 2:
            break
    if prog == "npx":
        return (words[1] if len(words) > 1 else None) if words and words[0] in ("tsx", "ts-node", "node") else None
    if prog in ("bun", "deno") and words and words[0] == "run":
        return words[1] if len(words) > 1 else None
    return words[0] if words else None


def _address_flag_given(rest) -> bool:
    for i, t in enumerate(rest):
        m = _ADDRESS_FLAG.match(t)
        if not m:
            continue
        val = m.group(1) if m.group(1) is not None else (rest[i + 1] if i + 1 < len(rest) else "")
        if "@" in val:
            return True
    return False


def _shebang_env_program(words):
    """The program an `env` #! line runs. ENVOPTHEAD1104 (Bence 69552): the line's words go through the same env
    option parser as a command line's (a value option, a long prefix, -S with options at its start), so
    `#!/usr/bin/env -S -a x python3` and `-S --c /tmp python3` are python3. An undecidable line names no program."""
    progs = [_basename(h[0]) for h in _command_heads(["env"] + list(words)) if h]
    return next((p for p in progs if _PYTHON.match(p) or (_NODEISH.match(p) and p != "npx")), progs[0] if progs else "")


def _shebang_kind(text):
    """'py' | 'node' | None from a #! line (`#!/usr/bin/python3`, `#!/usr/bin/env -S node`)."""
    m = re.match(r"#!\s*(\S+)([^\n]*)", text or "")
    if not m:
        return None
    prog = _basename(m.group(1))
    if prog in ("env", "genv"):
        prog = _basename(_shebang_env_program(m.group(2).split()))
    if _PYTHON.match(prog):
        return "py"
    if _NODEISH.match(prog) and prog != "npx":
        return "node"
    return None


def _local_helper_paths(path, text, kind):
    """One level of local helpers: modules the script imports, resolved next to it."""
    # MAILGATESCRIPT1027 R1: next to the script and, for a symlinked entry, next to its real path
    dirs = [os.path.dirname(path)]
    try:
        real = os.path.dirname(os.path.realpath(path))
        if real not in dirs:
            dirs.append(real)
    except (OSError, ValueError):
        pass  # the lexical directory only
    # MAILGATESCRIPT1027 R2: the limit applies per directory, so a symlinked entry's real-path helpers are looked at
    lists = []
    for d in dirs:
        out = []
        if kind == "py":
            for m in _PY_LOCAL_IMPORT.finditer(text):
                if m.group(1) and m.group(1).startswith("."):
                    x = m.group(1)
                    rest = x.lstrip(".")
                    base = d
                    for _ in range(len(x) - len(rest) - 1):
                        base = os.path.dirname(base)
                    if rest:
                        rels = [rest.replace(".", "/")]
                    else:
                        rels = [(n.split() or [""])[0] for n in (m.group(2) or "").split(",")]
                    for rel in rels:
                        if rel:
                            out += [os.path.normpath(os.path.join(base, rel + ".py")),
                                    os.path.normpath(os.path.join(base, rel, "__init__.py"))]
                    continue
                names = [m.group(1)] if m.group(1) else [(n.split() or [""])[0] for n in (m.group(3) or "").split(",")]
                for name in names:
                    if not name or name.startswith("."):
                        continue
                    rel = name.replace(".", "/")
                    out += [os.path.normpath(os.path.join(d, rel + ".py")),
                            os.path.normpath(os.path.join(d, rel, "__init__.py"))]
        else:
            for m in _NODE_LOCAL_IMPORT.finditer(text):
                out += [os.path.normpath(os.path.join(d, m.group(1) + ext)) for ext in _NODE_EXTS]
        lists.append([p for p in dict.fromkeys(out) if p != path][:_HELPER_LIMIT])
    return list(dict.fromkeys(p for lst in lists for p in lst))


# MAILGATEAPIB1027 (Samu 50983): a subprocess that runs a mail program, written into a FILE, went through, while
# the same code as a -c string did not. The file path takes a CALL shape: a process-starting call whose first
# argument (a string, or the first item of a list) starts with sendmail, msmtp or swaks. Read on the raw text, since
# a shell string ('sendmail -t < m.eml') holds whitespace and the masker blanks it. Not the code-string rule as it
# is: measured over the repo, its loose form (exec word anywhere, the sender word anywhere, plus sendMail( / mail.send
# / SMTP( anywhere) made 21 of the gates' own sources and tests a "sender" for the sub-agents' hard gate, which
# would refuse running them. Not send.py either: the support-mail test harnesses run it under stubs.
# Samu 50995 N1: the call is found on the MASKED text (its name and the opening parenthesis are code there; a call
# shape quoted inside a prose literal is blanked), and its first argument is read from the RAW text at the same
# position (the masker keeps the length in code points), since a shell string holds whitespace.
_FILE_EXEC_CALL = re.compile(
    r"(?:\bsubprocess\.(?:run|call|check_call|check_output|Popen)|\bos\.(?:system|popen)|\bexec(?:File)?(?:Sync)?|\bspawn(?:Sync)?)\s*\(")
_FILE_EXEC_ARG = re.compile(r"""\s*\[?\s*['"`](?:[^'"`\s]*/)?(?:sendmail|msmtp|swaks)(?=['"`\s])""")


def _file_exec_sends(raw: str, masked: str) -> bool:
    if len(raw) != len(masked):  # not expected; the raw text is then judged alone, which errs toward a send
        masked = raw
    return any(_FILE_EXEC_ARG.match(raw, m.end()) for m in _FILE_EXEC_CALL.finditer(masked))


def _text_sends(raw: str, masked: str, imports) -> bool:
    """A script file's (or helper's) text: the mail imports, the web mail APIs, and a call that runs a mail program."""
    return bool(imports.search(masked) or _web_mail_sends(masked) or _file_exec_sends(raw, masked))


def _file_sends(path, text, kind, read_script) -> bool:
    imports = _PY_MAIL_IMPORT if kind == "py" else _NODE_MAIL_IMPORT
    lang = "py" if kind == "py" else "js"
    if _text_sends(text, _mask_prose_literals(text, lang), imports):
        return True
    # The helpers are found on the raw text: a helper named only in a docstring is read too, which errs toward a send.
    for h in _local_helper_paths(path, text, kind):
        t = read_script(h, _SCRIPT_READ_LIMIT)
        if t is not None and _text_sends(t, _mask_prose_literals(t, lang), imports):
            return True
    return False


# COPYGATEDRAFTFP1104 (Samu 69301, Bence 69319): a python script given a --to/--cc/--bcc address used to be a send
# before it was read (MAILGATESCRIPT1027), so an IMAP draft writer (`python3 draft.py --to a@x`, imaplib APPEND) needed
# approval like a sender. The address rule now yields to the script judge ONLY when the script, and every local helper
# it imports (read in turn), uses nothing but a short ALLOWLIST of modules a draft writer needs, in plain forms the walk
# can follow. Everything else keeps the old rule (a send): any other module, standard library included (a stdlib module
# can send or run code on its own: logging.handlers.SMTPHandler, timeit, pdb, cProfile ... -- Bence 69319), an
# installed package, an import that cannot be parsed, code the judge cannot follow (dynamic import, exec/eval/compile,
# getattr and friends, a dunder or private attribute, a module reached through another module's attribute:
# `imaplib.socket`, `pathlib.os`), os and sys beyond a few plain attributes, the depth or file budget running out.
# Exactly the imports of the draft writers (Samu 69321, Bence 69319); widening it is a gate decision, not a fix.
_PY_DRAFT_MODULES = frozenset((
    "imaplib", "email", "argparse", "json", "re", "datetime", "time", "base64", "pathlib", "textwrap", "html",
    "mimetypes", "uuid", "hashlib", "getpass", "string", "os", "sys",
))
# os and sys only through these attributes (a bare `os`, passed on or aliased, is not followed)
_PY_OS_ATTRS = frozenset(("path", "environ", "getenv", "getcwd"))
_PY_SYS_ATTRS = frozenset(("argv", "exit", "stdin"))
# Builtins that run code (or a pager, help()), and the reflective reaches, as bare names (`re.compile` is not `compile`)
_PY_UNFOLLOWED_CODE = re.compile(
    r"(?<![\w.])(?:__import__|exec|eval|compile|execfile|__builtins__|getattr|setattr|delattr|globals|locals|vars"
    r"|__loader__|__spec__|breakpoint|help|get_type_hints)\b")
# An attribute that reaches a module or a raw channel through another object: `imaplib.socket`, `pathlib.os`,
# `argparse._os`, an IMAP object's own socket and raw writer (`.sock`, `.send`: SMTP spoken over a re-opened IMAP
# connection), the stream class that runs a command (`IMAP4_stream`), and every private or dunder attribute except
# on self / cls (`uuid._get_command_stdout`, `os.__dict__`, `type(x).__subclasses__`).
_PY_REACH_ATTRS = ("os", "sys", "socket", "subprocess", "ssl", "posix", "nt", "builtins", "importlib", "smtplib",
                   "logging", "shutil", "pty", "ctypes", "signal", "multiprocessing", "asyncio", "threading", "select",
                   "selectors", "http", "urllib", "operator", "IMAP4_stream", "sock", "send", "sendall", "file",
                   "readline", "shutdown", "sslobj", "get_type_hints")
_PY_REACH = re.compile(r"\.\s*(?:" + "|".join(_PY_REACH_ATTRS) + r")\b|(?<!self)(?<!cls)\.\s*_[A-Za-z_]")
# a class built on an imaplib class can override what the constructor checks (and reach the socket)
_PY_IMAP_SUBCLASS = re.compile(r"\bclass\b[^\n:]*\([^)]*\bIMAP4")
_PY_FROM_IMPORT = re.compile(r"\bfrom[ \t]+(\.*[\w.]*)[ \t]+import\b[ \t]*(\([^)]*\)|[\w.,* \t]*)")
_PY_PLAIN_IMPORT = re.compile(r"\bimport[ \t]+([\w., \t]+)")
_PY_WALK_FILES = 24
_PY_WALK_DEPTH = 4


def _py_module_files(dirs, dotted):
    """The local files `import a.b` loads from one of dirs: each package __init__.py on the way and the module."""
    out = []
    parts = dotted.split(".")
    for d in dirs:
        for i in range(1, len(parts) + 1):
            base = os.path.join(d, *parts[:i])
            if i < len(parts):
                out.append(os.path.join(base, "__init__.py"))
            else:
                out += [base + ".py", os.path.join(base, "__init__.py")]
    return list(dict.fromkeys(os.path.normpath(p) for p in out))


def _py_script_dirs(path):
    dirs = [os.path.dirname(path)]
    try:
        real = os.path.dirname(os.path.realpath(path))
        if real not in dirs:
            dirs.append(real)
    except (OSError, ValueError):
        pass
    return dirs


def _py_imports(masked):
    """(modules, froms, spans, ok). modules: (name, required) for each module a masked text imports, a relative one
    with its leading dots; a `from M import x` also lists M.x as not required (x may be a submodule, or only a name).
    froms: (M, [names]) per from-import. plains: (name, alias) per `import name [as alias]`. spans: the statements'
    text ranges. ok=False when an `import` word is not one of the two plain forms (a continuation line, `import(`)."""
    mods, froms, plains, spans = [], [], [], []
    for m in _PY_FROM_IMPORT.finditer(masked):
        spans.append((m.start(), m.end()))
        mod = m.group(1)
        if not mod:
            return [], [], [], [], False
        mods.append((mod, True))
        names = []
        for n in (m.group(2) or "").strip().strip("()").replace("\n", ",").split(","):
            name = (n.split() or [""])[0]
            if name:
                names.append(name)
                if name != "*":
                    mods.append((mod + ("" if mod.endswith(".") else ".") + name, False))
        froms.append((mod, names))
    for m in _PY_PLAIN_IMPORT.finditer(masked):
        if any(a <= m.start() < b for a, b in spans):
            continue
        spans.append((m.start(), m.end()))
        for n in m.group(1).split(","):
            words = n.split()
            if not words:
                return [], [], [], [], False
            mods.append((words[0], True))
            plains.append((words[0], words[2] if len(words) >= 3 and words[1] == "as" else None))
    # every `import` keyword must sit inside one of the parsed statements (a `\` continuation, `import(` ... do not)
    for m in re.finditer(r"\bimport\b", masked):
        if not any(a <= m.start() < b for a, b in spans):
            return [], [], [], [], False
    if "\\\n" in masked:
        return [], [], [], [], False
    return mods, froms, plains, spans, True


def _py_code_unfollowed(masked, froms, plains, spans) -> bool:
    """The allowlist's code rules over one masked file (see the block above)."""
    for mod, alias in plains:
        if alias and mod.split(".")[0] in ("os", "sys"):
            return True
    for mod, names in froms:
        if mod.startswith("."):
            continue
        top = mod.split(".")[0]
        for name in names:
            if name == "*" or name.startswith("_") or name in _PY_REACH_ATTRS:
                return True
            if mod == "os" and name not in _PY_OS_ATTRS:
                return True
            if mod == "sys" and name not in _PY_SYS_ATTRS:
                return True
        if top not in ("os", "sys") and "*" in names:
            return True
    # the code outside the import statements
    code = list(masked)
    for a, b in spans:
        code[a:b] = " " * (b - a)
    code = "".join(code)
    if _PY_UNFOLLOWED_CODE.search(code) or _PY_REACH.search(code) or _PY_IMAP_SUBCLASS.search(code):
        return True
    for m in re.finditer(r"(?<![\w.])(os|sys)\b", code):
        attr = re.match(r"\s*\.\s*(\w+)", code[m.end():])
        allowed = _PY_OS_ATTRS if m.group(1) == "os" else _PY_SYS_ATTRS
        if not attr or attr.group(1) not in allowed:
            return True
    return False


def _py_walk_verdict(path, text, read_script):
    """'send' | 'unfollowed' | 'clean' for a readable python script and everything it imports (see the block above)."""
    seen = {os.path.normpath(path)}
    queue = [(os.path.normpath(path), text, 0)]
    while queue:
        cur, body, depth = queue.pop(0)
        if len(body.encode("utf-8")) > _SCRIPT_READ_LIMIT or _ZIP_MAGIC in body:
            return "send"
        masked = _mask_prose_literals(body, "py")
        # no separate mail-text check here: smtplib, the network clients and the process modules are all off the
        # allowlist, so a file that sends is already "unfollowed" (the judge's own text check runs before the walk)
        mods, froms, plains, spans, ok = _py_imports(masked)
        if not ok or _py_code_unfollowed(masked, froms, plains, spans):
            return "unfollowed"
        dirs = _py_script_dirs(cur)
        for mod, required in mods:
            if mod.startswith("."):
                rest = mod.lstrip(".")
                base = os.path.dirname(cur)
                for _ in range(len(mod) - len(rest) - 1):
                    base = os.path.dirname(base)
                files = _py_module_files([base], rest) if rest else [os.path.join(base, "__init__.py")]
                local = [f for f in files if read_script(f, 1) is not None]
                if not local and required and rest:
                    return "unfollowed"
            else:
                top = mod.split(".")[0]
                # a local file of the same name shadows the standard library: it is what runs, so it is read
                local = [f for f in _py_module_files(dirs, mod) if read_script(f, 1) is not None]
                if not local:
                    if not required:
                        continue
                    if top not in _PY_DRAFT_MODULES or (top == "os" and mod not in ("os", "os.path")):
                        return "unfollowed"
                    continue
            for f in local:
                if f in seen:
                    continue
                if depth + 1 > _PY_WALK_DEPTH or len(seen) >= _PY_WALK_FILES:
                    return "unfollowed"
                t = read_script(f, _SCRIPT_READ_LIMIT + 1)
                if t is None:
                    return "unfollowed"
                seen.add(f)
                queue.append((f, t, depth + 1))
    return "clean"


def _py_address_run_sends(paths, read_script) -> bool:
    """A python script run with an address flag: a send unless some candidate is readable and every readable
    candidate walks 'clean' (COPYGATEDRAFTFP1104)."""
    found = False
    for path in paths:
        text = read_script(path, _SCRIPT_READ_LIMIT + 1)
        if text is None:
            path = os.path.join(path, "__main__.py")
            text = read_script(path, _SCRIPT_READ_LIMIT + 1)
        if text is None:
            continue
        found = True
        if _py_walk_verdict(path, text, read_script) != "clean":
            return True
    return not found


# MAILGATEDIRZIP1027: python runs a directory's __main__.py, and a zip app's __main__.py from inside the
# archive. The archive is not unpacked here, so a zip run by python is a send.
_ZIP_MAGIC = "PK\x03\x04"


def _judge_candidates(paths, kind, read_script):
    """(readable, verdict): a send when ANY readable candidate sends -- the candidates are where the script
    may be (cwd, each `cd` target), and which one runs is not known here; a file over the read limit is a send."""
    readable = False
    for path in paths:
        text = read_script(path, _SCRIPT_READ_LIMIT + 1)
        if text is None and kind == "py":
            path = os.path.join(path, "__main__.py")
            text = read_script(path, _SCRIPT_READ_LIMIT + 1)
        if text is None and kind == "node":
            # node runs DIR/package.json "main", else DIR/index.js; a main that cannot be read as named is a send
            pkg = read_script(os.path.join(path, "package.json"), _SCRIPT_READ_LIMIT + 1)
            main = None
            if pkg is not None:
                try:
                    data = json.loads(pkg)
                except ValueError:
                    return True, True
                main = data.get("main") if isinstance(data, dict) else None
            declared = isinstance(main, str) and main != ""
            path = os.path.normpath(os.path.join(path, main)) if declared else os.path.join(path, "index.js")
            text = read_script(path, _SCRIPT_READ_LIMIT + 1)
            if text is None and declared:
                return True, True
        if text is None:
            continue
        readable = True
        if kind == "py" and _ZIP_MAGIC in text:
            return True, True
        if len(text.encode("utf-8")) > _SCRIPT_READ_LIMIT or _file_sends(path, text, kind, read_script):
            return True, True
    return readable, False


def _python_module(rest):
    """MAILGATESCRIPT1027 R1: MOD of `-m MOD` / `-mMOD` among the interpreter options, else None."""
    i = 0
    while i < len(rest):
        t = rest[i]
        if t == "-m":
            return rest[i + 1] if i + 1 < len(rest) else None
        if re.match(r"^-m[^-]", t):
            return t[2:]
        # MAILGATEDIRZIP1027: -m at the end of a cluster of flags without a value (`-um MOD`, `-BmMOD`)
        cluster = re.match(r"^-[bBdEhiIOPqRsSuvVx]+m(.*)$", t)
        if cluster:
            return cluster.group(1) or (rest[i + 1] if i + 1 < len(rest) else None)
        if t in _PY_OPT_WITH_ARG:
            i += 2
            continue
        if t.startswith("-") and t != "--" and not t.startswith("-c"):
            i += 1
            continue
        return None
    return None


# JSCDSEND1104 (Samu 69538 / 69623): a run is ADDRESSED when the command names a recipient: --to / --cc / --bcc (any
# value) or an e-mail address anywhere in it. The two gates differ HERE, and only here:
#   - the sub-agent gate (email-send-gate.mjs, a hard deny) calls the fail-closed branches (an undecidable cd or -m, a
#     missing or unreadable script) a send only on an addressed run, or a developer's `cd $WT && python3 -m pytest`
#     would be refused; an undecidable SCRIPT PATH is a send there on every run too (ISSUE2582, Samu 72403);
#   - this gate (the main agent's approval gate) keeps them fail-closed on every run: it guards the owner's real mail,
#     a script can carry the address inside, and the cost of a false positive is an approval request, not a denial.
# A READABLE sender is a send on both. script-run-cases.json holds both expected verdicts per row (main / sub).
_FAIL_CLOSED_NEEDS_ADDRESS = False
_EMAIL_IN_WORD = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")


def _run_is_addressed(rest, cmd_words) -> bool:
    return any(_ADDRESS_FLAG.match(w) or _EMAIL_IN_WORD.search(w) for w in list(rest) + list(cmd_words))


def _python_module_sends(module, cwd, cmd_words, read_script, addressed=False) -> bool:
    """MAILGATESCRIPT1027 R1: `python -m MOD` runs MOD.py or MOD/__main__.py under cwd or a cd target. An
    installed module cannot be read here, so with no readable candidate it is not a send."""
    if not re.match(r"^[\w.]+$", module):
        return False
    rel = module.replace(".", "/")
    bases, undecidable = _cd_bases(cwd, cmd_words)
    if undecidable and addressed:
        return True  # MAILGATESCRIPT1027 R2: a cd that cannot be resolved: fail-closed when addressed (JSCDSEND1104)
    paths = []
    for base in bases:
        paths += [os.path.normpath(os.path.join(base, rel + ".py")),
                  os.path.normpath(os.path.join(base, rel, "__main__.py"))]
    return _judge_candidates(paths, "py", read_script)[1]


def _head_runs_sender_script(toks, cwd, read_script, depth, cmd_words) -> bool:
    if not toks:
        return False
    prog = _basename(toks[0])
    rest = toks[1:]
    if _WRAPPER_SHELL.match(prog):
        if depth >= _SHELL_C_DEPTH:
            return False
        for i in range(len(rest) - 1):
            if _SHELL_C_FLAG.match(rest[i]) and script_run_sends(rest[i + 1], cwd, read_script, depth + 1, cmd_words):
                return True
        return False
    # the fail-closed branches below fire when `addressed`: on this gate always (see _FAIL_CLOSED_NEEDS_ADDRESS)
    # Samu 69648 (3a): after a command-substitution cd, what runs is out of sight even without an address
    addressed = (not _FAIL_CLOSED_NEEDS_ADDRESS) or _SUBST_MARK in cmd_words or _run_is_addressed(rest, cmd_words)
    if _PYTHON.match(prog):
        module = _python_module(rest)
        script = None if module else _python_script_operand(rest)[0]
        if _address_flag_given(rest):
            # COPYGATEDRAFTFP1104: an address is a send (also under -m / -c, where no file is named), unless the script
            # file and everything it imports is visible here and the walk finds no send (_py_walk_verdict). A PYTHON*
            # setting in the command can change what an import loads, so it keeps the old rule. Bence 69343 / Samu
            # 69345: code the interpreter runs at START-UP, before the script (a .pth line, sitecustomize,
            # usercustomize in a writable site-packages), is not visible to the walk; only -I with -S (or -E -s -S)
            # turns it off, so without them the old rule holds (the approval gate names the fix: draft_isolation_hint).
            if not _address_run_judgeable(rest, module, script, cwd, cmd_words, toks[0]):
                return True
            return _py_address_run_sends(_resolve_script_paths(script, cwd, cmd_words), read_script)
        if module:
            return _python_module_sends(module, cwd, cmd_words, read_script, addressed)
        kind = "py"
    elif _NODEISH.match(prog):
        script = _node_script_operand(prog, rest)
        # MAILGATESCRIPT1027 R1: npx with another package than the tsx / ts-node / node runner form is no script run
        if prog == "npx" and script is None:
            return False
        if _address_flag_given(rest):
            return True
        kind = "node"
    elif _subst_artefact(toks[0]):
        return False  # Samu 69682: a piece of a cut command substitution, not a file that runs
    elif _SCRIPT_FILE.search(toks[0]) or "/" in toks[0]:
        # a directly executed file: its #! line picks the interpreter, else its extension
        # MAILGATESCRIPT1027 R1: every candidate is judged on its own, with its own kind
        paths = _resolve_script_paths(toks[0], cwd, cmd_words)
        ext_kind = "py" if re.search(r"\.py$", toks[0], re.I) else "node" if _SCRIPT_FILE.search(toks[0]) else None
        if addressed and _relative_under_undecidable_cd(toks[0], cwd, cmd_words):
            return True
        addr = _address_flag_given(rest)
        readable = False
        for p in paths:
            head = read_script(p, _SHEBANG_READ_LIMIT)
            if head is None:
                continue
            kind = _shebang_kind(head) or ext_kind
            if not kind:
                continue
            if addr:
                return True
            readable = True
            if _judge_candidates([p], kind, read_script)[1]:
                return True
        if readable:
            return False
        if not ext_kind:
            # no candidate with a kind is readable: a #! line cannot be known, the extension gives none
            return False
        # the kind is known and no candidate is readable: fail-closed when addressed; an undecidable path always
        return addressed or bool(_UNDECIDABLE_PATH.search(toks[0]))
    else:
        return False
    if script is None:
        return False
    if _UNDECIDABLE_PATH.search(script):
        return True  # what runs is undecidable here: a send, addressed or not (ISSUE2582: the JS twin agrees now)
    if addressed and _relative_under_undecidable_cd(script, cwd, cmd_words):
        return True  # MAILGATESCRIPT1027 R1: a relative script after a cd that cannot be resolved: fail-closed
    paths = _resolve_script_paths(script, cwd, cmd_words)
    if prog == "node" and not re.search(r"\.[^/]*$", _basename(script)):
        # Samu 69538: node loads an extensionless script as X, X.js or X.json; a native X.node addon cannot be read here
        if addressed and any(read_script(p + ".node", _SHEBANG_READ_LIMIT) is not None for p in paths):
            return True
        paths = [c for p in paths for c in (p, p + ".js", p + ".json")]
    readable, verdict = _judge_candidates(paths, kind, read_script)
    if readable:
        return verdict
    # a missing script is a send when addressed; `bun test` is not
    return addressed and bool(_SCRIPT_FILE.search(script) or "/" in script)


# Samu 69538: the tokenizer cuts a command substitution out of its word, so `cd $(git rev-parse --show-toplevel)` and a
# backtick cd reach _cd_bases as a bare `cd`. Read on the raw command: such a cd or pushd is an undecidable cd.
_SUBST_CD = re.compile(r"""(?:^|[\s;&|(!{])(?:cd|pushd)(?:\s+-\S*)*\s+["']?[^\s;&|"']*(?:\$\(|`)""")
_SUBST_MARK = "$CMD_SUBST_CD"  # the undecidable cd word handed on for it


def _subst_artefact(t) -> bool:
    """Samu 69682 (1): a head that starts with whitespace, or has more `)` than `(`, is a piece of a command
    substitution the tokenizer cut (`H="$(cd "$(...)" && pwd)/x"`), not a file run by path. The JS twin agrees."""
    return bool(re.match(r"\s", t)) or t.count(")") > t.count("(")


# Samu 69682 (2): $(dirname P) / $(basename P) / $(realpath P) with a literal P are resolved on the raw command before
# tokenizing (nested too); with a variable argument the substitution becomes an outside variable. See the JS twin.
_DET_SUBST = re.compile(r"""\$\(\s*(dirname|basename|realpath)\s+(?:"([^"$`\\]*)"|'([^']*)'|([^\s$`'"()|;&<>*?\[\]{}\\]+)|("?)(\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*|[0-9]))\5)\s*\)""")
_OUTSIDE_PATH_VAR = "$GATE_OUTSIDE_PATH"
_SAFE_LITERAL = re.compile(r"""^[^\s$`'"()|;&<>*?\[\]{}\\]+$""")


def _det_subst_value(fn, p, cwd):
    if fn == "dirname":
        s = p.rstrip("/") or "/"
        if s == "/":
            return "/"
        i = s.rfind("/")
        if i < 0:
            return "."
        return s[:i].rstrip("/") or "/"
    if fn == "basename":
        s = p.rstrip("/")
        return "/" if s == "" else s.split("/")[-1]
    if os.path.isabs(p):
        ab = p
    elif isinstance(cwd, str) and os.path.isabs(cwd):
        ab = os.path.join(cwd, p)
    else:
        return None
    return os.path.realpath(ab) if os.path.exists(ab) else os.path.normpath(ab)


def _resolve_deterministic_subst(cmd, cwd):
    s = cmd
    for _ in range(16):
        m = _DET_SUBST.search(s)
        if not m:
            break
        if m.group(6) is not None:
            v = _OUTSIDE_PATH_VAR
        else:
            p = next(g for g in (m.group(2), m.group(3), m.group(4)) if g is not None)
            v = _OUTSIDE_PATH_VAR if p == _OUTSIDE_PATH_VAR else _det_subst_value(m.group(1), p, cwd)
            if v is None or not (v == _OUTSIDE_PATH_VAR or _SAFE_LITERAL.match(v)):
                break
        s = s[:m.start()] + v + s[m.end():]
    return s


_VAR_REF = re.compile(r"^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$")


def _assigned_cd_dirs(segments):
    """Samu 69648 (3a): `D=dir; cd $D` (also `export D=dir`): the literal dirs the command itself assigns to a cd's
    variable, handed on as more cd words. The `cd $D` stays undecidable too; a VAR set only outside is not resolved."""
    vars_, out = {}, []
    for toks in segments:
        assigns = toks[1:] if toks and toks[0] == "export" else toks
        if assigns and all(_ENV_ASSIGN.match(t) for t in assigns):
            for t in assigns:
                name, v = t.split("=", 1)
                if v == "" or _UNDECIDABLE_PATH.search(v):
                    vars_.pop(name, None)
                else:
                    vars_[name] = v
            continue
        for i in range(1, len(toks)):
            prev = toks[i - 1]
            if prev not in ("cd", "pushd") and not (prev == "--" and i >= 2 and toks[i - 2] in ("cd", "pushd")):
                continue
            m = _VAR_REF.match(toks[i])
            v = vars_.get(m.group(1) or m.group(2)) if m else None
            if v is not None:
                out.append(v)
    return out


def _py_isolated(rest) -> bool:
    """The interpreter options before the script turn off every start-up code path: -I with -S (`-I -S`, `-IS`,
    `-SI`), or -E with -s and -S. A joined -X / -W value and anything after a -c / -m letter is not an option letter."""
    letters = set()
    i = 0
    while i < len(rest):
        t = rest[i]
        if t in _PY_OPT_WITH_ARG:
            i += 2
            continue
        if t == "-" or t == "--" or not t.startswith("-") or t.startswith("--"):
            if t.startswith("--") and t != "--":
                i += 1
                continue
            break
        for ch in t[1:]:
            if ch in "cmXW":
                break
            letters.add(ch)
        if re.search(r"[cm]", t[1:]):
            break
        i += 1
    return ("I" in letters and "S" in letters) or {"E", "s", "S"} <= letters


# Bence 69412 / Samu 69415: the walk is only meaningful for the real interpreter. A program merely NAMED python3 (an
# absolute or relative path, a PATH change in the command, a shell function, alias or hash entry of that name) is
# whatever it is, so the address rule holds for it. Accepted: a bare python/python3[.x] with no such change, or an
# absolute path in a system bin directory. Stated limit: a PATH or alias set in a shell profile, and a same-named
# program put into a writable system bin directory, are not visible in the command.
_PY_BARE_INTERPRETER = re.compile(r"^python(?:3(?:\.\d+)?)?$")
_PY_SYSTEM_INTERPRETER = re.compile(r"^/(?:usr/bin|usr/local/bin|opt/homebrew/bin)/python(?:3(?:\.\d+)?)?$")
_PY_NAME_REBOUND = re.compile(r"\bpython[\w.]*\s*\(\s*\)|\bfunction\s+python|\balias\b|\bhash\b|\benable\b")
# The tokenizer splits `python3() { ...; }` at the parentheses, so a function definition is found on the raw
# command and handed on as this marker word.
_PY_FUNC_DEF_RAW = re.compile(r"\bpython[\w.]*\s*\(\s*\)|\bfunction\s+python")
_PY_REBOUND_MARK = "__python_name_rebound__"


def _py_interpreter_is_real(prog_word, cmd_words) -> bool:
    # a PATH change anywhere in the command (a prefix, export, env PATH=, PATH+=), or env -P (macOS: another search path)
    if any(re.match(r"^PATH\+?=", w) for w in cmd_words):
        return False
    if "env" in cmd_words and any(w.startswith("-P") for w in cmd_words):
        return False
    if _PY_REBOUND_MARK in cmd_words or _PY_NAME_REBOUND.search(" ".join(cmd_words)):
        return False
    return bool(_PY_BARE_INTERPRETER.match(prog_word) or _PY_SYSTEM_INTERPRETER.match(prog_word))


def _address_run_judgeable(rest, module, script, cwd, cmd_words, prog_word="python3") -> bool:
    """A python run with an address may be judged by its script's content (the walk) only in these shapes."""
    return not (module or script is None or _UNDECIDABLE_PATH.search(script)
                or _relative_under_undecidable_cd(script, cwd, cmd_words)
                or any(re.match(r"^PYTHON\w*=", w) for w in cmd_words)
                or not _py_isolated(rest)
                or not _py_interpreter_is_real(prog_word, cmd_words))


def draft_isolation_hint(cmd: str, cwd, read_script=None) -> bool:
    """True when a python run with an address is a send only because the interpreter was not isolated: run with -I -S
    it would be judged by its content, and its script walks clean (the approval gate names the fix then)."""
    if read_script is None:
        read_script = _read_script_head
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        return False
    cmd_words = [w for toks in segments for w in toks] + ([_PY_REBOUND_MARK] if _PY_FUNC_DEF_RAW.search(cmd) else [])
    for toks in segments:
        for h in _command_heads(toks):
            if not h or not _PYTHON.match(_basename(h[0])):
                continue
            rest = h[1:]
            if not _address_flag_given(rest) or _py_isolated(rest):
                continue
            module = _python_module(rest)
            script = None if module else _python_script_operand(rest)[0]
            if not _address_run_judgeable(["-I", "-S"] + list(rest), module, script, cwd, cmd_words, h[0]):
                continue
            if not _py_address_run_sends(_resolve_script_paths(script, cwd, cmd_words), read_script):
                return True
    return False


# ISSUE2582 (A): `D=/x; python3 $D/a.py` -- a variable the command itself sets to a literal. The script path was
# undecidable, so on this gate every such run asked for an approval (10 harmless calls a day in the reporter's fleet).
# _bind_literal_vars puts the value in place of `$D` / `${D}` on the RAW command, before anything else reads it, and
# ONLY where the value at run time is certain. Anything it cannot prove keeps the variable, i.e. today's fail-closed
# verdict. The proof, all of it required:
#   - the assignment is a segment of its own (`D=v`, `export D=v`), at depth 0, run unconditionally (at the start or
#     after `;` / a newline) or in a pure `&&` chain that reaches the use; its own end is `;`, a newline, `&&`, `||` or
#     the end (a `|` or `&` puts it in a subshell, and a subshell's assignment is lost);
#   - the value is a plain literal (no `$`, backtick, quote, glob or white space);
#   - Dani (review of #2586): the NAME appears NOWHERE in the command (outside the heredoc bodies, quoted text included)
#     but in that one assignment and in plain `$D` / `${D}` uses. Every other way to set it names it: a second or a
#     prefix assignment, `D+=`, `D[i]=`, `for D`, `read D`, `printf -v D` (also after `builtin`), zsh `print -v D`,
#     `exec {D}>`, `${D::=x}` / `${D:=x}`, `unset D`, `typeset D`, a function body, a trap string;
#   - the assignment stands outside every block (if / while / until / for / select / case / `{`: a block may not run);
#   - no eval, source / `.`, alias, autoload or trap in command position (also after command / builtin / exec /
#     noglob / nocorrect / `-`): those run code the command does not show; and no IFS anywhere (no binding at all);
#   - the use comes AFTER the assignment and is a plain `$D` / `${D}`, unquoted or double-quoted, and is not followed
#     by `:`, `[` or `(` (zsh reads `$D:h` as a modifier and `$D[1]` as a subscript); `'$D'` and `\$D` are the
#     literal text, `${D%x}` and the like are not filled in;
#   - a `cd $D` / `pushd $D` word is left alone (_assigned_cd_dirs has its own, older rule for it).
# Heredoc bodies are not touched (B below judges a body only when the shell does not expand it). The JS twin
# (email-send-gate.mjs :: bindLiteralVars) does the same; script-run-cases.json binds the two.
# Samu 72415 (measured on 7 days of the fleet's sub-agent calls): a `for` anywhere switched the binding off, and
# `S=/x; for id in ...; do python3 $S/close.py $id; done` was 509 of the 635 calls the tightening would newly deny.
# A block keyword now only opens / closes a block (an assignment inside one does not bind).
_BIND_GLOBAL_BLOCK = frozenset(("eval", "source", ".", "alias", "autoload", "trap"))
_BIND_PRECMD = frozenset(("command", "builtin", "exec", "noglob", "nocorrect", "-", "nohup", "nice", "time"))
_BIND_OPEN = frozenset(("if", "while", "until", "case", "{", "for", "select"))
_BIND_CLOSE = frozenset(("fi", "done", "esac", "}"))
_BIND_LEAD = frozenset(("then", "do", "else", "elif", "!", "time"))
_BIND_NAME = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")
_BIND_LITERAL = re.compile(r"""^[^\s$`'"()|;&<>*?\[\]{}\\!~#]+$""")
_BIND_ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z_0-9]*)(\[[^\]]*\])?(\+?)=")


def _heredoc_body_spans(cmd: str):
    """The (start, end) of every heredoc body in `cmd` (the text between the opener line and the closing tag)."""
    return [(m.end(1) + 1, m.end() - len(m.group(2))) for m in _HEREDOC.finditer(cmd)]


def _bind_scan(cmd: str):
    """Segments of the raw command: a list of dicts {words, sep_before, sep_after, depth}. A word is a dict
    {text (unquoted), quoted, escaped, refs [(name, start, end)], start}; a ref is an unquoted or double-quoted
    `$NAME` / `${NAME}`. Returns None when the command cannot be read."""
    spans = _heredoc_body_spans(cmd)
    segs = []
    cur = {"words": [], "sep_before": None, "depth": 0}
    word = None
    depth = 0
    stack = []  # "s" for $( , "p" for ( , "b" for a backtick
    q = None
    i, n = 0, len(cmd)

    def new_word(pos):
        return {"text": "", "quoted": False, "escaped": False, "refs": [], "start": pos}

    def end_word():
        nonlocal word
        if word is not None:
            cur["words"].append(word)
            word = None

    def end_seg(sep):
        nonlocal cur
        end_word()
        cur["sep_after"] = sep
        if cur["words"]:
            segs.append(cur)
        elif segs and sep is not None:
            pass
        cur = {"words": [], "sep_before": sep, "depth": depth}

    while i < n:
        skip = next((e for s, e in spans if s == i), None)
        if skip is not None:
            i = skip  # a heredoc body: data, not shell
            continue
        ch = cmd[i]
        if q == "'":
            if ch == "'":
                q = None
            else:
                word["text"] += ch  # a single-quoted `$D` is the literal text: no ref is recorded, nothing is filled in
            i += 1
            continue
        if ch == "\\" and i + 1 < n:  # an escaped `\$D` is literal text too: no ref
            if word is None:
                word = new_word(i)
            word["escaped"] = True  # inside "..." a backslash may stay: the value is not certain, never bound
            word["text"] += cmd[i + 1]
            i += 2
            continue
        if ch == "$" and (i + 1 < n) and (cmd[i + 1] == "{" or _BIND_NAME.match(cmd, i + 1)):
            if word is None:
                word = new_word(i)
            if cmd[i + 1] == "{":
                m = _BIND_NAME.match(cmd, i + 2)
                if m and m.end() < n and cmd[m.end()] == "}":
                    if not (m.end() + 1 < n and cmd[m.end() + 1] in ":[("):  # zsh modifier / subscript: not plain
                        word["refs"].append((m.group(0), i, m.end() + 1))
                    word["text"] += cmd[i:m.end() + 1]
                    i = m.end() + 1
                    continue
                word["text"] += ch  # ${D%x}, ${D:-x}, ...: not filled in (and ${D=x} cannot change a D set before)
                i += 1
                continue
            m = _BIND_NAME.match(cmd, i + 1)
            if not (m.end() < n and cmd[m.end()] in ":[("):  # zsh `$D:h` modifier, `$D[1]` subscript: not plain
                word["refs"].append((m.group(0), i, m.end()))
            word["text"] += cmd[i:m.end()]
            i = m.end()
            continue
        if q == '"':
            if ch == '"':
                q = None
            elif ch == "`" or (ch == "$" and cmd.startswith("$(", i)):
                end = _subst_end(cmd, i)
                if end < 0:
                    return None  # an unclosed substitution: not read here
                # a quoted "$(...)" runs in a subshell: nothing in it is filled in (a name in it is one more
                # occurrence, so that name is never bound)
                word["text"] += cmd[i:end]
                i = end
                continue
            else:
                word["text"] += ch
            i += 1
            continue
        if ch in "'\"":
            if word is None:
                word = new_word(i)
            word["quoted"] = True
            q = ch
            i += 1
            continue
        if ch == "#" and word is None:
            while i < n and cmd[i] != "\n":
                i += 1
            continue
        if ch in " \t":
            end_word()
            i += 1
            continue
        if ch == "\n" or ch == ";":
            end_seg(";")
            i += 1
            continue
        if ch == "`":
            if stack and stack[-1] == "b":
                stack.pop()
            else:
                stack.append("b")
            depth = len(stack)
            end_seg("(")
            i += 1
            continue
        if cmd.startswith("$(", i):
            stack.append("s")
            depth = len(stack)
            end_seg("(")
            i += 2
            continue
        if ch == "(":
            stack.append("p")
            depth = len(stack)
            end_seg("(")
            i += 1
            continue
        if ch == ")":
            if stack:
                stack.pop()
            depth = len(stack)
            end_seg(")")
            i += 1
            continue
        if ch in "&|":
            prev = cmd[i - 1] if i else ""
            nxt = cmd[i + 1] if i + 1 < n else ""
            if ch == "&" and (prev in "<>" or nxt == ">"):
                if word is None:
                    word = new_word(i)
                word["text"] += ch  # a redirect (2>&1, &>), not a background run
                i += 1
                continue
            if ch == "|" and prev == ">":
                word["text"] += ch  # >| is a redirect
                i += 1
                continue
            if cmd.startswith("&&", i) or cmd.startswith("||", i):
                end_seg(cmd[i:i + 2])
                i += 2
                continue
            end_seg("|&" if cmd.startswith("|&", i) else ch)
            i += 2 if cmd.startswith("|&", i) else 1
            continue
        if word is None:
            word = new_word(i)
        word["text"] += ch
        i += 1
    if q:
        return None
    end_seg(None)
    return segs


def _subst_end(cmd: str, i: int) -> int:
    """The index just past the `$(...)` or backtick substitution that starts at i (inside double quotes), else -1."""
    if cmd[i] == "`":
        j = i + 1
        while j < len(cmd):
            if cmd[j] == "\\":
                j += 2
                continue
            if cmd[j] == "`":
                return j + 1
            j += 1
        return -1
    depth, j, q = 0, i + 1, None
    while j < len(cmd):
        c = cmd[j]
        if q:
            if c == "\\" and q == '"':
                j += 2
                continue
            if c == q:
                q = None
        elif c == "\\":
            j += 2
            continue
        elif c in "'\"":
            q = c
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    return -1


def _bind_literal_vars(cmd: str) -> str:
    """ISSUE2582 (A): see the note above. Returns `cmd` with the provable uses of literal variables filled in."""
    if "$" not in cmd or "=" not in cmd:
        return cmd
    scanned = _bind_scan(cmd)
    if scanned is None:
        return cmd
    segs = scanned
    outside = _outside_bodies(cmd, 0, len(cmd))
    if re.search(r"(?<![A-Za-z0-9_])IFS(?![A-Za-z0-9_])", outside):
        return cmd
    block = 0  # how many blocks are open at the segment
    for seg in segs:
        words = seg["words"]
        k = 0
        while k < len(words) and not words[k]["quoted"]:
            t = words[k]["text"]
            if t in _BIND_OPEN:
                block += 1
                if t in ("for", "select", "case"):
                    k = len(words)  # the rest is the word list / the case word, not a command
                    break
                k += 1
                continue
            if t in _BIND_CLOSE:
                block = max(0, block - 1)
                k += 1
                continue
            if t in _BIND_LEAD:
                k += 1
                continue
            break
        seg["block"] = block  # eval / source / `.` ... in command position: _bound_is_plain, quoted or not
    ref_count = {}
    for seg in segs:
        for w in seg["words"]:
            for name, _s, _e in w["refs"]:
                ref_count[name] = ref_count.get(name, 0) + 1
    binds = {}  # name -> (segment index, value, conditional)
    for idx, seg in enumerate(segs):
        words = seg["words"]
        assigns = words[1:] if words and words[0]["text"] == "export" and not words[0]["quoted"] else words
        if not assigns or not all(_BIND_ASSIGN.match(w["text"]) for w in assigns):
            continue
        if seg["depth"] != 0 or seg["block"] != 0 or seg["sep_after"] not in (None, ";", "&&", "||"):
            continue
        if seg["sep_before"] in (None, ";"):
            conditional = False
        elif seg["sep_before"] == "&&":
            conditional = True
        else:
            continue
        for w in assigns:
            name, value = w["text"].split("=", 1)
            if w["escaped"] or not _BIND_LITERAL.match(value) or name == "IFS":
                continue
            occurrences = len(re.findall(r"(?<![A-Za-z0-9_])" + re.escape(name) + r"(?![A-Za-z0-9_])", outside))
            if occurrences != 1 + ref_count.get(name, 0):
                continue  # the name is named somewhere else: it may be set another way
            binds[name] = (idx, value, conditional)
    if not binds:
        return cmd
    edits = []
    for idx, seg in enumerate(segs):
        words = seg["words"]
        for k, w in enumerate(words):
            prev = words[k - 1]["text"] if k else None
            prev2 = words[k - 2]["text"] if k > 1 else None
            if prev in ("cd", "pushd") or (prev == "--" and prev2 in ("cd", "pushd")):
                continue
            for name, start, end in w["refs"]:
                b = binds.get(name)
                if b is None or idx <= b[0]:
                    continue
                if b[2] and any(segs[j]["sep_after"] != "&&" for j in range(b[0], idx)):
                    continue
                edits.append((start, end, b[1], name))
    bound = cmd
    for start, end, value, _name in sorted(edits, reverse=True):
        bound = bound[:start] + value + bound[end:]
    # in the bound command each bound name stands once (its assignment) plus its uses left as they were: a filled-in
    # value that spells a bound name (`export "$A$B"=x` -> `export "SD"=x`) is one more assignment
    expected = {n: 1 + ref_count.get(n, 0) - sum(1 for e in edits if e[3] == n) for n in binds}
    return bound if _bound_is_plain(bound, expected) else cmd


# Dani (review of #2586, the computed name): the name rule only sees a name WRITTEN in the command; a setter can build it
# (`A=S; B=D; printf -v "$A$B" ...`, `unset "$A$B"`, `$((A$B=1))`, `${(P)X::=...}`, `x[$A$B=1]`, `[[ 1 -eq $A$B=1 ]]`), or
# hide behind a dynamic or quoted command name (`C=printf; $C -v ...`, `"printf" -v ...`). So the BOUND command (every
# provable use filled in) is read once more, and any of these anywhere keeps today's verdict for the whole command:
#   - a variable-setting builtin as a word anywhere (quoted or not): read, declare, typeset, local, readonly, mapfile,
#     readarray, getopts, let, unset, vared, zparseopts, zstyle, integer, float, and export unless its segment is the
#     plain `export NAME=literal` form; printf / print with a -v word in the same segment; set -A / +A;
#   - eval / source / `.` / alias / autoload / trap as a command, quoted or not, also behind command / builtin / exec;
#   - a command word (after keywords, assignments and command / builtin / exec ...) that still holds a `$` or backtick;
#   - `((`, `$[`, a `${` with `=` inside, a `$NAME[` / `${NAME[` subscript, or `[[` with an arithmetic comparison.
_BIND_SETTERS = frozenset(("read", "declare", "typeset", "local", "readonly", "mapfile", "readarray", "getopts", "let",
                           "unset", "vared", "zparseopts", "zstyle", "integer", "float"))
_BIND_DYNAMIC_TEXT = re.compile(r"\(\(|\$\[|\$\{[^}]*=|\$\{?[A-Za-z_][A-Za-z_0-9]*\[")
_BIND_ARITH_TEST = re.compile(r"-(?:eq|ne|lt|le|gt|ge)\b")


def _bound_is_plain(bound: str, expected=None) -> bool:
    outside = _outside_bodies(bound, 0, len(bound))
    for name, count in (expected or {}).items():
        if len(re.findall(r"(?<![A-Za-z0-9_])" + re.escape(name) + r"(?![A-Za-z0-9_])", outside)) != count:
            return False
    if _BIND_DYNAMIC_TEXT.search(outside):
        return False
    if "[[" in outside and _BIND_ARITH_TEST.search(outside):
        return False
    segs = _bind_scan(bound)
    if segs is None:
        return False
    for seg in segs:
        words = seg["words"]
        texts = [w["text"] for w in words]
        for i, t in enumerate(texts):
            if t in _BIND_SETTERS:
                return False
            if t == "export" and not all(_BIND_ASSIGN.match(x) for x in texts[i + 1:]):
                return False
            if t in ("printf", "print") and any(x.startswith("-v") for x in texts[i + 1:]):
                return False
            if t == "set" and any(x.startswith(("-A", "+A")) for x in texts[i + 1:]):
                return False
        k = 0
        while k < len(words) and (words[k]["text"] in _BIND_OPEN or words[k]["text"] in _BIND_CLOSE
                                  or words[k]["text"] in _BIND_LEAD):
            if words[k]["text"] in ("for", "select", "case"):
                k = len(words)
                break
            k += 1
        while k < len(words) and _BIND_ASSIGN.match(words[k]["text"]):
            k += 1
        while k < len(words) and words[k]["text"] in _BIND_PRECMD:
            k += 1
        if k < len(words):
            head = words[k]
            if head["text"] in _BIND_GLOBAL_BLOCK or head["refs"] or "$" in head["text"] or "`" in head["text"]:
                return False
    return True


# ISSUE2582 (B): `cat > /x/new.py <<'EOF' ... EOF` and then `python3 /x/new.py` in the same command. The file does not
# exist yet when the gate runs, and a missing script is a send on this gate (JSCDSEND1104). The script that runs is the
# heredoc body, so the body is what is judged -- with the same reader as a file on disk, local imports included. Only
# when the body is certainly what the file holds at run time:
#   - the opener is exactly `cat > P <<TAG`, `cat <<TAG > P` or `tee P <<TAG` (optionally `> /dev/null` after tee),
#     at the start of its line or after a quote-free `...;` (the `;` makes the write unconditional), nothing after it:
#     a `>>` / `tee -a` appends, so the old content would run too;
#   - the tag is quoted (`<<'EOF'`) or the body has no `$` and no backtick (an unquoted body is expanded by the shell);
#   - P is absolute after (A), or relative in a command with no cd / pushd / env -C;
#   - Dani (review of #2586): the write must HAPPEN. Before it only commands that cannot create P without naming it
#     (mkdir, echo, printf, true, :, test, [, sleep, date, pwd, ls, cd, pushd, rm, cat, tee, export, set, and
#     assignments): an unzip, git, cp -r or any program could leave P there, read-only, and the write would fail; a
#     control word before it (if, while, do, `{`, ...) is no such command either, so a conditional write is out. And P
#     must not exist when the gate runs: if it does, the body AND the file on disk are judged, and either one sending is
#     a send. That also covers noclobber (set -C, setopt noclobber): it only stops the write over an EXISTING P;
#   - P is named exactly twice in the command: the write and one run. Another write, a cp, mv or sed -i on it, or a
#     second run would change what runs, so they keep today's verdict.
# Every other case reads the disk as before (and a missing file stays fail-closed).
_WRITTEN_OPENER = re.compile(
    r"""^(?P<pre>[^\n'"`\\]*;[ \t]*)?[ \t]*(?:cat[ \t]+>[ \t]*(?P<p1>[^\s'"<>;&|$`]+)[ \t]+<<-?[ \t]*(?P<q1>'?)(?P<t1>\w+)(?P=q1)"""
    r"""|cat[ \t]+<<-?[ \t]*(?P<q2>'?)(?P<t2>\w+)(?P=q2)[ \t]+>[ \t]*(?P<p2>[^\s'"<>;&|$`]+)"""
    r"""|tee[ \t]+(?P<p3>[^\s'"<>;&|$`-][^\s'"<>;&|$`]*)(?:[ \t]+>[ \t]*/dev/null)?[ \t]+<<-?[ \t]*(?P<q3>'?)(?P<t3>\w+)(?P=q3)"""
    r""")[ \t]*$""")


_WRITTEN_SAFE_BEFORE = frozenset(("mkdir", "echo", "printf", "true", ":", "test", "[", "sleep", "date", "pwd", "ls", "cd",
                                  "pushd", "rm", "cat", "tee", "export", "set"))


def _written_safe_before(text: str) -> bool:
    """Every command in `text` (what runs before the write) is one that cannot create a file without naming it."""
    try:
        segments = _segments_tokens(text)
    except ValueError:
        return False
    for toks in segments:
        head = next((t for t in toks if not _ENV_ASSIGN.match(t)), None)
        if head is not None and head not in _WRITTEN_SAFE_BEFORE:
            return False
    return True




def _written_scripts(cmd: str, cwd):
    """ISSUE2582 (B): {absolute path: heredoc body} for the scripts this command writes and then runs (see above)."""
    out = {}
    has_cd = bool(re.search(r"(?:^|[\s;&|(])(?:cd|pushd)(?:\s|$)|(?:^|[\s;&|(])(?:g?env)\s[^\n]*(?:-C|--chdir)", cmd))
    for m in _HEREDOC.finditer(cmd):
        line_start = cmd.rfind("\n", 0, m.start()) + 1
        opener = cmd[line_start:m.end(1)]
        w = _WRITTEN_OPENER.match(opener)
        if not w:
            continue
        path = w.group("p1") or w.group("p2") or w.group("p3")
        quoted = bool(w.group("q1") or w.group("q2") or w.group("q3"))
        body = cmd[m.end(1) + 1:m.end() - len(m.group(2))]
        if not quoted and ("$" in body or "`" in body):
            continue
        if os.path.isabs(path):
            ab = os.path.normpath(path)
        elif not has_cd and isinstance(cwd, str) and os.path.isabs(cwd):
            ab = os.path.normpath(os.path.join(cwd, path))
        else:
            continue
        # the write runs unconditionally: the line before does not continue into it (&&, ||, |, a backslash)
        if re.search(r"(?:&&|\|\||\||\\)\s*$", cmd[:line_start]):
            continue
        # nothing before the write can have left P there unnamed (so the write does not fail on it)
        if not _written_safe_before(_outside_bodies(cmd, 0, line_start) + (w.group("pre") or "")):
            continue
        # counted by the FILE NAME, so `./x.py`, `$D/x.py` and `/abs/x.py` are all mentions of x.py
        mention = re.compile(r"(?<![\w.-])" + re.escape(os.path.basename(path)) + r"(?![\w.-])")
        before = _outside_bodies(cmd, 0, line_start)
        after = _outside_bodies(cmd, m.end() - len(m.group(2)), len(cmd))
        if (mention.search(before) or len(mention.findall(opener)) != 1 or len(mention.findall(after)) != 1
                or ab in out):
            out.pop(ab, None)
            continue
        out[ab] = body
    return out


def _outside_bodies(cmd: str, lo: int, hi: int) -> str:
    """cmd[lo:hi] with every heredoc body cut out (a body is data: a path named there is no shell word)."""
    out, pos = [], lo
    for s, e in _heredoc_body_spans(cmd):
        if e <= lo or s >= hi:
            continue
        out.append(cmd[pos:max(s, lo)])
        pos = min(e, hi)
    out.append(cmd[pos:hi])
    return "".join(out)


def script_run_sends(cmd: str, cwd, read_script=None, depth: int = 0, _cd_words=()) -> bool:
    if read_script is None:
        read_script = _read_script_head
    cmd = _bind_literal_vars(cmd)
    written = _written_scripts(cmd, cwd)
    # Dani (review of #2586): a P that exists now may survive the write (read-only, noclobber set elsewhere): its body
    # is judged NEXT TO the file on disk (which the normal reading below judges), and a sending body is a send
    for path, body in [(p, b) for p, b in written.items() if os.path.lexists(p)]:
        kind = _shebang_kind(body[:_SHEBANG_READ_LIMIT]) or (
            "py" if path.endswith(".py") else "node" if _SCRIPT_FILE.search(path) else None)
        if kind and _judge_candidates(
                [path], kind, lambda q, lim, _p=path, _b=body: _b[:lim] if os.path.normpath(q) == _p
                else read_script(q, lim))[1]:
            return True
    written = {p: b for p, b in written.items() if not os.path.lexists(p)}
    if written:
        disk_read = read_script

        def read_script(path, limit=_SCRIPT_READ_LIMIT):  # noqa: F811 -- ISSUE2582 (B): the written body wins
            body = written.get(os.path.normpath(path)) if isinstance(path, str) else None
            return body[:limit] if body is not None else disk_read(path, limit)
    cmd = _resolve_deterministic_subst(cmd, cwd)
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        return False  # unparseable: is_send_invocation's legacy fallback already judged it
    cmd_words = _with_env_chdir(list(_cd_words) + [w for toks in segments for w in toks])
    for d in _assigned_cd_dirs(segments):
        cmd_words += ["cd", d]
    if _SUBST_CD.search(cmd):
        cmd_words += ["cd", _SUBST_MARK]
    if _PY_FUNC_DEF_RAW.search(cmd):
        cmd_words.append(_PY_REBOUND_MARK)
    return any(_head_runs_sender_script(h, cwd, read_script, depth, cmd_words)
               for toks in segments for h in _command_heads(toks))


# --- Hungarian detection (accent-insensitive markers) -----------------------
# These fire on both the correct and the stripped spelling, so a transliterated
# mail is still recognised as Hungarian -- that is the whole point.
HU_MARKERS = [
    "hogy", "nem", "vagy", "amit", "ami", "mert", "ezt", "ez a", "van", "lesz",
    "kell", "tehat", "tehát", "koszonom", "köszönöm", "szia", "sziasztok",
    "kerlek", "kérlek", "csatolva", "udvozlettel", "üdvözlettel", "levelet",
    "kuldom", "küldöm", "jelezz", "irj", "írj", "mar", "már", "csak",
]
# A puszta "level" 2026-08-26-an kikerult a markerek kozul. Magyar markerkent
# gyenge (a gyakori alak a "levelet", az mar bent van), viszont az ANGOL "level"
# minden elofordulasa magyar-pontot adott egy angol szovegnek, es igy indithatta
# el az ekezet-vizsgalatot olyan uzeneten, ami nem is magyar.

# Accentless spellings of frequent Hungarian words -> the correct form. Every
# entry is a word that CANNOT be spelled without its accent, so a hit inside
# Hungarian text is an error, not a style choice.
ACCENTLESS = {
    "es": "és", "tehat": "tehát", "koszonom": "köszönöm", "koszi": "köszi",
    "koszonjuk": "köszönjük", "kerlek": "kérlek", "kerem": "kérem",
    "kerjuk": "kérjük", "kerdes": "kérdés", "kerdesem": "kérdésem",
    "valasz": "válasz", "valaszt": "választ", "valaszol": "válaszol",
    # "levelet" NEM tartozik ide (2026-08-11, hamis pozitiv eles levelen):
    # a szotar invarianca az, hogy minden bejegyzes olyan szo, amit ekezet
    # NELKUL nem lehet leirni. A "levelet" (levél -> levelet) pont ilyen helyes
    # alak, ezert onmagara mutato bejegyzeskent allt itt, es minden korrekt
    # magyar levelet megblokkolt "levelet -> levelet" javaslattal. A "levelét"
    # (birtokos) ekezetlen alakja EGYBEESIK vele, tehat szabalykent nem is
    # eldontheto -- ezt a kapu nem tudja megfogni, es nem is szabad neki.
    "level": "levél", "levelre": "levélre",
    "elore": "előre", "elott": "előtt", "utan": "után", "kozott": "között",
    "kesz": "kész", "keszult": "készült", "keszen": "készen",
    "ervenyes": "érvényes", "ervenytelen": "érvénytelen",
    "telepito": "telepítő", "telepites": "telepítés", "telepiteni": "telepíteni",
    "ujra": "újra", "uj": "új", "ujat": "újat", "igy": "így", "ugy": "úgy",
    "tobb": "több", "tobbi": "többi", "kulon": "külön", "kuldom": "küldöm",
    "kuldtem": "küldtem", "kuldes": "küldés", "kuldunk": "küldünk",
    "fajl": "fájl", "fajlt": "fájlt", "fajlok": "fájlok",
    "hatarido": "határidő", "hataridot": "határidőt",
    "lehetoseg": "lehetőség", "lehetoseget": "lehetőséget",
    "szukseges": "szükséges", "szuksege": "szüksége",
    "mukodik": "működik", "mukodes": "működés", "muszaki": "műszaki",
    "beallitas": "beállítás", "beallitani": "beállítani",
    "elofizetes": "előfizetés", "elofizetest": "előfizetést",
    "szamla": "számla", "szamlat": "számlát", "szamlazas": "számlázás",
    "arajanlat": "árajánlat", "ar": "ár", "arak": "árak",
    "ora": "óra", "orakor": "órakor", "ev": "év", "evi": "évi",
    "honap": "hónap", "het": "hét", "hetfo": "hétfő", "csutortok": "csütörtök",
    "pentek": "péntek", "januar": "január", "februar": "február",
    "marcius": "március", "aprilis": "április", "majus": "május",
    "junius": "június", "julius": "július", "oktober": "október",
    "ket": "két", "harom": "három", "negy": "négy", "ot": "öt",
    "szivesen": "szívesen", "erteket": "értéket", "ertem": "értem",
    "jol": "jól", "rovid": "rövid", "hosszu": "hosszú", "biztonsagos": "biztonságos",
    # "megnyitni" ugyanaz a hibaosztaly, mint a fenti "levelet": onmagara mutato
    # bejegyzes egy olyan szonal, ami ekezet nelkul is helyes. Kiveve 2026-08-11,
    # MIELOTT eles levelen elsult volna.
    "eleresi": "elérési", "elerheto": "elérhető",
    "sajat": "saját", "tovabbi": "további", "tovabb": "tovább",
    "figyelmeztetes": "figyelmeztetés", "ellenorizd": "ellenőrizd",
    "ellenorzes": "ellenőrzés", "reszletek": "részletek", "resz": "rész",
    "vegen": "végén", "vegre": "végre", "elinditja": "elindítja",
    "inditas": "indítás", "masold": "másold", "masolat": "másolat",
    "gepre": "gépre", "gep": "gép", "gepen": "gépen",
    "ervenyesites": "érvényesítés", "aktivalas": "aktiválás",
    "hozzajarulas": "hozzájárulás", "elofordul": "előfordul",
    # +48 bejegyzes 2026-08-13 (EKEZETLISTA812, Szabi GO: "Vedd"). A jeloltek a
    # sajat magyar szovegeinkbol jottek (69 fajl, 60 gyakori ekezetes szo, amit a
    # lista addig nem fogott); a szures KET lepcsos volt: lokalis modell (Muse
    # Glimmer 30B) itelete + sajat felulvizsgalat. SZANDEKOSAN KIMARADT, mert az
    # ekezetlen alak onmagaban is letezo magyar szo: mar (marni), meg (igekoto),
    # kor (eletkor/korszak), fonok (fonni), var (a seb varja), kod (kod ES kod),
    # hozza, meres, lepes, szamlazz, jon, tovabbra. Az "all" -> "áll" TUDATOS
    # kivetel: nem magyar szo, de gyakori ANGOL szo; a kapu csak magyarnak mert
    # szovegen fut, ezert Szabi vallalta a kockazatot.
    "elso": "első", "ezert": "ezért", "valodi": "valódi",
    "nelkul": "nélkül", "miert": "miért", "utana": "utána",
    "kovetkezo": "következő", "szekcio": "szekció", "tenyleg": "tényleg",
    "videot": "videót", "video": "videó", "azert": "azért",
    "hivas": "hívás", "szam": "szám", "szoveg": "szöveg",
    "mas": "más", "kulso": "külső", "dontes": "döntés",
    "letezik": "létezik", "kozvetlenul": "közvetlenül", "felhasznalo": "felhasználó",
    "nema": "néma", "verzio": "verzió", "erdemes": "érdemes",
    "irja": "írja", "mostantol": "mostantól", "latszik": "látszik",
    "szoval": "szóval", "kozos": "közös", "netto": "nettó",
    "cim": "cím", "futo": "futó", "javitas": "javítás",
    "kockazat": "kockázat", "ebbol": "ebből", "mindket": "mindkét",
    "eleg": "elég", "regi": "régi", "kulonbozo": "különböző",
    "kezzel": "kézzel", "peldaul": "például", "izolalt": "izolált",
    "kozben": "közben", "udvozlettel": "üdvözlettel", "oket": "őket",
    "afa": "áfa", "allapot": "állapot", "all": "áll",
    # EKEZET1018 (2026-10-18): +476 entries. The candidates are accented word forms collected from a live
    # install's own correctly accented Hungarian customer-facing copy (web pages, ad and post texts), after
    # stripping code, paths and hyphenated identifiers. The trigger: short accentless messages ('unnepek', 'lakas',
    # 'haloszoba', 'padlofutes', 'kulcsszef') went through the gate. Each key went through the filters below and a
    # manual review (three review rounds). LEFT OUT, with the reason:
    #   automatically: accentless forms of <= 3 letters (meg, kor, kod, var, fel, jo, mar, ...: too many homonyms),
    #   forms that are also words in correctly accented Hungarian prose (helyen), English words (panorama), and
    #   everything that was already in the dictionary;
    #   by manual judgement, because the accentless form is ANOTHER real Hungarian word: mert, mertek, mertem,
    #   merve, merne, merni, meri (merni = 'dare'), akar, kapna, kapcsolhatok, agyak, aggyal, varja, fele, teli,
    #   termek, hajra, deli, tora, futott (fut), mentes ('free of'), tartalmat (accusative of tartalom, the same
    #   class as 'levelet'), tartsatok (imperative), tarolunk (tarol is a verb), and instrumental -nal/-nel forms
    #   of place names; frequent English / international forms: dont, fore, datum, foto, hatter; proper names and
    #   place names in general (this dictionary holds no proper names).
    # Where the accentless form can stand for two correct forms, both are suggested (kornyeken, szoveget, ertek,
    # meglevo, szallashelyen, ...), and where the spelling rules require two words, that form is named first
    # (ujepitesu -> 'új építésű', nyitvatartast -> 'nyitva tartást'; AkH12).
    "ablakaba": "ablakába", "adataibol": "adataiból", "adatfeldolgozokent": "adatfeldolgozóként",
    "adatkezelesi": "adatkezelési", "adatkezelo": "adatkezelő", "adatkezeloje": "adatkezelője",
    "adatvedelmi": "adatvédelmi", "adozasi": "adózási", "ajanlat": "ajánlat",
    "ajanlatot": "ajánlatot", "alakjaban": "alakjában", "alapjan": "alapján", "alapveto": "alapvető",
    "allitas": "állítás", "allitashoz": "állításhoz", "allithatjatok": "állíthatjátok", "allithato": "állítható",
    "alvohely": "alvóhely", "alvohelyet": "alvóhelyet / alvóhelyét", "apartmantol": "apartmantól", "atjon": "átjön",
    "atment": "átment", "atnezve": "átnézve", "atutalas": "átutalás", "autoval": "autóval", "bajtokra": "bájtokra",
    "bajtra": "bájtra", "bankkartya": "bankkártya",
    "bankkartyas": "bankkártyás", "barki": "bárki", "barmikor": "bármikor", "beallitasok": "beállítások",
    "beallitasokban": "beállításokban", "bejutas": "bejutás", "belul": "belül", "berelt": "bérelt", "betu": "betű",
    "beture": "betűre", "bongeszod": "böngésződ", "bonthato": "bontható", "borvidek": "borvidék",
    "bringaut": "bringaút", "bringaval": "bringával", "cellaba": "cellába", "cimben": "címben",
    "csaladoknak": "családoknak", "csuszda": "csúszda", "datuma": "dátuma", "datumkorlat": "dátumkorlát",
    "datumok": "dátumok", "datumos": "dátumos", "datumot": "dátumot", "datumsor": "dátumsor",
    "dobozaban": "dobozában", "dohanyzas": "dohányzás", "dontese": "döntése", "dontesi": "döntési", "donto": "döntő",
    "edeny": "edény", "egesz": "egész", "egeszeben": "egészében", "egyeb": "egyéb", "egyesevel": "egyesével",
    "egyezest": "egyezést", "egymas": "egymás", "ejes": "éjes", "ejjel": "éjjel", "ejre": "éjre",
    "ejszaka": "éjszaka", "ejszam": "éjszám", "ejszamot": "éjszámot", "ekezet": "ékezet", "ekezetet": "ékezetet / ékezetét",
    "ekezettel": "ékezettel", "elemzese": "elemzése", "elemzesehez": "elemzéséhez", "elerhetoseg": "elérhetőség",
    "elerhetosegek": "elérhetőségek", "elirtuk": "elírtuk", "elkepzelheto": "elképzelhető",
    "ellenorizheted": "ellenőrizheted", "ellenorizve": "ellenőrizve", "ellenorzesek": "ellenőrzések",
    "elmeny": "élmény", "elobb": "előbb", "eloirasoknak": "előírásoknak", "elotte": "előtte", "elotti": "előtti",
    "elsodleges": "elsődleges", "elteres": "eltérés", "elutasitana": "elutasítana", "elutasitasi": "elutasítási",
    "epitesu": "építésű", "erdekeben": "érdekében", "erheto": "érhető", "erhetok": "érhetők", "erkezes": "érkezés",
    "erkezessel": "érkezéssel", "erkezik": "érkezik", "ertek": "érték / értek", "ertekeles": "értékelés",
    "ertekelesek": "értékelések", "eszkozt": "eszközt", "eszkozzel": "eszközzel", "etterem": "étterem",
    "ettol": "ettől", "evszakban": "évszakban", "felbontason": "felbontáson", "felhasznaloi": "felhasználói",
    "felnott": "felnőtt", "feltetelek": "feltételek", "felugyeletevel": "felügyeletével", "felul": "felül",
    "fizetes": "fizetés", "foglalas": "foglalás", "foglalasi": "foglalási", "foglalaskezeles": "foglaláskezelés",
    "foglalasnal": "foglalásnál", "foglalasra": "foglalásra", "foglalast": "foglalást", "foglalhato": "foglalható",
    "foglalo": "foglaló", "foglaloig": "foglalóig", "foldszint": "földszint", "foldszinti": "földszinti",
    "fooldal": "főoldal", "fooldalon": "főoldalon", "fooldalra": "főoldalra", "formatumban": "formátumban",
    "forras": "forrás", "forrashoz": "forráshoz", "forrasukhoz": "forrásukhoz", "foszezonban": "főszezonban",
    "fozolap": "főzőlap", "furdoszoba": "fürdőszoba", "futheto": "fűthető", "fuves": "füves", "graphbol": "graphból",
    "grillezo": "grillező", "grillezohely": "grillezőhely", "gyujtott": "gyűjtött / gyújtott", "hajszarito": "hajszárító",
    "haloban": "hálóban", "haloszoba": "hálószoba", "haloszobaban": "hálószobában", "haloszobaszam": "hálószobaszám",
    "haloszobaval": "hálószobával", "halozat": "hálózat", "hany": "hány", "harmas": "hármas", "hasznal": "használ",
    "hasznalhatjatok": "használhatjátok", "hasznalhatnak": "használhatnak", "hasznalhattok": "használhattok",
    "hasznaljak": "használják / használjak", "hasznaljuk": "használjuk", "hasznalt": "használt",
    "hasznalunk": "használunk", "hatalyos": "hatályos", "hatosag": "hatóság", "hazadat": "házadat / hazádat",
    "helyiseget": "helyiséget / helyiségét", "hetvege": "hétvége", "hetvegek": "hétvégék", "hetvegen": "hétvégén",
    "hetvegere": "hétvégére", "hirdetesbol": "hirdetésből", "hirdetesek": "hirdetések", "hirdetesen": "hirdetésen / hirdetésén",
    "hirdetesszovege": "hirdetésszövege", "hofok": "hőfok", "hofokot": "hőfokot", "homerseklet": "hőmérséklet",
    "homokozo": "homokozó", "honapig": "hónapig", "hoszivattyus": "hőszivattyús", "hoterkepek": "hőtérképek",
    "hozzajarul": "hozzájárul", "hozzajarulasat": "hozzájárulását", "hutes": "hűtés", "hutest": "hűtést",
    "hutheto": "hűthető", "idejeig": "idejéig", "idopontot": "időpontot", "iger": "ígér", "inditasa": "indítása",
    "indulas": "indulás", "informaciok": "információk", "informacioszabadsag": "információszabadság",
    "irhato": "írható", "irjon": "írjon", "irjuk": "írjuk", "jatszoter": "játszótér", "jatszoteret": "játszóteret / játszóterét",
    "jogszabalyi": "jogszabályi", "jogszabalyoknak": "jogszabályoknak", "jonnel": "jönnél",
    "jovahagyas": "jóváhagyás", "jovahagyott": "jóváhagyott", "jutast": "jutást", "kanape": "kanapé",
    "kanapeagy": "kanapéágy", "karacsony": "karácsony", "kartya": "kártya", "kattintassal": "kattintással",
    "kauciot": "kauciót", "kavefozo": "kávéfőző", "kedvezmeny": "kedvezmény", "kenyelmes": "kényelmes",
    "kepek": "képek", "kepen": "képen / képén", "kepernyo": "képernyő", "kepernyoje": "képernyője", "kepre": "képre",
    "kerdesekkel": "kérdésekkel", "kerekparokat": "kerékpárokat", "kerekpartarolo": "kerékpártároló",
    "kerekpartaroloban": "kerékpártárolóban", "keri": "kéri", "kertjeben": "kertjében", "kertjet": "kertjét",
    "kerul": "kerül", "kerunk": "kérünk", "kezeleseben": "kezelésében", "kezeljuk": "kezeljük",
    "kihuzhato": "kihúzható", "kikotoi": "kikötői", "kilato": "kilátó", "kitetel": "kitétel", "kivul": "kívül",
    "kockazatos": "kockázatos", "koddal": "kóddal", "kodjai": "kódjai", "kodot": "kódot / ködöt", "koncepcio": "koncepció",
    "konyhakep": "konyhakép", "konyhas": "konyhás", "konyhaval": "konyhával", "korbekeritve": "körbekerítve",
    "korben": "körben", "korbol": "körből / korból", "korfajl": "körfájl", "korfajlba": "körfájlba",
    "kornyeken": "környéken / környékén", "kornyezetben": "környezetben", "korul": "körül",
    "kotelezettseg": "kötelezettség", "kotelezo": "kötelező", "kotheto": "köthető", "kovess": "kövess",
    "kozel": "közel", "kozelben": "közelben", "kozelgo": "közelgő", "kozeli": "közeli",
    "kozremukodik": "közreműködik", "koztarsasag": "köztársaság", "kozti": "közti", "kozvetlen": "közvetlen",
    "kreativok": "kreatívok", "kulcsszeffel": "kulcsszéffel", "kulonallo": "különálló", "kulonben": "különben",
    "lakas": "lakás", "lakasban": "lakásban", "lakashoz": "lakáshoz", "lakassal": "lakással", "lakasunk": "lakásunk",
    "lakhatasi": "lakhatási", "lassuk": "lássuk", "latjuk": "látjuk", "latogato": "látogató",
    "latogatok": "látogatók / látogatok", "latogatottsag": "látogatottság", "latogatottsagot": "látogatottságot",
    "legkondicionalt": "légkondicionált", "legrovidebb": "legrövidebb", "leiras": "leírás", "leirast": "leírást",
    "lejar": "lejár", "lemondas": "lemondás", "lemondasi": "lemondási",
    "letszam": "létszám", "levo": "lévő / levő", "listaja": "listája", "listajahoz": "listájához", "majustol": "májustól",
    "masodik": "második", "masodperces": "másodperces", "medencek": "medencék", "medencet": "medencét",
    "megallitja": "megállítja", "megerkezhettek": "megérkezhettek", "megfelelo": "megfelelő",
    "megfeleloen": "megfelelően", "megfigyeles": "megfigyelés", "megis": "mégis",
    "megjelenitesehez": "megjelenítéséhez", "megkeresheto": "megkereshető", "megkulonbozteto": "megkülönböztető",
    "meglevo": "meglévő / meglevő", "megnezve": "megnézve", "megnyitasa": "megnyitása", "megtalalhato": "megtalálható",
    "megtekinteseig": "megtekintéséig", "mentese": "mentése", "meretu": "méretű", "merhetoseg": "mérhetőség",
    "merjuk": "mérjük / merjük", "mezoje": "mezője", "mikrohullamu": "mikrohullámú", "mindharom": "mindhárom",
    "mindkettoben": "mindkettőben", "molo": "móló", "mosogatogep": "mosogatógép", "mosogep": "mosógép",
    "mosogeppel": "mosógéppel", "mukodesehez": "működéséhez", "munkaterulet": "munkaterület", "mutans": "mutáns",
    "mutanson": "mutánson", "nalunk": "nálunk", "napfeny": "napfény", "napjan": "napján", "napozashoz": "napozáshoz",
    "nappalibol": "nappaliból", "naptar": "naptár", "naptarban": "naptárban", "naptarig": "naptárig",
    "nehany": "néhány", "nekunk": "nekünk", "nelkuli": "nélküli", "nezd": "nézd", "neztem": "néztem",
    "nezzetek": "nézzetek / nézzétek", "nyar": "nyár", "nyilik": "nyílik",
    "nyitvatartast": "nyitva tartást / nyitvatartást", "onallo": "önálló",
    "orszagbol": "országból", "orzesi": "őrzési", "orzi": "őrzi", "osszel": "ősszel", "oszi": "őszi",
    "padlofutes": "padlófűtés", "padlofutessel": "padlófűtéssel", "parkolas": "parkolás", "parkolo": "parkoló",
    "parkoloval": "parkolóval", "paroknak": "pároknak", "partisztasag": "pártisztaság",
    "partisztasaga": "pártisztasága", "partjan": "partján", "pezsgo": "pezsgő", "pihenes": "pihenés",
    "piheneshez": "pihenéshez", "pihenesre": "pihenésre", "privat": "privát", "proban": "próbán",
    "ralatas": "rálátás", "redony": "redőny", "regisztracio": "regisztráció",
    "rendezvenyek": "rendezvények", "resze": "része", "reszleteket": "részleteket", "rogzitett": "rögzített",
    "rogzitunk": "rögzítünk", "segitheti": "segítheti", "seta": "séta", "setany": "sétány", "soran": "során",
    "sotet": "sötét", "sotetitett": "sötétített", "strandfurdo": "strandfürdő", "surgos": "sürgős", "suti": "süti",
    "sutijei": "sütijei", "sutik": "sütik", "sutiket": "sütiket", "sutikhez": "sütikhez", "sutit": "sütit",
    "suto": "sütő", "szabaly": "szabály", "szabalyok": "szabályok", "szabalyon": "szabályon", "szallas": "szállás",
    "szallasdijbol": "szállásdíjból", "szallashelyen": "szálláshelyen / szálláshelyén", "szamjegy": "számjegy",
    "szamodra": "számodra", "szamozott": "számozott", "szandekosan": "szándékosan", "szazalek": "százalék",
    "szemelyes": "személyes", "szemelyre": "személyre", "szemenek": "szemének", "szol": "szól",
    "szolgaltatasa": "szolgáltatása", "szolgaltatast": "szolgáltatást", "szolgaltatunk": "szolgáltatunk",
    "szoljon": "szóljon", "szomszedban": "szomszédban", "szovegbe": "szövegbe", "szovegben": "szövegben",
    "szovege": "szövege", "szovegeben": "szövegében", "szovegek": "szövegek", "szoveget": "szöveget / szövegét",
    "szoveggel": "szöveggel", "szovegmezok": "szövegmezők", "szukseg": "szükség", "szuksegesek": "szükségesek",
    "tagas": "tágas", "talalhato": "található", "talalsz": "találsz", "tamogatja": "támogatja",
    "tarolhatjatok": "tárolhatjátok", "tartozkodas": "tartózkodás",
    "taviranyitos": "távirányítós", "taviranyitoval": "távirányítóval", "tavolsagok": "távolságok",
    "telefonszam": "telefonszám", "telen": "télen / telén", "terkep": "térkép", "terulet": "terület",
    "tetel": "tétel", "tietek": "tiétek", "toltodik": "töltődik", "torli": "törli",
    "torlodnek": "törlődnek", "tortenik": "történik", "tudnivalo": "tudnivaló", "tuzijatek": "tűzijáték",
    "udvarbol": "udvarból", "ugras": "ugrás", "ugyanigy": "ugyanígy", "ujepitesu": "új építésű / újépítésű",
    "ujrarender": "újrarender", "unnep": "ünnep", "unnepek": "ünnepek", "unnepi": "ünnepi", "urlapok": "űrlapok",
    "utja": "útja", "utoirat": "utóirat", "uzemelnek": "üzemelnek", "uzemelteto": "üzemeltető", "valaszd": "válaszd",
    "valaszolunk": "válaszolunk", "valo": "való", "valtozat": "változat", "valtozatlanul": "változatlanul",
    "valtozo": "változó", "varnotok": "várnotok", "vasalo": "vasaló", "vegeig": "végéig", "vegleges": "végleges",
    "velemenyek": "vélemények", "vendegek": "vendégek", "vendegeket": "vendégeket",
    "vendegertekelesek": "vendégértékelések", "vendeglo": "vendéglő", "veszit": "veszít",
    "vezerelheto": "vezérelhető", "vezerlopaneleken": "vezérlőpaneleken", "videolejatszast": "videolejátszást",
    "visszaellenorizhesse": "visszaellenőrizhesse", "visszaigazolas": "visszaigazolás",
    "visszaolvasasa": "visszaolvasása", "vitorlas": "vitorlás", "vizpartig": "vízpartig", "zaro": "záró",
    "zart": "zárt", "zuhanyzoval": "zuhanyzóval",
    # adatvedelem and kornyek are also typical page paths ('az /adatvedelem/ lap'). They stay in the dictionary:
    # the EKEZETMASZK1018 path mask covers a /path after a space, and in running prose they are still errors.
    "adatvedelem": "adatvédelem", "kornyek": "környék",
    # Not from the collected copy, but forms that went through the gate in the measurement above: 'kulcsszef' (the
    # copy only has 'kulcsszéffel') and 'olcso'. Neither is a real word without its accents.
    "kulcsszef": "kulcsszéf", "olcso": "olcsó",
}

# GATEHOMOGLIF816 (2026-08-16, Marveen merese): 33 cirill homoglifa ult a
# memoria-sorokban es kartya-cimekben -- olvasva lathatatlan, de a grep/FTS
# nema nulla-talalatot ad, ami hianyzo emleknek latszik, nem serult adatnak.
# A szabaly a VEGYES SZORA vonatkozik (egy szon belul latin ES nem-latin betu),
# nem a cirill puszta jelenletere -- egy szandekosan idegen nyelvu idezet
# tiszta nem-latin szavai atmennek. Unicode-tudatos tokenizalas kell: a WORD
# regex latin-only, egy homoglifas szot darabokra vagna.
# THE RULE ITSELF LIVES IN scripts/lib/mixed_script.py, and is imported, not
# copied. Measured 2026-09-24 (review of #1541): the inter-agent send gate had
# re-implemented it as "any Cyrillic or Greek letter" and refused a plain
# Russian quote and a standalone Greek symbol, both of which THIS path passes.
# Two gates disagreeing about what is legitimate teach the sender that the rule
# depends on which script they called. One source, so they cannot drift.
#
# AND THE #1548 EXCEPTION MOVED WITH IT. SCRIPT_NEUTRAL (HOMOGLYPHMICRO924:
# the micro sign, superscripts and subscripts, so "40 µs", "100 m²" and
# "H₂O" are not mixed-script words) lived in THIS file until the extraction.
# It now lives in the shared module, so both paths get it -- before, only
# this one did. It is imported here too, so an importer of this module keeps
# seeing the name. This is the exception a rebase silently drops if only the
# hook-side conflict is resolved, which is why the test suite measures
# "40 µs" and "H₂O" on BOTH paths rather than trusting a green rebase.
#
# GUARDED, for the same reason as the email_extract import below, and measured
# the same way: a bare ImportError fires during MODULE LOAD, escapes the
# __main__ net and exits 1 -- and PreToolUse reads 1 as NON-blocking, so the
# send would run UNCHECKED. That is the one outcome a gate must never have.
# scripts/__tests__/email-extract-parity.test.py copies this file to a
# directory where neither module resolves and requires exit 2; before this
# guard the extraction turned that case from BLOCKED into a crash.
#
# The stub does NOT invent a fallback rule. A gate that cannot load its rule
# has no verdict, and "no verdict" here means BLOCK, not pass: the call sites
# turn MixedScriptUnavailable into a refusal that says the rule could not be
# loaded, instead of a homoglyph finding that was never measured.
class MixedScriptUnavailable(RuntimeError):
    """The shared mixed-script rule could not be imported."""


try:
    sys.path.insert(0, os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))
    from mixed_script import (  # noqa: E402
        UWORD, SCRIPT_NEUTRAL, char_script, mixed_script_words,
    )
except Exception as _mixed_exc:  # noqa: BLE001 -- deliberate fail-closed stub
    _MIXED_ERR = repr(_mixed_exc)
    UWORD = re.compile(r"[^\W\d_]+", re.UNICODE)
    SCRIPT_NEUTRAL = frozenset()

    def char_script(ch: str) -> str:
        return "UNKNOWN"

    def mixed_script_words(text: str):
        raise MixedScriptUnavailable(_MIXED_ERR)

_char_script = char_script   # the name this file used before the extraction


EM_DASH = "—"
# ENDASHGATE1030: an en dash after a word with horizontal white space before it (NBSP and tabs included, line breaks
# not) and either horizontal white space and a word after it, or the end of the line (a dash where the line was
# broken), i.e. a dash in prose; an unspaced range ("10–12") and a list marker at the start of a line do not match.
# Group 1 is the character before the white space, for the range exception below.
SPACED_EN_DASH = re.compile(r"(\S)[^\S\r\n]+\u2013(?:[^\S\r\n]+(?=\S)|[^\S\r\n]*(?=\r?\n|$))")
# A time span or a date range is a range, not a dash ("10:00 – 12:00", "október 30. – november 2.", "2026 – 2027"):
# a digit, or a period right after a digit ("30."), before the white space, and a digit or a month name (lower case,
# inflected too: "novemberig") after the dash. Any other period or colon before it is prose ("kész. – 3 dolog").
_DIGITS = "0123456789"
_RANGE_AFTER = re.compile(r"\d|(?:január|február|március|április|május|június|július|augusztus|szeptember|október"
                          r"|november|december)")


def spaced_en_dashes(prose: str) -> int:
    """How many spaced en dashes in `prose` are dashes (ENDASHGATE1030); a time span or date range is not one."""
    n = 0
    for m in SPACED_EN_DASH.finditer(prose):
        before = m.group(1)
        number_before = before in _DIGITS or (before == "." and m.start() > 0 and prose[m.start() - 1] in _DIGITS)
        if number_before and _RANGE_AFTER.match(prose, m.end()):
            continue
        n += 1
    return n

# GATEPERSIST816: owner-specific NAME rules load from an UNTRACKED local file,
# not from this (public-repo) script. The generic checks (accents, em dash,
# double hyphen, mixed-script) are universal Hungarian-copy QA and ship in the
# repo; a personal-name rule names a private third party, and that must not be
# published as a side effect of persisting the gate. A missing rules file is
# NOT silent: every run appends a loud line to the gate log, because a
# protection whose absence is invisible only protects until someone touches
# the tree. File shape: {"bad_name_patterns": ["<python-regex>", ...]}
# Always the install's own file (ENVRELAXGATE1104): the hook runs in the checked
# agent's environment, so no environment variable may hand it other rules. A test
# runs the hook from a tmp install (<tmp>/scripts linked to the repo's; abspath,
# not realpath, keeps <tmp> as the root).
_LOCAL_RULES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                            "store", "outgoing-copy-gate-rules.json")

_GATE_LOG = os.path.join(os.path.dirname(_LOCAL_RULES), "outgoing-copy-gate.log")


def pass_with_warning(msg: str) -> str:
    """A non-blocking warning, for BOTH readers. `systemMessage` is shown on
    the host's terminal only and never enters the model's request; the agent
    that just made the call learns of it only through
    `hookSpecificOutput.additionalContext` (measured 2026-11-08 on our own
    transcripts: systemMessage 0/6, PreToolUse additionalContext 7/7)."""
    return json.dumps({
        "systemMessage": msg,
        "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": msg},
    })


def _gate_log(message: str) -> None:
    """Append one TIMESTAMPED line to the gate log.

    The log used to carry bare text. Measured 2026-09-05: 8005 lines, four
    distinct messages, and one of them recorded a FAIL-OPEN pass-through on the
    Telegram branch -- a message that went out unaudited -- with no way to tell
    which day it happened on, let alone which message it was. A gate log whose
    entries cannot be placed in time cannot be used to check anything. Local
    time with the offset, never UTC.
    """
    try:
        from datetime import datetime
        stamp = datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")
        with open(_GATE_LOG, "a", encoding="utf-8") as fh:
            fh.write(f"{stamp} {message.rstrip()}\n")
    except OSError:
        pass


# CLCOPYGATEHIANY902 (owner decision, TG 14442) MERGED WITH GATEPERSIST816/3
# (PDB install, 2026-08-19). Two independent fixes to the same question, from
# opposite directions, so the merged policy has FIVE states:
#
#   "ok"         -> patterns loaded, the name check enforces as before.
#   "sanctioned" -> the file EXISTS and explicitly says "no_name_rule": true.
#                   Reported by the PDB install, 2026-08-19: their rules file
#                   was lost with no backup, and the owner decided not to
#                   reconstruct it. That is a taken decision, not a loss, and
#                   an install that has made it should not be nagged about it
#                   on every send. So this state is silent
#                   EVERYWHERE: no log line, no systemMessage, no block. Note
#                   the early return BELOW, which deliberately skips the
#                   logging tail. An ordinary empty list WITHOUT the flag does
#                   NOT reach this state, so a file emptied by accident can
#                   never masquerade as the sanctioned one.
#   "empty"      -> no patterns and no flag: the check is OFF.
#   "missing"    -> file absent, which is EVERY fresh customer install, since
#                   the file names a private person and is deliberately not
#                   shipped. Both of these fail-OPEN with a LOUD, user-visible
#                   warning on every send: the old fail-closed email path left
#                   a paying customer unable to send mail at all (Nova,
#                   2026-09-02).
#   "invalid"    -> the file EXISTS but cannot be used (bad JSON, wrong schema,
#                   uncompilable regex). Somebody TRIED to configure it and got
#                   it wrong: the email path stays fail-CLOSED until repaired.
#
# WHY THE MERGE IS NOT A CHOICE BETWEEN THE TWO: without the sanctioned state,
# a live rules file carrying the flag with an empty pattern list reads as
# "empty", and a loud warning gets stamped on EVERY outgoing letter, customer
# mail included. Without the missing/empty/invalid split, a fresh install with
# no file at all cannot send mail at all. Each half is wrong exactly where the
# other one is right, which is why both are here.
RULES_OK = "ok"
RULES_SANCTIONED = "sanctioned"
RULES_EMPTY = "empty"
RULES_MISSING = "missing"
RULES_INVALID = "invalid"

# The states where the name check does not run AND that is not a taken
# decision: the ones that must stay loud.
RULES_LOUD = (RULES_MISSING, RULES_EMPTY, RULES_INVALID)


def load_bad_name():
    """Return (compiled_regex_or_None, state) -- see the RULES_* names above."""
    try:
        with open(_LOCAL_RULES, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            state = RULES_INVALID
        else:
            pats = data.get("bad_name_patterns") or []
            if not isinstance(pats, list) or not all(isinstance(x, str) for x in pats):
                state = RULES_INVALID
            elif pats:
                return (re.compile("|".join(pats)), RULES_OK)
            elif data.get("no_name_rule") is True or data.get("name_check_disabled") is True:
                # Returns HERE, before the logging tail, on purpose: a taken
                # decision must not write a "the protection is gone" line into
                # the ledger on every single run. An alarm that can never be
                # answered is the one people learn to ignore -- it was drowning
                # the real signals in the same log (571 lines here by
                # 2026-09-04, CLCOPYGATEDONTES904).
                # TWO spellings of the SAME decision are accepted, because two
                # installs each documented one before the branches met:
                #   {"no_name_rule": true, "no_name_rule_reason": "why"}
                #     (GATEPERSIST816/3, the PDB install)
                #   {"bad_name_patterns": [], "name_check_disabled": true,
                #    "decided_at": "2026-09-04", "note": "why"}
                #     (CLCOPYGATEDONTES904)
                # Dropping either spelling would silently turn that install's
                # recorded decision back into a loud "empty".
                return (None, RULES_SANCTIONED)
            else:
                state = RULES_EMPTY
    except FileNotFoundError:
        state = RULES_MISSING
    except Exception:
        # Present but unusable: unreadable (permissions), unparseable JSON,
        # or an uncompilable pattern. All of these mean someone TRIED to
        # configure the rule and failed -- that must stay loud AND closed.
        state = RULES_INVALID
    # ONE logging tail for EVERY loud state (Marveen review on #1156: the
    # first cut logged only the exception branches, so empty/schema-invalid
    # left no log line while missing did -- same event class, inconsistent
    # ledger).
    _gate_log(f"outgoing-copy-gate: NEV-SZABALY {state.upper()} ({_LOCAL_RULES}) -- "
              "a nev-ellenorzes NEM fut.")
    return (None, state)


def _name_correction() -> str:
    try:
        with open(_LOCAL_RULES, encoding="utf-8") as fh:
            corr = json.load(fh).get("correction") or ""
        return (" " + corr) if corr else ""
    except Exception:
        return ""


BAD_NAME, RULES_STATE = load_bad_name()
ACCENTED = set("áéíóöőúüűÁÉÍÓÖŐÚÜŰ")
TAG = re.compile(r"<[^>]+>")

# GATEKOTOJEL817 + GATEHYPH816 (2026-08-19 este, ket hamis pozitiv elo
# gazda-beszelgetesben, ot perc alatt): a kapu nem tett kulonbseget PROZA es
# AZONOSITO kozott. (1) `Drive-ot` -- az idegen tulajdonnevhez a magyar
# toldalek kotojellel kapcsolodik (ez a HELYES iras), de a betu-only WORD
# tokenizalo a kotojelnel vagott, es a maradek `ot` darabot onallo magyar
# szonak nezte (ot -> öt). (2) `Video atalakitas` -- egy Drive-mappa NEVE a
# szovegben: mondatkozi nagybetus szo, azonosito, nem proza. A javitas a
# TOKENIZALAS, nem a szotar (szo-kivetel a valodi hibakat is atengedne):
#   - kotojeles alaknal a TELJES szoalak vizsgalando (a `drive-ot` egeszkent
#     nincs a szotarban -> atmegy; az onallo `ot` prozaban tovabbra is bukik);
#   - a MONDATKOZI nagybetus szo azonosito/tulajdonnev -> kimarad; mondat
#     elejen (. ! ? : ujsor vagy lista-jel utan) a nagybetu normal proza,
#     ott tovabbra is vizsgaljuk.
HYPHEN_WORD = re.compile(r"[a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ]+(?:-[a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ]+)*")


def _at_sentence_start(text: str, idx: int) -> bool:
    i = idx - 1
    while i >= 0 and text[i] in " \t\"'([{":
        i -= 1
    if i < 0:
        return True
    ch = text[i]
    if ch in ".!?:\n":
        return True
    if ch in "-*•":
        j = i - 1
        while j >= 0 and text[j] in " \t":
            j -= 1
        return j < 0 or text[j] == "\n"
    return False


def accent_check_tokens(prose: str):
    """(lowercase alak, kezdo-pozicio) parok az ekezet-vizsgalathoz."""
    out = []
    for m in HYPHEN_WORD.finditer(prose):
        tok = m.group(0)
        # DIGIT-HYPHEN SUFFIX (429-es, 403-as, 2026-os, 3420-as). HYPHEN_WORD only
        # admits LETTERS around the hyphen, so a Hungarian suffix attached to a
        # NUMBER is seen as a standalone word -- and "es" is then read as the
        # accent-stripped "és". These are not prose words; they carry no accent.
        # (2026-08-21: the gate blocked a correct message reading "429-es vagy
        # 403-as". GATEKOTOJEL817 covered letter-hyphen-letter forms, not this one.)
        if m.start() >= 2 and prose[m.start() - 1] == "-" and prose[m.start() - 2].isdigit():
            continue
        if "-" not in tok and tok[0].isupper() and not _at_sentence_start(prose, m.start()):
            continue
        out.append((tok.lower(), m.start()))
    return out


def _hit_context(prose: str, pos: int, length: int) -> str:
    """A talalat elotti/utani 3-3 szo + karakter-pozicio (GATEHYPH816 (B):
    elo beszelgetes kozben ne kelljen greppelni, melyik szorol van szo)."""
    before = prose[:pos].split()[-3:]
    token = prose[pos:pos + length]
    after = prose[pos + length:].split()[:3]
    frag = " ".join(before + [token] + after)
    return f'"...{frag}..." @{pos}'


# Technikai tokenek maszkolasa AZ EKEZET-ELLENORZES ELOTT. Merve 2026-08-13, a
# +48-as bovites negativ kontrolljan: egy HIBATLANUL ekezetezett eles level
# fennakadt a `video_view` esemenynevben levo "video"-n. A szobonto az aláhúzást
# hataroljelnek veszi, tehat minden snake_case azonosito, fajlnev, URL-slug es
# domain beszallit egy "magyar szot", ami ott ekezet nelkul HELYES. Ugyanaz az
# osztaly, mint a 2026-08-11-i `level` fajlnev-talalat. Ugyanide tartozik a
# 2026-08-25-i talalat ugyanebbol az osztalybol: a TULAJDONNEV + kotojeles toldalek
# ("Chrome-ot", "Drive-ra") is puszta "ot"/"ra" tokenre esik szet, es az "ot" benne
# van a szotarban (-> "ot"). Ezert a maszk a nagybetuvel kezdodo tovet is elfogadja,
# de CSAK ha a kotojel utan legfeljebb negy kisbetu all: egy valodi magyar osszetett
# szo masodik tagja ("Telegram-hidam") tipikusan hosszabb, tehat az tovabbra is fennakad.
# 2026-08-26-i talalat, HARMADIK a sorozatban, de mas alosztaly: nem toldalek volt,
# hanem egy ANGOL SZO, ami veletlenul egy ekezetes magyar szo ekezetlen alakja.
# A "level 1" (autonomia-szint) alak a szotarban "level -> level" javaslatot valtott ki,
# es ketszer blokkolta a reggeli uzenetet. A szotarbol NEM vettem ki a bejegyzest, mert
# a magyar "level" tenyleg hibas alak; a maszk csak a SZAM ELOTTI angol hasznalatot vagja ki.
# Ami igy is fennakad: az idezojelbe tett, magarol beszelo "level" szo. Arra a kod-span
# (backtick) a kijarat, az ugyanis maszkolva van.
# 2026-08-27, NEGYEDIK a sorozatban: a KOTOJELES KISBETUS AZONOSITO. Az utemezett
# feladatok es skillek nevei (folyamatos-ellenorzes, mentes-lemaradas-ellenorzes,
# kontextus-atadas-visszaallitas) ekezet nelkuli magyar szavakbol allnak, mert fajl- es
# mappanevek. A szotar ezeket valodi talalatnak latja, pedig AZONOSITOK, nem proza --
# a gazdanak pont igy, betuhiven kell leirni oket, kulonben nem talalja meg a gepen.
# A maszk ezert kivagja a legalabb ket tagu, csupa kisbetus, kotojellel osszekotott
# alakokat. Egy valodi magyar mondat nem all ilyen alakbol, es a NAGYBETUS kezdetu
# osszetetelekre (Chrome-ot) mar van kulon, szigorubb szabaly folotte.
# 2026-08-24-i talalat: a szambol es kotojeles magyar toldalekbol allo alak
# ("8:09-es", "2-es", "17:06-kor") a szobontonal puszta "es"/"kor" tokenne esik
# szet, amit a szotar hibanak lat -- pedig ott toldalek, nem szo. A javitas nem a szotarbol
# vesz ki (az elrontana a valodi talalatokat is), hanem a technikai regiokat
# vagja ki a vizsgalt szovegbol. A gondolatjel-ellenorzes NEM ezen fut (az a nyers
# szovegen mer), a nev-ellenorzes pedig a SAJAT, szukebb maszkjan -- lasd NAME_MASK.
#
# GATENEVSTRIP921 (kulso bejelentes 2026-09-21, sajat visszameres 2026-09-22):
# KET SZABALY, AMI UGYANARRA A SZOVEGRE NEZ, NEM UGYANAZT A MASZKOT AKARJA.
# A bejelentes az volt, hogy a nev-szabaly a NYERS szovegen fut, ezert URL-ben,
# kod-spanban vagy utvonalban allo nevalak is megallitja a teljes uzenetet
# (harom ilyen hamis pozitiv reprodukalva). A kezenfekvo javitas -- a nev-szabaly
# athelyezese a strip_technical UTANRA -- viszont LYUKAT NYIT, mert az alabbi ket
# alternativa a NEVET magat vagja ki a szovegbol a toldalekaval egyutt:
#   "Nev-val" / "Nev-nak" / "Nev-fele"  ->  a tulajdonnev+toldalek ag eszi meg
# Merve a sajat mintankon (kartya-komment 17237): harom prozai alakbol harom tunt
# el a strip utan, vagyis csendben ATMENTEK volna. Ezert a nev-szabaly a kozos,
# egyertelmuen technikai regiokat kapja meg maszknak (_TECH_COMMON), a toldalek-
# es azonosito-agakat NEM. Ezek az agak a token- es ekezet-vizsgalatnak kellenek,
# ahol epp az a dolguk, hogy a toldalek-toredeket ne nezzek onallo szonak.
#
# A KET MASZK EGY FORRASBOL EPUL, hogy ne drifteljenek szet: ha valaki uj
# technikai regiot vesz fel, a _TECH_COMMON-ba irva MINDKET ellenorzes latja.
_TECH_COMMON = r"""
        https?://\S+                # URL
      | [\w.+-]+@[\w-]+\.[\w.]+     # email
      | `[^`]*`                     # kod-span
      | \b\w+(?:_\w+)+\b            # snake_case azonosito
      | \b\w+\.[A-Za-z]{2,10}(?:-[a-záéíóöőúüű]{1,4})?\b   # fajlnev / domain, magyar toldalekkal (video.mp4, marveen.io, Mail.app-ot)
      | \b[\w-]*/[\w/-]+            # utvonal / slug
"""
# CSAK a token-/ekezet-vizsgalat vaghatja ki ezeket: mindharom ag kepes egy
# tulajdonnevet a toldalekaval egyutt elnyelni, ezert a nev-szabaly nem kapja meg.
_TECH_SUFFIXED = r"""
        \d+(?:[.:,]\d+)*-[a-záéíóöőúüű]+(?![^\W\d_])   # szam + magyar toldalek (8:09-es, 2-es, 17:06-kor), csak magyar latin betu
      | \d+(?:[.:,]\d+)*[\ \u00a0\u202f]?[%‰°$€£]-[a-záéíóöőúüű]+(?![^\W\d_])   # szam + mertekegyseg-jel + toldalek (30%-ot, 2‰-es, 90°-os, 5€-t)
      | \b[A-ZÁÉÍÓÖŐÚÜŰ][^\W\d_]*-[a-záéíóöőúüű]{1,4}\b   # tulajdonnev + toldalek (Chrome-ot, Drive-ra)
      | \blevel\s+\d+\b            # angol "level 1" (autonomia-szint, log-szint)
      | (?:(?<![\w-])--)?\b[a-z]+(?:-[a-z]+){1,4}\b    # kotojeles kisbetus azonosito (feladat- es skill-nevek), --flag alakban is
"""
# COPYGATEHOMONUM1105 (2026-11-06): the plain number branch (the first line above) took ANY Unicode letter as its suffix
# ([^\W\d_]+), so a Cyrillic or Greek letter in such a suffix was masked away before the homoglyph rule ran. It now
# takes Hungarian Latin letters only, with the end of the suffix pinned, the same rule as its unit-sign sibling below.
# ISSUE1838COPYGATE (#2543, 2026-11-05): the number branch wanted a DIGIT right before the hyphen, so a suffix after a
# unit sign ('30%-ot', '2‰-es', '90°-os', '5€-es') was cut at the hyphen and its fragment checked as a standalone word:
# 'ot' -> 'öt', 'es' -> 'és'. Suffixes that are not dictionary words ('20%-kal', '15%-át') passed by luck. The second
# branch takes number + sign + suffix whole, with an optional (also non-breaking) space before the sign ('30 %-ot').
# Its suffix is Hungarian Latin letters ONLY, unlike the branch above: TECHNICAL also feeds the homoglyph rule
# (mixed_script_words runs on the stripped prose), and a Cyrillic letter in such a suffix must still reach it.
# The lookahead pins the END of the suffix (Dani, #2545 review): without it a suffix that starts Latin and ends
# Cyrillic or Greek had its Latin part eaten, the rest was a single-script fragment, and no mixed word was seen.
# FLAGDASH1030 (2026-10-30): the hyphenated-identifier branch above used to eat only the word part of a
# '--select-release-current' flag, so strip_technical() left the leading '--' between two spaces, and the double-hyphen
# rule counted it as a dash in prose: 'plesk installer --select-release-current --upgrade-installed-components' was
# BLOCKED twice. The optional '--' prefix takes the flag whole. A real ' -- ' in prose is still counted: the prefix
# needs a letter right after the two hyphens, and a prose dash has a space there.
TECHNICAL = re.compile(_TECH_COMMON + "|" + _TECH_SUFFIXED, re.X)
NAME_MASK = re.compile(_TECH_COMMON, re.X)

# EKEZETMASZK1018 (2026-10-18): all three review rounds of the EKEZET1018 dictionary extension found the same class:
# a dictionary word matched in a place that is not Hungarian prose. TECHNICAL does not cover an #anchor, a --flag or a
# /path that starts after a space (it does cover 'word/word': \b[\w-]*/[\w/-]+ needs a word boundary before the
# opening '/'). These three branches are a SEPARATE mask that only the accent check uses (hits, ratio, context),
# applied after TECHNICAL. TECHNICAL is also used by the homoglyph rule (mixed_script_words) and the double-hyphen
# count, and there the mask would hide a Cyrillic homoglyph inside '#fоglalas' or '--jоvahagyott'. The name-rule
# mask (NAME_MASK) does not get them either.
# The path branch does NOT swallow a sentence-final period ('/kapcsolat.'): otherwise the next sentence's capitalised
# first word would look like a mid-sentence capital, and the accent check would skip it.
# COPYMASK1019 (2026-10-20, measured on the #2065 corpus check): two more shapes that only carry identifiers, also
# accent-only for the same reason: a directory with its trailing slash ('kepek/', 'fizetes/*'; a word/word path is
# already in TECHNICAL) and a key=value pair ('funkcio=ertekeles'). NOT masked, deliberately:
#   - a QUOTED word or phrase. A quoted single token looked like a literal value ('lakas'), but it is also exactly how
#     a button label or a value to type is written for a customer ('kattints a "reszletek" gombra'), so a mask would
#     let accentless customer copy through (Samu, #2085 review). A quoted identifier goes in backticks;
#   - a bare table or page name in a sentence ('a velemenyek táblán'), which has no shape that tells it from prose:
#     backticks again.
_ACCENT_ONLY = r"""
        (?<![\w&])\#[\w-]+                   # anchor / hashtag (#reszletek): an identifier, not prose
      | (?<![\w-])--[A-Za-z][\w-]*            # command-line flag (--jovahagyott)
      | (?<![\w/])/[\w-]+(?:[./][\w-]+)*/?    # a path that starts with / after a space (az /adatvedelem/ lap), no final period
      | (?<![\w/.-])[\w.-]+/\**(?=[\s,;:.!?)\]'"]|$)   # a directory written with its trailing slash (kepek/, fizetes/*)
      | (?<![\w.-])[A-Za-z_][\w.-]*=[^\s,;)\]'"]+   # key=value (funkcio=ertekeles), a parameter, not prose
"""
ACCENT_MASK = re.compile(_ACCENT_ONLY, re.X)


def strip_technical(text: str) -> str:
    return TECHNICAL.sub(" ", text)


# STRIPDASH1109 (2026-11-09, kanban 1e9b49f5): the ' -- ' count ran on strip_technical() output, and that cut puts a
# SPACE where a technical region was, so the cut itself could build the pattern: '--accept_routes=true' (snake_case
# branch) became ' -- =true' and was BLOCKED as a prose dash, although the raw text has no ' -- ' anywhere. The count
# now runs on a copy where each region is a placeholder with no space and no hyphen in it, so a cut can only remove a
# dash, never create one. A real ' -- ' next to a region ('ez -- `kod`') still has its own spaces and is still counted.
TECH_PLACEHOLDER = "_"


def strip_technical_closed(text: str) -> str:
    return TECHNICAL.sub(TECH_PLACEHOLDER, text)


def strip_for_accent(prose: str) -> str:
    """The accent check's own ADDITIONAL mask, applied to the strip_technical output (EKEZETMASZK1018)."""
    return ACCENT_MASK.sub(" ", prose)


def strip_for_name(text: str) -> str:
    """A nev-ellenorzes maszkja: csak az egyertelmuen technikai regiok esnek ki."""
    return NAME_MASK.sub(" ", text)


def is_hungarian(text: str) -> bool:
    low = text.lower()
    return sum(1 for m in HU_MARKERS if m in low) >= 3


# GATETG816 (2026-08-16, Marveen merese): az is_hungarian() funkcionalis szavakra
# szur, ezert a TOMOR, tenykozol, felsorolasos magyar uzenet (pont a fo agens
# Telegram-stilusa) nem eri el a 3 markert, es az ekezet-vizsgalat el sem indul --
# a mai napindito elso bekezdese ekezetlenul atment. A nyelv-detektor ezert nem
# EGYEDULI kapu tobbe: egyetlen olyan szotar-talalat, ami magyarul ekezet nelkul
# NEM letezik ES angol/technikai szokent sem ertelmezheto, onmagaban eleg ok a
# vizsgalatra. Az alabbi kizaras CSAK a triggerre vonatkozik: ha a szoveg mas
# uton magyarnak bizonyult, ezek a talalatok is jelentesre kerulnek -- de egyedul
# nem ranthatnak be egy angol szoveget az auditba ("the all-new level editor").
# KNOWN LIMIT (KAPUES1018, 2026-10-18): so a Hungarian text with fewer than 3 DISTINCT HU_MARKERS words (substring
# matches count), and without any ACCENTLESS word that is NOT listed here, can pass with an accentless "es", whatever
# its length (the >200-letter ratio branch also runs only once the audit has started). Measured size: of 267
# Hungarian sentences with one "és" -> "es" mutation, the gate lets 206 through. Measured and pinned case:
# "Örülünk, hogy jöttök, es nem sietünk." -> exit 0 (2 markers: hogy, nem); with "már" (a 3rd marker) the same text
# is blocked. A third trigger built on the text's other accented words gave false blocks in three review rounds on
# non-Hungarian customer text that quotes a Hungarian dish or place name (e.g. Spanish "Probamos pörkölt y
# kürtőskalács, es delicioso."), so it was rejected: the gate's main value is that it does not wrongly block a
# customer message. Test: scripts/__tests__/outgoing-copy-gate-kapues1018-hatar.test.py.
AMBIGUOUS_TRIGGER = {
    "es", "ar", "arak", "ev", "evi", "ot", "uj", "ujat", "het", "ora", "mas",
    "all", "level", "video", "netto",
    # EKEZET1018: foreign-looking forms that must not pull a non-Hungarian text into the audit on their own; in a
    # text that is Hungarian by other evidence they are still reported.
    "privat", "zart", "molo", "seta", "mutans", "kanape",
}

# EKEZET1018: the NAME class exempts only when CAPITALISED. In lowercase these are frequent Hungarian words (soran,
# kozel, hany, keri, levo), and in a short accentless message they are exactly the evidence; only the capitalised
# sentence-start form can be a foreign name ("Soran will ship", "Kozel agreed"). accent_check_tokens() already drops
# a capitalised word in mid-sentence, so a capitalised token here is always sentence-initial.
AMBIGUOUS_NAME_TRIGGER = {
    # sentence-start English words / names (Keri, Iger, Soran) that would pull an English text in on their own
    "keri", "iger", "soran",
    # the same class (sentence-start foreign names / brands: Hany, Korben, Kozel, Barki, Levo)
    "hany", "korben", "kozel", "barki", "levo",
}


def accentless_evidence(tok_pos, text):
    """The trigger evidence, from (lowercase form, position) pairs, using the original case in `text`."""
    return {w for w, p in tok_pos
            if w in ACCENTLESS and w not in AMBIGUOUS_TRIGGER
            and not (w in AMBIGUOUS_NAME_TRIGGER and text[p:p + 1].isupper())}


# collect_bash_body / collect_mcp_body moved VERBATIM to email_extract.py
# (EMAILKAPU901 PR1): the level-2 approval gate hashes the same letter this
# gate audits, so the extraction must have exactly one implementation.
# Byte-parity with the pre-move behavior is pinned by
# scripts/__tests__/email-extract-parity.test.py against a golden captured
# from the pre-move code.
# GUARDED import: a bare ImportError would escape the __main__ net (it fires
# during module load), exit 1, and PreToolUse treats 1 as NON-blocking -- the
# send would run UNCHECKED. The stubs keep the email path fail-closed through
# the existing unreadable branch, and leave the telegram path (which never
# calls these) fail-open as designed.
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from email_extract import (collect_bash_body, collect_harder_mail_text, collect_mcp_body,  # noqa: E402
                               classify_mail_tool, is_harder_mail_tool, is_ms365_tool,
                               ms365_text_checked)
except Exception as _extract_exc:  # noqa: BLE001 -- deliberate fail-closed stub
    _EXTRACT_ERR = repr(_extract_exc)

    def collect_bash_body(cmd: str):
        return ("", f"az email_extract modul nem toltheto be ({_EXTRACT_ERR})")

    def collect_mcp_body(tool_input: dict, tool_name: str = ""):
        return ""

    def collect_harder_mail_text(tool_input: dict):
        return ("", f"az email_extract modul nem toltheto be ({_EXTRACT_ERR})")

    def is_harder_mail_tool(tool_name):
        return False

    def is_ms365_tool(tool_name):
        return False

    def ms365_text_checked(tool_input):
        return ("", None)

    def classify_mail_tool(tool_name):
        # Without the shared classifier nothing can be classified precisely.
        # Crude SUPERSET instead: every outbound name holds one of these words,
        # so each lands on the unreadable (fail-closed) branch of main();
        # manage_email keeps its operation test, and plain reads (search /
        # read / list) still pass.
        n = str(tool_name or "").lower()
        if n == "bash":
            return None
        if "manage_email" in n:
            return "manage_email"
        return "draft" if re.search(r"send|draft|reply|forward", n) else None


# --- Telegram reply (GATETG816) ---------------------------------------------
# The reply tool sends MarkdownV2, where every special char arrives escaped
# (\. \( \) \-). Those backslashes sit inside the prose the audit reads, and
# they can split technical tokens or glue fragments in ways the email path
# never sees. Un-escape (backslash before a non-word char) BEFORE auditing --
# this is analysis-only, the outgoing payload is untouched.
MDV2_ESCAPE = re.compile(r"\\([^\w\s])")


# --- Human-facing HTTP channels via curl (GATEHTTP924) ------------------------
# The Bash arm recognised exactly one kind of send: email. Every other outbound
# path that a human reads, and that an agent can reach with a plain curl, left
# the machine with no audit at all. Measured 2026-09-24 with a synthetic em-dash
# payload: a comment to the community API, a post to Discord's REST API and a
# Telegram Bot API sendMessage all passed exit 0, while the SAME text through
# the Telegram reply tool was blocked. The gate was not failing on these paths,
# it simply had no door there.
#
# Covered here, each only when the method is a SEND (POST/PUT/PATCH or an
# implicit POST from a data flag; GET/HEAD reads pass untouched):
#   - the community agent API (api.marveen.io): feed posts, comments, mention
#     replies. Written from a vault-held base URL in practice ($B/feed/...), so
#     the path shape counts even when the host is an unresolved variable;
#   - Discord REST: .../channels/<id>/messages[/<id>];
#   - Telegram Bot API: .../bot<token>/send*|edit*.
# NOT covered, deliberately: /api/messages (inter-agent and federation). That
# channel is agent-to-agent, its traffic is written without accents, and it
# already has its own homoglyph-only gate (INTERAGENTHOMOGLIF923) above.
#
# Failure direction follows the email branch, not the Telegram one: a body the
# hook cannot read BLOCKS. These are deferrable writes (a community post is
# even queued for owner approval), and a public text that skipped the audit
# costs more than a retry with a readable body. An INTERNAL error still passes
# loudly, like every channel arm.
_HTTP_CHANNEL_TARGETS = (
    ("marveen.io", re.compile(
        r"^((https?://)?([^/\s]*\.)?api\.marveen\.io|\$\{?\w+\}?)(/[^\s]*)?"
        r"/(feed/posts(/[^/\s]+/comments)?|mentions/[^/\s]+/reply)/?(\?\S*)?$", re.I)),
    ("Discord API", re.compile(
        r"^(https?://)?([^/\s]*\.)?discord(app)?\.com/api(/v\d+)?/channels/[^/\s]+/messages(/[^/\s]+)?/?(\?\S*)?$",
        re.I)),
    ("Telegram API", re.compile(
        r"^(https?://)?api\.telegram\.org/bot[^/\s]+/(send|edit)\w*/?(\?\S*)?$", re.I)),
)
# Only the prose a human reads. ids, chat ids, parse modes and urls stay out:
# auditing them would block on tokens nobody reads as text.
_HTTP_TEXT_FIELDS = ("title", "content", "text", "caption", "message")


def _http_channel_segment(cmd: str):
    """(label, tokens) of the first curl segment that SENDS to a covered
    human-facing HTTP channel, or (None, None)."""
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        return None, None
    for toks in segments:
        while toks and _ENV_ASSIGN.match(toks[0]):
            toks = toks[1:]
        if not toks or not _CURLISH.match(_basename(toks[0])):
            continue
        rest = toks[1:]
        for label, target in _HTTP_CHANNEL_TARGETS:
            if any(target.match(t) for t in rest):
                if _curl_resend_verdict(_basename(toks[0]), rest) == "read":
                    return None, None  # a GET of the feed: nothing is sent
                return label, toks
    return None, None


def _http_channel_text(raw: str) -> str:
    """The human-read prose of a channel body: JSON object fields, or the same
    fields form-encoded (Telegram accepts both). Unknown shape: the raw body."""
    try:
        obj = json.loads(raw)
    except ValueError:
        obj = None
    if isinstance(obj, dict):
        return "\n".join(str(obj[f]) for f in _HTTP_TEXT_FIELDS
                         if isinstance(obj.get(f), str) and obj.get(f))
    if obj is None:
        from urllib.parse import parse_qs
        form = parse_qs(raw, keep_blank_values=False)
        got = [v for f in _HTTP_TEXT_FIELDS for v in form.get(f, [])]
        if got:
            return "\n".join(got)
    return raw


def http_channel_gate(cmd: str) -> None:
    """Exit 2 on a copy problem or an unreadable body, exit 0 when clean.
    RETURNS (does not exit) when the command is not a covered HTTP send, so
    the caller's other arms still run."""
    label, toks = _http_channel_segment(cmd)
    if label is None:
        return
    try:
        raw, unreadable = _curl_payload_raw(cmd, toks, all_flags=True)
        if unreadable:
            sys.stderr.write(
                f"KIMENO-SZOVEG KAPU ({label}): TILTVA, mert a kimeno szoveget nem tudtam "
                f"megvizsgalni.\nOk: {unreadable}.\n\n"
                "Ez szandekosan fail-closed: egy vizsgalhatatlan kuldes pont a kaput utne ki.\n"
                "Vizsgalhato alak: idezett heredoc (--data-binary @- <<'JSON'), "
                "@/abszolut/ut.json, vagy inline -d '...' behelyettesites nelkul.\n")
            sys.exit(2)
        if raw is None:
            sys.exit(0)  # a bare POST: nothing of ours is being sent
        text = _http_channel_text(raw)
        if not text.strip():
            sys.exit(0)
        problems = audit(text)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate blanket: fail-open-loud
        head = f"outgoing-copy-gate: HTTP-csatorna-ag ({label}) belso hiba, FAIL-OPEN atengedes"
        tail = " -- ez az uzenet a szoveg-ellenorzes NELKUL ment ki."
        sys.stderr.write(f"{head}: {exc!r}{tail}\n")
        _gate_log(f"{head}: {exc!r}{tail}")
        # stderr on exit 0 and the gate log never reach the sending agent;
        # only additionalContext does, so it learns the send went out unchecked.
        # The model gets the exception TYPE only: a repr can carry the text
        # being processed (e.g. a UnicodeEncodeError quotes it).
        print(pass_with_warning(f"{head}: {type(exc).__name__}{tail}"))
        sys.exit(0)
    if problems:
        sys.stderr.write(
            f"KIMENO-SZOVEG KAPU ({label}): TILTVA, az uzenet nem mehet ki igy.\n\n"
            + "\n".join(f"  - {p}" for p in problems)
            + "\n\nJavitsd a szoveget es kuldd ujra.\n")
        sys.exit(2)
    sys.exit(0)


def collect_channel_body(tool_input: dict, unescape_mdv2: bool) -> str:
    """Text of a channel reply. GATEDISCORD905: both the Telegram and the
    Discord reply tool put the prose in `text` (schema-checked, not guessed);
    `caption`/`message` stay in the list because they cost nothing and a
    missed field here is a SILENT ZERO -- empty text exits 0, i.e. fail-open.
    Only Telegram's MarkdownV2 escapes get undone: on Discord a backslash is
    a literal the author wrote, not gate noise."""
    fields = ("text", "caption", "message")
    got = [str(tool_input[f]) for f in fields if tool_input.get(f)]
    # c67f5f34: the Telegram reply tool's one-tap answer buttons (a Marveen patch
    # of the plugin, scripts/patch-telegram-plugin.py) are outgoing text too: the
    # tapped label is what the recipient sees and sends back. A label this gate
    # did not read would be the silent zero above, so every label joins the body;
    # a value that is not a list is read as it is (the loud side).
    # DCBTN1023: the Discord reply tool's buttons (scripts/patch-discord-plugin.py)
    # are objects, {label, style}: only the label is shown, so only the label is
    # read -- the dict's own words (label, style, success) would be ASCII noise in
    # the accent ratio. An object without a string label is read as it is.
    buttons = tool_input.get("buttons")
    if isinstance(buttons, (list, tuple)):
        got += [s for s in (str(b["label"]) if isinstance(b, dict) and isinstance(b.get("label"), str) else str(b)
                            for b in buttons) if s.strip()]
    elif buttons:
        got.append(str(buttons))
    joined = "\n".join(got)
    return MDV2_ESCAPE.sub(r"\1", joined) if unescape_mdv2 else joined


def channel_gate(tool_input: dict, label: str, unescape_mdv2: bool) -> None:
    """Audit a channel reply (Telegram or Discord). FAIL-OPEN on any internal
    error (exit 0 + loud log): email is deferrable, but these are the owner's
    ONLY supervision channels -- a gate crash that silences one costs more
    than a slipped accent. A FOUND problem still blocks (exit 2): that is the
    gate's whole point."""
    try:
        text = collect_channel_body(tool_input, unescape_mdv2)
        if not text.strip():
            sys.exit(0)  # files-only reply or empty text: nothing to audit
        # GATECOPY827: a masolhato kodblokk CSAK markdownv2 modban lesz
        # kodblokk. A reply tool `format` parametere alapertelmezesben "text",
        # es plain textben a Telegram nem parsolja a harom backtickot, tehat
        # nincs copy gomb -- a szoveg nyersen, a backslash-escape-ekkel egyutt
        # jelenik meg. Ez 2026-08-17 ota OTSZOR ment ki igy (a memoriaban
        # feedback_telegram_codeblock_needs_markdownv2, plusz a kotelezove tett
        # telegram-copy-gomb skill), es egyik alkalommal sem tudashiany volt,
        # hanem kihagyott lepes. Ezert innentol gepi kapu allitja meg, nem
        # emlekezet. A vizsgalat a NYERS szovegen fut, mert a fence-t a
        # MDV2_ESCAPE feloldas nem erinti.
        raw = "\n".join(str(tool_input[f]) for f in ("text", "caption", "message")
                        if tool_input.get(f))
        # This rule is TELEGRAM-SPECIFIC: the copy button depends on MarkdownV2
        # parsing. Discord renders a triple-backtick block natively in a plain
        # message and its reply tool has no markdownv2 format value at all, so on
        # that branch the rule would block a problem that does not exist -- and,
        # before the label existed, would have named the wrong channel while doing
        # it. The condition therefore filters on the label explicitly, not on
        # unescape_mdv2: those two only happen to coincide today, and the intent
        # here is the channel.
        if (label == "Telegram" and "```" in raw
                and str(tool_input.get("format", "")).lower() != "markdownv2"):
            sys.stderr.write(
                "KIMENO-SZOVEG KAPU (Telegram): TILTVA, a kodblokk nem lenne masolhato.\n\n"
                "  - A szoveg harom backtickes kodblokkot tartalmaz, de a hivasban\n"
                "    format=\"" + str(tool_input.get("format") or "text") + "\". Plain textben a Telegram nem ad copy gombot,\n"
                "    es a MarkdownV2 escape-ek (\\. \\- \\() nyersen latszanak.\n\n"
                "Kuldd ujra ugyanezt a szoveget format=\"markdownv2\"-vel. Kodblokkon\n"
                "belul csak a backtickot es a backslasht kell escapelni, a blokkon\n"
                "kivuli prozat viszont teljesen (_*[]()~`>#+-=|{}.!).\n"
            )
            sys.exit(2)
        problems = audit(text)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate blanket: fail-open path
        head = f"outgoing-copy-gate: {label.upper()}-ag belso hiba, FAIL-OPEN atengedes"
        tail = " -- ez az uzenet a szoveg-ellenorzes NELKUL ment ki."
        sys.stderr.write(f"{head}: {exc!r}{tail}\n")
        _gate_log(f"{head}: {exc!r}{tail}")
        print(pass_with_warning(f"{head}: {type(exc).__name__}{tail}"))  # type only, see above
        sys.exit(0)
    if problems:
        sys.stderr.write(
            f"KIMENO-SZOVEG KAPU ({label}): TILTVA, az uzenet nem mehet ki igy.\n\n"
            + "\n".join(f"  - {p}" for p in problems)
            + "\n\nJavitsd a szoveget es kuldd ujra (a MarkdownV2 escape-eket a kapu "
              "az ellenorzes elott feloldja, azok nem szamitanak hibanak).\n"
        )
        sys.exit(2)
    # GATEPERSIST816(2): a hianyzo nev-szabaly a csatorna-agon fail-open marad,
    # de a figyelmeztetes ODA megy, ahol a session tenyleg latja -- a hook
    # stdout systemMessage mezoje a futo sessionben jelenik meg, nem egy
    # logfajlban, amit senki nem olvas.
    # GATEPERSIST816/3 + CLCOPYGATEDONTES904: a tudatosan felfuggesztett
    # szabaly (RULES_SANCTIONED, barmelyik flag-irassal) mar nem veszteseg,
    # nincs mit jelezni, a Telegram-ag ott csendben marad. Minden mas nem-ok
    # allapot (missing/empty/invalid) figyelmeztetest kap.
    if RULES_STATE in RULES_LOUD:
        print(pass_with_warning(
            "outgoing-copy-gate: a NEV-SZABALY fajl hianyzik/ures "
            f"({_LOCAL_RULES}) -- a nev-ellenorzes NEM fut a kimeno uzeneteken. "
            "Potold a store/outgoing-copy-gate-rules.json-t."))
    sys.exit(0)


def audit(text: str):
    """Return a list of human-readable problems."""
    # COPYGATEENT914 (Marveen merese, 2026-09-14, egy VALODI vevo-levelen): a
    # tag-kiszedes onmagaban megkerulheto HTML-ENTITASSAL. A `&mdash;` (es a
    # szamos `&#8212;` / hex `&#x2014;` alak) atment a kapun, a cimzettnel
    # viszont gondolatjelkent renderel -- vagyis a kapu zoldet mondott arra,
    # amit tilt. Merve mind a harom alakon.
    # A SORREND SZANDEKOS: eloszor a tageket szedjuk ki, AZUTAN dekodolunk.
    # Forditva egy szovegkent mutatott, escape-elt jelolo (`&lt;b&gt;`) valodi
    # tagge dekodolodna, es a TAG.sub kitorolne a szoveg egy darabjat.
    plain = html.unescape(TAG.sub(" ", text))
    problems = []
    if EM_DASH in plain:
        problems.append(
            f"GONDOLATJEL (em dash, U+2014) {plain.count(EM_DASH)} helyen -- allo szabaly, soha nem mehet ki."
        )
    # GATENEVSTRIP921: a nev-szabaly a SAJAT maszkjan fut (NAME_MASK), nem a
    # nyers szovegen es nem a strip_technical kimeneten -- lasd a NAME_MASK
    # feletti indoklast. Igy a kod-spanban/URL-ben allo nevalak atmegy, a
    # toldalekos prozai alak ("Nev-val") viszont tovabbra is bukik.
    bad = BAD_NAME.search(strip_for_name(plain)) if BAD_NAME else None
    if bad:
        problems.append(
            f"HELYTELEN NEV: {bad.group(0)!r} -- a lokal nev-szabaly (store/outgoing-copy-gate-rules.json) szerint helytelen alak; a helyes irast a szabaly-fajl correction mezoje adja." + _name_correction()
        )
    prose = strip_technical(plain)
    # DUPLA KOTOJEL gondolatjel-potlokent (Szabi 2. eszrevetele, 2026-08-16): a
    # " -- " prozaban ugyanugy zavaro, mint a tiltott em dash. A PROZAN merjuk
    # (strip_technical utan), igy a kodreszletek/parancsok --flag alakjai nem
    # erintettek -- azok amugy sem " -- " alakuak (nincs szokoz a kotojelek
    # utan), de a technikai regiok kivagasa a biztos hatar.
    # STRIPDASH1109: a szamlalas a szokoz nelkuli helyorzos kivagason fut, mert a
    # szokozos kivagas maga is letre tudta hozni a " -- " mintat.
    dh = strip_technical_closed(plain).count(" -- ")
    if dh:
        problems.append(
            f"DUPLA KOTOJEL gondolatjel-potlokent {dh} helyen (' -- ') -- Szabi jelzese: "
            "ugyanugy zavaro, mint az em dash. Ird at kotojel nelkul: kettospont, zarojel, vagy uj mondat."
        )
    # ENDASHGATE1030 (2026-10-30): a szokozzel korulvett EN DASH (" – ", U+2013) a
    # magyar gondolatjel tipikus alakja, es eddig atment (a kapu csak az em dash-t
    # es a " -- "-t nezte). A PROZAN merjuk, mint a dupla kotojelet. A szo utani,
    # vizszintes szokozzel (NBSP, tab is) kezdodo en dash szamit, ha utana szokoz es
    # szo, vagy a sor vege jon. Nem gondolatjel: a szokoz nelkuli tartomany ("10–12"),
    # a sor eleji felsorolasjel ("– elem"), es az idosav/datumtartomany ("10:00 –
    # 12:00", "oktober 30. – november 2."): tartomany, nem gondolatjel (Samu
    # 55873/55879; spaced_en_dashes). Az &ndash; entitas a fenti html.unescape
    # miatt ugyanide jut.
    ed = spaced_en_dashes(prose)
    if ed:
        problems.append(
            f"GONDOLATJEL (en dash szokozokkel, ' – ', U+2013) {ed} helyen -- a gondolatjel tilos. "
            "Ird at: kettospont, zarojel, vagy uj mondat. Idosav es datumtartomany (10:00 – 12:00, 10–12) tartomany, nem gondolatjel: az maradhat."
        )
    # 4. ellenorzes (GATEHOMOGLIF816): vegyes irasrendszeru szo. SZANDEKOSAN
    # NEM magyar-kapuzott (elteres Marveen specjetol, ervvel): az FP-vedelem
    # maga a VEGYES-szo szabaly -- egy legitim idegen idezet szavai TISZTA
    # nem-latin betusek, sosem vegyesek. A magyar-kapu itt semmit nem vedene,
    # viszont lyukat utne: egy 2-markeres, hibatlanul ekezetes magyar szoveg
    # homoglifaja atcsuszna (merve: a 'kerlek+koszonom' paros keves a
    # nyelv-detektorhoz). A konkret szot ES karaktert nevezzuk meg, mert a
    # hiba szemre lathatatlan -- enelkul a javitas talalgatas lenne.
    try:
        mixed = mixed_script_words(prose)
    except MixedScriptUnavailable as exc:
        problems.append(
            "A VEGYES-IRASRENDSZER SZABALY NEM TOLTHETO BE "
            f"(scripts/lib/mixed_script.py: {exc}). Ez NEM homoglifa-talalat: a "
            "szabaly meg sem futott, tehat a szovegrol semmit nem tudunk. "
            "Szandekosan fail-closed."
        )
        mixed = []
    if mixed:
        shown = "; ".join(f"{w!r} -- benne {name}" for w, _c, name in mixed[:5])
        more = f" (+{len(mixed) - 5} tovabbi)" if len(mixed) > 5 else ""
        problems.append(
            f"VEGYES IRASRENDSZERU SZO (homoglifa), {len(mixed)} db: {shown}{more}. "
            "Latin szoba keveredett nem-latin betu: olvasva lathatatlan, de a keresest/grepet neman eltori."
        )
    # EKEZETMASZK1018: the accent check runs on the text after the ADDITIONAL identifier mask (anchor, flag, /path);
    # the homoglyph and double-hyphen rules above still see the TECHNICAL-masked prose, unchanged.
    accent_prose = strip_for_accent(prose)
    tok_pos = accent_check_tokens(accent_prose)
    words = [w for w, _ in tok_pos]
    if is_hungarian(plain) or accentless_evidence(tok_pos, accent_prose):
        hits = sorted({w for w in words if w in ACCENTLESS})
        # Az aranyot is a prozan merjuk: a technikai tokenekben nincs ekezet, tehat
        # egy kodban gazdag, egyebkent helyes level aranyat lefele huznak.
        letters = sum(1 for ch in accent_prose if ch.isalpha())
        acc = sum(1 for ch in accent_prose if ch in ACCENTED)
        ratio = (acc / letters) if letters else 0.0
        if hits:
            first_pos = {}
            for w, p in tok_pos:
                if w in ACCENTLESS and w not in first_pos:
                    first_pos[w] = p
            shown = ", ".join(
                f"{h} -> {ACCENTLESS[h]} ({_hit_context(accent_prose, first_pos[h], len(h))})"
                for h in hits[:12]
            )
            more = f" (+{len(hits) - 12} tovabbi)" if len(hits) > 12 else ""
            problems.append(f"HIANYZO EKEZETEK, {len(hits)} szo: {shown}{more}")
        elif letters > 200 and ratio < 0.01:
            problems.append(
                f"MAGYAR SZOVEG GYAKORLATILAG EKEZET NELKUL (ekezet-arany {ratio:.3%}, {letters} betun). "
                "A szolistam nem talalt konkret talalatot, de az arany onmagaban gepi atirasra utal -- olvasd vissza."
            )
    return problems


# Outbound-shaped operations of the multiplexed manage_email tool. Everything
# else it does (search, read, labels, trash, getAttachment...) produces no text
# of ours, so the gate must not touch it -- classifying those as sends is how
# the sibling email gate once denied plain mailbox READS (MANAGEOP904).
# "new" is the `email` MCP server's word for a fresh letter on its `messages`
# multiplexer (EMAILMESSAGESMUX1108, measured 2026-11-08 on a letter that went out
# with no audit). The dispatch already reads `action` next to `operation`, so the
# only thing missing was the word itself.
MANAGE_EMAIL_OUTBOUND_OPS = {"send", "new", "reply", "replyall", "reply_all", "forward"}
# EMAILMUXFOLLOWUP1111 (Dani's #2635 review, Samu 75811), the same rules as the
# approval gate's manage_email_is_send:
# F1 every op key is read (a decoy `operation` hid `action: "new"`), and an op is
#    normalised (lower case, '-' -> '_'), so `reply-all` / `Reply_All` are audited;
# F3 the `email` server's `messages` tool is judged by an ALLOW list of the reads
#    measured on the live install; any other operation is outbound text and audited.
MANAGE_EMAIL_OP_KEYS = ("operation", "action")
EMAIL_MUX_READ_OPS = frozenset({
    "search", "read", "mark_read", "mark_unread", "flag", "unflag", "move", "archive", "trash"})


def multiplexer_ops(tool_input) -> list:
    ops = []
    for key in MANAGE_EMAIL_OP_KEYS:
        value = tool_input.get(key) if isinstance(tool_input, dict) else None
        if isinstance(value, str) and value.strip():
            ops.append(value.strip().lower().replace("-", "_"))
    return ops

# Dedicated (non-multiplexed) outbound tools: the draft tools and the Gmail
# connector's three separate send-shaped tools. Kept in step with the matcher
# this hook is registered under in settings.json.
# GMAILCONNECTOR914: the server segment is NOT always exactly "gmail" -- the
# claude.ai connector is mcp__claude_ai_Gmail__send_message, one underscore
# before Gmail, and `(^|__)gmail__` never matched it, so its sends fell through
# to sys.exit(0) with no audit (measured 2026-08-30, 2026-09-08).
# The names are now classified by the shared suffix classifier
# (email_extract.classify_mail_tool), a superset of the pattern that stood here:
# a tool prefix (mcp__gmail__v2_reply_all) or a server without "gmail__" right
# before the base (mcp__server-gmail-autoauth-mcp__reply_all) no longer moves a
# send out of the audit. EMAIL_TOOL_RE stays for importers only.
EMAIL_TOOL_RE = re.compile(
    r"(send_email|create_draft|draft_email|update_draft"
    r"|gmail__(reply|reply_all|send_message|forward)$)",
    re.I,
)
# The kinds whose payload carries OUR text and is audited here. send_draft is
# deliberately NOT one of them: it carries only a draftId, so there is no text
# of ours in the call (the draft's text was audited when it was written), and
# an empty payload would turn every send_draft into a permanent fail-closed
# deny, overruling the approval gate's level decision for it.
_AUDITED_MAIL_KINDS = ("send_email", "connector_send", "draft")


# --- Inter-agent messages: HOMOGLYPH-ONLY (INTERAGENTHOMOGLIF923) -----------
# `curl .../api/messages` is NOT an email send (send-invocation-cases.json pins
# it expected:false, and that stays), so none of the copy rules below ever ran
# on it: no accent audit, no name rule, no em dash -- correctly, because the
# fleet's internal traffic is written WITHOUT accents and the full audit would
# block most of it. One dimension is added here and nothing else: a MIXED-SCRIPT
# word (homoglyph). The fleet coordinates by card ids, agent names and file
# paths passed in messages; a Cyrillic 'a' in one of those does not look wrong,
# it silently points at something that does not exist. Measured 2026-09-16:
# four such characters in the lead agent's own messages, caught only by a
# manual scan.
#
# FAILURE DIRECTION IS THE OPPOSITE OF THE EMAIL BRANCH (Marveen, msg 28870):
#   - homoglyph FOUND           -> BLOCK (exit 2), naming the word and the char;
#   - body NOT INTERPRETABLE     -> PASS, with a loud named systemMessage and a
#     (unreadable path, $-path,     gate-log line. On this channel a false block
#     run-time substitution,        mutes an agent (the fleet's coordination
#     non-object JSON, unknown      backbone); the threat is our own agent
#     shape)                        emitting a lookalike by accident, not an
#                                   attacker, so fail-open-loud is the right side.
# All three shapes are covered, or the concept is not closed: quoted heredoc
# (`--data-binary @- <<'JSON'`), `@file`, and inline `-d '...'`.
_IA_TARGET = re.compile(r"^(https?://)?[^/\s]*/api/messages/?(\?\S*)?$", re.I)
_IA_DATA_FLAGS = ("-d", "--data", "--data-binary", "--data-raw", "--data-ascii", "--json")
_IA_SUBST = re.compile(r"\$\(|`|\$\{?\w")


def _ia_segment(cmd: str):
    """Tokens of the curl segment that POSTs to /api/messages, or None."""
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        return None
    for toks in segments:
        while toks and _ENV_ASSIGN.match(toks[0]):
            toks = toks[1:]
        if toks and _CURLISH.match(_basename(toks[0])) and any(_IA_TARGET.match(t) for t in toks[1:]):
            return toks
    return None


# The fleet's everyday form is `S=/abs/scratch; ... --data-binary @$S/m.json`:
# the variable is assigned a LITERAL earlier in the SAME command string. That
# is deterministic, so it is resolved here instead of warned about. Measured
# 2026-09-23 over 1153 real inter-agent POSTs: without this, most of the
# warnings were exactly this shape, and a warning that fires on half the
# traffic is noise. Only a plain literal value counts (no quotes-with-$,
# no substitution); anything else stays unresolved and is warned about.
_IA_ASSIGN = re.compile(r"""(?:^|[;&|\n(]\s*|\s)(?:export\s+)?([A-Za-z_]\w*)=(?:"([^"$`]*)"|'([^']*)'|([^\s;&|$`'"()]+))""")


def _ia_resolve_local_vars(cmd: str, ref: str) -> str:
    local = {}
    for m in _IA_ASSIGN.finditer(cmd):
        local[m.group(1)] = next(g for g in m.groups()[1:] if g is not None)
    def sub(m):
        name = m.group(1) or m.group(2)
        return local.get(name, m.group(0))
    return re.sub(r"\$\{(\w+)\}|\$(\w+)", sub, ref)


def _curl_payload_raw(cmd: str, toks, all_flags: bool = False):
    """(raw_body, unreadable_reason) of a curl data flag, from the three shapes
    (inline -d, @file, quoted heredoc via @-). raw_body is None when the call
    carries no data flag at all. Shared by the inter-agent homoglyph gate and
    the HTTP channel gate (GATEHTTP924), so both read the SAME body the same way.
    all_flags: curl joins repeated -d values with '&' (a form body such as
    `-d chat_id=1 -d text=...`); the HTTP gate needs every part, or the text
    field hides behind the first flag. The inter-agent gate keeps first-only."""
    raw = None
    parts = []
    for i, t in enumerate(toks):
        val = None
        for f in _IA_DATA_FLAGS:
            if t == f and i + 1 < len(toks):
                val = toks[i + 1]
            elif t.startswith(f + "="):
                val = t[len(f) + 1:]
            elif f == "-d" and t.startswith("-d") and len(t) > 2 and not t.startswith("--"):
                val = t[2:]
            if val is not None:
                is_raw_flag = f == "--data-raw"
                break
        if val is None:
            continue
        if val.startswith("@") and not is_raw_flag:
            ref = val[1:]
            if ref == "-":
                m = re.search(r"<<-?\s*'?(\w+)'?[^\n]*\n(.*?)\n\1(?=\s|$)", cmd, re.S)
                if not m:
                    return None, "a torzs stdin-rol jon (@-), heredoc nelkul"
                if not re.search(r"<<-?\s*'", cmd) and _IA_SUBST.search(m.group(2)):
                    return None, "a heredoc NEM idezett, es shell-behelyettesitest tartalmaz"
                raw = m.group(2)
            else:
                path = os.path.expandvars(os.path.expanduser(_ia_resolve_local_vars(cmd, ref)))
                if "$" in path:
                    return None, f"a torzs fel nem oldhato @utvonalrol jon (@{ref})"
                try:
                    with open(path, encoding="utf-8", errors="replace") as fh:
                        raw = fh.read()
                except OSError as exc:
                    return None, f"a torzs-fajl (@{ref}) nem olvashato ({exc.strerror or exc})"
        else:
            if _IA_SUBST.search(val):
                return None, "az inline torzs shell-behelyettesitest tartalmaz, futasidoben dol el"
            raw = val
        if not all_flags:
            break
        parts.append(raw)
    if all_flags and parts:
        return "&".join(parts), None
    return raw, None


def _ia_payload(cmd: str, toks):
    """(text, unreadable_reason) of the message body, from the three shapes."""
    raw, unreadable = _curl_payload_raw(cmd, toks)
    if unreadable:
        return None, unreadable
    if raw is None:
        # No data flag at all: a GET of the queue (the most frequent call on this
        # path) or a bare POST. Nothing is being SENT, so nothing to scan and
        # nothing to warn about -- a warning here would fire on every queue read.
        return "", None
    try:
        obj = json.loads(raw)
    except ValueError:
        return None, "a torzs nem ervenyes JSON"
    if not isinstance(obj, dict):
        return None, "a torzs JSON, de nem objektum"
    # EVERY string field: a lookalike in `to` misroutes as silently as one in
    # `content` misleads.
    strings = [str(v) for v in obj.values() if isinstance(v, str)]
    return "\n".join(strings), None


def inter_agent_homoglyph_gate(cmd: str) -> None:
    """Exit 2 on a homoglyph, exit 0 otherwise (loudly when unreadable).
    Only called for a command that is NOT an email send."""
    toks = _ia_segment(cmd)
    if toks is None:
        sys.exit(0)
    text, unreadable = _ia_payload(cmd, toks)
    if unreadable:
        msg = ("outgoing-copy-gate (inter-agent, homoglifa): a torzs NEM vizsgalhato -- "
               f"{unreadable}. Az uzenet ATMENT, homoglifa-ellenorzes NELKUL. "
               "Vizsgalhato alak: idezett heredoc (--data-binary @- <<'JSON') vagy @/abszolut/ut.json.")
        _gate_log(msg)
        print(pass_with_warning(msg))
        sys.exit(0)
    try:
        mixed = mixed_script_words(text)
    except MixedScriptUnavailable as exc:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU (inter-agent): TILTVA -- a vegyes-irasrendszer szabaly "
            f"NEM TOLTHETO BE (scripts/lib/mixed_script.py: {exc}).\n"
            "Ez nem a szovegrol szol: a szabaly meg sem futott. Szandekosan fail-closed, "
            "mert egy le nem futott ellenorzes nem 'rendben'.\n"
        )
        sys.exit(2)
    if mixed:
        shown = "; ".join(f"{w!r} -- benne {name}" for w, _c, name in mixed[:5])
        more = f" (+{len(mixed) - 5} tovabbi)" if len(mixed) > 5 else ""
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU (inter-agent): TILTVA -- VEGYES IRASRENDSZERU SZO (homoglifa), "
            f"{len(mixed)} db: {shown}{more}.\n"
            "Egy kartya-azonositoban, agens-nevben vagy utvonalban ez neman felreiranyit. "
            "Javitsd a szoveget es kuldd ujra. (Itt CSAK a homoglifa fut, ekezet- es copy-szabaly nem.)\n"
        )
        sys.exit(2)
    sys.exit(0)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unparseable payload must not wedge the session

    tool = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input") or {}
    # A tool_input that is not a dict crashed every branch on its first .get(),
    # which the Telegram arm then reported as an internal gate error and passed
    # through fail-open. Measured 2026-09-05: the log holds exactly one such
    # line, AttributeError("'int' object has no attribute 'get'"), and a payload
    # with an integer tool_input reproduces it byte for byte. Name the real
    # cause instead of the symptom, and keep each arm's designed failure
    # direction: nothing of ours is readable, so Telegram (the owner's only
    # supervision channel) still passes, email still blocks.
    if not isinstance(tool_input, dict):
        shape = type(tool_input).__name__
        gated = (re.search(r"telegram.*__reply$", tool, re.I)
                 or classify_mail_tool(tool) is not None
                 or tool == "Bash")
        if not gated:
            sys.exit(0)  # not a send: the net must never widen the gate
        _gate_log(f"outgoing-copy-gate: a tool_input nem szotar, hanem {shape} "
                  f"-- a vizsgalat nem futtathato (tool={tool!r}).")
        if re.search(r"telegram.*__reply$", tool, re.I):
            # Telegram stays fail-open by design, but not silently.
            print(pass_with_warning(
                f"outgoing-copy-gate: a Telegram-hivas tool_input mezoje nem szotar, hanem {shape} "
                "-- FAIL-OPEN atengedes, ez az uzenet a szoveg-ellenorzes NELKUL ment ki."))
            sys.exit(0)
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA, a hivas tool_input mezoje nem szotar, hanem "
            f"{shape} -- a kimeno szoveg igy nem olvashato ki, tehat nem vizsgalhato.\n"
            "Fail-closed: egy vizsgalhatatlan kuldes pont a kaput utne ki. "
            "Hivd ujra rendes parameterekkel.\n"
        )
        sys.exit(2)

    # GATECOPY828 (#1184): the scaffold wires this hook onto reply AND
    # edit_message (an edit can replace a working code block with a broken
    # one). The dispatch must recognise BOTH, or the edit half of the matcher
    # invokes a hook that exits 0 without auditing anything.
    if re.search(r"telegram.*__(reply|edit_message)$", tool, re.I):
        channel_gate(tool_input, "Telegram", unescape_mdv2=True)  # exits; never falls through
    if re.search(r"discord.*__(reply|edit_message)$", tool, re.I):
        # GATEDISCORD905: an install whose owner DM and every working thread run
        # on Discord had no gate on that path at all -- same audit, no MarkdownV2
        # unescaping (on Discord a backslash is a literal the author typed).
        channel_gate(tool_input, "Discord", unescape_mdv2=False)  # exits; never falls through
    # COPYGATEMATCHER904: the hook is REGISTERED for manage_email, create_draft,
    # update_draft and the Gmail connector's reply/send_message/forward tools,
    # but this dispatch only ever recognised a tool NAME containing
    # "send_email" -- so on an install whose email tool is the multiplexed
    # mcp__google-workspace__manage_email, every letter fell through to
    # sys.exit(0) and the copy audit NEVER ran on an outgoing email. Measured
    # 2026-09-04: an em dash in a manage_email draft body passed the gate,
    # while the same text was blocked on the Telegram path. Same class as the
    # email-send-gate's MANAGEOP904 fix: a multiplexer cannot be classified by
    # its name, only by the operation it was asked to perform.
    mail_kind = classify_mail_tool(tool)
    if mail_kind == "manage_email":
        ops = multiplexer_ops(tool_input)
        if str(tool or "").lower().replace("-", "_").endswith("email__messages"):
            outbound = [o for o in ops if o not in EMAIL_MUX_READ_OPS]
            if ops and not outbound:
                sys.exit(0)  # every named operation is a measured read: no outgoing text of ours
            op = outbound[0] if outbound else ""
        else:
            outbound = [o for o in ops if o in MANAGE_EMAIL_OUTBOUND_OPS]
            if not outbound:
                sys.exit(0)  # search/read/labels/trash...: no outgoing text of ours
            op = outbound[0]
        # A bare forward carries someone else's text and an EMPTY note: there is
        # nothing of ours to audit, and the fail-closed "unreadable" branch below
        # would block it for no reason.
        if op == "forward" and not str(tool_input.get("body") or "").strip():
            sys.exit(0)
        text, unreadable = collect_mcp_body(tool_input), None
    elif mail_kind in _AUDITED_MAIL_KINDS:
        # MS365MAIL1024: update-mail-message / update-shared-mailbox-message are
        # drafts that may carry only a flag (isRead) or a changed field, not a
        # letter -- with no text there is nothing of ours to audit, and the
        # fail-closed "no inspectable text" branch below would block the read
        # flag flip for no reason. SECURITY review on MS365MAIL1024, round 2: the
        # Graph read is chosen by the tool NAME (is_ms365_tool), so a non-Graph
        # tool with an object body is audited on its flat fields and a Graph
        # tool without a Graph shape still is; a Graph call is read through
        # ms365_text_checked, so a case-duplicate key (a "Subject" next to a
        # "subject") is unreadable here, not "no text"; an update tool skips the
        # audit only when it is readable AND carries no text.
        is_update = (str(tool or "").lower().replace("-", "_")
                     .endswith(("update_mail_message", "update_shared_mailbox_message")))
        if is_ms365_tool(tool):
            text, unreadable = ms365_text_checked(tool_input)
            if is_update and not unreadable and not text:
                sys.exit(0)
        else:
            if is_update and not collect_mcp_body(tool_input, tool):
                sys.exit(0)
            if is_harder_mail_tool(tool) and tool_input.get("body_format") not in (None, ""):
                # HARDERMAILGATES1019 (design 6.3a): a formatted harder-mail letter is
                # audited on the text the server renders from it, never on raw markup.
                text, unreadable = collect_harder_mail_text(tool_input)
            else:
                text, unreadable = collect_mcp_body(tool_input, tool), None
    elif tool == "Bash":
        cmd = str(tool_input.get("command") or "")
        if not is_send_invocation(cmd):
            http_channel_gate(cmd)  # exits if it is a human-facing HTTP send; else returns
            inter_agent_homoglyph_gate(cmd)  # exits; a no-op pass for anything else
        text, unreadable = collect_bash_body(cmd)
    else:
        sys.exit(0)

    if unreadable or not text.strip():
        if tool == "Bash" and wrapper_depth_hit(cmd):
            sys.stderr.write(
                "KIMENO-SZOVEG KAPU: TILTVA, mert a parancs valodi fejet nem latom.\n"
                f"Ok: a parancs a burkolo-korlatnal ({_HEAD_DEPTH} egymasba agyazott burkolo: sudo, "
                "time, env, nohup, nice, timeout...) is meg burkolo, tehat nem tudom eldonteni, "
                "hogy levelkuldes-e. Ez szandekosan fail-closed.\n\n"
                f"Ha ez NEM levelkuldes: csokkentsd a burkolok szamat {_HEAD_DEPTH} vagy kevesebb ala.\n"
                "Ha levelkuldes: tedd vizsgalhatova -- ABSZOLUT utvonalu stdin-atiranyitas "
                "(< /teljes/ut/body.txt), vagy --body-ban atadott szoveg.\n"
            )
            sys.exit(2)
        reason = unreadable or "a hook nem talalt vizsgalhato szoveget a hivasban"
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA, mert a levelet nem tudtam megvizsgalni.\n"
            f"Ok: {reason}.\n\n"
            "Ez szandekosan fail-closed: egy vizsgalhatatlan kuldes pont a kaput utne ki.\n"
            "Tedd vizsgalhatova, aztan kuldd ujra -- ABSZOLUT utvonalu stdin-atiranyitas "
            "(< /teljes/ut/body.txt, shell-valtozo NELKUL), vagy --body-ban atadott szoveg.\n"
        )
        sys.exit(2)

    # GATEPERSIST816(2): az EMAIL ut a hianyzo nev-szabalyra FAIL-CLOSED. A
    # level halaszthato, es pont a vevo fele a legdragabb a rossz nev -- egy
    # csendben lealit nev-ellenorzes mellett kuldeni rosszabb, mint megvarni a
    # szabaly-fajl potlasat. (A telegram-ag fail-open marad systemMessage
    # figyelmeztetessel: az a felugyeleti csatorna, ott a nemulas a dragabb.)
    if RULES_STATE == RULES_INVALID:
        # The file EXISTS but cannot be used: someone configured it and got it
        # wrong. Silent enforcement-loss here would be invisible, so this stays
        # fail-closed until the file is repaired (negative control in tests).
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA -- a NEV-SZABALY fajl LETEZIK, de "
            f"ervenytelen ({_LOCAL_RULES}): nem parse-olhato JSON, rossz sema "
            "vagy hibas regex.\n"
            "Javitsd a fajlt (bad_name_patterns: [regex, ...] + correction), "
            "aztan kuldd ujra.\n"
        )
        sys.exit(2)

    problems = audit(text)
    if problems:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA, a levél nem mehet ki így.\n\n"
            + "\n".join(f"  - {p}" for p in problems)
            + "\n\nJavitsd a szoveget es kuldd ujra. Ekezetes magyar szoveg a vevo fele "
              "nem stiluskerdes: Szabi 2026-08-10-en ket kulon esetben kerte szamon.\n"
        )
        sys.exit(2)

    if RULES_STATE in (RULES_MISSING, RULES_EMPTY):
        # Fail-OPEN, but never silent: the send goes out WITHOUT the name
        # check, and the user must see that on the surface they are using --
        # a log line nobody reads is the same as nothing (CLCOPYGATEHIANY902).
        print(pass_with_warning(
            "outgoing-copy-gate: a NEV-SZABALY fajl "
            + ("HIANYZIK" if RULES_STATE == RULES_MISSING else "URES (nincs minta)")
            + f" ({_LOCAL_RULES}) -- ez a level a nev-ellenorzes NELKUL ment ki. "
            "Ha kell a vedelem, hozd letre a fajlt: "
            '{"bad_name_patterns": ["<python-regex>"], "correction": "<helyes alak>"}.'))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate blanket: fail-closed net
        # An unhandled crash exits 1, and PreToolUse treats 1 as NON-blocking,
        # so the send would run UNCHECKED -- the exact opposite of the email
        # path's fail-closed contract (e.g. a non-dict tool_input used to
        # AttributeError inside collect_mcp_body). The channel paths never
        # reach here: channel_gate() catches its own errors and exits 0
        # (fail-open by design), so this net only ever catches the email/Bash
        # send paths, where blocking is the safe failure mode.
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA, belso hiba a vizsgalat kozben "
            f"({exc!r}).\n"
            "Fail-closed: egy vizsgalhatatlan kuldes pont a kaput utne ki. "
            "Tedd vizsgalhatova a hivast, aztan kuldd ujra.\n"
        )
        sys.exit(2)
