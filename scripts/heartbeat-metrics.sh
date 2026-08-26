#!/usr/bin/env bash
# heartbeat-metrics.sh -- the heartbeat round's single callable instrument
# (HBMEMBLIND819, third contract).
#
# Why a script and not a prescribed command, measured three times: the
# hot-memory metric drifted through three prescription layers -- 2026-08-07
# (HBMEMBLIND807) a prose bullet let the round compose its own SQL; the fix
# shipped a ready-made query, and 2026-08-19 (HBMEMBLIND819) post-compact
# rounds reconstructed it with the wrong agent_id; the next fix shipped a
# ready-made one-liner, and 2026-08-24 22:00 a round re-composed it with a
# truncated format string, so a missing field printed as a silent 0.
# A prescription the agent must re-copy every hour is not a mechanism; a
# script on disk has nothing to recompose.
#
# Output contract (consumed VERBATIM by the heartbeat agent's CLAUDE.md,
# rendered from src/web/heartbeat-agent-scaffold.ts):
#
#   HB_METRICS_V1 ts=<local time in CLAW_TZ>
#   COUNTS urgent=N in_progress=N waiting=N planned=N new_hot_memories_1h=N db_size_mb=N waiting_shown=N
#   URGENT <id> <title>            (0..n lines)
#   WAITING <id> <title>           (0..n lines)
#   SCHEDULES enabled=N
#   TASK_RUNS_1H total=N [<status>=N ...]
#   ERROR <section>: <reason>      (any failed measurement)
#
# Fail-closed (the load-bearing property): a missing or null field NEVER
# prints as 0 -- it prints an ERROR line and the exit code is non-zero.
# A 0 in this output is always a measured zero. The sentinel line always
# prints first, so partial output stays usable; the version in the
# sentinel is the reader's compatibility check ("known sentinel or
# instrument failure", never "looks like output").
#
# Env (all optional):
#   CLAW_STORE_DIR         store/ holding .dashboard-token + claudeclaw.db
#                          (default: <repo root>/store, derived from this
#                          script's own location)
#   CLAW_DASHBOARD_ORIGIN  dashboard origin (default http://localhost:3420)
#   CLAW_TZ                timezone for the ts= stamp (default Europe/Budapest)

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE_DIR="${CLAW_STORE_DIR:-$ROOT/store}"
ORIGIN="${CLAW_DASHBOARD_ORIGIN:-http://localhost:3420}"
TZNAME="${CLAW_TZ:-Europe/Budapest}"

echo "HB_METRICS_V1 ts=$(TZ="$TZNAME" date +'%Y-%m-%d %H:%M')"

# All measurements run in ONE python3 process: no pipes, no shell variables
# carrying JSON, and no data piped into a heredoc (the HBHEREDOC819 shape
# was `echo "$JSON" | python3 <<PY` -- the heredoc replaces stdin and the
# piped data is silently lost; here the heredoc IS the program and nothing
# is piped). python3's sqlite3 module replaces the sqlite3 CLI, which does
# not exist on a stock Linux install (exit 127).
STORE_DIR="$STORE_DIR" ORIGIN="$ORIGIN" python3 - <<'PY'
import json, os, sqlite3, sys, urllib.request

store = os.environ['STORE_DIR']
origin = os.environ['ORIGIN']
fail = 0

def err(section, reason):
    global fail
    print('ERROR %s: %s' % (section, reason))
    fail = 1

tok = None
try:
    with open(os.path.join(store, '.dashboard-token')) as f:
        tok = f.read().strip()
except OSError as e:
    err('token', 'cannot read .dashboard-token: %s' % e)

def get(path):
    req = urllib.request.Request(
        origin + path, headers={'Authorization': 'Bearer ' + tok})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

if tok is not None:
    # Kanban + memory + DB size: every number is computed server-side on
    # /api/kanban/heartbeat-summary and copied here -- there is nothing to
    # recompose (HBMEMBLIND807/819, HBKANBANDRIFT819, HBDBMERET822).
    try:
        d = get('/api/kanban/heartbeat-summary')
        c = d.get('counts')
        if not isinstance(c, dict):
            err('summary', 'counts missing from response')
        else:
            required = ['urgent', 'in_progress', 'waiting', 'planned',
                        'new_hot_memories_1h', 'db_size_mb']
            missing = [k for k in required if c.get(k) is None]
            if missing:
                # Fail-closed: the absent field must not become a 0.
                err('summary', 'missing/null fields: %s' % ','.join(missing))
            else:
                print('COUNTS urgent=%s in_progress=%s waiting=%s planned=%s '
                      'new_hot_memories_1h=%s db_size_mb=%s waiting_shown=%s'
                      % (c['urgent'], c['in_progress'], c['waiting'],
                         c['planned'], c['new_hot_memories_1h'],
                         c['db_size_mb'], d.get('waiting_shown')))
            for x in d.get('urgent') or []:
                print('URGENT', x.get('id'), x.get('title'))
            for x in d.get('waiting') or []:
                print('WAITING', x.get('id'), x.get('title'))
    except Exception as e:
        err('summary', repr(e))

    # The live schedule registry -- NOT the scheduled_tasks table, which is
    # empty on this deployment and would report 0 forever.
    try:
        r = get('/api/schedules')
        print('SCHEDULES enabled=%d' % sum(1 for x in r if x.get('enabled')))
    except Exception as e:
        err('schedules', repr(e))

# task_runs.ts is epoch MILLISECONDS: the cutoff must be *1000. With a
# seconds cutoff every row matches and "last hour" silently becomes "since
# the beginning". strftime('%s','now') instead of unixepoch() so the query
# also runs on sqlite < 3.38.
try:
    db = os.path.join(store, 'claudeclaw.db')
    if not os.path.exists(db):
        err('task_runs', 'db not found: %s' % db)
    else:
        con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
        rows = con.execute(
            "SELECT status, COUNT(*) FROM task_runs "
            "WHERE ts > (strftime('%s','now') - 3600) * 1000 "
            "GROUP BY status").fetchall()
        total = sum(n for _, n in rows)
        parts = ' '.join('%s=%d' % (s, n) for s, n in rows)
        print('TASK_RUNS_1H total=%d%s' % (total, (' ' + parts) if parts else ''))
except Exception as e:
    err('task_runs', repr(e))

sys.exit(1 if fail else 0)
PY
