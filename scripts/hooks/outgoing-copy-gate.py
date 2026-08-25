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
  1. Hungarian text that is missing its accents (the incident above).
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
_SENDER_PROG = re.compile(r"^(sendmail|msmtp|swaks)$", re.I)
_SENDPY = re.compile(r"^send\.py$", re.I)
_PYTHON = re.compile(r"^python3?$", re.I)
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
_CODE_EXECISH = re.compile(
    r"\bsubprocess\b|os\.system|\bpopen\b|child_process|\bexec[A-Za-z]*\s*\(|\bspawn[A-Za-z]*\s*\(",
    re.I,
)
_CODE_SENDER_LIT = re.compile(r"sendmail|msmtp|swaks|send\.py", re.I)


def _code_string_sends(code: str) -> bool:
    if _CODE_SEND.search(code):
        return True
    return bool(_CODE_EXECISH.search(code) and _CODE_SENDER_LIT.search(code))
# Token-ELEJERE horgonyzott cel-minta: egy URL-argumentum vagy csupasz
# domain/utvonal illik ra; egy JSON-payload ('{...api.resend.com...}') nem.
_RESEND_TARGET = re.compile(r"^(https?://)?([^/@\s]*\.)?api\.resend\.com(/|$|\s|$)", re.I)
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
        if tok in ("|", "||", "&", "&&", ";", "(", ")", ";;", "|&"):
            if cur:
                segments.append(cur)
            cur = []
        else:
            cur.append(tok)
    if cur:
        segments.append(cur)
    return segments


def _segment_is_send(toks, depth: int) -> bool:
    while toks and _ENV_ASSIGN.match(toks[0]):
        toks = toks[1:]
    if not toks:
        return False
    prog = _basename(toks[0])
    rest = toks[1:]
    if _SENDER_PROG.match(prog):
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
            if t in ("-c", "-e", "--eval") and i + 1 < len(rest) and _code_string_sends(rest[i + 1]):
                return True
    # send.py futtatasa (kozvetlenul, vagy python/runner utan) --to cimzettel
    candidates = [prog] + (
        [_basename(rest[0])] if rest and (_PYTHON.match(prog) or _NODEISH.match(prog)) else []
    )
    if any(_SENDPY.match(c) for c in candidates) and any(
        t == "--to" or t.startswith("--to=") for t in rest
    ):
        return True
    # graph-mail kimeno alparanccsal (tsx/node runner utan is)
    if any(_GRAPHMAIL.match(_basename(t)) for t in toks) and "send" in rest:
        return True
    # curl/wget: a cel-token akkor is muvelet, ha idezojelben allt -- a
    # horgonyzott minta valasztja el a payload-belseji emlitestol
    if _CURLISH.match(prog) and any(_RESEND_TARGET.match(t) for t in rest):
        return True
    return False


def is_send_invocation(cmd: str, _depth: int = 0) -> bool:
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        # Parse-hiba (pl. lezaratlan idezojel): nem tudunk poziciot mondani.
        # Konzervativ visszaeses: csak akkor auditalunk, ha eros kuldes-literal
        # all a szovegben -- igy egy fura, de valodi kuldes nem csuszik at
        # neman, a tipikus belso parancsok viszont nem kapnak hamis pozitivot.
        return bool(_FALLBACK_LITERALS.search(cmd))
    return any(_segment_is_send(toks, _depth) for toks in segments)

# --- Hungarian detection (accent-insensitive markers) -----------------------
# These fire on both the correct and the stripped spelling, so a transliterated
# mail is still recognised as Hungarian -- that is the whole point.
HU_MARKERS = [
    "hogy", "nem", "vagy", "amit", "ami", "mert", "ezt", "ez a", "van", "lesz",
    "kell", "tehat", "tehát", "koszonom", "köszönöm", "szia", "sziasztok",
    "kerlek", "kérlek", "csatolva", "udvozlettel", "üdvözlettel", "levelet",
    "level", "kuldom", "küldöm", "jelezz", "irj", "írj", "mar", "már", "csak",
]

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
}

# GATEHOMOGLIF816 (2026-08-16, Marveen merese): 33 cirill homoglifa ult a
# memoria-sorokban es kartya-cimekben -- olvasva lathatatlan, de a grep/FTS
# nema nulla-talalatot ad, ami hianyzo emleknek latszik, nem serult adatnak.
# A szabaly a VEGYES SZORA vonatkozik (egy szon belul latin ES nem-latin betu),
# nem a cirill puszta jelenletere -- egy szandekosan idegen nyelvu idezet
# tiszta nem-latin szavai atmennek. Unicode-tudatos tokenizalas kell: a WORD
# regex latin-only, egy homoglifas szot darabokra vagna.
UWORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def _char_script(ch: str) -> str:
    import unicodedata
    try:
        return unicodedata.name(ch).split(" ")[0]
    except ValueError:
        return "UNKNOWN"


