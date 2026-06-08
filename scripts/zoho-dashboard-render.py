#!/usr/bin/env python3
"""Render the fiREG Zoho pipeline dashboard PNG from already-fetched deal pages.

The agent first paginates all Deals via the Zoho MCP (see the zoho-crm-bulk-query
skill), which saves each oversized page to the session's tool-results dir. This
script aggregates those saved JSON pages and renders a 2-section dashboard.

Usage:
  zoho-dashboard-render.py --since <epoch_ms> [--out <png>] [--root <dir>]

--since   only aggregate getDealsRecords-*.txt files whose filename timestamp
          (ms) is >= this value (i.e. the pages fetched in THIS run). Get it at
          run start with:  python3 -c 'import time;print(int(time.time()*1000))'
--out     output PNG path (default store/zoho-dashboard.png)
--root    project tool-results parent (default the marveen project dir)
"""
import json, glob, collections, argparse, os
from PIL import Image, ImageDraw, ImageFont

DEF_ROOT = "/Users/macbook/.claude/projects/-Users-macbook-marveen"
ORPHAN = "ZOHO admin FelhőNet"
ACTIVE = ["Qualified - Prospect", "Presentation, discovery", "Proposal", "Contract"]
WEIGHT = {"Qualified - Prospect": 0.2, "Presentation, discovery": 0.3, "Proposal": 0.5, "Contract": 0.8}

def load_deals(root, since):
    seen = {}
    for f in glob.glob(root + "/*/tool-results/mcp-zoho-crm-ZohoCRM_getDealsRecords-*.txt"):
        try:
            ts = int(f.split("-")[-1].replace(".txt", ""))
        except ValueError:
            continue
        if ts < since:
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        for r in d.get("data", {}).get("data", []):
            if "Amount" in r:           # only the runs that fetched Amount
                seen[r["id"]] = r
    return list(seen.values())

def own(r):
    n = (r.get("Owner") or {}).get("name", "(none)")
    return "Pungor Zoltán" if n.startswith("Pungor") else n

def amt(r):
    try:
        return float(r.get("Amount") or 0)
    except (TypeError, ValueError):
        return 0.0

def font(sz, bold=False):
    for p in (["/System/Library/Fonts/Supplemental/Arial Bold.ttf"] if bold else
              ["/System/Library/Fonts/Supplemental/Arial.ttf"]) + \
             ["/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"]:
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            pass
    return ImageFont.load_default()

