#!/bin/bash
# Marveen - Reggeli napindító
# Trigger: systemd user timer (Linux, <agent>-morning.timer) vagy LaunchAgent
# (macOS), naponta 7:27-kor. Naponta legfeljebb egyszer küld (lásd a guardot).
#
# A Linux telepítő 2026-09-13 óta NEM engedélyezi ezt a timert: ugyanazt a
# munkát a beseedelt reggeli-napindito scheduled task végzi 07:30-kor, az élő
# csatorna-munkamenetben, ahol VAN channel allowlist. Ez a script a tartalék
# és a kézi út marad (systemctl --user enable --now <agent>-morning.timer,
# vagy MORNING_FORCE=1 mellett közvetlen futtatás).

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# CLAUDE_BIN overrides the lookup. The PATH export above is deliberate (systemd
# hands this script a minimal PATH), but it also wipes anything a caller put in
# front -- so a test cannot substitute a stub by prepending to PATH, and would
# silently drive the REAL binary instead. The seam keeps the hermetic tests
# hermetic; nothing in production sets it.
CLAUDE="${CLAUDE_BIN:-$(command -v claude)}"
[ -z "$CLAUDE" ] && echo "ERROR: claude not found on PATH" >&2 && exit 1
LOG="$INSTALL_DIR/store/morning.log"

# Load config
if [ -f "$INSTALL_DIR/.env" ]; then
  export $(grep -v '^#' "$INSTALL_DIR/.env" | xargs)
fi

CALENDAR_ID="${HEARTBEAT_CALENDAR_ID:-primary}"

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

cd "$INSTALL_DIR"

# CHATID0: the ALLOWED_CHAT_ID:-0 default used to hand the installer
# placeholder straight to the prompt as a real chat id. resolve_owner_chat_id
# refuses "0"/empty and falls back to the paired channel (access.json) --
# with neither, the run must not start at all: no owner chat, nothing to
# deliver, no point spending the model call, and NO stamp (so the guard
# retries next trigger instead of silently marking the day done).
. "$INSTALL_DIR/scripts/lib/owner-chat.sh"
if ! CHAT_ID="$(resolve_owner_chat_id "$INSTALL_DIR/.env" 2>>"$LOG")"; then
  echo "=== Reggeli napindító kihagyva: nincs tulajdonos-chat (guard nem pecsételve) ===" >> "$LOG"
  exit 0
fi

# Delivery-proof sentinel. The dedup stamp must record "the briefing REACHED
# the owner", not "the process exited 0" -- those diverged on 2026-09-13: the
# run refused the task (empty channel allowlist in its config dir, so the reply
# tool rejected the chat_id), printed an explanation, exited 0, and stamped the
# day as done. The owner got nothing and the guard suppressed every retry. Now
# the run must print SENTINEL as its last line, which it is told to do ONLY
# after a reply tool call actually succeeded; no sentinel means no stamp, so the
# next trigger tries again.
#
# Per-run nonce suffix: the sentinel is spelled out inside the prompt, so a
# fixed constant is a control trigger that matches its own instruction text --
# a run that QUOTES the instruction ("...print MORNING_SENT_OK...") on a bare
# line would stamp a day that was never delivered. With the nonce, the only
# string that stamps is the one THIS run was asked to print, and yesterday's
# transcript (or a hardcoded echo) can never satisfy today's gate.
SENTINEL="MORNING_SENT_OK_$(date +%s)_$$"
RUN_OUT="$(mktemp)"
trap 'rm -f "$RUN_OUT"' EXIT

CLAUDE_CODE_DISABLE_AGENT_VIEW=1 $CLAUDE --dangerously-skip-permissions \
  --channels plugin:telegram@claude-plugins-official \
  -p "Reggeli napindító - készítsd el és küld el Telegramra (chat_id: $CHAT_ID).

1. Email check: search_emails az elmúlt 12 órából, szűrd ki a spam/promo emaileket
2. Naptár: list-events a mai napra a $CALENDAR_ID naptárból (Europe/Budapest timezone)
3. AI hírek: WebSearch \"AI news [tegnapi dátum]\"
4. Küld el Telegramra a reply tool-lal (chat_id: $CHAT_ID)

Tömör, lényegre törő. Ékezetesen írj magyarul.

FONTOS, a kézbesítés visszaigazolása: ha a Telegram küldés TÉNYLEGESEN sikerült
(a reply tool hibamentesen lefutott), akkor a válaszod UTOLSÓ sora pontosan ez
legyen, önmagában: $SENTINEL
Ha bármi miatt nem ment ki az üzenet (eszköz nem elérhető, hiba, megtagadás,
visszakérdezés), akkor EZT A SORT NE írd ki. Ilyenkor írd le egy mondatban, mi
akadályozta meg a küldést." > "$RUN_OUT" 2>&1
RUN_RC=$?

cat "$RUN_OUT" >> "$LOG"

if [ "$RUN_RC" -eq 0 ] && grep -qx "$SENTINEL" "$RUN_OUT"; then
  echo "$TODAY" > "$STAMP"
  echo "=== Kézbesítve, guard bepecsételve: $TODAY ===" >> "$LOG"
else
  echo "=== NEM kézbesítve (rc=$RUN_RC, sentinel hiányzik) -- guard NEM pecsételve, a következő trigger újra próbálja ===" >> "$LOG"
fi

echo "=== Kész $(date) ===" >> "$LOG"