def mixed_script_words(text: str):
    """Return [(word, bad_char, bad_char_name), ...] for words mixing LATIN
    with any other script. Pure non-Latin words (foreign quotes) pass."""
    import unicodedata
    out = []
    for word in UWORD.findall(text):
        scripts = {_char_script(ch) for ch in word}
        if "LATIN" in scripts and len(scripts) > 1:
            bad = next(ch for ch in word if _char_script(ch) != "LATIN")
            try:
                bad_name = unicodedata.name(bad)
            except ValueError:
                bad_name = "UNKNOWN"
            out.append((word, bad, f"{bad_name} (U+{ord(bad):04X})"))
    return out


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


def load_bad_name():
    try:
        with open(_LOCAL_RULES, encoding="utf-8") as fh:
            pats = json.load(fh).get("bad_name_patterns") or []
        if pats:
            return re.compile("|".join(pats))
    except OSError:
        pass
    except Exception:
        pass
    try:
        log_path = os.path.join(os.path.dirname(_LOCAL_RULES), "outgoing-copy-gate.log")
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(f"outgoing-copy-gate: NEV-SZABALY FAJL HIANYZIK/URES ({_LOCAL_RULES}) -- "
                     "a nev-ellenorzes NEM fut; potold a store/outgoing-copy-gate-rules.json-t.\n")
    except OSError:
        pass
    return None


def _name_correction() -> str:
    try:
        with open(_LOCAL_RULES, encoding="utf-8") as fh:
            corr = json.load(fh).get("correction") or ""
        return (" " + corr) if corr else ""
    except Exception:
        return ""


BAD_NAME = load_bad_name()
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
# osztaly, mint a 2026-08-11-i `level` fajlnev-talalat. A javitas nem a szotarbol
# vesz ki (az elrontana a valodi talalatokat is), hanem a technikai regiokat
# vagja ki a vizsgalt szovegbol. A gondolatjel- es nev-ellenorzes NEM ezen fut.
TECHNICAL = re.compile(
    r"""https?://\S+                # URL
      | [\w.+-]+@[\w-]+\.[\w.]+     # email
      | `[^`]*`                     # kod-span
      | \b\w+(?:_\w+)+\b            # snake_case azonosito
      | \b\w+\.[A-Za-z]{2,10}\b     # fajlnev / domain (video.mp4, marveen.io)
      | \b[\w-]*/[\w/-]+            # utvonal / slug
    """,
    re.X,
)


def strip_technical(text: str) -> str:
    return TECHNICAL.sub(" ", text)


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
AMBIGUOUS_TRIGGER = {
    "es", "ar", "arak", "ev", "evi", "ot", "uj", "ujat", "het", "ora", "mas",
    "all", "level", "video", "netto",
}


def accentless_evidence(words):
    return {w for w in words if w in ACCENTLESS and w not in AMBIGUOUS_TRIGGER}


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
    redirect = re.search(r"(?<!<)<(?!<)\s*([^\s|;&<>]+)", cmd)
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
    if not parts and re.search(r"\|\s*(python3?|node|tsx)?[^|]*send", cmd):
        return ("", "a torzs egy pipe-bol jon, a hook nem latja")
    return ("\n".join(parts), None)


def collect_mcp_body(tool_input: dict):
    fields = ("body", "text", "html", "htmlBody", "message", "subject", "content")
    got = [str(tool_input[f]) for f in fields if tool_input.get(f)]
    return "\n".join(got)


# --- Telegram reply (GATETG816) ---------------------------------------------
# The reply tool sends MarkdownV2, where every special char arrives escaped
# (\. \( \) \-). Those backslashes sit inside the prose the audit reads, and
# they can split technical tokens or glue fragments in ways the email path
# never sees. Un-escape (backslash before a non-word char) BEFORE auditing --
# this is analysis-only, the outgoing payload is untouched.
MDV2_ESCAPE = re.compile(r"\\([^\w\s])")


def collect_telegram_body(tool_input: dict) -> str:
    fields = ("text", "caption", "message")
    got = [str(tool_input[f]) for f in fields if tool_input.get(f)]
    return MDV2_ESCAPE.sub(r"\1", "\n".join(got))


