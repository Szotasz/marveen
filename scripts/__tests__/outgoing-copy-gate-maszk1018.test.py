#!/usr/bin/env python3
"""Test the EKEZETMASZK1018 identifier mask of scripts/hooks/outgoing-copy-gate.py.

The class the three EKEZET1018 review rounds kept hitting: a dictionary word matched in a place that is not Hungarian
prose. Uses an accent-dictionary word that was in the dictionary before EKEZET1018 ('reszletek' -> 'részletek'),
so it measures the mask, not the dictionary extension.
  M1  '#reszletek' (anchor / hashtag)            in a correctly accented Hungarian message: passes (exit 0)
  M2  '--reszletek' (command-line flag)          : passes
  M3  'a /reszletek/ lap' (path after a space)   : passes
  M4  'reszletek.md' (file name)                 : passes   (already masked before EKEZETMASZK1018)
  M5  '`reszletek`' (inline code)                : passes   (already masked before)
  P1  'a reszletek lent' (the same word in prose): BLOCKED by the accent rule, the word named
  P2  a prose dash ' -- ' is still reported by the double-hyphen rule ('DUPLA KOTOJEL' in the output). Background, not
      measured by P2: the double-hyphen count runs on the strip_technical() output, before strip_for_accent(), so the
      flag branch cannot affect it.
  P3  'A lap címe /kapcsolat. Reszletek ...': the path branch does not swallow the sentence-final period, so the next
      sentence's capitalised first word is still checked and blocked
  S1  the three branches are in the separate _ACCENT_ONLY mask;
  S2  TECHNICAL (used by the homoglyph rule and the double-hyphen count) and NAME_MASK do not contain them: checked on
      the _TECH_COMMON/_TECH_SUFFIXED source strings AND on the compiled TECHNICAL.pattern / NAME_MASK.pattern of the
      loaded hook; S2b behaviourally, strip_technical() and strip_for_name() leave '#reszletek', '--reszletek' and
      '/reszletek/' in place (a NAME_MASK built from _ACCENT_ONLY would have passed the string check);
  S3  the KONTROLL mutant anchor (strip_for_accent's return line) occurs exactly once in the hook
  L1-L4 tested limits of this mask (KAPUMARADEK1018). L1-L3 each have a backtick counterpart:
      L1  a CSS class ('a .reszletek mező') is not masked: BLOCKED; 'a `.reszletek` mező' passes
      L2  an @handle ('a @reszletek mező') is not masked: BLOCKED; 'a `@reszletek` mező' passes
      L3  a shell variable ('a $reszletek mező') is not masked: BLOCKED; 'a `$reszletek` mező' passes
      L4  a word glued after a prose dash ('kész --reszletek') is masked by the flag branch and passes. It is accepted because
          one-word flags that are also dictionary words are common in tool commands (on one install, 17 of 203);
          this test does not measure that number. It has no backtick counterpart; KONTROLL runs it on the mask-less
          copy too, where it must be BLOCKED, and KONTROLL-AG ties it to the flag branch.
  Pass expectations use atment(): exit 0 and no FAIL-OPEN / internal-error marker in the output (the Telegram path
  lets a message through with exit 0 on an internal error). Block expectations of the accent rule use tiltva(): exit 2,
  'HIANYZO EKEZETEK' and 'szo ->' in the output.
  H1-H3 a Cyrillic homoglyph inside '#...', '--...' and '/.../' is still blocked by the homoglyph rule
KONTROLL: M1-M3 and L4 re-run against a copy of the hook whose strip_for_accent() returns its input unchanged, in a
temporary directory with scripts/lib and hooks/email_extract.py symlinked next to it; each must now be BLOCKED (a
'KONTROLL-BUKOTT' line per case), else that case is blind.
KONTROLL-AG: one copy per branch of _ACCENT_ONLY, with only that branch made never-matching; on each
copy exactly the cases of that branch are BLOCKED and the others still pass (hash: M1, flag: M2 and L4, path: M3).
A copy that crashes (Traceback), exits with anything but 0/2, or goes through the FAIL-OPEN path (the Telegram path
catches an internal error and exits 0 with 'FAIL-OPEN', without a Traceback) is 'not measurable' and a FAIL. The temporary directory is created and
used inside try/finally; a directory left behind after the in-process cleanup is a FAIL (a killed test process skips
the finally block).
Run: python3 scripts/__tests__/outgoing-copy-gate-maszk1018.test.py   (exit 0 = the listed checks passed, 1 = a failure)
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
AGAK = ["\\#[\\w-]+", "--[A-Za-z]", "/[\\w-]+(?:[./][\\w-]+)*/?"]   # a harom uj ag jellemzo darabja
MUTANS_REGI = '    return ACCENT_MASK.sub(" ", prose)\n'
MUTANS_UJ = '    return prose\n'
# KONTROLL-AG: az _ACCENT_ONLY agai (a forrasban pontosan egyszer), es az esetek, amelyeket egyedul ez az ag takar
AG_MINTAK = {
    "horgony": (r"(?<![\w&])\#[\w-]+", {"M1"}),
    "kapcsolo": (r"(?<![\w-])--[A-Za-z][\w-]*", {"M2", "L4"}),
    "ut": (r"(?<![\w/])/[\w-]+(?:[./][\w-]+)*/?", {"M3"}),
}
SOHA = r"(?!x)x"

CIR_O = "\u043e"   # cirill o, homoglifa
ELEJE = "Szia! Holnap reggel átnézem, "
VEGE = ", és küldöm a választ. Köszönöm szépen."
ESETEK = {
    "M1": ELEJE + "a #reszletek szakasz is jó" + VEGE,
    "M2": ELEJE + "a --reszletek kapcsolóval futtatva" + VEGE,
    "M3": ELEJE + "a /reszletek/ lap is rendben" + VEGE,
    "M4": ELEJE + "a reszletek.md fájl is megvan" + VEGE,
    "M5": ELEJE + "a `reszletek` mező is megvan" + VEGE,
}
FAILS = []
L4_SZOVEG = ELEJE + "kész --reszletek holnap" + VEGE


def atment(kod, kimenet):
    """0-s kilepes, es nem a FAIL-OPEN ag engedte at (a Telegram-ag belso hibanal 0-val enged at)."""
    return kod == 0 and "FAIL-OPEN" not in kimenet and "belso hiba" not in kimenet


def tiltva(kod, kimenet, szo):
    """Az ekezet-szabaly tiltott, es a hianyzo szot nevezi ('szo ->')."""
    return kod == 2 and "HIANYZO EKEZETEK" in kimenet and (szo + " ->") in kimenet


def check(nev, ok, reszlet=""):
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", nev, "" if ok or not reszlet else " (%s)" % reszlet[:300]))
    if not ok:
        FAILS.append(nev)


def run(hook, text):
    p = subprocess.run([sys.executable, hook], input=json.dumps(
        {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": {"text": text}}),
        capture_output=True, text=True, timeout=30, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    return p.returncode, p.stdout + p.stderr


def merhetetlen(kod, kimenet):
    """A mutans futasa nem ertekelheto: osszeomlott, nem 0/2-vel lepett ki, vagy a FAIL-OPEN ag engedte at."""
    return "Traceback" in kimenet or kod not in (0, 2) or "FAIL-OPEN" in kimenet or "belso hiba" in kimenet


def modul():
    sys.dont_write_bytecode = True   # mint a run() PYTHONDONTWRITEBYTECODE-ja: a teszt ne irjon __pycache__-t
    spec = importlib.util.spec_from_file_location("maszk1018_gate", HOOK)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    src = open(HOOK, encoding="utf-8").read()
    acc = re.search(r'^_ACCENT_ONLY = r"""(.*?)"""', src, re.S | re.M)
    tech = re.search(r'^_TECH_COMMON = r"""(.*?)"""', src, re.S | re.M).group(1) + \
        re.search(r'^_TECH_SUFFIXED = r"""(.*?)"""', src, re.S | re.M).group(1)
    check("S1 a harom ag a kulon _ACCENT_ONLY maszkban van", acc is not None and all(a in acc.group(1) for a in AGAK))
    check("S2 a TECHNICAL (homoglifa, dupla kotojel) es a NAME_MASK forrasa nem tartalmazza oket",
          not any(a in tech for a in AGAK))
    g = modul()
    check("S2 a lefordított TECHNICAL.pattern es NAME_MASK.pattern sem tartalmazza oket",
          not any(a in g.TECHNICAL.pattern or a in g.NAME_MASK.pattern for a in AGAK))
    minta = "a #reszletek, a --reszletek es a /reszletek/ is"
    check("S2b a strip_technical() es a strip_for_name() a harom alakot meghagyja",
          g.strip_technical(minta).count("reszletek") == 3 and g.strip_for_name(minta).count("reszletek") == 3,
          "%r / %r" % (g.strip_technical(minta), g.strip_for_name(minta)))
    check("S3 a mutans-horgony pontosan egyszer szerepel", src.count(MUTANS_REGI) == 1)

    for nev, szoveg in ESETEK.items():
        kod, ki = run(HOOK, szoveg)
        check("%s azonositoban a szotar szava nem riaszt (0)" % nev, atment(kod, ki), ki)

    kod, ki = run(HOOK, ELEJE + "a reszletek lent vannak" + VEGE)
    check("P1 ugyanaz a szo folyoszovegben: az ekezet-szabaly tiltja, es megnevezi", tiltva(kod, ki, "reszletek"), ki)

    kod, ki = run(HOOK, "Szia! Holnap átnézem -- és küldöm a választ. Köszönöm szépen.")
    check("P2 a proza ' -- ' tovabbra is a dupla-kotojel szabalyba utkozik (2)", kod == 2 and "DUPLA KOTOJEL" in ki, ki)

    kod, ki = run(HOOK, "Szia! A lap címe /kapcsolat. Reszletek holnap jönnek, köszönöm szépen.")
    check("P3 az ut utani mondatzaro pont nem nyelodik el: a kovetkezo mondatkezdo szo tiltva (2)",
          tiltva(kod, ki, "reszletek"), ki)

    # L1-L3: ezeket az alakokat ez a maszk nem takarja; backtickben a kod-span maszk takarja
    for nev, tok in (("L1", ".reszletek"), ("L2", "@reszletek"), ("L3", "$reszletek")):
        kod, ki = run(HOOK, ELEJE + "a %s mező is megvan" % tok + VEGE)
        check("%s ISMERT HATAR, a '%s' nincs maszkolva: tiltva (2)" % (nev, tok), tiltva(kod, ki, "reszletek"), ki)
        kod, ki = run(HOOK, ELEJE + "a `%s` mező is megvan" % tok + VEGE)
        check("%s backtickben ('`%s`') atmegy (0)" % (nev, tok), atment(kod, ki), ki)
    kod, ki = run(HOOK, L4_SZOVEG)
    check("L4 ISMERT HATAR, a proza-kotojelhez tapado szot a kapcsolo-ag maszkolja: atmegy (0)",
          atment(kod, ki), ki)

    for nev, tok in (("H1", "#f%sglalas" % CIR_O), ("H2", "--f%sglalas" % CIR_O), ("H3", "/f%sglalas/" % CIR_O)):
        kod, ki = run(HOOK, "Szia! Holnap átnézem a %s részt is, és küldöm a választ. Köszönöm szépen." % tok)
        check("%s homoglifa a '%s' tokenben: tovabbra is tiltva (2), a homoglifa-szabaly fogja" % (nev, tok[:2]),
              kod == 2 and "nem-latin" in ki, ki)

    # KONTROLL: a harom ag nelkuli kapu (strip_for_accent valtozatlanul adja vissza) az M1-M3-at es az L4-et blokkolja.
    # KAPUMARADEK1018: a mappa letrehozasa, feltoltese es hasznalata a try-on belul; a takaritas utan megmaradt mappa FAIL.
    tmp = tempfile.mkdtemp(prefix="maszk1018-mutans-")
    try:
        hooks = os.path.join(tmp, "scripts", "hooks")
        os.makedirs(hooks)
        os.symlink(os.path.join(os.path.dirname(os.path.dirname(HOOK)), "lib"), os.path.join(tmp, "scripts", "lib"))
        os.symlink(os.path.join(os.path.dirname(HOOK), "email_extract.py"), os.path.join(hooks, "email_extract.py"))
        mutans = os.path.join(hooks, "outgoing-copy-gate.py")
        with open(mutans, "w", encoding="utf-8") as fh:
            fh.write(src.replace(MUTANS_REGI, MUTANS_UJ, 1))
        kontroll_esetek = (("M1", ESETEK["M1"]), ("M2", ESETEK["M2"]), ("M3", ESETEK["M3"]), ("L4", L4_SZOVEG))
        for nev, szoveg in kontroll_esetek:
            kod, ki = run(mutans, szoveg)
            if merhetetlen(kod, ki):
                print("  [FAIL] KONTROLL NEM MERHETO (%s): a mutans kapu nem futott rendben (kilepes %d)" % (nev, kod))
                FAILS.append("kontroll-%s" % nev)
            elif tiltva(kod, ki, "reszletek"):
                print("KONTROLL-BUKOTT: %s-maszk-nelkul (tiltva, ahogy kell)" % nev)
            else:
                print("  [FAIL] A KONTROLL NEM BUKOTT (%s): a maszk nelkul is atment -- a teszt vak" % nev)
                FAILS.append("kontroll-%s" % nev)
        # KONTROLL-AG: agankent egy mutans; csak az ag sajat esetei buknak
        for ag, (minta_ag, sajat) in AG_MINTAK.items():
            if src.count(minta_ag) != 1:
                print("  [FAIL] KONTROLL-AG NEM MERHETO (%s): az ag mintaja nem pontosan egyszer szerepel" % ag)
                FAILS.append("kontroll-ag-%s" % ag)
                continue
            with open(mutans, "w", encoding="utf-8") as fh:
                fh.write(src.replace(minta_ag, SOHA, 1))
            for nev, szoveg in kontroll_esetek:
                kod, ki = run(mutans, szoveg)
                if merhetetlen(kod, ki):
                    print("  [FAIL] KONTROLL-AG NEM MERHETO (%s, %s): kilepes %d" % (ag, nev, kod))
                    FAILS.append("kontroll-ag-%s-%s" % (ag, nev))
                elif nev in sajat and not tiltva(kod, ki, "reszletek"):
                    print("  [FAIL] A KONTROLL-AG NEM BUKOTT (%s, %s): az ag nelkul is atment" % (ag, nev))
                    FAILS.append("kontroll-ag-%s-%s" % (ag, nev))
                elif nev not in sajat and not atment(kod, ki):
                    print("  [FAIL] KONTROLL-AG (%s, %s): egy MASIK ag esete is bukott -- nem ez az ag takarja" % (ag, nev))
                    FAILS.append("kontroll-ag-%s-%s" % (ag, nev))
                elif nev in sajat:
                    print("KONTROLL-AG-BUKOTT: %s-ag nelkul a(z) %s tiltva" % (ag, nev))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        if os.path.exists(tmp):
            print("  [FAIL] az ideiglenes mappa nem torolheto: %s" % tmp)
            FAILS.append("tmp-szivargas")

    print("ITELET: %s" % ("a felsorolt esetek a vartak" if not FAILS else "%d eset elter: %s" % (len(FAILS), FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
