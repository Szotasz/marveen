#!/usr/bin/env bash
# Marveen backup.
#
# The archive has two top-level groups so a restore is unambiguous about
# where each file belongs (see docs/MIGRATION.md):
#
#   repo/   -> extract under the project root (this repo)
#     store/**                 (DB WAL-checkpointed first; minus models,
#                               virtualenvs, browser profile and logs)
#     .env                     (project root secrets)
#     scheduled-tasks.json     (legacy, if present)
#     assets/meetings/**       (meeting transcripts/memos)
#     agents/*/CLAUDE.md, SOUL.md, .mcp.json
#     agents/*/.claude/channels/{telegram,slack,discord}/.env, access.json
#
#   home/   -> extract under $HOME
#     .claude/skills/**            (the self-built skill library)
#     .claude/scheduled-tasks/**   (file-based scheduled tasks: SKILL.md + config)
#     .claude/channels/*/.env      (MAIN orchestrator channel token)
#     .claude/channels/*/access.json, invites.json, approved/**  (pairing state)
#     Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist (launchd jobs)
#
# Output: backups/claudeclaw-YYYYmmdd-HHMMSS.tar.gz
# Retention: keeps the most recent 14 archives, prunes the rest.
#
# Restore (preserve modes so the 0600 token files stay private):
#   tar -xpzf <archive> -C /tmp/restore        # inspect first
#   then copy repo/* into the project root and home/* into $HOME.
# Full runbook: docs/MIGRATION.md.

set -euo pipefail

# The archive carries live secrets (store/.claude-oauth-token, .dashboard-token,
# the vault master key next to vault.json, every channel .env). It must be
# born 0600 -- not chmod-ed afterwards, because a crash between tar and chmod
# would leave a world-readable copy (BACKUPTITOK915: measured 0644 on the
# owner host under the default umask 022). umask 077 covers the archive, the
# backups/ dir, the staging dir and every temp file this script creates.
umask 077

# launchd hands this script the bare default PATH (/usr/bin:/bin:/usr/sbin:/sbin),
# NOT a login shell's. age and rclone live in /usr/local/bin (or /opt/homebrew/bin
# on Apple silicon), so every `command -v` below missed them and the 03:30 run
# fell into the fail-closed branch: "age is not installed; NOT encrypting and NOT
# uploading" -- measured 2026-09-20, the first scheduled run after offsite went
# live, while a hand-run from an interactive shell succeeded. Prepend the usual
# install prefixes here rather than only in the plist, so the fix also holds for
# cron, a rebuilt plist, or any other minimal-environment caller.
PATH="/usr/local/bin:/opt/homebrew/bin:${PATH}"
export PATH

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Literal membership test for the archive verification below (card a8a92d55).
# shellcheck source=lib/archive-list-has.sh
. "${REPO_ROOT}/scripts/lib/archive-list-has.sh"
# Overridable so a test can build a throwaway archive without touching the
# real backup directory (and its retention sweep).
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="${BACKUP_DIR}/claudeclaw-${STAMP}.tar.gz"
KEEP=14

mkdir -p "${BACKUP_DIR}"
cd "${REPO_ROOT}"

# Checkpoint WAL into the main DB file so the snapshot is self-contained.
# Tolerate a missing sqlite3 CLI -- just fall back to copying the files as-is.
if [[ -f store/claudeclaw.db ]] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 store/claudeclaw.db 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null || true
fi

# --- Build the two path lists (each relative to its own base). -------------
# tar refuses missing entries, which would fail the whole backup on a fresh
# machine (no agents yet) -- so we only list paths that actually exist.
REPOLIST="$(mktemp -t claudeclaw-repo.XXXXXX)"
HOMELIST="$(mktemp -t claudeclaw-home.XXXXXX)"
MANIFEST="$(mktemp -t claudeclaw-manifest.XXXXXX)"
# The staging tree lives next to the archives, NOT in $TMPDIR. macOS runs
# com.apple.bsd.dirhelper daily at 03:35 (StartCalendarInterval) with
# CLEAN_FILES_OLDER_THAN_DAYS=3: it deletes $TMPDIR files whose atime is older
# than three days. `cp -p` below preserves the SOURCE atime, so every file that
# is rarely read (an agent's CLAUDE.md, a channel .env, the dashboard token, a
# small side database) arrives in the stage already "three days old" and can be
# swept between the copy and the tar. The archive is still written, the
# verification below then reports the holes, and the nightly job fails.
# BACKUP_DIR is not a sweep target, and the EXIT trap still removes the stage.
STAGE="$(mktemp -d "${BACKUP_DIR}/.stage.XXXXXX")"
BUNDLE=""
trap 'rm -f "${REPOLIST}" "${HOMELIST}" "${MANIFEST}"; [[ -n "${BUNDLE}" ]] && rm -f "${BUNDLE}"; rm -rf "${STAGE}"' EXIT

