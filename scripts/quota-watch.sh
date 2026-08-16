#!/usr/bin/env bash
# Tisztan helyi, Claude-kvotat NEM fogyaszto kvota-figyeles es automatikus
# DeepSeek-atallitas (Jozsi, 2026-08-16 -- "en azt hittem van helyi LLM").
#
# MIERT KULON A KORABBI Claude-heartbeat-alapu valtozattol: az elozo valtozat
# (scheduled-task "kvota-deepseek-valto") minden futasnal EGY VALODI Claude
# fordulot koltott, meg akkor is, ha nem volt teendo -- ez EPP AZT a kvotat
# fogyasztotta, aminek a kimeruleset figyelnie kellett volna. Ez a script
# tiszta bash+python, launchd StartInterval-lal hivva, NULLA Claude-hivassal.
#
# ADAPTIV UTEMEZES (Jozsi kerese, 2026-08-16 22:53): a launchd 15 percenkent
# hiv, de a script ONMAGAT fekezi -- 90% ALATT csak oranta vegez TENYLEGES
# ellenorzest (a kozbulso hivasok nulla-koltsegu no-op-ok), 90% FOLOTT minden
# hivas teny ellenorzes (~15 percenkent).
#
# MIT CSINAL 98%-nal: lefuttatja a model-provider-switch.sh to-deepseek-et
# (a 8 sub-agentre), majd ir egy ertesito-flaget (store/quota-watch-notify.json),
# amit a legkozelebbi Claude-heartbeat felolvas es Telegramon jelez + beallitja
# a visszavaltas utemezeset. A fo-agenst (marveen) EZ A SCRIPT SEM erinti --
# annak sajat modell-valtasa es ujrainditasa Claude-dontest (mikor van
# "termeszetes fordulohatar") igenyel, azt a flag-alapu ertesites vezerli be.
#
# Hasznalat:
#   bash scripts/quota-watch.sh            # normal futas (launchd hivja)
#   bash scripts/quota-watch.sh --force    # a fekezest atugorja, mindig teny ellenorzes
#   bash scripts/quota-watch.sh --self-test

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUOTA_FILE="${QUOTA_STATUS_FILE:-$REPO_ROOT/store/quota-status.json}"
STATE_FILE="${QUOTA_WATCH_STATE_FILE:-$REPO_ROOT/store/quota-watch-state.json}"
NOTIFY_FILE="${QUOTA_WATCH_NOTIFY_FILE:-$REPO_ROOT/store/quota-watch-notify.json}"
SWITCH_STATE_FILE="${MODEL_SWITCH_STATE_FILE:-$REPO_ROOT/store/model-switch-state.json}"
SWITCH_SCRIPT="${MODEL_SWITCH_SCRIPT:-$REPO_ROOT/scripts/model-provider-switch.sh}"

THRESHOLD_ACTION=98      # e felett indul a DeepSeek-atallitas
THRESHOLD_TIGHT=90       # e felett minden 15 perces hivas teny ellenorzes
LOOSE_INTERVAL_SEC=3600  # e alatt legfeljebb oranta egy teny ellenorzes

now_epoch() { python3 -c "import time; print(int(time.time()))"; }

