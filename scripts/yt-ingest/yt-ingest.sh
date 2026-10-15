#!/usr/bin/env bash
# yt-ingest.sh -- isolated YouTube processing step (card d840bbce).
#
#   yt-ingest.sh [--subs-only] [--scene S] [--max-frames N] [--out DIR] <youtube-url>
#   yt-ingest.sh keep <video_id> <frame.jpg> [<frame.jpg>]   [--out DIR]
#
# A deterministic script, not an LLM: it cannot be talked into anything,
# because it never interprets the text it downloads.
#
# Trust boundary:
#   * The URL must be on a YouTube host listed under quarantine_domains in
#     store/egress-allowlist.json (re-read on every run). Only the 11-char
#     video id survives the gate; yt-dlp gets a URL we build ourselves.
#   * yt-dlp and ffmpeg run under bwrap with a cleared environment and an
#     empty $HOME: store/ (tokens), .claude*, agents/ are not visible.
#     yt-dlp keeps the network (it must download); ffmpeg runs without it.
#     Network destinations are NOT filtered -- unprivileged bwrap cannot.
#   * The video file lives only in a per-run temp dir that a trap removes on
#     every exit path (István, Q034: the full video is not retained).
#   * stdout carries measured values only (OK manifest=... frames=N words=N).
#     Uploader text (title, description, chapters) lands in manifest.json
#     under "untrusted"; read the transcript through yt-read.sh.
#
# The `keep` subcommand moves the 1-2 chosen frames to frames/ and removes
# the other candidates listed in the manifest (Q034: only the selected
# frames are kept long-term).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${YT_INGEST_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
LIB="$SCRIPT_DIR/yt_ingest_lib.py"
ALLOWLIST="${YT_INGEST_ALLOWLIST:-$ROOT/store/egress-allowlist.json}"
OUT_BASE="${YT_INGEST_OUT_BASE:-$ROOT/agents/leanscout/research/video/_ingest}"
YTDLP_VENV="${YT_INGEST_YTDLP_VENV:-$HOME/.local/share/pipx/venvs/yt-dlp}"

fail() { echo "FAIL $*" >&2; exit "${FAIL_CODE:-1}"; }

SUBS_ONLY=0
SCENE=0.3
MAX_FRAMES=60
MIN_GAP=2
OUT_DIR=""
MODE=ingest
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --subs-only) SUBS_ONLY=1 ;;
    --scene) shift; SCENE="${1:-}" ;;
    --max-frames) shift; MAX_FRAMES="${1:-}" ;;
    --out) shift; OUT_DIR="${1:-}" ;;
    --) shift; ARGS+=("$@"); break ;;
    -*) FAIL_CODE=2 fail "usage=unknown-option" ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

[[ "$SCENE" =~ ^0(\.[0-9]{1,3})?$|^1(\.0{1,3})?$ ]] || FAIL_CODE=2 fail "usage=scene-0..1"
[[ "$MAX_FRAMES" =~ ^[0-9]{1,3}$ ]] && [ "$MAX_FRAMES" -ge 1 ] && [ "$MAX_FRAMES" -le 200 ] \
  || FAIL_CODE=2 fail "usage=max-frames-1..200"

if [ "${#ARGS[@]}" -ge 1 ] && [ "${ARGS[0]}" = keep ]; then
  MODE=keep
  [ "${#ARGS[@]}" -ge 3 ] && [ "${#ARGS[@]}" -le 4 ] || FAIL_CODE=2 fail "usage=keep-id-1..2-frames"
  VID="${ARGS[1]}"
  [[ "$VID" =~ ^[A-Za-z0-9_-]{11}$ ]] || FAIL_CODE=2 fail "usage=bad-video-id"
  for f in "${ARGS[@]:2}"; do
    [[ "$f" =~ ^f_[0-9]{4,}_[0-9]{3,4}\.jpg$ ]] || FAIL_CODE=2 fail "usage=bad-frame-name"
  done
  DIR="${OUT_DIR:-$OUT_BASE/$VID}"
  [ -f "$DIR/manifest.json" ] || FAIL_CODE=4 fail "keep=no-manifest"
  if res="$(python3 "$LIB" keep "$DIR" "${ARGS[@]:2}")"; then
    read -r kept pruned <<<"$res"
    echo "OK manifest=$DIR/manifest.json kept=$kept pruned=$pruned"
    exit 0
  else
    rc=$?; exit "$rc"
  fi
fi

[ "${#ARGS[@]}" -eq 1 ] || FAIL_CODE=2 fail "usage=one-url"
command -v bwrap >/dev/null || fail "dep=bwrap"
command -v ffmpeg >/dev/null || fail "dep=ffmpeg"
[ -x "$YTDLP_VENV/bin/yt-dlp" ] || fail "dep=yt-dlp-venv"

