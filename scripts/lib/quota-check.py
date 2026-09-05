#!/usr/bin/env python3
"""Quota-threshold check for limit-monitor.sh (MIOHEREDOC902).

Reads QUOTA_FILE / QUOTA_WARN_PCT / QUOTA_MAX_AGE_SEC from the environment
and prints STALE / EXPIRED / HIT lines exactly as the old in-script heredoc
did (byte-parity measured against the pre-move body). Moved OUT of the
shell command substitution because bash 3.2's $() scanner dies on any
unpaired apostrophe inside a $()-embedded heredoc -- the whole monitor
exits 2 at parse time and Linux CI (bash >= 4) is structurally blind to it
(measured on the PR #1080 verify). With the body in its own file the
hazard class is gone and comments may use normal punctuation.
"""
import json, os, time

path = os.environ["QUOTA_FILE"]
warn = float(os.environ["QUOTA_WARN_PCT"])
max_age = int(os.environ["QUOTA_MAX_AGE_SEC"])
try:
    d = json.load(open(path))
except Exception:
    raise SystemExit(0)

age = int(time.time()) - int(d.get("written_at") or 0)
if age > max_age:
    print("STALE\t%d" % age)
    raise SystemExit(0)

# Alert on crossed LEVELS, not on the raw percentage: keying the dedupe on the
# exact number would send a fresh alert for every single point from 90 to 100.
# Two levels are enough -- the heads-up, and the moment it is actually gone.
levels = sorted({100.0, warn}, reverse=True)

labels = {"five_hour": "5 oras keret", "seven_day": "heti keret"}
labels_short = {"five_hour": "five_hour", "seven_day": "seven_day"}
hits = []
expired = []
for key in ("five_hour", "seven_day"):
    w = (d.get("rate_limits") or {}).get(key) or {}
    pct = w.get("used_percentage")
    if not isinstance(pct, (int, float)) or pct < warn:
        continue
    resets = w.get("resets_at")
    # A window whose reset time has already passed describes a window that no
    # longer exists. The numbers only move when an API response brings new ones,
    # so after a rollover the block sits there unchanged with resets_at in the
    # past (measured at the 22:00 rollover on 2026-08-18: 25% / "resets 22:00"
    # still standing at 22:00:29). Alerting on it would report a spent quota
    # that has since been handed back. Nothing real is lost by skipping: while
    # the quota was actually spent, resets_at was in the future and the alert
    # already went out.
    if isinstance(resets, (int, float)) and resets <= time.time():
        expired.append(labels_short[key])
        continue
    level = next((L for L in levels if pct >= L), warn)
    when = ""
    if isinstance(resets, (int, float)):
        when = time.strftime("%m-%d %H:%M", time.localtime(resets))
    hits.append((key, round(float(pct)), when, int(resets or 0), int(level)))

if not hits:
    if expired:
        print("EXPIRED\t%s" % ",".join(expired))
    raise SystemExit(0)

# Dedupe key: window + crossed level + the reset timestamp of that window. One
# alert per level per window; the next window (new resets_at) starts clean.
key = "|".join("%s:%s:%s" % (k, lv, rs) for k, _p, _w, rs, lv in hits)
lines = []
for k, p, w, _rs, _lv in hits:
    line = "%s: %d%% elhasznalva" % (labels[k], p)
    if w:
        line += " (nullazodik: %s)" % w
    lines.append(line)
print("HIT\t%s\t%s" % (key, " / ".join(lines)))
