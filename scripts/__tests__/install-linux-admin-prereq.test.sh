#!/bin/bash
# LINUXINSTPREREQ1104 PR2: the non-admin pre-check and the --admin-prereq switch of install-linux.sh.
#   1. the pre-check block, cut from the REAL script, with stubbed id/sudo/python3:
#      a non-admin user with missing packages stops (rc 1) BEFORE the package step, with the list
#      and the one-line admin command; a sudo/admin/wheel member and a passwordless-sudo user keep
#      the old path (no stop, no text); nothing missing -> no stop.
#   2. --admin-prereq without root stops at once with the command; --help names the switch.
#   3. the admin branch exits before the repo bootstrap (no clone, no user-level step).
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
awk '/^# LINUXINSTPREREQ1104: the non-admin pre-check\./{on=1} on{print} /^ADMIN_INSTALLED="\$MISSING_PKGS"$/{on=0}' "$REPO/install-linux.sh" > "$TMP/pre.sh"
assert_contains "the pre-check was cut from the real script" "$(cat "$TMP/pre.sh")" 'admin_group_member'
# the helper definitions of the early root guard (admin_prereq_cmd, root_only_path)
awk '/^MARVEEN_OFFICIAL_RAW=/{on=1} /^__ADMIN_MODE=0$/{on=0} on' "$REPO/install-linux.sh" > "$TMP/defs.sh"
assert_contains "the guard helpers were cut" "$(cat "$TMP/defs.sh")" 'admin_prereq_cmd()'
# the whole guard block, up to the install-lang loader
awk '/^MARVEEN_OFFICIAL_RAW=/{on=1} /^# shellcheck source=install-lang.sh$/{on=0} on' "$REPO/install-linux.sh" > "$TMP/guard.sh"
assert_contains "the guard was cut" "$(cat "$TMP/guard.sh")" 'root_only_path "$__self"'

# run_pre <groups> <sudo -n ok 1/0> <uid> <missing pkgs> <node major> <gate json or ''> [linger yes|no|na]
# PATH is ONLY the stub dir (+ the few real tools the block uses), so the runner's own loginctl/sudo
# never decide a case.
run_pre() {
  local d="$TMP/p$RANDOM"; mkdir -p "$d/bin" "$d/etc"
  local lg="${7:-yes}"
  for t in tr grep python3 cat; do ln -s "$(command -v $t)" "$d/bin/$t"; done
  if [ "$lg" != na ]; then
    printf '#!/bin/bash\necho "Linger=%s"\n' "$( [ "$lg" = nosd ] && echo no || echo "$lg" )" > "$d/bin/loginctl"
  fi
  printf '#!/bin/bash\ncase "$1" in -u) echo %s ;; -un) echo qauser ;; -nG) echo "%s" ;; *) echo "uid=%s" ;; esac\n' "$3" "$1" "$3" > "$d/bin/id"
  printf '#!/bin/bash\n[ "$1" = -n ] && exit %s\nexit 1\n' "$( [ "$2" = 1 ] && echo 0 || echo 1 )" > "$d/bin/sudo"
  chmod +x "$d/bin/"*
  [ -n "$6" ] && printf '%s' "$6" > "$d/etc/ms.json"
  sed "s#/etc/claude-code/managed-settings.json#$d/etc/ms.json#" "$TMP/pre.sh" > "$d/pre.sh"
  cat > "$d/run.sh" <<EOF
set -e
RED= GREEN= ORANGE= NC= DIM= BOLD=
. "$REPO/install-lang.sh"
warn() { echo "WARN \$*"; }
. "$TMP/defs.sh"
ADMIN_PREREQ=0
MISSING_PKGS="$4"
LINGER_SYSTEMD_DIR="$( [ "$lg" = nosd ] && echo "$d/none" || echo "$d" )"
NODE_VER=$5
. "$d/pre.sh"
echo "REACHED-PACKAGE-STEP"
EOF
  OUT="$(PATH="$d/bin" /bin/bash "$d/run.sh" 2>&1)"; RC=$?
}

