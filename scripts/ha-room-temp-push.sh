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
# peci01 sits in garage 2 (Viktor, 2026-08-06), so only that sensor is shown;
# garazs1 (sensor.shellyht_34bc74_temperature) was dropped on the same call.
# garazs2: where peci01 sits until the machine-room move; mt15_kucko: the Tuya
# 15-in-1 that will watch the machine room (#289). Both flow to the page; the
# gree-thermostat on peci01 matches on the machine key, not the display name.
SENSORS="${SENSORS:-sensor.garazs2_temperature sensor.mt15_kucko_temperature}"
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
printf '%s\n' "$payload" | ssh -i "$KEY" -o ConnectTimeout=8 -o BatchMode=yes "$PECI" \
  "cat > '$DEST.tmp' && mv -f '$DEST.tmp' '$DEST' && chmod 644 '$DEST'"
