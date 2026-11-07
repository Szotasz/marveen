#!/bin/bash
# HOSTINGERDOCKER1107: what the Linux installer writes before its services start, done in the container on every
# start, each step only when its target is missing (idempotent). The configuration the installer asks for (the owner,
# the names, the Claude token, the channel token, the pairing) is left to the dashboard's first-run wizard.
# Inputs (compose environment): MARVEEN_CHANNEL (telegram|discord|slack), MARVEEN_AGENT_ID, MARVEEN_LANG, TZ, WEB_PORT.
set -u
INSTALL_DIR="${MARVEEN_INSTALL_DIR:-/opt/marveen}"
cd "$INSTALL_DIR" || exit 1
umask 077
say() { printf 'first-boot: %s\n' "$*"; }

CHANNEL="${MARVEEN_CHANNEL:-telegram}"
case "$CHANNEL" in telegram|discord|slack) ;; *) say "MARVEEN_CHANNEL must be telegram, discord or slack (got: $CHANNEL)"; exit 2 ;; esac
AGENT_ID="${MARVEEN_AGENT_ID:-marveen}"
printf '%s' "$AGENT_ID" | grep -Eqx '[a-z][a-z0-9-]{1,30}' || { say "MARVEEN_AGENT_ID must be a lower-case slug (got: $AGENT_ID)"; exit 2; }
WEB_PORT="${WEB_PORT:-3420}"
# Until the wizard's identity step: a name the wizard's rename replaces everywhere (ONB: it renames only a set name).
OWNER_NAME=Owner
BOT_NAME=Marveen

