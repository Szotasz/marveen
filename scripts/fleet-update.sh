#!/usr/bin/env bash
# fleet-update.sh -- the update procedure, in runnable form.
#
# WHY THIS EXISTS. On 2026-09-01 an update at 09:22 cost the fleet until 11:25. Not because
# the repair was hard (it was minutes) but because nobody knew what had changed, in what
# order to check, or when it was safe to start the agents again. Every step below existed as
# knowledge in somebody's head that morning, and every one of them was skipped.
#
# IT DOES NOT RUN THE UPDATE. Balázs chose the checking form over the self-repairing one on
# 2026-09-01, and the reason is the incident itself: what broke us was a silent automatic
# step. This sequences the checks, refuses to bless a broken state, and prints the command
# for the human to run. Nothing here writes to the tree.
#
# USAGE
#   bash scripts/fleet-update.sh before    # gate + snapshot, then it tells you what to run
#   bash scripts/fleet-update.sh after     # what changed, what is missing, are agents healthy
#
# EXIT 0 = this phase is clean. EXIT 1 = stop and read.

set -uo pipefail

ROOT="${FLEET_ROOT:-/home/marveen/marveen}"
PHASE="${1:-}"

hr() { printf '%s\n' "------------------------------------------------------------"; }
step() { printf '\n== %s\n' "$1"; }

case "$PHASE" in
  before)
    step "1/3  Are our own patches present RIGHT NOW?"
    # If the tree is already broken, a later diff blames the update for damage that predates
    # it. Establish a clean baseline or stop.
    if ! bash "$ROOT/scripts/fleet-patch-check.sh" --quiet; then
      hr
      echo "STOP. The tree is missing fleet patches BEFORE the update."
      echo "Restore them first, otherwise the after-diff will blame the update for this."
      exit 1
    fi
    echo "ok: every marker present."

    step "2/3  Recording the BEFORE state"
    python3 "$ROOT/scripts/fleet-snapshot.py" before || exit 1

    step "3/3  Which agents are running now, so you can tell later"
    python3 "$ROOT/scripts/fleet-doctor.py" || true

    hr
    echo "BASELINE RECORDED. Now run the update yourself, from the HOST, not in here:"
    echo
    echo "  cd /opt/marveen-docker && docker compose exec -u marveen marveen bash -lc 'cd /home/marveen/marveen && bash scripts/update.sh'"
    echo
    echo "Then come back and run:  bash scripts/fleet-update.sh after"
    echo
    echo "Do NOT start or restart agents until 'after' comes back clean."
    ;;

  after)
    # TWO verdicts, not one, and the split is deliberate. A broken tree is a STOP: agents
    # must not be started on it. An agent parked on an approval prompt is an ordinary
    # operating state that happens several times an hour -- folding it into the same red
    # verdict would make this script cry wolf on every run, and a guard that fires on
    # legitimate states is one somebody switches off.
    TREE=0
    AGENTS=0

    step "1/3  What did the update take?"
    python3 "$ROOT/scripts/fleet-snapshot.py" after || TREE=1

    step "2/3  Are our patches still in the build?"
    if ! bash "$ROOT/scripts/fleet-patch-check.sh" --quiet; then
      TREE=1
    else
      echo "ok: every marker present."
    fi

    step "3/3  Are the agents healthy?"
    # Deliberately last: an agent can look fine while the build under it is wrong, and the
    # damage only shows at its NEXT restart. The first two questions are about the tree.
    python3 "$ROOT/scripts/fleet-doctor.py" || AGENTS=1

    hr
    if [ "$TREE" -eq 0 ] && [ "$AGENTS" -eq 0 ]; then
      echo "CLEAN. Nothing we watch was lost, and no agent needs attention."
      exit 0
    fi
    if [ "$TREE" -eq 0 ]; then
      echo "TREE CLEAN, AGENTS NEED A HAND."
      echo "The update took nothing and the build is intact, so it is safe to start agents."
      echo "What remains is ordinary: see the agent list above."
      hr
      echo "A parked agent is answered from its pane, never by typing a number:"
      echo "  in Claude Code 2.1.252 the start-up dialogs have NO numbers -- a digit selects"
      echo "  nothing and can open a browser login. Read the pane, find the > marker, and"
      echo "  press Enter only when it sits on the option you want."
      exit 0
    fi
    echo "STOP: THE TREE IS NOT CLEAN. Do not start agents on this build."
    echo "Read the sections above in order: what was lost, then what is missing from the"
    echo "build, then which agents need a hand."
    echo
    echo "Restoring a lost file:"
    echo "  cd $ROOT && git checkout rebase-proba -- <path>"
    echo "  npm run build && bash scripts/fleet-patch-check.sh"
    echo
    echo "A parked agent is answered from its pane, never by typing a number:"
    echo "  in Claude Code 2.1.252 the start-up dialogs have NO numbers -- a digit selects"
    echo "  nothing and can open a browser login. Read the pane, find the > marker, and press"
    echo "  Enter only when it sits on the option you want."
    exit 1
    ;;

  *)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
