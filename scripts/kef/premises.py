import re, subprocess, sys, os, zipfile, html

TEMPLATE="/root/marveen/store/fireg-import-templates/premises_hu.xlsx"
HEAD=['Név','Irányítószám','Település','Utca','Utca típus','Házszám',
      'Telephelykapcsolat: 1','Telephelykapcsolat: 2','Telephelykapcsolat: 3',
      'Telephelykapcsolat: 4','Telephelykapcsolat: 5']
UTCATIP=(r'(körútja|körút|krt|sugárútja|sugárút|sgt|útja|út|utcája|utca|u\.|'
         r'tere|tér|köze|köz|kapuja|kapu|sora|sor|rakpartja|rakpart|rkp|fasora|fasor|'
         r'parkja|park|ligetje|liget|sétánya|sétány|dűlő|dülő|puszta|tanya|major|'
         r'dombja|domb|lejtő|lépcső|udvara|udvar|telepe|telep|allé)')

def text(pdf):
    return subprocess.run(['pdftotext','-layout',pdf,'-'],capture_output=True,text=True).stdout

def parse(pdf):
    txt=text(pdf)
    lines=[re.sub(r'\s+',' ',l).strip() for l in txt.split('\n') if l.strip()]
    # név: a "...üzemeltetési napló" sor utáni 1-3 sor; a telephely-specifikus (" - "-t tartalmazó) sort preferáljuk
    nev=''
    for i,l in enumerate(lines):
        if 'üzemeltetési napló' in l.lower():
            BAD=('megfelel','rendelet','tvmi','szabvány','szabvany','felülvizsgálat','pontja','§')
            cand=[c for c in lines[i+1:i+4] if c and not any(b in c.lower() for b in BAD)]
            dashed=[c for c in cand if ' - ' in c]
            nev = dashed[-1] if dashed else (cand[0] if cand else '')
            break
    if not nev and len(lines)>2: nev=lines[2]
    nev=re.sub(r'\s+',' ',nev).strip()
    # cím: TELEPHELY CÍME, fallback: KÉSZENLÉTBEN TARTÓ CÍME -- a cím az oszlopközig (2+ szóköz) tart
    irsz=telep=utca=tip=hsz=''
    m=re.search(r'TELEPHELY CÍME:\s*(\d{4})\s+(.+?)(?:\s{2,}|\n|$)', txt)
    if not m:
        m=re.search(r'KÉSZENLÉTBEN TARTÓ CÍME:\s*(\d{4})\s+(.+?)(?:\s{2,}|\n|$)', txt)
    if m:
        irsz=m.group(1)
        rest=re.sub(r'\s+',' ',m.group(2)).strip().rstrip('.')
        # település , utca típus házszám
        # település , utca <típus> házszám[/emelet/ajtó]
        cm=re.match(r'(.+?)\s*,\s*(.+?)\s+'+UTCATIP+r'\.?\s+([0-9][0-9/A-Za-z\-]*)\b.*$', rest, re.IGNORECASE)
        if cm:
            telep=cm.group(1).strip()
            utca=cm.group(2).strip()
            tip=cm.group(3).strip().rstrip('.')
            hsz=cm.group(4).strip().rstrip('.')
        else:
            # nincs felismert utcatípus (hrsz/külterület/telepnév) -> a teljes cím-maradékot az Utca mezőbe
            parts=rest.split(',',1)
            telep=parts[0].strip()
            utca=parts[1].strip().rstrip('.') if len(parts)>1 else ''
    return dict(nev=nev,irsz=irsz,telep=telep,utca=utca,tip=tip,hsz=hsz)

# ---- xlsx writer (template clone, sheet1 csere) ----
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
    zin=zipfile.ZipFile(TEMPLATE,'r')
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data=zin.read(item.filename)
            if item.filename=='xl/worksheets/sheet1.xml':
                data=sheet1_xml(rows).encode('utf-8')
            zout.writestr(item, data)
    zin.close()

if __name__=='__main__':
    for pdf in sys.argv[1:]:
        d=parse(pdf)
        print(f"{os.path.basename(pdf)[:30]:31} | {d['nev'][:38]:38} | {d['irsz']} {d['telep'][:16]:16} | {d['utca'][:18]:18} {d['tip']:8} {d['hsz']}")
