#!/usr/bin/env bash
# COMMITID927 -- idempotent installer: refuse a commit whose AUTHOR or COMMITTER
# is not this install's bot identity. Auto-run by scripts/sync-hooks.sh.
#
# WHY THIS EXISTS, and why a documentation fix was not enough (measured
# 2026-09-27): sixteen commits went to seven public PRs carrying the operator's
# personal e-mail address, and four more carried a THIRD PARTY's account. None of
# it came from a broken config -- it came from FOLLOWING THE WRITTEN PROCEDURE:
# the commit-push skill prescribed `git -c user.email=<personal address>` on the
# command line. The text was the contaminant. Both copies are fixed now, but a
# text fix only holds while everyone reads the current text; this hook holds
# regardless.
#
# WHAT IT CAN SEE, measured in an isolated repo on all four override forms:
#   config only ................ git var reports the config identity
#   git -c user.email=x ........ git var reports x
#   GIT_AUTHOR_EMAIL=x ......... git var reports x for the AUTHOR, config for the committer
#   git commit --author="x" .... git var reports x for the AUTHOR, config for the committer
# So `git var GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT` in a pre-commit hook sees
# EVERY form, including `--author=`, which the config alone would miss. That is
# why the gate reads git var and not the config, and why it checks BOTH fields:
# in the last two forms the two identities diverge, and today both were dirty.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The identity every commit in this install must carry. THERE IS NO DEFAULT, and
# that is deliberate: this file goes upstream, so a baked-in default would be OUR
# bot, and another install would silently be told to expect an identity that is
# not theirs. The failure would then look like a broken gate rather than a
# missing setting. Resolution order:
#   1. MARVEEN_BOT_EMAIL in the environment
#   2. MARVEEN_BOT_EMAIL= in the install's .env
#   3. nothing -> SKIP quietly (one line, exit 0), below: sync-hooks.sh runs every
#      install-*-hook.sh on each update, so an install that never opted in to this gate
#      must not get an error block and a non-zero exit every time. A value that IS set
#      but is not an address stays a loud refusal (the shape check): that is someone
#      configuring the gate and getting it wrong.
#
# AND NOT FROM THE REPO CONFIG, which is the one trap this gate has: `user.email`
# is exactly what `git -c user.email=` overrides, so a gate that read its expected
# value from there would compare the config with itself and ALWAYS pass. The
# expected identity has to come from outside the thing being checked.
BOT_EMAIL="${MARVEEN_BOT_EMAIL:-}"
if [ -z "$BOT_EMAIL" ] && [ -f "$ROOT/.env" ]; then
  # Same shapes the product's readEnvFile accepts: the key is what precedes the
  # first `=`, trimmed, so a leading `export ` does NOT match -- measured against
  # src/env.ts on 2026-09-27.
  # The product trims the WHOLE LINE before splitting on `=`, so a CRLF file loses its
  # \r there. This reader has to do the same explicitly: measured 2026-09-27 against the
  # compiled dist/env.js on 13 .env shapes, and the CRLF line ending was the ONE that
  # diverged -- the product returned `addr`, this returned `addr\r`, which would be baked
  # into the gate and then block EVERY commit with a message that looks like a wrong
  # identity rather than a stray byte. This machine is WSL, so CRLF files are not
  # hypothetical.
  # The CR is put into the pattern via printf rather than written as `\r`: in POSIX BRE
  # `\r` is undefined and some seds read it as a literal `r`, which would chop a trailing
  # r off a real address. And `[[:space:]]` covers CR here but that is locale-dependent,
  # so it is not relied on alone.
  CR="$(printf '\r')"
  BOT_EMAIL="$(sed -n 's/^[[:space:]]*MARVEEN_BOT_EMAIL[[:space:]]*=[[:space:]]*//p' "$ROOT/.env" | tail -1 | sed "s/${CR}*\$//" | sed 's/[[:space:]]*$//; s/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//')"
fi
if [ -z "$BOT_EMAIL" ]; then
  # Not configured means not opted in: say so in one line and leave the hooks as they are.
  echo "install-commit-identity-hook: skipped (MARVEEN_BOT_EMAIL not set; set it in .env to enable the gate)"
  exit 0
fi