def telegram_gate(tool_input: dict) -> None:
    """Audit a Telegram reply. FAIL-OPEN on any internal error (exit 0 + loud
    log): email is deferrable, but Telegram is the owner's ONLY supervision
    channel -- a gate crash that silences it costs more than a slipped accent.
    A FOUND problem still blocks (exit 2): that is the gate's whole point."""
    try:
        text = collect_telegram_body(tool_input)
        if not text.strip():
            sys.exit(0)  # files-only reply or empty text: nothing to audit
        problems = audit(text)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate blanket: fail-open path
        warn = f"outgoing-copy-gate: TELEGRAM-ag belso hiba, FAIL-OPEN atengedes: {exc!r}\n"
        sys.stderr.write(warn)
        try:
            log_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__)))), "store", "outgoing-copy-gate.log")
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(warn)
        except OSError:
            pass
        sys.exit(0)
    if problems:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU (Telegram): TILTVA, az uzenet nem mehet ki igy.\n\n"
            + "\n".join(f"  - {p}" for p in problems)
            + "\n\nJavitsd a szoveget es kuldd ujra (a MarkdownV2 escape-eket a kapu "
              "az ellenorzes elott feloldja, azok nem szamitanak hibanak).\n"
        )
        sys.exit(2)
    # GATEPERSIST816(2): a hianyzo nev-szabaly a telegram-agon fail-open marad,
    # de a figyelmeztetes ODA megy, ahol a session tenyleg latja -- a hook
    # stdout systemMessage mezoje a futo sessionben jelenik meg, nem egy
    # logfajlban, amit senki nem olvas.
    if BAD_NAME is None:
        print(json.dumps({"systemMessage":
            "outgoing-copy-gate: a NEV-SZABALY fajl hianyzik/ures "
            f"({_LOCAL_RULES}) -- a nev-ellenorzes NEM fut a kimeno uzeneteken. "
            "Potold a store/outgoing-copy-gate-rules.json-t."}))
    sys.exit(0)


def audit(text: str):
    """Return a list of human-readable problems."""
    plain = TAG.sub(" ", text)
    problems = []
    if EM_DASH in plain:
        problems.append(
            f"GONDOLATJEL (em dash, U+2014) {plain.count(EM_DASH)} helyen -- allo szabaly, soha nem mehet ki."
        )
    bad = BAD_NAME.search(plain) if BAD_NAME else None
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
    mixed = mixed_script_words(prose)
    if mixed:
        shown = "; ".join(f"{w!r} -- benne {name}" for w, _c, name in mixed[:5])
        more = f" (+{len(mixed) - 5} tovabbi)" if len(mixed) > 5 else ""
        problems.append(
            f"VEGYES IRASRENDSZERU SZO (homoglifa), {len(mixed)} db: {shown}{more}. "
            "Latin szoba keveredett nem-latin betu: olvasva lathatatlan, de a keresest/grepet neman eltori."
        )
    tok_pos = accent_check_tokens(prose)
    words = [w for w, _ in tok_pos]
    if is_hungarian(plain) or accentless_evidence(words):
        hits = sorted({w for w in words if w in ACCENTLESS})
        # Az aranyot is a prozan merjuk: a technikai tokenekben nincs ekezet, tehat
        # egy kodban gazdag, egyebkent helyes level aranyat lefele huznak.
        letters = sum(1 for ch in prose if ch.isalpha())
        acc = sum(1 for ch in prose if ch in ACCENTED)
        ratio = (acc / letters) if letters else 0.0
        if hits:
            first_pos = {}
            for w, p in tok_pos:
                if w in ACCENTLESS and w not in first_pos:
                    first_pos[w] = p
            shown = ", ".join(
                f"{h} -> {ACCENTLESS[h]} ({_hit_context(prose, first_pos[h], len(h))})"
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


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unparseable payload must not wedge the session

    tool = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input") or {}

    if re.search(r"telegram.*__reply$", tool, re.I):
        telegram_gate(tool_input)  # exits; never falls through
    if re.search(r"send_email", tool, re.I):
        text, unreadable = collect_mcp_body(tool_input), None
    elif tool == "Bash":
        cmd = str(tool_input.get("command") or "")
        if not is_send_invocation(cmd):
            sys.exit(0)
        text, unreadable = collect_bash_body(cmd)
    else:
        sys.exit(0)

    if unreadable or not text.strip():
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
    if BAD_NAME is None:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA -- a NEV-SZABALY fajl hianyzik/ures "
            f"({_LOCAL_RULES}), igy a nev-ellenorzes nem tud lefutni.\n"
            "Email fail-closed: potold a store/outgoing-copy-gate-rules.json-t "
            "(bad_name_patterns + correction), aztan kuldd ujra.\n"
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

    sys.exit(0)


if __name__ == "__main__":
    main()
