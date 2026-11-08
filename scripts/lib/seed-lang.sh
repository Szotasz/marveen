#!/bin/bash
# PERSONAESC1107 seed A (Samu 72845, 73234): an English install gets the English seed texts. A seeded Markdown file
# `<rel>` (repo-relative: seed-skills/..., seed-scheduled-tasks/..., scheduled-tasks/...) may have an English version at
# `seed_en_rel <rel>`. On an install whose AGENT_TEXT_LANG is en (decided once by scripts/lib/persona-template.sh, only
# READ here) the seeders write the English version's bytes to the target path of `<rel>`. src/web/seed-lang.ts is the
# same rule for the dashboard's ensureDefaultScheduledTasks.
#
#   seed_lang <install dir>                 en|hu (persona-template.sh agent_text_lang, read only)
#   seed_en_rel <rel>                       the English version's repo-relative path (it may not exist)
#   seed_src_for <install dir> <rel> <lang> the absolute file to read for <rel>: the English version on en when it
#                                           exists, else <rel> itself
#
# A seeder sources this once. Without it (an older image, a test harness that slices one loop out of a script) the
# caller defines the fallback: hu, the plain file, i.e. the behaviour before seed A.

_seed_lang_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=persona-template.sh
. "$_seed_lang_dir/persona-template.sh"

seed_lang() {
  case "$(agent_text_lang "$1")" in en) printf 'en' ;; *) printf 'hu' ;; esac
}

seed_en_rel() {
  case "$1" in *.md) printf 'i18n/en/%s' "$1" ;; esac
}

seed_src_for() {
  local install="$1" rel="$2" lang="$3" en
  if [ "$lang" = en ]; then
    en="$(seed_en_rel "$rel")"
    if [ -n "$en" ] && [ -f "$install/$en" ]; then printf '%s' "$install/$en"; return 0; fi
  fi
  printf '%s' "$install/$rel"
}
