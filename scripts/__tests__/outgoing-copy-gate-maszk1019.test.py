#!/usr/bin/env python3
"""Test the COPYMASK1019 extension of the accent check's identifier mask (_ACCENT_ONLY) in
scripts/hooks/outgoing-copy-gate.py.

The #2065 corpus check found accent hits that sit only in identifiers. Three of their shapes are masked now, for the
accent check only (same reason as EKEZETMASZK1018: TECHNICAL also feeds the homoglyph rule). Uses the dictionary word
'reszletek' -> 'részletek', like outgoing-copy-gate-maszk1018.test.py.
  N1  'a reszletek/ mappa'      (a directory with its trailing slash)     in a correctly accented message: passes (0)
  N2  '(reszletek/*, ...)'      (the same with a glob)                    : passes
  N3  'funkcio=reszletek'       (key=value)                               : passes
  P1  'a reszletek lent'        (the word in prose)                       : BLOCKED, the word named
  P2  "'a reszletek lent'"      (a quoted run of several words): NOT masked, deliberately (that is usually copy): BLOCKED
  P3  'reszletek = lent'        (an '=' with spaces is prose punctuation) : BLOCKED
  P4  'a kepek/. Reszletek ...' (the directory branch does not swallow the sentence-final period): the next sentence's
      capitalised first word is still checked: BLOCKED
  P5  "don't reszletek, isn't"  (English apostrophes do not hide a word): BLOCKED
  Q1-Q3 a quoted single word is customer copy as often as a literal (Samu, #2085 review), so it is NOT masked:
      'kattints a "reszletek" gombra', "a gomb felirata 'reszletek'", 'ird be: "reszletek"': each BLOCKED
  S1  the two branches are in _ACCENT_ONLY; S2 neither the TECHNICAL / NAME_MASK source nor their compiled patterns
      contain them; S2b strip_technical() and strip_for_name() leave the two shapes in place
  H1-H2 a Cyrillic homoglyph inside 'f.glalas/' and 'x=f.glalas' is still blocked by the homoglyph rule
KONTROLL: N1-N3 against a copy whose strip_for_accent() returns its input unchanged: each must be BLOCKED.
KONTROLL-AG: one copy per new branch with only that branch made never-matching: exactly that branch's cases are BLOCKED
(konyvtar: N1 N2, kulcs: N3), the others still pass.
Pass expectations use atment() (exit 0, no FAIL-OPEN / internal-error marker), blocks of the accent rule use tiltva()
(exit 2, 'HIANYZO EKEZETEK' and 'szo ->'). The temporary directory is used inside try/finally; one left behind is a FAIL.
Run: python3 scripts/__tests__/outgoing-copy-gate-maszk1019.test.py   (exit 0 = the listed checks passed, 1 = a failure)
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
MUTANS_REGI = '    return ACCENT_MASK.sub(" ", prose)\n'
MUTANS_UJ = '    return prose\n'
# KONTROLL-AG: the new branches (each exactly once in the hook) and the cases only that branch covers
AG_MINTAK = {
    "konyvtar": (r"""(?<![\w/.-])[\w.-]+/\**(?=[\s,;:.!?)\]'"]|$)""", {"N1", "N2"}),
    "kulcs": (r"""(?<![\w.-])[A-Za-z_][\w.-]*=[^\s,;)\]'"]+""", {"N3"}),
}
SOHA = r"(?!x)x"

CIR_O = "о"   # Cyrillic o, a homoglyph
ELEJE = "Szia! Holnap reggel átnézem, "
VEGE = ", és küldöm a választ. Köszönöm szépen."
ESETEK = {
    "N1": ELEJE + "a reszletek/ mappa is megvan" + VEGE,
    "N2": ELEJE + "az oldalak (reszletek/*, index) is megvannak" + VEGE,
    "N3": ELEJE + "a funkcio=reszletek sor is megvan" + VEGE,
}
FAILS = []


def atment(kod, kimenet):
    return kod == 0 and "FAIL-OPEN" not in kimenet and "belso hiba" not in kimenet