# add_if <listfile> <base> <relpath>  -- append relpath when <base>/<relpath> exists.
add_if() {
  local list="$1" base="$2" rel="$3"
  if [[ -e "${base}/${rel}" ]]; then echo "${rel}" >> "${list}"; fi
}

# repo/ group (relative to REPO_ROOT)
# store/ -- everything EXCEPT the bulky, regenerable and transient parts.
# Until 2026-09-04 this was a five-name whitelist (the DB, its -shm/-wal, the
# dashboard token, config-overrides.json) and every OTHER file in store/ sat
# outside the archive without ever saying so: the credential vault, the
# verified-recipients ledger that gates every outgoing letter, the egress
# allowlist, the autonomy levels, the per-service API tokens, and hand-made
# data that exists nowhere else (the mail-partner categorisation, the SEO
# baselines, the webshop change log). A whitelist is silent about every file
# added after it was written, so the rule is inverted here: take store/ and
# name only what must stay OUT.
#   whisper, health, cowork, venv-*, dhl-chrome-profile, fedex-labels,
#   fedex-vam, archery-basis  -- models, exports, virtualenvs, a browser
#     profile and generated PDFs: 3.2 GB, all re-downloadable or reproducible
#   *.log, *.out, *.pid       -- runtime noise, worthless in a restore
# What remains is ~4 MB next to the DB, so the archive stays small.
#   backups                   -- store/backups holds OTHER machines' tarballs (two 2026-07-13
#     hermes dumps, 701 MB): a backup inside the backup, and not this host's state
#   darwin-relay              -- relay.log (87 MB): a log, not state; nothing restores from it
#   scheduled-runs            -- SCHEDPROMPTREF917 fire-time snapshots, ~100 files/day,
#     7-day retention on disk already (scheduled-run-snapshot.ts); regenerated on every
#     large-task fire, so a restore losing yesterday's costs nothing
#   (measured 2026-09-16: these two were 788 MB of a 948 MB archive; excluding them
#    leaves ~150 MB. STORE_SKIP does not delete anything -- the files stay on disk.)
STORE_SKIP=" whisper health cowork venv-garmin venv-pdf dhl-chrome-profile fedex-labels fedex-vam archery-basis backups darwin-relay scheduled-runs "
if [[ -d store ]]; then
  while IFS= read -r _entry; do
    _name="$(basename "${_entry}")"
    case "${STORE_SKIP}" in *" ${_name} "*) continue ;; esac
    case "${_name}" in *.log|*.out|*.pid) continue ;; esac
    echo "store/${_name}" >> "${REPOLIST}"
  done < <(find store -mindepth 1 -maxdepth 1)
fi
add_if "${REPOLIST}" "${REPO_ROOT}" .env
add_if "${REPOLIST}" "${REPO_ROOT}" scheduled-tasks.json
add_if "${REPOLIST}" "${REPO_ROOT}" assets/meetings
# The MAIN agent's own persona. Measured 2026-09-22 in a full decrypt-and-diff
# restore drill: the archive carried all 9 sub-agent CLAUDE.md files (they live
# under agents/, taken below) and NEITHER of the main agent's own two, because
# both are gitignored (.gitignore:48,51) and sat in no other list. A restore
# would have brought back every memory, skill and token and then come up with
# the template persona -- the one thing a restore is supposed to preserve.
add_if "${REPOLIST}" "${REPO_ROOT}" CLAUDE.md
add_if "${REPOLIST}" "${REPO_ROOT}" SOUL.md
# The isolated config home of the main agent (see the "ket-config-otthon"
# memory). Almost everything under .channels-config/ is a symlink into
# ~/.claude and is therefore already covered by the home/ group -- but these
# three are real files that exist nowhere else:
#   settings.json  -- which channel plugin is enabled, plus the egress deny
#                     list (curl/wget/nc). Without it the restored main agent
#                     has no Telegram and no egress guard.
#   .claude.json   -- MCP server registrations and per-project trust.
#   plugins/       -- installed-plugin + marketplace state (12 KB).
# Named one by one on purpose: the rest of the directory is symlinks, caches
# and transcripts, and tar would follow the symlinks into a second full copy.
add_if "${REPOLIST}" "${REPO_ROOT}" .channels-config/settings.json
add_if "${REPOLIST}" "${REPO_ROOT}" .channels-config/.claude.json
add_if "${REPOLIST}" "${REPO_ROOT}" .channels-config/plugins
# Per-agent identity + channel secrets (glob; missing dir is not an error).
if [[ -d agents ]]; then
  find agents -type f \
    \( -name 'CLAUDE.md' -o -name 'SOUL.md' -o -name '.mcp.json' \
       -o -name 'access.json' -o -name '.env' \) \
    -print >> "${REPOLIST}"
