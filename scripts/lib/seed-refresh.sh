# shellcheck shell=bash
# DOCKERSEEDREFRESH1108: the seed-refresh rules, shared by update.sh (a git install) and the Docker image's first boot.
# Moved here verbatim from update.sh; only the "is this copy untouched" test and the tracked-file listing differ per
# caller, so the caller defines them (the seams):
#   seed_copy_is_untouched <installed> <repo-relative path> <mode>   0 iff the copy equals a version we shipped
#   seed_tracked_files <dir>                                         the shipped files under <dir>, relative to it
#   sched_task_verified_ok <task>                                    the registry verdict (0 ok, 1 not ok, 2 unknown)
#   register_seeded_schedules                                        registers $SCHED_REGISTER_NAMES
# The caller also sets INSTALL_DIR, HOME, SEED_LANG (scripts/lib/seed-lang.sh), MAIN_AGENT_ID / BOT_NAME / OWNER_NAME /
# WEB_PORT for the templated groups, and the counters SEED_REFRESH_UPDATED / SEED_REFRESH_KEPT and SCHED_REVIEW_NAMES.
# Sourcing this file defines functions only.

# Render a template stream the same way the seeder does. Keep in sync with the
# sed blocks in the seeding loops below and in install-linux.sh.
render_seed_template() {
  # {{PROJECT_ROOT}} is the node seeder's alias for {{INSTALL_DIR}}
  # (substituteTemplatePlaceholders) -- without it here, any shipped task using
  # that form (ledger-live-drain does) hash-mismatches every rendered historical
  # version and is permanently classified "touched", so it never refreshes.
  # DOCKERSEEDREFRESH1108: the values go in LITERALLY. A name the owner typed in the wizard may hold a sed
  # metacharacter: with `sed s/../$name/` a `&` wrote the matched placeholder back, a `/` broke the expression (an empty
  # file left behind), a `\` was an escape. One pass, left to right: a known placeholder is replaced by its value and
  # the value is never scanned again (a name holding "{{INSTALL_DIR}}" stays that text). Pure bash, so the bytes are
  # kept exactly (a missing final newline stays missing, as with sed) on bash 3.2 and 5.x alike.
  _rst_in="$(cat; printf x)"; _rst_in="${_rst_in%x}"
  _rst_out=""
  while :; do
    case "$_rst_in" in *"{{"*) ;; *) break ;; esac
    _rst_out="$_rst_out${_rst_in%%"{{"*}"
    _rst_in="{{${_rst_in#*"{{"}"
    case "$_rst_in" in
      "{{MAIN_AGENT_ID}}"*) _rst_out="$_rst_out${MAIN_AGENT_ID:-}"; _rst_in="${_rst_in#"{{MAIN_AGENT_ID}}"}" ;;
      "{{BOT_NAME}}"*) _rst_out="$_rst_out${BOT_NAME:-}"; _rst_in="${_rst_in#"{{BOT_NAME}}"}" ;;
      "{{OWNER_NAME}}"*) _rst_out="$_rst_out${OWNER_NAME:-}"; _rst_in="${_rst_in#"{{OWNER_NAME}}"}" ;;
      "{{INSTALL_DIR}}"*) _rst_out="$_rst_out${INSTALL_DIR}"; _rst_in="${_rst_in#"{{INSTALL_DIR}}"}" ;;
      "{{PROJECT_ROOT}}"*) _rst_out="$_rst_out${INSTALL_DIR}"; _rst_in="${_rst_in#"{{PROJECT_ROOT}}"}" ;;
      "{{WEB_PORT}}"*) _rst_out="$_rst_out${WEB_PORT:-3420}"; _rst_in="${_rst_in#"{{WEB_PORT}}"}" ;;
      # PERSONARENDERLITERAL1108: the persona templates' two extra placeholders, substituted ONLY when the caller sets
      # RENDER_CHAT_ID / RENDER_TIMEZONE (render_persona_file's callers); unset, they stay as they are, so every seed
      # render keeps its bytes.
      "{{CHAT_ID}}"*) if [ -n "${RENDER_CHAT_ID+x}" ]; then _rst_out="$_rst_out$RENDER_CHAT_ID"; _rst_in="${_rst_in#"{{CHAT_ID}}"}"; else _rst_out="$_rst_out{{"; _rst_in="${_rst_in#"{{"}"; fi ;;
      "{{TIMEZONE}}"*) if [ -n "${RENDER_TIMEZONE+x}" ]; then _rst_out="$_rst_out$RENDER_TIMEZONE"; _rst_in="${_rst_in#"{{TIMEZONE}}"}"; else _rst_out="$_rst_out{{"; _rst_in="${_rst_in#"{{"}"; fi ;;
      *) _rst_out="$_rst_out{{"; _rst_in="${_rst_in#"{{"}" ;;
    esac
  done
  printf '%s' "$_rst_out$_rst_in"
}

# PERSONARENDERLITERAL1108: render a persona template ($1) into its target ($2) with render_seed_template, never
# truncating the target: the render goes to a temp file next to it and replaces the target only when it succeeded and
# is not empty. On failure the old file stays as it was, the temp file is removed, and the return is 1 (the caller says
# so loudly). The identity comes from the caller's MAIN_AGENT_ID / BOT_NAME / OWNER_NAME / INSTALL_DIR / WEB_PORT and,
# for the CLAUDE.md template, RENDER_CHAT_ID / RENDER_TIMEZONE.
render_persona_file() {
  _rpf_tmp="$2.render.$$"
  if render_seed_template < "$1" > "$_rpf_tmp" && [ -s "$_rpf_tmp" ] && mv -f "$_rpf_tmp" "$2"; then
    return 0
  fi
  rm -f "$_rpf_tmp"
  return 1
}

# A top-level task-config.json on stdin, as the dashboard seeder writes it
# (agent-scaffold.ts copyTaskConfigWithAgentRewrite): parsed, a string "agent"
# set to MAIN_AGENT_ID, re-serialised as 2-space JSON plus a newline, and NO
# placeholder substitution. Unparseable input comes out as is (the seeder's
# byte-copy fallback). #2285: comparing against the placeholder render instead
# kept the shipped literal "agent": "marveen", so on any other MAIN_AGENT_ID the
# untouched copy never matched and a config fix never arrived.
render_seeded_task_config() {
  MAIN_AGENT_ID="${MAIN_AGENT_ID:-}" node -e '
    let raw = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (d) => { raw += d })
    process.stdin.on("end", () => {
      let cfg
      try { cfg = JSON.parse(raw) } catch { process.stdout.write(raw); return }
      if (cfg && typeof cfg === "object" && typeof cfg.agent === "string") cfg.agent = process.env.MAIN_AGENT_ID
      process.stdout.write(JSON.stringify(cfg, null, 2) + "\n")
    })'
}

# The bytes a seeder writes for the shipped file on stdin. $1 = mode, $2 = its
# path (repo-relative or the source file; only the file name is read).
#   verbatim  as is (seed-skills)
#   template  the identity placeholders (the shell seeders: seed-scheduled-tasks)
#   seeded    what ensureDefaultScheduledTasks writes for the top-level
#             scheduled-tasks: task-config.json via render_seeded_task_config,
#             any other file with the placeholders
render_seed_stream() {
  case "$1" in
    template) render_seed_template ;;
    seeded)
      case "$2" in
        */task-config.json|task-config.json) render_seeded_task_config ;;
        *) render_seed_template ;;
      esac ;;
    *) cat ;;
  esac
}


