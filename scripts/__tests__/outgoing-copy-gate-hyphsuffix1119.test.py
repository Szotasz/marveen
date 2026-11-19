#!/usr/bin/env python3
"""Test HYPHSUFFIX1119: the accent check skips a hyphen-attached Hungarian suffix after a closing mark
(scripts/hooks/outgoing-copy-gate.py, ATTACHED_SUFFIX / strip_attached_suffix).

The #2920 corpus check (637 real Slack sends) found 5 false refusals, all one shape: the suffix written with a hyphen
after a foreign word, a quote or Markdown. The closing mark cut the suffix off, and 'ot' was read as an unaccented 'öt'.
  N1  'futtasd az `<term>`-ot'      (a foreign word in a code span)          in a correctly accented message: passes (0)
  N2  'a "nagy gomb"-ot'            (straight double quote)                  : passes
  N3  'a „nagy gomb”-ot'            (Hungarian curly quotes)                 : passes
  N4  "a 'nagy gomb'-ot"            (single quote)                           : passes
  N5  'a *Messages Tab*-ot'         (bold)                                   : passes
  N6  'a **nagy gomb**-ot'          (double-star bold)                       : passes
  N7  'a (nagy gomb)-ot'            (parenthesis)                            : passes
  P1  'tehat holnap'                (the real refusal of the corpus)         : BLOCKED, the word named
  P2  'ot perc mulva'               (the standalone word)                    : BLOCKED
  P3  'a gomb - ot perc'            (a prose dash: a space before the hyphen): BLOCKED
  P4  'a "nagy gomb"-reszletek'     (more than 4 letters: a compound part, not a suffix): BLOCKED
  H1  'a "nagy gomb"-<Cyrillic o>t' (a homoglyph in the suffix): BLOCKED by the homoglyph rule
  S1  strip_technical() and strip_for_name() do not apply the new mask (the homoglyph and name rules keep the suffix)
KONTROLL: N1-N7 against a copy whose strip_attached_suffix() returns its input unchanged: each must be BLOCKED.
Pass expectations use atment() (exit 0, no FAIL-OPEN / internal-error marker), blocks of the accent rule use tiltva()
(exit 2, 'HIANYZO EKEZETEK' and 'szo ->'). The temporary directory is used inside try/finally; one left behind is a FAIL.
Run: python3 scripts/__tests__/outgoing-copy-gate-hyphsuffix1119.test.py   (exit 0 = the listed checks passed, 1 = a failure)
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
MUTANS_REGI = '    return ATTACHED_SUFFIX.sub("", text)\n'
MUTANS_UJ = '    return text\n'

CIR_O = "о"   # Cyrillic o, a homoglyph
ELEJE = "Szia! Holnap reggel átnézem, "
VEGE = ", és küldöm a választ. Köszönöm szépen."
ESETEK = {
    "N1": ELEJE + "futtasd az `install-check`-ot is" + VEGE,
    "N2": ELEJE + 'a "nagy gomb"-ot is' + VEGE,
    "N3": ELEJE + "a „nagy gomb”-ot is" + VEGE,
    "N4": ELEJE + "a 'nagy gomb'-ot is" + VEGE,
    "N5": ELEJE + "a *Messages Tab*-ot is" + VEGE,
    "N6": ELEJE + "a **nagy gomb**-ot is" + VEGE,
    "N7": ELEJE + "a (nagy gomb)-ot is" + VEGE,
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
        {"tool_name": "mcp__plugin_slack-channel_slack__reply", "tool_input": {"chat_id": "D0TEST", "text": text}}),
        capture_output=True, text=True, timeout=30, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    return p.returncode, p.stdout + p.stderr


def modul():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("hyphsuffix1119_gate", HOOK)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    src = open(HOOK, encoding="utf-8").read()
    check("S0 the mutant anchor occurs exactly once", src.count(MUTANS_REGI) == 1)
    g = modul()
    minta = 'a "nagy gomb"-ot'
    check("S1 strip_technical() and strip_for_name() keep the suffix (the mask is accent-only)",
          "-ot" in g.strip_technical(minta) and "-ot" in g.strip_for_name(minta),
          "%r / %r" % (g.strip_technical(minta), g.strip_for_name(minta)))

    for nev, szoveg in ESETEK.items():
        kod, ki = run(HOOK, szoveg)
        check("%s a hyphen-attached suffix after a closing mark does not alarm (0)" % nev, atment(kod, ki), ki)

    for nev, szoveg, szo, leiras in (
        ("P1", ELEJE + "tehat holnap" + VEGE, "tehat", "the corpus's real refusal"),
        ("P2", ELEJE + "ot perc mulva" + VEGE, "ot", "the standalone word"),
        ("P3", ELEJE + "a gomb - ot perc" + VEGE, "ot", "a prose dash, space before the hyphen"),
        ("P4", ELEJE + 'a "nagy gomb"-reszletek' + VEGE, "reszletek", "more than 4 letters is not a suffix"),
    ):
        kod, ki = run(HOOK, szoveg)
        check("%s %s: BLOCKED and named (2)" % (nev, leiras), tiltva(kod, ki, szo), ki)

    kod, ki = run(HOOK, ELEJE + 'a "nagy gomb"-%st is' % CIR_O + VEGE)
    check("H1 a homoglyph in the suffix: still BLOCKED by the homoglyph rule (2)", kod == 2 and "nem-latin" in ki, ki)

    tmp = tempfile.mkdtemp(prefix="hyphsuffix1119-mutans-")
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
            elif tiltva(kod, ki, "ot"):
                print("KONTROLL-BUKOTT: %s without the mask (blocked, as it must be)" % nev)
            else:
                print("  [FAIL] KONTROLL DID NOT FAIL (%s): passes without the mask too, the test is blind" % nev)
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