def tiltva(kod, kimenet, szo):
    return kod == 2 and "HIANYZO EKEZETEK" in kimenet and (szo + " ->") in kimenet


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
    spec = importlib.util.spec_from_file_location("maszk1019_gate", HOOK)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    src = open(HOOK, encoding="utf-8").read()
    acc = re.search(r'^_ACCENT_ONLY = r"""(.*?)"""', src, re.S | re.M)
    tech = re.search(r'^_TECH_COMMON = r"""(.*?)"""', src, re.S | re.M).group(1) + \
        re.search(r'^_TECH_SUFFIXED = r"""(.*?)"""', src, re.S | re.M).group(1)
    agak = [m for m, _ in AG_MINTAK.values()]
    check("S1 the two branches are in the separate _ACCENT_ONLY mask", acc is not None and all(a in acc.group(1) for a in agak))
    check("S2 the TECHNICAL (homoglyph, double hyphen) and NAME_MASK sources do not contain them", not any(a in tech for a in agak))
    g = modul()
    check("S2 nor do the compiled TECHNICAL.pattern and NAME_MASK.pattern",
          not any(a in g.TECHNICAL.pattern or a in g.NAME_MASK.pattern for a in agak))
    minta = "a reszletek/ es a funkcio=reszletek is"
    check("S2b strip_technical() and strip_for_name() leave the two shapes in place",
          g.strip_technical(minta).count("reszletek") == 2 and g.strip_for_name(minta).count("reszletek") == 2,
          "%r / %r" % (g.strip_technical(minta), g.strip_for_name(minta)))
    check("S3 the mutant anchor occurs exactly once", src.count(MUTANS_REGI) == 1)

    for nev, szoveg in ESETEK.items():
        kod, ki = run(HOOK, szoveg)
        check("%s the dictionary word in an identifier does not alarm (0)" % nev, atment(kod, ki), ki)

    for nev, szoveg, leiras in (
        ("P1", ELEJE + "a reszletek lent vannak" + VEGE, "the word in prose"),
        ("P2", ELEJE + "a 'reszletek lent vannak' mondat" + VEGE, "a quoted run of several words is not masked"),
        ("P3", ELEJE + "a reszletek = lent sor" + VEGE, "an '=' with spaces is prose"),
        ("P4", "Szia! A mappa neve kepek/. Reszletek holnap jönnek, köszönöm szépen.", "the period after a directory is not swallowed"),
        ("P5", "Szia! I don't know, reszletek isn't here, köszönöm szépen, holnap jönnek a válaszok.", "an English apostrophe does not hide a word"),
        ("Q1", ELEJE + 'kattints a "reszletek" gombra' + VEGE, "a quoted button label is customer copy"),
        ("Q2", ELEJE + "a gomb felirata 'reszletek' lesz" + VEGE, "a quoted label in single quotes"),
        ("Q3", ELEJE + 'ird be: "reszletek"' + VEGE, "a quoted value to type"),
    ):
        kod, ki = run(HOOK, szoveg)
        check("%s %s: BLOCKED and named (2)" % (nev, leiras), tiltva(kod, ki, "reszletek"), ki)

    for nev, tok in (("H1", "f%sglalas/" % CIR_O), ("H2", "x=f%sglalas" % CIR_O)):
        kod, ki = run(HOOK, "Szia! Holnap átnézem a %s részt is, és küldöm a választ. Köszönöm szépen." % tok)
        check("%s a homoglyph in '%s': still BLOCKED by the homoglyph rule (2)" % (nev, tok), kod == 2 and "nem-latin" in ki, ki)

    tmp = tempfile.mkdtemp(prefix="maszk1019-mutans-")
    try:
        hooks = os.path.join(tmp, "scripts", "hooks")
        os.makedirs(hooks)
        os.symlink(os.path.join(os.path.dirname(os.path.dirname(HOOK)), "lib"), os.path.join(tmp, "scripts", "lib"))
        os.symlink(os.path.join(os.path.dirname(HOOK), "email_extract.py"), os.path.join(hooks, "email_extract.py"))
        mutans = os.path.join(hooks, "outgoing-copy-gate.py")
        with open(mutans, "w", encoding="utf-8") as fh:
            fh.write(src.replace(MUTANS_REGI, MUTANS_UJ, 1))
        for nev, szoveg in ESETEK.items():
            kod, ki = run(mutans, szoveg)
            if merhetetlen(kod, ki):
                print("  [FAIL] KONTROLL NOT MEASURABLE (%s): exit %d" % (nev, kod))
                FAILS.append("kontroll-%s" % nev)
            elif tiltva(kod, ki, "reszletek"):
                print("KONTROLL-BUKOTT: %s without the mask (blocked, as it must be)" % nev)
            else:
                print("  [FAIL] KONTROLL DID NOT FAIL (%s): passes without the mask too, the test is blind" % nev)
                FAILS.append("kontroll-%s" % nev)
        for ag, (minta_ag, sajat) in AG_MINTAK.items():
            if src.count(minta_ag) != 1:
                print("  [FAIL] KONTROLL-AG NOT MEASURABLE (%s): the branch is not in the hook exactly once" % ag)
                FAILS.append("kontroll-ag-%s" % ag)
                continue
            with open(mutans, "w", encoding="utf-8") as fh:
                fh.write(src.replace(minta_ag, SOHA, 1))
            for nev, szoveg in ESETEK.items():
                kod, ki = run(mutans, szoveg)
                if merhetetlen(kod, ki):
                    print("  [FAIL] KONTROLL-AG NOT MEASURABLE (%s, %s): exit %d" % (ag, nev, kod))
                    FAILS.append("kontroll-ag-%s-%s" % (ag, nev))
                elif nev in sajat and not tiltva(kod, ki, "reszletek"):
                    print("  [FAIL] KONTROLL-AG DID NOT FAIL (%s, %s): passes without the branch" % (ag, nev))
                    FAILS.append("kontroll-ag-%s-%s" % (ag, nev))
                elif nev not in sajat and not atment(kod, ki):
                    print("  [FAIL] KONTROLL-AG (%s, %s): another branch's case failed too" % (ag, nev))
                    FAILS.append("kontroll-ag-%s-%s" % (ag, nev))
                elif nev in sajat:
                    print("KONTROLL-AG-BUKOTT: without the %s branch %s is blocked" % (ag, nev))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        if os.path.exists(tmp):
            print("  [FAIL] the temporary directory could not be removed: %s" % tmp)
            FAILS.append("tmp-szivargas")

    print("ITELET: %s" % ("the listed cases are as expected" if not FAILS else "%d cases differ: %s" % (len(FAILS), FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
