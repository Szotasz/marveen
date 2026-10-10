#!/usr/bin/env python3
"""The vtools-diag line scripts/voice/_vtools.py writes on stderr (cards deeaa175, 75c3d163).

faster_whisper is stubbed: no model, no audio, no network. Pins what the dashboard's
reader (src/web/routes/voice.ts, parseVtoolsDiag) relies on:
- stdout stays exactly the transcript (words=False) or one JSON line (words=True):
  the diagnosis never leaks into the stream every existing caller reads;
- stderr carries ONE vtools-diag line, every value a single whitespace-free token,
  with model= and revision= next to the measurements;
- model/revision name the model that was actually loaded: a pinned model directory
  names itself (revision = the trailing 40-hex id in its name), a Hub name resolves
  through download_model(local_files_only=True) to its cache snapshot id, and any
  failure there degrades to an empty revision, never to a failed transcription.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import types

sys.dont_write_bytecode = True  # importing the toolkit must not leave __pycache__ in the tree
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), "voice", "_vtools.py")
REV = "08e178d48790749d25932bbc082711ddcfdfbc4f"
OTHER_REV = "1111111111111111111111111111111111111111"
# The reader's field rule, same pattern as parseVtoolsDiag in src/web/routes/voice.ts.
FIELD_RE = re.compile(r"(?:^|\s)([a-z_]+)=(\S*)")

fails = 0


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else " -- " + detail))
    if not ok:
        fails += 1


class Seg:
    def __init__(self, text, nsp, alp, temp=None, words=None):
        self.text = text
        self.no_speech_prob = nsp
        self.avg_logprob = alp
        if temp is not None:
            self.temperature = temp
        self.words = words or []


class Word:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end


class Info:
    duration = 4.39


STATE = {"segs": [], "download": None, "download_calls": [], "loaded": []}


class WhisperModel:
    def __init__(self, name, device=None, compute_type=None):
        STATE["loaded"].append(name)

    def transcribe(self, path, **kw):
        return iter(STATE["segs"]), Info()


def download_model(name, local_files_only=False, **kw):
    STATE["download_calls"].append((name, local_files_only))
    d = STATE["download"]
    if isinstance(d, Exception):
        raise d
    return d


fw = types.ModuleType("faster_whisper")
fw.WhisperModel = WhisperModel
fwu = types.ModuleType("faster_whisper.utils")
fwu.download_model = download_model
fw.utils = fwu
sys.modules["faster_whisper"] = fw
sys.modules["faster_whisper.utils"] = fwu

spec = importlib.util.spec_from_file_location("vtools_diag_under_test", SRC)
vt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vt)

tmp = tempfile.mkdtemp(prefix="voice-diag-test-")


def run(model, segs, words=False, download=None):
    os.environ["MARVEEN_WHISPER_MODEL"] = model
    STATE.update(segs=segs, download=download, download_calls=[], loaded=[])
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        vt._whisper(os.path.join(tmp, "nincs.ogg"), words=words)
    lines = [l for l in err.getvalue().splitlines() if l.startswith("vtools-diag ")]
    fields = dict(FIELD_RE.findall(lines[0][len("vtools-diag "):])) if lines else {}
    return out.getvalue(), lines, fields


SPEECH = [Seg("Ez egy rendes mondat.", 0.108, -0.598, 0.0)]

try:
    # 1. A pinned model directory names itself; the revision is the 40-hex tail of the name.
    pinned = os.path.join(tmp, "faster-whisper-medium-" + REV)
    os.mkdir(pinned)
    out, lines, f = run(pinned, SPEECH)
    check("stdout is exactly the transcript", out == "Ez egy rendes mondat.\n", repr(out))
    check("exactly one vtools-diag line on stderr", len(lines) == 1, repr(lines))
    check("pinned dir: model is the directory name", f.get("model") == "faster-whisper-medium-" + REV, repr(f))
    check("pinned dir: revision is the id in the name", f.get("revision") == REV, repr(f))
    check("pinned dir: no Hub lookup", STATE["download_calls"] == [], repr(STATE["download_calls"]))
    check("the model that was loaded is the one named", STATE["loaded"] == [pinned], repr(STATE["loaded"]))
    check("measurements next to the identity",
          (f.get("segments"), f.get("duration"), f.get("no_speech_prob"), f.get("avg_logprob"), f.get("temperature"))
          == ("1", "4.39", "0.108", "-0.598", "0.00"), repr(f))

    # 2. A directory without an id in its name: the name stays, the revision is empty.
    plain = os.path.join(tmp, "sajat-modell")
    os.mkdir(plain)
    out, lines, f = run(plain, SPEECH)
    check("plain dir: model is the directory name, revision empty",
          (f.get("model"), f.get("revision")) == ("sajat-modell", ""), repr(f))

    # 3. A Hub name: the revision is the cache snapshot it resolved to, looked up offline.
    snap = os.path.join(tmp, "models--Systran--faster-whisper-small", "snapshots", OTHER_REV)
    out, lines, f = run("small", SPEECH, download=snap)
    check("hub name: model is the name", f.get("model") == "small", repr(f))
    check("hub name: revision is the snapshot id", f.get("revision") == OTHER_REV, repr(f))
    check("hub name: the lookup is local_files_only", STATE["download_calls"] == [("small", True)],
          repr(STATE["download_calls"]))

    # 4. The lookup fails (not cached, offline, bad name): empty revision, the transcript still goes out.
    out, lines, f = run("small", SPEECH, download=OSError("nincs a gyorsitotarban"))
    check("lookup failure: revision empty, model kept", (f.get("model"), f.get("revision")) == ("small", ""), repr(f))
    check("lookup failure: stdout unchanged", out == "Ez egy rendes mondat.\n", repr(out))

    # 5. A resolved path that is not a snapshot dir carries no revision claim.
    out, lines, f = run("small", SPEECH, download=os.path.join(tmp, "valami", "mas"))
    check("non-snapshot path: revision empty", f.get("revision") == "", repr(f))

    # 6. No segments: the measurements are empty fields, not a crash and not zeros.
    out, lines, f = run(pinned, [])
    check("no segments: stdout is an empty line", out == "\n", repr(out))
    check("no segments: segments=0 and empty per-segment fields",
          (f.get("segments"), f.get("no_speech_prob"), f.get("avg_logprob"), f.get("temperature"))
          == ("0", "", "", ""), repr(f))
    check("no segments: identity still present", f.get("model") == "faster-whisper-medium-" + REV, repr(f))

    # 7. An older faster-whisper without Segment.temperature degrades to an empty value.
    out, lines, f = run(pinned, [Seg("Mondat.", 0.2, -0.3)])
    check("no temperature attribute: empty value", f.get("temperature") == "", repr(f))

    # 8. words=True keeps its own stdout contract (one JSON line) and still writes the diag line.
    out, lines, f = run(pinned, [Seg("Szia", 0.1, -0.2, 0.0, [Word(" Szia", 0.0, 0.5)])], words=True)
    try:
        parsed = json.loads(out)
    except ValueError:
        parsed = None
    check("words=True: stdout is one JSON line", parsed is not None and out.count("\n") == 1, repr(out))
    check("words=True: the diag line is there too", len(lines) == 1 and f.get("model", "").endswith(REV), repr(lines))

    # 9. Whitespace in a name cannot split the line into extra fields.
    spaced = os.path.join(tmp, "nev szokozzel")
    os.mkdir(spaced)
    out, lines, f = run(spaced, SPEECH)
    check("whitespace in the name becomes one token", f.get("model") == "nev_szokozzel" and f.get("segments") == "1",
          repr(f))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("%d FAIL" % fails if fails else "ALL PASS")
sys.exit(1 if fails else 0)
