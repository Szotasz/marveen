# update-rebase-go.sh -- the owner's GO that update.sh's auto-rebase branch requires (AUTOUPDATEDIVERG1110).
#
# Why: on a diverged install (local commits AND new upstream commits) update.sh can replay the local
# commits onto the new upstream. Until now one environment variable (UPDATE_AUTO_REBASE=1) switched that
# on, so an agent could rewrite the install's history with nobody asked: the db-write-gate denies
# `git rebase` in the install, not a script that rebases. Rewriting history is the owner's call, so the
# rebase now needs an approval the OWNER gave (the approvals API: approving takes an owner session, or a
# Bridge key with the owner's session; never the shared or an agent token), bound to exactly this rebase
# and used once.
#
# The binding (content_hash): sha256 of
#     update_rebase\nbranch=<branch>\nhead=<HEAD sha>\ntarget=<upstream sha>\n
# HEAD pins the local commits (their history is part of the commit id), target pins what they are
# replayed onto. A new local or upstream commit after the GO changes the hash: hash_mismatch.
#
# The flow:
#   1. scripts/update-rebase-request.sh prints the hash (and the request command) for this install now.
#   2. The agent files the request: approval-request <agent> update_rebase <timeout> <file> --content-hash <h>.
#   3. The owner approves it (dashboard Approvals page, Bridge).
#   4. UPDATE_REBASE_APPROVAL=<id> bash update.sh: after its fetch, update.sh runs THIS FILE as a program
#      (`rebase` below) in a CLEAN process; it consumes the approval and, only on HTTP 200, rebases.
#
# Why a clean process (Dani's review of #2676, measured): the caller controls update.sh's environment.
# A node, sed or grep earlier on its PATH, or an EXPORTED shell function of that name, decided the check
# (the port read, the verdict), and an exported function can even replace `exit` or `[` inside update.sh
# (measured: bash imports such functions). So both the decision AND the rebase happen here, in a process
# started as `/usr/bin/env -i PATH=<system dirs> /bin/bash --noprofile --norc <this file> rebase ...`:
# no inherited variables, no imported functions (bash refuses to import a function named /usr/bin/env),
# fixed system tool directories, curl by absolute path, the port read with sed (digits only, no node)
# from the install's own config, never the environment. Whatever update.sh does with the answer, the
# history is rewritten only in here, after a consumed GO.
# Stated limit: a caller that runs arbitrary code can rebase without update.sh at all; no gate here is
# an OS boundary. This closes the documented switch and its environment-level bypasses.

UPDATE_REBASE_CATEGORY='update_rebase'
# Dani's second delta review (47f33c43), measured: the caller's HOME reached the clean process, and curl
# without -q read $HOME/.curlrc, whose connect-to line steered the consume call to a server of the
# caller's own -- a real rebase with no approval. So: update.sh gives this process a FIXED HOME inside the
# install (an empty, never-created path: no .curlrc, no .gitconfig is read from it), curl runs with -q as
# its first argument (no curlrc at all), the hash tool is called by absolute path, the PATH holds only
# root-owned system directories (no /usr/local/bin, no /opt/homebrew/bin: those are user-writable), and
# the rebase gets an explicit committer identity instead of one from a config file.
UPDATE_REBASE_COMMITTER_NAME='Marveen update'
UPDATE_REBASE_COMMITTER_EMAIL='update@marveen.invalid'

# stdin -> 64 lowercase hex, or rc 1 (never an empty or truncated fingerprint).
update_rebase_sha256() {
  local h=''
  # Absolute paths only: a hash tool found on a user-writable PATH directory could print the hash of
  # ANOTHER, already approved request (Dani, non-blocking note on 47f33c43).
  if [ -x /usr/bin/sha256sum ]; then h="$(/usr/bin/sha256sum | /usr/bin/awk '{print $1}')"
  elif [ -x /usr/bin/shasum ]; then h="$(/usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
  elif [ -x /usr/bin/openssl ]; then h="$(/usr/bin/openssl dgst -sha256 -r | /usr/bin/awk '{print $1}')"
  else /bin/cat >/dev/null; return 1
  fi
  case "$h" in *[!0-9a-f]*|'') return 1 ;; esac
  [ "${#h}" -eq 64 ] || return 1
  printf '%s' "$h"
}

