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
import socket
import subprocess
import tempfile
import urllib.request
import urllib.parse
import urllib.error

# api.telegram.org publishes an AAAA record that is not routable from every host, and
# Python's urllib has no happy-eyeballs fallback: each fresh connection stalls on the
# IPv6 attempt before dropping to IPv4. MEASURED 2026-07-27 on the Marveen box: getFile
# took 25.1s with IPv6 allowed vs 0.0s IPv4-only, and a full transcribe ran 2m43s of
# which only 5.5s was CPU. That silently blew the dashboard's 60s STT timeout, so
# /api/voice/directive returned transcript=null and voice messages reached the agent
# untranscribed -- a failure with no error anywhere, just a missing transcript.
# PREFER IPv4, do not EXCLUDE IPv6: an AF_INET-only override would turn a working
# IPv6-only host into a dead one (ENETUNREACH -> transcript=null), which is the same
# silent failure this patch exists to remove, just relocated. Ordering keeps the whole
# measured benefit -- the stalling AAAA attempt no longer comes first -- while a host
# with no IPv4 route still resolves and connects. The caller's own `family` argument is
# passed through untouched, so an explicit AF_INET6 lookup still gets what it asked for.
_orig_getaddrinfo = socket.getaddrinfo



def _whisper_model_name():
    """faster-whisper model size (MARVEEN_WHISPER_MODEL, default 'small')."""
    return (os.environ.get("MARVEEN_WHISPER_MODEL") or "small").strip()

def _getaddrinfo_ipv4_first(host, port, family=0, *args, **kwargs):
    results = _orig_getaddrinfo(host, port, family, *args, **kwargs)
    # Stable sort: AF_INET entries move to the front, every other family keeps the
    # relative order the resolver returned.
    return sorted(results, key=lambda entry: 0 if entry[0] == socket.AF_INET else 1)


socket.getaddrinfo = _getaddrinfo_ipv4_first
# urlretrieve() takes no timeout kwarg -- bound it here so a stalled download can never
# hang unbounded again.
socket.setdefaulttimeout(60)


