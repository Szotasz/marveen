import sys, os, re, subprocess
sys.path.insert(0, os.path.dirname(__file__))

# VVMEK heuristic extractor. The VVMEK org uses a NON-standard "nyilvántartás"
# format: pages of procedure text, then a device-code register table:
#   Ssz  building  floor  CODE(TG82011)  count count count
# The code encodes building+floor+seq. We recover belső=CODE and a coarse
# helye=building/floor. There is NO per-row type or date -> type stays flagged
# (the napló is "tűzgátló nyílászárók" but the specific enum is not in the row),
# dates empty. This gives Hori the device inventory; type/dates are manual.

# Anchor on the device CODE (TG####), which is the one constant across the
# VVMEK format variants (floor may be a letter, a location word may precede the
# code). belső = code; helye = the building number (first numeric after the Ssz).
CODE = re.compile(r'\b(TG[A-Z0-9]{3,})\b')


def extract(pdf):
    txt = subprocess.run(['pdftotext', '-layout', pdf, '-'],
                         capture_output=True, text=True).stdout
    devs = []
    seen = set()
    for line in txt.splitlines():
        if not re.match(r'\s*\d{1,4}\s', line):   # must be a register row (leading Ssz)
            continue
        m = CODE.search(line)
        if not m:
            continue
        code = m.group(1)
        if code in seen:
            continue
        seen.add(code)
        before = line[:m.start()].split()
        nums = [t for t in before if t.isdigit()]
        building = nums[1] if len(nums) >= 2 else (nums[0] if nums else '')
        helye = f"{building}. épület" if building else ''
        devs.append(dict(belso=code, helye=helye, tipus_raw='', code='', conf=False,
                         mukelv='', szarnyak='', gyarto='', meret='', nyilas='',
                         tuzallosag='', ue_date='', idosz_date=''))
    return devs


if __name__ == '__main__':
    for pdf in sys.argv[1:]:
        d = extract(pdf)
        print(f"{os.path.basename(pdf)[:34]}: {len(d)} eszköz"
              + (f"  pl belső={[x['belso'] for x in d[:3]]}" if d else "  (nincs kód-tábla -> non-tabuláris)"))