run_check() {
  local force="$1"
  if [ ! -f "$QUOTA_FILE" ]; then
    echo "quota-watch: $QUOTA_FILE nincs -- meg nem irt statuszlinort a session." >&2
    return 0
  fi

  local pct
  pct=$(python3 -c "
import json
try:
    d = json.load(open('$QUOTA_FILE'))
    p = d.get('seven_day_used_percentage')
    print(p if isinstance(p, (int, float)) else -1)
except Exception:
    print(-1)
")
  if [ "$pct" = "-1" ]; then
    echo "quota-watch: seven_day_used_percentage nem olvashato -- kihagyva." >&2
    return 0
  fi

  local now last_full
  now=$(now_epoch)
  last_full=0
  [ -f "$STATE_FILE" ] && last_full=$(python3 -c "
import json
try: print(int(json.load(open('$STATE_FILE')).get('last_full_check', 0)))
except Exception: print(0)
")

  # FEKEZES: 90% alatt legfeljebb oranta egy TENY ellenorzes -- a kozbulso
  # launchd-hivasok nulla-koltsegu no-op-ok (nincs fajlolvasason es egy
  # aritmetikan tul semmi).
  local do_full=1
  if [ "$force" != "1" ]; then
    python3 -c "
import sys
pct = $pct
now = $now
last = $last_full
sys.exit(0 if (pct < $THRESHOLD_TIGHT and (now - last) < $LOOSE_INTERVAL_SEC) else 1)
"
    [ $? -eq 0 ] && do_full=0
  fi
  [ "$do_full" = "0" ] && return 0

  # Innentol TENYLEGES ellenorzes -- allapot-frissites, fuggetlenul attol,
  # tortenik-e valtas.
  printf '{"last_full_check": %s, "last_pct": %s}\n' "$now" "$pct" > "$STATE_FILE"

  python3 -c "import sys; sys.exit(0 if $pct >= $THRESHOLD_ACTION else 1)"
  if [ $? -ne 0 ]; then
    return 0  # kuszob alatt, csendben vege
  fi

  if [ -f "$SWITCH_STATE_FILE" ]; then
    return 0  # mar valtva vagyunk (vagy egy korabbi valtas fel-vegzett) -- nincs teendo
  fi

  echo "quota-watch: $pct% >= $THRESHOLD_ACTION% -- valtas DeepSeek-re."
  local switch_out_file switch_rc
  switch_out_file="$(mktemp)"
  bash "$SWITCH_SCRIPT" to-deepseek > "$switch_out_file" 2>&1
  switch_rc=$?

  local resets_at
  resets_at=$(python3 -c "
import json
try: print(json.load(open('$QUOTA_FILE')).get('seven_day_resets_at', ''))
except Exception: print('')
")

  # switch_out_file-bol olvasva, NEM shell-interpolalva -- a kimenet
  # tetszoleges idezojelet/ujsort tartalmazhat, es ez elkeruli az injekciot.
  python3 -c "
import json
out = open('$switch_out_file').read()
json.dump({
    'pct': $pct,
    'switch_ok': $switch_rc == 0,
    'switch_output': out,
    'resets_at': '$resets_at',
    'notified_at': None,
}, open('$NOTIFY_FILE', 'w'))
"
  rm -f "$switch_out_file"
  echo "quota-watch: ertesito flag irva ($NOTIFY_FILE), a kovetkezo Claude-heartbeat relezi Telegramra."
}

self_test() {
  local rc=0
  local tmp_quota tmp_state tmp_notify tmp_switch_state
  tmp_quota="$(mktemp)"; tmp_state="$(mktemp)"; tmp_notify="$(mktemp)"; tmp_switch_state="$(mktemp)"
  rm -f "$tmp_state" "$tmp_notify" "$tmp_switch_state"

  # 1. 90% ALATT, NINCS elozo allapot -> teny ellenorzes fusson (last_full=0,
  #    tehat now-0 > LOOSE_INTERVAL biztosan), de a kuszob alatt marad, NEM valt.
  echo '{"seven_day_used_percentage": 50, "seven_day_resets_at": 1787400000}' > "$tmp_quota"
  QUOTA_STATUS_FILE="$tmp_quota" QUOTA_WATCH_STATE_FILE="$tmp_state" QUOTA_WATCH_NOTIFY_FILE="$tmp_notify" \
    MODEL_SWITCH_STATE_FILE="$tmp_switch_state" bash "${BASH_SOURCE[0]}" >/dev/null 2>&1
  [ -f "$tmp_state" ] || { echo "BUKIK 1: allapot-fajl nem jott letre az elso (kenyszeritett) teny-ellenorzesnel"; rc=1; }
  [ -f "$tmp_notify" ] && { echo "BUKIK 1: notify-flag irodott 50%-nal (nem kellett volna)"; rc=1; }

  # 2. UGYANAZ a hivas KOZVETLENUL utana, 90% alatt -> FEKEZVE, allapot valtozatlan marad.
  local before_mtime after_mtime
  before_mtime=$(stat -f '%m' "$tmp_state")
  QUOTA_STATUS_FILE="$tmp_quota" QUOTA_WATCH_STATE_FILE="$tmp_state" QUOTA_WATCH_NOTIFY_FILE="$tmp_notify" \
    MODEL_SWITCH_STATE_FILE="$tmp_switch_state" bash "${BASH_SOURCE[0]}" >/dev/null 2>&1
  after_mtime=$(stat -f '%m' "$tmp_state")
  [ "$before_mtime" = "$after_mtime" ] || { echo "BUKIK 2: 90% alatt a masodik hivas is teny-ellenorzest vegzett (fekezesnek kellett volna)"; rc=1; }

  # 3. 98%+ ES nincs meglevo switch-allapot -> a switch szkript (stub-bal
  #    helyettesitve) meghivodik es notify-flag irodik.
  echo '{"seven_day_used_percentage": 99, "seven_day_resets_at": 1787400000}' > "$tmp_quota"
  local stub_switch
  stub_switch="$(mktemp)"
  cat > "$stub_switch" <<'STUBEOF'
#!/usr/bin/env bash
echo "STUB: $1 hivva"
exit 0
STUBEOF
  chmod +x "$stub_switch"
  QUOTA_STATUS_FILE="$tmp_quota" QUOTA_WATCH_STATE_FILE="$tmp_state" QUOTA_WATCH_NOTIFY_FILE="$tmp_notify" \
    MODEL_SWITCH_STATE_FILE="$tmp_switch_state" MODEL_SWITCH_SCRIPT="$stub_switch" \
    bash "${BASH_SOURCE[0]}" --force >/dev/null 2>&1
  [ -f "$tmp_notify" ] || { echo "BUKIK 3: 99%-nal --force-szal nem irodott notify-flag"; rc=1; }
  rm -f "$stub_switch"

  rm -f "$tmp_quota" "$tmp_state" "$tmp_notify" "$tmp_switch_state"
  if [ "$rc" -eq 0 ]; then echo "ONTESZT: OK"; else echo "ONTESZT: BUKOTT"; fi
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test ;;
  --force) run_check 1 ;;
  *) run_check 0 ;;
esac
