#!/usr/bin/env bash
# Rembrandt -- the independent Codex reviewer worker.
#
# Not a Claude agent: the review deliberately runs on a different vendor's model
# so it does not inherit the implementer's blind spots. Terra by default, Sol
# (max effort) for big/risky changes, Luna for mechanical checks.
#
#   rembrandt.sh <project> <terra|sol|luna> <effort> <task-file> [--wait]
#
# Runs in tmux session worker-rembrandt-<project> so the orchestrator can watch
# the pane and relay progress, exactly like the Claude workers.
set -uo pipefail

PROJECT="${1:-}"; MODEL_KEY="${2:-terra}"; EFFORT="${3:-high}"; TASK_FILE="${4:-}"; WAIT="${5:-}"

usage() {
  echo "usage: rembrandt.sh <project> <terra|sol|luna> <low|medium|high|xhigh|max|ultra> <task-file> [--wait]" >&2
  exit 2
}
[ -z "$PROJECT" ] && usage
[ -z "$TASK_FILE" ] && usage
[ -f "$TASK_FILE" ] || { echo "task file not found: $TASK_FILE" >&2; exit 2; }

WORKDIR="/home/ubuntu/projects/$PROJECT"
[ -d "$WORKDIR" ] || { echo "unknown project: $PROJECT" >&2; exit 2; }

case "$MODEL_KEY" in
  sol)   MODEL="gpt-5.6-sol" ;;
  terra) MODEL="gpt-5.6-terra" ;;
  luna)  MODEL="gpt-5.6-luna" ;;
  *) echo "unknown model: $MODEL_KEY (terra|sol|luna)" >&2; exit 2 ;;
esac

case "$EFFORT" in low|medium|high|xhigh|max|ultra) ;; *) echo "bad effort: $EFFORT" >&2; exit 2 ;; esac

SESSION="worker-rembrandt-$PROJECT"
OUTDIR="/home/ubuntu/marveen/store/rembrandt"
mkdir -p "$OUTDIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$OUTDIR/$PROJECT-$STAMP.md"
PROMPT_FILE="$OUTDIR/$PROJECT-$STAMP.prompt"

# The Codex sandbox cannot start on this host (bwrap has no permission to set up
# a loopback in a new netns), so "read-only" is enforced by these rules, not by
# the OS. State it plainly rather than pretending there is a hard guard.
{
  cat <<'POLICY'
SZEREP: független reviewer. Te vagy Rembrandt.

Amit csinálsz: terv- és kódreview. Hibát, biztonsági és regressziós kockázatot
keresel. Kritikus vagy, de konkrét: minden észrevételhez fájl és sor, meg egy
mondat arról, mi romlik el tőle.

Amit NEM csinálsz, semmilyen körülmények között:
- Fájlt NEM módosítasz, nem hozol létre, nem törölsz. Ez review, nem javítás.
- git commit, push, checkout, reset: TILOS.
- Nem telepítesz csomagot, nem módosítasz rendszerbeállítást.
- Titkot, tokent, kulcsot nem írsz ki. Ha ilyet találsz a kódban, azt jelezd
  megtalálásként, de az ÉRTÉKÉT ne másold be.

Amit szabad: olvasni, keresni (ls, cat, grep, find, git log, git diff), tesztet
és diagnosztikai parancsot futtatni.

NEM delegálsz. Nincs alattad senki.

A válaszod szerkezete:
1. Összefoglaló: mehet / javítás kell / blokkoló probléma van.
2. Kritikus észrevételek (fájl:sor + mi romlik el).
3. Kisebb észrevételek.
4. Amit ellenőriztél és rendben találtál (hogy látszódjon a lefedettség).

Magyarul írj, a kód és a technikai kifejezések angolul.

--- A REVIEW TÁRGYA ---
POLICY
  cat "$TASK_FILE"
} > "$PROMPT_FILE"

# The prompt goes in on STDIN and the command lives in a runner FILE -- an
# earlier version string-built the command and wrapped it in nested double
# quotes, which closed the outer quote early: the prompt was word-split into
# `bash -lc` positional parameters, codex started with an EMPTY prompt and
# answered something generic. A 54-byte "review" that looks like a real answer
# is worse than a crash, so there is no quoting left to get wrong.
RUNNER="$OUTDIR/$PROJECT-$STAMP.sh"
{
  echo '#!/usr/bin/env bash'
  echo "cd $(printf %q "$WORKDIR") || exit 1"
  printf 'codex exec -m %q -c model_reasoning_effort=%q \\\n' "$MODEL" "$EFFORT"
  printf '  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \\\n'
  printf '  -o %q - < %q\n' "$OUT" "$PROMPT_FILE"
  echo 'status=$?'
  printf 'echo; echo "--- REVIEW KESZ (exit $status): %s ---"\n' "$OUT"
} > "$RUNNER"
chmod +x "$RUNNER"

tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -c "$WORKDIR" "$RUNNER"

echo "session: $SESSION"
echo "model:   $MODEL (effort: $EFFORT)"
echo "output:  $OUT"

if [ "$WAIT" = "--wait" ]; then
  while tmux has-session -t "$SESSION" 2>/dev/null; do sleep 5; done
  echo "--- kesz ---"
  [ -f "$OUT" ] && cat "$OUT"
fi
