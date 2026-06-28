import sys, os, re, subprocess, tempfile, time
sys.path.insert(0, os.path.dirname(__file__))
import ea
from gen_ea import write_xlsx

SYS = "/usr/bin/python3"
CLI = "/root/marveen/scripts/owncloud-cli.py"
SRC = "fiREG közös/temp/KEF"
DST = "fiREG közös/temp/KEF/_import_kesz/EA"
CACHE = "/root/marveen/store/kef-listing.txt"
DRY = os.environ.get("DRY") == "1"


def cli(*a):
    return subprocess.run([SYS, CLI, *a], capture_output=True, text=True).stdout


if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
    files = [l.strip() for l in open(sys.argv[1]) if l.strip()]
else:
    files = sorted(set(re.findall(r'[A-Za-z0-9_]+_\d{4}_EA_UN\.pdf', open(CACHE).read())))
print(f"{len(files)} EA PDF {'(DRY, nincs upload)' if DRY else ''}", flush=True)

tmp = tempfile.mkdtemp(prefix="kef_ea_")
if not DRY:
    subprocess.run([SYS, CLI, "mkdir", DST], capture_output=True)

ok = err = 0
flagged = []
t0 = time.time()
for i, fn in enumerate(files, 1):
    base = fn[:-4]
    lp = os.path.join(tmp, fn)
    try:
        cli("get", f"{SRC}/{fn}", lp)
        if not os.path.exists(lp):
            raise RuntimeError("letöltés sikertelen")
        devs = ea.extract(lp)
        if not devs:
            raise RuntimeError("0 eszköz kinyerve")
        xp = os.path.join(tmp, base + ".xlsx")
        write_xlsx(xp, devs)
        n = len(devs)
        noflag = sum(1 for d in devs if not d['code'])
        nodate = sum(1 for d in devs if not (d['ue_date'] or d['idosz_date']))
        nobelso = sum(1 for d in devs if not d['belso'])
        reasons = []
        if noflag:
            reasons.append(f"{noflag}/{n} ismeretlen típuskód")
        if nobelso * 100 // n > 20:
            reasons.append(f"{nobelso}/{n} belső nélkül")
        if nodate * 100 // n > 20:
            reasons.append(f"{nodate}/{n} dátum nélkül")
        if reasons:
            flagged.append((base, "; ".join(reasons)))
        if not DRY:
            u = cli("put", xp, f"{DST}/{base}.xlsx")
            if "HTTP 2" not in u:
                raise RuntimeError("upload: " + u[-80:])
        ok += 1
        if i % 20 == 0 or DRY:
            print(f"[{i}/{len(files)}] OK {base} ({n} eszk, {n-noflag} kód, {n-nodate} dátum)", flush=True)
        if os.path.exists(xp) and not DRY:
            os.remove(xp)
        os.remove(lp)
    except Exception as e:
        err += 1
        flagged.append((base, f"HIBA: {e}"))
        print(f"[{i}/{len(files)}] HIBA {base}: {e}", flush=True)

print(f"\n=== KÉSZ: {ok} sikeres, {err} hiba, {int(time.time()-t0)}s ===", flush=True)
if flagged:
    print(f"=== ÁTNÉZENDŐ ({len(flagged)}) ===", flush=True)
    for b, m in flagged:
        print(f"  {b}: {m}", flush=True)
