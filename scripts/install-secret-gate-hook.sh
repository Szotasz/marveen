#!/usr/bin/env bash
# EVIDGUARD818 -- idempotent installer: run the secret gate before every commit.
# Auto-run by scripts/sync-hooks.sh on update, same as install-git-guard-hook.sh.
#
# THIS HOOK IS THE FAST LANE, NOT THE GATE. It is skippable with
# `git commit --no-verify`, so the authoritative check is the CI job on the PR
# (.github/workflows/secret-gate.yml). Both call the same scanner.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)" && pwd)/hooks"
DISPATCH="$HOOK_DIR/pre-commit"
GUARD="$HOOK_DIR/pre-commit.d/10-secret-gate"
MARK="marveen-pre-commit-dispatcher"
mkdir -p "$HOOK_DIR/pre-commit.d"

# 1. The sub-hook: scan what is staged.
cat > "$GUARD" <<'EOF'
#!/usr/bin/env bash
# EVIDGUARD818: block a commit that stages an evidence/artifact path, a known
# secret shape, or quoted channel material. Override (CI still checks):
#   SKIP_SECRET_GATE=1 git commit ...
set -euo pipefail
[ "${SKIP_SECRET_GATE:-0}" = "1" ] && { echo "pre-commit: SKIP_SECRET_GATE=1 -- the CI job still runs." >&2; exit 0; }
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
if ! command -v npx >/dev/null 2>&1; then
  echo "pre-commit: npx not found, cannot run the secret gate -- BLOCKING (fail-closed)." >&2
  echo "Install Node, or bypass knowingly with SKIP_SECRET_GATE=1 (the CI job will still catch it)." >&2
  exit 1
fi
npx --no-install tsx scripts/secret-gate.ts --staged
EOF
chmod +x "$GUARD"

# 2. Dispatcher: run every executable in pre-commit.d/ (mirrors the pre-push one).
if [ -f "$DISPATCH" ] && ! grep -q "$MARK" "$DISPATCH" 2>/dev/null; then
  mv "$DISPATCH" "$HOOK_DIR/pre-commit.d/00-existing-precommit"
  chmod +x "$HOOK_DIR/pre-commit.d/00-existing-precommit"
  echo "  (preserved existing pre-commit as pre-commit.d/00-existing-precommit)"
fi
cat > "$DISPATCH" <<EOF
#!/usr/bin/env bash
# $MARK : run every executable in pre-commit.d/.
set -euo pipefail
HOOK_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
status=0
for h in "\$HOOK_DIR"/pre-commit.d/*; do
  [ -x "\$h" ] || continue
  "\$h" "\$@" || status=1
done
exit \$status
EOF
chmod +x "$DISPATCH"

echo "  secret gate pre-commit hook installed (bypass: SKIP_SECRET_GATE=1; the CI job is the real gate)"
