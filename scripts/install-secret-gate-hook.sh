#!/usr/bin/env bash
# EVIDGUARD818 -- idempotent installer: run the secret gate before every commit.
# Auto-run by scripts/sync-hooks.sh on update, same as install-git-guard-hook.sh.
#
# THIS HOOK IS THE FAST LANE, NOT THE GATE. It is skippable with
# `git commit --no-verify`, so the authoritative check is the CI job on the PR
# (.github/workflows/secret-gate.yml). Both call the same scanner.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# `rev-parse --git-common-dir` answers RELATIVE TO THE REPO (".git"), so the
# `git -C "$ROOT"` above only looks safe: resolving that answer with a bare `cd`
# resolves it against the CALLER's cwd. Measured: started from another checkout
# this installer wrote the secret gate into THAT repository and printed its
# success line, leaving this repo unprotected -- silent non-enforcement, which
# is the one failure a guard must not have.
GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --git-common-dir)"
case "$GIT_COMMON_DIR" in /*) ;; *) GIT_COMMON_DIR="$ROOT/$GIT_COMMON_DIR" ;; esac
HOOK_DIR="$(cd "$GIT_COMMON_DIR" && pwd)/hooks"
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

# -- The personal-data leg: a pre-push.d member, not a second gate -----------
# Same runner (scripts/secret-gate.ts --pushed), same dispatcher family as the
# force-push guard. It runs on what git is about to TRANSMIT, so it sees every
# spelling of a push (git -C x push, a script, an alias), not just the literal
# command line. There is deliberately NO environment override: an agent that can
# export a variable could switch the gate off. `git push --no-verify` is git's
# own switch and is denied to agents by the destructive-gate hook.
PUSH_DISPATCH="$HOOK_DIR/pre-push"
PUSH_MARK="marveen-pre-push-dispatcher"
PUSH_GUARD="$HOOK_DIR/pre-push.d/15-personal-data-gate"
mkdir -p "$HOOK_DIR/pre-push.d"

# The gate's code is resolved against the INSTALL root, not the checkout being
# pushed from: hooks are shared by every worktree, and an old branch that does not
# contain the script must not turn every push into a "module not found" block.
cat > "$PUSH_GUARD" <<EOF
#!/usr/bin/env bash
# PIIGATE: block a push whose added lines or commit messages carry personal data
# (e-mail, home-directory path, phone, IBAN, HU account/tax number, local denylist).
# Fail-closed: if the check cannot run, the push does not go.
set -euo pipefail
GATE_ROOT="$ROOT"
TSX="\$GATE_ROOT/node_modules/.bin/tsx"
RUNNER="\$GATE_ROOT/scripts/secret-gate.ts"
if [ ! -x "\$TSX" ] || [ ! -f "\$RUNNER" ]; then
  echo "pre-push: the personal-data gate cannot run (\$TSX or \$RUNNER missing) -- BLOCKING (fail-closed)." >&2
  echo "Reinstall: bash \$GATE_ROOT/scripts/install-secret-gate-hook.sh" >&2
  exit 1
fi
exec "\$TSX" "\$RUNNER" --pushed "\$@"
EOF
chmod +x "$PUSH_GUARD"

# Record a pre-push.d member in pre-push.required: its name and the sha256 of the bytes just
# written. The dispatcher refuses to run if a listed member is missing or no longer matches.
register_pre_push_member() {
  local name="$1" file="$2" sum
  sum="$( (sha256sum "$file" 2>/dev/null || shasum -a 256 "$file") | cut -d' ' -f1)"
  touch "$HOOK_DIR/pre-push.required"
  grep -v "^${name} " "$HOOK_DIR/pre-push.required" > "$HOOK_DIR/pre-push.required.tmp" 2>/dev/null || true
  printf '%s %s\n' "$name" "$sum" >> "$HOOK_DIR/pre-push.required.tmp"
  mv "$HOOK_DIR/pre-push.required.tmp" "$HOOK_DIR/pre-push.required"
}
register_pre_push_member "15-personal-data-gate" "$PUSH_GUARD"

# The dispatcher may not exist yet (install order is alphabetical: git-guard
# normally runs first). Write the identical one rather than depend on that, and rewrite it
# every time: it is generated, and an older copy must pick up the "a member that cannot run
# is an error, not a skip" rule.
if true; then
  if [ -f "$PUSH_DISPATCH" ] && ! grep -q "$PUSH_MARK" "$PUSH_DISPATCH" 2>/dev/null; then
    mv "$PUSH_DISPATCH" "$HOOK_DIR/pre-push.d/00-existing-prepush"
    chmod +x "$HOOK_DIR/pre-push.d/00-existing-prepush"
    echo "  (preserved existing pre-push as pre-push.d/00-existing-prepush)"
  fi
  cat > "$PUSH_DISPATCH" <<EOF
#!/usr/bin/env bash
# $PUSH_MARK : run every executable in pre-push.d/, passing the ref list to each.
set -euo pipefail
HOOK_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
payload="\$(cat)"
status=0
# The members that MUST be there (pre-push.required, one name per line, written by the
# installers). A required member that is missing is as off as one that cannot run: deleting a
# gate file must not make the dispatcher quietly run fewer checks.
REQ="\$HOOK_DIR/pre-push.required"
if [ -f "\$REQ" ]; then
  while read -r req want; do
    [ -n "\$req" ] || continue
    if [ ! -e "\$HOOK_DIR/pre-push.d/\$req" ]; then
      echo "pre-push: required member \$req is missing -- BLOCKING (a gate that was installed and is gone is a gate that is off)." >&2
      status=1
      continue
    fi
    # The recorded sha256 of the member as the installer wrote it: a member whose BYTES changed
    # (replaced by "exit 0", edited by a script) is as off as one that is gone. Reinstalling
    # re-records it.
    if [ -n "\$want" ]; then
      if command -v sha256sum >/dev/null 2>&1; then have="\$(sha256sum "\$HOOK_DIR/pre-push.d/\$req" | cut -d' ' -f1)"
      elif command -v shasum >/dev/null 2>&1; then have="\$(shasum -a 256 "\$HOOK_DIR/pre-push.d/\$req" | cut -d' ' -f1)"
      else have="none"; fi
      if [ "\$have" != "\$want" ]; then
        echo "pre-push: required member \$req does not match its recorded hash (\$have) -- BLOCKING (changed since install; reinstall to re-record)." >&2
        status=1
      fi
    fi
  done < "\$REQ"
fi
for h in "\$HOOK_DIR"/pre-push.d/*; do
  [ -e "\$h" ] || continue
  # A member that is present but not executable is a gate that is OFF. Skipping it silently
  # (the old behaviour) made \`chmod -x\` a one-command way to disable any push check.
  if [ ! -x "\$h" ]; then
    echo "pre-push: \$h is not executable -- BLOCKING (a hook that cannot run is a gate that is off)." >&2
    status=1
    continue
  fi
  printf '%s\n' "\$payload" | "\$h" "\$@" || status=1
done
exit \$status
EOF
  chmod +x "$PUSH_DISPATCH"
fi

echo "  personal-data pre-push gate installed (no env override; names need a local hooks/pii-denylist.txt)"
