#!/usr/bin/env bash
# Every `npm rebuild better-sqlite3` in update.sh runs only when the native
# module does not load (#950).
#
# Why: better-sqlite3 13.x ships a Node-API prebuild. An unconditional rebuild
# that falls back to a source build under a Node the toolchain cannot target
# fails AND deletes the working binary. The main path was gated; the rollback
# paths (which exist to restore a working binary) were not.
#
# How: a static read of update.sh. A CALL is each occurrence of `npm rebuild
# better-sqlite3` (package token must end at whitespace, ; | & or EOL) in the
# code left after comments, quoted strings and trailing comments are stripped.
# A call is GATED only if its stripped line STARTS with
# `native_module_loads || npm rebuild better-sqlite3`, or the stripped code of
# the previous non-empty line is exactly `if ! native_module_loads; then`; a
# line holding more than one call is always UNGATED. At least MIN_CALLS calls
# are required. Both native_module_loads() definitions (update.sh's own and the
# finalize heredoc's) must have exactly the expected node -e body.
# Self-tests tamper with a temp copy (inverted gate, unrelated command, lost
# main-path gate, lost call, package-name suffix, second call on a line, lost/
# changed finalize definition, no-op or deleted own definition) and require the
# matching check (calls_ok / finalize_ok) to fail. The self-tests target the
# shapes update.sh has today, so a restructured update.sh makes one report
# "tamper did not apply" (a loud failure asking for the test to be updated),
# never a silent pass.
#
# Run:  bash scripts/__tests__/update-rebuild-gated.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CEL="${UPDATE_SH:-$ROOT/update.sh}"
MIN_CALLS=5
FAILS=0
CALL_RE='npm[[:space:]]+rebuild[[:space:]]+better-sqlite3([[:space:]]|;|\||&|$)'
GATED_RE='^[[:space:]]*native_module_loads[[:space:]]*\|\|[[:space:]]*'"$CALL_RE"

strip_code() {  # stdin: one source line; stdout: code without comments/strings
  sed -E 's/^[[:space:]]*#.*$//; s/"([^"\\]|\\.)*"//g; s/'"'"'[^'"'"']*'"'"'//g; s/[[:space:]]#.*$//'
}

# calls_ok <file>: exit 0 when every rebuild call is GATED and there are >= MIN_CALLS.
# Calls are counted per occurrence; a line with more than one is always UNGATED.
# Per-call lines are printed only when VERBOSE=1.
# bash 3.2 (macOS) has no mapfile: read line by line.
calls_ok() {
  local f="$1" n=0 calls=0 bad=0 prev="" t line code rest k
  # strip_code is line-preserving: run it once over the file, in step with the original (fd 3).
  while IFS= read -r code; do
    IFS= read -r line <&3
    n=$((n+1))
    k=0; rest="$code"
    while [[ "$rest" =~ $CALL_RE ]]; do
      k=$((k+1))
      rest="${rest#*"${BASH_REMATCH[0]}"}"
    done
    if [ "$k" -gt 0 ]; then
      calls=$((calls+k))
      if [ "$k" -gt 1 ]; then
        [ "${VERBOSE:-0}" = 1 ] && echo "FAIL  update.sh:$n UNGATED (more than one rebuild call on one line): $line"
        bad=$((bad+1))
      elif [[ "$code" =~ $GATED_RE ]] || [ "$prev" = "if ! native_module_loads; then" ]; then
        [ "${VERBOSE:-0}" = 1 ] && echo "PASS  update.sh:$n GATED"
      else
        [ "${VERBOSE:-0}" = 1 ] && echo "FAIL  update.sh:$n UNGATED: $line"
        bad=$((bad+1))
      fi
    fi
    if [[ "$code" =~ [^[:space:]] ]]; then
      t="${code#"${code%%[![:space:]]*}"}"
      prev="${t%"${t##*[![:space:]]}"}"
    fi
  done 3< "$f" < <(strip_code < "$f")
  [ "${VERBOSE:-0}" = 1 ] && echo "INFO  found $calls rebuild calls (need >= $MIN_CALLS)"
  [ "$bad" -eq 0 ] && [ "$calls" -ge "$MIN_CALLS" ]
}

# fn_body <file> <start> <end>: within lines start..end, the body of the first
# native_module_loads() definition (from the first `{` after the name to its
# matching `}`) as one normalized string; prints nothing if none is found.
fn_body() {
  awk -v s="$2" -v e="$3" '
    NR < s || NR > e { next }
    !def && /^[[:space:]]*native_module_loads\(\)/ {
      def = 1
      $0 = substr($0, index($0, "native_module_loads()") + 21)
    }
    def && !done {
      line = $0
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (!open) { if (c == "{") { open = 1; depth = 1 } continue }
        if (c == "{") depth++
        else if (c == "}" && --depth == 0) { done = 1; break }
        body = body c
      }
      body = body " "
    }
    END {
      if (!done) exit
      gsub(/[[:space:]]+/, " ", body)
      sub(/^ /, "", body); sub(/ $/, "", body)
      sub(/;$/, "", body); sub(/ $/, "", body)
      print body
    }' "$1"
}

EXPECTED_BODY='node -e "new (require('"'"'better-sqlite3'"'"'))('"'"':memory:'"'"').close()" >/dev/null 2>&1'

