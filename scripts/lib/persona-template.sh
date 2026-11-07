#!/bin/bash
# PERSONAEN1107 / PERSONAESC1107 (Samu 72702, 72762 (b)): the language of everything the install writes for its agents
# (the persona templates here; the dashboard's managed CLAUDE.md sections through src/web/agent-text-lang.ts) is decided
# ONCE, at the first render, and kept in .env as AGENT_TEXT_LANG=en|hu. Every later render only reads it, so a re-run
# installer or `update.sh --regen-claudemd` never switches the language, and the persona and the managed sections always
# agree. An install without the key (every install from before this) is Hungarian, byte-for-byte as before.
#
#   agent_text_lang <dir>          the key, or hu without it
#   agent_text_lang_decide <dir>   the key if set; else, on a FIRST render (no CLAUDE.md yet), decide from MARVEEN_LANG or
#                                  the install's .lang (en only with the English template there), write the key into
#                                  .env, and print it; an existing install without the key stays hu (nothing written)
#   persona_template <dir> <name> [decide]
#                                  the template path in that language (decide: the first-render callers, i.e. the
#                                  installers and the Docker first-boot; without it: read only, e.g. update.sh)

_atl_read() {
  local v
  # The LAST occurrence and both quote kinds, as the TypeScript reader (src/env-parse.ts) takes it, so the persona and
  # the managed sections never disagree on a hand-edited .env (EGM review: two lines, or AGENT_TEXT_LANG='en').
  v="$(grep '^AGENT_TEXT_LANG=' "$1/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d "[:space:]\"'")"
  case "$v" in en|hu) printf '%s' "$v" ;; esac
}

agent_text_lang() {
  local v
  v="$(_atl_read "$1")"
  printf '%s' "${v:-hu}"
}

agent_text_lang_decide() {
  local dir="$1" v lang
  v="$(_atl_read "$dir")"
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  if [ -f "$dir/CLAUDE.md" ]; then printf 'hu'; return 0; fi
  lang="${MARVEEN_LANG:-}"
  [ -n "$lang" ] || lang="$(head -1 "$dir/.lang" 2>/dev/null | tr -d '[:space:]')"
  if [ "$lang" = en ] && [ -f "$dir/templates/en/CLAUDE.md.template" ]; then lang=en; else lang=hu; fi
  if [ -f "$dir/.env" ]; then
    # A last line without a newline would swallow the key.
    [ -s "$dir/.env" ] && [ -n "$(tail -c1 "$dir/.env")" ] && printf '\n' >> "$dir/.env"
    printf 'AGENT_TEXT_LANG=%s\n' "$lang" >> "$dir/.env"
  fi
  printf '%s' "$lang"
}

persona_template() {
  local dir="$1" name="$2" lang
  if [ "${3:-}" = decide ]; then lang="$(agent_text_lang_decide "$dir")"; else lang="$(agent_text_lang "$dir")"; fi
  if [ "$lang" = en ] && [ -f "$dir/templates/en/$name" ]; then
    printf '%s' "$dir/templates/en/$name"
  else
    printf '%s' "$dir/templates/$name"
  fi
}
