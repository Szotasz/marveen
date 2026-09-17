#!/usr/bin/env python3
"""Test the owner-CC default of scripts/support-mail/send.py (SUPPCCDEF917).

A CLAUDE.md kimondja, hogy MINDEN kimeno levelnek CC-znie kell a gazdat, kivetel
nelkul. Ez a szabaly sokaig CSAK PROZABAN letezett: a `--cc` opcionalis volt,
default None. Mert eset 2026-09-14: negy Comline-levelbol HAROM CC nelkul ment ki,
ezert a gazda a sajat postaladajaban nem latta a megoldast, es ugy jelezte vissza,
mintha az ugy meg allna. Nem a szabaly volt rossz, hanem hogy nem volt KODUTBA kotve.

A teszt az argumentum-feloldast meri, NEM kuld levelet: a send.py main()-je
halozatot nyitna, ezert a parser-agat kulon epitjuk fel ugyanazokkal a
definiciokkal, es a FORRASBOL allitjuk, hogy azok tenyleg ezek.

Run:  python3 scripts/__tests__/support-mail-owner-cc.test.py
"""
import os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SEND = os.path.join(ROOT, 'scripts', 'support-mail', 'send.py')
FAILS = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def main():
    src = open(SEND, encoding='utf-8').read()

    # 1. A default a gazda cime, nem None. Ez a lenyeg: ha valaki visszaallitja
    #    `default=None`-ra, ez a sor bukik.
    check('a --cc defaultja a gazda-cim, nem None',
          re.search(r'ap\.add_argument\(\s*"--cc"\s*,\s*default=OWNER_CC', src) is not None)
    check('OWNER_CC a gazda cimere all',
          'szota.szabolcs@gmail.com' in src and 'OWNER_CC' in src)

    # 2. Van KIMONDOTT lemondas, es csak az kapcsolja ki.
    check('letezik --no-owner-cc kapcsolo', '--no-owner-cc' in src)
    check('a lemondas CSAK a default erteket ejti ki',
          re.search(r'if a\.no_owner_cc and a\.cc == OWNER_CC', src) is not None,
          'enelkul egy KIMONDOTT --cc-t is eldobna')

    # 3. A kimenet MONDJA KI, ha CC nelkul ment. Enelkul a hianyzo CC nema.
    check('a kimenet jelzi a CC nelkuli kuldest', 'CC NELKUL' in src)

    # 4. Funkcionalis: a parser ugyanazokkal a definiciokkal a vart erteket adja.
    #    KIMONDOTT HATAR: ez a harom allitas a LOGIKA ALAKJAT meri, nem a szallitott
    #    fajlt -- egy kulon epitett parseren fut, tehat egy visszaallitott send.py
    #    mellett is ZOLD maradna. A fajlhoz az 1-3. pont forras-allitasai kotik a
    #    tesztet, es a mutacios kontrollban PONTOSAN azok az otok buknak. Ezt azert
    #    irom ide, mert egy 'funkcionalis' cimke enelkul tobbet igerne, mint amit mer.
    prog = (
        'import argparse\n'
        'OWNER_CC = "szota.szabolcs@gmail.com"\n'
        'ap = argparse.ArgumentParser()\n'
        'ap.add_argument("--to", required=True)\n'
        'ap.add_argument("--subject", required=True)\n'
        'ap.add_argument("--cc", default=OWNER_CC)\n'
        'ap.add_argument("--no-owner-cc", action="store_true")\n'
        'a = ap.parse_args()\n'
        'if a.no_owner_cc and a.cc == OWNER_CC: a.cc = None\n'
        'print(repr(a.cc))\n'
    )

    def run(args):
        r = subprocess.run([sys.executable, '-c', prog, *args], capture_output=True, text=True, timeout=20)
        return r.stdout.strip()

    base = ['--to', 'x@y.hu', '--subject', 's']
    check('CC nelkul hivva a gazda cime jon', run(base) == repr('szota.szabolcs@gmail.com'),
          run(base))
    check('--no-owner-cc eseten None', run(base + ['--no-owner-cc']) == repr(None),
          run(base + ['--no-owner-cc']))
    check('KIMONDOTT --cc-t a --no-owner-cc NEM ejti ki',
          run(base + ['--cc', 'masik@ceg.hu', '--no-owner-cc']) == repr('masik@ceg.hu'),
          run(base + ['--cc', 'masik@ceg.hu', '--no-owner-cc']))

    if FAILS:
        print(f"\n{len(FAILS)} FAILED: {FAILS}", file=sys.stderr)
        sys.exit(1)
    print("\nOK: 8 allitas, mind zold.")


if __name__ == '__main__':
    main()
