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
  - --dry-run: mindent ellenoriz, semmit nem ir.

Hasznalat:
  kartya-es-ertesites.py --id X905 --assignee boni --title "..." --desc-file /path
      --msg-file /path [--priority normal] [--status planned] [--dry-run]
Az onmagunknak (marveen) vagy a gazdanak (szabolcs) szolo kartya ertesites nelkul is mehet:
ott a --no-msg kapcsolo kell, KIMONDVA.

A KULDO NEVE (KARTYAKULDO906, Boni lelete 20254): az ertesites feladoja a --from, alapertelmezese
az --author kisbetusitve. Korabban a from HARDCODE 'marveen' volt, tehat az eszkoz MINDEN agens
ertesiteset a fo-agens neveben kuldte ki -- aki olvasta, a MAS mereset ENGEM idezte. Attribucios
hiba, nem kenyelmi kerdes: ket napja pont azon dolgozunk, hogy KI mert MIT es MILYEN HATARRAL.
ONHUROK: ha a felado ES a felelos ugyanaz, az ertesites nem onmagahoz megy, hanem a
KOORDINATORHOZ (marveen) -- kimondva, a kimeneten es az uzenet elso soraban is.

KOMMENT-ONLY MOD (KARTYAIRASESZKOZ905, 2026-09-05): komment egy MEGLEVO kartyara,
ERTESITES NELKUL, ugyanazokkal a kapukkal es kotelezo visszaolvasassal:
  kartya-es-ertesites.py --id X905 --comment-file /path [--author Samu] [--dry-run]
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
FLEET = {'samu','zara','boni','iris','dani','geri','deeper','qwen','mira','tomi','jumanji','hidli'}
COORDINATOR = 'marveen'
GAZDA = 'szabolcs'
# Ismert FELELOS-nevek. NEM zart halmaz: a tablan 2026-09-06-an 40 kulonbozo felelos allt, es a
# tobbsegi nem-flotta ertek kulso GitHub-felhasznalonev (PR-kartyak szerzoi). Ezert a nem-ismert
# nev nem automatikusan hiba -- lasd _felelos_feloldas.
ISMERT_FELELOSOK = FLEET | {COORDINATOR, GAZDA}


def _felelos_feloldas(nyers):
    """A felelos KANONIKUS alakja. Flotta/gazda nev -> kisbetus (ez a tabla bevett alakja).
    MINDEN MAS nev SZO SZERINT marad.

    MERVE (2026-09-06, elo tabla): a nem-flotta felelosok kulso GitHub-nevek, es TOBB VEGYES
    KISBETUS-NAGYBETUS alakban allnak (Vlbbtabs, KratoBal, PCha0s, palvolgyidigital). A korabbi
    feltetel nelkuli .lower() ezeket MAS ertekke alakitotta, mint ami a tablan all -- vagyis a
    tool-lal felvett kartya kulon oszlopba kerult volna ugyanattol a szerzotol. A kisbetusites
    ezert a FLOTTA-nevekre szol, ahol az a bevett alak, es nem a tablatol idegen normalizalas."""
    nev = nyers.strip()
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

GEPI_FEJLEC_RX = re.compile(r'^\s*\[[^\]\n]*\d{1,2}:\d{2}, rendszerora\]\s*\n?')

