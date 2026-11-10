#!/bin/bash
# Marveen - AI Team Setup
# Interactive installer for macOS

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
ORANGE='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

# CLI flag parsing -- runs before the interactive wizard.
# WEB_PORT can also be set as an env var (env var wins if --port is not given).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|--web-port)
      if [[ -z "${2:-}" || "${2}" == --* ]]; then
        echo "Error: --port requires a numeric argument (e.g. --port 3421)" >&2; exit 1
      fi
      WEB_PORT="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--port <N>]"
      echo "  --port <N>   Dashboard port (default: 3420). Also settable via WEB_PORT env var."
      exit 0 ;;
    *) echo "Unknown option: $1 (use --help for usage)" >&2; exit 1 ;;
  esac
done
WEB_PORT="${WEB_PORT:-3420}"

INSTALL_STEP="init"

# shellcheck source=install-lang.sh
source "$(dirname "$0")/install-lang.sh"

# #1874: the managed-settings.json writes below are machine-wide (org-policy layer)
# and need root. Say what is written and why, ONCE, before the first of them asks
# for a password. The text lives in install-lang.sh; the function stays here, so a
# standalone run that fetched an older install-lang.sh still has it (an unknown
# _t key just prints nothing).
managed_settings_notice() {
  if [ -n "${MANAGED_NOTICE_SHOWN:-}" ]; then
    return 0
  fi
  MANAGED_NOTICE_SHOWN=1
  echo -e "  ${ORANGE}i${NC} $(_t managed.notice_what)"
  echo -e "    $(_t managed.notice_sudo)"
}

# MACROOTFROMCLONE1106: the installer's root steps run no code from the clone. The clone is the user's, so
# anything running as that user (an agent) can rewrite it; a root step that ran a clone file would run the
# agent's code as root on the next install. So:
#   - the managed-settings writer is EMBEDDED below, byte for byte the same as
#     scripts/lib/managed-settings-write.py (a test holds the two equal), and runs as
#     /usr/bin/sudo /usr/bin/python3 -I -S - : no cwd import, no site-packages, no PATH lookup;
#   - every root call names its program by absolute path (a PATH entry like ~/.bun/bin is the user's);
#   - right after the last root step the sudo login is dropped and the password the Bridge passed in is
#     unset, BEFORE any clone code (npm, the build, the sourced helpers) runs.
# The boundary: the installer itself runs no clone code as root and leaves the password out of clone code's
# reach. It does not protect the user's login environment (profile, PATH, HOME): against an agent running as
# the same user only a separate admin account separates. The macOS sudoers secure_path: not measured.
managed_write() { # $1 = the managed file, then the writer's flags; the writer's own exit code
  /usr/bin/sudo /usr/bin/python3 -I -S - "$@" <<'MSW_PY'
#!/usr/bin/env python3
"""The ONE safe writer of Claude Code's machine-wide managed-settings.json (MANAGEDSETTINGSWRITE1103).

Every installer path that touches the org-policy file calls this, instead of its own inline
merge. The inline copies had two faults:

1. scripts/ensure-managed-channels-enabled.sh turned an unreadable or non-object file into {}
   and wrote it back, as root. That silently dropped every other managed key, including the
   allowedChannelPlugins list, and so muted every channel host-wide.
2. All of them wrote a FIXED tmp name (`<file>.tmp`) with a plain open(), which follows a
   symlink, then copymode/chmod on that path (also following it), then os.replace. Whoever can
   write the directory can make a root process write and chmod a file of its choosing.
   (The same class was fixed in the Bridge's gromzo-root.sh on review of Bridge #99.)

The rules here:
- an existing file that is not valid JSON or not a JSON object: NOT written, exit 1;
- the file, if it exists, must be a regular file (not a symlink) owned by the effective user;
- the directory must be owned by the effective user and not group- or other-writable;
- changes are additive only: plugins are appended once, channelsEnabled is set true; every
  other key and entry stays; an unchanged file is not rewritten;
- the write: a fresh mkstemp file in the same directory (O_EXCL, unpredictable name), mode and
  owner set on the fd (an existing file keeps its mode, a new one gets 0644 so the
  unprivileged session can read the policy), written through the fd, then os.replace; the
  tmp is removed on any error.

The ownership checks use the EFFECTIVE uid: root when the installer runs this with sudo, the
test user in the tests, so the same code is measured in both.

Usage: managed-settings-write.py <file> [--create] [--channels-enabled] [--add-plugin NAME@MARKET]...
  --create  write the file if it does not exist (otherwise a missing file is left alone, exit 0)
Exit: 0 written or nothing to do; 1 refused (the reason on stderr), nothing changed.
"""
import json
import os
import stat
import sys
import tempfile


def refuse(msg):
    print("managed-settings NOT written: %s" % msg, file=sys.stderr)
    sys.exit(1)


def parse_args(argv):
    if not argv or argv[0].startswith("-"):
        refuse("usage: managed-settings-write.py <file> [--create] [--channels-enabled] [--add-plugin NAME@MARKET]...")
    path, create, enable, plugins = argv[0], False, False, []
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--create":
            create = True
        elif a == "--channels-enabled":
            enable = True
        elif a == "--add-plugin" and i + 1 < len(argv):
            name, sep, market = argv[i + 1].partition("@")
            if not sep or not name or not market:
                refuse("bad --add-plugin value: %r (want NAME@MARKETPLACE)" % argv[i + 1])
            plugins.append({"plugin": name, "marketplace": market})
            i += 1
        else:
            refuse("unknown argument: %r" % a)
        i += 1
    return path, create, enable, plugins


def check_dir(d, euid):
    try:
        st = os.lstat(d)
    except OSError as e:
        refuse("the directory %s cannot be read: %s" % (d, e.strerror))
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        refuse("%s is not a plain directory" % d)
    if st.st_uid != euid:
        refuse("the directory %s is not owned by uid %d" % (d, euid))
    if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        refuse("the directory %s is group- or other-writable" % d)


def main(argv):
    path, create, enable, plugins = parse_args(argv)
    euid = os.geteuid()
    d = os.path.dirname(os.path.abspath(path))
    check_dir(d, euid)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        st = None
    if st is None:
        if not create:
            print("managed-settings: %s does not exist, nothing to merge" % path)
            return 0
        data, mode = {}, 0o644
    else:
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            refuse("%s is not a regular file" % path)
        if st.st_uid != euid:
            refuse("%s is not owned by uid %d" % (path, euid))
        try:
            with open(path, "rb") as f:
                data = json.loads(f.read().decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            refuse("%s is not valid JSON (%s); an org-policy file is never rebuilt from scratch" % (path, type(e).__name__))
        if not isinstance(data, dict):
            refuse("%s is not a JSON object" % path)
        mode = stat.S_IMODE(st.st_mode)
    before = json.dumps(data, sort_keys=True)
    if plugins:
        have = data.get("allowedChannelPlugins")
        if have is None:
            have = []
        if not isinstance(have, list):
            refuse("allowedChannelPlugins in %s is not a list" % path)
        for p in plugins:
            if not any(isinstance(e, dict) and e.get("plugin") == p["plugin"]
                       and e.get("marketplace") == p["marketplace"] for e in have):
                have.append(p)
        data["allowedChannelPlugins"] = have
    if enable:
        data["channelsEnabled"] = True
    if json.dumps(data, sort_keys=True) == before and st is not None:
        print("managed-settings: %s already has everything, not rewritten" % path)
        return 0
    fd, tmp = tempfile.mkstemp(prefix=".managed-settings.", suffix=".tmp", dir=d)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, euid, os.getegid() if euid != 0 else 0)
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(data, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    print("managed-settings: %s written" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
MSW_PY
}
# Read as the user, nothing written: 0 when the file already has every wanted entry (NAME@MARKETPLACE, or
# --channels for channelsEnabled), so an already-correct host asks for no password (the gate's old rule).
# A wrong answer only means a needless or skipped write, never code run as root.
managed_has() {
  /usr/bin/python3 -I -S - "$@" 2>/dev/null <<'MSH_PY'
import json, sys
path, want = sys.argv[1], sys.argv[2:]
try:
    d = json.load(open(path))
except Exception:
    sys.exit(1)
if not isinstance(d, dict):
    sys.exit(1)
have = set()
for p in d.get("allowedChannelPlugins") or []:
    if isinstance(p, dict):
        have.add("%s@%s" % (p.get("plugin"), p.get("marketplace")))
for w in want:
    if w == "--channels":
        if d.get("channelsEnabled") is not True:
            sys.exit(1)
    elif w not in have:
        sys.exit(1)
sys.exit(0)
MSH_PY
}
# 0 = a root-owned regular file, not group/other-writable, with every parent dir root-owned and not
# group/other-writable unless sticky (/tmp). The macOS twin of install-linux.sh root_only_path (BSD stat).
macos_root_only_path() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  macos_root_only_chain "$1"
}
# 0 = a mode (the last four octal digits of stat %p) that only the owner can write: no group or other write
# bit, unless the sticky bit is set (/tmp). Anything but four octal digits is refused. A function of its own so
# the rule is tested on mode strings: a root-owned, admin-group-writable dir (0775) is writable by the admin
# installing user and so by every agent of theirs, and no test host has one to stat.
macos_mode_root_only() {
  case "$1" in [0-7][0-7][0-7][0-7]) ;; *) return 1 ;; esac
  [ $(( 8#$1 & 8#022 )) -eq 0 ] || [ $(( 8#$1 & 8#1000 )) -ne 0 ]
}
# The same rule for a path and every dir above it, without the regular-file test (a dir chain).
macos_root_only_chain() {
  local p="$1" m
  while :; do
    [ "$(/usr/bin/stat -f '%u' "$p" 2>/dev/null)" = 0 ] || return 1
    m="$(/usr/bin/stat -f '%p' "$p" 2>/dev/null)" || return 1
    m="${m: -4}"
    macos_mode_root_only "$m" || return 1
    [ "$p" = / ] && break
    p="$(dirname "$p")"
  done
  return 0
}
# The global npm install as root (NPMPERM1's sudo route): only from root-owned node and npm, under a clean
# environment (no user PATH for npm's `env node`, no user HOME/.npmrc). Otherwise refused, with the manual step.
root_npm_install_global() { # $1 = the package
  local npm node npm_real node_real
  npm="$(command -v npm 2>/dev/null)" || npm=""
  node="$(command -v node 2>/dev/null)" || node=""
  [ -n "$npm" ] && [ -n "$node" ] || return 1
  npm_real="$(/usr/bin/python3 -I -S -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$npm")" || return 1
  node_real="$(/usr/bin/python3 -I -S -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$node")" || return 1
  macos_root_only_path "$npm_real" && macos_root_only_path "$node_real" || return 1
  # the names on PATH (often links) sit in a root-only dir chain, so nobody swaps them after this check
  macos_root_only_chain "$(dirname "$npm")" && macos_root_only_chain "$(dirname "$node")" || return 1
  /usr/bin/sudo /usr/bin/env -i PATH="$(dirname "$node_real"):/usr/bin:/bin:/usr/sbin:/sbin" HOME=/var/root \
    "$node_real" "$npm_real" install -g "$1"
}

# Error-translation layer (NPMPERM1 kor): minden stderr egy log-fajlba is
# megy, hogy hibanal a trap ne csak sorszamot mondjon, hanem le tudja
# forditani az upstream hibat (explain_install_error, install-lang.sh).
INSTALL_ERRLOG=$(mktemp "${TMPDIR:-/tmp}/marveen-install-stderr.XXXXXX")
# INSTSTDERRTMP1104: the copy holds whatever a failing tool printed (a token in a
# URL, a password a broken prompt echoed back), and it outlived every run in the
# customer's TMPDIR. Only explain_install_error reads it, on the way out (fail()
# and on_error() call it before exit), so it leaves with the process: removed on
# EXIT, which bash runs after those calls on every exit path, and turned into an
# exit by INT/TERM so an interrupted run cleans up too.
cleanup_install_errlog() {
  [ -n "${INSTALL_ERRLOG:-}" ] || return 0
  rm -f "$INSTALL_ERRLOG"
  # The tee behind `exec 2>` starts asynchronously; a run that exits within its
  # first milliseconds can unlink the file before tee opened it, and `tee -a`
  # then creates it again (measured in the test). Close our end of the pipe so
  # tee sees EOF, give it a moment, and remove a re-created file once more.
  exec 2>&-
  local i=0
  while [ "$i" -lt 10 ]; do
    [ -e "$INSTALL_ERRLOG" ] && rm -f "$INSTALL_ERRLOG"
    sleep 0.05 2>/dev/null || break
    i=$((i + 1))
  done
  return 0
}
trap cleanup_install_errlog EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
exec 2> >(tee -a "$INSTALL_ERRLOG" >&2)

ok() { echo -e "  ${GREEN}✓${NC} $*"; }

# Does the INSTALL carry an auth credential the SERVICES can read?
# NOT the same question as `claude auth status` / a Keychain login: the launchd
# units read ONLY <install>/.env and <install>/store/.claude-oauth-token. On
# macOS `claude auth login` fills the KEYCHAIN and nothing else, so before this
# change the services were never given a credential at all -- the operator's
# terminal worked and the agents sat at "Not logged in".
service_auth_present() {
  grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' "$INSTALL_DIR/.env" 2>/dev/null && return 0
  [ -s "$INSTALL_DIR/store/.claude-oauth-token" ] && return 0
  return 1
}
warn() { echo -e "  ${ORANGE}!${NC} $*"; }

offer_claude_fallback() {
  local step="$1" err_msg="$2" line_info="${3:+:$3}"
  if ! command -v claude &>/dev/null; then
    return
  fi
  echo ""
  echo -e "${ORANGE}$(_t macos.claude_available)${NC}"
  local prompt="Marveen installer failed at step \"${step}\". Error: ${err_msg}. Script: install.sh${line_info}. Repo: https://github.com/Szotasz/marveen. OS: macOS $(sw_vers -productVersion 2>/dev/null || echo unknown). Node: $(node -v 2>/dev/null || echo missing). Dir: ${INSTALL_DIR}. Your task: diagnose this Marveen installer failure. The install scripts are install.sh (macOS) and install-linux.sh. Read the relevant section, check for missing dependencies or permission issues, and suggest concrete shell commands to fix."
  if [ -t 0 ]; then
    read -rp "$(_t prompt_open_claude)" OPEN_CLAUDE
    OPEN_CLAUDE=${OPEN_CLAUDE:-n}
    if [[ "$OPEN_CLAUDE" == "i" || "$OPEN_CLAUDE" == "y" ]]; then
      # `claude` takes the initial prompt as a POSITIONAL argument. The old
      # `--prompt` flag no longer exists (unknown option '--prompt'), so the
      # offer died at the exact moment the operator asked for help.
      claude "$prompt"
      return
    fi
  fi
  echo -e "  ${DIM}$(_t macos.fallback_manual)${NC}"
  echo -e "  ${DIM}claude \"$(echo "$prompt" | sed 's/"/\\"/g')\"${NC}"
}

fail() {
  echo -e "  ${RED}✗${NC} $*"
  explain_install_error "${INSTALL_ERRLOG:-}"
  offer_claude_fallback "$INSTALL_STEP" "$*" "${BASH_LINENO[0]}"
  exit 1
}

on_error() {
  echo ""
  echo -e "${RED}Varatlan hiba a(z) '${INSTALL_STEP}' lepesben (sor: $1).${NC}"
  explain_install_error "${INSTALL_ERRLOG:-}"
  offer_claude_fallback "$INSTALL_STEP" "Unexpected error at line $1" "$1"
  exit 1
}
trap 'on_error $LINENO' ERR

