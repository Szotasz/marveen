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
# Deliberately narrower than email-send-gate.mjs: that one may block read-only
# inspection of the send scripts (acceptable for a sub-agent deny), while this
# one must only fire on an actual send, or it would block the main agent from
# reading its own tooling. Hence the recipient-argument requirement below.
SEND_CMD = re.compile(
    r"(support-mail/send\.py|\bsend\.py\b|graph-mail[^\n]*\bsend\b|api\.resend\.com"
    r"|\bsendmail\b|\bmsmtp\b|\bswaks\b)",
    re.I,
)
HAS_RECIPIENT = re.compile(r"(--to\b|\bto_addrs\b|\bto=|\"to\"\s*:|'to'\s*:)", re.I)

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
WORD = re.compile(r"[a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ]+")
TAG = re.compile(r"<[^>]+>")


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
    words = [w.lower() for w in WORD.findall(prose)]
    if is_hungarian(plain) or accentless_evidence(words):
        hits = sorted({w for w in words if w in ACCENTLESS})
        # Az aranyot is a prozan merjuk: a technikai tokenekben nincs ekezet, tehat
        # egy kodban gazdag, egyebkent helyes level aranyat lefele huznak.
        letters = sum(1 for ch in prose if ch.isalpha())
        acc = sum(1 for ch in prose if ch in ACCENTED)
        ratio = (acc / letters) if letters else 0.0
        if hits:
            shown = ", ".join(f"{h} -> {ACCENTLESS[h]}" for h in hits[:12])
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
        if not (SEND_CMD.search(cmd) and HAS_RECIPIENT.search(cmd)):
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
