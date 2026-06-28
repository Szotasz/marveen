import sys, os, zipfile, html
# VK (vészkijárat) import XLSX writer.
TEMPLATE = "/root/marveen/store/fireg-import-templates/veszkijarat-sablon-veszkijaratimport.xlsx"
HEAD = ['Eszköz helye', 'Típus', 'Altípus', 'Működési elv',
        'Utolsó időszakos felülvizsgálat', 'Utolsó üzemeltetői ellenőrzés',
        'Gyártási dátum', 'Belső Azonosító', 'Megjegyzés']
def colref(n):
    s=''; n+=1
    while n:
        n,r=divmod(n-1,26); s=chr(65+r)+s
    return s
def cell(ci,ri,v):
    v=html.escape(str(v))
    return f'<c r="{colref(ci)}{ri}" t="inlineStr"><is><t xml:space="preserve">{v}</t></is></c>'
def sheet1_xml(rows):
    out=['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
         '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
         f'<dimension ref="A1:{colref(len(HEAD)-1)}{len(rows)}"/><sheetData>']
    for ri,r in enumerate(rows,1):
        out.append(f'<row r="{ri}">'+''.join(cell(ci,ri,c) for ci,c in enumerate(r))+'</row>')
    out.append('</sheetData></worksheet>'); return ''.join(out)
def device_row(d):
    return [d.get('helye',''), d.get('code',''), '', d.get('mukelv',''),
            d.get('idosz_date',''), d.get('ue_date',''), '', d.get('belso',''), '']
def write_xlsx(path, devs):
    rows=[HEAD]+[device_row(d) for d in devs]
    zin=zipfile.ZipFile(TEMPLATE,'r')
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data=zin.read(item.filename)
            if item.filename=='xl/worksheets/sheet1.xml':
                data=sheet1_xml(rows).encode('utf-8')
            zout.writestr(item,data)
    zin.close()
