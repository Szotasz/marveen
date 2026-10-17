#!/usr/bin/env bash
# Optional cross-review by ChatGPT and Gemini before pushing a PR.
# Requires OPENAI_API_KEY and/or GEMINI_API_KEY stored in the vault.
# If a key is missing the reviewer is silently skipped.
#
# Usage: ./scripts/pre-pr-review.sh [--worktree] [base-ref]
#   base-ref defaults to upstream/main
#   --worktree reviews the uncommitted working tree instead (`git diff HEAD`:
#     staged and unstaged changes to tracked files; untracked files are not
#     sent). Use it when the change is not committed yet, e.g. a local patch
#     set applied on top of a release: with a base-ref such a tree reviews as
#     "no diff" and exits 0, which looks like a pass.
#
# Environment (all optional):
#   PREPR_OPENAI_MODEL   OpenAI model id            (default gpt-4o)
#   PREPR_GEMINI_MODEL   Gemini model id            (default gemini-2.0-flash)
#   PREPR_REVIEWERS      comma list of reviewers    (default openai,gemini)
#   PREPR_STRICT=1       a reviewer that is enabled but skipped (no key), that
#                        fails, or that answers with empty content makes the
#                        run exit non-zero. Without it a skipped reviewer is
#                        reported and the run still exits 0 (the historical,
#                        optional behaviour).
#
# What leaves this machine is the diff, so the diff is checked first:
#   - no secret in argv or URL: every credential travels in a 0600 header
#     file (`curl -H @file`), every body in a 0600 file (`--data-binary @file`).
#     `ps` and proxy logs see paths, never values.
#   - the diff is scanned BEFORE any network call (vault included), by
#     scripts/pre-pr-review-scan.ts (the gate's secret shapes, hex runs,
#     high-entropy tokens, credential paths) and scripts/secret-gate.ts. A hit,
#     or a scanner that cannot run, aborts the run; findings name file:line,
#     never the matched text. There is no override: a review is optional, a
#     leaked key is not reversible.
#   - a diff above MAX_DIFF_BYTES is refused, not truncated: a cut diff would
#     be reviewed as if it were the whole change.
#   - every request has a connect and a total timeout; a non-2xx answer is
#     reported by status code only, because the body can echo the prompt.

set -euo pipefail

WORKTREE=0
if [ "${1:-}" = "--worktree" ]; then
  WORKTREE=1
  shift
fi
BASE="${1:-upstream/main}"
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_OPENAI="${PREPR_OPENAI_MODEL:-gpt-4o}"
MODEL_GEMINI="${PREPR_GEMINI_MODEL:-gemini-2.0-flash}"
REVIEWERS="${PREPR_REVIEWERS:-openai,gemini}"
STRICT="${PREPR_STRICT:-0}"
TOKEN_FILE="$INSTALL_DIR/store/.dashboard-token"
MAX_DIFF_BYTES=204800
CURL_LIMITS=(--connect-timeout 10 --max-time 120)

if [ ! -f "$TOKEN_FILE" ]; then
  echo "[pre-pr-review] Dashboard token not found, skipping cross-review." >&2
  exit 0
fi

# Everything below that holds a credential, the diff or a request body lives
# in this directory: 0700, files 0600, removed on any exit.
umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pre-pr-review.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Dashboard port: env WEB_PORT, else the install .env, else 3420.
# `|| true`: with pipefail a missing .env would otherwise end the run silently.
WEB_PORT="${WEB_PORT:-$(grep -E '^WEB_PORT=' "$(dirname "$0")/../.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "' || true)}"
WEB_PORT="${WEB_PORT:-3420}"
API="http://localhost:${WEB_PORT}/api/vault"

# Pinned output format: user config (color.ui=always, diff.external,
# textconv, noprefix, relative) must not change what is scanned and sent.
if [ "$WORKTREE" = 1 ]; then
  RANGE_LABEL="the working tree (git diff HEAD)"
  git diff --no-color --no-ext-diff --no-textconv --no-relative \
    --src-prefix=a/ --dst-prefix=b/ HEAD > "$WORK/diff"
else
  RANGE_LABEL="$BASE"
  git diff --no-color --no-ext-diff --no-textconv --no-relative \
    --src-prefix=a/ --dst-prefix=b/ "$BASE"...HEAD > "$WORK/diff"
fi
if [ ! -s "$WORK/diff" ]; then
  echo "[pre-pr-review] No diff found against $RANGE_LABEL, nothing to review."
  exit 0
fi

