#!/usr/bin/env python3
"""
Shared quiet-hours check for the Telegram hooks (submit / stop / reply-guard / watchdog).

Config: <state_dir>/quiet-hours.json, e.g.
  {"<chat_id>": {"start": "23:00", "end": "07:00", "tz": "Europe/Budapest"}}
Windows may wrap midnight (start > end).

Why this file lives in the repo (card e6680b3c): until 2026-09-22 it existed ONLY in
~/.claude/hooks, which is not version controlled. On 2026-09-12 15:32:53Z an update run
(update.sh -> scripts/sync-hooks.sh -> install-*-hook.sh) copied the repo versions of the
sibling hooks over their locally patched copies and the quiet-hours branch was lost; the
module itself survived only because it was not on the installer's copy list. The hooks now
import it from their OWN directory, so an installer can never again ship a hook whose
quiet-hours dependency is missing.

⛔ FAIL-OPEN IS THE DEFAULT, AND THAT IS DELIBERATE: a missing or unparseable config makes
in_quiet() False for every chat, i.e. the hooks behave as if no quiet hours were configured.
That is the right default for a notification path (never block delivery because a config is
absent) -- but it is silent, and a silent fail-open is exactly how the 2026-09-12 regression
went unnoticed for ten days. Callers that want to KNOW must ask config_state() and log it;
see the reply-guard and the watchdog for the shape.
"""
import os, json, datetime

CONFIG_NAME = "quiet-hours.json"

# config_state() return values -- a caller can log these; they are not error conditions.
STATE_OK = "ok"              # file exists, parsed, at least one chat configured
STATE_EMPTY = "empty"        # file exists and parses, but configures no chat
STATE_MISSING = "missing"    # no such file at state_dir
STATE_UNREADABLE = "unreadable"  # exists but could not be read or parsed


def config_path(state_dir):
    return os.path.join(state_dir, CONFIG_NAME)


def config_state(state_dir):
    """Why a quiet-hours lookup found nothing. ⛔ The point is to tell MISSING from EMPTY:
    both make in_quiet() return False, but only one of them is a deployment defect."""
    path = config_path(state_dir)
    if not os.path.exists(path):
        return STATE_MISSING
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return STATE_UNREADABLE
    if not isinstance(d, dict):
        return STATE_UNREADABLE
    return STATE_OK if d else STATE_EMPTY


def load(state_dir):
    try:
        with open(config_path(state_dir), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _hm(s):
    h, m = str(s).split(":")
    return int(h) * 60 + int(m)


def in_quiet(state_dir, chat_id, now=None):
    """True iff chat_id has a configured window and local time is inside it.
    [start, end) -- start inclusive, end exclusive."""
    cfg = load(state_dir).get(str(chat_id))
    if not cfg:
        return False
    try:
        tzname = cfg.get("tz") or "Europe/Budapest"
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(tzname)
        except Exception:
            tz = None
        t = now or datetime.datetime.now(tz)
        if t.tzinfo is None and tz is not None:
            t = t.replace(tzinfo=tz)
        cur = t.hour * 60 + t.minute
        start, end = _hm(cfg.get("start", "23:00")), _hm(cfg.get("end", "07:00"))
        if start <= end:
            return start <= cur < end
        return cur >= start or cur < end
    except Exception:
        return False


def quiet_window_end(state_dir, chat_id, at_epoch):
    """If the instant at_epoch (unix seconds) falls inside chat_id's window, return
    the unix epoch of that window's END (local wall clock); else None."""
    cfg = load(state_dir).get(str(chat_id))
    if not cfg:
        return None
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(cfg.get("tz") or "Europe/Budapest")
        t = datetime.datetime.fromtimestamp(int(at_epoch), tz)
        if not in_quiet(state_dir, chat_id, t):
            return None
        eh, em = divmod(_hm(cfg.get("end", "07:00")), 60)
        end = t.replace(hour=eh, minute=em, second=0, microsecond=0)
        if end <= t:
            end = end + datetime.timedelta(days=1)
        return int(end.timestamp())
    except Exception:
        return None
