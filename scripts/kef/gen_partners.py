import sys, os, re, json, zipfile, html
sys.path.insert(0, os.path.dirname(__file__))
import premises  # address parser (UTCATIP) + xlsx writer helpers

CACHE = "/root/marveen/store/kef-telephely/prefix-cache.json"
TAXFILE = "/root/marveen/store/kef-telephely/partner-adoszamok.txt"
OUTDIR = "/root/marveen/store/kef-telephely/partner-import"
PARTNER_TMPL = "/root/marveen/store/fireg-import-templates/partners_hu.xlsx"

_FOLD = str.maketrans('áéíóöőúüűÁÉÍÓÖŐÚÜŰ', 'aeiooouuuaeiooouuu')
def norm(s):
    s = re.sub(r'\s+', ' ', (s or '')).strip().lower().translate(_FOLD)
    return re.sub(r'\s*-\s*', '-', s)

# --- Attila 11 merge-decisions, applied as a canonical-parent mapper. ---
# Reclassify: these prefixes are a CHILD telephely of a county parent, not a parent.
RECLASS = {
    'BKVO_Repulokorhaz': 'Bács-Kiskun Vármegyei Oktatókórház',   # decision 10
    'ZVK_Ady':           'Zala Vármegyei Szent Rafael Kórház',   # decision 11
}
# Canonical display name per normalised extracted-parent (merges variants -> 1).
# Built from the tax-file authoritative names where they exist.
CANON = {
    norm('Győr-Moson-Sopron Vármegyei Petz Aladár Egyetemi Oktató Kórház'): 'Petz Aladár Egyetemi Oktató Kórház',
    norm('Petz Aladár Egyetemi Oktató Kórház'): 'Petz Aladár Egyetemi Oktató Kórház',
    norm('Győr-Moson-Sopron Vármegyei'): 'Petz Aladár Egyetemi Oktató Kórház',   # truncation
    norm('Heves Vármegyei Markhot Ferenc Oktatókórház és Rendelőintézet'): 'Heves Vármegyei Markhot Ferenc Oktatókórház és Rendelőintézet',
    norm('Jász-Nagykun-Szolnok Vármegyei Hetényi Géza Kórház-Rendelőintézet'): 'Jász-Nagykun-Szolnok Vármegyei Hetényi Géza Kórház-Rendelőintézet',
    norm('Jász-Nagykun Szolnok vármegyei Hetényi Géza Kórház'): 'Jász-Nagykun-Szolnok Vármegyei Hetényi Géza Kórház-Rendelőintézet',
    norm('Bács-Kiskun Vármegyei Oktatókórház'): 'Bács-Kiskun Vármegyei Oktatókórház',
    norm('Hatvani Albert Schweitzer Kórház'): 'Albert Schweitzer Kórház-Rendelőintézet',
    norm('Dél-budai Centrumkórház Szent Imre Egyetemi Oktatókórház'): 'Dél-budai Centrumkórház Szent Imre Egyetemi Oktatókórház',
}
# Per-parent overrides keyed by a distinctive name SUBSTRING (robust to display
# variants). székhely = corrected seat where the napló mis-states it (county HQ);
# ado_empty = leave the Adószám blank (Attila/research: not found / conflict /LOW).
OVERRIDES = [
    # (name-substring, székhely-fix or None, ado_empty, székhely-uncertain-flag)
    ('Selye János',          '2921 Komárom, Beöthy Zsolt utca 4',        True,  True),
    ('Tatai Árpád',          '2890 Tata, Hősök tere 2',                  True,  False),
    ('Kapuvári Lumniczer',   '9330 Kapuvár, Dr. Lumniczer Sándor utca 7', True, False),
    ('Albert Schweitzer',    '3000 Hatvan, Balassi Bálint út 16',        False, False),
    ('Jászberényi Szent Erzsébet', '5100 Jászberény, Szelei út 2',       False, False),
    ('Orosházi Dr. László',  '5900 Orosháza, Könd utca 59',              False, False),
    ('Siófok',               '8600 Siófok, Fő utca 132',                 False, True),
    # county parents whose parent_addr field is mis-attributed in some naplók:
    ('Petz Aladár',          '9024 Győr, Vasvári Pál utca 2-4',          False, False),
    ('Bács-Kiskun Vármegyei Oktatókórház', '6000 Kecskemét, Nyíri út 38', False, False),
    # research said leave Adószám empty (LOW / not found):
    ('Dorogi Szent Borbála', None,                                       True,  False),
    ('Országos Mentális',    None,                                       True,  False),
    ('Parádfürdői',          None,                                       True,  False),
    ('Tüdőgyógyintézet',     None,                                       True,  False),
]
def override_for(name):
    for sub, sz, emp, flag in OVERRIDES:
        if norm(sub) in norm(name):
            return sz, emp, flag
    return None, False, False