DIFF_BYTES="$(wc -c < "$WORK/diff" | tr -d ' ')"
if [ "$DIFF_BYTES" -gt "$MAX_DIFF_BYTES" ]; then
  echo "[pre-pr-review] Diff against $RANGE_LABEL is $DIFF_BYTES bytes, above the $MAX_DIFF_BYTES byte limit." >&2
  echo "[pre-pr-review] Refusing to send a truncated diff; nothing was sent. Review a smaller range." >&2
  exit 1
fi

# --- secret filter: runs before ANY request, the vault included ---
# Both passes run on tsx from THIS install (never a bare `npx`, which may
# download it). If either cannot run, nothing is sent: an unscanned diff is
# not a clean diff.
#   1. scripts/pre-pr-review-scan.ts: every line of the diff text that would
#      leave (headers and `@@` lines included), with the gate's own secret
#      shapes plus hex-run, entropy and credential-path rules.
#   2. scripts/secret-gate.ts --range: what CI runs on a PR, on the head tree.
# Findings name file:line and the detector, never the matched text.
TSX="$INSTALL_DIR/node_modules/.bin/tsx"
if [ ! -x "$TSX" ] || [ ! -f "$INSTALL_DIR/scripts/pre-pr-review-scan.ts" ] \
    || [ ! -f "$INSTALL_DIR/scripts/secret-gate.ts" ]; then
  echo "[pre-pr-review] Secret scan not runnable here (no local tsx; run npm ci); nothing was sent." >&2
  exit 1
fi
if ! "$TSX" "$INSTALL_DIR/scripts/pre-pr-review-scan.ts" "$WORK/diff" > "$WORK/scan.out" 2>&1; then
  echo "[pre-pr-review] Possible secret in the diff against $RANGE_LABEL; nothing was sent:" >&2
  sed 's/^/  /' "$WORK/scan.out" >&2
  echo "[pre-pr-review] The matched text is not printed. Remove the value (or the file) and rerun." >&2
  exit 1
fi
# The repo gate knows two modes: --range (committed head tree) and --staged
# (the index). The working tree has no range, so --worktree runs the gate on
# the index and relies on the diff scanner above for the unstaged part: the
# scanner saw every line that leaves.
if [ "$WORKTREE" = 1 ]; then
  GATE_ARGS=(--staged)
  GATE_LABEL="the index (--staged)"
else
  GATE_ARGS=(--range "$BASE...HEAD")
  GATE_LABEL="$BASE...HEAD"
fi
if ! "$TSX" "$INSTALL_DIR/scripts/secret-gate.ts" "${GATE_ARGS[@]}" > "$WORK/gate.out" 2>&1; then
  echo "[pre-pr-review] scripts/secret-gate.ts did not clear $GATE_LABEL; nothing was sent:" >&2
  sed 's/^/  /' "$WORK/gate.out" >&2
  exit 1
fi

# write_header <out-file> <header-name> <prefix> <secret-file>
# Turns a raw secret file (dashboard token) into one header line in a 0600
# file. The value never passes through argv or a shell variable.
write_header() {
  python3 -I - "$@" <<'PY'
import os, sys
out, name, prefix, src = sys.argv[1:5]
val = open(src, encoding='utf-8').read().strip()
if not val or '\r' in val or '\n' in val:
    sys.exit(1)
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as fh:
    fh.write(f'{name}: {prefix}{val}\nContent-Type: application/json\n')
PY
}

# vault_header <secret-id> <out-file> <header-name> <prefix>
# Fetches a vault entry straight into a 0600 file and turns it into a header
# file. Returns non-zero when the entry is missing, empty or unreadable.
vault_header() {
  local id="$1" out="$2" name="$3" prefix="$4" code
  code="$(curl -s "${CURL_LIMITS[@]}" -H @"$WORK/dashboard.hdr" \
    -o "$WORK/vault.json" -w '%{http_code}' "$API/$id" 2>/dev/null)" || code=000
  if [ "$code" != 200 ]; then
    rm -f "$WORK/vault.json"
    return 1
  fi
  python3 -I - "$WORK/vault.json" "$out" "$name" "$prefix" <<'PY' || { rm -f "$WORK/vault.json"; return 1; }
import json, os, sys
src, out, name, prefix = sys.argv[1:5]
try:
    val = str(json.load(open(src, encoding='utf-8')).get('value', '') or '').strip()
except Exception:
    sys.exit(1)
if not val or '\r' in val or '\n' in val:
    sys.exit(1)
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as fh:
    fh.write(f'{name}: {prefix}{val}\nContent-Type: application/json\n')
PY
  rm -f "$WORK/vault.json"
}

