#!/usr/bin/env bash
# Ensure the SYSTEM-level Claude Code managed-settings.json enables channels.
#
# WHY: claude-code >= 2.1.205 SILENTLY drops channel-plugin INBOUND
# notifications on a TEAM/ENTERPRISE org unless the managed (org-policy) settings
# contain "channelsEnabled": true. The bot still sends OUTBOUND and the poller
# still runs (pending 0), so it looks "almost working" -- but replies never reach
# the session (plugin log: "Channel notifications skipped: channels not enabled
# by org policy"). channelsEnabled is a MANAGED-settings-only key; user/project
# settings have no effect. See the channel-inbound-org-policy-gate skill.
#
# ALWAYS-ENSURE (not org-type detection): on a personal org the key is simply
# ignored (harmless), and an account can move personal -> team AFTER install, so
# detecting org type at install time is fragile. Setting it unconditionally in
# the managed layer is the simple, robust, correct-for-all-cases choice.
#
# Idempotent, reversible (delete the key), and a SAFE JSON merge (never sed):
# existing managed keys -- e.g. allowedChannelPlugins -- are preserved, and a
# file that is not a valid JSON object is left untouched (reported as manual).
#
# Managed-settings paths (authoritative, code.claude.com/docs/en/settings.md):
#   macOS: /Library/Application Support/ClaudeCode/managed-settings.json
#   Linux/WSL: /etc/claude-code/managed-settings.json
set -u

case "$(uname -s)" in
  Darwin) MANAGED_FILE="/Library/Application Support/ClaudeCode/managed-settings.json" ;;
  Linux)  MANAGED_FILE="/etc/claude-code/managed-settings.json" ;;
  *) echo "  channelsEnabled: nem tamogatott OS ($(uname -s)); kihagyva."; echo "MARVEEN_CHANNELS_GATE=ok"; exit 0 ;;
esac

# Idempotent: already true -> nothing to do.
#
# Answering "is this already configured?" is a READ, and the managed file is org
# policy (0644, not a secret), so ask it with NO privilege and ask it BEFORE the
# sudo handling below. Resolving sudo first meant a host where the key was
# ALREADY set, but the invoking user had no sudo, reported
#   ! channelsEnabled: nem root es nincs sudo -- kihagyva.
#   MARVEEN_CHANNELS_GATE=manual
# and sent the operator off to fix something that was already correct. Ask the
# question that costs nothing first; only a WRITE needs privilege.
#
# $1 is the privilege prefix ("" or sudo). No `[ -f ]` guard: absent and
# unreadable are the same answer here, and that test would itself need the
# privilege we may not have.
channels_enabled() {
  $1 python3 - "$MANAGED_FILE" 2>/dev/null <<'PY'
import json, sys
try:
    sys.exit(0 if json.load(open(sys.argv[1])).get("channelsEnabled") is True else 1)
except Exception:
    sys.exit(1)
PY
}

report_enabled() {
  echo "  channelsEnabled: mar be van kapcsolva ($MANAGED_FILE)"
  echo "MARVEEN_CHANNELS_GATE=ok"
}

# MANAGEDUMASK1119: an EXISTING managed dir keeps its mode under `mkdir -p -m 0755` (below), and an older install made
# it 0700 under a 077 umask: the session cannot read the policy inside, and the gate silently does nothing. If it is a
# real directory (not a symlink), owned by the privileged user (root in an install), and not 0755, set it to 0755,
# loudly. 0755 never adds a group/other write bit; a dir owned by anyone else, or a symlink, is left alone (the writer
# refuses those anyway). $1 is the privilege prefix. It runs BEFORE each "already enabled" check that could see an
# enabled policy through that 0700 dir (as root), since those checks exit early.
MANAGED_DIR="$(dirname "$MANAGED_FILE")"
repair_managed_dir() {
  [ -d "$MANAGED_DIR" ] && [ ! -L "$MANAGED_DIR" ] || return 0
  local om owner mode
  om="$(stat -c '%u %a' "$MANAGED_DIR" 2>/dev/null || stat -f '%u %Lp' "$MANAGED_DIR" 2>/dev/null)"
  owner="${om%% *}"; mode="${om##* }"
  # the mode first: a 0755 dir needs no privileged `id -u` (no sudo call, no password) on every run
  [ -n "$om" ] && [ "$mode" != "755" ] && [ "$owner" = "$($1 id -u)" ] || return 0
  if $1 chmod 0755 "$MANAGED_DIR" 2>/dev/null; then
    echo "  ! channelsEnabled: a $MANAGED_DIR mappa joga $mode volt (a session nem latott bele) -- 0755-re allitva."
  else
    echo "  ! channelsEnabled: a $MANAGED_DIR mappa joga $mode, es nem sikerult 0755-re allitani -- kezi root-lepes:"
    echo "      sudo chmod 0755 \"$MANAGED_DIR\""
  fi
}

