# shellcheck shell=bash
# DOCKERSEEDREFRESH1108: the seed refresh of a Docker volume. The image has no .git and update.sh never runs here, so a
# volume kept the seed texts it was first booted with. docker/seed-snapshot.sh copies the seed SOURCES of the tree the
# volume ran into .seed-prev before code-sync swaps the code; after the swap first-boot sources scripts/lib/seed-refresh.sh
# (the same rules update.sh runs) and this file, and calls docker_seed_refresh. This file defines the lib's seams:
#   seed_copy_is_untouched  the copy equals the render of .seed-prev/<rel> or of the current tree's <rel> (git's history
#                           always holds the current version too: a retry or an earlier partial run stays untouched), with
#                           EITHER identity: the current .env names, or the ones first-boot renders with before the
#                           wizard (Owner / Marveen; the wizard renames only .env, CLAUDE.md and SOUL.md)
#   seed_tracked_files      every file under the dir (the image build removed every gitignored file of the seed dirs)
#   sched_task_verified_ok  the registry verdict, recorded per task in .seed-prev/.verdicts on its first ask, so a run
#                           that crashed after a write still answers with the verdict from BEFORE the write
#   register_seeded_schedules  the registry CLI with --source installer, as first-boot registers its seeds
# Sourcing it defines functions only.

seed_hash() {
  shasum -a 256 | awk '{print $1}'
}

seed_copy_is_untouched() {
  _du_installed="$1"; _du_rel="$2"; _du_mode="${3:-verbatim}"
  [ -f "$_du_installed" ] || return 1
  _du_cur="$(seed_hash <"$_du_installed")"
  [ -n "$_du_cur" ] || return 1
  for _du_src in "$INSTALL_DIR/.seed-prev/$_du_rel" "$INSTALL_DIR/$_du_rel"; do
    [ -f "$_du_src" ] && [ ! -L "$_du_src" ] || continue
    [ "$(render_seed_stream "$_du_mode" "$_du_rel" <"$_du_src" | seed_hash)" = "$_du_cur" ] && return 0
    [ "$(OWNER_NAME="$SEED_DEFAULT_OWNER" BOT_NAME="$SEED_DEFAULT_BOT" render_seed_stream "$_du_mode" "$_du_rel" <"$_du_src" | seed_hash)" = "$_du_cur" ] && return 0
  done
  return 1
}

seed_tracked_files() {
  (cd "$1" 2>/dev/null && find . -type f) | sed 's|^\./||' | LC_ALL=C sort
}

sched_task_verified_ok() {
  _dv_rec="$INSTALL_DIR/.seed-prev/.verdicts/$1"
  if [ -f "$_dv_rec" ]; then
    return "$(cat "$_dv_rec")"
  fi
  _dv_rc=2
  _dv_cli="$INSTALL_DIR/dist/web/schedule-registry-cli.js"
  if [ -f "$_dv_cli" ] && command -v node >/dev/null 2>&1; then
    _dv_out="$(node "$_dv_cli" verify "$1" 2>/dev/null)" && _dv_rc=0 || _dv_rc=$?
    # update.sh's rule: 1 is a verdict only with the CLI's own "<verdict> <name>" line (not registry-error).
    if [ "$_dv_rc" = 1 ] && ! printf '%s\n' "$_dv_out" | grep -xE "[a-z-]+ $1" | grep -qv '^registry-error '; then _dv_rc=2; fi
    case "$_dv_rc" in 0|1) ;; *) _dv_rc=2 ;; esac
  fi
  mkdir -p "$INSTALL_DIR/.seed-prev/.verdicts" && printf '%s' "$_dv_rc" > "$_dv_rec"
  return "$_dv_rc"
}

register_seeded_schedules() {
  _dr_names="${SCHED_REGISTER_NAMES:-}"
  SCHED_REGISTER_NAMES=""
  [ -n "$(echo "$_dr_names" | tr -d ' ')" ] || return 0
  # shellcheck disable=SC2086 # word-splitting the name list is intended
  if node "$INSTALL_DIR/dist/web/schedule-registry-cli.js" register --source installer $(printf '%s\n' $_dr_names | sort -u) >/dev/null 2>&1; then
    SEED_REGISTERED_NAMES="${SEED_REGISTERED_NAMES:-} $_dr_names"
    printf 'seed-refresh: scheduled tasks registered:%s\n' "$_dr_names"
  else
    printf 'seed-refresh: WARN: the registry did not take:%s\n' "$_dr_names"
    return 1
  fi
}