# Request bodies: built by python from the diff file, written to 0600 files.
# `max_completion_tokens` replaces the deprecated `max_tokens`: the newer
# reasoning models reject the old name, and the new one counts reasoning
# tokens too, so the cap means the same thing on every model.
python3 -I - "$WORK/diff" "$WORK/openai.json" "$WORK/gemini.json" "$MODEL_OPENAI" <<'PY'
import json, os, sys
diff_path, openai_out, gemini_out, model_openai = sys.argv[1:5]
diff = open(diff_path, encoding='utf-8', errors='replace').read()
prompt = ('You are a senior software engineer reviewing a pull request. Review the following git diff '
          'for correctness, security, and code quality. Be concise and specific. List any real issues found.'
          f'\n\nDiff:\n```\n{diff}\n```')
for path, body in ((openai_out, {'model': model_openai, 'messages': [{'role': 'user', 'content': prompt}], 'max_completion_tokens': 1000}),
                   (gemini_out, {'contents': [{'parts': [{'text': prompt}]}]})):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        json.dump(body, fh)
PY

# review <label> <url> <header-file> <body-file> <python-extract-expr>
# Prints the review text; on failure prints the status only and returns 1.
review() {
  local label="$1" url="$2" hdr="$3" body="$4" expr="$5" code rc=0
  code="$(curl -s "${CURL_LIMITS[@]}" -H @"$hdr" --data-binary @"$body" \
    -o "$WORK/resp.json" -w '%{http_code}' "$url" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[pre-pr-review] $label request failed (curl exit $rc: network error or timeout)." >&2
    return 1
  fi
  case "$code" in
    2??) ;;
    *) echo "[pre-pr-review] $label request failed: HTTP $code (response body not shown)." >&2
       return 1 ;;
  esac
  # Control characters (ESC, CR, C1) are stripped: the reply is untrusted text
  # and must not drive the terminal. Newline and tab stay. An empty or null
  # content is a failure, not a review: `str(None)` would otherwise print the
  # word None and the run would look green.
  python3 -I -c "import json,re,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); v=$expr; t='' if v is None else str(v); sys.exit(3) if not t.strip() else print(re.sub(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]', '', t))" \
      "$WORK/resp.json" 2>/dev/null
  local prc=$?
  if [ "$prc" -eq 3 ]; then
    echo "[pre-pr-review] $label answered HTTP $code with empty content (no review text)." >&2
    return 1
  elif [ "$prc" -ne 0 ]; then
    echo "[pre-pr-review] $label answered HTTP $code with an unexpected shape (response body not shown)." >&2
    return 1
  fi
}

# wants <reviewer>: is the reviewer on the PREPR_REVIEWERS list?
wants() {
  case ",$REVIEWERS," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# skipped <label> <reason>: a reviewer that did not run. Under PREPR_STRICT=1
# this is a failure (a mandatory gate that silently skips is not a gate).
skipped() {
  echo "[pre-pr-review] $1 review skipped: $2"
  if [ "$STRICT" = 1 ]; then
    FAILED=1
  fi
}

if ! write_header "$WORK/dashboard.hdr" Authorization 'Bearer ' "$TOKEN_FILE"; then
  echo "[pre-pr-review] Dashboard token is empty or malformed, skipping cross-review." >&2
  exit 0
fi

FAILED=0

# --- ChatGPT ---
if ! wants openai; then
  echo "[pre-pr-review] ChatGPT review disabled by PREPR_REVIEWERS."
elif vault_header OPENAI_API_KEY "$WORK/openai.hdr" Authorization 'Bearer '; then
  echo ""
  echo "=== ChatGPT Review ==="
  echo "[pre-pr-review] model: $MODEL_OPENAI"
  review ChatGPT https://api.openai.com/v1/chat/completions \
    "$WORK/openai.hdr" "$WORK/openai.json" "d['choices'][0]['message']['content']" || FAILED=1
  rm -f "$WORK/openai.hdr"
else
  skipped ChatGPT "OPENAI_API_KEY not set in vault."
fi

# --- Gemini ---
if ! wants gemini; then
  echo "[pre-pr-review] Gemini review disabled by PREPR_REVIEWERS."
elif vault_header GEMINI_API_KEY "$WORK/gemini.hdr" x-goog-api-key ''; then
  echo ""
  echo "=== Gemini Review ==="
  echo "[pre-pr-review] model: $MODEL_GEMINI"
  review Gemini "https://generativelanguage.googleapis.com/v1beta/models/${MODEL_GEMINI}:generateContent" \
    "$WORK/gemini.hdr" "$WORK/gemini.json" "d['candidates'][0]['content']['parts'][0]['text']" || FAILED=1
  rm -f "$WORK/gemini.hdr"
else
  skipped Gemini "GEMINI_API_KEY not set in vault."
fi

exit "$FAILED"
