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

# shellcheck source=install-lang.sh
source "$(dirname "$0")/install-lang.sh"

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
    --help|-h)
      echo "Usage: $0 [--port <N>]"
      echo "  --port <N>   Dashboard port (default: 3420). Also settable via WEB_PORT env var."
      exit 0 ;;
    *) echo "Unknown option: $1 (use --help for usage)" >&2; exit 1 ;;
  esac
done
WEB_PORT="${WEB_PORT:-3420}"

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
for pkg in ffmpeg git tmux lsof curl python3 pipx unzip; do
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
NODE_OK=false
if command -v node &>/dev/null; then
  NODE_VER=$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])' 2>/dev/null || echo "0")
  [ "$NODE_VER" -ge 20 ] && NODE_OK=true
fi
$NODE_OK || MISSING_PKGS="$MISSING_PKGS nodejs"

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
        warn "nodesource repo hozzaadasa sikertelen -- a disztro sajat nodejs + npm csomagjat telepitem."
        apt_run update -qq
        MISSING_PKGS="$MISSING_PKGS npm"
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
    # python3/pipx/unzip/nodejs). Az ffmpeg-hez Fedoran az RPM Fusion repo
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
    git clone --depth 1 --branch main https://github.com/Szotasz/marveen.git "$TARGET_DIR" \
      || fail "git clone sikertelen: https://github.com/Szotasz/marveen.git (main branch)"
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
# alone is not enough -- we verify it runs (with a timeout so a hanging Bun
# binary cannot wedge the installer).
_claude_runs() { command -v claude >/dev/null 2>&1 && timeout 25 claude --version </dev/null >/dev/null 2>&1; }

# Pinned Node-based fallback for AVX-less hosts. @2.1.110 is the LAST version
# that ships bin=cli.js (a `#!/usr/bin/env node` entrypoint) running without
# AVX -- 2.1.120+ bundles only the Bun ELF binary, so DO NOT use latest here.
# Unlike the old 2.0.76 pin, 2.1.110 also understands `--channels`, which
# channels.sh requires to boot the bot. Verified on the AVX-less pilot VPS.
CLAUDE_PIN="2.1.110"

if _claude_runs; then
  ok "claude mar telepitve es fut: $(claude --version 2>/dev/null || echo 'ok')"
else
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
      curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_PIN}" || warn "pinnelt install.sh sikertelen."
    fi
  else
    echo -e "  Claude Code telepitese (hivatalos installer, ~/.local/bin)..."
    curl -fsSL https://claude.ai/install.sh | bash
  fi
  hash -r
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

# Bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
if command -v bun &>/dev/null; then
  ok "bun mar telepitve: $(bun --version)"
else
  echo -e "  Bun telepitese (Telegram plugin fuggoseg)..."
  curl -fsSL https://bun.sh/install | bash 2>/dev/null
  if ! command -v bun &>/dev/null; then
    echo -e "  ${RED}✗${NC} Bun telepites sikertelen. Probalj manualisan: curl -fsSL https://bun.sh/install | bash"
  else
    ok "bun telepitve"
  fi
fi
ensure_in_rc 'BUN_INSTALL' 'export BUN_INSTALL="$HOME/.bun"'
ensure_in_rc '.bun/bin' 'export PATH="$BUN_INSTALL/bin:$PATH"'

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

# Skip the prompt only when THIS INSTALL already carries a credential the
# services can read (a re-run, or the dashboard wizard got there first).
# Gating on `claude auth status` here is what silently skipped token capture
# for operators who had followed step 2 below and run `claude setup-token`
# first -- the correct user behaviour triggered the bug.
if service_auth_present; then
  ok "A telepites mar hordoz auth kulcsot (.env / store/.claude-oauth-token)"
else
  if claude auth status &>/dev/null; then
    echo -e "  ${ORANGE}A terminalod be van jelentkezve, de a SZOLGALTATASOK ehhez nem ferenek hozza.${NC}"
    echo -e "  ${DIM}A systemd unitok csak a .env-et es a store/.claude-oauth-token-t olvassak.${NC}"
  else
    echo -e "  ${ORANGE}Nincs aktiv Claude bejelentkezes.${NC}"
  fi
  if [ "$IS_HEADLESS" = "true" ]; then
    echo ""
    echo -e "  ${BLUE}Headless szerver detektalva (nincs DISPLAY).${NC}"
    echo -e "  ${BLUE}Bongeszo-alapu bejelentkezes nem lehetseges.${NC}"
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
      ensure_in_rc 'ANTHROPIC_API_KEY' "export ANTHROPIC_API_KEY=\"$ANTHROPIC_API_KEY_INPUT\""
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
    echo ""
    read -p "  OAuth token: " OAUTH_TOKEN_INPUT
    if [ -n "$OAUTH_TOKEN_INPUT" ]; then
      export CLAUDE_CODE_OAUTH_TOKEN="$OAUTH_TOKEN_INPUT"
      ensure_in_rc 'CLAUDE_CODE_OAUTH_TOKEN' "export CLAUDE_CODE_OAUTH_TOKEN=\"$OAUTH_TOKEN_INPUT\""
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
echo ""
read -rp "$(_t prompt_channel_select_linux)" PROVIDER_CHOICE
PROVIDER_CHOICE=${PROVIDER_CHOICE:-1}
if [ "$PROVIDER_CHOICE" = "2" ]; then
  CHANNEL_PROVIDER="slack"
