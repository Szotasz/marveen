#!/usr/bin/env python3
"""destructive-gate.py -- PreToolUse kapu a valoban visszafordithatatlan muveletekre.

MIERT LETEZIK (2026-09-08): az agensek atalltak engedelylistas (strict) modrol
permissive modra, mert az engedelylista sosem lehet teljes -- egy nap alatt haromszor
NEM a jogosultsag bukott el, hanem a HIVAS ALAKJA (relativ ut, cd-prefix, heredoc), es
hetbol negy agens allt egyszerre jovahagyasi kepernyon trivialis dolgokon (python3, cd,
tmux list-sessions, a sajat konyvtara olvasasa).

DE: a permissive mod a `--dangerously-skip-permissions` kapcsoloval indul, ami a
settings.json DENY listajat is hatalytalanitja. Ott pedig olyan tiltasok alltak, amelyek
TUDATOS dontesek voltak, nem veletlenek:
  - Istvan dontese 2026-09-07: a sub-agensek NEM kapnak mv/rm jogot. Indok: aznap a
    duplikacio MENTETTE MEG az adatot, tehat a torles ara bizonyitottan magas.
  - Hitelesito adatok olvasasanak tiltasa.
  - A kozos repoba valo push: kifele mutato, visszafordithatatlan.

KET SZABALY AZOTA SZUKULT (PR #1357 review, Szabolcs; Istvan mind az ot pontot
jovahagyta). Nem enyhites, hanem a hatar athelyezese oda, ahol a kockazat tenylegesen
van -- ugyanaz az indok, ami 2026-09-14-en a szovegkornyezet-erzekenyseget kikenyszeritette:

  - TORLES: a munkakonyvtar (PROJECT_ROOT) ALATT engedett. Kivul, valamint a .git es a
    store/ alatt tovabbra sem. Az agens a sajat munkaterulete szemetet takaritja; a
    verziotortenetet es az eles allapotot nem. Ami nem eldontheto (behelyettesites,
    csovezetekbol jovo lista, cwd nelkuli relativ ut), az tovabbra is BLOKK.
  - PUSH: a sajat munkaagra valo push engedett. Tiltott marad az eroltetett push
    (--force es tarsai, '+' refspec), a tavoli ag torlese, a --all, es a vedett agakra
    (main/master) iranyulo push. Cel-ag nelkuli `git push` szinten blokk: az upstream
    nem latszik a parancsbol, tehat nem eldontheto, hova menne.

  Miert nem maradt a szigorubb alak: egy tiltas, amit a mindennapi munka naponta
  beleutkozik, nem kockazatot csokkent, hanem megkerulest tanit -- ezt a kapu sajat
  merese mar egyszer kimutatta (lasd lentebb). A dontes az operatore: a kapu egeszet
  a biztonsagi profil kapcsolja be (`destructiveGate`), es alapbol KI van kapcsolva.

A HOOK a permission-modtol FUGGETLENUL fut. Ezert ami tenyleg tilos, az ide kerul, nem a
deny listara. A deny lista permissive modban disz; a hook nem az.

Ez a kapu SZANDEKOSAN SZUK. Nem azt sorolja fel, mi szabad (az volt a regi, elbukott
modell), hanem azt a nehany dolgot, amit nem szabad.

MIERT LETT SZOVEGKORNYEZET-ERZEKENY (2026-09-14, kartya ba856d56, lean-chief dontese):
A kapu eredetileg a parancs TELJES SZOVEGEBEN keresett mintat. Meres 3365 egyedi, valos
parancson: 109 blokk, ebbol 31 HAMIS POZITIV (28,4%) -- a minta heredoc-torzsben,
karakterlanc-literalban vagy kommentben allt, a muvelet SOHA nem hajtodott vegre. A
merest vegzo agens maga hatszor akadt el rajta egyetlen feladat kozben, es harom esetben
epp a hamis pozitivok DOKUMENTALASA, JELENTESE, illetve MAGA EZ A JAVITAS volt a
blokkolt muvelet. Ez nem kenyelmi kerdes: amig az atfogalmazas olcsobb, mint a jelentes,
a kapu nem kockazatot csokkent, hanem egyre ugyesebb megkeruleseket tanit.

A javitas NEM lazitja a szabalyokat (a lean-chief kifejezetten elvetette a "jelzes
blokkolas helyett" iranyt). Csak azt valtoztatja meg, HOL keres:
  1. a shell- es kod-KOMMENTSOROK nem futnak le -> kimaradnak;
  2. az ADAT-heredoc torzse ("cat > fajl <<EOF") fajlba megy -> kimarad;
  3. az ERTELMEZONEK adott heredoc torzse ("python3 - <<PY") FUT -> BENNE MARAD.
     Ez a kulonbsegtetel kotelezo elem volt: a mereskor ket VALODI hitelesito-fajl-
     olvasas allt ilyen torzsben, es egy naiv "heredoc kihagyasa" elengedte volna oket;
  4. a szokozt tartalmazo idezojeles szoveg proza vagy adat (uzenet-torzs, JSON-payload,
     regex-minta, teszt-eset), nem utvonal -> kimarad. A szokoz NELKULI idezojeles
     szoveg lehet utvonal, ezert az BENNE MARAD. Ugyanez all a beagyazott kodra: egy
     utvonal-literal szokoz nelkuli, egy magyarazo mondat nem az;
  5. a szegmensekre bontas es a parancsnev-felismeres IDEZOJEL-TUDATOS lett: egy '|'
     vagy ';' egy idezett grep-mintan belul nem vag uj szegmenst, es egy szokozt
     tartalmazo idezett szoveg (peldaul egy teszteset leirasa) nem parancsnev.

ISMERT, TUDATOSAN VALLALT KORLAT: ha egy utvonal SZOKOZT tartalmaz es idezojelben all,
a Bash-ag nem veszi eszre. A fajl-eszkoz ag (Read/Edit/Write) viszont igen, es azon a
meres 0 hamis pozitivot mutatott, ezert ott nem valtozott semmi.

Meres es reprodukcio: docs/destruktiv-kapu-hamis-pozitiv-meres.md
Regresszios teszt: scripts/__tests__/destructive-gate.test.py

Blokkolas: exit 2 + indoklas a stderr-re (a Claude Code ezt visszaadja az agensnek).
"""
import json, os, re, sys

