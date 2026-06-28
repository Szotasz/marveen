import re, sys, os, html
sys.path.insert(0, os.path.dirname(__file__))
import tv  # words_of / fine_lines / DATE / iso_date

# VK (vészkijárat / menekülési ajtó, TGV naplók) parser. Same hybrid layout as
# HFR (section-grouped type + EA-style column rows, alphanumeric belső PZAJ1).
#
# Hybrid layout: SECTION-GROUPED type (a heading like "Füstelvezető ablak",
# "Központ", "Légutánpótló ablak" precedes a group, as in TG) but EA-style
# COLUMN ROWS ("Ssz Belső helye", with a real alphanumeric Belső id like LPAB5 /
# KP1). Dates use ÜE/IF/K markers (marker ABOVE its date); K is ignored.
# Like TG, devices render once per inspection view -> dedup-merge complementary
# dates by (belső, helye, type). NO generic type fallback -> unknown stays flagged.
#
# Output dict -> fustgato-sablon-hofustelvezeto_import.xlsx:
#   belso->A | helye->B | code->C Típus | mukelv->F Működési elv | idosz_date->J
#   | ue_date->K. (D Altípus / E Füstszakasz / G gyártás / H szerelvény -> üres.)

iso_date = tv.iso_date
DATE = tv.DATE
# Belső id: LPAB5, KP1, RWA12 ... (letters + 1..6 digits, optional -suffix)
HFR_BELSO = re.compile(r'^[A-ZÁÉÍÓÖŐÚÜŰ]{1,6}-?\d{1,6}(?:[-/][A-Z0-9]{1,4})?$')

# Authoritative HFR enum, ordered LONGEST-first so multi-word phrases win.
TYPEMAP = [
    ('menekülési ajtó tűzgátló funkcióval', 'menekulesi_ajto_tuzgatlo_funkcioval'),
    ('pánikzáras ajtó',                     'panikzaras_ajto'),
    ('vészkijárati ajtó',                   'veszkijarati_ajto'),
    ('menekülési ajtó',                     'menekulesi_ajto'),
    ('egyedi ajtó',                         'egyedi_ajto'),
]
HEAD_PHRASES = [p for p, _ in TYPEMAP]


def map_type(s):
    sl = re.sub(r'\s+', ' ', s.lower()).strip()
    for phrase, code in TYPEMAP:
        if sl.startswith(phrase):
            return code, True
    return '', False


def header_xs(ws):
    def fx(*labels):
        xs = [x for y, x, t in ws if t in labels]
        return min(xs) if xs else None
    return fx('Eszközjellemzők'), fx('Üzemeltetői'), fx('Időszakos'), fx('Eszköz')


def _date_pairs(lines):
    """Pair each date with the ÜE/IF marker just ABOVE it (within 14px, similar
    x). K (karbantartás) is ignored. Returns [(y, 'ue'|'if', iso)]."""
    markers, dates = [], []
    for ym, cs in lines:
        for cy, x, t in cs:
            if re.match(r'ÜE\.?$', t):
                markers.append((ym, x, 'ue'))
            elif re.match(r'IF\.?$', t):
                markers.append((ym, x, 'if'))
            elif DATE.search(t):
                iso = iso_date(t)
                if iso:
                    dates.append((ym, x, iso))
    out = []
    for dy, dx, iso in dates:
        cand = [(abs(my - dy), k) for my, mx, k in markers
                if my <= dy + 2 and dy - my <= 14 and abs(mx - dx) <= 40]
        if cand:
            out.append((dy, min(cand)[1], iso))
    return out