clear
echo ""
echo -e "${BOLD}  ▐▛███▜▌   Marveen${NC}"
if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
  echo -e "${BOLD} ▝▜█████▛▘  Your AI team, running while you sleep.${NC}"
else
  echo -e "${BOLD} ▝▜█████▛▘  $(_t tagline)${NC}"
fi
echo -e "${DIM}   ▘▘ ▝▝${NC}"
echo ""
if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
  echo -e "${DIM}  Setup wizard - macOS${NC}"
else
  echo -e "${DIM}$(_t macos.wizard_title)${NC}"
fi
echo ""

# Step 1: Check prerequisites
INSTALL_STEP="prerequisites"
echo -e "${BOLD}$(_t section_1)${NC}"

# ── macOS verzio pre-flight (MACOSOLD1) ──────────────────────────────
# A fuggosegeket a Homebrew-ra bizzuk, a brew-nak viszont sajat macOS-
# minimumai vannak. Regi gepen a brew portable-ruby-ja dyld-hibaval hal
# (____chkstk_darwin, "your system version is too old"), es a felhasznalo
# egy Ruby-linker hibat lat egy sorszammal (2026-07-30, eles workshop).
# Itt, a legelso lepesben derul ki, ERTHETO mondattal es KIUTTAL.
#
# A kuszobok a Homebrew SAJAT deklaralt minimumai (brew.sh, Homebrew
# 6.0.13, kiolvasva 2026-07-30):
#   HOMEBREW_MACOS_OLDEST_ALLOWED="10.15"  -- ez alatt a brew el sem indul
#   HOMEBREW_MACOS_OLDEST_SUPPORTED="14"   -- ez alatt "unsupported/best effort"
# Uj brew-kiadasnal ezek valtozhatnak; a forras a brew repo brew.sh fajlja.
BREW_OLDEST_ALLOWED="10.15"
BREW_OLDEST_SUPPORTED="14"

# major[.minor] numerikus osszehasonlitas: 0 ha $1 < $2 (sort -V nelkul,
# a BSD sort -V viselkedesere nem epitunk).
macos_version_lt() {
  local a1 b1 a2 b2
  a1=${1%%.*}; b1=${2%%.*}
  a2=${1#*.}; [ "$a2" = "$1" ] && a2=0; a2=${a2%%.*}
  b2=${2#*.}; [ "$b2" = "$2" ] && b2=0; b2=${b2%%.*}
  [ "$a1" -lt "$b1" ] || { [ "$a1" -eq "$b1" ] && [ "$a2" -lt "$b2" ]; }
}

MACOS_VER=$(sw_vers -productVersion 2>/dev/null || echo "")
if [ -z "$MACOS_VER" ]; then
  # Ismeretlen allapot: kimondjuk, nem talalgatunk -- a telepites megy
  # tovabb, es ha a brew bukik, a hibauzenete legalabb valodi lesz.
  echo -e "  ${DIM}$(_t macos.ver_unknown)${NC}"
elif macos_version_lt "$MACOS_VER" "$BREW_OLDEST_ALLOWED"; then
  # VEGLEGES akadaly ezen a gepen: a Homebrew el sem indul ilyen regi
  # macOS-en -- azonnal, ertheto mondattal allunk meg, kiuttal.
  echo -e "${RED}$(_t macos.ver_too_old_head) ${MACOS_VER}${NC}"
  echo -e "  $(_t macos.ver_too_old_body1)"
  echo -e "  $(_t macos.ver_too_old_body2)"
  fail "$(_t macos.ver_too_old_fail)"
elif macos_version_lt "$MACOS_VER" "$BREW_OLDEST_SUPPORTED"; then
  # Szurke sav: a brew "unsupported / best effort" -- tipikusan mukodik,
  # de torhet. Nem hazudunk sem sikert, sem bukast: figyelmeztetunk, es a
  # felhasznalo dont.
  warn "$(_t macos.ver_unsupported_head) ${MACOS_VER}"
  echo -e "  $(_t macos.ver_unsupported_body)"
  read -rp "$(_t macos.ver_unsupported_prompt)" CONT_OLD_MACOS
  CONT_OLD_MACOS=${CONT_OLD_MACOS:-i}
  # hu prompt: i/n, en prompt: y/n -- mindket igen-alak elfogadva.
  case "$CONT_OLD_MACOS" in
    i|I|y|Y) : ;;
    *) fail "$(_t macos.ver_unsupported_abort)" ;;
  esac
fi

check_cmd() {
  if command -v "$1" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $2"
    return 0
  else
    echo -e "  ${RED}✗${NC} $2 $(_t macos.missing)"
    return 1
  fi
}

# INSTPWURES825: egy tavoli, NEM interaktiv SSH-session nem tolti be a
# shell-profilt, ezert az Apple Siliconos Homebrew (es minden, amit o
# telepitett: node, tmux, git) NINCS a PATH-on. A lenti ellenorzesek brew
# nelkul hamisan hianyt jeleznenek, a telepito ag pedig ujra telepitene a
# mar meglevo Homebrew-t. Ezert a meres ELOTT betoltjuk a brew kornyezetet,
# ha a binaris letezik -- ugyanaz a ket sor, amit a telepito ag a sajat
# telepitese utan mar hasznal.
if ! command -v brew &>/dev/null; then
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

MISSING=0
check_cmd "node" "Node.js (v20+)" || MISSING=1
check_cmd "npm" "npm" || MISSING=1
check_cmd "tmux" "tmux" || MISSING=1
check_cmd "git" "git" || MISSING=1

# Check Node version
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 20 ]; then
    echo -e "  ${RED}✗${NC} Node.js verzio: $(node -v) (minimum: v20)"
    MISSING=1
  fi
fi

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo -e "${ORANGE}$(_t macos.install_missing_deps)${NC}"
  if ! command -v brew &>/dev/null; then
    echo -e "${ORANGE}$(_t macos.installing_homebrew)${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Homebrew on Apple Silicon installs to /opt/homebrew; add it to PATH now
    # so subsequent `brew` calls in this script succeed without a shell restart.
    if [ -x /opt/homebrew/bin/brew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew ]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
    if ! command -v brew &>/dev/null; then
      fail "Homebrew telepitese sikertelen. Telepitsd manualisan (https://brew.sh) es futtasd ujra az installert."
    fi
  fi
  command -v node &>/dev/null || brew install node@22
  command -v tmux &>/dev/null || brew install tmux
  command -v git &>/dev/null || brew install git
  echo -e "${GREEN}$(_t macos.deps_installed)${NC}"
fi

# Bun: no longer here. GROMZONOPROVIDER1108: installed after the channel choice ("bun-install" below), only for a
# channel whose plugin runs on Bun (telegram, discord).
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
# BUNTIMEOUT1108 (ported, GROMZONOPROVIDER1108): the Linux installer's Bun path, here too. It was a bare
# `curl | bash 2>/dev/null` under set -e: no time limit, no retry, no npm fallback, the reason thrown away.
# macOS has no `timeout`: _mac_timeout uses one when installed (coreutils), else the system perl runs the command in
# its OWN process group and, past the limit, signals the whole group (TERM, then KILL after 10 s), so the vendor
# script's own download is cut too; exit 124 on the limit, like timeout(1).
_mac_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout --kill-after=10 "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout --kill-after=10 "$secs" "$@"; return $?; fi
  /usr/bin/perl -e 'my $t = shift; my $pid = fork; die "fork: $!" unless defined $pid;
    if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 }
    local $SIG{ALRM} = sub { kill "TERM", -$pid; sleep 10; kill "KILL", -$pid; waitpid($pid, 0); exit 124 };
    alarm $t; waitpid($pid, 0); alarm 0;
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$secs" "$@"
}
_run_remote_installer() {
  local label="$1" url="$2" check="$3"
  shift 3
  local tries="${REMOTE_INSTALL_TRIES:-3}" n=1 rc dir script log
  # No fixed /tmp fallback name: the installer runs as root, and a predictable path that it fills and then runs could
  # be replaced by another local user (Dani 73434). Without a private temp dir the step stops.
  if ! dir="$(mktemp -d 2>/dev/null)" || [ -z "$dir" ]; then
    warn "$label: nem tudtam privat ideiglenes konyvtarat letrehozni (mktemp -d)."
    return 1
  fi
  script="$dir/install.sh"
  log="$dir/install.log"
  while [ "$n" -le "$tries" ]; do
    : > "$log"
    rc=0
    if curl -fsSL --connect-timeout "${REMOTE_INSTALL_CONNECT_TIMEOUT:-20}" --max-time "${REMOTE_INSTALL_FETCH_TIMEOUT:-60}" \
         -o "$script" "$url" 2>>"$log"; then
      if _mac_timeout "${REMOTE_INSTALL_TIMEOUT:-300}" bash "$script" "$@" </dev/null >>"$log" 2>&1; then
        rc=0
      else
        rc=$?
      fi
    else
      rc=$?
      echo "(the installer script could not be downloaded from $url, curl exit $rc)" >>"$log"
    fi
    hash -r
    if "$check"; then
      rm -rf "$dir"
      return 0
    fi
    if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
      warn "$label: a(z) $n/$tries. probalkozas tullepte az idokorlatot (${REMOTE_INSTALL_TIMEOUT:-300} mp)."
    else
      warn "$label: a(z) $n/$tries. probalkozas sikertelen (kilepesi kod: $rc)."
    fi
    n=$((n + 1))
    if [ "$n" -le "$tries" ]; then sleep "${REMOTE_INSTALL_RETRY_DELAY:-5}"; fi
  done
  echo -e "  ${DIM}$label telepito utolso sorai:${NC}"
  tail -n 15 "$log" 2>/dev/null | sed 's/^/    /'
  rm -rf "$dir"
  return 1
}

_install_bun_from_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    warn "Bun (npm tartalek): az npm nem elerheto."
    return 1
  fi
  ensure_global_npm_writable auto || true
  local log rc=0 npm_prefix npm_bun real
  if ! log="$(mktemp 2>/dev/null)" || [ -z "$log" ]; then
    warn "Bun (npm tartalek): nem tudtam privat ideiglenes fajlt letrehozni (mktemp)."
    return 1
  fi
  if [ "${NPM_NEEDS_SUDO:-}" = "1" ]; then
    # Dani 73629: as root ONLY through root_npm_install_global (root-owned node and npm, a root-only dir chain, env -i,
    # HOME=/var/root), never a plain `sudo npm`, which resolves npm and its config from the user's side. No time limit,
    # as in the Claude step: a password-asking sudo needs the terminal, which a process group under _mac_timeout lacks.
    if ! root_npm_install_global "bun@${BUN_PIN}" >"$log" 2>&1; then
      rc=1
      echo -e "  ${RED}✗${NC} $(_t macos.root_npm_bun_failed)"
      echo "    sudo npm install -g bun@${BUN_PIN}"
    fi
    # the sudo login ends here, as after the Claude step
    command /usr/bin/sudo -K 2>/dev/null || true
  else
    _mac_timeout "${REMOTE_INSTALL_TIMEOUT:-300}" npm install -g "bun@${BUN_PIN}" </dev/null >"$log" 2>&1 || rc=$?
  fi
  hash -r
  # The bun this npm install put in, by npm's own prefix: `command -v bun` could name an older bun earlier on PATH
  # (Dani 73434).
  # An empty prefix would make this "/bin/bun" (Dani 73504, the TMPPROBE1108 Linux fix, ported): no prefix, no link.
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  npm_bun="${npm_prefix:+$npm_prefix/bin/bun}"
  if [ "$rc" = 0 ] && [ -n "$npm_bun" ] && [ -x "$npm_bun" ] && "$npm_bun" --version >/dev/null 2>&1; then
    real="$(readlink -f "$npm_bun" 2>/dev/null || echo "$npm_bun")"
    mkdir -p "$BUN_INSTALL/bin"
    ln -sf "$real" "$BUN_INSTALL/bin/bun"
    ln -sf bun "$BUN_INSTALL/bin/bunx"
    rm -f "$log"
    return 0
  fi
  warn "Bun (npm tartalek): sikertelen (kilepesi kod: $rc)."
  echo -e "  ${DIM}Bun (npm tartalek) utolso sorai:${NC}"
  tail -n 15 "$log" 2>/dev/null | sed 's/^/    /'
  rm -f "$log"
  return 1
}

_install_bun() {
  if _run_remote_installer "Bun (GitHub-letoltes)" https://bun.sh/install _bun_present; then
    ok "bun telepitve: $("$BUN_INSTALL/bin/bun" --version 2>/dev/null)"
    return 0
  fi
  warn "A Bun GitHub-letoltese nem sikerult; tartalek: npm install -g bun@${BUN_PIN} (registry.npmjs.org)."
  if _install_bun_from_npm && _bun_present; then
    ok "bun telepitve (npm tartalek): $("$BUN_INSTALL/bin/bun" --version 2>/dev/null)"
    return 0
  fi
  fail "A Bun telepitese nem sikerult: a GitHub-letoltes (bun.sh/install) es az npm-tartalek (bun@${BUN_PIN}) is bukott, az okot a fenti sorok mutatjak. Ellenorizd, hogy a gep eleri-e a github.com-ot vagy a registry.npmjs.org-ot, majd inditsd ujra a telepitest."
}
_bun_present() { [ -x "$BUN_INSTALL/bin/bun" ] && "$BUN_INSTALL/bin/bun" --version >/dev/null 2>&1; }
BUN_PIN="1.4.4"

# Check Claude Code CLI
echo ""
if ! command -v claude &>/dev/null; then
  echo -e "  ${RED}✗${NC} $(_t macos.claude_missing)"
  echo -e "${ORANGE}$(_t macos.install_claude_hint)${NC}"
  read -rp "$(_t prompt_install_claude)" INSTALL_CLAUDE
  if [[ "$INSTALL_CLAUDE" == "i" || "$INSTALL_CLAUDE" == "y" ]]; then
    # NPMPERM1: hivatalos nodejs.org .pkg-s (vagy Intel) gepen a globalis
    # node_modules root-tulajdonu -- EACCES-szel halna. Pre-flight + kiut.
    if ! ensure_global_npm_writable; then
      fail "$(_t npm.aborted)"
    fi
    if [ "${NPM_NEEDS_SUDO:-}" = "1" ]; then
      if ! root_npm_install_global @anthropic-ai/claude-code; then
        echo -e "  ${RED}✗${NC} $(_t macos.root_npm_refused)"
        echo "    sudo npm install -g @anthropic-ai/claude-code"
        fail "$(_t npm.aborted)"
      fi
      # the sudo login ends here: the user-level steps below run no root step until the managed block
      command /usr/bin/sudo -K 2>/dev/null || true
    else
      npm install -g @anthropic-ai/claude-code
    fi
  else
    # A javasolt parancs KULON, masolhato sorban -- egy workshop-resztvevo
    # kezzel gepelte at es egyetlen karakteren (@ = AltGr) elbukott.
    echo -e "  ${DIM}Telepitsd (masold ki az alabbi sort):${NC}"
    echo "    npm install -g @anthropic-ai/claude-code"
    fail "Claude Code CLI szukseges a futtatashoz."
  fi
fi
echo -e "  ${GREEN}✓${NC} Claude Code CLI"

INSTALL_STEP="claude-setup"
# Step 2: Claude Code first-run flags (BEFORE auth login)
#
# Reason: ha a `claude auth login` browser-flow megakad (timeout, Ctrl+C,
# vagy a felhasznalo nem klikkel a "Trust this browser?"-ben), a `set -e`
# alatt a script kilep es a flag-set NEM fut le -- onnantol a tmux-spawned
# headless session orokre parkol a "Trust this folder" / theme-picker /
# Bypass Permissions promptokon. Tehat a flag-set FOLY-RA `auth login`
# ELOTT, hogy ezek a defensive default-ok mindenkeppen a helyukre keruljenek.
mkdir -p "$HOME/.claude"
/usr/bin/python3 -I -S - <<'PYEOF'
import json, os, pathlib
p = pathlib.Path(os.path.expanduser("~/.claude.json"))
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text())
    except Exception:
        data = {}