# Parancsok, amelyeket nem az agens dont el. Nem stilus-kerdes: mindegyik adatot vagy
# allapotot semmisit meg visszafordithatatlanul.
BANNED_CMDS = {'rm', 'mv', 'shred', 'sudo', 'mkfs', 'dd'}
# 'rm' a listan marad, de NEM feltetel nelkul: sajat, szukebb szabalya van lentebb
# (_rm_allowed). A halmazban azert all, hogy egy jovobeli szerkesztes ne felejtse el:
# ez tovabbra is destruktiv parancs, csak nem mindig tiltott.

# A telepites gyokere. A sajat helyzetebol szarmazik -- <ROOT>/scripts/hooks/ezafajl --,
# nem konfigbol: egy kapunak nem lehet olyan bemenete, amit a vizsgalt fel is at tud irni.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# A munkakonyvtar alatt is vedett alkonyvtarak. A 'rm' engedelye a MUNKARA szol, nem a
# verziotortenetre es nem a futo allapotra: a .git ujrairhatatlan, a store/ pedig az
# eles adatbazist, a tokent es a vault-ot tartalmazza -- pont az, aminek az elvesztese
# 2026-09-07-en a tiltast egyaltalan indokolta.
RM_PROTECTED = ('.git', 'store')
# Feloldhatatlan alakok egy torlendo utvonalban. A '*' es a '?' NEM szerepel: a shell
# glob nem lep at '/'-en, tehat egy munkakonyvtar alatti minta a munkakonyvtar alatt
# marad. A behelyettesites viszont barmive kiertekelodhet, azt nem latjuk elore.
RM_UNRESOLVABLE = ('$', '`', '{', '}')
# Push-kapcsolok, amelyek a tavoli tortenetet irjak ujra vagy toroltetnek refet.
PUSH_FORCE_FLAGS = {'-f', '--force', '--force-with-lease', '--force-if-includes', '--mirror'}
PUSH_DELETE_FLAGS = {'-d', '--delete'}
# Ertekuket KULON szoban hozo push-kapcsolok (kulonben a szomszedjuk refspecnek latszik).
PUSH_VALUE_FLAGS = {'-o', '--push-option', '--receive-pack', '--exec', '--repo'}
# A vedett agak: ide kezzel, review-val megy valami, nem egy agens push-abol.
PROTECTED_BRANCHES = {'main', 'master'}
# Ut-elotagok, amelyek hitelesito adatot tartalmaznak.
PROTECTED_READ = ('.ssh', '.aws', '.gnupg', '.gmail-mcp')
# A hataroloval egyutt illesztunk: a puszta minta ELENGEDTE a zaro perjel nelkuli alakot,
# pedig pont az volt az eles eset 2026-09-08-an. A hatarolo azert kell, hogy a
# hasonlo kezdetu, de mas nevu konyvtar NE illeszkedjen.
PROTECTED_RE = re.compile(r'/\.(ssh|aws|gnupg|gmail-mcp)(?=/|\s|$|["\'])')
ENV_RE = re.compile(r'(?:^|[\s=:])(?:[^\s"\']*/)?\.env(?=$|[\s"\'`,;)\]}])')

# Amelyik parancs a heredoc-torzset VEGREHAJTJA, nem fajlba irja. Csak ezeknel marad
# bent a torzs a vizsgalt szovegben.
INTERPRETERS = {'python', 'python3', 'bash', 'sh', 'zsh', 'node', 'perl', 'ruby', 'php'}
SCRIPT_FLAGS = {'-c', '-e', '-E', '-p', '--command', '--eval'}
# -p is node's print-eval and -E is perl's feature-enabled -e. They are in the
# set only so the argument after them counts as CODE rather than prose. A flag
# that does not actually take a script (perl -pe, bash -p) is harmless here:
# _script_arg_ranges only records a range when a QUOTE follows the flag.

HOME = os.path.expanduser('~')

DELIMS = ('&&', '||', '$(', ';', '|', '\n', '`')


def block(msg):
    sys.stderr.write(
        'DESTRUKTIV-KAPU: BLOKKOLVA.\n' + msg +
        '\n\nEz nem jogosultsagi hiba, es nem is kell hozza jovahagyast kerned: '
        'ez a muvelet a Lean Chief dontese. Ha tenyleg szukseges, ird meg NEKI, '
        'hogy MIT es MIERT akarsz, es o elvegzi vagy engedelyezi.\n')
    sys.exit(2)


def _quote_map(text):
    """Minden karakterhez: idezojelen belul van-e (0=nem, 1=aposztrof, 2=idezojel).

    Toleransan kezeli a parositatlan idezojelet is: nem dob hibat, csak allapotot valt.
    """
    state = [0] * len(text)
    q = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '\\' and q != 1 and i + 1 < len(text):
            state[i] = q
            state[i + 1] = q
            i += 2
            continue
        if q == 0 and ch in ("'", '"'):
            q = 1 if ch == "'" else 2
            state[i] = 0            # maga a nyito jel nincs "belul"
            i += 1
            continue
        if (q == 1 and ch == "'") or (q == 2 and ch == '"'):
            state[i] = 0            # a zaro jel sincs
            q = 0
            i += 1
            continue
        state[i] = q
        i += 1
    return state


def _blank_ranges(text, ranges):
    """A megadott tartomanyokat szokozre cvereli, a sortoreseket megtartva.
    Az offsetek igy valtozatlanok maradnak, ami a hibakeresest is olvashatova teszi."""
    if not ranges:
        return text
    out = list(text)
    for a, b in ranges:
        for i in range(max(0, a), min(len(out), b)):
            if out[i] != '\n':
                out[i] = ' '
    return ''.join(out)