def base_name(s):
    """Strip trailing sub-unit suffixes / duplicated last word so decision-merges
    (FMK +Szakambulancia, Dorogi +Szakrendelő, Markhot Rendelőintézet x2) collapse."""
    s = re.sub(r'\s+', ' ', s or '').strip()
    s = re.sub(r'\s*-?\s*\d+-es Számú Szakambulancia$', '', s, flags=re.I)
    s = re.sub(r'\s+Szakrendelő$', '', s)
    s = re.sub(r'(\b\w+)\s+\1$', r'\1', s)   # "... Rendelőintézet Rendelőintézet" -> "... Rendelőintézet"
    return s.strip()


def canon_parent(prefix, extracted):
    if prefix in RECLASS:
        return RECLASS[prefix]
    n = norm(extracted)
    if n in CANON:
        return CANON[n]
    return re.sub(r'\s+', ' ', (extracted or '')).strip()


def load_tax():
    tax = []
    for l in open(TAXFILE, encoding='utf-8'):
        l = l.strip()
        if not l or l.startswith('#'):
            continue
        parts = [p.strip() for p in l.split('|')]
        if len(parts) >= 4 and parts[3] == 'HIGH':
            tax.append((parts[0], parts[1], parts[2]))
    return tax


def match_tax(name, city, tax):
    nn, nc = norm(name), norm(city)
    for tn, tc, ado in tax:
        if norm(tn) == nn:
            return ado
    cands = [(len(set(norm(tn).split()) & set(nn.split())), ado, tn)
             for tn, tc, ado in tax if norm(tc) == nc]
    if not cands:
        return ''
    cands.sort(reverse=True)
    # a city with a single tax entry is unambiguous -> accept on city alone;
    # a shared city (Budapest) needs >=2 name-token overlap.
    city_count = sum(1 for _, tc, _ in tax if norm(tc) == nc)
    if cands[0][0] >= 2 or city_count == 1:   # shared city -> need name overlap; unique city -> unambiguous
        return cands[0][1]
    return ''


def split_addr(addr):
    irsz = telep = utca = tip = hsz = ''
    m = re.match(r'\s*(\d{4})\s+(.+)', addr or '')
    if not m:
        return irsz, telep, utca, tip, hsz
    irsz = m.group(1); rest = re.sub(r'\s+', ' ', m.group(2)).strip().rstrip('.')
    cm = re.match(r'(.+?)\s*,\s*(.+?)\s+' + premises.UTCATIP + r'\.?\s+([0-9][0-9/A-Za-z\-]*)\b.*$', rest, re.IGNORECASE)
    if cm:
        telep, utca, tip, hsz = cm.group(1).strip(), cm.group(2).strip(), cm.group(3).strip().rstrip('.'), cm.group(4).strip().rstrip('.')
    else:
        parts = rest.split(',', 1)
        telep = parts[0].strip(); utca = parts[1].strip().rstrip('.') if len(parts) > 1 else ''
    return irsz, telep, utca, tip, hsz


def colref(n):
    s = ''; n += 1
    while n:
        n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s

def cell(ci, ri, v):
    return f'<c r="{colref(ci)}{ri}" t="inlineStr"><is><t xml:space="preserve">{html.escape(str(v))}</t></is></c>'

def write_xlsx(path, tmpl, rows):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
           f'<dimension ref="A1:{colref(max(len(r) for r in rows)-1)}{len(rows)}"/><sheetData>']
    for ri, r in enumerate(rows, 1):
        out.append(f'<row r="{ri}">' + ''.join(cell(ci, ri, c) for ci, c in enumerate(r)) + '</row>')
    out.append('</sheetData></worksheet>')
    zin = zipfile.ZipFile(tmpl, 'r')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for it in zin.infolist():
            data = zin.read(it.filename)
            if it.filename == 'xl/worksheets/sheet1.xml':
                data = ''.join(out).encode('utf-8')
            zout.writestr(it, data)
    zin.close()


def safe(name):
    return re.sub(r'[^A-Za-z0-9._-]+', '_', name)[:60]


