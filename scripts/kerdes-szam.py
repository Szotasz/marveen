#!/usr/bin/env python3
"""Folyamatos, NAPONKENT ujrainduló kerdes-sorszam Lacinak feltett kerdesekhez.

Laci allo szabalya (2026-09-23, Telegram 1412): "egy nap egy lista legyen 1-tol
kezdve nap vegeig folyamatos szamozassal". Az indok az ove, es mert: ha nem
valaszol azonnal, a kulon-kulon szamozott listak valaszai OSSZEKEVEREDNEK.
2026-09-23-an pontosan ez tortent: ket kulon 1-tol indulo lista futott
parhuzamosan, es a "2, 3, 4, 5 nem relevans" mindkettore illett volna.

Hasznalat:
  python3 scripts/kerdes-szam.py uj "A kerdes szovege"   -> kiirja a sorszamot, rogziti
  python3 scripts/kerdes-szam.py lista                    -> a mai kerdesek, allapottal
  python3 scripts/kerdes-szam.py valasz <szam> "valasz"   -> megjeloli megvalaszoltkent
  python3 scripts/kerdes-szam.py nyitott                  -> csak a megvalaszolatlanok

A szamlalo a DATUM valtasakor indul ujra 1-rol. A tarolo napokra bontva orzi a
tortenetet, tehat egy tegnapi szam sem vesz el.
"""
import json, sys, os
from datetime import datetime

STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "store")
PATH = os.path.join(STORE, "kerdes-szamlalo.json")


def load():
    if os.path.exists(PATH):
        with open(PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save(d):
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, PATH)


def today():
    return datetime.now().strftime("%Y-%m-%d")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    d = load()
    nap = d.setdefault(today(), [])

    if cmd == "uj":
        if len(sys.argv) < 3:
            print("hianyzik a kerdes szovege"); return 2
        szam = len(nap) + 1
        nap.append({"szam": szam, "kerdes": sys.argv[2],
                    "idopont": datetime.now().strftime("%H:%M"),
                    "valasz": None})
        save(d)
        print(szam)
        return 0

    if cmd == "valasz":
        if len(sys.argv) < 4:
            print("hasznalat: valasz <szam> \"valasz\""); return 2
        szam = int(sys.argv[2])
        for k in nap:
            if k["szam"] == szam:
                k["valasz"] = sys.argv[3]
                k["valasz_idopont"] = datetime.now().strftime("%H:%M")
                save(d)
                print(f"{szam}. megvalaszolva")
                return 0
        print(f"nincs {szam}. kerdes a mai listan"); return 1

    if cmd in ("lista", "nyitott"):
        if not nap:
            print("ma meg nem kerdeztem semmit"); return 0
        for k in nap:
            if cmd == "nyitott" and k["valasz"] is not None:
                continue
            jel = "NYITOTT" if k["valasz"] is None else "megvalaszolva"
            print(f"{k['szam']:3}. [{k['idopont']}] {jel}: {k['kerdes']}")
            if k["valasz"]:
                print(f"      -> {k['valasz']}")
        return 0

    print(f"ismeretlen parancs: {cmd}"); return 2


if __name__ == "__main__":
    sys.exit(main())
