#!/usr/bin/env bash
# A flotta sub-agenseinek modell-szolgaltato-valtasa Claude <-> DeepSeek kozott,
# a heti Max 20x kvota kimerulesere keszulve (Jozsi, 2026-08-16).
#
# MIT CSINAL: minden FUTO, marveen-en KIVULI fej modelljet atallitja es ujraindit
# vele friss ablakkal (--model csak inditaskor ervenyesul, menet kozben nem valt).
#
# MIT NEM CSINAL: a fo-agenst (marveen) NEM erinti -- annak sajat ujrainditasa a
# --channels sessiont is megolne, es a live Telegram-beszelgetest szakitana meg.
# Azt kulon, kezzel, alkalmas pillanatban kell atallitani (lasd a script vegi
# kiirast).
#
# ALLAPOT: store/model-switch-state.json -- a valtas ELOTTI modelleket orzi, hogy
# a visszavaltas PONTOSAN oda alljon vissza, ahol volt (nem egy hardkodolt "sonnet").
#
# Hasznalat:
#   bash scripts/model-provider-switch.sh to-deepseek [--dry-run]
#   bash scripts/model-provider-switch.sh to-claude   [--dry-run]
#   bash scripts/model-provider-switch.sh --self-test

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="${MODEL_SWITCH_STATE_FILE:-$REPO_ROOT/store/model-switch-state.json}"
TOKEN_FILE="${DASHBOARD_TOKEN_FILE:-$REPO_ROOT/store/.dashboard-token}"
BASE_URL="${MARVEEN_BASE_URL:-http://localhost:3420}"
DEEPSEEK_MODEL="deepseek-v4-pro"

api() {
  # api METHOD PATH [JSON-BODY]
  local method="$1" path="$2" body="${3:-}"
  local token
  token="$(cat "$TOKEN_FILE" 2>/dev/null)"
  if [ -n "$body" ]; then
    curl -s -X "$method" -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "$body" "$BASE_URL$path"
  else
    curl -s -X "$method" -H "Authorization: Bearer $token" "$BASE_URL$path"
  fi
}