elif [ "$PROVIDER_CHOICE" = "3" ]; then
  CHANNEL_PROVIDER="discord"
else
  CHANNEL_PROVIDER="telegram"
fi
ok "Csatorna: $CHANNEL_PROVIDER"

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
  grep -v "^$1=" "$INSTALL_DIR/.env" > "$_emk_tmp" 2>/dev/null || true
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
if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  env_keep_or_set TELEGRAM_BOT_TOKEN "${BOT_TOKEN}"
  # Never demote a paired install: CHAT_ID=0 means pairing was skipped THIS
  # run -- it must not overwrite a real chat id from a previous run.
  _existing_chat="$(grep '^ALLOWED_CHAT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ "${CHAT_ID}" != "0" ] || [ -z "$_existing_chat" ]; then
    env_merge_key ALLOWED_CHAT_ID "${CHAT_ID}"
  fi
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
  _probe_cfg="$(mktemp -d 2>/dev/null || echo /tmp/marveen-authprobe.$$)"
  _probe_out=""
  _probe_rc=1
  if command -v claude >/dev/null 2>&1; then
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
  rm -rf "$_probe_cfg" 2>/dev/null || true
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

# CLAUDE.md generalasa template-bol
if [ -f "$INSTALL_DIR/templates/CLAUDE.md.template" ]; then
  sed -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
    -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
    -e "s/{{CHAT_ID}}/$CHAT_ID/g" \
    -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
    -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
    -e "s/{{WEB_PORT}}/${WEB_PORT:-3420}/g" \
    "$INSTALL_DIR/templates/CLAUDE.md.template" >"$INSTALL_DIR/CLAUDE.md"
  ok "CLAUDE.md generalva"
else
  warn "CLAUDE.md.template nem talalhato, CLAUDE.md nem generalhato"
fi

# SOUL.md generalasa template-bol (personality definition for the main agent).
if [ -f "$INSTALL_DIR/templates/SOUL.md.template" ] && [ ! -f "$INSTALL_DIR/SOUL.md" ]; then
  sed -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
      -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
      "$INSTALL_DIR/templates/SOUL.md.template" > "$INSTALL_DIR/SOUL.md"
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
    for f in "$tpl"*; do
      [ -f "$f" ] || continue
      sed -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
          -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
          -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
          -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
          -e "s/{{WEB_PORT}}/${WEB_PORT:-3420}/g" \
          "$f" > "$target/$(basename "$f")"
    done
    ok "Utemezett feladat scaffoldolva: $task_name"
  done
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
    [[ "$task_name" == "bumblebee-hygiene-scan" ]] && continue
    target="$SCHED_TARGET_DIR/$task_name"
    if [ -d "$target" ]; then
      SCHED_SKIP=$((SCHED_SKIP + 1))
      continue
    fi
    mkdir -p "$target"
    for f in "$tpl"*; do
      [ -f "$f" ] || continue
      sed -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
          -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
          -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
          -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
          -e "s/{{WEB_PORT}}/${WEB_PORT:-3420}/g" \
          "$f" > "$target/$(basename "$f")"
    done
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
mkdir -p "$CHANNEL_DIR"

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
fi

# Channel plugin install
if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
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

# Enable plugin at project scope so --channels can boot-time activate it
cd "$INSTALL_DIR"
if claude plugin enable "$PLUGIN_SHORT@marveen-marketplace" --scope project 2>/dev/null || \
   claude plugin enable "$PLUGIN_ID" --scope project 2>/dev/null; then
  ok "${CHANNEL_PROVIDER} plugin project-scope-ban engedelyezve"
else
  warn "Plugin project-scope enable sikertelen. Futtasd kezzel:"
  echo -e "  ${DIM}cd $INSTALL_DIR && claude plugin enable ${PLUGIN_ID} --scope project${NC}"