data["hasCompletedOnboarding"] = True
if not data.get("theme"):
    data["theme"] = "dark"
p.write_text(json.dumps(data, indent=2))
try:
    os.chmod(p, 0o600)
except Exception:
    pass
PYEOF
/usr/bin/python3 -I -S - <<'PYEOF'
import json, os, pathlib
p = pathlib.Path(os.path.expanduser("~/.claude/settings.json"))
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text())
    except Exception:
        data = {}
data["skipDangerousModePermissionPrompt"] = True
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(data, indent=2))
try:
    os.chmod(p, 0o600)
except Exception:
    pass
PYEOF
echo -e "  ${GREEN}✓${NC} Claude Code first-run flags pre-set"

INSTALL_STEP="claude-auth"
# Step 2b: Claude authentication (kept tolerant -- ha megakad, folytatjuk)
echo ""
echo -e "${BOLD}$(_t section_2_macos)${NC}"
echo -e "${DIM}$(_t macos.auth_hint_1)${NC}"
echo -e "${DIM}$(_t macos.auth_hint_2)${NC}"
echo -e "${DIM}$(_t macos.auth_hint_3)${NC}"
read -rp "$(_t prompt_login)" DO_AUTH
if [[ "$DO_AUTH" == "i" || "$DO_AUTH" == "y" ]]; then
  # `&& ... || ...` rather than a `set +e` window: a `trap ... ERR` fires
  # regardless of the errexit setting, and on_error() above EXITS, so a window
  # never protected the branch below -- only keeping the command out of the
  # trap's reach does. Only the FINAL command of an && / || list is subject to
  # errexit and the ERR trap, so this captures the status instead of aborting.
  claude auth login && AUTH_RC=0 || AUTH_RC=$?
  if [ "$AUTH_RC" -ne 0 ]; then
    echo -e "  ${ORANGE}⚠${NC} Auth login nem fejezodott be sikeresen (exit $AUTH_RC)."
    echo -e "  ${DIM}$(_t macos.auth_later)${NC}"
  fi
fi
echo -e "  ${GREEN}✓${NC} $(_t macos.firstrun_done)"

# Service-side credential. `claude auth login` above authenticates the OPERATOR
# (Keychain); the launchd units cannot use that. They read .env and
# store/.claude-oauth-token, so ask for a setup-token unless this install
# already carries one (re-run, or the dashboard wizard got there first).
MACOS_OAUTH_TOKEN_INPUT=""
if service_auth_present; then
  ok "A telepites mar hordoz auth kulcsot (.env / store/.claude-oauth-token)"
else
  echo ""
  echo -e "  ${BOLD}Az ugynokok kulon hitelesitot igenyelnek.${NC}"
  echo -e "  ${DIM}A fenti bejelentkezes a Te termnaljadnak szol (Keychain);${NC}"
  echo -e "  ${DIM}a hatterszolgaltatasok ahhoz nem ferenek hozza.${NC}"
  echo -e "  ${BOLD}1.${NC} Futtasd egy terminalban: ${BLUE}claude setup-token${NC}"
  echo -e "  ${BOLD}2.${NC} Masold ide a kiirt tokent (Enter = kihagyas):"
  read -rp "  OAuth token: " MACOS_OAUTH_TOKEN_INPUT
  if [ -n "$MACOS_OAUTH_TOKEN_INPUT" ]; then
    if printf '%s' "$MACOS_OAUTH_TOKEN_INPUT" | grep -Eq '^sk-ant-oat01-[A-Za-z0-9_-]{40,}$'; then
      ok "Token formailag rendben, elmentjuk a szolgaltatasoknak"
    else
      warn "A beirt ertek nem setup-token alaku (sk-ant-oat01-...). Elmentjuk, de ellenorizd."
    fi
  else
    warn "Token nem lett megadva -- az ugynokok igy nem fognak elindulni."
  fi
fi

# Pre-flight headless probe (Issue #179, scope corrected by #1872).
# `claude auth login` may exit 0 even when the resulting token is unusable for
# headless queries (browser flow interrupted, stale cached state, etc.). This
# probe runs with the OPERATOR's environment and Keychain only, so it checks the
# login of the terminal the user is sitting at (what the pairing step's
# `claude` uses) -- NOT the agents' credential. The launchd units read .env and
# store/.claude-oauth-token, the token entered above is not even saved yet, and
# the fail-closed service-auth gate further down probes exactly that path. So a
# failure here must not predict that agent creation will fail: it did, falsely,
# on every token-based install over SSH (#1872).
echo ""
echo -e "  ${DIM}$(_t macos.headless_test)${NC}"
# The exit status here used to be `head`'s, not claude's: `VAR=$(cmd | head)`
# reports the LAST pipeline element, so a failing claude looked like success.
# PIPESTATUS does NOT help either -- after an assignment it describes the
# assignment, not the pipeline inside the substitution (measured). Dropping the
# pipe entirely is the only form that reports claude's own status.
# The `&& ... || ...` guard replaces the `set +e` window that used to wrap this:
# the ERR trap fires regardless of errexit and on_error() exits, so the window
# was decorative -- a failing probe still killed the installer here.
CLAUDE_PROBE_OUT=$(claude --print "ping" 2>&1) && CLAUDE_PROBE_EXIT=0 || CLAUDE_PROBE_EXIT=$?
CLAUDE_PROBE_OUT=${CLAUDE_PROBE_OUT:0:200}
if [ "$CLAUDE_PROBE_EXIT" -eq 0 ] && [ -n "$CLAUDE_PROBE_OUT" ]; then
  echo -e "  ${GREEN}✓${NC} $(_t macos.headless_ok)"
else
  warn "$(_t macos.headless_fail)"
  echo -e "    ${DIM}Kimenet: ${CLAUDE_PROBE_OUT:-<ures>}${NC}"
  echo -e "    ${DIM}Tipikus okok: ebben a terminálban nincs Claude-bejelentkezés (pl. SSH-n át), hálózati probléma, régi claude CLI.${NC}"
  echo -e "    ${DIM}Javítás, ha ebből a terminálból használod a claude-ot (pl. a párosításhoz): \`claude /login\` -> \`claude --print \"ping\"\` újra.${NC}"
fi

INSTALL_STEP="personal-info"
# Step 3: Personal info
echo ""
echo -e "${BOLD}$(_t section_3_macos)${NC}"
read -rp "$(_t prompt_your_name)" OWNER_NAME
# Chat ID is NOT asked here -- the user doesn't know it yet.
# It will be set automatically during the Telegram pairing flow.
CHAT_ID="0"

INSTALL_STEP="channel-setup"
# Step 4: Channel provider setup
echo ""
echo -e "${BOLD}$(_t section_4_macos)${NC}"
echo -e "${DIM}$(_t macos.channel_select_hint)${NC}"
echo -e "  ${BOLD}1.${NC} $(_t macos.channel_option_1)"
echo -e "  ${BOLD}2.${NC} Slack"
echo -e "  ${BOLD}3.${NC} Discord"
echo -e "  ${BOLD}4.${NC} $(_t channel_option_gromzo)"
echo ""
read -rp "$(_t prompt_channel_select4)" PROVIDER_CHOICE
PROVIDER_CHOICE=${PROVIDER_CHOICE:-1}
if [ "$PROVIDER_CHOICE" = "2" ]; then
  CHANNEL_PROVIDER="slack"
elif [ "$PROVIDER_CHOICE" = "3" ]; then
  CHANNEL_PROVIDER="discord"
elif [ "$PROVIDER_CHOICE" = "4" ] || [ "$PROVIDER_CHOICE" = "gromzo" ]; then
  # GROMZONOPROVIDER1108: the main agent talks only through Gromzo (no bot token, no Bun); accepted as 4 or by name.
  CHANNEL_PROVIDER="gromzo"
else
  CHANNEL_PROVIDER="telegram"
fi
echo -e "  ${GREEN}✓${NC} Csatorna: $CHANNEL_PROVIDER"

# INSTTOKEN807: probe the freshly entered bot token BEFORE anything is written.
# Warn-only (advisory), for two hard reasons: a network hiccup must not block
# the install, and the headless derive contract (Bridge payload) forbids new
# interactive reads here -- so we say it loudly and let the install continue.
# The dashboard save path hard-rejects the same states (#926); this is the
# installer-side voice for the same three findings, each with its remedy.
# set -e safe: every path ends in return 0; curl failures are guarded.
# The token value itself is NEVER printed.
probe_telegram_token() {
  _ptt_t="$1"
  [ -n "$_ptt_t" ] || return 0
  _ptt_me="$(curl -s --max-time 8 "https://api.telegram.org/bot${_ptt_t}/getMe" 2>/dev/null)" || return 0
  case "$_ptt_me" in
    *'"ok":true'*) : ;;
    *'"ok":false'*)
      warn "A megadott bot token ERVENYTELEN (a Telegram getMe elutasitotta)."
      echo -e "    ${DIM}Ellenorizd a @BotFather-tol kapott tokent. A telepites folytatodik, de a bot ezzel a tokennel nem fog valaszolni.${NC}"
      return 0 ;;
    *) return 0 ;;
  esac
  _ptt_wh="$(curl -s --max-time 8 "https://api.telegram.org/bot${_ptt_t}/getWebhookInfo" 2>/dev/null)" || return 0
  case "$_ptt_wh" in
    *'"url":"http'*)
      warn "A bot token ervenyes, de a bot WEBHOOKRA van kotve -- a Marveen poller igy nem tud ra csatlakozni."
      echo -e "    ${DIM}Teendo: nyisd meg bongeszoben: https://api.telegram.org/bot<A-TOKENED>/deleteWebhook${NC}"
      echo -e "    ${DIM}vagy keszits uj botot a @BotFather-nel, es futtasd ujra a telepitot azzal.${NC}"
      return 0 ;;
  esac
  _ptt_up="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://api.telegram.org/bot${_ptt_t}/getUpdates?timeout=0&limit=1" 2>/dev/null)" || return 0
  if [ "$_ptt_up" = "409" ]; then
    warn "A bot token ervenyes, de egy MASIK futo rendszer mar hasznalja (Telegram 409 Conflict)."
    echo -e "    ${DIM}Egy tokent egyszerre csak egy telepites hasznalhat. Teendo: allitsd le a korabbi telepitest,${NC}"
    echo -e "    ${DIM}vagy keszits uj botot a @BotFather-nel, es futtasd ujra a telepitot az uj tokennel.${NC}"
  fi
  return 0
}

BOT_TOKEN=""
SLACK_BOT_TOKEN=""
SLACK_APP_TOKEN=""
DISCORD_BOT_TOKEN=""
DISCORD_CHANNEL_ID=""
OPERATOR_DISCORD_USER_ID=""

if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  echo ""
  echo -e "${DIM}  Az AI asszisztensed Telegramon kommunikal veled.${NC}"
  echo -e "${DIM}  1. Nyisd meg a @BotFather-t a Telegramban${NC}"
  echo -e "${DIM}  2. Ird be: /newbot${NC}"
  echo -e "${DIM}  3. Adj nevet a botodnak${NC}"
  echo -e "${DIM}  4. Masold ide a kapott tokent:${NC}"
  echo ""
  read -rp "$(_t prompt_telegram_token)" BOT_TOKEN
  probe_telegram_token "$BOT_TOKEN"
elif [ "$CHANNEL_PROVIDER" = "discord" ]; then
  echo ""
  echo -e "${DIM}  Az AI asszisztensed Discordon kommunikal veled.${NC}"
  echo -e "${DIM}  1. Hozz letre egy alkalmazast: discord.com/developers/applications${NC}"
  echo -e "${DIM}  2. Bot fulon: Add Bot, majd masold ki a Tokent${NC}"
  echo -e "${DIM}  3. Privileged Gateway Intents: kapcsold be a MESSAGE CONTENT INTENT-et${NC}"
  echo -e "${DIM}  4. OAuth2 > URL Generator: bot scope, majd hivd meg a szerveredre${NC}"
  echo -e "${DIM}  5. Masold ki a csatorna ID-jet (Developer Mode > jobb klikk > Copy Channel ID)${NC}"
  echo -e "${DIM}  6. Sajat (operator) user ID: jobb klikk a nevedre > Copy User ID${NC}"
  echo ""
  read -rp "$(_t prompt_discord_bot_token)" DISCORD_BOT_TOKEN
  read -rp "$(_t prompt_discord_channel_id)" DISCORD_CHANNEL_ID
  echo ""
  echo -e "${DIM}  Az operator user ID-re a parositashoz kell: amikor egy uj felhasznalo${NC}"
  echo -e "${DIM}  DM-et ir a botnak, a bot ezen az ID-n ertesit teged jovahagyasert.${NC}"
  read -rp "$(_t prompt_discord_user_id)" OPERATOR_DISCORD_USER_ID

  # A previously written managed allowlist (a slack/teams install writes one)
  # BLOCKS every channel plugin missing from it -- measured on the fleet host:
  # /Library/Application Support/ClaudeCode/managed-settings.json lists
  # slack-channel + telegram + teams, no discord, so a discord plugin on such a
  # machine goes silently mute. A fresh telegram-only install never creates the
  # file and the official-marketplace plugin runs fine without it, so we only
  # MERGE when the file already exists -- never create it here.
  MANAGED_FILE="/Library/Application Support/ClaudeCode/managed-settings.json"
  if [ -f "$MANAGED_FILE" ]; then
    managed_settings_notice
    # Read as the user (MACROOTFROMCLONE1106): an already-allowed discord needs no password.
    if ! managed_has "$MANAGED_FILE" discord@claude-plugins-official; then
      echo -e "  ${ORANGE}⚠${NC} $(_t macos.managed_update)"
      # Merge only, the file is never created here: the shared writer
      # (MANAGEDSETTINGSWRITE1103, scripts/lib/managed-settings-write.py).
      # An org-policy file is NEVER rebuilt from scratch: one that is not a
      # valid JSON object is left untouched and the call fails, because a {}
      # fallback would silently drop the OTHER channels' allowlist entries,
      # muting them host-wide. Every other key and the file mode stay; the
      # write goes through a fresh mkstemp file and os.replace.
      if managed_write "$MANAGED_FILE" --add-plugin discord@claude-plugins-official
      then
        echo -e "  ${GREEN}✓${NC} Discord engedelyezve a managed-settings allowlistben"
      else
        echo -e "  ${RED}✗${NC} A managed-settings.json nem volt biztonsagosan frissitheto -- a fajl ERINTETLEN maradt."
        echo -e "  ${DIM}Kezi potlas (root): add az allowedChannelPlugins tombhoz:${NC}"
        echo -e "  ${DIM}  {\"plugin\":\"discord\",\"marketplace\":\"claude-plugins-official\"}${NC}"
      fi
    fi
  fi
elif [ "$CHANNEL_PROVIDER" = "gromzo" ]; then
  # GROMZONOPROVIDER1108: no bot, no token: the Gromzo channel is connected later from the Marveen Bridge.
  echo ""
  echo -e "${DIM}  Az AI asszisztensed a Gromzo alkalmazason at kommunikal veled; bot-token nem kell.${NC}"
  echo -e "${DIM}  A Gromzot a Marveen Bridge-ben kotod be a telepites utan.${NC}"
