#!/bin/bash
# owner-chat.sh -- shell port of src/owner-chat.ts resolveOwnerChatId (CHATID0).
#
# The installer default ALLOWED_CHAT_ID=0 is not empty and not falsy, so every
# shell consumer that tested for emptiness sent straight to chat 0 and earned
# a silent Bot API 400. This is the ONE place shell scripts decide "owner chat
# or nothing" -- source it, do not execute it:
#
#   resolve_owner_chat_id ENV_FILE [PROVIDER]
#
#   stdout: the chat id, or nothing when this install has no owner chat.
#   stderr: one reason line when stdout is empty.
#   Order (mirrors resolveOwnerChatId): the provider's configured .env key
#   first, then <state dir>/access.json (allowFrom -> groups -> channels,
#   first normalized non-placeholder entry).
#
# Bash 3.2 compatible (macOS system bash). JSON is read with `node -e`
# (spec "Nem spec-eredetű" 1.) -- no jq dependency assumed.

# _owner_chat_normalize VALUE -- "" (unset) or the trimmed id. "0" is the
# installer placeholder (src/owner-chat.ts normalizeChatId): neither empty
# nor falsy, so it must be refused explicitly, not just tested for emptiness.
_owner_chat_normalize() {
  local v="$1"
  v="$(printf '%s' "$v" | tr -d '\r')"
  # trim leading/trailing whitespace and surrounding quotes
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  v="${v%\"}"; v="${v#\"}"
  v="${v%\'}"; v="${v#\'}"
  if [ -z "$v" ] || [ "$v" = "0" ]; then
    return 1
  fi
  printf '%s' "$v"
}

# _owner_chat_env_key PROVIDER -- the .env key that carries this provider's
# configured owner chat (channel-provider.ts getChannelChatId).
_owner_chat_env_key() {
  case "$1" in
    slack) echo "SLACK_CHANNEL_ID" ;;
    discord) echo "DISCORD_CHANNEL_ID" ;;
    googlechat) echo "GOOGLECHAT_SPACE_ID" ;;
    teams) echo "TEAMS_ALLOWED_CONVERSATION_ID" ;;
    *) echo "ALLOWED_CHAT_ID" ;;
  esac
}

# _owner_chat_state_dir ENV_FILE PROVIDER -- channelStateDir(provider), shell
# side: <PROVIDER>_STATE_DIR env override, else install-scoped
# <install>/.claude/channels/<provider>, else legacy ~/.claude/channels/<provider>
# while the install-scoped one has no .env yet (channel-provider.ts #915).
_owner_chat_state_dir() {
  local env_file="$1" provider="$2" install_dir subdir override_var override
  install_dir="$(cd "$(dirname "$env_file")" && pwd)"
  case "$provider" in
    slack) subdir="slack" ;;
    discord) subdir="discord" ;;
    googlechat) subdir="googlechat" ;;
    teams) subdir="teams" ;;
    *) subdir="telegram" ;;
  esac
  override_var="$(printf '%s' "$provider" | tr '[:lower:]' '[:upper:]')_STATE_DIR"
  eval "override=\"\${$override_var:-}\""
  if [ -n "$override" ]; then
    printf '%s' "$override"
    return 0
  fi
  local installed="$install_dir/.claude/channels/$subdir"
  if [ -f "$installed/.env" ]; then
    printf '%s' "$installed"
    return 0
  fi
  local legacy="$HOME/.claude/channels/$subdir"
  if [ -f "$legacy/.env" ]; then
    printf '%s' "$legacy"
    return 0
  fi
  printf '%s' "$installed"
}

# _owner_chat_from_access ACCESS_JSON_PATH -- first normalized, non-placeholder
# id from allowFrom, then groups, then channels (owner-chat.ts order). Empty
# stdout (no output at all) when the file is missing/unreadable/malformed or
# nothing usable is found.
_owner_chat_from_access() {
  local path="$1"
  [ -f "$path" ] || return 1
  node -e '
    const fs = require("fs")
    let raw
    try { raw = JSON.parse(fs.readFileSync(process.argv[1], "utf-8")) } catch { process.exit(1) }
    function norm(v) {
      const s = String(v).trim().replace(/^["\x27]|["\x27]$/g, "")
      if (!s || s === "0") return null
      return s
    }
    if (Array.isArray(raw.allowFrom)) {
      for (const entry of raw.allowFrom) {
        const id = norm(entry)
        if (id) { process.stdout.write(id); process.exit(0) }
      }
    }
    for (const key of ["groups", "channels"]) {
      const map = raw[key]
      if (!map || typeof map !== "object") continue
      for (const k of Object.keys(map)) {
        const id = norm(k)
        if (id) { process.stdout.write(id); process.exit(0) }
      }
    }
    process.exit(1)
  ' "$path" 2>/dev/null
}

# resolve_owner_chat_id ENV_FILE [PROVIDER] -- see file header.
resolve_owner_chat_id() {
  local env_file="$1" provider="${2:-telegram}" key raw normalized state_dir access_id
  if [ ! -f "$env_file" ]; then
    echo "no owner chat: env file not found: $env_file" >&2
    return 1
  fi
  key="$(_owner_chat_env_key "$provider")"
  raw="$(grep -E "^${key}=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)"
  if normalized="$(_owner_chat_normalize "$raw")"; then
    printf '%s\n' "$normalized"
    return 0
  fi
  state_dir="$(_owner_chat_state_dir "$env_file" "$provider")"
  if access_id="$(_owner_chat_from_access "$state_dir/access.json")"; then
    printf '%s\n' "$access_id"
    return 0
  fi
  echo "no owner chat: .env placeholder/empty and no access.json owner" >&2
  return 1
}
