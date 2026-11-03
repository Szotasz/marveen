#!/usr/bin/env python3
"""Test FLAGDASH1030 in scripts/hooks/outgoing-copy-gate.py: a --flag with hyphens inside is not a prose dash.

The hyphenated-identifier branch of TECHNICAL used to take only the word part of '--select-release-current', so
strip_technical() left the '--' between two spaces and the double-hyphen rule (' -- ') blocked the message.
  N1  'plesk installer --select-release-current --upgrade-installed-components'  : passes (0)
  N2  one flag at the end of a sentence ('futtasd --dry-run-only.')              : passes
  N3  a flag without inner hyphen ('npm run build --verbose')                     : passes (it never alarmed)
  P1  a real dash in prose ('ez megy -- nem baj')                                 : BLOCKED, DUPLA KOTOJEL
  P2  a prose dash before a hyphenated word ('ez -- az ujra-inditas')             : BLOCKED (the prefix needs a letter
      right after the two hyphens, a prose dash has a space there)
  P3  the flag next to a real prose dash: the dash is still counted, exactly once : BLOCKED, '1 helyen'
  H1  a Cyrillic homoglyph inside '--f.glalas-mod' is still blocked by the homoglyph rule
  S1  strip_technical() removes the whole flag, the '--' included
KONTROLL: N1 and N2 against a copy with the old branch (no '--' prefix): each must be BLOCKED for the double hyphen.
Run: python3 scripts/__tests__/outgoing-copy-gate-flagdash1030.test.py   (exit 0 = the listed checks passed, 1 = a failure)
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
UJ_AG = r"(?:(?<![\w-])--)?\b[a-z]+(?:-[a-z]+){1,4}\b"
REGI_AG = r"\b[a-z]+(?:-[a-z]+){1,4}\b"

CIR_O = "о"   # Cyrillic o, a homoglyph
ELEJE = "Szia! Holnap reggel átnézem, "
VEGE = ", és küldöm a választ. Köszönöm szépen."
ESETEK = {
    "N1": ELEJE + "a parancs ez: plesk installer --select-release-current --upgrade-installed-components" + VEGE,
    "N2": "Szia! Holnap reggel átnézem, előtte futtasd így: tool --dry-run-only. Köszönöm szépen, és küldöm a választ.",
}
FAILS = []


def atment(kod, kimenet):
    return kod == 0 and "FAIL-OPEN" not in kimenet and "belso hiba" not in kimenet


def kotojel(kod, kimenet, db=None):
    return kod == 2 and "DUPLA KOTOJEL" in kimenet and (db is None or "%d helyen" % db in kimenet)


def merhetetlen(kod, kimenet):
    return "Traceback" in kimenet or kod not in (0, 2) or "FAIL-OPEN" in kimenet or "belso hiba" in kimenet


def check(nev, ok, reszlet=""):
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", nev, "" if ok or not reszlet else " (%s)" % reszlet[:300]))
    if not ok:
        FAILS.append(nev)


def run(hook, text):
    p = subprocess.run([sys.executable, hook], input=json.dumps(
        {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": {"text": text}}),
        capture_output=True, text=True, timeout=30, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    return p.returncode, p.stdout + p.stderr


def modul():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("flagdash1030_gate", HOOK)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    src = open(HOOK, encoding="utf-8").read()
    check("S0 the new branch occurs exactly once", src.count(UJ_AG) == 1)
    g = modul()
    minta = "plesk installer --select-release-current --upgrade-installed-components"
    kivagva = g.strip_technical(minta)
    check("S1 strip_technical() removes the whole flag, the '--' included", "--" not in kivagva, repr(kivagva))

    for nev, szoveg in ESETEK.items():
        kod, ki = run(HOOK, szoveg)
        check("%s a --flag with inner hyphens is not a prose dash (0)" % nev, atment(kod, ki), ki)
    kod, ki = run(HOOK, ELEJE + "a buildet így indítsd: npm run build --verbose" + VEGE)
    check("N3 a flag without inner hyphen passes (0)", atment(kod, ki), ki)

    for nev, szoveg, db, leiras in (
        ("P1", ELEJE + "ez megy -- nem baj" + VEGE, 1, "a real dash in prose"),
        ("P2", ELEJE + "ez -- az ujra-inditas" + VEGE, 1, "a prose dash before a hyphenated word"),
        ("P3", ELEJE + "futtasd: tool --dry-run-only -- utána jó" + VEGE, 1, "a flag next to a prose dash"),
    ):
        kod, ki = run(HOOK, szoveg)
        check("%s %s: BLOCKED, counted once (2)" % (nev, leiras), kotojel(kod, ki, db), ki)

    kod, ki = run(HOOK, "Szia! Holnap átnézem a --f%sglalas-mod kapcsolót is, és küldöm a választ. Köszönöm szépen." % CIR_O)
    check("H1 a homoglyph inside a --flag: still BLOCKED by the homoglyph rule (2)", kod == 2 and "nem-latin" in ki, ki)

    tmp = tempfile.mkdtemp(prefix="flagdash1030-mutans-")
    try:
        hooks = os.path.join(tmp, "scripts", "hooks")
        os.makedirs(hooks)
        os.symlink(os.path.join(os.path.dirname(os.path.dirname(HOOK)), "lib"), os.path.join(tmp, "scripts", "lib"))
        os.symlink(os.path.join(os.path.dirname(HOOK), "email_extract.py"), os.path.join(hooks, "email_extract.py"))
        mutans = os.path.join(hooks, "outgoing-copy-gate.py")
        with open(mutans, "w", encoding="utf-8") as fh:
            fh.write(src.replace(UJ_AG, REGI_AG, 1))
        for nev, szoveg in ESETEK.items():
            kod, ki = run(mutans, szoveg)
            if merhetetlen(kod, ki):
                print("  [FAIL] KONTROLL NOT MEASURABLE (%s): exit %d" % (nev, kod))
                FAILS.append("kontroll-%s" % nev)
            elif kotojel(kod, ki):
                print("KONTROLL-BUKOTT: %s with the old branch (blocked for the double hyphen, as it was)" % nev)
            else:
                print("  [FAIL] KONTROLL DID NOT FAIL (%s): passes with the old branch too, the test is blind" % nev)
                FAILS.append("kontroll-%s" % nev)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        if os.path.exists(tmp):
            print("  [FAIL] the temporary directory could not be removed: %s" % tmp)
            FAILS.append("tmp-szivargas")

    print("ITELET: %s" % ("the listed cases are as expected" if not FAILS else "%d cases differ: %s" % (len(FAILS), FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
