import re, sys, os, html
sys.path.insert(0, os.path.dirname(__file__))
import tv  # words_of / fine_lines / DATE / iso_date

# TG (tűzgátló / fire doors) parser.
#
# Layout differs from TV/EA: it is SECTION-GROUPED and LABEL-BASED.
# - The Típus is a SECTION HEADING ("Tűzgátló ajtó", "Tűzgátló ajtó pánikzárral"
#   ...), not a per-row field. Each device inherits the most recent type heading
#   seen above it (document order). NO generic fallback -> unknown stays flagged.
# - Each device is a block led by an "Ssz Belső" two-int row, with labelled
#   fields inside it: "Készenléti helye :", "Működési elv :", "Szárnyak :",
#   "Gyártó :", "Méret :", "Nyílás irány :", plus ÜE./IF. dated markers.
#
# Output dict -> tuzgato-sablon-fire_doors_hu.xlsx (A..P):
#   helye->A | code->B Típus | mukelv->C | meret->H | nyilas->I | szarnyak->J
#   | tuzallosag->K | idosz_date->M | ue_date->N | belso->O.

iso_date = tv.iso_date
DATE = tv.DATE

# Authoritative TG enum, ordered LONGEST-first so "tűzgátló ajtó pánikzárral"
# matches before "tűzgátló ajtó", and "tűz és füstgátló ajtó" before others.
TYPEMAP = [
    ('tűz és füstgátló ajtó',      'tuz_fustgatlo_ajto'),
    ('tűz és füstgátló kapu',      'tuz_fustgatlo_kapu'),
    ('tűzgátló ajtó pánikzárral',  'tuzgatlo_ajto_panikzarral'),
    ('tűzgátló szervizajtó',       'tuzgatlo_szervizajto'),
    ('tűzgátló csappantyú',        'tuzgatlo_csappantyu'),
    ('tűzgátló mobil függöny',     'tuzgatlo_mobil_fuggony'),
    ('tűzgátló tömítés',           'tuzgatlo_tomites'),
    ('tűzgátló üveg',              'tuzgatlo_uveg'),
    ('tűzgátló zsalu',             'tuzgatlo_zsalu'),
    ('tűzgátló ajtó',              'tuzgatlo_ajto'),
    ('tűzgátló kapu',              'tuzgatlo_kapu'),
    ('légpótló ajtó',              'legpotlo_ajto'),
    ('légpótló kapu',              'legpotlo_kapu'),
    ('tűzoltó takaró',             'tuzgatlo_takaro'),
    ('vezérlő központ',            'vezerlo_kozpont'),
]
# phrases that can lead a SECTION HEADING line
HEAD_PHRASES = [p for p, _ in TYPEMAP]
TUZALLO = re.compile(r'\bT\s?(15|30|45|60|90|120)\b')


def map_type(s):
    sl = re.sub(r'\s+', ' ', s.lower()).strip()
    for phrase, code in TYPEMAP:
        if sl.startswith(phrase):
            return code, True
    return '', False


def field(block_text, label):
    """Value after 'Label :' up to the next labelled field or end."""
    m = re.search(label + r'\s*:\s*(.*?)(?=\s+(?:Készenléti helye|Működési elv|'
                  r'Szárnyak|Gyártó|Méret|Nyílás|Beépít|Tűzállóság|Típus)\s*:|$)',
                  block_text)
    return html.unescape(m.group(1).strip()) if m else ''


def _date_marker_pairs(lines):
    """Pair each date token with its inspection marker. In TG the marker (ÜE./IF.)
    renders just BELOW its date (date@225 -> IF@235), so search 0..14px below the
    date at a similar x. K. (karbantartás) is intentionally ignored. Returns
    [(y, 'ue'|'if', iso)]."""
    markers = []   # (y, x, kind)
    dates = []     # (y, x, iso)
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
                if my >= dy - 2 and my - dy <= 14 and abs(mx - dx) <= 30]
        if cand:
            out.append((dy, min(cand)[1], iso))
    return out


