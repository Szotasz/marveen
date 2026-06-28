import re, subprocess, sys, os

# TV (tűzivízforrás) parser.
#
# Design (header-anchored, layout-agnostic):
# - ANCHOR each device on its Belső/helye line (leading ints + alphabetic helye);
#   pull the type/altípus/dates from a y-window around it. Handles both the
#   single-line layout and the stacked 3-band layout (helye / type / altípus on
#   separate y) without per-x column cuts.
# - TYPE is anchored semantically on the RIGHTMOST keyword
#   (tűzcsap/szivattyú/tartály/medence/...) + qualifier walk-left, so neither a
#   type prefix ("Nedves") leaking into helye nor a keyword inside helye
#   ("oxigén tartály mellett") misfires.
# - DATES use a wider window (the date cell straddles the main row by ~15px) and
#   per-page column detection. Many naplók render each device TWICE (one view per
#   inspection cycle) with COMPLEMENTARY dates, so identical (belső,helye,kód)
#   rows are deduped and their dates merged.
#
# Output dict per device -> import template (tuzivizforras-sablon):
#   belso -> A Belső Azonosító | helye -> B Vízforrás helye | code -> C Vízforrástípus
#   altipus -> D altípusa/űrtartalma | szerelvenyek -> F | idosz_date -> I Utolsó
#   időszakos felülvizsgálat | ue_date -> N Utolsó üzemeltetői ellenőrzés.
#   (G Utolsó nyomáspróba nincs megbízhatóan kinyerve -> üres, importőr tölti.)

# Vízforrástípus enum -- HITELES fiREG kódok (references/fireg-import-enum-spec.md,
# Attila 2026-06-25). Nincs generikus fallback: ami nem illik egy hiteles mintára,
# az flagelt ('', conf=False), és a fiREG-importőrnek (Hori) jelölendő.
TYPEMAP = [
    (r'nedves\s*fali\s*t[űu]zcsap',            'nedves_fali_tuzcsap'),
    (r'sz[áa]raz\s*fali\s*t[űu]zcsap',         'szaraz_fali_tuzcsap'),
    (r'f[öo]ld\s*feletti\s*t[űu]zcsap',        'fold_feletti_tuzcsap'),
    (r'f[öo]ld\s*alatti\s*t[űu]zcsap',         'fold_alatti_tuzcsap'),
    (r'sz[áa]raz\s*t[űu]ziv[íi]zvezet[ée]k',   'szaraz_tuzivizvezetek'),
    (r'h[űu]t[őo]torony',                       'hutotorony_vizmedenceje'),
    (r'nyitott\s*medence|nyitott\s*tart[áa]ly', 'nyitott_medence'),
    (r'z[áa]rt\s*medence|z[áa]rt\s*tart[áa]ly', 'zart_medence'),
    (r'nyom[áa]sfokoz[óo]\s*szivatty[úu]',     'nyomasfokozo_szivattyu'),
    (r'szerelv[ée]ny\s*szekr[ée]ny',           'szerelveny_szekreny'),
    (r'term[ée]szetes\s*v[íi]zforr[áa]s',      'termeszetes_vizforras'),
    (r'v[íi]zm[űu]\s*v[íi]zt[áa]rol[óo]',      'vizmu_viztarolo'),
]

# A type cell looks like "<qualifier> <keyword> / <code>".  We find the keyword,
# walk left across qualifier words, and take the "/ code" to the right as altípus.
KEYWORD = re.compile(r't[űu]zcsap|szivatty[úu]|tart[áa]ly|medenc|szekr[ée]ny|'
                     r'v[íi]zvezet[ée]k|v[íi]zforr[áa]s|v[íi]zt[áa]rol[óo]', re.I)
QUALIFIER = re.compile(r'^(nedves|sz[áa]raz|fali|f[öo]ld|feletti|alatti|nyom[áa]sfokoz[óo]|'
                       r'nyitott|z[áa]rt|h[űu]t[őo]torony|term[ée]szetes|v[íi]zm[űu]|'
                       r'szerelv[ée]ny|t[űu]ziv[íi]zvezet[ée]k|medence/tart[áa]ly)$', re.I)
DATE = re.compile(r'(20\d\d)\.(\d{2})\.?(\d{2})?')