echo "1. non-admin (no group, no passwordless sudo), packages missing -> stop before the package step"
run_pre "u users" 0 1002 " ffmpeg nodejs" 18 ''
assert_eq "rc" 1 "$RC"
assert_not_contains "stopped before the package step" "$OUT" "REACHED-PACKAGE-STEP"
assert_contains "lists the packages" "$OUT" "ffmpeg nodejs"
assert_contains "names the Node version" "$OUT" "18"
assert_contains "the gate is reported missing" "$OUT" "/etc/claude-code"
assert_contains "the stated limit (ollama, bumblebee)" "$OUT" "ollama"
assert_contains "the admin command fetches the official script" "$OUT" 'raw.githubusercontent.com/Szotasz/marveen/main/install-linux.sh'
assert_contains "the admin command names this user" "$OUT" '--admin-prereq --user qauser'
assert_contains "the admin command carries the ref to the fetched script" "$OUT" 'MARVEEN_REF=main bash'
assert_not_contains "the admin command never points at a user path" "$OUT" '/home/'

echo "1b. non-admin, no node at all -> says 'not installed', not 'version 0'"
run_pre "u" 0 1002 " nodejs" 0 ''
assert_eq "rc" 1 "$RC"
assert_contains "not installed" "$OUT" "nincs telepítve"
assert_not_contains "no 'version 0'" "$OUT" "verzió) 0"

echo "2. sudo-group member, no passwordless sudo -> the old path, unchanged (no pre-check text)"
for g in sudo admin wheel; do
  run_pre "u $g" 0 1000 " ffmpeg" 18 ''
  assert_eq "$g: rc" 0 "$RC"
  assert_contains "$g: reaches the package step" "$OUT" "REACHED-PACKAGE-STEP"
  assert_not_contains "$g: no pre-check text" "$OUT" "--admin-prereq"
done

echo "3. passwordless sudo (not in a group) -> the old path"
run_pre "u" 1 1003 " ffmpeg" 18 ''
assert_eq "rc" 0 "$RC"
assert_not_contains "no pre-check text" "$OUT" "--admin-prereq"

echo "4. root -> the old path"
run_pre "root" 0 0 " ffmpeg" 18 ''
assert_eq "rc" 0 "$RC"

echo "5. non-admin, nothing missing, gate on -> goes on silently"
run_pre "u" 0 1002 "" 22 '{"channelsEnabled": true}'
assert_eq "rc" 0 "$RC"
assert_contains "reaches the package step" "$OUT" "REACHED-PACKAGE-STEP"
assert_not_contains "no gate warning" "$OUT" "/etc/claude-code"
assert_contains "the stated limit, before the install goes on" "$OUT" "WARN Sudo nélkül a szemantikus memória (ollama)"

echo "6. non-admin, nothing missing, gate off -> goes on, with the gate warning and the command"
run_pre "u" 0 1002 "" 22 '{"channelsEnabled": false}'
assert_eq "rc" 0 "$RC"
assert_contains "the gate warning" "$OUT" "WARN"
assert_contains "the command" "$OUT" "--admin-prereq"

echo "6b. non-admin, packages there, linger OFF -> stop (the services would die with the session)"
run_pre "u" 0 1002 "" 22 '{"channelsEnabled": true}' no
assert_eq "rc" 1 "$RC"
assert_contains "names linger" "$OUT" "loginctl linger"
assert_not_contains "no package line" "$OUT" "csomagok:"
assert_contains "the command with --user" "$OUT" "--admin-prereq --user qauser"

echo "6c. non-admin, packages there, no loginctl (no systemd) -> goes on"
run_pre "u" 0 1002 "" 22 '{"channelsEnabled": true}' na
assert_eq "rc" 0 "$RC"
assert_contains "reaches the package step" "$OUT" "REACHED-PACKAGE-STEP"

