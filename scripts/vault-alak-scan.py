#!/usr/bin/env python3
"""
PATSZIVARGAS912 -- titok-kezelesi ALAKOK sopresé a skill/task fakban.

HAROM MINTAT keres, mert a szivargas harom kulonbozo uton keletkezett:
  A) utasitas-alak:   export X="<vault: CIMKE>"   -- ket olvasatot enged, az egyik
                      a "keresd ki es ird ide"
  B) stdout-ra iras:  echo 'X=CIMKE' | node vault-resolve.mjs | cut -d= -f2-
                      parancs-behelyettesites NELKUL -- minden futas beirja az
                      erteket az atiratba
  C) lemezre iras:    a feloldott titok egy sima fajlba kerul (pl. /tmp/*.json)

ES KULON MERI AZ ERTEKET: van-e valodi token-ALAKU sztring a fajlokban. A ket
allitas kulon all: "nincs benne ertek" (elo kitettseg) es "nincs benne rossz
recept" (tovabb-tanitas) nem ugyanaz.

KET BUKTATO, MINDKETTO MERVE 2026-09-14:
  1. A markdown inline-kod BACKTICKJE ugyanugy nez ki, mint a parancs-
     behelyettesites. Ha nem veszed ki elobb, a B-mintara HAMIS NEGATIVOT kapsz
     (egy valodi szivargo sor "rendben"-kent jon vissza).
  2. A `.bak` fajlok nem esnek a szokasos kiterjesztes-szurobe (SKILL.md.bak-x
     nem vegzodik .md-re), tehat a nulla rajtuk VAK marad. Egy biztonsagi masolat
     celja a visszaallitas: eppen az a fajl orzi a rossz alakot, amit egy
     "allitsd vissza" mozdulat visszahozna. Ezert a szuro bereszi a .bak*-ot.
     NE TOROLD a .bak-okat: azok a bizonyitek es a visszaallitas lehetosege.

A NULLA CSAK POZITIV KONTROLLAL ER VALAMIT: tegyel egy eldobhato fajlt a sajat
skill-mappadba a szivargo alakkal, futtasd (1 talalat kell), toroldd, futtasd
ujra (0). Enelkul a "0 elofordulas" es a "rossz helyre neztem" megkulonboztethetetlen.
"""
import os, re, sys

# KIMENET-SZERZODES (a PR is ezt mondja ki, PATSZIVARGAS912):
#   KIIR: gyoker-lista, kihagyott konyvtarnevek, a fajlnev-minta, az atvizsgalt
#         fajlok szama, es kategoriankent az UTVONAL:SORSZAM.
#   SOSEM IR KI: magat az ERTEKET, semmilyen alakban, se stdoutra, se fajlba.
#         Az ERTEK-kategoriabol is CSAK a hely utazik, a talalt sztring nem.
#   A "0 talalat" JELENTESE: a KIIRT hatokoron belul nincs talalat. Ami azon
#         kivul van, az NINCS MEGMERVE -- nem az, hogy tiszta.

# A gyokerek FELULIRHATOK, hogy a teszt (es egy store nelkuli negativ kontroll)
# egy eldobhato fara tudja iranyitani a szkent. Felulirva a beepitett halmaz
# NEM adodik hozza: a teszt pontosan azt meri, amit megadott.
def _alap_gyokerek(home: str, claw: str) -> list:
    out = [
        os.path.join(home, ".claude/skills"),
        os.path.join(home, ".claude/scheduled-tasks"),
        os.path.join(home, ".claude/commands"),
        os.path.join(claw, "scripts"),
        os.path.join(claw, "store/tools"),
    ]
    agents = os.path.join(claw, "agents")
    if os.path.isdir(agents):
        for a in sorted(os.listdir(agents)):
            for sub in (".claude/skills", ".claude-config/skills", ".claude/scheduled-tasks"):
                p = os.path.join(agents, a, sub)
                if os.path.isdir(p) and not os.path.islink(p):
                    out.append(p)
    return out

_args = [a for a in sys.argv[1:] if a != "--json"]
JSON_KI = "--json" in sys.argv[1:]
ROOTS = _args if _args else _alap_gyokerek(
    os.path.expanduser("~"),
    os.environ.get("CLAUDECLAW_ROOT", "/Users/marvin/ClaudeClaw"),
)