def _heredoc_opener_runs_body(head):
    """A `<<` ELOTTI resz alapjan: a torzs PROGRAM lesz, vagy egy program BEMENETE?

    A kulonbseg nem az, hogy szerepel-e ertelmezo-nev a soron, hanem az, hogy az
    ertelmezo HONNAN veszi a programjat (79d8b59c):
      bash <<SH            -> nincs megnevezve program, marad a stdin  -> PROGRAM
      bash -s <<SH         -> a -s kifejezetten stdin                  -> PROGRAM
      python3 - <<PY       -> a '-' kifejezetten stdin                 -> PROGRAM
      bash szkript.sh <<EOF-> a program a FAJL, a torzs annak bemenete -> ADAT
      python3 -c "..." <<PY-> a program a -c utani szoveg              -> ADAT
      cat > fajl <<EOF     -> nem is ertelmezo                         -> ADAT

    A regi valtozat azt kerdezte, hogy a soron BARHOL all-e ertelmezo-nev. Ez minden
    `bash <valami>.sh <<EOF` alakra igaz, ezert egy tiltott parancs MEGEMLITESE egy
    uzenet-torzsben ugyanugy blokkolodott, mint a vegrehajtasa. 2026-09-24-en harom
    eles esetben akasztotta meg a csapat sajat dokumentaciojat, egyszer epp ennek a
    hibanak a jelenteset.
    """
    seg = re.split(r'\|\||&&|[;|&]', head)[-1]
    toks = [t for t in re.split(r'\s+', seg.strip()) if t]
    k = 0
    while k < len(toks) and (re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', toks[k])
                             or os.path.basename(toks[k].strip('"\'')) in _TRANSPARENT):
        k += 1
    if k >= len(toks):
        return False
    base = os.path.basename(toks[k].strip('"\''))
    if base not in INTERPRETERS:
        # Ismeretlen burkolo mogott allo ertelmezo (timeout, strace, ...) ugyanugy
        # lefuttatja a torzset. A burkolo argumentum-alakjat nem talalgatjuk: marad
        # a regi, szelesebb olvasat. Igy ez a javitas SZIGORUAN szukebb valtozas --
        # csak a fenti, egyertelmu eset fordul at.
        return any(os.path.basename(t.strip('"\'')) in INTERPRETERS for t in toks[k:])
    for t in toks[k + 1:]:
        if t in ('-', '-s'):
            return True
        if t in SCRIPT_FLAGS:
            return False
        if t.startswith('-'):
            continue
        return False               # egy program-FAJL: a torzs annak a bemenete
    return True


def _heredoc_body_ranges(cmd):
    """(adat-torzsek, ertelmezo-torzsek) karaktertartomanyai.

    A kulonbseg az, hogy a nyito sor parancsa VEGREHAJTJA-e a torzset:
      cat > fajl <<EOF   -> adat      (fajlba megy, semmi nem futtatja)
      python3 - <<PY     -> ertelmezo (a python lefuttatja)
    """
    lines = cmd.split('\n')
    offs, pos = [], 0
    for ln in lines:
        offs.append(pos)
        pos += len(ln) + 1
    data, code = [], []
    i = 0
    while i < len(lines):
        m = re.search(r'<<-?\s*([\'"]?)([A-Za-z_][A-Za-z0-9_]*)\1', lines[i])
        if m:
            delim = m.group(2)
            is_code = _heredoc_opener_runs_body(lines[i][:m.start()])
            j = i + 1
            while j < len(lines) and lines[j].strip() != delim:
                j += 1
            if j > i:
                a = offs[i] + len(lines[i]) + 1
                b = offs[j] if j < len(lines) else len(cmd)
                (code if is_code else data).append((a, b))
            i = j
        i += 1
    return data, code


def _comment_ranges(text):
    """Sorok, amelyek elso nem-szokoz karaktere kettoskereszt. Shellben es beagyazott
    Python/Ruby kodban egyarant komment, tehat sosem hajtodik vegre.
    Sor vegi kommentet SZANDEKOSAN nem vagunk le: ott a jel lehet idezojelben."""
    out, pos = [], 0
    for ln in text.split('\n'):
        if ln.lstrip().startswith('#'):
            out.append((pos, pos + len(ln)))
        pos += len(ln) + 1
    return out


def _prose_quote_ranges(text, keep_ranges, code_ranges=()):
    """Szokozt tartalmazo idezojeles szovegek tartomanyai -- ezek proza vagy adat
    (uzenet-torzs, JSON-payload, regex-minta, teszt-eset), nem utvonal.

    A szokoz NELKULI idezett szoveg utvonal lehet, ezert marad. A `keep_ranges` az
    ertelmezonek atadott szkript-argumentum: annak a tartalma FUT, nem proza.
    """
    state = _quote_map(text)
    out = []
    i = 0
    while i < len(text):
        if state[i]:
            j = i
            while j < len(text) and state[j] == state[i]:
                j += 1
            span = text[i:j]
            inside_keep = any(a <= i < b for a, b in keep_ranges)
            # Parancs-behelyettesites idezojelen belul VEGREHAJTODIK -- a shell ott
            # visszalep parancs-kontextusba. Ezt sosem tekintjuk prozanak, kulonben
            # a mereskor 6 VALODI blokk veszett volna el (PORT="$(sed ... )" alak).
            # Az ertelmezo-heredoc TORZSEBEN a backtick es a $( nem parancs-
            # behelyettesites, hanem sima karakter egy Python/Node szovegben. A
            # kivetel ezert csak shell-kontextusban ervenyes.
            in_code_body = any(a <= i < b for a, b in code_ranges)
            runs_code = (not in_code_body) and ('$(' in span or chr(96) in span)
            if not inside_keep and not runs_code and re.search(r'\s', span):
                out.append((i, j))
            i = j
        else:
            i += 1
    return out


def _script_arg_ranges(text):
    """Az ertelmezonek -c/-e utan atadott idezett szkript tartomanyai: ez FUTO KOD."""
    out = []
    state = _quote_map(text)
    for m in re.finditer(r'(?<![\w-])(python3?|bash|sh|zsh|node|perl|ruby|php)\s+(-\w|--\w+)', text):
        if m.group(2) not in SCRIPT_FLAGS:
            continue
        k = m.end()
        while k < len(text) and text[k] in ' \t':
            k += 1
        if k < len(text) and text[k] in ('"', "'"):
            k += 1
            j = k
            while j < len(text) and state[j]:
                j += 1
            out.append((k, j))
    return out


def scannable(cmd):
    """A parancs azon resze, amely TENYLEG lefut. Lasd a modul-fejlec 1-4. pontjat."""
    data, code = _heredoc_body_ranges(cmd)
    text = _blank_ranges(cmd, data)
    text = _blank_ranges(text, _comment_ranges(text))
    keep = _script_arg_ranges(text)
    text = _blank_ranges(text, _prose_quote_ranges(text, keep, code))
    return text


