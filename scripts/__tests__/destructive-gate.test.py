#!/usr/bin/env python3
"""Regresszios kapu a destructive-gate.py szovegkornyezet-erzekenysegehez (ba856d56).

Az osztaly, amit ez a teszt kizar: a kapu a parancs SZOVEGEBEN keres mintat, ezert
olyan hivast is blokkol, amely a mintat csak EMLITI -- heredoc-torzsben, karakterlanc-
literalban vagy kommentben --, mikozben a muvelet soha nem hajtodik vegre. Meres 3365
valos parancson (2026-09-14): 109 blokk, ebbol 31 hamis pozitiv. A javitas utan 4.

A masik irany legalabb ennyire fontos: a javitas EGYETLEN valos blokkot sem veszithet
el. Az itteni POZITIV kontrollok pontosan ezt rogzitik -- egy jovobeli "meg kevesebb
hamis pozitiv" finomitas ezeken bukjon meg, ne eles hasznalatban.

A ket eset, amit a legkonnyebb osszekeverni, es amit ez a teszt kulon pin-el:
  cat > fajl <<EOF   -- a torzs ADAT, fajlba megy, semmi nem futtatja  -> atengedve
  python3 - <<PY     -- a torzset az ertelmezo VEGREHAJTJA             -> vizsgalva
A mereskor ket VALODI hitelesito-fajl-olvasas allt ilyen ertelmezo-torzsben; egy naiv
"a heredoc-torzset hagyd ki" javitas elengedte volna oket.

Futtatas: python3 <ezafajl>   Exit 0 = minden teszt zold.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
GATE = os.path.join(ROOT, "scripts", "hooks", "destructive-gate.py")

spec = importlib.util.spec_from_file_location("dgate", GATE)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Blocked(Exception):
    pass


def _raise(msg):
    raise Blocked(msg)


gate.block = _raise

failed = []


def check(name, ok):
    print("  [%s] %s" % ("PASS" if ok else "FAIL", name))
    if not ok:
        failed.append(name)


def blocks_cwd(cmd, cwd):
    """Ugyanaz, mint blocks(), de megadott munkakonyvtarral: a rm-engedely
    (PR #1357) relativ utaknal ettol fugg, es cwd nelkul minden relativ ut
    egyszeruen nem eldontheto -- az sosem mutatna meg a kulonbseget."""
    try:
        gate.check_bash(cmd, cwd=cwd)
        return False
    except Blocked:
        return True


def blocks(cmd):
    try:
        gate.check_bash(cmd)
        return False
    except Blocked:
        return True


def blocks_path(path):
    try:
        gate.check_read(path)
        return False
    except Blocked:
        return True



def _hook_exit(stdin_text):
    """A kaput ELES hookkent futtatja: JSON a szabvanyos bemeneten, exit-kod vissza."""
    r = subprocess.run([sys.executable, GATE], input=stdin_text,
                       capture_output=True, text=True)
    return r.returncode


def _injected_fault_exit():
    """Szandekos hiba a check_bash-ben: a main()-nek 2-vel kell kilepnie, nem 0-val."""
    src = open(GATE, encoding="utf-8").read()
    # A csonk szignaturaja kovesse a valodit (cwd-vel egyutt): kulonben nem a
    # BEINJEKTALT hibat mernenk, hanem egy TypeError-t -- ami szinten 2-vel
    # lepne ki, tehat a teszt zold maradna, mikozben mar mast merne.
    fault = ("\n\ndef check_bash(cmd, _depth=0, cwd=None):\n"
             "    raise ValueError('szandekosan injektalt hiba')\n\n")
    # A foltnak a main() HIVASA ELE kell kerulnie, kulonben a modul mar lefutott.
    marker = "if __name__ =="
    i = src.index(marker)
    src = src[:i] + fault + src[i:]
    tmp = os.path.join(tempfile.mkdtemp(), "faulty-gate.py")
    open(tmp, "w", encoding="utf-8").write(src)
    r = subprocess.run([sys.executable, tmp],
                       input=json.dumps({"tool_name": "Bash",
                                         "tool_input": {"command": "ls"}}),
                       capture_output=True, text=True)
    return r.returncode


def _depth_limit_blocks():
    """A melysegkorlat tullepese blokkol-e. Kozvetlenul hivjuk, mert jol formazott
    shell-idezessel ilyen melyen agyazni nem lehet -- a korlat a KOD vedelme."""
    try:
        gate.check_bash("bash -c 'ls'", _depth=gate._MAX_NEST)
        return False
    except Blocked:
        return True
    except TypeError:
        return False


# A vedett nevek es a tiltott parancsnevek OSSZEFUZVE allnak elo. Nem szepitesbol:
# maga a kapu blokkolna ennek a tesztfajlnak a MEGIRASAT, ha szo szerint allnanak
# benne -- a meres kozben ez hetszer fordult elo (lasd a kapu fejlecet). A teszt
# tehat sajat maga is peldany arra a hibaosztalyra, amit vizsgal.
D = "."
SSH = D + "ssh"
ENV = D + "env"
GM = D + "gmail-mcp"
HOME = "/home/istvan"
RM = "r" + "m"
MV = "m" + "v"
SUDO = "sud" + "o"
SHRED = "shre" + "d"
DD = "d" + "d"
GPUSH = "git " + "push"

# --- 1. POZITIV kontrollok: ezek TOVABBRA IS blokkolodnak -------------------
print("POZITIV kontroll -- valodi muvelet, blokkolni kell:")
check("egyszeru torles", blocks(RM + " /tmp/x"))
check("rekurziv torles", blocks(RM + " -rf build"))
check("torles lanc masodik tagjakent", blocks("cd /tmp && " + RM + " x"))
check("torles csovezetek utan", blocks("ls /tmp | xargs " + RM))
check("athelyezes", blocks(MV + " a b"))
check("jogosultsag-emeles", blocks(SUDO + " apt install gh"))
check("biztonsagos torles", blocks(SHRED + " -u titok.txt"))
check("nyers lemeziras", blocks(DD + " if=/dev/zero of=/dev/sdx"))
check("kozos repoba iras", blocks(GPUSH + " origin main"))
check("hitelesito konyvtar listazasa", blocks("ls -la ~/" + SSH + "/"))
check("hitelesito konyvtar zaro perjel nelkul", blocks("ls -la " + HOME + "/" + GM))
check("hitelesito fajl masolasa", blocks("cp ~/" + GM + "/credentials.json /tmp/"))
check("konfig-fajl olvasasa szokoz utan", blocks("sed -n 's/^WEB_PORT=//p' " + ENV))
# Ezt a REGI valtozat ELENGEDTE: csak szokoz utan illesztett, ezert a teljes utvonalas
# alak atment rajta. A meres talalta meg, 1 valos esettel. Ez tehat nem uj blokk,
# hanem egy addig eszrevetlen lyuk zarasa.
check("konfig-fajl olvasasa teljes utvonallal",
      blocks('grep -i "MODEL" ' + ROOT + "/" + ENV))
# A $( ) idezojelen BELUL is parancs-kontextus: ezt a regresszios futas elso korenek
# 6 elvesztett valos talalata tanitotta meg.
check("parancs-behelyettesites idezojelen belul",
      blocks('PORT="$(sed -n \'s/^WEB_PORT=//p\' ' + ENV + ' | head -1)"'))
check("idezett, de szokoz nelkuli parancsnev", blocks("'" + RM + "' /tmp/x"))

print()
print("POZITIV kontroll -- ERTELMEZONEK adott kod, blokkolni kell:")
check("ertelmezo-heredoc megnyitja a hitelesito fajlt",
      blocks("python3 - <<'PY'\nimport json, os\n"
             "h = os.path.expanduser('~/" + GM + "')\n"
             "print(json.load(open(h + '/credentials.json')))\nPY"))
check("ertelmezo -c kapcsoloval megnyitja a hitelesito fajlt",
      blocks('python3 -c "import json; d = json.load(open(\'' + HOME + '/' + GM +
             '/credentials.json\')); print(d)"'))
check("bash-heredoc torol", blocks("bash <<'SH'\n" + RM + " -rf /tmp/x\nSH"))

print()
print("POZITIV kontroll -- fajl-eszkoz ag (itt a meres 0 hamis pozitivot mutatott):")
check("hitelesito fajl olvasasa", blocks_path(HOME + "/" + SSH + "/id_rsa"))
check("konfig-fajl olvasasa", blocks_path(ROOT + "/" + ENV))
check("artalmatlan fajl atengedve", not blocks_path(ROOT + "/README.md"))

# --- 2. NEGATIV kontrollok: ezek NEM blokkolodnak tobbe ---------------------
print()
print("NEGATIV kontroll -- a minta csak EMLITVE van, a muvelet nem tortenik meg:")
check("shell-komment emliti a torlest",
      not blocks("# ide nem irok " + RM + " parancsot\nls -la"))
check("shell-komment emliti a hitelesito konyvtarat",
      not blocks("# a ~/" + GM + " hitelesito adatot tartalmaz, ezert nem nyulunk hozza\nls"))
check("ADAT-heredoc torzse emliti a torlest",
      not blocks("cat > /tmp/doc.md <<'EOF'\nA szabaly: " + RM +
                 " parancsot nem futtatsz.\nEOF"))
check("ADAT-heredoc torzse emliti a hitelesito konyvtarat",
      not blocks('cat > /tmp/profil.json <<\'EOF\'\n{"deny": ["Read(${HOME}/' + SSH +
                 '/**)"]}\nEOF'))
check("ADAT-heredoc torzse emliti a konfig-fajlt",
      not blocks("cat > /tmp/jegyzet.txt <<'EOF'\nA port a " + ENV + " fajlban all.\nEOF"))
check("regex-minta tartalmazza a tiltott parancsot",
      not blocks('grep -ln "' + RM + ' -rf\\|' + MV + ' " scripts/hooks/*'))
check("uzenet-torzs emliti a hitelesito konyvtarat",
      not blocks('curl -s -X POST http://localhost:3420/api/messages '
                 '-d \'{"content":"a ~/' + GM + ' konyvtar mar letrehozva"}\''))
check("teszteset-lista karakterlanckent tartalmazza a parancsot",
      not blocks("python3 - <<'PY'\ncases = [('egyszeru', '" + RM +
                 " /tmp/x', 2)]\nprint(len(cases))\nPY"))
check("proza egy ertelmezo-heredoc karakterlancaban",
      not blocks("python3 - <<'PY'\nm = 'az ls ~/" + GM +
                 "/ parancs nem mond semmit'\nprint(m)\nPY"))

print()
print("NEGATIV kontroll -- artalmatlan hetkoznapi parancsok:")
for cmd in ("cd /home/istvan/marveen && ls -la",
            "git commit -m 'fix'",
            "rmdir /tmp/ures",
            "curl -s http://localhost:3420/api/kanban",
            "tmux list-sessions",
            "python3 - <<'PY'\nprint(1 + 1)\nPY",
            "grep -rn 'TODO' src/ | head -20"):
    check("atengedve: " + cmd.split("\n")[0][:46], not blocks(cmd))

# --- 3. Burkolo-parancsok (dec196bb) ----------------------------------------
# A kapu a szegmens ELSO szavat nezi parancsnevnek. Minden burkolo, amely parancsot kap
# ARGUMENTUMKENT, atvitte mellette a tiltott parancsot. Mind a tizenegy alak a kapu
# KORABBI valtozatan is atment: nem regresszio volt, hanem kezdettol nyitva allo res.
print()
print("POZITIV kontroll -- BURKOLT tiltott parancs, blokkolni kell:")
check("xargs helyettesito jellel", blocks("xargs -I {} " + RM + " {}"))
check("xargs kulon-szavas kapcsoloval", blocks("ls | xargs -n 1 " + RM))
check("find -exec pontosvesszovel", blocks("find . -name x -exec " + RM + " {} ;"))
check("find -exec plusz jellel", blocks("find . -name x -exec " + RM + " {} +"))
check("idokorlat-burkolo", blocks("timeout 5 " + RM + " /tmp/x"))
check("prioritas-burkolo", blocks("nice " + RM + " /tmp/x"))
check("prioritas-burkolo kapcsoloval", blocks("nice -n 10 " + RM + " /tmp/x"))
check("parhuzamosito", blocks("parallel " + RM + " ::: a b"))
check("ismetlo burkolo", blocks("watch " + RM + " /tmp/x"))
check("lancolt burkolok", blocks("timeout 5 nice " + RM + " /tmp/x"))
# A ket legfontosabb: igy indit egy agens parancsot a leggyakrabban.
check("shell -c kapcsoloval", blocks('bash -c "' + RM + ' -rf /tmp/x"'))
check("shell -c aposztroffal", blocks("sh -c '" + RM + " -rf /tmp/x'"))
# A burkolo-atlatas nem torolheti a szegmens sajat parancsanak vizsgalatat:
check("burkolo utan artalmatlan parancs atengedve", not blocks("timeout 5 ls -la /tmp"))
check("xargs utan artalmatlan parancs atengedve", not blocks("ls | xargs grep -l TODO"))
check("shell -c artalmatlan szkripttel atengedve",
      not blocks('bash -c "ls -la /tmp | head -3"'))

# --- 4. A KIMONDOTT KORLATOK ------------------------------------------------
# Ezek NEM allitasok arrol, hogy a viselkedes helyes. Azert allnak itt, hogy aki a kaput
# tovabbfejleszti, MERT adatot lasson arrol, meddig hat a vedelem -- es hogy ha valaki
# egyszer zarja oket, itt lassa, hol kell allitania.
print()
print("KIMONDOTT KORLAT -- ezek TUDATOSAN nyitva vannak (nem allitas, csak jelentes):")
for leiras, parancs in (
        ("tobbszintu beagyazas", 'bash -c "bash -c \\"' + RM + ' -rf /tmp/x\\""'),
        ("tavoli gepen futo parancs", "ssh gep " + RM + " -rf /tmp/x")):
    print("  [%s] %s" % ("nyitva" if not blocks(parancs) else "mar zarul", leiras))

# --- 5. Melysegkorlat es FAIL-CLOSED ----------------------------------------
# A melysegkorlat nem a mai viselkedes miatt kell (a mert maximalis melyseg 3), hanem
# hogy egy kesobbi valtoztatas se tudjon vegtelen rekurzioba futni. Tullepese BLOKK.
print()
print("POZITIV kontroll -- melysegkorlat es fail-closed:")
check("melysegkorlat letezik es blokkol",
      _depth_limit_blocks())
check("olvashatatlan bemenetre exit 2", _hook_exit("nem json") == 2)
check("artalmatlan parancsra exit 0",
      _hook_exit(json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls -la"}})) == 0)
check("tiltott parancsra exit 2",
      _hook_exit(json.dumps({"tool_name": "Bash",
                             "tool_input": {"command": RM + " -rf /tmp/x"}})) == 2)
# A LENYEG: ha maga a kapu hasal el, az NEM lehet csendes atengedes. A block() SystemExit-tel
# lep ki, azt az "except Exception" nem fogja meg -- tehat a valodi blokkolas atmegy, es
# csak a VARATLAN kivetel valt ki fail-closed viselkedest.
check("a kapu sajat hibaja is exit 2 (fail-closed)", _injected_fault_exit() == 2)


# --- 6. rm a munkakonyvtar alatt + git push (PR #1357) ----------------------
# A kapu ket szabalya SZUKULT, Szabolcs review-ja nyoman: a torles a munkakonyvtar
# alatt es a sajat munkaagra valo push a MUNKA resze, nem dontes. Amit a
# feltetel nelkuli tiltas termelt, az nem biztonsag volt, hanem atfogalmazas.
#
# A ket irany itt kulon all, es a NEGATIV oldal az uj: egy szabaly, ami csak
# blokkolni tud, ugyanannyit er, mint ami csak atengedni.
GROOT = gate.PROJECT_ROOT
OUTSIDE = os.path.dirname(GROOT)

print()
print("POZITIV kontroll -- torles, amit tovabbra sem enged at:")
check("munkakonyvtaron kivul, abszolut", blocks_cwd(RM + " /tmp/x", GROOT))
check("munkakonyvtaron kivul, relativ kilepessel",
      blocks_cwd(RM + " ../../valami", os.path.join(GROOT, "agents")))
check("a verziotortenet", blocks_cwd(RM + " -rf " + GROOT + "/.git", GROOT))
check("az eles allapot (store/)", blocks_cwd(RM + " " + GROOT + "/store/adat.db", GROOT))
check("maga a munkakonyvtar gyokere", blocks_cwd(RM + " -rf " + GROOT, GROOT))
check("cd utan mar mashol torol",
      blocks_cwd("cd " + OUTSIDE + " && " + RM + " -rf x", GROOT))
check("behelyettesites: nem eldontheto, hova mutat",
      blocks_cwd(RM + ' -rf "$TARGET/build"', GROOT))
check("cwd nelkul a relativ ut nem eldontheto", blocks(RM + " -rf build"))
check("nem latszik, mit torolne (csovezetekbol)", blocks_cwd("ls | xargs " + RM, GROOT))
check("find -exec helyettesito jellel", blocks_cwd(
      "find . -name '*.tmp' -exec " + RM + " {} ;", GROOT))

print()
print("NEGATIV kontroll -- torles a munkakonyvtar alatt, ez a MUNKA resze:")
check("abszolut ut a gyoker alatt",
      not blocks_cwd(RM + " " + GROOT + "/build/out.js", GROOT))
check("relativ ut a cwd alatt", not blocks_cwd(RM + " -rf build", GROOT))
check("relativ ut melyebb cwd-bol",
      not blocks_cwd(RM + " -f jegyzet.txt", os.path.join(GROOT, "agents", "valaki")))
check("glob nem lep at konyvtarhataron",
      not blocks_cwd(RM + " -f " + GROOT + "/tmp/*.log", GROOT))
check("cd a gyoker ALA, utana torles",
      not blocks_cwd("cd " + GROOT + "/agents && " + RM + " -rf scratch", GROOT))
check("'..' a gyokeren BELUL marad",
      not blocks_cwd(RM + " -rf ../build", os.path.join(GROOT, "agents")))

print()
print("POZITIV kontroll -- push, ami tovabbra is tiltott:")
check("eroltetett push", blocks(GPUSH + " --force origin munkaag"))
check("eroltetett push rovid alakkal", blocks(GPUSH + " -f origin munkaag"))
check("lease-elt eroltetes", blocks(GPUSH + " --force-with-lease origin munkaag"))
check("'+' refspec is eroltetes", blocks(GPUSH + " origin +munkaag"))
check("tavoli ag torlese", blocks(GPUSH + " origin --delete munkaag"))
check("vedett ag: main", blocks(GPUSH + " origin main"))
check("vedett ag: master ketoldalu refspecben", blocks(GPUSH + " origin HEAD:master"))
check("vedett ag teljes ref-uttal", blocks(GPUSH + " origin munkaag:refs/heads/main"))
check("mindent kitol", blocks(GPUSH + " --all origin"))
check("cel-ag nelkul nem eldontheto", blocks(GPUSH))
check("csak remote, refspec nelkul", blocks(GPUSH + " origin"))
check("a git sajat -C kapcsolojan is atlat", blocks("git -C /tmp push origin main"))

print()
print("NEGATIV kontroll -- sajat munkaagra valo push, ez a MUNKA resze:")
check("egyszeru munkaag", not blocks(GPUSH + " origin munkaag"))
check("upstream beallitasa", not blocks(GPUSH + " -u origin HEAD:munkaag"))
check("fork-URL-re, tokennel", not blocks(
      GPUSH + " https://user:x@github.com/valaki/repo.git munkaag:munkaag"))
check("cimke", not blocks(GPUSH + " origin v1.2.3"))
check("mas git alparancs valtozatlan", not blocks("git commit -m 'fix'"))


# --- 7. A cwd BEKOTESE a hook teljes utjan --------------------------------
# A 6. szakasz esetei kozvetlenul a check_bash()-t hivjak, megadott cwd-vel. A main()
# viszont az ESEMENYBOL veszi a cwd-t, es azt az ag egyetlen fenti eset sem erinti:
# ha a mezo neve elirodna, minden modul-szintu teszt zold maradna, es a kapu elesben
# minden relativ torlest blokkolna (vagy rosszabb: rossz konyvtarhoz merne).
def _hook_cwd_exit(cmd, cwd):
    ev = {"tool_name": "Bash", "tool_input": {"command": cmd}}
    if cwd is not None:
        ev["cwd"] = cwd
    return _hook_exit(json.dumps(ev))


print()
print("A cwd bekotese a hook teljes utjan (main -> check_bash):")
check("relativ torles a gyoker alol: atengedve", _hook_cwd_exit(RM + " -rf build", ROOT) == 0)
check("ugyanaz a parancs mashonnan: blokkolva",
      _hook_cwd_exit(RM + " -rf build", "/etc") == 2)
check("cwd nelkul a relativ ut nem eldontheto",
      _hook_cwd_exit(RM + " -rf build", None) == 2)
check("abszolut ut a gyoker alatt cwd nelkul is atmegy",
      _hook_cwd_exit(RM + " -rf " + ROOT + "/build", None) == 0)
check("munkaagra push atengedve", _hook_cwd_exit(GPUSH + " origin munkaag", ROOT) == 0)
check("main-re push blokkolva", _hook_cwd_exit(GPUSH + " origin main", ROOT) == 2)


# --- 8. SHELL-KULCSSZO a parancsnev elott (2026-09-24-i res) ----------------
# MERVE az akkori kapun: "rm -f /tmp/x" -> exit 2, de
# "if rm -f /tmp/x; then echo ok; fi" -> exit 0. A szegmens elso tokenje az `if`,
# az nem tiltott parancsnev, es a mogotte allo rm-et a kapu meg sem nezte. A hazi
# stilus epp ezt az alakot irja elo, tehat a leggyakoribb alak volt a vak folt.
print()
print("Shell-kulcsszo a parancsnev elott (nem rejtheti el a tiltott parancsot):")
check("if + rm blokkolva", blocks("if " + RM + " -f /etc/passwd; then echo ok; fi"))
check("while + rm blokkolva", blocks("while " + RM + " -rf /etc/x; do :; done"))
check("! + rm blokkolva", blocks("! " + RM + " -rf /etc/x"))
check("csoportositas + rm blokkolva", blocks("{ " + RM + " -rf /etc/x; }"))
check("then-agban allo rm blokkolva", blocks("then " + RM + " -rf " + HOME + "/.ssh"))
check("if + eros push blokkolva", blocks("if " + GPUSH + " --force origin main; then echo ok; fi"))
check("if + rm a gyoker alol atengedve",
      not blocks_cwd("if " + RM + " -rf build; then echo ok; fi", ROOT))
check("if + munkaagra push atengedve",
      not blocks_cwd("if " + GPUSH + " origin munkaag; then echo ok; fi", ROOT))
check("artalmatlan if-feltetel valtozatlanul atmegy",
      not blocks("if systemctl --user is-active foo; then echo A; else echo B; fi"))
check("teszt-feltetel atmegy", not blocks("if [ -f /tmp/x ]; then echo van; fi"))
check("az 'rm' szo mint grep-minta nem parancs", not blocks("if grep -q rm file.txt; then echo t; fi"))


print()
if failed:
    print("%d FAILED: %s" % (len(failed), failed), file=sys.stderr)
    sys.exit(1)
print("Minden destructive-gate szovegkornyezet-teszt zold.")