PARTNER_HEAD = ['Név', 'Adószám', 'Székhely: irányítószám', 'Székhely: város',
                'Székhely: utca', 'Székhely: utca típus', 'Székhely: házszám',
                'Partnerkapcsolat: név', 'Partnerkapcsolat: email', 'Partnerkapcsolat: telefon']


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    tdir = os.path.join(OUTDIR, 'telephelyek')
    os.makedirs(tdir, exist_ok=True)
    for old in os.listdir(tdir):   # clear stale per-parent files from earlier runs
        os.remove(os.path.join(tdir, old))
    d = json.load(open(CACHE, encoding='utf-8'))
    tax = load_tax()

    groups = {}   # norm-key -> dict(disp, p_addrs, children)
    flags = []
    for pre, v in sorted(d.items()):
        if 'err' in v:
            flags.append((pre, 'letöltés hiba')); continue
        ext = v.get('parent') or ''
        if not ext and pre not in RECLASS:
            flags.append((pre, 'nincs szülő (parent üres) -> Attila külön nézi')); continue
        cp = base_name(canon_parent(pre, ext))
        key = norm(cp)   # merges typo/accent/length variants (decisions 7,8 + Markhot/Markusovszky dups)
        g = groups.setdefault(key, dict(disp=cp, p_addrs=[], children=[]))
        if len(cp) > len(g['disp']):
            g['disp'] = cp
        if v.get('parent_addr'):
            g['p_addrs'].append(v['parent_addr'])
        child_name = v.get('child_short') or v.get('child_full') or pre
        g['children'].append((child_name, v.get('child_addr') or '', pre))
    groups = {g['disp']: g for g in groups.values()}   # re-key by display name

    # build partner rows + per-parent telephely files
    partner_rows = [PARTNER_HEAD]
    summary = []
    for cp in sorted(groups):
        g = groups[cp]
        sz_fix, ado_empty, sz_flag = override_for(cp)
        # székhely: override where mis-attributed, else most common parent_addr
        sz = sz_fix if sz_fix else (max(set(g['p_addrs']), key=g['p_addrs'].count) if g['p_addrs'] else '')
        irsz, telep, utca, tip, hsz = split_addr(sz)
        ado = '' if ado_empty else match_tax(cp, telep, tax)
        partner_rows.append([cp, ado, irsz, telep, utca, tip, hsz, '', '', ''])
        if sz_flag:
            flags.append((cp, f'SZÉKHELY: a napló nem ad külön székhelyt, a PDF telephely-címét tettem be: {sz} -> Attila erősítse meg az official seat-et'))
        if not ado:
            flags.append((cp, 'Adószám ÜRES (a 7 kézi/LOW tétel egyike, vagy nincs biztos match) -> kézi'))
        # per-parent telephely file
        ch_rows = [premises.HEAD]
        for cn, ca, pre in sorted(g['children']):
            ci, ct, cu, cp2, ch = split_addr(ca)
            ch_rows.append([cn, ci, ct, cu, cp2, ch, '', '', '', '', ''])
        write_xlsx(os.path.join(OUTDIR, 'telephelyek', f'{safe(cp)}.xlsx'), premises.TEMPLATE, ch_rows)
        summary.append((cp, telep or '?', ado or 'ÜRES', len(g['children'])))

    write_xlsx(os.path.join(OUTDIR, 'kef-partnerek_partner-import.xlsx'), PARTNER_TMPL, partner_rows)

    # review summary + flags
    print(f"=== {len(groups)} kanonikus partner (szülő), {sum(s[3] for s in summary)} telephely ===")
    for cp, city, ado, nch in summary:
        print(f"  {cp[:50]:50} | {city[:16]:16} | adó:{ado:18} | {nch} telephely")
    flags = list(dict.fromkeys(flags))   # dedup, preserve order
    print(f"\n=== FLAG ({len(flags)}) ===")
    for k, m in flags:
        print(f"  {k}: {m}")
    with open(os.path.join(OUTDIR, 'partner-flag.txt'), 'w', encoding='utf-8') as f:
        f.write(f"KEF partner-generálás flag-riport / {len(flags)} tétel\n\n")
        for k, m in flags:
            f.write(f"  {k}: {m}\n")
    print(f"\nPARTNER XLSX: {OUTDIR}/kef-partnerek_partner-import.xlsx")
    print(f"TELEPHELY XLSX-ek: {OUTDIR}/telephelyek/ ({len(groups)} fájl)")


if __name__ == '__main__':
    main()
