#!/usr/bin/env python3
"""Excel reader and differ for this installation.

Why it is written by hand: measured 2026-09-22, this machine has no openpyxl, xlrd,
pandas, pyexcel or odf, and no libreoffice/xlsx2csv/in2csv/ssconvert either. An .xlsx
is a ZIP of XML parts, so the standard library is enough and nothing needs installing.

Legacy binary .xls is a different format entirely (an OLE2 container holding a BIFF
record stream) and lives in xlsbiff.py; this module dispatches to it on the file's own
signature, not on the extension, so a mislabelled file is still read correctly. The host
is Windows with Office installed, but Excel COM automation was measured from WSL on
2026-09-22 and rejected for the runtime path: it worked once, then returned
RPC_E_CALL_REJECTED repeatedly and left Excel processes behind, which made the NEXT run
look like a failure. A scheduled agent must not depend on that.

Usage:
  python3 scripts/xlsx.py read <file> [--sheet NAME] [--format json|csv] [--include-hidden]
  python3 scripts/xlsx.py diff <old> <new> [--key COLUMN] [--sheet NAME]

Both commands take .xlsx and .xls, and diff may mix the two.
"""
import argparse
import csv
import datetime as dt
import json
import re
import sys
import os
import zipfile
from xml.etree import ElementTree as ET

try:
    import xlsbiff
except ImportError:  # imported from outside scripts/, e.g. by a scheduled task elsewhere
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import xlsbiff

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

# Built-in number formats that mean "this number is a date or a time".
BUILTIN_DATE_IDS = set(range(14, 23)) | set(range(45, 48)) | {27, 30, 36, 50, 57}


class XlsxError(RuntimeError):
    pass


def _q(tag):
    return "{%s}%s" % (NS_MAIN, tag)


def _col_index(ref):
    """'BC12' -> 54 (zero-based column). Cells may be sparse, so this is how a row is placed."""
    letters = re.match(r"([A-Z]+)", ref or "")
    if not letters:
        return None
    n = 0
    for ch in letters.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _col_letter(idx):
    """0 -> 'A', 26 -> 'AA'. Csak megjelenitesre, hogy nevtelen oszlop is azonosithato legyen."""
    out = ""
    idx += 1
    while idx:
        idx, rem = divmod(idx - 1, 26)
        out = chr(65 + rem) + out
    return out


def _serial_to_text(value, is_datetime):
    """Excel stores dates as days since 1899-12-30. Without this a deadline reads as 46023.

    Verified against two anchors on 2026-09-22: serial 44927 -> 2023-01-01 and 46023 ->
    2026-01-01, both correct. Serials below 61 come out one day early, because Excel itself
    treats 1900 as a leap year and this offset does not reproduce that bug. That only affects
    dates before 1900-03-01, which no O&M record carries, so it is left as is rather than
    silently patched.
    """
    if not is_datetime:
        return _num_to_text(value)
    try:
        days = float(value)
    except (TypeError, ValueError):
        return str(value)
    base = dt.datetime(1899, 12, 30)
    try:
        stamp = base + dt.timedelta(days=days)
    except OverflowError:
        return _num_to_text(value)
    if days < 1:  # time of day only
        return stamp.strftime("%H:%M:%S")
    if abs(days - int(days)) < 1e-9:
        return stamp.strftime("%Y-%m-%d")
    return stamp.strftime("%Y-%m-%d %H:%M:%S")


def _num_to_text(value):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return "" if value is None else str(value)
    if f == int(f) and abs(f) < 1e15:
        return str(int(f))
    return repr(f)


def _shared_strings(z):
    try:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    out = []
    for si in root.findall(_q("si")):
        # A string can be split into many runs (<r><t>); join them or formatting eats words.
        out.append("".join(t.text or "" for t in si.iter(_q("t"))))
    return out


def _date_styles(z):
    """Return the set of style indexes whose number format renders as a date or time."""
    try:
        root = ET.fromstring(z.read("xl/styles.xml"))
    except KeyError:
        return set()
    custom = {}
    fmts = root.find(_q("numFmts"))
    if fmts is not None:
        for f in fmts.findall(_q("numFmt")):
            code = f.get("formatCode", "")
            stripped = re.sub(r'\[[^\]]*\]|"[^"]*"', "", code)
            if re.search(r"[ymdhs]", stripped, re.IGNORECASE):
                custom[f.get("numFmtId")] = True
    date_styles = set()
    xfs = root.find(_q("cellXfs"))
    if xfs is not None:
        for i, xf in enumerate(xfs.findall(_q("xf"))):
            fid = xf.get("numFmtId")
            if fid is None:
                continue
            if custom.get(fid) or (fid.isdigit() and int(fid) in BUILTIN_DATE_IDS):
                date_styles.add(i)
    return date_styles