def segments(text):
    """Logikai szegmensek (&&, ||, ;, |, ujsor, $(, backtick) -- IDEZOJEL-TUDATOSAN.

    A regi valtozat vakon vagott, ezert egy idezett grep-minta belsejeben levo '|'
    uj szegmenst nyitott, es a minta kovetkezo szava parancsnevnek latszott.
    """
    state = _quote_map(text)
    parts, start, i = [], 0, 0
    while i < len(text):
        if state[i]:
            i += 1
            continue
        hit = next((d for d in DELIMS if text.startswith(d, i)), None)
        if hit:
            parts.append(text[start:i])
            i += len(hit)
            start = i
            continue
        i += 1
    parts.append(text[start:])
    return [p.strip() for p in parts if p.strip()]


def _tokens(seg):
    """Idezojel-tudatos szavakra bontas. Elemek: (szoveg idezojel nelkul, volt-e benne
    idezojelen beluli szokoz)."""
    state = _quote_map(seg)
    toks, cur, had_space, i = [], [], False, 0
    while i < len(seg):
        ch = seg[i]
        if not state[i] and ch in ' \t':
            if cur:
                toks.append((''.join(cur), had_space))
                cur, had_space = [], False
            i += 1
            continue
        if not state[i] and ch in ('"', "'"):
            i += 1
            continue
        if state[i] and ch in ' \t':
            had_space = True
        cur.append(ch)
        i += 1
    if cur:
        toks.append((''.join(cur), had_space))
    return toks


# --- Burkolo-parancsok (dec196bb) --------------------------------------------
# A kapu a szegmens ELSO szavat nezi parancsnevnek. Enelkul minden burkolo, amely
# parancsot kap ARGUMENTUMKENT, atvinne mellette a tiltott parancsot:
#     ls /tmp | xargs <tiltott>          find . -exec <tiltott> {} ;
#     timeout 5 <tiltott> /tmp/x         bash -c "<tiltott> ..."
# Mind a tizenegy megmert alak a kapu KORABBI valtozatan is atment: ez nem regresszio
# volt, hanem kezdettol nyitva allo res. 3365 valos parancson megmerve a bovites 0 uj
# blokkot, 0 tort kontrollt es 0 elveszett blokkot hozott -- a koltseg MERT, nem becsult.
#
# A KORLAT, amit ki kell mondani: a beagyazott szkript vizsgalata CSAK EGY SZINTIG hat.
#     bash -c "<tiltott> -rf /tmp/x"              -> BLOKK
#     bash -c "bash -c \"<tiltott> -rf /tmp/x\""  -> ATENGED
# mert a token-kinyeres nem bontja vissza a visszaperjeles idezojel-vedest. Ez tehat a
# VELETLEN ellen ved, nem az elszant megkerules ellen -- ami illik a kapu jellegehez
# (egyuttmukodo agensek kormanyzasa), de ne higgye senki teljesnek.
# Tovabbra sem zarul: "ssh gep <tiltott>" -- az tavoli gepen fut, arra kulon szabaly
# kellene, nem burkolo-felismeres.
# SHELL-KULCSSZAVAK a parancsnev ELOTT. A `if rm -f /x; then ...` szegmens elso
# tokenje az `if`, ami nem tiltott parancsnev -- a kapu ezert a mogotte allo `rm`-et
# SOHA NEM NEZTE MEG. 2026-09-24-en merve az ELES kapun: `rm -f /tmp/x` -> exit 2,
# `if rm -f /tmp/x; then echo ok; fi` -> exit 0. A res azert sulyos, mert a hazi
# stilus (CLAUDE.md: "Minden ellenorzes if ... then ... else ... fi formaban") EPP
# ezt az alakot irja elo, tehat a leggyakoribb alak volt a vak folt.
# Az `if`/`while`/`!`/`{` elotag, a `fi`/`done`/`}` lezaro -- mindegyiket atlepjuk:
# a lezarok utan vagy nincs semmi, vagy a kovetkezo parancs all, es azt nezni kell.
_KEYWORDS = ('if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done',
             'case', 'esac', 'in', 'select', 'function', 'coproc',
             '!', '{', '}', '(', ')', '[[', ']]')
_TRANSPARENT = ('exec', 'command', 'time', 'nohup', 'env')
_PREFIX_WRAPPERS = ('xargs', 'timeout', 'nice', 'ionice', 'stdbuf', 'watch', 'parallel',
                    'flock', 'chroot', 'setsid', 'unbuffer')
_FIND_EXEC = ('-exec', '-execdir', '-ok', '-okdir')
_SHELLS = ('sh', 'bash', 'zsh', 'dash', 'ksh')
# A kapcsolok, amelyek KULON szoban hozzak az ertekuket (xargs -I {} / -n 1 / -P 4).
_VALUE_FLAGS = ('-I', '-i', '-n', '-P', '-L', '-s', '-d', '-E', '-a',
                '--max-args', '--max-procs', '--delimiter', '--replace', '--arg-file')
_NUMERIC = re.compile(r'^[0-9]+(\.[0-9]+)?[smhd]?$')
# Explicit melysegkorlat a hurokvedelem (sub != cmd) MELLE. A mert maximalis melyseg 3;
# a korlat nem a mai viselkedes miatt kell, hanem hogy egy jovobeli valtoztatas se
# tudjon vegtelen rekurzioba futni. Tullepese BLOKK, nem atengedes: egy ennyire agyazott
# parancsot a kapu nem tud vegigkovetni, es amit nem lat at, azt nem engedi.
_MAX_NEST = 8


def _bare_tokens(seg):
    return [(t, sp) for t, sp in _tokens(seg.replace('(', ' ')) if t]


def _after_wrapper(toks, i):
    """A burkolo utani elso parancsnev-jelolt indexe (kapcsolokat es szamot atlepve)."""
    j = i + 1
    while j < len(toks):
        t = toks[j][0]
        if t.startswith('-'):
            j += 2 if t in _VALUE_FLAGS else 1
            continue
        if _NUMERIC.match(t):        # timeout 5 CMD, nice 10 CMD
            j += 1
            continue
        return j
    return None


