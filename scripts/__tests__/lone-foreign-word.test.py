#!/usr/bin/env python3
"""LONEFOREIGN893 -- a magyar mondatban allo, maganyos idegen szo is talalat.

MIT VED. A vegyes-iras szabaly (scripts/lib/mixed_script.py) SZANDEKOSAN
atengedi a tisztan nem-latin szot, mert az idegen nyelvu idezet legitim. Egy
eset viszont atcsuszott rajta: 2026-10-09-en egy magyar Telegram-uzenetben a
"majus" helyett az orosz "май" allt. A szo tisztan cirill, tehat a szon
BELUL nincs keveredes -- es a mondat magyarul olvasva ertelmes maradt.

A KULONBSEG, AMIT A SZABALY MER: az idezet TOBB idegen szobol all vagy
idezojelben van; az elgepeles EGY, magaban allo szo egy egyebkent latin
mondatban. Ezert a ket iranyt KULON merjuk: a FOG eseteket ugyanugy, mint az
ATENGED eseteket -- egy "mindent megfog" valtozat az elsot teljesitene, es a
masodikkal buktatna meg a legitim szovegeket.

Futtatas: python3 scripts/__tests__/lone-foreign-word.test.py   (exit 0 = rendben)
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
LIB = os.path.join(ROOT, "scripts", "lib")
sys.path.insert(0, LIB)

import mixed_script  # noqa: E402

FAILS = 0
N = 0


def allit(mit: str, igaz: bool, extra: str = "") -> None:
    global FAILS, N
    N += 1
    if igaz:
        print(f"PASS  {mit}")
    else:
        FAILS += 1
        print(f"FAIL  {mit}{('  -- ' + extra) if extra else ''}")


# ---------------------------------------------------------------- a szabaly
FOG = [
    ("a kartya esete", "A legnagyobb egyhavi eses -14,6%, az is май-junius kozott"),
    ("maganyos cirill szo mondat kozepen", "a jelentes отчет formaban keszult el ma"),
    ("maganyos gorog SZO", "a gorog λόγος szo jelentese ertelem"),
]
ATENGED = [
    ("idegen idezet idezojelben", "Balazs azt irta: „Спасибо большое” es ennyi volt"),
    ("idegen MONDAT idezojel nelkul", "A mondat igy szolt: Спасибо большое за помощь ennyi volt"),
    # EZT CSAK AZ IDEZOJEL-SZABALY MENTI MEG: EGYETLEN idegen szo, latin szavak
    # kozott -- a sziget-feltetel szerint talalat lenne. Enelkul az idezojel-ag
    # MERETLEN marad (merve: a kivetelet torolve a keszlet zold maradt).
    ("EGY idegen szo IDEZOJELBEN", "A magyar szo a „правда” jelentese igazsag"),
    ("egy betus gorog szimbolum", "a π erteke 3,14 es a Δ jele valtozas"),
    ("egy betus cirill jel", "a т betu a cirill abeceben all"),
    ("mertekegyseg", "a meres 40 µs alatt lefutott rendben"),
    ("keplet", "a H₂O es a 100 m² is rendben van igy"),
    ("tiszta magyar", "Ez egy teljesen rendes magyar mondat, ekezettel."),
    ("tiszta orosz szoveg", "Это полностью русское предложение"),
    # A KEVES LATIN SZO SZANDEKOSAN ATENGED: ket szavas toredekben nincs eleg
    # bizonyitek arra, hogy a szoveg magyar, es egy kapu-tevedes dragabb.
    ("rovid toredek", "Koszi спасибо"),
]

for cimke, szoveg in FOG:
    allit(f"FOG: {cimke}", bool(mixed_script.isolated_foreign_words(szoveg)), repr(szoveg[:46]))
for cimke, szoveg in ATENGED:
    talalat = mixed_script.isolated_foreign_words(szoveg)
    allit(f"ATENGED: {cimke}", not talalat, f"talalat: {talalat}")

# A VEGYES-SZO SZABALY VALTOZATLAN: ez a par allitas, enelkul egy olyan atiras is
# atmenne, ami a regi szabalyt elrontja.
allit(
    "a vegyes szo (cirill o magyar szoban) TOVABBRA IS talalat",
    bool(mixed_script.mixed_script_words("a fajl nem tоlthető")),
)
allit(
    "es a tisztan idegen szo a VEGYES szabalynak tovabbra sem talalat",
    not mixed_script.mixed_script_words("az is май-junius kozott"),
)

# ------------------------------------------------- a KET UT, egy szabalybol
# A kartya kimondja: mind a ket utvonal a kozos modulbol dolgozzon. Ezt nem
# forras-olvasassal merjuk, hanem a VISELKEDESSEL: ugyanaz a szoveg mind a
# kettot megallitja.
proc = subprocess.run(
    [sys.executable, os.path.join(LIB, "homoglyph.py")],
    input="A legnagyobb egyhavi eses, az is май-junius kozott".encode(),
    capture_output=True,
)
allit("az agent-msg ut (homoglyph.py) MEGALL rajta", proc.returncode == 3, f"exit {proc.returncode}")
allit("  es megnevezi a szot", "май" in proc.stderr.decode(), proc.stderr.decode()[:80])

proc_ok = subprocess.run(
    [sys.executable, os.path.join(LIB, "homoglyph.py")],
    input="A mondat igy szolt: Спасибо большое за помощь ennyi volt".encode(),
    capture_output=True,
)
allit("  es az idegen MONDATOT atengedi", proc_ok.returncode == 0, f"exit {proc_ok.returncode}")

# A hook-ut a kozos modulbol importalja a szabalyt; ha az import elromlik, a
# csonk FAIL-CLOSED kivetelt dob, nem ures listat ad.
hook = os.path.join(ROOT, "scripts", "hooks", "outgoing-copy-gate.py")
forras = open(hook, encoding="utf-8").read()
allit("a hook a kozos modulbol importalja a szabalyt", "isolated_foreign_words," in forras)
allit("  es a hook fail-closed csonkja is dob", forras.count("raise MixedScriptUnavailable(_MIXED_ERR)") == 2)

print(f"\n{N} allitas, {FAILS} bukott")
sys.exit(1 if FAILS else 0)
