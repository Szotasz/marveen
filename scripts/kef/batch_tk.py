import sys, os, subprocess, tempfile, time
sys.path.insert(0, os.path.dirname(__file__))
import tk_plumber
from gen_xlsx import write_xlsx, HEAD, iso

SYS="/usr/bin/python3"
CLI="/root/marveen/scripts/owncloud-cli.py"
SRC="fiREG közös/temp/KEF"
DST="fiREG közös/temp/KEF/_import_kesz/TK"
kept=[l.strip() for l in open(sys.argv[1]) if l.strip()]
tmp=tempfile.mkdtemp(prefix="kef_tk_")
subprocess.run([SYS,CLI,"mkdir",DST],capture_output=True)
ok=err=0; t0=time.time()
for i,fn in enumerate(kept,1):
    base=fn[:-4]; lp=os.path.join(tmp,fn)
    try:
        subprocess.run([SYS,CLI,"get",f"{SRC}/{fn}",lp],capture_output=True,text=True)
        if not os.path.exists(lp): raise RuntimeError("download failed")
        devs,md=tk_plumber.extract(lp)
        if not devs: raise RuntimeError("0 eszköz kinyerve")
        mdate=iso(md[-1]) if md else ''
        rows=[HEAD]+[[d['belso'],d['helye'],d['tipus'],d['gyari'],d['gyartas'],d.get('megj',''),mdate,'','',mdate] for d in devs]
        xp=os.path.join(tmp,base+".xlsx"); write_xlsx(xp,rows)
        u=subprocess.run([SYS,CLI,"put",xp,f"{DST}/{base}.xlsx"],capture_output=True,text=True)
        if "HTTP 2" not in u.stdout: raise RuntimeError("upload: "+u.stdout[-80:])
        ok+=1; print(f"[{i}/{len(kept)}] OK {base} ({len(devs)} eszk) md={mdate}",flush=True)
        os.remove(lp); os.remove(xp)
    except Exception as e:
        err+=1; print(f"[{i}/{len(kept)}] HIBA {base}: {e}",flush=True)
print(f"\n=== KÉSZ: {ok} sikeres, {err} hiba, {int(time.time()-t0)}s ===",flush=True)