def command_index(toks):
    """A szegmens TENYLEGES parancsnevenek indexe, a burkolokon atlatva.

    A kornyezeti hozzarendelesek (FOO=bar), az atlatszo elotagok (exec, env, ...) es a
    burkolok (xargs, timeout, ...) atlepesre kerulnek. None, ha nincs parancsnev.
    """
    i = 0
    for _ in range(12):             # a lanc hossza korlatos: nem hurkolunk vegtelenul
        while i < len(toks) and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', toks[i][0]):
            i += 1
        if i >= len(toks):
            return None
        base = os.path.basename(toks[i][0])
        if toks[i][0] in _KEYWORDS and not toks[i][1]:
            i += 1
            continue
        if base in _TRANSPARENT:
            i += 1
            continue
        if base in _PREFIX_WRAPPERS:
            nxt = _after_wrapper(toks, i)
            if nxt is None:
                return None
            i = nxt
            continue
        return i
    return None


def _sub_scripts(toks, idx):
    """A szegmens shell-parancsanak -c kapcsoloval atadott szkriptje(i)."""
    if idx is None or os.path.basename(toks[idx][0]) not in _SHELLS:
        return []
    for k in range(idx + 1, len(toks)):
        if toks[k][0] in ('-c', '--command') and k + 1 < len(toks):
            return [toks[k + 1][0]]
    return []


def _under(path, root):
    """True, ha a (mar abszolut) path a root ALATT van. A root maga NEM szamit bele."""
    root = os.path.normpath(root)
    path = os.path.normpath(path)
    return path.startswith(root + os.sep)


def _resolve(arg, cwd):
    """A torlendo argumentum abszolut alakja, vagy None ha nem eldontheto.

    Symlinkre SZANDEKOSAN nem oldunk fel: az `rm link` magat a linket torli, tehat a
    cel helye nem szamit. A szulokonyvtar viszont szamit, ezert azt feloldjuk -- egy
    munkakonyvtarba mutato symlink-konyvtaron keresztul kulonben kifele lehetne torolni.
    """
    if not arg or any(c in arg for c in RM_UNRESOLVABLE):
        return None
    arg = os.path.expanduser(arg)
    if not os.path.isabs(arg):
        if cwd is None:
            return None
        arg = os.path.join(cwd, arg)
    arg = os.path.normpath(arg)
    parent, base = os.path.split(arg)
    try:
        parent = os.path.realpath(parent)
    except OSError:
        return None
    return os.path.normpath(os.path.join(parent, base))


def _rm_allowed(toks, argstart, cwd):
    """(engedett?, indoklas) -- a torles minden celpontja a munkakonyvtar alatt van-e.

    Alapertelmezesben ENGEDETT a PROJECT_ROOT alatti torles (PR #1357). A korabbi,
    feltetel nelkuli tiltas nem kockazatot csokkentett, hanem atfogalmazast tanitott:
    a sajat munkajat takarito agens megkerulesi alakokat keresett. Amit a kapu tovabbra
    sem enged at, az a ROOT-on KIVULRE mutato torles es minden alak, amirol nem tudja
    eldonteni, hova mutat -- ez utobbi nem szigor, hanem a kapu egyetlen tisztesseges
    valasza arra, amit nem lat at.
    """
    paths, skip = [], 0
    for tok, quoted_space in toks[argstart:]:
        if skip:
            skip -= 1
            continue
        if quoted_space:              # szokozos idezett szoveg: nem utvonal (lasd ba856d56)
            return False, 'idezett, szokozt tartalmazo argumentum'
        if tok == '--':
            continue
        if tok.startswith('-') and tok != '-':
            continue
        paths.append(tok)
    if not paths:
        return False, 'nem latszik, MIT torolne (pl. csovezetekbol vagy -exec {}-bol jon a lista)'
    for raw in paths:
        abspath = _resolve(raw, cwd)
        if abspath is None:
            return False, 'nem eldontheto utvonal: %s' % raw[:60]
        if not _under(abspath, PROJECT_ROOT):
            return False, 'a munkakonyvtaron KIVULRE mutat: %s' % abspath
        rel = os.path.relpath(abspath, PROJECT_ROOT).split(os.sep)
        if rel and rel[0] in RM_PROTECTED:
            return False, 'vedett alkonyvtar a munkakonyvtaron belul: %s' % rel[0]
    return True, ''


def _cd_target(toks, argstart, cwd):
    """A `cd` uj munkakonyvtara, vagy None ha nem kovetheto.

    Miert kell: a szegmensekre bontas utan a `cd /etc && rm foo` masodik fele ugy nezne
    ki, mintha az agens sajat konyvtaraban torolne. Ez nem elmeleti -- ez AZ eset,
    amiert a munkakonyvtar-alapu engedely kulonben egy sorban megkerulheto lenne.
    """
    args = [t for t, _sp in toks[argstart:] if not t.startswith('-')]
    if not args:
        return HOME                  # a puszta `cd` a HOME-ba visz
    tgt = _resolve(args[0], cwd)
    return tgt


def _git_push_index(toks, argstart):
    """A 'push' alparancs indexe, a git sajat kapcsoloin (-C ut, -c kulcs=ertek) atlepve."""
    i = argstart
    while i < len(toks):
        t = toks[i][0]
        if t in ('-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'):
            i += 2
            continue
        if t.startswith('-'):
            i += 1
            continue
        return i if t == 'push' else None
    return None


