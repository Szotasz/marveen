#!/usr/bin/env bash
# css-guard.sh — Design System token hygiene check
#
# Checks:
#   1. No raw hex values in web/css/components/ files
#   2. All var(--token) refs in components resolve to tokens.css
#   3. No standalone base component class defined in web/style.css (features layer)
#
# Exit 0 on success, 1 on any failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPONENTS_DIR="$REPO_ROOT/web/css/components"
TOKENS_FILE="$REPO_ROOT/web/css/tokens.css"
FEATURES_FILE="$REPO_ROOT/web/style.css"

fail=0

# ── Check 1: No raw hex in component CSS ─────────────────────────────────────
echo "==> Check 1: no raw hex in web/css/components/"
hex_hits=$(grep -rEn "#[0-9a-fA-F]{3,8}\b" "$COMPONENTS_DIR" 2>/dev/null || true)
if [[ -n "$hex_hits" ]]; then
  echo "FAIL:"
  echo "$hex_hits"
  fail=1
else
  echo "  OK"
fi

# ── Check 2: No undefined token refs in component files ──────────────────────
echo "==> Check 2: all var(--token) in components resolve to tokens.css"
used=$(grep -hEo 'var\(--[a-zA-Z0-9_-]+' "$COMPONENTS_DIR"/*.css 2>/dev/null \
  | sed 's/var(--//' \
  | grep -v '^_' \
  | sort -u)
defined=$(grep -Eo '^\s*--[a-zA-Z0-9_-]+\s*:' "$TOKENS_FILE" \
  | sed 's/[[:space:]]*://; s/^[[:space:]]*//; s/^--//' \
  | sort -u)
undefined=$(comm -23 <(printf '%s\n' $used) <(printf '%s\n' $defined))
if [[ -n "$undefined" ]]; then
  echo "FAIL: tokens used in components but not defined in tokens.css:"
  echo "$undefined"
  fail=1
else
  echo "  OK"
fi

# ── Check 3: No standalone base component class in style.css ─────────────────
echo "==> Check 3: no standalone component-base rule in web/style.css"
component_pattern="btn|badge|chip|card|modal|field|table|empty|toast|tooltip"
scope_violations=$(grep -En "^\.(${component_pattern})[[:space:]]*\{" "$FEATURES_FILE" || true)
if [[ -n "$scope_violations" ]]; then
  echo "FAIL: standalone component class found in features layer:"
  echo "$scope_violations"
  fail=1
else
  echo "  OK"
fi

exit $fail