def extract(pdf):
    pages = tv.words_of(pdf)
    g = header_xs([w for pg in pages for w in pg])
    devs = []
    current_code = ''
    for ws in pages:
        if not any(t == 'Készenléti' for y, x, t in ws):
            continue
        esz_x, ue_x, idosz_x, megj_x = header_xs(ws)
        esz_x = esz_x if esz_x is not None else g[0]
        idosz_x = idosz_x if idosz_x is not None else g[2]
        if esz_x is None:
            esz_x = 264
        thi = esz_x - 6
        lines = tv.fine_lines(ws, 5)
        pairs = _date_pairs(lines)

        anchors = []  # (ym, cs, code)
        for ym, cs in lines:
            txt = re.sub(r'\s+', ' ', ' '.join(t for cy, x, t in cs)).strip()
            low = txt.lower()
            # section heading -> set the running type
            if 'helye' not in low and len(cs) <= 4:
                for p in HEAD_PHRASES:
                    if low == p or (low.startswith(p) and len(txt) < len(p) + 12):
                        current_code = map_type(p)[0]
                        break
            # device anchor: leading Ssz int + at least one more token
            if cs and re.fullmatch(r'\d{1,4}', cs[0][2]) and len(cs) > 1:
                anchors.append((ym, cs, current_code))
        anchor_ys = [a[0] for a in anchors]

        for ai, (ym, cs, ccode) in enumerate(anchors):
            lo, hi = ym - 6, ym + 14
            if ai > 0:
                lo = max(lo, anchor_ys[ai - 1] + 2)
            if ai + 1 < len(anchors):
                hi = min(hi, anchor_ys[ai + 1] - 2)

            # Belső az. = the token in the Belső column (just right of the Ssz,
            # left of helye) that carries a digit: LPAB5 / KP1 / T/00/D/05 / 10.
            belso = ''
            helye_x0 = cs[0][1] + 8
            bx, bt = cs[1][1], cs[1][2]
            if bx < thi - 60 and re.search(r'\d', bt) and not DATE.search(bt):
                belso = bt                          # Ssz + id (LPAB5 / T/00/D/05 / 10)
                helye_x0 = bx + 18
            elif re.fullmatch(r'\d{1,4}', cs[0][2]):
                belso = cs[0][2]                    # single leading number = Belső az.

            # helye = tokens after the Ssz/belső, left of the Eszközjellemzők band
            hl = sorted([(round(y2 / 3), x2, t2) for y2, cs2 in lines if lo <= y2 <= hi
                         for cy, x2, t2 in cs2
                         if helye_x0 < x2 < thi and not DATE.search(t2)],
                        key=lambda e: (e[0], e[1]))
            helye = html.unescape(re.sub(r'\s+', ' ', ' '.join(t for _, _, t in hl)).strip(' -'))

            esz_txt = re.sub(r'\s+', ' ', ' '.join(
                t2 for y2, cs2 in lines if lo <= y2 <= hi for cy, x2, t2 in cs2
                if x2 >= esz_x - 14 and (idosz_x is None or x2 < idosz_x - 30)))
            m = re.search(r'(?:M[űu]k\.?\s*)?elv:?\s*([^|]*?)(?:\s+Gyárt|$)', esz_txt, re.I)
            mukelv = re.split(r'\s*(?:[ÜUI]E\.|IF\.|K\.|\(|20\d\d\.\d)', m.group(1), 1)[0].strip(' ,/-') if m else ''

            dlo, dhi = ym - 16, ym + 16
            if ai > 0:
                dlo = max(dlo, (anchor_ys[ai - 1] + ym) / 2)
            if ai + 1 < len(anchors):
                dhi = min(dhi, (ym + anchor_ys[ai + 1]) / 2)
            ue_date = idosz_date = ''
            for dy, kind, iso in pairs:
                if not (dlo <= dy <= dhi):
                    continue
                if kind == 'if':
                    idosz_date = max(idosz_date, iso)
                else:
                    ue_date = max(ue_date, iso)

            if not (ccode or ue_date or idosz_date or belso) or not helye:
                continue
            devs.append(dict(belso=belso, helye=helye, tipus_raw=ccode, code=ccode,
                             conf=bool(ccode), mukelv=mukelv,
                             ue_date=ue_date, idosz_date=idosz_date))

    # dedup-merge complementary inspection-view renders (like TG/TV)
    merged, order = {}, []
    for x in devs:
        k = (x['belso'], re.sub(r'\s+', ' ', x['helye']).strip().lower(), x['code'])
        if k not in merged:
            merged[k] = dict(x); order.append(k)
        else:
            m = merged[k]
            m['ue_date'] = max(m['ue_date'], x['ue_date'])
            m['idosz_date'] = max(m['idosz_date'], x['idosz_date'])
            if not m['mukelv']:
                m['mukelv'] = x['mukelv']
    return [merged[k] for k in order]


if __name__ == '__main__':
    for pdf in sys.argv[1:]:
        d = extract(pdf)
        n = len(d) or 1
        from collections import Counter
        codes = Counter(x['code'] or ('?' + x['helye'][:14]) for x in d)
        fb = sum(1 for x in d if x['belso']); fh = sum(1 for x in d if x['helye'])
        ft = sum(1 for x in d if x['code']);  fu = sum(1 for x in d if x['ue_date'])
        fi = sum(1 for x in d if x['idosz_date'])
        print(f"\n### {os.path.basename(pdf)[:34]}: {len(d)} eszköz")
        print(f"    belső {fb*100//n}% helye {fh*100//n}% típuskód {ft*100//n}% "
              f"ÜE {fu*100//n}% IF {fi*100//n}%")
        print(f"    kódok: {dict(codes)}")
        for x in d[:3]:
            print(f"  {x['belso']:>6} | {x['helye'][:32]:32} | {x['code']:22} | ÜE={x['ue_date']:10} IF={x['idosz_date']:10}")
