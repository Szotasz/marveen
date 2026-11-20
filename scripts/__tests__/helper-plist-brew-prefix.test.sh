#!/bin/bash
# The PATH the helper installers write, on a Homebrew in a custom prefix (ISSUE1968BREWPREFIX).
# Run: bash scripts/__tests__/helper-plist-brew-prefix.test.sh
#
# Bug being locked out: install-channel-coordinator.sh, install-channel-outage-alarm.sh,
# install-stuck-modal-guard.sh and install-{slack,telegram}-progress-hook.sh wrote a
# fixed PATH into their launchd plists, so on a custom prefix (tmux and claude in
# <prefix>/bin) the helper found neither. They now take the PATH from
# scripts/lib/helper-path.sh helper_launchd_path, which learns <prefix>/bin from the
# PATH's <prefix>/opt/node@NN/bin keg entry (the rule of #2578) as its second learned
# dir, after the dir tmux was found in.
#
# Contract, per installer:
#   - custom prefix: the plist PATH holds <prefix>/bin where helper_launchd_path puts
#     it (after ~/.local/bin for the stuck-modal guard, NATIVECLAUDEFIRST1011), and
#     every dir helper_launchd_path gives;
#   - default prefix (/opt/homebrew keg) and no tmux outside the fixed list: the
#     plist PATH is the old literal, byte for byte.
#
# Hermetic: a copied install root, a throwaway HOME per run, a PATH of symlinked
# system tools WITHOUT tmux, and uname / launchctl stubs; nothing is loaded.

set -u
# The dirs made here stand for a normal install dir: a group-writable one is refused as a learned
# PATH dir (PATHDIROWNER1120), so the run must not depend on the caller's umask.
umask 022

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# A copy of the install root, so nothing is written into the checkout; the coordinator
# needs its build artifact.
ROOT="$TMP/root"; mkdir -p "$ROOT/dist"
cp -R "$REPO/scripts" "$ROOT/scripts"
printf '// stub\n' > "$ROOT/dist/channel-coordinator.js"

# A PATH with the tools the installers use, and no tmux in it.
SYS="$TMP/sys"; mkdir -p "$SYS"
for t in bash sh dirname basename mkdir cat id grep sed cut tr head tail rm mv cp ls env awk find wc sort date chmod readlink python3; do
  p="$(PATH=/usr/bin:/bin command -v "$t" 2>/dev/null || true)"
  [ -n "$p" ] && ln -s "$p" "$SYS/$t"
done
printf '#!/bin/sh\necho Darwin\n' > "$SYS/uname"; chmod +x "$SYS/uname"
printf '#!/bin/sh\nexit 0\n' > "$SYS/launchctl"; chmod +x "$SYS/launchctl"
[ -e "$SYS/tmux" ] && fail "the tool dir must not hold tmux"

stub() { mkdir -p "$1"; printf '#!/bin/sh\nexit 0\n' > "$1/$2"; chmod +x "$1/$2"; }

# The custom prefix: node@22's keg (node lives there, as on a real install) and <prefix>/bin with tmux.
PFX="$TMP/opt/custombrew"
stub "$PFX/opt/node@22/bin" node
stub "$PFX/bin" tmux
KEG="$PFX/opt/node@22/bin"
# The default prefix case: node outside the fixed list, the keg entry of /opt/homebrew on PATH.
stub "$TMP/nodebin" node

# run_installer <installer> <home> <PATH> <provider> -- the PATH value written into the plist
run_installer() {
  printf 'SERVICE_ID=bpt\nCHANNEL_PROVIDER=%s\n' "$4" > "$TMP/.env"
  mkdir -p "$2/.claude/channels/telegram-coordinator"
  printf 'TELEGRAM_BOT_TOKEN=x\n' > "$2/.claude/channels/telegram-coordinator/.env"
  HOME="$2" PATH="$3" MARVEEN_ENV_FILE="$TMP/.env" /bin/bash "$ROOT/scripts/$1" >"$TMP/out" 2>&1 || { echo "RC-HIBA $(cat "$TMP/out")"; return; }
  n="$(find "$2/Library/LaunchAgents" -name '*.plist' 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" = 1 ] || { echo "PLIST-SZAM=$n"; return; }
  p="$(find "$2/Library/LaunchAgents" -name '*.plist' | head -1)"
  python3 -c "import plistlib,sys; print(plistlib.load(open(sys.argv[1],'rb'))['EnvironmentVariables']['PATH'])" "$p" 2>&1
}

# helper_path <home> <PATH> -- what helper_launchd_path gives in that environment
helper_path() { (HOME="$1" PATH="$2"; . "$ROOT/scripts/lib/helper-path.sh"; helper_launchd_path); }

