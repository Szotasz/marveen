import sys, os, zipfile, html

# EA (világítás) import XLSX writer. Clones the official template and swaps only
# xl/worksheets/sheet1.xml (preserves styles/enum sheets), like gen_tv.py.
TEMPLATE = "/root/marveen/store/fireg-import-templates/vilagitas-sablon-vilagitas_import.xlsx"
HEAD = ['Belső Azonosító', 'Készenléti helye', 'Típus', 'Altípus',
        'Működési elv', 'Gyártási dátum', 'Gyártó', 'Tápellátás', 'Megjegyzés',
        'Utolsó időszakos felülvizsgálat', 'Utolsó üzemeltetői ellenőrzés']


def colref(n):
    s = ''; n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def cell(ci, ri, v):
    v = html.escape(str(v))
    return (f'<c r="{colref(ci)}{ri}" t="inlineStr"><is>'
            f'<t xml:space="preserve">{v}</t></is></c>')


def sheet1_xml(rows):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
           f'<dimension ref="A1:{colref(len(HEAD)-1)}{len(rows)}"/><sheetData>']
    for ri, r in enumerate(rows, 1):
        out.append(f'<row r="{ri}">' + ''.join(cell(ci, ri, c) for ci, c in enumerate(r)) + '</row>')
    out.append('</sheetData></worksheet>')
    return ''.join(out)


def device_row(d):
    """Map an ea.extract() device dict to the 11 template columns (A..K).
    Date cells are TEXT in eeee-hh-nn (iso_date), per the import spec."""
    return [
        d.get('belso', ''),         # A Belső Azonosító
        d.get('helye', ''),         # B Készenléti helye
        d.get('code', ''),          # C Típus (enum)
        d.get('altipus', ''),       # D Altípus
        d.get('mukelv', ''),        # E Működési elv
        '',                         # F Gyártási dátum (nincs a PDF-ben)
        d.get('gyarto', ''),        # G Gyártó
        '',                         # H Tápellátás (nincs)
        '',                         # I Megjegyzés
        d.get('idosz_date', ''),    # J Utolsó időszakos felülvizsgálat
        d.get('ue_date', ''),       # K Utolsó üzemeltetői ellenőrzés
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


if __name__ == '__main__':
    import ea
    OUT = 'out_ea'
    os.makedirs(OUT, exist_ok=True)
    for pdf in sys.argv[1:]:
        devs = ea.extract(pdf)
        base = os.path.basename(pdf).replace('.pdf', '')
        write_xlsx(os.path.join(OUT, base + '.xlsx'), devs)
        flagged = sum(1 for d in devs if not d['code'])
        print(f"{base}: {len(devs)} sor, {flagged} flag (üres típuskód)")
