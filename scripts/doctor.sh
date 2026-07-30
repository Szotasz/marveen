#!/bin/bash
# Marveen system health check. Run: bash scripts/doctor.sh
# Exit 0 = all OK, 1 = something failed

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; FAIL=1; }

FAIL=0
MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
# Dashboard port: env WEB_PORT, else .env, else the 3420 default. A fixed 3420
# made this diagnostic report a RUNNING dashboard as dead on any other port --
# and it is run precisely when something is already wrong.
WEB_PORT="${WEB_PORT:-$(grep -E '^WEB_PORT=' "$(dirname "$0")/../.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')}"
WEB_PORT="${WEB_PORT:-3420}"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"

echo -e "\n${BOLD}Marveen Doctor${RESET}: $(date '+%Y-%m-%d %H:%M:%S')\n"

# --- Services (systemd on Linux, launchd on macOS) ---
echo -e "${BOLD}Services${RESET}"
for component in channels dashboard; do
  if [ "$(uname -s)" = "Darwin" ]; then
    # launchd label convention: com.<MAIN_AGENT_ID>.<component>
    label="com.${MAIN_AGENT_ID}.${component}"
    # `launchctl list` prints "PID Status Label"; a literal "-" PID means loaded
    # but not currently running.
    pid="$(launchctl list 2>/dev/null | awk -v l="$label" '$3 == l {print $1}')"
    if [ -n "$pid" ] && [ "$pid" != "-" ]; then
      ok "$label: running (pid $pid)"
    elif [ -n "$pid" ]; then
      fail "$label: loaded but NOT running"
    else
      fail "$label: not loaded"
    fi
  else
    svc="${MAIN_AGENT_ID}-${component}"
    if systemctl --user is-active "$svc.service" &>/dev/null; then
      ok "$svc: running"
    else
      fail "$svc: NOT running"
    fi
  fi
done

# --- Tmux sessions ---
echo -e "\n${BOLD}Tmux sessions${RESET}"
if tmux has-session -t "${MAIN_AGENT_ID}-channels" 2>/dev/null; then
  ok "${MAIN_AGENT_ID}-channels: alive"
else
  warn "${MAIN_AGENT_ID}-channels: not running"
fi

# The heartbeat SUB-AGENT (session agent-heartbeat) is opt-in and OFF by default
# -- see the HEARTBEAT_AGENT_ENABLED gate in src/index.ts. Warning about a
# missing session on an install that never asked for it is pure noise, so only
# complain when it is actually switched on. The flag can come from .env or from
# the dashboard's store/config-overrides.json.
HB_AGENT=$(grep -E "^HEARTBEAT_AGENT_ENABLED=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')
if [ -z "$HB_AGENT" ] && [ -f store/config-overrides.json ]; then
  HB_AGENT=$(python3 -c "import json,sys;print(json.load(open('store/config-overrides.json')).get('HEARTBEAT_AGENT_ENABLED',''))" 2>/dev/null)
fi
if [ "$HB_AGENT" = "1" ]; then
  if tmux has-session -t "agent-heartbeat" 2>/dev/null; then
    ok "agent-heartbeat: alive"
  else
    warn "agent-heartbeat: enabled but NOT running"
  fi
else
  ok "agent-heartbeat: off by design (HEARTBEAT_AGENT_ENABLED not set)"
fi

# --- Channel health ---
echo -e "\n${BOLD}Telegram bridge${RESET}"
bash scripts/verify-channels-health.sh 2>&1 | grep -E '^\s+\(|HEALTHY|UNHEALTHY' | while read line; do
  case "$line" in
    *OK*) echo -e "  ${GREEN}✓${RESET} $line" ;;
    *FAIL*) echo -e "  ${RED}✗${RESET} $line"; FAIL=1 ;;
    *) echo "  $line" ;;
  esac
done
# Re-check exit code separately since subshell can't set FAIL
if ! bash scripts/verify-channels-health.sh &>/dev/null; then
  FAIL=1
fi

# --- Managed-settings channel org-policy gate ---
# claude-code >= 2.1.205 silently drops channel-plugin INBOUND notifications on a
# team/enterprise org unless the system managed-settings has channelsEnabled:true.
# Diagnostic only (warn, not fail): a personal org ignores the flag.
echo -e "\n${BOLD}Managed-settings${RESET}"
case "$(uname -s)" in
  Darwin) MANAGED_FILE="/Library/Application Support/ClaudeCode/managed-settings.json" ;;
  Linux)  MANAGED_FILE="/etc/claude-code/managed-settings.json" ;;
  *)      MANAGED_FILE="" ;;
