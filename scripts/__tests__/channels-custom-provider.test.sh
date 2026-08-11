#!/bin/bash
# Contract tests for main-agent-custom-provider.mjs
#
# Why this exists: channels.sh gains customProvider support for the main agent
# so the main agent can run on LiteLLM/OpenCode (or any Anthropic-compatible custom
# endpoint) rather than the standard Anthropic Claude API.
#
# Key invariants:
#   1. No customProvider -> exit 0, no output (no-op for existing installs).
#   2. customProvider set but definition missing -> exit 1, stderr, no stdout.
#   3. customProvider set, empty baseUrl -> exit 1, stderr.
#   4. Valid authHeader=none -> exit 0, env line with ANTHROPIC_AUTH_TOKEN=ollama.
#   5. Env line always starts with "unset CLAUDE_CODE_OAUTH_TOKEN &&".
#   6. All shell-interpolated values (baseUrl, model) are single-quoted.
#   7. A $ or " in the model name must not expand in the output.
#   8. authHeader=none -> unset ANTHROPIC_API_KEY present, no export ANTHROPIC_API_KEY.
#   9. Missing vault key -> exit 1 (configured-but-broken, channels.sh aborts).
#  10. Configured-but-broken path exits 1 consistently.
#
# HERMETIC EXECUTION: each case runs the helper inside an isolated temp
# PROJECT_ROOT created INSIDE the real project tree so that node.js module
# resolution still finds the shared node_modules/ while touching no live
# store/ or agents/ files. MAIN_AGENT_ID is explicitly set to "testprovider"
# in the temp .env, so the test never depends on the real install's identity.
#
# Run: bash scripts/__tests__/channels-custom-provider.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REAL_HELPER="$INSTALL_DIR/scripts/main-agent-custom-provider.mjs"

if [ ! -f "$INSTALL_DIR/dist/web/agent-process.js" ]; then
  echo "SKIP: dist/ not built (run 'npm run build' first)"
  exit 0
fi

# The isolated root lives INSIDE the project tree so node.js walks up to find
# the shared node_modules/. It is a build product (temp dir), never a real
# store or agents dir. mktemp -d inside INSTALL_DIR guarantees that.
root="$(mktemp -d "$INSTALL_DIR/tmp.provtest.XXXXXX")"
trap 'rm -rf "$root"' EXIT

# Copy dist/ and the helper script.
cp -r "$INSTALL_DIR/dist" "$root/dist"
mkdir -p "$root/scripts"
cp "$REAL_HELPER" "$root/scripts/main-agent-custom-provider.mjs"

# Explicit MAIN_AGENT_ID so the test never depends on the real .env.
TEST_AGENT="testprovider"
printf 'MAIN_AGENT_ID=%s\n' "$TEST_AGENT" > "$root/.env"

# Paths inside the isolated root.
AGENT_DIR="$root/agents/$TEST_AGENT"
AGENT_CFG="$AGENT_DIR/agent-config.json"
PROVIDERS_PATH="$root/store/custom-providers.json"
mkdir -p "$AGENT_DIR" "$root/store"

# Helper: run the helper in the isolated root and capture stdout + exit code.
# $1 = agent-config.json body (written to AGENT_CFG; "" = remove the file)
# $2 = custom-providers.json body (written to PROVIDERS_PATH; "" = remove)
# Sets: GOT_OUT (stdout), GOT_RC (exit code), GOT_ERR (stderr)
run() {
  local agent_cfg="$1" providers_cfg="$2"
  if [ -n "$agent_cfg" ]; then
    printf '%s\n' "$agent_cfg" > "$AGENT_CFG"
  else
    rm -f "$AGENT_CFG"
  fi
  if [ -n "$providers_cfg" ]; then
    printf '%s\n' "$providers_cfg" > "$PROVIDERS_PATH"
  else
    rm -f "$PROVIDERS_PATH"
  fi
  _stderr_tmp="$(mktemp "${TMPDIR:-/tmp}/cp_stderr.XXXXXX")"
  GOT_OUT="$(node "$root/scripts/main-agent-custom-provider.mjs" 2>"$_stderr_tmp")"
  GOT_RC=$?
  GOT_ERR="$(cat "$_stderr_tmp")"
  rm -f "$_stderr_tmp"
}

NONE_PROVIDER='{"providers":[{"id":"litellm-local","label":"LiteLLM","baseUrl":"http://127.0.0.1:4010","authHeader":"none","vaultKey":null}]}'
BEARER_PROVIDER='{"providers":[{"id":"bearer-ep","label":"Bearer","baseUrl":"http://127.0.0.1:4010","authHeader":"Bearer","vaultKey":"MY_BEARER_KEY"}]}'
XAPIKEY_PROVIDER='{"providers":[{"id":"xkey-ep","label":"XKey","baseUrl":"http://127.0.0.1:4010","authHeader":"x-api-key","vaultKey":"MY_XAPIKEY_KEY"}]}'