fi

# home/ group (relative to $HOME)
add_if "${HOMELIST}" "${HOME}" .claude/skills
add_if "${HOMELIST}" "${HOME}" .claude/scheduled-tasks
# Every hook registration in this install lives in ONE file: ~/.claude/settings.json
# (8 hook groups measured 2026-09-22 -- PreCompact, SessionStart, UserPromptSubmit,
# PreToolUse, PostToolUse, Stop). That is the approval gate, the Hungarian copy
# gate, the outgoing-copy gate, the Telegram progress hooks and the system-directive
# check. Until the same drill, none of it was in the archive: the scripts under
# scripts/hooks/ were restorable, the file that makes anything CALL them was not,
# so a restore would have come up with every gate silently unwired.
# .credentials.json is deliberately NOT taken: a restored stale credential file
# wins over a valid env token and brings back the 401 cascade (fleet AUTH rule).
add_if "${HOMELIST}" "${HOME}" .claude/settings.json
# The file-based auto-memory. Until 2026-09-04 this was NOT in the archive, and
# a restore test that day proved what that costs: 490 markdown memories for the
# main agent alone, none of them in the tarball. The SQLite copy is not a
# substitute -- it holds the prose, not the frontmatter, the type or the
# [[links]] between memories. Only the memory/ directories are taken, not the
# whole projects/ tree, which is full of transcripts and tool-result dumps.
if [[ -d "${HOME}/.claude/projects" ]]; then
  ( cd "${HOME}" && find .claude/projects -maxdepth 2 -type d -name memory -print ) >> "${HOMELIST}"
fi
# MAIN orchestrator channel tokens + pairing state, per provider. bot.pid and
# inbox/ are runtime/transient and intentionally excluded. Since #915 the
# main state dir is install-scoped (<repo>/.claude/channels/<provider>); the
# HOME base only still holds it on an unmigrated install -- take both, each
# from its own list so restore puts them back where they came from.
if [[ -d "${HOME}/.claude/channels" ]]; then
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 \
      \( -name '.env' -o -name 'access.json' -o -name 'invites.json' \) \
      -print ) >> "${HOMELIST}"
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 -type d -name 'approved' -print ) >> "${HOMELIST}"
fi
if [[ -d "${REPO_ROOT}/.claude/channels" ]]; then
  ( cd "${REPO_ROOT}" && find .claude/channels -maxdepth 2 \
      \( -name '.env' -o -name 'access.json' -o -name 'invites.json' \) \
      -print ) >> "${REPOLIST}"
  ( cd "${REPO_ROOT}" && find .claude/channels -maxdepth 2 -type d -name 'approved' -print ) >> "${REPOLIST}"
fi
# launchd jobs for this fleet. The job labels are com.<MAIN_AGENT_ID>.<service>
# (see src/web/main-agent.ts), so resolve MAIN_AGENT_ID the way the app does
# (src/env.ts: read from .env, default "marveen" when unset) instead of
# hardcoding one deployment's prefix. Parsing mirrors env.ts: last definition
# wins, surrounding matching quotes stripped.
MAIN_AGENT_ID="marveen"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  # `|| true`: with `set -o pipefail`, a no-match grep would otherwise fail the
  # whole substitution (and, under `set -e`, abort the backup) on any install
  # that leaves MAIN_AGENT_ID unset and relies on the "marveen" default.
  _mid="$(grep -E '^[[:space:]]*MAIN_AGENT_ID[[:space:]]*=' "${REPO_ROOT}/.env" | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true)"
  [[ -n "${_mid}" ]] && MAIN_AGENT_ID="${_mid}"
