#!/usr/bin/env bash
# The update finalizer outlives a kill aimed at the process group that launched
# update.sh (FINDETACHMAC1113).
#
# Measured 2026-11-10 on a Mac install: update.sh ran as a background Bash task
# of the main agent's own session; stop.sh ended that session, the finalizer
# (a plain `&` job, still in the caller's process group, because macOS has no
# setsid(1)) got a TERM right after stop.sh and was gone before start.sh ran.
#
# These tests EXTRACT the real launch block from update.sh (the
# `if command -v systemd-run ...` ... `fi` that starts the finalizer) and run it
# with a PATH that has neither systemd-run nor setsid -- the macOS shape on any
# OS -- from a caller that leads its own process group. Then the caller's group
# is SIGKILLed, and the fake finalizer must still finish.
#   1. the launch block's finalizer survives the group kill;
#   2. it runs in a different process group than the caller;
#   3. positive control: a plain `&` child (the pre-fix macOS branch) does NOT
#      survive the same kill, so test 1 can fail;
#   4. exactly one finalizer ran (the python3 path must not also take the fallback).
#   5. a scope finalizer that exits 6 runs exactly once;
#   6. when systemd-run cannot start, the fallback runs exactly once;
#   7. a scope finalizer that exits 0 runs exactly once;
#   8. when the start marker cannot be written, the fallback runs exactly once
#      (requires a non-root user).
#
# Run:  bash scripts/__tests__/update-finalize-detach.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAILS=0
N=0

check() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then echo "SKIP: python3 not found"; exit 0; fi

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/findetach.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

# Extract the launch block from update.sh.
"$PY" - "$ROOT/update.sh" "$SANDBOX/launch-block.sh" <<'EXTRACT'
import sys
src = open(sys.argv[1], encoding='utf-8').read()
i = src.index('if command -v systemd-run >/dev/null 2>&1 && [ -d "$XDG_RUN" ]; then')
j = src.index('\nfi\n', i)
open(sys.argv[2], 'w', encoding='utf-8').write(src[i:j] + '\nfi\n')
EXTRACT

# A PATH with only what the block and the fakes need: no systemd-run, no setsid.
BIN="$SANDBOX/bin"; mkdir -p "$BIN"
for t in bash sleep; do ln -s "$(command -v "$t")" "$BIN/$t"; done
ln -s "$PY" "$BIN/python3"

# Fake finalizer: records its pid, waits past the kill, then marks survival.
cat > "$SANDBOX/fake-finalize.sh" <<'FF'
out="$1"
echo "start $$" >> "$out.runs"
sleep 2
echo survived > "$out"
FF