# finalize_ok <file>: heredoc found; its native_module_loads() body and update.sh's own
# (before the heredoc) both equal EXPECTED_BODY.
finalize_ok() {
  local f="$1" start end mine theirs
  start="$(grep -n "<<'FINALIZE_EOF'" "$f" | head -n1 | cut -d: -f1)"
  end="$(grep -n '^FINALIZE_EOF$' "$f" | head -n1 | cut -d: -f1)"
  [ -n "$start" ] && [ -n "$end" ] && [ "$end" -gt "$start" ] || return 1
  mine="$(fn_body "$f" "$((start+1))" "$((end-1))")"
  theirs="$(fn_body "$f" 1 "$((start-1))")"
  # Exactly one definition per region: a later redefinition would be the one bash uses.
  [ "$(defs_in "$f" "$((start+1))" "$((end-1))")" -eq 1 ] || return 1
  [ "$(defs_in "$f" 1 "$((start-1))")" -eq 1 ] || return 1
  [ "$mine" = "$EXPECTED_BODY" ] && [ "$theirs" = "$EXPECTED_BODY" ]
}

defs_in() {  # defs_in <file> <from> <to>: count native_module_loads() definitions in the range
  awk -v a="$2" -v b="$3" 'NR >= a && NR <= b && /^[[:space:]]*native_module_loads\(\)/ { n++ } END { print n + 0 }' "$1"
}

report() {  # report <label> <exit status>
  if [ "$2" -eq 0 ]; then echo "PASS  $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi
}

VERBOSE=1 calls_ok "$CEL"; rc=$?
report "every rebuild call gated, >= $MIN_CALLS calls" "$rc"
finalize_ok "$CEL"; rc=$?
report "finalize heredoc defines native_module_loads() identically to update.sh" "$rc"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# self_test <name> <check function> <awk program>: tamper $CEL into $TMP; the check must FAIL.
# First-occurrence edits use awk (BSD sed has no 0,/re/ address).
self_test() {
  local name="$1" check="$2" prog="$3"
  awk "$prog" "$CEL" > "$TMP"
  if cmp -s "$TMP" "$CEL"; then
    echo "FAIL  self-test: $name tamper did not apply"; FAILS=$((FAILS+1)); return
  fi
  if "$check" "$TMP"; then
    echo "FAIL  self-test: $name was not caught"; FAILS=$((FAILS+1))
  else
    echo "PASS  self-test: $name"
  fi
}

self_test inverted calls_ok \
  '!d && sub(/native_module_loads \|\| npm rebuild/, "! native_module_loads || npm rebuild") { d = 1 } { print }'
self_test unrelated calls_ok \
  '!d && sub(/native_module_loads \|\| npm rebuild/, "native_module_loads || true; npm rebuild") { d = 1 } { print }'
self_test prev-path calls_ok \
  '{ t = $0; gsub(/^[ \t]+|[ \t]+$/, "", t) } t == "if ! native_module_loads; then" { sub(/if ! native_module_loads; then/, "if true; then") } { print }'
self_test lost-call calls_ok \
  '!d && /npm[[:space:]]+rebuild[[:space:]]+better-sqlite3([[:space:]]|;|\||&|$)/ { d = 1; next } { print }'
self_test finalize finalize_ok \
  '/<<.FINALIZE_EOF.$/ { inb = 1 } /^FINALIZE_EOF$/ { inb = 0 } inb && !d && /^[ \t]*native_module_loads\(\)/ { d = 1; next } { print }'
self_test finalize-body finalize_ok \
  '/<<.FINALIZE_EOF.$/ { inb = 1 } /^FINALIZE_EOF$/ { inb = 0 } inb && !d && /^[ \t]*native_module_loads\(\)/ && sub(/:memory:/, ":memoryX:") { d = 1 } { print }'
self_test pkg-boundary calls_ok \
  '!d && sub(/native_module_loads \|\| npm rebuild better-sqlite3/, "&-broken") { d = 1 } { print }'
self_test two-calls calls_ok \
  '!d && /native_module_loads \|\| npm rebuild better-sqlite3/ { d = 1; $0 = $0 "; npm rebuild better-sqlite3 --silent 2>/dev/null || true" } { print }'
self_test body-noop finalize_ok \
  '/<<.FINALIZE_EOF.$/ { exit_tamper = 1 } !exit_tamper && !d && /^native_module_loads\(\) \{$/ { d = 1; print "native_module_loads() { :; }; _unused() {"; next } { print }'
self_test outer-deleted finalize_ok \
  '/<<.FINALIZE_EOF.$/ { inb = 1 } !inb && !d && /^[ \t]*native_module_loads\(\)/ { d = 1; skip = 1 } skip { if ($0 == "}") skip = 0; next } { print }'
self_test later-redefinition finalize_ok \
  '/<<.FINALIZE_EOF.$/ { inb = 1 } inb && !d && /^native_module_loads\(\)/ { print; print "native_module_loads() { :; }"; d = 1; next } { print }'

[ "$FAILS" -eq 0 ] && { echo "OK: update-rebuild-gated"; exit 0; }
echo "FAILED: $FAILS"; exit 1
