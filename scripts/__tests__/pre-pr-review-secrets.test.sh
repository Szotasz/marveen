#!/usr/bin/env bash
# pre-pr-review.sh keeps every credential out of argv and URLs, and sends no
# diff that carries a secret or that it would have to truncate.
#
# WHAT THIS GUARDS. The script used to put the Gemini key in the URL
# (`?key=...`), the OpenAI key and the dashboard token in `-H "Authorization:
# Bearer ..."` on curl's command line (visible in `ps`), and the whole diff in
# a `-d` argument, with no secret filter and no timeout.
#
# Nothing leaves the machine: a curl stub on PATH records every argv it gets,
# copies the header files it is handed, and plays both the dashboard vault and
# the two LLM APIs. The fake keys are generated at run time, so this file
# carries no secret-shaped literal for the repo's own gate to trip on.
#
# Run:  bash scripts/__tests__/pre-pr-review-secrets.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }
yes_if() { if eval "$1"; then echo 0; else echo 1; fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/prprev.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
REPO="$SANDBOX/install"; BIN="$SANDBOX/bin"; SCRIPT_TMP="$SANDBOX/tmp"
mkdir -p "$REPO/scripts" "$REPO/store" "$REPO/src/security" "$BIN" "$SCRIPT_TMP"
cp "$ROOT/scripts/pre-pr-review.sh" "$ROOT/scripts/pre-pr-review-scan.ts" "$ROOT/scripts/secret-gate.ts" "$REPO/scripts/"
cp "$ROOT/src/security/secret-gate.ts" "$REPO/src/security/"
cp "$ROOT/package.json" "$REPO/"
# The secret scan runs on the install's own tsx. Without it the script must
# refuse (tested below), so the suite needs `npm ci` to say anything else.
if [ ! -x "$ROOT/node_modules/.bin/tsx" ]; then
  echo "FAIL  node_modules/.bin/tsx missing under $ROOT: run npm ci first"; exit 1
fi
ln -s "$ROOT/node_modules" "$REPO/node_modules"

rand() { python3 -c 'import secrets,string,sys; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(int(sys.argv[1]))))' "$1"; }
DASH_TOKEN="dash$(rand 24)"
OPENAI_VAL="oai$(rand 24)"
GEMINI_VAL="gem$(rand 24)"
printf '%s\n' "$DASH_TOKEN" > "$REPO/store/.dashboard-token"
printf 'WEB_PORT=3999\n' > "$REPO/.env"

# curl stub. Logs: one line per argv element, a "--CALL--" separator per call;
# each `-H @file` header file's content and octal mode; the request body.
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
echo "--CALL--" >> "$CURL_LOG"
out=""; url=""
for a in "$@"; do printf '%s\n' "$a" >> "$CURL_LOG"; done
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2; continue ;;
    -H) case "$2" in @*) f="${2#@}"
          python3 -c 'import os,sys; print("MODE", oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$f" >> "$HDR_LOG"
          cat "$f" >> "$HDR_LOG" ;; esac
        shift 2; continue ;;
    --data-binary) case "$2" in @*) cat "${2#@}" > "$BODY_LOG" ;; esac; shift 2; continue ;;
    http://*|https://*) url="$1" ;;
  esac
  shift
done
code=200
case "$url" in
  */api/vault/OPENAI_API_KEY) if [ -n "${OPENAI_VAL:-}" ]; then body="{\"value\":\"$OPENAI_VAL\"}"; else body='{}'; code=404; fi ;;
  */api/vault/GEMINI_API_KEY) if [ -n "${GEMINI_VAL:-}" ]; then body="{\"value\":\"$GEMINI_VAL\"}"; else body='{}'; code=404; fi ;;
  https://api.openai.com/*) body='{"choices":[{"message":{"content":"OPENAI-REVIEW-TEXT"}}]}'; code="${OPENAI_CODE:-200}"
     [ -n "${OPENAI_REPLY:-}" ] && body="$OPENAI_REPLY"
     [ "$code" = 200 ] || body='{"error":"ECHOED-PROMPT-MARKER"}' ;;
  https://generativelanguage.googleapis.com/*) body='{"candidates":[{"content":{"parts":[{"text":"GEMINI-REVIEW-TEXT"}]}}]}' ;;
  *) body='{}'; code=404 ;;
