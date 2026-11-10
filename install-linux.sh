#!/bin/bash
# Marveen - AI Team Setup
# Interactive installer for Linux (Ubuntu/Debian)

set -e
[ "${DEBUG:-0}" = "1" ] && set -x

# Ha a terminal tipusa ismeretlen (pl. xterm-ghostty), visszaesunk xterm-256color-ra
if ! tput longname &>/dev/null 2>&1; then
  export TERM=xterm-256color
fi

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
ORANGE='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

ok() { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${ORANGE}!${NC} $*"; }

INSTALL_STEP="init"

# ADMINPREREQTRUST1104 (Samu 69561): --admin-prereq runs as ROOT, so it may only run code that the
# non-admin user cannot write -- otherwise the user (or an agent running as it) edits a file and the
# next admin run executes it as root. This guard comes FIRST, before install-lang.sh is sourced:
#   - this script itself must be a root-owned regular file, not group/other-writable, in a dir chain
#     that only root can change (a sticky dir like /tmp counts as safe: others cannot swap root's file);
#   - an install-lang.sh next to it is held to the same rule, or not used;
#   - the gate and its writer are ALWAYS fetched fresh from the official source (never the checkout);
#   - MARVEEN_RAW_BASE is refused, MARVEEN_REF must be a plain ref name.
# The safe way to run it is printed by admin_prereq_cmd: download from the fixed URL into a fresh
# root-owned temp dir and run from there.
MARVEEN_OFFICIAL_RAW="https://raw.githubusercontent.com/Szotasz/marveen"
admin_prereq_cmd() { # $1 = the user Marveen will run as
  # MARVEEN_REF goes along: the fetched script then takes install-lang.sh and the gate from the SAME ref
  # (measured live: without it the script came from the branch and its texts from main, raw keys).
  echo "sudo bash -c 'd=\$(mktemp -d) && curl -fsSL ${MARVEEN_OFFICIAL_RAW}/${MARVEEN_REF:-main}/install-linux.sh -o \"\$d/install-linux.sh\" && MARVEEN_REF=${MARVEEN_REF:-main} bash \"\$d/install-linux.sh\" --admin-prereq --user ${1}'"
}
root_only_path() { # $1 = file; 0 = root-owned, not g/o-writable, and every parent dir likewise (or sticky)
  local p="$1" m
  [ -f "$p" ] && [ ! -L "$p" ] || return 1
  [ "$(stat -c '%u' "$p" 2>/dev/null)" = 0 ] || return 1
  m="$(stat -c '%a' "$p" 2>/dev/null)" || return 1
  [ $(( 8#$m & 8#022 )) -eq 0 ] || return 1
  p="$(dirname "$p")"
  while :; do
    [ "$(stat -c '%u' "$p" 2>/dev/null)" = 0 ] || return 1
    m="$(stat -c '%a' "$p" 2>/dev/null)" || return 1
    # group/other-writable is only safe with the sticky bit (/tmp): then nobody else can swap root's file
    if [ $(( 8#$m & 8#022 )) -ne 0 ] && [ $(( 8#$m & 8#1000 )) -eq 0 ]; then return 1; fi
    [ "$p" = / ] && break
    p="$(dirname "$p")"
  done
  return 0
}
__ADMIN_MODE=0
for __a in "$@"; do [ "$__a" = --admin-prereq ] && __ADMIN_MODE=1; done
if [ "$__ADMIN_MODE" = 1 ] && [ "$(id -u)" -eq 0 ]; then
  __self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  if [ -n "${MARVEEN_RAW_BASE:-}" ]; then
    echo "Hiba / Error: --admin-prereq does not accept MARVEEN_RAW_BASE (it runs as root; only the official source)." >&2
    exit 1
  fi
  case "${MARVEEN_REF:-main}" in
    *[!A-Za-z0-9._/-]*|-*|*..*) echo "Hiba / Error: --admin-prereq: invalid MARVEEN_REF." >&2; exit 1 ;;
  esac
  __who="${SUDO_USER:-<user>}"
  if ! root_only_path "$__self"; then
    echo "Hiba: az --admin-prereq rootként fut, de ezt a fájlt ($__self) egy nem-root felhasználó is módosíthatja. Innen nem futunk; futtasd a hivatalos forrásból:" >&2
    echo "Error: --admin-prereq runs as root, but this file ($__self) can be changed by a non-root user. Not running it; run it from the official source:" >&2
    echo "    $(admin_prereq_cmd "$__who")" >&2
    exit 1
  fi
  if [ -f "$(dirname "$__self")/install-lang.sh" ] && ! root_only_path "$(dirname "$__self")/install-lang.sh"; then
    echo "Hiba / Error: --admin-prereq: install-lang.sh next to this script is writable by a non-root user. Run it from the official source:" >&2
    echo "    $(admin_prereq_cmd "$__who")" >&2
    exit 1
  fi
fi

# shellcheck source=install-lang.sh
# MARVEENLANG1763: the README's one-liner (curl ... install-linux.sh -o install.sh &&
# bash install.sh) and the Windows/WSL wrapper (/tmp/marveen-install.sh) run this
# script ON ITS OWN, before the repo is cloned, so install-lang.sh is not next to it.
# Next to it (a checkout, the Bridge) -> sourced from there, exactly as before.
# Missing -> fetched from the same ref the repo is cloned from below (MARVEEN_REF,
# default main), checked (non-empty, defines _t), sourced from a mktemp file.
# Unreachable -> a plain bilingual stop with the manual way, before any install step.
MARVEEN_REF="${MARVEEN_REF:-main}"
if [ -f "$(dirname "$0")/install-lang.sh" ]; then
  source "$(dirname "$0")/install-lang.sh"
else
  _lang_url="${MARVEEN_RAW_BASE:-https://raw.githubusercontent.com/Szotasz/marveen}/${MARVEEN_REF}/install-lang.sh"
  _lang_tmp="$(mktemp "${TMPDIR:-/tmp}/marveen-install-lang.XXXXXX")"
  _lang_ok=0
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$_lang_url" -o "$_lang_tmp" 2>/dev/null && _lang_ok=1
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$_lang_tmp" "$_lang_url" 2>/dev/null && _lang_ok=1
  fi
  if [ "$_lang_ok" = "1" ] && [ -s "$_lang_tmp" ] && grep -q '^_t() {' "$_lang_tmp"; then
    source "$_lang_tmp"
    rm -f "$_lang_tmp"
  else
    rm -f "$_lang_tmp"
    echo "Hiba: a telepito nyelvi fajlja (install-lang.sh) nem toltheto le: $_lang_url" >&2
    echo "Error: the installer's language file (install-lang.sh) could not be downloaded: $_lang_url" >&2
    echo "  Kezzel / manually: git clone --branch ${MARVEEN_REF} https://github.com/Szotasz/marveen.git ~/marveen && bash ~/marveen/install-linux.sh" >&2
    exit 1
  fi
  unset _lang_url _lang_tmp _lang_ok
fi
# end of the install-lang loader (MARVEENLANG1763)

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

offer_claude_fallback() {
  local step="$1" err_msg="$2" line_info="${3:+:$3}"
  if ! command -v claude &>/dev/null; then
    return
  fi
  echo ""
  echo -e "${ORANGE}Claude Code elerheto a gepen.${NC}"
  local prompt="Marveen installer failed at step \"${step}\". Error: ${err_msg}. Script: install-linux.sh${line_info}. Repo: https://github.com/Szotasz/marveen. OS: $(lsb_release -ds 2>/dev/null || cat /etc/os-release 2>/dev/null | head -1 || echo Linux). Node: $(node -v 2>/dev/null || echo missing). Dir: ${INSTALL_DIR}. Your task: diagnose this Marveen installer failure. The install scripts are install.sh (macOS) and install-linux.sh. Read the relevant section, check for missing dependencies or permission issues, and suggest concrete shell commands to fix."
  if [ -t 0 ]; then
    read -rp "$(_t prompt_open_claude)" OPEN_CLAUDE
    OPEN_CLAUDE=${OPEN_CLAUDE:-n}
    if [[ "$OPEN_CLAUDE" == "i" || "$OPEN_CLAUDE" == "y" ]]; then
      # `claude` az inicialis promptot pozicionalis argumentumkent veszi.
      # A regi `--prompt` flag mar nem letezik (unknown option '--prompt').
      claude "$prompt"
      return
    fi
  fi
  echo -e "  ${DIM}Futtasd manualisan:${NC}"
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

# Does the INSTALL carry an auth credential the SERVICES can read?
#
# This is deliberately NOT `claude auth status`. That command answers a
# different question -- "can the operator's current shell talk to Claude?" --
# and the two answers diverge in the exact case that broke every affected
# install: the services (systemd units) read ONLY <install>/.env and
# <install>/store/.claude-oauth-token. They never see ~/.claude/.credentials.json,
# the macOS Keychain, or a CLAUDE_CODE_OAUTH_TOKEN exported from ~/.bashrc.
#
# Measured on a live host 2026-07-30, same host, same command:
#   non-interactive shell (how systemd starts a unit):  claude auth status -> FAILS
#   interactive shell     (how this installer runs):    claude auth status -> SUCCEEDS
# because a previous install had written `export CLAUDE_CODE_OAUTH_TOKEN=...`
# into ~/.bashrc. The installer therefore believed auth was done, skipped the
# token capture, and left the services with nothing.
service_auth_present() {
  grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' "$INSTALL_DIR/.env" 2>/dev/null && return 0
  [ -s "$INSTALL_DIR/store/.claude-oauth-token" ] && return 0
  return 1
}

# Ha a <marker> szoveg nem talalhato az rc fajlban, hozzaadja a <sort>.
# Mindket fajlt kezeli (.bashrc, .zshrc) ha leteznek.
# Hasznalat: ensure_in_rc "keres_minta" "hozzaadando sor"
ensure_in_rc() {
  local marker="$1" line="$2"
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -qF "$marker" "$rc" 2>/dev/null && continue
    printf '%s\n' "$line" >>"$rc"
    warn "RC frissitve ($(basename "$rc")): $line"
  done
}

# SECSZIVEK1007: secrets belong in the 0600 install files, not in shell
# startup files. The services never read an rc file: they use <install>/.env
# and <install>/store/.claude-oauth-token, both 0600 (see
# service_auth_present). A re-run removes the credential export lines from the
# rc files and says so. The rewrite keeps the rc file's inode and permissions
# (cat back, not mv), and `|| true` because grep -v exits 1 when every line is
# filtered out.
remove_secret_export_from_rc() {
  local var="$1" rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -Eq "^[[:space:]]*export[[:space:]]+${var}=" "$rc" 2>/dev/null || continue
    { grep -Ev "^[[:space:]]*export[[:space:]]+${var}=" "$rc" || true; } >"$rc.tmp" \
      && cat "$rc.tmp" >"$rc" && rm -f "$rc.tmp"
    warn "$(basename "$rc"): a korabbi ${var} export-sor torolve (titok nem kerul shell rc fajlba)"
  done
}

# Interactive convenience without the secret in the rc: one line that READS the
# value from a 0600 install file at shell start, and exports it only when it is
# there. The file path is single-quoted for the shell ('\'' for a quote in it).
# Usage: ensure_secret_reader_in_rc VAR FILE KIND   (KIND: file = whole file, env = VAR= line of a .env)
ensure_secret_reader_in_rc() {
  local var="$1" file="$2" kind="$3" q marker line
  q="'$(printf '%s' "$file" | sed "s/'/'\\\\''/g")'"
  marker="# marveen: ${var} from the install's 0600 file"
  if [ "$kind" = "env" ]; then
    line="${marker}"$'\n'"_mv=\"\$(grep -m1 '^${var}=' ${q} 2>/dev/null | cut -d= -f2-)\"; [ -n \"\$_mv\" ] && export ${var}=\"\$_mv\"; unset _mv"
  else
    line="${marker}"$'\n'"[ -s ${q} ] && export ${var}=\"\$(cat ${q})\""
  fi
  ensure_in_rc "$marker" "$line"
}

# SECSZIVEKKIADAS1008: the same scrub for an install that already carries auth
# (a re-run never reaches the prompt above). scripts/lib/rc-secrets.sh holds
# the identical copy update.sh uses; update-rc-secret-scrub.test.ts keeps them equal.
rc_has_secret_export() {
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -Eq "^[[:space:]]*export[[:space:]]+${1}=" "$rc" 2>/dev/null && return 0
  done
  return 1
}

scrub_secret_exports_from_rc() {
  if rc_has_secret_export ANTHROPIC_API_KEY; then
    remove_secret_export_from_rc ANTHROPIC_API_KEY
    ensure_secret_reader_in_rc ANTHROPIC_API_KEY "$INSTALL_DIR/.env" env
  fi
  if rc_has_secret_export CLAUDE_CODE_OAUTH_TOKEN; then
    remove_secret_export_from_rc CLAUDE_CODE_OAUTH_TOKEN
    ensure_secret_reader_in_rc CLAUDE_CODE_OAUTH_TOKEN "$INSTALL_DIR/store/.claude-oauth-token" file
  fi
  return 0
}

# Tobbsoros blokkot ad az rc fajlokhoz ha a <marker> meg nem szerepel bennuk.
# Hasznalat: ensure_block_in_rc "marker" "$BLOKK_VALTOZO"
ensure_block_in_rc() {
  local marker="$1" block="$2"
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -qF "$marker" "$rc" 2>/dev/null && continue
    printf '\n%s\n' "$block" >>"$rc"
    warn "RC blokk hozzaadva ($(basename "$rc")): $marker"
  done
}

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
    --admin-prereq)
      ADMIN_PREREQ=1; shift ;;
    --user)
      if [[ -z "${2:-}" || "${2}" == --* ]]; then
        echo "Error: --user requires a user name (with --admin-prereq: the user Marveen will run as)" >&2; exit 1
      fi
      ADMIN_USER="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--port <N>] [--admin-prereq [--user <name>]]"
      echo "  --port <N>       Dashboard port (default: 3420). Also settable via WEB_PORT env var."
      echo "  --admin-prereq   Run as root (sudo) by an administrator: installs ONLY the machine-level"
      echo "                   prerequisites (packages, Node.js >= 20, the managed-settings channel gate)"
      echo "                   so a user without sudo can then run this installer. No clone, no dashboard,"
      echo "                   no services. Safe to run again."
      echo "  --user <name>    With --admin-prereq: the user Marveen will run as. Its user services"
      echo "                   are allowed to keep running (loginctl linger), which only root can set."
      exit 0 ;;
    *) echo "Unknown option: $1 (use --help for usage)" >&2; exit 1 ;;
  esac
done
WEB_PORT="${WEB_PORT:-3420}"
# LINUXINSTPREREQ1104: --admin-prereq is the root half of a non-admin install. Without root
# it stops here, before any step, with the exact command.
ADMIN_PREREQ="${ADMIN_PREREQ:-0}"

# EE2392D3 (measured 2026-11-10 on a throwaway Ubuntu 24.04): run as root from `sudo -i` or `sudo bash`, Claude Code's
# official installer refuses ("do not run this installer with sudo", it reads SUDO_USER) and this install stopped at
# [2/7] after three tries. Its refusal is not worked around (Samu 75472, Marveen 75473): the install stops here, at
# once, and names the two ways that work. A direct root login (the Bridge's SSH) has no SUDO_USER and goes on;
# --admin-prereq is run with sudo on purpose (admin_prereq_cmd) and is exempt.
if [ "$ADMIN_PREREQ" != 1 ] && [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  echo "Hiba: ne sudo -i vagy sudo bash alól futtasd a telepítőt. Lépj be közvetlenül rootként (root-SSH), vagy futtasd a saját felhasználóddal (sudo-joggal)." >&2
  echo "Error: do not run the installer from sudo -i or sudo bash. Log in as root directly (root SSH), or run it as your own user (with sudo rights)." >&2
  exit 1
fi
ADMIN_USER="${ADMIN_USER:-}"
if [ -n "$ADMIN_USER" ] && [ "$ADMIN_PREREQ" != 1 ]; then
  echo -e "${RED}$(_t linux.adminprereq_user_needs_flag)${NC}" >&2; exit 1
fi
if [ "$ADMIN_PREREQ" = 1 ] && [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}$(_t linux.adminprereq_need_root)${NC}" >&2
  echo "    $(admin_prereq_cmd "${ADMIN_USER:-$(id -un)}")" >&2
  exit 1
fi
if [ -n "$ADMIN_USER" ] && ! id "$ADMIN_USER" >/dev/null 2>&1; then
  echo -e "${RED}$(_t linux.adminprereq_user_unknown) ${ADMIN_USER}${NC}" >&2; exit 1
fi

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
echo -e "${DIM}  Telepito wizard - Linux (Ubuntu/Debian)${NC}"
echo ""

# ── WSLMNT1 vedohalo: /mnt/ ala klonozott repo ──────────────────────
# WSL-ben a terminal gyakran a Windows-mappaban (/mnt/c/...) nyilik, es az
# oda klonozott repon a git/npm chmod-muveletei "Operation not permitted"
# hibakkal halnak (drvfs nem POSIX). A leggyakoribb elakadas MEG a klonnal
# tortenik (a script el sem indul -- azt a README `cd ~`-ja fedi); ez a
# check a MASODIK esetet fogja: a klon valahogy letrejott /mnt/ alatt, es
# a telepito onnan indult. Ertheto mondat + masolhato kiut, sorszam helyett.
case "$INSTALL_DIR" in
  /mnt/*)
    echo -e "${RED}A telepito a Windows-fajlrendszerrol fut (${INSTALL_DIR}).${NC}"
    echo -e "  A /mnt/ alatti mappakon a git es az npm jogosultsag-muveletei nem mukodnek (WSL/drvfs) -- a telepites itt elhalna."
    echo -e "  ${DIM}Kiut: klonozd a Linux home-ba, es onnan futtasd (masold az alabbi sorokat):${NC}"
    echo "    cd ~"
    echo "    git clone --branch main https://github.com/Szotasz/marveen.git"
    echo "    cd marveen && ./install.sh"
    exit 1
    ;;
esac

# WSL detection, used by the auth prompt and the service launch below.
IS_WSL=false
if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  IS_WSL=true
fi

INSTALL_STEP="prerequisites"
# ─────────────────────────────────────────────
# [1/7] Elofeltetelek
# ─────────────────────────────────────────────
echo -e "${BOLD}$(_t section_1)${NC}"

# Csomagkezelo detektalas: apt-get (Debian/Ubuntu) vagy dnf (Fedora/Nobara/RHEL).
# A kesobbi telepito agak PKG_MANAGER alapjan valasztanak parancsot es csomagnevet.
PKG_MANAGER=""
if command -v apt-get &>/dev/null; then
  PKG_MANAGER="apt"
elif command -v dnf &>/dev/null; then
  PKG_MANAGER="dnf"
elif command -v yum &>/dev/null; then
  PKG_MANAGER="yum"
fi
if [ -z "$PKG_MANAGER" ]; then
  fail "Nem tamogatott csomagkezelo. Ez a telepito apt-get (Debian/Ubuntu) vagy dnf/yum (Fedora/Nobara/RHEL) rendszert var."
fi

# ── apt lock kezeles (APTLOCK1) ──────────────────────────────────────
# Friss Ubuntun/WSL-en az apt-daily / unattended-upgrades az elso percekben
# MAGATOL elindul es fogja a dpkg zarolast, majd perceken belul elengedi. Ez
# ATMENETI allapot: a helyes viselkedes a lathato varakozas, nem a hibauzenet
# (2026-07-30, workshop: "Could not get lock /var/lib/dpkg/lock-frontend...
# It is held by process 6250" -> "Varatlan hiba... (sor: 240)"). A harom
# allapotot szethuzzuk: atmeneti (var), vegleges (lejart cap, nevesitett
# holderrel), ismeretlen (nincs fuser -- kimondjuk, es a DPkg::Lock::Timeout
# vedohalora hagyatkozunk).
APT_LOCK_FILES="/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock"
APT_LOCK_WAIT_CAP=300   # 5 perc -- az apt-daily ennyi alatt tipikusan vegez
# Vedohalo minden apt-get hivasra: az apt sajat, fcntl-szintu varakozasa arra
# az esetre, ha a pre-flight utan, de a parancs elott ugrik be egy uj holder.
APT_OPTS="-o DPkg::Lock::Timeout=180"

# ── interaktiv dialogusok kizarasa (APTPROMPT802) ────────────────────
# 2026-08-02, eles gepen merve: az elso VALODI elso-telepitesnel a
#   sudo apt-get install -y nodejs
# elakadt egy whiptail ablakon ("Pending kernel upgrade"), amit a needrestart
# apt-hookja nyitott (apt-pinvoke -m u). A telepito a Marveen appbol fut, ahol
# nincs terminal es nincs stdin -- a dialogus tehat nem elnyomhato, a telepites
# ott all, amig valaki kezzel ki nem lovi. A naplo elso jele: "dpkg-preconfigure:
# unable to re-open stdin". Eddig azert nem jott elo, mert a teszt-gepeken a node
# mar fent volt a korabbi korokbol, es ez a lepes kimaradt.
#
# HAROM retegben zarjuk ki, mert egy reteg sem eleg onmagaban:
#   1. DEBIAN_FRONTEND=noninteractive -- a debconf keresek ellen.
#   2. NEEDRESTART_SUSPEND=1 (+ NEEDRESTART_MODE=l tartalek) -- a needrestart
#      apt-hookja ellen; ez az, ami a konkret gepet megfogta, es amit a frontend
#      NEM fed.
#
#      MIERT "l" ES NEM "a", holott az "a" is elnemitja a kerdest (merve az eles
#      gepen, needrestart 3.11 / Ubuntu 26.04, 2026-08-02):
#        - /usr/lib/needrestart/apt-pinvoke 43-46. sor: ha NEEDRESTART_SUSPEND
#          nem ures, kiir egy sort es `exit 0` -- az `exec needrestart` CSAK
#          ezutan, az 49. sorban jon. Tehat SUSPEND mellett a needrestart EL SEM
#          INDUL: sem dialogus, sem ujrainditas. A MODE azon az uton sosem jut
#          ervenyre.
#        - A MODE tehat TARTALEK: azokra a (regebbi) verziokra, amelyek hookja
#          esetleg nem nezi a SUSPEND-et. Es ha a tartalek lep ervenybe, akkor
#          szamit, MELYIK erteket adtuk: a needrestart -r modjai l = list only,
#          i = interactive, a = automatically restart.
#        - Az "a" tehat ujrainditana a varakozo szolgaltatasokat A TELEPITES
#          KOZBEN. A cel-gepen ez negy szolgaltatast jelentett (dbus,
#          networkd-dispatcher, serial-getty@ttyS0, systemd-logind), es a
#          telepito KESOBB epit a felhasznaloi session-buszra (XDG_RUNTIME_DIR /
#          DBUS_SESSION_BUS_ADDRESS), majd meg kesobb user-unitokat allit be. Egy
#          dbus/logind restart a csomag-lepesben tehat egy MASIK, kesobbi lepest
#          buktathatna el -- olyan hibat, ami semmivel nem utal vissza az aptra.
#        - Az "l" ugyanugy nem kerdez, de nem is indit ujra semmit: a fuggo
#          szolgaltatasok a kovetkezo rebootig a regi konyvtarakkal futnak, ami
#          egy friss telepitesnel rendben van.
#      NE ALLITSD VISSZA "a"-ra azzal, hogy "az alaposabb" -- itt epp az a
#      kockazat, hogy a tartalek TOBBET csinal, mint amit kertunk tole.
#   3. </dev/null minden hivason -- ha egy hook megis kerdez, azonnal EOF-ot kap
#      a helyett, hogy a telepito sajat stdinjere varna.
#
# MIERT INLINE ATADAS ES NEM CSAK export: a sudo alapertelmezesben env_reset-tel
# fut, tehat az exportalt valtozo NEM jut at. Debian 13-on megmerve:
#   export DEBIAN_FRONTEND=... ; sudo printenv DEBIAN_FRONTEND -> URES
#   sudo DEBIAN_FRONTEND=... printenv DEBIAN_FRONTEND        -> noninteractive
#   sudo -E printenv DEBIAN_FRONTEND                          -> noninteractive
# Ezert a sudo-s hivasoknal a valtozok a parancs ele kerulnek, es az export CSAK
# a `sudo -E`-vel indulo gyerekek (nodesource setup-script) miatt marad meg.
NONINTERACTIVE_ENV="DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1
# A meglevo config-fajlokat megtartjuk, ujat nem kerdezunk: a "melyik verziot
# tartsam meg?" dpkg-prompt ugyanugy megallitana a telepitest, mint a needrestart.
DPKG_KEEP_CONF="-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef"

# MINDEN apt-get hivas ezen a fuggvenyen megy at. Egy hely, ahol a fenti harom
# reteg egyutt van -- egy uj hivas hozzaadasakor nem lehet elfelejteni az
# egyiket, es a teszt ezt a fuggvenyt futtatja, nem a leirasat.
apt_run() {
  # shellcheck disable=SC2086
  sudo $NONINTERACTIVE_ENV apt-get $APT_OPTS $DPKG_KEEP_CONF "$@" </dev/null
}

# dnf/yum: a -y a csomag- es GPG-kulcs-kerdeseket is elfogadja, needrestart ott
# nincs; a stdin-lezaras viszont ugyanugy kell, es a valtozok atadasa artalmatlan.
pkg_install_noninteractive() {
  # shellcheck disable=SC2086
  sudo $NONINTERACTIVE_ENV "$PKG_MANAGER" install -y "$@" </dev/null
}

# stdout: "<pid> <procnev>" ha valaki fogja barmelyik lockot; ures + exit 1 ha
# szabad. fuser nelkul exit 2 = NEM TUDJUK megallapitani (ismeretlen allapot).
apt_lock_holder() {
  command -v fuser &>/dev/null || return 2
  local l pid name
  for l in $APT_LOCK_FILES; do
    [ -e "$l" ] || continue
    pid=$(sudo fuser "$l" 2>/dev/null | tr -s ' ' '\n' | grep -m1 '[0-9]' || true)
    if [ -n "$pid" ]; then
      name=$(ps -o comm= -p "$pid" 2>/dev/null || true)
      echo "$pid ${name:-?}"
      return 0
    fi
  done
  return 1
}

# A ket ertekadas alatt SZANDEKOSAN `&& rc=0 || rc=$?` all, nem `; rc=$?`.
# A szkript `set -e` alatt fut (5. sor), es egy ertekadas kilepesi kodja a
# parancs-behelyettesitese -- tehat `holder=$(apt_lock_holder); rc=$?` eseten a
# shell MAR AZON A SORON kilep, ha a fuggveny nem nullat ad. Az pedig pontosan
# akkor ad nem nullat, amikor NINCS zar (return 1) vagy nincs fuser (return 2),
# vagyis a haromallapotu logika alatta SOSEM futott le: az egyetlen tulelo ag az
# volt, amikor tenyleg fogta valaki a lockot. A zar-figyelo igy a NYUGODT gepen
# olte meg a telepitest, es a lock-versenyes gepen engedte at -- ezert ment at a
# 07-30-i workshopon es bukott egy friss VPS-en 08-02-an.
wait_for_apt_lock() {
  local holder rc waited=0 interval=5
  holder=$(apt_lock_holder) && rc=0 || rc=$?
  if [ "$rc" -eq 2 ]; then
    # fuser nincs (minimal image) -- nem tudjuk MEGNEZNI, ki fogja a lockot.
    # Ezt kimondjuk, es az APT_OPTS timeout-ja kezeli, ha tenyleg fogott.
    echo -e "  ${DIM}$(_t linux.apt_lock_unknown)${NC}"
    return 0
  fi
  [ "$rc" -ne 0 ] && return 0   # szabad
  warn "$(_t linux.apt_lock_waiting_prefix) ${holder}"
  echo -e "  ${DIM}$(_t linux.apt_lock_transient_hint)${NC}"
  while [ "$waited" -lt "$APT_LOCK_WAIT_CAP" ]; do
    sleep "$interval"; waited=$((waited + interval))
    holder=$(apt_lock_holder) && rc=0 || rc=$?
    if [ "$rc" -ne 0 ]; then
      ok "$(_t linux.apt_lock_freed_prefix) ${waited}s"
      return 0
    fi
    if [ $((waited % 30)) -eq 0 ]; then
      echo -e "  ${DIM}$(_t linux.apt_lock_still_prefix) ${holder} -- ${waited}s / ${APT_LOCK_WAIT_CAP}s${NC}"
    fi
  done
  # Lejart a cap: ez mar nem "varjunk meg egy kicsit" -- nevesitett holderrel
  # es kiuttal allunk meg, nem sorszammal.
  echo -e "${RED}$(_t linux.apt_lock_timeout_head) ${holder}${NC}"
  echo -e "  $(_t linux.apt_lock_timeout_body1)"
  echo -e "  $(_t linux.apt_lock_timeout_body2)"
  fail "$(_t linux.apt_lock_timeout_fail)"
}

# RAM check: npm build can fail on low-memory instances (e.g. t3.micro)
if command -v free &>/dev/null; then
  TOTAL_RAM_MB=$(free -m | awk '/^Mem:/ {print $2}')
  TOTAL_SWAP_MB=$(free -m | awk '/^Swap:/ {print $2}')
  TOTAL_AVAIL=$((TOTAL_RAM_MB + TOTAL_SWAP_MB))
  if [ "$TOTAL_AVAIL" -lt 2048 ]; then
    warn "$(_t linux.low_ram_prefix) ${TOTAL_RAM_MB} MB RAM + ${TOTAL_SWAP_MB} MB swap = ${TOTAL_AVAIL} MB"
    echo -e "  ${ORANGE}Az npm build legalabb 2 GB memoriat igenyel.${NC}"
    if [ "$TOTAL_SWAP_MB" -lt 1024 ]; then
      read -rp "$(_t prompt_swap)" CREATE_SWAP
      CREATE_SWAP=${CREATE_SWAP:-i}
      if [ "$CREATE_SWAP" = "i" ]; then
        echo -e "  Swap letrehozasa (sudo szukseges)..."
        sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
        if swapon --show | grep -q '/swapfile'; then
          ok "2 GB swap aktivalva"
          if ! grep -q '/swapfile' /etc/fstab; then
            echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
            ok "Swap hozzaadva az /etc/fstab-hoz (ujrainditas utan is megmarad)"
          fi
        else
          warn "Swap letrehozas sikertelen. A build elbukthat."
        fi
      else
        warn "Swap kihagyva. Ha a build elbukik, futtasd: sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
      fi
    fi
  else
    ok "Memoria: ${TOTAL_RAM_MB} MB RAM + ${TOTAL_SWAP_MB} MB swap"
  fi
fi

MISSING_PKGS=""
for pkg in ffmpeg git tmux lsof curl python3 pipx unzip zstd; do
  if ! command -v "$pkg" &>/dev/null; then
    MISSING_PKGS="$MISSING_PKGS $pkg"
  fi
done

# C/C++ toolchain a native npm modulok forditasahoz. A better-sqlite3 elobb egy
# prebuilt binarist probal letolteni (prebuild-install); ha az nem elerheto vagy
# a letoltes idotullepes miatt elbukik, node-gyp-pel forditja forrasbol, amihez
# make + gcc/g++ kell. A csomagnev a 'command -v' nevtol elter, ezert kulon
# ellenorizzuk (make/cc), es managerenkent a megfelelo csomagot adjuk hozza
# (apt: build-essential -- make/gcc/g++; dnf: make gcc gcc-c++).
if ! command -v make &>/dev/null || ! command -v cc &>/dev/null; then
  if [ "$PKG_MANAGER" = "apt" ]; then
    MISSING_PKGS="$MISSING_PKGS build-essential"
  else
    MISSING_PKGS="$MISSING_PKGS make gcc gcc-c++"
  fi
fi

# Node.js v20+ ellenorzes
# LINUXINSTPREREQ1104: the >= 20 rule is checked BEFORE and AFTER the package step,
# through one function. Before this, it was checked only before: when nodesource
# failed, the distro nodejs went in (Ubuntu 24.04: 18.19, measured on the probe
# VPS) and only `command -v node` ran afterwards, so the install went on with a
# Node it does not support and broke later with an unrelated-looking error.
node_major() {
  command -v node &>/dev/null || { echo 0; return 0; }
  node -e 'process.stdout.write(process.version.slice(1).split(".")[0])' 2>/dev/null || echo 0
}
# The major version of apt's nodejs candidate, 0 when there is none or it is
# unreadable ("1:18.19.1+dfsg-6ubuntu5" -> 18, "(none)" -> 0).
apt_nodejs_candidate_major() {
  local c=""
  c=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ {print $2; exit}') || c=""
  c="${c#*:}"
  c="${c%%[!0-9]*}"
  echo "${c:-0}"
}
NODE_FIX_APT='curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs'
NODE_OK=false
NODE_VER=$(node_major)
[ "$NODE_VER" -ge 20 ] && NODE_OK=true
$NODE_OK || MISSING_PKGS="$MISSING_PKGS nodejs"

# LINUXINSTPREREQ1104: the non-admin pre-check. A user who is not root, cannot sudo without a
# password and is in none of the admin groups would stop at the package step with a bare
# "sudo: a password is required". Instead: the missing root steps, measured with the SAME
# code the package step uses (MISSING_PKGS, node_major), and the one-line admin command,
# before anything is installed. A member of sudo/admin/wheel keeps the old path unchanged.
admin_group_member() { id -nG 2>/dev/null | tr ' ' '\n' | grep -qxE 'sudo|admin|wheel'; }
channels_gate_state() { # ok | missing | unknown -- the same test as ensure-managed-channels-enabled.sh
  command -v python3 >/dev/null 2>&1 || { echo unknown; return 0; }
  if python3 - /etc/claude-code/managed-settings.json 2>/dev/null <<'PY'
import json, sys
try:
    sys.exit(0 if json.load(open(sys.argv[1])).get("channelsEnabled") is True else 1)
except Exception:
    sys.exit(1)
PY
  then echo ok; else echo missing; fi
}
# Linger: a non-admin user's services stop with its session unless root allows them to stay
# (measured on the probe VPS: install rc 0, then the dashboard was gone). na = no loginctl (no systemd).
# "na" also when systemd is not the running init (a container, WSL without systemd): loginctl may be
# installed there, but linger cannot be set and [7/7] starts the services with nohup anyway.
# /run/systemd/system is systemd's own "booted with systemd" test (sd_booted).
LINGER_SYSTEMD_DIR="${LINGER_SYSTEMD_DIR:-/run/systemd/system}"
linger_state() {
  command -v loginctl >/dev/null 2>&1 && [ -d "$LINGER_SYSTEMD_DIR" ] || { echo na; return 0; }
  if loginctl show-user "$(id -un)" 2>/dev/null | grep -q '^Linger=yes'; then echo yes; else echo no; fi
}
if [ "$ADMIN_PREREQ" != 1 ] && [ "$(id -u)" -ne 0 ] && ! admin_group_member && ! sudo -n true 2>/dev/null; then
  GATE_STATE="$(channels_gate_state)"
  LINGER_STATE="$(linger_state)"
  ADMIN_CMD="$(admin_prereq_cmd "$(id -un)")"
  if [ -n "$MISSING_PKGS" ] || [ "$LINGER_STATE" = no ]; then
    echo -e "${RED}$(_t linux.nonadmin_head)${NC}"
    [ -n "$MISSING_PKGS" ] && echo -e "  - $(_t linux.nonadmin_pkgs)${MISSING_PKGS}"
    if [ "$NODE_VER" -eq 0 ]; then echo -e "  - $(_t linux.nonadmin_node_missing)"
    elif [ "$NODE_VER" -lt 20 ]; then echo -e "  - $(_t linux.nonadmin_node) ${NODE_VER}"; fi
    [ "$LINGER_STATE" = no ] && echo -e "  - $(_t linux.nonadmin_linger)"
    echo -e "  - $(_t "linux.nonadmin_gate_${GATE_STATE}")"
    echo -e "  $(_t linux.nonadmin_cmd_lead)"
    echo "      $ADMIN_CMD"
    echo -e "  ${DIM}$(_t linux.nonadmin_sudo_hint)${NC}"
    echo -e "  ${DIM}$(_t linux.nonadmin_skips)${NC}"
    exit 1
  fi
  if [ "$GATE_STATE" != ok ]; then
    warn "$(_t "linux.nonadmin_gate_${GATE_STATE}")"
    echo -e "  ${DIM}$(_t linux.nonadmin_cmd_lead) ${ADMIN_CMD}${NC}"
  fi
  # A stated limit (Samu 69465): the non-admin path is not a product path yet (the owner's
  # user-model decision); these two need root and are left out, so say it before they are missed.
  warn "$(_t linux.nonadmin_skips)"
fi
ADMIN_INSTALLED="$MISSING_PKGS"

if [ -n "$MISSING_PKGS" ]; then
  warn "Hianyzo csomagok:$MISSING_PKGS"
  echo -e "  Telepites sudo-val ($PKG_MANAGER)..."
  if [ "$PKG_MANAGER" = "apt" ]; then
    wait_for_apt_lock
    if echo "$MISSING_PKGS" | grep -q nodejs; then
      # A nodesource setup-script curl-t igenyel, de csupasz VPS-en (Debian
      # netinst) a curl maga is hianyozhat -- ilyenkor eloszor azt telepitjuk,
      # kulonben a repo-lepes neman kimarad, a disztro sajat (regebbi) nodejs-e
      # telepul, es Debianon az npm (kulon csomag) le se jon -> [1/7] fail.
      if ! command -v curl &>/dev/null; then
        apt_run update -qq || true
        apt_run install -y curl -qq || true
        hash -r
      fi
      echo -e "  Node.js v22 repo hozzaadasa (nodesource)..."
      # A setup-scriptet valtozoba toltjuk es a curl exit-kodjat kulon nezzuk:
      # a 'curl | sudo bash -' pipeline exit-kodja a bash-e lenne (ures stdin-en
      # 0), igy a curl-hiba nem latszana es a fallback sosem aktivalodna.
      NODESOURCE_OK=false
      if command -v curl &>/dev/null; then
        NODESOURCE_SETUP="$(curl -fsSL https://deb.nodesource.com/setup_22.x 2>/dev/null || true)"
        if [ -n "$NODESOURCE_SETUP" ] && echo "$NODESOURCE_SETUP" | sudo -E $NONINTERACTIVE_ENV bash - >/dev/null 2>&1; then
          NODESOURCE_OK=true # a nodesource nodejs csomag node+npm-et egyben hozza
        fi
      fi
      if [ "$NODESOURCE_OK" = false ]; then
        # Fallback: disztro sajat nodejs-e. Debianon az npm kulon csomag,
        # a nodesource-bundle-lel ellentetben nem jon a nodejs-sel magatol.
        apt_run update -qq
        # LINUXINSTPREREQ1104: only a candidate that meets the rule goes in. An
        # older one would only leave an unsupported Node on the machine.
        NODE_CAND=$(apt_nodejs_candidate_major)
        if [ "$NODE_CAND" -ge 20 ]; then
          warn "nodesource repo hozzaadasa sikertelen -- a disztro sajat nodejs (v${NODE_CAND}) + npm csomagjat telepitem."
          MISSING_PKGS="$MISSING_PKGS npm"
        else
          fail "$(_t linux.node_distro_too_old) ${NODE_CAND}.
    $(_t linux.node_fix_lead)
      ${NODE_FIX_APT}"
        fi
      fi
    else
      apt_run update -qq
    fi
    # shellcheck disable=SC2086
    apt_run install -y $MISSING_PKGS -qq
  else
    # dnf/yum (Fedora/Nobara/RHEL). A disztro nodejs csomagja v20+ az aktualis
    # kiadasokon, es az npm-et is tartalmazza -- nincs szukseg kulso repora.
    # Csomagnevek megegyeznek a Debian-belivel (ffmpeg/git/tmux/lsof/curl/
    # python3/pipx/unzip/zstd/nodejs). Az ffmpeg-hez Fedoran az RPM Fusion repo
    # kellhet; ha mar engedelyezve van, a csomag elerheto.
    # shellcheck disable=SC2086
    pkg_install_noninteractive $MISSING_PKGS
  fi
fi

hash -r

# Ellenorzes: node es npm tenyleg elerheto-e
if [ "$PKG_MANAGER" = "apt" ]; then
  NODE_FIX_HINT="sudo apt-get install nodejs"
  NPM_FIX_HINT="dpkg -l nodejs"
else
  NODE_FIX_HINT="sudo $PKG_MANAGER install nodejs"
  NPM_FIX_HINT="sudo $PKG_MANAGER install nodejs npm"
fi
command -v node &>/dev/null || fail "Node.js telepitese sikertelen. Ellenorizd: $NODE_FIX_HINT"
command -v npm &>/dev/null || fail "npm nem talalhato a nodejs csomag utan sem. Ellenorizd: $NPM_FIX_HINT"
# LINUXINSTPREREQ1104: the rule again, after the package step, on every path
# (apt and dnf/yum, a node that was there before or one that just went in).
NODE_VER=$(node_major)
if [ "$NODE_VER" -lt 20 ]; then
  if [ "$PKG_MANAGER" = "apt" ]; then
    fail "$(_t linux.node_too_old) ${NODE_VER}.
    $(_t linux.node_fix_lead)
      ${NODE_FIX_APT}"
  else
    fail "$(_t linux.node_too_old) ${NODE_VER}.
    $(_t linux.node_fix_rpm)"
  fi
fi

ok "ffmpeg $(ffmpeg -version | awk 'NR==1 {print $3}')"
ok "git $(git --version | awk '{print $3}')"
ok "make $(make --version | awk 'NR==1 {print $3}')"
ok "lsof $(lsof -v 2>&1 | awk '/^    revision:/ {print $2}')"
ok "node $(node --version)"
ok "npm $(npm --version)"
ok "pipx" $(pipx --version)
ok "python3 $(python3 --version | awk '{print $2}')"
ok "tmux $(tmux -V | awk '{print $2}')"
ok "unzip" $(unzip -v | awk 'NR==1 {print $2}')
ok "zstd $(zstd --version | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

# LINUXINSTPREREQ1104: --admin-prereq stops here. Only the channel gate is left of the root
# steps; the clone, the build, the dashboard and the services are the non-admin user's run.
if [ "$ADMIN_PREREQ" = 1 ]; then
  # ADMINPREREQTRUST1104: never the checkout's copy (the non-admin user can write it). The gate AND
  # the writer it calls (scripts/lib/managed-settings-write.py, found next to the gate) come from the
  # official source at MARVEEN_REF, into a fresh root-owned temp tree.
  {
    GATE_DIR="$(mktemp -d /tmp/marveen-channels-gate.XXXXXX)"
    mkdir -p "$GATE_DIR/lib"
    GATE_SCRIPT="$GATE_DIR/ensure-managed-channels-enabled.sh"
    _raw="${MARVEEN_OFFICIAL_RAW}/${MARVEEN_REF}/scripts"
    # The writer is optional here: an older ref's gate does not call it (main before the
    # writer landed), and a gate that needs it and misses it reports the manual step itself.
    curl -fsSL "$_raw/ensure-managed-channels-enabled.sh" -o "$GATE_SCRIPT" 2>/dev/null || : > "$GATE_SCRIPT"
    curl -fsSL "$_raw/lib/managed-settings-write.py" -o "$GATE_DIR/lib/managed-settings-write.py" 2>/dev/null \
      || rm -f "$GATE_DIR/lib/managed-settings-write.py"
  }
  GATE_OUT=""
  [ -s "$GATE_SCRIPT" ] && GATE_OUT="$(bash "$GATE_SCRIPT" 2>&1 || true)"
  case "$GATE_OUT" in *MARVEEN_CHANNELS_GATE=ok*) GATE_RESULT=ok ;; *) GATE_RESULT=manual ;; esac
  LINGER_RESULT=nouser
  if ! command -v loginctl >/dev/null 2>&1 || [ ! -d "${LINGER_SYSTEMD_DIR:-/run/systemd/system}" ]; then LINGER_RESULT=na
  elif [ -n "$ADMIN_USER" ]; then
    if loginctl enable-linger "$ADMIN_USER" 2>/dev/null; then LINGER_RESULT=ok; else LINGER_RESULT=fail; fi
  fi
  echo ""
  echo -e "${BOLD}$(_t linux.adminprereq_done_head)${NC}"
  if [ -n "$ADMIN_INSTALLED" ]; then ok "$(_t linux.adminprereq_pkgs_installed)${ADMIN_INSTALLED}"; else ok "$(_t linux.adminprereq_pkgs_present)"; fi
  ok "node $(node --version)"
  if [ "$GATE_RESULT" = ok ]; then ok "$(_t linux.adminprereq_gate_ok)"; else
    warn "$(_t linux.adminprereq_gate_manual)"
    # the gate's own human lines (its reason); the machine verdict line stays out
    [ -n "$GATE_OUT" ] && printf '%s\n' "$GATE_OUT" | grep -v 'MARVEEN_CHANNELS_GATE=' | sed 's/^/    /'
  fi
  case "$LINGER_RESULT" in
    ok) ok "$(_t linux.adminprereq_linger_ok) ${ADMIN_USER}" ;;
    na) ok "$(_t linux.adminprereq_linger_na)" ;;
    fail) warn "$(_t linux.adminprereq_linger_fail) ${ADMIN_USER}" ;;
    *) warn "$(_t linux.adminprereq_linger_nouser)"
       echo "      $(admin_prereq_cmd '<name>')" ;;
  esac
  echo -e "  $(_t linux.adminprereq_next_lead)"
  echo "      $(_t linux.adminprereq_next_same)${ADMIN_USER:+   (${ADMIN_USER})}"
  exit 0
fi

# ─────────────────────────────────────────────
# Repo bootstrap
# ─────────────────────────────────────────────
# Ha a scriptet onmagaban toltottek le (curl|bash, `bash install-linux.sh`
# a home-bol, vagy a Windows/WSL wrapper /tmp-be menti), akkor a repo NINCS
# a gepen -> a kesobbi `npm install`, template-masolas es dist build mind egy
# package.json nelkuli mappaban futna (ENOENT: /root/package.json). Ilyenkor
# klonozzuk a repot egy stabil helyre es ujrafuttatjuk magunkat onnan.
# git itt mar garantaltan telepitve van (lasd fentebb a [1/7] lepest).
if [ ! -f "$INSTALL_DIR/package.json" ]; then
  warn "A telepito a repon kivulrol fut (nincs package.json itt: $INSTALL_DIR)."
  TARGET_DIR="$HOME/marveen"
  if [ -f "$TARGET_DIR/package.json" ]; then
    ok "Meglevo checkout: $TARGET_DIR -- frissites..."
    git -C "$TARGET_DIR" pull --ff-only 2>/dev/null || warn "git pull kihagyva (helyi valtozasok lehetnek)."
  else
    echo -e "  Repo klonozasa -> ${TARGET_DIR} ..."
    # A repo default branch-e a develop, de a publikus telepito main-rol fut
    # (a Windows/WSL wrapper is main-rol fetcheli a scriptet) -> pineljuk a main-t.
    # MARVEENLANG1763: the same ref the language file came from (default main).
    git clone --depth 1 --branch "$MARVEEN_REF" https://github.com/Szotasz/marveen.git "$TARGET_DIR" \
      || fail "git clone sikertelen: https://github.com/Szotasz/marveen.git (${MARVEEN_REF} branch)"
    ok "Repo klonozva: $TARGET_DIR"
  fi
  echo -e "  Telepito ujrainditasa a checkoutbol..."
  # Forward argv so a run from outside the repo (curl bootstrap, or an explicit
  # `install-linux.sh --port N`) keeps its flags across the self-reclone exec.
  exec bash "$TARGET_DIR/install-linux.sh" "$@"
fi

INSTALL_STEP="claude-bun-install"
# ─────────────────────────────────────────────
# [2/7] Claude Code + Bun telepitese
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}$(_t section_2_linux)${NC}"

# ~/.local/bin eloszor, hogy a claude check mar jo PATH-on fusson
ensure_in_rc '.local/bin' 'export PATH="$HOME/.local/bin:$PATH"'
export PATH="$HOME/.local/bin:$PATH"

# Does an installed claude actually LAUNCH? On an AVX-less x86 host the official
# installer's Bun standalone binary SIGILLs / hangs on start, so `command -v`
# alone is not enough -- we verify it runs. `--version` is NOT that probe:
# measured 2026-09-23 on the AVX-less pilot VPS (CLIRUNSVERZIO923), the
# 2.1.200+ Bun ELF answers `--version` with exit 0 and then spins silently on a
# real prompt, so a host that already carries a latest claude would pass the
# gate and get an install on which no agent prompt ever runs. The probe is a
# real `-p` prompt, made auth-free on purpose: an isolated EMPTY config dir and
# the auth env unset make a healthy CLI exit 1 within ~2 s ("Not logged in",
# JSON on stdout, no API call, nothing written to the real config), while a Bun
# binary without AVX either SIGILLs (exit 132) or hangs until `timeout` (124).
# "Runs" therefore means: exited on its own with a code below 124.
_claude_runs() {
  command -v claude >/dev/null 2>&1 || return 1
  local probe_cfg rc
  # TMPPROBE1108 (Dani 73504): no fixed /tmp fallback name. The probe hands the dir to claude as CLAUDE_CONFIG_DIR,
  # and a predictable one another local user created first could carry a settings.json whose hooks run commands.
  # Without a private dir there is no probe: counted as "does not run" (the step then says so).
  probe_cfg="$(mktemp -d 2>/dev/null)" || probe_cfg=""
  [ -n "$probe_cfg" ] && [ -d "$probe_cfg" ] || return 1
  env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
    CLAUDE_CONFIG_DIR="$probe_cfg" DISABLE_AUTOUPDATER=1 \
    timeout "${CLAUDE_PROBE_TIMEOUT:-25}" claude -p 'ping' --max-turns 1 --output-format json \
    </dev/null >/dev/null 2>&1
  rc=$?
  rm -rf "$probe_cfg"
  # 124 = hung until timeout, 125-127 = could not even exec, 128+ = killed by a signal (SIGILL/SIGSEGV)
  [ "$rc" -lt 124 ]
}
# A claude that is on PATH but does not launch (typically the official
# installer's Bun ELF at ~/.local/bin/claude) would keep SHADOWING the pinned
# Node build: ~/.local/bin is first on PATH and `npm -g` lands in /usr/bin or
# ~/.npm-global. Move it aside (reversible: <path>.avx-broken) so the pin wins.
_shelve_broken_claude() {
  local p
  p="$(command -v claude 2>/dev/null || true)"
  [ -n "$p" ] || return 0
  if mv "$p" "${p}.avx-broken" 2>/dev/null; then
    warn "A mar telepitett claude ($p) AVX nelkul nem indul; felretettem: ${p}.avx-broken"
  else
    warn "A mar telepitett claude ($p) AVX nelkul nem indul, es nem tudtam felretenni -- a pinnelt verziot arnyekolhatja."
  fi
  hash -r
}

# BUNTIMEOUT1108: the vendors' "curl | bash" installers (Claude Code, Bun) ran with no time limit and with their
# errors thrown away (`2>/dev/null`). On 2026-11-08 a fresh Bun download on the owner's VPS stalled: ~/.bun/bin was
# created empty, the installer never got past the step, and the Bridge showed only "Claude + Bun". This helper fetches
# the vendor script to a file (connect and total time limits), runs it under `timeout` (its own downloads included:
# timeout signals the whole process group), retries, and on the final failure prints the vendor's own last lines, so
# the reason is visible. It never decides the outcome by the script's exit code alone: $3 is the check that the tool
# is really there (a vendor script can exit 0 without installing).
#   _run_remote_installer <label> <url> <check-fn> [script args...]   -> 0 when <check-fn> passes, else 1
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
      if timeout --kill-after=10 "${REMOTE_INSTALL_TIMEOUT:-300}" bash "$script" "$@" </dev/null >>"$log" 2>&1; then
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
_claude_present() { command -v claude >/dev/null 2>&1; }
_bun_present() { [ -x "$BUN_INSTALL/bin/bun" ] && "$BUN_INSTALL/bin/bun" --version >/dev/null 2>&1; }

# BUNTIMEOUT1108 (Samu 73430): the fallback when the GitHub release download fails. Measured on the owner's VPS on
# 2026-11-08: bun.sh/install answered 200, the GitHub bun-linux-x64.zip timed out (0 bytes in 90 s) and then gave
# HTTP 503, twice in a row. npm's `bun` package comes from registry.npmjs.org instead. Same version as the Docker image
# (Dockerfile BUN_VERSION; a test pins the two together). The binary is linked into ~/.bun/bin, the official layout
# every PATH line and probe of ours already names.
BUN_PIN="1.4.4"
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
    timeout --kill-after=10 "${REMOTE_INSTALL_TIMEOUT:-300}" sudo npm install -g "bun@${BUN_PIN}" </dev/null >"$log" 2>&1 || rc=$?
  else
    timeout --kill-after=10 "${REMOTE_INSTALL_TIMEOUT:-300}" npm install -g "bun@${BUN_PIN}" </dev/null >"$log" 2>&1 || rc=$?
  fi
  hash -r
  # The bun this npm install put in, by npm's own prefix: `command -v bun` could name an older bun earlier on PATH
  # (Dani 73434).
  # An empty prefix would make this "/bin/bun", on a merged-/usr system possibly a distro bun (Dani 73504): no prefix,
  # no link.
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
# The official installer (bun.sh/install, which downloads from GitHub releases) first, npm as the fallback; a stop with
# the reason when both fail. Never a hang and never a silent "continue without bun".
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

# Pinned Node-based fallback for AVX-less hosts. @2.1.112 is the LAST version
# that ships bin=cli.js (a `#!/usr/bin/env node` entrypoint) running without
# AVX -- from 2.1.113 on every published version ships bin=bin/claude.exe with
# a postinstall that downloads the Bun ELF binary, so DO NOT use latest here.
# Measured 2026-09-23 on the AVX-less pilot VPS (QEMU Virtual CPU 2.5+, 0 avx
# flags) with a REAL `claude -p ... --output-format json` probe, not
# `--version` (which still exits 0 on some Bun builds there): 2.1.110/111/112
# answer, 2.1.113/150/170 SIGILL ("CPU lacks AVX support"), 2.1.200/240/260/280
# spin silently for 120 s. 2.1.112 understands `--channels` (same parser
# as 2.1.110), which channels.sh requires to boot the bot. Keep in sync with
# scripts/channels.sh and scripts/fix-avx.sh (a test pins the three together).
CLAUDE_PIN="2.1.112"

if _claude_runs; then
  ok "claude mar telepitve es fut: $(claude --version 2>/dev/null || echo 'ok')"
else
  # Present on PATH but did not launch (the probe above failed while the
  # binary exists): remembered here so the AVX-less branch can shelve it.
  CLAUDE_PREEXISTING_BROKEN="$(command -v claude 2>/dev/null || true)"
  # AVX pre-flight: the official installer's Bun binary needs AVX. Only x86
  # (has a `flags :` line in /proc/cpuinfo) can lack it; ARM (`Features :`, no
  # `avx`) runs the arm64 Bun binary fine, so it takes the official path.
  if grep -qE '^flags[[:space:]]*:' /proc/cpuinfo 2>/dev/null && ! grep -qiw avx /proc/cpuinfo 2>/dev/null; then
    warn "A CPU nem tamogatja az AVX-et; a hivatalos installer Bun-binaryja elszallna (SIGILL)."
    echo -e "  ${DIM}Pinnelt Node-verzio telepitese: @${CLAUDE_PIN} (nehany legfrissebb Claude Code fix kimaradhat, de fut AVX nelkul).${NC}"
    # The auto-updater would replace the pinned Node cli.js with the latest
    # Bun binary on first run -> SIGILL. Disable it persistently (rc files for
    # interactive shells; channels.sh exports it for the agent sessions).
    ensure_in_rc 'DISABLE_AUTOUPDATER' 'export DISABLE_AUTOUPDATER=1'
    export DISABLE_AUTOUPDATER=1
    [ -n "${CLAUDE_PREEXISTING_BROKEN:-}" ] && _shelve_broken_claude
    if command -v npm >/dev/null 2>&1; then
      # NPMPERM1: nodesource-os gepen a globalis node_modules root-tulajdonu
      # lehet. Auto-mod: nem kerdez, sudo-ra valt lathato megjegyzessel.
      ensure_global_npm_writable auto || true
      if [ "${NPM_NEEDS_SUDO:-}" = "1" ]; then
        sudo npm install -g "@anthropic-ai/claude-code@${CLAUDE_PIN}" || warn "npm install sikertelen (@${CLAUDE_PIN})."
      else
        npm install -g "@anthropic-ai/claude-code@${CLAUDE_PIN}" || warn "npm install sikertelen (@${CLAUDE_PIN})."
      fi
    else
      warn "npm nem elerheto; a pinnelt hivatalos installert probalom (@${CLAUDE_PIN})."
      _run_remote_installer "Claude Code (@${CLAUDE_PIN})" https://claude.ai/install.sh _claude_present "${CLAUDE_PIN}" \
        || warn "pinnelt install.sh sikertelen."
    fi
  else
    echo -e "  Claude Code telepitese (hivatalos installer, ~/.local/bin)..."
    _run_remote_installer "Claude Code" https://claude.ai/install.sh _claude_present || true
  fi
  hash -r
  # BUNTIMEOUT1108: no claude at all after the installer (and its retries) is a hard stop with the reason above,
  # not a "continue" into a claude-auth step that can never work. A claude that is there but does not launch keeps
  # the existing AVX message below.
  if ! _claude_present; then
    fail "A Claude Code telepitese nem sikerult (a fenti sorok mutatjak az okat). Inditsd ujra a telepitest; ha ugyanitt akad el, ellenorizd, hogy a gep eleri-e a claude.ai-t (AVX nelkuli gepen a registry.npmjs.org-ot)."
  fi
  # Verify the install actually launches -- surfaces an AVX crash HERE with a
  # clear message instead of a cryptic SIGILL at first agent-spawn.
  if _claude_runs; then
    ok "claude telepitve es fut: $(claude --version 2>/dev/null || echo 'ok')"
  else
    echo -e "  ${RED}HIBA:${NC} claude telepitve, de nem indul (valoszinuleg AVX-hianyos CPU + Bun-binary)."
    if command -v npm >/dev/null 2>&1; then
      echo -e "  ${DIM}Probald manualisan (masold ki az alabbi sort):${NC}"
      echo "    npm install -g @anthropic-ai/claude-code@${CLAUDE_PIN}"
    else
      echo -e "  ${DIM}Telepits nvm+node-ot, majd (masold ki az alabbi sort):${NC}"
      echo "    npm install -g @anthropic-ai/claude-code@${CLAUDE_PIN}"
    fi
  fi
fi

# Channel inbound org-policy gate: ensure the system managed-settings enable
# channels. claude-code >= 2.1.205 silently drops channel-plugin INBOUND
# notifications on a team/enterprise org unless managed-settings has
# channelsEnabled:true (harmless / no-op on a personal org). Idempotent.
if [ -f "$INSTALL_DIR/scripts/ensure-managed-channels-enabled.sh" ]; then
  managed_settings_notice
  echo -e "  Managed-settings channel-kapu ellenorzese..."
  bash "$INSTALL_DIR/scripts/ensure-managed-channels-enabled.sh" || true
fi

# Linuxbrew (ha telepitve van)
if [ -x "/home/linuxbrew/.linuxbrew/bin/brew" ]; then
  ensure_in_rc 'linuxbrew' 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"'
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"
  ok "Linuxbrew PATH beallitva"
fi

# XDG_RUNTIME_DIR + DBUS: headless szerveren automatikusan beallitjuk
# (detektalas: nincs DISPLAY es nincs WAYLAND_DISPLAY)
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  XDG_BLOCK='# marveen-user-bus: XDG_RUNTIME_DIR + DBUS headless szerveren
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ] && [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi'
  ensure_block_in_rc 'marveen-user-bus' "$XDG_BLOCK"
  # Aktivaljuk az aktualis sessionban is
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi
  if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ] && [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  fi
  ok "XDG_RUNTIME_DIR / DBUS beallitva (headless)"
fi

# Bun: no longer here. GROMZONOPROVIDER1108: it is installed after the channel choice ("bun-install" below), and only
# for a channel whose plugin runs on Bun (telegram, discord). A Gromzo or Slack install never downloads it.
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

INSTALL_STEP="claude-auth"
# ─────────────────────────────────────────────
# [3/7] Claude bejelentkezes
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}$(_t section_3_linux)${NC}"

IS_HEADLESS=false
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  IS_HEADLESS=true
fi
# WSLg exports DISPLAY/WAYLAND_DISPLAY on every WSL2 distro, so the check above
# called a WSL box "desktop" and made Enter mean "3 = skip". On WSL the services
# can only use a token (see service_auth_present), so default to the token path
# there, exactly like a headless server.
if [ "$IS_WSL" = "true" ]; then
  IS_HEADLESS=true
fi

# Skip the prompt only when THIS INSTALL already carries a credential the
# services can read (a re-run, or the dashboard wizard got there first).
# Gating on `claude auth status` here is what silently skipped token capture
# for operators who had followed step 2 below and run `claude setup-token`
# first -- the correct user behaviour triggered the bug.
if service_auth_present; then
  ok "A telepites mar hordoz auth kulcsot (.env / store/.claude-oauth-token)"
  scrub_secret_exports_from_rc
else
  if claude auth status &>/dev/null; then
    echo -e "  ${ORANGE}A terminalod be van jelentkezve, de a SZOLGALTATASOK ehhez nem ferenek hozza.${NC}"
    echo -e "  ${DIM}A systemd unitok csak a .env-et es a store/.claude-oauth-token-t olvassak.${NC}"
  else
    echo -e "  ${ORANGE}Nincs aktiv Claude bejelentkezes.${NC}"
  fi
  if [ "$IS_HEADLESS" = "true" ]; then
    echo ""
    if [ "$IS_WSL" = "true" ]; then
      echo -e "  ${BLUE}WSL detektalva: a hatterszolgaltatasok csak tokent tudnak hasznalni.${NC}"
    else
      echo -e "  ${BLUE}Headless szerver detektalva (nincs DISPLAY).${NC}"
      echo -e "  ${BLUE}Bongeszo-alapu bejelentkezes nem lehetseges.${NC}"
    fi
    echo -e "  ${BOLD}Ajanlott: OAuth token (2) vagy API key (1).${NC}"
    echo ""
  fi
  echo ""
  echo -e "  Valassz bejelentkezesi modot:"
  echo -e "  ${BOLD}1.${NC} API key ${DIM}(Anthropic Console -> fizeteses/pay-as-you-go)${NC}"
  echo -e "  ${BOLD}2.${NC} OAuth token ${DIM}(Pro/Max elofizetes - tokennel egy masik geprol)${NC}"
  echo -e "  ${BOLD}3.${NC} Kihagyas ${DIM}(kesobb allitod be)${NC}"
  echo ""
  if [ "$IS_HEADLESS" = "true" ]; then
    read -rp "$(_t prompt_auth_mode)" AUTH_MODE
    AUTH_MODE=${AUTH_MODE:-2}
  else
    read -rp "$(_t prompt_auth_mode)" AUTH_MODE
    AUTH_MODE=${AUTH_MODE:-3}
  fi

  if [ "$AUTH_MODE" = "1" ]; then
    echo ""
    echo -e "  ${DIM}API kulcsot itt talalod: https://console.anthropic.com/settings/keys${NC}"
    read -p "  ANTHROPIC_API_KEY (sk-ant-...): " ANTHROPIC_API_KEY_INPUT
    if [ -n "$ANTHROPIC_API_KEY_INPUT" ]; then
      export ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY_INPUT"
      remove_secret_export_from_rc ANTHROPIC_API_KEY
      ensure_secret_reader_in_rc ANTHROPIC_API_KEY "$INSTALL_DIR/.env" env
      CLAUDE_AUTH_ENV_LINE="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY_INPUT}"
      ok "ANTHROPIC_API_KEY beallitva"
    else
      warn "API key nem lett megadva, kihagyas."
    fi

  elif [ "$AUTH_MODE" = "2" ]; then
    echo ""
    echo -e "  ${ORANGE}Lepesek egy boengeszos gepen:${NC}"
    echo -e "  ${BOLD}1.${NC} Nyiss egy terminalt egy olyan gepen ahol van bongeszo"
    echo -e "  ${BOLD}2.${NC} Futtasd: ${BLUE}claude setup-token${NC}"
    echo -e "  ${BOLD}3.${NC} A bongeszo megnyilik, jelentkezz be a Claude fiokoddal"
    echo -e "  ${BOLD}4.${NC} Masold vissza ide a kiirt tokent:"
    echo -e "  ${DIM}A token sk-ant-oat01- kezdetu. A bongeszoben megjeleno kod NEM a token:${NC}"
    echo -e "  ${DIM}azt a setup-token ablakaba kell beirni, es utana a terminal irja ki a tokent.${NC}"
    echo ""
    # Shape-check BEFORE the value is written anywhere. Without it any paste was
    # accepted -- typically the one-time code the browser shows during
    # `claude setup-token` -- and landed in .env as if it were the
    # token; the services then failed to authenticate with no hint why. Same
    # pattern the store/.claude-oauth-token write below already gates on.
    OAUTH_TOKEN_INPUT=""
    for _try in 1 2 3; do
      # Read into OAUTH_TOKEN_INPUT (not a new name): the desktop installer
      # derives its prompts from this file by variable name.
      read -p "  OAuth token: " OAUTH_TOKEN_INPUT
      _tok="$(printf '%s' "$OAUTH_TOKEN_INPUT" | tr -d '[:space:]')"
      OAUTH_TOKEN_INPUT=""
      [ -z "$_tok" ] && break
      if printf '%s' "$_tok" | grep -Eq '^sk-ant-oat01-[A-Za-z0-9_-]{40,}$'; then
        OAUTH_TOKEN_INPUT="$_tok"
        break
      fi
      warn "Ez nem setup-token (nem sk-ant-oat01- kezdetu, vagy tul rovid). Probald ujra, vagy hagyd uresen a kihagyashoz."
    done
    unset _tok _try
    if [ -n "$OAUTH_TOKEN_INPUT" ]; then
      export CLAUDE_CODE_OAUTH_TOKEN="$OAUTH_TOKEN_INPUT"
      remove_secret_export_from_rc CLAUDE_CODE_OAUTH_TOKEN
      ensure_secret_reader_in_rc CLAUDE_CODE_OAUTH_TOKEN "$INSTALL_DIR/store/.claude-oauth-token" file
      CLAUDE_AUTH_ENV_LINE="CLAUDE_CODE_OAUTH_TOKEN=${OAUTH_TOKEN_INPUT}"
      # Ellenorzes
      if claude auth status &>/dev/null; then
        ok "OAuth token elfogadva, bejelentkezes sikeres"
      else
        warn "Token beallitva, de az ellenorzes sikertelen -- ellenorizd a tokent."
      fi
    else
      warn "Token nem lett megadva, kihagyas."
    fi

  else
    # Record that skipping was a CHOICE, here, at the moment it is made
    # (INSTDEAD803). Without this the only later evidence is the ABSENCE of
    # credentials, and absence cannot tell "the operator decided to set this up
    # later" apart from "the sign-in broke halfway" -- which is exactly the
    # dead end a bootcamp host hit on 2026-08-03. The installer app reads this
    # flag to decide whether an install is finished or unfinished. It is not a
    # renunciation: completing the sign-in later stays available on request.
    CLAUDE_AUTH_DEFERRED=1
    echo -e "  ${DIM}Kihagyva. Kesobb allitsd be:${NC}"
    echo -e "  ${DIM}  export ANTHROPIC_API_KEY=sk-ant-...${NC}"
    echo -e "  ${DIM}  vagy: claude setup-token (boengeszos gepen), majd export CLAUDE_CODE_OAUTH_TOKEN=...${NC}"
  fi
fi

# Pre-flight headless probe — Issue #179.
# `claude auth status` only checks the token file; it does NOT verify the SDK
# can actually run a query against the live API. On a VPS where the token is
# stale or the network blocks api.anthropic.com, agent create later bombs out
# with "Failed to generate CLAUDE.md". Catch it here while the user is still in
# front of the install script.
echo ""
echo -e "  ${DIM}Headless Claude Code teszt...${NC}"
# The exit status here used to be `head`'s, not claude's: `VAR=$(cmd | head)`
# reports the LAST pipeline element, so a failing claude looked like success.
# PIPESTATUS does NOT help either -- after an assignment it describes the
# assignment, not the pipeline inside the substitution (measured). Dropping the
# pipe entirely is the only form that reports claude's own status; the output is
# truncated afterwards in the shell.
# The `&& ... || ...` guard is what keeps a failing probe out of the ERR trap:
# the trap fires regardless of the errexit setting and on_error() exits 1, so an
# unguarded capture aborted the installer instead of reaching the branch below.
CLAUDE_PROBE_OUT=$(claude --print "ping" 2>&1) && CLAUDE_PROBE_EXIT=0 || CLAUDE_PROBE_EXIT=$?
CLAUDE_PROBE_OUT=${CLAUDE_PROBE_OUT:0:200}
if [ "$CLAUDE_PROBE_EXIT" -eq 0 ] && [ -n "$CLAUDE_PROBE_OUT" ]; then
  ok "Az OPERATOR shelljebol futtathato a Claude Code (\`claude --print\` valaszolt)"
else
  warn "Headless Claude Code probe SIKERTELEN. Az agent-letrehozas KESOBB EL fog hasalni."
  echo -e "    ${DIM}Kimenet: ${CLAUDE_PROBE_OUT:-<ures>}${NC}"
  echo -e "    ${DIM}Tipikus okok: nincs ervenyes auth, halozati problema, regi claude CLI.${NC}"
  echo -e "    ${DIM}Javitas: \`claude --version\` -> \`claude /login\` (vagy ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN beallitas) -> \`claude --print \"ping\"\` ujra.${NC}"
fi

# Ensure ~/.claude directory tree has correct ownership and permissions.
# On Ubuntu desktop, umask or prior package installs can leave these dirs
# world-readable or owned by root, which blocks Claude Code from writing
# its config/settings files.
mkdir -p "$HOME/.claude"
chmod 700 "$HOME/.claude"
for d in "$HOME/.claude/channels" "$HOME/.claude/skills" "$HOME/.claude/scheduled-tasks"; do
  mkdir -p "$d"
  chmod 700 "$d"
done

# Mark the Claude Code first-run wizard as completed so the tmux-spawned
# `claude --channels ...` process doesn't stop on the theme picker and
# block the Telegram plugin from ever initializing.
python3 - <<'PYEOF'
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

# Pre-accept the --dangerously-skip-permissions confirmation dialog so the
# headless `claude --channels ...` session in scripts/channels.sh doesn't
# park on it forever (the dialog needs interactive Enter and there's no TTY
# attached). Claude Code maintains this flag itself once accepted manually,
# but we have to seed it before the first systemd-spawned session.
python3 - <<'PYEOF'
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
echo -e "  ${GREEN}✓${NC} Claude Code first-run beallitas kesz"

INSTALL_STEP="personal-info"
# ─────────────────────────────────────────────
# [4/7] Szemelyes beallitasok
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}$(_t section_4_linux)${NC}"
read -rp "$(_t prompt_your_name)" OWNER_NAME
# Chat ID is NOT asked here -- the user doesn't know it yet.
# It will be set automatically during the Telegram pairing flow.
CHAT_ID="0"

# VPS/cloud MCP warning (headless only)
if [ "$IS_HEADLESS" = "true" ]; then
  echo ""
  echo -e "${ORANGE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${ORANGE}  FIGYELEM: VPS / cloud szerver detektalva${NC}"
  echo -e "${ORANGE}  Ha a claude.ai fiokodban sok MCP connector van${NC}"
  echo -e "${ORANGE}  engedelyezve, a headless session megprobalja betolteni${NC}"
  echo -e "${ORANGE}  mindet, ami instabilitast okozhat.${NC}"
  echo ""
  echo -e "  ${BOLD}Javasoljuk:${NC} lepj be a claude.ai Settings oldalara es"
  echo -e "  tiltsd le a felesleges MCP-ket telepites elott."
  echo -e "${ORANGE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  read -rp "$(_t prompt_vps_continue)" CONTINUE_MCP
  CONTINUE_MCP=${CONTINUE_MCP:-i}
  if [ "$CONTINUE_MCP" != "i" ]; then
    echo -e "  ${DIM}Telepites megszakitva. Tiltsd le a felesleges MCP-ket, majd futtasd ujra.${NC}"
    exit 0
  fi
fi

# Channel provider setup
echo ""
echo -e "${BOLD}  Csatorna beallitas${NC}"
echo -e "${DIM}  Melyik csatornan kommunikaljon az AI asszisztensed?${NC}"
echo -e "  ${BOLD}1.${NC} Telegram (alapertelmezett)"
echo -e "  ${BOLD}2.${NC} Slack"
echo -e "  ${BOLD}3.${NC} Discord"
echo -e "  ${BOLD}4.${NC} $(_t channel_option_gromzo)"
echo -e "  ${BOLD}5.${NC} $(_t channel_option_teams)"
echo ""
read -rp "$(_t prompt_channel_select5)" PROVIDER_CHOICE
PROVIDER_CHOICE=${PROVIDER_CHOICE:-1}
if [ "$PROVIDER_CHOICE" = "2" ]; then
  CHANNEL_PROVIDER="slack"
elif [ "$PROVIDER_CHOICE" = "3" ]; then
  CHANNEL_PROVIDER="discord"
elif [ "$PROVIDER_CHOICE" = "4" ] || [ "$PROVIDER_CHOICE" = "gromzo" ]; then
  # GROMZONOPROVIDER1108: the main agent talks only through Gromzo (no bot token, no Bun); accepted as 4 or by name.
  CHANNEL_PROVIDER="gromzo"
elif [ "$PROVIDER_CHOICE" = "5" ] || [ "$PROVIDER_CHOICE" = "teams" ]; then
  # EE2392D3: Microsoft Teams (claude-channel-teams, an Azure Bot); accepted as 5 or by name.
  CHANNEL_PROVIDER="teams"
else
  CHANNEL_PROVIDER="telegram"
fi
ok "Csatorna: $CHANNEL_PROVIDER"

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
TEAMS_BOT_APP_ID=""
TEAMS_BOT_TENANT_ID=""
TEAMS_BOT_APP_PASSWORD=""

# EE2392D3: one .env value per key: whitespace (a pasted newline, a trailing space) is cut, never written.
_teams_clean() { printf '%s' "$1" | tr -d '[:space:]'; }
_teams_uuid() { printf '%s' "$1" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; }
_teams_tty() { [ -t 0 ]; } # a terminal on stdin: only there is echo switched off

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
elif [ "$CHANNEL_PROVIDER" = "teams" ]; then
  # EE2392D3: the three keys of the Azure Bot's Entra app (the names the Teams plugin and the dashboard read:
  # TEAMS_BOT_APP_ID, TEAMS_BOT_TENANT_ID, TEAMS_BOT_APP_PASSWORD). Each read stays a plain `read -rp` line, so the
  # Bridge's headless derive can turn it into its env preset; the secret is not echoed (stty, a no-op without a
  # terminal) and is never printed. Empty = set up later with the plugin's setup-azure-bot.sh --env-file.
  echo ""
  echo -e "${DIM}  Az AI asszisztensed Microsoft Teamsen kommunikal veled, egy Azure Boton at.${NC}"
  echo -e "${DIM}  Ha mar van Azure Botod: add meg az alkalmazas (App ID), a tenant es a titkos kulcs ertekeit.${NC}"
  echo -e "${DIM}  Ha meg nincs: hagyd uresen, a bot a telepites utan a Teams-bovitmeny${NC}"
  echo -e "${DIM}  setup-azure-bot.sh szkriptjevel hozhato letre (Teams-bekotesi sugo).${NC}"
  echo ""
  read -rp "$(_t prompt_teams_app_id)" TEAMS_BOT_APP_ID
  TEAMS_BOT_APP_ID="$(_teams_clean "$TEAMS_BOT_APP_ID")"
  if [ -n "$TEAMS_BOT_APP_ID" ]; then
    read -rp "$(_t prompt_teams_tenant_id)" TEAMS_BOT_TENANT_ID
    TEAMS_BOT_TENANT_ID="$(_teams_clean "$TEAMS_BOT_TENANT_ID")"
    # Echo off only on a terminal, and back on every way out of the read: Ctrl+C and TERM restore it and stop
    # (130), a stdin EOF under the ERR trap restores it on EXIT. The traps that were set before (the Bridge's
    # headless run has its own EXIT trap, headless-helpers.sh on_exit_emit_result) are saved and put back, also on
    # the Ctrl+C path; without a terminal no trap is touched at all (Ábel 75250, measured).
    _teams_prev_traps="$(trap -p INT TERM EXIT)"
    # The caller's EXIT command itself (trap -p prints it shell-quoted: eval turns it back into the string), so an
    # exit while echo is off (a stdin EOF under set -e, Dani 75350 (1)) runs it after the echo comes back.
    _teams_prev_exit=""
    eval "_teams_prev_exit=$(trap -p EXIT | sed -e 's/^trap -- //' -e 's/ EXIT$//')"
    if _teams_tty; then
      trap 'stty echo 2>/dev/null || true; trap - INT TERM EXIT; eval "$_teams_prev_traps"; exit 130' INT TERM
      trap 'stty echo 2>/dev/null || true; eval "$_teams_prev_exit"' EXIT
      stty -echo 2>/dev/null || true
    fi
    read -rp "$(_t prompt_teams_app_password)" TEAMS_BOT_APP_PASSWORD
    if _teams_tty; then
      stty echo 2>/dev/null || true
      trap - INT TERM EXIT
      eval "$_teams_prev_traps"
    fi
    unset _teams_prev_traps _teams_prev_exit
    echo ""
    TEAMS_BOT_APP_PASSWORD="$(_teams_clean "$TEAMS_BOT_APP_PASSWORD")"
    _teams_uuid "$TEAMS_BOT_APP_ID" || warn "Az App ID nem GUID alaku (pl. 11111111-2222-3333-4444-555555555555). Ellenorizd az Entra-alkalmazasnal."
    _teams_uuid "$TEAMS_BOT_TENANT_ID" || warn "A Tenant ID nem GUID alaku. Ellenorizd: az login utan az account show --query tenantId."
    [ -n "$TEAMS_BOT_APP_PASSWORD" ] || warn "A titkos kulcs ures: a bot igy nem tud valaszolni. Kesobb a setup-azure-bot.sh --env-file potolja."
  fi
elif [ "$CHANNEL_PROVIDER" = "gromzo" ]; then
  # GROMZONOPROVIDER1108: no bot, no token: the Gromzo channel is connected later from the Marveen Bridge (Gromzo
  # wizard), through the local marveen-mxd.
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
fi

read -rp "$(_t prompt_bot_name)" BOT_NAME
BOT_NAME=${BOT_NAME:-"Marveen"}

# Derive the ASCII slug the backend uses everywhere (tmux sessions, systemd
# unit labels, DB agent_id, API routing). NFKD + ASCII + lowercase dashes,
# empty fallback to "marveen" so we never end up with a blank identifier.
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
# the defaults, so the systemd unit names below stay byte-identical to a
# brand-unaware install.
BRAND_NAME="$BOT_NAME"
SERVICE_ID="$MAIN_AGENT_ID"

INSTALL_STEP="bun-install"
# GROMZONOPROVIDER1108: Bun only for a channel plugin that runs on it (telegram, discord). Slack runs on Node, Gromzo
# on Node through marveen-mxd: those installs never download Bun, so they cannot fail on it (the owner's 11-08 Gromzo
# install failed exactly on the Bun download). A Bun channel added later installs it then (release B).
case "$CHANNEL_PROVIDER" in
  # EE2392D3: teams too: the Teams plugin's .mcp.json starts its server with `bun run ... start`.
  telegram|discord|teams)
    if command -v bun &>/dev/null; then
      ok "bun mar telepitve: $(bun --version)"
    else
      # unzip -- a Bun hivatalos telepitoje ezzel csomagolja ki a binarist; nincs alapertelmezetten telepitve friss WSL distrokon,
      # nelkule "error: unzip is required to install bun"-nal elhasal.
      command -v unzip &>/dev/null || pkg_install_noninteractive unzip || true
      echo -e "  Bun telepitese (${CHANNEL_PROVIDER} plugin fuggoseg)..."
      # BUNTIMEOUT1108: time limits, retries, the vendor's own error lines, the npm fallback, and a stop with the reason.
      _install_bun
    fi
    ensure_in_rc 'BUN_INSTALL' 'export BUN_INSTALL="$HOME/.bun"'
    ensure_in_rc '.bun/bin' 'export PATH="$BUN_INSTALL/bin:$PATH"'
    ;;
  *)
    ok "Bun nem kell (${CHANNEL_PROVIDER}: a csatorna Node-on fut)"
    ;;
esac

INSTALL_STEP="npm-install"
# ─────────────────────────────────────────────
# [5/7] Fuggosegek telepitese + konfiguracic
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}$(_t section_5)${NC}"
cd "$INSTALL_DIR"

echo -e "  npm install..."
# Fast path: npm ci. On a benign lockfile desync it fails harmlessly and we
# fall back to npm install, so ci's stderr is captured (not shown) to avoid a
# scary EUSAGE dump on the happy path. But if the fallback ALSO fails -- e.g.
# node-gyp getting OOM-killed while compiling better-sqlite3 from source, which
# has no prebuilt binary for newer Node ABIs -- we replay ci's captured stderr
# so the real error is visible instead of an empty "check above".
_NPM_CI_LOG=$(mktemp)
if ! npm ci --loglevel warn 2>"$_NPM_CI_LOG"; then
  if ! npm install --loglevel warn; then
    echo -e "  ${DIM}--- npm ci kimenet ---${NC}"
    cat "$_NPM_CI_LOG" >&2
    rm -f "$_NPM_CI_LOG"
    fail "npm install sikertelen. Ellenorizd a fenti hibauzeneteket (pl. node-gyp OOM a better-sqlite3 forditasakor)."
  fi
  # INSTALLDIRTYTREE1103: the fallback may rewrite the tracked lock into npm's
  # canonical form; restore it so the fresh install leaves a clean tree (the
  # next update's npm ci reinstalls from the tracked lock anyway).
  git -C "$INSTALL_DIR" checkout -q -- package-lock.json 2>/dev/null || true
fi
rm -f "$_NPM_CI_LOG"
ok "npm csomagok telepitve"

INSTALL_STEP="typescript-build"
echo -e "  TypeScript forditas..."
if ! npm run build --loglevel warn; then
  fail "TypeScript forditas sikertelen. Ellenorizd a hibauzeneteket fentebb."
fi
ok "TypeScript leforditva"

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

mkdir -p "$INSTALL_DIR/store"
mkdir -p "$INSTALL_DIR/agents"
ok "Konyvtarak letrehozva"

INSTALL_STEP="configuration"
# .env letrehozasa
echo ""
echo -e "${BOLD}  Konfiguracio letrehozasa...${NC}"

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
  : # GROMZONOPROVIDER1108: no token keys (CHANNEL_PROVIDER=gromzo is written above)
elif [ "$CHANNEL_PROVIDER" = "teams" ]; then
  # EE2392D3: the Teams keys go ONLY to the channel .env (below), the file the plugin reads and the plugin's
  # setup-azure-bot.sh --env-file rewrites on a secret rotation. A second copy here would win in readTeamsCreds
  # (the install .env is read first) and go stale at the first rotation. CHANNEL_TOKEN finds the app id in the
  # channel .env (getMainChannelToken, TEAMSALERTENV1110).
  :
elif [ "$CHANNEL_PROVIDER" = "discord" ]; then
  env_keep_or_set DISCORD_BOT_TOKEN "${DISCORD_BOT_TOKEN}"
  env_keep_or_set DISCORD_CHANNEL_ID "${DISCORD_CHANNEL_ID}"
  env_keep_or_set OPERATOR_DISCORD_USER_ID "${OPERATOR_DISCORD_USER_ID}"
else
  env_keep_or_set SLACK_BOT_TOKEN "${SLACK_BOT_TOKEN}"
  env_keep_or_set SLACK_APP_TOKEN "${SLACK_APP_TOKEN}"
fi
# The operator's deliberate "set auth up later" choice, persisted next to the
# rest of the configuration. Written only when the skip branch above set it, so
# it is a record of a decision and never an inference from missing credentials.
# If the run dies before this point the flag is simply absent, which reads as
# "unfinished" -- the safe direction, since that offers help rather than
# assuming the operator wanted no auth.
if [ "${CLAUDE_AUTH_DEFERRED:-}" = "1" ]; then
  env_merge_key CLAUDE_AUTH_DEFERRED 1
fi

# Claude auth credentials (API key or OAuth token) -- channels.sh reads
# these selectively so the tmux-spawned claude process can authenticate.
# Merged by key, so an auth line saved by a previous run (or the dashboard
# wizard) survives a re-run where the prompt was skipped.
if [ -n "${CLAUDE_AUTH_ENV_LINE:-}" ]; then
  env_merge_key "${CLAUDE_AUTH_ENV_LINE%%=*}" "${CLAUDE_AUTH_ENV_LINE#*=}"
fi
chmod 600 "$INSTALL_DIR/.env"
# Fleet setup-token file: per-agent config-dir isolation and the credentials
# guard are BOTH gated on store/.claude-oauth-token; without it every
# sub-agent silently falls back to the shared rotating
# ~/.claude/.credentials.json (2026-07-15 bootcamp bug family). Parity with
# the dashboard wizard (/api/onboarding/claude-auth) and scripts/auth.sh.
# Shape-gated (a garbage paste must not poison every sub-agent launch) and
# written under umask 077 (no 644 window before a chmod).
if [ -n "${OAUTH_TOKEN_INPUT:-}" ] && printf '%s' "$OAUTH_TOKEN_INPUT" | grep -Eq '^sk-ant-oat01-[A-Za-z0-9_-]{40,}$'; then
  mkdir -p "$INSTALL_DIR/store"
  (umask 077 && printf '%s' "$OAUTH_TOKEN_INPUT" > "$INSTALL_DIR/store/.claude-oauth-token")
  ok "Fleet setup-token eltarolva (store/.claude-oauth-token) -- per-agent izolacio aktiv"
  # Point the MAIN agent at an isolated config dir too, not just the
  # sub-agents. Without this the main bot keeps the shared ~/.claude and
  # authenticates from whatever refreshes that root -- on Linux the shared
  # ~/.claude/.credentials.json -- which periodically expires and 401s the bot
  # into a parked TUI that the router reads as busy, so the channel goes silent
  # with no error (the confirmed root cause of the 2026-07-23 marveen-channels
  # outage). The setting existed but nothing ever turned it on, so every
  # default install was wired to that failure mode.
  #
  # Only in THIS branch, i.e. only when the installer just captured the fleet
  # token itself in this same run: the operator handed it over moments ago, so
  # the identity the main bot will run under is not a surprise. An install that
  # already carried auth keeps whatever it had. env_set_if_absent, so a
  # deliberate MAIN_AGENT_ISOLATED_CONFIG=0 stands.
  env_set_if_absent MAIN_AGENT_ISOLATED_CONFIG 1
fi
ok ".env letrehozva (chmod 600)"

# ── Fail-closed auth gate ────────────────────────────────────────────────────
# Until now nothing verified that the AGENTS will actually be able to log in.
# A skipped/empty token prompt produced a fully "successful" install whose main
# agent then sat at "Not logged in" and re-tried forever (2026-07-30: 26 healer
# escalations and 12 pointless restarts over six hours on one host).
#
# Three states, and the failure branches must never print the success text:
#   OK       -- the services carry a credential AND it answers a live query
#   BROKEN   -- no credential, or a credential that does not work
#   UNKNOWN  -- the probe could not run (no claude binary, no network)
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
else
  # Probe the way a SERVICE will run: an isolated config dir (so ~/.claude and
  # the operator's shell exports cannot make a broken install look healthy)
  # carrying ONLY the credential the units will actually get.
  # TMPPROBE1108 (Dani 73504): no fixed /tmp fallback name. This dir is claude's CLAUDE_CONFIG_DIR next to the SERVICE
  # token; a predictable one another local user created first could carry a settings.json whose hooks run commands
  # with it. Without a private dir the probe is skipped and the state is UNKNOWN (said below).
  _probe_cfg="$(mktemp -d 2>/dev/null)" || _probe_cfg=""
  [ -n "$_probe_cfg" ] || warn "Az auth-proba kimarad: nem tudtam privat ideiglenes konyvtarat letrehozni (mktemp -d)."
  _probe_out=""
  _probe_rc=1
  if [ -n "$_probe_cfg" ] && command -v claude >/dev/null 2>&1; then
    # A 401 here is the VERDICT this gate exists to report, not an installer
    # error -- see the guard rationale above the operator-shell probe.
    if [ -n "$_svc_token" ]; then
      _probe_out="$(env -i PATH="$PATH" HOME="$HOME" CLAUDE_CONFIG_DIR="$_probe_cfg" \
        CLAUDE_CODE_OAUTH_TOKEN="$_svc_token" \
        claude --print "ping" 2>&1)" && _probe_rc=0 || _probe_rc=$?
    else
      _probe_out="$(env -i PATH="$PATH" HOME="$HOME" CLAUDE_CONFIG_DIR="$_probe_cfg" \
        ANTHROPIC_API_KEY="$_svc_apikey" \
        claude --print "ping" 2>&1)" && _probe_rc=0 || _probe_rc=$?
    fi
    _probe_out=${_probe_out:0:200}
    if [ "$_probe_rc" -eq 0 ] && [ -n "$_probe_out" ]; then
      INSTALL_AUTH_STATE="OK"
    else
      INSTALL_AUTH_STATE="BROKEN"
    fi
  else
    INSTALL_AUTH_STATE="UNKNOWN"
  fi
  [ -z "$_probe_cfg" ] || rm -rf "$_probe_cfg" 2>/dev/null || true
fi
unset _svc_token _svc_apikey

case "$INSTALL_AUTH_STATE" in
  OK)
    ok "Auth ellenorizve a SZOLGALTATASOK utjan (izolalt konfig + a unitok hitelesitoje)"
    ;;
  UNKNOWN)
    warn "Az auth-ot NEM tudtam ellenorizni (nincs futtathato claude vagy nincs halozat)."
    echo -e "    ${DIM}A telepites folytatodik, de az ugynokok indulasa nincs igazolva.${NC}"
    echo -e "    ${DIM}Ellenorzes kesobb: ${BLUE}bash \"$INSTALL_DIR/scripts/doctor.sh\"${NC}"
    ;;
  *)
    warn "AZ UGYNOKOK IGY NEM FOGNAK ELINDULNI: a telepites nem hordoz mukodo auth kulcsot."
    echo -e "    ${DIM}A szolgaltatasok CSAK ezt a ket helyet olvassak:${NC}"
    echo -e "    ${DIM}  - $INSTALL_DIR/.env  (CLAUDE_CODE_OAUTH_TOKEN vagy ANTHROPIC_API_KEY)${NC}"
    echo -e "    ${DIM}  - $INSTALL_DIR/store/.claude-oauth-token${NC}"
    echo -e "    ${DIM}Ha a terminalodban mukodik a claude, az NEM eleg: a systemd unit${NC}"
    echo -e "    ${DIM}nem olvassa a ~/.bashrc-t es a ~/.claude credentialt.${NC}"
    echo -e "    ${BOLD}Javitas most: ${BLUE}bash \"$INSTALL_DIR/scripts/auth.sh\"${NC}"
    ;;
esac

# SEEDRENDERLITERAL1108 / PERSONARENDERLITERAL1108: the persona renders and the seeding loops below render through the
# shared lib (scripts/lib/seed-refresh.sh render_seed_template / render_persona_file): a name typed here with &, / or \
# goes in literally, a failed render never truncates its target, and the seeded bytes are the ones the seed refresh
# compares against later. The lib ships in this tree; without it the tree is broken.
[ -f "$INSTALL_DIR/scripts/lib/seed-refresh.sh" ] && . "$INSTALL_DIR/scripts/lib/seed-refresh.sh"
command -v render_persona_file >/dev/null 2>&1 || fail "scripts/lib/seed-refresh.sh is missing: the install tree is incomplete"

# CLAUDE.md generalasa template-bol
if [ -f "$INSTALL_DIR/templates/CLAUDE.md.template" ]; then
  # PERSONARENDERLITERAL1108: the shared literal render, through a temp file (the target is never truncated)
  RENDER_CHAT_ID="$CHAT_ID" RENDER_TIMEZONE="$(. "$INSTALL_DIR/scripts/lib/install-tz.sh"; z="$(install_tz "$INSTALL_DIR")"; printf '%s' "${z:-UTC}")" \
    render_persona_file "$(. "$INSTALL_DIR/scripts/lib/persona-template.sh"; persona_template "$INSTALL_DIR" CLAUDE.md.template decide)" "$INSTALL_DIR/CLAUDE.md" \
    || fail "CLAUDE.md could not be rendered from its template; nothing was written"
  ok "CLAUDE.md generalva"
else
  warn "CLAUDE.md.template nem talalhato, CLAUDE.md nem generalhato"
fi

# SOUL.md generalasa template-bol (personality definition for the main agent).
if [ -f "$INSTALL_DIR/templates/SOUL.md.template" ] && [ ! -f "$INSTALL_DIR/SOUL.md" ]; then
  render_persona_file "$(. "$INSTALL_DIR/scripts/lib/persona-template.sh"; persona_template "$INSTALL_DIR" SOUL.md.template decide)" "$INSTALL_DIR/SOUL.md" \
    || fail "SOUL.md could not be rendered from its template; nothing was written"
  ok "SOUL.md generalva"
elif [ ! -f "$INSTALL_DIR/templates/SOUL.md.template" ] && [ ! -f "$INSTALL_DIR/SOUL.md" ]; then
  warn "SOUL.md.template nem talalhato, SOUL.md nem generalhato"
fi

# Default scheduled tasks scaffoldolasa ~/.claude/scheduled-tasks/ ala. A
# template-ek {{MAIN_AGENT_ID}} placeholdert hasznalnak, igy a felhasznalo
# valasztott agent slugja kerul be a hardcoded "marveen" helyett. Letezo task
# konyvtarakat soha nem irjuk felul.
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
    ok "Utemezett feladat scaffoldolva: $task_name"
  done
fi

# PERSONAESC1107 seed A: the seeders' language (scripts/lib/seed-lang.sh, read only: the persona render above decided it).
# On en a seeded Markdown file comes from i18n/en/<its repo path> when that exists. Without the lib, Hungarian as before.
SEED_LANG=hu
if [ -f "$INSTALL_DIR/scripts/lib/seed-lang.sh" ]; then
  . "$INSTALL_DIR/scripts/lib/seed-lang.sh"
  SEED_LANG="$(seed_lang "$INSTALL_DIR")"
fi

# Seed scheduled tasks: from seed-scheduled-tasks/ into ~/.claude/scheduled-tasks/
# Idempotent: skip directories that already exist. Templates use {{MAIN_AGENT_ID}},
# {{BOT_NAME}}, {{OWNER_NAME}}, {{INSTALL_DIR}} placeholders.
SEED_SCHED_DIR="$INSTALL_DIR/seed-scheduled-tasks"
if [ -d "$SEED_SCHED_DIR" ]; then
  mkdir -p "$SCHED_TARGET_DIR"
  SCHED_NEW=0
  SCHED_SKIP=0
  SCHED_TOMBSTONE="$SCHED_TARGET_DIR/.removed-defaults"
  for tpl in "$SEED_SCHED_DIR"/*/; do
    [ -d "$tpl" ] || continue
    task_name=$(basename "$tpl")
    [[ "$task_name" == "bumblebee-hygiene-scan" ]] && continue
    target="$SCHED_TARGET_DIR/$task_name"
    # #796: a reinstall over an existing box must honor the dashboard's record
    # of a deleted default (.removed-defaults); a UI re-create clears it.
    if [ -f "$SCHED_TOMBSTONE" ] && grep -qxF "$task_name" "$SCHED_TOMBSTONE" 2>/dev/null; then
      SCHED_SKIP=$((SCHED_SKIP + 1))
      continue
    fi
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
    ok "Seed scheduled tasks: ${SCHED_NEW} uj, ${SCHED_SKIP} kihagyva"
  fi
  if [ "$SCHED_NEW" -gt 0 ]; then
    STATE_FILE="$INSTALL_DIR/store/kanban-audit-state.json"
    if [ ! -f "$STATE_FILE" ]; then
      echo '{"last_audit_at":null}' > "$STATE_FILE"
      ok "kanban-audit state inicializalva"
    fi
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

# Seed bumblebee threat-intel catalogs into ~/.claude/tools/
BB_SEED_TI="$INSTALL_DIR/seed-scheduled-tasks/bumblebee-hygiene-scan/threat-intel"
BB_TARGET_TI="$HOME/.claude/tools/bumblebee-threat-intel"
if [ -d "$BB_SEED_TI" ] && [ ! -d "$BB_TARGET_TI" ]; then
  mkdir -p "$BB_TARGET_TI"
  cp "$BB_SEED_TI"/*.json "$BB_TARGET_TI/" 2>/dev/null
  ok "Bumblebee threat-intel katalogusok telepitve"
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
      ok "Seed config: $cfg_name"
    fi
  done
fi

# Channel state directory setup
CHANNEL_DIR="$HOME/.claude/channels/$CHANNEL_PROVIDER"
# GROMZONOPROVIDER1108: gromzo keeps no channel state here (no token, no access.json), so no empty dir for it.
[ "$CHANNEL_PROVIDER" = "gromzo" ] || mkdir -p "$CHANNEL_DIR"

if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ -n "$BOT_TOKEN" ]; then
  (umask 077 && echo "TELEGRAM_BOT_TOKEN=$BOT_TOKEN" >"$CHANNEL_DIR/.env")
  chmod 600 "$CHANNEL_DIR/.env"
  cat >"$CHANNEL_DIR/access.json" <<ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
ACCESSEOF
  ok "$(_t linux.tg_channel_configured)"
elif [ "$CHANNEL_PROVIDER" = "slack" ] && [ -n "$SLACK_BOT_TOKEN" ]; then
  (umask 077 && cat >"$CHANNEL_DIR/.env" <<SLACKENVEOF
SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN
SLACK_APP_TOKEN=$SLACK_APP_TOKEN
SLACKENVEOF
  )
  chmod 600 "$CHANNEL_DIR/.env"
  cat >"$CHANNEL_DIR/access.json" <<ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "channels": {},
  "pending": {}
}
ACCESSEOF
  ok "$(_t linux.slack_channel_configured)"
elif [ "$CHANNEL_PROVIDER" = "discord" ] && [ -n "$DISCORD_BOT_TOKEN" ]; then
  (umask 077 && cat >"$CHANNEL_DIR/.env" <<DISCORDENVEOF
DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN
DISCORD_CHANNEL_ID=$DISCORD_CHANNEL_ID
DISCORDENVEOF
  )
  chmod 600 "$CHANNEL_DIR/.env"
  cat >"$CHANNEL_DIR/access.json" <<ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "channels": {},
  "pending": {}
}
ACCESSEOF
  ok "$(_t linux.discord_channel_configured)"
elif [ "$CHANNEL_PROVIDER" = "teams" ] && [ -n "$TEAMS_BOT_APP_ID" ]; then
  # EE2392D3: the plugin's own keys (setup-azure-bot.sh writes the same three plus the type).
  (umask 077 && cat >"$CHANNEL_DIR/.env" <<TEAMSENVEOF
TEAMS_BOT_APP_ID=$TEAMS_BOT_APP_ID
TEAMS_BOT_APP_PASSWORD=$TEAMS_BOT_APP_PASSWORD
TEAMS_BOT_TENANT_ID=$TEAMS_BOT_TENANT_ID
TEAMS_BOT_APP_TYPE=SingleTenant
TEAMSENVEOF
  )
  chmod 600 "$CHANNEL_DIR/.env"
  [ -f "$CHANNEL_DIR/access.json" ] || cat >"$CHANNEL_DIR/access.json" <<ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
ACCESSEOF
  ok "$(_t linux.teams_channel_configured)"
fi

# EE2392D3: the Teams plugin is not on Claude Code's built-in channel-plugin list, so a teams install needs it in
# the machine-wide managed-settings allowlist, or the bot looks online and never answers (inbound dropped). The
# same shared writer as macOS (MANAGEDSETTINGSWRITE1103, scripts/lib/managed-settings-write.py --add-plugin): it
# merges, keeps every other key and the file mode, and refuses a file it cannot parse. All four channel plugins,
# as on macOS: once the list exists it REPLACES the built-in one, so a teams-only entry would mute a Telegram or
# Discord agent on this host. Root as for the channelsEnabled write above; asked first as the user, so a file
# that already allows all four needs no privilege.
TEAMS_ALLOWLIST_PLUGINS="slack-channel@marveen-marketplace telegram@claude-plugins-official teams@marveen-marketplace discord@claude-plugins-official"
managed_allows_all() { # $1 = the managed file, then NAME@MARKET...; 0 only when every one is listed
  python3 -I -S - "$@" 2>/dev/null <<'MAA_PY'
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
sys.exit(0 if all(w in have for w in want) else 1)
MAA_PY
}
if [ "$CHANNEL_PROVIDER" = "teams" ]; then
  TEAMS_MANAGED_FILE="/etc/claude-code/managed-settings.json" # fixed: a root write never takes its target from the environment
  # shellcheck disable=SC2086
  if managed_allows_all "$TEAMS_MANAGED_FILE" $TEAMS_ALLOWLIST_PLUGINS; then
    ok "Teams engedelyezve a managed-settings allowlistben ($TEAMS_MANAGED_FILE)"
  else
    managed_settings_notice
    _ms_priv=""
    [ "$(id -u)" -eq 0 ] || _ms_priv="sudo"
    _ms_args=()
    for _p in $TEAMS_ALLOWLIST_PLUGINS; do _ms_args+=(--add-plugin "$_p"); done
    if $_ms_priv mkdir -p "$(dirname "$TEAMS_MANAGED_FILE")" 2>/dev/null \
      && $_ms_priv python3 -I "$INSTALL_DIR/scripts/lib/managed-settings-write.py" "$TEAMS_MANAGED_FILE" --create "${_ms_args[@]}"; then
      ok "Teams engedelyezve a managed-settings allowlistben ($TEAMS_MANAGED_FILE)"
    else
      warn "A managed-settings allowlist nem volt frissitheto, a fajl ERINTETLEN maradt. Teams nelkule a bot nem valaszol."
      echo -e "  ${DIM}Kezi potlas (root):${NC}"
      echo -e "  ${DIM}  sudo python3 -I $INSTALL_DIR/scripts/lib/managed-settings-write.py $TEAMS_MANAGED_FILE --create ${_ms_args[*]}${NC}"
    fi
    unset _ms_priv _ms_args _p
  fi
fi

# Channel plugin install
# GROMZONOPROVIDER1108: on gromzo there is no channel plugin to install here; the Gromzo plugin comes with the Bridge's
# Gromzo step (marveen-mxd's payload).
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
elif [ "$CHANNEL_PROVIDER" = "teams" ]; then
  PLUGIN_MARKETPLACE="Szotasz/marveen-marketplace"
  PLUGIN_ID="teams@marveen-marketplace"
  PLUGIN_SHORT="teams"
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
  echo -e "  ${ORANGE}Elso probalkozas sikertelen, ujraprobalok...${NC}"
  sleep 2
  if claude plugin install "$PLUGIN_ID" 2>/dev/null; then
    ok "${CHANNEL_PROVIDER} plugin telepitve (masodik probalkozesal)"
  else
    echo -e "  ${RED}✗${NC} ${CHANNEL_PROVIDER} plugin telepites sikertelen."
    echo -e "  ${DIM}  (Lehetseges ok: Claude meg nincs bejelentkezve)${NC}"
    echo -e "  Bejelentkezes utan futtasd:"
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

# skill-factory telepitese (self-learning meta-skill)
SKILLS_DIR="$HOME/.claude/skills"
if [ -d "$INSTALL_DIR/skills/skill-factory" ]; then
  mkdir -p "$SKILLS_DIR/skill-factory"
  cp -r "$INSTALL_DIR/skills/skill-factory/"* "$SKILLS_DIR/skill-factory/"
  ok "skill-factory telepitve"
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
    ok "Seed skills: ${SEED_NEW} uj, ${SEED_SKIP} kihagyva (mar letezik)"
  fi
fi

INSTALL_STEP="ollama-whisper"
# ─────────────────────────────────────────────
# [6/7] Ollama + Whisper
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}$(_t section_6_linux)${NC}"

# --- Ollama telepites ---
#
# Where the RUNTIME will look. src/config.ts:331 reads OLLAMA_URL and falls back
# to http://localhost:11434; this step used to hardcode that fallback in seven
# places, so an install pointed at a non-default or remote Ollama probed and
# pulled the embedding model somewhere the running fleet would never read --
# and installed a second, local daemon it did not need. Same precedence as the
# runtime: the environment first, then the .env this installer has already
# written, then the historical default.
OLLAMA_API="${OLLAMA_URL:-}"
if [ -z "$OLLAMA_API" ] && [ -f "$INSTALL_DIR/.env" ]; then
  OLLAMA_API="$(grep -E '^OLLAMA_URL=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- | tr -d ' "')"
fi
OLLAMA_API="${OLLAMA_API:-http://localhost:11434}"

echo -e "  Ollama ellenorzese (szemantikus memoria kereseshez)..."
if curl -s --max-time 5 "${OLLAMA_API}/api/version" &>/dev/null; then
  # Answering already: nothing to install, wherever it happens to run.
  ok "ollama elerheto (${OLLAMA_API})"
elif command -v ollama &>/dev/null; then
  ok "ollama mar telepitve"
else
  echo -e "  Ollama telepitese..."
  # Az ollama telepitoje sudo-val ir a /usr/local/bin-be es allit be systemd service-t.
  # Elore gyorsitotarazzuk a sudo hitelesitest, hogy a gyermek-script sudo prompt-ja ne bukjon el.
  sudo -v 2>/dev/null || true
  # zstd -- az ollama telepitoje ezzel csomagolja ki a binarist; nincs alapertelmezetten telepitve friss WSL distron,
  # nelkule "ERROR: This version requires zstd for extraction" hibaval elhasal.
  command -v zstd &>/dev/null || pkg_install_noninteractive zstd || true
  # NEM fatalis: ha az ollama telepitoje hibara fut (pl. sudo, halozat, WSL),
  # csak figyelmeztetunk es kihagyjuk a szemantikus memoria lepest -- a telepito megy tovabb.
  if curl -fsSL https://ollama.com/install.sh | sh; then
    ok "ollama telepitve"
  else
    warn "ollama telepitese sikertelen -- a szemantikus memoria kereses kimarad."
    echo -e "  ${DIM}Kesobb kezzel: sudo -v && curl -fsSL https://ollama.com/install.sh | sh${NC}"
  fi
fi

# The service-start + model-pull block runs when there is a local binary to
# start OR an API to pull through -- a remote/containerised Ollama has no local
# binary, but the model still has to exist on it.
if command -v ollama &>/dev/null || curl -s --max-time 5 "${OLLAMA_API}/api/version" &>/dev/null; then
# A telepito letrehoz egy ollama.service systemd egységet és elindítja.
# Ha megis nem futna, systemctl-lel indítjuk -- NEM ollama serve &
if ! curl -s --max-time 5 "${OLLAMA_API}/api/version" &>/dev/null; then
  echo -e "$(_t linux.ollama_starting)"
  sudo systemctl enable --now ollama 2>/dev/null || true
  # Megvarjuk amig az API valaszol (max 15 mp)
  for i in $(seq 1 15); do
    curl -s --max-time 5 "${OLLAMA_API}/api/version" &>/dev/null && break
    sleep 1
  done
fi

# Modell letoltese az Ollama HTTP API-n keresztul (CLI script-ben ismert TTY-bug miatt)
# stream:false --> szinkron, egyetlen valaszt ad vissza a letoltes utan
ollama_pull() {
  local model="$1" size="$2"
  # API-up guard (BC100FAIL810): this whole step is declared optional/non-fatal,
  # but on a host where the ollama BINARY installed yet its SERVICE never came up
  # (no ollama.service unit, API at :11434 dead -- measured on ai-bootcamp-vps100
  # 2026-08-10), the pull below would abort the whole install. Under `set -e` the
  # `status=$(curl ... | python3 json.load)` assignment inherits the pipeline's
  # exit code -- an empty curl (connection refused) makes json.load raise, python3
  # exits non-zero, the assignment inherits it, and the ERR trap kills the
  # install at step "ollama-whisper". So skip -- non-fatal -- whenever the API is
  # not answering, instead of trying a pull that cannot work.
  if ! curl -s --max-time 5 "${OLLAMA_API}/api/version" &>/dev/null; then
    warn "ollama API nem valaszol (${OLLAMA_API}) -- $model letoltese kimarad (a szolgaltatas nem all fel). Kesobb: ollama serve && ollama pull $model"
    return 0
  fi
  if curl -s --max-time 5 "${OLLAMA_API}/api/tags" | grep -q "\"$model\""; then
    ok "$model mar letoltve"
    return 0
  fi
  echo -e "  $model letoltese ($size)..."
  local status
  # `|| status=""` is load-bearing under `set -e`: a command-substitution
  # assignment aborts the script when its pipeline exits non-zero (empty body ->
  # json.load raises -> python3 exits 1). The guard turns that into the warn path.
  status=$(curl -s --max-time 600 \
    -X POST "${OLLAMA_API}/api/pull" \
    -H 'Content-Type: application/json' \
    -d "{\"model\": \"$model\", \"stream\": false}" |
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null) || status=""
  if [ "$status" = "success" ]; then
    ok "$model kesz"
  else
    warn "$model letoltese sikertelen (status: ${status:-<ures valasz>}) -- kezzel: ollama pull $model"
  fi
}

# nomic-embed-text (szemantikus memoria, kotelozo)
ollama_pull "nomic-embed-text" "~274 MB"
fi  # command -v ollama

# --- Whisper (opcionalis) ---
echo ""
echo -e "  Whisper telepites (beszed -> szoveg leirat, opcionalis)..."
if command -v whisper &>/dev/null; then
  ok "whisper mar telepitve"
else
  read -rp "$(_t prompt_whisper)" DO_WHISPER
  DO_WHISPER=${DO_WHISPER:-n}
  if [ "$DO_WHISPER" = "i" ]; then
    pipx install openai-whisper 2>/dev/null &&
      ok "openai-whisper telepitve" ||
      warn "whisper telepites sikertelen (kezzel: pipx install openai-whisper)"
  else
    echo -e "  ${DIM}Kihagyva. Kesobb: pipx install openai-whisper${NC}"
  fi
fi

INSTALL_STEP="bumblebee"
# ─────────────────────────────────────────────
# Go + bumblebee (supply-chain scanner)
# ─────────────────────────────────────────────
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
  ok "$(go version | grep -oE 'go[0-9]+\.[0-9.]+')"
else
  echo -e "  ${ORANGE}!${NC} Go >= 1.25 szukseges -- telepites..."
  _GO_INSTALLED=false
  # 1. snap (Ubuntu/Debian desktop, Fedora, Nobara)
  if command -v snap &>/dev/null; then
    echo -e "  snap install go --classic..."
    if sudo snap install go --classic 2>/dev/null; then
      export PATH="/snap/bin:$PATH"
      _GO_INSTALLED=true
      ok "Go telepitve (snap)"
    fi
  fi
  # 2. Hivatalos tarball fallback (ha snap nem elerheto vagy sikertelen)
  if [ "$_GO_INSTALLED" = "false" ]; then
    echo -e "  Hivatalos Go tarball letoltese (go.dev/dl)..."
    _ARCH=$(uname -m)
    case "$_ARCH" in
      x86_64)  _GOARCH="amd64" ;;
      aarch64) _GOARCH="arm64" ;;
      armv7l)  _GOARCH="armv6l" ;;
      *)       _GOARCH="" ;;
    esac
    if [ -n "$_GOARCH" ]; then
      _GOVERSION=$(curl -fsSL "https://go.dev/dl/?mode=json" 2>/dev/null \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['version'])" 2>/dev/null \
        || echo "go1.25.0")
      _GOTAR="${_GOVERSION}.linux-${_GOARCH}.tar.gz"
      if curl -fsSL "https://go.dev/dl/${_GOTAR}" -o "/tmp/${_GOTAR}" 2>/dev/null; then
        # set -e + trap ERR van eletben: a kicsomagolas bukasa NE allitsa le a
        # telepitest, csak hagyja ki bumblebee-t.
        sudo rm -rf /usr/local/go 2>/dev/null || true
        if sudo tar -C /usr/local -xzf "/tmp/${_GOTAR}" 2>/dev/null; then
          export PATH="$PATH:/usr/local/go/bin"
          ensure_in_rc '/usr/local/go/bin' 'export PATH="$PATH:/usr/local/go/bin"'
          _GO_INSTALLED=true
          ok "Go telepitve (/usr/local/go): ${_GOVERSION}"
        else
          echo -e "  ${RED}✗${NC} Go tarball kicsomagolas sikertelen."
        fi
        rm -f "/tmp/${_GOTAR}"
      else
        echo -e "  ${RED}✗${NC} Go tarball letoltes sikertelen."
      fi
    else
      echo -e "  ${RED}✗${NC} Ismeretlen CPU architektura ($_ARCH) -- Go nem telepitheto automatikusan."
    fi
  fi
  if [ "$_GO_INSTALLED" = "false" ]; then
    echo -e "  ${ORANGE}!${NC} Go telepites sikertelen -- bumblebee kihagyva."
    echo -e "  ${DIM}  Kezzel: sudo snap install go --classic  VAGY  https://go.dev/dl${NC}"
  fi
fi

BUMBLEBEE_BIN="$HOME/.local/bin/bumblebee"
if [ -x "$BUMBLEBEE_BIN" ]; then
  ok "bumblebee mar telepitve ($BUMBLEBEE_BIN)"
elif _go_version_ok; then
  echo -e "  bumblebee build forrasbol (github.com/perplexityai/bumblebee)..."
  mkdir -p "$HOME/.local/bin"
  _BB_TMP=$(mktemp -d)
  if git clone -q --depth 1 --branch v0.1.2 https://github.com/perplexityai/bumblebee.git "$_BB_TMP" 2>/dev/null; then
    if (cd "$_BB_TMP" && go build -o "$BUMBLEBEE_BIN" ./cmd/bumblebee 2>/dev/null); then
      chmod +x "$BUMBLEBEE_BIN"
      ok "bumblebee telepitve: $BUMBLEBEE_BIN"
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
  echo -e "  ${DIM}  Kezzel: sudo snap install go --classic && git clone https://github.com/perplexityai/bumblebee /tmp/bb && (cd /tmp/bb && go build -o ~/.local/bin/bumblebee ./cmd/bumblebee)${NC}"
fi

INSTALL_STEP="systemd"
# ─────────────────────────────────────────────
# [7/7] Automatikus inditas (systemd)
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}$(_t section_7)${NC}"

SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

NODE_PATH="$(which node)"
# Unit names key off SERVICE_ID. SERVICE_ID == MAIN_AGENT_ID for a brand-unaware
# (default) install, so these unit names are unchanged unless the operator chose
# a distinct brand above. The channels unit still runs channels.sh, which names
# its tmux session ${MAIN_AGENT_ID}-channels (the session id the backend uses);
# the unit name and the session name are independent.
DASH_UNIT="${SERVICE_ID}-dashboard"
CHAN_UNIT="${SERVICE_ID}-channels"
MORN_UNIT="${SERVICE_ID}-morning"
KEEPALIVE_UNIT="${SERVICE_ID}-channel-keepalive-probe"
INBOX_OBSERVER_UNIT="${SERVICE_ID}-main-inbox-observer"

# Detect the host timezone so the scheduled-task runner (which reads
# cron expressions in Node's local TZ) fires at the operator's wall
# clock, not the VPS UTC default. If detection fails or the host is
# already UTC, we emit a comment instead so the unit stays explicit.
SYSTEM_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || true)"
SYSTEM_TZ="${SYSTEM_TZ%$'\n'}"
if [ -n "$SYSTEM_TZ" ] && [ "$SYSTEM_TZ" != "Etc/UTC" ] && [ "$SYSTEM_TZ" != "UTC" ]; then
  TZ_LINE="Environment=TZ=$SYSTEM_TZ"
else
  TZ_LINE="# no explicit TZ detected; inheriting host default"
fi

# ${DASH_UNIT}.service
cat >"$SYSTEMD_DIR/${DASH_UNIT}.service" <<EOF
[Unit]
Description=${BOT_NAME} Dashboard
After=network.target

[Service]
Type=simple
# KillMode=process: the dashboard spawns sub-agent tmux sessions (claude
# processes) that live in this unit's cgroup. With the default
# control-group kill mode, every dashboard restart/deploy would SIGKILL
# the whole cgroup and take all running agents down with it (only the
# main agent survives via its own channels unit). process mode kills only
# the node main process on stop/restart, leaving the agents running.
KillMode=process
WorkingDirectory=$INSTALL_DIR
# Rebuild the better-sqlite3 native binding if it can't load for the current
# Node ABI before starting. Prevents the "Could not locate the bindings file"
# crash-loop after an npm install / Node upgrade (root-caused 2026-07-03: ~350
# restarts, StartLimit hit, dashboard + channels down ~42 min).
ExecStartPre=$INSTALL_DIR/scripts/ensure-native-modules.sh
ExecStart=$NODE_PATH $INSTALL_DIR/dist/index.js
Restart=on-failure
RestartSec=5
# Raise the file-descriptor limit: the dashboard makes many tmux subprocess
# calls + holds MCP/SSE connections; the default soft limit (often 1024, or 256
# under launchd on macOS) is exhausted once enough agents are active -> EMFILE,
# silent HTTP-listener flap + "can't find session" tmux failures (2026-06-27).
LimitNOFILE=16384
StandardOutput=append:$INSTALL_DIR/store/dashboard.log
StandardError=append:$INSTALL_DIR/store/dashboard.error.log
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
${TZ_LINE}

[Install]
WantedBy=default.target
EOF

# ${CHAN_UNIT}.service
cat >"$SYSTEMD_DIR/${CHAN_UNIT}.service" <<EOF
[Unit]
Description=${BOT_NAME} Channels (${CHANNEL_PROVIDER})
After=network.target
# StartLimit* belong in [Unit], not [Service] (systemd logs "Unknown key
# StartLimitIntervalSec in section [Service]" and ignores them there), so the
# crash-loop throttle only applies when they live here.
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
# KillMode=process: the first tmux new-session from channels.sh starts the
# SHARED tmux server in this unit's cgroup, and every sub-agent session lives
# there too. Default control-group mode would SIGKILL the whole fleet on a
# stop/restart (only the main agent's own unit). process mode kills only
# channels.sh; the tmux server and all agents survive. channels.sh kill-sessions
# its own "\$SESSION" before new-session so the surviving session doesn't collide.
KillMode=process
WorkingDirectory=$INSTALL_DIR
# See the dashboard unit: rebuild the better-sqlite3 native binding if it can't
# load for the current Node ABI before starting (2026-07-03 crash-loop fix).
ExecStartPre=$INSTALL_DIR/scripts/ensure-native-modules.sh
ExecStart=$INSTALL_DIR/scripts/channels.sh
# Restart=always, NOT on-failure. channels.sh has watchdog branches that exit ON
# PURPOSE to be restarted (sustained plugin death, plugin never started), and
# under on-failure a zero exit read as "service finished" and the channel stayed
# dead for good -- silently, with no failed unit to notice. macOS never showed
# this because the launchd plist uses KeepAlive=true, which restarts regardless
# of exit code; this line is what makes the Linux side symmetric with it.
# Observed on a live v1.27.0 install 2026-08-04: unit inactive/dead after
# ExecMainStatus=0, ten minutes before anyone looked.
# Restart churn stays bounded by StartLimitIntervalSec/StartLimitBurst in
# [Unit] above plus channels.sh's own rapid-failure backoff (sleep 60/300).
Restart=always
RestartSec=10
StandardOutput=append:$INSTALL_DIR/store/channels.log
StandardError=append:$INSTALL_DIR/store/channels.error.log
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=USER=$USER
Environment=TERM=xterm-256color
Environment=LANG=${LANG:-en_US.UTF-8}
${TZ_LINE}

[Install]
WantedBy=default.target
EOF

# ${MORN_UNIT}.service (a timer hivja)
cat >"$SYSTEMD_DIR/${MORN_UNIT}.service" <<EOF
[Unit]
Description=${BOT_NAME} Reggeli Napindito

[Service]
Type=oneshot
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/scripts/morning-briefing.sh
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
${TZ_LINE}
EOF

# ${MORN_UNIT}.timer
# WRITTEN BUT NOT ENABLED (see the enable list further down). The morning
# briefing ships TWICE: as this 07:27 timer and as the seeded
# scheduled-tasks/reggeli-napindito task at 07:30. Two runs of the same work
# three minutes apart is one too many, and the timer is the weaker of the two:
# it launches a headless `claude -p` whose config dir carries no channel
# allowlist, so its reply tool rejects the owner's chat_id and the run refuses
# itself as a prompt injection (observed 2026-09-13, and it stamped the day as
# delivered on the way out). The scheduled task runs inside the live channel
# session, which has the allowlist. The unit files stay on disk so an operator
# who wants the timer path can `systemctl --user enable --now <id>-morning.timer`,
# but only with ANTHROPIC_API_KEY in the install .env: morning-briefing.sh refuses
# to run its headless `claude -p` on the subscription login (MORNTIMER2197, #2197).
#
# NO Requires=/Wants= on the service here: a [Unit] dependency on the
# triggered service makes EVERY activation of the timer unit (each systemd
# user-manager start, not just the 07:27 elapse) queue an immediate start of
# the briefing service. Under user-manager restart churn that multiplied the
# morning briefing (customer report 2026-07-26: 5 deliveries in one day).
# The [Timer] section binds to ${MORN_UNIT}.service by name on elapse, which
# is the only coupling a timer needs.
cat >"$SYSTEMD_DIR/${MORN_UNIT}.timer" <<EOF
[Unit]
Description=${BOT_NAME} Reggeli Napindito Timer

[Timer]
OnCalendar=*-*-* 07:27:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# ${KEEPALIVE_UNIT}.service/.timer -- token-free IDLE-path keepalive producer.
#
# WHY THIS MUST BE INSTALLED (measured on a live install, night of 2026-09-12/13:
# 13 service restarts, one every ~50 minutes, all night). store/.channel-keepalive
# has two intended producers: organic inbound (channel-monitor advances the mtime
# on every ingested message -- covers BUSY periods) and this probe (covers QUIET
# periods). The repo shipped scripts/channel-keepalive-probe.sh plus placeholder
# units under scripts/systemd/, but nothing installed them, so on a real host the
# ONLY producer was inbound traffic. Every night, as soon as the owner stopped
# writing, the file aged past the dashboard's 45-minute liveness ceiling and
# channel-monitor "recovered" a perfectly healthy session: respawn-pane (the main
# agent's conversation gone, restarted fresh with no --continue), which killed the
# telegram plugin with it, which tripped channels.sh's own dead-plugin watchdog
# 181s later, which exited 1 for a second, whole-unit restart. A silent channel is
# normal at 3am; the watchdog read it as a wedge because nothing was left to prove
# otherwise.
#
# The probe does NOT fake liveness: it touches the keepalive only after proving
# from the process tree that the channels tmux session, its claude pid, and a
# telegram poller descending from that pid are all alive. A genuinely dead pipe
# still ages out and still gets recovered.
cat >"$SYSTEMD_DIR/${KEEPALIVE_UNIT}.service" <<EOF
[Unit]
Description=${BOT_NAME} token-free idle-path channel keepalive probe

[Service]
Type=oneshot
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/scripts/channel-keepalive-probe.sh
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
${TZ_LINE}
StandardOutput=append:$INSTALL_DIR/store/channel-keepalive-probe.log
StandardError=append:$INSTALL_DIR/store/channel-keepalive-probe.log
EOF

# Same "no Requires=/Wants= on the triggered service" rule as the morning timer
# above: the [Timer] section already binds to ${KEEPALIVE_UNIT}.service by name.
# 3 minutes is far inside every consumer's staleness threshold (the dashboard's
# 45-minute ceiling, channel-watchdog's 15).
cat >"$SYSTEMD_DIR/${KEEPALIVE_UNIT}.timer" <<EOF
[Unit]
Description=${BOT_NAME} channel keepalive probe every 3 minutes

[Timer]
OnBootSec=90s
OnUnitActiveSec=3min
AccuracySec=20s

[Install]
WantedBy=timers.target
EOF

# ${INBOX_OBSERVER_UNIT}.service/.timer -- the main agent's inbox queue, watched
# from OUTSIDE the dashboard process. Every other delivery path is watched by
# something; the main agent's is not, and its only in-process reader lives in
# the dashboard itself, so a stopped or wedged dashboard takes the watcher down
# with it and mail to the main agent sits pending with nobody to notice.
#
# The repo shipping the script is not enough -- that is the exact defect the
# observer's own header names about the unscheduled watchdog script, and it is
# why this block exists next to the keepalive probe rather than in a README.
cat >"$SYSTEMD_DIR/${INBOX_OBSERVER_UNIT}.service" <<EOF
[Unit]
Description=${BOT_NAME} out-of-process observer of the main agent's inbox queue

[Service]
Type=oneshot
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/scripts/main-inbox-observer.sh
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
${TZ_LINE}
StandardOutput=append:$INSTALL_DIR/store/main-inbox-observer.log
StandardError=append:$INSTALL_DIR/store/main-inbox-observer.log
EOF

# Deliberately NOT bound to the dashboard unit: "the dashboard is down" is one
# of the states this observes, so the timer has to survive it. Six ticks fit
# inside the 30-minute stall threshold, so one missed tick cannot push the
# alert past the window.
cat >"$SYSTEMD_DIR/${INBOX_OBSERVER_UNIT}.timer" <<EOF
[Unit]
Description=${BOT_NAME} main-agent inbox observer every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF

# marveen-host-watchdog.service -- host/WSL-VM restart detector (btime-based).
# Distinguishes a whole-VM restart (all units down at once, NOT an app crash)
# from a service crash, and Telegrams it. See scripts/host-restart-watchdog.sh.
cat >"$SYSTEMD_DIR/${SERVICE_ID}-host-watchdog.service" <<EOF
[Unit]
Description=${BOT_NAME} host/WSL-VM restart watchdog (btime-based)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$INSTALL_DIR/scripts/host-restart-watchdog.sh
Environment=MARVEEN_STORE=$INSTALL_DIR/store
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
${TZ_LINE}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

# marveen-notify@.service -- templated app-crash notifier, fired by OnFailure=
# drop-ins on the dashboard/channels units. OnFailure => app crash (vs the
# host-watchdog's btime-change => host restart).
cat >"$SYSTEMD_DIR/${SERVICE_ID}-notify@.service" <<EOF
[Unit]
Description=${BOT_NAME} app-crash notifier for %i

[Service]
Type=oneshot
ExecStart=$INSTALL_DIR/scripts/unit-fail-notify.sh %i
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
${TZ_LINE}
StandardOutput=journal
StandardError=journal
EOF

# OnFailure drop-ins: wire the app-crash notifier onto the two long-running units.
for u in "${DASH_UNIT}" "${CHAN_UNIT}"; do
  mkdir -p "$SYSTEMD_DIR/${u}.service.d"
  cat >"$SYSTEMD_DIR/${u}.service.d/onfailure.conf" <<EOF
[Unit]
OnFailure=${SERVICE_ID}-notify@%n.service
EOF
done

# 1. linger eloszor: ez engedelyezi a user systemd sessiont boot utan is,
#    es headless-en az aktualis script futasa alatt is szukseges lehet
if loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  ok "loginctl linger mar engedelyezve ($USER)"
elif sudo loginctl enable-linger "$USER" 2>/dev/null; then
  ok "loginctl linger engedelyezve ($USER)"
else
  warn "loginctl linger nem sikerult -- a servicek esetleg nem indulnak el boot utan (sudo szukseges)"
fi

# 2. XDG_RUNTIME_DIR + DBUS garantalasa systemctl --user-hoz
#    (a korabbi XDG-blokk csak headless-detektalasnál fut, itt mindig kell)
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR}/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
fi

# 3. Inditás -- systemd ha elerheto, kulonben kozvetlen nohup (mint start.sh).
#    WSL / konteneren / user-session nelkuli VPS-en a `systemctl --user` NEM
#    mukodik. A korabbi kod ott csak `... start ... || true`-t hivott fallback
#    nelkul -> a Telegram bridge SOHA nem indult el, es a parositasnal a bot
#    nemanak tunt ("hiaba irunk a botnak, nem jon semmi"). A direct-launch ag
#    ezt zarja be; a systemd unitok a helyukon maradnak, ha kesobb elerheto.
SVCFAIL=0
if pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  systemctl --user daemon-reload
  # The green tick used to print unconditionally after a `|| true`, so a failed
  # enable was reported as success -- the visible version of the same defect the
  # macOS branch had. `if` rather than `&&`: a failing enable inside an if
  # CONDITION is exempt from errexit and from the ERR trap, so the installer
  # reports it instead of dying on it.
  # ${MORN_UNIT}.timer is deliberately NOT in this list -- the seeded
  # reggeli-napindito scheduled task already delivers the morning briefing at
  # 07:30 from inside the live channel session. See the timer's comment above.
  if systemctl --user enable "${DASH_UNIT}" "${CHAN_UNIT}" "${KEEPALIVE_UNIT}.timer" "${INBOX_OBSERVER_UNIT}.timer" "${SERVICE_ID}-host-watchdog.service" 2>/dev/null; then
    ok "systemd unitok generalva es engedelyezve"
  else
    warn "A unit-fajlok elkeszultek, de az engedelyezesuk nem sikerult -- ujrainditas utan a szolgaltatasok nem indulnak el maguktol."
    # ALL FOUR units the enable above covers, not just the two services. A
    # command that silently drops the keepalive probe or the watchdog would leave
    # them disabled while the operator sees no error and believes the fix worked
    # -- an incomplete instruction ends the same way as a false claim.
    # The label gets its own line. With "Javitas most:" in front of the command,
    # the backslashes join all three printed lines into ONE command whose first
    # token is `Javitas`, so a pasted block fails with "Javitas: command not
    # found" and enables nothing. Measured by rendering the block and running it.
    # `bash -n` does NOT catch this: the pasted text is valid shell, just a
    # different command than the one we meant to offer. Same shape as
    # install-macos.sh, where the label is already on its own line.
    echo -e "  ${DIM}Javitas most:${NC}"
    echo -e "  ${DIM}systemctl --user enable \\${NC}"
    echo -e "  ${DIM}    ${DASH_UNIT} ${CHAN_UNIT} \\${NC}"
    echo -e "  ${DIM}    ${KEEPALIVE_UNIT}.timer ${INBOX_OBSERVER_UNIT}.timer ${SERVICE_ID}-host-watchdog.service${NC}"
  fi
  systemctl --user start "${DASH_UNIT}" "${CHAN_UNIT}" 2>/dev/null || true
  sleep 2
  for svc in "${DASH_UNIT}" "${CHAN_UNIT}"; do
    if systemctl --user is-active --quiet "$svc" 2>/dev/null; then
      ok "$svc fut"
    else
      echo -e "  ${RED}✗${NC} $svc nem indult el"
      echo -e "  ${DIM}Log: journalctl --user -u $svc -n 20${NC}"
      SVCFAIL=1
    fi
  done
  [ "$SVCFAIL" -eq 0 ] && ok "Mindket szolgaltatas fut"
  # TIMERSTART1011: `enable` alone does not start a timer. Both timers fire on
  # OnBootSec=90s, which on a host that has been up for a while has already
  # passed, so without a start they stay inactive until the next reboot. The
  # keepalive probe then never refreshes, and the channel monitor reads the
  # stale keep-alive as a wedged session and respawns the main agent (measured
  # on a fresh Linux install: three hard restarts in 80 minutes). One start per
  # timer, after the services, so a timer that failed to install can take down
  # neither the services nor the other timer, and a failed start never stops the
  # installer; not part of SVCFAIL, since the bridge itself runs, but named with
  # the fix.
  for tmr in "${KEEPALIVE_UNIT}.timer" "${INBOX_OBSERVER_UNIT}.timer"; do
    systemctl --user start "$tmr" 2>/dev/null || true
    if systemctl --user is-active --quiet "$tmr" 2>/dev/null; then
      ok "$tmr fut"
    else
      warn "$tmr nem fut -- inditsd: systemctl --user start $tmr"
    fi
  done
else
  warn "systemd --user nem elerheto (WSL / konteneren / VPS user-session nelkul) -- kozvetlen inditas."
  mkdir -p "$INSTALL_DIR/store"
  # Launch through start.sh rather than a second copy of its nohup lines. The
  # copy here never checked for a running instance, so re-running the installer
  # (the usual move after a half-failed install) started a SECOND channels.sh on
  # the same bot token -- two pollers splitting the incoming messages, no error
  # anywhere. start.sh's direct-launch branch is idempotent (flock + pidfile +
  # cmdline check), sets IS_SANDBOX for root, and writes the same pidfiles the
  # checks below read.
  bash "$INSTALL_DIR/scripts/start.sh" >>"$INSTALL_DIR/store/boot.log" 2>&1 || true
  sleep 3
  if kill -0 "$(cat "$INSTALL_DIR/store/dashboard.pid" 2>/dev/null)" 2>/dev/null; then
    ok "Dashboard fut (nohup, pid $(cat "$INSTALL_DIR/store/dashboard.pid"))"
  else
    echo -e "  ${RED}✗${NC} Dashboard nem indult el -- log: $INSTALL_DIR/store/dashboard.log"
    SVCFAIL=1
  fi
  if kill -0 "$(cat "$INSTALL_DIR/store/channels.pid" 2>/dev/null)" 2>/dev/null; then
    ok "Channels (Telegram bridge) fut (nohup, pid $(cat "$INSTALL_DIR/store/channels.pid"))"
  else
    echo -e "  ${RED}✗${NC} Channels nem indult el -- log: $INSTALL_DIR/store/channels.log"
    SVCFAIL=1
  fi
  echo -e "  ${DIM}Ujrainditas kesobb: ./scripts/start.sh${NC}"
  if [ "$IS_WSL" = "true" ]; then
    # Without systemd nothing restarts the services after a WSL restart, and
    # the installer used to stop at the one-line warning above.
    echo ""
    echo -e "  ${ORANGE}WSL-en a systemd nincs bekapcsolva, ezert a Marveen a WSL ujraindulasa utan nem indul el magatol.${NC}"
    echo -e "  ${DIM}Bekapcsolas: ird be az /etc/wsl.conf fajlba (sudo):${NC}"
    echo "    [boot]"
    echo "    systemd=true"
    echo -e "  ${DIM}majd Windows PowerShellben: wsl --shutdown, nyisd meg ujra az Ubuntut, es futtasd ujra ezt a telepitot.${NC}"
  fi
fi

# WSL2 shuts the whole VM down shortly after the last WSL window closes
# (vmIdleTimeout), and that stops every service with it -- systemd and linger do
# not help (scripts/systemd/README-host-stability.md). The fix lives on the
# Windows side and must not be written from Linux, so only detect and explain.
if [ "$IS_WSL" = "true" ]; then
  _wslcfg=""
  _cmd="$(command -v cmd.exe 2>/dev/null || echo /mnt/c/Windows/System32/cmd.exe)"
  _winprofile="$("$_cmd" /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')"
  [ -n "$_winprofile" ] && _wslcfg="$(wslpath -u "$_winprofile" 2>/dev/null)/.wslconfig"
  if [ -z "$_wslcfg" ] || ! grep -Eqi '^[[:space:]]*vmIdleTimeout[[:space:]]*=[[:space:]]*-1' "$_wslcfg" 2>/dev/null; then
    echo ""
    echo -e "  ${ORANGE}WSL: ha bezarod az utolso Ubuntu ablakot, a Windows par perc mulva leallitja a WSL-t, es vele a Marveent is.${NC}"
    echo -e "  ${DIM}Javitas Windowson: a %UserProfile%\\.wslconfig fajlba ird be:${NC}"
    echo "    [wsl2]"
    echo "    vmIdleTimeout=-1"
    echo -e "  ${DIM}majd PowerShellben egyszer: wsl --shutdown${NC}"
  fi
  unset _wslcfg _winprofile _cmd
fi

# ISSUE2472WSLSPIN1103 begin
# WSL before 3.0.1 has an interop bug: the threads of wslhost.exe can spin
# forever, and over hours or days the host's CPU is eaten (microsoft/WSL#41173,
# fixed by #41319, first shipped in 3.0.1). The fix is a Windows-side update,
# so only detect and explain. `wsl.exe --version` prints UTF-16LE (see the note
# at the top of install-windows.ps1): drop the NUL bytes before parsing. Best
# effort only: no wsl.exe, a hang (timeout), an empty or unreadable answer all
# stay silent, and nothing here may stop the install (set -e + ERR trap).
if [ "$IS_WSL" = "true" ]; then
  # 0 when $1 < $2, compared numerically component by component (2.10 > 2.9).
  _wsl_ver_lt() {
    local _a _b _i _x _y
    IFS=. read -r -a _a <<< "$1" || true
    IFS=. read -r -a _b <<< "$2" || true
    for _i in 0 1 2 3; do
      _x=$((10#${_a[$_i]:-0})); _y=$((10#${_b[$_i]:-0}))
      if [ "$_x" -lt "$_y" ]; then return 0; fi
      if [ "$_x" -gt "$_y" ]; then return 1; fi
    done
    return 1
  }
  _wslexe="$(command -v wsl.exe 2>/dev/null || true)"
  if [ -z "$_wslexe" ] && [ -x /mnt/c/Windows/System32/wsl.exe ]; then
    _wslexe=/mnt/c/Windows/System32/wsl.exe
  fi
  _wslver=""
  if [ -n "$_wslexe" ]; then
    if command -v timeout >/dev/null 2>&1; then
      _wslout="$(timeout 10 "$_wslexe" --version 2>/dev/null | LC_ALL=C tr -d '\000\r' || true)"
    else
      _wslout="$("$_wslexe" --version 2>/dev/null | LC_ALL=C tr -d '\000\r' || true)"
    fi
    # The first line is "WSL version: 2.7.10.0" (localized label, so match the
    # leading "WSL" and its separator, not "WSLg"); a BOM may precede it.
    _wslver="$(printf '%s\n' "$_wslout" | LC_ALL=C sed -n 's/^[^A-Za-z0-9]*WSL[^A-Za-z0-9][^0-9]*\([0-9][0-9]*\(\.[0-9][0-9]*\)\{1,3\}\).*/\1/p' | head -n 1 || true)"
  fi
  if [ -n "$_wslver" ] && _wsl_ver_lt "$_wslver" 3.0.1; then
    echo ""
    echo -e "  ${ORANGE}WSL ${_wslver}: ebben a regi WSL-verzioban ismert hiba van, amitol orak-napok alatt a wslhost.exe leterheli a gepet (a 3.0.1-es verziotol javitva).${NC}"
    echo -e "  ${DIM}Javitas Windows PowerShellben: wsl --update, utana: wsl --shutdown${NC}"
  fi
  unset _wslexe _wslout _wslver
  unset -f _wsl_ver_lt
fi
# ISSUE2472WSLSPIN1103 end

# Ellenorzes
sleep 3
echo ""
echo -e "${BOLD}$(_t section_checks)${NC}"
if { [ "$CHANNEL_PROVIDER" = "telegram" ] || [ "$CHANNEL_PROVIDER" = "teams" ]; } && ! command -v bun &>/dev/null; then
  echo -e "  ${RED}✗${NC} Bun nem talalhato. A ${CHANNEL_PROVIDER} plugin nem fog mukodni."
  echo -e "  ${BOLD}Javitas:${NC} curl -fsSL https://bun.sh/install | bash"
  echo -e "  ${DIM}Utana: source ~/.bashrc && ./scripts/start.sh${NC}"
fi
PLUGIN_CHECK_PATTERN="${CHANNEL_PROVIDER}"
if [ "$CHANNEL_PROVIDER" = "gromzo" ]; then
  ok "Gromzo: a csatorna-plugint a Bridge Gromzo-lepese ellenorzi"
elif ! claude plugin list 2>/dev/null | grep -q "$PLUGIN_CHECK_PATTERN"; then
  echo -e "  ${RED}✗${NC} ${CHANNEL_PROVIDER} plugin nincs telepitve."
  echo -e "  ${BOLD}Javitas:${NC} claude plugin install ${PLUGIN_ID}"
  echo -e "  ${DIM}Utana: systemctl --user restart ${CHAN_UNIT}${NC}"
else
  ok "${CHANNEL_PROVIDER} plugin ellenorizve"
fi

# INSTPAIRPATH930: the access.json the pairing must read AND write. channels.sh moves the
# shared $HOME/.claude/channels/<provider> dir into the install on its first start (#915,
# scripts/channels.sh MAIN_CHAN_DIR), and the plugin writes the pending code there, so the
# install-scoped file wins; the legacy path is only the fallback for a bridge that has not
# migrated yet. Resolved AFTER the code is typed in, when the bot has already answered.
_pairing_access_file() {
  local scoped="$INSTALL_DIR/.claude/channels/$CHANNEL_PROVIDER/access.json"
  if [ -f "$scoped" ]; then echo "$scoped"; else echo "$CHANNEL_DIR/access.json"; fi
}

# ─────────────────────────────────────────────
# Channel pairing (Telegram only; Slack uses OAuth / App install)
# ─────────────────────────────────────────────
if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ -n "$BOT_TOKEN" ]; then
  echo ""
  echo -e "${BOLD}Telegram parositas${NC}"


  # Is the Telegram bridge actually running?
  #
  # `systemctl --user is-active` alone answers a NARROWER question than this
  # step needs -- "does a systemd USER unit for it exist and run" -- and the two
  # answers diverge on exactly the hosts the [7/7] step already handles. There,
  # `pidof systemd` / `systemctl --user status` failing is not an error: the
  # installer falls back to a direct nohup launch and prints
  #   "Channels (Telegram bridge) fut (nohup, pid N)"
  # ...and then this check called the very bridge it had just started "not
  # started", skipped pairing, and left the install with ALLOWED_CHAT_ID=0 plus
  # a red warning telling the operator to pair by hand. WSL is a documented
  # supported platform and has no systemd user session by default, so this is
  # not an exotic shape.
  #
  # Ask the same three ways start.sh/stop.sh already distinguish -- user unit,
  # system unit, direct launch -- so pairing works wherever the launch worked.
  _bridge_is_up() {
    systemctl --user is-active --quiet "${CHAN_UNIT}" 2>/dev/null && return 0
    systemctl is-active --quiet "${CHAN_UNIT}" 2>/dev/null && return 0
    # The pidfile start.sh writes on its no-systemd branch. `kill -0` only
    # probes for existence; it sends no signal.
    local _pid
    _pid="$(cat "$INSTALL_DIR/store/channels.pid" 2>/dev/null)" || return 1
    [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null
  }

  # Megvarjuk amig a channels service tenyleg valaszol (max 15 mp)
  echo -e "  Varakozas a Telegram bridge elindulasara..."
  BRIDGE_OK=false
  for i in $(seq 1 15); do
    if _bridge_is_up; then
      BRIDGE_OK=true
      break
    fi
    sleep 1
  done

  if [ "$BRIDGE_OK" = "false" ]; then
    warn "A Telegram bridge nem indult el. Parositas kihagyva."
    echo -e "  ${DIM}systemd-vel:  journalctl --user -u ${CHAN_UNIT} -n 30${NC}"
    echo -e "  ${DIM}anelkul:      tail -n 30 $INSTALL_DIR/store/channels.log${NC}"
    echo -e "  ${DIM}Kesobb: ./scripts/start.sh, majd irj a botodnak${NC}"
  else
    ok "Telegram bridge fut"
    echo ""
    echo -e "  ${BOLD}1.${NC} Nyisd meg a Telegram appot es irj a botodnak (barmit, pl. \"Szia\")"
    echo -e "  ${BOLD}2.${NC} A bot valaszol egy parosito kodot"
    echo -e "  ${BOLD}3.${NC} Masold ide a kapott kodot:"
    echo ""
    read -rp "$(_t prompt_pair_code)" PAIR_CODE

    if [ -n "$PAIR_CODE" ]; then
      ACCESS_FILE="$(_pairing_access_file)"
      if [ ! -f "$ACCESS_FILE" ]; then
        warn "access.json nem talalhato: $ACCESS_FILE"
        echo -e "  ${DIM}Bizonyosodj meg rola, hogy a bot futott amikor uzeneteket kuldtel neki.${NC}"
      else
        # PAIR_CODE env-en at adjuk at, hogy elkerüljük a shell injection-t
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
          sed -i "s/^ALLOWED_CHAT_ID=.*/ALLOWED_CHAT_ID=${CHAT_ID}/" "$INSTALL_DIR/.env"
          ok "Parositas sikeres! (chat ID: $PENDING_CHAT_ID)"
          ok ".env ALLOWED_CHAT_ID frissitve"
          ok "Policy: allowlist (csak te erheted el a botot)"
          # Ujrainditjuk, hogy felvegye az uj access.json-t. The tick used to
          # print after `restart ... || true`, so on a no-systemd host (WSL) it
          # claimed a restart that never ran. Without systemd the bridge was
          # started by start.sh, so restart it the same way.
          if systemctl --user restart "${CHAN_UNIT}" 2>/dev/null; then
            ok "${CHAN_UNIT} $(_t linux.chan_restarted)"
          elif bash "$INSTALL_DIR/scripts/stop.sh" >>"$INSTALL_DIR/store/boot.log" 2>&1 \
               && bash "$INSTALL_DIR/scripts/start.sh" >>"$INSTALL_DIR/store/boot.log" 2>&1 \
               && sleep 3 && _bridge_is_up; then
            ok "${CHAN_UNIT} $(_t linux.chan_restarted)"
          else
            warn "A csatorna ujrainditasa nem sikerult -- futtasd: ./scripts/stop.sh && ./scripts/start.sh"
          fi
        else
          warn "A kod nem talalhato az access.json pending bejegyzesei kozott."
          echo -e "  ${DIM}Lehetseges okok:${NC}"
          echo -e "  ${DIM}  - A bot meg nem kapta meg az uzeneteidet (varj par masodpercet)${NC}"
          echo -e "  ${DIM}  - Elgepeles a kodban${NC}"
          echo -e "  ${DIM}Kesobb: claude -> /telegram:access pair $PAIR_CODE${NC}"
        fi
      fi
    else
      echo -e "  ${DIM}Rendben, kesobb is parosithatsz.${NC}"
      echo -e "  ${DIM}Futtasd: claude, majd /telegram:access pair AKOD${NC}"
    fi
  fi
fi

# ─────────────────────────────────────────────
# Korabbi rendszer koltoztetese
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}Korabbi rendszer koltoztetese${NC}"
echo -e "${DIM}  Ha volt korabbi AI asszisztensed (OpenClaw, egyeni bot), atmigralhato a memoriai.${NC}"
read -rp "$(_t prompt_migrate)" DO_MIGRATE
DO_MIGRATE=${DO_MIGRATE:-n}
if [ "$DO_MIGRATE" = "i" ]; then
  if [ -f "$INSTALL_DIR/scripts/migrate.sh" ]; then
    "$INSTALL_DIR/scripts/migrate.sh"
  else
    warn "A migrate.sh nem talalhato. Hasznald a dashboardot: http://localhost:${WEB_PORT:-3420} -> Koltoztes"
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

# ─────────────────────────────────────────────
# Kesz!
# ─────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BOLD}${GREEN}$(_t success_installed)${NC}"
echo ""

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
else
  if [ -n "$DASH_TOKEN" ]; then _hint="$(_t dash.token_file_hint)"; _k=dash.token_file_hint
  else _hint="$(_t dash.no_token_hint)"; _k=dash.no_token_hint; fi
  # An older install-lang.sh (standalone run) answers an unknown key with the key itself.
  [ "$_hint" = "$_k" ] && _hint="  (store/.dashboard-token)"
  echo -e "  ${BOLD}Dashboard:${NC} http://localhost:${WEB_PORT:-3420}"
  echo -e "  ${DIM}${_hint}${NC}"
fi
echo ""
echo -e "  ${DIM}VPS/szerver eleres tavolrol:${NC}"
echo -e "  ${DIM}  A .env fajlba ird: WEB_HOST=0.0.0.0${NC}"
echo -e "  ${DIM}  Majd: systemctl --user restart ${DASH_UNIT}${NC}"
# EE2392D3 (Abel 75479, Samu 75482): the closing lines name the install's own channel, not always Telegram.
case "$CHANNEL_PROVIDER" in
  teams) _CHAN_APP="Teams"; _CHAN_IN="Teamsben" ;;
  slack) _CHAN_APP="Slack"; _CHAN_IN="Slacken" ;;
  discord) _CHAN_APP="Discord"; _CHAN_IN="Discordon" ;;
  gromzo) _CHAN_APP="Gromzo"; _CHAN_IN="a Gromzo appban" ;;
  *) _CHAN_APP="Telegram"; _CHAN_IN="Telegramon" ;;
