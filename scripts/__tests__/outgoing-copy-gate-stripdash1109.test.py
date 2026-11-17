#!/usr/bin/env python3
"""Test STRIPDASH1109 in scripts/hooks/outgoing-copy-gate.py: cutting a technical region never creates a ' -- '.

The double-hyphen count ran on strip_technical() output, which puts a SPACE where a region was, so the cut itself could
build the pattern: '--accept_routes=true' (snake_case branch) became ' -- =true' and was BLOCKED as a prose dash. The
count now runs on a copy where each region is a placeholder with no space in it.
  N1  a --flag with a snake_case name ('tool --accept_routes=true')               : passes (0)
  N2  a --flag right before a code span ('tool --`dry`')                          : passes
  N3  the original measured case ('sudo tailscale set --accept-routes=true')      : passes (FLAGDASH1030 kept)
  P1  a real dash in prose ('ez megy -- nem baj')                                 : BLOCKED, '1 helyen'
  P2  a real dash right before a code span ('ez -- `kod`')                        : BLOCKED, '1 helyen'
  P3  a real dash right after a snake_case name ('kod_nev -- ez')                 : BLOCKED, '1 helyen'
  P4  a flagged region and a real dash in one text: the dash is counted exactly once
  S1  strip_technical_closed() leaves no space where a region was
KONTROLL: N1 and N2 against a copy that counts on the old, space-filled cut: each must be BLOCKED for the double hyphen.
Run: python3 scripts/__tests__/outgoing-copy-gate-stripdash1109.test.py   (exit 0 = the listed checks passed, 1 = a failure)
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
UJ_SZAMLALAS = 'dh = strip_technical_closed(plain).count(" -- ")'
REGI_SZAMLALAS = 'dh = prose.count(" -- ")'
ELEJE = "Szia! Holnap reggel átnézem, "
VEGE = ", és küldöm a választ. Köszönöm szépen."
ESETEK = {
    "N1": ELEJE + "a parancs ez: tool --accept_routes=true" + VEGE,
    "N2": ELEJE + "a parancs ez: tool --`dry`" + VEGE,
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
    spec = importlib.util.spec_from_file_location("stripdash1109_gate", HOOK)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    src = open(HOOK, encoding="utf-8").read()
    check("S0 the new count occurs exactly once", src.count(UJ_SZAMLALAS) == 1)
    g = modul()
    kivagva = g.strip_technical_closed("tool --accept_routes=true")
    check("S1 strip_technical_closed() leaves no space where a region was", " -- " not in kivagva and "--" + g.TECH_PLACEHOLDER in kivagva, repr(kivagva))

    for nev, szoveg in ESETEK.items():
        kod, ki = run(HOOK, szoveg)
        check("%s a cut region does not make a prose dash (0)" % nev, atment(kod, ki), ki)
    kod, ki = run(HOOK, ELEJE + "a parancs ez: sudo tailscale set --accept-routes=true" + VEGE)
    check("N3 the measured case passes (0)", atment(kod, ki), ki)

    for nev, szoveg, db, leiras in (
        ("P1", ELEJE + "ez megy -- nem baj" + VEGE, 1, "a real dash in prose"),
        ("P2", ELEJE + "ez -- `kod`" + VEGE, 1, "a real dash before a code span"),
        ("P3", ELEJE + "kod_nev -- ez" + VEGE, 1, "a real dash after a snake_case name"),
        ("P4", ELEJE + "futtasd: tool --accept_routes=true -- utána jó" + VEGE, 1, "a cut flag next to a real dash"),
    ):
        kod, ki = run(HOOK, szoveg)
        check("%s %s: BLOCKED, counted once (2)" % (nev, leiras), kotojel(kod, ki, db), ki)

    tmp = tempfile.mkdtemp(prefix="stripdash1109-mutans-")
    try:
        hooks = os.path.join(tmp, "scripts", "hooks")
        os.makedirs(hooks)
        os.symlink(os.path.join(os.path.dirname(os.path.dirname(HOOK)), "lib"), os.path.join(tmp, "scripts", "lib"))
        os.symlink(os.path.join(os.path.dirname(HOOK), "email_extract.py"), os.path.join(hooks, "email_extract.py"))
        mutans = os.path.join(hooks, "outgoing-copy-gate.py")
        with open(mutans, "w", encoding="utf-8") as fh:
            fh.write(src.replace(UJ_SZAMLALAS, REGI_SZAMLALAS, 1))
        for nev, szoveg in ESETEK.items():
            kod, ki = run(mutans, szoveg)
            if merhetetlen(kod, ki):
                print("  [FAIL] KONTROLL NOT MEASURABLE (%s): exit %d" % (nev, kod))
                FAILS.append("kontroll-%s" % nev)
            elif kotojel(kod, ki):
                print("KONTROLL-BUKOTT: %s with the old count (blocked for the double hyphen, as it was)" % nev)
            else:
                print("  [FAIL] KONTROLL DID NOT FAIL (%s): passes with the old count too, the test is blind" % nev)
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
