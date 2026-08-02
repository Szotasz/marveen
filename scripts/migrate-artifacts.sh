#!/usr/bin/env bash
# migrate-artifacts.sh -- import loose artifact files into the SQLite artifact store
#
# USAGE:
#   migrate-artifacts.sh [OPTIONS] --agent AGENT_ID [--dir DIR ...]
#
# OPTIONS:
#   --agent AGENT_ID     agent_id to attach imported artifacts to (required)
#   --dir DIR            directory to scan (repeatable; default: auto-detect scratchpad dirs)
#   --min-bytes N        skip files smaller than N bytes (default: 100)
#   --dry-run            scan and log what would be imported, but do not write or delete
#   --log FILE           write JSON log to FILE (default: store/artifact-migration-<ts>.json)
#   --port PORT          dashboard port (default: WEB_PORT env / .env / 3420)
#
# FLOW PER FILE:
#   1. sha256 of the file on disk
#   2. POST /api/artifacts  -> id
#   3. GET  /api/artifacts/:id -> sha256 of stored content
#   4. if sha256 matches  -> DELETE local file
#      if sha256 mismatch -> keep local file, log error (never deletes on doubt)
#
# EXIT CODES: 0=ok (incl. dry-run), 1=fatal (bad args / no token / API down)

set -euo pipefail
IFS=$'\n\t'

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

# ── helpers ──────────────────────────────────────────────────────────────────

log_json() {
  # append a JSON object line to LOG_FILE
  printf '%s\n' "$1" >> "$LOG_FILE"
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

sha256_string() {
  # sha256 of a string (from API content field)
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else
    printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  fi
}

json_escape() {
  # minimal JSON string escaping for shell-built payloads
  printf '%s' "$1" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'
}

detect_kind() {
  local file="$1"
  local ext="${file##*.}"
  case "${ext,,}" in
    html|htm) echo "html" ;;
    md|markdown) echo "markdown" ;;
    json) echo "json" ;;
    txt|text) echo "text" ;;
    *) echo "binary" ;;
  esac
}

detect_mime() {
  local kind="$1"
  case "$kind" in
    html)     echo "text/html; charset=utf-8" ;;
    markdown) echo "text/markdown; charset=utf-8" ;;
    json)     echo "application/json; charset=utf-8" ;;
    text)     echo "text/plain; charset=utf-8" ;;
    *)        echo "application/octet-stream" ;;
  esac
}

# ── defaults ─────────────────────────────────────────────────────────────────

DRY_RUN=0
AGENT_ID=""
MIN_BYTES=100
DIRS=()
LOG_FILE=""
WEB_PORT="${WEB_PORT:-}"

# resolve WEB_PORT from .env if not set
if [ -z "$WEB_PORT" ]; then
  WEB_PORT="$(grep -E '^WEB_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "' || true)"
  WEB_PORT="${WEB_PORT:-3420}"
fi

# ── argument parsing ──────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)    DRY_RUN=1; shift ;;
    --agent)      AGENT_ID="$2"; shift 2 ;;
    --dir)        DIRS+=("$2"); shift 2 ;;
    --min-bytes)  MIN_BYTES="$2"; shift 2 ;;
    --log)        LOG_FILE="$2"; shift 2 ;;
    --port)       WEB_PORT="$2"; shift 2 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[ -n "$AGENT_ID" ] || die "--agent AGENT_ID is required"

# ── log file setup ────────────────────────────────────────────────────────────

TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${LOG_FILE:-$INSTALL_DIR/store/artifact-migration-${TS}.json}"
mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE"   # truncate / create

# ── token ────────────────────────────────────────────────────────────────────

TOKEN_FILE="$INSTALL_DIR/store/.dashboard-token"
[ -f "$TOKEN_FILE" ] || die "store/.dashboard-token not found -- is the dashboard running?"
TOKEN="$(cat "$TOKEN_FILE")"
BASE_URL="http://127.0.0.1:${WEB_PORT}"

# quick connectivity check
HTTP_CHECK="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/artifacts" 2>/dev/null || true)"
[ "$HTTP_CHECK" = "200" ] || die "Cannot reach $BASE_URL/api/artifacts (HTTP $HTTP_CHECK). Is the dashboard running?"

# ── auto-detect directories ───────────────────────────────────────────────────

