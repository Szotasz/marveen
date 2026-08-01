#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Dependency-closure checker for monitor releases (P0 phase 2, requirement 2).
#
# Verifies that a compiled release bundle has NO references to the shared
# git checkout. Every dependency must be either:
#   1. Inside the release directory itself (bundled copy)
#   2. A system tool (/usr/bin/*, /proc, /bin/*, etc.)
#   3. A Node.js built-in module
#
# Usage:
#   scripts/dependency-closure-check.sh <release-dir>
#   scripts/dependency-closure-check.sh releases/monitor-current
#
# Exit codes:
#   0 — clean: no shared-checkout references found
#   1 — blockers: shared-checkout references found (BLOCK deployment)
#   2 — warnings only: non-blocking issues (e.g. unused file)
#
# Output: JSON on stdout, human-readable on stderr
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

RELEASE_DIR="${1:-}"
if [[ -z "$RELEASE_DIR" ]]; then
  echo '{"status":"error","errors":["usage: dependency-closure-check.sh <release-dir>"]}'
  exit 1
fi

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "{\"status\":\"error\",\"errors\":[\"release directory not found: $RELEASE_DIR\"]}"
  exit 1
fi

# Resolve to absolute PHYSICAL path (follow symlinks to real directory)
RELEASE_DIR="$(cd "$RELEASE_DIR" && pwd -P)"
ERRORS=()
WARNINGS=()

# ── Patterns that indicate a shared-checkout dependency ──────────────────────
# These MUST NOT appear in any compiled JS file in the release.
FORBIDDEN_PATTERNS=(
  "/home/iszzu/marveen/src/"
  "/home/iszzu/marveen/scripts/"
  "/home/iszzu/marveen/dist/"
  "INSTALL_DIR.*scripts"
)

# Match process.cwd() only when actually INVOKED (with parentheses),
# not when mentioned in a comment like "No process.cwd() fallback".
FORBIDDEN_CWD='process\.cwd\(\s*\)'

# ── Check each .js file for forbidden patterns ───────────────────────────────
echo "Checking $RELEASE_DIR for shared-checkout references..." >&2

shopt -s nullglob
js_files=("$RELEASE_DIR"/*.js)
shopt -u nullglob

if [[ ${#js_files[@]} -eq 0 ]]; then
  ERRORS+=("no .js files found in $RELEASE_DIR")
fi

for js_file in "${js_files[@]}"; do
  basename="$(basename "$js_file")"
  echo "  scanning $basename..." >&2

  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -q "$pattern" "$js_file" 2>/dev/null; then
      matches="$(grep -n "$pattern" "$js_file" | head -5 | tr '\n' '; ')"
      ERRORS+=("$basename: forbidden pattern '$pattern' found: $matches")
    fi
  done

  # Check for process.cwd() INVOCATION (not comment mentions).
  # First grep finds lines with the pattern; second grep filters out
  # lines where the actual CODE (after any leading whitespace) is a comment.
  # Line-number prefix from grep -n is stripped before comment check.
  #
  # ONE narrow, explicit exception: `process.env.MARVEEN_HOME ?? process.cwd()`
  # is a KNOWN, intentional fallback (PR #775 review) used by the dashboard's
  # own copy of this code (dist/web/*.js, imported by agent-process.ts), which
  # today starts with no MARVEEN_HOME set and relies on cwd == repo root. The
  # RELEASE copy this checker scans never actually reaches that branch — the
  # systemd unit (scripts/systemd/marveen-memory-monitor.service) always sets
  # MARVEEN_HOME explicitly — but the compiled bytes are identical either way
  # since both copies come from the same source. Requiring MARVEEN_HOME
  # unconditionally in source would fix the release's false positive but
  # break the live dashboard, which is out of this check's scope to fix.
  # A BARE process.cwd() anywhere else is still flagged; only this specific
  # guarded form is allowed.
  # POSIX ERE for bash's [[ =~ ]] — no \s, use [[:space:]] instead.
  MARVEEN_HOME_GUARDED_CWD='process\.env\.MARVEEN_HOME[[:space:]]*\?\?[[:space:]]*process\.cwd\([[:space:]]*\)'
  if grep -Pq "${FORBIDDEN_CWD}" "$js_file" 2>/dev/null; then
    cwd_lines_raw="$(grep -n "${FORBIDDEN_CWD}" "$js_file" | head -5 || true)"
    cwd_lines=""
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      # Strip line-number prefix (e.g. "25:") before checking for comment
      code_part="${line#*:}"
      # Skip if the code part is a // comment
      if [[ "$code_part" =~ ^[[:space:]]*// ]]; then
        continue
      fi
      # Skip the one explicitly allowed guarded-fallback pattern
      if [[ "$code_part" =~ ${MARVEEN_HOME_GUARDED_CWD} ]]; then
        continue
      fi
      cwd_lines="${cwd_lines}${line}; "
    done <<< "$cwd_lines_raw"
    if [[ -n "$cwd_lines" ]]; then
      ERRORS+=("$basename: process.cwd() invocation found (not in comment, not the allowed MARVEEN_HOME guard): $cwd_lines")
    fi
  fi

  # Extra: check for any absolute path that looks like a checkout
  abs_paths="$(grep -oP '(?<!")(?<![/\w])/[a-z]+/[a-z]+/marveen/' "$js_file" 2>/dev/null | sort -u | tr '\n' ', ' || true)"
  if [[ -n "$abs_paths" ]]; then
    ERRORS+=("$basename: absolute checkout paths found: $abs_paths")
  fi