else
  echo ""
  echo -e "${DIM}  Az AI asszisztensed Slack-en kommunikal veled.${NC}"
  echo -e "${DIM}  1. Hozz letre egy Slack App-ot: api.slack.com/apps${NC}"
  echo -e "${DIM}  2. Engedeld a Socket Mode-ot${NC}"
  echo -e "${DIM}  3. OAuth & Permissions > Bot Token Scopes:${NC}"
  echo -e "${DIM}     app_mentions:read, channels:history, channels:join,${NC}"
  echo -e "${DIM}     channels:read, chat:write, files:read, files:write,${NC}"
  echo -e "${DIM}     groups:history, im:history, reactions:write, users:read${NC}"
  echo -e "${DIM}  4. Event Subscriptions > Bot Events:${NC}"
  echo -e "${DIM}     app_mention, message.channels, message.groups, message.im${NC}"
  echo -e "${DIM}  5. Installald a workspace-be${NC}"
  echo ""
  read -rp "$(_t prompt_slack_bot_token)" SLACK_BOT_TOKEN
  read -rp "$(_t prompt_slack_app_token)" SLACK_APP_TOKEN

  # Managed settings: Claude Code requires allowedChannelPlugins at system level
  MANAGED_DIR="/Library/Application Support/ClaudeCode"
  MANAGED_FILE="$MANAGED_DIR/managed-settings.json"
  SLACK_ENTRY='{"plugin":"slack-channel","marketplace":"marveen-marketplace"}'
  TELEGRAM_ENTRY='{"plugin":"telegram","marketplace":"claude-plugins-official"}'
  TEAMS_ENTRY='{"plugin":"teams","marketplace":"marveen-marketplace"}'
  DISCORD_ENTRY='{"plugin":"discord","marketplace":"claude-plugins-official"}'
  REQUIRED_JSON="{\"allowedChannelPlugins\":[$SLACK_ENTRY,$TELEGRAM_ENTRY,$TEAMS_ENTRY,$DISCORD_ENTRY]}"

  managed_settings_notice
  if [ -f "$MANAGED_FILE" ]; then
    # Gate on ALL required plugins being present (not just slack) -- otherwise an
    # install that already has slack/telegram but not teams skips the merge and
    # the Teams bot is silently dropped (online but never replies). This is the
    # per-customer sudo-elimination: the installer (already sudo) allows teams
    # at install time, so no manual managed-settings edit is needed later.
    # Read as the user (MACROOTFROMCLONE1106): a file that already allows all four needs no password.
    if ! managed_has "$MANAGED_FILE" slack-channel@marveen-marketplace telegram@claude-plugins-official \
      teams@marveen-marketplace discord@claude-plugins-official; then
      echo -e "  ${ORANGE}⚠${NC} $(_t macos.managed_update)"
      # Additive merge through the shared writer (MANAGEDSETTINGSWRITE1103,
      # scripts/lib/managed-settings-write.py; same call as the Discord branch).
      # An org-policy file is NEVER rebuilt from scratch: one that is not a
      # valid JSON object is left untouched and the call fails -- the old
      # empty-object fallback silently dropped every OTHER managed key
      # (channelsEnabled, other allowlists) host-wide, and the older `sudo tee`
      # shape TRUNCATED the file even when the merge failed. Every other key and
      # the file mode stay; the write goes through a fresh mkstemp file.
      if managed_write "$MANAGED_FILE" \
        --add-plugin slack-channel@marveen-marketplace \
        --add-plugin telegram@claude-plugins-official \
        --add-plugin teams@marveen-marketplace \
        --add-plugin discord@claude-plugins-official
      then
        echo -e "  ${GREEN}✓${NC} $(_t macos.managed_updated)"
      else
        echo -e "  ${RED}✗${NC} A managed-settings.json nem volt biztonsagosan frissitheto -- a fajl ERINTETLEN maradt."
        echo -e "  ${DIM}Kezi potlas (root): add az allowedChannelPlugins tombhoz a hianyzo bejegyzeseket:${NC}"
        echo -e "  ${DIM}  $REQUIRED_JSON${NC}"
      fi
    else
      echo -e "  ${GREEN}✓${NC} $(_t macos.managed_has_slack)"
    fi
  else
    echo -e "  ${ORANGE}⚠${NC} $(_t macos.managed_create)"
    /usr/bin/sudo /bin/mkdir -p "$MANAGED_DIR"
    # Fresh file through the same shared writer (--create): a fresh mkstemp file
    # and os.replace, so an interrupted install can never leave a truncated or
    # empty org-policy file that a later run would then refuse to touch (the
    # merge above declines unparseable files by design). A new file gets 0644
    # whatever the umask: under `umask 077` a root-owned 0600 policy is one the
    # unprivileged session cannot read, so it silently never takes effect. If a
    # file appeared meanwhile, --create merges into it instead of replacing it.
    if managed_write "$MANAGED_FILE" --create \
      --add-plugin slack-channel@marveen-marketplace \
      --add-plugin telegram@claude-plugins-official \
      --add-plugin teams@marveen-marketplace \
      --add-plugin discord@claude-plugins-official
    then
      echo -e "  ${GREEN}✓${NC} $(_t macos.managed_created)"
    else
      echo -e "  ${RED}✗${NC} A managed-settings.json letrehozasa nem sikerult -- kezi potlas (root):"
      echo -e "  ${DIM}  echo '$REQUIRED_JSON' > \"$MANAGED_FILE\"${NC}"
    fi
  fi
fi

# Channel inbound org-policy gate: ensure the system managed-settings enable
# channels (runs unconditionally, not only in the Slack branch above). claude-code
# >= 2.1.205 silently drops channel-plugin INBOUND notifications on a team/
# enterprise org unless managed-settings has channelsEnabled:true (harmless /
# no-op on a personal org). Idempotent + preserves existing managed keys.
# MACROOTFROMCLONE1106: the embedded writer does it, not the clone's
# scripts/ensure-managed-channels-enabled.sh (that script ran the clone's writer as root). Its separate
# call stays separate from the plugin merge above, so an allowlist the writer refuses never keeps
# channelsEnabled from being set. ORGGATESILENT806: never fails the install, and the outcome reaches the
# final summary (CHANNELS_GATE_STATE).
CHANNELS_GATE_STATE="manual"
MANAGED_DIR="/Library/Application Support/ClaudeCode"
MANAGED_FILE="$MANAGED_DIR/managed-settings.json"
if managed_has "$MANAGED_FILE" --channels; then
  echo "  channelsEnabled: mar be van kapcsolva ($MANAGED_FILE)"
  CHANNELS_GATE_STATE="ok"
else
  managed_settings_notice
  echo -e "  Managed-settings channel-kapu ellenorzese..."
  if /usr/bin/sudo /bin/mkdir -p "$MANAGED_DIR" 2>/dev/null && managed_write "$MANAGED_FILE" --create --channels-enabled; then
    echo "  channelsEnabled=true beallitva a managed-settings-ben ($MANAGED_FILE)"
    echo "    (a bejovo channel-uzenetek team/enterprise orgnal is celba ernek; restart utan lep eletbe.)"
    CHANNELS_GATE_STATE="ok"
  else
    echo "  ! channelsEnabled: a managed-settings frissitese sikertelen (a zaro osszegzes mondja a kezi lepest)."
  fi
fi

# MACROOTFROMCLONE1106: the LAST root step is above. From here on clone code runs (npm install and the build,
# the sourced helpers, the clone's scripts), so first the sudo login goes and the password the Bridge passed
# in (headless-sudo-macos.sh) is unset. `command` keeps this line out of the Bridge's sudo -> run_priv rewrite.
command /usr/bin/sudo -K 2>/dev/null || true
unset __MARVEEN_SUDO_PW
unset -f run_priv

read -rp "$(_t prompt_bot_name)" BOT_NAME
BOT_NAME=${BOT_NAME:-"Marveen"}

# Derive the ASCII slug the backend uses everywhere (tmux sessions, plist
# labels, DB agent_id, API routing). NFKD + ASCII + lowercase dashes, empty
# fallback to "marveen" so we never end up with a blank identifier.
MAIN_AGENT_ID=$(python3 - "$BOT_NAME" <<'PYEOF'
import sys, unicodedata, re
s = sys.argv[1].strip()
s = unicodedata.normalize('NFKD', s).encode('ASCII', 'ignore').decode()
s = re.sub(r'[^a-zA-Z0-9]+', '-', s).strip('-').lower()
print(s or 'marveen')
PYEOF
)
if [ "$MAIN_AGENT_ID" != "marveen" ]; then
  echo -e "  ${DIM}$(_t macos.agent_id_info)${MAIN_AGENT_ID}${NC}"
fi

# Product / system brand. Per Szabi's decision the installer does NOT prompt for
# a brand -- the product is always named after the main agent. BRAND_NAME and
# SERVICE_ID remain as fields (config.ts keeps the env support as a dormant
# capability, default = the agent name), but the install flow hardcodes them to
# the defaults, so the launchd labels below stay byte-identical to a
# brand-unaware install.
BRAND_NAME="$BOT_NAME"
SERVICE_ID="$MAIN_AGENT_ID"

# Resolve the Node the launchd SERVICES will run, and pin the whole install to
# it. Idempotent: sets NODE_PATH / NODE_BIN_DIR once, both the npm step below and
# the launchagent step later call it.
#
# This used to live only in the launchagent step, ~600 lines further down -- long
# AFTER `npm rebuild better-sqlite3`. So the install compiled the native module
# against whatever generic `node` was on the operator's PATH (v25/v26, ABI 141)
# and THEN handed the services node@22 (ABI 127). The pin worked exactly as
# designed and the module was still built for the wrong runtime:
#
#   better_sqlite3.node was compiled against NODE_MODULE_VERSION 141.
#   This version of Node.js requires NODE_MODULE_VERSION 127.
#
# `channels` survived (it touches no DB); the dashboard died on its first
# require, so store/.dashboard-token -- written on first successful boot -- was
# never created, and the installer still printed "sikeresen telepitve".
resolve_service_node() {
  [ -n "${NODE_PATH:-}" ] && [ -x "${NODE_PATH:-}" ] && return 0

  # Homebrew's generic `node` symlink auto-upgrades to new majors whose ABI
  # breaks the prebuilt better-sqlite3. node@22 is keg-only, so a generic `node`
  # of any major can coexist -- pin to its keg path.
  local prefix
  prefix="$(brew --prefix node@22 2>/dev/null || true)"

  if { [ -z "$prefix" ] || [ ! -x "$prefix/bin/node" ]; } && command -v brew &>/dev/null; then
    echo -e "  ${ORANGE}node@22 telepitese a launchd szolgaltatasokhoz (ABI-stabil better-sqlite3)...${NC}"
    brew install node@22 || true
    prefix="$(brew --prefix node@22 2>/dev/null || true)"
  fi

  if [ -n "$prefix" ] && [ -x "$prefix/bin/node" ]; then
    NODE_PATH="$prefix/bin/node"
  else
    # Last-resort fallback: node@22 could not be installed (e.g. no brew). The
    # services may still break on an ABI-incompatible node -- warn loudly.
    NODE_PATH="$(which node)"
    echo -e "  ${RED}Figyelem:${NC} node@22 nem elerheto, a szolgaltatasok ${NODE_PATH}-ra allnak. ABI-hiba eseten telepitsd: brew install node@22"
  fi

  NODE_BIN_DIR="$(dirname "$NODE_PATH")"
}

# Step 5: Install dependencies
INSTALL_STEP="bun-install"
# GROMZONOPROVIDER1108: Bun only for a channel plugin that runs on it (telegram, discord); Slack and Gromzo run on Node.
# MACROOTFROMCLONE1106 still holds: the profile is never sourced; bun's installer only adds its bin dir to it.
case "$CHANNEL_PROVIDER" in
  telegram|discord)
    if command -v bun &>/dev/null; then
      ok "bun mar telepitve: $(bun --version)"
    else
      echo -e "  ${ORANGE}$(_t macos.installing_bun)${NC}"
      _install_bun
    fi
    ;;
  *)
    ok "Bun nem kell (${CHANNEL_PROVIDER}: a csatorna Node-on fut)"
    ;;
esac

INSTALL_STEP="npm-install"
echo ""
echo -e "${BOLD}$(_t section_5)${NC}"
cd "$INSTALL_DIR"
resolve_service_node
# Prepending NODE_BIN_DIR is what makes the rebuild target the SERVICE runtime:
# npm resolves `node` through PATH, and node-gyp compiles against the node that
# resolves. Same reason the install runs under it too -- it can fetch or build
# native prebuilds of its own.
#
# INSTALLDIRTYTREE1103: `npm ci` first, as install-linux.sh and update.sh do.
# A plain `npm install` rewrites package-lock.json into npm's canonical form
# (marveen2, 11-03: +1 line, better-sqlite3 "hasInstallScript"), and a tracked
# file changed by the installer sends every later update down the stash path.
# `npm install` stays as the fallback for a genuine lockfile desync; the lock
# it may rewrite is restored afterwards, because node_modules is what the
# service runs and the next update's `npm ci` reinstalls from the tracked lock.
_NPM_CI_LOG=$(mktemp)
if PATH="$NODE_BIN_DIR:$PATH" npm ci --loglevel warn 2>"$_NPM_CI_LOG"; then
  _NPM_OK=1
elif PATH="$NODE_BIN_DIR:$PATH" npm install --loglevel warn; then
  _NPM_OK=1
  git -C "$INSTALL_DIR" checkout -q -- package-lock.json 2>/dev/null || true
else
  _NPM_OK=0
  echo -e "  ${DIM}--- npm ci kimenet ---${NC}"
  cat "$_NPM_CI_LOG" >&2
fi
rm -f "$_NPM_CI_LOG"
if [ "$_NPM_OK" != 1 ] || ! PATH="$NODE_BIN_DIR:$PATH" npm rebuild better-sqlite3 --build-from-source; then
  fail "npm install sikertelen. Ellenorizd a hibauzeneteket fentebb."
fi
unset _NPM_OK
ok "$(_t macos.npm_done)"

# Build TypeScript
INSTALL_STEP="typescript-build"
echo -e "$(_t macos.building)"
# Same PATH pin as npm ci/install above: a bare `npm run build` resolves the
# generic Homebrew `node`, which may be a different major -- or broken outright
# (a node bottle linked against a simdjson dylib that a later brew upgrade
# removed aborts in dyld, and the install died here with node@22 present).
if ! PATH="$NODE_BIN_DIR:$PATH" npm run build --loglevel warn; then
  fail "TypeScript forditas sikertelen. Ellenorizd a hibauzeneteket fentebb."
fi
ok "$(_t macos.ts_built)"

# Stamp the build-marker after a successful fresh-install build, mirroring the
# update.sh self-heal (dist/.built-commit records the commit dist was built
# from). On a build abort, fail()/the ERR-trap exit 1 BEFORE this line, so the
# marker is only ever written for a complete dist -- it can never falsely
# report a stale/partial dist as healthy. Stamping it here also keeps a later
# update.sh run from a needless first-adoption self-healing rebuild (marker ==
# HEAD on a fresh install). A failed rev-parse just leaves the marker absent,
# which the update.sh self-heal then handles exactly as before (no regression).
if [ -d "$INSTALL_DIR/dist" ]; then
  _built_commit="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$_built_commit" ] && printf '%s\n' "$_built_commit" > "$INSTALL_DIR/dist/.built-commit"
fi

INSTALL_STEP="configuration"
# Step 6: Configuration
echo ""
echo -e "${BOLD}$(_t section_6_macos)${NC}"

