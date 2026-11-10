# GENERATED (agents/geri/work/hostingerdocker/gen-pre-seed-a-fixture.py) from update.sh at 724b356b9, the last commit before
# PERSONAESC1107 seed A. Verbatim slices: the seed functions, then the two initial-seed blocks (seed-skills, seed-scheduled-tasks).
# The PULL run of the seed A change executes exactly this code (update.sh has no re-exec). Do not edit by hand.

render_seed_template() {
  # {{PROJECT_ROOT}} is the node seeder's alias for {{INSTALL_DIR}}
  # (substituteTemplatePlaceholders) -- without it here, any shipped task using
  # that form (ledger-live-drain does) hash-mismatches every rendered historical
  # version and is permanently classified "touched", so it never refreshes.
  sed -e "s/{{MAIN_AGENT_ID}}/${MAIN_AGENT_ID:-}/g" \
      -e "s/{{BOT_NAME}}/${BOT_NAME:-}/g" \
      -e "s/{{OWNER_NAME}}/${OWNER_NAME:-}/g" \
      -e "s|{{INSTALL_DIR}}|${INSTALL_DIR}|g" \
      -e "s|{{PROJECT_ROOT}}|${INSTALL_DIR}|g" \
      -e "s/{{WEB_PORT}}/${WEB_PORT:-3420}/g"
}

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

seed_copy_is_untouched() {
  installed="$1"; rel="$2"; mode="${3:-verbatim}"
  [ -f "$installed" ] || return 1
  cur="$(shasum -a 256 <"$installed" 2>/dev/null | awk '{print $1}')"
  [ -n "$cur" ] || return 1
  # Newest first, capped: a file we shipped 25+ revisions ago and never fixed
  # since is not worth the extra git calls.
  for blob in $(git -C "$INSTALL_DIR" log --format=%H -n 25 -- "$rel" 2>/dev/null); do
    candidate="$(git -C "$INSTALL_DIR" show "$blob:$rel" 2>/dev/null | render_seed_stream "$mode" "$rel" | shasum -a 256 | awk '{print $1}')"
    [ "$cur" = "$candidate" ] && return 0
  done
  return 1
}

render_seed_file() {
  render_seed_stream "$2" "$1" <"$1"
}

sched_pre_verify_once() {
  if [ "${sched_task:-0}" = "1" ] && [ -z "${sched_pre_ok:-}" ]; then
    sched_pre_rc=0
    sched_task_verified_ok "$name" || sched_pre_rc=$?
    case "$sched_pre_rc" in 0) sched_pre_ok=1 ;; 1) sched_pre_ok=0 ;; *) sched_pre_ok=u ;; esac
  fi
}