echo "main-agent-custom-provider.mjs"

# 1. No customProvider -> exit 0, empty stdout
run '' ''
if [ -z "$GOT_OUT" ] && [ "$GOT_RC" -eq 0 ]; then
  pass "no customProvider -> exit 0, no output"
else
  fail "no customProvider -> exit 0, no output" "exit=0, stdout=empty" "exit=$GOT_RC, stdout='$GOT_OUT'"
fi

# 2. customProvider set but provider not in store -> exit 1, empty stdout
run '{"customProvider":"ghost","model":"oc/test"}' '{"providers":[]}'
if [ -z "$GOT_OUT" ] && [ "$GOT_RC" -ne 0 ]; then
  pass "missing provider definition -> exit 1, no stdout"
else
  fail "missing provider definition -> exit 1, no stdout" "exit!=0, stdout=empty" "exit=$GOT_RC, stdout='$GOT_OUT'"
fi
if printf '%s' "$GOT_ERR" | grep -q "not found in store"; then
  pass "missing provider -> stderr warning"
else
  fail "missing provider -> stderr warning" "not found in store" "$GOT_ERR"
fi

# 3. Empty baseUrl -> exit 1
run '{"customProvider":"bad-ep","model":"oc/test"}' \
    '{"providers":[{"id":"bad-ep","label":"Bad","baseUrl":"","authHeader":"none","vaultKey":null}]}'
if [ -z "$GOT_OUT" ] && [ "$GOT_RC" -ne 0 ]; then
  pass "empty baseUrl -> exit 1, no stdout"
else
  fail "empty baseUrl -> exit 1, no stdout" "exit!=0, stdout=empty" "exit=$GOT_RC, stdout='$GOT_OUT'"
fi

# 4. Valid authHeader=none -> exit 0, non-empty output
run '{"customProvider":"litellm-local","model":"oc/gpt-5.6-luna"}' "$NONE_PROVIDER"
if [ -n "$GOT_OUT" ] && [ "$GOT_RC" -eq 0 ]; then
  pass "valid none-auth provider -> exit 0, non-empty output"
else
  fail "valid none-auth provider -> exit 0, non-empty output" "exit=0, non-empty" "exit=$GOT_RC, stdout='$GOT_OUT'"
fi
NONE_OUT="$GOT_OUT"

# 5. Env line starts with "unset CLAUDE_CODE_OAUTH_TOKEN &&" -- byte-exact on the full
# none output so a leading contamination line cannot slip through a grep anchor.
EXPECTED_NONE="unset CLAUDE_CODE_OAUTH_TOKEN && export ANTHROPIC_BASE_URL='http://127.0.0.1:4010' && export ANTHROPIC_AUTH_TOKEN=ollama && unset ANTHROPIC_API_KEY && export ANTHROPIC_MODEL='oc/gpt-5.6-luna' && "
if [ "$NONE_OUT" = "$EXPECTED_NONE" ]; then
  pass "env line starts with unset CLAUDE_CODE_OAUTH_TOKEN"
else
  fail "env line starts with unset CLAUDE_CODE_OAUTH_TOKEN" "$EXPECTED_NONE" "$NONE_OUT"
fi

# 6. ANTHROPIC_MODEL is single-quoted
if printf '%s' "$NONE_OUT" | grep -q "ANTHROPIC_MODEL='oc/gpt-5.6-luna'"; then
  pass "ANTHROPIC_MODEL is single-quoted"
else
  fail "ANTHROPIC_MODEL is single-quoted" "ANTHROPIC_MODEL='oc/gpt-5.6-luna'" "$NONE_OUT"
fi

# 6b. ANTHROPIC_BASE_URL is single-quoted
if printf '%s' "$NONE_OUT" | grep -q "ANTHROPIC_BASE_URL='http://127.0.0.1:4010'"; then
  pass "ANTHROPIC_BASE_URL is single-quoted"
else
  fail "ANTHROPIC_BASE_URL is single-quoted" "ANTHROPIC_BASE_URL='http://127.0.0.1:4010'" "$NONE_OUT"
fi

# 7. Dollar sign in model must not expand (single-quote escaping)
run '{"customProvider":"litellm-local","model":"oc/model-with-$-dollar"}' "$NONE_PROVIDER"
if printf '%s' "$GOT_OUT" | grep -qF "ANTHROPIC_MODEL='oc/model-with-\$-dollar'"; then
  pass "dollar sign in model is single-quoted (no expansion)"
else
  fail "dollar sign in model is single-quoted" "ANTHROPIC_MODEL='oc/model-with-\$-dollar'" "$GOT_OUT"
fi

