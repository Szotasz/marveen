#!/usr/bin/env python3
"""The mixed-script word rule, in ONE place for every path that blocks on it.

THE RULE: a word that mixes LATIN with another script is a finding. A word
written entirely in another script is NOT -- a Russian quote, a Greek symbol
and a Hungarian word are all legitimate text; a Hungarian word with a Cyrillic
`о` inside it is not, because it reads correctly and matches nothing.

WHY IT LIVES HERE (2026-09-24 review of #1541). Two paths block on this rule:
the outgoing-copy hook (#1509) and the inter-agent send gate (scripts/lib/
homoglyph.py, wired into scripts/agent-msg.sh). The second one shipped with a
rule of its own -- "any Cyrillic or Greek letter" -- and it refused two
legitimate texts that the first one passed: a plain Russian sentence and a
standalone Greek symbol. Two gates that disagree about what is legitimate are
worse than one gate: the sender learns that the rule depends on which script
they happened to call. So the rule is imported, not re-implemented, and the
test suite measures the two paths against one corpus.

NO AUTOMATIC REPLACEMENT lives here either, and that is deliberate (see the
header of src/homoglyph.ts): the look-alike maps by SHAPE, but the intended
word often needs a different letter -- Cyrillic ER looks like `p`, while the
word wanted `r`. The fix is written by someone who read the word.
"""
import re
import unicodedata

# Unicode-aware tokenisation: a latin-only \w+ would CUT a contaminated word
# into pieces at the homoglyph and then find each piece single-script, i.e. the
# tokenizer itself would hide exactly what is being looked for.
UWORD = re.compile(r"[^\W\d_]+", re.UNICODE)


# HOMOGLYPHMICRO924 (#1548, measured 2026-09-24). "Script" here is the FIRST
# WORD of the Unicode name, and for a few characters that word is the name of
# the sign, not a script. "40 µs" (MICRO SIGN), "100 m²" and "5 cm³"
# (SUPERSCRIPT TWO/THREE) and "H₂O" (SUBSCRIPT TWO) all blocked as mixed-script
# words, because a super/subscript digit is not \d, so UWORD takes it into the
# word. These are unit and formula notation; none of them disguises a latin
# letter (the MICRO SIGN's only confusable is the Greek mu).
#
# THE LIST IS DELIBERATELY EXPLICIT. "Every non-letter is neutral" would be too
# wide: ROMAN NUMERAL ONE (U+2160) is a non-letter and looks like a latin I,
# while KELVIN SIGN (U+212A) and ANGSTROM SIGN (U+212B) are letters that look
# like latin K and A. Those stay caught.
#
# IT LIVES HERE, NOT IN THE HOOK, for the same reason as the rule itself: #1548
# fixed this on the hook path only, so the inter-agent send gate still blocked
# "40 µs". One source, one answer, on every path.
SCRIPT_NEUTRAL = frozenset(
    ["\u00b5", "\u00b2", "\u00b3", "\u00b9", "\u2070"]
    + [chr(cp) for cp in range(0x2074, 0x207A)]  # superscript 4..9
    + [chr(cp) for cp in range(0x2080, 0x208A)]  # subscript 0..9
)


def char_script(ch: str) -> str:
    """First word of the Unicode name: LATIN, CYRILLIC, GREEK, ...

    NEUTRAL for the unit/formula characters above: they are neither a script
    to mix nor a letter to disguise."""
    if ch in SCRIPT_NEUTRAL:
        return "NEUTRAL"
    try:
        return unicodedata.name(ch).split(" ")[0]
    except ValueError:
        return "UNKNOWN"


# Back-compat alias: the hook used this private name before the extraction.
_char_script = char_script


def mixed_script_words(text: str):
    """Return [(word, bad_char, "NAME (U+XXXX)"), ...] for words mixing LATIN
    with any other script. Pure non-Latin words (foreign quotes) pass."""
    out = []
    for word in UWORD.findall(text):
        scripts = {char_script(ch) for ch in word} - {"NEUTRAL"}
        if "LATIN" in scripts and len(scripts) > 1:
            bad = next(ch for ch in word if char_script(ch) not in ("LATIN", "NEUTRAL"))
            try:
                bad_name = unicodedata.name(bad)
            except ValueError:
                bad_name = "UNKNOWN"
            out.append((word, bad, f"{bad_name} (U+{ord(bad):04X})"))
    return out


