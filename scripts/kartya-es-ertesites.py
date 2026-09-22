#!/usr/bin/env python3
"""Kartya felvetele ES a gazdajanak szolo ertesites EGY lepesben.

MIERT: 2026-09-05-en a kanban-audit ot friss kartyat talalt megnevezett flotta-gazdaval,
amirol soha nem ment uzenet -- negy kozuluk ugyanabban a delelottben az enyem volt. Boni
lelete: "a kartya-felvetel es az ertesites ket kulon lepes; ha ez ismetlodik, erdemesebb
osszekotni, mint emlekezni ra."

Amit garantal:
  - megnevezett flotta-gazdas kartya NEM jon letre ertesites nelkul (a szkript megtagadja);
  - mindket iras VISSZA VAN OLVASVA (a kartya SELECT-tel, az uzenet a visszakapott id-vel);
  - a 300 karakteres cim-kaput ELORE jelzi, nem utolag a trigger;
  - --dry-run: mindent ellenoriz, semmit nem ir -- ES UGYANAZOKAT A KAPUKAT futtatja, mint az
    eles ag (letezes, token). Egy dry-run, ami megengedobb az eles futasnal, rosszabb, mint
    a semmi: zoldet ad arra, amit a rendszer megtagad. Ezt a kartya-dryrun-paritas teszt meri.

Hasznalat:
  kartya-es-ertesites.py --id X905 --assignee boni --title "..." --desc-file /path
      --msg-file /path --author Boni [--priority normal] [--status planned] [--dry-run]
A felado MINDKET modban KIMONDOTT (KARTYAKULDO908, 2026-09-08): a letrehozo agon --author vagy
--from kell, kulonben megtagadas. Korabban csendben 'marveen' lett belole.
Az onmagunknak (marveen) vagy a gazdanak (szabolcs) szolo kartya ertesites nelkul is mehet:
ott a --no-msg kapcsolo kell, KIMONDVA.
A GAZDANAK --msg-file-lal is lehet kartyat adni, de az ertesites NEM megy ki (GAZDAUZENET921,
2026-09-21): a gazda nem agens, nincs sessionje, a sor mindig failed lett (19/19), es az eszkoz
megis zold UZENET OK-ot irt, mert a sort olvasta vissza, nem a kezbesitest. Most a kimenet
KIMONDJA a hianyt (FIGYELEM-sor, dry-runban is), es a kartya-nyom is ezt rogziti.

A KULDO NEVE (KARTYAKULDO906, Boni lelete 20254): az ertesites feladoja a --from, alapertelmezese
az --author kisbetusitve. Korabban a from HARDCODE 'marveen' volt, tehat az eszkoz MINDEN agens
ertesiteset a fo-agens neveben kuldte ki -- aki olvasta, a MAS mereset ENGEM idezte. Attribucios
hiba, nem kenyelmi kerdes: ket napja pont azon dolgozunk, hogy KI mert MIT es MILYEN HATARRAL.
ONHUROK: ha a felado ES a felelos ugyanaz, az ertesites nem onmagahoz megy, hanem a
KOORDINATORHOZ (marveen) -- kimondva, a kimeneten es az uzenet elso soraban is.

KOMMENT-ONLY MOD (KARTYAIRASESZKOZ905, 2026-09-05): komment egy MEGLEVO kartyara,
ERTESITES NELKUL, ugyanazokkal a kapukkal es kotelezo visszaolvasassal:
  kartya-es-ertesites.py --id X905 --comment-file /path --author Samu [--dry-run]

A MEZOK, AMIKET EBBEN A MODBAN MOZGATNI LEHET: --status, --priority, --title, --assignee es
2026-09-19 ota a --desc-file is (EKEZETKAPU919). A leiras eddig az EGYETLEN kartya-mezo volt,
amit letrehozas utan senki nem tudott javitani: egy elsore rosszul megirt leiras VEGLEGES volt,
es ez eloszor egy gazda ele keszulo szovegben okozott kart (rossz hatarido negy helyen).
A tiltas nem leiras-vedelem volt, hanem hianyzo UPDATE-ut. Amiert megis biztonsagos megnyitni:
a mozgatas-nyom MINDEN valtozo mezo TELJES regi erteket kiirja egy kommentbe, tehat a csere nem
TORLI a regi szoveget, hanem HOZZAIRJA a kartyahoz -- a leiras igy nem lesz csendes
atiras-felulet. Ures --desc-file-t a mozgato ag megtagad.
A LEIRASRA 2026-09-21 OTA UGYANAZ AZ EKEZET-KAPU FUT, MINT A KOMMENTRE (EKEZETKAPU919), mindket
agon (letrehozo ES mozgato): 300 karakter folott 4 szazalek alatti ekezet-arany MEGTAGADAS, a
kiut a --ekezet-nelkul-szandekos. A leiras volt az utolso gazdanak szant mezo, ami ekezet nelkul
bement. Az ERTESITES (--msg-file) NEM esik ide: az gepnek szol, nem a kanban-feluletre.
Az --author itt KOTELEZO (KARTYADRYRUN907, 2026-09-08): korabban csendben 'Marveen'-re esett,
tehat a kartyan MAS neve allt, mint aki irta. A letrehozo agon az alapertelmezes valtozatlan.
MEZOMOZGATAS (KARTYASTATUSZ906, Boni lelete 2026-09-06): komment-modban a lenti mezok MEGLEVO
kartyat mozgatnak, elotte-pillanatkeppel es FUGGETLEN visszaolvasassal:
  kartya-es-ertesites.py --id X905 --status waiting --comment-file /path --author Boni

  A MOZGATHATO MEZOK TELJES LISTAJA (ez az egyetlen hely, ahol fel van sorolva):
    --title      a kartya cime      (300 karakteres kapu + ID-horgony kapu)
    --status     planned | in_progress | testing | waiting | done
    --priority   low | normal | high | urgent
    --assignee   a felelos          (KARTYAKULDO906 4. tetel, 2026-09-06)

Korabban a --status es a --priority komment-modban SZO NELKUL ELVESZETT: a kimenet OK-t mondott, a
kartya nem mozdult. A mozgatas SZANDEKOSAN a komment-modhoz van kotve -- egyik mezo sem valtozhat
nyom nelkul. A FELELOS kulon indoka (Marveen, sajat hasznalatbol): a felelos-mezo a tablankon nem
cimke, hanem azt mondja meg, KINEL all a dontes -- a mozgatasa allapot-valtoztatas, nem adminisztracio.

Ket fuggetlen hibaosztalyt zar ugyanez az egy ut: (1) a nyers sqlite3-quoting otodik
elofordulasa utan a quoting az eszkoz dolga (parameterkotes); (2) a fejlec-idot a
RENDSZERORA adja (ugyanaz az ertek, mint a created_at), gepelt orat a kapu megtagad --
2026-09-05-en 17 kommentbol 11-ben tert el a gepelt ora a valodi created_at-tol.
"""
import argparse, json, os, re, sqlite3, sys, time, unicodedata, urllib.request

