#!/bin/bash
# APIKEYSCOPE1107 (APIKULCSINDITAS1004 B): the install's auth mode, the bash twin of authKeyModeFrom in
# src/web/auth-key-mode.ts. Sourced, never executed. A parity test runs both on the same fixtures.
#   subscription: an OAuth token exists (.env CLAUDE_CODE_OAUTH_TOKEN, or a non-empty store/.claude-oauth-token);
#   keyonly:      no OAuth token, .env has ANTHROPIC_API_KEY;
#   none:         neither.
# .env is read the way channels.sh reads it: the first `KEY=` line, the raw value after the first `=`.

auth_key_mode() { # install dir -> prints subscription|keyonly|none
  local dir="$1" oauth="" key=""
  if [ -f "$dir/.env" ]; then
    oauth="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$dir/.env" | head -1 | cut -d= -f2-)"
    key="$(grep -E '^ANTHROPIC_API_KEY=' "$dir/.env" | head -1 | cut -d= -f2-)"
  fi
  # a whitespace-only token file is no token (the launchers read it with $(cat) / trim it)
  if [ -n "$oauth" ] || { [ -f "$dir/store/.claude-oauth-token" ] && [ -n "$(tr -d '[:space:]' < "$dir/store/.claude-oauth-token")" ]; }; then
    printf '%s\n' subscription
  elif [ -n "$key" ]; then
    printf '%s\n' keyonly
  else
    printf '%s\n' none
  fi
}

# The owner-facing sentence for a mode, HU or EN (Samu 72223). Names the key's VARIABLE, never its value.
auth_key_mode_notice() { # mode lang -> one paragraph, or nothing (none)
  case "$1:$2" in
    subscription:en) printf '%s\n' "Marveen: .env holds an API key (ANTHROPIC_API_KEY) next to the subscription login. Until this version that key could reach every sub-agent: their sessions stopped at Claude Code's API-key question, or background calls were billed to the key. From this version only agents set to authMode=api and the main agent get it. To do: check the key's usage in the Anthropic Console; set authMode=api on any agent that should run on the key; if none should, remove the line from .env." ;;
    subscription:*)  printf '%s\n' "Marveen: a .env-ben API-kulcs (ANTHROPIC_API_KEY) áll az előfizetéses belépés mellett. Eddig ez a kulcs minden al-ügynökhöz eljuthatott: a munkamenetek a Claude Code API-kulcs-kérdésénél álltak, vagy a háttérhívások a kulcson számláztak. Ettől a verziótól csak az authMode=api beállítású ügynökök és a fő ügynök kapják meg. Teendő: nézd meg a kulcs használatát az Anthropic Console-ban; ha egy ügynöknek a kulcson kell futnia, állítsd authMode=api-ra; ha egyiknek sem, töröld a sort a .env-ből." ;;
    keyonly:en)      printf '%s\n' "Marveen: on this install the API key (ANTHROPIC_API_KEY) is the only Claude login, and the fleet runs on it (the Console bills per token). From this version every sub-agent gets its approval for the key, so no sub-agent session stops at Claude Code's API-key question. Nothing to do." ;;
    keyonly:*)       printf '%s\n' "Marveen: ezen a telepítésen az API-kulcs (ANTHROPIC_API_KEY) az egyetlen Claude-belépés, a flotta ezen fut (a Console tokenenként számláz). Ettől a verziótól minden al-ügynök megkapja a jóváhagyást a kulcsra, így egyik al-ügynök munkamenete sem áll meg a Claude Code API-kulcs-kérdésénél. Teendő nincs." ;;
    *) ;;
  esac
}
