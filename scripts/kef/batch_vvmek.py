import sys, os, subprocess, tempfile, time
sys.path.insert(0, os.path.dirname(__file__))
import vvmek
from gen_tg import write_xlsx   # TG template (tűzgátló nyílászárók)
SYS="/usr/bin/python3"; CLI="/root/marveen/scripts/owncloud-cli.py"
SRC="fiREG közös/temp/KEF"; DST="fiREG közös/temp/KEF/_import_kesz/TG"
files=[l.strip() for l in open(sys.argv[1]) if l.strip()]
tmp=tempfile.mkdtemp(prefix="kef_vv_")
ok=0; nontab=[]
for fn in files:
    base=fn[:-4]; lp=os.path.join(tmp,fn)
    subprocess.run([SYS,CLI,"get",f"{SRC}/{fn}",lp],capture_output=True)
    if not os.path.exists(lp): nontab.append((base,"letöltés sikertelen")); continue
    devs=vvmek.extract(lp)
    if not devs:
        nontab.append((base,"non-tabuláris (nincs eszköz-kód, csak narratív/eljárás szöveg)")); continue
    xp=os.path.join(tmp,base+".xlsx"); write_xlsx(xp,devs)
    u=subprocess.run([SYS,CLI,"put",xp,f"{DST}/{base}.xlsx"],capture_output=True,text=True).stdout
    if "HTTP 2" in u:
        ok+=1; print(f"OK {base}: {len(devs)} eszköz (belső+épület, típus FLAG)",flush=True)
    else: nontab.append((base,"upload hiba"))
print(f"\n=== {ok} feltöltve, {len(nontab)} non-tabuláris ===")
for b,m in nontab: print(f"  {b}: {m}")