def _check_git(toks, argstart):
    """git push: nem tiltott onmagaban (PR #1357), de harom alakja igen.

    Amit a kapu MEGTART: a tortenet ujrairasat (--force es tarsai, '+' refspec), a
    tavoli ref torleset, es a vedett agakra (main/master) iranyulo push-t. Ezek
    kifele mutatnak es mas munkajat is elvihetik -- ezt nem egy agens donti el.
    Amit ELENGED: a sajat munkaag push-a, ami eddig is a munka resze volt, csak
    jovahagyason keresztul.
    """
    pi = _git_push_index(toks, argstart)
    if pi is None:
        return
    args, skip = [], 0
    for tok, _sp in toks[pi + 1:]:
        if skip:
            skip -= 1
            continue
        if tok in PUSH_VALUE_FLAGS:
            skip = 1
            continue
        args.append(tok)
    flags = [a for a in args if a.startswith('-')]
    positional = [a for a in args if not a.startswith('-')]

    for f in flags:
        base = f.split('=', 1)[0]
        if base in PUSH_FORCE_FLAGS:
            block('git push %s: a tavoli tortenet ujrairasa mas munkajat is elviheti. '
                  'Sima push szabad, eroltetett nem.' % base)
        if base in PUSH_DELETE_FLAGS:
            block('git push %s: tavoli ag torlese. A torles nem az agens dontese.' % base)
        if base == '--all':
            block('git push --all: minden agat kitolja, a vedetteket is. '
                  'Nevezd meg, melyik agra pusholsz.')

    refspecs = positional[1:]          # az elso pozicionalis a remote (vagy URL)
    if not refspecs:
        block('git push cel-ag nelkul: a kapu nem tudja eldonteni, melyik agra menne '
              '(az upstream nem latszik a parancsbol). Nevezd meg: '
              'git push <remote> HEAD:<ag>.')
    for spec in refspecs:
        # Az ures forras-refspec (`:ag`) ugyanaz a muvelet, mint a --delete: torli a
        # tavoli agat. 2026-09-24-en merve, a szabaly atvitelekor: a kapcsolos alakot
        # tiltotta, a ketpontosat atengedte. Ugyanaz a dontes, ugyanaz a verdikt.
        if spec.startswith(':') or spec.startswith('+:'):
            block('git push %s: ures forras-refspec, azaz tavoli ag torlese. '
                  'A torles nem az agens dontese.' % spec[:40])
        if spec.startswith('+'):
            block('git push +%s: a "+" eloterjesztes eroltetett push. '
                  'Eroltetett push nem az agens dontese.' % spec[1:][:40])
        dest = spec.split(':', 1)[1] if ':' in spec else spec
        if dest.rsplit('/', 1)[-1] in PROTECTED_BRANCHES and not dest.startswith('refs/tags/'):
            block('git push a(z) "%s" agra: vedett ag, ide review-n keresztul megy '
                  'valami. Pusholj sajat munkaagra.' % dest)


# --- Az ERTELMEZO-PAYLOAD belseje (efccadab) ---------------------------------
# Istvan jovahagyta 2026-09-21 04:01, a lean-chief eloterjesztesere. A kapu eddig a
# PARANCSNEVET es az UTVONAL-MINTAT nezte; ha ugyanaz a torles egy `python3 -c`
# egysoron vagy egy `python3 - <<PY` torzsben allt, a kapu nem latott bele. A modul
# fejlece ezt 2026-09-20 ota ISMERT es NYITOTT resként nevezi meg -- ez a szakasz
# zarja be.
#
# A SCOPE-OT A LEAN CHIEF SZABTA MEG, es szandekosan szuk: "ne vezess be uj
# tiltasokat azon tul, amit a kapu ma is tilt. A cel ugyanaz a szabalykeszlet, csak
# az interpreter-burok mogott is." Ezert a tabla minden sora egy MA IS TILTOTT
# parancs megfeleloje, es a sor ki is mondja, MELYIKE:
#     os.remove / shutil.rmtree / fs.unlinkSync / File.delete ...  ->  rm
#     os.rename / shutil.move  / fs.renameSync  / FileUtils.mv ...  ->  mv
# Ami ma NEM tiltott, az itt sem lesz az. Kifejezetten KIMARAD, noha a 2026-09-20-as
# probaban atment es kezenfekvo volna felvenni:
#     open(f,'w')      csonkitas -- a `: > fajl` alak ma is atmegy, tehat nem szabaly
#     sqlite3 DELETE   DB-tartalom -- a kapu sosem nezett SQL-t
#     urllib POST      kifele iranyulo forgalom -- az az egress-deny dolga, mas kapu
#     .ssh ut darabolt osszefuzessel -- obfuszkacio, kulon dontes kell hozza
# Ez nem feledekenyseg: mindegyik UJ tiltas volna, es a kartya kifejezetten tiltja.
#
# A shell-kihivast (os.system, subprocess, child_process, Ruby backtick...) NEM kulon
# szabalylistaval kezeljuk, hanem VISSZAVEZETJUK a check_bash-re. Igy a burkon beluli
# parancsra pontosan ugyanaz a szabalykeszlet all, es nem keletkezik egy masodik,
# lassan elkulonbozo lista. Ez a kartya kovetelmenyenek szo szerinti alakja.
_PAYLOAD_RULES = (
    # (minta, a ma is tiltott parancs, amelynek ez a megfeleloje)
    (r'\bos\.(remove|unlink|rmdir|removedirs)\s*\(',            'rm'),
    (r'\bshutil\.rmtree\s*\(',                                  'rm'),
    (r'\bos\.(rename|renames|replace)\s*\(',                    'mv'),
    (r'\bshutil\.(move|copyfile)\s*\(',                         'mv'),
    (r'\.unlink\s*\(',                                          'rm'),   # pathlib.Path
    (r'\bPath\([^)]*\)\.(rmdir|rename|replace)\s*\(',           'mv'),
    # Node. A `Sync` vegu nevek maguktol is egyertelmuek, ezert NEM kerul ele
    # pont-tilto elonezet: a leggyakoribb alak `require('fs').rmSync(...)`, ahol a
    # nevet epp egy pont elozi meg. Merve: pont-tiltassal mind a harom node-alak
    # atment a kapun. A pont NELKULI nevek (`rm`, `unlink`, `rename`) tul altalanosak,
    # azok tovabbra is megnevezett fs-objektumot vagy require-t kernek.
    (r'(?<![\w$])(?:rmSync|unlinkSync|rmdirSync)\s*\(',          'rm'),
    (r'(?<![\w$])renameSync\s*\(',                               'mv'),
    (r'\b(?:fs|fsp|fsPromises)\.(?:promises\.)?(?:rm|unlink|rmdir)\s*\(', 'rm'),
    (r'\b(?:fs|fsp|fsPromises)\.(?:promises\.)?rename\s*\(',    'mv'),
    (r'require\(\s*[\'"]fs(?:/promises)?[\'"]\s*\)\s*\.\s*(?:rm|unlink|rmdir)\s*\(', 'rm'),
    (r'require\(\s*[\'"]fs(?:/promises)?[\'"]\s*\)\s*\.\s*rename\s*\(', 'mv'),
    (r'\bFile(?:Utils)?\.(delete|unlink|rm|rm_r|rm_rf|remove_entry|remove_entry_secure)\b', 'rm'),
    (r'\bDir\.(delete|rmdir|unlink)\b',                         'rm'),
    (r'\bFile(?:Utils)?\.(rename|mv|move)\b',                   'mv'),
    (r'\b(rmtree|remove_tree)\s*\(',                            'rm'),   # Perl File::Path
    (r'(?<![\w.])unlink\s*\(',                                  'rm'),   # Perl builtin
    (r'(?<![\w.])rename\s*\(',                                  'mv'),   # Perl builtin
)
_PAYLOAD_RE = tuple((re.compile(p), c) for p, c in _PAYLOAD_RULES)