fi
if [[ -d "${HOME}/Library/LaunchAgents" ]]; then
  ( cd "${HOME}" && find Library/LaunchAgents -maxdepth 1 -name "com.${MAIN_AGENT_ID}.*.plist" -print ) >> "${HOMELIST}"
  # The name prefix is not a reliable owner mark. Measured 2026-09-22: 8 of this
  # fleet's 9 launchd jobs were com.mikrobi.*, and the ninth -- the channel
  # keepalive probe, the guard that stops the night restarts -- was still named
  # com.marveen.* from before the rename, so the glob above missed exactly the
  # job whose absence is hardest to notice (a missing guard looks like quiet).
  # A plist that points INTO this repo belongs to this fleet whatever it is
  # called, so take that union. The two sources overlap, which is why both
  # lists are de-duplicated before the manifest is built.
  ( cd "${HOME}" && grep -l -- "${REPO_ROOT}" Library/LaunchAgents/*.plist 2>/dev/null || true ) >> "${HOMELIST}"
fi

# --- Local commits that live on no remote. ---------------------------------
# This archive deliberately carries unversioned state, not the source: the
# source is supposed to live on a git remote. On 2026-09-04 that assumption
# broke -- nine days of work sat committed locally and pushed nowhere, so the
# only copy was this disk, and the tarball did not hold it either. A bundle of
# every local branch that origin does not already have closes the gap for a few
# hundred KB (the full history is 26 MB, but the shared part is recoverable by
# cloning origin). Restore, after cloning origin:
#   git fetch <restored>/repo/local-commits.bundle 'refs/heads/*:refs/heads/*'
if command -v git >/dev/null 2>&1 && [[ -d "${REPO_ROOT}/.git" ]]; then
  BUNDLE="$(mktemp -t claudeclaw-bundle.XXXXXX)"
  # An empty ref set makes `git bundle` refuse with "empty bundle", which is
  # the GOOD case (everything is already pushed), not an error -- so a failure
  # here just drops the file instead of failing the backup.
  if git -C "${REPO_ROOT}" bundle create "${BUNDLE}" \
       --branches --not --remotes=origin >/dev/null 2>&1; then
    echo "backup: local-commits.bundle $(wc -c < "${BUNDLE}" | awk '{print $1}') bytes"
  else
    rm -f "${BUNDLE}"; BUNDLE=""
    echo "backup: no local-only commits to bundle"
  fi
fi

# De-duplicate both lists. Several collectors above legitimately overlap (the
# launchd name-glob and the repo-path grep name the same plists), and a repeated
# entry would be copied twice into the staging tree and listed twice in the
# manifest -- noise in the one file a restore reads first.
for _list in "${REPOLIST}" "${HOMELIST}"; do
  if [[ -s "${_list}" ]]; then
    sort -u "${_list}" > "${_list}.dedup" && mv "${_list}.dedup" "${_list}"
  fi
done

if [[ ! -s "${REPOLIST}" && ! -s "${HOMELIST}" ]]; then
  echo "backup: nothing to archive" >&2
  exit 0
fi

# --- Manifest (stored at the archive root for self-description). -----------
{
  echo "Marveen backup ${STAMP}"
  echo "host: $(hostname 2>/dev/null || echo '?')   user: ${USER:-?}   home: ${HOME}"
  echo "repo root: ${REPO_ROOT}"
  echo "Restore: tar -xpzf <archive> -C <tmp>; copy repo/* -> project root, home/* -> \$HOME."
  echo "See docs/MIGRATION.md for the full runbook (TCC, launchd paths, one-bot-one-poller, venv rebuild)."
  echo "--- repo/ ---"; sed 's,^,repo/,' "${REPOLIST}" 2>/dev/null || true
  if [[ -n "${BUNDLE}" ]]; then
    echo "repo/local-commits.bundle   (git bundle: local branches absent from origin)"
  fi
  echo "--- home/ ---"; sed 's,^,home/,' "${HOMELIST}" 2>/dev/null || true
} > "${MANIFEST}"

# --- Assemble the archive via a staging dir, then one plain tar. -----------
# The repo/ and home/ groups are produced by copying into a staging tree, NOT
# by tar name-substitution: bsdtar's `-s` and GNU tar's `--transform` are
# mutually incompatible (on GNU tar, `-s` is `--same-order` and takes no
# argument), so a substitution-based build is not portable. Staging + a single
# `tar -czf -C "${STAGE}" .` works identically on macOS (bsdtar) and Linux
# (GNU tar). Everything backed up is small (a few MB), so the copy is cheap;
# `cp -pR` preserves modes so the 0600 token files stay private.
cp "${MANIFEST}" "${STAGE}/MANIFEST.txt"

STAGE_FAILS=0
stage_group() {  # stage_group <listfile> <base> <group>
  local list="$1" base="$2" group="$3" rel parent
  [[ -s "${list}" ]] || return 0
  while IFS= read -r rel; do
    [[ -z "${rel}" ]] && continue
    parent="$(dirname "${rel}")"
    mkdir -p "${STAGE}/${group}/${parent}"
    # BACKUPALERT925: one unreadable file (e.g. a root-owned 0600 leftover) used
    # to abort the whole run under `set -e`, so no archive was written at all.
    # Skip it loudly instead; the manifest still names it, so the verification
    # below reports it as MISSING and the run fails with exit 6 and an alert.
    if ! cp -pR "${base}/${rel}" "${STAGE}/${group}/${parent}/"; then
      # A directory entry can be PARTIALLY copied (one unreadable file inside):
      # the manifest names the directory, which did get in, so verification
      # alone would pass. Count every staging failure and fail the run on it.
      STAGE_FAILS=$((STAGE_FAILS + 1))
      echo "backup: WARN could not fully stage ${group}/${rel} -- the run will fail (exit 6)" >&2
    fi
  done < "${list}"
}

stage_group "${REPOLIST}" "${REPO_ROOT}" repo
stage_group "${HOMELIST}" "${HOME}" home

if [[ -n "${BUNDLE}" ]]; then
  mkdir -p "${STAGE}/repo"
  cp -p "${BUNDLE}" "${STAGE}/repo/local-commits.bundle"
  chmod 600 "${STAGE}/repo/local-commits.bundle"
fi

# --- Drop bulky derived media from the staged prezi tree. ------------------
# Owner decision, 2026-09-19: "A pdf-ekre semmi szukseg, meg a kepekre. azokat
# nem is kell menteni mert mindent vegul canvaba teszek."
# Measured the same day: store/prezi carried 104.9 MB of PDF/PNG/JPG inside a
# 104 MB archive -- over 95% of every nightly copy was the same unchanged
# export set, re-packed each time. The state that actually matters
# (store/claudeclaw.db) is 13 MB. This matters beyond disk: the archive is
# uploaded as ONE object, so nothing dedupes between nights.
#
# Two guards on the rule, because a silent drop is exactly how the 2026-09-04
# incident happened:
#   - scoped to store/prezi ONLY. store/brand-assets holds the single original
#     SA logo (9 KB) and must never be swept up by a repo-wide media filter.
#   - inside prezi, *logo* / *brand* / *arculat* are KEPT. The transparent SA
#     logo lives there as a PNG and has no larger original, so a blanket
#     *.png rule would delete the only copy we have.
# The exclusion is recorded in the manifest (both copies, so the archive and
# the verification agree): a restore must be able to SEE what is deliberately
# absent instead of inferring it from a gap.
PREZI_STAGE="${STAGE}/repo/store/prezi"
media_files=0
media_bytes=0
if [[ -d "${PREZI_STAGE}" ]]; then
  while IFS= read -r -d '' _f; do
    media_bytes=$(( media_bytes + $(wc -c < "${_f}") ))
    media_files=$(( media_files + 1 ))
    rm -f "${_f}"
  done < <(find "${PREZI_STAGE}" -type f \
             \( -iname '*.pdf' -o -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \
                -o -iname '*.gif' -o -iname '*.webp' \) \
             ! -iname '*logo*' ! -iname '*brand*' ! -iname '*arculat*' -print0)
fi
if [[ "${media_files}" -gt 0 ]]; then
  _media_note="excluded: ${media_files} derived media file(s) from store/prezi (${media_bytes} bytes) -- PDF/PNG/JPG/JPEG/GIF/WEBP, except *logo*/*brand*/*arculat*"
  printf '%s\n' "${_media_note}" >> "${MANIFEST}"
  printf '%s\n' "${_media_note}" >> "${STAGE}/MANIFEST.txt"
  echo "backup: ${_media_note}"
fi

# Archive only the top-level entries that exist (a group dir is absent when
# its list was empty), so tar never errors on a missing entry and the names
# stay clean (no leading "./").
( cd "${STAGE}" && tar -czf "${ARCHIVE}" MANIFEST.txt \
    $( [[ -d repo ]] && echo repo ) $( [[ -d home ]] && echo home ) )
echo "backup: wrote ${ARCHIVE} ($(wc -c < "${ARCHIVE}" | awk '{print $1}') bytes)"

# --- Verify the archive against the manifest. ------------------------------
# The manifest says what the backup INTENDED to carry; until now nothing
# checked what it actually carries. That gap is exactly how 2026-09-04
# happened: the store/ whitelist had been silently dropping files for weeks
# and the restore test was what finally noticed, not the backup itself. A
# backup that cannot say what is inside it is a promise, not a copy.
#
# Two checks, because they fail differently:
#   - every manifest entry has a matching path in the archive (a staging copy
#     that silently did nothing shows up here),
#   - a few load-bearing items are present by name (an archive that is valid,
#     small and useless -- the 09-04 shape -- shows up here even if the
#     manifest itself was built wrong).
ARCHIVE_LIST="$(mktemp -t claudeclaw-verify.XXXXXX)"
trap 'rm -f "${REPOLIST}" "${HOMELIST}" "${MANIFEST}" "${ARCHIVE_LIST}"; [[ -n "${BUNDLE}" ]] && rm -f "${BUNDLE}"; rm -rf "${STAGE}"' EXIT
tar -tzf "${ARCHIVE}" > "${ARCHIVE_LIST}"

missing=0
while IFS= read -r want; do
  # Manifest body lines only: the header block and the group separators are
  # prose, not paths.
  case "${want}" in repo/*|home/*) ;; *) continue ;; esac
  # A directory entry is listed once in the manifest and expands to many paths
  # in the archive, so match on the prefix, and anchor it so "store/x" cannot
  # be satisfied by "store/xyz". LITERALLY (card a8a92d55): as a regex, a route
  # dir like `[id]` never matched itself and failed a complete backup.
  if ! archive_list_has "${ARCHIVE_LIST}" "${want}"; then
    echo "backup: MISSING from the archive: ${want}" >&2
    missing=$((missing + 1))
  fi
done < <(sed -e 's/  *(.*)$//' "${MANIFEST}")

# Load-bearing by name. Each one has already been lost or nearly lost once:
# the memory directories and the local-commit bundle on 2026-09-04, the
# credential-carrying store/ files by the whitelist that preceded it.
for marker in "repo/store/claudeclaw.db" "home/.claude/skills" "home/.claude/scheduled-tasks"; do
  archive_list_has "${ARCHIVE_LIST}" "${marker}" || {
    echo "backup: MISSING load-bearing item: ${marker}" >&2
    missing=$((missing + 1))
  }
done
# The file-based memories: only required when this host actually has some, so
# a fresh install does not fail its first backup.
if ( cd "${HOME}" && find .claude/projects -maxdepth 2 -type d -name memory -print -quit 2>/dev/null | grep -q . ); then
  grep -qE "^home/\.claude/projects/.*/memory(/|$)" "${ARCHIVE_LIST}" || {
    echo "backup: MISSING load-bearing item: the file-based memory directories" >&2
    missing=$((missing + 1))
  }