# Render one shipped file the way the seeder would write it ($1 = source, $2 = mode).
render_seed_file() {
  render_seed_stream "$2" "$1" <"$1"
}

# PERSONAESC1107 seed A: the English version of a shipped seed file (scripts/lib/seed-lang.sh seed_en_rel: i18n/en/<rel>),
# absolute, when this tree ships one as a regular file; empty otherwise, and always empty without the helper (this
# script run against a tree from before seed A). $1 = repo-relative path.
seed_en_file() {
  command -v seed_en_rel >/dev/null 2>&1 || return 0
  _se_rel="$(seed_en_rel "$1")"
  if [ -n "$_se_rel" ] && [ -f "$INSTALL_DIR/$_se_rel" ] && [ ! -L "$INSTALL_DIR/$_se_rel" ]; then
    printf '%s' "$INSTALL_DIR/$_se_rel"
  fi
  return 0
}

# True (0) iff $1 (an installed file) is untouched as EITHER language's shipped version: a historical version of $2 or
# of its English version, rendered by mode $3. A language switch is a refresh of an untouched copy, nothing more.
seed_copy_is_untouched_any() {
  seed_copy_is_untouched "$1" "$2" "$3" && return 0
  command -v seed_en_rel >/dev/null 2>&1 || return 1
  _su_en="$(seed_en_rel "$2")"
  [ -n "$_su_en" ] || return 1
  seed_copy_is_untouched "$1" "$_su_en" "$3"
}

