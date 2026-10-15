#!/usr/bin/env bash
# yt-read.sh -- read what yt-ingest.sh produced, with the trust boundary marked.
#
#   yt-read.sh <video_id> [transcript|meta] [--out DIR]
#
# transcript (default): the transcript, wrapped by wrapUntrustedFetch()
#   (dist/prompt-safety.js) -- security tags scrubbed, <untrusted ...
#   fetch-nonce="..."> frame around it. Same wrapper the quarantine-reader
#   path uses.
# meta: the manifest's "untrusted" section (title, channel, description,
#   chapters), wrapped the same way.
#
# Both print a short trusted header first (machine-measured manifest fields:
# id, duration, transcript source, frame paths). Nothing the uploader wrote
# is printed outside the <untrusted> frame.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${YT_INGEST_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
OUT_BASE="${YT_INGEST_OUT_BASE:-$ROOT/agents/leanscout/research/video/_ingest}"
SAFETY="${YT_INGEST_PROMPT_SAFETY:-$ROOT/dist/prompt-safety.js}"

fail() { echo "FAIL $*" >&2; exit "${FAIL_CODE:-1}"; }

VID="" WHAT=transcript OUT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; OUT_DIR="${1:-}" ;;
    transcript|meta) WHAT="$1" ;;
    -*) FAIL_CODE=2 fail "usage=unknown-option" ;;
    *) [ -z "$VID" ] || FAIL_CODE=2 fail "usage=one-id"; VID="$1" ;;
  esac
  shift
done
[[ "$VID" =~ ^[A-Za-z0-9_-]{11}$ ]] || FAIL_CODE=2 fail "usage=bad-video-id"
DIR="${OUT_DIR:-$OUT_BASE/$VID}"
[ -f "$DIR/manifest.json" ] || FAIL_CODE=4 fail "read=no-manifest"
[ -f "$SAFETY" ] || fail "dep=prompt-safety-js"

exec node --input-type=module - "$SAFETY" "$DIR" "$VID" "$WHAT" <<'JS'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [safety, dir, vid, what] = process.argv.slice(2)
const { wrapUntrustedFetch, generateFetchNonce } = await import(pathToFileURL(safety).href)
const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
if (m.schema !== 'yt-ingest/1' || m.video_id !== vid) {
  console.error('FAIL read=manifest-mismatch')
  process.exit(4)
}
const frames = (m.frames || []).map(f => `${f.path} t=${f.t_s}s score=${f.scene_score}`)
console.log([
  `[trusted] video_id=${m.video_id} duration_s=${m.duration_s} mode=${m.mode}`,
  `[trusted] transcript_source=${m.transcript_source} frames_stage=${m.frames_stage} frames=${frames.length}`,
  ...frames.map(f => `[trusted]   ${join(dir, f.split(' ')[0])} ${f.split(' ').slice(1).join(' ')}`),
].join('\n'))
let content
if (what === 'meta') {
  content = JSON.stringify(m.untrusted ?? {}, null, 1)
} else {
  const p = join(dir, 'transcript.txt')
  if (!existsSync(p)) {
    console.log('[trusted] no transcript (transcript_source=none)')
    process.exit(0)
  }
  content = readFileSync(p, 'utf8')
}
console.log(wrapUntrustedFetch(m.canonical_url, content, generateFetchNonce()))
JS
