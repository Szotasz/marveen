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
# existing managed keys -- e.g. allowedChannelPlugins -- are preserved.
#
# Managed-settings paths (authoritative, code.claude.com/docs/en/settings.md):
#   macOS: /Library/Application Support/ClaudeCode/managed-settings.json
#   Linux/WSL: /etc/claude-code/managed-settings.json
set -u

case "$(uname -s)" in
  Darwin) MANAGED_FILE="/Library/Application Support/ClaudeCode/managed-settings.json" ;;
  Linux)  MANAGED_FILE="/etc/claude-code/managed-settings.json" ;;
  *) echo "  channelsEnabled: nem tamogatott OS ($(uname -s)); kihagyva."; exit 0 ;;
esac

# Root-aware privilege prefix. The managed dir is root-owned on both platforms.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "  ! channelsEnabled: nem root es nincs sudo -- kihagyva."
    echo "    Kezi lepes (root): tedd be a(z) {\"channelsEnabled\": true}-t ide: $MANAGED_FILE"
    exit 0
  fi
fi

# Idempotent: already true -> nothing to do.
if [ -f "$MANAGED_FILE" ] && $SUDO python3 - "$MANAGED_FILE" 2>/dev/null <<'PY'
import json, sys
try:
    sys.exit(0 if json.load(open(sys.argv[1])).get("channelsEnabled") is True else 1)
except Exception:
    sys.exit(1)
PY
then
  echo "  channelsEnabled: mar be van kapcsolva ($MANAGED_FILE)"
  exit 0
fi

if ! $SUDO mkdir -p "$(dirname "$MANAGED_FILE")" 2>/dev/null; then
  echo "  ! channelsEnabled: nem sikerult letrehozni $(dirname "$MANAGED_FILE") -- kezi root-lepes szukseges."
  exit 0
fi

# Safe JSON merge: load existing (or {}), set channelsEnabled=true, atomic write.
if $SUDO python3 - "$MANAGED_FILE" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    d = json.load(open(p)) if os.path.exists(p) else {}
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
d["channelsEnabled"] = True
tmp = p + ".tmp"
with open(tmp, "w") as f:
    f.write(json.dumps(d, indent=2) + "\n")
os.replace(tmp, p)
PY
then
  echo "  channelsEnabled=true beallitva a managed-settings-ben ($MANAGED_FILE)"
  echo "    (a bejovo channel-uzenetek team/enterprise orgnal is celba ernek; restart utan lep eletbe.)"
else
  echo "  ! channelsEnabled: a managed-settings frissitese sikertelen."
  echo "    Kezi lepes (root): tedd be a(z) {\"channelsEnabled\": true}-t ide: $MANAGED_FILE"
fi
exit 0