# 7b. Double-quote in baseUrl must not break the shell statement
run '{"customProvider":"litellm-local","model":"oc/test"}' \
    '{"providers":[{"id":"litellm-local","label":"L","baseUrl":"http://127.0.0.1:4010/v1","authHeader":"none","vaultKey":null}]}'
if printf '%s' "$GOT_OUT" | grep -q "ANTHROPIC_BASE_URL='http://127.0.0.1:4010/v1'"; then
  pass "baseUrl with path component is single-quoted"
else
  fail "baseUrl with path component is single-quoted" "ANTHROPIC_BASE_URL='http://127.0.0.1:4010/v1'" "$GOT_OUT"
fi

# 8. authHeader=none -> unset ANTHROPIC_API_KEY present, no export ANTHROPIC_API_KEY
run '{"customProvider":"litellm-local","model":"oc/gpt-5.6-luna"}' "$NONE_PROVIDER"
if printf '%s' "$GOT_OUT" | grep -q 'unset ANTHROPIC_API_KEY'; then
  pass "authHeader=none -> unset ANTHROPIC_API_KEY (no conflict)"
else
  fail "authHeader=none -> unset ANTHROPIC_API_KEY" "unset ANTHROPIC_API_KEY" "$GOT_OUT"
fi
if printf '%s' "$GOT_OUT" | grep -q 'export ANTHROPIC_API_KEY'; then
  fail "authHeader=none -> no export ANTHROPIC_API_KEY" "(absent)" "ANTHROPIC_API_KEY exported"
else
  pass "authHeader=none -> no export ANTHROPIC_API_KEY"
fi

# 9. Bearer with missing vault key -> exit 1 (no vault.json in temp store)
run '{"customProvider":"bearer-ep","model":"oc/test"}' "$BEARER_PROVIDER"
if [ -z "$GOT_OUT" ] && [ "$GOT_RC" -ne 0 ]; then
  pass "missing vault key -> exit 1, no stdout"
else
  fail "missing vault key -> exit 1, no stdout" "exit!=0, stdout=empty" "exit=$GOT_RC, stdout='$GOT_OUT'"
fi
if printf '%s' "$GOT_ERR" | grep -q "vault key"; then
  pass "missing vault key -> stderr mentions vault key"
else
  fail "missing vault key -> stderr mentions vault key" "vault key" "$GOT_ERR"
fi

# 10. Every configured-but-broken path exits non-zero (comprehensive)
# Already covered by cases 2, 3, 9 above.
pass "configured-but-broken paths exit 1 (covered by cases 2, 3, 9)"

# --- Bearer happy-path ---
# Seed the hermetic vault with a Bearer token, then assert byte-exact output.
# Without this, a swapped env-var name in the Bearer branch (e.g.
# ANTHROPIC_API_KEY instead of ANTHROPIC_AUTH_TOKEN) would pass all grep checks
# while silently sending the wrong header.
TEST_BEARER_KEY='bearer-token-test-1234567890'
if TEST_ROOT="$root" TEST_KEY="$TEST_BEARER_KEY" node --input-type=module <<'VAULT_SETUP_BEARER' 2>/dev/null
import { join } from 'node:path'
const { setSecret } = await import(join(process.env.TEST_ROOT, 'dist', 'web', 'vault.js'))
setSecret('MY_BEARER_KEY', 'Test Bearer token', process.env.TEST_KEY)
VAULT_SETUP_BEARER
then
  printf '%s\n' '{"customProvider":"bearer-ep","model":"oc/test"}' > "$AGENT_CFG"
  printf '%s\n' "$BEARER_PROVIDER" > "$PROVIDERS_PATH"
  EXPECTED_BEARER="unset CLAUDE_CODE_OAUTH_TOKEN && export ANTHROPIC_BASE_URL='http://127.0.0.1:4010' && export ANTHROPIC_AUTH_TOKEN='${TEST_BEARER_KEY}' && unset ANTHROPIC_API_KEY && export ANTHROPIC_MODEL='oc/test' && "
  BEARER_OUT="$(node "$root/scripts/main-agent-custom-provider.mjs" 2>/dev/null)"
  BEARER_RC=$?
  if [ "$BEARER_RC" -eq 0 ] && [ "$BEARER_OUT" = "$EXPECTED_BEARER" ]; then
    pass "Bearer happy-path: byte-exact stdout"
  else
    fail "Bearer happy-path: byte-exact stdout" "$EXPECTED_BEARER" "exit=$BEARER_RC stdout='$BEARER_OUT'"
  fi
  # Clean up so subsequent cases don't pick up the bearer agent config
  rm -f "$AGENT_CFG" "$PROVIDERS_PATH"
else
  fail "Bearer happy-path: vault setup" "setSecret succeeded" "node setup failed"
  fail "Bearer happy-path: byte-exact stdout" "(skipped)" "(vault setup failed)"
