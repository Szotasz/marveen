#!/bin/bash
# PERSONAEN1107 (HOSTINGERDOCKER1107, Samu 72702): the main agent's persona template (CLAUDE.md, SOUL.md) in the
# install's language. The Hungarian one is the default; the English one (templates/en/, a faithful translation) only
# when the install's language is English AND the file is there. The language: MARVEEN_LANG if set, else the
# install's .lang (install.sh writes it), else Hungarian.
# Usage: . scripts/lib/persona-template.sh; persona_template <install dir> <CLAUDE.md.template|SOUL.md.template>
persona_template() {
  local dir="$1" name="$2" lang="${MARVEEN_LANG:-}"
  [ -n "$lang" ] || lang="$(head -1 "$dir/.lang" 2>/dev/null | tr -d '[:space:]')"
  if [ "$lang" = en ] && [ -f "$dir/templates/en/$name" ]; then
    printf '%s' "$dir/templates/en/$name"
  else
    printf '%s' "$dir/templates/$name"
  fi
}
