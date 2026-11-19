#!/bin/bash
# INSTEXECARGS1118: when install-linux.sh runs from outside a checkout, it clones (or
# updates) ~/marveen and re-runs itself from there. The flags given on the command line
# (e.g. --port) must reach that second run. The flag loop shifts every argument, so the
# re-exec used to pass an empty list and --port was silently lost.
# The two blocks under test are cut from the REAL script (the flag loop and the repo
# bootstrap) and run with stubs: the "checkout" install-linux.sh only prints its argv.
# Hermetic: throwaway dirs, no sudo, no network, nothing installed.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail_t() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail_t "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail_t "$1 (missing '$3')" ;; esac; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
awk '/^# CLI flag parsing/{on=1} on{print} /^WEB_PORT="\$\{WEB_PORT:-3420\}"$/{on=0}' "$REPO/install-linux.sh" > "$TMP/flags.sh"
awk '/^# Repo bootstrap$/{on=1} on{print} on && /^fi$/{exit}' "$REPO/install-linux.sh" > "$TMP/bootstrap.sh"
assert_contains "the flag loop was cut from the real script" "$(cat "$TMP/flags.sh")" '--port|--web-port)'
assert_contains "the re-exec was cut from the real script" "$(cat "$TMP/bootstrap.sh")" 'exec bash "$TARGET_DIR/install-linux.sh"'

# run_case <with existing checkout 1/0> <args...>: OUT = what the re-run install-linux.sh saw.
run_case() {
  local existing="$1"; shift
  local d="$TMP/c$RANDOM"; mkdir -p "$d/home" "$d/outside" "$d/bin"
  # The re-run target: a checkout whose installer only reports its argv, one per line.
  local target="$d/home/marveen"
  printf '#!/bin/bash\necho "RERUN argc=$#"\nfor a in "$@"; do echo "ARG[$a]"; done\n' > "$d/rerun.sh"
  if [ "$existing" = 1 ]; then
    mkdir -p "$target"; echo '{}' > "$target/package.json"; cp "$d/rerun.sh" "$target/install-linux.sh"
  fi
  # git stub: `pull` succeeds; `clone ... <dir>` creates the checkout.
  cat > "$d/bin/git" <<EOF
#!/bin/bash
case " \$* " in
  *" clone "*) dir="\${@: -1}"; mkdir -p "\$dir"; echo '{}' > "\$dir/package.json"; cp "$d/rerun.sh" "\$dir/install-linux.sh" ;;
esac
exit 0
EOF
  chmod +x "$d/bin/git"
  cat > "$d/outside/install-linux.sh" <<EOF
set -e
RED= GREEN= ORANGE= NC= DIM= BOLD=
warn() { echo "WARN \$*"; }
ok() { echo "OK \$*"; }
fail() { echo "FAIL \$*"; exit 1; }
MARVEEN_REF=main
INSTALL_DIR="$d/outside"
$(cat "$TMP/flags.sh")
$(cat "$TMP/bootstrap.sh")
echo "NOT-REEXECED"
EOF
  OUT="$(HOME="$d/home" PATH="$d/bin:/usr/bin:/bin" /bin/bash "$d/outside/install-linux.sh" "$@" 2>&1)"; RC=$?
}

echo "1. fresh clone: --port 3555 reaches the re-run"
run_case 0 --port 3555
assert_eq "rc" 0 "$RC"
assert_contains "re-run happened" "$OUT" "RERUN argc=2"
assert_contains "--port reached the re-run" "$OUT" "ARG[--port]"
assert_contains "its value too" "$OUT" "ARG[3555]"

echo "2. existing checkout (pull path): --web-port 3600 reaches the re-run"
run_case 1 --web-port 3600
assert_eq "rc" 0 "$RC"
assert_contains "re-run happened" "$OUT" "RERUN argc=2"
assert_contains "--web-port reached the re-run" "$OUT" "ARG[--web-port]"
assert_contains "its value too" "$OUT" "ARG[3600]"

echo "3. an argument with a space survives as one argument"
run_case 0 --user "a b"
assert_contains "re-run happened" "$OUT" "RERUN argc=2"
assert_contains "kept as one word" "$OUT" "ARG[a b]"

echo "4. no flags: the re-run gets none"
run_case 0
assert_contains "re-run with an empty argv" "$OUT" "RERUN argc=0"

echo ""
echo "Results: $PASS/$((PASS + FAIL)) passed"
[ "$FAIL" -eq 0 ] || { echo "FAILED: $FAIL tests"; exit 1; }