echo "6d. non-admin, packages there, loginctl installed but systemd not running (container/WSL) -> goes on"
run_pre "u" 0 1002 "" 22 '{"channelsEnabled": true}' nosd
assert_eq "rc" 0 "$RC"
assert_contains "reaches the package step" "$OUT" "REACHED-PACKAGE-STEP"

echo "7. --admin-prereq without root, --help"
# Only as non-root: as root this would be the real admin run (packages installed on the runner).
if [ "$(id -u)" -ne 0 ]; then
  OUT="$(MARVEEN_LANG=en /bin/bash "$REPO/install-linux.sh" --admin-prereq 2>&1 </dev/null)"; RC=$?
  assert_eq "non-root --admin-prereq: rc" 1 "$RC"
  assert_contains "non-root: names the official command" "$OUT" "raw.githubusercontent.com/Szotasz/marveen/main/install-linux.sh"
  assert_not_contains "non-root: no step ran" "$OUT" "[1/7]"
fi
OUT="$(/bin/bash "$REPO/install-linux.sh" --help 2>&1)"
assert_contains "--help names the switch" "$OUT" "--admin-prereq"
assert_contains "--help names --user" "$OUT" "--user <name>"
OUT="$(/bin/bash "$REPO/install-linux.sh" --user someone 2>&1 </dev/null)"; RC=$?
assert_eq "--user without --admin-prereq: rc" 1 "$RC"

echo "7b. ADMINPREREQTRUST1104: the early root guard (the real block; stubbed id/stat owner, real modes)"
# stat stub: %u = FAKE_UID, %a = the real permission bits (python, so it works on any OS)
mkdir -p "$TMP/gbin"
cat > "$TMP/gbin/stat" <<'EOF'
#!/usr/bin/env python3
import os, sys
fmt, path = sys.argv[2], sys.argv[3]
st = os.stat(path)
uid = os.environ.get('FAKE_UID_FILE') if path == os.environ.get('FAKE_UID_PATH') else None
print((uid or os.environ.get('FAKE_UID', '0')) if fmt == '%u' else oct(st.st_mode & 0o7777)[2:])
EOF
printf '#!/bin/bash\n[ "$1" = -u ] && echo "${FAKE_ID:-0}" || /usr/bin/id "$@"\n' > "$TMP/gbin/id"
chmod +x "$TMP/gbin/stat" "$TMP/gbin/id"
mk_guard() { # $1 dir; the guard + a marker, as <dir>/install-linux.sh
  mkdir -p "$1"; { echo '#!/bin/bash'; cat "$TMP/guard.sh"; echo 'echo GUARD-PASSED'; } > "$1/install-linux.sh"; chmod 644 "$1/install-linux.sh"
}
g() { # env... ; runs the guard copy in $GD as "root" with --admin-prereq
  OUT="$(env PATH="$TMP/gbin:$PATH" "$@" /bin/bash "$GD/install-linux.sh" --admin-prereq --user x 2>&1)"; RC=$?
}
GD="$TMP/g1"; mk_guard "$GD"; chmod 755 "$GD"
g FAKE_UID=1000
assert_eq "a user-owned script: rc" 1 "$RC"
assert_contains "a user-owned script: refused, with the official command" "$OUT" "raw.githubusercontent.com/Szotasz/marveen/main/install-linux.sh"
assert_not_contains "a user-owned script: nothing ran" "$OUT" "GUARD-PASSED"
g FAKE_UID=0
assert_contains "root-owned, 644, safe dirs: passes" "$OUT" "GUARD-PASSED"
g FAKE_UID=0 FAKE_UID_PATH="$(cd "$GD" && pwd -P)/install-linux.sh" FAKE_UID_FILE=1000
assert_not_contains "the FILE user-owned, the dirs root-owned: refused" "$OUT" "GUARD-PASSED"
chmod 664 "$GD/install-linux.sh"; g FAKE_UID=0
assert_not_contains "a group-writable script: refused" "$OUT" "GUARD-PASSED"
chmod 644 "$GD/install-linux.sh"
GD="$TMP/w/g2"; mk_guard "$GD"; chmod 777 "$TMP/w"; g FAKE_UID=0
assert_not_contains "a world-writable, non-sticky parent dir: refused" "$OUT" "GUARD-PASSED"
chmod 1777 "$TMP/w"; g FAKE_UID=0
assert_contains "a sticky world-writable parent (/tmp-like): passes" "$OUT" "GUARD-PASSED"
chmod 755 "$TMP/w"
GD="$TMP/g1"; g FAKE_UID=0 MARVEEN_RAW_BASE=https://example.invalid
assert_not_contains "MARVEEN_RAW_BASE: refused" "$OUT" "GUARD-PASSED"
g FAKE_UID=0 MARVEEN_REF='main;id'
assert_not_contains "a non-plain MARVEEN_REF: refused" "$OUT" "GUARD-PASSED"
printf 'echo LANG-SOURCED\n' > "$GD/install-lang.sh"; chmod 666 "$GD/install-lang.sh"; g FAKE_UID=0
assert_not_contains "a writable install-lang.sh next to it: refused" "$OUT" "GUARD-PASSED"
rm -f "$GD/install-lang.sh"
g FAKE_UID=1000 FAKE_ID=1000
assert_contains "not root: the guard does not apply" "$OUT" "GUARD-PASSED"

