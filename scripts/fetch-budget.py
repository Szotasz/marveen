#!/usr/bin/env python3
"""
How heavy a guest have we been on each source? Read it BEFORE a fetch sweep.

Why this exists
---------------
On 2026-08-28 `learn.kregtool.com` started returning 403 to everything. It was not
broken and it had not changed its mind about the allowlist: we had taken 140 pages
off it, 83 of them in one day, and on 08-27 fifty-two requests inside fourteen
minutes -- six to seven a minute, sustained. It is a free, public source. We used
it up.

The rule that came out of it lives in the quarantine-reader's own prompt: behave
like a guest, no more than about a dozen pages from one host in a run. But that
rule is PER RUN, and the damage was not done in one run. It was done by a caller
spawning sweep after sweep, each one individually modest. A per-run cap cannot see
across runs, so it cannot stop what actually happened.

This closes that gap on the caller's side, where the whole picture is. It counts
what the egress gate already logged, so it is a measurement, not a good intention.

Usage
-----
  fetch-budget.py [--host HOST] [--days N] [--warn-per-day 40] [--warn-per-min 3]

Exit code 1 if any host is over a threshold, so it can gate a step.
"""
import argparse
import collections
import datetime as dt
import re
import sys
import os

LOG = os.path.join(os.path.dirname(__file__), "..", "store", "egress-blocked.log")
LINE = re.compile(r'^(\S+) (\w+) url="([^"]+)"')


def host_of(url):
    if "://" not in url:
        return "?"
    return re.sub(r"^www\.", "", url.split("/")[2]).lower()


def read(path):
    rows = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = LINE.match(line)
            if not m:
                continue
            ts, verdict, url = m.groups()
            # Only fetches that actually left the machine count against a source.
            # A BLOCKED line never reached it and is not our footprint there.
            if not verdict.startswith("ALLOWED"):
                continue
            rows.append((ts[:10], ts[11:16], host_of(url)))
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", help="csak ez a host")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--warn-per-day", type=int, default=40)
    ap.add_argument("--warn-per-min", type=int, default=3)
    a = ap.parse_args(argv)

    rows = read(LOG)
    if not rows:
        print("Nincs meg engedelyezett letoltes a naploban.")
        return 0

    cutoff = (dt.date.today() - dt.timedelta(days=a.days - 1)).isoformat()
    rows = [r for r in rows if r[0] >= cutoff]
    if a.host:
        want = re.sub(r"^www\.", "", a.host.lower())
        rows = [r for r in rows if r[2] == want]
    if not rows:
        print(f"Nincs talalat az utolso {a.days} napban.")
        return 0

    per_day = collections.Counter((d, h) for d, _, h in rows)
    per_min = collections.Counter((d, t, h) for d, t, h in rows)
    totals = collections.Counter(h for _, _, h in rows)

    print(f"LETOLTESEK, utolso {a.days} nap")
    print(f"{'HOST':<34}{'OSSZ':>6}  {'CSUCSNAP':>10}  {'/NAP':>5}  {'CSUCS/PERC':>10}")
    print("-" * 74)
    over = []
    for host, total in totals.most_common():
        days = {d: n for (d, h), n in per_day.items() if h == host}
        peak_day, peak_n = max(days.items(), key=lambda x: x[1])
        peak_min = max((n for (d, t, h), n in per_min.items() if h == host), default=0)
        flag = ""
        if peak_n > a.warn_per_day or peak_min > a.warn_per_min:
            flag = "  <-- SOK"
            over.append(host)
        print(f"{host:<34}{total:>6}  {peak_day:>10}  {peak_n:>5}  {peak_min:>10}{flag}")

    if over:
        print()
        print("Ezekre a hostokra NEHEZ vendegek voltunk: " + ", ".join(over))
        print("A hozzaferes nem ujratermelodo eroforras. Ha egy oldal kizar, azt a")
        print("domain-lista bovitesevel NEM lehet megjavitani. Oszd el napokra, vagy")
        print("kerdezd meg a gazdat, hogy megeri-e egyaltalan.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