# every_dir_in <needles> <haystack> -- yes when every dir of the first PATH value is in the second
every_dir_in() {
  _rest="$1:"
  while [ -n "$_rest" ]; do
    _d="${_rest%%:*}"; _rest="${_rest#*:}"
    case ":$2:" in *":$_d:"*) ;; *) echo "no ($_d)"; return ;; esac
  done
  echo yes
}

# expected <installer> <home> <helper path> -- the plist PATH the installer must write
expected() {
  case "$1" in
    install-channel-coordinator.sh) printf '%s' "$3" ;;
    install-channel-outage-alarm.sh|install-slack-progress-hook.sh|install-telegram-progress-hook.sh) printf '%s' "$3:/usr/sbin:/sbin" ;;
    install-stuck-modal-guard.sh)
      _l="${3%"$BASE"}"; _l="${_l#"$2/.local/bin:"}"
      printf '%s' "$2/.local/bin:${_l}/opt/homebrew/bin:$2/.bun/bin:/usr/local/bin:/usr/bin:/bin" ;;
  esac
}

# The literal each installer wrote before (the default-prefix result must stay this, byte for byte).
old_literal() {
  case "$1" in
    install-channel-coordinator.sh) printf '%s' "$BASE" ;;
    install-channel-outage-alarm.sh|install-slack-progress-hook.sh|install-telegram-progress-hook.sh) printf '%s' "$BASE:/usr/sbin:/sbin" ;;
    install-stuck-modal-guard.sh) printf '%s' "$2/.local/bin:/opt/homebrew/bin:$2/.bun/bin:/usr/local/bin:/usr/bin:/bin" ;;
  esac
}

provider_of() { case "$1" in install-slack-progress-hook.sh) echo slack ;; *) echo telegram ;; esac; }

for INST in install-channel-coordinator.sh install-channel-outage-alarm.sh install-stuck-modal-guard.sh \
            install-slack-progress-hook.sh install-telegram-progress-hook.sh; do
  echo "$INST"
  PROV="$(provider_of "$INST")"

  # B1: custom prefix, its keg on PATH, <prefix>/bin NOT on PATH (a launchd-started update); tmux only in <prefix>/bin
  H="$TMP/b1-$INST"; mkdir -p "$H"
  HP="$(helper_path "$H" "$KEG:$SYS")"
  assert_eq "B1 helper_launchd_path learns <prefix>/bin as the first dir" "$PFX/bin:$BASE" "$HP"
  GOT="$(run_installer "$INST" "$H" "$KEG:$SYS" "$PROV")"
  assert_eq "B1 the plist PATH carries <prefix>/bin in its place" "$(expected "$INST" "$H" "$HP")" "$GOT"
  assert_eq "B1 every dir helper_launchd_path gives is in the plist PATH" "yes" "$(every_dir_in "$HP" "$GOT")"

  # B2: tmux also in ~/.local/bin: that dir first, <prefix>/bin the SECOND learned dir
  H="$TMP/b2-$INST"; stub "$H/.local/bin" tmux
  HP="$(helper_path "$H" "$KEG:$SYS")"
  assert_eq "B2 helper_launchd_path: the tmux dir, then <prefix>/bin" "$H/.local/bin:$PFX/bin:$BASE" "$HP"
  GOT="$(run_installer "$INST" "$H" "$KEG:$SYS" "$PROV")"
  assert_eq "B2 the plist PATH carries both in their place" "$(expected "$INST" "$H" "$HP")" "$GOT"
  assert_eq "B2 every dir helper_launchd_path gives is in the plist PATH" "yes" "$(every_dir_in "$HP" "$GOT")"

  # B3 (INVARIANS): the default prefix (/opt/homebrew keg), no tmux outside the list -> the old literal
  H="$TMP/b3-$INST"; mkdir -p "$H"
  GOT="$(run_installer "$INST" "$H" "/opt/homebrew/opt/node@22/bin:$TMP/nodebin:$SYS" "$PROV")"
  assert_eq "B3 INVARIANS default prefix -> the old PATH, byte for byte" "$(old_literal "$INST" "$H")" "$GOT"

  # B4 (INVARIANS): a keg whose <prefix>/bin does not exist adds nothing
  H="$TMP/b4-$INST"; mkdir -p "$H"
  stub "$TMP/nobin/opt/node@22/bin" node
  GOT="$(run_installer "$INST" "$H" "$TMP/nobin/opt/node@22/bin:$SYS" "$PROV")"
  assert_eq "B4 INVARIANS a keg without <prefix>/bin -> the old PATH" "$(old_literal "$INST" "$H")" "$GOT"
done

echo ""
echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