# THE RESIDUAL HOLE OF A BAKED VALUE, and the one Sam's shape-check idea points at:
# install this with a PERSONAL address and the gate will faithfully DEMAND that personal
# address on every commit -- the incident class, re-entered through the installer, with
# the gate reporting success. So the value gets checked here, where it is chosen.
#
# It WARNS and does not refuse, deliberately. A hard requirement of
# `users.noreply.github.com` would be a guess about other fleets: a bot with a real
# mailbox, a GitHub Enterprise host or a non-GitHub remote are all legitimate, and this
# file goes upstream. Refusing them would make the gate un-installable for reasons we
# cannot measure from here. What is NOT a guess is that a no-reply form is the only one
# that cannot be a human's mailbox -- so the mismatch is worth saying out loud, once, at
# the moment someone can still fix it.
case "$BOT_EMAIL" in
  *@*) ;;
  *) echo "install-commit-identity-hook: NOT INSTALLED -- '$BOT_EMAIL' is not an e-mail address." >&2
     exit 1 ;;
esac
case "$BOT_EMAIL" in
  *.noreply.github.com) ;;
  *) echo "install-commit-identity-hook: WARNING -- the identity being baked in is" >&2
     echo "    $BOT_EMAIL" >&2
     echo "  which is not a no-reply form. Every commit in this install will be REQUIRED to" >&2
     echo "  carry it, and the gate will then report a personal address as correct. If that" >&2
     echo "  address belongs to a person, this gate is now enforcing the very thing it exists" >&2
     echo "  to prevent. Re-run with the bot's noreply address if that was not intended." >&2
     echo "  Installing anyway: a real bot mailbox or a non-GitHub host is legitimate, and" >&2
     echo "  this script cannot tell those apart from a mistake." >&2 ;;
