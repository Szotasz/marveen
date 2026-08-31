#!/bin/bash
# Marveen - Reggeli napindító
# Trigger: systemd user timer (Linux, <agent>-morning.timer) vagy LaunchAgent
# (macOS), naponta 7:27-kor. Naponta legfeljebb egyszer küld (lásd a guardot).
#
# 2026-08-10: A KÜLDÉS BOT API-VAL MEGY, NEM `--channels`-SZEL. Ne rakd vissza.
# Ez a script systemd oneshotként fut, tehát nincs tmux panelje. Ha `--channels`-
# szel indul, akkor (a) saját Telegram plugint nyit a fő session-nel KÖZÖS
# ~/.claude/channels/<provider>/bot.pid-re, és (b) a dashboard
# reapDetachedChannelClaudes()-e panel nélküli árvának látja és kilövi.
# Akárhogyan is ér véget a plugin, a bot.pid elavul, a channels.sh
# PLUGIN_DEAD_GRACE (180s) után kilép, és a fő session újraindul -- ami a 07:30-as
# session-beli napindítót is elvágta. Mérés (a service VÉGE -> channels halál):
# 08-06 181s, 08-07 179s, 08-09 180s, 08-10 184s, azaz pontosan a grace-ablak.
# (08-08 kilógott, azt nem magyaráztuk meg.) Részletek: channel-disconnect-supervision
# skill + kanban 4204bf42.
#
# Következmény a promptra: a modell NEM küld, csak ELŐÁLLÍTJA a szöveget a
# stdoutra; a küldés alább, curl-lel történik.

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE="$(command -v claude)"
[ -z "$CLAUDE" ] && echo "ERROR: claude not found on PATH" >&2 && exit 1
LOG="$INSTALL_DIR/store/morning.log"

# Load config
if [ -f "$INSTALL_DIR/.env" ]; then
  export $(grep -v '^#' "$INSTALL_DIR/.env" | xargs)
fi

CHAT_ID="${ALLOWED_CHAT_ID:-0}"
CALENDAR_ID="${HEARTBEAT_CALENDAR_ID:-primary}"
TG_ENV="$HOME/.claude/channels/${CHANNEL_PROVIDER:-telegram}/.env"
TOKEN="$(grep -oE '[0-9]+:[A-Za-z0-9_-]+' "$TG_ENV" 2>/dev/null | head -1)"