refresh_one_seed_file() {
  f="$1"; installed="$2"; rel="$3"; mode="$4"
  # Already identical to what we would write -> not an update. Without this
  # the run is not idempotent: it would rewrite the same bytes and report a
  # refresh on every single update, which is exactly the kind of constant
  # signal that stops being read.
  want="$(render_seed_file "$f" "$mode" | shasum -a 256 | awk '{print $1}')"
  have="$(shasum -a 256 <"$installed" 2>/dev/null | awk '{print $1}')"
  [ "$want" = "$have" ] && return 0
  if seed_copy_is_untouched "$installed" "$rel" "$mode"; then
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
      want="$(render_seed_file "${d}SKILL.md" "$mode" | shasum -a 256 | awk '{print $1}')"
      have="$(shasum -a 256 <"$target_root/$name/SKILL.md" | awk '{print $1}')"
      [ "$want" = "$have" ] && skill_current=1
    fi
    # Subdir files: the TRACKED ones only, the same set the seed loops copy
    # (an untracked or ignored file can be a secret; SEEDSKILLSUB1018). Read
    # into a variable first: the loop body must update the counters in THIS
    # shell, not in a pipeline subshell.
    tracked="$(git -C "$d" ls-files 2>/dev/null)"
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

run_seed_refresh() {
  # Self-initialising counters: the function must not depend on a caller having
  # set them, or it dies under `set -u` the moment it is called from anywhere
  # else (a test harness found exactly that).
  SEED_REFRESH_UPDATED="${SEED_REFRESH_UPDATED:-0}"
  SEED_REFRESH_KEPT="${SEED_REFRESH_KEPT:-0}"
  # .env values feed the template rendering; without MAIN_AGENT_ID a rendered
  # comparison would be meaningless, so templated tasks are skipped then.
  if [ -f "$INSTALL_DIR/.env" ]; then
    MAIN_AGENT_ID="${MAIN_AGENT_ID:-$(sed -n 's/^MAIN_AGENT_ID=//p' "$INSTALL_DIR/.env" | head -1 | tr -d '"')}"
    BOT_NAME="${BOT_NAME:-$(sed -n 's/^BOT_NAME=//p' "$INSTALL_DIR/.env" | head -1 | tr -d '"')}"
    OWNER_NAME="${OWNER_NAME:-$(sed -n 's/^OWNER_NAME=//p' "$INSTALL_DIR/.env" | head -1 | tr -d '"')}"
    WEB_PORT="${WEB_PORT:-$(sed -n 's/^WEB_PORT=//p' "$INSTALL_DIR/.env" | head -1 | tr -d '"')}"
  fi
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
  if [ "$SEED_REFRESH_UPDATED" -gt 0 ]; then
    echo -e "  ${GREEN}✓${NC} Szallitott skill/feladat frissitve: ${SEED_REFRESH_UPDATED} (erintetlen masolat); megtartva: ${SEED_REFRESH_KEPT} (helyben modositott)"
  fi
  # Scheduled-task registry: one summary line at the end, so an unattended auto-update log
  # shows every refreshed-but-unregistered task in one place.
  if [ -n "$(echo "${SCHED_REVIEW_NAMES:-}" | tr -d ' ')" ]; then
    echo -e "  ${ORANGE:-}⚠${NC:-} Kezi atnezesre varo utemezett feladatok (frissitve, de NEM regisztralva):${SCHED_REVIEW_NAMES}"
  fi
  return 0
}

sched_task_verified_ok() {
  _sv_cli="$INSTALL_DIR/dist/web/schedule-registry-cli.js"
  [ -f "$_sv_cli" ] || return 2
  command -v node >/dev/null 2>&1 || return 2
  _sv_rc=0
  _sv_out="$(node "$_sv_cli" verify "$1" 2>/dev/null)" || _sv_rc=$?
  [ "$_sv_rc" = "0" ] && return 0
  # registry-error = the CLI could not read the registry: unknown, not a verdict.
  if [ "$_sv_rc" = "1" ] && printf '%s\n' "$_sv_out" | grep -xE "[a-z-]+ $1" | grep -qv '^registry-error '; then
    return 1
  fi
  return 2
}

sched_task_all_shipped() {
  _sa_dir="${1%/}"; _sa_src="${2%/}"; _sa_mode="${3:-verbatim}"
  [ -d "$_sa_dir" ] || return 1
  _sa_list="$(find "$_sa_dir" -mindepth 1 2>/dev/null)" || return 1
  [ -n "$_sa_list" ] || return 1
  _sa_tracked="$(git -C "$_sa_src" ls-files 2>/dev/null)"
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
    [ -n "$_sa_have" ] && [ "$_sa_want" = "$_sa_have" ] || return 1
  done <<EOF_SA
$_sa_list
EOF_SA
  return 0
}

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

register_seeded_schedules() {
  _names="${SCHED_REGISTER_NAMES:-}"
  SCHED_REGISTER_NAMES=""
  [ -n "$(echo "$_names" | tr -d ' ')" ] || return 0
  _cli="$INSTALL_DIR/dist/web/schedule-registry-cli.js"
  if [ ! -f "$_cli" ] || ! command -v node >/dev/null 2>&1; then
    echo -e "  ${ORANGE}⚠${NC} Utemezes-regisztracio kihagyva (nincs $_cli):${_names}. Az elso, registry-t tartalmazo frissitesnel ezt a dashboard egyszeri backfillje potolja; kulonben build utan: node $_cli register${_names}"
    return 0
  fi
  # shellcheck disable=SC2086 # word-splitting the name list is intended
  if node "$_cli" register --source update-sh $(printf '%s\n' $_names | sort -u) >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Utemezett feladatok regisztralva:$(printf ' %s' $(printf '%s\n' $_names | sort -u))"
  else
    echo -e "  ${ORANGE}⚠${NC} Utemezes-regisztracio sikertelen:${_names} -- futtasd: node $_cli status"
  fi
  return 0
}

# --- the initial-seed blocks ---
SEED_SKILLS_DIR="$INSTALL_DIR/seed-skills"
if [ -d "$SEED_SKILLS_DIR" ]; then
  SEED_NEW=0
  SEED_SKIP=0
  SEED_FORCED=0
  for skill_dir in "$SEED_SKILLS_DIR"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    target="$SKILLS_DIR/$skill_name"
    forced=0
    if [ -d "$target" ]; then
      if [ "$RESEED_FLEET" = "1" ]; then
        rm -rf "$target"
        forced=1
      else
        SEED_SKIP=$((SEED_SKIP + 1))
        continue
      fi
    fi
    mkdir -p "$target"
    for f in "$skill_dir"*; do
      [ -f "$f" ] || continue
      cp "$f" "$target/$(basename "$f")"
    done
    # SEEDSKILLSUB1018: a skill's subdirs (scripts/, references/, ...) ship too,
    # verbatim and with their mode bits; its SKILL.md points into them.
    # Only the files git TRACKS: a whole-dir copy also carried untracked and
    # ignored files, and fleet-helper's own scripts/.gitignore names exactly
    # those as secrets/personal data (mail_rules.json, .dashboard-token).
    # Outside a git checkout nothing below the top level is copied.
    git -C "$skill_dir" ls-files -z 2>/dev/null | while IFS= read -r -d '' rel; do
      case "$rel" in */*) ;; *) continue ;; esac   # top-level files: the loop above
      mkdir -p "$target/$(dirname "$rel")"
      cp -p "$skill_dir$rel" "$target/$rel"
    done
    if [ "$forced" = "1" ]; then SEED_FORCED=$((SEED_FORCED + 1)); else SEED_NEW=$((SEED_NEW + 1)); fi
  done
  if [ "$SEED_NEW" -gt 0 ] || [ "$SEED_SKIP" -gt 0 ] || [ "$SEED_FORCED" -gt 0 ]; then
    echo -e "  ${GREEN}✓${NC} Seed skills: ${SEED_NEW} új, ${SEED_FORCED} frissítve, ${SEED_SKIP} kihagyva"
  fi
fi

SEED_SCHED_DIR="$INSTALL_DIR/seed-scheduled-tasks"
if [ -d "$SEED_SCHED_DIR" ]; then
  if [ -z "$MAIN_AGENT_ID" ]; then
    echo -e "  ${ORANGE}⚠${NC} Seed scheduled tasks kihagyva: .env hiányzik vagy MAIN_AGENT_ID nincs beállítva"
  else
    mkdir -p "$SCHED_TARGET_DIR"
    SCHED_NEW=0
    SCHED_SKIP=0
    SCHED_FORCED=0
    # Default skip-if-exists; --reseed-fleet force-refreshes the canonical task
    # content (SKILL.md + task-config.json). Task RUN-STATE lives in store/ (not
    # in the task dir), so it is preserved across a force-reseed. Tasks the user
    # authored themselves have no seed-scheduled-tasks/ source -> never visited.
    SCHED_TOMBSTONE="$SCHED_TARGET_DIR/.removed-defaults"
    for tpl in "$SEED_SCHED_DIR"/*/; do
      [ -d "$tpl" ] || continue
      task_name=$(basename "$tpl")
      target="$SCHED_TARGET_DIR/$task_name"
      # #796: an operator who deleted a shipped default must not have it
      # re-seeded here. The dashboard records deletions in .removed-defaults;
      # a UI re-create clears the entry. Honored even under --reseed-fleet
      # (resurrection is a deliberate UI action, not a content refresh).
      if [ -f "$SCHED_TOMBSTONE" ] && grep -qxF "$task_name" "$SCHED_TOMBSTONE" 2>/dev/null; then
        SCHED_SKIP=$((SCHED_SKIP + 1)); continue
      fi
      forced=0
      if [ -d "$target" ]; then
        if [ "$RESEED_FLEET" = "1" ]; then
          rm -rf "$target"
          forced=1
        else
          SCHED_SKIP=$((SCHED_SKIP + 1))
          continue
        fi
      fi
      mkdir -p "$target"
      # SEEDREFDIR1018: the references/ subdir ships too (see install-linux.sh).
      for sub in "" "references/"; do
        [ -z "$sub" ] || [ -d "$tpl$sub" ] || continue
        mkdir -p "$target/$sub"
        for f in "$tpl$sub"*; do
          [ -f "$f" ] || continue
          # {{WEB_PORT}} belongs here too: install-linux.sh substitutes it in both
          # of its seeding loops, and a task seeded by THIS path used to keep the
          # literal placeholder in its URLs. Same placeholder set on both paths,
          # or a template silently means different things depending on which
          # script created the copy.
          sed -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
              -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
              -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
              -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
              -e "s/{{WEB_PORT}}/${WEB_PORT:-3420}/g" \
              "$f" > "$target/$sub$(basename "$f")"
        done
      done
      SCHED_REGISTER_NAMES="${SCHED_REGISTER_NAMES:-} $task_name"
      if [ "$forced" = "1" ]; then SCHED_FORCED=$((SCHED_FORCED + 1)); else SCHED_NEW=$((SCHED_NEW + 1)); fi
    done
    register_seeded_schedules
    if [ "$SCHED_NEW" -gt 0 ] || [ "$SCHED_SKIP" -gt 0 ] || [ "$SCHED_FORCED" -gt 0 ]; then
      echo -e "  ${GREEN}✓${NC} Seed scheduled tasks: ${SCHED_NEW} új, ${SCHED_FORCED} frissítve, ${SCHED_SKIP} kihagyva"
    fi
  fi
fi