def render(deals, out):
    N = len(deals)
    if N == 0:
        raise SystemExit("No deals loaded (rossz --since vagy nincs friss lapozás).")
    stage = collections.Counter(r.get("Stage") for r in deals)
    owner = collections.Counter(own(r) for r in deals)
    orph = [r for r in deals if own(r) == ORPHAN]
    unq = stage.get("Un-qualified", 0)
    active = [r for r in deals if r.get("Stage") in ACTIVE and own(r) != ORPHAN]
    acount = collections.Counter(r.get("Stage") for r in active)
    aval = collections.defaultdict(float)
    repval = collections.defaultdict(float)
    for r in active:
        aval[r.get("Stage")] += amt(r); repval[own(r)] += amt(r)
    weighted = sum(amt(r) * WEIGHT.get(r.get("Stage"), 0) for r in active)
    tot = sum(amt(r) for r in active)

    from datetime import datetime
    W, H = 1480, 2500
    img = Image.new("RGB", (W, H), "#ffffff"); d = ImageDraw.Draw(img)
    INK, SUB, RED, GRAY = "#1a1a1a", "#666666", "#d32f2f", "#b0b0b0"
    BLUE, GREEN, AMBER = "#1565c0", "#2e7d32", "#ef9a00"
    def text(x, y, s, f, fill=INK, anchor="la"): d.text((x, y), s, font=f, fill=fill, anchor=anchor)
    def num(v): return f"{int(v):,}".replace(",", " ")
    def hbar(x, y, w, rows, fmt=num):
        maxv = max((v for _, v, _ in rows), default=1) or 1
        lblw, barx, barw = 300, x + 300, w - 300 - 150
        bh = 46
        for i, (lbl, v, col) in enumerate(rows):
            yy = y + i * (bh + 10)
            text(x, yy + bh / 2, lbl, font(24), fill=INK, anchor="lm")
            bw = int(barw * (v / maxv))
            d.rounded_rectangle([barx, yy, barx + max(bw, 2), yy + bh], radius=6, fill=col)
            text(barx + max(bw, 2) + 12, yy + bh / 2, fmt(v), font(23, True), fill=INK, anchor="lm")
        return y + len(rows) * (bh + 10)
    M = 60
    d.rectangle([0, 0, W, 8], fill=RED)
    text(M, 40, "fiREG Sales Pipeline Dashboard", font(46, True))
    text(M, 100, f"Zoho CRM  |  {N} deal átnézve  |  {datetime.now():%Y-%m-%d %H:%M}", font(24), fill=SUB)
    text(M, 134, "Heti automata pillanatkép. A gazdátlan Un-qualified import a valós számot tovább növelheti.", font(20), fill=SUB)
    y = 190
    d.rectangle([M, y, M + 6, y + 34], fill=RED); text(M + 20, y, "1) TAKARÍTÁS-NÉZET", font(32, True)); y += 60
    boxes = [(f"{N}", "Deal átnézve", INK), (f"{len(orph)}", "Gazdátlan (FelhőNet)", GRAY),
             (f"{unq}", "Un-qualified", AMBER), (f"{100*unq//N}%", "a bázis Un-qualified", RED)]
    bw = (W - 2 * M - 3 * 20) // 4
    for i, (big, lab, col) in enumerate(boxes):
        bx = M + i * (bw + 20)
        d.rounded_rectangle([bx, y, bx + bw, y + 110], radius=14, outline="#e0e0e0", width=2)
        text(bx + bw / 2, y + 42, big, font(44, True), fill=col, anchor="mm")
        text(bx + bw / 2, y + 86, lab, font(19), fill=SUB, anchor="mm")
    y += 150
    text(M, y, "Deal-ek stage szerint (teljes bázis)", font(25, True)); y += 44
    srows = [(s, c, RED if s == "Un-qualified" else (GREEN if s == "Closed Won" else "#7e8aa2")) for s, c in stage.most_common()]
    y = hbar(M, y, W - 2 * M, srows); y += 30
    text(M, y, "Deal-ek tulajdonos szerint (gazdátlan vs valós felelős)", font(25, True)); y += 44
    orows = [(o, c, GRAY if o == ORPHAN else (BLUE if o.startswith("Konkoly") else (GREEN if o.startswith("Pungor") else "#7e8aa2"))) for o, c in owner.most_common()]
    y = hbar(M, y, W - 2 * M, orows); y += 40
    d.rectangle([M, y, M + 6, y + 34], fill=GREEN); text(M + 20, y, "2) ÉLŐ PIPELINE / FORECAST  (aktív deal-ek, gazdátlanok nélkül)", font(30, True)); y += 58
    nb = [(f"{len(active)}", "Aktív deal", INK), (num(tot), "Pipeline összérték", GREEN), (num(weighted), "Súlyozott forecast", RED)]
    bw3 = (W - 2 * M - 2 * 20) // 3
    for i, (big, lab, col) in enumerate(nb):
        bx = M + i * (bw3 + 20)
        d.rounded_rectangle([bx, y, bx + bw3, y + 110], radius=14, outline="#e0e0e0", width=2)
        text(bx + bw3 / 2, y + 42, big, font(40, True), fill=col, anchor="mm")
        text(bx + bw3 / 2, y + 86, lab, font(19), fill=SUB, anchor="mm")
    y += 150
    order = ["Contract", "Proposal", "Presentation, discovery", "Qualified - Prospect"]
    text(M, y, "Aktív pipeline darabszám stage szerint", font(25, True)); y += 44
    y = hbar(M, y, W - 2 * M, [(s, acount.get(s, 0), GREEN) for s in order]); y += 26
    text(M, y, "Aktív pipeline ÉRTÉK stage szerint (Zoho Amount)", font(25, True)); y += 44
    y = hbar(M, y, W - 2 * M, [(s, aval.get(s, 0), AMBER) for s in order]); y += 26
    text(M, y, "Aktív pipeline ÉRTÉK felelős szerint", font(25, True)); y += 44
    rrows = [(o, v, BLUE if o.startswith("Konkoly") else (GREEN if o.startswith("Pungor") else "#7e8aa2")) for o, v in sorted(repval.items(), key=lambda x: -x[1]) if v > 0]
    y = hbar(M, y, W - 2 * M, rrows)
    text(M, H - 36, "Generálta: Boss (automata heti pipeline-látkép)  |  forrás: Zoho CRM", font(18), fill=SUB)
    img.save(out)
    print(json.dumps({"out": out, "deals": N, "orphan": len(orph), "unq": unq,
                      "active": len(active), "total": int(tot), "weighted": int(weighted)}, ensure_ascii=False))

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, required=True)
    ap.add_argument("--out", default="/Users/macbook/marveen/store/zoho-dashboard.png")
    ap.add_argument("--root", default=DEF_ROOT)
    a = ap.parse_args()
    render(load_deals(a.root, a.since), a.out)
