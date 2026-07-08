#!/usr/bin/env python3
"""Voice tools for the agent fleet (STT + TTS), local + free.

Subcommands:
  transcribe <file_id> <state_dir>
      Download a Telegram voice file by file_id using the bot token in
      <state_dir>/.env, transcribe it (Hungarian, faster-whisper small),
      print the transcript to stdout.

  speak <voice_onnx> <state_dir> <chat_id> <text...>
      Synthesize <text> with the given Piper voice model, convert to
      ogg/opus, and send it as a Telegram voice message via the bot token
      in <state_dir>/.env. Prints "ok=<bool> id=<message_id>".

  canary <voice_onnx> <expected_text...>
      Local-only self-test, no Telegram/network involved: synthesize
      <expected_text> with Piper, transcribe the resulting audio straight
      back with faster-whisper, and compare. Prints a one-line JSON result
      {"passed": bool, "expected": str, "transcript": str, "ratio": float}
      and exits 0 on pass / 1 on fail. Temp wav is always deleted -- never
      touches the live Telegram-facing stt.sh/tts.sh state or sends anything.

The bot token is read from the caller's OWN state dir at call time, never
hardcoded -- so each agent speaks/listens on its own bot.
"""
import os
import re
import sys
import json
import subprocess
import tempfile
import urllib.request
import urllib.parse

# Resolved relative to this file so PREFIX-based installs work correctly.
VENV_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "bin", "python")


def _token(state_dir):
    env = open(os.path.join(state_dir, ".env")).read()
    m = re.search(r"^TELEGRAM_BOT_TOKEN=(.+)$", env, re.M)
    if not m:
        sys.exit("no TELEGRAM_BOT_TOKEN in " + state_dir)
    return m.group(1).strip().strip('"').strip("'")


def transcribe(file_id, state_dir):
    token = _token(state_dir)
    d = json.load(urllib.request.urlopen(
        f"https://api.telegram.org/bot{token}/getFile?file_id={urllib.parse.quote(file_id)}",
        timeout=20))
    fp = d["result"]["file_path"]
    fd, out = tempfile.mkstemp(suffix=".ogg")
    os.close(fd)
    try:
        urllib.request.urlretrieve(f"https://api.telegram.org/file/bot{token}/{fp}", out)
        from faster_whisper import WhisperModel
        m = WhisperModel("small", device="cpu", compute_type="int8")
        segs, _ = m.transcribe(out, language="hu", beam_size=5)
        print(" ".join(s.text.strip() for s in segs).strip())
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass


def speak(voice_onnx, state_dir, chat_id, text):
    token = _token(state_dir)
    fd_wav, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd_wav)
    fd_ogg, ogg = tempfile.mkstemp(suffix=".ogg")
    os.close(fd_ogg)
    try:
        subprocess.run([VENV_PY, "-m", "piper", "-m", voice_onnx, "-f", wav],
                       input=text.encode(), check=True)
        # Optional voice style: deeper + slower (e.g. a melancholic android tone).
        # asetrate lowers pitch AND slows playback; aresample restores the container
        # rate (so the lower pitch sticks). Distribution-safe default = 1.0 (off,
        # natural Piper voice); set VOICE_PITCH in the host env (e.g. dashboard
        # plist) to style a specific deployment. TODO: per-agent voice-style config.
        pitch = os.environ.get("VOICE_PITCH", "1.0")
        af = []
        if pitch and pitch != "1.0":
            af = ["-af", "asetrate=22050*%s,aresample=22050" % pitch]
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-i", wav, *af, "-c:a", "libopus", "-b:a", "32k", ogg], check=True)
        b = "----fleetvoice"
        fd = open(ogg, "rb").read()
        body = (("--" + b + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + str(chat_id) + "\r\n").encode()
                + ("--" + b + "\r\nContent-Disposition: form-data; name=\"voice\"; filename=\"v.ogg\"\r\nContent-Type: audio/ogg\r\n\r\n").encode()
                + fd + b"\r\n" + ("--" + b + "--\r\n").encode())
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendVoice", data=body)
        req.add_header("Content-Type", "multipart/form-data; boundary=" + b)
        r = json.load(urllib.request.urlopen(req, timeout=30))
        print("ok=%s id=%s" % (r.get("ok"), (r.get("result") or {}).get("message_id")))
    finally:
        for p in (wav, ogg):
            try:
                os.unlink(p)
            except OSError:
                pass


def _normalize(s):
    s = s.lower()
    s = re.sub(r"[^\w\sáéíóöőúüű]", "", s, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def canary(voice_onnx, expected_text):
    fd_wav, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd_wav)
    try:
        subprocess.run([VENV_PY, "-m", "piper", "-m", voice_onnx, "-f", wav],
                       input=expected_text.encode(), check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        from faster_whisper import WhisperModel
        m = WhisperModel("small", device="cpu", compute_type="int8")
        segs, _ = m.transcribe(wav, language="hu", beam_size=5)
        transcript = " ".join(s.text.strip() for s in segs).strip()
        exp_words = _normalize(expected_text).split()
        got_words = set(_normalize(transcript).split())
        common = sum(1 for w in exp_words if w in got_words)
        ratio = common / max(1, len(exp_words))
        passed = ratio >= 0.8
        print(json.dumps({"passed": passed, "expected": expected_text,
                           "transcript": transcript, "ratio": round(ratio, 2)}))
        sys.exit(0 if passed else 1)
    finally:
        try:
            os.unlink(wav)
        except OSError:
            pass


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "transcribe":
        transcribe(sys.argv[2], sys.argv[3])
    elif cmd == "speak":
        speak(sys.argv[2], sys.argv[3], sys.argv[4], " ".join(sys.argv[5:]))
    elif cmd == "canary":
        canary(sys.argv[2], " ".join(sys.argv[3:]))
    else:
        sys.exit("usage: _vtools.py transcribe <file_id> <state_dir> | speak <voice_onnx> <state_dir> <chat_id> <text...> | canary <voice_onnx> <expected_text...>")
