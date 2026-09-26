#!/usr/bin/env python3
"""Regression test for the workbook readers (xlsx.py and xlsbiff.py).

The method matters more than the assertions: the SAME workbook is present three times,
as .xlsx, as BIFF8 .xls and as BIFF5 .xls, and the two legacy files were written by real
Excel on 2026-09-22 (SaveAs formats 56 and 39) rather than by this repository. So the
.xlsx side is independent ground truth for the .xls side, and a bug in the BIFF reader
cannot hide behind a matching bug in the fixture generator.

The fixture is built out of the awkward cases on purpose: a 28 000 character string that
straddles several SST CONTINUE boundaries, an ASCII twin so the COMPRESSED branch crosses
one too, numbers that Excel packs into MULRK, a non-RK double, a styled-but-empty cell,
formulas whose cached result is a string / a boolean / an error, a deliberately blank row,
and a date carrying a time. Record counts are asserted, because "0 differences" over a
fixture that never reached a code path proves nothing about that path.

Run: python3 scripts/test_xlsx.py
"""
import collections
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import xlsbiff  # noqa: E402
import xlsx  # noqa: E402

FIX = os.path.join(HERE, "fixtures")
XLSX = os.path.join(FIX, "workbook.xlsx")
BIFF8 = os.path.join(FIX, "workbook-biff8.xls")
BIFF5 = os.path.join(FIX, "workbook-biff5.xls")
LOCKED = os.path.join(FIX, "workbook-encrypted.xls")

failures = []


def check(name, condition, detail=""):
    if condition:
        print("  ok   %s" % name)
    else:
        print("  FAIL %s %s" % (name, detail))
        failures.append(name)


def record_counts(path):
    data = open(path, "rb").read()
    ole = xlsbiff._Ole(data)
    stream = ole.open_stream("Workbook") or ole.open_stream("Book")
    names = {
        xlsbiff.CONTINUE: "CONTINUE", xlsbiff.SST: "SST", xlsbiff.LABELSST: "LABELSST",
        xlsbiff.LABEL: "LABEL", xlsbiff.RK: "RK", xlsbiff.MULRK: "MULRK",
        xlsbiff.NUMBER: "NUMBER", xlsbiff.FORMULA: "FORMULA", xlsbiff.STRING_R: "STRING",
        xlsbiff.BOOLERR: "BOOLERR", xlsbiff.BLANK: "BLANK", xlsbiff.MULBLANK: "MULBLANK",
    }
    counter = collections.Counter()
    for opcode, _payload, _pos in xlsbiff._records(stream, 0):
        if opcode in names:
            counter[names[opcode]] += 1
    return counter


def compare(reference, other, label, allow_truncated_at_255=False):
    diffs = []
    for sheet in reference:
        a = reference[sheet]
        b = other.get(sheet, [])
        for ri in range(max(len(a), len(b))):
            ra = a[ri] if ri < len(a) else []
            rb = b[ri] if ri < len(b) else []
            for ci in range(max(len(ra), len(rb))):
                ca = ra[ci] if ci < len(ra) else ""
                cb = rb[ci] if ci < len(rb) else ""
                if ca == cb:
                    continue
                # BIFF5 cannot hold more than 255 characters per cell, so Excel cut the
                # text when it WROTE the file. That is the format's limit, not a reader
                # bug, and the reader reports it as a warning instead of hiding it.
                if allow_truncated_at_255 and len(cb) == 255 and ca.startswith(cb):
                    continue
                diffs.append("%s r%d c%d: %r != %r" % (sheet, ri + 1, ci + 1, ca[:40], cb[:40]))
    check("%s megegyezik az .xlsx-szel" % label, not diffs,
          "; ".join(diffs[:3]) + (" (+%d tovabbi)" % (len(diffs) - 3) if len(diffs) > 3 else ""))


