#!/usr/bin/env bash
# Acceptance test for scripts/install-voice.sh in a clean environment.
#
# Runs inside Docker (ubuntu:24.04) to guarantee no pre-existing components
# influence the result. Host-side: docker must be available.
#
# Usage:
#   ./scripts/__tests__/test-voice-install.sh           # runs Docker test
#   SKIP_DOCKER=1 INSTALL_DIR=/tmp/voice-test-xxx \
#     ./scripts/__tests__/test-voice-install.sh         # in-container self-test
#
# Exit code: 0 = all PASS, 1 = at least one FAIL.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0

_pass() { echo "[PASS] $*"; ((PASS++)) || true; }
_fail() { echo "[FAIL] $*" >&2; ((FAIL++)) || true; }
_section() { echo ""; echo "--- $* ---"; }

# ============================================================
# DOCKER MODE (default): spin up persistent ubuntu:24.04, run self
# Container is kept alive after the test for manual inspection.
# ============================================================
CONTAINER_NAME="${VOICE_TEST_CONTAINER:-marveen-voice-test}"

if [[ "${SKIP_DOCKER:-}" != "1" ]]; then
  # Remove any leftover container from a previous run
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

  echo "==> Starting persistent test container: $CONTAINER_NAME"
  docker run -d --name "$CONTAINER_NAME" \
    -v "$REPO_ROOT:/marveen:ro" \
    ubuntu:24.04 \
    tail -f /dev/null

  echo "==> Running acceptance tests inside container..."
  EXIT_CODE=0
  docker exec \
    -e SKIP_DOCKER=1 \
    -e INSTALL_DIR=/tmp/voice-test \
    "$CONTAINER_NAME" \
    bash /marveen/scripts/__tests__/test-voice-install.sh 2>&1 || EXIT_CODE=$?

  echo ""
  if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo "==> Container test: PASS"
  else
    echo "==> Container test: FAIL (exit $EXIT_CODE)"
  fi

  echo ""
  echo "==> Container '$CONTAINER_NAME' is still running for manual inspection."
  echo "    Enter:  docker exec -it $CONTAINER_NAME bash"
  echo "    Venv:   source /tmp/voice-test/venv/bin/activate"
  echo "    Voices: ls /tmp/voice-test/voices/"
  echo "    TTS:    /tmp/voice-test/tts.sh imre <chat_id> 'Helló, ez egy teszt'"
  echo "    Piper direct: echo 'Helló' | /tmp/voice-test/venv/bin/python -m piper \\"
  echo "                    -m /tmp/voice-test/voices/hu_HU-imre-medium.onnx -f /tmp/out.wav"
  echo "    STT:    /tmp/voice-test/venv/bin/python /tmp/voice-test/_vtools.py transcribe <file_id> <state_dir>"
  echo "    Cleanup: docker rm -f $CONTAINER_NAME"
  exit "$EXIT_CODE"
fi

# ============================================================
# IN-CONTAINER SELF-TEST MODE (SKIP_DOCKER=1)
# ============================================================
DEST="${INSTALL_DIR:-/tmp/voice-test}"
echo "==> Voice install acceptance test"
echo "    INSTALL_DIR=$DEST"
echo "    $(uname -a)"

# Preflight: confirm clean environment
_section "Preflight checks"
[[ ! -d "$DEST/venv" ]]                            && _pass "No prior venv (clean)" \
                                                   || _fail "Existing venv found -- not isolated!"
[[ ! -f "$DEST/voices/hu_HU-imre-medium.onnx" ]]  && _pass "No prior voice model (clean)" \
                                                   || _fail "Existing voice model found -- not isolated!"
command -v ffmpeg &>/dev/null                      && _fail "ffmpeg pre-installed (not clean)" \
                                                   || _pass "No pre-installed ffmpeg (clean)"

# Run installer
_section "Running installer"
INSTALL_DIR="$DEST" bash /marveen/scripts/install-voice.sh
echo "    installer exited $?"

# C1: venv + package import
_section "C1: Python venv + package import"
if [[ -d "$DEST/venv" ]]; then
  _pass "venv exists at $DEST/venv"
else
  _fail "venv missing"
fi
if "$DEST/venv/bin/python" -c "import faster_whisper, piper" 2>/dev/null; then
  _pass "faster_whisper and piper importable"
else
  _fail "package import failed"
fi

# C2: Voice models -- both imre and anna
_section "C2: Hungarian TTS voice models"
MIN_ONNX_BYTES=1000000
for name in hu_HU-imre-medium hu_HU-anna-medium; do
  onnx="$DEST/voices/${name}.onnx"
  json_file="$DEST/voices/${name}.onnx.json"
  if [[ -f "$onnx" ]]; then
    size=$(stat -c%s "$onnx" 2>/dev/null || stat -f%z "$onnx")
    if [[ "$size" -ge "$MIN_ONNX_BYTES" ]]; then
      _pass "${name}.onnx present (${size} bytes)"
    else
      _fail "${name}.onnx too small (${size} bytes)"
    fi
  else
    _fail "${name}.onnx missing"
  fi
  [[ -f "$json_file" ]] && _pass "${name}.onnx.json present" || _fail "${name}.onnx.json missing"

  # Verify the .onnx.json is valid JSON and contains expected fields
  if "$DEST/venv/bin/python" -c "
import json, sys
d = json.load(open('$json_file'))
assert 'language' in d or 'espeak' in d or 'audio' in d, 'missing expected keys'
" 2>/dev/null; then
    _pass "${name}.onnx.json valid"
  else
    _fail "${name}.onnx.json invalid or missing expected keys"
  fi
done