def map_type(s):
    sl = s.lower()
    for pat, code in TYPEMAP:
        if re.search(pat, sl):
            return code, True   # hiteles kód -> igazolt
    # Hori döntése (2026-06-26): a minősítő nélküli bare "Tűzcsap" -> nedves fali
    # tűzcsap. CSAK a csupasz szóra (nem tűzcsapszekrény/egyéb zaj).
    if re.fullmatch(r't[űu]zcsap', sl.strip()):
        return 'nedves_fali_tuzcsap', True
    return '', False            # ismeretlen/kétértelmű -> flag


def iso_date(s):
    m = DATE.search(s)
    if not m:
        return ''
    y, mo, d = m.group(1), m.group(2), m.group(3)
    return f"{y}-{mo}-{d}" if d else f"{y}-{mo}"


def words_of(pdf):
    xml = subprocess.run(['pdftotext', '-bbox-layout', pdf, '-'],
                         capture_output=True, text=True).stdout
    pages = []
    for pg in re.split(r'<page ', xml)[1:]:
        ws = [(float(y), float(x), t) for x, y, t in re.findall(
            r'<word xMin="([0-9.]+)" yMin="([0-9.]+)" xMax="[0-9.]+" yMax="[0-9.]+">([^<]*)</word>', pg)]
        pages.append(ws)
    return pages


def cluster_lines(ws):
    """Group words into physical lines by y, return [(y, [(x,text),...]), ...]."""
    rowmap = {}
    for y, x, t in ws:
        rowmap.setdefault(round(y / 5), []).append((y, x, t))
    lines = []
    for k in sorted(rowmap):
        cells = sorted(rowmap[k], key=lambda e: e[1])
        ymean = sum(c[0] for c in cells) / len(cells)
        lines.append((ymean, [(x, t) for _, x, t in cells]))
    return lines


def header_anchors(ws):
    """x-position of the date column blocks from header labels. The columns are
    stable doc-wide, so we search ALL y (the header repeats at arbitrary y, even
    near a page bottom) and take the leftmost occurrence."""
    def fx(label):
        xs = [x for y, x, t in ws if t == label]
        return min(xs) if xs else None
    return fx('Üzemeltetői'), fx('Időszakos'), fx('Eszköz')


CODE_W1 = re.compile(r'^[A-Za-z]{1,3}\d{0,3}$')   # C52, C, D25, NA, B
CODE_W2 = re.compile(r'^(\d{1,4}|m3|mm)$')         # 52, 100, m3
TOMLO = re.compile(r'^(lapost[öo]ml[őo]|merevt[öo]ml[őo])$', re.I)  # tűzcsap altípus
# Belső Azonosító when it is an alphanumeric ID (FT1-H, TH2-A) rather than a plain
# number. Requires >=2 uppercase letters before the digits so a helye fragment
# ("B2 szoba") cannot be mistaken for an internal ID. Naplók that carry only an
# Ssz sequence number (no real ID) stay belső-empty and are correctly flagged.
BELSO_CODE = re.compile(r'^[A-ZÁÉÍÓÖŐÚÜŰ]{2,4}\d{1,4}(?:[-/][A-Z0-9]{1,4})?$')


def parse_type(rest_tokens):
    """rest_tokens = list of (x, word) after the leading Ssz/Belső ints.
    Returns (helye, tipus_raw, code, conf, altipus). Anchors on the keyword,
    NOT on x or on a slash that may live inside the helye text."""
    words = [t for _, t in rest_tokens]
    # type keyword = FIRST tűzcsap/szivattyú/... occurrence (helye won't contain it)
    kw_idx = next((i for i, w in enumerate(words) if KEYWORD.search(w)), None)
    if kw_idx is None:
        return ' '.join(words).strip(), '', '', False, ''
    # walk left over qualifier words to get the type-phrase start
    start = kw_idx
    while start - 1 >= 0 and QUALIFIER.match(words[start - 1]):
        start -= 1
    tipus_raw = ' '.join(words[start:kw_idx + 1]).strip()
    helye = ' '.join(words[:start]).strip()
    # altípus = code right after the FIRST '/' that comes after the keyword
    alt = ''
    slash_idx = next((i for i in range(kw_idx + 1, len(words)) if words[i] == '/'), None)
    if slash_idx is not None:
        tail = [w for w in words[slash_idx + 1:] if w not in ('-', '')]
        if tail and CODE_W1.match(tail[0]):
            alt = tail[0]
            if len(tail) > 1 and CODE_W2.match(tail[1]):
                alt = f"{tail[0]} {tail[1]}"
    code, conf = map_type(tipus_raw)
    return helye, tipus_raw, code, conf, alt


