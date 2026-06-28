import sys, os, zipfile, html, re, shutil

TEMPLATE="/root/marveen/store/fireg-import-templates/tuzoltokeszulek-sablon-keszulek_import.xlsx"
HEAD=['Belső Azonosító','Készenléti helye','Készüléktípus','Gyári száma','Gyártási dátum','Megjegyzés','Utolsó alap karb','Utolsó közép karb','Utolsó teljes karb','Utolsó üzemeltető ellenőrzés']

def colref(n):
    s=''; n+=1
    while n: n,r=divmod(n-1,26); s=chr(65+r)+s
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
    out.append('</sheetData></worksheet>')
    return ''.join(out)

def write_xlsx(path, rows):
    # clone the template, swap only xl/worksheets/sheet1.xml
    zin=zipfile.ZipFile(TEMPLATE,'r')
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data=zin.read(item.filename)
            if item.filename=='xl/worksheets/sheet1.xml':
                data=sheet1_xml(rows).encode('utf-8')
            zout.writestr(item, data)
    zin.close()

def iso(d): return d.replace('.','-') if d else ''

if __name__=='__main__':
    import tk_final
    OUT='out_import'; os.makedirs(OUT,exist_ok=True)
    for pdf in sys.argv[1:]:
        devs,md=tk_final.extract(pdf)
        mdate=iso(sorted(md)[-1]) if md else ''
        rows=[HEAD]
        for d in devs:
            rows.append([d['belso'],d['helye'],d['tipus'],d['gyari'],d['gyartas'],d.get('megj',''),
                         mdate,'','',mdate])
        base=os.path.basename(pdf).replace('.pdf','')
        write_xlsx(os.path.join(OUT,base+'.xlsx'),rows)
        print(f"{base}: {len(devs)} sor (klónozott sablon-szerkezet)")