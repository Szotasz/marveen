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

# Same question, now with the privilege we just resolved. An admin who locked
# the managed file down still gets the early exit instead of a pointless
# privileged rewrite on every install -- the old order got that right by reading
# as root, and an unprivileged-only check would have lost it.
if [ -n "$SUDO" ] && channels_enabled "$SUDO"; then
  report_enabled
  exit 0
fi

if ! $SUDO mkdir -p "$(dirname "$MANAGED_FILE")" 2>/dev/null; then
  echo "  ! channelsEnabled: nem sikerult letrehozni $(dirname "$MANAGED_FILE") -- kezi root-lepes szukseges:"
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