# Ahonnan a payload SHELLT hiv. A zarojeles argumentumbol kiszedjuk a
# karakterlanc-literalokat, szokozzel osszefuzzuk, es visszaadjuk a check_bash-nek.
# A lista-alak (`subprocess.run(['rm','-rf',p])`) igy "rm -rf" lesz -- a parancsnev
# az ELSO szo marad, tehat a meglevo felismeres valtozatlanul all ra.
_SHELLOUT_RE = re.compile(
    # Ket elonezet-osztaly, szandekosan kulon. A megkulonboztetheto nevek (`execSync`,
    # `spawnSync`, `execFileSync`) elott allhat pont -- `require('child_process').execSync`
    # a leggyakoribb node-alak, es a pont-tilto elonezet EPP ezt engedte at (merve).
    # A puszta `system`, `exec`, `qx` viszont tul altalanos: azok elott a pont-tiltas marad,
    # kulonben minden `foo.exec(` talalat lenne.
    r'(?:(?<![\w$])(?:execSync|spawnSync|execFileSync)|'
    r'require\(\s*[\'"]child_process[\'"]\s*\)\s*\.\s*'
    r'(?:exec|execFile|spawn|execSync|execFileSync|spawnSync)|'
    r'(?<![\w.])(?:os\.system|os\.popen|os\.exec[lv]?[pe]*|subprocess\.(?:run|call|'
    r'check_call|check_output|Popen|getoutput)|child_process\.(?:exec|execSync|'
    r'execFile|execFileSync|spawn|spawnSync)|IO\.popen|'
    r'Open3\.(?:capture2|capture3|popen3)|system|exec|qx))\s*\(')
_STR_LIT_RE = re.compile(r"(['\"])((?:\\.|(?!\1).)*)\1")


def _balanced_arg(text, open_idx):
    """A nyito zarojeltol a hozza tartozo zarojelig terjedo szoveg. Ha nincs parja
    (csonka payload), a szoveg vegeig -- egy le nem zart hivast nem engedunk at
    csak azert, mert elgepeltek."""
    depth, i = 0, open_idx
    while i < len(text):
        if text[i] == '(':
            depth += 1
        elif text[i] == ')':
            depth -= 1
            if depth == 0:
                return text[open_idx + 1:i]
        i += 1
    return text[open_idx + 1:]


def interpreter_payloads(cmd):
    """Minden szovegdarab, amit egy ERTELMEZO fog vegrehajtani.

    Harom forras, mind a harom a kartyan nevesitve:
      1. `-c` / `-e` / `-E` / `-p` utani idezett szkript,
      2. az ertelmezonek adott heredoc TORZSE (`python3 - <<PY`), amit a
         _heredoc_body_ranges mar ma is megkulonboztet az adat-heredoctol,
      3. a `-` STDIN-alak csovon at (`echo "..." | python3 -`): ilyenkor az ELOZO
         csoszakasz idezett szovegei a kod. A prozaszures kulonben pont ezeket
         mosna ki, mert szokozt tartalmaznak.
    A kommentsorok es az ADAT-heredocok itt is ki vannak fehérítve, mielott
    barmit kinyernenk: egy kikommentezett sor a payloadon belul sem fut le.
    """
    data, code = _heredoc_body_ranges(cmd)
    text = _blank_ranges(cmd, data)
    text = _blank_ranges(text, _comment_ranges(text))
    out = [text[a:b] for a, b in code]
    out += [text[a:b] for a, b in _script_arg_ranges(text)]
    out += [text[a:b] for a, b in _stdin_pipe_ranges(text)]
    return [p for p in out if p.strip()]


def _stdin_pipe_ranges(text):
    """`echo "<kod>" | python3 -` -- az ertelmezo a STDIN-rol olvas.

    Csak akkor ad vissza tartomanyt, ha a cso EGYIK szakaszanak parancsa ertelmezo
    ES a szakaszban ott all a puszta `-`. Enelkul minden idezett szoveget kodnak
    kellene tekinteni, ami a prozaszures ellentetje volna.
    """
    state = _quote_map(text)
    bars = [i for i in range(len(text)) if not state[i] and text[i] == '|'
            and not text.startswith('||', i) and not (i and text[i - 1] == '|')]
    if not bars:
        return []
    bounds = [0] + [b + 1 for b in bars] + [len(text)]
    parts = [(bounds[k], bounds[k + 1] - (1 if k + 1 <= len(bars) else 0))
             for k in range(len(bounds) - 1)]
    out = []
    for k, (a, b) in enumerate(parts):
        toks = [t for t, _sp in _tokens(text[a:b])]
        if not toks or k == 0:
            continue
        if os.path.basename(toks[0]) in INTERPRETERS and '-' in toks[1:]:
            pa, pb = parts[k - 1]
            prev_state = _quote_map(text[pa:pb])
            i = 0
            while i < pb - pa:
                if prev_state[i]:
                    j = i
                    while j < pb - pa and prev_state[j] == prev_state[i]:
                        j += 1
                    out.append((pa + i, pa + j))
                    i = j
                else:
                    i += 1
    return out


def check_payload(payload, _depth=0, cwd=None):
    """A ma is tiltott muveletek az ertelmezo-burkon BELUL."""
    for rx, equivalent in _PAYLOAD_RE:
        m = rx.search(payload)
        if m:
            block('Ertelmezo-payloadban allo, visszafordithatatlan muvelet: "%s" -- ez a '
                  '"%s" megfeleloje, amit a kapu a shellben is tilt. A burok nem valtoztat '
                  'a dontesen.\n(a payload reszlete: %s)'
                  % (m.group(0).strip(), equivalent, payload[:160]))
    for m in _SHELLOUT_RE.finditer(payload):
        arg = _balanced_arg(payload, payload.index('(', m.end() - 1))
        words = [g2 for _g1, g2 in _STR_LIT_RE.findall(arg)]
        if not words:
            continue
        inner = ' '.join(words).strip()
        if not inner or _depth >= _MAX_NEST:
            continue
        # Ugyanaz a szabalykeszlet, nem egy masodik lista: a kihivott parancs
        # visszamegy a check_bash-be.
        check_bash(inner, _depth + 1, cwd)