# Same-day dedup guard: the briefing must go out at most once per calendar
# day no matter how many times the trigger fires (a timer-unit re-activation
# on a systemd user-manager restart, a Persistent= catch-up, or a manual
# re-run). MORNING_FORCE=1 bypasses the guard for deliberate re-sends.
STAMP="$INSTALL_DIR/store/.morning-last-sent"
TODAY="$(date +%F)"
if [ "${MORNING_FORCE:-0}" != "1" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$TODAY" ]; then
  echo "=== Reggeli napindító $(date) -- SKIP: ma már elküldve (guard: $STAMP) ===" >> "$LOG"
  exit 0
fi

echo "=== Reggeli napindító $(date) ===" >> "$LOG"

# Fail BEFORE burning a model call if we could not send the result anyway.
if [ -z "$TOKEN" ]; then
  echo "ERROR: nincs bot token ($TG_ENV) -- kihagyva, nem hívok modellt" >> "$LOG"
  echo "=== Kész $(date) ===" >> "$LOG"
  exit 1
fi
if [ -z "$CHAT_ID" ] || [ "$CHAT_ID" = "0" ]; then
  echo "ERROR: nincs valodi ALLOWED_CHAT_ID -- kihagyva, nem hívok modellt" >> "$LOG"
  echo "=== Kész $(date) ===" >> "$LOG"
  exit 1
fi

cd "$INSTALL_DIR"

# 2026-08-13: SAJÁT CLAUDE_CONFIG_DIR, ÜRES enabledPlugins-szal.
#
# A 08-10-i Bot API-s átállás (lásd a fejlécet) csak a küldést vette ki a
# modellből -- a plugin BETÖLTÉSÉT nem. A headless `claude -p` a megosztott
# ~/.claude/settings.json-t olvassa, abban pedig telegram@claude-plugins-official
# = true, tehát MINDEN reggeli futás nyitott egy második Telegram plugint a fő
# session-nel KÖZÖS ~/.claude/channels/<provider>/bot.pid-re. Amikor a headless
# futás véget ért, a pid elavult, a channels.sh a PLUGIN_DEAD_GRACE (180s) után
# kilépett, és a fő session újraindult. Mérve: 08-11, 08-12, 08-13 -- mindhárom
# reggel, az átállás UTÁN is.
#
# Miért nem a meglévő .channels-config: azt a dashboard MINDEN fő-agens
# induláskor újraprovizionálja (ensureMainAgentIsolatedConfigDir), és az
# enabledPlugins-t a scope-hívás állítja be, nem örökli a fájlból -- az üres
# érték csendben felülíródna. A store/.briefing-config-ot senki nem provizionálja.
#
# A gmail MCP nem innen jön, hanem a projekt .mcp.json-jából (a `cd` fentebb),
# ezért az e-mail szekció megmarad. A .claude.json másolt oauthAccount +
# hasTrustDialogAccepted adja a belépést és a projekt-bizalmat.
BRIEFING_CONFIG="$INSTALL_DIR/store/.briefing-config"
if [ ! -f "$BRIEFING_CONFIG/settings.json" ]; then
  # Fail-closed: csendes visszaesés a közös configra = a fenti hiba visszatérése.
  echo "ERROR: hiányzik a $BRIEFING_CONFIG -- NEM hívok modellt, mert a közös configgal újraindítanám a fő sessiont" >> "$LOG"
  echo "=== Kész $(date) ===" >> "$LOG"
  exit 1
fi
export CLAUDE_CONFIG_DIR="$BRIEFING_CONFIG"

# A saját CLAUDE_CONFIG_DIR-rel a `claude` nem találja a megosztott bejelentkezést
# ("Not logged in"), ezért a tokent ugyanonnan adjuk át, ahonnan a channels.sh a
# fő agenst indítja (lásd scripts/channels.sh CFG_ENV). Fail-closed: token nélkül
# a modellhívás úgyis csak hibát adna vissza.
OAUTH_FILE="$INSTALL_DIR/store/.claude-oauth-token"
if [ ! -s "$OAUTH_FILE" ]; then
  echo "ERROR: hiányzik a $OAUTH_FILE -- NEM hívok modellt (a saját config dir nélküle nincs bejelentkezve)" >> "$LOG"
  echo "=== Kész $(date) ===" >> "$LOG"
  exit 1
fi
export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$OAUTH_FILE")"

# ÖVSZORÍTÓ a fenti üres enabledPlugins mellé. Ha a plugin bármiért mégis
# betöltődne (öröklött env, jövőbeli scope-szabály), a saját STATE_DIR-jébe írja
# a bot.pid-et, nem a fő session-ével közösbe. Mérve 08-13: a plugin kilépéskor
# TÖRLI a bot.pid-et, a channels.sh pedig "disappeared" után 180s-mal kilép --
# pontosan ez vágta el a fő sessiont minden reggel.
BRIEFING_STATE="$(mktemp -d)"
export TELEGRAM_STATE_DIR="$BRIEFING_STATE/telegram"
export DISCORD_STATE_DIR="$BRIEFING_STATE/discord"

OUT="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$OUT" "$ERR"; rm -rf "$BRIEFING_STATE"' EXIT

# NINCS --channels: lásd a fejlécet. A modell csak szöveget ad vissza.
$CLAUDE --dangerously-skip-permissions \
  -p "Reggeli napindító. Állítsd elő a szöveget, de NE küldd el sehová: nincs
csatorna-eszközöd, a küldést a hívó script végzi. A válaszod TELJES EGÉSZE maga
az elküldendő üzenet lesz, ezért ne írj köré bevezetőt, magyarázatot vagy
zárómondatot arról, hogy mit csináltál.

1. Email: az elmúlt 12 óra levelei (gmail MCP), a spam/promó kiszűrve
2. Naptár: a mai nap eseményei a(z) $CALENDAR_ID naptárból, Europe/Budapest.
   NINCS naptár MCP tool -- a REST API-t használd a store/janos-google-token.json
   refresh tokenjével (a client_id/secret a ~/.gmail-mcp/credentials.json-ban van).
3. AI hírek: WebSearch a tegnapi dátumra

Ha egy kategóriában nincs semmi, hagyd ki a szekciót teljesen, ne írd oda hogy üres.
Sima szöveg, NEM markdown (a küldés nem formázott módban megy, a csillagok és
alulvonások nyersen látszanának). A linkeket csupasz URL-ként írd.
Tömör, lényegre törő. Ékezetesen írj magyarul." > "$OUT" 2>"$ERR"
RC=$?

cat "$OUT" >> "$LOG"
[ -s "$ERR" ] && { echo "--- stderr ---" >> "$LOG"; cat "$ERR" >> "$LOG"; }

BODY="$(cat "$OUT")"
if [ "$RC" -ne 0 ] || [ -z "${BODY//[[:space:]]/}" ]; then
  echo "ERROR: a modell nem adott használható szöveget (rc=$RC, ${#BODY} karakter) -- NEM küldök, a napi stamp marad régi" >> "$LOG"
  echo "=== Kész $(date) ===" >> "$LOG"
  exit 1
fi

# 2026-08-19: A DETERMINISZTIKUS SZEKCIOK BEHUZASA (Dream Engine, "amivel el vagyunk
# maradva", flotta-kutatas). MIERT: ot egymast koveto reggel ez a headless ut nyert a
# session-beli utemezett feladattal szemben, es ezek a szekciok EGYIKE SEM volt benne --
#   grep -cE 'DREAM|kanban_cards|waiting|fleet-research' scripts/morning-briefing.sh -> 0
# --, tehat a gazda ot napig nem latta a ra varo dontesek listajat, pedig azt o maga
# kerte (2026-07-26). A ket kuldo kozotti dontes (kanban 4204bf42) tovabbra is nala van;
# ez a valtozas nem donti el, csak a tetjet szunteti meg.
#
# FAIL-OPEN, szandekosan: a szekciok EXTRAK. Ha a generator hibazik vagy uresset ad, a
# napindito email/naptar/AI-hirek resze valtozatlanul kimegy. Forditva nem lenne igaz
# arany: egy kiegeszites nem allithatja meg a fo uzenetet.
SECTIONS="$(bash "$INSTALL_DIR/scripts/morning-sections.sh" 2>>"$LOG")" || SECTIONS=""
if [ -n "${SECTIONS//[[:space:]]/}" ]; then
  BODY="$SECTIONS

$BODY"
  # Log the POSITIVE case too, not just the failure. The log above (line ~137)
  # records the MODEL's raw output, which is captured BEFORE this prepend --
  # so grepping morning.log for "DREAM" can never find the sections even when
  # they were sent perfectly. On 2026-08-20 that nearly cost us the fix: the
  # planned check was `grep -A3 DREAM store/morning.log`, it returned nothing,
  # and the conclusion would have been "the 08-19 wiring failed, roll back to
  # the backup" -- while the sections had in fact gone out at 07:27:59.
  # Proving presence beats inferring it from the absence of a warning.
  echo "SZEKCIOK BEKERULTEK a napinditoba (${#SECTIONS} karakter, a modell szovege ELE)" >> "$LOG"
else
  echo "FIGYELEM: a morning-sections.sh ures/hibas kimenetet adott -- a napindito a szekciok NELKUL megy ki" >> "$LOG"
fi

# Telegram sendMessage hard limit is 4096 chars. Split on paragraph boundaries so
# a long briefing arrives as a few readable parts instead of being truncated.
SENT_OK=1
while IFS= read -r -d '' CHUNK; do
  [ -z "${CHUNK//[[:space:]]/}" ] && continue
  CODE="$(curl -s -m 30 -o /dev/null -w '%{http_code}' \
    "https://api.telegram.org/bot$TOKEN/sendMessage" \
    --data-urlencode "chat_id=$CHAT_ID" \
    --data-urlencode "text=$CHUNK" \
    --data-urlencode "disable_web_page_preview=true")"
  if [ "$CODE" != "200" ]; then
    echo "ERROR: sendMessage HTTP $CODE" >> "$LOG"
    SENT_OK=0
  fi
