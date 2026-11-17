#!/bin/bash
# MANAGEDDIRMODE2816 (maintainer finding on PR 2816): the mode of the Teams managed-settings
# directory in install-linux.sh. The mkdir of dirname(TEAMS_MANAGED_FILE) must be an explicit
# 0755: the OR-umask version changed nothing under umask 077 (077|022=077), so the fresh
# root-owned /etc/claude-code came out 0700, the unprivileged Claude session could not traverse
# it and the policy silently never applied. The real block is cut from the script, re-pointed
# into a temp dir, and run with PATH stubs (id prints 1000, sudo is a passthrough, python3
# records argv, mkdir records argv AND forwards to /bin/mkdir): under umask 077 AND umask 002
# the recorded mkdir argv must carry -m and 0755, and the created directory's real mode
# (stat -c %a) must be 755. Hermetic: throwaway dirs, no sudo, no network, nothing installed.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail_t() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail_t "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail_t "$1 (missing '$3')" ;; esac; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# the whole Teams managed-settings block, from its opening if to the block-closing fi
awk '/^if \[ "\$CHANNEL_PROVIDER" = "teams" \]; then$/{on=1} on{print} on && /^fi$/{exit}' "$REPO/install-linux.sh" > "$TMP/block.sh"
assert_contains "the Teams managed block was cut from the real script" "$(cat "$TMP/block.sh")" 'managed-settings-write.py'

# run_um <umask-octal>: runs the cut block (the managed file re-pointed into a fresh temp dir)
# under that caller umask. PATH is ONLY the stub dir (+ dirname, the one real tool the block
# needs), so the runner's own sudo/python3/mkdir never decide a case.
run_um() {
  local um="$1"
  D="$TMP/u$um"; mkdir -p "$D/bin"
  printf '#!/bin/bash\necho 1000\n' > "$D/bin/id"
  printf '#!/bin/bash\nexec "$@"\n' > "$D/bin/sudo"
  cat > "$D/bin/python3" <<EOF
#!/bin/bash
printf 'python3 %s\n' "\$*" >> "$D/py.log"
exit 0
EOF
  cat > "$D/bin/mkdir" <<EOF
#!/bin/bash
printf 'mkdir %s\n' "\$*" >> "$D/mkdir.log"
exec /bin/mkdir "\$@"
EOF
  ln -s "$(command -v dirname)" "$D/bin/dirname"
  chmod +x "$D/bin/id" "$D/bin/sudo" "$D/bin/python3" "$D/bin/mkdir"
  sed "s#/etc/claude-code/managed-settings.json#$D/target/managed-settings.json#" "$TMP/block.sh" > "$D/block.sh"
  cat > "$D/run.sh" <<EOF
set -e
umask $um
CHANNEL_PROVIDER=teams
TEAMS_ALLOWLIST_PLUGINS="teams@marveen-marketplace"
DIM= NC=
ok() { echo "OK \$*"; }
warn() { echo "WARN \$*"; }
managed_settings_notice() { :; }
managed_allows_all() { return 1; }
INSTALL_DIR="$D"
. "$D/block.sh"
EOF
  OUT="$(PATH="$D/bin" /bin/bash "$D/run.sh" 2>&1)"; RC=$?
}

for um in 077 002; do
  echo "$um: caller umask $um -> explicit -m 0755, whatever the umask would leave"
  run_um "$um"
  assert_eq "$um: rc" 0 "$RC"
  assert_contains "$um: the write path succeeded (no manual fallback)" "$OUT" "Teams engedelyezve"
  assert_contains "$um: the mkdir argv carries -m" "$(cat "$D/mkdir.log" 2>/dev/null)" "-m"
  assert_contains "$um: the mkdir argv carries 0755" "$(cat "$D/mkdir.log" 2>/dev/null)" "0755"
  assert_contains "$um: the python writer ran on the managed file" "$(cat "$D/py.log" 2>/dev/null)" "managed-settings-write.py"
  assert_eq "$um: the created directory's real mode is 755" "755" "$(stat -c %a "$D/target" 2>/dev/null || stat -f %Lp "$D/target" 2>/dev/null || echo missing)"
done

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
