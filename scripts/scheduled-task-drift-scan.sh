#!/usr/bin/env bash
# Report scheduled-task config drift: a shipped template gained a key that the
# LIVE config does not have.
#
# Why this exists, precisely. #1338 added a `preCheck` field to the
# ledger-live-drain template: a non-recording pre-check that lets an empty tick
# cost no model turn. The field is per-task opt-in and lives in the LIVE config
# under ~/.claude, not in the repo. update.sh's refresh_untouched_seeds copies a
# new template over -- unless the live copy was edited locally (agent id,
# absolute path, a different cadence): then seed_copy_is_untouched sends it to
# the KEPT branch, which only increments a counter that is printed when some
# OTHER file was updated. On one install the field never arrived that way, and
# the task kept paying a model turn on every empty tick (hundreds a day) for a
# script that surfaced nothing.
#
# So the finding this looks for is NOT "a value differs". Every value difference
# here is deliberate: the live configs run under a different agent id, at cadences
# the owner tuned, with fields the templates never had. Overwriting those would be
# the bug. The finding is a MISSING KEY -- the shape a new capability arrives in,
# and the one shape nobody notices, because a config that lacks a field looks
# exactly like a config that never needed it.
#
# Three classes, and only the third one speaks by default:
#   expected substitution  agent, and any {{PLACEHOLDER}} the seeder renders
#                          -> never reported, at any verbosity
#   local policy           schedule, enabled, type, forceSend, ... value differs,
#                          or a key the live config has and the template does not
#                          -> only with -v
#   MISSING KEY            in the template, absent or null in the live config
#                          -> reported by name, exit 1
#
# Usage:
#   scripts/scheduled-task-drift-scan.sh [-v] [--tasks-dir DIR] [--task NAME]
#
# Exit: 0 = no missing keys (with -v, differences may still be listed)
#       1 = at least one missing key
#       2 = usage error / no templates found (cannot be measuring anything)
#
# Deliberately read-only. It never writes, never resyncs, and never touches the
# live tree: the decision about a local divergence belongs to whoever made it.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASKS_DIR="${SCHEDULED_TASKS_DIR:-$HOME/.claude/scheduled-tasks}"
VERBOSE=0
ONLY_TASK=""

while [ $# -gt 0 ]; do
  case "$1" in
    -v|--verbose) VERBOSE=1; shift ;;
    --tasks-dir) TASKS_DIR="${2:?--tasks-dir needs a path}"; shift 2 ;;
    --task) ONLY_TASK="${2:?--task needs a name}"; shift 2 ;;
    -h|--help) sed -n '1,/^set -uo pipefail/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "scheduled-task-drift-scan: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

# The template roots, in the order update.sh visits them. Both are optional: a
# checkout may carry either.
TEMPLATE_ROOTS=""
for r in "$REPO_ROOT/scheduled-tasks" "$REPO_ROOT/seed-scheduled-tasks"; do
  [ -d "$r" ] && TEMPLATE_ROOTS="$TEMPLATE_ROOTS $r"
done
if [ -z "$TEMPLATE_ROOTS" ]; then
  echo "scheduled-task-drift-scan: no template dirs under $REPO_ROOT -- nothing could be measured" >&2
  exit 2
fi

REPO_ROOT="$REPO_ROOT" TASKS_DIR="$TASKS_DIR" VERBOSE="$VERBOSE" ONLY_TASK="$ONLY_TASK" \
TEMPLATE_ROOTS="$TEMPLATE_ROOTS" python3 - <<'PY'
import json, os, re, sys

repo = os.environ["REPO_ROOT"]
tasks_dir = os.environ["TASKS_DIR"]
verbose = os.environ["VERBOSE"] == "1"
only = os.environ["ONLY_TASK"]
roots = os.environ["TEMPLATE_ROOTS"].split()

# Placeholder values, same set and same precedence as update.sh's
# render_seed_template: the process environment first, then the project .env.
def env_values():
    vals = {}
    envfile = os.path.join(repo, ".env")
    if os.path.exists(envfile):
        for line in open(envfile, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("MAIN_AGENT_ID", "BOT_NAME", "OWNER_NAME", "WEB_PORT"):
        if os.environ.get(k):
            vals[k] = os.environ[k]
    return vals

EV = env_values()
SUBS = {
    "{{MAIN_AGENT_ID}}": EV.get("MAIN_AGENT_ID", ""),
    "{{BOT_NAME}}": EV.get("BOT_NAME", ""),
    "{{OWNER_NAME}}": EV.get("OWNER_NAME", ""),
    "{{INSTALL_DIR}}": repo,
    "{{PROJECT_ROOT}}": repo,
    "{{WEB_PORT}}": EV.get("WEB_PORT", "3420"),
}

def render(v):
    if not isinstance(v, str):
        return v
    for k, r in SUBS.items():
        v = v.replace(k, r)
    return v

# `agent` is the one key whose value is SUPPOSED to differ: the templates ship
# under the upstream default agent id and the live copy runs under the install's own. Treating
# it as drift would put a line in every report forever, which is how a report
# stops being read.
ALWAYS_EXPECTED = {"agent", "createdAt"}

missing = []      # (task, key, template value)
differences = []  # (task, key, template value, live value)
checked = 0
pairs = 0

for root in roots:
    for name in sorted(os.listdir(root)):
        if only and name != only:
            continue
        tpl_path = os.path.join(root, name, "task-config.json")
        live_path = os.path.join(tasks_dir, name, "task-config.json")
        if not os.path.isfile(tpl_path):
            continue
        pairs += 1
        if not os.path.isfile(live_path):
            # Not installed here. Adding tasks is not this script's business --
            # update.sh deliberately never adds files to an existing dir either.
            if verbose:
                print(f"  info  {name}: template only, not installed under {tasks_dir}")
            continue
        try:
            tpl = json.load(open(tpl_path, encoding="utf-8"))
            live = json.load(open(live_path, encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            print(f"  warn  {name}: cannot compare ({e})")
            continue
        checked += 1
        for key, tval in tpl.items():
            if key in ALWAYS_EXPECTED:
                continue
            rendered = render(tval)
            if key not in live or live[key] is None:
                # A null is the exact shape seen in the field: the key was
                # present and empty, which reads as "configured" to a human and as
                # "off" to the runner.
                if rendered not in (None, ""):
                    missing.append((name, key, rendered))
                continue
            if live[key] != rendered:
                differences.append((name, key, rendered, live[key]))
        if verbose:
            for key in live:
                if key not in tpl and key not in ALWAYS_EXPECTED:
                    differences.append((name, key, "<not in template>", live[key]))

if pairs == 0:
    print("scheduled-task-drift-scan: no template task-config.json found -- nothing could be measured", file=sys.stderr)
    sys.exit(2)

for name, key, tval in missing:
    print(f'DRIFT {name}: template defines "{key}" = {tval!r}, the live config does not')
if verbose:
    for name, key, tval, lval in differences:
        print(f'  local {name}: "{key}" template={tval!r} live={lval!r}')
    print(f"  checked {checked} installed task(s) against {pairs} template(s)")

if missing:
    print(f"scheduled-task-drift-scan: {len(missing)} missing key(s). "
          f"The live config predates the template; decide per key, do not bulk-resync.")
    sys.exit(1)
sys.exit(0)
PY
