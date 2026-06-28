import re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
import tv  # reuse words_of / fine_lines / DATE / iso_date

# EA (világítás) parser.
#
# Same fiREG table grammar as TV, but:
# - The Típus cell is a CLEAN standalone enum label ("Irányfény világítás"),
#   not TV's "<qualifier> <keyword> / <code>". So we match the type band string
#   directly against the authoritative EA enum (NO generic fallback -> flag).
# - SINGLE render: each device shows BOTH dates (ÜE + IF) on one row, so unlike
#   TV there is NO complementary-date duplication -> NO dedup-merge (it would
#   wrongly collapse distinct devices that share an empty belső + same helye).
# - Extra fields from the Eszközjellemzők band: Műk. elv -> E, Gyártó -> G.
#
# Output dict -> vilagitas-sablon-vilagitas_import.xlsx:
#   belso -> A | helye -> B | code -> C Típus | altipus -> D | mukelv -> E Működési
#   elv | gyarto -> G Gyártó | idosz_date -> J | ue_date -> K.

iso_date = tv.iso_date
DATE = tv.DATE
# Belső az. as an alphanumeric ID: TV-style "FT1-H" and EA-style "EKRK-00129"
# (letters, optional '-', 2-6 digits). A plain Ssz sequence number is NOT this.
EA_BELSO = re.compile(r'^[A-ZÁÉÍÓÖŐÚÜŰ]{2,6}-?\d{2,6}(?:[-/][A-Z0-9]{1,4})?$')


def map_type(s):
    """EA enum. Returns (code, confident). The menekülési-jel alacsony/magas
    mapping is intentionally 'inverted' per the authoritative spec -- do NOT
    'correct' it. Bare/ambiguous strings are flagged ('', False)."""
    t = s.lower()
    t = re.sub(r'\s+', ' ', t).strip()
    if 'menekülési' in t and 'jel' in t:
        if 'középmagas' in t or 'kozepmagas' in t:
            return 'menekulesi_jel_kozepmagas', True
        if 'alacsonyan' in t:
            return 'menekulesi_jel_magas', True       # spec: alacsonyan -> magas
        if 'magasan' in t:
            return 'menekulesi_jel_alacsony', True     # spec: magasan -> alacsony
        return '', False                                # bare "menekülési jel"
    if 'utánvilágító' in t or 'utanvilagito' in t:
        return 'utanvilagito_jel', True
    if 'irányfény' in t or 'iranyfeny' in t:
        return 'iranyfeny_vilagitas', True
    if 'biztonsági' in t or 'biztonsagi' in t:
        return 'biztonsagi_vilagitas', True
    if 'pánik' in t or 'panik' in t:
        return 'panik_elleni_vilagitas', True
    if 'tartalék' in t or 'tartalek' in t:
        return 'tartalekvilagitas', True
    if 'egyedi' in t:
        return 'egyedi_vilagitas', True
    return '', False


# Enum-phrase START words (not continuations like "világítás"/"jel"), used to
# anchor devices on no-Ssz layouts where rows carry no leading sequence number.
START_KW = re.compile(r'^(irányfény|biztonsági|menekülési|utánvilágító|egyedi|'
                      r'pánik|tartalék|tartalékvilágítás)', re.I)


def clean_field(s):
    """Trim a jellemzők value (Műk.elv / Gyártó) at the first inspection marker
    or parenthetical so the ÜE./IF. badge and szerelvény-count don't leak in."""
    s = re.split(r'\s*(?:[ÜUI]E\.|IF\.|\(!!|\(|20\d\d\.\d)', s, 1)[0]
    return s.strip(' ,/-')


def header_xs(ws):
    def fx(*labels):
        xs = [x for y, x, t in ws if t in labels]
        return min(xs) if xs else None
    return (fx('Típus'), fx('Eszközjellemzők'), fx('Üzemeltetői'),
            fx('Időszakos'), fx('Eszköz'))


