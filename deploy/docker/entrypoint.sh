#!/bin/sh
# The app reads its settings from /app/.env (not from process env) and rewrites
# it from the dashboard (atomic rename, so it cannot be a symlink or a file
# mount). Keep the durable copy in the store volume and mirror it both ways:
#   store/.env -> /app/.env at start, /app/.env -> store/.env while running.
set -e
DURABLE=/app/store/.env
if [ -f "$DURABLE" ]; then
  cp "$DURABLE" /app/.env
else
  : > /app/.env
  # first boot only: seed from the optional mounted secret
  [ -f /config/env ] && cat /config/env >> /app/.env && echo >> /app/.env
fi
grep -q '^WEB_HOST=' /app/.env || echo 'WEB_HOST=0.0.0.0' >> /app/.env
chmod 600 /app/.env
cp -p /app/.env "$DURABLE"
(
  while sleep 3; do
    cmp -s /app/.env "$DURABLE" || cp -p /app/.env "$DURABLE"
  done
) &

# Runtime state the app keeps next to the code (Telegram token + pairing under
# .claude/channels, user agents, workspace, reports) goes to the store volume.
for d in .claude agents workspace reports; do
  mkdir -p "/app/store/data/$d"
  rm -rf "/app/$d"
  ln -s "/app/store/data/$d" "/app/$d"
done

# Channel plugin lives in ~/.claude (a volume): install it once, in the
# background, retrying until the marketplace is reachable.
PLUGIN="${CHANNEL_PLUGIN:-telegram@claude-plugins-official}"
(
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    claude plugin list 2>/dev/null | grep -q "${PLUGIN%@*}" && exit 0
    claude plugin marketplace add "anthropics/claude-plugins-official" >/dev/null 2>&1 || true
    claude plugin install "$PLUGIN" >/dev/null 2>&1 && exit 0
    sleep 15
  done
) &
exec "$@"