# Create or UPDATE .env -- MERGE, never replace (card 8290FF71). The old
# cat> heredoc regenerated the file on every run, silently dropping every
# line the installer does not own: wizard-saved credentials
# (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY), operator-added keys
# (WEB_HOST, GOOGLE_API_KEY, MAIN_AGENT_ISOLATED_CONFIG, ...) and a live
# pairing (ALLOWED_CHAT_ID) -- so a re-run over a working install broke it.
# Critical toggles should additionally live in store/config-overrides.json
# (two-layer store), which install/update never touches.
env_merge_key() {
  # env_merge_key KEY VALUE -- drop any existing KEY= line, append KEY=VALUE.
  _emk_tmp="$INSTALL_DIR/.env.tmp.$$"
  # ENVTMPMODE925: the tmp holds the WHOLE .env (bot token, API keys) until the
  # mv below, so it is created 0600 from its first byte -- at the umask default
  # it was world-readable for that window (the VAULTMODE818 pattern). The rm
  # matters too: a leftover tmp of the same name would keep its old mode.
  rm -f "$_emk_tmp"
  (umask 077; grep -v "^$1=" "$INSTALL_DIR/.env" > "$_emk_tmp" 2>/dev/null) || true
  printf '%s=%s\n' "$1" "$2" >> "$_emk_tmp"
  mv "$_emk_tmp" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
}
env_keep_or_set() {
  # env_keep_or_set KEY VALUE -- like env_merge_key, but an EMPTY new value
  # never clobbers an existing non-empty one (re-run with a skipped prompt).
  _eks_existing="$(grep "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ -z "$2" ] && [ -n "$_eks_existing" ]; then return 0; fi
  env_merge_key "$1" "$2"
}
env_set_if_absent() {
  # env_set_if_absent KEY VALUE -- write only when the KEY line does not exist
  # at all. Used for a default the installer proposes rather than enforces: an
  # operator who deliberately set KEY=0 keeps that decision across re-runs, and
  # an explicitly set KEY=1 is not rewritten either.
  if grep -q "^$1=" "$INSTALL_DIR/.env" 2>/dev/null; then return 0; fi
  env_merge_key "$1" "$2"
}
env_add_list_entry() {
  # env_add_list_entry KEY ENTRY -- make sure ENTRY is in the comma list KEY,
  # keeping every entry already there. Read the way the server reads it: the
  # LAST KEY= line wins (src/env-parse.ts), one pair of surrounding quotes is
  # dropped, and each entry is compared after the server's normalisation
  # (parseSystemSenderIds: split on commas, trim; sanitizeAgentIdent: keep
  # [A-Za-z0-9_-]). Present -> no write; absent -> appended, as ONE KEY= line.
  _eal_cur="$(grep "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$_eal_cur" in
    \"*\") _eal_cur="${_eal_cur#\"}"; _eal_cur="${_eal_cur%\"}" ;;
    \'*\') _eal_cur="${_eal_cur#\'}"; _eal_cur="${_eal_cur%\'}" ;;
  esac
  _eal_cur="$(printf '%s' "$_eal_cur" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  _eal_saved_ifs="$IFS"; IFS=','
  for _eal_e in $_eal_cur; do
    if [ "$(printf '%s' "$_eal_e" | tr -dc 'A-Za-z0-9_-')" = "$2" ]; then IFS="$_eal_saved_ifs"; return 0; fi
  done
  IFS="$_eal_saved_ifs"
  if [ -n "$(printf '%s' "$_eal_cur" | tr -d ', ')" ]; then env_merge_key "$1" "$_eal_cur,$2"; else env_merge_key "$1" "$2"; fi
}
(umask 077 && touch "$INSTALL_DIR/.env")
chmod 600 "$INSTALL_DIR/.env"
[ -s "$INSTALL_DIR/.env" ] || printf '# Main agent konfiguracio\n' >> "$INSTALL_DIR/.env"
env_merge_key CHANNEL_PROVIDER "${CHANNEL_PROVIDER}"
env_merge_key OWNER_NAME "${OWNER_NAME}"
env_merge_key BOT_NAME "${BOT_NAME}"
env_merge_key BRAND_NAME "${BRAND_NAME}"
env_merge_key MAIN_AGENT_ID "${MAIN_AGENT_ID}"
env_merge_key SERVICE_ID "${SERVICE_ID}"
env_merge_key WEB_PORT "${WEB_PORT:-3420}"
# The fleet's own guards alert under their OWN names: the prod-tree guard
# (scripts/install-prod-tree-guard-hook.sh) and the channels.sh shared-root
# guard. The message route accepts a sender only if it is a registered agent,
# the owner, or listed in SYSTEM_SENDER_IDS, so without these entries each
# guard falls back to sending as MAIN_AGENT_ID, i.e. the supervisory system
# writes under the main agent's name. Appended to what the operator listed,
# never replacing it; an entry already there is not written twice.
# KNOWN LIMIT: the server reads the list once, at start-up (src/config.ts). A
# fresh install starts it after this; a RE-RUN over a running install does not
# restart it, so until the next dashboard restart a guard that reads the new
# line sends under its own name to a server that does not know it yet.
env_add_list_entry SYSTEM_SENDER_IDS prod-tree-guard
env_add_list_entry SYSTEM_SENDER_IDS channels-sh-guard
if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  env_keep_or_set TELEGRAM_BOT_TOKEN "${BOT_TOKEN}"
  # Never demote a paired install: CHAT_ID=0 means pairing was skipped THIS
  # run -- it must not overwrite a real chat id from a previous run.
  _existing_chat="$(grep '^ALLOWED_CHAT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ "${CHAT_ID}" != "0" ] || [ -z "$_existing_chat" ]; then
    env_merge_key ALLOWED_CHAT_ID "${CHAT_ID}"
  fi
elif [ "$CHANNEL_PROVIDER" = "gromzo" ]; then
  : # GROMZONOPROVIDER1108: no token keys
elif [ "$CHANNEL_PROVIDER" = "discord" ]; then
  env_keep_or_set DISCORD_BOT_TOKEN "${DISCORD_BOT_TOKEN}"
  env_keep_or_set DISCORD_CHANNEL_ID "${DISCORD_CHANNEL_ID}"
  env_keep_or_set OPERATOR_DISCORD_USER_ID "${OPERATOR_DISCORD_USER_ID}"
else
  env_keep_or_set SLACK_BOT_TOKEN "${SLACK_BOT_TOKEN}"
  env_keep_or_set SLACK_APP_TOKEN "${SLACK_APP_TOKEN}"
fi
chmod 600 "$INSTALL_DIR/.env"
echo -e "  ${GREEN}✓${NC} $(_t macos.env_created)"

# Create store directory
mkdir -p "$INSTALL_DIR/store"
mkdir -p "$INSTALL_DIR/agents"

# Persist the service-side credential captured in the auth step. Both sinks are
# needed: .env is what channels.sh exports for the MAIN agent, and the fleet
# token file is what per-agent config-dir isolation reads for SUB-agents.
if [ -n "${MACOS_OAUTH_TOKEN_INPUT:-}" ]; then
  env_merge_key CLAUDE_CODE_OAUTH_TOKEN "$MACOS_OAUTH_TOKEN_INPUT"
  chmod 600 "$INSTALL_DIR/.env"
  if printf '%s' "$MACOS_OAUTH_TOKEN_INPUT" | grep -Eq '^sk-ant-oat01-[A-Za-z0-9_-]{40,}$'; then
    (umask 077 && printf '%s' "$MACOS_OAUTH_TOKEN_INPUT" > "$INSTALL_DIR/store/.claude-oauth-token")
    ok "Fleet setup-token eltarolva (store/.claude-oauth-token) -- per-agent izolacio aktiv"
    # Point the MAIN agent at an isolated config dir too, not just the
    # sub-agents. Without this the main bot keeps the shared ~/.claude and
    # authenticates from whatever refreshes that root -- the ROTATING macOS
    # Keychain OAuth session -- which periodically expires and 401s the bot
    # into a parked TUI that the router reads as busy, so the channel goes
    # silent with no error (the confirmed root cause of the 2026-07-23
    # marveen-channels outage). The setting existed but nothing ever turned
    # it on, so every default install was wired to that failure mode.
    #
    # Only in THIS branch, i.e. only when the installer just captured the
    # fleet token itself in this same run: the operator handed it over
    # moments ago, so the identity the main bot will run under is not a
    # surprise. An install that already carried auth keeps whatever it had.
    # env_set_if_absent, so a deliberate MAIN_AGENT_ISOLATED_CONFIG=0 stands.
    env_set_if_absent MAIN_AGENT_ISOLATED_CONFIG 1
  fi
fi

# ── Fail-closed auth gate ────────────────────────────────────────────────────
# Three states; the failure branches must never print the success text.
INSTALL_AUTH_STATE="BROKEN"
_svc_token=""
if [ -s "$INSTALL_DIR/store/.claude-oauth-token" ]; then
  _svc_token="$(cat "$INSTALL_DIR/store/.claude-oauth-token" 2>/dev/null || true)"
fi
if [ -z "$_svc_token" ]; then
  _svc_token="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
fi
_svc_apikey="$(grep -E '^ANTHROPIC_API_KEY=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"

if ! service_auth_present; then
  INSTALL_AUTH_STATE="BROKEN"
elif ! command -v claude >/dev/null 2>&1; then
  INSTALL_AUTH_STATE="UNKNOWN"
else
  # Probe the way a SERVICE runs: isolated config dir (so the Keychain and the
  # operator's shell cannot make a broken install look healthy) carrying ONLY
  # the credential the launchd units will get.
  # TMPPROBE1108 (Dani 73504): no fixed /tmp fallback name. This dir is claude's CLAUDE_CONFIG_DIR next to the SERVICE
  # token; a predictable one another local user created first could carry a settings.json whose hooks run commands
  # with it. Without a private dir the probe is skipped and the state is UNKNOWN (said below).
  _probe_cfg="$(mktemp -d 2>/dev/null)" || _probe_cfg=""
  if [ -z "$_probe_cfg" ]; then
    warn "Az auth-proba kimarad: nem tudtam privat ideiglenes konyvtarat letrehozni (mktemp -d)."
    INSTALL_AUTH_STATE="UNKNOWN"
  else
    # A 401 here is the VERDICT this gate exists to report, not an installer
    # error. Unguarded, the capture reached the ERR trap and on_error() exited 1 --
    # blaming the enclosing `fi` -- so the BROKEN branch below (and its
    # `scripts/auth.sh` hint) was unreachable in exactly the case it was written
    # for. `&& ... || ...` keeps the failure out of the trap and preserves rc.
    _probe_rc=0
    if [ -n "$_svc_token" ]; then
      _probe_out="$(env -i PATH="$PATH" HOME="$HOME" CLAUDE_CONFIG_DIR="$_probe_cfg" \
        CLAUDE_CODE_OAUTH_TOKEN="$_svc_token" claude --print "ping" 2>&1)" && _probe_rc=0 || _probe_rc=$?
    else
      _probe_out="$(env -i PATH="$PATH" HOME="$HOME" CLAUDE_CONFIG_DIR="$_probe_cfg" \
        ANTHROPIC_API_KEY="$_svc_apikey" claude --print "ping" 2>&1)" && _probe_rc=0 || _probe_rc=$?
    fi
    _probe_out=${_probe_out:0:200}
    if [ "$_probe_rc" -eq 0 ] && [ -n "$_probe_out" ]; then
      INSTALL_AUTH_STATE="OK"
    else
      INSTALL_AUTH_STATE="BROKEN"
    fi
    rm -rf "$_probe_cfg" 2>/dev/null || true
  fi
fi
unset _svc_token _svc_apikey

case "$INSTALL_AUTH_STATE" in
  OK)
    ok "Auth ellenorizve a SZOLGALTATASOK utjan (izolalt konfig + a unitok hitelesitoje)"
    ;;
  UNKNOWN)
    warn "Az auth-ot NEM tudtam ellenorizni (nincs futtathato claude vagy nincs halozat)."
    echo -e "    ${DIM}A telepites folytatodik, de az ugynokok indulasa nincs igazolva.${NC}"
    ;;
  *)
    warn "AZ UGYNOKOK IGY NEM FOGNAK ELINDULNI: a telepites nem hordoz mukodo auth kulcsot."
    echo -e "    ${DIM}A szolgaltatasok CSAK ezt a ket helyet olvassak:${NC}"
    echo -e "    ${DIM}  - $INSTALL_DIR/.env  (CLAUDE_CODE_OAUTH_TOKEN vagy ANTHROPIC_API_KEY)${NC}"
    echo -e "    ${DIM}  - $INSTALL_DIR/store/.claude-oauth-token${NC}"
    echo -e "    ${DIM}A Keychain-bejelentkezes (claude auth login) ehhez NEM eleg.${NC}"
    echo -e "    ${BOLD}Javitas most: ${BLUE}bash \"$INSTALL_DIR/scripts/auth.sh\"${NC}"
    ;;
esac
echo -e "  ${GREEN}✓${NC} $(_t macos.dirs_created)"

# SEEDRENDERLITERAL1108 / PERSONARENDERLITERAL1108: the persona renders and the seeding loops below render through the
# shared lib (scripts/lib/seed-refresh.sh render_seed_template / render_persona_file): a name typed here with &, / or \
# goes in literally, a failed render never truncates its target, and the seeded bytes are the ones the seed refresh
# compares against later. The lib ships in this tree; without it the tree is broken.
[ -f "$INSTALL_DIR/scripts/lib/seed-refresh.sh" ] && . "$INSTALL_DIR/scripts/lib/seed-refresh.sh"
command -v render_persona_file >/dev/null 2>&1 || fail "scripts/lib/seed-refresh.sh is missing: the install tree is incomplete"

# Generate CLAUDE.md from template
if [ -f "$INSTALL_DIR/templates/CLAUDE.md.template" ]; then
  # PERSONARENDERLITERAL1108: the shared literal render, through a temp file (the target is never truncated)
  RENDER_CHAT_ID="$CHAT_ID" RENDER_TIMEZONE="$(. "$INSTALL_DIR/scripts/lib/install-tz.sh"; z="$(install_tz "$INSTALL_DIR")"; printf '%s' "${z:-UTC}")" \
    render_persona_file "$(. "$INSTALL_DIR/scripts/lib/persona-template.sh"; persona_template "$INSTALL_DIR" CLAUDE.md.template decide)" "$INSTALL_DIR/CLAUDE.md" \
    || fail "CLAUDE.md could not be rendered from its template; nothing was written"
  echo -e "  ${GREEN}✓${NC} $(_t macos.claude_md_generated)"
else
  echo -e "  ${ORANGE}⚠${NC} CLAUDE.md.template nem talalhato, CLAUDE.md nem generalhato"
fi

# Generate SOUL.md from template (personality definition for the main agent).
# Sub-agents get theirs from the LLM generator, but the main agent didn't
# have one before, so the dashboard showed "Nincs SOUL.md".
if [ -f "$INSTALL_DIR/templates/SOUL.md.template" ] && [ ! -f "$INSTALL_DIR/SOUL.md" ]; then
  render_persona_file "$(. "$INSTALL_DIR/scripts/lib/persona-template.sh"; persona_template "$INSTALL_DIR" SOUL.md.template decide)" "$INSTALL_DIR/SOUL.md" \
    || fail "SOUL.md could not be rendered from its template; nothing was written"
  echo -e "  ${GREEN}✓${NC} $(_t macos.soul_md_generated)"
elif [ ! -f "$INSTALL_DIR/templates/SOUL.md.template" ] && [ ! -f "$INSTALL_DIR/SOUL.md" ]; then
  echo -e "  ${ORANGE}⚠${NC} SOUL.md.template nem talalhato, SOUL.md nem generalhato"
fi

