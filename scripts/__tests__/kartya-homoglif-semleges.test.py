#!/usr/bin/env python3
"""Test the homoglyph filter of scripts/kartya-es-ertesites.py on unit notation (HOMOGLYPHMICRO924).

Merve 2026-09-24: a kartya-eszkoz cim-kapuja a "40 us" alakot (MICRO SIGN, U+00B5)
vegyes irasrendszeru szonak vette es megtagadta. A MICRO SIGN betu-kategoriaju, de
mertekegyseg-elotag, latin betut nem alcaz. A kimeno-szoveg kapu (outgoing-copy-gate.py)
ugyanezt a hibat SCRIPT_NEUTRAL-lal javitja; ez a teszt a kartya-eszkoz parjat rogziti.

Amit ALLIT:
  1. a MICRO SIGN egy latin szoban NEM gyanus;
  2. a valodi homoglifa (cirill a, KELVIN SIGN) tovabbra is gyanus;
  3. a MICRO SIGN nem vedi ki a mellette allo cirill betut ugyanabban a szoban;
  4. a magyar ekezetes szo nem gyanus (nincs uj hamis pozitiv, nincs visszalepes).

Run:  python3 scripts/__tests__/kartya-homoglif-semleges.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
FAILS = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


spec = importlib.util.spec_from_file_location('kartya', SCRIPT)
kartya = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kartya)

# Kodpontbol epitve, hogy a fajl ne hordozzon szo szerinti hasonmast.
MICRO, CYR_A, KELVIN = '\u00b5', '\u0430', '\u212a'

check('MICRO SIGN egy latin szoban nem gyanus', kartya.gyanus(f'p95 kesleltetes 40 {MICRO}s') == [],
      repr(kartya.gyanus(f'40 {MICRO}s')))
check('cirill a egy latin szoban gyanus', kartya.gyanus(f'k{CYR_A}rtya') != [])
check('KELVIN SIGN egy latin szoban gyanus', kartya.gyanus(f'{KELVIN}elvin') != [])
hit = kartya.gyanus(f'40 {MICRO}s{CYR_A}')
check('a MICRO SIGN nem vedi ki a mellette allo cirill betut', hit != [] and 'U+0430' in hit[0], repr(hit))
check('magyar ekezetes szo nem gyanus', kartya.gyanus('Árvíztűrő tükörfúrógép') == [])

if FAILS:
    sys.stderr.write(f'{len(FAILS)} FAIL: {FAILS}\n')
    sys.exit(1)
print('ALL PASS')