# As root, the unprivileged check below already reads through a 0700 dir: repair first.
[ "$(id -u)" -eq 0 ] && repair_managed_dir ""

if channels_enabled ""; then
  report_enabled
  exit 0
fi

# A write MAY be needed from here on, so now resolve privilege.
# Root-aware privilege prefix. The managed dir is root-owned on both platforms.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "  ! channelsEnabled: nem root es nincs sudo -- kihagyva."
    echo "    Kezi lepes (rootkent futtatva biztonsagos, meglevo kulcsokat megorzi):"
    echo "      sudo bash $0"
    echo "MARVEEN_CHANNELS_GATE=manual"
    exit 0
  fi
fi

# Not root: the privileged check below reads through a 0700 dir: repair first (MANAGEDUMASK1119).
[ -n "$SUDO" ] && repair_managed_dir "$SUDO"

# Same question, now with the privilege we just resolved. An admin who locked
# the managed file down still gets the early exit instead of a pointless
# privileged rewrite on every install -- the old order got that right by reading
# as root, and an unprivileged-only check would have lost it.
if [ -n "$SUDO" ] && channels_enabled "$SUDO"; then
  report_enabled
  exit 0
fi

# MANAGEDUMASK1119: -m 0755 whatever the umask (as #2816 and #2955 do for the installers' own mkdirs). Without it a
# root umask of 077 made the dir 0700, the user's session could not read the policy inside, and the gate silently did
# nothing; on Linux this script runs before the installer's Teams block, so that -m 0755 found the dir already there.
if ! $SUDO mkdir -p -m 0755 "$MANAGED_DIR" 2>/dev/null; then
  echo "  ! channelsEnabled: nem sikerult letrehozni $MANAGED_DIR -- kezi root-lepes szukseges:"
  echo "      sudo bash $0"
  echo "MARVEEN_CHANNELS_GATE=manual"
  exit 0
fi

# The write goes through the ONE shared writer (MANAGEDSETTINGSWRITE1103):
# scripts/lib/managed-settings-write.py. The inline merge that lived here turned
# an unparseable or non-object file into {} and wrote it back as root, dropping
# every other managed key (allowedChannelPlugins too, muting every channel), and
# it wrote a fixed `<file>.tmp` that a planted symlink could redirect. The
# writer refuses a file it cannot parse, keeps every other key and the file's
# mode (a new file gets 0644, whatever the umask), and writes through a fresh
# mkstemp file in the same directory. -I: no import from cwd or PYTHONPATH.
MSW="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/managed-settings-write.py"
if [ ! -f "$MSW" ]; then
  echo "  ! channelsEnabled: a managed-settings iro hianyzik ($MSW) -- kezi root-lepes szukseges:"
  echo "      sudo bash $0"
  echo "MARVEEN_CHANNELS_GATE=manual"
  exit 0
fi
if $SUDO python3 -I "$MSW" "$MANAGED_FILE" --create --channels-enabled
then
  echo "  channelsEnabled=true beallitva a managed-settings-ben ($MANAGED_FILE)"
  echo "    (a bejovo channel-uzenetek team/enterprise orgnal is celba ernek; restart utan lep eletbe.)"
  echo "MARVEEN_CHANNELS_GATE=ok"
else
  echo "  ! channelsEnabled: a managed-settings frissitese sikertelen."
  echo "    Kezi lepes (rootkent futtatva biztonsagos, meglevo kulcsokat megorzi):"
  echo "      sudo bash $0"
  echo "MARVEEN_CHANNELS_GATE=manual"
fi
exit 0