def fine_lines(ws, ytop):
    """Tight y-clustering of body words into physical lines."""
    rowmap = {}
    for y, x, t in ws:
        if y <= ytop:
            continue
        rowmap.setdefault(round(y / 3), []).append((y, x, t))
    out = []
    for k in sorted(rowmap):
        cs = sorted(rowmap[k], key=lambda e: e[1])
        ym = sum(c[0] for c in cs) / len(cs)
        out.append((ym, cs))
    return out


def helye_from_anchor(anchor_tokens):
    """anchor_tokens = words after the leading ints. helye = up to the type/date."""
    out = []
    for w in anchor_tokens:
        if KEYWORD.search(w) or QUALIFIER.match(w) or w == '/' or DATE.search(w):
            break
        out.append(w)
    return ' '.join(out).strip()


def extract(pdf):
    pages = words_of(pdf)
    # Per-page columns (the two copies of a duplicated napló live on separate
    # pages with different column x), with a doc-global fallback for any page
    # whose header label is missing.
    g_ue, g_idosz, g_megj = header_anchors([w for pg in pages for w in pg])
    devs = []
    for ws in pages:
        if not any(t == 'Készenléti' for y, x, t in ws):
            continue
        p_ue, p_idosz, p_megj = header_anchors(ws)
        # A duplicated napló's two views are single-column pages (only ÜE, or only
        # IF). Do NOT inject the absent column there -- it would mis-bucket dates.
        # Fall back to globals only when the page carries NO date header at all.
        if p_ue is None and p_idosz is None:
            ue_x, idosz_x = g_ue, g_idosz
        else:
            ue_x, idosz_x = p_ue, p_idosz
        megj_x = p_megj if p_megj is not None else g_megj
        # Headers repeat at arbitrary y (sometimes near the page bottom), so a
        # header-relative cut drops rows. We parse the whole page; the anchor +
        # type-gate below reject header/legend/sub-header lines on their own.
        ytop = 5
        lines = fine_lines(ws, ytop)

        # anchor lines = start with int(s) and carry alphabetic helye text
        anchors = []
        for li, (ym, cs) in enumerate(lines):
            toks = [t for _, _, t in cs]
            ni = 0
            while ni < len(toks) and ni < 2 and re.fullmatch(r'\d{1,4}\.?', toks[ni]):
                ni += 1
            if ni == 0:
                continue
            rest = toks[ni:]
            if not any(re.search(r'[A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]', w) for w in rest):
                continue
            anchors.append((ym, cs, ni, li))
        anchor_ys = [a[0] for a in anchors]

        for ai, (ym, cs, ni, li) in enumerate(anchors):
            ints = [t.rstrip('.') for _, _, t in cs[:ni]]
            nb = ni
            ctoks = [t for _, _, t in cs]
            # Belső az. = the LAST leading number. With two leading ints the first
            # is the Ssz and the second is the Belső id ("1 18" -> 18); with a
            # single leading int that number IS the Belső id ("2 H épület" -> 2,
            # the ids are non-consecutive so they are real, not a row counter).
            # An alphanumeric id (FT1-H) right after a single Ssz int wins instead.
            if len(ints) < 2 and ni < len(ctoks) and BELSO_CODE.match(ctoks[ni]):
                belso = ctoks[ni]
                nb = ni + 1
            else:
                belso = ints[-1] if ints else ''
            anchor_tokens = [t for _, _, t in cs[nb:]]
            # window around the anchor, clamped to neighbour anchors
            lo = ym - 8
            hi = ym + 11
            if ai > 0:
                lo = max(lo, anchor_ys[ai - 1] + 2)
            if ai + 1 < len(anchors):
                hi = min(hi, anchor_ys[ai + 1] - 2)
            wlines = [(y2, cs2) for y2, cs2 in lines if lo <= y2 <= hi]

            # Pick the TYPE keyword. A keyword may also appear inside helye
            # ("oxigén tartály mellett"), so prefer the one in the type column:
            # keyword immediately followed by '/', and a valid enum code; among
            # ties take the rightmost. Rank = (has_slash, valid_code, ki).
            best = None  # (rank, y2, st, ki, cs2, slash)
            for y2, cs2 in wlines:
                toks2 = [t for _, _, t in cs2]
                for ki in [i for i, w in enumerate(toks2) if KEYWORD.search(w)]:
                    slash = next((j for j in range(ki + 1, len(toks2)) if toks2[j] == '/'), None)
                    has_slash = slash is not None and slash - ki <= 2
                    st = ki
                    while st - 1 >= 0 and QUALIFIER.match(toks2[st - 1]):
                        st -= 1
                    _, ok = map_type(' '.join(toks2[st:ki + 1]))
                    rank = (1 if has_slash else 0, 1 if ok else 0, ki)
                    if best is None or rank > best[0]:
                        best = (rank, y2, st, ki, cs2, slash)

            # wider band (clamped to neighbours) for type-spread layouts where the
            # qualifier / altípus-digits / helye sit on a separate y from the keyword
            alo, ahi = ym - 16, ym + 16
            if ai > 0:
                alo = max(alo, (anchor_ys[ai - 1] + ym) / 2)
            if ai + 1 < len(anchors):
                ahi = min(ahi, (ym + anchor_ys[ai + 1]) / 2)
            auglines = [(y2, cs2) for y2, cs2 in lines if alo <= y2 <= ahi]

            tipus_raw, code, conf, alt = '', '', False, ''
            helye = helye_from_anchor(anchor_tokens)
            if best is not None:
                _, by2, st, ki, cs2, slash = best
                toks2 = [t for _, _, t in cs2]
                kx = cs2[ki][1]
                # Some layouts spread the type across y-bands: "Nedves fali" above,
                # "tűzcsap / C" on the main line, "52" below. Pull the qualifier
                # from the band above and the altípus digits from the band below,
                # within the type column x-range.
                quals_above = sorted(
                    [(x, t) for y, cs3 in auglines for _, x, t in cs3
                     if by2 - 13 <= y < by2 - 2 and kx - 70 <= x <= kx + 60 and QUALIFIER.match(t)])
                same = toks2[st:ki]
                tipus_raw = ' '.join([t for _, t in quals_above] + same + [toks2[ki]]).strip()
                code, conf = map_type(tipus_raw)
                if slash is not None:
                    tail = [w for w in toks2[slash + 1:] if w not in ('-', '')]
                    if tail and CODE_W1.match(tail[0]):
                        alt = tail[0]
                        if len(tail) > 1 and CODE_W2.match(tail[1]):
                            alt = f"{tail[0]} {tail[1]}"
                if alt and not re.search(r'\d', alt):   # code letter only -> digits below
                    below = sorted(
                        [(x, t) for y, cs3 in auglines for _, x, t in cs3
                         if by2 + 2 < y <= by2 + 13 and kx - 30 <= x <= kx + 95
                         and re.fullmatch(r'\d{1,4}', t)])
                    if below:
                        alt = f"{alt} {below[0][1]}"
                # if the type sits on the anchor line, helye = tokens before it
                if abs(by2 - ym) < 0.1:
                    helye = ' '.join(toks2[nb:st]).strip()
                # helye on its own band (type-only anchor line): collect left of type
                if not helye:
                    hw = sorted(
                        [(y, x, t) for y, cs3 in auglines for _, x, t in cs3
                         if by2 - 9 <= y <= by2 + 2 and x < kx - 45
                         and not re.fullmatch(r'\d{1,4}\.?', t) and not DATE.search(t)
                         and re.search(r'[A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]', t)],
                        key=lambda e: (round(e[0] / 4), e[1]))
                    helye = ' '.join(t for _, _, t in hw).strip()
            # altípus on its own band: a diameter code (C52) OR a tömlő word
            # (Lapostömlő/Merevtömlő) in the type column near the keyword.
            if not alt and best is not None:
                for y, cs3 in auglines:
                    for _, x2, t2 in cs3:
                        if not (kx - 50 <= x2 <= kx + 130):
                            continue
                        if (CODE_W1.match(t2) and re.search(r'\d', t2)) or TOMLO.match(t2):
                            alt = t2
                            break
                    if alt:
                        break
            if not tipus_raw:   # every vízforrás has a type; filters stray header lines
                continue

            # Dates use a WIDER window than the type: in single-copy layouts the
            # date cell straddles the main row (ym-15 .. ym+15). Clamp to the
            # anchor midpoints so it cannot bleed into a neighbouring device.
            dlo, dhi = ym - 18, ym + 18
            if ai > 0:
                dlo = max(dlo, (anchor_ys[ai - 1] + ym) / 2)
            if ai + 1 < len(anchors):
                dhi = min(dhi, (ym + anchor_ys[ai + 1]) / 2)
            ue_date, idosz_date = '', ''
            for y2, cs2 in lines:
                if not (dlo <= y2 <= dhi):
                    continue
                for _, x2, t2 in cs2:
                    if not DATE.search(t2):
                        continue
                    diso = iso_date(t2)
                    if not diso:
                        continue
                    if idosz_x is not None and x2 >= idosz_x - 6 and (megj_x is None or x2 < megj_x - 10):
                        idosz_date = max(idosz_date, diso)
                    elif ue_x is not None and x2 >= ue_x - 40 and (idosz_x is None or x2 < idosz_x - 6):
                        ue_date = max(ue_date, diso)

            # szerelvények: continuation lines between this anchor and the next
            szerelvenyek = []
            for y2, cs2 in lines:
                if not (ym < y2 <= hi + 4):
                    continue
                txt = re.sub(r'\s+', ' ', ' '.join(t for _, _, t in cs2)).strip()
                low = txt.lower()
                if '(szerelvény)' in low or 'sugárcső' in low or 'tömlő' in low:
                    sz = re.sub(r'\(szerelvény\)', '', txt).strip(' /-')
                    if sz and not DATE.search(sz):
                        szerelvenyek.append(re.sub(r'\s+', ' ', sz))

            devs.append(dict(belso=belso, helye=helye, tipus_raw=tipus_raw, code=code,
                             conf=conf, altipus=alt, szerelvenyek=szerelvenyek,
                             ue_date=ue_date, idosz_date=idosz_date))

    # Many TV naplók render each device TWICE (one copy per inspection-cycle view),
    # and the two copies carry COMPLEMENTARY dates (one ÜE, one IF). Merge identical
    # (belső, helye, code) rows, combining dates/altípus/szerelvény. Docs that list
    # each device once have unique keys and are left untouched.
    merged, order = {}, []
    for x in devs:
        k = (x['belso'], re.sub(r'\s+', ' ', x['helye']).strip().lower(), x['code'])
        if k not in merged:
            merged[k] = dict(x)
            order.append(k)
        else:
            m = merged[k]
            m['ue_date'] = max(m['ue_date'], x['ue_date'])
            m['idosz_date'] = max(m['idosz_date'], x['idosz_date'])
            if not m['altipus']:
                m['altipus'] = x['altipus']
            if len(x['szerelvenyek']) > len(m['szerelvenyek']):
                m['szerelvenyek'] = x['szerelvenyek']
    return [merged[k] for k in order]


