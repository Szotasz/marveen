#!/usr/bin/env python3
"""fiREG sales activity report from Zoho CRM.

Counts per-salesperson activity (new deals, calls, tasks, notes, meetings)
created in a date window. Used by the daily/weekly sales-activity report
that goes to Attila on Telegram.

Usage:
  python3 sales_activity.py <start_date> <end_date> [label]
  dates are YYYY-MM-DD (Europe/Budapest), end is EXCLUSIVE.
  e.g. one day:  python3 sales_activity.py 2026-06-19 2026-06-20 "csütörtök (2026.06.19.)"
       one week: python3 sales_activity.py 2026-06-15 2026-06-20 "múlt hét (06.15-06.19.)"
"""
import sys, json
sys.path.insert(0, "/root/marveen/scripts")
from zoho_crm import call
from collections import defaultdict

OWN = {"Konkoly József": "Jocó", "Pungor Zoltán": "Zoli", "Arany János": "János",
       "Fekete Attila": "Attila", "ZOHO admin FelhőNet": "Gazdátlan", "Horváth Gábor": "Gábor"}
SALES = ["Jocó", "Zoli", "János"]  # the three sales reps Attila tracks

def owner(r):
    o = r.get("Owner") or {}
    return OWN.get(o.get("name", ""), o.get("name", ""))

def fetch(module, fields, start, end):
    """All records of `module` with Created_Time in [start, end)."""
    crit = (f"((Created_Time:greater_equal:{start}T00:00:00+02:00)"
            f"and(Created_Time:less_than:{end}T00:00:00+02:00))")
    rows, page = [], 1
    while page <= 10:
        code, txt = call(f"{module}/search",
                         {"criteria": crit, "fields": fields, "per_page": 200, "page": page})
        if code == 204:
            break
        if code != 200:
            sys.stderr.write(f"{module} err {code}: {txt[:150]}\n")
            break
        b = json.loads(txt)
        rows += b.get("data", [])
        if not b.get("info", {}).get("more_records"):
            break
        page += 1
    return rows

def tally(start, end):
    mods = {
        "Deals":  "Deal_Name,Owner,Created_Time,Stage,Amount",
        "Calls":  "Subject,Owner,Created_Time,Call_Type",
        "Tasks":  "Subject,Owner,Created_Time",
        "Events": "Event_Title,Owner,Created_Time",
        "Notes":  "Note_Title,Owner,Created_Time",
    }
    counts = {s: defaultdict(int) for s in SALES}
    new_deals = defaultdict(list)
    for mod, fl in mods.items():
        for r in fetch(mod, fl, start, end):
            o = owner(r)
            if o not in SALES:
                continue
            counts[o][mod] += 1
            if mod == "Deals":
                new_deals[o].append(r.get("Deal_Name"))
    return counts, new_deals

def render(label, counts, new_deals):
    LBL = {"Deals": "új deal", "Calls": "hívás", "Tasks": "feladat",
           "Events": "találkozó", "Notes": "jegyzet"}
    lines = [f"SALES-AKTIVITÁS - {label}", ""]
    grand = defaultdict(int)
    for s in SALES:
        c = counts[s]
        total = sum(c.values())
        for k, v in c.items():
            grand[k] += v
        parts = [f"{c[m]} {LBL[m]}" for m in ["Deals", "Calls", "Tasks", "Events", "Notes"] if c[m]]
        summary = ", ".join(parts) if parts else "nincs rögzített aktivitás"
        lines.append(f"{s}: {summary}  (összesen {total} tétel)")
        if new_deals[s]:
            for dn in new_deals[s]:
                lines.append(f"    új deal: {dn}")
    lines.append("")
    g = ", ".join(f"{grand[m]} {LBL[m]}" for m in ["Deals", "Calls", "Tasks", "Events", "Notes"] if grand[m])
    lines.append(f"Csapat összesen: {g if g else 'nincs aktivitás'}")
    return "\n".join(lines)

def chart(label, counts, png_path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    cats = ["Deals", "Calls", "Tasks", "Events", "Notes"]
    catlabel = {"Deals": "új deal", "Calls": "hívás", "Tasks": "feladat",
                "Events": "találkozó", "Notes": "jegyzet"}
    colors = {"Deals": "#1b7837", "Calls": "#4393c3", "Tasks": "#f1a340",
              "Events": "#998ec3", "Notes": "#d6604d"}
    x = np.arange(len(SALES))
    fig, ax = plt.subplots(figsize=(9, 5.5))
    bottom = np.zeros(len(SALES))
    for c in cats:
        vals = [counts[s][c] for s in SALES]
        ax.bar(x, vals, bottom=bottom, label=catlabel[c], color=colors[c])
        bottom += np.array(vals)
    ax.set_xticks(x)
    ax.set_xticklabels(SALES, fontsize=12)
    ax.set_ylabel("rögzített tételek száma")
    ax.set_title(f"Sales-aktivitás - {label}", fontsize=13, fontweight="bold")
    for i, s in enumerate(SALES):
        t = int(sum(counts[s].values()))
        if t:
            ax.text(i, t + 0.4, str(t), ha="center", fontweight="bold")
    ax.legend(loc="upper right", fontsize=10)
    plt.tight_layout()
    plt.savefig(png_path, dpi=120)
    return png_path

if __name__ == "__main__":
    start, end = sys.argv[1], sys.argv[2]
    label = sys.argv[3] if len(sys.argv) > 3 else f"{start} .. {end}"
    png = sys.argv[4] if len(sys.argv) > 4 else None
    counts, new_deals = tally(start, end)
    print(render(label, counts, new_deals))
    if png:
        chart(label, counts, png)
        sys.stderr.write(f"chart saved: {png}\n")
