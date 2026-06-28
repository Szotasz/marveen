import re, sys, subprocess, os, csv

def words_of(pdf):
    xml=subprocess.run(['pdftotext','-bbox-layout',pdf,'-'],capture_output=True,text=True).stdout
    pages=[]
    for pg in re.split(r'<page ', xml)[1:]:
        ws=[(float(y0),float(x0),float(x1),t) for x0,y0,x1,y1,t in
            re.findall(r'<word xMin="([0-9.]+)" yMin="([0-9.]+)" xMax="([0-9.]+)" yMax="([0-9.]+)">([^<]*)</word>', pg)]
        pages.append(ws)
    return pages

def maint_date(pdf):
    txt=subprocess.run(['pdftotext','-layout',pdf,'-'],capture_output=True,text=True).stdout
    ds=sorted(set(re.findall(r'KARBANTARTÁS IDŐPONTJA:\s*(20\d\d\.\d{2}\.\d{2})', txt)))
    return ds

def header_x(pages):
    # find column-header row words on first page that has 'Ssz'
    for ws in pages:
        if any(t=='Ssz' for _,_,_,t in ws):
            y0=[y for y,x0,x1,t in ws if t=='Ssz'][0]
            hw=[(x0,x1,t) for y,x0,x1,t in ws if -42 < (y-y0) < 14]
            def gx(lbl,xmin=0,xmax=9999):
                for x0,x1,t in sorted(hw):
                    if t==lbl and xmin<=x0<=xmax: return x0,x1
                return None
            # megjegyzés header (appears above the Ssz row, right side)
            mj=[x0 for y,x0,x1,t in ws if t=='megjegyzés' and x0>500]
            megj_l=(min(mj)-110) if mj else None
            return {
                'megj_l': megj_l,
                'ssz': gx('Ssz'),
                'belso': gx('az.'),
                'helye': gx('Készenléti'),
                'oltas': gx('Oltásteljesítmény'),
                'gyari': gx('Gyári'),
                'gyartas': gx('Gyártás'),
                'esed': gx('Esedékes'),
            }, y0
    return None, None

def extract(pdf):
    pages=words_of(pdf)
    H,hy=header_x(pages)
    if not H: return [], []
    if not all(H.get(k) for k in ('ssz','helye','gyari','gyartas')):
        return [], []
    ssz_l=H['ssz'][0]; helye_l=H['helye'][0]
    belso_l=H['belso'][0] if H.get('belso') else ssz_l+18
    gyari_l=H['gyari'][0]; gyartas_l=H['gyartas'][0]
    oltas_l=H['oltas'][0] if H.get('oltas') else gyari_l
    esed_l=H['esed'][0] if H.get('esed') else gyartas_l+35
    megj_l=H.get('megj_l') or 575
    # collect all device-region words to find loc/type split
    midxs=[]
    devwords=[]  # (anchor_key, y,x0,x1,t)
    all_anchors=[]
    for pi,ws in enumerate(pages):
        hyl=[y for y,x0,x1,t in ws if t=='Ssz']
        ytop=(hyl[0]+12) if hyl else 195
        anchors=sorted(y for y,x0,x1,t in ws if ssz_l-2<=x0<ssz_l+10 and re.fullmatch(r'\d{1,4}',t) and ytop<y<560)
        if not anchors: continue
        for y,x0,x1,t in ws:
            if not(ytop<y<560): continue
            if belso_l+4 < x0 < oltas_l-2:
                midxs.append(x0)
    # split between location and type: largest gap in mid-x histogram
    split=(helye_l+oltas_l)/2
    if midxs:
        lo=int(helye_l); hi=int(oltas_l)
        bins={}
        for x in midxs:
            bins[int(x//4)]=bins.get(int(x//4),0)+1
        # valley = lowest-count bin in the central 30%-80% of the range
        a=lo+int((hi-lo)*0.20); b=lo+int((hi-lo)*0.85)
        cand=[(bins.get(k//4,0),k) for k in range(a,b)]
        if cand:
            split=min(cand)[1]
    devs=[]
    for pi,ws in enumerate(pages):
        hyl=[y for y,x0,x1,t in ws if t=='Ssz']
        ytop=(hyl[0]+12) if hyl else 195
        anchors=sorted(y for y,x0,x1,t in ws if ssz_l-2<=x0<ssz_l+10 and re.fullmatch(r'\d{1,4}',t) and ytop<y<560)
        if not anchors: continue
        bk={a:[] for a in anchors}
        for w in ws:
            y=w[0]
            if not(ytop<y<560): continue
            a=min(anchors,key=lambda A:abs(A-y))
            bk[a].append(w)
        for a in anchors:
            wl=sorted(bk[a])
            belso=' '.join(t for y,x0,x1,t in wl if belso_l-3<=x0<helye_l-2 and re.fullmatch(r'\d{1,4}\.?',t))
            helye=' '.join(t for y,x0,x1,t in wl if belso_l-1<=x0<split and not re.fullmatch(r'\d{1,4}\.?',t))
            tipus=' '.join(t for y,x0,x1,t in wl if split<=x0<oltas_l-2)
            gyari=[t for y,x0,x1,t in wl if gyari_l-10<=x0<gyartas_l+6 and re.fullmatch(r'\d{4,}',t)]
            gyartas=' '.join(t for y,x0,x1,t in wl if gyartas_l-4<=x0<esed_l-2 and re.fullmatch(r'(19|20)\d\d',t))
            # cleanups
            belso=re.sub(r'\D','',belso)
            tipus=re.sub(r'\s*Otelj:.*$','',tipus)
            tipus=re.sub(r'\s*Oegys:.*$','',tipus).strip()
            tipus=re.sub(r'\s+',' ',tipus)
            helye=re.sub(r'\s+',' ',helye).strip(' -')
            gyari=[g for g in gyari if not (len(g)==4 and 1990<=int(g)<=2030)]
            gyari=max(gyari,key=len) if gyari else ''
            gyartas=re.findall(r'(?:19|20)\d\d', gyartas)
            gyartas=gyartas[0] if gyartas else ''
            megj=' '.join(t for y,x0,x1,t in wl if x0>=megj_l)
            megj=re.sub(r'\s+',' ',megj).strip()
            devs.append(dict(belso=belso,helye=helye,tipus=tipus,gyari=gyari,gyartas=gyartas,megj=megj))
    return devs, maint_date(pdf)

if __name__=='__main__':
    for pdf in sys.argv[1:]:
        devs,md=extract(pdf)
        base=os.path.basename(pdf).replace('.pdf','')
        nb=sum(1 for d in devs if d['belso'])
        nh=sum(1 for d in devs if d['helye'])
        nt=sum(1 for d in devs if d['tipus'])
        ng=sum(1 for d in devs if d['gyari'])
        ny=sum(1 for d in devs if d['gyartas'])
        n=len(devs) or 1
        print(f"\n### {base}: {len(devs)} eszköz | karbantartás dátum(ok)={md}")
        print(f"    kitöltött: belső={nb*100//n}% helye={nh*100//n}% típus={nt*100//n}% gyári={ng*100//n}% gyártás={ny*100//n}%")
        for d in devs[:6]:
            print(f"  belső={d['belso']:>3} | helye={d['helye'][:34]:34} | típus={d['tipus'][:26]:26} | gyári={d['gyari']:>7} | gyártás={d['gyartas']}")
