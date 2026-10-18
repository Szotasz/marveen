#!/usr/bin/env python3
"""Pin the KAPUES1018 documented limit of scripts/hooks/outgoing-copy-gate.py.

The limit, for the listed texts only: a Hungarian text with fewer than 3 distinct HU markers and no unambiguous accentless
dictionary word passes with an accentless 'es', because 'es' is in AMBIGUOUS_TRIGGER and cannot start the accent audit
on its own. A fix was rejected after three review rounds (it blocked foreign customer text quoting Hungarian names).
  H1  'Örülünk, hogy jöttök, es nem sietünk.' (2 markers): passes (exit 0) -- the KNOWN LIMIT. If this check fails,
      the gate changed: update the KNOWN LIMIT comment above AMBIGUOUS_TRIGGER as well.
  H2  the same with 'már' (3rd marker): blocked for missing accents, naming 'es' -- the audit itself works.
  H3  H1 with the correct 'és': passes.
KONTROLL: H1 is re-run on a copy of the hook whose AMBIGUOUS_TRIGGER lacks only "es"; the copy must block it naming
'es', otherwise H1 does not show what the comment says causes the pass. The copy runs in a temporary directory with
scripts/lib and hooks/email_extract.py symlinked next to it; a copy that crashes, exits with anything but 0/2 or goes
through the FAIL-OPEN path is reported as not measurable; a temporary directory left after cleanup is a FAIL. Pass
checks also require no FAIL-OPEN / internal-error marker.
Run: python3 scripts/__tests__/outgoing-copy-gate-kapues1018-hatar.test.py   (exit 0 = all pass, 1 = a failure)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
HOOK = os.path.join(HOOKS, "outgoing-copy-gate.py")
H1 = "Örülünk, hogy jöttök, es nem sietünk."
H2 = "Örülünk, hogy már jöttök, es nem sietünk."
ES_SOR = '    "es", "ar", "arak",'
ES_NELKUL = '    "ar", "arak",'
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


def fail_open(ki):
    return "FAIL-OPEN" in ki or "belso hiba" in ki


def atment(kod, ki):
    return kod == 0 and not fail_open(ki)


def es_blokk(kod, ki):
    return kod == 2 and "HIANYZO EKEZETEK" in ki and re.search(r"(?:: |, )es -> ", ki) is not None


def main():
    src = open(HOOK, encoding="utf-8").read()
    kod, ki = run(HOOK, H1)
    check("H1 ISMERT HATAR: 2 markeres rovid magyar szoveg ekezetlen 'es'-sel atmegy (0)", atment(kod, ki), ki)
    kod, ki = run(HOOK, H2)
    check("H2 a 3. markerrel ('már') ugyanez tiltva, a kimenet megnevezi az 'es'-t", es_blokk(kod, ki), ki)
    h3 = H1.replace(" es ", " és ")
    kod, ki = run(HOOK, h3)
    check("H3 helyes 'és'-sel atmegy (0)", h3 != H1 and atment(kod, ki), ki)

    if src.count(ES_SOR) != 1:
        print("  [FAIL] A KONTROLL NEM MERHETO: az AMBIGUOUS_TRIGGER 'es' sora nem talalhato pontosan egyszer")
        FAILS.append("kontroll-merhetetlen")
    else:
        tmp = tempfile.mkdtemp(prefix="kapues1018-hatar-")
        try:
            hooks = os.path.join(tmp, "scripts", "hooks")
            os.makedirs(hooks)
            os.symlink(os.path.join(os.path.dirname(HOOKS), "lib"), os.path.join(tmp, "scripts", "lib"))
            os.symlink(os.path.join(HOOKS, "email_extract.py"), os.path.join(hooks, "email_extract.py"))
            mutans = os.path.join(hooks, "outgoing-copy-gate.py")
            with open(mutans, "w", encoding="utf-8") as fh:
                fh.write(src.replace(ES_SOR, ES_NELKUL))
            kod, ki = run(mutans, H1)
            if "Traceback" in ki or kod not in (0, 2) or fail_open(ki):
                print("  [FAIL] A KONTROLL NEM MERHETO: a mutans kapu nem futott rendben (kilepes %d)" % kod)
                FAILS.append("kontroll-merhetetlen")
            elif es_blokk(kod, ki):
                print("KONTROLL-BUKOTT: 'es' nelkul az AMBIGUOUS_TRIGGER-ben a H1 tiltva (kilepes %d)" % kod)
            else:
                print("  [FAIL] A KONTROLL NEM BUKOTT: 'es' nelkul is atmegy -- a H1 nem az 'es'-t meri (%s)" % ki[:200])
                FAILS.append("kontroll")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            if os.path.exists(tmp):
                print("  [FAIL] az ideiglenes mappa nem torolheto: %s" % tmp)
                FAILS.append("tmp-szivargas")

    print("ITELET: %s" % ("minden eset a vart" if not FAILS else "%d eset elter: %s" % (len(FAILS), FAILS)))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