# The language ONE seeded dir is refreshed in (EGM design review M4: never half a dir). $1 = repo-relative dir, $2 = the
# installed dir, $3 = mode. The install's language (SEED_LANG) when EVERY installed file that has an English version is
# untouched in either language; otherwise the dir keeps the language it is in (en when any such file is an English
# version), so a locally edited file never leaves its dir mixed. hu without the helper.
seed_refresh_dir_lang() {
  command -v seed_en_rel >/dev/null 2>&1 || { printf 'hu'; return 0; }
  _dl_en_dir="$INSTALL_DIR/$(seed_en_rel "$1/x.md")"; _dl_en_dir="${_dl_en_dir%/x.md}"
  _dl_all=1; _dl_cur=hu
  if [ -d "$_dl_en_dir" ]; then
    _dl_files="$(cd "$_dl_en_dir" && find . -type f -name '*.md' 2>/dev/null)"
    while IFS= read -r _dl_rel; do
      [ -n "$_dl_rel" ] || continue
      _dl_rel="${_dl_rel#./}"
      [ -f "$2/$_dl_rel" ] || continue
      seed_copy_is_untouched_any "$2/$_dl_rel" "$1/$_dl_rel" "$3" || _dl_all=0
      seed_copy_is_untouched "$2/$_dl_rel" "$(seed_en_rel "$1/$_dl_rel")" "$3" && _dl_cur=en
    done <<EOF_DL
$_dl_files
EOF_DL
  fi
  if [ "$_dl_all" = 1 ]; then printf '%s' "${SEED_LANG:-hu}"; else printf '%s' "$_dl_cur"; fi
}

# Scheduled-task registry: take the registry verdict of the task dir being
# refreshed, ONCE per dir, right before its first file is rewritten or added
# (sched_pre_ok: "" = not asked yet, 1 = trusted, 0 = not trusted, u = unknown /
# no CLI). A no-op outside a scheduled-task dir. Reads/sets the per-dir state
# refresh_untouched_seeds keeps (sched_task, sched_pre_ok, name).
sched_pre_verify_once() {
  if [ "${sched_task:-0}" = "1" ] && [ -z "${sched_pre_ok:-}" ]; then
    sched_pre_rc=0
    sched_task_verified_ok "$name" || sched_pre_rc=$?
    case "$sched_pre_rc" in 0) sched_pre_ok=1 ;; 1) sched_pre_ok=0 ;; *) sched_pre_ok=u ;; esac
  fi
}