fi

if [[ "${STAGE_FAILS}" -gt 0 ]]; then
  echo "backup: FAILED staging -- ${STAGE_FAILS} entr(y/ies) could not be copied completely (see WARN lines above)." >&2
  missing=$((missing + STAGE_FAILS))
fi

if [[ "${missing}" -gt 0 ]]; then
  echo "backup: FAILED verification -- ${missing} item(s) named in the manifest are not in ${ARCHIVE}." >&2
  echo "backup: the archive is kept for inspection, but do NOT treat it as a good copy." >&2
  # launchd sends this script's output to logs/backup.log, which nobody opens.
  # A loud failure into an unread file is the same silence the verification
  # above exists to break, so the failure also goes onto the agent message
  # queue, where it survives the agent being asleep at 04:30 and gets read on
  # the next turn. Best-effort: a messaging problem must not change the exit
  # code or mask the real failure.
  # To the install's own main agent: MAIN_AGENT_ID as resolved near the top of
  # this script (from .env the way the app reads it: last definition wins,
  # quotes stripped, default "marveen"), never a fixed name -- an id that does
  # not exist on this install makes the alert go nowhere (card a8a92d55). Do not
  # re-read .env here: a second, simpler parse took the FIRST definition, kept
  # the quotes, and without `|| true` aborted the script under pipefail on an
  # install with no MAIN_AGENT_ID line (card a95cada0).
  if [[ -x "${REPO_ROOT}/scripts/agent-msg.sh" ]]; then
    # BACKUPALERT925: the recipient used to be a literal agent name from the
    # author's machine, so on any other fleet the alert went nowhere and the
    # swallowed error hid that too. Address this install's main agent.
    bash "${REPO_ROOT}/scripts/agent-msg.sh" "${MAIN_AGENT_ID}" "${MAIN_AGENT_ID}" \
      "[MENTES] A napi mentes ellenorzese ELBUKOTT ${STAMP}-kor: ${missing} tetel hianyzik az archivumbol (reszletek: logs/backup.log). Az archivum NEM tekintheto jo masolatnak." \
      >/dev/null 2>&1 || echo "backup: WARN could not queue the failure alert for ${MAIN_AGENT_ID}" >&2
  fi
  exit 6
