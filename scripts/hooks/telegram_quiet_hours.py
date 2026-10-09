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
went unnoticed for ten days. Callers that want to KNOW ask config_case() and log what
defect_text() and not_configured_note_once() give them; see the reply guard, the Stop
fallback and the watchdog for the shape.
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


# ---------------------------------------------------------------------------
# WHAT A HOOK LOGS ABOUT THE CONFIG: three cases, not one (card 20e178fc).
#
# config_state() cannot tell an install that NEVER used quiet hours from one that
# LOST its config: both are MISSING. Logging every MISSING as a defect called the
# normal state of an install without quiet hours a defect, and the reply guard wrote
# that line on every Stop with an open question, so the log grew without bound. The
# install marker tells the two apart: a hook that sees a usable config naming a chat
# records that config's path in the quiet-hours.seen marker in the install's store
# directory (remember_configured). Then:
#   NOT_CONFIGURED  no file, and the marker never recorded this path: the normal state
#                   of an install (or a channel) without quiet hours; noted ONCE per
#                   state dir with the label 'quiet hours not configured';
#   LOST            no file, but the marker recorded this path: it was in use and is
#                   gone; a defect, loud on every run;
#   UNREADABLE      the file is there but cannot be read or parsed; a defect whatever
#                   the marker says (a file that is there says someone meant quiet hours).
# The marker is per config PATH, not per install: a fleet where only one channel uses
# quiet hours must not report the others as LOST.
# ---------------------------------------------------------------------------

CASE_OK = "ok"                          # usable, names at least one chat
CASE_EMPTY = "empty"                    # usable, names no chat: {} turns quiet hours off on purpose
CASE_NOT_CONFIGURED = "not-configured"  # no file, and the marker never recorded this path
CASE_LOST = "lost"                      # no file, but the marker recorded this path
CASE_UNREADABLE = "unreadable"          # the file exists but cannot be read or parsed

SEEN_NAME = "quiet-hours.seen"
NOTED_NAME = "quiet-hours-not-configured.noted"


def install_root():
    """The root whose store directory holds the marker: MARVEEN_ROOT when set (the installer pins it for
    the watchdog, the tests point it at a temp tree), else the root this module runs from
    (<root>/scripts/hooks, where every hook imports it from), else None."""
    env = os.environ.get("MARVEEN_ROOT")
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.basename(here) == "hooks" and os.path.basename(os.path.dirname(here)) == "scripts":
        root = os.path.dirname(os.path.dirname(here))
        # the watchdog's own plausibility check: a stray copy in some other scripts/hooks tree is no install
        if os.path.isdir(os.path.join(root, ".claude")) or os.path.isdir(os.path.join(root, "agents")):
            return root
    return None


def seen_path(root=None):
    """The install marker: quiet-hours.seen in the root's store directory; None without a root."""
    root = root or install_root()
    return os.path.join(root, "store", SEEN_NAME) if root else None


def seen_configs(seen):
    """The config paths the marker records (resolved), one JSON object per line: {"config": <path>, ...}.
    A torn or foreign line is skipped; an absent or unreadable marker records nothing."""
    out = set()
    if not seen:
        return out
    try:
        with open(seen, encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if isinstance(d, dict) and isinstance(d.get("config"), str):
                    out.add(os.path.realpath(d["config"]))
    except Exception:
        pass
    return out


def remember_configured(state_dir, seen, by):
    """Record in the marker that this state dir's config is in use: only when it is usable AND names a chat
    (the loss of an empty {} is no defect), and only once per config path. One line per path, appended with a
    single write, so two hooks racing record the same path twice at worst. Returns True if this call wrote a
    line; never raises."""
    try:
        if not seen or config_state(state_dir) != STATE_OK:
            return False
        path = os.path.realpath(config_path(state_dir))
        if path in seen_configs(seen):
            return False
        os.makedirs(os.path.dirname(seen), exist_ok=True)
        line = json.dumps({"config": path, "by": by,
                           "first_seen": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        fd = os.open(seen, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, (line + "\n").encode("utf-8"))
        finally:
            os.close(fd)
        return True
    except Exception:
        return False


def config_case(state_dir, seen):
    """config_state() with the history the marker gives: MISSING splits into LOST (the marker recorded this
    config's path) and NOT_CONFIGURED (it did not, or there is no marker to ask)."""
    st = config_state(state_dir)
    if st == STATE_OK:
        return CASE_OK
    if st == STATE_EMPTY:
        return CASE_EMPTY
    if st == STATE_UNREADABLE:
        return CASE_UNREADABLE
    if os.path.realpath(config_path(state_dir)) in seen_configs(seen):
        return CASE_LOST
    return CASE_NOT_CONFIGURED


def defect_text(case, state_dir, seen):
    """The label of a config DEFECT, the same in the reply guard, the Stop fallback and the watchdog; None when
    the case is not a defect (ok, empty, not configured)."""
    path = config_path(state_dir)
    if case == CASE_LOST:
        return ("quiet-hours config lost: %s was in use on this install (recorded in %s) and is gone; restore it,"
                " or write {} to turn quiet hours off on purpose" % (path, seen))
    if case == CASE_UNREADABLE:
        return "quiet-hours config unreadable: %s exists but cannot be read or parsed" % path
    return None


def not_configured_note_once(state_dir):
    """The one 'quiet hours not configured' line, the first time a hook meets this state dir NOT_CONFIGURED;
    None every time after. A small noted-file beside where the config would be records it; if that cannot
    be written, the line is not given either: a normal state must not repeat on every run."""
    try:
        fd = os.open(os.path.join(state_dir, NOTED_NAME), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    except Exception:
        return None
    return "quiet hours not configured: no %s on this install (noted once)" % config_path(state_dir)


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
