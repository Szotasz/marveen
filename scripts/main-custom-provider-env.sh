# shellcheck shell=bash
# CUSTPROVWATCHDOG1125: the main agent's custom provider env (the Hostinger AI Router, LiteLLM, Ollama ...) for the
# out-of-process main respawns, channel-watchdog.sh and stuck-modal-guard.sh. Without it their respawn started the
# main agent on the standard Claude backend: channels.sh is the only launcher that added it (the in-process respawns
# got it in #3121). The same helper and the same contract as channels.sh's own block:
#   stdout: the env prefix (ending in "&& "), or nothing when no provider is configured; rc 0
#   rc != 0: a provider is configured but cannot be used (no record, no key, no model). The caller must NOT respawn:
#            the running session stays, instead of being killed and replaced by one on the wrong backend.
# No dist (a half-updated tree) or no node: nothing, rc 0, the respawn as before.
# usage: main_custom_provider_env <install_dir> <node_bin> <config_dir or ""> <log_file>
main_custom_provider_env() {
  local dir="$1" node="$2" cfg="$3" log="$4"
  [ -n "$node" ] && [ -f "$dir/dist/web/custom-providers.js" ] || return 0
  # As channels.sh: the config dir only when it exists, so the helper stamps the key approval into the right .claude.json.
  [ -n "$cfg" ] && [ -d "$cfg" ] || cfg=""
  "$node" "$dir/scripts/main-agent-custom-provider.mjs" "$cfg" 2>>"$log"
}