def komment_mod(a):
    """Komment egy MEGLEVO kartyara, ertesites nelkul. Kapuk + kotelezo visszaolvasas."""
    text = open(a.comment_file, encoding='utf-8').read().strip()
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
    if a.status is not None and a.status not in STATUSZOK:
        sys.exit(f'MEGTAGADVA: ervenytelen statusz ("{a.status}"). Ervenyes: {", ".join(STATUSZOK)}.')
    if a.priority is not None and a.priority not in PRIORITASOK:
        sys.exit(f'MEGTAGADVA: ervenytelen prioritas ("{a.priority}"). Ervenyes: {", ".join(PRIORITASOK)}.')

    db = sqlite3.connect(_db_kapu()); db.execute('PRAGMA busy_timeout=8000')
    card = db.execute('SELECT id,status,assignee,priority,title FROM kanban_cards WHERE id=?', (a.id,)).fetchone()
    if not card:
        sys.exit(f'MEGTAGADVA: a(z) {a.id} kartya NEM LETEZIK -- komment-only mod csak meglevo kartyara ir.\n'
                 f'Uj kartyahoz a letrehozo mod valo (--assignee/--title).')
    # ELOTTE-PILLANATKEP: enelkul a visszaolvasas nem meres, csak egy ertek felolvasasa.
    elotte = {'status': card[1], 'priority': card[3], 'title': card[4], 'assignee': card[2]}
    # A FELELOS FELOLDASA a kartya ismereteben: a kanonikus alakot hasonlitjuk az elotte-erteknek,
    # kulonben egy "Samu" -> "samu" no-op valodi mozgatasnak latszana.
    uj_felelos = None
    if a.assignee is not None:
        uj_felelos = _felelos_feloldas(a.assignee)
        if not uj_felelos:
            sys.exit('MEGTAGADVA: ures felelos-nev.')
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
    mozgatas = {k: v for k, v in (('status', a.status), ('priority', a.priority), ('title', a.title),
                                  ('assignee', uj_felelos))
                if v is not None}
    valtozik = {k: v for k, v in mozgatas.items() if v != elotte[k]}
    valtozatlan = {k: v for k, v in mozgatas.items() if v == elotte[k]}

    now = int(time.time())
    fejlec = f'[{a.author} {time.strftime("%Y-%m-%d %H:%M", time.localtime(now))}, rendszerora]'
    tartalom = f'{fejlec}\n{text}'
    if a.dry_run:
        terv = (', '.join(f'{k}: {str(elotte[k])[:57]} -> {str(v)[:57]}' for k, v in valtozik.items()) or 'nincs')
        print(f'DRY-RUN OK (komment-mod, DB: {DB}): kartya letezik ({card}), kapuk atmentek.\n'
              f'  fejlec: {fejlec} | szoveg {len(text)} kar | ertesites: NINCS (komment-only)\n'
              f'  mezomozgatas: {terv}'
              + (f' | mar ezen az erteken all: {valtozatlan}' if valtozatlan else ''))
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
          f'{back[2]} kar, created_at==fejlec-ido. Ertesites: nem ment (komment-only).')

    if valtozatlan:
        print(f'FIGYELEM: mar ezen az erteken all, nem mozgatom: '
              + ', '.join(f'{k}={v}' for k, v in valtozatlan.items()))
    if not valtozik:
        if mozgatas:
            print('MEZOMOZGATAS: nincs teendo (minden kimondott ertek mar ez volt).')
        return
    sets = ', '.join(f'{k}=?' for k in valtozik)
    cur = db.execute(f'UPDATE kanban_cards SET {sets}, updated_at=? WHERE id=?',
                     (*valtozik.values(), now, a.id))
    db.commit()
    if cur.rowcount != 1:
        sys.exit(f'HIBA: a mezomozgatas {cur.rowcount} sort erintett (1 helyett) -- a komment MAR BEIRT.')
    # FUGGETLEN visszaolvasas: uj SELECT, nem a cursor allitasa. A 0-talalatos UPDATE
    # es a sikeres UPDATE kulonben megkulonboztethetetlen lenne.
    utana = db.execute('SELECT status,priority,title,assignee FROM kanban_cards WHERE id=?', (a.id,)).fetchone()
    kapott = {'status': utana[0], 'priority': utana[1], 'title': utana[2], 'assignee': utana[3]}
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
    db.execute('INSERT INTO kanban_comments (card_id,author,content,created_at) VALUES (?,?,?,?)',
               (a.id, 'kartya-es-ertesites',
                '[kartya-es-ertesites.py] Mezomozgatas a fenti komment mellett ('
                + ', '.join(f'{k}: {rov(elotte[k])} -> {rov(kapott[k])}' for k in valtozik)
                + f'), kerte: {a.author}. Fuggetlenul visszaolvasva.', now))
    db.commit()

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--id', required=True); p.add_argument('--assignee')
    p.add_argument('--title'); p.add_argument('--desc-file')
    p.add_argument('--msg-file'); p.add_argument('--priority', default=None)
    # Az alapertelmezes SZANDEKOSAN None (nem 'planned'/'normal'): csak igy lehet
    # megkulonboztetni a KIMONDOTT erteket a nem-adottol. A letrehozo ag lentebb tolti fel.
    p.add_argument('--status', default=None); p.add_argument('--no-msg', action='store_true')
    p.add_argument('--comment-file', help='KOMMENT-ONLY mod: komment meglevo kartyara, ertesites nelkul')
    p.add_argument('--assignee-uj', action='store_true', dest='assignee_uj',
                   help='komment-mod: kimondva uj (a tablan meg nem szereplo) felelos-nev')
    p.add_argument('--author', default='Marveen', help='komment-mod: a komment szerzoje')
    p.add_argument('--from', dest='from_agent', default=None,
                   help='az ertesites feladoja (alapertelmezes: az --author kisbetusitve)')
    p.add_argument('--dry-run', action='store_true')
    a = p.parse_args()

    if a.comment_file:
        # A KEVERES-KAPUT KI KELL ENGEDNI az uj mezohoz, kulonben az uj kod ELERHETETLEN, es a
        # bovites "kesz"-nek latszik ugy, hogy soha nem fut le (Boni kikotese a cim-bovitesnel).
        if a.msg_file or a.desc_file:
            sys.exit('MEGTAGADVA: a --comment-file nem keverheto a letrehozo mod kapcsoloival\n'
                     '(--desc-file/--msg-file) -- egy futas egy muvelet.\n'
                     'A --title/--status/--priority/--assignee viszont MOZGATJA a meglevo kartyat.')
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
    if not who:
        sys.exit('MEGTAGADVA: ures felelos-nev.')
    # A FELADO: kimondva (--from), vagy a szerzobol. Az alapertelmezes az --author kisbetusitve,
    # tehat a korabbi viselkedes (--author nelkul: 'marveen') valtozatlan marad.
    frm = (a.from_agent or a.author).strip().lower()
    if frm not in KULDOK:
        sys.exit(f'MEGTAGADVA: ismeretlen felado ("{frm}"). Ervenyes: {", ".join(sorted(KULDOK))}.\n'
                 f'Ha az --author nem agens-nev (pl. "Marveen (Boni lelete)"), add meg kimondva: --from <agens>.')
    desc = open(a.desc_file, encoding='utf-8').read() if a.desc_file else ''
    msg = open(a.msg_file, encoding='utf-8').read() if a.msg_file else ''

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

    if a.dry_run:
        _db_kapu()
        print(f'DRY-RUN OK (DB: {DB}): minden ellenorzes atment.\n  id={a.id} gazda={who} statusz={a.status} '
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
    tokpath = os.path.join(ROOT, 'store', '.dashboard-token')
    tok = os.environ.get('KARTYA_TOKEN')
    if tok is None:
        if not os.path.exists(tokpath):
            sys.exit(f'A KARTYA LETREJOTT, DE AZ UZENET NEM MENT KI: nincs dashboard-token itt:\n'
                     f'  {tokpath}\n(gyoker: {ROOT}). Mondd ki: CLAUDECLAW_ROOT=<a fo fa> vagy KARTYA_TOKEN=<token>.\n'
                     f'Kuldd el kezzel az uzenetet, kulonben a kartya nema marad.')
        tok = open(tokpath).read().strip()
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
