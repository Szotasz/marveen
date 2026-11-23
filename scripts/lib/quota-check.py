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
import glob, json, os, sys, time

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




def reading_age(d, now):
    """Return (age_seconds, None), or (None, reason) when there is no usable stamp.

    This used to be `now - int(d.get("written_at") or 0)`, so a missing, null or
    zero stamp became an age counted from 1970 -- "STALE 1790511588", about 56
    years, printed exactly like a genuinely old reading. The log could not tell
    "the writer never stamped this file" from "this file is very old", and those
    have different fixes. A non-numeric stamp or a non-object file raised a
    traceback instead. All of them are now one distinct, named outcome.
    """
    if not isinstance(d, dict):
        return None, "a fajl nem JSON objektum (%s)" % type(d).__name__
    if "written_at" not in d or d["written_at"] is None:
        return None, "nincs written_at"
    ts = d["written_at"]
    # bool is an int subclass: True would pass as the stamp 1.
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        return None, "written_at nem szam: %r" % (ts,)
    if ts <= 0:
        return None, "written_at nem pozitiv: %r" % (ts,)
    return int(now) - int(ts), None


def evaluate(d, warn, max_age):
    """The one STALE / EXPIRED / HIT line for one reading, or None (nothing to say)."""
    out = None
    age, no_stamp = reading_age(d, time.time())
    if no_stamp:
        # Still a STALE line, so the measured path is skipped exactly as before, but
        # the second field is a word, never a number: it cannot be read as an age.
        out = ("STALE\tnostamp\t%s" % no_stamp)
        return out
    if age > max_age:
        out = ("STALE\t%d" % age)
        return out

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
            out = ("EXPIRED\t%s" % ",".join(expired))
        return out

    # Dedupe key: window + crossed level + the reset timestamp of that window. One
    # alert per level per window; the next window (new resets_at) starts clean.
    key = "|".join("%s:%s:%s" % (k, lv, rs) for k, _p, _w, rs, lv in hits)
    lines = []
    for k, p, w, _rs, _lv in hits:
        line = "%s: %d%% elhasznalva" % (labels[k], p)
        if w:
            line += " (nullazodik: %s)" % w
        lines.append(line)
    return "HIT\t%s\t%s" % (key, " / ".join(lines))


def main():
    warn = float(os.environ["QUOTA_WARN_PCT"])
    max_age, max_age_note = resolve_max_age(os.environ.get("QUOTA_MAX_AGE_SEC"))
    if max_age_note:
        # stderr, not stdout: stdout carries the single STALE / EXPIRED / HIT line
        # the monitor parses, and a second line there would break its `case`.
        print(max_age_note, file=sys.stderr)
    qdir = os.environ.get("QUOTA_DIR", "")
    if qdir and glob.glob(os.path.join(qdir, "wk-*.json")):
        line = evaluate_accounts(qdir, warn, max_age, os.environ.get("QUOTA_STATE") or None,
                                 os.environ.get("QUOTA_FILE") or None)
    else:
        try:
            d = json.load(open(os.environ["QUOTA_FILE"]))
        except Exception:
            return
        line = evaluate(d, warn, max_age)
    if line:
        print(line)


def evaluate_accounts(qdir, warn, max_age, state_path=None, shared_path=None, now=None):
    """USAGEPERACCOUNT1123: one reading per subscription account
    (store/claude-rate-limits/, see claude_accounts.py), checked one by one and
    folded into the single line the monitor parses. The HIT text names the plan.

    Dedupe is per account and window (Revizor 5372 J2): the monitor keeps ONE
    stored key, so the key printed here is the full set of alerted parts
    "<account>/<window>:<level>:<reset>" (the stored ones whose reset is still
    ahead, plus the new ones), and a HIT is printed only when a part is NEW. An
    account whose reading goes stale and comes back is therefore not alerted
    twice for the same level of the same window. The text lists only the new parts.

    A reading that cannot be tied to an account (no seven-day reset, so no
    fingerprint) is checked as "ismeretlen fiok" instead of being skipped or
    crashing the round (J3), and so is the shared file when its reading has no
    fingerprint (a five-hour-only block never gets a per-account file, M3).
    Precedence: any new HIT > any EXPIRED > all STALE (the freshest age) > nothing."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import claude_accounts
    now = time.time() if now is None else now
    root = os.path.dirname(os.path.dirname(qdir))
    lab = claude_accounts.Labeler(root)
    readings = []
    for path in sorted(glob.glob(os.path.join(qdir, "wk-*.json"))):
        try:
            readings.append(json.load(open(path)))
        except Exception:
            continue
    if shared_path:
        try:
            d = json.load(open(shared_path))
            if isinstance(d, dict) and claude_accounts.fingerprint(d.get("rate_limits") or {}) is None:
                readings.append(d)
        except Exception:
            pass
    parts, texts, expired, stale = {}, {}, [], []
    for d in readings:
        rl = (d.get("rate_limits") if isinstance(d, dict) else None) or {}
        fp = claude_accounts.fingerprint(rl if isinstance(rl, dict) else {})
        if fp is None:
            acct, name = "unknown", "ismeretlen fiok"
        else:
            plan, acct, _src, _c = lab.label(fp, d.get("cwd"))
            name = lab.plans.get(plan, acct)
        line = evaluate(d, warn, max_age)
        if not line:
            continue
        f = line.split("\t")
        if f[0] == "HIT":
            texts_by_win = dict(zip([x.split(":", 1)[0] for x in f[1].split("|")], f[2].split(" / ")))
            for part in f[1].split("|"):
                k = "%s/%s" % (acct, part)
                parts[k] = "%s: %s" % (name, texts_by_win.get(part.split(":", 1)[0], ""))
        elif f[0] == "EXPIRED":
            expired.append("%s:%s" % (acct, f[1]))
        elif f[0] == "STALE":
            stale.append(f)
    if parts:
        seen = set()
        if state_path:
            try:
                prev = open(state_path).read().strip()
            except OSError:
                prev = ""
            for k in prev.split(";") if "/" in prev else []:
                try:
                    if int(k.rsplit(":", 1)[1]) > now:
                        seen.add(k)
                except (IndexError, ValueError):
                    continue
        new = [k for k in parts if k not in seen]
        if not new:
            return None
        key = ";".join(sorted(seen | set(parts)))
        return "HIT\t%s\t%s" % (key, " / ".join(parts[k] for k in sorted(new)))
    if expired:
        return "EXPIRED\t%s" % ",".join(expired)
    if stale:
        ages = [x for x in stale if x[1] != "nostamp"]
        if ages:
            return "STALE\t%s" % min(ages, key=lambda x: int(x[1]))[1]
        return "\t".join(stale[0])
    return None

if __name__ == "__main__":
    main()