fi
echo "backup: verified $(grep -cE '^(repo|home)/' "${MANIFEST}") manifest entries against the archive"

# --- Encrypt, then copy offsite. ------------------------------------------
# Added 2026-09-19. The offsite copy was blocked for months by one fact: this
# archive carries live secrets (dashboard bearer, channel bot tokens, .env),
# so it could not go into any cloud folder. Public-key encryption removes the
# blocker instead of arguing with it -- only the PUBLIC key is on this host,
# so nothing here can read back what it uploaded.
#
# Both steps are OPT-IN by the presence of a config file, and both are LOUD
# when half-configured. A backup that silently skips encryption and uploads
# the raw tarball would be worse than no offsite copy at all.
#
# Order matters: the manifest verification above runs on the PLAIN archive.
# Encrypt only after it passed, or a failed verification would leave an
# unreadable blob as the only artifact.
AGE_RECIPIENT_FILE="${REPO_ROOT}/store/.backup-age-recipient"
R2_REMOTE_FILE="${REPO_ROOT}/store/.backup-r2-remote"
UPLOAD_ARCHIVE="${ARCHIVE}"

if [[ -f "${AGE_RECIPIENT_FILE}" ]]; then
  if ! command -v age >/dev/null 2>&1; then
    echo "backup: ERROR -- ${AGE_RECIPIENT_FILE} exists but 'age' is not installed; NOT encrypting and NOT uploading." >&2
    UPLOAD_ARCHIVE=""
  else
    # First non-empty line, trimmed at the ENDS only. An earlier version used
    # `tr -d '[:space:]'`, which is right for an age1... key and WRONG for an
    # SSH public key: age accepts `ssh-ed25519 AAAA... comment` as a recipient,
    # and squeezing out the inner spaces turns it into
    # "malformed SSH recipient: ... ssh: no key found". Measured 2026-09-19 --
    # and it matters here, because the owner's laptop has ssh-keygen built in
    # while its Homebrew is broken, so the SSH form is the path of least
    # resistance for generating the key OFF this machine.
    _recipient="$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "${AGE_RECIPIENT_FILE}" | grep -v '^$' | head -1)"
    if [[ -z "${_recipient}" ]]; then
      echo "backup: ERROR -- ${AGE_RECIPIENT_FILE} is empty; NOT encrypting and NOT uploading." >&2
      UPLOAD_ARCHIVE=""
    elif age -r "${_recipient}" -o "${ARCHIVE}.age" "${ARCHIVE}"; then
      # The raw tarball goes NOW. Leaving it next to the encrypted copy makes
      # the encryption decorative: every token would still sit there in clear.
      rm -f "${ARCHIVE}"
      UPLOAD_ARCHIVE="${ARCHIVE}.age"
      echo "backup: encrypted -> $(basename "${UPLOAD_ARCHIVE}") ($(wc -c < "${UPLOAD_ARCHIVE}" | tr -d ' ') bytes), plain tar.gz removed"
    else
      echo "backup: ERROR -- age encryption failed; the plain archive is kept locally and NOT uploaded." >&2
      UPLOAD_ARCHIVE=""
    fi
  fi