echo "7c. the admin branch takes the gate only from the official source, never the checkout"
ADMIN_BLOCK="$(awk '/--admin-prereq stops here/{on=1} on{print} /^# Repo bootstrap/{exit}' "$REPO/install-linux.sh")"
assert_contains "the gate comes from the official raw URL" "$ADMIN_BLOCK" '_raw="${MARVEEN_OFFICIAL_RAW}/${MARVEEN_REF}/scripts"'
GATE_REFS="$(printf '%s\n' "$ADMIN_BLOCK" | grep -v '^\s*#' | grep 'ensure-managed-channels-enabled.sh' | grep -v '\$_raw/ensure-managed-channels-enabled.sh' | grep -v 'GATE_SCRIPT="\$GATE_DIR/ensure-managed-channels-enabled.sh"')"
assert_eq "no other gate path in the admin branch" "" "$GATE_REFS"

echo "8. the admin branch exits before the repo bootstrap"
SRC="$(cat "$REPO/install-linux.sh")"
a="${SRC%%# Repo bootstrap*}"
assert_contains "the admin exit sits before the repo bootstrap" "$a" 'if [ "$ADMIN_PREREQ" = 1 ]; then'
assert_contains "and it exits 0" "$(awk '/--admin-prereq stops here/{on=1} on{print} /^# Repo bootstrap/{exit}' "$REPO/install-linux.sh")" "exit 0"

echo "9. every new text key resolves in both languages"
for lang in hu en; do
  OUT="$(MARVEEN_LANG=$lang /bin/bash -c ". '$REPO/install-lang.sh'; for k in adminprereq_need_root nonadmin_head nonadmin_pkgs nonadmin_node nonadmin_node_missing nonadmin_gate_ok nonadmin_gate_missing nonadmin_gate_unknown nonadmin_cmd_lead nonadmin_sudo_hint adminprereq_done_head adminprereq_pkgs_installed adminprereq_pkgs_present adminprereq_gate_ok adminprereq_gate_manual adminprereq_next_lead nonadmin_linger nonadmin_skips adminprereq_next_same adminprereq_user_needs_flag adminprereq_user_unknown adminprereq_linger_ok adminprereq_linger_na adminprereq_linger_fail adminprereq_linger_nouser; do _t linux.\$k; done")"
  assert_not_contains "$lang: no raw key" "$OUT" "linux."
done

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
