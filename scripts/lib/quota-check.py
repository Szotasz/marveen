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
import json, os, sys, time

# The ONE place the staleness window is decided for the measured quota path.
# limit-monitor.sh used to carry its own copy of the default; it no longer does,
# so these two numbers cannot drift apart from the code that enforces them.
DEFAULT_MAX_AGE_SEC = 21600

# QUOTAFELSOHATAR910. The guard had a floor but no CEILING, and the missing side
# is the dangerous one: too small only makes a fresh reading look stale (loud,
# harmless), while too large makes a DEAD reading look fresh -- the strip shows
# a confident green for a weeks-old number and the monitor stays quiet. Measured
# on 2026-09-10: a 30-day-old reading with QUOTA_MAX_AGE_SEC=216000000 produced
# NO output at all, i.e. one mistyped zero silently switches the guard off.
# Where 604800 comes from, stated as what it actually is -- OUR operating
# decision, not a claim about the provider's product. This monitor tracks
# exactly two windows, and they are the two its own writer produces:
# statusline-ratelimit.sh writes rate_limits.five_hour and rate_limits.seven_day,
# and the loop below reads those same two. Seven days is therefore the longest
# window WE HAVE A NUMBER FOR, so a reading older than that cannot be checked
# against anything we track, whatever the config claims. Whether some longer
# window exists upstream is not measured here and the ceiling does not depend
# on it: past a week the reading is unusable for this monitor either way.
MAX_AGE_CEILING_SEC = 604800


def resolve_max_age(raw):
    """Return (seconds, note). A note means the value was rejected.

    Rejected values fall back to the default and SAY SO on stderr (the monitor
    logs it). Silently repairing a bad config would keep exactly the silence
    this guard exists to remove: the operator would go on believing the number
    they typed is the number in force.
    """
    if raw is None or raw.strip() == "":
        return DEFAULT_MAX_AGE_SEC, None
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_AGE_SEC, (
            "QUOTA_MAX_AGE_SEC=%r nem szam, ezert nem hasznalom; helyette a default %d masodperc"
            % (raw, DEFAULT_MAX_AGE_SEC))
    if value <= 0:
        return DEFAULT_MAX_AGE_SEC, (
            "QUOTA_MAX_AGE_SEC=%d nem pozitiv, ezert nem hasznalom; helyette a default %d masodperc"
            % (value, DEFAULT_MAX_AGE_SEC))
    if value > MAX_AGE_CEILING_SEC:
        return DEFAULT_MAX_AGE_SEC, (
            "QUOTA_MAX_AGE_SEC=%d nagyobb a %d masodperces felso hatarnal (a leghosszabb ablak, amit ez a monitor kovet), "
            "ezert nem hasznalom; helyette a default %d masodperc"
            % (value, MAX_AGE_CEILING_SEC, DEFAULT_MAX_AGE_SEC))
    return value, None


path = os.environ["QUOTA_FILE"]
warn = float(os.environ["QUOTA_WARN_PCT"])
max_age, max_age_note = resolve_max_age(os.environ.get("QUOTA_MAX_AGE_SEC"))
if max_age_note:
    # stderr, not stdout: stdout carries the single STALE / EXPIRED / HIT line
    # the monitor parses, and a second line there would break its `case`.
    print(max_age_note, file=sys.stderr)
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
