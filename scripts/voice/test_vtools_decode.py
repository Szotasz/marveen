#!/usr/bin/env python3
"""Behaviour test for VOICEPYAV930: _decode_audio() turns any audio file into
the 16 kHz mono float32 samples faster-whisper takes, without PyAV.

faster-whisper 1.2.1 + PyAV 19 fails on a file path (av.open() no longer takes
metadata_errors=), so _vtools.py decodes with ffmpeg and passes a numpy array.
This drives the real ffmpeg on a generated 1 s, 440 Hz stereo 48 kHz ogg/opus
tone (the shape of a Telegram voice note) and checks what comes out.

Needs ffmpeg and numpy (the voice venv has numpy):
  ~/.local/share/marveen-voice/venv/bin/python scripts/voice/test_vtools_decode.py
A missing dependency is a FAIL, not a silent skip.
"""

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("_vtools_under_test", os.path.join(HERE, "_vtools.py"))
vt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vt)

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("ok   - %s" % name)
    else:
        FAILS.append(name)
        print("FAIL - %s%s" % (name, ("  :: " + detail) if detail else ""))


def main():
    if not shutil.which("ffmpeg"):
        check("ffmpeg on PATH", False, "install ffmpeg")
        return
    try:
        import numpy as np
    except ImportError:
        check("numpy importable", False, "run with the voice venv python")
        return

    tmp = tempfile.mkdtemp(prefix="vtools-decode-")
    ogg = os.path.join(tmp, "tone.ogg")
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=1:sample_rate=48000",
                    "-ac", "2", "-c:a", "libopus", "-b:a", "32k", ogg], check=True)

    audio = vt._decode_audio(ogg)
    check("returns a numpy array", isinstance(audio, np.ndarray), type(audio).__name__)
    check("float32 samples", audio.dtype == np.float32, str(audio.dtype))
    check("mono (1-D)", audio.ndim == 1, "ndim=%d" % audio.ndim)
    # 1 s at 16 kHz; opus pre-skip/padding moves it by a few ms at most.
    check("~1 s at 16 kHz", abs(len(audio) - 16000) < 800, "len=%d" % len(audio))
    peak = float(np.abs(audio).max()) if len(audio) else 0.0
    check("normalised to [-1, 1)", 0.05 < peak < 1.0, "peak=%.3f" % peak)
    # Dominant frequency survives the resample (440 Hz, not 440*3 from a wrong rate).
    spectrum = np.abs(np.fft.rfft(audio))
    freq = float(np.fft.rfftfreq(len(audio), 1.0 / 16000)[int(spectrum.argmax())])
    check("440 Hz tone preserved", abs(freq - 440) < 10, "freq=%.1f" % freq)

    try:
        vt._decode_audio(os.path.join(tmp, "missing.ogg"))
        check("missing file raises", False, "no exception")
    except subprocess.CalledProcessError:
        check("missing file raises", True)

    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
    sys.exit(1 if FAILS else 0)
