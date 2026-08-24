#!/bin/bash
# Scanner conformance: every planted item in known-positive must be found,
# and known-negative must come back with zero findings. A pattern scan
# without a known positive cannot distinguish "clean" from "scanner dead".
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN="$DIR/../bin/mio-scan"

EXPECTED_RULES=(
  ignore-previous-instructions
  ignore-previous-instructions-hu
  role-reassignment
  system-prompt-probe
  fake-system-tag
  imperative-html-comment
  pipe-to-shell
  exfiltrate-instruction
  email-address
  hu-phone-number
  api-key-shaped
  secret-assignment
)

echo "== known-positive =="
POS_JSON="$("$SCAN" < "$DIR/known-positive.txt")"
echo "$POS_JSON" | python3 -m json.tool
FAIL=0
for rule in "${EXPECTED_RULES[@]}"; do
  if ! echo "$POS_JSON" | grep -q "\"$rule\""; then
    echo "MISSING PLANT: $rule was not found by the scanner" >&2
    FAIL=1
  fi
done

echo
echo "== known-negative =="
NEG_JSON="$("$SCAN" < "$DIR/known-negative.txt")"
echo "$NEG_JSON" | python3 -m json.tool
NEG_COUNT=$(echo "$NEG_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['findings']))")
if [[ "$NEG_COUNT" != "0" ]]; then
  echo "FALSE POSITIVES on innocent content: $NEG_COUNT finding(s)" >&2
  FAIL=1
fi

echo
if [[ $FAIL -eq 0 ]]; then
  echo "RESULT: PASS (all plants found, zero false positives)"
else
  echo "RESULT: FAIL" >&2
  exit 1
fi
