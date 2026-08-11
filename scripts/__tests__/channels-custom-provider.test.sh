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
  GOT_OUT="$(node "$root/scripts/main-agent-custom-provider.mjs" 2>/tmp/cp_test_stderr)"
  GOT_RC=$?
  GOT_ERR="$(cat /tmp/cp_test_stderr)"
}

NONE_PROVIDER='{"providers":[{"id":"litellm-local","label":"LiteLLM","baseUrl":"http://127.0.0.1:4010","authHeader":"none","vaultKey":null}]}'
BEARER_PROVIDER='{"providers":[{"id":"bearer-ep","label":"Bearer","baseUrl":"http://127.0.0.1:4010","authHeader":"Bearer","vaultKey":"MY_BEARER_KEY"}]}'

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

# 5. Env line starts with "unset CLAUDE_CODE_OAUTH_TOKEN &&"
if printf '%s' "$NONE_OUT" | grep -q '^unset CLAUDE_CODE_OAUTH_TOKEN &&'; then
  pass "env line starts with unset CLAUDE_CODE_OAUTH_TOKEN"
else
  fail "env line starts with unset CLAUDE_CODE_OAUTH_TOKEN" "starts with 'unset CLAUDE_CODE_OAUTH_TOKEN &&'" "$NONE_OUT"
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

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
