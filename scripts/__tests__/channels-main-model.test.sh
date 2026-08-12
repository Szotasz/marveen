#!/bin/bash
# Contract tests for main-agent model resolution in scripts/channels.sh.
#
# Why this exists (2026-07-29): the model was read ONLY from
# .claude/settings.json, which is a TRACKED file. An install that wants a
# different model than the repository ships had to edit that file, and then:
#   - the update preflight refused to run ("dirty tree"), so the dashboard's
#     update button was permanently blocked on that install, and
#   - checking out the release branch silently restored the repository's model,
#     so the next restart came up on a different model than the operator chose.
#     Silent, because nothing fails -- the agent just answers as another model.
#
# MAIN_AGENT_MODEL in .env (per-install, gitignored) now takes precedence, and
# settings.json remains the shipped default.
#
# Driven through `channels.sh --resolve-main-model`, which prints the resolved
# model and exits before touching tmux, the store or the network.
# Run: bash scripts/__tests__/channels-main-model.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

# Each case runs the script from a throwaway install root, so INSTALL_DIR (which
# the script derives from its own path) points at fixture files, not the repo.
# $1 = label, $2 = .env body, $3 = settings.json body, $4 = expected model
expect_model() {
  local label="$1" env_body="$2" settings_body="$3" want="$4"
  local root got
  root="$(mktemp -d)"
  mkdir -p "$root/scripts" "$root/.claude"
  cp "$SRC" "$root/scripts/channels.sh"
  [ -n "$env_body" ] && printf '%s\n' "$env_body" > "$root/.env"
  [ -n "$settings_body" ] && printf '%s\n' "$settings_body" > "$root/.claude/settings.json"
  got="$(bash "$root/scripts/channels.sh" --resolve-main-model 2>/dev/null | head -1)"
  rm -rf "$root"
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label" "$want" "$got"; fi
}

echo "channels.sh main-model resolution"

expect_model "settings.json alone is still honoured (shipped default)" \
  "" '{"model":"claude-opus-4-8[1m]"}' 'claude-opus-4-8[1m]'

expect_model ".env wins over settings.json (the whole point)" \
  'MAIN_AGENT_MODEL=claude-opus-5' '{"model":"claude-opus-4-8[1m]"}' 'claude-opus-5'

expect_model ".env alone works with no settings.json" \
  'MAIN_AGENT_MODEL=claude-sonnet-5' '' 'claude-sonnet-5'

expect_model "neither present -> empty, launcher omits --model" \
  "" '' ''

expect_model "an empty MAIN_AGENT_MODEL does not shadow settings.json" \
  'MAIN_AGENT_MODEL=' '{"model":"claude-opus-5"}' 'claude-opus-5'

# A model id with a bracketed suffix must survive verbatim: the launcher
# single-quotes it, and an unquoted `[1m]` would glob-expand in the tmux shell.
expect_model "bracketed suffix survives the .env route" \
  'MAIN_AGENT_MODEL=claude-opus-5[1m]' '' 'claude-opus-5[1m]'

# .env carries other keys too; the matcher must be anchored, not a substring.
expect_model "a similarly named key does not leak in" \
  'NOT_MAIN_AGENT_MODEL=wrong-model
MAIN_AGENT_MODEL=claude-haiku-4-5' '' 'claude-haiku-4-5'

# MODELMIGRATE806: with NO .env override and NO model in settings.json, the
# resolver falls back to the SHIPPED DISTRIBUTION_DEFAULT_AGENT_MODEL, read from
# dist/config-registry.js via node. This is what reaches existing model-less
# installs on a plain code update -- no per-install .env write. Drive it through
# the real resolver with a fixture dist that exports a known constant.
migr_fallback() {
  local want="$1" root
  root="$(mktemp -d)"
  mkdir -p "$root/scripts" "$root/dist"
  cp "$SRC" "$root/scripts/channels.sh"
  printf 'exports.DISTRIBUTION_DEFAULT_AGENT_MODEL = %s;\n' "\"$want\"" > "$root/dist/config-registry.js"
  local got
  got="$(bash "$root/scripts/channels.sh" --resolve-main-model 2>/dev/null | head -1)"
  rm -rf "$root"
  if [ "$got" = "$want" ]; then pass "no .env + no settings model -> shipped distribution default ($want)"; else fail "distribution-default fallback" "$want" "$got"; fi
}
migr_fallback "claude-opus-5[1m]"

