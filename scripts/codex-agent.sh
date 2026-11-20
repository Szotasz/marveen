#!/usr/bin/env bash
# Compose a Codex pane command only after checking the launch binary.
set -euo pipefail
# Sanitize inside the pane as well: tmux may have retained a different env.
if [ "${1:-}" = --run ]; then
  while IFS= read -r key; do
    case "$key" in CLAUDE*|ANTHROPIC*) unset "$key" ;; esac
  done < <(compgen -e)
  codex_bin=${2:?Codex binary is required}
  # Optional third argument: the .codex-overrides file (codexIdentity=overrides).
  # One `key=value` per line becomes one `-c key=value` argv element, in file
  # order; empty lines are skipped. Nothing else is added to the command line.
  overrides_file=${3:-}
  if [ -n "$overrides_file" ]; then
    # R1 review: the same checks as compose mode, here too -- this is where the file is read.
    if [[ "$overrides_file" != /* ]] || [ -L "$overrides_file" ] || [ ! -f "$overrides_file" ]; then
      echo "Codex launch error: overrides file must be an absolute path to an existing regular file: $overrides_file" >&2
      exit 1
    fi
    override_args=()
    while IFS= read -r override || [ -n "$override" ]; do
      [ -n "$override" ] || continue
      override_args+=(-c "$override")
    done < "$overrides_file"
    # An overrides agent never falls back to a bare launch: that would run it without its identity.
    if [ "${#override_args[@]}" -eq 0 ]; then
      echo "Codex launch error: overrides file is empty: $overrides_file" >&2
      exit 1
    fi
    exec "$codex_bin" "${override_args[@]}"
  fi
  exec "$codex_bin"
fi
codex_home=${1:?CODEX_HOME directory is required}
workspace=${2:?Agent workspace is required}
overrides_file=${3:-}
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
# The overrides file decides this agent's identity, so it must be the file the
# dashboard wrote: absolute, an existing regular file, and not a symlink pointed
# somewhere else (a relative path would resolve inside the pane's cd target).
if [ -n "$overrides_file" ]; then
  if [[ "$overrides_file" != /* ]] || [ -L "$overrides_file" ] || [ ! -f "$overrides_file" ]; then
    echo "Codex launch error: overrides file must be an absolute path to an existing regular file: $overrides_file" >&2
    exit 1
  fi
fi
# Only paths enter argv. Credential values remain in the environment.
if [ -n "$overrides_file" ]; then
  printf 'export CODEX_HOME=%q && cd %q && exec bash %q --run %q %q\n' "$codex_home" "$workspace" "$0" "$codex_bin" "$overrides_file"
else
  printf 'export CODEX_HOME=%q && cd %q && exec bash %q --run %q\n' "$codex_home" "$workspace" "$0" "$codex_bin"
fi
