#!/usr/bin/env bash
# Pulls room temperatures from Home Assistant and pushes them into the
# start.otthon webroot on peci01 (card #273/#274). Runs on the marveen box, not
# on peci01: peci01 sits on 192.168.2.x and cannot reach the 192.168.1.x net
# where HA lives, while this box reaches both (HA on its own LAN, peci01 over
# the WireGuard tunnel). status-gen.sh on peci01 merges the pushed file into
# status.json and drops it when it goes stale, so if this box is off the page
# shows nothing rather than an old number.
set -euo pipefail
cd "$(dirname "$0")/.."

HA_URL="${HA_URL:-http://192.168.1.124:8123}"
# mt15_kucko: the Tuya 15-in-1 watching the machine room, where all units now
# live (#289). garazs2 was dropped 2026-08-08 once peci01 moved out of the
# garage -- its reading is no longer "the room". (Viktor may move peci01 back to
# garazs2 for winter ~mid-October: the machine warms that car-garage usefully in
# cold months; if so, re-add sensor.garazs2_temperature here.)
# The gree-thermostat on peci01 matches on the machine key, not the display name.
SENSORS="${SENSORS:-sensor.mt15_kucko_temperature}"
PECI="${PECI:-viktor@192.168.2.122}"
KEY="${KEY:-$HOME/.ssh/atlas-crm-migration-ed25519}"
DEST="${DEST:-/mnt/data/start-otthon/room-temp.json}"

TOKEN=$(echo "T=homeassistant-long-live-token" | node scripts/vault-resolve.mjs | cut -d= -f2-)
[ -n "$TOKEN" ] || { echo "vault resolve failed" >&2; exit 1; }

payload=$(for s in $SENSORS; do
  curl -s --connect-timeout 5 --max-time 10 \
    -H "Authorization: Bearer $TOKEN" "$HA_URL/api/states/$s"
  echo
done | python3 -c '
import json, sys, time
from datetime import datetime
now = time.time()
rooms = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        s = json.loads(line)
        c = float(s["state"])
        ts = datetime.fromisoformat(s["last_updated"]).timestamp()
    except (ValueError, KeyError, TypeError):
        continue
    # A battery sensor that has not reported for 2h is dead or asleep for
    # good; its last value is not the current room temperature.
    if now - ts > 7200:
        continue
    name = s.get("attributes", {}).get("friendly_name") or s["entity_id"]
    name = name.replace(" Temperature", "").strip()
    # Stable machine key alongside the display name: consumers (the peci01
    # gree-thermostat) must not have to match on accented, renamable labels.
    key = s["entity_id"]
    key = key[len("sensor."):] if key.startswith("sensor.") else key
    key = key[:-len("_temperature")] if key.endswith("_temperature") else key
    rooms.append({"key": key, "name": name, "c": round(c, 1), "updated_unix": int(ts)})
print(json.dumps({"fetched_unix": int(now), "rooms": rooms}))
')

[ -n "$payload" ] || { echo "empty payload" >&2; exit 1; }
# The remote side reports the PREVIOUS fetched_unix before overwriting, so this
# box can tell how long the chain was blind (card #310: a 9-hour overnight gap
# produced 229 journal-only alerts on peci01 and nobody heard about it). The
# old-value read must never block the push itself, hence the || echo 0.
old=$(printf '%s\n' "$payload" | ssh -i "$KEY" -o ConnectTimeout=8 -o BatchMode=yes "$PECI" \
  "old=\$(python3 -c \"import json;print(int(json.load(open('$DEST')).get('fetched_unix',0)))\" 2>/dev/null || echo 0); cat > '$DEST.tmp' && mv -f '$DEST.tmp' '$DEST' && chmod 644 '$DEST'; echo \"\$old\"")

GAP_ALERT_SEC="${GAP_ALERT_SEC:-1800}"
CHAT_ID="${CHAT_ID:-1061406155}"
now_unix=$(date +%s)
if [ "${old:-0}" -gt 0 ] && [ $((now_unix - old)) -gt "$GAP_ALERT_SEC" ]; then
  gap_min=$(( (now_unix - old) / 60 ))
  # once-per-day: a flapping link must not turn this into a alert storm.
  python3 scripts/hooks/telegram_fallback_send.py "$CHAT_ID" \
    "[gépterem] A szenzor-push ${gap_min} percig állt, a termosztát addig vak volt (fail-closed, a klímához nem nyúlt). A lánc most újra él." \
    --once-per-day klima-lanc-gap || true
fi
