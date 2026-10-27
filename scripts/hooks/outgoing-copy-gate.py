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
    szegmens-hatarkent lassa; idezojelen BELUL a szoveg erintetlen (tartalom)."""
    out = []
    q = None  # None | "'" | '"'
    i, n = 0, len(cmd)
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
        if ch == "\n" or ch == "`":
            out.append(";"); i += 1; continue
        if ch == "$" and i + 1 < n and cmd[i + 1] == "(":
            out.append(";"); i += 2; continue
        out.append(ch); i += 1
    return "".join(out)


def _segments_tokens(cmd: str):
    """[[token, ...], ...] szegmensenkent -- quote-tudatosan, poziciot orizve."""
    import shlex
    lex = shlex.shlex(_mask_subshell_markers(_HEREDOC.sub(r"\1", cmd)),
                      posix=True, punctuation_chars="();|&")
    lex.whitespace_split = True
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
    "env": ("uCS", ("unset", "chdir", "split-string"), 0),
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
}
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
        if cmd_words[i] != "cd":
            i += 1
            continue
        i += 1
        while i < len(cmd_words) and cmd_words[i] in _CD_OPTIONS:
            i += 1
        if i < len(cmd_words) and cmd_words[i] == "--":
            i += 1  # MAILGATESCRIPT1027 R2: `--` ends the options, the next word is DIR even when it starts with `-`
        d = cmd_words[i] if i < len(cmd_words) else None
        tilde = d is not None and (d == "~" or d.startswith("~/"))
        if (not d or d == "-" or (d.startswith("~") and not tilde) or _UNDECIDABLE_PATH.search(d)):
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


def _shebang_kind(text):
    """'py' | 'node' | None from a #! line (`#!/usr/bin/python3`, `#!/usr/bin/env -S node`)."""
    m = re.match(r"#!\s*(\S+)([^\n]*)", text or "")
    if not m:
        return None
    prog = _basename(m.group(1))
    if prog == "env":
        prog = _basename(next((w for w in m.group(2).split() if not w.startswith("-") and "=" not in w), ""))
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


def _python_module_sends(module, cwd, cmd_words, read_script) -> bool:
    """MAILGATESCRIPT1027 R1: `python -m MOD` runs MOD.py or MOD/__main__.py under cwd or a cd target. An
    installed module cannot be read here, so with no readable candidate it is not a send."""
    if not re.match(r"^[\w.]+$", module):
        return False
    rel = module.replace(".", "/")
    bases, undecidable = _cd_bases(cwd, cmd_words)
    if undecidable:
        return True  # MAILGATESCRIPT1027 R2: a cd that cannot be resolved: fail-closed
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
    if _PYTHON.match(prog):
        if _address_flag_given(rest):  # also under -m / -c, where no file is named
            return True
        module = _python_module(rest)
        if module:
            return _python_module_sends(module, cwd, cmd_words, read_script)
        script = _python_script_operand(rest)[0]
        kind = "py"
    elif _NODEISH.match(prog):
        script = _node_script_operand(prog, rest)
        # MAILGATESCRIPT1027 R1: npx with another package than the tsx / ts-node / node runner form is no script run
        if prog == "npx" and script is None:
            return False
        if _address_flag_given(rest):
            return True
        kind = "node"
    elif _SCRIPT_FILE.search(toks[0]) or "/" in toks[0]:
        # a directly executed file: its #! line picks the interpreter, else its extension
        # MAILGATESCRIPT1027 R1: every candidate is judged on its own, with its own kind
        paths = _resolve_script_paths(toks[0], cwd, cmd_words)
        ext_kind = "py" if re.search(r"\.py$", toks[0], re.I) else "node" if _SCRIPT_FILE.search(toks[0]) else None
        if _relative_under_undecidable_cd(toks[0], cwd, cmd_words):
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
        return True  # the kind is known and no candidate is readable: fail-closed
    else:
        return False
    if script is None:
        return False
    if _UNDECIDABLE_PATH.search(script):
        return True  # what runs is undecidable here: fail-closed
    if _relative_under_undecidable_cd(script, cwd, cmd_words):
        return True  # MAILGATESCRIPT1027 R1: a relative script after a cd that cannot be resolved: fail-closed
    readable, verdict = _judge_candidates(_resolve_script_paths(script, cwd, cmd_words), kind, read_script)
    if readable:
        return verdict
    return bool(_SCRIPT_FILE.search(script) or "/" in script)  # a missing script is a send; `bun test` is not


