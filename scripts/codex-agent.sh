#!/usr/bin/env bash
# Compose a Codex pane command only after checking the launch binary.
set -euo pipefail
# Sanitize inside the pane as well: tmux may have retained a different env.
if [ "${1:-}" = --run ]; then
  while IFS= read -r key; do
    case "$key" in CLAUDE*|ANTHROPIC*) unset "$key" ;; esac
  done < <(compgen -e)
  exec "${2:?Codex binary is required}"
fi
codex_home=${1:?CODEX_HOME directory is required}
workspace=${2:?Agent workspace is required}
codex_bin=$(command -v "${MARVEEN_CODEX_BIN:-codex}" || true)
if [ -z "$codex_bin" ] || ! command -v "$codex_bin" >/dev/null 2>&1; then
  echo 'Codex launch error: codex is missing; install >= 0.150 or set MARVEEN_CODEX_BIN' >&2
  exit 1
fi
# Do not inherit Claude authentication even during the version probe.
unset CLAUDE_CONFIG_DIR CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY
version=$("$codex_bin" --version) || { echo 'Codex launch error: version probe failed' >&2; exit 1; }
if [[ ! "$version" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]] ||
   (( BASH_REMATCH[1] == 0 && BASH_REMATCH[2] < 150 )); then
  echo 'Codex launch error: codex >= 0.150 is required' >&2
  exit 1
fi
# Only paths enter argv. Credential values remain in the environment.
printf 'export CODEX_HOME=%q && cd %q && exec bash %q --run %q\n' "$codex_home" "$workspace" "$0" "$codex_bin"
