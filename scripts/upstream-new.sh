#!/bin/bash
# Which upstream commits has this fork NOT dealt with yet?
#
# A fork that carries its own work cannot always merge upstream wholesale: some
# commits get hand-ported, some are deliberately skipped. Git compares commit
# IDENTITY, not content, so `git log HEAD..upstream/develop` keeps listing a
# hand-ported commit forever -- the list only grows, and every review has to
# re-read commits it already decided on. store/upstream-ported.json is the
# missing memory: every SHA ported or consciously skipped, with a one-line
# reason.
#
# Nothing here is fork-specific: point UPSTREAM_REF at whatever you track.
#
# This script is the ONLY entry point for an upstream review. It subtracts the
# ledger from the upstream log, so what it prints is genuinely new.
#
# Usage:
#   scripts/upstream-new.sh                 list unhandled upstream commits (newest first)
#   scripts/upstream-new.sh --count         just the number
#   scripts/upstream-new.sh mark ported  <sha> "reason"
#   scripts/upstream-new.sh mark skipped <sha> "reason"
#
# `mark` keeps the ledger current as part of the review, so the next run is shorter.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEDGER="$ROOT/store/upstream-ported.json"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/develop}"

# Seed the ledger on first use. It is per-install state (every fork makes its own
# decisions), so it lives under the gitignored store/ rather than being tracked.
if [ ! -f "$LEDGER" ]; then
  mkdir -p "$(dirname "$LEDGER")"
  printf '{\n  "ported": {},\n  "skipped": {},\n  "pending": {},\n  "updated": ""\n}\n' > "$LEDGER"
  echo "upstream-new: created a fresh ledger at $LEDGER" >&2
fi

# --- mark: record a decision -------------------------------------------------
if [ "${1:-}" = "mark" ]; then
  BUCKET="${2:-}"
  SHA="${3:-}"
  REASON="${4:-}"
  case "$BUCKET" in
    ported|skipped|pending) ;;
    *) echo "usage: $0 mark ported|skipped|pending <sha> \"reason\"" >&2; exit 2 ;;
  esac
  if [ -z "$SHA" ] || [ -z "$REASON" ]; then
    echo "usage: $0 mark $BUCKET <sha> \"reason\"" >&2; exit 2
  fi
  # Expand a short sha to the full one so the ledger stays comparable.
  FULL_SHA="$(git -C "$ROOT" rev-parse "$SHA" 2>/dev/null || echo "$SHA")"
  python3 - "$LEDGER" "$BUCKET" "$FULL_SHA" "$REASON" <<'PY'
import json, sys, datetime
ledger, bucket, sha, reason = sys.argv[1:5]
with open(ledger) as f:
    d = json.load(f)
d.setdefault(bucket, {})
# A SHA lives in exactly one bucket: re-marking moves it rather than duplicating.
for b in ('ported', 'skipped', 'pending'):
    if b != bucket and isinstance(d.get(b), dict):
        d[b].pop(sha, None)
d[bucket][sha] = reason
d['updated'] = datetime.date.today().isoformat()
with open(ledger, 'w') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write('\n')
print(f"{bucket}: {sha[:8]} -- {reason}")
PY
  exit $?
fi

# --- list: upstream log minus the ledger -------------------------------------
if ! git -C "$ROOT" rev-parse --verify --quiet "$UPSTREAM_REF" >/dev/null; then
  echo "upstream-new: nincs ilyen ref: $UPSTREAM_REF (git fetch upstream?)" >&2
  exit 1
fi

# Only ported and skipped are DECIDED. `pending` means the opposite -- the
# commit is still open, with a note attached -- so subtracting it here would
# make `mark pending` the one gesture that makes you forget a commit, which is
# the exact failure this script exists to prevent.
HANDLED="$(python3 -c "
import json
d = json.load(open('$LEDGER'))
seen = set()
for b in ('ported', 'skipped'):
    v = d.get(b)
    if isinstance(v, dict):
        seen.update(v)
    elif isinstance(v, list):
        seen.update(v)
print('\n'.join(seen))
")"

# sha<TAB>reason for every pending commit, so the listing can mark them inline.
PENDING_FILE="$(mktemp)"
python3 -c "
import json
d = json.load(open('$LEDGER'))
v = d.get('pending')
if isinstance(v, dict):
    for sha, reason in v.items():
        print(sha + '\t' + str(reason))
" > "$PENDING_FILE" 2>/dev/null || true

# Subtract with grep -F rather than a shell `case`: a case pattern's `)` inside
# a $( ) substitution trips the parser (bash: "syntax error near unexpected token").
HANDLED_FILE="$(mktemp)"
trap 'rm -f "$HANDLED_FILE" "$PENDING_FILE"' EXIT
printf '%s\n' "$HANDLED" | grep -v '^$' > "$HANDLED_FILE" || true
NEW="$(git -C "$ROOT" log --format='%H %ad %s' --date=short "HEAD..$UPSTREAM_REF" 2>/dev/null \
  | grep -vFf "$HANDLED_FILE" || true)"

COUNT="$(printf '%s' "$NEW" | grep -c . || true)"

if [ "${1:-}" = "--count" ]; then
  echo "$COUNT"
  exit 0
fi

TOTAL="$(git -C "$ROOT" rev-list --count "HEAD..$UPSTREAM_REF" 2>/dev/null || echo 0)"
echo "upstream-new: $COUNT uj / $TOTAL osszes ($UPSTREAM_REF), a tobbi mar a ledgerben van"
[ "$COUNT" = "0" ] && exit 0
echo
printf '%s\n' "$NEW" | while read -r sha date subject; do
  NOTE="$(grep -F "$sha" "$PENDING_FILE" 2>/dev/null | head -1 | cut -f2- || true)"
  if [ -n "$NOTE" ]; then
    printf '  %s  %s  %s  [pending: %s]\n' "${sha:0:8}" "$date" "$subject" "$NOTE"
  else
    printf '  %s  %s  %s\n' "${sha:0:8}" "$date" "$subject"
  fi
done
echo
echo "Dontes utan:  scripts/upstream-new.sh mark ported|skipped <sha> \"egy soros indok\""
echo "Meg nem dontod el: scripts/upstream-new.sh mark pending <sha> \"mire vartok\" -- a listan MARAD, jelolve."