# Refresh ONE installed copy of a shipped file if it is provably untouched.
# $1 = source file, $2 = installed path, $3 = repo-relative path, $4 = mode.
refresh_one_seed_file() {
  f="$1"; installed="$2"; rel="$3"; mode="$4"
  # seed A (EGM design review M2): the directory's language (seed_dir_lang, set per dir by refresh_untouched_seeds)
  # picks the source ONCE, here, so the comparison below, the history check and the write all use the same version;
  # otherwise an English copy would never equal the Hungarian `want` and every update would rewrite it.
  if [ "${seed_dir_lang:-hu}" = en ]; then
    _rf_en="$(seed_en_file "$rel")"
    [ -n "$_rf_en" ] && f="$_rf_en"
  fi
  # Already identical to what we would write -> not an update. Without this
  # the run is not idempotent: it would rewrite the same bytes and report a
  # refresh on every single update, which is exactly the kind of constant
  # signal that stops being read.
  want="$(render_seed_file "$f" "$mode" | shasum -a 256 | awk '{print $1}')"
  have="$(shasum -a 256 <"$installed" 2>/dev/null | awk '{print $1}')"
  [ "$want" = "$have" ] && return 0
  if seed_copy_is_untouched_any "$installed" "$rel" "$mode"; then
    sched_pre_verify_once
    if [ "$mode" = "verbatim" ]; then
      cp "$f" "$installed"
    else
      render_seed_file "$f" "$mode" >"$installed.seedtmp" && mv "$installed.seedtmp" "$installed"
    fi
    SEED_REFRESH_UPDATED=$((SEED_REFRESH_UPDATED + 1))
    sched_dir_refreshed=1
  else
    SEED_REFRESH_KEPT=$((SEED_REFRESH_KEPT + 1))
  fi
  return 0
}