VID="$(python3 "$LIB" gate "${ARGS[0]}" "$ALLOWLIST")" || exit 3
CANON="https://www.youtube.com/watch?v=$VID"
DIR="${OUT_DIR:-$OUT_BASE/$VID}"
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/yt-ingest.XXXXXXXX")"
cleanup() { rm -rf -- "$WORK"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir -p "$WORK/dl" "$WORK/cand" "$WORK/home"

# sandbox <net|nonet> cmd...  -- /work is the per-run temp dir.
sandbox() {
  local net="$1"; shift
  local netflag=(--unshare-net)
  [ "$net" = net ] && netflag=(--share-net)
  bwrap \
    --unshare-all "${netflag[@]}" --die-with-parent --new-session \
    --ro-bind /usr /usr \
    --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/sbin /sbin \
    --proc /proc --dev /dev --tmpfs /tmp --tmpfs /home \
    --ro-bind /etc/ssl /etc/ssl \
    --ro-bind-try /etc/ca-certificates /etc/ca-certificates \
    --ro-bind "$(readlink -f /etc/resolv.conf)" /etc/resolv.conf \
    --ro-bind /etc/hosts /etc/hosts \
    --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf \
    --ro-bind-try /etc/alternatives /etc/alternatives \
    --ro-bind "$YTDLP_VENV" /opt/yt-dlp \
    --bind "$WORK" /work \
    --chdir /work \
    --clearenv \
    --setenv PATH /usr/bin --setenv HOME /work/home --setenv LANG C.UTF-8 \
    --setenv TMPDIR /tmp \
    "$@"
}

LOG="$DIR/.ingest.log"
: >"$LOG"

ytdlp_common=(
  /opt/yt-dlp/bin/python -m yt_dlp
  --ignore-config --no-plugin-dirs --no-exec --no-cookies-from-browser
  --no-playlist --no-progress --socket-timeout 30 --retries 3
  --js-runtimes node:/usr/bin/node --no-remote-components
  --no-write-thumbnail --no-write-comments
  -o "/work/dl/v.%(ext)s"
)

# Pass 1: metadata only. Pass 2 reuses it (--load-info-json), so YouTube is
# extracted once and exactly one subtitle track is requested -- several
# parallel tracks drew HTTP 429 on the first live run.
sandbox net "${ytdlp_common[@]}" --skip-download --write-info-json -- "$CANON" >>"$LOG" 2>&1 \
  || fail "stage=yt-dlp-info exit=$? log=$LOG"
INFO="$WORK/dl/v.info.json"
[ -f "$INFO" ] || fail "stage=info-json-missing log=$LOG"
python3 "$LIB" slim-info "$INFO" "$DIR/info.json"

read -r SUBLANG SUBKIND <<<"$(python3 "$LIB" pick-sub "$INFO")"
pass2=("${ytdlp_common[@]}" --load-info-json /work/dl/v.info.json)
[ "$SUBKIND" = subs-manual ] && pass2+=(--write-subs --sub-langs "$SUBLANG" --sub-format vtt)
[ "$SUBKIND" = subs-auto ] && pass2+=(--write-auto-subs --sub-langs "$SUBLANG" --sub-format vtt)

if [ "$SUBS_ONLY" = 1 ]; then
  if [ "$SUBKIND" != none ]; then
    sandbox net "${pass2[@]}" --skip-download >>"$LOG" 2>&1 \
      || fail "stage=yt-dlp-subs exit=$? log=$LOG"
  fi
else
  sandbox net "${pass2[@]}" \
    -f "bv*[height<=720]+ba/b[height<=720]" --merge-output-format mkv \
    --max-filesize 800M >>"$LOG" 2>&1 \
    || fail "stage=yt-dlp-video exit=$? log=$LOG"
fi

TSOURCE=none
WORDS=0
VTT="$WORK/dl/v.$SUBLANG.vtt"
if [ "$SUBKIND" != none ] && [ -f "$VTT" ]; then
  TSOURCE="$SUBKIND:$SUBLANG"
  cp -- "$VTT" "$DIR/transcript.vtt"
  WORDS="$(python3 "$LIB" transcript "$DIR/transcript.vtt" "$DIR/transcript.txt")"
fi

FRAMES=0
if [ "$SUBS_ONLY" = 0 ]; then
  VIDEO="$(find "$WORK/dl" -maxdepth 1 -type f -name 'v.*' \
    \( -name '*.mkv' -o -name '*.mp4' -o -name '*.webm' \) | head -1)"
  [ -n "$VIDEO" ] || fail "stage=video-missing log=$LOG"
  VREL="/work/dl/$(basename "$VIDEO")"
  sandbox nonet /usr/bin/ffmpeg -nostdin -hide_banner -loglevel error -i "$VREL" \
    -vf "select='gt(scene,$SCENE)',metadata=print:file=/work/scene.txt,scale='min(1280,iw)':-2" \
    -fps_mode vfr -q:v 3 /work/cand/c_%05d.jpg >>"$LOG" 2>&1 \
    || fail "stage=ffmpeg exit=$? log=$LOG"
  rm -f -- "$VIDEO"
  [ -f "$WORK/scene.txt" ] || : >"$WORK/scene.txt"
  FRAMES="$(python3 "$LIB" frames "$WORK/scene.txt" "$WORK/cand" "$DIR/candidates" "$MAX_FRAMES" "$MIN_GAP")"
fi

MODE_TAG=full; [ "$SUBS_ONLY" = 1 ] && MODE_TAG=subs-only
python3 "$LIB" manifest "$DIR" "$VID" "$DIR/info.json" "$MODE_TAG" "$TSOURCE" "$SCENE"
echo "OK manifest=$DIR/manifest.json frames=$FRAMES words=$WORDS transcript=$TSOURCE"
