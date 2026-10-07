#!/bin/bash
# Contract tests for the network wait before the main session starts
# (BOOTSTAGGER1007 (a), scripts/lib/channel-net-wait.sh).
#
# Origin (measured 2026-10-07): after a power cut launchd started the main
# session before DNS was up; the co-listen Slack plugin's MCP connect failed for
# good ("getaddrinfo ENOTFOUND slack.com") and the owner's main channel stayed
# deaf for 30 minutes. channels.sh now waits (bounded) until the primary and
# every co-listen provider's host resolves.
#
# Driven through channels.sh's test seams (--channel-wait-hosts,
# --channel-net-wait), so a mutant copy of the script can turn this red via
# CHANNELS_BIN. The resolver is replaced with CHANNEL_DNS_PROBE except in the
# "real resolver" block, which runs the actual node/python3/getent chain of the
# host it runs on (macOS locally, Linux in CI).
# Run: bash scripts/__tests__/channels-net-wait.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }
eq() { if [ "$3" = "$2" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNELS="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

hosts() { bash "$CHANNELS" --channel-wait-hosts "$@" 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }

echo "channels.sh network wait: which hosts"
echo "====================================="
eq "telegram primary alone"                     "api.telegram.org"           "$(hosts telegram)"
eq "telegram + slack co-listen (our host)"      "api.telegram.org slack.com" "$(hosts telegram slack-channel@marveen-marketplace)"
eq "slack primary + telegram co-listen"         "slack.com api.telegram.org" "$(hosts slack telegram@claude-plugins-official)"
eq "a host shared by primary and extra is waited for once" "slack.com" "$(hosts slack slack-channel@marveen-marketplace)"
eq "discord"                                    "discord.com"                "$(hosts discord)"
eq "a provider with no known host is skipped"   "api.telegram.org"           "$(hosts telegram whatsapp@marveen-marketplace)"
got="$(bash "$CHANNELS" --channel-wait-hosts telegram whatsapp@marveen-marketplace 2>&1 >/dev/null)"
case "$got" in *"no known host for provider 'whatsapp'"*) pass "...and the skip is said, not silent" ;; *) fail "...and the skip is said" "a log line" "$got" ;; esac

echo ""
echo "channels.sh network wait: the loop (fake resolver)"
echo "=================================================="
# A resolver that starts answering after N calls PER HOST (a network coming up).
cat > "$TMPD/probe-after" <<'EOF'
#!/bin/bash
f="$PROBE_DIR/count-$1"
n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$f"
[ "$n" -ge "$PROBE_OK_AFTER" ]
EOF
chmod +x "$TMPD/probe-after"
printf '#!/bin/sh\nexit 1\n' > "$TMPD/probe-never"; chmod +x "$TMPD/probe-never"
printf '#!/bin/sh\nexit 2\n' > "$TMPD/probe-none"; chmod +x "$TMPD/probe-none"
printf '#!/bin/sh\nexit 0\n' > "$TMPD/probe-up"; chmod +x "$TMPD/probe-up"

run_wait() { CHANNEL_NET_WAIT_INTERVAL_S="${INTERVAL:-0.1}" CHANNEL_NET_WAIT_MAX_S="${MAX:-10}" bash "$CHANNELS" --channel-net-wait "$@" 2>"$TMPD/err"; }

mkdir -p "$TMPD/c1"
PROBE_DIR="$TMPD/c1" PROBE_OK_AFTER=3 CHANNEL_DNS_PROBE="$TMPD/probe-after" run_wait api.telegram.org slack.com; rc=$?
eq "resolves after 3 tries -> exit 0" "0" "$rc"
eq "...it asked until it resolved (telegram)" "3" "$(cat "$TMPD/c1/count-api.telegram.org")"
eq "...and for every host, not just the first (slack)" "3" "$(cat "$TMPD/c1/count-slack.com")"
grep -q "waiting for" "$TMPD/err" && pass "...the wait is logged" || fail "...the wait is logged" "a 'waiting for' line" "$(cat "$TMPD/err")"
grep -q "all channel hosts resolve after" "$TMPD/err" && pass "...and so is the end" || fail "...and so is the end" "an 'all ... resolve' line" "$(cat "$TMPD/err")"

