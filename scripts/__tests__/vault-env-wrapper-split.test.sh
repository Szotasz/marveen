#!/usr/bin/env bash
# vault-env-wrapper.sh must keep '=' inside and at the end of resolved values.
# The resolver is stubbed, so no vault is touched.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/vew.XXXXXX")"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/scripts"
cp "$HERE/../vault-env-wrapper.sh" "$T/scripts/"
cat > "$T/scripts/vault-resolve.mjs" <<'JS'
process.stdout.write("PAD1=abc=\nPAD2=YWJj==\nINNER=x=y=z\nPLAIN=value\n")
JS
out="$(PAD1=vault:a PAD2=vault:b INNER=vault:c PLAIN=vault:d bash "$T/scripts/vault-env-wrapper.sh" env)"
pass=0; fail=0
check() { if printf '%s\n' "$out" | grep -qx "$1"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got: $(printf '%s\n' "$out" | grep "^${1%%=*}=" ))"; fail=$((fail+1)); fi; }
check 'PAD1=abc='
check 'PAD2=YWJj=='
check 'INNER=x=y=z'
check 'PLAIN=value'
echo "PASS=$pass FAIL=$fail"; [ "$fail" -eq 0 ]
