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
# The PATH the clean process gets: fixed system directories (the system tools come first).
UPDATE_REBASE_CLEAN_PATH='/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin'

# stdin -> 64 lowercase hex, or rc 1 (never an empty or truncated fingerprint).
update_rebase_sha256() {
  local h=''
  if command -v sha256sum >/dev/null 2>&1; then h="$(sha256sum | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then h="$(shasum -a 256 | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then h="$(openssl dgst -sha256 -r | awk '{print $1}')"
  else cat >/dev/null; return 1
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
  out="$(printf 'header = "Authorization: Bearer %s"\n' "$tok" | /usr/bin/curl -K - -sS -m 10 \
    -o - -w '\n%{http_code}' -H 'Content-Type: application/json' -X POST --data-binary "$body" \
    "http://127.0.0.1:${port}/api/approvals/${id}/consume" 2>/dev/null)" || { echo 'dashboard-unreachable'; return 1; }
  code="${out##*$'\n'}"
  if [ "$code" = "200" ] && printf '%s' "$out" | grep -q '"ok":true'; then return 0; fi
  reason="$(printf '%s' "$out" | sed -n 's/.*"reason":"\([a-z_]*\)".*/\1/p' | head -1)"
  echo "${reason:-http-$code}"
  return 1
}

# The program: `rebase <install-dir> <approval-id> <branch>`, run by update.sh in a clean process, in the
# install, AFTER update.sh fetched origin/<branch> (FETCH_HEAD). Prints one line per outcome, exit code:
#   0  "consumed <id> head=<sha> target=<sha> rebased=<sha>"  the GO was consumed and the rebase is done
#   1  "refused <reason> head=<sha> target=<sha>"              no GO; nothing changed
#   3  "conflict <commit> <subject> files=<a,b>"               GO consumed, the rebase conflicted and was aborted
update_rebase_main() {
  local cmd="$1" dir="$2" id="$3" branch="$4" head target reason new cur files
  [ "$cmd" = "rebase" ] || { echo "usage: rebase <install-dir> <approval-id> <branch>"; return 2; }
  cd "$dir" || { echo "refused no-install-dir"; return 1; }
  head="$(git rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null)"
  target="$(git rev-parse --verify -q 'FETCH_HEAD^{commit}' 2>/dev/null)"
  if [ -z "$head" ] || [ -z "$target" ]; then echo "refused no-sha head=${head:-?} target=${target:-?}"; return 1; fi
  if ! reason="$(update_rebase_consume "$dir" "$id" "$branch" "$head" "$target")"; then
    echo "refused ${reason:-unknown} head=$head target=$target"; return 1
  fi
  if git -c core.editor=true rebase "$target" >/dev/null 2>&1; then
    new="$(git rev-parse HEAD 2>/dev/null)"
    echo "consumed $id head=$head target=$target rebased=$new"; return 0
  fi
  cur="$(git rev-parse --short REBASE_HEAD 2>/dev/null || echo '?') $(git log -1 --format=%s REBASE_HEAD 2>/dev/null || true)"
  files="$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
  git rebase --abort >/dev/null 2>&1 || true
  echo "conflict ${cur} files=${files}"
  return 3
}

# Run as a program (update.sh's clean process): `bash update-rebase-go.sh rebase <dir> <id> <branch>`.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  update_rebase_main "$@"
  exit $?
fi