def extract(pdf):
    pages = tv.words_of(pdf)
    g = header_xs([w for pg in pages for w in pg])
    devs = []
    for ws in pages:
        if not any(t == 'Készenléti' for y, x, t in ws):
            continue
        tip_x, esz_x, ue_x, idosz_x, megj_x = header_xs(ws)
        tip_x = tip_x if tip_x is not None else g[0]
        esz_x = esz_x if esz_x is not None else g[1]
        ue_x = ue_x if ue_x is not None else g[2]
        idosz_x = idosz_x if idosz_x is not None else g[3]
        megj_x = megj_x if megj_x is not None else g[4]
        if tip_x is None or esz_x is None:
            continue
        # type text starts left of its header; helye ends before that
        tlo = tip_x - 30
        thi = esz_x - 6

        lines = tv.fine_lines(ws, 5)
        # primary: rows that start with an Ssz sequence number + text
        anchors = []
        for li, (ym, cs) in enumerate(lines):
            if not cs:
                continue
            if not re.fullmatch(r'\d{1,4}', cs[0][2]):
                continue
            if not any(re.search(r'[A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]', t) for _, _, t in cs[1:]):
                continue
            anchors.append((ym, cs, True))
        # fallback: no-Ssz layout -> anchor on the type-band START keyword, then
        # collapse anchors within 12px (a wrapped type phrase = one device)
        if not anchors:
            cand = []
            for ym, cs in lines:
                if any(tlo <= x2 <= thi and START_KW.match(t2) for _, x2, t2 in cs):
                    cand.append((ym, cs))
            last_y = -1e9
            for ym, cs in cand:
                if ym - last_y < 12:
                    continue
                anchors.append((ym, cs, False))
                last_y = ym
        anchor_ys = [a[0] for a in anchors]

        for ai, (ym, cs, has_ssz) in enumerate(anchors):
            ssz = cs[0][2] if has_ssz else ''
            # y-window clamped to neighbour anchors (EA wraps helye/jellemzők over
            # a few lines per device)
            lo, hi = ym - 6, ym + 14
            if ai > 0:
                lo = max(lo, anchor_ys[ai - 1] + 2)
            if ai + 1 < len(anchors):
                hi = min(hi, anchor_ys[ai + 1] - 2)
            band = []
            for y2, cs2 in lines:
                if not (lo <= y2 <= hi):
                    continue
                for cy, x2, t2 in cs2:
                    band.append((y2, x2, t2))

            # Belső az.: a real ID sits at/after the Belső header x (left of helye).
            # In these naplók only the Ssz is present (no separate ID) -> belso ''.
            belso = ''
            if has_ssz and len(cs) > 1 and EA_BELSO.match(cs[1][2]):
                belso = cs[1][2]            # Ssz + alphanumeric id (EKRK-00129)
            elif has_ssz and re.fullmatch(r'\d{1,4}', cs[0][2]):
                belso = cs[0][2]            # single leading number = Belső az.

            # type tokens = type x-band, ordered
            tip_tokens = sorted([(round(y2 / 3), x2, t2) for y2, x2, t2 in band
                                 if tlo <= x2 < thi], key=lambda e: (e[0], e[1]))
            tipus_raw = re.sub(r'\s+', ' ', ' '.join(t for _, _, t in tip_tokens)).strip()
            code, conf = map_type(tipus_raw)

            # helye = left of the type band (after the Ssz), skip pure numbers/dates
            hl_tokens = sorted([(round(y2 / 3), x2, t2) for y2, x2, t2 in band
                                if x2 < tlo and not (has_ssz and abs(y2 - ym) < 0.1 and x2 == cs[0][1])
                                and not DATE.search(t2)],
                               key=lambda e: (e[0], e[1]))
            # drop the leading Ssz token itself
            helye = re.sub(r'\s+', ' ', ' '.join(t for _, _, t in hl_tokens)).strip()
            helye = re.sub(r'^\d{1,4}\s+', '', helye).strip(' -')
            if belso and helye.startswith(belso):
                helye = helye[len(belso):].strip(' -')

            # Eszközjellemzők band -> Műk. elv (E), Gyártó (G)
            esz_txt = re.sub(r'\s+', ' ', ' '.join(
                t2 for y2, x2, t2 in sorted(band, key=lambda e: (round(e[0] / 3), e[1]))
                if x2 >= esz_x - 14 and (ue_x is None or x2 < ue_x - 20)))
            mukelv = gyarto = ''
            m = re.search(r'(?:M[űu]k\.?\s*)?elv:?\s*([^|]*?)(?:\s+Gyárt|$)', esz_txt, re.I)
            if m:
                mukelv = clean_field(m.group(1))
            m = re.search(r'Gyárt[óo]:?\s*([^|]*?)(?:M[űu]k|$)', esz_txt, re.I)
            if m:
                gyarto = clean_field(m.group(1))

            # dates: ÜE column vs IF column
            dlo, dhi = ym - 14, ym + 14
            if ai > 0:
                dlo = max(dlo, (anchor_ys[ai - 1] + ym) / 2)
            if ai + 1 < len(anchors):
                dhi = min(dhi, (ym + anchor_ys[ai + 1]) / 2)
            ue_date = idosz_date = ''
            for y2, cs2 in lines:
                if not (dlo <= y2 <= dhi):
                    continue
                for cy, x2, t2 in cs2:
                    if not DATE.search(t2):
                        continue
                    diso = iso_date(t2)
                    if not diso:
                        continue
                    # IF column = right of its header; ÜE column = the band between
                    # the jellemzők block and the IF column. The date numbers float
                    # left of the 'Üzemeltetői'/'Időszakos' header labels, so bucket
                    # by column gaps, not by header proximity.
                    if idosz_x is not None and x2 >= idosz_x - 30 and (megj_x is None or x2 < megj_x - 10):
                        idosz_date = max(idosz_date, diso)
                    elif esz_x is not None and x2 >= esz_x + 20 and (idosz_x is None or x2 < idosz_x - 30):
                        ue_date = max(ue_date, diso)

            # gate out cover/telephely junk (address lines anchor on a 4-digit irsz
            # but carry no enum type, no date, no ID)
            if not (code or ue_date or idosz_date or belso):
                continue
            if not tipus_raw:
                continue
            devs.append(dict(ssz=ssz, belso=belso, helye=helye, tipus_raw=tipus_raw,
                             code=code, conf=conf, altipus='', mukelv=mukelv,
                             gyarto=gyarto, ue_date=ue_date, idosz_date=idosz_date))
    return devs


if __name__ == '__main__':
    for pdf in sys.argv[1:]:
        d = extract(pdf)
        n = len(d) or 1
        from collections import Counter
        codes = Counter(x['code'] or ('?' + x['tipus_raw'][:18]) for x in d)
        fb = sum(1 for x in d if x['belso']); fh = sum(1 for x in d if x['helye'])
        ft = sum(1 for x in d if x['code']);  fa = sum(1 for x in d if x['mukelv'])
        fu = sum(1 for x in d if x['ue_date']); fi = sum(1 for x in d if x['idosz_date'])
        print(f"\n### {os.path.basename(pdf)[:34]}: {len(d)} eszköz")
        print(f"    belső {fb*100//n}% helye {fh*100//n}% típuskód {ft*100//n}% "
              f"műk.elv {fa*100//n}% ÜE {fu*100//n}% IF {fi*100//n}%")
        print(f"    kódok: {dict(codes)}")
        for x in d[:4]:
            print(f"  {x['ssz']:>3} | {x['helye'][:30]:30} | {x['code']:24} | "
                  f"elv={x['mukelv'][:14]:14} | ÜE={x['ue_date']:10} IF={x['idosz_date']:10}")