else
  # No recipient configured: stay local, and say so once per run rather than
  # letting the absence pass as "nothing to do".
  echo "backup: note -- no ${AGE_RECIPIENT_FILE}, so the archive stays local and unencrypted." >&2
fi

if [[ -n "${UPLOAD_ARCHIVE}" && -f "${R2_REMOTE_FILE}" && "${UPLOAD_ARCHIVE}" == *.age ]]; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "backup: ERROR -- ${R2_REMOTE_FILE} exists but 'rclone' is not installed; nothing was uploaded." >&2
  else
    _remote="$(tr -d '[:space:]' < "${R2_REMOTE_FILE}")"
    # Upload only. The script NEVER deletes remotely, and that is deliberate:
    # the R2 key lives on this host, so a script that prunes the remote would
    # hand anyone who reaches this machine a one-command way to wipe the very
    # copy the offsite backup exists for.
    if rclone copy "${UPLOAD_ARCHIVE}" "${_remote}/" >/dev/null 2>&1; then
      # "200 OK" is not proof. Compare the byte count on the far side.
      _local_bytes="$(wc -c < "${UPLOAD_ARCHIVE}" | tr -d ' ')"
      _remote_bytes="$(rclone size "${_remote}/$(basename "${UPLOAD_ARCHIVE}")" --json 2>/dev/null | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
      if [[ "${_remote_bytes}" == "${_local_bytes}" ]]; then
        echo "backup: uploaded -> ${_remote}/$(basename "${UPLOAD_ARCHIVE}") (${_local_bytes} bytes, size matches)"
      else
        echo "backup: ERROR -- upload size mismatch: local ${_local_bytes}, remote '${_remote_bytes}'. Treat the offsite copy as bad." >&2
      fi
    else
      echo "backup: ERROR -- rclone upload to ${_remote} failed; the local encrypted archive is kept." >&2
    fi
  fi
