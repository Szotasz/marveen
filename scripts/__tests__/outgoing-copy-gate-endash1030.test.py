#!/usr/bin/env python3
"""Test ENDASHGATE1030 in scripts/hooks/outgoing-copy-gate.py: a spaced en dash in prose is a dash.

The gate blocked the em dash (U+2014) and ' -- ', but a spaced en dash (' – ', U+2013), the usual Hungarian dash,
passed: 'ez megy – nem baj' went out.
  B1  'ez megy – nem baj'                                   : BLOCKED, '1 helyen'
  B2  two spaced en dashes                                  : BLOCKED, '2 helyen'
  B3  NBSP on both sides ('ez megy\\u00a0–\\u00a0nem baj')    : BLOCKED
  B4  the HTML entity ('ez megy &ndash; nem baj')           : BLOCKED (html.unescape)
  B5  a spaced range of numbers ('10 – 12 óra')             : BLOCKED (spaced, it reads as a dash; unspaced is the range)
  B6  double space and a tab around the dash                : BLOCKED, '2 helyen'
  B7  a dash at the end of a line ('ez megy –' + newline)   : BLOCKED
  N1  an unspaced range ('10–12 óra között')                : passes
  N2  a list marker at the start of a line ('– első')       : passes
  N3  inside a code span ('`a – b`') and in a URL           : passes (technical regions)
  N4  a word joined with an unspaced en dash ('Budapest–Bécs'): passes
  N5  an indented list marker ('  – első')                  : passes
KONTROLL: B1 and B4 against a copy without the new check: each must PASS there (else the test is blind).
Run: python3 scripts/__tests__/outgoing-copy-gate-endash1030.test.py   (exit 0 = the listed checks passed, 1 = a failure)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
CHECK = "    ed = len(SPACED_EN_DASH.findall(prose))\n"

ELEJE = "Szia! Holnap reggel átnézem, "
VEGE = ", és küldöm a választ. Köszönöm szépen."
FAILS = []


def check(nev, ok, reszlet=""):
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", nev, "" if ok or not reszlet else " (%s)" % reszlet[:300]))
    if not ok:
        FAILS.append(nev)


def run(hook, text):
    p = subprocess.run([sys.executable, hook], input=json.dumps(
        {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": {"text": text}}),
        capture_output=True, text=True, timeout=30, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    return p.returncode, p.stdout + p.stderr


def atment(kod, kimenet):
    return kod == 0 and "FAIL-OPEN" not in kimenet and "belso hiba" not in kimenet


def endash(kod, kimenet, db=None):
    return kod == 2 and "en dash" in kimenet and (db is None or "%d helyen" % db in kimenet)


BLOKK = (
    ("B1 a spaced en dash in prose", ELEJE + "ez megy – nem baj" + VEGE, 1),
    ("B2 two spaced en dashes", ELEJE + "ez megy – nem baj, és az is – holnap" + VEGE, 2),
    ("B3 NBSP on both sides", ELEJE + "ez megy – nem baj" + VEGE, 1),
    ("B4 the &ndash; entity", ELEJE + "ez megy &ndash; nem baj" + VEGE, 1),
    ("B5 a spaced range of numbers", ELEJE + "a hívás 10 – 12 óra között jó" + VEGE, 1),
    ("B6 double space and a tab", ELEJE + "ez megy  –  nem baj, és az is\t–\tholnap" + VEGE, 2),
    ("B7 a dash at the end of a line", "Szia! Holnap reggel átnézem, ez megy –\nnem baj, és küldöm a választ. Köszönöm szépen.", 1),
)
ATMEGY = (
    ("N1 an unspaced range", ELEJE + "a hívás 10–12 óra között jó" + VEGE),
    ("N2 a list marker at the start of a line", "Szia! A teendők holnapra:\n– első lépés\n– második lépés\nKöszönöm szépen, és küldöm a választ."),
    ("N3 code span and URL", ELEJE + "a parancs `a – b` és a https://example.com/a–b cím" + VEGE),
    ("N4 an unspaced en dash between words", ELEJE + "a Budapest–Bécs járat" + VEGE),
    ("N5 an indented list marker", "Szia! A teendők holnapra:\n  – első lépés\n  – második lépés\nKöszönöm szépen, és küldöm a választ."),
)


def main():
    src = open(HOOK, encoding="utf-8").read()
    check("S0 the check occurs exactly once", src.count(CHECK) == 1)

    for nev, szoveg, db in BLOKK:
        kod, ki = run(HOOK, szoveg)
        check("%s: BLOCKED, %d place(s)" % (nev, db), endash(kod, ki, db), ki)
    for nev, szoveg in ATMEGY:
        kod, ki = run(HOOK, szoveg)
        check("%s: passes (0)" % nev, atment(kod, ki), ki)

    tmp = tempfile.mkdtemp(prefix="endash1030-mutans-")
    try:
        hooks = os.path.join(tmp, "scripts", "hooks")
        os.makedirs(hooks)
        os.symlink(os.path.join(os.path.dirname(os.path.dirname(HOOK)), "lib"), os.path.join(tmp, "scripts", "lib"))
        os.symlink(os.path.join(os.path.dirname(HOOK), "email_extract.py"), os.path.join(hooks, "email_extract.py"))
        mutans = os.path.join(hooks, "outgoing-copy-gate.py")
        with open(mutans, "w", encoding="utf-8") as fh:
            fh.write(src.replace(CHECK, "    ed = 0\n", 1))
        for nev, szoveg, _ in (BLOKK[0], BLOKK[3]):
            kod, ki = run(mutans, szoveg)
            if "Traceback" in ki or kod not in (0, 2):
                print("  [FAIL] KONTROLL NOT MEASURABLE (%s): exit %d" % (nev, kod))
                FAILS.append("kontroll-" + nev)
            elif atment(kod, ki):
                print("KONTROLL-ATMENT: %s without the check (passes, as it did before)" % nev)
            else:
                print("  [FAIL] KONTROLL DID NOT PASS (%s): blocked without the check too, the test is blind" % nev)
                FAILS.append("kontroll-" + nev)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        if os.path.exists(tmp):
            print("  [FAIL] the temporary directory could not be removed: %s" % tmp)
            FAILS.append("tmp-szivargas")

    print("ITELET: %s" % ("the listed cases are as expected" if not FAILS else "%d cases differ: %s" % (len(FAILS), FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
