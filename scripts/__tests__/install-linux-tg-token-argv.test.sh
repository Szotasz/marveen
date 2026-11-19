#!/bin/bash
# INSTTGTOKENARGV1118: install-linux.sh probe_telegram_token never puts the bot token on a
# command line (another process on the same machine can read argv from ps while curl runs).
# The function is cut from the REAL script and run with a curl stub that records its argv and
# its stdin, and answers by the requested method. The behaviour (the three warnings) must not
# change. Hermetic: throwaway dirs, no network.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail_t() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail_t "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail_t "$1 (missing '$3')" ;; esac; }
assert_not_contains() { case "$2" in *"$3"*) fail_t "$1 (unexpected '$3')" ;; *) pass "$1" ;; esac; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
awk '/^probe_telegram_token\(\) \{$/{on=1} on{print} on && /^\}$/{exit}' "$REPO/install-linux.sh" > "$TMP/fn.sh"
assert_contains "the function was cut from the real script" "$(cat "$TMP/fn.sh")" '_ptt_t="$1"'

TOKEN="123456789:AAFakeTokenForTheArgvProbe_xyz"

# run_case <getMe answer> <getWebhookInfo answer> <getUpdates http code>
run_case() {
  local d="$TMP/c$RANDOM"; mkdir -p "$d/bin"
  cat > "$d/bin/curl" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >> "$d/argv"
in=""; case " \$* " in *" -K - "*) in="\$(cat)"; printf '%s\n' "\$in" >> "$d/stdin" ;; esac
req="\$* \$in"
case "\$req" in
  *"/getMe"*) printf '%s' '$1' ;;
  *"/getWebhookInfo"*) printf '%s' '$2' ;;
  *"/getUpdates"*) printf '%s' '$3' ;;
esac
EOF
  chmod +x "$d/bin/curl"
  cat > "$d/run.sh" <<EOF
set -e
DIM= NC=
warn() { echo "WARN \$*"; }
$(cat "$TMP/fn.sh")
probe_telegram_token "\$PTT_TOKEN"
echo "RC=\$?"
EOF
  OUT="$(PTT_TOKEN="$TOKEN" PATH="$d/bin:/usr/bin:/bin" /bin/bash "$d/run.sh" 2>&1)"
  ARGV="$(cat "$d/argv" 2>/dev/null)"; STDIN="$(cat "$d/stdin" 2>/dev/null)"
  CALLS="$(grep -c . "$d/argv" 2>/dev/null || echo 0)"
}

echo "1. valid token, no webhook, another poller (409): all three calls, token never in argv"
run_case '{"ok":true}' '{"ok":true,"result":{"url":""}}' 409
assert_contains "finished" "$OUT" "RC=0"
assert_eq "three curl calls" 3 "$CALLS"
assert_not_contains "the token is not in any curl argv" "$ARGV" "$TOKEN"
assert_contains "getMe went via stdin config" "$STDIN" "url = \"https://api.telegram.org/bot${TOKEN}/getMe\""
assert_contains "getWebhookInfo went via stdin config" "$STDIN" "/bot${TOKEN}/getWebhookInfo\""
assert_contains "getUpdates went via stdin config" "$STDIN" "/bot${TOKEN}/getUpdates?timeout=0&limit=1\""
assert_contains "the 409 warning still fires" "$OUT" "409 Conflict"
assert_not_contains "the token is not printed" "$OUT" "$TOKEN"

echo "2. invalid token: one call, the invalid-token warning"
run_case '{"ok":false,"error_code":401}' '' 200
assert_eq "one curl call" 1 "$CALLS"
assert_contains "invalid-token warning" "$OUT" "ERVENYTELEN"
assert_not_contains "the token is not in the curl argv" "$ARGV" "$TOKEN"

echo "3. webhook bound: two calls, the webhook warning"
run_case '{"ok":true}' '{"ok":true,"result":{"url":"https://example.invalid/hook"}}' 200
assert_eq "two curl calls" 2 "$CALLS"
assert_contains "webhook warning" "$OUT" "WEBHOOKRA"
assert_not_contains "the token is not in the curl argv" "$ARGV" "$TOKEN"

echo "4. a token that is not a bot token (a quote, a line break, a trailing line break, no id, a letter in the id, empty after the colon): no call, the shape warning"
for bad in 'abc' '123:AA"x' "$(printf '123:AAx\nurl = "http://example.invalid/"')" $'123:AAx\n' ':AAx' '12a:AAx' '123:'; do
  TOKEN="$bad"
  run_case '{"ok":true}' '{"ok":true,"result":{"url":""}}' 409
  assert_eq "no curl call" 0 "$CALLS"
  assert_contains "the shape warning" "$OUT" "alakja ERVENYTELEN"
done
TOKEN="123456789:AAFakeTokenForTheArgvProbe_xyz"

echo ""
echo "Results: $PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ] || { echo "FAILED: $FAIL tests"; exit 1; }
