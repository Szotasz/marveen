#!/usr/bin/env bash
# Watch the wardrobe video-render queue, so "let's see how the VPS copes" is an
# actual measurement rather than a complaint from a seller.
#
# The number that decides whether a bigger machine is needed is NOT the core
# count, it is how long a seller waits in the queue. One render measured 18,6 s
# on the serving host (2 cores, 2026-08-31); a wait over WAIT_ALERT means work
# was piling up behind it. That is the moment the answer changes.
#
# Token-free: no model runs. Bash, ssh, psql, Telegram Bot API.
set -uo pipefail

HOST="${WARDROBE_HOST:-trueplay-vps}"
STATE_DIR="$HOME/.local/state/bigme"
LASTRUN="$STATE_DIR/wardrobe-queue-watch.lastrun"
SEEN="$STATE_DIR/wardrobe-queue-watch.seen"
FAILS_FILE="$STATE_DIR/wardrobe-queue-watch.fails"
WAIT_ALERT="${WAIT_ALERT:-60}"     # seconds a job spent waiting before we care
mkdir -p "$STATE_DIR"

stamp() { printf '%s %s\n' "$(date -Is)" "$*" > "$LASTRUN"; }

alert() {
  local msg="$1" sum
  # A watcher whose alarm has never been fired is a watcher nobody has tested.
  # DRY_RUN prints what would go out, so the threshold can be proven without
  # sending noise to the owner.
  if [ -n "${DRY_RUN:-}" ]; then printf 'DRY_RUN would send:\n%s\n' "$msg"; stamp "DRY_RUN riasztas-osszeallt"; return 0; fi
  sum=$(printf '%s' "$msg" | md5sum | cut -d' ' -f1)
  if [ "$(cat "$SEEN" 2>/dev/null)" = "$sum" ]; then stamp "OK ugyanaz-a-riasztas-mar-kiment"; return 0; fi
  local tok chat
  tok=$(grep -oE '[0-9]+:[A-Za-z0-9_-]+' "$HOME/.claude/channels/telegram/.env" 2>/dev/null | head -1)
  chat=$(python3 -c "import json;print(json.load(open('$HOME/.claude/channels/telegram/access.json'))['allowFrom'][0])" 2>/dev/null)
  if [ -z "$tok" ] || [ -z "$chat" ]; then stamp "HIBA nincs-telegram-token-vagy-chat"; return 1; fi
  curl -s --max-time 20 -X POST "https://api.telegram.org/bot$tok/sendMessage" \
    --data-urlencode "chat_id=$chat" --data-urlencode "text=$msg" -o /dev/null
  printf '%s' "$sum" > "$SEEN"
  stamp "RIASZTAS elkuldve"
}

# One round trip, bounded: a local timeout kills only the local client, so the
# remote side gets its own limit too.
Q="SELECT
     count(*) FILTER (WHERE j.status='queued')                                   AS waiting_now,
     COALESCE(max(EXTRACT(epoch FROM (j.started_at - j.created_at)))::int, 0)    AS worst_wait,
     count(*) FILTER (WHERE j.started_at - j.created_at > interval '${WAIT_ALERT} seconds') AS slow_waits,
     count(*) FILTER (WHERE j.status='failed')                                   AS failed,
     count(*)                                                                    AS jobs,
     COALESCE(max(j.render_ms), 0)                                               AS worst_render
   FROM post_jobs j
   WHERE j.kind='post' AND j.created_at > now() - interval '24 hours';"

OUT=$(timeout 45 ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
        "timeout 30 sudo -u postgres psql -d wardrobe -tAF'|' -c \"${Q//\"/\\\"}\"" 2>/dev/null | head -1)

if [ -z "$OUT" ]; then
  # A watcher that cannot measure looks exactly like a watcher with nothing to
  # report. Three blind rounds is itself the news.
  N=$(( $(cat "$FAILS_FILE" 2>/dev/null || echo 0) + 1 )); echo "$N" > "$FAILS_FILE"
  stamp "NEM-MERT ($N. kor egymas utan)"
  [ "$N" -ge 3 ] && alert "Wardrobe sor-figyelo: $N egymast koveto korben NEM tudtam merni (ssh vagy psql nem valaszolt a $HOST gepen). A sor allapotarol jelenleg NINCS informaciom."
  exit 0
fi
echo 0 > "$FAILS_FILE"

IFS='|' read -r WAITING WORST SLOW FAILED JOBS WORST_MS <<<"$OUT"

if [ "${SLOW:-0}" -gt 0 ]; then
  alert "Wardrobe sor: TORLODAS. Az elmult 24 oraban $SLOW olyan video volt, amelyik ${WAIT_ALERT} masodpercnel tobbet VART a soran (a leghosszabb varakozas ${WORST} mp). Egy rendereles maga kb 19 mp. Ez az a jel, amirol beszeltunk: innentol a tobb mag valodi kerdes, nem elmelet. Osszes poszt 24 oraban: $JOBS."
elif [ "${FAILED:-0}" -gt 0 ]; then
  alert "Wardrobe sor: $FAILED elhibazott rendereles az elmult 24 oraban ($JOBS posztbol). Ez nem fogyasztott keretet a vevoknel, de meg kell nezni miert bukott."
else
  stamp "OK jobs=$JOBS varakozik=$WAITING leghosszabb-varakozas=${WORST}mp leghosszabb-render=${WORST_MS}ms"
  : > "$SEEN"
fi
exit 0
