#!/usr/bin/env bash
# Idempotent installer (card ee1a22f1): pre-push gate "outgoing code needs a reviewer-green trace".
# Auto-run by scripts/sync-hooks.sh on update, same as install-git-guard-hook.sh. The hook's
# contract, the trace format and the bypass are documented at the top of
# scripts/git-hooks/pre-push-review-gate.py and in docs/security-hardening.md.
#
# THIS HOOK GUARDS AGAINST FORGETTING, NOT AGAINST A DELIBERATE BYPASS: it is skipped by
# `git push --no-verify`, and its trace (a mailbox row from the reviewer agent) is self-declared.
#
# OPT-IN: the hook is installed everywhere sync-hooks.sh runs, but it does nothing until
# REVIEW_GATE_REVIEWER (environment or <root>/.env) names the reviewer agent.
# UNDO: remove .git/hooks/pre-push.d/30-review-gate (there is no uninstaller; re-running this
# script puts it back).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# `rev-parse --git-common-dir` answers RELATIVE TO THE REPO (".git"); resolving it with a bare
# `cd` resolves it against the CALLER's cwd (measured on the sibling installers, see
# src/__tests__/hook-installer-cwd-independence.test.ts). Anchor it to $ROOT.
GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --git-common-dir)"
case "$GIT_COMMON_DIR" in /*) ;; *) GIT_COMMON_DIR="$ROOT/$GIT_COMMON_DIR" ;; esac
HOOK_DIR="$(cd "$GIT_COMMON_DIR" && pwd)/hooks"
DISPATCH="$HOOK_DIR/pre-push"
GUARD="$HOOK_DIR/pre-push.d/30-review-gate"
SRC="$ROOT/scripts/git-hooks/pre-push-review-gate.py"
MARK="marveen-pre-push-dispatcher"

# core.hooksPath pointing anywhere but $HOOK_DIR means git never runs the hook we are about to
# write: the installer would print a success line and the gate would enforce nothing (measured in
# review). The one failure an enforcement gate must not have is silent non-enforcement, so refuse.
HOOKS_PATH="$(git -C "$ROOT" config --get core.hooksPath || true)"
if [ -n "$HOOKS_PATH" ]; then
  case "$HOOKS_PATH" in /*) ;; *) HOOKS_PATH="$(git -C "$ROOT" rev-parse --show-toplevel)/$HOOKS_PATH" ;; esac
  RESOLVED="$(cd "$HOOKS_PATH" 2>/dev/null && pwd -P || true)"
  WANT="$(cd "$HOOK_DIR" 2>/dev/null && pwd -P || true)"
  if [ -z "$RESOLVED" ] || [ "$RESOLVED" != "$WANT" ]; then
    echo "install-review-gate-hook: core.hooksPath is set to '$(git -C "$ROOT" config --get core.hooksPath)', so git does not run $HOOK_DIR -- the gate would enforce NOTHING. NOT installed. Unset core.hooksPath or install the hook into that directory." >&2
    exit 1
  fi
fi

[ -f "$SRC" ] || { echo "install-review-gate-hook: $SRC missing" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "install-review-gate-hook: python3 not found, the gate cannot run -- NOT installed" >&2; exit 1; }

# The dispatcher is the git-guard installer's job; run it when it is not there yet, then verify.
if ! grep -q "$MARK" "$DISPATCH" 2>/dev/null; then
  bash "$ROOT/scripts/install-git-guard-hook.sh" >/dev/null
fi
grep -q "$MARK" "$DISPATCH" 2>/dev/null || { echo "install-review-gate-hook: no pre-push dispatcher at $DISPATCH after install-git-guard-hook.sh -- the gate would never run" >&2; exit 1; }

mkdir -p "$HOOK_DIR/pre-push.d"
cp "$SRC" "$GUARD"
chmod +x "$GUARD"

# Migration: this gate shipped first as pre-push.d/30-sam-green-gate (reviewer id and env names fixed
# to one fleet). Left in place it would keep running next to the new one with the old env names, so it
# is removed -- but only when it is recognisably ours (its docstring), never an unrelated file.
LEGACY="$HOOK_DIR/pre-push.d/30-sam-green-gate"
if [ -f "$LEGACY" ] && grep -q "pre-push gate: outgoing code needs a" "$LEGACY" 2>/dev/null; then
  rm -f "$LEGACY"
  echo "  (removed the first-generation hook $LEGACY; the config names changed to REVIEW_GATE_*)"
fi

echo "✓ reviewer-green gate installed: INACTIVE until REVIEW_GATE_REVIEWER names the reviewer agent (environment or $ROOT/.env). Once active, outgoing agent code needs a '<TRACE WORD> <sha>' line from it (guards against forgetting; bypass: REVIEW_GATE_SKIP=1 + REVIEW_GATE_SKIP_REASON, logged; undo: remove $GUARD)."
