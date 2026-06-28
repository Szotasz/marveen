import sys, os, re, subprocess, tempfile, json
sys.path.insert(0, os.path.dirname(__file__))
import telephely_tree as tt
SYS="/usr/bin/python3"; CLI="/root/marveen/scripts/owncloud-cli.py"; SRC="fiREG közös/temp/KEF"
CACHE=open("/root/marveen/store/kef-listing.txt").read()
TYPE=tt.TYPE
files=re.findall(r'([A-Za-z0-9_]+_\d{4}_'+TYPE+r'_UN(?:_I+)?\.pdf)', CACHE)
by_prefix={}
for fn in files:
    pre=re.sub(r'_\d{4}_'+TYPE+r'_UN(?:_I+)?\.pdf$','',fn)
    by_prefix.setdefault(pre,fn)
tmp=tempfile.mkdtemp(prefix="cache_t_")
out={}
for i,(pre,fn) in enumerate(sorted(by_prefix.items()),1):
    lp=os.path.join(tmp,fn)
    subprocess.run([SYS,CLI,"get",f"{SRC}/{fn}",lp],capture_output=True)
    if not os.path.exists(lp):
        out[pre]={"err":"download"}; continue
    d=tt.extract(lp); d["acr"]=pre.split('_')[0]; d["prefix"]=pre; d["file"]=fn
    out[pre]=d; os.remove(lp)
    if i%40==0: print(f"  {i}/{len(by_prefix)}",flush=True)
json.dump(out, open("/root/marveen/store/kef-telephely/prefix-cache.json","w"), ensure_ascii=False, indent=0)
print(f"CACHED {len(out)} prefix -> /root/marveen/store/kef-telephely/prefix-cache.json",flush=True)