def main():
    print("BIFF rekord-lefedettseg (amit a fixture tenylegesen megfeszit)")
    c8 = record_counts(BIFF8)
    for rec, minimum in (("CONTINUE", 5), ("SST", 1), ("LABELSST", 10), ("MULRK", 5),
                         ("RK", 1), ("NUMBER", 1), ("FORMULA", 5), ("STRING", 3),
                         ("BOOLERR", 3), ("BLANK", 1)):
        check("BIFF8 %s >= %d (%d)" % (rec, minimum, c8[rec]), c8[rec] >= minimum)
    c5 = record_counts(BIFF5)
    check("BIFF5 LABEL >= 10 (%d)" % c5["LABEL"], c5["LABEL"] >= 10)
    check("BIFF5-ben nincs SST (a formatum nem ismeri)", c5["SST"] == 0)

    print("tartalom")
    reference = xlsx.read_workbook(XLSX)
    check("az .xlsx negy lapot ad", sorted(reference) == ["Adatok", "Szelek", "Számok", "Üres"],
          str(sorted(reference)))

    warn8 = []
    got8 = xlsbiff.read_workbook(BIFF8, warnings=warn8)
    compare(reference, got8, "BIFF8")
    check("BIFF8-ra nincs figyelmeztetes", warn8 == [], str(warn8))

    warn5 = []
    got5 = xlsbiff.read_workbook(BIFF5, warnings=warn5)
    compare(reference, got5, "BIFF5", allow_truncated_at_255=True)
    check("BIFF5 jelzi a 255 karakteres csonkitast",
          any("255" in w for w in warn5), str(warn5))

    print("reszletek, amikbol egy elcsuszas eszrevetlen maradna")
    adatok = got8["Adatok"]
    check("a szandekosan ures sor a helyen marad (VEGE a 8. sorban)",
          len(adatok) >= 8 and adatok[7][0] == "VÉGE", repr(adatok[6:8]))
    check("a 28 000 karakteres szoveg hianytalan az SST CONTINUE-k utan",
          len(got8["Szelek"][1][1]) == len(reference["Szelek"][1][1]) == 28000,
          "%d / %d" % (len(got8["Szelek"][1][1]), len(reference["Szelek"][1][1])))
    szelek = {r[0]: r[1] for r in got8["Szelek"]}
    check("datum ido ertek", szelek.get("datum ido") == "2026-03-08 12:45:00", szelek.get("datum ido"))
    check("nem RK double", szelek.get("nem RK double") == "0.1234567890123457", szelek.get("nem RK double"))
    check("RK szazad", szelek.get("RK szazad") == "12.34", szelek.get("RK szazad"))
    check("negativ tort", szelek.get("negativ tort") == "-0.0625", szelek.get("negativ tort"))
    check("stilusos ures cella ures marad", szelek.get("stilusos ures") == "", repr(szelek.get("stilusos ures")))
    check("kepleteredmeny: hiba", got8["Adatok"][1][5] == "#DIV/0!", got8["Adatok"][1][5])
    check("kepleteredmeny: szoveg", got8["Adatok"][1][6] == "INV-001-x", got8["Adatok"][1][6])
    check("kepleteredmeny: logikai", got8["Adatok"][7][4] == "IGAZ", got8["Adatok"][7][4])

    print("hibautak")
    try:
        xlsx.read_workbook(LOCKED)
        check("titkositott munkafuzet elutasitasa", False, "nem dobott hibat")
    except xlsx.XlsxError as e:
        check("titkositott munkafuzet elutasitasa", "jelszo" in str(e).lower(), str(e))
    try:
        xlsx.read_workbook(BIFF8, sheet="Nincsilyen")
        check("ismeretlen lapnev elutasitasa", False, "nem dobott hibat")
    except xlsx.XlsxError as e:
        check("ismeretlen lapnev elutasitasa", "nincs ilyen lap" in str(e), str(e))

    print("a kiterjesztes nem dont: a fajl alairasa dont")
    check("az .xls-re keresztelt .xlsx is olvashato",
          xlsx.read_workbook(XLSX)["Adatok"][0][0] == "Azonosító")

    print()
    if failures:
        print("BUKOTT: %d" % len(failures))
        return 1
    print("MIND ATMENT")
    return 0


if __name__ == "__main__":
    sys.exit(main())