def _sheet_targets(z):
    """Map sheet name -> zip path, following the relationship ids (order is not reliable)."""
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {}
    try:
        rel_root = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        for r in rel_root.findall("{%s}Relationship" % NS_PKG_REL):
            rels[r.get("Id")] = r.get("Target")
    except KeyError:
        pass
    out = []
    sheets = wb.find(_q("sheets"))
    if sheets is None:
        raise XlsxError("a munkafuzetben nincs egyetlen lap sem")
    for sh in sheets.findall(_q("sheet")):
        name = sh.get("name")
        rid = sh.get("{%s}id" % NS_REL_DOC)
        target = rels.get(rid, "worksheets/sheet1.xml")
        if target.startswith("/"):
            path = target.lstrip("/")
        else:
            path = "xl/" + target.lstrip("./")
        out.append((name, path, sh.get("state", "visible")))
    return out


def _read_sheet(z, path, strings, date_styles):
    root = ET.fromstring(z.read(path))
    data = root.find(_q("sheetData"))
    if data is None:
        return []
    rows = []
    for row in data.findall(_q("row")):
        # A sheet stores only the rows that hold something, so row 9 can follow row 5.
        # Appending in document order collapses that gap and shifts every later row up,
        # which silently misaligns a diff against another workbook. Measured 2026-09-22
        # on a fixture with one deliberately empty row: the .xls reader kept the position
        # and this one did not.
        r_attr = row.get("r")
        if r_attr and r_attr.isdigit():
            target = int(r_attr) - 1
            while len(rows) < target:
                rows.append([])
        cells = []
        for c in row.findall(_q("c")):
            idx = _col_index(c.get("r"))
            if idx is None:
                idx = len(cells)
            while len(cells) < idx:
                cells.append("")
            ctype = c.get("t")
            if ctype == "inlineStr":
                is_el = c.find(_q("is"))
                text = "".join(t.text or "" for t in is_el.iter(_q("t"))) if is_el is not None else ""
            else:
                v = c.find(_q("v"))
                raw = v.text if v is not None else None
                if raw is None:
                    text = ""
                elif ctype == "s":
                    try:
                        text = strings[int(raw)]
                    except (ValueError, IndexError):
                        text = ""
                elif ctype == "b":
                    text = "IGAZ" if raw == "1" else "HAMIS"
                elif ctype in ("str", "e"):
                    text = raw
                else:
                    style = c.get("s")
                    is_date = style is not None and style.isdigit() and int(style) in date_styles
                    text = _serial_to_text(raw, is_date)
            cells.append(text)
        rows.append(cells)
    while rows and not any(c.strip() for c in rows[-1]):
        rows.pop()
    width = max((len(r) for r in rows), default=0)
    for r in rows:
        while len(r) < width:
            r.append("")
    return rows


def _looks_like_ole(path):
    """Decide by content, not by name. A file called .xlsx can still be a binary .xls."""
    try:
        with open(path, "rb") as fh:
            return fh.read(8) == xlsbiff.OLE_MAGIC
    except FileNotFoundError:
        raise XlsxError("nincs ilyen fajl: %s" % path)


def read_workbook(path, sheet=None, include_hidden=False, warnings=None):
    """Return {sheet_name: [[cell, ...], ...]} with every value rendered as text.

    Handles both .xlsx (ZIP of XML) and legacy .xls (OLE2 + BIFF), chosen by signature.
    """
    if _looks_like_ole(path):
        try:
            return xlsbiff.read_workbook(path, sheet, include_hidden, warnings=warnings)
        except xlsbiff.BiffError as e:
            raise XlsxError(str(e))
    try:
        z = zipfile.ZipFile(path)
    except FileNotFoundError:
        raise XlsxError("nincs ilyen fajl: %s" % path)
    except zipfile.BadZipFile:
        raise XlsxError(
            "ez a fajl nem ervenyes .xlsx (nem ZIP). Ha .xls-bol lett atnevezve, az nem konvertalas."
        )
    with z:
        strings = _shared_strings(z)
        date_styles = _date_styles(z)
        targets = _sheet_targets(z)
        names = [t[0] for t in targets]
        if sheet is not None and sheet not in names:
            raise XlsxError("nincs ilyen lap: %s. A munkafuzet lapjai: %s" % (sheet, ", ".join(names)))
        out = {}
        for name, zip_path, state in targets:
            if sheet is not None and name != sheet:
                continue
            if state != "visible" and not include_hidden and sheet is None:
                continue
            try:
                out[name] = _read_sheet(z, zip_path, strings, date_styles)
            except KeyError:
                raise XlsxError("a(z) '%s' lap hianyzik a fajlbol (%s)" % (name, zip_path))
        return out