t0=$(date +%s)
MAX=1 CHANNEL_DNS_PROBE="$TMPD/probe-never" run_wait slack.com; rc=$?
el=$(( $(date +%s) - t0 ))
eq "never resolves -> gives up with exit 1" "1" "$rc"
[ "$el" -le 4 ] && pass "...at the limit, not later (${el}s for a 1s limit)" || fail "...at the limit" "<=4s" "${el}s"
grep -q "GAVE UP" "$TMPD/err" && grep -q "starting the session anyway" "$TMPD/err" && pass "...and says the session starts anyway" || fail "...says it starts anyway" "GAVE UP line" "$(cat "$TMPD/err")"

CHANNEL_DNS_PROBE="$TMPD/probe-up" run_wait api.telegram.org slack.com; rc=$?
eq "network already up -> exit 0" "0" "$rc"
eq "...silently (no wait line)" "" "$(cat "$TMPD/err")"

CHANNEL_DNS_PROBE="$TMPD/probe-none" run_wait slack.com; rc=$?
eq "no resolver on the host -> does not block (exit 0)" "0" "$rc"
grep -q "no resolver" "$TMPD/err" && pass "...and says so" || fail "...says no resolver" "a line" "$(cat "$TMPD/err")"

run_wait; rc=$?
eq "no hosts -> exit 0 at once" "0" "$rc"

echo ""
echo "channels.sh network wait: the real resolver chain on this host"
echo "=============================================================="
MAX=2 run_wait localhost; rc=$?
eq "localhost resolves" "0" "$rc"
MAX=1 run_wait no-such-host.invalid; rc=$?
eq "an .invalid name does not (RFC 6761), and the wait gives up" "1" "$rc"

# Each fallback of the chain, forced: a PATH that holds only the basic tools
# plus ONE resolver. getent exists on Linux only (measured: absent on macOS),
# so that branch runs in CI and is reported as skipped on a Mac.
BASH_BIN="$(command -v bash)"
tooldir() {
  local d="$TMPD/$1"; mkdir -p "$d"
  for t in date sleep cat dirname head cut grep tr sed; do
    [ -x "$(command -v "$t")" ] && ln -sf "$(command -v "$t")" "$d/$t"
  done
  echo "$d"
}
only_resolver() {  # $1 = resolver binary name, rest = hosts; prints the exit code
  local d; d="$(tooldir "only-$1")"
  ln -sf "$(command -v "$1")" "$d/$1"
  PATH="$d" CHANNEL_NET_WAIT_INTERVAL_S=0.1 CHANNEL_NET_WAIT_MAX_S=1 "$BASH_BIN" "$CHANNELS" --channel-net-wait "${@:2}" 2>/dev/null; echo $?
}
if command -v python3 >/dev/null 2>&1; then
  eq "python3 branch (no node): localhost resolves" "0" "$(only_resolver python3 localhost)"
  eq "python3 branch (no node): an .invalid name does not" "1" "$(only_resolver python3 no-such-host.invalid)"
else
  echo "  SKIP: python3 branch (no python3 on this host)"
fi
if command -v getent >/dev/null 2>&1; then
  eq "getent branch (no node, no python3): localhost resolves" "0" "$(only_resolver getent localhost)"
  eq "getent branch (no node, no python3): an .invalid name does not" "1" "$(only_resolver getent no-such-host.invalid)"
else
  echo "  SKIP: getent branch (no getent on this host -- macOS)"
fi
d="$(tooldir none)"
PATH="$d" CHANNEL_NET_WAIT_MAX_S=1 "$BASH_BIN" "$CHANNELS" --channel-net-wait slack.com 2>/dev/null; rc=$?
eq "no resolver at all (none of node/python3/getent): does not block" "0" "$rc"

echo ""
echo "channels.sh network wait: wired into the main launch"
echo "===================================================="
# The launch itself needs tmux and claude; the order is pinned on the source.
SRC="$CHANNELS"
wait_ln="$(grep -n 'wait_for_channel_hosts \$(channel_wait_hosts "\$CHANNEL_PROVIDER" \$CHANNEL_PLUGINS_EXTRA) || true' "$SRC" | head -1 | cut -d: -f1)"
launch_ln="$(grep -n 'new-session -d -s "\$SESSION" -c "\$INSTALL_DIR"' "$SRC" | head -1 | cut -d: -f1)"
[ -n "$wait_ln" ] && pass "the launch path waits for the primary + co-listen hosts, and never aborts on a give-up (|| true)" || fail "launch path waits" "the wait line" "none"
[ -n "$wait_ln" ] && [ -n "$launch_ln" ] && [ "$wait_ln" -lt "$launch_ln" ] && pass "...before the main session is created" || fail "...before new-session" "wait < launch" "wait=$wait_ln launch=$launch_ln"

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