SKIP_DIR = {"node_modules", ".git", "dist", "build", ".next", "worktrees"}
# .bak* IS bent van (2. buktato)
# 2026-09-18 LELET: a szuro pont azokat a fajlneveket ejtette ki, amik
# hitelesitot szoktak HORDOZNI (`config.toml`, `.env`, `credentials`, `.yaml`,
# `.ini`). Ezert egy ilyen fajl akkor sem lett volna megmerve, ha a konyvtara
# gyokerkent be van teve -- a gyoker-bovites egyedul NEM oldotta volna meg.
# Szelesitunk, mert ez a JELZO ag: az eszkoz csak SZAMOL, nem cselekszik, es
# erteket sosem ir ki.
NEV_OK = re.compile(
    r"\.(md|sh|mjs|js|cjs|ts|json|py|txt|toml|ya?ml|ini|cfg|conf|env)(\.bak[\w.-]*)?$"
    r"|\.bak[\w.-]*$"
    r"|(^|/)\.env(\.[\w.-]+)?$"
    r"|(^|/)credentials$"
)
EXEC = re.compile(r"node\s+[^\s|]*vault-resolve")
UTASITAS = re.compile(r"<vault\s*:")
# A LEMEZ-minta SZUK: csak akkor talalat, ha a CELPONT nem /dev/null, ES a soron
# valodi titok-forras all. A laza alak HAROM FANTOM-LELETET adott 2026-09-14-en:
# a "PAT" reszsztringkent illeszkedett a PATH-ra, a /tmp/dep egy repo-klon, es a
# harmadik talalat epp az a PROZA volt, ami elmagyarazza, miert NINCS mar lemezen.
# Egy kronikusan hamis riasztas nem hianyt okoz, hanem erzeketlenseget.
# A `-o <fajl>` AG CSAK curl-lel egyutt ervenyes: a `-o` a ps sajat flagje is
# (`ps -o command=`), es enelkul ket tovabbi fantom-lelet jott egy olyan skillbol,
# ami csak processzeket listaz.
LEMEZ_CURL = re.compile(r"curl\b[^|]*-o\s+(?!/dev/null)(\S+)")
# A `>` ELOTT szokoz vagy sor-eleje kell: enelkul egy `<owner>/<repo> /tmp/dep`
# alaku PLACEHOLDER zaro `>`-e atirányitasnak latszott, es egy repo-klonra riasztott.
LEMEZ_EGYEB = re.compile(r"(^|\s)>\s*/tmp/\S+|open\(['\"]/tmp/\S+")
TITOK_FORRAS = re.compile(r"/api/vault/|vault-resolve|\bPAT\b|SECRET|_TOKEN\b|_KULCS\b")
# a magyarazo proza nem lelet: ha a sor egy javitas INDOKLASA, ne riassz
PROZA = re.compile(r"MIERT|MIÉRT|korabbi alak|korábbi alak|javitva|javítva|NEM MEGY LEMEZRE")
# VALODI ertek-alak, sosem kiirva -- csak szamoljuk.
#
# 2026-09-18 LELET: ez a minta korabban CSAK `sbp_[0-9a-f]{40}` volt, tehat
# kizarolag a Supabase PAT-ot latta. A "0 ertek-talalat" ezert SOHA nem azt
# jelentette, hogy "nincs hitelesito", hanem azt, hogy "nincs Supabase PAT
# literal" -- es a 09-14-i zaro allitasom ("ertek szinten a szivargas lezarva")
# ennel tobbet allitott, mint amit mert. A testver-eszkoz
# (scripts/untracked-titok-scan.py) MAR a szelesebb mintat hasznalta, tehat ket
# eszkoz ket kulonbozo szamot adott ugyanarra a kerdesre: az modszertani res,
# nem valtozas. Innentol EGY kozos halmaz.
#
# A HATAROLAS NEM KOZMETIKA. Hatarolas NELKUL a `re_...` ag barmelyik snake_case
# AZONOSITO belsejere illeszkedik (`measure_actually_measured` -> "re_" +
# maradek), es a szeles minta elso futasa pont ezert adott 35 talalatot 24
# `.md` skill-fajlban, MIND fantom. Egy kronikusan hamis riasztas nem hianyt
# okoz, hanem erzeketlenseget -- ugyanaz a csapda, amit ez az eszkoz 09-14-en
# mar egyszer megtanult. A `(?<![A-Za-z0-9_-])` azt koveteli, hogy az ELOTAG
# tenyleg elotag legyen. UGYANEZ A HIBA BENNE VAN a testver-eszkozben is
# (scripts/untracked-titok-scan.py) -- ott meg javitando.
_B = r"(?<![A-Za-z0-9_-])"
ERTEK = re.compile(
    _B + r"sbp_[0-9a-f]{40}"                       # Supabase PAT
    r"|" + _B + r"sb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}"  # Supabase uj alak
    r"|" + _B + r"sk-[A-Za-z0-9_-]{20,}"           # OpenAI-stilusu
    r"|" + _B + r"re_[A-Za-z0-9_-]{20,}"           # Resend
    r"|" + _B + r"ctx7sk-[A-Za-z0-9_-]{16,}"       # Context7
    r"|" + _B + r"eyJ[A-Za-z0-9_-]{30,}"           # JWT
)

