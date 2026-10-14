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

    check_missing_ffmpeg_fallback(ogg, tmp)
    shutil.rmtree(tmp, ignore_errors=True)


def _decode_with(ogg, path_env, fallback_dirs, find=None):
    """Run _decode_audio with a given PATH / fallback dirs; return (result, stderr text)."""
    import contextlib
    import io
    # getattr: run against a _vtools.py without the lookup, this must report FAIL, not crash.
    saved = (os.environ.get("PATH"), getattr(vt, "_FFMPEG_FALLBACK_DIRS", None),
             getattr(vt, "_find_ffmpeg", None))
    err = io.StringIO()
    try:
        os.environ["PATH"] = path_env
        vt._FFMPEG_FALLBACK_DIRS = fallback_dirs
        if find is not None:
            vt._find_ffmpeg = find
        with contextlib.redirect_stderr(err):
            result = vt._decode_audio(ogg)
    finally:
        os.environ["PATH"] = saved[0] or ""
        vt._FFMPEG_FALLBACK_DIRS, vt._find_ffmpeg = saved[1], saved[2]
    return result, err.getvalue()


def check_missing_ffmpeg_fallback(ogg, tmp):
    """Review point 1 on PR #1887: no ffmpeg must hand the path back (PyAV decodes
    it on av < 19) with one diagnosable stderr line, not die with FileNotFoundError."""
    import numpy as np
    msg = "ffmpeg not found on PATH, falling back to faster-whisper's own decoder"
    empty = os.path.join(tmp, "empty-bin")
    os.mkdir(empty)

    try:
        result, err = _decode_with(ogg, empty, ())
    except FileNotFoundError as e:
        check("no ffmpeg anywhere: falls back instead of raising", False, repr(e))
        return
    check("no ffmpeg anywhere: returns the path unchanged", result == ogg, repr(result)[:80])
    check("no ffmpeg anywhere: exactly one stderr line", err == msg + "\n", repr(err))

    # Located in a fallback dir while PATH lacks it (dashboard PATH=/usr/bin:/bin).
    alt = os.path.join(tmp, "brew-bin")
    os.mkdir(alt)
    os.symlink(shutil.which("ffmpeg"), os.path.join(alt, "ffmpeg"))
    result, err = _decode_with(ogg, empty, (alt,))
    check("ffmpeg only in a fallback dir: still decodes",
          isinstance(result, np.ndarray) and abs(len(result) - 16000) < 800,
          type(result).__name__)
    check("ffmpeg only in a fallback dir: stderr stays quiet", err == "", repr(err))

    # Resolved, then gone at exec time: the FileNotFoundError branch.
    gone = os.path.join(tmp, "vanished", "ffmpeg")
    try:
        result, err = _decode_with(ogg, empty, (), find=lambda: gone)
    except FileNotFoundError as e:
        check("ffmpeg vanished before exec: falls back instead of raising", False, repr(e))
        return
    check("ffmpeg vanished before exec: returns the path", result == ogg, repr(result)[:80])
    check("ffmpeg vanished before exec: one stderr line", err == msg + "\n", repr(err))


if __name__ == "__main__":
    main()
    sys.exit(1 if FAILS else 0)