# Refresh one seeded directory tree. $1 = repo source dir (relative), $2 = target
# root, $3 = verbatim|template, $4 = which subdirs ship: "references" (a task's
# references/ only, the default) or "all" (every subdir: a skill's scripts/,
# references/, ...; SEEDSKILLSUB1018).
refresh_untouched_seeds() {
  src_rel="$1"; target_root="$2"; mode="${3:-verbatim}"; subdirs="${4:-references}"
  [ -d "$INSTALL_DIR/$src_rel" ] || return 0
  [ -d "$target_root" ] || return 0
  for d in "$INSTALL_DIR/$src_rel"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    [ -d "$target_root/$name" ] || continue     # not seeded here -> not ours to add
    # Scheduled-task registry: the registry hash covers the WHOLE task dir,
    # references/ included, so every write below (a top-level file, a
    # references/ file refreshed, a missing references/ file added) sits inside
    # the same bracket: verify once before the first write
    # (sched_pre_verify_once), re-register once after the last one.
    sched_task=0
    case "$target_root" in */scheduled-tasks) sched_task=1 ;; esac
    sched_pre_ok=""
    sched_dir_refreshed=0
    # seed A: this dir's language, decided once for the whole dir (seed_refresh_dir_lang); refresh_one_seed_file and
    # the two branches below read the matching version of each file.
    seed_dir_lang="$(seed_refresh_dir_lang "$src_rel/$name" "$target_root/$name" "$mode")"
    for f in "$d"*; do
      [ -f "$f" ] || continue
      base="$(basename "$f")"
      installed="$target_root/$name/$base"
      [ -f "$installed" ] || continue           # never add files to an existing dir
      refresh_one_seed_file "$f" "$installed" "$src_rel/$name/$base" "$mode"
    done
    # SEEDREFDIR1018: the references/ subdir a SKILL.md points at. An existing
    # copy follows the same untouched-only rule. A MISSING one is the single
    # exception to "never add files": it is added only when the installed
    # SKILL.md is now byte-identical to the shipped one -- that copy runs our
    # text, and our text points at the file. A locally edited SKILL.md is the
    # operator's, so its directory gets nothing added.
    skill_current=0
    if [ -f "${d}SKILL.md" ] && [ -f "$target_root/$name/SKILL.md" ]; then
      _sc_src="${d}SKILL.md"
      if [ "$seed_dir_lang" = en ]; then _sc_en="$(seed_en_file "$src_rel/$name/SKILL.md")"; [ -n "$_sc_en" ] && _sc_src="$_sc_en"; fi
      want="$(render_seed_file "$_sc_src" "$mode" | shasum -a 256 | awk '{print $1}')"
      have="$(shasum -a 256 <"$target_root/$name/SKILL.md" | awk '{print $1}')"
      [ "$want" = "$have" ] && skill_current=1
    fi
    # Subdir files: the TRACKED ones only, the same set the seed loops copy
    # (an untracked or ignored file can be a secret; SEEDSKILLSUB1018). Read
    # into a variable first: the loop body must update the counters in THIS
    # shell, not in a pipeline subshell.
    tracked="$(seed_tracked_files "$d")"
    while IFS= read -r rel; do
      case "$rel" in */*) ;; *) continue ;; esac
      [ "$subdirs" = "all" ] || case "$rel" in references/*) ;; *) continue ;; esac
      f="$d$rel"
      [ -f "$f" ] || continue
      installed="$target_root/$name/$rel"
      if [ -f "$installed" ]; then
        refresh_one_seed_file "$f" "$installed" "$src_rel/$name/$rel" "$mode"
      elif [ "$skill_current" = "1" ]; then
        sched_pre_verify_once
        mkdir -p "$(dirname "$installed")"
        if [ "$seed_dir_lang" = en ]; then _am_en="$(seed_en_file "$src_rel/$name/$rel")"; [ -n "$_am_en" ] && f="$_am_en"; fi
        if [ "$mode" = "verbatim" ]; then
          cp -p "$f" "$installed"   # verbatim keeps the mode bits (a skill's scripts)
        else
          render_seed_file "$f" "$mode" >"$installed.seedtmp" && mv "$installed.seedtmp" "$installed"
        fi
        SEED_REFRESH_UPDATED=$((SEED_REFRESH_UPDATED + 1))
        sched_dir_refreshed=1
      fi
    done <<EOF_TRACKED
$tracked
EOF_TRACKED
    # Scheduled-task registry: a refreshed scheduled task changed on disk, so its registry
    # hash must be renewed or the runner refuses it -- but ONLY when the task is
    # provably trusted, and right now (not at the end of the whole run), so the
    # runner's ticks in between do not flag it as "NOT firing".
    if [ "$sched_task" = "1" ] && [ "$sched_dir_refreshed" = "1" ]; then
      register_refreshed_schedule "$name" "$sched_pre_ok" "$target_root/$name" "$d" "$mode"
    fi
  done
  return 0
}

# True (0) iff every entry of the installed task dir $1 is shipped content:
#   - a regular top-level file (no symlink) byte-identical to the current
#     shipped version of the same file in the seed source dir $2 (rendered when
#     $3 = "template"), or
#   - the references/ subdir (SEEDREFDIR1018) or a file under it: the subdir
#     a real directory (no symlink) that the seed has too, and each file in it
#     byte-identical to a file git TRACKS at the same path in the seed (the same
#     set the seed loops copy).
# Any other entry fails: an extra file with no shipped counterpart (e.g. a
# planted preCheck script), a symlink, any other subdir.
sched_task_all_shipped() {
  _sa_dir="${1%/}"; _sa_src="${2%/}"; _sa_mode="${3:-verbatim}"
  [ -d "$_sa_dir" ] || return 1
  _sa_list="$(find "$_sa_dir" -mindepth 1 2>/dev/null)" || return 1
  [ -n "$_sa_list" ] || return 1
  _sa_tracked="$(seed_tracked_files "$_sa_src")"
  while IFS= read -r _sa_entry; do
    [ -n "$_sa_entry" ] || continue
    _sa_rel="${_sa_entry#"$_sa_dir"/}"
    [ ! -L "$_sa_entry" ] || return 1
    _sa_seed="$_sa_src/$_sa_rel"
    case "$_sa_rel" in
      references)
        [ -d "$_sa_entry" ] && [ ! -L "$_sa_seed" ] && [ -d "$_sa_seed" ] || return 1
        continue ;;
      references/*)
        [ -f "$_sa_entry" ] || return 1
        printf '%s\n' "$_sa_tracked" | grep -qxF -- "$_sa_rel" || return 1 ;;
      */*) return 1 ;;
      *) [ -f "$_sa_entry" ] || return 1 ;;
    esac
    [ ! -L "$_sa_seed" ] && [ -f "$_sa_seed" ] || return 1
    _sa_want="$(render_seed_file "$_sa_seed" "$_sa_mode" | shasum -a 256 | awk '{print $1}')"
    _sa_have="$(shasum -a 256 <"$_sa_entry" 2>/dev/null | awk '{print $1}')"
    [ -n "$_sa_have" ] || return 1
    if [ "$_sa_want" != "$_sa_have" ]; then
      # seed A (EGM review M1): the shipped English version of the same file is shipped content too.
      _sa_en="$(seed_en_file "${_sa_src#"$INSTALL_DIR"/}/$_sa_rel")"
      [ -n "$_sa_en" ] || return 1
      [ "$(render_seed_file "$_sa_en" "$_sa_mode" | shasum -a 256 | awk '{print $1}')" = "$_sa_have" ] || return 1
    fi
  done <<EOF_SA
$_sa_list
EOF_SA
  return 0
}