# A SZKEN ONMAGAT NEM MERI. Mert 2026-09-18, amikor az eszkoz a `scripts/` ala
# kerult (ami maga is gyoker): a SAJAT DOKUMENTACIOJA tartalmazza mind a harom
# keresett alakot peldakent, tehat 3 ALLANDO fantom-talalatot gyartott magara.
# Egy szken, ami minden futasnal riaszt magara, pontosan az az erzeketlenseg-
# termelo, ami ellen a szuk mintak keszultek. A kizaras REALPATH szerint megy,
# tehat egy symlinkelt masolat sem csuszik at rajta.
# ES A SAJAT TESZTJET SEM. A teszt VETOMAGJAI szuksegszeruen tartalmazzak mind a
# harom keresett alakot -- kulonben nem tudnak megmerni, hogy a szken megtalalja
# oket. Mert 2026-09-18: a teszt-fajl 4 allando talalatot adott. A kizaras
# SZUK es NEVESITETT (ez az egy fajl, realpath szerint), nem `*.test.py`: egy
# masik teszt eppen ugy elrejthet egy valodi szivargast, mint barmi mas.
_ONMAGA = {
    os.path.realpath(__file__),
    os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  "__tests__", "vault-alak-scan.test.py")),
}

# D) BEEGETETT HITELESITO KULCSNEV SZERINT. Ez az egyetlen ag, amit a regi,
# koveteslen `untracked-titok-scan.py` fedett es ez az eszkoz NEM -- halmaz-
# kulonbsegkent merve 2026-09-18, es NEM elmeleti: a teljes hatokoron talalt egy
# VALODI beegetett kulcsot egy flotta-szintu skillben, amit az elotag-alapu
# ERTEK-minta elszalasztott (nincs ismert elotagja).
#
# KET SZUKITES, mert hatarolatlanul ez az ag ZAJT termel. Mert: 17 nyers talalat
# a hatokoron, ebbol 11 PROZA vagy PLACEHOLDER -- egy hibauzenetet idezo mondat
# (`token: "No such file..."`), egy `<vault: CIMKE>` alaku helykitolto, egy
# .env-bol olvaso grep-parancs. Egy kronikusan hamis riasztas nem hianyt okoz,
# hanem erzeketlenseget.
#   1. PLACEHOLDER-kizaras: `<...>`, `your`, `example`, `xxx`, `...`, `TODO`.
#   2. ENTROPIA-kuszob: legalabb 12 KULONBOZO karakter. Egy valodi kulcs surun
#      valtozatos; egy mondat vagy egy rovid helykitolto nem.
# A kuszob ALATT levo talalat NEM "tiszta", csak NEM JELENTJUK -- ezert all a
# hatokor-kiirasban, hogy amit nem merunk, arrol nem allitunk semmit.
# A kulcsnev a SOR ELEJEN all (opcionalis behuzas + a szokasos ertekado
# elotagok + JSON-mezo idezojele). Ez valasztja el az ERTEKADAST a PROZATOL:
# `const POSTHOG_API_KEY = "..."` es `"api_key": "..."` benne van, de egy
# hibauzenetet idezo mondat (`... uzenetet ad (PATH: "..."; token: "...")`)
# NINCS. A `:` alak SZANDEKOSAN bent marad: a hitelesitok java egy JSON/YAML
# konfigban ul, es egy `=`-re szukitett minta pont azokra vakulna meg.
KULCSNEV = re.compile(
    r"""^[\s>*-]*(?:(?:const|let|var|export|readonly|public|private)\s+)*["']?"""
    r"""[A-Za-z_]*(?:password|passwd|secret|token|api_key|apikey|kulcs)["']?"""
    r"""\s*[:=]\s*(["'])([^"'$\n]{16,})\1""",
    re.I)
