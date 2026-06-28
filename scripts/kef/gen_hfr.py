import sys, os, zipfile, html

# HFR (hő-füst) import XLSX writer. Clones the official template, swaps sheet1.xml.
TEMPLATE = "/root/marveen/store/fireg-import-templates/fustgato-sablon-hofustelvezeto_import.xlsx"
HEAD = ['Belső Azonosító', 'Eszköz helye', 'Típus', 'Altípus', 'Füstszakasz',
        'Működési elv', 'Gyártási dátum', 'Szerelvények', 'Megjegyzés',
        'Utolsó időszakos felülvizsgálat', 'Utolsó üzemeltetői ellenőrzés']


def colref(n):
    s = ''; n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def cell(ci, ri, v):
    v = html.escape(str(v))
    return f'<c r="{colref(ci)}{ri}" t="inlineStr"><is><t xml:space="preserve">{v}</t></is></c>'


def sheet1_xml(rows):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
           f'<dimension ref="A1:{colref(len(HEAD)-1)}{len(rows)}"/><sheetData>']
    for ri, r in enumerate(rows, 1):
        out.append(f'<row r="{ri}">' + ''.join(cell(ci, ri, c) for ci, c in enumerate(r)) + '</row>')
    out.append('</sheetData></worksheet>')
    return ''.join(out)


def device_row(d):
    return [
        d.get('belso', ''),        # A Belső Azonosító
        d.get('helye', ''),        # B Eszköz helye
        d.get('code', ''),         # C Típus (enum)
        '',                        # D Altípus
        '',                        # E Füstszakasz
        d.get('mukelv', ''),       # F Működési elv
        '',                        # G Gyártási dátum
        '',                        # H Szerelvények
        '',                        # I Megjegyzés
        d.get('idosz_date', ''),   # J Utolsó időszakos felülvizsgálat
        d.get('ue_date', ''),      # K Utolsó üzemeltetői ellenőrzés
    ]


def write_xlsx(path, devs):
    rows = [HEAD] + [device_row(d) for d in devs]
    zin = zipfile.ZipFile(TEMPLATE, 'r')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == 'xl/worksheets/sheet1.xml':
                data = sheet1_xml(rows).encode('utf-8')
            zout.writestr(item, data)
    zin.close()