# $1 task name, $2 pre-refresh verdict (1 = trusted, 0 = not trusted,
# u = unknown), $3 installed dir, $4 seed source dir, $5 verbatim|template.
register_refreshed_schedule() {
  _rr_name="$1"; _rr_pre="$2"; _rr_dir="$3"; _rr_src="$4"; _rr_mode="${5:-verbatim}"
  if [ "$_rr_pre" = "1" ] || sched_task_all_shipped "$_rr_dir" "$_rr_src" "$_rr_mode"; then
    SCHED_REGISTER_NAMES="$_rr_name"
    register_seeded_schedules
    return 0
  fi
  SCHED_REVIEW_NAMES="${SCHED_REVIEW_NAMES:-} $_rr_name"
  if [ "$_rr_pre" = "0" ]; then
    echo -e "  ${ORANGE:-}⚠${NC:-} Utemezett feladat NEM regisztralva (kezi atnezes kell): $_rr_name -- a frissites elott sem volt megbizhato, es a konyvtaraban nem csak szallitott tartalom van. A runner addig kihagyja. Atnezes utan: node $INSTALL_DIR/dist/web/schedule-registry-cli.js status ; register $_rr_name"
  else
    # No usable CLI: on the first update to a guard build (old dist) the
    # dashboard's one-time backfill will register AND fire this task as it is
    # on disk, so "the runner skips it" would be false here.
    echo -e "  ${ORANGE:-}⚠${NC:-} Utemezett feladat NEM regisztralva (kezi atnezes kell): $_rr_name -- a registry-ellenorzes nem futott (nincs vagy nem mukodik: $INSTALL_DIR/dist/web/schedule-registry-cli.js verify), a frissites elotti allapota ISMERETLEN, es a konyvtaraban nem csak szallitott tartalom van. Ha ez az elso frissites a registry-t tartalmazo buildre, a dashboard egyszeri backfillje az elso indulaskor regisztralja es a runner futtatni fogja: nezd at MOST ($_rr_dir). Kulonben build utan: node $INSTALL_DIR/dist/web/schedule-registry-cli.js status ; register $_rr_name"
  fi
  return 0
}

# The three shipped groups, each with its mode (see render_seed_stream). The templated ones need MAIN_AGENT_ID: without
# it a rendered comparison would be meaningless, so they are skipped.
seed_refresh_groups() {
  refresh_untouched_seeds "seed-skills" "$HOME/.claude/skills" "verbatim" "all"
  if [ -n "${MAIN_AGENT_ID:-}" ]; then
    refresh_untouched_seeds "seed-scheduled-tasks" "$HOME/.claude/scheduled-tasks" "template"
    # SEEDREFRESH826: the TOP-LEVEL scheduled-tasks/ dir (dream-engine,
    # memoria-heartbeat, reggeli-napindito, ledger-live-drain) was seeded by
    # ensureDefaultScheduledTasks but never refreshed -- a one-shot seed, so
    # every shipped fix reached new installs only. Measured on the reference
    # host: 5/5 live seeded copies had drifted. Same untouched-only rule.
    # "seeded", not "template": that seeder rewrites the config's agent field and
    # substitutes nothing in it (#2285, render_seeded_task_config).
    refresh_untouched_seeds "scheduled-tasks" "$HOME/.claude/scheduled-tasks" "seeded"
  fi
  return 0
}