# update_rebase_hash <branch> <head-sha> <target-sha> -> the content_hash the approval must carry.
update_rebase_hash() {
  printf 'update_rebase\nbranch=%s\nhead=%s\ntarget=%s\n' "$1" "$2" "$3" | update_rebase_sha256
}

# The install's dashboard port from its config files only (config-overrides.json > .env > 3420), digits only.
update_rebase_port() {
  local dir="$1" p=''
  if [ -f "$dir/store/config-overrides.json" ]; then
    p="$(tr -d '\n' < "$dir/store/config-overrides.json" | sed -n 's/.*"WEB_PORT"[[:space:]]*:[[:space:]]*"\{0,1\}\([0-9][0-9]*\)"\{0,1\}.*/\1/p' | head -1)"
  fi
  if [ -z "$p" ] && [ -f "$dir/.env" ]; then
    p="$(sed -n 's/^WEB_PORT=["'"'"']\{0,1\}\([0-9][0-9]*\)["'"'"']\{0,1\}[[:space:]]*$/\1/p' "$dir/.env" | head -1)"
  fi
  case "$p" in ''|*[!0-9]*) p=3420 ;; esac
  printf '%s' "$p"
}

# update_rebase_consume <install-dir> <approval-id> <branch> <head> <target> -> rc 0 consumed now; rc 1 + reason on stdout.
update_rebase_consume() {
  local dir="$1" id="$2" branch="$3" head="$4" target="$5" hash port tok out code body reason
  if [ -z "$id" ]; then echo 'no-approval-id'; return 1; fi
  case "$id" in *[!0-9a-fA-F-]*) echo 'bad-approval-id'; return 1 ;; esac
  [ "${#id}" -eq 36 ] || { echo 'bad-approval-id'; return 1; }
  hash="$(update_rebase_hash "$branch" "$head" "$target")" || { echo 'no-hash'; return 1; }
  [ -r "$dir/store/.dashboard-token" ] || { echo 'no-token'; return 1; }
  tok="$(tr -d '\r\n' < "$dir/store/.dashboard-token")"
  case "$tok" in ''|*\"*|*\\*) echo 'no-token'; return 1 ;; esac
  port="$(update_rebase_port "$dir")"
  body="$(printf '{"category":"%s","content_hash":"%s","consumer":"update.sh auto-rebase","ref":"%s %s..%s"}' \
    "$UPDATE_REBASE_CATEGORY" "$hash" "$branch" "$head" "$target")"
  # The token travels in a curl config on stdin (never in an argv), as scripts/lib/curl-tok.sh does.
  # -q FIRST: curl reads no curlrc at all (a caller's .curlrc could redirect the call).
  out="$(printf 'header = "Authorization: Bearer %s"\n' "$tok" | /usr/bin/curl -q -K - -sS -m 10 \
    -o - -w '\n%{http_code}' -H 'Content-Type: application/json' -X POST --data-binary "$body" \
    "http://127.0.0.1:${port}/api/approvals/${id}/consume" 2>/dev/null)" || { echo 'dashboard-unreachable'; return 1; }
  code="${out##*$'\n'}"
  if [ "$code" = "200" ] && printf '%s' "$out" | grep -q '"ok":true'; then return 0; fi
  reason="$(printf '%s' "$out" | sed -n 's/.*"reason":"\([a-z_]*\)".*/\1/p' | head -1)"
  echo "${reason:-http-$code}"
  return 1
}

# A local commit that changes package.json without package-lock.json cannot pass `npm ci` on ANY version
# (measured on a toy install 2026-11-10: the same failure before and after the update), so the update can
# never succeed. update_rebase_will_fail <base> prints the reason when the local commits (base..HEAD) do
# that, and nothing otherwise. The GO is not spent on such a run (Dani F4).
update_rebase_will_fail() {
  local base="$1" files
  files="$(git diff --name-only "$base" HEAD 2>/dev/null)" || { echo 'diff-failed'; return 0; }
  if printf '%s\n' "$files" | grep -qx 'package.json' && ! printf '%s\n' "$files" | grep -qx 'package-lock.json'; then
    echo 'local-dependency-without-lock'
  fi
}