done < <(printf '%s' "$BODY" | python3 -c '
import sys
text = sys.stdin.read()
LIMIT = 3900
parts, cur = [], ""
for para in text.split("\n\n"):
    cand = para if not cur else cur + "\n\n" + para
    if len(cand) <= LIMIT:
        cur = cand
        continue
    if cur:
        parts.append(cur)
    while len(para) > LIMIT:          # a single paragraph over the limit
        parts.append(para[:LIMIT])
        para = para[LIMIT:]
    cur = para
if cur:
    parts.append(cur)
# Trailing NUL after EVERY part, not just between them: `read -d ""` returns
# non-zero on a chunk that is not delimiter-terminated, so the while-loop would
# silently DROP the last part -- and in the common single-part case that means
# nothing is sent at all while the script still reports success. (Measured
# 2026-08-10 before this ever ran for real.)
for p in parts:
    sys.stdout.write(p + "\0")
')

if [ "$SENT_OK" = "1" ]; then
  echo "$TODAY" > "$STAMP"
  echo "KIKULDVE Bot API-val ($CHAT_ID)" >> "$LOG"
else
  echo "RESZLEGES/SIKERTELEN kuldes -- a napi stamp NEM lett frissitve, a kovetkezo futas ujraprobalja" >> "$LOG"
fi

echo "=== Kész $(date) ===" >> "$LOG"
