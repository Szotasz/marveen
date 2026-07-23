#!/bin/bash
# headersHelper shim for remote MCP servers: find node (GUI/nvm PATH is not
# guaranteed when Claude Code launches the helper), then run the resolver.
# Claude Code passes the "HeaderName=Scheme:::vaultSecretId" args through here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
# nvm installs live outside PATH when launched from a GUI context.
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  for candidate in $(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V -r); do
    if [ -x "$HOME/.nvm/versions/node/$candidate/bin/node" ]; then
      NODE="$HOME/.nvm/versions/node/$candidate/bin/node"
      break
    fi
  done
fi
if [ -z "$NODE" ]; then
  echo "vault-headers-helper: node not found" >&2
  exit 1
fi

exec "$NODE" "$PROJECT_ROOT/scripts/vault-headers-helper.mjs" "$@"
