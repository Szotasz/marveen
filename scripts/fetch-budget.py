#!/usr/bin/env python3
"""
How heavy a guest have we been on each source? Read it BEFORE a fetch sweep.

Why this exists
---------------
On 2026-08-28 `learn.kregtool.com` started returning 403 to everything. It was not
broken and it had not changed its mind about the allowlist: we had taken 140 pages
off it in three days, 83 of them on 08-26 alone. It is a free, public source. We
used it up.

The shape of it matters, because two people described it two different wrong ways
before anyone measured it. It was NOT one fourteen-minute hammering, and it was NOT
two hours of sustained pressure either. Averaged over the span it is 0.4 requests a
minute, which is nothing: on 08-26 the traffic sat inside 22 distinct minutes out of
212, on 08-27 inside 14 out of 125. Roughly nine tenths of the window is silent, and
the rest is clusters of four to eight in a single minute.

So spreading the SAME number of requests over more hours would not have saved the
source. The binding number was the volume itself -- 83 pages in a day off one free
site -- with the bursts making it more visible. The remedy is to want fewer pages,
not to trickle the same ones more politely.

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
  fetch-budget.py --budget HOST [--cap 12]      # may I fetch from it right now?

`--budget` answers the only question a caller actually has before a sweep: how many
pages have I already taken off this host TODAY, and how many are left. It reports
the remaining allowance and exits 1 when there is none, so a sweep can be gated on
it instead of on somebody remembering.

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


# Second-level suffixes where the registrable domain is the LAST THREE labels.
# Without this, ukworkshop.co.uk collapses to "co.uk" and every British source
# lands in one bucket -- which would be a worse error than the one this fixes.
MULTI_SUFFIX = {
    "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk",
    "com.au", "net.au", "org.au", "co.nz", "com.br", "co.za", "co.jp", "com.mx",
}


def host_of(url):
    """Group by the REGISTRABLE domain, not the exact hostname.

    Measured 2026-08-28: counting exact hostnames put learn.kregtool.com at 140
    and www.kregtool.com at 1, so the source read as 140 when the site had in
    fact served us 141. One record is nothing; the unit being wrong is not.
    The allowlist matches a base domain OR ANY SUBDOMAIN of it, and the site
    operator sees one site -- so a per-hostname counter can sit under the cap on
    every subdomain while the site as a whole is well over it. Count the thing
    that actually binds.
    """
    if "://" not in url:
        return "?"
    host = url.split("/")[2].lower().split(":")[0]
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    if ".".join(labels[-2:]) in MULTI_SUFFIX:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def read(path):
    """Returns (rows, skipped_selftest).

    Only fetches that actually left the machine count against a source. A BLOCKED
    line never reached it. A SELFTEST_ line did not either: the gate writes those
    when EGRESS_GATE_SELFTEST is set and a payload is piped through it dry.

    The skipped count comes back with the rows and is ALWAYS printed, because a
    silent skip is the failure mode here. If that variable ever sticks on in a
    live session, real fetches get logged as SELFTEST_ and vanish from this
    tally -- the counter would report a smaller number and look healthy, which is
    exactly the shape of the two counting bugs this file already documents. A
    number that quietly excludes things is worse than no number.
    """
    rows = []
    skipped = 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = LINE.match(line)
            if not m:
                continue
            ts, verdict, url = m.groups()
            if verdict.startswith("SELFTEST"):
                skipped += 1
                continue
            if not verdict.startswith("ALLOWED"):
                continue
            rows.append((ts[:10], ts[11:16], host_of(url)))
    return rows, skipped


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", help="csak ez a host")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--warn-per-day", type=int, default=40)
    ap.add_argument("--warn-per-min", type=int, default=3)
    ap.add_argument("--budget", metavar="HOST",
                    help="mennyit vittem el MA errol a hostrol, es mennyi maradt")
    ap.add_argument("--cap", type=int, default=12,
                    help="napi plafon egy hostra (alap 12)")
    a = ap.parse_args(argv)

    rows, selftest_skipped = read(LOG)
    if selftest_skipped:
        print(f"[selftest] {selftest_skipped} sor kihagyva a naplobol (SELFTEST_, "
              f"halozati keres nem tortent). Ha ez a szam EL, akkor az "
              f"EGRESS_GATE_SELFTEST bent ragadt, es VALODI letoltesek esnek ki "
              f"a szamolasbol.")

    if a.budget:
        want = host_of("https://" + re.sub(r"^[a-z]+://", "", a.budget.strip().lower()))
        today = dt.date.today().isoformat()
        used = sum(1 for d, _, h in rows if h == want and d == today)
        left = a.cap - used
        print(f"{want}: ma {used} letoltes, napi plafon {a.cap}.")
        if left > 0:
            print(f"MEHET meg {left}.")
            return 0
        print("ELFOGYOTT MARA. Ne innen szedd tovabb: vagy holnap, vagy masik forrasbol.")
        print("A darabszam a kotoelem, nem a sebesseg. Lasd a fenti magyarazatot.")
        return 1

    if not rows:
        print("Nincs meg engedelyezett letoltes a naploban.")
        return 0

    cutoff = (dt.date.today() - dt.timedelta(days=a.days - 1)).isoformat()
    rows = [r for r in rows if r[0] >= cutoff]
    if a.host:
        want = host_of("https://" + re.sub(r"^[a-z]+://", "", a.host.strip().lower()))
        rows = [r for r in rows if r[2] == want]
    if not rows:
        print(f"Nincs talalat az utolso {a.days} napban.")
        return 0

    per_day = collections.Counter((d, h) for d, _, h in rows)
    per_min = collections.Counter((d, t, h) for d, t, h in rows)
    totals = collections.Counter(h for _, _, h in rows)

    print(f"LETOLTESEK, utolso {a.days} nap")
    print(f"{'HOST':<30}{'OSSZ':>6}  {'CSUCSNAP':>10}  {'/NAP':>5}  {'CSUCS/PERC':>10}  {'AKTIV PERC':>10}")
    print("-" * 88)
    over = []
    for host, total in totals.most_common():
        days = {d: n for (d, h), n in per_day.items() if h == host}
        peak_day, peak_n = max(days.items(), key=lambda x: x[1])
        peak_min = max((n for (d, t, h), n in per_min.items() if h == host), default=0)
        # How many distinct minutes carried any traffic at all, on the peak day.
        # Without it a peak of 8/min reads as relentless when it may be one cluster
        # in an otherwise silent afternoon -- which is exactly how two of us
        # misread the kregtool log before measuring it.
        active = sum(1 for (d, t, h) in per_min if h == host and d == peak_day)
        flag = ""
        if peak_n > a.warn_per_day or peak_min > a.warn_per_min:
            flag = "  <-- SOK"
            over.append(host)
        print(f"{host:<30}{total:>6}  {peak_day:>10}  {peak_n:>5}  {peak_min:>10}  "
              f"{active:>10}{flag}")

    if over:
        print()
        print("Ezekre a hostokra NEHEZ vendegek voltunk: " + ", ".join(over))
        print("A hozzaferes nem ujratermelodo eroforras. Ha egy oldal kizar, azt a")
        print("domain-lista bovitesevel NEM lehet megjavitani.")
        print("Es a megoldas NEM az, hogy ugyanannyi kerest teritunk szet tobb orara:")
        print("a kregtoolnal a span-re vetitett atlag 0,4/perc volt, megis kizart. A")
        print("kotolelek a DARABSZAM. Kevesebb oldalt akarj, ne udvariasabban ugyanannyit.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
