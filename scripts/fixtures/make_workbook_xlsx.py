#!/usr/bin/env python3
"""Build a rich .xlsx fixture that exercises every BIFF record the reader must handle.

The point of the fixture is the AWKWARD cases, not the pretty ones: a string long
enough to straddle an SST CONTINUE boundary, a run of numbers that Excel packs into
MULRK, formulas whose cached result is a string / a boolean / an error, and accented
text in both the compressed and the UTF-16 encodings.
"""
import datetime as dt
import zipfile
from xml.sax.saxutils import escape

LONG = "Nagyon hosszú magyar szöveg árvíztűrő tükörfúrógép. " * 60  # ~3000 chars
# Long enough to straddle several SST CONTINUE boundaries (a BIFF record payload caps at
# 8224 bytes, and UTF-16 doubles the byte count). The ASCII twin sits next to it so a
# COMPRESSED string also has to cross a boundary, which is where the encoding flag flips.
HUGE_UTF16 = "Árvíztűrő tükörfúrógép, mérés és összehasonlítás. " * 560   # ~28 000 chars, under Excel's 32767 cell limit
HUGE_ASCII = "Plain ascii filler for the compressed branch of the reader. " * 470

# (value, kind) kinds: s=string, n=number, d=date-serial, b=bool, f=formula
HEADER = ["Azonosító", "Megnevezés", "Dátum", "Teljesítmény", "Aktív", "Hiba", "Képlet"]


def serial(d):
    return (d - dt.date(1899, 12, 30)).days


ROWS = [
    ["INV-001", "Szolnok napelempark", serial(dt.date(2026, 1, 15)), 1234.5, True, None, None],
    ["INV-002", "Kecskemét tracker", serial(dt.date(2026, 2, 29 - 1)), 987.0, False, None, None],
    ["INV-003", LONG, serial(dt.date(2026, 9, 22)), 0.125, True, None, None],
    ["INV-004", "Szolnok napelempark", serial(dt.date(2025, 12, 31)), -42.0, False, None, None],
    ["INV-005", "", serial(dt.date(2026, 6, 1)), 100.0, True, None, None],
]

CT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

WB = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Adatok" sheetId="1" r:id="rId1"/>
<sheet name="Számok" sheetId="2" r:id="rId2"/>
<sheet name="Üres" sheetId="3" r:id="rId3"/>
<sheet name="Szelek" sheetId="4" r:id="rId6"/>
</sheets>
</workbook>"""

WB_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>
</Relationships>"""