# The .env override still wins over the distribution-default fallback.
expect_model ".env override beats the distribution-default fallback" \
  'MAIN_AGENT_MODEL=claude-sonnet-5' '' 'claude-sonnet-5'

# THE SHIPPED-DEFAULT CONTRACT (MODELDRIFT807, 2026-08-07): a fresh install
# CLONES the repo, so the .claude/settings.json a customer gets is the TRACKED
# file itself -- NO installer copies the template (or anything else) over it
# (measured: install-macos.sh / install-linux.sh never write
# $INSTALL_DIR/.claude/settings.json). The predecessor of this block copied the
# TEMPLATE into the fixture and asserted on that -- a contract no installer
# implements, so it stayed green while every real fresh install resolved the
# tracked file's pinned claude-opus-4-8[1m] and the distribution default never
# ran. These contracts drive the REAL shipped files instead.
SHIPPED_SETTINGS="$INSTALL_DIR/.claude/settings.json"

# (1) The tracked settings file pins NO model. A hand-set model on a live
# install still wins (covered above) -- this is about what we SHIP.
shipped_model="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("model") or "")' "$SHIPPED_SETTINGS")"
if [ -z "$shipped_model" ]; then
  pass "shipped .claude/settings.json pins no model (distribution default stays live)"
else
  fail "shipped .claude/settings.json pins no model" "(empty)" "$shipped_model"
fi

# (2) The resolver over the REAL shipped settings file falls through to the
# distribution default. The sentinel value can only surface via the registry
# read, so a pinned model in the shipped file turns this red.
real_settings_model="$(bash -c '
  root="$(mktemp -d)"; mkdir -p "$root/scripts" "$root/.claude" "$root/dist"
  cp "'"$SRC"'" "$root/scripts/channels.sh"
  cp "'"$SHIPPED_SETTINGS"'" "$root/.claude/settings.json"
  printf "exports.DISTRIBUTION_DEFAULT_AGENT_MODEL = \"SENTINEL-FROM-REGISTRY\";\n" > "$root/dist/config-registry.js"
  bash "$root/scripts/channels.sh" --resolve-main-model 2>/dev/null | head -1
  rm -rf "$root"
')"
if [ "$real_settings_model" = "SENTINEL-FROM-REGISTRY" ]; then
  pass "resolver over the REAL shipped settings falls through to the distribution default"
else
  fail "resolver over the REAL shipped settings falls through to the distribution default" "SENTINEL-FROM-REGISTRY" "$real_settings_model"
fi

# (3) The real shipped constant (the single source of truth) is Opus 5 (1M).
registry_default="$(grep -oE "DISTRIBUTION_DEFAULT_AGENT_MODEL = '[^']+'" "$INSTALL_DIR/src/config-registry.ts" | head -1 | sed "s/.*'\(.*\)'/\1/")"
if [ "$registry_default" = "claude-opus-5[1m]" ]; then
  pass "DISTRIBUTION_DEFAULT_AGENT_MODEL is claude-opus-5[1m] (real src constant)"
else
  fail "DISTRIBUTION_DEFAULT_AGENT_MODEL is claude-opus-5[1m]" "claude-opus-5[1m]" "$registry_default"
fi

# (4) The template must not resurrect a second model source: no installer ships
# it as .claude/settings.json, so a model field in it is dead code that a future
# test could again mistake for the live contract.
template_model="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("model") or "")' "$INSTALL_DIR/templates/settings.json.template")"
if [ -z "$template_model" ]; then
  pass "settings template pins no model (single source: config-registry)"
else
  fail "settings template pins no model" "(empty)" "$template_model"
fi

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