# Scaffold default scheduled tasks into ~/.claude/scheduled-tasks/. Templates
# carry {{MAIN_AGENT_ID}} placeholders so tasks target the user's chosen agent
# slug rather than hardcoded "marveen". Skip task dirs that already exist --
# never overwrite user customizations.
SCHED_TPL_DIR="$INSTALL_DIR/templates/scheduled-tasks"
SCHED_TARGET_DIR="$HOME/.claude/scheduled-tasks"
if [ -d "$SCHED_TPL_DIR" ]; then
  mkdir -p "$SCHED_TARGET_DIR"
  for tpl in "$SCHED_TPL_DIR"/*/; do
    [ -d "$tpl" ] || continue
    task_name=$(basename "$tpl")
    target="$SCHED_TARGET_DIR/$task_name"
    if [ -d "$target" ]; then
      continue
    fi
    mkdir -p "$target"
    # SEEDREFDIR1018: a task may keep part of its text in a references/
    # subdir that its SKILL.md points at; it ships with the same templating,
    # or the pointer lands on a file that does not exist.
    for sub in "" "references/"; do
      [ -z "$sub" ] || [ -d "$tpl$sub" ] || continue
      mkdir -p "$target/$sub"
      for f in "$tpl$sub"*; do
        [ -f "$f" ] || continue
        # SEEDRENDERLITERAL1108: the shared render (literal values; the bytes the seed refresh compares against)
        render_seed_template < "$f" > "$target/$sub$(basename "$f")"
      done
    done
    INSTALL_SCHED_REGISTER="${INSTALL_SCHED_REGISTER:-} $task_name"
    echo -e "  ${GREEN}✓${NC} Utemezett feladat scaffoldolva: $task_name"
  done
fi

# Setup channel state directory
CHANNEL_DIR="$HOME/.claude/channels/$CHANNEL_PROVIDER"
# GROMZONOPROVIDER1108: gromzo keeps no channel state here (no token, no access.json), so no empty dir for it.
[ "$CHANNEL_PROVIDER" = "gromzo" ] || mkdir -p "$CHANNEL_DIR"

if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ -n "$BOT_TOKEN" ]; then
  (umask 077 && echo "TELEGRAM_BOT_TOKEN=$BOT_TOKEN" > "$CHANNEL_DIR/.env")
  chmod 600 "$CHANNEL_DIR/.env"
  cat > "$CHANNEL_DIR/access.json" << ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
ACCESSEOF
  echo -e "  ${GREEN}✓${NC} $(_t macos.tg_channel_configured)"
elif [ "$CHANNEL_PROVIDER" = "slack" ] && [ -n "$SLACK_BOT_TOKEN" ]; then
  (umask 077 && cat > "$CHANNEL_DIR/.env" << SLACKENVEOF
SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN
SLACK_APP_TOKEN=$SLACK_APP_TOKEN
SLACKENVEOF
  )
  chmod 600 "$CHANNEL_DIR/.env"
  cat > "$CHANNEL_DIR/access.json" << ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "channels": {},
  "pending": {}
}
ACCESSEOF
  echo -e "  ${GREEN}✓${NC} $(_t macos.slack_channel_configured)"
elif [ "$CHANNEL_PROVIDER" = "discord" ] && [ -n "$DISCORD_BOT_TOKEN" ]; then
  (umask 077 && cat > "$CHANNEL_DIR/.env" << DISCORDENVEOF
DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN
DISCORD_CHANNEL_ID=$DISCORD_CHANNEL_ID
DISCORDENVEOF
  )
  chmod 600 "$CHANNEL_DIR/.env"
  cat > "$CHANNEL_DIR/access.json" << ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "channels": {},
  "pending": {}
}
ACCESSEOF
  echo -e "  ${GREEN}✓${NC} $(_t macos.discord_channel_configured)"
fi

# Install channel plugin
# GROMZONOPROVIDER1108: on gromzo there is no channel plugin to install here (the Bridge's Gromzo step brings it).
if [ "$CHANNEL_PROVIDER" = "gromzo" ]; then
  PLUGIN_ID=""
  ok "Gromzo: a csatorna-plugint a Bridge Gromzo-lepese hozza (itt nincs mit telepiteni)"
elif [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  PLUGIN_MARKETPLACE="anthropics/claude-plugins-official"
  PLUGIN_ID="telegram@claude-plugins-official"
  PLUGIN_SHORT="telegram"
elif [ "$CHANNEL_PROVIDER" = "discord" ]; then
  PLUGIN_MARKETPLACE="anthropics/claude-plugins-official"
  PLUGIN_ID="discord@claude-plugins-official"
  PLUGIN_SHORT="discord"
else
  PLUGIN_MARKETPLACE="Szotasz/marveen-marketplace"
  PLUGIN_ID="slack-channel@marveen-marketplace"
  PLUGIN_SHORT="slack-channel"
fi

if [ -z "$PLUGIN_ID" ]; then
  :
else
echo -e "  ${CHANNEL_PROVIDER} plugin telepites..."
claude plugin marketplace add "$PLUGIN_MARKETPLACE" 2>/dev/null || true
if claude plugin install "$PLUGIN_ID" 2>/dev/null; then
  ok "${CHANNEL_PROVIDER} plugin telepitve"
else
  echo -e "  ${ORANGE}$(_t macos.plugin_retry)${NC}"
  sleep 2
  if claude plugin install "$PLUGIN_ID" 2>/dev/null; then
    ok "${CHANNEL_PROVIDER} plugin telepitve (masodik probalkozassal)"
  else
    echo -e "  ${RED}✗${NC} ${CHANNEL_PROVIDER} plugin telepites sikertelen."
    echo -e "  ${BOLD}$(_t macos.plugin_manual_hint)${NC}"
    echo -e "  ${BLUE}claude plugin install ${PLUGIN_ID}${NC}"
    echo ""
  fi
fi
fi

# INSTALLDIRTYTREE1103: NO `claude plugin enable --scope project` here. That
# call rewrote the TRACKED .claude/settings.json (the whole file reformatted, ~500
# lines, plus a wrong "<provider>@marveen-marketplace" key for Telegram/Discord),
# so every fresh install left a dirty tree and every later update had to stash.
# channels.sh enables the primary plugin for the main session through its
# launch-time --settings file (store/.main-extra-plugins.settings.json), which
# outranks the project scope and is gitignored.
cd "$INSTALL_DIR"

# Install skill-factory (self-learning meta-skill)
SKILLS_DIR="$HOME/.claude/skills"
if [ -d "$INSTALL_DIR/skills/skill-factory" ]; then
  mkdir -p "$SKILLS_DIR/skill-factory"
  cp -r "$INSTALL_DIR/skills/skill-factory/"* "$SKILLS_DIR/skill-factory/"
  echo -e "  ${GREEN}✓${NC} $(_t macos.skill_factory_installed)"
fi

# PERSONAESC1107 seed A: the seeders' language (scripts/lib/seed-lang.sh, read only: the persona render above decided it).
# On en a seeded Markdown file comes from i18n/en/<its repo path> when that exists. Without the lib, Hungarian as before.
SEED_LANG=hu
if [ -f "$INSTALL_DIR/scripts/lib/seed-lang.sh" ]; then
  . "$INSTALL_DIR/scripts/lib/seed-lang.sh"
  SEED_LANG="$(seed_lang "$INSTALL_DIR")"
fi

# Seed skills: fleet-level skills from seed-skills/ into ~/.claude/skills/
# Idempotent: skip directories that already exist (never overwrite user customizations)
SEED_SKILLS_DIR="$INSTALL_DIR/seed-skills"
if [ -d "$SEED_SKILLS_DIR" ]; then
  SEED_NEW=0
  SEED_SKIP=0
  for skill_dir in "$SEED_SKILLS_DIR"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    target="$SKILLS_DIR/$skill_name"
    if [ -d "$target" ]; then
      SEED_SKIP=$((SEED_SKIP + 1))
      continue
    fi
    mkdir -p "$target"
    for f in "$skill_dir"*; do
      [ -f "$f" ] || continue
      seed_src="$f"
      command -v seed_src_for >/dev/null 2>&1 && seed_src="$(seed_src_for "$INSTALL_DIR" "seed-skills/$skill_name/$(basename "$f")" "${SEED_LANG:-hu}")"
      cp "$seed_src" "$target/$(basename "$f")"
    done
    # SEEDSKILLSUB1018: a skill's subdirs (scripts/, references/, ...) ship too,
    # verbatim and with their mode bits; its SKILL.md points into them.
    # Only the files git TRACKS: a whole-dir copy also carried untracked and
    # ignored files, and fleet-helper's own scripts/.gitignore names exactly
    # those as secrets/personal data (mail_rules.json, .dashboard-token).
    # Outside a git checkout nothing below the top level is copied.
    git -C "$skill_dir" ls-files -z 2>/dev/null | while IFS= read -r -d '' rel; do
      case "$rel" in */*) ;; *) continue ;; esac   # top-level files: the loop above
      mkdir -p "$target/$(dirname "$rel")"
      seed_src="$skill_dir$rel"
      command -v seed_src_for >/dev/null 2>&1 && seed_src="$(seed_src_for "$INSTALL_DIR" "seed-skills/$skill_name/$rel" "${SEED_LANG:-hu}")"
      cp -p "$seed_src" "$target/$rel"
    done
    SEED_NEW=$((SEED_NEW + 1))
  done
  if [ "$SEED_NEW" -gt 0 ] || [ "$SEED_SKIP" -gt 0 ]; then
    echo -e "  ${GREEN}✓${NC} Seed skills: ${SEED_NEW} new, ${SEED_SKIP} skipped"
  fi
fi