def extract(pdf):
    pages = tv.words_of(pdf)
    devs = []
    current_code = ''
    for ws in pages:
        if not any(t == 'Készenléti' for y, x, t in ws):
            continue
        lines = tv.fine_lines(ws, 5)
        pairs = _date_marker_pairs(lines)

        # ordered scan: update the section type on headings, anchor each device on
        # its "Készenléti helye :" line (the only reliable 1:1 per-device marker).
        helye_anchors = []   # (ym, code)
        for ym, cs in lines:
            txt = re.sub(r'\s+', ' ', ' '.join(t for cy, x, t in cs)).strip()
            low = txt.lower()
            if 'helye' not in low:
                for p in HEAD_PHRASES:
                    if low.startswith(p) and len(txt) < len(p) + 18:
                        current_code = map_type(p)[0]
                        break
            if 'Készenléti helye' in txt:
                helye_anchors.append((ym, current_code))
        ah = [a[0] for a in helye_anchors]

        for ai, (ym, ccode) in enumerate(helye_anchors):
            # span = this helye line DOWN to just above the next device's helye.
            # helye sits at the TOP of each block; the "Ssz Belső" row, Működési
            # elv, Szárnyak and ALL dated check rows (ÜE quarterly + IF + K) follow
            # below it, so the full block must be captured to get the latest dates.
            lo = ym - 4
            hi = ym + 60 if ai + 1 == len(helye_anchors) else ah[ai + 1] - 4
            blk = sorted([(y2, x2, t2) for y2, cs2 in lines if lo <= y2 <= hi
                          for cy, x2, t2 in cs2], key=lambda e: (round(e[0] / 3), e[1]))
            btext = re.sub(r'\s+', ' ', ' '.join(t2 for _, _, t2 in blk)).strip()

            # belső: from the leading "Ssz Belső" row -> the Belső az. is the LAST
            # leading number (naplók often set Belső az. = Ssz, so "1 1" -> 1).
            belso = ''
            for y2, cs2 in lines:
                if not (lo <= y2 <= hi):
                    continue
                ii = [t for cy, x, t in cs2 if re.fullmatch(r'\d{1,4}', t)][:2]
                lead = cs2 and re.fullmatch(r'\d{1,4}', cs2[0][2])
                if lead and ii:
                    belso = ii[-1]; break

            helye = field(btext, 'Készenléti helye')
            mukelv = field(btext, 'Működési elv')
            szm = re.search(r'Szárnyak\s*:\s*(\d+)', btext)
            szarnyak = szm.group(1) if szm else ''
            gyarto = field(btext, 'Gyártó')
            meret = field(btext, 'Méret(?:e)?')
            nyilas = field(btext, 'Nyílás(?:\\s*irány)?')
            mt = TUZALLO.search(btext)
            tuzallosag = ('T ' + mt.group(1)) if mt else ''

            ue_date = idosz_date = ''
            for dy, kind, iso in pairs:
                if not (lo <= dy <= hi):
                    continue
                if kind == 'if':
                    idosz_date = max(idosz_date, iso)
                else:
                    ue_date = max(ue_date, iso)

            if not helye:
                continue
            devs.append(dict(belso=belso, helye=helye, tipus_raw=ccode, code=ccode,
                             conf=bool(ccode), mukelv=mukelv, szarnyak=szarnyak,
                             gyarto=gyarto, meret=meret, nyilas=nyilas,
                             tuzallosag=tuzallosag, ue_date=ue_date, idosz_date=idosz_date))

    # Like TV, TG renders each device once per inspection-cycle view, and the
    # views carry COMPLEMENTARY markers (one ÜE, one IF/K). Merge identical
    # (belső, helye, type) rows, combining dates and any field one view filled.
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
            for fld in ('mukelv', 'szarnyak', 'gyarto', 'meret', 'nyilas', 'tuzallosag'):
                if not m[fld]:
                    m[fld] = x[fld]
    result = [merged[k] for k in order]
    # Fallback to the older COLUMN-based TG layout (helye/dates in fixed columns,
    # not inline "Készenléti helye :" labels) when the label parse finds nothing.
    if not result:
        result = _extract_column(pages)
    return result


LABEL_KW = re.compile(r'Szárnyak|M[űu]ködési|Méret|Gyárt|Nyílás|Beépít|Tűzállóság|Ajtótok|'
                      r'Típus|Készenléti|Belső|Eszköz|ellenőrzés|felülvizsgálat|Karbantartás|idő', re.I)
JUNK_TOK = re.compile(r'^(?:[ÜUI]E|IF|K)\.?$|^\(?!!\)?$|^NFM$|^!!\)?$|^\(!!$|^!!$|^:$')


