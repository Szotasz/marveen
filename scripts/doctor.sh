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
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"

echo -e "\n${BOLD}Marveen Doctor${RESET}: $(date '+%Y-%m-%d %H:%M:%S')\n"

# --- Systemd services ---
echo -e "${BOLD}Services${RESET}"
for svc in "${MAIN_AGENT_ID}-channels" "${MAIN_AGENT_ID}-dashboard"; do
  if systemctl --user is-active "$svc.service" &>/dev/null; then
    ok "$svc: running"
  else
    fail "$svc: NOT running"
  fi
done

# --- Tmux sessions ---
echo -e "\n${BOLD}Tmux sessions${RESET}"
for sess in "${MAIN_AGENT_ID}-channels" "agent-heartbeat"; do
  if tmux has-session -t "$sess" 2>/dev/null; then
    ok "$sess: alive"
  else
    warn "$sess: not running"
  fi
done

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

# --- Channel keepalive ---
echo -e "\n${BOLD}Keepalive${RESET}"
KA_FILE="store/.channel-keepalive"
if [ -f "$KA_FILE" ]; then
  KA_AGE=$(( $(date +%s) - $(stat -c "%Y" "$KA_FILE") ))
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
# Auth: API key OR OAuth token is enough
API_KEY=$(grep -E "^ANTHROPIC_API_KEY=" .env 2>/dev/null | head -1 | cut -d= -f2-)
OAUTH=$(grep -E "^CLAUDE_CODE_OAUTH_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2-)
if [ -n "$API_KEY" ] || [ -n "$OAUTH" ]; then
  ok "Claude auth: present ($([ -n "$API_KEY" ] && echo 'API key' || echo 'OAuth'))"
else
  fail "Claude auth: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN"
fi

# --- Claude headless auth (official: long-lived setup-token) ---
echo -e "\n${BOLD}Claude headless auth${RESET}"
if grep -qE '^CLAUDE_CODE_OAUTH_TOKEN="?sk-ant-oat01-' .env 2>/dev/null; then
  ok "Headless token: long-lived setup-token configured (CLAUDE_CODE_OAUTH_TOKEN, ~1 year)"
elif grep -qE '^CLAUDE_CODE_OAUTH_TOKEN=' .env 2>/dev/null; then
  warn "CLAUDE_CODE_OAUTH_TOKEN set, but not sk-ant-oat01- format (may be the wrong type)"
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
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $(cat store/.dashboard-token)" http://localhost:3420/api/agents 2>/dev/null)
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
