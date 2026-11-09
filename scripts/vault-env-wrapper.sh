#!/bin/bash
# Resolve vault: references in env vars, then exec the real command.
# Claude Code launches this as the MCP server "command". The actual
# server command + args are passed as arguments to this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find node binary
NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  echo "vault-env-wrapper: node not found" >&2
  exit 1
fi

# Collect vault: references from env
REFS=""
ASKED=" "
for var in $(env | grep '=vault:' | cut -d= -f1); do
  val="${!var}"
  secret_id="${val#vault:}"
  REFS="${REFS}${var}=${secret_id}"$'\n'
  ASKED="${ASKED}${var} "
done

if [ -n "$REFS" ]; then
  # VAULTNEMA912: vault-resolve now fails LOUD (exit 2 = malformed ref line,
  # exit 3 = missing secret) instead of silent success. DELIBERATE CHOICE
  # (option a, measured with Marveen): the MCP server still starts. This
  # wrapper's job is launching; a stale vault: reference must not become a
  # fleet-wide startup failure. The truth goes to stderr (vault-resolve has
  # already named the offending label/line there), and the RESOLVED SUBSET is
  # still exported -- vault-resolve keeps printing the good lines in a mixed
  # batch. The `|| RC=$?` shape is what keeps `set -e` from killing the
  # wrapper before `exec` under the new contract.
  RC=0
  # VAULTWRAPMULTI1108: --escaped puts each value on ONE line (backslash, line feed and carriage return escaped).
  # Before it, a multi-line secret (an APNs .p8 PEM key) split into lines; a line without '=' became a "name", export
  # refused it, and bash printed that line, i.e. bytes of the private key, into the error (measured 2026-10-31).
  RESOLVED=$(printf '%s' "$REFS" | "$NODE" "$PROJECT_ROOT/scripts/vault-resolve.mjs" --escaped) || RC=$?
  if [ "$RC" -ne 0 ]; then
    echo "vault-env-wrapper: vault-resolve exit $RC -- not every vault: reference resolved; starting anyway with the resolved subset" >&2
  fi
  # Split each line on the FIRST '=' only, preserving '=' inside/at-end of the
  # value (e.g. base64 keys with '=' padding). `IFS='=' read -r key value`
  # drops a single trailing '=' (PAD1=abc= became abc), so use parameter
  # expansion instead.
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      *=*) ;;
      *) echo "vault-env-wrapper: skipped an output line that is not NAME=value (its text is not shown)" >&2; continue ;;
    esac
    key="${line%%=*}"
    # Only a valid name this wrapper ASKED for is exported (a line of a split value can look like NAME=..., e.g. base64
    # padding). The name check comes FIRST: the asked-for list is space separated, so a "name" with a space in it
    # ("PLAIN PEM=...") would match it, and export would print the whole line (Dani #2615). Anything skipped is reported
    # with a message that quotes NOTHING of the line: it could be a value.
    case "$key" in
      ''|[0-9]*|*[!A-Za-z0-9_]*)
        echo "vault-env-wrapper: skipped an output line that is not NAME=value (its text is not shown)" >&2
        continue ;;
    esac
    case "$ASKED" in
      *" $key "*) ;;
      *) echo "vault-env-wrapper: skipped an output line for a name that was not asked for (its text is not shown)" >&2; continue ;;
    esac
    # %b undoes vault-resolve's escaping exactly: every backslash of the value arrives as \\, so the only escapes
    # are \\, \n and \r; printf -v keeps a trailing line feed (a command substitution would drop it).
    printf -v value '%b' "${line#*=}"
    export "$key"="$value"
  done <<< "$RESOLVED"
fi

exec "$@"