fi

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
      cp "$f" "$target/$(basename "$f")"
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
echo -e "  Ollama ellenorzese (szemantikus memoria kereseshez)..."
if command -v ollama &>/dev/null; then
  ok "ollama mar telepitve"
else
  echo -e "  Ollama telepitese..."
  # Az ollama telepitoje sudo-val ir a /usr/local/bin-be es allit be systemd service-t.
  # Elore gyorsitotarazzuk a sudo hitelesitest, hogy a gyermek-script sudo prompt-ja ne bukjon el.
  sudo -v 2>/dev/null || true
  # NEM fatalis: ha az ollama telepitoje hibara fut (pl. sudo, halozat, WSL),
  # csak figyelmeztetunk es kihagyjuk a szemantikus memoria lepest -- a telepito megy tovabb.
  if curl -fsSL https://ollama.com/install.sh | sh; then
    ok "ollama telepitve"
  else
    warn "ollama telepitese sikertelen -- a szemantikus memoria kereses kimarad."
    echo -e "  ${DIM}Kesobb kezzel: sudo -v && curl -fsSL https://ollama.com/install.sh | sh${NC}"
  fi
fi

# A service-inditas es modell-letoltes csak akkor fut, ha az ollama tenyleg telepult.
if command -v ollama &>/dev/null; then
# A telepito letrehoz egy ollama.service systemd egységet és elindítja.
# Ha megis nem futna, systemctl-lel indítjuk -- NEM ollama serve &
if ! curl -s http://localhost:11434/api/version &>/dev/null; then
  echo -e "$(_t linux.ollama_starting)"
  sudo systemctl enable --now ollama 2>/dev/null || true
  # Megvarjuk amig az API valaszol (max 15 mp)
  for i in $(seq 1 15); do
    curl -s http://localhost:11434/api/version &>/dev/null && break
    sleep 1
  done
fi