esac
echo -e "  ${BOLD}${_CHAN_APP}:${NC} Irj a botodnak!"
echo ""
echo -e "  ${DIM}Kovetkezo lepesek:${NC}"
echo -e "  ${DIM}1. Nyisd meg a dashboardot a fenti URL-lel${NC}"
echo -e "  ${DIM}2. Irj a botodnak ${_CHAN_IN} -- mar valaszolnia kell${NC}"
echo -e "  ${DIM}3. A Csapat oldalon hozhatsz letre tobb agenst${NC}"
echo ""
echo -e "  ${DIM}Hasznos parancsok:${NC}"
echo -e "  ${DIM}  systemctl --user status ${DASH_UNIT} ${CHAN_UNIT} --no-pager${NC}"
echo -e "  ${DIM}  journalctl --user -u ${DASH_UNIT} -f${NC}    -- dashboard logok"
echo -e "  ${DIM}  journalctl --user -u ${CHAN_UNIT} -f${NC}     -- channels logok"
echo -e "  ${DIM}  ./update.sh${NC}                                  -- frissites"
echo -e "  ${DIM}  ./scripts/start.sh${NC}                           $(_t linux.start_hint)"
echo -e "  ${DIM}  ./scripts/stop.sh${NC}                            -- leallitas"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# The auth verdict is repeated LAST, because the "next steps" above tell the
# user the bot will answer -- which is false when the services have no working
# credential. A green frame must not be the final thing a broken install says.
if [ "${INSTALL_AUTH_STATE:-UNKNOWN}" != "OK" ]; then
  echo ""
  if [ "${INSTALL_AUTH_STATE:-}" = "UNKNOWN" ]; then
    echo -e "  ${ORANGE}! FIGYELEM: az auth-ot nem sikerult ellenoriznunk.${NC}"
    echo -e "  ${DIM}  Lehet hogy mukodik, de nem igazoltuk. Ha a bot nem valaszol:${NC}"
  else
    echo -e "  ${RED}✗ AZ UGYNOKOK MEG NEM FOGNAK VALASZOLNI: hianyzik a mukodo auth kulcs.${NC}"
    echo -e "  ${DIM}  A fenti 2. lepes (\"irj a botodnak\") addig NEM fog mukodni.${NC}"
  fi
  echo -e "  ${BOLD}  Javitas: ${BLUE}bash \"$INSTALL_DIR/scripts/auth.sh\"${NC}${BOLD} majd ${BLUE}bash \"$INSTALL_DIR/scripts/channels.sh\" restart${NC}"
  echo ""
fi