# GYOKER-FELOLDAS: env ELOSZOR, __file__ CSAK tartaleknak, beegetett /Users/... SEHOL.
# (Boni ket meresebol, msg 20272.) A sorrend nem izles kerdese:
#   - A beegetett gazda-utvonal tilos, mert a scripts/ SHIPPEL (project_marveen_distribution_
#     hardcode_rule): egy beegetett ertek miatt a kozossegi napi uzenetek hetekig nem mentek ki.
#   - A __file__-ELSO sorrend viszont ROSSZ LENNE, mert a kanban DB EGY ELO tarolo, nem
#     worktree-nkenti. Worktree-ben a modul helyebol szarmaztatott gyoker eltolodik (merve,
#     #978 review: nyers worktree-futas 42 drop vs. korrigalt 15), es a kartya-iras egy arva
#     masolatba menne, amit senki nem lat. Ezert az env mondhatja meg, hova irunk.
ROOT = os.environ.get('CLAUDECLAW_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# KARTYA_DB env: teszt-horog (verify-the-guard) es kimondott felulbiralas.
DB = os.environ.get('KARTYA_DB') or os.path.join(ROOT, 'store', 'claudeclaw.db')

def _db_kapu():
    """A NEM LETEZO DB a legveszelyesebb alak: az sqlite3.connect LETREHOZNA egy ures fajlt,
    es a futas 'no such table'-lel halna el -- vagy ami rosszabb, egy MASOLATBA irna. Ezert a
    hianyzo fajl MEGTAGADAS, a feloldott utvonal kimondasaval.

    SAMU LELETE a #1204 verifyben: a kapu CSAK a letezest nezte, ezert egy LETEZO-de-ures
    (0 byte, vagy kanban_cards nelkuli) fajl ATMENT rajta, es a futas nyers Python-tracebacket
    adott a szep MEGTAGADVA helyett. Nem volt hamis siker es rossz helyre sem irt -- de a
    hibauzenet volt hasznalhatatlan. Ezert a kapu MOST A TABLAT IS MEGNEZI."""
    if not os.path.exists(DB):
        sys.exit(f'MEGTAGADVA: a kanban DB nem letezik ezen az utvonalon:\n  {DB}\n'
                 f'(gyoker: {ROOT})\nA kanban EGY elo tarolo, nem worktree-nkenti. Ha innen akarsz\n'
                 f'irni, mondd ki: CLAUDECLAW_ROOT=<a fo fa> vagy KARTYA_DB=<a db utvonala>.')
    try:
        db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
        van = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='kanban_cards'").fetchone()
        db.close()
    except sqlite3.Error as e:
        sys.exit(f'MEGTAGADVA: a fajl letezik, de nem olvashato kanban DB-kent:\n  {DB}\n'
                 f'(gyoker: {ROOT})\nsqlite: {e}')
    if not van:
        sys.exit(f'MEGTAGADVA: a fajl letezik, de NINCS BENNE kanban_cards tabla:\n  {DB}\n'
                 f'(gyoker: {ROOT})\nEz jellemzoen egy korabbi rossz ut-feloldas hagyta ott. Mondd ki:\n'
                 f'CLAUDECLAW_ROOT=<a fo fa> vagy KARTYA_DB=<a db utvonala>.')
    return DB
def _token_kapu(dry_run):
    """A dashboard-token feloldasa, EGY helyen -- hogy a dry-run ES az eles ag UGYANAZT a
    kaput fussa. A ket ag CSAK a mondatban ter el, mert a KOVETKEZMENY ter el: az eles agon
    a kartya EKKOR MAR LETREJOTT (a token-kapu az 5. lepesben all, a 4. lepes irasa utan),
    a dry-run agon meg semmi nem irodott -- ezert ott felteteles modban mondjuk ki, hogy
    eles futasban MAR LETREJONNE. Ez a hianyzo mondat volt a dry-run legdragabb hazugsaga:
    zoldet adott arra a futasra, aminek a vege pontosan az az allapot, amit az egesz eszkoz
    megelozni hivatott -- a NEMA KARTYA."""
    tok = os.environ.get('KARTYA_TOKEN')
    if tok is not None:
        return tok
    tokpath = os.path.join(ROOT, 'store', '.dashboard-token')
    if not os.path.exists(tokpath):
        elozmeny = ('MEGTAGADVA (dry-run): eles futasban A KARTYA MAR LETREJONNE, DE AZ UZENET NEM MENNE KI:'
                    if dry_run else
                    'A KARTYA LETREJOTT, DE AZ UZENET NEM MENT KI:')
        sys.exit(f'{elozmeny} nincs dashboard-token itt:\n'
                 f'  {tokpath}\n(gyoker: {ROOT}). Mondd ki: CLAUDECLAW_ROOT=<a fo fa> vagy KARTYA_TOKEN=<token>.\n'
                 + ('A dry-run ezert PIROS: az eles futas reszlegesen irna (kartya igen, uzenet nem).'
                    if dry_run else
                    'Kuldd el kezzel az uzenetet, kulonben a kartya nema marad.'))
    return open(tokpath).read().strip()


FLEET = {'samu','zara','boni','iris','dani','geri','deeper','qwen','mira','tomi','jumanji','hidli'}
COORDINATOR = 'marveen'
GAZDA = 'szabolcs'
# Ismert FELELOS-nevek. NEM zart halmaz: a tablan 2026-09-06-an 40 kulonbozo felelos allt, es a
# tobbsegi nem-flotta ertek kulso GitHub-felhasznalonev (PR-kartyak szerzoi). Ezert a nem-ismert
# nev nem automatikusan hiba -- lasd _felelos_feloldas.
ISMERT_FELELOSOK = FLEET | {COORDINATOR, GAZDA}


def _gazda_figyelmeztetes(conn):
    """A gazdanak cimzett inter-agent ertesites SZERKEZETILEG nem kezbesitheto (GAZDAUZENET921,
    2026-09-21): a gazda nem agens, nincs tmux-sessionje, amibe a router beirhatna. Merve a teljes
    tortenetben: 19 failed / 0 delivered. Az eszkoz korabban itt is zold `UZENET OK`-ot irt, mert a
    SORT olvasta vissza, nem a kezbesitest -- ugyanaz a csalad, mint a tool_call_log.success
    (TOOLLOGVAKSIKER921). A szamot a hivas pillanataban UGYANABBOL a DB-bol merjuk, nem beirt
    konstanskent, hogy a figyelmeztetes akkor is igazat mondjon, ha a viszony egyszer megvaltozik."""
    f, d, n = conn.execute(
        "SELECT COALESCE(SUM(status='failed'),0), COALESCE(SUM(status='delivered'),0), COUNT(*)"
        " FROM agent_messages WHERE to_agent=?", (GAZDA,)).fetchone()
    return (f'FIGYELEM: a felelos a GAZDA ({GAZDA}), es a gazdanak NINCS agens-sessionje, tehat az\n'
            f'inter-agent ertesites NEM lesz kezbesitve (a sorban eddig {n} gazda-cimzettu uzenet:\n'
            f'{f} failed, {d} delivered). Az uzenetet NEM kuldom ki. A gazdahoz TELEGRAMON szolj,\n'
            f'vagy a fo-agens viszi ele kotegben -- a kartya letrejon, csak ertesites nelkul.')


def _felelos_feloldas(nyers):
    """A felelos KANONIKUS alakja, ES a rea vonatkozo kapuk EGY helyen.

    A KAPU AZERT ITT ALL, ES NEM A KET HIVONAL (Samu lelete a #1211 verifyben): a homoglifa-
    szures a cimre, a leirasra, az uzenetre es a kommentre futott, a FELELOSRE nem, mert ket
    kulon agon kellett volna kimondani -- es a masodikat elfelejtettem. Elo probaval merve:
    egy cirill a-t tartalmazo nev MINDKET agon beirodott a tablara. Egy megoszlo kapu pontosan
    igy hasad el, ezert a kozos feloldas kapuz, es minden jovobeli ag ingyen megkapja.

    A KANONIKUS ALAK: flotta/gazda nev -> kisbetus (ez a tabla bevett alakja).
    MINDEN MAS nev SZO SZERINT marad.

    MERVE (2026-09-06, elo tabla): a nem-flotta felelosok kulso GitHub-nevek, es TOBB VEGYES
    KISBETUS-NAGYBETUS alakban allnak (Vlbbtabs, KratoBal, PCha0s, palvolgyidigital). A korabbi
    feltetel nelkuli .lower() ezeket MAS ertekke alakitotta, mint ami a tablan all -- vagyis a
    tool-lal felvett kartya kulon oszlopba kerult volna ugyanattol a szerzotol. A kisbetusites
    ezert a FLOTTA-nevekre szol, ahol az a bevett alak, es nem a tablatol idegen normalizalas."""
    nev = nyers.strip()
    if not nev:
        sys.exit('MEGTAGADVA: ures felelos-nev.')
    # HOMOGLIFA: a felelos-mezo a legrosszabb hely egy lathatatlan betucserere -- a nev
    # HELYESNEK LATSZIK, a kartya viszont sajat, egy-elemu oszlopba kerul, es a "kinel all
    # a dontes" kerdesre a tabla csendben rosszul valaszol. Ugyanaz a szures, mint a cimen.
    if (h := gyanus(nev)):
        sys.exit(f'MEGTAGADVA: vegyes irasrendszeru betu a felelos-nevben: {h[:5]}\n'
                 f'A nev helyesnek LATSZIK, de nem az, amit a tabla tobbi kartyaja hordoz.\n'
                 f'Gepeld ujra a nevet, ne masold be.')
    if nev.lower() == GAZDA:
        # NEM kapu, hanem a hazirend kimondasa (gazda-keres, 2026-09-04): a gazda soran CSAK
        # az a kartya all, amit MA EL TUD DONTENI -- egy mondatban feltehato kerdes, ket
        # kimenettel. Nem tiltjuk, mert a dontes-kartya legitim; de nyom nelkul ne csusszon oda.
        print(f'FIGYELEM: a felelos "{GAZDA}" lesz. A tabla-szabaly szerint a gazda soran csak az\n'
              f'a kartya all, amit MA el tud donteni: egy mondatban feltehato kerdes, KET kimenettel,\n'
              f'es a valasz ma is szamit. Ha elobb MERNI vagy KESZITENI kell valamit, a kartya a\n'
              f'vegrehajtoe marad, es a fo-agens viszi a gazda ele kotegben.')
    return nev.lower() if nev.lower() in ISMERT_FELELOSOK else nev


def _horgony(s):
    """Osszehasonlitasi alak az ID-horgonyhoz: csak betuk/szamok, nagybetusen."""
    return re.sub(r'[^0-9A-Za-z]', '', s).upper()


def _horgony_kapu(card_id, cim):
    """A CIM TARTALMAZZA A KARTYA SAJAT ID-JET (Boni lelete, KARTYAKULDO906 1. tetel).

    MIERT KAPU: nalunk a cim-horgony az ID -- a 2026-08-24-i 411 kartyas migracio azon allt vagy
    bukott, hogy az ID ott van-e a cimben; aminek nem volt horgonya, az kezi bucket lett. Egy
    cim-mozgatas csendben leveheti a horgonyt, es a kovetkezo migracio fizeti meg.

    MIERT NORMALIZALT, ES NEM NYERS `id not in title` (Marveen merese, 2026-09-06): a nyers alak a
    tabla BEVETT PR-kartya-konvenciojat tagadna meg -- az id `PR1195`, a cim "PR #1195 (...)", tehat
    a horgony OTT VAN, csak szokozzel es kettoskereszttel. Az utolso het 354 kartyajan merve: a nyers
    feltetel 52-t (14,7%) utasitana el, a normalizalt 13-at (3,7%) -- es ez a 13 tulnyomoreszt pont a
    celzott hiba (hex-ID a DB-ben, tole fuggetlen szemantikus horgony a cimben)."""
    if _horgony(card_id) not in _horgony(cim):
        sys.exit(f'MEGTAGADVA: a cim nem tartalmazza a kartya sajat ID-jet ({card_id}).\n'
                 f'  cim:        {cim[:120]}\n'
                 f'  osszevetve: "{_horgony(card_id)}" nincs benne ebben: "{_horgony(cim)[:120]}"\n'
                 f'A cim-horgony nalunk az ID: ami horgony nelkul marad, az a kovetkezo migracioban\n'
                 f'kezi bucket lesz. Az irasjelek nem szamitanak ("PR #1195" jo a PR1195 id-hez).')
# A kanban_cards CHECK-jei. Kapuban is szerepelnek, hogy egy elgepelt ertek olvashato
# uzenetet adjon, ne nyers sqlite3 IntegrityError-t.
STATUSZOK = ('planned','in_progress','testing','waiting','done')
PRIORITASOK = ('low','normal','high','urgent')
# Ervenyes FELADO-nevek. Elgepelt nev csendben rossz attribuciot irna a sorba, ezert kapu.
KULDOK = FLEET | {COORDINATOR}
API = os.environ.get('KARTYA_API', 'http://localhost:3420/api/messages')
HU = set('áéíóöőúüűÁÉÍÓÖŐÚÜŰ')

def gyanus(t):
    """Nem-magyar, nem-ASCII BETUK egy egyebkent ASCII szoban (HOMOGLIFKAPU905 D-szabalya)."""
    out = []
    for w in t.split():
        if any(ord(c) > 127 and c not in HU and unicodedata.category(c).startswith('L') for c in w) \
           and any('a' <= c.lower() <= 'z' for c in w):
            out.append(' '.join(f'U+{ord(c):04X}' if ord(c) > 127 else c for c in w))
    return out

# Gepelt ora a szoveg elejen: "[NEV ... 12:3x]" vagy "[NEV 2026-09-05 12:34]" alaku fejlec.
# A fejlec-idot az eszkoz teszi be a rendszerorabol; a keziratos ora pont az a hibaosztaly,
# amit ez a mod megszuntet (11/17 elterese egy napon, mind folfele).
# A "3x"-es perc-alak (pl. "18:3x") a MERT tipikus keziratos forma -- a ket-szamjegyu
# minta pont ezt engedte at az elso guard-tesztkor (2026-09-05), ezert [\dx].
TYPED_CLOCK_RX = re.compile(r'^\s*\[[^\]\n]*\d{1,2}:[\dx][\dx][^\]\n]*\]')
CLOCK_RX = re.compile(r'\d{1,2}:[\dx][\dx]')

def gepelt_ora_fejlec(text):
    """A gepelt ora a SZERZO-FEJLEC POZICIOJABAN tilos (Zara lelete, 2026-09-05):
    az elso sorban, az elso ' -- ' ELOTT allo ora fejlec-datalas ("ZARA 16:15 -- ...").
    A torzsben vagy a ' -- ' utan idezett idopont ("a gazda TG 10:59-kor irta") szabad:
    az idezo alakot az kulonbozteti meg, hogy az ora ELOTT kisbetus szo all."""
    first = text.split('\n', 1)[0]
    if TYPED_CLOCK_RX.match(first):
        return True
    head, sep, _ = first.partition(' -- ')
    if not sep:
        head, sep, _ = first.partition('--')
    if not sep:
        head = first
    m = CLOCK_RX.search(head)
    if not m:
        return False
    # RAGOZOTT ido = idezet, nem stempli (Geri 19899/1, Marveen 19920/1 dontese): a
    # "07:40-ES FUTAS" / "10:59-kor" alakban az ora egy esemenyre mutat, a fejlec-stempli
    # viszont mindig csupasz ("16:15"). Inkabb atengedunk nehany rosszat, mint hogy a
    # lelet-jelentes szokasos nagybetus alakja bukjon.
    utana = head[m.end():m.end()+3]
    if len(utana) >= 2 and utana[0] == '-' and utana[1].isalpha():
        return False
    elotte = head[:m.start()].split()
    for w in elotte:
        if w[:1].islower():
            return False
    # Ha az ora elott kozvetlenul DATUM all, az csak a MAI datummal fejlec-datalas --
    # a nem-mai datum hatarido/esemeny-idezet ("HATARIDO 2026-09-08 10:00 -- ..."), szabad.
    datum = None
    if elotte:
        u = elotte[-1].strip('([,').rstrip(',')
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', u):
            datum = u
    if datum is not None and datum != time.strftime('%Y-%m-%d'):
        return False
    if sep:
        return True
    # Nincs '--': a korpusz-regresszio (KAPUPOZICIO905) szerint a fejlec-datalas itt is el
    # (Boni kerek zarojeles alakja, Marveen hajnali "MERES 2026-09-05 04:2x ..." stilusa).
    # Datum nelkuli, '--' nelkuli mondat-kozepi ido szabad; csak a MAI datum + ora paros bukik.
    return datum is not None

# GEPI IDOBELYEG-JELZES, NEM KAPU (Marveen sajat hibaja, 2026-09-16; Mira fogta meg).
# MIERT LETEZIK: a MIODMVALASZ913 lezaro kommentjebe a mio prod DB-bol vett
# `2026-09-14 07:57:39.706374+00` ertekeket irtam be ORAKENT, zona-jeloles nelkul. Azok UTC-k,
# CEST-ben 09:57. A szabaly SZO SZERINT ott allt a sajat memoriamban (kanban-kartya-szabalyok,
# "ha a forras Z-vel/UTC vegzodik, KONVERTALD CEST-re, mielott leirod"), es megis elrontottam --
# tehat ez nem tudas-hiany, hanem LANCOLAS-hiany, ugyanaz az alak, mint a homoglifanal.
# A TELL: a masodperc-pontossagu ora (HH:MM:SS) emberi szovegben szinte mindig BEMASOLT gepi
# ertek, es a `+00` maga a zona-jeloles, amit a bemasolaskor le szoktunk vagni.
# MIERT NEM BLOKKOL: kommentbe log-reszlet es nyers DB-kimenet is legitim modon kerul, ott a
# hamis riasztas a kapu lassu kikapcsolasa lenne. Egy jelzes eleg.
# A JELZES ALAKJA MIRA MERESE UTAN ALLT BE (2026-09-16, msg 25767). Az elso valtozatom
# HAROM hamis pozitivot adott, es mindharom a TIPIKUS komment-tartalmon: Mira megmerte a `Z`-t
# es az idotartamot, a `+00`-t pedig en, amikor a jelenteset visszamertem (o csendesnek irta, de
# a fuggvenyt kozvetlenul hivva JELZETT -- tehat a sajat trigger-listam volt rossz, nem az ové).
# A HIBA GYOKERE: a `+00`-t TRIGGERKENT hasznaltam, holott az maga a ZONA-JELOLES. Az en eredeti
# hibam epp az volt, hogy a `+00`-t LEVAGTAM es csupasz orat irtam. Tehat a jelzes helyes alanya
# a CSUPASZ masodperc-ora: amelyik mellett NINCS zona.
# MIERT SZAMIT: ez a jelzes azon a feluleten fut, ahova CI-logot es futasi idot masolunk. Harom
# hamis riasztas utan a kovetkezo olvaso atsiklik rajta, es az igazi talalat is elvesz --
# "a hamis riasztas a kapu LASSU KIKAPCSOLASA".
ORA_RX = re.compile(r'(?<![\d:])(\d{1,2}):(\d{2}):(\d{2})(?![\d:])')
# Kozvetlenul az ora UTAN allo zona: Z, .123Z, +00, +02:00, -05:00, vagy szokoz + zona-szo.
ORA_UTANI_ZONA_RX = re.compile(r'^(?:\.\d+)?\s*(?:Z\b|[+-]\d{2}(?::?\d{2})?|\s*(?:UTC|GMT|CEST|CET)\b)')
# Az ora ELOTT kozvetlenul allo datum -- ettol a 00 ora valodi idopont, nem idotartam.
DATUM_ELOTT_RX = re.compile(r'\d{4}-\d{2}-\d{2}[ T]$')
ZONA_RX = re.compile(r'\b(CEST|CET|UTC|GMT|helyi ido|helyi oraval|idozona)\b', re.I)

def gepi_idobelyeg_jelzes(szoveg, cimke='komment'):
    """Jelez (NEM blokkol), ha CSUPASZ masodperc-pontossagu ora all a szovegben: olyan, ami
    mellett nincs zona-jeloles. A DB/API idok UTC-ben jonnek, a flotta CEST-ben olvas.

    ISMERT HATAR, KIMONDVA: ha a szoveg BARHOL tartalmaz zona-szot (UTC/CEST/...), az egesz
    komment csendes lesz, akkor is, ha egy MASIK mondatban csupasz ora all. Ez szandekos
    dokumentum-szintu kibuvo (a zonat magyarazo komment ne riasszon), de valodi lyuk. Azert
    all igy, mert a jelzes NEM blokkol: a szorosabb, ora-kozeli szabaly tobb hamis riasztast
    adna, es a hamis riasztas ezt a kaput gyorsabban oli meg, mint ez a lyuk.
    A LYUK SZO SZERINT (Mira mutatta meg, 2026-09-16) -- ez a komment CSENDES:
        "A deploy 2026-09-16 09:12:44 CEST-kor futott le.
         A DM-valasz viszont 07:57:39-kor ment ki, ezt a DB-bol masoltam."
    Az elso mondat zona-szava elnemiti a masodik mondat csupasz orajat. Mira megmerte a sajat
    aznapi kommentjein: NULLA eset harapott ra. Ezert nem szigoritottuk -- egy meg nem tortent
    esemenyre epitett szabaly maga a kronikusan piros alak."""
    if not szoveg or ZONA_RX.search(szoveg):
        return
    for m in ORA_RX.finditer(szoveg):
        if ORA_UTANI_ZONA_RX.match(szoveg[m.end():m.end()+10]):
            continue                      # Z / +00 / +02:00 -- a zona ki VAN irva
        if m.group(1) == '00' and not DATUM_ELOTT_RX.search(szoveg[:m.start()]):
            continue                      # "runtime 00:03:12" -- idotartam, nem idopont
        print(f'FIGYELEM: a(z) {cimke} csupasz gepi orat tartalmaz zona-jeloles nelkul: "{m.group(0)}".\n'
              '  A DB/API idok tobbnyire UTC-ben jonnek, a gazda es a flotta CEST-ben olvas --\n'
              '  szeptemberben ez 2 ora csuszas, es formailag helyes oranak latszik.\n'
              '  Nem allitalak meg. Vagy konvertald CEST-re, vagy ird oda a zonat.', file=sys.stderr)
        return

GEPI_FEJLEC_RX = re.compile(r'^\s*\[[^\]\n]*\d{1,2}:\d{2}, rendszerora\]\s*\n?')

# EKEZET-JELZES, NEM KAPU (Mira merese, 2026-09-14). A gazda 2026-09-07-i szabalya szerint a
# kanban-KOMMENTET EMBER olvassa, tehat teljes magyar ekezettel megy (a kanban-CIM nem).
# MERVE: a komment-oldal 2676 sorbol 27 szazalekon all -- a szabaly SEHOL nem volt bekotve az
# iras pillanataba, ezert csak egy agens tartotta. Ez ugyanaz az alak, mint a homoglifanal es a
# memoria-indexnel: a szabaly megvan, a lepes nincs.
# 2026-09-17 OTA KAPU, NEM JELZES -- ES AZ OK A MERES, NEM AZ ELV. A jelzes 2026-09-14 ota allt
# itt azzal az indokkal, hogy "egy jelzes eleg". 2026-09-17-en KET agens (Mira es Marveen) futott
# bele UGYANAZON A NAPON, es MINDKET ekezet nelkuli szoveg KIMENT. Egy kapu, ami nulla esetben
# allit meg semmit, pontosan annyit er, mintha nem lenne ott -- a jelenlete viszont megnyugtat,
# es ez a rosszabbik fele. (Mira javaslata, msg 26275; Marveen dontese.)
# A REGI ELLENERV VALOS MARAD: kommentbe kod, log-reszlet es nyers DB-ertek is kerul legitim
# modon, ott a hamis pozitiv a kapu lassu kikapcsolasa lenne. EZERT NEM "mindig allj meg", hanem
# KIMONDOTT FELULBIRALAS: --ekezet-nelkul-szandekos. A surgos eset tovabbra is egy kapcsoloval
# megoldhato, de nem VELETLENUL megy ki: aki atengedi, leirja, hogy tudja.
# A CIMRE NEM VONATKOZIK: a gazda 2026-09-07-i szabalya szerint a kanban-CIM maradhat ekezet
# nelkul, a KOMMENTET viszont EMBER olvassa.
# A KAPU AZ IRAS ELE KERULT. Jelzeskent az INSERT UTAN allt, ami megengedheto volt; kapukent
# ott ertelmetlen lenne (mar bent van a sor), es rosszabb a mainal: "megallitottalak" uzenetet
# adna egy mar megtortent irasra.
# ARANY-KAPU, NEM JELENLET-KAPU (EKEZETARANY921, 2026-09-21). Az elozo alak `any`-predikatum volt:
# EGYETLEN ekezetes betu BARHOL a szovegben kikapcsolta a kaput az EGESZ szovegre. Merve: 831
# karakter ekezet nelkuli szoveg atment egy ekezetes szoval a vegen (0,36 szazalek); a tabla
# utolso 30 napjanak 300+ karakteres, "ekezetes" kommentjeibol 52 szazalek allt 0,5 szazalek
# alatt -- vagyis a kapu a hosszu szovegeken gyakorlatilag ki volt kapcsolva. A kuszob 4 szazalek
# (ekezetes betu / osszes betu), a Dream Engine DREAM.md-kapujanak precedense: a rendesen
# ekezetezett magyar proza 8-12 szazalek (a sajat teszt-fixtura 10,6), az ekezet nelkuli
# gyakorlatilag nulla, a 4 biztonsagosan a ketto kozott all. A kod/log/nyers-ertek eset
# legitim modon alacsony aranyu: arra a --ekezet-nelkul-szandekos kiut van, ami MEGMARAD.
EKEZET_ARANY_KUSZOB = 0.04

def _ekezet_arany(szoveg):
    EK = set('áéíóöőúüűÁÉÍÓÖŐÚÜŰ')
    betuk = [ch for ch in szoveg if ch.isalpha()]
    if not betuk:
        return 0.0, 0
    return sum(1 for ch in betuk if ch in EK) / len(betuk), len(betuk)

def _ekezet_kapu(szoveg, szandekos, cimke='komment'):
    if len(szoveg) < 300:
        return
    arany, betuk = _ekezet_arany(szoveg)
    if arany >= EKEZET_ARANY_KUSZOB:
        return
    NAGY = cimke.upper()
    # A magyar targyeset nem kepezheto a cimkebol gepiesen ("leiras" -> "leirast", nem "leiraset"),
    # es egy kapu, ami rosszul beszel, kevesebbet er: aki olvassa, gepi zajnak veszi.
    TARGY = {'komment': 'kanban-kommentet', 'leiras': 'kanban-leirast'}.get(cimke, f'kanban-{cimke}t')
    if szandekos:
        print(f'FIGYELEM: ekezet nelkuli {cimke} megy be (ekezet-arany {arany:.1%}, {betuk} betun), '
              'KIMONDOTT felulbiralassal (--ekezet-nelkul-szandekos).', file=sys.stderr)
        return
    sys.exit(f'MEGTAGADVA: ez a(z) {cimke} EKEZET NELKULI (ekezet-arany {arany:.1%} {betuk} betun, a kuszob '
             f'{EKEZET_ARANY_KUSZOB:.0%}), pedig a {TARGY} EMBER olvassa\n'
             f'  (gazda-szabaly, 2026-09-07). A kanban-CIM maradhat ekezet nelkul, a {NAGY} nem.\n'
             f'  A(z) {cimke} NEM irodott be. Ird at ekezetesen, es kuldd ujra.\n'
             '  Ha kivetelesen indokolt (nyers log, kod-reszlet, surgos eset), add meg\n'
             '  kimondottan: --ekezet-nelkul-szandekos')


def komment_mod(a):
    """Komment egy MEGLEVO kartyara, ertesites nelkul. Kapuk + kotelezo visszaolvasas."""
    # SZERZO-KAPU (KARTYADRYRUN907, 2026-09-08). Boni es Zara egymastol fuggetlenul
    # merte 2026-09-07-en (21700, 21701), hogy --author nelkul a fejlec ES a
    # kanban_comments.author mezo CSENDBEN 'Marveen'-re esett. A javitas akkor egy
    # VERZIOKOVETETLEN peldanyba ment, es a v1.37.0 kiadas nemán visszaallitotta a hibat
    # (a kartya kozben done-on allt, tehat senki nem olvasta ujra). Ezert all itt fail-closed
    # kapu FELSZOLITAS helyett: a kapu akkor is vedd, ha senki nem olvassa el a korlevelet.
    # MIERT NEM ELEG A HELYES ALAPERTELMEZES: a komment SZERZOJE attribucio, nem kenyelem --
    # a rossz nev irANYA is rossz, mert FELFELE, a koordinatorra mutat, tehat SULYT ad egy
    # mondatnak, amit nem o irt.

    if a.author is None:
        sys.exit('MEGTAGADVA: komment-modban a szerzo KIMONDOTT: add meg az --author-t\n'
                 '(pl. --author Boni). Korabban ez csendben "Marveen"-re esett vissza, tehat\n'
                 'a kartyan MAS neve allt, mint aki irta -- es a kimenet kozben OK-t mondott.')
    text = open(a.comment_file, encoding='utf-8').read().strip()
    # Az ERTESITES szovege NEM esik az ekezet-kapu ala, ugyanugy, mint a letrehozo agon:
    # az nem a kanban-felulet, hanem inter-agent uzenet.
    msg = open(a.msg_file, encoding='utf-8').read() if a.msg_file else ''
    _ekezet_kapu(text, a.ekezet_nelkul_szandekos)
    if not text:
        sys.exit('MEGTAGADVA: ures komment-fajl.')
    # UJRAPROBALKOZAS-ut (Iris lelete, Mira merese, 19912): ha a szoveg egy KORABBI
    # gepi fejleccel erkezik (bukott iras utani ujrakuldes, vagy a kartyarol visszamasolt
    # szoveg), a sajat kimenetunkon akadna fenn a kapu. NEM kivetelt teszunk (azt kezzel
    # rossz oraval is be lehetne gepelni "rendszerora" cimkevel) -- hanem LEVAGJUK es
    # friss stemplit kap: a regi gepi fejlecben allo ora sosem elhet tovabb.
    # INVARIANS (Mira merte, 19943): a levagas a TELJES fejlecet viszi, a NEVVEL egyutt --
    # igy gepi-fejlec-alaku hamisitvannyal MAS NEVEBEN sem lehet irni (a friss stempli a
    # tenyleges --author-t hordozza). NE "optimalizald" csak az ora-resz levagasara:
    # azzal ez a nev-vedelem csendben eltunne.
    levagva = 0
    while (m := GEPI_FEJLEC_RX.match(text)):
        text = text[m.end():].lstrip('\n')
        levagva += 1
    if levagva:
        print(f'FIGYELEM: {levagva} korabbi rendszerora-fejlec eltavolitva, friss stemplit kap.')
    if not text:
        sys.exit('MEGTAGADVA: a komment csak fejlec(ek)bol allt, torzs nelkul.')
    if gepelt_ora_fejlec(text):
        sys.exit('MEGTAGADVA: gepelt ora a szerzo-fejlec poziciojaban (elso sor, a -- elott). Az orat\n'
                 'az eszkoz teszi be a rendszerorabol -- torold a kezi fejlecet. A torzsben idezett\n'
                 'idopont (pl. "a gazda 10:59-kor irta") szabad.')
    if (h := gyanus(text)):
        sys.exit(f'MEGTAGADVA: vegyes irasrendszeru szo a kommentben: {h[:5]}')
    gepi_idobelyeg_jelzes(text, 'komment')

    # MEZOMOZGATAS (KARTYASTATUSZ906, Boni lelete 20271): a --status/--priority korabban
    # komment-modban SZO NELKUL ELVESZETT. A kimenet OK-t mondott, a kartya nem mozdult, es a
    # hamis siker iranya rossz volt: a kartya nema maradt a ROSSZ statuszban. A ket lehetseges
    # javitas kozul (megtagadas vs. mukodo UPDATE) a masodik all, mert a bevezetes ota ervenyes
    # flotta-szabaly ("statuszra az eszkoz --status kapcsoloja") ezt IGERI -- Boninak nyers
    # sqlite3-hoz kellett nyulnia, pont ahhoz az uthoz, amit az eszkoz nyugdijazni akart.
    # A mozgatas SZANDEKOSAN a komment-modhoz kotott: igy statusz sosem valtozik nyom nelkul.
    # A CIM IS MOZGATHATO (2026-09-06): a flotta-szabaly a cimre IS az eszkozt nevezi meg, es
    # amig a --title meglevo kartyara nem hatott, a szabaly fele hamis maradt. Ugyanazok a kapuk
    # allnak ra, mint a letrehozo agon -- kulonben a mozgatas megkerulne a 300 karaktert.
    if a.title is not None:
        if len(a.title) > 300:
            sys.exit(f'MEGTAGADVA: a cim {len(a.title)} karakter (max 300). A trigger levagna es kommentbe tenne.\n'
                     f'A cim EGY sor legyen (lelet + gazda + hatarido), a reszletek a leirasba.')
        if (h := gyanus(a.title)):
            sys.exit(f'MEGTAGADVA: vegyes irasrendszeru szo a cimben: {h[:5]}')
        _horgony_kapu(a.id, a.title)
    # A LEIRAS IS MOZGATHATO (EKEZETKAPU919, 2026-09-19). Marveen kikotese: a regi szoveg NE
    # vesszen el -- ezt nem kulon kod adja, hanem a mar meglevo mozgatas-nyom, ami MINDEN valtozo
    # mezo TELJES regi erteket kiirja egy kommentbe (lasd lent: `reszletes`). Ezert a leiras ugy
    # kerul be, mint a tobbi mezo, es nem sajat kulon uton: egy kulon ut pont azt a nyomot kerulne
    # meg, amiert az egesz engedmeny megadhato.
    # AMI RAFUT ES AMI NEM: a homoglifa-kapu igen (ugyanaz a hamisitas-felulet, mint a cimen).
    # AZ EKEZET-KAPU IS (EKEZETKAPU919, 2026-09-21) -- ES EZ A SOR KORABBAN HALLGATOTT ROLA.
    # A felsorolas 2026-09-19 ota itt allt "homoglifa igen, 300 karakter nem, horgony nem"
    # alakban, es az ekezet-kaput meg sem emlitette. Nem kimaradas volt: a leirast a CIM
    # kapuihoz igazitottam, holott a leirast a gazda ugyanugy OLVASSA, mint a kommentet.
    # A magabiztos, hianyos felsorolas rosszabb egy kimaradasnal, mert a kovetkezo olvaso
    # jogosan hiszi el. Most ugyanaz a 4 szazalekos arany-kapu fut ra, mint a kommentre,
    # ugyanazzal a --ekezet-nelkul-szandekos kiuttal.
    # A 300 karakteres hatar NEM: az a CIM trigger-levagasa ellen all, a leiras epp a hosszu
    # szovege. A horgony-kapu sem: az azt meri, hogy a CIM hordozza-e a kartya azonositojat.
    uj_leiras = None
    if a.desc_file is not None:
        uj_leiras = open(a.desc_file, encoding='utf-8').read()
        if not uj_leiras.strip():
            sys.exit('MEGTAGADVA: ures --desc-file a mozgato agon. Ez a leiras KIURITESE lenne, es\n'
                     'egy ures leiras ugyanugy nez ki, mint egy elfelejtett. Ha tenyleg torolni\n'
                     'akarod a tartalmat, irj be egy sort arrol, MIERT ures (a regi szoveg a\n'
                     'mozgatas-nyomban akkor is megmarad).')
        if (h := gyanus(uj_leiras)):
            sys.exit(f'MEGTAGADVA: vegyes irasrendszeru szo a leirasban: {h[:5]}')
        _ekezet_kapu(uj_leiras, a.ekezet_nelkul_szandekos, 'leiras')
    if a.status is not None and a.status not in STATUSZOK:
        sys.exit(f'MEGTAGADVA: ervenytelen statusz ("{a.status}"). Ervenyes: {", ".join(STATUSZOK)}.')
    if a.priority is not None and a.priority not in PRIORITASOK:
        sys.exit(f'MEGTAGADVA: ervenytelen prioritas ("{a.priority}"). Ervenyes: {", ".join(PRIORITASOK)}.')

    db = sqlite3.connect(_db_kapu()); db.execute('PRAGMA busy_timeout=8000')
    card = db.execute('SELECT id,status,assignee,priority,title,description FROM kanban_cards WHERE id=?', (a.id,)).fetchone()
    if not card:
        sys.exit(f'MEGTAGADVA: a(z) {a.id} kartya NEM LETEZIK -- komment-only mod csak meglevo kartyara ir.\n'
                 f'Uj kartyahoz a letrehozo mod valo (--assignee/--title).')
    # ELOTTE-PILLANATKEP: enelkul a visszaolvasas nem meres, csak egy ertek felolvasasa.
    elotte = {'status': card[1], 'priority': card[3], 'title': card[4], 'assignee': card[2],
               'description': card[5]}
    # A FELELOS FELOLDASA a kartya ismereteben: a kanonikus alakot hasonlitjuk az elotte-erteknek,
    # kulonben egy "Samu" -> "samu" no-op valodi mozgatasnak latszana.
    uj_felelos = None
    if a.assignee is not None:
        uj_felelos = _felelos_feloldas(a.assignee)
        if uj_felelos != elotte['assignee'] and uj_felelos not in ISMERT_FELELOSOK and not a.assignee_uj:
            # TIPUS-KAPU, NEM NEV-HALMAZ (Marveen merese, 2026-09-06): a felelos-oszlop NEM zart
            # halmaz -- 40 kulonbozo ertek all rajta, tobbsegukben kulso GitHub-nevek. Egy zart
            # halmazu kapu ezert a legitim mozgatasok tobbseget tagadna meg. Amit viszont meg
            # tudunk merni: all-e MAR MASIK kartya pontosan ezen a neven. Ha nem, az tipikusan
            # elgepeles, ami csendben egy sajat, egy-elemu oszlopba viszi a kartyat.
            # ISMERT HATAR: ARCHIVALT kartya is szamit. Igy egy regi elgepeles onmagat
            # legitimalja (merve: a tablan 44 archivalt kartya all "Samu" es 2 a
            # "Marveen+Samu+Zara" erteken). Szandekos: a szigoritas a legitim, regota hasznalt
            # kulso neveket is elutasitana, ami gyakoribb eset, mint a regi elgepeles ujra-
            # felhasznalasa. A kapu celja az UJ elgepeles kiszurese, nem a tortenet takaritasa.
            masik = db.execute('SELECT COUNT(*) FROM kanban_cards WHERE assignee=? AND id<>?',
                               (uj_felelos, a.id)).fetchone()[0]
            if not masik:
                kozeli = [r[0] for r in db.execute(
                    'SELECT DISTINCT assignee FROM kanban_cards WHERE assignee IS NOT NULL'
                    ' AND lower(assignee) LIKE ? ORDER BY assignee LIMIT 5',
                    ('%' + uj_felelos.lower()[:4] + '%',)).fetchall()]
                sys.exit(f'MEGTAGADVA: "{uj_felelos}" nem ismert flotta-nev, es MASIK kartya sem all rajta.\n'
                         f'Ez tipikusan elgepeles, ami sajat, egy-elemu oszlopba viszi a kartyat.\n'
                         + (f'Hasonlo, MAR LETEZO nevek: {", ".join(kozeli)}\n' if kozeli else '')
                         + 'Ha tenyleg uj nev (pl. uj kulso PR-szerzo), mondd ki: --assignee-uj.')
    # ERTESITES-KAPU A KOMMENT-MODBAN (KOMMENTERTESITES922), a KOMMENTMSGFILE922 ota UGY, hogy a
    # LEGOLCSOBB UT A HELYES: a --msg-file all az elso helyen, es ugyanez a futas kuldi el.
    # AZ ESET: az eszkoz eddig CSAK KIIRTA, hogy `Ertesites: nem ment (komment-only)`. Marveen ezt
    # egyetlen napon tizszer elolvasta es tovabbment; kozben egy merge-rol csak a kartyara irt, es
    # egy tars allapot-kepe elavult. Egy jelzes, amit megszoktunk, nem kapu.
    #
    # A HATAR SZANDEKOS, es mindket negativ kontroll a tesztben all:
    #   - SAJAT kartyara irt komment ATMEGY: a sajat nyomod nem ertesites-ugy;
    #   - KULSO felelos (GitHub-nev, nem flotta-agens) ATMEGY: nekik nem inter-agent uzenet megy.
    # A MOZGATAST IS NEZZUK: ha ugyanez a futas ATADJA a kartyat, a REGI felelosnek epp ugy tudnia
    # kell rola, mint az ujnak, tehat mindketto szamit -- es az ERTESITES PONTOSAN EZT a halmazt
    # kapja, nem egy ujraszarmaztatottat (KOMMENTMSGFILE922 b) kikotes).
    _erintett = {x for x in (elotte['assignee'], uj_felelos) if x}
    _ertesitendo = sorted(x for x in _erintett
                          if x in FLEET and x != (a.author or '').strip().lower())
    # ELLENTMONDAS-KAPU, ugyanaz az alak, mint a --no-msg + --msg-file parosnal a letrehozo agon:
    # a ket szandek kozul nem talalhato ki, melyik az igazi, tehat nem valasztunk helyette.
    if a.msg_file and a.nincs_ertesites_szandekos:
        sys.exit('MEGTAGADVA: --msg-file ES --nincs-ertesites-szandekos egyszerre -- a ketto ellentmond\n'
                 'egymasnak. Vagy ertesitesz (--msg-file), vagy kimondva nem (--nincs-ertesites-szandekos).')
    if a.msg_file and not _ertesitendo:
        sys.exit('MEGTAGADVA: --msg-file, de NINCS kit ertesiteni ezen a kartyan: a felelos vagy te magad\n'
                 'vagy ("' + str(a.author) + '"), vagy nem flotta-agens. Nem talalunk ki cimzettet.\n'
                 'Ha egy KONKRET agensnek akarsz irni, az a kulon ut: scripts/agent-msg-send.sh <cimzett> <fajl>.')
    if _ertesitendo and not a.msg_file and not a.nincs_ertesites_szandekos:
        _kik = ', '.join(_ertesitendo)
        sys.exit('MEGTAGADVA: a kartya felelose "' + _kik + '" (flotta-agens), te pedig "'
                 + str(a.author) + '" vagy,\n'
                 'es igy a komment NEM ertesit senkit. A KARTYA NEM ERTESITES: ez a komment ugy allna\n'
                 'a tablan, hogy a felelos nem tud rola.\n'
                 '  EZ A LEGEGYSZERUBB UT: add hozza a --msg-file <fajl> kapcsolot, es UGYANEZ a futas\n'
                 '    elkuldi az ertesitest ide: ' + _kik + '\n'
                 '  Ha kulon lepesben szolnal: scripts/agent-msg-send.sh ' + _ertesitendo[0] + ' <fajl>\n'
                 '  Ha csak NYOMOT hagysz a jovonek, es a felelosnek nem kell tudnia rola:\n'
                 '    mondd ki a --nincs-ertesites-szandekos kapcsoloval.')
    if a.nincs_ertesites_szandekos and _ertesitendo:
        # UGYANAZ A SZIMMETRIA, MINT A --no-msg-nel: a kimondott kihagyas LATSZODJON a kimeneten,
        # kulonben maga a KAPCSOLO valik szokassá -- ugyanaz a vaksag egy lepessel arrebb.
        print('FIGYELEM: --nincs-ertesites-szandekos egy flotta-felelosu ('
              + ', '.join(_ertesitendo) + ') kartyan. Ez KIMONDOTT kihagyas: a felelos NEM fog '
              'tudni errol a kommentrol.')

    mozgatas = {k: v for k, v in (('status', a.status), ('priority', a.priority), ('title', a.title),
                                  ('assignee', uj_felelos), ('description', uj_leiras))
                if v is not None}
    valtozik = {k: v for k, v in mozgatas.items() if v != elotte[k]}
    valtozatlan = {k: v for k, v in mozgatas.items() if v == elotte[k]}

    now = int(time.time())
    fejlec = f'[{a.author} {time.strftime("%Y-%m-%d %H:%M", time.localtime(now))}, rendszerora]'
    tartalom = f'{fejlec}\n{text}'
    if a.dry_run:
        terv = (', '.join(f'{k}: {str(elotte[k])[:57]} -> {str(v)[:57]}' for k, v in valtozik.items()) or 'nincs')
        print(f'DRY-RUN OK (komment-mod, DB: {DB}): kartya letezik ({card}), kapuk atmentek.\n'
              f'  fejlec: {fejlec} | szoveg {len(text)} kar | ertesites: '
              + (f'{len(msg)} kar -> ' + ', '.join(_ertesitendo) + ' (felado: '
                 + (a.from_agent or a.author).strip().lower() + ')' if msg else 'NINCS (komment-only)') + '\n'
              f'  mezomozgatas: {terv}'
              + (f' | mar ezen az erteken all: {valtozatlan}' if valtozatlan else ''))
        if valtozik:
            _elozmeny_figyelmeztetes(db, a, now, dry=True)
        return

    cur = db.execute('INSERT INTO kanban_comments (card_id,author,content,created_at) VALUES (?,?,?,?)',
                     (a.id, a.author, tartalom, now))
    db.commit()
    back = db.execute('SELECT id,author,length(content),created_at FROM kanban_comments WHERE rowid=?',
                      (cur.lastrowid,)).fetchone()
    if not back:
        sys.exit('HIBA: a komment nem olvashato vissza -- az iras nem tortent meg.')
    if back[3] != now:
        sys.exit(f'HIBA: a visszaolvasott created_at ({back[3]}) nem a fejlec ideje ({now}).')
    print(f'KOMMENT OK (visszaolvasva innen: {DB}): comment_id={back[0]} author={back[1]} '
          f'{back[2]} kar, created_at==fejlec-ido. '
          + ('Ertesites: ugyanebben a futasban megy.' if msg else 'Ertesites: nem ment (komment-only).'))


    # ERTESITES UGYANEBBEN A FUTASBAN (KOMMENTMSGFILE922). A CIMZETT-HALMAZ PONTOSAN az, amit a
    # kapu fent kiszamolt (_ertesitendo) -- NEM ujraszarmaztatjuk. Ha ket helyen szarmaztatnank,
    # a kapu panaszkodhatna az egyik nevre, mikozben az uzenet egy masikhoz megy, es a teszt
    # mindkettot zoldnek latna.
    if msg:
        frm = (a.from_agent or a.author).strip().lower()
        tok = _token_kapu(dry_run=False)
        kuldott = []
        for cimzett in _ertesitendo:
            req = urllib.request.Request(API,
                data=json.dumps({'from': frm, 'to': cimzett, 'content': msg}).encode(),
                headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok},
                method='POST')
            try:
                r = json.load(urllib.request.urlopen(req))
            except Exception as e:
                sys.exit('A KOMMENT BEIRODOTT, DE AZ UZENET NEM MENT KI (' + cimzett + '): ' + str(e)
                         + '\nKuldd el kezzel, kulonben a felelos nem tud a kommentrol.')
            mid = r.get('id')
            if not mid:
                sys.exit('A KOMMENT BEIRODOTT, de az uzenet-valasz nem ad id-t: ' + str(r)[:200])
            sor = db.execute('SELECT id,from_agent,to_agent,status FROM agent_messages WHERE id=?',
                             (mid,)).fetchone()
            if not sor:
                sys.exit('A KOMMENT BEIRODOTT, de a(z) ' + str(mid) + ' uzenet-sor NEM OLVASHATO VISSZA.')
            # A visszaolvasas a FELADOT es a CIMZETTET is meri: a sor allhatna rossz neven.
            if sor[1] != frm or sor[2] != cimzett:
                sys.exit('HIBA: a sor nem azt hordozza, amit kuldtunk. Vart: ' + frm + ' -> ' + cimzett
                         + '; kapott: ' + str(sor[1]) + ' -> ' + str(sor[2]) + '.')
            kuldott.append((mid, cimzett))
            print('UZENET OK (visszaolvasva a sorbol, felado is): ' + str(sor))
        # NYOM A KARTYAN, a MERT halmazzal: egy kesobbi olvaso lassa, kihez ert el ez a komment.
        db.execute('INSERT INTO kanban_comments (card_id,author,content,created_at) VALUES (?,?,?,?)',
                   (a.id, 'kartya-es-ertesites',
                    '[kartya-es-ertesites.py] A komment es az ertesites EGY futasban keszult. '
                    + 'Ertesites: ' + ', '.join('msg ' + str(m) + ' -> ' + c for m, c in kuldott)
                    + ' (felado: ' + frm + '). Mindket iras visszaolvasva.', now))
        db.commit()
        print('NYOM OK: kartya-komment az ertesites utjarol (' + ', '.join(str(m) for m, _ in kuldott) + ')')

    if valtozatlan:
        print(f'FIGYELEM: mar ezen az erteken all, nem mozgatom: '
              + ', '.join(f'{k}={v}' for k, v in valtozatlan.items()))
    if not valtozik:
        if mozgatas:
            print('MEZOMOZGATAS: nincs teendo (minden kimondott ertek mar ez volt).')
        return
    _elozmeny_figyelmeztetes(db, a, now)

    sets = ', '.join(f'{k}=?' for k in valtozik)
    cur = db.execute(f'UPDATE kanban_cards SET {sets}, updated_at=? WHERE id=?',
                     (*valtozik.values(), now, a.id))
    db.commit()
    if cur.rowcount != 1:
        sys.exit(f'HIBA: a mezomozgatas {cur.rowcount} sort erintett (1 helyett) -- a komment MAR BEIRT.')
    # FUGGETLEN visszaolvasas: uj SELECT, nem a cursor allitasa. A 0-talalatos UPDATE
    # es a sikeres UPDATE kulonben megkulonboztethetetlen lenne.
    utana = db.execute('SELECT status,priority,title,assignee,description FROM kanban_cards WHERE id=?', (a.id,)).fetchone()
    kapott = {'status': utana[0], 'priority': utana[1], 'title': utana[2], 'assignee': utana[3],
              'description': utana[4]}
    for k, v in valtozik.items():
        if kapott[k] != v:
            sys.exit(f'HIBA: a(z) {k} visszaolvasva "{kapott[k]}", nem a kert "{v}". Az iras NEM ert celba.')
    def rov(v):
        v = str(v)
        return v if len(v) <= 60 else v[:57] + '...'
    print(f'MEZOMOZGATAS OK (fuggetlenul visszaolvasva innen: {DB}): '
          + ', '.join(f'{k}: {rov(elotte[k])} -> {rov(kapott[k])}' for k in valtozik))
    # A MOZGATAS NYOMA A KARTYAN: a komment szovege Bonie, ez a sor a gepe. Enelkul a
    # tabla olvasoja latja az uj statuszt, de nem latja, hogy KI es MIKOR mozgatta.
    #
    # A REGI ERTEK TELJES EGESZEBEN IDE KERUL (2026-09-11, Mira lelete). A kartya-mezo
    # EGYERTEKU: aki utoljara ir, felulir, es a regi ertek ELVESZIK. A rovidített nyom
    # ma nem volt eleg: egy felulirt cimet nem lehetett belole visszaallitani, mert a
    # naplo csak 60 karaktert orzott. (Ugyanaznap HAROM ilyen utkozes volt, mind
    # kartya-mezon -- mikozben a KOZOS SKILL-FAJLBA harman irtak egy oran belul nulla
    # utkozessel, mert az a szerkezet HOZZAFUZHETO, nem egyerteku.)
    # A konzol-kimenet marad rovid (olvashatosag); a TAROLT nyom teljes.
    teljes = [f'{k}: {rov(elotte[k])} -> {rov(kapott[k])}' for k in valtozik]
    # A NULL-t KIIRVA kell megkulonboztetni az ures szotol: a visszaallito ember kulonben
    # a 'None' szot masolna vissza egy mezobe, ami eredetileg NULL volt.
    reszletes = '\n'.join(
        f'  A(z) {k} TELJES REGI ERTEKE (masolhato, ha vissza kell allitani):\n  '
        + (str(elotte[k]) if elotte[k] is not None else '(ures -- NULL volt)')
        for k in valtozik)
    # GEPI ZAROSOR (Samu verify-lelete a #1296-on, 2026-09-12). A kovetkezo kor
    # figyelmeztetese EBBOL olvassa vissza a mozgatot -- SOHA a fenti szabad szovegbol.
    # A szabad szoveges parse harom alakban bukott: a 'dr. Kovacs' nevet az elso pontnal
    # levagta; egy regi ertek, amiben benne all a 'kerte: Hamis.' szoveg, atvette a valodi
    # szerzo helyet; es a legrosszabb, ha a beagyazott nev EGYBEESIK a kovetkezo mozgatoeval,
    # az intes teljesen ELNEMUL -- pont az utkozes-alaku adaton, amiert letezik.
    # A zarosor az UTOLSO sor, a `reszletes` (tehat minden kulso eredetu ertek) MOGOTT all,
    # es a visszaolvasas az UTOLSO illeszkedest veszi: egy ertekbe hamisitott zarosor igy
    # sosem elozheti meg a valodit. A nevbol a sortoresek kiesnek, kulonben a nev maga
    # tudna zarosort hamisitani.
    # A NEVBOL A SORTORES ES A MEZOELVALASZTO IS KIESIK (Samu 2. verify-kore, B2-alak).
    # A sortores-ejtes onmagaban keves volt: egy 'Silent | mezok: z' alaku nev ELCSUSZTATJA a
    # mezok-mezot, es ha utana egy tenyleg 'Silent' nevu szerzo mozgat, a FIGYELMEZTETES ELNEMUL --
    # vagyis a nev maga allitja elo pontosan azt a csendet, amiert ez a mechanizmus letezik.
    # A '|' ejtese ugyanaz az elv, mint a sortorese: a zarosor szerkezetet a NEV nem irhatja felul.
    mozgato = ' '.join((a.author or '(ismeretlen)').replace('|', '/').split())
    zarosor = f'{_ZAROSOR_ELO}{mozgato} | mezok: {",".join(valtozik)} | ts: {now}'
    db.execute('INSERT INTO kanban_comments (card_id,author,content,created_at) VALUES (?,?,?,?)',
               (a.id, 'kartya-es-ertesites',
                '[kartya-es-ertesites.py] Mezomozgatas a fenti komment mellett ('
                + ', '.join(teljes)
                + f'), kerte: {a.author}. Fuggetlenul visszaolvasva.\n' + reszletes
                + '\n' + zarosor, now))
    db.commit()