elif [[ -f "${R2_REMOTE_FILE}" && -z "${UPLOAD_ARCHIVE}" ]]; then
  echo "backup: upload skipped -- there is no encrypted archive to send (see the error above)." >&2
elif [[ -f "${R2_REMOTE_FILE}" ]]; then
  echo "backup: upload skipped -- the archive is not encrypted, and an unencrypted copy must never leave this host." >&2
fi

# The archive contains sensitive tokens (dashboard bearer, channel bot tokens,
# project .env secrets). Do not auto-sync ${BACKUP_DIR} to iCloud, Dropbox,
# Google Drive, or any other cloud-backup folder. Keep it local.
echo "backup: WARNING -- archive contains sensitive tokens; keep ${BACKUP_DIR} out of cloud-sync folders (iCloud / Dropbox / Google Drive)." >&2

# Keep the newest ${KEEP} archives, drop the rest. while-read (not mapfile)
# for macOS bash 3.2 compatibility.
#
# `|| true` on the ls: with `set -euo pipefail` (top of file) an EMPTY
# ${BACKUP_DIR} makes the glob stay literal, `ls` exits 2, pipefail promotes
# that to the pipeline's status, and `set -e` kills the script -- AFTER a
# completely successful backup. Measured 2026-09-19 in a throwaway empty dir:
# exit code 1, and the statement after this block never ran. It does not bite
# today (9 archives, KEEP=14), but it bites on a fresh install's first run and
# on any host where someone empties the directory -- and it would look like
# the backup fails every single night. Found via a third-party writeup that
# lists this exact shape as a known trap.
# The braces are load-bearing: `|` binds tighter than `||`, so a bare
# `ls ... || true | tail ...` would parse as `ls ... || { true | tail ... }`
# and skip the pruning entirely on the success path.
#
# The glob matches BOTH .tar.gz and .tar.gz.age. Once encryption is on, every
# archive is a .age file -- a pattern that only said `*.tar.gz` would match
# nothing, prune nothing, and let the directory grow without bound while still
# reporting success. That is the same silent shape as the empty-dir trap above,
# just pointing the other way.
{ ls -1t "${BACKUP_DIR}"/claudeclaw-*.tar.gz "${BACKUP_DIR}"/claudeclaw-*.tar.gz.age 2>/dev/null || true; } | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
  [[ -z "${f}" ]] && continue
  rm -f "${f}"
  echo "backup: pruned $(basename "${f}")"
done
