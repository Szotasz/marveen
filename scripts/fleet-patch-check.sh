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
#   scripts/fleet-patch-check.sh --list   # print both manifests and exit 0
#
# EXIT 0 = every marker present. EXIT 1 = at least one missing, DO NOT START AGENTS.
#
# ENVIRONMENT
#   FLEET_ROOT                     tree to check          (default /home/marveen/marveen)
#   FLEET_PATCH_MARKERS_LOCAL      extra markers file     (default $FLEET_ROOT/store/fleet-patch-markers.local)
#   FLEET_PATCH_RESTORE_HINT       text printed on a MISS (default $FLEET_ROOT/store/fleet-patch-restore-hint.txt)
#
# THE WAY PAST A WRONG REFUSAL
#   FLEET_PATCH_CHECK_OVERRIDE=1 <command>   # proceed anyway, misses printed, use logged
#
# It exists because this guard refuses a RESTART, and a restart is what you reach for when
# something is already broken. A refusal you cannot get past would turn a false positive
# into an outage. The refusal prints this line itself, so nobody has to find it here first.
#
# TWO MANIFESTS, AND THIS IS THE POINT OF THE WHOLE FILE
#   shipped  -- in this script, and it describes THIS repository. Measured to pass on the
#               tree it merges into, so a fresh clone starts at 0 MISS.
#   local    -- store/fleet-patch-markers.local, optional, gitignored, same line format.
#               An install that carries its own patches lists them there, and only there.
#
# ORDERING, and it matters more than the code. An earlier revision of this file kept all the
# markers in one list, including markers for files that exist only on one fleet's private
# branches. Measured on develop at the time: 7 of 11 MISS. Since fleet-update.sh treats a
# MISS as a hard stop, that revision would have refused every restart on every other
# install -- disabling the exact path you use to recover, on the strength of a patch those
# installs were never supposed to have.
#
# So the rule is not "wire it up carefully", it is structural: the shipped half must be
# provable against this repository at any moment, and anything install-specific goes in the
# local half, where its failures land on the person who wrote it.
#
# Dependency-free on purpose: sh builtins, grep, wc. No python3, no jq -- an agent profile
# may deny those, and this has to run where the damage is.

set -uo pipefail

ROOT="${FLEET_ROOT:-/home/marveen/marveen}"
MODE="${1:-}"

# marker format:  kind | path | needle | min
#   file    -- the path must exist and be non-empty
#   contains-- the path must contain <needle> at least <min> times
#
# THE SHIPPED MANIFEST DESCRIBES THIS REPOSITORY, AND NOTHING ELSE. Every marker below is
# satisfied by the tree this file is merged into -- measured, not assumed, and the review
# that asked for it is the reason: an earlier revision listed markers for files that live
# only on one install's private branches, so on any other tree 7 of 11 reported MISS and the
# restart gate refused every restart. A guard whose default configuration cannot pass is not
# strict, it is broken, and it takes down the one path you use to recover.
MARKERS='
file|templates/profiles/researcher-reader.json||
file|templates/profiles/designer.json||
file|scripts/agent-msg.sh||
contains|src/web/agent-process.ts|runAsUser|10
contains|src/web/agent-config.ts|runAsUser|1
contains|src/web/routes/agent-terminal.ts|tmuxInvocationFor|1
contains|templates/profiles/researcher-reader.json|"permissionMode": "strict"|1
contains|templates/profiles/designer.json|"permissionMode": "strict"|1
'

# AND THE PART THAT IS YOURS, NOT OURS.
#
# An install that carries its own patches has its own markers, and they must not be in the
# file everyone receives. Put them here instead, one per line, same four fields:
#
#   store/fleet-patch-markers.local
#
# It is optional, it is gitignored, and an update cannot take it. Blank lines and lines
# starting with # are ignored. Every line is reported with a [local] tag so a MISS is
# attributable to whoever wrote it.
#
# This split is the whole answer to the ordering problem. The shipped half is provable
# against the repository at any time; the local half describes a tree only its owner can
# see, and its failures land on that owner.
LOCAL_MARKERS_FILE="${FLEET_PATCH_MARKERS_LOCAL:-$ROOT/store/fleet-patch-markers.local}"
LOCAL_MARKERS=''
if [ -f "$LOCAL_MARKERS_FILE" ]; then
  # Strip comments and blank lines here so the reading loop stays one shape for both halves.
  LOCAL_MARKERS="$(/bin/grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$LOCAL_MARKERS_FILE" 2>/dev/null || true)"
fi
# HOW TO CHOOSE A NEEDLE, because getting it wrong costs a round and looks like a finding.
# The first version of the agent-msg.sh marker looked for "arity" and found zero -- the file
# says "ARITY-orzo", uppercase, and grep -F is case sensitive. The guard was there the whole
# time; the miss was in the question, not in the world. So prefer the guard's own FAILURE
# MESSAGE over a word from a comment: a comment can be reworded by anyone, the message only
# disappears when the thing it protects does. That marker now lives in the local manifest,
# where the install that owns the patch also owns the needle.