def script_run_sends(cmd: str, cwd, read_script=None, depth: int = 0, _cd_words=()) -> bool:
    if read_script is None:
        read_script = _read_script_head
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        return False  # unparseable: is_send_invocation's legacy fallback already judged it
    cmd_words = list(_cd_words) + [w for toks in segments for w in toks]
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

# GATEPERSIST816: owner-specific NAME rules load from an UNTRACKED local file,
# not from this (public-repo) script. The generic checks (accents, em dash,
# double hyphen, mixed-script) are universal Hungarian-copy QA and ship in the
# repo; a personal-name rule names a private third party, and that must not be
# published as a side effect of persisting the gate. A missing rules file is
# NOT silent: every run appends a loud line to the gate log, because a
# protection whose absence is invisible only protects until someone touches
# the tree. File shape: {"bad_name_patterns": ["<python-regex>", ...]}
_LOCAL_RULES = os.environ.get(
    "OUTGOING_COPY_GATE_RULES",
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                 "store", "outgoing-copy-gate-rules.json"),
)

_GATE_LOG = os.path.join(os.path.dirname(_LOCAL_RULES), "outgoing-copy-gate.log")


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
        \d+(?:[.:,]\d+)*-[^\W\d_]+   # szam + magyar toldalek (8:09-es, 2-es, 17:06-kor)
      | \b[A-ZÁÉÍÓÖŐÚÜŰ][^\W\d_]*-[a-záéíóöőúüű]{1,4}\b   # tulajdonnev + toldalek (Chrome-ot, Drive-ra)
      | \blevel\s+\d+\b            # angol "level 1" (autonomia-szint, log-szint)
      | \b[a-z]+(?:-[a-z]+){1,4}\b    # kotojeles kisbetus azonosito (feladat- es skill-nevek)
"""
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
        warn = f"outgoing-copy-gate: HTTP-csatorna-ag ({label}) belso hiba, FAIL-OPEN atengedes: {exc!r}"
        sys.stderr.write(warn + "\n")
        _gate_log(warn)
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
        warn = f"outgoing-copy-gate: {label.upper()}-ag belso hiba, FAIL-OPEN atengedes: {exc!r}"
        sys.stderr.write(warn + "\n")
        _gate_log(warn)
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
        print(json.dumps({"systemMessage":
            "outgoing-copy-gate: a NEV-SZABALY fajl hianyzik/ures "
            f"({_LOCAL_RULES}) -- a nev-ellenorzes NEM fut a kimeno uzeneteken. "
            "Potold a store/outgoing-copy-gate-rules.json-t."}))
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
    dh = prose.count(" -- ")
    if dh:
        problems.append(
            f"DUPLA KOTOJEL gondolatjel-potlokent {dh} helyen (' -- ') -- Szabi jelzese: "
            "ugyanugy zavaro, mint az em dash. Ird at kotojel nelkul: kettospont, zarojel, vagy uj mondat."
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
MANAGE_EMAIL_OUTBOUND_OPS = {"send", "reply", "replyall", "forward"}

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
        print(json.dumps({"systemMessage": msg}))
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
            sys.exit(0)  # Telegram stays fail-open by design
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
        op = str(tool_input.get("operation") or tool_input.get("action") or "").strip().lower()
        if op not in MANAGE_EMAIL_OUTBOUND_OPS:
            sys.exit(0)  # search/read/labels/trash...: no outgoing text of ours
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
        print(json.dumps({"systemMessage":
            "outgoing-copy-gate: a NEV-SZABALY fajl "
            + ("HIANYZIK" if RULES_STATE == RULES_MISSING else "URES (nincs minta)")
            + f" ({_LOCAL_RULES}) -- ez a level a nev-ellenorzes NELKUL ment ki. "
            "Ha kell a vedelem, hozd letre a fajlt: "
            '{"bad_name_patterns": ["<python-regex>"], "correction": "<helyes alak>"}.'}))
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
