import sys, os, re, subprocess, tempfile, time, zipfile, html
sys.path.insert(0, os.path.dirname(__file__))
import premises  # reuse child-name (dashed header) + address parsing helpers

SYS = "/usr/bin/python3"
CLI = "/root/marveen/scripts/owncloud-cli.py"
SRC = "fiREG közös/temp/KEF"
CACHE = "/root/marveen/store/kef-listing.txt"
OUTDIR = "/root/marveen/store/kef-telephely"

TYPE = r'(?:TK|TV|TG|TGV|EA|HFR|FG|TCS|HAV)'


def cli(*a):
    return subprocess.run([SYS, CLI, *a], capture_output=True, text=True).stdout


def field(txt, label):
    """Value after 'LABEL:' up to a 2+ space gap / EOL (column boundary)."""
    m = re.search(label + r'\s*:\s*(.+?)(?:\s{2,}|\n|$)', txt)
    return re.sub(r'\s+', ' ', m.group(1)).strip().rstrip('.') if m else ''


BOILER = ('megfelel', 'rendelet', 'tvmi', '§', 'szabvány', 'szabvany', 'pontja',
          'nyomtatás', 'fájl készült', 'további információ')


def header_line(txt):
    """The top-of-page header naming the site. Prefer the dashed full line
    (Parent - Telephely ...); else the centered parent-name line. This is the
    reliable source -- the 'KÉSZENLÉTBEN TARTÓ NEVE:' field wraps to multiple
    lines on many naplók and yields fragments."""
    lines = [re.sub(r'\s+', ' ', l).strip() for l in txt.split('\n') if l.strip()]
    for i, l in enumerate(lines):
        if 'üzemeltetési napló' in l.lower():
            cand = [c for c in lines[i + 1:i + 6] if not any(b in c.lower() for b in BOILER)]
            dashed = [c for c in cand if ' - ' in c]
            return dashed[0] if dashed else (cand[0] if cand else '')
    return ''


def extract(pdf):
    txt = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True).stdout
    parent_addr = field(txt, r'KÉSZENLÉTBEN TARTÓ CÍME')
    child_addr = field(txt, r'KÉSZENLÉTBEN TARTÓ TELEPHELY CÍME')
    hdr = header_line(txt)
    # parent = first segment of the dashed header; rest = the telephely.
    # No dash => the napló is the parent's OWN main site (székhely).
    if ' - ' in hdr:
        parent = hdr.split(' - ')[0].strip()
        cshort = hdr.split(' - ', 1)[1].strip()
        cname = hdr
    else:
        parent = hdr
        cshort = '(székhely)'
        cname = hdr
    # main-site napló: the site IS the parent, so its address is the parent CÍME
    if cshort == '(székhely)' and not child_addr:
        child_addr = parent_addr
    return dict(parent=parent, parent_addr=parent_addr, child_full=cname,
                child_short=cshort, child_addr=child_addr)


_FOLD = str.maketrans('áéíóöőúüűÁÉÍÓÖŐÚÜŰ', 'aeiooouuuaeiooouuu')