esac
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
printf '%s' "$code"
STUB
chmod +x "$BIN/curl"

g() { git -C "$REPO" -c user.name=t -c user.email=t@localhost -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
g init -q
printf 'hello\n' > "$REPO/app.txt"; g add app.txt; g commit -qm base; g tag base

# commit_change <file> <content-file>: a fresh commit on top of `base`.
commit_change() {
  g checkout -q -B work base
  mkdir -p "$(dirname "$REPO/$1")"
  cp "$2" "$REPO/$1"; g add -- "$1"; g commit -qm change
}

# run [VAR=value ...]: the script in the sandbox repo, clean env plus the given vars.
run() {
  : > "$SANDBOX/curl.log"; : > "$SANDBOX/hdr.log"; : > "$SANDBOX/body.log"
  (cd "$REPO" && env -u WEB_PORT PATH="$BIN:$PATH" TMPDIR="$SCRIPT_TMP" \
      CURL_LOG="$SANDBOX/curl.log" HDR_LOG="$SANDBOX/hdr.log" BODY_LOG="$SANDBOX/body.log" \
      OPENAI_VAL="$OPENAI_VAL" GEMINI_VAL="$GEMINI_VAL" "$@" \
      /bin/bash scripts/pre-pr-review.sh base >"$SANDBOX/out.txt" 2>"$SANDBOX/err.txt")
  RC=$?
  CALLS="$(grep -c -- '--CALL--' "$SANDBOX/curl.log")"
}
has() { grep -qF -- "$2" "$1"; }

# ---- 1. happy path: both reviewers, nothing secret in argv ----
printf 'def add(a, b):\n    return a + b  # DIFF-BODY-MARKER\n' > "$SANDBOX/c1"
commit_change src/calc.py "$SANDBOX/c1"
run
ok "happy path exits 0" "$RC" "rc=$RC err=$(head -3 "$SANDBOX/err.txt")"
ok "four curl calls (2 vault + 2 LLM)" "$(yes_if '[ "$CALLS" = 4 ]')" "calls=$CALLS"
ok "ChatGPT review printed" "$(yes_if 'has "$SANDBOX/out.txt" "=== ChatGPT Review ===" && has "$SANDBOX/out.txt" OPENAI-REVIEW-TEXT')"
ok "Gemini review printed" "$(yes_if 'has "$SANDBOX/out.txt" "=== Gemini Review ===" && has "$SANDBOX/out.txt" GEMINI-REVIEW-TEXT')"
for v in "$DASH_TOKEN" "$OPENAI_VAL" "$GEMINI_VAL"; do
  ok "no credential value in any curl argv (${v:0:4}...)" "$(yes_if '! has "$SANDBOX/curl.log" "$v"')"
done
ok "no ?key= in any URL" "$(yes_if '! grep -q "key=" "$SANDBOX/curl.log"')"
ok "diff body is not in argv (sent via --data-binary @file)" "$(yes_if '! has "$SANDBOX/curl.log" DIFF-BODY-MARKER && has "$SANDBOX/body.log" DIFF-BODY-MARKER')"
ok "Gemini key travels as x-goog-api-key header" "$(yes_if 'has "$SANDBOX/hdr.log" "x-goog-api-key: $GEMINI_VAL"')"
ok "OpenAI key travels as Authorization header file" "$(yes_if 'has "$SANDBOX/hdr.log" "Authorization: Bearer $OPENAI_VAL"')"
ok "dashboard token travels as Authorization header file" "$(yes_if 'has "$SANDBOX/hdr.log" "Authorization: Bearer $DASH_TOKEN"')"
ok "every header file is 0600" "$(yes_if '[ "$(grep -c "^MODE " "$SANDBOX/hdr.log")" = 4 ] && ! grep "^MODE " "$SANDBOX/hdr.log" | grep -qv "0o600"')"
python3 - "$SANDBOX/curl.log" > "$SANDBOX/limits.txt" <<'PY'
import sys
calls = open(sys.argv[1]).read().split('--CALL--\n')[1:]
bad = [i for i, c in enumerate(calls) if '--connect-timeout\n10\n' not in c or '--max-time\n120\n' not in c]
print('ok' if calls and not bad else f'missing on calls {bad}')
PY
ok "every curl call has --connect-timeout 10 and --max-time 120" "$(yes_if '[ "$(cat "$SANDBOX/limits.txt")" = ok ]')" "$(cat "$SANDBOX/limits.txt")"
ok "vault is asked on the .env port" "$(yes_if 'has "$SANDBOX/curl.log" "http://localhost:3999/api/vault/OPENAI_API_KEY"')"
# (tsx keeps its own cache under TMPDIR; only the script's work dir counts.)
ok "temp dir removed on exit" "$(yes_if '[ -z "$(ls -A "$SCRIPT_TMP" | grep "^pre-pr-review\.")" ]')"

# ---- 2. secret in the diff: abort before ANY curl, value never printed ----
FAKE_GOOGLE="AI""za$(rand 35)"
printf 'x = 1\nconfig = "%s"\n' "$FAKE_GOOGLE" > "$SANDBOX/c2"
commit_change src/conf.py "$SANDBOX/c2"
run
ok "google-key-shaped diff exits non-zero" "$(yes_if '[ "$RC" -ne 0 ]')"
ok "google-key-shaped diff: no curl call at all" "$(yes_if '[ "$CALLS" = 0 ]')" "calls=$CALLS"
ok "finding names file:line" "$(yes_if 'has "$SANDBOX/err.txt" "src/conf.py:2"')" "$(cat "$SANDBOX/err.txt")"
ok "finding never prints the value" "$(yes_if '! has "$SANDBOX/err.txt" "$FAKE_GOOGLE" && ! has "$SANDBOX/out.txt" "$FAKE_GOOGLE"')"

FAKE_SK="s""k-ant-$(rand 40)"
printf 'token = "%s"\n' "$FAKE_SK" > "$SANDBOX/c3"
commit_change lib/x.ts "$SANDBOX/c3"
run
ok "sk- key aborts with no curl" "$(yes_if '[ "$RC" -ne 0 ] && [ "$CALLS" = 0 ]')"

printf -- '-----BEG''IN OPENSSH PRIVATE KEY-----\n' > "$SANDBOX/c4"
commit_change keys/readme.md "$SANDBOX/c4"
run
ok "PEM header aborts with no curl" "$(yes_if '[ "$RC" -ne 0 ] && [ "$CALLS" = 0 ]')"

printf 'value = "%s"\n' "$(rand 48)" > "$SANDBOX/c5"
commit_change lib/y.py "$SANDBOX/c5"
run
ok "high-entropy 48-char token aborts with no curl" "$(yes_if '[ "$RC" -ne 0 ] && [ "$CALLS" = 0 ]')"

printf 'PORT=1\n' > "$SANDBOX/c6"
commit_change config/.env "$SANDBOX/c6"
run
ok ".env path in the diff aborts with no curl" "$(yes_if '[ "$RC" -ne 0 ] && [ "$CALLS" = 0 ] && has "$SANDBOX/err.txt" "config/.env"')"

# A secret on a REMOVED line is still sent to the reviewers: it must block too.
g checkout -q -B work base
printf 'old = "%s"\n' "$FAKE_SK" > "$REPO/legacy.txt"; g add legacy.txt; g commit -qm add-legacy; g tag -f base2 >/dev/null
g rm -q legacy.txt; g commit -qm drop-legacy
( cd "$REPO" && : > "$SANDBOX/curl.log"
  env PATH="$BIN:$PATH" TMPDIR="$SCRIPT_TMP" CURL_LOG="$SANDBOX/curl.log" HDR_LOG=/dev/null BODY_LOG=/dev/null \
    /bin/bash scripts/pre-pr-review.sh base2 >/dev/null 2>"$SANDBOX/err.txt" ); RC=$?
ok "secret on a removed line aborts with no curl" "$(yes_if '[ "$RC" -ne 0 ] && [ ! -s "$SANDBOX/curl.log" ] && has "$SANDBOX/err.txt" "removed line"')"

# ---- 3. no false alarm on public hashes ----
{ printf '"integrity": "sha512-%s==",\n' "$(rand 86)"; printf 'commit %s\n' "$(python3 -c 'import secrets; print(secrets.token_hex(20))')"; } > "$SANDBOX/c7"
commit_change package-lock.json "$SANDBOX/c7"
run
ok "lockfile SRI hash and a commit sha do not block" "$RC" "rc=$RC err=$(head -3 "$SANDBOX/err.txt")"

# ---- 4. oversized diff: refused, not truncated ----
python3 -c 'import sys; sys.stdout.write("line of harmless text\n" * 12000)' > "$SANDBOX/c8"
commit_change big.txt "$SANDBOX/c8"
run
ok "oversized diff exits non-zero with no curl" "$(yes_if '[ "$RC" -ne 0 ] && [ "$CALLS" = 0 ]')"
ok "oversized diff says why" "$(yes_if 'has "$SANDBOX/err.txt" "above the 204800 byte limit"')"

# ---- 5. non-2xx: status only, no body echo ----
commit_change src/calc.py "$SANDBOX/c1"
run OPENAI_CODE=500
ok "HTTP 500 makes the run fail" "$(yes_if '[ "$RC" -ne 0 ]')"
ok "HTTP 500 reported by code" "$(yes_if 'has "$SANDBOX/err.txt" "HTTP 500"')"
ok "HTTP 500 body is not echoed" "$(yes_if '! has "$SANDBOX/err.txt" ECHOED-PROMPT-MARKER && ! has "$SANDBOX/out.txt" ECHOED-PROMPT-MARKER')"
ok "Gemini still runs after the ChatGPT failure" "$(yes_if 'has "$SANDBOX/out.txt" GEMINI-REVIEW-TEXT')"

# ---- 6. compatibility paths ----
run OPENAI_VAL= GEMINI_VAL=
ok "keys missing from vault: both skipped, exit 0" "$(yes_if '[ "$RC" = 0 ] && has "$SANDBOX/out.txt" "OPENAI_API_KEY not set in vault" && has "$SANDBOX/out.txt" "GEMINI_API_KEY not set in vault"')"
ok "keys missing: only the two vault calls" "$(yes_if '[ "$CALLS" = 2 ]')" "calls=$CALLS"

g checkout -q -B work base
run
ok "empty diff: exit 0, nothing sent" "$(yes_if '[ "$RC" = 0 ] && [ "$CALLS" = 0 ] && has "$SANDBOX/out.txt" "No diff found"')"

commit_change src/calc.py "$SANDBOX/c1"
mv "$REPO/.env" "$SANDBOX/env.bak"
run
ok "no .env: falls back to port 3420 instead of dying under pipefail" "$(yes_if '[ "$RC" = 0 ] && has "$SANDBOX/curl.log" "http://localhost:3420/api/vault/OPENAI_API_KEY"')" "rc=$RC"
mv "$SANDBOX/env.bak" "$REPO/.env"

mv "$REPO/store/.dashboard-token" "$SANDBOX/tok.bak"
run
ok "no dashboard token: skip, exit 0, nothing sent" "$(yes_if '[ "$RC" = 0 ] && [ "$CALLS" = 0 ]')"
mv "$SANDBOX/tok.bak" "$REPO/store/.dashboard-token"

# ---- 7. shapes and parser blind spots ----
HEX=0123456789abcdef
rhex() { python3 -c 'import secrets,sys; print(secrets.token_hex(int(sys.argv[1])//2))' "$1"; }
blocks() { # blocks <label> <marker> [VAR=value ...]: expect abort before any curl, marker never sent
  local label="$1" marker="$2"; shift 2
  run "$@"
  ok "$label: aborts, no curl, never sent" "$(yes_if '[ "$RC" -ne 0 ] && [ "$CALLS" = 0 ] && ! has "$SANDBOX/body.log" "$marker"')" "rc=$RC calls=$CALLS"
}
K="s""k_$(rhex 48)"; printf 'ELEVEN = "%s"\n' "$K" > "$SANDBOX/a1"; commit_change a.py "$SANDBOX/a1"
blocks "ElevenLabs sk_+48 hex" "$K"
K="$(rhex 64)"; printf 'TOKEN = "%s"\n' "$K" > "$SANDBOX/a2"; commit_change b.py "$SANDBOX/a2"
blocks "dashboard-token shape (64 hex)" "$K"
K="s""bp_$(rhex 40)"; printf 'x: %s\n' "$K" > "$SANDBOX/a3"; commit_change c.yml "$SANDBOX/a3"
blocks "Supabase sbp_+40 hex" "$K"
K="$(rhex 40)"; printf 'checksum = "%s"\n' "$K" > "$SANDBOX/a4"; commit_change d.py "$SANDBOX/a4"
blocks "40 hex outside a git context" "$K"

# Unchanged secret line carried in the @@ function-context header.
K="s""k-proj-$(rand 40)"
g checkout -q -B work base
{ printf 'api_key: %s\n' "$K"; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf '  k%s: v\n' "$i"; done; } > "$REPO/d.yml"
g add d.yml; g commit -qm d0; g tag -f base3 >/dev/null
sed 's/k10: v/k10: changed/' "$REPO/d.yml" > "$SANDBOX/d.tmp" && cp "$SANDBOX/d.tmp" "$REPO/d.yml"; g commit -qam d1
( cd "$REPO" && : > "$SANDBOX/curl.log" && : > "$SANDBOX/body.log"
  env PATH="$BIN:$PATH" TMPDIR="$SCRIPT_TMP" CURL_LOG="$SANDBOX/curl.log" HDR_LOG=/dev/null BODY_LOG="$SANDBOX/body.log" \
    OPENAI_VAL="$OPENAI_VAL" GEMINI_VAL="$GEMINI_VAL" /bin/bash scripts/pre-pr-review.sh base3 >/dev/null 2>"$SANDBOX/err.txt" ); RC=$?
ok "secret in the @@ hunk header aborts, never sent" "$(yes_if '[ "$RC" -ne 0 ] && [ ! -s "$SANDBOX/curl.log" ] && has "$SANDBOX/err.txt" "hunk header"')" "rc=$RC"

# Removed line reading `-- a/...` (SQL comment) and added line reading `++ b/...`.
K="s""k-proj-$(rand 40)"
g checkout -q -B work base
printf 'select 1;\n-- a/b key %s\n' "$K" > "$REPO/e.sql"; g add e.sql; g commit -qm e0; g tag -f base4 >/dev/null
printf 'select 1;\n' > "$REPO/e.sql"; g commit -qam e1
( cd "$REPO" && : > "$SANDBOX/curl.log"
  env PATH="$BIN:$PATH" TMPDIR="$SCRIPT_TMP" CURL_LOG="$SANDBOX/curl.log" HDR_LOG=/dev/null BODY_LOG=/dev/null \
    /bin/bash scripts/pre-pr-review.sh base4 >/dev/null 2>"$SANDBOX/err.txt" ); RC=$?
ok "removed line '-- a/... <key>' aborts" "$(yes_if '[ "$RC" -ne 0 ] && [ ! -s "$SANDBOX/curl.log" ] && has "$SANDBOX/err.txt" "e.sql:2 (removed line)"')" "rc=$RC $(cat "$SANDBOX/err.txt")"
K="AI""za$(rand 35)"; printf '++ b/x %s\n' "$K" > "$SANDBOX/f1"; commit_change f.txt "$SANDBOX/f1"
blocks "added line '++ b/... <key>'" "$K"

# User git config must not change what is scanned.
mkdir -p "$SANDBOX/cfgsrc"; printf 'DB_PASSWORD=hunter2xyz\n' > "$SANDBOX/cfgsrc/env"
g checkout -q -B work base; mkdir -p "$REPO/cfg"; cp "$SANDBOX/cfgsrc/env" "$REPO/cfg/.env"; g add -f cfg/.env; g commit -qm g
printf '[color]\n\tui = always\n' > "$SANDBOX/gc-color"
blocks ".env path with color.ui=always" hunter2xyz GIT_CONFIG_GLOBAL="$SANDBOX/gc-color"
printf '#!/bin/sh\necho "$1 changed"; diff -u "$2" "$5" | tail -n +3\nexit 0\n' > "$SANDBOX/extdiff"; chmod +x "$SANDBOX/extdiff"
printf '[diff]\n\texternal = %s\n' "$SANDBOX/extdiff" > "$SANDBOX/gc-ext"
blocks ".env path with diff.external" hunter2xyz GIT_CONFIG_GLOBAL="$SANDBOX/gc-ext"
printf '[diff]\n\tnoprefix = true\n' > "$SANDBOX/gc-nop"
blocks ".env path with diff.noprefix" hunter2xyz GIT_CONFIG_GLOBAL="$SANDBOX/gc-nop"

# Exactly 32 hex.
K="$(rhex 32)"; printf 'KEY = "%s"\n' "$K" > "$SANDBOX/a5"; commit_change k32.py "$SANDBOX/a5"
blocks "exactly 32 hex" "$K"

# NUL in the diff: a UTF-16 file forced to text diff hides the key between bytes.
K="AI""za$(rand 35)"
g checkout -q -B work base
printf 'u16.txt diff\n' > "$REPO/.gitattributes"
python3 -c 'import sys; open(sys.argv[1],"wb").write(("key = " + sys.argv[2] + "\n").encode("utf-16-le"))' "$REPO/u16.txt" "$K"
g add .gitattributes u16.txt; g commit -qm u16
blocks "NUL byte in the diff (UTF-16 text)" "$(printf '%s' "$K" | cut -c1-4)"
ok "NUL finding is named" "$(yes_if 'has "$SANDBOX/err.txt" "NUL byte"')"

# A committed .patch carrying a GIT binary patch block.
printf 'diff --git a/k.bin b/k.bin\nGIT binary patch\nliteral 12\nTcmZ?d00001\n\nliteral 0\nHcmV?d00001\n' > "$SANDBOX/p1"
commit_change fix.patch "$SANDBOX/p1"
blocks "GIT binary patch block in the diff" "TcmZ?d00001"
ok "binary patch finding is named" "$(yes_if 'has "$SANDBOX/err.txt" "binary patch block"')"

# Pinned commit sha in a git context is not a secret.
printf 'uses: actions/checkout@%s\n# reverts commit %s\n' "$(rhex 40)" "$(rhex 40)" > "$SANDBOX/h1"
commit_change .github/workflows/x.yml "$SANDBOX/h1"
run
ok "40-hex commit sha after @ / 'commit' does not block" "$RC" "rc=$RC err=$(head -3 "$SANDBOX/err.txt")"

# Terminal escapes in the LLM reply are stripped.
commit_change src/calc.py "$SANDBOX/c1"
run OPENAI_REPLY='{"choices":[{"message":{"content":"A\u001b]0;pwned\u0007\u001b[2JB\r\u009bC"}}]}'
python3 -c 'import sys; d=open(sys.argv[1],"rb").read(); sys.exit(0 if b"A]0;pwned[2JBC" in d and b"\x1b" not in d and b"\r" not in d and b"\x07" not in d and "\u009b".encode() not in d else 1)' "$SANDBOX/out.txt"
ok "control characters stripped from the LLM reply" "$?"

# No local tsx: the scan cannot run, so nothing may be sent.
rm "$REPO/node_modules"
run
ok "no local tsx: refuses, no curl" "$(yes_if '[ "$RC" -ne 0 ] && [ "$CALLS" = 0 ] && has "$SANDBOX/err.txt" "not runnable"')" "rc=$RC calls=$CALLS"
ln -s "$ROOT/node_modules" "$REPO/node_modules"
rm "$REPO/scripts/secret-gate.ts"
run
ok "secret-gate.ts missing: refuses, no curl" "$(yes_if '[ "$RC" -ne 0 ] && [ "$CALLS" = 0 ]')" "rc=$RC calls=$CALLS"
cp "$ROOT/scripts/secret-gate.ts" "$REPO/scripts/"

# ---- 8. static: the script itself ----
ok "bash -n passes" "$(yes_if 'bash -n "$ROOT/scripts/pre-pr-review.sh"')"
ok "no ?key= left in the script" "$(yes_if '! grep -q "?key=" "$ROOT/scripts/pre-pr-review.sh"')"
ok "every request body goes as --data-binary @file" "$(yes_if '! grep -E -- "--data" "$ROOT/scripts/pre-pr-review.sh" | grep -v -- "--data-binary @" | grep -q . && ! grep -Eq -- "-d \"\\\$(PAYLOAD|PROMPT|DIFF)" "$ROOT/scripts/pre-pr-review.sh"')"

echo
echo "$((N-FAILS))/$N passed"
[ "$FAILS" = 0 ]