# style 1 = date (numFmtId 14), style 0 = general
STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>"""


def col_letter(i):
    out = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        out = chr(65 + r) + out
    return out


class SST:
    def __init__(self):
        self.items = []
        self.index = {}

    def add(self, s):
        if s not in self.index:
            self.index[s] = len(self.items)
            self.items.append(s)
        return self.index[s]

    def xml(self):
        body = "".join(
            '<si><t xml:space="preserve">%s</t></si>' % escape(s) for s in self.items
        )
        return (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'count="%d" uniqueCount="%d">%s</sst>' % (len(self.items), len(self.items), body)
        )


def sheet_xml(rows):
    """rows: list of list of (kind, value) with kind in s/n/d/b/f-str/f-num/f-err/None."""
    out = []
    for ri, row in enumerate(rows, start=1):
        cells = []
        for ci, cell in enumerate(row):
            if cell is None:
                continue
            kind, value = cell
            ref = "%s%d" % (col_letter(ci), ri)
            if kind == "s":
                cells.append('<c r="%s" t="s"><v>%d</v></c>' % (ref, value))
            elif kind == "n":
                cells.append('<c r="%s"><v>%s</v></c>' % (ref, repr(value)))
            elif kind == "d":
                cells.append('<c r="%s" s="1"><v>%d</v></c>' % (ref, value))
            elif kind == "dt":
                cells.append('<c r="%s" s="2"><v>%s</v></c>' % (ref, repr(value)))
            elif kind == "blank":
                cells.append('<c r="%s" s="1"/>' % ref)
            elif kind == "b":
                cells.append('<c r="%s" t="b"><v>%d</v></c>' % (ref, 1 if value else 0))
            elif kind == "fs":
                f, cached = value
                cells.append(
                    '<c r="%s" t="str"><f>%s</f><v>%s</v></c>'
                    % (ref, escape(f), escape(cached))
                )
            elif kind == "fn":
                f, cached = value
                cells.append('<c r="%s"><f>%s</f><v>%s</v></c>' % (ref, escape(f), repr(cached)))
            elif kind == "fe":
                f, cached = value
                cells.append('<c r="%s" t="e"><f>%s</f><v>%s</v></c>' % (ref, escape(f), cached))
            elif kind == "fb":
                f, cached = value
                cells.append(
                    '<c r="%s" t="b"><f>%s</f><v>%d</v></c>' % (ref, escape(f), 1 if cached else 0)
                )
        if cells:
            out.append('<row r="%d">%s</row>' % (ri, "".join(cells)))
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData>%s</sheetData></worksheet>" % "".join(out)
    )


def build(path):
    sst = SST()

    s1 = [[("s", sst.add(h)) for h in HEADER]]
    for r in ROWS:
        ident, name, date, power, active, _err, _f = r
        row = [
            ("s", sst.add(ident)),
            ("s", sst.add(name)),
            ("d", date),
            ("n", power),
            ("b", active),
            ("fe", ("1/0", "#DIV/0!")),
            ("fs", ('A%d&"-x"' % (len(s1) + 1), ident + "-x")),
        ]
        s1.append(row)
    # a deliberately blank row, then a trailing row: sparse sheets are the common case
    s1.append([])
    s1.append([("s", sst.add("VÉGE")), None, None, ("fn", ("SUM(D2:D6)", 2279.625)),
               ("fb", ("D8>0", True))])

    # Sheet2: a dense numeric grid -> Excel packs these into MULRK / MULBLANK
    s2 = []
    for r in range(1, 13):
        s2.append([("n", float(r * c) / 4.0) for c in range(1, 11)])

    # Sheet4: the cases the first fixture did NOT reach, each one a record type of its own
    s4 = [
        [("s", sst.add("eset")), ("s", sst.add("ertek"))],
        [("s", sst.add("huge utf16")), ("s", sst.add(HUGE_UTF16))],
        [("s", sst.add("huge ascii")), ("s", sst.add(HUGE_ASCII))],
        [("s", sst.add("nem RK double")), ("n", 0.1234567890123457)],
        [("s", sst.add("nagy szam")), ("n", 123456789012.345)],
        [("s", sst.add("negativ tort")), ("n", -0.0625)],
        [("s", sst.add("RK egesz")), ("n", 42.0)],
        [("s", sst.add("RK szazad")), ("n", 12.34)],
        [("s", sst.add("datum ido")), ("d", 0)],  # patched below to a fractional serial
        [("s", sst.add("stilusos ures")), ("blank", None)],
        [("s", sst.add("ures kepletszoveg")), ("fs", ('""', ""))],
        [("s", sst.add("nulla")), ("n", 0.0)],
    ]
    s4[8][1] = ("dt", serial(dt.date(2026, 3, 8)) + 0.53125)  # 12:45:00

    parts = {
        "[Content_Types].xml": CT,
        "_rels/.rels": ROOT_RELS,
        "xl/workbook.xml": WB,
        "xl/_rels/workbook.xml.rels": WB_RELS,
        "xl/styles.xml": STYLES,
        "xl/worksheets/sheet1.xml": sheet_xml(s1),
        "xl/worksheets/sheet2.xml": sheet_xml(s2),
        "xl/worksheets/sheet3.xml": sheet_xml([]),
        "xl/worksheets/sheet4.xml": sheet_xml(s4),
        "xl/sharedStrings.xml": sst.xml(),
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)
    print("written", path, "sst_unique=", len(sst.items), "longest=", max(len(s) for s in sst.items))


if __name__ == "__main__":
    import sys
    build(sys.argv[1])
