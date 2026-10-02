#!/usr/bin/env bash
# Every `npm ci` that update.sh RUNS carries --include=dev (UPDNPMCIDEV930).
#
# Why: the service runs under NODE_ENV=production, and a bare `npm ci` then
# skips the devDependencies the build needs (AUTOUPDNODEENV905). A community
# fork lost the flag from the main npm ci in an upstream merge and rolled back
# five times in ten days before anyone saw why. Here the flag is on every call
# today (main path, retry fallbacks, rollback), but nothing held it there.
#
# How: a static read of update.sh. A line counts as a CALL when `npm ci` is
# still there after the comment lines and every quoted string are removed
# (echo texts and RESULT_MSG mention `npm ci` as advice to the user; those are
# not calls). Each call must carry --include=dev. The number of calls found
# must be at least MIN_HIVAS, so a parser that finds nothing cannot pass.
#
# Run:  bash scripts/__tests__/update-npm-ci-include-dev.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CEL="${UPDATE_SH:-$ROOT/update.sh}"
MIN_HIVAS=5
FAILS=0

hivasok() {  # prints "<line>:<original text>" for every npm ci CALL in $1
  awk '{ print NR ":" $0 }' "$1" | while IFS= read -r sor; do
    szam="${sor%%:*}"; szoveg="${sor#*:}"
    kod="$(printf '%s\n' "$szoveg" | sed -E 's/^[[:space:]]*#.*$//; s/"([^"\\]|\\.)*"//g; s/'"'"'[^'"'"']*'"'"'//g; s/[[:space:]]#.*$//')"
    if printf '%s\n' "$kod" | grep -Eq '(^|[^[:alnum:]_-])npm[[:space:]]+ci([^[:alnum:]_-]|$)'; then
      printf '%s:%s\n' "$szam" "$szoveg"
    fi
  done
}

DB=0
while IFS= read -r h; do
  [ -z "$h" ] && continue
  DB=$((DB+1))
  if printf '%s\n' "$h" | grep -q -- '--include=dev'; then
    echo "PASS  update.sh:${h%%:*} carries --include=dev"
  else
    echo "FAIL  update.sh:${h%%:*} runs npm ci WITHOUT --include=dev: ${h#*:}"
    FAILS=$((FAILS+1))
  fi
done < <(hivasok "$CEL")

if [ "$DB" -ge "$MIN_HIVAS" ]; then
  echo "PASS  found $DB npm ci calls (>= $MIN_HIVAS)"
else
  echo "FAIL  found only $DB npm ci calls (< $MIN_HIVAS): the parser or update.sh changed"
  FAILS=$((FAILS+1))
fi

[ "$FAILS" -eq 0 ] && { echo "OK: update-npm-ci-include-dev"; exit 0; }
echo "FAILED: $FAILS"; exit 1