def _index(rows, key_col):
    if not rows:
        return {}, []
    header, body = rows[0], rows[1:]
    if key_col is None:
        return {"sor %d" % (i + 2): r for i, r in enumerate(body)}, header
    if key_col not in header:
        raise XlsxError("nincs ilyen oszlop a fejlecben: %s (fejlec: %s)" % (key_col, ", ".join(header)))
    k = header.index(key_col)
    out = {}
    for r in body:
        out.setdefault(r[k] if k < len(r) else "", r)
    return out, header


def diff_workbooks(old_path, new_path, key=None, sheet=None):
    """Compare two workbooks. The two sides may be different formats: .xls against .xlsx
    is the normal case when a system is migrated, and it is exactly the comparison that
    must not silently drop the half it cannot read."""
    notes = []
    old = read_workbook(old_path, sheet, warnings=notes)
    new = read_workbook(new_path, sheet, warnings=notes)
    report = {"old": old_path, "new": new_path, "key": key, "warnings": notes, "sheets": {}}
    for name in sorted(set(old) | set(new)):
        if name not in old:
            report["sheets"][name] = {"status": "uj lap", "rows": len(new[name])}
            continue
        if name not in new:
            report["sheets"][name] = {"status": "torolt lap", "rows": len(old[name])}
            continue
        o, oh = _index(old[name], key)
        n, nh = _index(new[name], key)
        entry = {"status": "osszehasonlitva", "header_changed": oh != nh,
                 "added": [], "removed": [], "changed": []}
        for k in n:
            if k not in o:
                entry["added"].append({"key": k, "row": n[k]})
        for k in o:
            if k not in n:
                entry["removed"].append({"key": k, "row": o[k]})
            elif o[k] != n[k]:
                cells = []
                for i in range(max(len(o[k]), len(n[k]))):
                    a = o[k][i] if i < len(o[k]) else ""
                    b = n[k][i] if i < len(n[k]) else ""
                    if a != b:
                        # Ures fejlec-cella eseten is kell nev, kulonben a jelentesben
                        # "': regi -> uj" all, es nem derul ki, melyik oszlop valtozott.
                        col = nh[i].strip() if i < len(nh) else ""
                        if not col:
                            col = "%s oszlop" % _col_letter(i)
                        cells.append({"column": col, "old": a, "new": b})
                entry["changed"].append({"key": k, "cells": cells})
        report["sheets"][name] = entry
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("read")
    r.add_argument("file")
    r.add_argument("--sheet")
    r.add_argument("--format", choices=["json", "csv"], default="json")
    r.add_argument("--include-hidden", action="store_true",
                   help="a rejtett lapokat is olvassa (alapbol kimaradnak)")

    d = sub.add_parser("diff")
    d.add_argument("old")
    d.add_argument("new")
    d.add_argument("--key", help="oszlopnev a sorok parositasahoz; enelkul sorszam szerint parosit")
    d.add_argument("--sheet")

    a = ap.parse_args()
    try:
        if a.cmd == "read":
            notes = []
            sheets = read_workbook(a.file, a.sheet, a.include_hidden, warnings=notes)
            for note in notes:
                print("FIGYELEM: %s" % note, file=sys.stderr)
            if a.format == "json":
                print(json.dumps(sheets, ensure_ascii=False, indent=2))
            else:
                w = csv.writer(sys.stdout)
                for name, rows in sheets.items():
                    print("### %s (%d sor)" % (name, len(rows)))
                    w.writerows(rows)
                    print()
        else:
            print(json.dumps(diff_workbooks(a.old, a.new, a.key, a.sheet),
                             ensure_ascii=False, indent=2))
    except XlsxError as e:
        print("HIBA: %s" % e, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
