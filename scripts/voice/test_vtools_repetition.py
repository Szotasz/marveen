#!/usr/bin/env python3
"""Behaviour test for VOICEWHISPER910: the Hungarian voice transcription must
not loop on a repetition-prone clip.

This measures the REPETITION in the output, not the presence of the
`condition_on_previous_text` argument. faster-whisper defaults that flag to
True, and with a noisy or silent tail the decoder echoes its own previous
output, so a voice message can come back with a phrase repeated two or three
times. `_vtools` now passes `condition_on_previous_text=False` at both call
sites; this test proves the effect on the transcript.

It builds one deterministic clip: a short Hungarian sentence (piper is
deterministic for a fixed voice and text) followed by a seeded low-amplitude
noise tail (Python's `random`, fixed seed), so the same bytes are produced on
every run and faster-whisper's beam search is deterministic on them. Then:

  1. Positive control: transcribing that clip WITH condition_on_previous_text
     =True reproduces the echo (a phrase repeats). Without this the guard below
     would be vacuous -- a clip that never loops proves nothing.
  2. Guard: the shipped `_vtools._whisper` output (which now sets the flag to
     False) contains no repeated phrase.

Needs the voice venv (faster-whisper, piper), a Hungarian voice, and ffmpeg.
Skips cleanly when any is absent, so it never fails for lack of the model.

Run: ~/.local/share/marveen-voice/venv/bin/python scripts/voice/test_vtools_repetition.py
"""

from __future__ import annotations

import importlib.util
import io
import os
import random
import re
import struct
import subprocess
import sys
import tempfile
import wave
from contextlib import redirect_stdout
from pathlib import Path
from shutil import which

VOICE = os.path.expanduser("~/.local/share/marveen-voice/voices/hu_HU-imre-medium.onnx")
SENTENCE = "Ez egy rovid teszt mondat a hangatiras ellenorzesehez."
FFMPEG = which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


def _skip(msg: str) -> None:
    print(f"SKIP: {msg}")
    sys.exit(0)


def _have_deps() -> bool:
    try:
        import faster_whisper  # noqa: F401
        import piper  # noqa: F401
    except Exception:
        return False
    return os.path.exists(VOICE) and os.path.exists(FFMPEG)


def _build_clip(dirpath: str) -> str:
    """A short sentence plus a deterministic seeded noise tail."""
    speech = os.path.join(dirpath, "s.wav")
    noise = os.path.join(dirpath, "n.wav")
    clip = os.path.join(dirpath, "c.wav")
    subprocess.run(
        [sys.executable, "-m", "piper", "-m", VOICE, "-f", speech],
        input=SENTENCE.encode(), check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    random.seed(42)
    sr, dur = 22050, 40
    with wave.open(noise, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for _ in range(sr * dur):
            v = max(-32767, min(32767, int(random.gauss(0, 1) * 350)))
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))
    lst = os.path.join(dirpath, "l.txt")
    Path(lst).write_text(f"file '{speech}'\nfile '{noise}'\n")
    subprocess.run(
        [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", lst, "-ar", "22050", "-ac", "1", clip],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return clip


def _max_repeated_trigram(text: str) -> int:
    """How many times the most-repeated 3-word phrase occurs. 1 means no
    phrase repeats; a loop pushes this above 1."""
    words = re.sub(r"[^a-z0-9 ]", " ", text.lower()).split()
    if len(words) < 3:
        return 1
    counts: dict[tuple[str, str, str], int] = {}
    best = 1
    for i in range(len(words) - 2):
        tri = (words[i], words[i + 1], words[i + 2])
        counts[tri] = counts.get(tri, 0) + 1
        best = max(best, counts[tri])
    return best


FAILURES: list[str] = []


def main() -> None:
    if not _have_deps():
        _skip("voice venv / piper / hu voice / ffmpeg not available; run with the marveen-voice venv")

    from faster_whisper import WhisperModel

    spec = importlib.util.spec_from_file_location("_vtools", Path(__file__).resolve().parent / "_vtools.py")
    vtools = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vtools)

    with tempfile.TemporaryDirectory() as d:
        clip = _build_clip(d)

        # 1. Positive control: the flag's OLD default really does loop on this clip.
        model = WhisperModel("small", device="cpu", compute_type="int8")
        segs, _ = model.transcribe(clip, language="hu", beam_size=5, condition_on_previous_text=True)
        looped = " ".join(s.text.strip() for s in segs).strip()
        control = _max_repeated_trigram(looped)
        if control <= 1:
            FAILURES.append(
                "positive control failed: condition_on_previous_text=True did not loop on the "
                f"fixture (max repeated 3-gram {control}); the fixture no longer triggers the bug, "
                "so the guard below would be vacuous. Rebuild the reproducer before trusting this test."
            )

        # 2. Guard: the shipped path (_vtools._whisper -> flag False) does not loop.
        buf = io.StringIO()
        with redirect_stdout(buf):
            vtools._whisper(clip)
        shipped = buf.getvalue().strip()
        repeats = _max_repeated_trigram(shipped)
        if repeats > 1:
            FAILURES.append(
                f"_vtools._whisper looped: a 3-word phrase repeats {repeats} times in the transcript "
                f"-> {shipped!r}. condition_on_previous_text is not False on the live path."
            )

        print(f"positive control (True) max-repeat={control}; shipped (_whisper) max-repeat={repeats}")

    if FAILURES:
        for f in FAILURES:
            print("FAIL:", f)
        sys.exit(1)
    print("OK: repetition-prone clip loops under True, clean under the shipped False path.")


if __name__ == "__main__":
    main()