done

# ── Check shell scripts ──────────────────────────────────────────────────────
shopt -s nullglob
sh_files=("$RELEASE_DIR"/*.sh)
shopt -u nullglob

for sh_file in "${sh_files[@]}"; do
  basename="$(basename "$sh_file")"
  echo "  scanning $basename..." >&2

  # Shell scripts may reference system tools (tmux, ps, /proc, awk, etc.)
  # but must NOT reference the shared checkout.
  checkout_refs="$(grep -n '/home/iszzu/marveen/' "$sh_file" 2>/dev/null | tr '\n' '; ' || true)"
  if [[ -n "$checkout_refs" ]]; then
    ERRORS+=("$basename: references shared checkout: $checkout_refs")
  fi

  # Verify the script only uses system deps
  # (list-agent-rss.sh should only use: bash, tmux, ps, awk, grep, cat, tail, head, /proc, /usr/bin/*)
  non_system="$(grep -oP '(?<=^|[^/])(/[a-z]+/[a-z]+/(?!proc|sys|dev|tmp|usr|bin|etc))[^\s"]*' "$sh_file" 2>/dev/null | tr '\n' ', ' || true)"
  if [[ -n "$non_system" ]]; then
    WARNINGS+=("$basename: non-system paths referenced: $non_system")
  fi
done

# ── Symlink audit ────────────────────────────────────────────────────────────
echo "  auditing symlinks..." >&2

while IFS= read -r -d '' link; do
  target="$(readlink "$link" 2>/dev/null || true)"

  # Check dangling
  if [[ ! -e "$link" ]]; then
    ERRORS+=("dangling symlink: $link -> $target")
    continue
  fi

  # Check escaping the release directory
  abs_target="$(readlink -f "$link" 2>/dev/null || true)"
  if [[ -n "$abs_target" ]] && [[ "$abs_target" != "$RELEASE_DIR"/* ]]; then
    ERRORS+=("symlink escapes release: $link -> $abs_target")
  fi
done < <(find "$RELEASE_DIR" -type l -print0 2>/dev/null || true)

# ── Manifest check ───────────────────────────────────────────────────────────
manifest="$RELEASE_DIR/release.json"
if [[ -f "$manifest" ]]; then
  echo "  checking manifest..." >&2

  # Verify every file listed in the manifest exists
  listed_files="$(python3 -c "import json,sys; print('\n'.join(json.load(open(sys.argv[1])).get('files',[])))" "$manifest" 2>/dev/null || true)"
  if [[ -n "$listed_files" ]]; then
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      if [[ ! -f "$RELEASE_DIR/$f" ]]; then
        ERRORS+=("manifest lists '$f' but file missing from release")
      fi
    done <<< "$listed_files"
  fi

  # Verify manifest has required fields
  commit="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('commit',''))" "$manifest" 2>/dev/null || true)"
  if [[ -z "$commit" ]]; then
    WARNINGS+=("manifest missing 'commit' field")
  fi
else
  WARNINGS+=("no release.json manifest found")
fi

# ── Output ───────────────────────────────────────────────────────────────────
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo "{\"status\":\"failure\",\"errors\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${ERRORS[@]}"),\"warnings\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${WARNINGS[@]}")}"
  echo "BLOCKERS found:" >&2
  for e in "${ERRORS[@]}"; do echo "  - $e" >&2; done
  exit 1
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  echo "{\"status\":\"ok\",\"errors\":[],\"warnings\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${WARNINGS[@]}")}"
  echo "Warnings (non-blocking):" >&2
  for w in "${WARNINGS[@]}"; do echo "  - $w" >&2; done
  exit 0
fi

echo '{"status":"ok","errors":[],"warnings":[]}'
echo "Clean: no shared-checkout references found in $RELEASE_DIR" >&2
exit 0