# One stream, two origins, so that a MISS can name whose manifest asked for it.
ALL_MARKERS="$(
  printf '%s\n' "$MARKERS" | while IFS= read -r line; do
    [ -z "$line" ] || printf 'shipped|%s\n' "$line"
  done
  if [ -n "$LOCAL_MARKERS" ]; then
    printf '%s\n' "$LOCAL_MARKERS" | while IFS= read -r line; do
      [ -z "$line" ] || printf 'local|%s\n' "$line"
    done
  fi
)"

if [ "$MODE" = "--list" ]; then
  printf '%s\n' "$ALL_MARKERS" | while IFS='|' read -r origin kind path needle min; do
    [ -z "${kind:-}" ] && continue
    tag=""
    [ "$origin" = "local" ] && tag="  [local]"
    if [ "$kind" = "file" ]; then
      echo "file      $path$tag"
    else
      echo "contains  $path  >= $min x  $needle$tag"
    fi
  done
  echo
  echo "local manifest: $LOCAL_MARKERS_FILE"
  [ -f "$LOCAL_MARKERS_FILE" ] || echo "  (absent -- only the shipped markers are checked)"
  exit 0
fi

MISSING=0
CHECKED=0
LOCAL_MISSING=0

# A miss counts once, and if it came from the local manifest we count that separately: the
# two halves have different owners, and the reader needs to know whom to ask. Defined out
# here rather than in the loop, and it returns 0 explicitly -- the last command in a shell
# function sets its status, and a bare test would make every shipped miss "fail".
miss() {
  echo "MISS  $path$tag ($1)"
  MISSING=$((MISSING + 1))
  if [ "$origin" = "local" ]; then
    LOCAL_MISSING=$((LOCAL_MISSING + 1))
  fi
  return 0
}

while IFS='|' read -r origin kind path needle min; do
  [ -z "${kind:-}" ] && continue
  CHECKED=$((CHECKED + 1))
  full="$ROOT/$path"
  tag=""
  [ "$origin" = "local" ] && tag=" [local]"

  if [ "$kind" = "file" ]; then
    if [ -s "$full" ]; then
      [ "$MODE" = "--quiet" ] || echo "OK    $path$tag"
    else
      miss "file absent or empty"
    fi
    continue
  fi

  if [ ! -f "$full" ]; then
    miss "file absent, cannot look for: $needle"
    continue
  fi

  # -F: the needle is a literal, not a pattern. /bin/grep, not the harness grep.
  n=$(/bin/grep -c -F -- "$needle" "$full" 2>/dev/null || true)
  [ -z "$n" ] && n=0
  if [ "$n" -ge "$min" ]; then
    [ "$MODE" = "--quiet" ] || echo "OK    $path$tag ($n x $needle)"
  else
    miss "found $n x, expected at least $min: $needle"
  fi
done <<EOF
$ALL_MARKERS
EOF

echo
if [ "$MISSING" -eq 0 ]; then
  echo "RESULT: $CHECKED markers, all present. Safe to start agents."
  exit 0
fi

echo "RESULT: $CHECKED markers, $MISSING MISSING. DO NOT START AGENTS."
if [ "$LOCAL_MISSING" -gt 0 ]; then
  echo "        $LOCAL_MISSING of them come from $LOCAL_MARKERS_FILE (marked [local] above)."
fi
echo
echo "Restore each missing path from a branch or backup that still has it, for example:"
echo "  cd $ROOT && git checkout <branch> -- <path>"

# The branch names worth trying are a property of the INSTALL, not of this repository. An
# earlier revision printed one fleet's private branch names to every user, which is the same
# mistake as putting that fleet's markers in the shipped manifest: advice that is wrong
# everywhere except where it was written. Each install can leave its own hint here.
RESTORE_HINT="${FLEET_PATCH_RESTORE_HINT:-$ROOT/store/fleet-patch-restore-hint.txt}"
if [ -s "$RESTORE_HINT" ]; then
  echo
  cat "$RESTORE_HINT"
fi
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
  #
  # The braces matter, and it was measured: `echo ... >> file 2>/dev/null` does NOT hide a
  # failing redirection. The shell opens the file before the command runs and before that
  # 2>/dev/null takes effect, so the error still reaches the terminal -- during the one
  # moment somebody is fighting an outage and reading every line for a clue. Wrapping the
  # whole thing puts the redirection inside the silenced group.
  LOGLINE="$(date '+%Y-%m-%d %H:%M:%S') override used, $MISSING of $CHECKED markers missing"
  { echo "$LOGLINE" >> "$ROOT/store/fleet-patch-check-override.log"; } 2>/dev/null || true
  exit 0
fi

exit 1