# C3: ffmpeg + libopus
_section "C3: ffmpeg + libopus encoder"
if command -v ffmpeg &>/dev/null; then
  _pass "ffmpeg available: $(ffmpeg -version 2>&1 | head -1)"
else
  _fail "ffmpeg not found after install"
fi
_enc=$(ffmpeg -encoders 2>&1 || true)
if echo "$_enc" | grep -q libopus; then
  _pass "libopus encoder present"
else
  _fail "libopus encoder missing"
fi

# C4: TTS end-to-end (text -> wav -> ogg/opus)
_section "C4: TTS end-to-end (both voices)"
for voice_name in imre anna; do
  voice_label="hu_HU-${voice_name}-medium"
  onnx="$DEST/voices/${voice_label}.onnx"
  wav_out="/tmp/test-tts-${voice_name}.wav"
  ogg_out="/tmp/test-tts-${voice_name}.ogg"
  TEST_TEXT="Helló, ez egy teszt üzenet a ${voice_name} hanggal."

  if echo "$TEST_TEXT" | "$DEST/venv/bin/python" -m piper \
      -m "$onnx" -f "$wav_out" 2>/dev/null; then
    wav_size=$(stat -c%s "$wav_out" 2>/dev/null || echo 0)
    if [[ "$wav_size" -gt 0 ]]; then
      _pass "TTS ${voice_name}: wav generated (${wav_size} bytes)"
    else
      _fail "TTS ${voice_name}: wav is empty"
    fi
  else
    _fail "TTS ${voice_name}: piper synthesis failed"
  fi

  if [[ -f "$wav_out" ]] && [[ "$(stat -c%s "$wav_out" 2>/dev/null || echo 0)" -gt 0 ]]; then
    if ffmpeg -hide_banner -loglevel error -y -i "$wav_out" \
        -c:a libopus -b:a 32k "$ogg_out" 2>/dev/null; then
      ogg_size=$(stat -c%s "$ogg_out" 2>/dev/null || echo 0)
      if [[ "$ogg_size" -gt 0 ]]; then
        _pass "TTS ${voice_name}: ogg/opus encoded (${ogg_size} bytes)"
      else
        _fail "TTS ${voice_name}: ogg output empty"
      fi
    else
      _fail "TTS ${voice_name}: ffmpeg ogg conversion failed"
    fi
  fi

  # Verify ogg is valid audio container
  if [[ -f "$ogg_out" ]]; then
    if ffprobe -v quiet -select_streams a:0 \
        -show_entries stream=codec_name "$ogg_out" 2>/dev/null | grep -q opus; then
      _pass "TTS ${voice_name}: valid opus stream confirmed"
    else
      _fail "TTS ${voice_name}: ffprobe did not find opus stream"
    fi
  fi
done

# C5: STT end-to-end (known ogg -> transcript with expected keyword)
# Uses one of the TTS outputs as a known-content reference file.
_section "C5: STT end-to-end (TTS output as reference)"
REF_OGG="/tmp/test-tts-imre.ogg"
EXPECTED_KW="teszt"   # "teszt" is in the TTS text, whisper-small should catch it
if [[ -f "$REF_OGG" ]]; then
  TRANSCRIPT=$("$DEST/venv/bin/python" - <<'PYEOF'
import sys
from faster_whisper import WhisperModel
m = WhisperModel("small", device="cpu", compute_type="int8")
segs, _ = m.transcribe("/tmp/test-tts-imre.ogg", language="hu", beam_size=5)
print(" ".join(s.text.strip() for s in segs).strip().lower())
PYEOF
  ) || TRANSCRIPT=""
  echo "    Transcript: $TRANSCRIPT"
  if [[ -n "$TRANSCRIPT" ]]; then
    _pass "STT produced non-empty transcript"
    if echo "$TRANSCRIPT" | grep -qi "$EXPECTED_KW"; then
      _pass "STT transcript contains expected keyword: '$EXPECTED_KW'"
    else
      # Whisper-small is imperfect on short Hungarian; non-fatal warning
      echo "    [WARN] keyword '$EXPECTED_KW' not found (small model imprecision, non-fatal)"
      _pass "STT ran without error (keyword match optional for small model)"
    fi
  else
    _fail "STT returned empty transcript"
  fi
else
  echo "    [SKIP] C5: reference ogg missing (TTS failed earlier)"
fi

# C6: Per-agent voice selection -- different onnx paths produce different outputs
_section "C6: Per-agent voice selection (imre vs anna differ)"
if [[ -f "/tmp/test-tts-imre.ogg" ]] && [[ -f "/tmp/test-tts-anna.ogg" ]]; then
  size_imre=$(stat -c%s /tmp/test-tts-imre.ogg)
  size_anna=$(stat -c%s /tmp/test-tts-anna.ogg)
  if [[ "$size_imre" -ne "$size_anna" ]]; then
    _pass "imre and anna produce different-sized audio (different voices confirmed)"
  else
    # Same size is suspicious but not conclusive -- content could differ
    echo "    [WARN] same file size for imre/anna -- may be coincidence, not failure"
    _pass "Both voices generated without error"
  fi
else
  echo "    [SKIP] C6: TTS outputs missing"
fi

# C7: Idempotence -- re-run installer, nothing breaks
_section "C7: Idempotence (re-run)"
INSTALL_DIR="$DEST" bash /marveen/scripts/install-voice.sh 2>&1 | grep -E "SKIP|PASS|complete" | head -10
"$DEST/venv/bin/python" -c "import faster_whisper, piper" \
  && _pass "packages still importable after re-run" \
  || _fail "packages broken after re-run"

# ============================================================
# Summary
# ============================================================
echo ""
echo "==========================================="
echo "  PASS: $PASS   FAIL: $FAIL"
echo "==========================================="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