esac
if [ -z "$MANAGED_FILE" ]; then
  warn "channelsEnabled: nem tamogatott OS -- kihagyva"
elif [ -f "$MANAGED_FILE" ] && python3 -c "import json,sys; sys.exit(0 if json.load(open('$MANAGED_FILE')).get('channelsEnabled') is True else 1)" 2>/dev/null; then
  ok "channelsEnabled: OK ($MANAGED_FILE)"
else
  warn "channelsEnabled: HIANYZIK -- team/enterprise orgnal a bejovo channel-uzenetek eldobodhatnak. Fix: bash scripts/ensure-managed-channels-enabled.sh"
fi

# --- Channel keepalive ---
echo -e "\n${BOLD}Keepalive${RESET}"
KA_FILE="store/.channel-keepalive"
if [ -f "$KA_FILE" ]; then
  # GNU stat uses -c "%Y", BSD/macOS stat uses -f "%m"
  if [ "$(uname -s)" = "Darwin" ]; then
    KA_MTIME=$(stat -f "%m" "$KA_FILE")
  else
    KA_MTIME=$(stat -c "%Y" "$KA_FILE")
  fi
  KA_AGE=$(( $(date +%s) - KA_MTIME ))
  if [ "$KA_AGE" -lt 600 ]; then
    ok "channel-keepalive: refreshed ${KA_AGE}s ago"
  elif [ "$KA_AGE" -lt 1200 ]; then
    warn "channel-keepalive: ${KA_AGE}s ago (watch out, restart after 18 min)"
  else
    fail "channel-keepalive: STALE (${KA_AGE}s) -- dashboard will likely restart"
  fi
else
  fail "channel-keepalive: file missing"
fi

# --- Settings ---
echo -e "\n${BOLD}Configuration${RESET}"
if [ -f ".claude/settings.json" ]; then
  MODEL=$(python3 -c "import json; d=json.load(open('.claude/settings.json')); print(d.get('model','NONE'))" 2>/dev/null)
  ok "Model: $MODEL"
  HOOK_COUNT=$(python3 -c "import json; d=json.load(open('.claude/settings.json')); print(len(d.get('hooks',{})))" 2>/dev/null)
  ok "Hooks: $HOOK_COUNT configured"
else
  fail ".claude/settings.json missing"
fi

# --- .env keys ---
echo -e "\n${BOLD}.env keys${RESET}"
for key in MAIN_AGENT_ID BOT_NAME TELEGRAM_BOT_TOKEN ALLOWED_CHAT_ID; do
  val=$(grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2-)
  if [ -n "$val" ]; then ok "$key: present"; else fail "$key: MISSING"; fi
