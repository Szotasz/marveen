#!/bin/bash
# Retire the progress-indicator plumbing of a channel provider that is no
# longer in use. The exact inverse of install-<provider>-progress-hook.sh:
# it unwires the hooks from settings.json and stops+removes the watchdog
# daemon (systemd user timer on Linux, launchd agent on macOS).
#
# Why this exists: installing a second provider's progress hook does NOT
# retire the first one's. After a Telegram -> Slack migration both sets stayed
# wired, so every turn ran a dead telegram_progress.py, and a systemd timer
# fired telegram_progress_watchdog.py 1440x/day against state directories that
# no longer existed. Silent, permanent waste that nothing reported. Exactly one
# provider's progress machinery should be live at a time: the one in
# CHANNEL_PROVIDER.
#
# Usage:
#   bash scripts/retire-progress-watchdog.sh telegram
#   bash scripts/retire-progress-watchdog.sh telegram --dry-run
#   bash scripts/retire-progress-watchdog.sh slack --force   # retire the ACTIVE provider
#
# Idempotent: safe to re-run, exits 0 with "nothing to retire" when clean.
# The hook .py files themselves are left on disk -- they are inert once
# unwired, and re-running the installer restores the wiring.

set -euo pipefail

PROVIDER="${1:-}"
shift || true
DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

case "$PROVIDER" in
  telegram|slack) ;;
  *)
    echo "usage: $0 <telegram|slack> [--dry-run] [--force]" >&2
    exit 2
    ;;
esac

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS="$HOME/.claude/settings.json"

# Read a single key from .env without sourcing it -- an unquoted value with
# spaces or a $(...) value would otherwise run arbitrary code. Mirrors the
# read_env in both install-*-progress-hook.sh scripts.
read_env() {
  [ -f "$INSTALL_DIR/.env" ] || return 0
  local v
  v="$(grep -E "^${1}=" "$INSTALL_DIR/.env" | tail -1)" || return 0
  v="${v#*=}"
  case "$v" in
    '"'*) v="${v#\"}"; v="${v%\"}" ;;
    "'"*) v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

SERVICE_ID="$(read_env SERVICE_ID)"
MAIN_AGENT_ID_ENV="$(read_env MAIN_AGENT_ID)"
SERVICE_ID="${SERVICE_ID:-${MAIN_AGENT_ID_ENV:-marveen}}"
ACTIVE_PROVIDER="$(read_env CHANNEL_PROVIDER)"

# Guard: never silently unwire the channel the install is actually using.
if [ -n "$ACTIVE_PROVIDER" ] && [ "$PROVIDER" = "$ACTIVE_PROVIDER" ] && [ "$FORCE" -ne 1 ]; then
  echo "✗ Refusing to retire '$PROVIDER': it is the active CHANNEL_PROVIDER." >&2
  echo "  Retiring it would leave turns with no progress indicator and no watchdog." >&2
  echo "  Re-run with --force if that is genuinely what you want." >&2
  exit 1
fi

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

DID_SOMETHING=0

# --- 1. Unwire the hooks from settings.json --------------------------------
if [ -f "$SETTINGS" ]; then
  PY="$(command -v python3 || true)"
  if [ -z "$PY" ]; then
    echo "❌ python3 not found in PATH" >&2
    exit 1
  fi
  # Back up before touching the user's settings -- this file also carries
  # unrelated hooks and permissions.
  if [ "$DRY_RUN" -ne 1 ]; then
    cp "$SETTINGS" "$SETTINGS.bak-retire-$PROVIDER"
  fi
  SETTINGS_OUT="$(PYTHONIOENCODING=utf-8 "$PY" - "$SETTINGS" "$PROVIDER" "$DRY_RUN" <<'PYEOF'
import json, sys

settings_path, provider, dry_run = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
with open(settings_path) as f:
    cfg = json.load(f)
hooks = cfg.get('hooks') or {}

# Match this provider's progress hooks by the script filename they invoke:
# <provider>_progress.py, _clear.py, _reply_clear.py, _watchdog.py. Matching on
# the filename (not the whole command) keeps this robust to the interpreter
# path and to any bash -c wrapper the installer may have used.
needle = f"{provider}_progress"
removed = []

for event, groups in list(hooks.items()):
    if not isinstance(groups, list):
        continue
    for group in list(groups):
        entries = group.get('hooks')
        if not isinstance(entries, list):
            continue
        keep = []
        for entry in entries:
            command = entry.get('command') or ''
            if needle in command:
                removed.append(f"{event}: {command}")
            else:
                keep.append(entry)
        if len(keep) != len(entries):
            group['hooks'] = keep
        # Prune a group left empty -- an empty matcher group is dead weight
        # that later installs would otherwise keep appending next to.
        if not group.get('hooks'):
            groups.remove(group)
    if not groups:
        del hooks[event]

if removed and not dry_run:
    cfg['hooks'] = hooks
    with open(settings_path, 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)

for line in removed:
    print(f"REMOVED {line}")
print(f"COUNT {len(removed)}")
PYEOF
)"
  COUNT="$(echo "$SETTINGS_OUT" | grep '^COUNT ' | cut -d' ' -f2)"
  echo "$SETTINGS_OUT" | grep '^REMOVED ' | sed 's/^REMOVED /  - /' || true
  if [ "${COUNT:-0}" -gt 0 ]; then
    DID_SOMETHING=1
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "  [dry-run] would unwire $COUNT $PROVIDER progress hook(s) from settings.json"
    else
      echo "✓ Unwired $COUNT $PROVIDER progress hook(s) from settings.json"
    fi
  else
    echo "⊙ No $PROVIDER progress hooks wired in settings.json"
    # Nothing changed -- drop the backup so the directory does not collect
    # identical copies on every re-run.
    if [ "$DRY_RUN" -ne 1 ]; then
      rm -f "$SETTINGS.bak-retire-$PROVIDER"
    fi
  fi
fi

# --- 2. Stop and remove the watchdog daemon --------------------------------
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  LABEL="com.${SERVICE_ID}.${PROVIDER}-progress-watchdog"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [ -f "$PLIST" ]; then
    run launchctl unload "$PLIST" 2>/dev/null || true
    run rm -f "$PLIST"
    DID_SOMETHING=1
    echo "✓ Watchdog retired (launchd: $LABEL)"
  else
    echo "⊙ No $PROVIDER watchdog launchd agent installed"
  fi
else
  UNIT_DIR="$HOME/.config/systemd/user"
  SVC="${SERVICE_ID}-${PROVIDER}-progress-watchdog"
  if [ -f "$UNIT_DIR/$SVC.timer" ] || [ -f "$UNIT_DIR/$SVC.service" ]; then
    if pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
      run systemctl --user disable --now "$SVC.timer" 2>/dev/null || true
    fi
    run rm -f "$UNIT_DIR/$SVC.timer" "$UNIT_DIR/$SVC.service"
    if pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
      run systemctl --user daemon-reload
    fi
    DID_SOMETHING=1
    echo "✓ Watchdog retired (systemd: $SVC.timer + .service removed)"
  else
    echo "⊙ No $PROVIDER watchdog systemd units installed"
  fi
fi

if [ "$DID_SOMETHING" -eq 0 ]; then
  echo "Nothing to retire for '$PROVIDER' -- already clean."
fi
