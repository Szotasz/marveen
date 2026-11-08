#!/usr/bin/env bash
# vault-env-wrapper.sh must keep '=' inside and at the end of resolved values, and (VAULTWRAPMULTI1108) a MULTI-LINE
# value must arrive whole, with no byte of it in the wrapper's stderr. The resolver is stubbed, so no vault is
# touched; the stub speaks the wrapper's contract (vault-resolve.mjs --escaped: one line per value, backslash, line
# feed and carriage return escaped). The fixture "secret" is not a real key.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/vew.XXXXXX")"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/scripts"
cp "$HERE/../vault-env-wrapper.sh" "$T/scripts/"
# The child prints the variables as JSON, so a value with line feeds, backslashes or a trailing line feed is compared
# byte for byte.
DUMP='process.stdout.write(JSON.stringify(Object.fromEntries(["PAD1","PAD2","INNER","PLAIN","PEM","BACKSL","TRAIL"].map(k => [k, process.env[k] ?? null]))))'
PEM_VALUE=$'-----BEGIN FIXTURE BLOCK-----\nMIGTAgEA+MBMG/FAKEFIXTUREBYTES0123\nZZQU+JV/FAKEFIXTUREBYTES4567==\n-----END FIXTURE BLOCK-----\n'

pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }

# 1. the contract: --escaped is asked for, and every value comes back exactly.
cat > "$T/scripts/vault-resolve.mjs" <<'JS'
if (process.argv[2] !== '--escaped') { process.stderr.write('stub: expected --escaped\n'); process.exit(2) }
const esc = (v) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
const vals = { PAD1: 'abc=', PAD2: 'YWJj==', INNER: 'x=y=z', PLAIN: 'value',
  PEM: '-----BEGIN FIXTURE BLOCK-----\nMIGTAgEA+MBMG/FAKEFIXTUREBYTES0123\nZZQU+JV/FAKEFIXTUREBYTES4567==\n-----END FIXTURE BLOCK-----\n',
  BACKSL: 'a\\nb\\\\c\\', TRAIL: 'line\n' }
process.stdout.write(Object.entries(vals).map(([k, v]) => `${k}=${esc(v)}\n`).join(''))
JS
out="$(PAD1=vault:a PAD2=vault:b INNER=vault:c PLAIN=vault:d PEM=vault:e BACKSL=vault:f TRAIL=vault:g \
  bash "$T/scripts/vault-env-wrapper.sh" node -e "$DUMP" 2>"$T/err1")"
want="$(PEM_VALUE="$PEM_VALUE" node -e 'process.stdout.write(JSON.stringify({PAD1:"abc=",PAD2:"YWJj==",INNER:"x=y=z",PLAIN:"value",PEM:process.env.PEM_VALUE,BACKSL:"a\\nb\\\\c\\",TRAIL:"line\n"}))')"
[ "$out" = "$want" ] && ok "every value exact (=, multi-line PEM, backslashes, trailing line feed)" || bad "values: got $out"
[ ! -s "$T/err1" ] && ok "the success path writes nothing to stderr" || bad "stderr on success: $(cat "$T/err1")"

# 2. a resolver that does NOT escape (the old format, a multi-line value split into lines): the wrapper still never
#    prints a byte of the value, and exports no variable named after one.
cat > "$T/scripts/vault-resolve.mjs" <<'JS'
process.stdout.write('PLAIN=value\nPEM=-----BEGIN FIXTURE BLOCK-----\nMIGTAgEA+MBMG/FAKEFIXTUREBYTES0123\nZZQU+JV/FAKEFIXTUREBYTES4567==\n-----END FIXTURE BLOCK-----\nPLAIN\n')
JS
# (the last line, "PLAIN" without '=', stands for a split line that happens to equal an asked-for name)
out2="$(PLAIN=vault:d PEM=vault:e bash "$T/scripts/vault-env-wrapper.sh" env 2>"$T/err2")"
if grep -q "FAKEFIXTUREBYTES" "$T/err2"; then bad "old format: value bytes in stderr: $(cat "$T/err2")"; else ok "old format: no value byte in stderr"; fi
if printf '%s\n' "$out2" | grep -q "^MIGTAg\|^ZZQU\|^-----"; then bad "old format: a variable named after value bytes"; else ok "old format: no variable named after value bytes"; fi
printf '%s\n' "$out2" | grep -qx 'PLAIN=value' && ok "old format: the good line still exported" || bad "old format: PLAIN lost"

echo "PASS=$pass FAIL=$fail"; [ "$fail" -eq 0 ]