# Modell letoltese az Ollama HTTP API-n keresztul (CLI script-ben ismert TTY-bug miatt)
# stream:false --> szinkron, egyetlen valaszt ad vissza a letoltes utan
ollama_pull() {
  local model="$1" size="$2"
  if curl -s http://localhost:11434/api/tags | grep -q "\"$model\""; then
    ok "$model mar letoltve"
    return 0
  fi
  echo -e "  $model letoltese ($size)..."
  local status
  status=$(curl -s --max-time 600 \
    -X POST http://localhost:11434/api/pull \
    -H 'Content-Type: application/json' \
    -d "{\"model\": \"$model\", \"stream\": false}" |
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null)
  if [ "$status" = "success" ]; then
    ok "$model kesz"
  else
    warn "$model letoltese sikertelen (status: $status) -- kezzel: ollama pull $model"
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
Description=${BOT_NAME} Channels (Telegram bridge)
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
Restart=on-failure
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
Environment=TELEGRAM_ENV=$HOME/.claude/channels/telegram/.env
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
Environment=TELEGRAM_ENV=$HOME/.claude/channels/telegram/.env
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
  if systemctl --user enable "${DASH_UNIT}" "${CHAN_UNIT}" "${MORN_UNIT}.timer" "${SERVICE_ID}-host-watchdog.service" 2>/dev/null; then
    ok "systemd unitok generalva es engedelyezve"
  else
    warn "A unit-fajlok elkeszultek, de az engedelyezesuk nem sikerult -- ujrainditas utan a szolgaltatasok nem indulnak el maguktol."
    # ALL FOUR units the enable above covers, not just the two services. A
    # command that silently drops the timer and the watchdog would leave them
    # disabled while the operator sees no error and believes the fix worked --
    # an incomplete instruction ends the same way as a false claim.
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
    echo -e "  ${DIM}    ${MORN_UNIT}.timer ${SERVICE_ID}-host-watchdog.service${NC}"
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
else
  warn "systemd --user nem elerheto (WSL / konteneren / VPS user-session nelkul) -- kozvetlen inditas."
  mkdir -p "$INSTALL_DIR/store"
  # Root VPS/container: claude refuses --dangerously-skip-permissions as uid 0,
  # which would kill the agent tmux sessions the dashboard spawns. Opt into the
  # sandbox escape hatch so first boot works (start.sh/channels.sh do the same).
  [ "$(id -u)" = "0" ] && export IS_SANDBOX=1
  nohup "$NODE_PATH" "$INSTALL_DIR/dist/index.js" >"$INSTALL_DIR/store/dashboard.log" 2>&1 &
  echo $! >"$INSTALL_DIR/store/dashboard.pid"
  nohup bash "$INSTALL_DIR/scripts/channels.sh" >"$INSTALL_DIR/store/channels.log" 2>&1 &
  echo $! >"$INSTALL_DIR/store/channels.pid"
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
fi

# Ellenorzes
sleep 3
echo ""
echo -e "${BOLD}$(_t section_checks)${NC}"
if [ "$CHANNEL_PROVIDER" = "telegram" ] && ! command -v bun &>/dev/null; then
  echo -e "  ${RED}✗${NC} Bun nem talalhato. A Telegram plugin nem fog mukodni."
  echo -e "  ${BOLD}Javitas:${NC} curl -fsSL https://bun.sh/install | bash"
  echo -e "  ${DIM}Utana: source ~/.bashrc && ./scripts/start.sh${NC}"
fi
PLUGIN_CHECK_PATTERN="${CHANNEL_PROVIDER}"
if ! claude plugin list 2>/dev/null | grep -q "$PLUGIN_CHECK_PATTERN"; then
  echo -e "  ${RED}✗${NC} ${CHANNEL_PROVIDER} plugin nincs telepitve."
  echo -e "  ${BOLD}Javitas:${NC} claude plugin install ${PLUGIN_ID}"
  echo -e "  ${DIM}Utana: systemctl --user restart ${CHAN_UNIT}${NC}"
else
  ok "${CHANNEL_PROVIDER} plugin ellenorizve"
fi

# ─────────────────────────────────────────────
# Channel pairing (Telegram only; Slack uses OAuth / App install)
# ─────────────────────────────────────────────
if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ -n "$BOT_TOKEN" ]; then
  echo ""
  echo -e "${BOLD}Telegram parositas${NC}"

  ACCESS_FILE="$CHANNEL_DIR/access.json"

  # Megvarjuk amig a channels service tenyleg valaszol (max 15 mp)
  echo -e "  Varakozas a Telegram bridge elindulasara..."
  BRIDGE_OK=false
  for i in $(seq 1 15); do
    if systemctl --user is-active --quiet "${CHAN_UNIT}" 2>/dev/null; then
      BRIDGE_OK=true
      break
    fi
    sleep 1
  done

  if [ "$BRIDGE_OK" = "false" ]; then
    warn "A ${CHAN_UNIT} service nem indult el. Parositas kihagyva."
    echo -e "  ${DIM}Ellenorizd: journalctl --user -u ${CHAN_UNIT} -n 30${NC}"
    echo -e "  ${DIM}Kesobb: systemctl --user start ${CHAN_UNIT}, majd irj a botodnak${NC}"
  else
    ok "Telegram bridge fut"
    echo ""
    echo -e "  ${BOLD}1.${NC} Nyisd meg a Telegram appot es irj a botodnak (barmit, pl. \"Szia\")"
    echo -e "  ${BOLD}2.${NC} A bot valaszol egy parosito kodot"
    echo -e "  ${BOLD}3.${NC} Masold ide a kapott kodot:"
    echo ""
    read -rp "$(_t prompt_pair_code)" PAIR_CODE

    if [ -n "$PAIR_CODE" ]; then
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
          # Ujrainditjuk, hogy felvegye az uj access.json-t
          systemctl --user restart "${CHAN_UNIT}" 2>/dev/null || true
          ok "${CHAN_UNIT} $(_t linux.chan_restarted)"
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
if [ -n "$DASH_TOKEN" ]; then
  echo -e "  ${BOLD}Dashboard:${NC} ${BLUE}http://localhost:${WEB_PORT:-3420}/?token=${DASH_TOKEN}${NC}"
  echo -e "  ${DIM}$(_t dash.token_hint)${NC}"
else
  echo -e "  ${BOLD}Dashboard:${NC} http://localhost:${WEB_PORT:-3420}"
  echo -e "  ${DIM}(A tokenes URL-t a szerver logban talalod)${NC}"
fi
echo ""
echo -e "  ${DIM}VPS/szerver eleres tavolrol:${NC}"
echo -e "  ${DIM}  A .env fajlba ird: WEB_HOST=0.0.0.0${NC}"
echo -e "  ${DIM}  Majd: systemctl --user restart ${DASH_UNIT}${NC}"
echo -e "  ${BOLD}Telegram:${NC} Irj a botodnak!"
echo ""
echo -e "  ${DIM}Kovetkezo lepesek:${NC}"
echo -e "  ${DIM}1. Nyisd meg a dashboardot a fenti URL-lel${NC}"
echo -e "  ${DIM}2. Irj a botodnak Telegramon -- mar valaszolnia kell${NC}"
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