# LONEFOREIGN893 (kartya #893, merve 2026-10-09). A fenti szabaly SZANDEKOSAN
# atengedi a tisztan nem-latin szot, mert az idegen nyelvu idezet legitim. Egy
# eset viszont atcsuszott rajta: 2026-10-09-en egy magyar Telegram-uzenetben a
# "majus" helyett az orosz "май" allt. A szo tisztan cirill, tehat a
# vegyes-iras szabaly -- helyesen -- nem talalt rajta semmit, es a mondat
# ("az is май-junius kozott") magyarul olvasva ERTELMES maradt. Ez ugyanaz a
# kar, mint a homoglifa: a szoveg jonak latszik, es egy ELGEPELT szo megy ki az
# ugyfel fele.
#
# A KULONBSEG, AMIT MERNI LEHET: az idezet TOBB nem-latin szobol all vagy
# idezojelben van, az elgepeles viszont EGY, magaban allo szo egy egyebkent
# latin mondatban. Ezert a szabaly nem a szo irasrendszeret nezi, hanem a
# KORNYEZETET.
#
# HAROM FELTETEL EGYUTT, es mindharom azert all itt, hogy egy legitim szoveg ne
# bukjon el:
#   1. a szoveg tulnyomoan latin (legalabb LATIN_KUSZOB latin szo) -- enelkul egy
#      tisztan orosz uzenet minden szava talalat lenne;
#   2. a nem-latin szo MAGABAN all (az elotte es utana allo szo latin), tehat nem
#      egy idegen mondat resze;
#   3. a szo legalabb HOSSZ_KUSZOB karakter -- az egy betus gorog es cirill jel
#      (π, Δ, т) szimbolum, nem szo, es a #1541 ota kimondottan atmehet.
# Plusz az idezojelben allo szot kihagyjuk: az idezet akkor is idezet, ha egy szo.
LATIN_KUSZOB = 3
HOSSZ_KUSZOB = 2

# AZ IDEZOJELEK, amiken belul a nem-latin szo idezetnek szamit. A magyar also
# idezojel (U+201E) es a felso (U+201D) mellett a sima ASCII " es a francia
# «» is itt van, mert a flotta szovegeiben mind a harom elofordul.
IDEZOJEL_NYITO = "\u201e\"\u00ab"
IDEZOJEL_ZARO = "\u201d\"\u00bb"


def _idezetben(text: str, kezdet: int) -> bool:
    """Idezojelen BELUL all-e a `kezdet` poziciojú szo.

    A merce egyszeru es szandekosan az: hany nyito idezojel all elotte, amihez
    nem jott zaro. Nem teljes nyelvtani elemzes -- egy kapu-feltetelnek nem is
    kell az --, de a "..." es a „...” parokat helyesen kezeli.
    """
    nyitva = False
    for ch in text[:kezdet]:
        if ch in IDEZOJEL_NYITO and not nyitva:
            nyitva = True
        elif ch in IDEZOJEL_ZARO and nyitva:
            nyitva = False
    return nyitva


def isolated_foreign_words(text: str):
    """[(szo, irasrendszer, "NAME (U+XXXX)"), ...] a MAGANYOS nem-latin szavakra.

    Egy idegen nyelvu idezet (tobb egymast koveto nem-latin szo, vagy
    idezojelben allo szoveg) NEM talalat. Lasd a fenti indoklast.
    """
    szavak = []
    for m in UWORD.finditer(text):
        szo = m.group(0)
        irasok = {char_script(ch) for ch in szo} - {"NEUTRAL", "UNKNOWN"}
        if not irasok:
            continue
        # A vegyes szo a MASIK szabaly dolga; itt csak az EGY irasrendszeru szo szamit.
        egy_iras = irasok.pop() if len(irasok) == 1 else None
        szavak.append((m.start(), szo, egy_iras))

    out = []
    for i, (kezdet, szo, iras) in enumerate(szavak):
        if iras is None or iras == "LATIN":
            continue
        if len(szo) < HOSSZ_KUSZOB:
            continue
        if sum(1 for _, _, x in szavak if x == "LATIN") < LATIN_KUSZOB:
            continue
        elozo = szavak[i - 1][2] if i > 0 else None
        kovetkezo = szavak[i + 1][2] if i + 1 < len(szavak) else None
        # EGY SZIGET: az elotte es utana allo szo is latin (vagy nincs ott szo).
        if elozo not in (None, "LATIN") or kovetkezo not in (None, "LATIN"):
            continue
        if _idezetben(text, kezdet):
            continue
        try:
            nev = unicodedata.name(szo[0])
        except ValueError:
            nev = "UNKNOWN"
        out.append((szo, iras, f"{nev} (U+{ord(szo[0]):04X})"))
    return out
