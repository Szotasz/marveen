#!/usr/bin/env bash
# Switch the Telegram progress feedback for an agent.
#
#   progress-mode.sh                      show the current setting for everyone
#   progress-mode.sh verbose              set the main agent
#   progress-mode.sh indicator liebig     set one agent
#
# silent    -- nothing goes to Telegram
# indicator -- one ephemeral "thinking" message, edited live, deleted at the end
# verbose   -- indicator PLUS the reasoning steps as permanent messages
#
# Takes effect on the next poll (~2s); no restart needed.
set -uo pipefail

CONFIG=/home/ubuntu/marveen/store/progress-config.json
MODE="${1:-}"
AGENT="${2:-turing}"

if [ -z "$MODE" ]; then
  python3 - "$CONFIG" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
print(f"alapertelmezes: {c.get('defaultMode','silent')}")
for a, v in (c.get('agents') or {}).items():
    print(f"  {a:10} {v.get('mode', c.get('defaultMode','silent'))}")
PY
  exit 0
fi

case "$MODE" in
  silent|indicator|verbose) ;;
  *) echo "mode: silent | indicator | verbose" >&2; exit 2 ;;
esac

python3 - "$CONFIG" "$AGENT" "$MODE" <<'PY'
import json, sys
path, agent, mode = sys.argv[1:4]
c = json.load(open(path))
c.setdefault('agents', {}).setdefault(agent, {})['mode'] = mode
json.dump(c, open(path, 'w'), indent=2, ensure_ascii=False)
print(f"{agent} -> {mode}")
PY