# A mezomozgatas-nyom GEPI ZAROSORA. Ket helyen hasznaljuk: iraskor a nyom vegere kerul,
# olvasaskor EBBOL jon a mozgato neve. A sor-eleji ^ es a sor-vegi $ egyutt kell: enelkul a
# mintaja beleillik egy tobbsoros regi ertekbe is.
_ZAROSOR_ELO = '-- mozgato: '
_ZAROSOR_RE = re.compile(r'^-- mozgato: (.*?) \| mezok: (.*?) \| ts: (\d+)$', re.M)


def _elozmeny_figyelmeztetes(db, a, now, dry=False):
    """KI allitotta utoljara a mezot, es MIKOR -- a dontes ELE.

    A no-op fogas csak azt latja, ha az ertek MAR ez. Azt NEM, ha valaki MAS
    percekkel korabban allitotta at, es most valaki visszafordul. 2026-09-11-en
    HAROMSZOR tortent meg egy oran belul, ugyanattol a szokastol: masfel oras
    tabla-pillanatkepbol dolgozni. Ez NEM kapu -- a visszaallitas sokszor jogos.

    A DRY-RUN AGON IS FUT (Mira lelete, 2026-09-11): eloszor csak az eles agon
    futott, es ezzel EPP A GONDOS HASZNALOT buntette -- aki elovigyazatossagbol
    dry-runol egy mezomozgatas elott, kevesebb informaciot kapott, mint aki
    gondolkodas nelkul nekifutott. A negyedik utkozest pont az elozetes
    ellenorzes elozne meg, es az az ut volt a vak.
    """
    elozmeny = db.execute(
        "SELECT created_at, content FROM kanban_comments WHERE card_id=? "
        "AND content LIKE '[kartya-es-ertesites.py] Mezomozgatas%' ORDER BY created_at DESC LIMIT 1",
        (a.id,)).fetchone()
    if not elozmeny:
        return
    kora = now - elozmeny[0]
    perc = kora / 60.0
    # AZ UTOLSO illeszkedes szamit, nem az elso: a kulso eredetu regi ertekek a zarosor ELOTT
    # allnak, tehat egy oda hamisitott sor sosem elozheti meg a valodit.
    talalatok = _ZAROSOR_RE.findall(elozmeny[1] or '')
    if not talalatok:
        # REGI FORMATUMU NYOM (a zarosor elotti korokbol). Nem talalgatunk nevet a szabad
        # szovegbol -- az volt a hiba. De NEM is nemulunk el: a friss, ismeretlen mozgato
        # epp a kockazatos eset.
        if kora < 1800:
            print(f'FIGYELEM -- AZ ELOZO MEZOMOZGATAS {perc:.0f} PERCE VOLT, a mozgato viszont '
                  f'NEM ALLAPITHATO MEG gepileg (regi formatumu nyom). Nezd meg a kartyan, '
                  f'ki mozgatott, mielott visszaforditod.')
        else:
            print(f'(elozo mezomozgatas: {perc:.0f} perce -- regi formatumu nyom, a mozgato nem '
                  f'allapithato meg gepileg)')
        return
    ki, mit, _ts = talalatok[-1]
    ki = ki.strip()
    if kora < 1800 and ki.lower() != (a.author or '').lower():
        print(f'FIGYELEM -- AZ ELOZO MEZOMOZGATAS {perc:.0f} PERCE VOLT, ES NEM A TIED: '
              f'{ki} allitotta ({mit}). Ha ezt most visszaforditod, elavult allapotbol dolgozol. '
              + ('Eles futasban a mozgatas VEGREHAJTODNA -- most semmi nem irodik.'
                 if dry else 'A mozgatast VEGREHAJTOM, de a kartyan lasd az o indokat is.'))
    else:
        print(f'(elozo mezomozgatas: {ki}, {perc:.0f} perce -- {mit})')

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--id', required=True); p.add_argument('--assignee')
    p.add_argument('--title')
    # A SUGO MONDJA MEG, MIT TUD A KAPCSOLO A KET AGON (Marveen kikotese, EKEZETKAPU919).
    # A korlatot eddig csak a keveres-kapu uzenete mutatta, amibol NEM derult ki, hogy a
    # leiras utolag javithatatlan -- aki nekifutott, a megtagadasbol azt olvasta ki, hogy
    # rossz kapcsolot hasznal, nem azt, hogy nincs ilyen ut.
    p.add_argument('--desc-file',
                   help='a kartya leirasa fajlbol. LETREHOZO modban a kezdo leiras; '
                        '--comment-file mellett a MEGLEVO leiras CSEREJE (a regi szoveg '
                        'teljes egeszeben bekerul a mozgatas-nyom kommentbe).')
    p.add_argument('--msg-file'); p.add_argument('--priority', default=None)
    # Az alapertelmezes SZANDEKOSAN None (nem 'planned'/'normal'): csak igy lehet
    # megkulonboztetni a KIMONDOTT erteket a nem-adottol. A letrehozo ag lentebb tolti fel.
    p.add_argument('--status', default=None); p.add_argument('--no-msg', action='store_true')
    p.add_argument('--nincs-ertesites-szandekos', action='store_true',
                   dest='nincs_ertesites_szandekos',
                   help='KIMONDOTT felulbiralas komment-modban: MAS flotta-agens kartyajara irsz\n'
                        'kommentet, es szandekosan NEM ertesited ot (KOMMENTERTESITES922)')
    p.add_argument('--comment-file', help='KOMMENT-ONLY mod: komment meglevo kartyara, ertesites nelkul')
    p.add_argument('--assignee-uj', action='store_true', dest='assignee_uj',
                   help='komment-mod: kimondva uj (a tablan meg nem szereplo) felelos-nev')
    # NINCS CSENDES ALAPERTELMEZES (KARTYADRYRUN907, 2026-09-08). Korabban itt
    # default='Marveen' allt, tehat egy --author nelkuli komment SZO NELKUL a
    # koordinatort nevezte meg szerzokent -- a kimenet OK-t mondott, a kartyan pedig
    # MAS neve allt. A None azert kell, hogy a komment-ag meg tudja KULONBOZTETNI a
    # kimondott erteket a nem-adottol; a letrehozo ag alapertelmezese lentebb, KIMONDVA all.
    p.add_argument('--author', default=None, help='a komment szerzoje (komment-modban KOTELEZO)')
    p.add_argument('--from', dest='from_agent', default=None,
                   help='az ertesites feladoja (alapertelmezes: az --author kisbetusitve)')
    p.add_argument('--ekezet-nelkul-szandekos', action='store_true',
                   dest='ekezet_nelkul_szandekos',
                   help='KIMONDOTT felulbiralas, ha a komment VAGY a leiras (--desc-file, mindket agon) '
                        'szandekosan ekezet nelkuli: nyers log, kod-reszlet, surgos eset')
    p.add_argument('--dry-run', action='store_true')
    a = p.parse_args()

    if a.comment_file:
        # A KEVERES-KAPUT KI KELL ENGEDNI az uj mezohoz, kulonben az uj kod ELERHETETLEN, es a
        # bovites "kesz"-nek latszik ugy, hogy soha nem fut le (Boni kikotese a cim-bovitesnel).
        # A --desc-file 2026-09-19 OTA MOZGATO KAPCSOLO IS (EKEZETKAPU919). Korabban itt allt a
        # tiltasban, es ettol a LEIRAS volt az egyetlen kartya-mezo, amit letrehozas utan SENKI
        # nem tudott javitani -- egy elsore rosszul megirt leiras VEGLEGES volt. A tiltas nem
        # leiras-vedelem volt, hanem hianyzo UPDATE-ut: a mozgato ag egyszeruen nem ismerte a
        # mezot (merve 2026-09-19, Geri). A --msg-file marad tiltva: az ERTESITES, ami a
        # letrehozashoz tartozik, nem a kartya allapotahoz. -- LASD LENT: FELOLDVA.
        # A --msg-file TILTASA FELOLDVA (KOMMENTMSGFILE922, 2026-09-22). A tiltas indoka az volt,
        # hogy "az ERTESITES a letrehozashoz tartozik, nem a kartya allapotahoz". A KOMMENTERTESITES922
        # ezt a premisszat CAFOLJA: ott mondtuk ki, hogy egy MAS flotta-agens kartyajara irt KOMMENT is
        # ertesitest KOVETEL. Nem lehet ugyanabban az eszkozben kotelezove tenni az ertesitest es kozben
        # tiltani a kapcsolot, ami megadja.
        # A MASODIK, MERT OK: a megtagadas OLCSOBBA tette a kibuvot a helyes utnal -- a helyes ut egy
        # MASIK szkript volt kulon lepessel, a kibuvo EGY kapcsolo ugyanazon a parancssoron. Aki siet,
        # a kapcsolot valasztja, es a kapu teljesitettnek erzodik.
        # A HARMADIK: ugyanez a tiltas mar egyszer tevedett ugyanigy. A --desc-file is itt allt, es
        # 2026-09-19-en (EKEZETKAPU919) merve kiderult, hogy nem leiras-vedelem volt, hanem hianyzo
        # UPDATE-ut. Mindket indok a FOGALOM birtoklasarol szolt, nem mert korlatrol.
        komment_mod(a)
        return
    if a.assignee_uj:
        sys.exit('MEGTAGADVA: az --assignee-uj csak komment-modban (mezomozgatas) ertelmes.\n'
                 'A letrehozo ag a kimondott felelos-nevet szo szerint elfogadja.')
    if not a.assignee or not a.title:
        sys.exit('MEGTAGADVA: letrehozo modhoz --assignee es --title kell (komment-modhoz --comment-file).')

    a.status = a.status or 'planned'
    a.priority = a.priority or 'normal'
    if a.status not in STATUSZOK:
        sys.exit(f'MEGTAGADVA: ervenytelen statusz ("{a.status}"). Ervenyes: {", ".join(STATUSZOK)}.')
    if a.priority not in PRIORITASOK:
        sys.exit(f'MEGTAGADVA: ervenytelen prioritas ("{a.priority}"). Ervenyes: {", ".join(PRIORITASOK)}.')

    # UGYANAZ A KANONIKUS ALAK, mint a mozgato agon -- kulonben a ket ut ugyanarra a nevre
    # KET KULONBOZO erteket irna a tablara.
    who = _felelos_feloldas(a.assignee)
    # A FELADO KIMONDOTT (KARTYAKULDO908, 2026-09-08). Korabban itt egy 'Marveen' tartalek allt:
    # --author es --from nelkul az ertesites CSENDBEN a koordinator neveben ment ki. Mira merte
    # 2026-09-07-en (21680), mi tortenik ilyenkor: Tomi olyan feladat-kiosztast kapott, ami ugy
    # nezett ki, mintha a FO-AGENS adta volna, holott a kartya Mirae volt. Az attribucios hiba
    # iranya a rossz: FELFELE mutat, tehat SULYT ad egy kerésnek, amit nem a koordinator kuldott,
    # es a cimzett neki is valaszolna vissza.
    # A #1237 ezt a komment-agon mar lezarta; ez a kapu ugyanaz a LETREHOZO agon. A ket agat
    # SZANDEKOSAN kulon PR zarja: a regi viselkedest egy KIADOTT teszt rogzitette
    # regresszio-kontrollkent (kartya-ertesites-felado, 3. ellenorzes), es egy ilyen szerzodest
    # nem irunk at egy masik javitas mellekhatasakent -- kulon dontesbol, a teszttel egyutt.
    if not a.from_agent and not a.author:
        sys.exit('MEGTAGADVA: a letrehozo agon is KIMONDOTT a felado: add meg az --author-t\n'
                 '(a kartya szerzoje) vagy a --from-ot (az ertesites feladoja).\n'
                 'Korabban ez csendben "marveen"-re esett vissza, tehat a cimzett ugy latta,\n'
                 'mintha a koordinator kerte volna -- es neki is valaszolt volna vissza.')
    frm = (a.from_agent or a.author).strip().lower()
    if frm not in KULDOK:
        sys.exit(f'MEGTAGADVA: ismeretlen felado ("{frm}"). Ervenyes: {", ".join(sorted(KULDOK))}.\n'
                 f'Ha az --author nem agens-nev (pl. "Marveen (Boni lelete)"), add meg kimondva: --from <agens>.')
    desc = open(a.desc_file, encoding='utf-8').read() if a.desc_file else ''
    msg = open(a.msg_file, encoding='utf-8').read() if a.msg_file else ''
    # EKEZET-KAPU A LEIRASON, A LETREHOZO AGON IS (EKEZETKAPU919, 2026-09-21). A ket ag kulon
    # kodut, es a kapu eddig EGYIKEN SEM allt: a leiras volt az utolso gazdanak szant mezo, ami
    # ekezet nelkul bement. Merve a kartyan: egy teljes leiras ment be igy, es a gazda ugyanugy
    # olvasta, mint a kommentet. A kapu az IRAS ELE kerul, mint a kommentnel.
    # AZ ERTESITES (--msg-file) SZANDEKOSAN NEM ESIK IDE: az nem a kanban-felulet, hanem
    # inter-agent uzenet, es a cimzettje gep. Ha oda is kell, az kulon dontes es kulon meres.
    _ekezet_kapu(desc, a.ekezet_nelkul_szandekos, 'leiras')

    # 1. KAPU: flotta-gazda ertesites nelkul -> megtagadva
    if who in FLEET and not msg and not a.no_msg:
        sys.exit(f'MEGTAGADVA: "{who}" flotta-agens, es nincs --msg-file. Egy megnevezett gazdas kartya,\n'
                 f'amirol a gazdaja nem tud, ugyanolyan nema, mintha nem letezne. Vagy adj uzenetet,\n'
                 f'vagy mondd ki a --no-msg kapcsoloval, hogy szandekosan nem ertesitesz.')
    if a.no_msg and who in FLEET:
        print(f'FIGYELEM: --no-msg egy flotta-gazdas ({who}) kartyanal. Ez szandekos kihagyas.')
    # ELLENTMONDAS-KAPU (sajat teszt lelete, 2026-09-06): `--no-msg` + `--msg-file` egyutt
    # korabban ATCSUSZOTT, es az uzenet MEGIS kiment -- vagyis a kimondott "ne kuldj" nem hatott.
    # Ugyanaz a hibaosztaly, mint Boni --status-lelete: egy kapcsolo, ami nem azt teszi, amit igér.
    # Nem valasztunk helyette: megtagadjuk, mert a ket szandek kozul nem talalhato ki, melyik az igazi.
    if a.no_msg and a.msg_file:
        sys.exit('MEGTAGADVA: --no-msg ES --msg-file egyszerre -- a ketto ellentmond egymasnak.\n'
                 'Vagy uzenetet kuldesz (--msg-file), vagy kimondva nem (--no-msg), de nem mindkettot.')

    # 2. cim-kapu ELORE
    if len(a.title) > 300:
        sys.exit(f'MEGTAGADVA: a cim {len(a.title)} karakter (max 300). A trigger levagna es kommentbe tenne.\n'
                 f'A cim EGY sor legyen (lelet + gazda + hatarido), a reszletek a leirasba.')
    # 2a. ID-HORGONY: ugyanaz a kapu, mint a cim-mozgatason. Ha csak a mozgatasra allna, a
    # horgony nelkuli cim egyszeruen a LETREHOZASKOR kerulne be, es a kapu semmit nem vedene.
    _horgony_kapu(a.id, a.title)

    # 2b. AZ UZENET NEVEZZE MEG A KARTYAT (2026-09-05, az eszkoz ELSO eles hasznalata bukott el rajta).
    # Az ORSZEMROUTING905 uzenete kiment es meg is erkezett, de a szovege SEHOL nem irta le a kartya
    # azonositojat -- ezert (a) a cimzett nem tudja osszekotni a kartyaval, es (b) a kanban-audit
    # kikuldes-detektora KIKULDETLENNEK olvassa, mert az ID-re illeszt. Elo-ellenorzes, tehat a
    # visszautasitas meg semmit nem irt.
    if msg and a.id not in msg:
        sys.exit(f'MEGTAGADVA: az uzenet szovege sehol nem nevezi meg a kartyat ({a.id}).\n'
                 f'Enelkul a cimzett nem tudja osszekotni a kettot, es az audit kikuldetlennek olvassa.\n'
                 f'Ird bele az azonositot a szovegbe (pl. "Kartya: {a.id}").')

    # 3. homoglifa-szures a sajat szovegemen
    for cimke, szoveg in (('cim', a.title), ('leiras', desc), ('uzenet', msg)):
        if (h := gyanus(szoveg)):
            sys.exit(f'MEGTAGADVA: vegyes irasrendszeru szo a(z) {cimke}-ban: {h[:5]}')
    for cimke, szoveg in (('cim', a.title), ('leiras', desc), ('uzenet', msg)):
        gepi_idobelyeg_jelzes(szoveg, cimke)

    if a.dry_run:
        # PARITAS-KAPU (KARTYADRYRUN907; Mira lelete 2026-09-07, UJRA ELO 2026-09-08 a kiadott
        # peldanyban). A dry-run KORABBAN ITT tert vissza: a 4. lepes letezes-ellenorzese ES az
        # 5. lepes token-kapuja ELOTT. Ezert zoldet adott ket olyan futasra, amit az eles ag
        # megtagad vagy elront:
        #   - LETEZO id-re "minden ellenorzes atment" (az eles ag: MEGTAGADVA, MAR LETEZIK);
        #   - token nelkul, uzenettel szinten zold (az eles ag: a kartya letrejon, az uzenet nem).
        # Egy dry-run, ami MEGENGEDOBB az eles agnal, rosszabb, mintha nem lenne: pont az a
        # hasznalat dol be, amiert a kapcsolo letezik ("atmenne-e?"). A kapcsolo erteke a
        # PARITAS, nem a szigor -- ezert a lenti ket kapu ugyanaz, mint az eles agon, es ezert
        # meri a kartya-dryrun-paritas teszt MINDKET IRANYT (a hamis zoldet es a hamis pirosat is).
        # IRNI TOVABBRA SEM IR: a letezes-ellenorzes READ-ONLY kapcsolaton megy, igy a dry-run
        # meg egy hianyzo DB-fajlt sem hozhat letre.
        dbro = sqlite3.connect(f'file:{_db_kapu()}?mode=ro', uri=True)
        letezik = dbro.execute('SELECT 1 FROM kanban_cards WHERE id=?', (a.id,)).fetchone()
        dbro.close()
        if letezik:
            # SZO SZERINT ugyanaz a mondat, mint az eles agon (a paritas-teszt 3. ellenorzese
            # pont ezt meri): ha a ket ag MAS okot mond ugyanarra, az olvasoja nem tudja
            # eldonteni, hogy ugyanaz a kapu fogta-e meg.
            sys.exit(f'MEGTAGADVA: a(z) {a.id} kartya MAR LETEZIK.')
        if msg and who == GAZDA:
            dbro2 = sqlite3.connect(f'file:{_db_kapu()}?mode=ro', uri=True)
            print(_gazda_figyelmeztetes(dbro2)); dbro2.close()
        elif msg:
            _token_kapu(dry_run=True)
        print(f'DRY-RUN OK (DB: {DB}): minden ellenorzes atment (a letezes- es a token-kaput is'
              f' beleertve).\n  id={a.id} gazda={who} statusz={a.status} '
              f'prio={a.priority}\n  cim {len(a.title)} kar | leiras {len(desc)} kar | uzenet {len(msg)} kar')
        return

    # 4. kartya + VISSZAOLVASAS
    now = int(time.time())
    db = sqlite3.connect(_db_kapu()); db.execute('PRAGMA busy_timeout=8000')
    if db.execute('SELECT 1 FROM kanban_cards WHERE id=?', (a.id,)).fetchone():
        sys.exit(f'MEGTAGADVA: a(z) {a.id} kartya MAR LETEZIK.')
    db.execute('''INSERT INTO kanban_cards (id,title,description,status,assignee,priority,sort_order,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,0,?,?)''', (a.id, a.title, desc, a.status, who, a.priority, now, now))
    db.commit()
    back = db.execute('SELECT id,status,assignee,length(title) FROM kanban_cards WHERE id=?', (a.id,)).fetchone()
    if not back: sys.exit('HIBA: a kartya nem olvashato vissza -- az iras nem tortent meg.')
    print(f'KARTYA OK (visszaolvasva innen: {DB}): {back}')

    # 5. uzenet + VISSZAOLVASAS
    if not msg:
        print('uzenet: kihagyva (--no-msg)'); return
    if who == GAZDA:
        # GAZDA-KAPU (GAZDAUZENET921): nem POST-olunk egy sort, amirol tudjuk, hogy failed lesz --
        # a zold `UZENET OK` pont ezt a sort olvasta vissza. A kanban-audit kikuldes-detektora a
        # felelostol JOVO uzeneteket nezi (from_agent = assignee), nem a neki cimzetteket, tehat a
        # kihagyott sor ott sem hianyzik.
        print(_gazda_figyelmeztetes(db))
        db.execute('INSERT INTO kanban_comments (card_id,author,content,created_at) VALUES (?,?,?,?)',
                   (a.id, 'kartya-es-ertesites',
                    f'[kartya-es-ertesites.py] A kartya letrejott, az ertesites NEM ment ki: a felelos a '
                    f'gazda ({GAZDA}), akinek nincs agens-sessionje, az inter-agent uzenet szerkezetileg nem '
                    f'kezbesitheto. A gazdahoz Telegramon kell szolni. A kartya visszaolvasva.', now))
        db.commit()
        print('NYOM OK: kartya-komment arrol, hogy ertesites NEM ment (gazda-cimzett)')
        return
    # ONHUROK (Boni 20254): a sajat magara osztott kartya ertesitese visszaert a keszitohoz, es egy
    # fordulojaba kerult, mire kiderult, hogy a sajat szoveget kapta vissza. Nem elhagyjuk az uzenetet
    # (a kartya akkor nema lenne), hanem a KOORDINATORHOZ iranyitjuk -- kimondva.
    cimzett = who
    if frm == who:
        if who == COORDINATOR:
            print(f'FIGYELEM: a felado es a felelos is a koordinator ({who}) -- nincs hova atiranyitani, '
                  f'az uzenet magahoz megy.')
        else:
            cimzett = COORDINATOR
            msg = (f'[ATIRANYITVA: {frm} a sajat magara osztott {a.id} kartyajarol ertesit; '
                   f'onhurok helyett a koordinatorhoz megy.]\n{msg}')
            print(f'ATIRANYITVA: felado == felelos ({who}) -- az ertesites a koordinatorhoz '
                  f'({COORDINATOR}) megy, nem onmagahoz.')

    # A token a gyokerbol jon, tehat ugyanaz a feloldas vonatkozik ra. KARTYA_TOKEN: teszt-horog
    # es kimondott felulbiralas, ugyanabban az alakban, mint a KARTYA_DB/KARTYA_API.
    tok = _token_kapu(dry_run=False)
    req = urllib.request.Request(API,
        data=json.dumps({'from': frm, 'to': cimzett, 'content': msg}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok}, method='POST')
    try:
        r = json.load(urllib.request.urlopen(req))
    except Exception as e:
        sys.exit(f'A KARTYA LETREJOTT, DE AZ UZENET NEM MENT KI: {e}\n'
                 f'Kuldd el kezzel, kulonben a kartya nema marad.')
    mid = r.get('id')
    if not mid: sys.exit(f'A KARTYA LETREJOTT, de az uzenet-valasz nem ad id-t: {str(r)[:200]}')
    row = db.execute('SELECT id,from_agent,to_agent,status FROM agent_messages WHERE id=?', (mid,)).fetchone()
    if not row:
        sys.exit(f'A KARTYA LETREJOTT, de a {mid} uzenet-sor NEM OLVASHATO VISSZA.')
    # A visszaolvasas a FELADOT is meri: pont ez a mezo allt korabban hardcode-olva.
    if row[1] != frm or row[2] != cimzett:
        sys.exit(f'HIBA: a sor nem azt hordozza, amit kuldtunk. Vart: {frm} -> {cimzett}; '
                 f'kapott: {row[1]} -> {row[2]}. Az ertesites ROSSZ NEVEN all.')
    print(f'UZENET OK (visszaolvasva a sorbol, felado is): {row}')

    # NYOM A KARTYAN: melyik uton keszult, es melyik uzenet tartozik hozza.
    # Boni lelete (2026-09-05): a kikuldes-detektor VEGYES populaciot mer -- a kozvetlenul
    # felvett es az eszkozzel felvett kartyakat egyutt. Enelkul a jovo heti szam nem
    # valaszthato szet "az eszkoz hasznalt-e" es "kevesebb kartya keszult" kozott.
    db.execute('INSERT INTO kanban_comments (card_id,author,content,created_at) VALUES (?,?,?,?)',
               (a.id, 'kartya-es-ertesites',
                f'[kartya-es-ertesites.py] A kartya es az ertesites EGY lepesben keszult. '
                f'Ertesites: msg {mid}, {frm} -> {cimzett}'
                + (' (ONHUROK helyett a koordinatorhoz iranyitva).' if cimzett != who else '.')
                + ' Mindket iras visszaolvasva.', now))
    db.commit()
    print(f'NYOM OK: kartya-komment a keszites utjarol (msg {mid})')

if __name__ == '__main__':
    main()