esac
# `rev-parse --git-common-dir` answers RELATIVE TO THE REPO (".git"), so the
# `git -C "$ROOT"` below only looks safe: resolving that answer with a bare `cd`
# resolves it against the CALLER's cwd. The secret-gate installer carries the
# same warning from a measured incident -- started from another checkout it
# wrote its guard into THAT repository and reported success, leaving this one
# unprotected. Silent non-enforcement is the one failure a guard must not have.
GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --git-common-dir)"
case "$GIT_COMMON_DIR" in /*) ;; *) GIT_COMMON_DIR="$ROOT/$GIT_COMMON_DIR" ;; esac
HOOK_DIR="$(cd "$GIT_COMMON_DIR" && pwd)/hooks"
DISPATCH="$HOOK_DIR/pre-commit"
GUARD="$HOOK_DIR/pre-commit.d/15-commit-identity"
MARK="marveen-pre-commit-dispatcher"
mkdir -p "$HOOK_DIR/pre-commit.d"

# 1. The sub-hook. 15- so it runs after the prod-tree guard (05) and the secret
#    gate (10): a wrong identity matters least of the three, and the louder
#    blocks should speak first.
cat > "$GUARD" <<HOOKEOF
#!/usr/bin/env bash
# marveen-commit-identity-gate (COMMITID927): refuse a commit whose AUTHOR or
# COMMITTER is not this install's bot identity. Managed by
# scripts/install-commit-identity-hook.sh -- edit there, not here.
# Deliberate override: SKIP_COMMIT_IDENTITY_GATE=1 git commit ...
set -euo pipefail
# The expected identity is BAKED IN at install time, and there is deliberately NO
# runtime override. Measured 2026-09-27, after Sam found it: with a runtime
# MARVEEN_BOT_EMAIL default here,
#     MARVEEN_BOT_EMAIL=x git -c user.email=x commit
# passed and printed NOTHING -- a SILENT way around the gate, next to the two loud
# documented ones. The expected value has to live somewhere the CALLER cannot set
# per invocation, and an environment variable is not such a place.
#
# NOR THE REPO CONFIG, which is the tempting fix and the wrong one. Measured in an
# isolated repo: inside the hook, \`git config user.email\` ALREADY SHOWS a \`git -c\`
# override (it arrives via GIT_CONFIG_PARAMETERS), so a gate reading it would compare
# the override with itself and pass. \`git config --local\` does resist \`git -c\`,
# GIT_CONFIG_COUNT and \`-c include.path\` -- but then a plain
#     git config user.email <personal address>
# makes the gate pass silently, and the commit carries that address (measured: it did).
# That turns the gate from "is this the bot" into "does this match whatever the caller
# wrote last", which is the incident, not the fix.
#
# THE PRICE, stated rather than hidden: if the bot account legitimately changes, this
# gate blocks the correct NEW identity until someone re-installs it. That is the cost of
# a value that cannot be re-aimed mid-flight, and a re-install is loud, not silent.
BOT_EMAIL="$BOT_EMAIL"
if [ "\${SKIP_COMMIT_IDENTITY_GATE:-0}" = "1" ]; then
  echo "pre-commit: SKIP_COMMIT_IDENTITY_GATE=1 -- the identity is NOT checked, and NOTHING checks it later." >&2
  echo "            There is no CI job behind this gate. If the address is wrong, it goes public." >&2
  exit 0
fi
if [ -z "\$BOT_EMAIL" ]; then
  echo "" >&2
  echo "BLOCKED: the commit-identity gate has NO expected identity baked in." >&2
  echo "  An empty expected value must never count as a match, so this refuses instead." >&2
  echo "  Re-install it, giving the identity explicitly:" >&2
  echo "      MARVEEN_BOT_EMAIL=<id>+<login>@users.noreply.github.com bash scripts/install-commit-identity-hook.sh" >&2
  exit 1
fi
# git var reflects every override form: the config, \`git -c\`, GIT_AUTHOR_EMAIL,
# and \`git commit --author=\`. Reading the config instead would miss the last two.
extract_mail() { printf '%s' "\$1" | sed -n 's/^.*<\\([^>]*\\)>.*$/\\1/p'; }
A_MAIL="\$(extract_mail "\$(git var GIT_AUTHOR_IDENT)")"
C_MAIL="\$(extract_mail "\$(git var GIT_COMMITTER_IDENT)")"
bad=0
[ "\$A_MAIL" = "\$BOT_EMAIL" ] || bad=1
[ "\$C_MAIL" = "\$BOT_EMAIL" ] || bad=1
if [ "\$bad" = "1" ]; then
  echo "" >&2
  echo "BLOCKED: this commit would not carry this install's bot identity." >&2
  echo "  author    : \$A_MAIL" >&2
  echo "  committer : \$C_MAIL" >&2
  echo "  expected  : \$BOT_EMAIL" >&2
  echo "" >&2
  echo "This is the gate for a measured incident (2026-09-27): sixteen commits reached seven" >&2
  echo "public PRs with a personal address, four more with a third party's account, and none of" >&2
  echo "it came from a broken config -- the written procedure prescribed it." >&2
  echo "" >&2
  echo "FIX THE REPO, NOT THE CALL. Do NOT pass -c user.email=, GIT_AUTHOR_EMAIL= or --author=:" >&2
  echo "all three override the config, and that is exactly how the addresses got out." >&2
  echo "  git config user.email \$BOT_EMAIL" >&2
  echo "" >&2
  echo "Override knowingly (nothing checks it afterwards): SKIP_COMMIT_IDENTITY_GATE=1 git commit ..." >&2
  exit 1
fi
HOOKEOF
chmod +x "$GUARD"

# 2. The dispatcher: create it, or adopt a pre-existing single-purpose hook.
if [ ! -e "$DISPATCH" ]; then
  cat > "$DISPATCH" <<'DISPEOF'
#!/usr/bin/env bash
# marveen-pre-commit-dispatcher : run every executable in pre-commit.d/.
set -euo pipefail
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
status=0
for h in "$HOOK_DIR"/pre-commit.d/*; do
  [ -x "$h" ] || continue
  "$h" "$@" || status=1
done
exit $status
DISPEOF
  chmod +x "$DISPATCH"
  echo "install-commit-identity-hook: dispatcher created."
elif ! grep -q "$MARK" "$DISPATCH"; then
  echo "install-commit-identity-hook: $DISPATCH exists and is NOT the marveen dispatcher." >&2
  echo "  Not overwriting it. Move its body into $HOOK_DIR/pre-commit.d/ and re-run." >&2
  exit 1
fi
echo "install-commit-identity-hook: gate installed at $GUARD (expects $BOT_EMAIL)."