# The whole refresh, in the caller's subshell. 0 = done (the snapshot is removed); anything else leaves the snapshot for
# the next start. The identity is first-boot's (env_val of .env), MAIN_AGENT_ID is first-boot's AGENT_ID.
docker_seed_refresh() {
  [ -d "$INSTALL_DIR/.seed-prev" ] || return 0
  command -v shasum >/dev/null 2>&1 || { echo "seed-refresh: WARN: no shasum in the image; skipped (the snapshot is kept)"; return 1; }
  GREEN="${GREEN:-}"; NC="${NC:-}"; ORANGE="${ORANGE:-}"
  SEED_REFRESH_UPDATED=0; SEED_REFRESH_KEPT=0; SCHED_REVIEW_NAMES=""; SCHED_REGISTER_NAMES=""; SEED_REGISTERED_NAMES=""
  SEED_DEFAULT_OWNER="${SEED_DEFAULT_OWNER:-Owner}"; SEED_DEFAULT_BOT="${SEED_DEFAULT_BOT:-Marveen}"
  MAIN_AGENT_ID="${MAIN_AGENT_ID:-}"; BOT_NAME="${BOT_NAME:-}"; OWNER_NAME="${OWNER_NAME:-}"; WEB_PORT="${WEB_PORT:-3420}"
  SEED_LANG="${SEED_LANG:-hu}"
  seed_refresh_groups
  # A run that crashed after rewriting a task file but before registering it finds the copy current on the retry
  # (refresh_one_seed_file returns early), so the registration is settled here for every task dir whose verdict was
  # recorded (= a write was about to happen) and that this run neither registered nor listed for review.
  for _dd_rec in "$INSTALL_DIR/.seed-prev/.verdicts/"*; do
    [ -f "$_dd_rec" ] || continue
    _dd_name="$(basename "$_dd_rec")"
    case " $SEED_REGISTERED_NAMES $SCHED_REVIEW_NAMES " in *" $_dd_name "*) continue ;; esac
    _dd_src=""; _dd_mode=""
    for _dd_try in "seed-scheduled-tasks:template" "scheduled-tasks:seeded"; do
      if [ -d "$INSTALL_DIR/${_dd_try%%:*}/$_dd_name" ]; then _dd_src="$INSTALL_DIR/${_dd_try%%:*}/$_dd_name"; _dd_mode="${_dd_try#*:}"; break; fi
    done
    [ -n "$_dd_src" ] && [ -d "$HOME/.claude/scheduled-tasks/$_dd_name" ] || continue
    case "$(cat "$_dd_rec")" in 0) _dd_pre=1 ;; 1) _dd_pre=0 ;; *) _dd_pre=u ;; esac
    register_refreshed_schedule "$_dd_name" "$_dd_pre" "$HOME/.claude/scheduled-tasks/$_dd_name" "$_dd_src" "$_dd_mode"
  done
  if find "$HOME/.claude/skills" "$HOME/.claude/scheduled-tasks" -name '*.seedtmp' 2>/dev/null | grep -q .; then
    echo "seed-refresh: WARN: a write did not finish (a .seedtmp is left); the snapshot is kept for the next start"
    return 1
  fi
  [ "$SEED_REFRESH_UPDATED" -gt 0 ] && echo "seed-refresh: shipped skills/tasks refreshed: $SEED_REFRESH_UPDATED (untouched copies); kept: $SEED_REFRESH_KEPT (edited)"
  [ -n "$(echo "$SCHED_REVIEW_NAMES" | tr -d ' ')" ] && echo "seed-refresh: WARN: refreshed but NOT registered (review by hand):$SCHED_REVIEW_NAMES"
  rm -rf "$INSTALL_DIR/.seed-prev"
  return 0
}
