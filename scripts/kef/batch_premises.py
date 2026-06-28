import sys, os, re, subprocess, tempfile, time
sys.path.insert(0, os.path.dirname(__file__))
import premises

SYS="/usr/bin/python3"
CLI="/root/marveen/scripts/owncloud-cli.py"
SRC="fiREG közös/temp/KEF"
DST="fiREG közös/temp/KEF/_import_kesz"
OUTNAME="premises_hu_KEF.xlsx"

def cli(*a):
    return subprocess.run([SYS,CLI,*a],capture_output=True,text=True).stdout

# 1) fájllista, prefix szerint csoportosítva, prefixenként 1 fájl
listing=cli("ls",SRC)
TYPE=r'(?:TK|TV|TG|TGV|EA|HFR)'
files=re.findall(r'([A-Za-z0-9_]+_\d{4}_'+TYPE+r'_UN\.pdf)', listing)
by_prefix={}
for fn in files:
    pre=re.sub(r'_\d{4}_'+TYPE+r'_UN\.pdf$','',fn)
    by_prefix.setdefault(pre,[]).append(fn)
prefixes=sorted(by_prefix)
print(f"{len(files)} PDF, {len(prefixes)} egyedi telephely-prefix",flush=True)

tmp=tempfile.mkdtemp(prefix="kef_prem_")
rows=[]; flagged=[]; t0=time.time()
for i,pre in enumerate(prefixes,1):
    fn=sorted(by_prefix[pre])[0]
    lp=os.path.join(tmp,fn)
    cli("get",f"{SRC}/{fn}",lp)
    if not os.path.exists(lp):
        flagged.append((pre,"letöltés sikertelen")); continue
    d=premises.parse(lp)
    miss=[k for k in ('nev','irsz','telep','utca','hsz') if not d[k]]
    if miss: flagged.append((pre,"hiányzó: "+",".join(miss)+f" | {d}"))
    rows.append((pre,d))
    os.remove(lp)
    if i%25==0: print(f"  [{i}/{len(prefixes)}] {int(time.time()-t0)}s",flush=True)

# 2) dedup azonos cím alapján (név+ir.szám+utca+házszám)
seen={}; final=[]
for pre,d in rows:
    key=(d['nev'].lower(), d['irsz'], d['utca'].lower(), d['hsz'].lower())
    if key in seen:
        flagged.append((pre,f"duplikátum: {seen[key]} címmel egyezik")); continue
    seen[key]=pre; final.append(d)

# 3) rendezés név szerint, XLSX
final.sort(key=lambda d:(d['nev'] or 'zzz'))
out_rows=[premises.HEAD]+[[d['nev'],d['irsz'],d['telep'],d['utca'],d['tip'],d['hsz'],'','','','',''] for d in final]
outp=os.path.join(tmp,OUTNAME)
premises.write_xlsx(outp,out_rows)
print(f"\n{len(final)} egyedi telephely sor -> {OUTNAME}",flush=True)

# 4) feltöltés
u=cli("put",outp,f"{DST}/{OUTNAME}")
print("upload:",re.search(r'HTTP \d+',u).group(0) if re.search(r'HTTP \d+',u) else u[-120:],flush=True)

# 5) flag riport
if flagged:
    print(f"\n=== ÁTNÉZENDŐ ({len(flagged)}) ===",flush=True)
    for pre,msg in flagged: print(f"  {pre}: {msg}",flush=True)
# helyi másolat is a scratchpadbe debughoz
import shutil; shutil.copy(outp, sys.argv[1] if len(sys.argv)>1 else "/tmp/"+OUTNAME)
print("kész",int(time.time()-t0),"s",flush=True)
