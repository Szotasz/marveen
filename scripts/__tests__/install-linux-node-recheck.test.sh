#!/bin/bash
# LINUXINSTPREREQ1104: install-linux.sh never goes on with a Node.js older than v20.
# The block under test is cut from the REAL script (from "# Node.js v20+ ellenorzes" up to
# the ffmpeg version line) and run with stubs: node/npm appear on PATH only when a stubbed
# package step installs them, at the major version the case asks for.
# Hermetic: throwaway dirs, no sudo, no network, nothing installed.
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
awk '/^# Node.js v20\+ ellenorzes$/{on=1} /^ok "ffmpeg /{on=0} on' "$REPO/install-linux.sh" > "$TMP/block.sh"
assert_contains "the block was cut from the real script" "$(cat "$TMP/block.sh")" 'NODE_VER=$(node_major)'
assert_contains "the post-check is in the block" "$(cat "$TMP/block.sh")" 'the rule again, after the package step'

# A stub node/npm pair of a given major version, put into $1.
put_node() {
  printf '#!/bin/bash\n[ "$1" = "-e" ] && printf %%s %s && exit 0\necho v%s.0.0\n' "$2" "$2" > "$1/node"
  printf '#!/bin/bash\necho 10.0.0\n' > "$1/npm"
  chmod +x "$1/node" "$1/npm"
}

declare -f put_node > "$TMP/helpers.sh"

# run_case <pkg manager> <node major already on PATH or 0> <nodesource ok 1/0> <apt candidate major> <major a package install yields>
run_case() {
  local d="$TMP/c$RANDOM"; mkdir -p "$d/bin"
  [ "$2" != 0 ] && put_node "$d/bin" "$2"
  printf '#!/bin/bash\n[ "%s" = 1 ] && { echo "# nodesource setup"; exit 0; }\nexit 6\n' "$3" > "$d/bin/curl"
  printf '#!/bin/bash\nprintf "nodejs:\\n  Installed: (none)\\n  Candidate: %s\\n"\n' "$( [ "$4" = 0 ] && echo '(none)' || echo "1:$4.19.1+dfsg-6ubuntu5" )" > "$d/bin/apt-cache"
  # sudo: only the nodesource setup pipe reaches it here (apt_run is stubbed below).
  printf '#!/bin/bash\ncat >/dev/null\necho nodesource >> "%s/log"\nexit 0\n' "$d" > "$d/bin/sudo"
  for t in awk grep cat chmod sed; do ln -s "$(command -v $t)" "$d/bin/$t" 2>/dev/null; done
  chmod +x "$d/bin/"*
  cat > "$d/run.sh" <<EOF
set -e
RED= GREEN= ORANGE= NC= DIM= BOLD=
. "$REPO/install-lang.sh"
warn() { echo "WARN \$*"; }
ok() { echo "OK \$*"; }
fail() { echo "FAIL \$*"; exit 1; }
wait_for_apt_lock() { :; }
. "$TMP/helpers.sh"
installs() { echo "\$*" | grep -qw nodejs && put_node "$d/bin" "$5"; return 0; }
apt_run() { echo "apt_run \$*" >> "$d/log"; installs "\$@"; }
pkg_install_noninteractive() { echo "pkg \$*" >> "$d/log"; installs "\$@"; }
PKG_MANAGER=$1
NONINTERACTIVE_ENV=
MISSING_PKGS=" ffmpeg"
. "$TMP/block.sh"
echo "REACHED-END node=\$(node_major)"
EOF
  OUT="$(PATH="$d/bin" /bin/bash "$d/run.sh" 2>&1)"; RC=$?
  LOG="$(cat "$d/log" 2>/dev/null)"
}

echo "1. Ubuntu 24.04 shape: no nodesource, distro candidate 18 -> loud stop, Node 18 NOT installed"
run_case apt 0 0 18 18
assert_eq "rc" 1 "$RC"
assert_contains "names the distro version" "$OUT" "18."
assert_contains "gives the fix line" "$OUT" "deb.nodesource.com/setup_22.x | sudo bash -"
assert_not_contains "nodejs was not installed" "$LOG" "install -y"
assert_not_contains "never reached the end" "$OUT" "REACHED-END"

echo "2. nodesource works -> v22, goes on"
run_case apt 0 1 18 22
assert_eq "rc" 0 "$RC"
assert_contains "reached the end with 22" "$OUT" "REACHED-END node=22"
assert_contains "nodesource ran" "$LOG" "nodesource"

echo "3. no nodesource, distro candidate 20 -> installs nodejs + npm, goes on"
run_case apt 0 0 20 20
assert_eq "rc" 0 "$RC"
assert_contains "npm added for the distro package" "$LOG" "npm"
assert_contains "reached the end with 20" "$OUT" "REACHED-END node=20"

echo "4. dnf gives 18 -> the post-check stops it, with the rpm hint"
run_case dnf 0 0 0 18
assert_eq "rc" 1 "$RC"
assert_contains "rpm hint" "$OUT" "nodejs.org"
assert_not_contains "never reached the end" "$OUT" "REACHED-END"

echo "5. node 22 already there -> nodejs not touched"
run_case apt 22 0 0 0
assert_eq "rc" 0 "$RC"
assert_not_contains "no nodejs install" "$LOG" "nodejs"
assert_contains "reached the end" "$OUT" "REACHED-END node=22"

echo "6. nodesource 'worked' but the install still yields 18 -> the post-check stops it"
run_case apt 0 1 18 18
assert_eq "rc" 1 "$RC"
assert_contains "names the installed major" "$OUT" "18."
assert_not_contains "never reached the end" "$OUT" "REACHED-END"

echo "7. English text"
OUT="$(MARVEEN_LANG=en /bin/bash -c ". '$REPO/install-lang.sh'; _t linux.node_too_old; _t linux.node_distro_too_old; _t linux.node_fix_lead; _t linux.node_fix_rpm")"
assert_not_contains "every key resolves (no raw key)" "$OUT" "linux.node_"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
