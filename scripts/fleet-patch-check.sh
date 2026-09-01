#!/usr/bin/env bash
# fleet-patch-check.sh -- does this build still contain the fleet's own patches?
#
# WHY THIS EXISTS. On 2026-09-01 an upstream update at 09:22 silently removed three things
# from the working tree: the runAsUser plumbing in src/web/agent-process.ts, and the
# researcher-reader and designer security profiles. Nothing failed and nothing logged. Two
# minutes later the restart launched five agents as the wrong OS user (so five agents ran
# twice), one agent became unreachable, one agent's memory directory was replaced by a
# symlink into the shared store, and one agent ran with permission prompts disabled because
# its strict profile was gone. Total: 09:22 to 10:26.
#
# Every one of those markers is a one-line check. This script is that line, written down.
#
# WHAT IT DOES NOT DO. It does not repair anything. Balázs chose the checking form over the
# self-repairing one on 2026-09-01, and the reason is the incident itself: what broke us was
# a silent automatic step. A guard that also fixes is a second silent automatic step.
#
# USAGE
#   scripts/fleet-patch-check.sh          # check, print a line per marker
#   scripts/fleet-patch-check.sh --quiet  # print only failures
#   scripts/fleet-patch-check.sh --list   # print the manifest and exit 0
#
# EXIT 0 = every marker present. EXIT 1 = at least one missing, DO NOT START AGENTS.
#
# THE WAY PAST A WRONG REFUSAL
#   FLEET_PATCH_CHECK_OVERRIDE=1 <command>   # proceed anyway, misses printed, use logged
#
# It exists because this guard refuses a RESTART, and a restart is what you reach for when
# something is already broken. A refusal you cannot get past would turn a false positive
# into an outage. The refusal prints this line itself, so nobody has to find it here first.
#
# ORDERING, and it matters more than the code: the manifest below describes the fully
# integrated tree. On a tree where those patches have not landed yet, this check reports
# them missing -- correctly, but uselessly, because there is nothing to restore. Wire it
# into the restart gate only once a run on the integrated tree reports 0 MISS.
#
# Dependency-free on purpose: sh builtins, grep, wc. No python3, no jq -- an agent profile
# may deny those, and this has to run where the damage is.

set -uo pipefail

ROOT="${FLEET_ROOT:-/home/marveen/marveen}"
MODE="${1:-}"

# marker format:  kind | path | needle | min
#   file    -- the path must exist and be non-empty
#   contains-- the path must contain <needle> at least <min> times
MARKERS='
file|templates/profiles/researcher-reader.json||
file|templates/profiles/designer.json||
file|scripts/local-now.sh||
file|scripts/agent-msg.sh||
file|scripts/fleet-api.sh||
contains|src/web/agent-process.ts|runAsUser|10
contains|src/web/agent-config.ts|runAsUser|1
contains|src/web/routes/agent-terminal.ts|tmuxInvocationFor|1
contains|templates/profiles/researcher-reader.json|"permissionMode": "strict"|1
contains|templates/profiles/designer.json|"permissionMode": "strict"|1
contains|scripts/agent-msg.sh|argumentum erkezett|1
'
# NOTE on that last marker, because it cost a round on the first run. I first wrote the
# needle as "arity" and got zero -- the file says "ARITY-orzo", uppercase, and grep -F is
# case sensitive. The guard was there the whole time; the miss was my question, not the
# world. So the needle is now the guard's own FAILURE MESSAGE, not a word from a comment:
# a comment can be reworded by anyone, the message only disappears if the guard does.

if [ "$MODE" = "--list" ]; then
  printf '%s\n' "$MARKERS" | while IFS='|' read -r kind path needle min; do
    [ -z "${kind:-}" ] && continue
    if [ "$kind" = "file" ]; then
      echo "file      $path"
    else
      echo "contains  $path  >= $min x  $needle"
    fi
  done
  exit 0
fi

MISSING=0
CHECKED=0

while IFS='|' read -r kind path needle min; do
  [ -z "${kind:-}" ] && continue
  CHECKED=$((CHECKED + 1))
  full="$ROOT/$path"

  if [ "$kind" = "file" ]; then
    if [ -s "$full" ]; then
      [ "$MODE" = "--quiet" ] || echo "OK    $path"
    else
      echo "MISS  $path (file absent or empty)"
      MISSING=$((MISSING + 1))
    fi
    continue
  fi

  if [ ! -f "$full" ]; then
    echo "MISS  $path (file absent, cannot look for: $needle)"
    MISSING=$((MISSING + 1))
    continue
  fi

  # -F: the needle is a literal, not a pattern. /bin/grep, not the harness grep.
  n=$(/bin/grep -c -F -- "$needle" "$full" 2>/dev/null || true)
  [ -z "$n" ] && n=0
  if [ "$n" -ge "$min" ]; then
    [ "$MODE" = "--quiet" ] || echo "OK    $path ($n x $needle)"
  else
    echo "MISS  $path (found $n x, expected at least $min: $needle)"
    MISSING=$((MISSING + 1))
  fi
done <<EOF
$MARKERS
EOF

echo
if [ "$MISSING" -eq 0 ]; then
  echo "RESULT: $CHECKED markers, all present. Safe to start agents."
  exit 0
fi

echo "RESULT: $CHECKED markers, $MISSING MISSING. DO NOT START AGENTS."
echo
echo "The fleet patches live on these branches; restore from the one that has the file:"
echo "  rebase-proba, fleet-fixes-20260901, fork/main, fleet/agent-owns-its-os-user"
echo "Example:  cd $ROOT && git checkout rebase-proba -- <path>"
echo
echo "After restoring, rebuild (npm run build) and re-run this check before starting agents."

# THE WAY OUT, PRINTED BY THE REFUSAL ITSELF.
#
# Requested in review by the repository owner, and the reasoning is stronger than the
# feature: a guard that REFUSES A RESTART is a different risk class from one that warns.
# If it fires wrongly, it locks the door in exactly the situation where recovery is
# needed, and the tool for getting out of that situation IS the restart. A refusal with
# no stated way past it turns a false positive into an outage.
#
# So the escape hatch is not hidden in a document: the refusal prints it, every time,
# right under the list of what is missing. Someone who knows the markers are wrong can
# proceed in one line -- and the override is loud, named, and leaves a record, so nobody
# ships it as a habit.
echo
echo "IF THIS REFUSAL IS WRONG, this is how you get past it (one round, no editing):"
echo "  FLEET_PATCH_CHECK_OVERRIDE=1 <the command you were running>"
echo "The override starts the agents anyway, prints the misses above, and appends one"
echo "line to store/fleet-patch-check-override.log so the next reader sees it was used."

if [ "${FLEET_PATCH_CHECK_OVERRIDE:-}" = "1" ]; then
  echo
  echo "OVERRIDE ACTIVE (FLEET_PATCH_CHECK_OVERRIDE=1): exiting 0 with $MISSING marker(s) missing."
  # Best effort: a store that is read-only (or absent) must not turn the override itself
  # into a second failure. The point of the override is that it always works.
  LOGLINE="$(date '+%Y-%m-%d %H:%M:%S') override used, $MISSING of $CHECKED markers missing"
  echo "$LOGLINE" >> "$ROOT/store/fleet-patch-check-override.log" 2>/dev/null || true
  exit 0
fi

exit 1