# Piper runs from the marveen-voice venv. Resolve robustly across install layouts:
# 1) explicit override env, 2) the real user-data venv (actual install location),
# 3) legacy path relative to this file (PREFIX-style). First existing wins.
def _resolve_venv_py():
    candidates = [
        os.environ.get("MARVEEN_VOICE_VENV_PY"),
        os.path.join(os.path.expanduser("~/.local/share/marveen-voice/venv"), "bin", "python"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "bin", "python"),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    # fall back to the user-data path even if missing, so the error message points at the real location
    return candidates[1]

VENV_PY = _resolve_venv_py()


def _token(state_dir):
    env = open(os.path.join(state_dir, ".env")).read()
    m = re.search(r"^TELEGRAM_BOT_TOKEN=(.+)$", env, re.M)
    if not m:
        sys.exit("no TELEGRAM_BOT_TOKEN in " + state_dir)
    return m.group(1).strip().strip('"').strip("'")


def _whisper(path, words=False):
    # ADDITIV (2026-09-12): a words=False ag VALTOZATLAN -- a stt.sh es a canary erre epul, es a
    # repetition-teszt a stdoutjat kapja el. A words=True ag KULON kimenet (JSON), uj hivoknak:
    # a vagas-hatar ellenorzeshez SZO-SZINTU `end` ido kell, amit a szoveges alak nem hordoz.
    from faster_whisper import WhisperModel
    # Model size is configurable: 'medium' is noticeably better than 'small' on
    # Hungarian accents/diacritics, at a cost in latency and memory. Default
    # stays 'small'; set MARVEEN_WHISPER_MODEL=medium to trade speed for accuracy.
    m = WhisperModel(_whisper_model_name(), device="cpu", compute_type="int8")
    segs, _ = m.transcribe(path, language="hu", beam_size=5, condition_on_previous_text=False,
                           word_timestamps=words)
    segs = list(segs)
    if not words:
        print(" ".join(s.text.strip() for s in segs).strip())
        return
    out = []
    for s_ in segs:
        for w in (getattr(s_, "words", None) or []):
            out.append({"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
    print(json.dumps({"text": " ".join(s_.text.strip() for s_ in segs).strip(), "words": out},
                     ensure_ascii=False))


def transcribe(file_id, state_dir):
    # Accept an already-downloaded local file as well as a Telegram file_id: the channel
    # plugin's download_attachment tool hands back a PATH, and feeding that to getFile as
    # a file_id fails with HTTP 400 (hit live 2026-07-27).
    if os.path.isfile(file_id):
        _whisper(file_id)
        return
    token = _token(state_dir)
    d = json.load(urllib.request.urlopen(
        f"https://api.telegram.org/bot{token}/getFile?file_id={urllib.parse.quote(file_id)}",
        timeout=20))
    fp = d["result"]["file_path"]
    fd, out = tempfile.mkstemp(suffix=".ogg")
    os.close(fd)
    try:
        urllib.request.urlretrieve(f"https://api.telegram.org/file/bot{token}/{fp}", out)
        _whisper(out)
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass



class VoiceSendError(RuntimeError):
    """sendVoice failed, and the message carries the reason the API gave.

    e39b8f7b: the caller used to see only ``HTTP Error 400: Bad Request``,
    because ``urlopen`` raises before anyone reads the response body -- and the
    body is where Telegram puts ``description`` ("chat not found", "VOICE_
    MESSAGES_FORBIDDEN", "file must be non-empty"). That string is the whole
    diagnosis, and it was thrown away at the one place it existed.
    """


def _http_error_detail(err):
    """Pull Telegram's own ``description`` out of a 4xx/5xx body.

    The body is read ONCE (it is a stream) and every failure mode below falls
    back to something still useful -- a diagnostic path that raises its own
    exception would hide the very error it is reporting.

    NOT included, deliberately: the request URL. It carries the bot token in the
    path (``/bot<token>/sendVoice``), so putting it in a log line or an
    exception message would leak the credential into places that get copied
    around (kanban comments, inter-agent messages, CI output).
    """
    try:
        raw = err.read()
    except Exception:  # noqa: BLE001 - the stream may already be consumed/closed
        raw = b""
    text = raw.decode("utf-8", "replace").strip()
    try:
        payload = json.loads(text)
    except ValueError:
        payload = None
    if isinstance(payload, dict) and payload.get("description"):
        return str(payload["description"])
    if text:
        # Not JSON (proxy/HTML error page): keep a bounded excerpt, not the lot.
        return text[:300]
    return "(the response had no body)"


def _post_voice(token, chat_id, ogg):
    """POST the ogg to sendVoice and return the parsed JSON answer.

    Two guards, both from e39b8f7b:
      * an EMPTY ogg is caught here, before the network call. Telegram answers a
        zero-byte upload with a 400 whose text does not say "your file is
        empty", so the useful error has to be produced on our side -- and the
        call is skipped, not just annotated.
      * a 4xx/5xx is turned into VoiceSendError carrying the API's description,
        and the same line goes to stderr so it survives in the job log even if
        the caller swallows the exception.
    """
    size = os.path.getsize(ogg)
    if size <= 0:
        raise VoiceSendError(
            "the synthesized voice file is empty (0 bytes) -- not sending; "
            "the TTS/ffmpeg step produced no audio"
        )
    b = "----fleetvoice"
    fd = open(ogg, "rb").read()
    body = (("--" + b + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + str(chat_id) + "\r\n").encode()
            + ("--" + b + "\r\nContent-Disposition: form-data; name=\"voice\"; filename=\"v.ogg\"\r\nContent-Type: audio/ogg\r\n\r\n").encode()
            + fd + b"\r\n" + ("--" + b + "--\r\n").encode())
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendVoice", data=body)
    req.add_header("Content-Type", "multipart/form-data; boundary=" + b)
    try:
        return json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        detail = _http_error_detail(e)
        print("sendVoice failed: HTTP %s -- %s" % (e.code, detail), file=sys.stderr)
        raise VoiceSendError("sendVoice failed: HTTP %s -- %s" % (e.code, detail)) from e


def _is_install_dir(d):
    """A marveen install is recognised by the ledger helper it ships."""
    return bool(d) and os.path.isfile(os.path.join(d, "scripts", "hooks", "ledger_lib.py"))


def _install_dir(state_dir=None):
    """Root of the marveen install this voice call belongs to, or None.

    Live calls run the INSTALLED toolkit copy (~/.local/share/marveen-voice/
    _vtools.py), which sits outside the install tree, so a path relative to this
    file is only right when running from the source tree. Resolution order:
    1) MARVEEN_INSTALL_DIR (the dashboard passes it), 2) this file's own tree
    (<install>/scripts/voice/_vtools.py), 3) the channel state_dir, which is
    <install>/agents/<name>/.claude/channels/<provider> for a sub-agent and
    <install>/.claude/channels/<provider> for the main agent."""
    candidates = [
        os.environ.get("MARVEEN_INSTALL_DIR"),
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    ]
    if state_dir:
        parts = os.path.abspath(state_dir).split(os.sep)
        if "agents" in parts:
            candidates.append(os.sep.join(parts[:len(parts) - 1 - parts[::-1].index("agents")]) or os.sep)
        if len(parts) >= 3 and parts[-3:-1] == [".claude", "channels"]:
            candidates.append(os.sep.join(parts[:-3]) or os.sep)
    for c in candidates:
        if _is_install_dir(c):
            return c
    return None


def _agent_from_state_dir(state_dir, main_agent_id):
    """Agent id from the channel state_dir: the <name> in .../agents/<name>/...,
    otherwise the main agent (its state_dir has no agents/ segment)."""
    parts = os.path.abspath(state_dir).split(os.sep)
    if "agents" in parts:
        i = len(parts) - 1 - parts[::-1].index("agents")
        if i + 1 < len(parts):
            return parts[i + 1]
    return main_agent_id


def _log_spoken_reply(state_dir, chat_id, text, message_id):
    """Record a sent voice reply as an outbound row in the conversation ledger.

    A voice reply goes out through sendVoice, not the channel `reply` tool, so
    without this row the ledger shows no answer and the reply guard asks the
    agent to answer again, producing a duplicate text reply. Never raises: the
    voice note has already been delivered, and a ledger problem must not turn
    that into a reported failure."""
    try:
        install = _install_dir(state_dir)
        if not install:
            return False
        hooks = os.path.join(install, "scripts", "hooks")
        if hooks not in sys.path:
            sys.path.insert(0, hooks)
        import ledger_lib
        ledger_lib.log_outbound(
            _agent_from_state_dir(state_dir, ledger_lib.main_agent_id()), str(chat_id),
            "[voice] " + (text[:400] if text else ""), message_id,
        )
        return True
    except Exception:
        return False


_PRON_FILE = "pronunciation-hu.json"

# Hungarian case endings / plural / possessive that may be glued straight onto
# a borrowed word without a hyphen ("Mondayben", "emailt", "meetingek").
# Deliberately a closed list: a key matches only as a whole word, or followed
# by a hyphenated suffix ("GitHub-on", "Opus-szal"), or by a chain of these
# endings and then a non-letter. Anything else that continues with letters is
# a different word and is left alone ("opusz" is not "Opus" + "z", "Driver" is
# not "Drive" + "r").
_HU_SUFFIXES = sorted({
    "ban", "ben", "ba", "be", "ból", "ből", "ra", "re", "ról", "ről", "ró", "rő",
    "nak", "nek", "on", "en", "ön", "n", "hoz", "hez", "höz", "tól", "től",
    "ig", "ért", "ként", "kor", "ul", "ül",
    "t", "ot", "et", "öt", "at",
    "k", "ok", "ek", "ök", "ak",
    "m", "om", "em", "öm", "am", "d", "od", "ed", "öd", "ad",
    "ja", "je", "jai", "jei", "juk", "jük", "ai", "ei", "i", "s", "es", "os", "as", "ös",
}, key=len, reverse=True)


def _pron_pattern(key):
    last = re.escape(key[-1])
    suffix = "|".join(re.escape(x) for x in _HU_SUFFIXES)
    return re.compile(
        # Not glued to a preceding word, address, path or domain.
        r"(?<![\w@/.\-])"
        + "(" + re.escape(key) + ")"
        + "("
        #   hyphenated suffix: any letters after one hyphen
        + r"-[^\W\d_]+"
        #   or glued endings, including the doubled final consonant of
        #   -val/-vel/-vá/-vé assimilation ("emaillel", "meetinggé")
        + "|(?:" + last + "(?:al|el|á|é)|" + suffix + "){1,3}"
        + ")?"
        # Must end the word, and must not continue into a domain/path/address.
        + r"(?![\w@/])(?!\.\w)",
        re.IGNORECASE,
    )


def _pronunciation_paths(state_dir=None):
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), _PRON_FILE)
    paths = [here]
    install = _install_dir(state_dir)
    if install:
        paths.append(os.path.join(install, "scripts", "voice", _PRON_FILE))
    return paths


def apply_pronunciation(text, path=None, state_dir=None):
    """Rewrite known English words into a Hungarian phonetic spelling before
    Piper reads them (the hu voices read 'Monday' letter by letter the
    Hungarian way). Case-insensitive whole-word match that keeps a Hungarian
    suffix ('Mondayben' -> 'mandéjben', 'GitHub-on' -> 'githab-on'), but never
    rewrites a longer word that merely starts with a key, or a word inside a
    domain, path or address. Longest keys first, so a multi-word key wins over
    a one-word one. Never raises: a missing or broken lexicon leaves the text
    untouched."""
    words = None
    for p in ([path] if path else _pronunciation_paths(state_dir)):
        try:
            with open(p, encoding="utf-8") as f:
                words = json.load(f).get("words", {})
            break
        except Exception:
            continue
    if not words:
        return text
    try:
        for key in sorted(words, key=len, reverse=True):
            value = words[key]
            text = _pron_pattern(key).sub(lambda m, v=value: v + (m.group(2) or ""), text)
    except Exception:
        return text
    return text


def speak(voice_onnx, state_dir, chat_id, text):
    token = _token(state_dir)
    fd_wav, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd_wav)
    fd_ogg, ogg = tempfile.mkstemp(suffix=".ogg")
    os.close(fd_ogg)
    try:
        subprocess.run([VENV_PY, "-m", "piper", "-m", voice_onnx, "-f", wav],
                       input=apply_pronunciation(text, state_dir=state_dir).encode(), check=True)
        # Optional voice style: deeper + slower (e.g. a melancholic android tone).
        # asetrate lowers pitch AND slows playback; aresample restores the container
        # rate (so the lower pitch sticks). Distribution-safe default = 1.0 (off,
        # natural Piper voice); set VOICE_PITCH in the host env (e.g. dashboard
        # plist) to style a specific deployment. TODO: per-agent voice-style config.
        pitch = os.environ.get("VOICE_PITCH", "1.0")
        filters = []
        if pitch and pitch != "1.0":
            filters.append("asetrate=22050*%s,aresample=22050" % pitch)
        # TAIL PAD: the last word or two of voice replies was regularly
        # reported cut off. Measured: the opus encode keeps the full length
        # (3.664s vs 3.657s WAV), but Piper
        # leaves only ~86ms of silence after the last phoneme, and the Telegram
        # player drops the tail of a clip. Half a second of padded silence moves
        # that loss into silence.
        filters.append("apad=pad_dur=%s" % os.environ.get("VOICE_TAIL_PAD_S", "0.5"))
        af = ["-af", ",".join(filters)]
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-i", wav, *af, "-c:a", "libopus", "-b:a", "32k", ogg], check=True)
        r = _post_voice(token, chat_id, ogg)
        mid = (r.get("result") or {}).get("message_id")
        print("ok=%s id=%s" % (r.get("ok"), mid))
        # A spoken reply is a reply: record it in the conversation ledger, or
        # the reply guard (which looks for a `reply` tool call) reads the
        # voice-only answer as "no reply" and pushes a duplicate text answer.
        if r.get("ok") and mid:
            _log_spoken_reply(state_dir, chat_id, text, mid)
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
        m = WhisperModel(_whisper_model_name(), device="cpu", compute_type="int8")
        segs, _ = m.transcribe(wav, language="hu", beam_size=5, condition_on_previous_text=False)
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
    elif cmd == "transcribe-words":
        # Lokalis fajl -> JSON szo-szintu idokkel. Telegram file_id-t NEM fogad: a hivoi (pl. a
        # vagas-hatar verify) maguk vagjak ki a klipet ffmpeg-gel.
        _whisper(sys.argv[2], words=True)
    elif cmd == "canary":
        canary(sys.argv[2], " ".join(sys.argv[3:]))
    else:
        sys.exit("usage: _vtools.py transcribe <file_id> <state_dir> | transcribe-words <file> | speak <voice_onnx> <state_dir> <chat_id> <text...> | canary <voice_onnx> <expected_text...>")