def norm(s):
    """Grouping key: lowercase, accent-folded, whitespace/hyphen-collapsed so
    pure typo variants (Oktatókórház/Oktatókorház, 'Bács- Kiskun') merge."""
    s = re.sub(r'\s+', ' ', s).strip().lower().translate(_FOLD)
    return re.sub(r'\s*-\s*', '-', s)


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    listing = open(CACHE).read()
    files = re.findall(r'([A-Za-z0-9_]+_\d{4}_' + TYPE + r'_UN(?:_I+)?\.pdf)', listing)
    by_prefix = {}
    for fn in files:
        pre = re.sub(r'_\d{4}_' + TYPE + r'_UN(?:_I+)?\.pdf$', '', fn)
        by_prefix.setdefault(pre, fn)   # keep first file per prefix
    prefixes = sorted(by_prefix)
    print(f"{len(prefixes)} egyedi telephely-prefix", flush=True)

    tmp = tempfile.mkdtemp(prefix="kef_tree_")
    rows = []       # (prefix, acronym, fields)
    flags = []
    t0 = time.time()
    for i, pre in enumerate(prefixes, 1):
        fn = by_prefix[pre]
        lp = os.path.join(tmp, fn)
        cli("get", f"{SRC}/{fn}", lp)
        if not os.path.exists(lp):
            flags.append((pre, "letöltés sikertelen")); continue
        d = extract(lp)
        os.remove(lp)
        acr = pre.split('_')[0]
        miss = [k for k in ('parent', 'child_addr') if not d[k]]
        if miss:
            flags.append((pre, "hiányzó: " + ",".join(miss)))
        rows.append((pre, acr, d))
        if i % 25 == 0:
            np = len(set(norm(r[2]['parent']) for r in rows if r[2]['parent']))
            print(f"[{i}/{len(prefixes)}] {int(time.time()-t0)}s, {np} szülő-intézmény eddig", flush=True)

    # cross-check: an acronym should map to ONE parent name
    acr_parents = {}
    for pre, acr, d in rows:
        if d['parent']:
            acr_parents.setdefault(acr, {}).setdefault(norm(d['parent']), d['parent'])
    for acr, pm in acr_parents.items():
        if len(pm) > 1:
            flags.append((acr + "*", "PREFIX-ÜTKÖZÉS: egy acronym több szülő: " + " | ".join(pm.values())))

    # group by NORMALISED parent (merges typo/whitespace variants); display the
    # longest original spelling seen for that institution.
    groups = {}
    for pre, acr, d in rows:
        key = norm(d['parent']) if d['parent'] else f"?{pre}"
        g = groups.setdefault(key, dict(disp=d['parent'] or f"(ismeretlen szülő: {pre})",
                                        addr='', children=[]))
        if len(d['parent']) > len(g['disp']):
            g['disp'] = d['parent']
        if not g['addr'] and d['parent_addr']:
            g['addr'] = d['parent_addr']
        g['children'].append(d)
    groups = {g['disp']: g for g in groups.values()}   # re-key by display name

    # (a) readable text tree
    tree_path = os.path.join(OUTDIR, "telephely-fa.txt")
    with open(tree_path, "w", encoding="utf-8") as f:
        f.write(f"KEF telephely-fa (szülő -> gyerek) / {len(groups)} szülő-intézmény, "
                f"{len(rows)} telephely\n\n")
        for parent in sorted(groups):
            g = groups[parent]
            f.write(f"# {parent}")
            if g['addr']:
                f.write(f"  ({g['addr']})")
            f.write(f"   [{len(g['children'])} telephely]\n")
            for c in sorted(g['children'], key=lambda x: x['child_short'] or x['child_full']):
                name = c['child_short'] or c['child_full'] or '(névtelen)'
                f.write(f"    - {name}")
                if c['child_addr']:
                    f.write(f"  |  {c['child_addr']}")
                f.write("\n")
            f.write("\n")

    # (b) premises_hu.xlsx with Telephelykapcsolat: 1 = parent
    rowsx = [premises.HEAD]
    for pre, acr, d in sorted(rows, key=lambda r: (norm(r[2]['parent']), r[0])):
        # parse child address into the premises columns
        p = premises.parse  # reuse address parsing via a synthetic call is hard; do inline
        irsz = telep = utca = tip = hsz = ''
        m = re.match(r'(\d{4})\s+(.+)', d['child_addr'])
        if m:
            irsz = m.group(1); rest = m.group(2).rstrip('.')
            cm = re.match(r'(.+?)\s*,\s*(.+?)\s+' + premises.UTCATIP + r'\.?\s+([0-9][0-9/A-Za-z\-]*)\b.*$',
                          rest, re.IGNORECASE)
            if cm:
                telep, utca, tip, hsz = (cm.group(1).strip(), cm.group(2).strip(),
                                         cm.group(3).strip().rstrip('.'), cm.group(4).strip().rstrip('.'))
            else:
                parts = rest.split(',', 1)
                telep = parts[0].strip(); utca = parts[1].strip().rstrip('.') if len(parts) > 1 else ''
        name = d['child_full'] or d['child_short']
        rowsx.append([name, irsz, telep, utca, tip, hsz, d['parent'], '', '', '', ''])
    xlsx_path = os.path.join(OUTDIR, "kef-telephely-fa_premises.xlsx")
    premises.write_xlsx(xlsx_path, rowsx)

    # flag report
    flag_path = os.path.join(OUTDIR, "telephely-flag.txt")
    with open(flag_path, "w", encoding="utf-8") as f:
        f.write(f"KEF telephely-fa flag-riport / {len(flags)} tétel\n\n")
        for pre, msg in flags:
            f.write(f"  {pre}: {msg}\n")

    print(f"\n=== KÉSZ: {len(rows)} telephely, {len(groups)} szülő-intézmény, "
          f"{len(flags)} flag, {int(time.time()-t0)}s ===", flush=True)
    print(f"FA:   {tree_path}", flush=True)
    print(f"XLSX: {xlsx_path}", flush=True)
    print(f"FLAG: {flag_path}", flush=True)


if __name__ == '__main__':
    main()
