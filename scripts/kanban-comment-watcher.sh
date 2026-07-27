#!/bin/bash
# kanban-comment-watcher: surfaces NEW comments on marveen-assigned cards into
# marveen's session as inter-agent messages, so Viktor can give feedback on a
# card and Marveen actually sees it (kanban comments do not notify by default).
#
# Filter: card.assignee = marveen AND lower(comment.author) != 'marveen'
#   -> catches Viktor's UI comments + other agents flagging a marveen card;
#      excludes Marveen's own comments (no self-loop).
# Delivery: POST /api/messages from=marveen to=marveen (documented self-notify
#   pattern) -> the existing inter-agent delivery injects it into the tmux.
# Event-gated: only messages when a genuinely new comment appears (watermark),
#   so no wasteful wakeups.
set -uo pipefail
ROOT="/home/viktor/Projects/marveen"
DB="$ROOT/store/claudeclaw.db"
TOKF="$ROOT/store/.dashboard-token"
STATE="$ROOT/store/.kanban-comment-watermark"
AGENT="marveen"
OWNER="viktor"   # human owner: their comments on ANY card surface to marveen
PORT="3420"
INTERVAL=60

# First run: start from the current max id so old comments are not replayed.
if [ ! -f "$STATE" ]; then
  sqlite3 "$DB" "SELECT COALESCE(MAX(id),0) FROM kanban_comments" > "$STATE" 2>/dev/null || echo 0 > "$STATE"
fi

while true; do
  LAST="$(cat "$STATE" 2>/dev/null || echo 0)"
  [ -z "$LAST" ] && LAST=0
  # tab-separated rows of new, non-marveen comments on marveen cards
  ROWS="$(sqlite3 -separator $'\x1f' "$DB" "
    SELECT c.id, k.rowid, c.author,
           replace(replace(k.title,char(10),' '),char(13),' '),
           replace(replace(c.content,char(10),' '),char(13),' ')
    FROM kanban_comments c JOIN kanban_cards k ON k.id = c.card_id
    WHERE c.id > $LAST
      AND lower(c.author) != '$AGENT'
      AND ( lower(c.author) = '$OWNER' OR k.assignee = '$AGENT' )
      AND k.archived_at IS NULL
    ORDER BY c.id" 2>/dev/null)"

  if [ -n "$ROWS" ]; then
    MAXID="$LAST"
    while IFS=$'\x1f' read -r cid seq author title content; do
      [ -z "$cid" ] && continue
      MSG="[Kártya-komment #${seq} «${title}» -- ${author} írta]: ${content}"
      BODY="$(python3 -c 'import json,sys; print(json.dumps({"from":"marveen","to":"marveen","content":sys.argv[1]}))' "$MSG" 2>/dev/null)"
      if [ -n "$BODY" ]; then
        curl -s --max-time 15 -X POST "http://localhost:$PORT/api/messages" \
          -H "Content-Type: application/json" \
          -H "Authorization: Bearer $(cat "$TOKF")" \
          -d "$BODY" >/dev/null 2>&1 && MAXID="$cid"
      fi
    done <<< "$ROWS"
    # advance watermark only past successfully-delivered comments
    [ "$MAXID" != "$LAST" ] && echo "$MAXID" > "$STATE"
  fi
  sleep "$INTERVAL"
done
