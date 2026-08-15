#!/usr/bin/env bash
# A heti/5 oras Claude-keret allasat fajlba irja, hogy a flotta GEPIESEN olvashassa.
#
# MIERT LETEZIK: a keret allasa eddig CSAK a /usage kepernyon latszott, ember szamara.
# 2026-08-06-an a 80%-os fagyasztasi kuszobrol Marveen es a vonalvezetok is kimondtak,
# hogy "a 80%-ot en nem latom" -- a kuszob merese es bejelentese azota is kezi, a gazdara
# harult. A Claude Code statusline-ja viszont MINDEN hivasnal atadja a rate_limits blokkot
# az STDIN JSON-ban; ez a script azt menti ki.
#
# BEMENET: a statusline JSON az STDIN-en (a Claude Code adja).
# KIMENET: <repo>/store/quota-status.json, atomikus cserevel (tmp + mv), hogy az olvaso
#          soha ne lasson felkesz fajlt. Tobb session parhuzamosan irhat: az utolso nyer,
#          es minden peldany onmagaban konzisztens.
#
# NEM IR, HA nincs rate_limits a bemenetben (a Claude Code sajat doksija szerint az csak
# elofizetesnel, az ELSO API-valasz utan jelenik meg). Ilyenkor a korabbi allapot MARAD --
# egy friss session inditasa nem torolheti a meg ervenyes merest.
#
# Onteszt (a kaput bukas-eloallitassal kell igazolni, nem feltetelezessel):
#   bash scripts/quota-status-write.sh --self-test

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="${QUOTA_STATUS_FILE:-$REPO_ROOT/store/quota-status.json}"

write_status() {
  local out="$1"
  local payload
  payload=$(jq -c '
    if (.rate_limits // empty) == null then empty
    else {
      five_hour_used_percentage: (.rate_limits.five_hour.used_percentage // null),
      five_hour_resets_at:       (.rate_limits.five_hour.resets_at       // null),
      seven_day_used_percentage: (.rate_limits.seven_day.used_percentage // null),
      seven_day_resets_at:       (.rate_limits.seven_day.resets_at       // null),
      model:                     (.model.display_name // null),
      measured_at:               (now | floor)
    }
    end
  ' 2>/dev/null)

  # Ures kimenet = nincs rate_limits a bemenetben -> NEM irunk, a korabbi meres marad.
  [ -z "$payload" ] && return 0

  local tmp
  tmp="$(mktemp "${out}.tmp.XXXXXX")" || return 0
  printf '%s\n' "$payload" > "$tmp" && mv -f "$tmp" "$out" || rm -f "$tmp"
}

self_test() {
  local tmpdir rc=0
  tmpdir="$(mktemp -d)"
  # A trap a BEALLITASKOR ertekelodik ki (dupla idezojel): a $tmpdir a self_test lokalis
  # valtozoja, es a fuggvenybol kilepve mar nem lenne lathato az EXIT-kor.
  trap "rm -rf '$tmpdir'" EXIT
  local target="$tmpdir/quota-status.json"

  # 1. POZITIV: teljes rate_limits -> a fajl letrejon, a ket szazalek pontosan atmegy.
  printf '%s' '{"rate_limits":{"five_hour":{"used_percentage":6,"resets_at":1786500000},
                "seven_day":{"used_percentage":47,"resets_at":1786700000}},
                "model":{"display_name":"Opus 5"}}' \
    | QUOTA_STATUS_FILE="$target" bash "${BASH_SOURCE[0]}"

  if [ ! -f "$target" ]; then
    echo "BUKIK 1: a fajl nem jott letre teljes rate_limits mellett"; rc=1
  else
    local got_week got_hour
    got_week=$(jq -r '.seven_day_used_percentage' "$target")
    got_hour=$(jq -r '.five_hour_used_percentage' "$target")
    [ "$got_week" = "47" ] || { echo "BUKIK 1: seven_day=$got_week (varva 47)"; rc=1; }
    [ "$got_hour" = "6" ]  || { echo "BUKIK 1: five_hour=$got_hour (varva 6)"; rc=1; }
  fi

  # 2. NEGATIV: rate_limits NELKULI bemenet NEM irhatja felul a korabbi merest.
  printf '%s' '{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":12}}' \
    | QUOTA_STATUS_FILE="$target" bash "${BASH_SOURCE[0]}"
  local after
  after=$(jq -r '.seven_day_used_percentage' "$target" 2>/dev/null)
  [ "$after" = "47" ] || { echo "BUKIK 2: rate_limits nelkuli bemenet elrontotta ($after)"; rc=1; }

  # 3. NEGATIV: nem-JSON bemenet nem dob es nem ir felul.
  printf '%s' 'ez nem json' | QUOTA_STATUS_FILE="$target" bash "${BASH_SOURCE[0]}"
  after=$(jq -r '.seven_day_used_percentage' "$target" 2>/dev/null)
  [ "$after" = "47" ] || { echo "BUKIK 3: nem-JSON bemenet elrontotta ($after)"; rc=1; }

  # 4. Nem maradhat .tmp szemet a celkonyvtarban.
  local leftovers
  leftovers=$(find "$tmpdir" -name 'quota-status.json.tmp.*' | wc -l | tr -d ' ')
  [ "$leftovers" = "0" ] || { echo "BUKIK 4: $leftovers db tmp fajl maradt"; rc=1; }

  [ $rc -eq 0 ] && echo "ONTESZT OK (4 eset: pozitiv + harom negativ)"
  return $rc
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi

write_status "$OUT_FILE"