set_env_key() { # key value: replace the line or append it (the .env is ours, 0600)
  if grep -q "^$1=" .env 2>/dev/null; then
    python3 -I -c 'import sys
k, v, p = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(p).read().splitlines()
open(p, "w").write("\n".join(f"{k}={v}" if l.startswith(k + "=") else l for l in lines) + "\n")' "$1" "$2" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

mkdir -p store agents workspace
if [ ! -f .env ]; then
  {
    printf '%s\n' "# Written by the Marveen container on its first start. The dashboard's wizard fills in the rest."
    printf 'CHANNEL_PROVIDER=%s\n' "$CHANNEL"
    printf 'OWNER_NAME=%s\nBOT_NAME=%s\nBRAND_NAME=%s\n' "$OWNER_NAME" "$BOT_NAME" "$BOT_NAME"
    printf 'MAIN_AGENT_ID=%s\nSERVICE_ID=%s\n' "$AGENT_ID" "$AGENT_ID"
    printf 'WEB_PORT=%s\n' "$WEB_PORT"
    printf 'SYSTEM_SENDER_IDS=prod-tree-guard,channels-sh-guard\n'
    [ "$CHANNEL" = telegram ] && printf 'ALLOWED_CHAT_ID=0\n'
    printf 'MAIN_AGENT_ISOLATED_CONFIG=1\n'
  } > .env
  say ".env written (channel: $CHANNEL, agent: $AGENT_ID)"
fi
# The container's own keys, on every start (an older .env gets them too).
set_env_key WEB_HOST 0.0.0.0
set_env_key MARVEEN_DEPLOYMENT docker
set_env_key CLAUDE_NATIVE_AUTOUPDATE 0
# The optional services of docker-compose.yml: the Ollama of the compose network, and the TLS proxy's public address
# (the CSRF allowlist and the browser links need it; the proxy sends X-Forwarded-Proto=https, so the cookie is Secure).
[ -n "${MARVEEN_OLLAMA_URL:-}" ] && set_env_key OLLAMA_URL "$MARVEEN_OLLAMA_URL"
if [ -n "${MARVEEN_DOMAIN:-}" ]; then
  printf '%s' "$MARVEEN_DOMAIN" | grep -Eqx '[A-Za-z0-9.-]{1,253}' || { say "MARVEEN_DOMAIN is not a host name: $MARVEEN_DOMAIN"; exit 2; }
  set_env_key DASHBOARD_PUBLIC_URL "https://$MARVEEN_DOMAIN"
fi
chmod 0600 .env

[ -f .lang ] || printf '%s\n' "${MARVEEN_LANG:-en}" > .lang

# Read the identity back from .env (a finished wizard changed it).
env_val() { grep -m1 "^$1=" .env | cut -d= -f2-; }
OWNER_NAME="$(env_val OWNER_NAME)"; BOT_NAME="$(env_val BOT_NAME)"; AGENT_ID="$(env_val MAIN_AGENT_ID)"
esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
O="$(esc "$OWNER_NAME")"; B="$(esc "$BOT_NAME")"; A="$(esc "$AGENT_ID")"

# The persona in the install's language (PERSONAEN1107): the helper picks templates/en/ for an English install; an image
# from before it renders the Hungarian template, as the installer did.
persona() { if [ -f scripts/lib/persona-template.sh ]; then (. scripts/lib/persona-template.sh; persona_template "$INSTALL_DIR" "$1"); else printf '%s' "templates/$1"; fi; }
if [ ! -f CLAUDE.md ] && [ -f templates/CLAUDE.md.template ]; then
  TZV="$(. scripts/lib/install-tz.sh; z="$(install_tz "$INSTALL_DIR")"; printf '%s' "${z:-UTC}")"
  sed -e "s/{{OWNER_NAME}}/$O/g" -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" -e "s/{{CHAT_ID}}/0/g" -e "s/{{BOT_NAME}}/$B/g" \
      -e "s/{{MAIN_AGENT_ID}}/$A/g" -e "s/{{WEB_PORT}}/$WEB_PORT/g" -e "s|{{TIMEZONE}}|$(esc "$TZV")|g" \
      "$(persona CLAUDE.md.template)" > CLAUDE.md
  say "CLAUDE.md written"
fi
if [ ! -f SOUL.md ] && [ -f templates/SOUL.md.template ]; then
  sed -e "s/{{OWNER_NAME}}/$O/g" -e "s/{{BOT_NAME}}/$B/g" "$(persona SOUL.md.template)" > SOUL.md
  say "SOUL.md written"
fi

# ~/.claude: the dirs, the first-run answers claude would otherwise stop on (IL:1167-1218).
mkdir -p "$HOME/.claude/channels" "$HOME/.claude/skills" "$HOME/.claude/scheduled-tasks"
chmod 0700 "$HOME/.claude" "$HOME/.claude/channels" "$HOME/.claude/skills" "$HOME/.claude/scheduled-tasks"
[ -f "$HOME/.claude.json" ] || printf '%s\n' '{"hasCompletedOnboarding": true, "theme": "dark"}' > "$HOME/.claude.json"
[ -f "$HOME/.claude/settings.json" ] || printf '%s\n' '{"skipDangerousModePermissionPrompt": true}' > "$HOME/.claude/settings.json"

# Scheduled tasks: the templates and the seeds, as the installer does (existing and removed ones are kept as they are).
SCHED="$HOME/.claude/scheduled-tasks"
REGISTER=""
copy_task() { # template dir, task name
  local tpl="$1" target="$SCHED/$2" sub f
  mkdir -p "$target"
  for sub in "" "references/"; do
    [ -z "$sub" ] || [ -d "$tpl$sub" ] || continue
    mkdir -p "$target/$sub"
    for f in "$tpl$sub"*; do
      [ -f "$f" ] || continue
      sed -e "s/{{MAIN_AGENT_ID}}/$A/g" -e "s/{{BOT_NAME}}/$B/g" -e "s/{{OWNER_NAME}}/$O/g" \
          -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" -e "s/{{WEB_PORT}}/$WEB_PORT/g" "$f" > "$target/$sub$(basename "$f")"
    done
  done
  REGISTER="$REGISTER $2"
}
for tpl in templates/scheduled-tasks/*/; do
  [ -d "$tpl" ] || continue; n="$(basename "$tpl")"
  [ -d "$SCHED/$n" ] || copy_task "$tpl" "$n"
done
for tpl in seed-scheduled-tasks/*/; do
  [ -d "$tpl" ] || continue; n="$(basename "$tpl")"
  [ "$n" = bumblebee-hygiene-scan ] && continue
  [ -f "$SCHED/.removed-defaults" ] && grep -qxF "$n" "$SCHED/.removed-defaults" && continue
  [ -d "$SCHED/$n" ] || copy_task "$tpl" "$n"
done
if [ -n "${REGISTER// /}" ]; then
  [ -f store/kanban-audit-state.json ] || printf '%s\n' '{"last_audit_at":null}' > store/kanban-audit-state.json
  # shellcheck disable=SC2086 # the names are directory names of the image
  node dist/web/schedule-registry-cli.js register --source installer $REGISTER >/dev/null 2>&1 \
    || say "WARN: the scheduled-task registry did not take:$REGISTER"
  say "scheduled tasks seeded:$REGISTER"
fi

for cfg in seed-config/*.json; do
  [ -f "$cfg" ] && [ ! -f "store/$(basename "$cfg")" ] && cp "$cfg" "store/$(basename "$cfg")"
done

# Skills: the whole tree of each (the installer copies sub-dirs through git ls-files; the image has no .git).
for src in skills/skill-factory seed-skills/*/; do
  [ -d "$src" ] || continue; n="$(basename "$src")"
  [ -e "$HOME/.claude/skills/$n" ] || { cp -R "$src" "$HOME/.claude/skills/$n" && say "skill seeded: $n"; }
done

# The hooks, as update.sh installs them (idempotent).
bash scripts/sync-hooks.sh >/dev/null 2>&1 || say "WARN: scripts/sync-hooks.sh failed"

# The channel plugin of the chosen provider ONLY (an installed channel plugin's server would start in every session).
case "$(env_val CHANNEL_PROVIDER)" in
  slack) PLUGIN=slack-channel@marveen-marketplace; MARKET=Szotasz/marveen-marketplace ;;
  discord) PLUGIN=discord@claude-plugins-official; MARKET=anthropics/claude-plugins-official ;;
  *) PLUGIN=telegram@claude-plugins-official; MARKET=anthropics/claude-plugins-official ;;
esac
if ! grep -qs "\"${PLUGIN}\"" "$HOME/.claude/plugins/installed_plugins.json"; then
  if claude plugin marketplace add "$MARKET" >/dev/null 2>&1 && claude plugin install "$PLUGIN" >/dev/null 2>&1; then
    say "channel plugin installed: $PLUGIN"
  else
    say "WARN: the channel plugin $PLUGIN did not install (network?); the next start tries again"
  fi
fi
exit 0