# The recovery ref before the rewrite (Dani F4, N1): refs/marveen/pre-update/<UTC YYYYMMDDTHHMMSSZ>, not a
# branch and not under refs/remotes. Keeps the newest 5, deleting older ones one by one with their exact old
# sha (update-ref -d <ref> <sha>, no glob). Prints the ref name; rc 1 when it could not be written.
UPDATE_REBASE_BACKUP_NS='refs/marveen/pre-update'
UPDATE_REBASE_BACKUP_KEEP=5
update_rebase_backup() {
  local head="$1" name ref n=1 line old_ref old_sha kept=0
  name="$(/bin/date -u +%Y%m%dT%H%M%SZ)"
  ref="$UPDATE_REBASE_BACKUP_NS/$name"
  while git show-ref --verify -q "$ref"; do n=$((n + 1)); ref="$UPDATE_REBASE_BACKUP_NS/$name-$n"; done
  git update-ref "$ref" "$head" "" 2>/dev/null || return 1
  [ "$(git rev-parse --verify -q "$ref" 2>/dev/null)" = "$head" ] || return 1
  while IFS=' ' read -r old_ref old_sha; do
    [ -n "$old_ref" ] || continue
    kept=$((kept + 1))
    [ "$kept" -le "$UPDATE_REBASE_BACKUP_KEEP" ] && continue
    git update-ref -d "$old_ref" "$old_sha" 2>/dev/null || true
  done < <(git for-each-ref --sort=-refname --format='%(refname) %(objectname)' "$UPDATE_REBASE_BACKUP_NS/")
  printf '%s' "$ref"
}

# The program: `rebase <install-dir> <approval-id> <branch>`, run by update.sh in a clean process, in the
# install, AFTER update.sh fetched origin/<branch> (FETCH_HEAD). The order is fixed (Dani F4): the will-fail
# pre-filter, the recovery ref, the consume, the rebase -- a run that cannot succeed and a failed backup never
# spend the GO. One line per outcome, key=value, the free-text subject LAST; exit code:
#   0  "consumed id=<id> head=<sha> target=<sha> rebased=<sha> backup=<ref>"
#   1  "refused reason=<reason> head=<sha> target=<sha>"                       nothing changed, GO not spent
#   3  "conflict backup=<ref> commit=<short> files=<a,b> subject=<text>"       GO spent, rebase aborted, HEAD unchanged
update_rebase_main() {
  local cmd="$1" dir="$2" id="$3" branch="$4" head target base reason backup new short subject files
  [ "$cmd" = "rebase" ] || { echo "usage: rebase <install-dir> <approval-id> <branch>"; return 2; }
  cd "$dir" || { echo "refused reason=no-install-dir"; return 1; }
  head="$(git rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null)"
  target="$(git rev-parse --verify -q 'FETCH_HEAD^{commit}' 2>/dev/null)"
  if [ -z "$head" ] || [ -z "$target" ]; then echo "refused reason=no-sha head=${head:-?} target=${target:-?}"; return 1; fi
  base="$(git merge-base "$head" "$target" 2>/dev/null)"
  [ -n "$base" ] || { echo "refused reason=no-merge-base head=$head target=$target"; return 1; }
  reason="$(update_rebase_will_fail "$base")"
  if [ -n "$reason" ]; then echo "refused reason=$reason head=$head target=$target"; return 1; fi
  if ! backup="$(update_rebase_backup "$head")"; then echo "refused reason=backup-failed head=$head target=$target"; return 1; fi
  if ! reason="$(update_rebase_consume "$dir" "$id" "$branch" "$head" "$target")"; then
    echo "refused reason=${reason:-unknown} head=$head target=$target"; return 1
  fi
  if git -c core.editor=true -c user.name="$UPDATE_REBASE_COMMITTER_NAME" -c user.email="$UPDATE_REBASE_COMMITTER_EMAIL" \
       rebase "$target" >/dev/null 2>&1; then
    new="$(git rev-parse HEAD 2>/dev/null)"
    echo "consumed id=$id head=$head target=$target rebased=$new backup=$backup"; return 0
  fi
  short="$(git rev-parse --short REBASE_HEAD 2>/dev/null || echo '?')"
  subject="$(git log -1 --format=%s REBASE_HEAD 2>/dev/null | tr -d '\r\n' || true)"
  files="$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
  git rebase --abort >/dev/null 2>&1 || true
  echo "conflict backup=$backup commit=$short files=$files subject=$subject"
  return 3
}

# Run as a program (update.sh's clean process): `bash update-rebase-go.sh rebase <dir> <id> <branch>`.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  update_rebase_main "$@"
  exit $?
fi
