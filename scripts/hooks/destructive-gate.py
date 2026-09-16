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
SCRIPT_FLAGS = {'-c', '-e', '--command', '--eval'}

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
            words = [w for w in re.split(r'[\s|;&]+', lines[i]) if w]
            is_code = any(os.path.basename(w.strip('"\'')) in INTERPRETERS for w in words)
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


def check_bash(cmd, _depth=0):
    text = scannable(cmd)
    for seg in segments(text):
        toks = _bare_tokens(seg)
        idx = command_index(toks)

        # A vizsgalando parancsnevek: a szegmens sajat parancsa, plusz a find -exec
        # utan allo parancs (az nem a szegmens elejen all, ezert kulon).
        names = []
        # Az idezojelen belul SZOKOZT tartalmazo szo nem parancsnev, hanem karakterlanc
        # (teszteset-lista, uzenet-szoveg, regex-minta) -- lasd ba856d56.
        if idx is not None and not toks[idx][1]:
            nxt = toks[idx + 1][0] if idx + 1 < len(toks) and not toks[idx + 1][1] else None
            names.append((toks[idx][0], nxt))
        for j, (t, _sp) in enumerate(toks):
            if t in _FIND_EXEC and j + 1 < len(toks) and not toks[j + 1][1]:
                names.append((toks[j + 1][0], None))

        for name, second in names:
            base = os.path.basename(name)
            if base in BANNED_CMDS:
                block('A tiltott parancs: "%s" (a teljes szegmens: %s)' % (base, seg[:160]))
            if base == 'git' and second == 'push':
                block('git push: a kozos repoba valo iras kifele mutato, visszafordithatatlan '
                      'muvelet. Commitolni szabad, pusholni nem.')

        for sub in _sub_scripts(toks, idx):
            if not sub or sub == cmd:
                continue
            if _depth >= _MAX_NEST:
                block('Tul melyen agyazott parancs (%d szint): a kapu nem tudja '
                      'vegigkovetni, ezert nem engedi at.' % _depth)
            check_bash(sub, _depth + 1)

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
            check_bash(str(inp.get('command') or ''))
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