KULCSNEV_PH = re.compile(r"your|example|xxx|placeholder|<[^>]+>|\.\.\.|TODO|FAKE|DUMMY", re.I)

def beegetett_kulcs(ln: str):
    """A sor egy beegetett hitelesitot allit-e be. None, ha nem, vagy ha zaj."""
    m = KULCSNEV.search(ln)
    if not m: return None
    v = m.group(2)
    if KULCSNEV_PH.search(v) or KULCSNEV_PH.search(ln): return None
    if len(set(v)) < 12: return None
    return m

def fajlok():
    latott = set(_ONMAGA)
    for root in ROOTS:
        if not os.path.isdir(root): continue
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d not in SKIP_DIR]
            for fn in fns:
                if not NEV_OK.search(fn): continue
                p = os.path.join(dp, fn); rp = os.path.realpath(p)
                if rp in latott: continue
                latott.add(rp); yield p

A, B, C, ERT, D = [], [], [], [], []
osszes = 0
for p in fajlok():
    osszes += 1
    try: lines = open(p, encoding="utf-8", errors="replace").read().splitlines()
    except Exception: continue
    for i, ln in enumerate(lines, 1):
        if UTASITAS.search(ln): A.append((p, i))
        m = EXEC.search(ln)
        if m:
            pre = ln[:m.start()].replace("`", "")   # 1. buktato
            if "$(" not in pre: B.append((p, i))
        lemez = LEMEZ_CURL.search(ln) or LEMEZ_EGYEB.search(ln)
        if lemez and TITOK_FORRAS.search(ln) and not PROZA.search(ln):
            C.append((p, i))
        if ERTEK.search(ln): ERT.append((p, i))     # az ERTEKET SOSEM irjuk ki
        if beegetett_kulcs(ln): D.append((p, i))   # az ERTEKET ITT SEM irjuk ki

def ki(cim, lst, hangos=True):
    print(f"\n=== {cim}: {len(lst)} sor / {len({x[0] for x in lst})} fajl ===")
    if hangos:
        for p, i in lst:
            print(f"  {p.replace(os.path.expanduser('~'), '~')}:{i}")

if JSON_KI:
    # Ugyanaz a tartalom, gepnek. ERTEK itt sem utazik: csak hely es darabszam.
    import json as _json
    print(_json.dumps({
        "hatokor": {"gyokerek": ROOTS, "kihagyott": sorted(SKIP_DIR), "nev_minta": NEV_OK.pattern},
        "atvizsgalt_fajlok": osszes,
        "A_utasitas_alak": [{"fajl": p, "sor": i} for p, i in A],
        "B_stdout_szivargas": [{"fajl": p, "sor": i} for p, i in B],
        "C_lemezre_iras": [{"fajl": p, "sor": i} for p, i in C],
        "ERTEK": [{"fajl": p, "sor": i} for p, i in ERT],
        "D_beegetett_kulcsnev": [{"fajl": p, "sor": i} for p, i in D],
    }, ensure_ascii=False, indent=2))
    raise SystemExit(1 if (ERT or D) else 0)

# A HATOKOR A SZAM RESZE. A 09-14-i "2027 atvizsgalt fajl, nulla" allitas azert
# adott hamis biztonsagot, mert a szam ONMAGABAN "mindenhol"-nek olvasodott. Egy
# leltar, ami nem mondja meg, MIT nezett meg, tobbet allit, mint amit mert.
print("=== A MERES HATOKORE (a szam ENNYIRE ervenyes, es semmivel sem tobbre) ===")
for r in ROOTS:
    print(f"  gyoker: {r.replace('/Users/marvin','~')}")
print(f"  kihagyott konyvtarnevek: {', '.join(sorted(SKIP_DIR))}")
print(f"  csak ezek a fajlnev-alakok: {NEV_OK.pattern}")
print("  AMI EZEN KIVUL VAN, AZ NINCS MEGMERVE -- nem az, hogy tiszta.")
print(f"\natvizsgalt fajlok: {osszes}  (a .bak* is benne)")
ki("A) utasitas-alak  <vault: CIMKE>", A)
ki("B) feloldas a STDOUT-ra  [SZIVARGO ALAK]", B)
ki("C) feloldott titok LEMEZRE", C)
ki("ERTEK: valodi token-alaku sztring  [ertek SOSEM kerul kiirasra]", ERT)
ki("D) beegetett hitelesito KULCSNEV szerint  [ertek SOSEM kerul kiirasra]", D)