# Seed scheduled tasks: from seed-scheduled-tasks/ into ~/.claude/scheduled-tasks/
# Idempotent: skip directories that already exist. Templates use {{MAIN_AGENT_ID}},
# {{BOT_NAME}}, {{OWNER_NAME}}, {{INSTALL_DIR}} placeholders.
SEED_SCHED_DIR="$INSTALL_DIR/seed-scheduled-tasks"
if [ -d "$SEED_SCHED_DIR" ]; then
  mkdir -p "$SCHED_TARGET_DIR"
  SCHED_NEW=0
  SCHED_SKIP=0
  for tpl in "$SEED_SCHED_DIR"/*/; do
    [ -d "$tpl" ] || continue
    task_name=$(basename "$tpl")
    target="$SCHED_TARGET_DIR/$task_name"
    if [ -d "$target" ]; then
      SCHED_SKIP=$((SCHED_SKIP + 1))
      continue
    fi
    mkdir -p "$target"
    # SEEDREFDIR1018: a task may keep part of its text in a references/
    # subdir that its SKILL.md points at; it ships with the same templating,
    # or the pointer lands on a file that does not exist.
    for sub in "" "references/"; do
      [ -z "$sub" ] || [ -d "$tpl$sub" ] || continue
      mkdir -p "$target/$sub"
      for f in "$tpl$sub"*; do
        [ -f "$f" ] || continue
        seed_src="$f"
        command -v seed_src_for >/dev/null 2>&1 && seed_src="$(seed_src_for "$INSTALL_DIR" "seed-scheduled-tasks/$task_name/$sub$(basename "$f")" "${SEED_LANG:-hu}")"
        # SEEDRENDERLITERAL1108: the shared render (literal values; the bytes the seed refresh compares against)
        render_seed_template < "$seed_src" > "$target/$sub$(basename "$f")"
      done
    done
    INSTALL_SCHED_REGISTER="${INSTALL_SCHED_REGISTER:-} $task_name"
    SCHED_NEW=$((SCHED_NEW + 1))
  done
  if [ "$SCHED_NEW" -gt 0 ] || [ "$SCHED_SKIP" -gt 0 ]; then
    echo -e "  ${GREEN}✓${NC} Seed scheduled tasks: ${SCHED_NEW} new, ${SCHED_SKIP} skipped"
  fi
  # Init state files for seeded tasks
  if [ "$SCHED_NEW" -gt 0 ]; then
    STATE_FILE="$INSTALL_DIR/store/kanban-audit-state.json"
    if [ ! -f "$STATE_FILE" ]; then
      echo '{"last_audit_at":null}' > "$STATE_FILE"
      echo -e "  ${GREEN}✓${NC} $(_t macos.kanban_state_init)"
    fi
  fi

  # Seed bumblebee threat-intel catalogs into ~/.claude/tools/
  BB_SEED_TI="$SEED_SCHED_DIR/bumblebee-hygiene-scan/threat-intel"
  BB_TARGET_TI="$HOME/.claude/tools/bumblebee-threat-intel"
  if [ -d "$BB_SEED_TI" ] && [ ! -d "$BB_TARGET_TI" ]; then
    mkdir -p "$BB_TARGET_TI"
    cp "$BB_SEED_TI"/*.json "$BB_TARGET_TI/" 2>/dev/null
    echo -e "  ${GREEN}✓${NC} $(_t macos.bumblebee_installed)"
  fi
fi

# Scheduled-task registry: the schedule runner fires a task only if its
# files hash-match the dashboard's registry. Register the tasks seeded above
# (dist is already built at this point). On a FRESH install this is redundant
# with the dashboard's one-time upgrade backfill; on a reinstall over an
# existing box it is what keeps a newly seeded default firing.
if [ -n "$(echo "${INSTALL_SCHED_REGISTER:-}" | tr -d ' ')" ] && [ -f "$INSTALL_DIR/dist/web/schedule-registry-cli.js" ] && command -v node >/dev/null 2>&1; then
  # shellcheck disable=SC2086 # word-splitting the name list is intended
  node "$INSTALL_DIR/dist/web/schedule-registry-cli.js" register --source installer $INSTALL_SCHED_REGISTER >/dev/null 2>&1 \
    || echo "  WARN: scheduled-task registry registration failed; run: node $INSTALL_DIR/dist/web/schedule-registry-cli.js status"
fi

# Seed config: copy default config files into store/ (idempotent: never overwrite)
SEED_CONFIG_DIR="$INSTALL_DIR/seed-config"
if [ -d "$SEED_CONFIG_DIR" ]; then
  for cfg in "$SEED_CONFIG_DIR"/*.json; do
    [ -f "$cfg" ] || continue
    cfg_name=$(basename "$cfg")
    target="$INSTALL_DIR/store/$cfg_name"
    if [ ! -f "$target" ]; then
      cp "$cfg" "$target"
      echo -e "  ${GREEN}✓${NC} Seed config: $cfg_name"
    fi
  done
fi

# Ollama + nomic-embed-text (szemantikus kereséshez) -- OPTIONAL.
#
# On a Mac without Homebrew (prerequisites met via MacPorts, so the
# prerequisites step never installs brew) `brew install ollama` fails and the
# `curl ... | sh` fallback ran. That script installed Ollama.app and the
# /usr/local/bin/ollama symlink, yet exited non-zero, and the ERR trap blamed
# the closing `fi`: "Unexpected error at line 1318". Same cure as the Whisper
# block below: do the work in a function called from an `|| rc=$?` list, and
# judge success by `command -v ollama` afterwards, not by the installer's rc.
echo ""
echo -e "$(_t macos.ollama_check)"

install_ollama() {
  if command -v ollama &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $(_t macos.ollama_installed)"
  else
    echo -e "  ${ORANGE}$(_t macos.ollama_installing)${NC}"
    if command -v brew &>/dev/null; then
      brew install ollama || true
    fi
    if ! command -v ollama &>/dev/null; then
      curl -fsSL https://ollama.com/install.sh | sh || true
    fi
    command -v ollama &>/dev/null || return 1
    echo -e "  ${GREEN}✓${NC} $(_t macos.ollama_installed)"
  fi

  # Start Ollama if not running
  if ! curl -s http://localhost:11434/api/version &>/dev/null; then
    echo -e "$(_t macos.ollama_starting)"
    ollama serve &>/dev/null &
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
      curl -s http://localhost:11434/api/version &>/dev/null && break
      sleep 1
    done
  fi

  # Pull nomic-embed-text model
  if ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
    echo -e "$(_t macos.nomic_downloading)"
    ollama pull nomic-embed-text || return 1
  fi
  return 0
}

OLLAMA_RC=0
install_ollama || OLLAMA_RC=$?

if [ "$OLLAMA_RC" -eq 0 ]; then
  echo -e "$(_t macos.ollama_done)"
else
  warn "$(_t macos.ollama_skipped)"
  echo -e "    ${DIM}$(_t macos.ollama_skipped_hint)${NC}"
fi

# Whisper (speech-to-text for video transcription) -- OPTIONAL.
#
# This block used to end the install. On an Intel Mac the operator saw only
# "Varatlan hiba a(z) 'configuration' lepesben (sor: 982)" -- 982 being the
# CLOSING `fi`, where nothing runs. Three defects, all fixed here:
#
#  1. macOS ships bash 3.2, where a command that fails inside a `{ ... }` group
#     on the RHS of `||` STILL reaches the ERR trap, and $LINENO blames the
#     enclosing `fi`. Same trap-vs-`fi` class as the `claude --print` probe and
#     the service-auth probe above; same cure: call the work through a function
#     in an `&& rc=0 || rc=$?` list, which keeps the failure out of the trap and
#     preserves the status. An OPTIONAL dependency must never abort the install.
#  2. `2>/dev/null` on every installer hid the reason. The real message here was
#     "pipx needs uv>=0.9.17, but ... reports 0.5.9" -- actionable, and never
#     shown. Let stderr through; it is captured in $INSTALL_ERRLOG too.
#  3. mlx-whisper is MLX-based, i.e. Apple Silicon ONLY. On Intel it can never
#     install, so the first attempt was guaranteed to fail there. Gate it on the
#     architecture and fall back to openai-whisper, which runs everywhere.
#
# The old fallback also printed "openai-whisper telepítve" unconditionally --
# after a `brew install` whose status it had just discarded. Each success line
# now follows the command that actually succeeded.
echo ""
echo -e "$(_t macos.whisper_installing)"

install_whisper() {
  if command -v mlx_whisper &>/dev/null || [ -f "$HOME/.local/bin/mlx_whisper" ]; then
    echo -e "  ${GREEN}✓${NC} $(_t macos.mlx_whisper_installed)"
    return 0
  fi

  if command -v whisper &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $(_t macos.whisper_installed)"
    return 0
  fi

  if ! command -v pipx &>/dev/null; then
    command -v brew &>/dev/null && brew install pipx
  fi

  if [ "$(uname -m)" = "arm64" ] && command -v pipx &>/dev/null; then
    if pipx install mlx-whisper; then
      echo -e "  ${GREEN}✓${NC} mlx-whisper telepítve"
      return 0
    fi
  fi

  if command -v pipx &>/dev/null; then
    if pipx install openai-whisper; then
      echo -e "  ${GREEN}✓${NC} openai-whisper telepítve (pipx)"
      return 0
    fi
  fi

  if command -v brew &>/dev/null; then
    if brew install openai-whisper; then
      echo -e "  ${GREEN}✓${NC} openai-whisper telepítve (brew)"
      return 0
    fi
  fi

  return 1
}

WHISPER_RC=0
install_whisper || WHISPER_RC=$?

if [ "$WHISPER_RC" -ne 0 ]; then
  warn "$(_t macos.whisper_skipped)"
  echo -e "    ${DIM}$(_t macos.whisper_skipped_hint)${NC}"
fi

# ffmpeg (audio/video processing). Without Homebrew an unguarded
# `brew install ffmpeg` was the next fatal stop after the Ollama block, so a
# missing brew (or a failed install) now warns instead of aborting.
if ! command -v ffmpeg &>/dev/null; then
  echo -e "$(_t macos.ffmpeg_installing)"
  if command -v brew &>/dev/null; then
    brew install ffmpeg || true
  fi
fi
if command -v ffmpeg &>/dev/null; then
  echo -e "$(_t macos.ffmpeg_done)"
else
  warn "$(_t macos.ffmpeg_skipped)"
  echo -e "    ${DIM}$(_t macos.ffmpeg_skipped_hint)${NC}"
fi

INSTALL_STEP="bumblebee"
# Go + bumblebee (supply-chain scanner)
echo ""
echo -e "  Go + bumblebee (supply-chain scanner)..."

_go_version_ok() {
  command -v go &>/dev/null || return 1
  local ver major minor
  ver=$(go version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)
  major=$(echo "$ver" | cut -d. -f1)
  minor=$(echo "$ver" | cut -d. -f2)
  [ "$major" -gt 1 ] || ( [ "$major" -eq 1 ] && [ "${minor:-0}" -ge 25 ] )
}

if _go_version_ok; then
  echo -e "  ${GREEN}✓${NC} $(go version | grep -oE 'go[0-9]+\.[0-9.]+')"
else
  echo -e "  ${ORANGE}!${NC} Go >= 1.25 szukseges -- telepites (brew install go)..."
  if command -v brew &>/dev/null; then
    # set -e + trap ERR van eletben: brew bukasa NE allitsa le a telepitest,
    # csak hagyja ki bumblebee-t (a _go_version_ok ujra-ellenoriz lentebb).
    if brew install go; then
      # Frissitjuk a PATH-ot az uj Go binary-re
      export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
    else
      echo -e "  ${ORANGE}!${NC} Go telepites sikertelen -- bumblebee kihagyva."
    fi
  else
    echo -e "  ${RED}✗${NC} Homebrew nem elerheto; bumblebee nem telepitheto automatikusan."
    echo -e "  ${DIM}  Kezzel: https://go.dev/dl (>= 1.25)${NC}"
  fi
fi

BUMBLEBEE_BIN="$HOME/.local/bin/bumblebee"
if [ -x "$BUMBLEBEE_BIN" ]; then
  echo -e "  ${GREEN}✓${NC} bumblebee mar telepitve ($BUMBLEBEE_BIN)"
elif _go_version_ok; then
  echo -e "  bumblebee build forrasbol (github.com/perplexityai/bumblebee)..."
  mkdir -p "$HOME/.local/bin"
  _BB_TMP=$(mktemp -d)
  if git clone -q --depth 1 --branch v0.1.2 https://github.com/perplexityai/bumblebee.git "$_BB_TMP" 2>/dev/null; then
    if (cd "$_BB_TMP" && go build -o "$BUMBLEBEE_BIN" ./cmd/bumblebee 2>/dev/null); then
      chmod +x "$BUMBLEBEE_BIN"
      echo -e "  ${GREEN}✓${NC} bumblebee telepitve: $BUMBLEBEE_BIN"
    else
      echo -e "  ${ORANGE}!${NC} bumblebee build sikertelen -- a supply-chain scan kihagyja a binart."
      echo -e "  ${DIM}  Kezzel: cd /tmp/bb && go build -o ~/.local/bin/bumblebee ./cmd/bumblebee${NC}"
    fi
  else
    echo -e "  ${ORANGE}!${NC} bumblebee clone sikertelen (halozat?) -- kihagyva."
  fi
  rm -rf "$_BB_TMP"
else
  echo -e "  ${ORANGE}!${NC} Go nem elerheto -- bumblebee kihagyva. A supply-chain scan atlepve."
  echo -e "  ${DIM}  Kezzel: brew install go && git clone https://github.com/perplexityai/bumblebee /tmp/bb && (cd /tmp/bb && go build -o ~/.local/bin/bumblebee ./cmd/bumblebee)${NC}"
fi

INSTALL_STEP="launchagent"
# Step 7: LaunchAgent setup
echo ""
echo -e "${BOLD}$(_t section_7)${NC}"

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"

# Pin launchd services to the SAME Node the native module was just compiled
# against (see resolve_service_node above, called from the npm-install step).
# The resolution used to live here, which is why the two disagreed.
resolve_service_node
# Launchd labels key off SERVICE_ID. SERVICE_ID == MAIN_AGENT_ID for a
# brand-unaware (default) install, so these labels are unchanged unless the
# operator picked a distinct brand above.
DASHBOARD_PLIST="com.${SERVICE_ID}.dashboard"
CHANNELS_PLIST="com.${SERVICE_ID}.channels"

# Dashboard service
# ISSUE2490 (b1): TERM and LANG exactly as the channels plist below. After a reboot either job can be the one that
# creates the tmux server (the dashboard's worker session often wins, agent-worker.ts), and the server's global
# environment is its creator's: without these the whole fleet ran in a server with no TERM and no LANG.
cat > "$PLIST_DIR/${DASHBOARD_PLIST}.plist" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DASHBOARD_PLIST}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${INSTALL_DIR}/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/store/dashboard.log</string>
  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/store/dashboard.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_BIN_DIR}:${HOME}/.local/bin:/opt/homebrew/bin:${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>TERM</key>
    <string>xterm-256color</string>
    <key>LANG</key>
    <string>${LANG:-en_US.UTF-8}</string>
  </dict>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>16384</integer>
  </dict>
  <key>HardResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>32768</integer>
  </dict>
</dict>
</plist>
PLISTEOF

# Channels service (Telegram bridge)
cat > "$PLIST_DIR/${CHANNELS_PLIST}.plist" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CHANNELS_PLIST}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/scripts/channels.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/store/channels.log</string>
  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/store/channels.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_BIN_DIR}:${HOME}/.local/bin:/opt/homebrew/bin:${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>USER</key>
    <string>${USER}</string>
    <key>TERM</key>
    <string>xterm-256color</string>
    <key>LANG</key>
    <string>${LANG:-en_US.UTF-8}</string>
  </dict>
</dict>
</plist>
PLISTEOF

echo -e "  ${GREEN}✓${NC} $(_t macos.launchagents_created)"

# Load AND START the LaunchAgents -- loading is not starting. The rationale and
# the measurements live in the shared helper, which scripts/start.sh uses too so
# both entry points behave identically.
. "$INSTALL_DIR/scripts/launchd-unit.sh"

# REMEDYCMD807: the remedy for a unit that is not running. A function because
# the closing summary repeats it word for word (#1871): whoever reads only the
# end of the run must get the same commands as the mid-run block.
print_services_remedy() {
  echo -e "    ${BOLD}Javítás most:${NC}"
  # kickstart alone cannot start a unit that was never REGISTERED in the gui
  # domain -- and that is exactly the state this fires in most often (an
  # SSH-driven install cannot bootstrap into gui/$UID; measured live, rc=5 EIO).
  # The remedy the user runs from a GUI terminal must be state-agnostic:
  # bootstrap first (registers + RunAtLoad-starts; errors harmlessly if already
  # registered), then kickstart (covers the registered-but-dead state).
  echo -e "    ${BLUE}launchctl bootstrap gui/$(id -u) \"\$HOME/Library/LaunchAgents/${DASHBOARD_PLIST}.plist\" 2>/dev/null; launchctl kickstart -p gui/$(id -u)/${DASHBOARD_PLIST}${NC}"
  echo -e "    ${BLUE}launchctl bootstrap gui/$(id -u) \"\$HOME/Library/LaunchAgents/${CHANNELS_PLIST}.plist\" 2>/dev/null; launchctl kickstart -p gui/$(id -u)/${CHANNELS_PLIST}${NC}"
  echo -e "    ${DIM}Ellenőrzés: launchctl print gui/$(id -u)/${CHANNELS_PLIST} | grep -E 'state|pid'${NC}"
}

# #1871: the outcome is kept, like INSTALL_AUTH_STATE / CHANNELS_GATE_STATE, so
# the closing banner and the exit status can tell the truth about it.
SERVICES_STATE="unknown"
DASHBOARD_PID="$(start_launchd_unit "$DASHBOARD_PLIST")"
CHANNELS_PID="$(start_launchd_unit "$CHANNELS_PLIST")"
if [ -n "$DASHBOARD_PID" ] && [ -n "$CHANNELS_PID" ]; then
  SERVICES_STATE="ok"
  echo -e "  ${GREEN}✓${NC} Szolgaltatasok elinditva (dashboard pid $DASHBOARD_PID, channels pid $CHANNELS_PID)"
else
  SERVICES_STATE="down"
  # "nem igazolt", not "nem indultak el": this branch fires when EITHER pid is
  # missing, so the plural claim was false whenever one unit came up. It also
  # says only what was measured -- the verification did not succeed -- instead of
  # asserting a consequence nobody checked.
  warn "A SZOLGALTATASOK INDULASA NEM IGAZOLT"
  # `if` rather than `[ ... ] && echo`: when the unit DID come up the test
  # returns 1, the && list returns 1, and the ERR trap would abort right here --
  # the very defect this block reports on.
  if [ -z "$DASHBOARD_PID" ]; then echo -e "    ${DIM}  - ${DASHBOARD_PLIST}: nem fut${NC}"; fi
  if [ -z "$CHANNELS_PID" ]; then echo -e "    ${DIM}  - ${CHANNELS_PLIST}: nem fut${NC}"; fi
  # Reassurance BEFORE the detail. Whoever is installing for the first time needs
  # three things from this screen, in this order: the install itself finished,
  # nothing is lost, and there is something to do about it.
  echo -e "    A telepites befejezodott. Ami nem indult el, azt fent latod, es a lentiekkel elindithatod."
  # The detail line states only the two things this code actually knows: it wrote
  # the plist files itself, and `launchctl print` reported no pid. It must NOT
  # claim the units were loaded: in start_launchd_unit the whole
  # bootstrap-or-load chain ends in `|| true`, and so does the kickstart, so no
  # return value is ever inspected. "Loaded but not started" was a diagnosis
  # nobody measured -- the same defect as the banner above it.
  echo -e "    ${DIM}A unit-fajlok a helyukon vannak, de futo folyamatot nem talaltunk.${NC}"
  print_services_remedy
fi

# ISSUE1891 (#1891): the three helper jobs below are verified by their own
# installers now (registered in gui/<uid> AND run once). One that is not running
# is collected here, warned about with its remedy, and repeated in the closing
# summary -- before #1891 each helper printed "Loaded" after a bare
# `launchctl load` and this file threw the output away, so on a Mac without a
# GUI login nothing ever said that the keep-alive probe was not running. The
# install's exit status is unchanged by a helper (the bot itself answers).
HELPERS_DOWN=""
note_helper_down() {
  HELPERS_DOWN="${HELPERS_DOWN}${HELPERS_DOWN:+ }$1"
  _nh_label="$("$INSTALL_DIR/scripts/$1.sh" --print-label 2>/dev/null | head -1)"
  echo -e "    ${DIM}Javitas (a GUI-bejelentkezes egy terminaljabol):${NC}"
  print_periodic_unit_remedy "$HOME/Library/LaunchAgents/${_nh_label}.plist" "$_nh_label"
}

# Idle-path keepalive probe (launchd twin of the Linux systemd timer). Without
# it the ONLY producer of store/.channel-keepalive freshness is organic inbound
# traffic, so a quiet night looks exactly like a wedged session: the file ages
# past the dashboard's 45-minute liveness ceiling and channel-monitor respawns a
# healthy main agent (its conversation lost), which kills the channel plugin,
# which trips the channels watchdog into a second restart. Measured on a live
# Linux install the night of 2026-09-12/13: 13 restarts, one every ~50 minutes.
# The probe never fakes liveness -- it proves the session, its claude pid and a
# descending poller are alive before touching the file -- so a genuinely dead
# channel still ages out and still gets recovered.
#
# The dedicated installer script already exists and is idempotent; --load starts
# it immediately. Non-fatal: a failed keepalive probe must not fail the install.
if [ -x "$INSTALL_DIR/scripts/install-channel-keepalive-probe.sh" ]; then
  if "$INSTALL_DIR/scripts/install-channel-keepalive-probe.sh" --load >/dev/null 2>&1; then
    ok "Keepalive-szonda telepitve (3 percenkent, hamis respawn ellen)"
  else
    warn "A keepalive-szonda NEM FUT (telepites vagy elso futas nem igazolt) -- nelkule a figyelo 45 perc csend utan ujrainditja az ep fo sessiont"
    note_helper_down install-channel-keepalive-probe
  fi
fi

# Stuck-modal guard, the launchd counterpart of the systemd unit template. A
# modal left open in the main session (a /mcp dialog after a full disk, the
# CLI's "Switch model?" after a /model -- measured 2026-10-05, half an hour of
# queued Telegram messages) blocks every inbound message, and on macOS nothing
# even noticed it. Installed in its default mode, log-only: detection and a
# log line; recovery stays opt-in (STUCK_MODAL_MODE=alert|act in .env, see
# docs/disk-modal-guards.md). Non-fatal, like the probe above.
if [ -x "$INSTALL_DIR/scripts/install-stuck-modal-guard.sh" ]; then
  if "$INSTALL_DIR/scripts/install-stuck-modal-guard.sh" --load >/dev/null 2>&1; then
    ok "Beragadt-ablak or telepitve (percenkent; alapbol csak naploz, beavatkozni a STUCK_MODAL_MODE=act kapcsoloval fog)"
  else
    warn "A beragadt-ablak or NEM FUT (telepites vagy elso futas nem igazolt)"
    note_helper_down install-stuck-modal-guard
  fi
fi

# Main-agent inbox observer, installed the same way and for the same reason: a
# probe nobody schedules is not a probe. Every delivery path except the main
# agent's queue is watched by something, and the one in-process reader of that
# queue lives inside the dashboard -- so when the dashboard is down or wedged,
# the watcher is down with it and mail to the main agent sits pending unseen.
# The observer runs from launchd instead, on its own 5-minute schedule, and
# alerts over the direct Bot API rather than /api/*, which dies with the same
# process. Idempotent, --load starts it at once, and non-fatal: a failed
# observer install must not fail the whole installation.
if [ -x "$INSTALL_DIR/scripts/install-main-inbox-observer.sh" ]; then
  if "$INSTALL_DIR/scripts/install-main-inbox-observer.sh" --load >/dev/null 2>&1; then
    ok "Fo-agens inbox-figyelo telepitve (5 percenkent, a dashboard folyamaton KIVUL)"
  else
    warn "Az inbox-figyelo NEM FUT (telepites vagy elso futas nem igazolt)"
    note_helper_down install-main-inbox-observer
  fi
fi

# Verify channel plugin is working
sleep 3
echo ""
echo -e "${BOLD}$(_t section_checks)${NC}"
if { [ "$CHANNEL_PROVIDER" = "telegram" ] || [ "$CHANNEL_PROVIDER" = "discord" ]; } && ! command -v bun &>/dev/null; then
  echo -e "  ${RED}✗${NC} Bun nem talalhato. A ${CHANNEL_PROVIDER} plugin nem fog mukodni."
  echo -e "  ${BOLD}Javitas:${NC} curl -fsSL https://bun.sh/install | bash"
  echo -e "  ${DIM}Utana: source ~/.zshrc && ./scripts/start.sh${NC}"
fi
PLUGIN_CHECK_PATTERN="${CHANNEL_PROVIDER}"
if [ "$CHANNEL_PROVIDER" = "gromzo" ]; then
  ok "Gromzo: a csatorna-plugint a Bridge Gromzo-lepese ellenorzi"
elif ! claude plugin list 2>/dev/null | grep -q "$PLUGIN_CHECK_PATTERN"; then
  echo -e "  ${RED}✗${NC} ${CHANNEL_PROVIDER} plugin nincs telepítve."
  echo -e "  ${BOLD}Javitas:${NC} claude plugin install ${PLUGIN_ID}"
  echo -e "  ${DIM}Utana: ./scripts/stop.sh && ./scripts/start.sh${NC}"
else
  echo -e "  ${GREEN}✓${NC} ${CHANNEL_PROVIDER} plugin ellenorizve"
fi

# Channel pairing flow (Telegram only; Slack uses OAuth / App install)
# INSTPAIRPATH930: the access.json the pairing must read AND write. channels.sh moves the
# shared $HOME/.claude/channels/<provider> dir into the install on its first start (#915,
# scripts/channels.sh MAIN_CHAN_DIR), and the plugin writes the pending code there, so the
# install-scoped file wins; the legacy path is only the fallback for a bridge that has not
# migrated yet. Resolved AFTER the code is typed in, when the bot has already answered.
_pairing_access_file() {
  local scoped="$INSTALL_DIR/.claude/channels/$CHANNEL_PROVIDER/access.json"
  if [ -f "$scoped" ]; then echo "$scoped"; else echo "$CHANNEL_DIR/access.json"; fi
}

if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ -n "$BOT_TOKEN" ]; then
  echo ""
  echo -e "${BOLD}$(_t macos.tg_pairing_title)${NC}"
  echo -e "${DIM}$(_t macos.tg_pairing_hint)${NC}"
  echo ""
  echo -e "  ${BOLD}1.${NC} Nyisd meg a Telegram appot es irj a botodnak (barmit, pl. \"Szia\")"
  echo -e "  ${BOLD}2.${NC} A bot kuld neked egy parosito kodot"
  echo -e "  ${BOLD}3.${NC} Masold ide a kapott kodot:"
  echo ""
  read -rp "$(_t prompt_pair_code)" PAIR_CODE
  if [ -n "$PAIR_CODE" ]; then
    ACCESS_FILE="$(_pairing_access_file)"
    if [ -f "$ACCESS_FILE" ]; then
      # Get the chat ID from the pending pairing in access.json
      PENDING_CHAT_ID=$(PAIR_CODE="$PAIR_CODE" python3 -c "
import json, os
with open('$ACCESS_FILE') as f:
    data = json.load(f)
code = os.environ['PAIR_CODE']
for c, info in data.get('pending', {}).items():
    if c == code:
        print(info.get('chatId', info.get('from', '')))
        break
" 2>/dev/null)

      if [ -n "$PENDING_CHAT_ID" ]; then
        # Approve the pairing and switch to allowlist
        PENDING_CHAT_ID="$PENDING_CHAT_ID" python3 -c "
import json, os
with open('$ACCESS_FILE') as f:
    data = json.load(f)
chat_id = os.environ['PENDING_CHAT_ID']
if chat_id not in data.get('allowFrom', []):
    data.setdefault('allowFrom', []).append(chat_id)
data['pending'] = {}
data['dmPolicy'] = 'allowlist'
with open('$ACCESS_FILE', 'w') as f:
    json.dump(data, f, indent=2)
" 2>/dev/null
        CHAT_ID="$PENDING_CHAT_ID"
        sed -i '' "s/^ALLOWED_CHAT_ID=.*/ALLOWED_CHAT_ID=${CHAT_ID}/" "$INSTALL_DIR/.env"
        ok "Parositas sikeres! (chat ID: $PENDING_CHAT_ID)"
        ok ".env ALLOWED_CHAT_ID frissitve"
        ok "Policy: allowlist (csak te erheted el a botot)"
      else
        # Fallback: try tmux send-keys approach
        echo -e "  ${ORANGE}A kod nem talalhato az access.json-ban.${NC}"
        echo -e "  ${DIM}Probald kesobb a terminalban: claude, majd /telegram:access pair $PAIR_CODE${NC}"
      fi
    else
      # INSTPAIRPATH930: a missing file used to skip the pairing in silence.
      warn "access.json nem talalhato: $ACCESS_FILE"
      echo -e "  ${DIM}Bizonyosodj meg rola, hogy a bot futott amikor uzeneteket kuldtel neki.${NC}"
    fi
  else
    echo -e "  ${DIM}$(_t macos.pairing_later)${NC}"
    echo -e "  ${DIM}Futtasd: claude, majd /telegram:access pair AKOD${NC}"
  fi