# caller_run <block-file> <tag>: runs the block from a caller that leads its own
# process group and stays alive; SIGKILLs that group once the block has run.
caller_run() {
  local block="$1" tag="$2" out="$SANDBOX/$2.out"
  cat > "$SANDBOX/$tag-caller.sh" <<CALLER
FINALIZE_SCRIPT="$SANDBOX/fake-finalize.sh"
FINALIZE_ARGS=("$out")
FINALIZE_LOG="$SANDBOX/$tag.log"
XDG_RUN="$SANDBOX/no-such-runtime-dir"
. "$block"
echo \$\$ > "$SANDBOX/$tag.caller"
sleep 30
CALLER
  PATH="$BIN" "$PY" -I -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    bash "$SANDBOX/$tag-caller.sh" &
  local i=0
  while [ ! -s "$SANDBOX/$tag.caller" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  local cpid; cpid="$(cat "$SANDBOX/$tag.caller" 2>/dev/null)"
  sleep 0.3   # let the finalizer start and record itself
  local fpid; fpid="$(sed -n 's/^start //p' "$out.runs" 2>/dev/null | head -1)"
  local cpg fpg
  cpg="$(ps -o pgid= -p "$cpid" 2>/dev/null | tr -d ' ')"
  fpg="$(ps -o pgid= -p "$fpid" 2>/dev/null | tr -d ' ')"
  echo "$cpg $fpg" > "$SANDBOX/$tag.pgids"
  [ -n "$cpid" ] && kill -KILL -- "-$cpid" 2>/dev/null
  wait 2>/dev/null
  sleep 2.5     # past the fake finalizer's own sleep
}

# 1-2, 4: the real launch block
caller_run "$SANDBOX/launch-block.sh" fixed
check "1 the launch block's finalizer survives a SIGKILL of the caller's process group" \
  "$([ "$(cat "$SANDBOX/fixed.out" 2>/dev/null)" = survived ] && echo 0 || echo 1)"
read -r cpg fpg < "$SANDBOX/fixed.pgids"
check "2 the finalizer runs in its own process group (caller=$cpg finalizer=$fpg)" \
  "$([ -n "$cpg" ] && [ -n "$fpg" ] && [ "$cpg" != "$fpg" ] && echo 0 || echo 1)"
check "4 exactly one finalizer ran" \
  "$([ "$(grep -c '^start ' "$SANDBOX/fixed.out.runs" 2>/dev/null)" = 1 ] && echo 0 || echo 1)" \
  "runs: $(grep -c '^start ' "$SANDBOX/fixed.out.runs" 2>/dev/null)"

# 3: positive control, the pre-fix macOS branch
printf 'bash "$FINALIZE_SCRIPT" "${FINALIZE_ARGS[@]}" < /dev/null >> "$FINALIZE_LOG" 2>&1 &\n' > "$SANDBOX/plain-block.sh"
caller_run "$SANDBOX/plain-block.sh" plain
check "3 control: a plain & child dies with the caller's group (so test 1 can fail)" \
  "$([ ! -e "$SANDBOX/plain.out" ] && echo 0 || echo 1)"

# 5-8: --scope returns the finalizer's exit code; marker failures need a fallback.
SETSID="$(command -v setsid || true)"
if [ -z "$SETSID" ]; then
  echo "SKIP: cases 5-8 require setsid"
else
  SCOPE_BIN="$SANDBOX/scope-bin"; mkdir -p "$SCOPE_BIN"
  for t in bash sleep rm; do ln -s "$(command -v "$t")" "$SCOPE_BIN/$t"; done
  ln -s "$PY" "$SCOPE_BIN/python3"
  ln -s "$SETSID" "$SCOPE_BIN/setsid"
  cat > "$SCOPE_BIN/systemd-run" <<'SD'
#!/usr/bin/env bash
[ "${FAKE_SDRUN_FAIL:-0}" = 1 ] && exit 1
while [[ "${1:-}" == --* ]]; do shift; done
"$@"
SD
  chmod +x "$SCOPE_BIN/systemd-run"
  cat > "$SANDBOX/scope-finalize.sh" <<'SF'
echo run >> "$1"
exit "$2"
SF

  scope_run() { # tag, finalizer exit code, optional scope startup failure, optional script path
    (
      export PATH="$SCOPE_BIN" FAKE_SDRUN_FAIL="${3:-0}"
      FINALIZE_SCRIPT="${4:-$SANDBOX/scope-finalize.sh}"
      FINALIZE_ARGS=("$SANDBOX/$1.runs" "$2")
      FINALIZE_LOG="$SANDBOX/$1.log"
      XDG_RUN="$SANDBOX"
      . "$SANDBOX/launch-block.sh"
      # Wait for the whole background list, including any fallback, so an
      # early first run cannot hide a second run still in flight.
      wait "$!"
    )
  }

  scope_run rolled-back 6
  runs="$(grep -c '^run$' "$SANDBOX/rolled-back.runs" 2>/dev/null)"
  check "5 finalizer exits 6: exactly one run" \
    "$([ "$runs" = 1 ] && echo 0 || echo 1)" "runs: $runs"

  scope_run scope-failed 6 1
  runs="$(grep -c '^run$' "$SANDBOX/scope-failed.runs" 2>/dev/null)"
  check "6 systemd-run cannot start: fallback runs exactly once" \
    "$([ "$runs" = 1 ] && echo 0 || echo 1)" "runs: $runs"

  scope_run success 0
  runs="$(grep -c '^run$' "$SANDBOX/success.runs" 2>/dev/null)"
  check "7 finalizer exits 0: exactly one run" \
    "$([ "$runs" = 1 ] && echo 0 || echo 1)" "runs: $runs"

  if [ "$(id -u)" = 0 ]; then
    echo "SKIP: case 8 requires a non-root user"
  else
    mkdir "$SANDBOX/ro"
    cp "$SANDBOX/scope-finalize.sh" "$SANDBOX/ro/scope-finalize.sh"
    chmod 555 "$SANDBOX/ro"
    scope_run marker-failed 6 0 "$SANDBOX/ro/scope-finalize.sh"
    runs="$(grep -c '^run$' "$SANDBOX/marker-failed.runs" 2>/dev/null)"
    check "8 marker cannot be written: the finalizer runs exactly once (via the fallback)" \
      "$([ "$runs" = 1 ] && echo 0 || echo 1)" "runs: $runs"
    chmod 755 "$SANDBOX/ro"
  fi

  # 9-11 (FINMARKERCLEAR1120): an old start marker that rm -f cannot clear must
  # not stop the finalizer. The marker sits next to the finalizer script.
  mkdir -p "$SANDBOX/m9/scope-finalize.started/keep"
  cp "$SANDBOX/scope-finalize.sh" "$SANDBOX/m9/scope-finalize.sh"
  scope_run marker-dir-scope-ok 6 0 "$SANDBOX/m9/scope-finalize.sh"
  runs="$(grep -c '^run$' "$SANDBOX/marker-dir-scope-ok.runs" 2>/dev/null)"
  check "9 the marker path is a non-empty folder, systemd-run starts: exactly one run" \
    "$([ "$runs" = 1 ] && echo 0 || echo 1)" "runs: $runs"

  mkdir -p "$SANDBOX/m10/scope-finalize.started/keep"
  cp "$SANDBOX/scope-finalize.sh" "$SANDBOX/m10/scope-finalize.sh"
  scope_run marker-dir-scope-failed 6 1 "$SANDBOX/m10/scope-finalize.sh"
  runs="$(grep -c '^run$' "$SANDBOX/marker-dir-scope-failed.runs" 2>/dev/null)"
  check "10 the marker path is a non-empty folder, systemd-run cannot start: exactly one run" \
    "$([ "$runs" = 1 ] && echo 0 || echo 1)" "runs: $runs"

  if [ "$(id -u)" = 0 ]; then
    echo "SKIP: case 11 requires a non-root user"
  else
    mkdir "$SANDBOX/ro11"
    cp "$SANDBOX/scope-finalize.sh" "$SANDBOX/ro11/scope-finalize.sh"
    : > "$SANDBOX/ro11/scope-finalize.started"
    chmod 555 "$SANDBOX/ro11"
    scope_run stale-marker-scope-failed 6 1 "$SANDBOX/ro11/scope-finalize.sh"
    runs="$(grep -c '^run$' "$SANDBOX/stale-marker-scope-failed.runs" 2>/dev/null)"
    check "11 an old marker file that cannot be removed, systemd-run cannot start: exactly one run" \
      "$([ "$runs" = 1 ] && echo 0 || echo 1)" "runs: $runs"
    chmod 755 "$SANDBOX/ro11"
  fi
fi

echo
if [ "$FAILS" -gt 0 ]; then echo "$FAILS FAILED of $N" >&2; exit 1; fi
echo "OK: $N checks passed."