if [ ${#DIRS[@]} -eq 0 ]; then
  # scratchpad dirs: /private/tmp/claude-* or /tmp/claude-* (macOS / Linux)
  while IFS= read -r d; do
    [ -d "$d" ] && DIRS+=("$d")
  done < <(find /private/tmp /tmp -maxdepth 2 -name 'claude-*' -type d 2>/dev/null | sort || true)

  # CLAUDE_SCRATCHPAD_DIR env override
  if [ -n "${CLAUDE_SCRATCHPAD_DIR:-}" ] && [ -d "$CLAUDE_SCRATCHPAD_DIR" ]; then
    DIRS+=("$CLAUDE_SCRATCHPAD_DIR")
  fi

  [ ${#DIRS[@]} -gt 0 ] || die "No directories found to scan. Use --dir to specify one."
fi

# ── scan ─────────────────────────────────────────────────────────────────────

IMPORTED=0
VERIFIED=0
DELETED=0
SKIPPED=0
FAILED=0

printf 'migrate-artifacts: scanning %d director%s (dry-run=%d, min-bytes=%d)\n' \
  "${#DIRS[@]}" "$([ ${#DIRS[@]} -eq 1 ] && echo y || echo ies)" "$DRY_RUN" "$MIN_BYTES"

for SCAN_DIR in "${DIRS[@]}"; do
  printf '  scanning: %s\n' "$SCAN_DIR"

  while IFS= read -r FILE; do
    # size filter
    SIZE="$(wc -c < "$FILE" | tr -d ' ')"
    if [ "$SIZE" -lt "$MIN_BYTES" ]; then
      SKIPPED=$((SKIPPED + 1))
      log_json "{\"action\":\"skip\",\"reason\":\"too_small\",\"file\":$(json_escape "$FILE"),\"size\":$SIZE}"
      continue
    fi

    KIND="$(detect_kind "$FILE")"
    MIME="$(detect_mime "$KIND")"
    TITLE="$(basename "$FILE")"
    LOCAL_SHA="$(sha256_file "$FILE")"

    if [ "$DRY_RUN" -eq 1 ]; then
      printf '  [dry-run] would import: %s (%s, %d bytes)\n' "$FILE" "$KIND" "$SIZE"
      log_json "{\"action\":\"dry_run\",\"file\":$(json_escape "$FILE"),\"kind\":\"$KIND\",\"size\":$SIZE,\"sha256\":\"$LOCAL_SHA\"}"
      IMPORTED=$((IMPORTED + 1))
      continue
    fi

    # ── import ──────────────────────────────────────────────────────────────
    printf '  importing: %s (%s, %d bytes) ... ' "$FILE" "$KIND" "$SIZE"

    if [ "$KIND" = "binary" ]; then
      CONTENT_B64="$(base64 < "$FILE" | tr -d '\n')"
      PAYLOAD="$(python3 -c "
import sys, json
print(json.dumps({'agent_id': sys.argv[1], 'title': sys.argv[2], 'kind': sys.argv[3], 'mime': sys.argv[4], 'content': sys.argv[5]}))
" "$AGENT_ID" "$TITLE" "$KIND" "$MIME" "$CONTENT_B64")"
    else
      FILE_CONTENT="$(cat "$FILE")"
      PAYLOAD="$(python3 -c "
import sys, json
print(json.dumps({'agent_id': sys.argv[1], 'title': sys.argv[2], 'kind': sys.argv[3], 'mime': sys.argv[4], 'content': sys.argv[5]}))
" "$AGENT_ID" "$TITLE" "$KIND" "$MIME" "$FILE_CONTENT")"
    fi

    IMPORT_RESP="$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/artifacts" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" 2>/dev/null)"
    IMPORT_STATUS="$(printf '%s' "$IMPORT_RESP" | tail -1)"
    IMPORT_BODY="$(printf '%s' "$IMPORT_RESP" | head -n -1)"

    if [ "$IMPORT_STATUS" != "201" ]; then
      printf 'FAILED (HTTP %s)\n' "$IMPORT_STATUS"
      FAILED=$((FAILED + 1))
      log_json "{\"action\":\"import_failed\",\"file\":$(json_escape "$FILE"),\"http\":$IMPORT_STATUS,\"body\":$(json_escape "$IMPORT_BODY")}"
      continue
    fi

    ARTIFACT_ID="$(printf '%s' "$IMPORT_BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])' 2>/dev/null || true)"
    if [ -z "$ARTIFACT_ID" ]; then
      printf 'FAILED (no id in response)\n'
      FAILED=$((FAILED + 1))
      log_json "{\"action\":\"import_failed\",\"file\":$(json_escape "$FILE"),\"reason\":\"no_id\",\"body\":$(json_escape "$IMPORT_BODY")}"
      continue
    fi

    printf 'id=%s ' "$ARTIFACT_ID"
    IMPORTED=$((IMPORTED + 1))

    # ── verify ──────────────────────────────────────────────────────────────
    GET_RESP="$(curl -s -w '\n%{http_code}' "$BASE_URL/api/artifacts/$ARTIFACT_ID" \
      -H "Authorization: Bearer $TOKEN" 2>/dev/null)"
    GET_STATUS="$(printf '%s' "$GET_RESP" | tail -1)"
    GET_BODY="$(printf '%s' "$GET_RESP" | head -n -1)"

    if [ "$GET_STATUS" != "200" ]; then
      printf 'VERIFY-FAIL (HTTP %s)\n' "$GET_STATUS"
      FAILED=$((FAILED + 1))
      log_json "{\"action\":\"verify_failed\",\"file\":$(json_escape "$FILE"),\"artifact_id\":\"$ARTIFACT_ID\",\"reason\":\"http_$GET_STATUS\"}"
      continue
    fi

    if [ "$KIND" = "binary" ]; then
      STORED_SHA="$(printf '%s' "$GET_BODY" | python3 -c '
import sys, json, base64, hashlib
d = json.load(sys.stdin)
raw = base64.b64decode(d["content"])
print(hashlib.sha256(raw).hexdigest())
' 2>/dev/null || true)"
    else
      STORED_SHA="$(printf '%s' "$GET_BODY" | python3 -c '
import sys, json, hashlib
d = json.load(sys.stdin)
raw = d["content"].encode("utf-8")
print(hashlib.sha256(raw).hexdigest())
' 2>/dev/null || true)"
    fi

    if [ "$STORED_SHA" != "$LOCAL_SHA" ]; then
      printf 'VERIFY-FAIL (sha mismatch: local=%s stored=%s) -- keeping file\n' "$LOCAL_SHA" "$STORED_SHA"
      FAILED=$((FAILED + 1))
      log_json "{\"action\":\"verify_sha_mismatch\",\"file\":$(json_escape "$FILE"),\"artifact_id\":\"$ARTIFACT_ID\",\"local_sha\":\"$LOCAL_SHA\",\"stored_sha\":\"$STORED_SHA\"}"
      continue
    fi

    printf 'verified '
    VERIFIED=$((VERIFIED + 1))

    # ── delete (only after verified) ─────────────────────────────────────────
    if rm -f "$FILE" 2>/dev/null; then
      printf 'deleted\n'
      DELETED=$((DELETED + 1))
      log_json "{\"action\":\"migrated\",\"file\":$(json_escape "$FILE"),\"artifact_id\":\"$ARTIFACT_ID\",\"kind\":\"$KIND\",\"size\":$SIZE,\"sha256\":\"$LOCAL_SHA\"}"
    else
      printf 'DELETE-FAIL (rm failed)\n'
      FAILED=$((FAILED + 1))
      log_json "{\"action\":\"delete_failed\",\"file\":$(json_escape "$FILE"),\"artifact_id\":\"$ARTIFACT_ID\"}"
    fi

  done < <(find "$SCAN_DIR" \
    \( -name '*.html' -o -name '*.htm' -o -name '*.md' -o -name '*.markdown' -o -name '*.json' -o -name '*.txt' \) \
    -type f 2>/dev/null | sort)
done

# ── summary ───────────────────────────────────────────────────────────────────

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\ndry-run complete: %d would be imported, %d skipped\n' "$IMPORTED" "$SKIPPED"
else
  printf '\ndone: %d imported, %d verified, %d deleted, %d skipped, %d failed\n' \
    "$IMPORTED" "$VERIFIED" "$DELETED" "$SKIPPED" "$FAILED"
fi

log_json "{\"action\":\"summary\",\"dry_run\":$DRY_RUN,\"imported\":$IMPORTED,\"verified\":$VERIFIED,\"deleted\":$DELETED,\"skipped\":$SKIPPED,\"failed\":$FAILED,\"log_file\":$(json_escape "$LOG_FILE")}"
printf 'log: %s\n' "$LOG_FILE"

exit 0
