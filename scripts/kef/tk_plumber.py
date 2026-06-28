import re, sys
import pdfplumber

def _norm(s): return re.sub(r'\s+',' ',(s or '')).strip()

def _colmap(header_rows):
    # combine up to 2 header rows per column index, classify
    ncol=max(len(r) for r in header_rows)
    labels=['']*ncol
    for r in header_rows:
        for i,c in enumerate(r):
            c=_norm(c)
            if c: labels[i]=(labels[i]+' '+c).strip()
    m={}
    for i,l in enumerate(labels):
        ll=l.lower()
        if 'ssz' in ll.split(): m.setdefault('ssz',i)
        elif 'belső' in ll and 'az' in ll: m['belso']=i
        elif 'készenléti' in ll or l.startswith('Készenléti'): m['helye']=i
        elif 'típus' in ll: m['tipus']=i
        elif 'gyári' in ll: m['gyari']=i
        elif ll.startswith('gyártás') or ll=='gyártás': m['gyartas']=i
        elif 'megjegyzés' in ll: m['megj']=i
    return m, labels

def extract(pdf_path):
    devs=[]; mdates=set()
    with pdfplumber.open(pdf_path) as pdf:
        for pg in pdf.pages:
            txt=pg.extract_text() or ''
            for d in re.findall(r'KARBANTARTÁS IDŐPONTJA[:\s]*?(20\d\d\.\d{2}\.\d{2})', txt):
                mdates.add(d)
            for t in pg.extract_tables():
                if not t or len(t)<2: continue
                # find header rows: the row containing 'Ssz'
                hidx=None
                for ri,row in enumerate(t[:3]):
                    if any(_norm(c)=='Ssz' for c in row): hidx=ri; break
                if hidx is None: continue
                m,labels=_colmap(t[:hidx+1])
                if 'ssz' not in m or ('helye' not in m): continue
                for row in t[hidx+1:]:
                    ssz=_norm(row[m['ssz']]) if m['ssz']<len(row) else ''
                    if not re.fullmatch(r'\d{1,4}', ssz): continue
                    def get(k):
                        i=m.get(k); 
                        return _norm(row[i]) if (i is not None and i<len(row)) else ''
                    belso=get('belso') or ssz
                    tipus=re.sub(r'\s*Oegys:.*$','',re.sub(r'\s*Otelj:.*$','',get('tipus'))).strip()
                    gy=re.findall(r'\d{3,}', get('gyari')); gy=gy[0] if gy else ''
                    yr=re.findall(r'(?:19|20)\d\d', get('gyartas')); yr=yr[0] if yr else ''
                    devs.append(dict(belso=belso,helye=get('helye'),tipus=tipus,gyari=gy,gyartas=yr,megj=get('megj')))
    return devs, sorted(mdates)

if __name__=='__main__':
    import time
    for pdf in sys.argv[1:]:
        t0=time.time(); devs,md=extract(pdf); dt=time.time()-t0
        n=len(devs) or 1
        b=sum(1 for d in devs if d['belso']); h=sum(1 for d in devs if d['helye']); g=sum(1 for d in devs if d['gyari']); ty=sum(1 for d in devs if d['tipus'])
        print(f"{pdf[:26]:27} {len(devs):4} eszk | belső {b*100//n}% helye {h*100//n}% típus {ty*100//n}% gyári {g*100//n}% | md={md} | {dt:.1f}s")