done
# Auth: mirrors claudeAuthPresent() in src/web/routes/onboarding.ts -- there are
# five legs, and only the first two live in .env. Checking .env alone reported a
# perfectly authenticated macOS install (Keychain leg) as broken.
# The Keychain probe is presence-only (no `-w`), so the secret never leaves it.
API_KEY=$(grep -E "^ANTHROPIC_API_KEY=" .env 2>/dev/null | head -1 | cut -d= -f2-)
OAUTH=$(grep -E "^CLAUDE_CODE_OAUTH_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)
if [ -n "$API_KEY" ]; then
  ok "Claude auth: present (.env API key)"
elif [ -n "$OAUTH" ]; then
  ok "Claude auth: present (.env OAuth token)"
elif [ -s "$HOME/.claude/.credentials.json" ]; then
  ok "Claude auth: present (~/.claude/.credentials.json)"
elif [ -s "store/.claude-oauth-token" ]; then
  ok "Claude auth: present (fleet setup-token in store/)"
elif [ "$(uname -s)" = "Darwin" ] && /usr/bin/security find-generic-password \
     -s "Claude Code-credentials" -a "$(id -un)" >/dev/null 2>&1; then
  ok "Claude auth: present (macOS Keychain)"
else
  fail "Claude auth: no credential found (env, credentials.json, fleet token, Keychain)"
fi

# --- Claude headless auth (official: long-lived setup-token) ---
echo -e "\n${BOLD}Claude headless auth${RESET}"
if grep -qE '^CLAUDE_CODE_OAUTH_TOKEN="?sk-ant-oat01-' .env 2>/dev/null; then
  ok "Headless token: long-lived setup-token configured (CLAUDE_CODE_OAUTH_TOKEN, ~1 year)"
elif grep -qE '^CLAUDE_CODE_OAUTH_TOKEN=' .env 2>/dev/null; then
  warn "CLAUDE_CODE_OAUTH_TOKEN set, but not sk-ant-oat01- format (may be the wrong type)"
elif [ "$(uname -s)" = "Darwin" ] && /usr/bin/security find-generic-password \
     -s "Claude Code-credentials" -a "$(id -un)" >/dev/null 2>&1; then
  ok "Headless token: not set, but the macOS Keychain holds a Claude login (interactive sessions are fine; only add a setup-token if you run agents headless)"
else
  warn "CLAUDE_CODE_OAUTH_TOKEN missing -- run: claude setup-token, then put it in .env"
fi
# .credentials.json is now only a legacy fallback (setup-token takes precedence), not critical if expired.
CREDS="$HOME/.claude/.credentials.json"
if [ -f "$CREDS" ]; then
  HOURS_LEFT=$(python3 -c "import json,time; o=json.load(open('$CREDS')).get('claudeAiOauth',{}); e=o.get('expiresAt',0); print(round((e-time.time()*1000)/3600000,1) if e else -1)" 2>/dev/null)
  [ "$HOURS_LEFT" != "-1" ] && echo "  (legacy .credentials.json: ${HOURS_LEFT}h left -- not critical alongside the setup-token)"
fi

# --- Ledger hook scripts ---
echo -e "\n${BOLD}Hook scripts${RESET}"
for f in scripts/hooks/ledger-capture.py scripts/hooks/ledger-outbound.py scripts/hooks/ledger-replay.py; do
  if [ -f "$f" ]; then ok "$f"; else fail "$f missing"; fi
done

# --- Dashboard API ---
echo -e "\n${BOLD}Dashboard${RESET}"
if [ -f "store/.dashboard-token" ]; then
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $(cat store/.dashboard-token)" "http://localhost:${WEB_PORT}/api/agents" 2>/dev/null)
  if [ "$HTTP" = "200" ]; then
    ok "Dashboard API: responding (HTTP 200)"
  else
    fail "Dashboard API: HTTP $HTTP"
  fi
else
  fail "store/.dashboard-token missing"
fi

# --- Database ---
echo -e "\n${BOLD}Database${RESET}"
if [ -f "store/claudeclaw.db" ]; then
  MEM=$(sqlite3 store/claudeclaw.db "SELECT COUNT(*) FROM memories;" 2>/dev/null || echo "?")
  ok "claudeclaw.db: alive ($MEM memories)"
else
  fail "store/claudeclaw.db missing"
fi

# --- Scheduled tasks ---
echo -e "\n${BOLD}Scheduled tasks${RESET}"
if [ -d ~/.claude/scheduled-tasks ]; then
  ENABLED=0; DISABLED=0
  for d in ~/.claude/scheduled-tasks/*/; do
    enabled=$(python3 -c "import json; c=json.load(open('$d/task-config.json')); print(c.get('enabled', True))" 2>/dev/null)
    name=$(basename "$d")
    if [ "$enabled" = "True" ]; then
      ok "$name: active"
      ENABLED=$((ENABLED+1))
    else
      warn "$name: disabled"
      DISABLED=$((DISABLED+1))
    fi
  done
  [ "$ENABLED" -eq 0 ] && warn "No active scheduled task"
else
  warn "~/.claude/scheduled-tasks does not exist"
fi

# --- Recent failures log ---
echo -e "\n${BOLD}Failures (last 24h)${RESET}"
if [ -f "store/channels-failures.log" ]; then
  RECENT=$(find store/channels-failures.log -mmin -1440 2>/dev/null)
  if [ -n "$RECENT" ]; then
    COUNT=$(wc -l < store/channels-failures.log)
    warn "channels-failures.log: $COUNT entries"
    tail -3 store/channels-failures.log | while read line; do echo "    $line"; done
  else
    ok "No recent failures"
  fi
else
  ok "No failure log"
fi

# --- Summary ---
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All OK.${RESET}\n"
else
  echo -e "${RED}${BOLD}There are failures -- check the ✗ lines above.${RESET}\n"
fi
exit "$FAIL"
