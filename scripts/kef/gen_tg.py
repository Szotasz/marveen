import sys, os, zipfile, html

# TG (tűzgátló / fire doors) import XLSX writer. Clones the official template and
# swaps only xl/worksheets/sheet1.xml (preserves styles/enum sheets).
TEMPLATE = "/root/marveen/store/fireg-import-templates/tuzgato-sablon-fire_doors_hu.xlsx"
HEAD = ['Eszköz helye', 'Típus', 'Működési elv', 'Gyártási dátum', 'Altípus',
        'Gyártó', 'Beépítése', 'Mérete', 'Nyil. irány', 'Szárnyak', 'Tűzállóság',
        'Szerelvények', 'Utolsó időszakos felülvizsgálat',
        'Utolsó üzemeltetői ellenőrzés', 'Belső Azonosító', 'Megjegyzés']


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
    """Map a tg.extract() device dict to the 16 template columns (A..P).
    Date cells are TEXT in eeee-hh-nn, per the import spec."""
    return [
        d.get('helye', ''),        # A Eszköz helye
        d.get('code', ''),         # B Típus (enum)
        d.get('mukelv', ''),       # C Működési elv
        '',                        # D Gyártási dátum (nincs)
        '',                        # E Altípus (nincs)
        d.get('gyarto', ''),       # F Gyártó
        '',                        # G Beépítése (nincs)
        d.get('meret', ''),        # H Mérete
        d.get('nyilas', ''),       # I Nyil. irány
        d.get('szarnyak', ''),     # J Szárnyak
        d.get('tuzallosag', ''),   # K Tűzállóság
        '',                        # L Szerelvények (nincs)
        d.get('idosz_date', ''),   # M Utolsó időszakos felülvizsgálat
        d.get('ue_date', ''),      # N Utolsó üzemeltetői ellenőrzés
        d.get('belso', ''),        # O Belső Azonosító
        '',                        # P Megjegyzés
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
    import tg
    OUT = 'out_tg'
    os.makedirs(OUT, exist_ok=True)
    for pdf in sys.argv[1:]:
        devs = tg.extract(pdf)
        base = os.path.basename(pdf).replace('.pdf', '')
        write_xlsx(os.path.join(OUT, base + '.xlsx'), devs)
        print(f"{base}: {len(devs)} sor")
