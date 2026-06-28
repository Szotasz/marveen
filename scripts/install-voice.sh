#!/usr/bin/env bash
# Voice components installer for the Marveen agent fleet.
#
# Installs: faster-whisper (STT) + piper-tts (TTS) + ffmpeg/libopus
#           + Hungarian TTS voice models (imre, anna) + fleet helper scripts.
#
# Usage:
#   ./scripts/install-voice.sh                     # installs to ~/.local/share/marveen-voice
#   INSTALL_DIR=/custom/path ./scripts/install-voice.sh
#
# Safe to re-run (idempotent): skips already-completed steps.
# Opt-in: this script is NOT run by the main dashboard installer.
set -euo pipefail

DEST="${INSTALL_DIR:-$HOME/.local/share/marveen-voice}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VOICE_SRC="$REPO_ROOT/scripts/voice"

HF_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"
VOICES=(
  "hu/hu_HU/imre/medium/hu_HU-imre-medium"
  "hu/hu_HU/anna/medium/hu_HU-anna-medium"
)

_pass() { echo "    [PASS] $*"; }
_fail() { echo "    [FAIL] $*" >&2; exit 1; }
_skip() { echo "    [SKIP] $*"; }
_step() { echo ""; echo "==> $*"; }

# --- Preflight: no existing install check (for test isolation) ---
if [[ "${VOICE_PREFLIGHT_CHECK:-}" == "1" ]]; then
  [[ -d "$DEST/venv" ]] && _fail "Existing venv found at $DEST/venv -- test isolation violated"
  [[ -f "$DEST/voices/hu_HU-imre-medium.onnx" ]] && _fail "Voice model already present -- test isolation violated"
  echo "==> Preflight OK: $DEST is clean"
fi

echo "==> Voice component installer"
echo "    Target: $DEST"

# --- Step 1: System dependencies ---
_step "[1/5] System dependencies (ffmpeg + libopus + python3-venv)"
_has_ffmpeg_opus() {
  # ffmpeg -encoders exits 1 (no input file); capture output before grep
  # so pipefail doesn't turn a successful grep into a failure.
  command -v ffmpeg &>/dev/null || return 1
  local _enc
  _enc=$(ffmpeg -encoders 2>&1 || true)
  echo "$_enc" | grep -q libopus
}
_has_python_venv() {
  python3 -m venv --help &>/dev/null 2>&1
}

# SKIP_SYSTEM_DEPS=1: skip the apt-get step (used by the dashboard installer
# which has already verified deps are present and runs without root).
if [[ "${SKIP_SYSTEM_DEPS:-}" == "1" ]]; then
  _has_ffmpeg_opus || _fail "ffmpeg + libopus missing -- install manually: sudo apt-get install -y ffmpeg"
  _has_python_venv || _fail "python3-venv missing -- install manually: sudo apt-get install -y python3-venv python3"
  _skip "SKIP_SYSTEM_DEPS=1: skipping apt-get step"
elif command -v apt-get &>/dev/null; then
  PKGS=()
  _has_ffmpeg_opus       || PKGS+=(ffmpeg)
  _has_python_venv       || PKGS+=(python3-venv python3)
  command -v curl &>/dev/null || PKGS+=(curl)
  if [[ ${#PKGS[@]} -gt 0 ]]; then
    echo "    Installing: ${PKGS[*]}"
    apt-get update -qq 2>&1 | tail -3
    apt-get install -y --no-install-recommends "${PKGS[@]}" 2>&1 | tail -5
  else
    _skip "apt packages already present"
  fi
else
  command -v ffmpeg  || _fail "ffmpeg not found (non-apt system, install manually)"
  _has_ffmpeg_opus   || _fail "ffmpeg has no libopus encoder"
  _has_python_venv   || _fail "python3-venv not available"
  _skip "non-apt system, system deps assumed present"
fi
_has_ffmpeg_opus || _fail "ffmpeg + libopus check failed after install"
_pass "ffmpeg + libopus OK"

# --- Step 2: Python venv ---
_step "[2/5] Python venv"
mkdir -p "$DEST/voices"
if [[ ! -d "$DEST/venv" ]]; then
  python3 -m venv "$DEST/venv"
  _pass "venv created at $DEST/venv"
else
  _skip "venv exists"
fi

# --- Step 3: Python packages ---
_step "[3/5] Python packages (faster-whisper + piper-tts)"
if "$DEST/venv/bin/python" -c "import faster_whisper, piper" 2>/dev/null; then
  _skip "packages already installed"
else
  "$DEST/venv/bin/pip" install --quiet faster-whisper piper-tts
  _pass "faster-whisper + piper-tts installed"
fi
"$DEST/venv/bin/python" -c "import faster_whisper, piper" || _fail "package import check failed"

# --- Step 4: Hungarian voice models ---
_step "[4/5] Hungarian TTS voice models"
MIN_ONNX_BYTES=50000000

for voice_path in "${VOICES[@]}"; do
  name="$(basename "$voice_path")"
  onnx="$DEST/voices/${name}.onnx"
  json="$DEST/voices/${name}.onnx.json"
  url_base="${HF_BASE}/${voice_path}"

  existing_size=0
  if [[ -f "$onnx" ]]; then
    existing_size=$(stat -c%s "$onnx" 2>/dev/null || stat -f%z "$onnx" 2>/dev/null || echo 0)
  fi

  if [[ "$existing_size" -ge "$MIN_ONNX_BYTES" ]]; then
    _skip "${name}: present (${existing_size} bytes)"
    continue
  fi

  echo "    Downloading ${name} (~63MB)..."
  curl -sSL --retry 3 --retry-delay 3 --connect-timeout 30 -o "$onnx" "${url_base}.onnx" \
    || { rm -f "$onnx"; _fail "download failed: ${name}.onnx"; }
  curl -sSL --retry 3 --retry-delay 3 --connect-timeout 30 -o "$json" "${url_base}.onnx.json" \
    || { rm -f "$json"; _fail "download failed: ${name}.onnx.json"; }

  size=$(stat -c%s "$onnx" 2>/dev/null || stat -f%z "$onnx")
  [[ "$size" -ge "$MIN_ONNX_BYTES" ]] || _fail "${name}.onnx too small (${size} bytes) -- download incomplete"
  _pass "${name}: ${size} bytes"
done

# --- Step 5: Helper scripts ---
_step "[5/5] Installing fleet helper scripts"
cp "$VOICE_SRC/_vtools.py" "$DEST/_vtools.py"
cp "$VOICE_SRC/stt.sh"     "$DEST/stt.sh"
cp "$VOICE_SRC/tts.sh"     "$DEST/tts.sh"
chmod +x "$DEST/stt.sh" "$DEST/tts.sh" "$DEST/_vtools.py"
_pass "stt.sh, tts.sh, _vtools.py deployed"

# --- Done ---
echo ""
echo "==> Installation complete: $DEST"
echo "    Voices: imre (hu_HU-imre-medium), anna (hu_HU-anna-medium)"
echo "    STT:    $DEST/stt.sh <file_id> [state_dir]"
echo "    TTS:    $DEST/tts.sh <voice> <chat_id> <text...>"