def _extract_column(pages):
    """Older TG layout: section-grouped type, but helye and dates live in FIXED
    COLUMNS (Belső az. | Készenléti helye | Üzemeltetői | Időszakos) instead of
    inline labels. Anchor on the leading Ssz column; ÜE/IF dates by column x."""
    devs = []
    current_code = ''
    for ws in pages:
        if not any(t == 'Készenléti' for y, x, t in ws):
            continue
        def hx(*labels):
            xs = [x for y, x, t in ws if t in labels]
            return min(xs) if xs else None
        belso_x = hx('Belső') or 40
        helye_x = hx('Készenléti') or (belso_x + 60)
        ue_x = hx('Üzemeltetői')
        idosz_x = hx('Időszakos')
        if ue_x is None or idosz_x is None:
            continue
        lines = tv.fine_lines(ws, 5)

        # anchors = leading Ssz int in the Ssz column (left of the Belső header)
        anchors = []
        for ym, cs in lines:
            txt = re.sub(r'\s+', ' ', ' '.join(t for cy, x, t in cs)).strip()
            low = txt.lower()
            if 'helye' not in low and len(cs) <= 5:
                for p in HEAD_PHRASES:
                    if low.startswith(p) and len(txt) < len(p) + 18:
                        current_code = map_type(p)[0]
                        break
            if cs and re.fullmatch(r'\d{1,4}\.?', cs[0][2]) and cs[0][1] < belso_x + 6:
                anchors.append((ym, current_code))
        ays = [a[0] for a in anchors]

        for ai, (ym, ccode) in enumerate(anchors):
            lo = ym - 4
            hi = ym + 44 if ai + 1 == len(anchors) else ays[ai + 1] - 4
            blk = [(y2, x2, t2) for y2, cs2 in lines if lo <= y2 <= hi for cy, x2, t2 in cs2]

            # helye lives in the column right of Belső, left of Üzemeltetői. Pick
            # the single line in the block with the most helye-column text (skips
            # label rows like "Szárnyak:"/"Gyártási idő:" and stray marker rows).
            belso = ''
            best_hl, best_score = [], 0
            for y2, cs2 in lines:
                if not (lo <= y2 <= hi):
                    continue
                row = ' '.join(t for cy, x, t in cs2)
                # capture an embedded Belső id from the Belső column
                for cy, x2, t2 in cs2:
                    if belso_x - 12 <= x2 < helye_x - 18 and re.search(r'\d', t2) \
                            and not DATE.search(t2) and not belso:
                        belso = t2
                if LABEL_KW.search(row):
                    continue
                toks = [(x2, t2) for cy, x2, t2 in cs2
                        if helye_x - 45 <= x2 < ue_x - 25 and not DATE.search(t2)
                        and not JUNK_TOK.match(t2)]
                score = sum(len(t) for _, t in toks if re.search(r'[A-Za-zÁÉÍÓÖŐÚÜŰ]', t))
                if score > best_score:
                    best_score, best_hl = score, toks
            helye = html.unescape(re.sub(r'\s+', ' ', ' '.join(
                t for _, t in sorted(best_hl)).strip(' -:')))

            szm = re.search(r'Szárnyak\s*:?\s*(\d+)',
                            ' '.join(t2 for y2, x2, t2 in blk if x2 < ue_x))
            szarnyak = szm.group(1) if szm else ''
            mt = TUZALLO.search(' '.join(t2 for y2, x2, t2 in blk))
            tuzallosag = ('T ' + mt.group(1)) if mt else ''

            # dates by column: ÜE in [ue..idosz), IF at/after idosz
            ue_date = idosz_date = ''
            for y2, x2, t2 in blk:
                iso = iso_date(t2) if DATE.search(t2) else ''
                if not iso:
                    continue
                if ue_x - 130 <= x2 < idosz_x - 40:
                    ue_date = max(ue_date, iso)
                elif x2 >= idosz_x - 40:
                    idosz_date = max(idosz_date, iso)

            if not helye:
                continue
            devs.append(dict(belso=belso, helye=helye, tipus_raw=ccode, code=ccode,
                             conf=bool(ccode), mukelv='', szarnyak=szarnyak, gyarto='',
                             meret='', nyilas='', tuzallosag=tuzallosag,
                             ue_date=ue_date, idosz_date=idosz_date))
    return devs


if __name__ == '__main__':
    for pdf in sys.argv[1:]:
        d = extract(pdf)
        n = len(d) or 1
        from collections import Counter
        codes = Counter(x['code'] or ('?' + x['tipus_raw'][:16]) for x in d)
        fh = sum(1 for x in d if x['helye']); ft = sum(1 for x in d if x['code'])
        fu = sum(1 for x in d if x['ue_date']); fi = sum(1 for x in d if x['idosz_date'])
        fb = sum(1 for x in d if x['belso']); fs = sum(1 for x in d if x['szarnyak'])
        print(f"\n### {os.path.basename(pdf)[:34]}: {len(d)} eszköz")
        print(f"    belső {fb*100//n}% helye {fh*100//n}% típuskód {ft*100//n}% "
              f"szárny {fs*100//n}% ÜE {fu*100//n}% IF {fi*100//n}%")
        print(f"    kódok: {dict(codes)}")
        for x in d[:3]:
            print(f"  helye={x['helye'][:34]:34} | {x['code']:24} | szárny={x['szarnyak'][:3]:3} "
                  f"| ÜE={x['ue_date']:10} IF={x['idosz_date']:10}")