fi

# Migration from previous system
echo ""
echo -e "${BOLD}$(_t macos.migration_title)${NC}"
echo -e "${DIM}$(_t macos.migration_hint)${NC}"
read -rp "$(_t prompt_migrate)" DO_MIGRATE
DO_MIGRATE=${DO_MIGRATE:-n}
if [ "$DO_MIGRATE" = "i" ]; then
  if [ -f "$INSTALL_DIR/scripts/migrate.sh" ]; then
    "$INSTALL_DIR/scripts/migrate.sh"
  else
    echo -e "  ${ORANGE}$(_t macos.migrate_missing)${NC}"
  fi
fi

# Warn if Telegram pairing was skipped
if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ "$CHAT_ID" = "0" ]; then
  echo ""
  echo -e "${ORANGE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${RED}$(_t warn_pair_missing)${NC}"
  echo -e "${ORANGE}  Az ALLOWED_CHAT_ID=0 marad az .env-ben. A bot a beszelgetesre${NC}"
  echo -e "${ORANGE}  valaszolni FOG (azt a parositas donti el), de a MAGATOL kuldott${NC}"
  echo -e "${ORANGE}  uzenetek elmaradnak: napi naplo, uj agens udvozlese, riasztasok.${NC}"
  echo ""
  echo -e "  ${BOLD}Javitas:${NC}"
  echo -e "  1. Irj a botodnak Telegramon (barmit)"
  echo -e "  2. Masold a kapott parosito kodot"
  echo -e "  3. Futtasd: ${BOLD}claude${NC}, majd ${BOLD}/telegram:access pair AKOD${NC}"
  echo -e "${ORANGE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
fi

# Done!
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
# #1871: "successfully installed" only when the services were seen running.
if [ "${SERVICES_STATE:-unknown}" = "down" ]; then
  echo -e "${BOLD}${ORANGE}$(_t success_installed_services_down)${NC}"
else
  echo -e "${BOLD}${GREEN}$(_t success_installed)${NC}"
fi
echo ""

# Read dashboard token for access URL
DASH_TOKEN=""
if [ -f "$INSTALL_DIR/store/.dashboard-token" ]; then
  DASH_TOKEN=$(cat "$INSTALL_DIR/store/.dashboard-token")
fi
# INSTSTDERRTMP1104: the token URL only to a terminal, the same rule the server
# keeps (src/web.ts). Redirected (the Bridge, a CI log, `> file`), the line would
# leave a root-equivalent credential in whatever captured it.
if [ -n "$DASH_TOKEN" ] && [ -t 1 ]; then
  echo -e "  ${BOLD}Dashboard:${NC} ${BLUE}http://localhost:${WEB_PORT:-3420}/?token=${DASH_TOKEN}${NC}"
  echo -e "  ${DIM}$(_t dash.token_hint)${NC}"
elif [ -n "$DASH_TOKEN" ]; then
  _hint="$(_t dash.token_file_hint)"
  # An older install-lang.sh (standalone run) answers an unknown key with the key itself.
  [ "$_hint" = "dash.token_file_hint" ] && _hint="  (store/.dashboard-token)"
  echo -e "  ${BOLD}Dashboard:${NC} http://localhost:${WEB_PORT:-3420}"
  echo -e "  ${DIM}${_hint}${NC}"
else
  echo -e "  ${BOLD}Dashboard:${NC} http://localhost:${WEB_PORT:-3420}"
  echo -e "  ${DIM}$(_t dash.no_token_hint)${NC}"
fi
echo -e "  ${BOLD}Telegram:${NC} $(_t telegram.write_hint)"
if [ "${CHANNELS_GATE_STATE:-manual}" = "ok" ]; then
  echo -e "  ${GREEN}✓${NC} Org-szintu channel-kapu: channelsEnabled=true a managed-settings-ben"
else
  echo -e "  ${ORANGE}!${NC} Org-szintu channel-kapu NINCS beallitva (team/enterprise orgnal a bejovo uzenetek elakadnak)."
  # MACROOTFROMCLONE1106: the key itself, not a clone script to run as root.
  echo -e "    Kezi root-lepes: a ${BOLD}/Library/Application Support/ClaudeCode/managed-settings.json${NC} fajlba (rootkent szerkesztve) keruljon: ${BOLD}\"channelsEnabled\": true${NC}"
fi
echo ""
echo -e "  ${DIM}$(_t next_steps.title)${NC}"
echo -e "  ${DIM}$(_t next_steps.1)${NC}"
echo -e "  ${DIM}$(_t next_steps.2)${NC}"
echo -e "  ${DIM}$(_t next_steps.3)${NC}"
echo ""
echo -e "  ${DIM}Frissites: ./update.sh${NC}"
echo -e "  ${DIM}Leallitas: ./scripts/stop.sh${NC}"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# The auth verdict is repeated LAST: the closing "next steps" tell the user the
# bot will answer, which is false when the services have no working credential.
if [ "${INSTALL_AUTH_STATE:-UNKNOWN}" != "OK" ]; then
  echo ""
  if [ "${INSTALL_AUTH_STATE:-}" = "UNKNOWN" ]; then
    echo -e "  ${ORANGE}! FIGYELEM: az auth-ot nem sikerult ellenoriznunk.${NC}"
  else
    echo -e "  ${RED}✗ AZ UGYNOKOK MEG NEM FOGNAK VALASZOLNI: hianyzik a mukodo auth kulcs.${NC}"
  fi
  echo -e "  ${BOLD}  Javitas: ${BLUE}bash \"$INSTALL_DIR/scripts/auth.sh\"${NC}${BOLD} majd ${BLUE}bash \"$INSTALL_DIR/scripts/channels.sh\" restart${NC}"
  echo ""
fi

# ISSUE1891 (#1891): a helper job that is not running is repeated at the end as
# well, with its remedy, for whoever reads only the end of the run.
if [ -n "${HELPERS_DOWN:-}" ]; then
  echo ""
  echo -e "  ${ORANGE}! SEGED-JOBOK, AMELYEK NEM FUTNAK:${NC}"
  for _h in $HELPERS_DOWN; do
    _hl="$("$INSTALL_DIR/scripts/$_h.sh" --print-label 2>/dev/null | head -1)"
    echo -e "    ${DIM}  - ${_hl}: nem fut${NC}"
  done
  echo -e "    A launchd ezeket csak egy GUI-bejelentkezesen belul futtatja. Javitas, a GUI-bejelentkezes egy terminaljabol:"
  for _h in $HELPERS_DOWN; do
    _hl="$("$INSTALL_DIR/scripts/$_h.sh" --print-label 2>/dev/null | head -1)"
    print_periodic_unit_remedy "$HOME/Library/LaunchAgents/${_hl}.plist" "$_hl"
  done
fi

# #1871: the services' state is repeated LAST too, with the same remedy, and a
# run whose main units are not running does not exit 0 -- so a scripted install
# can tell (scripts/start.sh already exits 1 in the same situation). 3, not 1:
# 1 is what fail() and the ERR trap use for a build that aborted.
# EXCEPT in the machine progress mode (MARVEEN_JSON_PROGRESS=1, the Bridge
# installer): its derived script appends the final emit_result AFTER this line,
# so an exit here would turn a finished install into "the install stopped
# before finishing" on the customer's screen.
if [ "${SERVICES_STATE:-unknown}" = "down" ]; then
  echo ""
  echo -e "  ${RED}✗ A SZOLGÁLTATÁSOK NEM FUTNAK:${NC}"
  if [ -z "${DASHBOARD_PID:-}" ]; then echo -e "    ${DIM}  - ${DASHBOARD_PLIST}: nem fut${NC}"; fi
  if [ -z "${CHANNELS_PID:-}" ]; then echo -e "    ${DIM}  - ${CHANNELS_PLIST}: nem fut${NC}"; fi
  print_services_remedy
  echo ""
  if [ "${MARVEEN_JSON_PROGRESS:-0}" != "1" ]; then
    exit 3
  fi
fi