to_deepseek() {
  local dry_run="$1"

  # Az allapot-fajl ellenorzese ELOBB jon, mint a kulcs-ellenorzes: olcsobb (nincs
  # HTTP-hivas), es igy a ket hibaosztaly (mar valtottunk / nincs kulcs) EGYMASTOL
  # FUGGETLENUL merheto -- onteszt is erre epul.
  if [ -f "$STATE_FILE" ]; then
    echo "MEGALLT: $STATE_FILE mar letezik -- ugy nez ki, mar DeepSeek-en allunk (vagy egy korabbi valtas fel-vegzett). Nezd at kezzel, mielott ujra futtatod." >&2
    return 1
  fi

  local configured
  configured=$(api GET /api/models/available | python3 -c "import json,sys; print(json.load(sys.stdin).get('deepseekConfigured'))")
  if [ "$configured" != "True" ]; then
    echo "MEGALLT: DEEPSEEK_API_KEY nincs bealitva a vaultban -- a valtas MOST nem mukodne (401 az elso hivasnal)." >&2
    echo "Bealitas: curl -X POST $BASE_URL/api/vault -H 'Content-Type: application/json' -d '{\"id\":\"DEEPSEEK_API_KEY\",\"label\":\"DeepSeek API Key\",\"value\":\"<kulcs>\"}'" >&2
    return 1
  fi

  # Egyetlen /api/agents hivasbol epul az allapot: {agent: eredeti_modell},
  # csak a FUTO, marveen-en kivuli fejekre -- ez lesz a STATE_FILE tartalma,
  # es ez adja a feldolgozando nevek listajat is (nincs kulon HTTP-hivas fejenkent).
  local state
  state=$(api GET /api/agents | python3 -c "
import json, sys
agents = json.load(sys.stdin)
out = {a['name']: (a.get('model') or '') for a in agents if a.get('running') and a['name'] != 'marveen'}
print(json.dumps(out))
")

  local agent_count
  agent_count=$(echo "$state" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
  if [ "$agent_count" = "0" ]; then
    echo "Nincs futo sub-agent -- nincs mit atallitani." >&2
    return 0
  fi

  if [ "$dry_run" = "1" ]; then
    echo "DRY-RUN -- ez torténne ($agent_count fej, allapot NEM iródik, senki NEM all at):"
    echo "$state" | python3 -m json.tool
    return 0
  fi

  printf '%s\n' "$state" > "$STATE_FILE"
  echo "Allapot mentve: $STATE_FILE ($agent_count fej)"

  echo "$state" | python3 -c "import json,sys; [print(n) for n in json.load(sys.stdin)]" | while IFS= read -r name; do
    [ -z "$name" ] && continue
    echo "-> $name: valtas $DEEPSEEK_MODEL-re"
    api PUT "/api/agents/$name" "{\"model\":\"$DEEPSEEK_MODEL\"}" >/dev/null
    api POST "/api/agents/$name/restart" '{"fresh":true}' >/dev/null
  done

  echo ""
  echo "KESZ. Minden futo sub-agent DeepSeek-V4-Pro-ra allt at, friss ablakkal (a korabbi kontextusuk elveszett -- ez a valtas ara)."
  echo "A fo-agens (marveen, ez a session) VALTOZATLAN maradt -- ha ot is at kell allitani, azt kulon, alkalmas pillanatban, kezzel kell megtenni (a sajat ujrainditasa a Telegram-csatornat is megszakitja)."
}

to_claude() {
  local dry_run="$1"
  if [ ! -f "$STATE_FILE" ]; then
    echo "MEGALLT: $STATE_FILE nincs -- nincs mit visszaallitani (vagy sosem valtottunk, vagy mar visszaallt)." >&2
    return 1
  fi

  local state
  state=$(cat "$STATE_FILE")

  if [ "$dry_run" = "1" ]; then
    echo "DRY-RUN -- ez torténne (allapot NEM torlódik, senki NEM all at):"
    echo "$state" | python3 -m json.tool
    return 0
  fi

  echo "$state" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for name, model in d.items():
    print(f'{name}\t{model}')
" | while IFS=$'\t' read -r name model; do
    [ -z "$name" ] && continue
    if [ -z "$model" ] || [ "$model" = "None" ]; then
      echo "-> $name: nincs rogzitett eredeti modell, kihagyva (marad a jelenlegi)."
      continue
    fi
    echo "-> $name: visszaallitas $model-re"
    api PUT "/api/agents/$name" "{\"model\":\"$model\"}" >/dev/null
    api POST "/api/agents/$name/restart" '{"fresh":true}' >/dev/null
  done

  rm -f "$STATE_FILE"
  echo ""
  echo "KESZ. Minden fej visszaallt a Claude-modelljere, friss ablakkal. Allapot-fajl torolve."
}

self_test() {
  local rc=0
  local tmp_state
  tmp_state="$(mktemp)"
  rm -f "$tmp_state"

  # to-claude MEGALLJON, ha nincs allapot-fajl (fail-closed: ne allitson vissza
  # tetszoleges/hardkodolt modellre, ha nem tudjuk, mi volt elotte).
  local out ec
  out=$(MODEL_SWITCH_STATE_FILE="$tmp_state" bash "${BASH_SOURCE[0]}" to-claude 2>&1)
  ec=$?
  if [ "$ec" -eq 0 ]; then
    echo "BUKIK: to-claude allapot-fajl nelkul is 0-val tert vissza (fail-closed varva)"; rc=1
  fi
  echo "$out" | grep -q "MEGALLT" || { echo "BUKIK: to-claude nem irta ki a MEGALLT-ot"; rc=1; }

  # to-deepseek MEGALLJON, ha mar letezik allapot-fajl (ne irja felul egy korabbi
  # valtas eredeti-modell rekordjait egy masodik futassal).
  echo '{"proba":"x"}' > "$tmp_state"
  out=$(MODEL_SWITCH_STATE_FILE="$tmp_state" bash "${BASH_SOURCE[0]}" to-deepseek 2>&1)
  ec=$?
  if [ "$ec" -eq 0 ]; then
    echo "BUKIK: to-deepseek meglevo allapot-fajl mellett is 0-val tert vissza"; rc=1
  fi
  echo "$out" | grep -q "mar letezik" || { echo "BUKIK: to-deepseek nem jelezte a meglevo allapot-fajlt"; rc=1; }
  rm -f "$tmp_state"

  if [ "$rc" -eq 0 ]; then echo "ONTESZT: OK"; else echo "ONTESZT: BUKOTT"; fi
  return "$rc"
}

case "${1:-}" in
  to-deepseek) to_deepseek "$([ "${2:-}" = "--dry-run" ] && echo 1 || echo 0)" ;;
  to-claude)   to_claude   "$([ "${2:-}" = "--dry-run" ] && echo 1 || echo 0)" ;;
  --self-test) self_test ;;
  *) echo "Hasznalat: $0 to-deepseek|to-claude [--dry-run]  |  $0 --self-test" >&2; exit 1 ;;
esac