def check_bash(cmd, _depth=0, cwd=None):
    text = scannable(cmd)
    # A munkakonyvtar szegmensrol szegmensre valtozhat (`cd X && rm y`), ezert
    # vegigvisszuk. Ismeretlen (None) cwd eseten a relativ utak nem eldonthetok, es a
    # nem eldonthetot a kapu nem engedi at.
    if cwd is not None:
        cwd = os.path.normpath(os.path.expanduser(cwd))
    entry_cwd, saw_cd = cwd, False
    for seg in segments(text):
        toks = _bare_tokens(seg)
        idx = command_index(toks)

        # A vizsgalando parancsnevek: a szegmens sajat parancsa, plusz a find -exec
        # utan allo parancs (az nem a szegmens elejen all, ezert kulon). Az argumentumok
        # kezdoindexe is kell, mert a feltetelesen engedett parancsok (rm, git) esetén
        # nem a nev, hanem az ARGUMENTUMOK dontik el a verdiktet.
        names = []
        # Az idezojelen belul SZOKOZT tartalmazo szo nem parancsnev, hanem karakterlanc
        # (teszteset-lista, uzenet-szoveg, regex-minta) -- lasd ba856d56.
        if idx is not None and not toks[idx][1]:
            names.append((toks[idx][0], idx + 1))
        for j, (t, _sp) in enumerate(toks):
            if t in _FIND_EXEC and j + 1 < len(toks) and not toks[j + 1][1]:
                names.append((toks[j + 1][0], j + 2))

        for name, argstart in names:
            base = os.path.basename(name)
            if base == 'git':
                _check_git(toks, argstart)
                continue
            if base == 'rm':
                ok, why = _rm_allowed(toks, argstart, cwd)
                if not ok:
                    block('Torles, amit a kapu nem engedhet at: %s.\n'
                          'A munkakonyvtar (%s) ALATTI torles alapbol szabad; ezen kivul, '
                          'illetve a .git es a store/ alatt nem.\n'
                          '(a teljes szegmens: %s)' % (why, PROJECT_ROOT, seg[:160]))
                continue
            if base in BANNED_CMDS:
                block('A tiltott parancs: "%s" (a teljes szegmens: %s)' % (base, seg[:160]))

        # A `cd` a KOVETKEZO szegmensek munkakonyvtarat allitja. Nem eldontheto cel
        # eseten a cwd ismeretlenne valik, ami a kesobbi relativ torleseket blokkolja.
        if idx is not None and not toks[idx][1] and os.path.basename(toks[idx][0]) == 'cd':
            cwd = _cd_target(toks, idx + 1, cwd)
            saw_cd = True

        for sub in _sub_scripts(toks, idx):
            if not sub or sub == cmd:
                continue
            if _depth >= _MAX_NEST:
                block('Tul melyen agyazott parancs (%d szint): a kapu nem tudja '
                      'vegigkovetni, ezert nem engedi at.' % _depth)
            check_bash(sub, _depth + 1, cwd)

    # Az ertelmezo-burkon beluli payload (efccadab). A szegmens-ciklus UTAN fut,
    # mert nem a parancsnevrol szol: a burok parancsneve legitim (python3), a
    # payload tartalma nem. A payload a TELJES parancsbol jon, nem egy szegmensbol,
    # ezert ha barhol allt benne `cd`, a munkakonyvtar nem eldontheto -- None.
    for payload in interpreter_payloads(cmd):
        check_payload(payload, _depth, None if saw_cd else entry_cwd)

    # Hitelesito fajlok kiolvasasa barmilyen parancson keresztul.
    m = PROTECTED_RE.search(text)
    if m:
        block('Hitelesito adatokat tartalmazo konyvtar: .%s' % m.group(1))
    if ENV_RE.search(text):
        block('.env fajl: hitelesito adatokat tartalmaz.')


def check_read(path):
    m = PROTECTED_RE.search(path if path.endswith('/') else path + '/')
    if m:
        block('Hitelesito adatokat tartalmazo konyvtar: .%s' % m.group(1))
    if os.path.basename(path) == '.env':
        block('.env fajl: hitelesito adatokat tartalmaz.')


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
    except Exception:
        # A tobbi governance-kapu is fail-closed ebben a repoban: ha a kapu nem tudja
        # elolvasni, mit engedelyezne, akkor nem engedelyez.
        sys.stderr.write('DESTRUKTIV-KAPU: a bemenet nem olvashato, ezert BLOKKOL.\n')
        sys.exit(2)
    tool = ev.get('tool_name') or ''
    inp = ev.get('tool_input') or {}
    # FAIL-CLOSED a kapu SAJAT hibajara is. A block() SystemExit-tel lep ki, azt a
    # BaseException-kent az "except Exception" nem fogja meg, tehat a valodi blokkolas
    # atmegy. Minden mas kivetel (rekurzio, regex, elgepeles egy kesobbi javitasban)
    # eddig NEM 2-es kilepessel vegzodott volna, vagyis a muvelet ATMENT volna: egy
    # elhasalt kapu csendben engedelyezove valik. Ez az egyetlen hibamod, amit egy
    # kapunal nem szabad megengedni.
    try:
        if tool == 'Bash':
            # A PreToolUse esemeny cwd-je a relativ utak feloldasahoz kell. Ha
            # hianyzik vagy nem a telepites alatt van, NEM helyettesitjuk a gyokerrel:
            # akkor a relativ torlesek egyszeruen nem eldonthetok, es blokkolodnak.
            ev_cwd = ev.get('cwd')
            if not (isinstance(ev_cwd, str) and ev_cwd.strip()):
                ev_cwd = None
            check_bash(str(inp.get('command') or ''), cwd=ev_cwd)
        elif tool in ('Read', 'Edit', 'Write', 'NotebookEdit'):
            check_read(str(inp.get('file_path') or ''))
    except Exception as exc:
        sys.stderr.write('DESTRUKTIV-KAPU: a kapu maga hibara futott (%s: %s), ezert '
                         'BLOKKOL. Ez a kapu hibaja, nem a tied -- szolj a leandev-nek.\n'
                         % (type(exc).__name__, exc))
        sys.exit(2)
    sys.exit(0)


if __name__ == '__main__':
    main()
