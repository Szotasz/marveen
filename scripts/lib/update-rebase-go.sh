# update-rebase-go.sh -- the owner's GO that update.sh's auto-rebase branch requires (AUTOUPDATEDIVERG1110).
#
# Why: on a diverged install (local commits AND new upstream commits) update.sh can replay the local
# commits onto the new upstream (the UPDATE_AUTO_REBASE branch). Until now one environment variable
# switched that on, so an agent could run `UPDATE_AUTO_REBASE=1 bash update.sh` and rewrite the
# install's history with nobody asked: the db-write-gate denies `git rebase` in the install, but
# not a script that rebases. Rewriting history is the owner's call, so the rebase now needs an
# approval the OWNER gave (the approvals API: approving takes an owner session or a Bridge key with
# the owner's session, never the shared or an agent token), bound to exactly this rebase and used once.
#
# The binding (content_hash): sha256 of
#     update_rebase\nbranch=<branch>\nhead=<HEAD sha>\ntarget=<upstream sha>\n
# HEAD pins the local commits (their history is part of the commit id), target pins what they are
# replayed onto. If either moves after the GO -- a new local commit, a new upstream commit -- the
# hash differs and the consume answers hash_mismatch.
#
# The flow:
#   1. scripts/update-rebase-request.sh prints the hash (and the request command) for this install now.
#   2. The agent files the request: approval-request <agent> update_rebase <timeout> <file> --content-hash <h>.
#   3. The owner approves it (dashboard Approvals page, Slack reaction, Bridge).
#   4. UPDATE_REBASE_APPROVAL=<id> bash update.sh: the diverged branch fetches, recomputes the hash and
#      consumes the approval (POST /api/approvals/<id>/consume, category update_rebase) BEFORE the rebase.
#      Only HTTP 200 lets the rebase run. Consumed, expired (approved more than 30 min ago), not approved,
#      bound to another HEAD/target, unknown id, no dashboard: no rebase, today's exit 5, HEAD unchanged.
#
# Where it asks: the dashboard of THIS install, on the port from the install's own config
# (store/config-overrides.json, then .env, then 3420) -- never the process environment, so a caller
# cannot point the check at a server of its own with WEB_PORT=. curl is called by absolute path.
# Stated limit: this is a check in a shell script the caller starts. It closes the documented
# switch; it is not an OS boundary against a caller that can run arbitrary code (no gate here is).

UPDATE_REBASE_CATEGORY='update_rebase'

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

# The install's dashboard port, from its config files only (config-overrides.json > .env > 3420).
update_rebase_port() {
  local dir="$1" p=''
  if [ -f "$dir/store/config-overrides.json" ] && command -v node >/dev/null 2>&1; then
    p="$(node -e 'try{const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=o&&o.WEB_PORT;if(v!==undefined&&v!==null)process.stdout.write(String(v))}catch{}' "$dir/store/config-overrides.json" 2>/dev/null)"
  fi
  if [ -z "$p" ] && [ -f "$dir/.env" ]; then
    p="$(sed -n 's/^WEB_PORT=//p' "$dir/.env" | head -1 | tr -d "\"' ")"
  fi
  case "$p" in ''|*[!0-9]*) p=3420 ;; esac
  printf '%s' "$p"
}

# update_rebase_go_consume <install-dir> <approval-id> <branch> <head-sha> <target-sha>
# rc 0: the owner's approval for exactly this rebase was consumed now (one use).
# rc 1: no GO; UPDATE_REBASE_GO_REASON says why (no-approval-id, bad-approval-id, no-hash, no-token,
#       dashboard-unreachable, not_found, already_consumed, expired, not_approved, hash_mismatch,
#       wrong_category, http-<code>).
UPDATE_REBASE_GO_REASON=''
update_rebase_go_consume() {
  local dir="$1" id="$2" branch="$3" head="$4" target="$5" hash port tok out code body reason
  UPDATE_REBASE_GO_REASON=''
  if [ -z "$id" ]; then UPDATE_REBASE_GO_REASON='no-approval-id'; return 1; fi
  case "$id" in *[!0-9a-fA-F-]*) UPDATE_REBASE_GO_REASON='bad-approval-id'; return 1 ;; esac
  [ "${#id}" -eq 36 ] || { UPDATE_REBASE_GO_REASON='bad-approval-id'; return 1; }
  hash="$(update_rebase_hash "$branch" "$head" "$target")" || { UPDATE_REBASE_GO_REASON='no-hash'; return 1; }
  [ -r "$dir/store/.dashboard-token" ] || { UPDATE_REBASE_GO_REASON='no-token'; return 1; }
  tok="$(tr -d '\r\n' < "$dir/store/.dashboard-token")"
  case "$tok" in ''|*\"*|*\\*) UPDATE_REBASE_GO_REASON='no-token'; return 1 ;; esac
  port="$(update_rebase_port "$dir")"
  body="$(printf '{"category":"%s","content_hash":"%s","consumer":"update.sh auto-rebase","ref":"%s %s..%s"}' \
    "$UPDATE_REBASE_CATEGORY" "$hash" "$branch" "$head" "$target")"
  # The token travels in a curl config on stdin (never in an argv), as scripts/lib/curl-tok.sh does.
  out="$(printf 'header = "Authorization: Bearer %s"\n' "$tok" | /usr/bin/curl -K - -sS -m 10 \
    -o - -w '\n%{http_code}' -H 'Content-Type: application/json' -X POST --data-binary "$body" \
    "http://127.0.0.1:${port}/api/approvals/${id}/consume" 2>/dev/null)" || { UPDATE_REBASE_GO_REASON='dashboard-unreachable'; return 1; }
  code="${out##*$'\n'}"
  if [ "$code" = "200" ] && printf '%s' "$out" | grep -q '"ok":true'; then return 0; fi
  reason="$(printf '%s' "$out" | sed -n 's/.*"reason":"\([a-z_]*\)".*/\1/p' | head -1)"
  UPDATE_REBASE_GO_REASON="${reason:-http-$code}"
  return 1
}