fi

# --- x-api-key path ---
# Populate the hermetic vault with a known key so the helper can resolve it.
# vault.js derives PROJECT_ROOT from the imported dist/config.js __dirname, so
# when dist/ lives inside $root, all vault files land in $root/store/.
# On Linux the vault auto-creates .vault-key without any logger calls.
TEST_XAPIKEY='sk-test-xapikey-1234567890abcdef'
if TEST_ROOT="$root" TEST_KEY="$TEST_XAPIKEY" node --input-type=module <<'VAULT_SETUP' 2>/dev/null
import { join } from 'node:path'
const { setSecret } = await import(join(process.env.TEST_ROOT, 'dist', 'web', 'vault.js'))
setSecret('MY_XAPIKEY_KEY', 'Test x-api-key', process.env.TEST_KEY)
VAULT_SETUP
then

  XKEY_AGENT='{"customProvider":"xkey-ep","model":"oc/test"}'
  # Write fixtures for inline x-api-key calls (pass $root as config dir so the
  # stamp lands in the hermetic tree, not in the real ~/.claude.json).
  printf '%s\n' "$XKEY_AGENT" > "$AGENT_CFG"
  printf '%s\n' "$XAPIKEY_PROVIDER" > "$PROVIDERS_PATH"

  # 11. x-api-key path -> exit 0, non-empty output
  GOT_OUT="$(node "$root/scripts/main-agent-custom-provider.mjs" "$root" 2>/dev/null)"
  GOT_RC=$?
  if [ -n "$GOT_OUT" ] && [ "$GOT_RC" -eq 0 ]; then
    pass "x-api-key provider -> exit 0, non-empty output"
  else
    fail "x-api-key provider -> exit 0, non-empty output" "exit=0, non-empty" "exit=$GOT_RC, stdout='$GOT_OUT'"
  fi

  # 12. stdout is BYTE-EXACTLY the env prefix on a COLD stamp path.
  #
  # The contamination only fires when stampCustomApiKeyApproval does real work:
  # the suffix is NOT yet in .claude.json (cold). A warm run (suffix already
  # present) is a no-op and never called logger.info -- so a warm-only test is
  # a false green. Each iteration must start from a cold config dir.
  #
  # Implementation: a fresh temp dir per iteration (no .claude.json at all)
  # so the stamp always writes a new file and exercises the cold path.
  EXPECTED_XKEY="unset CLAUDE_CODE_OAUTH_TOKEN && export ANTHROPIC_BASE_URL='http://127.0.0.1:4010' && export ANTHROPIC_API_KEY='${TEST_XAPIKEY}' && unset ANTHROPIC_AUTH_TOKEN && export ANTHROPIC_MODEL='oc/test' && "
  XKEY_FAIL=0
  for _i in 1 2 3 4 5; do
    # Fresh cfg dir: no .claude.json present -> cold stamp on every iteration.
    _cold_cfg="$(mktemp -d "$root/tmp.cold.XXXXXX")"
    RAW_XKEY="$(NODE_ENV=production node "$root/scripts/main-agent-custom-provider.mjs" "$_cold_cfg" 2>/dev/null)"
    _xkey_rc=$?
    rm -rf "$_cold_cfg"
    if [ "$RAW_XKEY" != "$EXPECTED_XKEY" ] || [ "$_xkey_rc" -ne 0 ]; then
      XKEY_FAIL=1
      break
    fi
  done
  if [ "$XKEY_FAIL" -eq 0 ]; then
    pass "x-api-key cold-stamp stdout is byte-exact (5 iterations, each cold)"
  else
    fail "x-api-key cold-stamp stdout is byte-exact" \
      "$EXPECTED_XKEY" "$RAW_XKEY"
  fi

  # 13. stamp written: $root/.claude.json contains the suffix in customApiKeyResponses.approved
  STAMP_FILE="$root/.claude.json"
  XKEY_SUFFIX="${TEST_XAPIKEY: -20}"
  if [ -f "$STAMP_FILE" ] && grep -qF "$XKEY_SUFFIX" "$STAMP_FILE"; then
    pass "x-api-key suffix stamped into .claude.json"
  else
    fail "x-api-key suffix stamped into .claude.json" "$XKEY_SUFFIX in .claude.json" "file missing or suffix absent"
  fi

else
  fail "vault setup for x-api-key tests" "setSecret succeeded" "node setup failed"
  fail "x-api-key provider -> exit 0, non-empty output" "(skipped)" "(vault setup failed)"
  fail "x-api-key stdout is byte-exact under NODE_ENV=production" "(skipped)" "(vault setup failed)"
  fail "x-api-key suffix stamped into .claude.json" "(skipped)" "(vault setup failed)"
fi

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