if __name__ == '__main__':
    for pdf in sys.argv[1:]:
        d = extract(pdf)
        n = len(d) or 1
        codes = {}
        for x in d:
            k = x['code'] or ('?' + x['tipus_raw'])
            codes[k] = codes.get(k, 0) + 1
        fb = sum(1 for x in d if x['belso'])
        fh = sum(1 for x in d if x['helye'])
        ft = sum(1 for x in d if x['code'])
        fc = sum(1 for x in d if x['conf'])
        fa = sum(1 for x in d if x['altipus'])
        fu = sum(1 for x in d if x['ue_date'])
        fi = sum(1 for x in d if x['idosz_date'])
        print(f"\n### {os.path.basename(pdf)[:34]}: {len(d)} eszköz")
        print(f"    belső {fb*100//n}% helye {fh*100//n}% típuskód {ft*100//n}% (igazolt {fc*100//n}%) "
              f"altípus {fa*100//n}% ÜE-dátum {fu*100//n}% IF-dátum {fi*100//n}%")
        print(f"    típuskódok: {codes}")
        for x in d[:4]:
            print(f"  {x['belso']:>3} | {x['helye'][:34]:34} | {x['code']:20} | alt={x['altipus'][:8]:8} "
                  f"| ÜE={x['ue_date']:10} IF={x['idosz_date']:10} | szer={len(x['szerelvenyek'])}")
